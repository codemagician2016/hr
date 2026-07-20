'use strict';

/**
 * static-serve.js — minimal static file server with SPA fallback (Feature 41).
 * Serves the Flutter-web build of the employee app on the m-<tenant> mobile-web
 * hosts. Zero dependencies (runs under pm2 on the shared box).
 *
 *   STATIC_DIR=/home/ubuntu/drifthr-hms/apps/mobile/build/web PORT=4215 node scripts/static-serve.js
 *
 * - Unknown paths fall back to index.html (the Flutter router owns the URL).
 * - No directory traversal (resolved paths must stay inside STATIC_DIR).
 * - Hashed/immutable Flutter assets get long cache; index.html is no-cache so a
 *   redeploy is picked up on the next load.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.STATIC_DIR || '.');
const PORT = parseInt(process.env.PORT || '4215', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.resolve(ROOT, `.${urlPath}`);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    }
    if (!stat) {
      // SPA fallback — the Flutter router owns unknown paths.
      filePath = path.join(ROOT, 'index.html');
      if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    }
    const ext = path.extname(filePath).toLowerCase();
    const isIndex = path.basename(filePath) === 'index.html';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (_e) {
    res.writeHead(500); res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`[static-serve] ${ROOT} on :${PORT}`);
});
