// ⑦ the village screen says which reads behind it did not come (Lane C, 2026-11-17): choose the village → its stores,
// rates and what each action needs → the existing action rows → a read that failed is said as that and read again.
// Display only: no action row, no send, no rule or gate is changed. WRITTEN, NOT RUN. KEY-FREE and import-free beyond
// node:test / node:assert / node:fs: screens/holding.mjs, fland.mjs, controller.mjs, app.mjs and the English
// dictionaries are read as TEXT, not imported.
//   Expected, case by case:
//   V1 a wallet whose record has not answered and no village held: "not loaded yet (not: no village)"; once it answered
//      with none: 「まだ村がありません。」 as before
//   V2 the village's province record is not held: the rules' mirror answers NotResident for every resident action (it
//      has no record to judge by) — the screen says the record is not loaded and that the line below may be for that
//      reason; failed: with the code and "load again" (the pure read province-reread); being read or waiting: no button
//   V3 the province record is held: no note; the action rows and their reasons are the rules' own, as before
//   V4 the last viewer read failed after an earlier answer: the stores are worked out from the record read before — said
//   V5 the villages held were read for another pinned world: said, until this world's answer comes
//   V6 the note rides with the head card: the list of cards is as long as it was; nothing of the action rows is touched
//   V7 English for every new sentence, quoting the existing English of the NotResident line; no banned word
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const hs = read('frontier/screens/holding.mjs'), fland = read('frontier/fland.mjs'), ctl = read('frontier/controller.mjs'), app = read('frontier/app.mjs');
const en = read('lang/en-frontier-play.mjs'), enBase = read('lang/en-frontier.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const hr = fnOf(hs, 'export function holdingRead(FS) {'), note = fnOf(hs, 'export function renderHoldingRead(FS) {');

test('V1 V4 V5 the viewer\'s record: not read, another world, stale, or answered', () => {
  // (corrected: by the world of the answer itself — web-frontier-ws07-production-read-fix-text.test.mjs)
  order(hr, 'const answeredHere = FS.meAnswered === true && (FS.meWorld === undefined || FS.meWorld === world);',
    "const viewer = !h ? (!FS.wallet ? 'none' : !answeredHere ? 'unread' : FS.meStatus === 'error' ? 'noneStale' : 'none')", ": FS.holdingsWorld !== undefined && FS.holdingsWorld !== world ? 'otherWorld'", ": FS.meStatus === 'error' ? 'stale' : 'ok';");
  assert.ok(hr.includes("const world = pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null;"));
  assert.ok(ctl.includes('FS.holdingsWorld = providerWorld();'), 'the provider records the world of the villages it applied');
  assert.ok(ctl.includes("FS.meStatus = 'ready'; FS.meError = null; FS.meAnswered = true;"));
  assert.ok(hs.includes("v === 'unread' ? L`村の記録をまだ読めていません。村がないという意味ではありません。次の読み込みで確かめます。`"));
  assert.ok(hs.includes(": v === 'noneStale' ? L`最後に読めた記録では、まだ村がありません。いまの読み込みは失敗しています。次の読み込みでもう一度確かめます。` : L`まだ村がありません。`"));
});

test('V2 V3 the village\'s province: why NotResident may be "not loaded"', () => {
  assert.ok(fland.includes("if (resident && (!ctx.province || ctx.province.resolvedNext + 1 < ctx.nowBell)) out.push('NotResident');"), 'the mirror answers NotResident with no record');
  assert.ok(hr.includes("return { viewer, province: !mine ? null : FS.provinces?.has?.(key) ? 'held' : st?.state ?? 'idle', code: st?.code ?? null, p: mine ? h.p : null, q: mine ? h.q : null,"));   // (the re-read's own part follows: web-frontier-ws07-village-reread-text.test.mjs)
  order(note, "if (r.province && r.province !== 'held') {", "r.province === 'failed'", 'この村の州の記録を読めていません（${r.code}）。', 'この村の州の記録を、まだ読めていません。',
    "if (r.province !== 'loading' && r.province !== 'waiting') lines.push(", 'data-act="province-reread" data-p="${r.p}" data-q="${r.q}"');
  assert.ok(note.includes("return lines.length ? html`<div class=\"village-read\""), 'nothing when all is read');
  assert.ok(app.includes("'province-reread': d =>"), 'the existing pure read');
});

test('V6 the note rides with the head; the action rows are untouched', () => {
  assert.ok(hs.includes('const readNote = renderHoldingRead(FS);'));
  assert.ok(hs.includes('return [...(wideStatus ? [wideStatus] : []), readNote || orderNote ? html`${head}${readNote}${orderNote}` : head, stores, ...(researchCard ? [researchCard] : []), ...(wideCard ? [wideCard] : []), build, troops, ...(s1On() ? [renderS1Village(FS)] : []), others];'));
  assert.doesNotMatch(hr + note, /data-act="(harvest|build|train|muster|garrison|nudge)"|actionBlocks\(|act\(/, 'no action and no gate in the read note');
  assert.ok(hs.includes("const lag = nudge === true && blocks.includes('NotResident');"), 'the blocked line and its button are as they were');
  assert.ok(hs.includes("blocks: Object.fromEntries(['Harvest', 'Build', 'Train', 'Muster', 'Garrison'].map(n => [n, actionBlocks(n, ctx)])),"));
});

test('V7 English follows, in the existing words of the NotResident line', () => {
  const base = enBase.match(/'この州はまだ前のターンの決着が済んでいません': '((?:[^'\\]|\\.)*)'/)?.[1];
  assert.ok(base);
  for (const k of ['村の記録をまだ読めていません。村がないという意味ではありません。次の読み込みで確かめます。', 'この村は、前に読んだ世界の記録です。いまの世界の記録を読み込んでいます。',
    'いまの読み込みに失敗しています。下の数は、最後に読めた記録から計算したものです。次の読み込みでもう一度確かめます。',
    'この村の州の記録を読めていません（{0}）。下の行動が「この州はまだ前のターンの決着が済んでいません」と出るのは、記録を読めていないためのことがあります。',
    'この村の州の記録を、まだ読めていません。読めるまで、下の行動は「この州はまだ前のターンの決着が済んでいません」と出ます。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    const value = line.slice(line.indexOf("': ") + 3);
    assert.doesNotMatch(value, /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
    if (k.includes('「この州はまだ')) assert.ok(value.includes(base), 'the quoted line is the page\'s own English for it');
  }
});
