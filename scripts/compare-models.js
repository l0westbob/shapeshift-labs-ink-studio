'use strict';
/* Builds the same model with every modelling method and writes a comparison: per method the extracted model (model.glb,
   the hand-off every method shares), the baked result and numbers for both. View it with `npm run serve` and
   /tools/compare.html?manifest=/studio/out/compare-models/manifest.json

     node scripts/compare-models.js [config.json] [out-dir]

   config.json is a list of { method, label, author?, source } (default: the tanks in examples/). method "sdf" takes a
   diorama JSON; the others go through model_build (three, cadquery, vox). */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const Scenes = require('../agent/scenes.js');

const DEFAULT = [
  { method: 'sdf', label: 'SDF (diorama JSON)', author: 'agent run, 6.9 min', source: 'examples/sdf/tank.json' },
  { method: 'three', label: 'three.js', author: 'agent run, 6.4 min', source: 'examples/three/tank-detailed.mjs' },
  { method: 'cadquery', label: 'CadQuery', author: 'written in the session', source: 'examples/cadquery/tank.py' },
  { method: 'vox', label: 'Voxel', author: 'written in the session', source: 'examples/vox/tank.json' }
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
  const entries = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : DEFAULT;
  const outRoot = path.resolve(ROOT, process.argv[3] || 'studio/out/compare-models');
  const manifest = { created: new Date().toISOString(), entries: [] };
  for (const entry of entries) {
    const out = path.join(outRoot, entry.method);
    fs.mkdirSync(out, { recursive: true });
    const started = Date.now();
    let scene, extract;
    if (entry.method === 'sdf') {
      scene = path.join(out, 'scene.json');
      fs.copyFileSync(path.resolve(ROOT, entry.source), scene);
      const exported = await call('scene_export', { scene: { path: scene }, format: 'glb', out: path.join(out, 'model.glb'), overwrite: true });
      extract = { note: 'meshed from the distance field by scene_export; baking uses the field itself, not this mesh', triangles: exported.meshes.reduce((s, m) => s + m.triangles, 0), parts: exported.meshes.length };
    } else {
      const built = await call('model_build', { source: entry.source, engine: entry.method, out, size: 6, pixelSize: 1, overwrite: true, preview: false });
      scene = built.scene;
      extract = { triangles: built.triangles, parts: built.parts?.length ?? built.roles?.length, roles: built.roles, warnings: built.warnings, ...(built.blocks ? { blocks: built.blocks, grid: built.grid, note: 'baked from the voxel grid itself; the GLB holds its visible block faces' } : {}) };
    }
    const buildMs = Date.now() - started;
    const baked = await call('scene_render', { scene: { path: scene }, size: { w: 128, h: 128 }, scale: 4, out: path.join(out, 'final.png'), overwrite: true, measure: ['stats', 'lint', 'values'] });
    await call('scene_render', { scene: { path: scene }, mode: 'turn', frames: 4, size: { w: 160, h: 160 }, scale: 2, out: path.join(out, 'turn.png'), overwrite: true });
    const { stats, lint, values } = baked.metrics;
    manifest.entries.push({
      method: entry.method, label: entry.label, author: entry.author, source: entry.source,
      glb: rel(path.join(out, 'model.glb')), baked: rel(path.join(out, 'final.png')), turn: rel(path.join(out, 'turn.png')),
      extract: { ...extract, buildSeconds: round(buildMs / 1000, 1) },
      bake: { splats: stats.splats?.total ?? stats.count, colours: lint.colours, noise: round(lint.noise), orphans: round(lint.orphans), tones: values.verdict, reference: { noise: round(lint.reference?.noise), orphans: round(lint.reference?.orphans) } }
    });
    console.log(entry.method.padEnd(9), (buildMs / 1000).toFixed(1) + ' s', extract.triangles + ' triangles', 'noise ' + round(lint.noise), 'orphans ' + round(lint.orphans), values.verdict);
  }
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nnpm run serve, then http://127.0.0.1:8765/tools/compare.html?manifest=' + rel(path.join(outRoot, 'manifest.json')));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
