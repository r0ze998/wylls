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
  assert.match(movedPart, /\n\s+quiet\(\);/);
  assert.doesNotMatch(movedPart, /done\(|failed\(|orderAnswered\(|after\?\.|refresh\(\)/);
  // an unconfirmed order is never then recorded as refused by the finally block
  assert.match(once, /if \(!fxDone\) \{ fxEmit\('action:refused', fxa\); if \(!unconfirmed\) orderAnswered\(order, false, \{ code, sent \}\); \}/);
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) every exit of the ordinary path after the scope may have changed
test('an old answer changes neither the new page notice nor another order busy notice, on every exit', () => {
  const once = between('async function actOnce(', '/** What an accepted action says');
  // the scope is the first thing taken, before the first await
  const taken = 'const scope0 = orderScope();';
  assert.ok(once.indexOf(taken) >= 0 && once.indexOf(taken) < once.indexOf('await '), 'taken before anything is awaited');
  // only this order's own busy notice is ever cleared
  assert.match(once, /let myBusy = FS\.notice;\n\s+const quiet = \(\) => \{ if \(FS\.notice === myBusy\) setNotice\(null\); \};/);
  assert.doesNotMatch(once, /FS\.notice\?\.busy\) setNotice\(null\)/, 'never "whatever is busy now"');
  // after the NFT generation read: neither its notice nor the FS.resident write for another viewer or world
  assert.match(once, /const g = await fresident\.currentGeneration\(FS\.wallet\.address, FS\.resident\.asset\)\.catch\(e => \{ if \(moved\(\)\) return undefined; throw e; \}\);/);
  const gen = once.indexOf('const g = await fresident.currentGeneration(');
  const genGuard = once.indexOf("if (moved()) return { ok: false, code: 'ScopeChanged', scopeChanged: true, sent: false };");
  assert.ok(gen > 0 && gen < genGuard && genGuard < once.indexOf("if (g === null) return early({ code: 'NftNotHeld' });") && genGuard < once.indexOf('FS.resident = { ...FS.resident, generation: g };'));
  // a refused send: the moved check comes before the failure notice
  const refusedMoved = once.indexOf('if (!r.ok && moved()) { code = r.code ?? null; quiet(); return { ...r, scopeChanged: true }; }');
  assert.ok(refusedMoved > 0 && refusedMoved < once.indexOf('if (!r.ok) { code = r.code ?? null; return failed(r); }'));
  // the catch-up retry is unchanged (pinned elsewhere verbatim); only its busy notice is gated and recorded as this order's
  assert.match(once, /if \(!local && !t\.ok && retryAfterCatchUp\(name, t\.code\)\) \{\n.*\n\s+if \(!moved\(\)\) \{ busy\(\(\) => L`州が追いつくのを待っています…`\); myBusy = FS\.notice; \}\n\s+if \(await catchUp\(/);
  // an exception after the page moved is not thrown at the new page's handler; before that, it is thrown as before
  assert.match(once, /code = e\?\.code \?\? 'Error';\n.*\n\s+if \(moved\(\)\) \{ console\.error\('frontier order of another viewer or world:', e\); quiet\(\); return \{ ok: false, code, scopeChanged: true, sent \}; \}\n\s+throw e;/);
});

test('local play keeps its own scope and record (unchanged)', () => {
  const once = between('async function actOnce(', '/** What an accepted action says');
  const localUnk = once.indexOf("if (local && r.ok && !t.ok && t.state !== 'failed') {");
  const ordinaryUnk = once.indexOf("if (!t.ok && (t.state === 'unknown' || t.state === 'unqueryable')) {");
  assert.ok(localUnk > 0 && localUnk < ordinaryUnk, 'local play returns on its own unconfirmed branch first');
});
