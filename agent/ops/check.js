'use strict';
/* model_check: a spec sheet as a test. Agents get proportions wrong more than anything else, so the sizes and ratios a
   model must have are written down before building and checked after: the whole model's extent (from the baked splats,
   so any diorama works) and, where model.json lists parts (every model_build engine writes it), each part's size and
   ratios between them. Each check says what it measured, what was wanted and by how much to scale to get there. */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const Scenes = require('../scenes.js');

const AXES = { x: 0, y: 1, z: 2 };
const round = v => Math.round(v * 1000) / 1000;
const range = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const axes = { type: 'object', properties: { x: range, y: range, z: range }, additionalProperties: false };

/* "wheel*" matches wheel-left-1 and wheels; the union of every match's bounds */
function partBounds(parts, pattern) {
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  const hits = parts.filter(p => re.test(p.name ?? ''));
  if (!hits.length) return null;
  const lo = [0, 1, 2].map(k => Math.min(...hits.map(p => p.lo[k]))), hi = [0, 1, 2].map(k => Math.max(...hits.map(p => p.hi[k])));
  return { lo, hi, count: hits.length };
}

defineOp({
  name: 'model_check',
  readOnly: true,
  title: 'Check a model against a spec sheet',
  effects: 'expensive',
  description: 'Check a model against a spec sheet written before building: size { x, y, z: [min, max] } for the whole model (measured from the baked splats, so any diorama works), parts { "turret": { x: [min, max] }, "wheel*": { ... } } for parts listed in model.json (every model_build engine writes it; * matches several parts, measured as their union) and ratios [{ a: "turret.x", b: "hull.x", range: [0.35, 0.45] }] (a name is a part, or "size" for the whole model). Units are scene units: build with size equal to the real longest side, or without size to keep the source units. Returns every check with its value, the wanted range, pass, and the scale that would fix it.',
  input: {
    type: 'object', required: ['spec'],
    properties: {
      scene: Scenes.sceneSchema,
      dir: { type: 'string', description: 'A model_build output directory (scene.json and model.json), instead of scene.' },
      spec: {
        type: 'object', additionalProperties: false,
        properties: {
          size: axes,
          parts: { type: 'object', additionalProperties: axes },
          ratios: {
            type: 'array',
            items: { type: 'object', required: ['a', 'b', 'range'], properties: { a: { type: 'string' }, b: { type: 'string' }, range }, additionalProperties: false }
          }
        }
      }
    },
    additionalProperties: false
  },
  async run({ scene, dir, spec }, ctx) {
    const root = ctx.root ?? process.cwd();
    if (!scene && !dir) throw new OpError('INVALID_INPUT', 'Give scene or dir', { path: '/scene' });
    let sceneArg = scene, modelFile;
    if (dir) {
      const folder = path.resolve(root, dir);
      sceneArg = { path: path.join(folder, 'scene.json') };
      modelFile = path.join(folder, 'model.json');
    } else if (scene.path) modelFile = path.join(path.dirname(path.resolve(root, scene.path)), 'model.json');
    const entry = Scenes.open(sceneArg, { ...ctx, persist: false });
    const world = Scenes.worldAt(entry);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0, q = 0; i < world.count; i++, q += 16)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], world.data[q + k]);
        hi[k] = Math.max(hi[k], world.data[q + k]);
      }
    const whole = { lo, hi };
    const parts = modelFile && fs.existsSync(modelFile) ? JSON.parse(fs.readFileSync(modelFile, 'utf8')).parts : [];

    const checks = [];
    const measure = (name, axis) => {
      const bounds = name === 'size' ? whole : partBounds(parts, name);
      if (!bounds) return null;
      return bounds.hi[AXES[axis]] - bounds.lo[AXES[axis]];
    };
    const check = (what, value, [min, max]) => {
      if (value === null) return checks.push({ what, pass: false, problem: parts.length ? 'no part matches' : 'no model.json with parts next to the scene' });
      const pass = value >= min && value <= max;
      const target = Math.min(max, Math.max(min, value));
      checks.push({ what, value: round(value), want: [min, max], pass, ...(pass ? {} : { scale: round(target / value) }) });
    };
    for (const [axis, want] of Object.entries(spec.size ?? {})) check('size.' + axis, measure('size', axis), want);
    for (const [name, sizes] of Object.entries(spec.parts ?? {}))
      for (const [axis, want] of Object.entries(sizes)) check(name + '.' + axis, measure(name, axis), want);
    for (const [i, ratio] of (spec.ratios ?? []).entries()) {
      const [an, aa] = ratio.a.split('.'), [bn, ba] = ratio.b.split('.');
      if (!AXES[aa] && AXES[aa] !== 0 || !AXES[ba] && AXES[ba] !== 0)
        throw new OpError('INVALID_INPUT', 'A ratio names part.axis, as in "turret.x"', { path: '/spec/ratios/' + i });
      const a = measure(an, aa), b = measure(bn, ba);
      check(ratio.a + ' / ' + ratio.b, a === null || b === null || !b ? null : a / b, ratio.range);
    }
    const failed = checks.filter(c => !c.pass);
    return {
      pass: !failed.length, passed: checks.length - failed.length, failed: failed.length, checks,
      size: [0, 1, 2].map(k => round(hi[k] - lo[k])), parts: parts.length
    };
  }
});
