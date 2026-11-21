const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const Scenes = require('../agent/scenes.js');
const { pythonFor } = require('../cli/cadquery-model.js');

const hasCadquery = (() => {
  try {
    execFileSync(pythonFor([root]), ['-c', 'import cadquery'], { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
})();
const noCadquery = hasCadquery ? false : 'cadquery is not installed (see requirements-modelling.txt)';

const call = (args, ctx = { allowCode: true }) => registry.call('model_build', args, { root, ...ctx });
const ok = outcome => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  return outcome.result;
};
const fails = (outcome, code) => {
  assert.equal(outcome.ok, false, 'expected ' + code);
  assert.equal(outcome.error.code, code, JSON.stringify(outcome.error));
  return outcome.error;
};
const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-build-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
};
const validate = async file => ok(await registry.call('scene_validate', { scene: { path: file } }, { root }));

test('model_build picks the engine from the extension and refuses unknown ones', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'model.stl'), 'solid x\nendsolid x\n');
  fails(await call({ source: path.join(dir, 'model.stl'), out: dir }), 'INVALID_INPUT');
  fails(await call({ source: 'examples/three/tank.mjs', engine: 'cadquery', out: dir }), 'INVALID_INPUT');
  fails(await call({ source: 'examples/cadquery/tank.py', out: dir }, {}), 'CODE_NOT_ALLOWED');
});

test('model_build turns a voxel model into a vox solid with a role per colour, without running code', async t => {
  const dir = tempDir(t), source = path.join(dir, 'crate.json'), out = path.join(dir, 'crate');
  fs.writeFileSync(source, JSON.stringify({
    cell: 0.5,
    colours: { w: { colour: '#8a5a2b', role: 'wood' }, m: '#777b72', n: '#777b72' },
    layers: ['wwww/wwww/wwww', ['wmmw/w..w/wnnw', 2], 'wwww/wwww/wwww']
  }));
  const result = ok(await call({ source, out, size: 2, pixelSize: 1, preview: false }, {}));
  assert.equal(result.engine, 'vox');
  assert.deepEqual(result.grid, [4, 4, 3]);
  assert.equal(result.blocks, 4 * 3 * 2 + 2 * 10);
  assert.deepEqual(result.roles, ['wood', 'paint-777b72'], 'letters of one colour share a role');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.equal(spec.solids.length, 1);
  const [solid] = spec.solids;
  assert.equal(solid.kind, 'vox');
  assert.equal(solid.cell, 0.5, 'four blocks of 0.5 are the 2 units asked for');
  assert.deepEqual(solid.key.w, { role: 'wood', pixelStyle: { dither: 'none', shadeSteps: 4 } });
  assert.equal((await validate(result.scene)).valid, true);

  /* the hand-off mesh: only visible faces, readable like any other model.glb */
  const mesh = Scenes.studio().readMesh(result.model);
  assert.ok(mesh.tri.length / 3 > 0 && mesh.tri.length / 3 < result.blocks * 12);
  assert.ok(fs.existsSync(result.raw));
  const rendered = ok(await registry.call('scene_render', { scene: { path: result.scene }, size: { w: 64, h: 64 } }, { root }));
  assert.ok(rendered.artWidth > 0);

  fs.writeFileSync(source, JSON.stringify({ colours: { w: '#8a5a2b' }, layers: ['wx'] }));
  const error = fails(await call({ source, out, overwrite: true, preview: false }, {}), 'BUILD_FAILED');
  assert.match(error.message, /'x' is not in the model's key/);
});

test('a vox solid in a diorama is validated letter by letter', async () => {
  const spec = {
    id: 'vox-check', style: 'slate', camera: { target: [0, 0, 0], dist: 3 },
    solids: [{ kind: 'vox', at: [0, 0, 0], key: { s: 'stoen', '..': 'wood' }, layers: ['sq'], front: ['s'] }]
  };
  const { valid, errors } = ok(await registry.call('scene_validate', { scene: { spec } }, { root }));
  assert.equal(valid, false);
  const problems = errors.map(e => e.path + ': ' + e.problem).join('\n');
  assert.match(problems, /exactly one of layers .* or front/);
  assert.match(problems, /key\.s: no role called "stoen"/);
  assert.match(problems, /key\.\.\.: a key is one letter/);
  assert.equal(errors.find(e => e.path === 'solids[0].key.s').hint, 'did you mean "stone"?');
});

test('model_build runs a CadQuery assembly: names, colours, roles, Z up to Y up, closed parts', { skip: noCadquery, timeout: 240000 }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'post.py'), out = path.join(dir, 'post');
  fs.writeFileSync(script, `import cadquery as cq
def build():
    assy = cq.Assembly()
    assy.add(cq.Workplane().box(1, 1, 0.2).edges("|Z").fillet(0.1), name="base", color=cq.Color("#3f4a22"), metadata={"role": "paint"})
    assy.add(cq.Workplane().circle(0.1).extrude(2), name="pole", color=cq.Color("#777b72"), loc=cq.Location((0, 0, 0.1)))
    return assy
`);
  const result = ok(await call({ source: script, out, preview: false }));
  assert.equal(result.engine, 'cadquery');
  assert.deepEqual(result.parts.map(part => [part.name, part.role]), [['base', 'paint'], ['pole', 'paint-777b72']]);
  assert.ok(result.parts.every(part => part.open < 0.02), 'tessellated solids are closed after welding');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  /* the 2.2 tall assembly (Z up in CAD) stands 2.2 tall along Y */
  const pole = spec.solids[1];
  assert.equal(pole.at[1], 0.2);
  assert.ok(Math.abs(pole.size - 2) < 0.01);
  assert.equal((await validate(result.scene)).valid, true);

  fs.writeFileSync(script, 'import cadquery as cq\nresult = cq.Workplane().box(1, 1, 1).edges().fillet(2)\n');
  const error = fails(await call({ source: script, out, overwrite: true, preview: false }), 'BUILD_FAILED');
  assert.match(error.hint, /post\.py", line 2/);
});

test('model_build carves drawn views into voxels: visual hull, colours from the views, unseen sides mirrored', async t => {
  const dir = tempDir(t), source = path.join(dir, 'hut.views.json'), out = path.join(dir, 'hut');
  const views = {
    front: ['.rr.', 'rrrr', 'wdgw', 'wdww'],
    right: ['.rr.', 'rrrr', 'wwww', 'wwww'],
    top: ['rrrr', 'rrrr', 'rrrr', 'rrrr']
  };
  fs.writeFileSync(source, JSON.stringify({ cell: 0.5, colours: { w: '#c8b88a', r: { colour: '#8a3324', role: 'roof' }, d: '#5a3a20', g: '#9fc3d6' }, views }));
  const result = ok(await call({ source, out, preview: false }, {}));
  assert.equal(result.engine, 'carve');
  assert.deepEqual(result.grid, [4, 4, 4]);
  /* walls: 4 x 4 x 2 layers; roof: the full slab, then where both gables meet, the middle 2 x 2 */
  assert.equal(result.blocks, 32 + 16 + 4);
  const vox = JSON.parse(fs.readFileSync(result.carved, 'utf8'));
  const at = (x, y, z) => vox.layers[y].split('/')[z][x];
  assert.equal(at(1, 0, 3), 'd', 'the front shows the door');
  assert.equal(at(1, 0, 0), 'd', 'the back, which no view sees, is painted like the front');
  assert.equal(at(1, 3, 1), 'r');
  assert.ok(fs.existsSync(result.views));
  assert.equal((await validate(result.scene)).valid, true);

  fs.writeFileSync(source, JSON.stringify({ colours: { w: '#ffffff' }, views: { front: ['ww', 'ww'], right: ['www', 'www', 'www'], top: ['ww', 'ww'] } }));
  const error = fails(await call({ source, out, overwrite: true, preview: false }, {}), 'BUILD_FAILED');
  assert.match(error.message, /disagree on the size along y/);
});

const hasBlender = (() => {
  try {
    execFileSync(require('../cli/blender-model.js').blenderBinary(), ['--version'], { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
})();

test('model_build runs a Blender script: modifiers applied, parts per material, Z up to Y up, sun lamp', { skip: hasBlender ? false : 'Blender is not installed', timeout: 240000 }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'post.blender.py'), out = path.join(dir, 'post');
  fs.writeFileSync(script, `import bpy, math
def mat(name, rgb, role=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*rgb, 1)
    if role: m["role"] = role
    return m
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.1))
base = bpy.context.object
base.name = "base"
base.scale = (1, 1, 0.2)
base.data.materials.append(mat("paint", (0.1, 0.2, 0.05), "olive"))
base.modifiers.new("bevel", "BEVEL").width = 0.05
bpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=2, location=(0, 0, 1.2))
pole = bpy.context.object
pole.name = "pole"
pole.data.materials.append(mat("metal", (0.5, 0.5, 0.5)))
bpy.ops.object.light_add(type="SUN")
`);
  const result = ok(await call({ source: script, out, preview: false }));
  assert.equal(result.engine, 'blender');
  assert.deepEqual(result.parts.map(part => [part.name, part.role]), [['base', 'olive'], ['pole', 'metal']]);
  assert.ok(result.parts.every(part => part.open === 0));
  assert.ok(result.parts[0].triangles > 12, 'the bevel modifier was applied');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.ok(Math.abs(spec.solids[1].size - 2) < 0.01 && Math.abs(spec.solids[1].at[1] - 0.2) < 0.01, 'the pole stands 2 tall on the base');
  assert.deepEqual(spec.light, { sun: [0, 1, 0] });
  assert.equal((await validate(result.scene)).valid, true);

  fs.writeFileSync(script, 'import bpy\nbpy.ops.mesh.primitive_cube_add()\nraise ValueError("no turret today")\n');
  const error = fails(await call({ source: script, out, overwrite: true, preview: false }), 'BUILD_FAILED');
  assert.match(error.message, /no turret today/);
  assert.match(error.hint, /post\.blender\.py", line 3/);
});

test('model_build composes parts from different engines into one diorama, merging palettes and roles', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'crate.vox.json'), JSON.stringify({ cell: 0.5, colours: { w: { colour: '#8a5a2b', role: 'wood' } }, layers: ['ww/ww', 'ww/ww'] }));
  fs.writeFileSync(path.join(dir, 'rock.json'), JSON.stringify({
    id: 'rock', style: 'slate', camera: { target: [0, 0, 0], dist: 3 },
    solids: [{ kind: 'ball', at: [0, 0.3, 0], r: 0.3, mat: 'stone' }, { kind: 'box', at: [0, 0.1, 0], half: [0.2, 0.1, 0.2], mat: { ramp: [3, 4, 5] } }]
  }));
  fs.writeFileSync(path.join(dir, 'pile.compose.json'), JSON.stringify({
    parts: [{ source: 'crate.vox.json', size: 1 }, { diorama: 'rock.json', at: [1.2, 0, 0], yaw: 0.5, scale: 2 }]
  }));
  const result = ok(await call({ source: path.join(dir, 'pile.compose.json'), out: path.join(dir, 'pile'), preview: false }, {}));
  assert.equal(result.engine, 'compose');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.deepEqual(spec.solids.map(s => s.kind), ['vox', 'ball', 'box']);
  assert.deepEqual(spec.solids[1].transform, { translation: [1.2, 0, 0], rotation: [0.5, 0, 0], scale: 2, pivot: [0, 0, 0] });
  assert.equal(spec.palette[0], 0x0b0d10, 'the first part keeps the background');
  const slate = Scenes.kit().KIT.diorama.styles.slate;
  assert.deepEqual(spec.roles.stone.map(i => spec.palette[i]), slate.roles.stone.map(i => slate.palette[i]), 'a style role keeps its colours');
  assert.deepEqual(spec.solids[2].mat.ramp.map(i => spec.palette[i]), [3, 4, 5].map(i => slate.palette[i]), 'raw ramps are remapped');
  assert.equal((await validate(result.scene)).valid, true);
  for (const style of ['slate', 'ember'])
    assert.equal(ok(await registry.call('scene_validate', { scene: { spec: { ...spec, style } } }, { root: path.join(dir, 'pile') })).valid, true);

  fs.writeFileSync(path.join(dir, 'pile.compose.json'), JSON.stringify({ parts: [{ source: path.join(root, 'examples/three/tank.mjs') }] }));
  fails(await call({ source: path.join(dir, 'pile.compose.json'), out: path.join(dir, 'pile'), overwrite: true, preview: false }, {}), 'CODE_NOT_ALLOWED');
});

test('model_check measures a model against a spec sheet and says how to scale what is off', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'post.vox.json'), JSON.stringify({
    cell: 0.5, colours: { b: { colour: '#3f4a22', role: 'base' }, p: { colour: '#777b72', role: 'pole' } },
    layers: ['bbbb/bbbb', '..../.p..', '..../.p..', '..../.p..']
  }));
  ok(await call({ source: path.join(dir, 'post.vox.json'), out: path.join(dir, 'post'), preview: false }, {}));
  const result = ok(await registry.call('model_check', {
    dir: path.join(dir, 'post'),
    spec: { size: { x: [1.8, 2.2], y: [3, 4] }, parts: { base: { x: [1.9, 2.1] }, 'po*': { y: [1, 2] } }, ratios: [{ a: 'pole.y', b: 'base.x', range: [0.7, 0.8] }] }
  }, { root }));
  const by = Object.fromEntries(result.checks.map(c => [c.what, c]));
  assert.equal(by['size.x'].pass, true);
  assert.equal(by['size.y'].pass, false);
  assert.ok(Math.abs(by['size.y'].scale - 3 / by['size.y'].value) < 0.01, 'scale says how far to grow');
  assert.equal(by['base.x'].pass, true);
  assert.equal(by['po*.y'].pass, true);
  assert.equal(by['pole.y / base.x'].pass, true);
  assert.equal(result.pass, false);
});

test('snap rounds voxel cells and mesh placements to whole art pixels', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'bar.vox.json'), JSON.stringify({ cell: 0.1, colours: { o: '#5b6b2e' }, layers: ['ooooooo'] }));
  const result = ok(await call({ source: path.join(dir, 'bar.vox.json'), out: path.join(dir, 'bar'), size: 1, snap: 20, preview: false }, {}));
  const cell = JSON.parse(fs.readFileSync(result.scene, 'utf8')).solids[0].cell;
  const unit = 1 / 20;
  assert.ok(Math.abs(cell / unit - Math.round(cell / unit)) < 1e-6 && cell >= unit, 'cell ' + cell + ' is whole pixels of ' + unit);
});

test('model_build paints with strokes, dabs and scatters; one blend group per colour', async t => {
  const dir = tempDir(t), source = path.join(dir, 'bush.paint.json');
  fs.writeFileSync(source, JSON.stringify({
    colours: { stem: '#5a3a20', leaf: { colour: '#4f7a2a', role: 'foliage' } }, blend: 0.05,
    strokes: [
      { colour: 'stem', points: [[0, 0, 0], [0, 0.5, 0]], width: 0.1, taper: [1, 0.5] },
      { colour: 'leaf', dab: [0, 0.7, 0], r: [0.4, 0.3, 0.4] },
      { colour: 'leaf', scatter: { around: [0, 0.8, 0], radius: 0.3, count: 5, size: [0.05, 0.1], seed: 2 } }
    ]
  }));
  const result = ok(await call({ source, out: path.join(dir, 'bush'), preview: false }, {}));
  assert.equal(result.engine, 'paint');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.deepEqual(spec.solids.map(s => s.kind), ['stroke', 'ball', 'ball', 'ball', 'ball', 'ball', 'ball']);
  assert.deepEqual(Object.keys(spec.groups).sort(), ['paint-foliage', 'paint-stem']);
  assert.equal(spec.solids[1].group, 'paint-foliage');
  assert.deepEqual(result.roles, ['stem', 'foliage']);
  assert.equal((await validate(result.scene)).valid, true);
  const again = ok(await call({ source, out: path.join(dir, 'bush'), overwrite: true, preview: false }, {}));
  assert.deepEqual(JSON.parse(fs.readFileSync(again.scene, 'utf8')).solids, spec.solids, 'scatters follow their seed');

  fs.writeFileSync(source, JSON.stringify({ colours: { stem: '#5a3a20' }, strokes: [{ colour: 'bark', dab: [0, 0, 0] }] }));
  const error = fails(await call({ source, out: path.join(dir, 'bush'), overwrite: true, preview: false }, {}), 'BUILD_FAILED');
  assert.match(error.message, /No colour called "bark"/);
});

const hasOpenscad = (() => {
  try {
    execFileSync(require('../cli/openscad-model.js').openscadBinary(), ['--version'], { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
})();

test('model_build renders OpenSCAD parts named in PARTS, or the whole file as one part', { skip: hasOpenscad ? false : 'OpenSCAD is not installed', timeout: 240000 }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'post.scad'), out = path.join(dir, 'post');
  fs.writeFileSync(script, `PARTS = [["base", "#3f4a22", "paint"], ["pole", "#777b72"]];
module part(name) {
  if (name == "base") translate([0, 0, 0.1]) cube([1, 1, 0.2], center = true);
  if (name == "pole") translate([0, 0, 0.2]) cylinder(r = 0.1, h = 2, $fn = 16);
}
if (is_undef(INK)) for (p = PARTS) color(p[1]) part(p[0]);
`);
  const result = ok(await call({ source: script, out, preview: false }));
  assert.equal(result.engine, 'openscad');
  assert.deepEqual(result.parts.map(p => [p.name, p.role]), [['base', 'paint'], ['pole', 'paint-777b72']]);
  assert.ok(result.parts.every(p => p.open === 0));
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.ok(Math.abs(spec.solids[1].size - 2) < 0.01 && Math.abs(spec.solids[1].at[1] - 0.2) < 0.01, 'the pole stands on the base, Z up to Y up');

  fs.writeFileSync(script, 'difference() { cube(2, center = true); sphere(1.3, $fn = 24); }\n');
  const single = ok(await call({ source: script, out, overwrite: true, preview: false }));
  assert.deepEqual(single.parts.map(p => p.name), ['post']);

  fs.writeFileSync(script, 'cube(1);\nfoo(;\n');
  const error = fails(await call({ source: script, out, overwrite: true, preview: false }), 'BUILD_FAILED');
  assert.match(error.message + ' ' + (error.hint ?? ''), /line 2/);
});

test('model_build meshes signed distance functions written as code', async t => {
  const dir = tempDir(t), script = path.join(dir, 'blob.sdf.mjs'), out = path.join(dir, 'blob');
  fs.writeFileSync(script, `export default ({ sdf }) => ({ parts: [
  { name: 'body', colour: '#5b6b2e', role: 'olive', field: sdf.smoothUnion(0.2, sdf.sphere(0.6), sdf.move(sdf.box([0.4, 0.2, 0.4]), [0, 0.6, 0])), bounds: [[-1, -1, -1], [1, 1.2, 1]] },
  { name: 'ring', colour: '#777b72', field: sdf.move(sdf.torus(0.7, 0.08), [0, 0.1, 0]), bounds: [[-1, -0.2, -1], [1, 0.4, 1]] }
] });
`);
  const result = ok(await call({ source: script, out, cells: 48, preview: false }));
  assert.equal(result.engine, 'sdf');
  assert.deepEqual(result.parts.map(p => [p.name, p.role]), [['body', 'olive'], ['ring', 'paint-777b72']]);
  assert.ok(result.parts.every(p => p.open < 0.02), 'meshed fields are closed');
  assert.equal((await validate(result.scene)).valid, true);

  fs.writeFileSync(script, 'export default ({ sdf }) => ({ parts: [{ name: "x", field: sdf.sphere(1) }] });\n');
  fs.utimesSync(script, new Date(), new Date(Date.now() + 2000));
  const error = fails(await call({ source: script, out, overwrite: true, preview: false }), 'BUILD_FAILED');
  assert.match(error.message, /needs bounds/);
});

test('Catmull-Clark subdivision: counts, smoothing, creases and the subd engine', async t => {
  const { subdivide, cage } = require('../cli/subd-model.js');
  const cube = cage.box([0, 0, 0], [1, 1, 1]);
  const once = subdivide(cube);
  assert.equal(once.vertices.length, 8 + 12 + 6);
  assert.equal(once.faces.length, 24);
  const radius = mesh => Math.max(...mesh.vertices.map(p => Math.hypot(...p)));
  assert.ok(radius(once) < Math.sqrt(3) - 0.1, 'smooth corners pull in');
  const sharp = subdivide({ ...cube, creases: [[0, 1], [0, 2], [0, 4]] });
  /* vertex points follow the 12 edge points, so corner 0 lands at index 12 */
  assert.deepEqual(sharp.vertices[12], [-1, -1, -1], 'a corner with three creased edges stays put');
  assert.notDeepEqual(once.vertices[12], [-1, -1, -1]);

  const dir = tempDir(t), source = path.join(dir, 'pebble.subd.json');
  fs.writeFileSync(source, JSON.stringify({ cages: [{ name: 'pebble', colour: '#777b72', levels: 2, ...cage.box([0, 0.5, 0], [1, 0.5, 0.7]) }] }));
  const result = ok(await call({ source, out: path.join(dir, 'pebble'), preview: false }, {}));
  assert.equal(result.engine, 'subd');
  assert.equal(result.parts[0].open, 0);
  assert.equal(result.parts[0].triangles, 6 * 16 * 2);
  fs.writeFileSync(path.join(dir, 'pebble.subd.mjs'), 'export default ({ cage }) => ({ cages: [cage.box()] });\n');
  fails(await call({ source: path.join(dir, 'pebble.subd.mjs'), out: path.join(dir, 'p2') }, {}), 'CODE_NOT_ALLOWED');
});

test('the loft engine skins sections and revolves profiles into closed surfaces', async t => {
  const dir = tempDir(t), source = path.join(dir, 'boat.loft.json');
  fs.writeFileSync(source, JSON.stringify({ parts: [
    { name: 'hull', colour: '#8a5a2b', role: 'wood', axis: 'x', around: 24, along: 20,
      sections: [{ at: -1, ellipse: [0.2, 0.3] }, { at: 0, rect: [0.6, 0.8], round: 0.15, centre: [0.1, 0] }, { at: 1, ellipse: [0.15, 0.1] }] },
    { name: 'mast', colour: '#5a3a20', axis: 'y', at: [0, 0, 0], revolve: [[0.05, 0.3], [0.05, 1.6]] }
  ] }));
  const result = ok(await call({ source, out: path.join(dir, 'boat'), preview: false }, {}));
  assert.equal(result.engine, 'loft');
  assert.ok(result.parts.every(p => p.open === 0), 'capped surfaces are closed');
  const bounds = JSON.parse(fs.readFileSync(path.join(dir, 'boat', 'model.json'), 'utf8')).parts;
  const hull = bounds.find(p => p.name === 'hull');
  assert.ok(Math.abs(hull.hi[0] - hull.lo[0] - 2) < 0.01, 'clamped ends reach the first and last section');
  assert.equal((await validate(result.scene)).valid, true);
});

test('grammars: an L-system grows a painted plant, a split grammar builds boxes and roofs', async t => {
  const { expand, turtle, derive } = require('../cli/grammar-model.js');
  assert.equal(expand({ axiom: 'A', rules: { A: 'AB', B: 'A' }, iterations: 4 }), 'ABAABABA');
  const { branches, leaves } = turtle('F[+F]F[-FL]', { angle: 90, step: 1 });
  assert.equal(branches.length, 3);
  assert.equal(leaves.length, 1);
  assert.deepEqual(branches[0].points.at(-1).map(v => Math.round(v * 1e6) / 1e6), [0, 2, 0], 'the trunk keeps going after the side branch');

  const terminals = derive({
    axiom: 'Lot', size: [6, 4, 4], colours: {},
    rules: { Lot: { split: 'y', sizes: [3, '~'], into: ['Walls', 'Roof'] }, Walls: { repeat: 'x', size: 2, into: 'Bay' }, Bay: { box: 'wall' }, Roof: { roof: 'gable', colour: 'roof' } }
  });
  assert.deepEqual(terminals.map(t => t.kind), ['box', 'box', 'box', 'gable']);
  assert.deepEqual(terminals[3].lo, [-3, 3, -2]);

  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'hut.grammar.json'), JSON.stringify({
    kind: 'split', axiom: 'Lot', size: [4, 3, 3], colours: { wall: '#c8b88a', roof: { colour: '#8a3324', role: 'roof' } },
    rules: { Lot: { split: 'y', sizes: [2, '~'], into: ['Wall', 'Roof'] }, Wall: { box: 'wall' }, Roof: { roof: 'hip', colour: 'roof', overhang: 0.2 } }
  }));
  const hut = ok(await call({ source: path.join(dir, 'hut.grammar.json'), out: path.join(dir, 'hut'), preview: false }, {}));
  assert.equal(hut.engine, 'grammar');
  const spec = JSON.parse(fs.readFileSync(hut.scene, 'utf8'));
  assert.deepEqual(spec.solids.map(s => s.kind), ['box', 'mesh'], 'boxes are native, roofs are meshes');
  assert.ok(hut.parts.every(p => p.open === 0));
  assert.equal((await validate(hut.scene)).valid, true);

  fs.writeFileSync(path.join(dir, 'weed.grammar.json'), JSON.stringify({
    kind: 'lsystem', axiom: 'A', iterations: 2, angle: 30, step: 0.3, width: 0.06, rules: { A: 'F[+AL][-AL]' },
    colours: { stem: '#4f7a2a', bud: '#e8b4c0' }, leaf: { colour: 'bud', size: 0.05 }
  }));
  const weed = ok(await call({ source: path.join(dir, 'weed.grammar.json'), out: path.join(dir, 'weed'), preview: false }, {}));
  const weedSpec = JSON.parse(fs.readFileSync(weed.scene, 'utf8'));
  assert.ok(weedSpec.solids.some(s => s.kind === 'stroke') && weedSpec.solids.some(s => s.kind === 'ball'));
});

test('sprite stacking turns PNG slices into voxels with exact colours', async t => {
  const dir = tempDir(t), png = require('../cli/png.js');
  /* two 3 x 2 slices side by side: a full slab, then a single block on top in another colour */
  const w = 6, h = 2, rgb = new Uint8Array(w * h * 3), alpha = new Uint8Array(w * h);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) rgb.set([0x5b, 0x6b, 0x2e], (y * w + x) * 3), (alpha[y * w + x] = 255);
  rgb.set([0xe8, 0xe4, 0xd8], (0 * w + 4) * 3);
  alpha[0 * w + 4] = 255;
  png.write(path.join(dir, 'slices.png'), w, h, rgb, alpha);
  fs.writeFileSync(path.join(dir, 'slab.stack.json'), JSON.stringify({ slices: 'slices.png', slice: [3, 2], cell: 0.5, roles: { '#5b6b2e': 'olive' } }));
  const result = ok(await call({ source: path.join(dir, 'slab.stack.json'), out: path.join(dir, 'slab'), preview: false }, {}));
  assert.equal(result.engine, 'stack');
  assert.equal(result.slices, 2);
  assert.equal(result.blocks, 7);
  assert.deepEqual(result.roles, ['olive', 'paint-e8e4d8']);
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.deepEqual(spec.solids[0].layers, ['aaa/aaa', '.b./...']);
});

test('captures: 3DGS and point-cloud PLY files become voxel models with filled insides and few colours', async t => {
  const dir = tempDir(t);
  /* a binary 3DGS ball: red top, blue bottom, plus faint splats that the opacity threshold drops */
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2'];
  const rows = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dc = v => (v / 255 - 0.5) / 0.28209479177387814;
  for (let i = 0; i < 6000; i++) {
    const u = rnd() * 2 - 1, phi = rnd() * 2 * Math.PI, s = Math.sqrt(1 - u * u), p = [s * Math.cos(phi), u, s * Math.sin(phi)];
    const colour = p[1] > 0 ? [220, 40, 30] : [30, 60, 200];
    rows.push([...p, ...colour.map(dc), 4, -4, -4, -4]);
  }
  for (let i = 0; i < 200; i++) rows.push([3 + rnd(), 3, 3, 0, 0, 0, -6, -4, -4, -4]);
  const head = 'ply\nformat binary_little_endian 1.0\nelement vertex ' + rows.length + '\n' + props.map(p => 'property float ' + p).join('\n') + '\nend_header\n';
  const body = Buffer.alloc(rows.length * props.length * 4);
  rows.forEach((row, i) => row.forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4)));
  fs.writeFileSync(path.join(dir, 'ball.ply'), Buffer.concat([Buffer.from(head), body]));
  fs.writeFileSync(path.join(dir, 'ball.splat.json'), JSON.stringify({ ply: 'ball.ply', resolution: 32, colours: 2 }));
  const result = ok(await call({ source: path.join(dir, 'ball.splat.json'), out: path.join(dir, 'ball'), preview: false }, {}));
  assert.equal(result.engine, 'splat');
  assert.equal(result.points, 6000, 'faint splats are dropped');
  const vox = JSON.parse(fs.readFileSync(result.scene, 'utf8')).solids[0];
  const middle = vox.layers[Math.floor(vox.layers.length / 2)].split('/');
  assert.notEqual(middle[Math.floor(middle.length / 2)][Math.floor(middle[0].length / 2)], '.', 'the inside is filled');
  assert.ok(result.blocks > (4 / 3) * Math.PI * 14 ** 3, 'a filled ball, not a shell: ' + result.blocks);
  assert.ok(result.blocks < (4 / 3) * Math.PI * 18 ** 3, 'closing gaps does not grow the ball: ' + result.blocks);
  const direct = ok(await call({ source: path.join(dir, 'ball.ply'), out: path.join(dir, 'ball-direct'), preview: false }, {}));
  assert.equal(direct.engine, 'splat', 'a .ply works on its own');

  /* an ascii point cloud with a settings file: two colours stay two families */
  const lines = [];
  for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) for (const y of [0, 1]) lines.push([x / 10, y / 10, z / 10, y ? 200 : 40, y ? 180 : 90, 40].join(' '));
  fs.writeFileSync(path.join(dir, 'slab.ply'), 'ply\nformat ascii 1.0\nelement vertex ' + lines.length + '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n' + lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'slab.splat.json'), JSON.stringify({ ply: 'slab.ply', resolution: 10, colours: 2, names: ['bottom', 'top'], hard: true }));
  const slab = ok(await call({ source: path.join(dir, 'slab.splat.json'), out: path.join(dir, 'slab'), preview: false }, {}));
  assert.deepEqual(slab.roles.sort(), ['bottom', 'top']);
});

test('depth maps: a drawn sprite with depth becomes columns, closed by a mirrored, flat or drawn back', async t => {
  const dir = tempDir(t), png = require('../cli/png.js');
  /* a 3 x 2 sprite: the middle column stands out fully, the others half; one pixel empty */
  const rgb = new Uint8Array(3 * 2 * 3).fill(0), alpha = new Uint8Array(6).fill(255), depth = new Uint8Array(6 * 3);
  for (let i = 0; i < 6; i++) rgb.set([0x5b, 0x6b, 0x2e], i * 3);
  const set = (i, v) => depth.set([v, v, v], i * 3);
  [0, 2, 3, 5].forEach(i => set(i, 128));
  [1, 4].forEach(i => set(i, 255));
  alpha[3] = 0;
  png.write(path.join(dir, 'front.png'), 3, 2, rgb, alpha);
  png.write(path.join(dir, 'depth.png'), 3, 2, depth, new Uint8Array(6).fill(255));
  const build = async back => {
    fs.writeFileSync(path.join(dir, 'b.depth.json'), JSON.stringify({ image: 'front.png', depth: 'depth.png', layers: 4, back }));
    return ok(await call({ source: path.join(dir, 'b.depth.json'), out: path.join(dir, 'out-' + back), preview: false }, {}));
  };
  const flat = await build('flat');
  assert.equal(flat.engine, 'depth');
  assert.equal(flat.blocks, 3 * 3 + 2 * 5, 'three half columns of 0..2 (one pixel is empty) and two full ones of 0..4');
  const mirror = await build('mirror');
  assert.equal(mirror.blocks, 3 * 5 + 2 * 9, 'mirrored columns reach as far behind as in front');
});

test('terrain: heights in coloured bands, rock on steep slopes, water up to its level', async t => {
  const dir = tempDir(t), png = require('../cli/png.js');
  /* a 4 x 1 ramp: 0, 1/3, 2/3, 1 */
  const grey = [0, 85, 170, 255], rgb = new Uint8Array(12);
  grey.forEach((g, i) => rgb.set([g, g, g], i * 3));
  png.write(path.join(dir, 'ramp.png'), 4, 1, rgb, new Uint8Array(4).fill(255));
  fs.writeFileSync(path.join(dir, 'ramp.terrain.json'), JSON.stringify({
    height: 'ramp.png', levels: 6, water: 0.4,
    bands: [{ below: 0.5, colour: '#d8c890', role: 'sand' }, { below: 1.01, colour: '#5f8f3a', role: 'grass' }],
    slope: { above: 1, colour: '#7a7470', role: 'rock' }
  }));
  const result = ok(await call({ source: path.join(dir, 'ramp.terrain.json'), out: path.join(dir, 'ramp'), preview: false }, {}));
  assert.equal(result.engine, 'terrain');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8')), vox = spec.solids[0];
  const letter = role => Object.entries(vox.key).find(([, m]) => (m.role ?? m) === role)?.[0];
  const column = x => vox.layers.map(l => l.split('/')[0][x]).join('');
  assert.equal(column(0)[0], letter('sand'));
  assert.equal(column(0).slice(1, 3), letter('water').repeat(2), 'water fills the low column up to its level');
  assert.equal(column(3)[6], letter('rock'), 'the top of the steep end is rock');
  assert.equal(spec.camera.pitch, 0.6);
});

test('levels: tile maps and sectors become floors, walls, doors and pools', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'room.level.json'), JSON.stringify({
    tile: 1, block: 0.5, wall: 2,
    tiles: { '#': { wall: true, colour: '#7a6a58', role: 'stone' }, '.': { floor: 0, colour: '#5a4a3a', role: 'floor' },
      '+': { door: 1, colour: '#7a6a58', floorColour: '#5a4a3a' }, '~': { floor: -0.5, liquid: 0, colour: '#4a3a2a', liquidColour: '#3a6a9a', liquidRole: 'water' } },
    map: ['###', '#~+', '###'],
    sectors: [{ points: [[3, 0], [5, 0], [5, 3], [3, 3]], floor: 0.5, colour: '#6a7a4a', role: 'yard' }]
  }));
  const result = ok(await call({ source: path.join(dir, 'room.level.json'), out: path.join(dir, 'room'), preview: false }, {}));
  assert.equal(result.engine, 'level');
  /* the door's floor has the floor colour but no role of its own, and no '.' tile is on this map to lend one */
  assert.deepEqual([...result.roles].sort(), ['paint-4a3a2a', 'paint-5a4a3a', 'stone', 'water', 'yard'].sort());
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.equal(spec.camera.pitch, 1);
  assert.equal((await validate(result.scene)).valid, true);
  fs.writeFileSync(path.join(dir, 'room.level.json'), JSON.stringify({ tiles: {}, map: ['#'] }));
  const error = fails(await call({ source: path.join(dir, 'room.level.json'), out: path.join(dir, 'room'), overwrite: true, preview: false }, {}), 'BUILD_FAILED');
  assert.match(error.message, /"#" is not in tiles/);
});
