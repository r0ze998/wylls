// local-perf (2026-11-21): the launcher lets the browser keep the page's art (pictures, fonts) and checks it on every load
// (no-cache + a validator, 304 when unchanged); code and pages stay no-store. In-process server on an ephemeral port only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createLauncherServer } from '../src/frontier/local-play-launcher.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = path.join(root, 'permutation-server/web');
const request = (port, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: route, headers: { host: 'localhost:41650', ...headers } }, res => {
    let n = 0; res.on('data', b => { n += b.length; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: n }));
  });
  req.on('error', reject); req.end();
});
const firstArt = () => {
  for (const dir of ['frontier/art', 'frontier']) {
    const abs = path.join(web, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) stack.push(f); else if (/\.(webp|png|svg)$/.test(e.name)) return path.relative(web, f);
      }
    }
  }
  return null;
};

test('art is kept and checked again (304 on an unchanged validator); code and pages stay no-store', async () => {
  const { server } = createLauncherServer({ port: 41650, web: fs.realpathSync(web) }, { start: async () => ({}), close() {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  try {
    const art = firstArt();
    assert.ok(art, 'the web tree has a picture');
    const a = await request(port, `/frontier/${art}`);
    assert.equal(a.status, 200); assert.equal(a.headers['cache-control'], 'no-cache'); assert.match(a.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(a.bytes > 0); assert.ok(a.headers['content-security-policy']);
    const b = await request(port, `/frontier/${art}`, { 'if-none-match': a.headers.etag });
    assert.equal(b.status, 304); assert.equal(b.bytes, 0); assert.equal(b.headers.etag, a.headers.etag);
    const c = await request(port, `/frontier/${art}`, { 'if-none-match': 'W/"0-0"' });
    assert.equal(c.status, 200); assert.ok(c.bytes > 0);
    for (const file of ['frontier/index.html', 'frontier/app.mjs', 'frontier/frontier.css']) {
      const r = await request(port, `/frontier/${file}`, { 'if-none-match': a.headers.etag });
      assert.equal(r.status, 200, file); assert.equal(r.headers['cache-control'], 'no-store', file); assert.equal(r.headers.etag, undefined, file);
    }
  } finally { server.close(); }
});
