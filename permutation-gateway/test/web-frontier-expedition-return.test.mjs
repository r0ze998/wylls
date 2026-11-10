// Exact local public-fixture tests: no keys, signing, seals, fetch, or transaction path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { originalReturnModel } from '../../permutation-server/web/frontier/fexpedition-return.mjs';
import { REPORT_SCHEMA, requestDigest } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { canonicalExpeditionAccounts } from '../../permutation-server/web/frontier/fexpedition-identity.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../frontier-node/crates/fclient/tests/fixtures/original_resident_draft_v1.json', import.meta.url), 'utf8'));
const [dissolve, returned] = fixture.cases;
const clone = x => JSON.parse(JSON.stringify(x));
const CLOSED = { dispatch_available: false, admitted: false, signed: false, enqueued: false,
  automatic_send: false, completion_proven: false, history_verified: false };
function report(c = dissolve) {
  const r = clone(c.request), canonical = canonicalExpeditionAccounts(r), isReturn = c.action === 'Return';
  const slot = (BigInt(r.min_slot) + 10n).toString();
  return { schema: REPORT_SCHEMA, status: 'preview', stage: 'plan', request_digest: requestDigest(r), scope: r,
    source: { kind: 'single_snapshot_source', read_calls: '1', coherent: true, single_response: true,
      context_slot: slot, digest: 'ab'.repeat(32), authority_verified: false, freshness: 'unknown', complete_world_view: false },
    blocker: null, facts: {
      key: `original-expedition-review:${r.host}:${canonical.standing_key}:${r.original_owner}`,
      kind: 'original-expedition-review', host: r.host, standing_key: canonical.standing_key,
      original_owner: r.original_owner, accounts: canonical.accounts,
      next_prerequisite: isReturn ? 'ReturnOriginalReserve' : 'OwnerDissolve',
      observed: { kind: 'original-host-wide-resident', entry: 0, state: isReturn ? 3 : 1, unit: 0,
        troops_milli: '600000', pending_bell: isReturn ? '9' : '0', resolved_next: '10',
        return_units: isReturn ? '600' : null, reserve_after: isReturn ? '1000' : null },
      min_slot: r.min_slot, context_slot: slot, clock: { slot, unix_timestamp: '1000', bell: '10', status_promoted_by_clock: false },
      coherent: true, provenance_verified: false, tag: null, instruction: null, ...CLOSED,
      denials: ['OriginalHostDispatchUnavailable', 'SourceProvenanceUnverified', 'HistoryUnverified',
        'ExecutionEvidenceUnverified', 'SignerAbsent', 'SliceDoesNotEnqueue', 'SnapshotCurrencyUnknown'] },
    draft: { kind: 'closed-resident-role-draft', action: c.action, roles: clone(c.expected.roles), dispatch_available: false, admitted: false },
    draft_blocker: null, ...CLOSED };
}
function noDraft(r, blocker = 'NoResidentDraftAtThisStage') { r.draft = null; r.draft_blocker = blocker; return r; }
function waitReport() {
  const r = noDraft(report()); r.facts.next_prerequisite = 'ResolveVoluntaryLeave';
  r.facts.observed.pending_bell = '9'; r.facts.observed.resolved_next = '9'; return r;
}
function closed(x) {
  for (const k of [...Object.keys(CLOSED), 'public_dispatch_available', 'executable', 'authority_verified', 'snapshot_content_verified']) assert.equal(x[k], false, k);
  assert.equal(x.observation_only, true);
}

for (const c of fixture.cases) test(`closed draft independently matches native/public contract fixture: ${c.id}`, () => {
  const r = report(c), before = JSON.stringify(r), model = originalReturnModel(r, c.request), p = model.proposal;
  assert.equal(p.byte_length, 60); assert.equal(p.bytes_hex, c.expected.bytes_hex);
  assert.equal(p.content_digest, c.expected.content_digest); assert.deepEqual(p.roles, c.expected.roles);
  assert.equal(p.standing.key, c.expected.standing_key); assert.deepEqual(p.standing, { ...c.request.standing, key: c.expected.standing_key });
  assert.equal(p.action, c.action); assert.equal(p.host, c.request.host);
  assert.equal(p.program, c.request.program); assert.equal(p.season, c.request.season);
  assert.deepEqual(p.binding.request, c.request); assert.equal(p.binding.request_digest, requestDigest(c.request));
  assert.equal(p.binding.snapshot_digest, r.source.digest); assert.equal(p.binding.context_slot, r.source.context_slot);
  assert.deepEqual(p.binding.clock, r.facts.clock); closed(model); closed(p);
  assert.equal(JSON.stringify(r), before); assert.deepEqual(clone(model), model);
  assert.ok(Object.isFrozen(model) && Object.isFrozen(p.roles[0]) && Object.isFrozen(p.binding.request.standing));
  if (c.action === 'Return') assert.deepEqual(p.roles.filter(x => x.signer).map(x => x.name), ['payer']);
});

test('resident, Leave resolution and reserve return remain distinct observations with no completion claim', () => {
  const resident = originalReturnModel(report(), dissolve.request);
  const waiting = originalReturnModel(waitReport(), dissolve.request);
  const r = report(returned); r.facts.observed.troops_milli = '600999';
  const ready = originalReturnModel(r, returned.request);
  assert.deepEqual([resident.phase, waiting.phase, ready.phase], ['resident', 'leave-pending', 'return-pending']);
  assert.deepEqual([resident.proposal.action, waiting.proposal, ready.proposal.action], ['Dissolve', null, 'Return']);
  assert.deepEqual(ready.steps.map(x => x.status), ['observed', 'observed', 'proposal']);
  assert.equal(ready.returnUnits, '600'); assert.equal(ready.reserveAfter, '1000');
  for (const m of [resident, waiting, ready]) {
    assert.ok(m.steps.every(s => s.status !== 'done')); closed(m);
    assert.doesNotMatch(m.titleJa + m.detailJa + m.steps.map(s => s.labelJa).join(''), /Dissolve|Leave|Return|bell/);
  }
});

test('unknown or contradictory resident state and reserve arithmetic cannot create proposals', () => {
  const mutations = [
    r => { r.facts.observed.state = 2; }, r => { r.facts.observed.state = 1; },
    r => { r.facts.observed.entry = 56; }, r => { r.facts.observed.pending_bell = '11'; },
    r => { r.facts.observed.resolved_next = '9'; }, r => { r.facts.observed.return_units = '601'; },
    r => { r.facts.observed.reserve_after = '599'; }, r => { r.facts.observed.reserve_after = '4294967296'; },
    r => { r.facts.next_prerequisite = 'Completed'; }, r => { r.facts.observed.kind = 'unknown'; },
  ];
  for (const mutate of mutations) { const r = report(returned); mutate(r); assert.throws(() => originalReturnModel(r, returned.request)); }
  const behind = report(); behind.facts.observed.resolved_next = '8';
  assert.throws(() => originalReturnModel(behind, dissolve.request));
  const resolved = waitReport(); resolved.facts.observed.state = 3; resolved.facts.observed.resolved_next = '10';
  assert.throws(() => originalReturnModel(resolved, dissolve.request));
});

test('current request binding rejects stale selection, deployment, host, wallet and minimum slot', () => {
  const r = report();
  for (const mutate of [
    q => { q.standing.p = '129'; }, q => { q.min_slot = '6051'; }, q => { q.wallet = q.payer; },
    q => { q.payer = q.wallet; }, q => { q.cluster = 'other'; },
    q => { q.deployment.ruleset_hash = 'cd'.repeat(32); }, q => { q.host = q.host.slice(0, -2) + '01'; },
    q => { q.program = q.payer; }, q => { q.season = q.payer; },
  ]) { const q = clone(dissolve.request); mutate(q); assert.throws(() => originalReturnModel(r, q)); }
  assert.throws(() => originalReturnModel(r, null));
  const wrongDigest = report(); wrongDigest.request_digest = '00'.repeat(32);
  assert.throws(() => originalReturnModel(wrongDigest, dissolve.request));
});

test('forged draft bytes, roles, action, admission and raw proposals are rejected', () => {
  for (const mutate of [
    r => { r.draft.bytes_hex = dissolve.expected.bytes_hex; }, r => { r.draft.roles[0].writable = true; },
    r => { r.draft.action = 'Return'; }, r => { r.signed = true; }, r => { r.admitted = true; },
    r => { r.facts.completion_proven = true; }, r => { r.source.authority_verified = true; },
    r => { r.facts.clock.slot = '9999'; },
  ]) { const r = report(); mutate(r); assert.throws(() => originalReturnModel(r, dissolve.request)); }
  const p = originalReturnModel(report(), dissolve.request).proposal;
  for (const raw of [p, clone(p), p.bytes_hex, new Uint8Array(60)]) assert.throws(() => originalReturnModel(raw, dissolve.request));
});

test('snapshot binding changes independently of identical closed proposal content', () => {
  const r = report(), first = originalReturnModel(r, dissolve.request);
  r.source.digest = 'cd'.repeat(32); r.source.context_slot = '6061';
  r.facts.context_slot = '6061'; r.facts.clock.slot = '6061';
  const second = originalReturnModel(r, dissolve.request);
  assert.equal(first.proposal.content_digest, second.proposal.content_digest);
  assert.notDeepEqual(first.binding, second.binding); assert.notDeepEqual(first.proposal.binding, second.proposal.binding);
  closed(second.proposal);
});

test('blocked and missing wallet/payer observations produce no proposal and explicit display states', () => {
  const r = report(); r.status = 'blocked'; r.stage = 'snapshot'; r.blocker = { code: 'SnapshotUnavailable' };
  r.facts = null; r.draft = null; r.draft_blocker = null;
  const blocked = originalReturnModel(r, dissolve.request);
  assert.equal(blocked.phase, 'unavailable'); assert.equal(blocked.code, 'SnapshotUnavailable'); assert.equal(blocked.proposal, null);
  for (const [c, field, code] of [[dissolve, 'wallet', 'WalletProposalRequired'], [returned, 'payer', 'PayerProposalRequired']]) {
    const altered = clone(c); altered.request[field] = null;
    const m = originalReturnModel(noDraft(report(altered), code), altered.request);
    assert.equal(m.proposal, null); assert.equal(m.code, code); assert.ok(m.steps.every(s => s.status !== 'proposal'));
  }
});

test('bridge stages remain pending and reject unknown state or invalid lead range', () => {
  for (const [next, state] of [['OriginalDepartureResolution', 'Departed'], ['OriginalDepartureSettlement', 'Departed'],
    ['RevealOrGatherEvidence', 'Settled'], ['OriginDestroyedSettlementOrCleanupEvidence', 'DestroyedAtOrigin'],
    ['DestinationResolveOrSettlementEvidence', 'Gathered']]) {
    const r = noDraft(report()); r.facts.next_prerequisite = next;
    r.facts.observed = { kind: 'owned-bridge-v2', slot: 0, state, depart_bell: '8', arrive_bell: '10', destination_bound: true };
    const m = originalReturnModel(r, dissolve.request);
    assert.equal(m.phase, 'expedition-pending'); assert.equal(m.proposal, null); assert.equal(m.code, next); closed(m);
    r.facts.observed.state = 'Free'; assert.throws(() => originalReturnModel(r, dissolve.request));
    r.facts.observed.state = state; r.facts.observed.arrive_bell = '9'; assert.throws(() => originalReturnModel(r, dissolve.request));
  }
});
