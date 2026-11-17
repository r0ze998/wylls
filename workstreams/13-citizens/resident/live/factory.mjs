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
//   plan              workstream 1's send.mjs planSend with chain.mjs rpcReader over `rpc.url`, ONLY when the caller
//                     declares that RPC's network (`rpc.cluster`) and it is the herald's; the Season given to the
//                     planner is the observed one; after planning, /h/season is read again and a changed world
//                     (program, Season, world account or network) makes the plan held (WorldChanged)
//   results (stop-A)  `execution`: the caller's ws04-acts port (resident/ports/ws04-acts.mjs); status only
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
import { observeLive } from './observe.mjs';
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

const sameSeason = (a, b) => !!a && !!b && a.programId === b.programId && String(a.seasonId) === String(b.seasonId) && a.seasonAddress === b.seasonAddress && a.cluster === b.cluster;

/**
 * `createLiveResident({heraldUrl, boardUrl?, rpc?: {url, cluster, source}, wallet, execution?, authority?, provider?,
 *   allow?, fetchImpl})` → {observe(), step({stop?, submittedKeys?})}. Nothing is read until one of them is called.
 */
export function createLiveResident({ heraldUrl, boardUrl = null, rpc = null, wallet, execution = null, authority = {}, provider = null, allow = {}, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl');
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
    const planned = async args => {
      if (!rpcOk) return { ok: false, code: 'RpcNotDeclared', why: 'no RPC with its declared network (rpc.url, rpc.cluster, rpc.source)' };
      if (!seen || rpc.cluster !== seen.cluster) return { ok: false, code: 'RpcOtherNetwork', why: `the RPC is declared for ${rpc.cluster}, the herald's network is ${seen?.cluster ?? 'unknown'}` };
      if (args?.season?.programId !== seen.programId || String(args?.season?.seasonId) !== seen.seasonId) return { ok: false, code: 'WorldMismatch', why: 'the planner was given another world than the one observed' };
      let r;
      try { r = await planSend(args); } catch (e) { return { ok: false, code: 'PlanFailed', why: String(e?.message ?? e).slice(0, 120) }; }
      let again = null;
      try { const s = await herald.get('/h/season'); if (s.status >= 200 && s.status < 300 && s.json) again = { programId: s.json.programId, seasonId: String(s.json.season), seasonAddress: s.json.seasonAddress, cluster: s.json.cluster }; } catch { again = null; }
      if (!sameSeason(again, seen)) return { ok: false, code: 'WorldChanged', why: again ? 'the world changed while planning' : 'the world could not be read again after planning' };
      return r;
    };
    return { pendingSendOf, planSend: planned, reader, season: seen ? { programId: seen.programId, seasonId: seen.seasonId } : null };
  };

  return Object.freeze({
    observe,
    step: ({ stop = null, submittedKeys = [] } = {}) => liveStep({ wallet, ports: { observe, execution }, deps: depsFor, provider, allow, stop, submittedKeys, authority }),
  });
}
