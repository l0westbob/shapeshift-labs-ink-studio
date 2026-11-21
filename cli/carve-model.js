'use strict';
/* Pixel first: draw the sprite, then carve the solid. A model is a few orthographic views drawn as letter grids, the way the
   finished pixel art should read, and a colour per letter:

     { "cell": 0.1, "colours": { "o": { "colour": "#5b6b2e", "role": "olive" }, "t": "#2b2b2b" },
       "views": { "front": [rows], "right": [rows], "top": [rows] } }

   Views (rows run from the top of the picture down, letters from left to right, "." is empty; Y is up, +Z is the front):
     front   seen from +Z: letters run along +x, rows down y          back    seen from -Z: letters run along -x
     right   seen from +X: letters run along -z, rows down y          left    seen from -X: letters run along +z
     top     seen from +Y: letters run along +x, rows run from -z (back) to +z (front)
     bottom  seen from -Y: letters run along +x, rows run from +z to -z

   A block stays where every view sees something (the visual hull); each surface block takes the letter of the view that
   sees it, by majority where several do (ties go to top, front, right, left, back, bottom); a side without its own view is
   painted like the opposite one (no back view: the back looks like the front). Hollows no view can see are
   filled, so carve first and then edit the written voxel model (carved.vox.json) for undercuts. The result goes through
   the voxel front end, so the diorama is one vox solid baked from the carved grid. */
const fs = require('node:fs');
const path = require('node:path');

const ORDER = ['top', 'front', 'right', 'left', 'back', 'bottom'];
const rowsOf = view => (typeof view === 'string' ? view.split(/[\/\n]/) : view).map(row => row.replace(/\s+$/, ''));

/* for view v: the grid's sizes along its picture axes, and the picture position of block (x, y, z), plus the direction
   of the ray from the viewer into the model */
const VIEWS = {
  front: { size: ({ nx, ny }) => [nx, ny], at: (x, y, z, { ny }) => [x, ny - 1 - y], ray: [0, 0, -1] },
  back: { size: ({ nx, ny }) => [nx, ny], at: (x, y, z, { nx, ny }) => [nx - 1 - x, ny - 1 - y], ray: [0, 0, 1] },
  right: { size: ({ nz, ny }) => [nz, ny], at: (x, y, z, { ny, nz }) => [nz - 1 - z, ny - 1 - y], ray: [-1, 0, 0] },
  left: { size: ({ nz, ny }) => [nz, ny], at: (x, y, z, { ny }) => [z, ny - 1 - y], ray: [1, 0, 0] },
  top: { size: ({ nx, nz }) => [nx, nz], at: (x, y, z) => [x, z], ray: [0, -1, 0] },
  bottom: { size: ({ nx, nz }) => [nx, nz], at: (x, y, z, { nz }) => [x, nz - 1 - z], ray: [0, 1, 0] }
};

/* the grid size every view agrees on */
function gridSize(views) {
  const dims = { nx: [], ny: [], nz: [] };
  const width = rows => Math.max(...rows.map(row => row.length));
  for (const [name, rows] of Object.entries(views)) {
    const w = width(rows), h = rows.length;
    if (name === 'front' || name === 'back') dims.nx.push([name, w]), dims.ny.push([name, h]);
    if (name === 'right' || name === 'left') dims.nz.push([name, w]), dims.ny.push([name, h]);
    if (name === 'top' || name === 'bottom') dims.nx.push([name, w]), dims.nz.push([name, h]);
  }
  const size = {};
  for (const [axis, list] of Object.entries(dims)) {
    if (!list.length) throw new Error('No view gives the model a size along ' + axis.slice(1) + ': draw front or back, right or left, and top or bottom so every axis is seen');
    const n = Math.max(...list.map(([, v]) => v));
    const short = list.filter(([, v]) => v !== n);
    if (short.length) throw new Error('The views disagree on the size along ' + axis.slice(1) + ': ' + list.map(([v, k]) => v + ' ' + k).join(', ') + ' (pad rows with "." so they match)');
    size[axis] = n;
  }
  return size;
}

function carve(views) {
  for (const name of Object.keys(views)) if (!VIEWS[name]) throw new Error('No view called "' + name + '"; views: ' + Object.keys(VIEWS).join(', '));
  const pictures = Object.fromEntries(Object.entries(views).map(([name, view]) => [name, rowsOf(view)]));
  const size = gridSize(pictures), { nx, ny, nz } = size;
  const letter = (name, x, y, z) => {
    const [u, v] = VIEWS[name].at(x, y, z, size), ch = pictures[name][v]?.[u];
    return ch && ch !== '.' && ch !== ' ' ? ch : null;
  };
  const solid = new Uint8Array(nx * ny * nz), id = (x, y, z) => (x * ny + y) * nz + z;
  for (let x = 0; x < nx; x++)
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++) if (Object.keys(pictures).every(name => letter(name, x, y, z))) solid[id(x, y, z)] = 1;

  /* paint: march each view's rays and give the first block hit that view's letter. A side no view looks at is painted
     from the opposite view, as if seen through (the back like the front), but only where no real view painted */
  const OPPOSITE = { front: 'back', back: 'front', right: 'left', left: 'right', top: 'bottom', bottom: 'top' };
  const votes = new Map(), mirrored = new Map();
  const passes = [
    ...Object.keys(pictures).map(name => [name, VIEWS[name].ray, votes]),
    ...Object.keys(pictures).filter(name => !pictures[OPPOSITE[name]]).map(name => [name, VIEWS[name].ray.map(v => -v), mirrored, OPPOSITE[name]])
  ];
  /* a mirrored pass reads the letters of its view but votes as the side it paints, so a bottom painted from the top view
     ranks last, as bottoms do */
  for (const [name, [dx, dy, dz], into, side = name] of passes) {
    const starts = [];
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      const px = x - dx, py = y - dy, pz = z - dz;
      if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) starts.push([x, y, z]);
    }
    for (let [x, y, z] of starts) {
      const ch = letter(name, x, y, z);
      if (!ch) continue;
      while (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) {
        if (solid[id(x, y, z)]) {
          const list = into.get(id(x, y, z)) ?? [];
          list.push([side, ch]);
          into.set(id(x, y, z), list);
          break;
        }
        x += dx, y += dy, z += dz;
      }
    }
  }
  const letters = new Array(nx * ny * nz).fill('.');
  for (const [i, list] of mirrored) if (!votes.has(i)) votes.set(i, list);
  for (const [i, list] of votes) {
    const count = new Map();
    for (const [, ch] of list) count.set(ch, (count.get(ch) ?? 0) + 1);
    const best = Math.max(...count.values());
    const tied = new Set([...count].filter(([, n]) => n === best).map(([ch]) => ch));
    letters[i] = ORDER.flatMap(name => list.filter(([v, ch]) => v === name && tied.has(ch)).map(([, ch]) => ch))[0];
  }
  /* hidden blocks take the letter of the nearest painted block along any axis, so soft voxels blend sensibly */
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    const i = id(x, y, z);
    if (!solid[i] || letters[i] !== '.') continue;
    let found = null;
    for (let r = 1; !found && r < Math.max(nx, ny, nz); r++)
      for (const [a, b, c] of [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]]) {
        const X = x + a, Y = y + b, Z = z + c;
        if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && letters[id(X, Y, Z)] !== '.' && solid[id(X, Y, Z)]) {
          found = letters[id(X, Y, Z)];
          break;
        }
      }
    letters[i] = found ?? Object.values(pictures)[0].join('').replace(/[.\s]/g, '')[0];
  }
  /* voxel layers: plans from the bottom up, rows from the back (z = 0) to the front, letters along x */
  const layers = [];
  for (let y = 0; y < ny; y++) {
    const rows = [];
    for (let z = 0; z < nz; z++) {
      let row = '';
      for (let x = 0; x < nx; x++) row += letters[id(x, y, z)];
      rows.push(row);
    }
    layers.push(rows.join('/'));
  }
  return { size, layers, blocks: solid.reduce((s, v) => s + v, 0) };
}

/* the drawn views as one picture, for the record and as targets for scene_fit */
function writeViews(views, colours, file) {
  const { encode } = require('./png.js');
  const pictures = Object.entries(views).map(([name, view]) => [name, rowsOf(view)]);
  const colourOf = ch => {
    const value = colours[ch];
    const text = typeof value === 'object' && value ? value.colour ?? value.color : value;
    return typeof text === 'number' ? text : parseInt(String(text).replace('#', ''), 16);
  };
  const scale = 4, gap = 2;
  const width = pictures.reduce((s, [, rows]) => s + Math.max(...rows.map(r => r.length)) + gap, gap) * scale;
  const height = (Math.max(...pictures.map(([, rows]) => rows.length)) + 2 * gap) * scale;
  const rgb = new Uint8Array(width * height * 3).fill(16);
  let left = gap;
  for (const [, rows] of pictures) {
    rows.forEach((row, v) => [...row].forEach((ch, u) => {
      if (ch === '.' || ch === ' ' || colours[ch] === undefined) return;
      const c = colourOf(ch);
      for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) {
        const i = ((gap + v) * scale + a) * width + (left + u) * scale + b;
        rgb.set([(c >> 16) & 255, (c >> 8) & 255, c & 255], i * 3);
      }
    }));
    left += Math.max(...rows.map(r => r.length)) + gap;
  }
  fs.writeFileSync(file, encode(width, height, rgb));
}

async function buildModel(file, options) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The views file is not JSON: ' + error.message);
  }
  if (!source.views || typeof source.views !== 'object') throw new Error('A carving needs "views": { "front": [rows], "right": [rows], "top": [rows] }');
  if (!source.colours) throw new Error('A carving needs "colours": { letter: "#rrggbb", ... }');
  const { size, layers, blocks } = carve(source.views);
  const vox = { cell: source.cell ?? 0.1, hard: source.hard ?? true, colours: source.colours, layers };
  if (source.round !== undefined) vox.round = source.round;
  const report = await require('./vox-model.js').buildFromSource(vox, { ...options, prefix: 'carve' });
  fs.writeFileSync(path.join(options.out, 'carved.vox.json'), JSON.stringify(vox, null, 1) + '\n');
  writeViews(source.views, source.colours, path.join(options.out, 'views.png'));
  return { ...report, carved: path.join(options.out, 'carved.vox.json'), views: path.join(options.out, 'views.png'), grid: [size.nx, size.ny, size.nz], blocks };
}

module.exports = { buildModel, carve, VIEWS, rowsOf };
