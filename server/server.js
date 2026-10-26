// Local web server: serves the app and a small JSON API for talking to SQL Server.
// It listens on 127.0.0.1 only, so it is reachable from this computer and nowhere else.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db.js');

const PORT = parseInt(process.env.PORT, 10) || 3210;
const HOST = '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const STATIC = { '/': 'index.html', '/index.html': 'index.html' };
const STATIC_DIRS = ['css', 'js'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = STATIC[pathname];
  if (!rel) {
    const clean = path.posix.normalize(decodeURIComponent(pathname)).replace(/^\/+/, '');
    if (STATIC_DIRS.includes(clean.split('/')[0]) && !clean.includes('..')) rel = clean;
  }
  const file = rel && path.join(ROOT, rel);
  if (!file || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}

// Blocks other websites (and DNS-rebinding tricks) from using this API through your browser.
function trusted(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))) return false;
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  return true;
}

const routes = {
  'GET /api/status': async () => db.status(),
  'POST /api/connect': async req => db.connect(await readJson(req)),
  'POST /api/disconnect': async () => { await db.disconnect(); return db.status(); },
  'GET /api/databases': async () => ({ databases: await db.databases() }),
  'POST /api/use-database': async req => db.useDatabase((await readJson(req)).database),
  'GET /api/schema': async () => ({ rows: await db.schemaRows() }),
  'POST /api/query': async (req, res) => {
    const body = await readJson(req);
    let cancel = null;
    // If the browser goes away (user pressed Cancel), stop the query on the server too.
    res.on('close', () => { if (!res.writableEnded && cancel) cancel(); });
    return db.runQuery(body.sql, { maxRows: body.maxRows, onCancel: fn => { cancel = fn; } });
  },
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!trusted(req)) return send(res, 403, { error: 'Forbidden.' });
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
    return serveStatic(req, res, pathname);
  }
  const handler = routes[req.method + ' ' + pathname];
  if (!handler) return send(res, 404, { error: 'Not found.' });
  try {
    send(res, 200, await handler(req, res));
  } catch (err) {
    if (res.writableEnded || res.destroyed) return;
    const status = err.status || 400;
    const out = { error: err.message || String(err) };
    // SQL Server errors carry a line number and error number, like the SSMS Messages tab.
    const orig = err.originalError && (err.originalError.info || err.originalError);
    if (err.number || (orig && orig.number)) out.number = err.number || orig.number;
    if (err.lineNumber || (orig && orig.lineNumber)) out.line = err.lineNumber || orig.lineNumber;
    if (status >= 500) console.error(err);
    send(res, status, out);
  }
});

function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`SQL Query Builder is running at http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop.');
    if (process.argv.includes('--open')) openBrowser(`http://localhost:${PORT}`);
  });
  const stop = () => db.disconnect().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { server, PORT };
