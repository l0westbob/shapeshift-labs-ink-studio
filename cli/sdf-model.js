'use strict';
/* Signed distance functions as code (the Shadertoy style agents have seen thousands of): a .sdf.mjs script returns parts
   whose field is a function of a point, built from library/sdf.mjs. Each part is meshed with the kit's implicit surface
   mesher inside its bounds and goes through model-core.js like any other mesh front end. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PACKAGE = path.join(__dirname, '..');

const colourOf = value => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^#?[0-9a-f]{6}$/i.test(value)) return parseInt(value.replace('#', ''), 16);
  return 0xb4b4b4;
};

async function buildModel(script, { kit, cells = 96, ...options }) {
  delete require.cache[fs.realpathSync(script)];
  const mod = await import(pathToFileURL(script).href + '?v=' + fs.statSync(script).mtimeMs);
  const build = typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : null;
  if (!build) throw new Error('The script must export a function ({ sdf }) => ({ parts: [...] })');
  const { makeSdf } = await import(pathToFileURL(path.join(PACKAGE, 'library', 'sdf.mjs')).href);
  const model = await build({ sdf: makeSdf() });
  const list = Array.isArray(model) ? model : model?.parts;
  if (!Array.isArray(list) || !list.length) throw new Error('The script must return { parts: [{ name, colour, role, field, bounds }] }');
  const shared = model.bounds;
  /* one resolution for every part: `cells` steps along the longest side of everything */
  const boxes = list.map((part, i) => {
    const b = part.bounds ?? shared;
    if (!Array.isArray(b) || b.length !== 2 || !b.every(v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)))
      throw new Error('parts[' + i + '] needs bounds [[x0, y0, z0], [x1, y1, z1]] (or give the model one bounds)');
    if (typeof part.field !== 'function') throw new Error('parts[' + i + '].field must be a function of [x, y, z]');
    return { min: b[0], max: b[1] };
  });
  const extent = Math.max(...[0, 1, 2].map(k => Math.max(...boxes.map(b => b.max[k])) - Math.min(...boxes.map(b => b.min[k]))));
  const resolution = model.resolution ?? extent / cells;
  const { roleFor, buildFromParts } = require('./model-core.js');
  const parts = list.map((part, i) => {
    const label = 'parts[' + i + '] (' + (part.name || 'unnamed') + ')';
    /* a part thinner than the sampling step falls between samples; try finer before giving up */
    let mesh, step = resolution;
    for (let attempt = 0; attempt < 4; attempt++, step /= 2) {
      try {
        mesh = kit.procedural.geometry.implicitSurface(part.field, boxes[i], { resolution: step, maxCells: 2000000, edgeRefinements: 3 });
      } catch (error) {
        throw new Error(label + ': ' + error.message);
      }
      if (mesh.positions.length) break;
    }
    if (!mesh.positions.length)
      throw new Error(label + ' has no surface inside its bounds, even sampled at ' + Math.round(step * 2e4) / 1e4 + ': check the bounds, and keep them tight around thin parts');
    return { name: part.name || 'part-' + (i + 1), pos: mesh.positions, role: roleFor(part.role, colourOf(part.colour)) };
  });
  return buildFromParts(parts, { ...options, kit, cells, prefix: 'sdf', sun: model.sun });
}

module.exports = { buildModel };
