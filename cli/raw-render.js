'use strict';
/* A plain picture of a triangle model before anything is baked: flat-shaded triangles with a z-buffer, a sun and a little
   sky light, drawn at twice the size and averaged down so edges are smooth. It needs no GPU and no dependencies, so every
   agent can look at the raw model the same way (Claude, Codex, a shell), side by side with the baked splats.

     rawRender(parts, { w = 320, h = 240, yaws = [0.6, 2.4], pitch = 0.42, sun })   -> { w, h, rgb }
       parts: [{ pos: Float32Array xyz, index?: Uint32Array, colour: 0xrrggbb }], all in one space with Y up
       one view per yaw, laid side by side; the camera frames the whole model the same way in every view */

const BACKGROUND = [11, 13, 16];

function boundsOf(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { pos } of parts)
    for (let i = 0; i < pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], pos[i + k]);
        hi[k] = Math.max(hi[k], pos[i + k]);
      }
  return { lo, hi };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function drawView(parts, { w, h, yaw, pitch, sun, centre, radius }) {
  const W = w * 2, H = h * 2, depth = new Float32Array(W * H).fill(Infinity), rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set(BACKGROUND, i * 3);
  const fov = 0.6, dist = (radius / Math.sin(fov / 2)) * 0.78;
  const eye = [centre[0] + dist * Math.cos(pitch) * Math.sin(yaw), centre[1] + dist * Math.sin(pitch), centre[2] + dist * Math.cos(pitch) * Math.cos(yaw)];
  const forward = unit(sub(centre, eye)), right = unit(cross(forward, [0, 1, 0])), up = cross(right, forward);
  const focal = (Math.min(W, H) / 2) / Math.tan(fov / 2);
  const project = p => {
    const d = sub(p, eye), z = dot(d, forward);
    return [W / 2 + (dot(d, right) * focal) / z, H / 2 - (dot(d, up) * focal) / z, z];
  };
  const light = unit(sun);
  for (const { pos, index, colour } of parts) {
    const base = [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255];
    const count = index ? index.length : pos.length / 3;
    for (let t = 0; t < count; t += 3) {
      const corner = k => {
        const v = (index ? index[t + k] : t + k) * 3;
        return [pos[v], pos[v + 1], pos[v + 2]];
      };
      const a = corner(0), b = corner(1), c = corner(2);
      let normal = unit(cross(sub(b, a), sub(c, a)));
      /* faces seen from behind (open or inverted meshes) are lit as if turned towards the camera */
      if (dot(normal, sub(eye, a)) < 0) normal = normal.map(x => -x);
      const shade = 0.28 + 0.12 * (0.5 + 0.5 * normal[1]) + 0.75 * Math.max(0, dot(normal, light));
      const [pa, pb, pc] = [project(a), project(b), project(c)];
      if (pa[2] <= 0 || pb[2] <= 0 || pc[2] <= 0) continue;
      const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
      const y0 = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const u = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
          const v = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
          const s = 1 - u - v;
          if (u < 0 || v < 0 || s < 0) continue;
          const z = 1 / (u / pa[2] + v / pb[2] + s / pc[2]), i = y * W + x;
          if (z >= depth[i]) continue;
          depth[i] = z;
          for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.min(255, base[k] * shade);
        }
    }
  }
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 3; k++) {
        const at = (dy, dx) => rgb[((y * 2 + dy) * W + x * 2 + dx) * 3 + k];
        out[(y * w + x) * 3 + k] = Math.round((at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1)) / 4);
      }
  return out;
}

function rawRender(parts, { w = 320, h = 240, yaws = [0.6, 2.4], pitch = 0.42, sun = [-0.45, 0.8, 0.5] } = {}) {
  const { lo, hi } = boundsOf(parts);
  const centre = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2), radius = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
  const views = yaws.map(yaw => drawView(parts, { w, h, yaw, pitch, sun, centre, radius }));
  const W = w * views.length, rgb = new Uint8Array(W * h * 3);
  views.forEach((view, n) => {
    for (let y = 0; y < h; y++) rgb.set(view.subarray(y * w * 3, (y + 1) * w * 3), (y * W + n * w) * 3);
  });
  return { w: W, h, rgb };
}

module.exports = { rawRender };
