const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const { locate } = require('../cli/three-model.js');

const skip = locate([root]) ? false : 'three is not installed (npm install)';
const call = (args, ctx = { allowCode: true }) => registry.call('model_three', args, { root, ...ctx });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-three-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
};

test('model_three runs scripts only when code is allowed', { skip }, async t => {
  const dir = tempDir(t);
  fails(await call({ script: 'examples/three/tank.mjs', out: dir }, {}), 'CODE_NOT_ALLOWED');
  assert.equal(fs.existsSync(path.join(dir, 'scene.json')), false);
});

test('model_three turns the example tank into a diorama of closed mesh parts', { skip }, async t => {
  const dir = tempDir(t);
  const result = ok(await call({ script: 'examples/three/tank.mjs', out: dir, size: 6, frames: 2 }));
  assert.equal(result.parts.length, 17);
  assert.ok(result.parts.every(part => part.open === 0), 'welded primitives are closed');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.extent, 6);
  assert.ok(fs.existsSync(path.join(dir, 'model.glb')) && fs.existsSync(path.join(dir, 'preview.png')));
  assert.equal(Buffer.from(result.image.base64, 'base64').subarray(1, 4).toString(), 'PNG');

  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.equal(spec.solids.length, 17);
  assert.ok(spec.solids.every(solid => solid.kind === 'mesh' && fs.existsSync(path.join(dir, solid.asset))));
  assert.equal(spec.palette.length, result.colours);
  const valid = ok(await registry.call('scene_validate', { scene: { path: result.scene } }, { root }));
  assert.equal(valid.valid, true);

  /* the generated scene carries on through the normal loop */
  const opened = ok(await registry.call('scene_open', { scene: { path: result.scene } }, { root }));
  const edited = ok(await registry.call('scene_edit', {
    scene: { handle: opened.handle }, baseRevision: opened.revision,
    operations: [{ op: 'setTransform', keys: ['slot:1'], patch: { translation: [0, 0.2, 0] } }]
  }, { root }));
  assert.notEqual(edited.revision, opened.revision);
  fails(await call({ script: 'examples/three/tank.mjs', out: dir }), 'EXISTS');
});

test('model_three keeps overlapping parts apart, rereads edited scripts and clears stale parts', { skip }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'blocks.cjs'), out = path.join(dir, 'model');
  const write = count => fs.writeFileSync(script, `module.exports = ({ THREE }) => {
    const group = new THREE.Group();
    for (let i = 0; i < ${count}; i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: i ? 0x3355aa : 0xaa3322 }));
      box.position.set(i * 0.5, 0.5, 0);
      box.name = 'block';
      group.add(box);
    }
    return group;
  };\n`);
  write(3);
  const three = ok(await call({ script, out, preview: false }));
  assert.equal(three.parts.length, 3);
  assert.equal(three.image, undefined);
  /* overlapping boxes: as one soup they would cancel where they overlap, as separate solids they stay solid */
  const spec = JSON.parse(fs.readFileSync(three.scene, 'utf8'));
  assert.deepEqual(spec.solids.map(solid => solid.at[0]), [-0.5, 0, 0.5]);

  write(1);
  fs.utimesSync(script, new Date(), new Date(Date.now() + 2000));
  const one = ok(await call({ script, out, overwrite: true, preview: false }));
  assert.equal(one.parts.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(out, 'parts')), ['01-block.glb']);
});

test('model_three reports scripts that return no model', { skip }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'empty.mjs');
  fs.writeFileSync(script, 'export default () => 42;\n');
  const error = fails(await call({ script, out: path.join(dir, 'out') }), 'BUILD_FAILED');
  assert.match(error.message, /Object3D/);
  fs.writeFileSync(script, 'export default ({ THREE }) => new THREE.Group();\n');
  fails(await call({ script, out: path.join(dir, 'out') }), 'BUILD_FAILED');
  fails(await call({ script: path.join(dir, 'missing.mjs'), out: dir }), 'NOT_FOUND');
});
