// AC6: PUB/events/latest.json (contract section 8.3): the departures and clashes of the last bells with actor tags and kind/ai flags, for
// the council page's panel. Built from the herald's public records only (the feed's normalised DEPART, REVEAL and CLASH rows and the
// clash reports): nothing the mind holds, so nothing sealed can leak through it. A departure shows no destination until its REVEAL is
// public, as on the chain.
//
//   {v:1, bell, from_bell, events:[
//     {kind:"depart", bell, host_id, arrive_bell, mass, origin:{p,q}, actor:{tag, kind, ai, faction, name}, destination:null|{p,q,tile}},
//     {kind:"clash", bell (the clash bell), log_bell, p, q, engagements, arrivals, actors:[{tag, kind, ai, faction, name, arrived, engaged, fate, lost}]}
//   ]}
//
// `kind` of an actor is the roster badge: "ai" | "seat" | "script" | null (a citizen no list names: a human or unknown); `ai` is
// `kind === "ai"` (the badge comes from the roster only, never from who signed). Newest first, at most `cap` events, the last `window`
// bells. Troops are whole troops (the chain counts milli-troops).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const WINDOW_BELLS = 72;
export const CAP = 150;
const MILLI = 1000;

export function createEventsPub({ feed, roster, nameOf, pubDir, window = WINDOW_BELLS, cap = CAP, onError = () => {} } = {}) {
  const dir = `${pubDir}/events`;
  let last = null;

  const badge = tag => {
    if (!tag) return null;
    const k = feed.kindOfTag?.(tag) ?? null;
    if (k) return k;
    if (roster.byTag?.(tag)) return 'ai';
    if (roster.seat?.tag === tag) return 'seat';
    return null;
  };
  const actorOf = tag => ({
    tag, kind: badge(tag), ai: badge(tag) === 'ai', faction: feed.owners?.factionOfTag?.(tag) ?? null,
    name: tag ? nameOf(tag) : null,
  });

  async function build(bell) {
    const from = Math.max(0, bell - window);
    const events = [];
    for (let b = from; b <= bell; b++) {
      for (const ev of feed.events(b)) {
        if (ev.kind === 'DEPART') {
          const tag = feed.owners?.citizenOfHost?.(ev.host_id) ?? null;
          const rv = feed.revealOf?.(ev.host_id, ev.arrive_bell) ?? null;
          events.push({
            kind: 'depart', bell: ev.depart_bell ?? ev.bell, sort: ev.bell, seq: ev.seq, host_id: String(ev.host_id), arrive_bell: ev.arrive_bell,
            mass: Math.floor(Number(ev.dep_mass) / MILLI), origin: { p: ev.origin_p, q: ev.origin_q }, actor: actorOf(tag),
            destination: rv ? { p: rv.p, q: rv.q, tile: rv.tile } : null,
          });
        } else if (ev.kind === 'CLASH' && ev.real) {
          let rep = null;
          try { rep = await feed.clashAt(ev.p, ev.q, ev.clash_bell); } catch (e) { onError(e); }
          const byTag = new Map();
          for (const f of rep?.fighters ?? []) {
            if (!f.owner) continue;
            const a = byTag.get(f.owner) ?? { ...actorOf(f.owner), arrived: false, engaged: false, fate: f.fate, troops_after: 0 };
            a.arrived ||= Boolean(f.arrival);
            a.engaged ||= Boolean(f.engaged);
            if (f.engaged || f.arrival) a.fate = f.fate;
            a.troops_after += Math.floor(Number(f.troops) / MILLI);
            byTag.set(f.owner, a);
          }
          // only the actors that took part: arrived or engaged (residents that merely stood in the province are not listed)
          events.push({
            kind: 'clash', bell: ev.clash_bell, log_bell: ev.bell, sort: ev.bell, seq: ev.seq, p: ev.p, q: ev.q, engagements: ev.engagements, arrivals: ev.arrivals,
            actors: [...byTag.values()].filter(a => a.arrived || a.engaged).sort((a, b) => (a.tag < b.tag ? -1 : 1)),
          });
        }
      }
    }
    events.sort((a, b) => b.sort - a.sort || (BigInt(b.seq) < BigInt(a.seq) ? -1 : 1));
    return { v: 1, bell, from_bell: from, events: events.slice(0, cap).map(({ sort, seq, ...e }) => e) };
  }

  /** Rebuild and write PUB/events/latest.json when its content (the bell aside) changed. Returns true when written. */
  async function update(bell) {
    const body = await build(bell);
    const sig = createHash('sha256').update(JSON.stringify(body.events)).digest('hex');
    if (sig === last && existsSync(`${dir}/latest.json`)) return false;
    last = sig;
    mkdirSync(dir, { recursive: true });
    const tmp = `${dir}/latest.json.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, `${dir}/latest.json`);
    return true;
  }

  return { update, build, read: () => { try { return JSON.parse(readFileSync(`${dir}/latest.json`, 'utf8')); } catch { return null; } } };
}
