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
  require('./ops.js');
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
