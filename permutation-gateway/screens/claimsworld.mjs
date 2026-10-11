// The banner rule's LABELLED PROTOTYPE in the sample world (PROTOTYPE-SPEC.md;
// liveworld.mjs option `claims`, off by default). The rule is a design: it is
// not in the program, the rules crate or the ABI, and nothing here is sent to
// a chain. This file is what the sample world keeps, computes and serves of
// it; every judgement is made by the pure functions of claims.mjs on the
// province as last resolved, and nothing on the land changes without a
// record (`PROTO_LAND`, served by /h/events with `proto: true`).
//
//   the land     one record per province of ring 2 (rings 0 and 1 have no
//                banners and no score), beside the province the world already
//                keeps and never inside its bytes. At world start every
//                settled village takes its site and its ring.
//   the players  the viewer and each neighbour village: what they spent, what
//                the day's walk paid, the day's exploring.
//   the keeper   after a province's turn is resolved: a banner past its limit
//                is frayed, one past its grace (or a stump) is struck, each in
//                the first turn the rule allows it.
//   the script   each neighbour town holds one banner from the first frame;
//                one host of the town in the viewer's own province comes to
//                stand on the viewer's first banner outside the home province,
//                or raises its own on a border tile of the viewer's other
//                home-wedge province: one threat with a count, which a march
//                that wins the tile answers. Seeded, deterministic, logged.
//   the orders   POST /gw/f/proto/land (not a transaction shape), judged as
//                the rule judges and written at once, each with its record.
//   the records  /h/season `sample.proto.claims`, `proto.land` on
//                /h/province/P,Q/latest and /h/me/<wallet>, /h/proto/standings,
//                and the read-only /h/proto/preview.
//
// Where this differs from the full rule is in SIMPLER_CLAIMS (served in the
// season record's `sample.simpler` while the prototype is on).
import * as C from './claims.mjs';
import { DIRECTIONS, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostParts } from '../../permutation-server/web/frontier/faddr.mjs';

const N = C.NUMBERS;
/** The label that must be on screen wherever the prototype shows anything, and the note under its score (PROTOTYPE-SPEC section 1). */
export const LABEL = Object.freeze({ ja: '試作ルール：旗（設計のみ・プログラム未実装）', en: 'Prototype rule: banners (design only, not in the program)' });
export const SCORE_NOTE = Object.freeze({ ja: 'この得点は試作の計算です。チェーンの記録ではありません。', en: 'This score is computed by the prototype. It is not a chain record.' });
export const REDUCED = Object.freeze(['no keeps', 'home province only is heartland', 'scripted neighbours', 'the keeper frays on time', 'no full-province rule']);

/** The script's own figures (none is a number of the rule). */
export const SCRIPT = Object.freeze({
  /** The ground within this many steps of the viewer's village is explored when the world starts. */
  EXPLORED_REACH: 3,
  /** The neighbours' host that makes the threat: one more host of the town in the viewer's own province, this many Spearmen (the rule's floor for a raise or a take outside its nation's ground). */
  THREAT_SEQ: 5, THREAT_TROOPS: 500,
  /** It leaves at the first neighbours' moment this many turns after the viewer's first banner outside the home province (PROTOTYPE-SPEC said 3). */
  THREAT_AFTER_RAISE: 0,
  /** With no such banner by this many turns after the world's first, it leaves for a border tile instead (PROTOTYPE-SPEC said 12). */
  THREAT_DEADLINE: 2,
  /**
   * A count that is done "at turn N" (`r`, the province's first unresolved turn, has reached N) can be acted on in the
   * clock's turn N + 1, about 65 game seconds into it: the keeper resolves a turn when its anchor, the reveal window of
   * 600 s and the seed's margin have passed (M1-CONTRACT 5.1), as on a chain whose keepers never lag.
   */
  CLOCK_LAG: 1,
  /** Works each neighbour starts with (abroad a banner costs 8 and more). */
  NEIGHBOUR_WORKS: 24,
  /** A neighbour walks a banner of its own when the walk is due within this many turns and a host of its own may. */
  WALK_AHEAD: 24,
});

/** Where the prototype is simpler than the rule as designed (the first five lines are PROTOTYPE-SPEC 2.1). */
export const SIMPLER_CLAIMS = Object.freeze([
  'prototype rule "banners" (design only): no keeps, so the wedge\'s nation stands in for the keep holder of every province',
  'prototype rule "banners": only the viewer\'s home province is heartland; the other ring 2 provinces are treated as frontier',
  'prototype rule "banners": the neighbours raise and attack banners by a seeded script, not by choice',
  'prototype rule "banners": the world\'s keeper marks lapsed banners itself; on a chain somebody has to send that instruction',
  'prototype rule "banners": the eight-hosts cap and the rule that makes room in a full province are not exercised',
  'prototype rule "banners": every village holds its site and its ring from the world\'s first turn, whichever nation\'s wedge it stands in; the viewer\'s town and the neighbours\' count as old enough to hold land abroad',
  'prototype rule "banners": a host that withdraws to another tile after a clash stands there from the next turn (the design\'s one change to the clash write-back; the program as built leaves its from_bell as it was)',
  `prototype rule "banners": the ground within ${SCRIPT.EXPLORED_REACH} steps of the viewer's village counts as explored from the world's first turn, so that a first banner can rise without scouts; the rest is surveyed by scouts or by marching`,
  'prototype rule "banners": each neighbour town\'s first banner is placed when the world starts, the one in the viewer\'s home province too, where the rule would let no foreign banner rise; each neighbour starts with 24 Works, and the town in the viewer\'s province has one more host of 500 Spearmen',
  `prototype rule "banners": the scripted threat is timed for a sitting of minutes: the host leaves ${SCRIPT.THREAT_DEADLINE} turns into the world (the specification said 12) for a border tile of the viewer's other home-wedge province, where it stands twelve turns to raise a banner of its own; it goes to the pole of a banner of the viewer's outside the home province instead only when there is one by then with no host of the viewer's nation on it (the option threat=pole makes it wait for that)`,
  'prototype rule "banners": the price of a banner is kept in a purse of the prototype\'s own (the Works the world pays as before, plus the day\'s walk, less what banners cost); the Citizen record is not touched',
  'prototype rule "banners": a nation-mate\'s take-over is judged as designed, but the keeper strikes in the first turn the grace has passed, so it does not come up in play',
]);

const TEXT = Object.freeze({
  NotResident: 'the province has not resolved the turns this needs, or the host is not in its roster', HostBusy: 'the host has a change pending', InTransit: 'the host is on a march that is not settled', Scouts: 'scouts never raise or take a banner',
  StandLonger: 'the host has not stood here long enough', TooFew: 'the host has too few troops for this here', NotSurveyed: 'the ground is not surveyed (explore it with scouts, or march a host here)', NotOpen: 'the tile is not open ground a banner can stand on',
  SiteOrCamp: 'a banner does not stand on a site, nor on or next to a camp', SiteRoom: 'two poles already stand beside that empty site', PatchTooSmall: 'the banner would hold fewer than three tiles', NotHere: 'a banner may not be raised here',
  CapReached: 'the player holds as many banners as the village\'s tier allows', PerProvince: 'two banners a player in one province', CeilingReached: 'the nation holds as much land in this province as it may without the keep', WorksShort: 'not enough Works',
  SlotsFull: 'the province has no banner slot left', ElbowNotAllowed: 'elbow room is not allowed here', Changed: 'the patch is smaller, or dearer, than the order allowed', NotYours: 'that banner is not the caller\'s to do this with',
  Contested: 'an enemy host stands on the pole: the banner can be neither struck nor widened', DressedToday: 'the banner was widened today already', PatchFull: 'the patch holds twelve tiles', Denied: 'an enemy host denies that tile',
  TooFar: 'the tile is more than two steps from the pole, or not next to the patch', NoHostBeside: 'no host of the holder stands on the tile or next to it', NotOnPole: 'the host does not stand on that banner\'s pole', SameNation: 'that is a banner of the host\'s own nation',
  Heartland: 'a host does nothing of this in another nation\'s heartland', NotPastGrace: 'the banner is not past its grace', NotInPatch: 'the host does not stand in the banner\'s patch', NotBeside: 'the host stands neither in the patch nor next to it',
  NotArrivedSince: 'the host was already here when the banner was last walked', TooLate: 'there is no such banner (it was struck)', NotDue: 'the banner is not past its limit', ElbowLocked: 'a banner raised with elbow room cannot be struck by its holder yet',
  BadData: 'the order names something that is not there', NotOwner: 'that host is not the caller\'s', NotFinal: 'the village is still provisional', QuotaExceeded: 'the sponsored-transaction quota for this game day is used up',
});
const OPS = Object.freeze(['raise', 'dress', 'take', 'pull', 'takeover', 'tend', 'fray', 'strike']);

export function createClaims(ctx) {
  const { provinces, holdings, HOME, st, pick, startTurn, R, K, RINGS } = ctx;
  const opt = { threat: 'auto', deadline: SCRIPT.THREAT_DEADLINE, afterRaise: SCRIPT.THREAT_AFTER_RAISE, ...ctx.options };
  const pkey = (p, q) => `${p},${q}`, keyOf = H => `${H.p},${H.q},${H.site}`;
  const lands = new Map(), players = new Map();
  const ME = () => ctx.me(), meKey = () => (ME() ? keyOf(ME()) : null);
  let tracks = 0;

  // ------------------------------------------------------------------ what claims.mjs is given: the province as resolved, with the reduced form as parameters
  const landOf = pv => lands.get(pkey(pv.p, pv.q)) ?? null;
  function view(pv) {
    const entries = pv.entries.filter(e => e.state !== R.ES.FREE).map(e => { const hp = hostParts(e.id), H = hp ? holdings.get(`${hp.p},${hp.q},${hp.site}`) : null; return { ...e, inTransit: H ? ctx.inTransit(H, e.id) : false, holder: hp ? `${hp.p},${hp.q},${hp.site}` : null }; });
    const faces = DIRECTIONS.map(([dp, dq]) => { const nb = provinces.get(pkey(pv.p + dp, pv.q + dq)); if (!nb) return null; const l = landOf(nb); return { p: nb.p, q: nb.q, open: true, ring: nb.ring, holderNation: nb.wedge, banners: [0, 1, 2, 3, 4, 5].map(n => (l ? l.banners.filter(b => b.used && b.nation === n).length : 0)) }; });
    return { p: pv.p, q: pv.q, ring: pv.ring, wedge: pv.wedge, holderNation: pv.wedge, heartland: pv.p === HOME.p && pv.q === HOME.q, resolvedNext: pv.resolvedNext, passableMask: pv.passableMask, exploredMask: pv.exploredMask,
      sites: pv.sites.slice(0, pv.siteCount), camp: pv.camp, entries, faces };
  }
  const entryIn = (v, id) => v.entries.find(e => BigInt(e.id) === BigInt(id)) ?? null;
  const heldBy = key => [...lands.values()].reduce((a, l) => a + l.banners.filter(b => b.used && b.holder === key).length, 0);
  const worksOf = P => (P.H.npc ? P.purse : Number(P.H.citizen.works)) + P.walkEarned - P.worksSpent;
  /** The player as the rule's functions read it. */
  function holderOf(key) {
    const P = players.get(key);
    return P ? { key, nation: P.H.faction, tier: P.H.tier, townOk: true, bannersHeld: heldBy(key), works: worksOf(P), elbowUsed: P.elbowUsed } : null;
  }
  const dayOf = r => Math.floor(r / N.DAY);

  // ------------------------------------------------------------------ the world's first turn
  for (const pv of provinces.values()) if (pv.ring >= 2) lands.set(pkey(pv.p, pv.q), C.newLand(pv.sites.slice(0, pv.siteCount), pv.resolvedNext));
  for (const H of holdings.values()) players.set(keyOf(H), { key: keyOf(H), H, purse: H.npc ? SCRIPT.NEIGHBOUR_WORKS : 0, worksSpent: 0, walkEarned: 0, exploreDay: -1, exploreToday: 0, walkDay: -1, elbowUsed: false });
  const home = ctx.home;
  // (a premise of the prototype: the ground round the viewer's village is explored already, by others before the world begins)
  if (ME()) for (let t = 0; t < N.TILES; t++) if (C.steps(t, HOME.tile) <= SCRIPT.EXPLORED_REACH && ((home.passableMask >> BigInt(t)) & 1n) === 1n) home.exploredMask |= 1n << BigInt(t);
  // every settled village takes its site and its ring, in the order of the sites
  for (const pv of [...provinces.values()].filter(x => x.ring >= 2).sort((a, b) => a.p - b.p || a.q - b.q)) {
    pv.siteMirror.forEach((m, site) => {
      if (m.state !== 1 || site >= pv.siteCount) return;
      const r = C.hearth(view(pv), landOf(pv), { site, nation: m.faction, holder: `${pv.p},${pv.q},${site}` });
      lands.set(pkey(pv.p, pv.q), r.land);
      ctx.log({ ...r.log, premise: true });
    });
  }
  /** A host that does not exist, standing on `tile` for as long as any count asks, having marched there along `route` (for the script's premises and for /h/proto/preview). */
  function supposed(pv, base, tile, route = null) {
    const v = view(pv), e = { id: base.id ?? 0n, faction: base.faction, unit: base.unit ?? 0, tile, state: R.ES.ROSTER, troops: base.troops, fromBell: pv.resolvedNext - 100_000, pendOp: 0, inTransit: false, holder: base.holder };
    v.entries = [...v.entries.filter(x => BigInt(x.id) !== BigInt(e.id)), e];
    let land = landOf(pv);
    if (route) { land = C.cloneLand(land); land.trails.set(String(e.id), { stamp: e.fromBell, tile, nation: e.faction, tiles: route }); }
    return { v, e, land };
  }
  // each neighbour town holds one banner next to its village from the first frame (the script's premise: raised by the
  // rule's own function for a host supposed to have marched there and stood; in the viewer's home province the
  // heartland's refusal is waived for this one banner, and SIMPLER_CLAIMS says so)
  if (ctx.neighbours) for (const H of [...holdings.values()].filter(x => x.npc)) {
    const pv = provinces.get(pkey(H.p, H.q)), key = keyOf(H);
    if (!landOf(pv)) continue;
    const base = { id: 0n, faction: H.faction, troops: N.FLOOR_ABROAD * 1000, holder: key };
    const judge = tile => { const s = supposed(pv, base, tile, []); s.v.heartland = false; return { s, c: C.canRaise(s.v, s.land, s.e, holderOf(key)) }; };
    const cands = [...Array(N.TILES).keys()].filter(t => C.steps(t, H.tile) === 2).map(t => ({ t, ...judge(t) })).filter(x => x.c.ok);
    if (!cands.length) continue;
    const best = Math.max(...cands.map(x => x.c.size)), top = cands.filter(x => x.c.size === best), x = top[pick(top.length, 'proto-first-banner', H.p, H.q, H.site)];
    const r = C.raise(x.s.v, x.s.land, x.s.e, holderOf(key));
    r.land.trails.delete('0');
    lands.set(pkey(pv.p, pv.q), r.land);
    players.get(key).worksSpent += r.price;
    ctx.log({ ...r.log, host: null, by: 'script', premise: true });
  }
  // the viewer's march that reached the camp the turn before the world starts: its route, for its trail
  const startRoute = ctx.startRoute;

  // ------------------------------------------------------------------ the keeper, the trail, the explore limit
  /** After a province's turn is resolved and its pending changes are settled: fray what is past its limit, strike what is past its grace or a stump, each in the first turn the rule allows. */
  function keeper(pv) {
    const land0 = landOf(pv);
    if (!land0) return;
    const r = pv.resolvedNext;
    // (bookkeeping, no change of land: a trail whose host has gone, moved or marched again is dropped)
    for (const [id, t] of land0.trails) { const e = pv.entries.find(x => String(x.id) === id && x.state === R.ES.ROSTER); if (!e || e.fromBell !== t.stamp || e.tile !== t.tile) land0.trails.delete(id); }
    for (let slot = 0; slot < N.SLOTS; slot++) {
      const land = landOf(pv), b = land.banners[slot];
      if (!b.used) continue;
      const v = view(pv), w = C.walkDue(v, land, slot);
      const res = b.tiles.length < N.STUMP_TILES && r - b.tendedTurn >= N.STUMP_AGE ? C.strike(v, land, r, { slot, reason: 'stump', by: 'keeper' })
        : r >= w.strikeAt ? C.strike(v, land, r, { slot, reason: 'grace', by: 'keeper' })
          : r >= w.frayAt && !b.frayed ? C.fray(v, land, r, { slot, by: 'keeper' }) : null;
      if (res?.ok) { lands.set(pkey(pv.p, pv.q), res.land); ctx.log(res.log); }
    }
  }
  /** SettleTransit found the fate Stays: the host's trail is written (the last four tiles of its route before the arrival tile that lie in this province). */
  function arrived(pv, hostId, route) {
    const land = landOf(pv);
    if (!land) return;
    const v = view(pv), e = entryIn(v, hostId);
    const way = route ?? (startRoute && BigInt(startRoute.host) === BigInt(hostId) ? startRoute.route : null);
    if (!e || e.state !== R.ES.ROSTER || !way) return;
    const tiles = [];
    for (const x of way.slice(0, N.TRAIL_STEPS)) { if (x.p !== pv.p || x.q !== pv.q) break; tiles.push(x.tile); }
    const r = C.writeTrail(v, land, e, tiles);
    lands.set(pkey(pv.p, pv.q), r.land);
    ctx.log(r.log);
  }
  /** The day's exploring: `{ok, left, perDay}` for an order of `n` tiles at turn `b` (counted when the order is given). */
  function exploreLimit(H, b, n) {
    const P = players.get(keyOf(H));
    if (!P) return { ok: true, left: N.EXPLORE_PER_DAY, perDay: N.EXPLORE_PER_DAY };
    const used = P.exploreDay === dayOf(b) ? P.exploreToday : 0;
    return { ok: used + n <= N.EXPLORE_PER_DAY, left: N.EXPLORE_PER_DAY - used, perDay: N.EXPLORE_PER_DAY };
  }
  function exploredNow(H, b, n) {
    const P = players.get(keyOf(H));
    if (!P) return;
    if (P.exploreDay !== dayOf(b)) { P.exploreDay = dayOf(b); P.exploreToday = 0; }
    P.exploreToday += n;
  }

  // ------------------------------------------------------------------ an act of the rule, by the viewer or by the script
  const refuse = (c, extra = {}) => ({ ok: false, code: c.code, error: `${c.code}: ${TEXT[c.code] ?? c.code}`, need: c.need ?? null, ...extra });
  /**
   * Judge one act for the player `key` and, when the rule allows it, write it: the land, the player's purse, the
   * record(s). `{ok: true, logs}` or `{ok: false, code, error, need}`. `body`: `{op, host, slot, tile, minTiles,
   * maxWorks, elbow, reason}`; `pv` the province.
   */
  function act(key, pv, body, by = key) {
    const land = landOf(pv), P = players.get(key), holder = holderOf(key);
    if (!land || !OPS.includes(body.op)) return refuse({ code: 'BadData' });
    const v = view(pv), r = pv.resolvedNext, slot = Number.isInteger(body.slot) ? body.slot : -1;
    const e = body.host !== undefined && body.host !== null ? entryIn(v, body.host) : null;
    const needsHost = ['raise', 'dress', 'take', 'pull', 'takeover', 'tend'].includes(body.op);
    if (needsHost && (!holder || !e)) return refuse({ code: e || !holder ? 'NotOwner' : 'NotResident' });
    if (needsHost && e.holder !== key) return refuse({ code: 'NotOwner' });
    if (body.op !== 'raise' && !(slot >= 0 && slot < N.SLOTS)) return refuse({ code: 'BadData' });
    let res;
    if (body.op === 'raise') res = C.raise(v, land, e, holder, r, { elbow: Array.isArray(body.elbow) ? body.elbow.map(Number).filter(Number.isInteger).slice(0, N.ELBOW_MAX) : [], minTiles: Number(body.minTiles) || 0, maxWorks: body.maxWorks === undefined || body.maxWorks === null ? Infinity : Number(body.maxWorks) });
    else if (body.op === 'dress') res = C.dress(v, land, e, holder, r, { slot, tile: Number(body.tile) });
    else if (body.op === 'take') res = C.take(v, land, e, holder, r, { slot });
    else if (body.op === 'pull') res = C.pullDown(v, land, e, holder, r, { slot });
    else if (body.op === 'takeover') res = C.takeOver(v, land, e, holder, r, { slot });
    else if (body.op === 'tend') res = C.tend(v, land, e, holder, r, { slot });
    else if (body.op === 'fray') res = C.fray(v, land, r, { slot, by });
    else res = C.strike(v, land, r, { slot, reason: ['own', 'grace', 'stump'].includes(body.reason) ? body.reason : 'own', holder, by });
    if (!res.ok) return refuse(res, res.code === 'StandLonger' ? { tiles: res.tiles ?? null, size: res.size ?? null, atTurn: res.need?.atTurn ?? null } : {});
    lands.set(pkey(pv.p, pv.q), res.land);
    const logs = [{ ...res.log, by, ...(res.note ? { note: res.note } : {}) }];   // (`by`: who sent it: the player, or `script` for the neighbours)
    if (body.op === 'raise') { P.worksSpent += res.price; if (res.elbowUsed) P.elbowUsed = true; }
    // the day's first walk (a tend or a dressing) pays 2 Works
    if (res.walked && P && P.walkDay !== dayOf(r)) { P.walkDay = dayOf(r); P.walkEarned += N.WALK_PAY; logs.push({ op: 'WALK', turn: r, p: pv.p, q: pv.q, slot, pole: res.log.pole, nation: res.log.nation, holder: key, tiles: [], from: null, works: N.WALK_PAY, by: key }); }
    for (const l of logs) ctx.log(l);
    return { ok: true, logs, note: res.note ?? null };
  }
  const provinceOf = x => {
    const [p, q] = Array.isArray(x) ? x : typeof x === 'string' ? x.split(',').map(Number) : x && typeof x === 'object' ? [x.p, x.q] : [NaN, NaN];
    return provinces.get(pkey(Number(p), Number(q))) ?? null;
  };
  const whereIs = id => { for (const pv of provinces.values()) if (pv.entries.some(e => e.state !== R.ES.FREE && BigInt(e.id) === BigInt(id))) return pv; return null; };
  const hostIdOf = x => { try { return x === undefined || x === null || x === '' ? null : BigInt(x); } catch { return null; } };
  /**
   * POST /gw/f/proto/land: an order of the viewer. Answered like the fixture's other orders (`{ok: true, track}`,
   * landed about 1.2 s later: GET /gw/f/tx/<track>; or `{ok: false, code, error, need}` with HTTP 200); it counts
   * against the same action bucket and quota. Not a transaction shape; nothing is signed and nothing is sent anywhere.
   */
  function route(body, t, orders) {
    const H = ME(), name = `ProtoLand:${body?.op ?? '?'}`, turn = ctx.bellOf(t);
    const out = r => { orders.push({ name, ok: r.ok, ...(r.ok ? { signature: r.track } : { code: r.code }), turn }); return r; };
    if (!H || !body || !OPS.includes(body.op)) return out(refuse({ code: 'BadData' }));
    const host = hostIdOf(body.host), pv = body.province !== undefined ? provinceOf(body.province) : host !== null ? whereIs(host) : null;
    if (!pv || !landOf(pv)) return out(refuse({ code: 'BadData' }));
    if (st.quota.left < 1) return out({ ...refuse({ code: 'QuotaExceeded' }), retryAt: ctx.quotaReset() });
    let answer = null;
    // the player prologue as every order of the viewer has it: the action bucket, then the province resolved through the clock's turn - 2
    const r = ctx.player(H, t, pv, b => {
      if (!R.residentOk(pv.resolvedNext, b)) return ctx.no('NotResident');
      answer = act(keyOf(H), pv, { ...body, host });
      return answer.ok ? ctx.done(answer.logs.length) : answer;
    });
    if (!r.ok) return out(answer && !answer.ok ? answer : { ...refuse({ code: r.code }), error: r.error ?? `${r.code}: ${TEXT[r.code] ?? r.code}` });
    const track = `proto-${++tracks}`;
    st.sent.set(track, { at: ctx.wall() + ctx.landMs, slot: ctx.slotNow() });
    st.quota.left--;
    return out({ ok: true, track, landMs: ctx.landMs, op: answer.logs[0].op, turn: answer.logs[0].turn, note: answer.note });
  }

  // ------------------------------------------------------------------ the neighbours' script
  const T = { id: null, H: null, state: 'none', mode: null, target: null, arrive: null, log: [] };
  const cinder = ctx.neighbours ? [...holdings.values()].find(H => H.npc && H.p === HOME.p && H.q === HOME.q) ?? null : null;
  if (cinder && ME() && opt.threat !== 'none') { T.H = cinder; T.id = ctx.addHost(cinder, SCRIPT.THREAT_SEQ, 0, SCRIPT.THREAT_TROOPS); T.state = 'wait'; }
  const said = (b, what, more = {}) => { const x = { host: T.id, bell: b, ok: true, code: null, proto: 'threat', what, ...more }; T.log.push(x); st.npcLog.push(x); };
  /** The viewer's banners outside the home province, the first raised first. */
  const abroadOfMine = () => [...lands].flatMap(([k, l]) => (k === pkey(HOME.p, HOME.q) ? [] : l.banners.map((b, slot) => ({ pv: provinceOf(k), slot, b })).filter(x => x.b.used && x.b.holder === meKey()))).sort((a, b) => a.b.raisedTurn - b.b.raisedTurn || a.pv.p - b.pv.p || a.pv.q - b.pv.q || a.slot - b.slot);
  /** A border tile of the viewer's other home-wedge province where the threat's host could raise a banner of its own: the one nearest the viewer's banner there, else the largest patch. */
  function borderTile() {
    const key = keyOf(T.H), base = { id: T.id, faction: T.H.faction, troops: SCRIPT.THREAT_TROOPS * 1000, holder: key };
    for (const pv of [...provinces.values()].filter(x => x.ring >= 2 && x.wedge === home.wedge && x !== home).sort((a, b) => a.p - b.p || a.q - b.q)) {
      const near = abroadOfMine().find(x => x.pv === pv)?.b.pole ?? null, out = [];
      for (let d = 0; d < 6; d++) for (const tile of C.BORDER_ROWS[d]) {
        if (pv.entries.some(e => e.state !== R.ES.FREE && e.tile === tile)) continue;
        const s = supposed(pv, base, tile, []), c = C.canRaise(s.v, s.land, s.e, holderOf(key));
        if (c.ok) out.push({ tile, size: c.size, far: near === null ? 0 : C.steps(tile, near) });
      }
      out.sort((a, b) => a.far - b.far || b.size - a.size || a.tile - b.tile);
      if (out.length) return { p: pv.p, q: pv.q, tile: out[0].tile };
    }
    return null;
  }
  /** The neighbours' turn (after their marches of the M1 script): the walks of their banners, and the one threat. */
  function script(b, t) {
    // a neighbour walks a banner of its own when the walk is near and one of its hosts may (the rule's own test)
    for (const [k, land] of lands) land.banners.forEach((bn, slot) => {
      const P = bn.used ? players.get(bn.holder) : null, pv = provinceOf(k);
      if (!P || !P.H.npc || C.walkDue(view(pv), land, slot).frayAt - pv.resolvedNext > SCRIPT.WALK_AHEAD) return;
      const v = view(pv), e = v.entries.find(x => x.holder === bn.holder && C.tend(v, land, x, holderOf(bn.holder), pv.resolvedNext, { slot }).ok);
      if (e && act(bn.holder, pv, { op: 'tend', host: e.id, slot }, 'script').ok) st.npcLog.push({ host: e.id, bell: b, ok: true, code: null, proto: 'walk', slot });
    });
    if (T.state === 'none' || T.state === 'over') return;
    const key = keyOf(T.H), at = whereIs(T.id), e = at ? at.entries.find(x => x.state !== R.ES.FREE && BigInt(x.id) === BigInt(T.id)) : null;
    if (T.state === 'wait') {
      if (!e) { if (!ctx.inTransit(T.H, T.id)) { T.state = 'over'; said(b, 'lost'); } return; }
      if (e.state !== R.ES.ROSTER || e.pendOp !== R.OP.NONE || ctx.inTransit(T.H, T.id) || b < e.readyBell || R.staminaAt(e.staminaValue, e.staminaBell, b) < R.DEPART_STAMINA || !R.residentOk(at.resolvedNext, b)) return;
      const first = abroadOfMine()[0] ?? null;
      let mode = null;
      // `auto`: at the deadline, the pole of the viewer's first banner outside the home province if there is one and no host of
      // the viewer's nation stands on it, else a border tile next door. `pole`: it waits, with no deadline, for such a pole
      // to be free. `border`: a border tile at the deadline. (It never marches onto a tile a host of the viewer's nation holds.)
      const free = first && b >= first.b.raisedTurn + opt.afterRaise && !first.pv.entries.some(x => x.state !== R.ES.FREE && x.tile === first.b.pole && x.faction === ME().faction);
      if (opt.threat === 'pole') mode = free ? 'pole' : null;
      else if (b >= startTurn + opt.deadline) mode = free && opt.threat !== 'border' ? 'pole' : 'border';
      if (!mode) return;
      const target = mode === 'pole' ? { p: first.pv.p, q: first.pv.q, tile: first.b.pole } : borderTile();
      if (!target) return;
      const m = ctx.scriptMarch(T.H, T.id, at, e, target, b, t);
      if (!m.ok) return;
      Object.assign(T, { state: 'marching', mode, target, arrive: m.arrive });
      said(b, 'left', { mode, arrive: m.arrive });   // (the destination is not said: it is sealed until the arrival turn has ended)
      return;
    }
    const there = provinceOf(T.target), v = view(there), h = entryIn(v, T.id);
    if (T.state === 'marching') {
      if (h && h.tile === T.target.tile && C.stands(v, h)) { T.state = 'standing'; said(b, 'stands', { mode: T.mode, province: [there.p, there.q], tile: h.tile, sinceTurn: h.fromBell }); }
      else if (!ctx.inTransit(T.H, T.id) && !(h && h.tile === T.target.tile)) { T.state = 'over'; said(b, 'turned back'); return; }
      else return;
    }
    if (!h || h.tile !== T.target.tile || h.state !== R.ES.ROSTER) { T.state = 'over'; said(b, 'beaten'); return; }
    const land = landOf(there);
    if (T.mode === 'border') {
      const c = C.canRaise(v, land, h, holderOf(key));
      if (c.ok) { const r = act(key, there, { op: 'raise', host: T.id }, 'script'); if (r.ok) { T.state = 'over'; said(b, 'raised', { slot: r.logs[0].slot, tiles: r.logs[0].tiles.length }); } }
      else if (c.code !== 'StandLonger') { T.state = 'over'; said(b, 'gave up', { why: c.code }); }
    } else {
      const k = C.kindOf(land, h.tile);
      if (k.kind !== 'banner' || land.banners[k.slot].nation === T.H.faction) { T.state = 'over'; said(b, 'nothing to take'); return; }
      const c = C.canFell(v, land, h, holderOf(key), there.resolvedNext, { slot: k.slot });
      if (c.ok) { const r = act(key, there, { op: 'take', host: T.id, slot: k.slot }, 'script'); if (r.ok) { T.state = 'over'; said(b, r.logs[0].op === 'TAKE' ? 'took' : 'pulled down', { slot: k.slot, note: r.note }); } }
      else if (c.code !== 'StandLonger') { T.state = 'over'; said(b, 'gave up', { why: c.code }); }
    }
  }

  // ------------------------------------------------------------------ the records served
  const season = () => ({ rule: C.RULE.rule, version: C.RULE.version, label: { ...LABEL }, scoreNote: { ...SCORE_NOTE }, numbers: C.NUMBERS, reduced: [...REDUCED],
    script: { exploredReach: SCRIPT.EXPLORED_REACH, threat: opt.threat, threatLeavesTurn: startTurn + opt.deadline, threatTroops: SCRIPT.THREAT_TROOPS }, clockLag: SCRIPT.CLOCK_LAG, startTurn, route: '/gw/f/proto/land', preview: '/h/proto/preview', standings: '/h/proto/standings' });
  /** `proto.land` of /h/province/P,Q/latest, or null for a province that has no land record (rings 0 and 1). */
  function province(pv) {
    const land = landOf(pv);
    if (!land) return null;
    const v = view(pv), r = pv.resolvedNext, day = dayOf(r);
    const banners = land.banners.map((b, slot) => {
      if (!b.used) return null;
      const w = C.walkDue(v, land, slot), foe = C.contested(v, land, slot), fall = foe ? C.fallTolls(v, land, slot, foe.faction, foe.fromBell) : null, hk = foe ? holderOf(foe.holder) : null;
      return { slot, pole: b.pole, nation: b.nation, holder: b.holder, tiles: [...b.tiles], raisedTurn: b.raisedTurn, tendedTurn: b.tendedTurn, firm: w.firm, border: C.borderToward(v, land, slot), frayed: b.frayed, walkDue: w.frayAt, strikeAt: w.strikeAt,
        dressedToday: b.dressDay === day, elbowLockedUntil: b.elbow ? b.raisedTurn + N.ELBOW_LOCK : null,
        contested: foe ? { nation: foe.faction, host: String(foe.id), troops: Math.floor(foe.troops / 1000), sinceTurn: foe.fromBell, tolls: fall.tolls, canTakeAtTurn: fall.atTurn, hasFloor: foe.troops >= C.floorFor(v, foe.faction) * 1000 && foe.unit !== R.SCOUT,
          onlyPull: hk ? C.takeStop(v, land, slot, hk) : null } : null };
    }).filter(Boolean);
    const rising = [];
    for (const e of v.entries) {
      const h = e.holder ? holderOf(e.holder) : null;
      if (!h || !(e.state === R.ES.ROSTER || e.state === R.ES.MUSTER_PENDING) || e.unit === R.SCOUT) continue;
      const c = C.canRaise(v, land, e, h);
      if (c.ok || c.code === 'StandLonger') rising.push({ host: String(e.id), nation: e.faction, holder: e.holder, tile: e.tile, sinceTurn: e.fromBell, canRaiseAtTurn: e.fromBell + c.stand, tiles: c.size, patch: c.tiles, trail: c.trail, ready: c.ok, forming: e.state !== R.ES.ROSTER });
    }
    return { resolvedNext: r, day, claim: [...land.claim], banners, trails: C.trails(v, land), counted: [...land.counted], paid: C.paid(land, v.holderNation), holderNation: v.holderNation, heartland: v.heartland, rising,
      villages: land.villageTiles.map((n, site) => (land.villageNation[site] === null ? null : { site, tile: land.sites[site], nation: land.villageNation[site], holder: land.villageHolder[site], tiles: n })).filter(Boolean),
      openedTurn: land.opened, ceiling: N.CEILING_ABROAD };
  }
  /** The totals of every province brought to its own resolved turn (on the fly: nothing is written). */
  const broughtForward = () => [...lands].map(([k, l]) => { const pv = provinceOf(k); return { pv, land: C.accrue(l, pv.wedge, pv.resolvedNext) }; });
  /** GET /h/proto/standings. `tilesNow`: village and banner land a nation holds; `paidNow`: the tile-turns a turn it is paid now (its commons and the keep's share included); `share`: its part of all tile-turns so far. */
  function standings() {
    const all = broughtForward(), nations = [0, 1, 2, 3, 4, 5].map(nation => ({ nation, tilesNow: 0, paidNow: 0, tileTurns: 0, share: 0 }));
    let expected = 0;
    for (const { pv, land } of all) {
      const paidNow = C.paid(land, pv.wedge);
      nations.forEach(x => { x.paidNow += paidNow[x.nation]; x.tileTurns += land.totals[x.nation]; x.tilesNow += land.villageTiles.reduce((a, n, s) => a + (land.villageNation[s] === x.nation ? n : 0), 0) + land.banners.reduce((a, b) => a + (b.used && b.nation === x.nation ? b.tiles.length : 0), 0); });
      expected += N.TILES * (pv.resolvedNext - land.opened);
    }
    const sum = nations.reduce((a, x) => a + x.tileTurns, 0), perTurn = nations.reduce((a, x) => a + x.paidNow, 0);
    // (before the first turn has been counted the share is the share of what a turn pays now)
    nations.forEach(x => { x.share = sum > 0 ? x.tileTurns / sum : x.paidNow / perTurn; });
    // (`byProvince`: who holds how many of each province's 61 tiles, for a view of the whole map without twelve reads)
    const byProvince = all.map(({ pv, land }) => ({ p: pv.p, q: pv.q, holderNation: pv.wedge, heartland: pv.p === HOME.p && pv.q === HOME.q, counted: [...land.counted], paid: C.paid(land, pv.wedge), banners: land.banners.filter(b => b.used).length }));
    return { v: 1, proto: true, rule: C.RULE.rule, turn: Math.max(...all.map(x => x.pv.resolvedNext)), unit: 'tile-turn', note: { ...SCORE_NOTE }, label: { ...LABEL }, nations, check: { sum, expected }, provinces: all.length, perTurn, byProvince };
  }
  /** What one of the viewer's hosts may do now: the page lights its buttons from this and holds no copy of the rule. */
  function hostActs(pv, v, land, e, holder) {
    const r = pv.resolvedNext, out = { host: String(e.id), p: pv.p, q: pv.q, tile: e.tile, unit: e.unit, stands: C.stands(v, e), raise: null, onPole: null, fell: null, tend: [], dress: [] };
    const k = C.kindOf(land, e.tile);
    if (e.unit !== R.SCOUT) { const c = C.canRaise(v, land, e, holder); out.raise = c.ok ? { ok: true, tiles: c.tiles, trail: c.trail, size: c.size, price: c.price, waitTurns: 0 } : { ok: false, code: c.code, need: c.need, ...(c.code === 'StandLonger' ? { tiles: c.tiles, trail: c.trail, size: c.size, price: c.price, waitTurns: c.waitTolls, atTurn: c.need.atTurn } : {}) }; }
    if (k.kind === 'banner' && land.banners[k.slot].pole === e.tile) {
      const b = land.banners[k.slot];
      out.onPole = { slot: k.slot, nation: b.nation, holder: b.holder };
      if (b.nation !== holder.nation) { const c = C.canFell(v, land, e, holder, r, { slot: k.slot }); out.fell = { slot: k.slot, ok: c.ok, code: c.ok ? null : c.code, need: c.ok ? null : c.need, tolls: c.tolls ?? null, atTurn: c.atTurn ?? null, canTake: c.stop === null, onlyPull: c.stop ?? null }; }
    }
    land.banners.forEach((b, slot) => {
      if (!b.used || b.nation !== holder.nation) return;
      // (a walk is made from the patch or the tile next to it; a tile is added from that tile or the one next to it, so from two steps off at most)
      const far = Math.min(...b.tiles.map(t => C.steps(t, e.tile)));
      if (far <= 1) { const t = C.tend(v, land, e, holder, r, { slot }); out.tend.push({ slot, ok: t.ok, code: t.ok ? null : t.code, need: t.ok ? null : t.need, paysToday: players.get(holder.key).walkDay !== dayOf(r) }); }
      if (b.holder !== holder.key || far > 2) return;
      const tiles = [e.tile, ...C.neighbours(e.tile)].filter(x => C.dress(v, land, e, holder, r, { slot, tile: x }).ok);
      const why = tiles.length ? null : C.dress(v, land, e, holder, r, { slot, tile: e.tile }).code;
      out.dress.push({ slot, tiles, code: ['Contested', 'DressedToday', 'PatchFull', 'CeilingReached'].includes(why) ? why : null });
    });
    return out;
  }
  /** `proto.land` of /h/me/<wallet>. */
  function me() {
    const key = meKey(), P = players.get(key), holder = holderOf(key), all = broughtForward();
    let tiles = 0, paidTiles = 0, villageTiles = 0, ledger = 0, nation = 0;
    const banners = [], hosts = [];
    for (const { pv, land } of all) {
      land.villageHolder.forEach((h, s) => { if (h === key) { villageTiles += land.villageTiles[s]; } });
      land.banners.forEach((b, slot) => { if (b.used && b.holder === key) { banners.push({ p: pv.p, q: pv.q, slot, pole: b.pole, tiles: b.tiles.length, frayed: b.frayed }); tiles += b.tiles.length; if (!b.frayed) paidTiles += b.tiles.length; } });
      ledger += land.names[key] ?? 0;
      nation += land.totals[holder.nation];
      const v = view(pv);
      for (const e of v.entries) if (e.holder === key && (e.state === R.ES.ROSTER || e.state === R.ES.MUSTER_PENDING)) hosts.push(hostActs(pv, v, landOf(pv), e, holder));
    }
    const used = P.exploreDay === dayOf(ctx.bellOf(ctx.now())) ? P.exploreToday : 0, homeLand = landOf(home), hv = view(home);
    return { holder: key, nation: holder.nation, tiles: tiles + villageTiles, paidTiles: paidTiles + villageTiles, villageTiles, bannerTiles: tiles, banners, bannersHeld: banners.length, cap: C.capOf(holder), perProvince: N.PER_PROVINCE,
      nextPrice: C.price(hv, homeLand, holder), works: holder.works, worksSpent: P.worksSpent, walkEarned: P.walkEarned, exploreLeftToday: N.EXPLORE_PER_DAY - used, walkPaidToday: P.walkDay === dayOf(home.resolvedNext), elbowUsed: P.elbowUsed,
      ledger, perTurn: paidTiles + villageTiles, shareOfNation: nation > 0 ? ledger / nation : 0, hosts };
  }
  /**
   * GET /h/proto/preview?host=<id>&p=<P>&q=<Q>&tile=<T>: what `canRaise` would say if that host stood on that tile
   * after the turns the rule asks: `{ok: true, tiles, trail, size, price, waitTurns}` or `{ok: false, code, need}`.
   * For a tile the host would have to march to, the trail is the one the world's own route for that march brings
   * (the rules kernel's `plan_path`, as the page plans). Without `host`: a host formed there now (`troops`, 100 by
   * default). Without `tile`: every tile of the province, `{all: [...]}`. Read-only: nothing is written.
   */
  function preview(url) {
    const q = url.searchParams, H = ME(), key = meKey(), pv = provinceOf([q.get('p') ?? HOME.p, q.get('q') ?? HOME.q]);
    if (!H || !pv || !landOf(pv)) return { v: 1, proto: true, ok: false, code: 'BadData', need: null };
    const id = hostIdOf(q.get('host')), at = id !== null ? whereIs(id) : null, real = at ? at.entries.find(e => e.state !== R.ES.FREE && BigInt(e.id) === BigInt(id)) : null;
    if (id !== null && (!real || !hostParts(id) || keyOf(H) !== `${hostParts(id).p},${hostParts(id).q},${hostParts(id).site}`)) return { v: 1, proto: true, ok: false, code: 'NotOwner', need: null };
    const troops = Math.max(1, Number(q.get('troops')) || N.FLOOR_HOME) * 1000, holder = holderOf(key), wait = C.standToRaise(view(pv), holder.nation);
    const one = tile => {
      let mode, s, extra = {};
      if (real && at === pv && real.tile === tile) {
        // it stands there already, or is forming there: judged as it is, the count as it runs (`waitTurns` is what is left of it)
        const v = view(pv), e = entryIn(v, id), c = C.canRaise(v, landOf(pv), e, holder);
        return c.ok || c.code === 'StandLonger' ? { tile, mode: 'standing', ok: true, tiles: c.tiles, trail: c.trail, flower: c.flower, size: c.size, price: c.price, waitTurns: c.waitTolls ?? 0, atTurn: e.fromBell + c.stand } : { tile, mode: 'standing', ok: false, code: c.code, need: c.need };
      }
      if (real) {
        // it would march: the world's own route for that march
        mode = 'march';
        if (real.unit === R.SCOUT) return { tile, mode, ok: false, code: 'Scouts', need: null };
        const plan = K.call('plan_path', { start: tileHex(at.p, at.q, real.tile), dest: tileHex(pv.p, pv.q, tile), unit: real.unit, blocked: [], seeds: RINGS });
        if (!plan.ok || !plan.value || plan.value.dirs.length > R.MAX_PATH_STEPS) return { tile, mode, ok: false, code: 'NoPath', need: null };
        const way = [];
        for (const x of ctx.routeTiles(tileHex(at.p, at.q, real.tile), plan.value.dirs).slice(0, N.TRAIL_STEPS)) { if (x.p !== pv.p || x.q !== pv.q) break; way.push(x.tile); }
        s = supposed(pv, { id, faction: real.faction, unit: real.unit, troops: real.troops, holder: key }, tile, way);
        extra = { steps: plan.value.dirs.length };
      } else {
        mode = 'form';
        if (pv.p !== H.p || pv.q !== H.q) return { tile, mode, ok: false, code: 'NotHere', need: { why: 'muster' } };
        s = supposed(pv, { id: 0n, faction: H.faction, unit: 0, troops, holder: key }, tile, null);
      }
      const c = C.canRaise(s.v, s.land, s.e, holder);
      return c.ok ? { tile, mode, ok: true, tiles: c.tiles, trail: c.trail, flower: c.flower, size: c.size, price: c.price, waitTurns: wait, ...extra } : { tile, mode, ok: false, code: c.code, need: c.need, ...extra };
    };
    const head = { v: 1, proto: true, p: pv.p, q: pv.q, host: id === null ? null : String(id), resolvedNext: pv.resolvedNext, stand: wait, floor: C.floorFor(view(pv), holder.nation) };
    if (q.get('tile') === null || q.get('tile') === '' || q.get('tile') === 'all') return { ...head, ok: true, all: [...Array(N.TILES).keys()].map(one) };
    const tile = Number(q.get('tile'));
    if (!(Number.isInteger(tile) && tile >= 0 && tile < N.TILES)) return { ...head, ok: false, code: 'BadData', need: null };
    return { ...head, ...one(tile) };
  }
  /** For tests and the play-through: the lands in a few lines. */
  function summary() {
    // (while the threat's host is on its sealed march the summary says neither where it goes nor which kind of place: only that it left and when it arrives)
    const sealed = T.state === 'marching';
    const out = { threat: { host: T.id === null ? null : String(T.id), state: T.state, mode: sealed ? null : T.mode, target: sealed ? null : T.target, arrive: T.arrive }, lands: {} };
    for (const [k, land] of lands) if (land.banners.some(b => b.used)) out.lands[k] = land.banners.map((b, slot) => (b.used ? { slot, pole: b.pole, nation: b.nation, holder: b.holder, tiles: b.tiles.length, frayed: b.frayed } : null)).filter(Boolean);
    return out;
  }

  return {
    keeper, arrived, exploreLimit, exploredNow, script, route, season, province, me, standings, preview, summary,
    /** For tests: an act of the rule by a player of the world (`key`: "p,q,site"), judged and written as the viewer's are, without the relay's envelope. */
    act: (key, at, body, by) => act(key, provinceOf(at), { ...body, host: hostIdOf(body.host) }, by),
    /** For tests: the land record of a province (a copy), the province as the rule's functions are given it, the player as they read it, the threat's own log. */
    land: (p, q) => { const l = lands.get(pkey(p, q)); return l ? C.cloneLand(l) : null; },
    view: (p, q) => view(provinces.get(pkey(p, q))),
    holder: key => holderOf(key ?? meKey()),
    setLand: (p, q, land) => { lands.set(pkey(p, q), C.cloneLand(land)); },
    threat: T,
    key: meKey,
  };
}
