'use strict';
/* The phase-one agent operations: validate, open, render, measure, edit and save a scene. Each returns plain data;
   images are returned as { image: { mimeType, base64 } } beside the metadata so adapters can pass them on as content. */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const { compact, diff, applyPatch, revisionOf } = require('../data.js');
const Scenes = require('../scenes.js');

const R = () => require('../../cli/render.js');
const PNG = () => require('../../cli/png.js');
const Critic = () => require('../../cli/critic.js');
const Crisp = () => require('../../cli/crisp.js');

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const viewSchema = {
  type: 'object',
  description: 'Camera overrides. Angles are radians; omitted fields keep the scene camera.',
  properties: {
    yaw: { type: 'number' }, pitch: { type: 'number' }, zoom: { type: 'number', minimum: 0.05, maximum: 50 },
    target: vec3, ortho: { type: 'boolean' }
  },
  additionalProperties: false
};
const sizeSchema = {
  type: 'object',
  description: 'Viewport in screen pixels. The renderer derives a smaller art-pixel grid from the scene detail.',
  properties: { w: { type: 'integer', minimum: 16, maximum: 2048 }, h: { type: 'integer', minimum: 16, maximum: 2048 } },
  additionalProperties: false
};
const lookSchema = {
  type: 'object',
  properties: {
    colored: { type: 'boolean', description: 'Palette-aware silhouette smoothing with body-coloured contours.' },
    raw: { type: 'boolean', description: 'Bypass palette styling.' }
  },
  additionalProperties: false
};
const METRICS = ['stats', 'lint', 'crisp', 'values'];
const metricsSchema = {
  type: 'array', items: { type: 'string', enum: METRICS }, minItems: 1,
  description: 'stats: splat counts, extent and palette use. lint: pixel-art faults (orphans, doubles, jaggies, banding, pillow, noise). crisp: clarity at native size against targets. values: dark/middle/light balance.'
};

const renderProperties = {
  t: { type: 'number', minimum: 0, description: 'Scene time in seconds (default 0).' },
  view: viewSchema, size: sizeSchema, look: lookSchema,
  mode: { type: 'string', enum: ['single', 'turn'] },
  frames: { type: 'integer', minimum: 2, maximum: 16, description: 'Views for mode turn (default 8).' },
  scale: { type: 'integer', minimum: 1, maximum: 16, description: 'Integer upscale of art pixels. Default fits about 640 px.' },
  out: { type: 'string', description: 'Also write the PNG to this path. Existing files outside studio/out need overwrite.' },
  overwrite: { type: 'boolean' },
  measure: metricsSchema
};
const renderOptionsSchema = { type: 'object', properties: renderProperties, additionalProperties: false };

/* --- shared rendering ----------------------------------------------------------------------------------------------- */

const DEFAULT_SIZE = { w: 640, h: 400 };

function renderImage(world, { t = 0, view = {}, size = {}, look = {} } = {}) {
  const started = Date.now();
  const image = R().render(world, {
    t, w: size.w ?? DEFAULT_SIZE.w, h: size.h ?? DEFAULT_SIZE.h,
    yaw: view.yaw, pitch: view.pitch, zoom: view.zoom ?? 1, target: view.target, ortho: view.ortho,
    colored: !!look.colored, raw: !!look.raw, paintCorrections: true
  });
  image.drawMs = Date.now() - started;
  return image;
}

/* integer upscale so the longest side lands near `target` pixels, never below native size */
const autoScale = (w, h, target = 640) => Math.max(1, Math.floor(target / Math.max(w, h)));

function encodeImage(image, scale) {
  const big = scale > 1 ? R().upscale(image, scale) : image;
  return { mimeType: 'image/png', base64: PNG().encode(big.w, big.h, big.rgb).toString('base64'), width: big.w, height: big.h };
}

const hex = colour => '#' + colour.toString(16).padStart(6, '0');
const background = (image, world) => (image.palette || world.pal)[0];

/* --- metrics -------------------------------------------------------------------------------------------------------- */

function statsOf(world, image) {
  const data = world.data, count = world.count, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let soft = 0, glowing = 0, shaderAnimated = 0, large = 0;
  for (let i = 0, q = 0; i < count; i++, q += 16) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], data[q + k]);
      hi[k] = Math.max(hi[k], data[q + k]);
    }
    if (data[q + 3] < 1) soft++;
    const kind = Math.round(data[q + 11]);
    if (kind & 32) glowing++;
    if (kind % 16) shaderAnimated++;
    if (Math.sqrt((data[q + 4] + data[q + 8] + data[q + 10]) / 3) > 0.4) large++;
  }
  const palette = Array.from(image.palette || world.pal, hex), total = image.w * image.h, use = Array.from(image.use);
  const used = use.map((u, index) => ({ index, colour: palette[index], share: u / total })).filter(row => row.share > 0);
  const unused = use.map((u, index) => (u ? -1 : index)).filter(index => index >= 0);
  const warnings = [];
  if (count > 150000) warnings.push({ code: 'SPLATS_HEAVY', message: 'More than 150,000 splats: heavy on a phone' });
  if (world.pal.length > 48) warnings.push({ code: 'PALETTE_TOO_LARGE', message: 'Palette has ' + world.pal.length + ' colours; the browser renderer uses 48' });
  if (unused.length > palette.length / 3)
    warnings.push({ code: 'PALETTE_UNUSED', message: unused.length + ' of ' + palette.length + ' colours never show from this view' });
  return {
    splats: { total: count, soft, glowing, shaderAnimated, large, animatedSpan: world.anim?.count ?? 0 },
    extent: { min: lo, max: hi, radius: world.radius },
    buildMs: world.buildMs,
    picture: { artWidth: image.w, artHeight: image.h, px: image.px },
    palette: { size: palette.length, used: used.sort((a, b) => b.share - a.share), unused },
    warnings
  };
}

function lintOf(image, world) {
  const img = { w: image.w, h: image.h, rgb: image.rgb || image.color };
  const { mark, bg, ...result } = Critic().lint(img, { bg: background(image, world) });
  return { ...result, reference: Critic().REFERENCE, note: 'Shares of non-background pixels except pillow (0..1) and colours (count). Lower is cleaner; compare with reference.' };
}

function crispOf(image, world) {
  const C = Crisp(), measured = C.measure(image, { bg: background(image, world) });
  const misses = [];
  for (const [key, floor] of Object.entries(C.FLOORS))
    if (Number.isFinite(measured[key]) && measured[key] < floor) misses.push({ metric: key, value: measured[key], floor });
  for (const [key, target] of Object.entries(C.TARGETS)) {
    if (!Number.isFinite(measured[key])) continue;
    const ok = key === 'flat' ? measured[key] >= target : measured[key] <= target;
    if (!ok) misses.push({ metric: key, value: measured[key], target, direction: key === 'flat' ? 'at least' : 'at most' });
  }
  const reference = Object.fromEntries(Object.entries(C.REFERENCE).map(([key, row]) => [key, row[2]]));
  const values = Object.fromEntries(Object.entries(measured).filter(([, v]) => typeof v === 'number'));
  return { ...values, targets: C.TARGETS, floors: C.FLOORS, reference, misses, pass: misses.length === 0 };
}

function valuesOf(image, world) {
  const bg = background(image, world), bgc = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255], n = image.w * image.h;
  const lum = [];
  for (let i = 0; i < n; i++) {
    const r = image.rgb[i * 3], g = image.rgb[i * 3 + 1], b = image.rgb[i * 3 + 2];
    if (r === bgc[0] && g === bgc[1] && b === bgc[2]) continue;
    lum.push(0.299 * r + 0.587 * g + 0.114 * b);
  }
  if (!lum.length) return { dark: 0, middle: 0, light: 0, low: 0, high: 0, verdict: 'EMPTY', message: 'Nothing but background is visible' };
  let lo = Infinity, hi = -Infinity;
  for (const v of lum) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const a = lo + (hi - lo) / 3, b = lo + ((hi - lo) * 2) / 3, share = [0, 0, 0];
  for (const v of lum) share[v < a ? 0 : v < b ? 1 : 2]++;
  const [dark, middle, light] = share.map(v => v / lum.length);
  const names = ['dark', 'middle', 'light'], shares = [dark, middle, light];
  const most = Math.max(...shares), least = Math.min(...shares);
  const verdict = hi - lo < 90 ? 'FLAT' : most > 0.72 ? 'ONE_TONE' : least < 0.08 ? 'TWO_TONES' : 'THREE_TONES';
  const message = {
    FLAT: 'Darkest and lightest are close together',
    ONE_TONE: 'Mostly ' + names[shares.indexOf(most)],
    TWO_TONES: 'Almost no ' + names[shares.indexOf(least)],
    THREE_TONES: 'Reads in three tones'
  }[verdict];
  return { dark, middle, light, low: lo, high: hi, verdict, message };
}

function measure(world, image, metrics) {
  const out = {};
  for (const metric of metrics) {
    if (metric === 'stats') out.stats = statsOf(world, image);
    else if (metric === 'lint') out.lint = lintOf(image, world);
    else if (metric === 'crisp') out.crisp = crispOf(image, world);
    else if (metric === 'values') out.values = valuesOf(image, world);
  }
  return out;
}

/* --- ops ------------------------------------------------------------------------------------------------------------ */

defineOp({
  name: 'scene_validate',
  title: 'Validate a diorama',
  effects: 'read',
  description: 'Check a JSON diorama without baking it. Returns every problem with a JSON path and a hint (often a "did you mean"). Use before scene_open or scene_save.',
  input: {
    type: 'object', required: ['scene'],
    properties: { scene: { ...Scenes.sceneSchema, description: 'A path (.json) or spec. Handles are validated in their current state.' } },
    additionalProperties: false
  },
  run({ scene }, ctx) {
    let spec, dir;
    if (scene.handle) {
      const entry = Scenes.open(scene, ctx);
      if (entry.kind !== 'diorama') return { valid: true, errors: [], warnings: [], note: 'Built-in and script scenes are code, not data' };
      spec = Scenes.specOf(entry);
      dir = entry.dir;
    } else if (scene.spec) spec = scene.spec;
    else if (scene.path) {
      const file = path.resolve(ctx.root ?? process.cwd(), scene.path);
      if (!file.endsWith('.json')) throw new OpError('UNSUPPORTED', 'Only .json dioramas can be validated as data', { path: '/scene/path' });
      if (!fs.existsSync(file)) throw new OpError('NOT_FOUND', 'No file at ' + file, { path: '/scene/path' });
      try {
        spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        return { valid: false, errors: [{ level: 'error', path: '', problem: 'not valid JSON: ' + error.message }], warnings: [] };
      }
      dir = path.dirname(file);
    } else throw new OpError('INVALID_INPUT', 'Validate takes a handle, path or spec', { path: '/scene' });
    let problems;
    try {
      problems = Scenes.problemsOf(spec, Scenes.environmentFor(spec, dir, ctx.root));
    } catch (error) {
      if (error instanceof OpError) return { valid: false, errors: [{ level: 'error', path: error.path ?? '', problem: error.message }], warnings: [] };
      throw error;
    }
    const errors = Scenes.errorsOf(problems);
    return { valid: errors.length === 0, errors, warnings: problems.filter(p => p.level !== 'error') };
  }
});

/* the editor's tree as compact rows (depth-first), capped so very large scenes stay affordable */
const TREE_LIMIT = 300;
function treeOf(root) {
  const rows = [];
  let total = 0;
  const walk = (node, depth) => {
    for (const child of node.children ?? []) {
      total++;
      if (rows.length < TREE_LIMIT) {
        const solid = child.solid ?? {};
        rows.push({
          key: child.key, kind: child.kind, depth, ...(child.name && { name: child.name }), ...(child.shape && { shape: child.shape }),
          ...(typeof solid.mat === 'string' && { mat: solid.mat }), ...(solid.part && { part: solid.part }), ...(solid.at && { at: solid.at })
        });
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return { tree: rows, ...(total > rows.length && { treeTruncated: total - rows.length }) };
}

defineOp({
  name: 'scene_open',
  readOnly: true,
  title: 'Open a scene',
  effects: 'expensive',
  description: 'Open a diorama, built-in demo or (when allowed) JS scene and bake it once. Returns a handle for the other scene_* tools, a content revision, counts of solids/parts, the palette roles and, for dioramas, the scene tree with the keys scene_edit operations take (e.g. "slot:1", "part:gem"). Keep the handle; baked worlds are cached per revision. Call again with the handle to reread the tree after edits.',
  input: {
    type: 'object', required: ['scene'],
    properties: {
      scene: Scenes.sceneSchema,
      bake: { type: 'boolean', description: 'Bake now to report splat stats (default true).' },
      tree: { type: 'boolean', description: 'Include the scene tree for dioramas (default true).' }
    },
    additionalProperties: false
  },
  run({ scene, bake = true, tree = true }, ctx) {
    const entry = Scenes.open(scene, ctx);
    const out = Scenes.describe(entry);
    if (tree && entry.kind === 'diorama') Object.assign(out, treeOf(entry.editor.tree()));
    if (bake) {
      const world = Scenes.worldAt(entry, { t: 0 });
      out.splats = world.count;
      out.buildMs = world.buildMs;
      out.camera = world.cam ? { target: world.cam.target, dist: world.cam.dist, yaw: world.cam.yaw, pitch: world.cam.pitch } : undefined;
      out.animated = !!world.anim;
    }
    return compact(out);
  }
});

defineOp({
  name: 'scene_render',
  title: 'Render a scene',
  effects: 'expensive',
  description: 'Render a PNG with the CPU renderer. mode "single" draws one view; "turn" draws `frames` views around the scene on one sheet. Returns the image plus art-pixel size and draw time. Pixel art is small, so images are cheap; scale defaults to fit about 640 px.',
  input: { type: 'object', required: ['scene'], properties: { scene: Scenes.sceneSchema, ...renderProperties }, additionalProperties: false },
  run({ scene, ...options }, ctx) {
    const entry = Scenes.open(scene, { ...ctx, persist: !!scene.handle });
    return renderEntry(entry, options, ctx);
  }
});

/* onFrame(world, image, mode) sees the drawn image, so callers can measure it without drawing it again */
function renderEntry(entry, { t = 0, view = {}, size = {}, look = {}, mode = 'single', frames = 8, scale, out, overwrite = false, measure: metrics }, ctx, onFrame) {
  const world = Scenes.worldAt(entry, { t });
  let image, meta;
  if (mode === 'turn') {
    const baseYaw = view.yaw ?? world.cam?.yaw ?? 0;
    const yaws = Array.from({ length: frames }, (_, i) => baseYaw + (2 * Math.PI * i) / frames);
    const shots = yaws.map(yaw => renderImage(world, { t, view: { ...view, yaw }, size: { w: size.w ?? 320, h: size.h ?? 240 }, look }));
    const cols = Math.min(4, frames);
    image = R().grid(shots.map(s => ({ w: s.w, h: s.h, rgb: s.rgb })), cols);
    image.px = shots[0].px;
    meta = { mode, frames, columns: cols, yaws, artWidth: shots[0].w, artHeight: shots[0].h, drawMs: shots.reduce((s, x) => s + x.drawMs, 0) };
  } else {
    image = renderImage(world, { t, view, size, look });
    meta = { mode, artWidth: image.w, artHeight: image.h, px: image.px, drawMs: image.drawMs };
  }
  const encoded = encodeImage(image, scale ?? autoScale(image.w, image.h));
  if (out) {
    const root = ctx.root ?? process.cwd(), file = path.resolve(root, out);
    /* files under studio/out are disposable previews; anything else is only replaced on request */
    const disposable = file.startsWith(path.join(root, 'studio', 'out') + path.sep);
    if (fs.existsSync(file) && !overwrite && !disposable)
      throw new OpError('EXISTS', 'A file already exists at ' + file, { path: '/out', hint: 'pass overwrite: true or write under studio/out' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(encoded.base64, 'base64'));
    meta.file = file;
  }
  const result = { handle: entry.persisted ? entry.handle : undefined, revision: Scenes.revisionFor(entry), t, ...meta, width: encoded.width, height: encoded.height };
  if (metrics && mode === 'single') result.metrics = measure(world, image, metrics);
  onFrame?.(world, image, mode);
  return { ...compact(result), image: { mimeType: encoded.mimeType, base64: encoded.base64 } };
}

defineOp({
  name: 'scene_measure',
  readOnly: true,
  title: 'Measure a scene',
  effects: 'expensive',
  description: 'Render one view (same size and view options as scene_render) and return numeric quality metrics measured at art-pixel resolution, without an image. Use as a feedback signal after edits: lint and crisp flag pixel-art faults, values checks tonal readability, stats reports splats and palette use.',
  input: {
    type: 'object', required: ['scene'],
    properties: {
      scene: Scenes.sceneSchema, metrics: metricsSchema,
      t: { type: 'number', minimum: 0 }, view: viewSchema, size: sizeSchema, look: lookSchema
    },
    additionalProperties: false
  },
  run({ scene, metrics = METRICS, t = 0, view = {}, size = {}, look = {} }, ctx) {
    const entry = Scenes.open(scene, { ...ctx, persist: !!scene.handle });
    const world = Scenes.worldAt(entry, { t });
    const image = renderImage(world, { t, view, size, look });
    return compact({ handle: scene.handle, revision: Scenes.revisionFor(entry), t, ...measure(world, image, metrics) });
  }
});

/* --- editing -------------------------------------------------------------------------------------------------------- */

const EDIT_OPS = {
  patch: 'RFC 6902 operation on the diorama JSON: { op: "patch", patch: { op: add|remove|replace|move|copy|test, path, value?, from? } }. Use it to add or remove solids ("/solids/-"), parts, motion or finish settings.',
  setTransform: '{ op, keys, patch: { translation?, rotation? [yaw,tilt,roll], scale?, pivot? } }',
  updateShape: '{ op, keys, patch } edits geometry fields of solids or operands',
  setModifiers: '{ op, keys, modifiers: [{ id, kind: join|mask|fold|warp|shell|swell|rough|bubbles, ... }] }',
  updateModifier: '{ op, keys, id, patch }',
  setMaterial: '{ op, keys, material } role name or full material object',
  setRole: '{ op, name, ramp: [palette indices] }',
  revert: '{ op: "revert", revision } restores an earlier revision of this session (must be the only operation)'
};
const editOpSchema = {
  type: 'object', required: ['op'],
  properties: {
    op: { type: 'string', enum: Object.keys(EDIT_OPS) },
    keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Scene tree keys, e.g. "slot:1" or "part:gem", from the tree scene_open returns. Required by setTransform, updateShape, setModifiers, updateModifier and setMaterial.' },
    patch: { type: 'object' }, modifiers: { type: 'array' }, id: { type: 'string' }, material: { type: ['string', 'object'] },
    name: { type: 'string' }, ramp: { type: 'array', items: { type: 'integer' } }, revision: { type: 'string' }
  },
  additionalProperties: false
};

function applyEditorOp(editor, op, index) {
  const keys = op.keys;
  const needs = (...fields) => {
    for (const field of fields)
      if (op[field] === undefined) throw new OpError('INVALID_INPUT', op.op + ' needs ' + field, { path: '/operations/' + index + '/' + field });
  };
  /* without keys the editor would fall back to its selection, which a draft never has: the edit would silently do nothing */
  if (op.op !== 'setRole') needs('keys');
  switch (op.op) {
    case 'setTransform': needs('patch'); return editor.setTransform(op.patch, keys);
    case 'updateShape': needs('patch'); return editor.updateShape(op.patch, keys);
    case 'setModifiers': needs('modifiers'); return editor.setModifiers(op.modifiers, keys);
    case 'updateModifier': needs('id', 'patch'); return editor.updateModifier(op.id, op.patch, keys);
    case 'setMaterial': needs('material'); return editor.setMaterial(op.material, keys);
    case 'setRole': needs('name', 'ramp'); return editor.setRole(op.name, op.ramp);
  }
}

function editError(error, index) {
  if (error instanceof OpError) return error;
  return new OpError(error.problems ? 'INVALID_SCENE' : 'EDIT_FAILED', error.message.split('\n')[0], {
    path: '/operations/' + index, details: error.problems
  });
}

/* Applies the batch to a draft built from the current spec. Nothing in the session changes unless every operation and the
   final validation pass, and dryRun is false. Consecutive patches apply to the raw JSON, so only the scene before a keyed
   operation and the final result have to validate; the environment (meshes, prefab library) is reloaded after patches. */
function draftEdits(entry, operations, root) {
  const before = Scenes.specOf(entry);
  let spec = before, env = entry.env, editor = null, settled = null, patched = false;
  const reload = () => {
    if (!patched) return;
    env = Scenes.environmentFor(spec, entry.dir, root);
    patched = false;
  };
  const valid = () => {
    if (spec === before) return Scenes.makeEditor(spec, env);
    reload();
    const errors = Scenes.errorsOf(Scenes.problemsOf(spec, env));
    if (errors.length) throw new OpError('INVALID_SCENE', 'The diorama has errors', { details: errors });
    return Scenes.makeEditor(spec, env);
  };
  const settle = () => {
    if (!editor) return;
    editor.commit();
    spec = editor.snapshot();
    settled = editor;
    editor = null;
  };
  operations.forEach((op, index) => {
    try {
      if (op.op === 'patch') {
        if (!op.patch) throw new OpError('INVALID_INPUT', 'patch needs a patch object', { path: '/operations/' + index + '/patch' });
        settle();
        spec = applyPatch(spec, op.patch, index);
        settled = null;
        patched = true;
      } else {
        if (!editor) {
          editor = settled ?? valid();
          settled = null;
          editor.begin('agent edit');
        }
        applyEditorOp(editor, op, index);
      }
    } catch (error) {
      if (editor) editor.cancel();
      throw editError(error, index);
    }
  });
  try {
    settle();
    settled ??= valid();
  } catch (error) {
    throw editError(error, operations.length - 1);
  }
  return { before, after: settled.snapshot(), editor: settled, env };
}

/* Repairs a .json diorama that does not validate: patch operations apply to the raw JSON and only the result must validate.
   Editor operations need a valid scene, so a repair batch may only contain patches. */
function repairFile(given, { operations, baseRevision, dryRun, render, metrics }, ctx) {
  const root = ctx.root ?? process.cwd(), file = path.resolve(root, given), dir = path.dirname(file);
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const current = revisionOf(before);
  if (baseRevision !== undefined && baseRevision !== current)
    throw new OpError('STALE_REVISION', 'The file is at ' + current + ', not ' + baseRevision, { hint: 'reread it or drop baseRevision' });
  const original = Scenes.problemsOf(before, Scenes.environmentFor(before, dir, root));
  const editorOp = operations.findIndex(op => op.op !== 'patch');
  if (editorOp >= 0)
    throw new OpError('INVALID_SCENE', 'The file does not validate yet; repair it with patch operations first', {
      path: '/operations/' + editorOp, hint: 'use { "op": "patch", "patch": { ... } } for every operation until the file validates',
      details: Scenes.errorsOf(original)
    });
  let after = before;
  operations.forEach((op, index) => {
    if (!op.patch) throw new OpError('INVALID_INPUT', 'patch needs a patch object', { path: '/operations/' + index + '/patch' });
    after = applyPatch(after, op.patch, index);
  });
  const env = Scenes.environmentFor(after, dir, root);
  const remaining = Scenes.errorsOf(Scenes.problemsOf(after, env));
  if (remaining.length) throw new OpError('INVALID_SCENE', 'The repaired diorama still has errors', { details: remaining });
  const editor = Scenes.makeEditor(after, env);
  const result = {
    dryRun, repaired: true, fixed: Scenes.errorsOf(original), previousRevision: current, revision: revisionOf(after),
    changes: diff(before, after)
  };
  if (!dryRun) {
    writeAtomic(file, editor.serialize(2) + '\n');
    result.file = file;
  }
  const target = { kind: 'diorama', editor, env, dir, file, worlds: new Map(), warnings: [], history: [] };
  return withRender(result, target, render, metrics, ctx);
}

/* write-then-rename so readers never see half a file; the temporary file is removed if anything fails */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

defineOp({
  name: 'scene_edit',
  title: 'Edit a diorama',
  effects: 'write',
  description: 'Apply a batch of edits to a diorama atomically: either every operation applies and the scene validates, or nothing changes. scene is an open handle, or a .json path, which is edited and written back in place (useful from the shell, where handles do not persist). A .json path that does not validate yet can be repaired with patch operations: only the result has to validate. Pass baseRevision to guard against stale state and dryRun to preview. Optionally render and/or measure the result in the same call. Operations: ' +
    Object.entries(EDIT_OPS).map(([k, v]) => k + ' ' + v).join('; '),
  input: {
    type: 'object', required: ['scene', 'operations'],
    properties: {
      scene: {
        type: 'object', description: 'Exactly one of handle (from scene_open) or path (a .json diorama, saved in place).',
        properties: { handle: { type: 'string' }, path: { type: 'string' } }, additionalProperties: false
      },
      operations: { type: 'array', items: editOpSchema, minItems: 1, maxItems: 200 },
      baseRevision: { type: 'string', description: 'Fail with STALE_REVISION unless the scene is still at this revision.' },
      dryRun: { type: 'boolean', description: 'Validate and report the diff without changing the session.' },
      render: { ...renderOptionsSchema, description: 'Render the result: same fields as scene_render without scene.' },
      measure: metricsSchema
    },
    additionalProperties: false
  },
  async run({ scene, operations, baseRevision, dryRun = false, render, measure: metrics }, ctx) {
    if (scene.path !== undefined && !/\.json$/i.test(scene.path))
      throw new OpError('UNSUPPORTED', 'Only .json dioramas can be edited by path', { path: '/scene/path' });
    let entry;
    try {
      entry = Scenes.open(scene, { ...ctx, persist: !!scene.handle });
    } catch (error) {
      /* a file that does not validate yet cannot be opened, but it can be repaired with patches */
      if (scene.path === undefined || error.code !== 'INVALID_SCENE') throw error;
      return repairFile(scene.path, { operations, baseRevision, dryRun, render, metrics }, ctx);
    }
    if (entry.kind !== 'diorama')
      throw new OpError('NOT_EDITABLE', 'Only JSON dioramas are editable; this is a ' + entry.kind + ' scene', { path: '/scene/handle' });
    const current = Scenes.revisionFor(entry);
    if (baseRevision !== undefined && baseRevision !== current)
      throw new OpError('STALE_REVISION', 'The scene is at ' + current + ', not ' + baseRevision, { hint: 'reread with scene_open or drop baseRevision' });

    let after, editor, env;
    if (operations[0].op === 'revert') {
      if (operations.length !== 1) throw new OpError('INVALID_INPUT', 'revert must be the only operation', { path: '/operations' });
      const found = entry.history.find(h => h.revision === operations[0].revision);
      if (!found) throw new OpError('NOT_FOUND', 'No earlier revision ' + operations[0].revision + ' in this session', {
        path: '/operations/0/revision', hint: 'known: ' + entry.history.map(h => h.revision).join(', ')
      });
      after = found.spec;
      env = found.env;
      editor = Scenes.makeEditor(after, env);
    } else ({ after, editor, env } = draftEdits(entry, operations, ctx.root));

    const before = Scenes.specOf(entry);
    const revision = revisionOf(after);
    const result = { handle: entry.persisted ? entry.handle : undefined, dryRun, previousRevision: current, revision, changes: diff(before, after) };
    if (!dryRun && revision !== current) {
      entry.history.push({ revision: current, spec: before, env: entry.env });
      if (entry.history.length > Scenes.HISTORY_LIMIT) entry.history.shift();
      entry.editor = editor;
      entry.env = env;
      entry.warnings = Scenes.problemsOf(after, env);
      entry.dirty = true;
      if (!entry.persisted) {
        writeAtomic(entry.file, editor.serialize(2) + '\n');
        entry.dirty = false;
        result.file = entry.file;
      }
    }
    const target = dryRun
      ? { kind: 'diorama', editor, env, dir: entry.dir, file: entry.file, seedOverride: entry.seedOverride, worlds: new Map(), warnings: [], history: [] }
      : entry;
    return withRender(result, target, render, metrics, ctx);
  }
});

/* adds the optional render and metrics of an edit result; a single view is drawn once and measured from the same image */
function withRender(result, target, render, metrics, ctx) {
  let measured;
  if (render) {
    result.render = renderEntry(target, render, ctx, (world, image, mode) => {
      if (metrics && mode === 'single') measured = measure(world, image, metrics);
    });
    delete result.render.handle;
  }
  if (metrics) {
    if (!measured) {
      const t = render?.t ?? 0, world = Scenes.worldAt(target, { t });
      measured = measure(world, renderImage(world, { t, view: render?.view, size: render?.size, look: render?.look }), metrics);
    }
    result.metrics = measured;
  }
  const image = result.render?.image;
  if (image) delete result.render.image;
  const out = compact(result);
  if (image) out.image = image;
  return out;
}

defineOp({
  name: 'scene_save',
  destructive: true,
  idempotent: true,
  title: 'Save a diorama',
  effects: 'write',
  description: 'Write the current diorama JSON of an open scene to disk. Defaults to the file it was opened from. Returns the path and revision.',
  input: {
    type: 'object', required: ['scene'],
    properties: {
      scene: { type: 'object', required: ['handle'], properties: { handle: { type: 'string' } }, additionalProperties: false },
      path: { type: 'string', description: 'Destination .json path; required for scenes not opened from a file.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing file other than the source (default false).' }
    },
    additionalProperties: false
  },
  run({ scene, path: destination, overwrite = false }, ctx) {
    const entry = Scenes.open(scene, ctx);
    if (entry.kind !== 'diorama') throw new OpError('NOT_EDITABLE', 'Only JSON dioramas can be saved', { path: '/scene/handle' });
    const file = destination ? path.resolve(ctx.root ?? process.cwd(), destination) : entry.file;
    if (!file) throw new OpError('INVALID_INPUT', 'This scene was not opened from a file; pass path', { path: '/path' });
    if (!file.endsWith('.json')) throw new OpError('INVALID_INPUT', 'Save to a .json path', { path: '/path' });
    if (file !== entry.file && fs.existsSync(file) && !overwrite)
      throw new OpError('EXISTS', 'A file already exists at ' + file, { path: '/path', hint: 'pass overwrite: true' });
    writeAtomic(file, entry.editor.serialize(2) + '\n');
    if (!entry.file) {
      entry.file = file;
      entry.dir = path.dirname(file);
    }
    entry.dirty = false;
    return { handle: entry.handle, file, revision: Scenes.revisionFor(entry) };
  }
});

module.exports = { METRICS, EDIT_OPS, measure, renderImage };
