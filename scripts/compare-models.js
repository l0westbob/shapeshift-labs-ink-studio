'use strict';
/* Builds the same model with every modelling method and writes a comparison: per method the extracted model (model.glb,
   the hand-off every method shares), the baked result and numbers for both. View it with `npm run serve` and
   /tools/compare.html?manifest=/studio/out/compare-models/manifest.json

     node scripts/compare-models.js [config.json] [out-dir]

   config.json is a list of { method, label, author?, source, group?, out?, options? } (options: extra model_build input) (default: every method in examples/). method
   "diorama" takes a diorama JSON as it is; the others are model_build engines. Methods that write no model.glb (dioramas,
   compositions, paintings, L-systems) are meshed with scene_export for the comparison. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const Scenes = require('../agent/scenes.js');

const TANK = 'The same tank';
const OTHER = 'Methods made for other subjects';
const DEFAULT = [
  { method: 'diorama', label: 'SDF diorama (JSON)', author: 'agent run, 6.9 min', source: 'examples/sdf/tank.json', group: TANK },
  { method: 'three', label: 'three.js', author: 'agent run, 6.4 min', source: 'examples/three/tank-detailed.mjs', group: TANK },
  { method: 'cadquery', label: 'CadQuery', author: 'written in the session', source: 'examples/cadquery/tank.py', group: TANK },
  { method: 'blender', label: 'Blender (bpy)', author: 'written in the session', source: 'examples/blender/tank.blender.py', group: TANK },
  { method: 'openscad', label: 'OpenSCAD', author: 'written in the session', source: 'examples/openscad/tank.scad', group: TANK },
  { method: 'sdf', label: 'SDF as code', author: 'written in the session', source: 'examples/sdf-code/tank.sdf.mjs', group: TANK },
  { method: 'subd', label: 'Subdivision cages', author: 'written in the session', source: 'examples/subd/tank.subd.mjs', group: TANK },
  { method: 'loft', label: 'Lofted B-splines', author: 'written in the session', source: 'examples/loft/tank.loft.json', group: TANK },
  { method: 'vox', label: 'Voxels', author: 'written in the session', source: 'examples/vox/tank.json', group: TANK },
  { method: 'carve', label: 'Carved from drawn views', author: 'written in the session', source: 'examples/carve/tank.views.json', group: TANK },
  { method: 'stack', label: 'Sprite stacking', author: 'slices of the voxel tank', source: 'examples/stack/tank.stack.json', group: TANK },
  { method: 'splat', label: 'Capture (point cloud)', author: 'stand-in sampled from the CadQuery tank', source: 'examples/splat/tank.splat.json', group: TANK },
  { method: 'depth', label: 'Depth maps (front and back)', author: 'drawn from the voxel tank', source: 'examples/depth/tank.depth.json', group: TANK },
  { method: 'compose', label: 'Composition', author: 'CadQuery hull, voxel star, SDF sandbags', source: 'examples/compose/tank.compose.json', group: TANK },
  { method: 'glb', label: 'TRELLIS.2 (image to 3D)', author: 'trellis2mlx preview from a render of the three.js tank, 68 s', source: 'examples/glb/tank-trellis.glb', group: TANK, options: { colourSpace: 'linear', yaw: -1.5708 } },
  { method: 'paint', label: 'Painting with splats', author: 'written in the session', source: 'examples/paint/tree.paint.json', group: OTHER },
  { method: 'grammar', label: 'L-system', author: 'written in the session', source: 'examples/grammar/tree.grammar.json', group: OTHER, out: 'lsystem' },
  { method: 'grammar', label: 'Split grammar', author: 'written in the session', source: 'examples/grammar/house.grammar.json', group: OTHER, out: 'split' },
  { method: 'terrain', label: 'Height-map terrain', author: 'written in the session', source: 'examples/terrain/island.terrain.json', group: OTHER },
  { method: 'level', label: '2.5D level (tiles and sectors)', author: 'written in the session', source: 'examples/level/dungeon.level.json', group: OTHER }
];

const ctx = { root: ROOT, allowCode: true };
const call = async (tool, args) => {
  const outcome = await registry.call(tool, args, ctx);
  if (!outcome.ok) throw new Error(tool + ': ' + outcome.error.code + ' ' + outcome.error.message + (outcome.error.hint ? ' (' + outcome.error.hint + ')' : ''));
  return outcome.result;
};
const rel = file => '/' + path.relative(ROOT, file).split(path.sep).join('/');
const round = (v, n = 3) => (typeof v === 'number' ? Math.round(v * 10 ** n) / 10 ** n : v);

async function main() {
  if (require.main !== module) return;
  const entries = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : DEFAULT;
  const outRoot = path.resolve(ROOT, process.argv[3] || 'studio/out/compare-models');
  const manifest = { created: new Date().toISOString(), entries: [] };
  for (const entry of entries) {
    const out = path.join(outRoot, entry.out ?? entry.method);
    fs.mkdirSync(out, { recursive: true });
    /* a model.glb left from an earlier run would hide that a method writes none */
    fs.rmSync(path.join(out, 'model.glb'), { force: true });
    const started = Date.now();
    let scene, extract;
    if (entry.method === 'diorama') {
      scene = path.join(out, 'scene.json');
      fs.copyFileSync(path.resolve(ROOT, entry.source), scene);
      extract = {};
    } else {
      /* the tanks are scaled to 6 units; other subjects keep the units they were written in */
      const sized = entry.group === OTHER ? {} : { size: 6 };
      const built = await call('model_build', { source: entry.source, engine: entry.method, out, ...sized, pixelSize: 1, ...entry.options, overwrite: true, preview: false });
      scene = built.scene;
      extract = {
        triangles: built.triangles, parts: built.parts?.length ?? built.solids, roles: built.roles, warnings: built.warnings?.length ? built.warnings : undefined,
        ...(built.blocks ? { blocks: built.blocks, note: 'baked from the voxel grid itself; the GLB holds its visible block faces' } : {})
      };
    }
    const buildMs = Date.now() - started;
    if (!fs.existsSync(path.join(out, 'model.glb'))) {
      const exported = await call('scene_export', { scene: { path: scene }, format: 'glb', out: path.join(out, 'model.glb'), overwrite: true });
      extract = { ...extract, triangles: exported.meshes.reduce((s, m) => s + m.triangles, 0), note: 'no mesh hand-off: meshed from the scene by scene_export for this view; baking uses the scene itself' };
    }
    const baked = await call('scene_render', { scene: { path: scene }, size: { w: 128, h: 128 }, scale: 4, out: path.join(out, 'final.png'), overwrite: true, measure: ['stats', 'lint', 'values'] });
    await call('scene_render', { scene: { path: scene }, mode: 'turn', frames: 4, size: { w: 160, h: 160 }, scale: 2, out: path.join(out, 'turn.png'), overwrite: true });
    const { stats, lint, values } = baked.metrics;
    manifest.entries.push({
      method: entry.method, label: entry.label, author: entry.author, source: entry.source, group: entry.group, scene: rel(scene),
      glb: rel(path.join(out, 'model.glb')), baked: rel(path.join(out, 'final.png')), turn: rel(path.join(out, 'turn.png')),
      extract: { ...extract, buildSeconds: round(buildMs / 1000, 1) },
      bake: { splats: stats.splats?.total ?? stats.count, colours: lint.colours, noise: round(lint.noise), orphans: round(lint.orphans), tones: values.verdict, reference: { noise: round(lint.reference?.noise), orphans: round(lint.reference?.orphans) } }
    });
    console.log((entry.out ?? entry.method).padEnd(9), (buildMs / 1000).toFixed(1) + ' s', extract.triangles + ' triangles', 'noise ' + round(lint.noise), 'orphans ' + round(lint.orphans), values.verdict);
  }
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nnpm run serve, then http://127.0.0.1:8765/tools/compare.html?manifest=' + rel(path.join(outRoot, 'manifest.json')));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
