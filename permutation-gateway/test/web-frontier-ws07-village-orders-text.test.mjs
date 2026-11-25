// ⑦ the village screen says what became of the orders given from it (Lane C, 2026-11-17): harvest, build, walls,
// promotion, train, muster, garrison → the controller's order lifecycle (FS.orders) → the village screen, where the
// results show (queue, tier, stores, reserve). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: screens/villageorders.mjs, screens/holding.mjs, controller.mjs, fplay.mjs and the English
// dictionaries are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of refused tests).
// A text check of the connection; it runs no page, herald or world, and sends nothing.
//   Expected, case by case:
//   O1 the lifecycle's records, as the controller writes them (unchanged by this work): accepted; refused with `sent`
//      false (nothing left the browser) or true (sent: failed, expired, or outcome not read — codes Unconfirmed /
//      TxUnqueryable from fplay track); unconfirmed (local play, held by its signature)
//   O2 the classes: refused+not sent → notSent; refused+sent+unknown code, or 'unconfirmed' with a code other than the
//      local hold's → unknown (never "not sent", never failed, never "in the record"); refused+sent+other →
//      sentFailed; 'unconfirmed' with LocalActUnconfirmed → held; accepted and the record still behind → waiting;
//      accepted otherwise → not listed
//   O3 what the record says (CORRECTED — the first version matched orders to copies by number and order, counted failed
//      orders among them, and called an unknown order "in the record"):
//      - an unknown order stays unknown whatever the record holds; the record's count / queue is said beside it as a
//        fact of the record, with "the record does not say whether this order did it"
//      - a failed order with the same copy number as a later accepted one: nothing of one order is counted for
//        another, so the accepted one is `waiting` only while the record is below ITS OWN number, never for good
//      - two accepted orders with the same number: neither is claimed shown or not shown beyond its own number
//      - "waiting" says only what was read so far; it promises nothing of the next load
//   O4 only this village's orders of this turn: by province and tile (a muster by province)
//   O5 the module is pure: no act, no send, no save, no refresh, no change of FS; it disables nothing
//   O6 the unknown outcome offers the pure re-read (village-reread), once; not while one is under way, not in the
//      prototype rule's world, not doubled beside the read note's own button
//   O7 the village screen calls it with the settled village and the chain's second, beside the read note; the cards
//      and the action rows are as they were
//   O8 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const vo = read('frontier/screens/villageorders.mjs'), hs = read('frontier/screens/holding.mjs'), ctl = read('frontier/controller.mjs'), play = read('frontier/fplay.mjs');
const en = read('lang/en-frontier-play.mjs'), enHand = read('lang/en-frontier-hand.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const model = fnOf(vo, 'export function villageOrdersModel(FS, h, now, kinds = VILLAGE_ORDER_KINDS) {'), view = fnOf(vo, 'export function renderVillageOrders(FS, h, now, { rereadShown = false, kinds = VILLAGE_ORDER_KINDS, reread = null } = {}) {');

test('O1 the lifecycle records this reads are the controller\'s own', () => {
  assert.ok(ctl.includes("const rec = { ...o, ...extra, state: ok ? 'accepted' : 'refused' };"));
  assert.ok(ctl.includes("const rec = { ...o, state: 'unconfirmed', sent: true, signature, code: 'LocalActUnconfirmed' };"));
  assert.ok(ctl.includes("const early = r => { orderAnswered(order, false, { code: r.code, sent: false }); return failed(r); };"));
  // (both shapes: this base's, and the one of main's order chain — adopted in the aggregate — where an ordinary-path
  //  unknown outcome is recorded 'unconfirmed' with the tracker's code and is not answered as refused)
  assert.match(ctl, /if \(!fxDone\) \{ fxEmit\('action:refused', fxa\); (if \(!unconfirmed\) )?orderAnswered\(order, false, \{ code, sent \}\); \}/);
  assert.ok(play.includes("return answered ? { ok: false, state: 'unknown', code: 'Unconfirmed' } : { ok: false, state: 'unqueryable', code: 'TxUnqueryable' };"));
  assert.ok(vo.includes("export const UNKNOWN_OUTCOME_CODES = Object.freeze(['Unconfirmed', 'TxUnqueryable']);"));
});

test('O2 each record is said as what it is', () => {
  assert.ok(vo.includes("export const LOCAL_HOLD_CODE = 'LocalActUnconfirmed';"));
  assert.ok(ctl.includes("code: 'LocalActUnconfirmed'"), 'the controller\'s own code for the hold');
  // (the classing moved to ONE place — orderOutcome — which the first village's guide reads too:
  //  web-frontier-ws07-first-village-orders-text.test.mjs; what each record is classed as is what it was)
  const outcome = fnOf(vo, 'export function orderOutcome(o) {');
  order(outcome, "if (o?.state === 'unconfirmed') return o.code === LOCAL_HOLD_CODE ? 'held' : 'unknown';",
    "if (o?.state === 'refused') return o.sent !== true ? 'notSent' : UNKNOWN_OUTCOME_CODES.includes(o.code) ? 'unknown' : 'sentFailed';", "return o?.state === 'accepted' ? 'accepted' : null;");
  order(model, "const outcome = orderOutcome(o), cls = outcome === 'accepted' ? (recordBehind(o, recordFactOf(o, h, now)) ? 'waiting' : null) : outcome;", 'if (!cls) continue;', 'out.push(');
  order(view, "if (x.cls === 'notSent')", '：送られていません。', "if (x.cls === 'sentFailed')", '：送信しましたが、成立しませんでした。', "if (x.cls === 'held')",
    '同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。', "if (x.cls === 'waiting')", '：受け付けられました。いま読めている村の記録には、まだ出ていません。',
    '// unknown:', 'この命令の結果は、まだ確認できていません（送られていない、という意味ではありません）。もう一度命じると、二重になることがあります。');
  // an unknown outcome is never worded as not sent, as failed, or as resolved by the record
  const unknownPart = view.slice(view.indexOf('// unknown:'));
  assert.doesNotMatch(unknownPart.replace(/（送られていない、という意味ではありません）/g, ''), /送られていません|成立しませんでした|記録には出ています/);
  assert.doesNotMatch(vo, /記録には出ています|次の読み込みで出ます/, 'no claim that the record shows an order, no promise of the next load');
});

test('O3 the record is a fact of its own, never proof of an order', () => {
  const fact = fnOf(vo, 'export function recordFactOf(o, h, now) {'), behind = fnOf(vo, 'export function recordBehind(o, fact) {'), words = fnOf(vo, 'function factWords(f) {');
  order(fact, "if (o.kind === 'build' && Number.isInteger(o.item) && BUILD_ITEMS[o.item]) return { kind: 'build', item: o.item, count: copyNumber(h, o.item) - 1 };",
    "if (o.kind === 'promote') return { kind: 'promote', tier: Number(h.tier ?? 0), queued: queueNow(h, now).some(q => q.item === ITEM_TIER_UP) };", 'return null;');
  order(behind, 'if (!fact) return false;', "if (fact.kind === 'build') return Number.isInteger(o.n) && fact.count < o.n;", 'return Number.isInteger(o.to) && fact.tier < o.to && !fact.queued;');
  // only the order's own number: no map of copies, no sorting of orders, no counting of one order for another
  assert.doesNotMatch(codeOf(vo), /copies|need\.(get|set|has)|\.sort\(|new Map\(/);
  // the fact is kept for the unknown class only, and worded with what the record cannot say
  // (the entry has since gained the order's `place` after `fact`; the fact itself is still the unknown class's only)
  assert.ok(model.includes("fact: cls === 'unknown' ? recordFactOf(o, h, now) : null, place: orderPlace(o, h) });"));
  assert.equal((model.match(/\bfact: /g) ?? []).length, 1, 'one fact field, set in one place');
  order(words, "if (f.kind === 'build')", 'つです（建設中を含みます）。この命令で増えたものかどうかは、記録からは分かりません。',
    '昇格の工事が列にあります。この命令によるものかどうかは、記録からは分かりません。', '昇格の工事は列にありません。');
  order(view, 'const fact = factWords(x.fact);', '<span class="vo-fact"> ${fact}</span>');
  // the order's own fields, as the controller writes them
  assert.ok(ctl.includes("order = orderOf('build', 'Build', { item, n, secs,"));
  assert.ok(ctl.includes("order = orderOf('promote', 'Build', { item, from: tier, to, secs,"));
});

test('O4 this village, this turn', () => {
  assert.ok(vo.includes("export const VILLAGE_ORDER_KINDS = Object.freeze(['harvest', 'build', 'walls', 'promote', 'train', 'muster', 'garrison']);"));
  assert.ok(vo.includes("const ofVillage = (o, h) => !!o?.tile && o.tile.p === h.p && o.tile.q === h.q && (o.kind === 'muster' || o.kind === 's1-fort' || o.tile.tile === h.tile);"));
  order(model, 'if (!h) return [];', 'const turn = FS.nowBell ?? null;', 'for (const o of FS.orders ?? []) {', 'if (!kinds.includes(o.kind) || o.turn !== turn || !ofVillage(o, h) || !ofContext(FS, o)) continue;');
});

test('O5 pure: it sends, saves and changes nothing', () => {
  const code = codeOf(vo);
  assert.doesNotMatch(code, /\bact\(|actOnce|io\.|tx\.|submit\(|refresh\(|rereadVillage\(|saveLand|storage|localStorage|fetch\(|pendingDriver|FS\.[A-Za-z]+ = |FS\.orders\.(push|splice|shift)|invalidate\(/);
  assert.doesNotMatch(code, /disabled/);
  assert.deepEqual([...code.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]).sort(),
    ['../../lang.mjs', '../../util.mjs', '../fi18n.mjs', '../fland.mjs', '../hud/icons.mjs', '../hud/rulebook.mjs']);
});

test('O6 the unknown outcome offers the pure re-read, once', () => {
  assert.ok(vo.includes("export const villageRereadOffered = FS => !!FS.wallet && !FS.proto && FS.mode === 'play' && FS.villageReread?.state !== 'loading';"));
  // (the button's action and words are the caller's — the trade card passes its own, web-frontier-ws07-s1-trade-read-text.test.mjs — and the village's by default)
  order(view, "const again = reread ?? { act: 'village-reread', label: L`村の記録を読み直す`, offered: villageRereadOffered(FS) };",
    "const ask = list.some(x => x.cls === 'unknown' || x.cls === 'waiting') && !rereadShown && again.offered === true;", 'data-act="${again.act}"');
  assert.equal((view.match(/data-act="/g) ?? []).length, 1, 'the only action here is the re-read');
  assert.ok(ctl.includes("  'village-reread': () => { rereadVillage().catch(() => {}); },"));
});

test('O7 the village screen is the consumer', () => {
  assert.ok(hs.includes("import { renderVillageOrders } from './villageorders.mjs';"));
  order(fnOf(hs, 'export function render(FS) {'), 'const readNote = renderHoldingRead(FS);',
    'const orderNote = renderVillageOrders(FS, m.settled, m.now, { rereadShown: holdingRead(FS).reread.can });',
    'return [...(wideStatus ? [wideStatus] : []), readNote || orderNote ? html`${head}${readNote}${orderNote}` : head, stores, ...(researchCard ? [researchCard] : []), ...(wideCard ? [wideCard] : []), build, troops, ...(s1On() ? [renderS1Village(FS)] : []), others];');
  assert.ok(hs.includes('const actionBusy = FS.inFlight > 0 || !!FS.homeActionBusy;'), 'the buttons\' own gate is as it was');
});

test('O8 English follows; no banned word', () => {
  for (const k of ['{0}の建設', '城壁の工事', '{0}の訓練', '{0}の編成', '守備隊の増員', 'この村から出した命令', '{0}：送られていません。', '{0}：送信しましたが、成立しませんでした。',
    '{0}：送信済みです。結果はまだ確認できていません。同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。',
    '{0}：受け付けられました。いま読めている村の記録には、まだ出ていません。',
    '{0}：送信済みです。この命令の結果は、まだ確認できていません（送られていない、という意味ではありません）。もう一度命じると、二重になることがあります。',
    'いま読めている村の記録では、{0}は {1} つです（建設中を含みます）。この命令で増えたものかどうかは、記録からは分かりません。',
    'いま読めている村の記録では、昇格の工事が列にあります。この命令によるものかどうかは、記録からは分かりません。', 'いま読めている村の記録では、段階は{0}です。昇格の工事は列にありません。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
  for (const k of ['収穫', '{0}への昇格', '訓練', '編成']) assert.ok(enHand.split('\n').some(l => l.startsWith(`  '${k}':`)), `${k} (the hand's dictionary)`);
});
