// The village drawer (web design §7.4; contract §5.10, I-29, I-56; UX design
// sections 1 and 6): short parchment cards with the common action first —
//   the village (name, tier, state, shield);
//   its stores as a ruled ledger (a line per resource: amount, cap, rate), and "harvest";
//   building: the queue, the three buildings that can go up now, the rest
//     behind a fold;
//   the troops: the reserve, then the action that makes sense now (muster
//     when there is a reserve, else train), the other behind a fold;
//   the rest (garrison, vigil hours, the village's details) as folds.
// The stores are settled lazily as the kernel does; training is immediate
// (I-56); a mustered host joins the roster from the next bell. Every action
// says why it cannot run now, with a "catch up" nudge when the province
// lags (NotResident).
import { s1On } from '../fs1.mjs';
import { localLane, COEXIST_LANE } from '../flocalplay-lane.mjs';
import { renderS1Village, caravansOff } from './s1.mjs';
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { icon, RESOURCE_ICON } from '../hud/icons.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER, UNITS, TIERS, BUILDINGS, HOLDING_STATES, errorText, factionName } from '../fi18n.mjs';
import { storesAt, holdingFacts, BUILD_ITEMS, buildItemOf, UNIT_ORDER, SETTLER, actionBlocks, ticketTimes, queueBuildingItem, trainingQuote, baseProduction, garrisonRoom } from '../fland.mjs';
import { settled, buildOffers, promotionOffer, queueNow, queueSlots, trainCost, shortOf, ITEM_TIER_UP } from '../hud/rulebook.mjs';
import { costChips, costWords, shortWords, took, unitGood, whyText } from '../hud/orderparts.mjs';
import { holdingName } from '../people/ui.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { span, NEAR_FULL_SECS } from '../hud/hud.mjs';
import { termButton } from '../hud/glossary.mjs';
import { row, dueHtml } from './shell.mjs';
import { villageConfirm } from '../hud/provisional.mjs';
import { countdown } from '../clock.mjs';
import { realTail, termsRate } from '../seasonterms.mjs';
import { cardHead, label, fold, chip, stamp } from './parts.mjs';
import { renderVillageOrders } from './villageorders.mjs';
import { hostsIn } from '../fland.mjs';
import { TERRITORY_V1, ownLandView, tileStillMine } from '../flocalplay-territory.mjs';
import { solText } from '../fdevnet-outpost.mjs';
import { unreadHostPlaces } from './host.mjs';
import { villageDrawn, provinceCoords } from '../hud/place.mjs';
import * as wideHolding from './wideholding.mjs';
import { claimTargets, settlerCost, mergeOpened, nationLandsOfCells } from '../flocalplay-wide.mjs';
import { expeditionHoldsOf } from '../flocalplay-expedition.mjs';
import { wideSlots } from '../fwide.mjs';
import { outpostCard } from './outpostcard.mjs';
import { landUpkeepMilli, withLand, signedNet, landPart, landPayer } from '../landfood.mjs';
import { projectHorizon, otherVillageNote, horizonLead, horizonStatusLines } from '../landhorizon.mjs';

/**
 * (TEST-ONLY wide play, LOCAL play only: owner t379u 「広い版がんばれ」) The village screen's wide-land card in a local
 * wide-land world (`FS.localPlay.wideLand`, the launcher's statement): the opened wide provinces within reach of this
 * first home (`outpost_range` 3), the settler cost of the next village against the stores, and one button per province
 * that files the WIDE CLAIM (0xD9 WideClaimSite, flocalplay-wide.mjs) on its next untried site. The world's runner
 * settles the claim. Nothing for any other world, a village that is not the first home, or one out of reach.
 */
/**
 * (fix-loop16, Q-LP16-1 (b)) The provinces whose rows the wide claim card never drops: Map "p,q" → 'tiles' (this player
 * owns a tile there: the page's own memory of the tile claims that landed in this visit, `FS.ui.ownTiles`, keys
 * "p,q,tile", while the territory read has not shown it let go since: tileStillMine), 'siege' (a host of this player is taking that province's keep: a kept expedition's followed hold that
 * is not lost — flocalplay-expedition.mjs expeditionHoldsOf — or the wide village's host marching on or holding it —
 * `FS.ui.wideHostSay`) or 'keep' (that hold ended with the keep taken). 'siege' / 'keep' win over 'tiles'. Display only: nothing is read from the chain here.
 */
export function claimPins(FS) {
  const pins = new Map();
  // (verify-pr247: a remembered tile the territory read shows let go since pins nothing — live, a province whose only
  //  tile was released for unpaid upkeep still said 「あなたのマスがある州」; the same rule as the card and the presses,
  //  flocalplay-territory.mjs tileStillMine)
  const tnow = typeof FS?.territoryTilesNow === 'function' ? FS.territoryTilesNow() : null;
  for (const k of Object.keys(FS?.ui?.ownTiles ?? {})) { const m = /^(-?\d+),(-?\d+),(\d+)$/.exec(k); if (m && tileStillMine(FS.ui.ownTiles, m[1], m[2], m[3], tnow)) pins.set(`${m[1]},${m[2]}`, 'tiles'); }
  // ('keep': the hold ended with the keep taken — the row says 「奪った」, not 「奪っている」)
  const siege = (to, taken = false) => { if (to && to.p !== undefined && to.q !== undefined) pins.set(`${String(to.p)},${String(to.q)}`, taken ? 'keep' : 'siege'); };
  for (const h of expeditionHoldsOf(FS ?? {}).values()) if (h?.to && h.outcome !== 'lost' && !Number.isInteger(h.keepLostAt)) siege(h.to, h.outcome === 'taken');
  const say = FS?.ui?.wideHostSay ?? null;
  if (say?.hold?.to && say.hold.outcome !== 'lost') siege(say.hold.to, say.hold.outcome === 'taken');
  if (say?.march?.to && say.march.phase !== 'gone') siege(say.march.to);
  if (say?.kind === 'decision' && say.name === 'WideDepart' && say.to) siege(say.to);
  return pins;
}
/** `list` (in its order) cut to `cap` rows, the pinned ones never cut: each kept row carries `pin` ('tiles' | 'siege' | null). */
export function pinnedRows(list, cap, pins) {
  const pinOf = t => pins?.get?.(`${String(t.p)},${String(t.q)}`) ?? null;
  let room = Math.max(0, cap - list.filter(pinOf).length);
  return list.filter(t => pinOf(t) || room-- > 0).map(t => ({ ...t, pin: pinOf(t) }));
}
export function wideClaimModel(FS, m) {
  // (DEVNET PLAY, devnet gap P1: a wide devnet season's opened wide provinces, controller FS.devnetWideLand)
  const wide = FS?.localPlay?.wideLand ?? FS?.devnetWideLand ?? null;
  if (!wide || !m?.holding) return null;
  const h = m.holding;
  if (Number(h.order ?? 1) !== 1) return null;
  // (loop-play4 B-9: a wide village of this citizen is a wide-bound slot of its inventory, not one of FS.holdings — it
  //  counts toward the three villages, and its province is never offered again)
  const mine = wideSlots(FS);
  const held = new Set(mine.filter(e => e.holding).map(e => `${String(e.holding.p)},${String(e.holding.q)}`));
  // (expansion-gameplay-1, reach from the nation's land — local wide worlds and devnet territory worlds (below); the devnet wide program 67a33c92 takes no witness:
  //  the opened wide land as the herald records it now (it grows where nations go), and the nation's land in it —
  //  a village of the nation, or a keep it won —, from which a claim may also reach OUTPOST_RANGE provinces)
  const local = !!FS?.localPlay?.wideLand;
  // (devnet-territory-dev: a devnet TERRITORY world — its gateway carries the tile claim, controller FS.devnetTerritory —
  //  runs the program of #206/#209: the nation-land reach and the tiles as in a local wide world)
  const rich = local || !!FS?.devnetTerritory;
  const cells = rich && typeof FS.wideLandNow === 'function' ? (FS.wideLandNow()?.cells ?? []) : [];
  const opened = rich ? mergeOpened(wide.targets, cells) : wide.targets;
  const lands = rich ? nationLandsOfCells(cells, FS.citizen?.faction) : [];
  const all = claimTargets({ p: h.p, q: h.q }, opened, lands).filter(t => !held.has(`${String(t.p)},${String(t.q)}`));
  // (fix-loop16, owner 2026-11-25 12:04 Q-LP16-1 (b): the card keeps its short list — 4 provinces near the first home, 6
  //  through the nation's land — but a province where this player owns a tile, or whose keep a host of this player is
  //  taking, ALWAYS keeps its row: as the land opened, nearer provinces pushed those rows off the card (loop-play16
  //  LP16-1) while the rule still took their claims. A pinned row counts toward the 4 / 6; more pinned than that all stay)
  const pins = claimPins(FS);
  const targets = [...pinnedRows(all.filter(t => !t.reach), 4, pins), ...pinnedRows(all.filter(t => t.reach), 6, pins)];
  const owned = (Array.isArray(FS.holdings) ? FS.holdings.length : 1) + mine.length;
  // (loop-play11 / D-verify-pr177-1: the program charges `settler_cost(holdings_n)` with holdings_n = the villages
  //  held BEFORE the claim — frontier proc wide.rs reads C::HOLDINGS_N — so a second village costs 800/800/400/200,
  //  not 1,200; asking for `owned + 1` kept the button shut until the stores held 1.5× the price)
  const need = settlerCost(Math.min(2, owned));
  const short = need.map((n, i) => ({ resource: RESOURCE_ORDER[i], need: n, have: m.have[i] ?? 0 })).filter(x => x.need > 0 && x.have < x.need);
  const tried = FS.ui?.wideTried ?? {};
  // (a slot-3 claim names the slot-2 wide village as its previous pair: flocalplay-wide.mjs wideClaimIntent)
  const prevH = mine.find(e => e.inventorySlot === 2 && e.holding)?.holding ?? null;
  const previous = prevH ? { p: String(prevH.p), q: String(prevH.q), site: Number(prevH.site) } : null;
  // (verify-pr206-209: in a territory world each province row also claims a single tile — instant, paid in ore, one a
  //  turn — whatever the next village's cost: the land grows by tiles, not only by village sites)
  const byKey = rich && typeof FS.wideLandNow === 'function' ? FS.wideLandNow()?.byKey ?? null : null;
  const terrOf = t => byKey?.get?.(`${t.p},${t.q}`)?.territory ?? null;
  const territory = all.some(t => terrOf(t)) || [...held].some(k => byKey?.get?.(k)?.territory);
  const ore = m.have[RESOURCE_ORDER.indexOf('Ore')] ?? 0;
  // (loop-play15 LP15-4: a province where a village of this player stands left the list — no second village there —
  //  and with it the only "Claim a tile" button of that province; with three villages the whole list went. In a
  //  territory world those provinces stay as tile-only rows: the land around one's own village is the first to claim.
  //  LOCAL wide worlds only: the devnet page's wallet-paid tile claim (#221) has not been played with these rows)
  const own = territory && local ? claimTargets({ p: h.p, q: h.q }, opened, lands).filter(t => held.has(`${String(t.p)},${String(t.q)}`) && terrOf(t)).map(t => ({ ...t, site: 0, territory: true, own: true })) : [];
  if (!targets.length && !own.length) return null;
  // (territory-card, owner 2026-11-25 Q-PDT-1 (a), display only: the viewer's OWN land as its territory summary says —
  //  controller refreshOwnLand, `FS.ownLand` of this world and Citizen —: tiles, the next tile's ore, upkeep per hour,
  //  and while upkeep is unpaid the turns left before tiles are let go. Unread yet: no line, the old card)
  const land = territory && FS.ownLand && Object.hasOwn(FS.ownLand, 'player') ? ownLandView(FS.ownLand.player, FS.nowBell ?? 0) : null;
  // (fix-loop18, LP18-4: a province with no tile left to claim kept an open "Claim a tile"; the press was answered
  //  「この州に取れるマスは残っていません。」. The row's button is shut, with those words, once the PAGE knows the province is
  //  full: every tile that is not a village site or the keep's has an owner in what the map's territory read keeps —
  //  the viewer's own tiles always, another player's only in sight (app.mjs FS.territoryTilesNow; nothing the fog hides
  //  is used: a tile whose owner the page may not know counts as free) — or is one this page claimed in this visit
  //  and the read has not shown let go since (flocalplay-territory.mjs tileStillMine).
  //  A race (the last tile taken since the read) is still answered by the press: controller.mjs 'territory-tile')
  const tnow = territory && typeof FS.territoryTilesNow === 'function' ? FS.territoryTilesNow() : null;
  const noFree = t => provinceFull(terrOf(t), tnow?.owners?.get?.(`${t.p},${t.q}`) ?? null, i => tileStillMine(FS.ui?.ownTiles, t.p, t.q, i, tnow));
  // (fix-loop18, LP18-8: the first village's food no longer grows — the net rate the stores show is 0 or below — while
  //  upkeep is still paid from the store: one line says another tile cannot be paid from what the village makes. The
  //  button stays — the rule takes the claim —; unpaid upkeep has its own lines above)
  const foodRow = land && !land.unpaid && land.tiles > 0 && Array.isArray(h.stores) ? withLand(storesAt(h, FS.chain?.now?.() ?? 0, RESOURCE_ORDER).find(x => x.resource === 'Food') ?? null, landUpkeepMilli(FS, h)) : null;
  const foodStalled = foodRow && foodRow.landPerHour > 0 && foodRow.perHour <= 0 ? { perHour: foodRow.perHour } : null;
  // (the button is off below the NEXT tile's price too — it opened at 10 ore whatever the price, and the claim was then refused)
  // (owner-answers-ui, owner 2026-11-26 10:52 item 10: "Claim a tile" is off while land upkeep is unpaid, with its reason
  //  line — the warning above already says no new tile can be claimed; display only, the rule is unchanged)
  const tilePrice = land ? land.nextOre : TERRITORY_V1.cost.base;
  return { targets: targets.map(t => ({ ...t, site: tried[`${t.p},${t.q}`] ?? 0, territory: !!terrOf(t), noFree: noFree(t) })), own: own.map(t => ({ ...t, noFree: noFree(t) })), need, short, full: owned >= 3, slot: Math.min(3, owned + 1), previous, foodStalled,
    territory, tileShort: ore < TERRITORY_V1.cost.base, land, tilePrice, tilePriceShort: ore >= TERRITORY_V1.cost.base && ore < tilePrice, tileOff: ore < tilePrice || !!land?.unpaid, devnet: !local && !!FS?.devnetTerritory, preview: !local && FS?.devnetTerritory && FS.tilePreview?.step === 'preview' ? FS.tilePreview : null };
}
/**
 * (fix-loop18, LP18-4) Whether a territory province is known to have no tile left for "Claim a tile": `terr` its
 * `{siteTiles, keepTile}` (wideland.mjs territoryOfCapture), `owners` the 61 owners the page keeps of it (a tag, or null
 * for a free tile AND for one whose owner the page may not know), `mine(i)` a tile this page claimed. Unknown: false.
 */
export function provinceFull(terr, owners, mine = () => false) {
  if (!terr || !Array.isArray(terr.siteTiles) || !Array.isArray(owners) || owners.length !== 61) return false;
  const skip = new Set([...terr.siteTiles, terr.keepTile]);
  for (let i = 0; i < 61; i++) if (!skip.has(i) && owners[i] === null && !mine(i)) return false;
  return true;
}
/** (fix-loop18, LP18-4) The row's words beside a shut "Claim a tile" of a full province. */
const noFreeNote = t => (t.noFree ? html` <span class="blocked" data-nofree="1">${L`この州に取れるマスは残っていません。`}</span>` : '');
/** (devnet-territory-dev) The tile claim's cost preview on a devnet territory world (fdevnet-territory.mjs): ore from the
 * first home's store, SOL from the wallet (the records the claim creates + the fee); the next press signs and sends. */
function tilePreviewBlock(pv, busy) {
  if (!pv) return '';
  const c = pv.cost, parts = [c.provinceNew ? L`この州の土地の記録 ${solText(c.provinceDeposit)} SOL` : null, c.playerNew ? L`あなたの土地の記録 ${solText(c.playerDeposit)} SOL` : null, L`手数料 ${solText(c.fee)} SOL`].filter(Boolean);
  const data = Object.entries(pv.press?.data ?? {}).map(([k, v]) => ` data-${k}="${String(v).replace(/[^0-9a-z-]/gi, '')}"`).join('');
  const act = pv.press?.act === 'wide-claim' ? 'wide-claim' : 'territory-tile';
  return html`<div class="preview" id="hp-tile-preview" role="group" aria-labelledby="hp-tile-preview-h">
    <p id="hp-tile-preview-h"><strong>${L`州 ${pv.target.p},${pv.target.q} のマス ${pv.tile} を取る費用`}</strong></p>
    <p>${L`鉱石 ${fmtNum(c.ore)}（本拠地の蔵から）`} · ${L`${solText(c.total)} SOL（ウォレットから）`}</p>
    <p class="muted">${parts.join(' · ')}</p>
    <p class="muted">${L`取ったあとの維持費は本拠地の食料から自動で払われます。払えないと新しいマスは取れず、24ターン後から遠いマスが1ターンに1つずつ手放されます。`}</p>
    <button type="button" class="btn small" data-act="${act}"${raw(data)} ${raw(busy ? 'disabled' : '')}>${L`署名して取る`}</button>
    <button type="button" class="btn small ghost" data-act="territory-tile-cancel">${L`やめる`}</button></div>`;
}
/** (territory-card) Upkeep in food per hour from milli-food per hour: up to three decimals (TERRITORY_V1.upkeep is in milli-food). */
const upkeepText = milli => fmtNum(milli / 1000, { maximumFractionDigits: 3 });
/**
 * (territory-card, owner Q-PDT-1 (a)) The card's lines about the viewer's own land: tiles owned, the next tile's price
 * (whole ore), upkeep per hour (food from the first village), and while upkeep is unpaid a warning with the turns left
 * until tiles are let go.
 */
export function ownLandBlock(land) {
  if (!land) return '';
  return html`<p id="hp-own-land"><strong>${L`あなたの土地`}</strong>: ${L`持っているマス ${fmtNum(land.tiles)}`} · ${L`次の1マス: 鉱石 ${fmtNum(land.nextOre)}`} · ${L`土地の維持費: 食料 ${upkeepText(land.upkeepMilliPerHour)}/時`}</p>
    ${land.unpaid ? html`<p id="hp-own-land-unpaid" role="status"><span class="blocked">${land.letting
      ? L`土地の維持費（本拠地の食料）が払えていません。遠いマスから1ターンに1つずつ手放されています。本拠地の毎ターンの食料が土地の維持費に足りるようになると止まります。`
      : land.tiles > 0 ? L`土地の維持費（本拠地の食料）が払えていません。新しいマスは取れません。あと ${fmtNum(land.turnsLeft)} ターン払えないままだと、遠いマスから1ターンに1つずつ手放されます。`
        : L`土地の維持費（本拠地の食料）が払えていません。新しいマスは取れません。本拠地に食料が戻ると、また取れます。`}</span></p>` : ''}`;
}
/** (en-ui-audit-2, a11y) A "Claim a tile" button names the card's lines that say why it is off or refused (ore short of
 * 10 / of the next tile's price, land upkeep unpaid), so a screen reader hears the reason with the button. */

/**
 * (land-logistics-horizon, display only) How far the first village's food
 * supports the land, from settle_upkeep (b). Rendered after ownLandBlock so
 * the existing land lines stay byte-for-byte.
 */
export function villageCensus(FS, payer, now) {
  const seen = new Map();
  const add = h => {
    if (!h) return;
    const k = `${h.p},${h.q},${h.site ?? 0}`;
    if (!seen.has(k)) seen.set(k, h);
  };
  for (const h of FS?.holdings ?? []) add(h);
  try { for (const e of wideSlots(FS) ?? []) if (e?.holding) add(e.holding); } catch { /* inventory unread */ }
  const payerKey = payer ? `${payer.p},${payer.q},${payer.site ?? 0}` : '';
  let otherFoodMilli = 0, otherProdMilliPerHour = 0;
  for (const v of seen.values()) {
    if (`${v.p},${v.q},${v.site ?? 0}` === payerKey) continue;
    try {
      const food = storesAt(settled(v, now), now, RESOURCE_ORDER).find(s => s.resource === 'Food');
      if (!food) continue;
      otherFoodMilli += Math.round(Number(food.value) * 1000);
      otherProdMilliPerHour += Math.round(Number(food.perHour) * 1000);
    } catch { /* a captured wide village may not settle like the first home */ }
  }
  return { villageCount: seen.size, otherFoodMilli, otherProdMilliPerHour };
}

/** The first village's food vs land upkeep, or null when there is no land to support. */
export function horizonFromFS(FS) {
  const payer = landPayer(FS);
  const player = FS?.ownLand?.player;
  if (!payer || !player || !(Number(player.tiles) > 0) || !(Number(player.upkeepMilliPerHour) > 0)) return null;
  const now = Number(FS.chain?.now?.() ?? 0);
  const food = storesAt(settled(payer, now), now, RESOURCE_ORDER).find(s => s.resource === 'Food');
  if (!food) return null;
  const census = villageCensus(FS, payer, now);
  const proj = projectHorizon({
    stockMilli: Math.round(Number(food.value) * 1000),
    productionMilliPerHour: Math.round(Number(food.perHour) * 1000),
    capMilli: Math.round(Number(food.cap ?? 2000) * 1000),
    upkeepMilliPerHour: Number(player.upkeepMilliPerHour ?? 0),
    paidTo: player.paidTo,
    remainder: Number(player.remainder ?? 0),
    unpaidSince: player.unpaidSince ?? null,
    nowTs: now,
    nowBell: FS.nowBell ?? 0,
    tiles: Number(player.tiles),
    hist: player.hist,
  });
  return { ...proj, ...census, rate: termsRate(), caravansOff: caravansOff(FS) };
}

export function ownLandHorizonBlock(h, opts = {}) {
  if (!h || !(h.tiles > 0) || !(h.upkeepMilliPerHour > 0)) return '';
  const rate = opts.rate;
  const cue = otherVillageNote(opts);
  const status = horizonStatusLines(h, rate);
  if (!status.length) return '';
  // (verify-pr272: the wide card and the food ledger can both show it on one village screen: one id each)
  return html`<div class="hp-own-land-horizon" id="${opts.id ?? 'hp-own-land-horizon'}">
    <p>${horizonLead()}${termButton('horizon')}</p>
    ${status.map(s => html`<p>${s}</p>`)}
    ${cue ? html`<p class="muted">${cue}</p>` : ''}</div>`;
}

export const tileWhy = w => {
  const ids = [w.tilePriceShort && 'hp-tile-why-price', w.territory && w.tileShort && 'hp-tile-why-ore', w.land?.unpaid && 'hp-tile-why-unpaid', w.land?.unpaid && 'hp-own-land-unpaid'].filter(Boolean);
  return ids.length ? ` aria-describedby="${ids.join(' ')}"` : '';
};
function wideClaimCard(FS, m, busy) {
  const w = wideClaimModel(FS, m);
  if (!w) return '';
  const hz = w.horizon ?? horizonFromFS(FS);
  // (territory-card: with three villages there is no next village — no village cost line, only the land and its tile rows)
  const cost = w.need.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(n)}` : null)).filter(Boolean).join(' · ');
  return html`<section class="vcard" id="hp-wide" aria-labelledby="hp-wide-h">
    ${cardHead({ id: 'hp-wide-h', ic: 'flag', title: L`広い土地に村を出す（テスト）` })}
    <p>${L`この村は広い土地（第129輪より外）のそばにあります。近くの州に2つめ・3つめの村を出せます。`}</p>
    ${w.full ? '' : html`<p class="muted">${L`費用（村の蔵から）`}: ${cost}${w.short.length ? html` — <span class="blocked" id="hp-wide-short">${L`足りません`}: ${w.short.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.need - x.have)}`).join(' · ')}</span>` : ''}</p>`}
    ${ownLandBlock(w.land)}
    ${ownLandHorizonBlock(hz, { rate: termsRate(), villageCount: hz?.villageCount, otherFoodMilli: hz?.otherFoodMilli, otherProdMilliPerHour: hz?.otherProdMilliPerHour, caravansOff: caravansOff(FS) })}
    ${w.foodStalled ? html`<p class="muted" id="hp-own-land-stalled"><span class="blocked">${L`食料の増え方はもう 0 以下です（${signedNet(w.foodStalled.perHour)}/時）。次の1マスの維持費は、本拠地が毎ターン作る食料では払えません。`}</span></p>` : ''}
    ${w.tilePriceShort ? html`<p class="muted"><span class="blocked" id="hp-tile-why-price">${L`鉱石が次の1マスの値段（${fmtNum(w.tilePrice)}）に足りないので、いまは「1マス取る」を押せません。`}</span></p>` : ''}
    ${w.land?.unpaid ? html`<p class="muted"><span class="blocked" id="hp-tile-why-unpaid">${L`土地の維持費が払えていないので、いまは「1マス取る」を押せません。`}</span></p>` : ''}
    ${w.territory && w.tileShort ? html`<p class="muted"><span class="blocked" id="hp-tile-why-ore">${L`鉱石が 10 に足りないので、いまは「1マス取る」を押せません。`}</span></p>` : ''}
    ${w.own.length ? html`<ul class="build-list">${w.own.map(t => html`<li><span>${L`州 ${t.p},${t.q}`} <span class="muted">${L`あなたの村がある州`}</span>${noFreeNote(t)}</span>
      <button type="button" class="btn small" data-act="territory-tile" data-p="${t.p}" data-q="${t.q}"${raw(t.reach ? ` data-rp="${t.reach.p}" data-rq="${t.reach.q}"` : '')}${raw(tileWhy(w))} aria-label="${L`1マス取る`}: ${L`州 ${t.p},${t.q}`}" ${raw(busy || w.tileOff || t.noFree ? 'disabled' : '')}>${L`1マス取る`}</button></li>`)}</ul>` : ''}
    ${w.full ? html`<p class="muted">${L`村はもう3つあります。`}</p>${w.targets.some(t => t.territory) ? html`<ul class="build-list">${w.targets.filter(t => t.territory).map(t => html`<li><span>${L`州 ${t.p},${t.q}`}${t.reach ? html` <span class="muted">${L`国の土地（州 ${t.reach.p},${t.reach.q}）から`}</span>` : ''}${t.pin === 'siege' ? html` <span class="muted" data-pin="siege">${L`あなたの軍勢が砦を奪っている州`}</span>` : t.pin === 'keep' ? html` <span class="muted" data-pin="keep">${L`あなたの軍勢が砦を奪った州`}</span>` : t.pin === 'tiles' ? html` <span class="muted" data-pin="tiles">${L`あなたのマスがある州`}</span>` : ''}${noFreeNote(t)}</span>
      <button type="button" class="btn small" data-act="territory-tile" data-p="${t.p}" data-q="${t.q}"${raw(t.reach ? ` data-rp="${t.reach.p}" data-rq="${t.reach.q}"` : '')}${raw(tileWhy(w))} aria-label="${L`1マス取る`}: ${L`州 ${t.p},${t.q}`}" ${raw(busy || w.tileOff || t.noFree ? 'disabled' : '')}>${L`1マス取る`}</button></li>`)}</ul>` : ''}` : html`<ul class="build-list">${w.targets.map(t => html`<li><span>${L`州 ${t.p},${t.q}`} <span class="muted">${L`村の場所 ${fmtNum(t.site + 1)}`}</span>${t.reach ? html` <span class="muted">${L`国の土地（州 ${t.reach.p},${t.reach.q}）から`}</span>` : ''}${t.pin === 'siege' ? html` <span class="muted" data-pin="siege">${L`あなたの軍勢が砦を奪っている州`}</span>` : t.pin === 'keep' ? html` <span class="muted" data-pin="keep">${L`あなたの軍勢が砦を奪った州`}</span>` : t.pin === 'tiles' ? html` <span class="muted" data-pin="tiles">${L`あなたのマスがある州`}</span>` : ''}${noFreeNote(t)}</span>
      ${t.territory ? html`<button type="button" class="btn small" data-act="territory-tile" data-p="${t.p}" data-q="${t.q}"${raw(t.reach ? ` data-rp="${t.reach.p}" data-rq="${t.reach.q}"` : '')}${raw(tileWhy(w))} aria-label="${L`1マス取る`}: ${L`州 ${t.p},${t.q}`}" ${raw(busy || w.tileOff || t.noFree ? 'disabled' : '')}>${L`1マス取る`}</button>` : ''}
      <button type="button" class="btn small" data-act="wide-claim" data-p="${t.p}" data-q="${t.q}" data-site="${t.site}" data-slot="${w.slot}"${raw(t.reach ? ` data-rp="${t.reach.p}" data-rq="${t.reach.q}"` : '')}${raw(w.slot === 3 && w.previous ? ` data-pp="${w.previous.p}" data-pq="${w.previous.q}" data-ps="${w.previous.site}"` : '')}${raw(w.short.length ? ' aria-describedby="hp-wide-short"' : '')} aria-label="${L`ここに村を出す`}: ${L`州 ${t.p},${t.q}`} ${L`村の場所 ${fmtNum(t.site + 1)}`}" ${raw(busy || w.short.length ? 'disabled' : '')}>${L`ここに村を出す`}</button></li>`)}</ul>
      ${w.targets.some(t => t.reach) ? html`<p class="muted">${L`自分の国の村がある州や、国が奪った砦の州から 3 州以内にも村を出せます。国の土地が広がるほど、遠くへ出られます。`}</p>` : ''}`}
    ${tilePreviewBlock(w.preview, busy)}
    ${w.territory ? html`<p class="muted">${L`自分の土地：「1マス取る」はその州のマスを1つ、すぐ自分の土地にします（鉱石 10、持っているマス1つごとに +2%、1ターンに1マス）。村は自分のマスの上にだけ建ち、「ここに村を出す」は1回目でその場所のマスを取り、2回目で村を出します。土地の維持費は本拠地の食料から払います（1マス 0.99/時、自分の村から3州より遠いと1州ごとに +0.48/時）。払えないと新しく取れず、24ターン後から遠いマスが1ターンに1つずつ手放されます。`}</p>` : ''}
    <p class="muted">${L`申し込みはターンの終わりに決まります（同じ場所を選んだ人がいれば抽選）。`}</p></section>`;
}

export { queueSlots, buildSecs } from '../hud/rulebook.mjs';
export const introBuildAvailable = h => (Number(h?.flags ?? 0) & 2) !== 0;
export const storageCap = tier => [2000, 6000, 15000, 40000][Number(tier)] ?? 2000;
export const signedRate = n => `${n >= 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`;
export const queueItemLabel = q => { const item = queueBuildingItem(q); return item === 7 ? L`村の昇格` : item !== null ? BUILDINGS[buildItemOf(item)?.resource] ?? L`建物` : L`維持費の変更`; };

/** How many buildings stand in sight before the fold. */
export const BUILD_SHOWN = 3;

/**
 * The − / + buttons and presets around a count (UI plan B4: no typing for
 * the common amounts). The input stays a plain number field (keyboard and
 * screen readers); `max` caps the presets ("all" when it is known).
 */
const steps = (name, { d = 100, presets = [100, 500, 1000], max = null } = {}) => html`<span class="stepper" role="group" aria-label="${L`数を変える`}">
  <button type="button" class="btn small" data-act="step" data-name="${name}" data-d="${-d}" aria-label="${L`${fmtNum(d)} 減らす`}">${icon('minus')}</button>
  <button type="button" class="btn small" data-act="step" data-name="${name}" data-d="${d}" aria-label="${L`${fmtNum(d)} 増やす`}">${icon('plus')}</button>
  ${presets.filter(v => max === null || v <= max).map(v => html`<button type="button" class="btn small" data-act="step-set" data-name="${name}" data-v="${v}">${fmtNum(v)}</button>`)}
  ${max !== null && max > 0 ? html`<button type="button" class="btn small" data-act="step-set" data-name="${name}" data-v="${max}">${L`全部（${fmtNum(max)}）`}</button>` : ''}</span>`;

/** Why an action is blocked, as text, with the catch-up offer for a lagging province. */
/**
 * When a provisional village becomes final, said with a time (the second review: "once every request from the same
 * turn is decided" gave none): by the clock when the page has the request's turn, else by how long it can take at
 * the most (24 turns: fland.mjs ticketTimes).
 */
export function provisionalNote(FS, h) {
  let by = null;
  try { by = FS?.clock && Number.isInteger(h?.ticketBell) ? ticketTimes(FS.clock, h.ticketBell).cohortEndsBy : null; } catch { by = null; }
  // (the time says what it is: how long from now, then the clock; `dueHtml`)
  // (fix-loop22: only with the chain's "now" — the time is said on the viewer's wall clock from it, never as the chain's clock)
  const now = FS?.chain?.now?.() ?? null;
  // (fix-provisional-guide: once the page sees the cohort closed, the time is the village's own final_ts — the card said
  //  "in about 3 h 43 min at the latest" while the rule allowed it in 16 min — and past it, that an action confirms it
  //  (loop-play23 BREAK-2: the village stays provisional after the time until the player acts))
  let c = null;
  try { c = h?.state === 1 ? villageConfirm(FS, h) : null; } catch { c = null; }
  if (c?.state === 'waiting' && !c.latest) return Lh`同じターンの申し込みはすべて決まりました。${dueHtml(c.at, now)}から確定できます。その時刻を過ぎたら、収穫などの行動をひとつすると確定します。`;
  if (c?.state === 'due' || c?.state === 'past') return L`いま確定できます。収穫などの行動をひとつすると確定します。`;
  return by && Number.isFinite(now) && by > now ? Lh`同じターンの申し込みがすべて決まると確定します。遅くとも${dueHtml(by, now)}です。` : L`同じターンの申し込みがすべて決まると確定します（遅くとも申し込みから約 4 時間）。`;
}

// (`nudge: false` — local play: the reasons stand as they are, without the "catch up" button. The keeper is not asked
//  for anything there (controller.mjs LOCAL_PLAY_REFUSED: the press would only be refused); the local world's own
//  keeper brings the province up. Everywhere else the button is offered as it always was.)
export function blockedLine(blocks, { nudge = true } = {}) {
  if (!blocks.length) return '';
  const lag = nudge === true && blocks.includes('NotResident');
  return html`<p class="blocked">${blocks.map(errorText).join(' / ')}${lag ? html` <button type="button" class="btn small" data-act="nudge">${L`追いつかせる`}</button>` : ''}</p>`;
}
// (this function under a name that the panel's own, narrower `blockedLine` in `render` does not shadow)
const blockedLineOf = blockedLine;

/**
 * The build cards (UI plan E2, Civ VII's yield preview; UX design 14.2): per thing the village may order built
 * (the six buildings, then the walls) `{item, kind, resource, perHour, n, cost, secs, doneIn, short: [{resource,
 * need}], blocks}` with the program's own numbers for the NEXT copy (hud/rulebook.mjs buildOffers: the n-th copy
 * costs base × (1 + (n−1)²/2) and takes 60 + 30 n minutes; the queue is serial). `copies` = n − 1, the ones built
 * or under way. (The card showed the first copy's cost for every copy, and a first copy as 60 minutes: it takes 90.)
 */
export function buildCards(h, stores, { now = 0, faction = h.faction ?? 0, province = null, workshop = true } = {}) {
  const have = stores.map(s => s.value);
  // the village's own site mirror (this holding's generation), for the walls' two items (rulebook wallItemsBusy)
  const m = province && province.p === h.p && province.q === h.q ? province.siteMirror?.[h.site] : null;
  const mirror = m && m.state === 1 && Number(m.gen) === Number(h.gen) ? m : null;
  return buildOffers(h, { now, have, faction, s1: s1On(), mirror, resolvedNext: province?.resolvedNext ?? null, workshop }).map(o => ({ ...o, copies: o.n - 1, wait: Math.max(0, o.doneIn - o.secs), short: o.short.map(x => ({ resource: RESOURCE_ORDER[x.r], need: x.need })) }));
}

/**
 * (fix-loop9, LP9-3) Whether this page may offer the S1 workshop (build item 8): everywhere but a local test world of the
 * plain lane, whose relay takes Build items 0-7 only (permutation-gateway local-play-act.mjs: item 8 in the coexist lane
 * alone) — loop-play9: offered in every plain world and refused 「命令の内容の形が正しくありません」 with a retry that could
 * never work. The --coexist world (② rights, ⑨ workshops) offers it as before.
 */
export const workshopOffered = FS => !FS?.localPlay || localLane() === COEXIST_LANE;

/** Compatibility view of the shared promotion offer; no second set of prices. */
export function upgradeModel(h, stores, now) {
  h = settled(h, now);
  const offer = promotionOffer(h, { now, have: stores.map(s => s.value) });
  if (!offer) return null;
  const before = baseProduction(h.tier), after = baseProduction(h.tier + 1);
  return { ...offer, next: offer.to, pending: offer.running, wait: Math.max(0, offer.doneIn - offer.secs), slots: offer.gives.slots[1], cap: offer.gives.cap[1],
    short: offer.short.map(x => ({ resource: RESOURCE_ORDER[x.r], need: x.need })),
    gains: after.map((v, i) => ({ resource: RESOURCE_ORDER[i], perHour: Number(v - before[i]) / 1000 })).filter(x => x.perHour > 0) };
}

/**
 * The Garrison form's own refusals as the program decides them (host.rs garrison_as), in its order, before anything is
 * signed: BadTroops (a whole number from 1) → Insufficient (the Spearman reserve) → GarrisonFull {room} (fland
 * garrisonRoom, on the village's own site mirror). The action's blocks (capture lock, not final, Province behind) stay
 * where they were: actionBlocks('Garrison'), which disables the form. Without the data (no reserve read, no own
 * mirror) the program decides. Null when it may be sent.
 */
export function garrisonProblem(FS, n) {
  const raw0 = activeHolding(FS);
  if (!raw0) return null;
  if (!Number.isInteger(n) || n < 1) return { code: 'BadTroops' };
  if (Array.isArray(raw0.reserve) && n > Number(raw0.reserve[0] ?? 0)) return { code: 'Insufficient' };
  const province = FS.provinces?.get(`${raw0.p},${raw0.q}`)?.province ?? null;
  const m = province && province.p === raw0.p && province.q === raw0.q ? province.siteMirror?.[raw0.site] : null;
  if (m && m.state === 1 && Number(m.gen) === Number(raw0.gen)) {
    const room = garrisonRoom(m, province.resolvedNext);
    if (n > room) return { code: 'GarrisonFull', room };
  }
  return null;
}
/** The words for garrisonProblem's own codes (the others are the program's sentences). */
export const garrisonProblemText = pr => (pr.code === 'GarrisonFull' ? L`守備隊にはあと ${fmtNum(pr.room)} 人まで入れられます`
  : pr.code === 'BadTroops' ? L`増やす人数は 1 以上の整数です` : errorText(pr.code));

/** The viewer's local clock time of a UTC hour today ("09:00"). */
const localHour = hr => { const d = new Date(Date.UTC(2026, 0, 1, hr, 0)); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * The panel's view model (numbers the tests read): stores, facts, the actions' blocks. The stores are the ones the
 * program's next instruction will find (hud/rulebook.mjs `settled`: a building that is done already produces).
 * Also what the hand reads (hud/hand.mjs): `have` (whole units by resource index), `offers` (buildCards), `promotion`,
 * `queue` (what is under way, in order) and `slots` (how many things this tier may have under way).
 */
export function holdingModel(FS) {
  const raw0 = activeHolding(FS);
  if (!raw0) return null;
  const now = FS.chain?.now() ?? 0;
  const h = settled(raw0, now);
  const env = FS.provinces?.get(`${h.p},${h.q}`);
  const ctx = { holding: raw0, citizen: FS.citizen, province: env?.province ?? null, nowBell: FS.nowBell ?? 0, now };
  // (food-net-caravan, owner Q-LP17-2: the ledger's food rate of the first village is net of the land upkeep —
  //  landfood.mjs; amounts, caps and every other row are the record's, as before)
  const land = landUpkeepMilli(FS, raw0);
  const stores = storesAt(h, now, RESOURCE_ORDER).map(s => withLand(s, land));
  const have = stores.map(s => s.value);
  const faction = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const promo = promotionOffer(h, { now, have });
  return {
    holding: h, rawHolding: raw0, settled: h, now, faction, programVersion: Number(FS.season?.programVersion ?? 1),
    stores, have,
    facts: holdingFacts(h, FS.season, now),
    blocks: Object.fromEntries(['Harvest', 'Build', 'Train', 'Muster', 'Garrison'].map(n => [n, actionBlocks(n, ctx)])),
    offers: buildCards(h, stores, { now, faction, province: env?.province ?? null, workshop: workshopOffered(FS) }),
    promotion: promo ? { ...promo, short: promo.short.map(x => ({ resource: RESOURCE_ORDER[x.r], need: x.need })) } : null,
    queue: queueNow(h, now), slots: queueSlots(h.tier),
    horizon: horizonFromFS(FS),
  };
}

/** A resource's mark on parchment: the strip's icon on a dark coin. */
export const resCoin = resource => html`<span class="res-coin">${icon(RESOURCE_ICON[resource] ?? (resource === 'Walls' ? 'shield' : 'crate'), `res-c-${resource}`)}</span>`;

/**
 * One store as a line of the ledger (UX design 11.12: resources on ink rules, not cards): the mark and the
 * name, the amount, the cap, the hourly rate. A full store is said in a word (stamped) and in the amount's ink.
 */
function storeRow(s) {
  const full = s.cap > 0 && s.value >= s.cap;
  // (food-net-caravan, owner Q-LP17-2: the first village's food — `s.perHour` is already the NET rate, the land's part beside it)
  const rate = s.landPerHour > 0 ? html`<span class="ledger-net${s.perHour < 0 ? ' ledger-net-neg' : ''}">${L`${signedNet(s.perHour)}/時`}<span class="ledger-land">${landPart(s)}</span></span>` : null;
  const near = !full && s.cap > 0 && s.perHour > 0 && ((s.cap - s.value) / s.perHour) * 3600 <= NEAR_FULL_SECS;
  return html`<tr class="ledger-row${full ? ' ledger-full' : near ? ' ledger-near' : ''}">
    <th scope="row">${icon(RESOURCE_ICON[s.resource] ?? 'crate', 'ledger-ic')}<span class="ledger-name">${RESOURCES[s.resource]}</span></th>
    <td class="ledger-val">${fmtNum(s.value)}</td>
    <td class="ledger-cap"><span aria-hidden="true">/ </span>${fmtNum(s.cap)}</td>
    <td class="ledger-rate">${full ? html`${stamp(L`満杯`, 'bad')}${rate ? html` ${rate}` : ''}` : rate ? rate : s.perHour !== 0 ? L`${signedRate(s.perHour)}/時` : html`<span aria-hidden="true">—</span>`}${near ? html`<span class="ledger-fullin">${L`満杯まで ${span(((s.cap - s.value) / s.perHour) * 3600)}`}</span>` : ''}</td></tr>`;
}
/** The stores as a ruled ledger: a line per resource. */
export function renderLedger(stores) {
  return html`<table class="ledger"><caption class="visually-hidden">${L`資源`}</caption>
    <thead><tr><th scope="col">${L`品目`}</th><th scope="col">${L`在庫`}</th><th scope="col">${L`上限`}</th><th scope="col">${L`毎時`}</th></tr></thead>
    <tbody>${stores.map(storeRow)}</tbody></table>`;
}

/**
 * One building as a row: what it gives, how long the next copy takes, what the next copy costs (the program's own
 * numbers: hud/rulebook.mjs), and the one button; `why` is the rule that stops it now, in words.
 */
function buildRow(c, why, have) {
  const name = BUILDINGS[c.resource];
  return html`<li class="build-row${c.short.length ? ' short' : ''}">${resCoin(c.resource)}
    <span class="br-main"><strong>${name}</strong><span class="br-yield">${c.perHour ? L`${RESOURCES[c.resource]} +${c.perHour}/時` : L`守り +100`}</span></span>
    <span class="br-meta">${icon('hourglass')}${took(c.secs)}${c.intro ? html` ${stamp(L`初めての建設`, 'ok')}` : ''} · ${costChips(c.cost, have)}${c.kind === 'building' && c.copies ? html` <span class="br-nth">${L`（${fmtNum(c.copies + 1)}つ目）`}</span>` : ''}</span>
    ${c.short.length ? html`<span class="br-short">${shortWords(c.short)}</span>` : ''}
    <button type="button" class="btn small br-go" data-act="build" data-item="${c.item}" aria-label="${L`${name}を建てる`}" ${raw(why ? 'disabled' : '')}>${L`建てる`}</button></li>`;
}

/** The promotion to the next tier as a row of the build card (it takes a place in the same queue). */
function promotionRow(p, why, have) {
  return html`<li class="build-row promo-row${p.short.length ? ' short' : ''}"><span class="res-coin">${icon('tierup')}</span>
    <span class="br-main"><strong>${L`${TIERS[p.to]}への昇格`}</strong><span class="br-yield">${L`産出 +${p.gives.prodPct[1]}% · 蔵 ${fmtNum(p.gives.cap[1])} · 建設 ${p.gives.slots[1]} つ · 村のまわり ${p.gives.radius[1]} マス`}</span></span>
    <span class="br-meta">${icon('hourglass')}${p.running ? L`あと ${took(p.doneIn)}` : took(p.secs)}${p.running ? '' : html` · ${costChips(p.cost, have)}`}</span>
    ${p.short.length && !p.running ? html`<span class="br-short">${shortWords(p.short)}</span>` : ''}
    ${p.running ? stamp(L`昇格中`, 'warn') : html`<button type="button" class="btn small br-go" data-act="build" data-item="${ITEM_TIER_UP}" aria-label="${L`${TIERS[p.to]}への昇格を始める`}" ${raw(why ? 'disabled' : '')}>${L`昇格`}</button>`}</li>`;
}

/**
 * The units as pictures to choose from (radio buttons named `unit`: the forms read `form.elements.unit.value`).
 * `costs`: under each, what a hundred cost and what the kind is good at (the training form).
 */
function unitPicks(f, list, legend, { costs = false, have = null, selected = 0, programVersion = 1 } = {}) {
  return html`<div class="unit-picks${costs ? ' unit-picks-costs' : ''}" role="radiogroup" aria-label="${legend}">${list.map((x, k) => html`<label class="unit-pick"><input type="radio" name="unit" value="${x.unit}" ${raw(x.unit === selected ? 'checked' : '')}>
    <img class="unit-card f${f}" src="${miniCardUrl(f, MINI_KINDS[x.unit])}" alt="" width="44" height="55" loading="lazy" decoding="async">
    <span class="unit-name">${UNITS[UNIT_ORDER[x.unit]]}</span>${x.troops !== undefined ? html`<span class="unit-n">${fmtNum(x.troops)}</span>` : ''}
    ${costs ? html`<span class="unit-good">${unitGood(x.unit)}</span><span class="unit-cost">${L`100人`} ${costChips(trainCost(x.unit, 100, programVersion), have)}</span>` : ''}</label>`)}</div>`;
}

/**
 * The Muster draft's scope: this world (cluster, program, season address, genesis; on local play also the runner
 * instance the page verified at start, since a replaced local world can repeat the rest), the wallet, and this village
 * (p, q, site, generation). Null when any part is unknown, including local play without a verified instance: then
 * nothing is kept. A draft is page memory only.
 */
export function musterScope(FS, h) {
  const r = FS?.record, w = FS?.wallet?.address, g = FS?.season?.genesisTs;
  if (!r?.programId || !r?.seasonAddress || g === undefined || g === null || !w || !h) return null;
  if (![h.p, h.q, h.site, h.gen].every(Number.isInteger)) return null;
  const local = FS.localPlay ?? null, instance = local?.march?.instance;
  if (local !== null && !(typeof instance === 'string' && /^[0-9a-f]{64}$/.test(instance))) return null;
  return `${r.cluster ?? ''}|${r.programId}|${r.seasonAddress}|${String(g)}|${local !== null ? instance : '-'}|${w}|${h.p},${h.q},${h.site}|${h.gen}`;
}

/**
 * What the Muster form shows: this scope's draft as the player left it, else the first kind in reserve and 100.
 * Never changed to fit the reserve: `missing` (the kind is not in reserve) and `short` (only that many are) say so.
 */
export function musterShown(FS, h, reserve) {
  const key = musterScope(FS, h), d = key !== null && FS?.musterDraft?.key === key ? FS.musterDraft : null;
  const unit = d && Number.isInteger(d.unit) ? d.unit : d ? null : (reserve[0]?.unit ?? 0);
  const troops = d && Number.isFinite(d.troops) ? d.troops : 100;
  const have = unit === null ? null : reserve.find(r => r.unit === unit) ?? null;
  return { key, unit, troops, kept: d !== null, missing: reserve.length > 0 && have === null, short: have && troops > have.troops ? have.troops : null };
}

/** The Muster form's input, kept for this scope (an unchecked kind keeps the one drafted before). */
export function keepMusterDraft(FS, h, { unit, troops }) {
  const key = musterScope(FS, h);
  if (key === null) return false;
  const before = FS.musterDraft?.key === key ? FS.musterDraft.unit : null;
  FS.musterDraft = { key, unit: Number.isInteger(unit) ? unit : before, troops: Number(troops) };
  return true;
}

/**
 * (2026-11-17, ⑦ from the troops card to the hosts) The hosts of THIS village, from the provinces the page holds — the
 * same rows the hosts drawer lists (fland.mjs hostsIn: a host's id carries its village's place, site and generation, so
 * a host is this village's by its own id, not by where it stands): `{forming, standing, marching, total, partial}`.
 *   forming   mustered, not yet in the record as formed (state 2) — what a muster just given becomes
 *   standing  formed and standing somewhere; marching: on the road
 *   partial   'unknown' — the list of provinces the viewer's hosts stand in is not read for what the page is now —,
 *             'unread' — some of those provinces are not held —, or null: the counts are all the page can know.
 * A count is of what the page holds; with `partial` it is not said to be all.
 */
export function villageHosts(FS, h) {
  const out = { forming: 0, standing: 0, marching: 0, total: 0, partial: null };
  if (!h) return out;
  const bell = FS.nowBell ?? 0;
  for (const env of FS.provinces?.values?.() ?? []) {
    if (!env?.province) continue;
    for (const r of hostsIn(env.province, h, bell)) {
      if (r.inTransit || r.state === 3) out.marching += 1; else if (r.state === 2) out.forming += 1; else out.standing += 1;
      out.total += 1;
    }
  }
  const un = unreadHostPlaces(FS);
  out.partial = !un.known ? 'unknown' : un.places.length ? 'unread' : null;
  return out;
}

/**
 * How the reads behind the village screen went (2026-11-17, ⑦) — nothing is asked here, only said:
 *  - `viewer`: by where the answer shown really came from (corrected 2026-11-17). With no village in hand: 'none' (nobody
 *    to ask — no wallet —, or the record answered "none" FOR THIS WORLD and the last read is good), 'noneStale' (it
 *    answered "none" for this world before, and the read fails now: kept as it was, said as kept), 'unread' (no answer
 *    for this viewer and this world yet — never, or only for another pinned world: not "no village"). With a village:
 *    'otherWorld' (the villages held were read for another pinned world — FS.holdingsWorld, with its generation),
 *    'stale' (the last read failed: the numbers are worked out from the record read before), 'ok'.
 *    The world of an answer is FS.meWorld (controller applyMeResult: a Citizen or "no Citizen" alike); a state without
 *    it — a fixture, a page from before — is taken as this world's, as it was;
 *  - `province`: the village's own province record — 'held', or how its read stands (controller's FS.provinceReads:
 *    'loading', 'waiting', 'failed', 'missing') or 'idle'. The rules' mirror (fland.actionBlocks) answers NotResident
 *    for a province it has no record of, so every action then reads "this province has not finished its last turn":
 *    without the record that is not known — the screen says which it is.
 */
export function holdingRead(FS) {
  const h = activeHolding(FS), pin = FS.pin ?? null;
  const world = pin?.programId && pin?.addresses?.season ? `${pin.gen ?? 0}|${pin.cluster ?? ''}|${pin.programId}|${pin.addresses.season}` : null;
  const answeredHere = FS.meAnswered === true && (FS.meWorld === undefined || FS.meWorld === world);
  const viewer = !h ? (!FS.wallet ? 'none' : !answeredHere ? 'unread' : FS.meStatus === 'error' ? 'noneStale' : 'none')
    : FS.holdingsWorld !== undefined && FS.holdingsWorld !== world ? 'otherWorld'
    : FS.meStatus === 'error' ? 'stale' : 'ok';
  // (the province's read is said — and offered again — only for a village of THIS world: another world's village names
  //  a place of another map, and nothing of it is asked for here)
  const mine = !!h && viewer !== 'otherWorld';
  const key = mine ? `${h.p},${h.q}` : null, st = key && !FS.provinces?.has?.(key) ? FS.provinceReads?.get?.(key) ?? null : null;
  // (2026-11-17, ⑦: the person's own re-read — controller rereadVillage. Its note is said only while it is still about
  //  what is shown: "being read" always; "did not come" / "came, but the land changed" while the viewer's record is the
  //  one it was said about (a later answer replaces FS.citizen or FS.meError); "the province did not come" for the
  //  village it was pressed for. It is offered while the latest load of the viewer's record failed, or after its own
  //  province part did not come; never in the prototype rule's world.)
  const rr = FS.villageReread ?? null;
  const rrState = !rr ? null : rr.state === 'loading' ? 'loading'
    : rr.state === 'provinceFailed' ? (mine && rr.ref === `${h.p},${h.q},${h.site},${h.gen ?? 0}` ? 'provinceFailed' : null)
    : (rr.errAt ?? null) === (FS.meError ?? null) && (rr.citAt ?? null) === (FS.citizen ?? null) ? rr.state : null;
  const can = !!FS.wallet && !FS.proto && FS.mode === 'play' && (FS.meStatus === 'error' || rrState === 'provinceFailed');
  return { viewer, province: !mine ? null : FS.provinces?.has?.(key) ? 'held' : st?.state ?? 'idle', code: st?.code ?? null, p: mine ? h.p : null, q: mine ? h.q : null,
    reread: { can, state: rrState, code: rrState ? rr.code ?? null : null } };
}
/** The lines of the person's own re-read (holdingRead().reread): what became of the press, and the button. */
function rereadLines(rr) {
  const lines = [];
  if (rr.state === 'loading') lines.push(html`<p class="muted" role="status">${L`村の記録を読み直しています…`}</p>`);
  else if (rr.state === 'failed') lines.push(html`<p class="notice error" role="alert">${L`村の記録を読み直せませんでした（${rr.code}）。前に読めた記録は、そのまま残しています。`}</p>`);
  else if (rr.state === 'changed') lines.push(html`<p class="notice" role="status">${L`読み直しましたが、土地の状態にかかわる変更がありました。この変更は、次の通常の読み込みで反映します。ここの表示は、まだ前の記録のものです。`}</p>`);
  else if (rr.state === 'yielded') lines.push(html`<p class="notice" role="status">${L`通常の読み込みが進んでいたので、この読み直しの答えは使いませんでした。通常の読み込みの結果をお待ちください。`}</p>`);
  else if (rr.state === 'provinceFailed') lines.push(html`<p class="notice error" role="alert">${L`村の記録は読み直せました。この村の州の記録は読み直せませんでした。州の数は、前に読めた記録のままです。`}</p>`);
  if (rr.can && rr.state !== 'loading') lines.push(html`<div class="actions"><button type="button" class="btn small" data-act="village-reread">${icon('return')}${L`村の記録を読み直す`}</button></div>`);
  return lines;
}
/** The note the village screen carries under its head when a read behind it did not come (holdingRead); '' when all is read. */
export function renderHoldingRead(FS) {
  const r = holdingRead(FS), lines = [];
  if (r.viewer === 'otherWorld') lines.push(html`<p class="notice" role="status">${L`この村は、前に読んだ世界の記録です。いまの世界の記録を読み込んでいます。`}</p>`);
  else if (r.viewer === 'stale') lines.push(html`<p class="notice error" role="status">${L`いまの読み込みに失敗しています。下の数は、最後に読めた記録から計算したものです。次の読み込みでもう一度確かめます。`}</p>`);
  if (r.province && r.province !== 'held') {
    lines.push(r.province === 'failed'
      ? html`<p class="notice error" role="alert">${L`この村の州の記録を読めていません（${r.code}）。下の行動が「この州はまだ前のターンの決着が済んでいません」と出るのは、記録を読めていないためのことがあります。`}</p>`
      : html`<p class="muted" role="status">${L`この村の州の記録を、まだ読めていません。読めるまで、下の行動は「この州はまだ前のターンの決着が済んでいません」と出ます。`}</p>`);
    if (r.province !== 'loading' && r.province !== 'waiting') lines.push(html`<div class="actions"><button type="button" class="btn small" data-act="province-reread" data-p="${r.p}" data-q="${r.q}">${icon('return')}${L`もう一度読み込む`}</button></div>`);
  }
  lines.push(...rereadLines(r.reread));
  return lines.length ? html`<div class="village-read" data-viewer="${r.viewer}" data-province="${r.province ?? ''}" data-reread="${r.reread.state ?? ''}">${lines}</div>` : '';
}

export function render(FS) {
  // a wide inventory slot chosen in the rail: the captured record's read-only cards stand here instead
  // (screens/wideholding.mjs); the legacy village below is untouched and returns with the wide card's own press
  if (FS.wideSelect) { const w = wideHolding.render(FS); if (w) return w; }
  const m = holdingModel(FS);
  const wideStatus = wideHolding.renderWideInventoryStatus(FS);
  // (2026-11-17, ⑦: "no village yet" only once the viewer's record answered so; before that it is not read — holdingRead)
  if (!m) {
    const rd = holdingRead(FS), v = rd.viewer, again = rereadLines(rd.reread);
    return html`${wideStatus}<p${v === 'unread' || v === 'noneStale' ? html` role="status" data-read="${v}"` : ''}>${v === 'unread' ? L`村の記録をまだ読めていません。村がないという意味ではありません。次の読み込みで確かめます。`
      : v === 'noneStale' ? L`最後に読めた記録では、まだ村がありません。いまの読み込みは失敗しています。次の読み込みでもう一度確かめます。` : L`まだ村がありません。`}</p>${again.length ? html`<div class="village-read" data-viewer="${v}" data-province="" data-reread="${rd.reread.state ?? ''}">${again}</div>` : ''}`;
  }
  const { holding: h, facts: f } = m;
  // (shadows the module's `blockedLine` for this panel: in local play the blocked reasons carry no "catch up" button)
  const blockedLine = blocks => blockedLineOf(blocks, { nudge: !FS.localPlay });
  const actionBusy = FS.inFlight > 0 || !!FS.homeActionBusy;
  const first = introBuildAvailable(m.settled);
  const trainUnit = Number.isInteger(FS.trainingDraft?.unit) ? FS.trainingDraft.unit : 0;
  const trainN = Number.isFinite(FS.trainingDraft?.n) ? FS.trainingDraft.n : 100;
  const training = trainingQuote(h, trainUnit, trainN, m.now, m.programVersion);
  const upkeep = (m.settled.upkeep ?? []).map((v, i) => ({ resource: RESOURCE_ORDER[i], perHour: Number(v) / 1000 })).filter(x => x.perHour > 0);
  const faction = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const full = m.stores.filter(s => s.cap > 0 && s.value >= s.cap);
  const building = m.queue;
  const queueFull = building.length >= m.slots;
  const freeIn = queueFull ? Math.min(...building.map(q => q.doneIn)) : 0;
  const cards = m.offers;
  // why a thing cannot be ordered now, as the rule says it (the program would answer the same)
  const whyOf = c => { const code = m.blocks.Build[0] ?? c.blocks[0] ?? null; if (actionBusy) return L`命令の結果を確認しています。`; return code ? whyText(code, { tier: Number(m.settled.tier ?? 0), freeIn, short: c.short, walls: c.kind === 'walls' }) : null; };
  // what can go up now first; the catalog's order otherwise
  const order = [...cards].sort((a, b) => Number(!!whyOf(a)) - Number(!!whyOf(b)) || a.item - b.item);
  const shown = order.slice(0, first ? 2 : BUILD_SHOWN), rest = order.slice(first ? 2 : BUILD_SHOWN);
  const reserve = f.reserve.filter(r => r.unit !== SETTLER);
  const musterable = reserve.reduce((a, r) => a + r.troops, 0);
  const vigil = FS.citizen?.vigilStartMin ?? 0;
  const vigilHour = Math.floor(vigil / 60);

  const head = html`<section class="vcard village-head" aria-labelledby="holding-title">
    ${cardHead({ id: 'holding-title', ic: 'home', pic: villageDrawn(faction, h.tier), title: holdingName(h), sub: [TIERS[h.tier] ?? '', factionName(faction)].filter(Boolean).join(' · '), side: stamp(HOLDING_STATES[f.state], f.state === 'final' ? 'ok' : 'warn') })}
    ${f.shieldLeft > 0 || f.dormantIn <= 0 || f.state === 'provisional' ? html`<ul class="fact-chips">
      ${f.shieldLeft > 0 ? html`<li>${chip(`${L`保護 あと ${countdown(f.shieldLeft)}`}${realTail(f.shieldLeft)}`, 'info', 'shield')}${termButton('shield')}</li>` : ''}
      ${f.dormantIn <= 0 ? html`<li>${chip(L`休眠中`, 'bad', 'moon')}${termButton('dormant')}</li>` : ''}
      ${f.state === 'provisional' ? html`<li class="fact-note">${provisionalNote(FS, h)}</li>` : ''}</ul>` : ''}
  </section>`;

  // (verify-pr272: on a village with the wide-land card the horizon stands there, under the land line — not twice on
  //  one screen; the food ledger carries it only when that card is not shown)
  const stores = html`<section class="vcard" id="hp-harvest" aria-labelledby="hp-harvest-h">
    ${cardHead({ id: 'hp-harvest-h', ic: 'crate', title: L`資源`, side: full.length ? html`<span class="c-count c-count-bad">${L`満杯 ${fmtNum(full.length)}`}</span>` : '' })}
    ${renderLedger(m.stores)}
    ${upkeep.length ? html`<p>${L`現在の維持費（毎時）`}: ${upkeep.map(x => `${RESOURCES[x.resource]} ${fmtNum(x.perHour)}`).join(' · ')}</p>` : ''}
    <div class="actions"><button type="button" class="btn primary" data-act="harvest" ${raw(actionBusy || m.blocks.Harvest.length ? 'disabled' : '')}>${icon('grain')}${L`収穫する`}</button>
      <span class="muted">${full.length ? L`${full.map(s => RESOURCES[s.resource]).join(' / ')}が満杯：これ以上は増えません。使いましょう` : L`資源は画面を閉じても毎時増減します（生産から維持費を引いた量）。収穫は、いまの量を蔵の記録に納めるだけです。`}</span></div>
    ${m.stores.some(s => s.landPerHour > 0) ? html`<p class="muted" id="hp-land-food">${L`食料の毎時は、あなたの土地の維持費を引いたあとの量です（「土地」がその分。ターンごとにこの村の食料から払われます）。`}</p>` : ''}
    ${m.stores.some(s => s.landPerHour > 0) && !wideClaimModel(FS, m) ? ownLandHorizonBlock(m.horizon, { id: 'hp-land-food-horizon', rate: termsRate(), villageCount: m.horizon?.villageCount, otherFoodMilli: m.horizon?.otherFoodMilli, otherProdMilliPerHour: m.horizon?.otherProdMilliPerHour, caravansOff: caravansOff(FS) }) : ''}
    ${blockedLine(m.blocks.Harvest)}</section>`;

  const queueName = q => queueItemLabel(q.q);
  const build = html`<section class="vcard" id="hp-build" aria-labelledby="hp-build-h">
    ${cardHead({ id: 'hp-build-h', ic: 'hammer', title: first ? L`最初の建設を選ぶ` : L`建設`, side: html`<span class="c-count${queueFull ? ' c-count-warn' : ''}">${L`建設中 ${fmtNum(building.length)}/${fmtNum(m.slots)}`}</span>` })}
    ${first ? html`<p>${L`農場で食料を増やすか、伐採場で木材を増やすか。村の最初の仕事を選びましょう。`}</p><p class="muted">${L`最初の生産施設の工事は60秒です。ほかの工事があると順番を待ちます。資源の費用は通常どおりです。`}</p>` : ''}
    ${building.length ? html`<ul class="queue">${building.map(q => html`<li>${icon('hourglass')}<strong>${queueName(q)}</strong><span class="queue-t">${q.running ? L`あと ${span(q.doneIn)}` : L`順番待ち（あと ${span(q.doneIn)}）`}</span></li>`)}</ul>` : html`<p class="muted">${L`建設の列は空です`}</p>`}
    <ul class="build-list">${shown.map(c => buildRow(c, whyOf(c), m.have))}</ul>
    ${rest.length ? fold('v-build', L`ほかの建物（${fmtNum(rest.length)}）`, html`<ul class="build-list">${rest.map(c => buildRow(c, whyOf(c), m.have))}${s1On() && !workshopOffered(FS) ? html`<li class="muted" data-workshop="lane">${L`工房はこの試験世界では建てられません（工房を貸す・権利を出す試験世界 --coexist でだけ建てられます）。`}</li>` : ''}</ul>`) : ''}
    ${m.promotion ? html`<ul class="build-list">${promotionRow(m.promotion, whyOf(m.promotion), m.have)}</ul>` : ''}
    ${queueFull ? html`<p class="blocked">${whyText('QueueFull', { tier: Number(m.settled.tier ?? 0), freeIn })}</p>` : ''}
    ${blockedLine(m.blocks.Build)}</section>`;

  // (the cheapest hundred the stores cannot pay for: the button says so instead of sending an order the program refuses)
  const trainShort = training.short.map(x => ({ resource: RESOURCE_ORDER[x.resource], need: x.need }));
  const trainForm = html`<form class="vform" id="hp-train" data-form="train">
    ${unitPicks(faction, UNIT_ORDER.map((u, unit) => ({ unit })).filter(x => x.unit !== SETTLER), L`兵種`, { costs: true, have: m.have, selected: trainUnit, programVersion: m.programVersion })}
    <div class="count-row"><label class="count-label" for="f-n">${L`人数`}</label><input id="f-n" name="n" type="number" min="1" step="1" value="${trainN}" max="30000" inputmode="numeric">${steps('n', { presets: [100, 200, 500], max: training.max })}</div>
    <p class="training-cost" aria-live="polite">${training.cost ? html`${L`訓練の費用`}: ${costChips(training.cost, m.have)}` : L`1〜30,000人で人数を決めてください。`}</p>
    <p class="muted training-hundred">${L`費用は100人ごとです。100人に満たない分も100人分かかります（10人でも100人分）。`}</p>
    <p class="muted">${L`いま訓練できる人数 ${fmtNum(training.max)}（一隊の上限まで）`}</p>
    <div class="actions"><button type="submit" class="btn primary" ${raw(actionBusy || m.blocks.Train.length || !training.affordable || trainN > 30000 || trainShort.length ? 'disabled' : '')}>${L`訓練する`}</button><span class="muted">${L`訓練はすぐに終わり、兵は控えに入ります。`}</span></div>
    ${trainShort.length ? html`<p class="blocked">${shortWords(trainShort)}</p>` : ''}
    ${blockedLine(m.blocks.Train)}</form>`;
  const ms = musterShown(FS, m.rawHolding, reserve);
  const musterForm = html`<form class="vform" id="hp-muster" data-form="muster">
    ${reserve.length ? unitPicks(faction, reserve, L`兵種`, { selected: ms.unit }) : ''}
    <div class="count-row"><label class="count-label" for="f-troops">${L`兵数（100〜30,000）`}</label><input id="f-troops" name="troops" type="number" min="100" max="30000" step="1" value="${ms.troops}" inputmode="numeric">${steps('troops', { max: reserve.length === 1 ? Math.min(30000, reserve[0].troops) || null : null })}</div>
    ${ms.missing ? html`<p class="blocked">${L`選んでいた兵種は控えにいません。兵種を選び直してください。`}</p>` : ''}
    ${ms.short !== null ? html`<p class="blocked">${L`控えのこの兵種は ${fmtNum(ms.short)} です。兵数を減らしてください。`}</p>` : ''}
    <div class="actions"><button type="submit" class="btn primary" ${raw(actionBusy || m.blocks.Muster.length || !reserve.length || ms.missing || ms.short !== null ? 'disabled' : '')}>${icon('banner')}${L`編成する`}</button><span class="muted">${L`編成した軍勢は、このターンが終わり、封が開けられて決着すると行動できます。`}</span></div>
    ${!reserve.length ? html`<p class="blocked">${L`控えの兵がいません：先に訓練しましょう`}</p>` : ''}
    ${blockedLine(m.blocks.Muster)}</form>`;
  // the action that makes sense now stands open; the other waits behind a fold
  const musterFirst = musterable >= 100;
  // (2026-11-17, ⑦ from the troops card to the hosts: train → the reserve → form up → the host — and from here on to the
  //  hosts drawer, where its march is planned. The card had no way on: after 「編成する」 the host it made was shown
  //  nowhere on this screen, and nothing led to the drawer that lists it. The button is the existing tab action; the
  //  drawer shows the village in hand — this one.)
  const vh = FS.mode === 'play' ? villageHosts(FS, m.rawHolding) : null;
  const hostsWay = vh ? html`<div class="village-hosts" data-hosts="${vh.total}" data-partial="${vh.partial ?? ''}">
      <p>${L`この村の軍勢：編成の反映待ち ${fmtNum(vh.forming)}、立っている ${fmtNum(vh.standing)}、進軍中 ${fmtNum(vh.marching)}。`}</p>
      ${vh.partial === 'unknown' ? html`<p class="muted" role="status">${L`軍勢がどの州にいるかの一覧をまだ読めていないので、この数がすべてとは限りません。`}</p>`
        : vh.partial === 'unread' ? html`<p class="muted" role="status">${L`読めていない州があるので、この数がすべてとは限りません。`}</p>` : ''}
      <div class="actions"><button type="button" class="btn" data-act="tab" data-tab="hosts">${icon('sword')}${L`この村の軍勢の一覧を開く`}</button></div>
      <p class="muted">${L`編成した軍勢は、記録に出ると「編成の反映待ち」に入ります。進軍の計画は、軍勢の一覧から立てます。`}</p></div>` : '';
  const troops = html`<section class="vcard" aria-labelledby="hp-troops-h">
    ${cardHead({ id: 'hp-troops-h', ic: 'sword', title: L`兵`, side: html`<span class="c-count">${L`控え ${fmtNum(musterable)}`}</span>` })}
    ${label(musterFirst ? L`軍勢を編成する` : L`兵を訓練する`)}
    ${musterFirst ? musterForm : trainForm}
    ${fold(musterFirst ? 'v-train' : 'v-muster', musterFirst ? L`兵を訓練する` : L`軍勢を編成する`, musterFirst ? trainForm : musterForm)}
    ${hostsWay}</section>`;

  const others = html`<section class="vcard vcard-folds" aria-label="${L`そのほか`}">
    ${fold('v-garrison', html`${icon('shield')}${L`守備隊を増やす`}`, html`<form class="vform" id="hp-garrison" data-form="garrison">
      <div class="count-row"><label class="count-label" for="f-delta">${L`増員（控えの兵から）`}</label><input id="f-delta" name="delta" type="number" min="1" step="1" value="100" inputmode="numeric">${steps('delta', { max: musterable || null })}</div>
      <div class="actions"><button type="submit" class="btn primary" ${raw(actionBusy || m.blocks.Garrison.length ? 'disabled' : '')}>${L`守備隊を増やす`}</button>${termButton('garrison')}</div>
      <p class="muted">${L`守備隊は増やすことだけできます（引き上げはまだできません）。`}</p>
      ${blockedLine(m.blocks.Garrison)}</form>`)}
    ${fold('v-vigil', html`${icon('moon')}${L`夜番の時間`}<span class="fold-val">${L`${String(vigilHour).padStart(2, '0')}:${String(vigil % 60).padStart(2, '0')} から（UTC）`}</span>`, html`<form class="vform" data-form="vigil">
      <label class="field">${L`開始（UTC の時）`}<select name="hour">${Array.from({ length: 24 }, (_, hr) => html`<option value="${hr}" ${raw(hr === vigilHour ? 'selected' : '')}>${L`${String(hr).padStart(2, '0')}:00 UTC（あなたの時刻 ${localHour(hr)}）`}</option>`)}</select></label>
      <div class="actions"><button type="submit" class="btn">${L`変える`}</button>${termButton('vigil')}</div>
      <p class="muted">${L`変更は24時間以上あとの最初の UTC 0時から有効で、週に1回までです。`}</p></form>`)}
    ${fold('v-facts', html`${icon('scroll')}${L`村の詳細`}`, html`<dl class="facts">
      ${row(L`場所`, provinceCoords(h.p, h.q))}
      ${row(L`段階`, html`${TIERS[h.tier] ?? h.tier} · ${HOLDING_STATES[f.state]}${termButton('tier')}`)}
      ${f.state === 'provisional' ? row(L`確定`, f.finalTs ? Lh`早くて${dueHtml(f.finalTs, FS.chain?.now?.() ?? null)}` : L`同じターンの申し込みがすべて決まってから`) : ''}
      ${f.shieldLeft > 0 ? row(L`保護`, L`残り ${countdown(f.shieldLeft)}`) : ''}
      ${row(L`休眠まで`, html`${f.dormantIn > 0 ? L`あと ${span(f.dormantIn)}` : L`休眠中`}${termButton('dormant')}`)}
    </dl>`)}</section>`;

  // S1: caravans, storehouses, structures, the fort and the nation (screens/s1.mjs)
  // (2026-11-17, ⑦: the reads behind this screen, said under its head when one did not come — renderHoldingRead; it
  //  rides with the head, so the list of cards is as long as it was)
  const readNote = renderHoldingRead(FS);
  // (2026-11-17, ⑦: what became of the orders given from this village this turn — screens/villageorders.mjs — rides with
  //  the head too; it reads FS.orders and the record, and changes no button)
  const orderNote = renderVillageOrders(FS, m.settled, m.now, { rereadShown: holdingRead(FS).reread.can });
  // (devnet-page-outpost: the second/third village on a devnet season whose gateway carries FileOutpost —
  //  screens/outpostcard.mjs — rides in the wide card's place, after it; the list below is as it was)
  const claimCard = wideClaimCard(FS, m, actionBusy), outpost = outpostCard(FS, m, actionBusy);
  const wideCard = claimCard && outpost ? html`${claimCard}${outpost}` : claimCard || outpost;
  return [...(wideStatus ? [wideStatus] : []), readNote || orderNote ? html`${head}${readNote}${orderNote}` : head, stores, ...(wideCard ? [wideCard] : []), build, troops, ...(s1On() ? [renderS1Village(FS)] : []), others];
}
