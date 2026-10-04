// Wave-A wiring between units that were built in parallel (integrator, slice gate; contract 11.3, 11.6).
//
//   feedView(feed, pump)           the feed shape AC1a's mind reads (cursorBell, revealed) over AC6a's real feed
//   createWaveAWatcher({feed})     the "stub that returns feed wakes only" of 11.6. Since AC6 (wave B) the service builds the real watcher
//                                  (watcher/index.mjs) and uses this only as the fallback when there is no feed (and AC6's watcher
//                                  reuses it for the feed's own wakes, W-CLASH and W-THREAT)
//   createEpisodePump({...})       feeds the real feed through episodes_from_events into the AC2 stores
//
//   socialReadViews({book,..})     the `social.read` shape AC1a's views read (sync), over AC4's real social store
//   socialClock(clock)             the {bell(), unix()} clock AC4's store reads, over the mind's game clock
//   provenanceOf(records)          AC1a's records as the {provenance, consume} AC4's book asks (consume tries both types)
//
// Nothing here decides anything about play: it moves public facts from the feed into the stores and the wake list.
// Every number a wake carries is a count from a public record.

import { statSync } from 'node:fs';
import { toTroops } from '../memory/herald-view.mjs';

// A DEPART can precede its REVEAL by up to 72 bells (AC2-NOTES, rule 1) and the producer reads rows up to ref + 14 bells: the
// window keeps 72 + 8. (The first wiring used 40, which lost a march whose REVEAL came later than that.)
const DEFAULT_LOOKBACK_BELLS = 80;
const BELL_SECS = 600;

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
 * shape the prompt's THREATS lines read. `mass` is WHOLE troops: the wake's `dep_mass` (and `home_troops_est`) are the chain's
 * milli-troops (a departure of 300 troops is 300000), the same number the threat episode says (`toTroops`).
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
          list.push(w.code === 'W-THREAT' ? { ...w, facts: { nation: w.nation, mass: toTroops(w.dep_mass), origin: w.origin, arrive_bell: w.arrive_bell } } : w);
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
 * Fold the feed into the AI's stores. `social` (optional, `socialEpisodeSource` below) adds the social store's accepted talk
 * rows (dm and motion episodes, the "adopted mover" trust delta) and its closed council files (council_result and strike
 * episodes), and the operator's redactions (a redacted record's episode is blanked, section 6.3). Without it those kinds
 * are not produced. Idempotent: a tick re-reads the last `lookback` bells and the stores
 * deduplicate by episode id and by delta id (AC2). It runs only when the feed's complete-through bell moved.
 *   views.ownState(tag, bell) creates the ledger with the persona's goals (the same call the mind makes)
 */
export function createEpisodePump({ feed, stores, views, roster, clock, config = {}, social = null, lookback = DEFAULT_LOOKBACK_BELLS, onError = () => {} }) {
  let doneThrough = -1;
  let running = null;
  const stats = { ticks: 0, runs: 0, episodes_added: 0, ai_runs: 0, unknown: {}, collisions: 0, errors: 0, last_error: null, last_ms: null, missing_recent: 0, redacted: 0, talk_rows: 0, councils: 0 };
  const publishedTags = new Set();

  async function run(through) {
    const t0 = Date.now();
    const bellNow = through + 1;
    const owners = feed.owners;
    if (!owners) return;
    const events = [];
    for (let b = Math.max(0, through - lookback); b <= through; b++) events.push(...feed.events(b));
    // A BUILD becomes the episode `build_done` at the bell of its `done_at`, which can be far after the row's own bell (builds
    // queue serially, 3600 + 1800 n secs each: the capture has 32 bells). So BUILD rows are taken from the whole log, not
    // from the window, while their done bell is still within the window or ahead: a live run and a full replay then agree (M11).
    const genesis = clock?.genesis?.() ?? null;
    const have = new Set(events.filter((r) => r.kind === 'BUILD').map((r) => String(r.seq)));
    for (let b = 0; b < Math.max(0, through - lookback); b++) {
      for (const r of feed.events(b)) {
        if (r.kind !== 'BUILD' || have.has(String(r.seq))) continue;
        const doneBell = genesis != null && r.done_at != null ? Math.floor((Number(r.done_at) - genesis) / BELL_SECS) : Infinity;
        if (doneBell >= through - lookback) {
          have.add(String(r.seq));
          events.push(r);
        }
      }
    }
    // PRE_GENESIS rows (bell 0xffffffff) never enter `events(b)` windows; the producer reads only bell-keyed rows
    const prepared = await feed.prepare(events);
    // a province or clash file the herald served late would give an episode a created_bell below bells already decided:
    // counted here (not held back: a file that never comes would stall every AI), so the live run shows how often it happens
    stats.missing_recent = (prepared.missing ?? []).filter((k) => {
      const b = Number(String(k).split(',').pop());
      return Number.isFinite(b) && b <= through - 3 && b >= through - 12;
    }).length;
    const talk = social?.talk?.() ?? [];
    const redactions = social?.redactions?.() ?? [];
    stats.talk_rows = talk.length;
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
        config: { genesis_ts: clock?.genesis?.() ?? null, ...config, redactions: [...(config.redactions ?? []), ...redactions] },
      };
      const councils = social?.councils?.(ai.faction) ?? [];
      stats.councils = Math.max(stats.councils, councils.length);
      try {
        const before = stores.episodes(tag).size;
        const res = stores.ingest(tag, { events, talk, council: councils }, ctx, { cursor: { event_seq: feed.cursor(), bell: through } });
        // an episode made from a redacted record is produced blanked, but its id is already stored: blank the stored one
        for (const ep of res.episodes ?? []) {
          if (ep.redacted && stores.episodes(tag).byId.get(ep.id)?.redacted !== true) {
            stores.episodes(tag).redact(ep.id);
            stats.redacted++;
          }
        }
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

// ------------------------------------------------------------------ AC4's social store as AC1a's views read it

/**
 * AC1a's `views.mjs` read `social.read.{council, inbox, hall}` synchronously (the shapes of its header comment); AC4's
 * store offers `book.list` (sync), `book.inbox` (async) and `council.publicState` (sync). This adapter keeps an
 * incremental row cache over `book.list` and drops it when `pub/redactions.json` changes (a redacted message must not
 * stay in a prompt). Rows are AC4's `messageView`s: `channel` is numeric (0 world, 1 nation, 3 direct) and `target` is the
 * nation number (nation) or the recipient's base58 wallet (direct); the prompt reads 3 as direct. What this returns is
 * what `/f/ai/*` serves anyway: no ballot, no sealed Call, no client address.
 */
/** AC4's `book.list` rows, cached incrementally; the cache is dropped when `pub/redactions.json` changes (a redacted text must not stay). */
export function socialRowCache({ book, pubDir = null, statFn = statSync }) {
  let rows = [];
  let cursor = 0;
  let tomb = null;
  return {
    /** every accepted row in order, refreshed; the cache is dropped when `pub/redactions.json` changes */
    rows() {
      let m = null;
      if (pubDir) {
        try {
          m = statFn(`${pubDir}/redactions.json`).mtimeMs;
        } catch {
          m = null;
        }
      }
      if (m !== tomb) {
        tomb = m;
        rows = [];
        cursor = 0;
      }
      for (let guard = 0; guard < 1000; guard++) {
        const r = book.list({ after: cursor, limit: 200 });
        if (!r.messages.length) break;
        rows.push(...r.messages);
        cursor = r.next;
        if (r.messages.length < 200) break;
      }
      return rows;
    },
  };
}

// socialReadViews: the AC1a views over the same cache (see the comment above socialRowCache)
export function socialReadViews({ book, council, pubDir = null, roster = null, statFn = statSync }) {
  const cache = socialRowCache({ book, pubDir, statFn });
  const rowsNow = () => cache.rows();
  const factionOf = (wallet) => roster?.byWallet?.(wallet)?.faction ?? null;
  return {
    /** the nation's latest council period, public fields only (never the ballots or the split) */
    council(f) {
      const s = council.publicState(f);
      if (!s || s.period == null) return null;
      const { ballots, tally_split, ...pub } = s;
      return pub;
    },
    /** rows addressed to the wallet: direct messages to it and the nation channel of its own nation */
    inbox(wallet) {
      const f = factionOf(wallet);
      return rowsNow().filter((r) => (r.channel === 3 && r.target === wallet) || (r.channel === 1 && f != null && r.target === f));
    },
    /** the nation channel of nation f, oldest first, last `limit` */
    hall(f, limit = 5) {
      return rowsNow().filter((r) => r.channel === 1 && r.target === f).slice(-limit);
    },
  };
}

/**
 * AC4's council file (`GET /f/ai/council`, `PUB/council/<k>-<f>.json`: `closes_bell`, `candidates[{option,kind,..}]`, `adopted`,
 * `strike_bell`, `open`) as the episodes producer reads it (`close_bell`, `options[{option,kind}]`, `adopted`, `strike_bell`,
 * `open{p,q,option}`). Only a CLOSED period is handed over (`tally_split` is set at the close): an open period's `adopted: false`
 * is not a result yet.
 */
export function councilFileForEpisodes(f) {
  if (!f || (f.tally_split == null && f.adopted !== true)) return null;
  const open = f.open && f.open.p !== undefined && f.open.q !== undefined ? { p: f.open.p, q: f.open.q, tile: f.open.tile, option: f.open.option } : undefined;
  return {
    faction: f.faction,
    period: f.period,
    close_bell: f.closes_bell,
    adopted: f.adopted === true,
    ...(f.strike_bell != null ? { strike_bell: f.strike_bell } : {}),
    ...(open ? { open } : {}),
    options: (f.candidates ?? []).map((o) => ({ option: o.option, kind: o.kind })),
  };
}

/**
 * What the episode pump reads from AC4's store: every accepted talk row (the producer reads sender tag, bell, channel, target,
 * kind and ref, never the text), the nation's closed council periods, and the inner ids of redacted records.
 */
export function socialEpisodeSource({ book, council, pubDir = null, statFn = statSync }) {
  const cache = socialRowCache({ book, pubDir, statFn });
  return {
    talk: () => cache.rows(),
    redactions: () => cache.rows().filter((r) => r.redacted).map((r) => r.inner),
    councils(faction) {
      const latest = council?.latest?.(faction);
      if (!latest) return [];
      const out = [];
      for (let k = 0; k <= latest.period; k++) {
        const e = councilFileForEpisodes(council.publicOf(faction, k));
        if (e) out.push(e);
      }
      return out;
    },
  };
}

/** The clock AC4's store reads: the game bell and chain time in seconds (the mind's game clock, wall time before its anchor). */
export function socialClock(clock, nowMs = Date.now) {
  return { bell: () => clock.bell(), unix: () => clock.gameNow?.() ?? nowMs() / 1000 };
}

/** AC1a's records as AC4's book asks for them: `provenance(id, item, type)` and `consume(id, item, type)` (talk and ballot items alike; without a type it tries both). */
export function provenanceOf(records) {
  return {
    provenance: (id, item, type) => records.provenance(id, item, type),
    consume: (id, item, type) => (type ? records.consume(id, item, type) : records.consume(id, item, 'talk') || records.consume(id, item, 'ballot')),
  };
}
