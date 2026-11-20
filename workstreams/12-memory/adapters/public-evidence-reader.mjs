// Workstream 12: an OPTIONAL public-evidence reader for an external AI resident (⑤ option B). (2026-11-20)
//
// Q12-1, option A (recommended in reports/plan-6-9-10-12-16.md §4.3): 12's evidence is NOT wired into the operator
// residents (⑤ A stays a fixed, explainable rule, owner decision) and not into any game rule. It is offered to an
// external resident as something it may ASK for: `createPublicEvidenceReader(...)` makes no request; only
// `advise({about})` reads, once per call, and only public records. An agent that never calls it is unaffected.
//
// What one `advise` reads (adapters/live-observation.mjs observeLive, unchanged): the herald's /h/season, /h/events
// (paged, at most `recall.eventPages` pages) and /h/me/{wallet} for the wallets asked about; optionally one RPC
// getSlot(finalized) when the caller declares the RPC <-> cluster pairing; optionally workstream 4's store, read-only.
// Nothing is written (the memory lives in this call only), nothing is signed or sent, no key is made or used.
// Without a finalized slot and a store bound to this world, every receipt is held with its reason and the answer
// says so: no record is never read as "did not do it".
//
// What it answers, per wallet asked about: whether the herald pairs the wallet with a citizen of this world; the
// public facts about that citizen's caravans (sent, settled delivered/lost, raided as sender or as raider, credited),
// counted and the most recent few with their sources and basis; and, only when the caller hands in ITS OWN memory
// (`own: {memory, viewer}`, e.g. the promises it made or heard and its own notes), the lines and reliability that
// memory holds about that wallet. It is evidence, never a decision: no score is turned into an order here, and the
// caution term of 12's reference policy is not an honesty judgement (advise.mjs CAUTION).
//
// Bounded recall (Q12-2, option A): the caps below bound what the agent READS (counterparties per call, facts and
// lines per counterparty, characters per line, herald pages per call). They are not a storage cap: 12's journal
// (when an agent keeps one) is never trimmed here, and this reader keeps nothing between calls.
import { observeLive } from './live-observation.mjs';
import { identityFromHeraldMe, resolverFromIdentity, worldFromSeason } from './canonical.mjs';
import { memoryLines } from '../src/view.mjs';
import { reliabilityOf } from '../src/fold.mjs';

export const READER_KIND = 'wylls.memory12.public-evidence-reader/v1';
/** Recall caps (what one answer may hold). A caller may lower them, or raise them up to RECALL_MAX, never past it. */
export const RECALL_DEFAULT = Object.freeze({ counterparties: 4, factsPerCounterparty: 6, linesPerCounterparty: 6, textChars: 200, eventPages: 16, reasons: 12 });
export const RECALL_MAX = Object.freeze({ counterparties: 16, factsPerCounterparty: 32, linesPerCounterparty: 24, textChars: 280, eventPages: 64, reasons: 32 });
const PUBLIC_VIEWER = Object.freeze({ tag: null, nation: null });
const CARAVAN_KINDS = Object.freeze(['caravan_sent', 'caravan_settled', 'caravan_raided', 'caravan_credited']);
export const NOTE = 'Public evidence only, with its sources; not a decision and not an honesty judgement. Held or missing records are unknown, never "did not".';

/** The caps actually used: integers in [0, RECALL_MAX], defaults where not given. */
export function recallCaps(asked = {}) {
  const out = {};
  for (const [k, d] of Object.entries(RECALL_DEFAULT)) {
    const v = asked?.[k];
    out[k] = Number.isSafeInteger(v) && v >= 0 ? Math.min(v, RECALL_MAX[k]) : d;
  }
  return Object.freeze(out);
}

const refuseRpc = async () => { throw new Error('this reader was given no RPC'); };
const noStore = () => { throw new Error('not given'); };
const cut = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

/**
 * `heraldUrl`: the world's public herald (for a local-play external resident, its own world proxy). Optional:
 * `rpcUrl` + `rpcBinding` {rpcUrl, cluster, source} (finality), `storePath` + `binding` (4's store and the operator's
 * declaration of its world), `kinds` (the caller's statement of each source's kind; capped by observeLive).
 * `io`: {getJson(url) -> {ok, status, body}, rpc?, readStore?} — this module makes no request itself.
 */
export function createPublicEvidenceReader({ heraldUrl, rpcUrl = null, rpcBinding = null, storePath = null, binding = null, kinds = {}, io, recall = {} } = {}) {
  if (typeof io?.getJson !== 'function') throw new TypeError('io.getJson is required (this reader makes no request itself)');
  const caps = recallCaps(recall);
  let calls = 0;
  return Object.freeze({
    kind: READER_KIND,
    recall: caps,
    get calls() { return calls; },
    /**
     * One read-only answer about `about` (wallet addresses). `own` (optional): {memory, viewer} — the caller's own
     * 12 memory and who it is in it; its lines about each wallet are added, bounded the same way.
     */
    async advise({ about = [], own = null } = {}) {
      calls += 1;
      const asked = [...new Set((Array.isArray(about) ? about : [about]).map(String))];
      const wallets = asked.slice(0, caps.counterparties);
      // The herald's own answers to this call's reads are kept (no second request) so the wallet <-> citizen pairing
      // is known even when observeLive holds every receipt before pairing (no finality, no store).
      const seen = { season: null, me: [] };
      const getJson = async url => {
        const r = await io.getJson(url);
        const path = new URL(url).pathname;
        if (r?.ok === true && path.endsWith('/h/season')) seen.season = r.body;
        if (r?.ok === true && /\/h\/me\/[^/]+$/.test(path)) seen.me.push(r.body);
        return r;
      };
      const ioUsed = { getJson, rpc: typeof io.rpc === 'function' ? io.rpc : refuseRpc, readStore: storePath ? io.readStore : noStore };
      const o0 = await observeLive({ heraldUrl, rpcUrl: rpcUrl ?? '', storePath, binding, rpcBinding, wallets, kinds, maxEventPages: caps.eventPages, io: ioUsed });
      const reasons = o0.reasons.map(r => (r === 'rpc_url_malformed' && !rpcUrl ? 'rpc_not_given' : r === 'ws04_store_unreadable:not given' && !storePath ? 'ws04_store_not_given' : r));
      const o = { ...o0, reasons, identity: o0.identity ?? pairing(seen) };
      const k = o.memory ? o.memory.knowledge(PUBLIC_VIEWER, o.observedBell ?? 0, { observedBy: o.observedBell ?? 0 }) : null;
      const ownK = own?.memory && Number.isSafeInteger(o.observedBell) ? own.memory.knowledge(own.viewer, o.observedBell, { observedBy: o.observedBell }) : null;
      const refusedMe = new Map((o.inputs?.meRefused ?? []).map(r => [r.wallet, r.why]));
      const answers = wallets.map(wallet => answerFor(wallet, { o, k, ownK, caps, refusedMe }));
      return Object.freeze({
        kind: READER_KIND, readOnly: true, note: NOTE,
        status: o.status, reasons: o.reasons.slice(0, caps.reasons), reasonsDropped: Math.max(0, o.reasons.length - caps.reasons),
        world: o.world, observedBell: o.observedBell, provenance: o.provenance,
        held: o.held.length, ingest: o.ingest ?? null,
        about: answers,
        recall: { caps, asked: asked.length, answered: answers.length, droppedCounterparties: asked.slice(caps.counterparties) },
      });
    },
  });
}

function pairing(seen) {
  let partition;
  try { partition = worldFromSeason(seen.season).partition; } catch { return null; }
  return resolverFromIdentity(seen.me.map(m => identityFromHeraldMe(m, { partition }).entry).filter(Boolean));
}

function answerFor(wallet, { o, k, ownK, caps, refusedMe }) {
  const base = { wallet, status: null, citizen: null, facts: null, own: null };
  if (!o.world) return { ...base, status: 'world_unverified' };
  const known = o.identity?.walletKnown?.(wallet) ?? null;
  const out = { ...base, status: known ? 'ok' : 'identity_unverified', ...(refusedMe.has(wallet) ? { why: refusedMe.get(wallet) } : {}) };
  if (known) {
    out.citizen = { tag: known.tag, partition: known.partition, source: known.source };
    const mine = f => f.data?.caravan?.partition === known.partition && f.data.caravan.sender === known.tag;
    const raider = f => f.kind === 'caravan_raided' && f.data?.raider === known.tag && f.data?.caravan?.partition === known.partition;
    if (o.status !== 'ok') {
      // nothing about its caravans was taken in (see the answer's reasons): unknown, not zero
      out.facts = { held: true, counts: null, recent: [], truncated: false, epistemic: 'unknown' };
      return withOwn(out, wallet, ownK, caps);
    }
    const rows = (k?.facts ?? []).filter(f => CARAVAN_KINDS.includes(f.kind) && (mine(f) || raider(f)));
    const counts = { sent: 0, settled_delivered: 0, settled_lost: 0, raided_as_sender: 0, raided_as_raider: 0, credited: 0 };
    for (const f of rows) {
      if (f.kind === 'caravan_sent') counts.sent++;
      else if (f.kind === 'caravan_settled') counts[f.data.outcome === 1 ? 'settled_lost' : 'settled_delivered']++;
      else if (f.kind === 'caravan_raided') counts[raider(f) ? 'raided_as_raider' : 'raided_as_sender']++;
      else if (f.kind === 'caravan_credited') counts.credited++;
    }
    const recent = [...rows].sort((a, b) => b.bell - a.bell || (a.id < b.id ? -1 : 1)).slice(0, caps.factsPerCounterparty)
      .map(f => ({ kind: f.kind, bell: f.bell, caravan: `${f.data.caravan.sender}#${f.data.caravan.seq}`, ...(f.kind === 'caravan_raided' ? { as: raider(f) ? 'raider' : 'sender' } : {}),
        basis: f.basis ?? null, source: f.source ? { ...f.source } : null }));
    out.facts = { held: false, counts, recent, truncated: rows.length > recent.length, epistemic: 'verified as stated by its basis' };
  }
  return withOwn(out, wallet, ownK, caps);
}

function withOwn(out, wallet, ownK, caps) {
  if (ownK) {
    const lines = memoryLines(ownK, [wallet]);
    const rel = reliabilityOf(ownK, wallet);
    out.own = {
      lines: lines.slice(0, caps.linesPerCounterparty).map(l => ({ epistemic: l.epistemic, text: cut(l.text, caps.textChars), sources: l.sources.slice(0, 8) })),
      truncated: lines.length > caps.linesPerCounterparty,
      reliability: { E: rel.E, verified: { ...rel.verified }, unresolved: rel.unresolved.length, neutral: rel.neutral.length, claims: { ...rel.claims } },
    };
  }
  return out;
}
