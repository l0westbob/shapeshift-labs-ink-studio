'use strict';
/* What every modelling front end shares once it has triangles: welding, one GLB per part, a palette role per material,
   the raw preview and the diorama that places the parts. Front ends (three.js, CadQuery, ...) only turn their model into
   parts:

     { name, pos: Float32Array xyz (world, Y up), index?: Uint32Array, colours?: Float32Array linear rgb per vertex,
       role: { key, colour: 0xrrggbb } | null }          role null: shade from the vertex colours with the automatic mesh look

   Each part becomes its own GLB and its own `mesh` solid. A distance field from one triangle soup decides inside and
   outside by counting crossings, so two overlapping closed shells would cancel out where they overlap; as separate solids
   the diorama unions their fields instead. */
const fs = require('node:fs');
const path = require('node:path');

const round = v => Math.round(v * 1e4) / 1e4;
const slugOf = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const slug = (name, i) => String(i).padStart(2, '0') + (slugOf(name) ? '-' + slugOf(name).slice(0, 32) : '');

/* a role named by `named` (a material name or explicit role), else by its colour */
const roleFor = (named, colour) => ({ key: slugOf(named) || 'paint-' + colour.toString(16).padStart(6, '0'), colour });

/* merges vertices closer than `tolerance` (front ends split them along seams and faces, and the distance field needs closed
   surfaces) and drops triangles that collapse */
function weld(part, tolerance) {
  const { pos, colours } = part, count = pos.length / 3;
  const source = part.index ?? Uint32Array.from({ length: count }, (_, i) => i);
  const seen = new Map(), remap = new Uint32Array(count), keep = [], keepColours = [];
  for (let i = 0; i < count; i++) {
    const key = Math.round(pos[i * 3] / tolerance) + ',' + Math.round(pos[i * 3 + 1] / tolerance) + ',' + Math.round(pos[i * 3 + 2] / tolerance);
    let at = seen.get(key);
    if (at === undefined) {
      at = keep.length / 3;
      seen.set(key, at);
      keep.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      if (colours) keepColours.push(colours[i * 3], colours[i * 3 + 1], colours[i * 3 + 2]);
    }
    remap[i] = at;
  }
  const index = [];
  for (let t = 0; t < source.length; t += 3) {
    const a = remap[source[t]], b = remap[source[t + 1]], c = remap[source[t + 2]];
    if (a !== b && b !== c && a !== c) index.push(a, b, c);
  }
  return { ...part, pos: Float32Array.from(keep), index: Uint32Array.from(index), colours: colours ? Float32Array.from(keepColours) : undefined };
}

function partBounds(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[i + k]);
      hi[k] = Math.max(hi[k], pos[i + k]);
    }
  return { lo, hi };
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

/* --- GLB ------------------------------------------------------------------------------------------------------------ */

const linear = c => [16, 8, 0].map(k => Math.pow(((c >> k) & 255) / 255, 2.2));

/* one node and mesh per part; material colours go in linear, as glTF wants (readers turn them back into sRGB) */
function toGlb(parts) {
  const { document } = require('./glb-file.js');
  const doc = document();
  for (const part of parts) {
    const attributes = { POSITION: doc.accessor(part.pos, 'VEC3', { target: 34962, bounds: true }) };
    if (part.colours) attributes.COLOR_0 = doc.accessor(part.colours, 'VEC3', { target: 34962 });
    const material = doc.add('materials', {
      name: part.role?.key, pbrMetallicRoughness: { baseColorFactor: [...linear(part.role?.colour ?? 0xffffff), 1], metallicFactor: 0, roughnessFactor: 1 }
    });
    const mesh = doc.add('meshes', {
      name: part.name || undefined,
      primitives: [{ attributes, indices: doc.accessor(part.index, 'SCALAR', { target: 34963 }), material }]
    });
    doc.gltf.scenes[0].nodes.push(doc.add('nodes', { name: part.name || undefined, mesh }));
  }
  return doc.finish();
}

/* --- palette ---------------------------------------------------------------------------------------------------------- */

const toHsl = c => {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), l = (hi + lo) / 2, d = hi - lo;
  if (d < 1e-6) return [0, 0, l];
  const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
};
const fromHsl = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].reduce((v, k) => (v << 8) | Math.round(Math.min(1, Math.max(0, k + m)) * 255), 0);
};
/* turns hue h towards target by up to `by` degrees, the short way round */
const lean = (h, target, by) => h + Math.max(-by, Math.min(by, ((target - h + 540) % 360) - 180));

/* `n` shades of one colour, dark to light. The colour itself is the second lightest shade, where a face turned to the sun
   lands; shadows lean cool and darken, the top shade leans warm. Greys stay grey. */
function rampOf(colour, n) {
  const [h, s, l] = toHsl(colour), base = n - 2, dark = Math.max(0.05, l * 0.32), light = Math.min(0.94, l + (1 - l) * 0.42);
  return Array.from({ length: n }, (_, i) => {
    if (i === base) return colour;
    const shadow = i < base, t = shadow ? 1 - i / base : 1;
    const ll = shadow ? l + (dark - l) * t : light;
    const hh = s < 0.08 ? h : shadow ? lean(h, 235, 24 * t) : lean(h, 48, 12);
    return fromHsl(hh, Math.min(1, shadow ? s * (1 + 0.15 * t) : s * 0.85), ll);
  });
}

const distance = (a, b) => [16, 8, 0].reduce((sum, k) => sum + (((a >> k) & 255) - ((b >> k) & 255)) ** 2, 0);

/* an outline colour at 0, then one ramp per role (in the order roles are first met). The built-in role names (stone, metal,
   moss, ...) are mapped onto the nearest model ramp as well, so switching the diorama's `style` changes its light and
   finish but every role still points into this palette */
function rolePalette(roleList, { shades, styles }) {
  const roles = new Map();
  for (const role of roleList) if (role && !roles.has(role.key)) roles.set(role.key, role.colour);
  const palette = [0x0b0d10], ramps = {}, mid = {};
  for (const [key, colour] of roles) {
    const ramp = rampOf(colour, shades);
    ramps[key] = ramp.map((_, i) => palette.length + i);
    mid[key] = colour;
    palette.push(...ramp);
  }
  const keys = Object.keys(ramps), builtin = {};
  if (keys.length && styles)
    for (const [name, indices] of Object.entries(styles.slate.roles)) {
      if (ramps[name]) continue;
      const colour = styles.slate.palette[indices[Math.floor(indices.length / 2)]];
      builtin[name] = ramps[keys.reduce((best, key) => (distance(mid[key], colour) < distance(mid[best], colour) ? key : best))];
    }
  return { palette, roles: { ...builtin, ...ramps }, named: keys };
}

const pixelStyleOf = (pixelStyle, shades) => (pixelStyle === false ? null : pixelStyle === true || pixelStyle === undefined ? { dither: 'none', shadeSteps: shades } : pixelStyle);

/* top-level fields every generated diorama shares: palette and roles, sun, flat shading, pixel size */
function sceneHeader({ name, prefix, palette, roles, pixelStyle, pixelSize, sun }) {
  return {
    id: prefix + '-' + (slugOf(name) || 'model'),
    name: name || prefix + ' model',
    seed: 1,
    style: 'moss',
    palette,
    ...(roles && Object.keys(roles).length ? { roles } : {}),
    ...(sun ? { light: { sun } } : {}),
    /* the style's palette dither scatters pixels between the shade bands that pixelStyle keeps flat, so it is off with it */
    ...(pixelStyle || pixelSize ? { finish: { ...(pixelStyle ? { dither: 0 } : {}), ...(pixelSize ? { look: { pixelSize } } : {}) } } : {})
  };
}

const cameraFor = (height, span) => ({ target: [0, round(height / 2), 0], dist: round(span * 1.7), pitch: 0.35, yaw: 0.6 });

/* --- raw preview ------------------------------------------------------------------------------------------------------ */

/* the model before baking, flat-shaded from the front and the back (see raw-render.js) */
function writeRaw(parts, file) {
  const { rawRender } = require('./raw-render.js'), { encode } = require('./png.js');
  const shaded = parts.map(({ pos, index, colours, role }) => {
    let colour = role?.colour ?? 0xb4b4b4;
    if (!role && colours?.length) {
      /* vertex colours are linear: their mean, back to sRGB */
      const mean = [0, 1, 2].map(k => {
        let sum = 0;
        for (let i = k; i < colours.length; i += 3) sum += colours[i];
        return Math.round(255 * Math.pow(Math.min(1, sum / (colours.length / 3)), 1 / 2.2));
      });
      colour = (mean[0] << 16) | (mean[1] << 8) | mean[2];
    }
    return { pos, index, colour };
  });
  const image = rawRender(shaded, { w: 360, h: 270 });
  fs.writeFileSync(file, encode(image.w, image.h, image.rgb));
}

/* --- the diorama ------------------------------------------------------------------------------------------------------ */

/* one mesh solid per part, fitted so the whole model is `size` across (or kept at source units), centred on x and z and
   standing on y = 0. kb-mesh fits each asset to its own size and rests it on `at`, so each part gets the shared scale
   through its own size and lands where it was through `at` */
function dioramaFor(parts, { size, cells = 96, hues, pixelStyle, header, files, snap }) {
  const bounds = boundsOf(parts), extent = extentOf(bounds);
  const k = size ? size / extent : 1, h = extent / cells;
  const cx = (bounds.lo[0] + bounds.hi[0]) / 2, cz = (bounds.lo[2] + bounds.hi[2]) / 2, y0 = bounds.lo[1];
  /* snap: the model's longest side spans `snap` art pixels, so positions and sizes round to whole pixels and part edges
     land on the pixel grid instead of splitting pixels */
  const unit = snap ? (extent * k) / snap : 0;
  const grid = (v, least = 0) => (unit ? Math.max(least, Math.round(v / unit) * unit) : v);
  const solids = parts.map((part, i) => {
    const solid = {
      kind: 'mesh',
      asset: files[i],
      size: round(grid(extentOf(part) * k, unit)),
      at: [round(grid(((part.lo[0] + part.hi[0]) / 2 - cx) * k)), round(grid((part.lo[1] - y0) * k)), round(grid(((part.lo[2] + part.hi[2]) / 2 - cz) * k))],
      cells: Math.max(12, Math.ceil(extentOf(part) / h))
    };
    if (part.role) solid.mat = pixelStyle ? { role: part.role.key, pixelStyle } : part.role.key;
    else if (hues) solid.hues = hues;
    return solid;
  });
  return { ...header, camera: cameraFor((bounds.hi[1] - bounds.lo[1]) * k, extent * k), solids };
}

/* a part's bounds where the diorama puts it: scaled to `size`, centred on x and z, standing on y = 0 */
function placed(part, parts, size) {
  const bounds = boundsOf(parts), k = size ? size / extentOf(bounds) : 1;
  const offset = [(bounds.lo[0] + bounds.hi[0]) / 2, bounds.lo[1], (bounds.lo[2] + bounds.hi[2]) / 2];
  return { lo: part.lo.map((v, i) => round((v - offset[i]) * k)), hi: part.hi.map((v, i) => round((v - offset[i]) * k)) };
}

/* model.json: every part's name, role and bounds in scene units, for model_check and other tools */
function writeModelJson(out, parts) {
  fs.writeFileSync(path.join(out, 'model.json'), JSON.stringify({ units: 'scene', parts }, null, 1) + '\n');
}

/* writes model.glb (every part), parts/NN-name.glb, raw.png and scene.json into `out`. kit is the loaded ink-studio KIT,
   used for the palette of vertex-coloured parts and the open-edge report; readMesh reads a GLB back the way scenes will. */
function finiteOrThrow(parts) {
  for (const part of parts)
    for (let i = 0; i < part.pos.length; i++)
      if (!Number.isFinite(part.pos[i])) throw new Error('Part "' + (part.name || 'unnamed') + '" has a position that is not a number (vertex ' + Math.floor(i / 3) + ')');
}

async function buildFromParts(rawParts, { out, prefix, sun, warnings = [], size, cells, hues = 6, shades = 4, pixelSize, pixelStyle, snap, overwrite = false, kit, readMesh }) {
  finiteOrThrow(rawParts);
  const extent0 = extentOf(boundsOf(rawParts.map(part => partBounds(part.pos))));
  const parts = rawParts
    .map(part => weld(part, Math.max(extent0 * 1e-6, 1e-9)))
    .filter(part => part.index.length)
    .map(part => ({ ...part, ...partBounds(part.pos), triangles: part.index.length / 3 }));
  if (!parts.length) throw new Error('The model has no visible meshes with triangles');
  const sceneFile = path.join(out, 'scene.json'), partsDir = path.join(out, 'parts');
  if (fs.existsSync(sceneFile) && !overwrite) throw Object.assign(new Error('A model already exists in ' + out), { code: 'EXISTS' });
  fs.mkdirSync(partsDir, { recursive: true });
  for (const old of fs.readdirSync(partsDir)) if (old.endsWith('.glb')) fs.rmSync(path.join(partsDir, old));

  fs.writeFileSync(path.join(out, 'model.glb'), toGlb(parts));
  const files = parts.map((part, i) => {
    const rel = 'parts/' + slug(part.name, i + 1) + '.glb';
    fs.writeFileSync(path.join(out, rel), toGlb([part]));
    return rel;
  });

  /* parts with a material role shade on that role's ramp; parts with vertex colours keep the automatic mesh look, which
     clusters their colours into families appended to the same palette */
  const { palette, roles, named } = rolePalette(parts.map(part => part.role), { shades, styles: kit.diorama?.styles });
  const coloured = parts.filter(part => !part.role);
  if (coloured.length) {
    const file = path.join(partsDir, 'vertex-colours.tmp.glb');
    fs.writeFileSync(file, toGlb(coloured));
    const { pal } = kit.mesh.look(readMesh(file), { hues, shades, bg: palette[0] });
    fs.rmSync(file);
    palette.push(...pal.slice(1));
  }
  writeRaw(parts, path.join(out, 'raw.png'));
  const style = pixelStyleOf(pixelStyle, shades);
  const report = parts.map((part, i) => {
    const info = kit.mesh.info(readMesh(path.join(out, files[i])));
    if (info.open > 0.02) warnings.push(files[i] + ' (' + (part.name || 'unnamed') + ') is not closed (' + Math.round(info.open * 100) + '% open edges): it bakes as a sheet with thickness');
    return { name: part.name || undefined, file: files[i], triangles: part.triangles, open: round(info.open), role: part.role?.key };
  });
  const header = sceneHeader({ name: path.basename(out), prefix, palette, roles, pixelStyle: style, pixelSize, sun });
  const spec = dioramaFor(parts, { size, cells, hues, pixelStyle: style, header, files, snap });
  fs.writeFileSync(sceneFile, JSON.stringify(spec, null, 2) + '\n');
  writeModelJson(out, parts.map(part => ({ name: part.name, role: part.role?.key, ...placed(part, parts, size) })));
  const extent = extentOf(boundsOf(parts));
  return {
    directory: out,
    scene: sceneFile,
    model: path.join(out, 'model.glb'),
    raw: path.join(out, 'raw.png'),
    triangles: parts.reduce((sum, part) => sum + part.triangles, 0),
    extent: round(size ? size : extent),
    colours: palette.length,
    roles: named,
    parts: report,
    warnings,
    spec
  };
}

module.exports = { buildFromParts, writeModelJson, partBounds, toGlb, rolePalette, rampOf, roleFor, sceneHeader, cameraFor, pixelStyleOf, writeRaw, slugOf, round };
