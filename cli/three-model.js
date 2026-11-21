'use strict';
/* three.js as a modelling front end. A script builds an Object3D with the three.js API; it is welded and written as GLB,
   and a diorama that places it is written next to it, so baking, rendering, editing and export carry on as for any scene.

     module.exports = ({ THREE, addon }) => group          (or export default; may be async)
     addon('geometries/RoundedBoxGeometry')                 imports a three.js addon from the same three install

   Each visible mesh becomes its own GLB and its own `mesh` solid. A distance field from one triangle soup decides inside
   and outside by counting crossings, so two overlapping closed shells (a turret sunk into a hull) would cancel out where
   they overlap; as separate solids the diorama unions their fields instead. Normals and UVs are dropped and vertices are
   welded, because three.js primitives split vertices along every seam and the field needs closed surfaces. Material and
   vertex colours survive, textures do not.

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

/* GLTFExporter reads its own blobs back with FileReader, which Node does not have */
function ensureFileReader() {
  if (typeof globalThis.FileReader === 'function') return;
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(bytes => this.finish(bytes), error => this.onerror?.(error));
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then(
        bytes => this.finish('data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(bytes).toString('base64')),
        error => this.onerror?.(error)
      );
    }
    finish(result) {
      this.result = result;
      this.onload?.({ target: this });
      this.onloadend?.({ target: this });
    }
  };
}

async function runScript(file, three) {
  /* the modification time in the URL makes import() read an edited ES module again instead of its cached first version;
     a CommonJS script is cached by file name alone, so that entry is dropped */
  delete require.cache[fs.realpathSync(file)];
  const mod = await import(pathToFileURL(file).href + '?v=' + fs.statSync(file).mtimeMs);
  const build = typeof mod.default === 'function' ? mod.default : typeof mod === 'function' ? mod : null;
  if (!build) throw new Error('The script must export a function ({ THREE, addon }) => Object3D');
  const object = await build({ THREE: three.THREE, addon: three.addon });
  if (!object?.isObject3D) throw new Error('The script must return a THREE.Object3D (a Mesh, Group or Scene)');
  return object;
}

const slug = (name, i) => String(i).padStart(2, '0') + (name ? '-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) : '');

/* every visible mesh, baked into world space and welded, with its triangle count and bounds */
async function weldedParts(object, three) {
  const { THREE } = three;
  const { mergeVertices } = await three.addon('utils/BufferGeometryUtils');
  object.updateMatrixWorld(true);
  const parts = [], warnings = [];
  object.traverseVisible(node => {
    if (node.isInstancedMesh || node.isSkinnedMesh) {
      warnings.push((node.name || node.type) + ': instanced and skinned meshes are skipped');
      return;
    }
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    let geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'color') geometry.deleteAttribute(name);
    geometry = mergeVertices(geometry, 1e-4);
    const triangles = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    if (!triangles) return;
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    const name = node.name || node.parent?.name || '';
    const mesh = new THREE.Mesh(geometry, node.material);
    mesh.name = name;
    parts.push({ name, mesh, triangles, lo: min.toArray(), hi: max.toArray() });
  });
  return { parts, warnings };
}

async function toGlb(object, three) {
  ensureFileReader();
  const { GLTFExporter } = await three.addon('exporters/GLTFExporter');
  return Buffer.from(await new GLTFExporter().parseAsync(object, { binary: true }));
}

const extentOf = ({ lo, hi }) => Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

function boundsOf(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of parts)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], part.lo[k]);
      hi[k] = Math.max(hi[k], part.hi[k]);
    }
  return { lo, hi };
}

const round = v => Math.round(v * 1e4) / 1e4;

/* a diorama with one mesh solid per part, fitted so the whole model is `size` across (or kept at three.js units), centred
   on x and z and standing on y = 0. kb-mesh fits each asset to its own size and rests it on `at`, so each part gets the
   shared scale through its own size and lands where it was through `at` */
function dioramaFor(parts, { size, cells = 96, hues, palette, name, files }) {
  const bounds = boundsOf(parts), extent = extentOf(bounds);
  const k = size ? size / extent : 1, h = extent / cells;
  const cx = (bounds.lo[0] + bounds.hi[0]) / 2, cz = (bounds.lo[2] + bounds.hi[2]) / 2, y0 = bounds.lo[1];
  const solids = parts.map((part, i) => {
    const solid = {
      kind: 'mesh',
      asset: files[i],
      size: round(extentOf(part) * k),
      at: [round(((part.lo[0] + part.hi[0]) / 2 - cx) * k), round((part.lo[1] - y0) * k), round(((part.lo[2] + part.hi[2]) / 2 - cz) * k)],
      cells: Math.max(12, Math.ceil(extentOf(part) / h))
    };
    if (hues) solid.hues = hues;
    return solid;
  });
  const height = (bounds.hi[1] - bounds.lo[1]) * k, span = extent * k;
  return {
    id: 'three-' + ((name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model'),
    name: name || 'three.js model',
    seed: 1,
    style: 'moss',
    palette,
    camera: { target: [0, round(height / 2), 0], dist: round(span * 1.6), pitch: 0.35, yaw: 0.6 },
    solids
  };
}

/* runs `script`, writes model.glb (the whole welded model), parts/NN-name.glb and scene.json into `out`. kit is the loaded
   ink-studio KIT, used for the palette and the open-edge report; readMesh reads a GLB back the way scenes will. */
async function buildModel(script, { out, roots = [], size, cells, hues = 6, shades = 4, overwrite = false, kit, readMesh }) {
  const three = await loadThree(roots);
  const object = await runScript(script, three);
  const { parts, warnings } = await weldedParts(object, three);
  if (!parts.length) throw new Error('The script returned no visible meshes with triangles');
  const sceneFile = path.join(out, 'scene.json'), partsDir = path.join(out, 'parts');
  if (fs.existsSync(sceneFile) && !overwrite) throw Object.assign(new Error('A model already exists in ' + out), { code: 'EXISTS' });
  fs.mkdirSync(partsDir, { recursive: true });
  for (const old of fs.readdirSync(partsDir)) if (old.endsWith('.glb')) fs.rmSync(path.join(partsDir, old));

  const whole = new three.THREE.Group();
  for (const part of parts) whole.add(part.mesh.clone());
  fs.writeFileSync(path.join(out, 'model.glb'), await toGlb(whole, three));

  const files = [];
  for (const [i, part] of parts.entries()) {
    const rel = 'parts/' + slug(part.name, i + 1) + '.glb';
    fs.writeFileSync(path.join(out, rel), await toGlb(part.mesh, three));
    files.push(rel);
  }

  /* one palette for the whole model, from its material colours; every part's look then picks its ramps from it */
  const mesh = readMesh(path.join(out, 'model.glb'));
  const look = kit.mesh.look(mesh, { hues, shades });
  const report = parts.map((part, i) => {
    const info = kit.mesh.info(readMesh(path.join(out, files[i])));
    if (info.open > 0.02) warnings.push(files[i] + ' (' + (part.name || 'unnamed') + ') is not closed (' + Math.round(info.open * 100) + '% open edges): it bakes as a sheet with thickness');
    return { name: part.name || undefined, file: files[i], triangles: part.triangles, open: round(info.open) };
  });
  const spec = dioramaFor(parts, { size, cells, hues, palette: look.pal, name: path.basename(out), files });
  fs.writeFileSync(sceneFile, JSON.stringify(spec, null, 2) + '\n');
  return {
    directory: out,
    scene: sceneFile,
    model: path.join(out, 'model.glb'),
    three: three.revision,
    triangles: parts.reduce((sum, part) => sum + part.triangles, 0),
    extent: round(extentOf(boundsOf(parts)) * (size ? size / extentOf(boundsOf(parts)) : 1)),
    colours: look.pal.length,
    parts: report,
    warnings,
    spec
  };
}

module.exports = { loadThree, buildModel, dioramaFor, locate };
