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

/* baked variants, most recent last; bounded by their splat count (about 64 bytes each), so a comparison page with a
   dozen scenes keeps them all while one scene can still hold many variants */
const CACHE = new Map();
let SPLAT_BUDGET = 8e6;
const splatsIn = entry => [...entry.worlds.values()].reduce((sum, world) => sum + (world.count ?? 0), 0);
const spans = new Map();
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

/* the given path is not echoed back: error text ends up in pages */
function sceneFile(given) {
  const file = path.resolve(ROOT, String(given ?? '').replace(/^\//, ''));
  if (!file.startsWith(ROOT + path.sep) || !file.endsWith('.json') || !fs.existsSync(file))
    throw Object.assign(new Error('No JSON diorama inside the repository at that path'), { status: 404 });
  return file;
}

const clamp = (value, lo, hi, fallback) => (Number.isFinite(Number(value)) ? Math.min(hi, Math.max(lo, Number(value))) : fallback);

/* settings from a page, in bounds, so no request bakes millions of splats or draws a huge image by mistake */
function bounded(s = {}) {
  const out = { ...s };
  out.art = Math.round(clamp(s.art, 16, 1024, 128));
  out.aspect = clamp(s.aspect, 0.25, 2, 0.75);
  out.resFactor = clamp(s.resFactor, 0.25, 4, 1);
  if (s.zoom !== undefined) out.zoom = clamp(s.zoom, 0.1, 10, 1);
  if (s.res !== undefined && s.res !== 'auto' && s.res !== 'keep') out.res = clamp(s.res, 0.004, 0.5, 0.09);
  return out;
}

/* a key that changes when the scene or any mesh file it uses changes, so edited assets are not served from cache */
function stamp(file, spec) {
  const dir = path.dirname(file), files = [file];
  const walk = solid => {
    if (!solid || typeof solid !== 'object') return;
    if (solid.kind === 'mesh' && typeof solid.asset === 'string') files.push(path.resolve(dir, solid.asset));
    for (const field of ['a', 'b', 'of', 'shape']) walk(solid[field]);
  };
  (spec.solids ?? []).forEach(walk);
  return files.map(f => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)).join(',');
}

/* the diorama with the bake settings applied; view settings are not part of it */
function variantOf(base, s, span) {
  const spec = structuredClone(base);
  spec.finish = { ...spec.finish, look: { ...spec.finish?.look, pixelSize: 1 } };
  /* auto: splats `resFactor` art pixels apart (1 for the final look; 2 bakes about four times fewer splats for previews);
     zooming in draws the model larger, so the spacing shrinks with it */
  if (s.res === 'auto' || s.res === undefined) spec.finish.res = round(Math.min(0.09, (span / s.art / (s.zoom ?? 1)) * s.resFactor), 4);
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

function entryFor(file, spec, version) {
  const key = file + '\n' + version + '\n' + JSON.stringify(spec);
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
  return { entry, cached: false };
}

function spanOf(file, base, version) {
  const key = file + '\n' + version;
  if (spans.has(key)) return spans.get(key);
  const entry = Scenes.openDiorama(base, { file });
  entry.worlds = new Map();
  const world = Scenes.worldAt(entry);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0, q = 0; i < world.count; i++, q += 16) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], world.data[q + k]), hi[k] = Math.max(hi[k], world.data[q + k]);
  const span = Math.max(...hi.map((v, k) => v - lo[k])) || 6;
  spans.set(key, span);
  return span;
}

function tune({ scene, settings: given = {} }) {
  const settings = bounded(given);
  const file = sceneFile(scene), base = JSON.parse(fs.readFileSync(file, 'utf8')), version = stamp(file, base);
  const span = spanOf(file, base, version), spec = variantOf(base, settings, span);
  const started = Date.now();
  const { entry, cached } = entryFor(file, spec, version);
  const world = Scenes.worldAt(entry);
  const bakeMs = cached ? 0 : Date.now() - started;
  let total = [...CACHE.values()].reduce((sum, e) => sum + splatsIn(e), 0);
  for (const [key, old] of CACHE) {
    if (total <= SPLAT_BUDGET || old === entry) continue;
    total -= splatsIn(old);
    CACHE.delete(key);
  }
  const art = settings.art;
  const view = {};
  for (const key of ['yaw', 'pitch', 'zoom']) if (settings[key] !== undefined && Number.isFinite(Number(settings[key]))) view[key] = Number(settings[key]);
  if (settings.ortho !== undefined) view.ortho = Boolean(settings.ortho);
  const drawStarted = Date.now();
  const shot = SceneOps.renderEntry(entry, {
    size: { w: art, h: Math.round(art * settings.aspect) }, scale: 1, view,
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

function save({ scene, settings: given = {} }) {
  const settings = bounded(given);
  const file = sceneFile(scene), base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const spec = variantOf(base, settings, spanOf(file, base, stamp(file, base)));
  /* the view as tuned: turn, tilt, zoom (as a closer camera) and projection */
  const camera = { ...spec.camera };
  if (settings.yaw !== undefined) camera.yaw = Number(settings.yaw);
  if (settings.pitch !== undefined) camera.pitch = Number(settings.pitch);
  if (settings.zoom !== undefined && camera.dist) camera.dist = round(camera.dist / settings.zoom);
  if (settings.ortho !== undefined) camera.projection = settings.ortho ? 'orthographic' : 'perspective';
  spec.camera = camera;
  const out = file.replace(/\.json$/, '.tuned.json');
  fs.writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
  return { file: '/' + path.relative(ROOT, out).split(path.sep).join('/'), render: { size: { w: settings.art, h: Math.round(settings.art * settings.aspect) } } };
}

function scenes() {
  const manifest = path.join(ROOT, 'studio/out/compare-models/manifest.json');
  if (!fs.existsSync(manifest)) return [];
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).entries.map(e => ({ label: e.label, group: e.group, scene: path.posix.join(path.posix.dirname(e.baked), 'scene.json') }));
}

function setBudget(splats) {
  SPLAT_BUDGET = splats;
}

module.exports = { tune, save, scenes, setBudget };
