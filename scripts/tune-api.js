'use strict';
/* The live tuner behind tools/tune.html: render a diorama with settings changed on the fly. Settings that only change the
   view (art resolution, camera, outline look) re-render the baked world; settings that change the bake (splat spacing,
   shade steps, dithering, light) bake a variant once and keep it in a small cache, so moving back to an earlier value is
   instant too. Served by scripts/serve.js on 127.0.0.1 only; scenes must be JSON dioramas inside the repository.

     GET  /api/scenes                 the scenes of the last comparison (label, path)
     POST /api/tune  { scene, settings }   -> { image (PNG base64), width, height, metrics, timings, settings }
     POST /api/save  { scene, settings }   -> writes <scene>.tuned.json next to the scene */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Scenes = require('../agent/scenes.js');
require('../agent/ops/index.js');
const SceneOps = require('../agent/ops/scene.js');
const { materials } = require('../cli/compose-model.js');

const CACHE = new Map(), LIMIT = 8;
const spans = new Map();
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

function sceneFile(given) {
  const file = path.resolve(ROOT, String(given ?? '').replace(/^\//, ''));
  if (!file.startsWith(ROOT + path.sep) || !file.endsWith('.json') || !fs.existsSync(file))
    throw Object.assign(new Error('No JSON diorama inside the repository at ' + given), { status: 404 });
  return file;
}

/* the diorama with the bake settings applied; view settings are not part of it */
function variantOf(base, s, span) {
  const spec = structuredClone(base);
  spec.finish = { ...spec.finish, look: { ...spec.finish?.look, pixelSize: 1 } };
  const art = s.art ?? 128;
  if (s.res === 'auto' || s.res === undefined) spec.finish.res = round(Math.min(0.09, span / art), 4);
  else if (s.res !== 'keep') spec.finish.res = Number(s.res);
  if (s.paletteDither !== undefined && s.paletteDither !== 'keep') spec.finish.dither = Number(s.paletteDither);
  if (s.sunYaw !== undefined || s.sunHeight !== undefined || s.amb !== undefined || s.sky !== undefined) {
    const light = { ...spec.light };
    if (s.sunYaw !== undefined && s.sunHeight !== undefined) {
      const yaw = (s.sunYaw * Math.PI) / 180, h = (s.sunHeight * Math.PI) / 180;
      light.sun = [round(Math.cos(h) * Math.sin(yaw)), round(Math.sin(h)), round(Math.cos(h) * Math.cos(yaw))];
    }
    if (s.amb !== undefined) light.amb = Number(s.amb);
    if (s.sky !== undefined) light.sky = Number(s.sky);
    spec.light = light;
  }
  /* pixel styles on every material: shade steps, ramp dithering, edge hardness */
  const style = {};
  if (s.shadeSteps !== undefined && s.shadeSteps !== 'keep') style.shadeSteps = Number(s.shadeSteps);
  if (s.matDither !== undefined && s.matDither !== 'keep') style.dither = s.matDither;
  if (s.edgeHardness !== undefined && s.edgeHardness !== 'keep') style.edgeHardness = Number(s.edgeHardness);
  if (Object.keys(style).length)
    for (const solid of spec.solids ?? [])
      for (const [mat, set] of materials(solid)) {
        if (typeof mat === 'string') set({ role: mat, pixelStyle: style });
        else if (mat && typeof mat === 'object') set({ ...mat, pixelStyle: { ...mat.pixelStyle, ...style } });
      }
  return spec;
}

function entryFor(file, spec) {
  const key = file + '\n' + JSON.stringify(spec);
  let entry = CACHE.get(key);
  if (entry) {
    CACHE.delete(key);
    CACHE.set(key, entry);
    return { entry, cached: true };
  }
  entry = Scenes.openDiorama(spec, { file });
  entry.worlds = new Map();
  entry.handle = 'tune';
  CACHE.set(key, entry);
  while (CACHE.size > LIMIT) CACHE.delete(CACHE.keys().next().value);
  return { entry, cached: false };
}

function spanOf(file, base) {
  if (spans.has(file)) return spans.get(file);
  const entry = Scenes.openDiorama(base, { file });
  entry.worlds = new Map();
  const world = Scenes.worldAt(entry);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0, q = 0; i < world.count; i++, q += 16) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], world.data[q + k]), hi[k] = Math.max(hi[k], world.data[q + k]);
  const span = Math.max(...hi.map((v, k) => v - lo[k])) || 6;
  spans.set(file, span);
  return span;
}

function tune({ scene, settings = {} }) {
  const file = sceneFile(scene), base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const span = spanOf(file, base), spec = variantOf(base, settings, span);
  const started = Date.now();
  const { entry, cached } = entryFor(file, spec);
  const world = Scenes.worldAt(entry);
  const bakeMs = cached ? 0 : Date.now() - started;
  const art = Math.max(16, Math.min(1024, Math.round(settings.art ?? 128)));
  const view = {};
  for (const key of ['yaw', 'pitch', 'zoom']) if (settings[key] !== undefined) view[key] = Number(settings[key]);
  if (settings.ortho) view.ortho = true;
  const drawStarted = Date.now();
  const shot = SceneOps.renderEntry(entry, {
    size: { w: art, h: Math.round(art * (settings.aspect ?? 0.75)) }, scale: 1, view,
    look: { colored: Boolean(settings.colored), raw: Boolean(settings.raw) }, measure: ['stats', 'lint', 'values']
  }, { root: ROOT });
  const { lint, values, stats } = shot.metrics;
  return {
    image: shot.image.base64, width: shot.width, height: shot.height,
    metrics: { noise: round(lint.noise), orphans: round(lint.orphans), jaggies: round(lint.jaggies), banding: round(lint.banding), tones: values.verdict, colours: lint.colours, splats: stats.splats.total, reference: lint.reference },
    timings: { bakeMs, drawMs: Date.now() - drawStarted, cached },
    resolved: { res: spec.finish.res, span: round(span), sun: spec.light?.sun, camera: { yaw: world.cam?.yaw, pitch: world.cam?.pitch } }
  };
}

function save({ scene, settings = {} }) {
  const file = sceneFile(scene), base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const spec = variantOf(base, settings, spanOf(file, base));
  if (settings.yaw !== undefined || settings.pitch !== undefined)
    spec.camera = { ...spec.camera, ...(settings.yaw !== undefined && { yaw: Number(settings.yaw) }), ...(settings.pitch !== undefined && { pitch: Number(settings.pitch) }) };
  const out = file.replace(/\.json$/, '.tuned.json');
  fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
  return { file: '/' + path.relative(ROOT, out).split(path.sep).join('/'), render: { size: { w: settings.art ?? 128, h: Math.round((settings.art ?? 128) * (settings.aspect ?? 0.75)) } } };
}

function scenes() {
  const manifest = path.join(ROOT, 'studio/out/compare-models/manifest.json');
  if (!fs.existsSync(manifest)) return [];
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).entries.map(e => ({ label: e.label, group: e.group, scene: path.posix.join(path.posix.dirname(e.baked), 'scene.json') }));
}

module.exports = { tune, save, scenes };
