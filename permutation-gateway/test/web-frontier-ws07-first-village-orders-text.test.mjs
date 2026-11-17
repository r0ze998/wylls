// ⑦ the first village, from arrival to the next thing to do (Lane C, 2026-11-17): the village is granted → 「村へ」
// (home-begin) lands on the build card → the first build → the guide's scout step (train 100 Scouts, form them up) →
// what became of each order → on with the village. What was already connected and is NOT rebuilt: the landing on the
// build card, the build's wait and countdown, the forming / resting / exploring states of the scout step, collecting
// the exploration, the village screen's own note of its orders. What was missing: the guide's OWN orders — 「斥候を
// 訓練する」 / 「斥候隊を編成する」 — were offered again after every answer with no word of the last press; after an answer
// that was not read, or one accepted that the village's record did not show yet, a second press trained or formed up
// again. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs, app.mjs,
// screens/onboarding.mjs, screens/villageorders.mjs and the English dictionary are read as TEXT, not imported (they load
// fi18n.mjs and lang.mjs, the subjects of refused tests). It runs no page, herald or world, and sends nothing.
//   Expected, case by case:
//   F1 the arrival is connected as it was: home-begin acknowledges the grant and opens the village; the app lands on
//      the build card; nothing of the join, the session, the ticket or the placing is touched
//   F2 an order record is classed in ONE place (orderOutcome): not sent / sent and failed / sent, outcome unknown —
//      both shapes: refused with `sent` and a tracker's code, and 'unconfirmed' with any code but the local hold's — /
//      held (local) / accepted
//   F3 which record the guide reads, for the step's own kind and unit (Train or Muster, Scouts), made under the
//      context the page is in NOW; and whose village it was — ONLY what the record itself holds, nothing reasoned on
//      top (CORRECTED THREE TIMES — first: only this turn's records; second: a muster was this village's whenever the
//      province matched; third: whenever its formation tile was the village's tile, with the village's ticket turn read
//      as a founding time. A formation tile is not the source village; no record field proves a generation):
//      - a MUSTER's record names where the host forms up, never the village that gave it — also when that tile is this
//        village's own. Its village is ALWAYS unknown. It is read as a record of this province: not confirmed (any
//        turn), or accepted this turn — and never as "this village's order"
//      - a TRAIN's record carries the tile of the village in hand at the order: the village's own tile → given from
//        the village on this tile. The record names no site and no generation; that it is the PRESENT village's is not
//        claimed (the carried note says so)
//        · not confirmed → read whatever its turn, newest first, before a later answer
//        · an answer (accepted, sent and failed, not sent) → only of THIS turn
//      - another tile of the province (for an order that carries its village's tile) → village unknown, as above
//      - another province → never read; a record of another context (viewer, herald, world) → never read
//      - no village's ticket turn, founding time or any other field is used to tell generations apart
//      - the village screen's own list keeps its rule (a muster by province) — unchanged here, and named as a limit
//      - limits: the last ORDERS_MAX records, in memory only
//   F4 what the guide says: accepted → "accepted this turn; it may not be in the village record yet; ordering again
//      does it once more"; unknown → "sent, result not confirmed (not 'not sent'); ordering again may do it twice";
//      held → "press the button below again to check its result"; sent and failed / not sent → as that, with the reason.
//      After accepted or unknown the step's button stays but is no longer the main press, and the pure re-read of the
//      village stands beside it; nothing is disabled
//   F5 the "next thing" pill does not send the order again by itself after accepted or unknown: it opens the guide
//   F6 nothing here sends or decides: the two guide orders are the controller's own (homeAction → trainOrder /
//      musterOrder), unchanged; the note and the pill read only
//   F7 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs'), ob = read('frontier/screens/onboarding.mjs'), vo = read('frontier/screens/villageorders.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const note = fnOf(ob, 'function scoutOrderNote(FS, h, kind) {'), step = fnOf(ob, 'export function renderScoutAction(FS) {'), pill = fnOf(ob, 'function scoutObjective(FS) {');

test('F1 the arrival lands on the build card, as it did', () => {
  const hb = ctl.slice(ctl.indexOf("  'home-begin': () => {"), ctl.indexOf("  'home-scout-train': () =>"));
  order(hb, 'const h = ackHomeGrant();', 'if (!h) return;', "FS.tab = 'holding';");
  const at = app.indexOf("  'home-begin': () => {"), land = app.slice(at, app.indexOf('\n  },\n', at) + 5);
  order(land, "ACTIONS['home-begin']();", "const panel = $('hp-build');", "panel?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });");
  assert.ok(read('frontier/screens/holding.mjs').includes('<section class="vcard" id="hp-build" aria-labelledby="hp-build-h">'), 'the build card it lands on');
});

test('F2 an order record is classed in one place', () => {
  const oc = fnOf(vo, 'export function orderOutcome(o) {');
  order(oc, "if (o?.state === 'unconfirmed') return o.code === LOCAL_HOLD_CODE ? 'held' : 'unknown';",
    "if (o?.state === 'refused') return o.sent !== true ? 'notSent' : UNKNOWN_OUTCOME_CODES.includes(o.code) ? 'unknown' : 'sentFailed';", "return o?.state === 'accepted' ? 'accepted' : null;");
  assert.equal((vo.match(/o\??\.state === '/g) ?? []).length, 3, 'no second classing of a record\'s state');
  assert.ok(vo.includes("export const LOCAL_HOLD_CODE = 'LocalActUnconfirmed';"));
  assert.ok(vo.includes("export const UNKNOWN_OUTCOME_CODES = Object.freeze(['Unconfirmed', 'TxUnqueryable']);"));
});

test('F3 the newest order of this village, this turn, this kind and unit', () => {
  const lv = fnOf(vo, 'export function latestVillageOrder(FS, h, match) {'), place = fnOf(vo, 'export function orderPlace(o, h) {');
  assert.ok(vo.includes("export const OWN_TILE_KINDS = Object.freeze(['muster', 's1-fort']);"));
  order(place, 'if (!o?.tile || !h || o.tile.p !== h.p || o.tile.q !== h.q) return null;', "return !OWN_TILE_KINDS.includes(o.kind) && o.tile.tile === h.tile ? 'tile' : 'unknown';");
  assert.doesNotMatch(codeOf(vo), /ticketBell|finalTs|\.gen\b|\.site\b/, 'no field is read as a village\'s founding or generation');
  order(lv, 'if (!h) return null;', "const turn = FS.nowBell ?? null, open = x => { const c = orderOutcome(x); return c === 'unknown' || c === 'held'; };",
    "const all = (FS.orders ?? []).filter(x => ofContext(FS, x) && match(x)), here = all.filter(x => orderPlace(x, h) === 'tile');", 'const o = here.find(open) ?? here.find(x => x.turn === turn) ?? null;',
    "const loose = o ? [] : all.filter(x => orderPlace(x, h) === 'unknown');", "const far = loose.find(open) ?? loose.find(x => x.turn === turn && orderOutcome(x) === 'accepted') ?? null;",
    'const pick = o ?? far, outcome = pick ? orderOutcome(pick) : null;', "carried: pick.turn !== turn, place: o ? 'tile' : 'unknown' } : null;");
  assert.doesNotMatch(codeOf(lv), /ofVillage\(/, 'the guide\'s lookup does not take a province for a village');
  // what the records hold of their place: the village's own tile by default; a muster's own tile; no site, no generation
  assert.ok(ctl.includes('const tile = extra.tile && Number.isInteger(extra.tile.tile) ? { p: extra.tile.p, q: extra.tile.q, tile: extra.tile.tile } : h && Number.isInteger(h.tile) ? { p: h.p, q: h.q, tile: h.tile } : null;'));
  assert.ok(ctl.includes("order: orderOf('muster', 'Muster', { unit, troops, tile: h ? { p: h.p, q: h.q, tile: at } : null,"));
  assert.ok(ctl.includes('const at = Number.isInteger(tile) ? tile : h?.tile;'), 'the guide\'s own muster names no tile: it forms up on the village\'s');
  // the context a record was made under: the controller's own count of orders, and the floor set when the context moves
  assert.ok(vo.includes("export const ofContext = (FS, o) => { const n = Number(String(o?.id ?? '').slice(1)); return !Number.isInteger(FS.orderFloor) || (Number.isInteger(n) && n > FS.orderFloor); };"));
  assert.ok(ctl.includes('const nextContext = () => { contextSeq += 1; FS.contextSeq = contextSeq; FS.orderFloor = orderSeq; };'));
  // (the start of the line only: the adopted order chain adds its own field at the end of it)
  assert.ok(ctl.includes("return { ...extra, id: `o${++orderSeq}`, kind, name, turn: nowBell(),"), 'the number an order is made with');
  assert.equal((ctl.match(/nextContext\(\);/g) ?? []).length, 3, 'another viewer, herald, world');
  assert.equal((ctl.match(/orderSeq/g) ?? []).length, 3, 'its declaration, orderOf, the floor — nothing else reads or writes it');
  assert.ok(ctl.includes('export const ORDERS_MAX = 40;'), 'the page keeps this many records');
  // (the village screen's own list keeps its rule — unchanged)
  assert.ok(vo.includes("const ofVillage = (o, h) => !!o?.tile && o.tile.p === h.p && o.tile.q === h.q && (o.kind === 'muster' || o.kind === 's1-fort' || o.tile.tile === h.tile);"));
  order(note, 'const x = latestVillageOrder(FS, h, o => o.kind === kind && o.unit === SCOUT);', 'if (!x) return null;');
  // the records the guide's two orders write: the controller's own, with their unit
  assert.ok(ctl.includes("return act('Train', { v: { holding: activeHolding(FS) }, fields: { unit, n }, order: orderOf('train', 'Train', { unit, n,"));
  assert.ok(ctl.includes("  'home-scout-train': () => homeAction(() => trainOrder(6, 100)),"));
  assert.ok(ctl.includes("  'home-scout-muster': () => homeAction(() => musterOrder(6, 100)),"));
});

test('F4 what the guide says of the last press', () => {
  // a record whose village is not in it (every muster; another tile): said as a record of this province — careful, and
  // nothing claimed of this village
  order(note, "if (x.place !== 'tile') {", "return { outcome: x.outcome, again: false, place: x.place,", 'data-place="unknown">${x.outcome === \'accepted\'',
    '? L`この州で、このターンに${name}の命令が受け付けられています。この村の命令かどうかは、記録からは分かりません。`',
    ': L`この州で出した${name}の命令（ターン ${fmtNum(x.turn ?? 0)}）に、結果をまだ確認できていないものがあります。この村の命令かどうかは、記録からは分かりません。`}</p>',
    "x.outcome === 'accepted' ? L`${name}は、このターンに受け付けられています。村の記録に、まだ出ていないことがあります。もう一度命じると、もう一度行います。`",
    ": x.outcome === 'unknown' ? L`${name}は送信済みで、結果をまだ確認できていません（送っていない、という意味ではありません）。もう一度命じると、二重になることがあります。`",
    ": x.outcome === 'held' ? L`${name}は送信済みで、結果をまだ確認できていません。同じ命令は送り直しません。下のボタンをもう一度押すと、結果を確認します。`",
    ": x.outcome === 'sentFailed' ? L`${name}は送信しましたが、成立しませんでした。` : L`${name}は、送られていません。`;", "const careful = x.outcome === 'accepted' || x.outcome === 'unknown';",
    'に、この村のマスから出した命令です。ターンが進んでも、結果が確かめられたわけではありません。命令の記録は村の世代を持たないので、いまの村の命令であることまでは、記録からは分かりません。）',
    "return { outcome: x.outcome, again: !careful, place: 'tile',", 'data-carried="${x.carried ? 1 : 0}" data-place="tile">${text}${earlier}',
    'careful && villageRereadOffered(FS) ? html`<button type="button" class="btn primary" data-act="village-reread">');
  order(step, "const on = scoutOrderNote(FS, h, 'muster'); return html`${on?.note ?? ''}<p>", "class=\"btn${on && !on.again ? '' : ' primary'}\" data-act=\"home-scout-muster\"",
    "const on = scoutOrderNote(FS, h, 'train');", "return html`${on?.note ?? ''}<p>", "class=\"btn${on && !on.again ? '' : ' primary'}\" data-act=\"home-scout-train\"");
  assert.doesNotMatch(note + step.slice(step.indexOf("scoutOrderNote(FS, h, 'muster')")), /disabled/, 'nothing is disabled: the button stays');
  // the states the step already had are as they were
  order(step, 'if (FS.inFlight > 0 || FS.homeActionBusy) return html`<p class="home-status" role="status">${L`命令の結果を確認しています。まもなく次の手順が表示されます。`}</p>`;',
    'if (h.explore?.state > 0) {', 'if (homeUnread(FS, h)) return html`<p class="home-status" role="status">${L`記録を読み込んでいます…`}</p>`;', 'const forming = rows.find(r => r.state === 2);');
});

test('F5 the pill does not send again by itself', () => {
  order(pill, "const muster = Number(h?.reserve?.[SCOUT] ?? 0) >= 100, on = h ? scoutOrderNote(FS, h, muster ? 'muster' : 'train') : null;",
    "if (on && !on.again) return { act: 'guide-open', data: {}, label: L`斥候の命令の結果を確かめる` };", "? { act: 'home-scout-muster', data: {}, label: L`斥候隊を編成する` }",
    ": { act: 'home-scout-train', data: {}, label: L`斥候を訓練する` };");
});

test('F6 nothing here sends or decides', () => {
  assert.doesNotMatch(codeOf(note), /\bact\(|homeAction|trainOrder|musterOrder|FS\.[A-Za-z0-9]+ = |invalidate\(|herald|io\./, 'the note reads only');
  assert.doesNotMatch(codeOf(fnOf(vo, 'export function latestVillageOrder(FS, h, match) {') + fnOf(vo, 'export function orderOutcome(o) {')), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(/);
  const ha = fnOf(ctl, 'async function homeAction(run) {');
  order(ha, 'if (FS.homeActionBusy || FS.inFlight > 0) return;', 'FS.homeActionBusy = true;', 'try { const result = await run(); if (result?.ok) await refresh(); return result; }', 'finally { FS.homeActionBusy = false;');
  assert.ok(ob.includes("import { latestVillageOrder, villageRereadOffered } from './villageorders.mjs';"));
});

test('F7 English follows; no banned word', () => {
  for (const k of ['斥候の訓練', '斥候隊の編成', '{0}は、このターンに受け付けられています。村の記録に、まだ出ていないことがあります。もう一度命じると、もう一度行います。',
    '{0}は送信済みで、結果をまだ確認できていません（送っていない、という意味ではありません）。もう一度命じると、二重になることがあります。',
    '{0}は送信済みで、結果をまだ確認できていません。同じ命令は送り直しません。下のボタンをもう一度押すと、結果を確認します。', '{0}は送信しましたが、成立しませんでした。', '{0}は、送られていません。',
    '斥候の命令の結果を確かめる', '村の記録を読み直す', '（ターン {0} に、この村のマスから出した命令です。ターンが進んでも、結果が確かめられたわけではありません。命令の記録は村の世代を持たないので、いまの村の命令であることまでは、記録からは分かりません。）',
    'この州で出した{0}の命令（ターン {1}）に、結果をまだ確認できていないものがあります。この村の命令かどうかは、記録からは分かりません。',
    'この州で、このターンに{0}の命令が受け付けられています。この村の命令かどうかは、記録からは分かりません。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
