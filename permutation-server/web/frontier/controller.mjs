// The play controller (W3-F): what the game page does between the herald
// (reads), the relay (writes) and the screens. It keeps the viewer's state
// in FS (fstate.mjs), refreshes it on the herald poll schedule (§4.2: 10 s
// while a march or a transaction is in flight, else 30 s; paused while the
// page is hidden, except the marchbook's self-reveal timer), runs the
// self-reveal (I-24, §9.1), and turns every `data-act` of the screens into
// one action: build → check → sign → relay → track (fplay.mjs), the march
// through fmarch.sendMarch. Nothing here decides a rule; the program does.
import { conquestEnabled, kernelFile, territoryStandings, keepFromProvince, applyControl, outpostOffer, mergeKeepEvents } from './fconquest.mjs';
import { holdingByRef } from './fland.mjs';
import * as fwide from './fwide.mjs';
import * as expedition from './fexpedition.mjs';
import * as preparation from './fexpedition-prepare.mjs';
import * as outbound from './fexpedition-compose.mjs';
import { FS, invalidate, activeHolding } from './fstate.mjs';
import { ownTag } from './people/ui.mjs';
import { updateLife } from './people/life.mjs';
import * as io from './fchainio.mjs';
import * as fsession from './fsession.mjs';
import * as fresident from './fresident.mjs';
import { AGENTS_REFRESH_MS, delegatedTo, loadAgents, refusalNote, takenBackNote } from './fdelegation.mjs';
import * as book from './marchbook.mjs';
import { submit, track, accountsFor, campMaskOf, campWinner } from './fplay.mjs';
import { sendMarch, sendMarchRetrying, planRoute, earliestBell, arrivalWindow, tipOptions, incomingWarnings, departMargin, RETREAT_CHOICES } from './fmarch.mjs';
import { landState, hostsIn, TICKET_SEEN_BELLS, FIRST_TICKET_RING, BUILD_ITEMS, UNIT_ORDER } from './fland.mjs';
import { BUILDINGS, TIERS, unitCount, failureText } from './fi18n.mjs';
import { settled, copyNumber, buildSecs, doneAfterQueue, grownSince, ITEM_TIER_UP, ITEM_WALLS, TIER_UP, WALLS } from './hud/rulebook.mjs';
import { exploreResultTurn, exploreResultWords } from './hud/orderparts.mjs';
import { planTicket } from './fjoin.mjs';
import { toggleTile } from './screens/explore.mjs';
import { composerArrival, composerMarch } from './screens/march.mjs';
import { sealMarch, unpack, ctHash as ctHashOf, sealRoot as sealRootOf } from './seal.mjs';
import { bellAt, bellStart, pipeline, archivePartOf, pollCap, roundTime, tlockRound } from './clock.mjs';
import { regionOf, ringOf, ringProvinces, homeNation, hexDistance } from './fgeo.mjs';
import { hostParts, hostId } from './faddr.mjs';
import { decodePage } from './flog.mjs';
import { nextPoll, BELLS_PER_DAY } from './herald.mjs';
import { applySeasonRecord } from './map/world.mjs';
import { readOverviews } from './map/overviews.mjs';
import { kernel as loadKernel, UNITS } from './wasm.mjs';
import { uiKey, uiStorage, loadUi, saveUi, landKey, loadLand, saveLand, LAND_DEFAULTS } from './fui.mjs';
import * as wallet from '../wallet.mjs';
import { EPHEMERAL_WALLET_NAME, currentEphemeralWallet } from './fephemeral-wallet.mjs';
import * as localDepart from './flocalplay-depart.mjs';
import * as localReveal from './flocalplay-reveal.mjs';
import * as localReturn from './flocalplay-return.mjs';
import * as localConquest from './flocalplay-conquest.mjs';
import * as localAct from './flocalplay-act.mjs';
import * as localMarch from './flocalplay-march.mjs';
import { localPlayIdentityOk } from './flocalplay.mjs';
import { decode as fromBase58, encode as toBase58 } from '../sdk/base58.mjs';
import { fromBase64 } from '../sdk/bytes.mjs';
import { L, fmtNum } from '../lang.mjs';
import { emit as fxEmit } from './fx/bus.mjs';
import { reachOrigins } from './screens/conquest.mjs';
import { s1On } from './fs1.mjs';
import { avoidingPalisades, watchOf, structuresIn, walkerOf, palisadeHexesOf } from './s1walk.mjs';
import { fastestPath, pack, landsWanted, landOfProvince, CARAVAN_FEE, MAX_PATH_STEPS, MAX_PATH_PROVINCES } from './fcaravan.mjs';
import { raidOffers, s1VillageModel, s1TileModel, siegeOffer, expelOffer, caravanProblem, KIND, PROPOSE_STANCE, PROPOSE_EXPEL, PROPOSE_READMIT } from './screens/s1.mjs';
import { placeData, raidProvinces, cargoBytes, RAID_CHOICE } from './fplay.mjs';
import { cachedReach, reachKey, reachableKeeps } from './fkeepreach.mjs';
import * as fprize from './fprize.mjs';
import { instantHomeEnabled, HOME_GRANTED, planHomes, homeSites, homeRingsOpen, seasonPlace, sameHome, homeKey, loadHome, saveHome, grantId } from './home.mjs';
// the prototype rule "banners" (a design tried in the sample world, never sent to a chain): its routes and the reading of its records
import * as protoIo from './proto/orders.mjs';
import * as pm from './proto/hand-model.mjs';

const SESSION_DAYS = 30 * 86_400;
/** Local play (flocalplay.mjs): `{address}` once its gate verified a herald for the page's memory-only wallet, else null. */
let localPlay = null;
const localPlayReadOnly = () => ({ code: 'LocalPlayReadOnly', text: () => L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。` });
const now = () => FS.chain?.now() ?? 0;
const nowBell = () => (FS.clock ? bellAt(FS.clock.genesisTs, now()) ?? 0 : 0);
/** The margin a departure is planned with (fmarch.mjs `departMargin`): 90 s on the chain's clock, more game seconds on a clock that runs fast. */
const margin = () => departMargin(FS.chain?.rate);
const scope = () => io.scope();
/** Save UI preferences once a season is pinned (convenience only). */
const saveUiPatch = patch => { const sc = scope(); if (sc) FS.ui = saveUi(uiStorage, uiKey(sc), patch); };
/**
 * The land record of this season and viewer (fui.mjs; the automatic site ticket's state), and the first home's record
 * (home.mjs): per Citizen, so keyed by the viewer (⑳: the NFT played, else the wallet — `viewerKey`; one wallet may
 * hold several NFTs, one Citizen each, and a pending PlaceHome or a chosen site of one is not another's).
 */
const landKeyNow = () => (scope() && FS.wallet?.address ? landKey(scope(), viewerKey()) : null);
const readLand = () => { const k = landKeyNow(); FS.landRec = k ? loadLand(uiStorage, k) : (FS.landRec ?? { ...LAND_DEFAULTS }); return FS.landRec; };
const homeKeyNow = () => scope() ? homeKey(scope(), viewerKey()) : null;
// LOCAL PLAY: the home choice's record (the selected site, the "pending" note with a signature, what was seen) is kept
// in THIS PAGE'S MEMORY ONLY — never in the device's storage. The record's shape and its key are the ordinary ones
// (home.mjs); only where it is kept differs. So a local test leaves nothing on the device, cannot be read by an
// ordinary page or another start, and is gone with the page. Outside local play: the device's storage, as always.
const localHomeMemory = (() => { const m = new Map(); return Object.freeze({ get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); } }); })();
const homeStorage = () => (localPlay ? localHomeMemory : uiStorage);
const readHome = () => homeKeyNow() ? loadHome(homeStorage(), homeKeyNow()) : { selected: null, pending: null, seen: null };
const saveHomePatch = patch => homeKeyNow() ? saveHome(homeStorage(), homeKeyNow(), patch) : null;
const saveLandPatch = patch => { const k = landKeyNow(); FS.landRec = k ? saveLand(uiStorage, k, patch) : { ...(FS.landRec ?? LAND_DEFAULTS), ...patch }; return FS.landRec; };
// (workstream 07: an NFT resident (⑳) seals its own marches; its march book is kept apart from its wallet's Citizen's, or
// the reconciliation against one Citizen's transits would write the other's entries off)
export const bookKey = () => (FS.wallet && scope() ? book.bookKey(scope(), FS.resident?.asset ? `${FS.wallet.address}#nft:${FS.resident.asset}` : FS.wallet.address) : null);
// Notices keep a thunk or the failure itself, so a language switch re-renders them in the new language.
const setNotice = n => { FS.notice = n; invalidate('panel'); };
const busy = text => setNotice({ busy: true, text });
const done = text => setNotice({ ok: true, text });
const failed = r => {
  if (r?.code === 'InviteRequired') FS.inviteRequired = true;
  // The village is handed to the owner's agent (its key is the session): say so, not only "a signature is missing".
  const note = refusalNote(FS.delegation, r?.code);
  if (note && !r?.text) return setNotice({ ok: false, ...r, agentLink: true, text: () => `${failureText(r)} ${note}` });
  // (a refusal of the prototype rule "banners" on one of the basic game's own routes — the day's limit of explorations,
  // which the sample world answers to an Explore — is said in the rule's sentence, only while the prototype is on)
  if (FS.proto && r && !r.text && pm.REFUSALS.includes(r.code)) return setNotice({ ok: false, ...r, text: () => pm.refusalText(r.code, { need: r.need }) });
  return setNotice({ ok: false, ...r, text: r?.text ?? null });
};

/**
 * Whether the village's key is held by the owner's agent (fdelegation.mjs), and whether this relay has an agent
 * wallet at all (the link in "More"). Read once, then again at most every AGENTS_REFRESH_MS while the key does not
 * match; public reads only.
 */
let agentsReadAt = -Infinity;
async function refreshDelegation() {
  if (!FS.wallet?.address) { FS.delegation = null; return; }
  const address = FS.wallet.address;
  const mismatch = FS.sessionProblem === 'SessionMismatch';
  if (!mismatch) { if (FS.delegation) { FS.delegation = null; invalidate('panel'); } if (FS.agentWallet !== undefined) return; }
  const t = Date.now();
  if (FS.agentWallet !== undefined && t - agentsReadAt < AGENTS_REFRESH_MS) return;
  agentsReadAt = t;
  const { enabled, agents } = await loadAgents(address);
  if (FS.wallet?.address !== address) return;
  const was = FS.delegation?.mode ?? null;
  FS.agentWallet = enabled;
  FS.delegation = delegatedTo({ sessionProblem: FS.sessionProblem, citizen: FS.citizen, agents });
  if ((FS.delegation?.mode ?? null) !== was) invalidate('panel');
}

/** The addresses and signer context of a player action. */
function ctx(extra = {}) {
  const pin = io.pinned();
  // ⑳: playing an NFT, the owner's wallet acts for the NFT's Citizen.
  const nft = FS.resident ? fresident.actorContext(FS.resident, FS.wallet.address) : {};
  return { addresses: pin.addresses, wallet: FS.wallet.address, actor: FS.session?.publicKey, faction: FS.citizen?.faction, profile: pin.profile, ...nft, ...extra };
}

/** The address `/h/me` and the quota are read for: the NFT played (⑳), else the wallet. */
const viewerKey = () => FS.resident?.asset ?? FS.wallet?.address;
const viewerCitizen = () => FS.resident?.citizen ?? io.pinned().addresses.of('Citizen', { wallet: FS.wallet.address });
/**
 * The Citizen the viewer's wide inventory must be about (fwide.mjs `parseWideInventory` pins): the NFT's Citizen
 * when one is played, else the connected wallet's canonical Citizen under the pinned program and season; null when
 * neither is known, which refuses the wide inventory rather than showing one. Derived here, never read from `/h/me`.
 */
function viewerCitizenPin() {
  if (FS.resident?.citizen) return FS.resident.citizen;
  const pin = io.pinned();
  return pin && FS.wallet?.address ? pin.addresses.of('Citizen', { wallet: FS.wallet.address }) : null;
}
/**
 * ⑳: the resident (NFT) played changes, or none is played any more: the viewer changes now, so the former viewer's
 * wide inventory and the wide village on the village screen leave now (fwide.mjs) — not when the next `/h/me` answers
 * — and any `/h/me` read still in flight is the former viewer's (`viewerRefresh`, as `adoptConnectedWallet` does).
 * The legacy fields follow the refresh the caller runs next, as before.
 */
export function adoptResident(next) {
  // (workstream 07: another viewer — the NFT's Citizen, or the wallet's own again —: what was read for the former
  // viewer goes, the wide inventory and the wide village included via resetViewer, before the read)
  ++viewerRefresh; ++homesRefresh;
  resetViewer({ wallet: false });
  FS.resident = next;
  FS.meStatus = 'loading';
  invalidate('panel', 'tabs', 'chips', 'map', 'rail');
}

/** ⑳: the wallet's resident NFTs (GET /f/residents); none when the relay has no resident policy. */
export async function loadNfts() {
  FS.nfts = null; FS.nftsRead = null;
  // Only a season of the nft-experimental program (its program version
  // carries 0x8000) has residents; other seasons never ask.
  if (!FS.wallet || !io.relay() || !(Number(FS.season?.programVersion ?? 0) & 0x8000)) return;
  const address = FS.wallet.address;
  const r = await fresident.loadResidents(address).catch(e => ({ ok: false, code: e?.code ?? 'network' }));
  // (workstream 07: an answer for a wallet no longer connected is dropped; a list not read is said as such
  // — FS.nftsRead —, never as "this wallet has no NFT")
  if (FS.wallet?.address !== address) return;
  FS.nftsRead = { ok: !!r?.ok, code: r?.ok ? null : String(r?.code ?? 'Unavailable') };
  if (r?.ok && r.policy) FS.nfts = { residents: r.residents, policy: r.policy };
  invalidate('panel');
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
  const address = FS.wallet?.address ?? null;
  const r = await prizeIo.loadPrize(address);
  if ((FS.wallet?.address ?? null) !== address) return;
  if (!r.ok) return;
  FS.prize = r.pool;
  if (r.pool && r.pool.state !== 'open') {
    const g = await prizeIo.loadLedger();
    if ((FS.wallet?.address ?? null) !== address) return;
    if (g.ok) FS.prizeLedger = g.ledger;
  }
  invalidate('panel');
}

/** The paid Join of a season with a pool: test tokens from the faucet if the wallet is short, then Pay and Join in one signed transaction (x402). */
async function paidJoin(s, { onSent, onLost } = {}) {
  if (localPlay) return failed(localPlayReadOnly());   // no faucet, no payment, no Join
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

/**
 * The key of an order for the double-send guard: its shape and its fields
 * (a second tap on the same button, or a form sent twice, while the first is
 * still on its way, is the same order).
 */
export const sendKey = (name, fields) => `${name}|${JSON.stringify(fields ?? {}, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x))}`;
const sending = new Set();

/** One sponsored action, tracked to its landing; the notice says how it went. */
async function act(name, { v = {}, fields = {}, signer, requester = null, label, after, onSent, onLost, order = null, say = null } = {}) {
  // `signer: null` = a settle shape (no authority signs; the session key signs the request only);
  // `signer: 'wallet'` = the wallet signs a shape the session key may not (a caravan to another player).
  // (a refusal before anything is sent is an answer to the order too)
  const early = r => { orderAnswered(order, false, { code: r.code, sent: false }); return failed(r); };
  // local play is reads only — except the six economy and mustering commands, which go through their OWN page-signed
  // path (flocalplay-act.mjs: the memory-only wallet is fee payer and actor; the relay rebuilds and checks the stated
  // intent). Every other order, and any of the six asked in another form (a settle shape, a wallet-only shape, a
  // requester, accounts that are a function of a fee payer), is refused here before anything is built, signed or sent.
  const route = localAct.localOrderRoute({ localPlay, name, v, signer, requester });
  if (route === 'refuse') return early(localPlayReadOnly());
  // LOCAL PLAY: one order at a time per SCOPE (this wallet, world and relay) and per STABLE key (the command, its
  // village, its fields — for Join only the nation: its expiry is re-made from the clock at every press). The ordinary
  // `sendKey` is not used here: it would tell a Join pressed one second later apart from the one still being signed.
  if (route === 'local-act') {
    const g = localDepartGate();
    if (!g?.ok) return early({ code: g?.code ?? 'LocalActNotAllowed' });
    const local = { scope: localAct.localActScope({ identity: localPlay, relay: g.relay }), key: localAct.localActKey(name, v, fields), origin: g.relay };
    if (local.scope === null) return early({ code: 'LocalActNotAllowed' });
    // SENT AND NOT CONFIRMED under this scope: the press never builds or sends another — it only asks what became of
    // the transaction already sent, by its signature. (Another scope's orders are neither seen nor asked about here.)
    if (localActLedger.held(local.scope, local.key)) {
      const askKey = `local-ask\n${local.scope}\n${local.key}`;
      if (sending.has(askKey)) { busy(() => L`同じ命令を送っています。結果を待ってください…`); return { ok: false, code: 'InFlight' }; }
      sending.add(askKey);
      try { return await localActAsk(name, local, { order, say, after }); } finally { sending.delete(askKey); }
    }
    // IN FLIGHT under this scope (being built, signed or posted: no signature yet): a second press starts nothing
    const out = await localAct.withLocalActSlot(localActLedger, local.scope, local.key, () => actOnce(name, { v, fields, signer, requester, label, after, onSent, onLost, order, say }, early, local));
    if (out?.ok === false && out.code === 'InFlight' && out.sent === undefined) busy(() => L`同じ命令を送っています。結果を待ってください…`);
    return out;
  }
  // the same order already on its way: say so, and send nothing (the chain would refuse the copy, and the player saw an error)
  const key = sendKey(name, fields);
  if (sending.has(key)) { busy(() => L`同じ命令を送っています。結果を待ってください…`); return { ok: false, code: 'InFlight' }; }
  sending.add(key);
  try { return await actOnce(name, { v, fields, signer, requester, label, after, onSent, onLost, order, say }, early); }
  finally { sending.delete(key); }
}

/** Local play's orders that were sent and are not confirmed yet (flocalplay-act.mjs `createLocalActLedger`): page memory only. */
const localActLedger = localAct.createLocalActLedger();
/** The scope the ledger is asked under: this page's verified identity (wallet, program, Season) and the relay its gate allows now; null when the gate is closed. */
const localActScopeNow = () => { const g = localDepartGate(); return localAct.localActScope({ identity: localPlay, relay: g?.ok ? g.relay : null }); };
export const localPlayUnconfirmedOrders = () => localActLedger.list(localActScopeNow()).map(e => ({ name: e.name, signature: e.signature }));
/** An order that was SENT and whose outcome is not known: recorded as that — with its signature — never as refused. */
function orderUnconfirmed(o, signature) {
  if (!o) return;
  const rec = { ...o, state: 'unconfirmed', sent: true, signature, code: 'LocalActUnconfirmed' };
  FS.orders = [rec, ...(FS.orders ?? []).filter(x => x.id !== o.id)].slice(0, ORDERS_MAX);
  const { say: _say, ...payload } = rec;
  fxEmit('order:unconfirmed', payload);
}
const localActUnconfirmedText = signature => () => L`この命令は送信済みですが、まだ確認できていません。同じ命令は送り直しません。もう一度押すと結果を確認します。署名 ${signature}`;
/** A press on an order that is held as sent-and-unconfirmed: ONE question about its signature; nothing is built or sent. */
async function localActAsk(name, lo, { order, say, after }) {
  busy(() => L`送信済みの命令の結果を確認しています…`);
  // (asked at the relay of the scope the order is held under, and used only if the page is still that scope when the
  //  answer comes: otherwise nothing is shown, nothing is released — the order stays held under its own scope)
  const s = await localAct.settleLocalAct(localActLedger, lo.scope, lo.key, localAct.localActRead({ allowed: () => ({ ok: true, relay: lo.origin }) }), { still: () => localActScopeNow() === lo.scope });
  if (s.state === 'left' || s.state === 'none') return { ok: false, code: 'LocalActScopeChanged', sent: s.state === 'left' };
  if (s.state === 'landed') {
    done(say ?? order?.say ?? DONE_TEXT[name] ?? (() => L`完了しました`)); orderAnswered(order, true, { signature: s.signature });
    refresh().catch(e => console.error('frontier refresh:', e)); await after?.({ ok: true, signature: s.signature });
    return { ok: true, signature: s.signature, reconciled: true };
  }
  if (s.state === 'failed') { orderAnswered(order, false, { code: s.code, sent: true, signature: s.signature }); return failed({ ok: false, code: s.code }); }
  orderUnconfirmed(order, s.signature); setNotice({ busy: false, text: localActUnconfirmedText(s.signature) });
  return { ok: false, code: 'LocalActUnconfirmed', signature: s.signature, sent: true };
}

/** What the local-play transport asks of the page: its gate, the identity the gate verified, the Season's ruleset hash as read, the live memory-only wallet. */
const localActDeps = () => ({ allowed: localDepartGate, identity: () => localPlay,
  rulesetHash: () => { const r = FS.season?.rulesetHash; return r instanceof Uint8Array ? [...r].map(b => b.toString(16).padStart(2, '0')).join('') : r; }, signer: currentEphemeralWallet });

// LOCAL PLAY — the ordinary march (flocalplay-march.mjs): the relay's instance-verified capability (read once after
// connect), the memory-only sender, and `FS.localMarch` (a getter, set at init): the ONE answer the UI reads. It is
// closed unless every condition of `localMarchOpen` holds; the page never passes its own readiness.
let localMarchCapability = null, localMarchSender = null;
const localMarchSenderNow = () => (localMarchSender ??= localMarch.createLocalMarchSender({ ...localActDeps(), open: () => FS.localMarch?.open === true }));
function localMarchView() {
  if (!localPlay) return null;
  const h = FS.compose?.holding ? holdingByRef(FS.holdings, FS.compose.holding) : activeHolding(FS);
  return localMarch.localMarchOpen({ capability: localMarchCapability, wallet: FS.wallet?.address ?? null, instance: localPlay.march?.instance ?? null, gate: localDepartGate(),
    holding: h ? { p: h.p, q: h.q, site: h.site } : null, held: localMarchSender ? localMarchSender.held(FS.compose?.host?.id ?? null) : [], trialEntry: localPlay.march?.trialEntry === true });
}

// `lo` (local play's six only; null otherwise): `{scope, key, origin}` taken by `act` BEFORE anything was awaited — the
// scope the order is sent, held and followed under, and the relay it is sent through.
async function actOnce(name, { v, fields, signer, requester, label, after, onSent, onLost, order, say }, early, lo = null) {
  // a wide holding among the subjects, or a village order while the village screen shows a wide village: refused
  // before anything is built or sent (fwide.mjs: the one guard every path meets)
  { const wr = fwide.wideRefusal(name, typeof v === 'object' ? v : null, FS); if (wr) return early(wr); }
  if (!io.pinned()) return early({ code: 'NoPin' });
  if (!FS.wallet) return early({ code: 'NoWallet' });
  // (only one of the six reaches here in local play: `act` refused the rest. No session key, no sponsor, no NFT path.)
  const local = lo !== null && localAct.localOrderRoute({ localPlay, name, v, signer, requester }) === 'local-act';
  if (localPlay && !local) return early(localPlayReadOnly());
  if (local && FS.resident) return early(localPlayReadOnly());
  let sign = null;
  // ⑳: an NFT Citizen has no Frontier session; its owner's wallet signs, for
  // the generation read fresh now (a transfer since the page loaded changes it).
  let resident = null;
  if (FS.resident && signer !== null && name !== 'JoinResident') {
    if (name === 'SetSession') return early({ code: 'NftNoSession' });
    const g = await fresident.currentGeneration(FS.wallet.address, FS.resident.asset);
    if (g === null) return early({ code: 'NftNotHeld' });
    FS.resident = { ...FS.resident, generation: g };
    resident = { generation: g, proof: FS.resident.proof };
  }
  if (signer !== null && !local) {
    if (name === 'Join' || name === 'JoinResident' || name === 'SetSession' || signer === 'wallet' || resident) {
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
    // (a wide holding among the subjects is refused as late as the send — and, for accounts that are a function of
    // the fee payer, inside that function, so none are built —; the screen's state was judged above, when the order
    // was authorized: an order of a legacy village that continues after the viewer moved to a wide village is not
    // refused here, an order naming a wide village is, however it got this far. fwide.mjs assertLegacySubjects)
    // (local play builds its own accounts, with the wallet as actor and fee payer: flocalplay-act.mjs)
    const accounts = local ? null : typeof v === 'function' ? fp => accountsFor(name, fwide.assertLegacySubjects(name, v(fp))) : accountsFor(name, ctx(v));
    const send = () => {
      const late = typeof v === 'object' ? fwide.wideRefusal(name, v, null) : null;
      if (late) return { ok: false, code: late.code, error: late.text, text: late.text };
      // (a relay that does not serve the economy routes: said as it always was — local play is reads only there)
      if (local) return localAct.submitLocalAct({ name, v, fields }, localActDeps()).then(x => { if (x.ok || x.code !== 'LocalActNotServed') return x; const ro = localPlayReadOnly(); return { ok: false, code: ro.code, error: ro.text, text: ro.text }; });
      return tx.submit({ name, accounts, fields, signer: sign, requester, citizen: requester ? viewerCitizen() : undefined, invite: v.invite, resident });
    };
    // (local play: the scope the order is sent under — this wallet, world and relay — was taken by `act` BEFORE anything
    //  was awaited: what is held is held under the identity it was sent with, and it is followed at the relay it was
    //  sent through, only while the page is still that scope)
    const lscope = local ? lo.scope : null, lkey = local ? lo.key : null;
    const stillScope = () => localActScopeNow() === lscope;
    // (in local play the transaction is followed by the relay's own status of its signature — the relay of the SEND,
    //  not whatever the page's gate allows at each later poll; `left` = the page is no longer that scope)
    const follow = async signature => {
      if (!local) return tx.track(signature);
      const f = await localAct.followLocalAct(signature, { origin: lo.origin, still: stillScope });
      return f.state === 'landed' ? { ok: true, state: 'landed', slot: f.slot } : f.state === 'failed' ? { ok: false, state: 'failed', code: f.code }
        : f.state === 'left' ? { ok: false, state: 'left', code: 'LocalActScopeChanged' } : { ok: false, state: 'unknown', code: 'Unconfirmed' };
    };
    let r = await send();
    if (local && r.ok) {
      // LOCAL PLAY, the moment the one send has a signature (flocalplay-act.mjs `settleLocalSend`) — in this order:
      // the order is HELD by its signature under the scope it was sent under; THEN the scope is asked; and only if the
      // page is still that scope does the page's own callback run (a callback that throws cannot lose the hold).
      sent = true;
      const s = localAct.settleLocalSend(localActLedger, lo, name, r, { still: stillScope, onSent });
      if (s.state === 'left') { code = 'LocalActScopeChanged'; fxDone = true; return { ok: false, code, signature: r.signature, sent: true }; }
      if (s.callbackError) console.error('frontier local order callback:', s.callbackError);
      fxEmit('action:sent', fxa);
    } else if (r.ok) {
      // the transaction left this browser (a refusal before sending never reaches here)
      sent = true; onSent?.(r); fxEmit('action:sent', fxa);
    }
    let t = r.ok ? await follow(r.signature) : r;
    // THE PAGE IS NO LONGER THE SCOPE THE ORDER WAS SENT UNDER (another wallet, world or relay, while it was sent or
    // followed): nothing of it is shown on the page as it is now — no "done", no failure, no order record — and it is
    // NOT released: it stays held under its own scope, by its signature, for when the page is that scope again.
    if (local && r.ok && (t.state === 'left' || !stillScope())) { code = 'LocalActScopeChanged'; fxDone = true; return { ok: false, code, signature: r.signature, sent: true }; }
    if (local && r.ok && (t.ok || t.state === 'failed')) localActLedger.release(lscope, lkey);
    // LOCAL PLAY, sent and NOT confirmed (no answer, pending, processed only): this is not a refusal and not a failure.
    // The order keeps its signature, is recorded as "sent, not confirmed", and stays held.
    if (local && r.ok && !t.ok && t.state !== 'failed') {
      code = 'LocalActUnconfirmed'; fxDone = true;
      orderUnconfirmed(order, r.signature); setNotice({ busy: false, text: localActUnconfirmedText(r.signature) });
      return { ok: false, code, signature: r.signature, sent: true };
    }
    // W6-D: a resident action refused because the province fell a bell behind between the check and the landing:
    // ask the keeper to catch it up, wait for the herald to show it, and send once more.
    // (never in local play: there a second transaction is only ever the player's own new press)
    if (!local && !t.ok && retryAfterCatchUp(name, t.code)) {
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
  if (localPlay) return false;   // the keeper is not asked for anything
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
let walletSyncEpoch = 0, connectingWallet = false;

function refreshSoon(ms = 1500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(e => console.error('frontier refresh:', e)), ms);
}

/**
 * Forget everything read for the viewer (workstream 07: shared by a wallet change and by a change between the wallet's
 * own Citizen and one of its resident NFTs — each is another viewer: its Citizen, villages, marches and notices).
 */
function resetViewer({ wallet: walletChanged = true } = {}) {
  expedition.clearInspection(FS); outbound.clearOutbound(FS);
  // (workstream 07: the former viewer's answer is not this viewer's: hud/drawer.mjs viewerState keeps an answered
  // record's view across a failed refresh only for the viewer and world it answered for. A reply still in flight for
  // the former viewer is dropped by refresh's currentViewer check, before applyMeResult.)
  FS.meAnswered = false;
  if (walletChanged) FS.session = null;
  if (walletChanged) FS.sessionProblem = null;
  FS.citizen = null;
  FS.holdings = [];
  FS.activeHolding = 0;
  FS.land = landState(null);
  FS.landRec = null;
  FS.quota = null;
  FS.book = [];
  FS.marches = [];
  FS.bellItems = [];
  FS.formingBells = [];
  FS.orders = [];
  FS.departed = null;
  mySlots = [];
  if (walletChanged) FS.delegation = null;
  if (walletChanged) FS.agentWallet = undefined;
  FS.homeChoice = null;
  FS.homeGrant = null;
  FS.homeFocus = null;
  FS.joinDraft = null;
  FS.compose = null;
  FS.explore = null;
  FS.exploreSeedReady = false;
  FS.autoTicket = null;
  FS.autoFull = new Map();
  FS.autoForceAt = 0;
  FS.autoNudgeBell = null;
  FS.incoming = [];
  FS.isMine = () => false;
  if (walletChanged) FS.prize = null;
  if (walletChanged) FS.prizePayment = null;
  // the wide inventory and the wide village on the village screen were the previous viewer's (fwide.mjs)
  fwide.clearWide(FS);
  FS.notice = null;
  // (⑳: the NFT played and the wallet's NFT list belong to the wallet: a resident NFT chosen under the previous wallet is not this wallet's)
  if (walletChanged) { FS.resident = null; FS.nfts = null; FS.nftsRead = null; }
}

/** A wallet event changes the viewer immediately; old /h/me replies may not restore the former owner. */
export function adoptConnectedWallet(next = wallet.connected()) {
  const address = next?.address ?? null;
  if (address === (FS.wallet?.address ?? null)) { FS.wallet = next; return false; }
  ++walletSyncEpoch;
  ++viewerRefresh;
  ++homesRefresh;
  agentsReadAt = -Infinity;
  prizeReadAt = 0;
  FS.wallet = next;
  resetViewer({ wallet: true });
  FS.meStatus = next ? 'loading' : 'ready';
  FS.meError = null;
  invalidate('panel', 'tabs', 'chips', 'map');
  return true;
}

async function syncConnectedWallet({ refreshUnchanged = false } = {}) {
  const next = wallet.connected();
  if (!adoptConnectedWallet(next)) {
    if (refreshUnchanged) await refresh();
    return;
  }
  const address = next?.address ?? null;
  const epoch = walletSyncEpoch;
  if (address) {
    try {
      const sc = scope();
      // (local play: no stored session key is read)
      const restored = sc && !localPlay ? await fsession.restore(sc, address) : null;
      if (epoch !== walletSyncEpoch) return;
      FS.session = restored;
    } catch (e) { console.error('frontier session restore:', e); }
  }
  // ⑳: the new wallet's resident NFTs (none without a resident policy).
  if (epoch === walletSyncEpoch) await loadNfts().catch(e => console.error('frontier residents:', e));
  if (epoch === walletSyncEpoch) await refresh();
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
  if (localPlay) { orderAnswered(order, false, { code: 'LocalPlayReadOnly', sent: false }); return failed(localPlayReadOnly()); }
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
    // ⑱: never before T(arrive) is published (+ REVEAL_PUBLISH_MARGIN): until then the material stays in this browser.
    // Judged on the chain time the herald has observed, not the extrapolated clock (the bots' contract, W6-C).
    const tPub = roundTime(FS.clock.drand.genesis, FS.clock.drand.period, tlockRound(FS.clock.drand, FS.clock.genesisTs, e.arriveBell)) + book.REVEAL_PUBLISH_MARGIN;
    const step = book.revealStep(e, { now: now(), bellStart: bellStart(FS.clock.genesisTs, e.arriveBell), notBefore: tPub, seen: Math.min(now(), FS.chain?.last?.unix ?? -Infinity), windowOpen: pl.state === 'open' || pl.state === 'awaitingBeacon' || pl.state === 'revealing', slotPresent: seen });
    // (local play: the self-reveal is a request to the keeper; none is made)
    if (step.action === 'send' && !localPlay) {
      const r = await io.reveal(book.revealMaterial(e));
      // (the attempt goes into the book as it stands now: a march sealed while the keeper answered is kept)
      const cur = book.recordAttempt(book.loadBook(store, key), e, { t: now(), route: 'self', result: r.ok ? 'accepted' : r.code });
      book.saveBook(store, key, cur);
      e = cur.find(x => sameMarch(x, first)) ?? e;
    }
    // (local play: the keeper sends the SettleTransit, as it reveals — the relay serves no page settle, so no button)
    const settleReady = !localPlay && !!transit && !!env && transit.state >= 2 && pl.state === 'resolved' && pl.close !== null && now() >= pl.close + 600;
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
  // (the viewer's forming hosts: the herald's facts of each muster turn, read like an arrival's once that turn has
  // ended, so the page says where the turn really is — hud/firststeps.mjs formingPhase. A read, nothing is sent)
  const forming = [];
  for (const env of holding ? FS.provinces?.values() ?? [] : []) {
    for (const r of hostsIn(env.province, holding, b)) {
      if (r.state !== 2 || !Number.isInteger(r.fromBell) || r.fromBell < 1) continue;
      const bell = r.fromBell - 1, rn = env.province.resolvedNext ?? null;
      // (a read that failed leaves the host without facts: the page then says only that it is forming)
      const got = b > bell ? await bellFacts(bell, regionOf(env.province.p, env.province.q), rn).then(x => (x.record ? x : null), () => null) : { facts: { resolvedNext: rn } };
      if (got) forming.push({ host: String(r.id), bell, facts: got.facts });
    }
  }
  if (key !== bookKey()) return;
  FS.formingBells = forming;
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
  // (workstream 07: a page that could not be read is said as such — screens/chronicle.mjs chronicleState —, never as an
  // empty record: FS.chronicle stays undefined until a page has been read, and FS.chronicleRead says how the last poll went)
  let failed = null, pages = 0;
  for (let page = 0; page < CHRONICLE_PAGES; page++) {
    let r;
    try { r = await herald.events(cursor); } catch (e) { r = { ok: false, code: e?.code ?? 'network' }; }
    if (!r?.ok) { failed = String(r?.code ?? 'Unavailable'); break; }
    pages++;
    const { records } = decodePage(r.events);
    // (the prototype's own records ride on the same pages, in a sample world that serves them)
    if (FS.proto) { const had = FS.proto.log, log = pm.mergeLog(had, pm.landRecords(r.events)); if (log.length !== had.length || log.at(-1)?.seq !== had.at(-1)?.seq) { FS.proto.log = log; FS.proto.rev = (FS.proto.rev ?? 0) + 1; } }
    FS.chronicle = [...(FS.chronicle ?? []), ...records].slice(-400);
    // the life of every holding (people/life.mjs): folded from every record read, not only the last 400
    FS.life = updateLife(FS.life ?? new Map(), records);
    if (r.next !== null && r.next !== undefined) cursor = r.next;
    if (!r.full) break;
  }
  if (pages > 0 && FS.chronicle === undefined) FS.chronicle = [];
  FS.chronicleRead = { ok: failed === null, code: failed, pages, bell: nowBell() };
  const own = FS.holdings ?? [];
  FS.isMine = rec => {
    if (rec.host_id !== undefined) { const h = hostParts(rec.host_id); return !!h && own.some(o => o.p === h.p && o.q === h.q && o.site === h.site); }
    return rec.p !== undefined && own.some(o => o.p === rec.p && o.q === rec.q && (rec.site === undefined || rec.site === o.site));
  };
  // Incoming (§7.7): public departures from other factions' holdings.
  const departures = (FS.chronicle ?? []).filter(x => x.record.name === 'DEPART').map(x => {
    const h = hostParts(x.record.host_id);
    const ov = h && [...FS.overviews.values()].flatMap(o => o.provinces).find(pr => pr.p === h.p && pr.q === h.q);
    return { ...x.record, faction: ov && h ? ov.owners[h.site] : null };
  }).filter(d => d.faction !== null && d.faction < 6);
  const k = FS.kernel ?? null;
  FS.incoming = FS.citizen ? incomingWarnings({ kernel: k, departures, holdings: own.map(o => ({ p: o.p, q: o.q, site: o.site, tile: o.tile, shieldUntilBell: FS.provinces.get(`${o.p},${o.q}`)?.province?.siteMirror?.[o.site]?.shieldUntilBell })), faction: FS.citizen.faction, genesisTs: FS.clock.genesisTs, nowBell: nowBell(), unitOf: () => WARNING_UNIT }) : [];
}

/** The herald client this controller reads (startPlay sets it; tests pass a fake). */
export function useHerald(h) { expedition.clearInspection(FS); outbound.clearOutbound(FS); herald = h; cursor = 0; mySlots = []; conquestRefresh += 1; homesRefresh += 1; viewerRefresh += 1; fwide.clearWide(FS); FS.meAnswered = false; }

/** A read-only request: deliberately outside ACTIONS, FORMS and the order lifecycle. */
export const expeditionContext = () => ({ pin: io.pinned(), relay: io.relay(), source: herald });
export const inspectOriginalExpedition = () => expedition.inspectExpedition(FS, { context: expeditionContext, changed: () => invalidate('panel') });
export const prepareOriginalExpedition = () => preparation.prepareExpedition(FS, { context: expeditionContext, changed: () => invalidate('panel') });
export const reconcileExpedition = () => { preparation.reconcilePreparation(FS, expeditionContext()); outbound.reconcileOutbound(FS, expeditionContext()); return expedition.reconcileInspection(FS, expeditionContext()); };
/** Local geometry/plaintext preparation, deliberately outside ACTIONS and FORMS. */
export const openOriginalOutbound = () => { outbound.openOutbound(FS, expeditionContext()); invalidate('map', 'panel'); };
export const editOriginalOutbound = (action, value) => { const ok = outbound.editOutbound(FS, expeditionContext(), action, value); invalidate('map', 'panel'); return ok; };
export const tapOriginalOutbound = hit => { const result = outbound.tapOutbound(FS, expeditionContext(), hit); if (result.handled) invalidate('map', 'panel'); return result; };
export const originalOutboundMap = () => outbound.readOutboundMap(FS, expeditionContext());
export const inspectOriginalOutboundRoute = () => outbound.inspectOutboundRoute(FS, { context: expeditionContext, changed: () => invalidate('panel') });
export const inspectOriginalOutboundContext = () => outbound.inspectOutboundContext(FS, { context: expeditionContext, changed: () => invalidate('panel') });
/**
 * One press on the boundary card: the earliest arrival turn of the observation still bound to this draft goes into
 * the draft's arrival field, and that observation is read again. A local edit and a read, like the two above:
 * deliberately outside ACTIONS and FORMS, nothing sealed, signed or sent. → `{ok, arriveBell?, from?, code?}`.
 */
export const useEarliestOriginalOutboundArrival = () => outbound.useEarliestOutboundArrival(FS, { context: expeditionContext, changed: () => invalidate('map', 'panel') });
/**
 * Local play only (flocalplay-depart.mjs): the ONE send the local-play page makes. The departure of the boundary
 * draft, signed by the page's memory-only wallet, through the loopback relay's two dedicated routes. Every other
 * order stays refused (`localPlayReadOnly`): this does not pass through `act`, a session key, the faucet or the
 * general relay route. Asked on every step: local play with its verified identity, localnet, a loopback page and
 * relay, the identity's own wallet connected, and that wallet the live memory-only one.
 */
const localDepartGate = () => localDepart.localDepartAllowed({ localPlay, cluster: io.pinned()?.cluster, relay: io.relay(), wallet: FS.wallet?.address ?? null, signer: currentEphemeralWallet() });
const localDepartChanged = () => invalidate('map', 'panel');
export const localPlayDepartAllowed = () => localDepartGate();
export const sendLocalPlayDeparture = () => localDepart.runLocalDepart(FS, { allowed: localDepartGate, context: expeditionContext,
  sealInput: () => ({ clock: FS.clock, drand: FS.record?.drand, seasonPkHash: FS.season?.quicknetPkHash, seasonNetwork: FS.season?.network, cluster: FS.record?.cluster }),
  seal: async req => (await import('./seal-wide.mjs')).sealWide(req), signer: currentEphemeralWallet, changed: localDepartChanged });
export const reconcileLocalPlayDeparture = () => localDepart.reconcileLocalDepart(FS, { allowed: localDepartGate, changed: localDepartChanged });
export const clearLocalPlayDeparture = () => { const ok = localDepart.clearLocalDepart(FS); if (ok) localDepartChanged(); return ok; };
/**
 * Local play only (flocalplay-reveal.mjs): the explicit Reveal of a departure this page sealed, under the same gate
 * as the departure. Two presses, never one: `check` reads the chain and says whether it can be revealed (nothing is
 * built or signed); `send` reveals what was checked, signed by the same memory-only wallet, once. An outcome that is
 * not known is asked about (`reconcile`), never sent again. "revealed" says the chain has the reveal and no more:
 * the arrival's gathering, battle and settlement are not this page's to do or to claim.
 */
const localRevealDeps = () => ({ allowed: localDepartGate, signer: currentEphemeralWallet, changed: localDepartChanged,
  budget: () => localReveal.LOCAL_REVEAL_BUDGET });
export const checkLocalPlayReveal = () => localReveal.checkLocalReveal(FS, localRevealDeps());
export const sendLocalPlayReveal = () => localReveal.runLocalReveal(FS, localRevealDeps());
export const reconcileLocalPlayReveal = () => localReveal.reconcileLocalReveal(FS, localRevealDeps());
export const clearLocalPlayReveal = () => { const ok = localReveal.clearLocalReveal(FS); if (ok) localDepartChanged(); return ok; };
/**
 * Local play only (flocalplay-return.mjs): the two player-signed steps of the existing return (Dissolve, then, after
 * the turn's own processing, Return), from the return card's own observation and under the departure's gate. Two
 * presses: `prepare` (nothing is signed) and the explicit `send` of what was prepared, once. An outcome that is not
 * known is asked about (`reconcile`), never sent again. Outside ACTIONS and FORMS, like the departure.
 */
const localReturnDeps = () => ({ allowed: localDepartGate, context: expeditionContext, signer: currentEphemeralWallet, changed: () => invalidate('panel') });
export const prepareLocalPlayReturn = () => localReturn.prepareLocalReturn(FS, localReturnDeps());
export const sendLocalPlayReturn = () => localReturn.sendLocalReturn(FS, localReturnDeps());
export const reconcileLocalPlayReturn = () => localReturn.reconcileLocalReturn(FS, localReturnDeps());
/**
 * Local play only, CLOSED BY DEFAULT (flocalplay-conquest.mjs): the one player-signed conquest step, DeclareSiege of
 * the Free City in the province an original host stays in, from the expedition card's own observation and under the
 * departure's gate. Two presses (prepare, then the explicit send); an outcome not known is asked about, never sent
 * again. `world` is this start's world capability as the local-play identity carries it (`conquestWorld`); the
 * launcher does not provide one today, so nothing is prepared. No `conditions` is passed: the module's own apply.
 */
const localConquestDeps = () => ({ allowed: localDepartGate, context: expeditionContext, signer: currentEphemeralWallet, world: () => localPlay?.conquestWorld ?? null, changed: () => invalidate('panel') });
export const prepareLocalPlayConquest = () => localConquest.prepareLocalConquest(FS, localConquestDeps());
export const sendLocalPlayConquest = () => localConquest.sendLocalConquest(FS, localConquestDeps());
export const reconcileLocalPlayConquest = () => localConquest.reconcileLocalConquest(FS, localConquestDeps());
/** Read-only (flocalplay-conquest.mjs): this wallet's siege reservations in the province the observed host stands in. Closed like the step above: no condition is passed from here. */
export const readLocalPlayConquestOrders = () => localConquest.readLocalConquestOrders(FS, localConquestDeps());
export const clearLocalPlayReturn = () => { const ok = localReturn.clearLocalReturn(FS); if (ok) invalidate('panel'); return ok; };

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
  // (workstream 07: a Province asked for and not stored — its read failed, e.g. 404 for one not on chain yet — waits the
  // same interval: each finished load redraws, and the redraw asked for it again at once, hundreds of times a minute)
  if (!have && fetchedAt.has(key) && now - fetchedAt.get(key) < WANT_REFRESH_MS) return false;
  artWanted.add(key);
  fetchedAt.set(key, now);
  loadEnvelope(p, q).catch(() => null).finally(() => { artWanted.delete(key); onLoad(); });
  return true;
}

/**
 * ⑳: whether the Citizen of a /h/me read is the viewer's own kind. Playing an NFT, the NFT's Citizen: its bytes carry
 * the resident mark naming the asset played (fcodec `residentAsset`). As the wallet, a wallet Citizen: no mark. The
 * herald serves the key's wallet Citizen first (`me_citizen`), and the herald client checks each kind against the key
 * alone, so a wallet Citizen whose wallet is the asset address passes there; it is still not the NFT's Citizen.
 */
function viewerOwnCitizen(citizen) {
  if (!citizen) return true;
  const mark = citizen.residentAsset;
  return FS.resident ? !!mark && toBase58(mark) === FS.resident.asset : mark === undefined;
}

/** Apply one /h/me read to the viewer. A missing Citizen is ready; a failed read is an error. */
export function applyMeResult(me) {
  // (another kind of Citizen than the viewer's: refused like any other Citizen of another key, never adopted)
  if (me.ok && !viewerOwnCitizen(me.citizen)) me = { ok: false, code: 'WrongKey' };
  if (me.ok) {
    FS.meStatus = 'ready'; FS.meError = null; FS.meAnswered = true;
    const before = FS.land?.stage;
    FS.citizen = me.citizen;
    FS.holdings = me.holdings;
    mySlots = me.slots ?? [];
    // the wide inventory (`wideContext`, `wideHoldings`) beside — never inside — the legacy holdings, checked against
    // this season's world and addresses, the Citizen the viewer *is* (derived from the wallet or the NFT played, never
    // read from the answer) and the viewer's own Citizen bytes (the slot bindings); a refused inventory is a wide
    // error, never a change to the legacy view (fwide.mjs)
    fwide.adoptWide(FS, me.record, { seasonAddress: FS.record?.seasonAddress, programId: FS.record?.programId,
      seasonId: io.pinned()?.seasonId ?? FS.record?.season ?? null, citizen: viewerCitizenPin(), citizenRecord: me.citizen ?? null, viewerKey: viewerKey() ?? null });
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
    // ⑳: an NFT Citizen has no Frontier session (its owner's wallet signs every action; SetSession is refused for
    // it): there is no key to mend, and the wallet's own key is not held against it
    if (FS.resident) FS.sessionProblem = null;
    else if (FS.session && FS.citizen) {
      const m = fsession.matchesCitizen(FS.session, FS.citizen, now());
      FS.sessionProblem = m.ok ? null : m.code;
    }
    refreshDelegation().catch(e => console.error('frontier delegation:', e));
    // An unchanged successful poll may replace decoded account objects while an
    // inspection is still reading. Retain it only if its complete identity still
    // resolves after adoption. Owner/generation/issuance changes fail closed.
    reconcileExpedition();
    return 'found';
  }
  expedition.clearInspection(FS, { keepInputs: true }); outbound.clearOutbound(FS);
  if (me.code === 'NotFound') {
    FS.meStatus = 'ready'; FS.meError = null; FS.meAnswered = true;
    FS.citizen = null; FS.holdings = []; FS.land = landState(null);
    mySlots = [];
    fwide.clearWide(FS); FS.wideStatus = 'unavailable';
    return 'missing';
  }
  FS.meStatus = 'error'; FS.meError = { code: me.code ?? 'Unavailable', text: L`自分の情報を読み込めませんでした。接続を確認して再試行してください。` };
  // (a failed read leaves no wide data and no wide selection behind: a wide card would stand on nothing)
  fwide.failWide(FS, me.code ?? 'Unavailable');
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
    const currentViewer = () => request === viewerRefresh && FS.wallet?.address === address;
    // ⑳: herald's /h/me/{asset} answers an NFT's Citizen (the wallet's own Citizen first).
    const me = await herald.me(viewerKey()).catch(e => ({ ok: false, code: e?.code ?? 'Unavailable' }));
    // A previous poll or wallet must not replace the viewer selected by a newer refresh.
    if (!currentViewer()) return;
    if (FS.proto) await refreshProto(me.ok ? me.record : undefined);
    if (!currentViewer()) return;
    if (applyMeResult(me) === 'error') return;
    const h = activeHolding(FS);
    // every holding's province (the rail can switch between them), the active one first
    for (const o of [h, ...(FS.holdings ?? []).filter(x => x !== h)]) if (o) { await loadEnvelope(o.p, o.q); if (!currentViewer()) return; }
    const home = h ? FS.provinces.get(`${h.p},${h.q}`)?.province ?? null : null;
    // (local play: the page's own catch-up request to the keeper is not made)
    if (!localPlay && shouldAutoNudge({ holding: h, province: home, nowBell: FS.nowBell, lastBell: FS.autoNudgeBell ?? null, hidden: !!globalThis.document?.hidden })) {
      FS.autoNudgeBell = FS.nowBell;
      io.nudge(h.p, h.q, home.resolvedNext).then(r => { if (r.ok) refreshSoon(4000); }).catch(() => {});
    }
    // (the prototype rule "banners": the provinces of the viewer's own nation in ring 2 (fgeo homeNation under the
    // season's placement), where a banner of another nation may be about to rise: their land records are read with
    // the viewer's own, whether or not the map shows them)
    if (FS.proto && Number.isInteger(FS.citizen?.faction)) { const place = seasonPlace(FS.season); for (const pq of ringProvinces(2)) { if (homeNation(pq.p, pq.q, place) === FS.citizen.faction && !(h && h.p === pq.p && h.q === pq.q)) { await loadEnvelope(pq.p, pq.q); if (!currentViewer()) return; } } }
    // Hosts standing in other provinces (after a march that Stays): their
    // envelopes too, so the Hosts tab can show and command them.
    if (me.ok) for (const pq of hostProvinces(me.record, h ? { p: h.p, q: h.q } : null)) { await loadEnvelope(pq.p, pq.q); if (!currentViewer()) return; }
    // SettleExplore is offered once the explore bell's seed is readable.
    FS.exploreSeedReady = false;
    if (h?.explore?.state && nowBell() >= h.explore.bell) {
      const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q));
      if (!currentViewer()) return;
      FS.exploreSeedReady = r.ok && !!seedSourceOf(r.record);
    }
    await refreshMarches();
    if (!currentViewer()) return;
    if (FS.citizen && io.pinned()) {
      const q = await io.quota(viewerCitizen());
      if (!currentViewer()) return;
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
    seeds: (FS.record?.rings ?? []).map(r => ({ ring: r.d, seed: r.seed })), blocked: palisadeHexes(FS) };
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
    seeds: (FS.record?.rings ?? []).map(x => ({ ring: x.d, seed: x.seed })), blocked: palisadeHexes(FS) };
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
/**
 * S1 (redesign stage 1): the caravans, structures and nations feeds into
 * `FS.s1`. A feed the herald has not written yet (NotFound) reads as a
 * fresh season's ([`s1Fresh`]): nothing built, every stance war. (It read
 * as nothing, which hid the nation's council until a proposal existed, so
 * nobody could make the first one.) Any other failure keeps what was read
 * before.
 */
export const s1Fresh = name => ({
  caravans: () => ({ v: 1, moving: [], vaults: [] }),
  structures: () => ({ v: 1, structures: [], sightings: [] }),
  nations: () => ({ v: 1, stances: Array.from({ length: 6 }, () => Array(6).fill(0)), proposals: [], expelled: [], domesticRaids: [] }),
})[name]?.() ?? null;
async function refreshS1(request) {
  const s1 = FS.s1 ??= { caravans: null, structures: null, nations: null, error: null };
  const names = ['caravans', 'structures', 'nations'];
  const results = await Promise.allSettled(names.map(n => herald[n]()));
  if (request !== conquestRefresh) return;
  s1.error = null;
  names.forEach((n, i) => {
    const r = results[i].status === 'fulfilled' ? results[i].value : null;
    if (r?.ok) s1[n] = r[n];
    else if (r?.code === 'NotFound') s1[n] ??= s1Fresh(n);
    else s1.error = L`隊商・構造物・国家の最新情報を取得できませんでした。`;
  });
  // the Provinces the viewer's own caravans stand in: their slots say whether a raid holds one (map/s1marks heldByRaids)
  const me = ownTag(FS);
  for (const c of s1.caravans?.moving ?? []) {
    if (me === null || me === undefined || BigInt(c.ownerTag) !== BigInt(me)) continue;
    for (const r of c.runs ?? []) wantProvince(r.p, r.q, () => invalidate('map'));
  }
}

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
  if (s1On()) await refreshS1(request);
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
    // (the rings a first village may be placed in: the open rings, no further than the heartland: home.mjs homeRingsOpen)
    const result = await planHomes({ overviews: FS.overviews, faction, nowBell: nowBell(), place: seasonPlace(FS.season), ringsOpen: homeRingsOpen(FS.season, FS.record?.rings?.length ?? 0),
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
    if (saved.pending && localPlay) {
      // LOCAL PLAY: the note is of a page-signed Join or PlaceHome. It is asked about as every local order is — ONCE, at
      // the relay of this scope (wallet, world, relay), only while the page is still that scope (flocalplay-act.mjs
      // `recheckLocalPending`) — never through the ordinary tracker. The note is cleared ONLY on the chain's own word
      // (landed, or refused); an unknown outcome keeps it and nothing is sent in its place; if the page became another
      // scope meanwhile, nothing is shown and nothing is touched.
      pending('confirming');
      const g = localDepartGate(), lscope = g?.ok ? localAct.localActScope({ identity: localPlay, relay: g.relay }) : null;
      if (lscope === null) return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
      const still = () => localActScopeNow() === lscope;
      // (the note says which scope — which relay too — its transaction was sent under: asked only when that is the
      //  page's scope now. A note of another relay, wallet or world is neither asked about nor cleared: it stays.)
      const s = await localAct.recheckLocalPending(localActLedger, lscope, saved.pending, { origin: g.relay, still });
      if (s.state === 'left' || !still()) return;
      if (s.state === 'other-scope') return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
      await refresh();
      if (!still()) return;
      if (FS.homeGrant) return;
      // The note is cleared by what the page now SEES of this wallet in this world (its Citizen exists: the Join is
      // done — also when the relay no longer knows the signature, or the order was already let go), or by the chain's
      // own refusal. An unknown outcome with nothing to see keeps it; nothing is sent in its place.
      if (saved.pending.kind === 'Join' && FS.citizen) saveHomePatch({ pending: null });
      else if (s.state === 'failed') saveHomePatch({ pending: null });
      else return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
    } else if (saved.pending) {
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
    if (!homeSites(env?.province, { faction: site.faction, nowBell: nowBell(), ringsOpen: homeRingsOpen(FS.season, FS.record?.rings?.length ?? 0), place: seasonPlace(FS.season) }).some(s => sameHome(s, site))) {
      FS.homeChoice.selected = null; saveHomePatch({ selected: null });
      return error('SiteUnavailable', L`この土地は現在選べません。候補を更新して別の土地を選んでください。`);
    }
    saveHomePatch({ selected: site });
    if (!FS.citizen) {
      pending('joining');
      if (FS.resident) {
        // ⑳: an NFT's Citizen is made by its first login (nft-login: JoinResident), never by the wallet Join; it is
        // on its way from the herald
        if (!await waitForOwn(() => !!FS.citizen)) return error('PendingHome', L`参加が記録されました。自分の情報の反映を待っています。`);
      } else {
        FS.joinDraft = { ...(FS.joinDraft ?? {}), faction: site.faction };
        const joined = await ACTIONS.join();
        if (!joined?.ok) return;
        if (!await waitForOwn(() => !!FS.citizen)) return error('PendingHome', L`参加が記録されました。自分の情報の反映を待っています。`);
        saveHomePatch({ pending: null });
      }
      if (FS.citizen.faction !== site.faction) { FS.homeChoice.selected = null; return error('WrongFaction', L`参加済みの国の土地を選んでください。`); }
    }
    if (FS.holdings?.length) { updateHomeGrant(); return; }
    // ⑳: an NFT Citizen has no in-game key (its owner's wallet signs the PlaceHome, for the pass's current
    // generation): the key step is a wallet Citizen's. (Found in the integration: the page asked the wallet for a key
    // the program refuses to register for an NFT Citizen, SetSession → NftNoSession, and the village was never placed)
    // (local play: no in-game key at all — the memory-only wallet signs the PlaceHome itself; SetSession is never asked)
    if (!localPlay && !FS.resident && (!FS.session || FS.sessionProblem)) {
      await ACTIONS.session(); await refresh();
      if (!FS.session || FS.sessionProblem) return;
    }
    pending('placing');
    const placed = await act('PlaceHome', { v: { holding: site, faction: FS.citizen.faction }, fields: { p: site.p, q: site.q, site: site.site },
      label: () => L`あなたの村を確定しています…`,
      // (local play: the note also carries the scope the PlaceHome was SENT under — wallet, world and relay — given by
      //  the local send step; outside local play no scope is given and the note is what it always was)
      onSent: (r, sentUnder) => saveHomePatch({ pending: { kind: 'PlaceHome', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }),
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
  // (⑳: an NFT Citizen files with its owner's wallet, it has no in-game key to wait for)
  if ((!FS.resident && (!FS.session || FS.sessionProblem)) || !Number.isInteger(FS.citizen?.faction) || FS.autoTicketBusy) return;
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
    const plan = await planTicket({ overviews: FS.overviews ?? new Map(), place: seasonPlace(FS.season), faction: FS.citizen.faction, ringsOpen: FS.record?.rings?.length ?? 1,
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
let overviewRefresh = null, overviewSource = null;
function refreshOverviews(b) {
  if (overviewRefresh?.bell === b && overviewRefresh.herald === herald) return overviewRefresh.promise;
  if (FS.overviewsBell === b && overviewSource === herald) return Promise.resolve();
  const request = { bell: b, herald, promise: null };
  overviewRefresh = request;
  request.promise = (async () => {
    try {
      try {
        const r = await request.herald.season();
        if (herald !== request.herald) return;
        // A later bell's read owns the season record; the older caller joins it.
        if (overviewRefresh !== request) return overviewRefresh?.promise;
        // The record, the world's extent and the ring lists move together. Setting
        // FS.record alone left FS.world behind the ticket planner's latest read.
        if (r?.ok && r.record) {
          applySeasonRecord(FS, r.record, { herald, onRings: () => invalidate('map', 'panel') });
          if (r.season) FS.season = r.season;
        }
      } catch { /* keep the last record */ }
      if (herald !== request.herald) return;
      if (overviewRefresh !== request) return overviewRefresh?.promise;
      // The rings the world has (map/world.mjs, set by applySeasonRecord above): a sparse world's own seeded rings,
      // else 0 .. ringsOpen − 1. Never counted from the record's length: a world that seeds ring 128 alone has one
      // entry, and its overview is ring 128's, not ring 0's.
      const world = FS.world;
      const count = Math.max(1, world?.ringsOpen ?? FS.record?.rings?.length ?? 1);
      // Also refresh rings 0–1 as map summaries: a newer season read may supersede
      // their queued boot reads. Ticket candidate rules still start at FIRST_TICKET_RING.
      const rings = world?.seeded ? [...world.seeded] : Array.from({ length: count }, (_, i) => i);
      // The same four-request queue serves boot and refresh; PSFOV2 cannot be
      // overwritten by a delayed legacy boot response. Ticket planning still awaits all.
      const results = await readOverviews(FS, { herald, rings, v2: conquestEnabled(FS.season),
        onChange: () => invalidate('map', 'panel'),
      });
      if (herald !== request.herald) return;
      if (overviewRefresh !== request) return overviewRefresh?.promise;
      // A partial/failed read remains retryable; a superseded caller cannot mark
      // the replacement client's or newer bell's refresh complete.
      if (results.every(Boolean)) {
        FS.overviewsBell = b;
        overviewSource = herald;
      }
    } finally {
      if (overviewRefresh === request) overviewRefresh = null;
    }
  })();
  return request.promise;
}

// ------------------------------------------------------------------ the composer
async function kernelOrNull() {
  if (FS.kernel) return FS.kernel;
  try { FS.kernel = await loadKernel({ ruleset: Buffer2hex(FS.season.rulesetHash), url: new URL(`./wasm/${kernelFile(FS.season)}`, import.meta.url) }); FS.kernelError = null; } catch (e) { FS.kernelError = e.code ?? 'NoWasm'; FS.kernel = null; }
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
  const r = planRoute(k, { from: { p: c.origin.p, q: c.origin.q, tile: c.host.tile }, to: dest, unit: c.host.unit, seeds, blocked: palisadeHexes(FS) });
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
  // local play: refused unless the march's own answer is open (FS.localMarch: capability, readiness, gate, village, no
  // held march); then ONE attempt below — no rollover resend, no nudge, no session, no stored book (the march's own
  // path does not go through `act`)
  if (localPlay && FS.localMarch?.open !== true) return failed(localPlayReadOnly());
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
    const r = localPlay ? await sendMarch(m, {
      seal: req => sealMarch(req), clock: FS.clock, publicKey: FS.beacon?.publicKey, accounts: null, session: null,
      ...localMarchSenderNow().depsFor({ holding: { p: h.p, q: h.q, site: h.site }, province: { p: c.origin.p, q: c.origin.q } }),
      onStep: s => { c.step = s; invalidate('panel'); },
      earliestAtSend: () => (FS.kernel && c.route ? earliestBell(FS.kernel, { genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: c.route.secs }) : null),
    }) : await sendMarchRetrying(m, {
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
    const marchOrder = orderOf('march', 'Depart', { host: String(c.host.id), unit: c.host.unit ?? 0, troops: c.host.troops ?? null, tile: { p: c.origin.p, q: c.origin.q, tile: c.host.tile },
      dest: c.dest ? { p: c.dest.p, q: c.dest.q, tile: c.dest.tile } : null, arriveBell: arrive, home });
    // (local play: a march that carries a signature WAS sent — it is never recorded as "not sent". Not confirmed: held
    //  by its signature (the memory book keeps it `sent`; only "ask" is offered). Failed on chain: sent, and refused there)
    const localSent = localPlay && !r.ok && typeof r.signature === 'string' && r.signature !== '';
    if (localSent && r.code !== 'TransactionFailed') orderUnconfirmed(marchOrder, r.signature);
    else orderAnswered(marchOrder, r.ok, r.ok ? {} : localSent ? { code: r.code ?? null, sent: true, signature: r.signature } : { code: r.code ?? null, sent: false });
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
      if (localSent && r.code !== 'TransactionFailed') setNotice({ busy: false, text: localActUnconfirmedText(r.signature) }); else failed(r);
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

// ------------------------------------------------------------------ S1 orders (screens/s1.mjs offers them)
const s1Refused = text => failed({ code: 'S1Refused', text });
/** Decoded Provinces as lands for a road from `a` to `b` (loaded as needed; a Province not open yet is left out). */
async function landsFor(a, b) {
  const out = [];
  for (const c of landsWanted(a, b)) {
    const key = `${c.p},${c.q}`;
    if (!FS.provinces.get(key)) await loadEnvelope(c.p, c.q).catch(() => null);
    const prov = FS.provinces.get(key)?.province;
    if (prov) out.push(landOfProvince(prov));
  }
  // (S1-1E-CONTRACT §2.5: a caravan's road through a palisade that stops it is refused `Path`; its callers plan round it)
  const w = walkerOf(FS);
  return w ? avoidingPalisades(out, (p, q) => watchOf(structuresIn(w.structures, p, q), w.stances, w.faction, w.expelled)) : out;
}
/** The hexes a march of the viewer must not plan through: the palisades that stop it (reveal.rs refuses such a walk). */
export const palisadeHexes = (fs = FS) => palisadeHexesOf(fs);
const s1Tile = d => ({ p: num(d.p), q: num(d.q), tile: num(d.tile) });
function s1Build(name, kind, at) {
  const h = activeHolding(FS);
  if (!h) return s1Refused(L`費用を払う村を選んでください`);
  const what = kind ? ({ [KIND.tower]: L`物見櫓`, [KIND.palisade]: L`柵`, [KIND.fort]: L`要塞` })[kind] : L`貯蔵庫`;
  const fields = name === 'BuildVault' ? { tile: at.tile } : { kind, tile: at.tile, notify: kind === KIND.tower ? 1 : 0 };
  return act(name, { v: { holding: h, at }, fields, order: orderOf('s1-build', name, { tile: at, say: () => L`${what}を建てました` }) });
}
/** SeizeVault / SeizeStructure: the viewer's host on the tile takes another's storehouse or structure. */
async function s1Seize(d) {
  const at = s1Tile(d);
  const m = s1TileModel(FS, { p: at.p, q: at.q, idx: at.tile });
  const o = m?.seize;
  if (!o) return s1Refused(L`このマスには奪えるものがありません`);
  if (o.blocks.length) return failed({ code: o.blocks[0] === 'NoHostHere' ? 'NotOnTile' : o.blocks[0] });
  const name = d.what === 'vault' ? 'SeizeVault' : 'SeizeStructure';
  const what = d.what === 'vault' ? L`貯蔵庫` : ({ [KIND.tower]: L`物見櫓`, [KIND.palisade]: L`柵`, [KIND.fort]: L`要塞` })[m.structure?.kind] ?? L`建物`;
  return act(name, { v: { at, hostHolding: o.hostHolding, ownerCitizen: o.ownerCitizen, province: at }, fields: { entry: o.entry },
    order: orderOf('s1-seize', name, { tile: at, say: () => L`${what}を奪いました` }) });
}
/**
 * DeclareSiege on another nation's village or a Free City (conquest contract
 * §3.4): the host standing there, its village paying; the target's owner
 * Citizen read from its Holding (the herald's /h/holding); the viewer's first
 * village within two provinces named for the Frontier-protection rule.
 */
async function s1Siege(d) {
  const sel = { p: num(d.p), q: num(d.q), idx: num(d.tile) };
  const o = siegeOffer(FS, sel);
  if (!o) return s1Refused(L`このマスには包囲できる村がありません`);
  if (o.blocks.length) return failed({ code: o.blocks[0] === 'NoFighterHere' ? 'NotOnHex' : o.blocks[0] });
  const A = io.pinned().addresses;
  let ownerCitizen = A.absent(0), order = 0;
  if (!o.freeCity) {
    busy(() => L`村の持ち主を確かめています…`);
    const r = await herald.holding(o.target.p, o.target.q, o.target.site);
    if (!r.ok) return failed(r);
    ownerCitizen = r.holding.ownerCitizen; order = r.holding.order;
  }
  const first = (FS.holdings ?? []).find(h => h.order === 1 || h.order === undefined);
  const near = first && hexDistance(first.p, first.q, o.target.p, o.target.q) <= 2 ? first : null;
  const word = o.freeCity ? L`自由都市` : order === 1 ? L`村（占領）` : L`村（奪取）`;
  return act('DeclareSiege', { v: { holding: o.src, province: o.target, target: o.target, ownerCitizen, nearby: near ? { p: near.p, q: near.q } : null },
    fields: { site: o.site, entry: o.entry, nearby_site: near ? near.site : 0 },
    order: orderOf('s1-siege', 'DeclareSiege', { tile: { p: sel.p, q: sel.q, tile: sel.idx }, say: () => L`${word}の包囲を宣言しました` }) });
}
/** Propose the expulsion (KIND_EXPEL) or the readmission (KIND_READMIT) of a village of the viewer's nation, named by one of its holdings. */
async function s1ProposeVillage(kind, at) {
  if (!at) return s1Refused(L`この村の情報をまだ読み込んでいません`);
  busy(() => L`村の持ち主を確かめています…`);
  const r = await herald.holding(at.p, at.q, at.site);
  if (!r.ok) return failed(r);
  const faction = FS.citizen?.faction;
  return act('Propose', { v: { faction, target: r.holding.ownerCitizen }, fields: { kind, target_faction: faction, value: 0 },
    say: () => (kind === PROPOSE_EXPEL ? L`村の追放を提案しました` : L`村を国に戻す提案をしました`) });
}
/** RaidCaravan: the viewer's host won a raid; take the caravan home or burn its load. */
async function s1Raid(d) {
  const r = raidOffers(FS).find(x => x.p === num(d.p) && x.q === num(d.q) && x.slot === num(d.slot));
  if (!r) return s1Refused(L`この略奪はもう決められません`);
  const A = io.pinned().addresses;
  const caravan = A.of('Caravan', { ownerTag: BigInt(r.caravan.ownerTag), seq: r.caravan.seq });
  const raid = { p: r.p, q: r.q };
  if (d.choice !== 'take') {
    return act('RaidCaravan', { v: { caravan, raider: r.raider, raid, dst: null },
      fields: { p: r.p, q: r.q, choice: RAID_CHOICE.burn, n_path: 1, dst_kind: 0, dst_p: 0, dst_q: 0, dst_at: 0, dst_gen: 0, steps: 0, path: new Uint8Array(12) },
      order: orderOf('s1-raid', 'RaidCaravan', { tile: { p: r.p, q: r.q, tile: r.tile }, say: () => L`隊商の荷を焼き払いました` }) });
  }
  if (!r.caravan.provinces) return s1Refused(L`この隊商の道筋がまだ読めません。焼き払うことはできます`);
  const home = (FS.holdings ?? []).find(h => h.p === r.raider.p && h.q === r.raider.q && h.site === r.raider.site);
  if (!home || !Number.isInteger(home.tile)) return s1Refused(L`荷を運ぶ村が見つかりません`);
  busy(() => L`道を探しています…`);
  const plan = fastestPath({ p: r.p, q: r.q, tile: r.tile }, { p: home.p, q: home.q, tile: home.tile }, await landsFor(raid, home));
  if (!plan || !plan.dirs.length) return s1Refused(L`村まで隊商の道が届きません（${fmtNum(MAX_PATH_STEPS)} マス・${fmtNum(MAX_PATH_PROVINCES)} 州まで）。焼き払うことはできます`);
  const dst = { kind: 'holding', p: home.p, q: home.q, site: home.site, gen: home.gen ?? 0 };
  const route = { raid, dst, pathProvinces: plan.provinces, oldRoute: r.caravan.provinces };
  return act('RaidCaravan', { v: { caravan, raider: r.raider, ...route },
    fields: { p: r.p, q: r.q, choice: RAID_CHOICE.take, n_path: raidProvinces(route).nPath, ...placeData(dst), steps: plan.dirs.length, path: pack(plan.dirs) },
    order: orderOf('s1-raid', 'RaidCaravan', { tile: { p: r.p, q: r.q, tile: r.tile }, say: () => L`隊商を奪い、村へ向かわせました` }) });
}
/**
 * SendCaravan from the village in hand or one of the viewer's storehouses to another of the viewer's places, or to
 * another player's village or storehouse: that one is signed by the wallet (caravan.rs WalletRequired), and a
 * village's generation is read from its Holding first (the herald's /h/holding).
 */
async function s1Caravan(srcIndex, dstIndex, cargo) {
  const m = s1VillageModel(FS), from = m.sources[srcIndex];
  let dst = m.destinations[dstIndex];
  const problem = caravanProblem(from, dst, cargo);
  if (problem === 'NoPlace') return s1Refused(L`出発地と行き先を選んでください`);
  if (problem === 'SamePlace') return s1Refused(L`出発地と行き先が同じです`);
  if (problem === 'NoCargo') return s1Refused(L`運ぶものを入れてください`);
  if (problem === 'Insufficient') return failed({ code: 'Insufficient' });
  if (!Number.isInteger(from.tile) || !Number.isInteger(dst.tile)) return s1Refused(L`出発地か行き先のマスがわかりません`);
  if (dst.other && !wallet.connected()) return failed({ code: 'NoWallet' });
  if (dst.other && dst.kind === 'holding') {
    busy(() => L`行き先の村を確かめています…`);
    const r = await herald.holding(dst.p, dst.q, dst.site);
    if (!r.ok) return failed(r);
    if (!Number.isInteger(Number(r.holding.gen))) return s1Refused(L`行き先の村はもうありません`);
    dst = { ...dst, gen: Number(r.holding.gen) };
  }
  busy(() => L`道を探しています…`);
  const plan = fastestPath({ p: from.p, q: from.q, tile: from.tile }, { p: dst.p, q: dst.q, tile: dst.tile }, await landsFor(from, dst));
  if (!plan || !plan.dirs.length) return s1Refused(L`そこまで隊商の道が届きません（${fmtNum(MAX_PATH_STEPS)} マス・${fmtNum(MAX_PATH_PROVINCES)} 州まで）`);
  const seq = Number(FS.citizen?.caravans ?? 0);
  const src = from.kind === 'vault' ? { kind: 'vault', p: from.p, q: from.q, tile: from.tile, gen: from.gen } : { kind: 'holding', p: from.p, q: from.q, site: from.site, gen: from.gen ?? 0 };
  const target = { kind: dst.kind, p: dst.p, q: dst.q, ...(dst.kind === 'vault' ? { tile: dst.tile } : { site: dst.site }), gen: dst.gen ?? 0 };
  return act('SendCaravan', { v: { seq, src, dst: target, provinces: plan.provinces, ...(dst.other ? { actor: FS.wallet.address } : {}) },
    fields: { seq, ...placeData(target), steps: plan.dirs.length, path: pack(plan.dirs), cargo: cargoBytes(cargo), fee: CARAVAN_FEE },
    ...(dst.other ? { signer: 'wallet', label: () => L`ほかの人の村か貯蔵庫へ送る隊商は、ウォレットで署名します…` } : {}),
    order: orderOf('s1-caravan', 'SendCaravan', { say: () => L`隊商が出発しました` }) });
}

export const ACTIONS = {
  'cq-refresh': () => refreshConquest(),
  // S1 (screens/s1.mjs)
  's1-vault': d => s1Build('BuildVault', 0, s1Tile(d)),
  's1-structure': d => s1Build('BuildStructure', num(d.kind), s1Tile(d)),
  's1-raid': d => s1Raid(d),
  's1-seize': d => s1Seize(d),
  's1-siege': d => s1Siege(d),
  's1-expel': d => {
    const o = expelOffer(FS, { p: num(d.p), q: num(d.q), idx: FS.provinces.get(`${num(d.p)},${num(d.q)}`)?.province?.sites?.[num(d.site)] });
    if (!o) return s1Refused(L`この村は追放を提案できません`);
    if (o.blocks.length) return failed({ code: o.blocks[0] === 'Expelled' ? 'NotVoter' : o.blocks[0] });
    return s1ProposeVillage(PROPOSE_EXPEL, { p: o.p, q: o.q, site: o.site });
  },
  's1-readmit': d => {
    const x = s1VillageModel(FS).nation?.out.find(e => String(e.tag) === String(d.tag));
    if (!x?.readmittable) return s1Refused(L`この村はまだ国に戻す提案ができません`);
    return s1ProposeVillage(PROPOSE_READMIT, x.holdings[0]);
  },
  's1-vote': d => act('Vote', { v: { faction: FS.citizen?.faction }, fields: { slot: num(d.slot), id: num(d.id), yes: num(d.yes) ? 1 : 0 },
    say: () => (num(d.yes) ? L`賛成に投票しました` : L`反対に投票しました`) }),
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
  // the wide village of an inventory slot on the village screen (read-only; screens/wideholding.mjs), and back
  'wide-select': d => { if (!fwide.selectWide(FS, num(d.slot))) return; FS.notice = FS.notice?.busy ? FS.notice : null; invalidate('panel', 'tabs', 'rail'); },
  'wide-close': () => { fwide.clearWideSelect(FS); invalidate('panel', 'tabs', 'rail'); },
  tab: d => { FS.tab = d.tab; FS.notice = FS.notice?.busy ? FS.notice : null; saveUiPatch({ tab: d.tab }); invalidate('panel', 'tabs'); },
  connect: async d => {
    const entry = (FS.walletList ?? [])[num(d.i)];
    connectingWallet = true;
    try {
      await wallet.connect(entry, { chain: wallet.chainOf(io.pinned()?.cluster ?? 'localnet') });
    } catch (e) { return failed({ code: e.code ?? 'WalletError', text: e.message }); }
    finally { connectingWallet = false; }
    await syncConnectedWallet({ refreshUnchanged: true });
  },
  // ⑳ (provisional): play one of the wallet's resident NFTs — the first login
  // (JoinResident) when its Citizen does not exist yet in this season.
  'nft-login': async d => {
    if (!FS.wallet) return failed({ code: 'NoWallet' });
    const entry = (FS.nfts?.residents ?? []).find(x => x.asset === d.asset);
    if (!entry || !FS.nfts.policy) return failed({ code: 'NftNotHeld' });
    const pin = io.pinned();
    const id = fresident.identityOf(entry, FS.nfts.policy, { addresses: pin.addresses, programId: pin.programId });
    if (!Number.isInteger(id.generation)) return failed({ code: 'NftNotHeld' });
    if (!id.joined) {
      if (!Number.isInteger(FS.joinDraft?.faction)) return failed({ code: 'PickFaction' });
      const gate = FS.season.joinGate.some(x => x !== 0) ? toBase58(FS.season.joinGate) : null;
      const r = await act('JoinResident', {
        v: { resident: fresident.joinAccounts(id, { addresses: pin.addresses, owner: FS.wallet.address }), joinGate: gate, invite: FS.joinDraft.invite },
        fields: { generation: id.generation, faction: FS.joinDraft.faction },
      });
      if (!r?.ok) return r;
    }
    // (the viewer changes here, before the read: the former viewer's state, wide inventory and selection leave at once)
    adoptResident({ ...id, joined: true });
    await refresh();
  },
  'nft-logout': async () => { adoptResident(null); await refresh(); },
  'pick-faction': d => { FS.joinDraft = { ...(FS.joinDraft ?? {}), faction: num(d.f) }; invalidate('panel'); if (needsHomeChoice()) return refreshHomes({ force: true }); },
  join: async () => {
    // LOCAL PLAY: no in-game key is derived, remembered or registered. The page's memory-only wallet signs the Join
    // itself and is the only key the Citizen will ever have (flocalplay-act.mjs writes the wallet as the Join's
    // session key). A Season with a prize pool or a join gate is not served there.
    if (localPlay) {
      if (FS.prize || FS.season?.joinGate?.some?.(x => x !== 0)) return failed(localPlayReadOnly());
      return act('Join', { v: { faction: FS.joinDraft.faction }, fields: { faction: FS.joinDraft.faction, session_expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) },
        // (the note carries the scope the Join was SENT under: it is asked about again only at that relay, for that wallet and world)
        onSent: (r, sentUnder) => { if (FS.homeChoice?.busy) saveHomePatch({ pending: { kind: 'Join', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }); },
        onLost: () => { if (FS.homeChoice?.busy) saveHomePatch({ pending: null }); } });
    }
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
    // Taking the key back from the owner's agent: say what this does (the key) and what it does not (the server's auto).
    const handed = FS.delegation;
    return act('SetSession', { fields: { session: s.publicKeyBytes, expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) },
      ...(handed ? { say: () => takenBackNote(handed), after: () => { FS.delegation = null; } } : {}) });
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
  // (local play: ONE status read of a held march; it sends nothing)
  'local-march-ask': (d = {}) => (localPlay && localMarchSender && typeof d.signature === 'string' ? localMarchSender.ask(d.signature).then(x => { invalidate('panel'); return x; }) : null),
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

// The guard on the village orders (fwide.mjs): while a wide village stands on the village screen, none of these runs
// from there, however it is reached (a stale control, a forged dataset, a shortcut, a repeated press, a call).
fwide.guardLegacy(ACTIONS, fwide.GUARDED_ACTS, { FS, refuse: failed });

// Local play: the actions that make or store a session key, pay, or ask the relay to do something do not run at all
// (the orders themselves stop in `act`). The ordinary page never has `localPlay` set, and runs them as before.
// (2026-11-12: `join` and `home-confirm` are no longer here. In local play they make no key and pay nothing: the Join
//  and the PlaceHome are two of the six page-signed economy commands — the memory-only wallet signs them itself, no
//  in-game key is derived or registered, the home choice's record stays in the page's memory — and they do something
//  only where the relay serves those routes; elsewhere they answer "reads only" as every order does. A Season with a
//  prize pool or a join gate is refused inside `join`. The session, NFT, faucet, nudge and forget actions stay refused.)
export const LOCAL_PLAY_REFUSED = Object.freeze(['session', 'nft-login', 'nft-logout', 'prize-faucet', 'nudge', 'forget']);
for (const name of LOCAL_PLAY_REFUSED) {
  const run = ACTIONS[name];
  if (run) ACTIONS[name] = (...a) => (localPlay ? failed(localPlayReadOnly()) : run(...a));
}

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
    order: orderOf('muster', 'Muster', { unit, troops, tile: h ? { p: h.p, q: h.q, tile: at } : null, say: () => L`${who} の編成を命じました。このターンの決着のあとに整列します` }) });
}
/** Garrison(delta): Spearmen of the reserve join the village's garrison. */
function garrisonOrder(n) {
  const k = Math.trunc(n);
  return act('Garrison', { v: { holding: activeHolding(FS) }, fields: { delta: BigInt(k) }, order: orderOf('garrison', 'Garrison', { n: k, say: () => L`守備隊を ${fmtNum(k)} 増やしました` }) });
}

/** Form submissions (data-form). */
export const FORMS = {
  // S1 (screens/s1.mjs)
  's1-caravan': f => s1Caravan(Math.trunc(formNum(f, 'src') || 0), Math.trunc(formNum(f, 'dst')),Array.from({ length: 8 }, (_, i) => Math.max(0, Math.trunc(formNum(f, `c${i}`) || 0)))),
  's1-fort': f => {
    const h = activeHolding(FS), troops = Math.trunc(formNum(f, 'troops')), tile = Math.trunc(formNum(f, 'tile'));
    if (!h) return s1Refused(L`村を選んでください`);
    return act('FortGarrison', { v: { holding: h, tile }, fields: { troops }, order: orderOf('s1-fort', 'FortGarrison', { tile: { p: h.p, q: h.q, tile }, say: () => L`要塞に槍兵 ${fmtNum(troops)} を入れました` }) });
  },
  's1-propose': f => act('Propose', { v: { faction: FS.citizen?.faction }, fields: { kind: PROPOSE_STANCE, target_faction: Math.trunc(formNum(f, 'target')), value: Math.trunc(formNum(f, 'value')) },
    say: () => L`方針の変更を提案しました` }),
  train: f => trainOrder(formNum(f, 'unit'), formNum(f, 'n')),
  muster: f => musterOrder(formNum(f, 'unit'), formNum(f, 'troops'), null),
  garrison: f => garrisonOrder(formNum(f, 'delta')),
  vigil: f => act('SetVigil', { fields: { start_min: Math.max(0, Math.min(23, Math.trunc(formNum(f, 'hour')))) * 60 } }),
  dest: f => setDestination({ p: Math.trunc(formNum(f, 'p')), q: Math.trunc(formNum(f, 'q')), tile: Math.trunc(formNum(f, 'tile')) }),
};
fwide.guardLegacy(FORMS, fwide.GUARDED_FORMS, { FS, refuse: failed });

/** Bound inputs (data-bind) of the composer and the join draft. */
export function bind(name, value) {
  if (name.startsWith('outbound-')) { editOriginalOutbound(name.slice(9), value); return; }
  if (expedition.inspectionInput(FS, name, value)) { invalidate('panel'); return; }
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
  // Local play is settled first, before any discovery, wallet event or read of this start can run an effect.
  localPlay = cfg.localPlay ?? null;
  FS.localPlay = localPlay;
  useHerald(h);
  Object.defineProperty(FS, 'localMarch', { configurable: true, enumerable: false, get: localMarchView });
  protoIo.configure({ herald: cfg.herald ?? '' });
  const pin = io.pinned();
  if (pin) herald.pin(pin.seasonId, pin.addresses);
  FS.ui = scope() ? loadUi(uiStorage, uiKey(scope())) : loadUi(uiStorage, '');
  FS.tab = FS.ui.tab;
  wallet.discover();
  if (cfg.dev && cfg.devWallet !== false && pin?.cluster === 'localnet') await wallet.enableDevWallet({ cluster: 'localnet', allowed: true }).catch(() => false);
  let walletEventsReady = false;
  const listWallets = () => {
    FS.walletList = wallet.list(wallet.chainOf(pin?.cluster ?? 'localnet'));
    invalidate('panel');
    if (walletEventsReady && !connectingWallet) syncConnectedWallet().catch(e => console.error('frontier wallet change:', e));
  };
  wallet.onChange(listWallets);
  listWallets();
  // Local play (flocalplay.mjs; cfg.localPlay is set only by its verified gate): the page's memory-only test wallet is
  // connected through the ordinary Wallet Standard path, and nothing else. No remembered wallet is reconnected and no
  // session key is restored, made or stored; every send is refused (`localPlay`, set at the top). Reads only.
  // The season this boot read and pinned by its ordinary path must be the very identity the gate verified (the
  // dedicated program, localnet, that Season account, the dispatch revision); otherwise no wallet is connected.
  if (localPlay && !localPlayIdentityOk(localPlay, pin, FS.season)) {
    FS.error = { code: 'LocalPlayIdentityChanged', text: L`ローカルプレイの接続先が、確認したときと変わりました。ページを開き直してください。` };
    invalidate('status');
  } else if (localPlay) {
    const mine = (FS.walletList ?? []).find(w => w.name === EPHEMERAL_WALLET_NAME && !w.why);
    const c = mine ? await wallet.connect(mine, { chain: wallet.chainOf('localnet') }).catch(() => null) : null;
    if (c && c.address === localPlay.address) adoptConnectedWallet(c);
    // (the march's capability: ONE read, bound to this herald's relay, this wallet and the launcher's stated instance)
    if (c && c.address === localPlay.address && localPlay.march?.instance) {
      const asked = localPlay.address;
      localMarch.readLocalMarchCapability({ origin: cfg.herald, wallet: asked, expectedInstance: localPlay.march.instance, request: (...a) => globalThis.fetch(...a) })
        .then(cap => { if (FS.wallet?.address === asked) { localMarchCapability = cap; invalidate('panel'); } }).catch(() => {});
    }
  }
  // A silent reconnect of the wallet used last time (no popup; nothing if it does not trust this page).
  const last = localPlay ? null : wallet.lastWalletName();
  const entry = last && (FS.walletList ?? []).find(w => w.name === last && !w.why);
  if (entry) {
    const c = await wallet.connect(entry, { chain: wallet.chainOf(pin?.cluster ?? 'localnet'), silent: true }).catch(() => null);
    if (c) {
      adoptConnectedWallet(c);
      const restored = await fsession.restore(scope(), c.address);
      if (FS.wallet?.address === c.address && wallet.connected()?.address === c.address) FS.session = restored;
    }
  }
  // The rules module once (the incoming warnings need it too); a missing
  // frontier.wasm is tolerated (the page says what needs it).
  await kernelOrNull();
  if ((wallet.connected()?.address ?? null) !== (FS.wallet?.address ?? null)) await syncConnectedWallet();
  await refresh();
  // Local play: the player this boot read must still be the gate's wallet's own Citizen; otherwise the page lets go
  // of the wallet and says so (sends stay refused either way).
  if (localPlay && FS.wallet && !localPlayIdentityOk(localPlay, io.pinned(), FS.season, FS.citizen)) {
    await wallet.disconnect().catch(() => {});
    adoptConnectedWallet(null);
    FS.error = { code: 'LocalPlayIdentityChanged', text: L`ローカルプレイの接続先が、確認したときと変わりました。ページを開き直してください。` };
    invalidate('status', 'panel');
  }
  walletEventsReady = true;
  if ((wallet.connected()?.address ?? null) !== (FS.wallet?.address ?? null)) await syncConnectedWallet();
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
