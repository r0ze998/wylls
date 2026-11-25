// LOCAL PLAY, TEST-ONLY — operator AI residents at war: the EYES and the MARCH, with the page's own code only.
//
// What a war resident reads is what the page reads, through the page's own herald client (herald.mjs createHerald:
// season, me, province, control, overview2 — public reads of the world proxy), decoded by the page's own decoders. The
// rules kernel is the page's own WASM file (fconquest.mjs kernelFile), checked by the page's own loader (wasm.mjs:
// published sha256, ABI version, ruleset hash) — only read from this checkout's disk instead of over HTTP. Targets come
// from the page's own finder (fkeepreach.mjs reachableKeeps, over keeps built exactly as controller.mjs builds them
// from the control snapshot and the ring overviews), the route from the composer's own planner (fmarch.mjs planRoute),
// and the march is sealed and sent by the page's own flow: fmarch.mjs sendMarch (checkMarch, plaintext, drand timelock
// seal of seal.mjs, the book) through flocalplay-march.mjs createLocalMarchSender (the relay's own bytes, the wallet's
// one signature, ONE submit, an unknown outcome held and only asked about) to the resident's OWN relay — the same
// relay routes a person's page posts to, only without the world proxy's `/gw` prefix. The march is opened only when
// the resident's own relay answers the page's own capability read for THIS wallet and THIS runner instance with the
// TEST-ONLY trial (flocalplay-march.mjs localMarchReady), as the page's gate requires.
// No other route; no operator read; no reveal (the world's keeper reveals, as for every march); no clock control.
import fs from 'node:fs/promises';
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { loadKernel } from '../../../permutation-server/web/frontier/wasm.mjs';
// (TEST-ONLY coexist lane: its Season's kernel is the S1 one, flocalplay-lane.mjs's one alias; elsewhere the hash itself)
import { kernelRulesetFor } from '../../../permutation-server/web/frontier/flocalplay-lane.mjs';
import { conquestEnabled, kernelFile, keepFromProvince } from '../../../permutation-server/web/frontier/fconquest.mjs';
import { reachableKeeps } from '../../../permutation-server/web/frontier/fkeepreach.mjs';
import { planRoute, sendMarch, earliestBell, arrivalWindow, tipOptions, departMargin, DEPART_STAMINA, freeTransitSlot } from '../../../permutation-server/web/frontier/fmarch.mjs';
import { sealMarch, checkBeacon } from '../../../permutation-server/web/frontier/seal.mjs';
import { seasonClock, bellAt } from '../../../permutation-server/web/frontier/clock.mjs';
import { hostsIn, actionBlocks } from '../../../permutation-server/web/frontier/fland.mjs';
import { tileHex, TILE_OFFSETS } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { seasonAddresses } from '../../../permutation-server/web/frontier/faddr.mjs';
import { createLocalMarchSender, readLocalMarchCapability, localMarchReady, LOCAL_MARCH_READY } from '../../../permutation-server/web/frontier/flocalplay-march.mjs';
import { orderableHosts, chooseMarch, MAX_HOSTS } from './local-play-operator-war.mjs';
// (flag-keeps-ai, F4: the resident's own player view under the fog of war — the page's own survey and keep masks)
import { anchorsOf, buildSurvey, remember } from '../../../permutation-server/web/frontier/map/survey.mjs';
import { fogKeeps, nationAnchors, createFogMemory } from '../../../permutation-server/web/frontier/map/fog.mjs';
import { flagSight, flagWeights, flagMarches, readGoals } from './local-play-operator-goals.mjs';

const WASM_DIR = new URL('../../../permutation-server/web/frontier/wasm/', import.meta.url);
/** The blocks that only mean "this turn of the province has not settled yet" (the page's muster wait). */
export const SETTLE_CODES = Object.freeze(['NotResident', 'NotFinal']);
/** Keeps farther than this many provinces from a host are not asked about (a march crosses at most 4 provinces). */
export const REACH_PROVINCES = 3;
const ring = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));
/** Province distance (axial). */
export const provinceDistance = (a, b) => ring(a.p - b.p, a.q - b.q);

/** A `fetch` over this checkout's files (`file:` URLs only), for the page's kernel loader. */
export async function fileFetch(url) {
  const u = new URL(String(url));
  if (u.protocol !== 'file:') throw new Error('file: only');
  try {
    const b = await fs.readFile(u);
    return { ok: true, status: 200, text: async () => b.toString('utf8'), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  } catch { return { ok: false, status: 404 }; }
}

/**
 * The keeps the page knows, as controller.mjs builds them (refreshConquest): for each province of the control
 * snapshot with a keep in its ring overview, `{p, q, tile, holder, troops, heartland, consolidatedUntil, contender,
 * progress, requiredBells, asOfBell}`. `overviews`: Map ring → decodeOverviewV2 result.
 */
export function keepsOf(control, overviews) {
  const keeps = new Map();
  for (const c of control?.provinces ?? []) {
    const ov = overviews.get(ring(c.p, c.q))?.provinces?.find(p => p.p === c.p && p.q === c.q);
    if (ov?.keepTile !== null && ov?.keepTile !== undefined) keeps.set(`${c.p},${c.q}`, Object.freeze({ p: c.p, q: c.q, tile: ov.keepTile, holder: c.control, troops: ov.keepTroops,
      // (the page leaves the consolidation bell unknown here; the snapshot's own `consolidating` flag says a keep is
      //  inside its protection after a capture — no contest counts there — so it is kept out, as fkeepreach would)
      heartland: c.heartland, consolidatedUntil: c.consolidating ? control.bell + 1 : null, contender: c.contender, progress: c.progress, requiredBells: c.required, asOfBell: control.bell }));
  }
  return keeps;
}

/**
 * The rings whose overviews the war eyes read (loop-play4 B-6): every ring of the control snapshot from ring 1 out (a
 * natural world's ring 1 is contestable land), within REACH_PROVINCES + 1 rings of a resident's village ring; none before
 * any village is known. Ascending.
 */
export function warRings(control, homeRings) {
  const homes = [...(homeRings ?? [])];
  const near = r => homes.some(h => Math.abs(h - r) <= REACH_PROVINCES + 1);
  // (fix-loop4: and every ring around a village up to the last ring of ordinary land — a wide world's control snapshot
  //  covers only the map before its growth (rings 0-2 at the setup's last turn), so the rim's keeps were never seen)
  const around = homes.flatMap(h => Array.from({ length: 2 * REACH_PROVINCES + 3 }, (_, i) => h - REACH_PROVINCES - 1 + i)).filter(r => r <= WIDE_FIRST_RING - 1);
  return [...new Set([...(control?.provinces ?? []).map(p => ring(p.p, p.q)), ...around])].filter(r => r >= 1 && near(r)).sort((a, b) => a - b);
}

/**
 * (fix-loop4) The hexes a war march must not be planned through: every tile of each province within REACH_PROVINCES + 1
 * of `homes` (ordinary land, ring 0 included) that no ring overview lists — a place with no Province account. The
 * program's Reveal reads every Province of the road and refuses an absent one (BadAccount, Custom(2): a ×60 wide world's
 * rim marches dipped into ring 127, which its growth never opened, and were never revealed — fix-loop4 play-through;
 * #96 BREAK-4 for the expedition). The page blocks the centre's absent places the same way (map/world.mjs
 * closedCentreHexes). `[{q, r}]`, the planner's `blocked`.
 */
export function absentHexes(overviews, homes) {
  const present = new Set();
  for (const o of overviews.values()) for (const pv of o.provinces ?? []) present.add(`${pv.p},${pv.q}`);
  const seen = new Set(), out = [];
  const R = REACH_PROVINCES + 1;
  for (const h of homes) for (let dp = -R; dp <= R; dp++) for (let dq = Math.max(-R, -dp - R); dq <= Math.min(R, -dp + R); dq++) {
    const p = h.p + dp, q = h.q + dq, k = `${p},${q}`;
    if (seen.has(k) || ring(p, q) >= WIDE_FIRST_RING) continue;
    seen.add(k);
    if (present.has(k)) continue;
    for (let i = 0; i < TILE_OFFSETS.length; i++) out.push(tileHex(p, q, i));
  }
  return out;
}

/** The first ring of the wide land (an ordinary Depart never goes there; wide marches are their own). */
export const WIDE_FIRST_RING = 129;

/**
 * (fix-loop4) The keeps of the provinces within REACH_PROVINCES of `homes` (`[{p, q}]`) that the ring `overviews` show a
 * keep in, from each one's own province record as the page builds them (fconquest.mjs keepFromProvince — controller.mjs
 * loadEnvelope), laid over `keeps` (the control snapshot's) where newer. `read(p, q)` → a herald province answer.
 * Ordinary land only (never the wide land).
 */
export async function nearKeeps(keeps, overviews, homes, read) {
  const out = new Map(keeps);
  const want = [];
  for (const o of overviews.values()) for (const pv of o.provinces ?? []) {
    if (pv.keepTile === null || pv.keepTile === undefined || ring(pv.p, pv.q) >= WIDE_FIRST_RING) continue;
    if (homes.some(h => provinceDistance(h, pv) <= REACH_PROVINCES)) want.push(pv);
  }
  for (const pv of want) {
    let r; try { r = await read(pv.p, pv.q); } catch { continue; }
    const k = r?.ok ? keepFromProvince(r.province) : null;
    if (!k) continue;
    const c = out.get(`${k.p},${k.q}`);
    if (!c || k.asOfBell >= (c.asOfBell ?? 0)) out.set(`${k.p},${k.q}`, Object.freeze(k));
  }
  return out;
}

/**
 * The world's eyes for war residents (shared by all residents of the process): `{refresh(), world, view(wallet)}`.
 * `refresh()` reads the season, the chain clock, the control snapshot and the ring overviews once per turn.
 */
/**
 * (flag-keeps-ai) One resident's fogged keeps, as its play page would show them (map/fog.mjs, the local test world's fog):
 * the survey's anchors are its villages (`villages` [{p, q, tile, tier}]) and standing hosts (`hosts` [{p, q, tile,
 * unit}]) plus its nation's held provinces (`territory` [{p, q}], the control snapshot's — map/fog.mjs nationSources
 * reads the same snapshot); nation-mates' villages are left out (their tiles need the terrain, which the eyes do not
 * read: a smaller sight, never a larger one). `fog` = `{tiles: Set, mem}` kept per resident (the page's device memory:
 * tiles seen before stay surveyed, keeps seen before are last-known). → Map "p,q" → keep (fogKeeps' shape).
 */
export function residentSeenKeeps(keeps, { villages, hosts, territory, faction, fog, ringsOpen = WIDE_FIRST_RING }) {
  const anchors = anchorsOf({ villages, hosts, extraAnchors: nationAnchors({ villages: [], territory }) });
  const survey = buildSurvey({ ringsOpen, anchors, memory: fog.tiles });
  remember(fog.tiles, survey);
  return fogKeeps(keeps, { survey, mem: fog.mem, viewer: faction });
}

/** A resident's fog state (memory only: gone with the process, as a page's memory is gone with its device). */
export function createResidentFog() {
  const mem = createFogMemory({ storage: { get: () => null, set: () => false } });
  mem.use(null);
  return { tiles: new Set(), mem };
}

export function createWarEyes({ herald: base, fetch: f = (...a) => globalThis.fetch(...a), goals = null }) {
  const herald = createHerald({ base, fetch: f });
  let kernel = null, kernelFor = null;
  const world = { rate: 1, sampledAt: 0, season: null, record: null, clock: null, beacon: null, now: null, nowBell: null, keeps: new Map(), blocked: [], seeds: [], controlBell: null, bellRead: null, homeRings: new Set(), homes: new Map(), control: null, goals: null, goalsAt: 0 };
  const fogs = new Map();
  async function refresh() {
    const st = await (await f(`${base}/h/status`, { signal: AbortSignal.timeout(4000) })).json();
    const now = Array.isArray(st?.live) ? Number(st.live[1]) : NaN;
    if (!Number.isSafeInteger(now)) throw new Error('no chain clock');
    if (!world.season || world.bellRead === null || bellAt(world.clock.genesisTs, now) !== world.bellRead) {
      const s = await herald.season();
      if (!s.ok) throw new Error(`season: ${s.code}`);
      world.season = s.season; world.record = s.record; world.clock = seasonClock(s.season);
      world.beacon = checkBeacon({ drand: s.record.drand, seasonPkHash: s.season.quicknetPkHash, cluster: s.record.cluster, seasonNetwork: s.season.network });
      world.seeds = (s.record.rings ?? []).filter(r => r && r.seed).map(r => ({ ring: r.d, seed: r.seed }));
      if (conquestEnabled(s.season)) {
        const c = await herald.control();
        if (c.ok) {
          // (every ring with provinces — ring 1 too: a natural world's ring 1 is ordinary contestable land (B14), and
          //  loop-play4 B-6 found its keeps were the only ones in reach of a kept world's villages — but only the rings
          //  within reach of a resident's village (none before the first village; a wide world has 131 rings and a turn
          //  is 10 s at x60))
          const rings = warRings(c.control, world.homeRings);
          const overviews = new Map();
          for (const r of rings) { const o = await herald.overview2(r); if (o.ok) overviews.set(r, o); }
          world.keeps = await nearKeeps(keepsOf(c.control, overviews), overviews, [...world.homes.values()], (p, q) => herald.province(p, q));
          world.blocked = absentHexes(overviews, [...world.homes.values()]);
          world.controlBell = c.control.bell;
          world.control = c.control;
        }
      }
      world.bellRead = bellAt(world.clock.genesisTs, now);
    }
    // (flag-keeps-ai: the world's goals, as the page's card reads them — the launcher's judge, at most every 3 s)
    if (goals && Date.now() - world.goalsAt >= 3000) { world.goalsAt = Date.now(); world.goals = await readGoals(goals, { fetch: f }); }
    // (the chain clock's rate: chain seconds per wall second, from two samples; a synthetic demo clock runs × its scale)
    const at = Date.now();
    if (world.sampledAt && at - world.sampledAt > 500 && now > world.now) world.rate = Math.max(1, Math.round(((now - world.now) * 1000) / (at - world.sampledAt)));
    world.now = now; world.sampledAt = at; world.nowBell = bellAt(world.clock.genesisTs, now);
    const file = kernelFile(world.season);
    if (kernelFor !== file) {
      kernel = await loadKernel({ url: new URL(file, WASM_DIR), fetch: fileFetch, ruleset: kernelRulesetFor(Buffer.from(world.season.rulesetHash).toString('hex')) });
      kernelFor = file;
    }
    return world;
  }
  /**
   * One resident's war snapshot: `{holding, hosts, reserve, hostCount, march, faction}` or null. `memory.targets`
   * (keep key → bell until which it counts as taken by this resident's own march) is read, never written here.
   */
  async function view(wallet, memory) {
    const me = await herald.me(wallet);
    if (!me.ok || !me.citizen || !me.holdings.length) return null;
    const holding = me.holdings[0], faction = Number(me.citizen.faction), nowBell = world.nowBell;
    // (the village's ring: the next refresh reads the keeps of the rings around it; a newly known ring is read at once)
    const hr = ring(holding.p, holding.q);
    if (!world.homeRings.has(hr)) { world.homeRings.add(hr); world.bellRead = null; }
    if (!world.homes.has(wallet)) { world.homes.set(wallet, { p: holding.p, q: holding.q }); world.bellRead = null; }
    const where = new Map();
    for (const h of me.record.hosts ?? []) if (Array.isArray(h?.province)) where.set(`${h.province[0]},${h.province[1]}`, { p: Number(h.province[0]), q: Number(h.province[1]) });
    where.set(`${holding.p},${holding.q}`, { p: holding.p, q: holding.q });
    const hosts = [], provinces = new Map();
    for (const [k, pq] of where) {
      const pv = await herald.province(pq.p, pq.q);
      if (!pv.ok) continue;
      provinces.set(k, pv.province);
      for (const h of hostsIn(pv.province, holding, nowBell)) hosts.push({ ...h, p: pq.p, q: pq.q });
    }
    const keeps = world.keeps;
    const onKeep = h => { const k = keeps.get(`${h.p},${h.q}`); return !!k && k.tile === h.tile && k.holder !== faction && k.contender === faction; };
    const ready = orderableHosts(hosts, { nowBell, departStamina: DEPART_STAMINA, holdingKey: onKeep });
    const transits = (holding.transit ?? []).filter(t => t.state !== 0).length;
    const free = freeTransitSlot(holding) !== null;
    // (flag-keeps-ai: the posting as THIS resident's player view shows it, and what it weighs for its marches)
    let sight = null, weights = null;
    if (world.goals) {
      const fog = fogs.get(wallet) ?? fogs.set(wallet, createResidentFog()).get(wallet);
      const villages = me.holdings.filter(h => Number.isInteger(h.tile)).map(h => ({ p: h.p, q: h.q, tile: h.tile, tier: h.tier ?? 0 }));
      const territory = (world.control?.provinces ?? []).filter(c => c.control === faction).map(c => ({ p: c.p, q: c.q }));
      const seen = residentSeenKeeps(keeps, { villages, hosts: hosts.filter(h => h.state === 1).map(h => ({ p: h.p, q: h.q, tile: h.tile, unit: h.unit })), territory, faction, fog });
      sight = flagSight({ answer: world.goals, faction, seenKeeps: seen });
      weights = flagWeights(sight, faction, { busy: flagMarches(memory?.targets, sight, nowBell) });
    }
    let march = null, plainTarget;
    if (ready.length && free && kernel) {
      const near = new Map([...keeps].filter(([, k]) => ready.some(h => provinceDistance(h, k) <= REACH_PROVINCES)));
      const origins = ready.map(h => ({ p: h.p, q: h.q, tile: h.tile, unit: h.unit, host: String(h.id), troops: h.troops }));
      // (flag-keeps-ai, documented: the target finder reads the UNFOGGED keeps of the herald within REACH_PROVINCES —
      //  holder, garrison, contest — as the war eyes did since #68; a player's page masks them under the fog of war. Only
      //  the flag weights above are limited to the resident's fogged view. Whether the war AI itself should be fogged is
      //  left to the owner (reports/flag-keeps-ai.md))
      const r = reachableKeeps({ kernel, keeps: near, origins, seeds: world.seeds, faction, nowBell, blocked: world.blocked });
      const taken = row => (memory?.targets?.[`${row.p},${row.q}`] ?? -1) >= nowBell;
      if (r.ok) march = chooseMarch(r.rows, { taken, weights });
      // (flag-keeps-ai: what the ordinary rule alone would have chosen — logged, so a run measures what the weights changed)
      if (r.ok && weights?.size) { const plain = chooseMarch(r.rows, { taken }); plainTarget = plain ? `${plain.row.p},${plain.row.q}` : null; }
      if (march) march = { ...march, host: ready.find(h => String(h.id) === march.row.origin.host) ?? null, province: provinces.get(`${march.row.origin.p},${march.row.origin.q}`) ?? null };
    }
    // (the page's own check of a resident action on the village's province, at this turn: while only the turn's
    //  settling blocks it, the page waits for the province's turn to settle — flocalplay-muster-wait.mjs — and so does this)
    const home = provinces.get(`${holding.p},${holding.q}`) ?? null;
    const blocks = actionBlocks('Muster', { holding, province: home, nowBell, now: world.now });
    const settling = blocks.length > 0 && blocks.every(b => SETTLE_CODES.includes(b));
    // (ai-ore-reserve: the resident's troops — at home and in its hosts — and whether a keep of its own nation within
    //  reach of its village is under another nation's contest: then its ore goes to troops, not land)
    const army = Number(holding.reserve?.[0] ?? 0) + hosts.reduce((n, x) => n + (Number(x.troops) || 0), 0);
    const threatened = [...keeps.values()].some(k => k.holder === faction && Number.isInteger(k.contender) && k.contender >= 0 && k.contender <= 5 && k.contender !== faction && provinceDistance(holding, k) <= REACH_PROVINCES);
    return { faction, holding, hosts, settling, blocks, army, threatened, reserve: Number(holding.reserve?.[0] ?? 0), hostCount: hosts.length + transits, march: march?.host ? march : null, nowBell, ready: ready.length, roomForHosts: hosts.length < MAX_HOSTS,
      ...(sight ? { goals: { round: sight.round, weighted: [...weights].map(([k, v]) => `${k}:${v.goal}`), ...(plainTarget !== undefined ? { plain: plainTarget } : {}) } } : {}) };
  }
  /**
   * The bell the chain is in NOW, as the page's chain clock extrapolates it from the last sample at the measured rate
   * (the same reading sendWarMarch uses for the departure time); null before the first refresh.
   */
  function liveBell() {
    if (!world.clock || !Number.isSafeInteger(world.now) || !world.sampledAt) return null;
    return bellAt(world.clock.genesisTs, Math.floor(world.now + Math.max(0, (Date.now() - world.sampledAt) / 1000) * (world.rate ?? 1)));
  }
  return Object.freeze({ refresh, view, world, herald, kernel: () => kernel, liveBell });
}

/**
 * The resident's own relay, opened for the march as the page opens it: the instance from its own relay, then the
 * page's capability read for THIS wallet and instance; open only with the TEST-ONLY trial. → `{open, instance, trial}`.
 */
export async function openMarch(origin, wallet, { fetch: f = (...a) => globalThis.fetch(...a) } = {}) {
  const r = await f(`${origin}/f/local-play/act/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'frontier-local-play-act-instance-v1' }), signal: AbortSignal.timeout(4000) });
  const j = r.ok ? await r.json() : null;
  if (!j || j.wallet !== wallet || typeof j.instance !== 'string') return { open: false, why: 'no instance from its own relay' };
  const cap = await readLocalMarchCapability({ origin: new URL(origin).origin, wallet, expectedInstance: j.instance,
    request: (url, init) => f(String(url).replace(`${new URL(origin).origin}/gw/`, `${new URL(origin).origin}/`), init) });
  if (!cap) return { open: false, why: 'its relay gave no march capability for this wallet and instance' };
  return { open: localMarchReady(LOCAL_MARCH_READY, { trial: cap.trial === true }), instance: j.instance, trial: cap.trial };
}

/**
 * ONE march for a war resident, with the page's own send flow. `r`: the resident (`origin`, `identity`, `rulesetHash`,
 * `signer`, `marchOpen`); `snap`: its `view()` with a chosen `march`; `eyes`. → sendMarch's answer, plus `arriveBell`.
 */
export async function sendWarMarch(r, snap, eyes, { post } = {}) {
  const w = eyes.world, k = eyes.kernel();
  const { row, host, province } = snap.march;
  const route = planRoute(k, { from: { p: row.origin.p, q: row.origin.q, tile: row.origin.tile }, to: { p: row.p, q: row.q, tile: row.tile }, unit: host.unit, seeds: w.seeds, blocked: w.blocked ?? [] });
  if (!route.ok) return { ok: false, step: 'route', code: route.code };
  // (the chain's time now, as the page's chain clock extrapolates it from its last sample at the measured rate)
  const nowSecs = () => w.now + Math.max(0, (Date.now() - w.sampledAt) / 1000) * (w.rate ?? 1);
  const margin = departMargin(w.rate ?? 1);
  const earliest = earliestBell(k, { genesisTs: w.clock.genesisTs, departTs: nowSecs() + margin, secs: route.route.secs });
  const win = arrivalWindow(w.season, w.nowBell, earliest);
  const tip = tipOptions(w.season)[0].lamports;
  const A = seasonAddresses(r.identity.programId, String(w.season.seasonId));
  const m = { season: w.season, nowBell: w.nowBell, resolvedNext: province?.resolvedNext ?? null, province, now: w.now, holding: snap.holding, host: host.entry,
    dest: { p: row.p, q: row.q, tile: row.tile }, route: route.route, earliest, arriveBell: win.min, stance: 0, retreat: { choice: 'never', ratio: null }, tip,
    holdingAddress: A.of('Holding', { p: snap.holding.p, q: snap.holding.q, site: snap.holding.site }) };
  const sender = r.marchSender ??= createLocalMarchSender({ allowed: () => ({ ok: true, relay: r.origin }), open: () => r.marchOpen === true, identity: () => r.identity,
    rulesetHash: () => r.rulesetHash, signer: () => r.signer, ...(post ? { post } : {}), tries: 20, every: 1000 });
  const out = await sendMarch(m, { seal: req => sealMarch(req, { inline: true }), clock: w.clock, publicKey: w.beacon?.publicKey, accounts: null, session: null,
    ...sender.depsFor({ holding: { p: snap.holding.p, q: snap.holding.q, site: snap.holding.site }, province: { p: row.origin.p, q: row.origin.q } }),
    earliestAtSend: () => earliestBell(k, { genesisTs: w.clock.genesisTs, departTs: nowSecs() + margin, secs: route.route.secs }) });
  return { ...out, arriveBell: m.arriveBell, route: { steps: route.route.dirs?.length ?? null, provinces: route.route.provinces?.length ?? null, secs: route.route.secs } };
}
