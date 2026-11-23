// (2026-11-17; first written without being run — run and in the key-free CI set since 2026-11-21, main-red-web-tests.) An order that was SENT and whose outcome is not known is shown as that — never
// as done ("訓練しました", "建設中（完成）"), refused ("できませんでした") or not sent ("…はまだされていません") — in the
// turn list (hud/turnlist.mjs) and the map's status toast (hud/status.mjs). Pure modules over a hand-made store; no
// page, no send. The retry button is offered exactly as before (its rule is the owner's).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turnModel } from '../../permutation-server/web/frontier/hud/turnlist.mjs';
import { statusOf, renderStatus, unconfirmedNotice } from '../../permutation-server/web/frontier/hud/status.mjs';

const tile = { p: 2, q: 0, tile: 7 };
const order = (over = {}) => ({ id: 'o1', kind: 'train', name: 'Train', turn: 40, unit: 0, n: 100, tile, ...over });

test('the turn list: an unconfirmed order says it was sent and is not confirmed, with its signature', () => {
  const FS = { nowBell: 40, orders: [
    order({ id: 't-u', state: 'unconfirmed', sent: true, signature: 'SIGabcdefghijklmnop', code: 'Unconfirmed' }),
    order({ id: 'b-u', kind: 'build', name: 'Build', item: 0, n: 1, secs: 5400, doneAt: 0, state: 'unconfirmed', sent: true, signature: 'SIGbuild0000000000', code: 'LocalActUnconfirmed' }),
    order({ id: 't-a', state: 'accepted' }),
    order({ id: 't-r', state: 'refused', code: 'NotOwner', sent: false }),
  ] };
  const rows = Object.fromEntries(turnModel(FS, { now: 100 }).orders.map(r => [r.id, r]));
  const tu = rows['t-u'], bu = rows['b-u'];
  for (const r of [tu, bu]) {
    assert.equal(r.unconfirmed, true); assert.equal(r.refused, false);
    assert.match(r.text, /送信しました。確定はまだ確認できていません。署名 /);
    assert.ok(r.why.length > 0, 'the code\'s own text');
  }
  assert.match(tu.text, /^訓練 — /); assert.match(tu.text, /署名 SIGabcdefghi$/, 'the first 12 characters of the signature');
  assert.doesNotMatch(tu.text, /訓練しました/, 'never said as done');
  assert.match(bu.text, /^建設 — /); assert.doesNotMatch(bu.text, /建設中|完成/, 'never said as under way or finished');
  // the other states are said as before
  assert.match(rows['t-a'].text, /訓練しました/); assert.equal(rows['t-a'].unconfirmed, undefined);
  assert.match(rows['t-r'].text, /訓練は送られていません/); assert.equal(rows['t-r'].refused, true);
});

test('the status toast: an unknown outcome is its own state, not a refusal and not "not sent"; retry as before', () => {
  const lastAct = { name: 'train' };
  // the ordinary path: failed(t) with tx.track's answer (fplay.mjs) — unknown and unqueryable
  for (const n of [{ ok: false, code: 'Unconfirmed', state: 'unknown', text: null }, { ok: false, code: 'TxUnqueryable', state: 'unqueryable', text: null }]) {
    assert.equal(unconfirmedNotice(n), true, n.code);
    const st = statusOf({ notice: n, lastAct }, { canRetry: true });
    assert.equal(st.state, 'unconfirmed'); assert.equal(st.what, null, 'not "訓練はまだされていません"');
    assert.ok(String(st.text).length > 0, 'the code\'s own text');
    assert.equal(st.retry, true, 'offered as before');
    assert.equal(statusOf({ notice: n, lastAct }, { canRetry: false }).retry, false);
    const html = String(renderStatus(st));
    assert.match(html, /tx-unconfirmed/); assert.match(html, /role="status"/);
    // Not the refusal toast: no alert, and no refusal headline (hud/status.mjs: <span class="toast-kind">できませんでした</span>).
    // The headline is what is pinned, not the bare phrase: TxUnqueryable's own text (fi18n, since 3b3ddecf) says
    // "取引の状態を照会できませんでした。失敗したという意味ではなく…", which is the code's sentence the toast is meant to show.
    assert.doesNotMatch(html, /role="alert"|toast-kind|tx-refused|tx-what/);
    assert.doesNotMatch(html, />\s*できませんでした\s*</, 'no refusal headline');
    if (n.code === 'TxUnqueryable') assert.match(html, /照会できませんでした。失敗したという意味ではなく/, 'the code\'s own text, which says it is no failure');
  }
  // local play's notice (controller: setNotice with code LocalActUnconfirmed)
  const local = { busy: false, text: () => '送信済みの線', code: 'LocalActUnconfirmed' };
  const st = statusOf({ notice: local, lastAct }, { canRetry: true });
  assert.deepEqual([st.state, st.text, st.what], ['unconfirmed', '送信済みの線', null]);
  // a refusal is still a refusal: before sending (no state), or a failure the chain reported
  for (const n of [{ ok: false, code: 'NotOwner' }, { ok: false, code: 'TransactionFailed', state: 'failed' }, { ok: false, code: 'Unconfirmed' }]) {
    assert.equal(unconfirmedNotice(n), false, JSON.stringify(n));
    const r = statusOf({ notice: n, lastAct }, { canRetry: true });
    assert.equal(r.state, 'refused'); assert.match(String(r.what), /訓練はまだされていません/);
  }
  // busy, waiting and done are untouched
  assert.equal(statusOf({ notice: { busy: true, text: () => 'b' } }).state, 'busy');
  assert.equal(statusOf({ notice: { ok: true, text: () => 'd' } }).state, 'done');
  assert.equal(unconfirmedNotice({ busy: true, code: 'LocalActUnconfirmed' }), false);
});

// (re-pinned 2026-11-21: since 0f626c0d of 2026-11-19 the march send's "sent, not confirmed" notice is marked too — its own
//  text, the same code, and `unsent: 'march-send'` so the status names the march and not the last act; it used to be the
//  unmarked line `setNotice({ busy: false, text: localActUnconfirmedText(r.signature) })`. web-frontier-march-held.test.mjs
//  tests what the status makes of it.)
test('the controller marks local play\'s two order notices, and the march send\'s own', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(ctl, /orderUnconfirmed\(order, s\.signature\); setNotice\(\{ busy: false, text: localActUnconfirmedText\(s\.signature\), code: 'LocalActUnconfirmed' \}\);/);
  assert.match(ctl, /orderUnconfirmed\(order, r\.signature\); setNotice\(\{ busy: false, text: localActUnconfirmedText\(r\.signature\), code: 'LocalActUnconfirmed' \}\);/);
  assert.match(ctl, /if \(localHeld\) \{ setNotice\(\{ busy: false, text: localMarchUnconfirmedText\(r\.signature\), code: 'LocalActUnconfirmed', unsent: 'march-send' \}\); if \(localPlay\) recheckHeldMarch\(r\.signature\); \}/);
  assert.doesNotMatch(ctl, /setNotice\(\{ busy: false, text: local(Act|March)UnconfirmedText\([a-z]\.signature\) \}\)/, 'no unmarked "sent, not confirmed" notice is left');
  assert.equal(unconfirmedNotice({ busy: false, text: () => 'x', code: 'LocalActUnconfirmed', unsent: 'march-send' }), true);
});
