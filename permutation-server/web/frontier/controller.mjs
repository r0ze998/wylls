// The play controller (W3-F): what the game page does between the herald
// (reads), the relay (writes) and the screens. It keeps the viewer's state
// in FS (fstate.mjs), refreshes it on the herald poll schedule (§4.2: 10 s
// while a march or a transaction is in flight, else 30 s; paused while the
// page is hidden, except the marchbook's self-reveal timer), runs the
// self-reveal (I-24, §9.1), and turns every `data-act` of the screens into
// one action: build → check → sign → relay → track (fplay.mjs), the march
// through fmarch.sendMarch. Nothing here decides a rule; the program does.
import { conquestEnabled, kernelFile, territoryStandings, keepFromProvince, applyControl, outpostOffer, mergeKeepEvents } from './fconquest.mjs';
import { mergeDonorReturns } from './fconquest.mjs';
import { holdingByRef } from './fland.mjs';
import { withRoads, holdingTechs } from './flocalplay-research.mjs';
import { createPollLoop } from './poll-loop.mjs';
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
import { AGENTS_REFRESH_MS, delegatedTo, delegationOf, loadAgents, refusalNote, registeredKey, takenBackNote } from './fdelegation.mjs';
import * as book from './marchbook.mjs';
import { submit, track, accountsFor, campMaskOf, campWinner } from './fplay.mjs';
import { sendMarch, sendMarchRetrying, planRoute, earliestBell, arrivalWindow, tipOptions, incomingWarnings, departMargin, RETREAT_CHOICES, checkMarch } from './fmarch.mjs';
import { landState, hostsIn, TICKET_SEEN_BELLS, FIRST_TICKET_RING, BUILD_ITEMS, buildItemOf, UNIT_ORDER } from './fland.mjs';
import { BUILDINGS, TIERS, unitCount, failureText, departRefusedReason } from './fi18n.mjs';
import { villageInUse } from './hud/rulebook.mjs';
import { settled, copyNumber, buildSecs, doneAfterQueue, grownSince, ITEM_TIER_UP, ITEM_WALLS, TIER_UP, WALLS, HOST_TROOPS } from './hud/rulebook.mjs';
import { exploreResultTurn, exploreResultWords } from './hud/orderparts.mjs';
import { planTicket } from './fjoin.mjs';
import { toggleTile } from './screens/explore.mjs';
import { composerArrival, composerMarch, destOpenOf } from './screens/march.mjs';
import { intentOf as pendingIntentOf, pendable, armPending, createPendingDriver, SETTLE_CODES, provinceLag, PENDING_LAG_TURNS, settleNow } from './flocalplay-pending.mjs';
import { musterIntentOf, nearTurnEnd, musterPress, sameWorld as sameMusterIdentity, sameHolding, stillSame as musterStill } from './flocalplay-muster-wait.mjs';
import { handModel as handModelOf, musterDraft } from './hud/hand.mjs';
import { sealMarch, unpack, ctHash as ctHashOf, sealRoot as sealRootOf } from './seal.mjs';
import { bellAt, bellStart, BELL_SECS, pipeline, archivePartOf, pollCap, roundTime, tlockRound } from './clock.mjs';
import { regionOf, ringOf, ringProvinces, homeNation, hexDistance } from './fgeo.mjs';
import { researchRefusalText, techName } from './hud/research.mjs';
import { TECHS } from './flocalplay-research.mjs';
import { territoryOfRoute, nearerOwnVillage } from './flocalplay-territory.mjs';
import { freeWideSites } from './flocalplay-wide.mjs';
import { hostParts, hostId } from './faddr.mjs';
import { decodePage } from './flog.mjs';
import { nextPoll, BELLS_PER_DAY } from './herald.mjs';
import { applySeasonRecord, contiguousRings, worldOf, ringSeeded } from './map/world.mjs';
import { readOverviews, overviewRefused } from './map/overviews.mjs';
import { kernel as loadKernel, UNITS } from './wasm.mjs';
import { kernelRulesetFor } from './flocalplay-lane.mjs';
// (TEST-ONLY, a coexist local world only: ② rights — flocalplay-rights.mjs, screens/rights.mjs)
import { localLane, COEXIST_LANE } from './flocalplay-lane.mjs';
import { decodeGrant, grantAddress, issuerTagOf, partyGrants, HERALD_GRANTS_SCHEMA, KIND_STOCK_SWAP } from './flocalplay-rights.mjs';
// (TEST-ONLY, a coexist local world only: a preview of ⑨ capacity and ⑩ custody — flocalplay-custody.mjs, screens/custody.mjs)
import * as cust from './flocalplay-custody.mjs';
import { fromBase64 as rightsB64 } from '../sdk/bytes.mjs';
import { uiKey, uiStorage, loadUi, saveUi, landKey, loadLand, saveLand, LAND_DEFAULTS } from './fui.mjs';
import * as wallet from '../wallet.mjs';
import { LOCAL_PLAY_WALLET_NAMES, currentEphemeralWallet } from './fephemeral-wallet.mjs';
import * as localDepart from './flocalplay-depart.mjs';
import * as devnetDepart from './fdevnet-depart.mjs';
import * as localReveal from './flocalplay-reveal.mjs';
import * as localExpedition from './flocalplay-expedition.mjs';
import * as localReturn from './flocalplay-return.mjs';
import * as localConquest from './flocalplay-conquest.mjs';
import * as localAct from './flocalplay-act.mjs';
import * as devnetPlayMod from './fdevnetplay.mjs';
import { waitForOwnRecord } from './fown-wait.mjs';
import { outpostCost } from './fdevnet-outpost.mjs';
import * as wideVillage from './fdevnet-wide-village.mjs';
import * as devnetTerritory from './fdevnet-territory.mjs';
import * as frent from './frent.mjs';
import { outpostCandidates, OUTPOST_PREVIEW_MS } from './screens/outpostcard.mjs';
import { nextOutpostSlot } from './fconquest.mjs';
import { openDevnetBook } from './fdevnetbook.mjs';
import * as localMarch from './flocalplay-march.mjs';
import { localPlayIdentityOk } from './flocalplay.mjs';
import { decode as fromBase58, encode as toBase58 } from '../sdk/base58.mjs';
import { fromBase64 } from '../sdk/bytes.mjs';
import { L, fmtNum } from '../lang.mjs';
import { emit as fxEmit } from './fx/bus.mjs';
import { reachOrigins } from './screens/conquest.mjs';
import { expeditionHoldText } from './screens/tracker.mjs';
import { custodyLosses, reserveShort, reserveShortText } from './screens/custody.mjs';
import { heldMarchAnswer } from './screens/villageorders.mjs';
import { s1On } from './fs1.mjs';
import { avoidingPalisades, watchOf, structuresIn, walkerOf, palisadeHexesOf } from './s1walk.mjs';
import { fastestPath, pack, landsWanted, landOfProvince, CARAVAN_FEE, MAX_PATH_STEPS, MAX_PATH_PROVINCES } from './fcaravan.mjs';
import { garrisonProblem, garrisonProblemText } from './screens/holding.mjs';
import { raidOffers, domesticRaidOffers, s1VillageModel, s1PlanOffers, s1TileModel, fortGarrisonProblem, fortProblemText, expelBlockText, siegeOffer, expelOffer, caravanProblem, KIND, PROPOSE_STANCE, PROPOSE_EXPEL, PROPOSE_READMIT } from './screens/s1.mjs';
import { placeData, raidProvinces, cargoBytes, RAID_CHOICE } from './fplay.mjs';
import { cachedReach, reachKey, reachableKeeps, MAX_ROUTE_PROVINCES } from './fkeepreach.mjs';
// the local test world's fog of war (map/fog.mjs): the keep lists and the incoming warnings show only what was seen
import { fogNow, viewKeeps, viewTile } from './map/fog.mjs';
import * as fprize from './fprize.mjs';
import { instantHomeEnabled, heartlandFull, noFreeHome, HOME_GRANTED, planHomes, homeSites, homeRingsOpen, seasonPlace, homePlaceOf, homeRingsOf, sameHome, homeKey, loadHome, saveHome, grantId } from './home.mjs';
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
/**
 * Save UI preferences once a season is pinned (convenience only). The saved preferences are laid OVER `FS.ui`: it also
 * holds this page's runtime memory (the wide host planner's `wideHost`, `wideHostSay`/`Ready`, `custodyPair`, …), which
 * is not stored. loop-play10: a tab press replaced `FS.ui` with the stored preferences alone, and the W2 card forgot
 * the march it had sent (it said 「軍勢は進軍に出ています。」 while its host held a keep, then offered a new host).
 */
const saveUiPatch = patch => { const sc = scope(); if (sc) FS.ui = { ...(FS.ui ?? {}), ...saveUi(uiStorage, uiKey(sc), patch) }; };
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
// (2026-11-17, ⑦ the first village: WHERE the home record of the viewer and world of this moment is kept — the same key
//  and the same place as readHome / saveHomePatch use, taken once. A Join or PlaceHome that was sent writes its note
//  THERE, whatever the page has become by the time the send answers: the note is the only record that a transaction
//  left this browser, and it belongs to the wallet and world it was sent for — never to the ones on the page later.)
const homeNoteNow = () => { const key = homeKeyNow(); return key ? { key, storage: homeStorage() } : null; };
const saveHomeAt = (at, patch) => (at ? saveHome(at.storage, at.key, patch) : null);
// (the chain's own "failed / expired" lets a note go only when the note is of a signature THIS send wrote: a note a
//  later send wrote in the same record is that send's)
const dropHomeNote = (at, sigs) => { if (!at) return; const n = loadHome(at.storage, at.key).pending; if (n && sigs.has(n.signature)) saveHome(at.storage, at.key, { pending: null }); };
// (confirmHome → ACTIONS.join: the question "is the confirm that asked for this Join still its own?", handed over for
//  the one call and taken at its first line)
let homeJoinStill = null;
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
  // (Q16-3: or to another key — ③'s courier, another app or device; no agent page to link then)
  const held = delegationOf(FS), note = refusalNote(held, r?.code);
  if (note && !r?.text) return setNotice({ ok: false, ...r, agentLink: !held.foreign, text: () => `${failureText(r)} ${note}` });
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
  // (Q16-3: a device with no stored key cannot have a mismatch yet, but the registered key may be an agent's or a
  //  program's all the same: it is read then too, so "re-make the key" is not offered over a delegation)
  //  (on a relay known to have no agent wallet nothing more is read for it: a program's key is told from the record)
  const keyless = FS.sessionProblem !== 'SessionMismatch' && !FS.session && !FS.resident && !!registeredKey(FS.citizen) && FS.agentWallet !== false;
  const mismatch = FS.sessionProblem === 'SessionMismatch' || keyless;
  if (!mismatch) { if (FS.delegation) { FS.delegation = null; invalidate('panel'); } if (FS.agentWallet !== undefined) return; }
  const t = Date.now();
  if (FS.agentWallet !== undefined && t - agentsReadAt < AGENTS_REFRESH_MS) return;
  agentsReadAt = t;
  const { enabled, agents } = await loadAgents(address);
  if (FS.wallet?.address !== address) return;
  const was = FS.delegation?.mode ?? null;
  FS.agentWallet = enabled;
  FS.delegation = delegatedTo({ sessionProblem: FS.sessionProblem, citizen: FS.citizen, agents, hasLocalKey: !!FS.session, now: now() });
  // (the owner's choice to keep a delegation is about that key only: another key registered since is asked about again)
  if (FS.keyKept && FS.keyKept !== registeredKey(FS.citizen)) FS.keyKept = null;
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
// (fix-devnet-join-wait, herald-load-50 F5: a gateway that answered "no prize pool" — every devnet play gateway, whose
//  season has none — was asked again every 15 s by every page. It is asked again only every PRIZE_ABSENT_MS for the
//  same relay and world; another relay, world or wallet, or a forced read (the paid Join), asks at once as before.)
export const PRIZE_ABSENT_MS = 600_000;
let prizeAbsent = null;
export async function refreshPrize({ force = false, at = Date.now() } = {}) {
  const absent = prizeAbsent !== null && prizeAbsent.relay === io.relay() && prizeAbsent.world === providerWorld() && prizeAbsent.wallet === (FS.wallet?.address ?? null);
  if (!io.relay() || (!force && at - prizeReadAt < (absent ? PRIZE_ABSENT_MS : PRIZE_REFRESH_MS))) return;
  prizeReadAt = at;
  // (2026-11-17, ⑦: an answer belongs to the wallet, the relay and the pinned world — with its generation, so A → B → A
  //  are three — it was asked under; one that any of them changed under is not written. A read dropped that way does not
  //  hold back the next one: the throttle is released for the new wallet, relay or world. Reads only; what is paid,
  //  claimed or joined is not touched here.)
  const address = FS.wallet?.address ?? null, relay = io.relay(), world = providerWorld();
  const current = () => (FS.wallet?.address ?? null) === address && io.relay() === relay && providerWorld() === world;
  const r = await prizeIo.loadPrize(address);
  if (!current()) { if (prizeReadAt === at) prizeReadAt = 0; return; }
  if (!r.ok) return;
  prizeAbsent = r.pool === null ? { relay, world, wallet: address } : null;
  FS.prize = r.pool;
  if (r.pool && r.pool.state !== 'open') {
    const g = await prizeIo.loadLedger();
    if (!current()) { if (prizeReadAt === at) prizeReadAt = 0; return; }
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
/**
 * (2026-11-17) The viewer and world an order is made under: the viewer key (the NFT's asset or the wallet) and the
 * pinned world (`providerWorld`: pin generation, cluster, program, Season), as refresh's currentViewer compares them.
 * An answer that comes back after either changed is not this page's: it is not recorded, said or acted on here.
 */
const orderScope = () => `${viewerKey() ?? ''}|${providerWorld() ?? ''}`;
function orderOf(kind, name, extra = {}) {
  const h = activeHolding(FS);
  const tile = extra.tile && Number.isInteger(extra.tile.tile) ? { p: extra.tile.p, q: extra.tile.q, tile: extra.tile.tile } : h && Number.isInteger(h.tile) ? { p: h.p, q: h.q, tile: h.tile } : null;
  return { ...extra, id: `o${++orderSeq}`, kind, name, turn: nowBell(), faction: FS.citizen?.faction ?? null, tile, at: now(), scope: orderScope() };
}
/** Whether order `o` was made under the viewer and world the page shows now (an order without a scope: as before). */
const orderHere = o => o.scope === undefined || o.scope === orderScope();
function orderAnswered(o, ok, extra = {}) {
  if (!o || !orderHere(o)) return;
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
  // (devnet play, fdevnetplay.mjs: the same page-signed transport for the devnet lane's commands — the connected wallet
  //  signs and pays; every other order keeps the ordinary path, as before)
  const pl = playLane();
  const route = localAct.localOrderRoute({ localPlay: pl?.identity ?? null, name, v, signer, requester, names: pl?.lane.names, otherwise: pl?.otherwise });
  if (route === 'refuse') return early(localPlayReadOnly());
  // LOCAL PLAY: one order at a time per SCOPE (this wallet, world and relay) and per STABLE key (the command, its
  // village, its fields — for Join only the nation: its expiry is re-made from the clock at every press). The ordinary
  // `sendKey` is not used here: it would tell a Join pressed one second later apart from the one still being signed.
  if (route === 'local-act') {
    const g = pl.gate();
    if (!g?.ok) return early({ code: g?.code ?? 'LocalActNotAllowed' });
    const local = { scope: localAct.localActScope({ identity: pl.identity, relay: g.relay }), key: localAct.localActKey(name, v, fields), origin: g.relay,
      identity: pl.identity, lane: pl.lane, deps: pl.deps };
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
const localActScopeNow = () => { const pl = playLane(), g = pl?.gate(); return localAct.localActScope({ identity: pl?.identity ?? null, relay: g?.ok ? g.relay : null }); };
export const localPlayUnconfirmedOrders = () => localActLedger.list(localActScopeNow()).map(e => ({ name: e.name, signature: e.signature }));
/** An order that was SENT and whose outcome is not known: recorded as that — with its signature — never as refused. */
function orderUnconfirmed(o, signature, code = 'LocalActUnconfirmed') {
  if (!o || !orderHere(o)) return;
  const rec = { ...o, state: 'unconfirmed', sent: true, signature, code: 'LocalActUnconfirmed' };
  if (code !== 'LocalActUnconfirmed') rec.code = code;   // (2026-11-17) the ordinary path's own code (Unconfirmed, TxUnqueryable)
  FS.orders = [rec, ...(FS.orders ?? []).filter(x => x.id !== o.id)].slice(0, ORDERS_MAX);
  const { say: _say, ...payload } = rec;
  fxEmit('order:unconfirmed', payload);
}
const localActUnconfirmedText = signature => () => L`この命令は送信済みですが、まだ確認できていません。同じ命令は送り直しません。もう一度押すと結果を確認します。署名 ${signature}`;
const localMarchUnconfirmedText = signature => () => L`進軍は送信済みですが、まだ確認できていません。同じ進軍は送り直しません。しばらく自動で確かめます（「もう一度」でも確認できます）。署名 ${signature}`;
/** (2026-11-19) The reason a march the runner rejected was not taken: the program's own words for its code (NotResident: the turn changed under the send), else the relay's. */
// (loop-play15 LP15-1: the program answers a refused tile claim with shared error numbers — Cooldown 29 for "one tile a
//  turn", NotEligible 43 for "land upkeep unpaid", Insufficient 21 for the ore — whose common texts speak of a host's
//  stamina and of refunds. The claim's own sentences instead; proc/wide_territory.rs territory_err)
const territoryRefusalText = pc => (pc === 29 ? L`このターンはもう1マス取りました。マスは1ターンに1つです。次のターンにもう一度押してください。`
  : pc === 43 ? L`土地の維持費（本拠地の食料）が払えていないので、新しいマスは取れません。本拠地に食料が戻ると、また取れます。払えないまま24ターンたつと、遠いマスから1ターンに1つずつ手放されます。`
  : pc === 21 ? L`鉱石が足りません。1マスは鉱石 10 で、持っているマス1つごとに 2% 高くなります（本拠地の蔵から払います）。`
  : null);
const researchRefused = (ans, { apply = false } = {}) => {
  const pc = ans && ans.ok === false ? Number(ans.programCode) : NaN;
  // (verify-pr232: AlreadyDone (52) to an apply means the village already has its nation's techs — the runner or keeper
  //  delivers them every turn —, not "your nation already knows this tech")
  const text = apply && pc === 52 ? () => L`国が覚えた技術の効果は、もうこの村に届いています（毎ターンの見回りが先に届けました）。` : researchRefusalText(pc) ? () => researchRefusalText(pc) : null;
  // (a refused pledge is not sent again by 「もう一度」: it needs its two presses again, with the amount shown first)
  if (text) failed({ ...ans, text, ...(apply ? {} : { retry: false }) });
  else if (!apply && ans && ans.ok === false) failed({ ...ans, retry: false });
};
const territoryRefused = ans => {
  const pc = ans && ans.ok === false ? Number(ans.programCode) : NaN;
  if (territoryRefusalText(pc)) failed({ ...ans, text: () => territoryRefusalText(pc) });
};
const localMarchRejectedText = r => (r.programCode === 26 ? L`送るあいだにターンが変わり、出発する州の前のターンの決着がまだでした。`
  : r.programCode === 31 ? L`送るあいだにターンが変わり、この到着ターンには着けなくなりました。`
  : failureText(r.programCode !== undefined ? r : { code: 'LocalMarchRejected' }));
/**
 * (2026-11-19) A held march (sent, outcome unknown) is asked about again on its own, a bounded number of times: every
 * HELD_RECHECK_MS, at most HELD_RECHECK_TRIES times (about 2 minutes, longer than a blockhash lives). Each ask is ONE
 * read through the relay it was sent through; nothing is sent again. Landed, failed on chain or expired (the relay read
 * its blockhash as past its life and the signature as unknown) — the host is free again and the player is told.
 */
export const HELD_RECHECK_MS = 5000, HELD_RECHECK_TRIES = 24;
/** A signed march's answer that is final (not held as "unconfirmed"): refused on chain, or read `expired` — never landed, never will (fmarch.mjs sendMarch: the book already let it go). */
export const LOCAL_MARCH_ANSWERED = Object.freeze(['TransactionFailed', 'LocalMarchExpired']);
const heldRechecks = new Set();
const HELD_TOLD = {
  landed: () => L`送信済みだった進軍は記録されました。軍勢は進軍中です。`,
  failed: () => L`送信済みだった進軍はチェーンで断られました。軍勢は村にいます。もう一度命令できます。`,
  expired: () => L`送信済みだった進軍は期限までに記録されませんでした（これから記録されることはありません）。軍勢は村にいます。もう一度命令できます。`,
};
function heldTold(x, signature = null) {
  if (!HELD_TOLD[x]) return false;
  // (D-verify-pr193-2: the held march's order record takes the answer too — refused when it failed or expired, as the
  //  first answer's is since #193; left 'unconfirmed', the guide still counted it as "marched")
  const a = heldMarchAnswer(FS.orders, signature, x);
  if (a) orderAnswered(a.record, a.ok, a.extra);
  if (x === 'landed') done(HELD_TOLD.landed); else setNotice({ ok: false, busy: false, text: HELD_TOLD[x], unsent: 'march-held', retry: false });
  refresh().catch(e => console.error('frontier refresh:', e));
  return true;
}
function recheckHeldMarch(signature, { tries = HELD_RECHECK_TRIES, every = HELD_RECHECK_MS } = {}) {
  if (!localMarchSender || heldRechecks.has(signature)) return;
  heldRechecks.add(signature);
  const sender = localMarchSender;
  let n = 0;
  const tick = async () => {
    if (sender !== localMarchSender) { heldRechecks.delete(signature); return; }
    let x = 'unconfirmed';
    try { x = await sender.ask(signature); } catch { x = 'unconfirmed'; }
    if (x !== 'unconfirmed') { heldRechecks.delete(signature); invalidate('panel'); heldTold(x, signature); return; }
    if (++n >= tries) { heldRechecks.delete(signature); return; }
    setTimeout(tick, every);
  };
  setTimeout(tick, every);
}
/** The press on a host held by an earlier march: ONE read of each of its held signatures; told when one is settled. */
async function askHeldMarches(hostId, { told = false } = {}) {
  if (!localMarchSender) return;
  busy(() => L`送信済みの進軍の結果を確認しています…`);
  let last = 'unconfirmed', answered = null;
  for (const sig of localMarchSender.held(hostId)) { try { last = await localMarchSender.ask(sig); } catch { last = 'unconfirmed'; } if (last !== 'unconfirmed') { answered = sig; break; } }
  invalidate('panel');
  if (heldTold(last, answered)) return;
  const sig = localMarchSender.held(hostId)[0];
  if (told && sig) setNotice({ busy: false, text: localMarchUnconfirmedText(sig), code: 'LocalActUnconfirmed', unsent: 'march-send' });
}
/** A press on an order that is held as sent-and-unconfirmed: ONE question about its signature; nothing is built or sent. */
async function localActAsk(name, lo, { order, say, after }) {
  busy(() => L`送信済みの命令の結果を確認しています…`);
  // (asked at the relay of the scope the order is held under, and used only if the page is still that scope when the
  //  answer comes: otherwise nothing is shown, nothing is released — the order stays held under its own scope)
  const s = await localAct.settleLocalAct(localActLedger, lo.scope, lo.key, localAct.localActRead({ allowed: () => ({ ok: true, relay: lo.origin }), lane: lo.lane }), { still: () => localActScopeNow() === lo.scope });
  if (s.state === 'left' || s.state === 'none') return { ok: false, code: 'LocalActScopeChanged', sent: s.state === 'left' };
  if (s.state === 'landed') {
    done(say ?? order?.say ?? DONE_TEXT[name] ?? (() => L`完了しました`)); orderAnswered(order, true, { signature: s.signature });
    refresh().catch(e => console.error('frontier refresh:', e)); await after?.({ ok: true, signature: s.signature });
    return { ok: true, signature: s.signature, reconciled: true };
  }
  if (s.state === 'failed') { orderAnswered(order, false, { code: s.code, sent: true, signature: s.signature }); return failed({ ok: false, code: s.code, ...(Number.isInteger(s.programCode) ? { programCode: s.programCode } : {}) }); }
  orderUnconfirmed(order, s.signature); setNotice({ busy: false, text: localActUnconfirmedText(s.signature), code: 'LocalActUnconfirmed' });
  return { ok: false, code: 'LocalActUnconfirmed', signature: s.signature, sent: true };
}

/** What the local-play transport asks of the page: its gate, the identity the gate verified, the Season's ruleset hash as read, the live memory-only wallet. */
const seasonRulesetHex = () => { const r = FS.season?.rulesetHash; return r instanceof Uint8Array ? [...r].map(b => b.toString(16).padStart(2, '0')).join('') : r; };
const localActDeps = () => ({ allowed: localDepartGate, identity: () => localPlay, rulesetHash: seasonRulesetHex, signer: currentEphemeralWallet });

// ------------------------------------------------------------------ devnet play (devnet gap P1, fdevnetplay.mjs)
/** The devnet play this page verified (readDevnetPlay at start), or null: then nothing below is ever used. */
let devnetPlay = null;
let devnetSeen = { address: null, identity: null, signer: null };
/** The connected wallet's devnet identity and signer handle, one object each per wallet (submitLocalAct compares them by identity). */
function devnetOwn() {
  const a = FS.wallet?.address ?? null;
  if (!devnetPlay || !a) return null;
  if (devnetSeen.address !== a) devnetSeen = { address: a, identity: devnetPlayMod.devnetIdentityOf(devnetPlay, a), signer: Object.freeze({ address: a, destroyed: false }) };
  return devnetSeen;
}
/** Whether the devnet transport may send now: devnet play on, this page's wallet connected and the one the page shows, not an NFT Citizen. */
function devnetGate() {
  if (!devnetPlay) return { ok: false, code: 'DevnetPlayOff' };
  const c = wallet.connected();
  if (!c || !FS.wallet || c.address !== FS.wallet.address) return { ok: false, code: 'NoWallet' };
  if (FS.resident) return { ok: false, code: 'DevnetPlayResident' };
  return { ok: true, relay: devnetPlay.relay };
}
export const devnetPlayOn = () => devnetPlay !== null;
/** A wide devnet season the page plays itself (rim first villages, the wide claim). */
const devnetWideNow = () => devnetPlayMod.devnetWide({ devnetPlay, record: FS.record, world: FS.world ?? (FS.record ? worldOf(FS.record) : null) });
/** Whether first villages past the heartland go by the one-site village request (local wide worlds; wide devnet seasons). */
const wideHomes = () => !!localPlay?.wideLand || devnetWideNow();
// (devnet-territory-dev: a wide devnet world whose gateway carries the tile claim — a territory world, the program of
//  #206/#209: tiles, the village on its own tile, and the reach witness of the nation's land)
const devnetTerritoryNow = () => devnetWideNow() && devnetPlayMod.devnetTerritoryOn(devnetPlay);
/**
 * THE TRANSPORT of the page-signed commands: local play's, or — on a verified devnet season with a connected wallet —
 * the devnet lane's; null for every other page (all orders take the ordinary path). `otherwise`: what an order the
 * lane does not carry does — refused in local play (reads only), the ordinary path on devnet.
 */
function playLane() {
  // (TEST-ONLY: a coexist world's page — its lane selected once its gate verified a coexist Season — carries ② rights and
  //  the S1 Vault and caravan as well; every other local world keeps LOCAL_LANE exactly)
  if (localPlay && rightsLaneOn()) return { lane: localAct.COEXIST_LOCAL_LANE, identity: localPlay, gate: localDepartGate, deps: { ...localActDeps(), lane: localAct.COEXIST_LOCAL_LANE }, otherwise: 'refuse' };
  if (localPlay) return { lane: localAct.LOCAL_LANE, identity: localPlay, gate: localDepartGate, deps: localActDeps(), otherwise: 'refuse' };
  const own = devnetOwn();
  if (!own) return null;
  const sign = async wire => wallet.signTransaction(wire);
  return { lane: devnetPlay.lane, identity: own.identity, gate: devnetGate, otherwise: 'general',
    deps: { allowed: devnetGate, identity: () => devnetOwn()?.identity ?? null, rulesetHash: seasonRulesetHex, signer: () => devnetOwn()?.signer ?? null, lane: devnetPlay.lane, sign } };
}

// DEVNET PLAY — the ordinary sealed march (devnet-page-war): the march book kept ENCRYPTED in this browser for the
// connected wallet (fdevnetbook.mjs: a non-extractable AES-GCM key in IndexedDB; a reload keeps the reveal halves), and
// the march sender of local play over the devnet lane (flocalplay-march.mjs devnetMarchLane): the connected wallet
// signs the Depart, the gateway forwards it once; keeper A settles, reveals, resolves and settles the transit.
let devnetBook = null, devnetBookOpening = null, devnetMarchSender = null, devnetMarchKey = null;
/** The devnet march book of the connected wallet (opened once per wallet), or null when it cannot be kept here. */
async function devnetBookNow() {
  const a = FS.wallet?.address ?? null;
  if (!devnetPlay || !a) return null;
  if (devnetBook?.wallet === a) return devnetBook;
  if (devnetBookOpening?.wallet !== a) {
    const p = openDevnetBook(devnetPlay, a).then(b => { if (devnetBookOpening?.p === p) devnetBook = b; return b; }, () => null);
    devnetBookOpening = { wallet: a, p };
  }
  const b = await devnetBookOpening.p;
  return b?.wallet === (FS.wallet?.address ?? null) ? b : null;
}
/** Where the march book lives: the devnet encrypted book on a devnet season (once open), the browser's otherwise. */
const marchStore = () => (devnetPlay && devnetBook && devnetBook.wallet === (FS.wallet?.address ?? null) ? devnetBook.storage : book.browserStorage);
/** The devnet march sender for the connected wallet and its book key, or null (not a devnet page, or no book here). */
async function devnetMarchSenderNow() {
  if (!devnetOwn()) return null;
  const bk = await devnetBookNow(), key = bookKey();
  if (!bk || !key) return null;
  if (!devnetMarchSender || devnetMarchKey !== `${bk.wallet}|${key}`) {
    devnetMarchKey = `${bk.wallet}|${key}`;
    devnetMarchSender = Object.freeze({ book: bk, sender: localMarch.createLocalMarchSender({ allowed: devnetGate, open: () => devnetGate().ok === true,
      identity: () => devnetOwn()?.identity ?? null, rulesetHash: seasonRulesetHex, signer: () => devnetOwn()?.signer ?? null,
      lane: localMarch.devnetMarchLane(devnetPlay.seasonId), storage: bk.storage, bookKey: key,
      sign: localMarch.connectedWalletSigner(w => wallet.signTransaction(w)) }) });
  }
  return devnetMarchSender;
}

// LOCAL PLAY — the ordinary march (flocalplay-march.mjs): the relay's instance-verified capability (read once after
// connect), the memory-only sender, and `FS.localMarch` (a getter, set at init): the ONE answer the UI reads. It is
// closed unless every condition of `localMarchOpen` holds; the page never passes its own readiness.
let localMarchCapability = null, localMarchSender = null;
const localMarchSenderNow = () => (localMarchSender ??= localMarch.createLocalMarchSender({ ...localActDeps(), open: () => FS.localMarch?.open === true }));
function localMarchView() {
  if (!localPlay) return null;
  const h = FS.compose?.holding ? holdingByRef(FS.holdings, FS.compose.holding) : activeHolding(FS);
  return localMarchFor(h, FS.compose?.host?.id ?? null);
}
/**
 * (round 27) The same answer for one host of one village: what sendTheMarch would find once that host's order is composed
 * (localMarchView reads the composed order's village and host, or the active village). The bar asks it for the host it
 * shows, so a host of another village, or a stale order of another host, does not read as refused when its own march
 * would be sent. Nothing else reads it; the send still reads localMarchView.
 */
function localMarchFor(h, hostId) {
  if (!localPlay) return null;
  return localMarch.localMarchOpen({ capability: localMarchCapability, wallet: FS.wallet?.address ?? null, instance: localPlay.march?.instance ?? null, gate: localDepartGate(),
    holding: h ? { p: h.p, q: h.q, site: h.site } : null, held: localMarchSender ? localMarchSender.held(hostId ?? null) : [], trialEntry: localPlay.march?.trialEntry === true });
}

// `lo` (local play's six only; null otherwise): `{scope, key, origin}` taken by `act` BEFORE anything was awaited — the
// scope the order is sent, held and followed under, and the relay it is sent through.
async function actOnce(name, { v, fields, signer, requester, label, after, onSent, onLost, order, say }, early, lo = null) {
  // (2026-11-17) the viewer and world this order is made under, taken before anything is awaited
  const scope0 = orderScope();
  // a wide holding among the subjects, or a village order while the village screen shows a wide village: refused
  // before anything is built or sent (fwide.mjs: the one guard every path meets)
  { const wr = fwide.wideRefusal(name, typeof v === 'object' ? v : null, FS); if (wr) return early(wr); }
  if (!io.pinned()) return early({ code: 'NoPin' });
  if (!FS.wallet) return early({ code: 'NoWallet' });
  // (only one of the six reaches here in local play: `act` refused the rest. No session key, no sponsor, no NFT path.)
  const local = lo !== null && localAct.localOrderRoute({ localPlay: lo.identity, name, v, signer, requester, names: lo.lane.names }) === 'local-act';
  // the ordinary path's answer is shown only if the page is still that viewer and world (local play follows its own scope)
  const moved = () => !local && orderScope() !== scope0;
  if (localPlay && !local) return early(localPlayReadOnly());
  if (local && FS.resident) return early(localPlayReadOnly());
  let sign = null;
  // ⑳: an NFT Citizen has no Frontier session; its owner's wallet signs, for
  // the generation read fresh now (a transfer since the page loaded changes it).
  let resident = null;
  if (FS.resident && signer !== null && name !== 'JoinResident') {
    if (name === 'SetSession') return early({ code: 'NftNoSession' });
    // (2026-11-17) a rejection is thrown as before unless the page moved meanwhile (then it is the old order's, below)
    const g = await fresident.currentGeneration(FS.wallet.address, FS.resident.asset).catch(e => { if (moved()) return undefined; throw e; });
    // (2026-11-17) another viewer or world now: neither its notice nor the write below
    if (moved()) return { ok: false, code: 'ScopeChanged', scopeChanged: true, sent: false };
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
  let unconfirmed = false;
  busy(label ?? (() => L`送信中…`));
  // (2026-11-17) this order's own busy notice: only it is ever cleared for a page that moved, never another order's
  let myBusy = FS.notice;
  const quiet = () => { if (FS.notice === myBusy) setNotice(null); };
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
      if (local) return localAct.submitLocalAct({ name, v, fields }, lo.deps).then(x => { if (x.ok || x.code !== 'LocalActNotServed') return x; const ro = localPlayReadOnly(); return { ok: false, code: ro.code, error: ro.text, text: ro.text }; });
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
      const f = await localAct.followLocalAct(signature, { origin: lo.origin, still: stillScope, lane: lo.lane });
      return f.state === 'landed' ? { ok: true, state: 'landed', slot: f.slot } : f.state === 'failed' ? { ok: false, state: 'failed', code: f.code, ...(Number.isInteger(f.programCode) ? { programCode: f.programCode } : {}) }
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
      orderUnconfirmed(order, r.signature); setNotice({ busy: false, text: localActUnconfirmedText(r.signature), code: 'LocalActUnconfirmed' });
      return { ok: false, code, signature: r.signature, sent: true };
    }
    // W6-D: a resident action refused because the province fell a bell behind between the check and the landing:
    // ask the keeper to catch it up, wait for the herald to show it, and send once more.
    // (never in local play: there a second transaction is only ever the player's own new press)
    if (!local && !t.ok && retryAfterCatchUp(name, t.code)) {
      // (2026-11-17) the retry is unchanged; only its busy notice is not put on a page that moved, and it is this order's
      if (!moved()) { busy(() => L`州が追いつくのを待っています…`); myBusy = FS.notice; }
      if (await catchUp(typeof v === 'object' ? (v.province ?? v.holding) : null)) {
        r = await send();
        if (r.ok) onSent?.(r);
        t = r.ok ? await tx.track(r.signature) : r;
      }
    }
    // (2026-11-17) a refusal answered after the page moved is not said on the new page
    if (!r.ok && moved()) { code = r.code ?? null; quiet(); return { ...r, scopeChanged: true }; }
    if (!r.ok) { code = r.code ?? null; return failed(r); }
    // sent, and the chain says it failed or it expired: definitely not landed (an unknown outcome is neither)
    if (!t.ok && (t.state === 'failed' || t.state === 'expired')) onLost?.(t);
    // (2026-11-17) SENT, AND THE OUTCOME NOT KNOWN (no answer, or no status read): not a refusal. The order is recorded
    // as sent and not confirmed, with its signature (as local play records it), never as refused — the next read shows
    // what became of it. The notice says what the chain answered, as before.
    if (!t.ok && (t.state === 'unknown' || t.state === 'unqueryable')) {
      unconfirmed = true;
      orderUnconfirmed(order, r.signature, t.code ?? 'Unconfirmed');
    }
    // (2026-11-17) the page is no longer the viewer or world this was sent under: nothing of the answer is shown here
    // (the effects bus is told as before — landed or refused — so a busy effect is settled; it is the stage's to end a
    //  scene of another world)
    if (moved()) {
      code = t.code ?? null;
      if (t.ok) { fxDone = true; fxEmit('action:landed', fxa); }
      quiet();
      return { ...t, signature: r.signature, scopeChanged: true };
    }
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
    // (2026-11-17) an exception after the page moved is not thrown at the new page's handler (its notice)
    if (moved()) { console.error('frontier order of another viewer or world:', e); quiet(); return { ok: false, code, scopeChanged: true, sent }; }
    throw e;
  } finally {
    if (!fxDone) { fxEmit('action:refused', fxa); if (!unconfirmed) orderAnswered(order, false, { code, sent }); }
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
/**
 * A number that moves with every change of viewer, herald or pinned world (resetViewer, useHerald, adoptPinnedWorld):
 * what was drawn or judged before it moved belongs to another context. `FS.contextSeq` is the number NOW — the one a
 * mark is compared with (corrected 2026-11-17: a judging and a button each carried the number they were made under,
 * and were compared with each other; after a herald change in the same world and for the same viewer the old judging
 * still stood and its own buttons still matched it).
 */
let contextSeq = 0;
// (`FS.orderFloor`: the number of the last order made — orderOf's own `o<n>` — when the context moved: an order with a
//  higher number was made under the context NOW. Read by screens/villageorders.mjs; no order record is touched.)
const nextContext = () => { contextSeq += 1; FS.contextSeq = contextSeq; FS.orderFloor = orderSeq; };
function resetViewer({ wallet: walletChanged = true } = {}) {
  expedition.clearInspection(FS); outbound.clearOutbound(FS);
  // (workstream 07: the former viewer's answer is not this viewer's: hud/drawer.mjs viewerState keeps an answered
  // record's view across a failed refresh only for the viewer and world it answered for. A reply still in flight for
  // the former viewer is dropped by refresh's currentViewer check, before applyMeResult.)
  FS.meAnswered = false;
  FS.meWorld = undefined;
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
  FS.marchesRead = null;
  FS.villageReread = null;   // (the former viewer's own re-read and its note — rereadVillage)
  FS.s1Plan = null;          // (a place chosen on the map for the former viewer's caravan or fort — planS1Place)
  exploreSeedMarks.clear(); FS.exploreSeedCheck = null;   // (the former viewer's exploration and its check — checkExploreSeed)
  FS.bellItems = [];
  FS.formingBells = [];
  FS.orders = [];
  FS.departed = null;
  mySlots = [];
  if (walletChanged) FS.delegation = null;
  if (walletChanged) FS.agentWallet = undefined;
  FS.homeChoice = null;
  FS.homeDropped = null;
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
  FS.incomingRead = null;    // (nothing judged yet for this viewer: "none" is not said — screens/incoming.mjs)
  FS.hostPlaces = null;      // (where the former viewer's hosts stand is not this viewer's — screens/host.mjs)
  nextContext();             // (another viewer: what was drawn for the former one acts on nothing — FS.incomingRead.ctx)
  FS.isMine = () => false;
  if (walletChanged) FS.prize = null;
  if (walletChanged) FS.prizePayment = null;
  // the wide inventory and the wide village on the village screen were the previous viewer's (fwide.mjs)
  fwide.clearWide(FS);
  // (verify-pr173: and the page's runtime memory in FS.ui was the previous viewer's too — the W2 planner's march, count
  //  and wait timer, the ⑩ depositor picked, the wide sites tried. A tab press used to wipe it by accident (loop-play10
  //  LP10-1); now that tab presses keep it, a viewer change drops it here. The stored preferences stay)
  if (FS.ui) {
    if (FS.ui.wideHost) wideHostStopWait(FS.ui.wideHost);
    const { wideHost: _h, wideHostSay: _s, wideHostReady: _r, wideHostWhy: _w, wideHostAct: _a, custodyPair: _c, wideTried: _t, ownTiles: _o, researchArm: _ra, ...kept } = FS.ui;
    FS.ui = kept;
  }
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

/**
 * The pinned world a provider reads for (2026-11-17, ⑦): cluster, program and season account as fchainio.setPin pinned
 * them (`addresses.season`, derived and checked against the herald's record); null while none is pinned (nothing made up).
 * A read started under one world is never applied under another, and a province envelope carries the world it was read
 * for (`world`).
 */
function providerWorld() { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; }

/**
 * The order of the season record's answers (2026-11-17, ⑦). Two readers ask /h/season of the same herald without waiting
 * for each other — the season poll (app.mjs loadSeason, which pins) and refreshOverviews (the play poll, a ticket's or a
 * home's plan) — and the herald client neither shares nor orders their requests, so an answer asked earlier can land
 * after one asked later. Each read takes a number when it asks (`askSeason`); an answer is applied only when no answer
 * asked later has been applied (`seasonStale` is false), and it is recorded as applied (`takeSeason`) only after it was
 * applied in full, in the same stretch without a wait as that check. A failed answer, a refused pin, or a throw while
 * applying records nothing, so an answer asked earlier may still be applied after it; one asked before an applied
 * answer does not undo what that answer set. The numbers only grow, so a later read is never held back and a
 * successful change of world is applied as soon as it is the latest asked.
 */
let seasonAsked = 0, seasonTaken = 0;
export function askSeason() { seasonAsked += 1; return seasonAsked; }
export function takeSeason(seq) { if (!(seq > seasonTaken)) return false; seasonTaken = seq; return true; }
export function seasonStale(seq) { return !(seq > seasonTaken); }
/**
 * Whether a season record is of the pinned world: cluster, program, season and, when the record names it, the season
 * account (as fchainio.setPin derived them). refreshOverviews applies only such a record — pinning stays loadSeason's;
 * a record of another world waits for the season poll, which pins it. False with no pin or a record it cannot read.
 */
function recordOfPin(record) {
  const p = io.pinned();
  if (!p?.addresses || !record) return false;
  try {
    return String(record.cluster || 'localnet') === p.cluster && String(record.programId) === p.programId
      && String(BigInt(String(record.season))) === p.seasonId && (!record.seasonAddress || record.seasonAddress === p.addresses.season);
  } catch { return false; }
}

/** The conquest and S1 state is another world's when its mark is not this world (untagged: world null). */
function dropOtherWorldConquest(world) {
  if (FS.conquest && (FS.conquest.world ?? null) !== world) FS.conquest = undefined;
  if (FS.s1 && (FS.s1.world ?? null) !== world) FS.s1 = undefined;
}

/**
 * Called right after a pin (app.mjs loadSeason; 2026-11-17, ⑦). When the pinned world — with its generation — is not
 * the one the page's reads were for, what they hold is another world's and is forgotten, not shown as this one's: the
 * ring overviews and when each was taken (so every ring of the new world is read again), the partial ring lists, the
 * bell marked complete, and the conquest and S1 state. The overviews Map is emptied in place (the map holds it). The
 * first pin and a pin of the same world forget nothing. Returns whether anything was forgotten.
 */
let readsWorld;
export function adoptPinnedWorld() {
  const world = providerWorld();
  if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }
  readsWorld = world;
  FS.overviews?.clear?.();
  FS.overviewTaken?.clear?.();
  FS.worldRings?.clear?.();
  FS.worldRingTaken?.clear?.();
  FS.overviewsBell = undefined;
  overviewSource = null; overviewWorld = null;
  // (2026-11-17, ⑦ the wide map: the province records read for another world are not this world's land — emptied in
  //  place —, and neither are when each was asked (the wait before asking again) nor how its read went)
  FS.provinces?.clear?.();
  fetchedAt.clear();
  FS.provinceReads?.clear?.();
  // (the reads under way were asked of another world: their answers are dropped (loadEnvelope) and no province is
  //  "being read" for this world yet — but their requests go on until they settle, and until then they keep their
  //  places (readsUnderWay is NOT emptied here: the limit counts what is really under way). Nothing waits from before)
  artWanted.clear();
  waitingWant = null;
  // (2026-11-17, ⑦ the march's entry: a draft and a host in hand name a host, a village and a route of the world that
  //  was pinned: not this world's. A draft that is only a draft is put away — one being sent, waiting to be sent or
  //  armed is the send's own and is left to it — and the host in hand is let go. The selected place stays the person's.)
  // (2026-11-17, ⑦ the march tracker: the marches listed were read for the world that was pinned: not this world's —
  //  the list is emptied and marked not read until this world's own reading; the device's book is keyed by world and is
  //  not touched)
  FS.marches = [];
  FS.marchesRead = null;
  FS.villageReread = null;   // (a re-read asked in the world that was pinned, and its note, are not this world's — rereadVillage)
  FS.s1Reread = null;        // (the same for the trade card's re-read — rereadS1)
  FS.s1Plan = null;          // (a place chosen on the map names a place of the world that was pinned — planS1Place)
  exploreSeedMarks.clear(); FS.exploreSeedCheck = null;   // (a seed read for the world that was pinned is not this world's)
  FS.incoming = []; FS.incomingRead = null;   // (warnings judged for the world that was pinned are not this world's; none is judged here yet)
  // (the candidates for a first village are places of the world that was pinned: a reading still under way writes nothing,
  //  and the list is let go — unless a join / placing is under way: that is confirmHome's own and is left to it, only
  //  its "reading" mark is taken off, since the reading it stood for will write nothing now)
  ++homesRefresh; if (FS.homeChoice) { if (FS.homeChoice.busy) { FS.homeChoice.loading = false; FS.homeChoice.reading = null; } else FS.homeChoice = null; }
  FS.hostPlaces = null;   // (the provinces of the world that was pinned are not this world's)
  nextContext();   // (another world: what was drawn for the former one acts on nothing — FS.incomingRead.ctx)
  if (FS.compose && !FS.compose.sending && !FS.compose.pending && !pendingDriver.armed) FS.compose = null;
  if (FS.hand?.host !== undefined && FS.hand?.host !== null) FS.hand = null;
  dropOtherWorldConquest(world);
  return true;
}

/** A slower response must not roll a province back to an earlier generation. */
export function latestEnvelope(previous, next) {
  if (!previous) return next;
  // (envelopes of two worlds are not ordered: a new season's seq, slot and bell are lower than the last world's, and the
  // older world's envelope must not win. Only envelopes read for the same world are compared — 2026-11-17)
  if (next && previous.world !== next.world) return next;
  for (const field of ['seq','slot','bell']) {
    const a=previous[field], b=next?.[field];
    if (a===undefined || a===null || a==='' || b===undefined || b===null || b==='') continue;
    try { if(BigInt(b)<BigInt(a)) return previous; if(BigInt(b)>BigInt(a)) return next; } catch { /* another comparable field may remain */ }
  }
  return next;
}

async function loadEnvelope(p, q, bell = 'latest', still = null) {
  const world = providerWorld();
  const r = await herald.province(p, q, bell);
  // (`still`: a caller's check that the answer still belongs to what it asked for — run after the read and BEFORE anything
  //  is applied; a false answer is dropped whole. Without it, as before)
  if (still && !still()) return null;
  // (an answer read for another pinned world than the one now pinned is dropped whole, before anything is applied)
  if (providerWorld() !== world) return null;
  if (r.ok) {
    r.world = world;
    if (bell !== 'latest') return r;
    const key=`${p},${q}`, accepted=latestEnvelope(FS.provinces.get(key),r);
    FS.provinces.set(key,accepted);
    // (the prototype's land record rides on the latest envelope of a sample world that serves it; a province that no longer carries one loses it)
    if (FS.proto) protoLand(key, accepted.proto?.land ?? null);
    const k=keepFromProvince(accepted.province);
    if (k && FS.conquest) FS.conquest.keeps.set(key,k);
    FS.provinceReads?.delete?.(key);
    // (a good read of the village's province, whoever asked it, ends the village re-read's "the province did not come" note)
    if (FS.villageReread?.state === 'provinceFailed' && FS.villageReread.key === key) FS.villageReread = null;
    return accepted;
  }
  // (2026-11-17, ⑦ the wide map: how the latest read of a province went, for the one who selected it — hud/inspect.mjs.
  //  A read that failed is not "being read" for good and not an empty province: `failed` with the herald's code, or
  //  `missing` when the herald has no record of it (NotFound). Only for the world still pinned — checked above — and
  //  only while nothing is held: a record read before stays what is shown)
  if (bell === 'latest' && !FS.provinces.has(`${p},${q}`)) (FS.provinceReads ??= new Map()).set(`${p},${q}`, { state: r.code === 'NotFound' ? 'missing' : 'failed', code: r.code ?? 'Error' });
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
  // (2026-11-17, ⑦ the march tracker: `failed` — the read itself did not come (a code other than NotFound): not the same
  //  as "no slot there yet". Told beside the answer; `env` and `slot` are exactly what they were, so nothing that is
  //  decided from them — the self-reveal, the settle offer — changes.)
  if (!env.ok) return { env: null, slot: null, failed: env.code !== 'NotFound', code: env.code ?? null };
  if (env.bell !== b) return { env: null, slot: null, failed: false, code: null };
  const s = env.slots.find(x => BigInt(x.account.hostId) === BigInt(hostId));
  return { env, slot: s ?? null, failed: false, code: null };
}

/** Pipeline facts of bell b in region r from the herald's bell-region record. */
async function bellFacts(b, region, resolvedNext = null) {
  const r = await herald.bellRegion(b, region);
  // (`failed`: as slotOf — the read did not come; the facts and the record returned are what they were)
  if (!r.ok) return { facts: { anchor: null, archive: null, seed: false, resolvedNext }, record: null, failed: r.code !== 'NotFound', code: r.code ?? null };
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

/**
 * The identity a march order of this page is bound to (round 29): the book's key (cluster, program, Season, wallet),
 * local play's world instance, and the village it left from. null without a book key.
 */
function marchScope(h = activeHolding(FS)) {
  const k = bookKey();
  if (!k) return null;
  return `${k}|${localPlay ? String(localPlay.march?.instance ?? '') : ''}|${h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : ''}`;
}
/**
 * The destination of a march this page sent itself, from its order record — only one bound to the same identity
 * (marchScope), the same transit slot, host and arrival turn, and not refused; else null (the card stays unconfirmed).
 * Records that match but name different destinations (an old unconfirmed send beside a later one) are ambiguous: null.
 */
function ownMarchDest(t, scope) {
  if (!scope) return null;
  const all = (FS.orders ?? []).filter(x => x.kind === 'march' && x.state !== 'refused' && x.scope === scope && x.transitSlot === t.slot
    && x.arriveBell === t.arriveBell && String(x.host) === String(t.hostId) && x.dest && Number.isInteger(x.dest.p) && Number.isInteger(x.dest.q));
  const dests = new Set(all.map(x => `${x.dest.p},${x.dest.q},${x.dest.tile}`));
  if (dests.size !== 1) return null;
  const o = all[0];
  return { p: o.dest.p, q: o.dest.q, tile: o.dest.tile };
}
const holdingRef = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');
/**
 * fix-wide-breaks BREAK-4: a route through a province the chain holds no Province for — grown land the herald has no
 * record of (NotFound) — is sealed and departs, but its Reveal is refused for good (the program reads every path
 * province: BadAccount, Custom(2), for an absent one) and the host comes home unrevealed. Asked once the route is
 * planned (not awaited by setDestination): such a route is taken back with RouteNotOpen, so nothing is sealed for it.
 */
async function checkRouteOpen(c, dest, route) {
  const crossed = routeProvincesOf(route).filter(x => !(x.p === c.origin.p && x.q === c.origin.q) && !(x.p === dest.p && x.q === dest.q) && !FS.provinces?.has?.(`${x.p},${x.q}`));
  for (const x of crossed) {
    const pr = await herald.province(x.p, x.q, 'latest').catch(() => null);
    if (FS.compose !== c || c.dest !== dest || c.route !== route) return;
    if (pr && !pr.ok && pr.code === 'NotFound') { c.route = null; c.routeError = 'RouteNotOpen'; invalidate('panel'); return; }
  }
}
/** The provinces a planned route crosses, as `{p, q}` integers (the planner's ProvinceCoord list). */
export const routeProvincesOf = route => (route?.provinces ?? []).map(x => (Array.isArray(x) ? { p: Number(x[0]), q: Number(x[1]) } : { p: Number(x?.p), q: Number(x?.q) }))
  .filter(x => Number.isInteger(x.p) && Number.isInteger(x.q));

async function readMarches() {
  const key = bookKey();
  if (!key) return;
  // (2026-11-17, ⑦: the context and the viewer this reading BEGAN under — kept on the mark the list is written with, so
  //  a list read before a change of herald, viewer or world, or for another village, is never taken for this one's)
  const readCtx = contextSeq, readViewer = viewerKey() ?? null;
  // (devnet play: the encrypted book of the connected wallet; opened once, before the first read)
  if (devnetPlay) await devnetBookNow().catch(() => null);
  const store = marchStore();
  // (the Holding and the slots of the last `refresh`)
  const holding = activeHolding(FS) ?? null, slotsOfMine = mySlots;
  // (round 29: what this reading belongs to; a change of any of it while the reading waits — another herald, world,
  //  instance, village or book — and nothing of this reading is written)
  //  (2026-11-17, ⑦: and the pinned world with its generation — the book key names cluster, program and Season, but not
  //  which pinning: a reading started under the first A is not written under the A pinned again after B)
  const at = { herald, localPlay, instance: localPlay?.march?.instance ?? null, holding: holdingRef(holding), key, scope: marchScope(holding), world: providerWorld() };
  const same = () => herald === at.herald && localPlay === at.localPlay && (localPlay?.march?.instance ?? null) === at.instance
    && holdingRef(activeHolding(FS) ?? null) === at.holding && bookKey() === at.key && providerWorld() === at.world;
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
    const slotRead = b >= first.arriveBell ? await slotOf(dest, first.arriveBell, first.host) : { slot: null, env: null };
    const { slot, env } = slotRead;
    if (slot) revealed.push(first.host);
    // (for the question "does this march still lack its slot?" the viewer's own record counts too. The herald shows
    // a Reveal that landed in two places: the destination's envelope of the arrival bell — that bell's own file once
    // it is closed, `latest` only while that bell is the one the province resolves next — and the viewer's own
    // record, which lists the viewer's ArrivalSlots of any bell from the moment they exist. What the page says of
    // the march, and when, still follows the envelope alone)
    const seen = !!slot || slotsOfMine.some(x => x.bell === first.arriveBell && BigInt(x.hostId) === BigInt(first.host));
    const factsRead = b >= first.arriveBell ? await bellFacts(first.arriveBell, region, env?.province.resolvedNext ?? null) : { facts: {}, record: null };
    const { facts, record } = factsRead;
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
    // (devnet play: keeper A's `settle` role sends it, as it reveals: no page settle)
    const settleReady = !localPlay && !devnetPlay && !!transit && !!env && transit.state >= 2 && pl.state === 'resolved' && pl.close !== null && now() >= pl.close + 600;
    // (`unread`: which of this march's reads did not come — for the tracker's words and its "read again"; nothing above reads it)
    marches.push({ entry: e, transit, facts: { nowBell: b, pipeline: pl.state, slotPresent: !!slot, settleReady }, record, slot, env, dest, region,
      unread: slotRead.failed || factsRead.failed ? { slot: !!slotRead.failed, facts: !!factsRead.failed, code: slotRead.code ?? factsRead.code ?? null } : null });
  }
  // (round 29: a live transit this device's book has no entry for — in local play every march: the page seals it, the
  //  relay sends it, and no book entry is written — got no turn facts, so its card stood at "waiting for the key" for
  //  good, even after the key was out and the arrival resolved (seen in a ×10 world). Once its arrival turn has come,
  //  its stage is read as a booked march's is, from the destination the transit carries or else from this page's own
  //  order record bound to the same identity, slot, host and arrival turn. Only a turn record that was read sets it: a
  //  failed read, or no matching record, leaves the card as before (unconfirmed). Reads only; nothing is sent.)
  const looseFacts = new Map(), looseUnread = new Map();
  for (const t of transits.filter(x => x.state >= 1 && x.state <= 3)) {
    if (marches.some(m => m.transit && m.transit.slot === t.slot) || !Number.isInteger(t.arriveBell) || b < t.arriveBell) continue;
    const dest = t.dest ?? ownMarchDest(t, at.scope);
    if (!dest) continue;
    const slotRead = await slotOf(dest, t.arriveBell, t.hostId);
    const { slot, env } = slotRead;
    if (!same()) return;
    const factsRead = await bellFacts(t.arriveBell, regionOf(dest.p, dest.q), env?.province.resolvedNext ?? null);
    const { facts, record } = factsRead;
    if (!same()) return;
    if (slotRead.failed || factsRead.failed) looseUnread.set(t.slot, { slot: !!slotRead.failed, facts: !!factsRead.failed, code: slotRead.code ?? factsRead.code ?? null, dest });
    if (record === null) continue;
    looseFacts.set(t.slot, { dest, slot, env, record, pipeline: pipeline(FS.clock, t.arriveBell, { now: now(), ...facts }).state });
  }
  // (from here to the write nothing waits: the book is read as it stands and written at once)
  const held = book.loadBook(store, key);
  // A live transit this device has no entry for (another device, cleared
  // storage): a card with entry null, so the tracker says keepers reveal it.
  for (const t of transits.filter(x => x.state >= 1 && x.state <= 3)) {
    if (marches.some(m => m.transit && m.transit.slot === t.slot)) continue;
    if (held.some(e => e.transitSlot === t.slot && e.host === String(t.hostId) && e.state !== 'settled')) continue;
    const lf = looseFacts.get(t.slot) ?? null, lu = looseUnread.get(t.slot) ?? null, dest = lf?.dest ?? t.dest;
    marches.push({ entry: null, transit: t, facts: { nowBell: b, pipeline: lf?.pipeline ?? null, slotPresent: !!lf?.slot, settleReady: false }, record: lf?.record ?? null, slot: lf?.slot ?? null, env: lf?.env ?? null,
      dest, region: dest ? regionOf(dest.p, dest.q) : null, unread: lu ? { slot: lu.slot, facts: lu.facts, code: lu.code } : null, readDest: lu?.dest ?? null });
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
  // (TEST-ONLY wide local play, fix-wide-breaks BREAK-1/3: the expeditions this page sent into the wide land — their
  //  host is in a bridge transit, the village's slot holds only its marker (state 4), so none of the reads above sees
  //  them. One read each through the relay's reveal/context route; their rows join the list. Reads only.)
  if (localPlay && localDepart.localDepartReveals(FS).some(r => r.signature)) {
    const gate = localDepartGate();
    // (fix-loop11, LP11-1: a departure sent and not settled is asked about here too, by its first signature — a read
    //  only; a refusal marks its seal, so the rows below drop it. loop-play11: the card's one look came before the chain
    //  had judged it, and nothing asked again until the person pressed 「結果を照合する」)
    if (gate?.ok && ['submitted', 'unknown'].includes(localDepart.localDepartOf(FS).status)) {
      await localDepart.reconcileLocalDepart(FS, { allowed: localDepartGate, changed: localDepartChanged }).catch(() => null);
      if (!same()) return;
    }
    if (gate?.ok) {
      await localExpedition.readExpeditions(FS, { relay: gate.relay, pin: { programId: localPlay.programId, seasonAddress: localPlay.seasonAddress },
        faction: Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : null, nowBell: b }).catch(() => null);
      if (!same()) return;
      await followExpeditionHolds(gate, b).catch(() => null);
      if (!same()) return;
    }
    marches.push(...localExpedition.expeditionRows(FS));
  }
  if (key !== bookKey() || !same()) return;
  FS.formingBells = forming;
  book.saveBook(store, key, entries);
  FS.book = entries;
  FS.marches = marches;
  // (the list was read for this book, village and world: an empty list now means "none", not "not read" — the tracker)
  FS.marchesRead = { key, world: at.world, ctx: readCtx, viewer: readViewer, holding: at.holding };
  FS.bellItems = [
    ...(holding ? [{ bell: b, region: regionOf(holding.p, holding.q), why: 'current', facts: {} }] : []),
    ...marches.filter(m => !m.expedition).map(m => ({ bell: m.entry?.arriveBell ?? m.transit?.arriveBell, region: m.region, why: 'arrival', facts: {} })),
  ];
}

/**
 * (fix-loop9, LP9-2) The hold of a wide keep by a kept expedition that stays on its tile, followed to its end: one read of
 * the province its own host stands in (the relay's wide read), the count shown on the march card, and the end — taken or
 * lost — said once as a notice. loop-play9: the keep was taken on chain at turn 550 and the page said nothing.
 */
async function followExpeditionHolds(gate, nowBell) {
  const faction = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : null;
  if (faction === null || !localPlay?.programId || !localPlay?.seasonAddress) return;
  const holds = localExpedition.expeditionHoldsOf(FS);
  const [{ readWideProvince }, { fromBase64 }, { wideProvinceAddress }] = await Promise.all([import('./flocalplay-wide-host.mjs'), import('../sdk/bytes.mjs'), import('./flocalplay-wide.mjs')]);
  const read = async addresses => {
    const j = await localAct.postLocalAct(gate.relay, localAct.LOCAL_ACT_CONTEXT_PATH, { schema: 'frontier-local-play-act-wide-read-v1', addresses });
    return (j?.accounts ?? []).map(a => (a ? fromBase64(a.data_b64) : null));
  };
  await localExpedition.readExpeditionHolds(FS, { read, parse: readWideProvince, address: (p, q) => wideProvinceAddress(localPlay.seasonAddress, localPlay.programId, p, q), faction, nowBell });
  // (an end is told once — and only counted as told when it was said: the fix-loop9 live run's capture came while a
  //  harvest's 「送信中…」 was up, the notice was skipped and never said; it now waits for the next refresh)
  for (const [k, h] of holds) {
    if (!h?.outcome || expeditionHoldTold.get(k) === h.outcome || FS.notice?.busy) continue;
    expeditionHoldTold.set(k, h.outcome);
    done(() => expeditionHoldText(h));
  }
}
const expeditionHoldTold = new Map();

/**
 * Read again what the tracker shows of ONE march whose reads did not come (2026-11-17, ⑦) — a pure read. It asks the
 * herald for the same two files readMarches reads for it (the destination's envelope of the arrival turn, that turn's
 * region record) and writes only what the tracker shows of that march: `facts.pipeline`, `facts.slotPresent` and
 * `unread`. It does NOT load or save the book, does NOT reveal (io.reveal), does NOT touch `slot`, `env`, `record`,
 * `entry`, `transit` or `settleReady` — what the self-reveal and the settle offer are decided from stays readMarches'
 * own, at its own times. Only a march marked `unread`, only from the arrival turn on (a sealed destination is never
 * asked for before it), only the destination this page already used for that read. The answer is written only if the
 * same herald, local-play instance, village, book, world and list still stand and no later press was made ON THIS MARCH.
 * Resolves true when the reads came, false when they did not or the request was let go.
 */
export async function rereadMarchFacts(hostId) {
  const list = FS.marches, m = (list ?? []).find(x => String(x.entry?.host ?? x.transit?.hostId ?? '') === String(hostId));
  const dest = m?.entry ? m.dest : m?.readDest ?? m?.dest ?? null;
  const bell = m?.entry?.arriveBell ?? m?.transit?.arriveBell;
  if (!m?.unread || !dest || !Number.isInteger(bell) || !herald || nowBell() < bell) return false;
  // (2026-11-17 correction: the request is this march's own — `m.rereadReq`, a token on the item. A later press on the
  //  SAME march takes its place; a press on another march does not touch it (one number for all marches let march B's
  //  press call off march A's). The tidy-up clears "being read" only while the item still names this request.)
  const req = m.rereadReq = {}, holding = holdingRef(activeHolding(FS) ?? null);
  const at = { herald, localPlay, instance: localPlay?.march?.instance ?? null, holding, key: bookKey(), world: providerWorld() };
  const same = () => m.rereadReq === req && FS.marches === list && list.includes(m) && herald === at.herald && localPlay === at.localPlay
    && (localPlay?.march?.instance ?? null) === at.instance && holdingRef(activeHolding(FS) ?? null) === at.holding && bookKey() === at.key && providerWorld() === at.world;
  m.rereading = true; invalidate('panel');
  let ok = false;
  try {
    const slotRead = await slotOf(dest, bell, m.entry?.host ?? m.transit?.hostId);
    if (!same()) return false;
    const factsRead = await bellFacts(bell, regionOf(dest.p, dest.q), slotRead.env?.province.resolvedNext ?? null);
    if (!same()) return false;
    if (slotRead.failed || factsRead.failed) m.unread = { slot: !!slotRead.failed, facts: !!factsRead.failed, code: slotRead.code ?? factsRead.code ?? null };
    else {
      // (a loose transit whose turn record is not there yet keeps its stage unknown, as readMarches leaves it)
      const known = !!m.entry || factsRead.record !== null;
      m.facts = { ...m.facts, ...(known ? { pipeline: pipeline(FS.clock, bell, { now: now(), ...factsRead.facts }).state, slotPresent: !!slotRead.slot } : {}) };
      m.unread = null; ok = true;
    }
  } catch (e) { console.error('frontier march reread:', e); if (same()) m.unread = { ...(m.unread ?? {}), code: e?.code ?? 'Error' }; }
  finally { if (m.rereadReq === req) m.rereading = false; invalidate('panel'); }
  return ok;
}

async function refreshChronicle() {
  // (2026-11-17, ⑦: the context this reading BEGAN under — what it judges at its end is marked with it, never with a
  //  context that began while it was under way: FS.incomingRead.ctx)
  const ctxAt = contextSeq;
  // (2026-11-17, ⑦: the chronicle belongs to one herald and one pinned world — cluster, program, season account as
  // fchainio.setPin pinned them. When either changed since it was read, what it holds is another world's: it is
  // forgotten — not shown as this world's, and not told as empty — and read again from the new world's start. A
  // read that the change overtakes writes nothing.)
  // (with the pin's generation — fchainio.setPin: a read started under the first A is not written under the A pinned again after B)
  const worldNow = () => { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; };
  const h0 = herald, w0 = worldNow();
  if (FS.chronicleSource !== h0 || FS.chronicleWorld !== w0) {
    if (FS.chronicleSource !== undefined) { cursor = 0; FS.chronicle = undefined; FS.chronicleRead = undefined; FS.life = undefined; FS.lifeWorld = undefined; }
    FS.chronicleSource = h0; FS.chronicleWorld = w0;
  }
  if (cursor === 0 && FS.record?.headSeq !== undefined) cursor = chronicleStart(FS.record.headSeq);
  // (workstream 07: a page that could not be read is said as such — screens/chronicle.mjs chronicleState —, never as an
  // empty record: FS.chronicle stays undefined until a page has been read, and FS.chronicleRead says how the last poll went)
  let failed = null, pages = 0;
  for (let page = 0; page < CHRONICLE_PAGES; page++) {
    let r;
    try { r = await herald.events(cursor); } catch (e) { r = { ok: false, code: e?.code ?? 'network' }; }
    // (the herald or the pinned world changed while this page was read: nothing of it is written, FS stays as it is)
    if (herald !== h0 || worldNow() !== w0) return;
    if (!r?.ok) { failed = String(r?.code ?? 'Unavailable'); break; }
    pages++;
    const { records } = decodePage(r.events);
    // (the prototype's own records ride on the same pages, in a sample world that serves them)
    if (FS.proto) { const had = FS.proto.log, log = pm.mergeLog(had, pm.landRecords(r.events)); if (log.length !== had.length || log.at(-1)?.seq !== had.at(-1)?.seq) { FS.proto.log = log; FS.proto.rev = (FS.proto.rev ?? 0) + 1; } }
    FS.chronicle = [...(FS.chronicle ?? []), ...records].slice(-400);
    // the life of every holding (people/life.mjs): folded from every record read, not only the last 400
    FS.life = updateLife(FS.life ?? new Map(), records);
    // (the world this life was read for: built from this world's pages since the last reset — app.mjs checkMoments)
    FS.lifeWorld = w0;
    if (r.next !== null && r.next !== undefined) cursor = r.next;
    if (!r.full) break;
  }
  if (pages > 0 && FS.chronicle === undefined) FS.chronicle = [];
  FS.chronicleRead = { ok: failed === null, code: failed, pages, bell: nowBell() };
  // (the viewer's holdings when a line is drawn, not when the record was read: after a wallet change the former
  // viewer's lines are not marked as this one's)
  FS.isMine = rec => {
    const own = FS.holdings ?? [];
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
  // (the viewer's holdings as they stand after this read — no await since the pages — as before 2026-11-17; isMine reads
  // them itself when a line is drawn)
  const holdingsNow = FS.holdings ?? [];
  FS.incoming = FS.citizen ? incomingWarnings({ kernel: k, departures, holdings: holdingsNow.map(o => ({ p: o.p, q: o.q, site: o.site, tile: o.tile, shieldUntilBell: FS.provinces.get(`${o.p},${o.q}`)?.province?.siteMirror?.[o.site]?.shieldUntilBell })), faction: FS.citizen.faction, genesisTs: FS.clock.genesisTs, nowBell: nowBell(), unitOf: () => WARNING_UNIT }) : [];
  { const fog = fogNow(); if (fog.on) FS.incoming = fog.incoming(FS.incoming, { nowBell: nowBell(), departures }); }
  // (2026-11-17, ⑦ the warning's way on — screens/incoming.mjs: each warning names its village whole (its tile and its
  //  generation, from the very holdings it was judged for), and how this judging was read is kept beside it: the pinned
  //  world, whether the rules were there, whether the chronicle's read came, and how many departures still under way
  //  could not be judged because the owner of their origin is not read. The judging itself — incomingWarnings, the reach
  //  test, the unit — and how often it runs are what they were.)
  for (const w of Array.isArray(FS.incoming) ? FS.incoming : []) {
    const o = holdingsNow.find(x => x.p === w.holding.p && x.q === w.holding.q && x.site === w.holding.site);
    if (o) { w.holding.tile = o.tile; w.holding.gen = o.gen ?? 0; }
  }
  const unknownOrigins = (FS.chronicle ?? []).filter(x => x.record.name === 'DEPART' && Number(x.record.arrive_bell) >= nowBell()).filter(x => {
    const h = hostParts(x.record.host_id);
    const ov = h && [...FS.overviews.values()].flatMap(o => o.provinces).find(pr => pr.p === h.p && pr.q === h.q);
    const f = ov && h ? ov.owners?.[h.site] : null;
    return f === null || f === undefined;
  }).length;
  // (`ctx`, `viewer`: the context this judging was read under — the number moves with every change of viewer, herald or
  //  pinned world. The card and the app compare it with the number NOW (`FS.contextSeq`): a judging of an earlier
  //  context is not this one's, and its buttons act on nothing — screens/incoming.mjs incomingRead, app.mjs incomingStill)
  FS.incomingRead = { world: providerWorld(), rules: !!k, chronicleOk: failed === null, unknownOrigins, bell: nowBell(), ctx: ctxAt, viewer: viewerKey() ?? null };
}

/** The herald client this controller reads (startPlay sets it; tests pass a fake). */
export function useHerald(h) { expedition.clearInspection(FS); outbound.clearOutbound(FS); herald = h; cursor = 0; mySlots = []; conquestRefresh += 1; homesRefresh += 1; viewerRefresh += 1; fwide.clearWide(FS); FS.meAnswered = false; FS.meWorld = undefined; FS.villageReread = null; FS.s1Reread = null; FS.s1Plan = null; exploreSeedMarks.clear(); FS.exploreSeedCheck = null; FS.incomingRead = null; FS.hostPlaces = null; nextContext(); }

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
// (fix-loop5, L5-3: a read the clock's move dropped — fexpedition-compose `dropped` — is read again by itself, at most
//  OUTBOUND_READ_RETRIES more times; then the card says so and the person presses again. Reads only: nothing is sent)
export const OUTBOUND_READ_RETRIES = 2;
// (fix-loop6, LP6-8: each read made again is said on the card while it runs — FS.outboundReread — : a mid-turn press at
//  ×60 showed nothing for 12 s and more while the page read again by itself)
const outboundReadAgain = async (run, kind) => {
  try {
    for (let i = 0; ; i++) {
      await run();
      if (FS.expeditionCompose?.dropped !== kind || i >= OUTBOUND_READ_RETRIES) return;
      FS.outboundReread = { kind, n: i + 1, of: OUTBOUND_READ_RETRIES }; invalidate('panel');
    }
  } finally { if (FS.outboundReread) { FS.outboundReread = null; invalidate('panel'); } }
};
// (fix-loop8, LP8-1: a departure refused unsent — DepartDraftChanged and the like, status 'error' — no longer stands on the
//  card over every later read: a new read of the road or of the conditions is a new attempt, and the old line goes.
//  clearLocalDepart keeps a run in flight or one whose outcome is not known.)
const forgetDepartError = () => { if (localDepart.localDepartOf(FS).status === 'error') localDepart.clearLocalDepart(FS); };
export const inspectOriginalOutboundRoute = () => { forgetDepartError(); return outboundReadAgain(() => outbound.inspectOutboundRoute(FS, { context: expeditionContext, changed: () => invalidate('panel') }), 'route'); };
export const inspectOriginalOutboundContext = () => { forgetDepartError(); return outboundReadAgain(() => outbound.inspectOutboundContext(FS, { context: expeditionContext, changed: () => invalidate('panel') }), 'context'); };
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
// (fix-loop11, LP11-1: a departure the chain refused after 「送信しました」 — its run reconciled `failed`, by the card's
//  「結果を照合する」 or by the march list's own look below — is said ONCE as a notice too, in plain words: the card may be
//  closed by then, and loop-play11's player read 「送信しました」 and went to the 進軍 list, where the refused seal stood)
const departToldFailed = new WeakSet();
const departRefusedNotice = () => {
  const d = localDepart.localDepartOf(FS);
  if (!['failed', 'expired'].includes(d.status) || !d.signature) return;
  const seal = localDepart.localDepartReveals(FS).find(x => x.signature === d.signature);
  if (!seal || departToldFailed.has(seal)) return;
  departToldFailed.add(seal);
  setNotice({ ok: false, busy: false, unsent: 'expedition-depart', retry: false, text: d.status === 'expired'
    ? () => L`遠征の出発の取引は、記録されないまま期限が切れました。軍勢は村にいます。境界のカードで「出発条件を確認」を押して読み直すと、もう一度出発できます。`
    : d.chain === 'rejected' ? () => L`遠征の出発は送る前の確かめで断られました（チェーンには届いていません）：${departRefusedReason(d)}。軍勢は村にいます。境界のカードで「出発条件を確認」を押して読み直すと、もう一度出発できます。`
    : () => L`遠征の出発はチェーンで断られました：${departRefusedReason(d)}。軍勢は村にいます。境界のカードで「出発条件を確認」を押して読み直すと、もう一度出発できます。` });
};
const localDepartChanged = () => { departRefusedNotice(); invalidate('map', 'panel'); };
export const localPlayDepartAllowed = () => localDepartGate();
// (fix-loop6, LP6-1: at ×60 the conditions' observation is dropped by the next clock poll, often before the person's
//  press on 出発する — the press was refused in place (loop-play6: 17 presses / 18 s). A press on a draft whose conditions
//  were read as holding (outboundReadyOnce) reads them again first and departs only if they still hold; otherwise the
//  card shows that read. The departure's own checks, and the program's, are unchanged.)
const isReadyNow = () => { const c = FS.expeditionCompose?.contextCheck; return c?.status === 'read' && c.ready?.ok === true && c.report?.ok === true; };
// (fix-loop8, LP8-1: a run that ends UNSENT because the clock moved — DepartDraftChanged — is tried again by the page,
//  flocalplay-depart.mjs departWithRetries: only while the card shows the same draft, after reading the conditions again
//  (and taking the in-time arrival candidate when the entered turn is now too early); never after anything was sent)
const departDraftNow = draft => FS.hand?.pop === outbound.OUTBOUND_POP && FS.expeditionCompose === draft && !!draft?.source;
const ARRIVAL_EARLY = ['ArrivalTooEarly', 'ArrivalWindowEmpty'];
export const sendLocalPlayDeparture = async () => {
  if (!isReadyNow() && outbound.outboundReadyOnce(FS)) {
    await inspectOriginalOutboundContext();
    if (!isReadyNow()) return localDepart.localDepartOf(FS);
  }
  const draft = FS.expeditionCompose ?? null;
  return localDepart.departWithRetries({ draftNow: () => departDraftNow(draft), readyNow: isReadyNow, reread: inspectOriginalOutboundContext,
    arrivalEarly: () => { const c = FS.expeditionCompose?.contextCheck; return c?.status === 'read' && ARRIVAL_EARLY.includes(c.report?.code); },
    takeInTime: useEarliestOriginalOutboundArrival,
    onRetry: (n, of) => { FS.departRetry = n === null ? null : { n, of }; invalidate('panel'); },
    run: async () => {
      const out = await localDepart.runLocalDepart(FS, { allowed: localDepartGate, context: expeditionContext,
        sealInput: () => ({ clock: FS.clock, drand: FS.record?.drand, seasonPkHash: FS.season?.quicknetPkHash, seasonNetwork: FS.season?.network, cluster: FS.record?.cluster }),
        seal: async req => (await import('./seal-wide.mjs')).sealWide(req), signer: currentEphemeralWallet, changed: localDepartChanged });
      if (out?.sent) {
        outbound.forgetOutboundReady(FS);
        // (fix-loop12, LP12-4: an earlier departure's refusal notice — 「遠征は出発していません…軍勢は村にいます」 — stood
        //  at the top for 40 turns after this one departed: a sent departure sets no notice of its own, so the old
        //  refusal was never replaced. A departure that went out and was not refused makes it untrue; it goes. A run
        //  refused itself — the runner's preflight answers after the bytes were posted, so it is `sent` too — keeps the
        //  notice it has just set (departRefusedNotice). Any other notice stays.)
        if (!['failed', 'expired', 'error'].includes(out.status) && FS.notice && FS.notice.ok === false && FS.notice.unsent === 'expedition-depart') setNotice(null);
      }
      return out;
    } });
};
export const reconcileLocalPlayDeparture = () => localDepart.reconcileLocalDepart(FS, { allowed: localDepartGate, changed: localDepartChanged });
export const clearLocalPlayDeparture = () => { const ok = localDepart.clearLocalDepart(FS); if (ok) localDepartChanged(); return ok; };
/**
 * DEVNET PLAY (devnet gap P15; fdevnet-depart.mjs): the boundary draft's departure on a WIDE devnet season, signed by the
 * player's CONNECTED wallet through the gateway's devnet expedition routes. Two presses: `prepare` seals (the reveal
 * half kept in the encrypted devnet book), builds the one canonical message and shows what it costs; `send` has the
 * wallet sign exactly that message and sends it once. keeper A's `expeditions` role drives every later step. Under the
 * devnet gate (devnet play on, this page's wallet connected and shown, not an NFT Citizen) and only on a wide season.
 */
const devnetDepartGate = () => { if (!devnetWideNow()) return { ok: false, code: 'DevnetDepartNotWide' }; return devnetGate(); };
export const devnetPlayDepartAllowed = () => devnetDepartGate();
export const prepareDevnetPlayDeparture = () => devnetDepart.prepareDevnetDepart(FS, { allowed: devnetDepartGate, context: expeditionContext,
  sealInput: () => ({ clock: FS.clock, drand: FS.record?.drand, seasonPkHash: FS.season?.quicknetPkHash, seasonNetwork: FS.season?.network, cluster: FS.record?.cluster }),
  seal: async req => (await import('./seal-wide.mjs')).sealWide(req), book: () => devnetBookNow(), wallet: () => FS.wallet?.address ?? null, changed: localDepartChanged });
export const sendDevnetPlayDeparture = async () => {
  const st = await devnetDepart.sendDevnetDepart(FS, { allowed: devnetDepartGate, sign: async w => wallet.signTransaction(w),
    wallet: () => FS.wallet?.address ?? null, changed: localDepartChanged });
  followDevnetDeparture();
  return st;
};
export const reconcileDevnetPlayDeparture = () => devnetDepart.reconcileDevnetDepart(FS, { allowed: devnetDepartGate, changed: localDepartChanged });
/**
 * (fix-devnet-join-wait) A sent departure whose status is still open (`submitted`: pending or processed only; `unknown`:
 * the send's answer was lost) is asked about again BY ITSELF — every DEVNET_DEPART_RECHECK_MS, at most
 * DEVNET_DEPART_RECHECK_TRIES times (about 2 minutes, longer than a blockhash lives) — by its signature, through the
 * gateway it was sent through (reconcileDevnetDepart: one status read, never a second send). It was asked once after
 * the send and then only on 「状況を確かめる」: a Depart that reached `confirmed` a few seconds later read as unconfirmed
 * until the player pressed. The button stays; this only stops the card from waiting silently.
 */
export const DEVNET_DEPART_RECHECK_MS = 3000, DEVNET_DEPART_RECHECK_TRIES = 40;
let devnetDepartFollow = null;
function followDevnetDeparture({ every = DEVNET_DEPART_RECHECK_MS, tries = DEVNET_DEPART_RECHECK_TRIES } = {}) {
  const open = d => ['submitted', 'unknown'].includes(d?.status) && typeof d.signature === 'string';
  const d0 = devnetDepart.devnetDepartOf(FS);
  if (!open(d0) || devnetDepartFollow === d0.signature) return;
  const sig = devnetDepartFollow = d0.signature;
  let n = 0;
  const tick = async () => {
    const d = devnetDepart.devnetDepartOf(FS);
    // (another departure, or this one settled — confirmed, failed, cleared —, or the tries spent: the follow ends)
    if (devnetDepartFollow !== sig || d.signature !== sig || !open(d) || ++n > tries) { if (devnetDepartFollow === sig) devnetDepartFollow = null; return; }
    try { await reconcileDevnetPlayDeparture(); } catch { /* asked again at the next tick */ }
    setTimeout(tick, every);
  };
  setTimeout(tick, every);
}
export const clearDevnetPlayDeparture = () => { const ok = devnetDepart.clearDevnetDepart(FS); if (ok) localDepartChanged(); return ok; };
/** The reveal halves of this wallet's boundary departures, as the encrypted devnet book keeps them (null: no book here). */
export const devnetPlayDepartReveals = async () => { const b = await devnetBookNow(); return b ? devnetDepart.devnetDepartReveals(b.storage) : null; };
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
// (2026-11-17, ⑦ the wide map: each read under way has its own token, so the end of an older read of a province — one
//  another world's change let go — neither frees the place of a newer read of that province nor clears what it says)
const artWanted = new Map();   // "P,Q" → the token of the read under way FOR THE WORLD NOW PINNED
// (2026-11-17 correction: the places are counted by the reads that are really under way — every token from its start
//  until its request has settled, whatever world it was asked of. A change of world lets go of what the reads MEAN
//  (artWanted, above: their answers are dropped) but not of the places they still take: the client cannot call a
//  request off, so it is not counted as stopped. The limit therefore holds across any number of changes of world.)
const readsUnderWay = new Set();   // the tokens of every request not settled yet
const fetchedAt = new Map();
/**
 * The ONE read that waits for a free place (2026-11-17, ⑦): the province the person selected, or pressed "read again"
 * for, when all WANT_IN_FLIGHT places are taken. Never a queue: a later one takes its place. It starts when a read
 * ends — only if the same world is still pinned and that province is still the one selected; otherwise it is let go.
 */
let waitingWant = null;
const selectedIs = (p, q) => { const s = FS.selected; return !!s && s.p === p && s.q === q; };
function holdWant(p, q, onLoad) {
  const key = `${p},${q}`;
  if (waitingWant && waitingWant.key !== key && FS.provinceReads?.get(waitingWant.key)?.state === 'waiting') FS.provinceReads.delete(waitingWant.key);
  waitingWant = { p, q, key, onLoad, world: providerWorld() };
  if (!FS.provinces.has(key)) (FS.provinceReads ??= new Map()).set(key, { state: 'waiting', code: null });
}
function startWaiting() {
  const w = waitingWant;
  if (!w) return;
  if (w.world !== providerWorld() || !selectedIs(w.p, w.q)) {
    waitingWant = null;
    if (FS.provinceReads?.get(w.key)?.state === 'waiting') FS.provinceReads.delete(w.key);
    return;
  }
  if (!herald || artWanted.has(w.key) || readsUnderWay.size >= WANT_IN_FLIGHT) return;
  waitingWant = null;
  startProvinceRead(w.p, w.q, w.onLoad, Date.now());
}
/** Start one read (the caller has checked the limit and that none of this province is under way). */
function startProvinceRead(p, q, onLoad, now) {
  const key = `${p},${q}`, token = {}, world = providerWorld();
  artWanted.set(key, token);
  readsUnderWay.add(token);
  fetchedAt.set(key, now);
  // (the read is under way: a province not held says so, also over an earlier failure or wait)
  if (!FS.provinces.has(key)) (FS.provinceReads ??= new Map()).set(key, { state: 'loading', code: null, token });
  else if (FS.provinceReads?.get(key)?.state === 'waiting') FS.provinceReads.delete(key);
  loadEnvelope(p, q).catch(() => { if (providerWorld() === world && artWanted.get(key) === token && !FS.provinces.has(key)) (FS.provinceReads ??= new Map()).set(key, { state: 'failed', code: 'Error' }); return null; })
    .finally(() => {
      // (settled — answered, failed or dropped: its own place is free now, and only its own)
      readsUnderWay.delete(token);
      // (only this read's own name and words: a newer read of the province keeps its own)
      if (artWanted.get(key) === token) artWanted.delete(key);
      const st = FS.provinceReads?.get(key);
      // (an answer the change of world dropped left "loading" behind for a province nobody asks about now: let go)
      if (st?.state === 'loading' && st.token === token && !FS.provinces.has(key)) FS.provinceReads.delete(key);
      startWaiting();
      onLoad();
    });
}
export function wantProvince(p, q, onLoad = () => {}, { now = Date.now(), bell = nowBell() } = {}) {
  const key = `${p},${q}`;
  if (!herald || artWanted.has(key)) return false;
  const have = FS.provinces.get(key);
  if (have && !(have.bell < bell && now - (fetchedAt.get(key) ?? 0) >= WANT_REFRESH_MS)) return false;
  // (workstream 07: a Province asked for and not stored — its read failed, e.g. 404 for one not on chain yet — waits the
  // same interval: each finished load redraws, and the redraw asked for it again at once, hundreds of times a minute)
  if (!have && fetchedAt.has(key) && now - fetchedAt.get(key) < WANT_REFRESH_MS) return false;
  // (every place taken: the map's own asks come again with the next redraw; the province the person selected — also
  //  from far away, where the map does not ask for it — waits for the next free place instead of being lost)
  if (readsUnderWay.size >= WANT_IN_FLIGHT) { if (selectedIs(p, q)) holdWant(p, q, onLoad); return false; }
  startProvinceRead(p, q, onLoad, now);
  return true;
}
/**
 * Read a province again now, at the person's request (the inspector's button; 2026-11-17, ⑦): the wait before asking
 * again is set aside for this province only. Answers what became of the press, never nothing: 'started', 'loading'
 * (its read is already under way: not doubled), 'waiting' (every place is taken: it has the one waiting place and
 * starts when a read ends) or false (no herald). A record held is read again whatever its bell: the person asked.
 */
export function retryProvince(p, q, onLoad = () => {}) {
  const key = `${p},${q}`;
  if (!herald) return false;
  if (artWanted.has(key)) return 'loading';
  fetchedAt.delete(key);
  if (readsUnderWay.size >= WANT_IN_FLIGHT) { holdWant(p, q, onLoad); return 'waiting'; }
  startProvinceRead(p, q, onLoad, Date.now());
  return 'started';
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
    // (2026-11-17, ⑦: the world this answer was read for — with the pin's generation —, for every answer: a Citizen
    //  and also "no Citizen". `FS.holdingsWorld` below is written only with villages, so "answered: none" had no world
    //  and could not be told from an answer of another world. Read metadata only: nothing is decided from it here.)
    FS.meWorld = providerWorld();
    const before = FS.land?.stage;
    FS.citizen = me.citizen;
    FS.holdings = me.holdings;
    // (the world these holdings were read for: the moments wait for it after a change of world — app.mjs checkMoments)
    FS.holdingsWorld = providerWorld();
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
    FS.meWorld = providerWorld();
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

/**
 * rent-live-rest: the cluster's rent of one Holding (the village ticket's escrow the details show), asked of the
 * page's own gateway route — devnet play: its RPC; local play: the runner — at most every RENT_RETRY_MS after a
 * failure and every RENT_FRESH_MS after an answer (frent.mjs). With no route (the sponsored demo) or no answer the
 * page shows the 5,080 MODEL figure and labels it so (app.mjs detailsMarkup). Nothing is sent.
 */
let rentAsking = false;
function rentRoute() {
  if (devnetPlay?.relay) return { relay: devnetPlay.relay, path: localAct.DEVNET_ACT_CONTEXT_PATH };
  const g = localPlay ? localDepartGate() : null;
  return g?.ok ? { relay: g.relay, path: localAct.LOCAL_ACT_CONTEXT_PATH } : null;
}
export function refreshRent(now = Date.now()) {
  if (rentAsking || !frent.rentDue(FS.rent, now)) return null;
  const route = rentRoute();
  if (!route) { FS.rent = frent.rentFailed(FS.rent, 'NoRentRoute', now); return null; }
  rentAsking = true;
  const adopt = r => { FS.rent = r; invalidate('panel'); };
  return localAct.postLocalAct(route.relay, route.path, { schema: frent.RENT_CONTEXT_SCHEMA })
    .then(v => adopt(frent.rentOfAnswer(v) ?? frent.rentFailed(FS.rent, 'RentAnswerMalformed')))
    .catch(e => adopt(frent.rentFailed(FS.rent, e?.code ?? 'Unavailable')))
    .finally(() => { rentAsking = false; });
}

/** Refresh the viewer's accounts, provinces, marches, chronicle and quota. */
export async function refresh() {
  // (2026-11-17, ⑦: counted while it runs, for rereadVillage — which adopts nothing while a refresh is under way, so a
  //  refresh goes from its own /h/me answer to its end on one observation. Nothing below is changed by the count.)
  pollsUnderWay += 1;
  try {
  if (!herald || !FS.clock) return;
  const request = ++viewerRefresh, world = providerWorld();
  FS.nowBell = nowBell();
  // (rent-live-rest: the cluster's rent for the ticket escrow preview, cached; never awaited here — frent.mjs)
  refreshRent();
  // A gated season shows the invite field before any refusal (I-51).
  FS.inviteRequired = FS.inviteRequired || inviteRequired(FS.season);
  await refreshPrize().catch(() => null);
  if (request !== viewerRefresh) return;
  syncProto();
  if (FS.wallet) {
    const address = FS.wallet.address;
    // (and the pinned world this refresh began under: a viewer's record or a province read for another world is never
    // applied to this one — 2026-11-17)
    const currentViewer = () => request === viewerRefresh && FS.wallet?.address === address && providerWorld() === world;
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
    // (2026-11-17, ⑦ the hosts screen: the provinces the viewer's record says its hosts stand in — every village's, the
    //  home province too — kept for the screen, which lists hosts only from the provinces the page HOLDS: a province
    //  named here and not held is "not read", not "no host". Nothing more is read for it; `ctx`: the context it was read under.)
    if (me.ok) FS.hostPlaces = { places: hostProvinces(me.record, null), ctx: contextSeq, world };
    if (me.ok) for (const pq of hostProvinces(me.record, h ? { p: h.p, q: h.q } : null)) { await loadEnvelope(pq.p, pq.q); if (!currentViewer()) return; }
    // SettleExplore is offered once the explore bell's seed is readable.
    FS.exploreSeedReady = false;
    // (2026-11-17, ⑦, corrected: under startPlay's setter this line takes back only a `true` written from outside — a
    //  seed READ ready for this village stays through the next read, and is no longer wiped at every refresh's start)
    if (h?.explore?.state && nowBell() >= h.explore.bell) {
      // (the read is the one it was — the same condition, once, for the village in hand. Its answer goes through the ONE
      //  place every seed answer is applied — applyExploreSeed — with what it was asked for and its request's number)
      const seedOf = { ref: holdingRef(h), bell: Number(h.explore.bell), ask: ++exploreSeedAsk };
      const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q));
      if (!currentViewer()) return;
      applyExploreSeed(seedOf.ref, seedOf.bell, world, r, seedOf.ask);
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
  // (⑧ doc 31 §1-A: a reading that has just found the heartland full hands over to the village request at once)
  if (needsHomeChoice()) { await refreshHomes(); if (heartlandFull(FS)) autoTicket().catch(e => console.error('frontier auto ticket:', e)); }
  else autoTicket().catch(e => console.error('frontier auto ticket:', e));
  } finally { pollsUnderWay -= 1; }
}

/** How many `refresh` calls are under way (counted at its head and in its `finally`); see rereadVillage. */
let pollsUnderWay = 0;

/**
 * Whether adopting this /h/me answer through applyMeResult would save nothing on the device: the land stage is the one
 * held (or none was held yet), no "why the land ended" record waits to be cleared, and no filed ticket waits to be
 * marked seen. Under exactly these conditions none of applyMeResult's `saveLandPatch` lines runs. "No Citizen" is plain
 * only while no Citizen and no village is held (a held village is never dropped by a re-read). `readLand` reads the
 * device's record, as applyMeResult itself does first; it writes nothing to the device.
 */
function plainMeAnswer(me) {
  if (!me.ok) return me.code === 'NotFound' && !FS.citizen && !(FS.holdings ?? []).length;
  const before = FS.land?.stage ?? null, after = landState(me.citizen).stage;
  if (before !== null && before !== after) return false;
  const lr = readLand();
  if ((after === 'provisional' || after === 'final') && lr.landEnd) return false;
  return lr.ticketSeen !== false;
}

/**
 * (2026-11-17, ⑦ the village screen) The person's own "read my village's record again": ONE read of the viewer's
 * record (/h/me) and ONE read of the province of the village in hand at the press — and nothing else. It is NOT
 * `refresh`: no prize read, no catch-up request (auto nudge), no march read (which can reveal and writes the march
 * book), no quota, conquest, chronicle or homes read, no automatic ticket; nothing is sent and nothing is saved.
 *   - the answer is adopted (applyMeResult, the one place a viewer's record is adopted) only when `plainMeAnswer`
 *     holds; an answer whose land stage differs is left whole to the regular load ('changed') — its bookkeeping is the
 *     regular load's; a failed read is NOT handed to applyMeResult (the values held and the wide inventory stay)
 *   - what an adoption still does besides memory: `refreshDelegation` may make its public agents read (at most every
 *     AGENTS_REFRESH_MS, while the key does not match) — a read, as in every regular load
 *   - whose answer: this press's own run object, the herald, local play, the wallet, the viewer key and the pinned
 *     world, all as at the press
 *   - against the regular load (corrected 2026-11-17: the first version let a refresh that began earlier go on with
 *     its own older record beside the holdings adopted here — two observations mixed): NOTHING is adopted while any
 *     refresh is under way ('yielded' — that refresh, from its own answer to its end, is the one observation), and
 *     an answer is let go without a word when a refresh began after the press and has ended. So a refresh never sees
 *     this adoption between its steps, and this adoption never stands under an older answer. refresh itself is
 *     unchanged but for the count; `viewerRefresh` is never moved here
 *   - which village: the one in hand at the press, by place, site AND generation (`holdingRef`); its province is read
 *     only if that same village is still among the holdings adopted — another village on the same place is not it
 *   - a press while one is under way starts nothing; the prototype rule's world (its own records ride on the regular
 *     load) and practice are not offered
 * `FS.villageReread = { state: 'loading'|'failed'|'changed'|'yielded'|'provinceFailed', code, key, ref, errAt, citAt }` is the note
 * for the screen (screens/holding.mjs holdingRead); null when there is nothing to say.
 */
export async function rereadVillage() {
  if (!herald || !FS.clock || !FS.wallet || FS.proto || FS.mode !== 'play') return false;
  if (FS.villageReread?.state === 'loading') return 'loading';
  const h0 = activeHolding(FS) ?? null;
  const run = { state: 'loading', code: null, key: h0 ? `${h0.p},${h0.q}` : null, ref: h0 ? holdingRef(h0) : null, errAt: null, citAt: null };
  const at = { herald, localPlay, address: FS.wallet.address, viewer: viewerKey(), world: providerWorld(), poll: viewerRefresh };
  const mine = () => FS.villageReread === run && herald === at.herald && localPlay === at.localPlay && FS.wallet?.address === at.address
    && viewerKey() === at.viewer && providerWorld() === at.world;
  // (the note is shown only while the viewer's record is the one it was said about: a later answer, good or failed,
  //  replaces FS.citizen or FS.meError and the note goes with it)
  const say = (state, code) => { run.state = state; run.code = code ?? null; run.errAt = FS.meError ?? null; run.citAt = FS.citizen ?? null; };
  FS.villageReread = run; invalidate('panel');
  let part = 'viewer';
  try {
    const me = await at.herald.me(at.viewer).catch(e => ({ ok: false, code: e?.code ?? 'Unavailable' }));
    if (!mine()) return false;
    if (pollsUnderWay > 0) { say('yielded'); return false; }
    if (viewerRefresh !== at.poll) { FS.villageReread = null; return false; }
    if (me.ok && !viewerOwnCitizen(me.citizen)) { say('failed', 'WrongKey'); return false; }
    if (!me.ok && me.code !== 'NotFound') { say('failed', me.code ?? 'Unavailable'); return false; }
    if (!plainMeAnswer(me)) { say('changed'); return false; }
    applyMeResult(me);
    part = 'province';
    const h = run.ref ? (FS.holdings ?? []).find(x => holdingRef(x) === run.ref) ?? null : null;
    if (h) {
      const got = await loadEnvelope(h.p, h.q, 'latest', mine);
      if (!mine()) return false;
      if (!got) { say('provinceFailed'); return 'partial'; }
    }
    FS.villageReread = null;
    return true;
  } catch (e) {
    console.error('frontier village reread:', e);
    if (mine()) say(part === 'viewer' ? 'failed' : 'provinceFailed', part === 'viewer' ? e?.code ?? 'Error' : null);
    return false;
  } finally {
    if (FS.villageReread === run && run.state === 'loading') FS.villageReread = null;
    invalidate('panel', 'tabs', 'chips', 'map');
  }
}

/** The conquest day files the records read back from today (a 14-day season in full). */
export const KEEP_EVENT_DAYS = 14;

/** Keep contests and captures of the season (/h/conquest/{day}.json): older days once, today's and yesterday's every refresh. */
async function refreshKeepEvents(cq, current) {
  if (!herald?.conquestDay) return;
  const bell = Math.max(0, Math.min(nowBell(), Number(FS.season.endBell ?? Infinity) - 1));
  const today = Math.floor(bell / BELLS_PER_DAY);
  const read = cq.eventDays ??= new Set();
  for (let d = Math.max(0, today - KEEP_EVENT_DAYS + 1); d <= today; d++) {
    if (read.has(d)) continue;
    const r = await herald.conquestDay(d).catch(() => null);
    if (!current()) return;
    if (!r?.ok) continue;
    cq.events = mergeKeepEvents(cq.events, r.day.events);
    // B18: the capture donor's return home (K-19), told as a notice by hud/feed.mjs
    cq.returns = mergeDonorReturns(cq.returns, r.day.events);
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
    // (2026-11-17, ⑦: and only while the world it was asked in is still pinned — FS.conquest is replaced at the next
    //  refreshConquest after a change, and until then this answer is not written into the former world's state)
    if (FS.conquest !== cq || (cq.world ?? null) !== providerWorld() || (!r.ok && r.code !== 'NotFound')) return;
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
  const args = { keeps: viewKeeps(cq.keeps), origins, home, faction: FS.citizen.faction, nowBell: FS.nowBell ?? 0, controlBell: cq.control.bell,
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
  const args = { keeps: viewKeeps(cq.keeps), origins, home: false, faction: FS.citizen.faction, nowBell: FS.nowBell ?? 0, controlBell: cq.control.bell,
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

/**
 * How many provinces of a control snapshot have a keep the page cannot place YET and that could matter to the reach
 * list: no keep of theirs is held from a province record, and their ring's village list (overview) is not read but
 * WILL be — the ring is one this world seeds (`ringSeeded`) — and the province is within a march's reach of an origin
 * (`origins`: the reach list's own, `[{p, q}]`; at most MAX_ROUTE_PROVINCES provinces away. No origin: not narrowed).
 * 0 once every such ring is read.
 * (PR #46 verification R1, 2026-11-18: the first version counted every unread ring. A sparse world never reads the
 *  rings it does not seed — map/overviews.mjs validRing; rings 0 and 1 of the natural world — so the count stood at 7
 *  for good and an empty list said "finding the keeps…" for ever, in place of "no keep within reach". A ring the world
 *  does not seed has nothing to wait for: it is not pending. Fail-safe: without `ringSeeded` no ring counts.)
 */
export function keepsPending(provinces, keeps, ringRead, ringSeeded = () => false, origins = [], faction = null, overviews = null) {
  const from = (origins ?? []).filter(o => Number.isInteger(o?.p) && Number.isInteger(o?.q));
  const near = c => from.length === 0 || from.some(o => hexDistance(o.p, o.q, c.p, c.q) <= MAX_ROUTE_PROVINCES);
  const nation = v => Number.isInteger(v) && v >= 0 && v <= 5;
  // (round 3: only a province whose keep could be a ROW of the list — fkeepreach.mjs contestableKeeps / defendableKeeps:
  //  held by another nation and not a heartland, or held by the viewer's nation and contested. The centre (control 6),
  //  an unheld province and a heartland can never be one, so nothing is waited for there. Without the viewer's nation
  //  the holder is not narrowed)
  const could = c => !nation(faction) || (nation(c.control) && (c.control !== faction ? !c.heartland : nation(c.contender) && c.contender !== faction));
  let n = 0;
  for (const c of provinces ?? []) {
    if (!Number.isInteger(c?.p) || !Number.isInteger(c?.q) || keeps.has(`${c.p},${c.q}`) || !could(c)) continue;
    const d = ringOf(c.p, c.q);
    if (ringSeeded(d) && !ringRead(d) && near(c)) n += 1;
  }
  // (round 3, seen live: the herald's latest control snapshot lags the turn by about three — control bell 6 at turn 9 —
  //  so a ring opened since (ring 4 of the natural world) has a keep in its overview, −2,4 with keep tile 18, before the
  //  snapshot covers its province: the keep is not in `keeps` (no holder known yet) and the list said "no keep within
  //  reach" for three turns although the runner had already named it reachable. A keep the page's overviews show in a
  //  province the snapshot does not cover yet is waited for, within reach; once the snapshot covers it, it is a row or
  //  it is not. Its holder is not known, so the holder rule cannot drop it.)
  const covered = new Set((provinces ?? []).map(c => `${c?.p},${c?.q}`));
  for (const ov of overviews?.values?.() ?? []) for (const o of ov?.provinces ?? []) {
    if (!Number.isInteger(o?.p) || !Number.isInteger(o?.q) || o.keepTile === null || o.keepTile === undefined) continue;
    const key = `${o.p},${o.q}`;
    if (!covered.has(key) && !keeps.has(key) && near(o)) n += 1;
  }
  return n;
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
/** The number of the last read of the S1 feeds that began (refreshS1): the read that began last is the one applied. */
let s1Ask = 0;
async function refreshS1(current, world, { caravanProvinces = true } = {}) {
  // (2026-11-17, ⑦: the feeds read in another pinned world — or another pinning of the same one — are not kept: a failure
  //  or NotFound here would otherwise leave that world's caravans, structures and nations standing as this one's)
  if (FS.s1 && (FS.s1.world ?? null) !== world) FS.s1 = undefined;
  const s1 = FS.s1 ??= { caravans: null, structures: null, nations: null, error: null, world };
  const names = ['caravans', 'structures', 'nations'];
  // (2026-11-17, ⑦ the trade card: a read belongs to its number — the person's own re-read (rereadS1) and the regular
  //  load may be under way together, and each applies three whole feeds: the one that BEGAN last is applied, an earlier
  //  one that answers later writes nothing. Regular loads among themselves were already so — refreshConquest's request.)
  const ask = ++s1Ask;
  const results = await Promise.allSettled(names.map(n => herald[n]()));
  if (!current()) return;
  if (ask !== s1Ask || FS.s1 !== s1) return;
  s1.error = null;
  // (how each feed's latest read went, for the card — the DATA kept is what it always was; only where it came from is
  //  marked: 'ok' (read now); 'missing' (the herald has no file and nothing was read before: the empty feed stands, as
  //  before); 'missingKept' (the herald has no file NOW, and a list read before is kept as it was — `??=` below never
  //  replaced it: that list is not this read's); 'failed' (keeps what was read before, or stays not read).
  //  `s1.fresh[n]`: the feed held is the empty one a NotFound stood up, not a list that was read.)
  s1.read = {};
  const fresh = s1.fresh ??= {};
  names.forEach((n, i) => {
    const r = results[i].status === 'fulfilled' ? results[i].value : null;
    if (r?.ok) { s1[n] = r[n]; fresh[n] = false; s1.read[n] = 'ok'; }
    else if (r?.code === 'NotFound') { const kept = s1[n] !== null && s1[n] !== undefined && fresh[n] !== true; s1[n] ??= s1Fresh(n); if (!kept) fresh[n] = true; s1.read[n] = kept ? 'missingKept' : 'missing'; }
    else { s1.error = L`隊商・構造物・国家の最新情報を取得できませんでした。`; s1.read[n] = 'failed'; }
  });
  // the Provinces the viewer's own caravans stand in: their slots say whether a raid holds one (map/s1marks heldByRaids)
  // (not from the person's own re-read — rereadS1 —, which reads the three feeds and nothing more: these province reads
  //  are the regular load's, with the map's own waits and places)
  // (TEST-ONLY, a coexist world: the ② Grants this viewer is party to, beside the S1 feeds; not awaited)
  if (rightsLaneOn()) refreshRights(current).catch(e => console.error('frontier rights:', e));
  if (rightsLaneOn()) refreshCustody(current).catch(e => console.error('frontier custody:', e));
  if (!caravanProvinces) return;
  const me = ownTag(FS);
  for (const c of s1.caravans?.moving ?? []) {
    if (me === null || me === undefined || BigInt(c.ownerTag) !== BigInt(me)) continue;
    for (const r of c.runs ?? []) wantProvince(r.p, r.q, () => invalidate('map'));
  }
}

/**
 * (2026-11-17, ⑦ the trade card) The person's own "read the lists again": the three S1 feeds (caravans and storehouses,
 * structures, nations) read once more through refreshS1 — and nothing else. (Corrected 2026-11-17: the first version
 * said so while refreshS1's end also asked the map's loader for the provinces of the viewer's own caravans; that part is
 * now the regular load's alone — `caravanProvinces: false` here. What this reads: herald.caravans, herald.structures,
 * herald.nations, once each. What it writes: FS.s1's three feeds, their read marks, FS.s1.error, FS.s1Reread.) It is NOT
 * refreshConquest (overviews, control, standings, the day files) and NOT refresh; nothing is sent or saved. The feeds are public: no viewer is
 * asked for. Whose answer: this press's own run, the herald and the pinned world as at the press; against the regular
 * load, the read that began last is applied (refreshS1's number). A press while one is under way starts nothing.
 * How it went is said by the feeds' own read marks (`FS.s1.read`); `FS.s1Reread = { state: 'loading'|'failed' }` only
 * says a read is under way, or that it could not be made at all.
 */
export async function rereadS1() {
  if (!herald || !s1On() || FS.mode !== 'play') return false;
  if (FS.s1Reread?.state === 'loading') return 'loading';
  const run = { state: 'loading' }, at = { herald, world: providerWorld() };
  const mine = () => FS.s1Reread === run && herald === at.herald && providerWorld() === at.world;
  FS.s1Reread = run; invalidate('panel');
  try { await refreshS1(mine, at.world, { caravanProvinces: false }); return mine(); }
  catch (e) { console.error('frontier s1 reread:', e); if (mine()) run.state = 'failed'; return false; }
  finally { if (FS.s1Reread === run && run.state === 'loading') FS.s1Reread = null; invalidate('panel', 'map'); }
}

/** The control / standings files last answered 404, with the bell, world and time of that answer (refreshConquest). */
const conquestMiss = { control: null, standings: null };
/**
 * (fix-loop12, LP12-2) In a fresh world's first turns — before its first control snapshot, while a 404 is expected
 * (`freshWorld` below, the same window that says 'loading') — a 404 is asked again after this long, not at the next turn.
 * loop-play12 and fix-loop12 (1×): the herald wrote the first snapshot 1 min into turn 2, the page had asked at the
 * turn's start and waited for turn 3 — 「届く砦を調べています…」 for ~9 more minutes. Past the window (a devnet season
 * with no snapshot for hours) the next-turn rule stands.
 */
const FRESH_MISS_RETRY_MS = 30_000;
export async function refreshConquest() {
  // (2026-11-17, ⑦: also in a world without conquest, what was read in another world is not kept: the feed, the sheet,
  //  the report and the S1 marks read FS.conquest and FS.s1 without asking whether conquest is on)
  dropOtherWorldConquest(providerWorld());
  if (!conquestEnabled(FS.season) || !herald?.control) return;
  const request=++conquestRefresh;
  // (2026-11-17, ⑦: a refresh belongs to its request and to the pinned world with its generation — fchainio.setPin: A → B →
  //  A are three. The herald object can stay the same across a re-pin, so the request number alone does not see it.
  //  What was read under another world — keeps, standings, the final, the day files read, the keep histories — is not
  //  this world's: FS.conquest starts again, as loading, and an answer the change overtakes writes nothing.)
  const world = providerWorld();
  const current = () => request === conquestRefresh && providerWorld() === world;
  if (FS.conquest && (FS.conquest.world ?? null) !== world) FS.conquest = undefined;
  const cq = FS.conquest ??= { status: 'loading', keeps: new Map(), standings: null, final: null, world };
  await refreshOverviews(nowBell());
  // (fix-devnet-join-wait, herald-load-50 F5: a control or standings file the herald does not have yet — 404: no bell
  //  complete over every opened province, no standings hour; on a fresh devnet season for hours — was asked again at
  //  every refresh, three times a minute per page. After a 404 it is asked again at the next bell, in the same world.)
  const bellNow = nowBell();
  const freshWorld = !cq.control && bellNow <= 1 + Math.ceil(Number(FS.season.revealWindow ?? 600) / Number(FS.season.bellSecs ?? 600));
  const missed = k => conquestMiss[k]?.world === world && conquestMiss[k].bell === bellNow && !(freshWorld && Date.now() - conquestMiss[k].at >= FRESH_MISS_RETRY_MS);
  const skipControl = missed('control'), skipStandings = missed('standings');
  const results = await Promise.allSettled([skipControl ? null : herald.control(), skipStandings ? null : herald.standings()]);
  if (!current()) return;
  const control = results[0].status === 'fulfilled' ? results[0].value : null;
  const standings = results[1].status === 'fulfilled' ? results[1].value : null;
  if (!skipControl) conquestMiss.control = control?.code === 'NotFound' ? { world, bell: bellNow, at: Date.now() } : null;
  if (!skipStandings) conquestMiss.standings = standings?.code === 'NotFound' ? { world, bell: bellNow, at: Date.now() } : null;
  // (not asked this time: what the last answer made of the page stays as it is)
  if (skipControl) { /* the status of the last answer stands */ }
  else if (control?.ok) {
    cq.control = control.control; applyControl(FS.overviews, cq.control);
    // (B9: a province of the control snapshot whose ring's village list the page has not read yet has a keep the page
    //  cannot place: counted, so that an empty reach list says it is still being worked out — screens/conquest.mjs
    //  reachLoading, hud/keephand.mjs — and not that no keep is within reach)
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
    { const w = FS.world ?? (FS.record ? worldOf(FS.record) : null);
      cq.keepsPending = keepsPending(cq.control.provinces, cq.keeps, d => FS.overviews.has(d) || overviewRefused(FS, d), d => !!w && ringSeeded(w, d), reachOrigins(FS).origins, FS.citizen?.faction ?? null, FS.overviews); }
    cq.status = 'ready'; cq.error = null;
  } else if (control?.code === 'NotFound' && nowBell() <= 1 + Math.ceil(Number(FS.season.revealWindow ?? 600) / Number(FS.season.bellSecs ?? 600)) && !cq.control) {
    // A fresh world has no completed control snapshot until its first bell settles.
    cq.status = 'loading'; cq.error = null;
  } else { cq.status = 'error'; cq.error = L`領土の最新情報を取得できませんでした。再取得してください。`; }
  if (standings?.ok) {
    const next = territoryStandings(standings.standings);
    if (next && next.bell >= (cq.standings?.bell ?? -1)) cq.standings = next;
  }
  if (s1On()) await refreshS1(current, world);
  // A control snapshot has a world bell, while a quiet province can have an
  // older resolvedNext. Read its actual keep after the summary: comparing
  // those different clocks would otherwise hide protection and disable it forever.
  const selected=FS.selected;
  if (selected) await loadEnvelope(selected.p,selected.q).catch(()=>null);
  // what was read so far is shown even when a newer refresh has started: a superseded one must not leave the panel waiting
  invalidate('map','panel','rail');
  if (!current()) return;
  if (selected) wantKeepHistory(selected.p, selected.q, () => invalidate('panel'));
  await refreshKeepEvents(cq, current);
  if (!current()) return;
  const s = FS.selected, pv = s && FS.provinces.get(`${s.p},${s.q}`)?.province;
  const site = pv && Number.isInteger(s.idx) ? pv.sites.indexOf(s.idx) : -1;
  cq.outpost = site >= 0 ? outpostOffer(FS,{p:s.p,q:s.q,site}) : null;
  if (nowBell() >= FS.season.endBell && !cq.final && herald.final) {
    const r = await herald.final();
    if (!current()) return;
    if (r.ok && Number(r.final.endBell) === FS.season.endBell && r.final.control?.bell === FS.season.endBell-1 && r.final.standings?.bell === FS.season.endBell-1) cq.final = territoryStandings(r.final.standings);
  }
  invalidate('map','panel','rail');
}

function needsHomeChoice() {
  if (!instantHomeEnabled(FS.season) || FS.holdings?.length || FS.meStatus === 'error') return false;
  if (!FS.citizen) return true;
  // (2026-11-18, ⑧ doc 31 §1-A: the heartland has no free first home for this nation — the village request instead
  //  (autoTicket; home.mjs heartlandFull). The reading stays as it is until the page is opened again.)
  if (heartlandFull(FS)) return false;
  return FS.land?.stage === 'joined' && !(FS.citizen.flags & (HOME_GRANTED | 4 | 16));
}

function updateHomeGrant() {
  if (!instantHomeEnabled(FS.season) || !(FS.citizen?.flags & HOME_GRANTED)) { FS.homeGrant = null; return; }
  const h = FS.holdings?.find(x => x.state === 2);
  if (!h) { FS.homeGrant = null; return; }
  const rec = readHome();
  if (rec.pending || rec.selected) saveHomePatch({ pending: null, selected: null });
  // B19: a village already in use is not welcomed again (local play keeps `seen` in the page's memory only, so a
  // reload or --resume forgot it); the note is written back so the rest of this page's life agrees
  if (rec.seen !== grantId(h) && !FS.homeGrant && villageInUse(h)) { saveHomePatch({ seen: grantId(h) }); FS.homeGrant = null; return; }
  if (rec.seen !== grantId(h)) {
    if (!sameHome(FS.homeGrant, h)) FS.homeFocus = h;
    FS.homeGrant = h; FS.tab = 'map';
  } else FS.homeGrant = null;
}

const wantedHomeFaction = () => { const f = FS.citizen?.faction ?? FS.joinDraft?.faction; return Number.isInteger(f) && f >= 0 && f < 6 ? f : null; };

/** Read a bounded set of actual free sites, without signing or claiming land. */
/**
 * (fix-loop6, LP6-12) The order in which first-village places are tried: this wallet's own (players spread out), except
 * for the TEST-ONLY contest pair of a local world (`localPlay.pair`, both roles): one order for the pair — its world's
 * Season — so two people of one nation start in the same province (loop-play6: 2 of 3 `--two` worlds put them on
 * opposite sides, and a caravan could not reach). The places themselves, and every rule of placing, are unchanged.
 */
export function homeSeed(fs = FS, identity = localPlay) {
  if ((identity?.pair === 'first' || identity?.pair === 'second') && typeof identity.seasonAddress === 'string') return `pair:${identity.seasonAddress}`;
  return fs.wallet?.address ?? 'visitor';
}
/** (verify-pr130, LP6-12) The pair role that shares homeSeed's order ('first' | 'second'), else null: home.mjs planHomes gives the two roles different sites. */
export function homePairRole(identity = localPlay) {
  return (identity?.pair === 'first' || identity?.pair === 'second') && typeof identity.seasonAddress === 'string' ? identity.pair : null;
}
export async function refreshHomes({ force = false } = {}) {
  if (!needsHomeChoice() || !herald) return;
  const old = FS.homeChoice ?? { candidates: [], selected: readHome().selected, rotation: 0 };
  const faction = wantedHomeFaction();
  if (old.busy || (!force && ((old.loading && old.faction === faction) || (old.loadedBell === nowBell() && old.faction === faction)))) return;
  // (2026-11-17, ⑦: the pinned world this reading began under — an answer the change of world overtakes writes nothing:
  //  the candidates are places of that world's map)
  const request = ++homesRefresh, world = providerWorld();
  // (`reading`: whose "loading" mark this is. Only this reading takes it off again, and only while it is still its own)
  FS.homeChoice = { ...old, faction, selected: old.selected?.faction === faction ? old.selected : null, loading: true, reading: request, error: null };
  // (corrected 2026-11-17: an answer is applied to the choice AS IT STANDS at the answer, never to the copy taken when the
  //  reading began — that copy put an older selection back and wiped the busy / pending / error of a join or placing
  //  begun meanwhile.
  //   - another reading began, or the world changed: nothing is written. A "loading" mark that is still this reading's
  //     own is taken off (nobody else will); a newer reading's mark is left alone.
  //   - no choice stands any more (another viewer): nothing.
  //   - a join / placing is under way (confirmHome writes busy, pending, error and the selection on the choice in
  //     hand): what was read is let go — confirmHome reads its own place again — and only this reading's mark goes.)
  const letGo = () => { const c = FS.homeChoice; if (c && c.reading === request) { c.loading = false; c.reading = null; invalidate('panel'); } };
  const standing = () => {
    if (request !== homesRefresh || providerWorld() !== world) { letGo(); return null; }
    const c = FS.homeChoice ?? null;
    if (!c || c.busy) { letGo(); return null; }
    return c;
  };
  invalidate('panel');
  try {
    if (force) FS.overviewsBell = undefined;
    await refreshOverviews(nowBell());
    // (the rings a first village may be placed in: the open rings, no further than the heartland: home.mjs homeRingsOpen)
    const result = await planHomes({ overviews: FS.overviews, faction, nowBell: nowBell(), place: homePlaceOf(FS), ringsOpen: homeRingsOf(FS, FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : 0),
      seed: `${homeSeed()}|${old.rotation ?? 0}`, rotation: old.rotation ?? 0, pair: homePairRole(),
      read: async (p, q) => { const env = await loadEnvelope(p, q); return env?.province ?? null; } });
    const cur = standing();
    if (!cur) return;
    // (a candidate the person picked on the map while this reading waited — home-pick writes it on the choice in hand —
    //  is theirs. Whether it is kept is decided as before: it must be among the candidates read)
    const picked = cur.selected ?? null;
    const selected = picked && (faction === null || picked.faction === faction) && result.candidates.some(h => sameHome(h, picked)) ? picked : faction !== null ? result.candidates[0] ?? null : null;
    // (an error a join / placing left on the choice meanwhile is the person's own action's: it is not cleared by a good
    //  reading, nor replaced by this reading's)
    FS.homeChoice = { ...cur, ...result, selected, faction, loadedBell: nowBell(), loading: false, reading: null,
      error: cur.error ?? (result.error ? { code: result.error, text: result.error === 'NoFreeHome' ? L`入植できる土地がまだ見つかりません。候補を更新してください。` : L`土地の情報を読み込めませんでした。もう一度お試しください。` } : null) };
  } catch (e) {
    const cur = standing();
    if (!cur) return;
    // (a failed reading changes the candidates and the selection of the choice in hand in nothing)
    FS.homeChoice = { ...cur, faction, loading: false, reading: null, error: cur.error ?? { code: e?.code ?? 'Unavailable', text: L`土地の情報を読み込めませんでした。もう一度お試しください。` } };
  }
  invalidate('panel', 'map');
}

/**
 * (2026-11-17, ⑦ the first village's place) The person's own "read the candidates again": the candidate places for the
 * first village read once more, in ANOTHER order — and nothing else. The messages of a failed or empty reading said
 * 「候補を更新してください」 and no control did it: pressing the confirm button again reads the SAME order again, and
 * `home-refresh` (called from nowhere) runs the ordinary `refresh` while the viewer's record fails — prize read, catch-up
 * request, march reading with its reveal and book, automatic ticket. This entry never calls `refresh`:
 *   - while the viewer's record fails, the pure read of it is tried first (rereadVillage: one /h/me read, adopted only
 *     when adopting saves nothing; for a viewer not joined yet that is "no Citizen"). Still failing → it stops and says so.
 *   - then the order number (`rotation`) moves, in memory, and refreshHomes reads: the ring overviews and the provinces
 *     planHomes asks for (herald reads; nothing is sent). The choice is not cleared and nothing is saved on the device;
 *     the candidate picked stays if it is among those read, as refreshHomes decides.
 *   - not while a join / placing is under way or a reading runs; not for another context than the one it was pressed
 *     in (viewer, herald, world).
 * What may be placed, joined, paid or signed is confirmHome's and is not touched.
 */
export async function rereadHomes() {
  if (!herald || FS.mode !== 'play' || !instantHomeEnabled(FS.season)) return false;
  const c0 = FS.homeChoice ?? null;
  if (c0?.busy || c0?.pending || c0?.loading || FS.inFlight > 0) return 'busy';
  const ctx = contextSeq;
  if (FS.meStatus === 'error') {
    await rereadVillage();
    if (ctx !== contextSeq) return false;
    if (FS.meStatus === 'error') { failed({ code: FS.meError?.code ?? 'Unavailable', text: L`あなたの記録をまだ読めていないので、土地の候補を読み直せませんでした。少し待って、もう一度お試しください。` }); return false; }
  }
  if (!needsHomeChoice()) return false;
  const c = FS.homeChoice ?? null;
  if (c?.busy || c?.pending || c?.loading) return 'busy';
  if (c) c.rotation = (c.rotation ?? 0) + 3;
  await refreshHomes({ force: true });
  return ctx === contextSeq && !FS.homeChoice?.error;
}

// fix-devnet-join-wait (herald-load-50 F3): the wait for the page's OWN record after a send the chain took (a Join, a
// rim village request, a PlaceHome). It was 5 reads 1 s apart; the herald shows a transaction only once it is
// FINALIZED (≈13 s on a real cluster, plus its poll and ingest), so on devnet the confirm stopped after the Join and
// the village request was never filed. Now (fown-wait.mjs): reads on a growing gap for up to OWN_WAIT_MS of wall
// time, a read that fails is not an answer, the card says what it waits for and for how long
// (`choice.ownWait = {what, secs}`, screens/join.mjs ownWaitLine), and a wait that ends without the record says so and
// offers to look again (error `retry: true`) — never a silent stop. Nothing is sent by the wait itself.
async function waitForOwn(predicate, { what = 'join', still = () => true } = {}) {
  const c = FS.homeChoice ?? null;
  const mark = secs => { if (c && FS.homeChoice === c) { c.ownWait = { what, secs }; invalidate('panel'); } };
  mark(0);
  try {
    const r = await waitForOwnRecord({ predicate, read: () => refresh(), still, progress: mark });
    if (!r.ok && c) c.ownWaited = r.secs;
    return r.ok;
  } finally { if (c && c.ownWait?.what === what) { c.ownWait = null; invalidate('panel'); } }
}
/** What a wait that ended without the record says (the card adds 「もう一度確かめる」: home-confirm, which sends nothing again). */
const OWN_WAIT_TIMEOUT = {
  join: secs => L`参加は受け付けられましたが、このページの読み取り先にまだ反映されていません（${fmtNum(secs)} 秒待ちました）。もう一度押しても重ねて参加はしません。「もう一度確かめる」を押すと確かめて、村の申し込みに進みます。`,
  ticket: secs => L`村の申し込みは受け付けられましたが、このページの読み取り先にまだ反映されていません（${fmtNum(secs)} 秒待ちました）。申し込みは重ねて送りません。「もう一度確かめる」で確かめます。`,
  home: secs => L`村の確定は受け付けられましたが、地図にまだ反映されていません（${fmtNum(secs)} 秒待ちました）。「もう一度確かめる」で確かめます。`,
};

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

/** Real milliseconds a press waits for a candidates reading already under way (then it reads itself). */
export const HOME_READ_WAIT_MS = 20_000;
// (fix-loop8, LP8-2: a press made while 「土地の候補を読み込んでいます…」 showed could end with nothing on the page — its
//  context moved during the wait (`contextSeq !== pressed`) and it returned silently; loop-play8 under load 12–31. The
//  press is now QUEUED instead: while the viewer, the world and the chosen nation are still those of the press and no
//  Citizen exists yet, it is made again by itself (at most HOME_CONFIRM_AGAIN times); otherwise the card says why it
//  stopped (FS.homeDropped, screens/join.mjs). A press is still of its own context: nothing is joined for another wallet.)
export const HOME_CONFIRM_AGAIN = 2;
let homeAgainLeft = HOME_CONFIRM_AGAIN, homeAgainNext = false;
export async function confirmHome() {
  // (a person's press starts with the whole budget; a press made again by itself carries what is left — pressAgain)
  const again = homeAgainNext ? homeAgainLeft : (homeAgainLeft = HOME_CONFIRM_AGAIN); homeAgainNext = false;
  if (!instantHomeEnabled(FS.season) || FS.homeChoice?.busy) return;
  // (fix-loop6, LP6-11 — B-8's real cause in the ×60 wide picker: a press made before the candidates were read started a
  //  FORCED reading; the next press, three seconds later, started another, which superseded the first, and the first
  //  press then found no selection and ended silently. Under load a reading outlasts the seconds between presses: 3–4
  //  presses. Now the press that waits says so on the button — FS.homeConfirmWait, screens/join.mjs — and a press
  //  meanwhile adds nothing; a reading already under way for this nation is waited for, not superseded)
  if (FS.homeConfirmWait) return;
  // (corrected 2026-11-17: the press is of the context it was made in — viewer, herald, world — and that is taken
  //  BEFORE the first wait. A candidates reading that outlasts a change of wallet or world leaves a choice of the page
  //  as it has become: this press does not go on with it.)
  const pressed = contextSeq;
  const faction = wantedHomeFaction();
  FS.homeDropped = null;
  const viewer0 = viewerKey() ?? null, world0 = providerWorld();
  const pressAgain = why => {
    if (again > 0 && (viewerKey() ?? null) === viewer0 && providerWorld() === world0 && !FS.citizen && wantedHomeFaction() === faction) { homeAgainLeft = again - 1; homeAgainNext = true; return confirmHome(); }
    if (!FS.citizen && (viewerKey() ?? null) === viewer0) { FS.homeDropped = { faction, why }; invalidate('panel'); }
  };
  const unread = () => !FS.homeChoice?.selected || (faction !== null && FS.homeChoice.selected.faction !== faction);
  if (unread()) {
    FS.homeConfirmWait = true; invalidate('panel');
    try {
      for (const until = Date.now() + HOME_READ_WAIT_MS; FS.homeChoice?.loading && FS.homeChoice.faction === faction && Date.now() < until && contextSeq === pressed;) await new Promise(r => setTimeout(r, 150));
      if (contextSeq === pressed && unread()) await refreshHomes({ force: true });
    } finally { FS.homeConfirmWait = false; invalidate('panel'); }
  }
  if (contextSeq !== pressed) return pressAgain('context');
  // (2026-11-18, ⑧ doc 31 §1-A: a visitor whose chosen nation has no free first home (the reading said NoFreeHome for
  //  that nation) is not left at a button that does nothing: this press joins the nation — Join and the in-game key,
  //  the same two steps as below, and no PlaceHome — and the village request (autoTicket) takes it from there. Only
  //  for a wallet that has not joined, and never in local play, whose relay step serves no FileTicket.)
  const requestInstead = !FS.homeChoice?.selected && !FS.citizen && !FS.resident && !localPlay && noFreeHome(FS.homeChoice, faction);
  // (the "no free first home" reading that press is made on: it is what the page shows next, so it is kept)
  const reading = requestInstead ? FS.homeChoice.error : null;
  if (requestInstead) { if (FS.homeChoice.busy) return; }
  else if (FS.homeChoice?.busy) return;
  // (fix-loop8, LP8-2: no candidate read for the press even after its wait and its own reading — queued again, or said)
  else if (!FS.homeChoice?.selected) return FS.homeChoice?.error ? undefined : pressAgain('unread');
  // (2026-11-17, ⑦: THIS confirm — the choice it was pressed on (the object), the context number of that moment
  //  (viewer, herald, world: nextContext), the world, and where that viewer's home record is kept.
  //   - what it shows (pending, error, the selection let go) is written on ITS choice, and only while that choice is
  //     the one standing and the context is the one it began in (`mine`). After another wallet, NFT, herald or world,
  //     it shows nothing and starts no further step: no Join, no key, no PlaceHome, no note cleared.
  //   - what it SENT is another matter: the note of a sent Join / PlaceHome is saved in the record taken here
  //     (`run.note`) whatever the page has become — see saveHomePatch just below.
  //   - at its end it lets go of its own busy mark only; a newer choice's is not its to take off.)
  const run = { choice: FS.homeChoice, ctx: pressed, note: homeNoteNow(), sent: new Set() };
  run.choice.busy = true; run.choice.error = null;
  if (reading) run.choice.error = reading;
  const mine = () => FS.homeChoice === run.choice && contextSeq === run.ctx;
  const pending = p => { if (!mine()) return; run.choice.pending = p; invalidate('panel'); };
  const error = (code, text, more = null) => { if (!mine()) return; run.choice.error = { code, text, ...(more ?? {}) }; invalidate('panel'); };
  // (fix-devnet-join-wait: the record of what was sent has not shown yet — said with how long the page waited, and the
  //  card offers to look again; that press finds the note of the send and asks about it, it never sends it again)
  const notShown = what => error('PendingHome', OWN_WAIT_TIMEOUT[what](run.choice.ownWaited ?? 0), { retry: true, waited: what });
  // (a rim village request this confirm, or an earlier one, filed and the herald shows: its ticket, or the village)
  const ticketShown = () => FS.land?.stage === 'ticket' || (FS.holdings ?? []).length > 0;
  // (within this confirm every save goes to the record taken at its start. A note WITH a signature — a transaction
  //  left this browser — is always saved, there. Anything else (the note cleared, the selection) is saved only while
  //  the confirm is still its own: what the page reads after a change is not this viewer's.)
  const saveHomePatch = patch => {
    if (typeof patch?.pending?.signature === 'string') { run.sent.add(patch.pending.signature); return saveHomeAt(run.note, patch); }
    return mine() ? saveHomeAt(run.note, patch) : null;
  };
  try {
    if (!FS.wallet) {
      const i = (FS.walletList ?? []).findIndex(w => !w.why);
      if (i < 0) return error('NoWallet', L`参加に使うウォレットを接続してください。`);
      pending('connecting'); await ACTIONS.connect({ i: String(i) });
      // (corrected 2026-11-17, fail closed: a press made with NO wallet ends here, whatever the connect did. The
      //  connect hands back nothing that says which wallet it connected — what the page holds afterwards (a name, an
      //  address, how often the context moved) cannot tell this connect's wallet from another that connected at the
      //  same moment — and the visitor's choice went with the visitor (resetViewer). So nothing is joined or placed on
      //  this press: the wallet stays connected, the page shows that wallet's own state, and the person presses
      //  again there. That press begins with a wallet and is its own.)
      return;
    }
    if (FS.meStatus !== 'ready') { await refresh(); if (FS.meStatus !== 'ready') return; }
    if (!mine()) return;
    const saved = readHome();
    if (saved.pending && playLane()) {
      // LOCAL PLAY: the note is of a page-signed Join or PlaceHome. It is asked about as every local order is — ONCE, at
      // the relay of this scope (wallet, world, relay), only while the page is still that scope (flocalplay-act.mjs
      // `recheckLocalPending`) — never through the ordinary tracker. The note is cleared ONLY on the chain's own word
      // (landed, or refused); an unknown outcome keeps it and nothing is sent in its place; if the page became another
      // scope meanwhile, nothing is shown and nothing is touched.
      pending('confirming');
      const pl = playLane(), g = pl.gate(), lscope = g?.ok ? localAct.localActScope({ identity: pl.identity, relay: g.relay }) : null;
      if (lscope === null) return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
      const still = () => localActScopeNow() === lscope;
      // (the note says which scope — which relay too — its transaction was sent under: asked only when that is the
      //  page's scope now. A note of another relay, wallet or world is neither asked about nor cleared: it stays.)
      const s = await localAct.recheckLocalPending(localActLedger, lscope, saved.pending, { origin: g.relay, still, lane: pl.lane });
      if (s.state === 'left' || !still()) return;
      if (s.state === 'other-scope') return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
      await refresh();
      if (!still()) return;
      if (FS.homeGrant) return;
      if (!mine()) return;
      // (fix-devnet-join-wait: the chain says the noted send LANDED and the herald does not show it yet — its finalized
      //  lag: the page waits for it here, as right after the send, instead of stopping at once)
      if (s.state === 'landed') {
        const k = saved.pending.kind;
        const shown = k === 'Join' ? () => !!FS.citizen : k === 'FileTicket' ? ticketShown : () => !!FS.homeGrant;
        if (!shown()) {
          pending(k === 'FileTicket' ? 'ticket' : 'confirming');
          if (!await waitForOwn(shown, { what: k === 'Join' ? 'join' : k === 'FileTicket' ? 'ticket' : 'home', still: () => still() && mine() })) return notShown(k === 'Join' ? 'join' : k === 'FileTicket' ? 'ticket' : 'home');
          if (!still() || !mine()) return;
          if (FS.homeGrant) return;
        }
      }
      // The note is cleared by what the page now SEES of this wallet in this world (its Citizen exists: the Join is
      // done — also when the relay no longer knows the signature, or the order was already let go), or by the chain's
      // own refusal. An unknown outcome with nothing to see keeps it; nothing is sent in its place.
      // (a rim village request: the herald shows its ticket or the village — the request's own view takes it from here)
      if (saved.pending.kind === 'FileTicket' && ticketShown()) { saveHomePatch({ pending: null }); return; }
      if (saved.pending.kind === 'Join' && FS.citizen) saveHomePatch({ pending: null });
      else if (s.state === 'failed') saveHomePatch({ pending: null });
      else return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
    } else if (saved.pending) {
      pending('confirming');
      const tracked = await tx.track(saved.pending.signature);
      await refresh();
      if (FS.homeGrant) return;
      // (fix-devnet-join-wait: landed and not shown yet — the herald's finalized lag — is waited for, as above)
      if (tracked.ok && saved.pending.kind === 'Join' && !FS.citizen) {
        if (!await waitForOwn(() => !!FS.citizen, { what: 'join', still: mine })) return notShown('join');
        if (!mine()) return;
      } else if (tracked.ok && saved.pending.kind === 'PlaceHome') {
        if (!await waitForOwn(() => !!FS.homeGrant, { what: 'home', still: mine })) return notShown('home');
        return;
      }
      if (saved.pending.kind === 'Join' && FS.citizen) saveHomePatch({ pending: null });
      else if (!tracked.ok && ['failed', 'expired'].includes(tracked.state)) saveHomePatch({ pending: null });
      else return error('PendingHome', L`参加の結果を確認しています。土地を重ねて申請せず、しばらくしてから再確認してください。`);
    }
    // (the re-check above read the page as it is now: its outcome is this confirm's only while the confirm is its own —
    //  the note is not cleared otherwise, see saveHomePatch — and nothing further is done)
    if (!mine()) return;
    let site = run.choice.selected;
    // (⑧ doc 31 §1-A, request instead: there is no place, only the nation — nothing to check, nothing to remember)
    if (requestInstead) site = { faction };
    else {
      if (FS.citizen && FS.citizen.faction !== site.faction) {
        run.choice.selected = null;
        return error('WrongFaction', L`参加済みの国の土地を選んでください。`);
      }
      const env = await loadEnvelope(site.p, site.q);
      if (!mine()) return;
      if (!homeSites(env?.province, { faction: site.faction, nowBell: nowBell(), ringsOpen: homeRingsOf(FS, FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : 0), place: homePlaceOf(FS) }).some(s => sameHome(s, site))) {
        run.choice.selected = null; saveHomePatch({ selected: null });
        return error('SiteUnavailable', L`この土地は現在選べません。候補を更新して別の土地を選んでください。`);
      }
      saveHomePatch({ selected: site });
    }
    if (!FS.citizen) {
      pending('joining');
      if (FS.resident) {
        // ⑳: an NFT's Citizen is made by its first login (nft-login: JoinResident), never by the wallet Join; it is
        // on its way from the herald
        if (!await waitForOwn(() => !!FS.citizen, { what: 'join', still: mine })) return notShown('join');
        if (!mine()) return;
      } else {
        FS.joinDraft = { ...(FS.joinDraft ?? {}), faction: site.faction };
        homeJoinStill = mine;
        const joined = await ACTIONS.join();
        if (!joined?.ok || !mine()) return;
        if (!await waitForOwn(() => !!FS.citizen, { what: 'join', still: mine })) return notShown('join');
        if (!mine()) return;
        saveHomePatch({ pending: null });
      }
      if (FS.citizen.faction !== site.faction) { run.choice.selected = null; return error('WrongFaction', L`参加済みの国の土地を選んでください。`); }
    }
    if (FS.holdings?.length) { updateHomeGrant(); return; }
    // ⑳: an NFT Citizen has no in-game key (its owner's wallet signs the PlaceHome, for the pass's current
    // generation): the key step is a wallet Citizen's. (Found in the integration: the page asked the wallet for a key
    // the program refuses to register for an NFT Citizen, SetSession → NftNoSession, and the village was never placed)
    // (local play: no in-game key at all — the memory-only wallet signs the PlaceHome itself; SetSession is never asked)
    // (devnet play: none either — the connected wallet is the Join's session key and signs every command itself)
    if (!localPlay && !devnetPlay && !FS.resident && (!FS.session || FS.sessionProblem)) {
      await ACTIONS.session(); await refresh();
      if (!mine() || !FS.session || FS.sessionProblem) return;
    }
    // (⑧ doc 31 §1-A, request instead: joined, with its key, and no PlaceHome — the heartland has no place. The reading
    //  this press was made on still stands, so the request's wait view is shown, not the planner; the request itself is
    //  filed by autoTicket, here and at every poll)
    if (requestInstead) {
      if (heartlandFull(FS)) { run.choice.busy = false; run.choice.pending = null; autoTicket().catch(e => console.error('frontier auto ticket:', e)); }
      return;
    }
    pending('placing');
    // (TEST-ONLY wide play, local wide-land worlds: a first village past the heartland — a settled rim province — is a
    //  one-site village REQUEST (FileTicket), because the program's PlaceHome names no province past the Season's base
    //  r_max (16) even on a grown map; the world's runner settles it on the bell's beacon at the turn's end)
    // (and a wide devnet season, devnet gap P1: an opened rim province of the player's nation, settled by keeper A's
    //  `tickets` role on the bell's beacon)
    if (wideHomes() && ringOf(site.p, site.q) > Number(FS.season?.conquestParams?.heartlandMaxRing ?? 3)) {
      const one = [{ p: site.p, q: site.q, site: site.site }];
      const filed = await act('FileTicket', { v: { sites: one }, fields: { sites: one }, label: () => L`辺境の村を申し込んでいます…`, say: () => L`辺境の村を申し込みました。ターンの終わりに決まります。`,
        // (fix-devnet-join-wait: the request is noted as the Join and PlaceHome are — a press after a reload or after a
        //  wait that ended asks about THIS signature and never files a second request while it may have landed)
        onSent: (r, sentUnder) => saveHomePatch({ pending: { kind: 'FileTicket', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }),
        onLost: () => dropHomeNote(run.note, run.sent) });
      if (!mine()) return;
      if (!filed?.ok) { await refresh(); if (mine()) error(filed?.code ?? FS.notice?.code ?? 'PlaceFailed', L`村の申し込みを送れませんでした。候補を更新してください。`); return; }
      // (fix-loop6, LP6-9: a rim ticket is settled by the world's runner at a turn's end; under load that took ~60 turns
      //  in loop-play6 with only 「村の受け取りを確認しています…」 on the card. The card now says the ticket's turn and how
      //  many turns have gone by: screens/join.mjs renderInstantPlacing, pending 'ticket')
      if (mine()) run.choice.ticketBell = nowBell();
      pending('ticket');
      // (fix-devnet-join-wait: waited for until the herald shows the REQUEST — its ticket, or already the village —, not
      //  only the village: the request is settled at the turn's end, which the ticket's own view shows from there)
      if (!await waitForOwn(ticketShown, { what: 'ticket', still: mine })) return notShown('ticket');
      if (mine() && ticketShown()) saveHomePatch({ pending: null });
      return;
    }
    const placed = await act('PlaceHome', { v: { holding: site, faction: FS.citizen.faction }, fields: { p: site.p, q: site.q, site: site.site },
      label: () => L`あなたの村を確定しています…`,
      // (local play: the note also carries the scope the PlaceHome was SENT under — wallet, world and relay — given by
      //  the local send step; outside local play no scope is given and the note is what it always was)
      onSent: (r, sentUnder) => saveHomePatch({ pending: { kind: 'PlaceHome', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }),
      // (the chain's own word that it did not land: the note goes, in the record it was written in, if it is still this send's)
      onLost: () => dropHomeNote(run.note, run.sent) });
    if (!mine()) return;
    if (!placed?.ok) { await refresh(); if (mine() && !FS.homeGrant) error(placed?.code ?? FS.notice?.code ?? 'PlaceFailed', L`土地の確定を確認できませんでした。再確認するか、候補を更新してください。`); return; }
    pending('confirming');
    if (!await waitForOwn(() => !!FS.homeGrant, { what: 'home', still: mine })) notShown('home');
  } catch (e) { error(e?.code ?? 'Unavailable', L`参加を完了できませんでした。接続を確認して再試行してください。`); }
  finally {
    run.choice.busy = false; run.choice.pending = null;
    // (a choice kept across a change of world only because this confirm was under way — adoptPinnedWorld — is let go
    //  with it: its candidates are places of the world that was pinned)
    if (FS.homeChoice === run.choice && contextSeq !== run.ctx) FS.homeChoice = null;
    invalidate('panel', 'tabs', 'map');
  }
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
    const plan = await planTicket({ overviews: FS.overviews ?? new Map(), place: seasonPlace(FS.season), faction: FS.citizen.faction, ringsOpen: FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : 1,
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
// (2026-11-17, ⑦: a refresh, its cache and its completion are for one herald AND one pinned world with its generation —
//  fchainio.setPin: A → B → A are three; the herald object can stay the same when the world is pinned again. A season
//  answer the change overtakes is not applied (record, extent, rings, FS.season), the shared queue is told the world
//  (`source`) so it stores no overview for another, and a bell is marked complete only for the world it was read in.)
let overviewRefresh = null, overviewSource = null, overviewWorld = null;
function refreshOverviews(b) {
  const w = providerWorld();
  if (overviewRefresh?.bell === b && overviewRefresh.herald === herald && overviewRefresh.world === w) return overviewRefresh.promise;
  if (FS.overviewsBell === b && overviewSource === herald && overviewWorld === w) return Promise.resolve();
  const request = { bell: b, herald, world: w, promise: null };
  const same = () => herald === request.herald && providerWorld() === request.world;
  overviewRefresh = request;
  request.promise = (async () => {
    try {
      try {
        const seq = askSeason();
        const r = await request.herald.season();
        if (!same()) return;
        // A later bell's read owns the season record; the older caller joins it.
        if (overviewRefresh !== request) return overviewRefresh?.promise;
        // The record, the world's extent and the ring lists move together. Setting
        // FS.record alone left FS.world behind the ticket planner's latest read.
        // (2026-11-17, ⑦: only a record of the pinned world, and only when no answer asked later was applied — askSeason.
        //  Checked, set and recorded without a wait in between; recorded only once set: a throw while applying is caught
        //  below, keeps the last record as before, and records nothing.)
        if (r?.ok && r.record && recordOfPin(r.record) && !seasonStale(seq)) {
          applySeasonRecord(FS, r.record, { herald, onRings: () => invalidate('map', 'panel') });
          if (r.season) FS.season = r.season;
          takeSeason(seq);
        }
      } catch { /* keep the last record */ }
      if (!same()) return;
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
      const results = await readOverviews(FS, { herald, rings, v2: conquestEnabled(FS.season), source: providerWorld,
        onChange: () => invalidate('map', 'panel'),
      });
      if (!same()) return;
      if (overviewRefresh !== request) return overviewRefresh?.promise;
      // A partial/failed read remains retryable; a superseded caller cannot mark
      // the replacement client's or newer bell's refresh complete.
      if (results.every(Boolean)) {
        FS.overviewsBell = b;
        overviewSource = herald;
        overviewWorld = request.world;
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
  try { FS.kernel = await loadKernel({ ruleset: kernelRulesetFor(Buffer2hex(FS.season.rulesetHash)), url: new URL(`./wasm/${kernelFile(FS.season)}`, import.meta.url) }); FS.kernelError = null; } catch (e) { FS.kernelError = e.code ?? 'NoWasm'; FS.kernel = null; }
  return FS.kernel;
}

async function setDestination(dest) {
  const c = FS.compose;
  if (!c) return;
  c.dest = dest; c.route = null; c.routeError = null; c.routeUnread = false; c.earliest = null; c.moved = null;
  // (B14, loop-play3: a place that is not open land — the centre of a season with the centre, land not open yet — is no
  //  destination: the program's Reveal needs its Province. Said at once, no route is asked for and nothing is sealed)
  if (destOpenOf(FS, dest) === false) { c.routeError = 'DestinationNotOpen'; invalidate('panel'); return; }
  invalidate('panel');
  const k = await kernelOrNull();
  // (2026-11-17, ⑦: the rules module may come after the person put the draft away, started another, or chose another
  //  place: the route written is the one of the place the draft names now, and nothing is written to a draft let go)
  if (FS.compose !== c || c.dest !== dest) return;
  // (2026-11-17, ⑦ the march card: `routeUnread` — the route was NOT read: the rules module could not be had, or working
  //  the route out threw. That is not the world's answer "no route" (a refusal code with routeUnread false) and not a
  //  search still under way: the card says so, keeps the place and every setting of the draft, and offers to ask again
  //  — ACTIONS['dest-retry']. A throw left the draft with neither route nor error: 「道のりを探しています…」 for good.)
  if (!k) { c.routeError = FS.kernelError ?? 'NoKernel'; c.routeUnread = true; invalidate('panel'); return; }
  try {
    const seeds = (FS.record?.rings ?? []).map(r => ({ ring: r.d, seed: r.seed }));
    const r = planRoute(k, { from: { p: c.origin.p, q: c.origin.q, tile: c.host.tile }, to: dest, unit: c.host.unit, seeds, blocked: palisadeHexes(FS) });
    if (!r.ok) { c.routeError = r.code; invalidate('panel'); return; }
    // (the route, the earliest turn and the arrival turn are worked out first and set together: a throw between them
    //  no longer leaves a route beside an arrival turn that was not made from it)
    // (world goal ② roads, Q-RI-1 (a): a host leaving a village that has roads marches 5 % faster — the route's secs
    //  carry it, so every later earliest turn of this draft, and its send's, is the same one)
    const route = withRoads(r.route, holdingTechs(c.holding ? holdingByRef(FS.holdings, c.holding) : activeHolding(FS), FS.citizen?.faction ?? c.host?.faction));
    const earliest = earliestBell(k, { genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: route.secs });
    const arrive = arrivalWindow(FS.season, nowBell(), earliest).min;
    c.route = route; c.earliest = earliest; c.arriveBell = arrive;
    checkRouteOpen(c, dest, r.route);
  } catch (e) {
    console.error('frontier route:', e);
    c.route = null; c.routeError = e?.code ?? 'Error'; c.routeUnread = true;
  }
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
    // (verify-pr117: under the local fog, a camp only where its tile has been surveyed — last-known terrain is the
    //  viewer's —: the page reads whole provinces it has never seen, and their camps were listed as 「近くの行き先」)
    if (camp?.state === 1 && viewTile(env.province.p, env.province.q, camp.tile, 2)) out.push({ kind: 'camp', p: env.province.p, q: env.province.q, tile: camp.tile });
  }
  for (const h of FS.holdings ?? []) out.push({ kind: 'holding', p: h.p, q: h.q, tile: h.tile });
  return out;
}

// TEST-ONLY local play, the ordinary march's test entry only: "press now, send when ready" (flocalplay-pending.mjs).
// One press arms ONE pending send of the exact composed order; it is sent once, by sendTheMarch below, the first moment
// every check passes — or withdrawn (told) when anything of the order changes, the gate closes, the key is gone, the world's
// end comes, the page is hidden for good, an earlier outcome is unknown, its turns run out, another problem appears, or the
// player cancels. Memory only: a reload never revives it.
const localMarchTrial = () => !!localPlay && localPlay.march?.trialEntry === true && FS.localMarch?.open === true && Number.isFinite(localPlay.worldEndsAt);
// (devnet-page-war-2) DEVNET PLAY, the ordinary march: the same "press now, send when ready" — on a devnet season the page's
// read of the home province (the herald's fold) lags the chain in real time, and 封をして出発する stood disabled while it did
// (devnet-page-war §6.5). On a verified devnet page with the connected wallet, a press while ONLY the province's settling
// blocks the order (NotResident / NotFinal, the page's own read) arms ONE waiting send of that exact order: the page reads
// the origin province again (one read at a time, at most every DEVNET_WAIT_REFRESH_MS) and sends once — the wallet is asked
// to sign then — the first moment every check passes, or withdraws and says why. Nothing is signed or sent while it waits.
export const DEVNET_WAIT_REFRESH_MS = 5_000;
const devnetMarchWait = () => !localPlay && !!devnetPlay && devnetGate().ok === true;
/** Whether the march card offers the waiting send: local play's test entry, or a verified devnet page with its wallet. */
const marchWaitOn = () => localMarchTrial() || devnetMarchWait();
/** The devnet season's end on this machine's clock (ms), as the waiting send's `endsAt`; NaN when the clock is unknown. */
function devnetEndsAt() {
  const end = Number(FS.season?.endBell), g = FS.clock?.genesisTs;
  if (!Number.isFinite(end) || !Number.isFinite(g)) return NaN;
  return Date.now() + (bellStart(g, end) - now()) * 1000;
}
/** An earlier devnet march of this host whose outcome is unknown (held by its signature). */
const devnetHeldNow = card => (devnetMarchSender ? devnetMarchSender.sender.held(card.host?.id ?? null).length > 0 : false);
let devnetWaitRead = -Infinity;
function marchNow(c) {
  const h = c.holding ? holdingByRef(FS.holdings, c.holding) : activeHolding(FS);
  const m = composerMarch(FS, composerArrival(FS));
  const problems = checkMarch(m).filter(p => p !== 'NoDestination');
  // (devnet-page-war-2: a devnet page's "world" is its verified devnet Season — the relay and the Season id it read)
  const world = localPlay ? localPlay.march?.instance ?? null : devnetPlay ? `devnet:${devnetPlay.relay}:${devnetPlay.seasonId}` : null;
  const intent = pendingIntentOf({ world, wallet: FS.wallet?.address ?? null, holding: h, host: c.host, origin: c.origin, m });
  return { problems, intent };
}
/**
 * loop-play4 B-2: the waiting send's notice while the province is `lag` turns behind (null: the wait was only extended).
 * A lag of PENDING_LAG_TURNS or more is the world's keeper falling behind — on a local world, the machine's load — and the
 * page keeps waiting on its own; nothing to press again.
 */
export function lagWaitText(lag, untilBell, kind, { devnet = false } = {}) {
  const what = kind === 'muster' ? L`この編成` : L`この命令`;
  // (devnet-page-war-2: on devnet the lag is the keeper's and the herald's, in real time — not this machine's load)
  if (devnet && Number.isInteger(lag) && lag >= PENDING_LAG_TURNS) return L`この州の決着の読み取りが ${fmtNum(lag)} ターン遅れています（世界の進行とこのページの読み取り先が追いつくのを待っています）。送信待ちはそのまま続け、州が追いつき次第${what}を1回だけ送ります。そのときウォレットが署名を求めます。押し直す必要はありません（取り消せます）。`;
  if (Number.isInteger(lag) && lag >= PENDING_LAG_TURNS) return L`この州の決着が ${fmtNum(lag)} ターン遅れています。このマシンの負荷が高く、世界の進行（ターンの決着）が追いついていないためです。送信待ちはそのまま続け、州が追いつき次第${what}を1回だけ送ります。押し直す必要はありません（取り消せます）。`;
  return L`送信待ちを続けています。州のターンの決着がまだつかないため、待つ期限をターン ${fmtNum(untilBell)} まで延ばしました。決着がつき次第${what}を1回だけ送ります（取り消せます）。`;
}
const PENDING_WITHDRAWN = {
  cancel: () => L`送信待ちを取り消しました。命令は送られていません。`,
  changed: () => L`送信待ちを取り消しました。命令の内容（到着ターンなど）が変わったためです。命令は送られていません。確かめてから、もう一度押してください。`,
  expired: () => L`送信待ちを取り消しました。期限のターンまでに送れませんでした。命令は送られていません。`,
  closed: () => L`送信待ちを取り消しました。この世界の進軍はいま送れません。命令は送られていません。`,
  unknown: () => L`送信待ちを取り消しました。前に送った命令の結果がまだわからないためです。送り直しはしません。`,
  problem: () => L`送信待ちを取り消しました。ターンの決着のほかに、送れない理由があります。命令は送られていません。`,
};
const heldNow = card => (localMarchSender ? localMarchSender.held(card.host?.id ?? null).length > 0 : false);
// (the driver: flocalplay-pending.mjs createPendingDriver — its look, its ONE read-only origin read at a time while armed,
//  the ordinary single send, and the page being hidden for good; a read that answers after a cancel never sends)
const pendingDriver = createPendingDriver({
  look: card => {
    const same = FS.compose === card, now = same ? marchNow(card) : { problems: null, intent: null };
    // (verify-pr98 BREAK-1: the origin province's settling against the chain's turn now, not the model's possibly older one)
    const origin = FS.provinces.get(`${card.origin?.p},${card.origin?.q}`)?.province ?? null;
    // (devnet-page-war-2: on a devnet page the march's gate is the devnet lane's — the verified season and the connected
    //  wallet the page shows —, the key is that wallet, and the world's end is the Season's)
    const dn = !localPlay && devnetMarchWait();
    return { ...now, problems: settleNow(now.problems, origin, nowBell()), nowBell: nowBell(), open: localPlay ? FS.localMarch?.open === true : dn, held: localPlay ? heldNow(card) : devnetHeldNow(card), busy: !!card.sending || FS.inFlight > 0 || marchNearEnd(), sameCard: same,
      keyAlive: localPlay ? !!FS.wallet?.address && FS.wallet.destroyed !== true : dn, endsAt: localPlay ? localPlay.worldEndsAt ?? NaN : devnetEndsAt(),
      // B20: the arrival turn the card's own clock moved to (composeTick), never a turn the player picked
      follow: same && Number.isInteger(card.moved?.to) ? card.moved.to : null,
      // loop-play4 B-2: how far the origin province is behind (the keeper under machine load)
      lag: provinceLag(FS.provinces.get(`${card.origin?.p},${card.origin?.q}`)?.province, nowBell()) };
  },
  // (the read is applied only while this page still reads the same herald for the same world with the same live key and the
  //  same armed card; otherwise its answer is dropped before it touches anything. A page's world never changes — startPlay
  //  sets the herald and the local-play identity once — this check holds that even so)
  refresh: card => {
    // (devnet-page-war-2: a devnet page reads the herald over the network, in real time: at most every DEVNET_WAIT_REFRESH_MS)
    if (!localPlay) { const t = Date.now(); if (t - devnetWaitRead < DEVNET_WAIT_REFRESH_MS) return Promise.resolve(); devnetWaitRead = t; }
    const h0 = herald, lp0 = localPlay, w0 = FS.wallet?.address ?? null;
    const still = () => herald === h0 && localPlay === lp0 && (FS.wallet?.address ?? null) === w0 && FS.wallet?.destroyed !== true && pendingDriver.armed === card;
    return loadEnvelope(card.origin.p, card.origin.q, 'latest', still).then(e => { if (e) { FS.nowBell = nowBell(); invalidate('panel'); } });
  },
  // (verify-pr98 BREAK-1: a refusal of this send names the march and its "try again" sends the march — never the player's
  //  earlier act, which FS.lastAct still held: the wait's own press is not one of app.mjs SENDS)
  send: card => { card.pending = null; FS.lastAct = { kind: 'act', name: 'march-send', data: {} }; return sendTheMarch(); },
  withdrawn: (card, why) => { card.pending = null; if (PENDING_WITHDRAWN[why]) setNotice({ busy: false, text: PENDING_WITHDRAWN[why](), unsent: 'march-send', retry: false }); else invalidate('panel'); },
  // B20 (loop-play3): the turn passed before the province settled and the arrival turn moved on with it. The waiting
  // send is kept for the same order at the new arrival turn, and the player is told (nothing is changed silently)
  // loop-play4 B-2: the province is turns behind (the world's keeper under machine load): said, and the wait goes on
  lagging: (card, p, lag) => { card.pending = p; setNotice({ busy: false, waiting: true, text: lagWaitText(lag, p.untilBell, 'march', { devnet: !localPlay }) }); },
  followed: (card, p, moved) => { card.pending = p; setNotice({ busy: false, waiting: true, text: L`時間が進んだため、到着はターン ${fmtNum(moved.to)} になりました（さきほどまではターン ${fmtNum(moved.from)}）。送信待ちは続けています。州のターンの決着がつき次第、この到着ターンで1回だけ送ります（ターン ${fmtNum(p.untilBell)} まで。取り消せます）。` }); },
  onPageHide: f => { globalThis.addEventListener?.('pagehide', f); return () => globalThis.removeEventListener?.('pagehide', f); },
});
// TEST-ONLY local play, the march's test entry: while an order is composed, or the village's muster or forts card is open,
// the province it waits on is read again (read only) every LOCAL_SYNC_MS, one read at a time, so the page sees the turn
// finish when it does. At ×60 the ordinary 5 s read left the page seconds behind a 10 s turn: the chain allowed the seal a
// median 6.7 s of the turn, the page showed it for about half a second (2026-11-14). Called from the page's quarter-second
// dial loop (app.mjs); no timer of its own; an answer for anything other than what was asked is dropped before it applies.
export const LOCAL_SYNC_MS = 500;
let localSyncBusy = false, localSyncLast = -Infinity;
function localSyncTarget() {
  if (!localMarchTrial()) return null;
  if (FS.compose?.origin) return { p: FS.compose.origin.p, q: FS.compose.origin.q };
  const pop = FS.hand?.pop;
  if (pop === 'muster' || pop === 'keeps') { const h = activeHolding(FS); return h ? { p: h.p, q: h.q } : null; }
  return null;
}
export function localSyncTick(t = Date.now()) {
  const target = localSyncTarget();
  if (!target || localSyncBusy || pendingDriver.armed || t - localSyncLast < LOCAL_SYNC_MS) return false;
  localSyncBusy = true; localSyncLast = t;
  const h0 = herald, lp0 = localPlay, w0 = FS.wallet?.address ?? null, key = `${target.p},${target.q}`;
  const still = () => { const n = localSyncTarget(); return herald === h0 && localPlay === lp0 && (FS.wallet?.address ?? null) === w0 && !!n && `${n.p},${n.q}` === key; };
  loadEnvelope(target.p, target.q, 'latest', still).then(e => { if (e) { FS.nowBell = nowBell(); invalidate('panel'); } }, () => null).then(() => { localSyncBusy = false; });
  return true;
}
// (2026-11-19, fix-march-held) The march's press, like the muster's (round 21): not in the last moments of a turn. A Depart
// that lands after the turn changed is refused by the program (NotResident 26: the origin province must be resolved
// through the landing turn − 2; ArrivalBell 31) — seen live at ×60, sent 0.6 s before the turn ended. In those moments the
// press arms the waiting send instead (sent once when every check passes in the next turn, or withdrawn and told — e.g.
// when the arrival turn moved with the turn). It lowers the chance of a refusal; the program's check still decides.
const marchNearEnd = () => nearTurnEnd({ genesisTs: FS.clock?.genesisTs, nowTs: now(), bellSecs: BELL_SECS, rate: FS.chain?.accelerated ? Number(FS.chain.rate) : 1 });
function armMarchWait() {
  const c = FS.compose;
  // (a march of this host sent earlier whose outcome is not known — the march's gate is closed then (LocalMarchHeld) —:
  //  the press asks about it, one read; nothing is sent)
  if (c && !c.sending && !c.pending && !pendingDriver.armed && localPlay && heldNow(c)) return askHeldMarches(c.host?.id ?? null, { told: true });
  if (!c || c.sending || c.pending || pendingDriver.armed || !marchWaitOn()) return;
  // (devnet: an earlier march of this host with an unknown outcome — nothing is armed; the card says it is held)
  if (!localPlay && devnetHeldNow(c)) return;
  const { problems, intent } = marchNow(c);
  // ready now, and not at the turn's very end: this press is an ordinary press
  if (problems.length === 0 && !marchNearEnd()) return sendTheMarch();
  if (problems.length > 0 && !pendable(problems)) return;
  const p = armPending({ intent, nowBell: nowBell() });
  if (!p || !pendingDriver.arm(c, p)) return;
  c.pending = p;
  setNotice({ busy: false, waiting: true, text: localPlay ? L`送信待ちです。州のターンの決着がつき次第、この命令を1回だけ送ります（ターン ${fmtNum(p.untilBell)} まで。取り消せます）。`
    : L`送信待ちです。このページが読む州のターンの決着が追いつき次第、この命令を1回だけ送ります。そのときウォレットが署名を求めます（ターン ${fmtNum(p.untilBell)} まで。取り消せます）。` });
}

// TEST-ONLY local play, the village's Form a host card (round 21; flocalplay-muster-wait.mjs): ONE press on its confirm
// sends the muster now when the page sees it ready and the turn is not about to change, or arms ONE waiting send of the
// exact muster shown, sent once through the ordinary single send (`musterOrder` → `act` → the local path) the first
// moment every check passes — or withdrawn and told. The driver is the march's (flocalplay-pending.mjs).
const MUSTER_WITHDRAWN = {
  cancel: PENDING_WITHDRAWN.cancel,
  changed: () => L`送信待ちを取り消しました。編成の内容（兵種・兵数・場所）が変わったためです。命令は送られていません。確かめてから、もう一度押してください。`,
  expired: PENDING_WITHDRAWN.expired,
  closed: () => L`送信待ちを取り消しました。この世界ではいま編成を送れません。命令は送られていません。`,
  unknown: PENDING_WITHDRAWN.unknown,
  problem: PENDING_WITHDRAWN.problem,
};
/**
 * The exact world and key a muster would be sent under, frozen when a waiting send is armed and compared at every look
 * AND right before the send: the local-act scope (wallet, program, Season, relay — flocalplay-act.mjs localActScope), the
 * runner's world instance, this page's herald and local-play identity objects, and the memory-only signer's handle. Any
 * difference — another world on the same Season, a restart, another relay, another key — withdraws instead of sending.
 */
function musterIdentity() {
  const g = localDepartGate();
  if (!localPlay || !g?.ok) return null;
  const scope = localAct.localActScope({ identity: localPlay, relay: g.relay });
  if (scope === null) return null;
  return Object.freeze({ scope, instance: localPlay.march?.instance ?? null, herald, localPlay, signer: currentEphemeralWallet() ?? null, wallet: FS.wallet?.address ?? null });
}
/**
 * The open muster card as the page sees it now: its draft, the reasons the program would refuse it (the page's view),
 * its identity. The card's village (the selection's) must be the page's active village — the one an order is sent for —
 * or nothing is offered (`HoldingMismatch`).
 */
function musterNow() {
  let model = null;
  try { model = handModelOf(FS); } catch { model = null; }
  if (model?.kind !== 'village' || model.pop !== 'muster') return { open: false, problems: null, intent: null, draft: null, holding: null };
  const h = model.subject.holding, d = musterDraft(FS, model);
  const draft = { unit: d.unit, troops: d.troops, tile: d.tile ?? h.tile };
  const problems = !sameHolding(h, activeHolding(FS)) ? ['HoldingMismatch'] : d.unit === null || d.max < HOST_TROOPS.min ? ['NoReserve'] : [...(model.m.blocks.Muster ?? [])];
  const id = musterIdentity();
  return { open: true, problems, draft, holding: h, identity: id, intent: id ? musterIntentOf({ world: `${id.scope}|${id.instance ?? ''}`, wallet: id.wallet, holding: h, draft }) : null };
}
/** Within the last moments of this turn on the chain's clock: wait (it lowers the chance of a refusal; it does not promise the turn the send lands in). */
const musterNearEnd = () => nearTurnEnd({ genesisTs: FS.clock?.genesisTs, nowTs: now(), bellSecs: BELL_SECS, rate: FS.chain?.accelerated ? Number(FS.chain.rate) : 1 });
/** An earlier muster of this page whose outcome is not known (held by its signature): nothing is sent again. */
const musterHeld = () => localActLedger.list(localActScopeNow()).some(e => e.name === 'Muster');
/** Everything a waiting muster depends on, as it is now, against what was frozen in `card`: null when it may be sent, else the reason it is withdrawn. */
function musterStillSame(card) {
  const n = musterNow();
  return musterStill(card, { identity: n.identity ?? musterIdentity(), open: n.open, pop: FS.hand?.pop ?? null, intent: n.intent, holding: n.holding, active: activeHolding(FS) });
}
const musterDriver = createPendingDriver({
  look: card => {
    const n = musterNow(), same = sameMusterIdentity(card.identity, n.identity ?? null);
    // (verify-pr98 BREAK-1: the village's province settling against the chain's turn now)
    const province = FS.provinces.get(`${card.holding.p},${card.holding.q}`)?.province ?? null;
    return { intent: n.intent, problems: settleNow(n.problems, province, nowBell()), nowBell: nowBell(), open: same && !FS.resident, held: musterHeld(),
      busy: FS.inFlight > 0 || musterNearEnd(), sameCard: n.open && sameHolding(card.holding, n.holding), keyAlive: !!FS.wallet?.address && FS.wallet.destroyed !== true, endsAt: localPlay?.worldEndsAt ?? NaN,
      lag: provinceLag(FS.provinces.get(`${card.holding.p},${card.holding.q}`)?.province, nowBell()) };
  },
  lagging: (card, p, lag) => { FS.musterWait = { untilBell: p.untilBell, lag }; setNotice({ busy: false, waiting: true, text: lagWaitText(lag, p.untilBell, 'muster') }); },
  // (the read is applied only while the page is still the world, herald, local-play identity and key frozen at arming)
  refresh: card => {
    const still = () => sameMusterIdentity(card.identity, musterIdentity()) && FS.wallet?.destroyed !== true && musterDriver.armed === card;
    return loadEnvelope(card.holding.p, card.holding.q, 'latest', still).then(e => { if (e) { FS.nowBell = nowBell(); invalidate('panel'); } });
  },
  // (checked once more right before the send — world, key, village, muster —; the village is passed as frozen)
  send: card => {
    FS.musterWait = null;
    const why = musterStillSame(card);
    if (why) { setNotice({ busy: false, text: MUSTER_WITHDRAWN[why](), unsent: 'muster', retry: false }); return null; }
    // (verify-pr98 BREAK-1: a refusal names the muster, and "try again" is this muster — not the earlier act in FS.lastAct
    //  (seen: a refused waiting muster said 「訓練はまだされていません」 and its retry sent the Train form again))
    FS.lastAct = { kind: 'act', name: 'muster', data: { unit: String(card.draft.unit), troops: String(card.draft.troops), tile: String(card.draft.tile) } };
    invalidate('panel');
    return musterOrder(card.draft.unit, card.draft.troops, card.draft.tile, card.holding);
  },
  withdrawn: (card, why) => {
    FS.musterWait = null;
    // (the card closed by the player: a cancel, said as one)
    const t = why === 'changed' && FS.hand?.pop !== 'muster' ? MUSTER_WITHDRAWN.cancel : MUSTER_WITHDRAWN[why];
    if (t) setNotice({ busy: false, text: t(), unsent: 'muster', retry: false }); else invalidate('panel');
  },
  onPageHide: f => { globalThis.addEventListener?.('pagehide', f); return () => globalThis.removeEventListener?.('pagehide', f); },
});
function armMusterWait() {
  if (!localPlay || musterDriver.armed) return;
  const n = musterNow();
  if (!n.open || !n.intent || !n.identity) return;
  const press = musterPress({ problems: n.problems, nearEnd: musterNearEnd(), settleCodes: SETTLE_CODES });
  // ready now, and not at the turn's very end: this press is an ordinary press (for the card's own village)
  if (press === 'send') return musterOrder(n.draft.unit, n.draft.troops, n.draft.tile, n.holding);
  if (press !== 'wait' || musterHeld()) return;
  const p = armPending({ intent: n.intent, nowBell: nowBell() });
  const card = Object.freeze({ intent: n.intent, identity: n.identity, holding: Object.freeze({ p: n.holding.p, q: n.holding.q, site: n.holding.site, gen: n.holding.gen ?? null, tile: n.holding.tile }), draft: Object.freeze({ ...n.draft }) });
  if (!p || !musterDriver.arm(card, p)) return;
  FS.musterWait = { untilBell: p.untilBell };
  setNotice({ busy: false, waiting: true, text: L`編成の送信待ちです。州のターンの決着がつき次第、この編成を1回だけ送ります（ターン ${fmtNum(p.untilBell)} まで。取り消せます）。` });
}
/** (tests) The muster's waiting send: armed or not. */
export const musterWaitArmed = () => !!musterDriver.armed;

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
    // (round 29: the identity this order is sent under, kept on its record — see marchScope)
    const sentScope = marchScope(h);
    // (devnet play: the devnet march sender, ONE attempt as local play's — no rollover resend, no nudge, no session;
    //  the book entry is kept encrypted BEFORE the wallet is asked to sign)
    const dm = !localPlay && devnetOwn() ? await devnetMarchSenderNow() : null;
    if (!localPlay && devnetOwn() && !dm) { failed({ code: 'NoIndexedDB' }); return; }
    const devnetDeps = dm ? (() => {
      const d = dm.sender.depsFor({ holding: { p: h.p, q: h.q, site: h.site }, province: { p: c.origin.p, q: c.origin.q } });
      return { ...d, submit: async req => { try { await dm.book.flush(); } catch { return { ok: false, code: 'NoIndexedDB', error: 'NoIndexedDB' }; } return d.submit(req); } };
    })() : null;
    const r = dm ? await sendMarch(m, {
      seal: req => sealMarch(req), clock: FS.clock, publicKey: FS.beacon?.publicKey, accounts: null, session: null,
      ...devnetDeps,
      onStep: s => { c.step = s; invalidate('panel'); },
      earliestAtSend: () => (FS.kernel && c.route ? earliestBell(FS.kernel, { genesisTs: FS.clock.genesisTs, departTs: now() + margin(), secs: c.route.secs }) : null),
    }) : localPlay ? await sendMarch(m, {
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
      dest: c.dest ? { p: c.dest.p, q: c.dest.q, tile: c.dest.tile } : null, arriveBell: arrive, home, scope: sentScope, transitSlot: Number.isInteger(r.entry?.transitSlot) ? r.entry.transitSlot : null });
    // (local play: a march that carries a signature WAS sent — it is never recorded as "not sent". Not confirmed: held
    //  by its signature (the memory book keeps it `sent`; only "ask" is offered). Failed on chain: sent, and refused there)
    const localSent = (localPlay || !!dm) && !r.ok && typeof r.signature === 'string' && r.signature !== '';
    // (loop-play12: a march the relay read as `expired` — its blockhash ran out before it landed: it never will — is
    //  answered too, like a chain refusal: sent, not recorded. It was held as "unconfirmed" with a re-check that could
    //  never answer — the sender's book had already let it go — and 「…まだ確認できていません…自動で確かめます」 stayed)
    const localHeld = localSent && !LOCAL_MARCH_ANSWERED.includes(r.code);
    if (localHeld) orderUnconfirmed(marchOrder, r.signature);
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
      // (2026-11-19) sent, outcome not known: said as that (the code makes it the "unconfirmed" state, not a refusal titled
      // with another action's words — it read 「編成はまだ命じられていません」), and asked again a bounded number of times;
      // a march the runner rejected, or one refused before the send, goes back to its card: "not sent", with the reason
      if (localHeld) { setNotice({ busy: false, text: localMarchUnconfirmedText(r.signature), code: 'LocalActUnconfirmed', unsent: 'march-send' }); if (localPlay) recheckHeldMarch(r.signature); }
      else if (localPlay && r.code === 'LocalMarchRejected') failed({ ...r, unsent: 'march-send', text: () => `${localMarchRejectedText(r)} ${L`命令は送られていません。カードはそのままです。確かめてから、もう一度押してください。`}` });
      else failed(localPlay ? { ...r, unsent: 'march-send' } : r);
    }
  } finally {
    c.sending = false; delete c.sendingArrival;
    FS.inFlight -= 1;
    refreshSoon();
  }
}

// ------------------------------------------------------------------ settlement (settle shapes: no authority signer, charged to the requester)
/**
 * (2026-11-17, ⑦ exploration) Whose "the result can be collected" is: `FS.exploreSeedReady` was one flag, read for the
 * village in hand at a refresh — after the person chose another village it stood, until the next refresh, as that
 * village's, and nothing said which exploration it was read for.
 * `exploreSeedMarks`: ONE mark per village — `ref (place, site, generation) → {ref, bell, world, state, code, ask,
 * source}` — naming the exploration's turn and the pinned world a seed answer was for; `state`: 'ready' | 'waiting'
 * (no seed yet, also NotFound) | 'failed' (the read did not come: NOT "no seed yet"); `ask`: the number of the REQUEST
 * the answer belongs to; `source`: 'read', or 'external' for a `true` written to the flag from outside.
 * The flag is true only while the village now in hand has a mark that is 'ready' for its pending exploration and the
 * world now pinned (startPlay makes the flag a getter over the marks; its readers are unchanged).
 *
 * `applyExploreSeed` is the ONE place a seed answer is applied — refresh's and the person's own check's alike
 * (corrected 2026-11-17: the first version guarded only the check; refresh wiped the mark at its start and wrote its
 * answer unconditionally, so a refresh that began earlier could take back a "ready" the check had read later):
 *   (a) an answer for another pinned world, or for an exploration that is not waiting now (collected, another turn,
 *       the village gone), is nobody's: nothing is written
 *   (b) a seed, once there, stays: a "ready" of the same exploration is never taken back by "not yet" or by a failed read
 *   (c) among answers that are not "ready", the one of the LATER request stands: an earlier request's answer that
 *       comes late does not replace it
 *   (d) a village's answer touches that village's mark only: another village's read never clears the one in hand's
 * No read is made here; how often and when the seed is read is refresh's (as it was) and the person's own press.
 */
const exploreSeedMarks = new Map();
let exploreSeedAsk = 0;
const exploreOfRef = ref => (FS.holdings ?? []).find(o => holdingRef(o) === ref) ?? null;
const exploreSeedNow = () => {
  const h = activeHolding(FS) ?? null, m = h ? exploreSeedMarks.get(holdingRef(h)) ?? null : null;
  return !!m && m.state === 'ready' && h.explore?.state > 0 && Number(h.explore.bell) === m.bell && providerWorld() === m.world;
};
function applyExploreSeed(ref, bell, world, r, ask, source = 'read') {
  FS.exploreSeedMarks = exploreSeedMarks;
  const here = providerWorld();
  // (marks of another world, and of explorations that are not waiting any more, are let go)
  for (const [k, m] of exploreSeedMarks) { const o = exploreOfRef(k); if (m.world !== here || !(o?.explore?.state > 0) || Number(o.explore.bell) !== m.bell) exploreSeedMarks.delete(k); }
  const o = exploreOfRef(ref);
  if (world !== here || !(o?.explore?.state > 0) || Number(o.explore.bell) !== bell) return false;   // (a)
  const ready = r?.ok === true && !!seedSourceOf(r.record), unread = !ready && r?.ok !== true && r?.code !== 'NotFound';
  const cur = exploreSeedMarks.get(ref) ?? null;   // (what is left after the pruning is this exploration's, in this world)
  if (cur && !ready && (cur.state === 'ready' || cur.ask > ask)) return false;   // (b), (c)
  exploreSeedMarks.set(ref, { ref, bell, world, state: ready ? 'ready' : unread ? 'failed' : 'waiting', code: unread ? r?.code ?? 'Error' : null, ask, source });   // (d)
  // (a page whose flag is a plain value — startPlay did not run — keeps it in step with the village in hand)
  if (!Object.getOwnPropertyDescriptor(FS, 'exploreSeedReady')?.get) FS.exploreSeedReady = exploreSeedNow();
  return true;
}
/**
 * The person's own "has the result come?" for the village in hand: ONE read of the exploration's turn record
 * (herald.bellRegion) — the read refresh makes — and nothing else; nothing is sent, settled or saved. Its answer is
 * applied by applyExploreSeed, with the village, the exploration and the world it was pressed for and its request's
 * number; a change of herald, world or viewer during the read drops it. A press while a check of the SAME village and
 * exploration is under way starts nothing; a check of another village does not hold this one back.
 * `FS.exploreSeedCheck = { state: 'loading', ref, bell, world }` names the check under way — the card shows it only
 * for that village.
 */
export async function checkExploreSeed() {
  const h = activeHolding(FS) ?? null;
  if (!herald || FS.mode !== 'play' || !(h?.explore?.state > 0)) return false;
  const at = { herald, world: providerWorld(), viewer: viewerKey() ?? null };
  const run = { state: 'loading', ref: holdingRef(h), bell: Number(h.explore.bell), world: at.world };
  const cur = FS.exploreSeedCheck ?? null;
  if (cur?.state === 'loading' && cur.ref === run.ref && cur.bell === run.bell && cur.world === run.world) return 'loading';
  const scope = () => herald === at.herald && providerWorld() === at.world && (viewerKey() ?? null) === at.viewer;
  const ask = ++exploreSeedAsk;
  FS.exploreSeedCheck = run; invalidate('panel');
  try {
    const r = await herald.bellRegion(h.explore.bell, regionOf(h.explore.p, h.explore.q)).catch(e => ({ ok: false, code: e?.code ?? 'Error' }));
    if (!scope()) return false;
    applyExploreSeed(run.ref, run.bell, at.world, r, ask);
    return exploreSeedMarks.get(run.ref)?.state === 'ready';
  } finally {
    if (FS.exploreSeedCheck === run) FS.exploreSeedCheck = null;
    invalidate('panel', 'tabs', 'chips');
  }
}

async function settleExplore() {
  // (2026-11-17, ⑦: a village with no exploration waiting has nothing to collect — said, instead of reading `rec.p` of
  //  nothing; and what was read for one world, viewer or village is not sent as another's: after the one wait below the
  //  press's own marks are checked BEFORE anything is built or sent. It only stops; the send is the one it was.)
  const h = activeHolding(FS) ?? null, rec = h?.explore ?? null;
  if (!h || !(rec?.state > 0)) return failed({ code: 'ExploreNone', text: L`この村には、受け取る探索の結果がありません。` });
  const prep = { herald, world: providerWorld(), viewer: viewerKey() ?? null, ref: holdingRef(h), bell: Number(rec.bell) };
  const region = regionOf(rec.p, rec.q);
  const r = await herald.bellRegion(rec.bell, region);
  { const now = activeHolding(FS) ?? null;
    if (herald !== prep.herald || providerWorld() !== prep.world || (viewerKey() ?? null) !== prep.viewer || holdingRef(now) !== prep.ref || Number(now?.explore?.bell) !== prep.bell) return { ok: false, code: 'ExploreChanged', sent: false }; }
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
/**
 * (devnet-page-outpost) The checks of one FileOutpost, made again from fresh reads: the Citizen and its villages (the
 * herald's `me`), the target's and the villages' provinces, then the program's own rule as the page knows it
 * (fconquest.mjs outpostOffer). → `{ok: true, offer}` or a refusal `{ok: false, code, text}`.
 */
/** (devnet-page-outpost) The map's outpost press on a devnet page: the first home's village screen, and its card's preview. */
function outpostFromMap(d) {
  FS.tab = 'holding';
  FS.activeHolding = Math.max(0, (FS.holdings ?? []).findIndex(h => h.order === 1));
  invalidate('panel', 'tabs', 'rail');
  return ACTIONS['outpost-preview'](d);
}
async function outpostRecheck(target, walletAddress) {
  const me = await herald.me(walletAddress).catch(() => ({ ok: false, code: 'Unavailable' }));
  if (!me.ok) return { ok: false, code: me.code ?? 'Unavailable' };
  if (FS.wallet?.address !== walletAddress) return { ok: false, code: 'NotOwner' };
  FS.citizen = me.citizen; FS.holdings = me.holdings; FS.land = landState(me.citizen);
  const sources = [target, ...FS.holdings.filter(h => h.order === 1 || h.order === 2)];
  for (const [i, p] of sources.entries()) {
    if (sources.slice(0, i).some(s => s.p === p.p && s.q === p.q)) continue;
    if (!await loadEnvelope(p.p, p.q)) return i === 0 && FS.provinceReads?.get?.(`${p.p},${p.q}`)?.state === 'missing'
      ? { ok: false, code: 'LocalActProvinceAbsent' } : { ok: false, code: 'Unavailable' };
  }
  const offer = outpostOffer(FS, target);
  FS.conquest && (FS.conquest.outpost = offer);
  return offer.eligible ? { ok: true, offer } : { ok: false, code: offer.code ?? 'OutpostRule', text: offer.reason };
}

/**
 * (devnet-p17) The checks of one wide village act, made again from fresh reads: the Citizen's record (`/h/me`, which
 * carries the wide village's captured bytes), the village's own province from the herald's wide route (a muster's
 * passable tiles and the province's turn cursor), then fdevnet-wide-village.mjs wideVillageCheck. Only the player's
 * own village and province are read (fog). → `{ok: true, entry, village, province, warn}` or a refusal.
 */
async function wideActRecheck(name, fields, walletAddress) {
  if (!walletAddress || !devnetPlay || !devnetPlayMod.devnetWideVillageOn(devnetPlay) || devnetGate().ok !== true) return { ok: false, code: devnetGate().code ?? 'DevnetPlayOff' };
  const slot = FS.wideSelect?.inventorySlot ?? null;
  await refresh().catch(() => null);
  if (FS.wallet?.address !== walletAddress) return { ok: false, code: 'NotOwner' };
  const entry = fwide.selectedWide(FS);
  if (!entry || entry.inventorySlot !== slot) return { ok: false, code: 'WideVillageUnread' };
  let province = null;
  if (entry.holding && name === wideVillage.WIDE_MUSTER) {
    const r = await herald.wideRoute({ places: [{ p: String(entry.holding.p), q: String(entry.holding.q) }] }).catch(() => null);
    const cap = r?.ok !== false ? (r?.json ?? r)?.route?.find?.(x => String(x?.p) === String(entry.holding.p) && String(x?.q) === String(entry.holding.q))?.capture?.bytes_b64 : null;
    try { province = typeof cap === 'string' ? wideVillage.wideProvinceFacts(fromBase64(cap)) : null; } catch { province = null; }
    // (the card's tile list: this village's province's passable tiles, as last read)
    if (province) FS.wideActProvince = { p: String(entry.holding.p), q: String(entry.holding.q), passable: province.passable };
    // (「自動」: the first passable tile of the province)
    if (fields.tile === -1 && province?.passable.length) fields = { ...fields, tile: province.passable[0] };
  }
  const c = wideVillage.wideVillageCheck(entry, { name, fields, province, nowBell: nowBell() });
  if (!c.ok) return { ok: false, code: c.code, text: wideActRefusalText(c) };
  return { ok: true, entry, village: wideVillage.wideVillageOf(entry.holding), province, fields, warn: c.warn };
}
/** (devnet-p17) The page's own words for a refusal it makes before anything is signed ('' → the code's general text). */
function wideActRefusalText(c) {
  switch (c.code) {
    case 'WideVillageUnread': return L`遠方の村の記録をまだ読めていません。少し待ってからもう一度押してください。`;
    case 'WideVillageNotLive': return L`この遠方の村は、いま命令を受けられる状態ではありません。`;
    case 'NotFinal': return L`遠方の村が確定するまでは編成できません。`;
    case 'WideVillageTroops': return L`軍勢は 100〜30,000 の兵で編成します。`;
    case 'Insufficient': return L`控えのこの兵種は ${fmtNum(Number(c.have ?? 0))} です。兵数を減らすか、先に訓練してください。`;
    case 'WideProvinceUnread': return L`この村の州の記録（通れるマス）をまだ読めていません。少し待ってからもう一度押してください。`;
    case 'WideVillageTile': return L`そのマスには軍勢を置けません（通れないマスです）。別のマスを選んでください。`;
    case 'QueueFull': return L`建設の列がいっぱいです。いまの建設が終わってから押してください。`;
    case 'WideVillageShape': return L`入力の値を確かめてください。`;
    default: return undefined;
  }
}
/** (devnet-p17) What an accepted wide village act says. */
function wideActDoneText(name, fields) {
  if (name === wideVillage.WIDE_HARVEST) return L`遠方の村で収穫しました。`;
  if (name === wideVillage.WIDE_BUILD) return L`遠方の村で建設を始めました。`;
  if (name === wideVillage.WIDE_TRAIN) return L`遠方の村で兵 ${fmtNum(fields.n)} を訓練しました。`;
  return L`遠方の村で兵 ${fmtNum(fields.troops)} の軍勢を編成しました。`;
}
/**
 * (devnet-p17) The result read back: the village's record is read again (every 3 s, at most about three minutes —
 * fix-devnet-join-wait: it was one minute, about the herald's finalized lag plus one ingest burst; fown-wait.mjs
 * OWN_WAIT_MS) until a capture after the send shows a change; the card then says what changed, by the record's own
 * figures. A record that does not change in that time is said as that (not as a failure: the chain said the act landed).
 */
async function wideActReadBack(sent, { tries = 60, every = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, every));
    if (FS.wideActPreview !== sent) return;
    await refresh().catch(() => null);
    const e = fwide.selectedWide(FS);
    if (!e?.holding || FS.wideActPreview !== sent) continue;
    const at = String(e.holding.currentness?.capturedSlot ?? '');
    if (sent.beforeSlot !== '' && at !== '' && BigInt(at) <= BigInt(sent.beforeSlot)) continue;
    const res = wideVillage.wideVillageResult(sent.before, e.holding.economy);
    if (!res.changed) continue;
    FS.wideActPreview = { ...sent, result: res, resultSlot: at };
    invalidate('panel');
    return;
  }
  if (FS.wideActPreview === sent) { FS.wideActPreview = { ...sent, result: { changed: false, unread: true } }; invalidate('panel'); }
}

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
  // (fix-9-10-followups: the local coexist lane names the caravan by its seed — flocalplay-rights.mjs RaidCaravan)
  const caravanRef = { ownerTag: String(r.caravan.ownerTag), seq: r.caravan.seq };
  const raid = { p: r.p, q: r.q };
  if (d.choice !== 'take') {
    return act('RaidCaravan', { v: { caravan, caravanRef, raider: r.raider, raid, dst: null },
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
  return act('RaidCaravan', { v: { caravan, caravanRef, raider: r.raider, ...route },
    fields: { p: r.p, q: r.q, choice: RAID_CHOICE.take, n_path: raidProvinces(route).nPath, ...placeData(dst), steps: plan.dirs.length, path: pack(plan.dirs) },
    order: orderOf('s1-raid', 'RaidCaravan', { tile: { p: r.p, q: r.q, tile: r.tile }, say: () => L`隊商を奪い、村へ向かわせました` }) });
}
/**
 * (fix-9-10-followups, local coexist lane only) RaidDomestic: the viewer's host stood where a caravan of its own nation
 * stood (screens/s1.mjs domesticRaidOffers); the program opens the raid, then 「奪って運ぶ」/「焼き払う」 decide it. The
 * caravan's owner Citizen is the account's own (`OWNER_CITIZEN`), read through the relay as the custody card reads.
 */
async function s1RaidOpen(d) {
  if (!rightsLaneOn()) return failed({ code: 'LocalActNotAllowed' });
  const r = domesticRaidOffers(FS).find(x => x.p === num(d.p) && x.q === num(d.q) && x.slot === num(d.slot));
  if (!r) return s1Refused(L`この隊商はもう止められません`);
  const A = io.pinned().addresses;
  busy(() => L`隊商の持ち主を確かめています…`);
  const at = A.of('Caravan', { ownerTag: BigInt(r.caravan.ownerTag), seq: r.caravan.seq });
  const got = await custodyRead([at]).catch(() => new Map());
  const cv = got.get(at) ? cust.decodeCaravan(got.get(at)) : null;
  if (!cv || cv.state !== cust.CV_MOVING) return s1Refused(L`この隊商はもう道の上にいません`);
  return act('RaidDomestic', { v: { caravanRef: { ownerTag: String(r.caravan.ownerTag), seq: r.caravan.seq }, province: { p: r.p, q: r.q }, hostHolding: r.hostHolding, ownerCitizen: cv.ownerCitizen },
    fields: { bell: r.bell, entry: r.entry },
    order: orderOf('s1-raid-open', 'RaidDomestic', { tile: { p: r.p, q: r.q, tile: r.tile }, say: () => L`隊商を止めました。荷を奪うか焼き払うかを決めてください` }) });
}
/**
 * SendCaravan from the village in hand or one of the viewer's storehouses to another of the viewer's places, or to
 * another player's village or storehouse: that one is signed by the wallet (caravan.rs WalletRequired), and a
 * village's generation is read from its Holding first (the herald's /h/holding).
 */
async function s1Caravan(srcIndex, dstIndex, cargo) {
  const m = s1VillageModel(FS), from = m.sources[srcIndex];
  // (2026-11-17, ⑦: what the plan is prepared for — checked after each wait below, BEFORE anything is built or sent: a
  //  source and a route found for one world, viewer or village are never sent as another's. It only stops; the send's
  //  own conditions, signer, fee and fields are as they were.)
  const prep = { herald, world: providerWorld(), viewer: viewerKey() ?? null, address: FS.wallet?.address ?? null, holding: holdingRef(activeHolding(FS) ?? null) };
  const prepHolds = () => herald === prep.herald && providerWorld() === prep.world && (viewerKey() ?? null) === prep.viewer && (FS.wallet?.address ?? null) === prep.address
    && holdingRef(activeHolding(FS) ?? null) === prep.holding;
  // (corrected 2026-11-17: the word that the preparation was overtaken replaces only THIS request's own "being
  //  prepared" notice, still standing — it would otherwise spin for good. Where that notice is gone or another stands
  //  (another viewer's reset, a newer request), an old request says nothing in a context that is no longer its own.)
  let prepNote = null;
  const prepChanged = () => (FS.notice === prepNote && prepNote !== null
    ? s1Refused(L`準備の間に、世界・ウォレット・選んでいる村のどれかが変わりました。隊商は送っていません。もう一度確かめてから送ってください。`) : { ok: false, code: 'S1PrepChanged', sent: false });
  let dst = m.destinations[dstIndex];
  const problem = caravanProblem(from, dst, cargo);
  if (problem === 'NoPlace') return s1Refused(L`出発地と行き先を選んでください`);
  if (problem === 'CapturePending') return failed({ code: 'CapturePending' });
  if (problem === 'SamePlace') return s1Refused(L`出発地と行き先が同じです`);
  if (problem === 'NoCargo') return s1Refused(L`運ぶものを入れてください`);
  if (problem === 'Insufficient') return failed({ code: 'Insufficient' });
  // (fix-loop8, LP8-3: a ① request's destination whose province is out of sight is not loaded yet: its record is read
  //  now for the site's tile — the data only; what the map shows of it is unchanged, fog and all)
  if (dst.coop && !Number.isInteger(dst.tile)) {
    busy(() => L`依頼の届け先のマスを確かめています…`); prepNote = FS.notice;
    if (!FS.provinces.get(`${dst.p},${dst.q}`)) await loadEnvelope(dst.p, dst.q).catch(() => null);
    if (!prepHolds()) return prepChanged();
    const t = Number(FS.provinces.get(`${dst.p},${dst.q}`)?.province?.sites?.[dst.site]);
    if (Number.isInteger(t)) dst = { ...dst, tile: t };
  }
  if (!Number.isInteger(from.tile) || !Number.isInteger(dst.tile)) return s1Refused(L`出発地か行き先のマスがわかりません`);
  if (dst.other && !wallet.connected()) return failed({ code: 'NoWallet' });
  if (dst.other && dst.kind === 'holding') {
    busy(() => L`行き先の村を確かめています…`); prepNote = FS.notice;
    const r = await herald.holding(dst.p, dst.q, dst.site);
    if (!prepHolds()) return prepChanged();
    if (!r.ok) return failed(r);
    if (!Number.isInteger(Number(r.holding.gen))) return s1Refused(L`行き先の村はもうありません`);
    // (fix-loop8, LP8-3: a ① request names its village with its generation; a village rebuilt since is another one —
    //  the board would not count a caravan to it — so nothing is sent)
    if (dst.coop && Number.isInteger(dst.coopGen) && Number(r.holding.gen) !== dst.coopGen) return s1Refused(L`依頼の届け先の村は、依頼が出されたあとで建て直されています。板で依頼を確かめてください。隊商は送っていません。`);
    dst = { ...dst, gen: Number(r.holding.gen) };
  }
  busy(() => L`道を探しています…`); prepNote = FS.notice;
  const lands = await landsFor(from, dst);
  if (!prepHolds()) return prepChanged();
  const plan = fastestPath({ p: from.p, q: from.q, tile: from.tile }, { p: dst.p, q: dst.q, tile: dst.tile }, lands);
  if (!plan || !plan.dirs.length) return s1Refused(L`そこまで隊商の道が届きません（${fmtNum(MAX_PATH_STEPS)} マス・${fmtNum(MAX_PATH_PROVINCES)} 州まで）`);
  const seq = Number(FS.citizen?.caravans ?? 0);
  const src = from.kind === 'vault' ? { kind: 'vault', p: from.p, q: from.q, tile: from.tile, gen: from.gen } : { kind: 'holding', p: from.p, q: from.q, site: from.site, gen: from.gen ?? 0 };
  const target = { kind: dst.kind, p: dst.p, q: dst.q, ...(dst.kind === 'vault' ? { tile: dst.tile } : { site: dst.site }), gen: dst.gen ?? 0 };
  return act('SendCaravan', { v: { seq, src, dst: target, provinces: plan.provinces, ...(dst.other ? { actor: FS.wallet.address } : {}) },
    fields: { seq, ...placeData(target), steps: plan.dirs.length, path: pack(plan.dirs), cargo: cargoBytes(cargo), fee: CARAVAN_FEE },
    ...(dst.other ? { signer: 'wallet', label: () => L`ほかの人の村か貯蔵庫へ送る隊商は、ウォレットで署名します…` } : {}),
    order: orderOf('s1-caravan', 'SendCaravan', { say: () => L`隊商が出発しました` }) });
}

/**
 * (2026-11-17, ⑦ from the map to the trade card) The place the person chose on the map — a storehouse, a village, one of
 * their forts — is handed to the existing caravan or fort form as its destination, its source or its fort. `d`: `{p, q,
 * tile, role: 'dst' | 'src' | 'fort'}`. Nothing is read, awaited, sent or saved: `FS.s1Plan = {role, p, q, tile, world,
 * viewer}` only names the tile, the pinned world (with its generation) and the viewer it was chosen for; what stands on
 * the tile is looked up again, from what the page holds, every time the card is drawn and when the form is sent
 * (screens/s1.mjs s1PlanNow) — so a place that is gone, another world's or another viewer's is never put in the form.
 * The form's amounts are the person's: nothing here writes them. Each press makes a NEW plan — a new object with its own
 * number `id`, also for the same tile again — so what a send began with can be told from what stands later. Answers the
 * plan's number, or false (with the reason said) when the tile offers no such role now.
 */
let s1PlanSeq = 0;
export function planS1Place(d = {}) {
  if (!s1On() || FS.mode !== 'play') return false;
  const sel = { p: num(d.p), q: num(d.q), idx: num(d.tile) }, role = String(d.role ?? '');
  const offers = s1PlanOffers(FS, sel);
  if (!['dst', 'src', 'fort'].includes(role) || offers[role] !== true) { s1Refused(L`この場所は、いまは計画に入れられません。地図でもう一度選んでください。`); return false; }
  FS.s1Plan = { id: ++s1PlanSeq, role, p: sel.p, q: sel.q, tile: sel.idx, world: providerWorld(), viewer: viewerKey() ?? null };
  invalidate('panel');
  return FS.s1Plan.id;
}
/** The chosen place is let go (the person's press). The form's own fields are not touched. */
export function clearS1Plan() { if (FS.s1Plan) { FS.s1Plan = null; invalidate('panel'); } }

/**
 * The plan a send from the trade card's forms began with, and whether the form used it: `{plan, used}`. `plan` is the
 * object standing at the press (or null); `used`: the form's own choice is the plan's place — its destination or source
 * index for a caravan, its tile for a fort. (Corrected 2026-11-17: the first version let ANY accepted caravan clear
 * whatever plan stood when the answer came — a plan chosen during the send, also for the same tile again, or another
 * world's, was lost to an old success.)
 */
function s1PlanAtSend({ srcIndex = null, dstIndex = null, fortTile = null } = {}) {
  const plan = FS.s1Plan ?? null, mp = plan ? s1VillageModel(FS).plan : null;
  const used = !!plan && !!mp && mp.id === plan.id && !mp.lost
    && ((mp.dst !== null && mp.dst === dstIndex) || (mp.src !== null && mp.src === srcIndex) || (mp.fort !== null && mp.fort === fortTile));
  return { plan, used };
}
/** An ACCEPTED send lets go of the plan it began with and used — only while that very plan still stands; any other answer, and any other plan, is left as it is. */
const s1PlanDone = (at, r) => { if (r?.ok === true && at.used && at.plan !== null && FS.s1Plan === at.plan) clearS1Plan(); return r; };
function s1CaravanFromForm(f) {
  const srcIndex = Math.trunc(formNum(f, 'src') || 0), dstIndex = Math.trunc(formNum(f, 'dst'));
  const at = s1PlanAtSend({ srcIndex, dstIndex });
  return s1Caravan(srcIndex, dstIndex, Array.from({ length: 8 }, (_, i) => Math.max(0, Math.trunc(formNum(f, `c${i}`) || 0)))).then(r => s1PlanDone(at, r));
}

/**
 * Derive this device's game key (the wallet signs a message; nothing on chain) and make it the Citizen's session —
 * unless another key is registered (Q16-3). Then nothing is sent without `replace` naming exactly the key registered
 * now (the one the warning showed): the answer is `SessionHeldElsewhere`, and the page shows who holds the key.
 */
async function setSession({ replace = null } = {}) {
  const pin = io.pinned();
  let s;
  try { s = await fsession.derive({ wallet: wallet.connected(), cluster: pin.cluster, programId: pin.programId, seasonId: pin.seasonId }); } catch (e) { return failed({ code: e.code ?? 'SignFailed' }); }
  fsession.remember(s);
  FS.session = s;
  const m = fsession.matchesCitizen(s, FS.citizen, now());
  if (m.ok) { FS.sessionProblem = null; FS.keyKept = null; return invalidate('panel'); }
  const registered = m.code === 'SessionMismatch' ? registeredKey(FS.citizen) : null;
  if (registered) FS.sessionProblem = 'SessionMismatch';
  if (registered && replace !== registered) {
    agentsReadAt = -Infinity;
    refreshDelegation().catch(e => console.error('frontier delegation:', e));
    setNotice({ ok: false, code: 'SessionHeldElsewhere', text: () => failureText({ code: 'SessionHeldElsewhere' }) });
    return { ok: false, code: 'SessionHeldElsewhere', sent: false };
  }
  // Replacing a key held elsewhere (the owner's agent, the courier, another device): say what this did and did not do.
  const handed = registered ? delegationOf(FS) : null;
  const expiry = BigInt(Math.floor(now()) + SESSION_DAYS - 600);
  // (once it landed the page shows this device's key at once, not the old holder's card until the next poll — verify-pr61 F3)
  const landed = () => { FS.delegation = null; FS.keyKept = null; FS.keyReview = null; if (FS.citizen) FS.citizen = { ...FS.citizen, session: s.publicKeyBytes, sessionExpiry: expiry }; FS.sessionProblem = null; invalidate('panel'); };
  return act('SetSession', { fields: { session: s.publicKeyBytes, expiry },
    ...(handed ? { say: () => takenBackNote(handed) } : {}), after: landed });
}

// ------------------------------------------------------------------ ② rights (TEST-ONLY, a coexist local world only)
/** Whether this page plays a coexist local world (flocalplay-lane.mjs: selected once the gate verified its Season). */
const rightsLaneOn = () => !!localPlay && localLane() === COEXIST_LANE;
const RIGHTS_WIDE_READ = 'frontier-local-play-act-wide-read-v1';
/**
 * The Grants this viewer is a party to (FOG RULE, flocalplay-rights.mjs): the herald's `/h/grants?citizen=` rows (kept
 * to the viewer's own again by `partyGrants`) and the Grants this page issued itself; their live state from the relay's
 * read-only account read (at most 16). Nothing is sent. `FS.rights` (screens/rights.mjs rightsModel).
 */
async function refreshRights(current = () => true) {
  if (!rightsLaneOn() || !FS.wallet || !io.pinned()) { FS.rights = undefined; return; }
  const viewer = viewerCitizen();
  if (!FS.rights || FS.rights.viewer !== viewer) FS.rights = { on: true, viewer, read: 'unread', rows: null, live: new Map(), issued: [] };
  const r = FS.rights;
  if (r.rows === null) r.read = 'loading';
  const got = herald?.grants ? await herald.grants(viewer).catch(() => ({ ok: false })) : { ok: false };
  if (!current() || FS.rights !== r) return;
  if (got.ok && got.grants?.schema === HERALD_GRANTS_SCHEMA) { r.rows = got.grants; r.read = 'ok'; } else if (r.rows === null) r.read = 'unavailable';
  const addrs = [...new Set([...(partyGrants(r.rows, viewer) ?? []).map(x => x.address), ...r.issued.map(x => x.address)])].slice(0, 16);
  const g = localDepartGate();
  if (addrs.length && g?.ok) {
    try {
      const j = await localAct.postLocalAct(g.relay, localAct.LOCAL_ACT_CONTEXT_PATH, { schema: RIGHTS_WIDE_READ, addresses: addrs });
      if (!current() || FS.rights !== r) return;
      // (an account the chain no longer holds — a closed Grant — is remembered as gone, never shown with its last bytes' offers)
      r.gone ??= new Set();
      (j?.accounts ?? []).forEach((a, i) => { const d = a ? decodeGrant(rightsB64(a.data_b64)) : null; if (d) { r.live.set(addrs[i], d); r.gone.delete(addrs[i]); } else if (a === null) r.gone.add(addrs[i]); });
    } catch (e) { console.error('frontier rights read:', e); }
  }
  invalidate('panel');
}
const dnum = (d, k) => Math.trunc(Number(d?.[k]));
/** A use of a Grant from a list row's data (screens/rights.mjs): the Grant, its facility village and its station Vault. */
function rightsUse(name, d, fields = {}) {
  if (!rightsLaneOn()) return failed({ code: 'LocalActNotAllowed' });
  const grant = { issuer_tag: String(d.tag), nonce: dnum(d, 'nonce') };
  const v = name === 'CloseGrant' ? { grant } : { grant, facility: { p: dnum(d, 'fp'), q: dnum(d, 'fq'), site: dnum(d, 'site') }, station: { p: dnum(d, 'fp'), q: dnum(d, 'fq'), tile: dnum(d, 'tile') } };
  const say = { ReserveSwap: () => L`交換を予約しました`, ExecuteSwap: () => L`交換しました。兵器はあなたの貯蔵庫に入りました`, ReleaseSwap: () => L`予約を戻しました`,
    RevokeGrant: () => L`権利を取り消しました`, CloseGrant: () => L`権利を閉じました` }[name];
  return act(name, { v, fields, say, after: () => refreshRights() });
}
/** Deliver the viewer's own arrived caravan, or one it took in a raid (screens/rights.mjs: local play has no keeper delivering S1 caravans). */
async function rightsDeliver(d) {
  if (!rightsLaneOn()) return failed({ code: 'LocalActNotAllowed' });
  const dst = d.kind === 'vault' ? { kind: 'vault', p: dnum(d, 'dp'), q: dnum(d, 'dq'), tile: dnum(d, 'at'), gen: dnum(d, 'gen') } : { kind: 'holding', p: dnum(d, 'dp'), q: dnum(d, 'dq'), site: dnum(d, 'at'), gen: dnum(d, 'gen') };
  const provinces = String(d.path ?? '').split('.').filter(Boolean).map(x => { const [p, q] = x.split('_').map(Number); return { p, q }; });
  // (fix-9-10-followups: `owner` — a caravan the viewer took in a raid keeps its sender's seed)
  const ownerTag = /^[0-9]{1,20}$/.test(String(d.owner ?? '')) ? String(d.owner) : null;
  const seq = dnum(d, 'seq');
  if (!ownerTag) return act('SettleCaravan', { v: { seq, dst, provinces }, fields: {}, say: () => L`隊商が届きました`, after: () => refreshRights() });
  // (its rent goes back to whoever paid it at the send — the account's RENT_TO, read through the relay)
  const at = io.pinned().addresses.of('Caravan', { ownerTag: BigInt(ownerTag), seq });
  const cv = await custodyRead([at]).then(m => (m.get(at) ? cust.decodeCaravan(m.get(at)) : null)).catch(() => null);
  if (!cv) return s1Refused(L`この隊商はもう道の上にいません`);
  return act('SettleCaravan', { v: { seq, dst, provinces, ownerTag, rentTo: cv.rentTo }, fields: {}, say: () => L`隊商が届きました`, after: () => refreshRights() });
}
function rightsIssueFromForm(f) {
  if (!rightsLaneOn()) return failed({ code: 'LocalActNotAllowed' });
  const o = f?.elements?.pair?.selectedOptions?.[0]?.dataset;
  if (!o) return failed({ code: 'S1Refused', text: L`工房の村と相手の貯蔵庫を選んでください` });
  const nonce = Math.trunc(Number(f.dataset.nonce)), days = Math.trunc(formNum(f, 'days'));
  const facility = { p: dnum(o, 'fp'), q: dnum(o, 'fq'), site: dnum(o, 'site') }, station = { p: facility.p, q: facility.q, tile: dnum(o, 'tile') };
  const fields = { nonce, kind: KIND_STOCK_SWAP, max_swaps: Math.trunc(formNum(f, 'max_swaps')), max_units: Math.trunc(formNum(f, 'max_units')), expires_ts: String(Math.floor(now()) + days * 86_400) };
  const pin = io.pinned(), me = viewerCitizen();
  return act('IssueGrant', { v: { facility, grantee: o.grantee, station }, fields, say: () => L`権利を出しました`,
    after: x => { if (x?.ok !== false && FS.rights) { FS.rights.issued.push({ address: grantAddress(pin.addresses.season, pin.programId, issuerTagOf(me), nonce), issuerTag: issuerTagOf(me), nonce }); } return refreshRights(); } });
}

// ------------------------------------------------------------------ ⑨ capacity · ⑩ custody (TEST-ONLY preview, a coexist local world only)
/**
 * Read-only account reads through the relay (the wide read). → Map(address → Uint8Array | null). Six addresses a call:
 * the page takes at most LOCAL_ACT_MAX_BYTES (16 KiB) of answer, and the largest account read here — a pool, 1,580 B —
 * is about 2.2 KB in base64 (twelve Holdings at once were refused, LocalActTooLarge).
 */
const CUSTODY_READ_BATCH = 6;
async function custodyRead(addrs) {
  const g = localDepartGate(), out = new Map();
  if (!g?.ok) return out;
  const list = [...new Set(addrs)];
  for (let i = 0; i < list.length; i += CUSTODY_READ_BATCH) {
    const part = list.slice(i, i + CUSTODY_READ_BATCH);
    const j = await localAct.postLocalAct(g.relay, localAct.LOCAL_ACT_CONTEXT_PATH, { schema: RIGHTS_WIDE_READ, addresses: part });
    (j?.accounts ?? []).forEach((a, k) => out.set(part[k], a ? rightsB64(a.data_b64) : null));
  }
  return out;
}
/**
 * What the preview card needs (FOG RULE, flocalplay-custody.mjs): the villages of the viewer's own Provinces (their
 * Holdings), the pools of the workshop villages there, the jobs the viewer is a party to, the lots in the viewer's
 * storehouses and the viewer's own lots, and the viewer's custody caravans those lots expect. Only reads. A loss seen
 * for the first time is told once, from the viewer's side (`FS.custody.told`).
 */
async function refreshCustody(current = () => true) {
  if (!rightsLaneOn() || !FS.wallet || !io.pinned()) { FS.custody = undefined; return; }
  const viewer = viewerCitizen(), pin = io.pinned(), A = pin.addresses;
  if (!FS.custody || FS.custody.viewer !== viewer) FS.custody = { on: true, viewer, myTag: cust.tagOf(viewer), read: 'unread', holdings: [], pools: new Map(), jobs: new Map(), lots: new Map(), caravans: new Map(), told: new Set(), custodySeqs: new Set() };
  const c = FS.custody;
  if (c.read === 'unread') c.read = 'loading';
  try {
    const provs = [...new Map((FS.holdings ?? []).map(h => [`${h.p},${h.q}`, { p: h.p, q: h.q }])).values()];
    const hAddr = provs.flatMap(pq => Array.from({ length: 12 }, (_, site) => A.of('Holding', { p: pq.p, q: pq.q, site })));
    const hs = await custodyRead(hAddr);
    if (!current() || FS.custody !== c) return;
    const holdings = [...hs.values()].map(b => (b ? cust.decodeHoldingBrief(b) : null)).filter(h => h && h.state !== 0);
    const vaults = (FS.s1?.caravans?.vaults ?? []).filter(v => provs.some(pq => pq.p === v.p && pq.q === v.q) && typeof v.ownerCitizen === 'string');
    // (a seizure or a capture moves a storehouse or village to its next generation, and a lot's or pool's address
    //  carries the generation: the planners also read the generations before and everything read before, or a loss
    //  would vanish instead of being told — verify-pr140)
    const lotAt = cust.lotReadPlan({ vaults, holdings, viewer, known: [...c.lots.values()].map(e => ({ vault: e.vault, owner: e.owner })) });
    const lotAddr = lotAt.map(x => cust.lotAddress(A.season, pin.programId, x.vault, cust.tagOf(x.owner)));
    const poolOf = cust.poolReadPlan({ holdings, known: [...c.pools.values()].map(e => e.pool.facility) });
    const poolAddr = poolOf.map(f => cust.poolAddress(A.season, pin.programId, f));
    const got = await custodyRead([...lotAddr, ...poolAddr]);
    if (!current() || FS.custody !== c) return;
    const lots = new Map();
    lotAt.forEach((x, i) => { const b = got.get(lotAddr[i]); const l = b ? cust.decodeLot(b) : null; if (l && l.owner === x.owner) lots.set(lotAddr[i], { vault: x.vault, owner: x.owner, lot: l }); else if (!l && c.lots.has(lotAddr[i]) && !c.lots.get(lotAddr[i]).gone) lots.set(lotAddr[i], { ...c.lots.get(lotAddr[i]), gone: true }); });
    const pools = new Map();
    poolOf.forEach((f, i) => { const b = got.get(poolAddr[i]); const pl = b ? cust.decodePool(b) : null; if (pl) pools.set(poolAddr[i], { pool: pl }); });
    // jobs: every job of the viewer's own pools, and the viewer's own jobs in others' pools
    const jobAt = [];
    for (const [, e] of pools) {
      const mine = e.pool.owner === viewer, myGrants = new Set(e.pool.grants.filter(g => g.user === viewer).map(g => g.seq));
      for (const o of e.pool.occ) if (mine || myGrants.has(o.grant)) jobAt.push({ facility: e.pool.facility, grant: o.grant, job: o.job, pool: e.pool });
    }
    const jobAddr = jobAt.map(x => cust.jobAddress(A.season, pin.programId, x.facility, x.grant, x.job));
    const caravanAt = [...lots.values()].filter(e => e.owner === viewer).flatMap(e => e.lot.inbound.filter(x => x.tag === c.myTag).map(x => ({ seq: x.seq, vault: e.vault, qty: x.qty })));
    for (const s of c.sent ?? []) if (!caravanAt.some(x => x.seq === s.seq)) caravanAt.push(s);
    const cvAddr = caravanAt.map(x => A.of('Caravan', { ownerTag: BigInt(c.myTag), seq: x.seq }));
    const got2 = await custodyRead([...jobAddr, ...cvAddr]);
    if (!current() || FS.custody !== c) return;
    const jobs = new Map();
    jobAt.forEach((x, i) => { const b = got2.get(jobAddr[i]); const j = b ? cust.decodeJob(b) : null; if (j) jobs.set(jobAddr[i], { facility: x.facility, job: j, owner: x.pool.owner }); });
    const caravans = new Map();
    // (fix-9-10-followups: an expected caravan read absent was closed on the road — a raider took it and delivered it —
    //  the lot still expects it until ReconcileLot; screens/custody.mjs tells that loss)
    const caravansGone = new Set();
    caravanAt.forEach((x, i) => { const b = got2.get(cvAddr[i]); const cv = b ? cust.decodeCaravan(b) : null; if (cv && cv.custody !== 0) caravans.set(cvAddr[i], { ...cv, vault: x.vault, qtyLeft: x.qty ?? null }); else if (got2.has(cvAddr[i]) && b === null && x.vault) caravansGone.add(x.seq); });
    Object.assign(c, { holdings, vaults, lots, pools, jobs, caravans, caravansGone, read: 'ok' });
    for (const [, cv] of caravans) c.custodySeqs.add(cv.seq);
    for (const s of c.sent ?? []) c.custodySeqs.add(s.seq);
    custodyTellLosses(c);
  } catch (e) { console.error('frontier custody read:', e); if (c.read !== 'ok') c.read = 'failed'; }
  invalidate('panel');
}
/** A loss the viewer has not been told of yet: one notice, from the viewer's side (the card keeps saying it). */
function custodyTellLosses(c) {
  for (const x of custodyLosses(FS)) {
    if (c.told.has(x.key)) continue;
    c.told.add(x.key);
    setNotice({ ok: false, loss: true, retry: false, text: x.text });
  }
}
const cplace = d => ({ p: dnum(d, 'p'), q: dnum(d, 'q'), tile: dnum(d, 'tile'), gen: dnum(d, 'gen') });
const cfac = d => ({ p: dnum(d, 'p'), q: dnum(d, 'q'), site: dnum(d, 'site'), gen: dnum(d, 'gen') });
const custodyOff = () => (!rightsLaneOn() ? failed({ code: 'LocalActNotAllowed' }) : null);
const custodyAct = (name, v, fields, say) => act(name, { v, fields, say, after: () => refreshCustody() });
/** A custody caravan (DepositLot) or a withdrawal (WithdrawLot): the route from `from` to `to`, as SendCaravan plans it. */
async function custodyWalk(from, to) {
  if (!Number.isInteger(from.tile) || !Number.isInteger(to.tile)) return null;
  busy(() => L`道を探しています…`);
  const plan = fastestPath({ p: from.p, q: from.q, tile: from.tile }, { p: to.p, q: to.q, tile: to.tile }, await landsFor(from, to));
  return plan && plan.dirs.length ? plan : null;
}
async function custodyDeposit(f) {
  const off = custodyOff(); if (off) return off;
  const d = f.dataset, qty = Math.trunc(formNum(f, 'qty')), h = activeHolding(FS);
  if (!h || !Number.isInteger(h.tile)) return s1Refused(L`鉱石を出す村を選んでください`);
  if (!(qty > 0)) return s1Refused(L`運ぶ鉱石の量を入れてください`);
  const vault = cplace(d);
  const plan = await custodyWalk(h, vault);
  if (!plan) return s1Refused(L`そこまで隊商の道が届きません（${fmtNum(MAX_PATH_STEPS)} マス・${fmtNum(MAX_PATH_PROVINCES)} 州まで）`);
  const seq = Number(FS.citizen?.caravans ?? 0);
  const src = { kind: 'holding', p: h.p, q: h.q, site: h.site, gen: h.gen ?? 0 };
  return act('DepositLot', { v: { seq, src, vault, provinces: plan.provinces }, fields: { seq, qty, steps: plan.dirs.length, path: pack(plan.dirs), fee: CARAVAN_FEE },
    say: () => L`鉱石を預けに隊商が出発しました`, after: x => { if (x?.ok !== false && FS.custody) (FS.custody.sent ??= []).push({ seq, vault }); return refreshCustody(); } });
}
async function custodyWithdraw(f) {
  const off = custodyOff(); if (off) return off;
  const d = f.dataset, qty = Math.trunc(formNum(f, 'qty')), h = activeHolding(FS);
  if (!h || !Number.isInteger(h.tile)) return s1Refused(L`鉱石を受け取る村を選んでください`);
  if (!(qty > 0)) return s1Refused(L`運ぶ鉱石の量を入れてください`);
  const vault = cplace(d);
  const plan = await custodyWalk(vault, h);
  if (!plan) return s1Refused(L`そこまで隊商の道が届きません（${fmtNum(MAX_PATH_STEPS)} マス・${fmtNum(MAX_PATH_PROVINCES)} 州まで）`);
  const seq = Number(FS.citizen?.caravans ?? 0);
  const dst = { kind: 'holding', p: h.p, q: h.q, site: h.site, gen: h.gen ?? 0 };
  return custodyAct('WithdrawLot', { seq, vault, dst, provinces: plan.provinces }, { seq, qty, steps: plan.dirs.length, path: pack(plan.dirs), fee: CARAVAN_FEE },
    () => L`預けた鉱石を引き取る隊商が出発しました`);
}
function custodyOpenLot(f) {
  const off = custodyOff(); if (off) return off;
  const o = f?.elements?.pair?.selectedOptions?.[0]?.dataset;
  // (fix-loop9, LP9-7: the select starts empty when there are several people to choose from)
  if (!o?.owner) return s1Refused(L`貯蔵庫と預ける人を選んでください`);
  FS.ui = { ...FS.ui, custodyPair: o.owner };
  return custodyAct('OpenLot', { vault: cplace(o), owner: o.owner }, { quota: Math.trunc(formNum(f, 'quota')) }, () => L`預かりの枠を開きました`);
}
function capacityLend(f) {
  const off = custodyOff(); if (off) return off;
  const d = f.dataset;
  return custodyAct('OpenCapacityPool', { facility: cfac(d), open: d.open === '1' }, { policies: [...cust.POLICIES], lend: Math.trunc(formNum(f, 'units')), seq: dnum(d, 'seq') },
    () => L`工房を貸し出しました`);
}
function capacityGrant(f) {
  const off = custodyOff(); if (off) return off;
  const d = f.dataset, o = f?.elements?.user?.selectedOptions?.[0]?.dataset;
  if (!o) return s1Refused(L`工房を使わせる相手を選んでください`);
  const days = Math.max(1, Math.trunc(formNum(f, 'days'))), units = Math.trunc(formNum(f, 'units')), arms = Math.trunc(formNum(f, 'arms'));
  const from = Math.floor(now()), until = from + days * 86_400;
  return custodyAct('GrantCapacity', { facility: cfac(d), user: o.user }, { grant: dnum(d, 'grant'), max_units: units, max_output: String(arms * cust.MILLI), from: String(from), until: String(until) },
    () => L`工房を使う権利を出しました`);
}
async function capacityReserve(f) {
  const off = custodyOff(); if (off) return off;
  const d = f.dataset, units = Math.trunc(formNum(f, 'units')), arms = Math.trunc(formNum(f, 'arms'));
  if (!(units > 0 && arms > 0)) return s1Refused(L`工房の数と兵器の数を入れてください`);
  // (fix-loop15, LP15-8: the booking takes its ore and wood from the user's own storehouse in the same message, and a
  //  storehouse without them made the node refuse the whole message — 「チェーンのノードがこの命令を実行前に受け付けません
  //  でした」, nothing about materials. Said here, before anything is signed, from the herald's read of that storehouse:
  //  read once more first when it looks short (a caravan may just have been delivered). Not known → sent as before;
  //  the program checks it again either way)
  const vt = dnum(d, 'vtile'), storesNow = () => (FS.s1?.caravans?.vaults ?? []).find(v => v.p === dnum(d, 'p') && v.q === dnum(d, 'q') && v.tile === vt && Number(v.gen) === dnum(d, 'vgen'))?.stores ?? null;
  let lack = reserveShort(storesNow(), arms);
  if (lack) { try { await rereadS1(); } catch { /* the read before stands */ } lack = reserveShort(storesNow(), arms); }
  if (lack) return s1Refused(reserveShortText(lack, vt));
  const plan = cust.jobPlan({ units, arms, now: now() });
  return custodyAct('ReserveCapacity', { facility: cfac(d), vault: { p: dnum(d, 'p'), q: dnum(d, 'q'), tile: dnum(d, 'vtile'), gen: dnum(d, 'vgen') } },
    { grant: dnum(d, 'grant'), job: dnum(d, 'job'), units, start: String(plan.start), end: String(plan.end), max_output: String(plan.maxOutput), ore: plan.ore, wood: plan.wood, deposit: 0 },
    () => L`工房を予約し、鉱石と木材を入れました`);
}
const capJob = (name, d, say, extra = {}) => { const off = custodyOff(); if (off) return off; return custodyAct(name, { facility: cfac(d), ...extra }, { grant: dnum(d, 'grant'), job: dnum(d, 'job') }, say); };

async function wideHostStep(e, mem, { auto = false } = {}) {
    const g = localDepartGate();
    if (!g?.ok) return failed({ code: g?.code ?? 'LocalActNotAllowed' });
    const village = { p: String(e.holding.p), q: String(e.holding.q), site: Number(e.holding.site) };
    const { createWideHostPlanner } = await import('./flocalplay-wide-plan.mjs');
    const { fromBase64 } = await import('../sdk/bytes.mjs');
    const read = async addresses => {
      const j = await localAct.postLocalAct(g.relay, localAct.LOCAL_ACT_CONTEXT_PATH, { schema: 'frontier-local-play-act-wide-read-v1', addresses });
      return (j?.accounts ?? []).map(a => (a ? fromBase64(a.data_b64) : null));
    };
    // (fix-loop11, LP11-1 audit: a WideDepart SENT whose outcome was not known — counted as a march, kept below — is asked
    //  about first, by its signature (a read only). Refused on chain: it was no march — the count and the march memory go
    //  back to what they were and the card says why; still not known: nothing is planned this time (the host may be out)
    if (mem.departHeld) {
      const h = mem.departHeld;
      let s = null; try { s = await localAct.localActRead({ allowed: localDepartGate, lane: playLane()?.lane ?? localAct.LOCAL_LANE })(h.signature); } catch { s = null; }
      if (s?.ok && s.state === 'failed') {
        mem.departHeld = null; mem.wideDeparts = h.wideDeparts; mem.lastWideDepart = h.lastWideDepart;
        FS.ui = { ...FS.ui, wideHostSay: { kind: 'wait', wait: 'refused', programCode: s.programCode ?? null }, wideHostReady: false };
        if (Number(s.programCode) === 26) wideHostWait(mem, { reason: 'turn', lag: null }); else wideHostStopWait(mem);
        invalidate('panel');
        return failed({ ok: false, code: s.code ?? 'TransactionFailed', unsent: 'wide-host-step', retry: false, ...(Number.isInteger(s.programCode) ? { programCode: s.programCode } : {}) });
      }
      if (s?.ok && s.state === 'landed') mem.departHeld = null;
      else { if (auto || !mem.waiting) wideHostWait(mem, { reason: 'march', lag: null }); return { ok: false, code: 'WideHostWait', why: 'the last wide march was sent and is not confirmed yet', wait: 'march' }; }
    }
    const { followWideHold, markWideHoldExpedition } = await import('./flocalplay-wide-plan.mjs');
    const planner = createWideHostPlanner({ herald, read, chainNow: async () => Math.floor(now()), chainRate: () => FS.chain?.rate ?? 1 });
    let w;
    try { w = await planner.decide(localPlay, mem, { wideTargets: localPlay.wideLand.targets, villages: [village] }); } catch (x) { w = { why: String(x?.message ?? x).slice(0, 200) }; }
    // (fix-loop6, LP6-15: `wideHostSay` — what the card says, in the page's language (screens/wideholding.mjs
    //  wideHostSayText); `wideHostWhy` stays the planner's own words, for the logs and the card's title only)
    // (fix-loop7, LP7-5: the keep's hold by this page's own march, followed to its end — taken or lost)
    if (w.march) mem.wideHold = followWideHold(mem.wideHold ?? null, w.march);
    // (fix-loop10, LP10-2: and whose hold it is — a kept expedition of the player's standing in that province took or
    //  holds the keep, not this village's later host: the card says so instead of 「砦を奪いました」)
    if (w.march && mem.wideHold) { try { mem.wideHold = markWideHoldExpedition(mem.wideHold, localExpedition.holdingExpeditions(FS)); } catch { /* the expedition records are not read: the hold as it is */ } }
    FS.ui = { ...FS.ui, wideHostWhy: w.decision?.why ?? w.why ?? null, wideHostSay: { ...wideHostSayOf(w), hold: mem.wideHold ?? null },
      wideHostAct: w.decision ? { name: w.decision.name, to: w.decision.to ?? null, arrive: w.decision.fields?.arrive_bell ?? null } : null };
    invalidate('panel');
    // (fix-loop8, LP8-5: after the keep was TAKEN, the card is followed LOOK-ONLY — a next cycle (train, muster, march) is
    //  the person's to start: when the planner has a step again, nothing is sent by itself; the button comes back with
    //  「次の一手を送れます」. loop-play8: the button re-enabled 26 times after the capture and each press sent nothing)
    if (w.decision && !w.decision.rebuild && auto && mem.waiting?.reason === 'captured') { wideHostStopWait(mem); FS.ui = { ...FS.ui, wideHostReady: true }; invalidate('panel'); return { ok: false, code: 'WideHostReady' }; }
    // (fix-loop9, LP9-1: after a lost march — every host at home under the march minimum — the card says the result and
    //  OFFERS the new host's first step once (train, then muster): it is not sent by itself while the card waits. A press
    //  sends it; the later steps of that new host go on as the first host's did. loop-play9: stuck for good on 「整列中」)
    // (w2-wipeout, D-verify-pr137-3: the same once the host was wiped out or became a keep's garrison. The offer comes
    //  FIRST on a person's press too: a press that met a march's end for the first time sent the new host's step before
    //  the card had said what happened; now that press shows the result and the offer, and the next press sends)
    if (w.decision?.rebuild) {
      const key = `${mem.lastWideDepart?.arrive ?? 'none'}`;
      if (mem.rebuildOffered !== key) { mem.rebuildOffered = key; wideHostStopWait(mem); FS.ui = { ...FS.ui, wideHostReady: 'rebuild' }; invalidate('panel'); return { ok: false, code: 'WideHostReady' }; }
    }
    FS.ui = { ...FS.ui, wideHostReady: false };
    if (!w.decision && w.wait === 'march' && mem.wideHold?.outcome === 'taken') { wideHostWait(mem, { reason: 'captured', lag: w.lag ?? null, hold: mem.wideHold }); return { ok: false, code: 'WideHostWait', why: w.why, wait: w.wait ?? null }; }
    if (!w.decision) {
      // (the province lags, the host forms, the village is not final yet: wait here, ask again about once a turn)
      // (fix-loop6, LP6-5: a march on its way or being decided is looked at again too, so its result shows by itself)
      if (WIDE_HOST_AUTO_WAIT.includes(w.wait) || (w.wait === 'march' && ['out', 'settling', 'unread'].includes(w.march?.phase))) wideHostWait(mem, { reason: w.wait === 'march' ? 'march' : w.wait, lag: w.lag ?? null });
      // (fix-loop7, LP7-5: a host standing on the keep while its nation's hold counts is followed too, about once a turn,
      //  until the keep is taken or the hold is lost — the card stopped reading at 「占拠中です：20 / 72 ターン」)
      else if (w.wait === 'march' && w.march?.phase === 'stands' && mem.wideHold && !mem.wideHold.outcome) wideHostWait(mem, { reason: 'hold', lag: null, hold: mem.wideHold });
      else wideHostStopWait(mem);
      return { ok: false, code: 'WideHostWait', why: w.why, wait: w.wait ?? null };
    }
    const d = w.decision;
    const noticeBefore = FS.notice;
    const r = await act(d.name, { v: d.v, fields: d.fields, say: () => wideHostDoneText(wideHostSayOf(w)) });
    // (verify-pr184, live: a W2 step the chain refused — WideMuster NotResident — was told as 「訓練はまだされていません。」
    //  with 「もう一度」, both from FS.lastAct: the person's last FORM press, a train at the rim village. That retry would
    //  have trained again there. The refusal is the W2 step's: its own words, and no retry — the card's wait sends again)
    if (FS.notice !== noticeBefore && FS.notice && !FS.notice.ok && !FS.notice.busy && !FS.notice.waiting) setNotice({ ...FS.notice, unsent: 'wide-host-step', retry: false });
    mem.decisions = (mem.decisions ?? 0) + 1;
    // (`act` answers a refusal with its notice — FS.notice — not with a result)
    const n = r === undefined ? FS.notice : r;
    // (w2-wipeout, live world B turn 473: a WideDepart REFUSED as the turn rolled under it — NotResident — came back as
    //  `undefined`, which `r?.ok !== false` counted as a march: wideDeparts 2 = the TEST cap with no second march sent,
    //  and lastWideDepart pointed at a march that never left. Only a send that was not refused counts)
    // (fix-loop11, LP11-1 audit: a WideDepart SENT whose outcome is not known yet — `LocalActUnconfirmed`, held by its
    //  signature — may be out: it counts, and is asked about at the next step — refused on chain, it is taken back)
    const heldDepart = n?.ok === false && n.sent === true && n.code === 'LocalActUnconfirmed' && typeof n.signature === 'string';
    if (heldDepart && d.name === 'WideDepart') mem.departHeld = { signature: n.signature, wideDeparts: mem.wideDeparts ?? 0, lastWideDepart: mem.lastWideDepart ?? null };
    if ((n?.ok !== false || heldDepart) && d.name === 'WideDepart') {
      mem.wideDeparts = (mem.wideDeparts ?? 0) + 1;
      // (fix-loop6, LP6-5: kept so the card can follow the march to its result — flocalplay-wide-plan marchState)
      if (d.to && Number.isInteger(d.fields?.arrive_bell)) mem.lastWideDepart = { to: d.to, arrive: d.fields.arrive_bell, troops: d.troops ?? null };
    }
    mem.wideHostUntil = mem.decisions;
    // (refused BEFORE it was sent because the turn rolled under it — NotResident 26 — : wait a turn and try again
    //  by itself; any other answer ends the waiting and is shown as it is)
    if (n?.ok === false && (Number(n.programCode) === 26 || n.code === 'NotResident' || n.code === 26)) wideHostWait(mem, { reason: 'turn', lag: null });
    else if (heldDepart && d.name === 'WideDepart') wideHostWait(mem, { reason: 'march', lag: null });
    else wideHostStopWait(mem);
    return r;
}

/**
 * (fix-loop14, LP14-15) What the notice says once a W2 step has landed, in the page's language: the step was told with
 * the planner's own log words (`decision.why`, English: "train 100 Spearmen at the wide village -64,-65 toward a new
 * host (reserve 0; …)") on a Japanese page too. `say`: wideHostSayOf's facts of the decision.
 */
export function wideHostDoneText(say) {
  const at = x => (x ? `${x.p},${x.q}` : '?');
  if (say?.name === 'WideTrain') return L`広い土地の村（州 ${at(say.village)}）で槍兵 ${fmtNum(Number(say.n ?? 0))} を訓練しました。`;
  if (say?.name === 'WideMuster') return L`広い土地の村（州 ${at(say.village)}）で槍兵 ${fmtNum(Number(say.troops ?? 0))} の軍勢の編成を命じました。`;
  if (say?.name === 'WideDepart') return L`軍勢（兵 ${fmtNum(Number(say.troops ?? 0))}）が州 ${at(say.to)} の砦へ進軍しました。到着はターン ${fmtNum(Number(say.arrive ?? 0))} です。`;
  return L`広い土地の村の次の一手を送りました。`;
}

/** (fix-loop6, LP6-15) The planner's answer as plain facts for the card to put in words (screens/wideholding.mjs wideHostSayText). */
function wideHostSayOf(w) {
  const d = w?.decision;
  if (d) return { kind: 'decision', name: d.name, n: d.fields?.n ?? null, troops: d.fields?.troops ?? d.troops ?? null, arrive: d.fields?.arrive_bell ?? null,
    to: d.to ? { p: String(d.to.p), q: String(d.to.q), holder: d.to.holder ?? null } : null, village: d.v?.wide ? { p: String(d.v.wide.p), q: String(d.v.wide.q) } : null,
    // (fix-loop9, LP9-1: a new host after a lost march — the last march's result and the troops that came home)
    ...(d.rebuild ? { rebuild: true, march: w.march ?? null, home: w.home ?? null, ...(w.ended ? { ended: w.ended } : {}) } : {}) };
  return { kind: 'wait', wait: w?.wait ?? null, lag: w?.lag ?? null, march: w?.march ?? null, why: w?.why ?? null, ...(w?.cap ? { cap: w.cap } : {}) };
}
// (fix-loop5, L5-1) the wide village card's waiting (TEST-ONLY wide -> wide play): one timer, about one turn apart
// (10–60 s of real time), at most WIDE_HOST_WAIT_MAX asks; stopped by 「待つのをやめる」, a sent step, or another answer.
export const WIDE_HOST_AUTO_WAIT = Object.freeze(['lag', 'host', 'village', 'turn']);
export const WIDE_HOST_WAIT_MAX = 360;
const wideHostTurnMs = () => { const rate = FS.chain?.accelerated ? Number(FS.chain.rate) : 1; return Math.min(60_000, Math.max(10_000, Math.round(BELL_SECS * 1000 / (rate > 0 ? rate : 1)))); };
function wideHostWait(mem, { reason, lag, hold = null }) {
  clearTimeout(mem.timer);
  // (fix-loop7: a hold of 72 turns is followed from its first turn: the count of asks starts again when the waiting
  //  turns into following the hold)
  const fresh = reason === 'hold' && mem.waiting?.reason !== 'hold';
  mem.waiting = { reason, lag, hold, since: fresh ? now() : mem.waiting?.since ?? now(), asks: (fresh ? 0 : mem.waiting?.asks ?? 0) + 1 };
  if (mem.waiting.asks > WIDE_HOST_WAIT_MAX) { wideHostStopWait(mem); return; }
  mem.timer = setTimeout(() => { mem.timer = null; ACTIONS['wide-host-step']({ auto: true }).catch(x => console.error('wide host wait:', x)); }, wideHostTurnMs());
}
function wideHostStopWait(mem) { clearTimeout(mem.timer); mem.timer = null; mem.waiting = null; }

export const ACTIONS = {
  // ② rights (TEST-ONLY, a coexist local world only: screens/rights.mjs)
  'rights-read': () => refreshRights(),
  'rights-execute': d => rightsUse('ExecuteSwap', d, { seq: dnum(d, 'seq') }),
  'rights-release': d => rightsUse('ReleaseSwap', d),
  'rights-revoke': d => rightsUse('RevokeGrant', d),
  'rights-close': d => rightsUse('CloseGrant', d),
  'rights-deliver': d => rightsDeliver(d),
  // ⑨ capacity · ⑩ custody (TEST-ONLY preview, a coexist local world only: screens/custody.mjs)
  'custody-read': () => refreshCustody(),
  'cap-reclaim': d => { const off = custodyOff(); if (off) return off; return custodyAct('ReclaimCapacity', { facility: cfac(d) }, { units: dnum(d, 'units'), seq: dnum(d, 'seq') }, () => L`工房を取り戻しました`); },
  'cap-revoke': d => { const off = custodyOff(); if (off) return off; return custodyAct('RevokeCapacity', { facility: cfac(d) }, { grant: dnum(d, 'grant') }, () => L`工房を使う権利を取り消しました`); },
  'cap-settle': d => capJob('SettleJob', d, () => L`作業の進みを記録しました`),
  'cap-cancel': d => capJob('CancelJob', d, () => L`作業を取り消しました`),
  'cap-claim': d => capJob('ClaimJob', d, () => L`兵器と残りの材料が貯蔵庫に入りました`, { vault: { p: dnum(d, 'p'), q: dnum(d, 'q'), tile: dnum(d, 'vtile'), gen: dnum(d, 'vgen') } }),
  'cap-loss': d => { const off = custodyOff(); if (off) return off; return custodyAct('RecordFacilityLoss', { facility: cfac(d), jobs: String(d.jobs ?? '').split('.').filter(Boolean).map(x => { const [g, j] = x.split('_').map(Number); return { grant: g, job: j }; }) }, {}, () => L`工房の村が失われたことを記録しました`); },
  'lot-deliver': d => { const off = custodyOff(); if (off) return off; return custodyAct('SettleCustody', { seq: dnum(d, 'seq'), vault: cplace(d), owner_tag: String(d.owner), provinces: String(d.path ?? '').split('.').filter(Boolean).map(x => { const [p, q] = x.split('_').map(Number); return { p, q }; }) }, {}, () => L`預ける鉱石が届きました`); },
  'lot-reconcile': d => { const off = custodyOff(); if (off) return off; return custodyAct('ReconcileLot', { vault: cplace(d), owner_tag: String(d.owner), caravans: String(d.caravans ?? '').split('.').filter(Boolean).map(x => { const [t, q] = x.split('_'); return { tag: t, seq: Number(q) }; }) }, {}, () => L`預かりの帳簿を確かめました`); },
  'lot-close': d => { const off = custodyOff(); if (off) return off; return custodyAct('CloseLot', { vault: cplace(d), owner_tag: String(d.owner), rent_to: String(d.rent) }, {}, () => L`預かりの枠を閉じました`); },
  'cq-refresh': () => refreshConquest(),
  // (the stale banner on local play: a read of the latest state — never a reload, never a send)
  'state-reread': () => rereadState(),
  // S1 (screens/s1.mjs)
  's1-vault': d => s1Build('BuildVault', 0, s1Tile(d)),
  's1-structure': d => s1Build('BuildStructure', num(d.kind), s1Tile(d)),
  's1-raid': d => s1Raid(d),
  's1-raid-open': d => s1RaidOpen(d),
  's1-seize': d => s1Seize(d),
  's1-siege': d => s1Siege(d),
  's1-expel': d => {
    const o = expelOffer(FS, { p: num(d.p), q: num(d.q), idx: FS.provinces.get(`${num(d.p)},${num(d.q)}`)?.province?.sites?.[num(d.site)] });
    if (!o) return s1Refused(L`この村は追放を提案できません`);
    if (o.blocks[0] === 'TargetExpelled') return s1Refused(expelBlockText('TargetExpelled'));
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
    // (round 28: a host of another village is composed from its own village — as the map tap and 「村へ戻す」 already do —
    //  instead of being silently not found; in local play its own march answer is asked first, as its send will ask it,
    //  and a refusal is said before any order is drafted — and before the village is switched, so a refusal leaves the
    //  page as it was. The order still fixes its village; the send still checks it.)
    const hi = holdingIndexOfHost(d.host);
    if (localPlay && localMarchFor(hi !== null ? FS.holdings[hi] : activeHolding(FS), d.host)?.open !== true) return failed(localPlayReadOnly());
    if (hi !== null && hi !== (FS.activeHolding ?? 0)) { FS.activeHolding = hi; invalidate('rail'); }
    if (!ACTIONS.compose({host:d.host,stay:'map'})) return;
    FS.tab = 'map'; FS.compose.stance = FS.conquest?.keeps.get(`${d.p},${d.q}`)?.holder === FS.citizen?.faction ? 0 : 1;
    await setDestination({p:num(d.p),q:num(d.q),tile:num(d.tile)});
  },
  // (devnet-page-outpost: on a devnet page that carries FileOutpost the map's 「前哨を築く」 opens the village card's preview
  //  instead — the wallet pays, so the cost is shown first and a second press sends; never a one-press send there)
  'cq-outpost': d => (devnetPlay && devnetPlayMod.devnetOutpostOn(devnetPlay) ? outpostFromMap(d) : homeAction(async () => {
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
  })),
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
  // (2026-11-17, ⑦: the candidates for the first village read again, in another order — reads only, never refresh)
  'home-reread': () => { rereadHomes().catch(e => console.error('frontier home reread:', e)); },
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
    const still = homeJoinStill; homeJoinStill = null;   // (asked by confirmHome: is that confirm still its own?)
    // LOCAL PLAY: no in-game key is derived, remembered or registered. The page's memory-only wallet signs the Join
    // itself and is the only key the Citizen will ever have (flocalplay-act.mjs writes the wallet as the Join's
    // session key). A Season with a prize pool or a join gate is not served there.
    // (DEVNET PLAY: the same — the connected wallet signs the Join and is its session key; no key is derived or kept)
    if (localPlay || devnetPlay) {
      if (FS.prize || FS.season?.joinGate?.some?.(x => x !== 0)) return failed(localPlayReadOnly());
      return act('Join', { v: { faction: FS.joinDraft.faction }, fields: { faction: FS.joinDraft.faction, session_expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) },
        // (the note carries the scope the Join was SENT under: it is asked about again only at that relay, for that wallet and world)
        onSent: (r, sentUnder) => { if (FS.homeChoice?.busy) saveHomePatch({ pending: { kind: 'Join', signature: r.signature, ...(typeof sentUnder?.scope === 'string' ? { scope: sentUnder.scope } : {}) } }); },
        onLost: () => { if (FS.homeChoice?.busy) saveHomePatch({ pending: null }); } });
    }
    const pin = io.pinned();
    let s;
    try { s = await fsession.derive({ wallet: wallet.connected(), cluster: pin.cluster, programId: pin.programId, seasonId: pin.seasonId }); } catch (e) { return failed({ code: e.code ?? 'SignFailed' }); }
    // (2026-11-17, ⑦: asked for by a confirm that is no longer its own — another wallet, NFT, herald or world while the
    //  key was derived —: the key is not remembered, nothing is sent, nothing is said on the page as it is now)
    if (still && !still()) return { ok: false, code: 'ContextChanged' };
    fsession.remember(s);
    FS.session = s;
    // (the note of this Join — only for a Join that is part of a first village's confirm, as before — is written in the
    //  home record of THIS moment: no wait stands between here and the wallet the Join is signed with (act → actOnce,
    //  paidJoin), so it is the record of the wallet and world the Join is sent for, whatever the page becomes before
    //  the send answers. It is let go on the chain's own "failed / expired", if it is still this send's)
    const noteAt = FS.homeChoice?.busy ? homeNoteNow() : null, noteSent = new Set();
    const lifecycle = { onSent: r => { if (noteAt) { noteSent.add(r.signature); saveHomeAt(noteAt, { pending: { kind: 'Join', signature: r.signature } }); } },
      onLost: () => dropHomeNote(noteAt, noteSent) };
    // A season with a prize pool: the entry fee and the Join in one transaction (x402).
    if (FS.prize) return paidJoin(s, lifecycle);
    const gate = FS.season.joinGate.some(x => x !== 0) ? toBase58(FS.season.joinGate) : null;
    return act('Join', { v: { faction: FS.joinDraft.faction, joinGate: gate, invite: FS.joinDraft.invite },
      fields: { faction: FS.joinDraft.faction, session: s.publicKeyBytes, session_expiry: BigInt(Math.floor(now()) + SESSION_DAYS - 600) },
      onSent: lifecycle.onSent, onLost: lifecycle.onLost });
  },
  // Q16-3: "re-make the key" restores this device's key and registers it only where nobody else's key is replaced
  // (none registered, or this wallet's own, expired). A key registered to another holder — ③'s courier, the owner's
  // agent, another app or device — is never replaced from here: the page then shows the warning, and the replacement
  // is `session-replace`, the owner's own choice for the key that was shown.
  session: () => setSession(),
  'session-replace': d => setSession({ replace: String(d?.key ?? '') }),
  // the action bar's "look and choose" (a village owner never sees the drawer's key card): opens the whole warning on
  // the bar, keep first; pressed again it closes. Nothing is signed or sent (verify-pr61 F2)
  'session-review': () => {
    const held = delegationOf(FS);
    FS.keyReview = held?.foreign && FS.keyReview !== held.agentKey ? held.agentKey : null;
    if (FS.keyReview) FS.keyKept = null;
    invalidate('panel');
  },
  // keeping the delegation, said explicitly (pressed again: the choice is reopened); nothing is signed or sent
  'session-keep': () => {
    const held = delegationOf(FS);
    FS.keyKept = held?.foreign && FS.keyKept !== held.agentKey ? held.agentKey : null;
    FS.keyReview = null;
    if (FS.keyKept && FS.notice?.code === 'SessionHeldElsewhere') FS.notice = null;
    invalidate('panel');
  },
  // the site picker is gone (owner decision V2): the client files the ticket itself; a retry now
  'auto-ticket': () => autoTicket({ force: true }),
  // (TEST-ONLY wide play, local wide-land worlds only: the wide claim from the first home — screens/holding.mjs wideClaimCard)
  // (verify-pr206-209) a TERRITORY world's single tile, from the village card's province row: one free tile of that
  // province (not a village site, not the keep's, not already this page's), instant, paid in ore by the first home,
  // one a turn — whatever the next village's cost. The same reach witness as the row's village; the nearest own
  // village names the upkeep distance (TQ-2). A tile another player owns moves the next press on; "already yours"
  // is remembered.
  // (world goal ②, research — hud/research.mjs villageResearchCard: the first press says what is given and that it does
  //  not come back; the second signs and sends. The apply copies the nation's techs into the village (anyone may send it))
  'research-arm': d => {
    const h = activeHolding(FS);
    if (!h) return;
    FS.ui = { ...(FS.ui ?? {}), researchArm: { at: `${h.p},${h.q},${h.site}`, tech: num(d.tech), amount: num(d.amount) } };
    invalidate('panel');
  },
  'research-cancel': () => { FS.ui = { ...(FS.ui ?? {}), researchArm: null }; invalidate('panel'); },
  'research-pledge': async d => {
    const h = activeHolding(FS), me = FS.citizen?.faction;
    const arm = FS.ui?.researchArm ?? null;
    FS.ui = { ...(FS.ui ?? {}), researchArm: null };
    if (!h || !Number.isInteger(me) || !arm || arm.at !== `${h.p},${h.q},${h.site}` || arm.tech !== num(d.tech) || arm.amount !== num(d.amount)) { invalidate('panel'); return; }
    const name = techName(TECHS[arm.tech]?.key);
    const t = await act('ResearchPledge', { v: { holding: { p: h.p, q: h.q, site: h.site }, nation: me }, fields: { tech: arm.tech, amount: arm.amount },
      say: () => L`科学 ${fmtNum(arm.amount)} を「${name}」に差し出しました（残りの費用を超える分は村に残ります）。` });
    researchRefused(t ?? (FS.notice?.ok === false ? FS.notice : null));
    invalidate('panel');
    return t;
  },
  'research-apply': async () => {
    const h = activeHolding(FS), me = FS.citizen?.faction;
    if (!h || !Number.isInteger(me)) return;
    const t = await act('ResearchApply', { v: { holding: { p: h.p, q: h.q, site: h.site }, nation: me }, fields: {}, say: () => L`国が覚えた技術の効果が、この村に届きました。` });
    researchRefused(t ?? (FS.notice?.ok === false ? FS.notice : null), { apply: true });
    invalidate('panel');
    return t;
  },
  'territory-tile': async d => {
    const h = activeHolding(FS);
    if (!h || !(localPlay?.wideLand || devnetTerritoryNow())) return;
    const target = { p: String(d.p), q: String(d.q) };
    const reach = d.rp !== undefined && d.rq !== undefined ? { p: String(d.rp), q: String(d.rq) } : null;
    let terr = null;
    try { const r = await herald.wideRoute({ places: [target] }); terr = r?.ok !== false ? territoryOfRoute(r?.json ?? r).get(`${target.p},${target.q}`) ?? null : null; } catch { terr = null; }
    if (!terr) return failed({ code: 'NoTerritory', text: L`この州ではマスを取れません（自分の土地のない世界か、州が読めませんでした）。` });
    const mine = FS.ui?.ownTiles ?? {}, triedKey = `t:${target.p},${target.q}`, from = num(FS.ui?.wideTried?.[triedKey] ?? 0);
    const blocked = new Set([...terr.siteTiles, terr.keepTile]);
    let tile = null;
    for (let i = Math.max(0, from); i < 61; i++) if (!blocked.has(i) && !mine[`${target.p},${target.q},${i}`]) { tile = i; break; }
    if (tile === null) return failed({ code: 'NoFreeTile', text: L`この州に取れるマスは残っていません。` });
    const home = { p: h.p, q: h.q, site: h.site }, key = `${target.p},${target.q},${tile}`;
    const vill = nearerOwnVillage(home, target, fwide.wideSlots(FS).filter(e => e.holding).map(e => ({ p: e.holding.p, q: e.holding.q, site: e.holding.site })));
    // (devnet-territory-dev: on devnet the first press is the cost preview — ore + SOL —, the next one signs and sends)
    if (devnetTerritoryNow() && !localPlay && !(await devnetTilePreviewGate(target, tile, { act: 'territory-tile', data: d }))) return { ok: false, quiet: true };
    if (devnetTerritoryNow() && !localPlay) FS.tilePreview = null;
    const t = await act('TerritoryClaim', { v: { holding: home, target, ...(reach ? { witness: { kind: 'nation', p: reach.p, q: reach.q } } : {}), ...(vill ? { village: vill } : {}) }, fields: { tile },
      say: () => L`広い土地（${target.p}, ${target.q}）のマス ${tile} を自分の土地にしました。` });
    const ans = t ?? (FS.notice?.ok === false ? FS.notice : null);
    const pc = Number(ans?.programCode), why = String(ans?.code ?? '') + ' ' + String(ans?.detail ?? '');
    const already = !!ans && ans.ok === false && (pc === 52 || /AlreadyDone/.test(why));
    const taken = !!ans && ans.ok === false && !already && (pc === 11 || /SiteTaken/.test(why));
    territoryRefused(ans);
    if ((t && t.ok !== false) || already) FS.ui = { ...(FS.ui ?? {}), ownTiles: { ...mine, [key]: true } };
    if (taken || already) FS.ui = { ...(FS.ui ?? {}), wideTried: { ...(FS.ui?.wideTried ?? {}), [triedKey]: tile + 1 } };
    invalidate('panel');
    return t;
  },
  'wide-claim': async d => {
    const h = activeHolding(FS);
    if (!h || !(localPlay?.wideLand || devnetWideNow())) return;
    const target = { p: String(d.p), q: String(d.q) }, slot = num(d.slot);
    // (expansion-gameplay-1: a target reached through the nation's land names that province as the reach witness;
    //  local wide worlds only — the devnet program takes no witness)
    const reach = localPlay?.wideLand && d.rp !== undefined && d.rq !== undefined ? { p: String(d.rp), q: String(d.rq) } : null;
    // (devnet-territory-dev: a devnet territory world runs the program of #206 — it takes the witness too)
    const reachD = !reach && devnetTerritoryNow() && d.rp !== undefined && d.rq !== undefined ? { p: String(d.rp), q: String(d.rq) } : null;
    // (a slot-3 claim: the slot-2 wide village as the previous pair — wideClaimIntent requires it)
    const previous = slot === 3 && d.pp !== undefined ? { p: String(d.pp), q: String(d.pq), site: num(d.ps) } : null;
    // (a claim names a FREE site of the province as the herald last captured it — any other is "taken" at its settle,
    //  the cost spent for nothing; flocalplay-wide.mjs freeWideSites. None known: nothing is sent)
    let site = num(d.site), terr = null;
    try {
      const r = await herald.wideRoute({ places: [target] });
      const free = r?.ok !== false ? freeWideSites(r?.json ?? r)?.get(`${target.p},${target.q}`) : null;
      if (Array.isArray(free)) { const next = free.find(x => x >= site) ?? free[0]; if (next === undefined) { failed({ code: 'NoFreeHome', text: L`この州には空いている村の場所がありません。` }); return; } site = next; }
      // (territory-impl, owner 2026-11-24 12:09 T-6: in a territory world the village stands on your own tile)
      terr = r?.ok !== false ? territoryOfRoute(r?.json ?? r).get(`${target.p},${target.q}`) ?? null : null;
    } catch { /* the herald did not answer: the card's own site, as before */ }
    const home = { p: h.p, q: h.q, site: h.site };
    if (terr) {
      // first press: the site's tile (one tile a turn, paid in ore by the first home; the same reach witness);
      // the next press — the tile yours — the village on it, naming the territory record (flocalplay-wide.mjs)
      const tile = terr.siteTiles[site], key = `${target.p},${target.q},${tile}`;
      const mineTiles = FS.ui?.ownTiles ?? {};
      if (!mineTiles[key]) {
        // (owner TQ-2: the upkeep distance is from the NEAREST own village — an own wide village nearer than home is named)
        const vill = nearerOwnVillage(home, target, fwide.wideSlots(FS).filter(e => e.holding).map(e => ({ p: e.holding.p, q: e.holding.q, site: e.holding.site })));
        const rw = reach ?? reachD;
        // (devnet-territory-dev: on devnet the site's tile is previewed first — ore + SOL —, then signed and sent)
        if (devnetTerritoryNow() && !localPlay && !(await devnetTilePreviewGate(target, tile, { act: 'wide-claim', data: d }))) return { ok: false, quiet: true };
        if (devnetTerritoryNow() && !localPlay) FS.tilePreview = null;
        const t = await act('TerritoryClaim', { v: { holding: home, target, ...(rw ? { witness: { kind: 'nation', p: rw.p, q: rw.q } } : {}), ...(vill ? { village: vill } : {}) }, fields: { tile }, say: () => L`広い土地（${target.p}, ${target.q}）のマスを自分の土地にしました。もう一度押すと、そこに村を出します。` });
        // (a refusal returns nothing — failed() only sets the notice — so the answer is read there; verify-pr206-209:
        //  "already yours" (52) after a reload or a refused village never reached the village, and a tile another
        //  player owns (SiteTaken 11) was asked again at every press)
        const ans = t ?? (FS.notice?.ok === false ? FS.notice : null);
        const pc = Number(ans?.programCode), why = String(ans?.code ?? '') + ' ' + String(ans?.detail ?? '');
        const already = !!ans && ans.ok === false && (pc === 52 || /AlreadyDone/.test(why));
        const taken = !!ans && ans.ok === false && !already && (pc === 11 || /SiteTaken/.test(why));
        territoryRefused(ans);
        if ((t && t.ok !== false) || already) { FS.ui = { ...(FS.ui ?? {}), ownTiles: { ...mineTiles, [key]: true } }; invalidate('panel'); }
        if (taken) { FS.ui = { ...(FS.ui ?? {}), wideTried: { ...(FS.ui?.wideTried ?? {}), [`${target.p},${target.q}`]: Math.min(11, site + 1) } }; invalidate('panel'); }
        if (!already) return t;
      }
    }
    const r = await act('WideClaim', { v: { holding: home, target, ...(reach && !terr ? { reach } : {}), ...(previous ? { previous } : {}), ...(terr ? { territory: true } : {}) }, fields: { site, slot }, say: () => L`広い土地（${target.p}, ${target.q}）に村の申し込みを出しました。ターンの終わりに決まります。` });
    // (a refused or failed site is not offered again: the next press names the next site)
    if (r && r.ok === false && r.sent !== true) { FS.ui = { ...(FS.ui ?? {}), wideTried: { ...(FS.ui?.wideTried ?? {}), [`${target.p},${target.q}`]: Math.min(11, site + 1) } }; invalidate('panel'); }
    return r;
  },
  // DEVNET PLAY (devnet-page-outpost): the second/third village card (screens/outpostcard.mjs) — wallet-paid, two presses.
  // 1. scan: the herald's record of each nearby province (open, or not opened yet); 2. preview: what the wallet pays (the
  // gateway's rent of the Holding the ticket escrows + the fee, in SOL) and the settler cost, nothing signed; 3. send: the
  // checks again, then ONE wallet-signed FileOutpost through the devnet lane (act → flocalplay-act.mjs).
  'outpost-scan': () => homeAction(async () => {
    const h = activeHolding(FS);
    if (!h || !devnetPlayMod.devnetOutpostOn(devnetPlay) || devnetGate().ok !== true) return failed({ code: devnetGate().code ?? 'DevnetPlayOff' });
    busy(() => L`近くの州を調べています…`);
    const c = FS.season?.conquestParams ?? FS.season ?? {};
    for (const x of outpostCandidates({ p: h.p, q: h.q }, { heartland: Number(c.heartlandMaxRing ?? 3), range: Number(c.outpostRange ?? 3) })) {
      FS.provinceReads?.delete?.(`${x.p},${x.q}`);
      await loadEnvelope(x.p, x.q).catch(() => null);
    }
    const walletAddress = FS.wallet?.address;
    const me = walletAddress ? await herald.me(walletAddress).catch(() => ({ ok: false })) : { ok: false };
    if (me.ok && FS.wallet?.address === walletAddress) { FS.citizen = me.citizen; FS.holdings = me.holdings; FS.land = landState(me.citizen); }
    done(() => L`近くの州を調べました。`);
    return { ok: false, quiet: true };
  }),
  'outpost-preview': d => homeAction(async () => {
    const target = { p: num(d.p), q: num(d.q), site: num(d.site) }, walletAddress = FS.wallet?.address;
    if (!walletAddress || !devnetPlayMod.devnetOutpostOn(devnetPlay) || devnetGate().ok !== true) return failed({ code: devnetGate().code ?? 'DevnetPlayOff' });
    const checked = await outpostRecheck(target, walletAddress);
    if (!checked.ok) return failed(checked);
    let ctx;
    try { ctx = await localAct.postLocalAct(devnetPlay.relay, localAct.DEVNET_ACT_CONTEXT_PATH, { schema: 'frontier-devnet-play-outpost-context-v1', wallet: walletAddress }); }
    catch (e) { return failed({ code: e?.code ?? 'LocalActNoAnswer' }); }
    if (ctx?.wallet !== walletAddress || typeof ctx?.holding_rent !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(ctx.holding_rent)) return failed({ code: 'Unavailable' });
    const escrow = /^(0|[1-9][0-9]{0,19})$/.test(String(FS.citizen?.ticketEscrow ?? '')) ? BigInt(FS.citizen.ticketEscrow) : 0n;
    FS.outpostPreview = { step: 'preview', target, cost: outpostCost({ holdingRent: BigInt(ctx.holding_rent), escrow, slots: Number(FS.citizen?.slots ?? 0) }), settler: checked.offer.cost,
      slot: nextOutpostSlot(FS.citizen, FS.holdings) ?? 2, wallet: walletAddress, at: Date.now() };
    setNotice(null);
    return { ok: false, quiet: true };
  }),
  // (the preview lives in FS.outpostPreview, page memory only: FS.ui is replaced from the saved UI state on a tab change)
  'outpost-cancel': () => { if (FS.outpostPreview) { FS.outpostPreview = null; invalidate('panel'); } },
  'outpost-send': d => homeAction(async () => {
    const target = { p: num(d.p), q: num(d.q), site: num(d.site) }, walletAddress = FS.wallet?.address, pv = FS.outpostPreview;
    const same = pv?.step === 'preview' && pv.target.p === target.p && pv.target.q === target.q && pv.target.site === target.site && pv.wallet === walletAddress;
    if (!same || Date.now() - pv.at > OUTPOST_PREVIEW_MS) { FS.outpostPreview = null; return failed({ code: 'OutpostRule', text: L`確認の内容が古くなりました。もう一度「ここに村を出す」を押してください。` }); }
    const checked = await outpostRecheck(target, walletAddress);
    if (!checked.ok) { FS.outpostPreview = null; return failed(checked); }
    if (checked.offer.cost.some((v, i) => v !== pv.settler[i])) { FS.outpostPreview = null; return failed({ code: 'OutpostRule', text: L`入植の条件と費用が更新されました。内容を確認して、もう一度申請してください。` }); }
    const anchor = FS.holdings.find(h => h.order === 1), slot2 = FS.holdings.find(h => h.order === 2) ?? anchor;
    const r = await act('FileOutpost', { v: { sites: [target], anchor, slot2 }, fields: { sites: [target], anchor_site_key: hostId({ ...anchor, seq: 0 }) },
      say: () => L`州（${target.p}, ${target.q}）に村の申し込みを出しました。ターンの終わりに決まります。` });
    FS.outpostPreview = r?.ok ? { step: 'sent', target, signature: r.signature } : null;
    invalidate('panel');
    return r;
  }),
  // DEVNET PLAY (devnet-p17, devnet gap P17): the selected WIDE village's own acts — Harvest, Build, Train, Muster —
  // wallet-paid, two presses, as the outpost card (screens/wideholding.mjs `wideActsCard`, fdevnet-wide-village.mjs):
  // 1. preview: the village's record and its province read again, the page's own checks, what the wallet pays (the fee,
  //    and on the province's FIRST muster the rent of its wide roster — the gateway's word for this cluster), nothing
  //    signed; 2. send: the checks again, then ONE wallet-signed act through the devnet lane (act → flocalplay-act.mjs);
  //    3. the result read back from the village's next record (fdevnet-wide-village.mjs wideVillageResult).
  'wide-act-cancel': () => { if (FS.wideActPreview) { FS.wideActPreview = null; invalidate('panel'); } },
  // (devnet-territory-dev: the tile claim's preview put away; nothing was signed)
  'territory-tile-cancel': () => { if (FS.tilePreview) { FS.tilePreview = null; invalidate('panel'); } },
  'wide-act-send': () => homeAction(async () => {
    const pv = FS.wideActPreview, walletAddress = FS.wallet?.address;
    if (pv?.step !== 'preview' || pv.wallet !== walletAddress || Date.now() - pv.at > wideVillage.WIDE_VILLAGE_PREVIEW_MS) {
      FS.wideActPreview = null; return failed({ code: 'WideVillageStale', text: L`確認の内容が古くなりました。もう一度「費用を確認」を押してください。` });
    }
    const checked = await wideActRecheck(pv.name, pv.fields, walletAddress);
    if (!checked.ok || JSON.stringify(checked.fields) !== JSON.stringify(pv.fields) || checked.village.p !== pv.village.p || checked.village.q !== pv.village.q || checked.village.site !== pv.village.site) { FS.wideActPreview = null; return failed(checked.ok ? { code: 'WideVillageStale' } : checked); }
    const before = checked.entry.holding, village = pv.village, name = pv.name, fields = pv.fields;
    const r = await act(name, { v: { wide: village }, fields, say: () => wideActDoneText(name, fields) });
    if (!r?.ok) { FS.wideActPreview = null; invalidate('panel'); return r; }
    FS.wideActPreview = { step: 'sent', name, fields, village, signature: r.signature, before: before.economy, beforeSlot: String(before.currentness?.capturedSlot ?? ''), result: null, at: Date.now() };
    invalidate('panel');
    wideActReadBack(FS.wideActPreview).catch(e => console.error('frontier wide read-back:', e));
    return r;
  }),
  // (TEST-ONLY wide -> wide marches, local wide-land worlds only, Q-W2 owner t385u: the selected WIDE village's own host —
  //  one press = the planner's one act: train Spearmen, muster a host, or march it onto a neighbouring province's keep;
  //  flocalplay-wide-plan.mjs, the same planner the AI residents use; the act is page-signed, flocalplay-wide-host.mjs)
  // (fix-loop5, L5-1) ONE step at a time, and the page WAITS instead of asking for presses: while the village's province
  //  lags the chain (or its host forms), nothing is sent; the page asks again by itself about once a turn and sends the
  //  step when it can (「待つのをやめる」 stops it). loop-play5 pressed every 2 s for ~10 min and spent the relay's cap.
  'wide-host-step': async (d = {}) => {
    FS.ui = { ...(FS.ui ?? {}) };
    const mem0 = (FS.ui.wideHost ??= { decisions: 0 });
    // (fix-loop11, LP11-2: the wait goes on while another village is open. loop-play11: the guide sends the player back to
    //  the rim village for the expedition; the timer then found no W2 view open, stopped the wait without a word, and the
    //  card came back with 「80 ターン遅れています」 / 「占拠中 9/72」 and a live button. The page's own timer now follows
    //  the wide village it was started for — its inventory slot, kept in the same runtime memory (#173) — whichever
    //  village the screen shows; a person's press still acts on the village on screen)
    const e = d.auto === true && Number.isInteger(mem0.slot) ? (fwide.wideSlots(FS).find(x => x.inventorySlot === mem0.slot) ?? null) : fwide.selectedWide(FS);
    if (!localPlay?.wideLand) { wideHostStopWait(mem0); return; }
    // (the inventory not read just now — a reload of the list, a slow read under load — is no reason to stop: ask again next turn)
    if (!e?.holding) { if (d.auto === true && mem0.waiting) wideHostWait(mem0, mem0.waiting); else wideHostStopWait(mem0); return; }
    if (d.auto !== true) mem0.slot = e.inventorySlot;
    if (d.auto !== true && mem0.waiting) return { ok: false, code: 'WideHostWaiting' };   // (already waiting: the press starts nothing)
    if (mem0.busy) return { ok: false, code: 'WideHostBusy' };
    mem0.busy = true;
    try { return await wideHostStep(e, mem0, { auto: d.auto === true }); } finally { mem0.busy = false; invalidate('panel'); }
  },
  'wide-host-stop': () => { const mem = FS.ui?.wideHost; if (mem) wideHostStopWait(mem); invalidate('panel'); },
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
      order = orderOf('build', 'Build', { item, n, secs, doneAt: hs ? doneAfterQueue(hs, now(), secs) : null, say: () => L`${BUILDINGS[buildItemOf(item)?.resource] ?? ''}の建設を始めました` });
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
    // (2026-11-16: a host of another of the viewer's villages — in hand after a plain tap on its tile, or its chip on a
    //  tile shared with the open village, which leave the village as it was — is dissolved from its own village, as
    //  「村へ戻す」 and the march switch to it first. The order named the open village and the program refused it
    //  (host.rs dissolve_as → resident_host); the bar had offered it, its check reading the host's own village.)
    const hi = holdingIndexOfHost(d.host);
    if (hi !== null && hi !== (FS.activeHolding ?? 0)) { FS.activeHolding = hi; invalidate('rail'); }
    const r = hostRow(d.host);
    const who = r ? unitCount(UNIT_ORDER[r.unit], r.troops) : null;
    return act('Dissolve', { v: { holding: activeHolding(FS), province: r ? { p: r.p, q: r.q } : null }, fields: { host_id: BigInt(d.host) },
      order: orderOf('dissolve', 'Dissolve', { host: String(d.host), unit: r?.unit ?? null, troops: r?.troops ?? null, tile: r ? { p: r.p, q: r.q, tile: r.tile } : null,
        say: () => (who ? L`${who} の解散を命じました。このターンの決着のあと、兵は控えに戻ります` : L`解散を命じました。このターンの決着のあと、兵は控えに戻ります`) }) });
  },
  compose: d => {
    // (2026-11-17, ⑦ the march's entry: a host of another of the viewer's villages is composed from its own village —
    //  as the map's order, 「村へ戻す」 and the keep's march already switch to it first. From the inspector's card and
    //  the host list it was looked for in the open village only and silently not found: the button did nothing. Only
    //  the draft's village is chosen here; what may be sent, and the send's own checks, are unchanged.)
    const hi = holdingIndexOfHost(d.host);
    if (hi !== null && hi !== (FS.activeHolding ?? 0)) { FS.activeHolding = hi; invalidate('rail'); }
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
  'compose-close': () => { pendingDriver.cancel('cancel'); FS.compose = null; invalidate('panel'); },
  'dest-from-map': () => { const s = FS.selected; if (s?.idx !== undefined) return setDestination({ p: s.p, q: s.q, tile: s.idx }); return undefined; },
  'dest-quick': d => setDestination({ p: num(d.p), q: num(d.q), tile: num(d.tile) }),
  // (2026-11-17, ⑦ the march card: the route of the draft's own place, asked again — a new request for the same place,
  //  so an answer of the earlier one that comes late is not written; the draft's settings are kept. Not while sending.)
  // (2026-11-17, ⑦ the village screen: the viewer's record and the village's province read again — a read only, never refresh)
  'village-reread': () => { rereadVillage().catch(() => {}); },
  // (2026-11-17, ⑦ exploration: has the result come for the village in hand — one read, nothing sent or settled)
  'explore-check': () => { checkExploreSeed().catch(() => {}); },
  // (2026-11-17, ⑦ the trade card: the three S1 feeds read again — a read only, never refreshConquest or refresh)
  's1-reread': () => { rereadS1().catch(() => {}); },
  'dest-retry': () => { const c = FS.compose; if (!c?.dest || c.sending) return undefined; return setDestination({ p: c.dest.p, q: c.dest.q, tile: c.dest.tile }); },
  'march-send': () => sendTheMarch(),
  'march-send-wait': () => armMarchWait(),
  'march-wait-cancel': () => pendingDriver.cancel('cancel'),
  'muster-send-wait': () => armMusterWait(),
  'muster-wait-cancel': () => musterDriver.cancel('cancel'),
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
    if (!activeHolding(FS)) return undefined;
    // (2026-11-17 correction: only the draft this request itself opened, for this host, is marked and given the village
    //  as its place. The entry answers nothing when the host is not there any more — and a draft of ANOTHER host, opened
    //  before, may still stand: it was then marked "home" and its place overwritten. That draft is left as it is.)
    const c = ACTIONS.compose({ host: d.host, stay: 'map' });
    if (!c || FS.compose !== c || String(c.host?.id) !== String(d.host)) return undefined;
    // (2026-11-17, ⑦: "its village" is the host's own — the entry above opens the draft from it, also for a host of a
    //  village that was not the open one: read after it, so the way home never ends at another village)
    const h = activeHolding(FS);
    if (!h) return undefined;
    c.home = true;
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
export const LOCAL_PLAY_REFUSED = Object.freeze(['session', 'session-replace', 'nft-login', 'nft-logout', 'prize-faucet', 'nudge', 'forget']);
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
/** Muster(unit, troops, tile): the host forms up on `tile` of the home province (the village's own tile when none is named) and stands from the next turn. `holding`: the village it is for (round 21's waiting send passes the one it froze; otherwise the active one). */
function musterOrder(unit, troops, tile = null, holding = null) {
  const h = holding ? holdingByRef(FS.holdings, holding) : activeHolding(FS);
  if (holding && !sameHolding(h, holding)) return failed({ code: 'NotOwner' });
  const at = Number.isInteger(tile) ? tile : h?.tile;
  const who = unitCount(UNIT_ORDER[unit], troops);
  return act('Muster', { v: { holding: h }, fields: { unit, troops, tile: at },
    order: orderOf('muster', 'Muster', { unit, troops, tile: h ? { p: h.p, q: h.q, tile: at } : null, say: () => L`${who} の編成を命じました。このターンの決着のあとに整列します` }) });
}
/** Garrison(delta): Spearmen of the reserve join the village's garrison. */
function garrisonOrder(n) {
  const k = Math.trunc(n);
  // (the program's refusals of the number itself — not a whole number from 1, the Spearman reserve, the garrison's
  //  room — here, before anything is signed: screens/holding.mjs garrisonProblem; under the wide card the send's own
  //  WideReadOnly answers first)
  const pr = FS.wideSelect ? null : garrisonProblem(FS, k);
  if (pr) return pr.code === 'Insufficient' ? failed({ code: pr.code }) : failed({ code: pr.code, text: garrisonProblemText(pr) });
  return act('Garrison', { v: { holding: activeHolding(FS) }, fields: { delta: BigInt(k) }, order: orderOf('garrison', 'Garrison', { n: k, say: () => L`守備隊を ${fmtNum(k)} 増やしました` }) });
}

/** Form submissions (data-form). */
export const FORMS = {
  // DEVNET PLAY (devnet-p17): a wide village's act, its first press — the preview (nothing signed; 'wide-act-send' sends)
  'wide-act-preview': f => wideActPreview(f),
  // ② rights (TEST-ONLY, a coexist local world only: screens/rights.mjs)
  'rights-issue': f => rightsIssueFromForm(f),
  'rights-reserve': f => rightsUse('ReserveSwap', f.dataset, { units: Math.trunc(formNum(f, 'units')), seq: dnum(f.dataset, 'seq') }),
  // ⑨ capacity · ⑩ custody (TEST-ONLY preview, a coexist local world only: screens/custody.mjs)
  'lot-open': f => custodyOpenLot(f),
  'lot-deposit': f => custodyDeposit(f),
  'lot-withdraw': f => custodyWithdraw(f),
  'cap-lend': f => capacityLend(f),
  'cap-grant': f => capacityGrant(f),
  'cap-reserve': f => capacityReserve(f),
  // S1 (screens/s1.mjs)
  // (the form's own indexes and amounts, as before; an accepted caravan lets go of the plan it began with — s1CaravanFromForm)
  's1-caravan': f => s1CaravanFromForm(f),
  's1-fort': f => {
    const h = activeHolding(FS), troops = Math.trunc(formNum(f, 'troops')), tile = Math.trunc(formNum(f, 'tile'));
    if (!h) return s1Refused(L`村を選んでください`);
    // (the program's own refusals — capture lock, not final, Province behind, the fort's room, the reserve — here,
    //  before anything is signed: screens/s1.mjs fortGarrisonProblem)
    const pr = fortGarrisonProblem(s1VillageModel(FS), tile, troops);
    if (pr) return ['CapturePending', 'NotFinal', 'NotResident', 'Insufficient'].includes(pr.code) ? failed({ code: pr.code }) : s1Refused(fortProblemText(pr));
    const at = s1PlanAtSend({ fortTile: tile });
    return act('FortGarrison', { v: { holding: h, tile }, fields: { troops }, order: orderOf('s1-fort', 'FortGarrison', { tile: { p: h.p, q: h.q, tile }, say: () => L`要塞に槍兵 ${fmtNum(troops)} を入れました` }) }).then(r => s1PlanDone(at, r));
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

/** (devnet-p17) The preview of one wide village act from its card's form (screens/wideholding.mjs wideActsCard). */
// (the Build item's field is `wide_item`: a form's `elements.item` is the collection's own item() method, not a field)
/**
 * DEVNET PLAY (devnet-territory-dev): the tile claim on a devnet territory world, wallet-paid, two presses
 * (fdevnet-territory.mjs). True when a fresh preview of exactly this tile is there (the press may sign and send);
 * otherwise reads the gateway's word for this cluster — the rent of the province's territory record and of the player's
 * summary when the claim creates them, the tiles (the ore price), unpaid upkeep — and shows it (nothing signed): false.
 */
async function devnetTilePreviewGate(target, tile, press = null) {
  const walletAddress = FS.wallet?.address;
  if (!walletAddress || devnetGate().ok !== true) { failed({ code: devnetGate().code ?? 'DevnetPlayOff' }); return false; }
  if (devnetTerritory.tilePreviewFresh(FS.tilePreview, { wallet: walletAddress, target, tile })) return true;
  let ctx;
  try { ctx = await localAct.postLocalAct(devnetPlay.relay, localAct.DEVNET_ACT_CONTEXT_PATH, { schema: devnetTerritory.TERRITORY_CONTEXT_SCHEMA, wallet: walletAddress, target: { p: String(target.p), q: String(target.q) } }); }
  catch (e) { failed({ code: e?.code ?? 'LocalActNoAnswer' }); return false; }
  if (!devnetTerritory.tileContextOk(ctx, walletAddress)) { failed({ code: 'Unavailable' }); return false; }
  const why = devnetTerritory.tileContextRefusal(ctx);
  if (why) { FS.tilePreview = null; invalidate('panel'); failed({ code: why === 'LocalActProvinceAbsent' ? 'TileProvinceAbsent' : why }); return false; }
  FS.tilePreview = { step: 'preview', wallet: walletAddress, target: { p: String(target.p), q: String(target.q) }, tile, cost: devnetTerritory.tileClaimCost(ctx), tiles: ctx.tiles,
    press: press ? { act: press.act, data: Object.fromEntries(Object.entries(press.data ?? {}).filter(([k, v]) => /^(p|q|rp|rq|site|slot|pp|pq|ps)$/.test(k) && v !== undefined).map(([k, v]) => [k, String(v)])) } : null, at: Date.now() };
  setNotice(null);
  invalidate('panel');
  return false;
}

function wideActPreview(f) {
  const name = String(f?.elements?.act?.value ?? f?.dataset?.wideAct ?? '');
  const n = k => Math.trunc(formNum(f, k));
  const fields = name === wideVillage.WIDE_HARVEST ? {} : name === wideVillage.WIDE_BUILD ? { item: n('wide_item') }
    : name === wideVillage.WIDE_TRAIN ? { unit: n('unit'), n: n('n') } : { unit: n('unit'), troops: n('troops'), tile: n('tile') };
  return homeAction(async () => {
    const walletAddress = FS.wallet?.address;
    const checked = await wideActRecheck(name, fields, walletAddress);
    if (!checked.ok) { FS.wideActPreview = null; return failed(checked); }
    let ctx;
    try { ctx = await localAct.postLocalAct(devnetPlay.relay, localAct.DEVNET_ACT_CONTEXT_PATH, { schema: wideVillage.WIDE_VILLAGE_CONTEXT_SCHEMA, wallet: walletAddress, village: checked.village }); }
    catch (e) { return failed({ code: e?.code ?? 'LocalActNoAnswer' }); }
    if (ctx?.wallet !== walletAddress || typeof ctx?.roster_rent !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(ctx.roster_rent) || typeof ctx.roster_present !== 'boolean') return failed({ code: 'Unavailable' });
    FS.wideActPreview = { step: 'preview', name, fields: checked.fields, village: checked.village, cost: wideVillage.wideVillageCost({ name, rosterRent: BigInt(ctx.roster_rent), rosterPresent: ctx.roster_present }),
      rosterNew: name === wideVillage.WIDE_MUSTER && !ctx.roster_present, warn: checked.warn, province: checked.province ? { resolvedNext: checked.province.resolvedNext } : null,
      wallet: walletAddress, at: Date.now() };
    setNotice(null);
    return { ok: false, quiet: true };
  });
}

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

/** (round 28) The index of the viewer's village whose province records hold host `id`, or null. */
function holdingIndexOfHost(id) {
  const hs = FS.holdings ?? [];
  for (let i = 0; i < hs.length; i++) {
    if (!hs[i]) continue;
    for (const env of FS.provinces.values()) if (hostsIn(env.province, hs[i], nowBell()).some(x => String(x.id) === String(id))) return i;
  }
  return null;
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
  // (devnet-page-war-2) whether the march card offers the waiting send (local play's test entry, or a devnet page)
  Object.defineProperty(FS, 'marchWaitOn', { configurable: true, enumerable: false, get: marchWaitOn });
  // (2026-11-17, ⑦: "the exploration's result can be collected" is true only for the village and exploration its seed was
  //  read for — exploreSeedNow. Corrected: no producer in the page writes `true` to the flag any more (refresh applies
  //  its answer through applyExploreSeed, with the village it READ for — writing the flag would have named the village
  //  in hand at the answer instead). A `true` written from outside is taken as the village now in hand's and marked
  //  'external'; a `false` takes back only such a mark — never a seed that was read.)
  FS.exploreSeedMarks = exploreSeedMarks;
  Object.defineProperty(FS, 'exploreSeedReady', { configurable: true, enumerable: true, get: exploreSeedNow,
    set: v => {
      const o = activeHolding(FS) ?? null, ref = o ? holdingRef(o) : null;
      if (v === true) { if (o?.explore?.state > 0) exploreSeedMarks.set(ref, { ref, bell: Number(o.explore.bell), world: providerWorld(), state: 'ready', code: null, ask: ++exploreSeedAsk, source: 'external' }); }
      else if (ref !== null && exploreSeedMarks.get(ref)?.source === 'external') exploreSeedMarks.delete(ref);
    } });
  // (devnet play: whether this is a wide devnet season the page plays itself, and its opened wide provinces — read by
  //  home.mjs and screens/holding.mjs; false / null on every other page)
  Object.defineProperty(FS, 'devnetWide', { configurable: true, enumerable: false, get: () => devnetWideNow() });
  // (devnet-territory-dev: a devnet territory world the page claims tiles in — screens/holding.mjs wideClaimModel)
  Object.defineProperty(FS, 'devnetTerritory', { configurable: true, enumerable: false, get: () => devnetTerritoryNow() });
  Object.defineProperty(FS, 'devnetWideLand', { configurable: true, enumerable: false,
    get: () => (devnetWideNow() ? Object.freeze({ targets: devnetPlayMod.wideTargetsOf(typeof FS.wideLandNow === 'function' ? FS.wideLandNow() : null) }) : null) });
  Object.defineProperty(FS, 'localMarchFor', { configurable: true, enumerable: false, value: (holding, hostId) => localMarchFor(holding ? holdingByRef(FS.holdings, holding) : null, hostId) });
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
    // (the memory-only wallet, or — TEST-ONLY, a launcher with --persist — the kept one; the address is checked below)
    const mine = (FS.walletList ?? []).find(w => LOCAL_PLAY_WALLET_NAMES.includes(w.name) && !w.why);
    const c = mine ? await wallet.connect(mine, { chain: wallet.chainOf('localnet') }).catch(() => null) : null;
    if (c && c.address === localPlay.address) adoptConnectedWallet(c);
    // (the march's capability: ONE read, bound to this herald's relay, this wallet and the launcher's stated instance)
    if (c && c.address === localPlay.address && localPlay.march?.instance) {
      const asked = localPlay.address;
      localMarch.readLocalMarchCapability({ origin: cfg.herald, wallet: asked, expectedInstance: localPlay.march.instance, request: (...a) => globalThis.fetch(...a) })
        .then(cap => { if (FS.wallet?.address === asked) { localMarchCapability = cap; invalidate('panel'); } }).catch(() => {});
    }
  }
  // (2026-11-17, ⑦: the first read is not a precondition of the rest of the start. A throw in it — the reconnect's
  //  session restore, the wallet sync, or the first refresh, whose reads the poll's own tick also guards — left the
  //  start there: no wallet events were followed and the poll below was never made, so the page never read again. It
  //  is reported, and the start goes on: the poll reads again. What the viewer is stays unknown until a read answers:
  //  hud/drawer.mjs viewerState says "pending" or "unreachable", never "not joined".)
  try {
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
    // DEVNET PLAY (devnet gap P1): one read of the gateway's devnet play info; on only for exactly the pinned devnet
    // world (fdevnetplay.mjs readDevnetPlay). Never in local play; elsewhere null and nothing changes.
    if (!localPlay && io.pinned()?.cluster === 'devnet') {
      devnetPlay = await devnetPlayMod.readDevnetPlay({ origin: cfg.herald, pin: io.pinned(), rulesetHash: FS.season?.rulesetHash });
      FS.devnetPlay = devnetPlay;
      // (rent-live-rest: the route is known now — ask the cluster's rent at once rather than after the model's retry)
      if (devnetPlay && FS.rent?.source !== 'cluster') FS.rent = null;
      if (devnetPlay) { invalidate('panel'); await refresh(); }
    }
  } catch (e) { console.error('frontier first read:', e); }
  // Local play: the player this boot read must still be the gate's wallet's own Citizen; otherwise the page lets go
  // of the wallet and says so (sends stay refused either way).
  if (localPlay && FS.wallet && !localPlayIdentityOk(localPlay, io.pinned(), FS.season, FS.citizen)) {
    await wallet.disconnect().catch(() => {});
    adoptConnectedWallet(null);
    FS.error = { code: 'LocalPlayIdentityChanged', text: L`ローカルプレイの接続先が、確認したときと変わりました。ページを開き直してください。` };
    invalidate('status', 'panel');
  }
  walletEventsReady = true;
  // (the same: a failed sync here is read again by the poll and by the next wallet event)
  try { if ((wallet.connected()?.address ?? null) !== (FS.wallet?.address ?? null)) await syncConnectedWallet(); } catch (e) { console.error('frontier wallet sync:', e); }
  let errors = 0;
  const hidden = () => !!globalThis.document?.hidden;
  const poll = pollLoop = createPollLoop({
    tick: async () => {
      try {
        // Hidden: only the marchbook's self-reveal step (§4.2), not the full refresh.
        if (hidden()) await revealTick(); else await refresh();
        errors = 0;
      } catch (e) { errors++; console.error('frontier refresh:', e); }
    },
    delay: () => pollDelay({ hidden: hidden(), inFlight: (FS.inFlight ?? 0) > 0 || (FS.marches ?? []).length > 0, errors, cap: pollCap(FS.chain) }),
  });
  // Shown again, or back from the browser's cache: the loop's next tick now (a full read), then the visible cadence —
  // not the hidden wait that was pending. (A hidden page read only its due reveals: its view of the world may be old.)
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!hidden()) poll.wake(); });
  globalThis.addEventListener?.('pageshow', e => { if (e?.persisted && !hidden()) poll.wake(); });
  poll.start(Math.min(10, pollCap(FS.chain)));
}

/** The page's poll loop once started (createPollLoop): woken when the page is shown again, or by the player's re-read. */
let pollLoop = null;
/**
 * Read the latest state now (the stale banner's button on local play, where a reload would lose the page's
 * memory-only key): the poll loop's next tick at once, a read only. Pressed twice, or while a read runs, it is still
 * one read after the running one (createPollLoop); before the loop has started it does nothing.
 */
export function rereadState() { pollLoop?.wake(); for (const f of rereadHooks) { try { f(); } catch (e) { console.error('frontier reread:', e); } } }
/** Other read loops the re-read also wakes (app.mjs: the season poll, the one read that moves the page's chain clock). */
const rereadHooks = [];
export function onReread(f) { if (typeof f === 'function') rereadHooks.push(f); }

/** The hidden page's tick: the self-reveal of the marchbook's due marches only. */
async function revealTick() {
  if (!herald || !FS.clock || !FS.wallet || !(FS.book ?? []).some(e => e.state !== 'settled' && e.state !== 'failed')) return;
  await refreshMarches();
}
