'use strict';
/* Voxels as a modelling front end. A model is typed as plans of letters (see src/kit/kl-vox.js), with a colour per letter:

     { "cell": 0.1, "hard": true, "mirror": "x",
       "colours": { "o": "#5b6b2e", "t": { "colour": "#2b2b2b", "role": "track" } },
       "layers": [ "oooo/oooo", ["tttt/t..t", 2], ... ] }        or "front": [...] (pictures from the front back)

   It becomes one `vox` solid in the diorama, baked from the grid itself, with a palette role per colour (named by "role",
   else by its colour, so letters of one colour share a ramp). model.glb holds the visible block faces, one mesh per
   letter, and raw.png shows them, so the blocks can be judged before baking like any other front end's mesh. */
const fs = require('node:fs');
const path = require('node:path');

const FACES = [
  [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
  [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
  [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
  [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
  [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]]
];

const colourOf = value => {
  const text = typeof value === 'object' && value ? value.colour ?? value.color : value;
  if (typeof text === 'number') return text;
  if (typeof text === 'string' && /^#?[0-9a-f]{6}$/i.test(text)) return parseInt(text.replace('#', ''), 16);
  throw new Error('a colour is "#rrggbb" or { "colour": "#rrggbb", "role": name }, not ' + JSON.stringify(value));
};

/* the visible faces of every block, one part per letter, in scene units centred on x and z and standing on y = 0 (where
   the vox solid puts them) */
function blockParts({ nx, ny, nz, grid, keys }, cell, roles) {
  const [cx, cy, cz] = cell, hx = (nx * cx) / 2, hz = (nz * cz) / 2;
  const filled = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && grid[(x * ny + y) * nz + z] > 0;
  const pos = keys.map(() => []), index = keys.map(() => []);
  for (let x = 0; x < nx; x++)
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++) {
        const k = grid[(x * ny + y) * nz + z];
        if (!k) continue;
        for (const [[dx, dy, dz], corners] of FACES) {
          if (filled(x + dx, y + dy, z + dz)) continue;
          const at = pos[k - 1].length / 3;
          for (const [a, b, c] of corners) pos[k - 1].push((x + a) * cx - hx, (y + b) * cy, (z + c) * cz - hz);
          index[k - 1].push(at, at + 1, at + 2, at, at + 2, at + 3);
        }
      }
  return keys
    .map((letter, i) => ({ name: letter, pos: Float32Array.from(pos[i]), index: Uint32Array.from(index[i]), role: roles[letter] }))
    .filter(part => part.index.length);
}

async function buildModel(file, { out, size, shades = 4, pixelSize, pixelStyle, overwrite = false, kit }) {
  const Core = require('./model-core.js');
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The voxel file is not JSON: ' + error.message);
  }
  if (!source.colours || typeof source.colours !== 'object') throw new Error('A voxel model needs "colours": { letter: "#rrggbb", ... }');
  const roles = {};
  for (const [letter, value] of Object.entries(source.colours)) roles[letter] = Core.roleFor(value?.role, colourOf(value));
  const model = { layers: source.layers, front: source.front, mirror: source.mirror, key: Object.fromEntries(Object.keys(roles).map(k => [k, k])) };
  const grid = kit.vox.parse(model);

  const cell0 = Array.isArray(source.cell) ? source.cell : [source.cell ?? 0.1, source.cell ?? 0.1, source.cell ?? 0.1];
  const extent0 = Math.max(grid.nx * cell0[0], grid.ny * cell0[1], grid.nz * cell0[2]);
  const k = size ? size / extent0 : 1, cell = cell0.map(c => Core.round(c * k));

  const sceneFile = path.join(out, 'scene.json');
  if (fs.existsSync(sceneFile) && !overwrite) throw Object.assign(new Error('A model already exists in ' + out), { code: 'EXISTS' });
  fs.mkdirSync(out, { recursive: true });

  const parts = blockParts(grid, cell, roles);
  fs.writeFileSync(path.join(out, 'model.glb'), Core.toGlb(parts));
  Core.writeRaw(parts, path.join(out, 'raw.png'));

  const { palette, roles: ramps, named } = Core.rolePalette(Object.values(roles), { shades, styles: kit.diorama?.styles });
  const style = Core.pixelStyleOf(pixelStyle, shades);
  const header = Core.sceneHeader({ name: path.basename(out), prefix: 'vox', palette, roles: ramps, pixelStyle: style, pixelSize });
  const solid = {
    kind: 'vox', at: [0, 0, 0], cell: cell[0] === cell[1] && cell[1] === cell[2] ? cell[0] : cell,
    hard: source.hard ?? true, ...(source.round !== undefined ? { round: source.round } : {}),
    ...(source.mirror ? { mirror: source.mirror } : {}),
    key: Object.fromEntries(Object.entries(roles).map(([letter, role]) => [letter, style ? { role: role.key, pixelStyle: style } : role.key])),
    ...(source.layers ? { layers: source.layers } : { front: source.front })
  };
  const height = grid.ny * cell[1], span = Math.max(grid.nx * cell[0], grid.nz * cell[2], height);
  const spec = { ...header, camera: Core.cameraFor(height, span), solids: [solid] };
  fs.writeFileSync(sceneFile, JSON.stringify(spec, null, 2) + '\n');
  return {
    directory: out, scene: sceneFile, model: path.join(out, 'model.glb'), raw: path.join(out, 'raw.png'),
    blocks: grid.grid.reduce((sum, v) => sum + (v > 0), 0), grid: [grid.nx, grid.ny, grid.nz],
    triangles: parts.reduce((sum, part) => sum + part.index.length / 3, 0), extent: Core.round(span),
    colours: palette.length, roles: named, warnings: [], spec
  };
}

module.exports = { buildModel };
