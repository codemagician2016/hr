#!/usr/bin/env node
const http = require('http');
const next = require('next');

const port = parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOST || process.env.NEXT_SERVER_HOST || '0.0.0.0';
const appDir = process.env.NEXT_APP_DIR || process.cwd();

const app = next({ dev: false, dir: appDir, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[next-pm2-server] request failed', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal server error');
      } else {
        res.destroy(err);
      }
    });
  });

  server.keepAliveTimeout = parseInt(process.env.NEXT_KEEP_ALIVE_TIMEOUT_MS || '65000', 10);
  server.headersTimeout = parseInt(process.env.NEXT_HEADERS_TIMEOUT_MS || '66000', 10);
  server.requestTimeout = parseInt(process.env.NEXT_REQUEST_TIMEOUT_MS || '120000', 10);
  server.on('error', (err) => {
    console.error('[next-pm2-server] listen failed', err);
    process.exit(1);
  });

  server.listen(port, hostname, () => {
    console.log(`[next-pm2-server] ${appDir} listening on ${hostname}:${port}`);
  });
}).catch((err) => {
  console.error('[next-pm2-server] boot failed', err);
  process.exit(1);
});
