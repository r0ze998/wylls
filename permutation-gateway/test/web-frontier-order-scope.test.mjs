// (2026-11-17) WRITTEN ONLY, NOT RUN. The order path's answers belong to the viewer and world the order was made
// under, and an outcome that is not known is "sent, not confirmed", never "refused" (controller.mjs act/actOnce).
// Pinned as text, as the other controller tests do (the controller needs the page to run): nothing is sent or built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const between = (a, b) => { const i = ctl.indexOf(a), j = ctl.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return ctl.slice(i, j); };

test('an order carries the viewer and world it was made under, and an answer for another is not recorded', () => {
  assert.match(ctl, /const orderScope = \(\) => `\$\{viewerKey\(\) \?\? ''\}\|\$\{providerWorld\(\) \?\? ''\}`;/);
  assert.match(between('function orderOf(kind, name', 'function orderAnswered('), /at: now\(\), scope: orderScope\(\) \};/);
  assert.match(ctl, /const orderHere = o => o\.scope === undefined \|\| o\.scope === orderScope\(\);/);
  assert.match(between('function orderAnswered(', 'export const sendKey'), /if \(!o \|\| !orderHere\(o\)\) return;/);
  assert.match(between('function orderUnconfirmed(', 'const localActUnconfirmedText'), /if \(!o \|\| !orderHere\(o\)\) return;/);
  // the local-play record is unchanged (pinned elsewhere too); the ordinary path's code is set after it
  assert.match(ctl, /const rec = \{ \.\.\.o, state: 'unconfirmed', sent: true, signature, code: 'LocalActUnconfirmed' \};\n\s+if \(code !== 'LocalActUnconfirmed'\) rec\.code = code;/);
});

test('the ordinary path: the scope is taken before anything is sent, and a late answer for another scope shows nothing', () => {
  const once = between('async function actOnce(', '/** What an accepted action says');
  const taken = 'const scope0 = orderScope();';
  assert.ok(once.indexOf(taken) >= 0 && once.indexOf(taken) < once.indexOf('let r = await send();'), 'taken before the send');
  assert.match(once, /const moved = \(\) => !local && orderScope\(\) !== scope0;/);
  // order of the answer: an unknown outcome is recorded as unconfirmed, then a moved page shows nothing, then the
  // failure notice, then the landing (done, the accepted record, the refresh, `after`)
  const unk = once.indexOf("if (!t.ok && (t.state === 'unknown' || t.state === 'unqueryable')) {");
  const mov = once.indexOf('if (moved()) {');
  const fail = once.indexOf('if (!t.ok) { code = t.code ?? null; return failed(t); }');
  const land = once.indexOf('done(say ?? order?.say ?? DONE_TEXT[name]');
  assert.ok(unk > 0 && unk < mov && mov < fail && fail < land, `${unk} ${mov} ${fail} ${land}`);
  assert.match(once, /orderUnconfirmed\(order, r\.signature, t\.code \?\? 'Unconfirmed'\);/);
  // a moved page: the effects bus is told as before (landed for a landing), the busy notice is cleared, nothing else
  const movedPart = once.slice(mov, fail);
  assert.match(movedPart, /if \(t\.ok\) \{ fxDone = true; fxEmit\('action:landed', fxa\); \}/);
  assert.match(movedPart, /if \(FS\.notice\?\.busy\) setNotice\(null\);/);
  assert.doesNotMatch(movedPart, /done\(|failed\(|orderAnswered\(|after\?\.|refresh\(\)/);
  // an unconfirmed order is never then recorded as refused by the finally block
  assert.match(once, /if \(!fxDone\) \{ fxEmit\('action:refused', fxa\); if \(!unconfirmed\) orderAnswered\(order, false, \{ code, sent \}\); \}/);
});

test('local play keeps its own scope and record (unchanged)', () => {
  const once = between('async function actOnce(', '/** What an accepted action says');
  const localUnk = once.indexOf("if (local && r.ok && !t.ok && t.state !== 'failed') {");
  const ordinaryUnk = once.indexOf("if (!t.ok && (t.state === 'unknown' || t.state === 'unqueryable')) {");
  assert.ok(localUnk > 0 && localUnk < ordinaryUnk, 'local play returns on its own unconfirmed branch first');
});
