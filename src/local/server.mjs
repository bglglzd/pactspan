import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { InputError, fields, requireValue } from '../core/data.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png' };
const CSP = "default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;connect-src 'self';object-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

function equalToken(value, token) {
  return typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
async function body(request) {
  requireValue(request.headers['content-type'] === 'application/json', 'Use application/json');
  requireValue(!request.headers['content-encoding'], 'Compressed request bodies are unsupported');
  requireValue(!request.headers['content-length'] || /^\d+$/.test(request.headers['content-length'])
    && Number(request.headers['content-length']) <= 1024 * 1024, 'Request exceeds 1 MiB');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; requireValue(size <= 1024 * 1024, 'Request exceeds 1 MiB'); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new InputError('Request must be valid UTF-8 JSON'); }
}
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data));
}

export async function startServer({ controller, staticRoot, port = 0 }) {
  requireValue(Number.isInteger(port) && port >= 0 && port <= 65535, 'Port must be in0..65535');
  const root = await realpath(staticRoot); const token = randomBytes(32).toString('hex'); let origin;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      // A fixed numeric loopback Host also rejects DNS rebinding and alternate authority spellings.
      if (request.headers.host !== new URL(origin).host) { json(response, 403, { error: 'Unrecognized local host' }); return; }
      if (request.headers.origin && request.headers.origin !== origin) { json(response, 403, { error: 'Cross-origin requests are refused' }); return; }
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.search || url.hash) { json(response, 400, { error: 'Unsupported request URL' }); return; }
      if (url.pathname.startsWith('/api/')) {
        if (!equalToken(request.headers['x-pactspan-token'], token)) { json(response, 403, { error: 'Local session token is required' }); return; }
        if (request.method === 'GET' && url.pathname === '/api/workspace') { json(response, 200, controller.snapshot()); return; }
        if (request.method === 'GET' && url.pathname === '/api/export') {
          const raw = await controller.export(); response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="pactspan-history.json"' }); response.end(raw); return;
        }
        if (request.method === 'GET' && /^\/api\/runs\/[a-zA-Z0-9_.-]+$/.test(url.pathname)) {
          const raw = await controller.runEvidence(url.pathname.split('/').at(-1));
          if (raw === null) { json(response, 404, { error: 'Unknown extraction run' }); return; }
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(raw); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/action') {
          if (request.headers.origin !== origin) { json(response, 403, { error: 'A same-origin mutation is required' }); return; }
          const value = await body(request); fields(value, ['action', 'args'], 'Local request');
          const result = await controller.dispatch(value.action, value.args); json(response, 200, { result, workspace: controller.snapshot() }); return;
        }
        json(response, 404, { error: 'Unknown local route' }); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const pathname = decodeURIComponent(url.pathname);
      const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(root + path.sep) || !MIME[path.extname(filename)]) { response.writeHead(404); response.end(); return; }
      const resolved = await realpath(filename);
      if (!resolved.startsWith(root + path.sep)) { response.writeHead(404); response.end(); return; }
      let content = await readFile(resolved);
      if (pathname === '/' || pathname === '/index.html') {
        content = content.toString('utf8').replace("connect-src 'none'", "connect-src 'self'")
          .replace('</head>', `<meta name="pactspan-local-session" content="${token}"></head>`);
      }
      response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] }); response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const known = error instanceof InputError || ['ExtractionError', 'EspoError', 'WorkspaceStoreError'].includes(error.name);
      json(response, known ? 400 : error.code === 'ENOENT' ? 404 : 500, { error: known ? error.message : 'Local action failed. Preserve workspace files and inspect configuration or disk access' });
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, server, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
