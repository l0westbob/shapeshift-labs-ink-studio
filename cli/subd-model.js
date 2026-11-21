'use strict';
/* Subdivision surfaces: a coarse cage of quads (and triangles) is smoothed by Catmull-Clark subdivision, the way film and
   game characters are modelled. Edges listed as creases stay sharp. A .subd.json (or a .subd.mjs script returning the
   same, with helpers from `cage`) lists the cages:

     { "cages": [ { "name": "body", "colour": "#5b6b2e", "role": "olive", "levels": 3,
                    "vertices": [[x, y, z], ...], "faces": [[0, 1, 2, 3], ...], "creases": [[0, 1], ...] } ] }

   Faces wind counter-clockwise seen from outside. Each cage is subdivided `levels` times (default 3) and goes through
   model-core.js as one mesh part. Y is up. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const key = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
const avg = list => [0, 1, 2].map(k => list.reduce((s, p) => s + p[k], 0) / list.length);

/* one Catmull-Clark step on a polygon mesh with optional sharp edges */
function subdivide({ vertices, faces, creases }) {
  const sharp = new Set((creases ?? []).map(([a, b]) => key(a, b)));
  const edges = new Map();
  faces.forEach((face, f) => face.forEach((a, i) => {
    const b = face[(i + 1) % face.length], k = key(a, b);
    if (!edges.has(k)) edges.set(k, { a: Math.min(a, b), b: Math.max(a, b), faces: [] });
    edges.get(k).faces.push(f);
  }));
  const facePoints = faces.map(face => avg(face.map(i => vertices[i])));
  const out = vertices.map(() => null), edgeIndex = new Map(), newVertices = [];
  /* edge points: the average of the ends and the two face points, or the midpoint on a sharp or open edge */
  for (const [k, e] of edges) {
    const mid = avg([vertices[e.a], vertices[e.b]]);
    const smooth = !sharp.has(k) && e.faces.length === 2;
    edgeIndex.set(k, newVertices.push(smooth ? avg([vertices[e.a], vertices[e.b], facePoints[e.faces[0]], facePoints[e.faces[1]]]) : mid) - 1);
  }
  /* vertex points: (F + 2R + (n - 3) P) / n inside; along two sharp or open edges, (6P + a + b) / 8; a corner stays put */
  const around = vertices.map(() => ({ faces: new Set(), edges: [] }));
  faces.forEach((face, f) => face.forEach(i => around[i].faces.add(f)));
  for (const [k, e] of edges) around[e.a].edges.push(k), around[e.b].edges.push(k);
  vertices.forEach((p, i) => {
    const { faces: fs, edges: es } = around[i];
    const hard = es.filter(k => sharp.has(k) || edges.get(k).faces.length !== 2);
    let q;
    if (hard.length >= 3) q = p;
    else if (hard.length === 2) {
      const ends = hard.map(k => (edges.get(k).a === i ? vertices[edges.get(k).b] : vertices[edges.get(k).a]));
      q = [0, 1, 2].map(c => (6 * p[c] + ends[0][c] + ends[1][c]) / 8);
    } else {
      const n = es.length, F = avg([...fs].map(f => facePoints[f])), R = avg(es.map(k => avg([vertices[edges.get(k).a], vertices[edges.get(k).b]])));
      q = [0, 1, 2].map(c => (F[c] + 2 * R[c] + (n - 3) * p[c]) / n);
    }
    out[i] = newVertices.push(q) - 1;
  });
  const faceIndex = facePoints.map(fp => newVertices.push(fp) - 1);
  const newFaces = [];
  faces.forEach((face, f) => face.forEach((v, i) => {
    const next = face[(i + 1) % face.length], prev = face[(i - 1 + face.length) % face.length];
    newFaces.push([out[v], edgeIndex.get(key(v, next)), faceIndex[f], edgeIndex.get(key(prev, v))]);
  }));
  /* a sharp edge splits into two sharp edges */
  const newCreases = [];
  for (const k of sharp) {
    const e = edges.get(k);
    if (!e) continue;
    newCreases.push([out[e.a], edgeIndex.get(k)], [edgeIndex.get(k), out[e.b]]);
  }
  return { vertices: newVertices, faces: newFaces, creases: newCreases };
}

function triangles(mesh) {
  const pos = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach((p, i) => pos.set(p, i * 3));
  const index = [];
  for (const face of mesh.faces) for (let i = 1; i < face.length - 1; i++) index.push(face[0], face[i], face[i + 1]);
  return { pos, index: Uint32Array.from(index) };
}

/* helpers for .subd.mjs scripts: cages to start from and change */
const cage = {
  /* a box cage centred at c with half sizes h: 8 vertices, 6 quads */
  box(c = [0, 0, 0], h = [0.5, 0.5, 0.5]) {
    const v = [];
    for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) v.push([c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]]);
    return { vertices: v, faces: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]] };
  },
  /* a prism of n sides around the Y axis, radius r, from y0 to y1 */
  prism(n = 8, r = 0.5, y0 = 0, y1 = 1, c = [0, 0, 0]) {
    const v = [];
    for (const y of [y0, y1]) for (let i = 0; i < n; i++) v.push([c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + y, c[2] - r * Math.sin((2 * Math.PI * i) / n)]);
    const faces = [Array.from({ length: n }, (_, i) => n - 1 - i), Array.from({ length: n }, (_, i) => n + i)];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
    return { vertices: v, faces };
  },
  /* an outline [[x, y], ...] in the XY plane, counter-clockwise, extruded from z0 to z1; rings are the two outline loops,
     ready to crease so the side faces stay flat while the outline rounds */
  outline(points, z0 = -0.5, z1 = 0.5) {
    const n = points.length, vertices = [...points.map(([x, y]) => [x, y, z0]), ...points.map(([x, y]) => [x, y, z1])];
    const faces = [Array.from({ length: n }, (_, i) => n - 1 - i), Array.from({ length: n }, (_, i) => n + i)];
    for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
    return { vertices, faces, rings: [Array.from({ length: n }, (_, i) => i), Array.from({ length: n }, (_, i) => n + i)] };
  },
  /* the edges of a closed loop of vertex numbers, as crease pairs */
  ring(loop) {
    return loop.map((v, i) => [v, loop[(i + 1) % loop.length]]);
  },
  /* pushes faces out along their normal by d, adding side quads (a loop of the cage grows a limb) */
  extrude(mesh, faceIds, d) {
    const vertices = mesh.vertices.map(p => p.slice()), faces = mesh.faces.map(f => f.slice());
    for (const id of faceIds) {
      const face = faces[id], ps = face.map(i => vertices[i]);
      const n = [0, 0, 0];
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i], b = ps[(i + 1) % ps.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const l = Math.hypot(...n) || 1;
      const top = face.map(i => vertices.push(vertices[i].map((x, k) => x + (n[k] / l) * d)) - 1);
      face.forEach((v, i) => faces.push([v, face[(i + 1) % face.length], top[(i + 1) % face.length], top[i]]));
      faces[id] = top;
    }
    return { ...mesh, vertices, faces };
  },
  /* moves and scales vertices in place: f(p, i) returns the new point */
  map(mesh, f) {
    return { ...mesh, vertices: mesh.vertices.map((p, i) => f(p.slice(), i)) };
  }
};

async function load(file) {
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  delete require.cache[fs.realpathSync(file)];
  const mod = await import(pathToFileURL(file).href + '?v=' + fs.statSync(file).mtimeMs);
  const build = typeof mod.default === 'function' ? mod.default : null;
  if (!build) throw new Error('The script must export a function ({ cage }) => ({ cages: [...] })');
  return build({ cage });
}

async function buildModel(file, options) {
  let source;
  try {
    source = await load(file);
  } catch (error) {
    throw new Error(file.endsWith('.json') ? 'The cage file is not JSON: ' + error.message : error.message);
  }
  if (!Array.isArray(source?.cages) || !source.cages.length) throw new Error('A subdivision model needs "cages": [{ vertices, faces, creases?, levels? }]');
  const { roleFor, buildFromParts } = require('./model-core.js');
  const colourOf = c => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? parseInt(c.replace('#', ''), 16) : 0xb4b4b4);
  const parts = source.cages.map((c, i) => {
    const where = 'cages[' + i + ']';
    if (!Array.isArray(c.vertices) || !Array.isArray(c.faces) || !c.faces.length) throw new Error(where + ' needs vertices and faces');
    for (const face of c.faces)
      if (!Array.isArray(face) || face.length < 3 || face.some(v => !Number.isInteger(v) || v < 0 || v >= c.vertices.length))
        throw new Error(where + ': every face lists three or more vertex numbers below ' + c.vertices.length);
    let mesh = { vertices: c.vertices, faces: c.faces, creases: c.creases };
    for (let l = 0; l < Math.min(5, c.levels ?? 3); l++) mesh = subdivide(mesh);
    return { name: c.name || 'cage-' + (i + 1), ...triangles(mesh), role: roleFor(c.role, colourOf(c.colour)) };
  });
  return buildFromParts(parts, { ...options, prefix: 'subd', sun: source.sun });
}

module.exports = { buildModel, subdivide, cage };
