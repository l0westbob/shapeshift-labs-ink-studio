const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const registry = require('../agent/registry.js');
require('../agent/ops/index.js');
const { applyPatch, compact, diff, revisionOf } = require('../agent/data.js');

const TOOLS = [
  'ink_docs', 'ink_discover', 'scene_validate', 'scene_open', 'scene_render', 'scene_measure', 'scene_edit', 'scene_save',
  'scene_query', 'scene_export', 'model_build', 'model_three', 'scene_fit', 'model_rank', 'world_open', 'world_step', 'world_query', 'world_sim', 'ink_cli', 'scene_review', 'look'
];
const example = path.join(root, 'examples', 'scene.json');
const gem = JSON.parse(fs.readFileSync(example, 'utf8'));
const call = (name, args, ctx) => registry.call(name, args, { root, ...ctx });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-agent-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
};
const isPng = base64 => Buffer.from(base64, 'base64').subarray(1, 4).toString() === 'PNG';

test('data helpers round floats, hash canonically, diff and patch', () => {
  assert.deepEqual(compact({ a: 1.2999999999999998, b: [3, 0.123456789], c: undefined }), { a: 1.3, b: [3, 0.1235] });
  assert.equal(revisionOf({ a: 1, b: 2 }), revisionOf({ b: 2, a: 1 }));
  assert.deepEqual(diff({ a: [1], b: 1 }, { a: [1, 2], c: 1 }), [
    { path: '/a/1', change: 'added' }, { path: '/b', change: 'removed' }, { path: '/c', change: 'added' }
  ]);
  const doc = { list: [1, 3] };
  assert.deepEqual(applyPatch(doc, { op: 'add', path: '/list/1', value: 2 }), { list: [1, 2, 3] });
  assert.deepEqual(doc, { list: [1, 3] }, 'patches work on a copy');
  assert.deepEqual(applyPatch(doc, { op: 'move', from: '/list/0', path: '/first' }), { list: [3], first: 1 });
  assert.throws(() => applyPatch(doc, { op: 'test', path: '/list/0', value: 9 }), { code: 'INVALID_PATCH' });
  assert.throws(() => applyPatch(doc, { op: 'remove', path: '/missing' }), { code: 'INVALID_PATCH' });
});

test('input schemas reject unknown fields and wrong types with every problem listed', async () => {
  const error = fails(await call('scene_render', { scene: { builtin: 'idol' }, t: -1, size: { w: 'big' }, extra: true }), 'INVALID_INPUT');
  assert.deepEqual(error.details.map(d => d.path).sort(), ['/extra', '/size/w', '/t']);
  fails(await call('scene_render', { scene: { builtin: 'idol', spec: {} } }), 'INVALID_INPUT');
  fails(await call('scene_nothing', {}), 'UNKNOWN_OP');
});

test('scene_validate reports structured problems with hints', async t => {
  const broken = { ...gem, bogus: 1, solids: [...gem.solids, { kind: 'bal', at: [0, 1, 0], r: 0.5, mat: 'accent' }] };
  const result = ok(await call('scene_validate', { scene: { spec: broken } }));
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(e => e.path), ['bogus', 'solids[2].kind']);
  assert.match(result.errors[1].hint, /ball/);
  assert.equal(ok(await call('scene_validate', { scene: { path: example } })).valid, true);
  const file = path.join(tempDir(t), 'broken.json');
  fs.writeFileSync(file, '{ not json');
  assert.equal(ok(await call('scene_validate', { scene: { path: file } })).valid, false);
});

test('a diorama opens once, renders from cache and measures numerically', async () => {
  const opened = ok(await call('scene_open', { scene: { path: example } }));
  assert.match(opened.handle, /^scn_/);
  assert.equal(opened.editable, true);
  assert.equal(opened.solids, 2);
  assert.ok(opened.splats > 0 && opened.roles.includes('accent'));
  const scene = { handle: opened.handle };

  const rendered = ok(await call('scene_render', { scene, t: 1, size: { w: 320, h: 200 } }));
  assert.ok(isPng(rendered.image.base64));
  assert.equal(rendered.revision, opened.revision);
  assert.ok(rendered.artWidth <= 320 && rendered.width >= rendered.artWidth);
  const again = ok(await call('scene_render', { scene, t: 1, size: { w: 320, h: 200 } }));
  assert.equal(again.image.base64, rendered.image.base64, 'rendering is deterministic');

  const metrics = ok(await call('scene_measure', { scene, metrics: ['stats', 'lint', 'crisp', 'values'] }));
  assert.equal(metrics.stats.splats.total, opened.splats);
  assert.ok(metrics.stats.palette.used.length > 0);
  for (const key of ['orphans', 'jaggies', 'noise']) assert.equal(typeof metrics.lint[key], 'number');
  assert.equal(typeof metrics.crisp.pass, 'boolean');
  assert.ok(['FLAT', 'ONE_TONE', 'TWO_TONES', 'THREE_TONES'].includes(metrics.values.verdict));
});

test('scene_edit applies batches atomically and guards revisions', async t => {
  const opened = ok(await call('scene_open', { scene: { spec: gem }, bake: false }));
  const scene = { handle: opened.handle };
  const ball = { kind: 'ball', at: [1.5, 0.6, 0], r: 0.5, mat: 'accent', res: 0.12 };

  fails(await call('scene_edit', { scene, baseRevision: 'stale', operations: [{ op: 'setMaterial', keys: ['slot:1'], material: 'earth' }] }), 'STALE_REVISION');
  const invalid = fails(await call('scene_edit', { scene, operations: [
    { op: 'patch', patch: { op: 'add', path: '/solids/-', value: ball } },
    { op: 'patch', patch: { op: 'add', path: '/solids/-', value: { ...ball, kind: 'bal' } } }
  ] }), 'INVALID_SCENE');
  assert.equal(invalid.details[0].path, 'solids[3].kind');
  assert.equal(ok(await call('scene_open', { scene, bake: false })).revision, opened.revision, 'a failed batch changes nothing');

  const preview = ok(await call('scene_edit', { scene, dryRun: true, operations: [{ op: 'patch', patch: { op: 'add', path: '/solids/-', value: ball } }], render: { size: { w: 160, h: 100 } } }));
  assert.ok(isPng(preview.image.base64));
  assert.equal(ok(await call('scene_open', { scene, bake: false })).revision, opened.revision, 'dry runs change nothing');

  const edited = ok(await call('scene_edit', { scene, baseRevision: opened.revision, measure: ['lint'], operations: [
    { op: 'patch', patch: { op: 'add', path: '/solids/-', value: ball } },
    { op: 'setTransform', keys: ['slot:1'], patch: { translation: [0, 0.5, 0] } }
  ] }));
  assert.equal(edited.previousRevision, opened.revision);
  assert.notEqual(edited.revision, opened.revision);
  assert.deepEqual(edited.changes.map(c => c.path), ['/solids/1/transform', '/solids/2']);
  assert.equal(typeof edited.metrics.lint.orphans, 'number');

  const reverted = ok(await call('scene_edit', { scene, operations: [{ op: 'revert', revision: opened.revision }] }));
  assert.equal(reverted.revision, opened.revision);

  const dir = tempDir(t);
  const saved = ok(await call('scene_save', { scene, path: path.join(dir, 'gem.json') }));
  assert.equal(revisionOf(JSON.parse(fs.readFileSync(saved.file, 'utf8'))), saved.revision);
  assert.equal(ok(await call('scene_save', { scene })).file, saved.file, 'later saves default to the saved file');
  fs.writeFileSync(path.join(dir, 'other.json'), '{}');
  fails(await call('scene_save', { scene, path: path.join(dir, 'other.json') }), 'EXISTS');
});

test('built-in scenes render but are not editable, and JS scenes need explicit permission', async () => {
  const sheet = ok(await call('scene_render', { scene: { builtin: 'idol' }, mode: 'turn', frames: 4, size: { w: 96, h: 96 } }));
  assert.equal(sheet.columns, 4);
  assert.ok(isPng(sheet.image.base64));
  const opened = ok(await call('scene_open', { scene: { builtin: 'idol' }, bake: false }));
  fails(await call('scene_edit', { scene: { handle: opened.handle }, operations: [{ op: 'setRole', name: 'x', ramp: [1] }] }), 'NOT_EDITABLE');
  fails(await call('scene_open', { scene: { builtin: 'nope' } }), 'NOT_FOUND');
  fails(await call('scene_open', { scene: { path: 'examples/sculpt.js' } }), 'CODE_NOT_ALLOWED');
  assert.equal(ok(await call('scene_open', { scene: { path: 'examples/sculpt.js' }, bake: false }, { allowCode: true })).kind, 'script');
});

test('the agent CLI prints JSON and uses exit codes', () => {
  const cli = path.join(root, 'cli', 'ink-studio.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'agent', ...args], { cwd: root, encoding: 'utf8' });
  const listed = run('list');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).map(op => op.name), TOOLS);
  const valid = run('call', 'scene_validate', JSON.stringify({ scene: { path: 'examples/scene.json' } }));
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).result.valid, true);
  const missing = run('call', 'scene_open', JSON.stringify({ scene: { path: 'missing.json' } }));
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).error.code, 'NOT_FOUND');
  assert.equal(run('call').status, 2);
});

test('the MCP server lists tools and returns images as content', async t => {
  const server = spawn(process.execPath, [path.join(root, 'agent', 'mcp-server.js'), '--root', root]);
  t.after(() => server.kill());
  let buffer = '';
  const waiting = new Map();
  server.stdout.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0; ) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(resolve => {
    waiting.set(++id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ink-studio');
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const { tools } = (await rpc('tools/list', {})).result;
  assert.deepEqual(tools.map(tool => tool.name), TOOLS);
  assert.equal(tools.find(tool => tool.name === 'scene_save').annotations.destructiveHint, true);
  assert.equal(tools.find(tool => tool.name === 'world_query').annotations.readOnlyHint, true);

  const opened = await rpc('tools/call', { name: 'scene_open', arguments: { scene: { path: 'examples/scene.json' } } });
  const { handle } = opened.result.structuredContent;
  const rendered = await rpc('tools/call', { name: 'scene_render', arguments: { scene: { handle }, size: { w: 160, h: 100 } } });
  assert.deepEqual(rendered.result.content.map(c => c.type), ['text', 'image']);
  assert.equal(rendered.result.content[1].mimeType, 'image/png');
  assert.ok(isPng(rendered.result.content[1].data));

  const failed = await rpc('tools/call', { name: 'scene_edit', arguments: { scene: { handle: 'scn_missing' }, operations: [{ op: 'revert', revision: 'x' }] } });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.error.code, 'NOT_FOUND');
  assert.equal((await rpc('nothing/here', {})).error.code, -32601);
});
