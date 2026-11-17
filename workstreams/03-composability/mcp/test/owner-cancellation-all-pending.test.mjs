// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// The owner's view lists the newest 50 operations, but a revoked connection's cancellation counts every unfinished
// operation of that connection (server.mjs ownerOperations):
//   C1 the defect it closes: cancellationOf over a partial list (the 50 newest) can say done while an older operation
//      of the link is still unfinished; over all of the link's operations it says reconciling and names it
//   C2 server.mjs passes the link's main-store operations to the cancellation; the listed 50 are unchanged
//   C3 unfinished operations are never archived, so the main store has all of them
// KEY-FREE: imports node:test, node:assert/strict, node:fs and ../src/ports.mjs (no imports); server.mjs is read as
// text. Plain objects only; nothing is sent, fetched or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cancellationOf } from '../src/ports.mjs';

const link = { linkId: 'l1', revokedAt: Date.UTC(2026, 10, 17) };
const old = { id: 'op_old', linkId: 'l1', state: 'accepted' };
const recent = Array.from({ length: 50 }, (_, i) => ({ id: `op_${i}`, linkId: 'l2', state: 'completed' }));

test('C1 a partial list says done; all of the link\'s operations do not', () => {
  const listed = recent.filter(o => o.linkId === 'l1'); // the 50 newest belong to another link: none of l1's is listed
  assert.equal(cancellationOf(link, listed).state, 'done', 'the old reading');
  const all = [old, ...recent].filter(o => o.linkId === 'l1');
  assert.deepEqual([cancellationOf(link, all).state, cancellationOf(link, all).awaitingReconciliation], ['reconciling', ['op_old']]);
});

test('C2 ownerOperations: the cancellation reads the link\'s main-store operations; the list stays 50', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function ownerOperations(owner) {'), src.indexOf('async function opStatus('));
  assert.match(fn, /const ops = store\.operationsOf\(\[\.\.\.ids\], 50\);/);
  assert.match(fn, /cancellation: receipts\.cancellation\(l, Object\.values\(db\.operations\)\.filter\(o => o\.linkId === l\.linkId\)\) \}\)\),/);
  assert.doesNotMatch(fn, /receipts\.cancellation\(l, ops\.filter/);
});

test('C3 only finished operations are archived', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(!TERMINAL\.includes\(op\.state\) \|\| inflight\.has\(op\.id\) \|\| now\(\) - Date\.parse\(op\.updatedAt \?\? op\.createdAt\) < archiveAfterMs\) continue;\n\s+store\.archive\(op\);/);
});
