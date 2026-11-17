// ⑦ correction to the tracker's re-read (Lane C, 2026-11-17): the request belongs to its own march. WRITTEN, NOT RUN.
// KEY-FREE and import-free beyond node:test / node:assert / node:fs: controller.mjs and screens/tracker.mjs are read as
// TEXT, not imported.
//   Expected, case by case:
//   O1 march A is being read again; the person presses "read again" on march B: A's request still stands — its answer
//      is written to A (it was: one number for all marches, so B's press called A's off and A stayed "not read")
//   O2 the same march pressed twice: the earlier request is called off; its answer is not written, and its end does not
//      clear "being read" while the later one is under way
//   O3 the list is replaced by the ordinary reading (new items): the old item's request writes nothing to the new list
//   O4 another world, another village, another book key: nothing is written
//   O5 the reads fail again: the march stays marked, with the new code; it can be pressed again
//   O6 still a pure read: nothing of the book, the reveal or the settle is touched
//   O7 a march that is resolved AND marked unread shows its report, replay and map buttons as any resolved march does,
//      beside the note and "read again" (the tracker's actions do not look at `unread`)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const ctl = read('controller.mjs'), trk = read('screens/tracker.mjs');
const at0 = ctl.indexOf('export async function rereadMarchFacts(hostId) {'), rr = ctl.slice(at0, ctl.indexOf('\n}\n', at0) + 2);
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('O1 O2 the request is the march\'s own', () => {
  order(rr, 'const req = m.rereadReq = {}, holding = holdingRef(activeHolding(FS) ?? null);',
    'const same = () => m.rereadReq === req && FS.marches === list && list.includes(m) && herald === at.herald && localPlay === at.localPlay',
    "m.rereading = true; invalidate('panel');", 'if (!same()) return false;', "finally { if (m.rereadReq === req) m.rereading = false; invalidate('panel'); }");
  assert.doesNotMatch(ctl, /marchRereadSeq/, 'no number shared by all marches is left');
  assert.doesNotMatch(code(rr), /finally \{ if \(list\.includes\(m\)\) m\.rereading = false/, 'an older end does not clear a newer request\'s "being read"');
});

test('O3 O4 the list, the world, the village, the book', () => {
  assert.ok(rr.includes('&& (localPlay?.march?.instance ?? null) === at.instance && holdingRef(activeHolding(FS) ?? null) === at.holding && bookKey() === at.key && providerWorld() === at.world;'));
  assert.equal(code(rr).split('if (!same()) return false;').length - 1, 2, 'asked after each of the two reads');
});

test('O5 a failure keeps the march marked', () => {
  assert.ok(rr.includes('if (slotRead.failed || factsRead.failed) m.unread = { slot: !!slotRead.failed, facts: !!factsRead.failed, code: slotRead.code ?? factsRead.code ?? null };'));
  assert.ok(rr.includes("} catch (e) { console.error('frontier march reread:', e); if (same()) m.unread = { ...(m.unread ?? {}), code: e?.code ?? 'Error' }; }"));
});

test('O6 still a pure read', () => {
  assert.doesNotMatch(code(rr), /io\.reveal|book\.|saveBook|loadBook|recordAttempt|settle|\.entry =|\.transit =|m\.slot =|m\.env =|m\.record =/);
});

test('O7 a resolved march keeps its report, replay and map buttons whether or not it is marked unread', () => {
  const acts = trk.slice(trk.indexOf('${m.dest || m.facts?.settleReady ? html`<div class="actions">'), trk.indexOf('${fold(`m-steps-${slug}`'));
  assert.ok(acts.includes('${m.dest && resolved && Number.isInteger(t.arriveBell) ? html`<button type="button" class="btn${m.facts?.settleReady ? \'\' : \' primary\'} small" data-act="report-open"'));
  assert.ok(acts.includes('data-act="battle-play"') && acts.includes('data-act="goto"'));
  assert.doesNotMatch(acts, /unread/, 'the actions do not depend on unread');
  assert.ok(trk.includes('${m.unread ? html`<div class="march-unread" role="status">'), 'the note and "read again" stand beside them');
});
