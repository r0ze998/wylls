// The sealed set (contract section 5.6): every target of a chosen march candidate and of an autopilot
// departure that was sent (confirmed by /v1/outcome), with its arrival bell, plus the nation's live Call
// target until S + 2. It is never rendered into a prompt after the step that chose it, and V5 / V5b
// refuse its coordinates, handles and names in any text. An entry leaves the set at the earlier of
//   (a) the moment its target is public on the chain (the REVEAL or CLASH of its arrival), and
//   (b) the release of its decision (section 7.2);
// a Strike Order target leaves at S + 2, or at (a) for a member's own army, whichever is first.
// Persisted under STATE/sealed/<tag>.json (private to the citizens service).
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export function createSealedSets({ stateDir }) {
  const dir = `${stateDir}/sealed`;
  mkdirSync(dir, { recursive: true });
  const mem = new Map();
  const file = (tag) => `${dir}/${/^[0-9a-f]{16}$/.test(tag) ? tag : 'bad'}.json`;
  const load = (tag) => {
    if (mem.has(tag)) return mem.get(tag);
    let v = [];
    try {
      if (existsSync(file(tag))) v = JSON.parse(readFileSync(file(tag), 'utf8'));
    } catch {
      v = [];
    }
    mem.set(tag, v);
    return v;
  };
  const save = (tag) => {
    if (!/^[0-9a-f]{16}$/.test(tag)) return;
    const tmp = `${file(tag)}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(mem.get(tag) ?? []));
    renameSync(tmp, file(tag));
  };
  return {
    list: (tag) => [...load(tag)],
    /** entry: {decision_id, host_id?, arrive_bell, pq:[p,q], tile?, nations:[f..], names:[...], troops?, distance?, target_kind?, via?, until_bell?} */
    add(tag, entries) {
      const l = load(tag);
      for (const e of entries) {
        const k = `${e.decision_id}:${e.host_id ?? ''}:${e.pq?.join(',')}:${e.via ?? ''}`;
        if (!l.some((x) => `${x.decision_id}:${x.host_id ?? ''}:${x.pq?.join(',')}:${x.via ?? ''}` === k)) l.push(e);
      }
      save(tag);
    },
    /**
     * Drop entries that are public or released. isPublic(entry) -> bool (feed REVEAL/CLASH), isReleased(decision_id) -> bool,
     * bell for Strike Order expiry (until_bell). Returns the number dropped.
     */
    prune(tag, { bell, isPublic = () => false, isReleased = () => false }) {
      const l = load(tag);
      const keep = l.filter((e) => {
        if (e.until_bell != null && bell >= e.until_bell) return false;
        if (isReleased(e.decision_id)) return false;
        if (isPublic(e)) return false;
        return true;
      });
      const n = l.length - keep.length;
      if (n) {
        mem.set(tag, keep);
        save(tag);
      }
      return n;
    },
    /** the live Call target for a member: replaced each step from memberView, so it never goes stale */
    setCall(tag, entry) {
      const l = load(tag).filter((e) => e.via !== 'call');
      if (entry) l.push(entry);
      mem.set(tag, l);
      save(tag);
    },
  };
}
