const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const registry = require('../agent/ops/index.js');

const call = (name, args) => registry.call(name, args, { root });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-agent-tools-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
};

test('ink_discover gives an overview, ranked search, tool schemas and the diorama format', async () => {
  const overview = ok(await call('ink_discover', {}));
  assert.ok(overview.tools.some(tool => tool.name === 'world_step'));
  assert.ok(overview.builtins.includes('watcher'));
  assert.ok(JSON.stringify(overview).length < 3000, 'the overview stays small');

  const search = ok(await call('ink_discover', { query: 'sprite atlas directions' }));
  assert.ok(search.results.length > 0);
  assert.ok(search.results.some(hit => hit.name === 'scene_export' || hit.topic === 'art-passes'));

  const described = ok(await call('ink_discover', { describe: 'world_step' }));
  assert.equal(described.input.type, 'object');
  fails(await call('ink_discover', { describe: 'nope' }), 'NOT_FOUND');

  const schema = ok(await call('ink_discover', { schema: 'diorama' }));
  assert.deepEqual(schema.solidKinds.ball.need, { at: 'vec3', r: 'num|vec3' });
  assert.ok('solids' in schema.top && 'res' in schema.solidCommon && 'spin' in schema.motion);
  assert.ok(schema.roles.includes('accent') && schema.types.vec3);
  assert.deepEqual(Object.keys(ok(await call('ink_discover', { schema: 'roles' }))).sort(), ['notes', 'roles', 'types']);
});

test('ink_docs lists, searches and pages through documents', async () => {
  const listed = ok(await call('ink_docs', {}));
  assert.ok(listed.topics.some(t => t.topic === 'agents'));
  assert.ok(listed.topics.some(t => t.topic === 'scene-editor'));

  const found = ok(await call('ink_docs', { query: 'stipple dither' }));
  assert.equal(found.results[0].topic, 'pixel-look');

  const first = ok(await call('ink_docs', { topic: 'scene-editor', maxChars: 400 }));
  assert.equal(first.text.length, 400);
  assert.ok(first.sections.includes('History'));
  const next = ok(await call('ink_docs', { topic: 'scene-editor', offset: first.nextOffset, maxChars: 400 }));
  assert.ok(!next.text.startsWith(first.text.slice(0, 50)));

  const section = ok(await call('ink_docs', { topic: 'scene-editor', section: 'history' }));
  assert.match(section.text, /^## History/);
  assert.equal(section.nextOffset, undefined);
  assert.match(fails(await call('ink_docs', { topic: 'scene' }), 'NOT_FOUND').hint, /scene-editor/);
  fails(await call('ink_docs', { topic: 'scene-editor', section: 'nothing like this' }), 'NOT_FOUND');
});

test('worlds open, step with actions, answer queries and keep evidence', async t => {
  const opened = ok(await call('world_open', { world: { path: 'examples/world-puzzle-gate.json' } }));
  const world = { handle: opened.handle };
  assert.equal(opened.tick, 0);
  assert.ok(opened.traces.includes('lock/why'));
  assert.ok(opened.actions.includes('world/input'));

  fails(await call('world_step', { world, steps: 5, actions: [{ tick: 1, action: 'nope' }] }), 'INVALID_ACTIONS');
  const actions = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'world-puzzle-gate.actions.json'), 'utf8'));
  const early = ok(await call('world_step', { world, steps: 5, actions }));
  assert.equal(early.tick, 5);
  assert.equal(early.from, 0, 'invalid actions did not advance the world');

  const branch = ok(await call('world_sim', { world, action: 'fork' }));
  const done = ok(await call('world_step', { world }));
  assert.equal(done.scenario.status, 'win');
  assert.ok(done.events.some(event => event.kind === 'puzzle-output-changed'));
  fails(await call('world_step', { world, ticks: 1 }), 'INVALID_INPUT');

  const why = ok(await call('world_query', { world, action: 'trace', name: 'lock/why' }));
  assert.equal(why.result.status, 'ok');
  fails(await call('world_query', { world, action: 'probe', name: 'nope/field' }), 'NOT_FOUND');
  fails(await call('world_query', { world, action: 'trace' }), 'INVALID_INPUT');

  assert.equal(ok(await call('world_sim', { world, action: 'verify' })).status, 'verified');
  ok(await call('world_step', { world: { handle: branch.handle }, ticks: done.tick }));
  assert.deepEqual(ok(await call('world_sim', { world, action: 'diff', other: branch.handle })).edits, []);
  assert.equal(ok(await call('world_sim', { world, action: 'diff', other: branch.handle, first: true })).status, 'equal');

  const file = path.join(tempDir(t), 'gate.run.json');
  ok(await call('world_sim', { world, action: 'save', kind: 'recording', path: file }));
  fails(await call('world_sim', { world, action: 'save', kind: 'recording', path: file }), 'EXISTS');
  const reopened = ok(await call('world_open', { world: { path: file } }));
  assert.equal(reopened.tick, done.tick);
  assert.equal(ok(await call('world_sim', { world, action: 'reset' })).tick, 0);

  fails(await call('world_open', { world: { path: 'examples/scene.json' } }), 'UNSUPPORTED');
  fails(await call('world_open', { world: { spec: { format: 'ink-studio/world', version: 1, id: 'x', dt: 'a' } } }), 'INVALID_WORLD');
});

test('world_query finds entities in space', async () => {
  const opened = ok(await call('world_open', { world: { path: 'examples/world-agent-orders.json' }, record: false }));
  const near = ok(await call('world_query', { world: { handle: opened.handle }, action: 'spatial', point: [0, 0, 0], radius: 3 }));
  assert.ok(near.result.some(entity => entity.id === 'shelter'));
  fails(await call('world_sim', { world: { handle: opened.handle }, action: 'verify' }), 'UNSUPPORTED');
});

test('scene_export writes GLB models and sprite atlases', async t => {
  const dir = tempDir(t);
  const glb = ok(await call('scene_export', { scene: { path: 'examples/scene.json' }, format: 'glb', out: path.join(dir, 'gem.glb') }));
  assert.equal(fs.readFileSync(glb.file).subarray(0, 4).toString(), 'glTF');
  assert.ok(glb.meshes[0].triangles > 0);
  fails(await call('scene_export', { scene: { path: 'examples/scene.json' }, format: 'glb', out: path.join(dir, 'gem.glb') }), 'EXISTS');
  fails(await call('scene_export', { scene: { builtin: 'idol' }, format: 'glb', out: path.join(dir, 'idol.glb') }), 'UNSUPPORTED');

  const atlas = ok(await call('scene_export', {
    scene: { path: 'examples/scene.json' }, format: 'atlas', out: path.join(dir, 'atlas'), directions: 4, to: 0.5, fps: 4, maps: ['depth']
  }));
  assert.equal(atlas.frames, 8);
  assert.deepEqual(atlas.files, ['color.png', 'depth.png', 'atlas.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'atlas', 'atlas.json'), 'utf8')).frames.length, 8);
  assert.equal(Buffer.from(atlas.image.base64, 'base64').subarray(1, 4).toString(), 'PNG');
});
