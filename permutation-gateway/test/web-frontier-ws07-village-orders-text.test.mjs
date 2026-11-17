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
//   O2 the classes: refused+not sent → notSent; refused+sent+unknown code → unknown (never "not sent", never failed);
//      refused+sent+other → sentFailed; unconfirmed → held; accepted and not in the record yet → waiting; accepted and
//      in the record, or naming no mark → not listed
//   O3 the record's evidence only where the order names it: a building's copy number (two orders with the same number:
//      the later needs one copy more), a promotion's tier or its place in the queue; otherwise null (nothing claimed)
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
const model = fnOf(vo, 'export function villageOrdersModel(FS, h, now) {'), view = fnOf(vo, 'export function renderVillageOrders(FS, h, now, { rereadShown = false } = {}) {');

test('O1 the lifecycle records this reads are the controller\'s own', () => {
  assert.ok(ctl.includes("const rec = { ...o, ...extra, state: ok ? 'accepted' : 'refused' };"));
  assert.ok(ctl.includes("const rec = { ...o, state: 'unconfirmed', sent: true, signature, code: 'LocalActUnconfirmed' };"));
  assert.ok(ctl.includes("const early = r => { orderAnswered(order, false, { code: r.code, sent: false }); return failed(r); };"));
  assert.ok(ctl.includes("if (!fxDone) { fxEmit('action:refused', fxa); orderAnswered(order, false, { code, sent }); }"));
  assert.ok(play.includes("return answered ? { ok: false, state: 'unknown', code: 'Unconfirmed' } : { ok: false, state: 'unqueryable', code: 'TxUnqueryable' };"));
  assert.ok(vo.includes("export const UNKNOWN_OUTCOME_CODES = Object.freeze(['Unconfirmed', 'TxUnqueryable']);"));
});

test('O2 each record is said as what it is', () => {
  // (corrected: 'unconfirmed' is the local hold only with the hold's own code; with any other code — main's chain records
  //  an ordinary-path unknown outcome that way — a second press is a new order: `unknown`, never the hold's words)
  assert.ok(vo.includes("export const LOCAL_HOLD_CODE = 'LocalActUnconfirmed';"));
  assert.ok(ctl.includes("code: 'LocalActUnconfirmed'"), 'the controller\'s own code for the hold');
  order(model, "if (o.state === 'unconfirmed') cls = o.code === LOCAL_HOLD_CODE ? 'held' : 'unknown';",
    "else if (o.state === 'refused') cls = o.sent !== true ? 'notSent' : UNKNOWN_OUTCOME_CODES.includes(o.code) ? 'unknown' : 'sentFailed';",
    "else if (o.state === 'accepted') cls = seen === false ? 'waiting' : null;", 'if (cls) out.push(');
  order(view, "if (x.cls === 'notSent')", '：送られていません。', "if (x.cls === 'sentFailed')", '：送信しましたが、成立しませんでした。', "if (x.cls === 'held')",
    '同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。', "if (x.cls === 'waiting')", '：受け付けられました。村の記録には、まだ出ていません。',
    'if (x.inRecord === true)', '送信の結果は確認できませんでしたが、村の記録には出ています。', '（送られていない、という意味ではありません）');
  // an unknown outcome is never worded as not sent or as failed
  const unknownPart = view.slice(view.indexOf('// unknown:'));
  assert.doesNotMatch(unknownPart.replace(/（送られていない、という意味ではありません）/g, ''), /送られていません|成立しませんでした/);
});

test('O3 the record is evidence only where the order names its mark', () => {
  order(model, "if (o.kind !== 'build' || !Number.isInteger(o.item) || !Number.isInteger(o.n) || o.state === 'refused' && o.sent !== true) continue;",
    'const key = `${o.item}|${o.n}`, extra = copies.get(key) ?? 0;', 'need.set(o.id, o.n + extra);',
    "if (o.kind === 'build' && need.has(o.id)) return copyNumber(h, o.item) - 1 >= need.get(o.id);",
    "if (o.kind === 'promote' && Number.isInteger(o.to)) return Number(h.tier ?? 0) >= o.to || queued.some(q => q.item === ITEM_TIER_UP);", 'return null;');
  assert.ok(model.includes('for (const o of [...mine].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {'), 'the earlier of two equal orders is counted first');
  // the order's own fields, as the controller writes them
  assert.ok(ctl.includes("order = orderOf('build', 'Build', { item, n, secs,"));
  assert.ok(ctl.includes("order = orderOf('promote', 'Build', { item, from: tier, to, secs,"));
});

test('O4 this village, this turn', () => {
  assert.ok(vo.includes("export const VILLAGE_ORDER_KINDS = Object.freeze(['harvest', 'build', 'walls', 'promote', 'train', 'muster', 'garrison']);"));
  assert.ok(vo.includes("const ofVillage = (o, h) => !!o?.tile && o.tile.p === h.p && o.tile.q === h.q && (o.kind === 'muster' || o.tile.tile === h.tile);"));
  order(model, 'if (!h) return [];', 'const turn = FS.nowBell ?? null;', 'const mine = (FS.orders ?? []).filter(o => VILLAGE_ORDER_KINDS.includes(o.kind) && o.turn === turn && ofVillage(o, h));');
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
  order(view, "const ask = list.some(x => x.cls === 'unknown' && x.inRecord !== true) && !rereadShown && villageRereadOffered(FS);", 'data-act="village-reread"');
  assert.equal((view.match(/data-act="/g) ?? []).length, 1, 'the only action here is the re-read');
  assert.ok(ctl.includes("  'village-reread': () => { rereadVillage().catch(() => {}); },"));
});

test('O7 the village screen is the consumer', () => {
  assert.ok(hs.includes("import { renderVillageOrders } from './villageorders.mjs';"));
  order(fnOf(hs, 'export function render(FS) {'), 'const readNote = renderHoldingRead(FS);',
    'const orderNote = renderVillageOrders(FS, m.settled, m.now, { rereadShown: holdingRead(FS).reread.can });',
    'return [...(wideStatus ? [wideStatus] : []), readNote || orderNote ? html`${head}${readNote}${orderNote}` : head, stores, build, troops, ...(s1On() ? [renderS1Village(FS)] : []), others];');
  assert.ok(hs.includes('const actionBusy = FS.inFlight > 0 || !!FS.homeActionBusy;'), 'the buttons\' own gate is as it was');
});

test('O8 English follows; no banned word', () => {
  for (const k of ['{0}の建設', '城壁の工事', '{0}の訓練', '{0}の編成', '守備隊の増員', 'この村から出した命令', '{0}：送られていません。', '{0}：送信しましたが、成立しませんでした。',
    '{0}：送信済みです。結果はまだ確認できていません。同じ命令は送り直しません。同じ命令をもう一度押すと、結果を確認します。',
    '{0}：受け付けられました。村の記録には、まだ出ていません。次の読み込みで出ます。', '{0}：送信の結果は確認できませんでしたが、村の記録には出ています。',
    '{0}：送信済みです。結果はまだ確認できていません（送られていない、という意味ではありません）。村の記録には、まだ出ていません。もう一度命じると、二重になることがあります。',
    '{0}：送信済みです。結果はまだ確認できていません（送られていない、という意味ではありません）。もう一度命じると、二重になることがあります。村の記録を読み直し、下の数で確かめてください。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
  for (const k of ['収穫', '{0}への昇格', '訓練', '編成']) assert.ok(enHand.split('\n').some(l => l.startsWith(`  '${k}':`)), `${k} (the hand's dictionary)`);
});
