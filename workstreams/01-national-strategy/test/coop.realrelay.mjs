// 本物の中継（permutation-gateway src/frontier/server.mjs）と本物のヘラルド（frontier-herald）で、依頼の画面から中継へ届くかを確かめる。
// チェーン（Agave）は無い：中継は blockhash を取れずに答えるので、「届いた・答えを読めた」までを確かめる。
//   必要：permutation-gateway の依存（npm ci --ignore-scripts --prefix permutation-gateway）、
//         frontier-node/target/debug/frontier-herald（cd frontier-node && cargo build --locked -p herald --bin frontier-herald）
//   node workstreams/01-national-strategy/test/coop.realrelay.mjs
// 中継の手数料の鍵は、使い捨ての試験用の種（一時フォルダ）。資金も実際の鍵も使わない。

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createBoard, createServer, PAGE } from '../coop/board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const HERALD = path.join(repo, 'frontier-node/target/debug/frontier-herald');
const RELAY = path.join(repo, 'permutation-gateway/src/frontier/server.mjs');
const missing = [];
if (!fs.existsSync(HERALD)) missing.push(`${HERALD}（cargo build --locked -p herald --bin frontier-herald）`);
if (!fs.existsSync(path.join(repo, 'permutation-gateway/node_modules/@solana/web3.js'))) missing.push('permutation-gateway の依存（npm ci --ignore-scripts --prefix permutation-gateway）');
if (missing.length) { console.log(`# skip：足りないもの：${missing.join('、')}`); process.exit(0); }

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-realrelay-'));
fs.writeFileSync(path.join(tmp, 'seed.hex'), crypto.randomBytes(32).toString('hex'));
const PROGRAM = '11111111111111111111111111111111';
const DEAD_RPC = 'http://127.0.0.1:41979';   // チェーンは無い
const P = { relayPub: 41973, relayOp: 41974, herald: 41975 };
const kids = [];
const start = (cmd, args) => { const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); kids.push(c); return c; };
const results = [];
const step = async (name, f) => { try { await f(); results.push(['ok', name]); } catch (e) { results.push(['not ok', name, e.message]); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

try {
  start('node', [RELAY, '--program', PROGRAM, '--season', '90', '--rpc', DEAD_RPC, '--port', String(P.relayOp), '--public-port', String(P.relayPub), '--pool-size', '2', '--dev',
    '--master-seed-file', path.join(tmp, 'seed.hex'), '--state-file', path.join(tmp, 'state.json')]);
  start(HERALD, ['--data', path.join(tmp, 'herald'), '--program', PROGRAM, '--season', '90', '--rpc', DEAD_RPC, '--listen', `127.0.0.1:${P.herald}`,
    '--relay', `127.0.0.1:${P.relayPub}`, '--test-key', '--source', 'localnet']);
  await wait(4000);
  const board = createBoard({ herald: `http://127.0.0.1:${P.herald}`, programId: PROGRAM, seasonId: '90', dataDir: path.join(tmp, 'board') });
  const srv = createServer(board, { herald: `http://127.0.0.1:${P.herald}` });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${origin}${PAGE}`);

  await step('本物の中継は CORS の見出しを返さず、OPTIONS に NotFound で答える（直接の問い合わせ）', async () => {
    const g = await fetch(`http://127.0.0.1:${P.relayPub}/f/relay`, { headers: { origin } });
    assert.equal(g.headers.get('access-control-allow-origin'), null);
    const o = await fetch(`http://127.0.0.1:${P.relayPub}/f/relay`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    assert.equal(o.status, 404);
  });

  await step('ブラウザ：依頼の画面（板の入口）から中継の住所へ直接は、GET も POST も止められる（CORS）', async () => {
    const r = await page.evaluate(async url => {
      const out = {};
      try { await fetch(`${url}/f/relay`); out.get = 'read'; } catch (e) { out.get = String(e); }
      try { await fetch(`${url}/f/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); out.post = 'read'; } catch (e) { out.post = String(e); }
      return out;
    }, `http://127.0.0.1:${P.relayPub}`);
    assert.match(r.get, /TypeError|Failed to fetch/);
    assert.match(r.post, /TypeError|Failed to fetch/);
  });

  await step('ブラウザ：同じ入口の /gw（板 → 本物のヘラルド → 本物の中継）なら届き、中継の答えを読める（チェーンが無いので blockhash の誤り）', async () => {
    const r = await page.evaluate(async () => { const x = await fetch('/gw/f/relay'); return { status: x.status, body: await x.text() }; });
    assert.equal(r.status, 500);
    assert.match(r.body, /blockhash/, '答えたのは中継（チェーンに届かない）');
    const p = await page.evaluate(async () => { const x = await fetch('/gw/f/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: x.status, body: await x.text() }; });
    assert.ok(p.status >= 400 && p.status < 500, `POST も中継まで届き、中継が断った（${p.status} ${p.body.slice(0, 80)}）`);
  });

  await step('ゲームと同じコード（fchainio.mjs relayInfo）を /gw で呼ぶと、中継の答え（チェーンが無い）として失敗を返す', async () => {
    const r = await page.evaluate(async () => {
      const io = await import('/ws01/repo/permutation-server/web/frontier/fchainio.mjs');
      io.setRelay('/gw');
      io.setPin({ programId: '11111111111111111111111111111111', cluster: 'localnet', seasonId: '90' });
      return io.relayInfo();
    });
    assert.equal(r.ok, false);
    assert.equal(r.httpStatus, 500);
    assert.match(r.error, /blockhash/);
  });
  await browser.close();
  srv.close();
} finally {
  for (const k of kids) k.kill();
}
for (const [s, n, m] of results) console.log(`${s} - ${n}${m ? `\n  ${m}` : ''}`);
const failed = results.filter(r => r[0] !== 'ok').length;
console.log(`# pass ${results.length - failed}\n# fail ${failed}`);
process.exit(failed ? 1 : 0);
