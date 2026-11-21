'use strict';
/* Modelling front ends other than the diorama's own solids. model_three runs a three.js script, welds and writes its
   meshes as GLB and writes a diorama with one mesh solid per part, so the usual open, render, edit and export loop
   carries on from there. */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const { compact } = require('../data.js');
const Scenes = require('../scenes.js');

const Three = () => require('../../cli/three-model.js');
const SceneOps = () => require('./scene.js');

defineOp({
  name: 'model_three',
  destructive: true,
  title: 'Model with three.js',
  effects: 'write',
  description: 'Build a model with the three.js API and turn it into a diorama. The script (.mjs or .js) exports a function ({ THREE, addon }) => Object3D; addon("geometries/RoundedBoxGeometry") imports a three.js addon. Every visible mesh becomes its own GLB under out/parts and its own mesh solid in out/scene.json (overlaps are unioned as distance fields), plus out/model.glb for the whole model. Material and vertex colours become one palette; textures, instanced and skinned meshes are not used. Returns the parts, warnings for open surfaces and a turnaround preview (also written to out/preview.png). Continue with scene_open on the returned scene path. Runs the script, so it needs code to be allowed.',
  input: {
    type: 'object', required: ['script', 'out'],
    properties: {
      script: { type: 'string', description: 'Path to the three.js script (.mjs, .js or .cjs).' },
      out: { type: 'string', description: 'Directory for scene.json, model.glb and parts/.' },
      size: { type: 'number', minimum: 0.1, maximum: 200, description: 'Largest side of the whole model in scene units (default: keep three.js units).' },
      cells: { type: 'integer', minimum: 16, maximum: 256, description: 'Distance-field cells along the whole model\'s longest side (default 96); small parts get the same cell size.' },
      hues: { type: 'integer', minimum: 1, maximum: 12, description: 'Colour families taken from the materials (default 6).' },
      shades: { type: 'integer', minimum: 2, maximum: 8, description: 'Shades per colour family (default 4).' },
      overwrite: { type: 'boolean', description: 'Replace an earlier model in out.' },
      preview: { type: 'boolean', description: 'Return a turnaround image of the scene (default true).' },
      frames: { type: 'integer', minimum: 1, maximum: 8, description: 'Preview views (default 4).' }
    },
    additionalProperties: false
  },
  async run({ script, out, size, cells, hues, shades, overwrite = false, preview = true, frames = 4 }, ctx) {
    if (!Scenes.codeAllowed(ctx))
      throw new OpError('CODE_NOT_ALLOWED', 'three.js scripts run arbitrary code and are disabled', {
        path: '/script', hint: 'start the server with --allow-code or INK_AGENT_ALLOW_CODE=1'
      });
    const root = ctx.root ?? process.cwd();
    const file = path.resolve(root, script), dir = path.resolve(root, out);
    if (!/\.(mjs|cjs|js)$/.test(file)) throw new OpError('INVALID_INPUT', 'The script must end in .mjs, .cjs or .js', { path: '/script' });
    if (!fs.existsSync(file)) throw new OpError('NOT_FOUND', 'No script at ' + file, { path: '/script' });
    let report;
    try {
      report = await Three().buildModel(file, {
        out: dir, roots: [path.dirname(file), root], size, cells, hues, shades, overwrite,
        kit: Scenes.kit().KIT, readMesh: Scenes.studio().readMesh
      });
    } catch (error) {
      if (error.code === 'THREE_MISSING')
        throw new OpError('UNSUPPORTED', 'three is not installed', { hint: 'npm install three in the project (or in ink-studio)' });
      if (error.code === 'EXISTS') throw new OpError('EXISTS', error.message, { path: '/out', hint: 'pass overwrite: true' });
      throw new OpError('BUILD_FAILED', error.message, { path: '/script', hint: error.stack?.split('\n').find(line => line.includes(file))?.trim() });
    }
    const { spec, ...summary } = report;
    const result = compact({ ...summary, next: { tool: 'scene_open', scene: { path: report.scene } } });
    if (preview) {
      const entry = Scenes.open({ path: report.scene }, { ...ctx, persist: false });
      /* written as preview.png too, because the shell transport returns no image content */
      const file = path.join(dir, 'preview.png');
      const shot = SceneOps().renderEntry(entry, { mode: frames > 1 ? 'turn' : 'single', frames, out: file, overwrite: true }, ctx);
      result.preview = file;
      result.image = shot.image;
    }
    return result;
  }
});
