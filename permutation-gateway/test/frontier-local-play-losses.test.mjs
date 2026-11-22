// The S1 losses as TEST-ONLY local acts of a COEXIST world (fix-9-10-followups): SeizeVault (0xB4), RaidDomestic (0xBE)
// and RaidCaravan (0xB3), so that ⑨/⑩'s "the captor takes all" and "goods on the road are the carrier's, lost if it is
// beaten" can happen in a local `--coexist --two` world — the program already has all three (caravan.rs); only the lane's
// list lacked them. The one builder the page and the relay share (permutation-server/web/frontier/flocalplay-rights.mjs),
// pinned BY HAND from frontier-abi/src/v2/ix.rs (SeizeVault/RaidDomestic/RaidCaravan) and the generated ABI table
// (abi-v2-tags.mjs, flags included); the page's offers (screens/s1.mjs domesticRaidOffers), the ② card's delivery of a
// caravan the viewer took, and the ⑩ card's road and seizure lines on real account shapes (screens/custody.mjs).
// No key (plain addresses), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode as b58d } from '../client/src/base58.mjs';
import { localActIntent, localActMessage, coexistPins, LocalActError } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM } from '../src/frontier/local-play-relay.mjs';
import * as C from '../../permutation-server/web/frontier/flocalplay-custody.mjs';
import * as R from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import * as PA from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { custodyModel } from '../../permutation-server/web/frontier/screens/custody.mjs';
import { rightsModel } from '../../permutation-server/web/frontier/screens/rights.mjs';
import { domesticRaidOffers, s1TileModel, renderS1Tile, caravanId, RAID_NONE, RAID_DECIDE_BELLS } from '../../permutation-server/web/frontier/screens/s1.mjs';
import { COEXIST_LANE, PLAIN_LANE } from '../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { seasonAddresses, seasonPda, citizenTag, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { TAGS as TAGS_V2 } from '../../permutation-server/web/sdk/frontier/abi-v2-tags.mjs';
import { parseTransaction } from '../client/src/solana-tx.mjs';
import { LOSS_INTENTS, TAKE_INTENT } from './fixtures/loss-intents.mjs';

const w = n => encode(new Uint8Array(32).fill(n));
const WALLET = w(1), WALLET_B = w(2);
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const ME = A.of('Citizen', { wallet: WALLET }), YOU = A.of('Citizen', { wallet: WALLET_B });
const TAG = citizenTag(ME).toString(), YOU_TAG = citizenTag(YOU).toString();
const COEX = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: WALLET, rulesetHash: COEXIST_LANE.rulesetHash };
const PLAIN = { ...COEX, rulesetHash: PLAIN_LANE.rulesetHash };
const F = { p: 3, q: -2, site: 4 }, V = { p: 3, q: -2, tile: 22 };
const INTENTS = LOSS_INTENTS({ F, V, owner: YOU, ownerTag: YOU_TAG });
const TAKE = TAKE_INTENT({ F, ownerTag: YOU_TAG });
const messageOf = (intent, p = COEX) => localActMessage(localActIntent(intent, { wallet: p.wallet, coexist: coexistPins(p) }), p, HASH).message;
const txOf = message => {
  const t = parseTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)]));
  const h = t.header, n = t.accountKeys.length;
  return { ...t, isSigner: i => i < h.numRequiredSignatures,
    isWritable: i => (i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < n - h.numReadonlyUnsignedAccounts) };
};
const lastIx = intent => { const t = txOf(messageOf(intent)); return { t, ix: t.instructions[t.instructions.length - 1] }; };
const hex = intent => Buffer.from(lastIx(intent).ix.data).toString('hex');
const refused = (f, code) => assert.throws(f, e => e instanceof LocalActError && e.code === code, code);
const caravanAt = (tag, seq) => A.of('Caravan', { ownerTag: BigInt(tag), seq });

test('the instruction data are v2 ix.rs\'s SeizeVault / RaidDomestic / RaidCaravan, byte for byte (pinned by hand)', () => {
  // SeizeVault { entry u8 }
  assert.equal(hex(INTENTS.SeizeVault), 'b4' + '05');
  // RaidDomestic { bell u32, entry u8 }
  assert.equal(hex(INTENTS.RaidDomestic), 'be' + '2c010000' + '05');
  // RaidCaravan { p i16, q i16, choice u8, n_path u8, dst_kind u8, dst_p i16, dst_q i16, dst_at u8, dst_gen u8, steps u8, path [u8; 12] }
  assert.equal(hex(INTENTS.RaidCaravan), 'b3' + '0300' + 'feff' + '01' + '01' + '00' + '0000' + '0000' + '00' + '00' + '00' + '00'.repeat(12));
  assert.equal(hex(TAKE), 'b3' + '0300' + 'feff' + '00' + '01' + '01' + '0300' + 'feff' + '04' + '00' + '02' + '09' + '00'.repeat(11));
  for (const [name, i] of [['SeizeVault', INTENTS.SeizeVault], ['RaidDomestic', INTENTS.RaidDomestic], ['RaidCaravan', INTENTS.RaidCaravan], ['RaidCaravan', TAKE]]) {
    const row = TAGS_V2.instructions.find(x => x.name === name);
    const len = Buffer.from(lastIx(i).ix.data).length;
    assert.ok(len >= row.data_len[0] && len <= row.data_len[1], `${name} data length ${len}`);
  }
});

test('the account lists are the generated ABI table\'s, flags included; the wallet is actor AND payer, the only signature', () => {
  const S = SEASON, W_ = WALLET;
  const check = (intent, want) => {
    const { t, ix } = lastIx(intent);
    assert.deepEqual(ix.keys.map(k => k.pubkey), want.map(x => x[0]), intent.name);
    const row = TAGS_V2.instructions.find(x => x.name === intent.name);
    const metas = row.account_groups.flatMap(g => Array.from({ length: Math.max(1, Math.min(g.max, want.length)) }, () => g.accounts).flat());
    want.forEach(([key, name], i) => {
      const meta = metas.find(m => m.name === name);
      assert.ok(meta, `${intent.name}: ${name}`);
      const at = t.accountKeys.indexOf(key);
      if (meta.signer) assert.ok(t.isSigner(at), `${intent.name}: ${name} signs`);
      if (meta.writable === 'w') assert.ok(t.isWritable(at), `${intent.name}: ${name} writable`);
    });
    assert.deepEqual(t.signers, [WALLET]);
  };
  check(INTENTS.SeizeVault, [[W_, 'actor'], [W_, 'payer'], [S, 'season'], [ME, 'citizen'], [A.of('Vault', V), 'vault'], [A.of('Province', V), 'province'], [A.of('Holding', F), 'host_holding'], [YOU, 'owner_citizen']]);
  check(INTENTS.RaidDomestic, [[W_, 'actor'], [W_, 'payer'], [S, 'season'], [ME, 'citizen'], [caravanAt(YOU_TAG, 2), 'caravan'], [A.of('Province', F), 'province'], [A.of('Holding', F), 'host_holding'], [YOU, 'owner_citizen']]);
  // (the caravan is read-only in RaidDomestic: the raid opens on the Province's slot)
  const rd = lastIx(INTENTS.RaidDomestic);
  assert.ok(!rd.t.isWritable(rd.t.accountKeys.indexOf(caravanAt(YOU_TAG, 2))));
  // a burn names the raid's Province alone and the raider's village as `dst` (fplay.mjs accountsFor)
  check(INTENTS.RaidCaravan, [[W_, 'actor'], [W_, 'payer'], [S, 'season'], [ME, 'citizen'], [caravanAt(YOU_TAG, 2), 'caravan'], [A.of('Holding', F), 'raider_holding'], [A.of('Holding', F), 'dst'], [A.of('Province', F), 'path_province']]);
  // a take: the raid's Province first, the new walk's others, then the old route's others (here all one)
  const take = lastIx(TAKE).ix.keys.map(k => k.pubkey);
  assert.deepEqual(take.slice(4), [caravanAt(YOU_TAG, 2), A.of('Holding', F), A.of('Holding', F), A.of('Province', F)]);
  const far = TAKE_INTENT({ F, ownerTag: YOU_TAG, oldRoute: [{ p: 3, q: -2 }, { p: 4, q: -2 }] });
  assert.deepEqual(lastIx(far).ix.keys.map(k => k.pubkey).slice(7), [A.of('Province', F), A.of('Province', { p: 4, q: -2 })]);
  // the compute budget is the game's own for each (abi-v2-budgets cu_limit_s1), with the local loaded-data limit
  for (const i of [INTENTS.SeizeVault, INTENTS.RaidDomestic, INTENTS.RaidCaravan]) {
    const t = txOf(messageOf(i));
    assert.equal(t.instructions.length, 4, i.name);
    assert.equal(Buffer.from(t.instructions[2].data).readUInt32LE(1), 67108864, i.name);
  }
});

test('plain worlds refuse them; a coexist intent is not built under plain pins; the page lane routes them only in the coexist lane', () => {
  for (const name of R.COEXIST_LOSS_ACTS) {
    assert.ok(R.COEXIST_ACTS.includes(name), name);
    refused(() => localActIntent(INTENTS[name], { wallet: WALLET }), 'LocalActNotAllowed');
    const intent = localActIntent(INTENTS[name], { wallet: WALLET, coexist: true });
    refused(() => localActMessage(intent, PLAIN, HASH), 'LocalActNotAllowed');
    assert.equal(PA.localOrderRoute({ localPlay: { address: WALLET }, name, v: {}, signer: undefined, requester: null }), 'refuse', name);
    assert.equal(PA.localOrderRoute({ localPlay: { address: WALLET }, name, v: {}, signer: undefined, requester: null, names: PA.COEXIST_LOCAL_LANE.names }), 'local-act', name);
  }
});

test('the page\'s orders (controller.mjs s1Seize / s1RaidOpen / s1Raid) build the relay\'s bytes; a signature is not carried to another caravan, tile or choice', () => {
  const id = { address: WALLET, programId: LOCAL_PLAY_PROGRAM, seasonAddress: SEASON };
  const page = (name, v, fields) => Buffer.from(PA.localActMessage(PA.localActIntentOf(name, v, fields, WALLET), id, COEXIST_LANE.rulesetHash, HASH, PA.COEXIST_LOCAL_LANE));
  // s1Seize: v {at, hostHolding (with gen), ownerCitizen, province}
  assert.deepEqual(page('SeizeVault', { at: V, hostHolding: { ...F, gen: 0 }, ownerCitizen: YOU, province: V }, { entry: 5 }), Buffer.from(messageOf(INTENTS.SeizeVault)));
  // s1RaidOpen: v {caravanRef, province, hostHolding, ownerCitizen}
  assert.deepEqual(page('RaidDomestic', { caravanRef: { ownerTag: YOU_TAG, seq: 2 }, province: { p: 3, q: -2 }, hostHolding: { ...F, gen: 0 }, ownerCitizen: YOU }, { bell: 300, entry: 5 }),
    Buffer.from(messageOf(INTENTS.RaidDomestic)));
  // s1Raid (burn): v {caravan: the devnet page's address, caravanRef, raider, raid, dst: null}; path a Uint8Array
  const burnFields = { p: 3, q: -2, choice: 1, n_path: 1, dst_kind: 0, dst_p: 0, dst_q: 0, dst_at: 0, dst_gen: 0, steps: 0, path: new Uint8Array(12) };
  assert.deepEqual(page('RaidCaravan', { caravan: caravanAt(YOU_TAG, 2), caravanRef: { ownerTag: YOU_TAG, seq: 2 }, raider: { ...F, gen: 0 }, raid: { p: 3, q: -2 }, dst: null }, burnFields),
    Buffer.from(messageOf(INTENTS.RaidCaravan)));
  // s1Raid (take): plan.provinces as the road planner returns them
  const takeFields = { ...TAKE.fields, path: Uint8Array.from(TAKE.fields.path) };
  assert.deepEqual(page('RaidCaravan', { caravan: caravanAt(YOU_TAG, 2), caravanRef: { ownerTag: YOU_TAG, seq: 2 }, raider: { ...F, gen: 0 }, raid: { p: 3, q: -2 }, dst: { kind: 'holding', ...F, gen: 0 }, pathProvinces: [{ p: 3, q: -2, n: 1 }], oldRoute: [{ p: 3, q: -2 }] }, takeFields),
    Buffer.from(messageOf(TAKE)));
  // the same message is not another caravan's, tile's or choice's
  const m = Buffer.from(messageOf(INTENTS.RaidDomestic));
  for (const over of [{ subject: { ...INTENTS.RaidDomestic.subject, caravan: { owner_tag: YOU_TAG, seq: 3 } } }, { fields: { bell: 301, entry: 5 } }, { subject: { ...INTENTS.RaidDomestic.subject, ownerCitizen: ME } }]) {
    assert.notDeepEqual(Buffer.from(messageOf({ ...INTENTS.RaidDomestic, ...over })), m);
  }
  assert.notDeepEqual(Buffer.from(messageOf({ ...INTENTS.SeizeVault, subject: { ...INTENTS.SeizeVault.subject, at: { ...V, tile: 23 } } })), Buffer.from(messageOf(INTENTS.SeizeVault)));
  assert.notDeepEqual(Buffer.from(messageOf(TAKE)), Buffer.from(messageOf(INTENTS.RaidCaravan)));
});

test('the intent shapes are closed: a burn names no destination, a take its own walk, entries within the roster, no wide place', () => {
  const bad = (i, over) => refused(() => localActIntent({ ...i, ...over }, { wallet: WALLET, coexist: true }), 'LocalActInvalid');
  bad(INTENTS.SeizeVault, { fields: { entry: 56 } });
  bad(INTENTS.SeizeVault, { subject: { ...INTENTS.SeizeVault.subject, ownerCitizen: 'nope' } });
  bad(INTENTS.SeizeVault, { subject: { ...INTENTS.SeizeVault.subject, extra: 1 } });
  bad(INTENTS.RaidDomestic, { fields: { bell: -1, entry: 5 } });
  bad(INTENTS.RaidDomestic, { subject: { ...INTENTS.RaidDomestic.subject, caravan: { owner_tag: 7, seq: 2 } } });
  bad(INTENTS.RaidCaravan, { subject: { ...INTENTS.RaidCaravan.subject, dst: { kind: 'holding', ...F, gen: 0 } } });
  bad(INTENTS.RaidCaravan, { fields: { ...INTENTS.RaidCaravan.fields, steps: 1 } });
  bad(INTENTS.RaidCaravan, { fields: { ...INTENTS.RaidCaravan.fields, choice: 2 } });
  bad(INTENTS.RaidCaravan, { fields: { ...INTENTS.RaidCaravan.fields, p: 4 } });
  bad(TAKE, { fields: { ...TAKE.fields, n_path: 2 } });
  bad(TAKE, { fields: { ...TAKE.fields, dst_at: 5 } });
  bad(TAKE, { fields: { ...TAKE.fields, steps: 0 } });
  refused(() => localActIntent({ ...INTENTS.SeizeVault, subject: { ...INTENTS.SeizeVault.subject, at: { p: 200, q: 0, tile: 3 } } }, { wallet: WALLET, coexist: true }), 'LocalActWideHolding');
});

test('SettleCaravan of a caravan the viewer took: its sender\'s seed (owner_tag) and rent recipient (rent_to, the account\'s RENT_TO); without them, the viewer\'s own', () => {
  const base = { name: 'SettleCaravan', subject: { seq: 2, dst: { kind: 'holding', ...F, gen: 0 }, provinces: [{ p: 3, q: -2 }] }, fields: {} };
  const tookSubject = { ...base.subject, owner_tag: YOU_TAG, rent_to: WALLET_B };
  const own = lastIx(base).ix.keys.map(k => k.pubkey), took = lastIx({ ...base, subject: tookSubject }).ix.keys.map(k => k.pubkey);
  // [fee_payer, season, caravan, dst, beneficiary, rent_to, path_province…] (caravan.rs settle_caravan; RENT_TO checked)
  assert.equal(own[2], caravanAt(TAG, 2)); assert.equal(own[5], WALLET);
  assert.equal(took[2], caravanAt(YOU_TAG, 2)); assert.equal(took[4], WALLET); assert.equal(took[5], WALLET_B);
  // the two go together: a seed without its rent recipient (or the reverse) is refused
  refused(() => localActIntent({ ...base, subject: { ...base.subject, owner_tag: YOU_TAG } }, { wallet: WALLET, coexist: true }), 'LocalActInvalid');
  refused(() => localActIntent({ ...base, subject: { ...base.subject, rent_to: WALLET_B } }, { wallet: WALLET, coexist: true }), 'LocalActInvalid');
  refused(() => localActIntent({ ...base, subject: { ...tookSubject, owner_tag: 5 } }, { wallet: WALLET, coexist: true }), 'LocalActInvalid');
  refused(() => localActIntent({ ...base, subject: { ...tookSubject, rent_to: 'nope' } }, { wallet: WALLET, coexist: true }), 'LocalActInvalid');
  // the page's order (controller.mjs rightsDeliver: v.ownerTag, v.rentTo from the account)
  const id = { address: WALLET, programId: LOCAL_PLAY_PROGRAM, seasonAddress: SEASON };
  const page = Buffer.from(PA.localActMessage(PA.localActIntentOf('SettleCaravan', { ...base.subject, ownerTag: YOU_TAG, rentTo: WALLET_B }, {}, WALLET), id, COEXIST_LANE.rulesetHash, HASH, PA.COEXIST_LOCAL_LANE));
  assert.deepEqual(page, Buffer.from(messageOf({ ...base, subject: tookSubject })));
  // the account's RENT_TO is read where the v2 layout keeps it (s1 Caravan @264)
  const b = Buffer.alloc(320); b.write('PSF1CRVN', 0); Buffer.from(b58d(WALLET_B)).copy(b, 264);
  assert.equal(C.decodeCaravan(new Uint8Array(b)).rentTo, WALLET_B);
});

// ---- the page: stopping a caravan of the viewer's own nation (screens/s1.mjs domesticRaidOffers)
// (the page keeps a village's owner as its bytes — herald `me`)
const HOME = { p: 3, q: -2, site: 4, gen: 0, tile: 14, ownerCitizen: b58d(ME), order: 1, state: 2, tier: 1, faction: 1, reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [],
  stores: Array.from({ length: 8 }, () => ({ value: 0n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n })) };
const host = (seq, tile, fromBell, holding = HOME) => ({ id: hostId({ ...holding, seq }), state: 1, tile, fromBell, faction: 1, unit: 0 });
function fs({ nowBell = 105, resolvedNext = 104, entries = [host(1, 30, 100)], slot = {}, caravan = {}, on = true } = {}) {
  const c = { ownerTag: YOU_TAG, seq: 2, faction: 1, arriveTs: 0, dst: { kind: 2, p: 3, q: -2, at: 22, gen: 0 }, provinces: [[3, -2]], cargo: [0, 0, 0, 40, 0, 0, 0, 0], raided: false, ...caravan };
  const s = { id: caravanId(c.ownerTag, c.seq), faction: 1, n: 3, raidOff: RAID_NONE, raidPos: 0, firstBell: 101, tiles: [12, 30, 21, 0, 0, 0, 0, 0], raider: 0n, ...slot };
  return { nowBell, citizen: { faction: 1 }, holdings: [HOME], s1: { caravans: { moving: [c], vaults: [] } }, custody: on ? { on: true } : undefined,
    provinces: new Map([['3,-2', { province: { p: 3, q: -2, resolvedNext, entries, caravans: [s], sites: [], siteCount: 0, passableMask: (1n << 61n) - 1n } }]]) };
}

test('a caravan of the viewer\'s nation that stood where the viewer\'s host stood, at a resolved turn within the window, may be stopped', () => {
  const offers = domesticRaidOffers(fs());
  assert.equal(offers.length, 1);
  assert.deepEqual({ ...offers[0], caravan: undefined }, { p: 3, q: -2, tile: 30, slot: 0, bell: 102, entry: 0, hostHolding: { p: 3, q: -2, site: 4, gen: 0 }, caravan: undefined });
  // the tile panel offers the press there, and only there
  assert.equal(s1TileModel(fs(), { p: 3, q: -2, idx: 30 }).stops.length, 1);
  assert.equal(s1TileModel(fs(), { p: 3, q: -2, idx: 12 }).stops.length, 0);
  assert.match(String(renderS1Tile(fs(), { p: 3, q: -2, idx: 30 })), /data-act="s1-raid-open"/);
  // not the coexist lane (no custody card): nothing
  assert.deepEqual(domesticRaidOffers(fs({ on: false })), []);
  // the viewer's own caravan, or one it took (holder), is not its to stop
  assert.deepEqual(domesticRaidOffers(fs({ caravan: { ownerTag: TAG } })), []);
  assert.deepEqual(domesticRaidOffers(fs({ caravan: { holderTag: TAG, raided: true } })), []);
  // another nation's caravan is the clash's (raidOffers after a resolve), not this order's
  assert.deepEqual(domesticRaidOffers(fs({ slot: { faction: 2 } })), []);
  // a raid already opened there
  assert.deepEqual(domesticRaidOffers(fs({ slot: { raidOff: 1 } })), []);
  // the turn not resolved yet; the host formed up after that turn; the window past
  assert.deepEqual(domesticRaidOffers(fs({ resolvedNext: 102 })), []);
  assert.deepEqual(domesticRaidOffers(fs({ entries: [host(1, 30, 103)] })), []);
  assert.deepEqual(domesticRaidOffers(fs({ nowBell: 102 + RAID_DECIDE_BELLS + 1 })), []);
  // a host of another player on the tile is not the viewer's
  assert.deepEqual(domesticRaidOffers(fs({ entries: [host(1, 30, 100, { p: 3, q: -2, site: 7, gen: 0 })] })), []);
  // the latest turn the host may name is offered (more of the window left)
  const two = domesticRaidOffers(fs({ entries: [host(1, 12, 90), host(2, 21, 90)], resolvedNext: 106, nowBell: 106 }));
  assert.equal(two.length, 1); assert.equal(two[0].bell, 103); assert.equal(two[0].tile, 21); assert.equal(two[0].entry, 1);
});

// ---- the ⑩ card on the account shapes a loss leaves (screens/custody.mjs)
const NOW = 10_000;
const VAULT_YOU = { p: 3, q: -2, tile: 22, gen: 0, ownerTag: YOU_TAG, ownerCitizen: YOU, faction: 1 };
const lotBytes = ({ vault, owner, state = 1, held = 0, forfeited = 0, inbound = [] }) => {
  const b = Buffer.alloc(576);
  b.write('PSF1CLOT', 0); b.writeInt16LE(vault.p, 64); b.writeInt16LE(vault.q, 66); b[68] = vault.tile; b[69] = vault.gen; b[70] = 3; b[71] = state;
  Buffer.from(b58d(owner)).copy(b, 72); b.writeBigUInt64LE(citizenTag(owner), 104); b.writeBigUInt64LE(BigInt(vault.ownerTag), 112); b.writeBigInt64LE(50000n, 120); b.writeBigInt64LE(BigInt(held), 128); b.writeBigInt64LE(BigInt(forfeited), 160);
  inbound.forEach((x, i) => { const at = 432 + i * 24; b.writeBigUInt64LE(BigInt(x.tag), at); b.writeUInt32LE(x.seq, at + 8); b[at + 12] = 1; b.writeBigInt64LE(BigInt(x.qty), at + 16); });
  Buffer.from(b58d(WALLET_B)).copy(b, 528);
  return new Uint8Array(b);
};
// (v2 s1 Caravan; `dst` a vault or — after a take — the raider's village; `cargo` milli-units by resource)
const caravanBytes = ({ owner, seq, custody = 1, dst, arriveTs, cargo = [0, 0, 0, 40000, 0, 0, 0, 0], takenBy = 0n }) => {
  const b = Buffer.alloc(320);
  b.write('PSF1CRVN', 0); Buffer.from(b58d(owner)).copy(b, 64); b.writeBigUInt64LE(citizenTag(owner), 96); b.writeUInt32LE(seq, 104); b[109] = 1; b[111] = 1;
  b[128] = dst.kind === 'holding' ? 1 : 2; b.writeInt16LE(dst.p, 129); b.writeInt16LE(dst.q, 131); b[133] = dst.kind === 'holding' ? dst.site : dst.tile; b[134] = dst.gen;
  b.writeInt16LE(3, 156); b.writeInt16LE(-2, 158);
  b.writeBigInt64LE(BigInt(arriveTs), 180); cargo.forEach((n, i) => b.writeBigInt64LE(BigInt(n), 192 + i * 8));
  b[296] = custody; b[297] = 3; b.writeBigUInt64LE(citizenTag(owner), 304); b.writeBigUInt64LE(BigInt(takenBy), 312);
  return C.decodeCaravan(new Uint8Array(b));
};
function world({ lots = [], caravans = [], gone = [], vaults = [VAULT_YOU] } = {}) {
  return { chain: { now: () => NOW }, clock: {}, provinces: new Map(), holdings: [], s1: { caravans: { vaults, moving: [] } },
    custody: { on: true, viewer: ME, myTag: TAG, read: 'ok', holdings: [], vaults, told: new Set(), custodySeqs: new Set(), caravansGone: new Set(gone),
      lots: new Map(lots.map((e, i) => [`lot${i}`, e])), pools: new Map(), jobs: new Map(), caravans: new Map(caravans.map((e, i) => [`cv${i}`, e])) } };
}
const myLot = over => ({ vault: VAULT_YOU, owner: ME, lot: C.decodeLot(lotBytes({ vault: VAULT_YOU, owner: ME, ...over })) });

test('the road: a custody caravan TAKEN (its destination now the raider\'s village), closed after the take, or burned — each told once to the depositor', () => {
  const inbound = [{ tag: TAG, seq: 3, qty: 40000 }];
  // the take rewrites DST to the raider's village: the caravan is still this lot's (read for this storehouse)
  const taken = caravanBytes({ owner: ME, seq: 3, custody: C.CV_CUSTODY_TAKEN, dst: { kind: 'holding', p: 3, q: -2, site: 7, gen: 0 }, arriveTs: NOW + 50, takenBy: citizenTag(YOU) });
  const m1 = custodyModel(world({ lots: [myLot({ inbound })], caravans: [{ ...taken, vault: VAULT_YOU }] }));
  assert.equal(m1.myLots[0].inbound[0].lost, true);
  assert.deepEqual(m1.losses.map(x => x.key), ['road:3']); assert.match(m1.losses[0].text(), /40/);
  assert.deepEqual(m1.myLots[0].reconcile.caravans, [`${TAG}_3`]);
  // the raider delivered it (the account is gone) before the depositor's page read it: still lost, reconcilable
  const m2 = custodyModel(world({ lots: [myLot({ inbound })], gone: [3] }));
  assert.equal(m2.myLots[0].inbound[0].lost, true); assert.deepEqual(m2.losses.map(x => x.key), ['road:3']);
  // a caravan not read yet (not in `caravansGone`) is not lost
  assert.equal(custodyModel(world({ lots: [myLot({ inbound })] })).myLots[0].inbound[0].lost, false);
  // burned: the empty caravan goes on, still the depositor's custody caravan
  const burned = caravanBytes({ owner: ME, seq: 3, dst: { kind: 'vault', ...VAULT_YOU }, arriveTs: NOW + 50, cargo: [0, 0, 0, 0, 0, 0, 0, 0] });
  const m3 = custodyModel(world({ lots: [myLot({ inbound })], caravans: [{ ...burned, vault: VAULT_YOU }] }));
  assert.equal(m3.myLots[0].inbound[0].burned, true); assert.equal(m3.myLots[0].inbound[0].lost, false);
  assert.deepEqual(m3.losses.map(x => x.key), ['burn:3']); assert.match(m3.losses[0].text(), /焼き払われ/);
  // an untouched one on the road: nothing told
  const fine = caravanBytes({ owner: ME, seq: 3, dst: { kind: 'vault', ...VAULT_YOU }, arriveTs: NOW + 50 });
  assert.deepEqual(custodyModel(world({ lots: [myLot({ inbound })], caravans: [{ ...fine, vault: VAULT_YOU }] })).losses, []);
});

test('a seizure by the depositor itself (two players): no loss of its own is told, the card says it took the storehouse; the keeper hears of its loss', () => {
  const took = custodyModel(world({ lots: [myLot({ held: 12000 })], vaults: [{ ...VAULT_YOU, gen: 1, ownerCitizen: ME, ownerTag: TAG, faction: 1 }] }));
  assert.equal(took.myLots[0].seized, true); assert.equal(took.myLots[0].tookIt, true);
  assert.deepEqual(took.losses, []);
  // forfeit to itself after ReconcileLot: still no loss
  const forfeit = custodyModel(world({ lots: [myLot({ state: C.LOT_FORFEITED, forfeited: 12000 })], vaults: [{ ...VAULT_YOU, gen: 1, ownerCitizen: ME, ownerTag: TAG, faction: 1 }] }));
  assert.deepEqual(forfeit.losses, []);
  // by a third: told as before
  const other = custodyModel(world({ lots: [myLot({ held: 12000 })], vaults: [{ ...VAULT_YOU, gen: 1, ownerCitizen: w(9), ownerTag: '9', faction: 2 }] }));
  assert.equal(other.myLots[0].tookIt, false); assert.equal(other.losses.length, 1);
  // the keeper (viewer YOU) whose storehouse the depositor took
  const keeperFs = world({ lots: [{ vault: VAULT_YOU, owner: ME, lot: C.decodeLot(lotBytes({ vault: VAULT_YOU, owner: ME, held: 12000 })) }], vaults: [{ ...VAULT_YOU, gen: 1, ownerCitizen: ME, ownerTag: TAG }] });
  Object.assign(keeperFs.custody, { viewer: YOU, myTag: YOU_TAG });
  const k = custodyModel(keeperFs);
  assert.equal(k.keptLots.length, 1); assert.equal(k.keptLots[0].seized, true); assert.equal(k.losses.length, 1);
});

test('the ② card offers the raider the delivery of the caravan it took (sender\'s seed), and never the victim\'s own taken caravan', () => {
  const moving = [
    { ownerTag: YOU_TAG, seq: 2, holderTag: TAG, raided: true, arriveTs: NOW - 5, dst: { kind: 1, p: 3, q: -2, at: 4, gen: 0 }, provinces: [[3, -2]], cargo: [0, 0, 0, 40, 0, 0, 0, 0] },
    { ownerTag: TAG, seq: 9, holderTag: YOU_TAG, raided: true, arriveTs: NOW - 5, dst: { kind: 1, p: 3, q: -2, at: 7, gen: 0 }, provinces: [[3, -2]], cargo: [0, 0, 0, 5, 0, 0, 0, 0] },
  ];
  const base = { chain: { now: () => NOW }, provinces: new Map(), holdings: [{ ...HOME }], s1: { caravans: { moving, vaults: [] } }, rights: { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [], rows: null } };
  const d = rightsModel(base, NOW).deliveries;
  assert.equal(d.length, 1); assert.equal(d[0].seq, 2); assert.equal(d[0].ownerTag, YOU_TAG);
});
