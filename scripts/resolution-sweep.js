'use strict';
/* How fine should the pixel art be? Renders the models of compare-models.js at several art resolutions, each with a splat
   spacing (finish.res) matched to the pixel size, and shows them at one display size with their numbers. Run
   scripts/compare-models.js first; view with `npm run serve` and /tools/sweep.html.

     node scripts/resolution-sweep.js [sizes] [compare-dir]      sizes default 64,96,128,192,384

   The splat spacing is the model's longest side divided by the art size, never coarser than the renderer's 0.09: the
   default spacing is coarser than a pixel once a model is a few units long, which shows as blotchy shading. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');

const ctx = { root: ROOT };
const call = async (tool, args) => {
  const outcome = await registry.call(tool, args, ctx);
  if (!outcome.ok) throw new Error(tool + ': ' + outcome.error.code + ' ' + outcome.error.message);
  return outcome.result;
};
const rel = file => '/' + path.relative(ROOT, file).split(path.sep).join('/');
const round = v => Math.round(v * 1000) / 1000;
const DISPLAY = 384;

async function main() {
  const sizes = (process.argv[2] ?? '64,96,128,192,384').split(',').map(Number);
  for (const size of sizes) if (DISPLAY % size) throw new Error(size + ' does not divide ' + DISPLAY + ', the display size');
  const compareDir = path.resolve(ROOT, process.argv[3] ?? 'studio/out/compare-models');
  const compare = JSON.parse(fs.readFileSync(path.join(compareDir, 'manifest.json'), 'utf8'));
  const outRoot = path.join(ROOT, 'studio/out/resolution-sweep');
  fs.mkdirSync(outRoot, { recursive: true });
  const manifest = { created: new Date().toISOString(), sizes, display: DISPLAY, entries: [] };
  for (const entry of compare.entries) {
    const dir = path.join(ROOT, path.dirname(entry.baked)), scene = path.join(dir, 'scene.json');
    if (!fs.existsSync(scene)) continue;
    const spec = JSON.parse(fs.readFileSync(scene, 'utf8'));
    const probe = await call('scene_measure', { scene: { path: scene }, size: { w: 64, h: 64 }, metrics: ['stats'] });
    const { min, max } = probe.stats.extent, span = Math.max(...max.map((v, k) => v - min[k]));
    const cells = [];
    for (const size of sizes) {
      /* the variant sits next to the scene, so its mesh assets resolve the same way */
      const variant = path.join(dir, 'scene-sweep.json');
      const res = round(Math.min(0.09, span / size));
      fs.writeFileSync(variant, JSON.stringify({ ...spec, finish: { ...spec.finish, res, look: { ...spec.finish?.look, pixelSize: 1 } } }));
      const file = path.join(outRoot, path.basename(dir) + '-' + size + '.png');
      const started = Date.now();
      /* every size drawn at the same display size, in whole pixels */
      const shot = await call('scene_render', { scene: { path: variant }, size: { w: size, h: size }, scale: DISPLAY / size, out: file, overwrite: true, measure: ['stats', 'lint', 'values'] });
      const ms = Date.now() - started;
      const { lint, values, stats } = shot.metrics;
      cells.push({ size, res, image: rel(file), noise: round(lint.noise), orphans: round(lint.orphans), jaggies: round(lint.jaggies), tones: values.verdict, splats: stats.splats.total, seconds: round(ms / 1000) });
      fs.rmSync(variant, { force: true });
    }
    manifest.entries.push({ label: entry.label, group: entry.group, span: round(span), cells });
    console.log(entry.label.padEnd(26), cells.map(c => c.size + ':' + c.noise).join('  '));
  }
  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('\nnpm run serve, then http://127.0.0.1:8765/tools/sweep.html');
}

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
