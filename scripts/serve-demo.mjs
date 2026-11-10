import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { buildDemo } from './build-demo.mjs';

const root = await realpath(await buildDemo());
const index = process.argv.indexOf('--port');
const port = index < 0 ? 0 : Number(process.argv[index + 1]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Use an integer --port in0..65535');
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname) === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const candidate = path.resolve(root, '.' + relative);
    if (!candidate.startsWith(root + path.sep) || !mime[path.extname(candidate)]) { response.writeHead(404); response.end(); return; }
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(root + path.sep)) { response.writeHead(404); response.end(); return; }
    const content = await readFile(resolved);
    response.writeHead(200, { 'Content-Type': mime[path.extname(resolved)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ local_url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, root })));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
