// A small tank modelled with three.js. Run it through model_three (or `ink-studio agent call model_three`) to get a
// diorama with one mesh solid per part. Units are metres; model_three can rescale with `size`.
export default ({ THREE }) => {
  const olive = new THREE.MeshStandardMaterial({ color: 0x5b6b2e, name: 'olive' });
  const darkOlive = new THREE.MeshStandardMaterial({ color: 0x3f4a22, name: 'dark-olive' });
  const track = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, name: 'track' });
  const steel = new THREE.MeshStandardMaterial({ color: 0x777b72, name: 'steel' });
  const tank = new THREE.Group();

  // hull: a side profile with sloped front and back, extruded across the width
  const profile = new THREE.Shape();
  profile.moveTo(-3.0, 0.5);
  profile.lineTo(3.0, 0.5);
  profile.lineTo(3.5, 1.1);
  profile.lineTo(2.6, 1.6);
  profile.lineTo(-2.9, 1.6);
  profile.lineTo(-3.3, 1.1);
  profile.closePath();
  const hullGeometry = new THREE.ExtrudeGeometry(profile, { depth: 2.6, bevelEnabled: false });
  hullGeometry.translate(0, 0, -1.3);
  const hull = new THREE.Mesh(hullGeometry, olive);
  hull.name = 'hull';
  tank.add(hull);

  // tracks: a rounded loop either side, with road wheels showing on the outside
  for (const side of [-1, 1]) {
    const loop = new THREE.Shape();
    loop.moveTo(-3.0, 0);
    loop.lineTo(3.0, 0);
    loop.absarc(3.0, 0.55, 0.55, -Math.PI / 2, Math.PI / 2, false);
    loop.lineTo(-3.0, 1.1);
    loop.absarc(-3.0, 0.55, 0.55, Math.PI / 2, (3 * Math.PI) / 2, false);
    const trackGeometry = new THREE.ExtrudeGeometry(loop, { depth: 0.7, bevelEnabled: false, curveSegments: 10 });
    trackGeometry.translate(0, 0, side > 0 ? 1.25 : -1.95);
    const belt = new THREE.Mesh(trackGeometry, track);
    belt.name = side > 0 ? 'track-left' : 'track-right';
    tank.add(belt);
    for (let i = 0; i < 5; i++) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 18), steel);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(-2.4 + i * 1.2, 0.5, side * 2.0);
      wheel.name = 'wheel';
      tank.add(wheel);
    }
  }

  // turret: a low eight-sided drum with a mantlet, barrel and hatch
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 0.8, 8), darkOlive);
  turret.position.set(-0.3, 2.0, 0);
  turret.rotation.y = Math.PI / 8;
  turret.name = 'turret';
  tank.add(turret);
  const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.8), darkOlive);
  mantlet.position.set(0.95, 2.0, 0);
  mantlet.name = 'mantlet';
  tank.add(mantlet);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 3.2, 14), darkOlive);
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(2.7, 2.05, 0);
  barrel.name = 'barrel';
  tank.add(barrel);
  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.38, 0.18, 14), steel);
  hatch.position.set(-0.6, 2.48, 0.35);
  hatch.name = 'hatch';
  tank.add(hatch);
  return tank;
};
