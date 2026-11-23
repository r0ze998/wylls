// w2-wipeout (D-verify-pr137-3): the next army after a host is WIPED OUT (no survivor) or became the GARRISON of the keep it
// took — the W2 wide village card, the home village's conquest guide and the expedition card. Key-free, no process, no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { WIDE_TRAIN, WIDE_MUSTER, wideHostRef, wideHostAlias } from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { createWideHostPlanner, followWideHold } from '../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as W from '../../permutation-server/web/frontier/screens/wideholding.mjs';

const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const NO_JA = /[぀-ヿ一-鿿]/;
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', SEASON_ID = '11';
const SEASON = seasonAddresses(PROGRAM, SEASON_ID).season;
const WORLD = worldIdOf(SEASON, PROGRAM);
const village = { p: '130', q: '-1', site: 4 };
const GENESIS = 1_000_000;
const season = { seasonId: SEASON_ID, genesisTs: GENESIS, drandGenesis: 0, drandPeriod: 3, seedMargin: 0, endBell: 100000 };
const herald = { season: async () => ({ ok: true, season, record: {} }) };
const OWN = 2, OTHER = 4;
// the village's own holding (its nation is whatever the planner reads from these bytes: the tests ask it — march.faction)
const holdingBytes = ({ reserve = 0, hostSeq = 1 } = {}) => { const hb = new Uint8Array(1344), hv = new DataView(hb.buffer); hb[69] = 1; hb[70] = 17; hb[71] = 2; hb[112] = 3; hv.setUint32(132, hostSeq, true); hv.setUint32(720, reserve, true); return hb; };
const provinceBytes = (resolvedNext, { hosts = [], keep = null } = {}) => {
  const pv = new Uint8Array(4864), v = new DataView(pv.buffer); v.setUint32(72, resolvedNext, true); pv[4480] = 0xff;
  hosts.forEach((h, i) => { const o = 1064 + i * 48; v.setBigUint64(o, wideHostAlias(wideHostRef({ world: WORLD, ...village, gen: 1, seq: h.seq })), true); pv[o + 8] = 3; pv[o + 10] = 43; pv[o + 11] = h.state ?? 1; v.setUint32(o + 12, h.troops, true); v.setUint32(o + 24, h.ready ?? 0, true); });
  if (keep) { pv[4480] = 30; pv[4481] = keep.holder; pv[4482] = keep.contender ?? 0xff; pv[4483] = keep.progress ?? 0; pv[4484] = 72; v.setUint32(4488, keep.troops ?? 87, true); }
  return pv;
};
const plannerAt = (nowBell, { holding, home, dest = null, open = false }) => createWideHostPlanner({ herald, chainNow: async () => GENESIS + nowBell * 600 + 1,
  read: async addrs => (addrs.length === 1 ? [dest] : addrs.map((_, i) => (i === 0 ? holding : i === 1 ? home : i === 2 && open ? new Uint8Array(8) : null))) });
const sent = () => ({ decisions: 3, wideHostUntil: 3, wideDeparts: 1, lastWideDepart: { to: { p: '131', q: '-1', tile: 30, holder: OTHER }, arrive: 394, troops: 100 } });
const ID = { programId: PROGRAM, seasonAddress: SEASON };
const ask = (p, memory = sent()) => p.decide(ID, memory, { wideTargets: [], villages: [village] });

test('(a) wiped out: no host at home, the march closed, none of it at the keep — the planner raises a NEW host (train, then muster) instead of waiting for ever', async () => {
  const home = provinceBytes(599);                                   // no host of the village at home
  const dest = provinceBytes(598, { keep: { holder: OTHER, troops: 140 } });  // nor at the keep: the host is gone
  const holding = holdingBytes({ reserve: 0 });
  const faction = (await plannerAt(600, { holding, home, dest }).decide(ID, sent(), { wideTargets: [], villages: [village] })).march?.faction;
  let w = await ask(plannerAt(600, { holding, home, dest }));
  assert.equal(w.decision?.name, WIDE_TRAIN, `a step, not 「its host left」 for ever: ${w.why}`);
  assert.equal(w.decision.rebuild, true); assert.equal(w.rebuild, true);
  assert.equal(w.ended, 'wiped'); assert.deepEqual(w.home, { hosts: 0, troops: 0 });
  assert.equal(w.march?.phase, 'gone');
  assert.match(w.decision.why, /lost at 131,-1 with no survivor home/);
  assert.notEqual(faction, OTHER, 'the fixture\'s keep is another nation\'s');
  w = await ask(plannerAt(600, { holding: holdingBytes({ reserve: 100 }), home, dest }));
  assert.equal(w.decision?.name, WIDE_MUSTER); assert.equal(w.decision.fields.troops, 100); assert.equal(w.ended, 'wiped');
  // never auto-sends: the planner only decides; nothing here is a send (the controller offers it — below)
  // a march still OPEN (survivors may come home with it): followed, not rebuilt
  w = await ask(plannerAt(600, { holding, home, dest, open: true }));
  assert.equal(w.wait, 'march'); assert.equal(w.decision, undefined);
  // still on its way (before the arrival turn): followed
  w = await ask(plannerAt(390, { holding, home, dest }));
  assert.equal(w.wait, 'march'); assert.equal(w.march.phase, 'out');
  // the destination not readable: followed (not judged gone)
  w = await ask(plannerAt(600, { holding, home, dest: null }));
  assert.equal(w.wait, 'march'); assert.equal(w.march.phase, 'unread');
  // standing on the keep (the hold counts): followed
  const stands = provinceBytes(598, { hosts: [{ seq: 0, troops: 60_000 }], keep: { holder: OTHER, contender: 0, progress: 5 } });
  w = await ask(plannerAt(600, { holding, home, dest: stands }));
  assert.equal(w.wait, 'march'); assert.equal(w.march.phase, 'stands');
  // a caller WITHOUT the march memory (the operator AI residents keep none) waits as before
  w = await ask(plannerAt(600, { holding, home, dest }), { decisions: 3, wideHostUntil: 3, wideDeparts: 1 });
  assert.equal(w.wait, 'march'); assert.equal(w.decision, undefined);
  // at the TEST cap: the cap's words, no new host
  w = await ask(plannerAt(600, { holding, home, dest }), { ...sent(), wideDeparts: 2 });
  assert.equal(w.wait, 'cap'); assert.equal(w.decision, undefined);
});

test('(b) keep TAKEN: the host became the garrison (gone from the entries, keep now the village nation\'s) — the planner raises a new host; the hold says taken', async () => {
  const home = provinceBytes(599);
  // which nation the planner reads for this village (holdingBytes' faction byte) — the keep is handed to it
  const probe = await ask(plannerAt(600, { holding: holdingBytes(), home, dest: provinceBytes(598, { keep: { holder: OTHER } }) }));
  const mine = probe.march.faction;
  const dest = provinceBytes(598, { keep: { holder: mine, troops: 42 } });
  const w = await ask(plannerAt(600, { holding: holdingBytes({ reserve: 0 }), home, dest }));
  assert.equal(w.decision?.name, WIDE_TRAIN); assert.equal(w.decision.rebuild, true);
  assert.equal(w.ended, 'garrison');
  assert.match(w.decision.why, /became the garrison of the keep of 131,-1/);
  // the card's memory of the hold, followed through the planner's answer: stands (counting) → gone with the keep ours = taken
  let hold = followWideHold(null, { to: { p: '131', q: '-1' }, arrive: 394, phase: 'stands', nowBell: 420, faction: mine, keep: { holder: OTHER, contender: mine, progress: 70, required: 72 } });
  hold = followWideHold(hold, w.march);
  assert.equal(hold.outcome, 'taken');
});

test('the W2 card says what happened (wiped out / garrison) and the new host\'s step — JA and EN; the hold\'s own end is not repeated', () => {
  setLang('ja');
  const wiped = { kind: 'decision', name: WIDE_TRAIN, n: 100, rebuild: true, ended: 'wiped', march: { phase: 'gone', to: { p: '131', q: '-1' } }, home: { hosts: 0, troops: 0 } };
  assert.equal(W.wideHostSayText(wiped), '結果：軍勢は州 131,-1 に残れませんでした（戦いに敗れました）。 軍勢は全滅しました：生き残った兵はなく、村に戻った兵はいません。この村に軍勢はいないため、新しい軍勢を作ります。 次の一手：槍兵 100 を訓練します（兵 100 そろうと編成できます）。');
  const garrison = { ...wiped, ended: 'garrison', name: WIDE_MUSTER, troops: 100, n: null };
  assert.equal(W.wideHostSayText(garrison), '結果：州 131,-1 の砦はあなたの国のものになりました。 砦を奪った軍勢は、砦の守備兵としてそこに残りました。この村に軍勢はいないため、次の砦へ向かう新しい軍勢を作ります。 次の一手：槍兵 100 の新しい軍勢を編成します。');
  // the followed hold's own end (taken) is said by the line under it (wide-host-held): not twice
  const held = { ...garrison, hold: { to: { p: '131', q: '-1' }, outcome: 'taken', at: 466 } };
  const t = W.wideHostSayText(held);
  assert.doesNotMatch(t, /結果：/); assert.match(t, /^砦を奪った軍勢は、砦の守備兵としてそこに残りました。/);
  // a lost hold (beaten off the keep) + nobody home: the hold's end below, the wipe-out words here
  const lostHold = { ...wiped, hold: { to: { p: '131', q: '-1' }, outcome: 'lost', why: 'gone', at: 470 } };
  assert.match(W.wideHostSayText(lostHold), /^軍勢は全滅しました：/);
  // survivors home (LP9-1) unchanged
  assert.match(W.wideHostSayText({ ...wiped, ended: undefined, home: { hosts: 1, troops: 87 } }), /生き残った兵 87 が村に戻っています。/);
  setLang('en');
  try {
    for (const x of [wiped, garrison, held, lostHold]) { const e = String(W.wideHostSayText(x)); assert.ok(e.length > 40, e); assert.doesNotMatch(e, NO_JA, `English only: ${e}`); }
    assert.match(String(W.wideHostSayText(wiped)), /The host was wiped out: no troops survived and none came back to the village\./);
    assert.match(String(W.wideHostSayText(garrison)), /^Result: the keep of province 131,-1 is now your nation's\. The host that took the keep stays there as its garrison\./);
  } finally { setLang('ja'); }
});

test('the controller OFFERS the new host by the button — on a person\'s press too — and sends only on the next press; the reason rides to the card', () => {
  const c = src('controller.mjs');
  assert.ok(c.includes("if (mem.rebuildOffered !== key) { mem.rebuildOffered = key; wideHostStopWait(mem); FS.ui = { ...FS.ui, wideHostReady: 'rebuild' }; invalidate('panel'); return { ok: false, code: 'WideHostReady' }; }"));
  assert.ok(!c.includes("if (auto && mem.rebuildOffered !== key)"), 'not only while the card waits');
  assert.ok(c.includes("if (w.decision && !w.decision.rebuild && auto && mem.waiting?.reason === 'captured')"), 'after a capture the rebuild goes through the same offer');
  assert.ok(c.includes("...(w.ended ? { ended: w.ended } : {})"));
  const w = src('screens/wideholding.mjs');
  assert.match(w, /data-wide-host-ready="\$\{FS\.ui\.wideHostReady === 'rebuild' \? 'rebuild' : 'next'\}"/);
});

test('expedition card: wiped out / keep taken / beaten off — what happened and 「村で次の軍勢を作る」 (opens the village; sends nothing), JA and EN', async () => {
  const { renderExpedition, expeditionNextText } = await import('../../permutation-server/web/frontier/screens/tracker.mjs');
  setLang('ja');
  const H = 'HoLdInGaDdReSs1111111111111111111111111111';
  const row = x => ({ expedition: { stage: 'settled', fate: 'stays', troopsAfter: 1_000_000, host: 'h'.repeat(40), arriveBell: 400, dest: { p: -65, q: -64, tile: 59 }, holding: H, hold: null, ...x } });
  const fs = { nowBell: 500, mode: 'play', holdings: [{ address: 'other' }, { address: H }] };
  const cases = { wiped: row({ fate: 'destroyed', troopsAfter: 0 }), garrison: row({ hold: { to: { p: -65, q: -64 }, outcome: 'taken', at: 550 } }), gone: row({ hold: { to: { p: -65, q: -64 }, outcome: 'lost', why: 'gone', at: 520 } }) };
  for (const [k, r] of Object.entries(cases)) {
    const card = String(renderExpedition(r, fs));
    assert.match(card, new RegExp(`class="march-next" role="status" data-next="${k}"`), k);
    assert.match(card, /data-act="next-army" data-holding="1"/, `${k}: the village that sent it`);
  }
  assert.match(expeditionNextText(cases.wiped.expedition), /^遠征の軍勢は全滅しました：生き残った兵はなく、村に戻った兵はいません。/);
  assert.match(expeditionNextText(cases.garrison.expedition), /^遠征の軍勢は砦の守備兵として残りました。/);
  // still standing, came home, or under way: nothing offered
  for (const x of [row({}), row({ fate: 'bounced' }), row({ fate: 'retreated' }), row({ stage: 'marching', fate: null }), row({ hold: { to: { p: 1, q: 2 }, outcome: null, progress: 3, required: 72 } })]) {
    assert.equal(expeditionNextText(x.expedition), ''); assert.doesNotMatch(String(renderExpedition(x, fs)), /next-army/);
  }
  // a village not in this page's list: the words, no press
  assert.doesNotMatch(String(renderExpedition(cases.wiped, { ...fs, holdings: [] })), /next-army/);
  setLang('en');
  try { for (const r of Object.values(cases)) assert.doesNotMatch(String(renderExpedition(r, fs)), NO_JA); } finally { setLang('ja'); }
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const at = app.indexOf("'next-army': d => {");
  assert.ok(at > 0);
  const body = app.slice(at, app.indexOf("'cg-go': d => {", at));
  assert.match(body, /selectVillage\(hi, \[0, 1, 2, 3, 4, 5\]\.some\(u => Number\(h\.reserve\?\.\[u\] \?\? 0\) >= 100\) \? 'muster' : 'train'\)/);
  assert.doesNotMatch(body, /\bact\(|postLocalAct|send/i, 'opens the card only');
  const X = src('flocalplay-expedition.mjs');
  assert.ok(X.includes('holding: record.holding ?? null,'));
});

test('home village (conquest guide): after a capture the card offers the next army; with no host left it offers train/muster, not an empty host list — JA and EN', async () => {
  const G = await import('../../permutation-server/web/frontier/screens/conquestguide.mjs');
  setLang('ja');
  // no host anywhere; the active village's reserve decides 訓練 / 編成
  const fs = reserve => ({ mode: 'play', citizen: { faction: OWN }, holdings: [{ p: 0, q: 0, site: 1, tile: 3, reserve }], activeHolding: 0, provinces: new Map(), marches: [] });
  let n = G.nextArmyGo(fs([0, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual([n.pop, n.go.act, n.go.data.pop], ['train', 'cg-go', 'train']);
  n = G.nextArmyGo(fs([100, 0, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual([n.pop, n.go.data.pop], ['muster', 'muster']);
  assert.equal(G.nextArmyGo(fs([0, 0, 0, 0, 0, 0, 500, 0])).pop, 'train', 'scouts are not a host for a keep');
  let a = G.afterCapture(fs([0, 0, 0, 0, 0, 0, 0, 0]));
  assert.match(a.text, /^砦を奪った軍勢は、砦の守備兵として残りました。いま進軍できる軍勢はいません。/); assert.equal(a.go.data.pop, 'train');
  a = G.afterCapture(fs([300, 0, 0, 0, 0, 0, 0, 0]));
  assert.match(a.text, /控えの兵で新しい軍勢を編成します。$/); assert.equal(a.go.data.pop, 'muster');
  const s = src('screens/conquestguide.mjs');
  assert.ok(s.includes("const next = !o && cap ? afterCapture(FS) : null;"), 'the captured card carries the offer');
  assert.ok(s.includes("if (!ready && !wait && !rows.length) {"), 'the march step with no host left');
  assert.ok(s.includes("m?.facts?.settled?.outcome === 'Destroyed'"), 'a settled 壊滅 is said');
  // (verify-pr176) what counts as still out: an unsettled march only; an expedition until it is over
  assert.ok(s.includes('const { wiped, pending } = marchesLeft(FS);'));
  const ml = ms => { const r = G.marchesLeft({ marches: ms }); return [r.pending.length, r.wiped ? 'wiped' : null]; };
  assert.deepEqual(ml([]), [0, null]);
  assert.deepEqual(ml([{ dest: { p: 1, q: 2 }, facts: { pipeline: 'resolved' } }]), [1, null], 'turned back, not settled: still out');
  assert.deepEqual(ml([{ dest: { p: 1, q: 2 }, facts: { settled: { outcome: 'Destroyed' } } }]), [0, 'wiped']);
  assert.deepEqual(ml([{ dest: { p: 1, q: 2 }, facts: { settled: { outcome: 'Withdrew' } } }]), [0, null], 'settled otherwise: home already, not still out');
  const xr = x => ({ dest: { p: -65, q: -64 }, facts: { nowBell: 500 }, expedition: { stage: 'settled', fate: 'stays', hold: null, ...x } });
  assert.deepEqual(ml([xr({ stage: 'revealed', fate: null })]), [1, null], 'an expedition on its way is out');
  assert.deepEqual(ml([xr({ hold: { outcome: null, progress: 10, required: 72 } })]), [1, null], 'an expedition holding a keep is out');
  assert.deepEqual(ml([xr({ fate: 'destroyed' })]), [0, 'wiped'], 'an expedition wiped out (live: it counted as out for good)');
  assert.deepEqual(ml([xr({ hold: { outcome: 'taken' } })]), [0, null], 'the expedition that took the keep is its garrison');
  assert.deepEqual(ml([xr({ hold: { outcome: 'lost', why: 'gone' } })]), [0, null], 'beaten off the keep');
  setLang('en');
  try {
    for (const r of [[0, 0, 0, 0, 0, 0, 0, 0], [300, 0, 0, 0, 0, 0, 0, 0]]) {
      const x = G.afterCapture(fs(r)); assert.doesNotMatch(x.text + x.go.label, NO_JA, x.text);
      assert.doesNotMatch(G.nextArmyGo(fs(r)).go.label, NO_JA);
    }
  } finally { setLang('ja'); }
});

test('a REFUSED WideDepart (act answers undefined + FS.notice) is not counted as a march — live world B turn 473: NotResident counted, cap reached with no 2nd march', () => {
  const c = src('controller.mjs');
  const at = c.indexOf("const r = await act(d.name, { v: d.v, fields: d.fields, say: () => d.why });");
  assert.ok(at > 0);
  const body = c.slice(at, c.indexOf('return r;', at));
  assert.ok(body.includes('const n = r === undefined ? FS.notice : r;'));
  assert.ok(body.includes("if (n?.ok !== false && d.name === 'WideDepart') {"), 'counted only when not refused');
  assert.ok(!body.includes("if (r?.ok !== false && d.name === 'WideDepart')"));
  assert.ok(body.indexOf('const n = r === undefined') < body.indexOf("d.name === 'WideDepart'"), 'the refusal is read before the count');
  // the controller's refusal path really answers undefined: failed() returns setNotice(), which returns nothing
  assert.ok(c.includes("const setNotice = n => { FS.notice = n; invalidate('panel'); };"));
});
