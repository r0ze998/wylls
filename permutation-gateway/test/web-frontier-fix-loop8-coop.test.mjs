// fix-loop8, LP8-3 (loop-play8): the ① co-op loop in local play. A caravan to a request the viewer accepted on 01's
// board goes to the request's own published destination — even when its province is out of sight — and, in a lane that
// carries caravans (coexist), it is sent the local way: the wallet as actor, the relay's and the program's checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PA from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import * as CB from '../../permutation-server/web/frontier/hud/coopboard.mjs';
import { registerCoopEntry, coopDestinations } from '../../permutation-server/web/frontier/hud/coopentry.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { rightsIntentOf } from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const W = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', OTHER = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', PROGRAM = 'Fron1111111111111111111111111111111111111111';
const IDENTITY = { address: W };

test('LP8-3 route: a caravan to another player\'s place (signer wallet) goes the local way only in a lane that carries SendCaravan', () => {
  const v = { seq: 0 };
  assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name: 'SendCaravan', v, signer: 'wallet', requester: null, names: PA.COEXIST_LOCAL_LANE.names }), 'local-act');
  assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name: 'SendCaravan', v, signer: undefined, requester: null, names: PA.COEXIST_LOCAL_LANE.names }), 'local-act', 'its own places, as before');
  // the plain lane does not carry caravans: refused as before
  assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name: 'SendCaravan', v, signer: 'wallet', requester: null }), 'refuse');
  // no other wallet-only shape changes, nor a settle shape, nor a requester
  for (const name of ['Harvest', 'Build', 'BuildVault', 'IssueGrant', 'SettleCaravan', 'RaidCaravan', 'SeizeVault'])
    assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name, v, signer: 'wallet', requester: null, names: PA.COEXIST_LOCAL_LANE.names }), 'refuse', name);
  assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name: 'SendCaravan', v, signer: null, requester: null, names: PA.COEXIST_LOCAL_LANE.names }), 'refuse');
  assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name: 'SendCaravan', v, signer: 'wallet', requester: OTHER, names: PA.COEXIST_LOCAL_LANE.names }), 'refuse');
  // devnet keeps its own: SendCaravan is not a devnet lane command (the ordinary path, as before)
  assert.equal(PA.localOrderRoute({ localPlay: IDENTITY, name: 'SendCaravan', v, signer: 'wallet', requester: null, names: PA.devnetLane('7').names, otherwise: 'general' }), 'general');
  assert.deepEqual([...PA.LOCAL_WALLET_SIGNED], ['SendCaravan']);
});

test('LP8-3 relay shape: the page\'s order to another player\'s village is the same checked intent (the program authenticates the place)', () => {
  const v = { seq: 3, src: { kind: 'holding', p: 2, q: 0, site: 4, gen: 1 }, dst: { kind: 'holding', p: 0, q: 2, site: 5, gen: 2 }, provinces: [{ p: 2, q: 0 }, { p: 1, q: 1 }, { p: 0, q: 2 }], actor: W };
  const fields = { seq: 3, dst_kind: 1, dst_p: 0, dst_q: 2, dst_at: 5, dst_gen: 2, steps: 9, path: new Uint8Array(12), cargo: new Uint8Array(32), fee: 1000n };
  new DataView(fields.cargo.buffer).setUint32(4, 20, true);
  fields.fee = BigInt(PA.COEXIST_LOCAL_LANE ? 0 : 0) + BigInt(readFileSync(new URL('../../permutation-server/web/frontier/fcaravan.mjs', import.meta.url), 'utf8').match(/CARAVAN_FEE = (\d+)n/)[1]);
  const intent = rightsIntentOf('SendCaravan', v, fields);
  assert.deepEqual(intent.subject.dst, { kind: 'holding', p: 0, q: 2, site: 5, gen: 2 });
  assert.equal(intent.subject.actor, undefined, 'the page\'s `actor` is not part of the intent: the relay\'s wallet is the actor');
});

const config = { season: { programId: PROGRAM, seasonId: '11' } };
const board = { read: 'ok', config };
const req = (id, extra = {}) => ({ id, ctx: { programId: PROGRAM, seasonId: '11' }, requester: OTHER, nation: 0, need: { Wood: 20 }, to: { p: 0, q: 2, site: 5, gen: 2 },
  stateNow: 'open', fulfilment: { status: 'none' }, responses: { [W]: { answer: 'accept', withdrawn: false } }, ...extra });
const fsOf = (extra = {}) => ({ season: { seasonId: 11 }, pin: { programId: PROGRAM }, wallet: { address: W }, holdings: [{ p: 2, q: 0, site: 4, gen: 1, tile: 30 }], activeHolding: 0, ...extra });

test('LP8-3 board: the destinations are the open requests this wallet accepted, of this world, never its own', () => {
  const FS = fsOf();
  const view = { read: 'ok', requests: [req('a'), req('b', { stateNow: 'closed' }), req('c', { responses: { [W]: { answer: 'decline' } } }),
    req('d', { responses: { [W]: { answer: 'accept', withdrawn: true } } }), req('e', { requester: W }), req('f', { ctx: { programId: PROGRAM, seasonId: '12' } }),
    req('g', { responses: {} }), req('h', { to: { p: 0, q: 2, site: 5, gen: 2 } })] };
  const d = CB.acceptedDestinations(FS, board, view, W);
  assert.deepEqual(d, [{ kind: 'holding', p: 0, q: 2, site: 5, gen: 2, other: true, coop: { id: 'a', need: { Wood: 20 } } }], 'one place once (h is the same place as a)');
  assert.deepEqual(CB.acceptedDestinations(FS, board, { read: 'unread', code: 'x' }, W), []);
  assert.deepEqual(CB.acceptedDestinations(FS, { read: 'absent' }, view, W), []);
  assert.deepEqual(CB.acceptedDestinations(FS, board, view, null), []);
  assert.deepEqual(CB.acceptedDestinations({ ...FS, season: { seasonId: 12 } }, board, view, W), [], 'a board of another Season');
  assert.deepEqual(CB.acceptedDestinations(FS, { read: 'ok', config: { season: { seasonId: '11' } } }, view, W), [], 'a board that does not name its program');
});

test('LP8-3 the entry\'s destinations reach the caravan form: a fogged, unloaded province is listed by its site; a loaded one by its tile', () => {
  setLang('ja');
  const off = registerCoopEntry({ id: 'ws01-coop', title: () => 'x', state: () => ({ available: true }), open: () => {},
    destinations: () => [{ kind: 'holding', p: 0, q: 2, site: 5, gen: 2, other: true, coop: { id: 'a', need: { Wood: 20 } } }] });
  try {
    const FS = { mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, caravans: 0, voted: [0, 0, 0, 0] }, wallet: { address: W },
      holdings: [{ p: 2, q: 0, site: 4, tile: 30, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => ({ value: 100000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n })), reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [] }],
      activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null } };
    assert.deepEqual(coopDestinations(FS).length, 1);
    const m = SCR.s1VillageModel(FS);
    const d = m.destinations.find(x => x.coop);
    assert.deepEqual([d.p, d.q, d.site, d.tile, d.other, d.coopGen, d.coop.id], [0, 2, 5, null, true, 2, 'a']);
    const html = String(SCR.renderS1Village(FS));
    assert.match(html, /data-form="s1-caravan"/, 'the form is offered: a destination exists');
    assert.match(html, /① 依頼の届け先：村（0, 2 · 村 5）/);
    assert.match(html, /あなたが「応じる」と答えた依頼の行き先です/);
    // loaded (and in sight or not — the form is not the map): its tile; one already listed is marked, not doubled
    const prov = { p: 0, q: 2, siteCount: 6, sites: [1, 2, 3, 4, 5, 44], siteMirror: Array.from({ length: 6 }, (_, j) => ({ state: j === 5 ? 1 : 0, faction: 3 })) };
    const FS2 = { ...FS, provinces: new Map([['0,2', { province: prov }]]) };
    const m2 = SCR.s1VillageModel(FS2), d2 = m2.destinations.filter(x => x.p === 0 && x.q === 2 && x.site === 5);
    assert.equal(d2.length, 1);
    assert.deepEqual([d2[0].tile, d2[0].coop.id, d2[0].coopGen], [44, 'a', 2]);
    assert.match(String(SCR.renderS1Village(FS2)), /① 依頼の届け先：村（0, 2 · マス 44）/);
    // the viewer's own village is never a ① destination
    const mine = { ...FS, holdings: [...FS.holdings, { ...FS.holdings[0], p: 0, q: 2, site: 5, tile: 44 }] };
    assert.equal(SCR.s1VillageModel(mine).destinations.filter(x => x.coop).length, 0);
  } finally { off(); }
  assert.deepEqual(coopDestinations({}), [], 'no entry: none');
});

test('LP8-3 the send: an unloaded ① destination\'s tile is read first; a village rebuilt since the request is refused unsent; the map\'s fog is not touched', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const at = ctl.indexOf('async function s1Caravan('), send = ctl.slice(at, ctl.indexOf('\n}\n', at));
  assert.ok(send.includes("if (dst.coop && !Number.isInteger(dst.tile)) {"));
  assert.ok(send.includes("if (!FS.provinces.get(`${dst.p},${dst.q}`)) await loadEnvelope(dst.p, dst.q).catch(() => null);"));
  assert.ok(send.includes('if (dst.coop && Number.isInteger(dst.coopGen) && Number(r.holding.gen) !== dst.coopGen) return s1Refused('));
  assert.doesNotMatch(send, /fogNow|fog\.|vision/, 'no vision rule is read or changed by the send');
  const s1 = readFileSync(new URL('../../permutation-server/web/frontier/screens/s1.mjs', import.meta.url), 'utf8');
  // (food-net-caravan, owner 2026-11-25 21:22 Q-LP17-4 — the behaviour change is the point: OTHER players' places are
  //  now listed only when of the viewer's nation or in sight, through map/fog.mjs viewTile in `otherPlaceOffered`.
  //  A ① destination is still the request's published place and passes no sight rule: the loop that adds it never
  //  asks otherPlaceOffered, and the form still reads no fog view or vision source itself)
  assert.doesNotMatch(s1, /fogNow|vision/, 'the caravan form reads no fog view and no vision source: it lists places, it does not draw land');
  assert.ok(s1.includes("import { viewTile, fogActive } from '../map/fog.mjs';"), 'the one sight question it asks: is this tile in sight now');
  const coopLoop = s1.slice(s1.indexOf('for (const c of coopDestinations(FS)) {'), s1.indexOf('const prov = h ? FS.provinces'));
  assert.ok(coopLoop.length > 0 && !/otherPlaceOffered|viewTile/.test(coopLoop), 'a ① destination is listed whatever is in sight');
});
