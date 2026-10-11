// AC6: the release job (contract section 7.2, ruling R10): a sealed decision record is opened once its march is public.
//
// A record is sealed at once when its sent actions include a march (model-chosen, recall, or a Strike-Order follow) or when its nation
// had a live Strike Order. `release_bell` is committed in the record and never changes. The brain re-plans a model answer 60 s after the
// step, so the real arrival can be later than the planned one; the job therefore opens a record when
//   - the REVEAL of every march of the decision is public AND that march's real arrival bell has ended (job bell > arrive), and
//   - the bell is not before `release_bell` (for a decision made under a live Strike Order that is S + 2),
// waiting at most 6 bells counted from the end of the bell `release_bell` (the job of bell release_bell + 7 gives up); a march nobody
// revealed is then opened with `destination: "unrevealed"`. A march the brain never sent (the outcome lists no sent depart) opens at
// `release_bell` as `not_sent`.
//
// `releaseDue(bell)` writes PUB/open/<bell>.json ONCE per bell with ALL records due at that bell (the file is served immutable, section
// 8.3: it is never rewritten; a record that becomes due later in the same bell waits for the next one). The opened record carries the
// real arrival bell next to the planned one, and the destinations come from the public REVEAL, never from model text.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const WAIT_BELLS = 6;
const MARCH_INTENTS = new Set(['depart', 'march', 'recall']);

/** The marches a sealed decision intended: [{host_id, planned_arrive_bell, via, target_kind}] (one per host, in the order intended). */
export function marchesOf(priv) {
  const seen = new Set();
  const out = [];
  for (const e of priv?.intended ?? []) {
    if (e.host_id == null) continue;
    const id = String(e.host_id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ host_id: id, planned_arrive_bell: e.arrive_bell ?? null, via: e.via ?? 'model', target_kind: e.target_kind ?? null });
  }
  return out;
}

/** Did the brain send a march for this decision? true | false | null (no outcome posted yet: unknown). */
export function sentMarch(tx) {
  if (!Array.isArray(tx) || !tx.length) return null;
  return tx.some(t => MARCH_INTENTS.has(t.intent) && t.status === 'sent');
}

/**
 * The state of one sealed record at job bell `bell`. `find = {depart(hostId) -> DEPART event|null, reveal(hostId, arriveBell) -> REVEAL event|null}`.
 * Returns {ready, destinations, waited_out}: when not ready the caller tries again at the next bell.
 */
export function releaseState({ entry, bell, find, waitBells = WAIT_BELLS }) {
  const rb = entry.full.release_bell;
  const marches = marchesOf(entry.priv);
  const sent = sentMarch(entry.full.tx);
  const giveUp = bell >= rb + waitBells + 1;
  // FB5 (fix plan F1): a decision that intended two marches and had one refused by V6 has `sent === true`, and the outcome tx carries no
  // host id, so the refused march used to wait the whole 6 bells and read "unrevealed". The arithmetic that needs no host id: the
  // brain sent `sentDeparts` departs for `marches.length` intended marches, so `marches.length - sentDeparts` of them were not sent; a
  // march with no public DEPART is one of them ONLY when every march without a DEPART fits in that number (otherwise it is ambiguous
  // which one a late DEPART belongs to, and it keeps waiting). Recalls are not marches of `intended`, so they are not counted.
  const departed = new Map(marches.map(m => [m.host_id, find.depart(m.host_id)]));
  const sentDeparts = Array.isArray(entry.full.tx) ? entry.full.tx.filter(t => (t.intent === 'depart' || t.intent === 'march') && t.status === 'sent').length : null;
  const missing = marches.filter(m => !departed.get(m.host_id));
  const refusedLeft = sent === true && sentDeparts !== null ? Math.max(0, marches.length - sentDeparts) : 0;
  const unsentIds = new Set(refusedLeft > 0 && missing.length > 0 && missing.length <= refusedLeft ? missing.map(m => m.host_id) : []);
  let pending = 0;
  const destinations = marches.map(m => {
    const base = { host_id: m.host_id, planned_arrive_bell: m.planned_arrive_bell, via: m.via };
    if (sent === false || unsentIds.has(m.host_id)) return { ...base, state: 'not_sent', destination: 'not_sent', arrive_bell: null };
    const d = departed.get(m.host_id);
    const r = d ? find.reveal(m.host_id, d.arrive_bell) : null;
    if (d && r && d.arrive_bell < bell) {
      return { ...base, state: 'revealed', p: r.p, q: r.q, tile: r.tile, arrive_bell: d.arrive_bell, depart_bell: d.depart_bell, planned_arrive_bell: m.planned_arrive_bell };
    }
    pending++;
    return { ...base, state: 'pending', arrive_bell: d?.arrive_bell ?? null, depart_bell: d?.depart_bell ?? null };
  });
  if (pending && !giveUp) return { ready: false, destinations, waited_out: false };
  const out = destinations.map(x => (x.state === 'pending' ? { ...x, state: 'unrevealed', destination: 'unrevealed' } : x));
  return { ready: true, destinations: out, waited_out: pending > 0 };
}

function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * createRelease({feed, records, pubDir, stats, onOpened, onError}) -> {releaseDue(bell), indexed()}
 *   onOpened(openedRecord) is called for every record after its file is written and the record is marked opened.
 */
export function createRelease({ feed, records, pubDir, stats = {}, onOpened = () => {}, onError = () => {}, waitBells = WAIT_BELLS } = {}) {
  const dir = `${pubDir}/open`;
  const bump = (k, n = 1) => { stats[k] = (stats[k] ?? 0) + n; };
  const done = new Set(); // bells whose file was handled (written, or found on disk)

  /** the DEPART of a host that left at or after the decision's bell (the plan fixes it within a bell or two of the step) */
  const departOf = (hostId, decisionBell) => {
    for (let b = Math.max(0, decisionBell - 1); b <= decisionBell + 4; b++) {
      for (const ev of feed.events(b)) if (ev.kind === 'DEPART' && String(ev.host_id) === hostId && ev.depart_bell >= decisionBell - 1) return ev;
    }
    return null;
  };

  function listBells() {
    try {
      const j = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));
      return Array.isArray(j.bells) ? j.bells : [];
    } catch { return []; }
  }

  async function releaseDue(bell) {
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/${bell}.json`;
    if (done.has(bell)) return { bell, opened: [], repeat: true };
    done.add(bell);
    if (existsSync(file)) {
      // written by an earlier process: the file is the truth; make sure its records are marked
      try {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        for (const r of j.records ?? []) records.markOpened(r.id);
      } catch (e) { onError(e); }
      bump('open_files_found');
      return { bell, opened: [], existing: true };
    }
    const due = records.dueForRelease(bell);
    const ready = [];
    for (const id of due) {
      const entry = records.getPrivate(id);
      if (!entry) continue;
      const find = { depart: h => departOf(h, entry.bell), reveal: (h, a) => feed.revealOf(h, a) };
      let st;
      try { st = releaseState({ entry, bell, find, waitBells }); } catch (e) { bump('release_errors'); onError(e); continue; }
      if (!st.ready) { bump('release_waiting'); continue; }
      const o = records.open(id);
      if (!o) continue;
      ready.push({ id, entry, st, opened: { ...o, v: 1, kind: entry.kind, by: entry.full.mode, wake: entry.full.wake ?? [], opened_bell: bell, destinations: st.destinations } });
    }
    if (!ready.length) return { bell, opened: [] };
    ready.sort((a, b) => a.entry.index - b.entry.index || (a.entry.kind < b.entry.kind ? -1 : a.entry.kind > b.entry.kind ? 1 : 0) || (a.id < b.id ? -1 : 1));
    atomicWrite(file, JSON.stringify({ v: 1, bell, records: ready.map(r => r.opened) }));
    const bells = [...new Set([...listBells(), bell])].sort((a, b) => a - b);
    atomicWrite(`${dir}/index.json`, JSON.stringify({ v: 1, bells, latest: bell }));
    for (const r of ready) {
      records.markOpened(r.id);
      bump('records_opened');
      if (r.st.waited_out) bump('records_unrevealed');
      if (r.st.destinations.some(d => d.state === 'revealed' && d.arrive_bell !== d.planned_arrive_bell)) bump('records_arrived_off_plan');
      try { onOpened(r.opened); } catch (e) { onError(e); }
    }
    bump('open_files_written');
    return { bell, opened: ready.map(r => r.id), file };
  }

  return { releaseDue, listBells, departOf };
}
