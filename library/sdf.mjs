// Signed distance functions in the style of Inigo Quilez, for model_build engine "sdf" (.sdf.mjs). A script gets them as
// `sdf` and returns parts whose `field` is a function of a point [x, y, z] (Y up), negative inside:
//
//   export default ({ sdf }) => ({ parts: [{ name: 'body', colour: '#5b6b2e', role: 'olive',
//     field: sdf.smoothUnion(0.2, sdf.sphere(1), sdf.move(sdf.box([0.5, 0.3, 0.5]), [0, 1, 0])),
//     bounds: [[-1.5, -1.2, -1.5], [1.5, 1.8, 1.5]] }] })
//
// Primitives are centred on the origin. Operations take and return fields, so they nest freely. Distances stay exact for
// the primitives and unions; smooth blends, twists, bends and noise only bound them, which meshing does not mind.

export function makeSdf() {
  const len = (x, y, z = 0) => Math.hypot(x, y, z);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mix = (a, b, t) => a + (b - a) * t;

  /* primitives */
  const sphere = r => ([x, y, z]) => len(x, y, z) - r;
  const box = ([hx, hy, hz]) => ([x, y, z]) => {
    const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
    return len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
  };
  const roundBox = (half, r) => round(box(half.map(h => Math.max(1e-4, h - r))), r);
  /* along Y, half height h */
  const cylinder = (r, h) => ([x, y, z]) => {
    const dx = len(x, z) - r, dy = Math.abs(y) - h;
    return Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0));
  };
  const capsule = (a, b, r) => ([x, y, z]) => {
    const pa = [x - a[0], y - a[1], z - a[2]], ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const h = clamp((pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2), 0, 1);
    return len(pa[0] - ba[0] * h, pa[1] - ba[1] * h, pa[2] - ba[2] * h) - r;
  };
  /* in the XZ plane */
  const torus = (R, r) => ([x, y, z]) => len(len(x, z) - R, y) - r;
  /* along Y from y = 0 (radius r1) to y = h (radius r2) */
  const roundCone = (r1, r2, h) => ([x, y, z]) => {
    const q = len(x, z), b = (r1 - r2) / h, a = Math.sqrt(Math.max(0, 1 - b * b)), k = q * -b + y * a;
    if (k < 0) return len(q, y) - r1;
    if (k > a * h) return len(q, y - h) - r2;
    return q * a + y * b - r1;
  };
  const ellipsoid = ([rx, ry, rz]) => ([x, y, z]) => {
    const k0 = len(x / rx, y / ry, z / rz), k1 = len(x / (rx * rx), y / (ry * ry), z / (rz * rz));
    return k1 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
  };
  /* the half space below a plane through `point` with normal n */
  const halfSpace = (n, point = [0, 0, 0]) => {
    const l = len(...n), u = n.map(v => v / l);
    return ([x, y, z]) => (x - point[0]) * u[0] + (y - point[1]) * u[1] + (z - point[2]) * u[2];
  };

  /* combinations */
  const union = (...fs) => p => Math.min(...fs.map(f => f(p)));
  const intersect = (...fs) => p => Math.max(...fs.map(f => f(p)));
  const subtract = (a, ...bs) => p => Math.max(a(p), ...bs.map(b => -b(p)));
  const smin = (a, b, k) => {
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
    return mix(b, a, h) - k * h * (1 - h);
  };
  const smoothUnion = (k, ...fs) => p => fs.map(f => f(p)).reduce((a, b) => smin(a, b, k));
  const smoothSubtract = (k, a, b) => p => -smin(-a(p), b(p), k);
  const smoothIntersect = (k, ...fs) => p => -fs.map(f => -f(p)).reduce((a, b) => smin(a, b, k));
  const round = (f, r) => p => f(p) - r;
  const shell = (f, t) => p => Math.abs(f(p)) - t / 2;
  const displace = (f, g) => p => f(p) + g(p);

  /* placing */
  const move = (f, [dx, dy, dz]) => ([x, y, z]) => f([x - dx, y - dy, z - dz]);
  const rotateX = (f, a) => ([x, y, z]) => f([x, Math.cos(a) * y + Math.sin(a) * z, -Math.sin(a) * y + Math.cos(a) * z]);
  const rotateY = (f, a) => ([x, y, z]) => f([Math.cos(a) * x - Math.sin(a) * z, y, Math.sin(a) * x + Math.cos(a) * z]);
  const rotateZ = (f, a) => ([x, y, z]) => f([Math.cos(a) * x + Math.sin(a) * y, -Math.sin(a) * x + Math.cos(a) * y, z]);
  const scale = (f, s) => ([x, y, z]) => f([x / s, y / s, z / s]) * s;
  const mirror = (f, axis = 'x') => ([x, y, z]) => f([axis === 'x' ? Math.abs(x) : x, axis === 'y' ? Math.abs(y) : y, axis === 'z' ? Math.abs(z) : z]);
  /* `count` copies along axis, `spacing` apart, centred */
  const repeat = (f, spacing, count, axis = 'x') => {
    const k = 'xyz'.indexOf(axis);
    return p => {
      const q = p.slice(), half = (count - 1) / 2;
      const i = clamp(Math.round(q[k] / spacing + half), 0, count - 1);
      q[k] -= (i - half) * spacing;
      return f(q);
    };
  };
  const elongate = (f, [hx, hy, hz]) => ([x, y, z]) => {
    const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
    return f([Math.max(qx, 0) * Math.sign(x), Math.max(qy, 0) * Math.sign(y), Math.max(qz, 0) * Math.sign(z)]) + Math.min(Math.max(qx, qy, qz), 0);
  };
  const twist = (f, k) => ([x, y, z]) => {
    const c = Math.cos(k * y), s = Math.sin(k * y);
    return f([c * x - s * z, y, s * x + c * z]);
  };
  const bend = (f, k) => ([x, y, z]) => {
    const c = Math.cos(k * x), s = Math.sin(k * x);
    return f([c * x - s * y, s * x + c * y, z]);
  };

  /* value noise in [-1, 1] and its fractal sum, for rough surfaces with displace */
  const hash = (x, y, z) => {
    const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  const noise = ([x, y, z]) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
    const u = t => t * t * (3 - 2 * t), ux = u(fx), uy = u(fy), uz = u(fz);
    const n = (a, b, c) => hash(ix + a, iy + b, iz + c);
    const v = mix(
      mix(mix(n(0, 0, 0), n(1, 0, 0), ux), mix(n(0, 1, 0), n(1, 1, 0), ux), uy),
      mix(mix(n(0, 0, 1), n(1, 0, 1), ux), mix(n(0, 1, 1), n(1, 1, 1), ux), uy), uz);
    return v * 2 - 1;
  };
  const fbm = (p, octaves = 4) => {
    let sum = 0, amp = 0.5, f = 1;
    for (let i = 0; i < octaves; i++) (sum += amp * noise([p[0] * f, p[1] * f, p[2] * f])), (amp *= 0.5), (f *= 2);
    return sum;
  };

  return {
    sphere, box, roundBox, cylinder, capsule, torus, roundCone, ellipsoid, halfSpace,
    union, intersect, subtract, smoothUnion, smoothSubtract, smoothIntersect, round, shell, displace,
    move, rotateX, rotateY, rotateZ, scale, mirror, repeat, elongate, twist, bend, noise, fbm
  };
}
