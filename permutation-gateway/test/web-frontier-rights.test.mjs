// ② rights on the village screen (TEST-ONLY, a coexist local world only): permutation-server/web/frontier/screens/
// rights.mjs. Its model keeps the FOG RULE (only Grants the viewer is a party to; stations only from the storehouses the
// page already shows in the facility's Province) and draws nothing at all outside a coexist world. No key, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rightsModel, renderRights } from '../../permutation-server/web/frontier/screens/rights.mjs';
import { seasonAddresses, citizenTag } from '../../permutation-server/web/frontier/faddr.mjs';
import { grantAddress, HERALD_GRANTS_SCHEMA } from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import { LOCAL_PLAY_PROGRAM } from '../src/frontier/local-play-relay.mjs';
import { encode } from '../client/src/base58.mjs';

const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const w = n => encode(new Uint8Array(32).fill(n));
const ME = A.of('Citizen', { wallet: w(1) }), YOU = A.of('Citizen', { wallet: w(2) }), THEM = A.of('Citizen', { wallet: w(3) }), OTHER = A.of('Citizen', { wallet: w(4) });
const tag = c => citizenTag(c).toString();
function grantBytes({ issuer, grantee, nonce, swaps = 0, open = 0, state = 1 }) {
  const b = new Uint8Array(272), v = new DataView(b.buffer);
  b.set(Buffer.from('PSF2GRNT'), 0); v.setBigUint64(8, 11n, true); b[18] = 1; b[19] = state; b[22] = 4; b[23] = 22;
  v.setInt16(24, 3, true); v.setInt16(26, -2, true); v.setUint32(28, nonce, true);
  b.set(Buffer.from(Uint8Array.from(require58(issuer))), 32); b.set(Buffer.from(Uint8Array.from(require58(grantee))), 64);
  v.setBigUint64(160, citizenTag(issuer), true); v.setBigInt64(168, 2_000_000_000n, true); v.setUint16(184, 3, true); v.setUint16(186, swaps, true); v.setUint32(188, 30, true); v.setUint32(196, open, true);
  return Buffer.from(b).toString('base64');
}
import { decode as require58 } from '../client/src/base58.mjs';
const row = (issuer, grantee, nonce, extra = {}) => ({ address: grantAddress(A.season, LOCAL_PLAY_PROGRAM, tag(issuer), nonce), issuer_tag: tag(issuer), grantee_tag: tag(grantee), nonce,
  issuer_citizen: null, grantee_citizen: null, account: grantBytes({ issuer, grantee, nonce, ...extra }) });
const FS = (over = {}) => ({
  chain: { now: () => 1_000_000 },
  holdings: [{ p: 3, q: -2, site: 4, production: [0, 0, 0, 0, 4000, 0, 0, 0] }, { p: 9, q: 9, site: 1, production: [] }],
  s1: { caravans: { vaults: [
    { p: 3, q: -2, tile: 22, gen: 0, ownerTag: tag(YOU), ownerCitizen: YOU, faction: 1 },
    { p: 3, q: -2, tile: 30, gen: 0, ownerTag: tag(ME), ownerCitizen: ME, faction: 0 },     // the viewer's own: not a station
    { p: 5, q: 5, tile: 2, gen: 0, ownerTag: tag(THEM), ownerCitizen: THEM, faction: 2 },  // another Province: not offered
    { p: 3, q: -2, tile: 40, gen: 0, ownerTag: tag(THEM), faction: 2 },                    // owner not read yet: not offered
  ] } },
  rights: { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [],
    rows: { schema: HERALD_GRANTS_SCHEMA, grants: [row(ME, YOU, 1), row(YOU, ME, 1, { open: 2 }), row(THEM, OTHER, 7)] } },
  ...over,
});

test('nothing at all outside a coexist world: no `FS.rights.on`, no model, no markup', () => {
  for (const f of [FS({ rights: undefined }), FS({ rights: { on: false, viewer: ME } }), FS({ rights: { on: true } })]) {
    assert.equal(rightsModel(f).on, false); assert.equal(renderRights(f), '');
  }
});

test('FOG: only the viewer\'s Grants are listed; a Grant between two other players is dropped even if the herald sent it', () => {
  const m = rightsModel(FS());
  assert.equal(m.grants.length, 2);
  assert.deepEqual(m.grants.map(g => g.role).sort(), ['grantee', 'issuer']);
  assert.ok(!m.grants.some(g => g.grant.issuerCitizen === THEM));
  const html = String(renderRights(FS()));
  assert.ok(!html.includes(grantAddress(A.season, LOCAL_PLAY_PROGRAM, tag(THEM), 7)));
  // the grantee may execute or release its open reservation; the issuer may revoke
  const asGrantee = m.grants.find(g => g.role === 'grantee'), asIssuer = m.grants.find(g => g.role === 'issuer');
  assert.deepEqual([...asGrantee.can].sort(), ['ExecuteSwap', 'ReleaseSwap']);
  assert.deepEqual([...asIssuer.can], ['RevokeGrant']);
  assert.match(html, /data-act="rights-execute"/); assert.match(html, /data-act="rights-revoke"/);
  // the next nonce is past the viewer's own issued Grants
  assert.equal(m.nextNonce, 2);
});

test('stations: only OTHER players\' storehouses the page already shows, in the facility\'s Province, owner known', () => {
  const m = rightsModel(FS());
  assert.equal(m.facilities.length, 1);   // (the village without workshops is no facility)
  assert.deepEqual(m.facilities[0].stations.map(s => [s.tile, s.granteeCitizen]), [[22, YOU]]);
  const html = String(renderRights(FS()));
  assert.match(html, /data-form="rights-issue"/); assert.match(html, new RegExp(`data-grantee="${YOU}"`));
  // no herald (503): the page's own issued Grants only, said as such
  const f = FS(); f.rights.rows = null; f.rights.read = 'unavailable';
  assert.equal(rightsModel(f).grants.length, 0); assert.match(String(renderRights(f)), /rights-read/);
});

// (rights-play, parent: the play-through's two findings) A CLOSED Grant offers nothing, whatever its last bytes say; the
// viewer's OWN arrived caravans are offered for delivery (local play has no keeper delivering S1 caravans), others' never.
import { rightsIntent, rightsMessage, settleCaravanInstruction, COEXIST_ACTS } from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
test('a closed Grant (herald state, or an account gone from the chain) is drawn closed with no offer', () => {
  const closedRow = { ...row(ME, YOU, 3, { state: 2 }), state: 'closed' };
  const f = FS({ rights: { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [], rows: { schema: HERALD_GRANTS_SCHEMA, grants: [closedRow] } } });
  const g = rightsModel(f).grants.find(x => x.address === closedRow.address);
  assert.equal(g.closed, true); assert.equal(g.can.size, 0);
  const revoked = row(ME, YOU, 4, { state: 2 });
  const f2 = FS({ rights: { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [], gone: new Set([revoked.address]), rows: { schema: HERALD_GRANTS_SCHEMA, grants: [revoked] } } });
  assert.equal(rightsModel(f2).grants[0].can.size, 0);
  const f3 = FS({ rights: { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [], rows: { schema: HERALD_GRANTS_SCHEMA, grants: [revoked] } } });
  assert.deepEqual([...rightsModel(f3).grants[0].can], ['CloseGrant'], 'a revoked Grant still open on the chain may be closed');
  assert.match(renderRights(f).s, /閉じた/);
});
test('deliveries: only the viewer\'s own caravans past their arrival, not raided; both province shapes; SettleCaravan bytes', () => {
  const car = (ownerTag, arriveTs, extra = {}) => ({ ownerTag, seq: 1, arriveTs, raided: false, cargo: [0, 0, 0, 0, 5, 0, 0, 0], dst: { kind: 1, p: 3, q: -2, at: 4, gen: 1 }, provinces: [{ p: 3, q: -2 }], ...extra });
  const f = FS();
  f.s1.caravans.moving = [car(tag(ME), 999_000), car(tag(ME), 1_000_001), car(tag(YOU), 1), car(tag(ME), 5, { raided: true }), car(tag(ME), 6, { seq: 2, provinces: [[3, -2], [4, -2]] })];
  const d = rightsModel(f).deliveries;
  assert.deepEqual(d.map(x => [x.seq, x.provinces]), [[1, [{ p: 3, q: -2 }]], [2, [{ p: 3, q: -2 }, { p: 4, q: -2 }]]]);
  assert.match(renderRights(f).s, /data-act="rights-deliver"/);
  // (fix-loop6, LP6-14: a crossed province read and not settled past the arrival — the press is not offered, the wait is said;
  //  settled past it, or not read at all, the press is offered — the program decides)
  f.clock = { genesisTs: 0 }; f.provinces = new Map([['3,-2', { province: { resolvedNext: 1 } }]]);   // arrival bell of ts 6 / 999_000: 0 / 1665
  f.s1.caravans.moving = [car(tag(ME), 999_000)];
  assert.equal(rightsModel(f).deliveries[0].settled, false);
  let out = renderRights(f).s;
  assert.doesNotMatch(out, /data-act="rights-deliver"/); assert.match(out, /通った州 3,-2 の決着が到着のターン 1,?665 を過ぎるのを待っています/);
  f.provinces.get('3,-2').province.resolvedNext = 1666;
  assert.equal(rightsModel(f).deliveries[0].settled, true); assert.match(renderRights(f).s, /data-act="rights-deliver"/);
  f.provinces = new Map();
  assert.equal(rightsModel(f).deliveries[0].settled, null); assert.match(renderRights(f).s, /data-act="rights-deliver"/);
  // (fix-loop12, LP12-8: the village is named by its TILE, as the caravan form names it — loop-play12 read 「村（-1, 2 · 4）へ」,
  //  the site number, beside the form's 「村（-1, 2 · マス 35）」 for the same village)
  const held = f.holdings;
  f.holdings = [];
  assert.match(renderRights(f).s, /村（3, -2）へ/, 'no record of the site: the province alone, never the bare site number');
  assert.doesNotMatch(renderRights(f).s, /村（3, -2 · 4）/);
  f.provinces = new Map([['3,-2', { province: { resolvedNext: 1666, sites: [0, 1, 2, 3, 35, 5, 6, 7, 8, 9, 10, 11] } }]]);
  assert.match(renderRights(f).s, /村（3, -2 · マス 35）へ/, 'the site\'s tile in the province record');
  f.holdings = [{ p: 3, q: -2, site: 4, gen: 1, tile: 36 }];
  assert.match(renderRights(f).s, /村（3, -2 · マス 36）へ/, 'the viewer\'s own village: its own tile');
  f.holdings = held; f.provinces = new Map();
  assert.ok(COEXIST_ACTS.includes('SettleCaravan'));
  const W = w(1), intent = rightsIntent('SettleCaravan', { seq: 1, dst: { kind: 'holding', p: 3, q: -2, site: 4, gen: 1 }, provinces: [{ p: 3, q: -2 }] }, {});
  const ix = settleCaravanInstruction(intent, { programId: LOCAL_PLAY_PROGRAM, seasonId: '11', wallet: W });
  assert.equal(ix.data[0], 0xb2); assert.deepEqual([...ix.data.subarray(1)], [...require58(W)]);
  assert.deepEqual(ix.keys.map(k => [k.isSigner, k.isWritable]), [[true, true], [false, false], [false, true], [false, true], [false, true], [false, true], [false, false]]);
  assert.equal(ix.keys[2].pubkey, A.of('Caravan', { ownerTag: citizenTag(ME), seq: 1 }), 'the viewer\'s own caravan only');
  assert.equal(ix.keys[3].pubkey, A.of('Holding', { p: 3, q: -2, site: 4 }));
  assert.ok(rightsMessage(intent, { programId: LOCAL_PLAY_PROGRAM, seasonId: '11', wallet: W, blockhash: W, loadedLimit: 67108864 }).length < 1232);
  assert.throws(() => rightsIntent('SettleCaravan', { seq: 1, dst: { kind: 'holding', p: 3, q: -2, site: 4, gen: 1 }, provinces: [] }, {}));
  assert.throws(() => rightsIntent('SettleCaravan', { seq: 1, dst: { kind: 'holding', p: 3, q: -2, site: 4, gen: 1 }, provinces: [{ p: 3, q: -2 }] }, { beneficiary: 'x' }));
});
