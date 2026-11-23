// fix-loop10-cosmetic: loop-play10's cosmetic BREAKs LP10-2…5 on the page side (TEST-only local worlds), Japanese and
// English. Key-free, no process, no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { wideHostRef, wideHostAlias, readWideProvince } from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { createWideHostPlanner, followWideHold, markWideHoldExpedition } from '../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';
import * as W from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import { pickModel, pickLabelText } from '../../permutation-server/web/frontier/map/picktile.mjs';

const WEB = new URL('../../permutation-server/web/', import.meta.url);
const src = f => readFileSync(new URL(`frontier/${f}`, WEB), 'utf8');
const JA = /[぀-ヿ一-鿿]/;
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', SEASON_ID = '11';
const SEASON = seasonAddresses(PROGRAM, SEASON_ID).season;
const WORLD = worldIdOf(SEASON, PROGRAM);
const village = { p: '130', q: '-1', site: 4 };
const GENESIS = 1_000_000, ASTER = 3, BOREALIS = 4;
const season = { seasonId: SEASON_ID, genesisTs: GENESIS, drandGenesis: 0, drandPeriod: 3, seedMargin: 0, endBell: 100000 };
const herald = { season: async () => ({ ok: true, season, record: {} }) };
const holdingBytes = ({ reserve = 0, hostSeq = 2 } = {}) => { const hb = new Uint8Array(1344), hv = new DataView(hb.buffer); hb[69] = 1; hb[70] = 17; hb[71] = 2; hb[112] = ASTER; hv.setUint32(132, hostSeq, true); hv.setUint32(720, reserve, true); return hb; };
/** A wide province record: `hosts` [{seq, troops, state}] of this village (nation Aster); `keep` {holder, contender, progress, troops}. */
const provinceBytes = (resolvedNext, { hosts = [], keep = null } = {}) => {
  const pv = new Uint8Array(4864), v = new DataView(pv.buffer); v.setUint32(72, resolvedNext, true); pv[4480] = 0xff;
  hosts.forEach((h, i) => { const o = 1064 + i * 48; v.setBigUint64(o, wideHostAlias(wideHostRef({ world: WORLD, ...village, gen: 1, seq: h.seq })), true); pv[o + 8] = ASTER; pv[o + 10] = 30; pv[o + 11] = h.state ?? 1; v.setUint32(o + 12, h.troops, true); });
  if (keep) { pv[4480] = 30; pv[4481] = keep.holder; pv[4482] = keep.contender ?? 0xff; pv[4483] = keep.progress ?? 0; pv[4484] = 72; v.setUint32(4488, keep.troops ?? 100, true); }
  return pv;
};
const plannerAt = (nowBell, { dest }) => createWideHostPlanner({ herald, chainNow: async () => GENESIS + nowBell * 600 + 1,
  read: async addrs => (addrs.length === 1 ? [dest] : addrs.map((_, i) => (i === 0 ? holdingBytes() : i === 1 ? provinceBytes(nowBell - 1) : null))) });
const TO = { p: '-65', q: '-64', tile: 30, holder: BOREALIS };
const memory = () => ({ decisions: 9, wideHostUntil: 3, wideDeparts: 2, lastWideDepart: { to: TO, arrive: 427, troops: 100 } });
const marchAt = async (nowBell, dest) => (await plannerAt(nowBell, { dest }).decide({ programId: PROGRAM, seasonAddress: SEASON }, memory(), { wideTargets: [], villages: [village] })).march;

// loop-play10 LP10-2: the W2 village's second march (100 troops, arrival 427) went onto the keep of -65,-64, which the
// player's own EXPEDITION (1,289) had held since turn ~360. The keep was taken at 433 and the W2 card said 「結果：州
// -65,-64 の砦を奪いました。…砦を奪った軍勢は、その砦に残って守っています。」 — as if these 100 troops had taken it.
test('LP10-2: a W2 host that joined a hold its nation already ran — the card says whose capture it was (expedition / another host / already yours), JA and EN', async () => {
  // turn 428: the host stands; the keep's count is 68 of 72 — one turn after the host's arrival
  let march = await marchAt(428, provinceBytes(428, { hosts: [{ seq: 1, troops: 100_000 }], keep: { holder: BOREALIS, contender: ASTER, progress: 68, troops: 0 } }));
  assert.deepEqual([march.phase, march.troops, march.sent, march.state], ['stands', 100, 100, 1], 'the march carries what the host left with and its state');
  let hold = followWideHold(null, march);
  assert.deepEqual([hold.outcome, hold.progress, hold.shared], [null, 68, 'nation'], 'a count far ahead of this host\'s own turns there: another host began it');
  // (the page's own records: a kept expedition holds that keep and arrived first)
  const expeditions = [{ dest: { p: -65n, q: -64n, tile: 30 }, arriveBell: 357 }];
  hold = markWideHoldExpedition(hold, expeditions);
  assert.equal(hold.shared, 'expedition');
  assert.equal(markWideHoldExpedition(hold, expeditions), hold, 'marked once: the same object after');
  // turn 434: the keep is Aster's (garrison 644 from the expedition); this host still stands, untouched
  march = await marchAt(434, provinceBytes(434, { hosts: [{ seq: 1, troops: 100_000 }], keep: { holder: ASTER, troops: 644 } }));
  hold = followWideHold(hold, march);
  assert.deepEqual([hold.outcome, hold.at, hold.shared, hold.already], ['taken', 434, 'expedition', undefined]);
  setLang('ja');
  const ja = W.wideHoldOutcomeText(hold);
  assert.equal(ja, '結果：州 -65,-64 の砦はあなたの国のものになりました（ターン 434 に確認）。あなたの遠征の軍勢が先に着いて占拠を進めていた砦です。この村の軍勢だけで奪ったのではありません。');
  assert.doesNotMatch(ja, /砦を奪いました/, 'not the sentence that credits this host');
  assert.equal(W.wideHostSayText({ kind: 'wait', wait: 'march', hold }), ja, 'what the card says');
  assert.match(W.wideHostSayText({ kind: 'wait', wait: 'cap', cap: 2, hold }), /^結果：州 -65,-64 の砦はあなたの国のものになりました.* 2 回までです/, 'and at the TEST cap, before the cap\'s words');
  let line = String(W.wideHostWaitLine({ reason: 'captured', lag: 2, hold }));
  assert.match(line, /data-wide-host-wait="captured"/); assert.match(line, /data-wide-host-joined="expedition"/);
  assert.match(line, /この村の軍勢は、その砦のマスに着いています。/); assert.doesNotMatch(line, /砦を奪った軍勢は/);
  // without the expedition's record: another host of the nation
  const nation = followWideHold(followWideHold(null, await marchAt(428, provinceBytes(428, { hosts: [{ seq: 1, troops: 100_000 }], keep: { holder: BOREALIS, contender: ASTER, progress: 68 } }))), march);
  assert.equal(W.wideHoldOutcomeText(nation), '結果：州 -65,-64 の砦はあなたの国のものになりました（ターン 434 に確認）。あなたの国の別の軍勢が先に占拠を進めていた砦です。この村の軍勢だけで奪ったのではありません。');
  // the keep already the nation's when the host is first seen there, untouched (state 1, the troops it left with)
  const already = markWideHoldExpedition(followWideHold(null, march), expeditions);
  assert.deepEqual([already.outcome, already.already, already.shared], ['taken', true, 'expedition']);
  assert.equal(W.wideHoldOutcomeText(already), '結果：州 -65,-64 の砦は、この村の軍勢が着いたときにはすでにあなたの国のものでした（ターン 434 に確認）。この軍勢が奪ったのではありません。 あなたの遠征の軍勢が先に着いていた砦です。');
  assert.equal(W.wideHoldOutcomeText({ ...already, shared: undefined }), '結果：州 -65,-64 の砦は、この村の軍勢が着いたときにはすでにあなたの国のものでした（ターン 434 に確認）。この軍勢が奪ったのではありません。');
  assert.match(String(W.wideHostWaitLine({ reason: 'captured', hold: already })), /data-wide-host-joined="already"/);
  // English: every new sentence has its own, with no Japanese left
  setLang('en');
  try {
    assert.equal(W.wideHoldOutcomeText(hold), 'Result: the keep of province -65,-64 is now your nation\'s (seen at turn 434). Your expedition reached it first and was already holding it. This village\'s host did not take it alone.');
    for (const t of [W.wideHoldOutcomeText(nation), W.wideHoldOutcomeText(already), W.wideHoldOutcomeText({ ...already, shared: undefined })]) { assert.ok(t.length > 20); assert.doesNotMatch(t, JA, t); }
    line = String(W.wideHostWaitLine({ reason: 'captured', hold }));
    assert.match(line, /This village&#39;s host has reached that keep&#39;s tile\./); assert.doesNotMatch(line.replace(/<[^>]*>/g, ''), JA);
  } finally { setLang('ja'); }
});

test('LP10-2: a host that took its keep ALONE is still said to have taken it (the count began with it; a donor is not "already yours"; an expedition that came later did not hold first)', async () => {
  // the solo march: first seen 3 turns after its arrival with a count of 3
  let march = await marchAt(430, provinceBytes(430, { hosts: [{ seq: 1, troops: 43_000 }], keep: { holder: BOREALIS, contender: ASTER, progress: 3 } }));
  let hold = followWideHold(null, march);
  assert.deepEqual([hold.outcome, hold.shared], [null, undefined]);
  // (first seen late: the count is as old as the host's stay — still its own)
  const late = followWideHold(null, await marchAt(470, provinceBytes(470, { hosts: [{ seq: 1, troops: 43_000 }], keep: { holder: BOREALIS, contender: ASTER, progress: 43 } })));
  assert.equal(late.shared, undefined);
  // (an expedition that reached the keep AFTER this host did not hold it first)
  assert.equal(markWideHoldExpedition(hold, [{ dest: { p: '-65', q: '-64' }, arriveBell: 440 }]), hold);
  assert.equal(markWideHoldExpedition(hold, [{ dest: { p: '-64', q: '-66' }, arriveBell: 300 }]), hold, 'another province');
  // the capture: the host became the garrison and left the entries
  march = await marchAt(500, provinceBytes(500, { keep: { holder: ASTER, troops: 21 } }));
  hold = followWideHold(hold, march);
  assert.deepEqual([hold.outcome, hold.shared, hold.already], ['taken', undefined, undefined]);
  setLang('ja');
  assert.equal(W.wideHoldOutcomeText(hold), '結果：州 -65,-64 の砦を奪いました。砦はあなたの国のものです（ターン 500 に確認）。');
  assert.match(String(W.wideHostWaitLine({ reason: 'captured', hold })), /砦を奪った軍勢は、その砦に残って守っています。/);
  // first seen only AFTER its own capture: the donor is retired (state 3) with what the garrison left it — not "already yours"
  const donor = followWideHold(null, await marchAt(500, provinceBytes(500, { hosts: [{ seq: 1, troops: 22_000, state: 3 }], keep: { holder: ASTER, troops: 21 } })));
  assert.deepEqual([donor.outcome, donor.already], ['taken', undefined]);
  assert.match(W.wideHoldOutcomeText(donor), /の砦を奪いました。/);
});

test('LP10-2: the controller marks the hold from the page\'s own expedition records, beside the pinned follow line', () => {
  const c = src('controller.mjs');
  assert.ok(c.includes("if (w.march) mem.wideHold = followWideHold(mem.wideHold ?? null, w.march);\n"), 'the follow line is unchanged');
  assert.ok(c.includes('mem.wideHold = markWideHoldExpedition(mem.wideHold, localExpedition.holdingExpeditions(FS));'));
  assert.ok(src('flocalplay-expedition.mjs').includes("export const holdingExpeditions = (fs, seals = localDepartReveals) => expeditionRows(fs, seals)\n  .filter(r => r.expedition.hold && r.expedition.hold.outcome !== 'lost' && r.expedition.dest)"), 'only expeditions with a followed hold that was not lost');
});

// loop-play10 LP10-3: bar 「編成」 → the muster pick open → switch to English: the canvas tag 「ここに集める」 stayed Japanese
// (app.mjs built the words once, when the pick opened).
test('LP10-3: a pick\'s tag over the lit tiles follows the page\'s language — the label is a function, read at every paint', () => {
  setLang('ja');
  const label = () => L`ここに集める`;
  const model = pickModel({ kind: 'muster', tiles: [{ p: 2, q: 0, tile: 6 }, { p: 2, q: 0, tile: 8 }], origin: { p: 2, q: 0, tile: 7 }, label });
  assert.equal(typeof model.label, 'function', 'the model keeps the function');
  assert.equal(pickLabelText(model.label), 'ここに集める');
  setLang('en');
  try { assert.equal(pickLabelText(model.label), 'Form here', 'the SAME open pick, after the switch'); } finally { setLang('ja'); }
  // (a plain string still works: the effects demo, older callers)
  assert.equal(pickModel({ kind: 'muster', tiles: [{ p: 2, q: 0, tile: 6 }], label: 'here' }).label, 'here');
  assert.equal(pickLabelText('here'), 'here'); assert.equal(pickLabelText(null), ''); assert.equal(pickLabelText(() => { throw new Error('x'); }), '');
  // the page hands functions, the board paints them now, and a language change repaints an open pick
  const app = src('app.mjs'), map = src('map/fmap.mjs');
  assert.ok(app.includes("const PICK_LABEL = { muster: () => L`ここに集める`, explore: () => L`ここを調べる`, dress: () => L`ここを広げる` };"));
  assert.ok(app.includes('const label = pickLabel(kind);')); assert.ok(app.includes("label: pickLabel('dress')"));
  assert.doesNotMatch(app, /label = kind === 'muster' \? L`/, 'no words built once');
  assert.ok(app.includes('onLangChange(() => { if (FS.hand?.pick) { try { mapRef?.tick?.(); }'), 'the canvas is painted again');
  assert.ok(map.includes("const pickWord = A?.mode === 'pick' ? pickLabelText(A.label) : '';")); assert.ok(map.includes('paintBellTag(ctx, top.x, top.y, pickWord, {'));
  assert.doesNotMatch(map, /paintBellTag\(ctx, top\.x, top\.y, A\.label/);
});

// loop-play10 LP10-4: the keep hand's odds rule said 「見張り塔」; the page's word for the building is 「物見櫓」 (LP8-8).
test('LP10-4: the page says 物見櫓 everywhere — no 「見張り塔」 left in the page code or its English table', () => {
  const walk = dir => readdirSync(dir).flatMap(n => { const p = new URL(`${n}`, dir); return statSync(p).isDirectory() ? walk(new URL(`${n}/`, dir)) : /\.(mjs|html)$/.test(n) ? [p] : []; });
  const left = [...walk(new URL('frontier/', WEB)), ...walk(new URL('lang/', WEB))].filter(p => readFileSync(p, 'utf8').includes('見張り塔')).map(p => p.pathname.split('/web/')[1]);
  assert.deepEqual(left, []);
  const rule = '勝ち目は、着いたターンの戦いを記録の守備兵と城壁と地形で計算した目安です。戦いの後に強さ（兵 × 1 人の強さ）が多く残った側がマスに残り、同じなら砦の側が残ります。運の揺れ（±10%）を含め、ほかの軍勢、教義の効果、道中の物見櫓で減る兵（最大 30%）は含みません。';
  assert.ok(src('hud/keephand.mjs').includes(`\${L\`${rule}\`}`));
  setLang('en');
  try { const en = L([rule]); assert.match(en, /watchtowers wear away on the road \(up to 30%\)/); assert.doesNotMatch(en, JA); } finally { setLang('ja'); }
});

// loop-play10 LP10-5: after the capture the expedition's card said 「砦を奪いました：軍勢は砦の守備兵になりました（兵 1,289）」 —
// the strength the host arrived with. The chain's keep record held a garrison of 644 (a capture leaves half of the
// holding host in the keep).
test('LP10-5: a taken keep\'s count is the chain keep record\'s garrison (and its turn), never the host\'s arrival strength, JA and EN', async () => {
  const X = await import('../../permutation-server/web/frontier/flocalplay-expedition.mjs');
  const { renderExpedition, expeditionTroopsNote } = await import('../../permutation-server/web/frontier/screens/tracker.mjs');
  const { canonicalOriginalHostRef, canonicalWideProvinceKey, packWidePlain } = await import('../../permutation-server/web/frontier/fexpedition-seal.mjs');
  const { seasonPda, withSeed, seedOf } = await import('../../permutation-server/web/frontier/faddr.mjs');
  const seasonKey = seasonPda(PROGRAM, 11)[0], world = worldIdOf(seasonKey, PROGRAM);
  const host = canonicalOriginalHostRef({ world, p: '-66', q: '128', site: 2, gen: 0, seq: 0 });
  const dest = canonicalWideProvinceKey({ world, p: '-65', q: '-64' });
  const r = { host, transitSlot: 0, commit: 'e'.repeat(64), arriveBell: 357, signature: 'sig', holding: withSeed(seasonKey, seedOf('Holding', { p: -66, q: 128, site: 2 }), PROGRAM), revealed: null,
    plain: packWidePlain({ version: 2, host, arriveBell: 357, dest, destTile: 59, stance: 0, retreatBps: 0, pathLen: 0, path: '00'.repeat(12), reserved: '00'.repeat(8) }) };
  const fs = { nowBell: 420, mode: 'play', holdings: [] };
  X.expeditionFactsOf(fs).set(r.commit, { facts: { transit: 'gone', fate: 'stays', settled: true, troopsAfter: 1_289_056, slotI: null, present: true, resolved: true }, bell: 358 });
  const pvAt = ({ contender = 0xff, holder = BOREALIS, progress = 0, hostTroops = 1_289_056, garrison = 0 }) => {
    const pv = new Uint8Array(4864), v = new DataView(pv.buffer); v.setUint32(72, 433, true);
    const o = 1064; v.setBigUint64(o, 99n, true); pv[o + 8] = ASTER; pv[o + 10] = 59; pv[o + 11] = 1; v.setUint32(o + 12, hostTroops, true);
    pv[4480] = 59; pv[4481] = holder; pv[4482] = contender; pv[4483] = progress; pv[4484] = 72; v.setUint32(4488, garrison, true);
    return pv;
  };
  let bytes = pvAt({ contender: ASTER, progress: 60 });
  const deps = { read: async () => [bytes], parse: readWideProvince, address: (p, q) => `wide:${p},${q}`, faction: ASTER, seals: () => [r] };
  await X.readExpeditionHolds(fs, { ...deps, nowBell: 420 });
  setLang('ja');
  let card = String(renderExpedition(X.expeditionRows(fs, () => [r])[0], fs));
  assert.match(card, /留まる：軍勢は広い土地の州に立っています <span class="muted">（兵 1,289）<\/span>/, 'while it holds: the host\'s own strength, as before');
  assert.deepEqual(X.holdingExpeditions(fs, () => [r]).map(x => [String(x.dest.p), String(x.dest.q), x.arriveBell]), [['-65', '-64', 357]], 'LP10-2: this expedition holds that keep');
  // turn 434 (w-keeplog.log 06:17:03): holder Aster, garrison 644, the host left with 645,056
  bytes = pvAt({ holder: ASTER, hostTroops: 645_056, garrison: 644 });
  await X.readExpeditionHolds(fs, { ...deps, nowBell: 434 });
  let row = X.expeditionRows(fs, () => [r])[0];
  assert.deepEqual([row.expedition.hold.outcome, row.expedition.hold.garrison, row.expedition.hold.garrisonAt], ['taken', 644, 434]);
  card = String(renderExpedition(row, fs));
  assert.match(card, /砦を奪いました：軍勢は砦の守備兵になりました <span class="muted" data-garrison="644">（砦の守備兵 644・ターン 434 の記録）<\/span>/);
  assert.doesNotMatch(card, /1,289/, 'the arrival strength is not shown as the garrison');
  // a later fight wears the garrison: the next read follows the chain, the end itself is unchanged (not said again)
  bytes = pvAt({ holder: ASTER, hostTroops: 645_056, garrison: 601 });
  await X.readExpeditionHolds(fs, { ...deps, nowBell: 470 });
  row = X.expeditionRows(fs, () => [r])[0];
  assert.deepEqual([row.expedition.hold.outcome, row.expedition.hold.at, row.expedition.hold.garrison, row.expedition.hold.garrisonAt], ['taken', 434, 601, 470]);
  // the keep lost later: the last own record stays, with its turn
  bytes = pvAt({ holder: BOREALIS, garrison: 900 });
  await X.readExpeditionHolds(fs, { ...deps, nowBell: 480 });
  assert.deepEqual([X.expeditionRows(fs, () => [r])[0].expedition.hold.garrison, X.expeditionRows(fs, () => [r])[0].expedition.hold.garrisonAt], [601, 470]);
  // not read: no number rather than the wrong one
  assert.equal(String(expeditionTroopsNote({ fate: 'stays', hold: { outcome: 'taken', at: 434 } }, 1289)), '');
  assert.equal(String(expeditionTroopsNote({ fate: 'destroyed', hold: null }, 0)), '');
  setLang('en');
  try {
    card = String(renderExpedition(X.expeditionRows(fs, () => [r])[0], fs));
    assert.match(card, /Keep taken: the host became the keep&#39;s garrison <span class="muted" data-garrison="601">\(keep garrison 601, as recorded at turn 470\)<\/span>/);
    assert.doesNotMatch(card.replace(/<[^>]*>/g, ''), JA);
  } finally { setLang('ja'); }
});
