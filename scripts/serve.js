'use strict';
/* Serves the repository read-only on 127.0.0.1, so browser pages (tools/raw-viewer.html, demos) can import three from
   node_modules and load studio/out files, plus the live tuner API (/api/*, see tune-api.js). No dependencies.
     npm run serve                 http://127.0.0.1:8765/
     node scripts/serve.js 9000    another port (or PORT=9000) */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain', '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8'
};

/* the live tuner's API (scripts/tune-api.js) runs in a pool of worker threads, started on first use so plain serving stays
   fast. Each scene always goes to the same worker, so its baked variants stay cached there while other scenes bake in
   parallel. TUNE_WORKERS sets the pool size. */
const { Worker } = require('node:worker_threads');
const WORKERS = Math.max(1, Number(process.env.TUNE_WORKERS) || Math.min(12, require('node:os').cpus().length - 2));
let pool = null, nextId = 0;
const pending = new Map();
function startPool() {
  pool = Array.from({ length: WORKERS }, () => {
    const worker = new Worker(path.join(__dirname, 'tune-worker.js'), { workerData: { budget: 4e6 } });
    worker.on('message', ({ id, result, error, status }) => {
      const job = pending.get(id);
      pending.delete(id);
      if (job) error ? job.reject(Object.assign(new Error(error), { status })) : job.resolve(result);
    });
    return worker;
  });
}
const workerFor = scene => {
  let h = 0;
  for (const ch of String(scene)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
};
function runInPool(op, input) {
  if (!pool) startPool();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    workerFor(input.scene ?? '').postMessage({ id, op, input });
  });
}
const json = (response, status, value) => response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));

function api(request, response, pathname) {
  /* only this page may call it: JSON bodies (which other sites cannot send without a CORS preflight) from this origin */
  const origin = request.headers.origin;
  if (origin && origin !== 'http://127.0.0.1:' + PORT && origin !== 'http://localhost:' + PORT) return json(response, 403, { error: 'other origins may not call the API' });
  if (request.method === 'GET' && pathname === '/api/info') return json(response, 200, { workers: WORKERS });
  if (request.method === 'GET' && pathname === '/api/scenes')
    return runInPool('scenes', {}).then(list => json(response, 200, list), error => json(response, 500, { error: error.message }));
  if (request.method !== 'POST' || !['/api/tune', '/api/save'].includes(pathname)) return json(response, 404, { error: 'no such API' });
  if (!String(request.headers['content-type']).startsWith('application/json')) return json(response, 415, { error: 'send JSON' });
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 1e6) request.destroy();
  });
  request.on('end', () => {
    let input;
    try {
      input = JSON.parse(body || '{}');
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
    runInPool(pathname === '/api/tune' ? 'tune' : 'save', input).then(
      result => json(response, 200, result),
      error => json(response, error.status ?? 400, { error: error.message })
    );
  });
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://local').pathname;
  if (pathname.startsWith('/api/')) return api(request, response, pathname);
  if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405).end();
  let file = path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://local').pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return response.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(file).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/  (tuner: /tools/tune.html, comparison: /tools/compare.html)`));
