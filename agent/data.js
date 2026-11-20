'use strict';
/* Small data helpers for agent output: compact numbers, content revisions, structural diffs and JSON Patch. */
const { createHash } = require('node:crypto');
const { OpError } = require('./registry.js');

/* rounds every finite float to `digits` significant digits so reports do not spend tokens on 1.2999999999999998 */
function compact(value, digits = 4) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    return Number(value.toPrecision(digits));
  }
  if (Array.isArray(value)) return value.map(item => compact(item, digits));
  if (ArrayBuffer.isView(value)) return Array.from(value, item => compact(item, digits));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = compact(item, digits);
    return out;
  }
  return value;
}

/* key-sorted JSON, so equal scenes hash equally however their fields were ordered */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

const revisionOf = spec => createHash('sha256').update(canonical(spec)).digest('hex').slice(0, 16);

const escape = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = key => key.replace(/~1/g, '/').replace(/~0/g, '~');

/* the JSON Pointer paths that differ between two values; stops descending at `limit` entries */
function diff(before, after, at = '', out = [], limit = 200) {
  if (out.length >= limit) return out;
  const a = typeOf(before), b = typeOf(after);
  if (a !== b || (a !== 'object' && a !== 'array')) {
    if (canonical(before) !== canonical(after))
      out.push({ path: at || '/', change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed' });
    return out;
  }
  const keys = a === 'array'
    ? Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i)
    : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const key of keys) diff(before[key], after[key], at + '/' + escape(key), out, limit);
  return out;
}
const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

function parsePointer(pointer, index) {
  if (pointer === '') return [];
  if (typeof pointer !== 'string' || !pointer.startsWith('/'))
    throw new OpError('INVALID_PATCH', 'A JSON Pointer starts with "/"', { path: '/operations/' + index + '/path' });
  return pointer.slice(1).split('/').map(unescape);
}

/* RFC 6902 add, remove, replace, move, copy and test on a deep copy of `doc` */
function applyPatch(doc, patch, index = 0) {
  const root = { value: structuredClone(doc) };
  const fail = (message, hint) => {
    throw new OpError('INVALID_PATCH', message, { path: '/operations/' + index, hint });
  };
  const locate = (pointer, create = false) => {
    const parts = parsePointer(pointer, index);
    let parent = root, key = 'value';
    for (const part of parts) {
      parent = parent[key];
      key = part;
      if (parent === null || typeof parent !== 'object') fail('Nothing at ' + pointer);
      if (Array.isArray(parent) && key !== '-' && !/^(0|[1-9]\d*)$/.test(key)) fail('Array index expected in ' + pointer);
    }
    if (!create && (key === '-' || !(key in parent))) fail('Nothing at ' + pointer);
    return { parent, key };
  };
  const take = pointer => {
    const { parent, key } = locate(pointer);
    return structuredClone(parent[key]);
  };
  const put = (pointer, value) => {
    const { parent, key } = locate(pointer, true);
    if (Array.isArray(parent)) {
      const i = key === '-' ? parent.length : Number(key);
      if (i > parent.length) fail('Index past the end of the array at ' + pointer);
      parent.splice(i, 0, value);
    } else parent[key] = value;
  };
  const drop = pointer => {
    const { parent, key } = locate(pointer);
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  };
  switch (patch.op) {
    case 'add': put(patch.path, structuredClone(patch.value)); break;
    case 'remove': drop(patch.path); break;
    case 'replace': drop(patch.path); put(patch.path, structuredClone(patch.value)); break;
    case 'move': { const value = take(patch.from); drop(patch.from); put(patch.path, value); break; }
    case 'copy': put(patch.path, take(patch.from)); break;
    case 'test':
      if (canonical(take(patch.path)) !== canonical(patch.value)) fail('Test failed at ' + patch.path);
      break;
    default: fail('Unknown patch op ' + JSON.stringify(patch.op), 'use add, remove, replace, move, copy or test');
  }
  return root.value;
}

module.exports = { compact, canonical, revisionOf, diff, applyPatch };
