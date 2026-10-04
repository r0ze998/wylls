// Episode store and the per-AI memory store (contract §5, §5.2, §5.6).
//
//   Episodes     the AI's episode list: add (dedupe by id), the 200 cap with importance-aware
//                eviction, canonical form and hash (M11), retrieve(focus, bellNow)
//   createMemoryStore({stateDir, pubDir}) -> {ledger(tag), episodes(tag), summary, ingest, ownState, publish}
//
// STATE/ledger/<tag>.json, STATE/episodes/<tag>.jsonl, STATE/summary/<tag>/<bell>.txt are private to the
// citizens service; PUB/memory/<tag>/episodes.json (and summary.json) are published live.
//
// Eviction (§5.2): over the cap, drop the lowest-importance episode, then the oldest (bell, then id).
// "never an importance >= 5 episode or the source of an open grievance while a lower-importance episode
// exists" holds by construction: every grievance source is an attacked_own episode (importance 8), the
// highest, so the (importance, bell, id) order drops it last. The replay applies the same function.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EPISODE_CAP, canonical, sha256hex } from './config.mjs';
import { compareEpisodes, episodes_from_events } from './episodes.mjs';
import { retrieve } from './retrieve.mjs';
import { Ledger } from './ledger.mjs';
import { createSummaryStore, summaryFile } from './summary.mjs';
import { tagHex } from '../persona/names.mjs';

const writeAtomic = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
};

/** The blanked form of an episode whose source record was redacted (§6.3): id, bell, kind and created_bell stay. */
export const redactedForm = ep => ({ v: ep.v, id: ep.id, bell: ep.bell, created_bell: ep.created_bell, kind: ep.kind, importance: ep.importance, entities: [], text: { en: '', ja: '' }, src: [], facts: {}, redacted: true });

export class Episodes {
  constructor(list = [], { cap = EPISODE_CAP } = {}) {
    this.cap = cap;
    this.byId = new Map();
    this.add(list);
  }
  static load(path, opts) {
    if (!existsSync(path)) return new Episodes([], opts);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return new Episodes(lines.map(l => JSON.parse(l)), opts);
  }
  save(path) { writeAtomic(path, this.list().map(e => canonical(e)).join('\n') + (this.byId.size ? '\n' : '')); }

  /** Add one episode or a list. Returns the number of NEW episodes kept. */
  add(eps) {
    let n = 0;
    for (const e of Array.isArray(eps) ? eps : [eps]) {
      if (!e || this.byId.has(e.id)) continue;
      this.byId.set(e.id, e);
      n++;
    }
    this._evict();
    return n;
  }
  _evict() {
    while (this.byId.size > this.cap) {
      let worst = null;
      for (const e of this.byId.values()) {
        if (!worst || e.importance < worst.importance || (e.importance === worst.importance && (e.bell < worst.bell || (e.bell === worst.bell && e.id < worst.id)))) worst = e;
      }
      this.byId.delete(worst.id);
    }
  }
  get size() { return this.byId.size; }
  get(id) { return this.byId.get(id) ?? null; }
  /** The canonical order: created_bell, bell, id. */
  list() { return [...this.byId.values()].sort(compareEpisodes); }
  /** Blank an episode whose source record was redacted (§6.3). */
  redact(id) { const e = this.byId.get(id); if (e && !e.redacted) this.byId.set(id, redactedForm(e)); }
  canonical() { return canonical(this.list()); }
  sha256() { return sha256hex(this.canonical()); }
  /** `retrieve(focus, bellNow) -> ids` (§5.2); pass the ledger's grievances for the exemption of their sources. */
  retrieve(focus, bellNow, { grievances = [] } = {}) { return retrieve(this.list(), focus, bellNow, { grievances }); }
}

/** The published file (PUB/memory/<tag>/episodes.json). */
export const episodesFile = (tag, eps) => ({ v: 1, tag: tagHex(tag), count: eps.size, sha256: eps.sha256(), episodes: eps.list() });

export function createMemoryStore({ stateDir, pubDir = null } = {}) {
  const ledgers = new Map(), episodeSets = new Map();
  const ledgerPath = tag => join(stateDir, 'ledger', `${tagHex(tag)}.json`);
  const episodePath = tag => join(stateDir, 'episodes', `${tagHex(tag)}.jsonl`);
  const summaries = createSummaryStore({ stateDir });
  const published = new Map(); // tag -> last published episodes sha

  const store = {
    summary: summaries,
    /** The ledger of an AI; created from `init` ({goals, bell}) when none exists. */
    ledger(tag, init) {
      const t = tagHex(tag);
      if (!ledgers.has(t)) ledgers.set(t, existsSync(ledgerPath(t)) ? Ledger.load(ledgerPath(t)) : Ledger.create({ tag: t, ...(init ?? {}) }));
      return ledgers.get(t);
    },
    episodes(tag) {
      const t = tagHex(tag);
      if (!episodeSets.has(t)) episodeSets.set(t, Episodes.load(episodePath(t)));
      return episodeSets.get(t);
    },
    /**
     * Run the producer for one AI and fold the result into its stores: episodes (deduped), ledger deltas
     * (idempotent) and the cursor. Returns the producer's result.
     */
    ingest(tag, batch, ctx, { cursor } = {}) {
      const eps = store.episodes(tag), led = store.ledger(tag);
      // the open grievances come from the ledger: an own march that reaches the wrongdoer answers them (code-set, §5.1)
      const openGrievances = led.grievances({ open: true }).map(g => ({ id: g.id, against: g.against, nation: g.nation, bell: g.bell }));
      const res = episodes_from_events(batch, { ...ctx, ai: { ...ctx.ai, tag }, config: { ...(ctx.config ?? {}), openGrievances: [...openGrievances, ...(ctx.config?.openGrievances ?? [])] } });
      eps.add(res.episodes);
      led.applyAll(res.deltas.filter(d => d.kind === 'grievance')); // a grievance before the `answered` delta that names it
      led.applyAll(res.deltas.filter(d => d.kind !== 'grievance'));
      if (cursor) led.setCursor(cursor);
      return res;
    },
    /** What the renderers take (§5.6): the AI's own ledger, episodes and summary only. */
    ownState(tag, extra = {}) {
      const t = tagHex(tag);
      return { tag: t, ledger: store.ledger(t).snapshot(), episodes: store.episodes(t), summary: summaries.latest(t), ...extra };
    },
    save(tag) { const t = tagHex(tag); store.ledger(t).save(ledgerPath(t)); store.episodes(t).save(episodePath(t)); },
    /** Publish PUB/memory/<tag>/episodes.json (and summary.json); skipped when unchanged. Returns true when written. */
    publish(tag) {
      if (!pubDir) return false;
      const t = tagHex(tag), eps = store.episodes(t), sum = summaries.latest(t);
      const body = episodesFile(t, eps);
      const stamp = `${body.sha256}|${sum?.sha256 ?? ''}`;
      if (published.get(t) === stamp) return false;
      writeAtomic(join(pubDir, 'memory', t, 'episodes.json'), `${JSON.stringify(body)}\n`);
      if (sum) writeAtomic(join(pubDir, 'memory', t, 'summary.json'), `${JSON.stringify(summaryFile(t, sum))}\n`);
      published.set(t, stamp);
      return true;
    },
  };
  return store;
}
