// ⑦ the report's 戦いを再生 / 見る (Lane C, 2026-11-17): the report stays open while the clash is read and is left only once
// the scene is on the map; "no scene" or a throw keeps it and says so, with the same button to read again; a request the
// change of world or herald called off is not a failure; only the last press answers; a report the person opened or
// closed meanwhile is theirs. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs:
// app.mjs, screens/report.mjs and the English dictionary are read as TEXT, not imported (they load fi18n.mjs and
// lang.mjs, the subjects of refused tests). A text check; it runs no page, herald or world.
//   R1 the action goes through playAsked; nothing is left before the answer
//   R2 playAsked: the press's number, the report open at the press and its world; reading shown; the answer read in a
//      guard; an earlier press answers nothing; true leaves only that report; false (no scene, or a throw) marks only that
//      report, still open, in the same world; null says nothing
//   R3 the scene is playBattle's as before: an explicit request (focus, neither auto nor still)
//   R4 the report shows reading / not loaded under its button, which stays the way to read again
//   R5 English for both sentences; no banned word
//   R6 every place that offers the button sends the same action (report, tracker, notices, inspector, turn list)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const app = read('frontier/app.mjs'), rep = read('frontier/screens/report.mjs'), en = read('lang/en-frontier-play.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const ask = fnOf(app, 'async function playAsked(p, q, bell) {');

test('R1 the action waits for the answer', () => {
  assert.ok(app.includes("'battle-play': d => { playAsked(num(d.p), num(d.q), num(d.bell)); },"));
  assert.doesNotMatch(app, /'battle-play': d => \{ leaveReport\(\);/, 'the report is no longer left before the clash is read');
});

test('R2 the report is kept until the scene plays', () => {
  assert.ok(app.includes('let playAskSeq = 0;'));
  order(ask, 'const req = ++playAskSeq;', 'const rep = FS.report ?? null, world = reportWorld();', 'closeDialPop();',
    "if (rep) { rep.playing = true; rep.playFailed = false; invalidate('panel'); }", 'let ok = false;',
    "try { ok = await playBattle(p, q, bell, { focus: true, asked }); } catch (e) { console.error('frontier battle play:', e); ok = false; }",
    'if (req !== playAskSeq) return;', 'if (rep) rep.playing = false;', 'if (ok === true) { if (rep && FS.report === rep) leaveReport(); return; }',
    'if (rep && ok === false && FS.report === rep && reportWorld() === world) rep.playFailed = true;', "if (rep) invalidate('panel');");
  const code = ask.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.split('await ').length - 1, 1);
});

test('R3 the scene is the explicit request it was', () => {
  // (corrected: the request carries its own validity, `asked`, and never `still` or `auto` — web-frontier-ws07-report-play-fix-text.test.mjs)
  assert.ok(ask.includes('playBattle(p, q, bell, { focus: true, asked })'));
  const code = ask.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /auto: true|still/, 'not the page\'s own scene, not the follow');
});

test('R4 the report says reading / not loaded under its button', () => {
  const head = fnOf(rep, 'function renderHeadline(sum, r) {');
  order(head, "const playState = r.playing ? html`<p class=\"muted\" role=\"status\">${L`戦いを読み込んでいます…`}</p>`",
    ': r.playFailed ? html`<p class="notice error" role="alert">${L`戦いを読み込めませんでした。報告はそのまま残しています。もう一度押すと読み直します。`}</p>` : \'\';',
    'data-act="battle-play"', '</div>${playState}`;');
});

test('R5 English follows; no banned word', () => {
  for (const k of ['戦いを読み込んでいます…', '戦いを読み込めませんでした。報告はそのまま残しています。もう一度押すと読み直します。']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});

test('R6 every place offering the replay sends the same action', () => {
  for (const f of ['frontier/screens/report.mjs', 'frontier/screens/tracker.mjs', 'frontier/hud/feed.mjs', 'frontier/hud/inspect.mjs', 'frontier/hud/turnlist.mjs']) assert.match(read(f), /battle-play/, f);
  assert.doesNotMatch(ask, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
