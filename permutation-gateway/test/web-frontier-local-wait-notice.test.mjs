// Round 45 (seen in live33, 2026-11-15): local play's waiting send (march-send-wait / muster-send-wait) is not one of the
// page's sends, so FS.lastAct still named the control pressed before it — Train. When the wait was withdrawn ("the order
// changed … The order was not sent. Check it, then press again"), the notice was headed "Nothing has been trained yet."
// and offered "Try again", which re-runs FS.lastAct: another Train. The wait's own lines now say what they are: the
// "waiting to send" line is a pending state (no "That did not work", no retry), a withdrawn wait names the march or the
// muster it concerns and offers no retry. Ordinary refusals are as before.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as status from '../../permutation-server/web/frontier/hud/status.mjs';

afterEach(() => setLang('ja'));
const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const TRAIN = { kind: 'act', name: 'train', data: { unit: '0', n: '500' } };

test('a withdrawn march wait after a Train press: headed by the march, no "Try again" (it would train again)', () => {
  setLang('en');
  const FS = { lastAct: TRAIN, notice: { busy: false, text: 'The waiting send is cancelled because the order changed. The order was not sent.', unsent: 'march-send', retry: false } };
  const st = status.statusOf(FS, { canRetry: true });
  assert.equal(st.state, 'refused');
  assert.equal(st.what, 'The march was not sent.');
  assert.equal(st.retry, false);
  const out = flat(status.renderStatus(st));
  assert.doesNotMatch(text(out), /trained/);
  assert.doesNotMatch(out, /data-act="notice-retry"/);
});

test('a withdrawn muster wait: headed by the muster, no "Try again"', () => {
  setLang('en');
  const st = status.statusOf({ lastAct: TRAIN, notice: { busy: false, text: 'x', unsent: 'muster', retry: false } }, { canRetry: true });
  assert.equal(st.what, 'The host has not been ordered to form up yet.');
  assert.equal(st.retry, false);
});

test('the "waiting to send" line is a pending state: no "That did not work", no header of another action, no retry', () => {
  for (const lang of ['en', 'ja']) {
    setLang(lang);
    const st = status.statusOf({ lastAct: TRAIN, notice: { busy: false, waiting: true, text: 'Waiting to send …' } }, { canRetry: true });
    assert.equal(st.state, 'busy');
    assert.equal(st.retry, false);
    assert.equal(st.what, undefined);
    const out = flat(status.renderStatus(st));
    assert.match(out, /role="status"/);
    assert.doesNotMatch(text(out), /That did not work|できませんでした|trained|訓練/);
    assert.doesNotMatch(out, /data-act="notice-retry"/);
  }
});

test('an ordinary refusal is as before: headed by the last control, "Try again" offered', () => {
  setLang('en');
  const st = status.statusOf({ lastAct: TRAIN, notice: { ok: false, code: 'HTTP503' } }, { canRetry: true });
  assert.equal(st.what, 'Nothing has been trained yet.');
  assert.equal(st.retry, true);
});

test('the controller tags every local wait line (march and muster: armed, withdrawn)', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const lines = src.split('\n').filter(l => /setNotice\(\{ busy: false/.test(l) && /PENDING_WITHDRAWN|MUSTER_WITHDRAWN|text: t\(\)|送信待ちです/.test(l));
  assert.equal(lines.length, 5, lines.join('\n'));
  for (const l of lines) assert.match(l, /waiting: true|unsent: '(march-send|muster)', retry: false/, l.trim());
});
