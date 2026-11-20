'use strict';
/* The long tail: every command of the human CLI, run as a child process and returned as a JSON envelope (exit code, parsed
   stdout, stderr, files written), plus typed wrappers for the commands that write JSON reports (reviews and looks).
   JavaScript scene files stay behind the same code permission as scene_open. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { defineOp, OpError } = require('../registry.js');
const { compact } = require('../data.js');
const Scenes = require('../scenes.js');

const CLI = path.join(__dirname, '..', '..', 'cli', 'ink-studio.js');
const CODE_FILE = /\.(c?js|mjs)$/i;
const codeAllowed = ctx => ctx.allowCode === true || process.env.INK_AGENT_ALLOW_CODE === '1';

function listFiles(dir, out = new Map()) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(file, out);
    else out.set(file, fs.statSync(file).mtimeMs);
  }
  return out;
}

const clip = (text, max) => (text.length > max ? { text: text.slice(0, max), truncated: text.length - max } : { text });

/* runs `ink-studio <command> ...args` in ctx.root and reports what changed in studio/out */
function runCli(command, args, ctx, { timeoutSeconds = 120, maxChars = 8000 } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(command) || command === 'agent')
    throw new OpError('INVALID_INPUT', 'Not a CLI command: ' + command, { path: '/command', hint: 'see ink_cli with command "help"' });
  const bad = args.findIndex(arg => CODE_FILE.test(arg) && !arg.startsWith('--'));
  if (bad >= 0 && !codeAllowed(ctx))
    throw new OpError('CODE_NOT_ALLOWED', 'JavaScript files run arbitrary code and are disabled', {
      path: '/args/' + bad, hint: 'use a .json diorama or world, or start the server with INK_AGENT_ALLOW_CODE=1'
    });
  const root = ctx.root ?? process.cwd(), outDir = path.join(root, 'studio', 'out');
  const before = listFiles(outDir), started = Date.now();
  const child = spawnSync(process.execPath, [CLI, command, ...args], {
    cwd: root, encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(codeAllowed(ctx) ? { INK_AGENT_ALLOW_CODE: '1' } : {}) }
  });
  if (child.error?.code === 'ETIMEDOUT') throw new OpError('CLI_TIMEOUT', 'The command ran longer than ' + timeoutSeconds + ' s');
  if (child.error) throw new OpError('CLI_FAILED', child.error.message);
  const files = [...listFiles(outDir)].filter(([file, mtime]) => before.get(file) !== mtime).map(([file]) => file);
  let json;
  try {
    json = child.stdout.trim() ? JSON.parse(child.stdout) : undefined;
  } catch {}
  return {
    exitCode: child.status, ok: child.status === 0, durationMs: Date.now() - started,
    ...(json !== undefined ? { json } : { stdout: clip(child.stdout, maxChars) }),
    ...(child.stderr.trim() && { stderr: clip(child.stderr, 4000) }),
    files
  };
}

defineOp({
  name: 'ink_cli',
  title: 'Run any ink-studio CLI command',
  effects: 'expensive',
  destructive: true,
  description: 'Run a command of the ink-studio CLI that has no dedicated tool (e.g. sheet, clip, ghost, passes, crisp, review, shimmer, compare, variants, pose-review, retarget, palette, curve, ornament, paint, reel, mesh, depth, snap, check). args are the words after the command, e.g. ["watcher", "--t", "2", "--n", "6"]. Returns the exit code, stdout (parsed when it is JSON), stderr and files written to studio/out. Use command "help" to list commands and options.',
  input: {
    type: 'object', required: ['command'],
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' }, maxItems: 200 },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 900 },
      maxChars: { type: 'integer', minimum: 500, maximum: 100000, description: 'Characters of non-JSON stdout to return (default 8000).' }
    },
    additionalProperties: false
  },
  run({ command, args = [], timeoutSeconds, maxChars }, ctx) {
    return runCli(command, args, ctx, { timeoutSeconds, maxChars });
  }
});

/* --- scenes as CLI arguments ---------------------------------------------------------------------------------------- */

/* a path the CLI can load for this scene; open dioramas are written beside their source so relative assets resolve */
function sceneArgument(scene, ctx) {
  if (scene.builtin) return { arg: scene.builtin, cleanup() {} };
  if (scene.path && !scene.handle) return { arg: scene.path, cleanup() {} };
  const entry = Scenes.open(scene, { ...ctx, persist: !!scene.handle });
  if (entry.kind === 'builtin') return { arg: entry.descriptor.id, cleanup() {} };
  if (entry.kind === 'script') return { arg: entry.file, cleanup() {} };
  const dir = entry.dir ?? os.tmpdir();
  const file = path.join(dir, '.ink-agent-' + randomUUID().slice(0, 8) + '.json');
  fs.writeFileSync(file, JSON.stringify(Scenes.specOf(entry)));
  return { arg: file, cleanup: () => fs.rmSync(file, { force: true }) };
}

function reportRun(command, positional, args, ctx, { timeoutSeconds } = {}) {
  const report = path.join(os.tmpdir(), 'ink-agent-report-' + randomUUID() + '.json');
  try {
    const result = runCli(command, [...positional, ...args, '--out', report], ctx, { timeoutSeconds });
    if (!fs.existsSync(report)) {
      throw new OpError('CLI_FAILED', (result.stderr?.text ?? result.stdout?.text ?? 'no report was written').trim().split('\n').slice(-3).join(' '), {
        details: { exitCode: result.exitCode }
      });
    }
    return { exitCode: result.exitCode, durationMs: result.durationMs, report: JSON.parse(fs.readFileSync(report, 'utf8')), files: result.files };
  } finally {
    fs.rmSync(report, { force: true });
  }
}

const REVIEWS = {
  'motion-review': 'motion findings, focus ranges and evidence (scene must expose Motion Review)',
  'clip-sequence': 'clip instances, retimed keys and cues, measured handoffs',
  'authored-contacts': 'authored contact ranges and socket transfer timing',
  'motion-fx': 'Motion FX timing, part masks and sampled effect output',
  'animation-timeline': 'shared shot timeline, stages, findings',
  'camera-rig': 'resolved shot, projection, blend and occlusion clearance',
  timeline: 'sampled tracks and exported cues',
  'data-inputs': 'typed source datasets, columns and samples',
  'cloth-review': 'captured cloth pose and settle report'
};

defineOp({
  name: 'scene_review',
  title: 'Run a review report',
  effects: 'expensive',
  description: 'Run one of the CLI review commands that produce a JSON report and return the report: ' +
    Object.entries(REVIEWS).map(([k, v]) => k + ' (' + v + ')').join('; ') + '. args adds CLI options such as ["--at", "1.5"].',
  input: {
    type: 'object', required: ['scene', 'kind'],
    properties: {
      scene: Scenes.sceneSchema,
      kind: { type: 'string', enum: Object.keys(REVIEWS) },
      args: { type: 'array', items: { type: 'string' }, maxItems: 100 },
      timeoutSeconds: { type: 'integer', minimum: 1, maximum: 900 }
    },
    additionalProperties: false
  },
  run({ scene, kind, args = [], timeoutSeconds }, ctx) {
    const { arg, cleanup } = sceneArgument(scene, ctx);
    try {
      return compact({ kind, ...reportRun(kind, [arg], args, ctx, { timeoutSeconds }) });
    } finally {
      cleanup();
    }
  }
});

const LOOK_ACTIONS = ['inspect', 'sample', 'bake', 'import', 'export'];
defineOp({
  name: 'look',
  title: 'Work with looks',
  effects: 'write',
  destructive: true,
  description: 'Looks are versioned colour treatments (LUTs, colour stacks, palettes, asset packs). inspect: bindings, dependencies and targets of a look file, scene or world. sample: colours through a look. bake: compile to a palette or LUT bundle. import: a .cube, .gpl, .pal, .hex or JSON file as a native look. export: convert to json, cube, gpl, pal or hex. Without out, JSON results are returned inline; bake, export and non-JSON formats need out.',
  input: {
    type: 'object', required: ['action', 'file'],
    properties: {
      action: { type: 'string', enum: LOOK_ACTIONS },
      file: { type: 'string', description: 'Look file, or for inspect also a scene or world .json.' },
      out: { type: 'string' },
      args: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'CLI options, e.g. ["--look", "pack/look", "--format", "lut"].' }
    },
    additionalProperties: false
  },
  run({ action, file, out, args = [] }, ctx) {
    if (!out && (action === 'bake' || action === 'export')) throw new OpError('INVALID_INPUT', action + ' needs out', { path: '/out' });
    if (out) {
      const result = runCli('look', [action, file, ...args, '--out', out], ctx);
      if (!result.ok) throw new OpError('CLI_FAILED', (result.stderr?.text ?? 'look ' + action + ' failed').trim(), { details: { exitCode: result.exitCode } });
      const target = path.resolve(ctx.root ?? process.cwd(), out);
      let inline;
      if (target.endsWith('.json') && fs.existsSync(target) && fs.statSync(target).size < 200000) inline = JSON.parse(fs.readFileSync(target, 'utf8'));
      return compact({ action, file: target, ...(inline !== undefined && { result: inline }), ...(result.stderr && { log: result.stderr.text }) });
    }
    return compact({ action, ...reportRun('look', [action, file], args, ctx) });
  }
});

module.exports = { runCli, sceneArgument };
