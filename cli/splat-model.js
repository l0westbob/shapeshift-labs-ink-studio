'use strict';
/* Captured models: a Gaussian splat (3DGS) or coloured point cloud in PLY, from photogrammetry or a splat trainer, turned
   into pixel art. Points (splat centres, with their size) are binned into a voxel grid, the closed inside is filled,
   colours are reduced to a few families by k-means, and the result continues as a voxel model. A .splat.json sets how:

     { "ply": "capture.ply", "resolution": 64, "colours": 6, "up": "y", "opacity": 0.5, "fill": true, "close": 1, "hard": false,
       "crop": [[-1, 0, -1], [1, 2, 1]], "names": ["moss", "bark", ...] }

   resolution is the number of blocks along the longest side; colours the number of families; up the capture's up axis
   ("y", "-y" as many trainers write, "z" or "-z"); opacity drops faint splats (3DGS only); crop keeps a box (in capture
   units, before turning up); fill closes gaps of up to `close` blocks before filling the inside. A .ply on its own uses
   these defaults. */
const fs = require('node:fs');
const path = require('node:path');

const SIZES = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
const READ = {
  char: 'readInt8', int8: 'readInt8', uchar: 'readUInt8', uint8: 'readUInt8', short: 'readInt16LE', int16: 'readInt16LE', ushort: 'readUInt16LE', uint16: 'readUInt16LE',
  int: 'readInt32LE', int32: 'readInt32LE', uint: 'readUInt32LE', uint32: 'readUInt32LE', float: 'readFloatLE', float32: 'readFloatLE', double: 'readDoubleLE', float64: 'readDoubleLE'
};

/* the vertex element of a PLY file as columns of numbers */
function readPly(file) {
  const bytes = fs.readFileSync(file);
  const end = bytes.indexOf('end_header');
  if (bytes.subarray(0, 3).toString() !== 'ply' || end < 0) throw new Error(path.basename(file) + ' is not a PLY file');
  const header = bytes.subarray(0, end).toString().split(/\r?\n/);
  const format = header.find(l => l.startsWith('format'))?.split(/\s+/)[1];
  if (!['ascii', 'binary_little_endian'].includes(format)) throw new Error('PLY format ' + format + ' is not supported (ascii or binary_little_endian)');
  const elements = [];
  for (const line of header) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'element') elements.push({ name: w[1], count: +w[2], props: [] });
    else if (w[0] === 'property' && w[1] !== 'list') elements.at(-1).props.push({ type: w[1], name: w[2] });
    else if (w[0] === 'property' && w[1] === 'list' && elements.at(-1).name === 'vertex') throw new Error('Vertex list properties are not supported');
  }
  const vertex = elements.find(e => e.name === 'vertex');
  if (!vertex) throw new Error('The PLY file has no vertex element');
  const columns = Object.fromEntries(vertex.props.map(p => [p.name, new Float64Array(vertex.count)]));
  let offset = bytes.indexOf('\n', end) + 1;
  if (format === 'ascii') {
    const lines = bytes.subarray(offset).toString().split(/\r?\n/);
    let row = 0;
    for (const e of elements) {
      for (let i = 0; i < e.count; i++, row++) {
        if (e !== vertex) continue;
        const values = lines[row].trim().split(/\s+/).map(Number);
        e.props.forEach((p, k) => (columns[p.name][i] = values[k]));
      }
    }
  } else {
    for (const e of elements) {
      if (e !== vertex) throw new Error('Binary PLY files must start with the vertex element');
      const stride = e.props.reduce((s, p) => s + SIZES[p.type], 0);
      for (let i = 0; i < e.count; i++) {
        let at = offset + i * stride;
        for (const p of e.props) {
          columns[p.name][i] = bytes[READ[p.type]](at);
          at += SIZES[p.type];
        }
      }
      break;
    }
  }
  return { count: vertex.count, columns };
}

/* points with colours (sRGB 0..255) and a radius, from a 3DGS or a plain coloured point cloud */
function pointsOf({ count, columns }, { opacity = 0.5 }) {
  const { x, y, z } = columns;
  if (!x || !y || !z) throw new Error('The PLY vertices need x, y and z');
  const C0 = 0.28209479177387814;
  const splat = Boolean(columns.f_dc_0);
  const out = [];
  for (let i = 0; i < count; i++) {
    let r, g, b, radius = 0;
    if (splat) {
      if (columns.opacity && 1 / (1 + Math.exp(-columns.opacity[i])) < opacity) continue;
      [r, g, b] = [0, 1, 2].map(k => Math.round(255 * Math.min(1, Math.max(0, 0.5 + C0 * columns['f_dc_' + k][i]))));
      if (columns.scale_0) radius = Math.exp(Math.max(columns.scale_0[i], columns.scale_1[i], columns.scale_2[i]));
    } else if (columns.red) [r, g, b] = [columns.red[i], columns.green[i], columns.blue[i]];
    else [r, g, b] = [180, 180, 180];
    out.push({ p: [x[i], y[i], z[i]], c: [r, g, b], radius });
  }
  return out;
}

const UP = { y: ([x, y, z]) => [x, y, z], '-y': ([x, y, z]) => [x, -y, -z], z: ([x, y, z]) => [x, z, -y], '-z': ([x, y, z]) => [x, -z, y] };

/* k-means on colours, seeded from the most common colour and then the farthest ones, so it is repeatable */
function kmeans(colours, k) {
  const counts = new Map();
  for (const c of colours) {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique = [...counts].map(([key, n]) => ({ c: [(key >> 16) & 255, (key >> 8) & 255, key & 255], n }));
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const centres = [unique.reduce((a, b) => (b.n > a.n ? b : a)).c.slice()];
  while (centres.length < Math.min(k, unique.length))
    centres.push(unique.reduce((best, u) => (Math.min(...centres.map(c => d2(c, u.c))) > Math.min(...centres.map(c => d2(c, best.c))) ? u : best)).c.slice());
  for (let iteration = 0; iteration < 12; iteration++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (const u of unique) {
      const j = centres.reduce((best, c, i) => (d2(c, u.c) < d2(centres[best], u.c) ? i : best), 0);
      for (let t = 0; t < 3; t++) sums[j][t] += u.c[t] * u.n;
      sums[j][3] += u.n;
    }
    sums.forEach((s, j) => s[3] && (centres[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
  }
  const nearest = c => centres.reduce((best, m, i) => (d2(m, c) < d2(centres[best], c) ? i : best), 0);
  return { centres: centres.map(c => c.map(Math.round)), nearest };
}

async function buildModel(file, options) {
  const config = file.endsWith('.ply') ? { ply: path.basename(file) } : JSON.parse(fs.readFileSync(file, 'utf8'));
  const ply = path.resolve(path.dirname(file), config.ply ?? '');
  if (!config.ply || !fs.existsSync(ply)) throw new Error('No PLY file at ' + ply);
  let points = pointsOf(readPly(ply), config);
  if (config.crop) {
    const [lo, hi] = config.crop;
    points = points.filter(({ p }) => p.every((v, k) => v >= lo[k] && v <= hi[k]));
  }
  const turn = UP[config.up ?? 'y'];
  if (!turn) throw new Error('up is y, -y, z or -z');
  points = points.map(pt => ({ ...pt, p: turn(pt.p) }));
  if (points.length < 4) throw new Error('Fewer than four points are left (check opacity and crop)');

  const lo = [0, 1, 2].map(k => Math.min(...points.map(pt => pt.p[k]))), hi = [0, 1, 2].map(k => Math.max(...points.map(pt => pt.p[k])));
  const extent = Math.max(...hi.map((v, k) => v - lo[k])), resolution = config.resolution ?? 64, cell = extent / resolution;
  const n = hi.map((v, k) => Math.max(1, Math.ceil((v - lo[k]) / cell) + 1));
  const id = (x, y, z) => (x * n[1] + y) * n[2] + z;
  const sums = new Map();
  /* each point, and each splat out to its radius (capped at two blocks), votes its colour into the blocks it covers */
  for (const { p, c, radius } of points) {
    const cx = Math.floor((p[0] - lo[0]) / cell), cy = Math.floor((p[1] - lo[1]) / cell), cz = Math.floor((p[2] - lo[2]) / cell);
    const reach = Math.min(2, Math.floor(radius / cell));
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) for (let d = -reach; d <= reach; d++) {
      const x = cx + a, y = cy + b, z = cz + d;
      if (x < 0 || y < 0 || z < 0 || x >= n[0] || y >= n[1] || z >= n[2] || a * a + b * b + d * d > reach * reach) continue;
      const s = sums.get(id(x, y, z)) ?? [0, 0, 0, 0];
      s[0] += c[0], s[1] += c[1], s[2] += c[2], s[3]++;
      sums.set(id(x, y, z), s);
    }
  }
  const colourAt = new Map([...sums].map(([i, s]) => [i, [s[0] / s[3], s[1] / s[3], s[2] / s[3]]]));
  /* fill: blocks the outside cannot reach through empty blocks are inside, and take the nearest surface colour */
  if (config.fill !== false) {
    /* gaps in a sparse shell would let the outside leak in, so the flood stops at the shell grown by `close` blocks, then
       the outside grows back by as much through empty blocks, which keeps the size */
    const total = n[0] * n[1] * n[2], close = config.close ?? 1;
    const coords = i => [Math.floor(i / (n[1] * n[2])), Math.floor(i / n[2]) % n[1], i % n[2]];
    const inBox = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < n[0] && y < n[1] && z < n[2];
    const barrier = new Uint8Array(total);
    for (const i of colourAt.keys()) {
      const [x, y, z] = coords(i);
      for (let a = -close; a <= close; a++) for (let b = -close; b <= close; b++) for (let d = -close; d <= close; d++)
        if (inBox(x + a, y + b, z + d)) barrier[id(x + a, y + b, z + d)] = 1;
    }
    const outside = new Uint8Array(total), queue = [];
    for (let x = 0; x < n[0]; x++) for (let y = 0; y < n[1]; y++) for (let z = 0; z < n[2]; z++)
      if ((x === 0 || y === 0 || z === 0 || x === n[0] - 1 || y === n[1] - 1 || z === n[2] - 1) && !barrier[id(x, y, z)]) (outside[id(x, y, z)] = 1), queue.push([x, y, z]);
    const STEPS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (queue.length) {
      const [x, y, z] = queue.pop();
      for (const [a, b, d] of STEPS) {
        const X = x + a, Y = y + b, Z = z + d;
        if (!inBox(X, Y, Z)) continue;
        const i = id(X, Y, Z);
        if (outside[i] || barrier[i]) continue;
        outside[i] = 1;
        queue.push([X, Y, Z]);
      }
    }
    for (let step = 0; step < close; step++) {
      const grow = [];
      for (let i = 0; i < total; i++) {
        if (outside[i] || colourAt.has(i)) continue;
        const [x, y, z] = coords(i);
        if (STEPS.some(([a, b, d]) => inBox(x + a, y + b, z + d) && outside[id(x + a, y + b, z + d)])) grow.push(i);
      }
      for (const i of grow) outside[i] = 1;
    }
    const surface = [...colourAt.keys()];
    for (let x = 0; x < n[0]; x++) for (let y = 0; y < n[1]; y++) for (let z = 0; z < n[2]; z++) {
      const i = id(x, y, z);
      if (outside[i] || colourAt.has(i)) continue;
      /* the colour of the block above, which is what a viewer would see over a filled hollow */
      let fill = null;
      for (let Y = y + 1; Y < n[1] && !fill; Y++) fill = colourAt.get(id(x, Y, z)) ?? null;
      colourAt.set(i, fill ?? colourAt.get(surface[0]));
    }
  }
  const { centres, nearest } = kmeans([...colourAt.values()].map(c => c.map(Math.round)), config.colours ?? 6);
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  const colours = Object.fromEntries(centres.map((c, j) => {
    const hex = '#' + ((c[0] << 16) | (c[1] << 8) | c[2]).toString(16).padStart(6, '0');
    return [LETTERS[j], config.names?.[j] ? { colour: hex, role: config.names[j] } : hex];
  }));
  const layers = [];
  for (let y = 0; y < n[1]; y++) {
    const rows = [];
    for (let z = 0; z < n[2]; z++) {
      let row = '';
      for (let x = 0; x < n[0]; x++) {
        const c = colourAt.get(id(x, y, z));
        row += c ? LETTERS[nearest(c.map(Math.round))] : '.';
      }
      rows.push(row);
    }
    layers.push(rows.join('/'));
  }
  const vox = { cell, hard: config.hard ?? false, colours, layers };
  const report = await require('./vox-model.js').buildFromSource(vox, { ...options, prefix: 'splat' });
  return { ...report, points: points.length };
}

module.exports = { buildModel, readPly, kmeans };
