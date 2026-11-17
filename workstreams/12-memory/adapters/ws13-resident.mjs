// Workstream 12 <-> workstream 13: the residents' memory, connected without changing their behaviour.
//
// What 13 has (read on origin/integration/ws09-13-v16-d0949fd4, workstreams/13-citizens/resident/ports/memory.mjs and
// resident.mjs): a MemoryPort {append(episode) -> boolean (false: id already kept), recall({focus, bell}) -> episodes,
// all() -> episodes}, one per resident, owned by that resident only. The resident writes episodes from the MOCK
// board and world it plays in (kinds kept, broken, declined, unanswered, delivered, raided, failed, refused-by-me,
// returned, joined, built; counterparties named by WALLET address) and derives its trust from them (trustOf:
// kept/returned +1, broken -2). The harness hands the port in as `resident.ports.memory`.
//
// INPUT 13 -> 12 (this module): `mirrorMemoryPort(inner, memory12, {owner})` returns a MemoryPort that answers exactly
// what `inner` answers (same append result, same recall, same all; the resident sees no difference) and, for each
// episode `inner` newly keeps, appends to workstream 12 a NOTE of the resident: owner-private, epistemic
// "interpreted", never evidence. So 13's `broken`, `failed`, `raided`, `returned` (late or not) stay the resident's
// reading of a mock board: they do not become verified failures, deliveries or reputation in 12. How a late return
// or a raided return is to be judged is not decided; nothing here judges it.
//   - idempotent: a note's id is a hash of its content, so a restart, a replay (`reconcile()`), or an episode the
//     inner port refuses as a duplicate never adds a second note;
//   - nothing else flows from 13: decisions, ActionResults (`sent`, `unknown`, fate `pending`) and board messages are
//     not memory inputs. A resident's action becomes a fact in 12 only through workstream 4's finalized receipts
//     (ws04-receipts.mjs);
//   - a mirror failure is counted and never changes what the resident gets back.
// OUTPUT 12 -> 13: none into the resident's port. The read path is the integrator's public-evidence sidecar
// (13-citizens/resident/ports/ws12-public-evidence.mjs): public records only, with an explicit principal resolver.
// The notes written here are private to their owner and never reach that sidecar or any other resident.
// No private data moves with a wallet or an NFT: transfer of private memory is undecided and not implemented.
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The counterparty an episode is about: its single wallet-address entity other than the owner, else null. */
export function counterpartyOf(ep, owner) {
  const others = [...new Set((ep.entities ?? []).filter(e => typeof e === 'string' && ADDRESS.test(e) && e !== owner))];
  return others.length === 1 ? others[0] : null;
}

/** The note a 13 episode becomes (args for memory12.note). */
export function noteOfEpisode(ep, owner) {
  return {
    owner, bell: ep.bell, about: counterpartyOf(ep, owner), by: 'code', basis: [],
    text: `[ws13 ${ep.kind}] ${ep.text?.en ?? ''} (ws13 episode ${ep.id}; mock board; not evidence)`,
  };
}

export function mirrorMemoryPort(inner, memory12, { owner }) {
  for (const m of ['append', 'recall', 'all']) if (typeof inner?.[m] !== 'function') throw new TypeError(`inner MemoryPort lacks ${m}()`);
  if (!ADDRESS.test(owner ?? '')) throw new TypeError('owner is the resident\'s wallet address');
  const stats = { mirrored: 0, duplicate: 0, errors: 0 };
  const mirror = ep => {
    try {
      const r = memory12.note(noteOfEpisode(ep, owner));
      if (r.status === 'added') stats.mirrored++; else stats.duplicate++;
    } catch { stats.errors++; }
  };
  return {
    kind: `${inner.kind ?? 'memory'}+ws12-mirror`,
    append(ep) {
      const fresh = inner.append(ep);
      if (fresh) mirror(inner.all().find(e => e.id === ep.id) ?? ep);
      return fresh;
    },
    recall(q) { return inner.recall(q); },
    all() { return inner.all(); },
    /** Mirror every episode the inner port holds (after a restart, or to catch up); duplicates are no-ops. */
    reconcile() { for (const ep of inner.all()) mirror(ep); return { ...stats }; },
    stats: () => ({ ...stats }),
  };
}
