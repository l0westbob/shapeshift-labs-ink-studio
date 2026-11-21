'use strict';
/* Painting with splats: a model made of brush strokes in space instead of a mesh, for painterly things (trees, bushes,
   smoke, cloth, creatures). A .paint.json lists colours and strokes:

     { "colours": { "bark": "#5a3a20", "leaf": { "colour": "#4f7a2a", "role": "leaf" } },
       "blend": 0.06,
       "strokes": [
         { "colour": "bark", "points": [[0, 0, 0], [0.1, 1.2, 0], [0.3, 2, 0]], "width": 0.35, "taper": [1, 0.4] },
         { "colour": "leaf", "dab": [0.3, 2.3, 0], "r": 0.5 },
         { "colour": "leaf", "scatter": { "around": [0, 2.4, 0], "radius": 0.9, "count": 30, "size": [0.12, 0.25], "seed": 4 } } ] }

   A stroke is a tube along its points (width, optional depth for a flat brush, taper [start, end] and pressure per point);
   a dab is a ball (r is a number or [x, y, z]); a scatter is many dabs inside a ball, placed by its seed (flatten < 1
   squashes it). Strokes of one colour melt into each other (blend is the softness); colours meet with a hard edge. Each
   colour becomes a palette role with its own ramp. The diorama is the model itself: there is no mesh hand-off. */
const fs = require('node:fs');
const path = require('node:path');

const colourOf = value => {
  const text = typeof value === 'object' && value ? value.colour ?? value.color : value;
  if (typeof text === 'number') return text;
  if (typeof text === 'string' && /^#?[0-9a-f]{6}$/i.test(text)) return parseInt(text.replace('#', ''), 16);
  throw new Error('a colour is "#rrggbb" or { "colour": "#rrggbb", "role": name }, not ' + JSON.stringify(value));
};

function random(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

async function buildModel(file, { out, shades = 4, pixelSize, pixelStyle, overwrite = false, kit }) {
  const Core = require('./model-core.js');
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The paint file is not JSON: ' + error.message);
  }
  if (!source.colours || !Array.isArray(source.strokes) || !source.strokes.length)
    throw new Error('A painting needs "colours": { name: "#rrggbb" } and "strokes": [ ... ]');
  const roles = {};
  for (const [name, value] of Object.entries(source.colours)) roles[name] = Core.roleFor(value?.role ?? name, colourOf(value));
  const { palette, roles: ramps, named } = Core.rolePalette(Object.values(roles), { shades, styles: kit.diorama?.styles });
  const style = Core.pixelStyleOf(pixelStyle, shades);
  const blend = source.blend ?? 0.06;
  const solids = [], points = [], groups = {};
  const matFor = name => {
    const role = roles[name];
    if (!role) throw new Error('No colour called "' + name + '"; colours: ' + Object.keys(roles).join(', '));
    groups['paint-' + role.key] = { blend };
    return { mat: style ? { role: role.key, pixelStyle: style } : role.key, group: 'paint-' + role.key };
  };
  const ball = (at, r, name) => {
    solids.push({ kind: 'ball', at: at.map(Core.round), r: Array.isArray(r) ? r.map(Core.round) : Core.round(r), ...matFor(name) });
    const reach = Array.isArray(r) ? Math.max(...r) : r;
    points.push(at.map(v => v - reach), at.map(v => v + reach));
  };
  source.strokes.forEach((stroke, i) => {
    const where = 'strokes[' + i + ']';
    if (stroke.points) {
      if (!Array.isArray(stroke.points) || stroke.points.length < 2) throw new Error(where + ': a stroke needs two or more [x, y, z] points');
      const solid = { kind: 'stroke', points: stroke.points, width: stroke.width ?? 0.2, ...matFor(stroke.colour) };
      for (const key of ['depth', 'taper', 'pressure']) if (stroke[key] !== undefined) solid[key] = stroke[key];
      solids.push(solid);
      const w = solid.width / 2;
      for (const p of stroke.points) points.push(p.map(v => v - w), p.map(v => v + w));
    } else if (stroke.dab) ball(stroke.dab, stroke.r ?? 0.2, stroke.colour);
    else if (stroke.scatter) {
      const { around, radius = 1, count = 20, size = [0.1, 0.2], seed = 1, flatten = 1 } = stroke.scatter;
      const next = random(seed);
      for (let n = 0; n < count; n++) {
        /* uniform inside the ball: a direction and a cube-root radius */
        const u = next() * 2 - 1, phi = next() * 2 * Math.PI, rr = radius * Math.cbrt(next()), s = Math.sqrt(1 - u * u);
        const at = [around[0] + rr * s * Math.cos(phi), around[1] + rr * u * flatten, around[2] + rr * s * Math.sin(phi)];
        ball(at, size[0] + (size[1] - size[0]) * next(), stroke.colour);
      }
    } else throw new Error(where + ' needs points (a stroke), dab (a ball) or scatter');
  });
  const lo = [0, 1, 2].map(k => Math.min(...points.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...points.map(p => p[k])));
  const sceneFile = path.join(out, 'scene.json');
  if (fs.existsSync(sceneFile) && !overwrite) throw Object.assign(new Error('A model already exists in ' + out), { code: 'EXISTS' });
  fs.mkdirSync(out, { recursive: true });
  const header = Core.sceneHeader({ name: path.basename(out), prefix: 'paint', palette, roles: ramps, pixelStyle: style, pixelSize });
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const camera = { ...Core.cameraFor(hi[1] - lo[1], span), target: [Core.round((lo[0] + hi[0]) / 2), Core.round((lo[1] + hi[1]) / 2), Core.round((lo[2] + hi[2]) / 2)] };
  const spec = { ...header, groups, camera, solids };
  fs.writeFileSync(sceneFile, JSON.stringify(spec, null, 2) + '\n');
  return { directory: out, scene: sceneFile, solids: solids.length, colours: palette.length, roles: named, extent: Core.round(span), warnings: [], spec };
}

module.exports = { buildModel };
