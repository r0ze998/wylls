// Workstream 12: workstream 4's read observation (`ws04-observation/0`) as a HELD report only (2026-11-17).
// Producer: workstream 4 `runexec::observation::read_observations` (branch codex/ws04-read-observation-20261116 @
// 7baa4d93, src/observation.rs and docs/READ-OBSERVATION-20261116.md): decoded CARAVAN_SETTLED / CARAVAN_RAIDED rows of
// a findex DB, read in one read-only transaction; `basis: 'unproven'`, `world`/`finality`/`complete` null, every
// observation held for world_binding_unproven, finality_unproven, transaction_record_identity_unproven and
// committed_frame_unproven; each page held for not_executor_receipts, source_provenance_unproven and
// resume_cursor_not_admitted. 4's own contract with 12/13: the page is NOT a store of receipts and MUST NOT be turned
// into one, into a chain source label, into coverage or into a finality attestation; a consumer may show the reasons.
//
// So this module:
//   - reads the page's shape and copies every held reason as given (none dropped, merged or renamed);
//   - admits nothing: every observation is returned as held, whatever the page says. A page that claims a world, a
//     finality, completeness or another basis is not believed either: that is one more reason, never fewer;
//   - makes no fact, calls no ingest, builds no Receipt, no `kind|subject` id, no coverage and no attestation;
//   - keeps `credited` as given (4 fixes it to null). A non-null credited is a reason, never a quantity;
//   - takes the slot as the transaction's (4: "never a timestamp"); arrival time is not read.
// The locator shown is 4's diagnostic `local_locator` and the triple signature|ps2_ordinal|body_sha256. Neither is a
// chain event id (4: the ordinal numbers the program's extracted PS2 bodies, not an instruction or log position, and
// a signature is not unique in the index), so nothing here dedupes or matches by it.
export const WS04_OBSERVATION_FORMAT = 'ws04-observation/0';
/** 4's per-observation held reasons at 7baa4d93; a page that lacks one is reported, and still held. */
export const WS04_OBSERVATION_HELD = Object.freeze(['world_binding_unproven', 'finality_unproven', 'transaction_record_identity_unproven', 'committed_frame_unproven']);
/** 4's page held reasons at 7baa4d93. */
export const WS04_PAGE_HELD = Object.freeze(['not_executor_receipts', 'source_provenance_unproven', 'resume_cursor_not_admitted']);
const KINDS = new Set(['caravan_settled', 'caravan_raided']);
const MAX_SHOWN = 256;   // 4's MAX_ROWS
const nat = x => Number.isSafeInteger(x) && x >= 0;
const strs = a => (Array.isArray(a) && a.every(x => typeof x === 'string') ? [...a] : null);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const optStr = x => x === null || typeof x === 'string';

// (2026-11-17) Store mode (runexec `observe store`, observation.rs `read_store_observations`): each row may carry
// `archive_epoch` {epoch, why, pairing} and the page `store` (the pairing facts). Carried as given when well formed,
// as diagnostics only: an epoch is the archive's producer setting (program as configured, commitment as requested),
// the pairing is one directory named by the caller (not proof of one archive, not one snapshot). Neither is evidence,
// neither lifts a hold, and a page without them is reported exactly as before.
const EPOCH_WHY = new Set(['covered_by_epoch', 'before_first_epoch', 'past_manifest_end', 'manifest_changed_during_read']);
const PAIRING = 'same_directory_not_proof_of_same_archive';
const GENERATIONS = new Set(['index_matches_manifest', 'index_ahead_of_manifest', 'index_behind_manifest', 'manifest_changed_during_read']);
const MALFORMED_EPOCH = Object.freeze({ epoch: null, why: 'archive_epoch_malformed', pairing: PAIRING });

/** A row's archive epoch as given, or null when it is not one runexec writes (then nothing is guessed). */
function epochOf(x, archiveSequence) {
  if (!obj(x) || !EPOCH_WHY.has(x.why) || x.pairing !== PAIRING) return null;
  if (x.epoch === null) return x.why === 'covered_by_epoch' ? null : { epoch: null, why: x.why, pairing: PAIRING };
  const e = x.epoch;
  if (x.why !== 'covered_by_epoch' || !obj(e) || !nat(e.from_seq) || e.from_seq < 1 || typeof e.source !== 'string' ||
      !optStr(e.program_configured) || !optStr(e.commitment_requested) ||
      // a covering epoch needs the row's own sequence: an unsafe one (reported _malformed) cannot be placed in a range
      !nat(archiveSequence) || e.from_seq > archiveSequence) return null;
  return { epoch: { from_seq: e.from_seq, source: e.source.slice(0, 60), program_configured: e.program_configured, commitment_requested: e.commitment_requested }, why: x.why, pairing: PAIRING };
}

/** The page's pairing facts as given; a number that is not a safe integer is null and named in `unsafe`. */
function storeOf(s) {
  if (!obj(s) || s.same_directory !== true || typeof s.manifest_stable !== 'boolean' || !GENERATIONS.has(s.generation) || !strs(s.limits)) return null;
  const unsafe = [];
  const n = k => (nat(s[k]) ? s[k] : (unsafe.push(k), null));
  return { same_directory: true, index_last_seq: n('index_last_seq'), manifest_next_seq_before: n('manifest_next_seq_before'),
    manifest_next_seq_after: n('manifest_next_seq_after'), manifest_stable: s.manifest_stable, generation: s.generation, limits: [...s.limits], unsafe };
}

/**
 * A `ws04-observation/0` page -> a held report: {format, admitted: 0, status: 'held', pageHeld, why, observations}.
 * `why` collects this module's own findings (malformed fields, missing reasons, claims not believed); 4's reasons are
 * kept apart, verbatim, in `pageHeld` and in each observation's `held`.
 */
export function heldFromWs04Observation(page) {
  const why = [];
  if (!page || typeof page !== 'object' || Array.isArray(page)) return Object.freeze({ format: null, admitted: 0, status: 'held', pageHeld: [], why: ['ws04_observation_not_an_object'], observations: [] });
  if (page.format !== WS04_OBSERVATION_FORMAT) why.push(`ws04_observation_format:${String(page.format).slice(0, 40)}`);
  if (page.basis !== 'unproven') why.push(`ws04_observation_basis_${String(page.basis).slice(0, 20)}_not_admitted`);
  for (const k of ['world', 'finality', 'complete']) if (page[k] !== null && page[k] !== undefined) why.push(`ws04_observation_claims_${k}_not_admitted`);
  const pageHeld = strs(page.held);
  if (!pageHeld) why.push('ws04_observation_page_held_malformed');
  else for (const r of WS04_PAGE_HELD) if (!pageHeld.includes(r)) why.push(`ws04_observation_page_held_missing:${r}`);
  if (!Array.isArray(page.observations)) why.push('ws04_observation_list_malformed');
  const list = Array.isArray(page.observations) ? page.observations : [];
  if (list.length > MAX_SHOWN) why.push(`ws04_observation_page_over_${MAX_SHOWN}`);
  const storeMode = page.store !== undefined;
  const store = storeMode ? storeOf(page.store) : undefined;
  if (storeMode && !store) why.push('ws04_observation_store_malformed');
  let epochRows = 0;
  const observations = list.slice(0, MAX_SHOWN).map((o, i) => {
    const own = [];
    if (!o || typeof o !== 'object') return { index: i, kind: null, held: [], why: ['observation_not_an_object'] };
    const held = strs(o.held);
    if (!held) own.push('held_malformed');
    else for (const r of WS04_OBSERVATION_HELD) if (!held.includes(r)) own.push(`held_missing:${r}`);
    const kind = o.event?.kind;
    if (!KINDS.has(kind)) own.push(`event_kind:${String(kind).slice(0, 30)}`);
    for (const k of ['event_cursor', 'archive_sequence', 'ps2_ordinal', 'transaction_slot']) if (!nat(o[k])) own.push(`${k}_malformed`);
    if (typeof o.signature !== 'string' || !o.signature || o.signature.length > 128) own.push('signature_malformed');
    if (typeof o.body_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.body_sha256)) own.push('body_sha256_malformed');
    const v = o.event?.value;
    if (kind === 'caravan_settled' && v && v.credited !== null && v.credited !== undefined) own.push('credited_present_not_admitted');
    if (v && nat(v.slot) && nat(o.transaction_slot) && v.slot !== o.transaction_slot) own.push('event_slot_not_the_transaction_slot');
    let epoch;
    if (o.archive_epoch !== undefined) {
      epochRows++;
      epoch = epochOf(o.archive_epoch, o.archive_sequence);
      if (!epoch) { own.push('archive_epoch_malformed'); epoch = MALFORMED_EPOCH; }
    }
    return {
      index: i, kind: KINDS.has(kind) ? kind : null,
      locator: typeof o.local_locator === 'string' ? o.local_locator.slice(0, 80) : null,
      // only safe integers go into the text: an ordinal past 2^53 would be shown rounded (it is reported _malformed)
      triple: typeof o.signature === 'string' && nat(o.ps2_ordinal) ? `${o.signature.slice(0, 128)}|${o.ps2_ordinal}|${o.body_sha256}` : null,
      transaction_slot: nat(o.transaction_slot) ? o.transaction_slot : null,
      held: held ?? [],
      why: own,
      ...(epoch ? { archive_epoch: epoch } : {}),
    };
  });
  // a page that carries rows' epochs without its pairing facts, or the facts without epochs on its rows, is not what
  // the store reader writes
  if (storeMode !== (epochRows > 0) && list.length > 0) why.push('ws04_observation_store_mode_inconsistent');
  return Object.freeze({ format: page.format ?? null, admitted: 0, status: 'held', pageHeld: pageHeld ?? [], why, observations, ...(storeMode ? { store } : {}) });
}
