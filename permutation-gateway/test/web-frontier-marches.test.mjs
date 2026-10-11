// The page's reading of its own marches (controller.mjs `refreshMarches`,
// `composeTick`) against the sample world, in node: the page's own controller
// and herald client, the world's own Depart and Reveal. Each case below was
// first seen in the browser suite on a fast clock (interaction.screen.mjs:
// "a march to an empty tile…", one full run in four) and found by logging
// every reveal the world received:
//   1. two readings side by side each sent the self-reveal (the second was
//      answered AlreadyDone) and the later one wrote its older copy of the
//      book over the first one's record of the attempt;
//   2. a march whose slot the destination's envelope does not show (the
//      turn after the arrival turn, until that turn is closed) was revealed
//      a second time 60 s on, although the viewer's own record lists the slot;
//   3. a reading that held a Holding older than the book (asked for before the
//      march landed, or from a herald a moment behind the relay) wrote a march
//      that had just landed off as settled, and this device never revealed it;
//   4. a reading wrote the copy of the book it began with over an order that
//      was sealed meanwhile;
//   5. an order card left open across a toll kept the turn it was opened with.
// The rule of the self-reveal (marchbook.mjs `revealStep`, contract §9.1) is
// what it was: these tests pin how the page feeds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../screens/server.mjs';
import * as W from '../screens/world.mjs';
import { kernel } from '../screens/kernel.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import * as book from '../../permutation-server/web/frontier/marchbook.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { ChainClock, seasonClock, bellAt } from '../../permutation-server/web/frontier/clock.mjs';
import { seasonTipMin, departMargin, DEPART_MARGIN_SECS } from '../../permutation-server/web/frontier/fmarch.mjs';
import { pack, encodePath, commit as sealCommit, ctHash as sealCtHash, sealRoot as sealRootOf } from '../../permutation-server/web/frontier/seal.mjs';
import { tileHex, TILE_OFFSETS, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const RATE = 30;   // the sample world's default: a turn every 20 s
const RINGS = W.seasonRecord().rings.map(r => ({ ring: r.d, seed: r.seed }));

/** The page's controller on a sample world whose clock the test moves: `{srv, world, clock, h, stored, key, to(turn, into), close()}`. */
async function open({ herald: wrap = h => h } = {}) {
  const srv = await startServer();
  const saved = { ...FS }, storageWas = globalThis.localStorage, relayWas = io.relay();
  const clock = { t: 1_700_000_000_000 };
  setLang('ja');
  srv.stage('holding');
  const world = srv.live(true, { wall: () => clock.t, neighbours: false });
  const stored = new Map(Object.entries(W.storageFor(srv.viewer, { stage: 'holding', lang: 'ja' })));
  globalThis.localStorage = { getItem: k => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, String(v)); }, removeItem: k => { stored.delete(k); } };
  const h = createHerald({ base: srv.url });
  const s = await h.season();
  const pin = io.setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses);
  io.setRelay(`${srv.url}/gw`);
  const chain = new ChainClock({ wall: () => clock.t });
  chain.setAccelerated(true);
  chain.observe(s.record.latestUnix, s.record.latestSlot);
  clock.t += 2_100;
  const s2 = await h.season();
  chain.observe(s2.record.latestUnix, s2.record.latestSlot);
  assert.equal(chain.rate, RATE);
  Object.assign(FS, { mode: 'play', pin, record: s.record, season: s.season, clock: seasonClock(s.season), chain, wallet: { address: srv.viewer.wallet }, session: null, kernel: kernel(),
    citizen: null, holdings: [], provinces: new Map(), overviews: new Map(), chronicle: [], marches: [], book: [], life: new Map(), incoming: [], compose: null });
  C.useHerald(wrap(h));
  const key = book.bookKey({ cluster: s.record.cluster, programId: s.record.programId, seasonId: s.record.season }, srv.viewer.wallet);
  return {
    srv, world, clock, h, stored, key,
    /** Move the clock to `into` game seconds into turn `b` (the world's and the page's: one wall clock). */
    to(b, into = 0) { const at = world.tollAt + 600 * (b - 43) + into; assert.ok(at >= world.now(), 'the clock only moves on'); clock.t += Math.ceil(((at - world.now()) / RATE) * 1000) + 1; assert.equal(bellAt(FS.clock.genesisTs, chain.now()), b); },
    book: () => book.loadBook(book.browserStorage, key),
    async close() {
      Object.assign(FS, saved);
      for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k];
      if (storageWas === undefined) delete globalThis.localStorage; else globalThis.localStorage = storageWas;
      io.setRelay(relayWas);
      srv.live(false);
      await srv.close();
    },
  };
}

/** An open tile two hexes from the village, and the way there. */
function destination(world) {
  const pv = world.province(W.HOME.p, W.HOME.q), o = TILE_OFFSETS[W.HOME.tile];
  const tile = [...Array(61).keys()].find(i => ((pv.passableMask >> BigInt(i)) & 1n) && !pv.sites.includes(i) && i !== W.CAMP_TILE && !pv.entries.some(e => e.state && e.tile === i) && hexDistance(o.q, o.r, TILE_OFFSETS[i].q, TILE_OFFSETS[i].r) === 2);
  const plan = kernel().call('plan_path', { start: tileHex(W.HOME.p, W.HOME.q, W.HOME.tile), dest: tileHex(W.HOME.p, W.HOME.q, tile), unit: 0, blocked: [], seeds: RINGS });
  assert.ok(plan.ok && plan.value, 'a way to the tile');
  return { tile, dirs: plan.value.dirs, secs: plan.value.secs };
}

/**
 * The free host departs for `dest`, sealed as the page seals (the same commit, seal root and plaintext; the seal's
 * bytes are a stand-in, as the world does not open seals): the world takes the Depart, and the entry this device
 * would hold is returned (`state` as asked; not yet in the book).
 */
function depart(o, dest, { arrive, slot = 0, state = 'landed' }) {
  const path = encodePath(dest.dirs);
  const plain = pack({ version: 1, hostId: BigInt(W.HOSTS.free), arriveBell: arrive, destP: W.HOME.p, destQ: W.HOME.q, destTile: dest.tile, stance: 0, retreatBps: 0, pathLen: path.pathLen, path: path.path });
  const salt = new Uint8Array(32).fill(7), seal = Uint8Array.from({ length: 165 }, (_, i) => (i === 0 ? 0x80 : (i * 7) & 0xff));
  const commit = sealCommit(plain, salt), ct = sealCtHash(seal), tip = seasonTipMin(FS.season);
  const r = o.world.order('Depart', { host_id: BigInt(W.HOSTS.free), commit, seal, arrive_bell: arrive, tip, transit_slot: slot });
  assert.equal(r.ok, true, `the world takes the Depart: ${JSON.stringify(r)}`);
  const e = book.entryOf({ host: BigInt(W.HOSTS.free), transitSlot: slot, departBell: o.world.turn(), arriveBell: arrive, holding: o.srv.viewer.holding, plain, salt, commit, sealRoot: sealRootOf(commit, ct), ctHash: ct, seal, round: 1, tip,
    route: { dirs: dest.dirs }, origin: { p: W.HOME.p, q: W.HOME.q, tile: W.HOME.tile } }, () => 0);
  return { ...e, state };
}
const put = (o, entry) => assert.equal(book.saveBook(book.browserStorage, o.key, book.addSealed(o.book(), entry)), true);
const mine = o => o.book().find(e => e.host === String(W.HOSTS.free));
const selfReveals = o => o.world.reveals.filter(r => r.by === 'self').map(r => [r.ok, r.code]);

test('the self-reveal goes out once: three readings of the marches side by side send one, the book keeps its attempt, and a slot the viewer\'s own record lists is not revealed again', async () => {
  const o = await open();
  try {
    await C.refresh();
    assert.equal(FS.nowBell, 42);
    const dest = destination(o.world), arrive = 44;
    put(o, depart(o, dest, { arrive }));
    await C.refresh();
    assert.deepEqual([mine(o).state, mine(o).attempts.length], ['landed', 0]);
    assert.deepEqual(selfReveals(o), [], 'nothing before the arrival turn');
    // ---- the arrival turn, half a minute in (the delay drawn for this entry is 0): the poll, the toll's read and an
    // order's answer ask for a reading in the same moment
    o.to(arrive, 30);
    await Promise.all([C.refresh(), C.refresh(), C.refresh()]);
    assert.deepEqual(selfReveals(o), [[true, null]], 'one self-reveal, taken');
    assert.deepEqual(mine(o).attempts.map(a => [a.route, a.result]), [['self', 'accepted']], 'the book holds the one attempt (the reading that came after did not write an older book over it)');
    // ---- two minutes on, still the arrival turn: nothing more
    o.to(arrive, 150);
    await Promise.all([C.refresh(), C.refresh()]);
    assert.deepEqual(selfReveals(o), [[true, null]]);
    assert.equal(mine(o).state, 'revealed', 'the envelope of the arrival turn shows the slot');
    // ---- the turn after: the destination's envelope does not show the slot (the arrival turn's own file comes when
    // that turn is closed; `latest` carries another turn's slots), the window is open, the attempt is more than 60 s
    // old. A device that never saw the slot in an envelope (it was put away after its reveal) still holds the entry
    // as `revealing`: the viewer's own record lists the slot, and that is "seen"
    o.to(arrive + 1, 30);
    book.saveBook(book.browserStorage, o.key, book.mark(o.book(), mine(o), { state: 'revealing' }));
    await C.refresh();
    const m = FS.marches.find(x => x.entry?.host === String(W.HOSTS.free));
    assert.deepEqual([m.facts.slotPresent, m.facts.pipeline], [false, 'revealing'], 'the envelope does not show it and the window is open');
    assert.deepEqual(selfReveals(o), [[true, null]], 'no second reveal for a slot the herald lists');
    assert.deepEqual([mine(o).state, mine(o).attempts.length], ['revealing', 1], 'what the page says of the march still follows the envelope');
    assert.deepEqual(o.srv.requests.filter(r => r.code >= 400), []);
  } finally { await o.close(); }
});

test('the rule\'s own retry still goes out: no slot anywhere 60 s after the first attempt, the window open: once more, and never a third time', async () => {
  const o = await open();
  try {
    await C.refresh();
    const dest = destination(o.world), arrive = 44;
    // (the first attempt is one the keeper never took: written into the book as sent, the world has no slot)
    const e = depart(o, dest, { arrive, state: 'revealing' });
    put(o, { ...e, attempts: [{ t: o.world.tollAt + 600 * (arrive - 43) + 5, route: 'self', result: 'accepted' }] });
    o.to(arrive, 40);
    await C.refresh();
    assert.deepEqual(selfReveals(o), [], 'not within 60 s of the first attempt');
    o.to(arrive, 70);
    await Promise.all([C.refresh(), C.refresh()]);
    assert.deepEqual(selfReveals(o), [[true, null]], 'the retry, once');
    assert.equal(mine(o).attempts.length, 2);
    o.to(arrive, 300);
    await C.refresh();
    assert.deepEqual(selfReveals(o), [[true, null]]);
  } finally { await o.close(); }
});

test('a march that landed after the Holding was read is not written off as settled: the next reading sees its transit, and this device reveals it', async () => {
  let afterMe = null;
  const o = await open({ herald: h => ({ ...h, me: async w => { const r = await h.me(w); const f = afterMe; afterMe = null; f?.(); return r; } }) });
  try {
    await C.refresh();
    const dest = destination(o.world), arrive = 44;
    // the Depart lands, and this device's send flow marks its entry `landed`, in the moment after a reading asked
    // for the viewer's record: that reading holds a Holding whose transit record is still free
    afterMe = () => put(o, depart(o, dest, { arrive }));
    await C.refresh();
    assert.equal(FS.holdings[0].transit[0].state, 0, 'the Holding this reading held is the older one');
    assert.equal(mine(o).state, 'landed', 'not settled: the book did not hold the march as on chain when that Holding was read');
    await C.refresh();
    assert.equal(FS.holdings[0].transit[0].state, 1);
    assert.equal(mine(o).state, 'landed');
    assert.equal(FS.marches.filter(x => x.entry?.host === String(W.HOSTS.free)).length, 1, 'the march has its card');
    o.to(arrive, 30);
    await C.refresh();
    assert.deepEqual(selfReveals(o), [[true, null]], 'revealed by this device in its arrival turn');
  } finally { await o.close(); }
});

test('a herald that is a moment behind the relay: the march is landed in the book, the Holding still shows its record free: not settled, and revealed in its arrival turn', async () => {
  // (the viewer's record one answer old: what a herald that folds the chain a moment after the relay confirmed shows)
  let last = null;
  const o = await open({ herald: h => ({ ...h, me: async w => { const r = await h.me(w), was = last ?? r; last = r; return was; } }) });
  try {
    await C.refresh();
    const dest = destination(o.world), arrive = 44;
    put(o, depart(o, dest, { arrive }));
    await C.refresh();
    assert.equal(FS.holdings[0].transit[0].state, 0, 'the Holding the page was shown is the one before the Depart');
    assert.equal(mine(o).state, 'landed', 'a free record before the arrival turn has ended is not "settled"');
    await C.refresh();
    assert.deepEqual([FS.holdings[0].transit[0].state, mine(o).state], [1, 'landed']);
    o.to(arrive, 30);
    await C.refresh(); await C.refresh();
    assert.deepEqual(selfReveals(o), [[true, null]]);
  } finally { await o.close(); }
});

test('an order sealed while the marches are being read stays in the book (the reading writes the book as it stands, not the copy it began with)', async () => {
  let duringRead = null;
  // (the hook runs while a reading waits for the arrival turn's own file of the destination)
  const o = await open({ herald: h => ({ ...h, province: async (p, q, bell) => { const r = await h.province(p, q, bell); if (Number.isInteger(bell)) { const f = duringRead; duringRead = null; f?.(); } return r; } }) });
  try {
    await C.refresh();
    assert.equal(FS.marches.length, 1, 'the march that reached the camp is being followed: a reading waits on the herald for it');
    const dest = destination(o.world);
    // this device's send flow saves a sealed order (before Depart is signed) in the middle of that reading
    const sealed = { ...depart(o, dest, { arrive: 44 }), state: 'sealed' };
    duringRead = () => put(o, sealed);
    await C.refresh();
    assert.equal(duringRead, null, 'the reading did wait on the herald');
    assert.equal(mine(o)?.commit_hex, sealed.commit_hex, 'the sealed order is still in the book');
    await C.refresh();
    assert.equal(mine(o).state, 'landed', 'and is followed from the next reading on');
  } finally { await o.close(); }
});

test('the order card follows the clock: its arrival turn moves on at the toll and in a turn\'s last seconds, and it says that it moved', async () => {
  const o = await open();
  try {
    await C.refresh();
    const dest = destination(o.world);
    const row = FS.provinces.get(`${W.HOME.p},${W.HOME.q}`).province.entries.find(e => BigInt(e.id) === BigInt(W.HOSTS.free));
    FS.compose = { host: { ...row, id: W.HOSTS.free, troops: 600, tile: W.HOME.tile, unit: 0 }, origin: { p: W.HOME.p, q: W.HOME.q }, stance: 0, retreat: 'never', ratio: null, tip: String(seasonTipMin(FS.season)), quick: [], dest: null, route: null, arriveBell: 44 };
    assert.equal(C.composeTick(), false, 'nothing without a destination');
    o.to(42, 450);
    await C.ACTIONS['dest-quick']({ p: String(W.HOME.p), q: String(W.HOME.q), tile: String(dest.tile) });
    const c = FS.compose;
    assert.ok(c.route && c.route.secs === dest.secs, 'the route is planned');
    assert.deepEqual([c.earliest, c.arriveBell, c.moved ?? null], [44, 44, null], 'two turns at the least');
    assert.equal(C.composeTick(), false, 'nothing to move');
    // ---- the last seconds of the turn: a departure planned now counts as the next turn's (the margin: 90 game
    // seconds on this clock, as on the chain's)
    assert.equal(departMargin(FS.chain.rate), DEPART_MARGIN_SECS);
    o.to(42, 600 - DEPART_MARGIN_SECS - 5);
    assert.equal(C.composeTick(), false, 'not yet');
    o.to(42, 600 - DEPART_MARGIN_SECS + 5);
    assert.equal(C.composeTick(), true);
    assert.deepEqual([c.earliest, c.arriveBell, c.moved], [45, 45, { from: 44, to: 45 }], 'the card names the next turn and says where it came from');
    assert.equal(C.composeTick(), false, 'once');
    // ---- the toll: nothing more to move (the card is already where the new turn's earliest is)
    o.to(43, 10);
    C.tolled();
    assert.deepEqual([FS.nowBell, c.arriveBell, c.moved], [43, 45, { from: 44, to: 45 }]);
    // ---- (the merge's play of 2026-10-11) the card says so in its foot as well: on a phone the page's own cards open
    // as the low sheet, which shows the foot only, and there the summary's turn changed with nothing said
    {
      const { render } = await import('../../permutation-server/web/frontier/hud/marchcard.mjs');
      const card = String(render(FS)), line = '時間が進んだので、到着はターン 45 になりました（さきほどまではターン 44）。';
      const body = card.slice(0, card.indexOf('<footer class="order-foot">')), foot = card.slice(card.indexOf('<footer class="order-foot">'));
      assert.ok(card.includes('<footer class="order-foot">'));
      assert.match(body, new RegExp(`<p class="mc-moved" role="status">.*${line}`), 'where the turn is named');
      assert.match(foot, new RegExp(`<p class="mc-moved mc-moved-foot" aria-hidden="true">.*${line}`), 'and in the foot, before the summary and the seal');
      assert.ok(foot.indexOf('mc-moved-foot') < foot.indexOf('class="order-sum"') && foot.indexOf('class="order-sum"') < foot.indexOf('data-act="march-send"'));
      const css = (await import('node:fs')).readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');
      assert.match(css, /\n\.mc-moved-foot \{ display: none; \}\n@media \(max-width: 759px\) \{ \.panel\[data-sheet="peek"\] \.order-foot \.mc-moved-foot \{ display: flex; margin: 0; \} \}/, 'shown only while the sheet is folded on a phone: said once on any screen');
    }
    // ---- a card left open for two more turns moves with each, and keeps saying the turn it first named
    o.to(45, 10);
    C.tolled();
    assert.deepEqual([c.earliest, c.arriveBell, c.moved], [47, 47, { from: 44, to: 47 }]);
    // ---- the player's own choice of a later turn stays, and ends the note
    C.ACTIONS['mc-bell']({ d: '2' });
    assert.deepEqual([c.arriveBell, c.moved], [49, null]);
    o.to(46, 10);
    C.tolled();
    assert.deepEqual([c.earliest, c.arriveBell, c.moved], [48, 49, null], 'a chosen turn that can still be reached is not touched');
    // ---- while an order is being sealed and sent the card is left alone
    c.sending = true;
    o.to(48, 10);
    assert.equal(C.composeTick(), false);
    assert.equal(c.arriveBell, 49);
  } finally { await o.close(); }
});

test('the departure margin by the clock\'s rate: 90 game seconds on the chain\'s clock and on a slow sample clock; at least two seconds of the player\'s time on a fast one; never over half a turn', () => {
  assert.deepEqual([undefined, 1, 0, 30, 45, 50, 75, 120, 600].map(r => departMargin(r)), [90, 90, 90, 90, 90, 100, 150, 240, 300]);
  assert.equal(departMargin(NaN), 90);
});
