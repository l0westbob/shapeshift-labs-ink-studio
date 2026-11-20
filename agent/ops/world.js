'use strict';
/* World simulation tools: open a deterministic world, step it with scheduled actions, query its published state and
   manage branches and evidence (fork, reset, save, verify, diff). "agents" inside a world are simulated characters. */
const path = require('node:path');
const { defineOp, OpError } = require('../registry.js');
const { compact } = require('../data.js');
const Worlds = require('../worlds.js');

const handleOnly = {
  type: 'object', required: ['handle'], properties: { handle: { type: 'string' } }, additionalProperties: false
};
const wrap = (code, fn) => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof OpError) throw error;
    throw new OpError(code, error.message);
  }
};

defineOp({
  name: 'world_open',
  title: 'Open a world simulation',
  effects: 'expensive',
  description: 'Open a deterministic fixed-tick world (an ink-studio/world manifest, checkpoint or run recording) and keep it running in memory. Returns a handle, tick, systems, scenario status and what can be queried: field and trace names and the action kinds accepted by world_step. Recording is on by default so the run can be verified and saved.',
  input: {
    type: 'object', required: ['world'],
    properties: {
      world: Worlds.worldSchema,
      seed: { type: 'integer', description: 'Seed override for a manifest.' },
      dt: { type: 'number', minimum: 0.0001, maximum: 1, description: 'Tick duration override in seconds for a manifest.' },
      record: { type: 'boolean', description: 'Retain a reproducible run recording (default true).' }
    },
    additionalProperties: false
  },
  run({ world, seed, dt, record = true }, ctx) {
    const entry = Worlds.open(world, ctx, { seed, dt, record });
    const query = entry.run.query().inspect();
    return compact({
      ...Worlds.summary(entry),
      ...(entry.file && { file: entry.file }),
      entities: query.entities.length,
      fields: query.fields.map(f => f.name),
      traces: query.traces.map(t => t.name),
      actions: query.actions,
      until: entry.run.view().world.scenario?.until
    });
  }
});

defineOp({
  name: 'world_step',
  title: 'Advance a world',
  effects: 'write',
  description: 'Schedule actions and advance an open world. Give exactly one of ticks (absolute), steps (relative) or t (seconds); with none, runs to the scenario\'s until tick. actions are commands like { id, tick, action: "world/input", args: { port: "system/port", value } }; invalid actions are rejected before anything advances. Returns the new tick, scenario status and the events emitted during the step.',
  input: {
    type: 'object', required: ['world'],
    properties: {
      world: handleOnly,
      ticks: { type: 'integer', minimum: 0 },
      steps: { type: 'integer', minimum: 0, maximum: 1000000 },
      t: { type: 'number', minimum: 0 },
      actions: { type: 'array', items: { type: 'object' }, maxItems: 10000 },
      stopOnOutcome: { type: 'boolean', description: 'Stop early when the scenario wins, fails or times out.' },
      maxEvents: { type: 'integer', minimum: 0, maximum: 500, description: 'Events to return (default 25, newest last).' }
    },
    additionalProperties: false
  },
  run({ world, ticks, steps, t, actions, stopOnOutcome = false, maxEvents = 25 }, ctx) {
    const entry = Worlds.open(world, ctx);
    const run = entry.run, before = run.view();
    const modes = [ticks, steps, t].filter(v => v !== undefined);
    if (modes.length > 1) throw new OpError('INVALID_INPUT', 'Give only one of ticks, steps or t', { path: '/ticks' });
    const until = before.world.scenario?.until;
    const target = ticks ?? (steps !== undefined ? before.tick + steps : t !== undefined ? Math.floor(t / before.world.dt + 1e-10) : until);
    if (target === undefined) throw new OpError('INVALID_INPUT', 'Give ticks, steps or t; this world has no scenario until tick', { path: '/steps' });
    if (target < before.tick) throw new OpError('INVALID_INPUT', 'The world is at tick ' + before.tick + ' and only runs forwards', {
      path: '/ticks', hint: 'use world_sim reset or a fork taken earlier'
    });
    if (actions?.length) wrap('INVALID_ACTIONS', () => run.schedule(actions));
    const seen = new Set(before.history.map(event => event.id));
    try {
      run.advance(target, { stopOnOutcome });
    } catch (error) {
      throw new OpError('STEP_FAILED', error.message, { details: { tick: run.view().tick } });
    }
    const after = run.view();
    const fresh = after.history.filter(event => !seen.has(event.id));
    return compact({
      handle: entry.handle, from: before.tick, tick: after.tick, time: after.time, scenario: run.scenario,
      commands: run.commandCounts(), newEvents: fresh.length, events: maxEvents ? fresh.slice(-maxEvents) : [],
      ...(fresh.length > maxEvents && { eventsTruncated: fresh.length - maxEvents })
    });
  }
});

const QUERY_ACTIONS = ['inspect', 'spatial', 'select', 'probe', 'trace', 'export'];
defineOp({
  name: 'world_query',
  title: 'Query a world',
  effects: 'read',
  description: 'Read the published state of an open world at its current tick. inspect: entities, fields, traces, systems, actions (where filters entities). spatial: entities near point within radius. select: resolve look targets. probe: sample a field at a target. trace: follow a named trace such as "world/cause" or a system\'s "why". export: sample a field over a line or grid spec. Field and trace names come from world_open.',
  input: {
    type: 'object', required: ['world', 'action'],
    properties: {
      world: Worlds.worldSchema,
      action: { type: 'string', enum: QUERY_ACTIONS },
      name: { type: 'string', description: 'Field (probe, export) or trace (trace) name.' },
      target: { type: 'object', description: '{ point: [x, y, z] } or { entity, socket? } or a look selector (select).' },
      args: { type: 'object', description: 'Extra query arguments, e.g. { explain: true }.' },
      spec: { type: 'object', description: 'export: line, grid or time-series sampling spec; spatial-batch probe: the batch spec.' },
      point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'spatial: search centre.' },
      radius: { type: 'number', minimum: 0, description: 'spatial: search radius.' },
      where: { type: 'object', description: 'inspect/spatial: entity filter.' }
    },
    additionalProperties: false
  },
  run({ world, action, name, target, args = {}, spec, point, radius, where }, ctx) {
    const entry = Worlds.open(world, ctx);
    const query = entry.run.query();
    const needs = (value, field) => {
      if (value === undefined) throw new OpError('INVALID_INPUT', action + ' needs ' + field, { path: '/' + field });
    };
    const result = wrap('QUERY_FAILED', () => {
      switch (action) {
        case 'inspect': return query.inspect({ where });
        case 'spatial': needs(point, 'point'); return query.spatial({ point, radius: radius ?? 1, where });
        case 'select': return { targets: query.select(target) };
        case 'probe':
          needs(name, 'name');
          return spec ? query.probe(name, {}, spec) : query.probe(name, target ?? {}, args);
        case 'trace': needs(name, 'name'); return query.trace(name, target ?? {}, args);
        case 'export': needs(name, 'name'); needs(spec, 'spec'); return query.export(name, spec, args);
      }
    });
    if (result?.status === 'unavailable')
      throw new OpError('NOT_FOUND', result.reason ?? 'not available', { path: '/name', hint: 'list names with world_query inspect' });
    return compact({ handle: entry.handle, tick: entry.run.view().tick, action, ...(name && { name }), result });
  }
});

const SIM_ACTIONS = ['plan', 'fork', 'reset', 'save', 'verify', 'diff', 'close'];
defineOp({
  name: 'world_sim',
  destructive: true,
  title: 'Manage world branches and evidence',
  effects: 'write',
  description: 'plan: system contracts and resolved execution order. fork: branch the world at its current tick into a new handle. reset: return to the opened state. save: write the current checkpoint or run recording to path. verify: replay the recording and confirm it reproduces. diff: compare with another handle at the same tick (edits), or with first: true locate the first divergent tick between their recordings. close: drop the handle.',
  input: {
    type: 'object', required: ['world', 'action'],
    properties: {
      world: handleOnly,
      action: { type: 'string', enum: SIM_ACTIONS },
      path: { type: 'string', description: 'save: destination .json.' },
      kind: { type: 'string', enum: ['checkpoint', 'recording'], description: 'save: what to write (default checkpoint).' },
      overwrite: { type: 'boolean' },
      other: { type: 'string', description: 'diff: the other world handle.' },
      first: { type: 'boolean', description: 'diff: find the first divergent tick.' },
      from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 }
    },
    additionalProperties: false
  },
  run({ world, action, path: destination, kind = 'checkpoint', overwrite = false, other, first = false, from, to, limit }, ctx) {
    const entry = Worlds.open(world, ctx), run = entry.run, R = Worlds.R();
    const recording = () => {
      if (!entry.record) throw new OpError('UNSUPPORTED', 'This world was opened without recording', { hint: 'reopen with record: true' });
      return run.recording();
    };
    switch (action) {
      case 'plan': return compact({ handle: entry.handle, plan: run.composition() });
      case 'fork': {
        const branch = Worlds.fork(entry);
        return { handle: branch.handle, forkedFrom: entry.handle, tick: branch.run.view().tick };
      }
      case 'reset': return compact(Worlds.summary(Worlds.reset(entry)));
      case 'close': Worlds.sessions.delete(entry.handle); return { handle: entry.handle, closed: true };
      case 'save': {
        if (!destination) throw new OpError('INVALID_INPUT', 'save needs path', { path: '/path' });
        const file = path.resolve(ctx.root ?? process.cwd(), destination);
        if (!file.endsWith('.json')) throw new OpError('INVALID_INPUT', 'Save to a .json path', { path: '/path' });
        Worlds.writeJson(file, kind === 'recording' ? recording() : run.checkpoint(), overwrite);
        return { handle: entry.handle, kind, file, tick: run.view().tick };
      }
      case 'verify': return compact({ handle: entry.handle, ...wrap('VERIFY_FAILED', () => R.verify(recording())) });
      case 'diff': {
        if (!other) throw new OpError('INVALID_INPUT', 'diff needs other', { path: '/other' });
        const right = Worlds.open({ handle: other }, ctx);
        if (first) {
          const source = e => (e.record ? e.run.recording() : e.run.checkpoint());
          return compact(wrap('DIFF_FAILED', () => R.firstDivergence(source(entry), source(right), { from, to, limit })));
        }
        const a = run.checkpoint(), b = right.run.checkpoint();
        if (a.tick !== b.tick) throw new OpError('INVALID_INPUT', 'Diff needs both worlds at the same tick (' + a.tick + ' vs ' + b.tick + ')', {
          path: '/other', hint: 'step the earlier one, or use first: true'
        });
        return compact(wrap('DIFF_FAILED', () => R.diff(a, b)));
      }
    }
  }
});
