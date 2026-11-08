// Workstream 12 <- workstream 4: memory facts from the run executor's Receipts (read on
// origin/integration/ws09-13-v16-d0949fd4, workstreams/04-execution/src/{store,executor,ports,model}.rs).
//
//   Receipt  {run_id, kind, subject, source, slot, body}            store.rs: "evidence of something that happened"
//     caravan_sent     subject cv:<owner hex>:<seq>, source sig:<sig>, body {seq, cargo[8], content_from}
//                      (the destination is the run's spec `ship.dst`: 4 checked the record against it)
//     caravan_settled  subject cv:..., source event:<id> | history:<id>, body Settle {key, outcome, dst, cargo[8],
//                      credited[8]|null (proposal P1), slot}
//     caravan_raided   subject cv:..., body Raid {key, choice, raider, taken[8], slot}
//     facility_used    not a memory input (no caravan, no counterparty)
//
// Rules this adapter holds to:
// - IDENTITY: one chain event can reach 4 twice (the feed's `event:` and the entity history's `history:`; 4's own
//   QUANTITY-CONTRACT §7 dedupes by kind|subject). The fact id is therefore kind|subject in the world's partition,
//   and the fact body leaves out what depends on the read path (`content_from`, `source`, `run_id`): the same event
//   is a duplicate; a different body under the same kind|subject is a collision (kept apart, first wins).
// - FINALITY: a receipt is turned into a fact only when its slot is at or below the finalized slot the caller
//   attests; otherwise it is held (`not_finalized`) and offered again later. Receipts carry no finality of their own.
// - TIME: slot -> world bell through the caller's clock (ws08-world.mjs `clockFromGenesis`); unknown -> held.
// - u64: owner and raider tags are u64 in the JSON; parse with `parseJsonU64` (no rounding above 2^53). The caravan
//   owner is taken from the subject's hex, which is exact by construction.
// - NOTHING IS INFERRED: no coverage ("not sent"), no owner interval, no lookup failure is synthesised from what the
//   receipts lack; a feed gap proves nothing (4 and 19: findex absence is not evidence of absence). Identity aliases
//   come only from the caller's resolver (4/8), with its source.
import { RESOURCES, fact as checkFact } from '../src/records.mjs';

const U64_KEYS = new Set(['owner', 'raider']);

/** JSON.parse that keeps u64 fields `owner` and `raider` exact (as decimal strings). Node 22's reviver source text. */
export function parseJsonU64(text) {
  return JSON.parse(text, (k, v, ctx) => (U64_KEYS.has(k) && typeof v === 'number' && ctx?.source ? ctx.source : v));
}

/** A u64 (decimal string, bigint or safe number) as the 16 lowercase hex digits the memory uses for chain tags. */
export function tagHexOf(u) {
  let b;
  if (typeof u === 'bigint') b = u;
  else if (typeof u === 'string' && /^\d{1,20}$/.test(u)) b = BigInt(u);
  else if (typeof u === 'number' && Number.isSafeInteger(u) && u >= 0) b = BigInt(u);
  else throw new TypeError(`not an exact u64: ${String(u).slice(0, 30)} (parse the receipt with parseJsonU64)`);
  if (b < 0n || b >= 2n ** 64n) throw new TypeError('u64 out of range');
  return b.toString(16).padStart(16, '0');
}

/** `cv:<owner hex>:<seq>` (model.rs CaravanKey::text) -> {ownerHex16, seq}. */
export function parseSubject(subject) {
  const m = /^cv:([0-9a-f]{1,16}):(\d{1,10})$/.exec(subject ?? '');
  if (!m) return null;
  const seq = Number(m[2]);
  return seq < 2 ** 32 ? { ownerHex: m[1].padStart(16, '0'), seq } : null;
}

const res = arr => {
  if (!Array.isArray(arr) || arr.length !== RESOURCES.length) throw new TypeError('Res is [u64; 8]');
  const out = {};
  arr.forEach((v, i) => { if (!Number.isSafeInteger(v) || v < 0) throw new TypeError('Res entry'); if (v > 0) out[RESOURCES[i]] = v; });
  return out;
};
const place = (p, partition) => ({ partition, kind: p.kind, p: p.p, q: p.q, at: p.at, gen: p.gen });

/**
 * One receipt -> {facts: [args for memory.observe], held: null | {why}}.
 * @param ctx {partition, observedBell, bellOfSlot(slot) -> bell|null, finalizedSlot, runSpecs: {run_id: RunSpec},
 *            resolveOwner(ownerHex16) -> {principal, source} | null}
 */
export function receiptToFacts(r, ctx) {
  const held = why => ({ facts: [], held: { receipt: `${r?.run_id}|${r?.kind}|${r?.subject}|${r?.source}`, why } });
  if (!r || typeof r.kind !== 'string' || typeof r.subject !== 'string' || (!Number.isSafeInteger(r.slot) || r.slot < 0)) return held('malformed');
  if (r.kind === 'facility_used') return held('not_a_memory_input');
  if (!['caravan_sent', 'caravan_settled', 'caravan_raided'].includes(r.kind)) return held(`unknown_kind:${r.kind}`);
  if (!Number.isSafeInteger(ctx.finalizedSlot) || ctx.finalizedSlot < 0 || r.slot > ctx.finalizedSlot) return held('not_finalized');
  const bell = ctx.bellOfSlot(r.slot);
  if (!Number.isSafeInteger(bell) || bell < 0) return held('clock_unmapped');
  if (!Number.isSafeInteger(ctx.observedBell) || ctx.observedBell < 0) return held('observed_clock_invalid');
  if (bell > ctx.observedBell) return held('observed_before_occurred');
  const key = parseSubject(r.subject);
  if (!key) return held('malformed_subject');
  // Settle/Raid repeat the caravan identity and slot inside the body. Do not
  // let a stale/corrupt envelope relabel another caravan or make an unfinalized
  // event appear finalized. Check before resolving aliases or emitting facts.
  if (r.kind !== 'caravan_sent') {
    try {
      const b = r.body;
      if (tagHexOf(b?.key?.owner) !== key.ownerHex ||
          !Number.isSafeInteger(b?.key?.seq) || b.key.seq !== key.seq) return held('body_key_mismatch');
      if (!Number.isSafeInteger(b.slot) || b.slot !== r.slot) return held('body_slot_mismatch');
    } catch (e) { return held(`malformed_body:${e.message}`.slice(0, 80)); }
  }
  const P = ctx.partition;
  const caravan = { partition: P, sender: key.ownerHex, seq: key.seq };
  const src = kind => ({ chain: P, sig: `${kind}|${r.subject}`, ix: 0 });
  // ctx.basis / ctx.aliasBasis: the caller's statement of where the store / the identity pairing were read (fact basis)
  const base = { bell, created_bell: ctx.observedBell, visibility: { scope: 'public' }, ...(ctx.basis ? { basis: ctx.basis } : {}) };
  const facts = [];
  const alias = ctx.resolveOwner?.(key.ownerHex) ?? null;
  if (alias && typeof alias.principal === 'string' && typeof alias.source === 'string') {
    // The mapping does not depend on this receipt: in the continuous world the citizen address (hence the tag) is
    // derived from the world account and the wallet, fixed from the world's start. Its bell is therefore 0, not the
    // receipt's: otherwise every receipt would restate the same mapping with another body (a false collision).
    facts.push({ kind: 'identity_alias', bell: 0, created_bell: ctx.observedBell, visibility: { scope: 'public' }, ...(ctx.aliasBasis ? { basis: ctx.aliasBasis } : {}),
      source: { chain: 'resolver', sig: `${P}|${key.ownerHex}|${alias.principal}`, ix: 0 },
      data: { partition: P, tag: key.ownerHex, principal: alias.principal } });
  }
  try {
    if (r.kind === 'caravan_sent') {
      const spec = ctx.runSpecs?.[r.run_id];
      if (!spec?.ship?.dst) return held('dst_unknown'); // the receipt has no destination; only the run's spec has it
      if (!Number.isSafeInteger(r.body?.seq) || r.body.seq !== key.seq) return held('seq_mismatch');
      facts.push({ kind: 'caravan_sent', ...base, source: src('caravan_sent'), data: { caravan, dst: place(spec.ship.dst, P), cargo: res(r.body.cargo) } });
    } else if (r.kind === 'caravan_settled') {
      const b = r.body;
      facts.push({ kind: 'caravan_settled', ...base, source: src('caravan_settled'),
        data: { caravan, outcome: b.outcome, dst: place(b.dst, P), cargo_recorded: res(b.cargo) } });
      // P1 (not applied in the program today): the settle record states what the destination kept
      if (Array.isArray(b.credited)) {
        facts.push({ kind: 'caravan_credited', ...base, source: src('caravan_credited'),
          data: { caravan, place: place(b.dst, P), credited: res(b.credited), unit: 'whole_units', basis: 'exec_record', exec: { sig: `settle|${r.subject}`, ix: 0 } } });
      }
    } else {
      const b = r.body;
      facts.push({ kind: 'caravan_raided', ...base, source: src('caravan_raided'), data: { caravan, raider: tagHexOf(b.raider), taken: res(b.taken) } });
    }
  } catch (e) { return held(`malformed_body:${e.message}`.slice(0, 80)); }
  return { facts, held: null };
}

/**
 * Feed receipts into a memory. Idempotent: run it again over the same or a larger set (after a restart, or when the
 * finalized slot advances) and only what is new is added. Returns counts and what was held (to offer again).
 */
export function ingestReceipts(memory, receipts, ctx) {
  const out = { added: 0, duplicate: 0, collision: 0, refused: 0, held: [] };
  for (const r of receipts) {
    const { facts, held } = receiptToFacts(r, ctx);
    if (held) { out.held.push(held); continue; }
    // all of a receipt's facts are checked before any is appended: one that the memory's record rules refuse holds
    // the whole receipt (with the reason) instead of leaving part of it written and stopping the rest of the feed
    try { for (const f of facts) checkFact(f); } catch (e) {
      out.held.push({ receipt: `${r?.run_id}|${r?.kind}|${r?.subject}|${r?.source}`, why: `malformed_fact:${e.message}`.slice(0, 80) });
      continue;
    }
    for (const f of facts) {
      const res2 = memory.observe(f);
      out[res2.status === 'added' ? 'added' : res2.status === 'duplicate' ? 'duplicate' : res2.status === 'collision' ? 'collision' : 'refused']++;
    }
  }
  return out;
}
