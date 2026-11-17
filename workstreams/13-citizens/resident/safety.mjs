// Checks against residents working the world together in ways a person
// could not, all read from public facts (the board and the world's events):
//
//   gift cycles      goods given without return that come back round (A→B→A, A→B→C→A)
//   sibling flows    transfers between residents of one owner (the owner tells each its siblings)
//   wash pairs       the same goods sent both ways between two parties within a window
//   echo threads     replies that answer replies (the board refuses them; the audit counts them)
//
// `wouldCloseGiftCycle` is what a resident checks before giving; `audit` is
// what an operator runs over a whole world (it reads every charter, which a
// resident never does).

export const GIFT_WINDOW_BELLS = 144;

/** Gift edges (giver → receiver) from fulfilled requests that promised nothing back, within the window. */
export function giftEdges(requests, bell, window = GIFT_WINDOW_BELLS) {
  return requests
    .filter(r => r.status === 'fulfilled' && Object.keys(r.offer).length === 0 && r.deliveredBell >= bell - window)
    .map(r => ({ from: r.by, to: r.from, bell: r.deliveredBell, request: r.id }));
}

/** True when a gift from `giver` to `receiver` would close a cycle of gifts in the window. */
export function wouldCloseGiftCycle(requests, bell, giver, receiver, window = GIFT_WINDOW_BELLS) {
  const edges = giftEdges(requests, bell, window);
  const seen = new Set([receiver]);
  const stack = [receiver];
  while (stack.length) {
    const at = stack.pop();
    for (const e of edges) if (e.from === at && !seen.has(e.to)) {
      if (e.to === giver) return true;
      seen.add(e.to); stack.push(e.to);
    }
  }
  return false;
}

/** Simple cycles in a directed edge list (up to length 4), each reported once. */
function cyclesOf(edges) {
  const out = new Set();
  const adj = new Map();
  for (const e of edges) { if (!adj.has(e.from)) adj.set(e.from, new Set()); adj.get(e.from).add(e.to); }
  const walk = (start, at, path) => {
    for (const nx of adj.get(at) ?? []) {
      if (nx === start && path.length >= 2) { const rot = [...path]; const i = rot.indexOf([...rot].sort()[0]); out.add([...rot.slice(i), ...rot.slice(0, i)].join('→')); }
      else if (!path.includes(nx) && path.length < 4) walk(start, nx, [...path, nx]);
    }
  };
  for (const s of adj.keys()) walk(s, s, [s]);
  return [...out];
}

/**
 * The operator's audit of a world. `charters` maps citizen → {owner} for
 * the residents (people have none). Returns findings; an empty list is a
 * clean run, not a proof of good conduct.
 */
export function audit({ events, requests, replies, charters = {}, window = GIFT_WINDOW_BELLS }) {
  const findings = [];
  const lastBell = events.length ? events[events.length - 1].bell : 0;
  for (const c of cyclesOf(giftEdges(requests, lastBell, Infinity))) findings.push({ kind: 'gift-cycle', cycle: c });
  const arrived = events.filter(e => e.kind === 'CaravanArrived');
  const sib = {};
  for (const e of arrived) {
    const a = charters[e.src]?.owner, b = charters[e.dst]?.owner;
    if (a && a === b) {
      const k = `${e.src}→${e.dst}`;
      sib[k] = sib[k] ?? {};
      for (const [n, v] of Object.entries(e.goods)) sib[k][n] = (sib[k][n] ?? 0) + v;
    }
  }
  for (const [pair, goods] of Object.entries(sib)) findings.push({ kind: 'sibling-flow', pair, goods });
  for (let i = 0; i < arrived.length; i++) for (let j = i + 1; j < arrived.length; j++) {
    const a = arrived[i], b = arrived[j];
    if (a.src === b.dst && a.dst === b.src && b.bell - a.bell <= window && JSON.stringify(a.goods) === JSON.stringify(b.goods)) findings.push({ kind: 'wash-pair', caravans: [a.caravan, b.caravan] });
  }
  // The same send twice in a row (same sender, destination and goods within two bells): what a retried or restarted
  // loop without idempotency leaves behind. Two honest sends can look like this too; the finding is a lead, not a verdict.
  const departs = events.filter(e => e.kind === 'CaravanDeparted');
  for (let i = 0; i < departs.length; i++) for (let j = i + 1; j < departs.length; j++) {
    const a = departs[i], b = departs[j];
    if (a.src === b.src && a.dst === b.dst && b.bell - a.bell <= 2 && JSON.stringify(a.goods) === JSON.stringify(b.goods)) findings.push({ kind: 'possible-duplicate-send', caravans: [a.caravan, b.caravan] });
  }
  const byReq = new Map();
  for (const r of replies) { const k = `${r.re}|${r.from}`; if (byReq.has(k)) findings.push({ kind: 'repeat-reply', key: k }); byReq.set(k, r); }
  return findings;
}
