'use strict';
/* Front ends that think in grids (depth maps, height maps, tile maps) describe each block by a colour, and this turns
   them into a voxel model: colours either keep their own letter (exact palettes) or are reduced to a few families by
   k-means, roles are named, and the layers are written the way the voxel front end reads them. */

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const hex = c => '#' + ((c[0] << 16) | (c[1] << 8) | c[2]).toString(16).padStart(6, '0');
const parse = text => {
  const v = typeof text === 'number' ? text : parseInt(String(text).replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/* grid: { nx, ny, nz, at(x, y, z) -> [r, g, b] | { colour, role } | null } with y up and z towards the front.
   colours: a number reduces to that many families; 'exact' keeps every colour (up to 62). names: role names in order,
   or roleOf(rgb) for exact colours. */
function voxSource(grid, { cell = 0.1, hard = true, colours = 'exact', names, roleOf } = {}) {
  const { nx, ny, nz } = grid;
  const cells = new Array(nx * ny * nz), id = (x, y, z) => (x * ny + y) * nz + z;
  const roles = new Map();
  for (let x = 0; x < nx; x++)
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++) {
        const v = grid.at(x, y, z);
        if (!v) continue;
        const rgb = Array.isArray(v) ? v : parse(v.colour);
        if (!Array.isArray(v) && v.role) roles.set(hex(rgb), v.role);
        cells[id(x, y, z)] = rgb;
      }
  const used = cells.filter(Boolean);
  if (!used.length) throw new Error('The grid is empty');
  let letterOf, table;
  if (colours === 'exact') {
    const unique = [...new Set(used.map(hex))];
    if (unique.length > LETTERS.length) throw new Error(unique.length + ' colours; at most ' + LETTERS.length + ' stay exact (or reduce them with "colours": n)');
    const index = new Map(unique.map((h, i) => [h, i]));
    letterOf = rgb => LETTERS[index.get(hex(rgb))];
    table = unique.map((h, i) => [LETTERS[i], h, roles.get(h) ?? roleOf?.(h) ?? null]);
  } else {
    const { centres, nearest } = require('./splat-model.js').kmeans(used, colours);
    letterOf = rgb => LETTERS[nearest(rgb)];
    table = centres.map((c, i) => [LETTERS[i], hex(c), names?.[i] ?? null]);
  }
  const layers = [];
  for (let y = 0; y < ny; y++) {
    const rows = [];
    for (let z = 0; z < nz; z++) {
      let row = '';
      for (let x = 0; x < nx; x++) row += cells[id(x, y, z)] ? letterOf(cells[id(x, y, z)]) : '.';
      rows.push(row);
    }
    layers.push(rows.join('/'));
  }
  return {
    cell, hard, layers,
    colours: Object.fromEntries(table.map(([letter, colour, role]) => [letter, role ? { colour, role } : colour]))
  };
}

/* pixels of a PNG as [r, g, b] and alpha 0..1 */
function image(file) {
  const { raster } = require('./png.js');
  const { w, h, data, max } = raster(file);
  return {
    w, h,
    rgb: (x, y) => { const i = (y * w + x) * 4; return [0, 1, 2].map(k => Math.round((data[i + k] * 255) / max)); },
    alpha: (x, y) => data[(y * w + x) * 4 + 3] / max,
    grey: (x, y) => { const i = (y * w + x) * 4; return (data[i] + data[i + 1] + data[i + 2]) / (3 * max); }
  };
}

/* repeatable value noise in [0, 1] and its fractal sum, for generated height maps */
function noise2(seed) {
  const hash = (x, y) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const value = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return (x, y, octaves = 4) => {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < octaves; i++) (sum += amp * value(x * f, y * f)), (norm += amp), (amp *= 0.5), (f *= 2);
    return sum / norm;
  };
}

/* camera settings over the generated ones (a level reads best from above), written back to scene.json */
function withCamera(report, camera) {
  if (!Object.keys(camera).length) return report;
  report.spec.camera = { ...report.spec.camera, ...camera };
  require('node:fs').writeFileSync(report.scene, JSON.stringify(report.spec, null, 2) + '\n');
  return report;
}

module.exports = { voxSource, withCamera, image, noise2, parse, hex };
