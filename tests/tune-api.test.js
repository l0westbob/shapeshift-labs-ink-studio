const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = require('../scripts/tune-api.js');

test('the tuner re-renders view changes from cache, bakes bake changes once, and saves a tuned scene', t => {
  const dir = fs.mkdtempSync(path.join(root, 'studio', 'out', 'tune-test-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const scene = path.join(dir, 'hut.json');
  fs.writeFileSync(scene, JSON.stringify({
    id: 'tune-hut', style: 'slate', camera: { target: [0, 0.5, 0], dist: 4 },
    solids: [{ kind: 'box', at: [0, 0.5, 0], half: [0.6, 0.5, 0.6], mat: 'stone' }, { kind: 'ball', at: [0, 1.3, 0], r: 0.4, mat: 'moss' }]
  }));
  const rel = '/' + path.relative(root, scene);
  const first = api.tune({ scene: rel, settings: { art: 96 } });
  assert.equal(first.width, 96);
  assert.equal(first.height, 72);
  assert.equal(first.timings.cached, false);
  assert.ok(first.resolved.res > 0 && first.resolved.res <= 0.09, 'spacing follows the pixel size');
  const turned = api.tune({ scene: rel, settings: { art: 96, yaw: 1.2 } });
  assert.equal(turned.timings.cached, true, 'a camera change needs no bake');
  const stepped = api.tune({ scene: rel, settings: { art: 96, shadeSteps: 2, matDither: 'bayer', sunYaw: 90, sunHeight: 30 } });
  assert.equal(stepped.timings.cached, false);
  assert.deepEqual(stepped.resolved.sun, [0.866, 0.5, 0]);
  assert.equal(api.tune({ scene: rel, settings: { art: 96 } }).timings.cached, true, 'earlier variants stay cached');

  const saved = api.save({ scene: rel, settings: { art: 96, shadeSteps: 2, yaw: 1.2 } });
  const tuned = JSON.parse(fs.readFileSync(path.join(root, saved.file), 'utf8'));
  assert.equal(tuned.camera.yaw, 1.2);
  assert.deepEqual(tuned.solids[0].mat, { role: 'stone', pixelStyle: { shadeSteps: 2 } });
  assert.equal(tuned.finish.look.pixelSize, 1);

  assert.throws(() => api.tune({ scene: '/../outside.json' }), /No JSON diorama inside the repository/);
  assert.throws(() => api.tune({ scene: path.join(os.tmpdir(), 'x.json') }), /No JSON diorama/);
});
