#!/usr/bin/env node
'use strict';
/* Claude Code PostToolUse hook: after a Write or Edit of a .json file that is an ink-studio diorama or world manifest,
   validate it and feed problems back to Claude (exit 2 + stderr). Anything else exits 0 immediately, before the toolkit
   is loaded, so the hook costs nothing on unrelated files. If the hook itself fails (toolkit cannot load, unreadable
   asset), it exits 1: Claude Code shows that to the user without blaming the file.

   World: { "format": "ink-studio/world" }. Diorama: no "format", a "solids" array whose items all have a string "kind",
   and a string "id" (the CLI requires both), so unrelated JSON that happens to have "solids" is left alone. */
const fs = require('node:fs');
const path = require('node:path');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

const looksLikeDiorama = value =>
  value.format === undefined && typeof value.id === 'string' && Array.isArray(value.solids) &&
  value.solids.every(solid => solid && typeof solid === 'object' && typeof solid.kind === 'string');

function classify(file) {
  if (typeof file !== 'string' || !file.toLowerCase().endsWith('.json') || !fs.existsSync(file)) return null;
  if (fs.statSync(file).size > 16 * 1024 * 1024) return null;
  const text = fs.readFileSync(file, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    /* only complain about broken JSON in files that look like ours */
    return /"ink-studio\/world"|"solids"\s*:\s*\[\s*\{\s*"kind"/.test(text) ? { kind: 'broken', error: error.message } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.format === 'ink-studio/world') return { kind: 'world', value };
  if (looksLikeDiorama(value)) return { kind: 'diorama', value };
  return null;
}

/* problems in the file itself; exceptions from the tooling propagate to main() */
function problemsFor(file, found) {
  if (found.kind === 'broken') return ['not valid JSON: ' + found.error];
  for (const method of ['log', 'info', 'warn', 'debug']) console[method] = () => {};
  const Scenes = require('../scenes.js');
  const { OpError } = require('../registry.js');
  Scenes.kit();
  if (found.kind === 'diorama') {
    let env;
    try {
      env = Scenes.environmentFor(found.value, path.dirname(file));
    } catch (error) {
      if (error instanceof OpError) return [(error.path ? error.path + ': ' : '') + error.message];
      throw error;
    }
    return Scenes.problemsOf(found.value, env).filter(p => p.level === 'error')
      .map(p => (p.path || '(root)') + ': ' + p.problem + (p.hint ? ' (' + p.hint + ')' : ''));
  }
  const Worlds = require('../worlds.js');
  let world;
  try {
    world = Worlds.classify(found.value, file).world;
  } catch (error) {
    if (error instanceof OpError) return [error.message];
    return ['data inputs: ' + error.message];
  }
  try {
    Worlds.R().validate(world);
    return [];
  } catch (error) {
    return [error.message];
  }
}

function main() {
  const input = readStdin();
  const given = input.tool_input?.file_path ?? input.tool_input?.path;
  if (typeof given !== 'string') return 0;
  const file = path.resolve(input.cwd ?? process.cwd(), given);
  const found = classify(file);
  if (!found) return 0;
  let problems;
  try {
    problems = problemsFor(file, found);
  } catch (error) {
    process.stderr.write('ink-studio validation hook could not run: ' + error.message + '\n');
    return 1;
  }
  if (!problems.length) return 0;
  process.stderr.write('ink-studio: ' + given + ' has ' + problems.length + ' problem(s):\n  ' + problems.slice(0, 20).join('\n  ') +
    (problems.length > 20 ? '\n  ... and ' + (problems.length - 20) + ' more' : '') +
    '\nFix them; ' + (found.kind === 'world' ? 'world_open' : 'scene_validate') + ' gives the full report.\n');
  return 2;
}

process.exitCode = main();
