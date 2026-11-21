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

test('detail follows the art size: cells, splat spacing, capture resolution and a pixels-per-block word for grids', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'bar.vox.json'), JSON.stringify({ cell: 0.1, colours: { o: '#5b6b2e' }, layers: ['o'.repeat(120)] }));
  const fine = ok(await call({ source: path.join(dir, 'bar.vox.json'), out: path.join(dir, 'fine'), size: 6, preview: false }, {}));
  assert.equal(fine.detail.blocks, 120);
  assert.equal(fine.detail.pixelsPerBlock, 0.7);
  assert.match(fine.warnings.join(' '), /smaller than an art pixel .* About 60 blocks/);
  const big = ok(await call({ source: path.join(dir, 'bar.vox.json'), out: path.join(dir, 'big'), size: 6, art: 256, preview: false }, {}));
  assert.equal(big.detail.pixelsPerBlock, 1.41);
  assert.deepEqual(big.warnings, []);
  assert.equal(JSON.parse(fs.readFileSync(big.scene, 'utf8')).finish.res, Math.round((6 / 256) * 1e4) / 1e4);
});

test('review fixes: big captures, surfel scales, colour limits, tall tiles, repeat sizes, colour keys in any case', { timeout: 240000 }, async t => {
  const dir = tempDir(t), png = require('../cli/png.js');
  /* 200,000 points: bounds once overflowed the call stack */
  const count = 200000, buf = Buffer.alloc(count * 15);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    buf.writeFloatLE(Math.cos(a), i * 15), buf.writeFloatLE((i % 100) / 100, i * 15 + 4), buf.writeFloatLE(Math.sin(a), i * 15 + 8);
    buf[i * 15 + 12] = 90, buf[i * 15 + 13] = 110, buf[i * 15 + 14] = 50;
  }
  fs.writeFileSync(path.join(dir, 'ring.ply'), Buffer.concat([Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex ' + count + '\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n'), buf]));
  const ring = ok(await call({ source: path.join(dir, 'ring.ply'), out: path.join(dir, 'ring'), preview: false }, {}));
  assert.equal(ring.points, count);
  /* 2D Gaussian (surfel) files have two scales */
  const surfel = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1'];
  const rows = Array.from({ length: 400 }, (_, i) => [Math.cos(i), Math.sin(i), (i % 20) / 20, 0.5, 0, 0, 4, -3, -3]);
  const body = Buffer.alloc(rows.length * surfel.length * 4);
  rows.forEach((row, i) => row.forEach((v, k) => body.writeFloatLE(v, (i * surfel.length + k) * 4)));
  fs.writeFileSync(path.join(dir, 'surfel.ply'), Buffer.concat([Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 400\n' + surfel.map(p => 'property float ' + p).join('\n') + '\nend_header\n'), body]));
  ok(await call({ source: path.join(dir, 'surfel.ply'), out: path.join(dir, 'surfel'), preview: false }, {}));
  fs.writeFileSync(path.join(dir, 'many.splat.json'), JSON.stringify({ ply: 'ring.ply', colours: 70 }));
  assert.match(fails(await call({ source: path.join(dir, 'many.splat.json'), out: path.join(dir, 'many'), preview: false }, {}), 'BUILD_FAILED').message, /colours is 1 to 62/);
  /* a tile taller than the default wall keeps its height */
  fs.writeFileSync(path.join(dir, 'tower.level.json'), JSON.stringify({ block: 0.5, wall: 2, tiles: { T: { wall: true, height: 4, colour: '#7a6a58' } }, map: ['T'] }));
  const tower = ok(await call({ source: path.join(dir, 'tower.level.json'), out: path.join(dir, 'tower'), preview: false }, {}));
  const bounds = JSON.parse(fs.readFileSync(path.join(dir, 'tower', 'model.json'), 'utf8')).parts[0];
  assert.ok(bounds.hi[1] - bounds.lo[1] >= 4, 'the 4 m wall is not cut at 2 m');
  void tower;
  /* repeat needs a size */
  fs.writeFileSync(path.join(dir, 'bad.grammar.json'), JSON.stringify({ kind: 'split', axiom: 'A', colours: { w: '#ffffff' }, rules: { A: { repeat: 'x', size: 0, into: 'B' }, B: { box: 'w' } } }));
  assert.match(fails(await call({ source: path.join(dir, 'bad.grammar.json'), out: path.join(dir, 'bad'), preview: false }, {}), 'BUILD_FAILED').message, /repeat needs a size above 0/);
  /* role keys in upper case */
  const rgb = new Uint8Array([0x5b, 0x6b, 0x2e]);
  png.write(path.join(dir, 's.png'), 1, 1, rgb, new Uint8Array([255]));
  fs.writeFileSync(path.join(dir, 's.stack.json'), JSON.stringify({ slices: ['s.png'], roles: { '#5B6B2E': 'olive' } }));
  assert.deepEqual(ok(await call({ source: path.join(dir, 's.stack.json'), out: path.join(dir, 's'), preview: false }, {})).roles, ['olive']);
});

test('review fixes: compose checks part extensions and drops inherited spacing; fit paths share a start; dotted part names', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'evil.js'), 'require("fs").writeFileSync(' + JSON.stringify(path.join(dir, 'ran')) + ', "1"); module.exports = () => ({ cages: [] });\n');
  fs.writeFileSync(path.join(dir, 'x.compose.json'), JSON.stringify({ parts: [{ source: 'evil.js', engine: 'subd' }] }));
  fails(await call({ source: path.join(dir, 'x.compose.json'), out: path.join(dir, 'x'), preview: false }, {}), 'BUILD_FAILED');
  assert.equal(fs.existsSync(path.join(dir, 'ran')), false, 'the script never ran');

  fs.writeFileSync(path.join(dir, 'a.vox.json'), JSON.stringify({ cell: 0.1, colours: { o: '#5b6b2e' }, layers: ['oo'] }));
  fs.writeFileSync(path.join(dir, 'pair.compose.json'), JSON.stringify({ parts: [{ source: 'a.vox.json', size: 0.2 }, { source: 'a.vox.json', size: 6, at: [1, 0, 0] }] }));
  const pair = ok(await call({ source: path.join(dir, 'pair.compose.json'), out: path.join(dir, 'pair'), preview: false }, {}));
  assert.ok(JSON.parse(fs.readFileSync(pair.scene, 'utf8')).finish.res > 0.01, 'the composition is not baked at the tiny first part\'s spacing');

  fs.writeFileSync(path.join(dir, 'two.json'), JSON.stringify({ id: 'two', style: 'slate', camera: { target: [0, 0, 0], dist: 4 },
    solids: [{ kind: 'ball', at: [0.5, 0.3, 0], r: 0.3, mat: 'stone' }, { kind: 'ball', at: [-0.5, 0.3, 0], r: 0.3, mat: 'stone' }] }));
  const mirrored = await registry.call('scene_fit', { scene: { path: path.join(dir, 'two.json') }, targets: [{ view: 'front', rows: ['ss'], colours: { s: '#777777' } }],
    params: [{ paths: ['/solids/0/at/0', '/solids/1/at/0'], min: -2, max: 2 }], out: path.join(dir, 'fit') }, { root });
  assert.equal(mirrored.ok, false);
  assert.match(mirrored.error.message, /start at different values/);

  const { normalised } = require('../cli/loft-model.js');
  const rect = normalised([[0.5, 1], [-0.5, 1], [-0.5, -1], [0.5, -1]]), ellipse = normalised([[0, 1], [1, 0], [0, -1], [-1, 0]]);
  const signed = ring => ring.reduce((s, [u, v], i) => s + u * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * v, 0);
  assert.ok(signed(rect) > 0 && signed(ellipse) > 0, 'rings run the same way round');
});

test('review fixes: show_object with names and colours, build123d colours', { skip: noCadquery, timeout: 240000 }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'shown.py');
  fs.writeFileSync(script, 'import cadquery as cq\nshow_object(cq.Workplane().box(1, 1, 1), "hull", {"color": "#ff0000", "role": "paint"})\nshow_object(cq.Workplane().sphere(0.4).translate((0, 0, 1)))\n');
  const shown = ok(await call({ source: script, out: path.join(dir, 'shown'), preview: false }));
  assert.deepEqual(shown.parts.map(p => [p.name, p.role]), [['hull', 'paint'], ['part-2', 'paint-b4b4b4']]);
  fs.writeFileSync(script, 'from build123d import Box, Color\nb = Box(1, 1, 1)\nb.color = Color(0.2, 0.4, 0.1)\nb.label = "crate"\nresult = b\n');
  const b123 = ok(await call({ source: script, out: path.join(dir, 'b123'), overwrite: true, preview: false }));
  assert.equal(b123.parts[0].role, 'paint-33661a');
});

test('review fixes: Blender skips hidden cutters and reads viewport colours', { skip: hasBlender ? false : 'Blender is not installed', timeout: 240000 }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'cut.blender.py');
  fs.writeFileSync(script, `import bpy
bpy.ops.mesh.primitive_cube_add(size=2)
body = bpy.context.object
body.name = "body"
m = bpy.data.materials.new("paint")
m.diffuse_color = (0.1, 0.5, 0.1, 1)
body.data.materials.append(m)
bpy.ops.mesh.primitive_cylinder_add(radius=0.4, depth=3)
cutter = bpy.context.object
cutter.hide_viewport = True
mod = body.modifiers.new("cut", "BOOLEAN")
mod.object = cutter
`);
  const result = ok(await call({ source: script, out: path.join(dir, 'cut'), preview: false }));
  assert.deepEqual(result.parts.map(p => p.name), ['body'], 'the hidden cutter is not a part');
  assert.notEqual(result.parts[0].role, 'paint-cccccc');
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  const ramp = spec.roles.paint.map(i => spec.palette[i]);
  assert.ok(ramp.some(c => ((c >> 8) & 255) > ((c >> 16) & 255) + 30), 'the green viewport colour is used, not the grey default');
});

test('review fixes: OpenSCAD names an empty part; subd ignores stray vertices and checks creases', { timeout: 240000 }, async t => {
  const dir = tempDir(t);
  if (hasOpenscad) {
    fs.writeFileSync(path.join(dir, 'e.scad'), 'PARTS = [["solid", "#777777"], ["ghost", "#777777"]];\nmodule part(name) { if (name == "solid") cube(1); }\n');
    assert.match(fails(await call({ source: path.join(dir, 'e.scad'), out: path.join(dir, 'e'), preview: false }), 'BUILD_FAILED').message, /Part "ghost"/);
  }
  const { cage } = require('../cli/subd-model.js');
  const box = cage.box();
  fs.writeFileSync(path.join(dir, 'stray.subd.json'), JSON.stringify({ cages: [{ ...box, vertices: [...box.vertices, [5, 5, 5]], levels: 1 }] }));
  ok(await call({ source: path.join(dir, 'stray.subd.json'), out: path.join(dir, 'stray'), preview: false }, {}));
  fs.writeFileSync(path.join(dir, 'crease.subd.json'), JSON.stringify({ cages: [{ ...box, creases: [0, 1] }] }));
  assert.match(fails(await call({ source: path.join(dir, 'crease.subd.json'), out: path.join(dir, 'crease'), preview: false }, {}), 'BUILD_FAILED').message, /creases\[0\] is a pair/);
});

/* a GLB written the way generators write them: a node with a transform, one primitive, optional texture or colours */
function glbOf(file, { texture, colours, material = {}, translation = [0, 0, 0], extensionsRequired, extra } = {}) {
  const { document } = require('../cli/glb-file.js'), png = require('../cli/png.js');
  const doc = document(), pos = [], uv = [], index = [];
  /* a cube with its own corners per face, so every edge is a UV seam */
  const faces = [[[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]],
    [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]];
  for (const face of faces) {
    const base = pos.length / 3;
    face.forEach((p, i) => (pos.push(...p), uv.push([0, 1, 1, 0][i], [1, 1, 0, 0][i])));
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const attributes = { POSITION: doc.accessor(Float32Array.from(pos), 'VEC3', { bounds: true }) };
  const pbr = { metallicFactor: 0, ...material.pbr };
  if (texture) {
    attributes.TEXCOORD_0 = doc.accessor(Float32Array.from(uv), 'VEC2');
    pbr.baseColorTexture = { index: doc.texture(texture.bytes ?? png.encode(texture.w, texture.h, texture.rgb), 'paint', texture.mime) };
  }
  if (colours) attributes.COLOR_0 = doc.accessor(Float32Array.from({ length: 24 * 3 }, (_, i) => colours[i % 3]), 'VEC3');
  const mat = doc.add('materials', { name: material.name, pbrMetallicRoughness: pbr });
  const mesh = doc.add('meshes', { name: 'crate', primitives: [{ attributes, indices: doc.accessor(Uint32Array.from(index), 'SCALAR'), material: mat, ...extra }] });
  doc.gltf.scenes[0].nodes.push(doc.add('nodes', { name: 'crate', mesh, translation }));
  if (extensionsRequired) doc.gltf.extensionsRequired = extensionsRequired;
  fs.writeFileSync(file, doc.finish());
  return file;
}

test('the glb engine keeps texture colours on finished meshes, splitting textured triangles to about a pixel, without code', async t => {
  const dir = tempDir(t);
  /* left half red, right half blue */
  const w = 8, rgb = new Uint8Array(w * w * 3);
  for (let i = 0; i < w * w; i++) rgb.set(i % w < w / 2 ? [200, 30, 30] : [30, 60, 200], i * 3);
  const source = glbOf(path.join(dir, 'crate.glb'), { texture: { w, h: w, rgb }, translation: [5, 1, 0] });
  const result = ok(await call({ source, out: path.join(dir, 'crate'), preview: false }, {}));
  assert.equal(result.engine, 'glb');
  assert.equal(result.glb.textured, 1);
  assert.ok(result.triangles > 2000, 'twelve triangles are split towards the pixel size: ' + result.triangles);
  assert.equal(result.parts[0].open, 0, 'both sides of every seam split alike, so the welded cube is closed');
  assert.deepEqual(result.roles, [], 'textured parts take colour families, not roles');
  assert.equal(result.glb.hues, 3, 'textured models default to three colour families');

  const mesh = Scenes.studio().readMesh(path.join(result.directory, result.parts[0].file));
  let red = 0, blue = 0;
  for (let i = 0; i < mesh.vcol.length; i += 3) {
    const [r, , b] = [mesh.vcol[i], mesh.vcol[i + 1], mesh.vcol[i + 2]];
    if (r > b * 2) red++;
    else if (b > r * 2) blue++;
  }
  assert.ok(red > 100 && blue > 100 && Math.abs(red - blue) / (red + blue) < 0.2, 'both texture halves reach the vertices: ' + red + ' red, ' + blue + ' blue');

  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.deepEqual(spec.solids[0].at, [0, 0, 0], 'the node translation moved the cube, and the diorama centres it on the ground');
  assert.ok(spec.camera.dist >= Math.hypot(2, 2, 2) / 2 * 2.75 - 1e-3, 'a compact model is framed by its bounding sphere: ' + spec.camera.dist);
  assert.equal((await validate(result.scene)).valid, true);
});

test('the glb engine: plain materials become roles, COLOR_0 becomes vertex colours, unreadable files say why', async t => {
  const dir = tempDir(t);
  const plain = ok(await call({ source: glbOf(path.join(dir, 'plain.glb'), { material: { name: 'Rust Metal', pbr: { baseColorFactor: [0.3, 0.05, 0.02, 1] } } }), out: path.join(dir, 'plain'), preview: false }, {}));
  assert.deepEqual(plain.roles, ['rust-metal']);
  assert.equal(plain.glb.textured, 0);

  const tinted = ok(await call({ source: glbOf(path.join(dir, 'tinted.glb'), { colours: [0.1, 0.6, 0.1] }), out: path.join(dir, 'tinted'), preview: false }, {}));
  assert.deepEqual(tinted.roles, []);
  const mesh = Scenes.studio().readMesh(path.join(tinted.directory, tinted.parts[0].file));
  assert.ok(mesh.vcol[1] > mesh.vcol[0] * 2, 'the vertex colour is kept (readMesh gives sRGB): ' + Array.from(mesh.vcol.slice(0, 3)));
  assert.equal(tinted.triangles, 12, 'untextured meshes are not split');
  assert.equal(tinted.glb.hues, 6, 'untextured models keep the usual six families');

  const jpeg = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), mime: 'image/jpeg' };
  assert.match(fails(await call({ source: glbOf(path.join(dir, 'jpeg.glb'), { texture: jpeg }), out: path.join(dir, 'jpeg'), preview: false }, {}), 'BUILD_FAILED').message, /only PNG textures/);
  assert.match(fails(await call({ source: glbOf(path.join(dir, 'draco.glb'), { extensionsRequired: ['KHR_draco_mesh_compression'] }), out: path.join(dir, 'draco'), preview: false }, {}), 'BUILD_FAILED').message, /without mesh compression/);

  /* a .gltf may only pull companion files from its own folder */
  const gltf = path.join(dir, 'outside.gltf');
  fs.writeFileSync(gltf, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: '../secret.bin', byteLength: 4 }] }));
  assert.match(fails(await call({ source: gltf, out: path.join(dir, 'outside'), preview: false }, {}), 'BUILD_FAILED').message, /outside its folder/);
});

test('refine splits long edges alike on both sides of a seam and carries attributes to the midpoints', () => {
  const { refine } = require('../cli/glb-model.js');
  /* two triangles that share the edge (1,0,0)-(0,1,0) by position but not by vertex */
  const pos = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const uv = { data: Float32Array.from([0, 0, 1, 0, 0, 1, 0.5, 0, 1, 1, 0.5, 1]), lanes: 2 };
  const fine = refine(pos, [0, 1, 2, 3, 4, 5], 0.3, 1e5, [uv]);
  const edges = new Map(), key = i => [0, 1, 2].map(k => Math.round(fine.pos[i * 3 + k] * 1e5)).join(',');
  for (let t = 0; t < fine.index.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = key(fine.index[t + e]), b = key(fine.index[t + ((e + 1) % 3)]), k = a < b ? a + '|' + b : b + '|' + a;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  const boundary = [...edges.values()].filter(n => n === 1).length;
  const longest = Math.max(...Array.from({ length: fine.index.length }, (_, i) => {
    const a = fine.index[i], b = fine.index[i % 3 === 2 ? i - 2 : i + 1];
    return Math.hypot(fine.pos[a * 3] - fine.pos[b * 3], fine.pos[a * 3 + 1] - fine.pos[b * 3 + 1]);
  }));
  assert.ok(longest <= 0.3, 'no edge is longer than the limit: ' + longest);
  assert.equal(boundary, 16, 'only the outer square is open (4 sides split into 4): no cracks along the shared diagonal');
  const [u0, v0] = [fine.attributes[0][6 * 2], fine.attributes[0][6 * 2 + 1]];
  assert.ok(Number.isFinite(u0) && Number.isFinite(v0) && fine.attributes[0].length === fine.pos.length / 3 * 2, 'every vertex has its uv');
});

test('the glb engine reads linear textures when told (trellis2mlx output) and turns models with yaw', async t => {
  const dir = tempDir(t), w = 4, rgb = new Uint8Array(w * w * 3).fill(64);
  const source = glbOf(path.join(dir, 'grey.glb'), { texture: { w, h: w, rgb } });
  const mean = result => {
    const mesh = Scenes.studio().readMesh(path.join(result.directory, result.parts[0].file));
    return mesh.vcol.reduce((sum, v) => sum + v, 0) / mesh.vcol.length;
  };
  const srgb = ok(await call({ source, out: path.join(dir, 'srgb'), preview: false }, {}));
  const linear = ok(await call({ source, out: path.join(dir, 'linear'), colourSpace: 'linear', preview: false }, {}));
  /* readMesh gives sRGB: texel 64 read as sRGB stays about 64/255, read as linear it shows as about 137/255 */
  assert.ok(Math.abs(mean(srgb) - 64 / 255) < 0.02, 'sRGB texel kept: ' + mean(srgb));
  assert.ok(Math.abs(mean(linear) - 137 / 255) < 0.02, 'linear texel brightened for display: ' + mean(linear));

  /* a long box along x turned a quarter turn lies along z */
  const { partsOf, documentOf } = require('../cli/glb-model.js');
  const { partBounds } = require('../cli/model-core.js');
  const longer = glbOf(path.join(dir, 'plain.glb'), {});
  const doc = documentOf(longer);
  doc.gltf.nodes[0].scale = [3, 1, 1];
  const turned = partBounds(partsOf(doc, { yaw: Math.PI / 2 }).parts[0].pos);
  assert.ok(turned.hi[2] - turned.lo[2] > 5.9 && turned.hi[0] - turned.lo[0] < 2.1, JSON.stringify(turned));
  fails(await call({ source, out: path.join(dir, 'bad'), colourSpace: 'gamma', preview: false }, {}), 'INVALID_INPUT');
});

test('the glb engine averages texture detail finer than an art pixel instead of point-sampling it', async t => {
  const dir = tempDir(t), w = 512, rgb = new Uint8Array(w * w * 3);
  /* a one-texel checkerboard: point samples land on black or white, the mean is mid grey */
  for (let i = 0; i < w * w; i++) rgb.fill((i % w) % 2 ^ Math.floor(i / w) % 2 ? 255 : 0, i * 3, i * 3 + 3);
  const result = ok(await call({ source: glbOf(path.join(dir, 'checker.glb'), { texture: { w, h: w, rgb } }), out: path.join(dir, 'checker'), preview: false }, {}));
  const mesh = Scenes.studio().readMesh(path.join(result.directory, result.parts[0].file));
  let extreme = 0;
  for (let i = 0; i < mesh.vcol.length; i += 3) if (mesh.vcol[i] < 0.5 || mesh.vcol[i] > 0.9) extreme++;
  /* linear mean 0.5 shows as about 0.735 in sRGB */
  assert.ok(extreme / (mesh.vcol.length / 3) < 0.02, Math.round((100 * extreme) / (mesh.vcol.length / 3)) + '% of vertices kept a black or white texel');
});
