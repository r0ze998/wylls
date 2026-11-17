// The resident's observation shape (resident.mjs ports.observe → {world, board}), from the live, partial observation
// (observe.mjs) (2026-11-17). Only what a real read grounds is filled; every other field the resident's consumers read
// is listed as missing, with the consumer and why. The result is never "complete" today, so it is never handed to the
// resident as if it were: residentObservePort answers by throwing, before anything else the resident would do.
//
// Why not just call Resident: its constructor may make a key, create the ledger record and save; its step observes and,
// with no village found, joins BEFORE it looks at its stop. The live path (step.mjs) keeps the stop first and never
// enacts. This module only projects and declares; it constructs nothing, joins nothing, signs and sends nothing.
//
// What the resident's consumers read (resident.mjs step/#learn/#duties/#settleReturns/#noteDebts/#wakes/#decide,
// candidates.mjs buildCandidates, safety.mjs), and what the live read gives:
export const RESIDENT_NEEDS = Object.freeze([
  { field: 'world.bell', by: 'step (cursors, the gift window), every bell-based rule', live: 'herald /h/season latestUnix through the Season clock (informational, not finality)' },
  { field: 'world.villages[].{citizen, owner}', by: 'step (the address map, finding its own village before join), #migrate (aliases), #who', live: 'its own Citizen only (herald /h/me); no world-wide list' },
  { field: 'world.villages[].stores', by: 'candidates.mjs (who can supply a request, what it can give)', live: 'not mapped: a Citizen has several S1 villages; the test world has one per citizen' },
  { field: 'world.villages[].{buildings, building, tier, cap, pos}', by: 'candidates.mjs, goals.mjs (build choices, distance)', live: 'not mapped: the test world\'s one-dimensional position and items' },
  { field: 'world.caravans', by: '#settleReturns, #noteDebts, candidates.mjs (goods on the road)', live: 'not read' },
  { field: 'world.events', by: 'step (event cursor), #learn (trust, raids, broken promises)', live: 'not mapped from the herald\'s program records' },
  { field: 'world.me.quota.{bucket, relayLeft, lamportsLeft}', by: 'candidates.mjs (whether an action or a caravan is possible today)', live: 'not mapped (herald /h/me has a quota of another shape)' },
  { field: 'world.me.pending', by: 'the resident\'s in-flight checks', live: 'not read' },
  { field: 'board.requests[].{id, from, to, want, offer, openTo, deadlineBell, status, returned, by}', by: 'step, #duties, #noteDebts, #wakes, candidates.mjs', live: 'not mapped: workstream 1\'s requests (need, a destination village, expiresAt, goalId, responses) are another schema; no payment offer, no open-to, no return' },
  { field: 'board.replies[].{re, from, decision}', by: 'candidates.mjs, #learn', live: 'not mapped: workstream 1\'s responses (accept with an offer, decline, withdrawn) are another schema' },
]);

/** The error the resident's observe port throws: the observation cannot be given in the resident's shape. */
export class ResidentObservationIncomplete extends Error {
  constructor(missing, view) { super(`the live observation does not give the resident's shape: ${missing.map(m => m.field).join(', ')}`); this.code = 'ResidentObservationIncomplete'; this.missing = missing; this.view = view; }
}

/**
 * The grounded part of the resident's shape, from one live observation, and what is missing.
 * → {complete: false, view: {world: {bell|null, villages: [own], …}, board: null}, missing: [{field, by, why}]}
 * Nothing missing is filled with an empty list or a guess.
 */
export function residentObservationOf(obs, { wallet }) {
  const missing = [];
  const world = { bell: null, villages: [] };
  if (obs?.kind !== 'live-partial') return { complete: false, view: null, missing: [{ field: '*', by: 'everything', why: 'not a live observation' }] };
  if (Number.isSafeInteger(obs.bell) && obs.bellBasis) world.bell = obs.bell;
  else missing.push({ field: 'world.bell', by: RESIDENT_NEEDS[0].by, why: obs.unknown?.find(u => u.what === 'bell')?.why ?? 'no herald time' });
  if (obs.self?.status === 'ok' && typeof wallet === 'string' && wallet) world.villages = [{ citizen: obs.self.citizen, owner: wallet, places: obs.self.holdings.map(h => h.place) }];
  else missing.push({ field: 'world.villages[] (own)', by: RESIDENT_NEEDS[1].by, why: obs.self?.why ?? 'own villages not read' });
  for (const n of RESIDENT_NEEDS.slice(1)) missing.push({ field: n.field, by: n.by, why: n.live });
  return { complete: false, view: { world, board: null }, missing };
}

/**
 * The world and clock an observe port declares (resident.mjs #provenance reads them), from one /h/season read:
 * workstream 12's worldFromSeason and frame.mjs seasonClock, injected. → {world, clock} | {world: null, why}
 */
export async function observeDeclaration({ herald, worldFromSeason, seasonClock }) {
  let s;
  try { s = await herald.get('/h/season'); } catch (e) { return { world: null, clock: null, why: `herald /h/season: ${String(e?.message ?? e).slice(0, 60)}` }; }
  if (!(s?.status >= 200 && s.status < 300 && s.json)) return { world: null, clock: null, why: `herald /h/season: http_${s?.status ?? '?'}` };
  try {
    const w = worldFromSeason(s.json);
    if (!w.world) return { world: null, clock: null, why: (w.reasons ?? []).join(',') || 'not a continuous world' };
    return { world: Object.freeze({ ...w.world }), clock: seasonClock({ genesisTs: w.clock.genesisTs, bellSecs: w.clock.bellSecs, source: w.clock.source }) };
  } catch (e) { return { world: null, clock: null, why: `herald /h/season malformed: ${String(e?.message ?? e).slice(0, 60)}` }; }
}

/**
 * An observe port in the resident's port form: an async function (address, since) with the declared `world` and
 * `clock` attached (as world/harness.mjs portsFor does for the test world). Each call reads the live observation
 * and THROWS ResidentObservationIncomplete with the grounded view and the missing fields, so a resident given this
 * port stops at its first line (observe) and never joins, decides or sends on a partial world. It also throws for
 * another address than the wallet, or when the observed world is not the declared one.
 * `declaration` must be a real one ({world: {cluster, world_id}, clock}); a missing one is refused at creation.
 */
export function residentObservePort({ observe, wallet, declaration }) {
  if (typeof observe !== 'function') throw new TypeError('observe: the live observation');
  if (typeof wallet !== 'string' || !wallet) throw new TypeError('wallet');
  const w = declaration?.world;
  if (!w || typeof w.cluster !== 'string' || !w.cluster || typeof w.world_id !== 'string' || !w.world_id || !declaration.clock) throw new TypeError(`no real world and clock to declare: ${declaration?.why ?? 'none given'}`);
  const port = async address => {
    if (address !== wallet) throw new ResidentObservationIncomplete([{ field: 'address', by: 'step', why: 'another address than this port\'s wallet' }], null);
    const obs = await observe();
    if (!obs?.world || obs.world.world_id !== w.world_id || obs.world.cluster !== w.cluster) throw new ResidentObservationIncomplete([{ field: 'world', by: 'step', why: 'the observed world is not the declared one' }], null);
    const r = residentObservationOf(obs, { wallet });
    throw new ResidentObservationIncomplete(r.missing, r.view);
  };
  return Object.assign(port, { world: w, clock: declaration.clock });
}
