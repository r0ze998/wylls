// Browser wide seal (web/frontier/seal-wide.mjs) against Rust
// (fclient::wide_seal / frontier-abi world_index::seal): the shared public
// vector holds one Rust-made and one browser-made seal over the PUBLISHED
// Quicknet round of fclient's q4 vector, opened here with that round's real
// signature. Consistency only, never future secrecy. Fresh seals use
// crypto.getRandomValues; no key, k or salt is printed or stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DOMAIN_MARCH_WIDE, IBE_LEN, WIDE_SEAL_LEN, commitWide, bodyXorWide, openWide, judgeWide, sealWideWith, sealWideRequest,
} from '../../permutation-server/web/frontier/seal-wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey, encodeWideDirections, packWidePlain }
  from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { QUICKNET, TEST_BEACON } from '../../permutation-server/web/frontier/abi.mjs';
import { SEAL_LEN, PLAIN_LEN } from '../../permutation-server/web/frontier/seal.mjs';
import { seasonClock } from '../../permutation-server/web/frontier/clock.mjs';

const CROSS = JSON.parse(readFileSync(new URL('./fixtures/wide-seal-cross-v1.json', import.meta.url), 'utf8'));
const Q4 = JSON.parse(readFileSync(new URL('../../frontier-node/crates/fclient/fixtures/tlock/q4-vector.json', import.meta.url), 'utf8'));
const W = '77'.repeat(32);
const hex = b => Buffer.from(b).toString('hex');
const host = canonicalOriginalHostRef({ world: W, p: '128', q: '0', site: 3, gen: 1, seq: 7 });
const sample = (over = {}) => ({ version: 2, host, arriveBell: 500, dest: canonicalWideProvinceKey({ world: W, p: '129', q: '0' }),
  destTile: 4, stance: 2, retreatBps: 0, ...encodeWideDirections([0]), reserved: '00'.repeat(8), ...over });
const g = QUICKNET.genesis, p = QUICKNET.period;
// T(500) = the published q4 round
const clock = { genesisTs: g + (Q4.round - 1) * p - 600 * 501, drand: { genesis: g, period: p } };
const request = (over = {}) => ({ plain: sample(), host, arriveBell: 500, clock,
  drand: { publicKey: QUICKNET.publicKey, period: p, genesis: g, chainHash: QUICKNET.chainHash },
  seasonPkHash: QUICKNET.pkHash, seasonNetwork: 2, cluster: 'localnet', ...over });

test('formats are the Rust ones and the legacy seal is untouched', () => {
  assert.equal(DOMAIN_MARCH_WIDE, 'PS-FRONTIER-MARCH-WIDE-v1');
  assert.equal(IBE_LEN, 128);
  assert.equal(WIDE_SEAL_LEN, 264);
  assert.equal(SEAL_LEN, 165);
  assert.equal(PLAIN_LEN, 37);
  assert.equal(CROSS.round, Q4.round);
  assert.equal(CROSS.host, host);
  assert.equal(hex(packWidePlain(sample())), CROSS.plain, 'the browser packs the plaintext byte for byte as Rust');
});

test('the browser opens the Rust seal and its own with the real round signature', () => {
  for (const side of ['rust', 'js']) {
    const v = CROSS[side];
    const opened = openWide(v.seal, Q4.sig);
    assert.equal(hex(opened.plain), CROSS.plain, side);
    assert.equal(hex(opened.commit), v.commit, side);
    assert.equal(hex(commitWide(opened.plain, opened.salt)), v.commit, side);
    assert.deepEqual(judgeWide({ seal: v.seal, signature: Q4.sig, commit: v.commit, host, arriveBell: 500 }), sample(), side);
    // another round's real signature: FO check
    assert.throws(() => openWide(v.seal, Q4.prev_round_sig), e => e.code === 'FoCheck', side);
  }
  assert.notEqual(CROSS.rust.seal, CROSS.js.seal);
});

test('a fresh browser seal round-trips, binds the round and keeps the reveal in memory only', () => {
  const a = sealWideRequest(request()), b = sealWideRequest(request());
  assert.equal(a.ok, true, a.error);
  assert.equal(a.round, Q4.round);
  assert.equal(a.seal.length, WIDE_SEAL_LEN);
  assert.ok((a.seal[0] & 0x80) !== 0 && (a.seal[0] & 0x40) === 0, "Depart's seal-flag syntax");
  assert.equal(hex(commitWide(a.reveal.plain, a.reveal.salt)), hex(a.commit));
  assert.equal(hex(a.reveal.plain), CROSS.plain);
  const opened = openWide(a.seal, Q4.sig);
  assert.ok(Buffer.from(opened.salt).equals(Buffer.from(a.reveal.salt)) && Buffer.from(opened.plain).equals(Buffer.from(a.reveal.plain)),
    'opened half matches the reveal half');
  // fresh randomness: nothing shared between two seals
  assert.notEqual(hex(a.seal.subarray(0, IBE_LEN)), hex(b.seal.subarray(0, IBE_LEN)));
  assert.notEqual(hex(a.commit), hex(b.commit));
  assert.ok(!Buffer.from(a.reveal.salt).equals(Buffer.from(b.reveal.salt)), 'two seals share a salt');
  // JSON never carries the reveal (plain or salt)
  const j = JSON.stringify(a);
  assert.ok(!j.includes(CROSS.plain) && !j.includes(hex(a.reveal.salt)) && j.includes('"reveal":"<redacted>"'));
});

test('beacon, round, randomness and plaintext refusals', () => {
  const code = over => sealWideRequest(request(over)).code;
  assert.equal(code({ seasonNetwork: undefined }), 'SeasonNetworkRequired');
  assert.equal(code({ seasonNetwork: 0 }), 'NotQuicknet');
  assert.equal(code({ seasonPkHash: '00'.repeat(32) }), 'PkHashMismatch');
  assert.equal(code({ drand: { publicKey: QUICKNET.publicKey, period: 30, genesis: g } }), 'BeaconClockMismatch');
  assert.equal(code({ drand: { publicKey: TEST_BEACON.publicKey, period: p, genesis: g }, seasonPkHash: TEST_BEACON.pkHash, cluster: 'devnet' }), 'TestBeaconOffLocalnet');
  assert.equal(code({ round: Q4.round + 1 }), 'WrongRound');
  assert.equal(code({ clock: {} }), 'Clock');
  assert.equal(code({ host: canonicalOriginalHostRef({ world: W, p: '128', q: '0', site: 3, gen: 1, seq: 8 }) }), 'HostMismatch');
  assert.equal(code({ arriveBell: 501 }), 'ArriveMismatch');
  for (const [over, want] of [
    [{ version: 1 }, 'Version'], [{ reserved: '01' + '00'.repeat(7) }, 'Reserved'], [{ destTile: 61 }, 'Tile'],
    [{ stance: 4 }, 'Stance'], [{ retreatBps: 60_001 }, 'Retreat'], [{ path: '80' + '00'.repeat(11) }, 'PathBits'],
    // step 0 = direction 6 (the encoder itself refuses it, so the bytes are literal)
    [{ pathLen: 1, path: '06' + '00'.repeat(11) }, 'Direction'], [{ pathLen: 33 }, 'PathTooLong'],
    [{ dest: canonicalWideProvinceKey({ world: '78'.repeat(32), p: '129', q: '0' }) }, 'WorldMismatch'],
  ]) assert.equal(code({ plain: sample(over) }), want, JSON.stringify(over));
  // weak or malformed randomness is refused before any sealing
  for (const draw of [n => new Uint8Array(n), () => new Uint8Array(15), () => 'x']) {
    assert.equal(sealWideRequest(request(), draw).code, 'Random');
  }
  let calls = 0;
  const same = n => { calls++; return new Uint8Array(n).fill(9); };
  assert.equal(sealWideRequest(request(), same).code, 'Random', 'k equal to sigma');
  assert.equal(calls, 2);
});

test('openWide and judgeWide refuse tampered or malformed seals', () => {
  const v = CROSS.rust;
  const b = Buffer.from(v.seal, 'hex');
  const body = Buffer.from(b); body[IBE_LEN + 70] ^= 1;
  assert.throws(() => judgeWide({ seal: hex(body), signature: Q4.sig, commit: v.commit, host, arriveBell: 500 }), e => e.code === 'Commit');
  const u = Buffer.from(b); u.fill(0xab, 0, 96);
  assert.throws(() => openWide(hex(u), Q4.sig), e => e.code === 'BadPoint');
  assert.throws(() => openWide(v.seal.slice(2), Q4.sig), e => e.code === 'SealLength');
  assert.throws(() => openWide(v.seal, Q4.sig.slice(2)), e => e.code === 'SignatureLength' || e.code === 'BadPoint');
  assert.throws(() => judgeWide({ seal: v.seal, signature: Q4.sig, commit: '00'.repeat(32), host, arriveBell: 500 }), e => e.code === 'Commit');
  assert.throws(() => judgeWide({ seal: v.seal, signature: Q4.sig, commit: v.commit, host, arriveBell: 499 }), e => e.code === 'ArriveMismatch');
  assert.throws(() => commitWide(new Uint8Array(135), new Uint8Array(32)), e => e.code === 'PlainLength');
  assert.throws(() => bodyXorWide(new Uint8Array(15), new Uint8Array(136)), e => e.code === 'KeyLength');
  // the seal-with primitive refuses a plaintext the codec refuses
  assert.throws(() => sealWideWith({ plain: { ...sample(), host: 'zz' }, round: Q4.round, publicKey: QUICKNET.publicKey,
    k: new Uint8Array(16).fill(1), sigma: new Uint8Array(16).fill(2) }));
});

test('the season clock must be the pinned beacon clock, in safe integers', () => {
  const code = over => sealWideRequest(request(over)).code;
  for (const bad of [NaN, Infinity, -Infinity, 1.5, '1700000000', 2 ** 53]) {
    assert.equal(code({ clock: { ...clock, genesisTs: bad } }), 'Clock', String(bad));
  }
  assert.equal(code({ clock: { ...clock, drand: { genesis: g, period: 30 } } }), 'ClockBeaconMismatch');
  assert.equal(code({ clock: { ...clock, drand: { genesis: g + 1, period: p } } }), 'ClockBeaconMismatch');
  assert.equal(code({ clock: { ...clock, drand: { genesis: g, period: 0 } } }), 'Clock');
  assert.equal(code({ clock: { ...clock, drand: { genesis: g, period: NaN } } }), 'Clock');
  // safe inputs whose cutoff genesisTs + 600·(b+1) would exceed MAX_SAFE_INTEGER
  // (a rounded T would otherwise be accepted)
  const near = Number.MAX_SAFE_INTEGER - 600;
  assert.equal(code({ clock: { ...clock, genesisTs: near } }), 'Clock');
  // the exact boundary: cutoff = MAX_SAFE_INTEGER is computed exactly, one more is refused
  const edge = Number.MAX_SAFE_INTEGER - 600 * 501;
  const atEdge = sealWideRequest(request({ clock: { ...clock, genesisTs: edge } }));
  assert.equal(atEdge.ok, true, atEdge.error);
  assert.equal(BigInt(atEdge.round), (BigInt(Number.MAX_SAFE_INTEGER) - BigInt(g) + BigInt(p) - 1n) / BigInt(p) + 1n);
  assert.equal(code({ clock: { ...clock, genesisTs: edge + 1 } }), 'Clock');
  // a negative delta beyond −MAX_SAFE_INTEGER is refused the same way
  assert.equal(code({ clock: { ...clock, genesisTs: -Number.MAX_SAFE_INTEGER }, round: 1 }), 'Clock');
  assert.equal(code({ round: Q4.round + 0.5 }), 'WrongRound');
  assert.equal(code({ round: String(Q4.round) }), 'WrongRound');
  assert.equal(sealWideRequest(request({ round: Q4.round })).ok, true);
});

// A Node worker_threads SHIM of the browser WorkerGlobalScope (not a browser
// Worker): it proves the module installs exactly one handler and answers once.
test('seal-wide-worker.mjs under a Node worker_threads shim installs one handler and answers once with the same id', async () => {
  const { Worker } = await import('node:worker_threads');
  const workerUrl = new URL('../../permutation-server/web/frontier/seal-wide-worker.mjs', import.meta.url).href;
  // Inside a worker thread: a WorkerGlobalScope whose addEventListener /
  // postMessage are recorded, then the real module is imported.
  const code = `
    const { parentPort } = require('node:worker_threads');
    const listeners = [];
    globalThis.WorkerGlobalScope = class { static [Symbol.hasInstance]() { return true; } };
    globalThis.addEventListener = (type, fn) => { if (type === 'message') listeners.push(fn); };
    const posts = [];
    globalThis.postMessage = m => posts.push(m);
    import(${JSON.stringify(workerUrl)}).then(() => {
      parentPort.on('message', req => {
        for (const fn of listeners) fn({ data: req });
        parentPort.postMessage({ listeners: listeners.length, posts: posts.map(m => ({ id: m.id, ok: m.ok, code: m.code,
          seal: m.seal && m.seal.length, revealPlain: m.revealPlain && m.revealPlain.length })) });
      });
      parentPort.postMessage('ready');
    });`;
  const w = new Worker(code, { eval: true });
  try {
    const next = () => new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    assert.equal(await next(), 'ready');
    const r = request();
    w.postMessage({ ...r, id: 7 });
    const out = await next();
    assert.equal(out.listeners, 1, 'only the wide handler (no legacy seal-worker handler)');
    assert.equal(out.posts.length, 1, 'exactly one answer');
    assert.deepEqual(out.posts[0], { id: 7, ok: true, code: undefined, seal: WIDE_SEAL_LEN, revealPlain: 136 });
  } finally {
    await w.terminate();
  }
});

test('sealWide keeps its own message id and cleans up when postMessage throws', async () => {
  const { sealWide } = await import('../../permutation-server/web/frontier/seal-wide.mjs');
  const seen = [];
  const saved = globalThis.Worker;
  globalThis.Worker = class {
    postMessage(input) {
      const msg = structuredClone(input); // the browser worker transport, including clone refusals
      seen.push(msg.id);
      if (msg.boom) throw new Error('cannot clone');
      const { id, ...req } = msg;
      const r = sealWideRequest(req);
      queueMicrotask(() => this.onmessage({ data: { id, ok: r.ok, seal: r.seal, commit: r.commit, ctHash: r.ctHash, sealRoot: r.sealRoot,
        round: r.round, revealPlain: r.reveal?.plain, revealSalt: r.reveal?.salt, code: r.code } }));
    }
  };
  try {
    const failed = await sealWide({ ...request(), boom: true });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'WorkerPost');
    const ok = await sealWide({ ...request(), id: 'caller-id' });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(typeof seen.at(-1), 'number', 'the internal id, not the caller\'s');
    assert.equal(hex(commitWide(ok.reveal.plain, ok.reveal.salt)), hex(ok.commit));
    assert.ok(JSON.stringify(ok).includes('"reveal":"<redacted>"'));
    const liveClock = seasonClock({ genesisTs: clock.genesisTs, drandGenesis: g,
      drandPeriod: p, seedMargin: 3, endBell: 1000 });
    assert.equal(typeof liveClock.window, 'function');
    assert.throws(() => structuredClone(request({ clock: liveClock })), { name: 'DataCloneError' });
    const live = await sealWide(request({ clock: liveClock }));
    assert.equal(live.ok, true, live.error);
    assert.equal(live.round, Q4.round);
    assert.equal(hex(commitWide(live.reveal.plain, live.reveal.salt)), hex(live.commit));
    assert.equal(typeof liveClock.window, 'function', 'the page clock is not mutated');
    assert.ok(JSON.stringify(live).includes('"reveal":"<redacted>"'));
    for (const invalid of [String(clock.genesisTs), BigInt(clock.genesisTs), NaN]) {
      const refused = await sealWide(request({ clock: { ...liveClock, genesisTs: invalid } }));
      assert.equal(refused.code, 'Clock', 'transport must not coerce invalid clock types');
    }
    assert.equal((await sealWide(request({ clock: liveClock, round: Q4.round + 1 }))).code, 'WrongRound');
    assert.equal((await sealWide(request({ clock: liveClock, seasonNetwork: 0 }))).code, 'NotQuicknet');

  } finally {
    globalThis.Worker = saved;
  }
});
