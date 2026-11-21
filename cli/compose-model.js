'use strict';
/* One model from parts made by different engines: the best tool for each part. A .compose.json lists the parts:

     { "parts": [
         { "source": "hull.py", "size": 6 },                                   built with its engine (from the extension)
         { "source": "emblem.vox.json", "size": 0.4, "at": [0.2, 1.7, 1.01] },
         { "diorama": "sandbags.json", "at": [-1.8, 1.3, 0], "yaw": 0.3, "scale": 0.8 } ],
       "camera": { ... }, "light": { ... }, "style": "moss" }                  optional; default: the first part's

   Each part's solids are placed with a transform (yaw, uniform scale, then `at`, around the origin) and merged into one
   diorama. Palettes merge colour by colour, roles keep their names (a clash with different colours gets the part number
   appended), materials and voxel keys are rewritten to match, and mesh assets point back at each part's files. */
const fs = require('node:fs');
const path = require('node:path');

const MAT_FIELDS = ['mat'];

/* the palette and roles a diorama actually means: its own, over its style's */
function effective(spec, styles) {
  const style = typeof spec.style === 'string' ? styles[spec.style] : spec.style?.extends ? styles[spec.style.extends] : spec.style ?? styles.slate;
  return { palette: (spec.palette ?? style?.palette ?? styles.slate.palette).slice(), roles: { ...(style?.roles ?? styles.slate.roles), ...(spec.roles ?? {}) } };
}

/* every material in a solid tree, with a setter, so roles and ramps can be rewritten in place */
function* materials(solid) {
  if (!solid || typeof solid !== 'object') return;
  for (const field of MAT_FIELDS) if (solid[field] !== undefined) yield [solid[field], value => (solid[field] = value)];
  if (solid.kind === 'vox' && solid.key) for (const letter of Object.keys(solid.key)) yield [solid.key[letter], value => (solid.key[letter] = value)];
  for (const field of ['a', 'b', 'of', 'shape']) if (solid[field] && typeof solid[field] === 'object') yield* materials(solid[field]);
  for (const modifier of solid.modifiers ?? []) if (modifier.shape) yield* materials(modifier.shape);
}

function composeSpecs(pieces, { styles, out, header = {} }) {
  const palette = [], roles = {}, solids = [], warnings = [];
  const indexOf = colour => {
    let i = palette.indexOf(colour);
    if (i < 0) i = palette.push(colour) - 1;
    return i;
  };
  /* index 0 is the background and outline colour: the first part's */
  indexOf(effective(pieces[0].spec, styles).palette[0]);
  pieces.forEach(({ spec, dir, place, label }, n) => {
    const { palette: own, roles: ownRoles } = effective(spec, styles);
    const rename = {};
    const roleName = name => {
      if (rename[name]) return rename[name];
      const ramp = (ownRoles[name] ?? []).map(i => indexOf(own[i]));
      let target = name;
      if (roles[target] && JSON.stringify(roles[target]) !== JSON.stringify(ramp)) target = name + '-' + (n + 1);
      roles[target] = ramp;
      return (rename[name] = target);
    };
    const rewrite = mat => {
      if (typeof mat === 'string') return roleName(mat);
      if (!mat || typeof mat !== 'object') return mat;
      const copy = { ...mat };
      if (typeof copy.role === 'string') copy.role = roleName(copy.role);
      if (Array.isArray(copy.ramp)) copy.ramp = copy.ramp.map(i => indexOf(own[i]));
      if (copy.over?.role) copy.over = { ...copy.over, role: roleName(copy.over.role) };
      return copy;
    };
    for (const key of ['motion', 'effects', 'groups', 'timeline'])
      if (spec[key] && (Array.isArray(spec[key]) ? spec[key].length : Object.keys(spec[key]).length)) warnings.push(label + ': its ' + key + ' are not carried over');
    for (const original of spec.solids ?? []) {
      const solid = structuredClone(original);
      for (const [mat, set] of materials(solid)) set(rewrite(mat));
      /* mesh assets are resolved next to the scene: point them at the part's own files */
      const fix = s => {
        if (!s || typeof s !== 'object') return;
        if (s.kind === 'mesh' && typeof s.asset === 'string' && dir) s.asset = path.relative(out, path.resolve(dir, s.asset)).split(path.sep).join('/');
        for (const field of ['a', 'b', 'of', 'shape']) fix(s[field]);
      };
      fix(solid);
      if (place && solid.kind !== 'ground') {
        if (solid.transform) warnings.push(label + ': a solid that already has a transform is placed by its own transform only');
        else solid.transform = { translation: place.at ?? [0, 0, 0], rotation: [place.yaw ?? 0, 0, 0], scale: place.scale ?? 1, pivot: [0, 0, 0] };
      }
      if (solid.id) solid.id = solid.id + '-' + (n + 1);
      solids.push(solid);
    }
  });
  /* built-in role names nobody claimed point at the nearest merged ramp, so another style still validates */
  const named = Object.keys(roles);
  const distance = (a, b) => [16, 8, 0].reduce((s, k) => s + (((a >> k) & 255) - ((b >> k) & 255)) ** 2, 0);
  const mid = name => palette[roles[name][Math.max(0, roles[name].length - 2)]] ?? 0;
  if (named.length)
    for (const [name, indices] of Object.entries(styles.slate.roles)) {
      if (roles[name]) continue;
      const colour = styles.slate.palette[indices[Math.floor(indices.length / 2)]];
      roles[name] = roles[named.reduce((best, key) => (distance(mid(key), colour) < distance(mid(best), colour) ? key : best))];
    }
  const first = pieces[0].spec;
  return {
    spec: {
      id: header.id ?? 'compose-' + path.basename(out).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: header.name ?? path.basename(out), seed: first.seed ?? 1,
      style: header.style ?? first.style ?? 'moss', palette, roles,
      ...(header.light ?? first.light ? { light: header.light ?? first.light } : {}),
      ...(header.finish ?? first.finish ? { finish: header.finish ?? first.finish } : {}),
      camera: header.camera ?? first.camera,
      solids
    },
    warnings
  };
}

/* buildPart(source, engine, outDir, options) builds one part with its engine and returns its report */
async function buildModel(file, { out, kit, buildPart, overwrite = false }) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The compose file is not JSON: ' + error.message);
  }
  if (!Array.isArray(source.parts) || !source.parts.length) throw new Error('A composition needs "parts": [ { "source" | "diorama", "at", "yaw", "scale", "size" }, ... ]');
  const sceneFile = path.join(out, 'scene.json');
  if (fs.existsSync(sceneFile) && !overwrite) throw Object.assign(new Error('A model already exists in ' + out), { code: 'EXISTS' });
  const base = path.dirname(file), pieces = [];
  for (const [i, part] of source.parts.entries()) {
    const label = 'parts[' + i + ']';
    if (part.diorama) {
      const scene = path.resolve(base, part.diorama);
      if (!fs.existsSync(scene)) throw new Error(label + ': no diorama at ' + scene);
      pieces.push({ spec: JSON.parse(fs.readFileSync(scene, 'utf8')), dir: path.dirname(scene), place: part, label });
    } else if (part.source) {
      const src = path.resolve(base, part.source);
      const dir = path.join(out, 'sources', String(i + 1).padStart(2, '0') + '-' + path.basename(src).replace(/\..*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      const report = await buildPart(src, part.engine, dir, { size: part.size, pixelSize: part.pixelSize, overwrite: true, ...(part.options ?? {}) });
      pieces.push({ spec: JSON.parse(fs.readFileSync(report.scene, 'utf8')), dir, place: part, label });
    } else throw new Error(label + ' needs "source" (built with its engine) or "diorama" (a scene file)');
  }
  fs.mkdirSync(out, { recursive: true });
  const { spec, warnings } = composeSpecs(pieces, { styles: kit.diorama.styles, out, header: source });
  fs.writeFileSync(sceneFile, JSON.stringify(spec, null, 2) + '\n');
  return { directory: out, scene: sceneFile, parts: pieces.map(p => p.label), solids: spec.solids.length, colours: spec.palette.length, roles: Object.keys(spec.roles), warnings, spec };
}

module.exports = { buildModel, composeSpecs };
