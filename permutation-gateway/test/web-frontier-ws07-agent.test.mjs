// Workstream 07: the agent page says what became of each sent action as workstream 4 names it (GET /f/agent/fate:
// EXECUTION-CONTRACT-20261106 §1, seven states), and a read that fails is not an empty answer. FIXTURE views only;
// no wallet signs and no key is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as AG from '../../permutation-server/web/frontier/fagent.mjs';
import { SEND_STATES } from '../../permutation-server/web/frontier/hud/statusview.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const view = { agentId: 'ag1', history: [
  { type: 'action', name: 'Muster', status: 'sent', key: 'k1', at: 1 },
  { type: 'action', name: 'Depart', status: 'failed', code: 'X', key: 'k2', at: 2, signature: 'sig2' },
  { type: 'action', name: 'Harvest', status: 'refused', code: 'NotOwner', key: 'k3', at: 3 },
] };

test('which actions are asked: those that may have left the relay (sent, or failed after it), not a refusal', () => {
  assert.deepEqual(AG.fateKeys(view), ['k1', 'k2']);
  assert.deepEqual(AG.fateKeys({ history: Array.from({ length: 14 }, (_, i) => ({ type: 'action', status: 'sent', key: `k${i}` })) }, 10).length, 10);
});

test('the relay\'s answer is 04\'s state; a failed read or an unknown word is "could not be queried", never a failure', () => {
  for (const s of SEND_STATES) assert.equal(AG.fateState({ ok: true, state: s }), s);
  assert.equal(AG.fateState({ ok: false, code: 'HTTP503' }), 'unqueryable');
  assert.equal(AG.fateState(null), 'unqueryable');
  assert.equal(AG.fateState({ ok: true, state: 'cancelled' }), 'unqueryable', 'a word 04 does not use is not guessed into one');
});

test('each sent action carries its state line under it, in Japanese and English; the plain "送信" never stands for the outcome alone', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const fates = new Map([['k1', 'pending'], ['k2', 'unknown']]);
    const h = String(AG.renderHistory(view, { fates }));
    assert.match(h, /data-key="send:pending"/);
    assert.match(h, /data-key="send:unknown"/);
    assert.equal((h.match(/data-key="send:/g) ?? []).length, 2, 'a refused action has no send state');
    const t = text(h);
    if (lang === 'en') { assert.match(t, /Waiting to be finalized/); assert.match(t, /The outcome is unknown/); assert.doesNotMatch(t, /[぀-ヿ一-鿿]/); }
    else { assert.match(t, /確定を待っています/); assert.match(t, /結果は不明です/); }
    for (const s of SEND_STATES) assert.match(String(AG.renderHistory(view, { fates: new Map([['k1', s]]) })), new RegExp(`data-key="send:${s}"`));
  }
  setLang('ja');
});

test('a history not read again says the shown one is older; an agent never read is not "nothing yet" for a failed read', () => {
  setLang('en');
  const t = text(AG.renderHistory(view, { read: { ok: false, code: 'HTTP502' } }));
  assert.match(t, /The agent(&#39;|')s latest history could not be loaded \(HTTP502\)\. What is shown here is what was loaded before/);
  assert.doesNotMatch(text(AG.renderHistory(view, { read: { ok: true } })), /could not be loaded/);
  setLang('ja');
});
