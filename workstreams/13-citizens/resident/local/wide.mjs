// ⑬ local resident in a LOCAL WIDE-LAND world: the wide land's own orders (external-wide-orders, 2026-11-23). KEY-FREE.
//
// What a person's page can do in a local wide world, and nothing else, with the page's own modules:
//   the wide claim 0xD9        flocalplay-wide.mjs (claimTargets within outpost_range, settlerCost, freeWideSites from the
//                              herald's public /h/world/wide/route) — the village screen's 「広い土地に村を出す」 card
//   a wide village's host      flocalplay-wide-plan.mjs createWideHostPlanner (WideTrain → WideMuster → WideDepart onto a
//                              neighbouring keep) over the relay's read-only wide read — the page's wide village card
//   the expedition (rim→wide)  the page's depart route (fexpedition-* → flocalplay-depart.mjs), as the operator residents
//                              send it (gateway local-play-operator-wide-march.mjs): a ready host of the rim village into
//                              a bordering wide province, sealed to T(arrive); the world's runner reveals it
// What it reads: the launcher's start answer's `wideLand.targets` (the page is told the same), the public herald through
// its own world proxy (season, status, its own /h/me with the page's wide inventory parser, its own province, the wide
// route captures) and its own relay's read-only wide read (the page's `frontier-local-play-act-wide-read-v1`). No
// operator route, no other wallet's record. Every order is a request: the relay (one action per turn, the byte-for-byte
// rebuild) and the program refuse it exactly as they refuse a person's.
import { claimTargets, settlerCost, freeWideSites, WIDE_CLAIM } from '../../../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { createWideHostPlanner } from '../../../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import { WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART } from '../../../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { parseWideInventory } from '../../../../permutation-server/web/frontier/fwide.mjs';
import { seasonAddresses } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';
import { createWideMarch, borderTargets } from '../../../../permutation-gateway/src/frontier/local-play-operator-wide-march.mjs';
import { villageSite } from './territory.mjs';

/** The order name the resident's journal gives the rim → wide expedition (the page's depart route, not a local act). */
export const EXPEDITION = 'Expedition';
export const WIDE_HOST_ORDERS = Object.freeze([WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART]);
/** Every wide-land order this resident may ask for (besides the rim first village, brain.mjs WIDE_HOME_ORDER). */
export const WIDE_ORDERS = Object.freeze([WIDE_CLAIM, ...WIDE_HOST_ORDERS, EXPEDITION]);
/**
 * The resident's own pace in the wide land (its choices, never looser than the world's one action per turn):
 *   claimTries 3            landed claims that founded nothing (the site was taken at the settle) before it stops claiming
 *   claimWaitBells 12       turns a landed claim is waited for (the runner settles it at a turn's end; ×60 under load)
 *   savePatienceBells 240   a claim is saved for (builds and training that would spend its cost are held) only when
 *                           production covers the settler cost within this many turns; else the village grows first
 *                           (a local wide world is always on a compressed clock: ×60 for 150 minutes is 900 turns; a
 *                           fresh rim village, food 40/h and wood 30/h, needs ≈200 turns for 1200/1200 — run1, which
 *                           asked 1.5× the price: the program's slot 2 costs 800/800/400/200 — verify-pr183)
 *   trainWaitBells 12       a landed WideTrain is not asked again for this long (training finishes into the reserve)
 *   expeditions 1           rim → wide expeditions in one world; expeditionGapBells between two
 *   routeTargets 4          the nearest claim targets whose free sites are read (one herald read)
 */
export const WIDE_LIMITS = Object.freeze({ claimTries: 3, claimWaitBells: 12, savePatienceBells: 240, trainWaitBells: 12, expeditions: 1, expeditionGapBells: 40, routeTargets: 4 });

const ring = (p, q) => { const a = BigInt(p), b = BigInt(q); const ab = x => (x < 0n ? -x : x); const s = -a - b; return Number([ab(a), ab(b), ab(s)].reduce((x, y) => (x > y ? x : y))); };

/** The resident's wide memory (inside journal.mjs state, `st.wide`), made when first needed. */
export const wideMem = st => (st.wide ??= { claims: 0, triedClaims: [], claimWait: null, departs: 0, lastDepart: null, trainedAt: null, expeditions: 0, expeditionUntil: -1 });

/**
 * The wide villages of the resident's own Citizen from its own `/h/me` read, with the page's own parser (fwide.mjs
 * parseWideInventory: the record checked against the Citizen bytes and the canonical addresses). → `{villages: [{p, q,
 * site, slot}], bound}` (`bound`: wide-bound slots, captured or not — the page counts them toward the three villages), or
 * `{villages: [], bound: 0, unread}` when the inventory is not there or refused.
 */
export function wideInventory(meRecord, citizen, { wallet, programId, seasonAddress, seasonId }) {
  try {
    const A = seasonAddresses(programId, String(seasonId));
    const inv = parseWideInventory(meRecord, { seasonAddress, programId, seasonId: String(seasonId), citizen: A.of('Citizen', { wallet }), citizenRecord: citizen, viewerKey: wallet });
    if (inv?.status !== 'ready') return { villages: [], bound: 0, unread: 'no wide inventory in the record' };
    const villages = inv.slots.filter(s => s.holding).map(s => ({ p: String(s.holding.p), q: String(s.holding.q), site: Number(s.holding.site), slot: s.inventorySlot }));
    return { villages, bound: inv.slots.length };
  } catch (e) { return { villages: [], bound: 0, unread: String(e?.code ?? e?.message ?? e).slice(0, 80) }; }
}

/** Whether a wide claim is the resident's to ask for now (no wide village yet, tries left). → why not, or null. */
export function claimNotDue(obs, st, limits = WIDE_LIMITS) {
  const w = obs?.wideLand, m = st.wide ?? {};
  if (!w) return 'the wide land is not read';
  if (w.villages.length || w.bound > 0) return 'I have a wide village already';
  if ((m.claims ?? 0) >= limits.claimTries) return `${m.claims} landed claim(s) founded no village: I stop claiming`;
  if (!w.targets.length) return 'no opened wide province within reach of my village';
  return null;
}
/** A landed claim still settling (the runner settles it at a turn's end). → why, or null. */
export function claimSettling(obs, st, limits = WIDE_LIMITS) {
  const c = st.wide?.claimWait;
  return c && Number.isInteger(c.bell) && obs.bell < c.bell + limits.claimWaitBells ? `my claim on ${c.site} (turn ${c.bell}) is settled at a turn's end (waited until turn ${c.bell + limits.claimWaitBells})` : null;
}
/**
 * The program's claim needs the first home FINAL (proc/wide.rs claim_site: NotFinal, Custom 24 — live run2: a claim of a
 * provisional rim village was rejected by the runner's preflight, not sent). The save goes on meanwhile. → why, or null.
 */
export function claimNotFinal(obs) {
  if (obs?.landStage === 'final') return null;
  return obs?.landStage ? `my first village is ${obs.landStage}, not final: a wide claim needs a final first home (NotFinal)` : 'my first village\'s land stage is not read';
}

/** The settler cost against the village's stock: `{need, short: {resource: n}, affordable}`. */
export function claimCost(obs) {
  const need = obs.wideLand?.need ?? settlerCost(1);   // (one village held: the second's price)
  const have = (obs.stores ?? []).map(s => s.value);
  const short = {};
  need.forEach((n, r) => { if (n > (have[r] ?? 0)) short[RESOURCE_ORDER[r]] = n - (have[r] ?? 0); });
  return { need, short, affordable: Object.keys(short).length === 0 };
}
/**
 * The claim order for this turn: the nearest target in reach, its first free untried site (the herald's capture; none
 * known: site by site, as the page's card). → `{order, site}` or `{why}`.
 */
export function claimOrder(obs, st) {
  const tried = new Set(st.wide?.triedClaims ?? []);
  const w = obs.wideLand;
  // (ws13-territory, #209 T-6: in a world with player territory a village stands on the claimer's OWN tile — the claim
  //  names the target's territory record (`territory: true`, never a reach witness) and the program refuses NotOwner
  //  otherwise. The site is chosen with its tile (territory.mjs villageSite); a site whose tile is not mine yet gives no
  //  order but `tileFirst`: the tile is claimed first (brain.mjs, one claim a turn), as the page's card does in two presses.
  //  Territory not read in a wide world: no claim is made on a guess.)
  if (obs.territory && obs.territory.on !== false) {
    if (obs.territory.on !== true) return { why: obs.territory.why ?? 'whether this world has player territory is not read' };
    const s = villageSite(obs.territory, st, new Map(w.targets.map(t => [`${t.p},${t.q}`, Array.isArray(t.free) ? t.free : null])));
    if (s.why) return { why: s.why };
    if (!s.mine) return { why: `the tile of site ${s.site} at ${s.p},${s.q} (tile ${s.tile}) is not mine yet: a village stands on my own land, the tile first`, tileFirst: s };
    const holding = { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site }, target = { p: String(s.p), q: String(s.q) };
    return { site: `${target.p},${target.q},${s.site}`, order: { name: WIDE_CLAIM, v: { holding, target, territory: true }, fields: { site: s.site, slot: w.slot } } };
  }
  const sitesOf = t => (Array.isArray(t.free) ? t.free : Array.from({ length: 12 }, (_, s) => s));
  const next = w.targets.flatMap(t => sitesOf(t).map(site => ({ t, site }))).find(c => !tried.has(`${c.t.p},${c.t.q},${c.site}`));
  if (!next) return { why: 'every free site within reach was tried' };
  const holding = { p: obs.holding.p, q: obs.holding.q, site: obs.holding.site }, target = { p: String(next.t.p), q: String(next.t.q) };
  return { site: `${target.p},${target.q},${next.site}`, order: { name: WIDE_CLAIM, v: { holding, target }, fields: { site: next.site, slot: w.slot } } };
}
/**
 * The save: a claim is due, not settling, has a site, its settler cost is short and production covers it within
 * WIDE_LIMITS.savePatienceBells → an order that would spend `spend` (by resource index) below that cost waits. → why, or null.
 */
export function saveHold(obs, st, spend, limits = WIDE_LIMITS) {
  if (!spend || !obs?.wideLand || claimNotDue(obs, st, limits) || claimSettling(obs, st, limits)) return null;
  const co = claimOrder(obs, st);
  if (!co.order && !co.tileFirst) return null;   // (ws13-territory: a site whose tile is being claimed first is saved for too)
  const cost = claimCost(obs);
  if (cost.affordable) return null;
  const rate = (obs.stores ?? []).map(s => s.perHour), have = (obs.stores ?? []).map(s => s.value);
  const bells = Math.max(0, ...Object.entries(cost.short).map(([r, n]) => { const per = (rate[RESOURCE_ORDER.indexOf(r)] ?? 0) / 6; return per > 0 ? Math.ceil(n / per) : Infinity; }));
  if (!Number.isFinite(bells) || bells > limits.savePatienceBells) return null;
  const eats = cost.need.some((n, r) => n > 0 && (spend[r] ?? 0) > 0 && (have[r] ?? 0) - (spend[r] ?? 0) < n);
  return eats ? `saving for the wide claim (production covers the settler cost in about ${bells} turn(s))` : null;
}

/** Whether a rim → wide expedition is the resident's to ask for now. → why not, or null. */
export function expeditionNotDue(obs, st, limits = WIDE_LIMITS) {
  const m = st.wide ?? {};
  if (!obs?.wideLand) return 'the wide land is not read';
  if (!obs.holding || ring(obs.holding.p, obs.holding.q) !== 128) return 'my village is not on the rim (ring 128)';
  if (!obs.wideLand.border?.length) return 'my village borders no opened wide province';
  if ((m.expeditions ?? 0) >= limits.expeditions) return `${m.expeditions} expedition(s) sent (my limit ${limits.expeditions})`;
  if (Number.isInteger(m.expeditionUntil) && obs.bell <= m.expeditionUntil) return `my last expedition left; the next not before turn ${m.expeditionUntil + 1}`;
  return null;
}
/** The planner's wide-host decision, unless my last WideTrain is still training (the planner reads only the reserve). */
export function wideHostDecision(obs, st, limits = WIDE_LIMITS) {
  const h = obs.wideLand?.host;
  if (!h) return { why: 'no wide village is read' };
  const d = h.decision;
  if (!d) return { why: h.why ?? 'nothing to do at my wide village', wait: h.wait ?? null };
  const t = st.wide?.trainedAt;
  if (d.name === WIDE_TRAIN && Number.isInteger(t) && obs.bell < t + limits.trainWaitBells) return { why: `my wide training of turn ${t} finishes into the reserve first (until turn ${t + limits.trainWaitBells})`, wait: 'training' };
  return { decision: d };
}

/** Summaries of a wide-host decision and an expedition plan for the journal and the log (no seal bytes). */
export const departMeta = d => (d?.name === WIDE_DEPART && d.to ? { to: { p: String(d.to.p), q: String(d.to.q), tile: d.to.tile, holder: d.to.holder }, arrive: d.fields?.arrive_bell ?? null, troops: d.troops ?? null } : null);
export const expeditionFields = p => ({ dest: { p: String(p.dest.p), q: String(p.dest.q) }, arriveBell: p.arriveBell, troops: Math.floor(Number(p.host?.troops ?? 0)), host: String(p.host?.id ?? '') });

/**
 * After a wide order: its memory (the failure hold is brain.mjs noteOutcome's). `outcome` landed | failed | refused |
 * unknown | not-sent; `meta`: the journal's summary (departMeta).
 */
export function noteWide(st, kind, name, outcome, { bell, site = null, meta = null, limits = WIDE_LIMITS } = {}) {
  const m = wideMem(st);
  if (kind === 'wideclaim') {
    if (site && outcome !== 'not-sent') m.triedClaims = [...m.triedClaims, site];
    if (outcome === 'landed') { m.claims += 1; m.claimWait = { bell, site }; }
  }
  if (kind === 'widehost' && name === WIDE_TRAIN && outcome === 'landed') m.trainedAt = bell;
  if (kind === 'widehost' && name === WIDE_DEPART && (outcome === 'landed' || outcome === 'unknown')) { m.departs += 1; if (meta?.to) m.lastDepart = { to: meta.to, arrive: meta.arrive, troops: meta.troops }; }
  if (kind === 'expedition' && (outcome === 'landed' || outcome === 'unknown')) { m.expeditions += 1; m.expeditionUntil = bell + limits.expeditionGapBells; }
  return st;
}

/**
 * The wide land as this resident sees it this turn: `look(obs, st)` → `obs.wideLand = {targets, border, need, slot,
 * villages, bound, host, expedition, bell}` (read at most once per turn and per memory change; nothing is signed or
 * sent). Ports: `herald` (base URL of its world proxy), `identity` ({address, programId, seasonAddress}), `wideTargets`
 * (the launcher's `wideLand.targets`), `read(addresses)` (its relay's read-only wide read), `fetch` (with the launcher's
 * Origin), `getJson(url)`.
 */
export function createWideEyes({ herald, identity, wideTargets, read, fetch: f, getJson, limits = WIDE_LIMITS, now = () => Date.now(), deps = {} }) {
  // (`deps` — tests only: `{march, planner}` stand-ins for the page's modules)
  const march = deps.march ?? createWideMarch({ herald, fetch: f, now });
  // (the chain's clock and the TEST clock's rate, as the operator residents' wide host reads them: local-play-operator-wide-host.mjs)
  const clock = { at: 0, chain: null, rate: 1 };
  async function chainNow() {
    const c = Number((await getJson(`${herald}/h/status`))?.live?.[1]);
    if (!Number.isSafeInteger(c)) throw Object.assign(new Error('NoChainClock'), { code: 'NoChainClock' });
    const t = now();
    if (clock.chain !== null && t - clock.at > 500 && c > clock.chain) clock.rate = Math.max(1, Math.round(((c - clock.chain) * 1000) / (t - clock.at)));
    clock.chain = c; clock.at = t;
    return c;
  }
  const planner = deps.planner ?? createWideHostPlanner({ herald: march.herald, read, chainNow, chainRate: () => clock.rate });
  let cache = null;
  const r = Object.freeze({ key: Object.freeze({ address: identity.address }), identity, index: 0 });
  async function look(obs, st) {
    if (!obs?.holding || !obs.wideInv) return null;
    const m = wideMem(st);
    const memKey = JSON.stringify([obs.bell, obs.holding, obs.wideInv.villages, m.claims, m.triedClaims.length, m.departs, m.expeditions, m.trainedAt]);
    if (cache?.key === memKey) return cache.value;
    const own = new Set(obs.wideInv.villages.map(v => `${v.p},${v.q}`));
    let targets = claimTargets(obs.holding, wideTargets).filter(t => !own.has(`${t.p},${t.q}`));
    const owned = 1 + obs.wideInv.bound;
    // (verify-pr183 / D-verify-pr177-1: the program charges settler_cost(holdings_n), holdings_n = the villages held
    //  BEFORE the claim — proc/wide.rs reads C::HOLDINGS_N — so the second village costs 800/800/400/200, not 1,200:
    //  the page's card, screens/holding.mjs wideClaimModel, asks the same)
    const value = { bell: obs.bell, villages: obs.wideInv.villages, bound: obs.wideInv.bound, need: settlerCost(Math.min(2, owned)), slot: Math.min(3, owned + 1),
      border: borderTargets(obs.holding, wideTargets), targets, host: null, expedition: null };
    // (a claim due: the free sites of the nearest targets, from the herald's public route capture — the page's card reads it)
    const probe = { ...obs, wideLand: value };
    if (!claimNotDue(probe, st, limits) && targets.length) {
      try {
        const near = targets.slice(0, limits.routeTargets);
        const free = freeWideSites(await getJson(`${herald}/h/world/wide/route?at=${encodeURIComponent(near.map(t => `${t.p},${t.q}`).join(';'))}`));
        value.targets = targets = near.map(t => (free.has(`${t.p},${t.q}`) ? { ...t, free: free.get(`${t.p},${t.q}`) } : t));
      } catch { /* no answer: site by site (a refused site is not asked again) */ }
    }
    // (a wide village: the page's planner over its own relay's read)
    if (value.villages.length) {
      const pm = { decisions: 0, wideHostUntil: -1, wideDeparts: m.departs, lastWideDepart: m.lastDepart };
      try { value.host = await planner.decide(identity, pm, { wideTargets, villages: value.villages }); } catch (e) { value.host = { why: String(e?.code ?? e?.message ?? e).slice(0, 160) }; }
    }
    // (an expedition due: a ready host, a judged path, the arrival window — or why not, with the host count)
    if (!expeditionNotDue(probe, st, limits)) {
      try { value.expedition = await march.plan(r, wideTargets); } catch (e) { value.expedition = { ok: false, why: String(e?.code ?? e?.message ?? e).slice(0, 160) }; }
    }
    // (a wide province still finishing the last turn — the planner's 'lag' wait — is read again next round, not cached for
    //  the turn: the first look of a turn is right after it changed, when the province is always behind (LP6-7's trap; live
    //  run1: WideMuster waited 16+ turns on "resolved to n−2, the turn is n" read once per turn)
    cache = value.host?.wait === 'lag' ? null : { key: memKey, value };
    return value;
  }
  /** ONE send of an expedition plan through the resident's own world proxy (`onSigned` before the one submit). */
  async function sendExpedition(plan, { signer, onSigned, transitSlot = 0 }) {
    const rr = { ...r, origin: herald, gw: true, signer };
    return march.send(rr, plan, { transitSlot, onSigned, requestId: `x13_${now().toString(36)}` });
  }
  return Object.freeze({ look, sendExpedition, herald: march.herald });
}
