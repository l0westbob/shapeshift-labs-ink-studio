// A small tank as subdivision cages, for model_build (engine "subd"). Y up, X forward, Z across, metres.
// Coarse cages are smoothed by Catmull-Clark; creased loops keep the flat faces flat while outlines round.
export default ({ cage }) => {
  const turnZ = m => cage.map(m, ([x, y, z]) => [x, -z, y]);   // a Y-axis prism turned to face Z
  const turnX = m => cage.map(m, ([x, y, z]) => [y, -x, z]);   // a Y-axis prism turned to lie along X
  const at = (m, [dx, dy, dz], [sx, sy, sz] = [1, 1, 1]) => cage.map(m, ([x, y, z]) => [x * sx + dx, y * sy + dy, z * sz + dz]);
  const both = m => [...m.rings[0], ...m.rings[1]];
  const ringCreases = m => m.rings.flatMap(r => cage.ring(r));
  const cages = [];
  const add = (name, colour, role, m, creases, levels = 3) => cages.push({ name, colour, role, levels, vertices: m.vertices, faces: m.faces, creases });

  // hull: side profile with glacis and rear plate, extruded across; its outline loops are creased
  const hull = cage.outline([[-2.55, 0.45], [2.15, 0.45], [2.7, 0.92], [2.25, 1.3], [-2.45, 1.3], [-2.65, 1.02]], -1, 1);
  add('hull', '#5b6b2e', 'olive', hull, ringCreases(hull), 2);
  // tracks: a stadium control polygon, creased on both faces so the sides stay flat
  const stadium = [[-2.55, 0.05], [2.55, 0.05], [2.75, 0.46], [2.55, 0.88], [-2.55, 0.88], [-2.75, 0.46]];
  for (const [side, z] of [['left', 1.25], ['right', -1.25]]) {
    const t = cage.outline(stadium, z - 0.27, z + 0.27);
    add('track-' + side, '#2b2b2b', 'track', t, ringCreases(t));
  }
  // road wheels: octagonal discs facing Z, creased rims
  for (const z of [1.53, -1.53]) for (let i = 0; i < 6; i++) {
    const w = turnZ(cage.prism(8, 0.31, -0.05, 0.05));
    const n = 8, rims = [cage.ring(Array.from({ length: n }, (_, k) => k)), cage.ring(Array.from({ length: n }, (_, k) => n + k))].flat();
    add('wheel', '#777b72', 'steel', at(w, [-1.9 + i * 0.76, 0.43, z]), rims, 2);
  }
  // turret: an octagonal prism narrowing to the top, creased at the base
  const turret = cage.map(cage.prism(8, 1, 0, 0.55), ([x, y, z]) => (y > 0.1 ? [x * 0.78, y, z * 0.78] : [x, y, z]));
  add('turret', '#5b6b2e', 'olive', at(turret, [-0.35, 1.3, 0], [1.15, 1, 0.95]), cage.ring([0, 1, 2, 3, 4, 5, 6, 7]));
  // mantlet and barrel
  const mantlet = cage.box([0.75, 1.6, 0], [0.18, 0.21, 0.4]);
  add('mantlet', '#3f4a22', 'dark-olive', mantlet, [[0, 2], [2, 6], [6, 4], [4, 0]], 2);
  const barrel = turnX(cage.prism(8, 0.085, 0, 2.5));
  add('barrel', '#3f4a22', 'dark-olive', at(barrel, [0.9, 1.6, 0]), [...cage.ring([0, 1, 2, 3, 4, 5, 6, 7]), ...cage.ring([8, 9, 10, 11, 12, 13, 14, 15])], 2);
  const brake = turnX(cage.prism(8, 0.13, 0, 0.32));
  add('muzzle-brake', '#3f4a22', 'dark-olive', at(brake, [3.3, 1.6, 0]), [...cage.ring([0, 1, 2, 3, 4, 5, 6, 7]), ...cage.ring([8, 9, 10, 11, 12, 13, 14, 15])], 2);
  // cupola: a short prism, its top left soft so it domes
  add('cupola', '#3f4a22', 'dark-olive', at(cage.prism(8, 0.3, 0, 0.24), [-0.7, 1.84, -0.35]), cage.ring([0, 1, 2, 3, 4, 5, 6, 7]));
  // fenders and engine deck: flat plates with creased outlines
  for (const z of [1.31, -1.31]) add('fender', '#3f4a22', 'dark-olive', cage.box([0.05, 1.03, z], [2.55, 0.03, 0.31]), [[0, 1], [2, 3], [4, 5], [6, 7], [0, 4], [1, 5], [2, 6], [3, 7]], 2);
  add('engine-deck', '#3f4a22', 'dark-olive', cage.box([-2.0, 1.36, 0], [0.25, 0.06, 0.7]), [[0, 1], [2, 3], [4, 5], [6, 7]], 2);
  add('antenna', '#777b72', 'steel', at(cage.prism(6, 0.02, 0, 1.1), [-1.2, 1.84, 0.55]), [...cage.ring([0, 1, 2, 3, 4, 5]), ...cage.ring([6, 7, 8, 9, 10, 11])], 1);
  return { cages };
};
