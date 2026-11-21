'use strict';
/* Sprite stacking, the pixel-art technique: an object drawn as horizontal slices, bottom to top, each a small top-down
   picture. A .stack.json names the slices:

     { "slices": "tank-slices.png", "slice": [50, 24], "cell": 0.125, "hard": true,
       "background": "#000000", "roles": { "#5b6b2e": "olive" } }

   `slices` is one sheet (slices side by side or stacked, each `slice` [width, height] pixels, read left to right, top to
   bottom, the first slice lowest) or a list of image files, bottom first. In each picture the top row is the back (-z),
   letters run along +x. Transparent pixels (or the `background` colour) are empty. Every colour stays exact: it becomes
   a letter and a palette role (named by `roles`, else by its colour), and the stack continues as a voxel model. */
const fs = require('node:fs');
const path = require('node:path');

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const hex = c => '#' + c.toString(16).padStart(6, '0');

function pixels(file) {
  const { raster } = require('./png.js');
  const { w, h, data, max } = raster(file);
  return { w, h, at: (x, y) => { const i = (y * w + x) * 4; return { rgb: (Math.round((data[i] * 255) / max) << 16) | (Math.round((data[i + 1] * 255) / max) << 8) | Math.round((data[i + 2] * 255) / max), alpha: data[i + 3] / max }; } };
}

async function buildModel(file, options) {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('The stack file is not JSON: ' + error.message);
  }
  const base = path.dirname(file);
  const background = source.background !== undefined ? parseInt(String(source.background).replace('#', ''), 16) : null;
  /* every slice as a function (x, y) -> colour or null */
  const slices = [];
  if (Array.isArray(source.slices)) {
    for (const name of source.slices) {
      const img = pixels(path.resolve(base, name));
      slices.push({ w: img.w, h: img.h, at: img.at });
    }
  } else if (typeof source.slices === 'string') {
    const img = pixels(path.resolve(base, source.slices));
    const [sw, sh] = source.slice ?? [img.w, img.h];
    if (img.w % sw || img.h % sh) throw new Error('The sheet (' + img.w + ' x ' + img.h + ') is not a whole number of ' + sw + ' x ' + sh + ' slices');
    for (let j = 0; j < img.h / sh; j++)
      for (let i = 0; i < img.w / sw; i++) slices.push({ w: sw, h: sh, at: (x, y) => img.at(i * sw + x, j * sh + y) });
  } else throw new Error('A stack needs "slices": a sheet file with "slice": [w, h], or a list of files');
  const w = Math.max(...slices.map(s => s.w)), h = Math.max(...slices.map(s => s.h));

  /* colour keys in any case: #5B6B2E and #5b6b2e are the same colour */
  const roles = Object.fromEntries(Object.entries(source.roles ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const letterOf = new Map(), colours = {};
  const layers = slices.map(slice => {
    const rows = [];
    for (let y = 0; y < h; y++) {
      let row = '';
      for (let x = 0; x < w; x++) {
        if (x >= slice.w || y >= slice.h) { row += '.'; continue; }
        const { rgb, alpha } = slice.at(x, y);
        if (alpha < 0.5 || rgb === background) { row += '.'; continue; }
        if (!letterOf.has(rgb)) {
          if (letterOf.size >= LETTERS.length) throw new Error('The slices use more than ' + LETTERS.length + ' colours; reduce the palette');
          const letter = LETTERS[letterOf.size];
          letterOf.set(rgb, letter);
          const role = roles[hex(rgb)];
          colours[letter] = role ? { colour: hex(rgb), role } : hex(rgb);
        }
        row += letterOf.get(rgb);
      }
      rows.push(row);
    }
    return rows.join('/');
  });
  if (!letterOf.size) throw new Error('Every slice is empty');
  const vox = { cell: source.cell ?? 0.1, hard: source.hard ?? true, colours, layers };
  const report = await require('./vox-model.js').buildFromSource(vox, { ...options, prefix: 'stack' });
  return { ...report, slices: slices.length };
}

module.exports = { buildModel };
