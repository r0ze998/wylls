// （2026-11-17、書いただけ・未実行）公開の準備：転送する住所・起動前の確かめ・世界の照合・健康・観測の保存。
// 鍵・署名・通信なし（ヘラルドは差し替え）。記録のフォルダは mkdtemp で作った新しいものだけを使い、それだけを消す。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBoard, forwardedFor, upstreamHeaders, checkPublicStart, worldOfSeason, loopbackHttp } from '../coop/board.mjs';

const PROG = 'Frnt1111111111111111111111111111111111111111';
const own = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-public-'));
const season = (over = {}) => ({ status: 200, json: { programId: PROG, season: '7', cluster: 'devnet', ...over } });

test('the address handed to the herald: the board applies the herald\'s own rule, a client cannot choose it', () => {
  // a client straight at the board (not loopback): its own address, whatever X-Forwarded-For it sends
  assert.equal(forwardedFor('203.0.113.9', '1.2.3.4'), '203.0.113.9');
  // a reverse proxy in front on this machine: the last address it set
  assert.equal(forwardedFor('127.0.0.1', '1.2.3.4, 198.51.100.7'), '198.51.100.7');
  assert.equal(forwardedFor('::ffff:127.0.0.1', '198.51.100.7'), '198.51.100.7');
  assert.equal(forwardedFor('::1', 'not-an-ip'), '::1', 'nothing usable: the peer');
  const h = upstreamHeaders({ headers: { 'x-forwarded-for': '9.9.9.9', forwarded: 'for=9.9.9.9', 'x-real-ip': '9.9.9.9', accept: 'x' }, socket: { remoteAddress: '203.0.113.9' } }, new URL('http://127.0.0.1:41940'));
  assert.deepEqual([h.host, h['x-forwarded-for'], h.forwarded, h['x-real-ip'], h.accept], ['127.0.0.1:41940', '203.0.113.9', undefined, undefined, 'x']);
});

test('the public start: refused before anything is made, for each missing or wrong setting', () => {
  const ok = { cluster: 'devnet', clusterGiven: true, dataDir: '/srv/ws01', dataGiven: true, herald: 'http://127.0.0.1:41940', rpc: 'http://127.0.0.1:41910', repoDir: '/repo' };
  assert.deepEqual(checkPublicStart(ok), []);
  const one = over => checkPublicStart({ ...ok, ...over });
  assert.match(one({ clusterGiven: false }).join(), /--cluster must be given/);
  assert.match(one({ cluster: 'localnet' }).join(), /Dev Wallet/);
  assert.match(one({ dataGiven: false }).join(), /--data must be given/);
  assert.match(one({ dataDir: '/repo/.local/ws01-coop' }).join(), /inside the repository/);
  assert.match(one({ herald: 'https://example.org' }).join(), /--herald must be http on this machine's loopback/);
  assert.match(one({ rpc: 'http://10.0.0.5:8899' }).join(), /--rpc must be http/);
  assert.deepEqual(one({ rpc: null }), [], 'no RPC is allowed (the board then says nations stay unverified)');
  assert.equal(loopbackHttp('http://localhost:1'), true); assert.equal(loopbackHttp('http://[::1]:1'), true); assert.equal(loopbackHttp('http://0.0.0.0:1'), false);
});

test('one world: the herald\'s Season is the board\'s, or it is said what differs, or that it is not known', () => {
  const w = { programId: PROG, seasonId: 7n, cluster: 'devnet' };
  assert.deepEqual(worldOfSeason(season(), w), { state: 'same' });
  assert.deepEqual(worldOfSeason(season({ season: 8, cluster: 'mainnet' }), w), { state: 'different', differs: ['season', 'cluster'] });
  assert.equal(worldOfSeason(season({ cluster: undefined }), w).state, 'unknown', 'no cluster named: not assumed');
  assert.equal(worldOfSeason({ status: 502, json: null }, w).state, 'unknown');
});

test('health says ok, missing and unknown apart; config does not publish the herald in the public profile', async () => {
  const dir = own();
  try {
    const mk = (fetchHerald, profile) => createBoard({ herald: 'http://127.0.0.1:9', programId: PROG, seasonId: '7', dataDir: dir, cluster: 'devnet', fetchHerald, profile });
    const same = mk(async () => season(), 'public');
    const h = await same.health();
    assert.deepEqual(h.parts, { herald: 'ok', chain: 'missing', store: 'ok', observed: 'ok' }, 'no --rpc: the chain part is missing, never ok');
    assert.equal(h.ok, false);
    assert.equal('herald' in same.config(), false, 'public: the inside address is not published');
    assert.equal(mk(async () => season(), 'local').config().herald, 'http://127.0.0.1:9', 'local: as before');
    const down = mk(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, 'public');
    assert.equal((await down.health()).parts.herald, 'unknown');
    const other = mk(async () => season({ programId: 'Othr1111111111111111111111111111111111111111' }), 'public');
    assert.equal((await other.health()).parts.herald, 'missing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the observed times: an unreadable file is kept aside (never reset in place or overwritten), a new one is written whole', async () => {
  const dir = own();
  try {
    fs.writeFileSync(path.join(dir, 'observed.json'), '{"ended": {"a": 1}, "vaul');   // cut off mid-write
    const board = createBoard({ herald: 'http://127.0.0.1:9', programId: PROG, seasonId: '7', dataDir: dir, cluster: 'devnet',
      fetchHerald: async p => (p === '/h/caravans.json' ? { status: 200, json: { ended: [{ ownerTag: '5', seq: 1 }], vaults: [] } } : season()) });
    const aside = fs.readdirSync(dir).filter(f => f.startsWith('observed.json.unreadable-'));
    assert.equal(aside.length, 1, 'kept under another name');
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"ended": {"a": 1}, "vaul', 'its bytes unchanged');
    assert.match(board.config().observed, /^unreadable: kept as observed\.json\.unreadable-/);
    assert.equal((await board.health()).parts.observed, 'missing');
    await board.caravans();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'observed.json'), 'utf8'));
    assert.equal(Object.keys(saved.ended).length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'observed.json.tmp')), false, 'written through a temporary file and renamed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
