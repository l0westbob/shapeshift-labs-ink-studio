'use strict';
/* Height-map terrain: a grey picture (or generated noise) becomes ground, one column of blocks per pixel, coloured in
   bands by height, with rock on steep slopes and water up to a level. A .terrain.json:

     { "height": "island.png" | { "noise": { "seed": 4, "size": [64, 64], "scale": 0.06, "octaves": 5, "island": 0.8 } },
       "levels": 20, "cell": 0.1, "water": 0.3,
       "bands": [ { "below": 0.34, "colour": "#d8c890", "role": "sand" },
                  { "below": 0.7, "colour": "#5f8f3a", "role": "grass" },
                  { "below": 1.01, "colour": "#e8ecef", "role": "snow" } ],
       "slope": { "above": 3, "colour": "#7a7470", "role": "rock" },
       "soil": { "colour": "#6a4a30", "role": "soil" },
       "waterColour": { "colour": "#3a6a9a", "role": "water" } }

   Height 0..1 (white high) maps to `levels` blocks. A column's top block takes the band of its height, or rock where it
   rises more than `slope.above` blocks over a neighbour; the blocks below are soil. Where the ground lies under the
   water level, water fills up to it. Heightfields cannot overhang; carve or edit the written voxel model for caves. */
const fs = require('node:fs');
const path = require('node:path');
const { withCamera, voxSource, image, noise2 } = require('./vox-grid.js');

async function buildModel(file, options) {
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  let w, d, heightAt;
  if (typeof source.height === 'string') {
    const img = image(path.resolve(path.dirname(file), source.height));
    (w = img.w), (d = img.h);
    heightAt = (x, z) => (img.alpha(x, z) < 0.5 ? null : img.grey(x, z));
  } else if (source.height?.noise) {
    const { seed = 1, size = [48, 48], scale = 0.07, octaves = 5, island = 0 } = source.height.noise;
    [w, d] = size;
    const n = noise2(seed);
    heightAt = (x, z) => {
      let v = n(x * scale, z * scale, octaves);
      /* island: fall off towards the edges so the land sits in the sea */
      if (island) v *= 1 - island * Math.min(1, Math.hypot((x / (w - 1)) * 2 - 1, (z / (d - 1)) * 2 - 1) ** 2);
      return Math.max(0, Math.min(1, (v - 0.15) / 0.7));
    };
  } else throw new Error('A terrain needs "height": a picture, or { "noise": { ... } }');
  const levels = source.levels ?? 16, waterLevel = source.water !== undefined ? Math.round(source.water * levels) : -1;
  const bands = (source.bands ?? [{ below: 0.35, colour: '#d8c890', role: 'sand' }, { below: 0.75, colour: '#5f8f3a', role: 'grass' }, { below: 1.01, colour: '#7a7470', role: 'rock' }]).slice().sort((a, b) => a.below - b.below);
  const soil = source.soil ?? { colour: '#6a4a30', role: 'soil' }, slope = source.slope, water = source.waterColour ?? { colour: '#3a6a9a', role: 'water' };
  const tops = new Array(w * d);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    const v = heightAt(x, z);
    tops[z * w + x] = v === null ? null : { block: Math.max(0, Math.round(v * levels)), v };
  }
  const topOf = (x, z) => (x < 0 || z < 0 || x >= w || z >= d ? null : tops[z * w + x]);
  const grid = {
    nx: w, ny: levels + 1, nz: d,
    at(x, y, z) {
      const t = topOf(x, z);
      if (!t) return null;
      if (y > t.block) return y <= waterLevel ? water : null;
      if (y < t.block) return soil;
      if (slope) {
        const rise = Math.max(...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => t.block - (topOf(x + a, z + b)?.block ?? t.block)));
        if (rise > slope.above) return slope;
      }
      return bands.find(b => t.v < b.below) ?? bands.at(-1);
    }
  };
  const vox = voxSource(grid, { cell: source.cell ?? 0.1, hard: source.hard ?? true, colours: 'exact' });
  const report = await require('./vox-model.js').buildFromSource(vox, { ...options, prefix: 'terrain' });
  return withCamera(report, { pitch: 0.6, ...source.camera });
}

module.exports = { buildModel };
