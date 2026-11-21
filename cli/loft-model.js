'use strict';
/* Lofted B-spline surfaces: smooth, taut skins through cross-sections, the way boat hulls, car bodies and fuselages are
   drawn. A .loft.json (or a .loft.mjs script returning the same) lists surfaces:

     { "parts": [
         { "name": "hull", "colour": "#5b6b2e", "role": "olive", "axis": "x",
           "sections": [ { "at": -2.5, "rect": [1.6, 0.6], "round": 0.1, "centre": [0.8, 0] },
                         { "at": 0, "ellipse": [0.8, 1.0] },
                         { "at": 2.5, "points": [[y, z], ...] } ] },
         { "name": "barrel", "revolve": [[r, t], ...], "axis": "x", "at": [x, y, z] } ] }

   A section is a closed ring of control points across the axis: given as points, an ellipse [half height, half width],
   or a rect [height, width] with optional round corners, each with an optional centre [up, across]. The surface is a
   uniform cubic B-spline: periodic around each ring, clamped along the sections (so it passes through the first and last),
   and its ends are capped flat, so it is closed. A revolve turns a profile of [radius, position] points around the axis.
   Axis "x" runs along X with up = Y and across = Z; "y" runs along Y with across X, Z; "z" along Z. */
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/* uniform cubic B-spline basis */
const basis = t => [(1 - t) ** 3 / 6, (3 * t ** 3 - 6 * t ** 2 + 4) / 6, (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6, t ** 3 / 6];

/* n points around a closed (periodic) control polygon */
function periodic(ctrl, n) {
  const out = [], m = ctrl.length;
  for (let i = 0; i < n; i++) {
    const u = (i / n) * m, s = Math.floor(u), b = basis(u - s);
    out.push(ctrl[0].map((_, k) => b.reduce((sum, w, j) => sum + w * ctrl[(s - 1 + j + m) % m][k], 0)));
  }
  return out;
}

/* n points along an open control polygon, clamped so the curve starts and ends at the end points */
function clamped(ctrl, n) {
  const padded = [ctrl[0], ctrl[0], ...ctrl, ctrl.at(-1), ctrl.at(-1)];
  const spans = padded.length - 3, out = [];
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * spans, s = Math.min(spans - 1, Math.floor(u)), b = basis(u - s);
    out.push(ctrl[0].map((_, k) => b.reduce((sum, w, j) => sum + w * padded[s + j][k], 0)));
  }
  return out;
}

function ringOf(section, i, where) {
  const [cu, cv] = section.centre ?? [0, 0];
  let pts;
  if (section.points) pts = section.points;
  else if (section.ellipse) {
    const [a, b] = section.ellipse, n = section.n ?? 8;
    pts = Array.from({ length: n }, (_, k) => [a * Math.sin((2 * Math.PI * k) / n), b * Math.cos((2 * Math.PI * k) / n)]);
  } else if (section.rect) {
    const [h, w] = section.rect, r = Math.min(section.round ?? 0, h / 2, w / 2), hu = h / 2, hv = w / 2;
    /* corners pulled in by the rounding, two control points per corner so a B-spline keeps the sides straight */
    pts = [[hu, hv - r], [hu - r, hv], [-hu + r, hv], [-hu, hv - r], [-hu, -hv + r], [-hu + r, -hv], [hu - r, -hv], [hu, -hv + r]];
    if (!r) pts = [[hu, hv], [hu, hv], [-hu, hv], [-hu, hv], [-hu, -hv], [-hu, -hv], [hu, -hv], [hu, -hv]];
  } else throw new Error(where + '.sections[' + i + '] needs points, ellipse or rect');
  if (pts.length < 3) throw new Error(where + '.sections[' + i + '] needs three or more points');
  return pts.map(([u, v]) => [u + cu, v + cv]);
}

/* (along, up, across) to x, y, z for an axis */
const place = (axis, offset = [0, 0, 0]) => ([a, u, v]) =>
  (axis === 'y' ? [v, a, u] : axis === 'z' ? [v, u, a] : [a, u, v]).map((x, k) => x + offset[k]);

function grid(rows, toXYZ) {
  /* rows: rings of equal length along the surface; side quads plus a flat cap fanned from each end ring's centre */
  const pos = [], index = [], n = rows[0].length;
  rows.forEach(ring => ring.forEach(p => pos.push(...toXYZ(p))));
  for (let r = 0; r < rows.length - 1; r++)
    for (let i = 0; i < n; i++) {
      const a = r * n + i, b = r * n + ((i + 1) % n), c = (r + 1) * n + ((i + 1) % n), d = (r + 1) * n + i;
      index.push(a, b, c, a, c, d);
    }
  for (const [r, flip] of [[0, true], [rows.length - 1, false]]) {
    const centre = [0, 1, 2].map(k => rows[r].reduce((s, p) => s + p[k], 0) / n);
    const at = pos.push(...toXYZ(centre)) / 3 - 1;
    for (let i = 0; i < n; i++) {
      const a = r * n + i, b = r * n + ((i + 1) % n);
      index.push(...(flip ? [at, b, a] : [at, a, b]));
    }
  }
  return { pos: Float32Array.from(pos), index: Uint32Array.from(index) };
}

function surface(part, where) {
  const toXYZ = place(part.axis ?? 'x', part.at);
  const around = part.around ?? 48, along = part.along ?? 64;
  if (part.revolve) {
    const profile = part.revolve;
    if (!Array.isArray(profile) || profile.length < 2) throw new Error(where + '.revolve needs two or more [radius, position] points');
    const path = profile.length > 2 ? clamped(profile.map(([r, t]) => [t, r]), along) : profile.map(([r, t]) => [t, r]);
    const rows = path.map(([t, r]) => Array.from({ length: around }, (_, i) => [t, r * Math.sin((2 * Math.PI * i) / around), r * Math.cos((2 * Math.PI * i) / around)]));
    return grid(rows, toXYZ);
  }
  if (!Array.isArray(part.sections) || part.sections.length < 2) throw new Error(where + ' needs two or more sections (or revolve)');
  const rings = part.sections.map((s, i) => ringOf(s, i, where));
  const size = Math.max(...rings.map(r => r.length));
  /* every ring sampled to the same count around, then the samples run along the sections as B-spline curves */
  const sampled = rings.map((ring, i) => periodic(ring, around).map(([u, v]) => [part.sections[i].at, u, v]));
  if (size < 3) throw new Error(where + ': rings need three or more points');
  const columns = Array.from({ length: around }, (_, k) => clamped(sampled.map(r => r[k]), along));
  const rows = Array.from({ length: along }, (_, j) => columns.map(col => col[j]));
  return grid(rows, toXYZ);
}

const helpers = { periodic, clamped };

async function load(file) {
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  delete require.cache[fs.realpathSync(file)];
  const mod = await import(pathToFileURL(file).href + '?v=' + fs.statSync(file).mtimeMs);
  if (typeof mod.default !== 'function') throw new Error('The script must export a function () => ({ parts: [...] })');
  return mod.default({ spline: helpers });
}

async function buildModel(file, options) {
  let source;
  try {
    source = await load(file);
  } catch (error) {
    throw new Error(file.endsWith('.json') ? 'The loft file is not JSON: ' + error.message : error.message);
  }
  if (!Array.isArray(source?.parts) || !source.parts.length) throw new Error('A loft model needs "parts": [{ sections | revolve, ... }]');
  const { roleFor, buildFromParts } = require('./model-core.js');
  const colourOf = c => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? parseInt(c.replace('#', ''), 16) : 0xb4b4b4);
  const parts = source.parts.map((part, i) => ({ name: part.name || 'surface-' + (i + 1), ...surface(part, 'parts[' + i + ']'), role: roleFor(part.role, colourOf(part.colour)) }));
  return buildFromParts(parts, { ...options, prefix: 'loft', sun: source.sun });
}

module.exports = { buildModel, periodic, clamped };
