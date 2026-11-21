// Reusable, tested parts for three.js models (model_build engine "three"). A script gets them as `parts`:
//
//   export default ({ THREE, parts }) => { const wheel = parts.roadWheel({ radius: 0.31 }, material); ... }
//
// Every function returns a closed THREE.Mesh or Group in metres, Y up, centred as documented, named, with the given
// material. tests/parts-library.test.js builds each one and checks it is closed. Small details are kept large enough to
// survive at sprite size.

export function makeParts(THREE, { RoundedBoxGeometry } = {}) {
  const named = (object, name) => ((object.name = name), object);

  /* a box with rounded edges, centred on the origin */
  function roundedBox({ length = 1, width = 1, height = 1, radius = 0.05 } = {}, material, name = 'box') {
    const geometry = RoundedBoxGeometry
      ? new RoundedBoxGeometry(length, height, width, 3, Math.min(radius, 0.45 * Math.min(length, width, height)))
      : new THREE.BoxGeometry(length, height, width);
    return named(new THREE.Mesh(geometry, material), name);
  }

  /* a wheel facing Z with a raised hub, centred on the origin */
  function roadWheel({ radius = 0.31, width = 0.1, hub = 0.35, segments = 24 } = {}, material, name = 'wheel') {
    const group = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, segments), material);
    disc.rotation.x = Math.PI / 2;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * hub, radius * hub, width + 0.06, segments), material);
    cap.rotation.x = Math.PI / 2;
    disc.name = name;
    cap.name = name + '-hub';
    group.add(disc, cap);
    return named(group, name);
  }

  /* a tank track as a stadium loop along X, facing Z, its bottom at y = 0 */
  function trackLoop({ length = 5.15, height = 0.92, width = 0.54, segments = 12 } = {}, material, name = 'track') {
    const r = height / 2, straight = length / 2 - r, shape = new THREE.Shape();
    shape.moveTo(-straight, -r);
    shape.lineTo(straight, -r);
    shape.absarc(straight, 0, r, -Math.PI / 2, Math.PI / 2, false);
    shape.lineTo(-straight, r);
    shape.absarc(-straight, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: segments });
    geometry.translate(0, r, -width / 2);
    return named(new THREE.Mesh(geometry, material), name);
  }

  /* a gun barrel along +X from the origin, with a sleeve at the base and a muzzle brake at the end */
  function barrel({ length = 2.5, radius = 0.085, brake = true, sleeve = true, segments = 20 } = {}, material, name = 'barrel') {
    const group = new THREE.Group();
    const tube = (r, l, x) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, l, segments), material);
      mesh.rotation.z = -Math.PI / 2;
      mesh.position.x = x + l / 2;
      return mesh;
    };
    group.add(named(tube(radius, length, 0), name));
    if (sleeve) group.add(named(tube(radius * 1.45, length * 0.18, 0), name + '-sleeve'));
    if (brake) group.add(named(tube(radius * 1.55, length * 0.13, length * 0.92), name + '-brake'));
    return named(group, name);
  }

  /* a round hatch on a ring, its bottom at y = 0 */
  function hatch({ radius = 0.25, thickness = 0.06, ring = 0.05, segments = 20 } = {}, material, name = 'hatch') {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(radius + ring, radius + ring, thickness, segments), material);
    base.position.y = thickness / 2;
    /* a closed dome: a lathe profile from the axis out to the rim and back over the top to the axis */
    const profile = [new THREE.Vector2(0, 0), new THREE.Vector2(radius, 0)];
    for (let i = 1; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      profile.push(new THREE.Vector2(radius * Math.cos(a), radius * 0.35 * Math.sin(a)));
    }
    const lid = new THREE.Mesh(new THREE.LatheGeometry(profile, segments), material);
    lid.position.y = thickness;
    base.name = name + '-ring';
    lid.name = name;
    group.add(base, lid);
    return named(group, name);
  }

  /* a wooden crate: a body with raised frame rails on every edge, its bottom at y = 0 */
  function crate({ length = 1, width = 1, height = 1, frame = 0.08 } = {}, material, name = 'crate') {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(length - frame, height - frame, width - frame), material);
    body.position.y = height / 2;
    body.name = name;
    group.add(body);
    const rail = (l, h, w, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(l, h, w), material);
      mesh.position.set(x, y, z);
      mesh.name = name + '-rail';
      group.add(mesh);
    };
    for (const sy of [frame / 2, height - frame / 2]) for (const sz of [-1, 1]) rail(length, frame, frame, 0, sy, (sz * (width - frame)) / 2);
    for (const sy of [frame / 2, height - frame / 2]) for (const sx of [-1, 1]) rail(frame, frame, width, (sx * (length - frame)) / 2, sy, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) rail(frame, height, frame, (sx * (length - frame)) / 2, height / 2, (sz * (width - frame)) / 2);
    return named(group, name);
  }

  /* a door or window panel facing +Z: a frame around an inset centre, its bottom at y = 0 */
  function panel({ width = 0.9, height = 1.2, depth = 0.08, frame = 0.07, inset = 0.025 } = {}, material, name = 'panel') {
    const group = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(width - 2 * frame, height - 2 * frame, depth - inset), material);
    back.position.set(0, height / 2, -inset / 2);
    back.name = name;
    group.add(back);
    const bar = (w, h, x, y) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth), material);
      mesh.position.set(x, y, 0);
      mesh.name = name + '-frame';
      group.add(mesh);
    };
    bar(width, frame, 0, frame / 2);
    bar(width, frame, 0, height - frame / 2);
    bar(frame, height - 2 * frame, -(width - frame) / 2, height / 2);
    bar(frame, height - 2 * frame, (width - frame) / 2, height / 2);
    return named(group, name);
  }

  return { roundedBox, roadWheel, trackLoop, barrel, hatch, crate, panel };
}
