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
import { UNIT_ORDER } from '../fland.mjs';
import { miniCardUrl } from '../people/minis.mjs';
import { ringOf } from '../fgeo.mjs';
import { troopsOf } from '../fmarch.mjs';
import { swatch } from '../screens/shell.mjs';
import { personChip, hostOwner, holdingName } from '../people/ui.mjs';
import { leaderHex } from '../people/leaders.mjs';
import { identityOf, displayName } from '../people/identity.mjs';
import { hostParts } from '../faddr.mjs';
import { activityText } from '../people/activity.mjs';
import { hostRows } from '../screens/host.mjs';
import { hasPin } from './pins.mjs';
import { termButton } from './glossary.mjs';
import { placeName, placeWhere } from '../map/names.mjs';
import { TERRAIN_TEXT, villageDrawn, provinceName, provinceCoords, tileName } from './place.mjs';
import { unpack } from '../seal.mjs';
import { materialBytes } from '../marchbook.mjs';
import { cardHead, chip, fold, label } from '../screens/parts.mjs';

/** Site states as the overview carries them (herald SITE_STATE) and the mirror (3 = released: a Free City). */
const SITE_TEXT = { free: () => L`村を置ける場所`, holding: () => L`村`, camp: () => L`蛮族の野営地`, reserved: () => L`予約済みの場所`, freeCity: () => L`自由都市` };

const overviewRec = (FS, p, q) => {
  for (const o of FS.overviews?.values?.() ?? []) {
    const r = o.provinces?.find(x => x.p === p && x.q === q);
    // (the clash flag speaks of the overview's own bell: an overview older than the last bell says nothing about now)
    if (r) return r.clash && Number.isInteger(o.bell) && Number.isInteger(FS.nowBell) && o.bell < FS.nowBell - 1 ? { ...r, clash: false } : r;
  }
  return null;
};

/** Whether factions a and b are not hostile in a province (RELATIONS bit a*8+b). */
export const friendly = (relations, a, b) => a === b || (relations !== undefined && relations !== null && ((BigInt(relations) >> BigInt(a * 8 + b)) & 1n) === 1n);

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
  const out = { p: s.p, q: s.q, ring: ringOf(s.p, s.q), opened: !!rec, owners, clash: !!rec?.clash && top === 3, loaded: !!prov, level: Number.isInteger(s.idx) ? lv(s.idx) : top,
    relation: Number.isInteger(viewer) && prov ? owners.filter(f => f !== viewer).map(f => ({ faction: f, friendly: friendly(prov.relations, viewer, f) })) : [],
    reportBell: top === 3 ? prov?.resolveSummary?.bell || null : null, tile: null };
  if (!Number.isInteger(s.idx)) return out;
  const here = out.level;
  const j = t ? t.sites.indexOf(s.idx) : prov ? Array.from(prov.sites ?? []).indexOf(s.idx) : -1;
  const tile = { idx: s.idx, terrain: t ? t.names[t.terrain[s.idx]] : null, site: null, hosts: [], camp: null };
  if (j >= 0 && here >= 2) {
    const m = here === 3 ? prov?.siteMirror?.[j] : null;
    const state = m ? (m.state === 3 ? 'freeCity' : ['free', 'holding', 'camp', 'free', 'reserved'][m.state] ?? 'free') : ['free', 'holding', 'camp', 'reserved'][rec?.sites?.[j] ?? 0];
    const faction = m ? m.faction : rec?.owners?.[j];
    const mine = (FS.holdings ?? []).find(h => h.p === s.p && h.q === s.q && h.site === j) ?? null;
    const holder = state === 'holding' ? FS.roster?.ownerOf(s.p, s.q, j) ?? null : null;
    tile.site = { index: j, state, faction: state === 'holding' ? faction : null, owner: holder ? identityOf(holder.tag) : null, tier: m?.tier ?? (state === 'holding' ? FS.roster?.tierOf?.(s.p, s.q, j) ?? null : null), garrison: m ? troopsOf(m.garrison) : null,
      shield: m ? m.shieldUntilBell > (FS.nowBell ?? 0) : false, mine: !!mine, holdingIndex: mine ? FS.holdings.indexOf(mine) : -1 };
  }
  for (const e of prov?.entries ?? []) {
    if (e.tile !== s.idx || (e.state !== 1 && e.state !== 2)) continue;
    if (here < 3 && !sv?.ownHosts?.has(String(e.id))) continue;   // other people's hosts: in sight only
    tile.hosts.push({ id: String(e.id), faction: e.faction, owner: hostOwner(FS.roster, e.id), unit: UNIT_ORDER[e.unit] ?? null, troops: troopsOf(e.troops), pending: e.state === 2 });
  }
  // (a camp's troops are whole troops in the account, Camp.TROOPS: not the thousandths a host's are)
  if (here === 3 && prov?.camp?.state === 1 && prov.camp.tile === s.idx) tile.camp = { troops: Number(prov.camp.troops) };
  out.tile = tile;
  return out;
}

/** What a place `{p, q, tile}` is called and where it is (map/names.mjs): `{name, where}`, by the same rules as the selection. */
export function placeAt(FS, place, terrainOf = null) {
  const m = inspectModel({ ...FS, selected: { p: place.p, q: place.q, idx: place.tile } }, terrainOf);
  return { name: placeName(m), where: placeWhere(m) };
}

/** The viewer's hosts standing on a tile and able to march (state 1, not on the road): `[{id, troops, unit}]` (`unit` the kernel's name). */
export function ownHostsOn(FS, p, q, idx) {
  try { return hostRows(FS).filter(r => r.p === p && r.q === q && r.tile === idx && r.state === 1 && !r.inTransit && !r.pending).map(r => ({ id: String(r.id), troops: r.troops, unit: UNIT_ORDER[r.unit] ?? null })); } catch { return []; }
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
  if (FS.compose && t && !FS.compose.sending) out.push({ act: 'dest-from-map', data: {}, text: L`ここを進軍の行き先にする`, primary: true });
  // the viewer's own ready hosts on this tile can be sent from here (the march card then opens on the map)
  if (!FS.compose && t) for (const h of ownHostsOn(FS, m.p, m.q, t.idx)) out.push({ act: 'compose', data: { host: h.id, stay: 'map' }, text: L`${unitCount(h.unit, h.troops)} を進軍させる`, primary: true });
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
  const name = held ? holdingName({ p: m.p, q: m.q, site: site.index }, site.tier ?? 0) : t?.camp ? SITE_TEXT.camp() : site && site.state !== 'free' ? SITE_TEXT[site.state]() : terrain;
  // under the name: what the land is, then where it is in words (the province by a village of the viewer's or by the
  // nation on whose side it lies; a village is itself the place: nothing more is said); the coordinates wait under
  // "details" (UX design 11.13)
  const where = [name && terrain && name !== terrain ? terrain : null, site && site.state === 'free' ? SITE_TEXT.free() : null, t && !held ? provinceName(FS, m.p, m.q) : null].filter(Boolean).join(' · ');
  const mark = held ? 'home' : t?.camp ? 'tent' : t?.hosts?.length ? 'sword' : t ? 'mountain' : 'chart';
  const side = site?.mine ? chip(L`あなたの村`, 'you') : held ? chip(html`${raw(leaderHex(site.faction, { size: 22 }))}${swatch(site.faction)}${factionName(site.faction)}`) : t?.camp ? chip(L`${fmtNum(t.camp.troops)} 兵`, 'bad') : '';
  const chips = [];
  if (held && site.garrison !== null) chips.push(chip(L`守備隊 ${fmtNum(site.garrison)}`, '', 'shield'));
  if (site?.shield) chips.push(html`${chip(L`保護中（攻撃されません）`, 'info', 'shield')}`);
  if (m.clash) chips.push(chip(L`このターンに衝突あり`, 'bad', 'swords'));
  // every chip explains itself (UX design 12.6; the second check: the viewer's own village carried 「シンダー 敵対」 with
  // nothing to say whose stance toward whom). On another nation's village the chip says how that nation stands toward
  // the viewer's; how the other nations of the province stand is a fact of the province and waits under "details".
  const stance = r => (r.friendly ? L`あなたの国と友好` : L`あなたの国と敵対`);
  const theirs = held && !site.mine ? m.relation.find(r => r.faction === site.faction) ?? null : null;
  if (theirs) chips.push(chip(stance(theirs), theirs.friendly ? 'ok' : 'bad', theirs.friendly ? 'check' : 'swords'));
  const acts = inspectActions(FS, m);
  const main = acts.filter(a => a.act !== 'pin-toggle'), pin = acts.find(a => a.act === 'pin-toggle');
  const btn = (a, cls = '') => html`<button type="button" class="btn small${a.primary ? ' primary' : ''}${cls}" data-act="${a.act}" ${dataAttrs(a.data)}>${a.text}</button>`;
  const hosts = t?.hosts?.length ? html`${label(L`このマスの軍勢`)}<ul class="list insp-hosts">${t.hosts.map(h => html`<li class="host-row">${h.unit ? html`<img class="unit-card small f${h.faction}" src="${miniCardUrl(h.faction, h.unit.toLowerCase())}" alt="" width="32" height="40" loading="lazy" decoding="async">` : ''}<span class="host-what"><strong>${unitCount(h.unit, h.troops)}</strong>${h.pending ? html` <span class="muted">${L`（次の鐘から）`}</span>` : ''}<span class="host-of">${h.owner ? personChip(h.owner, h.faction, { size: 20 }) : html`${swatch(h.faction)}${factionName(h.faction)}`}</span></span></li>`)}</ul>` : '';
  const now = t ? (activities?.get(`${m.p},${m.q},${t.idx}`) ?? []).filter((a, i, all) => all.findIndex(b => b.kind === a.kind) === i) : [];
  const who = hostInfoOf(FS);
  const doing = now.length ? html`${label(L`いまの様子`)}<ul class="list doing">${now.map(a => html`<li class="doing-${a.kind}">${activityText(a, who)}</li>`)}</ul>` : '';
  const facts = [];
  // (the label is "position": in English "Ring" beside "Ring 2" read as a doubled word); the coordinates stand here and nowhere above
  facts.push(html`<div class="row"><dt>${L`位置`}</dt><dd>${provinceCoords(m.p, m.q)} · ${m.opened ? L`第${m.ring}輪` : L`第${m.ring}輪（まだひらいていません）`}${termButton('ring')}</dd></div>`);
  if (terrain) facts.push(html`<div class="row"><dt>${L`地形`}</dt><dd>${terrain}</dd></div>`);
  if (m.relation.length) facts.push(html`<div class="row"><dt>${L`この州に村を持つほかの国`}</dt><dd>${m.relation.map(r => html`<span class="nowrap">${swatch(r.faction)}${r.friendly ? L`${factionName(r.faction)}（あなたの国と友好）` : L`${factionName(r.faction)}（あなたの国と敵対）`}</span> `)}</dd></div>`);
  if (!t && m.owners.length) facts.push(html`<div class="row"><dt>${L`村を持つ国`}</dt><dd>${m.owners.map(f => html`<span class="nowrap">${swatch(f)}${factionName(f)}</span> `)}</dd></div>`);
  return html`<section class="inspect" aria-labelledby="inspect-title">
    ${cardHead({ id: 'inspect-title', ic: mark, pic: held ? villageDrawn(site.faction, site.tier ?? 0) : null, title: name ?? provinceName(FS, m.p, m.q), sub: name ? where : (m.opened ? L`第${m.ring}輪` : L`第${m.ring}輪（まだひらいていません）`), side })}
    ${site?.owner ? html`<p class="inspect-owner">${personChip(site.owner, site.faction, { size: 36, full: true, note: L`この村の領主` })}</p>` : ''}
    ${chips.length ? html`<p class="fact-chips">${chips}</p>` : ''}
    ${m.opened && m.level < 3 ? html`<p class="insp-survey">${chip(m.level === 2 ? L`測量済み` : L`未測量`, '', 'chart')}<span class="muted">${m.level === 2 ? L`前に見た範囲です。土地と村を、色を落として描きます。` : L`まだ見ていない範囲です。地形だけを図にしています。`}</span></p>` : ''}
    ${main.length ? html`<div class="actions insp-acts">${main.map((a, i) => btn({ ...a, primary: a.primary && i === main.findIndex(x => x.primary) }))}</div>` : ''}
    ${hosts}${doing}
    ${!m.loaded && m.opened ? html`<p class="muted">${L`この州のようすを読み込んでいます…`}</p>` : ''}
    ${fold('i-more', L`くわしく`, html`<dl class="facts">${facts}</dl>${pin ? html`<div class="actions">${html`<button type="button" class="btn small" data-act="${pin.act}" ${dataAttrs(pin.data)}>${icon('pin')}${pin.text}</button>`}</div>` : ''}`)}
  </section>`;
}
