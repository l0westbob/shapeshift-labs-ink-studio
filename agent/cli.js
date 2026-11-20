'use strict';
/* `ink-studio agent ...`: the agent operations from a shell, one call per process, JSON in and JSON out.

     ink-studio agent list                       op names, descriptions and input schemas
     ink-studio agent call <op> '<json>'          run an op; '-' reads the JSON from stdin
     ink-studio agent mcp [--allow-code]          serve the ops over MCP stdio

   Exit codes: 0 success, 1 operation error, 2 bad usage. Images are not printed; pass "out" to write them. */
const fs = require('node:fs');

module.exports = async function agentCli(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'mcp') for (const method of ['log', 'info', 'warn', 'debug']) console[method] = (...args) => console.error(...args);
  const registry = require('./registry.js');
  require('./ops/index.js');
  const print = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (sub === 'list') {
    print(registry.list().map(op => ({ name: op.name, effects: op.effects, description: op.description, input: op.input })));
    return 0;
  }
  if (sub === 'mcp') {
    process.argv = [process.argv[0], require.resolve('./mcp-server.js'), ...rest];
    require('./mcp-server.js');
    return undefined;
  }
  if (sub === 'call' && rest[0]) {
    let input = {};
    try {
      const text = rest[1] === '-' ? fs.readFileSync(0, 'utf8') : rest[1];
      if (text) input = JSON.parse(text);
    } catch (error) {
      print({ ok: false, error: { code: 'INVALID_JSON', message: error.message } });
      return 2;
    }
    const outcome = await registry.call(rest[0], input, { allowCode: rest.includes('--allow-code') });
    if (outcome.ok && outcome.result.image) {
      const { image, ...result } = outcome.result;
      const bytes = Math.round((image.base64.length * 3) / 4);
      outcome.result = { ...result, image: { mimeType: image.mimeType, bytes, ...(result.file ? {} : { note: 'pass "out" to write the PNG' }) } };
    }
    print(outcome);
    return outcome.ok ? 0 : 1;
  }
  print({ ok: false, error: { code: 'USAGE', message: 'ink-studio agent list | call <op> <json|-> [--allow-code] | mcp [--allow-code]' } });
  return 2;
};

/* `ink-studio stats|lint|crisp|values <scene> --json`: the classic measuring commands answered by the agent ops, so scripts
   get the same JSON an agent gets. Times default as in the classic commands (lint and crisp look at t = 2). validate is not
   mapped: it already has its own --json for worlds, looks and look bindings. */
const LEGACY_JSON = ['stats', 'lint', 'crisp', 'values'];
const DEFAULT_TIME = { stats: 0, lint: 2, crisp: 2, values: 0 };

async function legacyJson(cmd, pos, opt) {
  for (const method of ['log', 'info', 'warn', 'debug']) console[method] = (...args) => console.error(...args);
  const registry = require('./registry.js');
  require('./ops/index.js');
  const ctx = { allowCode: true, root: process.cwd() };
  const number = key => (opt[key] === undefined ? undefined : Number(opt[key]));
  const source = id => ({
    ...(/\.(json|c?js)$/i.test(id) ? { path: id } : { builtin: id }),
    ...(opt.seed !== undefined && { seed: Number(opt.seed) })
  });
  const ids = pos.length ? pos : [];
  if (!ids.length) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'USAGE', message: 'ink-studio ' + cmd + ' <scene ...> --json' } }) + '\n');
    return 2;
  }
  const outcomes = [];
  for (const id of ids) {
    const view = Object.fromEntries(['yaw', 'pitch', 'zoom'].map(k => [k, number(k)]).filter(([, v]) => v !== undefined));
    if (opt.target) view.target = String(opt.target).split(',').map(Number);
    if (opt.ortho) view.ortho = true;
    const size = { w: number('w') ?? 900, h: number('h') ?? 620 };
    outcomes.push(await registry.call('scene_measure', {
      scene: source(id), metrics: [cmd], t: number('t') ?? DEFAULT_TIME[cmd], view, size,
      look: { colored: !!opt.colored, raw: !!opt.raw }
    }, ctx));
  }
  process.stdout.write(JSON.stringify(outcomes.length === 1 ? outcomes[0] : outcomes) + '\n');
  return outcomes.some(o => !o.ok) ? 1 : 0;
}

module.exports.LEGACY_JSON = LEGACY_JSON;
module.exports.legacyJson = legacyJson;
