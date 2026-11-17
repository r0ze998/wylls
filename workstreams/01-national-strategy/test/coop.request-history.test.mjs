// 依頼の記録（2026-11-17。WRITTEN ONLY, NOT RUN）：history.mjs requestHistory と、画面の結線（読むだけ・状態にかかわらず）。
// 鍵・署名・送信・HTTP・起動なし。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OUTCOME_JA, requestHistory } from '../coop/history.mjs';

const ME = 'Me111', OTHER = 'Ot222';
const sending = (seq, outcome, who = ME) => ({ kind: 'sending', responder: who, caravan: { ownerTag: '77', seq }, walletSig: `w${seq}`, cargo: { wood: 10 }, src: { p: 4, q: 0, site: 5, gen: 1 }, ...(outcome === undefined ? {} : { outcome }) });
const closed = (o = {}) => ({
  id: 'r1', stateNow: 'expired', links: [{ caravan: { ownerTag: '77', seq: 2 }, responder: ME }],
  sendings: [sending(1, { status: 'unknown', why: '見えない' }), sending(2, { status: 'landed' }), sending(3, { status: 'landed' }), sending(4, { status: 'failed', why: 'Insufficient' }, OTHER), sending(5)],
  arrivals: [
    { caravanId: { ownerTag: '77', seq: 2 }, state: 'delivered', counted: { wood: 9 }, countFinal: true },
    { caravanId: { ownerTag: '77', seq: 9 }, state: 'moving', counted: null, notCountedWhy: '輸送中', countFinal: false },
  ],
  ...o,
});

test('a closed request keeps its saved sends, their checked outcome, links, arrivals and counts', () => {
  const h = requestHistory(closed(), ME);
  assert.deepEqual(h.sendings.map(z => [z.seq, z.status, z.link, z.mine]), [[1, 'unknown', null, true], [2, 'landed', 'linked', true], [3, 'landed', 'unlinked', true], [4, 'failed', null, false], [5, 'unknown', null, true]]);
  assert.equal(h.sendings[4].why, '板の答えに結果がない', 'no outcome in the answer is unknown, never sent or not sent');
  assert.deepEqual(h.sendings[0].src, { p: 4, q: 0, site: 5, gen: 1 });
  assert.deepEqual(h.arrivals.map(x => [x.seq, x.state, x.counted, x.final]), [[2, 'delivered', { wood: 9 }, true], [9, 'moving', null, false]]);
  assert.equal(h.arrivals[1].why, '輸送中');
});

test('nothing is made up: missing fields are unread (null), an unknown status stays unknown, a not-counted arrival has no amount', () => {
  const h = requestHistory(closed({ sendings: undefined, arrivals: 'x' }), ME);
  assert.equal(h.sendings, null);
  assert.equal(h.arrivals, null);
  const w = requestHistory(closed({ sendings: [sending(1, { status: 'weird' })] }), ME).sendings[0];
  assert.equal(w.status, 'weird');
  assert.equal(w.known, false);
  const e = requestHistory(closed({ sendings: [], arrivals: [] }), ME);
  assert.deepEqual([e.sendings, e.arrivals], [[], []]);
  const n = requestHistory(closed({ arrivals: [{ caravanId: { ownerTag: '1', seq: 1 }, state: 'unknown', counted: 0 }] }), ME).arrivals[0];
  assert.equal(n.counted, null, 'a counted that is not an object is not an amount');
  assert.equal(requestHistory(closed(), null).sendings.every(z => z.mine === false), true, 'no viewer: nothing is mine');
});

test('the words cover exactly the outcomes chain.mjs sendOutcome returns; landed is not arrived', () => {
  const chain = readFileSync(new URL('../coop/chain.mjs', import.meta.url), 'utf8');
  const f = chain.slice(chain.indexOf('export async function sendOutcome('), chain.indexOf('\n}\n', chain.indexOf('export async function sendOutcome(')));
  const statuses = [...new Set([...f.matchAll(/status: '([a-z-]+)'/g)].map(m => m[1]))].sort();
  assert.deepEqual(Object.keys(OUTCOME_JA).sort(), statuses);
  assert.match(OUTCOME_JA.landed, /到着ではない/);
  assert.match(OUTCOME_JA.unknown, /送っていないとは言わない/);
});

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');
const hist = readFileSync(new URL('../coop/history.mjs', import.meta.url), 'utf8');
const between = (a, b) => ui.slice(ui.indexOf(a), ui.indexOf(b, ui.indexOf(a)));

test('the page shows the record on every request, whatever its state or answer, and only reads', () => {
  assert.match(ui, /\n      \$\{historyHtml\(q, me\)\}\n    <\/div>`;\n  \}\)\.join\(''\) : '<div class="note">依頼はまだない<\/div>';/, 'outside every open/accepted/destination condition');
  const h = between('function historyHtml(q, me) {', '\n}\n');
  for (const src of [h, hist]) assert.doesNotMatch(src, /post\(|followSend\(|sendOnce\(|sendFor\(|sendPlanned\(|signRecord\(|fetch\(|api\(|apiRead\(/, 'read only: no record, no link, no send, no new read');
  assert.match(h, /'<li class="warn">送信の記録が読めない（ないとは言わない）<\/li>'/);
  assert.match(h, /'<li class="warn">到着の記録が読めない（ないとは言わない）<\/li>'/);
  assert.match(h, /数えていない（\$\{esc\(x\.why \?\? '理由は記録にない'\)\}/);
  assert.match(h, /z\.known \? OUTCOME_JA\[z\.status\] : `分からない（\$\{z\.status\}）`/);
});

test('the record stays open across re-reads, and opens for the request the entry pointed at', () => {
  assert.match(ui, /const historyOpen = new Set\(\);/);
  assert.match(ui, /\$\{historyOpen\.has\(q\.id\) \? ' open' : ''\}/);
  assert.match(ui, /document\.addEventListener\('toggle', e => \{[\s\S]*?if \(d\.open\) historyOpen\.add\(d\.dataset\.req\); else historyOpen\.delete\(d\.dataset\.req\);\n\}, true\);/);
  const f = between('function applyFocus()', 'function staleSay(');
  assert.match(f, /if \(!focus\.seen\) \{ historyOpen\.add\(q\.id\); el\.querySelector\('details\.req-history'\)\?\.setAttribute\('open', ''\); \}/);
  assert.doesNotMatch(f, /post\(|sendFor\(|sendOnce\(|followSend\(|click\(\)/);
});
