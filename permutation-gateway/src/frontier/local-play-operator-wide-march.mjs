// TEST-ONLY wide local play (wide-march-local, owner t379u 「広い版がんばれ」 / t359u AI march): an operator AI resident's
// march from its rim village (ring 128) INTO the wide land (ring 129+), with the page's own modules only — the same
// path the page's 「境界への道を準備」 card takes (fexpedition-compose.mjs → flocalplay-depart.mjs):
//
//   the herald's reads (season, me, the home province's hosts, the route captures of the wide land)
//     → a geometric path (fexpedition-seal.mjs traceWideDirections) into the chosen wide province, judged by the page's
//       own route observation (fexpedition-route.mjs evaluateOutboundRoute: passable, no palisade, the arrival window)
//     → the wide plaintext (prepareOriginalOutboundPlain) sealed to T(arrive) (seal-wide.mjs sealWideRequest)
//     → the canonical request (fexpedition-depart-prepare.mjs departPreparationRequestOf) to the resident's OWN relay's
//       depart/prepare route (the keyless Rust CLI builds the unsigned message), checked whole (localDepartPrepared)
//     → signed by the resident's own memory-only key, checked again (localDepartSigned), depart/submit, depart/status.
//
// Nothing here is a new rule, instruction, route or privilege: every check is the page's or the program's. The world's
// runner reveals the expedition from the PUBLIC round and drives its destination (itest destination_driver, TEST-ONLY
// SELF_REVEAL), so the resident keeps no secret after the send. No key leaves the process; nothing is retried.
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { hostsIn } from '../../../permutation-server/web/frontier/fland.mjs';
import { DEPART_STAMINA, tipOptions, departMargin } from '../../../permutation-server/web/frontier/fmarch.mjs';
import { seasonClock, bellAt } from '../../../permutation-server/web/frontier/clock.mjs';
import { worldIdOf } from '../../../permutation-server/web/frontier/map/wide.mjs';
import { traceWideDirections, prepareOriginalOutboundPlain, unpackWidePlain } from '../../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { originalHostRef } from '../../../permutation-server/web/frontier/fexpedition.mjs';
import { evaluateOutboundRoute } from '../../../permutation-server/web/frontier/fexpedition-route.mjs';
import { loadOutboundRouteCaptures } from '../../../permutation-server/web/frontier/fexpedition-route-read.mjs';
import { sealWideRequest } from '../../../permutation-server/web/frontier/seal-wide.mjs';
import { departPreparationRequestOf, canonicalDepartProposal, publicSealOk, DEPART_PREPARE_REQUEST_SCHEMA, DEPART_PREPARE_PROGRAM_VERSION } from '../../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs';
import { localDepartPrepared, localDepartSigned, localDepartSubmitted, localDepartStatus, postLocalDepart, LOCAL_DEPART_SUBMIT_SCHEMA } from '../../../permutation-server/web/frontier/flocalplay-depart.mjs';
import { orderableHosts } from './local-play-operator-war.mjs';
import { wireTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { toHex, toBase64, fromHex } from '../../../permutation-server/web/sdk/bytes.mjs';

/** The longest path tried (hex steps); the program allows 32 and at most 4 provinces. */
export const WIDE_PATH_MAX = 14;
/** Candidate paths judged per decision (each one herald read). */
export const WIDE_PATH_TRIES = 4;
/** Turns of slack over the observation's earliest arrival (the send runs a few seconds; ×60 is 10 s a turn). */
export const ARRIVAL_SLACK_BELLS = 2;

const ring = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));
const big = x => BigInt(String(x));
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); };

/**
 * The wide provinces a rim village borders (pure): ring 129 provinces of `targets` at province distance 1 from
 * `(p, q)`, nearest first. `targets`: the runner's opened wide provinces `[{p, q}]` (decimal strings).
 */
export function borderTargets(village, targets) {
  if (!village || ring(village.p, village.q) !== 128) return [];
  return (targets ?? []).map(t => ({ p: Number(t.p), q: Number(t.q) }))
    .filter(t => ring(t.p, t.q) === 129 && ring(t.p - village.p, t.q - village.q) === 1)
    .sort((a, b) => a.p - b.p || a.q - b.q);
}

/**
 * Geometric paths (pure, `traceWideDirections`) from `origin` (`{p, q, tile}`, decimal p/q) into province `dest`,
 * staying in the origin province until the last step: the shortest first, at most `limit`. Terrain is not known here.
 */
export function pathsInto(world, origin, dest, { limit = WIDE_PATH_TRIES, max = WIDE_PATH_MAX } = {}) {
  const out = [], seen = new Set(); let frontier = [[]];
  const at = (t, p, q) => String(t.p) === String(p) && String(t.q) === String(q);
  for (let depth = 0; depth < max && out.length < limit; depth++) {
    const next = [];
    for (const dirs of frontier) for (let k = 0; k < 6 && out.length < limit; k++) {
      const nd = [...dirs, k];
      let e; try { e = traceWideDirections({ world, origin, directions: nd }).endpoint; } catch { continue; }
      const id = `${e.tileQ},${e.tileR}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (at(e, dest.p, dest.q)) { out.push({ directions: nd, tile: e.tile }); if (out.length >= limit) break; }
      else if (at(e, origin.p, origin.q)) next.push(nd);
    }
    frontier = next;
  }
  return out;
}

/**
 * The wide-march side of one resident: `{plan(r, wideTargets), send(r, plan)}`. `herald`: the world's herald base URL.
 * `plan` → `{ok: true, plan}` (a ready host, a judged path, the arrival window) or `{ok: false, why}` (nothing sent).
 */
export function createWideMarch({ herald: base, fetch: f = (...a) => globalThis.fetch(...a), now = () => Date.now() }) {
  const herald = createHerald({ base, fetch: f });
  const clock = { at: 0, chain: null, rate: 1 };
  async function chainNow() {
    const st = await (await f(`${base}/h/status`, { signal: AbortSignal.timeout(4000) })).json();
    const c = Array.isArray(st?.live) ? Number(st.live[1]) : NaN;
    if (!Number.isSafeInteger(c)) fail('NoChainClock');
    const t = now();
    if (clock.chain !== null && t - clock.at > 500 && c > clock.chain) clock.rate = Math.max(1, Math.round(((c - clock.chain) * 1000) / (t - clock.at)));
    clock.chain = c; clock.at = t;
    return c;
  }
  async function plan(r, wideTargets) {
    const s = await herald.season();
    if (!s.ok) return { ok: false, why: `season: ${s.code}` };
    const season = s.season, record = s.record;
    if (String(season.programVersion) !== DEPART_PREPARE_PROGRAM_VERSION) return { ok: false, why: 'not the expedition dispatch Season' };
    const me = await herald.me(r.key.address);
    if (!me.ok || !me.citizen || !me.holdings?.length) return { ok: false, why: 'no village' };
    const holding = me.holdings[0];
    const targets = borderTargets(holding, wideTargets);
    if (!targets.length) return { ok: false, why: 'the village does not border the wide land' };
    const nowTs = await chainNow(), nowBell = bellAt(seasonClock(season).genesisTs, nowTs);
    const pv = await herald.province(holding.p, holding.q);
    if (!pv.ok) return { ok: false, why: `home province: ${pv.code}` };
    const all = hostsIn(pv.province, holding, nowBell);
    const ready = orderableHosts(all, { nowBell, departStamina: DEPART_STAMINA }).filter(h => h.troops >= 100);
    // (`hosts`: every host of the village here — 0 means one must be formed first; forming or tired hosts are waited for)
    if (!ready.length) return { ok: false, why: all.length ? 'its host is not ready yet' : 'no host at home', hosts: all.length };
    const host = ready[0];
    const program = r.identity?.programId, seasonAddr = r.identity?.seasonAddress;
    if (!program || !seasonAddr) return { ok: false, why: 'the relay has not named its program and season yet' };
    const world = worldIdOf(seasonAddr, program);
    const source = { program, season: seasonAddr, seasonId: String(season.seasonId), world, unit: host.unit, faction: Number(me.citizen.faction),
      holdingFlags: Number(holding.flags ?? 0), origin: { p: String(holding.p), q: String(holding.q), tile: host.tile } };
    const departTs = Math.floor(nowTs) + departMargin(clock.rate);
    const tried = [];
    for (const dest of targets) {
      for (const path of pathsInto(world, source.origin, dest)) {
        let data;
        try { data = await loadOutboundRouteCaptures(herald, source, path.directions, AbortSignal.timeout(8000)); } catch (e) { tried.push(`${dest.p},${dest.q}: ${e.code ?? 'RouteReadUnavailable'}`); continue; }
        const probe = evaluateOutboundRoute({ source, directions: path.directions, lands: data.lands, season, departTs, arriveBell: null });
        if (probe.code !== 'ArrivalRequired' || !Number.isInteger(probe.min)) { tried.push(`${dest.p},${dest.q}: ${probe.code}`); continue; }
        const arriveBell = Math.min(probe.min + ARRIVAL_SLACK_BELLS, probe.max);
        const judged = evaluateOutboundRoute({ source, directions: path.directions, lands: data.lands, season, departTs, arriveBell });
        if (!judged.ok) { tried.push(`${dest.p},${dest.q}: ${judged.code}`); continue; }
        return { ok: true, plan: { season, record, holding, host, source, dest, directions: path.directions, destTile: path.tile, arriveBell, nowBell,
          tip: String(tipOptions(season)[0].lamports) } };
      }
    }
    return { ok: false, why: `no passable path into the wide land (${tried.slice(0, 4).join('; ') || 'no geometric path'})` };
  }
  /** ONE send of a judged plan by the resident `r` (`origin`, `signer`, `key`): → `{ok, step, code?, signature?, status?}`. */
  async function send(r, p, { transitSlot = 0, requestId = `wm_${now().toString(36)}_${r.index}` } = {}) {
    const step = { at: 'sealing' };
    try {
      const host = originalHostRef(p.source.world, String(p.host.id));
      // (the page's review of the plaintext; the sealer takes the typed plaintext unpacked from its bytes, as runLocalDepart does)
      const review = prepareOriginalOutboundPlain({ program: p.source.program, season: p.source.season, host, origin: p.source.origin, directions: p.directions,
        arriveBell: p.arriveBell, stance: 0, retreatBps: 0 });
      const plain = unpackWidePlain(fromHex(review.plainHex));
      const sealed = sealWideRequest({ plain, host, arriveBell: p.arriveBell, clock: seasonClock(p.season), drand: p.record.drand, seasonPkHash: p.season.quicknetPkHash,
        seasonNetwork: p.season.network, cluster: p.record.cluster });
      if (!sealed.ok) fail(sealed.code ?? 'SealFailed');
      const pub = { commit: toHex(sealed.commit), seal: toHex(sealed.seal) };
      if (!publicSealOk(pub)) fail('SealFailed');
      step.at = 'preparing';
      const scope = { schema: DEPART_PREPARE_REQUEST_SCHEMA, request_id: requestId, cluster: p.record.cluster, program: p.source.program, season: p.source.season,
        deployment: { program_version: DEPART_PREPARE_PROGRAM_VERSION, ruleset_hash: toHex(Uint8Array.from(p.season.rulesetHash)) },
        wallet: r.key.address, payer: r.key.address, host, standing: { p: p.source.origin.p, q: p.source.origin.q }, transit_slot: String(transitSlot),
        arrive_bell: String(p.arriveBell), tip: p.tip, public_commit: pub.commit, public_seal: pub.seal, min_slot: '0' };
      const request = departPreparationRequestOf({ ...scope, proposal: canonicalDepartProposal(scope) });
      // (the page's three /gw/ paths, as the page names them; a resident posts to its own relay directly, without /gw)
      const post = (path, body) => postLocalDepart(r.origin, path, body, { fetch: (url, init) => f(String(url).replace(`${r.origin}/gw/`, `${r.origin}/`), init) });
      const prepared = localDepartPrepared(await post('/gw/f/local-play/depart/prepare', request), request);
      step.at = 'signing';
      const [out] = await r.signer.wallet.features['solana:signTransaction'].signTransaction({ account: { address: r.key.address }, transaction: wireTransaction(prepared.message, []) });
      const signed = await localDepartSigned(out?.signedTransaction ?? [], prepared, r.key.address);
      step.at = 'submitting';
      let answer;
      try { answer = localDepartSubmitted(await post('/gw/f/local-play/depart/submit', { schema: LOCAL_DEPART_SUBMIT_SCHEMA, message_digest: prepared.digest, transaction_b64: toBase64(signed.wire) }), signed.signature); } catch (e) {
        return { ok: false, step: 'sent', code: e.code ?? 'LocalDepartOutcomeUnknown', signature: signed.signature, unknown: true };
      }
      step.at = 'status';
      for (let i = 0; i < 20; i++) {
        let st = null;
        try { st = localDepartStatus(await post('/gw/f/local-play/depart/status', { schema: 'frontier-local-play-depart-status-v1', signature: signed.signature }), signed.signature); } catch { st = null; }
        if (st && ['confirmed', 'finalized'].includes(st.status)) return { ok: true, step: 'landed', signature: signed.signature, submitted: answer };
        if (st?.status === 'failed') return { ok: false, step: 'failed', code: st.err ?? 'Failed', signature: signed.signature };
        await new Promise(res => setTimeout(res, 1000));
      }
      return { ok: false, step: 'sent', code: 'LocalDepartOutcomeUnknown', signature: signed.signature, unknown: true };
    } catch (e) {
      return { ok: false, step: step.at, code: e.code ?? String(e?.message ?? e).slice(0, 120) };
    }
  }
  return Object.freeze({ plan, send, herald });
}
