// The play controller (W3-F): what the game page does between the herald
// (reads), the relay (writes) and the screens. It keeps the viewer's state
// in FS (fstate.mjs), refreshes it on the herald poll schedule (§4.2: 10 s
// while a march or a transaction is in flight, else 30 s; paused while the
// page is hidden, except the marchbook's self-reveal timer), runs the
// self-reveal (I-24, §9.1), and turns every `data-act` of the screens into
// one action: build → check → sign → relay → track (fplay.mjs), the march
// through fmarch.sendMarch. Nothing here decides a rule; the program does.
import { conquestEnabled, territoryStandings, keepFromProvince, applyControl, outpostOffer, mergeKeepEvents } from './fconquest.mjs';
import { holdingByRef } from './fland.mjs';
import { FS, invalidate, activeHolding } from './fstate.mjs';
import { updateLife } from './people/life.mjs';
import * as io from './fchainio.mjs';
import * as fsession from './fsession.mjs';
import * as book from './marchbook.mjs';
import { submit, track, accountsFor, campMaskOf, campWinner } from './fplay.mjs';
import { sendMarchRetrying, planRoute, earliestBell, arrivalWindow, tipOptions, incomingWarnings, departMargin, RETREAT_CHOICES } from './fmarch.mjs';
import { landState, hostsIn, TICKET_SEEN_BELLS, FIRST_TICKET_RING, BUILD_ITEMS, UNIT_ORDER } from './fland.mjs';
import { BUILDINGS, TIERS, unitCount } from './fi18n.mjs';
import { settled, copyNumber, buildSecs, doneAfterQueue, grownSince, ITEM_TIER_UP, ITEM_WALLS, TIER_UP, WALLS } from './hud/rulebook.mjs';
import { exploreResultTurn, exploreResultWords } from './hud/orderparts.mjs';
import { planTicket } from './fjoin.mjs';
import { toggleTile } from './screens/explore.mjs';
import { composerArrival, composerMarch } from './screens/march.mjs';
import { sealMarch, unpack, ctHash as ctHashOf, sealRoot as sealRootOf } from './seal.mjs';
import { bellAt, bellStart, pipeline, archivePartOf, pollCap } from './clock.mjs';
import { regionOf, ringOf, ringProvinces, wedgeOf } from './fgeo.mjs';
import { hostParts, hostId } from './faddr.mjs';
import { decodePage } from './flog.mjs';
import { nextPoll, BELLS_PER_DAY } from './herald.mjs';
import { kernel as loadKernel, UNITS } from './wasm.mjs';
import { uiKey, uiStorage, loadUi, saveUi, landKey, loadLand, saveLand, LAND_DEFAULTS } from './fui.mjs';
import * as wallet from '../wallet.mjs';
import { decode as fromBase58, encode as toBase58 } from '../sdk/base58.mjs';
import { fromBase64 } from '../sdk/bytes.mjs';
import { L, fmtNum } from '../lang.mjs';
import { emit as fxEmit } from './fx/bus.mjs';
import { reachOrigins } from './screens/conquest.mjs';
import { cachedReach, reachKey, reachableKeeps } from './fkeepreach.mjs';
import * as fprize from './fprize.mjs';
import { instantHomeEnabled, HOME_GRANTED, planHomes, homeSites, sameHome, homeKey, loadHome, saveHome, grantId } from './home.mjs';
// the prototype rule "banners" (a design tried in the sample world, never sent to a chain): its routes and the reading of its records
import * as protoIo from './proto/orders.mjs';
import * as pm from './proto/hand-model.mjs';

const SESSION_DAYS = 30 * 86_400;
const now = () => FS.chain?.now() ?? 0;
const nowBell = () => (FS.clock ? bellAt(FS.clock.genesisTs, now()) ?? 0 : 0);
/** The margin a departure is planned with (fmarch.mjs `departMargin`): 90 s on the chain's clock, more game seconds on a clock that runs fast. */
const margin = () => departMargin(FS.chain?.rate);
const scope = () => io.scope();
/** Save UI preferences once a season is pinned (convenience only). */
const saveUiPatch = patch => { const sc = scope(); if (sc) FS.ui = saveUi(uiStorage, uiKey(sc), patch); };
/** The land record of this season and wallet (fui.mjs; the automatic site ticket's state). */
const landKeyNow = () => (scope() && FS.wallet?.address ? landKey(scope(), FS.wallet.address) : null);
const readLand = () => { const k = landKeyNow(); FS.landRec = k ? loadLand(uiStorage, k) : (FS.landRec ?? { ...LAND_DEFAULTS }); return FS.landRec; };
const homeKeyNow = () => scope() ? homeKey(scope(), FS.wallet?.address) : null;
const readHome = () => homeKeyNow() ? loadHome(uiStorage, homeKeyNow()) : { selected: null, pending: null, seen: null };
const saveHomePatch = patch => homeKeyNow() ? saveHome(uiStorage, homeKeyNow(), patch) : null;
const saveLandPatch = patch => { const k = landKeyNow(); FS.landRec = k ? saveLand(uiStorage, k, patch) : { ...(FS.landRec ?? LAND_DEFAULTS), ...patch }; return FS.landRec; };
const bookKey = () => (FS.wallet && scope() ? book.bookKey(scope(), FS.wallet.address) : null);
// Notices keep a thunk or the failure itself, so a language switch re-renders them in the new language.
const setNotice = n => { FS.notice = n; invalidate('panel'); };
const busy = text => setNotice({ busy: true, text });
const done = text => setNotice({ ok: true, text });
const failed = r => {
  if (r?.code === 'InviteRequired') FS.inviteRequired = true;
  // (a refusal of the prototype rule "banners" on one of the basic game's own routes — the day's limit of explorations,
  // which the sample world answers to an Explore — is said in the rule's sentence, only while the prototype is on)
  if (FS.proto && r && !r.text && pm.REFUSALS.includes(r.code)) return setNotice({ ok: false, ...r, text: () => pm.refusalText(r.code, { need: r.need }) });
  return setNotice({ ok: false, ...r, text: r?.text ?? null });
};

/** The addresses and signer context of a player action. */
function ctx(extra = {}) {
  const pin = io.pinned();
  return { addresses: pin.addresses, wallet: FS.wallet.address, actor: FS.session?.publicKey, faction: FS.citizen?.faction, profile: pin.profile, ...extra };
}

/** The send and the follow-up (fplay.mjs); tests put stand-ins here to play a relay and a chain. */
let tx = { submit, track };
export function useTransport(t) { tx = t ? { submit: t.submit ?? submit, track: t.track ?? track } : { submit, track }; }
/** The prize pool's reads and the paid Join (fprize.mjs); tests put stand-ins here. */
let prizeIo = fprize;
export function usePrize(p) { prizeIo = p ? { ...fprize, ...p } : fprize; }

/** How often the pool is read again (ms), and when it last was. */
export const PRIZE_REFRESH_MS = 15_000;
let prizeReadAt = 0;
/**
 * The season's prize pool (テストUSDC; null when the season has none) and,
 * once the result is final, the published achievements ledger.
 */
export async function refreshPrize({ force = false, at = Date.now() } = {}) {
  if (!io.relay() || (!force && at - prizeReadAt < PRIZE_REFRESH_MS)) return;
  prizeReadAt = at;
  const r = await prizeIo.loadPrize(FS.wallet?.address ?? null);
  if (!r.ok) return;
  FS.prize = r.pool;
  if (r.pool && r.pool.state !== 'open') {
    const g = await prizeIo.loadLedger();
    if (g.ok) FS.prizeLedger = g.ledger;
  }
  invalidate('panel');
}

/** The paid Join of a season with a pool: test tokens from the faucet if the wallet is short, then Pay and Join in one signed transaction (x402). */
async function paidJoin(s, { onSent, onLost } = {}) {
  const w = wallet.connected();
  if (!w) return failed({ code: 'NoWallet' });
  busy(() => L`参加費（テストUSDC）を支払って参加しています…`);
  FS.inFlight = (FS.inFlight ?? 0) + 1;
  try {
    await refreshPrize({ force: true });
    const fee = BigInt(FS.prize.fee);
    const before = FS.prize.wallet?.balance ?? '0';
    if (BigInt(before) < fee) {
      const f = await prizeIo.faucet(w.address);
      if (!f.ok) return failed(f);
      await refreshPrize({ force: true });
    }
    const funded = FS.prize.wallet?.balance ?? before;
    const r = await prizeIo.payAndJoin({ wallet: w, faction: FS.joinDraft.faction, session: s, sessionExpiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600), maxFee: fee });
    if (!r.ok) return failed(r);
    onSent?.(r);
    const t = await tx.track(r.signature);
    if (!t.ok && (t.state === 'failed' || t.state === 'expired')) onLost?.(t);
    if (!t.ok) return failed(t);
    await refreshPrize({ force: true });
    // What the wallet held before and after (the page shows both).
    FS.prizePayment = { signature: r.signature, before: funded, after: FS.prize.wallet?.balance ?? null, fee: String(fee) };
    done(() => L`参加費を支払い、参加しました`);
    return r;
  } finally {
    FS.inFlight = Math.max(0, (FS.inFlight ?? 1) - 1);
  }
}

/** The effects bus's word of an own action (fx/stage.mjs: busy, sent, landed, refused), with the tile it is about. */
let fxSeq = 0;
function fxAction(name, v, order = null) {
  const h = (v && typeof v === 'object' && v.holding) || activeHolding(FS) || null;
  // (an order about a host, or about a tile, is shown where that is: not on the village)
  const at = order?.tile && Number.isInteger(order.tile.tile) ? order.tile : null;
  // (what the order is of, for the board's staging: a Train's unit and number — the recruits that walk in, fx/stage.mjs —,
  // a host's id)
  const of = {};
  if (Number.isInteger(order?.unit)) of.unit = order.unit;
  if (Number.isInteger(order?.n)) of.n = order.n;
  if (order?.host !== undefined && order?.host !== null) of.host = String(order.host);
  return { id: `${name}#${++fxSeq}`, name, faction: FS.citizen?.faction ?? null, tile: at ?? (h && Number.isInteger(h.tile) ? { p: h.p, q: h.q, tile: h.tile } : null), ...of };
}

/**
 * Own orders (UX design 14.2): every order the player places is said on the effects bus once it is answered,
 * with its kind and the tile it is about, and kept for the list of this turn (hud/turnlist.mjs).
 *
 *   'order:accepted'  {id, kind, name, turn, faction, tile: {p, q, tile} | null, at (chain seconds), ...what the kind carries}
 *   'order:refused'   the same, plus {code, sent: whether the order had left this browser}
 *
 * kind → what it carries:
 *   harvest   grown: [whole units by resource, kernel order] (what had grown since the last settling)
 *   build     item (0–5), n (the copy's number), secs, doneAt
 *   walls     item 6, secs, doneAt
 *   promote   item 7, from, to (tiers), secs, doneAt
 *   train     unit, n
 *   muster    unit, troops, tile = where the host forms up
 *   garrison  n
 *   dissolve  host (id as a string), tile = where the host stands
 *   explore   host, tiles: [tile index], tile = where the Scout stands
 *   march     host, unit, troops, dest: {p, q, tile} (the viewer's own sealed destination: never shown to anyone else),
 *             arriveBell, home: true for a march back to the village, tile = where it leaves from
 */
export const ORDER_KINDS = Object.freeze(['harvest', 'build', 'walls', 'promote', 'train', 'muster', 'garrison', 'dissolve', 'explore', 'march']);
/** Orders kept for the list of this turn: this many at most (older ones leave). */
export const ORDERS_MAX = 40;
let orderSeq = 0;
function orderOf(kind, name, extra = {}) {
  const h = activeHolding(FS);
  const tile = extra.tile && Number.isInteger(extra.tile.tile) ? { p: extra.tile.p, q: extra.tile.q, tile: extra.tile.tile } : h && Number.isInteger(h.tile) ? { p: h.p, q: h.q, tile: h.tile } : null;
  return { ...extra, id: `o${++orderSeq}`, kind, name, turn: nowBell(), faction: FS.citizen?.faction ?? null, tile, at: now() };
}
function orderAnswered(o, ok, extra = {}) {
  if (!o) return;
  const rec = { ...o, ...extra, state: ok ? 'accepted' : 'refused' };
  FS.orders = [rec, ...(FS.orders ?? []).filter(x => x.id !== o.id)].slice(0, ORDERS_MAX);
  const { say: _say, ...payload } = rec;
  fxEmit(ok ? 'order:accepted' : 'order:refused', payload);
}

/** One sponsored action, tracked to its landing; the notice says how it went. */
async function act(name, { v = {}, fields = {}, signer, requester = null, label, after, onSent, onLost, order = null, say = null } = {}) {
  // `signer: null` = a settle shape (no authority signs; the session key signs the request only).
  // (a refusal before anything is sent is an answer to the order too)
  const early = r => { orderAnswered(order, false, { code: r.code, sent: false }); return failed(r); };
  if (!io.pinned()) return early({ code: 'NoPin' });
  if (!FS.wallet) return early({ code: 'NoWallet' });
  let sign = null;
  if (signer !== null) {
    if (name === 'Join' || name === 'SetSession') {
      const w = wallet.connected();
      if (!w) return early({ code: 'NoWallet' });
      sign = { wallet: w };
    } else {
      if (!FS.session) return early({ code: 'NoSession' });
      sign = { session: FS.session };
    }
  }
  busy(label ?? (() => L`送信中…`));
  const fxa = fxAction(name, v, order);
  let fxDone = false, sent = false, code = null;
  fxEmit('action:busy', fxa);
  FS.inFlight = (FS.inFlight ?? 0) + 1;
  try {
    const accounts = typeof v === 'function' ? fp => accountsFor(name, v(fp)) : accountsFor(name, ctx(v));
    const send = () => tx.submit({ name, accounts, fields, signer: sign, requester, citizen: requester ? io.pinned().addresses.of('Citizen', { wallet: FS.wallet.address }) : undefined, invite: v.invite });
    let r = await send();
    // the transaction left this browser (a refusal before sending never reaches here)
    if (r.ok) { sent = true; onSent?.(r); fxEmit('action:sent', fxa); }
    let t = r.ok ? await tx.track(r.signature) : r;
    // W6-D: a resident action refused because the province fell a bell behind between the check and the landing:
    // ask the keeper to catch it up, wait for the herald to show it, and send once more.
    if (!t.ok && retryAfterCatchUp(name, t.code)) {
      busy(() => L`州が追いつくのを待っています…`);
      if (await catchUp(typeof v === 'object' ? (v.province ?? v.holding) : null)) {
        r = await send();
        if (r.ok) onSent?.(r);
        t = r.ok ? await tx.track(r.signature) : r;
      }
    }
    if (!r.ok) { code = r.code ?? null; return failed(r); }
    // sent, and the chain says it failed or it expired: definitely not landed (an unknown outcome is neither)
    if (!t.ok && (t.state === 'failed' || t.state === 'expired')) onLost?.(t);
    if (!t.ok) { code = t.code ?? null; return failed(t); }
    // each kind of order answers in its own words (the second capture: every order said "recorded on chain")
    done(say ?? order?.say ?? DONE_TEXT[name] ?? (() => L`完了しました`));
    fxDone = true; fxEmit('action:landed', fxa);
    orderAnswered(order, true);
    // (an order's result is read at once: the bar's figures follow the record, not the next poll a second and a half later)
    if (order) refresh().catch(e => console.error('frontier refresh:', e));
    await after?.(r);
    return r;
  } catch (e) {
    code = e?.code ?? 'Error';
    throw e;
  } finally {
    if (!fxDone) { fxEmit('action:refused', fxa); orderAnswered(order, false, { code, sent }); }
    FS.inFlight -= 1;
    refreshSoon();
  }
}

/** What an accepted action says when it is not an order with words of its own. */
const DONE_TEXT = {
  Join: () => L`国に加わりました`, SetSession: () => L`ゲーム内の鍵を用意しました`, SetVigil: () => L`夜番の時間を変えました`, FileTicket: () => L`村の申し込みを出しました`,
  SettleExplore: () => L`探索の結果を受け取りました`, SettleTransit: () => L`進軍の結果を受け取りました`,
};

/** Catch up the action's province, which may differ from the host's home. */
async function catchUp(target = null) {
  const h = target ?? activeHolding(FS);
  if (!h || !Number.isInteger(h.p) || !Number.isInteger(h.q)) return false;
  const r = await io.nudge(h.p, h.q, FS.provinces.get(`${h.p},${h.q}`)?.province.resolvedNext ?? nowBell());
  if (!r.ok) return false;
  const home = activeHolding(FS);
  if (home?.p === h.p && home?.q === h.q) FS.autoNudgeBell = nowBell();
  for (let i = 0; i < 10; i++) {
    await new Promise(res => setTimeout(res, 2000));
    await loadEnvelope(h.p, h.q);
    const pr = FS.provinces.get(`${h.p},${h.q}`)?.province;
    if (pr && !provinceLags(pr, nowBell())) return true;
  }
  return false;
}

// ------------------------------------------------------------------ pure rules of the controller (tested)
/** Resident actions sent again once after a catch-up when the program answers NotResident (not Depart: the march has its own path). */
export const CATCH_UP_RETRY = Object.freeze(['Muster', 'Garrison', 'Dissolve', 'Explore']);
export const retryAfterCatchUp = (name, code) => code === 'NotResident' && CATCH_UP_RETRY.includes(name);
/** The program's resident rule: a province lags when it is not resolved through `nowBell − 2` (`resolved_next + 1 < b`). */
export const provinceLags = (province, nowBell) => !province || province.resolvedNext + 1 < nowBell;
/**
 * Whether the page asks the keeper to catch the viewer's home province up
 * on its own (W6-D): the keeper skips quiet provinces in batches (up to 24
 * bells), so a player's province usually lags and every resident action
 * waited for a tap on "catch up". Once per bell, only while the page is
 * visible and the viewer holds land there.
 */
export function shouldAutoNudge({ holding, province, nowBell, lastBell = null, hidden = false }) {
  if (hidden || !holding || !(holding.state === 1 || holding.state === 2) || !province) return false;
  if (!provinceLags(province, nowBell)) return false;
  return lastBell !== nowBell;
}

/** Events the chronicle starts behind the head (a fresh page starts near the head, not at event 1). */
export const CHRONICLE_WINDOW = 500;
/** Pages of /h/events read per refresh while the answer is `full`. */
export const CHRONICLE_PAGES = 4;
/** The chronicle's first cursor for the season record's `headSeq` (wave-3 review, W3-F). */
export const chronicleStart = headSeq => Math.max(0, Number(headSeq ?? 0) - CHRONICLE_WINDOW);
/**
 * The unit the incoming warnings judge a departure with: the fastest pace
 * (cavalry), so `reachable` stays optimistic — a "no" is certain — whatever
 * unit the host is (DEPART does not log it).
 */
export const WARNING_UNIT = UNITS.indexOf('Horseman');
/** Seconds between polls while the page is hidden: only the self-reveal step runs (§4.2). */
export const HIDDEN_POLL = 60;
/**
 * Seconds until the next poll (§4.2): 10 s while a march or a transaction is
 * in flight, else 30 s; hidden, the reveal-only tick every 60 s; doubled per
 * consecutive error up to 5 min, hidden or not.
 */
export function pollDelay({ hidden = false, inFlight = false, errors = 0, cap = Infinity }) {
  // (`cap`: on a clock that runs fast, a quarter of a turn at most: clock.mjs pollCap; a hidden page twice that)
  const base = hidden ? Math.min(HIDDEN_POLL, cap * 2) : Math.min(nextPoll({ kind: 'own', inFlight, errors: 0 }), cap);
  return errors > 0 ? Math.min(300, base * 2 ** errors) : base;
}
/**
 * A turn began (the page's toll). On a clock that runs fast the polls are too slow for it, so the page reads again
 * at once (the hosts that stand from this turn) and once more when the turn before last is resolved: the anchor
 * (turn end + 2 s), the window of 600 s and the seed margin of 60 s put that about 65 chain seconds into a turn
 * (M1-CONTRACT 5.1). Nothing on a real cluster: there the polls are well inside a ten-minute turn.
 */
export function tolled() {
  // (the page knows the new turn the moment it tolls, not a read later: until then the checks before an order took
  // the old turn, so in the first instants of a turn the village's 編成 could be pressed, was refused by the world —
  // the province had not caught up — and was sent again by itself, while a host's orders said why they wait)
  if (FS.clock) { try { FS.nowBell = nowBell(); invalidate('panel', 'rail'); } catch { /* no clock yet */ } }
  // (an order card that stands open names a turn that can still be reached)
  try { composeTick(); } catch (e) { console.error('frontier compose:', e); }
  if (!Number.isFinite(pollCap(FS.chain)) || globalThis.document?.hidden) return;
  const r = Math.max(1, Number(FS.chain.rate) || 1);
  for (const secs of [0.25, 75 / r + 0.5]) setTimeout(() => refresh().catch(e => console.error('frontier refresh:', e)), secs * 1000);
}
/** The provinces (other than `home`) where /h/me lists a host of the viewer: `[{p, q}]`. */
export function hostProvinces(meRecord, home = null) {
  const out = [];
  for (const h of meRecord?.hosts ?? []) {
    const [p, q] = Array.isArray(h.province) ? h.province : [];
    if (!Number.isInteger(p) || !Number.isInteger(q)) continue;
    if (home && home.p === p && home.q === q) continue;
    if (!out.some(x => x.p === p && x.q === q)) out.push({ p, q });
  }
  return out;
}
/**
 * The seed source a SettleExplore/SettleTicket may name for a bell-region
 * record: `{archived: true}` once archived, else `{nonce}` of a cache still
 * present whose round is THE anchor's S and whose A is THE anchor's; null
 * while neither exists (wave-3 review, W3-F: not `caches[0]`).
 */
export function seedSourceOf(record) {
  if (!record) return null;
  if (record.archived) return { archived: true };
  const a = record.anchor?.A;
  const c = (record.caches ?? []).find(x => x.present !== false && (record.S === undefined || record.S === null || String(x.round) === String(record.S)) && (a === undefined || String(x.A) === String(a)));
  return c ? { nonce: c.nonce } : null;
}
/** Whether a join needs an invite: the season's join gate is set (I-51). */
export const inviteRequired = season => !!season?.joinGate?.some?.(x => x !== 0);

// ------------------------------------------------------------------ refresh
const Buffer2hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
let herald = null, refreshTimer = null, cursor = 0, conquestRefresh = 0, homesRefresh = 0, viewerRefresh = 0;

function refreshSoon(ms = 1500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(e => console.error('frontier refresh:', e)), ms);
}

/** A slower response must not roll a province back to an earlier generation. */
export function latestEnvelope(previous, next) {
  if (!previous) return next;
  for (const field of ['seq','slot','bell']) {
    const a=previous[field], b=next?.[field];
    if (a===undefined || a===null || a==='' || b===undefined || b===null || b==='') continue;
    try { if(BigInt(b)<BigInt(a)) return previous; if(BigInt(b)>BigInt(a)) return next; } catch { /* another comparable field may remain */ }
  }
  return next;
}

async function loadEnvelope(p, q, bell = 'latest') {
  const r = await herald.province(p, q, bell);
  if (r.ok) {
    if (bell !== 'latest') return r;
    const key=`${p},${q}`, accepted=latestEnvelope(FS.provinces.get(key),r);
    FS.provinces.set(key,accepted);
    // (the prototype's land record rides on the latest envelope of a sample world that serves it; a province that no longer carries one loses it)
    if (FS.proto) protoLand(key, accepted.proto?.land ?? null);
    const k=keepFromProvince(accepted.province);
    if (k && FS.conquest) FS.conquest.keeps.set(key,k);
    return accepted;
  }
  return null;
}

// ------------------------------------------------------------------ the prototype rule "banners" (PROTOTYPE-SPEC; proto/orders.mjs, proto/hand-model.mjs)
/**
 * The switch. The prototype is on exactly while the season record of a sample world carries `sample.proto.claims`
 * (the fixture's boot parameter `claims=1`): then `FS.proto` holds its records and the three routes may be called.
 * Without it `FS.proto` is null, nothing is asked and the page draws and says nothing of it.
 */
/** One province's land record as last read; `FS.proto.rev` moves when a record differs from the one held (the board builds its model again only then). */
function protoLand(key, land) {
  const P = FS.proto;
  if (!P) return;
  const sigs = (P.sigs ??= new Map()), sig = land ? JSON.stringify(land) : '';
  if ((sigs.get(key) ?? '') === sig) return;
  sigs.set(key, sig);
  if (land) P.lands.set(key, land); else P.lands.delete(key);
  P.rev = (P.rev ?? 0) + 1;
}
export function syncProto() {
  const claims = FS.mode === 'play' ? pm.claimsOf(FS.record) : null;
  if (!claims) { if (FS.proto) FS.proto = null; protoIo.enable(false); return null; }
  if (!FS.proto) FS.proto = pm.emptyState(claims); else FS.proto.claims = claims;
  protoIo.enable(true);
  return FS.proto;
}

/** Previews held at most (older ones leave); an answer that could not be had is asked again after this long (ms). */
const PREVIEWS_MAX = 160, PREVIEW_RETRY_MS = 4000;
/**
 * What the world would say of a banner at a place (GET /h/proto/preview): the answer held for it, or undefined
 * while it is asked (the panel and the map are drawn again when it comes); null when the world could not be
 * asked. `x = {host, p, q, tile}` for a host that exists, `{p, q, tile, unit, troops}` for one being placed.
 */
export function wantPreview(x, onAnswer = null) {
  const P = FS.proto;
  if (!P || !x || !Number.isInteger(x.tile)) return undefined;
  const key = pm.previewKey(FS, x), hit = P.previews.get(key);
  if (hit && !(hit.answer === null && Date.now() - hit.at > PREVIEW_RETRY_MS)) return hit.answer;
  P.previews.set(key, { at: Date.now(), answer: undefined });
  if (P.previews.size > PREVIEWS_MAX) P.previews.delete(P.previews.keys().next().value);
  protoIo.preview(x).then(a => {
    if (FS.proto !== P) return;
    // (an answer of the world, accepted or refused with its code, is kept; a route that could not be reached is "not known")
    const known = a && (a.ok === true || (a.ok === false && typeof a.code === 'string' && !/^(network|NotFound|Off|HTTP\d+|BadData|NotOwner|NoPath)$/.test(a.code)));
    P.previews.set(key, { at: Date.now(), answer: known ? a : null });
    P.rev = (P.rev ?? 0) + 1;
    invalidate('panel', 'map');
    onAnswer?.(known ? a : null);
  }).catch(() => { if (FS.proto === P) P.previews.set(key, { at: Date.now(), answer: null }); });
  return undefined;
}

/**
 * What the world would say of a banner on every tile of a province for one of the viewer's hosts (the preview route
 * with no tile: `all`), held like a single preview: the list, undefined while it is asked, null when it could not be
 * had. `x = {host, p, q}`.
 */
export function wantPlaces(x, onAnswer = null) {
  const P = FS.proto;
  if (!P || !x || x.host === null || x.host === undefined || !Number.isInteger(x.p) || !Number.isInteger(x.q)) return undefined;
  const key = `all|${pm.previewKey(FS, { ...x, tile: 'all' })}`, hit = P.previews.get(key);
  if (hit && !(hit.answer === null && Date.now() - hit.at > PREVIEW_RETRY_MS)) return hit.answer;
  P.previews.set(key, { at: Date.now(), answer: undefined });
  if (P.previews.size > PREVIEWS_MAX) P.previews.delete(P.previews.keys().next().value);
  protoIo.preview({ host: x.host, p: x.p, q: x.q }).then(a => {
    if (FS.proto !== P) return;
    const all = a && a.ok === true && Array.isArray(a.all) ? a.all : null;
    P.previews.set(key, { at: Date.now(), answer: all });
    onAnswer?.(all);
  }).catch(() => { if (FS.proto === P) P.previews.set(key, { at: Date.now(), answer: null }); });
  return undefined;
}

/** The viewer's own record and the score of the prototype, read with every refresh while it is on. */
async function refreshProto(meRecord) {
  const P = FS.proto;
  if (!P) return;
  if (meRecord !== undefined) {
    const m = meRecord?.proto?.land ?? null, sig = m ? JSON.stringify(m) : '';
    if (sig !== (P.meSig ?? '')) { P.meSig = sig; P.me = m; P.rev = (P.rev ?? 0) + 1; }
  }
  pm.learn(FS);
  const s = await protoIo.standings();
  if (FS.proto === P && s.ok && Array.isArray(s.nations)) P.standings = s;
}

/** The orders of the prototype as this turn's list names them (hud/turnlist.mjs). */
export const PROTO_ORDER_KINDS = Object.freeze({ raise: 'banner-raise', dress: 'banner-dress', tend: 'banner-tend', take: 'banner-take', pull: 'banner-pull', strike: 'banner-strike' });
const PROTO_SENT = {
  raise: () => L`旗を立てる命令を出しました（試作）。記録を待っています`, dress: () => L`旗の土地を広げる命令を出しました（試作）`, tend: () => L`旗の見回りを命じました（試作）`,
  take: () => L`旗を取る命令を出しました（試作）`, pull: () => L`旗を倒す命令を出しました（試作）`, strike: () => L`旗を取り下げる命令を出しました（試作）`,
};
/**
 * One order of the prototype (POST /gw/f/proto/land): the sample world judges it by its own module and answers
 * `{ok: true}` (its record follows about a second later: the page reads again then, and everything on screen that
 * tells of it comes from that record) or `{ok: false, code, need?, why?}`, said in the rule's own sentence.
 * Nothing is signed and nothing reaches a chain.
 */
async function protoOrder(op, fields, at = null) {
  const order = orderOf(PROTO_ORDER_KINDS[op], `proto:${op}`, { tile: at, proto: true });
  if (!FS.proto) { orderAnswered(order, false, { code: 'Off', sent: false }); return failed({ code: 'Off', text: () => pm.refusalText('Off') }); }
  busy(() => L`送信中…`);
  FS.inFlight = (FS.inFlight ?? 0) + 1;
  try {
    let r = await protoIo.land(op, fields);
    // (as for the basic game's resident orders, W6-D: the province fell a turn behind between the page's check and
    // the world's — the first instants of a turn —: wait until the page sees it caught up, and send once more)
    if (!r.ok && r.code === 'NotResident' && Number.isInteger(fields?.p) && Number.isInteger(fields?.q)) {
      busy(() => L`州が追いつくのを待っています…`);
      for (let i = 0; i < 12; i++) {
        await new Promise(res => setTimeout(res, 500));
        await loadEnvelope(fields.p, fields.q);
        const pr = FS.provinces.get(`${fields.p},${fields.q}`)?.province;
        if (pr && !provinceLags(pr, nowBell())) { r = await protoIo.land(op, fields); break; }
      }
    }
    if (!r.ok) {
      const me = pm.meOf(FS);
      const say = () => pm.refusalText(r.code, { need: r.need, why: r.why, turn: r.turn, cap: me?.cap, held: (me?.banners ?? []).length, perProvince: me?.perProvince });
      orderAnswered(order, false, { code: r.code ?? null, sent: true, why: say() });
      return failed({ ...r, text: say });
    }
    // (a take the world turned into pulling down says so in its answer)
    done(r.note && op === 'take' ? () => L`ここでは取れないため、旗を倒す命令になりました（試作）` : PROTO_SENT[op]);
    orderAnswered(order, true);
    // (the record follows `landMs` after the answer: the page reads then, and once more a little later)
    const lands = Number.isFinite(r.landMs) ? Math.max(0, r.landMs) : 1200;
    for (const ms of [lands + 250, lands + 1500]) setTimeout(() => refresh().catch(e => console.error('frontier refresh:', e)), ms);
    return r;
  } finally {
    FS.inFlight -= 1;
  }
}


/**
 * The ArrivalSlot of `host` in its destination's envelope of bell `b`: the
 * per-bell file, or the latest one while it is still that bell's; `env`
 * null otherwise (SettleTransit is offered only with the arrival bell's own
 * envelope: its slot and resolver; wave-3 review, W3-F).
 */
async function slotOf(dest, b, hostId) {
  let env = await herald.province(dest.p, dest.q, b);
  if (!env.ok) env = await herald.province(dest.p, dest.q, 'latest');
  if (!env.ok || env.bell !== b) return { env: null, slot: null };
  const s = env.slots.find(x => BigInt(x.account.hostId) === BigInt(hostId));
  return { env, slot: s ?? null };
}

/** Pipeline facts of bell b in region r from the herald's bell-region record. */
async function bellFacts(b, region, resolvedNext = null) {
  const r = await herald.bellRegion(b, region);
  if (!r.ok) return { facts: { anchor: null, archive: null, seed: false, resolvedNext }, record: null };
  const j = r.record;
  return { record: j, facts: { anchor: r.anchor ? { a: Number(r.anchor.a) } : null, archive: j.archived || j.tombstoned ? { archived: !!j.archived, tombstoned: !!j.tombstoned } : null,
    seed: (j.caches ?? []).length > 0, latestRound: 0, resolvedNext } };
}

// ------------------------------------------------------------------ the marches: this device's book against the chain
const sameMarch = (a, b) => a.host === b.host && a.transitSlot === b.transitSlot && a.arriveBell === b.arriveBell;
/** The viewer's own ArrivalSlots (of any bell) as the viewer's record listed them when it was last read (`refresh`). */
let mySlots = [];

/**
 * One reading of the marches at a time: a call made while one is under way is answered by one more reading after
 * it, shared by everyone who asked meanwhile.
 *
 * Why (found with the sample world on a fast clock, 2026-10-11, by logging every reveal): `refresh` is called from
 * several places that do not wait for each other (the poll, the toll, an order's answer, the page shown again), and
 * a reading of the marches loaded the book at its start, waited on the herald and wrote the book back at its end.
 * Two readings side by side therefore both found "no attempt yet, no slot yet" and each sent the self-reveal: the
 * keeper answered the second AlreadyDone (a wasted request, the march itself unharmed), and the later one wrote
 * its older copy of the book over the first one's record of the attempt.
 */
let marchesRun = null, marchesNext = null;
function refreshMarches() {
  if (!marchesRun) { marchesRun = readMarches().finally(() => { marchesRun = null; }); return marchesRun; }
  const again = () => { marchesNext = null; return refreshMarches(); };
  return (marchesNext ??= marchesRun.then(again, again));
}

async function readMarches() {
  const key = bookKey();
  if (!key) return;
  const store = book.browserStorage;
  // (the Holding and the slots of the last `refresh`)
  const holding = activeHolding(FS) ?? null, slotsOfMine = mySlots;
  // Wave-5 review: a gathered transit carries its destination (FLAG_GATHERED,
  // v1.7), so a card with no local entry still names its region.
  const transits = holding ? holding.transit.map((t, slot) => ({ slot, state: t.state, hostId: t.hostId, arriveBell: t.arriveBell, sealRoot: Buffer2hex(t.sealRoot),
    dest: (t.flags & 4) ? { p: t.destP, q: t.destQ } : null })) : [];
  const marches = [];
  const revealed = [];
  const b = nowBell();
  for (const first of book.loadBook(store, key).filter(x => x.state !== 'settled' && x.state !== 'failed')) {
    const p = unpack(book.materialBytes(first).plain);
    // (the tile too: the feed names it, the survey keeps it, the column walks to it and the turn's results play on it.
    // It was left out, so with a march sealed on this device the people layer threw on every frame and the arrival's
    // mark fell on the province's middle tile: found with the live fixture)
    const dest = { p: p.destP, q: p.destQ, tile: p.destTile };
    const region = regionOf(dest.p, dest.q);
    const { slot, env } = b >= first.arriveBell ? await slotOf(dest, first.arriveBell, first.host) : { slot: null, env: null };
    if (slot) revealed.push(first.host);
    // (for the question "does this march still lack its slot?" the viewer's own record counts too. The herald shows
    // a Reveal that landed in two places: the destination's envelope of the arrival bell — that bell's own file once
    // it is closed, `latest` only while that bell is the one the province resolves next — and the viewer's own
    // record, which lists the viewer's ArrivalSlots of any bell from the moment they exist. What the page says of
    // the march, and when, still follows the envelope alone)
    const seen = !!slot || slotsOfMine.some(x => x.bell === first.arriveBell && BigInt(x.hostId) === BigInt(first.host));
    const { facts, record } = b >= first.arriveBell ? await bellFacts(first.arriveBell, region, env?.province.resolvedNext ?? null) : { facts: {}, record: null };
    const pl = pipeline(FS.clock, first.arriveBell, { now: now(), ...facts });
    const transit = transits.find(t => t.slot === first.transitSlot && String(t.hostId) === first.host) ?? null;
    // (the entry as the book holds it NOW, after the waits above: its attempts decide whether a reveal goes out)
    let e = book.loadBook(store, key).find(x => sameMarch(x, first)) ?? first;
    // Self-reveal (§9.1): at the arrival bell's start + the drawn delay; once more after 60 s if no slot and the window is open.
    const step = book.revealStep(e, { now: now(), bellStart: bellStart(FS.clock.genesisTs, e.arriveBell), windowOpen: pl.state === 'open' || pl.state === 'awaitingBeacon' || pl.state === 'revealing', slotPresent: seen });
    if (step.action === 'send') {
      const r = await io.reveal(book.revealMaterial(e));
      // (the attempt goes into the book as it stands now: a march sealed while the keeper answered is kept)
      const cur = book.recordAttempt(book.loadBook(store, key), e, { t: now(), route: 'self', result: r.ok ? 'accepted' : r.code });
      book.saveBook(store, key, cur);
      e = cur.find(x => sameMarch(x, first)) ?? e;
    }
    const settleReady = !!transit && !!env && transit.state >= 2 && pl.state === 'resolved' && pl.close !== null && now() >= pl.close + 600;
    marches.push({ entry: e, transit, facts: { nowBell: b, pipeline: pl.state, slotPresent: !!slot, settleReady }, record, slot, env, dest, region });
  }
  // (from here to the write nothing waits: the book is read as it stands and written at once)
  const held = book.loadBook(store, key);
  // A live transit this device has no entry for (another device, cleared
  // storage): a card with entry null, so the tracker says keepers reveal it.
  for (const t of transits.filter(x => x.state >= 1 && x.state <= 3)) {
    if (marches.some(m => m.transit && m.transit.slot === t.slot)) continue;
    if (held.some(e => e.transitSlot === t.slot && e.host === String(t.hostId) && e.state !== 'settled')) continue;
    marches.push({ entry: null, transit: t, facts: { nowBell: b, pipeline: null, slotPresent: false, settleReady: false }, record: null, slot: null, env: null,
      dest: t.dest, region: t.dest ? regionOf(t.dest.p, t.dest.q) : null });
  }
  // (a free transit record means "settled" only once the march's arrival turn has ended: no transit is settled
  // before that (contract §5.11). The Holding a reading holds may be older than the book — it was asked for before
  // the send flow marked the march `landed`, or the herald is a moment behind the relay — and a march that had just
  // landed was then written off as settled: never revealed by this device, its card left to "the keepers")
  const entries = book.reconcile(held, { transits, revealedHosts: revealed, complete: !!holding })
    .map((e, i) => (e.state === 'settled' && held[i].state !== 'settled' && !(b > e.arriveBell) ? held[i] : e));
  book.saveBook(store, key, entries);
  FS.book = entries;
  FS.marches = marches;
  FS.bellItems = [
    ...(holding ? [{ bell: b, region: regionOf(holding.p, holding.q), why: 'current', facts: {} }] : []),
    ...marches.map(m => ({ bell: m.entry?.arriveBell ?? m.transit?.arriveBell, region: m.region, why: 'arrival', facts: {} })),
  ];
}

async function refreshChronicle() {
  if (cursor === 0 && FS.record?.headSeq !== undefined) cursor = chronicleStart(FS.record.headSeq);
  for (let page = 0; page < CHRONICLE_PAGES; page++) {
    const r = await herald.events(cursor);
    if (!r.ok) break;
    const { records } = decodePage(r.events);
    // (the prototype's own records ride on the same pages, in a sample world that serves them)
    if (FS.proto) { const had = FS.proto.log, log = pm.mergeLog(had, pm.landRecords(r.events)); if (log.length !== had.length || log.at(-1)?.seq !== had.at(-1)?.seq) { FS.proto.log = log; FS.proto.rev = (FS.proto.rev ?? 0) + 1; } }
    FS.chronicle = [...(FS.chronicle ?? []), ...records].slice(-400);
    // the life of every holding (people/life.mjs): folded from every record read, not only the last 400
    FS.life = updateLife(FS.life ?? new Map(), records);
    if (r.next !== null && r.next !== undefined) cursor = r.next;
    if (!r.full) break;
  }
  const own = FS.holdings ?? [];
  FS.isMine = rec => {
    if (rec.host_id !== undefined) { const h = hostParts(rec.host_id); return !!h && own.some(o => o.p === h.p && o.q === h.q && o.site === h.site); }
    return rec.p !== undefined && own.some(o => o.p === rec.p && o.q === rec.q && (rec.site === undefined || rec.site === o.site));
  };
  // Incoming (§7.7): public departures from other factions' holdings.
  const departures = FS.chronicle.filter(x => x.record.name === 'DEPART').map(x => {
    const h = hostParts(x.record.host_id);
    const ov = h && [...FS.overviews.values()].flatMap(o => o.provinces).find(pr => pr.p === h.p && pr.q === h.q);
    return { ...x.record, faction: ov && h ? ov.owners[h.site] : null };
  }).filter(d => d.faction !== null && d.faction < 6);
  const k = FS.kernel ?? null;
  FS.incoming = FS.citizen ? incomingWarnings({ kernel: k, departures, holdings: own.map(o => ({ p: o.p, q: o.q, site: o.site, tile: o.tile, shieldUntilBell: FS.provinces.get(`${o.p},${o.q}`)?.province?.siteMirror?.[o.site]?.shieldUntilBell })), faction: FS.citizen.faction, genesisTs: FS.clock.genesisTs, nowBell: nowBell(), unitOf: () => WARNING_UNIT }) : [];
}

/** The herald client this controller reads (startPlay sets it; tests pass a fake). */
export function useHerald(h) { herald = h; cursor = 0; mySlots = []; conquestRefresh += 1; homesRefresh += 1; viewerRefresh += 1; }

/**
 * Load the latest envelope of a province the map draws at tile detail, the
 * inspector reads or a scene needs: at most WANT_IN_FLIGHT requests at once
 * (herald.wantedProvinces' limit), and again when the copy is older than the
 * current bell and was fetched WANT_REFRESH_MS ago or more (one refresh per
 * bell at most, so spectators cost the herald little). `onLoad` redraws.
 */
export const WANT_IN_FLIGHT = 12;
export const WANT_REFRESH_MS = 30_000;
const artWanted = new Set();
const fetchedAt = new Map();
export function wantProvince(p, q, onLoad = () => {}, { now = Date.now(), bell = nowBell() } = {}) {
  const key = `${p},${q}`;
  if (!herald || artWanted.has(key) || artWanted.size >= WANT_IN_FLIGHT) return false;
  const have = FS.provinces.get(key);
  if (have && !(have.bell < bell && now - (fetchedAt.get(key) ?? 0) >= WANT_REFRESH_MS)) return false;
  artWanted.add(key);
  fetchedAt.set(key, now);
  loadEnvelope(p, q).catch(() => null).finally(() => { artWanted.delete(key); onLoad(); });
  return true;
}

/** Apply one /h/me read to the viewer. A missing Citizen is ready; a failed read is an error. */
export function applyMeResult(me) {
  if (me.ok) {
    FS.meStatus = 'ready'; FS.meError = null;
    const before = FS.land?.stage;
    FS.citizen = me.citizen;
    FS.holdings = me.holdings;
    mySlots = me.slots ?? [];
    FS.land = landState(me.citizen);
    // why the last holding or ticket ended, kept with its bell for the next cards (review finding 7)
    const after = FS.land.stage, gone = after === 'joined' || after === 'refugee';
    const lr = readLand();
    if (before && gone && ['provisional', 'final', 'ticket'].includes(before)) saveLandPatch({ landEnd: { why: before === 'provisional' ? 'displaced' : before === 'final' ? 'lost' : 'ended', bell: nowBell(), refiled: false } });
    if ((after === 'provisional' || after === 'final') && lr.landEnd) saveLandPatch({ landEnd: null });
    // the filed ticket counts as seen once the herald shows it (or what it led to); not merely because the stage is
    // not 'joined' (a refugee is not a ticket) — review finding 5
    const shown = ['ticket', 'provisional', 'final'].includes(after) || (Number.isInteger(FS.landRec?.lastTicketBell) && Number(me.citizen?.ticketBell) === FS.landRec.lastTicketBell);
    if (FS.landRec?.ticketSeen === false && shown) saveLandPatch({ ticketSeen: true });
    if (me.record?.quota) FS.quota = me.record.quota;
    if (FS.session && FS.citizen) {
      const m = fsession.matchesCitizen(FS.session, FS.citizen, now());
      FS.sessionProblem = m.ok ? null : m.code;
    }
    return 'found';
  }
  if (me.code === 'NotFound') {
    FS.meStatus = 'ready'; FS.meError = null;
    FS.citizen = null; FS.holdings = []; FS.land = landState(null);
    mySlots = [];
    return 'missing';
  }
  FS.meStatus = 'error'; FS.meError = { code: me.code ?? 'Unavailable', text: L`自分の情報を読み込めませんでした。接続を確認して再試行してください。` };
  invalidate('panel', 'chips');
  return 'error';
}

/** Refresh the viewer's accounts, provinces, marches, chronicle and quota. */
export async function refresh() {
  if (!herald || !FS.clock) return;
  const request = ++viewerRefresh;
  FS.nowBell = nowBell();
  // A gated season shows the invite field before any refusal (I-51).
  FS.inviteRequired = FS.inviteRequired || inviteRequired(FS.season);
  await refreshPrize().catch(() => null);
  if (request !== viewerRefresh) return;
  syncProto();
  if (FS.wallet) {
    const address = FS.wallet.address;
    const me = await herald.me(address).catch(e => ({ ok: false, code: e?.code ?? 'Unavailable' }));
    // A previous poll or wallet must not replace the viewer selected by a newer refresh.
    if (request !== viewerRefresh || FS.wallet?.address !== address) return;
    if (FS.proto) await refreshProto(me.ok ? me.record : undefined);
    if (request !== viewerRefresh || FS.wallet?.address !== address) return;
    if (applyMeResult(me) === 'error') return;
    const h = activeHolding(FS);
    // every holding's province (the rail can switch between them), the active one first
    for (const o of [h, ...(FS.holdings ?? []).filter(x => x !== h)]) if (o) await loadEnvelope(o.p, o.q);
    const home = h ? FS.provinces.get(`${h.p},${h.q}`)?.province ?? null : null;
    if (shouldAutoNudge({ holding: h, province: home, nowBell: FS.nowBell, lastBell: FS.autoNudgeBell ?? null, hidden: !!globalThis.document?.hidden })) {
      FS.autoNudgeBell = FS.nowBell;
      io.nudge(h.p, h.q, home.resolvedNext).then(r => { if (r.ok) refreshSoon(4000); }).catch(() => {});
    }
    // (the prototype rule "banners": the provinces of the viewer's own wedge in ring 2, where a banner of another nation
    // may be about to rise: their land records are read with the viewer's own, whether or not the map shows them)
    if (FS.proto && Number.isInteger(FS.citizen?.faction)) for (const pq of ringProvinces(2)) { if (wedgeOf(pq.p, pq.q) === FS.citizen.faction && !(h && h.p === pq.p && h.q === pq.q)) await loadEnvelope(pq.p, pq.q); }
    // Hosts standing in other provinces (after a march that Stays): their
    // envelopes too, so the Hosts tab can show and command them.
    if (me.ok) for (const pq of hostProvinces(me.record, h ? { p: h.p, q: h.q } : null)) await loadEnvelope(pq.p, pq.q);
    // SettleExplore is offered once the explore bell's seed is readable.
    FS.exploreSeedReady = false;
    if (h?.explore?.state && nowBell() >= h.explore.bell) {
      const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q));
      FS.exploreSeedReady = r.ok && !!seedSourceOf(r.record);
    }
    await refreshMarches();
    if (FS.citizen && io.pinned()) {
      const q = await io.quota(io.pinned().addresses.of('Citizen', { wallet: FS.wallet.address }));
      if (q.ok) FS.quota = q;
    }
  } else { FS.meStatus = 'ready'; FS.meError = null; }
  updateHomeGrant();
  await refreshConquest();
  await refreshChronicle();
  invalidate('panel', 'tabs', 'chips', 'map');
  if (needsHomeChoice()) await refreshHomes();
  else autoTicket().catch(e => console.error('frontier auto ticket:', e));
}

/** The conquest day files the records read back from today (a 14-day season in full). */
export const KEEP_EVENT_DAYS = 14;

/** Keep contests and captures of the season (/h/conquest/{day}.json): older days once, today's and yesterday's every refresh. */
async function refreshKeepEvents(cq, request) {
  if (!herald?.conquestDay) return;
  const bell = Math.max(0, Math.min(nowBell(), Number(FS.season.endBell ?? Infinity) - 1));
  const today = Math.floor(bell / BELLS_PER_DAY);
  const read = cq.eventDays ??= new Set();
  for (let d = Math.max(0, today - KEEP_EVENT_DAYS + 1); d <= today; d++) {
    if (read.has(d)) continue;
    const r = await herald.conquestDay(d).catch(() => null);
    if (request !== conquestRefresh) return;
    if (!r?.ok) continue;
    cq.events = mergeKeepEvents(cq.events, r.day.events);
    if (d < today - 1) read.add(d);
  }
  cq.events ??= [];
}

const keepWanted = new Set();
/** A keep's holders, contests and captures (/h/keep), read for the selected province and again once the bell has turned. */
export function wantKeepHistory(p, q, onLoad = () => {}) {
  const cq = FS.conquest, key = `${p},${q}`, bell = nowBell();
  if (!cq || !herald?.keep || !Number.isInteger(p) || !Number.isInteger(q) || keepWanted.has(key) || (cq.history?.get(key)?.asOf ?? -1) >= bell) return false;
  keepWanted.add(key);
  herald.keep(p, q).then(r => {
    if (FS.conquest !== cq || (!r.ok && r.code !== 'NotFound')) return;
    (cq.history ??= new Map()).set(key, r.ok ? { ...r.keep, asOf: bell } : { asOf: bell });
  }).catch(() => null).finally(() => { keepWanted.delete(key); onLoad(); });
  return true;
}

/**
 * The keeps of other nations the viewer's marches can reach (fkeepreach.mjs), for the
 * nation tab's list and the keep panel's note: asked by the panel while either is on
 * screen, answered once per origins, turn and control snapshot from the keeps the page
 * already holds (no request). True when the list was computed by this call.
 */
let reachWaiting = false;
export function wantKeepReach() {
  const cq = FS.conquest;
  if (!cq?.control || !conquestEnabled(FS.season) || !Number.isInteger(FS.citizen?.faction)) return false;
  const { home, origins } = reachOrigins(FS);
  if (!origins.length) return false;
  const args = { keeps: cq.keeps, origins, home, faction: FS.citizen.faction, nowBell: FS.nowBell ?? 0, controlBell: cq.control.bell,
    seeds: (FS.record?.rings ?? []).map(r => ({ ring: r.d, seed: r.seed })) };
  const key = reachKey(args);
  if (cq.reach?.key === key) return false;
  if (!FS.kernel) {
    if (reachWaiting) return false;
    reachWaiting = true;
    kernelOrNull().then(k => { if (!k && FS.conquest === cq) cq.reach = { key, ok: false, code: FS.kernelError ?? 'NoKernel' }; })
      .finally(() => { reachWaiting = false; invalidate('panel'); });
    return false;
  }
  cq.reach = cachedReach(cq.reach, { ...args, kernel: FS.kernel });
  return true;
}

/**
 * The keeps of other nations ONE host of the viewer can reach from the tile it stands on (the host's bar,
 * hud/keephand.mjs): `FS.conquest.hostReach = {key, host, ok, rows, unreachable}` (fkeepreach.mjs), answered once
 * per host, tile, turn and control snapshot from the keeps the page already holds (no request). A host that
 * cannot depart yet is measured too: its list says where it will be able to go. True when computed by this call.
 */
let hostReachWaiting = false;
export function wantHostReach(hostId) {
  const cq = FS.conquest;
  if (!cq?.control || !conquestEnabled(FS.season) || !Number.isInteger(FS.citizen?.faction)) return false;
  const r = hostRow(hostId);
  if (!r) return false;
  const origins = [{ p: r.p, q: r.q, tile: r.tile, unit: r.unit, host: String(r.id), troops: r.troops }];
  const args = { keeps: cq.keeps, origins, home: false, faction: FS.citizen.faction, nowBell: FS.nowBell ?? 0, controlBell: cq.control.bell,
    seeds: (FS.record?.rings ?? []).map(x => ({ ring: x.d, seed: x.seed })) };
  const key = `h:${r.id}|${reachKey(args)}`;
  if (cq.hostReach?.key === key) return false;
  if (!FS.kernel) {
    if (hostReachWaiting) return false;
    hostReachWaiting = true;
    kernelOrNull().then(k => { if (!k && FS.conquest === cq) cq.hostReach = { key, host: String(r.id), ok: false, code: FS.kernelError ?? 'NoKernel' }; })
      .finally(() => { hostReachWaiting = false; invalidate('rail', 'panel'); });
    return false;
  }
  cq.hostReach = { ...reachableKeeps({ ...args, kernel: FS.kernel }), key, host: String(r.id) };
  return true;
}

/** Refresh conquest together; retain known state on transport failures. */
export async function refreshConquest() {
  if (!conquestEnabled(FS.season) || !herald?.control) return;
  const request=++conquestRefresh;
  const cq = FS.conquest ??= { status: 'loading', keeps: new Map(), standings: null, final: null };
  await refreshOverviews(nowBell());
  const results = await Promise.allSettled([herald.control(), herald.standings()]);
  if (request!==conquestRefresh) return;
  const control = results[0].status === 'fulfilled' ? results[0].value : null;
  const standings = results[1].status === 'fulfilled' ? results[1].value : null;
  if (control?.ok) {
    cq.control = control.control; applyControl(FS.overviews, cq.control);
    for (const c of cq.control.provinces) {
      const ov = FS.overviews.get(ringOf(c.p,c.q))?.provinces.find(p => p.p === c.p && p.q === c.q);
      if (ov?.keepTile !== null && ov?.keepTile !== undefined) cq.keeps.set(`${c.p},${c.q}`, {
        p:c.p,q:c.q,tile:ov.keepTile,holder:c.control,troops:ov.keepTroops,
        heartland:c.heartland,consolidatedUntil:null,contender:c.contender,progress:c.progress,requiredBells:c.required,asOfBell:cq.control.bell });
    }
    for (const e of FS.provinces.values()) {
      const k = keepFromProvince(e.province); if (!k) continue;
      const c = cq.keeps.get(`${k.p},${k.q}`);
      if (k.asOfBell >= (c?.asOfBell ?? 0)) cq.keeps.set(`${k.p},${k.q}`, k);
      // a quiet province resolves late: its record is older than the control snapshot, but while the
      // holder is the same its consolidation bell still stands, so the panel can say if the keep is open
      else if (c.consolidatedUntil === null && k.holder === c.holder) c.consolidatedUntil = k.consolidatedUntil;
    }
    cq.status = 'ready'; cq.error = null;
  } else if (control?.code === 'NotFound' && nowBell() <= 1 + Math.ceil(Number(FS.season.revealWindow ?? 600) / Number(FS.season.bellSecs ?? 600)) && !cq.control) {
    // A fresh world has no completed control snapshot until its first bell settles.
    cq.status = 'loading'; cq.error = null;
  } else { cq.status = 'error'; cq.error = L`領土の最新情報を取得できませんでした。再取得してください。`; }
  if (standings?.ok) {
    const next = territoryStandings(standings.standings);
    if (next && next.bell >= (cq.standings?.bell ?? -1)) cq.standings = next;
  }
  // A control snapshot has a world bell, while a quiet province can have an
  // older resolvedNext. Read its actual keep after the summary: comparing
  // those different clocks would otherwise hide protection and disable it forever.
  const selected=FS.selected;
  if (selected) await loadEnvelope(selected.p,selected.q).catch(()=>null);
  // what was read so far is shown even when a newer refresh has started: a superseded one must not leave the panel waiting
  invalidate('map','panel','rail');
  if (request!==conquestRefresh) return;
  if (selected) wantKeepHistory(selected.p, selected.q, () => invalidate('panel'));
  await refreshKeepEvents(cq, request);
  if (request!==conquestRefresh) return;
  const s = FS.selected, pv = s && FS.provinces.get(`${s.p},${s.q}`)?.province;
  const site = pv && Number.isInteger(s.idx) ? pv.sites.indexOf(s.idx) : -1;
  cq.outpost = site >= 0 ? outpostOffer(FS,{p:s.p,q:s.q,site}) : null;
  if (nowBell() >= FS.season.endBell && !cq.final && herald.final) {
    const r = await herald.final();
    if (request!==conquestRefresh) return;
    if (r.ok && Number(r.final.endBell) === FS.season.endBell && r.final.control?.bell === FS.season.endBell-1 && r.final.standings?.bell === FS.season.endBell-1) cq.final = territoryStandings(r.final.standings);
  }
  invalidate('map','panel','rail');
}

function needsHomeChoice() {
  if (!instantHomeEnabled(FS.season) || FS.holdings?.length || FS.meStatus === 'error') return false;
  if (!FS.citizen) return true;
  return FS.land?.stage === 'joined' && !(FS.citizen.flags & (HOME_GRANTED | 4 | 16));
}

function updateHomeGrant() {
  if (!instantHomeEnabled(FS.season) || !(FS.citizen?.flags & HOME_GRANTED)) { FS.homeGrant = null; return; }
  const h = FS.holdings?.find(x => x.state === 2);
  if (!h) { FS.homeGrant = null; return; }
  const rec = readHome();
  if (rec.pending || rec.selected) saveHomePatch({ pending: null, selected: null });
  // (the card asks for the first building: once one is ordered, from the village's own bar, it has been answered)
  if (rec.seen !== grantId(h) && (h.queue ?? []).some(q => q && Number(q.doneAt ?? 0) > 0)) { saveHomePatch({ seen: grantId(h) }); FS.homeGrant = null; return; }
  if (rec.seen !== grantId(h)) {
    if (!sameHome(FS.homeGrant, h)) FS.homeFocus = h;
    FS.homeGrant = h; FS.tab = 'map';
  } else FS.homeGrant = null;
}

const wantedHomeFaction = () => { const f = FS.citizen?.faction ?? FS.joinDraft?.faction; return Number.isInteger(f) && f >= 0 && f < 6 ? f : null; };

/** Read a bounded set of actual free sites, without signing or claiming land. */
export async function refreshHomes({ force = false } = {}) {
  if (!needsHomeChoice() || !herald) return;
  const old = FS.homeChoice ?? { candidates: [], selected: readHome().selected, rotation: 0 };
  const faction = wantedHomeFaction();
  if (old.busy || (!force && ((old.loading && old.faction === faction) || (old.loadedBell === nowBell() && old.faction === faction)))) return;
  const request = ++homesRefresh;
  FS.homeChoice = { ...old, faction, selected: old.selected?.faction === faction ? old.selected : null, loading: true, error: null };
  invalidate('panel');
  try {
    if (force) FS.overviewsBell = undefined;
    await refreshOverviews(nowBell());
    const result = await planHomes({ overviews: FS.overviews, faction, nowBell: nowBell(), ringsOpen: conquestEnabled(FS.season) ? Math.min(FS.record?.rings?.length ?? 0, Number(FS.season.conquestParams?.heartlandMaxRing ?? FS.season.heartlandMaxRing ?? 3) + 1) : FS.record?.rings?.length ?? 0,
      seed: `${FS.wallet?.address ?? 'visitor'}|${old.rotation ?? 0}`, rotation: old.rotation ?? 0,
      read: async (p, q) => { const env = await loadEnvelope(p, q); return env?.province ?? null; } });
    if (request !== homesRefresh) return;
    const selected = old.selected && (faction === null || old.selected.faction === faction) && result.candidates.some(h => sameHome(h, old.selected)) ? old.selected : faction !== null ? result.candidates[0] ?? null : null;
    FS.homeChoice = { ...old, ...result, selected, faction, loadedBell: nowBell(), loading: false,
      error: result.error ? { code: result.error, text: result.error === 'NoFreeHome' ? L`入植できる土地がまだ見つかりません。候補を更新してください。` : L`土地の情報を読み込めませんでした。もう一度お試しください。` } : null };
  } catch (e) {
    if (request !== homesRefresh) return;
    FS.homeChoice = { ...old, faction, loading: false, error: { code: e?.code ?? 'Unavailable', text: L`土地の情報を読み込めませんでした。もう一度お試しください。` } };
  }
  invalidate('panel', 'map');
}

async function waitForOwn(predicate) {
  for (let i = 0; i < 5; i++) {
    await refresh();
    if (predicate()) return true;
    if (FS.meStatus === 'error') return false;
    if (i < 4) await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/** The second action is always based on confirmed Join state, never an optimistic Citizen. */
/**
 * The first village's card has been read: it is noted for this device and season (it does not come back with the next
 * refresh) and the drawer is free again. Its own button does this and opens the village; closing the card or pressing a
 * dock tab does it too (on the real chain the card kept the drawer: the close button and every tab did nothing).
 * Returns the village, or null when no card stood.
 */
export function ackHomeGrant() {
  const h = FS.homeGrant;
  if (!h) return null;
  saveHomePatch({ seen: grantId(h), pending: null, selected: null });
  FS.homeGrant = null; FS.homeFocus = h;
  return h;
}

export async function confirmHome() {
  if (!instantHomeEnabled(FS.season) || FS.homeChoice?.busy) return;
  const faction = wantedHomeFaction();
  if (!FS.homeChoice?.selected || (faction !== null && FS.homeChoice.selected.faction !== faction)) await refreshHomes({ force: true });
  if (!FS.homeChoice?.selected || FS.homeChoice.busy) return;
  FS.homeChoice.busy = true; FS.homeChoice.error = null;
  const pending = p => { FS.homeChoice.pending = p; invalidate('panel'); };
  const error = (code, text) => { FS.homeChoice.error = { code, text }; invalidate('panel'); };
  try {
    if (!FS.wallet) {
      const i = (FS.walletList ?? []).findIndex(w => !w.why);
      if (i < 0) return error('NoWallet', L`参加に使うウォレットを接続してください。`);
      pending('connecting'); await ACTIONS.connect({ i: String(i) });
      if (!FS.wallet) return;
    }
    if (FS.meStatus !== 'ready') { await refresh(); if (FS.meStatus !== 'ready') return; }
    const saved = readHome();
    if (saved.pending) {
      pending('confirming');
      const tracked = await tx.track(saved.pending.signature);
      await refresh();
      if (FS.homeGrant) return;
      if (saved.pending.kind === 'Join' && FS.citizen) saveHomePatch({ pending: null });
      else if (!tracked.ok && ['failed', 'expired'].includes(tracked.state)) saveHomePatch({ pending: null });
      else return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
    }
    let site = FS.homeChoice.selected;
    if (FS.citizen && FS.citizen.faction !== site.faction) {
      FS.homeChoice.selected = null;
      return error('WrongFaction', L`参加済みの国の土地を選んでください。`);
    }
    const env = await loadEnvelope(site.p, site.q);
    if (!homeSites(env?.province, { faction: site.faction, nowBell: nowBell(), ringsOpen: FS.record?.rings?.length ?? 0 }).some(s => sameHome(s, site))) {
      FS.homeChoice.selected = null; saveHomePatch({ selected: null });
      return error('SiteUnavailable', L`この土地は現在選べません。候補を更新して別の土地を選んでください。`);
    }
    saveHomePatch({ selected: site });
    if (!FS.citizen) {
      pending('joining'); FS.joinDraft = { ...(FS.joinDraft ?? {}), faction: site.faction };
      const joined = await ACTIONS.join();
      if (!joined?.ok) return;
      if (!await waitForOwn(() => !!FS.citizen)) return error('PendingHome', L`参加が記録されました。自分の情報の反映を待っています。`);
      saveHomePatch({ pending: null });
    }
    if (FS.holdings?.length) { updateHomeGrant(); return; }
    if (!FS.session || FS.sessionProblem) {
      await ACTIONS.session(); await refresh();
      if (!FS.session || FS.sessionProblem) return;
    }
    pending('placing');
    const placed = await act('PlaceHome', { v: { holding: site, faction: FS.citizen.faction }, fields: { p: site.p, q: site.q, site: site.site },
      label: () => L`あなたの村を確定しています…`,
      onSent: r => saveHomePatch({ pending: { kind: 'PlaceHome', signature: r.signature } }),
      onLost: () => saveHomePatch({ pending: null }) });
    if (!placed?.ok) { await refresh(); if (!FS.homeGrant) error(placed?.code ?? FS.notice?.code ?? 'PlaceFailed', L`土地の確定を確認できませんでした。再確認するか、候補を更新してください。`); return; }
    pending('confirming');
    if (!await waitForOwn(() => !!FS.homeGrant)) error('PendingHome', L`村の確定が記録されました。地図への反映を待っています。`);
  } catch (e) { error(e?.code ?? 'Unavailable', L`参加を完了できませんでした。接続を確認して再試行してください。`); }
  finally { if (FS.homeChoice) { FS.homeChoice.busy = false; FS.homeChoice.pending = null; } invalidate('panel', 'tabs', 'map'); }
}

// ------------------------------------------------------------------ the first holding, placed automatically (owner decision V2)
/**
 * Joining is choosing a faction: when the Citizen has neither a holding nor an open
 * ticket (just joined, its ticket ended — displaced or exhausted — or it lost its
 * holding), this browser plans a ticket (fjoin.mjs: its own order of the home wedge's
 * free sites, cohort room, the §5.9 overflow) and files it.
 *   - once a bell for this device (the stored `autoTryBell`, re-read: other tabs count);
 *   - not while a ticket that left this browser is not yet shown by the herald
 *     (`ticketSeen` false, written only once the transaction was sent — a refusal
 *     before sending locks nothing; review finding 1);
 *   - `force` (the "file again now" button) skips both.
 * `FS.autoTicket = {state: 'searching'|'sent'|'waiting'|'nofree'|'failed', bell, code?}`.
 */
export async function autoTicket({ force = false } = {}) {
  if (needsHomeChoice()) { FS.autoTicket = null; return; }
  const stage = FS.land?.stage;
  if (stage !== 'joined' && stage !== 'refugee') { FS.autoTicket = null; return; }
  if (!FS.session || FS.sessionProblem || !Number.isInteger(FS.citizen?.faction) || FS.autoTicketBusy) return;
  const b = nowBell();
  const rec = readLand();   // per wallet; another tab may have filed or be filing (review finding 6, re-check 4)
  const filed = rec.lastTicketBell;
  const onItsWay = rec.ticketSeen === false && Number.isInteger(filed) && b < filed + TICKET_SEEN_BELLS;
  // this bell's attempt is under way or done elsewhere (not failed): the button respects it too (re-check 8)
  const tried = rec.autoTryBell === b && !rec.autoTryFailed;
  if (!force) {
    if (onItsWay) { FS.autoTicket = { state: 'sent', bell: filed }; invalidate('panel'); return; }
    if (rec.autoTryBell === b) { if (!FS.autoTicket) { FS.autoTicket = { state: 'waiting', bell: b }; invalidate('panel'); } return; }
  } else {
    if (tried && !onItsWay) return;
    const t = Date.now();
    if (t - (FS.autoForceAt ?? 0) < AUTO_FORCE_MS) return;   // the button is throttled (re-check 3)
    FS.autoForceAt = t;
  }
  FS.autoTicketBusy = true;
  saveLandPatch({ autoTryBell: b, autoTryFailed: false });   // before sending: a second tab skips this bell
  FS.autoTicket = { state: 'searching', bell: b };
  invalidate('panel');
  let sent = false;
  try {
    await refreshOverviews(b);
    for (const [k, at] of FS.autoFull ?? []) if (b - at >= AUTO_FULL_BELLS) FS.autoFull.delete(k);
    const plan = await planTicket({ overviews: FS.overviews ?? new Map(), faction: FS.citizen.faction, ringsOpen: FS.record?.rings?.length ?? 1,
      seed: `${FS.wallet?.address ?? ''}|${b}`, nowBell: b, read: (p, q) => readProvinceOnce(p, q, b), skip: new Set((FS.autoFull ?? new Map()).keys()),
      homeFull: homeWedgeFull(FS.record, FS.citizen.faction) });
    FS.autoFull ??= new Map();
    for (const k of plan.full ?? []) FS.autoFull.set(k, b);
    if (!plan.ok) { FS.autoTicket = plan.why === 'readfail' ? { state: 'failed', bell: b, code: 'Unavailable' } : { state: plan.why, bell: b }; return; }
    const r = await fileTicket(plan.sites, plan.source, b);
    if (r?.ok === true) { sent = true; FS.autoTicket = { state: 'sent', bell: b }; }
    else if (FS.landRec?.ticketSeen === false && FS.landRec.lastTicketBell === b) { sent = true; FS.autoTicket = { state: 'sent', bell: b }; }   // sent, outcome unknown: keep waiting
    else {
      FS.autoTicket = { state: 'failed', bell: b, code: r?.code ?? FS.notice?.code ?? 'Error' };
      if (FS.notice && FS.notice.ok === false) FS.notice = null;   // the card says it (one live region, review finding 11)
    }
  } catch (e) {
    FS.autoTicket = { state: 'failed', bell: b, code: e?.code ?? 'Error' };
  } finally {
    if (!sent) saveLandPatch({ autoTryFailed: true });   // nothing left this browser for good: the button may try again
    FS.autoTicketBusy = false;
    invalidate('panel');
  }
}
/** The "file again now" button at most this often; provinces found full are not read again for this many bells. */
export const AUTO_FORCE_MS = 20_000, AUTO_FULL_BELLS = 6;

/** A Province read for the automatic ticket, once a bell (re-check 3: no repeated reads of the same bell). */
async function readProvinceOnce(p, q, b) {
  FS.autoProv ??= new Map();
  const k = `${p},${q}`;
  const hit = FS.autoProv.get(k);
  if (hit && hit.bell === b) return hit.province;
  try {
    const e = await herald.province(p, q);
    if (!e.ok) return null;
    FS.autoProv.set(k, { bell: b, province: e.province });
    if (FS.autoProv.size > 200) FS.autoProv.delete(FS.autoProv.keys().next().value);
    return e.province;
  } catch { return null; }
}

/**
 * The program's own "home wedge full" (Frontier WEDGE_OPEN − WEDGE_OCCUPIED = 0, the
 * overflow rule of §5.9) when the season record carries the counters; else null (the
 * planner then decides conservatively from the Provinces it read).
 */
function homeWedgeFull(record, faction) {
  const o = record?.wedgeOpen, c = record?.wedgeOccupied, w = faction;
  if (!Array.isArray(o) || !Array.isArray(c) || !Number.isInteger(o[w]) || !Number.isInteger(c[w])) return null;
  return o[w] - c[w] <= 0;
}

/**
 * The season record's open rings and their overviews, re-read once a bell while a ticket
 * is being planned: new rings and freed sites show up (review finding 3).
 */
async function refreshOverviews(b) {
  if (FS.overviewsBell === b) return;
  FS.overviewsBell = b;
  try {
    const r = await herald.season();
    if (r?.ok && r.record) { FS.record = r.record; if (r.season) FS.season = r.season; }
  } catch { /* keep the last record */ }
  const rings = Math.max(1, FS.record?.rings?.length ?? 1);
  for (let d = FIRST_TICKET_RING; d < rings; d++) {   // rings 0–1 hold no ticket sites (re-check 3)
    try { const o = await (conquestEnabled(FS.season) && herald.overview2 ? herald.overview2(d) : herald.overview(d)); if (o.ok) FS.overviews.set(d, o); } catch { /* keep the last overview */ }
  }
}

// ------------------------------------------------------------------ the composer
async function kernelOrNull() {
  if (FS.kernel) return FS.kernel;
  try { FS.kernel = await loadKernel({ ruleset: Buffer2hex(FS.season.rulesetHash), url: new URL(conquestEnabled(FS.season) ? './wasm/frontier-v2.wasm' : './wasm/frontier.wasm', import.meta.url) }); FS.kernelError = null; } catch (e) { FS.kernelError = e.code ?? 'NoWasm'; FS.kernel = null; }
  return FS.kernel;
}

async function setDestination(dest) {
  const c = FS.compose;
  if (!c) return;
  c.dest = dest; c.route = null; c.routeError = null; c.earliest = null; c.moved = null;
  invalidate('panel');
  const k = await kernelOrNull();
  if (!k) { c.routeError = FS.kernelError ?? 'NoKernel'; invalidate('panel'); return; }
  const seeds = (FS.record?.rings ?? []).map(r => ({ ring: r.d, seed: r.seed }));
  const r = planRoute(k, { from: { p: c.origin.p, q: c.origin.q, tile: c.host.tile }, to: dest, unit: c.host.unit, seeds });
  if (!r.ok) { c.routeError = r.code; invalidate('panel'); return; }
  c.route = r.route;
  c.earliest = earliestBell(k, { genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: r.route.secs });
  c.arriveBell = arrivalWindow(FS.season, nowBell(), c.earliest).min;
  invalidate('panel');
}

/**
 * The order card follows the clock. The earliest turn a march can arrive moves on while the card stands open: at
 * the toll, in a turn's last seconds (the margin of fmarch.mjs, from which a departure counts as the next turn's)
 * and at a long road's own moment. The card kept the turn it was opened with, so a seal pressed after such a
 * moment was refused before anything was sealed, with 「そのターンには着けません（道のりに合いません）」, and only
 * then did the card name the next turn (seen 2026-10-11 on a phone with a turn of 12 s: the play-through's first
 * march was "not sent"; a player on the real clock met it when a card opened before a turn's last 90 s was sealed
 * within them, or after the toll). Now the card's own turn moves with the clock, the card says that it moved and
 * from which turn (`moved`), and its seal is for the turn it names. Called at every toll and from the page's tick;
 * returns whether anything changed. (A press in the very instant of the change is still refused before anything is
 * sealed, and the order is offered again: nothing is sealed for a turn the card did not name.)
 */
export function composeTick() {
  const c = FS.compose;
  if (!c || c.sending || !c.route || !c.dest || !FS.season || !FS.clock) return false;
  // (the earliest turn only ever moves on)
  const fresh = FS.kernel ? earliestBell(FS.kernel, { genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: c.route.secs }) : null;
  const earliest = fresh !== null && fresh > (c.earliest ?? 0) ? fresh : c.earliest;
  const w = arrivalWindow(FS.season, nowBell(), earliest);
  const arrive = Number.isInteger(c.arriveBell) ? Math.min(w.max, Math.max(w.min, c.arriveBell)) : c.arriveBell;
  if (earliest === c.earliest && arrive === c.arriveBell) return false;
  if (Number.isInteger(c.arriveBell) && Number.isInteger(arrive) && arrive > c.arriveBell) c.moved = { from: c.moved?.from ?? c.arriveBell, to: arrive };
  c.earliest = earliest; c.arriveBell = arrive;
  invalidate('panel', 'map');
  return true;
}

function quickDestinations() {
  const out = [];
  for (const env of FS.provinces.values()) {
    const camp = env.province.camp;
    if (camp?.state === 1) out.push({ kind: 'camp', p: env.province.p, q: env.province.q, tile: camp.tile });
  }
  for (const h of FS.holdings ?? []) out.push({ kind: 'holding', p: h.p, q: h.q, tile: h.tile });
  return out;
}

async function sendTheMarch() {
  const c = FS.compose;
  if (!c || c.sending || FS.inFlight > 0) return;
  const h = c.holding ? holdingByRef(FS.holdings,c.holding) : activeHolding(FS);
  if (!h) return failed({code:'NotOwner'});
  const pin = io.pinned();
  const arrival = composerArrival(FS);
  const m = { ...composerMarch(FS, arrival), holdingAddress: pin.addresses.of('Holding', h) };
  c.earliest = m.earliest; c.arriveBell = m.arriveBell;
  c.sendingArrival = arrival; c.sending = true; c.step = null;
  invalidate('panel');
  // the effects layer draws the route on while the order is sealed and sent (own view only), then stamps it (fx/stage.mjs)
  // (the route with its origin, as the march book keeps it: the planner's answer alone has no starting tile, so the
  // ribbon was a straight line from the village to the destination instead of the road the host takes)
  // (`host`: the departing host's id; the board's character steps off with it at once when it is the one it leads: people/onboard.mjs)
  const fxa = { id: `Depart#${++fxSeq}`, name: 'Depart', faction: FS.citizen?.faction ?? null, unit: c.host?.unit ?? 0, host: String(c.host?.id ?? ''), tile: { p: c.origin.p, q: c.origin.q, tile: c.host.tile }, dest: c.dest ? { p: c.dest.p, q: c.dest.q, tile: c.dest.tile } : null,
    route: Array.isArray(c.route?.dirs) ? { p: c.origin.p, q: c.origin.q, tile: c.host.tile, dirs: [...c.route.dirs] } : null };
  fxEmit('action:busy', fxa);
  FS.inFlight = (FS.inFlight ?? 0) + 1;
  try {
    const origin = () => FS.provinces.get(`${c.origin.p},${c.origin.q}`)?.province ?? null;
    // A turn that rolls over between composing and sending: the march is sent again with the arrival moved (fmarch.sendMarchRetrying).
    const r = await sendMarchRetrying(m, {
      seal: req => sealMarch(req), clock: FS.clock, publicKey: FS.beacon?.publicKey,
      storage: book.browserStorage, bookKey: bookKey(), session: FS.session,
      accounts: accountsFor('Depart', ctx({ holding: { p: h.p, q: h.q, site: h.site }, province: c.origin })),
      submit, track, onStep: s => { c.step = s; invalidate('panel'); },
      earliestAtSend: () => (FS.kernel && c.route ? earliestBell(FS.kernel, { genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: c.route.secs }) : null),
      refresh: async () => { await loadEnvelope(c.origin.p, c.origin.q).catch(() => null); FS.nowBell = nowBell(); return { nowBell: nowBell(), now: now(), resolvedNext: origin()?.resolvedNext ?? null, province: origin() }; },
      nudge: () => io.nudge(c.origin.p, c.origin.q, origin()?.resolvedNext ?? nowBell()),
      onRetry: x => {
        c.step = null; c.arriveBell = x.arriveBell; if (x.earliest !== null) c.earliest = x.earliest;
        busy(x.arriveBell !== x.from ? () => L`ターンが変わりました。到着を第${fmtNum(x.arriveBell)}ターンに直して送り直しています…` : () => L`州が追いつくのを待っています…`);
      },
    });
    fxEmit(r.ok ? 'march:sealed' : 'action:refused', fxa);
    const arrive = r.arriveBell ?? c.arriveBell, moved = r.ok && Number.isInteger(r.arriveFrom) && r.arriveFrom !== arrive ? r.arriveFrom : null, home = !!c.home || (c.dest && h && c.dest.p === h.p && c.dest.q === h.q && c.dest.tile === h.tile);
    orderAnswered(orderOf('march', 'Depart', { host: String(c.host.id), unit: c.host.unit ?? 0, troops: c.host.troops ?? null, tile: { p: c.origin.p, q: c.origin.q, tile: c.host.tile },
      dest: c.dest ? { p: c.dest.p, q: c.dest.q, tile: c.dest.tile } : null, arriveBell: arrive, home }), r.ok, r.ok ? {} : { code: r.code ?? null, sent: false });
    // (the board keeps the screen: the column sets out there; the marches drawer is one press away. It opened by itself
    // and, on a phone, covered the departing column)
    // (the selection that was the order's destination goes with the card, in the same instant: the page cleared it a
    // moment later, once this function had returned, and for a quarter of a second the drawer showed that tile's own
    // card — 「地図 草原…」 flashed where the order card had been; the English recording of 2026-10-11)
    if (r.ok) { FS.selected = null; FS.inspectOpen = false; done(() => (moved !== null ? L`出発しました。ターンが変わったため、到着は第${fmtNum(moved)}ターンから第${fmtNum(arrive)}ターンになりました。` : home ? L`封をして村へ向かいました。ターン ${fmtNum(arrive)} に着きます` : L`封をして出発しました。ターン ${fmtNum(arrive)} に着きます`)); FS.compose = null; FS.tab = 'map'; FS.departed = { host: String(c.host.id), at: now() }; } else {
      // A stale earliest bell: show the new window (the player chooses again).
      if (r.code === 'ArrivalBell' && r.earliest !== null && r.earliest !== undefined) {
        const to = Math.max(c.arriveBell, arrivalWindow(FS.season, nowBell(), r.earliest).min);
        if (to > c.arriveBell) c.moved = { from: c.moved?.from ?? c.arriveBell, to };
        c.earliest = r.earliest; c.arriveBell = to;
      }
      failed(r);
    }
  } finally {
    c.sending = false; delete c.sendingArrival;
    FS.inFlight -= 1;
    refreshSoon();
  }
}

// ------------------------------------------------------------------ settlement (settle shapes: no authority signer, charged to the requester)
async function settleExplore() {
  const h = activeHolding(FS), rec = h.explore;
  const region = regionOf(rec.p, rec.q);
  const r = await herald.bellRegion(rec.bell, region);
  const A = io.pinned().addresses;
  const src = r.ok ? seedSourceOf(r.record) : null;
  if (!src) return failed({ code: 'SeedNotReady' });
  const archived = !!src.archived;
  const nonce = src.nonce;
  const archive = A.of('AnchorArchive', { region, part: archivePartOf(rec.bell) });
  const settle = archived ? { seed: archive, anchor: archive } : { seed: A.of('SeedCache', { bell: rec.bell, region, nonce }), anchor: A.of('BellAnchor', { bell: rec.bell, region }) };
  return act('SettleExplore', { v: ctx({ holding: h, settle }), signer: null, requester: FS.session });
}

/**
 * The Citizen a SettleTransit must name when this host won the camp (v1.7,
 * I-56; the keeper's rule, fclient camp_winner): the host's arrival record
 * in the resolved ClashInputs Stays at the lowest `camp_mask` position. The
 * mask and the fate come from the arrival bell's own envelope (decoded
 * `campMask`, ABI v1.8); the herald's clash report bytes are the fallback. The Holding's owner Citizen, or null.
 */
export async function campCitizenOf(m, hostId, { heraldClient = herald, holding = activeHolding(FS), faction = FS.citizen?.faction } = {}) {
  const ci = m.env?.inputs;
  if (!ci || !m.dest || !m.transit || !holding || !Number.isInteger(faction)) return null;
  const k = [0, 1, 2, 3].find(i => { const r = ci.arrivals?.[faction * 4 + i]; return r?.present === 1 && String(r.hostId) === String(hostId); });
  if (k === undefined || ci.arrivals[faction * 4 + k].fate !== 1) return null;
  // v1.8: the ABI names ClashInputs' camp_mask (was RSV_76), so the decoded
  // envelope carries it; the raw /h/clash bytes remain the fallback.
  let mask = Number.isInteger(ci.campMask) ? ci.campMask : null;
  if (mask === null) {
    const rep = await heraldClient.clash(m.dest.p, m.dest.q, m.transit.arriveBell);
    const raw = rep?.ok && rep.report?.inputs_b64 ? fromBase64(rep.report.inputs_b64) : null;
    if (!raw) return null;
    mask = campMaskOf(raw);
  }
  if (!campWinner(mask, faction, k, ci.arrivals[faction * 4 + k].fate)) return null;
  return toBase58(holding.ownerCitizen);
}

async function settleTransit(hostId) {
  const m = (FS.marches ?? []).find(x => String(x.entry?.host) === String(hostId));
  const h = activeHolding(FS);
  if (!m?.entry?.seal_b64 || !m.transit) return failed({ code: 'TransitState' });
  const seal = fromBase64(m.entry.seal_b64);
  const commit = Uint8Array.from(m.entry.commit_hex.match(/../g).map(x => parseInt(x, 16)));
  // The pair judged must be the logged pair: sha256(commit ‖ sha256(seal)) = the transit's seal_root.
  if (Buffer2hex(sealRootOf(commit, ctHashOf(seal))) !== m.transit.sealRoot) return failed({ code: 'CommitMismatch' });
  const A = io.pinned().addresses;
  const slotAcc = m.slot?.account ?? null;
  const inputs = m.env?.inputs ?? null;
  const archive = m.record?.archived;
  const anchor = archive ? A.of('AnchorArchive', { region: m.region, part: archivePartOf(m.transit.arriveBell) }) : A.of('BellAnchor', { bell: m.transit.arriveBell, region: m.region });
  const campCitizen = await campCitizenOf(m, hostId);
  const v = fp => ctx({ holding: { p: h.p, q: h.q, site: h.site }, settle: {
    dest: m.dest, arriveBell: m.transit.arriveBell, faction: FS.citizen.faction, slotIndex: slotAcc?.i ?? 0, anchor,
    slotBeneficiary: slotAcc ? toBase58(slotAcc.beneficiary) : fp, resolver: inputs ? toBase58(inputs.resolver) : fp, rentPayer: toBase58(h.rentPayer), beneficiary: fp, campCitizen } });
  return act('SettleTransit', { v, fields: fp => ({ transit_slot: m.entry.transitSlot, commit, seal, beneficiary: fromBase58(fp) }), signer: null, requester: FS.session });
}

// ------------------------------------------------------------------ actions (data-act)
const num = x => Number.parseInt(x, 10);
const formNum = (form, name) => Number(form?.elements?.[name]?.value ?? NaN);

/** Hold the button lock until refreshed facts replace the previous offer. */
async function homeAction(run) {
  if (FS.homeActionBusy || FS.inFlight > 0) return;
  FS.homeActionBusy = true; invalidate('panel');
  try { const result = await run(); if (result?.ok) await refresh(); return result; }
  finally { FS.homeActionBusy = false; invalidate('panel'); }
}

export const ACTIONS = {
  'cq-refresh': () => refreshConquest(),
  'cq-march': async d => {
    if (FS.inFlight || !conquestEnabled(FS.season)) return;
    if (!ACTIONS.compose({host:d.host,stay:'map'})) return;
    FS.tab = 'map'; FS.compose.stance = FS.conquest?.keeps.get(`${d.p},${d.q}`)?.holder === FS.citizen?.faction ? 0 : 1;
    await setDestination({p:num(d.p),q:num(d.q),tile:num(d.tile)});
  },
  'cq-outpost': d => homeAction(async () => {
    const target = {p:num(d.p),q:num(d.q),site:num(d.site)};
    const quoted=FS.conquest?.outpost, walletAddress=FS.wallet?.address;
    if(!walletAddress || !conquestEnabled(FS.season)) return failed({code:'NoWallet'});
    const me=await herald.me(walletAddress).catch(()=>({ok:false,code:'Unavailable'}));
    if(!me.ok) return failed(me);
    if(FS.wallet?.address!==walletAddress) return failed({code:'NotOwner'});
    FS.citizen=me.citizen; FS.holdings=me.holdings; FS.land=landState(me.citizen);
    const sources=[target,...FS.holdings.filter(h=>h.order===1 || h.order===2)];
    for(const [i,p] of sources.entries()) {
      if(sources.slice(0,i).some(s=>s.p===p.p && s.q===p.q)) continue;
      if(!await loadEnvelope(p.p,p.q)) return failed({code:'Unavailable'});
    }
    const offer = outpostOffer(FS,target);
    FS.conquest.outpost = offer;
    if (!offer.eligible) return failed({code:offer.code ?? 'OutpostRule',text:offer.reason});
    if(!quoted?.eligible || quoted.target?.p!==target.p || quoted.target?.q!==target.q || quoted.target?.site!==target.site || offer.cost.some((v,i)=>v!==quoted.cost?.[i])) return failed({code:'OutpostRule',text:L`入植の条件と費用が更新されました。内容を確認して、もう一度申請してください。`});
    const anchor = FS.holdings.find(h => h.order===1), slot2 = FS.holdings.find(h => h.order===2) ?? anchor;
    return act('FileOutpost',{v:{sites:[target],anchor,slot2},fields:{sites:[target],anchor_site_key:hostId({...anchor,seq:0})}});
  }),
  'home-pick': d => {
    const h = FS.homeChoice?.candidates?.[num(d.i)];
    if (!h || FS.homeChoice.busy) return;
    FS.homeChoice.selected = h; FS.homeChoice.error = null; FS.homeFocus = h;
    FS.joinDraft = { ...(FS.joinDraft ?? {}), faction: h.faction };
    saveHomePatch({ selected: h }); invalidate('panel', 'map');
  },
  'home-preview': () => { if (FS.homeChoice?.selected) { FS.homeFocus = FS.homeChoice.selected; invalidate('panel', 'map'); } },
  'home-refresh': async () => {
    if (FS.homeChoice?.busy) return;
    if (FS.meStatus === 'error') await refresh();
    if (FS.homeChoice) { FS.homeChoice.rotation = (FS.homeChoice.rotation ?? 0) + 3; FS.homeChoice.selected = null; }
    saveHomePatch({ selected: null }); return refreshHomes({ force: true });
  },
  'home-confirm': () => confirmHome(),
  'prize-refresh': () => refreshPrize({ force: true }),
  'prize-faucet': async () => {
    if (!FS.wallet) return failed({ code: 'NoWallet' });
    busy(() => L`テストUSDCを受け取っています…`);
    const r = await prizeIo.faucet(FS.wallet.address);
    if (!r.ok) return failed(r);
    await refreshPrize({ force: true });
    return done(() => (r.already ? L`テストUSDCは受け取り済みです` : L`テストUSDCを受け取りました`));
  },
  'home-begin': () => {
    const h = ackHomeGrant();
    if (!h) return;
    FS.tab = 'holding';
    invalidate('panel', 'tabs', 'map');
  },
  'home-scout-train': () => homeAction(() => trainOrder(6, 100)),
  'home-scout-muster': () => homeAction(() => musterOrder(6, 100)),
  'me-retry': () => refresh(),
  tab: d => { FS.tab = d.tab; FS.notice = FS.notice?.busy ? FS.notice : null; saveUiPatch({ tab: d.tab }); invalidate('panel', 'tabs'); },
  connect: async d => {
    const entry = (FS.walletList ?? [])[num(d.i)];
    try {
      await wallet.connect(entry, { chain: wallet.chainOf(io.pinned()?.cluster ?? 'localnet') });
    } catch (e) { return failed({ code: e.code ?? 'WalletError', text: e.message }); }
    FS.wallet = wallet.connected();
    FS.meStatus = 'loading'; FS.meError = null; FS.homeGrant = null;
    FS.session = await fsession.restore(scope(), FS.wallet.address);
    await refresh();
  },
  'pick-faction': d => { FS.joinDraft = { ...(FS.joinDraft ?? {}), faction: num(d.f) }; invalidate('panel'); if (needsHomeChoice()) return refreshHomes({ force: true }); },
  join: async () => {
    const pin = io.pinned();
    let s;
    try { s = await fsession.derive({ wallet: wallet.connected(), cluster: pin.cluster, programId: pin.programId, seasonId: pin.seasonId }); } catch (e) { return failed({ code: e.code ?? 'SignFailed' }); }
    fsession.remember(s);
    FS.session = s;
    const lifecycle = { onSent: r => { if (FS.homeChoice?.busy) saveHomePatch({ pending: { kind: 'Join', signature: r.signature } }); },
      onLost: () => { if (FS.homeChoice?.busy) saveHomePatch({ pending: null }); } };
    // A season with a prize pool: the entry fee and the Join in one transaction (x402).
    if (FS.prize) return paidJoin(s, lifecycle);
    const gate = FS.season.joinGate.some(x => x !== 0) ? toBase58(FS.season.joinGate) : null;
    return act('Join', { v: { faction: FS.joinDraft.faction, joinGate: gate, invite: FS.joinDraft.invite },
      fields: { faction: FS.joinDraft.faction, session: s.publicKeyBytes, session_expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) },
      onSent: r => { if (FS.homeChoice?.busy) saveHomePatch({ pending: { kind: 'Join', signature: r.signature } }); },
      onLost: () => { if (FS.homeChoice?.busy) saveHomePatch({ pending: null }); } });
  },
  session: async () => {
    const pin = io.pinned();
    let s;
    try { s = await fsession.derive({ wallet: wallet.connected(), cluster: pin.cluster, programId: pin.programId, seasonId: pin.seasonId }); } catch (e) { return failed({ code: e.code ?? 'SignFailed' }); }
    fsession.remember(s);
    FS.session = s;
    const m = fsession.matchesCitizen(s, FS.citizen, now());
    if (m.ok) { FS.sessionProblem = null; return invalidate('panel'); }
    return act('SetSession', { fields: { session: s.publicKeyBytes, expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) } });
  },
  // the site picker is gone (owner decision V2): the client files the ticket itself; a retry now
  'auto-ticket': () => autoTicket({ force: true }),
  harvest: () => { const h = activeHolding(FS); return act('Harvest', { v: { holding: h }, order: orderOf('harvest', 'Harvest', { grown: h ? grownSince(h, now()) : [], say: () => L`収穫を蔵に納めました` }) }); },
  // Build(item): a building (0–5), the walls (6) or the promotion to the next tier (7: the program's ITEM_TIER_UP)
  build: d => homeAction(() => {
    const h = activeHolding(FS), item = num(d.item);
    const hs = h ? settled(h, now()) : null;
    let order;
    if (item === ITEM_TIER_UP) {
      const tier = Number(hs?.tier ?? 0), secs = TIER_UP[tier]?.secs ?? 0, to = tier + 1;
      order = orderOf('promote', 'Build', { item, from: tier, to, secs, doneAt: hs ? doneAfterQueue(hs, now(), secs) : null, say: () => L`${TIERS[to] ?? ''}への昇格を始めました` });
    } else if (item === ITEM_WALLS) {
      order = orderOf('walls', 'Build', { item, secs: WALLS.secs, doneAt: hs ? doneAfterQueue(hs, now(), WALLS.secs) : null, say: () => L`城壁の工事を始めました` });
    } else {
      const n = hs ? copyNumber(hs, item) : 1, secs = item < 6 && (Number(h?.flags ?? 0) & 2) ? 60 : buildSecs(n);
      order = orderOf('build', 'Build', { item, n, secs, doneAt: hs ? doneAfterQueue(hs, now(), secs) : null, say: () => L`${BUILDINGS[BUILD_ITEMS[item]?.resource] ?? ''}の建設を始めました` });
    }
    return act('Build', { v: { holding: h, item }, fields: { item }, order });
  }),
  // the hand's orders (hud/hand.mjs): the same instructions as the drawer's forms, from data
  train: d => trainOrder(num(d.unit), num(d.n)),
  muster: d => musterOrder(num(d.unit), num(d.troops), d.tile === undefined || d.tile === '' ? null : num(d.tile)),
  garrison: d => garrisonOrder(num(d.n)),
  // W6-D: re-read soon after the keeper was asked (the next poll could be 30 s away, past the window the catch-up opens).
  nudge: (d = {}) => { const h = Number.isInteger(num(d.p)) && Number.isInteger(num(d.q)) ? {p:num(d.p),q:num(d.q)} : activeHolding(FS); if(!h) return; const env = FS.provinces.get(`${h.p},${h.q}`); return io.nudge(h.p, h.q, env?.province.resolvedNext ?? nowBell()).then(r => { refreshSoon(4000); return r.ok ? done(() => L`追いつくよう頼みました`) : failed(r); }); },
  dissolve: d => {
    const r = hostRow(d.host);
    const who = r ? unitCount(UNIT_ORDER[r.unit], r.troops) : null;
    return act('Dissolve', { v: { holding: activeHolding(FS), province: r ? { p: r.p, q: r.q } : null }, fields: { host_id: BigInt(d.host) },
      order: orderOf('dissolve', 'Dissolve', { host: String(d.host), unit: r?.unit ?? null, troops: r?.troops ?? null, tile: r ? { p: r.p, q: r.q, tile: r.tile } : null,
        say: () => (who ? L`${who} の解散を命じました。このターンの決着のあと、兵は控えに戻ります` : L`解散を命じました。このターンの決着のあと、兵は控えに戻ります`) }) });
  },
  compose: d => {
    const r = hostRow(d.host);
    if (!r) return;
    const h = activeHolding(FS);
    const tips = tipOptions(FS.season);
    FS.compose = { holding:{p:h.p,q:h.q,site:h.site,gen:h.gen}, host: { ...r.entry, id: r.id, troops: r.troops, tile: r.tile, unit: r.unit }, origin: { p: r.p, q: r.q }, stance: 0, retreat: 'never', ratio: null,
      tip: String(tips[0].lamports), quick: quickDestinations(), dest: null, route: null, arriveBell: arrivalWindow(FS.season, nowBell()).min };
    // from the map (the inspector) the march is composed on the map; from the Hosts tab, on the Marches tab
    if (d.stay !== 'map') FS.tab = 'marches';
    invalidate('panel', 'tabs', 'map');
    return FS.compose;
  },
  // the march card (hud/marchcard.mjs): the arrival bell stepper, the stance and the retreat presets
  'mc-bell': d => {
    const c = FS.compose;
    if (!c || !FS.season || c.sending) return;
    const w = composerArrival(FS);
    c.earliest = w.earliest;
    c.arriveBell = Math.min(w.max, Math.max(w.min, w.value + (num(d.d) || 0)));
    c.moved = null;   // (the turn is the player's own choice again)
    invalidate('panel');
  },
  'mc-stance': d => { if (FS.compose) { FS.compose.stance = Math.max(0, Math.min(3, num(d.v) || 0)); invalidate('panel'); } },
  'mc-retreat': d => { if (FS.compose && RETREAT_CHOICES.some(r => r.id === d.v)) { FS.compose.retreat = d.v; invalidate('panel'); } },
  'compose-close': () => { FS.compose = null; invalidate('panel'); },
  'dest-from-map': () => { const s = FS.selected; if (s?.idx !== undefined) return setDestination({ p: s.p, q: s.q, tile: s.idx }); return undefined; },
  'dest-quick': d => setDestination({ p: num(d.p), q: num(d.q), tile: num(d.tile) }),
  'march-send': () => sendTheMarch(),
  'explore-open': d => { const r = hostRow(d.host), h=activeHolding(FS); FS.explore = r ? { holding:{p:h.p,q:h.q,site:h.site,gen:h.gen}, host: r, tiles: [] } : null; FS.tab = 'hosts'; invalidate('panel', 'tabs'); },
  'explore-tile': d => { FS.explore.tiles = toggleTile(FS.explore.tiles, num(d.tile)); invalidate('panel'); },
  'explore-send': () => {
    const x = FS.explore;
    if (!x?.host || !x.tiles?.length || FS.inFlight > 0) return undefined;
    const h = x.holding ? holdingByRef(FS.holdings, x.holding) : activeHolding(FS);
    if (!h) return failed({ code: 'NotOwner' });
    const tiles = [...x.tiles];
    return act('Explore', { v: { holding: h, province: { p: x.host.p, q: x.host.q } },
      fields: { host_id: BigInt(x.host.id), n: tiles.length, tiles: Uint8Array.of(tiles[0], tiles[1] ?? 0) }, after: () => { FS.explore = null; },
      order: orderOf('explore', 'Explore', { host: String(x.host.id), tiles, tile: { p: x.host.p, q: x.host.q, tile: x.host.tile }, resultTurn: exploreResultTurn(FS, nowBell()), say: () => L`斥候を探索に出しました（${tiles.length} マス）。${exploreResultWords(exploreResultTurn(FS, nowBell()))}` }) });
  },
  // back to the village: a march like any other (74 stamina, sealed), with the village as its destination
  'march-home': d => {
    const h = activeHolding(FS);
    if (!h) return undefined;
    ACTIONS.compose({ host: d.host, stay: 'map' });
    if (!FS.compose) return undefined;
    FS.compose.home = true;
    return setDestination({ p: h.p, q: h.q, tile: h.tile });
  },
  // ---- the prototype rule "banners" (hud/proto.mjs): orders to the sample world, never to a chain
  'proto-raise': d => protoOrder('raise', { host: d.host, p: num(d.p), q: num(d.q), minTiles: num(d.min) || 0, maxWorks: num(d.max) || 0 }, protoAt(d)),
  'proto-dress': d => protoOrder('dress', { host: d.host, p: num(d.p), q: num(d.q), slot: num(d.slot), tile: num(d.tile) }, { p: num(d.p), q: num(d.q), tile: num(d.tile) }),
  'proto-tend': d => protoOrder('tend', { host: d.host, p: num(d.p), q: num(d.q), slot: num(d.slot) }, protoAt(d)),
  'proto-take': d => protoOrder('take', { host: d.host, p: num(d.p), q: num(d.q), slot: num(d.slot) }, protoAt(d)),
  'proto-pull': d => protoOrder('pull', { host: d.host, p: num(d.p), q: num(d.q), slot: num(d.slot) }, protoAt(d)),
  'proto-strike': d => protoOrder('strike', { p: num(d.p), q: num(d.q), slot: num(d.slot), reason: 'own' }, protoAt(d)),
  'settle-explore': () => settleExplore(),
  'settle-transit': d => settleTransit(d.host),
  forget: () => { if (FS.session) fsession.forget(FS.session); FS.session = null; invalidate('panel'); },
};

/** Where an order of the prototype is about: the host's tile, else the banner's pole. */
function protoAt(d) {
  const r = d.host ? hostRow(d.host) : null;
  if (r) return { p: r.p, q: r.q, tile: r.tile };
  const b = (pm.landOf(FS, num(d.p), num(d.q))?.banners ?? []).find(x => x.slot === num(d.slot));
  return b ? { p: num(d.p), q: num(d.q), tile: b.pole } : null;
}

/** Train(unit, n): an immediate purchase into the village's reserve. */
function trainOrder(unit, n) {
  const who = unitCount(UNIT_ORDER[unit], n);
  return act('Train', { v: { holding: activeHolding(FS) }, fields: { unit, n }, order: orderOf('train', 'Train', { unit, n, say: () => L`${who} を訓練しました。控えに入りました` }) });
}
/** Muster(unit, troops, tile): the host forms up on `tile` of the home province (the village's own tile when none is named) and stands from the next turn. */
function musterOrder(unit, troops, tile = null) {
  const h = activeHolding(FS);
  const at = Number.isInteger(tile) ? tile : h?.tile;
  const who = unitCount(UNIT_ORDER[unit], troops);
  return act('Muster', { v: { holding: h }, fields: { unit, troops, tile: at },
    order: orderOf('muster', 'Muster', { unit, troops, tile: h ? { p: h.p, q: h.q, tile: at } : null, say: () => L`${who} の編成を命じました。次のターンに整列します` }) });
}
/** Garrison(delta): Spearmen of the reserve join the village's garrison. */
function garrisonOrder(n) {
  const k = Math.trunc(n);
  return act('Garrison', { v: { holding: activeHolding(FS) }, fields: { delta: BigInt(k) }, order: orderOf('garrison', 'Garrison', { n: k, say: () => L`守備隊を ${fmtNum(k)} 増やしました` }) });
}

/** Form submissions (data-form). */
export const FORMS = {
  train: f => trainOrder(formNum(f, 'unit'), formNum(f, 'n')),
  muster: f => musterOrder(formNum(f, 'unit'), formNum(f, 'troops'), null),
  garrison: f => garrisonOrder(formNum(f, 'delta')),
  vigil: f => act('SetVigil', { fields: { start_min: Math.max(0, Math.min(23, Math.trunc(formNum(f, 'hour')))) * 60 } }),
  dest: f => setDestination({ p: Math.trunc(formNum(f, 'p')), q: Math.trunc(formNum(f, 'q')), tile: Math.trunc(formNum(f, 'tile')) }),
};

/** Bound inputs (data-bind) of the composer and the join draft. */
export function bind(name, value) {
  if (name === 'invite') { FS.joinDraft = { ...(FS.joinDraft ?? {}), invite: String(value).trim() }; return; }
  const c = FS.compose;
  if (!c) return;
  if (name === 'arriveBell') c.arriveBell = num(value);
  else if (name === 'stance') c.stance = num(value);
  else if (name === 'retreat') c.retreat = String(value);
  else if (name === 'ratio') c.ratio = Number(value);
  else if (name === 'tip') c.tip = String(value);
  invalidate('panel');
}

function hostRow(id) {
  const h = activeHolding(FS);
  if (!h) return null;
  for (const env of FS.provinces.values()) {
    const r = hostsIn(env.province, h, nowBell()).find(x => String(x.id) === String(id));
    if (r) return { ...r, p: env.province.p, q: env.province.q, province: env.province };
  }
  return null;
}

async function fileTicket(sites, source = null, bell = nowBell()) {
  if (!sites.length) return undefined;
  // the "on its way" lock: written once the transaction left this browser, cleared when the chain says it failed or
  // expired (review finding 1, re-check major); an unknown outcome keeps it
  return act('FileTicket', { v: { sites }, fields: { sites },
    onSent: () => saveLandPatch({ lastTicket: sites, ticketSeen: false, lastTicketBell: bell, ticketSource: source,
      ...(FS.landRec?.landEnd ? { landEnd: { ...FS.landRec.landEnd, refiled: true } } : {}) }),
    onLost: () => saveLandPatch({ ticketSeen: true }) });
}

// ------------------------------------------------------------------ start
/**
 * Start play on the game page: `{herald, cfg}`. Wallet discovery (the dev
 * wallet only on a localnet season served from a loopback page), the UI
 * preferences, the session key kept on this device, and the poll loop.
 */
export async function startPlay({ herald: h, cfg }) {
  useHerald(h);
  protoIo.configure({ herald: cfg.herald ?? '' });
  const pin = io.pinned();
  if (pin) herald.pin(pin.seasonId, pin.addresses);
  FS.ui = scope() ? loadUi(uiStorage, uiKey(scope())) : loadUi(uiStorage, '');
  FS.tab = FS.ui.tab;
  wallet.discover();
  if (cfg.dev && pin?.cluster === 'localnet') await wallet.enableDevWallet({ cluster: 'localnet', allowed: true }).catch(() => false);
  const listWallets = () => { FS.walletList = wallet.list(wallet.chainOf(pin?.cluster ?? 'localnet')); invalidate('panel'); };
  wallet.onChange(listWallets);
  listWallets();
  // A silent reconnect of the wallet used last time (no popup; nothing if it does not trust this page).
  const last = wallet.lastWalletName();
  const entry = last && (FS.walletList ?? []).find(w => w.name === last && !w.why);
  if (entry) {
    const c = await wallet.connect(entry, { chain: wallet.chainOf(pin?.cluster ?? 'localnet'), silent: true }).catch(() => null);
    if (c) { FS.wallet = wallet.connected(); FS.session = await fsession.restore(scope(), FS.wallet.address); }
  }
  // The rules module once (the incoming warnings need it too); a missing
  // frontier.wasm is tolerated (the page says what needs it).
  await kernelOrNull();
  await refresh();
  let errors = 0;
  const hidden = () => !!globalThis.document?.hidden;
  const loop = async () => {
    try {
      // Hidden: only the marchbook's self-reveal step (§4.2), not the full refresh.
      if (hidden()) await revealTick(); else await refresh();
      errors = 0;
    } catch (e) { errors++; console.error('frontier refresh:', e); }
    const wait = pollDelay({ hidden: hidden(), inFlight: (FS.inFlight ?? 0) > 0 || (FS.marches ?? []).length > 0, errors, cap: pollCap(FS.chain) });
    setTimeout(loop, wait * 1000);
  };
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!hidden()) refreshSoon(0); });
  setTimeout(loop, Math.min(10, pollCap(FS.chain)) * 1000);
}

/** The hidden page's tick: the self-reveal of the marchbook's due marches only. */
async function revealTick() {
  if (!herald || !FS.clock || !FS.wallet || !(FS.book ?? []).some(e => e.state !== 'settled' && e.state !== 'failed')) return;
  await refreshMarches();
}
