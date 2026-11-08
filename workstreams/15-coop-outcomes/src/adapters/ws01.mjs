// ①'s request board and arrival records → evaluator events. Written against
// ①'s real code at 3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52
// (origin/preserve/ws01-coop-s1-3f3c8478): `fold()` of coop/record.mjs (the
// board's state) and `arrivalOf()` of coop/arrival.mjs (one record per linked
// caravan). The arrival records in scenarios/fixtures/ were produced by
// ①'s own `arrivalOf`/`creditedOf` (test/contract-ws01.test.mjs).
//
// From the board (`fromWs01Board`):
//   - `state.requests` is an object keyed by request id (`fold()`): `{id,
//     goalId, requester, need, to, at, expiresAt, state, links: [{responder,
//     claimedNation, caravan: {ownerTag, seq}, at, n}]}`; `at` in seconds
//   - ① already lets a caravan be linked once, in record order (`n`), and only
//     while the request is open; a link stays valid after the request is
//     cancelled or expires (the caravan still arrives). This adapter takes the
//     links as ① folded them and keeps the first by `n` should a feed repeat one
//   - quantities are not taken from the board
//
// From the arrival records (`fromWs01Arrivals`), only `source: 'chain-log'`
// counts (①: the herald's lists are for display and cross-checking):
//   delivered + verifiedQty, qtyKind 'lower-bound' (a village)  → arrival, lower bound
//   delivered, verifiedQty null (a storehouse)                  → arrival, unknown (0 … cargo + 1)
//   lost                                                        → lost
//   misdelivered (settled elsewhere)                            → lost, cause unconfirmed (no one named)
//   raided-taken / raided-burned                                → nothing reaches the project (the S1
//                                                                  records carry the raid itself)
//   moving / unknown, or any herald-only record                 → pending: no settle, nothing counted
// The caravan ids are the S1 adapter's (`cv:<ownerTag>:<seq>:<resource>`, the
// tag in decimal): feeding the same caravan from both adapters is refused as a
// repeat (conflict / already settled), never counted twice.

const SECONDS_PER_BELL = 600;

/** The board's requests as a list, whichever form `fold()` gave (object by id, or a list). */
const requestsOf = board => (Array.isArray(board?.requests) ? board.requests : Object.values(board?.requests ?? {}));

/**
 * `{events, linkResolver, rejected}` from ①'s folded board. `map.projectOf(request)`
 * → `{project, goal, structure, steward}` or null; `map.actorOf(wallet)` → actor id;
 * `map.bellOf(seconds)` → world bell.
 */
export function fromWs01Board(board, map, { stream = 'ws01' } = {}) {
  const events = [];
  const rejected = [];
  const opened = new Set();
  const byCaravan = new Map();
  let seq = 0;
  const requests = [...requestsOf(board)].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const links = [];
  for (const r of requests) {
    const p = map.projectOf(r);
    if (!p) { rejected.push({ request: r.id, why: 'no project for this goal' }); continue; }
    const steward = map.actorOf(p.steward ?? r.requester);
    if (!steward) { rejected.push({ request: r.id, why: 'requester unknown' }); continue; }
    if (!opened.has(p.project)) {
      opened.add(p.project);
      events.push({ id: `${stream}:req:${r.id}`, stream, seq: seq++, at: map.bellOf(r.at), kind: 'project.open', verified: 'chain',
        project: p.project, goal: p.goal, structure: p.structure, steward, ...(r.expiresAt ? { deadline: map.bellOf(r.expiresAt) } : {}), src: { request: r.id } });
    }
    for (const l of r.links ?? []) links.push({ l, r, p, steward });
  }
  // ①'s record order (`n`) decides; the link time and request break ties for feeds without `n`.
  links.sort((x, y) => (x.l.n ?? Infinity) - (y.l.n ?? Infinity) || x.l.at - y.l.at || x.r.at - y.r.at || (x.r.id < y.r.id ? -1 : x.r.id > y.r.id ? 1 : 0));
  for (const { l, r, p, steward } of links) {
    const key = `${l.caravan.ownerTag}:${l.caravan.seq}`;
    if (byCaravan.has(key)) { rejected.push({ request: r.id, caravan: key, why: 'duplicateOf', of: byCaravan.get(key).request }); continue; }
    byCaravan.set(key, { request: r.id, project: p.project, steward, responder: map.actorOf(l.responder) });
  }
  /** For s1-chain.mjs: a caravan linked to a request goes to that request's project. */
  const linkResolver = (fallback = () => null) => (place, ownerTag, s) => {
    const hit = byCaravan.get(`${ownerTag}:${s}`);
    if (!hit) return fallback(place, ownerTag, s);
    // ①: requests name a village (kind 1); arrivals there count the logged cargo as a lower bound.
    return { actor: hit.steward, project: hit.project, kind: place.kind === 2 ? 'storehouse' : 'village' };
  };
  return { events, linkResolver, rejected, links: byCaravan };
}

/**
 * Events from ①'s arrival records (`arrivalOf`). `links` is fromWs01Board's
 * (caravan → project); `map.bellOfArrival(record)` gives the bell the record
 * settled at (①'s record carries a signature, not a time); `map.actorOf`.
 * The sender's stock is not in ①'s records: the send enters the cargo
 * `fromOutside`.
 */
export function fromWs01Arrivals(arrivals, links, map, { stream = 'ws01-arrival' } = {}) {
  const events = [];
  const pending = [];
  let seq = 0;
  const sorted = [...arrivals].sort((a, b) => (`${a.caravanId.ownerTag}:${a.caravanId.seq}` < `${b.caravanId.ownerTag}:${b.caravanId.seq}` ? -1 : 1));
  for (const a of sorted) {
    const key = `${a.caravanId.ownerTag}:${a.caravanId.seq}`;
    const link = links.get(key);
    if (!link || a.source !== 'chain-log' || !['delivered', 'lost', 'misdelivered'].includes(a.state) || !a.cargo) {
      pending.push({ caravan: key, state: a.state, source: a.source, why: !link ? 'not linked' : a.source !== 'chain-log' ? 'herald only: not counted' : 'nothing reaches the project' });
      continue;
    }
    const s = seq++;
    let sub = 0;
    const at = map.bellOfArrival(a);
    const from = map.actorOf(a.responder);
    const emit = (kind, fields, verified, dt = 0) => events.push({ id: `${stream}:${s}:${sub}`, stream, seq: s, sub: sub++, at: at + dt, kind, verified, ...fields, src: { caravan: key, state: a.state } });
    for (const [res, cargo] of Object.entries(a.cargo).sort()) {
      if (!cargo) continue;
      const ship = `cv:${a.caravanId.ownerTag}:${a.caravanId.seq}:${res}`;
      emit('ship.send', { ship, from, to: `project:${link.project}`, resource: res, qty: cargo, fromOutside: true }, 'chain');
      if (a.state === 'lost') emit('ship.lost', { ship }, 'chain');
      else if (a.state === 'misdelivered') emit('ship.lost', { ship, cause: 'unconfirmed' }, 'chain');
      else if (a.verifiedQty && a.qtyKind === 'lower-bound') emit('ship.arrive', { ship, qty: a.verifiedQty[res] ?? 0, qtyKind: 'lower_bound' }, 'chain_lower_bound');
      else emit('ship.arrive', { ship, qty: cargo, qtyKind: 'unknown' }, 'unverified');
    }
  }
  return { events, pending };
}

/** ①'s request times are seconds; with a known season start they map to bells (600 s each). */
export const bellOfSeconds = genesis => t => Math.floor((t - genesis) / SECONDS_PER_BELL);
