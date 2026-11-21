'use strict';
/* scene_fit: inverse modelling. Numbers in a diorama (positions, sizes, radii, cells, ...) are tuned until orthographic
   renders match target views: the drawings of a carve source, other letter grids, or PNGs. It searches with a (1+λ)
   evolution strategy in the parameters' [min, max] box, scores silhouette overlap and colour agreement at art-pixel
   resolution (optionally pixel-art faults), and writes the best diorama with before and after sheets.

   Rendering the whole scene once per candidate is slow but needs no gradients, so it works for every solid kind and every
   front end; time is the cost, and `budget` caps it. */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const Scenes = require('../scenes.js');

const SceneOps = () => require('./scene.js');
const Carve = () => require('../../cli/carve-model.js');
const PNG = () => require('../../cli/png.js');

/* the camera for each drawn view, orthographic (see carve-model.js for how views are drawn) */
const CAMERAS = {
  front: { yaw: 0, pitch: 0 }, back: { yaw: Math.PI, pitch: 0 }, right: { yaw: Math.PI / 2, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 }, top: { yaw: 0, pitch: Math.PI / 2 - 1e-3 }, bottom: { yaw: 0, pitch: -Math.PI / 2 + 1e-3 }
};

const colourValue = value => {
  const text = typeof value === 'object' && value ? value.colour ?? value.color : value;
  return typeof text === 'number' ? text : parseInt(String(text).replace('#', ''), 16);
};
const rgbOf = c => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/* a target as a grid: mask (filled or not) and a colour family per pixel */
function targetsOf(list, root) {
  const out = [];
  for (const [i, target] of list.entries()) {
    const where = '/targets/' + i;
    if (target.views) {
      const file = path.resolve(root, target.views);
      if (!fs.existsSync(file)) throw new OpError('NOT_FOUND', 'No views file at ' + file, { path: where + '/views' });
      const source = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [view, rows] of Object.entries(source.views ?? {})) out.push(gridTarget(view, rows, source.colours, where));
    } else if (target.rows) out.push(gridTarget(target.view, target.rows, target.colours, where));
    else if (target.image) {
      if (!CAMERAS[target.view]) throw new OpError('INVALID_INPUT', 'A target needs a view: ' + Object.keys(CAMERAS).join(', '), { path: where + '/view' });
      const image = PNG().read(path.resolve(root, target.image));
      const bg = target.background !== undefined ? rgbOf(colourValue(target.background)) : [...image.rgb.subarray(0, 3)];
      const colours = new Map(), cells = [];
      for (let p = 0; p < image.w * image.h; p++) {
        const rgb = [...image.rgb.subarray(p * 3, p * 3 + 3)];
        if (dist2(rgb, bg) < 300) cells.push(null);
        else {
          const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
          if (!colours.has(key)) colours.set(key, colours.size);
          cells.push(key);
        }
      }
      out.push({ view: target.view, w: image.w, h: image.h, cells, colours: [...colours.keys()] });
    } else throw new OpError('INVALID_INPUT', 'A target is { views: file }, { view, rows, colours } or { view, image }', { path: where });
  }
  if (!out.length) throw new OpError('INVALID_INPUT', 'No targets', { path: '/targets' });
  return out;
}

function gridTarget(view, rows, colours, where) {
  if (!CAMERAS[view]) throw new OpError('INVALID_INPUT', 'No view called "' + view + '"', { path: where + '/view', hint: 'views: ' + Object.keys(CAMERAS).join(', ') });
  if (!colours) throw new OpError('INVALID_INPUT', 'Letter grids need colours', { path: where + '/colours' });
  const lines = Carve().rowsOf(rows), w = Math.max(...lines.map(r => r.length)), h = lines.length;
  const cells = [];
  for (let v = 0; v < h; v++)
    for (let u = 0; u < w; u++) {
      const ch = lines[v][u];
      cells.push(!ch || ch === '.' || ch === ' ' || colours[ch] === undefined ? null : colourValue(colours[ch]));
    }
  return { view, w, h, cells, colours: [...new Set(cells.filter(c => c !== null))] };
}

const bounds = (w, h, filled) => {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (filled(x, y)) x0 = Math.min(x0, x), x1 = Math.max(x1, x), y0 = Math.min(y0, y), y1 = Math.max(y1, y);
  return x1 < 0 ? null : { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

/* how well a render matches a target. The render is scaled uniformly so its silhouette covers the same area as the
   target's and centred on it (centre of mass on centre of mass), so framing and overall scale do not matter but proportions do. Colours compare by family:
   a render pixel belongs to the target colour whose shade ramp holds the nearest shade */
function compare(target, image, background, families) {
  const tb = bounds(target.w, target.h, (x, y) => target.cells[y * target.w + x] !== null);
  const bg = rgbOf(background);
  const at = (x, y) => [...image.rgb.subarray((y * image.w + x) * 3, (y * image.w + x) * 3 + 3)];
  const filledAt = (x, y) => x >= 0 && y >= 0 && x < image.w && y < image.h && dist2(at(x, y), bg) > 30;
  const rb = bounds(image.w, image.h, filledAt);
  if (!tb || !rb) return { silhouette: 0, colour: 0 };
  /* areas and centroids: centring on the centre of mass, not the bounding box, keeps a thin part (an antenna) that one
     side has and the other lacks from shifting the whole comparison */
  let targetArea = 0, renderArea = 0, tcx = 0, tcy = 0, rcx = 0, rcy = 0;
  for (let y = 0; y < target.h; y++) for (let x = 0; x < target.w; x++) if (target.cells[y * target.w + x] !== null) (targetArea++, (tcx += x + 0.5), (tcy += y + 0.5));
  for (let y = rb.y0; y < rb.y0 + rb.h; y++) for (let x = rb.x0; x < rb.x0 + rb.w; x++) if (filledAt(x, y)) (renderArea++, (rcx += x + 0.5), (rcy += y + 0.5));
  (tcx /= targetArea), (tcy /= targetArea), (rcx /= renderArea), (rcy /= renderArea);
  const k = Math.sqrt(targetArea / renderArea); /* target cells per render pixel */
  const x0 = Math.floor(Math.min(tb.x0, tcx - (rb.w * k) / 2)), x1 = Math.ceil(Math.max(tb.x0 + tb.w, tcx + (rb.w * k) / 2));
  const y0 = Math.floor(Math.min(tb.y0, tcy - (rb.h * k) / 2)), y1 = Math.ceil(Math.max(tb.y0 + tb.h, tcy + (rb.h * k) / 2));
  let both = 0, either = 0, same = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const inside = x >= 0 && y >= 0 && x < target.w && y < target.h;
      const want = inside ? target.cells[y * target.w + x] : null;
      const rx = Math.floor(rcx + (x + 0.5 - tcx) / k), ry = Math.floor(rcy + (y + 0.5 - tcy) / k);
      const filled = filledAt(rx, ry);
      if (want !== null || filled) either++;
      if (want !== null && filled) {
        both++;
        const got = at(rx, ry);
        let best = null, bestD = Infinity;
        for (const [colour, shades] of families) for (const shade of shades) {
          const d = dist2(got, shade);
          if (d < bestD) (bestD = d), (best = colour);
        }
        if (best === want) same++;
      }
    }
  return { silhouette: either ? both / either : 0, colour: both ? same / both : 0 };
}

/* JSON pointer read and write on a plain object */
const tokens = pointer => pointer.split('/').slice(1).map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'));
const getAt = (obj, pointer) => tokens(pointer).reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setAt(obj, pointer, value) {
  const keys = tokens(pointer), last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

/* small seeded generator for the search */
function random(seed) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return { next, gauss: () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next()) };
}

function sheet(rows, file) {
  /* rows of images (w, h, rgb), each row side by side, scaled up for viewing */
  const R = require('../../cli/render.js');
  const scale = 3, gap = 4;
  const scaled = rows.map(row => row.map(img => (img ? R.upscale(img, scale) : null)));
  const width = Math.max(...scaled.map(row => row.reduce((s, img) => s + (img?.w ?? 0) + gap, gap)));
  const height = scaled.reduce((s, row) => s + Math.max(...row.map(img => img?.h ?? 0)) + gap, gap);
  const rgb = new Uint8Array(width * height * 3).fill(24);
  let top = gap;
  for (const row of scaled) {
    let left = gap;
    for (const img of row) {
      if (!img) continue;
      for (let y = 0; y < img.h; y++) rgb.set(img.rgb.subarray(y * img.w * 3, (y + 1) * img.w * 3), ((top + y) * width + left) * 3);
      left += img.w + gap;
    }
    top += Math.max(...row.map(img => img?.h ?? 0)) + gap;
  }
  fs.writeFileSync(file, PNG().encode(width, height, rgb));
}

/* a target drawn at about the height of its renders, in whole pixels per cell */
const targetImage = (target, height) => {
  const k = Math.max(1, Math.floor(height / target.h)), w = target.w * k, h = target.h * k;
  const rgb = new Uint8Array(w * h * 3).fill(11);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = target.cells[Math.floor(y / k) * target.w + Math.floor(x / k)];
      if (c !== null) rgb.set(rgbOf(c), (y * w + x) * 3);
    }
  return { w, h, rgb };
};

defineOp({
  name: 'scene_fit',
  destructive: true,
  title: 'Fit a scene to target views',
  effects: 'expensive',
  description: 'Inverse modelling: tune numbers in a diorama until orthographic renders match target views. params are JSON pointers into the diorama with a range ({ path: "/solids/3/at/1", min, max } or paths: [...] to move several fields together, e.g. mirrored parts). targets are the views of a carve source ({ views: "model.views.json" }), letter grids ({ view: "front", rows, colours }) or PNGs ({ view, image }). Each candidate is baked and rendered from every target view; the score is silhouette overlap and colour agreement (each render is scaled to the area of the target and centred, so framing and overall scale do not matter but proportions do), minus pixel-art noise if weights.lint is set. Writes the best diorama to out/scene.json, out/fit.png (per view: target, before, after) and returns the best values and the score history. Slow by design: every candidate rebakes the scene; budget caps the seconds.',
  input: {
    type: 'object', required: ['scene', 'params', 'targets', 'out'],
    properties: {
      scene: Scenes.sceneSchema,
      params: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', required: ['min', 'max'],
          properties: { path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, minItems: 1 }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number', exclusiveMinimum: 0 } },
          additionalProperties: false
        }
      },
      targets: { type: 'array', minItems: 1, items: { type: 'object' } },
      out: { type: 'string', description: 'Directory for scene.json, fit.png and fit.json.' },
      iterations: { type: 'integer', minimum: 1, maximum: 500, description: 'Generations (default 20).' },
      population: { type: 'integer', minimum: 1, maximum: 64, description: 'Candidates per generation (default 6).' },
      sigma: { type: 'number', minimum: 0.001, maximum: 1, description: 'Starting step as a share of each range (default 0.15).' },
      size: { type: 'integer', minimum: 24, maximum: 512, description: 'Render size in pixels for each view (default 96).' },
      weights: {
        type: 'object', properties: { silhouette: { type: 'number' }, colour: { type: 'number' }, lint: { type: 'number' } }, additionalProperties: false,
        description: 'Score weights (default silhouette 1, colour 0.5, lint 0).'
      },
      budget: { type: 'number', minimum: 1, description: 'Stop after this many seconds (default 600).' },
      seed: { type: 'integer', description: 'Seed for the search (default 1).' }
    },
    additionalProperties: false
  },
  async run({ scene, params, targets: targetList, out, iterations = 20, population = 6, sigma = 0.15, size = 96, weights = {}, budget = 600, seed = 1 }, ctx) {
    const root = ctx.root ?? process.cwd();
    const opened = Scenes.open(scene, { ...ctx, persist: false });
    if (opened.kind !== 'diorama') throw new OpError('NOT_EDITABLE', 'scene_fit tunes JSON dioramas', { path: '/scene' });
    const base = structuredClone(Scenes.specOf(opened));
    const targets = targetsOf(targetList, root);
    const w = { silhouette: weights.silhouette ?? 1, colour: weights.colour ?? 0.5, lint: weights.lint ?? 0 };
    const { rampOf } = require('../../cli/model-core.js');
    const families = new Map();
    for (const t of targets) for (const c of t.colours) if (!families.has(c)) families.set(c, rampOf(c, 5).map(rgbOf));

    params.forEach((p, i) => {
      const where = '/params/' + i;
      const list = p.paths ?? (p.path ? [p.path] : null);
      if (!list) throw new OpError('INVALID_INPUT', 'A param needs path or paths', { path: where });
      for (const pointer of list)
        if (typeof getAt(base, pointer) !== 'number') throw new OpError('INVALID_INPUT', pointer + ' is not a number in the diorama', { path: where });
      if (!(p.max > p.min)) throw new OpError('INVALID_INPUT', 'max must be above min', { path: where });
      p.list = list;
    });
    const toUnit = (p, v) => (v - p.min) / (p.max - p.min);
    const fromUnit = (p, u) => {
      let v = p.min + Math.min(1, Math.max(0, u)) * (p.max - p.min);
      if (p.step) v = Math.round(v / p.step) * p.step;
      return Math.round(v * 1e5) / 1e5;
    };
    const specFor = unit => {
      const spec = structuredClone(base);
      params.forEach((p, i) => p.list.forEach(pointer => setAt(spec, pointer, fromUnit(p, unit[i]))));
      return spec;
    };

    const env = opened.env, file = opened.file, dir = opened.dir;
    const evaluate = spec => {
      let entry;
      try {
        entry = { kind: 'diorama', file, dir, env, editor: Scenes.makeEditor(spec, env), warnings: [], worlds: new Map(), handle: 'fit' };
      } catch {
        return { score: -Infinity, images: [] };
      }
      const world = Scenes.worldAt(entry);
      const bg = (world.pal || [0])[0];
      let silhouette = 0, colour = 0, noise = 0;
      const images = targets.map(target => {
        const aspect = target.w / target.h;
        const image = SceneOps().renderImage(world, {
          view: { ...CAMERAS[target.view], ortho: true },
          size: aspect >= 1 ? { w: size, h: Math.max(24, Math.round(size / aspect)) } : { w: Math.max(24, Math.round(size * aspect)), h: size }
        });
        const m = compare(target, image, (image.palette || world.pal)[0] ?? bg, families);
        silhouette += m.silhouette / targets.length;
        colour += m.colour / targets.length;
        if (w.lint) noise += (SceneOps().measure(world, image, ['lint']).lint?.noise ?? 0) / targets.length;
        return image;
      });
      return { score: w.silhouette * silhouette + w.colour * colour - w.lint * noise, silhouette, colour, noise, images };
    };

    const started = Date.now(), rng = random(seed);
    let current = params.map(p => toUnit(p, getAt(base, p.list[0])));
    const before = evaluate(specFor(current));
    let best = { unit: current, ...before }, step = sigma, evaluations = 1;
    const history = [{ generation: 0, score: round(before.score), silhouette: round(before.silhouette), colour: round(before.colour) }];
    for (let g = 1; g <= iterations && (Date.now() - started) / 1000 < budget; g++) {
      let improved = 0;
      for (let k = 0; k < population && (Date.now() - started) / 1000 < budget; k++) {
        const unit = best.unit.map(u => Math.min(1, Math.max(0, u + step * rng.gauss())));
        const result = evaluate(specFor(unit));
        evaluations++;
        if (result.score > best.score) {
          best = { unit, ...result };
          improved++;
        }
      }
      /* one-fifth rule: widen the step while it keeps finding better candidates, narrow it when it does not */
      step = Math.max(0.002, Math.min(0.5, step * (improved / population > 0.2 ? 1.5 : 0.82)));
      history.push({ generation: g, score: round(best.score), silhouette: round(best.silhouette), colour: round(best.colour), step: round(step) });
    }

    const dirOut = path.resolve(root, out);
    fs.mkdirSync(dirOut, { recursive: true });
    const bestSpec = specFor(best.unit);
    /* mesh assets are resolved next to the scene, so a fitted copy elsewhere points back at the originals */
    if (dir && path.resolve(dir) !== dirOut)
      for (const solid of Scenes.kit().KIT.diorama.solids(bestSpec))
        if (solid.kind === 'mesh' && typeof solid.asset === 'string' && !path.isAbsolute(solid.asset)) solid.asset = path.relative(dirOut, path.resolve(dir, solid.asset));
    fs.writeFileSync(path.join(dirOut, 'scene.json'), JSON.stringify(bestSpec, null, 2) + '\n');
    sheet(targets.map((t, i) => [targetImage(t, best.images[i]?.h ?? size), before.images[i], best.images[i]]), path.join(dirOut, 'fit.png'));
    const values = params.map((p, i) => ({ paths: p.list, before: getAt(base, p.list[0]), after: fromUnit(p, best.unit[i]) }));
    const report = {
      scene: path.join(dirOut, 'scene.json'), sheet: path.join(dirOut, 'fit.png'),
      before: { score: round(before.score), silhouette: round(before.silhouette), colour: round(before.colour) },
      after: { score: round(best.score), silhouette: round(best.silhouette), colour: round(best.colour) },
      values, evaluations, seconds: round((Date.now() - started) / 1000), history
    };
    fs.writeFileSync(path.join(dirOut, 'fit.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  }
});

function round(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v;
}

module.exports = { compare, targetsOf, CAMERAS, rgbOf };
