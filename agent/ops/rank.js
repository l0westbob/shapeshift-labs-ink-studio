'use strict';
/* model_rank: best of N. Many candidates for one brief (from different engines, agents or seeds) are baked, rendered and
   scored the same way, and ranked: pixel-art faults against the reference, tonal readability, and, when target views
   are given, how well each matches them. It writes a ranking, a contact sheet and a manifest that tools/compare.html
   shows, so the winner can be picked, looked at and refined (scene_fit, scene_edit). */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const Scenes = require('../scenes.js');

const SceneOps = () => require('./scene.js');
const Fit = () => require('./fit.js');

const LOWER_IS_BETTER = ['orphans', 'doubles', 'jaggies', 'noise', 'banding'];
const TONES = { THREE_TONES: 1, TWO_TONES: 0.6 };
const round = v => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);

/* 1 when a fault is at or under the reference, falling towards 0 as it grows past it */
function cleanliness(lint) {
  const shares = LOWER_IS_BETTER.map(key => {
    const value = lint[key], reference = lint.reference?.[key];
    if (typeof value !== 'number' || !reference) return null;
    return Math.min(1, reference / Math.max(value, reference * 0.05));
  }).filter(v => v !== null);
  return shares.length ? shares.reduce((s, v) => s + v, 0) / shares.length : 0;
}

/* a candidate's scene: a diorama path, or a model_build output directory */
function sceneFile(candidate, root, i) {
  const where = '/candidates/' + i;
  const given = candidate.scene ?? candidate.dir;
  if (typeof given !== 'string') throw new OpError('INVALID_INPUT', 'A candidate is { scene: path } or { dir: model_build out }', { path: where });
  let file = path.resolve(root, given);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'scene.json');
  if (!fs.existsSync(file)) throw new OpError('NOT_FOUND', 'No scene at ' + file, { path: where });
  return file;
}

defineOp({
  name: 'model_rank',
  destructive: true,
  title: 'Rank candidate models',
  effects: 'expensive',
  description: 'Best of N: bake, render and score candidate models for one brief the same way, and rank them. A candidate is { scene: diorama path } or { dir: a model_build output directory }, with an optional label. The score blends cleanliness (pixel-art faults against the reference: orphans, doubles, jaggies, noise, banding), tones (three readable tones beat two) and, when targets are given (views of a carve source, letter grids or PNGs, as in scene_fit), silhouette and colour match. Writes out/ranking.json, out/sheet.png (every candidate, best first) and out/manifest.json for tools/compare.html. Use it after several agents or engines built the same thing, then refine the winner.',
  input: {
    type: 'object', required: ['candidates', 'out'],
    properties: {
      candidates: {
        type: 'array', minItems: 1, maxItems: 32,
        items: { type: 'object', properties: { scene: { type: 'string' }, dir: { type: 'string' }, label: { type: 'string' } }, additionalProperties: false }
      },
      targets: { type: 'array', items: { type: 'object' }, description: 'Optional target views, as in scene_fit.' },
      out: { type: 'string', description: 'Directory for ranking.json, sheet.png and manifest.json.' },
      size: { type: 'integer', minimum: 32, maximum: 512, description: 'Render size (default 128).' },
      weights: {
        type: 'object', additionalProperties: false,
        properties: { clean: { type: 'number' }, tones: { type: 'number' }, match: { type: 'number' } },
        description: 'Score weights (default clean 0.5, tones 0.2, match 0.6 when targets are given).'
      }
    },
    additionalProperties: false
  },
  async run({ candidates, targets: targetList, out, size = 128, weights = {} }, ctx) {
    const root = ctx.root ?? process.cwd();
    const dirOut = path.resolve(root, out);
    fs.mkdirSync(dirOut, { recursive: true });
    const w = { clean: weights.clean ?? 0.5, tones: weights.tones ?? 0.2, match: targetList?.length ? weights.match ?? 0.6 : 0 };
    const targets = targetList?.length ? Fit().targetsOf(targetList, root) : [];
    const { rampOf } = require('../../cli/model-core.js');
    const families = new Map();
    for (const t of targets) for (const c of t.colours) if (!families.has(c)) families.set(c, rampOf(c, 5).map(Fit().rgbOf));

    const rows = [];
    for (const [i, candidate] of candidates.entries()) {
      const file = sceneFile(candidate, root, i);
      const label = candidate.label ?? path.basename(path.dirname(file));
      const slot = path.join(dirOut, String(i + 1).padStart(2, '0') + '-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
      fs.mkdirSync(slot, { recursive: true });
      let entry;
      try {
        entry = Scenes.open({ path: file }, { ...ctx, persist: false });
      } catch (error) {
        rows.push({ label, scene: file, error: error.message, score: -Infinity });
        continue;
      }
      const shot = SceneOps().renderEntry(entry, { size: { w: size, h: size }, scale: 4, out: path.join(slot, 'baked.png'), overwrite: true, measure: ['stats', 'lint', 'values'] }, ctx);
      const { lint, values, stats } = shot.metrics;
      const clean = cleanliness(lint), tones = TONES[values.verdict] ?? 0.3;
      let match = null;
      if (targets.length) {
        const world = Scenes.worldAt(entry);
        let silhouette = 0, colour = 0;
        for (const target of targets) {
          const image = SceneOps().renderImage(world, { view: { ...Fit().CAMERAS[target.view], ortho: true }, size: { w: 96, h: 96 } });
          const m = Fit().compare(target, image, (image.palette || world.pal)[0], families);
          silhouette += m.silhouette / targets.length;
          colour += m.colour / targets.length;
        }
        match = { silhouette: round(silhouette), colour: round(colour), score: round((silhouette + 0.5 * colour) / 1.5) };
      }
      const total = (w.clean * clean + w.tones * tones + w.match * (match?.score ?? 0)) / (w.clean + w.tones + w.match);
      const glb = path.join(path.dirname(file), 'model.glb');
      rows.push({
        label, scene: file, baked: path.join(slot, 'baked.png'), glb: fs.existsSync(glb) ? glb : undefined,
        score: round(total), clean: round(clean), tones: values.verdict, match,
        lint: { noise: round(lint.noise), orphans: round(lint.orphans), jaggies: round(lint.jaggies), doubles: round(lint.doubles) },
        splats: stats.splats?.total, image: shot
      });
    }
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((row, i) => (row.rank = i + 1));

    /* contact sheet, best first */
    const R = require('../../cli/render.js'), PNG = require('../../cli/png.js');
    const ranked = rows.filter(row => row.baked), shots = ranked.map(row => PNG.read(row.baked));
    if (shots.length) {
      const sheet = R.grid(shots.map(s => ({ w: s.w, h: s.h, rgb: s.rgb })), Math.min(4, shots.length), ranked.map(row => '#' + row.rank + ' ' + row.label + ' ' + row.score));
      fs.writeFileSync(path.join(dirOut, 'sheet.png'), PNG.encode(sheet.w, sheet.h, sheet.rgb));
    }
    const rel = file => '/' + path.relative(root, file).split(path.sep).join('/');
    const manifest = {
      created: new Date().toISOString(),
      entries: rows.filter(row => row.baked).map(row => ({
        method: 'rank-' + row.rank, label: '#' + row.rank + ' ' + row.label + ' (' + row.score + ')', author: 'model_rank', source: rel(row.scene),
        glb: row.glb ? rel(row.glb) : undefined, baked: rel(row.baked), turn: rel(row.baked),
        extract: { note: row.glb ? undefined : 'no model.glb next to this scene' },
        bake: { splats: row.splats, colours: undefined, noise: row.lint.noise, orphans: row.lint.orphans, tones: row.tones, reference: { noise: 0.177, orphans: 0.015 } }
      }))
    };
    fs.writeFileSync(path.join(dirOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const ranking = rows.map(({ image, ...row }) => row);
    fs.writeFileSync(path.join(dirOut, 'ranking.json'), JSON.stringify(ranking, null, 2) + '\n');
    return {
      ranking, best: ranking[0], sheet: path.join(dirOut, 'sheet.png'), manifest: path.join(dirOut, 'manifest.json'),
      view: 'npm run serve, then http://127.0.0.1:8765/tools/compare.html?manifest=' + rel(path.join(dirOut, 'manifest.json'))
    };
  }
});
