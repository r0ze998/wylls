// AC6: who is in which nation, from public records (the owners index of AC6a) and the roster. Used by the council job (the nation's
// holdings, who may vote, which humans are present) and by the Strike Order (which wallet is which citizen).
//
//   createCensus({feed, roster}) -> {start(), holdingsOfNation(f), hasFinalHolding(tag), tagOfWallet(w), walletOfTag(tag),
//                                    voters(f) -> {eligible: [wallet]|null, humans: [wallet]}, tagsOfNation(f)}
//
// A citizen is known from its SETTLE rows (the owners index resolves its nation from its JOIN) and from the roster (AI and seat).
// Rule bots never vote (section 6.5 step 2): their wallets are excluded from `eligible`.
import * as b58 from '../../../permutation-server/web/sdk/base58.mjs';

export function createCensus({ feed, roster }) {
  const tags = new Set();
  let started = false;
  const owners = () => feed?.owners ?? null;

  function ingest(events) {
    for (const ev of events ?? []) {
      if (ev.kind !== 'SETTLE') continue;
      if (ev.citizen) tags.add(ev.citizen);
      if (ev.displaced) tags.add(ev.displaced);
    }
  }
  const rosterTags = () => [...roster.ai.map(a => a.tag), ...(roster.seat?.tag ? [roster.seat.tag] : [])];

  const api = {
    start() {
      if (started) return;
      started = true;
      try { ingest(feed?.batchSince?.('0')?.events); } catch { /* the feed is not up yet */ }
      feed?.subscribe?.(({ events }) => ingest(events));
    },
    /** tags of the citizens of nation f that hold or held a village, plus the AI and the seat of that nation */
    tagsOfNation(f) {
      const o = owners();
      const out = new Set();
      for (const t of [...tags, ...rosterTags()]) {
        const fac = o?.factionOfTag?.(t) ?? roster.byTag?.(t)?.faction ?? (roster.seat?.tag === t ? roster.seat.faction : null);
        if (fac === f) out.add(t);
      }
      return [...out].sort();
    },
    /** one entry per village the nation holds: [{p, q, site, tag, final}] */
    holdingsOfNation(f) {
      const o = owners();
      if (!o) return [];
      const out = [];
      for (const t of api.tagsOfNation(f)) for (const h of o.holdingsOf(t)) out.push({ p: h.p, q: h.q, site: h.site, tag: t, final: Boolean(h.final) });
      return out;
    },
    hasFinalHolding(tag) {
      return Boolean(owners()?.holdingsOf?.(tag)?.some(h => h.final));
    },
    walletOfTag(tag) {
      return roster.byTag?.(tag)?.wallet ?? (roster.seat?.tag === tag ? roster.seat.wallet : null) ?? owners()?.walletOf?.(tag) ?? null;
    },
    tagOfWallet(w) {
      const a = roster.byWallet?.(w);
      if (a) return a.tag;
      if (roster.seat?.wallet === w) return roster.seat.tag ?? null;
      for (const t of tags) if (owners()?.walletOf?.(t) === w) return t;
      return null;
    },
    /**
     * The voters of nation f at C0: wallets of its citizens with a final holding, rule bots excluded, and the non-AI ones among them
     * (the seat and any human) for the human-present rule. `eligible` is null when no wallet could be resolved (AC4 then asks the herald).
     */
    voters(f) {
      const eligible = [];
      const humans = [];
      for (const t of api.tagsOfNation(f)) {
        if (!api.hasFinalHolding(t)) continue;
        const w = api.walletOfTag(t);
        if (!w) continue;
        let wb;
        try { wb = b58.decode(w); } catch { continue; }
        if (wb.length !== 32) continue;
        if (roster.isScript?.(w)) continue;
        eligible.push(w);
        if (!roster.byWallet?.(w)) humans.push(w);
      }
      return { eligible: eligible.length ? eligible.sort() : null, humans: humans.sort() };
    },
  };
  return api;
}
