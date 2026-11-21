// Tank modelled with three.js for model_three. Length along X (front = +X), Y up, width along Z.
export default async ({ THREE, addon }) => {
  const { RoundedBoxGeometry } = await addon('geometries/RoundedBoxGeometry');
  const tank = new THREE.Group();

  const mat = (c) => new THREE.MeshStandardMaterial({ color: c });
  const OLIVE = mat(0x6b7a3a);
  const OLIVE_DARK = mat(0x4c5a2a);
  const TRACK = mat(0x2e2b28);
  const WHEEL = mat(0x8a9450);
  const METAL = mat(0x2a2a2a);
  const TAN = mat(0xb59a5e);

  const add = (geo, m, name, x = 0, y = 0, z = 0, parent = tank) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.name = name;
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // Extrude a side profile (x, y) along Z, centred.
  const sideExtrude = (pts, depth, bevel = 0) => {
    const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(s, {
      depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1, curveSegments: 12,
    });
    g.translate(0, 0, -depth / 2);
    return g;
  };

  // ---- Hull: lower hull with sloped glacis, sitting between the tracks.
  const hullW = 2.2;
  add(sideExtrude([
    [-3.0, 0.55], [2.6, 0.55], [3.25, 1.05], [2.7, 1.45], [-2.9, 1.45], [-3.15, 1.1],
  ], hullW), OLIVE, 'hull');

  // Fenders / track guards over the tracks (wide thin plate).
  for (const s of [-1, 1]) {
    add(sideExtrude([
      [-3.2, 1.38], [3.0, 1.38], [3.35, 1.18], [3.4, 1.26], [3.05, 1.5], [-3.2, 1.5],
    ], 0.7), OLIVE_DARK, `fender${s > 0 ? 'L' : 'R'}`, 0, 0, s * 1.45);
  }

  // ---- Tracks: stadium loop, with road wheels, sprocket and idler.
  const trackLoop = () => {
    const s = new THREE.Shape();
    const r = 0.56, x0 = -2.8, x1 = 2.9, cy = 0.66;
    s.moveTo(x0, cy - r);
    s.lineTo(x1, cy - r);
    s.absarc(x1, cy, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(x0, cy + r);
    s.absarc(x0, cy, r, Math.PI / 2, Math.PI * 1.5, false);
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.62, bevelEnabled: false, curveSegments: 14 });
    g.translate(0, 0, -0.31);
    return g;
  };
  for (const s of [-1, 1]) {
    const side = s > 0 ? 'L' : 'R';
    add(trackLoop(), TRACK, `track${side}`, 0, 0, s * 1.45);
    // Road wheels on the outside face.
    const wheelZ = s * 1.84;
    const xs = [-2.15, -1.25, -0.35, 0.55, 1.45, 2.3];
    xs.forEach((x, i) => {
      const w = add(new THREE.CylinderGeometry(0.4, 0.4, 0.2, 20), WHEEL, `wheel${side}${i}`, x, 0.52, wheelZ);
      w.rotation.x = Math.PI / 2;
      const hub = add(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 12), METAL, `hub${side}${i}`, x, 0.52, wheelZ + s * 0.1);
      hub.rotation.x = Math.PI / 2;
    });
    // Return rollers on the upper run.
    for (const x of [-1.7, 0.1, 1.9]) {
      const rr = add(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 10), METAL, `roller${side}${x}`, x, 1.2, wheelZ - s * 0.12);
      rr.rotation.x = Math.PI / 2;
    }
    // Drive sprocket (rear) and idler (front), raised.
    for (const [x, y, nm] of [[-2.8, 0.7, 'sprocket'], [2.9, 0.78, 'idler']]) {
      const w = add(new THREE.CylinderGeometry(0.34, 0.34, 0.2, 16), METAL, `${nm}${side}`, x, y, wheelZ - s * 0.02);
      w.rotation.x = Math.PI / 2;
    }
  }

  // ---- Rear engine deck detail and exhausts.
  add(new RoundedBoxGeometry(1.5, 0.12, 1.7, 2, 0.04), OLIVE_DARK, 'engineDeck', -2.15, 1.5, 0);
  for (const z of [-0.6, 0.6]) {
    const ex = add(new THREE.CylinderGeometry(0.11, 0.11, 0.35, 10), METAL, `exhaust${z > 0 ? 'L' : 'R'}`, -3.15, 1.25, z);
    ex.rotation.z = Math.PI / 2;
  }
  // Headlights on the glacis.
  for (const z of [-0.85, 0.85]) {
    add(new RoundedBoxGeometry(0.16, 0.14, 0.2, 2, 0.04), TAN, `light${z > 0 ? 'L' : 'R'}`, 2.85, 1.38, z);
  }

  // ---- Turret: hexagonal plan, extruded upward with a sloped top via scale.
  const turret = new THREE.Group();
  turret.position.set(-0.15, 1.45, 0);
  tank.add(turret);
  const plan = new THREE.Shape([
    [1.5, 0.4], [0.85, 1.0], [-1.25, 1.0], [-1.6, 0.65], [-1.6, -0.65], [-1.25, -1.0], [0.85, -1.0], [1.5, -0.4],
  ].map(([x, z]) => new THREE.Vector2(x, z)));
  const tg = new THREE.ExtrudeGeometry(plan, {
    depth: 0.55, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 2, curveSegments: 4,
  });
  tg.rotateX(-Math.PI / 2); // shape XY -> XZ plane, extrude along +Y
  // rotateX(-90deg) maps shape y to -z; fine since plan is symmetric.
  tg.translate(0, 0.18, 0);
  add(tg, OLIVE, 'turret', 0, 0, 0, turret);
  // Rear bustle storage box.
  add(new RoundedBoxGeometry(0.6, 0.45, 1.9, 2, 0.06), OLIVE_DARK, 'bustle', -1.95, 0.5, 0, turret);
  // Mantlet.
  add(new RoundedBoxGeometry(0.45, 0.6, 0.9, 3, 0.12), OLIVE_DARK, 'mantlet', 1.7, 0.52, 0, turret);
  // Gun barrel with bore evacuator and muzzle brake.
  const barrel = add(new THREE.CylinderGeometry(0.12, 0.14, 3.4, 14), OLIVE_DARK, 'barrel', 3.5, 0.52, 0, turret);
  barrel.rotation.z = Math.PI / 2;
  const evac = add(new THREE.CylinderGeometry(0.17, 0.17, 0.45, 14), OLIVE_DARK, 'evacuator', 3.1, 0.52, 0, turret);
  evac.rotation.z = Math.PI / 2;
  const muzzle = add(new THREE.CylinderGeometry(0.17, 0.17, 0.3, 14), METAL, 'muzzle', 5.25, 0.52, 0, turret);
  muzzle.rotation.z = Math.PI / 2;
  // Commander cupola with hatch.
  add(new THREE.CylinderGeometry(0.42, 0.46, 0.26, 18), METAL, 'cupola', -0.55, 1.0, 0.45, turret);
  add(new THREE.CylinderGeometry(0.36, 0.36, 0.1, 18), TAN, 'hatch', -0.55, 1.17, 0.45, turret);
  // Loader hatch (flat) and periscope block.
  add(new RoundedBoxGeometry(0.55, 0.08, 0.5, 2, 0.03), OLIVE_DARK, 'loaderHatch', -0.4, 0.95, -0.5, turret);
  add(new RoundedBoxGeometry(0.2, 0.18, 0.3, 2, 0.04), METAL, 'periscope', 0.45, 0.98, 0.5, turret);
  // Roof machine gun.
  const mg = add(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 8), METAL, 'mg', -0.15, 1.3, 0.45, turret);
  mg.rotation.z = Math.PI / 2;
  add(new RoundedBoxGeometry(0.3, 0.14, 0.14, 2, 0.03), METAL, 'mgBody', -0.45, 1.3, 0.45, turret);
  // Antenna.
  add(new THREE.CylinderGeometry(0.025, 0.035, 1.6, 6), METAL, 'antenna', -1.4, 1.6, -0.75, turret);
  // Smoke dischargers.
  for (const s of [-1, 1]) {
    const d = add(new RoundedBoxGeometry(0.35, 0.18, 0.28, 2, 0.04), OLIVE_DARK, `smoke${s > 0 ? 'L' : 'R'}`, 1.0, 0.7, s * 1.2, turret);
    d.rotation.y = s * 0.4;
  }

  return tank;
};
