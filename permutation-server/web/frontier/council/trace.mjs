// One decision followed from top to bottom (the "Follow this decision" view): four steps, each read from public files.
//   1 the public event(s) that match the decision's wake reason   /h/events (the herald's log: seq, turn, transaction signature,
//                                                                  and who holds the village that issued the army), the roster
//   2 the memory lines shown to the model                          the record's `retrieved` + /h/ai/memory/<tag>/episodes.json
//   3 what was chosen                                              the decision record and its opened record (decisions.mjs)
//   4 the result                                                   the record's `tx`, the opened destination, the clash rows of
//                                                                  events/latest.json and the AI's own later episodes
//
// What the view may and may not say:
//   - The record names the wake reason (W-THREAT, W-CLASH), not the event. Step 1 lists the public events that became this
//     AI's episodes of that kind since its previous decision with the same wake (the watcher hands each wake over once,
//     looking back 8 bells), and says so. When the herald rows of the decision's own transactions have been read, an
//     event logged AFTER them is left out (it cannot have been handed to a decision that had already acted) and is
//     listed under the AI's next decision instead. It is a match of records, never a statement of why the AI chose.
//   - An episode line is tied to an event only by the episode's own `src` (`event:<seq>`).
//   - "cited" is the model naming a line that was shown to it. A line that was shown and not named is printed as
//     "shown, not cited". Nothing here says the choice rested on a line.
//   - Whose army it was comes from the herald's public log, the way the citizens service itself derives it (watcher/owners.mjs):
//     a host id carries (province, site, generation) (faddr.mjs `hostParts`), and the log's HOME_PLACED, OUTPOST_SETTLED,
//     SETTLE and CAPTURE_SETTLED rows name the holder of that site and generation. The page reads the log from its start up to
//     the event (lazily, a few pages per poll). events/latest.json keeps recent rows only and is used only as a shortcut.
//     While the log is being read the view says "being read", never "not found".
//   - What kind of actor that is comes from the roster only: an AI citizen, a script bot or the presenter seat when the roster lists the tag;
//     "person (player)" only when the tag is in none of those lists AND the script bot list could be checked; else it says
//     that it could not be checked. Nothing is guessed from a flag in a file.
//   - An autopilot step is printed as an autopilot step in every step; it never carries model words.
//   - "no result yet" until a clash row or an own episode exists for the march; the view never says that no clash happened
//     (the files it reads carry real clashes only, so their absence proves nothing).
//
// Pure builders (`buildTrace`, `startedByPeople`, `normalizeHerald`, …) and the render function; no network here.
import { actorEl, int, lineEl, placeText, tplNodes } from './parts.mjs';
import { tagKey } from './badges.mjs';
import { buildDecision, candidateLabel, candidateList, EVENT_WAKES } from './decisions.mjs';
import { clashFacts } from './events.mjs';
import { nationName } from './lang.mjs';

const str = v => (typeof v === 'string' ? v : '');
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);
const arr = v => (Array.isArray(v) ? v : []);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const SIG = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/; // a transaction signature (base58)
const MILLI = 1000; // the chain counts milli-troops

/** The watcher's look-back for a wake (citizens/mind/wiring.mjs `lookback`). */
export const WAKE_LOOKBACK = 8;
/** Which episode kinds a wake code leaves in the AI's memory (citizens/memory/episodes.mjs). */
const WAKE_EPISODES = Object.freeze({
  'W-THREAT': k => k === 'threat',
  'W-CLASH': k => /^(attacked_own|clash_own_|camp_cleared_own)/.test(k),
});
const RESULT_KIND = /^(clash_own_|camp_cleared_own|attacked_own)/;

// ------------------------------------------------------------------ the herald's event log
const tagOfDecimal = v => (/^\d{1,20}$/.test(str(v)) && v !== '0' ? BigInt.asUintN(64, BigInt(v)).toString(16).padStart(16, '0') : null);
const OWN_KINDS = ['HOME_PLACED', 'OUTPOST_SETTLED', 'SETTLE', 'CAPTURE_SETTLED'];

/**
 * A page of `/h/events?after=<seq>` → rows `{seq, bell, name, sig, hostId, troops, from, arrive, depart, at, clashBell,
 * engagements, own}` (only what the trace prints). `own` is `{p, q, site, gen, tag}` on a row that names the holder of a
 * village site (tag null: the site has no holder from here on).
 */
export function normalizeHerald(file) {
  const out = [];
  for (const e of arr(file?.events)) {
    const seq = num(e?.seq);
    const d = obj(e?.decoded);
    if (seq === null || !Number.isInteger(seq) || seq < 0) continue;
    const k = obj(d.key), p = obj(d.payload);
    const name = /^[A-Z_]{1,24}$/.test(str(d.name)) ? d.name : '';
    const row = { seq, bell: num(e.bell) ?? num(d.bell), name, sig: SIG.test(str(e.sig)) ? e.sig : '', hostId: '', troops: null, from: null, arrive: null, depart: null, at: null, clashBell: null, engagements: null, own: null };
    if (name === 'DEPART') {
      row.hostId = str(k.host_id);
      row.troops = num(p.dep_mass) !== null ? Math.floor(num(p.dep_mass) / MILLI) : null;
      row.from = num(p.origin_p) !== null && num(p.origin_q) !== null ? { p: num(p.origin_p), q: num(p.origin_q) } : null;
      row.arrive = num(p.arrive_bell);
      row.depart = num(p.depart_bell);
    } else if (name === 'CLASH') {
      row.at = num(k.p) !== null && num(k.q) !== null ? { p: num(k.p), q: num(k.q) } : null;
      row.clashBell = num(k.bell);
      row.engagements = num(p.engagements);
    } else if (num(k.p) !== null && num(k.q) !== null) row.at = { p: num(k.p), q: num(k.q) };
    if (name === 'REVEAL') { row.hostId = str(p.host_id); row.arrive = num(k.arrive); }
    if (OWN_KINDS.includes(name) && row.at && num(k.site) !== null) {
      // SETTLE names a new holder only when it is fresh (0) or displaces (1); a capture names the captor and the new generation
      const settles = name !== 'SETTLE' || num(p.outcome) === 0 || num(p.outcome) === 1;
      const gen = num(name === 'CAPTURE_SETTLED' ? p.new_gen : p.gen);
      if (settles && gen !== null) row.own = { p: row.at.p, q: row.at.q, site: num(k.site), gen, tag: tagOfDecimal(name === 'CAPTURE_SETTLED' ? p.captor_tag : p.citizen_tag) };
    }
    out.push(row);
  }
  return out;
}

/**
 * What the page has read of the herald's log: `rows` Map(seq → row), `sites` Map("p,q,site" → [{gen, tag, seq}]) (who held a
 * village site, in log order), `reveals` Map("p,q,turn" → [host id]) (the armies that arrived there), and `scanned`: every
 * row up to this number has been read (the log is read from its start, page after page).
 */
export const makeLog = () => ({ rows: new Map(), sites: new Map(), reveals: new Map(), scanned: 0 });

/**
 * Add one page of `/h/events?after=<after>` to the log. A page asked with `after === log.scanned` moves the scan forward to
 * its last row. Returns the number of new rows.
 */
export function ingestLog(log, file, after = null) {
  let n = 0, last = null;
  for (const r of normalizeHerald(file)) {
    last = last === null ? r.seq : Math.max(last, r.seq);
    if (log.rows.has(r.seq)) continue;
    log.rows.set(r.seq, r);
    n++;
    if (r.own) {
      const key = `${r.own.p},${r.own.q},${r.own.site}`;
      const list = log.sites.get(key) ?? log.sites.set(key, []).get(key);
      list.push({ gen: r.own.gen, tag: r.own.tag, seq: r.seq });
      list.sort((a, b) => a.seq - b.seq);
    }
    if (r.name === 'REVEAL' && r.hostId && r.at && r.arrive !== null) {
      const key = `${r.at.p},${r.at.q},${r.arrive}`;
      const list = log.reveals.get(key) ?? log.reveals.set(key, []).get(key);
      if (!list.includes(r.hostId)) list.push(r.hostId);
    }
  }
  if (after !== null && after === log.scanned && last !== null) log.scanned = last;
  return n;
}

/**
 * Whose army a host id was at event `seq`: `{state: 'known', tag}`, `{state: 'loading'}` (the log has not been read that
 * far, or the host-id reader is still loading) or `{state: 'unknown'}` (read that far, and no holder is named).
 * `hostParts` is faddr.mjs `hostParts` (null while it loads, false when it could not be loaded).
 */
export function hostOwner(log, hostParts, hostId, seq) {
  if (hostParts === false || !hostId) return { state: 'unknown', tag: null };
  if (!hostParts) return { state: 'loading', tag: null };
  let h = null;
  try { h = hostParts(hostId); } catch { h = null; }
  if (!h) return { state: 'unknown', tag: null };
  const e = (log.sites.get(`${h.p},${h.q},${h.site}`) ?? []).findLast(x => x.gen === h.gen && x.seq < seq);
  if (e) return e.tag ? { state: 'known', tag: e.tag } : { state: 'unknown', tag: null };
  return { state: log.scanned >= seq ? 'unknown' : 'loading', tag: null };
}

// ------------------------------------------------------------------ who acted
/** True when every script bot of the roster can be recognised by tag (the page derived a tag for each listed wallet). */
export const scriptListKnown = index => index.scriptCount === 0 || index.scriptTagCount >= index.scriptCount;

/**
 * The type of an actor `{tag?, wallet?}`: 'ai' | 'script' | 'seat' (the roster lists it), 'person' (in none of the lists,
 * and the script list could be checked), 'unlisted' (not an AI, not the seat; the script list could not be checked),
 * 'unknown' (no identifier at all).
 */
export function actorType(index, who = {}) {
  const id = index.identify(who);
  if (id.kind) return id.kind;
  const tag = tagKey(who.tag);
  if (!tag && !str(who.wallet)) return 'unknown';
  return str(who.wallet) || scriptListKnown(index) ? 'person' : 'unlisted';
}
const typed = (index, a) => ({ tag: a.tag ?? null, wallet: a.wallet ?? '', faction: a.faction ?? null, type: actorType(index, a), fate: a.fate ?? null, after: a.after ?? null });
const isPerson = a => a.type === 'person' || a.type === 'seat';

// ------------------------------------------------------------------ step 1: the events behind the wake
const sameAt = (a, p, q) => !!a && a.p === p && a.q === q;

/** Map(transaction signature → the lowest event number the herald logged for it). */
export function sigSeqIndex(herald) {
  const m = new Map();
  for (const r of herald.values()) if (r.sig && !(m.get(r.sig) <= r.seq)) m.set(r.sig, r.seq);
  return m;
}
/** The first event number of a record's own transactions, or null when none of them has been read from the herald. */
const ownSeq = (tx, sigSeq) => { const s = tx.map(x => sigSeq.get(x.sig)).filter(n => n !== undefined); return s.length ? Math.min(...s) : null; };

/** The episodes of the AI that match the decision's event wakes, and the bell window they were looked for in. */
function wakeEpisodes({ d, tx, minds, episodes, sigSeq }) {
  const hits = new Map();
  let from = null;
  const mine = ownSeq(tx, sigSeq);
  const firstSeq = e => (e.seqs.length ? Math.min(...e.seqs) : null);
  for (const code of EVENT_WAKES) {
    if (!d.wake.includes(code)) continue;
    const before = minds.filter(r => r.tag === d.tag && r.bell < d.bell && r.id !== d.id && r.wake.includes(code));
    const prev = Math.max(-1, ...before.map(r => r.bell));
    const lo = Math.max(prev, d.bell - WAKE_LOOKBACK - 1);
    const all = [...episodes.values()].filter(e => WAKE_EPISODES[code](e.kind) && e.created !== null);
    // not an event logged after this decision's own transactions: it had already acted
    let hit = all.filter(e => e.created > lo && e.created <= d.bell && !(mine !== null && firstSeq(e) !== null && firstSeq(e) > mine));
    let lowest = lo + 1;
    // an event logged in the bell of the previous such decision, after that decision had acted, is handed to this one
    if (prev >= 0 && prev === lo) {
      const theirs = before.filter(r => r.bell === prev).map(r => ownSeq(r.tx, sigSeq)).filter(n => n !== null);
      const carried = theirs.length ? all.filter(e => e.created === prev && firstSeq(e) !== null && firstSeq(e) > Math.max(...theirs)) : hit.length ? [] : all.filter(e => e.created === prev);
      if (carried.length) { hit = [...carried, ...hit]; lowest = prev; }
    }
    for (const e of hit) hits.set(e.id, e);
    from = from === null ? lowest : Math.min(from, lowest);
  }
  return { episodes: [...hits.values()].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1)), from: from === null ? null : Math.max(0, from) };
}

function eventItem(seq, eps, { herald, events, index, log, hostParts }) {
  const row = seq !== null ? herald.get(seq) ?? null : null;
  const threat = eps.find(e => e.kind === 'threat') ?? null;
  const f = (threat ?? eps[0]).facts;
  const kind = row ? (row.name === 'DEPART' ? 'depart' : row.name === 'CLASH' ? 'clash' : 'other') : threat ? 'depart' : 'other';
  const item = {
    seq, sig: row?.sig ?? '', loaded: !!row, kind, name: row?.name ?? '', bell: row?.bell ?? (threat ?? eps[0]).created, episodeIds: eps.map(e => e.id),
    actors: [], actorState: 'unknown', nation: null, troops: null, from: null, arrive: null, at: null, clashBell: null, engagements: null,
  };
  // an AI citizen's nation is the roster's; anyone else's is what the caller knows (the episode's fact, the file's row)
  const withNation = (tag, faction) => typed(index, { tag, faction: index.aiByTag(tag)?.faction ?? faction ?? null });
  if (kind === 'depart') {
    item.troops = row ? row.troops : f.mass;
    item.from = row ? row.from : (f.p !== null && f.q !== null ? { p: f.p, q: f.q } : null);
    item.arrive = row ? row.arrive : f.arrive;
    const departBell = row?.depart ?? row?.bell ?? null;
    // whose army: the holder of the village that issued the host, from the herald's log; the recent-events file only as a shortcut
    const own = row ? hostOwner(log, hostParts, row.hostId, row.seq) : { state: 'loading', tag: null };
    const ev = row?.hostId ? events.find(e => e.kind === 'depart' && e.hostId === row.hostId && (departBell === null || e.bell === departBell)) : null;
    if (own.state === 'known') item.actors.push(withNation(own.tag, f.nation));
    else if (ev?.actors[0]) item.actors.push(typed(index, ev.actors[0]));
    item.actorState = item.actors.length ? 'known' : own.state;
    item.nation = item.actors[0]?.faction ?? ev?.faction ?? f.nation;
  } else if (kind === 'clash') {
    item.at = row.at;
    item.clashBell = row.clashBell;
    item.engagements = row.engagements;
    // who arrived there: the REVEAL rows of that place and turn (each names a host), then the holder of each host
    const hosts = row.at ? log.reveals.get(`${row.at.p},${row.at.q},${row.clashBell}`) ?? [] : [];
    const owners = hosts.map(id => hostOwner(log, hostParts, id, row.seq));
    const seen = new Set();
    for (const o of owners) if (o.state === 'known' && !seen.has(o.tag)) { seen.add(o.tag); item.actors.push(withNation(o.tag, null)); }
    const ev = row.at ? events.find(e => e.kind === 'clash' && sameAt(e.at, row.at.p, row.at.q) && e.bell === row.clashBell) : null;
    if (!item.actors.length) for (const a of ev?.actors ?? []) item.actors.push(typed(index, a));
    item.actorState = item.actors.length ? 'known' : (hostParts === false ? 'unknown' : log.scanned >= row.seq && hostParts ? 'unknown' : 'loading');
  } else if (row?.at) item.at = row.at;
  return item;
}

// ------------------------------------------------------------------ the trace of one decision
/**
 * `rec` the decision record (normalizeMinds; may be null when only the opened record is known), `opened` its opened
 * record or null, `minds` every decision record (to find the AI's previous decision with the same wake), `episodes` the
 * AI's episode Map (null while it has not loaded), `herald` Map(seq → normalizeHerald row), `events` normalizeEvents
 * rows, `index` the roster index, `bellNow` the current bell, `sigSeq` (optional) `sigSeqIndex(herald)` when many traces are built,
 * `log` the page's copy of the herald's log (`makeLog`; `herald` is its `rows`), `hostParts` faddr.mjs `hostParts` (null while loading, false if it failed).
 */
export function buildTrace({ rec = null, opened = null, minds = [], episodes = null, herald = null, events = [], index, bellNow = null, sigSeq = null, log = null, hostParts = null }) {
  log ??= { ...makeLog(), rows: herald ?? new Map() };
  herald ??= log.rows;
  const d = buildDecision({ rec, opened, episodes });
  const eventWakes = d.wake.filter(w => EVENT_WAKES.includes(w));

  // step 1
  const triggers = [];
  let window = null;
  if (eventWakes.length && episodes) {
    const w = wakeEpisodes({ d, tx: rec?.tx ?? [], minds, episodes, sigSeq: sigSeq ?? sigSeqIndex(herald) });
    window = { from: w.from, to: d.bell };
    const bySeq = new Map();
    for (const e of w.episodes) for (const s of (e.seqs.length ? e.seqs : [null])) (bySeq.get(s) ?? bySeq.set(s, []).get(s)).push(e);
    for (const [seq, eps] of bySeq) triggers.push(eventItem(seq, eps, { herald, events, index, log, hostParts }));
    triggers.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
  }

  // step 2: every line the record lists as shown, in order; a cited id outside that list is added at the end and marked
  const memory = { state: d.state === 'sealed' ? 'sealed' : 'shown', lines: [], verdicts: [] };
  if (d.state !== 'sealed') {
    const shown = (opened ?? rec)?.retrieved ?? [];
    const cited = d.remembered.map(m => m.id);
    const ids = [...shown, ...cited.filter(id => !shown.includes(id))];
    ids.forEach((id, i) => {
      const fromRecord = opened?.remembered.find(m => m.id === id) ?? null;
      const ep = episodes?.get?.(id) ?? null;
      const text = fromRecord?.text ?? ep?.text ?? null;
      const missing = !text || (!text.en && !text.ja);
      memory.lines.push({
        n: i < shown.length ? i + 1 : null, id, kind: ep?.kind ?? '', bell: fromRecord?.bell ?? ep?.bell ?? null, text: missing ? null : text, entities: ep?.entities ?? [],
        missing, loading: missing && !episodes, cited: cited.includes(id),
        events: triggers.filter(g => g.episodeIds.includes(id)).map(g => g.seq),
        fromStep1: triggers.some(g => g.episodeIds.includes(id)),
      });
    });
    if (d.by !== 'model' && !memory.lines.length) memory.state = 'autopilot';
    else if (!memory.lines.length) memory.state = 'none';
    for (const g of triggers) {
      const mine = memory.lines.filter(l => g.episodeIds.includes(l.id) && l.n !== null);
      memory.verdicts.push({ seq: g.seq, status: mine.some(l => l.cited) ? 'cited' : mine.length ? 'shown_not_cited' : 'not_shown' });
    }
  }

  // step 4
  const tx = (rec?.tx ?? []).map(x => ({ intent: x.intent, status: x.status, sig: SIG.test(x.sig) ? x.sig : '' }));
  const marches = d.destinations.map(m => {
    const clashes = events.filter(e => e.kind === 'clash' && sameAt(e.at, m.p, m.q) && e.bell === m.arrive && e.actors.some(a => a.tag === d.tag))
      .map(e => ({ at: e.at, bell: e.bell, engagements: e.engagements, own: e.actors.find(a => a.tag === d.tag) }));
    const lines = episodes ? [...episodes.values()].filter(e => RESULT_KIND.test(e.kind) && ((m.hostId && e.hosts.includes(m.hostId)) || (e.facts.p === m.p && e.facts.q === m.q && e.bell === m.arrive && m.arrive !== null)))
      .sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1))
      .map(e => ({ id: e.id, kind: e.kind, bell: e.bell, text: e.text, entities: e.entities, events: e.seqs.map(seq => ({ seq, sig: herald.get(seq)?.sig ?? '', loaded: herald.has(seq) })) })) : [];
    const status = clashes.length || lines.length ? 'recorded' : (bellNow === null || m.arrive === null || bellNow <= m.arrive + 3) ? 'pending' : 'no_record';
    return { ...m, clashes, lines, status };
  });

  const want = new Set();
  for (const g of triggers) if (g.seq !== null && !g.loaded) want.add(g.seq);
  for (const m of marches) for (const l of m.lines) for (const e of l.events) if (!e.loaded) want.add(e.seq);
  // the log has to be read up to the last event whose actor is still unresolved
  const scanTo = Math.max(0, ...triggers.filter(g => g.loaded && g.actorState === 'loading' && g.seq !== null).map(g => g.seq));

  return {
    id: d.id, tag: d.tag, index: d.index, bell: d.bell, kind: d.kind, by: d.by, reason: d.reason, state: d.state, releaseBell: d.releaseBell, wake: d.wake, eventWakes,
    episodesLoaded: !!episodes, window, triggers, startedByPerson: triggers.some(g => g.actors.some(isPerson)),
    memory, decision: d,
    result: { tx, marches, sealed: d.state === 'sealed', marched: d.marched, unrevealed: d.unrevealed, notSent: d.notSent },
    wantSeqs: [...want].sort((a, b) => a - b), scanTo,
    pending: !episodes ? eventWakes.length > 0 : triggers.some(g => (g.seq !== null && !g.loaded) || g.actorState === 'loading'),
  };
}

const envOf = (env, rec, opened, sigSeq = null) => ({ rec, opened, minds: env.minds, episodes: env.episodesByTag.get(rec?.tag ?? opened?.tag) ?? null, herald: env.herald ?? env.log?.rows ?? null, events: env.events, index: env.index, bellNow: env.bellNow, sigSeq, log: env.log ?? null, hostParts: env.hostParts ?? null });

/** The record whose id starts with `idPrefix` (a deep link may carry the first digits only): `{rec, opened}` or null. */
export function findRecord({ minds = [], opened = new Map() }, idPrefix) {
  const p = str(idPrefix).toLowerCase();
  if (!/^[0-9a-f]{6,64}$/.test(p)) return null;
  const rec = minds.find(r => r.id.startsWith(p)) ?? null;
  if (rec) return { rec, opened: opened.get(rec.id) ?? null };
  for (const [id, op] of opened) if (id.startsWith(p) && op.tag) return { rec: null, opened: op };
  return null;
}

/** The trace of the decision `idPrefix`, or null when its record has not been read. `env` = `{minds, opened, episodesByTag, log, hostParts, events, index, bellNow}` (`herald` = the log's rows, when there is no log). */
export function traceOf(env, idPrefix) {
  const f = findRecord(env, idPrefix);
  return f ? buildTrace(envOf(env, f.rec, f.opened)) : null;
}

/** The traces of every model decision that has a threat or clash wake (newest first). */
export function eventTraces(env) {
  const sigSeq = sigSeqIndex(env.herald ?? env.log?.rows ?? new Map());
  return env.minds.filter(r => r.mode === 'model' && r.wake.some(w => EVENT_WAKES.includes(w)))
    .map(r => buildTrace(envOf(env, r, env.opened.get(r.id) ?? null, sigSeq)))
    .sort((a, b) => b.bell - a.bell || (b.index ?? 0) - (a.index ?? 0) || (a.id < b.id ? -1 : 1));
}

/** Model decisions whose wake matches a public action of a person (a player or the presenter seat). */
export const startedByPeople = (env, { limit = 12 } = {}) => eventTraces(env).filter(tr => tr.startedByPerson).slice(0, limit);

/** What the page still has to read for these traces: `{tags, seqs, scanTo}` (episode lists not loaded, herald events not read, how far the log must be read for the actors). */
export function traceNeeds(env, traces) {
  const tags = new Set(), seqs = new Set();
  let scanTo = 0;
  for (const tr of traces) {
    if (!tr) continue;
    if (!tr.episodesLoaded && tr.tag) tags.add(tr.tag);
    for (const s of tr.wantSeqs) seqs.add(s);
    scanTo = Math.max(scanTo, tr.scanTo);
  }
  return { tags: [...tags], seqs: [...seqs].sort((a, b) => a - b), scanTo };
}

// ------------------------------------------------------------------ render
const ACTOR_KEY = { ai: 'trace.actor.ai', script: 'trace.actor.script', seat: 'trace.actor.seat', person: 'trace.actor.person', unlisted: 'trace.actor.unlisted', unknown: 'trace.actor.unknown', loading: 'trace.actor.loading' };
const VERDICT_KEY = { cited: 'trace.verdict.cited', shown_not_cited: 'trace.verdict.shown_not_cited', not_shown: 'trace.verdict.not_shown' };
const STATUS_KEY = { sent: 'trace.status.sent', refused: 'trace.status.refused' };
const orRaw = (t, key, raw) => (t(key) === key ? raw : t(key));

/** A transaction signature: the first and last digits, the whole value on hover and in the opened box (select to copy). */
export function sigEl(ctx, sig, loaded = true) {
  const { h, t } = ctx;
  if (!sig) return h('span', { class: 'muted small' }, t(loaded ? 'trace.sig_absent' : 'trace.sig_none'));
  return h('details', { class: 'sig' },
    h('summary', { title: sig }, `${t('trace.sig')} ${sig.slice(0, 8)}…${sig.slice(-6)}`),
    h('code', { class: 'sig-full' }, sig));
}

/**
 * "nation Aster · Koin [person (player)]". An AI citizen and a script bot carry their roster badge (as everywhere on the
 * page); every other actor gets the trace's own chip, which says a person, or says that it could not be checked.
 */
function whoEl(ctx, a, nation, state = 'unknown') {
  const { h, t, lang } = ctx;
  const type = a?.type ?? (state === 'loading' ? 'loading' : 'unknown');
  return h('span', { class: 'trace-who' },
    nation !== null && nation !== undefined ? `${t('ev.nation', { name: nationName(nation, lang) })} · ` : null,
    a && (a.tag || a.wallet) ? actorEl(ctx, a, { long: true }) : null,
    type === 'ai' || type === 'script' ? null : [' ', h('span', { class: `chip trace-actor trace-actor-${type}` }, t(ACTOR_KEY[type]))]);
}

function stepEl(ctx, n, titleKey, ...kids) {
  const { h, t } = ctx;
  return h('div', { class: `trace-step trace-step-${n}` }, h('h4', { class: 'trace-step-title' }, h('span', { class: 'trace-n' }, String(n)), ' ', t(titleKey)), kids);
}

function eventEl(ctx, g) {
  const { h, t } = ctx;
  const li = h('li', { class: `trace-event trace-event-${g.kind}` }, h('span', { class: 'bellmark' }, g.bell !== null ? t('page.bell_n', { n: int(g.bell) }) : ''));
  if (g.kind === 'depart') {
    const vars = { troops: int(g.troops), from: g.from ? placeText(t, g.from.p, g.from.q) : '?', arrive: g.arrive !== null ? int(g.arrive) : '?' };
    li.appendChild(h('span', { class: 'event-text' }, tplNodes(t(g.troops !== null ? 'trace.depart' : 'trace.depart_notroops', vars), { who: whoEl(ctx, g.actors[0] ?? null, g.nation, g.actorState) })));
  } else if (g.kind === 'clash') {
    li.appendChild(h('span', { class: 'event-text' }, t('trace.clash', { at: g.at ? placeText(t, g.at.p, g.at.q) : '?', bell: g.clashBell !== null ? int(g.clashBell) : '?', n: g.engagements !== null ? int(g.engagements) : '?' })));
    li.appendChild(h('span', { class: 'event-actors' }, g.actors.length ? g.actors.map(a => h('span', { class: 'event-actor' }, whoEl(ctx, a, a.faction))) : whoEl(ctx, null, null, g.actorState)));
  } else li.appendChild(h('span', { class: 'event-text' }, g.name ? t('trace.event_other', { name: g.name }) : t('trace.event_unread')));
  li.appendChild(h('div', { class: 'trace-ref muted small' }, g.seq !== null ? `${t('trace.seq', { seq: int(g.seq) })} · ` : null, sigEl(ctx, g.sig, g.loaded)));
  return li;
}

function step1(ctx, tr) {
  const { h, t } = ctx;
  const people = tr.triggers.length > 0 && tr.triggers.every(g => g.actors.length > 0 && g.actors.every(isPerson));
  const title = people ? 'trace.s1_person' : 'trace.s1_other';
  if (!tr.eventWakes.length) return stepEl(ctx, 1, title, h('p', { class: 'muted' }, t('trace.s1_nowake', { wake: tr.wake.join(', ') || t('trace.wake_none') })));
  if (!tr.episodesLoaded) return stepEl(ctx, 1, title, h('p', { class: 'muted' }, t('trace.episodes_loading')));
  if (!tr.triggers.length) return stepEl(ctx, 1, title, h('p', { class: 'muted' }, t('trace.s1_none', { wake: tr.eventWakes.join(', ') })));
  return stepEl(ctx, 1, title,
    h('ul', { class: 'lines trace-events' }, tr.triggers.map(g => eventEl(ctx, g))),
    h('p', { class: 'muted small' }, t('trace.s1_note', { wake: tr.eventWakes.join(', '), a: int(tr.window.from), b: int(tr.window.to) })));
}

const sealedNote = (ctx, tr) => (tr.releaseBell !== null ? ctx.t('trace.sealed_until', { n: int(tr.releaseBell) }) : ctx.t('trace.sealed_until_nobell'));

function step2(ctx, tr) {
  const { h, t } = ctx;
  const m = tr.memory;
  if (m.state === 'sealed') return stepEl(ctx, 2, 'trace.s2', h('p', { class: 'sealed-body' }, sealedNote(ctx, tr)));
  if (m.state === 'autopilot') return stepEl(ctx, 2, 'trace.s2', h('p', { class: 'muted' }, t('trace.s2_autopilot')));
  if (m.state === 'none') return stepEl(ctx, 2, 'trace.s2', h('p', { class: 'muted' }, t('trace.s2_none')));
  const ul = h('ul', { class: 'lines remembered trace-memory' });
  for (const l of m.lines) {
    const li = h('li', { class: `trace-line${l.cited ? ' cited' : ''}${l.fromStep1 ? ' from-step1' : ''}` },
      h('span', { class: 'cand-id' }, l.n !== null ? `M${l.n}` : '—'), ' ',
      l.missing ? h('span', { class: 'missing' }, t(l.loading ? 'dec.remembered_loading' : 'dec.remembered_missing', { id: l.id.slice(0, 8) })) : lineEl(ctx, l.text, l.entities, { cls: 'line' }), ' ',
      h('span', { class: 'bellmark' }, [l.kind, l.bell !== null ? t('page.bell_n', { n: int(l.bell) }) : ''].filter(Boolean).join(' · ')));
    if (l.fromStep1) li.appendChild(h('span', { class: 'chip chip-motion' }, l.events.some(s => s !== null) ? t('trace.mem.from_event', { seq: l.events.filter(s => s !== null).map(int).join(', ') }) : t('trace.mem.from_step1')));
    if (l.n === null) li.appendChild(h('span', { class: 'chip chip-state-sealed' }, t('trace.mem.unlisted')));
    else if (l.cited) li.appendChild(h('span', { class: 'chip chip-model' }, t('trace.mem.cited')));
    else li.appendChild(h('span', { class: 'chip chip-auto' }, t('trace.mem.not_cited')));
    ul.appendChild(li);
  }
  return stepEl(ctx, 2, 'trace.s2',
    h('p', { class: 'muted small' }, t(tr.by === 'model' ? 'trace.s2_note' : 'trace.s2_note_autopilot')),
    ul,
    m.verdicts.map(v => h('p', { class: `trace-verdict trace-verdict-${v.status}` }, v.seq !== null ? t(VERDICT_KEY[v.status], { seq: int(v.seq) }) : t(VERDICT_KEY[v.status], { seq: '?' }))),
    h('p', { class: 'muted small' }, t('dec.remembered_caption')));
}

function step3(ctx, tr) {
  const { h, t } = ctx;
  const d = tr.decision;
  const by = h('span', { class: `chip ${d.by === 'model' ? 'chip-model' : 'chip-auto'}` }, t(d.by === 'model' ? 'dec.by_model' : 'dec.by_autopilot'));
  if (d.state === 'sealed') return stepEl(ctx, 3, 'trace.s3', h('p', { class: 'sealed-body' }, by, ' ', t(d.by === 'model' ? 'trace.made_model' : 'trace.made_auto'), ' ', sealedNote(ctx, tr)));
  if (d.kind === 'reflection') return stepEl(ctx, 3, 'trace.s3', h('p', null, by), h('p', { class: 'reflection-body muted' }, t('dec.reflection_body')));
  const kids = [h('p', null, by, d.by !== 'model' ? h('span', { class: 'muted' }, ` ${t('trace.auto_note')}`) : null)];
  kids.push(d.candidates.length ? h('details', { class: 'cand-box', open: true }, h('summary', null, t('dec.candidates')), candidateList(ctx, d)) : h('p', { class: 'muted small' }, t('trace.no_candidates')));
  const chose = d.chosen.length ? d.chosen.map(c => (c.label || c.kind ? `${c.id} ${candidateLabel(t, c)}` : c.id)).join(' + ') : t('dec.chose_none');
  kids.push(h('p', { class: 'chose' }, h('strong', null, `${t('dec.chose')}: `), chose, d.goalId ? h('span', { class: 'muted' }, ` · ${t('dec.goal', { id: d.goalId })}`) : null));
  if (d.params.length) kids.push(h('p', { class: 'trace-params' }, h('strong', null, `${t('trace.params')}: `), d.params.map(p => `${p.id}: ${p.pairs.map(([k, v]) => `${k} ${v}`).join(' · ')}`).join('; ')));
  if (d.by !== 'model' && !d.whyWithheld) kids.push(h('p', { class: 'words muted' }, t('dec.words_autopilot')));
  else {
    kids.push(h('p', { class: 'words-label' }, t('dec.words')));
    kids.push(d.whyWithheld ? h('p', { class: 'words muted' }, t('dec.withheld')) : h('p', { class: 'words' }, d.why || t('dec.words_none')));
  }
  if (d.say.length) kids.push(h('div', { class: 'say' }, h('span', { class: 'muted' }, `${t('dec.say')}: `), d.say.map(s => h('q', null, s))));
  return stepEl(ctx, 3, 'trace.s3', kids);
}

function step4(ctx, tr) {
  const { h, t } = ctx;
  const r = tr.result;
  const kids = [h('p', { class: 'trace-sub' }, t('trace.tx'))];
  if (!r.tx.length) kids.push(h('p', { class: 'muted' }, t('trace.tx_none')));
  else kids.push(h('ul', { class: 'lines trace-tx' }, r.tx.map(x => h('li', null,
    h('span', { class: 'cand-id' }, orRaw(t, `dec.intent.${x.intent}`, x.intent || '?')), ' ',
    h('span', { class: `chip ${x.status === 'sent' ? 'chip-state-released' : 'chip-auto'}` }, STATUS_KEY[x.status] ? t(STATUS_KEY[x.status]) : (x.status || '?')), ' ',
    sigEl(ctx, x.sig)))));

  if (r.sealed) kids.push(h('p', { class: 'sealed-body' }, r.marched ? `${t('trace.dest_sealed')} ${sealedNote(ctx, tr)}` : sealedNote(ctx, tr)));
  else if (r.notSent) kids.push(h('p', { class: 'dest muted not-sent' }, t('dec.not_sent')));
  else if (r.unrevealed && !r.marches.length) kids.push(h('p', { class: 'dest muted' }, t('dec.unrevealed')));
  else if (!r.marches.length) kids.push(h('p', { class: 'muted' }, t('trace.no_march')));
  for (const m of r.marches) {
    kids.push(h('p', { class: 'dest' }, h('strong', null, `${t('dec.destination')}: `), t('dec.destination_at', { p: int(m.p), q: int(m.q), tile: int(m.tile) }),
      m.arrive !== null ? h('span', { class: 'muted' }, ` · ${t('dec.arrives', { a: int(m.arrive), b: int(m.planned ?? m.arrive) })}`) : null));
    kids.push(h('p', { class: 'trace-sub' }, t('trace.outcome')));
    if (m.status === 'pending') kids.push(h('p', { class: 'muted trace-pending' }, t('trace.pending')));
    else if (m.status === 'no_record') kids.push(h('p', { class: 'muted trace-pending' }, t('trace.no_record')));
    for (const c of m.clashes) {
      kids.push(h('p', { class: 'trace-clash' }, h('span', { class: 'chip' }, t('ev.kind.clash')), ' ',
        t('trace.clash', { at: placeText(t, c.at.p, c.at.q), bell: int(c.bell), n: c.engagements !== null ? int(c.engagements) : '?' }), ' ',
        actorEl(ctx, { tag: tr.tag }, {}), clashFacts(ctx, c.own)));
    }
    if (m.lines.length) {
      kids.push(h('p', { class: 'muted small' }, t('trace.outcome_lines')));
      kids.push(h('ul', { class: 'lines remembered' }, m.lines.map(l => h('li', null,
        lineEl(ctx, l.text, l.entities, { cls: 'line' }), ' ', h('span', { class: 'bellmark' }, l.kind),
        l.events.map(e => h('div', { class: 'trace-ref muted small' }, `${t('trace.seq', { seq: int(e.seq) })} · `, sigEl(ctx, e.sig, e.loaded)))))));
    }
  }
  return stepEl(ctx, 4, 'trace.s4', kids);
}

/** The whole view of one decision. */
export function renderTrace(ctx, tr, { onClose = null } = {}) {
  const { h, t } = ctx;
  const kindTxt = orRaw(t, `dec.kind.${tr.kind}`, tr.kind);
  const stateKey = tr.state === 'sealed' ? 'dec.state_sealed' : tr.state === 'released' ? 'dec.state_released' : 'dec.state_plain';
  return h('article', { class: `trace trace-${tr.by}`, 'data-id': tr.id.slice(0, 16) },
    h('div', { class: 'dec-head' },
      h('h3', { class: 'trace-title' }, t('trace.title')),
      h('span', { class: 'dec-who' }, actorEl(ctx, { tag: tr.tag })),
      h('span', { class: `chip ${tr.by === 'model' ? 'chip-model' : 'chip-auto'}` }, t(tr.by === 'model' ? 'dec.by_model' : 'dec.by_autopilot')),
      h('span', { class: `chip chip-state-${tr.state}` }, t(stateKey)),
      h('span', { class: 'bellmark' }, `${t('page.bell_n', { n: int(tr.bell) })} · ${kindTxt} · ${t('trace.wake', { codes: tr.wake.join(', ') || t('trace.wake_none') })}`),
      onClose ? h('button', { type: 'button', class: 'btn btn-quiet btn-trace', on: { click: onClose } }, t('trace.close')) : null),
    h('p', { class: 'muted small' }, t('trace.note'), ' ', h('span', { class: 'trace-id' }, t('trace.record', { id: tr.id.slice(0, 16) }))),
    step1(ctx, tr), step2(ctx, tr), step3(ctx, tr), step4(ctx, tr));
}

/** The short list at the top of the decisions section, and the open trace under it. */
export function renderTracePanel(ctx, { started = [], pending = false, trace = null, traceId = null, onOpen = null, onClose = null } = {}) {
  const { h, t, lang } = ctx;
  const box = h('div', { class: 'trace-panel' });
  const list = h('div', { class: 'trace-started' }, h('h3', null, t('trace.started.title')), h('p', { class: 'muted small' }, t('trace.started.note')));
  if (!started.length) list.appendChild(h('p', { class: 'empty' }, t(pending ? 'trace.started.loading' : 'trace.started.none')));
  else list.appendChild(h('ul', { class: 'lines' }, started.map(tr => {
    const g = tr.triggers.find(x => x.actors.some(isPerson));
    const a = g.actors.find(isPerson);
    return h('li', { class: 'trace-started-item' },
      h('span', { class: 'bellmark' }, t('page.bell_n', { n: int(tr.bell) })),
      actorEl(ctx, { tag: tr.tag }), ' ',
      h('span', { class: 'chip chip-model' }, t('dec.by_model')), ' ',
      h('span', { class: 'muted' }, t('trace.started.line', { b: g.bell !== null ? int(g.bell) : '?', nation: nationName(a.faction ?? g.nation, lang), actor: t(ACTOR_KEY[a.type]) })), ' ',
      onOpen ? h('button', { type: 'button', class: 'btn btn-quiet btn-trace', on: { click: () => onOpen(tr.id) } }, t('trace.open')) : null);
  })));
  if (started.length && pending) list.appendChild(h('p', { class: 'muted small' }, t('trace.started.loading')));
  box.appendChild(list);
  if (trace) box.appendChild(renderTrace(ctx, trace, { onClose }));
  else if (traceId) box.appendChild(h('p', { class: 'empty trace-loading' }, t('trace.loading', { id: String(traceId).slice(0, 16) })));
  return box;
}
