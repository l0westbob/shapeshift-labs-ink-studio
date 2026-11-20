'use strict';
/* World sessions for agents: a deterministic fixed-tick simulation held in memory under a handle, so an agent can step it,
   query it, fork it and save evidence without reloading files between calls. Sources are world manifests
   (ink-studio/world), checkpoints, run recordings and checkpoint-store references, on disk or inline. */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { OpError } = require('./registry.js');
const Scenes = require('./scenes.js');

const SESSION_LIMIT = 16;
const sessions = new Map();

const W = () => Scenes.kit().KIT.world;
const R = () => W().runtime;
const Store = () => require('../src/simulation-checkpoint-store.js');

const worldSchema = {
  type: 'object',
  description: 'Exactly one of: handle (from world_open), path (world manifest, checkpoint or run recording .json), spec (inline world manifest).',
  properties: {
    handle: { type: 'string' },
    path: { type: 'string' },
    spec: { type: 'object', description: 'An ink-studio/world manifest, checkpoint or run recording object.' }
  },
  additionalProperties: false
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new OpError(error.code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_JSON', error.message, { path: '/world/path' });
  }
}

/* what a document is: { world, checkpoint?, log? }, following checkpoint-store references the way the CLI does */
function classify(value, file) {
  if (value?.format === Store().format) {
    if (!file) throw new OpError('UNSUPPORTED', 'A checkpoint-store reference needs to be opened from a path', { path: '/world/spec' });
    const store = path.resolve(path.dirname(file), value.store);
    value = Store().openCheckpointStore(store).load(value);
  }
  if (value?.format === W().format) {
    if (file && value.dataInputs !== undefined)
      value = { ...value, dataInputs: require('../cli/data-inputs.js').embed(Scenes.kit().KIT.dataInputs, value.dataInputs, file) };
    return { world: value };
  }
  if (value?.format === R().checkpointFormat) return { world: value.world, checkpoint: value };
  if (value?.format === R().runFormat) return { world: value.end.world, checkpoint: value.end, log: value };
  throw new OpError('UNSUPPORTED', 'Expected an ink-studio/world manifest, checkpoint or run recording', {
    path: file ? '/world/path' : '/world/spec', hint: 'got format ' + JSON.stringify(value?.format) + '; scene dioramas use scene_open'
  });
}

function createRun(input, { record = true } = {}) {
  try {
    return R().create(input.world, { checkpoint: input.checkpoint, recordRun: record || undefined });
  } catch (error) {
    throw new OpError('INVALID_WORLD', error.message);
  }
}

function open(source, ctx = {}, { seed, dt, record = true } = {}) {
  const given = ['handle', 'path', 'spec'].filter(key => source?.[key] !== undefined);
  if (given.length !== 1) throw new OpError('INVALID_INPUT', 'Pass exactly one of handle, path, spec in world', { path: '/world' });
  if (source.handle) {
    const entry = sessions.get(source.handle);
    if (!entry) throw new OpError('NOT_FOUND', 'No open world with handle ' + source.handle, { path: '/world/handle', hint: 'call world_open again' });
    entry.used = Date.now();
    return entry;
  }
  const file = source.path && path.resolve(ctx.root ?? process.cwd(), source.path);
  if (file && !file.endsWith('.json')) throw new OpError('UNSUPPORTED', 'World paths must be .json files', { path: '/world/path' });
  const input = classify(file ? readJson(file) : source.spec, file);
  if ((seed !== undefined || dt !== undefined) && input.checkpoint)
    throw new OpError('INVALID_INPUT', 'A checkpoint or recording keeps its own seed and timestep', { path: '/seed' });
  if (seed !== undefined || dt !== undefined) input.world = { ...input.world, ...(seed !== undefined && { seed }), ...(dt !== undefined && { dt }) };
  const entry = { input, file, record, run: createRun(input, { record }) };
  /* one-shot sources (ctx.persist false) never take a session slot, so they cannot evict live handles */
  return ctx.persist === false ? entry : remember(entry);
}

function remember(entry) {
  entry.handle = 'wld_' + randomUUID().slice(0, 8);
  entry.used = Date.now();
  sessions.set(entry.handle, entry);
  if (sessions.size > SESSION_LIMIT) sessions.delete([...sessions.values()].sort((a, b) => a.used - b.used)[0].handle);
  return entry;
}

function fork(entry) {
  return remember({ input: entry.input, file: entry.file, record: entry.record, run: entry.run.fork(), forkedFrom: entry.handle });
}

function reset(entry) {
  entry.run = createRun(entry.input, { record: entry.record });
  return entry;
}

function summary(entry) {
  const run = entry.run, checkpoint = run.checkpoint(), { world, tick } = checkpoint;
  return {
    handle: entry.handle, id: world.id, seed: world.seed, dt: world.dt, tick, time: tick * world.dt,
    systems: Object.keys(checkpoint.states), commands: run.commandCounts(),
    events: checkpoint.history.length, eventsDropped: checkpoint.dropped,
    scenario: run.scenario, recording: !!entry.record
  };
}

/* refuses to replace an existing file without overwrite; pointer names the input field that holds the path */
function checkWritable(file, overwrite, pointer = '/path') {
  if (fs.existsSync(file) && !overwrite)
    throw new OpError('EXISTS', 'A file already exists at ' + file, { path: pointer, hint: 'pass overwrite: true' });
}

function writeJson(file, value, overwrite, pointer) {
  checkWritable(file, overwrite, pointer);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { worldSchema, classify, open, fork, reset, summary, sessions, checkWritable, writeJson, W, R };
