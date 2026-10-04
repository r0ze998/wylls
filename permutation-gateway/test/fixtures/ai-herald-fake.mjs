// AC6a: a fake herald that serves the captured test/fixtures/ai-herald-* files over HTTP on 127.0.0.1:0.
// For tests of the AI citizens' feed (and anything else that reads the herald's public files).
//
//   const h = await startFakeHerald({ pageSize: 100 });   // h.url, h.requests, h.close()
//
// Routes (the same shapes the real herald serves, captured; see ai-herald-meta.json):
//   GET /h/season                       ai-herald-season.json
//   GET /h/events?after=<seq>           pages of the events excerpt, `full` true when the page is full
//   GET /h/province/<p>,<q>/<bell>      ai-herald-province-<p>,<q>-<bell>.json, else 404 {"code":"NotYet"}
//   GET /h/clash/<p>,<q>/<bell>         ai-herald-clash-<p>,<q>-<bell>.json, else 404 {"code":"NotYet"}
//   GET /h/roster/<ring>/latest.bin     ai-herald-roster-synthetic-<ring>.bin (SYNTHETIC, see the meta), else 404
//   GET /h/me/<wallet>                  ai-herald-me-<label>.json of the captured wallets
// Every other path answers 404 {"code":"NotFound"}. Options let a test hold rows back (`rows`), serve fewer
// provinces (`hide`) or count requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(FIXTURE_DIR, name));
export const readJson = name => JSON.parse(read(name).toString('utf8'));
export const exists = name => fs.existsSync(path.join(FIXTURE_DIR, name));

export const loadMeta = () => readJson('ai-herald-meta.json');
export const loadEvents = () => readJson('ai-herald-events.json');

export async function startFakeHerald({ pageSize = 500, rows = null, hide = () => false } = {}) {
  const all = rows ?? loadEvents().events;
  const requests = [];
  const meta = loadMeta();
  const meFiles = new Map(meta.me.map(m => [m.wallet, m.file]));
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    requests.push(u.pathname + u.search);
    const notYet = () => send(res, 404, '{"code":"NotYet","ok":false}');
    const file = (name, type) => (exists(name) && !hide(u.pathname) ? send(res, 200, read(name), type) : notYet());
    let m;
    if (u.pathname === '/h/season') return file('ai-herald-season.json');
    if (u.pathname === '/h/events') {
      const after = BigInt(u.searchParams.get('after') ?? '0');
      const rest = all.filter(r => BigInt(r.seq) > after);
      const events = rest.slice(0, pageSize);
      const next = events.length ? events[events.length - 1].seq : String(after);
      return send(res, 200, JSON.stringify({ v: 1, events, next, full: events.length === pageSize }));
    }
    if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/(\d+)$/.exec(u.pathname))) return file(`ai-herald-province-${m[1]},${m[2]}-${m[3]}.json`);
    if ((m = /^\/h\/clash\/(-?\d+),(-?\d+)\/(\d+)$/.exec(u.pathname))) return file(`ai-herald-clash-${m[1]},${m[2]}-${m[3]}.json`);
    if ((m = /^\/h\/roster\/(\d+)\/latest\.bin$/.exec(u.pathname))) {
      return exists(`ai-herald-roster-synthetic-${m[1]}.bin`) ? send(res, 200, read(`ai-herald-roster-synthetic-${m[1]}.bin`), 'application/octet-stream') : send(res, 404, '{"code":"NotFound","ok":false}');
    }
    if ((m = /^\/h\/me\/([1-9A-HJ-NP-Za-km-z]+)$/.exec(u.pathname)) && meFiles.has(m[1])) return send(res, 200, read(meFiles.get(m[1])));
    return send(res, 404, '{"code":"NotFound","ok":false}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, requests, rows: all, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
