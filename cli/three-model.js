'use strict';
/* three.js as a modelling front end. A script builds an Object3D with the three.js API; it is welded and written as GLB,
   and a diorama that places it is written next to it, so baking, rendering, editing and export carry on as for any scene.

     module.exports = ({ THREE, addon, parts }) => group   (or export default; may be async)
     parts.roadWheel({ radius }, material)                  tested parts from library/ink-parts.mjs
     addon('geometries/RoundedBoxGeometry')                 imports a three.js addon from the same three install

   Each visible mesh becomes a part for model-core.js (its own GLB and its own `mesh` solid). Normals and UVs are dropped
   and vertices are welded there, because three.js primitives split vertices along every seam and the field needs closed
   surfaces. Material and vertex colours survive, textures do not.

   three is an optional peer dependency, looked up from the given roots (the user's project) before this package. */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PACKAGE = path.join(__dirname, '..');

function locate(roots) {
  for (const root of [...roots, PACKAGE]) {
    try {
      return path.resolve(path.dirname(require.resolve('three', { paths: [root] })), '..');
    } catch {
      /* not installed under this root */
    }
  }
  return null;
}

async function loadThree(roots = []) {
  const dir = locate(roots);
  if (!dir) throw Object.assign(new Error('three is not installed'), { code: 'THREE_MISSING' });
  const url = rel => pathToFileURL(path.join(dir, rel)).href;
  const THREE = await import(url('build/three.module.js'));
  const addon = name => import(url(path.join('examples/jsm', name.replace(/^\/+/, '').replace(/\.js$/, '') + '.js')));
  return { THREE, addon, dir, revision: THREE.REVISION };
}

/* the parts library (library/ink-parts.mjs), bound to this three.js */
async function partsFor(three) {
  const { makeParts } = await import(pathToFileURL(path.join(PACKAGE, 'library', 'ink-parts.mjs')).href);
  const { RoundedBoxGeometry } = await three.addon('geometries/RoundedBoxGeometry');
  return makeParts(three.THREE, { RoundedBoxGeometry });
}

async function runScript(file, three) {
  /* the modification time in the URL makes import() read an edited ES module again instead of its cached first version;
     a CommonJS script is cached by file name alone, so that entry is dropped */
  delete require.cache[fs.realpathSync(file)];
  const mod = await import(pathToFileURL(file).href + '?v=' + fs.statSync(file).mtimeMs);
  const build = typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : null;
  if (!build) throw new Error('The script must export a function ({ THREE, addon }) => Object3D');
  const object = await build({ THREE: three.THREE, addon: three.addon, parts: await partsFor(three) });
  if (!object?.isObject3D) throw new Error('The script must return a THREE.Object3D (a Mesh, Group or Scene)');
  return object;
}

const Core = () => require('./model-core.js');

/* every visible mesh in world space, with its material role or vertex colours */
function threeParts(object, THREE) {
  object.updateMatrixWorld(true);
  const parts = [], warnings = [];
  object.traverseVisible(node => {
    if (node.isInstancedMesh || node.isSkinnedMesh) {
      warnings.push((node.name || node.type) + ': instanced and skinned meshes are skipped');
      return;
    }
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    const name = node.name || node.parent?.name || '';
    const material = Array.isArray(node.material) ? node.material[0] : node.material;
    if (Array.isArray(node.material) && node.material.length > 1)
      warnings.push((name || 'a mesh') + ': only the first of its ' + node.material.length + ' materials is used');
    const { position, color } = geometry.attributes;
    const pos = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) pos.set([position.getX(i), position.getY(i), position.getZ(i)], i * 3);
    let colours;
    if (color && material?.vertexColors) {
      colours = new Float32Array(color.count * 3);
      for (let i = 0; i < color.count; i++) colours.set([color.getX(i), color.getY(i), color.getZ(i)], i * 3);
    }
    /* which role a material shades with: userData.role, else its name, else its colour */
    const hex = material?.color ? material.color.getHex(THREE.SRGBColorSpace) : 0xb4b4b4;
    parts.push({
      name, pos, colours, index: geometry.index ? Uint32Array.from(geometry.index.array) : undefined,
      role: colours ? null : Core().roleFor(material?.userData?.role || material?.name, hex)
    });
  });
  return { parts, warnings, sun: sunOf(object, THREE) };
}

/* the first visible directional light gives the diorama its sun: the direction towards the light, as three.js aims it */
function sunOf(object, THREE) {
  let sun = null;
  object.traverseVisible(node => {
    if (sun || !node.isDirectionalLight) return;
    const from = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    const to = new THREE.Vector3().setFromMatrixPosition(node.target.matrixWorld);
    const direction = from.sub(to);
    if (direction.lengthSq() > 1e-12) sun = direction.normalize().toArray().map(Core().round);
  });
  return sun;
}

/* runs `script` and hands its meshes to the shared model core (see model-core.js for what is written) */
async function buildModel(script, { roots = [], ...options }) {
  const three = await loadThree(roots);
  const object = await runScript(script, three);
  const { parts, warnings, sun } = threeParts(object, three.THREE);
  if (!parts.length) throw new Error('The script returned no visible meshes with triangles');
  return { ...(await Core().buildFromParts(parts, { ...options, prefix: 'three', sun, warnings })), three: three.revision };
}

module.exports = { loadThree, buildModel, locate };
