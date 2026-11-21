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
