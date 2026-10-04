// Wave-A wiring between units that were built in parallel (integrator, slice gate; contract 11.3, 11.6).
//
//   feedView(feed, pump)           the feed shape AC1a's mind reads (cursorBell, revealed) over AC6a's real feed
//   createWaveAWatcher({feed})     the "stub that returns feed wakes only" of 11.6, until AC6's watcher is merged
//   createEpisodePump({...})       feeds the real feed through episodes_from_events into the AC2 stores
//
// Nothing here decides anything about play: it moves public facts from the feed into the stores and the wake list.
// Every number a wake carries is a count from a public record.

const DEFAULT_LOOKBACK_BELLS = 40; // the producer reads rows up to ref + 14 bells; episodes older than this were created already

/**
 * The feed shape the mind reads. `cursorBell()` is the highest bell whose records are complete in the feed AND
 * folded into the stores (the pump), so a session is refused (`feed_lag`) when memory is behind the chain.
 * `revealed(entry)` says whether the target of a sealed march is public (its REVEAL is in the log).
 */
export function feedView(feed, pump = null) {
  if (!feed) return null;
  return {
    cursorBell() {
      const through = feed.completeThrough();
      if (through < 0) return -1;
      const done = pump ? pump.throughBell() : through;
      return Math.min(through, done);
    },
    /**
     * The bots step within seconds of a bell's start, before the chain's block time has crossed the boundary and before
     * the herald has indexed it, so the feed cannot yet vouch for bell - 1. Pull the feed and fold the pump now (single
     * flight, cheap) until it can, for at most `maxMs`. Returns whether the cursor reached `minBell`.
     */
    async waitCursor(minBell, maxMs) {
      const t0 = Date.now();
      for (;;) {
        if (this.cursorBell() >= minBell) return true;
        if (Date.now() - t0 >= maxMs) return false;
        await feed.poll();
        if (pump?.tick) await pump.tick();
        if (this.cursorBell() >= minBell) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    revealed(e) {
      if (e?.host_id != null && e?.arrive_bell != null && feed.revealOf(String(e.host_id), e.arrive_bell)) return true;
      // the release waits for a REVEAL at most 6 bells (7.2): after that the sealed entry no longer protects a public fact
      return e?.arrive_bell != null && feed.headBell() > e.arrive_bell + 7;
    },
  };
}

/**
 * The wave-A watcher: the feed's own wakes (W-CLASH, W-THREAT of 3.2) and nothing else. Each wake is delivered once,
 * at the first decision whose bell is at or after the bell it was logged in, so a late poll cannot lose it and a
 * repeated poll cannot count it twice. A W-THREAT wake carries `facts` ({nation, mass, origin, arrive_bell}), the
 * shape the prompt's THREATS lines read.
 */
export function createWaveAWatcher({ feed, lookback = 8 }) {
  const delivered = new Map(); // tag -> Set of "code:seq" already handed to a decision
  const last = new Map(); // tag -> {bell, list}: the answer given for the last bell asked
  return {
    stub: true,
    kind: 'wave-a-feed-wakes',
    wakeEvents(tag, bell) {
      if (!feed) return [];
      const prev = last.get(tag);
      if (prev && prev.bell === bell) return prev.list; // a repeated (tag, bell) answers the same
      if (prev && bell < prev.bell) return []; // an older bell is never asked again
      let seen = delivered.get(tag);
      if (!seen) delivered.set(tag, (seen = new Set()));
      // a record logged in bell b arrives after the bots stepped at the start of b: it is delivered at b + 1 at the latest,
      // so the window reaches back `lookback` bells and each wake is handed over once
      const list = [];
      for (let b = Math.max(0, bell - lookback); b <= bell; b++) {
        for (const w of feed.wakeEvents(tag, b)) {
          const key = `${w.code}:${w.seq}`;
          if (seen.has(key)) continue;
          seen.add(key);
          list.push(w.code === 'W-THREAT' ? { ...w, facts: { nation: w.nation, mass: w.dep_mass, origin: w.origin, arrive_bell: w.arrive_bell } } : w);
        }
      }
      last.set(tag, { bell, list });
      return list;
    },
    start() {},
    stop() {},
  };
}

/**
 * Fold the feed into the AI's stores. Idempotent: a tick re-reads the last `lookback` bells and the stores
 * deduplicate by episode id and by delta id (AC2). It runs only when the feed's complete-through bell moved.
 *   views.ownState(tag, bell) creates the ledger with the persona's goals (the same call the mind makes)
 */
export function createEpisodePump({ feed, stores, views, roster, clock, config = {}, lookback = DEFAULT_LOOKBACK_BELLS, onError = () => {} }) {
  let doneThrough = -1;
  let running = null;
  const stats = { ticks: 0, runs: 0, episodes_added: 0, ai_runs: 0, unknown: {}, collisions: 0, errors: 0, last_error: null, last_ms: null };
  const publishedTags = new Set();

  async function run(through) {
    const t0 = Date.now();
    const bellNow = through + 1;
    const owners = feed.owners;
    if (!owners) return;
    const events = [];
    for (let b = Math.max(0, through - lookback); b <= through; b++) events.push(...feed.events(b));
    // PRE_GENESIS rows (bell 0xffffffff) never enter `events(b)` windows; the producer reads only bell-keyed rows
    const prepared = await feed.prepare(events);
    for (const entry of roster.ai) {
      const tag = entry.tag;
      const home = owners.homeOf(tag);
      if (!home) continue; // no village yet: nothing of its own to remember
      const ai = {
        tag, wallet: entry.wallet, faction: owners.factionOfTag(tag) ?? entry.faction ?? null,
        home: { p: home.p, q: home.q }, holdings: owners.holdingsOf(tag).map((h) => ({ p: h.p, q: h.q, site: h.site })),
      };
      views.ownState(tag, through); // creates the ledger with the persona's goals
      const ctx = {
        ai, bellNow, owners, province: prepared.province, clash: prepared.clash, clashDetail: prepared.clashDetail,
        config: { genesis_ts: clock?.genesis?.() ?? null, ...config },
      };
      try {
        const before = stores.episodes(tag).size;
        const res = stores.ingest(tag, { events }, ctx, { cursor: { event_seq: feed.cursor(), bell: through } });
        stats.ai_runs++;
        stats.episodes_added += stores.episodes(tag).size - before;
        for (const u of res.unknown ?? []) stats.unknown[u.what] = (stats.unknown[u.what] ?? 0) + 1;
        stats.collisions += res.collisions?.length ?? 0;
        stores.save(tag);
        if (stores.publish(tag)) publishedTags.add(tag);
      } catch (e) {
        stats.errors++;
        stats.last_error = String(e?.stack ?? e).slice(0, 600);
        onError(e);
      }
    }
    stats.last_ms = Date.now() - t0;
  }

  const api = {
    stats,
    published: () => [...publishedTags],
    throughBell: () => doneThrough,
    /** One pass; skipped when the feed has not moved. Never throws. */
    async tick() {
      stats.ticks++;
      if (running) return running;
      if (!feed || !roster?.ready) return null;
      const through = feed.completeThrough();
      if (through < 0 || through <= doneThrough) return null;
      running = (async () => {
        try {
          stats.runs++;
          await run(through);
          doneThrough = through;
        } catch (e) {
          stats.errors++;
          stats.last_error = String(e?.stack ?? e).slice(0, 600);
          onError(e);
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
  return api;
}
