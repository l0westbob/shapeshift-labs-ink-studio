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
