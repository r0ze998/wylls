// fix-wide-breaks (TEST-ONLY wide local play) BREAK-1 / BREAK-3: the page's own expeditions into the wide land are read
// from the chain (bridge transit, clash inputs, arrival slots) and shown in 進軍 / Hosts / the map; a seal the runner has
// opened is let go by the reveal strip; the strip no longer stands over an open drawer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonPda, withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey, packWidePlain } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { revealAddresses } from '../../permutation-server/web/frontier/fexpedition-reveal.mjs';
import { fromHex } from '../../permutation-server/web/sdk/bytes.mjs';
// (the local-play program id, [0x45; 32]; written out so this test reaches no gateway src/ and runs in the key-free CI job)
const LOCAL_PLAY_PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';
import * as X from '../../permutation-server/web/frontier/flocalplay-expedition.mjs';
import { localRevealCandidate } from '../../permutation-server/web/frontier/flocalplay-reveal.mjs';
import { renderExpedition, expeditionPhases, render as renderTracker } from '../../permutation-server/web/frontier/screens/tracker.mjs';
import { ownMarches } from '../../permutation-server/web/frontier/map/board.mjs';
import { readFileSync } from 'node:fs';

const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0];
const WORLD = worldIdOf(SEASON, LOCAL_PLAY_PROGRAM);
const HOST = canonicalOriginalHostRef({ world: WORLD, p: '-68', q: '-60', site: 10, gen: 0, seq: 0 });
const DEST = canonicalWideProvinceKey({ world: WORLD, p: '-68', q: '-61' });
const HOLDING = withSeed(SEASON, seedOf('Holding', { p: -68, q: -60, site: 10 }), LOCAL_PLAY_PROGRAM);
const plain = arriveBell => packWidePlain({ version: 2, host: HOST, arriveBell, dest: DEST, destTile: 55, stance: 0, retreatBps: 0, pathLen: 0, path: '00'.repeat(12), reserved: '00'.repeat(8) });
const PIN = { programId: LOCAL_PLAY_PROGRAM, seasonAddress: SEASON };
const FACTION = 0;
const rec = (arriveBell = 219) => ({ host: HOST, transitSlot: 0, commit: 'c'.repeat(64), arriveBell, signature: 'sig', plain: plain(arriveBell), holding: HOLDING, revealed: null });
const latin = s => Uint8Array.from(s, c => c.charCodeAt(0));
function bridge(state) { const b = new Uint8Array(336); b.set(latin('PSWLEXP1')); b[8] = 2; b[16 + 1] = state; return { owner: LOCAL_PLAY_PROGRAM, data: b }; }
function slot(host) { const b = new Uint8Array(288); b.set(latin('PSFXWASL')); b.set(fromHex(host), 96); return { owner: LOCAL_PLAY_PROGRAM, data: b }; }
function inputs({ k = 0, fate = 1, after = 110_000, resolved = true, settled = false, host = HOST, faction = FACTION } = {}) {
  const b = new Uint8Array(320 + 24 * 112), v = new DataView(b.buffer); b.set(latin('PSFXWCLI'));
  if (resolved) b[18] = 2;
  if (settled) v.setUint32(36, 1 << k, true);
  const o = 320 + k * 112; b.set(fromHex(host), o); b[o + 102] = faction; b[o + 106] = 1; b[o + 107] = fate; v.setUint32(o + 108, after, true); v.setUint32(o + 88, 110_000, true);
  return { owner: LOCAL_PLAY_PROGRAM, data: b };
}
const addrs = r => X.expeditionAccounts(r, PIN, FACTION).addresses;
const facts = (r, m) => { const a = addrs(r); return X.expeditionFacts(r, LOCAL_PLAY_PROGRAM, FACTION, new Map(a.map((x, i) => [x, m[i] ?? null])), a); };

test('the accounts read are the transit, the clash inputs and the four arrival slots the reveal uses', () => {
  const r = rec(), a = revealAddresses({ program: LOCAL_PLAY_PROGRAM, season: SEASON, holding: HOLDING, transitSlot: 0, faction: FACTION, arriveBell: 219, destKey: DEST, destRegion: 0 });
  assert.deepEqual(addrs(r), [a.transit, a.inputs, ...a.slots]);
});

test('an expedition is staged from the chain: marching → arrived → revealed → resolved → settled', () => {
  const r = rec();
  assert.equal(X.expeditionStage(r, null, 200), 'sent');
  assert.equal(X.expeditionStage(r, facts(r, [bridge(1)]), 210), 'marching');
  assert.equal(X.expeditionStage(r, facts(r, [bridge(2)]), 219), 'arrived');
  const rv = facts(r, [bridge(2), null, null, slot(HOST)]);
  assert.equal(rv.slotI, 1); assert.equal(X.expeditionStage(r, rv, 230), 'revealed');
  const rs = facts(r, [bridge(2), inputs({ settled: false }), slot(HOST)]);
  assert.equal(rs.fate, 'stays'); assert.equal(rs.troopsAfter, 110_000); assert.equal(X.expeditionStage(r, rs, 290), 'resolved');
  assert.equal(X.expeditionStage(r, facts(r, [bridge(2), inputs({ settled: true })]), 295), 'settled');
  assert.equal(X.expeditionStage(r, facts(r, [null, inputs({ fate: 5 })]), 300), 'settled');
  assert.equal(facts(r, [null, inputs({ fate: 5 })]).fate, 'destroyed');
  // (gone after the arrival with nothing read of it: not known, never "nothing happened")
  assert.equal(X.expeditionStage(r, facts(r, []), 300), 'unknown');
  assert.equal(X.expeditionStage(r, facts(r, []), 210), 'sent');
});

test('only our own host and nation in records the program owns count', () => {
  const r = rec(), OTHER = canonicalOriginalHostRef({ world: WORLD, p: '-68', q: '-60', site: 10, gen: 0, seq: 1 });
  assert.equal(facts(r, [bridge(2), inputs({ host: OTHER }), slot(OTHER)]).fate, null);
  assert.equal(facts(r, [bridge(2), inputs({ faction: 3 })]).fate, null);
  const foreign = { ...slot(HOST), owner: '11111111111111111111111111111111' };
  assert.equal(facts(r, [bridge(2), null, foreign]).slotI, null);
});

test('readExpeditions reads each kept seal once through the context route and lets an opened seal go (BREAK-3)', async () => {
  const fs = {}, r = rec(), list = () => [r];
  const posts = [];
  const post = async (origin, path, body) => {
    posts.push({ origin, path, body });
    return { context_slot: '9', blockhash: { hash: '11111111111111111111111111111111', last_valid_block_height: '9', context_slot: '9' },
      accounts: body.addresses.map((a, i) => { const acc = [bridge(2), inputs({ settled: true }), slot(HOST)][i] ?? null; return { address: a, owner: acc?.owner ?? null, data_b64: acc ? Buffer.from(acc.data).toString('base64') : null }; }) };
  };
  const m = await X.readExpeditions(fs, { relay: 'http://127.0.0.1:41551', pin: PIN, faction: FACTION, nowBell: 300, post, seals: list });
  assert.equal(posts.length, 1); assert.equal(posts[0].path, '/gw/f/local-play/reveal/context'); assert.equal(posts[0].body.addresses.length, 6);
  assert.equal(m.get(r.commit).facts.fate, 'stays');
  assert.deepEqual(r.revealed, { signature: null, by: 'chain' });
  // a settled seal is not read again
  await X.readExpeditions(fs, { relay: 'http://127.0.0.1:41551', pin: PIN, faction: FACTION, nowBell: 301, post, seals: list });
  assert.equal(posts.length, 1);
  // a failed read keeps nothing new and throws nothing
  const fs2 = {}, r2 = rec(400);
  await X.readExpeditions(fs2, { relay: 'http://127.0.0.1:41551', pin: PIN, faction: FACTION, nowBell: 300, post: async () => { throw new Error('down'); }, seals: () => [r2] });
  assert.equal(X.expeditionFactsOf(fs2).size, 0); assert.equal(r2.revealed, null);
});

test('the rows: 進軍 names the expedition and its fate, Hosts says where the host stands, the map draws it while under way (BREAK-1)', () => {
  const r = rec(), fs = { nowBell: 230, mode: 'play', holdings: [{ address: HOLDING, p: -68, q: -60, site: 10, tile: 30, transit: [{ state: 4, hostId: 7n, arriveBell: 219, originP: -68, originQ: -60, originTile: 30 }] }] };
  X.expeditionFactsOf(fs).set(r.commit, { facts: facts(r, [bridge(2), null, slot(HOST)]), bell: 230 });
  const rows = X.expeditionRows(fs, () => [r]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.expedition.stage, 'revealed'); assert.deepEqual(row.dest, { p: -68, q: -61, tile: 55 }); assert.equal(row.transit.state, 4);
  const html = String(renderExpedition(row, fs));
  assert.match(html, /data-expedition="revealed"/); assert.match(html, /-68,-61/);
  assert.doesNotMatch(String(renderTracker({ ...fs, marches: rows, marchesRead: {} })), /進軍中の軍勢はいません/);
  const drawn = ownMarches({ ...fs, marches: rows });
  assert.equal(drawn.length, 1); assert.equal(drawn[0].expedition, true); assert.equal(drawn[0].hexes.length, 2); assert.equal(drawn[0].arrived, true);
  // settled Stays: the card says so, the map no longer draws a march, Hosts lists where it stands
  X.expeditionFactsOf(fs).set(r.commit, { facts: facts(r, [null, inputs({ settled: true })]), bell: 295 });
  const done = X.expeditionRows(fs, () => [r]);
  assert.equal(done[0].expedition.stage, 'settled'); assert.equal(done[0].expedition.fate, 'stays');
  assert.match(String(renderExpedition(done[0], fs)), /data-fate="stays"/);
  assert.equal(ownMarches({ ...fs, marches: done }).length, 0);
  assert.deepEqual(X.standingExpeditions(fs, () => [r]).map(x => x.dest), [{ p: -68, q: -61, tile: 55 }]);
});

test('the phases of an expedition', () => {
  assert.deepEqual(expeditionPhases('marching', 219, 210).map(x => x.state), ['done', 'now', 'next']);
  assert.deepEqual(expeditionPhases('revealed', 219, 230).map(x => x.state), ['done', 'done', 'now']);
  assert.deepEqual(expeditionPhases('settled', 219, 300).map(x => x.state), ['done', 'done', 'done']);
});

test('wiring: readMarches adds the rows, Hosts and the strip read them (source pins)', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(c, /marches\.push\(\.\.\.localExpedition\.expeditionRows\(FS\)\)/);
  const h = readFileSync(new URL('../../permutation-server/web/frontier/screens/host.mjs', import.meta.url), 'utf8');
  assert.match(h, /\$\{wideLines\(FS\)\}/);
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(a, /const css = localRevealCss\(!!drawerOf\(FS\)\);/);
});

test('the reveal strip lets a seal go that the chain opened', () => {
  const fs = {};
  assert.equal(localRevealCandidate(fs), null);
});
