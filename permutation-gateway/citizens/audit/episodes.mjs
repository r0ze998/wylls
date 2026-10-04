// M11, the episode replay (contract 5.7, 7.3, 10.2 G15; rulings R10 and integ-A-NOTES section 17; unit AC8).
//
// What it does, over the PUBLIC log only (the herald's /h/events, /h/province, /h/clash, the published talk and council files,
// the operator's redactions; the brain's marchbook and every private file are never inputs):
//
//  Part 1  for 3 sampled AIs (sampled by sha256(last minds_root || i)) `episodes_from_events` is replayed over the whole log
//          with the same code the live pump uses, the 200 cap is applied (importance-aware eviction), every redaction is
//          applied, and the canonical list is compared with `PUB/memory/<tag>/episodes.json`: the file's own sha256 field
//          must equal the hash of its episodes (an edited episode fails here), and the replayed list must equal it. An
//          episode whose source record was redacted is compared by id, bell, kind and created_bell only (text and entities
//          are blanked on both sides).
//  Part 2  for 20 sampled opened decisions (an unsealed model record, or a sealed one with its opening) `retrieve()` is
//          recomputed from the replayed episodes: only episodes with created_bell < the decision's bell, the 200 cap applied
//          AS OF THAT BELL (the 200 the eviction rule keeps among those episodes, not the cap of the final list; R10), the
//          redactions whose tombstone bell is at or before the decision's bell applied (a later one does not blank it), the
//          open grievances derived from the replay, and the focus rebuilt from the opened candidates, the situation and the
//          inbox. The result must equal the record's `retrieved`, or equal it after the budget cut of renderMemory (the
//          oldest unprotected ids first; the cut is reported).
//  Part 3  every id in `choice.mem` of every published or opened decision is in its `retrieved` (G13).
//
// What the replay cannot know and how it says so (AC8-NOTES.md): the focus extras (inbox sender tags, threat nations) are not
// stored with a record. The threat nations are re-derived by running the wave-A watcher stub over the replayed feed in the AI's
// own decision order; the inbox senders are derived from the talk files when the record's inbox_root is not the empty root.
// When the service stored `focus` (`priv.focus`, published in full/decisions) it is used as it is (`focus_source: "stored"`).
import { Episodes, redactedForm } from '../memory/store.mjs';
import { EPISODE_CAP, canonical, sha256hex } from '../memory/config.mjs';
import { episodes_from_events } from '../memory/episodes.mjs';
import { retrieve, protectedIds } from '../memory/retrieve.mjs';
import { createFeed } from '../watcher/feed.mjs';
import { createWaveAWatcher, councilFileForEpisodes } from '../mind/wiring.mjs';
import { decode, fromBase64, view } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { createCheck, sampleFrom, sha256Canonical, sha256hex as sha, groupBy } from './canon.mjs';

const EMPTY_INBOX_ROOT = sha('');
export const SAMPLE_AIS = 3;
export const SAMPLE_DECISIONS = 20;
const RETRIEVING_KINDS = new Set(['session', 'reaction', 'motion', 'ballot']);

/** The form two lists are compared in: a redacted episode reduces to id, bell, kind, created_bell. */
export const comparisonForm = e => (e.redacted ? { id: e.id, bell: e.bell, kind: e.kind, created_bell: e.created_bell, redacted: true } : e);
export const comparisonHash = list => sha256hex(canonical(list.map(comparisonForm)));

/** The inner hashes (hex) of the talk records a redaction tombstone list names, with their bells. */
export const tombstoneMap = list => new Map((list ?? []).filter(t => typeof t?.inner === 'string').map(t => [t.inner, Number(t.bell ?? 0)]));

/** An episode is made from a redacted record when one of its sources is `talk:<inner>` of a tombstone. */
export function redactedAt(ep, tombs, bell = Infinity) {
  for (const s of ep.src ?? []) {
    if (!String(s).startsWith('talk:')) continue;
    const t = tombs.get(String(s).slice(5));
    if (t !== undefined && t <= bell) return true;
  }
  return false;
}

/** Apply the 200 cap (importance-aware eviction, the store's own function) and the redactions at or before `bell`. */
export function listAsOf(all, { bellExclusive = Infinity, tombs = new Map(), redactBell = Infinity, cap = EPISODE_CAP } = {}) {
  const store = new Episodes(all.filter(e => e.created_bell < bellExclusive), { cap });
  return store.list().map(e => (e.redacted || redactedAt(e, tombs, redactBell) ? redactedForm(e) : e));
}

// ------------------------------------------------------------------ the public inputs
/**
 * The accepted talk rows of the published bell files in acceptance order, as the producer reads them (the shape of the book's
 * message view): `{id, bell, wallet, tag, channel, target, kind, ref, origin, inner}`. A redacted entry has no bytes: its
 * metadata comes from `PUB/full/social.json` (written at season end from the social journal, never the text).
 */
export function talkRowsFromPub(pub, { tagOfWallet, social = null }) {
  const meta = new Map((social?.records ?? []).filter(r => r.inner).map(r => [r.inner, r]));
  const rows = [];
  for (const [bell, file] of pub.talk()) {
    for (const r of file?.records ?? []) {
      if (r.type === 'ballot') continue;
      let v = null, wallet = null;
      if (r.bytes_b64) {
        try { const d = decode(fromBase64(r.bytes_b64)); if (d.type !== 'talk') continue; v = view(d); wallet = v.wallet; } catch { continue; }
      } else if (r.redacted && meta.has(r.inner)) {
        const m = meta.get(r.inner);
        if (m.type !== 'talk' || m.channel === undefined) continue;
        v = { channel: m.channel, target: m.target ?? null, kind: m.kind, ref: m.ref }; wallet = m.wallet;
      } else continue;
      rows.push({ id: r.id, bell, wallet, tag: tagOfWallet(wallet), channel: v.channel, target: v.target, kind: v.kind, ref: v.ref, origin: meta.get(r.inner)?.origin ?? v.origin, inner: r.inner, ...(r.redacted ? { redacted: true } : {}) });
    }
  }
  return rows;
}

/** The council files in the shape the producer reads (wiring.mjs `councilFileForEpisodes`), per faction. */
export function councilsFromPub(pub) {
  const out = new Map();
  for (const f of pub.councils()) {
    const e = councilFileForEpisodes(f);
    if (e) (out.get(Number(f.faction)) ?? out.set(Number(f.faction), []).get(Number(f.faction))).push(e);
  }
  return out;
}

/** A feed over the herald, drained to the end of its log; `through` = the last bell whose records are all in hand. */
export async function drainFeed({ herald, roster, fetchImpl = null, onError = () => {} }) {
  const feed = createFeed({ herald, roster, fetch: fetchImpl, onError });
  // one poll reads at most 400 pages; a long log needs several
  let r;
  for (let i = 0; i < 100; i++) {
    const before = feed.cursor();
    r = await feed.poll();
    if (r.ok || (feed.cursor() === before && r.error)) break;
  }
  if (!r.ok) throw new Error(`the herald could not be read to the end of its log: ${r.error}`);
  return { feed, through: feed.completeThrough() };
}

/**
 * Replay `episodes_from_events` for one AI over the whole log: the same events the live pump reads (every log bell up to
 * `through`), the same readers, the same context. Two passes so that the open grievances the pump takes from the ledger exist
 * for the `answered` deltas. Returns the uncapped, unredacted episodes and the deltas.
 */
export async function replayOne({ feed, prepared, events, tag, entry, through, genesisTs, talk, councils, extraConfig = {} }) {
  const owners = feed.owners;
  const home = owners.homeOf(tag);
  if (!home) return { episodes: [], deltas: [], unknown: [], collisions: [], noHome: true };
  const ai = { tag, wallet: entry.wallet, faction: owners.factionOfTag(tag) ?? entry.faction ?? null, home: { p: home.p, q: home.q }, holdings: owners.holdingsOf(tag).map(h => ({ p: h.p, q: h.q, site: h.site })) };
  const base = {
    ai, bellNow: through + 1, owners, province: prepared.province, clash: prepared.clash, clashDetail: prepared.clashDetail,
    config: { genesis_ts: genesisTs, redactions: [], ...extraConfig },
  };
  const batch = { events, talk, council: councils };
  const first = episodes_from_events(batch, { ...base, config: { ...base.config, openGrievances: [] } });
  const open = first.deltas.filter(d => d.kind === 'grievance').map(d => ({ id: d.id, against: d.against, nation: d.nation, bell: d.bell }));
  const second = open.length ? episodes_from_events(batch, { ...base, config: { ...base.config, openGrievances: open } }) : first;
  return { episodes: second.episodes, deltas: second.deltas, unknown: second.unknown, collisions: second.collisions };
}

/** Grievances open at `bell` from a replay's deltas: (event, bell, answered) as `retrieve` reads them. */
export function grievancesAt(episodes, deltas, bell) {
  const byId = new Map(episodes.map(e => [e.id, e]));
  const answered = new Set(deltas.filter(d => d.kind === 'answered' && d.bell < bell).map(d => d.grievance));
  return deltas.filter(d => d.kind === 'grievance' && (byId.get(d.event)?.created_bell ?? Infinity) < bell)
    .map(d => ({ id: d.id, event: d.event, bell: d.bell, answered: answered.has(d.id) }));
}

/** The cut check: `got` equals `want` or `want` with its first k unprotected ids removed (renderMemory drops the oldest unprotected first). */
export function explainRetrieved(want, got, protectedSet) {
  if (want.length === got.length && want.every((x, i) => x === got[i])) return { ok: true, cut: 0 };
  if (got.length >= want.length) return { ok: false };
  const unprotected = want.filter(id => !protectedSet.has(id));
  const k = want.length - got.length;
  if (k > unprotected.length) return { ok: false };
  const dropped = new Set(unprotected.slice(0, k));
  const expected = want.filter(id => !dropped.has(id));
  return expected.length === got.length && expected.every((x, i) => x === got[i]) ? { ok: true, cut: k } : { ok: false };
}

const diffLists = (want, got) => {
  const w = new Map(want.map(e => [e.id, e])), g = new Map(got.map(e => [e.id, e]));
  const missing = [...w.keys()].filter(i => !g.has(i));
  const extra = [...g.keys()].filter(i => !w.has(i));
  const changed = [...w.keys()].filter(i => g.has(i) && canonical(comparisonForm(w.get(i))) !== canonical(comparisonForm(g.get(i))));
  return { missing_in_published: missing.slice(0, 8), extra_in_published: extra.slice(0, 8), changed: changed.slice(0, 8), counts: { replayed: want.length, published: got.length } };
};

/**
 * @param {object} o
 * @param {object} o.pub          openPub(PUB)
 * @param {string|{get:Function}} o.herald  loopback herald URL (or a {get(path)} double)
 * @param {object} o.roster       roster.json
 * @param {Function} o.tagOfWallet (wallet b58) -> citizen tag hex
 * @param {{opened:(id)=>object|null, decisions:Iterable}} o.decisions see verify-minds `collectDecisions`
 */
export async function checkM11({ pub, drained: drainedIn = null, herald, roster, tagOfWallet, decisions, seedHex, fetchImpl = null, sampleAis = SAMPLE_AIS, sampleDecisions = SAMPLE_DECISIONS, through: throughOpt = null, codeCheck = null }) {
  const chk = createCheck('M11', 'episode replay');
  const ais = roster?.ai ?? [];
  if (!ais.length) { chk.skip('no AI citizens on the roster'); return chk.result(); }
  const entryOf = new Map(ais.map(a => [a.tag, a]));
  let drained = drainedIn;
  if (!drained) { try { drained = await drainFeed({ herald, roster, fetchImpl }); } catch (e) { chk.fail('herald_unreadable', { detail: e.message }); return chk.result(); } }
  const { feed } = drained;
  const through = throughOpt ?? drained.through;
  const season = feed.season();
  const genesisTs = Number(season?.genesisTs);
  chk.set('through_bell', through);
  if (codeCheck) chk.set('replay_code', codeCheck);

  const tombs = tombstoneMap(pub.redactions());
  const social = pub.fullSocial();
  const talk = talkRowsFromPub(pub, { tagOfWallet, social });
  const councils = councilsFromPub(pub);
  const events = [];
  for (let b = 0; b <= through; b++) events.push(...feed.events(b));
  const prepared = await feed.prepare(events);
  const replays = new Map();
  const replay = async tag => {
    if (!replays.has(tag)) {
      const entry = entryOf.get(tag);
      replays.set(tag, await replayOne({ feed, prepared, events, tag, entry, through, genesisTs, talk, councils: councils.get(entry.faction) ?? [] }));
    }
    return replays.get(tag);
  };

  // ---- part 1: the episode lists of the sampled AIs
  const tags = ais.map(a => a.tag).sort();
  const sampledAis = sampleFrom(seedHex, tags, sampleAis);
  chk.set('sampled_ais', sampledAis);
  for (const tag of sampledAis) {
    chk.count();
    const file = pub.memoryFile(tag);
    const published = file?.episodes ?? [];
    if (file) {
      const ownHash = sha256hex(canonical([...published].sort((a, b) => a.created_bell - b.created_bell || a.bell - b.bell || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))));
      if (file.sha256 !== ownHash) chk.fail('episodes_file_inconsistent', { tag, detail: 'the file\'s sha256 is not the hash of its own episodes (an episode was edited, added or removed after publication)', file_sha256: file.sha256, recomputed: ownHash });
    }
    const r = await replay(tag);
    if (r.noHome) { if (published.length) chk.fail('episodes_without_home', { tag, count: published.length }); else if (!file) chk.note(`${tag}: no village and no episode file (nothing to remember)`); continue; }
    const want = listAsOf(r.episodes, { tombs });
    if (!file) { if (want.length) chk.fail('episodes_file_missing', { tag, replayed: want.length }); continue; }
    const wantHash = comparisonHash(want), gotHash = comparisonHash(published);
    if (wantHash !== gotHash) chk.fail('episodes_mismatch', { tag, replayed_sha256: wantHash, published_sha256: gotHash, ...diffLists(want, published), unknown: r.unknown.length ? r.unknown.slice(0, 4) : undefined });
  }

  // ---- parts 2 and 3: retrieval of sampled decisions, and the citations of all of them
  const pool = decisions.filter(d => d.opened && d.record.mode === 'model' && RETRIEVING_KINDS.has(d.record.kind) && Array.isArray(d.opened.retrieved))
    .sort((a, b) => a.record.bell - b.record.bell || a.record.index - b.record.index || (a.record.kind < b.record.kind ? -1 : a.record.kind > b.record.kind ? 1 : 0) || (a.record.id < b.record.id ? -1 : 1));
  for (const d of decisions) {
    if (!d.opened) continue;
    const mem = d.opened.choice?.mem ?? [];
    chk.count();
    const retrievedIds = new Set(d.opened.retrieved ?? []);
    const bad = mem.filter(id => !retrievedIds.has(id));
    if (bad.length) chk.fail('mem_outside_retrieved', { decision: d.record.id, bell: d.record.bell, ai: d.record.ai, mem: bad, retrieved: d.opened.retrieved });
  }
  chk.set('mem_checked', decisions.filter(x => x.opened).length);
  const sampled = sampleFrom(seedHex, pool, sampleDecisions);
  chk.set('sampled_decisions', sampled.length);
  // the wave-A watcher stub, run in each AI's own decision order, gives the threat nations the live decisions saw
  const watcherOf = new Map();
  const allRecordsOf = groupBy(decisions.map(d => d.record), r => r.ai);
  let focusStored = 0, focusDerived = 0, skipped = 0, cutSeen = 0;
  for (const d of sampled) {
    const rec = d.record, op = d.opened;
    chk.count();
    const entry = entryOf.get(rec.ai);
    if (!entry) { chk.fail('decision_ai_not_on_roster', { decision: rec.id, ai: rec.ai }); continue; }
    const r = await replay(rec.ai);
    const candidates = op.candidates ?? d.full?.candidates ?? null;
    if (!candidates) { skipped++; continue; }
    const sit = d.full?.situation ?? null;
    const homeP = sit?.me?.home?.p !== undefined ? sit.me.home : feed.owners.homeOf(rec.ai);
    const faction = sit?.me?.faction ?? feed.owners.factionOfTag(rec.ai) ?? entry.faction;
    const base = new Set([rec.ai, `nation:${faction}`]);
    if (homeP?.p !== undefined) base.add(`pq:${homeP.p},${homeP.q}`);
    for (const c of candidates) for (const e of c.entities ?? []) base.add(e);
    const variants = [];
    if (Array.isArray(d.full?.focus)) { variants.push({ name: 'stored', focus: new Set(d.full.focus) }); focusStored++; }
    else {
      focusDerived++;
      if (!watcherOf.has(rec.ai)) {
        const w = createWaveAWatcher({ feed });
        const bells = [...new Set((allRecordsOf.get(rec.ai) ?? []).map(x => x.bell))].sort((a, b) => a - b);
        const threats = new Map();
        for (const b of bells) {
          threats.set(b, w.wakeEvents(rec.ai, b).filter(x => x.code === 'W-THREAT' && x.facts).map(x => x.facts.nation));
        }
        watcherOf.set(rec.ai, threats);
      }
      const threatNations = watcherOf.get(rec.ai).get(rec.bell) ?? [];
      const withThreat = new Set([...base, ...threatNations.map(n => `nation:${n}`)]);
      variants.push({ name: 'base', focus: base });
      if (threatNations.length) variants.push({ name: 'threat', focus: withThreat });
      if (rec.inbox_root && rec.inbox_root !== EMPTY_INBOX_ROOT) {
        const senders = talk.filter(t => t.bell <= rec.bell && t.bell >= rec.bell - 12 && t.tag && t.tag !== rec.ai
          && ((t.channel === 3 && t.target === entry.wallet) || (t.channel === 1 && Number(t.target) === faction))).map(t => t.tag);
        const sset = new Set(senders);
        variants.push({ name: 'inbox', focus: new Set([...base, ...sset]) }, { name: 'inbox+threat', focus: new Set([...withThreat, ...sset]) });
      }
    }
    const as = listAsOf(r.episodes, { bellExclusive: rec.bell, tombs, redactBell: rec.bell });
    const gr = grievancesAt(as, r.deltas, rec.bell).filter(g => as.some(e => e.id === g.event && !e.redacted));
    const byIdMap = new Map(as.map(e => [e.id, e]));
    let ok = null, tried = [];
    for (const v of variants) {
      const want = retrieve(as, v.focus, rec.bell, { grievances: gr });
      const prot = protectedIds(byIdMap, want, gr);
      const ex = explainRetrieved(want, op.retrieved, prot);
      tried.push({ variant: v.name, want });
      if (ex.ok) { ok = { variant: v.name, cut: ex.cut }; break; }
    }
    if (!ok) chk.fail('retrieved_mismatch', { decision: rec.id, bell: rec.bell, ai: rec.ai, retrieved: op.retrieved, replayed: tried.map(t => ({ variant: t.variant, ids: t.want })), focus_source: variants[0].name === 'stored' ? 'stored' : 'derived' });
    else if (ok.cut) cutSeen++;
  }
  chk.set('retrieval', { sampled: sampled.length, focus_stored: focusStored, focus_derived: focusDerived, skipped_no_candidates: skipped, with_budget_cut: cutSeen });
  if (skipped) chk.note(`${skipped} sampled decision(s) had no opened candidates (no PUB/full/decisions file or opening): the focus could not be rebuilt, retrieval not recomputed for them`);
  if (!sampled.length) chk.note('no opened model decision to sample: part 2 ran on 0 decisions');
  if (focusDerived) chk.note('the focus extras (inbox senders, threat nations) are not stored with a record: they were derived (variants base / threat / inbox); a service that stores `focus` in each private record makes this exact');
  chk.set('episodes_total', Object.fromEntries([...replays].map(([t, r]) => [t, r.episodes.length])));
  return chk.result();
}
