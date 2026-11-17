// ⑦ correction to the report's replay (Lane C, 2026-11-17): an explicit request's validity — the last press, the report
// it was pressed in (or none), the world — is asked inside playBattle before anything is staged, flown to or put on the
// map; it is not the follow's `still`, so a newer scene of the province never calls off a clash the person asked for.
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs is read as TEXT, not
// imported (it loads fi18n.mjs and lang.mjs, the subjects of refused tests). The cases below are pinned by the order
// they rely on; no page, herald or world is run.
//   Expected, case by case (each "null" is before any scene, flight, FS.battles or effect):
//   C1 an earlier press answers after a later one: asked() is false (not the last press) → null; playAsked returns at
//      `req !== playAskSeq` and leaves the later press's playing / failed state alone
//   C2 the same report pressed twice: the first → null as in C1; the second answers for the report
//   C3 report A pressed, report B opened while it is read: asked() false (the report is not A) → null; B is not closed or
//      marked; nothing plays
//   C4 the report closed while it is read: asked() false (no report is not A) → null; nothing plays
//   C5 pressed with no report open, then a report opened: asked() false (a report is not "none") → null; nothing plays
//   C6 the world changes: playBattle's own world check → null; nothing restored or marked
//   C7 a replay of an older clash while a newer scene of the province plays: `asked` is not `still` → it plays
//   C8 "no scene" (false) or a throw for the last press, the report still open in the same world → the report kept,
//      marked failed, same button reads again; true → only that report is left
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const fnOf = head => { const at = app.indexOf(head); assert.ok(at >= 0, head); return app.slice(at, app.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const pb = fnOf('export async function playBattle(');
const ask = fnOf('async function playAsked(p, q, bell) {');
const NULL_CHECK = 'if (momentWorld() !== world || heraldRef !== source || (still && !still()) || (asked && !asked())) return null;';

test('C1–C6 the request\'s validity is asked before any effect', () => {
  order(pb, '{ focus = false, auto = false, still = null, asked = null } = {}) {', 'const r = await source.clash(p, q, bell).catch(() => null);', NULL_CHECK,
    'syncBattleWorld();', 'const scene = battleScene({', 'if (focus && mapRef) {', 'mapRef.flyTo({', 'FS.battles = [', "fxEmit('battle', {");
  const before = pb.slice(0, pb.indexOf(NULL_CHECK));
  assert.doesNotMatch(before.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'), /mapRef\.flyTo|FS\.battles =|fxEmit\(|camKeep\./, 'no effect before the check');
  order(ask, 'const req = ++playAskSeq;', 'const rep = FS.report ?? null, world = reportWorld();',
    'const asked = () => req === playAskSeq && (FS.report ?? null) === rep && reportWorld() === world;',
    'try { ok = await playBattle(p, q, bell, { focus: true, asked }); }', 'if (req !== playAskSeq) return;', 'if (rep) rep.playing = false;');
});

test('C7 asked is not still: a person\'s replay of an older clash plays', () => {
  assert.ok(pb.includes('if ((auto || still) && (FS.battles ?? []).some(b =>'), 'the newer-scene rule is the page\'s and the follow\'s only');
  assert.doesNotMatch(pb, /\(auto \|\| still \|\| asked\)|asked\) && \(FS\.battles/, 'asked is not added to it');
  const code = ask.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /still|auto: true/);
});

test('C8 the outcome for the last press', () => {
  order(ask, 'if (req !== playAskSeq) return;', 'if (rep) rep.playing = false;', 'if (ok === true) { if (rep && FS.report === rep) leaveReport(); return; }',
    'if (rep && ok === false && FS.report === rep && reportWorld() === world) rep.playFailed = true;', "if (rep) invalidate('panel');");
  assert.ok(ask.includes("} catch (e) { console.error('frontier battle play:', e); ok = false; }"), 'a throw is a failure, not a call-off');
});

test('the other callers pass no asked (unchanged)', () => {
  assert.equal((app.match(/\basked \}\)/g) ?? []).length, 1, 'only playAsked passes it');
  assert.doesNotMatch(pb + ask, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
