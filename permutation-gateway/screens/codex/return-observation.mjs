// Synthetic read-only presentation observations for the original player page.
// These transitions are server fixture choices, never results of game writes.
import { requestDigest, REPORT_SCHEMA } from '../../../permutation-server/web/frontier/fexpedition.mjs';
import { canonicalExpeditionAccounts, canonicalExpeditionRoles } from '../../../permutation-server/web/frontier/fexpedition-identity.mjs';

const CLOSED = Object.freeze({ dispatch_available:false, admitted:false, signed:false, enqueued:false,
  automatic_send:false, completion_proven:false, history_verified:false });

export function syntheticReturnInspection(request, { phase = 'dissolve' } = {}) {
  const canonical = canonicalExpeditionAccounts(request);
  const next = { dissolve:'OwnerDissolve', resolving:'ResolveVoluntaryLeave', return:'ReturnOriginalReserve' }[phase];
  if (!next) throw new Error('SyntheticReturnPhase');
  const action = phase === 'dissolve' ? 'Dissolve' : phase === 'return' ? 'Return' : null;
  const facts = {
    key:`original-expedition-review:${request.host}:${canonical.standing_key}:${request.original_owner}`,
    kind:'original-expedition-review', host:request.host, standing_key:canonical.standing_key,
    original_owner:request.original_owner, accounts:canonical.accounts, next_prerequisite:next,
    observed:{ kind:'original-host-wide-resident', entry:0, state:phase === 'return' ? 3 : 1, unit:0,
      troops_milli:'600000', pending_bell:'9', resolved_next:phase === 'resolving' ? '9' : '10',
      return_units:phase === 'return' ? '600' : null, reserve_after:phase === 'return' ? '1000' : null },
    min_slot:request.min_slot, context_slot:'5000',
    clock:{slot:'5000',unix_timestamp:'1800006000',bell:'10',status_promoted_by_clock:false},
    coherent:true,provenance_verified:false,tag:null,instruction:null,...CLOSED,
    denials:['OriginalHostDispatchUnavailable','SourceProvenanceUnverified','HistoryUnverified',
      'ExecutionEvidenceUnverified','SignerAbsent','SliceDoesNotEnqueue','SnapshotCurrencyUnknown'],
  };
  return {schema:REPORT_SCHEMA,status:'preview',stage:'plan',request_digest:requestDigest(request),scope:structuredClone(request),
    source:{kind:'single_snapshot_source',read_calls:'1',coherent:true,single_response:true,context_slot:'5000',
      digest:'ab'.repeat(32),authority_verified:false,freshness:'unknown',complete_world_view:false},
    blocker:null,facts,draft:action ? {kind:'closed-resident-role-draft',action,
      roles:canonicalExpeditionRoles(request,action),dispatch_available:false,admitted:false} : null,
    draft_blocker:action ? null : 'NoResidentDraftAtThisStage',...CLOSED};
}
