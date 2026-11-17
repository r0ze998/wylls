// The operator resident's live path, assembled from the real readers and functions (2026-11-17). The composition
// root of observe.mjs → candidates.mjs → decide.mjs → step.mjs, like bin/observe-canonical.mjs is for 12's read.
//
// Creating it does nothing: no request, no key, no start, no loop. Each call of `observe()` or `step()` is one read
// (and, for a send, one plan from the chain); nothing is signed, posted, submitted or joined (step.mjs: enacting is not
// connected). There is no runner here: whoever calls step decides when, and the resident's own limits are not lifted.
//
// What it connects, with the conversions made explicit:
//   herald, board     GET `${url}${path}`, redirects refused, JSON only → {status, json}
//   world, bell       workstream 12 adapters/canonical.mjs worldFromSeason, currentBellFromSeason (/h/season)
//   villages          /h/me bytes_b64 → bytes (base64) → the game's decode('Holding'|'Citizen', bytes, {seasonId})
//                     → addresses as base58 (ownerCitizen, wallet), as workstream 1's send.mjs holdingAt does
//   stock             the game's storesAt(settled(holding, t), t, RESOURCE_ORDER), t = /h/season latestUnix (the
//                     herald's), whole units by workstream 1's RESOURCES order, as send.mjs's estimate does
//   earlier sends     workstream 1's pending.mjs pendingSendOf
//   plan              workstream 1's send.mjs planSend with chain.mjs rpcReader over `rpc.url`, its `now` (Unix seconds)
//                     being this observation's herald latestUnix (observe.mjs plannerNow; unknown or invalid: held,
//                     TimeUnknown, never the local clock), ONLY when the caller
//                     declares that RPC's network (`rpc.cluster`) and it is the herald's; the Season given to the
//                     planner is the observed one; after planning, /h/season is read again and a changed world
//                     (program, Season, world account or network) makes the plan held (WorldChanged)
//   results (stop-A)  `execution`: the caller's port with status(); only status is used. Or (2026-11-17) `actsStatus`
//                     {bin, db, gatewayPort?, bridge?, registry, agentId}: workstream 4's acts client
//                     (createActsClient: runexec over the run store `db`) wrapped in the status-only port
//                     (ports/ws04-acts-status.mjs), whose origin {registry, agentId} is the caller's explicit
//                     statement; made at creation with no IO. With `gatewayPort`, each status read also reads the
//                     wallet once and records the answer in the run store (workstream 4's behaviour).
//   stop, keys        with `residentDir`: the resident's own stop and submitted keys, read at each step() from its
//                     charter.json and state.json and its halt file (resident-state.mjs; read only, no key file, no
//                     Resident constructed). A caller's `stop` may add a stop, never clear the resident's; its keys
//                     are the resident's only (held while their world is not recorded).
// The wallet, the authorities and any provider are the caller's, given explicitly; none is made here.

import { worldFromSeason, currentBellFromSeason } from '../../../12-memory/adapters/canonical.mjs';
import { planSend } from '../../../01-national-strategy/coop/send.mjs';
import { pendingSendOf } from '../../../01-national-strategy/coop/pending.mjs';
import { rpcReader } from '../../../01-national-strategy/coop/chain.mjs';
import { RESOURCES } from '../../../01-national-strategy/coop/record.mjs';
import { decode } from '../../../../permutation-server/web/frontier/fcodec.mjs';
import { encode as toBase58 } from '../../../../permutation-server/web/sdk/base58.mjs';
import { storesAt } from '../../../../permutation-server/web/frontier/fland.mjs';
import { settled } from '../../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/fi18n.mjs';
import { readFileSync, lstatSync } from 'node:fs';
import { observeLive, plannerNow } from './observe.mjs';
import { readResidentState } from './resident-state.mjs';
import { seasonClock, clockId } from '../frame.mjs';
import { createActsClient } from '../../../04-execution/clients/acts.mjs';
import { ws04ActsStatusPort } from '../ports/ws04-acts-status.mjs';
import { residentObservationOf, observeDeclaration, residentObservePort as makeResidentObservePort } from './resident-view.mjs';
import { liveStep } from './step.mjs';

const bytesOf = b64 => {
  if (typeof b64 !== 'string' || !b64) throw new TypeError('no account bytes');
  const s = atob(b64);
  return Uint8Array.from(s, ch => ch.charCodeAt(0));
};
const baseOf = u => { const x = new URL(u); if (!['http:', 'https:'].includes(x.protocol) || x.username || x.password) throw new TypeError('an http(s) URL without credentials'); return x.href.replace(/\/+$/, ''); };

/** A GET reader over one base URL (herald or board): `{status, json}`, never following a redirect. */
export function getReader(url, fetchImpl) {
  const base = baseOf(url);
  return {
    async get(path) {
      const r = await fetchImpl(`${base}${path}`, { redirect: 'error', headers: { accept: 'application/json' } });
      let json = null;
      try { json = await r.json(); } catch { json = null; }
      return { status: r.status, json };
    },
  };
}

/** The game's decoders and stock, as observe.mjs takes them. */
export const gameDeps = Object.freeze({
  decodeHolding(b64, { seasonId }) {
    const h = decode('Holding', bytesOf(b64), { seasonId });
    return { p: h.p, q: h.q, site: h.site, gen: h.gen, tile: h.tile, ownerCitizen: toBase58(h.ownerCitizen), decoded: h };
  },
  decodeCitizen(b64, { seasonId }) {
    const c = decode('Citizen', bytesOf(b64), { seasonId });
    return { wallet: toBase58(c.wallet), holdingsN: c.holdingsN };
  },
  stockAt(h, t) {
    const have = storesAt(settled(h.decoded, t), t, RESOURCE_ORDER).map(x => x.value);
    return Object.fromEntries(RESOURCES.map((r, i) => [r, have[i]]));
  },
});

/**
 * (2026-11-17) Whether a path exists, for the resident's halt file: true when it is there (a link counts, even a
 * dangling one: the halt is taken as present), false ONLY when the system says it does not exist (ENOENT), and throws
 * for anything else (no permission, a path component that is not a directory, …): never "absent" by failure.
 */
export function existsForHalt(p) {
  try { lstatSync(p); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
}

const sameSeason = (a, b) => !!a && !!b && a.programId === b.programId && String(a.seasonId) === String(b.seasonId) && a.seasonAddress === b.seasonAddress && a.cluster === b.cluster;

/**
 * `createLiveResident({heraldUrl, boardUrl?, rpc?: {url, cluster, source}, wallet, execution?, authority?, provider?,
 *   allow?, fetchImpl})` → {observe(), step({stop?, submittedKeys?})}. Nothing is read until one of them is called.
 */
export function createLiveResident({ heraldUrl, boardUrl = null, rpc = null, wallet, residentDir = null, execution = null, actsStatus = null, authority = {}, provider = null, allow = {}, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl');
  // (2026-11-17) the result port from explicit settings: workstream 4's client, read-only wrapper, the stated origin.
  // Nothing runs here (createActsClient keeps its arguments); a missing or partial setting is refused, not completed.
  if (actsStatus) {
    if (execution) throw new TypeError('give either execution or actsStatus, not both');
    const { bin, db, gatewayPort = null, bridge = false, registry, agentId } = actsStatus;
    if (typeof bin !== 'string' || !bin.startsWith('/') || typeof db !== 'string' || !db.startsWith('/')) throw new TypeError('actsStatus.bin and actsStatus.db: absolute paths (the runexec binary and its run store)');
    if (gatewayPort !== null && !(Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort < 65536)) throw new TypeError('actsStatus.gatewayPort: a port on 127.0.0.1, or null (answer from the store only)');
    execution = ws04ActsStatusPort(createActsClient({ bin, db, gatewayPort, bridge: bridge === true }), { agentId, registry });
  }
  if (typeof wallet !== 'string' || !wallet) throw new TypeError('wallet: the resident\'s address, supplied by its owner');
  const herald = getReader(heraldUrl, fetchImpl);
  const board = boardUrl ? getReader(boardUrl, fetchImpl) : null;
  const rpcOk = rpc && typeof rpc.url === 'string' && typeof rpc.cluster === 'string' && rpc.cluster && typeof rpc.source === 'string' && rpc.source;
  const reader = rpcOk ? rpcReader(baseOf(rpc.url), { fetchImpl: (u, init) => fetchImpl(u, { ...init, redirect: 'error' }) }) : null;
  const deps = { worldFromSeason, currentBellFromSeason, ...gameDeps };
  const observe = () => observeLive({ herald, board, wallet, deps });

  /** The planner and the earlier-send rule for one observation: the Season is the observed one, re-checked after. */
  const depsFor = obs => {
    const seen = obs?.season ?? null;
    const at = plannerNow(obs);   // (2026-11-17) the planner's `now`: this observation's herald latestUnix, never the local clock
    const planned = async args => {
      if (!rpcOk) return { ok: false, code: 'RpcNotDeclared', why: 'no RPC with its declared network (rpc.url, rpc.cluster, rpc.source)' };
      if (!seen || rpc.cluster !== seen.cluster) return { ok: false, code: 'RpcOtherNetwork', why: `the RPC is declared for ${rpc.cluster}, the herald's network is ${seen?.cluster ?? 'unknown'}` };
      if (args?.season?.programId !== seen.programId || String(args?.season?.seasonId) !== seen.seasonId) return { ok: false, code: 'WorldMismatch', why: 'the planner was given another world than the one observed' };
      if (!at.ok) return { ok: false, code: 'TimeUnknown', why: `${at.why}: the stock is not estimated at a guessed time` };
      let r;
      try { r = await planSend({ ...args, now: at.now }); } catch (e) { return { ok: false, code: 'PlanFailed', why: String(e?.message ?? e).slice(0, 120) }; }
      let again = null;
      try { const s = await herald.get('/h/season'); if (s.status >= 200 && s.status < 300 && s.json) again = { programId: s.json.programId, seasonId: String(s.json.season), seasonAddress: s.json.seasonAddress, cluster: s.json.cluster }; } catch { again = null; }
      if (!sameSeason(again, seen)) return { ok: false, code: 'WorldChanged', why: again ? 'the world changed while planning' : 'the world could not be read again after planning' };
      return r;
    };
    return { pendingSendOf, planSend: planned, reader, season: seen ? { programId: seen.programId, seasonId: seen.seasonId } : null };
  };

  return Object.freeze({
    observe,
    // (2026-11-17) the resident's shape from one live observation: the grounded part and what is missing (never
    // complete today); a read only, nothing decided or enacted
    residentView: async () => residentObservationOf(await observe(), { wallet }),
    // (2026-11-17) an observe port in the resident's form, declaring the real world and clock from one /h/season read;
    // each call throws ResidentObservationIncomplete (a resident given it stops at observe: no join, no decision)
    residentObservePort: async () => makeResidentObservePort({ observe, wallet, declaration: await observeDeclaration({ herald, worldFromSeason, seasonClock }) }),
    step: async ({ stop = null, submittedKeys = [] } = {}) => {
      if (!residentDir) return liveStep({ wallet, ports: { observe, execution }, deps: depsFor, provider, allow, stop, submittedKeys, authority });
      // (2026-11-17) the resident's own stop and keys, read now (not at creation); unknown is a stop
      // (2026-11-17) the resident's files first (no network). The live frame a submitted key must match is read ONLY
      // when the resident is stopped, an execution origin is declared, and some key is complete enough that only that
      // frame could decide it: then one GET of /h/season (world and clock), nothing else. Otherwise nothing is read,
      // and when not stopped the step goes on as before (its keys are not used: only stop-A reads results).
      const fs = { readText: p => readFileSync(p, 'utf8'), exists: existsForHalt };
      const first = readResidentState({ dir: residentDir, wallet, fs });
      // (2026-11-17) the stop for this WHOLE call: the caller's and the one first read, kept; a later read can only add
      // one (a stop that clears during the call does not let it observe, decide or plan)
      const stops = [stop, first.stop].filter(Boolean);
      let rs = first, live = null, later = null;
      if (stops.length && execution?.origin && first.submitted.held.some(h => h.needsLive)) {
        live = { world: null, clock: null, execution: execution.origin, read: 'herald /h/season (world and clock only, to match submitted keys)' };
        try {
          const s = await herald.get('/h/season');
          if (s.status >= 200 && s.status < 300 && s.json) { const w = worldFromSeason(s.json); if (w.world) { live.world = w.world; live.clock = clockId(seasonClock(w.clock)); } }
        } catch { /* not known: every key stays held */ }
        later = readResidentState({ dir: residentDir, wallet, fs, live });
        if (later.stop) stops.push(later.stop);
        rs = later;
      }
      const effective = stops.length ? { why: stops[0].why ?? 'stopped', reasons: stops.map(x => x.why ?? 'stopped') } : null;
      // keys only from a read that matched them against the live frame, and only while stopped (stop-A)
      const keys = effective && later ? later.submitted.keys : [];
      const r = await liveStep({ wallet, ports: { observe, execution }, deps: depsFor, provider, allow, stop: effective, submittedKeys: keys, authority });
      return { ...r, resident: { stop: effective, callerStop: stop, firstStop: first.stop, laterStop: later ? later.stop : undefined, facts: rs.facts, live, submittedRead: keys, submittedHeld: rs.submitted.held, submittedWhy: rs.submitted.why, unsent: rs.unsent } };
    },
  });
}
