// ①'s request board → evaluator events. Written from ①'s contract as relayed
// (workstreams/01-national-strategy/coop/record.mjs `fold()` and
// arrival.mjs, branch ws/01-coop-s1 @ 3f3c8478b0a37a7ecfd6ca4641b8d47fb58aff52);
// ①'s files were not in this checkout, so the field names below are the
// relayed ones and this adapter is checked only against synthetic folds.
//
// Division of labour, so that no caravan is counted twice:
//   - ① says which request a caravan serves (a signed `link`), and what a
//     request is for (`goalId`, `need`, the requester's village);
//   - the quantities come from the chain records (s1-chain.mjs), never from
//     ①'s arrival view. `linkResolver` turns ①'s links into the
//     `destination` the S1 adapter asks for.
//
// A request becomes a project when `projectOf(request)` names one: several
// requests (one per resource, or per helper) may feed one project.

/** ①'s request states that still accept caravans. */
const OPEN = new Set(['open', 'accepted']);

/**
 * `{events, linkResolver, rejected}` from a folded board
 * (`{requests: [{id, goalId, requester, need, to, at, expiresAt, state, links: [{responder, caravan: {ownerTag, seq}, at}]}]}`).
 * `map.projectOf(request)` → `{project, goal, structure, steward}` or null;
 * `map.actorOf(signer)` → actor id; `map.bellOf(at)` → bell.
 */
export function fromWs01Board(board, map, { stream = 'ws01' } = {}) {
  const events = [];
  const rejected = [];
  const opened = new Set();
  const byCaravan = new Map();
  let seq = 0;
  const requests = [...(board.requests ?? [])].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
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
    // ①: the first link of a caravan wins; later ones are duplicates (allocate()).
    for (const l of [...(r.links ?? [])].sort((a, b) => a.at - b.at)) {
      const key = `${l.caravan.ownerTag}:${l.caravan.seq}`;
      if (byCaravan.has(key)) { rejected.push({ request: r.id, caravan: key, why: 'duplicateOf', of: byCaravan.get(key).request }); continue; }
      if (!OPEN.has(r.state) && r.state !== undefined) { rejected.push({ request: r.id, caravan: key, why: `request ${r.state}` }); continue; }
      byCaravan.set(key, { request: r.id, project: p.project, steward, responder: map.actorOf(l.responder) });
    }
  }
  /** For s1-chain.mjs: a caravan linked to a request goes to that request's project. */
  const linkResolver = (fallback = () => null) => (place, ownerTag, s) => {
    const hit = byCaravan.get(`${ownerTag}:${s}`);
    if (!hit) return fallback(place, ownerTag, s);
    // ①: requests name a village (kind 1); arrivals there count the logged cargo as a lower bound.
    return { actor: hit.steward, project: hit.project, kind: place.kind === 2 ? 'storehouse' : 'village' };
  };
  return { events, linkResolver, rejected };
}
