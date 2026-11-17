// ⑦ the trade card (交易と防備, screens/s1.mjs), from order to result (Lane C, 2026-11-17): a caravan or a fort order is
// given → the controller's order lifecycle answers it → the card says what became of it; the lists behind the card
// (caravans and storehouses, structures, nations) say how they were read, and can be read again by the person —
// through the S1 feeds only. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// controller.mjs, screens/s1.mjs, screens/villageorders.mjs and the English dictionary are read as TEXT, not imported
// (they load fi18n.mjs and lang.mjs, the subjects of refused tests). It runs no page, herald or world, and sends nothing.
//   Expected, case by case:
//   T1 refreshS1 records how each feed's latest read went ('ok' / 'missing' / 'failed'); a failed feed keeps what was
//      read before or stays not read; the regular load's order and frequency are as they were
//   T2 the read that began last is applied: an earlier read (regular or the person's) that answers later writes nothing;
//      a read for a feed object that was replaced (another world) writes nothing
//   T3 rereadS1 is refreshS1 and nothing else: not refreshConquest, not refresh, no send, no save; one at a time; the
//      press's own run, herald and world; a throw is "could not be made", never an empty list
//   T4 the card: a feed not read is not an empty feed — unread / failed with nothing held / failed with the earlier list
//      kept are each said; "build them on the map" and "no place to send to yet" only of lists that were read
//   T5 the button while a feed is not read as it should be, not while reading; the action is the pure re-read
//   T6 the card's own orders (a caravan, spearmen into a fort) through the same model as the village's: not sent / sent
//      and failed / sent, outcome unknown / held (local) — no mark in any record, so nothing of a record is claimed;
//      the unknown outcome offers the lists' re-read, once
//   T7 a change of herald or world lets the re-read go; the sends themselves (s1Caravan, the fort form) are unchanged
//   T8 English for every sentence; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), s1 = read('frontier/screens/s1.mjs'), vo = read('frontier/screens/villageorders.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const codeOf = body => body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const rs = fnOf(ctl, 'async function refreshS1(current, world) {'), rr = fnOf(ctl, 'export async function rereadS1() {');
const state = fnOf(s1, 'export function s1ReadState(FS) {'), note = fnOf(s1, 'export function renderS1Read(FS) {'), card = fnOf(s1, 'export function renderS1Village(FS) {');

test('T1 how each feed was read is recorded', () => {
  order(rs, 's1.error = null;', 's1.read = {};', "if (r?.ok) { s1[n] = r[n]; s1.read[n] = 'ok'; }", "else if (r?.code === 'NotFound') { s1[n] ??= s1Fresh(n); s1.read[n] = 'missing'; }",
    "s1.read[n] = 'failed'; }");
  assert.ok(ctl.includes('  if (s1On()) await refreshS1(current, world);'), 'the regular load calls it as it did');
  assert.equal((ctl.match(/refreshS1\(/g) ?? []).length, 3, 'its definition, the regular load, the re-read');
});

test('T2 the read that began last is applied', () => {
  assert.ok(ctl.includes('let s1Ask = 0;'));
  order(rs, "if (FS.s1 && (FS.s1.world ?? null) !== world) FS.s1 = undefined;", 'const s1 = FS.s1 ??=', 'const ask = ++s1Ask;', 'await Promise.allSettled(names.map(n => herald[n]()));',
    'if (!current()) return;', 'if (ask !== s1Ask || FS.s1 !== s1) return;', 's1.error = null;');
  assert.equal((codeOf(rs).match(/await /g) ?? []).length, 1, 'nothing is written before the one wait is checked');
});

test('T3 the re-read is the three feeds and nothing else', () => {
  order(rr, "if (!herald || !s1On() || FS.mode !== 'play') return false;", "if (FS.s1Reread?.state === 'loading') return 'loading';",
    "const run = { state: 'loading' }, at = { herald, world: providerWorld() };", 'const mine = () => FS.s1Reread === run && herald === at.herald && providerWorld() === at.world;',
    "FS.s1Reread = run; invalidate('panel');", 'try { await refreshS1(mine, at.world); return mine(); }', "if (mine()) run.state = 'failed';",
    "finally { if (FS.s1Reread === run && run.state === 'loading') FS.s1Reread = null;");
  assert.doesNotMatch(codeOf(rr), /refreshConquest|\brefresh\(|refreshOverviews|refreshMarches|refreshPrize|autoTicket|io\.|\bact\(|saveLand|saveHome|storage|pendingDriver/);
  assert.ok(ctl.includes("  's1-reread': () => { rereadS1().catch(() => {}); },"));
});

test('T4 a feed not read is not an empty feed', () => {
  order(state, "const feed = n => { const held = !!s1 && s1[n] !== null && s1[n] !== undefined, failed = s1?.read?.[n] === 'failed'; return held ? (failed ? 'stale' : 'ok') : failed ? 'unreadFailed' : 'unread'; };",
    "return { ...feeds, any: Object.values(feeds).some(x => x !== 'ok'), reread: FS.s1Reread?.state ?? null, can: FS.mode === 'play' };");
  order(note, "if (r[n] === 'unread')", 'を、まだ読めていません。ないという意味ではありません。', "else if (r[n] === 'unreadFailed')", 'を読み込めませんでした。ないという意味ではありません。',
    "else if (r[n] === 'stale')", 'の最新の読み込みに失敗しています。下に出ているのは、最後に読めたものです。');
  order(card, "const rd = s1ReadState(FS), listsRead = rd.caravans !== 'unread' && rd.caravans !== 'unreadFailed', builtRead = rd.structures !== 'unread' && rd.structures !== 'unreadFailed';",
    'const readNote = renderS1Read(FS);', ': listsRead && builtRead ? html`<p class="muted">${L`貯蔵庫や物見櫓・柵・要塞は、地図でマスを選ぶと建てられます。`}</p>` : \'\';',
    ': listsRead ? html`<p class="muted">${L`隊商を送れる行き先（ほかの村か貯蔵庫）がまだありません。`}</p>`', '貯蔵庫の一覧をまだ読めていないので、送れる行き先がそろっていません。',
    '${readNote}${orderNote}${manualLine}${spend}${caravans}${owned}');
});

test('T5 the button, and what it does', () => {
  order(note, "if (r.reread === 'loading')", '一覧を読み直しています…', "else if (r.reread === 'failed')", '一覧を読み直せませんでした。前に読めたものは、そのまま残しています。',
    "if (r.can && (r.any || r.reread === 'failed') && r.reread !== 'loading') lines.push(", 'data-act="s1-reread"');
  assert.doesNotMatch(codeOf(state + note), /FS\.[A-Za-z0-9]+ = |invalidate\(|\bact\(/, 'the note reads; it changes nothing');
});

test('T6 the card\'s own orders, through the village\'s model', () => {
  assert.ok(vo.includes("export const S1_ORDER_KINDS = Object.freeze(['s1-caravan', 's1-fort']);"));
  assert.ok(ctl.includes("order: orderOf('s1-caravan', 'SendCaravan', { say: () => L`隊商が出発しました` }) });"));
  assert.ok(ctl.includes("order: orderOf('s1-fort', 'FortGarrison', { tile: { p: h.p, q: h.q, tile },"));
  order(vo, "case 's1-caravan': return L`隊商の出発`;", "case 's1-fort': return L`要塞への槍兵`;");
  const fact = fnOf(vo, 'export function recordFactOf(o, h, now) {');
  assert.doesNotMatch(fact, /s1-/, 'no mark of a caravan or a fort order in a record: nothing is claimed');
  assert.ok(s1.includes("import { renderVillageOrders, S1_ORDER_KINDS } from './villageorders.mjs';"));
  order(card, "const orderNote = renderVillageOrders(FS, m.holding, FS.chain?.now?.() ?? 0, { kinds: S1_ORDER_KINDS, rereadShown: !!readNote && rd.reread !== 'loading' && (rd.any || rd.reread === 'failed'),",
    "reread: { act: 's1-reread', label: L`一覧を読み直す`, offered: rd.can && rd.reread !== 'loading' } });");
});

test('T7 another herald or world; the sends are as they were', () => {
  assert.ok(ctl.includes('FS.villageReread = null; FS.s1Reread = null; }'), 'useHerald');
  order(fnOf(ctl, 'export function adoptPinnedWorld() {'), 'FS.villageReread = null;', 'FS.s1Reread = null;', 'dropOtherWorldConquest(world);');
  const send = fnOf(ctl, 'async function s1Caravan(srcIndex, dstIndex, cargo) {');
  assert.doesNotMatch(send, /s1Reread|rereadS1|s1\.read/, 'the caravan\'s send does not know of the re-read');
  assert.ok(send.includes("return act('SendCaravan', { v: { seq, src, dst: target, provinces: plan.provinces, ...(dst.other ? { actor: FS.wallet.address } : {}) },"));
});

test('T8 English follows; no banned word', () => {
  for (const k of ['隊商と貯蔵庫の一覧', '建物の一覧', '国の方針と議題', '{0}を、まだ読めていません。ないという意味ではありません。', '{0}を読み込めませんでした。ないという意味ではありません。',
    '{0}の最新の読み込みに失敗しています。下に出ているのは、最後に読めたものです。', '一覧を読み直しています…', '一覧を読み直せませんでした。前に読めたものは、そのまま残しています。', '一覧を読み直す',
    '貯蔵庫の一覧をまだ読めていないので、送れる行き先がそろっていません。', '隊商の出発', '要塞への槍兵']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});
