// (2026-11-19, fix-march-held) The page's words for a local march that the runner rejected, and for one sent whose
// outcome is not known (D-r0ze-play-kit-1): the unconfirmed notice read 「できませんでした · 編成はまだ命じられていません」
// — a refusal titled with the LAST muster's words — because the march's notice carried no code. Key-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statusOf, renderStatus } from '../../permutation-server/web/frontier/hud/status.mjs';
import { failureText, CLIENT_CODES } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const text = s => String(s);

test('a sent march whose outcome is unknown: the "unconfirmed" state, never a refusal titled with another action', () => {
  // the last control pressed was the muster's: before the fix its words titled the march's notice
  const FS = { lastAct: { kind: 'act', name: 'muster' }, notice: { busy: false, text: () => '進軍は送信済みですが…', code: 'LocalActUnconfirmed', unsent: 'march-send' } };
  const st = statusOf(FS, { canRetry: true });
  assert.equal(st.state, 'unconfirmed');
  assert.equal(st.what, null);
  const html = text(renderStatus(st));
  assert.ok(!html.includes('できませんでした'), html);
  assert.ok(!html.includes('編成はまだ命じられていません'), html);
  // the same notice WITHOUT its code (the old controller line) was the bug
  const old = statusOf({ ...FS, notice: { ...FS.notice, code: undefined, unsent: undefined } }, { canRetry: true });
  assert.equal(old.state, 'refused'); assert.match(text(old.what), /編成はまだ命じられていません/);
});

test('a rejected march: a refusal that says the march was not sent (its own words, whatever the last control was)', () => {
  const FS = { lastAct: { kind: 'act', name: 'muster' }, compose: null, notice: { ok: false, code: 'LocalMarchRejected', programCode: 26, unsent: 'march-send', text: () => 'reason' } };
  const st = statusOf(FS, { canRetry: true });
  assert.equal(st.state, 'refused');
  assert.match(text(st.what), /進軍は送られていません/);
});

test('the new codes have texts in both languages; NotResident is named by its program code', () => {
  for (const c of ['LocalActRejected', 'LocalMarchRejected', 'LocalMarchExpired']) assert.ok(CLIENT_CODES.includes(c), c);
  assert.match(text(failureText({ code: 'LocalMarchRejected' })), /送られていません/);
  assert.match(text(failureText({ code: 'LocalMarchRejected', programCode: 26 })), /決着/);
  setLang('en');
  try {
    assert.match(text(failureText({ code: 'LocalMarchRejected' })), /not sent/i);
    assert.match(text(failureText({ code: 'LocalMarchExpired' })), /now it never will be/);
  } finally { setLang('ja'); }
});

test('the controller: a rejection goes back to the card; a held march is re-checked a bounded number of times; the march press waits out a turn end', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const HELD_RECHECK_MS = 5000, HELD_RECHECK_TRIES = 24;/);
  assert.match(src, /if \(\+\+n >= tries\) \{ heldRechecks\.delete\(signature\); return; \}/, 'bounded');
  assert.match(src, /const marchNearEnd = \(\) => nearTurnEnd\(/);
  assert.match(src, /busy: !!card\.sending \|\| FS\.inFlight > 0 \|\| marchNearEnd\(\)/, 'a waiting march is not sent in the last moments of a turn');
  // only the march's compose stays open on a refusal: FS.compose is cleared on success alone
  const from = src.indexOf('async function sendTheMarch()'), body = src.slice(from, src.indexOf('\n}\n', from));
  assert.equal(body.split('FS.compose = null').length - 1, 1);
  assert.ok(body.indexOf('FS.compose = null') < body.indexOf('} else {'), 'cleared on the success branch only');
});
