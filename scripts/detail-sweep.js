'use strict';
/* How much input detail does a given sprite size want? Two experiments on one detailed model (the CadQuery tank from
   scripts/compare-models.js), rendered at one art size:

   1. raster: the model voxelised at several resolutions (blocks along its longest side), built as voxel models
   2. continuous: the mesh model with several distance-field resolutions (cells) and splat spacings

   Each render is scored for pixel-art faults (noise, orphans, jaggies) and for fidelity: silhouette overlap and colour
   agreement with a reference render of the mesh at a fine field and spacing. Views: the default three-quarter camera and
   an orthographic side view. Writes studio/out/detail-sweep/report.json and a contact sheet.

     node scripts/detail-sweep.js [art] [model-dir]          art default 128 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Scenes = require('../agent/scenes.js');
require('../agent/ops/index.js');
const SceneOps = require('../agent/ops/scene.js');
const { compare } = require('../agent/ops/fit.js');
const { rampOf } = require('../cli/model-core.js');

const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const VIEWS = { 'three-quarter': {}, side: { yaw: 0, pitch: 0, ortho: true } };

/* scanline voxelisation: per part, rays along +x through every (y, z) block centre, filled between crossing pairs */
function voxelise(parts, blocks) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { pos } of parts) for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], pos[i + k]), hi[k] = Math.max(hi[k], pos[i + k]);
  const cell = Math.max(...hi.map((v, k) => v - lo[k])) / blocks;
  const n = hi.map((v, k) => Math.max(1, Math.ceil((v - lo[k]) / cell)));
  const grid = new Array(n[0] * n[1] * n[2]).fill(null), id = (x, y, z) => (x * n[1] + y) * n[2] + z;
  for (const { pos, tri, colour } of parts) {
    /* triangles bucketed by the (y, z) rows their box covers */
    const rows = new Map();
    for (let t = 0; t < tri.length; t += 3) {
      const ys = [0, 1, 2].map(k => pos[tri[t + k] * 3 + 1]), zs = [0, 1, 2].map(k => pos[tri[t + k] * 3 + 2]);
      const y0 = Math.max(0, Math.floor((Math.min(...ys) - lo[1]) / cell - 0.5)), y1 = Math.min(n[1] - 1, Math.ceil((Math.max(...ys) - lo[1]) / cell - 0.5));
      const z0 = Math.max(0, Math.floor((Math.min(...zs) - lo[2]) / cell - 0.5)), z1 = Math.min(n[2] - 1, Math.ceil((Math.max(...zs) - lo[2]) / cell - 0.5));
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const key = y * n[2] + z;
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(t);
      }
    }
    for (const [key, list] of rows) {
      const y = Math.floor(key / n[2]), z = key % n[2], py = lo[1] + (y + 0.5) * cell, pz = lo[2] + (z + 0.5) * cell;
      const hits = [];
      for (const t of list) {
        const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
        /* barycentric test of (py, pz) in the triangle's yz projection, then x at that point */
        const d = (pos[b + 1] - pos[a + 1]) * (pos[c + 2] - pos[a + 2]) - (pos[c + 1] - pos[a + 1]) * (pos[b + 2] - pos[a + 2]);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((py - pos[a + 1]) * (pos[c + 2] - pos[a + 2]) - (pz - pos[a + 2]) * (pos[c + 1] - pos[a + 1])) / d;
        const v = ((pz - pos[a + 2]) * (pos[b + 1] - pos[a + 1]) - (py - pos[a + 1]) * (pos[b + 2] - pos[a + 2])) / d;
        if (u < 0 || v < 0 || u + v > 1) continue;
        hits.push(pos[a] + u * (pos[b] - pos[a]) + v * (pos[c] - pos[a]));
      }
      hits.sort((p, q) => p - q);
      for (let h = 0; h + 1 < hits.length; h += 2)
        for (let x = Math.max(0, Math.ceil((hits[h] - lo[0]) / cell - 0.5)); x < n[0] && lo[0] + (x + 0.5) * cell <= hits[h + 1]; x++) grid[id(x, y, z)] = colour;
    }
  }
  return { n, cell, grid, id };
}

function voxSourceOf({ n, cell, grid, id }, roleOf) {
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz', letters = new Map(), colours = {};
  const layers = [];
  for (let y = 0; y < n[1]; y++) {
    const rows = [];
    for (let z = n[2] - 1; z >= 0; z--) {
      let row = '';
      for (let x = 0; x < n[0]; x++) {
        const c = grid[id(x, y, z)];
        if (c === null) { row += '.'; continue; }
        if (!letters.has(c)) {
          const letter = LETTERS[letters.size];
          letters.set(c, letter);
          colours[letter] = { colour: '#' + c.toString(16).padStart(6, '0'), role: roleOf.get(c) };
        }
        row += letters.get(c);
      }
      rows.push(row);
    }
    layers.push(rows.join('/'));
  }
  return { cell, hard: true, colours, layers };
}

async function main() {
  const art = Number(process.argv[2] ?? 128), dir = path.resolve(ROOT, process.argv[3] ?? 'studio/out/compare-models/cadquery');
  const out = path.join(ROOT, 'studio/out/detail-sweep');
  fs.mkdirSync(out, { recursive: true });
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8'));
  const studio = Scenes.studio(), kit = Scenes.kit().KIT;
  const colourOfRole = role => spec.palette[spec.roles[role][spec.roles[role].length - 2]];
  const parts = spec.solids.filter(s => s.kind === 'mesh').map(s => {
    const mesh = studio.readMesh(path.join(dir, s.asset));
    return { pos: mesh.pos, tri: mesh.tri, colour: colourOfRole(typeof s.mat === 'string' ? s.mat : s.mat.role), role: typeof s.mat === 'string' ? s.mat : s.mat.role };
  });
  const roleOf = new Map(parts.map(p => [p.colour, p.role]));
  const families = new Map([...roleOf.keys()].map(c => [c, rampOf(c, 5).map(v => [(v >> 16) & 255, (v >> 8) & 255, v & 255])]));
  const aspect = 0.75, size = { w: art, h: Math.round(art * aspect) };
  const span = (spec.camera?.dist ?? 6 * 1.7) / 1.7;

  const render = (entryOrSpec, file, view) => {
    const entry = entryOrSpec.kind ? entryOrSpec : Object.assign(Scenes.openDiorama(entryOrSpec, { file }), { worlds: new Map(), handle: 'detail' });
    const world = Scenes.worldAt(entry);
    const image = SceneOps.renderImage(world, { size, view: VIEWS[view] });
    return { entry, world, image, metrics: SceneOps.measure(world, image, ['lint']).lint };
  };
  /* the reference: the mesh scene with a fine field and splats half a pixel apart */
  const refSpec = { ...spec, finish: { ...spec.finish, res: round(span / art / 2, 4), look: { ...spec.finish?.look, pixelSize: 1 } }, solids: spec.solids.map(s => (s.kind === 'mesh' ? { ...s, cells: s.cells * 3 } : s)) };
  const reference = {};
  for (const view of Object.keys(VIEWS)) {
    const { image, world } = render(refSpec, path.join(dir, 'scene.json'), view);
    const bg = (image.palette || world.pal)[0], bgRgb = [(bg >> 16) & 255, (bg >> 8) & 255, bg & 255];
    const cells = [];
    let x0 = image.w, x1 = -1;
    for (let p = 0; p < image.w * image.h; p++) {
      const rgb = [...image.rgb.subarray(p * 3, p * 3 + 3)];
      const filled = (rgb[0] - bgRgb[0]) ** 2 + (rgb[1] - bgRgb[1]) ** 2 + (rgb[2] - bgRgb[2]) ** 2 > 30;
      if (!filled) { cells.push(null); continue; }
      x0 = Math.min(x0, p % image.w), x1 = Math.max(x1, p % image.w);
      /* the reference pixel's colour family */
      let best = null, bestD = Infinity;
      for (const [colour, shades] of families) for (const s of shades) {
        const d = (rgb[0] - s[0]) ** 2 + (rgb[1] - s[1]) ** 2 + (rgb[2] - s[2]) ** 2;
        if (d < bestD) (bestD = d), (best = colour);
      }
      cells.push(best);
    }
    reference[view] = { target: { view, w: image.w, h: image.h, cells, colours: [...families.keys()] }, width: x1 - x0 + 1 };
  }
  const score = (image, world, view) => {
    const m = compare(reference[view].target, image, (image.palette || world.pal)[0], families);
    return { silhouette: round(m.silhouette), colour: round(m.colour) };
  };

  const report = { art, size, reference: Object.fromEntries(Object.entries(reference).map(([v, r]) => [v, { objectPixels: r.width }])), raster: [], continuous: [] };
  /* 1. raster */
  for (const blocks of [20, 35, 50, 70, 100, 128, 160]) {
    const vox = voxSourceOf(voxelise(parts, blocks), roleOf);
    const voxDir = path.join(out, 'vox-' + blocks);
    const built = await require('../cli/vox-model.js').buildFromSource(vox, { out: voxDir, size: span, overwrite: true, kit });
    const scene = JSON.parse(fs.readFileSync(built.scene, 'utf8'));
    scene.finish = { ...scene.finish, res: round(Math.min(0.09, span / art), 4), look: { ...scene.finish?.look, pixelSize: 1 } };
    scene.camera = spec.camera;
    const row = { blocks, cell: round(vox.cell, 4) };
    for (const view of Object.keys(VIEWS)) {
      const { image, world, metrics } = render(scene, built.scene, view);
      row[view] = { pixelsPerBlock: round(reference[view].width / blocks, 2), noise: round(metrics.noise), orphans: round(metrics.orphans), jaggies: round(metrics.jaggies), ...score(image, world, view) };
      fs.writeFileSync(path.join(out, 'vox-' + blocks + '-' + view + '.png'), require('../cli/png.js').encode(image.w, image.h, image.rgb));
    }
    report.raster.push(row);
    console.log('vox', String(blocks).padStart(3), Object.keys(VIEWS).map(v => v + ' ' + JSON.stringify(row[v])).join('  '));
  }
  /* 2. continuous */
  for (const cells of [48, 96, 128, 192]) for (const spacing of [0.5, 1, 2, 3]) {
    const factor = cells / 96;
    const variant = { ...spec, finish: { ...spec.finish, res: round(Math.min(0.09, (span / art) * spacing), 4), look: { ...spec.finish?.look, pixelSize: 1 } }, solids: spec.solids.map(s => (s.kind === 'mesh' ? { ...s, cells: Math.max(12, Math.round(s.cells * factor)) } : s)) };
    const row = { cells, spacing };
    for (const view of Object.keys(VIEWS)) {
      const { image, world, metrics } = render(variant, path.join(dir, 'scene.json'), view);
      row[view] = { noise: round(metrics.noise), orphans: round(metrics.orphans), jaggies: round(metrics.jaggies), ...score(image, world, view) };
    }
    report.continuous.push(row);
    console.log('mesh cells', String(cells).padStart(3), 'spacing', spacing, Object.keys(VIEWS).map(v => v + ' ' + JSON.stringify(row[v])).join('  '));
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\nobject width in pixels:', JSON.stringify(report.reference));
}

if (require.main === module)
  main().catch(error => {
    console.error(error.stack);
    process.exit(1);
  });
