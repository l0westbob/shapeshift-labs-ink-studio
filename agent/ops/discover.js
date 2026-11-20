'use strict';
/* Discovery: what the toolkit can do (ops, catalog, diorama schema) and its documentation in agent-sized pieces. */
const fs = require('node:fs');
const path = require('node:path');
const { defineOp, OpError, list, get } = require('../registry.js');
const Scenes = require('../scenes.js');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const EXTRA_DOCS = { agents: path.join(ROOT, 'AGENTS.md'), readme: path.join(ROOT, 'README.md') };

const words = text => String(text).toLowerCase().match(/[a-z0-9]+/g) ?? [];
const score = (haystack, terms) => {
  const text = haystack.toLowerCase();
  return terms.reduce((sum, term) => sum + (text.includes(term) ? 1 + Math.min(4, text.split(term).length - 2) * 0.1 : 0), 0);
};

/* --- documents ------------------------------------------------------------------------------------------------------ */

let docIndex;
function docs() {
  if (docIndex) return docIndex;
  const files = fs.readdirSync(DOCS).filter(f => f.endsWith('.md')).sort().map(f => [f.slice(0, -3), path.join(DOCS, f)]);
  docIndex = new Map();
  for (const [topic, file] of [...Object.entries(EXTRA_DOCS), ...files]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? topic;
    docIndex.set(topic, { topic, title, text, sections: sectionsOf(text) });
  }
  return docIndex;
}

/* headings outside code fences, with the character range each section covers */
function sectionsOf(text) {
  const out = [];
  let fenced = false, offset = 0;
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const match = !fenced && /^(#{1,4})\s+(.+)$/.exec(line);
    if (match) out.push({ level: match[1].length, heading: match[2].trim(), start: offset });
    offset += line.length + 1;
  }
  out.forEach((section, i) => {
    const next = out.slice(i + 1).find(s => s.level <= section.level);
    section.end = next ? next.start : text.length;
  });
  return out;
}

function findDoc(topic) {
  const doc = docs().get(topic);
  if (doc) return doc;
  const near = [...docs().keys()].filter(key => key.includes(topic) || topic.includes(key)).slice(0, 8);
  throw new OpError('NOT_FOUND', 'No documentation topic "' + topic + '"', {
    path: '/topic', hint: near.length ? 'did you mean: ' + near.join(', ') : 'call ink_docs without arguments to list topics'
  });
}

function searchDocs(query, limit) {
  const terms = words(query);
  const hits = [];
  for (const doc of docs().values()) {
    const parts = doc.sections.length ? doc.sections : [{ heading: doc.title, start: 0, end: doc.text.length }];
    for (const section of parts) {
      const body = doc.text.slice(section.start, section.end);
      const s = score(body, terms) + score(section.heading, terms) + score(doc.title, terms) * 0.5;
      if (s < terms.length * 0.75) continue;
      const at = Math.max(0, body.toLowerCase().indexOf(terms.find(t => body.toLowerCase().includes(t)) ?? ''));
      const snippet = body.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, ' ').trim();
      hits.push({ topic: doc.topic, title: doc.title, section: section.heading, score: Math.round(s * 100) / 100, snippet });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

defineOp({
  name: 'ink_docs',
  title: 'Read documentation',
  effects: 'read',
  description: 'Read the toolkit documentation in pieces. No arguments: list topics. query: search sections and get snippets. topic: a document\'s section list and text (paginated with offset/maxChars); add section to read just one heading. Topic "agents" is the agent guide.',
  input: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Document name, e.g. "scene-editor", "pixel-look", "headless-worlds", "agents".' },
      section: { type: 'string', description: 'Heading text (case-insensitive substring) to read one section of topic.' },
      query: { type: 'string', description: 'Full-text search across all documents.' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset into the topic text.' },
      maxChars: { type: 'integer', minimum: 200, maximum: 30000, description: 'Characters to return (default 6000).' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Search results (default 10).' }
    },
    additionalProperties: false
  },
  run({ topic, section, query, offset = 0, maxChars = 6000, limit = 10 }) {
    if (query !== undefined && topic === undefined) return { query, results: searchDocs(query, limit) };
    if (topic === undefined) {
      if (section !== undefined) throw new OpError('INVALID_INPUT', 'section needs a topic', { path: '/section' });
      return { topics: [...docs().values()].map(d => ({ topic: d.topic, title: d.title })) };
    }
    const doc = findDoc(topic);
    let start = 0, end = doc.text.length, heading;
    if (section !== undefined) {
      const wanted = section.toLowerCase();
      const found = doc.sections.find(s => s.heading.toLowerCase() === wanted) ?? doc.sections.find(s => s.heading.toLowerCase().includes(wanted));
      if (!found) throw new OpError('NOT_FOUND', 'No section "' + section + '" in ' + topic, {
        path: '/section', hint: 'sections: ' + doc.sections.map(s => s.heading).join(' | ')
      });
      ({ start, end, heading } = found);
    }
    const from = start + offset, to = Math.min(end, from + maxChars);
    const out = { topic, title: doc.title, ...(heading && { section: heading }), text: doc.text.slice(from, to), chars: end - start };
    if (to < end) out.nextOffset = to - start;
    if (offset === 0 && section === undefined) out.sections = doc.sections.filter(s => s.level >= 2 && s.level <= 3).map(s => s.heading);
    return out;
  }
});

/* --- diorama format ------------------------------------------------------------------------------------------------- */

const TYPE_LEGEND = {
  str: 'string', num: 'finite number', pos: 'positive number', bool: 'boolean', vec2: '[a, b]', vec3: '[x, y, z]',
  list: 'array', obj: 'object', pts: 'array of [x, y, z] points', outline: 'array of [x, y] points',
  mat: 'palette role name (see roles) or a material object', solid: 'a nested solid object', style: 'one of styles',
  join: 'boolean or blend operation name (see docs topic "scene-editor")', profile: '[[r, y], ...] radius profile',
  1: 'structured value, checked by its own rules (see docs)'
};

function dioramaSchema(part) {
  const D = Scenes.kit().KIT.diorama;
  const all = {
    top: D.fields.top, solidKinds: D.kinds, solidCommon: D.fields.common, motion: D.fields.motion,
    effects: D.fields.effects, modifiers: D.fields.modifiers, roles: D.roles, styles: Object.keys(D.styles)
  };
  const picked = part === undefined ? all : { [part]: all[part] };
  return {
    ...picked,
    types: TYPE_LEGEND,
    notes: 'need = required fields, may = optional. An array of strings lists allowed values. Positions are [x, y, z] with Y up; box takes half-extents; res is surface sampling spacing (smaller is denser and slower). Minimal example: docs topic "agents" or examples/scene.json.'
  };
}

/* --- discovery ------------------------------------------------------------------------------------------------------ */

/* agent entries mirror the registry, which is searched directly */
const catalog = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8')).entries.filter(entry => entry.kind !== 'agent');
const opSummary = op => ({ name: op.name, effects: op.effects, title: op.title });

defineOp({
  name: 'ink_discover',
  title: 'Discover capabilities',
  effects: 'read',
  description: 'Find out what ink-studio can do. No arguments: overview of tools, catalog and schemas. query: rank tools, catalog features and documentation by keywords. describe: full input schema of one tool. schema: the JSON diorama format (top-level fields, solid kinds with required/optional fields, motion, effects, modifiers, roles, styles).',
  input: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords, e.g. "sprite atlas directions" or "rain weather".' },
      describe: { type: 'string', description: 'Tool name to describe in full.' },
      schema: { type: 'string', enum: ['diorama', 'top', 'solidKinds', 'solidCommon', 'motion', 'effects', 'modifiers', 'roles', 'styles'] },
      limit: { type: 'integer', minimum: 1, maximum: 50 }
    },
    additionalProperties: false
  },
  run({ query, describe, schema, limit = 12 }) {
    if (describe !== undefined) {
      const op = get(describe);
      if (!op) throw new OpError('NOT_FOUND', 'No tool called "' + describe + '"', { path: '/describe', hint: 'tools: ' + list().map(o => o.name).join(', ') });
      return { name: op.name, title: op.title, effects: op.effects, description: op.description, input: op.input };
    }
    if (schema !== undefined) return dioramaSchema(schema === 'diorama' ? undefined : schema);
    if (query === undefined) {
      const kinds = {};
      for (const entry of catalog()) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
      return {
        tools: list().map(opSummary),
        catalog: { entries: catalog().length, kinds, note: 'query to search features; run kind "cli" entries with ink_cli' },
        docs: { topics: docs().size, note: 'ink_docs lists and searches them' },
        schemas: ['diorama', 'solidKinds', 'motion', 'effects', 'modifiers', 'roles', 'styles'],
        builtins: Scenes.kit().SCENES.map(s => s.id)
      };
    }
    const terms = words(query);
    if (!terms.length) throw new OpError('INVALID_INPUT', 'query needs at least one word', { path: '/query' });
    const tools = list()
      .map(op => ({ type: 'tool', name: op.name, title: op.title, score: score(op.name + ' ' + op.title + ' ' + op.description, terms) }))
      .filter(hit => hit.score >= terms.length * 0.5);
    const features = catalog()
      .map(e => ({ type: 'catalog', id: e.id, kind: e.kind, title: e.title, use: e.use, ...(e.example && { doc: e.example }),
        score: score([e.id, e.title, e.what, e.use, (e.tags ?? []).join(' ')].join(' '), terms) }))
      .filter(hit => hit.score >= terms.length * 0.5);
    const documents = searchDocs(query, limit).map(hit => ({ type: 'doc', ...hit }));
    const results = [...tools, ...features, ...documents].sort((a, b) => b.score - a.score).slice(0, limit);
    return { query, results };
  }
});

module.exports = { docs, searchDocs, dioramaSchema };
