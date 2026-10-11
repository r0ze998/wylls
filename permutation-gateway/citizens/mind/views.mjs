// The three views a prompt may be rendered from (contract section 5.6, 11.6):
//   publicView()     the same data /f/ai/* serves and /h/* shows: roster, council options and motions (never
//                    ballot counts), nation-channel and direct messages, the feed cursor
//   ownState(tag)    this AI's ledger, episodes, summary, standing orders and sealed set. Keyed by tag; no other
//                    AI's state is reachable from it
//   memberView(f)    the sealed Call of the AI's own nation only
// Nothing else reaches a prompt: no other AI's ownState, no unopened ballot, no client IP, no social-store
// internals. This file is the only place where those objects are assembled, so T-K4 can be tested on it.
//
// Assumed shapes of the other units (listed in AC1a-NOTES.md; tests use doubles with exactly these):
//   social.read.council(f)           -> {period, state, options:[{option,kind,p,q,ratio}], motions:[{wallet,tag?,name?,option}], closes_bell, adopted, strike_bell, call_commit}
//   social.read.inbox(wallet)        -> [{id, bell, wallet, tag, name, faction?, channel:'direct'|'nation'|3|1, text, inner}] addressed to the wallet or its nation
//   social.read.hall(f, limit)       -> the same rows, nation channel of nation f
//   social.memberCall(f, period)     -> {option, kind, p, q, tile, strike_bell, follow_from, invited, nonce}|null
//   feed.cursorBell()                -> the highest bell whose records the feed has fully processed (feed_lag when < bell - 1)
//   stores.ledger(tag) / stores.episodes(tag) / stores.summary.latest(tag) / stores.save(tag)   (AC2's createMemoryStore; Ledger.s is the section 5.1 document)
//   personaOf(rosterEntry) -> persona with goals (AC2 persona/deal.mjs)
const FACTION_OF = (rosterEntry) => rosterEntry?.faction ?? null;
export const ledgerDoc = (l) => (typeof l?.snapshot === 'function' ? l.snapshot() : JSON.parse(JSON.stringify(l?.s ?? l?.data ?? l ?? {})));
/** The mutable section 5.1 document behind a ledger object (AC2's Ledger keeps it in .s). */
export const ledgerState = (l) => l?.s ?? l?.data ?? l;

export function createRoster(rosterJson) {
  const ai = rosterJson?.ai ?? [];
  const byTag = new Map(ai.map((a) => [a.tag, a]));
  const byWallet = new Map(ai.map((a) => [a.wallet, a]));
  const scriptWallets = new Set(rosterJson?.script?.wallets ?? []);
  return {
    ready: ai.length > 0,
    ai,
    byTag: (t) => byTag.get(t) ?? null,
    byWallet: (w) => byWallet.get(w) ?? null,
    byIndex: (i) => ai.find((a) => a.index === i) ?? null,
    isAi: (tag) => byTag.has(tag),
    isScript: (wallet) => scriptWallets.has(wallet),
    seat: rosterJson?.seat ?? null,
  };
}

export function createViews({ social, feed = null, stores, roster, nameOf = null, clock = null, sealed = null, councilFor = null, personaOf = null } = {}) {
  if (!stores) throw new Error('createViews: stores required');
  const read = social?.read ?? {};

  function publicView() {
    return {
      bell: () => clock?.bell?.() ?? null,
      roster,
      council: (f) => (councilFor ? councilFor(f) : read.council?.(f) ?? null),
      inboxRows: (wallet) => read.inbox?.(wallet) ?? [],
      hallRows: (f, limit = 5) => read.hall?.(f, limit) ?? [],
      feedCursorBell: () => feed?.cursorBell?.() ?? null,
      nameOf: (tag) => nameOf?.(tag) ?? null,
    };
  }

  /** Everything private to one AI. The caller passes the tag of the AI it is deciding for; there is no way to list others. */
  function ownState(tag, bell = 0) {
    const entry = roster.byTag(tag);
    const persona = entry ? (personaOf ? personaOf(entry) : { id: entry.persona, ambition: entry.ambition, creed_variant: entry.creed_variant, temperament: entry.temperament }) : null;
    const ledger = stores.ledger(tag, { goals: persona?.goals ?? [], bell });
    return {
      tag,
      index: entry?.index ?? null,
      wallet: entry?.wallet ?? null,
      faction: FACTION_OF(entry),
      persona,
      name: entry?.name ?? null,
      ledger, // the AC2 Ledger object (the mind mutates counters, day_start, seq, standing through it)
      doc: ledgerDoc(ledger), // a snapshot of the section 5.1 document (what the renderers read)
      episodes: stores.episodes(tag),
      summary: typeof stores.summary === 'function' ? stores.summary(tag) : stores.summary?.latest?.(tag) ?? null,
      sealed: sealed?.list(tag) ?? [],
    };
  }

  /** The sealed Call of the AI's own nation, or null. Never another nation's. */
  function memberView(f) {
    const council = read.council?.(f) ?? null;
    if (!council || !council.adopted || council.period == null) return { call: null };
    const call = social?.memberCall?.(f, council.period) ?? null;
    return { call: call ? { ...call, period: council.period } : null };
  }

  return { publicView, ownState, memberView };
}
