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
  /* the raw model, before baking: two views side by side, and the hull's olive is in it */
  const raw = require('../cli/png.js').read(result.raw);
  assert.deepEqual([raw.w, raw.h], [720, 270]);
  let olive = 0;
  for (let i = 0; i < raw.w * raw.h; i++) if (raw.rgb[i * 3 + 1] > raw.rgb[i * 3] + 10 && raw.rgb[i * 3 + 1] > raw.rgb[i * 3 + 2] + 30) olive++;
  assert.ok(olive > 2000, 'raw.png shows the green hull (' + olive + ' px)');
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

test('model_three gives each material a stable role, keeps vertex colours automatic and survives a style change', { skip }, async t => {
  const dir = tempDir(t), script = path.join(dir, 'roles.mjs'), out = path.join(dir, 'model');
  fs.writeFileSync(script, `export default ({ THREE }) => {
    const group = new THREE.Group();
    const add = (material, x, geometry = new THREE.BoxGeometry(1, 1, 1)) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, 0.5, 0);
      group.add(mesh);
    };
    const paint = new THREE.MeshStandardMaterial({ color: 0x5b6b2e });
    paint.userData.role = 'Hull Paint';
    add(paint, 0);
    add(paint, 1.5);
    add(new THREE.MeshStandardMaterial({ color: 0x777b72, name: 'steel' }), 3);
    add(new THREE.MeshStandardMaterial({ color: 0xc8321e }), 4.5);
    const tinted = new THREE.BoxGeometry(1, 1, 1);
    tinted.setAttribute('color', new THREE.Float32BufferAttribute(new Array(tinted.attributes.position.count * 3).fill(0.6), 3));
    add(new THREE.MeshStandardMaterial({ vertexColors: true }), 6, tinted);
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(0, 10, 0);
    group.add(sun);
    return group;
  };\n`);
  const result = ok(await call({ script, out, shades: 3, pixelSize: 1, preview: false }));
  assert.deepEqual(result.roles, ['hull-paint', 'steel', 'paint-c8321e']);
  assert.deepEqual(result.parts.map(part => part.role), ['hull-paint', 'hull-paint', 'steel', 'paint-c8321e', undefined]);

  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.deepEqual(spec.solids[0].mat, { role: 'hull-paint', pixelStyle: { dither: 'none', shadeSteps: 3 } });
  assert.equal(spec.solids[4].mat, undefined, 'vertex colours keep the automatic look');
  assert.deepEqual(spec.roles['hull-paint'], [1, 2, 3]);
  assert.equal(spec.palette[2], 0x5b6b2e, 'the material colour is the lit shade of its ramp');
  assert.ok(spec.palette.length > 10, 'the vertex-coloured part adds its own families');
  assert.deepEqual(spec.light, { sun: [0, 1, 0] });
  assert.deepEqual(spec.finish, { dither: 0, look: { pixelSize: 1 } });

  /* every built-in role points into this palette, so another style still validates */
  for (const style of ['slate', 'ember', 'moss']) {
    const valid = ok(await registry.call('scene_validate', { scene: { spec: { ...spec, style } } }, { root: out }));
    assert.equal(valid.valid, true, style + ': ' + JSON.stringify(valid.errors));
  }

  const plain = ok(await call({ script, out, overwrite: true, pixelStyle: false, preview: false }));
  const plainSpec = JSON.parse(fs.readFileSync(plain.scene, 'utf8'));
  assert.equal(plainSpec.solids[0].mat, 'hull-paint');
  assert.equal(plainSpec.finish, undefined);
});
