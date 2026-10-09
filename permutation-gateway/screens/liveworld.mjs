// The live mode of the screenshot fixture (UX design 12.4): the same small
// world as world.mjs, with a clock that runs and a relay that takes orders,
// so the page's own triggers (the toll, the turn's results, the moments,
// the battle, the accepted and the refused answer) can be seen and tested
// without a chain. Nothing here is a rule of the game: it is a stand-in
// that answers in the shapes the real herald and relay use.
//
//   the clock    The page's first /h/season starts it, `delay` seconds
//                before turn 42 ends (the season record's latestUnix and
//                latestSlot then follow the wall clock). The page tolls by
//                its own chain clock; this world turns at the same moment.
//   the turn     From turn 43 on the herald's answers show: the building in
//                the viewer's queue done (its done_at passes twelve seconds
//                into the turn; the page sees that by its own clock), the stores
//                risen (a credit, as loot or a refund leaves them), the
//                viewer's sealed march revealed at the camp (its
//                ArrivalSlot in the home province's envelope of bell 43 and
//                the REVEAL record), and the clash of bell 41 at the
//                viewer's village resolved (the Province's resolve summary,
//                the CLASH record, the report under /h/clash).
//   the relay    Harvest, Build (a building), Muster, Explore and Depart
//                are checked as the relay checks them (the sponsored shape,
//                its fee payer, the session key's signature), answered with
//                `{ok, signature}` (the fee payer's signature of the very
//                message), reported by GET /f/tx as `unknown` and then
//                `landed`, and written into the Holding, the Province and
//                the log as the program writes them. One Depart a turn: the
//                next is refused (`Bucket`), so the refusal can be seen.
//                Every other shape gets the fixture's old refusal.
//
// A refusal is a `{ok: false, code, error}` body with HTTP 200, as the
// fixture always answered (the real relay answers 4xx: the browser suites
// count any HTTP error as a failure of the page).
import * as W from './world.mjs';
import { keyFromSeed, verify } from '../../permutation-server/web/session.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { classify } from '../../permutation-server/web/sdk/frontier/shapes.mjs';
import { encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { fromBase64, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { BUILD_ITEMS } from '../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../permutation-server/web/frontier/fi18n.mjs';
import { ctHash, sealRoot, unpack } from '../../permutation-server/web/frontier/seal.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { DEPART_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';

const { GENESIS_TS, BELL, LATEST_UNIX, LATEST_SLOT, HOME, CAMP_TILE, HOSTS, PROGRAM } = W;

/** The turn the page's clock shows at load, and the constants of the live turn. */
export const LIVE = Object.freeze({
  TURN: Math.floor((LATEST_UNIX - GENESIS_TS) / 600),
  /** Seconds from the page's first /h/season to the toll (the default; `live(true, {delay})`). */
  DELAY: 8,
  /** Wall ms a relayed transaction takes to land (GET /f/tx says `unknown` until then). */
  LAND_MS: 1_200,
  /**
   * The building in the viewer's queue is done this many seconds after the toll: a woodcutter's (catalog item 1),
   * +10 wood an hour. (Twelve: after the toll's banner, the unsealing and the battle of the turn have played.)
   */
  BUILT_AFTER: 12,
  BUILDING: Object.freeze({ kind: 1, arg: 1, delta: 10_000, item: 1 }),
  /** What the stores gain at the turn (whole units by resource). */
  CREDIT: Object.freeze([180, 120, 0, 0, 0, 0, 0, 0]),
  /** The bell of the clash the turn reports. */
  CLASH_BELL: BELL + 1,
  /** A building ordered through the relay takes this long (the first copy's hour). */
  BUILD_SECS: 3_600,
  DEPARTS_PER_TURN: 1,
  FEE_SEED: new Uint8Array(32).fill(0x33),
});
const QUEUE_PRODUCTION = 1, ENTRY_ROSTER = 1, ENTRY_MUSTER_PENDING = 2, ENTRY_DEPARTED = 3, NO_TILE = 0xff;
const PS2 = Object.freeze({ HARVEST: 20, BUILD: 21, MUSTER: 23, EXPLORE: 26, DEPART: 30, REVEAL: 31, TRANSIT_SETTLED: 34, CLASH: 41 });
const REFUSED = Object.freeze({
  Bucket: 'Bucket: this turn\'s march has left already (the live fixture takes one Depart a turn)',
  QueueFull: 'QueueFull: four buildings are under way',
  Insufficient: 'Insufficient: the stores or the reserve do not hold that much',
  HostBusy: 'HostBusy: this host cannot take that order now',
  Explored: 'Explored: that tile was explored already',
  TransitState: 'TransitState: that transit record is in use',
  BadData: 'BadData: the order names something that is not there',
});

/**
 * A live world: `{seen(), now(), turn(), advance(), view(), clock(), relay(method, path, body), orders}`.
 * `viewer`: the fixture's viewer (world.mjs `viewer()`); `delay`, `landMs` as LIVE; `wall`: ms clock (tests pass their own).
 */
export function createLive({ viewer, delay = LIVE.DELAY, landMs = LIVE.LAND_MS, wall = () => Date.now() } = {}) {
  const T1 = GENESIS_TS + 600 * (LIVE.TURN + 1);   // the toll: turn 43 begins
  let t0 = null, base = T1 - delay;
  const at = ms => (t0 === null ? base : base + (ms - t0) / 1000);
  const now = () => at(wall());
  const turnAt = t => Math.floor((t - GENESIS_TS) / 600);
  const fee = keyFromSeed(LIVE.FEE_SEED);

  // ---- what the turn and the orders change
  const st = {
    stores: W.HOLDING_STORES.map(([value, rate, cap]) => ({ value: value * 1000, rate: rate * 1000, cap: cap * 1000, t0: W.HOLDING_STORES_T0 })),
    queue: [{ doneAt: T1 + LIVE.BUILT_AFTER, kind: LIVE.BUILDING.kind, arg: LIVE.BUILDING.arg, delta: LIVE.BUILDING.delta }],
    reserve: [...W.HOLDING_RESERVE], hostSeq: 10, lastOwner: LATEST_UNIX - 3_600,
    transit: [null, W.marchingTransit(W.liveSealRoot()), null, null], explore: null,
    entries: W.HOME_ENTRIES(), explored: 0n,
    resolvedNext: BELL + 1, summary: { bell: W.REPORT_BELL, engagements: 3, arrivals: 2, destroyed: 1, bounced: 0 },
    slots: [], turned: false, clashBell: null,
    // the records the fixture's own log lacks for this world: the raid's departure, and the order of the building in the queue
    log: [
      { kind: PS2.DEPART, bell: BELL - 1, fields: { host_id: W.RAIDER, origin_p: HOME.p, origin_q: HOME.q, origin_tile: W.HOME_SITES[7], depart_bell: BELL - 1, arrive_bell: LIVE.CLASH_BELL, dep_mass: 900_000, march_stamina: DEPART_STAMINA } },
      { kind: PS2.BUILD, bell: BELL + 1, fields: { p: HOME.p, q: HOME.q, site: HOME.site, item: LIVE.BUILDING.item, done_at: T1 + LIVE.BUILT_AFTER } },
    ],
    quotaLeft: 38, departs: new Map(), sent: new Map(), pending: [], tracks: 0,
  };
  const orders = [];   // every order the relay answered: {name, ok, code?, turn}

  const storeAt = (s, t) => Math.min(Math.max(s.cap, s.value), s.value + Math.floor((s.rate * Math.max(0, t - s.t0)) / 3600));
  const settleStores = t => { for (const s of st.stores) { s.value = storeAt(s, t); s.t0 = t; } };
  /** The owner touch: buildings done by `t` leave the queue and raise their production from the moment they were done. */
  function touch(t) {
    for (const q of st.queue.filter(x => x.doneAt <= t).sort((a, b) => a.doneAt - b.doneAt)) {
      settleStores(q.doneAt);
      if (q.kind === QUEUE_PRODUCTION) st.stores[q.arg].rate += q.delta;
    }
    st.queue = st.queue.filter(x => x.doneAt > t);
    settleStores(t);
    st.lastOwner = t;
  }
  /** Turn 43 has begun: what the herald's answers show from now on. */
  function turnOver() {
    st.turned = true;
    settleStores(T1);
    LIVE.CREDIT.forEach((n, r) => { st.stores[r].value += n * 1000; });
    st.slots.push(W.liveArrivalSlot());
    st.resolvedNext = LIVE.CLASH_BELL + 1;
    st.summary = { bell: LIVE.CLASH_BELL, engagements: 3, arrivals: 1, destroyed: 1, bounced: 0 };
    st.clashBell = LIVE.CLASH_BELL;
    const b = LIVE.TURN + 1;
    st.log.push(
      { kind: PS2.REVEAL, bell: b, fields: { p: HOME.p, q: HOME.q, arrive: W.MARCH_ARRIVE, faction: 0, i: 0, host_id: HOSTS.marching, tile: CAMP_TILE, stance: 1, retreat: 0 } },
      { kind: PS2.CLASH, bell: b, fields: { p: HOME.p, q: HOME.q, bell: LIVE.CLASH_BELL, engagements: 3 } },
      { kind: PS2.TRANSIT_SETTLED, bell: b, fields: { host_id: W.RAIDER, outcome: 4 } },
    );
  }
  /** Bring the world up to the wall clock: the turn, then every relayed transaction that has landed. */
  function settle() {
    const ms = wall();
    if (!st.turned && at(ms) >= T1) turnOver();
    const due = st.pending.filter(x => x.at <= ms).sort((a, b) => a.at - b.at);
    st.pending = st.pending.filter(x => x.at > ms);
    for (const x of due) x.apply(Math.floor(at(x.at)));
  }

  // ---- the relay
  const refused = code => ({ status: 200, body: { ok: false, code, error: REFUSED[code] ?? code } });
  const entryOf = id => st.entries.find(e => BigInt(e.id) === BigInt(id)) ?? null;
  /** What an order needs and what it writes: `{code}` to refuse, `{apply(t)}` to take, null for a shape this world does not play. */
  function order(shape) {
    const d = shape.data, t = now(), b = turnAt(t);
    switch (shape.name) {
      case 'Harvest':
        return { apply: ts => { touch(ts); st.log.push({ kind: PS2.HARVEST, bell: turnAt(ts), fields: { p: HOME.p, q: HOME.q, site: HOME.site } }); } };
      case 'Build': {
        const item = BUILD_ITEMS[d.item];
        if (!item?.cost) return null;   // the walls name the Province and have their own record: not played here
        if (st.queue.filter(q => q.doneAt > t).length + st.pending.filter(x => x.name === 'Build').length >= 4) return { code: 'QueueFull' };
        if (item.cost.some((n, r) => storeAt(st.stores[r], t) < n * 1000)) return { code: 'Insufficient' };
        return { apply: ts => {
          touch(ts);
          item.cost.forEach((n, r) => { st.stores[r].value -= n * 1000; });
          const doneAt = ts + LIVE.BUILD_SECS;
          st.queue.push({ doneAt, kind: QUEUE_PRODUCTION, arg: RESOURCE_ORDER.indexOf(item.resource), delta: item.perHour * 1000 });
          st.log.push({ kind: PS2.BUILD, bell: turnAt(ts), fields: { p: HOME.p, q: HOME.q, site: HOME.site, item: d.item, done_at: doneAt } });
        } };
      }
      case 'Muster': {
        if (!(d.unit >= 0 && d.unit < 7) || d.troops < 100 || !(d.tile >= 0 && d.tile < 61)) return { code: 'BadData' };
        if (st.reserve[d.unit] < d.troops) return { code: 'Insufficient' };
        st.reserve[d.unit] -= d.troops;   // held at once: two musters in flight cannot spend the same troops
        return { apply: ts => {
          touch(ts);
          const id = hostId({ ...HOME, seq: st.hostSeq++ }), tb = turnAt(ts);
          // muster-pending (state 2): it joins the roster at the next bell
          st.entries.push({ id, faction: 0, unit: d.unit, tile: d.tile, state: ENTRY_MUSTER_PENDING, troops: d.troops * 1000, staminaValue: 120, staminaBell: tb, dealtBps: 10_000, readyBell: tb, fromBell: tb + 1 });
          st.log.push({ kind: PS2.MUSTER, bell: tb, fields: { host_id: id, unit: d.unit, troops: d.troops, tile: d.tile, entry: st.entries.length - 1 } });
        } };
      }
      case 'Explore': {
        const e = entryOf(d.host_id);
        if (!e || e.state !== ENTRY_ROSTER || e.unit !== 6 || st.explore || st.pending.some(x => x.name === 'Explore')) return { code: 'HostBusy' };
        const tiles = [...d.tiles].slice(0, d.n);
        if (!(d.n === 1 || d.n === 2) || tiles.some(x => !(x >= 0 && x < 61))) return { code: 'BadData' };
        if (tiles.some(x => (st.explored >> BigInt(x)) & 1n)) return { code: 'Explored' };
        return { apply: ts => {
          touch(ts);
          for (const x of tiles) st.explored |= 1n << BigInt(x);
          const rec = [tiles[0], d.n === 2 ? tiles[1] : NO_TILE];
          st.explore = { bell: turnAt(ts), p: HOME.p, q: HOME.q, tiles: rec, host: BigInt(d.host_id), state: 1 };
          st.log.push({ kind: PS2.EXPLORE, bell: turnAt(ts), fields: { host_id: BigInt(d.host_id), p: HOME.p, q: HOME.q, n: d.n, tiles: Uint8Array.from(rec) } });
        } };
      }
      case 'Depart': {
        if ((st.departs.get(b) ?? 0) >= LIVE.DEPARTS_PER_TURN) return { code: 'Bucket' };
        const e = entryOf(d.host_id);
        if (!e || e.state !== ENTRY_ROSTER) return { code: 'HostBusy' };
        if (!(d.transit_slot >= 0 && d.transit_slot < 4) || st.transit[d.transit_slot]) return { code: 'TransitState' };
        st.departs.set(b, (st.departs.get(b) ?? 0) + 1);
        const root = sealRoot(d.commit, ctHash(d.seal));
        return { apply: ts => {
          touch(ts);
          const tb = turnAt(ts);
          st.transit[d.transit_slot] = { state: 1, unit: e.unit, faction: e.faction, originTile: e.tile, originP: HOME.p, originQ: HOME.q, hostId: BigInt(d.host_id), departBell: tb, arriveBell: d.arrive_bell,
            departTs: ts, depMass: e.troops, marchStamina: DEPART_STAMINA, dealtBps: 10_000, sealRoot: root, tip: BigInt(d.tip), flags: 3 };
          const left = Math.max(0, Math.min(120, e.staminaValue + Math.max(0, tb - e.staminaBell)) - DEPART_STAMINA);
          Object.assign(e, { state: ENTRY_DEPARTED, staminaValue: left, staminaBell: tb });
          st.log.push({ kind: PS2.DEPART, bell: tb, fields: { host_id: BigInt(d.host_id), origin_p: HOME.p, origin_q: HOME.q, origin_tile: e.tile, depart_bell: tb, arrive_bell: d.arrive_bell, dep_mass: e.troops,
            march_stamina: DEPART_STAMINA, tip: BigInt(d.tip), seal_root: root, commit: Uint8Array.from(d.commit), seal: Uint8Array.from(d.seal) } });
        } };
      }
      default:
        return null;
    }
  }
  /** POST /f/relay: the checks of the real relay that need no chain, then the order. */
  async function sponsor(b) {
    const key = await fee;
    let tx, shape;
    try {
      const wire = fromBase64(String(b?.tx ?? ''));
      tx = parseTransaction(wire);
      shape = classify(tx, { programId: PROGRAM, wireBytes: wire.length });
    } catch (e) {
      return { status: 200, body: { ok: false, code: 'InvalidTransaction', error: String(e?.message ?? e) } };
    }
    if (!shape.ok) return { status: 200, body: { ok: false, code: shape.code, error: `relay refused: ${shape.problem}` } };
    if (shape.feePayer !== key.publicKey) return { status: 200, body: { ok: false, code: 'RelayRejected', error: 'relay refused: the fee payer is not a key of this relay' } };
    if (shape.authority) {
      const sig = tx.signatures[tx.signers.indexOf(shape.authority)];
      if (shape.authority !== viewer?.session || !(await verify(shape.authority, tx.message, sig))) return { status: 200, body: { ok: false, code: 'BadSignature', error: 'the authority\'s signature is missing or invalid' } };
    }
    settle();
    const o = order(shape);
    if (!o) return null;
    const turn = turnAt(now());
    if (o.code) { orders.push({ name: shape.name, ok: false, code: o.code, turn }); return refused(o.code); }
    const signature = toBase58(await key.sign(tx.message));
    const lands = wall() + landMs;
    st.sent.set(signature, { at: lands, slot: LATEST_SLOT + 200 + st.sent.size });
    st.pending.push({ at: lands, name: shape.name, apply: o.apply });
    st.quotaLeft = Math.max(0, st.quotaLeft - 1);
    orders.push({ name: shape.name, ok: true, signature, turn });
    return { status: 200, body: { ok: true, signature } };
  }
  /** POST /f/reveal: the keeper's answer; the march's ArrivalSlot stands in its destination's envelope from now on. */
  function reveal(b) {
    let p;
    try { p = unpack(fromBase64(String(b?.plain_b64 ?? ''))); } catch { return { status: 200, body: { ok: false, code: 'BadPlaintext', error: 'plain_b64 must be base64 of 37 bytes' } }; }
    settle();
    const tr = st.transit[b.transit_slot];
    if (!tr || BigInt(tr.hostId) !== p.hostId || tr.arriveBell !== p.arriveBell) return { status: 200, body: { ok: false, code: 'TransitState', error: REFUSED.TransitState } };
    const key = `ar:${p.destP},${p.destQ},${p.arriveBell},0,${b.transit_slot}`;
    if (p.destP === HOME.p && p.destQ === HOME.q && !st.slots.some(s => s.key === key)) {
      st.slots.push({ key, slot: LATEST_SLOT + 1_600 + st.slots.length, bytes: toBase64(W.arrivalSlotBytes({ p: p.destP, q: p.destQ, bell: p.arriveBell, i: b.transit_slot, unit: tr.unit, stance: p.stance, tile: p.destTile, retreatBps: p.retreatBps, hostId: p.hostId, depMass: tr.depMass })) });
      st.log.push({ kind: PS2.REVEAL, bell: turnAt(now()), fields: { p: p.destP, q: p.destQ, arrive: p.arriveBell, faction: 0, i: b.transit_slot, host_id: p.hostId, tile: p.destTile, stance: p.stance, retreat: p.retreatBps } });
    }
    return { status: 202, body: { accepted: true, track: `live-${++st.tracks}` } };
  }

  return {
    orders,
    /** The page's first /h/season: the clock starts. */
    seen() { if (t0 === null) t0 = wall(); },
    now, turn: () => turnAt(now()),
    /** When the turn ends (chain seconds). */
    tollAt: T1,
    /** The next turn begins now (a page that is open learns it at its next season poll): the new turn. */
    advance() {
      const t = now(), next = GENESIS_TS + 600 * (turnAt(t) + 1);
      base += next - t;
      settle();
      return turnAt(now());
    },
    /** The clock alone (every stage): what the season record says. */
    clock() {
      settle();
      const t = now();
      return { headSeq: W.HEAD_SEQ, latestUnix: Math.floor(t), latestSlot: LATEST_SLOT + 1 + Math.floor(Math.max(0, t - (T1 - delay)) * 2.5) };
    },
    /** The live view world.mjs draws the viewer's village from (stage `holding`). */
    view() {
      const c = this.clock(), turn = turnAt(now());
      return {
        ...c, headSeq: W.HEAD_SEQ + st.log.length, turn, quotaLeft: st.quotaLeft,
        holding: {
          hostSeq: st.hostSeq, lastOwnerAction: st.lastOwner,
          stores: st.stores.map(s => ({ value: s.value, rate: s.rate, cap: s.cap, t0: s.t0, frac: 0 })),
          queue: st.queue.map(q => ({ ...q })), reserve: [...st.reserve], transit: st.transit.map(x => (x ? { ...x } : null)),
          ...(st.explore ? { explore: { ...st.explore } } : {}),
        },
        province: {
          // a mustered host joins the roster when its bell comes
          entries: st.entries.map(e => (e.state === ENTRY_MUSTER_PENDING && e.fromBell <= turn ? { ...e, state: ENTRY_ROSTER } : { ...e })),
          resolvedNext: Math.max(st.resolvedNext, turn - 1), resolveSummary: { ...st.summary }, exploredMask: st.explored,
        },
        slots: st.slots.map(s => ({ ...s })), envelopeBell: st.turned ? turn : BELL,
        anchoredThrough: st.clashBell ?? BELL, clashBell: st.clashBell, log: st.log,
      };
    },
    /** The relay's answer `{status, body}`, or null for what this world does not play (the fixture's old refusal then). */
    async relay(method, path, body) {
      const key = await fee;
      settle();
      const quota = { left: st.quotaLeft, resetsAt: GENESIS_TS + 86_400 };
      if (method === 'GET' && path === '/gw/f/relay') return { status: 200, body: { feePayer: key.publicKey, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000, programId: PROGRAM, quota } };
      if (method === 'GET' && path === '/gw/f/quota') return { status: 200, body: { ...quota, lamportsLeft: '400000000' } };
      if (method === 'GET' && path.startsWith('/gw/f/tx/')) {
        const s = st.sent.get(decodeURIComponent(path.slice('/gw/f/tx/'.length)));
        return { status: 200, body: s && s.at <= wall() ? { state: 'landed', slot: s.slot } : { state: 'unknown' } };
      }
      if (method === 'POST' && path === '/gw/f/relay') return sponsor(body);
      if (method === 'POST' && path === '/gw/f/reveal') return reveal(body);
      if (method === 'POST' && path === '/gw/f/nudge') return { status: 200, body: { queued: true, blocking: false } };
      return null;
    },
  };
}
