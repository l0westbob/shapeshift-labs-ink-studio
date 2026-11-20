'use strict';
/* Questions about a baked scene: which target owns a pixel-sized spot, what material and colour a splat resolves to, and
   which look targets exist. Uses the same query descriptors as world_query, read from the scene at time t. */
const { defineOp, OpError } = require('../registry.js');
const { compact } = require('../data.js');
const Scenes = require('../scenes.js');

const ACTIONS = ['inspect', 'select', 'sample', 'output', 'provenance'];

defineOp({
  name: 'scene_query',
  title: 'Query a baked scene',
  effects: 'read',
  description: 'Ask about a baked scene at time t. select: look targets (objects, entities, materials) with splat counts. sample: the splat nearest a point (at) or inside a selector, with its target, material, position and final colour. output/provenance: look output or provenance for a selector. inspect: the fields and traces the scene publishes.',
  input: {
    type: 'object', required: ['scene', 'action'],
    properties: {
      scene: Scenes.sceneSchema,
      action: { type: 'string', enum: ACTIONS },
      t: { type: 'number', minimum: 0 },
      at: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'sample: world-space point.' },
      radius: { type: 'number', minimum: 0, description: 'sample: search radius around at.' },
      select: { type: 'object', description: 'Look selector, e.g. { "material": "accent" } or { "object": "gem" }.' }
    },
    additionalProperties: false
  },
  run({ scene, action, t = 0, at, radius, select }, ctx) {
    const entry = Scenes.open(scene, { ...ctx, persist: !!scene.handle });
    const world = Scenes.worldAt(entry, { t });
    const query = Scenes.kit().KIT.world.query.fromScene(world, t);
    let result;
    try {
      if (action === 'inspect') {
        const { fields, traces } = query.inspect();
        result = { fields, traces };
      } else if (action === 'select') result = { targets: query.select(select) };
      else if (action === 'sample') {
        if (!at && !select) throw new OpError('INVALID_INPUT', 'sample needs at or select', { path: '/at' });
        result = query.probe('look/sample', select, { ...(at && { at }), ...(radius !== undefined && { radius }) });
      } else result = query.probe('look/' + action, select, {});
    } catch (error) {
      if (error instanceof OpError) throw error;
      throw new OpError('QUERY_FAILED', error.message);
    }
    if (result?.status === 'unavailable') throw new OpError('NOT_FOUND', result.reason ?? 'not available', { path: '/action' });
    return compact({ revision: Scenes.revisionFor(entry), t, action, result });
  }
});
