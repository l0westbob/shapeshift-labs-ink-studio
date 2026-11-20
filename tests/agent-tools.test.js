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

test('scene_query explains baked splats and look targets', async () => {
  const scene = { path: 'examples/scene.json' };
  const targets = ok(await call('scene_query', { scene, action: 'select' })).result.targets;
  assert.ok(targets.some(target => target.object === 'gem' && target.material === 'accent'));
  const sample = ok(await call('scene_query', { scene, action: 'sample', at: [0, 1.8, 0.7] })).result.value;
  assert.equal(sample.material, 'accent');
  assert.match(sample.swatch, /^#[0-9a-f]{6}$/);
  const output = ok(await call('scene_query', { scene, action: 'output', select: { material: 'accent' } })).result.value;
  assert.equal(output.matched, 1);
  fails(await call('scene_query', { scene, action: 'sample' }), 'INVALID_INPUT');
});

test('ink_cli runs classic commands as JSON envelopes and keeps code behind permission', async t => {
  const help = ok(await call('ink_cli', { command: 'help' }));
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout.text, /ink-studio <command>/);
  const sheet = path.join(tempDir(t), 'sheet.png');
  const made = ok(await call('ink_cli', { command: 'sheet', args: ['examples/scene.json', '--n', '2', '--out', sheet] }));
  assert.equal(made.ok, true);
  assert.ok(fs.existsSync(sheet));
  const unknown = ok(await call('ink_cli', { command: 'nope' }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.stderr.text, /unknown command/);
  fails(await call('ink_cli', { command: 'render', args: ['examples/sculpt.js'] }), 'CODE_NOT_ALLOWED');
  fails(await call('ink_cli', { command: 'agent', args: ['list'] }), 'INVALID_INPUT');
});

test('scene_review and look return the CLI reports as data', async () => {
  const withCode = { root, allowCode: true };
  const review = ok(await registry.call('scene_review', { scene: { path: 'examples/motion-review.js' }, kind: 'motion-review' }, withCode));
  assert.equal(review.report.scene, 'motion-review');
  assert.ok(Array.isArray(review.report.findings));
  fails(await call('scene_review', { scene: { path: 'examples/motion-review.js' }, kind: 'motion-review' }), 'CODE_NOT_ALLOWED');
  fails(await call('scene_review', { scene: { path: 'examples/scene.json' }, kind: 'timeline' }), 'CLI_FAILED');

  const opened = ok(await call('scene_open', { scene: { path: 'examples/scene.json' }, bake: false }));
  ok(await call('scene_edit', { scene: { handle: opened.handle }, operations: [{ op: 'patch', patch: { op: 'replace', path: '/name', value: 'Edited gem' } }] }));
  const dataReview = await call('scene_review', { scene: { handle: opened.handle }, kind: 'data-inputs' });
  assert.equal(dataReview.ok, false, 'a scene without data inputs reports a CLI failure');
  assert.equal(fs.readdirSync(path.join(root, 'examples')).filter(f => f.startsWith('.ink-agent-')).length, 0, 'temporary scene files are removed');

  const imported = ok(await call('look', { action: 'import', file: 'examples/blue-shadow.cube' }));
  assert.equal(imported.report.format, 'ink-studio/asset-pack');
  const sampled = ok(await call('look', { action: 'sample', file: 'examples/blue-shadow.cube', args: ['--colors', '["#ff0000"]'] }));
  assert.equal(sampled.report.samples.length, 1);
  fails(await call('look', { action: 'bake', file: 'examples/blue-shadow.cube' }), 'INVALID_INPUT');
});

test('the catalog lists every agent tool and CLI command', () => {
  const { spawnSync } = require('node:child_process');
  const check = spawnSync(process.execPath, [path.join(root, 'scripts', 'sync-catalog.js'), '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const ids = new Set(JSON.parse(fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')).entries.map(e => e.id));
  for (const op of registry.list()) assert.ok(ids.has('agent.' + op.name), op.name);
});

test('classic measuring commands answer with agent JSON when given --json', () => {
  const { spawnSync } = require('node:child_process');
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'cli', 'ink-studio.js'), ...args, '--json'], { cwd: root, encoding: 'utf8' });
  const stats = run('stats', 'examples/scene.json');
  assert.equal(stats.status, 0, stats.stderr);
  assert.ok(JSON.parse(stats.stdout).result.stats.splats.total > 0);
  const lint = run('lint', 'examples/scene.json');
  assert.equal(typeof JSON.parse(lint.stdout).result.lint.orphans, 'number');
  assert.equal(run('stats', 'missing.json').status, 1);
  const classic = run('validate', 'examples/scene.json');
  assert.equal(classic.status, 0, classic.stderr);
  assert.equal(JSON.parse(classic.stdout).ok, undefined, 'validate keeps its own --json report');
});

test('review fixes: sessions, precision, large renders, keys, annotations, overwrite, roots, reports', async t => {
  const { compact } = require('../agent/data.js');
  assert.deepEqual(compact({ x: 1234.5678, y: 98765.4321, z: 0.000123456 }), { x: 1234.568, y: 98765.432, z: 0.0001235 });

  const live = ok(await call('world_open', { world: { path: 'examples/world-puzzle-gate.json' } }));
  const sessions = require('../agent/worlds.js').sessions.size;
  for (let i = 0; i < 20; i++) ok(await call('world_query', { world: { path: 'examples/world-puzzle-gate.json' }, action: 'inspect' }));
  assert.equal(require('../agent/worlds.js').sessions.size, sessions, 'one-shot queries take no session slot');
  ok(await call('world_step', { world: { handle: live.handle }, steps: 1 }));

  const big = ok(await call('scene_measure', { scene: { path: 'examples/scene.json' }, metrics: ['values'], size: { w: 2048, h: 2048 } }));
  assert.ok(['FLAT', 'ONE_TONE', 'TWO_TONES', 'THREE_TONES'].includes(big.values.verdict));

  const opened = ok(await call('scene_open', { scene: { path: 'examples/scene.json' }, bake: false }));
  assert.ok(opened.tree.some(row => row.key === 'slot:1' && row.shape === 'ball'));
  const missingKeys = fails(await call('scene_edit', { scene: { handle: opened.handle }, operations: [{ op: 'setMaterial', material: 'earth' }] }), 'INVALID_INPUT');
  assert.equal(missingKeys.path, '/operations/0/keys');
  const recoloured = ok(await call('scene_edit', { scene: { handle: opened.handle }, operations: [{ op: 'setMaterial', keys: ['slot:1'], material: 'earth' }] }));
  assert.ok(recoloured.changes.length > 0);

  const dir = tempDir(t), png = path.join(dir, 'keep.png');
  fs.writeFileSync(png, 'reference');
  fails(await call('scene_render', { scene: { handle: opened.handle }, out: png }), 'EXISTS');
  ok(await call('scene_render', { scene: { handle: opened.handle }, out: png, overwrite: true }));
  assert.notEqual(fs.readFileSync(png, 'utf8'), 'reference');

  const meshSpec = {
    id: 'totem-check', name: 'Totem', seed: 1, style: 'moss',
    camera: { target: [0, 1, 0], dist: 8, pitch: 0.2, yaw: 0.4 },
    solids: [{ kind: 'mesh', asset: 'assets/totem', size: 2, at: [0, 1, 0] }]
  };
  assert.equal(ok(await registry.call('scene_validate', { scene: { spec: meshSpec } }, { root: path.join(root, 'lab') })).valid, true);

  const sheet = path.join(dir, 'sheet.png');
  const made = ok(await call('ink_cli', { command: 'sheet', args: ['examples/scene.json', '--n', '2', '--out', sheet] }));
  assert.ok(made.files.includes(sheet), 'files written through --out are reported');

  const server = require('node:child_process').spawnSync(process.execPath, [path.join(root, 'cli', 'ink-studio.js'), 'agent', 'list'], { cwd: root, encoding: 'utf8' });
  assert.equal(server.status, 0);
});

test('MCP annotations mark only genuinely read-only tools as read-only', async () => {
  const source = fs.readFileSync(path.join(root, 'agent', 'mcp-server.js'), 'utf8');
  assert.match(source, /readOnlyHint: op.effects === 'read' \|\| op.readOnly === true/);
  const byName = Object.fromEntries(registry.list().map(op => [op.name, op]));
  const readOnly = op => op.effects === 'read' || op.readOnly === true;
  assert.equal(readOnly(byName.ink_cli), false);
  assert.equal(readOnly(byName.scene_render), false);
  assert.equal(readOnly(byName.scene_open), true);
  assert.equal(readOnly(byName.world_open), true);
});

test('scene_review accepts reports printed to stdout (cloth-review)', async () => {
  const review = ok(await registry.call('scene_review', { scene: { path: 'examples/cloth-review.js' }, kind: 'cloth-review' }, { root, allowCode: true }));
  assert.equal(typeof review.report, 'object');
  assert.ok(review.report.scene);
});

test('shell transport: ink-agent, scene_edit by path and world_step chained through files', async t => {
  const dir = tempDir(t);
  const { spawnSync } = require('node:child_process');
  const agent = (...args) => spawnSync(path.join(root, 'bin', 'ink-agent'), args, { cwd: dir, encoding: 'utf8' });
  const listed = agent('list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(JSON.parse(listed.stdout).some(tool => tool.name === 'scene_edit'));

  const scene = path.join(dir, 'gem.json');
  fs.copyFileSync(path.join(root, 'examples', 'scene.json'), scene);
  const edited = agent('call', 'scene_edit', JSON.stringify({ scene: { path: scene }, operations: [{ op: 'setMaterial', keys: ['slot:1'], material: 'earth' }] }));
  assert.equal(edited.status, 0, edited.stdout);
  assert.equal(JSON.parse(edited.stdout).result.file, scene);
  assert.equal(JSON.parse(fs.readFileSync(scene, 'utf8')).solids[1].mat, 'earth');
  const rejected = agent('call', 'scene_edit', JSON.stringify({ scene: { path: scene }, operations: [{ op: 'patch', patch: { op: 'replace', path: '/solids/1/kind', value: 'bal' } }] }));
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(scene, 'utf8')).solids[1].kind, 'ball', 'a rejected batch leaves the file alone');
  fails(await call('scene_edit', { scene: { path: 'examples/sculpt.js' }, operations: [{ op: 'setRole', name: 'x', ramp: [1] }] }), 'UNSUPPORTED');

  const actions = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'world-puzzle-gate.actions.json'), 'utf8'));
  const first = path.join(dir, 'step1.json'), second = path.join(dir, 'step2.json');
  ok(await call('world_step', { world: { path: 'examples/world-puzzle-gate.json' }, steps: 5, actions, save: { path: first } }));
  const done = ok(await call('world_step', { world: { path: first }, save: { path: second } }));
  assert.equal(done.scenario.status, 'win');
  assert.equal(done.handle, undefined, 'one-shot steps do not leave sessions behind');
  assert.equal(ok(await call('world_sim', { world: { path: second }, action: 'verify' })).status, 'verified');
  fails(await call('world_sim', { world: { path: second }, action: 'fork' }), 'INVALID_INPUT');
  fails(await call('world_step', { world: { path: first }, save: { path: second } }), 'EXISTS');
});

test('scene_edit repairs an invalid file with patches and ink-agent explains itself', async t => {
  const dir = tempDir(t), file = path.join(dir, 'broken.json');
  fs.copyFileSync(path.join(root, 'evals', '_fixtures', 'broken.json'), file);
  const kindFix = { op: 'patch', patch: { op: 'replace', path: '/solids/2/kind', value: 'ball' } };
  const partial = fails(await call('scene_edit', { scene: { path: file }, operations: [kindFix] }), 'INVALID_SCENE');
  assert.equal(partial.details[0].path, 'bogus');
  const editorOp = fails(await call('scene_edit', { scene: { path: file }, operations: [{ op: 'setMaterial', keys: ['slot:1'], material: 'earth' }] }), 'INVALID_SCENE');
  assert.match(editorOp.hint, /patch/);
  assert.match(fs.readFileSync(file, 'utf8'), /"bal"/, 'failed repairs leave the file alone');
  const repaired = ok(await call('scene_edit', { scene: { path: file }, operations: [kindFix, { op: 'patch', patch: { op: 'remove', path: '/bogus' } }] }));
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.fixed.length, 2);
  assert.equal(ok(await call('scene_validate', { scene: { path: file } })).valid, true);

  const { spawnSync } = require('node:child_process');
  const help = spawnSync(process.execPath, [path.join(root, 'bin', 'ink-agent'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ink-agent call <tool>/);
  assert.match(help.stdout, /scene_edit/);
});

test('world review fixes: no silent overwrite, no empty verify, one-shot note', async t => {
  const dir = tempDir(t), source = path.join(dir, 'gate.json');
  fs.copyFileSync(path.join(root, 'examples', 'world-puzzle-gate.json'), source);
  fails(await call('world_step', { world: { path: source }, steps: 1, save: { path: source } }), 'EXISTS');
  assert.equal(JSON.parse(fs.readFileSync(source, 'utf8')).format, 'ink-studio/world', 'the manifest is untouched');
  fails(await call('world_sim', { world: { path: source }, action: 'verify' }), 'INVALID_INPUT');
  assert.match(ok(await call('world_step', { world: { path: source }, steps: 1 })).note, /not kept/);
});
