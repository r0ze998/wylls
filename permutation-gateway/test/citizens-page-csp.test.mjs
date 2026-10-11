// Council page (unit AC7), CSP-clean under serve.mjs (contract §1.3 C6, §11.5 AC7). The page is served by the real
// serve.mjs over the real web directory; the CSP header it sends is read from the response and the served HTML, CSS
// and every module of the import graph are checked against what that policy allows: no inline script, no inline
// style (element or attribute), no handler attribute, nothing off-origin, and every module the page imports resolves
// (the page's own modules through serve.mjs; the three design-session modules it loads lazily by absolute path through
// the herald prefix, here a fake herald that serves the web directory the way the real herald's static handler does).
import './fixtures/ai-page-lang.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServe, PAGE_CSP } from '../citizens/serve.mjs';
import { specifiers } from './fixtures/ai-page-src.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, '../../permutation-server/web');
const pageDir = path.join(webDir, 'frontier');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-page-csp-'));
const aiDir = path.join(tmp, 'ai');
fs.mkdirSync(path.join(aiDir, 'pub'), { recursive: true });
fs.writeFileSync(path.join(aiDir, 'pub', 'roster.json'), '{"v":1}');

// A fake herald: /frontier/<rel> serves permutation-server/web/<rel> (the real herald's `web` handler: root = web dir,
// same safe-name rule), /h/season answers a localnet season.
const fakeHerald = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/h/season') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"cluster":"localnet"}'); }
  if (u.pathname.startsWith('/frontier/')) {
    const rel = u.pathname.slice('/frontier/'.length);
    const safe = /^[A-Za-z0-9/._-]+$/.test(rel) && rel.split('/').every(s => s && !s.startsWith('.'));
    const p = path.join(webDir, rel);
    if (safe && fs.existsSync(p) && fs.statSync(p).isFile()) { res.writeHead(200, { 'content-type': p.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream' }); return res.end(fs.readFileSync(p)); }
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"ok":false}');
});
let serve, base, heraldPort;
before(async () => {
  await new Promise(r => fakeHerald.listen(0, '127.0.0.1', r));
  heraldPort = fakeHerald.address().port;
  serve = createServe({ aiDir, herald: `http://127.0.0.1:${heraldPort}`, social: `http://127.0.0.1:${heraldPort}`, port: 0, pageDir });
  await serve.listen();
  base = serve.url;
});
after(async () => { await serve.close(); await new Promise(r => fakeHerald.close(r)); fs.rmSync(tmp, { recursive: true, force: true }); });

const get = async p => {
  const r = await fetch(base + p);
  return { status: r.status, headers: r.headers, text: await r.text() };
};
const csp = c => Object.fromEntries(c.split(';').map(s => s.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test('the page is served with the CSP of serve.mjs: self only, no unsafe-inline, no eval, no external host', async () => {
  const r = await get('/council.html');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('content-security-policy'), PAGE_CSP);
  const p = csp(r.headers.get('content-security-policy'));
  assert.deepEqual(p['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(p['style-src'], ["'self'"]);
  assert.deepEqual(p['connect-src'], ["'self'"]);
  assert.deepEqual(p['form-action'], ["'none'"]);
  assert.deepEqual(p['object-src'], ["'none'"]);
  assert.deepEqual(p['frame-ancestors'], ["'none'"]);
  for (const [k, v] of Object.entries(p)) {
    assert.ok(!v.some(x => /unsafe-inline|unsafe-eval|\*|https?:/.test(x.replace("'wasm-unsafe-eval'", ''))), `${k}: ${v}`);
    if (k !== 'img-src') assert.ok(!v.includes('data:') && !v.includes('blob:'), `${k} allows data: or blob:`);
  }
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const alt = await get('/frontier/council.html');
  assert.equal(alt.status, 200, 'also under /frontier/');
  assert.equal(alt.text, r.text);
});

test('the served HTML has nothing the CSP would block: no inline script or style, no handler attribute, no off-origin reference', async () => {
  const { text } = await get('/council.html');
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc="council\/main\.mjs"/);
    assert.equal(m[2].trim(), '', 'inline script body');
  }
  assert.doesNotMatch(body, /<style\b/i);
  assert.doesNotMatch(body, /\sstyle\s*=/i);
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(body, /javascript:/i);
  for (const m of body.matchAll(/\b(?:src|href|action|poster|data)\s*=\s*"([^"]*)"/gi)) assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(m[1]), `off-origin reference ${m[1]}`);
  for (const m of body.matchAll(/<link\b[^>]*>/gi)) assert.match(m[0], /rel="stylesheet"[^>]*href="council\/council\.css"/);
});

test('the stylesheet and every page module are served with the page CSP and the right types', async () => {
  const css = await get('/council/council.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(css.headers.get('content-security-policy'), PAGE_CSP);
  assert.doesNotMatch(css.text, /url\s*\(|@import/);
  const modules = fs.readdirSync(path.join(pageDir, 'council')).filter(f => f.endsWith('.mjs'));
  assert.ok(modules.includes('main.mjs') && modules.includes('aisocial.mjs'));
  const ja = await get('/council/lang.ja.json');
  assert.equal(ja.status, 200, 'the Japanese dictionary is served');
  assert.equal(Object.keys(JSON.parse(ja.text)).length > 300, true);
  for (const f of modules) {
    const r = await get(`/council/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), /text\/javascript/, f);
    assert.equal(r.headers.get('content-security-policy'), PAGE_CSP, f);
  }
});

test('the import graph of the page resolves through serve.mjs and the herald prefix (static imports local, design-session modules lazily by absolute path)', async () => {
  const seen = new Set();
  const lazy = new Set();
  const queue = ['/council/main.mjs'];
  while (queue.length) {
    const u = queue.pop();
    if (seen.has(u)) continue;
    seen.add(u);
    const r = await get(u);
    assert.equal(r.status, 200, `${u} must resolve (status ${r.status})`);
    for (const s of specifiers(r.text)) {
      if (s.startsWith('/')) { lazy.add(s); queue.push(s); continue; }
      assert.ok(s.startsWith('./') || s.startsWith('../'), `${u} imports a bare or remote specifier ${s}`);
      queue.push(new URL(s, new URL(u, 'http://x')).pathname);
    }
  }
  // the page's own modules are the local ones, and the page imports no design-session module statically
  const local = [...seen].filter(u => u.startsWith('/council/'));
  assert.ok(local.length >= 12, `local modules ${local.length}`);
  assert.deepEqual([...lazy].filter(u => !u.startsWith('/frontier/')), [], 'absolute imports are under the herald prefix only');
  assert.deepEqual([...lazy].sort(), ['/frontier/frontier/faddr.mjs', '/frontier/frontier/people/identity.mjs', '/frontier/session.mjs'], 'the three lazily loaded read-only web modules');
  // and everything they pull in came back 200 through the herald prefix
  const viaHerald = [...seen].filter(u => u.startsWith('/frontier/'));
  assert.ok(viaHerald.length >= 10, `closure of the lazy modules: ${viaHerald.length}`);
  for (const u of viaHerald) assert.ok(fs.existsSync(path.join(webDir, u.slice('/frontier/'.length))), u);
});

test('the council modules import nothing outside council/ statically (design-session files are only read, lazily, by URL)', () => {
  const dir = path.join(pageDir, 'council');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const s of specifiers(src)) {
      if (s.startsWith('/')) continue;
      assert.match(s, /^\.\/[a-z]+\.mjs$/, `${f} imports ${s}`);
      assert.ok(fs.existsSync(path.join(dir, s)), `${f} imports a missing ${s}`);
    }
  }
});

test('the AI\'s own files are served as data (no script CSP) and the page can read them with connect-src self', async () => {
  const r = await get('/h/ai/roster.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('no design-session file is served by the council routes (only council.html and council/*)', async () => {
  for (const p of ['/app.mjs', '/index.html', '/frontier.css', '/fsession.mjs']) assert.equal((await get(p)).status, 404, p);
});
