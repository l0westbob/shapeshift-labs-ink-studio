'use strict';
/* Blender as a modelling front end. blender_runner.py runs the script headless in an empty scene, evaluates every object
   with its modifiers and writes triangles per object and material; model-core.js turns them into GLBs and a diorama.
   Blender is found as $INK_BLENDER, else `blender` on the PATH, else the macOS application. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const RUNNER = path.join(__dirname, 'blender_runner.py');
const APP = '/Applications/Blender.app/Contents/MacOS/Blender';

function blenderBinary() {
  if (process.env.INK_BLENDER) return process.env.INK_BLENDER;
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['blender'], { encoding: 'utf8' }).split('\n')[0].trim() || APP;
  } catch {
    return fs.existsSync(APP) ? APP : 'blender';
  }
}

const run = (file, args, timeout) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve(stdout))));

async function buildModel(script, { timeout = 300000, ...options }) {
  const blender = blenderBinary();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-blender-')), json = path.join(tmp, 'parts.json');
  let data;
  try {
    try {
      await run(blender, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', RUNNER, '--', script, json], timeout);
    } catch (error) {
      /* only a failed spawn means Blender is missing; a script that fails exits with an error instead */
      if (error.code === 'ENOENT' && String(error.syscall).startsWith('spawn')) throw Object.assign(new Error('No Blender at ' + blender), { code: 'BLENDER_MISSING' });
      if (error.killed) throw Object.assign(new Error('Blender ran longer than ' + timeout / 1000 + ' s'), { code: 'TIMEOUT' });
      /* the traceback is on stderr; what the script printed on stdout must not be taken for the error */
      const lines = String(error.stderr || '').split('\n').filter(Boolean);
      const last = lines.filter(line => /^\w+(Error|Exception|Exit)\b:?/.test(line.trim())).pop() || lines.filter(line => /Error|Exception/.test(line)).pop() || lines.pop() || 'Blender failed';
      const where = lines.reverse().find(line => line.includes('File "' + script + '"'));
      throw Object.assign(new Error(last.trim()), { where: where?.trim() });
    }
    if (!fs.existsSync(json)) throw new Error('The script ended before the model was written (did it exit early?)');
    data = JSON.parse(fs.readFileSync(json, 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { roleFor, buildFromParts } = require('./model-core.js');
  const parts = data.parts.map(part => ({
    name: part.name || '', pos: Float32Array.from(part.pos), index: Uint32Array.from(part.index),
    role: roleFor(part.role, part.colour ?? 0xb4b4b4)
  }));
  if (!parts.length) throw new Error('The script made no visible mesh objects');
  const report = await buildFromParts(parts, { ...options, prefix: 'blender', sun: data.sun, warnings: data.warnings ?? [] });
  return { ...report, blender: data.blender };
}

module.exports = { buildModel, blenderBinary };
