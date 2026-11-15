// Fixed public bytes and fake fetch only. No sockets, keys, signatures, or timers
// beyond the reader's cleared request deadline. Run only after closure review.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseWideLive, createWideLiveReader, renderWideLive, readWideLiveJSON, wideLiveEnabled } from '../../permutation-server/web/frontier/fwide-live.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { sortKeyOf, wideHoldingAddress } from '../../permutation-server/web/frontier/fwide.mjs';
import { captureAddress } from '../../permutation-server/web/frontier/map/widecapture.mjs';
import { worldIdOf, ringPosition } from '../../permutation-server/web/frontier/map/wide.mjs';
import { encode, decode } from '../../permutation-server/web/sdk/base58.mjs';
import { toBase64, fromHex, fromBase64, utf8 } from '../../permutation-server/web/sdk/bytes.mjs';
import { decode as decodeAccount } from '../../permutation-server/web/frontier/fcodec.mjs';
import { setS1, s1On } from '../../permutation-server/web/frontier/fs1.mjs';
import { BUILDINGS, RESOURCES } from '../../permutation-server/web/frontier/fi18n.mjs';
import { L } from '../../permutation-server/web/lang.mjs';
import { residentCitizen } from '../../permutation-server/web/sdk/frontier/resident.mjs';

const programId = encode(new Uint8Array(32).fill(94));
const viewerKey = encode(new Uint8Array(32).fill(65));
const addresses = seasonAddresses(programId, '5');
const citizen = addresses.of('Citizen', { wallet: viewerKey });
const pins = { programId, viewerKey, viewerKind: 'wallet', citizen, seasonId: '5', seasonAddress: addresses.season, world: worldIdOf(addresses.season, programId), rulesetHash: '11'.repeat(32) };
const holding = { kind: 'WideHolding', readOnly: true, executable: false, ownerCitizen: citizen, world: pins.world, season: '5', p: 9007199254740993n, q: -130n, site: 3, generation: 1, inventorySlot: 2 };
holding.capture = { address: wideHoldingAddress(addresses.season, programId, holding.p, holding.q, 3), slot: 100n, verification: 'captured-unverified' };
const le = (n, size) => { const b = new Uint8Array(size), v = new DataView(b.buffer); if (size === 8) v.setBigUint64(0, BigInt(n), true); else v.setUint32(0, n, true); return b; };
function header(size, magic, version) {
  const b = new Uint8Array(size); b.set(utf8(magic)); b.set(le(5, 8), 8); new DataView(b.buffer).setUint16(16, version, true); return b;
}
function digest(j) {
  const hash = createHash('sha256');
  for (const b of [utf8('PSF-KEEPER-WIDE-SNAPSHOT-v1'), le(j.observed_slot, 8), le(j.min_slot, 8), le(9, 4), utf8('confirmed'), le(4, 4)]) hash.update(b);
  const sorted = [...j.accounts].sort((a, b) => Buffer.compare(decode(a.address), decode(b.address)));
  for (const a of sorted) {
    const bytes = fromBase64(a.data_b64);
    for (const b of [decode(a.address), Uint8Array.of(1), le(a.lamports, 8), decode(a.owner), Uint8Array.of(0), le(bytes.length, 4), bytes]) hash.update(b);
  }
  for (const b of [Uint8Array.of(0xc1), fromBase64(j.clock.data_b64), Uint8Array.of(0)]) hash.update(b);
  j.snapshot_digest = hash.digest('hex'); return j;
}
function fixture() {
  const hb = header(1344, 'PSFXWHL1', 3), pb = header(4864, 'PSFXWPV1', 3), cb = header(384, 'PSF1CITZ', 2), sb = header(2048, 'PSF1SEAS', 2);
  hb[68] = 3; hb[69] = 1; hb.set(decode(citizen), 72); hb[1280] = 1; hb[1282] = 1; hb[1283] = 2;
  hb.set(fromHex(pins.world), 1288); hb.set(sortKeyOf(holding.p, holding.q), 1320);
  // First resource VALUE, intentionally above Number's exact integer range.
  hb.set(le(9007199254740993n, 8), 152);
  pb[70] = ringPosition(holding.p, holding.q).wedge; pb[4736] = 1; pb[4738] = 1; pb[4739] = 15;
  pb.set(fromHex(pins.world), 4740); pb.set(sortKeyOf(holding.p, holding.q), 4772); pb[4800] = 1;
  pb[296 + 3 * 64] = 1; pb[296 + 3 * 64 + 4] = 1;
  cb.set(decode(viewerKey), 64); cb[173] = 255; cb[178] = 12; cb[185] = 255;
  sb[65] = addresses.bump; sb.set(fromHex(pins.rulesetHash), 104); sb[136] = 12; new DataView(sb.buffer).setUint16(138, 0x4004, true);
  const clock = new Uint8Array(40); clock.set(le(101, 8)); clock.set(le(1800000000, 8), 32);
  const keys = [holding.capture.address, captureAddress('province', sortKeyOf(holding.p, holding.q), 3, addresses.season, programId), citizen, addresses.season];
  return digest({ v: 1, kind: 'wide-village-rpc-observation', commitment: 'confirmed', single_response: true,
    current: false, authenticated: false, executable: false, source_complete: false, wallet_ownership_verified: false,
    observed_slot: '101', min_slot: '100', program: programId, season: '5', world: pins.world, ruleset_hash: pins.rulesetHash, program_version: 0x4004,
    citizen, p: String(holding.p), q: String(holding.q), site: 3, gen: 1, slot: 2,
    accounts: [hb, pb, cb, sb].map((b, i) => ({ kind: ['holding', 'province', 'citizen', 'season'][i], address: keys[i], owner: programId, executable: false, lamports: '1', data_b64: toBase64(b) })),
    clock: { address: 'SysvarC1ock11111111111111111111111111111111', owner: 'Sysvar1111111111111111111111111111111111111', executable: false, data_b64: toBase64(clock) } });
}
function mutateAccount(j, index, edit) { const b = fromBase64(j.accounts[index].data_b64); edit(b); j.accounts[index].data_b64 = toBase64(b); return digest(j); }
function response(value = fixture(), ok = true) {
  let done = false;
  return { ok, body: { getReader: () => ({ read: async () => { if (done) return { done: true }; done = true; return { done: false, value: utf8(JSON.stringify(value)) }; }, cancel: async () => { done = true; }, releaseLock() {} }) } };
}

// Match app.loadSeason's existing supported-season initialization. The
// production mappings are unchanged; the raw validated Season selects S1.
before(() => {
  const j = fixture(); parseWideLive(j, pins, holding);
  setS1(decodeAccount('Season', fromBase64(j.accounts[3].data_b64), { profile: 2, seasonId: '5' }));
  assert.equal(s1On(), true);
});

test('observed queues use the existing S1 production, workshop, walls, tier and upkeep labels', () => {
  for (const [kind, arg, name] of [[1, 1, BUILDINGS.Wood], [1, 4, BUILDINGS.Horses], [4, 0, BUILDINGS.Walls], [3, 0, L`村の昇格`], [2, 0, L`維持費の変更`]]) {
    const j = mutateAccount(fixture(), 0, b => { b.set(le(1800000060, 8), 600); b[608] = kind; b[609] = arg; });
    const markup = String(renderWideLive(parseWideLive(j, pins, holding)));
    assert.ok(markup.includes(`<li>${name} · `), `queue kind ${kind}, arg ${arg}: ${name}`);
    assert.ok(markup.includes(`${RESOURCES.Horses}: 0.000`));
    assert.doesNotMatch(markup, /kind [0-9], arg/);
  }
});

test('resident Citizen uses the existing public asset identity and rejects inconsistent raw marks', () => {
  const asset = encode(new Uint8Array(32).fill(82));
  const resident = residentCitizen(addresses, asset);
  const residentPins = { ...pins, viewerKind: 'resident', viewerKey: asset, citizen: resident };
  const residentHolding = { ...holding, ownerCitizen: resident };
  const j = fixture(); j.citizen = resident; j.accounts[2].address = resident;
  mutateAccount(j, 0, b => b.set(decode(resident), 72));
  mutateAccount(j, 2, b => { b.fill(0, 64, 96); b.set(decode(asset), 348); b[380] = 1; });
  const observed = parseWideLive(j, residentPins, residentHolding);
  assert.equal(observed.authenticated, false); assert.equal(observed.executable, false);
  for (const edit of [b => b[380] = 0, b => b[64] = 1, b => b[348] ^= 1, b => b.fill(0, 348, 380)]) {
    assert.throws(() => parseWideLive(mutateAccount(structuredClone(j), 2, edit), residentPins, residentHolding));
  }
  assert.throws(() => parseWideLive(j, { ...residentPins, viewerKey }, residentHolding));
  assert.throws(() => parseWideLive(j, { ...residentPins, viewerKind: 'wallet' }, residentHolding));
  const otherAddress = structuredClone(j); otherAddress.accounts[2].address = citizen; digest(otherAddress);
  assert.throws(() => parseWideLive(otherAddress, residentPins, residentHolding));
});

test('observed raw bytes stay separate and retain exact coordinates and amounts', () => {
  const before = structuredClone(holding), result = parseWideLive(fixture(), pins, holding);
  assert.equal(result.observedSlot, 101n); assert.equal(result.executable, false);
  assert.equal(result.economy.stores[0].value, '9007199254740993');
  assert.deepEqual(holding, before);
  assert.match(String(renderWideLive(result)), /RPC observed at slot 101/);
  assert.match(String(renderWideLive(result)), /9007199254740\.993/);
  assert.doesNotMatch(String(renderWideLive(result)), /kind 0, arg/);
});

test('scope, metadata and raw identity corruption fail closed even with a new content digest', () => {
  for (const edit of [j => j.world = '22'.repeat(32), j => j.gen++, j => j.slot = 3, j => j.current = true,
    j => j.observed_slot = '099', j => j.accounts[0].owner = viewerKey, j => j.accounts.reverse(), j => j.clock.owner = viewerKey,
    j => j.snapshot_digest = '00'.repeat(32), j => j.ruleset_hash = '22'.repeat(32)]) {
    const j = fixture(); edit(j); assert.throws(() => parseWideLive(j, pins, holding));
  }
  for (const [index, edit] of [[0, b => b[69]++], [0, b => b[1283] = 3], [1, b => b[296 + 3 * 64 + 4]++],
    [1, b => b[4739] = 0], [2, b => b[178] = 0], [2, b => b[64]++], [3, b => b[104]++], [3, b => b[65]++], [3, b => b[136]++]]) {
    assert.throws(() => parseWideLive(mutateAccount(fixture(), index, edit), pins, holding));
  }
  assert.throws(() => parseWideLive(fixture(), { ...pins, viewerKey: programId }, holding));
  assert.throws(() => parseWideLive(fixture(), pins, { ...holding, generation: 2 }));
  const wrongClock = fixture(), clock = fromBase64(wrongClock.clock.data_b64);
  clock[0]--; wrongClock.clock.data_b64 = toBase64(clock);
  assert.throws(() => parseWideLive(digest(wrongClock), pins, holding));
});

test('explicit fixed-origin read; failure clears observation and never falls back to history', async () => {
  let fail = false, calls = 0;
  const reader = createWideLiveReader({ enabled: true, getSelection: () => ({ pins, holding }), fetchImpl: async (url, options) => {
    calls++; assert.match(url, /^\/h\/wide-live\/village\?/); assert.match(url, /p=9007199254740993/); assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET');
    return response(fixture(), !fail);
  } });
  assert.equal(calls, 0); await reader.refresh(); assert.equal(reader.state.status, 'observed');
  fail = true; await reader.refresh(); assert.deepEqual(reader.state, { status: 'unavailable' });
  assert.doesNotMatch(String(renderWideLive(reader.state)), /RPC observed at slot 101/);
});

test('selection/viewer changes abort and discard late answers; default off makes no request', async () => {
  let selected = { pins, holding }, resolve, signal;
  const reader = createWideLiveReader({ enabled: true, getSelection: () => selected, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); } });
  const pending = reader.refresh(); selected = null; reader.sync(); assert.equal(signal.aborted, true);
  resolve(response()); await pending; assert.equal(reader.state.status, 'idle');
  const disabled = createWideLiveReader({ getSelection: () => ({ pins, holding }), fetchImpl: () => { throw Error('must not fetch'); } });
  await disabled.refresh(); assert.equal(disabled.state.status, 'disabled');
});

test('source change invalidates an already displayed observation', async () => {
  let sourceKey = 'first';
  const reader = createWideLiveReader({ enabled: true, getSelection: () => ({ pins, holding, sourceKey }), fetchImpl: async () => response() });
  await reader.refresh(); assert.equal(reader.state.status, 'observed');
  sourceKey = 'second'; reader.sync(); assert.equal(reader.state.status, 'idle');
});

test('capability requires exact experimental deployment and the configured same origin', () => {
  const config = { herald: 'http://localhost:8787', origin: 'http://localhost:8787', season: { layoutVersion: 2, programVersion: 0x4004, rulesVersion: 12 }, mode: 'play', sample: null };
  assert.equal(wideLiveEnabled(config), true);
  for (const over of [{ herald: undefined }, { origin: '' }, { herald: 'http://localhost:8899' }, { herald: 'https://example.org' }, { mode: 'spectate' }, { sample: {} },
    { season: { ...config.season, programVersion: 4 } }, { season: { ...config.season, programVersion: 0x4005 } }, { season: { ...config.season, rulesVersion: 11 } }, { season: { ...config.season, layoutVersion: 1 } }]) {
    assert.equal(wideLiveEnabled({ ...config, ...over }), false);
  }
});

test('stream stops at byte cap and rejects malformed UTF-8 before JSON parsing', async () => {
  for (const chunks of [[new Uint8Array(32768), new Uint8Array(1), new Uint8Array(100)], [Uint8Array.of(0xff)]]) {
    let reads = 0, cancelled = false, released = false;
    const r = { body: { getReader: () => ({ read: async () => reads < chunks.length ? { value: chunks[reads++], done: false } : { done: true }, cancel: async () => { cancelled = true; }, releaseLock() { released = true; } }) } };
    await assert.rejects(readWideLiveJSON(r)); assert.equal(cancelled, true); assert.equal(released, true);
    if (chunks.length === 3) assert.equal(reads, 2);
  }
  await assert.rejects(readWideLiveJSON({ text: async () => '{}' }));
});
