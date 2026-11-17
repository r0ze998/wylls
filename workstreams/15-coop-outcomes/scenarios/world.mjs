// The small fixed world every scenario starts from, and a builder that
// numbers events per stream. Six nations as in S1 (decided: six, fixed);
// sizes differ on purpose (n0 large … n5 one member). One period of 480
// bells, as the recorded S1 season run (docs/frontier/stage1f/S1-SEASON-RUN.md).

export const NATIONS = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
const SIZES = { n0: 6, n1: 4, n2: 3, n3: 3, n4: 2, n5: 1 };
/** Each member's starting goods (per resource; never summed). */
const STOCK = { food: 400, wood: 400, stone: 500, ore: 200, arms: 40, gold: 150 };
/** Keeps at the start: n0 4, n1 3, n2 2, n3 2, n4 1, n5 0. */
const KEEPS = { n0: 4, n1: 3, n2: 2, n3: 2, n4: 1, n5: 0 };

export function baseState({ endsAt = 480, extraActors = [], optionsAt } = {}) {
  const actors = [];
  for (const n of NATIONS) for (let i = 0; i < SIZES[n]; i++) actors.push({ id: `${n}-${i}`, nation: n, kind: 'human' });
  actors.push(...extraActors);
  const lots = [];
  for (const a of actors) {
    if (a.stock === false) continue;
    for (const [r, q] of Object.entries(a.stock ?? STOCK)) lots.push({ lot: `init:${a.id}:${r}`, owner: a.id, resource: r, qty: q, verified: 'chain' });
  }
  const keeps = [];
  let k = 0;
  for (const n of NATIONS) for (let i = 0; i < KEEPS[n]; i++) keeps.push({ keep: `k${k++}`, nation: n });
  for (const a of actors) { delete a.stock; }
  return {
    world: { id: 'ws15-model-world' },
    period: { id: 'P1', opensAt: 0, endsAt, ...(optionsAt === undefined ? {} : { optionsAt }) },
    nations: NATIONS, actors, lots, keeps,
    streams: { chain: { from: 0 }, ws01: { from: 0 } },
  };
}

/** Collects events, numbering each stream from 0 in the order they are added. */
export class Script {
  constructor() { this.events = []; this.next = {}; }
  add(at, kind, fields, { stream = 'chain', verified = 'chain', id } = {}) {
    const seq = this.next[stream] ?? 0;
    this.next[stream] = seq + 1;
    this.events.push({ id: id ?? `${stream}:${seq}`, stream, seq, at, kind, verified, ...fields });
    return this;
  }
  /** A caravan sent at `at` and arriving `travel` bells later. */
  ship(at, ship, from, to, resource, qty, { travel = 10, arrive = qty, verified = 'chain', lot } = {}) {
    this.add(at, 'ship.send', { ship, from, to, resource, qty, ...(lot === undefined ? {} : { lot }) });
    if (arrive !== null) this.add(at + travel, 'ship.arrive', { ship, qty: arrive }, { verified });
    return this;
  }
  /** `actor` puts `qty` of lot `lot` into `project` (①'s board would record this). */
  give(at, project, actor, lot, qty, opts = {}) { return this.add(at, 'contribute', { project, actor, lot, qty }, { stream: 'ws01', ...opts }); }
}

export const init = (actor, r) => `init:${actor}:${r}`;
