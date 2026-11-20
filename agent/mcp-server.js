#!/usr/bin/env node
'use strict';
/* ink-studio as an MCP server over stdio (newline-delimited JSON-RPC 2.0). Dependency-free on purpose: it speaks the
   small part of the protocol a tool server needs (initialize, ping, tools/list, tools/call) and exposes every op in the
   registry as a tool. stdout carries only protocol messages, so all console output from the toolkit goes to stderr.

     node agent/mcp-server.js [--root DIR] [--allow-code]

   --root sets the directory relative paths resolve against (default: $CLAUDE_PROJECT_DIR, else the working directory).
   --allow-code (or INK_AGENT_ALLOW_CODE=1) lets scene_open run JavaScript scene files. */
const readline = require('node:readline');

for (const method of ['log', 'info', 'warn', 'debug']) console[method] = (...args) => console.error(...args);

const registry = require('./registry.js');
require('./ops/index.js');
const { version } = require('../package.json');

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const args = process.argv.slice(2);
const flag = name => args.indexOf(name);
const ctx = {
  /* relative paths resolve against --root, else the Claude Code project (plugin servers may start elsewhere), else cwd */
  root: require('node:path').resolve(flag('--root') >= 0 ? args[flag('--root') + 1] ?? '.' : process.env.CLAUDE_PROJECT_DIR || process.cwd()),
  allowCode: flag('--allow-code') >= 0
};

const INSTRUCTIONS = [
  'ink-studio sculpts signed-distance solids into pixel-art Gaussian splats, renders them on the CPU and runs deterministic world simulations.',
  'Start with ink_discover (overview, search, schema "diorama") and ink_docs.',
  'Scene loop: scene_validate a JSON diorama, scene_open it to get a handle, scene_render to look, scene_measure for numbers,',
  'scene_edit with baseRevision (add render/measure to see the result in one call), scene_save to keep it, scene_export for GLB or sprite atlases.',
  'Worlds: world_open, world_step with actions, world_query, world_sim to fork, verify, diff and save; worlds only run forwards.',
  'Everything else the CLI can do: scene_review, look, and ink_cli for any command.',
  'Relative paths resolve against ' + ctx.root + '; prefer absolute paths. Errors come back as { code, message, path, hint, details }; fix the input at path and retry.',
  'Note: "agents" inside scene data means simulated characters, not you.'
].join(' ');

function toolOf(op) {
  return {
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: op.input,
    annotations: {
      title: op.title,
      readOnlyHint: op.effects === 'read' || op.readOnly === true,
      destructiveHint: !!op.destructive,
      idempotentHint: op.idempotent ?? op.effects !== 'write',
      openWorldHint: false
    }
  };
}

async function callTool(params) {
  const outcome = await registry.call(params?.name, params?.arguments ?? {}, ctx);
  if (!outcome.ok)
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }], structuredContent: { error: outcome.error } };
  const { image, ...data } = outcome.result;
  const content = [{ type: 'text', text: JSON.stringify(data) }];
  if (image) content.push({ type: 'image', data: image.base64, mimeType: image.mimeType });
  return { content, structuredContent: data };
}

const handlers = {
  initialize(params) {
    const requested = params?.protocolVersion;
    return {
      protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'ink-studio', title: 'ink-studio', version },
      instructions: INSTRUCTIONS
    };
  },
  ping: () => ({}),
  'tools/list': () => ({ tools: registry.list().map(toolOf) }),
  'tools/call': callTool
};

const send = message => process.stdout.write(JSON.stringify(message) + '\n');

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  const isNotification = message.id === undefined;
  const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined;
  if (isNotification) return;
  if (!handler) return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found: ' + message.method } });
  try {
    send({ jsonrpc: '2.0', id: message.id, result: await handler(message.params) });
  } catch (error) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
}

/* requests are answered one at a time, in order: renders are CPU-bound and sessions are shared */
let queue = Promise.resolve();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const batch = Array.isArray(message) ? message : [message];
  queue = queue.then(() => batch.reduce((p, m) => p.then(() => handle(m)), Promise.resolve()));
});
lines.on('close', () => queue.then(() => process.exit(0)));
