// Whether a READ-ONLY resident can be assembled from what is supplied, and why not (2026-11-17). It never constructs
// a Resident, never writes a file, never makes a key and calls no port: it reads the ports object and answers.
//
// Why it exists: no production assembly of a resident is in this tree. The only constructor call is
// world/harness.mjs openResident, a TEST world on its own clock (MOCK_WORLD / MOCK_CLOCK), and the gateway's operator
// agent runner is another program. A resident that reads the live observation (ports/live-canonical.mjs) would need
// every port below; each one Resident uses is listed with the line that uses it and what it does. A read-only
// assembly refuses every port whose use signs, sends, joins, spends or calls a model, and refuses any port that is
// required and not supplied. A port that only pretends (a stub that refuses everything) is not accepted as the real
// one: it is refused by the same rule, so a refusing stub never turns into "assembled".
//
// With today's contracts the answer is always `assembled: false`: Resident#step has no read-only path. The reasons are
// the dependencies (see REQUIREMENTS[].effect), not something this module can lift.

/**
 * What Resident (resident.mjs, this tree) needs, from its source. `effect`: what using it does.
 *   read         reads only
 *   local-write  writes the resident's own files (charter.json, state.json, decisions.jsonl, its ledger)
 *   key          makes or reads a private key
 *   sign         signs a record with the resident's key
 *   join         asks the world to make a citizen (an act in the world)
 *   spend        holds or charges the resident's budget (its agent ledger, and a cost ledger when supplied)
 *   model        sends the decision request to a model provider
 *   send         submits, checks or cancels actions in the world (an execution service)
 *   post         posts to the public board
 */
export const REQUIREMENTS = Object.freeze([
  { port: 'dir', at: 'constructor: readFileSync(charter.json); createStateStore(state.json); AgentLedger over it', effect: 'local-write', required: true },
  { port: 'identity', at: 'constructor: identity, else keyIdentity over loadOrCreateKey on resident.key', effect: 'key', required: true,
    note: 'without one the constructor makes and saves a key; keylessIdentity is a test identity (label "ws13-test:…")' },
  { port: 'execution', at: 'step: assertPort(execution) (submit/status/cancel, retentionBells); #enact submit; #reconcile status/cancel', effect: 'send', required: true },
  { port: 'observe', at: 'step: ports.observe(address, {events, boardBell}) -> {world: {bell, villages, …}, board}', effect: 'read', required: true,
    note: "the only implementation is world/harness.mjs portsFor (the test world's view); no live adapter exists, and no contract maps the herald to this shape" },
  { port: 'join', at: 'step: ports.join({body, sig: identity.sign(JOIN_DOMAIN, body)}) when no village is found', effect: 'join', required: true },
  { port: 'memory', at: 'step/#learn/#request: ports.memory.all/append/recall', effect: 'local-write', required: true },
  { port: 'board', at: '#enact: ports.board.post(body)', effect: 'post', required: true },
  { port: 'provider', at: '#decide: decideWithin(ports.provider, req) after ledger.hold(inference)', effect: 'model', required: true },
  { port: 'cost', at: '#decide: (ports.cost ?? flatCost(pricePerCall)).quote/reserve/settle', effect: 'spend', required: false, note: 'absent: a flat price is held and charged in the agent ledger' },
  { port: 'fallback', at: '#decide: ports.fallback(candidates) when no provider answer', effect: 'read', required: true },
  { port: 'evidence', at: '#publicEvidence: ports.evidence.read({counterparty, worldBell}), clock and world checked first', effect: 'read', required: false },
]);
const NOT_READ_ONLY = new Set(['key', 'sign', 'join', 'spend', 'model', 'send', 'post', 'local-write']);

/**
 * {assembled: false, constructed: false, refused: [{port, why}], supplied: [...], evidence} for the supplied
 * `{dir, identity, ports}`. `evidence` reports, without reading it, what a resident would do with ports.evidence:
 * its world, clock and basis, and the observation's held count; `reachesResident: false` because no resident is made.
 */
export function readOnlyResidentPreflight({ dir = null, identity = null, ports = {} } = {}) {
  const supplied = { dir, identity, ...ports };
  const has = p => supplied[p] !== null && supplied[p] !== undefined;
  const refused = [];
  for (const r of REQUIREMENTS) {
    if (r.effect === 'read') {
      if (r.required && !has(r.port)) refused.push({ port: r.port, why: `required and not supplied (${r.at})${r.note ? `; ${r.note}` : ''}` });
      continue;
    }
    if (NOT_READ_ONLY.has(r.effect) && (r.required || has(r.port))) {
      refused.push({ port: r.port, why: `${r.effect}: not read-only (${r.at})${has(r.port) ? '; supplied, refused all the same' : r.required ? '; required' : ''}${r.note ? `; ${r.note}` : ''}` });
    }
  }
  // The observe port a test harness gives (its world and clock are the test world's) is not a live observe port.
  const ob = ports.observe;
  if (has('observe') && (ob.world?.world_id === null || ob.clock?.kind === 'mock-world')) refused.push({ port: 'observe', why: "the test world's observe port (MOCK_WORLD / MOCK_CLOCK), not a live one" });
  const ev = ports.evidence;
  const evidence = ev ? Object.freeze({
    kind: ev.kind ?? null, world: ev.world ?? null, clock: ev.clock ?? null, basis: ev.basis ?? 'unstated',
    observation: ev.observation ? { status: ev.observation.status, held: ev.observation.held, ws04: ev.observation.ws04 ? { status: ev.observation.ws04.status, observations: ev.observation.ws04.observations } : null } : null,
    actsOn: ev.basis === 'chain', reachesResident: false,
  }) : null;
  return Object.freeze({ assembled: false, constructed: false, refused: Object.freeze(refused), supplied: Object.freeze(Object.keys(supplied).filter(has)), evidence });
}
