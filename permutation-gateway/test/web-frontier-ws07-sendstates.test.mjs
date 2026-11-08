// Workstream 07: 04's seven states of a signed send kept apart up to the screen (EXECUTION-CONTRACT-20261106 §1).
// GET /f/tx answers landed, failed or unknown (04 §2: its "unknown" covers pending and unknown); a read that never
// answers is "unqueryable", not "unknown" and never a failure. No key, no signature: txStatus is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { track } from '../../permutation-server/web/frontier/fplay.mjs';
import * as SV from '../../permutation-server/web/frontier/hud/statusview.mjs';
import { clientText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const wait = async () => {};

test('track keeps "no answer" (unqueryable) apart from "answered: not final" (unknown); neither is failed', async () => {
  const seq = answers => { let i = 0; return async () => { const a = answers[Math.min(i++, answers.length - 1)]; if (a instanceof Error) throw a; return a; }; };
  const run = answers => track('sig', { tries: 3, wait, read: seq(answers) });
  assert.deepEqual(await run([{ ok: true, state: 'landed', slot: 9 }]), { ok: true, state: 'landed', slot: 9 });
  assert.equal((await run([{ ok: true, state: 'failed', code: 'X' }])).state, 'failed');
  assert.deepEqual(await run([{ ok: true, state: 'unknown' }]), { ok: false, state: 'unknown', code: 'Unconfirmed' });
  assert.deepEqual(await run([{ ok: false, code: 'HTTP503' }]), { ok: false, state: 'unqueryable', code: 'TxUnqueryable' });
  assert.deepEqual(await run([new Error('down')]), { ok: false, state: 'unqueryable', code: 'TxUnqueryable' }, 'a thrown read is no answer, not a crash');
  assert.deepEqual(await run([{ ok: true, state: 'unknown' }, { ok: false, code: 'network' }]), { ok: false, state: 'unknown', code: 'Unconfirmed' }, 'once answered, a later lost read does not make it unqueryable');
  setLang('en');
  assert.match(clientText('TxUnqueryable'), /could not be queried\. This does not mean it failed/);
  assert.doesNotMatch(clientText('Unconfirmed'), /fail/i);
  setLang('ja');
});

test('the seven states: each its own symbol-and-words line; only landed, failed, expired, not-sent say final; none of the open ones says failed', () => {
  setLang('ja');
  const v = SV.SEND_STATES.map(state => SV.sendView({ state }));
  assert.deepEqual(v.map(x => x.key), SV.SEND_STATES.map(s => `send:${s}`));
  assert.ok(v.every(x => x.ok && x.errors.length === 0));
  assert.equal(new Set(v.map(x => x.text)).size, 7, 'seven texts, none merged');
  for (const x of v) {
    const t = [x.text, ...x.details].join();
    if (['send:pending', 'send:unknown', 'send:unqueryable'].includes(x.key)) { assert.doesNotMatch(t, /（確定）/); assert.match(t, /失敗したという意味ではありません|失敗とも成功とも言いません/); }
    else assert.match(t, /（確定）/);
  }
  assert.equal(SV.sendView({ state: 'cancelled' }).ok, false, 'a state 04 does not name is not received');
  setLang('en');
  const jp = /[぀-ヿ一-鿿]/;
  for (const x of SV.SEND_STATES.map(state => SV.sendView({ state }))) assert.doesNotMatch([x.text, ...x.details].join(' '), jp, x.key);
  setLang('ja');
});
