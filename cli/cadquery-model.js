'use strict';
/* CadQuery (and build123d) as a modelling front end. cadquery_runner.py runs the Python script in a venv, tessellates
   every shape and writes triangles with names, colours and roles; model-core.js turns them into GLBs and a diorama.
   Python is found as $INK_PYTHON, else .venv/bin/python under the given roots (the project, then ink-studio), else
   python3. See requirements-modelling.txt for the venv. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PACKAGE = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'cadquery_runner.py');

function pythonFor(roots) {
  if (process.env.INK_PYTHON) return process.env.INK_PYTHON;
  for (const root of [...roots, PACKAGE]) {
    const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (fs.existsSync(venv)) return venv;
  }
  return 'python3';
}

const run = (file, args, timeout) => new Promise((resolve, reject) =>
  execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout))));

/* the last useful line Python printed: the exception, or a SystemExit message */
const pythonError = stderr => String(stderr || '').trim().split('\n').filter(Boolean).pop() || 'the script failed';

async function buildModel(script, { roots = [], tolerance, timeout = 180000, ...options }) {
  const python = pythonFor(roots);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-cadquery-')), json = path.join(tmp, 'parts.json');
  let data;
  try {
    await run(python, [RUNNER, script, json, ...(tolerance ? [String(tolerance)] : [])], timeout);
    data = JSON.parse(fs.readFileSync(json, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('No Python at ' + python), { code: 'PYTHON_MISSING' });
    if (/No module named 'cadquery'/.test(error.stderr)) throw Object.assign(new Error('cadquery is not installed for ' + python), { code: 'CADQUERY_MISSING' });
    if (error.killed) throw Object.assign(new Error('The script ran longer than ' + timeout / 1000 + ' s'), { code: 'TIMEOUT' });
    const line = String(error.stderr || '').split('\n').reverse().find(text => text.includes('File "' + script + '"'));
    throw Object.assign(new Error(pythonError(error.stderr)), { where: line?.trim() });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { roleFor } = require('./model-core.js');
  const parts = data.parts.map(part => ({
    name: part.name || '',
    pos: Float32Array.from(part.pos),
    index: Uint32Array.from(part.index),
    role: roleFor(part.role, part.colour ?? 0xb4b4b4)
  }));
  if (!parts.length) throw new Error('The script made no shapes with triangles');
  const report = await require('./model-core.js').buildFromParts(parts, { ...options, prefix: 'cadquery', warnings: data.warnings ?? [] });
  return { ...report, cadquery: data.cadquery };
}

module.exports = { buildModel, pythonFor };
