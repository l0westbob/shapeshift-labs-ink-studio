'use strict';
/* Modelling front ends other than the diorama's own solids. Each one turns its source into triangles or voxels, and the
   shared core (cli/model-core.js) writes model.glb, raw.png, a palette role per material and a diorama, so the usual
   open, render, edit and export loop carries on from there:

     three     a three.js script (.mjs, .js, .cjs) exporting ({ THREE, addon }) => Object3D      runs code
     cadquery  a CadQuery or build123d script (.py) defining build(), result or show_object()    runs code
     blender   a Blender script (.blender.py) building objects with bpy; modifiers are applied      runs code
     vox       a voxel model (.json): plans of letters and a colour per letter                    data only
     carve     drawn views (.views.json): the sprite drawn from front, side and top, carved into voxels   data only
     compose   a composition (.compose.json): parts from different engines and dioramas, placed together
     paint     a painting (.paint.json): brush strokes, dabs and scatters in space, no mesh               data only
     openscad  an OpenSCAD file (.scad): CSG, parts named in PARTS and drawn by module part(name)    runs OpenSCAD
     sdf       distance functions as code (.sdf.mjs): fields built from library/sdf.mjs, meshed     runs code
     subd      subdivision cages (.subd.json, or .subd.mjs with cage helpers): Catmull-Clark, creases
     loft      lofted B-spline surfaces (.loft.json/.loft.mjs): sections or revolved profiles, capped
     grammar   procedural grammars (.grammar.json): L-systems painted as strokes, split grammars as boxes and roofs
     stack     sprite stacking (.stack.json): PNG slices, bottom first, every colour exact, as voxels */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const { compact } = require('../data.js');
const Scenes = require('../scenes.js');

const SceneOps = () => require('./scene.js');
const ENGINES = {
  three: { module: '../../cli/three-model.js', extensions: ['.mjs', '.js', '.cjs'], code: true, label: 'three.js scripts' },
  cadquery: { module: '../../cli/cadquery-model.js', extensions: ['.py'], code: true, label: 'CadQuery scripts' },
  blender: { module: '../../cli/blender-model.js', extensions: ['.blender.py'], code: true, label: 'Blender scripts' },
  vox: { module: '../../cli/vox-model.js', extensions: ['.vox.json', '.json'], code: false, label: 'voxel models' },
  carve: { module: '../../cli/carve-model.js', extensions: ['.views.json'], code: false, label: 'drawn views' },
  compose: { module: '../../cli/compose-model.js', extensions: ['.compose.json'], code: false, label: 'compositions' },
  paint: { module: '../../cli/paint-model.js', extensions: ['.paint.json'], code: false, label: 'paintings' },
  openscad: { module: '../../cli/openscad-model.js', extensions: ['.scad'], code: true, label: 'OpenSCAD files' },
  sdf: { module: '../../cli/sdf-model.js', extensions: ['.sdf.mjs', '.sdf.js'], code: true, label: 'SDF scripts' },
  subd: { module: '../../cli/subd-model.js', extensions: ['.subd.json', '.subd.mjs'], code: file => file.endsWith('.mjs'), label: 'subdivision cages' },
  loft: { module: '../../cli/loft-model.js', extensions: ['.loft.json', '.loft.mjs'], code: file => file.endsWith('.mjs'), label: 'lofted surfaces' },
  grammar: { module: '../../cli/grammar-model.js', extensions: ['.grammar.json'], code: false, label: 'grammars' },
  stack: { module: '../../cli/stack-model.js', extensions: ['.stack.json'], code: false, label: 'sprite stacks' }
};
/* whether building a file with an engine runs code: per engine, or per file for engines that take data or scripts */
const runsCode = (name, file) => (typeof ENGINES[name].code === 'function' ? ENGINES[name].code(file) : ENGINES[name].code);
/* the engine whose longest matching extension ends the file name, so model.views.json carves and model.json is voxels */
const matchOf = (file, name) => Math.max(0, ...ENGINES[name].extensions.filter(ext => file.toLowerCase().endsWith(ext)).map(ext => ext.length));
const engineFor = file => Object.keys(ENGINES).filter(name => matchOf(file, name)).sort((a, b) => matchOf(file, b) - matchOf(file, a))[0];

const COMMON = {
  out: { type: 'string', description: 'Directory for scene.json, model.glb, raw.png, preview.png and parts/.' },
  size: { type: 'number', minimum: 0.1, maximum: 200, description: 'Largest side of the whole model in scene units (default: keep source units).' },
  cells: { type: 'integer', minimum: 16, maximum: 256, description: 'Mesh engines: distance-field cells along the whole model\'s longest side (default 96); small parts get the same cell size.' },
  hues: { type: 'integer', minimum: 1, maximum: 12, description: 'Colour families for meshes with vertex colours (default 6).' },
  shades: { type: 'integer', minimum: 2, maximum: 8, description: 'Shades per role ramp (default 4).' },
  pixelSize: { type: 'integer', minimum: 1, maximum: 16, description: 'Screen pixels per art pixel, written to finish.look.pixelSize (default: the renderer\'s 2, so a 128 px render is a 64 px sprite; 1 draws every pixel).' },
  pixelStyle: {
    anyOf: [{ type: 'boolean' }, { type: 'object' }],
    description: 'pixelStyle for every role material (default true: { dither: "none", shadeSteps: shades }, flat shade bands without speckle; false leaves the renderer default; an object is used as given).'
  },
  snap: { type: 'integer', minimum: 8, maximum: 1024, description: 'Art pixels the longest side spans in the final sprite; positions and sizes round to whole pixels so part edges land on the pixel grid (mesh engines and voxels).' },
  overwrite: { type: 'boolean', description: 'Replace an earlier model in out.' },
  preview: { type: 'boolean', description: 'Return a turnaround image of the baked scene (default true).' },
  frames: { type: 'integer', minimum: 1, maximum: 8, description: 'Preview views (default 4).' }
};

async function build(engine, { source, out, size, cells, hues, shades, pixelSize, pixelStyle, tolerance, snap, overwrite = false, preview = true, frames = 4 }, ctx, field) {
  const spec = ENGINES[engine];
  if (runsCode(engine, source) && !Scenes.codeAllowed(ctx))
    throw new OpError('CODE_NOT_ALLOWED', spec.label + ' run arbitrary code and are disabled', {
      path: '/' + field, hint: 'start the server with --allow-code or INK_AGENT_ALLOW_CODE=1 (voxel models need no code)'
    });
  const root = ctx.root ?? process.cwd();
  const file = path.resolve(root, source), dir = path.resolve(root, out);
  if (!matchOf(file, engine))
    throw new OpError('INVALID_INPUT', spec.label + ' end in ' + spec.extensions.join(', '), { path: '/' + field });
  if (!fs.existsSync(file)) throw new OpError('NOT_FOUND', 'No file at ' + file, { path: '/' + field });
  /* a composition builds each of its parts with that part's engine; code engines still need code to be allowed */
  const buildPart = async (partFile, partEngine, partOut, options) => {
    const name = partEngine ?? engineFor(partFile);
    if (!name || !ENGINES[name] || name === 'compose') throw new Error('Cannot tell the engine of ' + path.basename(partFile));
    if (runsCode(name, partFile) && !Scenes.codeAllowed(ctx))
      throw Object.assign(new Error(path.basename(partFile) + ' is a ' + ENGINES[name].label.replace(/s$/, '') + ', which runs code'), { code: 'CODE_NOT_ALLOWED' });
    return require(ENGINES[name].module).buildModel(partFile, {
      roots: [path.dirname(partFile), root], kit: Scenes.kit().KIT, readMesh: Scenes.studio().readMesh, out: partOut, ...options
    });
  };
  let report;
  try {
    report = await require(spec.module).buildModel(file, {
      out: dir, roots: [path.dirname(file), root], size, cells, hues, shades, pixelSize, pixelStyle, tolerance, snap, overwrite,
      kit: Scenes.kit().KIT, readMesh: Scenes.studio().readMesh, buildPart
    });
  } catch (error) {
    if (error.code === 'THREE_MISSING')
      throw new OpError('UNSUPPORTED', 'three is not installed', { hint: 'npm install three in the project (or in ink-studio)' });
    if (error.code === 'OPENSCAD_MISSING')
      throw new OpError('UNSUPPORTED', error.message, { hint: 'install OpenSCAD (openscad on the PATH, or set INK_OPENSCAD)' });
    if (error.code === 'BLENDER_MISSING')
      throw new OpError('UNSUPPORTED', error.message, { hint: 'install Blender (blender on the PATH, or set INK_BLENDER)' });
    if (error.code === 'PYTHON_MISSING' || error.code === 'CADQUERY_MISSING')
      throw new OpError('UNSUPPORTED', error.message, {
        hint: 'uv venv --python 3.12 .venv && uv pip install --python .venv -r requirements-modelling.txt (or set INK_PYTHON)'
      });
    if (error.code === 'EXISTS') throw new OpError('EXISTS', error.message, { path: '/out', hint: 'pass overwrite: true' });
    if (error.code === 'CODE_NOT_ALLOWED')
      throw new OpError('CODE_NOT_ALLOWED', error.message, { path: '/' + field, hint: 'start the server with --allow-code or INK_AGENT_ALLOW_CODE=1' });
    throw new OpError('BUILD_FAILED', error.message, {
      path: '/' + field, hint: error.where ?? error.stack?.split('\n').find(line => line.includes(file))?.trim()
    });
  }
  const { spec: diorama, ...summary } = report;
  const result = compact({ engine, ...summary, next: { tool: 'scene_open', scene: { path: report.scene } } });
  if (preview) {
    const entry = Scenes.open({ path: report.scene }, { ...ctx, persist: false });
    /* written as preview.png too, because the shell transport returns no image content */
    const shotFile = path.join(dir, 'preview.png');
    const shot = SceneOps().renderEntry(entry, {
      mode: frames > 1 ? 'turn' : 'single', frames, size: { w: 256, h: 256 }, scale: frames > 2 ? 2 : 3, out: shotFile, overwrite: true
    }, ctx);
    result.preview = shotFile;
    result.image = shot.image;
  }
  return result;
}

const RESULT = 'Writes out/model.glb (the extracted model, the same hand-off for every engine), out/raw.png (that model before baking, flat-shaded from the front and the back), out/scene.json (a diorama with a palette role per material: material.userData.role or name in three.js, metadata role or colour in CadQuery, the colour entry in voxels) and a turnaround preview of the baked scene (also out/preview.png). Continue with scene_open on the returned scene path.';

defineOp({
  name: 'model_build',
  destructive: true,
  title: 'Build a model with another modeller',
  effects: 'write',
  description: 'Build a model outside the diorama format and turn it into a diorama. engine "three": a three.js script (.mjs/.js/.cjs) exporting ({ THREE, addon }) => Object3D, good for quick low-poly hard surfaces. engine "cadquery": a CadQuery or build123d script (.py, Z up, run in .venv) defining build() or result (an Assembly with names, colours and metadata={"role": ...} keeps them), good for precise parts with fillets, chamfers, lofts and cut details. engine "blender": a Blender script (.blender.py, Z up, headless, empty scene) building objects with bpy; modifiers (bevel, subdivision, mirror, array, boolean) are applied, parts split per object and material, role from the "role" property or name of the material, base colour from its Principled BSDF; good for smooth organic forms and bevelled hard surfaces. engine "openscad" (.scad, Z up): CSG; name parts with PARTS = [["hull", "#5b6b2e", "olive"], ...] and module part(name), else the whole file is one part. engine "sdf" (.sdf.mjs): signed distance functions as code, export ({ sdf }) => ({ parts: [{ name, colour, role, field: p => distance, bounds: [[x0,y0,z0],[x1,y1,z1]] }] }) with sdf = primitives, smooth unions, repeats, twists and noise from library/sdf.mjs; each field is meshed inside its bounds. engine "subd" (.subd.json, or .subd.mjs exporting ({ cage }) => ({ cages })): { cages: [{ name, colour, role, levels, vertices, faces (quads, counter-clockwise from outside), creases: [[a, b]] }] } smoothed by Catmull-Clark subdivision, creased edges stay sharp; good for characters and soft organic forms. engine "loft" (.loft.json/.loft.mjs): { parts: [{ name, colour, role, axis, sections: [{ at, points | ellipse: [h, w] | rect: [h, w], round, centre }] } | { revolve: [[radius, position]], axis, at }] } as capped cubic B-spline surfaces through the sections; good for hulls, bodies, fuselages, barrels. engine "grammar" (.grammar.json): kind "lsystem" { axiom, rules (string or [[string, weight]]), iterations, angle, step, width, shrink, colours, leaf } drawn by a 3D turtle (F f + - & ^ backslash / | [ ] L) and painted as strokes, for plants; kind "split" { axiom, size, colours, rules: { name: op | [ops] } } with split (axis, sizes with "~" shares, into), repeat (axis, size, into), inset (with face and depth for a slab), box (colour) and roof (gable or hip, overhang), for buildings. engine "stack" (.stack.json): sprite stacking, { slices: sheet.png with slice: [w, h] | [files], cell, background, roles } horizontal PNG slices bottom first, every pixel colour kept exact as a voxel letter and role. engine "vox": a voxel JSON { cell, hard, colours: { letter: "#rrggbb" | { colour, role } }, layers | front: [plans of letters] }, good for small props and characters at sprite size; it needs no code. engine "carve" (.views.json): pixel first, draw the model as orthographic views { cell, colours, views: { front, right, top, (back, left, bottom): [rows of letters] } } the way the sprite should read; blocks stay where every view sees something and take the colours the views show, then it continues as voxels (writes carved.vox.json to refine and views.png). engine "compose" (.compose.json): { parts: [{ source: file (built with its engine) | diorama: scene.json, at, yaw, scale, size }], camera?, light?, style? } merges parts from different engines into one diorama, the best tool for each part (palettes and roles merged, assets kept); it writes scene.json only (no model.glb). engine "paint" (.paint.json): { colours, blend, strokes: [{ colour, points, width, taper, pressure } | { colour, dab: [x,y,z], r } | { colour, scatter: { around, radius, count, size: [min, max], seed, flatten } }] } paints a model with splat brush strokes in space, for painterly trees, bushes, smoke or creatures; strokes of one colour melt together; scene.json only. The engine follows from the file extension unless given. Mesh engines make one mesh solid per part (overlaps are unioned as distance fields); voxels make one vox solid. ' + RESULT + ' three and cadquery run code, so they need code to be allowed.',
  input: {
    type: 'object', required: ['source', 'out'],
    properties: {
      source: { type: 'string', description: 'The model source: a three.js script, a CadQuery/build123d .py script or a voxel .json file.' },
      engine: { type: 'string', enum: Object.keys(ENGINES), description: Object.keys(ENGINES).join(', ') + ' (default: from the file extension, longest match first).' },
      tolerance: { type: 'number', minimum: 0.0001, maximum: 0.05, description: 'cadquery: largest triangle chord error as a share of the model size (default 0.0015).' },
      ...COMMON
    },
    additionalProperties: false
  },
  async run(args, ctx) {
    const engine = args.engine ?? engineFor(args.source);
    if (!engine) throw new OpError('INVALID_INPUT', 'Cannot tell the engine from ' + path.basename(args.source), {
      path: '/engine', hint: 'pass engine: ' + Object.keys(ENGINES).join(', ') + ' (or use .mjs, .py, .json)'
    });
    return build(engine, args, ctx, 'source');
  }
});

defineOp({
  name: 'model_three',
  destructive: true,
  title: 'Model with three.js',
  effects: 'write',
  description: 'model_build with engine "three". The script (.mjs or .js) exports a function ({ THREE, addon }) => Object3D; addon("geometries/RoundedBoxGeometry") imports a three.js addon. Every visible mesh becomes its own GLB under out/parts and its own mesh solid (overlaps are unioned as distance fields). Each material becomes a palette role (material.userData.role, else material.name, else its colour); meshes with vertex colours get automatic colour families; a directional light becomes the sun. Textures, instanced and skinned meshes are not used. ' + RESULT + ' Runs the script, so it needs code to be allowed.',
  input: {
    type: 'object', required: ['script', 'out'],
    properties: { script: { type: 'string', description: 'Path to the three.js script (.mjs, .js or .cjs).' }, ...COMMON },
    additionalProperties: false
  },
  async run({ script, ...args }, ctx) {
    return build('three', { source: script, ...args }, ctx, 'script');
  }
});
