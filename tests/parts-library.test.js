const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const { locate } = require('../cli/three-model.js');
const { pythonFor } = require('../cli/cadquery-model.js');

const hasCadquery = (() => {
  try {
    execFileSync(pythonFor([root]), ['-c', 'import cadquery'], { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
})();
const build = async (t, name, text) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-parts-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  fs.writeFileSync(path.join(dir, name), text);
  const outcome = await registry.call('model_build', { source: path.join(dir, name), out: path.join(dir, 'out'), preview: false }, { root, allowCode: true });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  return outcome.result;
};

test('every CadQuery library part builds closed', { skip: hasCadquery ? false : 'cadquery is not installed', timeout: 240000 }, async t => {
  const result = await build(t, 'parts.py', `import cadquery as cq
from ink_parts import road_wheel, track_loop, barrel, hatch, crate, panel, rounded_box, bolt_ring
def build():
    assy = cq.Assembly()
    for i, (name, shape) in enumerate([("rounded-box", rounded_box(1, 0.6, 0.4)), ("road-wheel", road_wheel()), ("track-loop", track_loop()),
                                        ("barrel", barrel()), ("hatch", hatch()), ("crate", crate()), ("panel", panel()), ("bolt-ring", bolt_ring())]):
        assy.add(shape.translate((0, i * 2.0, 0)), name=name, color=cq.Color("#777b72"))
    return assy
`);
  assert.deepEqual(result.parts.map(p => p.name), ['rounded-box', 'road-wheel', 'track-loop', 'barrel', 'hatch', 'crate', 'panel', 'bolt-ring']);
  for (const part of result.parts) assert.equal(part.open, 0, part.name + ' is closed');
});

test('every three.js library part builds closed and named', { skip: locate([root]) ? false : 'three is not installed' }, async t => {
  const result = await build(t, 'parts.mjs', `export default ({ THREE, parts }) => {
  const m = new THREE.MeshStandardMaterial({ color: 0x777b72, name: 'steel' });
  const group = new THREE.Group();
  [parts.roundedBox({}, m), parts.roadWheel({}, m), parts.trackLoop({}, m), parts.barrel({}, m), parts.hatch({}, m), parts.crate({}, m), parts.panel({}, m)]
    .forEach((item, i) => { item.position.z = i * 2; group.add(item); });
  return group;
};
`);
  for (const name of ['box', 'wheel', 'track', 'barrel', 'hatch', 'crate', 'panel']) assert.ok(result.parts.some(p => p.name === name), name);
  for (const part of result.parts) assert.equal(part.open, 0, part.name + ' is closed');
});
