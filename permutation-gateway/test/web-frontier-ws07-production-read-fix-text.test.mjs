// ⑦ correction to the village screen's read states (Lane C, 2026-11-17): "no village" is said only for an answer that
// really is this viewer's and this world's; another world's village offers no read of its place. WRITTEN, NOT RUN.
// KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs, screens/holding.mjs and the English
// dictionary are read as TEXT, not imported.
//   Expected, case by case (no village in hand):
//   W1 no wallet: 'none' — nobody to ask (as before)
//   W2 a wallet, never answered (first load; after resetViewer or useHerald, which clear the answer and its world): 'unread'
//   W3 answered "none" in world A, then world B is pinned (the same herald): 'unread' — A's "none" is not B's;
//      B answers "none": FS.meWorld = B → 'none' (never stuck as another world's: NotFound records its world too)
//   W4 answered "none" here, then the read fails (the kept answer): 'noneStale' — said as the last record read
//   W5 A → B → A: the generation differs, so the first A's answer is not the last A's: 'unread' until it answers
//   W6 no pin: the world is null on both sides: an answer counts as here
//   W7 a state without FS.meWorld (a fixture, a page from before): taken as this world's, as it was
//   With a village:
//   W8 the villages were read for another world: 'otherWorld'; the province's read state is not shown and no
//      "load again" of that place is offered (province null, p and q null)
//   W9 this world's village: as before — the province's state, the note, the pure "load again"
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const ctl = read('frontier/controller.mjs'), hs = read('frontier/screens/holding.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const hr = fnOf(hs, 'export function holdingRead(FS) {'), note = fnOf(hs, 'export function renderHoldingRead(FS) {'), am = fnOf(ctl, 'export function applyMeResult(me) {');

test('W3 W4 every answer records its world: a Citizen and "no Citizen" alike', () => {
  order(am, 'if (me.ok) {', "FS.meStatus = 'ready'; FS.meError = null; FS.meAnswered = true;", 'FS.meWorld = providerWorld();', 'FS.holdingsWorld = providerWorld();',
    "if (me.code === 'NotFound') {", "FS.meStatus = 'ready'; FS.meError = null; FS.meAnswered = true;", 'FS.meWorld = providerWorld();', 'FS.citizen = null; FS.holdings = []; FS.land = landState(null);');
  assert.equal(am.split('FS.meWorld = providerWorld();').length - 1, 2, 'both answers, and only answers');
  const fail = am.slice(am.lastIndexOf("FS.meStatus = 'error';"));
  assert.doesNotMatch(fail, /FS\.meWorld/, 'a failed read records no world: the answer kept is still the one before');
});

test('W2 the answer and its world are let go together', () => {
  const rv = fnOf(ctl, 'function resetViewer(');
  order(rv, 'FS.meAnswered = false;', 'FS.meWorld = undefined;');
  assert.ok(ctl.includes('fwide.clearWide(FS); FS.meAnswered = false; FS.meWorld = undefined; }'), 'useHerald');
});

test('W1–W7 no village: by where the answer came from', () => {
  order(hr, "const world = pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null;",
    'const answeredHere = FS.meAnswered === true && (FS.meWorld === undefined || FS.meWorld === world);',
    "const viewer = !h ? (!FS.wallet ? 'none' : !answeredHere ? 'unread' : FS.meStatus === 'error' ? 'noneStale' : 'none')");
  assert.ok(ctl.includes("function providerWorld() { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; }"), 'the same string the provider records');
  assert.ok(hs.includes(": v === 'noneStale' ? L`最後に読めた記録では、まだ村がありません。いまの読み込みは失敗しています。次の読み込みでもう一度確かめます。` : L`まだ村がありません。`"));
  const line = en.split('\n').find(l => l.startsWith("  '最後に読めた記録では、まだ村がありません。いまの読み込みは失敗しています。次の読み込みでもう一度確かめます。':"));
  assert.ok(line);
  assert.doesNotMatch(line.slice(line.indexOf("': ") + 3), /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
});

test('W8 W9 another world\'s village offers no read of its place', () => {
  order(hr, ": FS.holdingsWorld !== undefined && FS.holdingsWorld !== world ? 'otherWorld'", "const mine = !!h && viewer !== 'otherWorld';", 'const key = mine ? `${h.p},${h.q}` : null',
    "return { viewer, province: !mine ? null : FS.provinces?.has?.(key) ? 'held' : st?.state ?? 'idle', code: st?.code ?? null, p: mine ? h.p : null, q: mine ? h.q : null };");
  order(note, "if (r.viewer === 'otherWorld')", "if (r.province && r.province !== 'held') {", 'data-act="province-reread" data-p="${r.p}" data-q="${r.q}"');
  // (with province null the whole block, its button included, is skipped)
  assert.ok(note.includes("if (r.province && r.province !== 'held') {"));
});
