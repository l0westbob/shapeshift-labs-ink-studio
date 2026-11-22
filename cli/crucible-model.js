'use strict';
/* Crucible scene recipes as a modelling front end. A .crucible.json is plain JSON that Crucible
   (https://github.com/codepawl/crucible, MIT) turns into meshes: bevelled boxes and cylinders, lathes, extrusions with holes
   and bevels, tubes, Bezier curves, text, terrain, and polygon meshes edited the way Blender's BMesh does (extrude, inset,
   transform selections by tag or normal, booleans on Manifold, a modifier stack). No code runs, so it needs no code
   permission: CSG and bevels as data.

     { "format": "crucible.scene", "schemaVersion": 1,
       "geometries": [{ "id": "hull", "type": "extrude", "contour": [[x, y], ...], "depth": 1.9, "bevel": 0.04 }, ...],
       "materials": [{ "id": "olive", "color": [0.15, 0.2, 0.04] }],         linear RGB; the id becomes the role name
       "nodes": [{ "id": "hull", "geometry": "hull", "material": "olive", "translation": [0, 0, -0.95],
                   "rotation": [x, y, z, w], "scale": [1, 1, 1], "parent": "..." }] }

   Primitive sizes: a box is 1 across (-0.5 to 0.5), a cylinder has radius 1 and height 1 along Y, a sphere radius 1.
   Every mesh node becomes a part with the role of its material; vertex colours (geometry colors) are kept instead.
   Material patterns and image maps are not carried over (the colour is), and the build says so.

   Crucible is an optional peer dependency, looked up from the given roots (the user's project) before this package;
   booleans also need manifold-3d next to it. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PACKAGE = path.join(__dirname, '..');
const NAME = '@codepawlhq/crucible';
const INSTALL = 'npm install @codepawlhq/crucible@0.22.0 manifold-3d@3.5.4';

/* the package folder: node_modules/@codepawlhq/crucible under a root or one of its parents (the package is ESM only,
   so require.resolve cannot find it through its exports) */
function locate(roots) {
  for (const root of [...roots, PACKAGE]) {
    for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', ...NAME.split('/'));
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

async function loadCrucible(roots = []) {
  const dir = locate(roots);
  if (!dir) throw Object.assign(new Error('Crucible is not installed'), { code: 'CRUCIBLE_MISSING', hint: INSTALL });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const entry = key => {
    const target = pkg.exports?.[key];
    const file = typeof target === 'string' ? target : target?.import ?? target?.default;
    if (!file) throw new Error('Crucible ' + pkg.version + ' has no ' + key + ' entry; this engine is written for 0.22');
    return import(pathToFileURL(path.join(dir, file)).href);
  };
  const [scene, mesh] = await Promise.all([entry('./addons/agent-scene'), entry('./addons/mesh')]);
  return { version: pkg.version, scene, mesh };
}

const usesBoolean = value =>
  Array.isArray(value) ? value.some(usesBoolean) : value && typeof value === 'object' ? value.op === 'boolean' || Object.values(value).some(usesBoolean) : false;

const srgbByte = v => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));

/* a crucible renderer part to an ink part: positions through the part matrix (column-major), role from the material */
function partOf(part, roleFor, warnings, seen) {
  const { geometry, matrix: m, material = {} } = part;
  const P = geometry.positions, pos = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const [x, y, z] = [P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < 3; k++) pos[i + k] = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
  }
  /* a mirrored matrix turns the triangles inside out */
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  const index = Uint32Array.from(geometry.indices);
  if (det < 0) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
  const colour = (material.color ?? [0.5, 0.5, 0.5]).map(srgbByte);
  if ((material.pattern || material.map || material.baseColorMap) && !seen.has(material.id)) {
    seen.add(material.id);
    warnings.push('material "' + material.id + '": its pattern or map is not carried over, only its colour');
  }
  if (geometry.colors?.length === P.length) {
    const colours = new Float32Array(P.length);
    for (let i = 0; i < P.length; i++) colours[i] = Math.min(1, geometry.colors[i] * (material.color?.[i % 3] ?? 1));
    return { name: part.name, pos, index, colours, role: null };
  }
  return { name: part.name, pos, index, role: roleFor(material.id, (colour[0] << 16) | (colour[1] << 8) | colour[2]) };
}

async function buildModel(file, { roots = [], ...options }) {
  let recipe;
  try {
    recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The recipe is not JSON: ' + error.message);
  }
  if (recipe?.format !== 'crucible.scene') throw new Error('A Crucible recipe starts with "format": "crucible.scene" and "schemaVersion": 1');
  const crucible = await loadCrucible(roots);
  if (usesBoolean(recipe.geometries)) {
    try {
      await crucible.mesh.loadMeshBooleans();
    } catch (error) {
      throw Object.assign(new Error('Booleans need manifold-3d next to Crucible: ' + error.message), { code: 'CRUCIBLE_MISSING', hint: INSTALL });
    }
  }
  await crucible.scene.loadAgentSceneModules(recipe);
  const scene = crucible.scene.createAgentScene(recipe);
  const { roleFor, buildFromParts } = require('./model-core.js');
  const warnings = [], seen = new Set();
  const parts = scene.parts.filter(part => part.geometry?.positions?.length && part.geometry?.indices?.length).map(part => partOf(part, roleFor, warnings, seen));
  if (!parts.length) throw new Error('The recipe has no mesh nodes');
  const report = await buildFromParts(parts, { ...options, prefix: 'crucible', warnings });
  return { ...report, crucible: crucible.version };
}

module.exports = { buildModel, loadCrucible };
