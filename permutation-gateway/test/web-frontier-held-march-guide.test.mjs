// (fix-held-march-guide, D-verify-pr193-2) A local-play march first held as "unconfirmed" by its signature and answered
// LATER — by the bounded re-check (recheckHeldMarch) or by a press on the held host (askHeldMarches) — gives its order
// record the answer: refused (sent, with the code) when it failed on chain or expired, accepted when it landed. Left
// 'unconfirmed', the conquest guide still counted it as "marched" (5/7) with no march out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heldMarchAnswer, HELD_MARCH_ANSWER_CODES, orderOutcome, LOCAL_HOLD_CODE } from '../../permutation-server/web/frontier/screens/villageorders.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const held = (sig = 'SIGa', extra = {}) => ({ id: 'o7', kind: 'march', name: 'Depart', dest: { p: 4, q: -1, tile: 9 }, state: 'unconfirmed', sent: true, signature: sig, code: LOCAL_HOLD_CODE, ...extra });
const apply = a => ({ ...a.record, ...a.extra, state: a.ok ? 'accepted' : 'refused' });   // controller.mjs orderAnswered

test('a held march answered failed / expired later: its record is refused, sent, with the first answer\'s code', () => {
  for (const [x, code] of [['failed', 'TransactionFailed'], ['expired', 'LocalMarchExpired']]) {
    const a = heldMarchAnswer([held('SIGz'), held('SIGa', { id: 'o8' })], 'SIGa', x);
    assert.equal(a.record.id, 'o8', 'the record of THAT signature');
    assert.equal(a.ok, false);
    const r = apply(a);
    assert.equal(r.state, 'refused'); assert.equal(r.sent, true); assert.equal(r.signature, 'SIGa'); assert.equal(r.code, code);
    assert.equal(orderOutcome(r), 'sentFailed', 'sent, and the chain answered it failed or expired — not "not sent", not "unknown"');
  }
  assert.deepEqual(HELD_MARCH_ANSWER_CODES, { failed: 'TransactionFailed', expired: 'LocalMarchExpired' });
  // the same codes the first answer treats as final (controller.mjs LOCAL_MARCH_ANSWERED)
  assert.match(readFileSync(new URL('controller.mjs', WEB), 'utf8'), /LOCAL_MARCH_ANSWERED = Object\.freeze\(\['TransactionFailed', 'LocalMarchExpired'\]\)/);
});

test('a held march answered landed later: accepted', () => {
  const r = apply(heldMarchAnswer([held()], 'SIGa', 'landed'));
  assert.equal(r.state, 'accepted'); assert.equal(r.code, null); assert.equal(orderOutcome(r), 'accepted');
});

test('nothing to answer: no answer yet, no signature, another signature, or a record that is not a held march', () => {
  assert.equal(heldMarchAnswer([held()], 'SIGa', 'unconfirmed'), null);
  assert.equal(heldMarchAnswer([held()], 'SIGa', 'bogus'), null);
  assert.equal(heldMarchAnswer([held()], null, 'failed'), null);
  assert.equal(heldMarchAnswer([held()], '', 'failed'), null);
  assert.equal(heldMarchAnswer([held()], 'SIGb', 'failed'), null);
  assert.equal(heldMarchAnswer(null, 'SIGa', 'failed'), null);
  assert.equal(heldMarchAnswer([held('SIGa', { kind: 'harvest' })], 'SIGa', 'failed'), null, 'another kind of order (the act ledger answers those)');
  assert.equal(heldMarchAnswer([held('SIGa', { state: 'refused' })], 'SIGa', 'failed'), null, 'already answered');
  assert.equal(heldMarchAnswer([held('SIGa', { state: 'accepted' })], 'SIGa', 'expired'), null, 'already answered');
  assert.equal(heldMarchAnswer([held('SIGa', { code: 'Unconfirmed' })], 'SIGa', 'failed'), null, 'the ordinary path\'s unknown outcome: not the local hold');
});

test('controller: both later answers pass the signature that was answered to heldTold, which answers the order record', () => {
  const c = readFileSync(new URL('controller.mjs', WEB), 'utf8');
  assert.match(c, /import \{ heldMarchAnswer \} from '\.\/screens\/villageorders\.mjs';/);
  const told = c.slice(c.indexOf('function heldTold('), c.indexOf('function recheckHeldMarch('));
  assert.match(told, /^function heldTold\(x, signature = null\) \{/);
  assert.match(told, /const a = heldMarchAnswer\(FS\.orders, signature, x\);\n  if \(a\) orderAnswered\(a\.record, a\.ok, a\.extra\);/);
  const re = c.slice(c.indexOf('function recheckHeldMarch('), c.indexOf('async function askHeldMarches('));
  assert.match(re, /if \(x !== 'unconfirmed'\) \{ heldRechecks\.delete\(signature\); invalidate\('panel'\); heldTold\(x, signature\); return; \}/);
  const ask = c.slice(c.indexOf('async function askHeldMarches('), c.indexOf('async function localActAsk('));
  assert.match(ask, /if \(last !== 'unconfirmed'\) \{ answered = sig; break; \}/);
  assert.match(ask, /if \(heldTold\(last, answered\)\) return;/);
  // every heldTold call names its signature
  assert.deepEqual(c.match(/heldTold\([^)]*\)/g).filter(x => !/^heldTold\((x, signature( = null)?|last, answered)\)$/.test(x)), []);
});
