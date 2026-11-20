'use strict';
/* The operation registry: every agent-facing operation is declared once with a JSON Schema input, a side-effect class and
   a run function that returns plain data. The MCP server, the `ink-studio agent` command and tests all call through here,
   so nothing below this layer prints, parses argv or exits the process.

     defineOp({ name, title, description, effects: 'read'|'write'|'expensive', input, run(args, ctx) })
     call(name, args, ctx)   validates args, runs the op, returns { ok: true, result } or { ok: false, error }
     list()                  the declared ops in registration order */

class OpError extends Error {
  /* code is a stable SCREAMING_SNAKE identifier an agent can branch on; path points into the input or the scene */
  constructor(code, message, { path, hint, details } = {}) {
    super(message);
    this.code = code;
    if (path !== undefined) this.path = path;
    if (hint !== undefined) this.hint = hint;
    if (details !== undefined) this.details = details;
  }
  toJSON() {
    const out = { code: this.code, message: this.message };
    for (const key of ['path', 'hint', 'details']) if (this[key] !== undefined) out[key] = this[key];
    return out;
  }
}

const ops = new Map();
const EFFECTS = new Set(['read', 'write', 'expensive']);

function defineOp(op) {
  if (!/^[a-z][a-z0-9_]*$/.test(op.name)) throw new TypeError('Op names use lower snake case: ' + op.name);
  if (ops.has(op.name)) throw new TypeError('Op already defined: ' + op.name);
  if (!EFFECTS.has(op.effects)) throw new TypeError('Op effects must be read, write or expensive: ' + op.name);
  if (op.input?.type !== 'object') throw new TypeError('Op input schema must describe an object: ' + op.name);
  if (typeof op.run !== 'function') throw new TypeError('Op needs a run function: ' + op.name);
  ops.set(op.name, Object.freeze({ ...op }));
  return op;
}

const typeOf = value =>
  value === null ? 'null' : Array.isArray(value) ? 'array' :
    Number.isInteger(value) ? 'integer' : typeof value;

/* A deliberately small JSON Schema subset: type, enum, required, properties, additionalProperties: false, items,
   minimum, maximum, minItems, maxItems. Every problem is reported, not just the first. */
function check(schema, value, at = '', problems = []) {
  if (!schema || schema === true) return problems;
  const actual = typeOf(value);
  if (schema.type) {
    const allowed = [].concat(schema.type);
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) {
      problems.push({ path: at || '/', problem: 'expected ' + allowed.join(' or ') + ', got ' + actual });
      return problems;
    }
  }
  if (schema.enum && !schema.enum.includes(value))
    problems.push({ path: at || '/', problem: 'expected one of ' + schema.enum.map(v => JSON.stringify(v)).join(', ') });
  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum)
      problems.push({ path: at || '/', problem: 'must be at least ' + schema.minimum });
    if (schema.maximum !== undefined && value > schema.maximum)
      problems.push({ path: at || '/', problem: 'must be at most ' + schema.maximum });
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      problems.push({ path: at || '/', problem: 'needs at least ' + schema.minItems + ' items' });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      problems.push({ path: at || '/', problem: 'allows at most ' + schema.maxItems + ' items' });
    if (schema.items) value.forEach((item, i) => check(schema.items, item, at + '/' + i, problems));
  }
  if (actual === 'object') {
    for (const key of schema.required || [])
      if (value[key] === undefined) problems.push({ path: at + '/' + key, problem: 'is required' });
    const props = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (props[key]) check(props[key], item, at + '/' + key, problems);
      else if (schema.additionalProperties === false)
        problems.push({ path: at + '/' + key, problem: 'is not a known field', hint: 'known fields: ' + Object.keys(props).join(', ') });
      else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, item, at + '/' + key, problems);
    }
  }
  return problems;
}

async function call(name, args = {}, ctx = {}) {
  const op = ops.get(name);
  if (!op) {
    const error = new OpError('UNKNOWN_OP', 'No operation called "' + name + '"', { hint: 'known: ' + [...ops.keys()].join(', ') });
    return { ok: false, error: error.toJSON() };
  }
  const problems = check(op.input, args);
  if (problems.length)
    return { ok: false, error: new OpError('INVALID_INPUT', problems.length + ' problem(s) in the input', { details: problems }).toJSON() };
  try {
    return { ok: true, result: await op.run(args, ctx) };
  } catch (error) {
    if (error instanceof OpError) return { ok: false, error: error.toJSON() };
    return { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } };
  }
}

const list = () => [...ops.values()];
const get = name => ops.get(name);

module.exports = { defineOp, call, list, get, check, OpError };
