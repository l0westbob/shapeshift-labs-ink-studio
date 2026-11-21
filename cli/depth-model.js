'use strict';
/* Depth maps, in the spirit of layered depth images: draw the sprite, then say how far each pixel stands out. A
   .depth.json names the pictures:

     { "image": "front.png", "depth": "front-depth.png", "whiteNear": true, "layers": 16, "cell": 0.1,
       "back": "mirror" | "flat" | { "image": "back.png", "depth": "back-depth.png" },
       "colours": "exact" | 6, "names": ["olive", ...] }

   Every opaque pixel becomes a column of blocks along z (towards the viewer). The front depth sets where the column ends
   in front (white near, unless whiteNear is false), in `layers` steps. The back is flat (a relief on a plate), mirrored
   (the same shape behind, for round things) or its own picture and depth seen from behind, so the object is closed by a
   second layer. Front blocks take the front picture's colour, back blocks the back picture's, inside blocks the front's.
   The result continues as a voxel model. The CLI's `depth` command makes a lit relief from a single photo-like depth map;
   this engine is for drawn sprites. */
const fs = require('node:fs');
const path = require('node:path');
const { withCamera, voxSource, image } = require('./vox-grid.js');

async function buildModel(file, options) {
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file), load = name => image(path.resolve(base, name));
  if (!source.image || !source.depth) throw new Error('A depth model needs "image" and "depth" (pictures of the same size)');
  const front = load(source.image), depth = load(source.depth);
  if (front.w !== depth.w || front.h !== depth.h) throw new Error('image and depth differ in size: ' + front.w + ' x ' + front.h + ' and ' + depth.w + ' x ' + depth.h);
  const layers = source.layers ?? 16, near = source.whiteNear === false ? v => 1 - v : v => v;
  const back = source.back ?? 'mirror';
  let backImage = null, backDepth = null;
  if (typeof back === 'object') {
    backImage = back.image ? load(back.image) : null;
    backDepth = load(back.depth);
    if (backDepth.w !== front.w || backDepth.h !== front.h) throw new Error('back depth must match the front picture in size');
  }
  const { w, h } = front, twoSided = back !== 'flat', nz = twoSided ? 2 * layers + 1 : layers + 1, mid = twoSided ? layers : 0;
  /* per column: the front and back z (in blocks) and the colours, or null where the pixel is empty */
  const columns = new Array(w * h).fill(null);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (front.alpha(x, y) < 0.5 || depth.alpha(x, y) < 0.5) continue;
      const zf = mid + Math.round(near(depth.grey(x, y)) * layers);
      let zb = 0, backColour = front.rgb(x, y);
      if (back === 'mirror') zb = 2 * mid - zf;
      else if (typeof back === 'object') {
        /* seen from behind, the back pictures run the other way round */
        const bx = w - 1 - x;
        if (backDepth.alpha(bx, y) < 0.5) zb = mid;
        else zb = mid - Math.round(near(backDepth.grey(bx, y)) * layers);
        if (backImage && backImage.alpha(bx, y) >= 0.5) backColour = backImage.rgb(bx, y);
      }
      columns[y * w + x] = { zf, zb: Math.min(zb, zf), front: front.rgb(x, y), back: backColour };
    }
  const grid = {
    nx: w, ny: h, nz,
    at(x, y, z) {
      const c = columns[(h - 1 - y) * w + x];
      if (!c || z < c.zb || z > c.zf) return null;
      return z === c.zb && z !== c.zf ? c.back : c.front;
    }
  };
  /* colour keys in any case: #5B6B2E and #5b6b2e are the same colour */
  const roles = Object.fromEntries(Object.entries(source.roles ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const vox = voxSource(grid, { cell: source.cell ?? 0.1, hard: source.hard ?? true, colours: source.colours ?? 'exact', names: source.names, roleOf: h => roles[h] });
  const report = await require('./vox-model.js').buildFromSource(vox, { ...options, prefix: 'depth' });
  return withCamera(report, { ...source.camera });
}

module.exports = { buildModel };
