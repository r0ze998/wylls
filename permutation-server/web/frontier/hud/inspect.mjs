// The selection inspector (UI plan stage 3; Eternum's tile details, Civ's
// select → details): what is on the chosen province or tile, from what the
// page already has — the overview (owners and site states of every open
// province), the province envelope (site mirror, hosts, camp, relations)
// and the rules module's terrain — and the actions that make sense there:
// open the holding, choose the tile as the march destination, add the site
// to the settlement ticket, read the last clash report. Every action is an
// existing `data-act` of the play screens; the inspector only offers it.
import { icon } from './icons.mjs';
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName, unitCount } from '../fi18n.mjs';
import { UNIT_ORDER, hostsIn } from '../fland.mjs';
import { miniCardUrl } from '../people/minis.mjs';
import { ringOf } from '../fgeo.mjs';
import { troopsOf } from '../fmarch.mjs';
import { swatch } from '../screens/shell.mjs';
import { personChip, hostOwner, holdingName, isOwnIdentity, ownTag } from '../people/ui.mjs';
import { s1Marks, S1_WORDS } from '../map/s1marks.mjs';
import { leaderHex } from '../people/leaders.mjs';
import { identityOf, displayName } from '../people/identity.mjs';
import { hostParts } from '../faddr.mjs';
import { fogNow, viewOverviews, viewClash } from '../map/fog.mjs';
import { activityText } from '../people/activity.mjs';
import { hostRows } from '../screens/host.mjs';
import { hasPin } from './pins.mjs';
import { termButton } from './glossary.mjs';
import { placeName, placeWhere } from '../map/names.mjs';
import { PLACE, placeNow, ringText, wideRingText, ringSeeded } from '../map/world.mjs';
import { TERRAIN_TEXT, villageDrawn, provinceName, provinceCoords, tileName } from './place.mjs';
import { unpack } from '../seal.mjs';
import { materialBytes } from '../marchbook.mjs';
import { cardHead, chip, fold, label } from '../screens/parts.mjs';
import { wideSlots } from '../fwide.mjs';
import { conquestEnabled, keepFor, renderKeep, renderOutpost } from '../screens/conquest.mjs';
import { territoryEnabled, territoryOf, territoryOwner } from '../territory.mjs';
import { landOf, landTile, landTileLines } from '../land.mjs';
import { s1On } from '../fs1.mjs';
import { campsOn, lootOf } from '../democamps.mjs';
import { renderS1Tile, raidOffers } from '../screens/s1.mjs';

/** Site states as the overview carries them (herald SITE_STATE) and the v2 mirror (3 = released, free again; 5 = a Free City). */
const SITE_TEXT = { free: () => L`村を置ける場所`, holding: () => L`村`, camp: () => L`蛮族の野営地`, reserved: () => L`予約済みの場所`, freeCity: () => L`自由都市` };

const overviewRec = (FS, p, q) => {
  // (the overviews as the viewer may see them: the fogged ones in a local test world, map/fog.mjs)
  for (const o of viewOverviews(FS)?.values?.() ?? []) {
    const r = o.provinces?.find(x => x.p === p && x.q === q);
    // (the clash flag speaks of the overview's own bell: an overview older than the last bell says nothing about now)
    if (r) return r.clash && Number.isInteger(o.bell) && Number.isInteger(FS.nowBell) && o.bell < FS.nowBell - 1 ? { ...r, clash: false } : r;
  }
  return null;
};

/** Whether a clash of (p, q) at `bell` is the viewer's own: a village of theirs there, or a march of theirs arriving then. */
export const ownClashPlace = (FS, p, q, bell) => !!FS.citizen && ((FS.holdings ?? []).some(h => h.p === p && h.q === q)
  || (FS.marches ?? []).some(m => m.dest && m.dest.p === p && m.dest.q === q && (m.entry?.arriveBell ?? m.transit?.arriveBell) === bell));

/** Whether factions a and b are not hostile in a province (RELATIONS bit a*8+b). */
export const friendly = (relations, a, b) => a === b || (relations !== undefined && relations !== null && ((BigInt(relations) >> BigInt(a * 8 + b)) & 1n) === 1n);

/** (fix-loop7, LP7-4) Whether province (p, q) is a province of the wide land that is open in this world (ring > 128). */
export function wideOpen(FS, p, q) {
  if (!Number.isInteger(p) || !Number.isInteger(q) || ringOf(p, q) <= 128) return false;
  let land = null;
  try { land = typeof FS?.wideLandNow === 'function' ? FS.wideLandNow() : null; } catch { land = null; }
  if (land?.byKey?.has?.(`${p},${q}`)) return true;
  const targets = FS?.localPlay?.wideLand?.targets;
  return Array.isArray(targets) && targets.some(t => Number(t?.p) === p && Number(t?.q) === q);
}

/**
 * The inspector's view of the selection: `{p, q, ring, opened, owners, tile?}`
 * with `tile = {idx, terrain, site?, hosts, camp?}`; null without a selection.
 */
export function inspectModel(FS, terrainOf) {
  const s = FS.selected;
  if (!s || !Number.isInteger(s.p)) return null;
  const rec = overviewRec(FS, s.p, s.q);
  const prov = FS.provinces?.get(`${s.p},${s.q}`)?.province ?? null;
  const viewer = FS.citizen?.faction;
  const t = terrainOf?.(s.p, s.q) ?? null;
  // the survey (map/survey.mjs): what the viewer has not surveyed is terrain and nothing else; what is surveyed but
  // out of sight keeps its village (nation, tier, lord) and loses what is happening there now. A page without a
  // survey (the spectator, a test) has everything in sight.
  const sv = FS.survey && !FS.survey.showAll ? FS.survey : null;
  const lv = idx => (!sv ? 3 : Number.isInteger(idx) ? sv.levelOf(s.p, s.q, idx) : 1);
  const top = sv ? sv.province(s.p, s.q).max : 3;
  const owners = rec ? [...new Set(rec.owners.filter((f, j) => rec.sites[j] === 1 && f < 6 && (!sv || lv(t?.sites?.[j]) >= 2)))] : [];
  // what the place is before any survey (map/world.mjs): open land, being made, not open yet, or beyond the season's map
  const place = placeNow(FS, s.p, s.q) ?? (rec ? PLACE.open : PLACE.unopened);
  // (2026-11-17, ⑦ the wide map: how the reads this card stands on went — the province's own record (controller
  //  loadEnvelope / wantProvince: loading, failed with a code, missing) and whether the ring's overview has been read at
  //  all. Not read is not empty: without the overview the card knows no village of this province, and says so)
  const read = prov ? null : FS.provinceReads?.get?.(`${s.p},${s.q}`) ?? null;
  // (only a ring that has an overview to read — map/world.mjs ringSeeded, as map/overviews.mjs asks it — can be "not read")
  const ringRead = !!rec || !FS.world || !ringSeeded(FS.world, ringOf(s.p, s.q)) || !!FS.overviews?.has?.(ringOf(s.p, s.q));
  // (fix-loop7, LP7-4: a province of the opened wide land — rings past 128, open in this world: the page's wide-land read,
  //  FS.wideLandNow, unfogged, or the local world's start answer's opened targets — is not "not open yet". Its ring being
  //  open is public geometry (the season record), so saying so shows nothing the fog hides. `wide` says it; the province's
  //  own record is read by the wide-land path, not the ordinary one, so `opened` stays as it was)
  const wide = wideOpen(FS, s.p, s.q);
  const out = { p: s.p, q: s.q, ring: ringOf(s.p, s.q), place, opened: place === PLACE.open, wide, owners, clash: !!rec?.clash && top === 3, loaded: !!prov, read, ringRead, level: Number.isInteger(s.idx) ? lv(s.idx) : top,
    relation: Number.isInteger(viewer) && prov ? owners.filter(f => f !== viewer).map(f => ({ faction: f, friendly: friendly(prov.relations, viewer, f) })) : [],
    // (fix-loop5, L5-6: under the fog a clash is offered only where its place is in sight now, or when it is the viewer's)
    reportBell: top === 3 && viewClash({ p: s.p, q: s.q, keepTile: rec?.keepTile ?? null, mine: ownClashPlace(FS, s.p, s.q, prov?.resolveSummary?.bell) }) ? prov?.resolveSummary?.bell || null : null, tile: null };
  if (!Number.isInteger(s.idx)) return out;
  const here = out.level;
  const j = t ? t.sites.indexOf(s.idx) : prov ? Array.from(prov.sites ?? []).indexOf(s.idx) : -1;
  const tile = { idx: s.idx, terrain: t ? t.names[t.terrain[s.idx]] : null, site: null, hosts: [], camp: null };
  // (B14: a centre place without a Province has no site: its seed's site list is not land — no 「村を置ける場所」 there)
  if (j >= 0 && here >= 2 && place !== PLACE.centre) {
    const m = here === 3 ? prov?.siteMirror?.[j] : null;
    // (the v2 mirror: 3 is a released site, free again; 5 a genesis Free City, `site::STATE_FREE_CITY`)
    const state = m ? (m.state === 5 ? 'freeCity' : ['free', 'holding', 'camp', 'free', 'reserved'][m.state] ?? 'free') : rec?.siteKinds?.[j] === 2 ? 'freeCity' : ['free', 'holding', 'camp', 'reserved'][rec?.sites?.[j] ?? 0];
    const faction = m ? m.faction : rec?.owners?.[j];
    const mine = (FS.holdings ?? []).find(h => h.p === s.p && h.q === s.q && h.site === j) ?? null;
    // (the fog of war of a local test world, map/fog.mjs — verify-pr93: the roster is live, so a village seen before but out
    //  of sight now is named, and its tier said, only when it is the viewer's nation's; its lord now is not the viewer's to know)
    const rosterHere = here === 3 || !fogNow().on || (Number.isInteger(FS.citizen?.faction) && faction === FS.citizen.faction);
    const holder = state === 'holding' && rosterHere ? FS.roster?.ownerOf(s.p, s.q, j) ?? null : null;
    tile.site = { index: j, state, faction: state === 'holding' ? faction : null, owner: holder ? identityOf(holder.tag) : null, tier: m?.tier ?? (state === 'holding' && rosterHere ? FS.roster?.tierOf?.(s.p, s.q, j) ?? null : null), garrison: m ? troopsOf(m.garrison) : null,
      shield: m ? m.shieldUntilBell > (FS.nowBell ?? 0) : false, mine: !!mine, holdingIndex: mine ? FS.holdings.indexOf(mine) : -1 };
  }
  for (const e of prov?.entries ?? []) {
    if (e.tile !== s.idx || (e.state !== 1 && e.state !== 2)) continue;
    if (here < 3 && !sv?.ownHosts?.has(String(e.id))) continue;   // other people's hosts: in sight only
    tile.hosts.push({ id: String(e.id), faction: e.faction, owner: hostOwner(FS.roster, e.id), unit: UNIT_ORDER[e.unit] ?? null, troops: troopsOf(e.troops), pending: e.state === 2 });
  }
  // (a camp's troops are whole troops in the account, Camp.TROOPS: not the thousandths a host's are)
  // (walletless demo, demo-npc-camps: the demo's camp markers show every camp through the fog, so its tile card says it too)
  if ((here === 3 || campsOn(FS)) && prov?.camp?.state === 1 && prov.camp.tile === s.idx) tile.camp = { troops: Number(prov.camp.troops) };
  // S1: a vault or a structure on this tile, from the herald's public feeds and by the map's own rules (map/s1marks.mjs:
  // drawn whatever the survey, the viewer's by the owner tag)
  if (FS.s1) {
    const mk = s1Marks(FS.s1, { own: ownTag(FS) });
    // (under the fog of war of a local test world, map/fog.mjs — verify-pr93: another's vault or structure only in sight now)
    const at = [...mk.vaults, ...mk.structures].filter(x => x.p === s.p && x.q === s.q && x.tile === s.idx && (x.own || here === 3 || !fogNow().on));
    if (at.length) tile.s1 = at.map(x => ({ kind: x.kind, faction: x.faction, own: x.own }));
  }
  // Ownership is current server state, so it is only shown while this tile is in sight.
  const territory = here === 3 ? territoryOf(FS, s.p, s.q) : null;
  if (territory) tile.territory = { owner: territoryOwner(FS, s.p, s.q, s.idx), since: territory.since[s.idx] };
  // the land preview (a TEST-ONLY world with land records): who holds this tile and any count running on it, in sight only
  const land = here === 3 && !territoryEnabled(FS) ? landOf(FS, s.p, s.q) : null;
  if (land) tile.land = landTile(land, s.idx);
  out.tile = tile;
  return out;
}

/**
 * How the reads behind the card went (2026-11-17, ⑦ the wide map), for open land only: the province's record being
 * read, not read (with the herald's code) or not there yet, and the ring's overview not read — each said as what it is,
 * never as an empty province, with one button that reads again (app `province-reread`). Nothing when all is read.
 */
function readState(m) {
  if (!m.opened) return '';
  const again = html`<button type="button" class="btn small" data-act="province-reread" data-p="${m.p}" data-q="${m.q}">${icon('return')}${L`もう一度読み込む`}</button>`;
  const lines = [];
  if (!m.loaded) {
    const st = m.read?.state ?? 'idle';
    if (st === 'failed') lines.push(html`<p class="notice error" role="alert">${L`この州のようすを読み込めませんでした（${m.read.code}）。何もない州という意味ではありません。`}</p>`);
    else if (st === 'missing') lines.push(html`<p class="muted" role="status">${L`この州の記録は、まだ届いていません。何もない州という意味ではありません。`}</p>`);
    else if (st === 'waiting') lines.push(html`<p class="muted" role="status">${L`この州の読み込みは、順番を待っています。空きしだい読み込みます。`}</p>`);
    else if (st === 'loading') lines.push(html`<p class="muted" role="status">${L`この州のようすを読み込んでいます…`}</p>`);
    // (nothing under way and nothing held: not asked yet, or an answer that was let go — said as that, with the button)
    else lines.push(html`<p class="muted" role="status">${L`この州のようすは、まだ読み込んでいません。何もない州という意味ではありません。`}</p>`);
  }
  if (!m.ringRead) lines.push(html`<p class="muted" role="status">${L`この輪の村の一覧は、まだ読み込めていません。村がないという意味ではありません。`}</p>`);
  if (!lines.length) return '';
  const retry = !m.ringRead || (!m.loaded && m.read?.state !== 'loading' && m.read?.state !== 'waiting');
  return html`<div class="insp-read" data-read="${!m.loaded ? m.read?.state ?? 'idle' : 'ring'}">${lines}${retry ? html`<div class="actions">${again}</div>` : ''}</div>`;
}

/** What a place `{p, q, tile}` is called and where it is (map/names.mjs): `{name, where}`, by the same rules as the selection. */
export function placeAt(FS, place, terrainOf = null) {
  const m = inspectModel({ ...FS, selected: { p: place.p, q: place.q, idx: place.tile } }, terrainOf);
  return { name: placeName(m), where: placeWhere(m) };
}

/** The viewer's hosts standing on a tile and able to march (state 1, not on the road): `[{id, troops, unit}]` (`unit` the kernel's name). */
export function ownHostsOn(FS, p, q, idx) {
  try {
    const out = hostRows(FS).filter(r => r.p === p && r.q === q && r.tile === idx && r.state === 1 && !r.inTransit && !r.pending).map(r => ({ id: String(r.id), troops: r.troops, unit: UNIT_ORDER[r.unit] ?? null, holdingIndex: FS.activeHolding ?? 0, other: false }));
    // (2026-11-17, ⑦ the march's entry: the hosts of the viewer's OTHER villages standing here too — hostRows reads the
    //  open village only, and the card showed such a host with no way to send it. `other`: its village is not the open
    //  one; the march's entry switches to it — controller ACTIONS.compose)
    const prov = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;
    (FS.holdings ?? []).forEach((h, i) => {
      if (!prov || !h || i === (FS.activeHolding ?? 0)) return;
      for (const r of hostsIn(prov, h, FS.nowBell ?? 0)) {
        if (r.tile !== idx || r.state !== 1 || r.inTransit || r.pending || out.some(x => x.id === String(r.id))) continue;
        out.push({ id: String(r.id), troops: r.troops, unit: UNIT_ORDER[r.unit] ?? null, holdingIndex: i, other: true });
      }
    });
    return out;
  } catch { return []; }
}

/**
 * Who a host is, for a line that names one (people/activity.mjs: a march on the road): `id → {mine, unit, troops,
 * owner, dest, sealHere}` — the viewer's own by its unit and troops (from the province the page holds) and, when
 * this device holds the copy of its seal, where it goes (`dest`, a place's name; `sealHere`); anyone else's by its
 * owner's name (the roster); null for an id that names no host.
 */
export function hostInfoOf(FS) {
  return id => {
    const hp = hostParts(id);
    if (!hp) return null;
    if ((FS.holdings ?? []).some(o => o.p === hp.p && o.q === hp.q && o.site === hp.site && o.gen === hp.gen)) {
      const e = (FS.provinces?.get?.(`${hp.p},${hp.q}`)?.province?.entries ?? []).find(x => String(x.id) === String(id));
      // where it goes, when this device holds the copy of its seal (the march book): by the place's name; else nothing is known here
      const kept = (FS.book ?? []).find(b => String(b.host) === String(id) && b.state !== 'settled' && b.state !== 'failed') ?? null;
      let dest = null;
      try { if (kept) { const m = unpack(materialBytes(kept).plain); dest = tileName(FS, m.destP, m.destQ, m.destTile); } } catch { dest = null; }
      return { mine: true, unit: e ? UNIT_ORDER[e.unit] ?? null : null, troops: e ? troopsOf(e.troops) : null, owner: null, dest, sealHere: !!kept };
    }
    const o = hostOwner(FS.roster, id);
    return { mine: false, unit: null, troops: null, owner: o ? displayName(o) : null };
  };
}

/** The actions the selection offers: `[{act, data, text, primary?}]` (existing play actions only). */
export function inspectActions(FS, m) {
  if (!m) return [];
  // a pin on this place (players and spectators)
  const place = { p: m.p, q: m.q, tile: m.tile ? m.tile.idx : null };
  const pin = { act: 'pin-toggle', data: { p: m.p, q: m.q, tile: place.tile ?? '' }, text: hasPin(FS.pins, place) ? L`ピンを外す` : L`ピンを立てる` };
  // spectators can replay a clash on the map (the report itself is the game page's)
  if (FS.mode === 'spectate') return [...(m.reportBell ? [{ act: 'battle-play', data: { p: m.p, q: m.q, bell: m.reportBell }, text: L`戦いを再生`, primary: true }] : []), pin];
  if (FS.mode !== 'play') return [];
  const out = [];
  const t = m.tile;
  if (t?.site?.mine) out.push({ act: 'holding-pick', data: { i: t.site.holdingIndex }, text: L`この村を開く`, primary: true });
  // (B14: never a centre place without a Province — the march would be sealed for land the program cannot reveal it on)
  if (FS.compose && t && !FS.compose.sending && m.place !== PLACE.centre) out.push({ act: 'dest-from-map', data: {}, text: L`ここを進軍の行き先にする`, primary: true });
  // the viewer's own ready hosts on this tile can be sent from here (the march card then opens on the map)
  // (a host of another of the viewer's villages says so: pressing it opens the march from that village)
  if (!FS.compose && t) for (const h of ownHostsOn(FS, m.p, m.q, t.idx)) out.push({ act: 'compose', data: { host: h.id, stay: 'map' }, text: h.other ? L`${unitCount(h.unit, h.troops)} を進軍させる（別の村の軍勢：その村から出します）` : L`${unitCount(h.unit, h.troops)} を進軍させる`, primary: true });
  // no site picking from the map (owner decision V2: the first village is placed automatically)
  if (m.reportBell) out.push({ act: 'battle-play', data: { p: m.p, q: m.q, bell: m.reportBell }, text: L`戦いを再生` });
  if (m.reportBell) out.push({ act: 'report-open', data: { p: m.p, q: m.q, bell: m.reportBell }, text: L`ターン ${fmtNum(m.reportBell)} の衝突の報告` });
  out.push(pin);
  return out;
}

const dataAttrs = d => raw(Object.entries(d).map(([k, v]) => `data-${k}="${String(v).replace(/[^\w.-]/g, '')}"`).join(' '));

/**
 * The selection on the dock's screens (UI plan E4): one line naming what the map
 * has selected, with "show" and "clear" — the screen keeps its own content.
 */
export function renderBrief(FS, terrainOf) {
  const m = inspectModel(FS, terrainOf);
  if (!m) return '';
  const t = m.tile, site = t?.site;
  // the place by its name (map/names.mjs, which follows the survey through the model); its coordinates are under the inspector's details
  const name = placeName(m);
  const what = html`${site?.state === 'holding' ? swatch(site.faction) : ''}<span>${name}</span>`;
  return html`<div class="sel-brief" role="status">${icon('pin')}<span class="sel-what">${L`選択中`}: ${what}${t?.hosts?.length ? html` · ${L`軍勢 ${fmtNum(t.hosts.length)}`}` : ''}</span>
    <button type="button" class="btn small" data-act="sel-open">${L`詳しく見る`}</button><button type="button" class="btn small quiet" data-act="sel-clear" aria-label="${L`選択を外す`}">${icon('close')}</button></div>`;
}

/**
 * The inspector: a compact card with the name first (the village, the camp or the land, then
 * where it is), who holds it, the actions that make sense there, the hosts on the tile and what
 * is happening; the rest (ring, terrain, relations) behind a fold.
 */
export function render(FS, terrainOf, activities = null) {
  const m = inspectModel(FS, terrainOf);
  if (!m) return html`<section class="inspect" aria-labelledby="inspect-title">${cardHead({ id: 'inspect-title', ic: 'eye', title: L`選択` })}<p class="muted">${L`地図のマスを選ぶと、そこにあるものがここに出ます。`}</p></section>`;
  const t = m.tile, site = t?.site;
  // a name before coordinates (UX design 5.3): the village, the camp or the land, then where it is
  const terrain = t?.terrain ? (TERRAIN_TEXT[t.terrain]?.() ?? t.terrain) : null;
  const held = site?.state === 'holding';
  const s1 = t?.s1?.[0] ?? null;
  // (a conquest season: the tile the province's keep stands on is that keep, by its holder — a spectator who pressed the
  // castle on the map read 「森」 as the card's name, and found the keep only in the plate further down)
  const keep = conquestEnabled(FS) && !territoryEnabled(FS) ? keepFor(FS, m.p, m.q) : null;
  const keepHere = !!keep && !!t && Number.isInteger(keep.tile) && keep.tile !== 255 && keep.tile === t.idx && !held && !t.camp;
  const keepName = keepHere ? (Number(keep.holder) < 6 ? L`${factionName(Number(keep.holder))}の砦` : L`この州の砦`) : null;
  const name = held ? holdingName({ p: m.p, q: m.q, site: site.index }, site.tier ?? 0) : t?.camp ? SITE_TEXT.camp() : keepName ?? (site && site.state !== 'free' ? SITE_TEXT[site.state]() : s1 ? S1_WORDS[s1.kind]?.() ?? terrain : terrain);
  // under the name: what the land is, then where it is in words (the province by a village of the viewer's or by the
  // nation on whose side it lies; a village is itself the place: nothing more is said); the coordinates wait under
  // "details" (UX design 11.13)
  const where = [name && terrain && name !== terrain ? terrain : null, site && site.state === 'free' ? SITE_TEXT.free() : null, t && !held ? provinceName(FS, m.p, m.q) : null].filter(Boolean).join(' · ');
  const mark = held ? 'home' : t?.camp ? 'tent' : keepHere ? 'flag' : t?.hosts?.length ? 'sword' : s1 ? 'shield' : t ? 'mountain' : 'chart';
  const side = site?.mine ? chip(L`あなたの村`, 'you') : held ? chip(html`${raw(leaderHex(site.faction, { size: 30 }))}${swatch(site.faction)}${factionName(site.faction)}`) : t?.camp ? chip(L`${fmtNum(t.camp.troops)} 兵`, 'bad')
    : s1 ? (s1.own ? chip(L`あなたのもの`, 'you') : chip(html`${swatch(s1.faction)}${factionName(s1.faction)}`)) : '';
  const chips = [];
  if ((held || site?.state === 'freeCity') && site.garrison !== null) chips.push(chip(L`守備隊 ${fmtNum(site.garrison)}`, '', 'shield'));
  if (site?.shield) chips.push(html`${chip(L`保護中（攻撃されません）`, 'info', 'shield')}`);
  if (m.clash) chips.push(chip(L`このターンに衝突あり`, 'bad', 'swords'));
  // (walletless demo, demo-npc-camps: a bandit camp's loot, by the world record's rule — web/frontier/democamps.mjs)
  const campRule = t?.camp ? campsOn(FS) : null;
  if (campRule) { const x = lootOf(t.camp.troops, campRule); chips.push(chip(L`倒すと戦利品：食料 ${fmtNum(x.food)}・鉱石 ${fmtNum(x.ore)}・金 ${fmtNum(x.gold)}`, 'ok', 'check')); }
  // every chip explains itself (UX design 12.6; the second check: the viewer's own village carried 「シンダー 敵対」 with
  // nothing to say whose stance toward whom). On another nation's village the chip says how that nation stands toward
  // the viewer's; how the other nations of the province stand is a fact of the province and waits under "details".
  const stance = r => (r.friendly ? L`あなたの国と友好` : L`あなたの国と敵対`);
  const theirs = held && !site.mine ? m.relation.find(r => r.faction === site.faction) ?? null : null;
  if (theirs) chips.push(chip(stance(theirs), theirs.friendly ? 'ok' : 'bad', theirs.friendly ? 'check' : 'swords'));
  for (const line of landTileLines(t?.land ?? null, { viewer: FS.citizen?.faction ?? null, nameOf: factionName })) chips.push(chip(line.text, line.tone, 'banner'));
  if (t?.territory) chips.push(chip(t.territory.owner === null ? L`どの国の領地でもありません` : t.territory.owner === FS.citizen?.faction ? L`あなたの国の領地` : L`${factionName(t.territory.owner)}の領地`, t.territory.owner === FS.citizen?.faction ? 'you' : '', 'banner'));
  // (a keep's holder, garrison and contest are the season's public record: the control snapshot and the reach list already
  // say them of every province, surveyed or not, so the panel stands for any province the player goes to: "go there" from
  // the reach list leads to the keep and its march button, not to a card that only says "unsurveyed")
  // (loop-play4 B-9: a province where the viewer holds a wide village — a wide-bound slot of its own inventory, never one
  //  of FS.holdings — says so, and opens that village; before, its sigil only named the province and its ring)
  const ownWide = wideSlots(FS).find(e => e.holding && String(e.holding.p) === String(m.p) && String(e.holding.q) === String(m.q)) ?? null;
  if (ownWide) chips.push(chip(L`あなたの村（広い土地）`, 'you', 'home'));
  const keepVisible = !!keep;
  const acts = inspectActions(FS, m);
  if (ownWide) acts.unshift({ act: 'wide-select', data: { slot: ownWide.inventorySlot }, text: L`この村を開く`, primary: true });
  const main = acts.filter(a => a.act !== 'pin-toggle'), pin = acts.find(a => a.act === 'pin-toggle');
  const btn = (a, cls = '') => html`<button type="button" class="btn small${a.primary ? ' primary' : ''}${cls}" data-act="${a.act}" ${dataAttrs(a.data)}>${a.text}</button>`;
  const hosts = t?.hosts?.length ? html`${label(L`このマスの軍勢`)}<ul class="list insp-hosts">${t.hosts.map(h => html`<li class="host-row">${h.unit ? html`<img class="unit-card small f${h.faction}" src="${miniCardUrl(h.faction, h.unit.toLowerCase())}" alt="" width="32" height="40" loading="lazy" decoding="async">` : ''}<span class="host-what"><strong>${unitCount(h.unit, h.troops)}</strong>${h.pending ? html` <span class="muted">${L`（次のターンから）`}</span>` : ''}<span class="host-of">${h.owner ? personChip(h.owner, h.faction, { size: 30, own: isOwnIdentity(FS, h.owner) }) : html`${swatch(h.faction)}${factionName(h.faction)}`}</span></span></li>`)}</ul>` : '';
  const now = t ? (activities?.get(`${m.p},${m.q},${t.idx}`) ?? []).filter((a, i, all) => all.findIndex(b => b.kind === a.kind) === i) : [];
  const who = hostInfoOf(FS);
  const doing = now.length ? html`${label(L`いまの様子`)}<ul class="list doing">${now.map(a => html`<li class="doing-${a.kind}">${activityText(a, who)}</li>`)}</ul>` : '';
  const facts = [];
  // (the label is "position": in English "Ring" beside "Ring 2" read as a doubled word); the coordinates stand here and nowhere above
  facts.push(html`<div class="row"><dt>${L`位置`}</dt><dd>${provinceCoords(m.p, m.q)} · ${m.wide ? wideRingText(m.ring) : ringText(m.place, m.ring)}${termButton('ring')}</dd></div>`);
  if (terrain) facts.push(html`<div class="row"><dt>${L`地形`}</dt><dd>${terrain}</dd></div>`);
  if (m.relation.length) facts.push(html`<div class="row"><dt>${L`この州に村を持つほかの国`}</dt><dd>${m.relation.map(r => html`<span class="nowrap">${swatch(r.faction)}${r.friendly ? L`${factionName(r.faction)}（あなたの国と友好）` : L`${factionName(r.faction)}（あなたの国と敵対）`}</span> `)}</dd></div>`);
  if (!t && m.owners.length) facts.push(html`<div class="row"><dt>${L`村を持つ国`}</dt><dd>${m.owners.map(f => html`<span class="nowrap">${swatch(f)}${factionName(f)}</span> `)}</dd></div>`);
  return html`<section class="inspect" aria-labelledby="inspect-title">
    ${cardHead({ id: 'inspect-title', ic: mark, pic: held ? villageDrawn(site.faction, site.tier ?? 0) : null, title: name ?? provinceName(FS, m.p, m.q), sub: name ? where : m.wide ? wideRingText(m.ring) : ringText(m.place, m.ring), side })}
    ${site?.owner ? html`<p class="inspect-owner">${personChip(site.owner, site.faction, { size: 44, full: true, own: !!site.mine, note: L`この村の領主` })}</p>` : ''}
    ${chips.length ? html`<p class="fact-chips">${chips}</p>` : ''}
    ${m.opened && m.level < 3 ? html`<p class="insp-survey">${chip(m.level === 2 ? L`測量済み` : L`未測量`, '', 'chart')}<span class="muted">${m.level === 2 ? L`前に見た範囲です。土地と村を、色を落として描きます。` : L`まだ見ていない範囲です。地形だけを図にしています。`}</span></p>` : ''}
    ${main.length ? html`<div class="actions insp-acts">${main.map((a, i) => btn({ ...a, primary: a.primary && i === main.findIndex(x => x.primary) }))}</div>` : ''}
    ${hosts}${doing}
    ${s1On() && FS.mode === 'play' && t && (m.level === 3 || ownHostsOn(FS, m.p, m.q, t.idx).length || raidOffers(FS).some(r => r.p === m.p && r.q === m.q && r.tile === t.idx)) ? renderS1Tile(FS, { p: m.p, q: m.q, idx: t.idx }) : ''}
    ${keepVisible && m.ring >= 2 ? renderKeep(FS, keep) : ''}
    ${site?.state === 'free' && m.level === 3 && !territoryEnabled(FS) ? renderOutpost(FS, { p: m.p, q: m.q, site: site.index }) : ''}
    ${readState(m)}
    ${fold('i-more', L`くわしく`, html`<dl class="facts">${facts}</dl>${pin ? html`<div class="actions">${html`<button type="button" class="btn small" data-act="${pin.act}" ${dataAttrs(pin.data)}>${icon('pin')}${pin.text}</button>`}</div>` : ''}`)}
  </section>`;
}
