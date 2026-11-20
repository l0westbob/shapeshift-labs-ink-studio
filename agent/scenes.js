'use strict';
/* Scene sessions for agents. A scene is opened from a JSON diorama (inline or on disk), a built-in demo id or, when code is
   allowed, a JavaScript scene file. Each open scene gets a handle; baked worlds are cached per revision and seed so a
   render-measure-edit loop does not rebake on every call. One-shot callers can pass a source wherever a handle is accepted. */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { OpError } = require('./registry.js');
const { revisionOf } = require('./data.js');

let toolkit;
const studio = () => require('../index.js');
const kit = () => (toolkit ??= studio().load());
const ArtDirection = () => require('../src/art-direction.js');

const HISTORY_LIMIT = 50;
const SESSION_LIMIT = 32;
const sessions = new Map();

/* --- where a scene comes from --------------------------------------------------------------------------------------- */

const SOURCE_KEYS = ['handle', 'path', 'spec', 'builtin'];
const sceneSchema = {
  type: 'object',
  description: 'Exactly one of: handle (from scene_open), path (.json diorama or .js scene file), spec (inline diorama object), builtin (demo id).',
  properties: {
    handle: { type: 'string', description: 'Handle returned by scene_open.' },
    path: { type: 'string', description: 'Path to a .json diorama, or a .js scene file when allowCode is set.' },
    spec: { type: 'object', description: 'Inline JSON diorama.' },
    builtin: { type: 'string', description: 'Built-in demo id, e.g. watcher, burn, idol, bench, stuff, cabinet, rehearsal.' },
    seed: { type: 'integer', description: 'Seed override for one-shot sources. Ignored with a handle.' }
  },
  additionalProperties: false
};

function sourceKey(scene) {
  const given = SOURCE_KEYS.filter(key => scene?.[key] !== undefined);
  if (given.length !== 1)
    throw new OpError('INVALID_INPUT', 'Pass exactly one of ' + SOURCE_KEYS.join(', ') + ' in scene', {
      path: '/scene', hint: given.length ? 'got ' + given.join(' and ') : 'got none'
    });
  return given[0];
}

function codeAllowed(ctx) {
  return ctx.allowCode === true || process.env.INK_AGENT_ALLOW_CODE === '1';
}

/* loads a prefab library and the mesh files a diorama names, resolved beside the file it came from (as the CLI does) */
function environmentFor(spec, dir, root = process.cwd()) {
  const K = kit().KIT;
  let prefabs;
  if (spec.prefabLibrary !== undefined) {
    if (!dir) throw new OpError('UNSUPPORTED', 'prefabLibrary needs a diorama opened from a path', { path: '/spec/prefabLibrary' });
    const library = path.resolve(dir, spec.prefabLibrary);
    if (!fs.existsSync(library)) throw new OpError('NOT_FOUND', 'No prefab library at ' + library, { path: '/spec/prefabLibrary' });
    prefabs = JSON.parse(fs.readFileSync(library, 'utf8'));
    for (const definition of Object.values(prefabs ?? {}))
      for (const solid of K.diorama.solids({ solids: Object.values(definition?.solids ?? {}) }))
        if (solid.kind === 'mesh' && typeof solid.asset === 'string') solid.asset = path.resolve(path.dirname(library), solid.asset);
  }
  const assets = {};
  let expanded = spec;
  try {
    expanded = K.authoring.scenePrefabs.expand(spec, { prefabs }).spec;
  } catch (error) {
    throw new OpError('INVALID_SCENE', error.message);
  }
  for (const solid of K.diorama.solids(expanded)) {
    if (solid.kind !== 'mesh' || typeof solid.asset !== 'string' || assets[solid.asset]) continue;
    const base = path.resolve(dir ?? root, solid.asset);
    const file = ['', '.obj', '.glb', '.gltf'].map(ext => base + ext).find(f => fs.existsSync(f) && fs.statSync(f).isFile());
    if (file) assets[solid.asset] = studio().readMesh(file);
  }
  return { assets, prefabs };
}

const problemsOf = (spec, env) => kit().KIT.diorama.check(spec, env);
const errorsOf = problems => problems.filter(problem => problem.level === 'error');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new OpError(error.code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_JSON', error.message, { path: '/scene/path' });
  }
}

/* --- sessions ------------------------------------------------------------------------------------------------------- */

function makeEditor(spec, env) {
  try {
    return studio().createSceneEditor(spec, { env, historyLimit: HISTORY_LIMIT });
  } catch (error) {
    throw new OpError('INVALID_SCENE', 'The diorama has errors', { details: error.problems ?? [{ problem: error.message }] });
  }
}

function openDiorama(spec, { file, seed, root } = {}) {
  const dir = file ? path.dirname(file) : undefined;
  const env = environmentFor(spec, dir, root);
  const problems = problemsOf(spec, env);
  if (errorsOf(problems).length) throw new OpError('INVALID_SCENE', 'The diorama has errors', { details: problems });
  const editor = makeEditor(spec, env);
  return { kind: 'diorama', file, dir, env, editor, seedOverride: seed, warnings: problems, history: [] };
}

function open(scene, ctx = {}) {
  const key = sourceKey(scene);
  if (key === 'handle') {
    const entry = sessions.get(scene.handle);
    if (!entry) throw new OpError('NOT_FOUND', 'No open scene with handle ' + scene.handle, { path: '/scene/handle', hint: 'call scene_open again' });
    entry.used = Date.now();
    return entry;
  }
  let entry;
  if (key === 'spec') entry = openDiorama(scene.spec, { seed: scene.seed, root: ctx.root });
  else if (key === 'builtin') {
    const descriptor = kit().SCENES.find(s => s.id === scene.builtin);
    if (!descriptor) throw new OpError('NOT_FOUND', 'No built-in scene "' + scene.builtin + '"', {
      path: '/scene/builtin', hint: 'built-ins: ' + kit().SCENES.map(s => s.id).join(', ')
    });
    entry = { kind: 'builtin', descriptor, seedOverride: scene.seed, warnings: [] };
  } else {
    const file = path.resolve(ctx.root ?? process.cwd(), scene.path);
    if (file.endsWith('.json')) entry = openDiorama(readJson(file), { file, seed: scene.seed });
    else if (file.endsWith('.js')) {
      if (!codeAllowed(ctx))
        throw new OpError('CODE_NOT_ALLOWED', 'JavaScript scene files run arbitrary code and are disabled', {
          path: '/scene/path', hint: 'use a .json diorama, or start the server with INK_AGENT_ALLOW_CODE=1'
        });
      if (!fs.existsSync(file)) throw new OpError('NOT_FOUND', 'No file at ' + file, { path: '/scene/path' });
      delete require.cache[file];
      entry = { kind: 'script', file, descriptor: require(file)(kit()), seedOverride: scene.seed, warnings: [] };
    } else throw new OpError('UNSUPPORTED', 'Scene paths must end in .json or .js', { path: '/scene/path' });
  }
  entry.handle = 'scn_' + randomUUID().slice(0, 8);
  entry.worlds = new Map();
  entry.used = Date.now();
  if (ctx.persist !== false) remember(entry);
  return entry;
}

function remember(entry) {
  entry.persisted = true;
  sessions.set(entry.handle, entry);
  if (sessions.size <= SESSION_LIMIT) return;
  const oldest = [...sessions.values()].sort((a, b) => a.used - b.used)[0];
  sessions.delete(oldest.handle);
}

const close = handle => sessions.delete(handle);

/* --- the scene's source and identity -------------------------------------------------------------------------------- */

const specOf = entry => (entry.kind === 'diorama' ? entry.editor.snapshot() : undefined);
const revisionFor = entry =>
  entry.kind === 'diorama' ? revisionOf(specOf(entry)) : revisionOf({ kind: entry.kind, id: entry.descriptor.id, file: entry.file });
const descriptorOf = entry => (entry.kind === 'diorama' ? kit().KIT.diorama.scene(specOf(entry), entry.env) : entry.descriptor);

/* --- baking and posing ---------------------------------------------------------------------------------------------- */

/* the same finishing the CLI gives a freshly built world, without any of its command-line overrides */
function finishWorld(world, descriptor) {
  const { KIT: K } = kit();
  const assembled = (descriptor.animate && descriptor.animate(world, world.seed)) || world;
  if (assembled.sandbox && !assembled.anim) K.sandbox.attach(assembled);
  if (assembled.pix && K.pixel) {
    assembled.pixTex = K.pixel.evaluators(assembled);
    assembled.pixCell = K.pixel.CELL;
    assembled.pixView = K.pixel.VIEW;
    assembled.pixUnfold = K.pixel.unfold;
    assembled.pixAnchors = K.pixel.anchors;
  }
  assembled.clock = 0;
  if (assembled.anim?.motionSettings) assembled.anim.motionDirection = ArtDirection().prepare(assembled.look?.artDirection);
  if (assembled.anim?.stateful) assembled.anim.update(0, 0);
  return assembled;
}

function bake(entry, seed) {
  const descriptor = descriptorOf(entry);
  const useSeed = seed ?? entry.seedOverride ?? descriptor.seed;
  const started = Date.now();
  let world;
  try {
    world = descriptor.build(useSeed);
  } catch (error) {
    throw new OpError('BUILD_FAILED', error.message);
  }
  world.seed = useSeed;
  world = finishWorld(world, descriptor);
  world.id = descriptor.id;
  world.name = descriptor.name;
  world.buildMs = Date.now() - started;
  return world;
}

/* a baked world at time t. Worlds that remember their past (anim.stateful) only run forwards, so asking for an earlier
   time rebakes. Stateless worlds are reused at any time. */
function worldAt(entry, { seed, t = 0 } = {}) {
  const key = revisionFor(entry) + ':' + (seed ?? entry.seedOverride ?? 'default');
  let world = entry.worlds.get(key);
  if (!world || (world.anim?.stateful && t < world.clock - 1e-9)) {
    world = bake(entry, seed);
    entry.worlds.clear();
    entry.worlds.set(key, world);
  }
  pose(world, t);
  return world;
}

/* the CLI's pose() without taps or command-line art direction */
function pose(world, t) {
  if (!world.anim) return;
  const AD = ArtDirection();
  const direction = AD.prepare(world.look?.artDirection);
  if (world.anim.motionSettings) world.anim.motionDirection = direction;
  const sceneTime = AD.time(direction, t);
  if (world.anim.stateful) {
    const separateCloth = direction?.cadence.scene && direction.cadence.cloth !== undefined && world.anim.hasIndependentCloth?.();
    const advanceScene = to => {
      while (world.clock < to - 1e-9) {
        const dt = Math.min(1 / 60, to - world.clock);
        world.clock += dt;
        if (separateCloth) world.anim.update(dt, world.clock, { separateCloth });
        else world.anim.update(dt, world.clock);
      }
    };
    if (separateCloth) {
      let at = world.clothClock ?? world.clock;
      while (at < t - 1e-9) {
        const dt = Math.min(1 / 60, t - at);
        at += dt;
        advanceScene(AD.time(direction, at));
        world.anim.advanceCloth(dt, at);
      }
      world.clothClock = t;
    } else advanceScene(sceneTime);
  } else world.anim.update(1 / 60, sceneTime);
  world.clock = sceneTime;
  if (world.anim.bones) {
    if (!world.rest) world.rest = world.data;
    world.data = kit().KIT.bones.posed({
      data: world.rest,
      anim: world.anim,
      get posedBuf() { return world.posedBuf; },
      set posedBuf(v) { world.posedBuf = v; }
    });
  }
}

/* --- summaries ------------------------------------------------------------------------------------------------------ */

function treeSummary(node) {
  const counts = { solids: 0, parts: 0, groups: 0 };
  const walk = n => {
    if (n.kind === 'solid') counts.solids++;
    else if (n.kind === 'part') counts.parts++;
    else if (n.kind === 'group') counts.groups++;
    (n.children || []).forEach(walk);
  };
  walk(node);
  return counts;
}

function describe(entry) {
  const out = {
    handle: entry.handle,
    kind: entry.kind,
    editable: entry.kind === 'diorama',
    revision: revisionFor(entry)
  };
  if (entry.kind === 'diorama') {
    const spec = specOf(entry);
    Object.assign(out, { id: spec.id, name: spec.name, seed: entry.seedOverride ?? spec.seed, ...treeSummary(entry.editor.tree()) });
    out.roles = Object.keys(entry.editor.materials()?.roles ?? {});
    if (entry.file) out.file = entry.file;
  } else Object.assign(out, { id: entry.descriptor.id, name: entry.descriptor.name, seed: entry.seedOverride ?? entry.descriptor.seed });
  const warnings = entry.warnings.filter(p => p.level !== 'error');
  if (warnings.length) out.warnings = warnings;
  return out;
}

module.exports = {
  kit, studio, sceneSchema, open, close, sessions, specOf, revisionFor, worldAt, pose, descriptorOf, describe, makeEditor,
  environmentFor, problemsOf, errorsOf, HISTORY_LIMIT
};
