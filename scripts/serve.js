'use strict';
/* Serves the repository read-only on 127.0.0.1, so browser pages (tools/raw-viewer.html, demos) can import three from
   node_modules and load studio/out files. No dependencies; works the same for any agent or a person.
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

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return response.writeHead(405).end();
  let file = path.join(ROOT, decodeURIComponent(new URL(request.url, 'http://local').pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return response.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  response.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  if (request.method === 'HEAD') return response.end();
  fs.createReadStream(file).pipe(response);
});

server.listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/  (raw models: /tools/raw-viewer.html)`));
