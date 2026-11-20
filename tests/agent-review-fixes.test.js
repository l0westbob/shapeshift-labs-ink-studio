const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const registry = require('../agent/ops/index.js');
const { applyPatch } = require('../agent/data.js');
const Pose = require('../cli/pose.js');

const call = (name, args, ctx = {}) => registry.call(name, args, { root, ...ctx });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-agent-fixes-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
};
const example = () => JSON.parse(fs.readFileSync(path.join(root, 'examples', 'scene.json'), 'utf8'));

test('JSON patches only reach own properties and never Object.prototype', async () => {
  assert.throws(() => applyPatch({ solids: [] }, { op: 'add', path: '/__proto__/polluted', value: 1 }), { code: 'INVALID_PATCH' });
  assert.throws(() => applyPatch({ a: 1 }, { op: 'add', path: '/constructor/prototype/polluted', value: 1 }), { code: 'INVALID_PATCH' });
  assert.throws(() => applyPatch({ a: 1 }, { op: 'remove', path: '/toString' }), { code: 'INVALID_PATCH' });
  assert.equal(({}).polluted, undefined);
  /* ordinary keys that happen to share a prototype name still work as own properties */
  assert.deepEqual(applyPatch({ a: 1 }, { op: 'add', path: '/constructor', value: 2 }), { a: 1, constructor: 2 });

  const opened = ok(await call('scene_open', { scene: { spec: example() }, bake: false }));
  fails(await call('scene_edit', {
    scene: { handle: opened.handle }, operations: [{ op: 'patch', patch: { op: 'add', path: '/__proto__/polluted', value: 'yes' } }]
  }), 'INVALID_PATCH');
  assert.equal(({}).polluted, undefined);
});

test('CLI bridge refuses a project ink-studio.config.js unless code is allowed', async t => {
  const dir = tempDir(t);
  const marker = path.join(dir, 'ran.txt');
  fs.writeFileSync(path.join(dir, 'ink-studio.config.js'), 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x"); module.exports = {};\n');
  fails(await call('ink_cli', { command: 'scenes' }, { root: dir }), 'CODE_NOT_ALLOWED');
  assert.equal(fs.existsSync(marker), false, 'the config did not run');
  const allowed = ok(await call('ink_cli', { command: 'scenes' }, { root: dir, allowCode: true }));
  assert.equal(allowed.exitCode, 0);
  assert.equal(fs.existsSync(marker), true, 'with permission the CLI runs as usual');
});

test('world_step checks save before the world moves', async t => {
  const dir = tempDir(t);
  const existing = path.join(dir, 'taken.json');
  fs.writeFileSync(existing, '{}\n');
  const opened = ok(await call('world_open', { world: { path: 'examples/world-puzzle-gate.json' } }));
  const error = fails(await call('world_step', { world: { handle: opened.handle }, steps: 5, save: { path: existing } }), 'EXISTS');
  assert.equal(error.path, '/save/path');
  fails(await call('world_step', { world: { handle: opened.handle }, steps: 5, save: { path: path.join(dir, 'run.txt') } }), 'INVALID_INPUT');
  const still = ok(await call('world_query', { world: { handle: opened.handle }, action: 'inspect' }));
  assert.equal(still.tick, opened.tick, 'a refused save leaves the handle where it was');
  const saved = ok(await call('world_step', { world: { handle: opened.handle }, steps: 5, save: { path: existing, overwrite: true } }));
  assert.equal(saved.tick, opened.tick + 5);
});

test('scene_edit batches: patches validate at the end, reload assets and measure the rendered view once', async t => {
  const dir = tempDir(t);
  const opened = ok(await call('scene_open', { scene: { spec: example() }, bake: false }));
  /* the first patch alone leaves an invalid ball (no r); the batch is judged by its result */
  const edited = ok(await call('scene_edit', {
    scene: { handle: opened.handle },
    operations: [
      { op: 'patch', patch: { op: 'add', path: '/solids/-', value: { kind: 'ball', at: [1, 1, 0], mat: 'stone' } } },
      { op: 'patch', patch: { op: 'add', path: '/solids/2/r', value: 0.3 } }
    ]
  }));
  assert.notEqual(edited.revision, opened.revision);
  /* a keyed operation still needs a valid scene before it */
  fails(await call('scene_edit', {
    scene: { handle: opened.handle },
    operations: [
      { op: 'patch', patch: { op: 'remove', path: '/solids/2/r' } },
      { op: 'setMaterial', keys: ['slot:1'], material: 'stone' }
    ]
  }), 'INVALID_SCENE');

  /* a mesh added by a patch is loaded beside the scene file */
  fs.writeFileSync(path.join(dir, 'rock.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n');
  const file = path.join(dir, 'scene.json');
  fs.writeFileSync(file, JSON.stringify(example()));
  const fromFile = ok(await call('scene_open', { scene: { path: file }, bake: false }));
  const withMesh = ok(await call('scene_edit', {
    scene: { handle: fromFile.handle },
    operations: [{ op: 'patch', patch: { op: 'add', path: '/solids/-', value: { kind: 'mesh', asset: 'rock.obj', at: [1, 0, 0], size: 1 } } }],
    render: { size: { w: 160, h: 100 } }, measure: ['values']
  }));
  assert.ok(withMesh.metrics.values.verdict, 'measured');
  assert.ok(withMesh.image, 'rendered');

  /* measuring an edit with a single render draws one picture */
  const Render = require('../cli/render.js'), draw = Render.render;
  let draws = 0;
  Render.render = (...args) => (draws++, draw(...args));
  t.after(() => { Render.render = draw; });
  ok(await call('scene_edit', {
    scene: { handle: opened.handle }, operations: [{ op: 'setMaterial', keys: ['slot:1'], material: 'stone' }],
    render: { size: { w: 160, h: 100 } }, measure: ['values', 'lint']
  }));
  assert.equal(draws, 1);
});

test('a world held by a cloth cadence is behind when cloth has passed t', () => {
  const direction = { cadence: { scene: 12, cloth: 30 } };
  const world = { anim: { stateful: true }, clock: Math.floor(0.49 * 12 + 1e-8) / 12, clothClock: 0.49 };
  assert.equal(Pose.behind(world, 0.45, direction), true, 'cloth already ran past 0.45');
  assert.equal(Pose.behind(world, 0.49, direction), false);
  assert.equal(Pose.behind(world, 0.6, direction), false);
  assert.equal(Pose.behind({ anim: {}, clock: 5 }, 1, direction), false, 'stateless worlds are never behind');
  assert.throws(() => Pose.pose(world, 0.45, { direction }), { code: 'BACKWARDS' });
});

test('reopening a JS scene picks up edits through symlinked paths', async t => {
  const dir = fs.realpathSync(tempDir(t)), link = path.join(tempDir(t), 'linked');
  fs.symlinkSync(dir, link);
  const write = count => fs.writeFileSync(path.join(dir, 'piece.js'),
    'module.exports = ({ makeBuilder }) => ({ id: "piece", name: "Piece", seed: 1, build(seed) {\n' +
    '  const B = makeBuilder(seed); for (let i = 0; i < ' + count + '; i++) B.iso(i * 0.1, 1, 0, 0.05, B.P[4], 0, {});\n' +
    '  return B.finish({ cam: { target: [0, 1, 0], dist: 6, pitch: 0.2, yaw: 0 } }); } });\n');
  write(10);
  const first = ok(await call('scene_open', { scene: { path: path.join(link, 'piece.js') } }, { allowCode: true }));
  write(30);
  const second = ok(await call('scene_open', { scene: { path: path.join(link, 'piece.js') } }, { allowCode: true }));
  assert.ok(second.splats > first.splats, 'the edited scene was loaded: ' + first.splats + ' -> ' + second.splats);
});

test('MCP server: ink_cli is not idempotent and prototype names are not methods', async t => {
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
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const tools = (await rpc('tools/list', {})).result.tools;
  const hint = name => tools.find(tool => tool.name === name).annotations.idempotentHint;
  assert.equal(hint('ink_cli'), false);
  assert.equal(hint('scene_save'), true);
  assert.equal(hint('scene_render'), true);
  for (const method of ['constructor', 'toString', 'hasOwnProperty'])
    assert.equal((await rpc(method, {})).error?.code, -32601, method);
});

test('the write hook reports a diorama without id and still ignores foreign JSON', t => {
  const dir = tempDir(t);
  const hook = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return spawnSync(process.execPath, [path.join(root, 'agent', 'hooks', 'validate-on-write.js')], {
      input: JSON.stringify({ tool_input: { file_path: file }, cwd: dir }), encoding: 'utf8'
    });
  };
  const { id, ...anonymous } = example();
  const missing = hook('anonymous.json', anonymous);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /id/);
  assert.equal(hook('foreign.json', { solids: [{ kind: 'granite' }, { kind: 'basalt' }] }).status, 0);
  assert.equal(hook('empty.json', { solids: [] }).status, 0);
});

test('play pools follow the builder seed', () => {
  const { makeBuilder, KIT: K } = require('..').load();
  const sparks = seed => {
    const B = makeBuilder(seed, K.diorama.styles.slate.palette);
    assert.equal(B.seed, seed >>> 0);
    const pieces = K.shatter(B, 16);
    const world = B.finish({ cam: { target: [0, 1, 0], dist: 8, pitch: 0.2, yaw: 0.4 }, detail: 10 });
    pieces.bind(world, world.count - 16);
    pieces.burst([new Float32Array(16).fill(0.5)], [0, 1, 0], 4, 0, undefined);
    pieces.update(1 / 30);
    return Array.from(world.data.slice((world.count - 16) * 16));
  };
  assert.deepEqual(sparks(3), sparks(3));
  assert.notDeepEqual(sparks(3), sparks(4));
});

test('duplicate keys are reported by validate, open and the hook, and a path edit removes them', async t => {
  const { duplicateKeys } = require('../agent/data.js');
  assert.deepEqual(duplicateKeys('{"a":1,"b":{"a":"x\\"a","a":2},"c":[{"k":1},{"k":2,"k":3}],"a":4}').map(d => d.path), ['b.a', 'c[1].k', 'a']);
  assert.deepEqual(duplicateKeys(fs.readFileSync(path.join(root, 'examples', 'scene.json'), 'utf8')), []);

  const dir = tempDir(t), file = path.join(dir, 'twice.json');
  /* the typo stays in the file while a second "kind" makes it parse as a ball */
  const text = JSON.stringify(example(), null, 2).replace('"kind": "ball",', '"kind": "bal",\n      "kind": "ball",');
  assert.ok(text.includes('"bal"'));
  fs.writeFileSync(file, text);

  const report = ok(await call('scene_validate', { scene: { path: file } }));
  assert.equal(report.valid, false);
  assert.equal(report.errors[0].path, 'solids[1].kind');
  assert.match(report.errors[0].problem, /duplicate key "kind"/);
  const refused = fails(await call('scene_open', { scene: { path: file } }), 'INVALID_SCENE');
  assert.equal(refused.details[0].path, 'solids[1].kind');

  const hook = spawnSync(process.execPath, [path.join(root, 'agent', 'hooks', 'validate-on-write.js')], {
    input: JSON.stringify({ tool_input: { file_path: file }, cwd: dir }), encoding: 'utf8'
  });
  assert.equal(hook.status, 2);
  assert.match(hook.stderr, /duplicate key "kind"/);

  const repaired = ok(await call('scene_edit', {
    scene: { path: file }, operations: [{ op: 'patch', patch: { op: 'replace', path: '/solids/1/kind', value: 'ball' } }]
  }));
  assert.equal(repaired.repaired, true);
  assert.ok(repaired.fixed.some(problem => /duplicate key/.test(problem.problem)));
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(written.includes('"bal"'), false);
  assert.deepEqual(duplicateKeys(written), []);
  assert.equal(ok(await call('scene_validate', { scene: { path: file } })).valid, true);
});
