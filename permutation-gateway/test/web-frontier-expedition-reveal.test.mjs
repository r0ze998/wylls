// The browser's own ExpeditionReveal (web/frontier/fexpedition-reveal.mjs).
// The reveal half comes from a seal made here with FIXED test k/σ (no wallet,
// no network); the wallet is a fixed public test address. Nothing is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { parseMessage } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey, traceWideDirections, encodeWideDirections, packWidePlain }
  from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { canonicalExpeditionAccounts } from '../../permutation-server/web/frontier/fexpedition-identity.mjs';
import { canonicalOutboundRoles } from '../../permutation-server/web/frontier/fexpedition-depart.mjs';
import { withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { sealWideWith } from '../../permutation-server/web/frontier/seal-wide.mjs';
import { QUICKNET } from '../../permutation-server/web/frontier/abi.mjs';
import { buildExpeditionReveal, revealMessage, revealAddresses, REVEAL_WIRE_LEN, RevealBuildError }
  from '../../permutation-server/web/frontier/fexpedition-reveal.mjs';

const PROGRAM = encode(new Uint8Array(32).fill(0x45));
const SEASON = encode(new Uint8Array(32).fill(0x34));
const WALLET = encode(new Uint8Array(32).fill(0x07));
const WORLD = worldIdOf(SEASON, PROGRAM);
const HOST = canonicalOriginalHostRef({ world: WORLD, p: '128', q: '0', site: 1, gen: 2, seq: 0 });
const HOLDING = withSeed(SEASON, seedOf('Holding', { p: 128, q: 0, site: 1 }), PROGRAM);
const DEST = canonicalWideProvinceKey({ world: WORLD, p: '129', q: '0' });
const hex = b => Buffer.from(b).toString('hex');

// a one-step route from a tile of (128, 0) into (129, 0)
const route = (() => {
  for (let tile = 0; tile < 61; tile++) for (let d = 0; d < 6; d++) {
    const t = traceWideDirections({ world: WORLD, origin: { p: '128', q: '0', tile }, directions: [d] });
    if (t.endpoint.key === DEST) return { tile, d, destTile: t.endpoint.tile };
  }
  throw new Error('no step into (129, 0)');
})();
const ARRIVE = 15;
const typedPlain = (over = {}) => ({ version: 2, host: HOST, arriveBell: ARRIVE, dest: DEST, destTile: route.destTile,
  stance: 1, retreatBps: 0, ...encodeWideDirections([route.d]), reserved: '00'.repeat(8), ...over });
const sealed = sealWideWith({ plain: typedPlain(), round: 30913812, publicKey: QUICKNET.publicKey,
  k: new Uint8Array(16).fill(0x11), sigma: new Uint8Array(16).fill(0x22) });
const transit = (over = {}) => ({ slot: 0, faction: 0, host: HOST, arriveBell: ARRIVE, sealRoot: hex(sealed.sealRoot),
  origin: { p: 128, q: 0, tile: route.tile }, ...over });
const build = (over = {}) => buildExpeditionReveal({ program: PROGRAM, season: SEASON, wallet: WALLET, holding: HOLDING,
  transit: transit(), destRegion: 5, targetI: 0, reveal: sealed.reveal, ctHash: sealed.ctHash, ...over });
const code = (want, fn) => assert.throws(fn, e => e.code === want);

test('the wire bytes are the version-2 wrapper of ExpeditionReveal', () => {
  const ix = build();
  const d = ix.data;
  assert.equal(d.length, REVEAL_WIRE_LEN);
  assert.deepEqual([...d.slice(0, 8)], [0xee, 0xff, 2, 2, 0xee, 0xff, 1, 1], 'dispatch head (Kind::Reveal) then the envelope (OP 1)');
  assert.deepEqual([d[8], d[9]], [0, 0], 'transit slot, target slot');
  assert.equal(hex(d.slice(10, 146)), hex(packWidePlain(typedPlain())));
  assert.equal(hex(d.slice(146, 178)), hex(sealed.reveal.salt));
  assert.equal(hex(d.slice(178, 210)), hex(sealed.ctHash));
  assert.equal(encode(d.slice(210, 242)), WALLET, 'beneficiary');
  assert.equal(ix.programId, PROGRAM);
  assert.ok(!JSON.stringify(ix).includes(hex(sealed.reveal.salt)), 'JSON never carries the reveal');
});

test('the accounts are the exact16 + path shape with the program\'s privileges', () => {
  const ix = build();
  const names = ix.keys.map(k => k.name);
  assert.deepEqual(names.slice(0, 16), ['fee_payer', 'season', 'holding', 'transit', 'anchor', 'archive', 'beaconlog', 'inputs',
    'dest_province', 'arrivalday', 'slot', 'slot', 'slot', 'slot', 'ix_sysvar', 'system']);
  assert.ok(names.length - 16 <= 3, 'at most three path provinces');
  const w = ix.keys.filter(k => k.isWritable).map(k => k.name);
  assert.deepEqual(w, ['fee_payer', 'arrivalday', 'slot'], 'the payer, the day and the TARGET slot only');
  assert.deepEqual(ix.keys.filter(k => k.isSigner).map(k => k.pubkey), [WALLET]);
  // the target slot moves with targetI
  const t2 = build({ targetI: 2 });
  assert.deepEqual(t2.keys.slice(10, 14).map(k => k.isWritable), [false, false, true, false]);
  assert.equal(t2.data[9], 2);
  // path provinces are the route's other provinces (here the origin (128, 0), original family)
  const path = ix.keys.slice(16).map(k => k.pubkey);
  const t = traceWideDirections({ world: WORLD, origin: { p: '128', q: '0', tile: route.tile }, directions: [route.d] });
  assert.equal(path.length, t.accountKeys.length - 1);
  if (path.length) assert.equal(path[0], withSeed(SEASON, seedOf('Province', { p: 128, q: 0 }), PROGRAM));
});

test('addresses agree with the existing JS derivations', () => {
  const a = revealAddresses({ program: PROGRAM, season: SEASON, holding: HOLDING, transitSlot: 0, faction: 0, arriveBell: ARRIVE, destKey: DEST, destRegion: 5 });
  // the wide Province (wp) as fexpedition-identity derives the wide standing
  const citizen = withSeed(SEASON, seedOf('Citizen', { wallet: WALLET }), PROGRAM);
  const id = canonicalExpeditionAccounts({ program: PROGRAM, season: SEASON, original_owner: citizen, host: HOST, wallet: WALLET, standing: { p: '129', q: '0' } });
  assert.equal(a.destProvince, id.accounts.wide_standing);
  // the transit (wm) as the Depart roles derive it
  const roles = canonicalOutboundRoles({ program: PROGRAM, season: SEASON, wallet: WALLET, payer: WALLET, original_owner: citizen, host: HOST,
    origin: { p: '128', q: '0' } }, { transitSlot: 0 });
  assert.equal(a.transit, roles.find(r => r.name === 'transit').address);
  // the beacon accounts are the legacy with-seed kinds of the destination's region
  assert.equal(a.anchor, withSeed(SEASON, seedOf('BellAnchor', { bell: ARRIVE, region: 5 }), PROGRAM));
  assert.equal(a.archive, withSeed(SEASON, seedOf('AnchorArchive', { region: 5, part: 0 }), PROGRAM));
  assert.equal(a.beaconLog, withSeed(SEASON, seedOf('BeaconLog', { region: 5 }), PROGRAM));
  assert.equal(new Set([a.inputs, a.arrivalDay, ...a.slots]).size, 6, 'distinct wide arrival addresses');
});

test('the unsigned message: three budget instructions then the reveal, the wallet alone signs', () => {
  const ix = build();
  const m = revealMessage({ instruction: ix, wallet: WALLET, recentBlockhash: encode(new Uint8Array(32).fill(9)), cuLimit: 400_000, loadedLimit: 1_867_776 });
  const p = parseMessage(m);
  assert.deepEqual(p.signers, [WALLET]);
  assert.equal(p.instructions.length, 4);
  assert.equal(p.instructions[3].programId, PROGRAM);
  assert.equal(hex(p.instructions[3].data), hex(ix.data));
  assert.ok(m.length + 65 <= 1232, `fits the packet (${m.length + 65} B)`);
  code('FeePayer', () => revealMessage({ instruction: ix, wallet: encode(new Uint8Array(32).fill(8)), recentBlockhash: encode(new Uint8Array(32).fill(9)), cuLimit: 1, loadedLimit: 1 }));
});

test('a reveal that cannot match is never built', () => {
  const wrongSalt = { plain: sealed.reveal.plain, salt: new Uint8Array(32).fill(1) };
  code('SealRootMismatch', () => build({ reveal: wrongSalt }));
  code('SealRootMismatch', () => build({ ctHash: new Uint8Array(32) }));
  code('SealRootMismatch', () => build({ transit: transit({ sealRoot: '00'.repeat(32) }) }));
  code('HostMismatch', () => build({ transit: transit({ host: canonicalOriginalHostRef({ world: WORLD, p: '128', q: '0', site: 1, gen: 2, seq: 1 }) }) }));
  code('ArriveMismatch', () => build({ transit: transit({ arriveBell: ARRIVE + 1 }) }));
  code('TargetSlot', () => build({ targetI: 4 }));
  code('Region', () => build({ destRegion: 16 }));
  code('PlainLength', () => build({ reveal: { plain: sealed.reveal.plain.slice(1), salt: sealed.reveal.salt } }));
  // a route that does not end at the committed destination
  assert.throws(() => build({ transit: transit({ origin: { p: 128, q: 0, tile: (route.tile + 30) % 61 } }) }));
  assert.ok(new RevealBuildError('x') instanceof Error);
});

// Local SBF needs this heap, but generic callers above keep their previous wire shape.
test('local SBF message has fixed heap after its limits and still fits a signed packet', () => {
  const args = { instruction: build(), wallet: WALLET, recentBlockhash: encode(new Uint8Array(32).fill(9)), cuLimit: 1_400_000, loadedLimit: 64 * 1024 * 1024, heapFrame: 256 * 1024 };
  const m = revealMessage(args), p = parseMessage(m);
  assert.equal(p.instructions.length, 5);
  assert.equal(p.instructions[3].programId, 'ComputeBudget111111111111111111111111111111');
  assert.deepEqual([...p.instructions[3].data], [1, 0, 0, 4, 0]);
  assert.equal(p.instructions[4].programId, PROGRAM);
  assert.ok(m.length + 65 <= 1232);
  for (const heapFrame of [0, 32768, 262145, '262144', NaN]) code('HeapFrame', () => revealMessage({ ...args, heapFrame }));
});
