'use strict';
/* Finished meshes from anywhere (image-to-3D generators such as TRELLIS.2, photogrammetry, asset stores, other DCC tools)
   as a modelling front end. A .glb or .gltf is read node by node with its transforms; every triangle primitive becomes a
   part:

     textured or vertex-coloured   the colour at each vertex (base colour factor x texture x COLOR_0) goes in as vertex
                                   colours, and the automatic mesh look clusters them into `hues` colour families
     plain material                one palette role per material, named after it, as the other mesh engines do

   A vertex colour can only hold what the texture shows at that vertex, so textured triangles are first split until no
   edge is longer than about 1.5 art pixels of the finished sprite (`objectPixels` across the model): a twelve-triangle crate
   keeps its painted planks, and a dense generated mesh is left almost as it is. Each vertex then takes the texture
   averaged over its triangles and over half an art pixel around it, so detail finer than a pixel (a 4K map on a dense
   generated mesh) does not come back as speckle. Textures must be PNG (trellis2mlx, trimesh
   and Blender write PNG by default); compressed meshes (Draco, meshopt) and other image formats are refused with a hint.
   colourSpace "linear" reads textures that hold linear values (trellis2mlx output); yaw turns the model about Y, and yaw
   "auto" with a reference picture (the one an image-to-3D generator was given) picks the turn whose silhouette, seen
   from the generated camera, matches the picture best. */
const fs = require('node:fs');
const path = require('node:path');

const COMPONENTS = {
  5120: ['getInt8', 1, 127], 5121: ['getUint8', 1, 255], 5122: ['getInt16', 2, 32767],
  5123: ['getUint16', 2, 65535], 5125: ['getUint32', 4, 0], 5126: ['getFloat32', 4, 0]
};
const LANES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const MAX_TRIANGLES = 2e6;

function documentOf(file) {
  const { readGlb, embed } = require('./glb-file.js');
  const bytes = fs.readFileSync(file);
  let { gltf, bin } = file.toLowerCase().endsWith('.glb') ? readGlb(bytes) : { gltf: JSON.parse(bytes.toString('utf8')), bin: Buffer.alloc(0) };
  if (gltf.buffers?.some(buffer => buffer.uri !== undefined) || gltf.images?.some(image => image.uri !== undefined)) {
    /* companion files stay next to the model: a .gltf must not pull in files from elsewhere */
    const dir = path.dirname(path.resolve(file));
    for (const item of [...(gltf.buffers ?? []), ...(gltf.images ?? [])]) {
      if (typeof item.uri !== 'string' || item.uri.startsWith('data:')) continue;
      const target = path.resolve(dir, decodeURIComponent(item.uri));
      if (path.relative(dir, target).startsWith('..') || path.isAbsolute(path.relative(dir, target)))
        throw new Error('The glTF refers to a file outside its folder: ' + item.uri);
    }
    ({ gltf, bin } = readGlb(embed(gltf, file, bin)));
  }
  if (gltf.asset?.version !== '2.0') throw new Error('Expected a glTF 2.0 file');
  const unsupported = (gltf.extensionsRequired ?? []).filter(name => name !== 'KHR_texture_transform' && name !== 'KHR_materials_emissive_strength');
  if (unsupported.length)
    throw new Error('The model needs ' + unsupported.join(', ') + ', which this reader does not decode: export it again without mesh compression and with PNG textures');
  return { gltf, bin, view: new DataView(bin.buffer, bin.byteOffset, bin.byteLength) };
}

/* an accessor as plain numbers, normalised integers turned into 0..1 (or -1..1) as glTF defines */
function accessor(doc, index, what) {
  const item = doc.gltf.accessors?.[index];
  if (!item) throw new Error(what + ' has no accessor ' + index);
  if (item.sparse) throw new Error(what + ' uses a sparse accessor, which this reader does not decode');
  const [get, size, max] = COMPONENTS[item.componentType] ?? [], lanes = LANES[item.type];
  if (!get || !lanes) throw new Error(what + ' has an unknown accessor layout');
  const out = new Float64Array(item.count * lanes);
  if (item.bufferView === undefined) return { data: out, lanes };
  const view = doc.gltf.bufferViews?.[item.bufferView];
  if (!view) throw new Error(what + ' has no buffer view');
  const stride = view.byteStride || lanes * size, base = (view.byteOffset ?? 0) + (item.byteOffset ?? 0);
  if (item.count && base + stride * (item.count - 1) + lanes * size > doc.bin.length) throw new Error(what + ' reaches past the end of the buffer');
  const scale = item.normalized && max ? 1 / max : 1;
  for (let i = 0; i < item.count; i++)
    for (let k = 0; k < lanes; k++) {
      const v = doc.view[get](base + i * stride + k * size, true) * scale;
      out[i * lanes + k] = scale !== 1 ? Math.max(-1, v) : v;
    }
  return { data: out, lanes };
}

/* --- node transforms (column-major 4x4) -------------------------------------------------------------------------------- */

function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [x, y, z] = node.translation ?? [0, 0, 0], [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    x, y, z, 1
  ];
}
const multiply = (a, b) => Array.from({ length: 16 }, (_, i) => {
  const c = Math.floor(i / 4), r = i % 4;
  return a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
});
const determinant = m => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);

/* every mesh node of the default scene with its world matrix */
function meshNodes(gltf, root = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) {
  const found = [], scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes ?? (gltf.nodes ?? []).map((_, i) => i);
  const visit = (index, parent, depth) => {
    const node = gltf.nodes?.[index];
    if (!node || depth > 64) return;
    const matrix = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) found.push({ node, matrix });
    for (const child of node.children ?? []) visit(child, matrix, depth + 1);
  };
  for (const index of roots) visit(index, root, 0);
  return found;
}

/* --- textures ----------------------------------------------------------------------------------------------------------- */

/* texel byte to linear light: glTF base colour textures are sRGB, but some generators store linear values in them
   (trellis2mlx writes TRELLIS.2's linear albedo straight into the PNG), which reads far too dark as sRGB */
const DECODE = {
  srgb: Array.from({ length: 256 }, (_, i) => {
    const q = i / 255;
    return q <= 0.04045 ? q / 12.92 : ((q + 0.055) / 1.055) ** 2.4;
  }),
  linear: Array.from({ length: 256 }, (_, i) => i / 255)
};
const WRAP = { 33071: 'clamp', 33648: 'mirror', 10497: 'repeat' };
const wrap = (v, mode) => {
  if (mode === 'clamp') return Math.min(1, Math.max(0, v));
  if (mode === 'mirror') {
    const t = ((v % 2) + 2) % 2;
    return t > 1 ? 2 - t : t;
  }
  return v - Math.floor(v);
};

function imageOf(doc, cache, index) {
  if (cache.has(index)) return cache.get(index);
  const image = doc.gltf.images?.[index], view = doc.gltf.bufferViews?.[image?.bufferView];
  if (!image || !view) throw new Error('Texture image ' + index + ' is missing');
  const bytes = doc.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const isPng = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
  if (!isPng)
    throw new Error('Texture image ' + index + ' is ' + (image.mimeType || 'not a PNG') + ': only PNG textures are read; export the model again with PNG textures');
  const { w, h, data, max } = require('./png.js').raster(Buffer.from(bytes));
  /* 8-bit sRGB RGB, so the lookup table turns texels into linear light */
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3)
    for (let k = 0; k < 3; k++) rgb[j + k] = max === 255 ? data[i + k] : Math.round((data[i + k] * 255) / max);
  const decoded = { w, h, rgb };
  cache.set(index, decoded);
  return decoded;
}

/* the texture's linear colour at uv, bilinear, the way a renderer with linear filtering would show it */
function sample(image, u, v, wrapS, wrapT, out, toLinear = DECODE.srgb) {
  const x = wrap(u, wrapS) * image.w - 0.5, y = wrap(v, wrapT) * image.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const px = c => (wrapS === 'repeat' ? ((c % image.w) + image.w) % image.w : Math.min(image.w - 1, Math.max(0, c)));
  const py = c => (wrapT === 'repeat' ? ((c % image.h) + image.h) % image.h : Math.min(image.h - 1, Math.max(0, c)));
  const xs = [px(x0), px(x0 + 1)], ys = [py(y0), py(y0 + 1)];
  for (let k = 0; k < 3; k++) {
    const at = (xi, yi) => toLinear[image.rgb[(ys[yi] * image.w + xs[xi]) * 3 + k]];
    out[k] = (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
  }
  return out;
}

/* KHR_texture_transform: uv' = translate * rotate * scale * uv */
function transformOf(info) {
  const t = info?.extensions?.KHR_texture_transform;
  if (!t) return null;
  const [ox, oy] = t.offset ?? [0, 0], [sx, sy] = t.scale ?? [1, 1], r = t.rotation ?? 0, c = Math.cos(r), s = Math.sin(r);
  return { texCoord: t.texCoord, apply: (u, v) => [c * sx * u + s * sy * v + ox, -s * sx * u + c * sy * v + oy] };
}

/* --- refinement -------------------------------------------------------------------------------------------------------- */

/* splits every edge longer than `limit`, a pass at a time, with the usual one-, two- and three-edge patterns. Edges are
   judged by length alone, so the two sides of a UV seam (same positions, different vertices) split alike and the surface
   stays closed once welded. Vertex attributes ({ data, lanes }: uv, colours) are carried to the midpoints. */
function refine(pos, index, limit, maxTriangles, attributes = []) {
  const P = Array.from(pos), A = attributes.map(({ data }) => Array.from(data));
  let tris = Array.from(index), capped = false;
  const limit2 = limit * limit;
  const long = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2 > limit2;
  for (let pass = 0; pass < 24; pass++) {
    const mids = new Map(), next = [];
    const mid = (a, b) => {
      const key = a < b ? a + ',' + b : b + ',' + a;
      let at = mids.get(key);
      if (at === undefined) {
        at = P.length / 3;
        P.push((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2);
        attributes.forEach(({ lanes }, j) => {
          for (let k = 0; k < lanes; k++) A[j].push((A[j][a * lanes + k] + A[j][b * lanes + k]) / 2);
        });
        mids.set(key, at);
      }
      return at;
    };
    let split = 0;
    for (let t = 0; t < tris.length; t += 3) {
      let [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      let marks = [long(a, b), long(b, c), long(c, a)];
      const count = marks.filter(Boolean).length;
      if (!count) {
        next.push(a, b, c);
        continue;
      }
      split++;
      /* turn the triangle (keeping its winding) so the pattern starts at edge ab */
      const turn = () => {
        [a, b, c] = [b, c, a];
        marks = [marks[1], marks[2], marks[0]];
      };
      if (count === 3) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
      } else if (count === 1) {
        while (!marks[0]) turn();
        const ab = mid(a, b);
        next.push(a, ab, c, ab, b, c);
      } else {
        while (marks[2]) turn(); /* the unmarked edge is ca: ab and bc split */
        const ab = mid(a, b), bc = mid(b, c);
        next.push(ab, b, bc, a, ab, bc, a, bc, c);
      }
    }
    tris = next;
    if (!split) break;
    if (tris.length / 3 > maxTriangles) {
      capped = true;
      break;
    }
  }
  return { pos: Float32Array.from(P), index: Uint32Array.from(tris), attributes: A.map(data => Float32Array.from(data)), capped };
}

/* --- colours per vertex ----------------------------------------------------------------------------------------------- */

/* the texture averaged over each triangle (a grid of samples, more for triangles that cover more texels), handed to its
   corners by area: a vertex gets the mean of the surface around it instead of whatever texel it happens to sit on */
function textureColours(part, fine, toLinear) {
  const [uv, tint] = fine.attributes, lanes = part.colour0?.lanes, { pos, index } = fine, { image } = part;
  const n = pos.length / 3, sum = new Float64Array(n * 3), weight = new Float64Array(n), texel = [0, 0, 0];
  const uvOf = i => (part.transform ? part.transform.apply(uv[i * 2], uv[i * 2 + 1]) : [uv[i * 2], uv[i * 2 + 1]]);
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
    const e1 = [0, 1, 2].map(k => pos[b * 3 + k] - pos[a * 3 + k]), e2 = [0, 1, 2].map(k => pos[c * 3 + k] - pos[a * 3 + k]);
    const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    if (!(area > 0)) continue;
    const [ua, ub, uc] = [uvOf(a), uvOf(b), uvOf(c)];
    const texels = (Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1])) / 2) * image.w * image.h;
    /* m x m samples spread evenly over the triangle, about one per four texels, at most 16 */
    const m = Math.max(1, Math.min(4, Math.round(Math.sqrt(texels) / 2)));
    const mean = [0, 0, 0];
    let count = 0;
    const at = (wb, wc) => {
      const wa = 1 - wb - wc;
      sample(image, wa * ua[0] + wb * ub[0] + wc * uc[0], wa * ua[1] + wb * ub[1] + wc * uc[1], part.wrapS, part.wrapT, texel, toLinear);
      for (let k = 0; k < 3; k++) mean[k] += texel[k] * (tint ? wa * tint[a * lanes + k] + wb * tint[b * lanes + k] + wc * tint[c * lanes + k] : 1);
      count++;
    };
    for (let i = 0; i < m; i++)
      for (let j = 0; i + j < m; j++) {
        at((i + 1 / 3) / m, (j + 1 / 3) / m);
        if (i + j < m - 1) at((i + 2 / 3) / m, (j + 2 / 3) / m);
      }
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) sum[v * 3 + k] += (mean[k] / count) * area;
      weight[v] += area;
    }
  }
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) colours[i * 3 + k] = weight[i] ? Math.min(1, (part.factor[k] * sum[i * 3 + k]) / weight[i]) : 0;
  return { colours, weight };
}

/* each vertex colour becomes the mean of the colours within `radius` (half an art pixel), weighted by the surface each
   vertex stands for and falling off with distance. Dense generated meshes carry texture detail far below a pixel, which
   would otherwise come back as speckle; the two sides of a UV seam meet here too. */
function smoothColours(pos, colours, weight, radius) {
  const n = pos.length / 3, cell = radius, grid = new Map(), r2 = radius * radius;
  const key = (x, y, z) => x + ',' + y + ',' + z;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 1] / cell), Math.floor(pos[i * 3 + 2] / cell));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], [cx, cy, cz] = [x, y, z].map(v => Math.floor(v / cell));
    const sum = [0, 0, 0];
    let total = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            const d2 = (pos[j * 3] - x) ** 2 + (pos[j * 3 + 1] - y) ** 2 + (pos[j * 3 + 2] - z) ** 2;
            if (d2 > r2) continue;
            const w = (weight ? weight[j] || 1e-12 : 1) * (1 - d2 / r2) + (j === i ? 1e-12 : 0);
            for (let k = 0; k < 3; k++) sum[k] += colours[j * 3 + k] * w;
            total += w;
          }
    for (let k = 0; k < 3; k++) out[i * 3 + k] = total ? sum[k] / total : colours[i * 3 + k];
  }
  return out;
}

/* --- orientation from the input picture ------------------------------------------------------------------------------- */

const MASK = 96;

/* the picture's silhouette (alpha, else everything unlike the corner colour) as a mask at most MASK cells across */
function pictureMask(file) {
  const { w, h, data, max } = require('./png.js').raster(fs.readFileSync(file));
  const at = (x, y, k) => data[(y * w + x) * 4 + k] / max;
  let alpha = false;
  for (let i = 3; i < data.length && !alpha; i += 4) alpha = data[i] < max;
  const corner = [0, 1, 2].map(k => at(0, 0, k));
  const filled = (x, y) => (alpha ? at(x, y, 3) > 0.5 : [0, 1, 2].reduce((d, k) => d + (at(x, y, k) - corner[k]) ** 2, 0) > 0.01);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (filled(x, y)) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  if (x1 < 0) throw new Error('The reference picture is empty: give it a transparent background or a plain one');
  const step = Math.max(x1 - x0 + 1, y1 - y0 + 1) / MASK, mw = Math.ceil((x1 - x0 + 1) / step), mh = Math.ceil((y1 - y0 + 1) / step);
  const cells = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) cells[y * mw + x] = filled(Math.min(w - 1, Math.floor(x0 + (x + 0.5) * step)), Math.min(h - 1, Math.floor(y0 + (y + 0.5) * step))) ? 1 : 0;
  return { w: mw, h: mh, cells };
}

/* the model turned by yaw (as partsOf turns it) seen from a camera at camYaw and pitch, orthographic, as a mask */
function modelMask(parts, yaw, camYaw, pitch) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const d = [Math.cos(pitch) * Math.sin(camYaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(camYaw)];
  /* the camera looks along -d; right is horizontal, up = d x right */
  const right = [d[2], 0, -d[0]].map(v => v / Math.hypot(d[0], d[2]));
  const up = [d[1] * right[2] - d[2] * right[1], d[2] * right[0] - d[0] * right[2], d[0] * right[1] - d[1] * right[0]];
  const projected = parts.map(({ pos }) => {
    const uv = new Float32Array((pos.length / 3) * 2);
    for (let i = 0; i < pos.length / 3; i++) {
      const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], X = c * x + s * z, Z = -s * x + c * z;
      uv[i * 2] = X * right[0] + y * right[1] + Z * right[2];
      uv[i * 2 + 1] = -(X * up[0] + y * up[1] + Z * up[2]);
    }
    return uv;
  });
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const uv of projected) for (let i = 0; i < uv.length; i += 2) for (let k = 0; k < 2; k++) (lo[k] = Math.min(lo[k], uv[i + k])), (hi[k] = Math.max(hi[k], uv[i + k]));
  const scale = (MASK - 1) / Math.max(hi[0] - lo[0], hi[1] - lo[1]), w = Math.ceil((hi[0] - lo[0]) * scale) + 1, h = Math.ceil((hi[1] - lo[1]) * scale) + 1;
  const cells = new Uint8Array(w * h);
  parts.forEach(({ index }, p) => {
    const uv = projected[p], px = i => (uv[i * 2] - lo[0]) * scale, py = i => (uv[i * 2 + 1] - lo[1]) * scale;
    for (let t = 0; t < index.length; t += 3) {
      const ax = px(index[t]), ay = py(index[t]), bx = px(index[t + 1]), by = py(index[t + 1]), cx = px(index[t + 2]), cy = py(index[t + 2]);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.floor(Math.max(ay, by, cy)));
      if (x0 === x1 && y0 === y1) {
        cells[y0 * w + x0] = 1;
        continue;
      }
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const qx = x + 0.5, qy = y + 0.5;
          const w0 = ((bx - qx) * (cy - qy) - (cx - qx) * (by - qy)) / area, w1 = ((cx - qx) * (ay - qy) - (ax - qx) * (cy - qy)) / area;
          if (w0 >= -1e-6 && w1 >= -1e-6 && w0 + w1 <= 1 + 1e-6) cells[y * w + x] = 1;
        }
    }
  });
  return { w, h, cells };
}

/* overlap of two silhouettes once both have the same area and share their centre of mass (intersection over union) */
function overlap(a, b) {
  const stats = m => {
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.cells[y * m.w + x]) (n++, (sx += x + 0.5), (sy += y + 0.5));
    return { n, cx: sx / n, cy: sy / n };
  };
  const sa = stats(a), sb = stats(b);
  if (!sa.n || !sb.n) return 0;
  const k = Math.sqrt(sb.n / sa.n);
  let both = 0;
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      if (!a.cells[y * a.w + x]) continue;
      const bx = Math.floor(sb.cx + (x + 0.5 - sa.cx) * k), by = Math.floor(sb.cy + (y + 0.5 - sa.cy) * k);
      if (bx >= 0 && by >= 0 && bx < b.w && by < b.h && b.cells[by * b.w + bx]) both++;
    }
  return both / (2 * sa.n - both);
}

/* the yaw that makes the model, seen from the generated camera (yaw 0.6), look most like the picture it was made from.
   Pitch is searched too, since the picture's camera height is unknown. Coarse 15 degree steps, then 3 degrees around
   the best. */
function orientTo(parts, reference, camYaw = 0.6) {
  const target = pictureMask(reference), pitches = [0.1, 0.3, 0.5, 0.7];
  let best = { score: -1 };
  const tryYaw = (yaw, pitch) => {
    const score = overlap(target, modelMask(parts, yaw, camYaw, pitch));
    if (score > best.score) best = { yaw, pitch, score };
  };
  for (let i = 0; i < 24; i++) for (const pitch of pitches) tryYaw((i * Math.PI) / 12, pitch);
  const coarse = best;
  for (let d = -12; d <= 12; d += 3) if (d) for (const pitch of [coarse.pitch - 0.1, coarse.pitch, coarse.pitch + 0.1]) tryYaw(coarse.yaw + (d * Math.PI) / 180, pitch);
  const yaw = Math.atan2(Math.sin(best.yaw), Math.cos(best.yaw));
  return { yaw: Math.round(yaw * 1e4) / 1e4, pitch: Math.round(best.pitch * 100) / 100, overlap: Math.round(best.score * 1000) / 1000 };
}

/* turns parts about the up axis in place, the same way partsOf's yaw does */
function turn(parts, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const { pos } of parts)
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], z = pos[i + 2];
      pos[i] = c * x + s * z;
      pos[i + 2] = -s * x + c * z;
    }
}

/* --- primitives to parts ----------------------------------------------------------------------------------------------- */

const MODES = { 4: 'triangles', 5: 'strip', 6: 'fan' };
function trianglesOf(mode, index) {
  if (mode === 4) return index;
  const out = [];
  for (let i = 2; i < index.length; i++) {
    if (mode === 5) out.push(...(i % 2 ? [index[i - 1], index[i - 2], index[i]] : [index[i - 2], index[i - 1], index[i]]));
    else out.push(index[0], index[i - 1], index[i]);
  }
  return out;
}

function partsOf(doc, { objectPixels = 84, colourSpace = 'srgb', yaw = 0 } = {}) {
  const { roleFor } = require('./model-core.js');
  const { gltf } = doc, images = new Map(), warnings = [], raw = [];
  const toLinear = DECODE[colourSpace];
  if (!toLinear) throw new Error('colourSpace is "srgb" or "linear"');
  /* yaw turns the whole model about the up axis (radians, counter-clockwise seen from above), for generators that face
     their output another way */
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const { node, matrix } of meshNodes(gltf, [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])) {
    const mesh = gltf.meshes?.[node.mesh];
    if (!mesh) continue;
    const flip = determinant(matrix) < 0;
    mesh.primitives.forEach((primitive, p) => {
      const mode = primitive.mode ?? 4;
      if (!MODES[mode]) return warnings.push((node.name || mesh.name || 'mesh ' + node.mesh) + ': points and lines are skipped');
      const what = 'Mesh "' + (mesh.name || node.mesh) + '" primitive ' + p;
      if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error(what + ' is Draco-compressed: export it again without mesh compression');
      if (primitive.attributes?.POSITION === undefined) throw new Error(what + ' has no positions');
      const local = accessor(doc, primitive.attributes.POSITION, what);
      const count = local.data.length / 3, pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const [x, y, z] = [local.data[i * 3], local.data[i * 3 + 1], local.data[i * 3 + 2]];
        for (let k = 0; k < 3; k++) pos[i * 3 + k] = matrix[k] * x + matrix[4 + k] * y + matrix[8 + k] * z + matrix[12 + k];
      }
      const order = primitive.indices !== undefined ? Array.from(accessor(doc, primitive.indices, what).data) : Array.from({ length: count }, (_, i) => i);
      let index = trianglesOf(mode, order);
      if (flip) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
      if (index.some(i => !(i >= 0 && i < count))) throw new Error(what + ' has an index outside its vertices');

      const material = gltf.materials?.[primitive.material] ?? {}, pbr = material.pbrMetallicRoughness ?? {};
      const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
      const info = pbr.baseColorTexture, transform = transformOf(info);
      const set = transform?.texCoord ?? info?.texCoord ?? 0;
      const hasTexture = info !== undefined && primitive.attributes['TEXCOORD_' + set] !== undefined;
      const colour0 = primitive.attributes.COLOR_0 !== undefined ? accessor(doc, primitive.attributes.COLOR_0, what) : null;
      const name = (node.name || mesh.name || 'mesh-' + node.mesh) + (mesh.primitives.length > 1 ? '-' + (material.name || p + 1) : '');

      if (!hasTexture && !colour0) {
        /* a plain material: one role, its colour back in sRGB */
        const srgb = factor.slice(0, 3).map(v => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
        raw.push({ name, pos, index: Uint32Array.from(index), role: roleFor(material.name, (srgb[0] << 16) | (srgb[1] << 8) | srgb[2]) });
        return;
      }

      if (hasTexture) {
        const texture = gltf.textures?.[info.index];
        if (texture?.source === undefined) throw new Error(what + ' has a base colour texture without an image (' + Object.keys(texture?.extensions ?? {}).join(', ') + ')');
        const image = imageOf(doc, images, texture.source);
        const sampler = gltf.samplers?.[texture.sampler] ?? {};
        const wrapS = WRAP[sampler.wrapS] ?? 'repeat', wrapT = WRAP[sampler.wrapT] ?? 'repeat';
        const uv = accessor(doc, primitive.attributes['TEXCOORD_' + set], what);
        /* split down to about an art pixel below, once the whole model's size is known */
        raw.push({ name, pos, index, uv, image, wrapS, wrapT, transform, factor, colour0 });
        return;
      }
      const colours = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) colours[i * 3 + k] = Math.min(1, factor[k] * colour0.data[i * colour0.lanes + k]);
      raw.push({ name, pos, index: Uint32Array.from(index), colours, role: null });
    });
  }
  if (!raw.length) throw new Error('The model has no triangle meshes');

  /* the pixel size of the finished sprite in model units: textured triangles are split down to it */
  const { partBounds } = require('./model-core.js');
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of raw) {
    const b = partBounds(part.pos);
    for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], b.lo[k])), (hi[k] = Math.max(hi[k], b.hi[k]));
  }
  /* vertices about 1.5 art pixels apart at most: finer only multiplies triangles, the bake samples between them anyway;
     colours are averaged over half a pixel around each vertex */
  const art = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / objectPixels, pixel = 1.5 * art;
  let budget = MAX_TRIANGLES;
  return {
    warnings,
    parts: raw.map(part => {
      if (!part.image) return part.colours ? { ...part, colours: smoothColours(part.pos, part.colours, null, art / 2) } : part;
      const before = part.index.length / 3;
      const fine = refine(part.pos, part.index, pixel, Math.max(before, budget), [part.uv, ...(part.colour0 ? [part.colour0] : [])]);
      budget = Math.max(0, budget - fine.index.length / 3);
      if (fine.capped) warnings.push(part.name + ': stopped splitting at ' + Math.round(fine.index.length / 3) + ' triangles; texture detail finer than that is averaged away');
      const { colours, weight } = textureColours(part, fine, toLinear);
      return { name: part.name, pos: fine.pos, index: fine.index, colours: smoothColours(fine.pos, colours, weight, art / 2), role: null, split: fine.index.length / 3 - before };
    })
  };
}

async function buildModel(file, { objectPixels, colourSpace, yaw, reference, ...options }) {
  const doc = documentOf(file);
  if (yaw === 'auto' && !reference) throw new Error('yaw "auto" needs reference: the picture the model was made from');
  const auto = yaw === 'auto';
  const { parts, warnings } = partsOf(doc, { objectPixels, colourSpace, yaw: auto ? 0 : yaw });
  let orientation;
  if (auto) {
    orientation = orientTo(parts, reference);
    turn(parts, orientation.yaw);
    if (orientation.overlap < 0.6) warnings.push('yaw "auto": the best view overlaps the reference picture only ' + Math.round(orientation.overlap * 100) + '%; check the turn');
  }
  const split = parts.reduce((sum, part) => sum + (part.split ?? 0), 0), textured = parts.filter(part => part.split !== undefined).length;
  /* generated textures are mottled: with six families every blotch gets its own, three read cleaner (measured on TRELLIS.2
     tanks: noise 0.29 at six, 0.20 at three) */
  const hues = options.hues ?? (textured ? 3 : undefined);
  const report = await require('./model-core.js').buildFromParts(parts, { ...options, hues, prefix: 'glb', warnings });
  return { ...report, glb: { generator: doc.gltf.asset?.generator, textured, splitTriangles: split, hues: hues ?? 6, ...(orientation ? { orientation } : {}) } };
}

module.exports = { buildModel, partsOf, documentOf, refine, orientTo, overlap, pictureMask, modelMask };
