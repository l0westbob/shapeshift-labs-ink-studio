const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const { rolePalette } = require('../cli/model-core.js');
const Scenes = require('../agent/scenes.js');

const ok = outcome => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  return outcome.result;
};

test('scene_fit tunes a diorama towards drawn views and keeps the best', { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-fit-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const { palette, roles } = rolePalette([{ key: 'walls', colour: 0xc8b88a }, { key: 'roof', colour: 0x8a3324 }], { shades: 4, styles: Scenes.kit().KIT.diorama.styles });
  const mat = role => ({ role, pixelStyle: { dither: 'none', shadeSteps: 4 } });
  fs.writeFileSync(path.join(dir, 'hut.json'), JSON.stringify({
    id: 'fit-hut', seed: 1, style: 'moss', palette, roles, finish: { dither: 0, look: { pixelSize: 1 } },
    camera: { target: [0, 1, 0], dist: 6 },
    solids: [{ kind: 'box', at: [0, 0.6, 0], half: [0.6, 0.6, 0.6], mat: mat('walls') }, { kind: 'box', at: [0, 1.4, 0], half: [0.6, 0.15, 0.6], mat: mat('roof') }]
  }));
  /* a wide, low hut under a thick roof, drawn from the front and the side */
  const views = { front: ['rrrrrrrr', 'rrrrrrrr', 'wwwwwwww', 'wwwwwwww'], right: ['rrrr', 'rrrr', 'wwww', 'wwww'] };
  fs.writeFileSync(path.join(dir, 'hut.views.json'), JSON.stringify({ colours: { w: '#c8b88a', r: '#8a3324' }, views }));
  const result = ok(await registry.call('scene_fit', {
    scene: { path: path.join(dir, 'hut.json') }, targets: [{ views: path.join(dir, 'hut.views.json') }],
    params: [{ path: '/solids/0/half/0', paths: ['/solids/0/half/0', '/solids/1/half/0'], min: 0.3, max: 2 }, { path: '/solids/1/half/1', min: 0.05, max: 1 }, { path: '/solids/1/at/1', min: 1, max: 2.5 }],
    out: path.join(dir, 'fit'), iterations: 8, population: 4, size: 48
  }, { root }));
  assert.ok(result.after.score >= result.before.score);
  assert.ok(result.after.silhouette > result.before.silhouette, 'the hut gets wider: ' + JSON.stringify(result.values));
  const spec = JSON.parse(fs.readFileSync(result.scene, 'utf8'));
  assert.equal(spec.solids[0].half[0], spec.solids[1].half[0], 'paths move together');
  assert.ok(fs.existsSync(result.sheet));
  assert.equal(result.history.length, 9);

  const bad = await registry.call('scene_fit', {
    scene: { path: path.join(dir, 'hut.json') }, targets: [{ views: path.join(dir, 'hut.views.json') }],
    params: [{ path: '/solids/0/kind', min: 0, max: 1 }], out: path.join(dir, 'fit')
  }, { root });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /is not a number/);
});
