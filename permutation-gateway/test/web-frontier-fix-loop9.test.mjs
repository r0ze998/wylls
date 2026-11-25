// fix-loop9: the loop-play9 BREAKs on the page side (TEST-only local worlds). Key-free, no process, no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { WIDE_TRAIN, WIDE_MUSTER, wideHostRef, wideHostAlias } from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { createWideHostPlanner, WIDE_MIN_HOST_TROOPS, WIDE_DEPARTS_MAX } from '../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as W from '../../permutation-server/web/frontier/screens/wideholding.mjs';

const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', SEASON_ID = '11';
const SEASON = seasonAddresses(PROGRAM, SEASON_ID).season;
const WORLD = worldIdOf(SEASON, PROGRAM);
const village = { p: '130', q: '-1', site: 4 };
const GENESIS = 1_000_000;
const season = { seasonId: SEASON_ID, genesisTs: GENESIS, drandGenesis: 0, drandPeriod: 3, seedMargin: 0, endBell: 100000 };
const herald = { season: async () => ({ ok: true, season, record: {} }) };
const holdingBytes = ({ reserve = 0, hostSeq = 1 } = {}) => { const hb = new Uint8Array(1344), hv = new DataView(hb.buffer); hb[69] = 1; hb[70] = 17; hb[71] = 2; hb[112] = 3; hv.setUint32(132, hostSeq, true); hv.setUint32(720, reserve, true); return hb; };
/** A wide province record: `hosts` [{seq, troops, state, ready}] of this village; `keep` {holder, contender, progress}. */
const provinceBytes = (resolvedNext, { hosts = [], keep = null } = {}) => {
  const pv = new Uint8Array(4864), v = new DataView(pv.buffer); v.setUint32(72, resolvedNext, true); pv[4480] = 0xff;
  hosts.forEach((h, i) => { const o = 1064 + i * 48; v.setBigUint64(o, wideHostAlias(wideHostRef({ world: WORLD, ...village, gen: 1, seq: h.seq })), true); pv[o + 8] = 3; pv[o + 10] = 43; pv[o + 11] = h.state ?? 1; v.setUint32(o + 12, h.troops, true); v.setUint32(o + 24, h.ready ?? 0, true); });
  if (keep) { pv[4480] = 30; pv[4481] = keep.holder; pv[4482] = keep.contender ?? 0xff; pv[4483] = keep.progress ?? 0; pv[4484] = 72; v.setUint32(4488, keep.troops ?? 87, true); }
  return pv;
};
const plannerAt = (nowBell, { holding, home, dest = null, open = false }) => createWideHostPlanner({ herald, chainNow: async () => GENESIS + nowBell * 600 + 1,
  read: async addrs => (addrs.length === 1 ? [dest] : addrs.map((_, i) => (i === 0 ? holding : i === 1 ? home : i === 2 && open ? new Uint8Array(8) : null))) });
const lost = () => ({ decisions: 3, wideHostUntil: 3, wideDeparts: 1, lastWideDepart: { to: { p: '131', q: '-1', tile: 30, holder: 4 }, arrive: 394, troops: 100 } });

// loop-play9 LP9-1: the W2 host (100) lost at the Borealis keep; 87 came home (state 1, ready 416). The planner picked a
// host only with ≥ 100 troops and never read the march when a host stood at home, so the card said
// 「軍勢が整列中か休んでいます。」 from turn ~426 to 600 and nothing was ever trained again.
test('LP9-1: a beaten host home under the march minimum — the planner says the lost march and starts a NEW host (train, then muster)', async () => {
  assert.equal(WIDE_MIN_HOST_TROOPS, 100);
  const home = provinceBytes(599, { hosts: [{ seq: 0, troops: 87_115, ready: 416 }] });
  const dest = provinceBytes(598, { keep: { holder: 4, troops: 87 } });
  // reserve 0 → train
  let w = await plannerAt(600, { holding: holdingBytes({ reserve: 0 }), home, dest }).decide({ programId: PROGRAM, seasonAddress: SEASON }, lost(), { wideTargets: [], villages: [village] });
  assert.equal(w.decision?.name, WIDE_TRAIN, `a step, not a wait for ever: ${w.why}`);
  assert.equal(w.decision.rebuild, true);
  assert.equal(w.march?.phase, 'gone', 'the last march is read: it did not stay');
  assert.deepEqual(w.home, { hosts: 1, troops: 87 });
  // reserve 100 → muster a new host (the program allows several hosts of a nation in a province)
  w = await plannerAt(600, { holding: holdingBytes({ reserve: 100 }), home, dest }).decide({ programId: PROGRAM, seasonAddress: SEASON }, lost(), { wideTargets: [], villages: [village] });
  assert.equal(w.decision?.name, WIDE_MUSTER); assert.equal(w.decision.fields.troops, 100); assert.equal(w.decision.rebuild, true);
  // a host of ≥ 100 that is only RESTING still waits (its rest ends): unchanged
  const resting = provinceBytes(599, { hosts: [{ seq: 0, troops: 120_000, ready: 640 }] });
  w = await plannerAt(600, { holding: holdingBytes({ reserve: 0 }), home: resting, dest }).decide({ programId: PROGRAM, seasonAddress: SEASON }, lost(), { wideTargets: [], villages: [village] });
  assert.equal(w.wait, 'host'); assert.equal(w.decision, undefined);
  // the small host and a NEW one forming: wait for the new one (not another train)
  const forming = provinceBytes(599, { hosts: [{ seq: 0, troops: 87_115, ready: 416 }, { seq: 1, troops: 100_000, state: 2, ready: 601 }] });
  w = await plannerAt(600, { holding: holdingBytes({ reserve: 0, hostSeq: 2 }), home: forming, dest }).decide({ programId: PROGRAM, seasonAddress: SEASON }, lost(), { wideTargets: [], villages: [village] });
  assert.equal(w.wait, 'host');
  // a march still open: followed, not rebuilt
  w = await plannerAt(600, { holding: holdingBytes({ reserve: 0 }), home, dest, open: true }).decide({ programId: PROGRAM, seasonAddress: SEASON }, lost(), { wideTargets: [], villages: [village] });
  assert.equal(w.wait, 'march');
});

test('LP9-1: the card says the result (lost, survivors home) and the new host\'s step; the cap says the last result and why no more — JA and EN', () => {
  setLang('ja');
  const say = { kind: 'decision', name: WIDE_TRAIN, n: 100, rebuild: true, march: { phase: 'gone', to: { p: '131', q: '-1' } }, home: { hosts: 1, troops: 87 } };
  const t = W.wideHostSayText(say);
  assert.equal(t, '結果：軍勢は州 131,-1 に残れませんでした（戦いに敗れました）。 生き残った兵 87 が村に戻っています。兵 100 未満の軍勢は進軍できないため、新しい軍勢を作ります。 次の一手：槍兵 100 を訓練します（兵 100 そろうと編成できます）。');
  assert.match(W.wideHostSayText({ ...say, name: WIDE_MUSTER, troops: 100, n: null }), /次の一手：槍兵 100 の新しい軍勢を編成します。$/);
  assert.doesNotMatch(t, /整列中か休んで/);
  const cap = W.wideHostSayText({ kind: 'wait', wait: 'cap', cap: WIDE_DEPARTS_MAX, march: { phase: 'gone', to: { p: '131', q: '-1' } } });
  assert.match(cap, /^結果：軍勢は州 131,-1 に残れませんでした（戦いに敗れました）。 この村からの広い土地の中の進軍は、テスト世界では 2 回までです。/);
  // (verify-pr162, live turn 601: the 2nd march's hold TAKEN, then the cap — the cap's words were hidden behind the result)
  const held = { to: { p: '-67', q: '-62' }, outcome: 'taken', at: 581 };
  const capTaken = W.wideHostSayText({ kind: 'wait', wait: 'cap', cap: WIDE_DEPARTS_MAX, march: { phase: 'gone', to: { p: '-67', q: '-62' } }, hold: held });
  assert.equal(capTaken, '結果：州 -67,-62 の砦を奪いました。砦はあなたの国のものです（ターン 581 に確認）。 この村からの広い土地の中の進軍は、テスト世界では 2 回までです。これ以上の進軍は計画しません（辺境の村からの遠征は続けられます）。');
  assert.match(W.wideHostSayText({ kind: 'wait', wait: 'cap', cap: 2, hold: { ...held, outcome: 'lost', why: 'gone' } }), /^結果：州 -67,-62 の砦は奪えませんでした。.* この村からの広い土地の中の進軍は、テスト世界では 2 回までです。/);
  // (a lag answer after the cap still says the result alone, as before)
  assert.equal(W.wideHostSayText({ kind: 'wait', wait: 'lag', lag: 2, hold: held }), '結果：州 -67,-62 の砦を奪いました。砦はあなたの国のものです（ターン 581 に確認）。');
  setLang('en');
  try {
    for (const x of [say, { ...say, name: WIDE_MUSTER, troops: 100 }, { ...say, home: { troops: 0 } }, { kind: 'wait', wait: 'cap', cap: 2, march: { phase: 'gone', to: { p: '1', q: '2' } } }, { kind: 'wait', wait: 'cap', cap: 2, hold: { to: { p: '1', q: '2' }, outcome: 'taken', at: 9 } }]) {
      const e = String(W.wideHostSayText(x)); assert.ok(e.length > 20, e); assert.doesNotMatch(e, /[぀-ヿ一-鿿]/, `English only: ${e}`);
    }
    assert.match(String(W.wideHostSayText(say)), /87 surviving troops are back at the village\. A host under 100 troops cannot march/);
  } finally { setLang('ja'); }
});

test('LP9-1: the controller OFFERS the new host\'s first step once (nothing sent while the card waits); a press sends it', () => {
  const c = src('controller.mjs');
  // (w2-wipeout: the offer comes first on a person's press too, not only while the card waits)
  assert.ok(c.includes("if (mem.rebuildOffered !== key) { mem.rebuildOffered = key; wideHostStopWait(mem); FS.ui = { ...FS.ui, wideHostReady: 'rebuild' }; invalidate('panel'); return { ok: false, code: 'WideHostReady' }; }"));
  assert.ok(c.includes("...(d.rebuild ? { rebuild: true, march: w.march ?? null, home: w.home ?? null, ...(w.ended ? { ended: w.ended } : {}) } : {}) };"));
  const w = src('screens/wideholding.mjs');
  assert.ok(w.includes("data-wide-host-ready=\"${FS.ui.wideHostReady === 'rebuild' ? 'rebuild' : 'next'}\""));
  assert.match(w, /次の一手を送れます（新しい軍勢づくり）。自動では送りません。押すと上の一手を送ります。/);
});

// loop-play9 LP9-2: a rim → wide expedition of 1,189 landed on the keep tile (59) of (-65,-64), held it and took it on
// chain at turn 550 (garrison 594) — the page never showed the count nor 「奪いました」.
test('LP9-2: an expedition standing on a wide keep is followed — the count, then taken (host became the garrison) or lost — and said on the card, JA and EN', async () => {
  const X = await import('../../permutation-server/web/frontier/flocalplay-expedition.mjs');
  const { renderExpedition, expeditionHoldText } = await import('../../permutation-server/web/frontier/screens/tracker.mjs');
  const { canonicalOriginalHostRef, canonicalWideProvinceKey, packWidePlain } = await import('../../permutation-server/web/frontier/fexpedition-seal.mjs');
  const { seasonPda, withSeed, seedOf } = await import('../../permutation-server/web/frontier/faddr.mjs');
  const { readWideProvince } = await import('../../permutation-server/web/frontier/flocalplay-wide-host.mjs');
  const season = seasonPda(PROGRAM, 11)[0], world = worldIdOf(season, PROGRAM), DUNMAR = 3, BOREALIS = 1;
  const host = canonicalOriginalHostRef({ world, p: '-66', q: '128', site: 2, gen: 0, seq: 0 });
  const dest = canonicalWideProvinceKey({ world, p: '-65', q: '-64' });
  const r = { host, transitSlot: 0, commit: 'd'.repeat(64), arriveBell: 478, signature: 'sig', holding: withSeed(season, seedOf('Holding', { p: -66, q: 128, site: 2 }), PROGRAM), revealed: null,
    plain: packWidePlain({ version: 2, host, arriveBell: 478, dest, destTile: 59, stance: 0, retreatBps: 0, pathLen: 0, path: '00'.repeat(12), reserved: '00'.repeat(8) }) };
  const fs = { nowBell: 490, mode: 'play', holdings: [] };
  X.expeditionFactsOf(fs).set(r.commit, { facts: { transit: 'gone', fate: 'stays', settled: true, troopsAfter: 1_189_000, slotI: null, present: true, resolved: true }, bell: 489 });
  const pvAt = ({ contender = 0xff, holder = BOREALIS, progress = 0, stand = true, tile = 59 }) => {
    const pv = new Uint8Array(4864), v = new DataView(pv.buffer); v.setUint32(72, 489, true);
    if (stand) { const o = 1064; v.setBigUint64(o, 99n, true); pv[o + 8] = DUNMAR; pv[o + 10] = tile; pv[o + 11] = 1; v.setUint32(o + 12, 1_189_000, true); }
    pv[4480] = 59; pv[4481] = holder; pv[4482] = contender; pv[4483] = progress; pv[4484] = 72; v.setUint32(4488, 594, true);
    return pv;
  };
  let bytes = pvAt({ contender: DUNMAR, progress: 12 }), asked = [];
  const deps = { read: async a => { asked.push(...a); return [bytes]; }, parse: readWideProvince, address: (p, q) => `wide:${p},${q}`, faction: DUNMAR, seals: () => [r] };
  await X.readExpeditionHolds(fs, { ...deps, nowBell: 490 });
  assert.deepEqual(asked, ['wide:-65,-64'], 'one read: the province its own host stands in, nothing else');
  let row = X.expeditionRows(fs, () => [r])[0];
  assert.deepEqual([row.expedition.hold.outcome, row.expedition.hold.progress, row.expedition.hold.required], [null, 12, 72]);
  setLang('ja');
  let card = String(renderExpedition(row, fs));
  assert.match(card, /data-hold="counting"/); assert.match(card, /遠征の軍勢が州 -65,-64 の砦を占拠中です：12 \/ 72 ターン。/);
  // turn 550: the keep is Dunmar's; the holding host became the garrison and left the entries
  bytes = pvAt({ holder: DUNMAR, contender: 0xff, stand: false });
  await X.readExpeditionHolds(fs, { ...deps, nowBell: 550 });
  row = X.expeditionRows(fs, () => [r])[0];
  assert.equal(row.expedition.hold.outcome, 'taken');
  card = String(renderExpedition(row, fs));
  assert.match(card, /砦を奪いました：軍勢は砦の守備兵になりました/); assert.doesNotMatch(card, /留まる：/);
  assert.match(card, /結果：遠征の軍勢が州 -65,-64 の砦を奪いました。砦はあなたの国のものです（ターン 550 に確認）。/);
  // (fix-loop10, LP10-5: a TAKEN keep is still read — one read, for its garrison — and its end is not changed or said again)
  asked = []; await X.readExpeditionHolds(fs, { ...deps, nowBell: 560 }); assert.deepEqual(asked, ['wide:-65,-64'], 'a taken keep is read for its garrison');
  assert.deepEqual([X.expeditionRows(fs, () => [r])[0].expedition.hold.outcome, X.expeditionRows(fs, () => [r])[0].expedition.hold.at], ['taken', 550]);
  assert.deepEqual(X.standingExpeditions(fs, () => [r]).length, 1);
  // the pure follower: lost both ways; not on the keep tile → nothing
  const P = readWideProvince;
  const d = { p: -65, q: -64, tile: 59 };
  const counting = X.followExpeditionHold(null, { dest: d, province: P(pvAt({ contender: DUNMAR, progress: 30 })), faction: DUNMAR, nowBell: 500 });
  const gone = X.followExpeditionHold(counting, { dest: d, province: P(pvAt({ stand: false })), faction: DUNMAR, nowBell: 510 });
  assert.deepEqual([gone.outcome, gone.why], ['lost', 'gone']);
  const other = X.followExpeditionHold(counting, { dest: d, province: P(pvAt({ contender: BOREALIS + 1 })), faction: DUNMAR, nowBell: 510 });
  assert.deepEqual([other.outcome, other.why], ['lost', 'held-by-other']);
  assert.equal(X.followExpeditionHold(null, { dest: { ...d, tile: 12 }, province: P(pvAt({ tile: 12 })), faction: DUNMAR, nowBell: 500 }), null, 'a tile that is not the keep\'s');
  assert.equal(X.followExpeditionHold(null, { dest: d, province: P(pvAt({})), faction: DUNMAR, nowBell: 479 }).waiting, true, 'standing, the count not started');
  assert.match(expeditionHoldText(gone), /遠征の軍勢が砦のマスからいなくなり、占拠が止まりました/);
  setLang('en');
  try {
    for (const h of [counting, gone, other, row.expedition.hold, X.followExpeditionHold(null, { dest: d, province: P(pvAt({})), faction: DUNMAR, nowBell: 479 })]) {
      const e = String(expeditionHoldText(h)); assert.ok(e.length > 20, e); assert.doesNotMatch(e, /[぀-ヿ一-鿿]/, `English only: ${e}`);
    }
    assert.doesNotMatch(String(renderExpedition(row, fs)), /[぀-ヿ一-鿿]/);
  } finally { setLang('ja'); }
  const c = src('controller.mjs');
  assert.ok(c.includes('await followExpeditionHolds(gate, b).catch(() => null);'));
  // (fix-loop9 live run: the capture came while 「送信中…」 was up and the notice was never said — told only when said)
  assert.ok(c.includes("if (!h?.outcome || expeditionHoldTold.get(k) === h.outcome || FS.notice?.busy) continue;"), 'a busy notice postpones the end, it does not drop it');
  assert.ok(c.includes("expeditionHoldTold.set(k, h.outcome);\n    done(() => expeditionHoldText(h));"), 'the end is said once as a notice');
});

test('LP9-2 (fog): a standing expedition sees from its tile like any own host (L3), not only "seen before"; followed off the tile, it no longer does', async () => {
  const { surveyInput } = await import('../../permutation-server/web/frontier/map/viewer.mjs');
  const { anchorsOf, L3 } = await import('../../permutation-server/web/frontier/map/survey.mjs');
  const exp = (hold = null, fate = 'stays', stage = 'settled') => ({ expedition: { stage, fate, dest: { p: -65, q: -64, tile: 59 }, hold }, dest: { p: -65, q: -64, tile: 59 } });
  const fs = marches => ({ mode: 'play', holdings: [], provinces: new Map(), marches, nowBell: 500, world: { ringsOpen: 129 } });
  const hostsOf = m => surveyInput(fs(m), { ready: true }).hosts;
  assert.deepEqual(hostsOf([exp()]), [{ p: -65, q: -64, tile: 59, unit: 0 }]);
  assert.equal(anchorsOf({ hosts: hostsOf([exp()]) })[0].level, L3);
  assert.deepEqual(hostsOf([exp({ outcome: 'counting' })]).length, 1);
  assert.deepEqual(hostsOf([exp({ outcome: 'taken' })]).length, 1, 'the garrison it became stands on the keep tile');
  assert.deepEqual(hostsOf([exp({ outcome: 'lost', why: 'gone' })]), [], 'beaten off the tile: no sight from there');
  assert.deepEqual(hostsOf([exp(null, 'bounced')]), [], 'a host that went home sees nothing there');
  assert.deepEqual(hostsOf([exp(null, null, 'revealed')]), [], 'still deciding: its destination only (L2), as before');
});

test('LP9-2 (国と領土): the keep a standing expedition holds is "your host is on this keep", not a keep to reach', async () => {
  const { ownHostOnKeep } = await import('../../permutation-server/web/frontier/screens/conquest.mjs');
  const keep = { p: -65, q: -64, tile: 59, holder: 1 };
  const exp = (extra = {}) => ({ expedition: { stage: 'settled', fate: 'stays', dest: { p: -65, q: -64, tile: 59 }, hold: null, ...extra }, dest: { p: -65, q: -64, tile: 59 }, entry: null });
  const fs = m => ({ nowBell: 500, holdings: [], provinces: new Map(), marches: m });
  assert.equal(ownHostOnKeep(fs([exp()]), keep), true);
  assert.equal(ownHostOnKeep(fs([exp({ hold: { outcome: 'lost', why: 'gone' } })]), keep), false);
  assert.equal(ownHostOnKeep(fs([exp({ fate: 'bounced' })]), keep), false);
  assert.equal(ownHostOnKeep(fs([exp()]), { ...keep, tile: 12 }), false);
});

// loop-play9 LP9-5: train 500 at ×60 → the bar said 「編成 最大 500人」 → 「全部」 → the muster went with 400 and 100 stayed in
// reserve: 「全部」 kept the number of the moment the card was drawn (a batch landed after it).
test('LP9-5: 「全部」 is the whole reserve when the order goes (a batch that lands later is included); a count picked by hand stays', async () => {
  const { musterDraft } = await import('../../permutation-server/web/frontier/hud/hand.mjs');
  const model = troops => ({ reserve: [{ unit: 0, troops }] });
  assert.equal(musterDraft({ hand: { troops: 400, troopsAll: true } }, model(500)).troops, 500, '全部 pressed at 400, the reserve is 500 now');
  assert.equal(musterDraft({ hand: { troops: 400, troopsAll: true } }, model(500)).all, true);
  assert.equal(musterDraft({ hand: { troops: 400, troopsAll: false } }, model(500)).troops, 400, 'a count chosen with − / + stays');
  assert.equal(musterDraft({ hand: {} }, model(1300)).troops, 1300, 'nothing pressed: all, as before');
  assert.equal(musterDraft({ hand: { troops: 700, troopsAll: false } }, model(500)).troops, 500, 'never above the reserve');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.ok(app.includes("'hand-troops': d => { FS.hand = { ...(FS.hand ?? {}), troops: num(d.n), troopsAll: d.all === '1' }; invalidate('panel'); },"));
  assert.ok(src('hud/hand.mjs').includes("presets: [{ n: d.max, text: L`全部`, all: true, pressed: d.all }]"));
});

// loop-play9 LP9-6: B took A's deposit caravan at turn 69: the map said 「略奪された隊商 ターン 0 着」 (the re-sent route had no
// runs) and B saw nothing of the caravan until 「奪った隊商 … 隊商を届ける」 at turn 136.
test('LP9-6: a taken caravan\'s tag gives its arrival turn from its arrival time (never "turn 0"), and the raider\'s card shows it on its way', async () => {
  const MARKS = await import('../../permutation-server/web/frontier/map/s1marks.mjs');
  const { rightsModel, renderRights } = await import('../../permutation-server/web/frontier/screens/rights.mjs');
  const { issuerTagOf } = await import('../../permutation-server/web/frontier/flocalplay-rights.mjs');
  setLang('ja');
  assert.equal(String(MARKS.caravanTagText(null, true)), '略奪された隊商（着くターンは不明）');
  assert.equal(String(MARKS.caravanTagText(0, true)), '略奪された隊商（着くターンは不明）');
  assert.match(String(MARKS.caravanTagText(136, true)), /略奪された隊商 ターン 136 着/);
  const G = 1_000_000, ME = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', A = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
  const myTag = issuerTagOf(ME), aTag = issuerTagOf(A);
  const taken = { ownerTag: aTag, seq: 3, faction: 0, holderTag: myTag, raided: true, runs: [], arriveTs: G + 136 * 600 + 30, src: { kind: 3, p: -1, q: 2, tile: 20 }, dst: { kind: 1, p: -1, q: 2, at: 35, gen: 0 }, provinces: [[-1, 2]], cargo: [0, 0, 0, 20, 0, 0, 0, 0] };
  const mk = MARKS.s1Marks({ caravans: { moving: [taken], vaults: [] } }, { bell: 70, bellOfTs: ts => Math.floor((ts - G) / 600) });
  assert.equal(mk.caravans[0].arriveBell, 136, 'from arriveTs when the route has no runs');
  assert.equal(MARKS.s1Marks({ caravans: { moving: [taken], vaults: [] } }, { bell: 70 }).caravans[0].arriveBell, null, 'no clock: unknown, not 0');
  const fs = now => ({ chain: { now: () => now }, season: { genesisTs: G }, provinces: new Map(), holdings: [], s1: { caravans: { moving: [taken], vaults: [] } }, rights: { on: true, viewer: ME, read: 'ok', live: new Map(), issued: [], rows: null } });
  const before = rightsModel(fs(G + 70 * 600), G + 70 * 600);
  assert.deepEqual(before.takenOnWay.map(c => [c.seq, c.arriveBell]), [[3, 136]]); assert.equal(before.deliveries.length, 0);
  assert.match(String(renderRights(fs(G + 70 * 600))), /奪った隊商（あなたの村へ向かっています）[\s\S]*ターン 136 に着きます。着いたら、ここで届けられます。/);
  const after = rightsModel(fs(G + 137 * 600), G + 137 * 600);
  assert.equal(after.takenOnWay.length, 0); assert.equal(after.deliveries.length, 1);
  setLang('en');
  try {
    for (const t of [MARKS.caravanTagText(null, true), MARKS.caravanTagText(null), String(renderRights(fs(G + 70 * 600)))]) assert.doesNotMatch(String(t).replace(/<[^>]+>/g, ''), /[぀-ヿ一-鿿]/, String(t).slice(0, 200));
  } finally { setLang('ja'); }
});

// loop-play9 LP9-7 (also verify-pr145): B's 「鉱石を預かる」 select started on the province's FIRST village (an AI's or a test
// village, 「モヴェイル（マス 6 …）」); the partner had to be picked by hand.
test('LP9-7: the depositor select starts empty when several people could deposit (or on the one picked last); one choice is chosen; an empty press is refused', async () => {
  const { openPairPick } = await import('../../permutation-server/web/frontier/screens/custody.mjs');
  const c = [{ owner: 'AI1' }, { owner: 'PARTNER' }];
  assert.equal(openPairPick([], null), null);
  assert.equal(openPairPick([{ owner: 'X' }], null), 0, 'one choice: chosen');
  assert.equal(openPairPick(c, null), null, 'several: none chosen — not the first village');
  assert.equal(openPairPick(c, 'PARTNER'), 1, 'the person picked last time');
  assert.equal(openPairPick(c, 'GONE'), null);
  const cu = src('screens/custody.mjs');
  assert.ok(cu.includes("${pairPick === null ? html`<option value=\"\" selected>${L`（預ける人を選んでください）`}</option>` : ''}"));
  const ctl = src('controller.mjs');
  assert.ok(ctl.includes("if (!o?.owner) return s1Refused(L`貯蔵庫と預ける人を選んでください`);"), 'the empty choice sends nothing');
  assert.ok(ctl.includes('FS.ui = { ...FS.ui, custodyPair: o.owner };'));
});

// loop-play9 LP9-8: the ① board offered 「国1…国6」 and listed Borealis as 「AQKA…3FEg（国1）」 (the select's default); the ⑮
// English reason said "You earned the title … Why: Delivered goods by their own caravan" (mixed person).
test('LP9-8: the ① board names nations as the game does and follows the chain-verified nation; the ⑮ English reasons name no person', async () => {
  const { CIV_NAMES } = await import('../../permutation-server/web/i18n.mjs');
  const coop = f => readFileSync(new URL(`../../workstreams/01-national-strategy/coop/${f}`, import.meta.url), 'utf8');
  const ui = coop('coop-ui.mjs'), page = coop('index.html');
  setLang('ja');
  const ja = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'].map(k => CIV_NAMES[k]);
  assert.ok(ui.includes(`export const NATION_JA = Object.freeze([${ja.map(n => `'${n}'`).join(', ')}]);`), 'the game page\'s names, in the program\'s order');
  assert.doesNotMatch(page, />国[1-6]</, 'no 「国1…国6」 options');
  ja.forEach((n, i) => assert.ok(page.includes(`<option value="${i}">${n}</option>`)));
  assert.ok(ui.includes("if (n && Number.isInteger(n.nation) && !nationChosen && $('nation').value !== String(n.nation)) $('nation').value = String(n.nation);"));
  assert.ok(ui.includes("$('nation').addEventListener('change', () => { nationChosen = true; refresh(); });"));
  // (⑮'s own test checks every person title's English reason: workstreams/15-coop-outcomes/test/request-title.test.mjs —
  //  ⑮ is not imported from outside workstreams/, its live.test.mjs guard)
  assert.match(readFileSync(new URL('../../workstreams/15-coop-outcomes/src/live.mjs', import.meta.url), 'utf8'), /en: 'Sent the caravan that delivered goods to a co-op request from someone of another nation/);
});

// loop-play9 LP9-4 (page side): S1 counts mines above the village's TERRAIN ore; without the map's terrain the page fell
// back to the tier's base (15/h), so a village with no terrain ore and three mines (22/h) read as one mine.
test('LP9-4: copyNumber counts S1 mines above the Holding\'s own terrain ore when the map has not given it', async () => {
  const { setS1, holdingOreExtra } = await import('../../permutation-server/web/frontier/fs1.mjs');
  const { copyNumber } = await import('../../permutation-server/web/frontier/hud/rulebook.mjs');
  assert.equal(holdingOreExtra({ terrainOre: '4000' }), 0);
  assert.equal(holdingOreExtra({ terrainOre: '9000' }), 5);
  assert.equal(holdingOreExtra({ terrainOre: '1500' }), null);
  assert.equal(holdingOreExtra({}), null);
  const h = { p: 1, q: -2, tile: 30, tier: 0, terrainOre: '4000', production: [0, 0, 0, '22000', 0, 0, 0, 0], queue: [] };
  setS1({ layoutVersion: 2, programVersion: 18436 });
  try { assert.equal(copyNumber(h, 3), 4, 'three mines over 4/h: the next is copy 4 (loop-play9 priced it as copy 2)'); }
  finally { setS1(null); }
});

// loop-play9 LP9-3: every plain local world offered 「工房」 (S1 build item 8); the plain relay takes Build items 0-7 only,
// so the press was refused 「命令の内容の形が正しくありません」 with a 「もう一度」 that could never work (LocalActShape).
test('LP9-3: the workshop is offered only where the order can go — not in a plain local world (the relay\'s Build range), as before elsewhere', async () => {
  const { buildOffers } = await import('../../permutation-server/web/frontier/hud/rulebook.mjs');
  const { workshopOffered } = await import('../../permutation-server/web/frontier/screens/holding.mjs');
  const lane = await import('../../permutation-server/web/frontier/flocalplay-lane.mjs');
  const { localActIntent } = await import('../src/frontier/local-play-act.mjs');
  const h = { p: 1, q: -2, site: 0, tier: 0, production: [], queue: [], flags: 0 };
  const items = o => buildOffers(h, { s1: true, have: [999, 999, 999, 999, 0, 0, 0, 0], ...o }).map(x => x.item);
  assert.ok(items({}).includes(8), 'an S1 page elsewhere (devnet, S1) still offers it');
  assert.ok(!items({ workshop: false }).includes(8));
  assert.equal(lane.localLane(), lane.PLAIN_LANE);
  assert.equal(workshopOffered({ localPlay: { programId: 'x' } }), false, 'a plain local world');
  assert.equal(workshopOffered({}), true, 'not local play');
  // the relay's own range, which the page now follows
  const W = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', v = { name: 'Build', subject: { holding: { p: 1, q: -2, site: 0 } }, fields: { item: 8 } };
  assert.throws(() => localActIntent(v, { wallet: W }), e => e.code === 'LocalActInvalid', 'the plain relay refuses item 8');
  assert.equal(localActIntent(v, { wallet: W, coexist: true }).fields.item, 8);
  const src0 = src('screens/holding.mjs');
  assert.ok(src0.includes('offers: buildCards(h, stores, { now, faction, province: env?.province ?? null, workshop: workshopOffered(FS) }),'));
  assert.match(src0, /工房はこの試験世界では建てられません（工房を貸す・権利を出す試験世界 --coexist でだけ建てられます）。/);
  // last in this file: the lane is one-way for the process
  lane.selectLocalLane(lane.COEXIST_LANE);
  assert.equal(workshopOffered({ localPlay: { programId: 'x' } }), true, 'the --coexist world offers it as before');
});

// fix-loop9 live run (wide, turn 181): the expedition counted 6/72 on the keep of (-68,-61) and 国と領土 still said
// 「見えている他国の砦で、いま届くものはありません。」 — a wide keep is in no reach list (rings ≤ 128 only).
test('LP9-2 (国と領土, live finding): a wide keep the expedition holds is listed under 「あなたの軍勢が着いている他国の砦」 with its count', async () => {
  const { expeditionKeeps, renderReach } = await import('../../permutation-server/web/frontier/screens/conquest.mjs');
  const exp = hold => ({ expedition: { stage: 'settled', fate: 'stays', dest: { p: -68, q: -61, tile: 60 }, hold }, dest: { p: -68, q: -61, tile: 60 } });
  assert.deepEqual(expeditionKeeps({ marches: [exp({ outcome: null, progress: 6, required: 72 })] }), [{ p: -68, q: -61, tile: 60, progress: 6, required: 72 }]);
  assert.deepEqual(expeditionKeeps({ marches: [exp({ outcome: 'taken' })] }), [], 'taken: the nation\'s own keep now');
  assert.deepEqual(expeditionKeeps({ marches: [exp(null)] }), [], 'not followed (not on a keep)');
  const c = src('screens/conquest.mjs');
  assert.ok(c.includes('${held.length || wideHeld.length ? html`<h4 class="kr-held-title" id="conquest-held-title">${L`あなたの軍勢が着いている砦（自分の国のもの以外）`}</h4>'));
  assert.equal(typeof renderReach, 'function');
});
