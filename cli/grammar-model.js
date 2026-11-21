'use strict';
/* Procedural grammars: rules instead of pieces. A .grammar.json is one of two kinds.

   L-system (plants, corals, branching things), drawn by a 3D turtle and painted with splat strokes:

     { "kind": "lsystem", "axiom": "A", "iterations": 5, "angle": 25, "step": 0.5, "width": 0.18, "seed": 3,
       "rules": { "A": "F[&+A L][&-A L][^A L]", "F": [["FF", 0.7], ["F", 0.3]] },
       "colours": { "wood": "#5a3a20", "leaf": "#4f7a2a" }, "leaf": { "colour": "leaf", "size": 0.25 },
       "shrink": { "step": 0.9, "width": 0.72 } }

     F draw forward, f move forward, + - turn (yaw), & ^ pitch, \ / roll, | turn around, [ ] push and pop, L leaf.
     A rule is a string, or a list of [string, weight] chosen by the seed. Each branch level shrinks by `shrink`.

   Split grammar (buildings, shelves, fences), in the style of CGA shape grammars: boxes are split into boxes by rules
   until terminals emit geometry:

     { "kind": "split", "axiom": "Lot", "size": [8, 9, 6],
       "colours": { "wall": "#c8b88a", "roof": { "colour": "#8a3324", "role": "roof" }, "glass": "#3a5a6a" },
       "rules": {
         "Lot":    { "split": "y", "sizes": [3, 3, "~"], "into": ["Ground", "Floor", "Roof"] },
         "Floor":  { "repeat": "x", "size": 2, "into": "Bay" },
         "Bay":    [ { "box": "wall" }, { "inset": [0.4, 0.5, 0], "face": "front", "depth": 0.1, "into": "Window" } ],
         "Window": { "box": "glass" },
         "Roof":   { "roof": "gable", "colour": "roof", "overhang": 0.3 } } }

     A rule is one operation or a list of them, all applied to the same box:
       split   along x, y or z into parts of `sizes` (numbers are absolute, "~" or "2~" share what is left), named `into`
       repeat  along an axis: as many parts of about `size` as fit, each named `into`
       inset   shrink by [x, y, z] on each side (front/back faces: `face` and `depth` make a thin slab on that face)
       box     a terminal box in a colour; roof: "gable" or "hip" over the box, with `overhang`
     The axiom box sits on y = 0, centred on x and z. Every terminal becomes a mesh part. */
const fs = require('node:fs');

function random(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/* --- L-systems ------------------------------------------------------------------------------------------------------- */

function expand({ axiom, rules = {}, iterations = 4, seed = 1 }) {
  const next = random(seed);
  let text = axiom;
  for (let i = 0; i < iterations; i++) {
    let out = '';
    for (const ch of text) {
      const rule = rules[ch];
      if (rule === undefined) out += ch;
      else if (typeof rule === 'string') out += rule;
      else {
        const total = rule.reduce((s, [, w]) => s + w, 0);
        let pick = next() * total;
        out += (rule.find(([, w]) => (pick -= w) <= 0) ?? rule.at(-1))[0];
      }
      if (out.length > 200000) throw new Error('The L-system grows past 200000 symbols; lower iterations');
    }
    text = out;
  }
  return text;
}

/* a 3D turtle: heading H, left L, up U, rotated by the symbols; returns branches (polylines with widths) and leaves */
function turtle(text, { angle = 25, step = 0.5, width = 0.15, shrink = {} }) {
  const a = (angle * Math.PI) / 180;
  const rotate = (v, axis, t) => {
    const c = Math.cos(t), s = Math.sin(t), d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    const cross = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
    return [0, 1, 2].map(k => v[k] * c + cross[k] * s + axis[k] * d * (1 - c));
  };
  let st = { p: [0, 0, 0], H: [0, 1, 0], L: [-1, 0, 0], U: [0, 0, 1], step, width, line: null };
  const stack = [], branches = [], leaves = [];
  const begin = () => {
    st.line = { points: [st.p.slice()], widths: [st.width] };
    branches.push(st.line);
  };
  for (const ch of text) {
    if (ch === 'F') {
      if (!st.line) begin();
      st.p = st.p.map((v, k) => v + st.H[k] * st.step);
      st.line.points.push(st.p.slice());
      st.line.widths.push(st.width);
    } else if (ch === 'f') {
      st.p = st.p.map((v, k) => v + st.H[k] * st.step);
      st.line = null;
    } else if (ch === '+' || ch === '-') {
      const t = ch === '+' ? a : -a;
      st.H = rotate(st.H, st.U, t);
      st.L = rotate(st.L, st.U, t);
    } else if (ch === '&' || ch === '^') {
      const t = ch === '&' ? a : -a;
      st.H = rotate(st.H, st.L, t);
      st.U = rotate(st.U, st.L, t);
    } else if (ch === '\\' || ch === '/') {
      const t = ch === '\\' ? a : -a;
      st.L = rotate(st.L, st.H, t);
      st.U = rotate(st.U, st.H, t);
    } else if (ch === '|') {
      st.H = st.H.map(v => -v);
      st.L = st.L.map(v => -v);
    } else if (ch === '[') {
      stack.push({ ...st, p: st.p.slice(), H: st.H.slice(), L: st.L.slice(), U: st.U.slice() });
      st = { ...st, step: st.step * (shrink.step ?? 0.9), width: st.width * (shrink.width ?? 0.7), line: null };
    } else if (ch === ']') {
      if (!stack.length) throw new Error('The L-system pops more than it pushes');
      /* back where the branch left off, the parent's polyline carries on, so a trunk stays one smooth stroke */
      st = stack.pop();
    } else if (ch === 'L') leaves.push({ at: st.p.slice(), width: st.width });
  }
  return { branches: branches.filter(b => b.points.length > 1), leaves };
}

function lsystemPaint(source) {
  const { branches, leaves } = turtle(expand(source), source);
  const wood = source.wood ?? Object.keys(source.colours)[0];
  const leaf = source.leaf ?? {};
  const strokes = branches.map(b => {
    const top = Math.max(...b.widths);
    return {
      colour: wood, points: b.points.map(p => p.map(v => Math.round(v * 1e4) / 1e4)), width: Math.round(top * 1e4) / 1e4,
      pressure: b.widths.map(w => Math.round(Math.min(1, w / top) * 1000) / 1000), taper: [1, 0.7]
    };
  });
  for (const l of leaves) strokes.push({ colour: leaf.colour ?? Object.keys(source.colours).at(-1), dab: l.at, r: leaf.size ?? 0.2 });
  return { colours: source.colours, blend: source.blend ?? 0.04, strokes };
}

/* --- split grammars ---------------------------------------------------------------------------------------------------- */

const AXIS = { x: 0, y: 1, z: 2 };

function sizesFor(spec, total) {
  const fixed = spec.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  const shares = spec.map(v => (typeof v === 'string' ? parseFloat(v) || 1 : 0)), shareSum = shares.reduce((s, v) => s + v, 0);
  const rest = Math.max(0, total - fixed);
  return spec.map((v, i) => (typeof v === 'number' ? v : (rest * shares[i]) / (shareSum || 1)));
}

/* boxes: { lo: [x, y, z], hi: [x, y, z] }; returns terminals { kind, colour, lo, hi, ... } */
function derive(source) {
  const terminals = [], [sx, sy, sz] = source.size ?? [4, 4, 4];
  const walk = (name, box, depth) => {
    if (depth > 40) throw new Error('The split grammar nests deeper than 40 rules; is a rule calling itself?');
    const rule = source.rules[name];
    if (rule === undefined) throw new Error('No rule called "' + name + '"');
    for (const op of Array.isArray(rule) ? rule : [rule]) {
      const size = [0, 1, 2].map(k => box.hi[k] - box.lo[k]);
      if (op.split) {
        const k = AXIS[op.split], parts = sizesFor(op.sizes, size[k]);
        let at = box.lo[k];
        parts.forEach((len, i) => {
          const lo = box.lo.slice(), hi = box.hi.slice();
          lo[k] = at;
          hi[k] = at += len;
          const into = Array.isArray(op.into) ? op.into[i] : op.into;
          if (into && len > 1e-6) walk(into, { lo, hi }, depth + 1);
        });
      } else if (op.repeat) {
        if (!(op.size > 0)) throw new Error('Rule "' + name + '": repeat needs a size above 0');
        const k = AXIS[op.repeat], n = Math.max(1, Math.round(size[k] / op.size)), len = size[k] / n;
        if (n > 10000) throw new Error('Rule "' + name + '": repeat would make ' + n + ' parts; give a larger size');
        for (let i = 0; i < n; i++) {
          const lo = box.lo.slice(), hi = box.hi.slice();
          lo[k] = box.lo[k] + i * len;
          hi[k] = lo[k] + len;
          walk(op.into, { lo, hi }, depth + 1);
        }
      } else if (op.inset) {
        const d = op.inset, lo = box.lo.map((v, k) => v + d[k]), hi = box.hi.map((v, k) => v - d[k]);
        if (op.face) {
          /* a thin slab standing proud of the named face */
          const t = op.depth ?? 0.08, k = op.face === 'front' || op.face === 'back' ? 2 : op.face === 'left' || op.face === 'right' ? 0 : 1;
          const outer = op.face === 'front' || op.face === 'right' || op.face === 'top';
          lo[k] = outer ? box.hi[k] - t / 2 : box.lo[k] - t / 2;
          hi[k] = outer ? box.hi[k] + t / 2 : box.lo[k] + t / 2;
        }
        if (hi.every((v, k) => v > lo[k])) walk(op.into, { lo, hi }, depth + 1);
      } else if (op.box) terminals.push({ kind: 'box', colour: op.box, lo: box.lo, hi: box.hi, name });
      else if (op.roof) terminals.push({ kind: op.roof, colour: op.colour, overhang: op.overhang ?? 0, lo: box.lo, hi: box.hi, name });
      else throw new Error('Rule "' + name + '" has an operation with none of split, repeat, inset, box, roof');
    }
  };
  walk(source.axiom, { lo: [-sx / 2, 0, -sz / 2], hi: [sx / 2, sy, sz / 2] }, 0);
  return terminals;
}

/* the deeper-than-wide roof swaps x and z, which mirrors it, so its faces turn round to keep pointing outwards */
const orient = (faces, alongX) => (alongX ? faces : faces.map(f => f.slice().reverse()));

/* closed triangle meshes for terminals */
function meshOf(t) {
  const [x0, y0, z0] = t.lo, [x1, y1, z1] = t.hi;
  if (t.kind === 'box') {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    return { v, f };
  }
  const o = t.overhang, X0 = x0 - o, X1 = x1 + o, Z0 = z0 - o, Z1 = z1 + o, ym = (z0 + z1) / 2;
  /* the ridge runs along the longer side */
  const alongX = x1 - x0 >= z1 - z0;
  if (t.kind === 'gable') {
    const v = alongX
      ? [[X0, y0, Z0], [X1, y0, Z0], [X1, y0, Z1], [X0, y0, Z1], [X0, y1, ym], [X1, y1, ym]]
      : [[X0, y0, Z0], [X0, y0, Z1], [X1, y0, Z1], [X1, y0, Z0], [(x0 + x1) / 2, y1, Z0], [(x0 + x1) / 2, y1, Z1]];
    return { v, f: orient([[0, 1, 2, 3], [0, 4, 5, 1], [2, 5, 4, 3], [0, 3, 4], [1, 5, 2]], alongX) };
  }
  if (t.kind === 'hip') {
    const inset = Math.min(x1 - x0, z1 - z0) / 2;
    const v = alongX
      ? [[X0, y0, Z0], [X1, y0, Z0], [X1, y0, Z1], [X0, y0, Z1], [x0 + inset, y1, ym], [x1 - inset, y1, ym]]
      : [[X0, y0, Z0], [X0, y0, Z1], [X1, y0, Z1], [X1, y0, Z0], [(x0 + x1) / 2, y1, z0 + inset], [(x0 + x1) / 2, y1, z1 - inset]];
    return { v, f: orient([[0, 1, 2, 3], [0, 4, 5, 1], [2, 5, 4, 3], [0, 3, 4], [1, 5, 2]], alongX) };
  }
  throw new Error('Roofs are gable or hip, not ' + t.kind);
}

function splitParts(source, roleFor, colourOf) {
  const terminals = derive(source);
  if (!terminals.length) throw new Error('The grammar made no terminals');
  return terminals.map(t => {
    const { v, f } = meshOf(t);
    const pos = new Float32Array(v.flat()), index = [];
    for (const face of f) for (let i = 1; i < face.length - 1; i++) index.push(face[0], face[i], face[i + 1]);
    const value = source.colours[t.colour];
    if (value === undefined) throw new Error('No colour called "' + t.colour + '"');
    return { name: t.name.toLowerCase(), pos, index: Uint32Array.from(index), role: roleFor(value?.role ?? t.colour, colourOf(value)), kind: t.kind };
  });
}

/* box terminals become native box solids where model.json says the part sits: exact distance fields, no seams between
   neighbouring boxes and no faceted normals; roofs stay mesh parts */
function nativeBoxes(report, parts, snap) {
  const path = require('node:path');
  const placed = JSON.parse(fs.readFileSync(path.join(report.directory, 'model.json'), 'utf8')).parts;
  /* the same pixel grid the mesh solids snap to, so walls and roofs meet */
  const unit = snap ? report.extent / snap : 0;
  const round = v => Math.round((unit ? Math.round(v / unit) * unit : v) * 1e4) / 1e4;
  const spec = report.spec;
  spec.solids = spec.solids.map((solid, i) => {
    if (parts[i].kind !== 'box') return solid;
    const { lo, hi } = placed[i];
    return { kind: 'box', at: lo.map((v, k) => round((v + hi[k]) / 2)), half: lo.map((v, k) => round((hi[k] - v) / 2)), mat: solid.mat };
  });
  fs.writeFileSync(report.scene, JSON.stringify(spec, null, 2) + '\n');
  return report;
}

async function buildModel(file, options) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The grammar file is not JSON: ' + error.message);
  }
  if (!source.colours) throw new Error('A grammar needs "colours"');
  if (source.kind === 'lsystem') {
    const os = require('node:os'), path = require('node:path');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-lsystem-')), paint = path.join(tmp, 'plant.paint.json');
    try {
      fs.writeFileSync(paint, JSON.stringify(lsystemPaint(source)));
      const report = await require('./paint-model.js').buildModel(paint, options);
      return { ...report, symbols: expand(source).length };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (source.kind === 'split') {
    const { roleFor, buildFromParts } = require('./model-core.js');
    const colourOf = value => {
      const text = typeof value === 'object' && value ? value.colour ?? value.color : value;
      return typeof text === 'string' ? parseInt(text.replace('#', ''), 16) : text;
    };
    const parts = splitParts(source, roleFor, colourOf);
    return nativeBoxes(await buildFromParts(parts, { ...options, prefix: 'grammar' }), parts, options.snap);
  }
  throw new Error('A grammar is "kind": "lsystem" or "split"');
}

module.exports = { buildModel, expand, turtle, derive };
