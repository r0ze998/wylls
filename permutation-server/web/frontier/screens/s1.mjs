// The redesign's stage 1 (S1; docs/frontier/stage1*) on the play screens:
//
//   on a chosen tile   what stands there (a storehouse, a tower, a palisade,
//                      a fort) and what can be built there, paid from the
//                      village in hand; a raid the viewer's host has won on
//                      a caravan here, to take or to burn
//   in the village     the viewer's storehouses, caravans on the road and
//                      structures; sending a caravan to another of its own
//                      places; manning its fort in the village's province;
//                      the nation's stances, its open proposals (a vote on
//                      each) and a proposal of a stance
//
// The models are pure (tested in web-frontier-s1.test.mjs); the program
// checks every rule again (contract: the page only offers). Every action is a
// `data-act` or `data-form` of controller.mjs.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { icon } from '../hud/icons.mjs';
import { RESOURCES, RESOURCE_ORDER, errorText, factionName } from '../fi18n.mjs';
import { storesAt, hostOfHolding, SCOUT, isFinal, finalityDue } from '../fland.mjs';
import { SIEGE_ARMS, s1On } from '../fs1.mjs';
import { settled, shortOf } from '../hud/rulebook.mjs';
import { activeHolding } from '../fstate.mjs';
import { keepFromProvince, capturePending } from '../fconquest.mjs';
import { hostParts } from '../faddr.mjs';
import { hexDistance, ringOf, wedgeOf } from '../fgeo.mjs';
import { ownTag } from '../people/ui.mjs';
import { MAX_VAULTS, VAULT_COST } from '../fcaravan.mjs';
import { S1_WORDS, caravanArriveBell, arriveBellOfTs, caravanId } from '../map/s1marks.mjs';
import { bellAt } from '../clock.mjs';
import { cardHead, chip, fold, label } from './parts.mjs';
import { renderVillageOrders, S1_ORDER_KINDS } from './villageorders.mjs';
import { swatch } from './shell.mjs';
import { renderCoopSlot, coopDestinations } from '../hud/coopentry.mjs';
import { arrivalView, cancelView, costView, manualView, spendable, renderStatus, cargoText as spendText } from '../hud/statusview.mjs';
import { arrivalOnRoad, createCaravanWatch, statusFrom } from '../hud/statussources.mjs';
import { renderRights } from './rights.mjs';
import { renderCustody } from './custody.mjs';
import { viewTile, fogActive } from '../map/fog.mjs';

// ------------------------------------------------------------------ the rules the page offers by (structure.rs, caravan.rs, nation.rs)
/** structure::KIND_*. */
export const KIND = Object.freeze({ tower: 1, palisade: 2, fort: 3 });
export const KIND_NAME = Object.freeze({ 1: 'tower', 2: 'palisade', 3: 'fort' });
/** structure::cost_units (whole units: wood, stone, arms, gold). */
export const STRUCTURE_COST = Object.freeze({ 1: Object.freeze([0, 300, 400, 0, 20, 100, 0, 0]), 2: Object.freeze([0, 200, 100, 0, 0, 20, 0, 0]), 3: Object.freeze([0, 500, 800, 0, 50, 200, 0, 0]) });
/** structure::max_of: structures of each kind a citizen may own. */
export const STRUCTURE_MAX = Object.freeze({ 1: 2, 2: 4, 3: 1 });
/** structure: entries a Province holds, forts a Province holds, whole troops a fort holds. */
export const PROVINCE_STRUCTURES = 12;
export const PROVINCE_FORTS = 2;
export const FORT_MAX_TROOPS = 2000;
/** caravan.rs: a raid's bell offset is RAID_NONE (none) or RAID_SETTLED; the raider decides within RAID_DECIDE_BELLS. */
export const RAID_NONE = 0xff;
export const RAID_SETTLED = 0xfe;
export const RAID_DECIDE_BELLS = 6;
/** caravan.rs: bells after the window from which an undecided raid with no road home is burned. */
export const RAID_BURN_AFTER_BELLS = 144;
/** structure::STANCE_*: how a nation stands toward another faction. */
export const STANCES = Object.freeze(['war', 'pass', 'ally']);
const STANCE_TEXT = { war: () => L`戦争`, pass: () => L`通行を許す`, ally: () => L`同盟` };
/** nation.rs KIND_STANCE. */
export const PROPOSE_STANCE = 1;
/** nation.rs ELIGIBLE_BELLS: a village proposes and votes once it has been in the season this long. */
export const ELIGIBLE_BELLS = 288;
/** nation.rs PROPOSALS: open proposals a nation holds at once. */
export const NATION_PROPOSALS = 4;
/** nation.rs READMIT_BELLS: an expelled village may be proposed back once it has been out this long. */
export const READMIT_BELLS = 432;
/** nation.rs KIND_EXPEL, KIND_READMIT. */
export const PROPOSE_EXPEL = 2, PROPOSE_READMIT = 3;

/**
 * Proposing to expel the village on a chosen site (nation.rs KIND_EXPEL): a
 * village of the viewer's own nation, not the viewer's, not expelled already.
 * `{p, q, site, blocks}` or null. The village's Citizen is read from its
 * Holding when the order is sent; the program checks the rest.
 */
export function expelOffer(FS, sel) {
  if (!sel || !Number.isInteger(sel.idx) || !s1On()) return null;
  const prov = FS.provinces?.get?.(`${sel.p},${sel.q}`)?.province ?? null;
  const n = Math.min(Number(prov?.siteCount ?? 0), 12);
  const j = Array.from(prov?.sites ?? []).slice(0, n).indexOf(sel.idx);
  const mirror = j >= 0 ? prov.siteMirror?.[j] : null;
  const faction = FS.citizen?.faction;
  if (!mirror || Number(mirror.state) !== SITE_HOLDING || Number(mirror.faction) !== faction) return null;
  if ((FS.holdings ?? []).some(h => h.p === sel.p && h.q === sel.q && h.site === j)) return null;
  const nation = s1VillageModel(FS).nation;
  if (!nation) return null;
  // (2026-11-16: nation.rs propose_as KIND_EXPEL refuses a village whose Citizen is already expelled — `since == 0`
  //  required, ProposalState —; the doc above said so but the code did not check it. The nation's expelled list names
  //  each expelled village's holdings (herald /h/nations.json; an older herald names none: then the program decides))
  const already = (nation.out ?? []).some(x => (x.holdings ?? []).some(h => h.p === sel.p && h.q === sel.q && h.site === j));
  const blocks = [...(nation.expelled ? ['Expelled'] : []), ...(!nation.eligible ? ['NotVoter'] : []), ...(already ? ['TargetExpelled'] : []),
    ...(nation.full ? ['ProposalsFull'] : []), ...(nation.ownOpen ? ['ProposalOpen'] : [])];
  return { p: sel.p, q: sel.q, site: j, blocks };
}
const NATIONS = 6;

export { caravanId };

/** The viewer's citizen tag (bigint) or null (people/ui.mjs ownTag). */
export const viewerTag = FS => ownTag(FS);
const isMine = (tag, mine) => mine !== null && mine !== undefined && BigInt(tag) === BigInt(mine);
/** ⑯ P3: whose a caravan is now: the holder a raid named (herald `holderTag`), else its sender. */
const holderOf = c => c.holderTag ?? c.ownerTag;

/** Whole units the village in hand holds now, by resource. */
function haveOf(FS, h) {
  if (!h) return Array(8).fill(0);
  const now = FS.chain?.now?.() ?? 0;
  return storesAt(settled(h, now), now, RESOURCE_ORDER).map(s => s.value);
}

/**
 * Why a tile takes no storehouse or structure (the program's VaultSite /
 * StructureSite rule): `'Impassable' | 'Site' | 'Keep' | 'Camp'`, or null
 * when it may.
 */
export function siteProblem(prov, idx) {
  if (!prov || !Number.isInteger(idx) || idx < 0 || idx >= 61) return 'Unknown';
  if ((BigInt(prov.passableMask ?? 0) & (1n << BigInt(idx))) === 0n) return 'Impassable';
  const n = Math.min(Number(prov.siteCount ?? 0), 12);
  if (Array.from(prov.sites ?? []).slice(0, n).includes(idx)) return 'Site';
  if (keepFromProvince(prov)?.tile === idx) return 'Keep';
  if (prov.camp?.state === 1 && prov.camp.tile === idx) return 'Camp';
  return null;
}

/**
 * What S1 has on a chosen tile and what can be built there:
 * `{vault, structure, build: {vault: {cost, blocks}, structures: [{kind, cost, blocks}]}, raids}`.
 * `blocks` are error names (fi18n errorText) or the page's own (`NoHolding`, `Taken`).
 */
export function s1TileModel(FS, sel) {
  if (!sel || !Number.isInteger(sel.idx)) return null;
  const { p, q, idx } = sel;
  const s1 = FS.s1 ?? {}, mine = viewerTag(FS);
  const prov = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;
  const at = x => x.p === p && x.q === q && x.tile === idx;
  const vault = (s1.caravans?.vaults ?? []).find(at) ?? null;
  const structure = (s1.structures?.structures ?? []).find(at) ?? null;
  const h = activeHolding(FS), have = haveOf(FS, h);
  const site = siteProblem(prov, idx), siteBlock = site === 'Unknown' ? 'Unknown' : site ? 'Site' : null;
  const c = FS.citizen ?? {};
  // (2026-11-16: the program's capture lock — holding.rs own_province_unlocked → capture_lock, CapturePending — refuses a
  //  storehouse and every structure while the village in hand is being captured; the card offered them and only the send
  //  was refused. The same mirror-generation rule as the program: fconquest.mjs capturePending.)
  const locked = !!h && capturePending(FS, h);
  const common = [...(h ? [] : ['NoHolding']), ...(locked ? ['CapturePending'] : []), ...(siteBlock ? [siteBlock] : [])];
  const vaultBlocks = [...common, ...(vault ? ['Taken'] : []), ...(Number(c.vaults ?? 0) >= MAX_VAULTS ? ['VaultLimit'] : []), ...(shortOf(VAULT_COST, have).length ? ['Insufficient'] : [])];
  const live = (prov?.structures ?? []).filter(e => Number(e.kind) !== 0);
  const forts = (prov?.forts ?? []).filter(f => Number(f.state) !== 0);
  const owned = { 1: Number(c.towers ?? 0), 2: Number(c.palisades ?? 0), 3: Number(c.forts ?? 0) };
  const structures = [1, 2, 3].map(kind => ({
    kind, name: KIND_NAME[kind], cost: STRUCTURE_COST[kind],
    blocks: [...common, ...(structure ? ['Taken'] : []), ...(owned[kind] >= STRUCTURE_MAX[kind] ? ['StructureLimit'] : []),
      ...(live.length >= PROVINCE_STRUCTURES || (kind === 3 && forts.length >= PROVINCE_FORTS) ? ['StructureFull'] : []),
      ...(shortOf(STRUCTURE_COST[kind], have).length ? ['Insufficient'] : [])],
  }));
  const v = vault && { ...vault, mine: isMine(vault.ownerTag, mine) };
  const st = structure && { ...structure, name: KIND_NAME[structure.kind], mine: isMine(structure.ownerTag, mine) };
  return {
    p, q, idx, site, have,
    vault: v, structure: st,
    seize: seizeOffer(FS, prov, idx, v, 'vault') ?? seizeOffer(FS, prov, idx, st, 'structure'),
    build: { vault: { cost: VAULT_COST, blocks: vaultBlocks }, structures },
    raids: raidOffers(FS).filter(r => r.p === p && r.q === q && r.tile === idx),
    stops: domesticRaidOffers(FS).filter(r => r.p === p && r.q === q && r.tile === idx),
  };
}

/**
 * Seizing another citizen's storehouse or structure on a tile (caravan.rs
 * SeizeVault, structure.rs SeizeStructure): one of the viewer's hosts stands
 * in the roster on the tile, resolved in (`from_bell ≤ resolved_next`); no host
 * of the owner stands there (the program checks: NotOnTile); a fort only once
 * it has fallen (FortManned). `{entry, hostHolding: {p, q, site, gen},
 * ownerCitizen, blocks}` or null when there is nothing of another's here.
 */
export function seizeOffer(FS, prov, idx, target, kind) {
  if (!target || target.mine) return null;
  const rn = Number(prov?.resolvedNext ?? 0);
  const entries = Array.from(prov?.entries ?? []);
  let entry = -1, hostHolding = null;
  entries.forEach((e, i) => {
    if (entry >= 0 || Number(e.state) !== 1 || Number(e.tile) !== idx || Number(e.fromBell) > rn) return;
    const h = (FS.holdings ?? []).find(x => hostOfHolding(e.id, x));
    if (h) { entry = i; hostHolding = { p: h.p, q: h.q, site: h.site, gen: h.gen ?? 0 }; }
  });
  const c = FS.citizen ?? {};
  const blocks = [
    ...(entry < 0 ? ['NoHostHere'] : []),
    ...(target.ownerCitizen ? [] : ['OwnerUnknown']),
    ...(kind === 'vault' && Number(c.vaults ?? 0) >= MAX_VAULTS ? ['VaultLimit'] : []),
    ...(kind !== 'vault' && Number(c[{ 1: 'towers', 2: 'palisades', 3: 'forts' }[target.kind]] ?? 0) >= (STRUCTURE_MAX[target.kind] ?? 0) ? ['StructureLimit'] : []),
    // (structure.rs fort_troops: troops + pending troops; a fort whose garrison is still coming in is manned too — the page
    //  read troops only and offered such a fort, refused on send: 2026-11-16)
    ...(kind !== 'vault' && Number(target.kind) === KIND.fort && (prov?.forts ?? []).some(f => Number(f.tile) === idx && Number(f.state) !== 0 && (Number(f.troops) > 0 || Number(f.pend ?? 0) > 0)) ? ['FortManned'] : []),
  ];
  return { entry, hostHolding, ownerCitizen: target.ownerCitizen ?? null, blocks };
}

/** SeasonParams v2 `siege_stake_gold` of every preset (presets.rs: 500), paid by the declaring host's village. */
export const SIEGE_STAKE_GOLD = 500;
/** SeasonParams v2 `sieges_per_day` of every preset (presets.rs: 2). */
export const SIEGES_PER_DAY = 2;
/** Province v2 conquest record flags that owe something (layout conquest_record OWED_MASK). */
const SIEGE_OWED_MASK = (1 << 1) | (1 << 2) | (1 << 5);
/** Province v2 site mirror states (layout `site::STATE_*`). */
const SITE_HOLDING = 1, SITE_FREE_CITY = 5;

/**
 * Declaring a siege on another nation's village or a Free City (conquest
 * contract §3.4, DeclareSiege; S1 burns SIEGE_ARMS more): one of the
 * viewer's fighting hosts stands in the roster on the site's tile, resolved
 * in; its village pays 500 gold (the stake, returned or burned as the siege
 * ends) and 50 arms. The program decides the rest (the lead host, shields,
 * protection, immunity, a free slot for a capture): its refusal is said in
 * words. `{site, entry, src: {p, q, site, gen}, target: {p, q, site}, freeCity,
 * blocks}` or null when the tile is no besiegeable site of another nation.
 */
export function siegeOffer(FS, sel) {
  if (!sel || !Number.isInteger(sel.idx)) return null;
  const prov = FS.provinces?.get?.(`${sel.p},${sel.q}`)?.province ?? null;
  if (!prov) return null;
  const n = Math.min(Number(prov.siteCount ?? 0), 12);
  const j = Array.from(prov.sites ?? []).slice(0, n).indexOf(sel.idx);
  const mirror = j >= 0 ? prov.siteMirror?.[j] : null;
  if (!mirror) return null;
  const state = Number(mirror.state), faction = FS.citizen?.faction;
  if (state !== SITE_HOLDING && state !== SITE_FREE_CITY) return null;
  if (state === SITE_HOLDING && Number(mirror.faction) === faction) return null;
  const rn = Number(prov.resolvedNext ?? 0);
  let entry = -1, src = null;
  Array.from(prov.entries ?? []).forEach((e, i) => {
    if (entry >= 0 || Number(e.state) !== 1 || Number(e.tile) !== sel.idx || Number(e.fromBell) > rn || Number(e.unit) >= SCOUT) return;
    const h = (FS.holdings ?? []).find(x => hostOfHolding(e.id, x));
    if (h) { entry = i; src = h; }
  });
  const have = src ? haveOf(FS, src) : Array(8).fill(0);
  const cost = [0, 0, 0, 0, SIEGE_ARMS, SIEGE_STAKE_GOLD, 0, 0];
  const c = FS.citizen ?? {};
  const today = Math.floor(Number(FS.chain?.now?.() ?? 0) / 86400);
  // a village under its shield (the mirror's SHIELD_UNTIL_BELL; a new village's protection) is refused `Shielded`
  const shielded = state === SITE_HOLDING && Number(mirror.shieldUntilBell ?? 0) > Number(FS.nowBell ?? 0);
  // siege.rs may_besiege_v3: a village in its owner's heartland (rings 2 to heartland_max_ring of its wedge) is refused
  // `Heartland` (the S1 program's relation is always Rivalry, never War; a nation's stance does not change it)
  const ring = ringOf(sel.p, sel.q), maxRing = Number(FS.season?.conquestParams?.heartlandMaxRing ?? 3);
  const heartland = state === SITE_HOLDING && ring >= 2 && ring <= maxRing && wedgeOf(sel.p, sel.q) === Number(mirror.faction);
  // (2026-11-16: conquest.rs declare_siege_as step 2 — the declaring village must be final; the lazy flip applies only
  //  when its own Province is the target's — and step 3 — the target Province resolved: resident_ok, NotResident —;
  //  the page offered both cases and they were refused on send)
  const now = Number(FS.chain?.now?.() ?? 0), nowBell = Number(FS.nowBell ?? 0);
  const srcFinal = !src || Number(src.state) === 2 || (src.p === sel.p && src.q === sel.q && finalityDue(src, prov, now, nowBell));
  const blocks = [
    ...(srcFinal ? [] : ['NotFinal']),
    ...(rn + 1 < nowBell ? ['NotResident'] : []),
    ...(heartland ? ['Heartland'] : []),
    ...(shielded ? ['Shielded'] : []),
    ...(entry < 0 ? ['NoFighterHere'] : []),
    ...(src && shortOf(cost, have).length ? ['Insufficient'] : []),
    ...(Number(c.siegeDay ?? -1) === today && Number(c.siegesToday ?? 0) >= SIEGES_PER_DAY ? ['SiegeCap'] : []),
    // conquest.rs declare_siege step 8: the declarer's own village under its shield is refused `Shielded` (the player
    // acting now is not dormant); step 5: a site whose conquest record is busy (`SiegeBusy`) or still owes a stake
    ...(src && Number(src.shieldUntil ?? 0) > Number(FS.chain?.now?.() ?? 0) ? ['SourceShielded'] : []),
    ...(prov.conquest?.[j] && Number(prov.conquest[j].kind) !== 0 ? ['SiegeBusy'] : prov.conquest?.[j] && (Number(prov.conquest[j].flags) & SIEGE_OWED_MASK) !== 0 ? ['StakeUnsettled'] : []),
  ];
  return { site: j, entry, src: src && { p: src.p, q: src.q, site: src.site, gen: src.gen ?? 0 }, target: { p: sel.p, q: sel.q, site: j }, freeCity: state === SITE_FREE_CITY, cost, have, blocks };
}

/**
 * The raids the viewer's hosts have won and may decide (caravan.rs
 * `raid_open`, within RAID_DECIDE_BELLS of the raid): `[{p, q, tile, slot,
 * raidBell, decideBy, raider: {p, q, site, gen}, caravan}]` — `caravan` the
 * feed's entry (its owner and sequence name the account).
 */
export function raidOffers(FS) {
  const out = [];
  const moving = FS.s1?.caravans?.moving ?? [];
  const bell = Number(FS.nowBell ?? 0);
  for (const env of FS.provinces?.values?.() ?? []) {
    const prov = env.province;
    (prov?.caravans ?? []).forEach((s, slot) => {
      const id = BigInt(s.id ?? 0), off = Number(s.raidOff);
      if (id === 0n || off === RAID_NONE || off === RAID_SETTLED) return;
      const hp = hostParts(s.raider);
      const raider = hp && (FS.holdings ?? []).find(h => h.p === hp.p && h.q === hp.q && h.site === hp.site && h.gen === hp.gen);
      if (!raider) return;
      const caravan = moving.find(c => caravanId(c.ownerTag, c.seq) === id);
      if (!caravan) return;
      const raidBell = Number(s.firstBell) + off;
      out.push({ p: prov.p, q: prov.q, tile: Number(s.tiles?.[off] ?? s.tiles?.[String(off)]), slot, raidBell, decideBy: raidBell + RAID_DECIDE_BELLS, open: bell <= raidBell + RAID_DECIDE_BELLS,
        raider: { p: raider.p, q: raider.q, site: raider.site, gen: raider.gen }, caravan });
    });
  }
  return out;
}

/**
 * (fix-9-10-followups, the local coexist lane only — `FS.custody.on`, which only refreshCustody sets there) Stopping a
 * caravan of the viewer's own nation (caravan.rs RaidDomestic, 0xBE): a clash never raids a caravan of the raider's own
 * faction, so a `--two` pair — always one nation — could never lose a caravan on the road. The program opens the raid
 * when one of the viewer's hosts stood, in the roster, on the tile where the caravan stood at the start of a resolved
 * turn (`bell < resolved_next`), from that turn or earlier, at most RAID_DECIDE_BELLS turns ago, the raid not opened
 * there before, and none of the caravan owner's hosts on that tile (the program checks that one: NotOnTile). Then the
 * usual decision (raidOffers) takes it home or burns its load.
 * `[{p, q, tile, slot, bell, entry, hostHolding: {p, q, site, gen}, caravan}]` — `caravan` the feed's entry.
 */
export function domesticRaidOffers(FS) {
  if (!FS.custody?.on) return [];
  const out = [];
  const moving = FS.s1?.caravans?.moving ?? [];
  const bell = Number(FS.nowBell ?? 0), me = viewerTag(FS), faction = Number(FS.citizen?.faction);
  for (const env of FS.provinces?.values?.() ?? []) {
    const prov = env.province;
    if (!prov) continue;
    const rn = Number(prov.resolvedNext ?? 0);
    const entries = Array.from(prov.entries ?? []);
    (prov.caravans ?? []).forEach((s, slot) => {
      const id = BigInt(s.id ?? 0);
      if (id === 0n || Number(s.raidOff) !== RAID_NONE || Number(s.faction) !== faction) return;
      const caravan = moving.find(c => caravanId(c.ownerTag, c.seq) === id);
      if (!caravan || isMine(caravan.holderTag ?? caravan.ownerTag, me)) return;
      const first = Number(s.firstBell), n = Math.min(Number(s.n ?? 0), 8);
      for (let k = n - 1; k >= 0; k--) {
        const b = first + k;
        if (b >= rn || bell > b + RAID_DECIDE_BELLS) continue;
        const tile = Number(s.tiles?.[k] ?? s.tiles?.[String(k)]);
        let entry = -1, hostHolding = null;
        entries.forEach((e, i) => {
          if (entry >= 0 || Number(e.state) !== 1 || Number(e.tile) !== tile || Number(e.fromBell) > b) return;
          const h = (FS.holdings ?? []).find(x => hostOfHolding(e.id, x));
          if (h) { entry = i; hostHolding = { p: h.p, q: h.q, site: h.site, gen: h.gen ?? 0 }; }
        });
        if (entry >= 0) { out.push({ p: prov.p, q: prov.q, tile, slot, bell: b, entry, hostHolding, caravan }); break; }
      }
    });
  }
  return out;
}

/**
 * The village's S1 view: the viewer's storehouses, caravans and structures,
 * where a caravan may go from the village in hand, its forts in the
 * village's province, and the nation (stances, proposals, the viewer's
 * votes).
 */
/** The pinned world (with its generation) and the viewer a trade plan is made for — the same marks controller.planS1Place writes. */
const planScope = FS => { const pin = FS.pin ?? null; return { world: pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null, viewer: FS.resident?.asset ?? FS.wallet?.address ?? null }; };
/**
 * (2026-11-17, ⑦ from the map to the trade card) What stands on a tile that a caravan may go to or leave from, in the
 * very shapes the caravan form's lists use (s1VillageModel sources / destinations, othersPlaces): a storehouse of the
 * caravans feed (the viewer's, or another's — only once whose is whose is known), one of the viewer's villages, or
 * another's village the province's record shows on that tile. Null when the page holds no such thing there — a tile
 * whose lists or province are not read gives null, never a guessed place.
 */
/**
 * (food-net-caravan, owner 2026-11-25 21:22 Q-LP17-4) Whether ANOTHER player's place — a village or a storehouse at
 * tile `tile` of (p, q), of nation `faction` — may be offered as a caravan's destination: one of the viewer's own
 * nation's, or one whose tile is IN SIGHT NOW (map/fog.mjs viewTile, L3). Under the fog the list named every village
 * of the provinces the page had read — six nations' villages with province and tile, none of them on the map
 * (loop-play17 LP17-4). A place seen before and now out of sight is not offered. Without fog (viewTile: always):
 * every place, as before. The viewer's own places and the ① requests the viewer accepted (a place its owner
 * published on the board, fix-loop8 LP8-3) do not pass through here.
 */
export const otherPlaceOffered = (FS, { p, q, tile, faction }) =>
  (Number.isInteger(FS?.citizen?.faction) && Number(faction) === FS.citizen.faction) || viewTile(p, q, tile);

export function s1PlaceAt(FS, sel) {
  if (!sel || !Number.isInteger(sel.p) || !Number.isInteger(sel.q) || !Number.isInteger(sel.idx)) return null;
  const { p, q, idx } = sel, mine = viewerTag(FS);
  const v = (FS.s1?.caravans?.vaults ?? []).find(x => x.p === p && x.q === q && x.tile === idx);
  if (v) {
    if (mine === null || mine === undefined) return null;
    // (food-net-caravan, Q-LP17-4: another's storehouse out of sight is not a place the map hands over)
    if (!isMine(v.ownerTag, mine) && !otherPlaceOffered(FS, { p, q, tile: idx, faction: v.faction })) return null;
    return isMine(v.ownerTag, mine) ? { kind: 'vault', p, q, tile: idx, gen: v.gen } : { kind: 'vault', p, q, tile: idx, gen: v.gen, other: true, faction: v.faction };
  }
  const own = (FS.holdings ?? []).find(o => o.p === p && o.q === q && o.tile === idx);
  if (own) return { kind: 'holding', p, q, site: own.site, gen: own.gen ?? 0, tile: own.tile };
  const prov = FS.provinces?.get?.(`${p},${q}`)?.province;
  const n = prov ? Math.min(Number(prov.siteCount ?? 0), 12) : 0;
  for (let j = 0; j < n; j++) {
    const mirror = prov.siteMirror?.[j];
    if (!mirror || Number(mirror.state) !== SITE_HOLDING || Number(prov.sites?.[j]) !== idx) continue;
    if ((FS.holdings ?? []).some(o => o.p === p && o.q === q && o.site === j)) continue;
    if (!otherPlaceOffered(FS, { p, q, tile: idx, faction: Number(mirror.faction) })) return null;
    return { kind: 'holding', p, q, site: j, gen: null, tile: idx, other: true, faction: Number(mirror.faction) };
  }
  return null;
}
/**
 * The plan as it holds NOW: `FS.s1Plan` only names a tile, a world and a viewer; here it is looked up again. Null with
 * no plan, or one made for another pinned world or another viewer (never used). `{role, place}` for a caravan's end;
 * `{role: 'fort', p, q, tile}` for a fort; `lost: true` when nothing of that kind stands on the tile in what the page
 * holds now (the place is not put in the form, and the card says so).
 */
export function s1PlanNow(FS) {
  const pl = FS.s1Plan ?? null, sc = planScope(FS);
  if (!pl || pl.world !== sc.world || pl.viewer !== sc.viewer) return null;
  if (pl.role === 'fort') return { id: pl.id ?? null, role: 'fort', p: pl.p, q: pl.q, tile: pl.tile, place: null, lost: false };
  const place = s1PlaceAt(FS, { p: pl.p, q: pl.q, idx: pl.tile });
  const fits = !!place && (pl.role === 'dst' || (pl.role === 'src' && place.kind === 'vault' && !place.other));
  return { id: pl.id ?? null, role: pl.role, p: pl.p, q: pl.q, tile: pl.tile, place: fits ? place : null, lost: !fits };
}
/**
 * What the map's tile card may hand to the trade card for this tile: `{place, dst, src, fort, why}`. `dst`: a caravan can
 * be sent THERE (a place stands on it and some source is another place); `src`: a caravan can leave FROM there (the
 * viewer's own storehouse); `fort`: the viewer's own fort in the province of the village in hand. Only what the forms
 * themselves list is offered; whether the caravan can be sent is the form's and the program's to say.
 */
export function s1PlanOffers(FS, sel) {
  const h = activeHolding(FS), place = s1PlaceAt(FS, sel);
  if (!h) return { place, dst: false, src: false, fort: false, why: place ? 'NoHolding' : null };
  const m = s1VillageModel(FS);
  const dst = !!place && m.sources.some(s => !samePlace(s, place));
  const src = !!place && place.kind === 'vault' && !place.other;
  const fort = !!sel && sel.p === h.p && sel.q === h.q && m.forts.some(f => f.tile === sel.idx);
  return { place, dst, src, fort, why: place && !dst && !src ? 'SamePlace' : null };
}

export function s1VillageModel(FS) {
  const s1 = FS.s1 ?? {}, mine = viewerTag(FS), h = activeHolding(FS);
  const vaults = (s1.caravans?.vaults ?? []).filter(v => isMine(v.ownerTag, mine));
  const caravans = (s1.caravans?.moving ?? []).filter(c => isMine(holderOf(c), mine)).map(c => ({ ...c, arriveBell: arriveBellOfTs(c, ts => (Number.isFinite(Number(FS.season?.genesisTs)) ? bellAt(Number(FS.season.genesisTs), ts) : null)) ?? caravanArriveBell(c) }));
  const structures = (s1.structures?.structures ?? []).filter(s => isMine(s.ownerTag, mine)).map(s => ({ ...s, name: KIND_NAME[s.kind] }));
  // where a caravan may leave from: the village in hand (its stores now) or one of the viewer's storehouses (the stores
  // the herald read from its account; a storehouse whose stores are not known yet offers nothing to send)
  // (2026-11-16: the capture lock — caravan.rs send_caravan_as for a village source, structure.rs fort_garrison_as —
  //  refuses while the village in hand is being captured: CapturePending; a storehouse source is not locked)
  const locked = !!h && capturePending(FS, h);
  const sources = [
    ...(h ? [{ kind: 'holding', p: h.p, q: h.q, site: h.site, gen: h.gen ?? 0, tile: h.tile, have: haveOf(FS, h), locked }] : []),
    ...vaults.map(v => ({ kind: 'vault', p: v.p, q: v.q, tile: v.tile, gen: v.gen, known: Array.isArray(v.stores), have: Array.isArray(v.stores) ? v.stores.map(Number) : Array(8).fill(0), cap: Number(v.cap ?? 0) })),
  ];
  const destinations = [
    ...(FS.holdings ?? []).map(o => ({ kind: 'holding', p: o.p, q: o.q, site: o.site, gen: o.gen ?? 0, tile: o.tile })),
    ...vaults.map(v => ({ kind: 'vault', p: v.p, q: v.q, tile: v.tile, gen: v.gen })),
    ...othersPlaces(FS, mine, h),
  ];
  // (fix-loop8, LP8-3: the destinations of the ① requests this viewer accepted on the board — hud/coopboard.mjs
  //  acceptedDestinations: the request's own published place, even when its province is out of sight and not loaded.
  //  One already listed is marked, not listed twice. Its tile comes from the province when it is loaded; otherwise the
  //  send reads it first — controller s1Caravan)
  for (const c of coopDestinations(FS)) {
    if (own(FS, c)) continue;
    const at = destinations.find(x => x.kind === 'holding' && x.p === c.p && x.q === c.q && x.site === c.site);
    if (at) { at.coop = c.coop; at.coopGen = c.gen; continue; }
    const prov = FS.provinces?.get?.(`${c.p},${c.q}`)?.province;
    const t = Number(prov?.sites?.[c.site]);
    destinations.push({ ...c, tile: Number.isInteger(t) ? t : null, faction: Number.isInteger(c.faction) ? c.faction : null, coopGen: c.gen });
  }
  const prov = h ? FS.provinces?.get?.(`${h.p},${h.q}`)?.province ?? null : null;
  const forts = h ? structures.filter(s => s.kind === KIND.fort && s.p === h.p && s.q === h.q).map(s => {
    const r = (prov?.forts ?? []).find(f => Number(f.tile) === s.tile && Number(f.state) !== 0);
    const troops = r ? Math.floor(Number(r.troops) / 1000) + Number(r.pend ?? 0) : 0;
    return { ...s, troops, room: Math.max(0, FORT_MAX_TROOPS - troops) };
  }) : [];
  const spearmen = Number(h?.reserve?.[0] ?? 0);
  const faction = FS.citizen?.faction;
  const n = s1.nations;
  const voted = Array.from(FS.citizen?.voted ?? [], Number);
  // nation.rs `eligible`: in the season ELIGIBLE_BELLS, not expelled
  const joinBell = Number(FS.citizen?.joinBell ?? NaN);
  const eligibleAt = Number.isFinite(joinBell) ? joinBell + ELIGIBLE_BELLS : null;
  const open = (n?.proposals ?? []).filter(x => x.faction === faction && x.state === 'open');
  // nation.rs: one open proposal a proposer (Propose refuses ProposalState while the viewer's last one is open)
  const me = viewerTag(FS);
  const ownOpen = open.find(x => me !== null && me !== undefined && x.proposerTag !== undefined && BigInt(x.proposerTag) === BigInt(me)) ?? null;
  const nation = Number.isInteger(faction) && n ? {
    faction, eligibleAt, eligible: eligibleAt !== null && eligibleAt <= Number(FS.nowBell ?? 0), full: open.length >= NATION_PROPOSALS,
    ownOpen: ownOpen && { slot: ownOpen.slot, id: ownOpen.id, closeBell: ownOpen.closeBell },
    stances: Array.from({ length: NATIONS }, (_, f) => (f === faction ? null : { faction: f, stance: STANCES[n.stances?.[faction]?.[f] ?? 0] })).filter(Boolean),
    toward: Array.from({ length: NATIONS }, (_, f) => (f === faction ? null : { faction: f, stance: STANCES[n.stances?.[f]?.[faction] ?? 0] })).filter(Boolean),
    proposals: open.map(x => ({ ...x, voted: voted[x.slot] === x.id, closesIn: x.closeBell - Number(FS.nowBell ?? 0) })),
    decided: (n.proposals ?? []).filter(x => x.faction === faction && (x.state === 'passed' || x.state === 'failed')).slice(-4).reverse(),
    // the nation's expelled villages; one may be proposed back after READMIT_BELLS (nation.rs readmittable)
    out: (n.expelled ?? []).filter(x => x.faction === faction).map(x => ({ ...x, readmitAt: Number(x.since) + READMIT_BELLS, readmittable: Number(x.since) + READMIT_BELLS <= Number(FS.nowBell ?? 0), named: (x.holdings ?? []).length > 0 })),
    expelled: !!(FS.citizen?.expelledSince && BigInt(FS.citizen.expelledSince) !== 0n),
  } : null;
  // the workshops eat the ore (arms.rs: 8 ore an hour each against a village's base 4) and every unit costs ore: a
  // village whose ore no longer grows can make arms but cannot train (s1-season-2: every player's village did this)
  let oreStarved = false;
  if (h) {
    const now = FS.chain?.now?.() ?? 0;
    const ore = storesAt(settled(h, now), now, RESOURCE_ORDER)[RESOURCE_ORDER.indexOf('Ore')];
    // (production[4]: the Horses slot, the workshops' arms under S1)
    oreStarved = Number(h.production?.[4] ?? 0) > 0 && !!ore && ore.perHour <= 0 && ore.value < 100;
  }
  // (2026-11-16: structure.rs fort_garrison_as also refuses a village that is not final after the lazy flip (NotFinal)
  //  and a Province behind the turn (NotResident, prologue::resident_ok); the form offered both)
  const nowBell = Number(FS.nowBell ?? 0), now = FS.chain?.now?.() ?? 0;
  const fortBlocks = !h ? [] : [...(locked ? ['CapturePending'] : []), ...(!isFinal(h, prov, now, nowBell) ? ['NotFinal'] : []),
    ...(!prov || Number(prov.resolvedNext) + 1 < nowBell ? ['NotResident'] : [])];
  // (2026-11-17, ⑦: the place chosen on the map — s1PlanNow — takes its place in the form's own lists: a destination the
  //  list does not hold (another's place beyond the nearest OTHER_PLACES) is added at its END, so no other index moves;
  //  a source is one of the sources or nothing; a fort is one of this village's forts or nothing)
  const pn = s1PlanNow(FS);
  let plan = null;
  if (pn) {
    plan = { id: pn.id, role: pn.role, dst: null, src: null, fort: null, lost: pn.lost };
    if (pn.role === 'dst' && pn.place) { let i = destinations.findIndex(x => samePlace(x, pn.place)); if (i < 0) { destinations.push(pn.place); i = destinations.length - 1; } plan.dst = i; }
    else if (pn.role === 'src' && pn.place) { const i = sources.findIndex(x => samePlace(x, pn.place)); if (i >= 0) plan.src = i; else plan.lost = true; }
    else if (pn.role === 'fort') { if (h && pn.p === h.p && pn.q === h.q && forts.some(f => f.tile === pn.tile)) plan.fort = pn.tile; else plan.lost = true; }
  }
  return { vaults, caravans, structures, sources, destinations, forts, spearmen, nation, have: haveOf(FS, h), holding: h, oreStarved, fortBlocks, plan };
}

/** How many of other players' places the caravan form lists, the nearest first. */
export const OTHER_PLACES = 24;

/**
 * Other players' places a caravan may go to (caravan.rs: a send to another
 * player needs the wallet, WalletRequired): their storehouses from the
 * caravans feed and their villages in the provinces the page has read (a
 * village's generation is read from its Holding at sending: `gen: null`),
 * the nearest to the village in hand first, OTHER_PLACES of them.
 * (food-net-caravan, owner Q-LP17-4: only the viewer's own nation's places and those in sight now — otherPlaceOffered.)
 */
/** Whether `c` (p, q, site) is one of the viewer's own villages. */
const own = (FS, c) => (FS.holdings ?? []).some(o => o.p === c.p && o.q === c.q && o.site === c.site);

export function othersPlaces(FS, mine, h) {
  const own = FS.holdings ?? [];
  // (the viewer's tag not read yet: whose storehouse is whose is unknown, so none is offered)
  const out = mine === null || mine === undefined ? [] : (FS.s1?.caravans?.vaults ?? []).filter(v => !isMine(v.ownerTag, mine))
    .filter(v => otherPlaceOffered(FS, v))
    .map(v => ({ kind: 'vault', p: v.p, q: v.q, tile: v.tile, gen: v.gen, other: true, faction: v.faction }));
  for (const [key, e] of FS.provinces ?? []) {
    const prov = e?.province;
    if (!prov) continue;
    const [p, q] = String(key).split(',').map(Number);
    const n = Math.min(Number(prov.siteCount ?? 0), 12);
    for (let j = 0; j < n; j++) {
      const mirror = prov.siteMirror?.[j];
      if (!mirror || Number(mirror.state) !== SITE_HOLDING) continue;
      if (own.some(o => o.p === p && o.q === q && o.site === j)) continue;
      if (!otherPlaceOffered(FS, { p, q, tile: Number(prov.sites?.[j]), faction: Number(mirror.faction) })) continue;
      out.push({ kind: 'holding', p, q, site: j, gen: null, tile: Number(prov.sites?.[j]), other: true, faction: Number(mirror.faction) });
    }
  }
  const far = x => (h ? hexDistance(h.p, h.q, x.p, x.q) : 0);
  return out.map((x, i) => ({ x, i, d: far(x) })).sort((a, b) => a.d - b.d || a.i - b.i).slice(0, OTHER_PLACES).map(o => o.x);
}

/**
 * (food-net-caravan) A destination's name for the form: the list is made again at every render AND at the send, and
 * under the fog it changes as places come into and leave sight — the option's index alone could then name another
 * place at the send. The form carries every option's key (the hidden `places`, by index); the send checks the place at
 * the chosen index still has its key.
 */
export const placeKey = d => (d ? `${d.kind}:${d.p}:${d.q}:${d.kind === 'vault' ? `t${d.tile}` : `s${d.site}`}` : '');
/** Two places are the same (a caravan cannot go where it starts). */
export const samePlace = (a, b) => !!a && !!b && a.kind === b.kind && a.p === b.p && a.q === b.q && (a.kind === 'vault' ? a.tile === b.tile : a.site === b.site);

/**
 * What stops a caravan from `src` to `dst` with `cargo` (whole units by
 * resource), as the page's own codes: `NoPlace`, `SamePlace`, `NoCargo`,
 * `Insufficient`; or null. The program checks again (caravan.rs).
 */
export function caravanProblem(src, dst, cargo) {
  if (!src || !dst) return 'NoPlace';
  // (the program refuses a village source being captured before it reads the destination or the cargo)
  if (src.kind === 'holding' && src.locked) return 'CapturePending';
  if (samePlace(src, dst)) return 'SamePlace';
  if (!cargo.some(v => v > 0)) return 'NoCargo';
  if (cargo.some((v, i) => v > Math.floor(src.have?.[i] ?? 0))) return 'Insufficient';
  return null;
}

/**
 * Why FortGarrison(tile, troops) would be refused for the numbers given, or null (structure.rs fort_garrison_as, in its
 * order: troops 1..FORT_MAX_TROOPS, the fort's room after its pending troops — StructureLimit —, then the reserve's
 * Spearmen — Insufficient): `{code, room?}`. The village-wide blocks are `m.fortBlocks`.
 */
export function fortGarrisonProblem(m, tile, troops) {
  if (m?.fortBlocks?.length) return { code: m.fortBlocks[0] };
  const f = (m?.forts ?? []).find(x => x.tile === tile);
  if (!f) return { code: 'NoFort' };
  if (!Number.isInteger(troops) || troops < 1 || troops > FORT_MAX_TROOPS) return { code: 'BadTroops' };
  if (troops > f.room) return { code: 'FortFull', room: f.room };
  if (troops > (m.spearmen ?? 0)) return { code: 'Insufficient' };
  return null;
}
/** The words for an expulsion's blocks (expelOffer). */
export const expelBlockText = b => (b === 'Expelled' ? L`あなたの村は国を追放されているため、投票も提案もできません。`
  : b === 'TargetExpelled' ? L`この村はもう追放されています（国に戻す提案は、追放された村の一覧から出せます）。` : errorText(b));
/** The words for fortGarrisonProblem. */
export const fortProblemText = pr => (pr.code === 'FortFull' ? L`この要塞にはあと ${fmtNum(pr.room)} 人まで入れられます`
  : pr.code === 'NoFort' ? L`要塞を選んでください` : pr.code === 'BadTroops' ? L`入れる人数は 1 から ${fmtNum(FORT_MAX_TROOPS)} までです` : errorText(pr.code));

// ------------------------------------------------------------------ words
const S1_BLOCK = { NoHolding: () => L`村を選んでください（費用は選んだ村から払います）`, Taken: () => L`このマスにはもう建っています`, Unknown: () => L`この州のようすをまだ読み込んでいません`,
  Site: () => errorText('StructureSite'), NoFighterHere: () => L`この村のマスに、着いて落ち着いたあなたの戦う軍勢（斥候以外）がいません。進軍で送り、守りに勝ってから包囲を宣言します`,
  NoHostHere: () => L`このマスに、着いて落ち着いたあなたの軍勢がいません（進軍で送り、次のターンを待ってください）`,
  OwnerUnknown: () => L`持ち主の情報をまだ読み込んでいません。少し待ってください`,
  Heartland: () => L`この村は持ち主の国の本国の中にあるため、包囲できません。本国の外の村か自由都市をねらってください`,
  SourceShielded: () => L`あなたの村がまだ保護期間中です。保護が終わるまで、ほかの村を包囲できません`,
  SiegeBusy: () => L`この村ではすでに包囲か占領が進んでいます`,
  StakeUnsettled: () => L`前の包囲の賭け金の行き先がまだ決まっていません` };
const blockText = b => (S1_BLOCK[b] ?? (() => errorText(b)))();
/** What the village in hand lacks for `cost`, in words ("足りない：石材 173 · 兵器 20"). */
export const shortText = (cost, have) => L`足りない：${shortOf(cost, have ?? []).map(x => `${RESOURCES[RESOURCE_ORDER[x.r]]} ${fmtNum(Math.ceil(x.need))}`).join(' · ')}`;
const costLine = cost => cost.map((v, r) => (v ? html`<span class="nowrap">${RESOURCES[RESOURCE_ORDER[r]]} ${fmtNum(v)}</span>` : '')).filter(Boolean).reduce((a, x) => html`${a}${a ? ' · ' : ''}${x}`, '');
const btn = (act, data, text, { primary = false, disabled = false } = {}) => html`<button type="button" class="btn small${primary ? ' primary' : ''}" data-act="${act}" ${raw(Object.entries(data).map(([k, v]) => `data-${k}="${String(v).replace(/[^\w.-]/g, '')}"`).join(' '))} ${raw(disabled ? 'disabled' : '')}>${text}</button>`;
const kindWord = kind => S1_WORDS[KIND_NAME[kind] ?? kind]?.() ?? '';
export const stanceText = s => STANCE_TEXT[s]?.() ?? s;

/** A tile's S1 section in the inspector (hud/inspect.mjs). */
export function renderS1Tile(FS, sel) {
  const m = s1TileModel(FS, sel);
  if (!m) return '';
  const here = [];
  if (m.vault) here.push(html`<li>${icon('crate')}${S1_WORDS.vault()} ${swatch(m.vault.faction)}${m.vault.mine ? chip(L`あなたの`, 'you') : factionName(m.vault.faction)}</li>`);
  if (m.structure) here.push(html`<li>${icon('shield')}${kindWord(m.structure.kind)} ${swatch(m.structure.faction)}${m.structure.mine ? chip(L`あなたの`, 'you') : factionName(m.structure.faction)}${m.structure.kind === KIND.fort && m.structure.sent ? html` <span class="muted">${L`送った兵 ${fmtNum(m.structure.sent)}`}</span>` : ''}</li>`);
  const raids = m.raids.map(r => html`<div class="s1-raid">${label(L`略奪の決定（ターン ${fmtNum(r.decideBy)} まで）`)}
    <p>${L`あなたの軍勢がこの隊商に勝ちました。荷を奪って自分の村へ運ぶか、焼き払うかを決めてください。`}</p>
    <p class="muted">${r.open ? '' : L`決める期限を過ぎました。`}${L`決めずに期限を過ぎると、村まで隊商の道があれば荷は村へ運ばれ、道がなければターン ${fmtNum(r.decideBy + RAID_BURN_AFTER_BELLS)} 以降に焼かれます。`}</p>
    <div class="actions">${btn('s1-raid', { p: r.p, q: r.q, slot: r.slot, choice: 'take' }, L`奪って運ぶ`, { primary: true, disabled: !r.open })}${btn('s1-raid', { p: r.p, q: r.q, slot: r.slot, choice: 'burn' }, L`焼き払う`, { disabled: !r.open })}</div></div>`);
  // (fix-9-10-followups: a caravan of the viewer's nation that stood here while the viewer's host did — local coexist only)
  const stops = (m.stops ?? []).map(r => html`<div class="s1-stop">${label(L`隊商を止める（ターン ${fmtNum(r.bell + RAID_DECIDE_BELLS)} まで）`)}
    <p>${L`ターン ${fmtNum(r.bell)} に、同じ国の${factionName(r.caravan.faction)}の隊商がこのマスにいて、あなたの軍勢も立っていました。止めると、荷を奪うか焼き払うかを決められます。持ち主の軍勢がこのマスにいると止められません。`}</p>
    <div class="actions">${btn('s1-raid-open', { p: r.p, q: r.q, slot: r.slot }, L`隊商を止める`, { primary: true })}</div></div>`);
  const offer = (act, data, text, o) => html`<li class="s1-offer">${btn(act, data, text, { disabled: o.blocks.length > 0 })}<span class="muted">${costLine(o.cost)}</span>${o.blocks.length ? html`<span class="blocked">${o.blocks.map(b => (b === 'Insufficient' ? shortText(o.cost, m.have) : blockText(b))).join(' / ')}</span>` : ''}</li>`;
  const target = m.vault && !m.vault.mine ? { word: S1_WORDS.vault(), kind: 'vault' } : m.structure && !m.structure.mine ? { word: kindWord(m.structure.kind), kind: 'structure' } : null;
  const seize = m.seize && target ? html`<div class="s1-seize">${label(L`${target.word}を奪う`)}
    <p>${L`このマスに立つあなたの軍勢が、持ち主に代わってこの${target.word}を自分のものにします。持ち主の軍勢がいると奪えません。`}</p>
    <div class="actions">${btn('s1-seize', { p: m.p, q: m.q, tile: m.idx, what: target.kind }, L`${target.word}を奪う`, { primary: true, disabled: m.seize.blocks.length > 0 })}</div>
    ${m.seize.blocks.length ? html`<p class="blocked">${m.seize.blocks.map(blockText).join(' / ')}</p>` : ''}</div>` : '';
  // (2026-11-17, ⑦: the place on this tile, handed to the village's caravan or fort form — app.mjs 's1-plan')
  const po = s1PlanOffers(FS, sel);
  const planData = role => ({ p: m.p, q: m.q, tile: m.idx, role });
  const plan = po.dst || po.src || po.fort || po.why ? html`<div class="s1-plan">${label(L`交易と防備の計画に入れる`)}
    ${po.dst || po.src || po.fort ? html`<div class="actions">${po.dst ? btn('s1-plan', planData('dst'), L`ここへ隊商を送る`) : ''}${po.src ? btn('s1-plan', planData('src'), L`ここから隊商を送る`) : ''}${po.fort ? btn('s1-plan', planData('fort'), L`この要塞に兵を入れる`) : ''}</div>` : ''}
    ${po.why === 'NoHolding' ? html`<p class="blocked">${blockText('NoHolding')}</p>` : po.why === 'SamePlace' ? html`<p class="muted">${L`ここは、いま隊商を出せるただ一つの場所です。同じ場所へは送れません。`}</p>` : ''}
    ${po.dst && po.place?.other ? html`<p class="muted">${L`ここはほかの人の場所です。着いた荷はその人のものになります。`}</p>` : ''}
    <p class="muted">${L`押すと、村の画面の「交易と防備」が開き、この場所が入ります。運ぶものと量は、そこであなたが入れます。まだ何も送りません。`}</p></div>` : '';
  const eo = expelOffer(FS, sel);
  const expel = eo ? html`<div class="s1-expel">${label(L`国の議会に提案する`)}
    <p>${L`この村は同じ国の村です。国から追放する提案を出すと、国の村が1日のあいだ投票します。追放された村は、国の村の柵に止められるようになり、投票も提案もできなくなります。`}</p>
    <div class="actions">${btn('s1-expel', { p: eo.p, q: eo.q, site: eo.site }, L`この村の追放を提案する`, { disabled: eo.blocks.length > 0 })}</div>
    ${eo.blocks.length ? html`<p class="blocked">${eo.blocks.map(expelBlockText).join(' / ')}</p>` : ''}</div>` : '';
  const so = siegeOffer(FS, sel);
  const siege = so ? html`<div class="s1-siege">${label(so.freeCity ? L`自由都市を包囲する` : L`この村を包囲する`)}
    <p>${so.freeCity ? L`包囲が続けば自由都市を取り、あなたの村になります。` : L`包囲が続けば、最初の村なら占領、ほかの村なら奪取になります。`} ${L`宣言には軍勢の村から金 ${fmtNum(SIEGE_STAKE_GOLD)}（包囲の結果で返るか失われます）と兵器 ${fmtNum(SIEGE_ARMS)} を使います。宣言は公開され、守り手に知らされます。`}</p>
    <div class="actions">${btn('s1-siege', { p: sel.p, q: sel.q, tile: sel.idx }, L`包囲を宣言する`, { primary: true, disabled: so.blocks.length > 0 })}</div>
    ${so.blocks.length ? html`<p class="blocked">${so.blocks.map(b => (b === 'Insufficient' ? shortText(so.cost, so.have) : blockText(b))).join(' / ')}</p>` : ''}
    <p class="muted">${L`宣言したあとにプログラムが判定すること：占領後の免除、先頭の軍勢、遅れて置かれた村の保護、奪う枠の空き、この世界の受付の終わりまでに終わるか。`}</p></div>` : '';
  // a tile already taken offers nothing to build: what stands there (and what can be done to it) is said above
  const build = m.site === 'Unknown' || m.vault || m.structure ? '' : html`${fold('s1-build', html`${icon('hammer')}${L`ここに建てる`}`, html`<ul class="list s1-offers">
    ${offer('s1-vault', { p: m.p, q: m.q, tile: m.idx }, L`${S1_WORDS.vault()}を建てる`, m.build.vault)}
    ${m.build.structures.map(o => offer('s1-structure', { p: m.p, q: m.q, tile: m.idx, kind: o.kind }, L`${kindWord(o.kind)}を建てる`, o))}</ul>
    <p class="muted">${L`費用は選んでいる村の蔵から払います。物見櫓はまわりの動きを知らせ、柵と要塞は通る敵を止めます。`}</p>`)}`;
  return html`<div class="s1-tile">${here.length ? html`<ul class="list s1-here">${here}</ul>` : ''}${plan}${stops}${raids}${seize}${siege}${expel}${build}</div>`;
}

/** The village's S1 card (screens/holding.mjs). */
/**
 * (workstream 07) The viewer's caravans that left the road's list while this page was open, with no end read yet
 * (hud/statussources.mjs createCaravanWatch), one watch per page state. app.mjs tells it the ends it reads (the away
 * reader's settlements and raids) and resets it with the away reader's scope.
 */
const watches = new WeakMap();
/**
 * (2026-11-17, ⑦) How the three S1 feeds behind this card were read (controller refreshS1 `FS.s1.read`), each as
 * 'ok' (read now, or the herald has no file and nothing was read before: an empty feed), 'stale' (the latest read
 * failed; what is shown was read before), 'staleMissing' (corrected 2026-11-17: the herald has no file NOW and a list
 * read before is kept — it is not the latest read's, and is not said as if it were), 'unreadFailed' (the latest read failed and nothing is held) or 'unread' (not read yet). A feed that is not
 * read is NOT an empty feed: "no caravans", "no storehouses", "no council" are said only of a feed that was read.
 * `reread`: the person's own re-read (controller rereadS1) — 'loading', 'failed' (it could not be made at all) or null.
 */
export function s1ReadState(FS) {
  const s1 = FS.s1 ?? null;
  const feed = n => { const held = !!s1 && s1[n] !== null && s1[n] !== undefined, mark = s1?.read?.[n]; return held ? (mark === 'failed' ? 'stale' : mark === 'missingKept' ? 'staleMissing' : 'ok') : mark === 'failed' ? 'unreadFailed' : 'unread'; };
  const feeds = { caravans: feed('caravans'), structures: feed('structures'), nations: feed('nations') };
  return { ...feeds, any: Object.values(feeds).some(x => x !== 'ok'), reread: FS.s1Reread?.state ?? null, can: FS.mode === 'play' };
}
const FEED_NAME = { caravans: () => L`隊商と貯蔵庫の一覧`, structures: () => L`建物の一覧`, nations: () => L`国の方針と議題` };
/** The note of s1ReadState under the card's head: one line per feed that is not read as it should be, the re-read's own line, and the button; '' when all are read. */
export function renderS1Read(FS) {
  const r = s1ReadState(FS), lines = [];
  for (const n of ['caravans', 'structures', 'nations']) {
    const name = FEED_NAME[n]();
    if (r[n] === 'unread') lines.push(html`<p class="muted" role="status" data-feed="${n}">${L`${name}を、まだ読めていません。ないという意味ではありません。`}</p>`);
    else if (r[n] === 'unreadFailed') lines.push(html`<p class="notice error" role="alert" data-feed="${n}">${L`${name}を読み込めませんでした。ないという意味ではありません。`}</p>`);
    else if (r[n] === 'staleMissing') lines.push(html`<p class="notice error" role="status" data-feed="${n}">${L`${name}は、最新の読み込みでは見つかりませんでした。下に出ているのは、前に読めたものです。いまもそのとおりかどうかは、分かりません。`}</p>`);
    else if (r[n] === 'stale') lines.push(html`<p class="notice error" role="status" data-feed="${n}">${L`${name}の最新の読み込みに失敗しています。下に出ているのは、最後に読めたものです。`}</p>`);
  }
  if (r.reread === 'loading') lines.push(html`<p class="muted" role="status">${L`一覧を読み直しています…`}</p>`);
  else if (r.reread === 'failed') lines.push(html`<p class="notice error" role="alert">${L`一覧を読み直せませんでした。前に読めたものは、そのまま残しています。`}</p>`);
  if (r.can && (r.any || r.reread === 'failed') && r.reread !== 'loading') lines.push(html`<div class="actions"><button type="button" class="btn small" data-act="s1-reread">${icon('return')}${L`一覧を読み直す`}</button></div>`);
  return lines.length ? html`<div class="s1-read" data-caravans="${r.caravans}" data-structures="${r.structures}" data-nations="${r.nations}">${lines}</div>` : '';
}

export const caravanWatchOf = FS => { let w = watches.get(FS); if (!w) { w = createCaravanWatch(); watches.set(FS, w); } return w; };
export function renderS1Village(FS) {
  const m = s1VillageModel(FS);
  if (!m.holding) return '';
  const bell = Number(FS.nowBell ?? 0);
  // (2026-11-17, ⑦: how the feeds behind this card were read — a feed not read is not an empty feed)
  const rd = s1ReadState(FS), listsRead = rd.caravans !== 'unread' && rd.caravans !== 'unreadFailed', builtRead = rd.structures !== 'unread' && rd.structures !== 'unreadFailed';
  const readNote = renderS1Read(FS);
  // (what became of the caravans and fort orders given from this village this turn — screens/villageorders.mjs; an order
  //  whose outcome is not confirmed offers the lists' re-read, unless the note above already does)
  const orderNote = renderVillageOrders(FS, m.holding, FS.chain?.now?.() ?? 0, { kinds: S1_ORDER_KINDS, rereadShown: !!readNote && rd.reread !== 'loading' && (rd.any || rd.reread === 'failed'),
    reread: { act: 's1-reread', label: L`一覧を読み直す`, offered: rd.can && rd.reread !== 'loading' } });
  // (another's village may share a province with the viewer's: its tile tells them apart)
  // (fix-loop8, LP8-3: a ① request's destination names its site — its tile may not be loaded, the province out of sight)
  const placeWord = d => (d.coop && !Number.isInteger(d.tile) ? L`① 依頼の届け先：村（${d.p}, ${d.q} · 村 ${d.site}）`
    : d.coop ? L`① 依頼の届け先：村（${d.p}, ${d.q} · マス ${d.tile}）`
    : d.kind === 'vault' ? L`${S1_WORDS.vault()}（${d.p}, ${d.q} · マス ${d.tile}）`
    : d.other || m.destinations.some(x => x.other && x.kind === 'holding' && x.p === d.p && x.q === d.q) ? L`${L`村`}（${d.p}, ${d.q} · マス ${d.tile}）` : L`村（${d.p}, ${d.q}）`);
  // (workstream 07: under each caravan, its arrival once its turn has come — past the turn is not "arrived": the line
  // says it is not settled yet; 04's own arrival replaces it when 04 registers one — and 04's cancel when registered:
  // hud/statussources.mjs, hud/statusview.mjs)
  const caravanStatus = c => { const a = statusFrom('caravanArrival', FS, c) ?? arrivalOnRoad(c, bell), x = statusFrom('caravanCancel', FS, c); return html`${a ? renderStatus(arrivalView(a)) : ''}${x ? renderStatus(cancelView(x)) : ''}`; };
  // (a caravan gone from the list is not said to have arrived: until its end is read, its state is unknown)
  const gone = Array.isArray(FS.s1?.caravans?.moving) ? caravanWatchOf(FS).observe(m.caravans).filter(g => isMine(g.ownerTag, viewerTag(FS))) : [];
  const caravans = m.caravans.length || gone.length ? html`${label(L`道中の隊商`)}<ul class="list">${m.caravans.map(c => html`<li>${icon('flag')}${c.raided ? S1_WORDS.raided() : S1_WORDS.caravan()} <span class="muted">${c.arriveBell !== null && c.arriveBell > bell ? L`ターン ${fmtNum(c.arriveBell)} に到着` : ''}</span>${caravanStatus(c)}</li>`)}${gone.map(() => html`<li>${icon('flag')}${S1_WORDS.caravan()}${renderStatus(arrivalView({ state: 'unread' }))}</li>`)}</ul>` : '';
  // (05's costs of this village and its switch back to manual play, when 05 registers them; nothing otherwise)
  const costs = statusFrom('villageCosts', FS, m.holding), manual = statusFrom('manualPlay', FS);
  const free = costs ? spendable(m.have, costs.costs ?? [], { committedInHave: costs.committedInHave }) : null;
  const spend = costs ? html`${label(L`費用の状態`)}${(costs.costs ?? []).map(x => renderStatus(costView(x)))}${free?.ok ? html`<p class="muted">${free.uncertain ? L`使える量（未確定の費用を最大で引いた見込み）：${spendText(free.free)}` : L`使える量（予約を引いたあと）：${spendText(free.free)}`}</p>` : html`<p class="blocked">${L`使える量を出せません：${free.errors.join(', ')}`}</p>`}` : '';
  const manualLine = manual ? renderStatus(manualView(manual)) : '';
  const owned = m.vaults.length || m.structures.length ? html`${label(L`あなたの貯蔵庫と建物`)}<ul class="list">${[
    ...m.vaults.map(v => html`<li>${icon('crate')}${S1_WORDS.vault()} <span class="muted">${v.p}, ${v.q} · ${v.tile}</span>${Array.isArray(v.stores)
      ? html` <span class="muted">${v.stores.some(x => Number(x) > 0) ? costLine(v.stores.map(Number)) : L`空`}${v.cap ? L`（上限 ${fmtNum(v.cap)}）` : ''}</span>` : ''}</li>`),
    ...m.structures.map(s => html`<li>${icon('shield')}${kindWord(s.kind)} <span class="muted">${s.p}, ${s.q} · ${s.tile}</span></li>`)]}</ul>` : listsRead && builtRead ? html`<p class="muted">${L`貯蔵庫や物見櫓・柵・要塞は、地図でマスを選ぶと建てられます。`}</p>` : '';
  // the goods a caravan carries (caravan.rs: the first six; arms and influence stay), the most any source holds
  const most = i => Math.max(0, ...m.sources.map(s => Math.floor(s.have?.[i] ?? 0)));
  const sendable = RESOURCE_ORDER.map((r, i) => ({ r, i, have: most(i) })).filter(x => x.have > 0 && x.i < 6);
  // (another player's place is never chosen by default: what arrives there is theirs)
  // (2026-11-17, ⑦: the place chosen on the map is the form's first choice — only where the view starts from its own
  //  markup; a choice the person already made in the form, and every amount, is theirs and is not written over)
  const pl = m.plan;
  // (fix-loop6, LP6-13: a source chosen on the map — 「ここから隊商を送る」 on a storehouse — is what the first destination is
  //  told apart from; it was the village's, and the storehouse came out as both source and destination)
  const plannedSrc = pl?.src !== null && pl?.src !== undefined ? m.sources[pl.src] : null;
  const firstDst = pl?.dst ?? m.destinations.findIndex(x => !x.other && !samePlace(plannedSrc ?? m.sources[0], x));
  const firstSrc = pl?.src ?? (pl?.dst !== null && pl?.dst !== undefined && samePlace(m.sources[0], m.destinations[pl.dst]) ? m.sources.findIndex(x => !samePlace(x, m.destinations[pl.dst])) : -1);
  // (fix-loop6, LP6-13: the amounts' upper bound is the SELECTED source's stock — it was the most any source held, the
  //  village's food 629 for a storehouse of wood 19 —, and follows a change of source: app.mjs, select[name=src])
  const srcNow = m.sources[firstSrc >= 0 ? firstSrc : 0];
  const haveOf6 = s => (s?.have ?? []).slice(0, 6).map(v => Math.max(0, Math.floor(Number(v) || 0)));
  const planned = pl?.dst !== null && pl?.dst !== undefined ? m.destinations[pl.dst] : pl?.src !== null && pl?.src !== undefined ? m.sources[pl.src] : null;
  // (corrected 2026-11-17: the note says what was chosen on the map and that it is the field's FIRST choice — not that
  //  it "is" the destination: a choice the person makes in the field afterwards is what is sent, and the note must not
  //  contradict the field. `data-plan-id`: the plan's number, for app.mjs landS1Plan.)
  const unpick = html`<button type="button" class="btn small" data-act="s1-plan-clear">${L`選択を外す`}</button>`;
  const planNote = !pl ? '' : pl.lost ? html`<p class="notice error" role="status" data-plan="lost" data-plan-id="${pl.id ?? ''}">${L`地図で選んだ場所を、いま読めている一覧では確かめられません。計画には入れていません。`} ${unpick}</p>`
    : planned ? html`<p class="notice" role="status" data-plan="${pl.dst !== null ? 'dst' : 'src'}" data-plan-id="${pl.id ?? ''}">${pl.dst !== null
      ? L`地図で選んだ場所：${placeWord(planned)}。行き先の欄の最初の選択にしました。欄で選び直すと、送るのは選び直した場所です。`
      : L`地図で選んだ場所：${placeWord(planned)}。出発地の欄の最初の選択にしました。欄で選び直すと、出発するのは選び直した場所です。`}${planned.other ? L`ここはほかの人の場所です。着いた荷はその人のものになります。` : ''}${L`運ぶものと量は、あなたが入れてください。`} ${unpick}</p>`
    : pl.fort !== null ? html`<p class="notice" role="status" data-plan="fort" data-plan-id="${pl.id ?? ''}">${L`地図で選んだ要塞：マス ${pl.fort}。要塞の欄の最初の選択にしました。欄で選び直すと、兵を入れるのは選び直した要塞です。入れる人数は、あなたが決めてください。`} ${unpick}</p>` : '';
  const haveText = s => (s.kind === 'vault' && !s.known ? L`在庫はまだ読み込んでいません`
    : s.have.slice(0, 6).map((v, i) => (v > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(Math.floor(v))}` : '')).filter(Boolean).join(' · ') || L`空`);
  const dstOption = (d, i) => html`<option value="${i}" data-key="${placeKey(d)}" ${raw(i === firstDst ? 'selected' : '')}>${placeWord(d)}${d.other && Number.isInteger(d.faction) ? ` · ${factionName(d.faction)}` : ''}</option>`;
  const ownDst = m.destinations.map((d, i) => [d, i]).filter(([d]) => !d.other), otherDst = m.destinations.map((d, i) => [d, i]).filter(([d]) => d.other);
  const send = ownDst.length >= 2 || (m.sources.length && otherDst.length) ? html`<form class="vform" data-form="s1-caravan">
    <label class="field">${L`出発地`}<select name="src" data-plan="${pl?.src ?? ''}">${m.sources.map((s, i) => html`<option value="${i}" data-have="${haveOf6(s).join(',')}" ${raw(i === firstSrc ? 'selected' : '')}>${placeWord(s)} — ${s.locked ? errorText('CapturePending') : haveText(s)}</option>`)}</select></label>
    <label class="field">${L`行き先`}<select name="dst" data-plan="${pl?.dst ?? ''}">${otherDst.length
      ? html`<optgroup label="${L`あなたの場所`}">${ownDst.map(([d, i]) => dstOption(d, i))}</optgroup><optgroup label="${L`ほかの人の場所`}">${otherDst.map(([d, i]) => dstOption(d, i))}</optgroup>`
      : ownDst.map(([d, i]) => dstOption(d, i))}</select></label>
    <input type="hidden" name="places" value="${m.destinations.map(placeKey).join('|')}">
    <input type="text" name="picked" value="" hidden tabindex="-1" aria-hidden="true" autocomplete="off">
    ${sendable.map(x => html`<div class="count-row"><label class="count-label" for="s1-c${x.i}">${RESOURCES[x.r]}</label><input id="s1-c${x.i}" name="c${x.i}" type="number" min="0" max="${haveOf6(srcNow)[x.i] ?? 0}" step="1" value="0" inputmode="numeric"></div>`)}
    <p class="muted">${L`運べる量は出発地の蔵にある分までです（出発地ごとの在庫は上の一覧のとおり）。`}</p>
    <div class="actions"><button type="submit" class="btn primary">${L`隊商を送る`}</button></div>
    ${otherDst.length ? html`<p class="muted">${L`ほかの人の村や貯蔵庫へ送ると、着いた荷はその人のものになります。ほかの人あての隊商は、ゲーム内の鍵ではなくウォレットで署名して送ります。`}</p>` : ''}
    ${fogActive(FS) ? html`<p class="muted s1-dst-sight">${L`行き先に並ぶのは、あなたの場所、あなたの国の村と貯蔵庫、いま見えている村と貯蔵庫だけです。`}</p>` : ''}
    ${otherDst.some(([d]) => d.coop) ? html`<p class="muted s1-coop-dst">${L`「① 依頼の届け先」は、国をまたぐ依頼の板であなたが「応じる」と答えた依頼の行き先です（依頼した人が板に公開した場所だけ。まわりの土地は見えないままです）。送ったあと、板で隊商を依頼に結び付けると、到着が数えられます。`}</p>` : ''}
    <p class="muted">${L`隊商は軍勢より遅く、道の上で略奪されることがあります。物見櫓の見張る土地や味方の柵の近くを通ると安全です。`}</p></form>`
    : listsRead ? html`<p class="muted">${L`隊商を送れる行き先（ほかの村か貯蔵庫）がまだありません。`}</p>` : html`<p class="muted">${L`貯蔵庫の一覧をまだ読めていないので、送れる行き先がそろっていません。`}</p>`;
  const fort = m.forts.length ? html`<form class="vform" data-form="s1-fort">
    <label class="field">${L`要塞`}<select name="tile" data-plan="${pl?.fort ?? ''}">${m.forts.map(f => html`<option value="${f.tile}" ${raw(pl?.fort === f.tile ? 'selected' : '')}>${L`マス ${f.tile}（兵 ${fmtNum(f.troops)} / ${fmtNum(FORT_MAX_TROOPS)}）`}</option>`)}</select></label>
    <div class="count-row"><label class="count-label" for="s1-ft">${L`入れる槍兵（控えから）`}<span class="muted"> / ${fmtNum(m.spearmen)}</span></label><input id="s1-ft" name="troops" type="number" min="1" max="${Math.min(m.spearmen, FORT_MAX_TROOPS)}" step="1" value="${Math.min(100, m.spearmen) || 1}" inputmode="numeric"></div>
    <div class="actions"><button type="submit" class="btn" ${raw(m.spearmen > 0 && !m.fortBlocks.length ? '' : 'disabled')}>${L`要塞に兵を入れる`}</button></div>
    ${m.fortBlocks.length ? html`<p class="blocked">${m.fortBlocks.map(blockText).join(' / ')}</p>` : ''}
    <p class="muted">${L`兵は次のターンから要塞を守ります。`}</p></form>` : '';
  const n = m.nation;
  const nation = n ? html`${label(L`国の方針`)}
    <ul class="list s1-stances">${n.stances.map(x => html`<li>${swatch(x.faction)}${factionName(x.faction)}: ${stanceText(x.stance)}</li>`)}</ul>
    ${n.proposals.length ? html`${label(L`投票中の議題`)}<ul class="list">${n.proposals.map(x => html`<li>${proposalText(x)} <span class="muted">${x.closesIn > 0 ? L`賛成 ${fmtNum(x.yes)} · 反対 ${fmtNum(x.no)} · あと ${fmtNum(x.closesIn)} ターン` : L`賛成 ${fmtNum(x.yes)} · 反対 ${fmtNum(x.no)} · 締め切り（集計を待っています）`}</span>
      ${x.voted ? chip(L`投票済み`, 'ok', 'check') : x.closesIn > 0 ? html`<span class="actions">${btn('s1-vote', { slot: x.slot, id: x.id, yes: 1 }, L`賛成`, { disabled: n.expelled || !n.eligible })}${btn('s1-vote', { slot: x.slot, id: x.id, yes: 0 }, L`反対`, { disabled: n.expelled || !n.eligible })}</span>` : ''}</li>`)}</ul>` : ''}
    ${n.out.length ? html`${label(L`追放された村`)}<ul class="list">${n.out.map(x => html`<li>${L`ターン ${fmtNum(x.since)} に追放`}
      ${x.readmittable && x.named ? btn('s1-readmit', { tag: x.tag }, L`国に戻す提案をする`, { disabled: n.expelled || !n.eligible || n.full || !!n.ownOpen }) : html`<span class="muted">${x.named ? L`ターン ${fmtNum(x.readmitAt)} から戻す提案ができます` : L`この村の情報をまだ読み込んでいません`}</span>`}</li>`)}</ul>` : ''}
    ${n.decided.length ? html`${label(L`決まった議題`)}<ul class="list">${n.decided.map(x => html`<li>${proposalText(x)} ${x.state === 'passed' ? chip(L`可決`, 'ok', 'check') : chip(L`否決`, 'warn')} <span class="muted">${L`賛成 ${fmtNum(x.yes)} · 反対 ${fmtNum(x.no)}`}</span></li>`)}</ul>` : ''}
    ${n.expelled ? html`<p class="blocked">${L`あなたの村は国を追放されているため、投票も提案もできません。`}</p>`
      : !n.eligible ? html`<p class="blocked">${n.eligibleAt === null ? L`投票と提案は、国に加わってから ${fmtNum(ELIGIBLE_BELLS)} ターン後にできるようになります。` : L`投票と提案は、ターン ${fmtNum(n.eligibleAt)} からできます（国に加わってから ${fmtNum(ELIGIBLE_BELLS)} ターン）。`}</p>`
      : n.full ? html`<p class="blocked">${L`投票中の議題が ${fmtNum(NATION_PROPOSALS)} 件あるため、新しい提案は締め切りを待ってから出せます。`}</p>`
      : n.ownOpen ? html`<p class="blocked">${L`あなたの提案がまだ投票中です。ターン ${fmtNum(n.ownOpen.closeBell)} の締め切りのあとで次の提案を出せます（提案は一人ひとつずつ）。`}</p>` : html`<form class="vform" data-form="s1-propose">
      <label class="field">${L`相手の国`}<select name="target">${n.stances.map(x => html`<option value="${x.faction}">${factionName(x.faction)}</option>`)}</select></label>
      <label class="field">${L`方針`}<select name="value">${STANCES.map((s, i) => html`<option value="${i}">${stanceText(s)}</option>`)}</select></label>
      <div class="actions"><button type="submit" class="btn">${L`方針の変更を提案する`}</button></div>
      <p class="muted">${L`提案は1日のあいだ投票を受け、賛成が3票以上かつ反対より多ければ決まります。`}</p></form>`}` : '';
  return html`<section class="vcard vcard-folds s1-card" id="hp-trade" aria-labelledby="s1-title">
    ${cardHead({ id: 's1-title', ic: 'flag', title: L`交易と防備` })}
    ${m.oreStarved ? html`<p class="blocked">${L`工房が鉱石をすべて使っていて、鉱石が増えていません。兵の訓練にも鉱石が要るので、鉱山を建てるまで訓練できなくなります。`}</p>` : ''}
    ${readNote}${orderNote}${manualLine}${spend}${caravans}${owned}
    ${planNote}
    ${fold('s1-send', html`${icon('flag')}${L`隊商を送る`}`, send, { open: !!pl && !pl.lost && pl.fort === null })}
    ${fort ? fold('s1-fort', html`${icon('shield')}${L`要塞に兵を入れる`}`, fort, { open: !!pl && pl.fort !== null }) : ''}
    ${nation ? fold('s1-nation', html`${icon('banner')}${L`国の議会`}`, nation) : ''}
    ${renderCoopSlot(FS)}</section>${renderRights(FS)}${renderCustody(FS)}`;
}

/** A proposal in words. */
export function proposalText(x) {
  if (x.kind === 'stance') return L`${factionName(x.targetFaction)}への方針を「${stanceText(STANCES[x.value] ?? 'war')}」にする`;
  if (x.kind === 'expel') return L`村をひとつ国から追放する`;
  return L`追放された村を国に戻す`;
}
