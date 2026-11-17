// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// A Duplicate whose answer was lost: the agent wallet's own record for this key says Duplicate and names the earlier
// send's signature. That signature is never taken as this request's (no gateway.signature, no caravan.mine, no
// processing); another of this server's operations holding it → DuplicateOfOperation; otherwise held Duplicate;
// nothing is re-sent; repeated reads change nothing (no second grant count, no new steps, no hold released).
//   U1 lost answer + Duplicate record, the earlier transaction lands: held Duplicate, never mine/processing, counted once
//   U2 a same-requestId send_caravan after U1's loss: not re-sent, same answer
//   U3 the earlier transaction is this server's own operation: DuplicateOfOperation, the hold given back (counted once)
//   U4 the earlier transaction is proven never to land: failed (NotLanded), as the answered Duplicate
//   U5 server.mjs source: one Duplicate handler (markDuplicate) for the answer, the fate and the older wallet's record
// KEY-FREE, PDA-FREE: harness.mjs (the real AgentGateway with a keyring that cannot sign; the send, the node and the
// herald scripted). The wallet's record line is written by the test in the real ledger's shape for a Duplicate
// (gateway.mjs refused(): status failed, code Duplicate, sent null, duplicateOf and signature the earlier send's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HAS_FATE, keyfreeWorld, mcpServer } from './harness.mjs';

const skip = HAS_FATE ? false : 'needs a wallet tree with actionFateView (WS03_GATEWAY_ROOT)';
const LINK = 'lnk_keyfree_01'; // mcpServer.connectViaRelay's default link id
const duplicateLine = (requestId, earlier) => ({ type: 'action', name: 'SendCaravan', key: `ws03:${LINK}:${requestId}`, source: 'mcp', status: 'failed', code: 'Duplicate',
  sent: null, duplicateOf: earlier, signature: earlier, lastValidBlockHeight: 150, slotFloor: 70 });
const receipt = x => x.error?.receipt ?? x; // a failed operation comes back as fail(code, message, {operationId, receipt})

test('U1/U2 lost answer of a Duplicate: held, never this request\'s, counted once, not re-sent', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  const p = await s.plan(linkId);
  w.script.next = 'unreachable'; // the answer is lost (nothing recorded by the script)
  await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-dlost1' });
  const earlier = 'sig-earlier-1';
  w.history.push(duplicateLine('req-kf-dlost1', earlier));
  w.node.statuses.set(earlier, { slot: 80, err: null, confirmationStatus: 'finalized' }); // the earlier transaction landed
  const posts = w.script.posts;
  const r = receipt(await s.tool(linkId, 'get_operation_status', { requestId: 'req-kf-dlost1' }));
  assert.deepEqual([r.state, r.hold?.code, r.gateway?.signature, r.gateway?.duplicateOf], ['accepted', 'Duplicate', null, earlier]);
  assert.equal(r.caravan?.mine, undefined, 'never mine');
  assert.equal((await s.tool(linkId, 'get_connection')).grant.used, 1, 'counted once');
  const steps = r.history.length;
  // Repeated reads: no new step, no second count, the hold kept.
  for (let i = 0; i < 3; i++) {
    const again = receipt(await s.tool(linkId, 'get_operation_status', { requestId: 'req-kf-dlost1' }));
    assert.deepEqual([again.state, again.hold?.code, again.gateway?.signature, again.history.length], ['accepted', 'Duplicate', null, steps]);
  }
  assert.equal((await s.tool(linkId, 'get_connection')).grant.used, 1);
  // U2: the same requestId again: answered from the record, nothing posted.
  const retry = receipt(await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-dlost1' }));
  assert.deepEqual([retry.state, retry.hold?.code], ['accepted', 'Duplicate']);
  assert.equal(w.script.posts, posts, 'not re-sent');
});

test('U3 the earlier transaction is this server\'s own operation: DuplicateOfOperation, counted once', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  const first = receipt(await s.tool(linkId, 'send_caravan', { planId: (await s.plan(linkId)).planId, requestId: 'req-kf-down01' }));
  assert.equal(first.state, 'accepted');
  const p2 = await s.plan(linkId);
  w.script.next = 'unreachable';
  await s.tool(linkId, 'send_caravan', { planId: p2.planId, requestId: 'req-kf-down02' });
  w.history.push(duplicateLine('req-kf-down02', first.gateway.signature));
  const x = await s.tool(linkId, 'get_operation_status', { requestId: 'req-kf-down02' });
  const r = receipt(x);
  assert.deepEqual([x.error?.code, r.state, r.error?.duplicateOfOperation, r.gateway?.signature], ['DuplicateOfOperation', 'failed', first.operationId, null]);
  assert.equal((await s.tool(linkId, 'get_connection')).grant.used, 1, 'the first operation carries the count');
});

test('U4 the earlier transaction is proven never to land: NotLanded, as the answered Duplicate', { skip }, async () => {
  const w = await keyfreeWorld({ relay: 'ws05' });
  const s = mcpServer(w);
  const { linkId } = await s.connectViaRelay();
  const p = await s.plan(linkId);
  w.script.next = 'unreachable';
  await s.tool(linkId, 'send_caravan', { planId: p.planId, requestId: 'req-kf-dexp01' });
  w.history.push(duplicateLine('req-kf-dexp01', 'sig-earlier-x'));
  w.node.height = 200; w.node.first = 0; // the node's history covers its lifetime: no such transaction
  const x = await s.tool(linkId, 'get_operation_status', { requestId: 'req-kf-dexp01' });
  assert.deepEqual([x.error?.code, receipt(x).state], ['NotLanded', 'failed']);
});

test('U5 one Duplicate handler for the answer, the fate and the older wallet\'s record', () => {
  const src = readFileSync(new URL('../../src/server.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/'DuplicateOfOperation'/g) ?? []).length, 1, 'DuplicateOfOperation is decided in one place');
  assert.match(src, /markDuplicate\(op, link, res\.duplicateOf \?\? res\.signature \?\? null, \{ by: 'agent wallet gateway \(Duplicate\)'/);
  assert.match(src, /if \(f\.code === 'Duplicate' && !op\.gateway\?\.signature && !isDuplicate\(op\)\) \{\n\s+markDuplicate\(op, link, f\.signature \?\? null/);
  assert.match(src, /if \(rec\.entry\?\.code === 'Duplicate'\) \{\n\s+markDuplicate\(op, link, rec\.entry\.signature \?\? null/);
  // The fate's Duplicate is handled before the branch that adopts a recorded signature as this request's.
  assert.ok(src.indexOf("if (f.code === 'Duplicate'") < src.indexOf('if (f.signature && !op.gateway?.signature) {'));
  // recover: before its adoption branch.
  assert.ok(src.indexOf("if (rec.entry?.code === 'Duplicate')") < src.indexOf('    if (sig) {'));
  assert.doesNotMatch(src, /op\.gateway\?\.duplicateOf\)/, 'presence, not truthiness, marks a Duplicate (duplicateOf may be null)');
});
