'use strict';
/* OpenSCAD as a modelling front end. A .scad file either draws one model (one grey part), or names its parts:

     PARTS = [["hull", "#5b6b2e", "olive"], ["track", "#2b2b2b"]];       name, colour, optional role
     module part(name) { if (name == "hull") hull_shape(); ... }
     if (is_undef(INK)) for (p = PARTS) color(p[1]) part(p[0]);          optional: what the OpenSCAD window shows

   Each part is rendered on its own (`part("hull");`) to binary STL and goes through model-core.js. INK is defined while
   rendering, so the preview line at the end stays out of the parts. OpenSCAD is Z up; the model is turned so Z becomes
   Y. OpenSCAD is found as $INK_OPENSCAD, `openscad` on the PATH, or the macOS application. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const APPS = ['/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD'];

function openscadBinary() {
  if (process.env.INK_OPENSCAD) return process.env.INK_OPENSCAD;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['openscad'], { encoding: 'utf8' }).split('\n')[0].trim();
    if (found) return found;
  } catch {
    /* not on the PATH */
  }
  return APPS.find(app => fs.existsSync(app)) ?? 'openscad';
}

const run = (file, args, timeout) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));

/* binary STL: 80 byte header, triangle count, then normal, three corners and two attribute bytes per triangle */
function readStl(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 5).toString() === 'solid' && bytes.includes('facet')) {
    const numbers = [...bytes.toString().matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap(m => [+m[1], +m[2], +m[3]]);
    return Float32Array.from(numbers);
  }
  const count = bytes.readUInt32LE(80), pos = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) for (let k = 0; k < 9; k++) pos[t * 9 + k] = bytes.readFloatLE(84 + t * 50 + 12 + k * 4);
  return pos;
}

/* Z up to Y up: (x, y, z) -> (x, z, -y) */
function yUp(pos) {
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) (out[i] = pos[i]), (out[i + 1] = pos[i + 2]), (out[i + 2] = -pos[i + 1]);
  return out;
}

function scadError(error, script) {
  const text = String(error.stderr || '') + String(error.stdout || '') + String(error.output || '');
  const line = text.split('\n').find(l => /^(ERROR|WARNING: Ignoring unknown)/.test(l)) ?? text.split('\n').filter(Boolean).pop() ?? 'OpenSCAD failed';
  const at = text.match(/in file (.*?), line (\d+)/);
  return Object.assign(new Error(line.replace(/ in file .*?, line \d+/, '').trim()), { where: at ? path.basename(at[1]) + ', line ' + at[2] : undefined });
}

async function buildModel(script, { timeout = 300000, ...options }) {
  const binary = openscadBinary();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-openscad-'));
  const include = 'include <' + script.split(path.sep).join('/') + '>\n';
  const render = async (body, out, format) => {
    const wrapper = path.join(tmp, 'wrap-' + path.basename(out) + '.scad');
    fs.writeFileSync(wrapper, include + body);
    try {
      await run(binary, ['-D', 'INK=1', ...(format ? ['--export-format', format] : []), '-o', out, wrapper], timeout);
    } catch (error) {
      /* an echo export writes its errors into the output file, not to stderr */
      if (fs.existsSync(out)) error.output = fs.readFileSync(out, 'utf8').slice(0, 4000);
      throw error;
    }
  };
  try {
    let list = null;
    try {
      const echo = path.join(tmp, 'parts.echo');
      await render('echo(INK_PARTS = is_undef(PARTS) ? undef : PARTS);\n', echo);
      const text = fs.readFileSync(echo, 'utf8').match(/INK_PARTS = (.*)/)?.[1];
      if (text && text.trim() !== 'undef') {
        try {
          list = JSON.parse(text.replace(/\bundef\b/g, 'null'));
        } catch {
          /* OpenSCAD echoes strings without escaping, so a quote in a part name cannot be read back */
          throw Object.assign(new Error('PARTS could not be read back (' + text.slice(0, 120) + '); keep part names to letters, digits, - and _'), { parsed: true });
        }
      }
    } catch (error) {
      if (error.parsed) throw error;
      if (error.code === 'ENOENT' && String(error.syscall).startsWith('spawn')) throw Object.assign(new Error('No OpenSCAD at ' + binary), { code: 'OPENSCAD_MISSING' });
      throw scadError(error, script);
    }
    const { roleFor, buildFromParts } = require('./model-core.js');
    const colourOf = c => (typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c) ? parseInt(c.replace('#', ''), 16) : 0xb4b4b4);
    const parts = [];
    if (list) {
      if (!Array.isArray(list) || !list.every(p => Array.isArray(p) && typeof p[0] === 'string'))
        throw new Error('PARTS must be a list of ["name", "#rrggbb", "role"] entries');
      for (const [name, colour, role] of list) {
        const stl = path.join(tmp, name.replace(/[^a-z0-9-_]/gi, '_') + '.stl');
        if (!/^[\w-]+$/.test(name)) throw new Error('Part name "' + name + '" in PARTS: use letters, digits, - and _');
        try {
          await render('part("' + name + '");\n', stl, 'binstl');
        } catch (error) {
          const failed = scadError(error, script);
          /* an empty part makes OpenSCAD exit with "top level object is empty": say which part */
          throw Object.assign(new Error('Part "' + name + '": ' + failed.message), { where: failed.where });
        }
        parts.push({ name, pos: yUp(readStl(stl)), role: roleFor(role, colourOf(colour)) });
      }
    } else {
      const stl = path.join(tmp, 'model.stl');
      try {
        await run(binary, ['-D', 'INK=1', '--export-format', 'binstl', '-o', stl, script], timeout);
      } catch (error) {
        if (error.code === 'ENOENT') throw Object.assign(new Error('No OpenSCAD at ' + binary), { code: 'OPENSCAD_MISSING' });
        throw scadError(error, script);
      }
      parts.push({ name: path.basename(script, '.scad'), pos: yUp(readStl(stl)), role: roleFor(null, 0xb4b4b4) });
    }
    const empty = parts.filter(p => !p.pos.length).map(p => p.name);
    if (empty.length) throw new Error('These parts drew nothing: ' + empty.join(', '));
    return buildFromParts(parts, { ...options, prefix: 'openscad' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { buildModel, openscadBinary, readStl };
