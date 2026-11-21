// A small tank as signed distance functions, for model_build (engine "sdf"). Y up, X forward, Z across, metres.
// Smooth unions soften the joints, repeat places the road wheels, halfSpace cuts the glacis and the rear.
export default ({ sdf }) => {
  const { roundBox, cylinder, capsule, smoothUnion, intersect, halfSpace, move, rotateX, rotateZ, repeat, mirror, union, ellipsoid, roundCone } = sdf;
  const along = (f) => rotateZ(f, Math.PI / 2); // a Y-axis primitive turned to lie along X
  const hull = intersect(
    roundBox([2.6, 0.42, 0.98], 0.06),
    halfSpace([0.62, 1, 0], [2.15, 0.42, 0]),       // glacis
    halfSpace([-0.8, 1, 0], [-2.45, 0.2, 0])        // rear plate
  );
  const track = mirror(move(capsule([-2.12, 0, 0], [2.12, 0, 0], 0.46), [0, 0, 1.25]), 'z');
  const trackSlab = mirror(move(roundBox([2.4, 0.46, 0.27], 0.12), [0, 0, 1.25]), 'z');
  const wheels = mirror(move(repeat(rotateX(cylinder(0.31, 0.05), Math.PI / 2), 0.75, 6, 'x'), [0, -0.03, 1.53]), 'z');
  const hubs = mirror(move(repeat(rotateX(cylinder(0.11, 0.09), Math.PI / 2), 0.75, 6, 'x'), [0, -0.03, 1.53]), 'z');
  const fenders = mirror(move(roundBox([2.55, 0.03, 0.31], 0.02), [0.05, 0.57, 1.31]), 'z');
  const turret = move(intersect(roundCone(0.95, 0.72, 0.55), move(roundBox([1.15, 0.28, 0.92], 0.1), [0, 0.28, 0])), [-0.35, 1.25, 0]);
  const gun = union(
    move(roundBox([0.17, 0.21, 0.4], 0.08), [0.7, 1.52, 0]),
    move(along(cylinder(0.085, 1.25)), [2.1, 1.52, 0]),
    move(along(cylinder(0.12, 0.22)), [1.05, 1.52, 0]),
    move(along(cylinder(0.13, 0.16)), [3.41, 1.52, 0])
  );
  const cupola = smoothUnion(0.05, move(cylinder(0.3, 0.1), [-0.7, 1.88, -0.35]), move(ellipsoid([0.22, 0.08, 0.22]), [-0.7, 1.98, -0.35]));
  const antenna = move(cylinder(0.02, 0.55), [-1.2, 2.3, 0.55]);
  const y = (lo, hi) => [[-3.8, lo, -1.9], [3.8, hi, 1.9]];
  return {
    parts: [
      { name: 'hull', colour: '#5b6b2e', role: 'olive', field: move(hull, [0, 0.83, 0]), bounds: y(0.2, 1.5) },
      { name: 'tracks', colour: '#2b2b2b', role: 'track', field: move(intersect(track, trackSlab), [0, 0.46, 0]), bounds: y(-0.1, 1.1) },
      { name: 'wheels', colour: '#777b72', role: 'steel', field: union(move(wheels, [0, 0.46, 0]), move(hubs, [0, 0.46, 0])), bounds: y(0, 0.9) },
      { name: 'fenders', colour: '#3f4a22', role: 'dark-olive', field: fenders, bounds: y(0.4, 0.75) },
      { name: 'turret', colour: '#5b6b2e', role: 'olive', field: turret, bounds: y(1.0, 2.0) },
      { name: 'gun', colour: '#3f4a22', role: 'dark-olive', field: gun, bounds: y(1.1, 1.9) },
      { name: 'cupola', colour: '#3f4a22', role: 'dark-olive', field: cupola, bounds: y(1.6, 2.2) },
      { name: 'antenna', colour: '#777b72', role: 'steel', field: antenna, bounds: [[-1.3, 1.6, 0.45], [-1.1, 3.0, 0.65]] }
    ]
  };
};
