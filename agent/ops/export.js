'use strict';
/* Export tools: write a scene as a GLB model or a directional sprite atlas for use outside ink-studio. */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const { compact } = require('../data.js');
const Scenes = require('../scenes.js');

const PNG = () => require('../../cli/png.js');
const Atlas = () => require('../../cli/sprite-atlas.js');
const MAPS = ['depth', 'normal', 'emission', 'silhouette'];

function destination(ctx, value, extension, pointer) {
  if (!value) throw new OpError('INVALID_INPUT', 'Give an output path', { path: pointer });
  const file = path.resolve(ctx.root ?? process.cwd(), value);
  if (extension && path.extname(file).toLowerCase() !== extension)
    throw new OpError('INVALID_INPUT', 'The output must end in ' + extension, { path: pointer });
  return file;
}

function exportGlb(entry, { out, seed, resolution, targetTriangles, textureSize = 1024, overwrite = false }, ctx) {
  const file = destination(ctx, out, '.glb', '/out');
  if (fs.existsSync(file) && !overwrite) throw new OpError('EXISTS', 'A file already exists at ' + file, { path: '/out', hint: 'pass overwrite: true' });
  const descriptor = Scenes.descriptorOf(entry);
  if (typeof descriptor.model !== 'function')
    throw new OpError('UNSUPPORTED', 'This scene exposes no rest geometry for GLB export', {
      hint: 'JSON dioramas support it; built-in demos and most script scenes do not'
    });
  let model;
  try {
    model = descriptor.model(seed ?? entry.seedOverride ?? descriptor.seed, { resolution, targetTriangles });
  } catch (error) {
    throw new OpError('EXPORT_FAILED', error.message);
  }
  try {
    const report = Scenes.studio().exportGlb(model, { out: file, textureSize });
    return compact({ format: 'glb', file: report.file, bytes: fs.statSync(report.file).size, meshes: report.meshes, joints: report.joints });
  } catch (error) {
    throw new OpError('EXPORT_FAILED', error.message);
  }
}

function exportAtlas(entry, options, ctx) {
  const { out, width = 96, height = 96, directions = 8, from = 0, to, fps = 12, maps = [], pitches, columns, overwrite = false, preview = true } = options;
  const dir = destination(ctx, out, '', '/out');
  if (fs.existsSync(path.join(dir, 'atlas.json')) && !overwrite)
    throw new OpError('EXISTS', 'An atlas already exists in ' + dir, { path: '/out', hint: 'pass overwrite: true' });
  const end = to ?? from;
  if (end < from) throw new OpError('INVALID_INPUT', 'to must not be before from', { path: '/to' });
  const frames = Math.max(1, Math.ceil((end - from) * fps - 1e-8));
  if (frames > 512) throw new OpError('INVALID_INPUT', 'An atlas holds at most 512 frames', { path: '/to' });
  const times = Array.from({ length: frames }, (_, i) => from + i / fps);
  const world = Scenes.worldAt(entry, { t: times[0] });
  let atlas;
  try {
    atlas = Atlas().spriteAtlas(world, {
      width, height, directions, columns: columns ?? directions, maps, times, fps, pitches,
      pivot: world.cam.target, yaw: world.cam.yaw, view: {}, pose: Scenes.pose
    });
  } catch (error) {
    throw new OpError('EXPORT_FAILED', error.message);
  }
  Atlas().writeAtlas(dir, atlas);
  const { metadata } = atlas;
  const result = compact({
    format: 'atlas', directory: dir, files: Object.keys(atlas.images).map(name => name + '.png').concat('atlas.json'),
    width: metadata.width, height: metadata.height, frames: metadata.frames.length, directions, cell: { width, height }
  });
  if (preview) {
    const color = atlas.images.color, rgb = new Uint8Array(metadata.width * metadata.height * 3);
    for (let i = 0, j = 0; i < color.length; i += 4, j += 3) {
      rgb[j] = color[i]; rgb[j + 1] = color[i + 1]; rgb[j + 2] = color[i + 2];
    }
    result.image = { mimeType: 'image/png', base64: PNG().encode(metadata.width, metadata.height, rgb).toString('base64') };
  }
  return result;
}

defineOp({
  name: 'scene_export',
  destructive: true,
  title: 'Export a scene',
  effects: 'write',
  description: 'Write a scene for use elsewhere. format "glb": indexed, UV-mapped geometry with materials, skins and clips (JSON dioramas). format "atlas": a directional RGBA sprite atlas (atlas.json plus PNGs) over a time range, with optional depth, normal, emission and silhouette maps; returns a colour preview image.',
  input: {
    type: 'object', required: ['scene', 'format', 'out'],
    properties: {
      scene: Scenes.sceneSchema,
      format: { type: 'string', enum: ['glb', 'atlas'] },
      out: { type: 'string', description: 'glb: a .glb file. atlas: a directory.' },
      overwrite: { type: 'boolean' },
      seed: { type: 'integer' },
      resolution: { type: 'number', minimum: 0.005, maximum: 2, description: 'glb: meshing resolution in scene units.' },
      targetTriangles: { type: 'integer', minimum: 100, maximum: 2000000, description: 'glb: triangle budget.' },
      textureSize: { type: 'integer', enum: [0, 256, 512, 1024, 2048, 4096], description: 'glb: baked texture size.' },
      width: { type: 'integer', minimum: 8, maximum: 1024, description: 'atlas: cell width.' },
      height: { type: 'integer', minimum: 8, maximum: 1024, description: 'atlas: cell height.' },
      directions: { type: 'integer', minimum: 1, maximum: 64 },
      pitches: { type: 'array', items: { type: 'number' }, maxItems: 8, description: 'atlas: camera pitches in radians.' },
      columns: { type: 'integer', minimum: 1, maximum: 256 },
      from: { type: 'number', minimum: 0 }, to: { type: 'number', minimum: 0 },
      fps: { type: 'number', minimum: 0.1, maximum: 240 },
      maps: { type: 'array', items: { type: 'string', enum: MAPS } },
      preview: { type: 'boolean', description: 'atlas: return the colour sheet as an image (default true).' }
    },
    additionalProperties: false
  },
  run({ scene, format, ...options }, ctx) {
    const entry = Scenes.open(scene, { ...ctx, persist: !!scene.handle });
    return format === 'glb' ? exportGlb(entry, options, ctx) : exportAtlas(entry, options, ctx);
  }
});
