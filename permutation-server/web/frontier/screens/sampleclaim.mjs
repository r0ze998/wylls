// THE WALLETLESS DEMO'S "Claim a tile" CARD (demo-claim-1, owner Q-WD-4 default: the real one-tile claim in the demo).
// The real card's parts (screens/holding.mjs: the land line, the logistics horizon, the reason lines, the province rows
// and their buttons) over the demo map; the rows, the tile, the witness and the price by TERRITORY_V1 in this browser
// (sampleland.mjs). Only a sample world whose record says `landClaim` shows it; every other page is as it was.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCE_ORDER } from '../fi18n.mjs';
import { storesAt } from '../fland.mjs';
import { TERRITORY_V1, ownLandView } from '../flocalplay-territory.mjs';
import { sampleClaimRows, nextClaimOre } from '../sampleland.mjs';
import { landClaimOn } from '../territory.mjs';
import { landUpkeepMilli, withLand, signedNet } from '../landfood.mjs';
import { termsRate } from '../seasonterms.mjs';
import { caravansOff } from './s1.mjs';
import { cardHead } from './parts.mjs';
import { pinnedRows, ownLandBlock, ownLandHorizonBlock, horizonFromFS, tileWhy, noFreeNote, upkeepText } from './holding.mjs';

/**
 * (walletless demo, demo-claim-1, owner Q-WD-4 default) The "Claim a tile" card of a sample world whose record says
 * `landClaim`: the real card's land lines, logistics horizon, reasons and province rows, over the demo map
 * (sampleland.mjs sampleClaimRows — the reach, the first free tile and the witness, by TERRITORY_V1, in this browser).
 * The first press shows the cost (ore from the first village, the tile's upkeep), the second claims.
 */
export function sampleClaimModel(FS, m) {
  if (!landClaimOn(FS) || !m?.holding || Number(m.holding.order ?? 1) !== 1 || !Number.isInteger(FS?.citizen?.faction)) return null;
  const h = m.holding, faction = FS.citizen.faction;
  const provinces = [...(FS.provinces?.values?.() ?? [])].filter(env => env?.province && env.sampleTerritory).map(env => ({ p: env.province.p, q: env.province.q, province: env.province, owners: env.sampleTerritory.owners }));
  const ownTiles = new Set(Object.keys(FS.ui?.ownTiles ?? {}));
  const all = sampleClaimRows({ provinces, home: { p: h.p, q: h.q }, faction, ownTiles });
  const pins = new Map(all.filter(t => t.mine).map(t => [`${t.p},${t.q}`, 'tiles']));
  const targets = pinnedRows(all.filter(t => t.tile !== null || t.mine), 6, pins).map(t => ({ ...t, reach: t.witness?.kind === 'nation' ? { p: t.witness.p, q: t.witness.q } : null, noFree: t.tile === null }));
  const land = FS.ownLand && Object.hasOwn(FS.ownLand, 'player') ? ownLandView(FS.ownLand.player, FS.nowBell ?? 0) : null;
  const ore = m.have[RESOURCE_ORDER.indexOf('Ore')] ?? 0;
  const tilePrice = land ? land.nextOre : nextClaimOre(0);
  const foodRow = land && !land.unpaid && land.tiles > 0 && Array.isArray(h.stores) ? withLand(storesAt(h, FS.chain?.now?.() ?? 0, RESOURCE_ORDER).find(x => x.resource === 'Food') ?? null, landUpkeepMilli(FS, h)) : null;
  const foodStalled = foodRow && foodRow.landPerHour > 0 && foodRow.perHour <= 0 ? { perHour: foodRow.perHour } : null;
  const pv = FS.tilePreview?.step === 'preview' && FS.tilePreview.demo ? FS.tilePreview : null;
  return { targets, land, tilePrice, territory: true, tileShort: ore < TERRITORY_V1.cost.base && tilePrice <= TERRITORY_V1.cost.base, tilePriceShort: ore < tilePrice && tilePrice > TERRITORY_V1.cost.base,
    tileOff: ore < tilePrice || !!land?.unpaid, foodStalled, preview: pv };
}
/** (demo-claim-1) The demo claim's cost: the ore of the first village's stores and the upkeep the tile adds; nothing is signed. */
function sampleTilePreviewBlock(pv, busy) {
  if (!pv) return '';
  return html`<div class="preview" id="hp-tile-preview" role="group" aria-labelledby="hp-tile-preview-h">
    <p id="hp-tile-preview-h"><strong>${L`州 ${pv.target.p},${pv.target.q} のマス ${pv.tile} を取る費用`}</strong></p>
    <p>${L`鉱石 ${fmtNum(pv.cost.ore)}（本拠地の蔵から）`} · ${L`このマスの維持費: 食料 ${upkeepText(pv.cost.upkeepMilli)}/時`}</p>
    <p class="muted">${L`取ったあとの維持費は本拠地の食料から自動で払われます。払えないと新しいマスは取れず、24ターン後から遠いマスが1ターンに1つずつ手放されます。`}</p>
    <button type="button" class="btn small primary" data-act="territory-tile" data-p="${pv.target.p}" data-q="${pv.target.q}" data-confirm="1" ${raw(busy ? 'disabled' : '')}>${L`1マス取る`}</button>
    <button type="button" class="btn small ghost" data-act="territory-tile-cancel">${L`やめる`}</button></div>`;
}
export function sampleClaimCard(FS, m, busy) {
  const w = sampleClaimModel(FS, m);
  if (!w) return '';
  const hz = horizonFromFS(FS), u = TERRITORY_V1.upkeep, c = TERRITORY_V1.cost;
  const from = t => (t.pin === 'tiles' ? html` <span class="muted" data-pin="tiles">${L`あなたのマスがある州`}</span>`
    : t.witness?.kind === 'nation' ? html` <span class="muted">${L`国の土地（州 ${t.witness.p},${t.witness.q}）から`}</span>`
      : t.witness?.kind === 'own' ? html` <span class="muted">${L`あなたのマス（州 ${t.witness.p},${t.witness.q}）から`}</span>` : '');
  return html`<section class="vcard" id="hp-land-claim" aria-labelledby="hp-land-claim-h">
    ${cardHead({ id: 'hp-land-claim-h', ic: 'flag', title: L`あなたの土地` })}
    ${ownLandBlock(w.land)}
    ${ownLandHorizonBlock(hz, { rate: termsRate(), villageCount: hz?.villageCount, otherFoodMilli: hz?.otherFoodMilli, otherProdMilliPerHour: hz?.otherProdMilliPerHour, caravansOff: caravansOff(FS) })}
    ${w.foodStalled ? html`<p class="muted" id="hp-own-land-stalled"><span class="blocked">${L`食料の増え方はもう 0 以下です（${signedNet(w.foodStalled.perHour)}/時）。次の1マスの維持費は、本拠地が毎ターン作る食料では払えません。`}</span></p>` : ''}
    ${w.tilePriceShort ? html`<p class="muted"><span class="blocked" id="hp-tile-why-price">${L`鉱石が次の1マスの値段（${fmtNum(w.tilePrice)}）に足りないので、いまは「1マス取る」を押せません。`}</span></p>` : ''}
    ${w.land?.unpaid ? html`<p class="muted"><span class="blocked" id="hp-tile-why-unpaid">${L`土地の維持費が払えていないので、いまは「1マス取る」を押せません。`}</span></p>` : ''}
    ${w.tileShort ? html`<p class="muted"><span class="blocked" id="hp-tile-why-ore">${L`鉱石が 10 に足りないので、いまは「1マス取る」を押せません。`}</span></p>` : ''}
    <ul class="build-list">${w.targets.map(t => html`<li data-claim-row="${t.p},${t.q}"><span>${L`州 ${t.p},${t.q}`}${from(t)}${noFreeNote(t)}</span>
      <button type="button" class="btn small" data-act="territory-tile" data-p="${t.p}" data-q="${t.q}"${raw(tileWhy(w))} aria-label="${L`1マス取る`}: ${L`州 ${t.p},${t.q}`}" ${raw(busy || w.tileOff || t.noFree ? 'disabled' : '')}>${L`1マス取る`}</button></li>`)}</ul>
    ${sampleTilePreviewBlock(w.preview, busy)}
    <p class="muted">${L`「1マス取る」はその州のマスを1つ、すぐ自分の土地にします（鉱石 ${fmtNum(c.base)}、持っているマス1つごとに +${fmtNum(c.perOwnedBps / 100)}%、1ターンに${fmtNum(TERRITORY_V1.claimsPerTurn)}マス）。本拠地、自分のマスがある州、自分の国の村がある州から ${fmtNum(TERRITORY_V1.range)} 州以内で取れます。土地の維持費は本拠地の食料から払います（1マス ${upkeepText(u.flat)}/時、自分の村から${fmtNum(u.freeDistance)}州より遠いと1州ごとに +${upkeepText(u.perDistance)}/時）。払えないと新しく取れず、${fmtNum(TERRITORY_V1.decayAfterBells)}ターン後から遠いマスが1ターンに1つずつ手放されます。`}</p></section>`;
}
