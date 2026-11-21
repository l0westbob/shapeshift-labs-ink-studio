'use strict';
/* 2.5D levels from plans, the way Wolfenstein drew from a tile grid and Doom from sectors: a floor plan with heights
   becomes walls, floors, steps and openings. A .level.json is a tile map or a list of sectors (or both):

     { "tile": 1, "block": 0.25, "wall": 3,
       "tiles": { "#": { "wall": true, "colour": "#7a6a58", "role": "stone" },
                  ".": { "floor": 0, "colour": "#5a4a3a", "role": "floor" },
                  "=": { "floor": 1, "colour": "#8a7a68" },
                  "+": { "door": 2.2, "colour": "#7a6a58", "floorColour": "#5a4a3a" },
                  "~": { "floor": -0.5, "liquid": 0, "colour": "#5a4a3a", "liquidColour": "#3a6a9a" } },
       "map": [ "#######", "#..=..#", "#..=..+", "#######" ],
       "sectors": [ { "points": [[0, 0], [6, 0], [6, 4], [0, 4]], "floor": 0, "colour": "#5a4a3a", "walls": 3, "wallColour": "#7a6a58" } ] }

   A tile is `tile` metres square and made of blocks `block` metres across. Wall tiles rise to `wall` metres; floor tiles
   are a slab whose top is at `floor` (stairs and platforms are just higher floors); door tiles are walls with an opening
   up to `door` metres; liquid fills a sunken floor up to its level. Map rows run from the back (-z) to the front, letters
   along x. Sectors are polygons in metres on the ground (x, z) with a floor height; with `walls` they get walls of that
   height along their edges. Everything continues as a voxel model. */
const fs = require('node:fs');
const { withCamera, voxSource } = require('./vox-grid.js');

const inside = (pts, x, z) => {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
const edgeDistance = (pts, x, z) => {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, az] = pts[j], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
};

async function buildModel(file, options) {
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  const block = source.block ?? 0.25, tile = source.tile ?? 1, wallHeight = source.wall ?? 3;
  const map = (source.map ?? []).map(row => row.replace(/\s+$/, ''));
  const sectors = source.sectors ?? [];
  if (!map.length && !sectors.length) throw new Error('A level needs a "map" of tiles or "sectors"');
  for (const row of map) for (const ch of row) if (ch !== ' ' && !source.tiles?.[ch]) throw new Error('The letter "' + ch + '" is not in tiles');
  /* the extent in metres, from the map and the sectors; floors may sink below zero */
  const mapW = Math.max(0, ...map.map(r => r.length)) * tile, mapD = map.length * tile;
  const sx = sectors.flatMap(s => s.points.map(p => p[0])), sz = sectors.flatMap(s => s.points.map(p => p[1]));
  const x0 = Math.min(0, ...sx), z0 = Math.min(0, ...sz), x1 = Math.max(mapW, ...sx), z1 = Math.max(mapD, ...sz);
  const lowest = Math.min(0, ...Object.values(source.tiles ?? {}).map(t => t.floor ?? 0), ...sectors.map(s => s.floor ?? 0)) - block;
  const highest = Math.max(wallHeight, ...Object.values(source.tiles ?? {}).map(t => t.floor ?? 0), ...sectors.map(s => Math.max(s.floor ?? 0, s.walls ?? 0)));
  const nx = Math.ceil((x1 - x0) / block), nz = Math.ceil((z1 - z0) / block), ny = Math.ceil((highest - lowest) / block) + 1;
  const yAt = metres => Math.round((metres - lowest) / block);
  const grid = {
    nx, ny, nz,
    at(ix, iy, iz) {
      const x = x0 + (ix + 0.5) * block, z = z0 + (iz + 0.5) * block;
      let got = null;
      /* tiles */
      const tx = Math.floor(x / tile), tz = Math.floor(z / tile), ch = map[tz]?.[tx];
      const t = ch && ch !== ' ' ? source.tiles[ch] : null;
      if (t) {
        if (t.wall) got = iy <= yAt(t.height ?? wallHeight) ? t : null;
        else if (t.door !== undefined) got = iy <= yAt(0) ? { colour: t.floorColour ?? t.colour, role: t.floorRole } : iy > yAt(t.door) && iy <= yAt(t.height ?? wallHeight) ? t : null;
        else {
          const top = yAt(t.floor ?? 0);
          if (iy <= top) got = t;
          else if (t.liquid !== undefined && iy <= yAt(t.liquid)) got = { colour: t.liquidColour ?? '#3a6a9a', role: t.liquidRole ?? 'liquid' };
        }
      }
      /* sectors, drawn over the tiles in order */
      for (const s of sectors) {
        if (!inside(s.points, x, z)) continue;
        if (s.walls && edgeDistance(s.points, x, z) < block && iy <= yAt(s.walls)) got = { colour: s.wallColour ?? s.colour, role: s.wallRole };
        else if (iy <= yAt(s.floor ?? 0)) got = { colour: s.colour, role: s.role };
        else if (got && got !== t) got = null;
      }
      return got && got.colour ? got : null;
    }
  };
  const vox = voxSource(grid, { cell: block, hard: source.hard ?? true, colours: 'exact' });
  const report = await require('./vox-model.js').buildFromSource(vox, { ...options, prefix: 'level' });
  return withCamera(report, { pitch: 1.0, ...source.camera });
}

module.exports = { buildModel };
