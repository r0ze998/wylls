// The record checks that run before any rule: shape, duplicates and
// conflicts by id, gaps in each stream's positions, and one canonical order.
// The output does not depend on the order or repetition of the input.
import { canonical } from './canon.mjs';
import { shapeProblems } from './contract.mjs';

/** The canonical order: bell, then stream, then position, then id. */
export const byOrder = (a, b) =>
  a.at - b.at || (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : 0) || a.seq - b.seq || (a.sub ?? 0) - (b.sub ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * `{events, notes, taint}`: the well-formed, unique, conflict-free events in
 * canonical order; what was set aside and why; and for each stream with a
 * gap, the first missing position (an event of that stream at or after it
 * may stand on a fact the evaluator never saw).
 */
export function normalize(events = [], streams = {}) {
  const notes = { duplicates: [], conflicts: [], rejected: [], gaps: [], inputInversions: 0 };
  const byId = new Map();
  const conflicted = new Set();
  for (const e of events) {
    const bad = shapeProblems(e);
    if (bad.length) { notes.rejected.push({ id: e?.id ?? null, code: bad[0] }); continue; }
    const text = canonical(e);
    const seen = byId.get(e.id);
    if (!seen) byId.set(e.id, { e, text });
    else if (seen.text === text) notes.duplicates.push(e.id);
    else conflicted.add(e.id);
  }
  for (const id of conflicted) { byId.delete(id); notes.conflicts.push(id); }
  // A conflicted id leaves a hole at its position, like a missing record.
  const holes = new Map();
  for (const e of events) {
    if (e && conflicted.has(e.id) && !shapeProblems(e).length) {
      if (!holes.has(e.stream)) holes.set(e.stream, new Set());
      holes.get(e.stream).add(e.seq);
    }
  }
  const list = [...byId.values()].map(v => v.e);
  // Two different ids at one position of a stream: the stream contradicts itself.
  const pos = new Map();
  for (const e of list) {
    // `sub` numbers several events an adapter derives from one source record (one per resource).
    const k = `${e.stream}\u0000${e.seq}\u0000${e.sub ?? 0}`;
    if (!pos.has(k)) pos.set(k, []);
    pos.get(k).push(e);
  }
  const kept = [];
  for (const group of pos.values()) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    for (const e of group) notes.conflicts.push(e.id);
    if (!holes.has(group[0].stream)) holes.set(group[0].stream, new Set());
    holes.get(group[0].stream).add(group[0].seq);
  }
  // Gaps per stream (missing positions, and holes left by conflicts).
  const taint = {};
  const names = new Set([...kept.map(e => e.stream), ...Object.keys(streams), ...holes.keys()]);
  for (const s of [...names].sort()) {
    const seqs = new Set(kept.filter(e => e.stream === s).map(e => e.seq));
    const from = streams[s]?.from ?? 0;
    const max = Math.max(from - 1, ...seqs, ...(holes.get(s) ?? []));
    const through = streams[s]?.through ?? max;
    const missing = [];
    for (let i = from; i <= Math.max(max, through); i++) if (!seqs.has(i)) missing.push(i);
    if (missing.length) {
      notes.gaps.push({ stream: s, missing: compress(missing) });
      taint[s] = missing[0];
    }
  }
  // How far the input was from the canonical order (information only).
  const order = events.filter(e => e && byId.get(e.id)?.e === e);
  for (let i = 1; i < order.length; i++) if (byOrder(order[i - 1], order[i]) > 0) notes.inputInversions++;
  kept.sort(byOrder);
  for (const k of ['duplicates', 'conflicts']) notes[k] = [...new Set(notes[k])].sort();
  notes.rejected.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { events: kept, notes, taint };
}

/** `[3,4,5,9]` → `['3-5','9']`. */
function compress(xs) {
  const out = [];
  for (let i = 0; i < xs.length;) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? `${xs[i]}` : `${xs[i]}-${xs[j]}`);
    i = j + 1;
  }
  return out;
}

/** Whether event `e` may stand on a record the evaluator never saw. */
export const tainted = (taint, e) => e.stream in taint && e.seq > taint[e.stream];
