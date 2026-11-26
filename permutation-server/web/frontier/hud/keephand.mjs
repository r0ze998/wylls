// The hand on a conquest season (program version 3: every province from ring
// 2 outward has a KEEP; a hostile host that holds a keep's tile for 72
// consecutive turns takes the province for its nation).
//
//   the host's bar   「砦へ進軍」 opens the list of the keeps THIS host can reach:
//                    province, holder (crest and colour), recorded defenders,
//                    the earliest arrival turn, the turns to hold. A row under
//                    the pointer lights its keep on the board; choosing a row
//                    (or a lit keep) opens the order card with the keep as the
//                    destination. Nothing is sent before 「封をして出発する」.
//   the waits        a combat host that cannot depart yet says why and from
//                    which turn (forming, the province settling its turn,
//                    resting, short of stamina, on the march): the keep panel
//                    and the reach list never end in "no host" while one is
//                    on its way to being ready.
//   small parts      a nation's crest chip, a signature printed short with a
//                    copy key, the row of turns held.
//
// Pure: models from the store, markup from the models. Every figure is the
// record's (the control snapshot's keeps, the province the page holds, the
// rules kernel's route); app.mjs lights the board and turns `data-act` into
// the page's own orders (`cq-march` → the composer; controller.mjs).
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName, unitCount, clientText } from '../fi18n.mjs';
import { UNIT_ORDER, SCOUT, SETTLER, actionBlocks } from '../fland.mjs';
import { DEPART_STAMINA, DEPART_MARGIN_SECS, arrivalWindow, earliestBell, arrivalStamina, ENGAGE_STAMINA } from '../fmarch.mjs';
import { activeHolding } from '../fstate.mjs';
import { hostRows } from '../screens/host.mjs';
import { sigilPath, FACTION_FILL, FACTION_DARK, FACTION_ON } from '../people/avatar.mjs';
import { icon } from './icons.mjs';
import { provinceName, provinceCoords } from './place.mjs';
import { whyText } from './orderparts.mjs';
import { keepArrival, ROUGH_TERRAIN } from './rulebook.mjs';
import { formingLine } from './firststeps.mjs';
import { contestableKeeps, defendableKeeps } from '../fkeepreach.mjs';
import { fogNow, viewKeeps } from '../map/fog.mjs';
import { turnsLine } from '../seasonterms.mjs';

const int = Number.isInteger;
const nation = f => int(f) && f >= 0 && f <= 5;
/** A conquest season on a chain: program version 3 or more, and not the sample world (which draws exactly what it drew: no keep is offered there). */
export const conquestOn = FS => Number(FS?.season?.programVersion ?? 0) >= 3 && !FS?.sample;
/**
 * Whether the world's keeps have been read and NONE is one the viewer's nation could take (`contestableKeeps`, the reach
 * list's own rule at the page's turn: another nation's, not in a heartland — a heartland keep never counts —, not under
 * its post-capture protection). Then the
 * fort march and its "N turns to take" are not offered: a world opened only to the heartlands has nothing to take.
 * Before the keeps are read nothing changes.
 */
export const noContestableKeep = FS => {
  const keeps = FS?.conquest?.keeps;
  // (nothing read yet, or the page's turn unknown: nothing is hidden. The turn is the one the reach list is asked with,
  //  `FS.nowBell`: a keep under its post-capture protection counts again once that turn passes)
  if (!(keeps instanceof Map) || keeps.size === 0 || !Number.isInteger(FS?.nowBell)) return false;
  // (a keep of the viewer's own nation that another nation is contesting is one to go and defend: the list is offered for it)
  const all = [...keeps.values()], faction = FS?.citizen?.faction;
  return contestableKeeps(all, { faction, nowBell: FS.nowBell }).length === 0 && defendableKeeps(all, { faction }).length === 0;
};
/**
 * Whether the world's keeps have been read and EVERY one stands in a heartland (where a keep never counts): a world opened
 * only to the heartlands, with nothing to take at all — the capture guide is not shown there. A keep outside a heartland
 * (taken, protected or contestable) keeps the guide. An empty or unread map hides nothing.
 * (fix-loop7, LP7-2: "read" means the world's control snapshot — `FS.conquest.control` — has come. Before it, the keeps
 *  the page holds are only those of the provinces it read for itself: the home province and its neighbours, all in the
 *  viewer's heartland. In a kept 1x world the first snapshot comes turns later (a fresh world has none until its first
 *  turn settles, and the herald's lags the turn), and the guide pill was hidden all that time — 「ガイド 3/7」 never
 *  showed during the first build, training and muster.)
 */
export const heartlandOnlyKeeps = FS => {
  const keeps = FS?.conquest?.keeps;
  if (!FS?.conquest?.control) return false;
  return keeps instanceof Map && keeps.size > 0 && [...keeps.values()].every(k => !!k?.heartland);
};
/** The turns a hostile host must hold a keep's tile (the season's parameter; the record's own figure where a keep carries one). */
export const holdTurns = (FS, keep = null) => {
  const k = Number(keep?.requiredBells ?? keep?.required), s = Number(FS?.season?.conquestParams?.keepBells);
  return Number.isFinite(k) && k > 0 ? k : Number.isFinite(s) && s > 0 ? s : 72;
};

// ------------------------------------------------------------------ small parts
/** A nation's crest (its sigil on a shield in its colour: the sigil carries the identity, never the colour alone). Presentation attributes only (CSP). */
export function crest(faction, size = 22) {
  const f = nation(faction) ? faction : null;
  const fill = f === null ? '#8a8a80' : FACTION_FILL[f], dark = f === null ? '#55554e' : FACTION_DARK[f];
  return raw(`<svg class="kh-crest" viewBox="0 0 24 28" width="${Math.round(size * 24 / 28)}" height="${size}" aria-hidden="true" focusable="false"><path d="M12 1.2l9.6 2.9v9.9c0 5.8-3.9 9.8-9.6 12.6C6.3 23.8 2.4 19.8 2.4 14V4.1Z" fill="${fill}" stroke="#f0d48a" stroke-width="1.3" stroke-linejoin="round"/><g transform="translate(12 12.6)"><path d="${sigilPath(f ?? 6, 5)}" fill="${f === null ? '#fffaf0' : FACTION_ON[f]}" stroke="${dark}" stroke-width=".7"/></g></svg>`);
}
/** A nation by its crest and name on a band of its colour (`kh-n0`…`kh-n5`, `kh-n6` neutral). */
export const nationChip = (f, { mine = false, size = 20 } = {}) => html`<span class="kh-nation kh-n${nation(f) ? f : 6}${mine ? ' kh-mine' : ''}">${crest(f, size)}<span class="kh-nation-name">${nation(f) ? factionName(f) : L`中立`}</span>${mine ? html`<span class="kh-you">${L`あなたの国`}</span>` : ''}</span>`;

/** A transaction signature printed short (first 8 … last 6): the whole of it is the title and what the copy key copies. */
export const shortSig = s => { const t = String(s ?? ''); return t.length > 18 ? `${t.slice(0, 8)}…${t.slice(-6)}` : t; };
export function sigChip(sig, { label = null } = {}) {
  const s = typeof sig === 'string' && /^[1-9A-HJ-NP-Za-km-z]{8,100}$/.test(sig) ? sig : null;
  if (!s) return '';
  return html`<span class="kh-sig">${label ? html`<span class="kh-sig-k">${label}</span>` : ''}<code title="${s}">${shortSig(s)}</code><button type="button" class="kh-copy" data-act="kh-copy" data-copy="${s}" aria-label="${L`署名をコピー`}" title="${L`署名をコピー`}"><span class="kh-copy-t">${L`コピー`}</span></button></span>`;
}

// ------------------------------------------------------------------ the waits
/**
 * Why a combat host of the viewer cannot depart now, with the turn from which it can when the rule names one:
 * `{why: 'march' | 'forming' | 'settling' | 'resting' | 'stamina' | 'blocked', turn (or null), nudge?, code?}`;
 * null for a host that can depart.
 *   forming   mustered this turn: it stands from `fromBell`
 *   settling  the turn has changed and the province's record of the last turn is not settled yet (a quiet
 *             province settles late): the host is in the record of the turn before. It departs once the
 *             province has caught up, which any order there, or 「州の処理を進める」, brings about.
 */
export function waitOf(FS, r) {
  const bell = FS.nowBell ?? 0;
  if (!r) return null;
  if (r.inTransit || r.state === 3) {
    // (fix-loop7, LP7-6: past its arrival turn the march's result is out — the page has shown it — but the village's
    //  transit record stays open until the program settles it (SettleTransit): the host still may not depart
    //  (HostInTransit). 「結果を受け取ると、また出発できます」 read as a step left to the player who had just received it)
    let t = null;
    try { t = (activeHolding(FS)?.transit ?? []).find(x => x.state >= 1 && x.state <= 3 && BigInt(x.hostId) === BigInt(r.id)) ?? null; } catch { t = null; }
    const arrive = Number(t?.arriveBell);
    return { why: 'march', turn: null, arrive: Number.isInteger(arrive) && arrive > 0 ? arrive : null, arrived: Number.isInteger(arrive) && arrive > 0 && bell > arrive };
  }
  const behind = !r.province || Number(r.province.resolvedNext) + 1 < bell;
  if (r.state === 2) {
    const from = int(r.fromBell) && r.fromBell > 0 ? r.fromBell : null;
    return from !== null && from > bell ? { why: 'forming', turn: from } : { why: 'settling', turn: bell, nudge: true };
  }
  if (r.state !== 1) return null;
  const blocks = actionBlocks('Depart', { holding: activeHolding(FS), province: r.province, now: FS.chain?.now?.() ?? 0, nowBell: bell, host: r });
  if (blocks.includes('NotResident') || behind) return { why: 'settling', turn: bell, nudge: true };
  if (blocks.length) return { why: 'blocked', turn: null, code: blocks[0] };
  if (bell < r.readyBell) return { why: 'resting', turn: r.readyBell };
  if (r.stamina < DEPART_STAMINA) return { why: 'stamina', turn: Math.max(bell + DEPART_STAMINA - r.stamina, r.readyBell ?? 0), stamina: r.stamina };
  return null;
}

/** Whether a fort may be chosen (the order card opened) while the host waits: no wait, or only its province finishing the
 *  previous turn (`settling`) for a host already formed (state 1). Choosing sends nothing; the order card holds the seal.
 *  A host still forming (state 2) is never chosen: the order card keeps the host as it was when opened, so it would stay
 *  busy (HostBusy) and could never be sealed. */
export const choosableWait = (w, r) => !w || (w.why === 'settling' && r?.state === 1);

/** The viewer's combat hosts that cannot depart now, soonest first: `[{id, unit, troops, p, q, tile, why, turn, nudge?}]`. */
export function hostWaits(FS) {
  const out = [];
  let rows = [];
  try { rows = hostRows(FS); } catch { rows = []; }
  for (const r of rows) {
    if (r.unit === SCOUT || r.unit === SETTLER) continue;
    const w = waitOf(FS, r);
    if (w) out.push({ id: String(r.id), unit: r.unit, troops: r.troops, p: r.p, q: r.q, tile: r.tile, ...w });
  }
  const rank = { settling: 0, forming: 1, resting: 2, stamina: 3, blocked: 4, march: 5 };
  return out.sort((a, b) => rank[a.why] - rank[b.why] || (a.turn ?? Infinity) - (b.turn ?? Infinity));
}

/** The viewer's fighting hosts that stand on tile `tile` of province (p, q), such as a keep's own tile: `[{id, unit, troops}]`. */
export function hostsOnTile(FS, p, q, tile) {
  let rows = [];
  try { rows = hostRows(FS); } catch { rows = []; }
  return rows.filter(r => r.unit !== SCOUT && r.unit !== SETTLER && !r.inTransit && r.state === 1 && r.p === p && r.q === q && r.tile === tile).map(r => ({ id: String(r.id), unit: r.unit, troops: r.troops }));
}
/** "Your host is holding this keep's tile: 486 Spearmen" (the keep panel, in place of an offer to send there the host that is there). */
export const holdingHereText = hosts => L`あなたの軍勢がこの砦のマスを保っています：${hosts.map(x => unitCount(UNIT_ORDER[x.unit], x.troops)).join(L`、`)}`;

/**
 * (round 20) The forts card's wait slot never grows shorter while the card stays open for one host at one width: after each
 * write of the card the slot's least height is the tallest it has been. The stand-in (round 19) holds the settling line's
 * height, but a host still forming says a longer line (its forming line from hud/firststeps.mjs, by phase), and when that line went
 * away as the host stood, the rows moved up by the difference (12 px at 1280 px in a recorded ×30 world) at the very moment
 * the row became pressable. Measured and set in the same task as the write, before the page is painted. Layout only.
 */
let slotHold = { key: null, h: 0 };
export function steadySlot(root, key) {
  const slot = root?.querySelector?.('.kh-wait-slot');
  if (!slot) { slotHold = { key: null, h: 0 }; return; }
  if (slotHold.key !== key) slotHold = { key, h: 0 };
  slot.style.minHeight = '';
  slotHold.h = Math.max(slotHold.h, Math.ceil(slot.getBoundingClientRect().height));
  slot.style.minHeight = `${slotHold.h}px`;
}

/** A wait in one sentence, naming the host: what it is doing and the turn from which it can depart. With `FS`, a host still
 * forming (state 2) says where its muster turn really is (hud/firststeps.mjs), not a turn it may not be ready by. */
export function waitText(w, FS = null) {
  const who = unitCount(UNIT_ORDER[w.unit], w.troops);
  if (FS && (w.why === 'forming' || w.why === 'settling')) {
    let row = null;
    try { row = hostRows(FS).find(r => String(r.id) === String(w.id) && r.state === 2) ?? null; } catch { row = null; }
    if (row) return formingLine(FS, row);
  }
  switch (w.why) {
    case 'forming': return L`${who} は編成中です。ターン ${fmtNum(w.turn)} から出発できます。`;
    case 'settling': return L`${who} のいる州が、ターンの処理を進めています。処理が済むと、このターン（ターン ${fmtNum(w.turn)}）から出発できます。`;
    case 'resting': return L`${who} は休息中です。ターン ${fmtNum(w.turn)} から出発できます。`;
    case 'stamina': return L`${who} は体力が足りません（${fmtNum(w.stamina)}/${fmtNum(DEPART_STAMINA)}）。ターン ${fmtNum(w.turn)} から出発できます。`;
    case 'march': return w.arrived
      ? L`${who} の進軍は到着のターン ${fmtNum(w.arrive)} を過ぎ、結果が出ています。村の記録で進軍の締めくくり（決着の反映）が済むと、また出発できます。このページが自動で読み直します。`
      : L`${who} は進軍に出ています。結果を受け取ると、また出発できます。`;
    default: return L`${who} はいま出発できません：${whyText(w.code)}`;
  }
}

/**
 * The waits as lines (the keep panel and the reach list, in place of "no host is ready"): each host with its
 * sentence; a province that has not settled offers the one press that settles it (`nudge`), and every line
 * leads to the host on the board.
 */
export function renderWaits(FS, waits = hostWaits(FS), { max = 3 } = {}) {
  if (!waits.length) return '';
  const busy = FS.inFlight > 0 || !!FS.homeActionBusy;
  return html`<ul class="kh-waits" role="status">${waits.slice(0, max).map(w => html`<li class="kh-wait kh-wait-${w.why}">${icon(w.why === 'march' ? 'march' : 'hourglass')}<span class="kh-wait-t">${waitText(w, FS)}</span>
    ${w.nudge && !FS.localPlay ? html`<button type="button" class="btn small" data-act="nudge" data-p="${w.p}" data-q="${w.q}" ${raw(busy ? 'disabled' : '')}>${L`この州の処理を進める`}</button>` : ''}</li>`)}</ul>`;
}

// ------------------------------------------------------------------ the keeps this host can reach
/** The earliest turn a march of `secs` seconds can arrive on, leaving now (the composer's own rule; null without a clock). */
export function arrivalTurn(FS, secs) {
  if (!FS.season || !Number.isFinite(secs)) return null;
  const bell = FS.nowBell ?? 0, now = FS.chain?.now?.() ?? null;
  let earliest = null;
  try { earliest = FS.clock && FS.kernel && now !== null ? earliestBell(FS.kernel, { genesisTs: FS.clock.genesisTs, departTs: now + DEPART_MARGIN_SECS, secs }) : null; } catch { earliest = null; }
  const min = arrivalWindow(FS.season, bell, earliest).min;
  return Number.isFinite(min) ? min : null;
}

/** Whether a tile is forest or hills (the defender's terrain modifier); true when the terrain is not known yet, so the estimate errs on the keep's side. */
export function roughAt(FS, p, q, tile) {
  try {
    const t = FS?.terrainOf?.(p, q) ?? null;
    const name = t && Number.isInteger(tile) ? t.names?.[t.terrain?.[tile]] : null;
    return name ? ROUGH_TERRAIN.has(name) : true;
  } catch { return true; }
}

/**
 * How the arrival of host `r` on a keep of `troops` defenders on tile (p, q, tile) would go (rulebook.mjs
 * keepArrival), or null when the keep's defenders or the host are not known.
 */
export function arrivalOdds(FS, r, { p, q, tile, troops, arrive = null }) {
  if (!r || !Number.isFinite(troops) || !Number.isFinite(Number(r.troops))) return null;
  // (fix-loop22, LP22-4: other nations' hosts the viewer SEES on the keep's tile fight there too; the estimate below is
  //  the keep's garrison alone and cannot weigh them — the row says so and leaves the odds to the order card's forecast,
  //  the rules' own run. The list said "50 defenders · Good" of a keep whose tile Ember's 289 held: the march retreated)
  const hosts = hostsSeenOnTile(FS, p, q, tile);
  if (hosts.length) return { odds: 'hosts', hosts, need: null, worst: null, best: null };
  // (and the stamina the host arrives with, as the chain counts it — hud/forecast.mjs arrivalStamina: under 20 it strikes exhausted)
  const bell = FS.nowBell ?? 0;
  const ent = Number.isFinite(Number(r.staminaValue)) ? r : Number.isFinite(Number(r.entry?.staminaValue)) ? r.entry : Number.isFinite(Number(r.stamina)) ? { staminaValue: Number(r.stamina), staminaBell: bell } : null;
  const stam = Number.isInteger(arrive) && ent ? arrivalStamina(ent, bell, arrive) : null;
  const tired = stam !== null && stam < ENGAGE_STAMINA;
  return { ...keepArrival({ unit: r.unit, troops: Math.floor(Number(r.troops)), keepTroops: troops, rough: roughAt(FS, p, q, tile), tired }), tired, stamina: stam };
}

/**
 * (fix-loop22) Other nations' hosts standing on tile (p, q, tile) in the province record the page holds, ONLY when the
 * viewer has that tile in sight (the order card's own reading of sight, hud/marchcard.mjs): `[{faction, troops}]`.
 */
export function hostsSeenOnTile(FS, p, q, tile) {
  if (FS?.survey && !FS.survey.showAll && FS.survey.levelOf(p, q, tile) < 3) return [];
  const prov = FS?.provinces?.get?.(`${p},${q}`)?.province;
  if (!prov) return [];
  return (prov.entries ?? []).filter(e => e && e.state === 1 && e.tile === tile && e.faction !== FS.citizen?.faction)
    .map(e => ({ faction: e.faction, troops: Math.floor(Number(e.troops) / 1000) })).filter(e => e.troops > 0);
}

/** The odds in a word and the line under it: 「十分」 / 「五分」 / 「足りない」, and the troops it takes. */
export function oddsText(o, unit) {
  if (!o) return null;
  // (fix-loop22: hosts on the tile — the order card's forecast weighs them, this list cannot)
  if (o.odds === 'hosts') return { word: L`軍勢あり`, line: L`${o.hosts.map(h => `${factionName(h.faction)} ${fmtNum(h.troops)}`).join(L`、`)} がマスにいます。勝ち目は命令の予測で` };
  const word = o.odds === 'good' ? L`十分` : o.odds === 'even' ? L`五分` : L`足りない`;
  if (o.tired) return { word, line: L`疲れて着く（体力 ${fmtNum(o.stamina)}）。${o.odds === 'good' ? L`それでも残れる見込み` : L`体力を回復してから`}` };
  const line = o.odds === 'good' ? L`着いたターンに残れる見込み` : o.need ? L`${unitCount(UNIT_ORDER[unit], o.need)} 以上で十分` : L`この兵種では届かない`;
  return { word, line };
}

/**
 * The list of the host's bar: `{state: 'loading' | 'error' | 'ready', code?, wait (the host's own wait, or null),
 * rows: [{p, q, tile, holder, troops, name, coords, hexes, provinces, arrive, hold, contender, progress, key, odds}],
 * unreachable (a count)}` for the host `r` (a hand subject's host). `FS.conquest.hostReach` is the controller's
 * answer for this host (`wantHostReach`): the kernel's routes from the tile it stands on.
 */
export function keepsModel(FS, r) {
  const hr = FS.conquest?.hostReach;
  const wait = waitOf(FS, r);
  if (!hr || hr.host !== String(r?.id)) return { state: 'loading', wait, rows: [], unreachable: 0 };
  if (!hr.ok) return { state: 'error', code: hr.code, wait, rows: [], unreachable: 0 };
  // (fix-loop22, LP22-4: the keep as the page knows it NOW — the order card's own source, screens/conquest.mjs keepFor's
  //  fog-aware view — not the copy inside the reach answer, which is cached per host, turn and control snapshot: the list
  //  said "50 defenders" while the card said "0 recorded defenders" of the same keep)
  const keeps = viewKeeps(FS.conquest?.keeps);
  const rows = hr.rows.map(x => {
    const k = keeps?.get?.(`${x.p},${x.q}`) ?? x;
    const contender = nation(k.contender) ? k.contender : null;
    const troops = Number.isFinite(Number(k.troops)) && k.tile === x.tile ? Number(k.troops) : Number.isFinite(x.troops) ? x.troops : null;
    return { p: x.p, q: x.q, tile: x.tile, holder: x.holder, troops, name: provinceName(FS, x.p, x.q, { own: false }), coords: provinceCoords(x.p, x.q),
      hexes: x.route.hexes, provinces: x.route.provinces.length, secs: x.route.secs, arrive: arrivalTurn(FS, x.route.secs), hold: holdTurns(FS, k), contender, progress: contender === null ? null : Math.max(0, Number(k.progress ?? 0)), key: `${x.p},${x.q}`,
      // (a row of the viewer's own contested keep: going there defends it; the odds against its own garrison mean nothing)
      ...(x.defend ? { defend: true } : {}),
      odds: !x.defend && troops !== null ? arrivalOdds(FS, r, { p: x.p, q: x.q, tile: x.tile, troops, arrive: arrivalTurn(FS, x.route.secs) }) : null };
  });
  return { state: 'ready', wait, rows, unreachable: hr.unreachable.length };
}

/**
 * What the board is told to light while a fighting host has the hand (`map.setKeepReach`, in the board's own shape):
 * every row's keep, reachable, with the turn the card says the march would arrive on (none while the host cannot
 * depart yet: the card says the way in turns then); `hot` the one under the pointer.
 */
export const keepLights = (model, hot = null) => (model?.state === 'ready' ? model.rows.map(x => ({ p: x.p, q: x.q, tile: x.tile, arriveTurn: model.wait ? null : x.arrive, holder: x.holder, defenders: x.troops, troops: x.troops, reachable: true, why: null, hot: x.key === hot })) : []);

/** The card above the host's bar: the keeps it can reach, nearest first. */
export function renderKeepsPop(FS, model, { head }) {
  const r = model.host, km = keepsModel(FS, r);
  const who = model.name;
  const sub = km.state === 'ready' ? L`届く砦 ${fmtNum(km.rows.length)}` : '';
  // (a host that cannot depart yet: its rows wait, and the arrival is said as the turns the way takes, not as a turn it cannot make)
  // (2026-11-14: except while its province only finishes the previous turn — `settling` —: choosing a fort sends nothing, and
  //  the order card then holds its own seal; at ×60 that wait covered most of each turn and every press on a row was refused)
  const off = !choosableWait(km.wait, r);
  const odds = x => oddsText(x.odds, r.unit);
  const arriveSaid = x => (x.arrive === null || off ? '—' : fmtNum(x.arrive));
  const rowLabel = x => (x.defend
    ? L`${x.name}の砦を守りに向かう：${factionName(x.contender)}が占拠中 ${fmtNum(x.progress ?? 0)}/${fmtNum(x.hold)}、到着はターン ${arriveSaid(x)}`
    : L`${x.name}の砦へ進軍：${factionName(x.holder)}が保持、守備兵 ${x.troops === null ? '—' : fmtNum(x.troops)}、到着はターン ${arriveSaid(x)}` + (odds(x) ? L`、勝ち目 ${odds(x).word}（${odds(x).line}）` : ''));
  const row = x => html`<li><button type="button" class="kh-row kh-n${x.holder}${x.defend ? ' kh-row-defend' : ''}${off ? ' off' : ''}" data-act="cq-march" data-host="${r.id}" data-p="${x.p}" data-q="${x.q}" data-tile="${x.tile}" data-keep-row="${x.key}" ${raw(off ? 'aria-disabled="true"' : '')}
      aria-label="${rowLabel(x)}">
    <span class="kh-row-band" aria-hidden="true"></span>
    <span class="kh-row-where">${crest(x.holder, 26)}<span class="kh-row-names"><strong class="kh-row-name">${x.name}</strong><span class="kh-row-holder">${x.defend ? L`あなたの国が保持` : L`${factionName(x.holder)}が保持`} · <span class="kh-coords">${x.coords}</span></span></span></span>
    <span class="kh-fig kh-fig-def">${icon('shield')}<span class="kh-fig-v num">${x.troops === null ? '—' : fmtNum(x.troops)}</span><span class="kh-fig-k">${L`守備兵`}</span></span>
    ${x.defend ? html`<span class="kh-fig kh-fig-odds kh-odds-defend">${icon('shield')}<span class="kh-fig-v">${L`守りに向かう`}</span><span class="kh-fig-k">${L`マスに残れば占拠を止めます`}</span></span>`
      : html`<span class="kh-fig kh-fig-odds kh-odds-${x.odds?.odds ?? 'none'}">${icon('swords')}<span class="kh-fig-v">${odds(x)?.word ?? '—'}</span><span class="kh-fig-k">${odds(x)?.line ?? L`勝ち目`}</span></span>`}
    <span class="kh-fig kh-fig-arr">${icon('bell')}<span class="kh-fig-v num">${x.arrive === null ? '—' : off ? L`+${fmtNum(Math.max(1, x.arrive - (FS.nowBell ?? 0)))} ターン` : L`ターン ${fmtNum(x.arrive)}`}</span><span class="kh-fig-k">${L`到着（${fmtNum(x.hexes)} マス）`}</span></span>
    <span class="kh-fig kh-fig-hold">${icon('flag')}<span class="kh-fig-v num">${x.contender !== null ? `${fmtNum(x.progress)}/${fmtNum(x.hold)}` : fmtNum(x.hold)}</span><span class="kh-fig-k">${x.contender !== null ? L`${factionName(x.contender)}が占拠中` : L`ターン保てば奪取`}</span></span>
    <span class="kh-row-go" aria-hidden="true">${icon('next')}</span></button></li>`;
  // (fix-loop12, LP12-2: a fresh world has no control snapshot until its first turn's records are complete — at 1× a few
  //  minutes into turn 2 — and the list waits for it; said, so the wait is not read as stuck)
  const firstRecords = km.state === 'loading' && FS.conquest?.status === 'loading' && !FS.conquest?.control;
  const body = km.state === 'loading' ? html`<p class="pop-line kh-loading">${L`届く砦を調べています…`}</p>${firstRecords ? html`<p class="pop-line muted kh-first">${L`始まったばかりの世界では、最初のターンの決着がそろうまで（数分）届く砦の一覧は出ません。`}</p>` : ''}`
    : km.state === 'error' ? html`<p class="pop-line pop-why">${clientText(km.code)}</p>`
    : km.rows.length ? html`<ol class="kh-rows" aria-label="${L`${who}が届く砦`}">${km.rows.map(row)}</ol>`
    // (B9: keeps the page cannot place yet — a ring's village list not read — : the list is still being worked out)
    // (the fog of war of a local test world, map/fog.mjs: only keeps the viewer has seen are listed; nothing is "pending")
    // (fix-loop6, LP6-4: not a dead end — the next useful step: a march onto a tile of the map, seen or not, which this
    //  list cannot offer. Nothing of the unseen land is said: no keep, place or count)
    : fogNow().on ? html`<p class="pop-line">${L`見えている他国の砦で、この軍勢がいま届くものはありません。まだ見ていない土地の砦は表示しません。`}</p>
      <p class="pop-line kh-fog-next">${L`次の一手：「進軍」で地図のマスを押せば、まだ見ていない土地へも向かえます（着いたあたりが見えるようになります）。`}</p>
      <div class="pop-foot"><button type="button" class="btn small" data-act="hand-march" data-host="${r.id}">${L`進軍で地図から選ぶ`}</button></div>`
    : Number(FS.conquest?.keepsPending ?? 0) > 0 ? html`<p class="pop-line kh-loading">${L`届く砦を調べています…`}</p>`
    : html`<p class="pop-line">${L`この軍勢がいま届く他国の砦はありません。進軍が越えられるのは4州までです。`}</p>`;
  // the wait line (real), and its invisible stand-in: when nothing waits, the slot holds the settling line this host would
  // show, hidden and inert, so the card keeps the same height when the province's turn finishing comes and goes each half
  // turn (round 19: a browser measured the line at 113 px against the slot's 64 px least height — the rows still moved)
  // (round 24: the stand-in says the plain settling sentence, not looked up through the host's state — for a host still
  //  forming that look-up gives its forming line, which can be shorter: a live ×30 world at 1280 px showed the card grow by
  //  42 px, moving the rows, when the host stood while its province was still catching up)
  const waitLine = (w, ghost = false) => html`<p class="pop-line pop-why kh-wait-line">${icon('hourglass')}<span>${ghost ? waitText({ ...w, id: r.id, unit: r.unit, troops: r.troops }) : waitText({ ...w, id: r.id, unit: r.unit, troops: r.troops }, FS)}</span>${w.nudge && ghost ? html` <span class="btn small">${L`この州の処理を進める`}</span>` : ''}${w.nudge && !ghost && !FS.localPlay ? html` <button type="button" class="btn small" data-act="nudge" data-p="${r.p}" data-q="${r.q}">${L`この州の処理を進める`}</button>` : ''}</p>`;
  // (round 20: the stand-in is ALWAYS in the slot, in the same grid cell as the real line (conquest-hand.css), so the slot
  //  is as tall as the taller of the two whatever the line says; it is the same in every mode — its button is a plain span
  //  either way. A longer line than the stand-in — a forming host's — is held by steadySlot until the card closes.)
  // (the wait line stands BELOW the rows: above them it pushed the rows down each time it appeared and up when it went, and a
  //  press aimed at a row landed on the line or on the map; 2026-11-14. Round 16: it stands in a slot that is ALWAYS there
  //  with a fixed least height (conquest-hand.css .kh-wait-slot) — the card is anchored at the bottom, so a line that came
  //  and went still moved the rows up and down by its own height each half turn, and one press meant for a row landed on
  //  the map and chose a tile as the destination)
  return html`${head(L`砦へ進軍`, sub)}
    ${body}
    <div class="kh-wait-slot">${km.wait ? waitLine(km.wait) : ''}<div class="kh-wait-ghost" aria-hidden="true" inert>${waitLine({ why: 'settling', turn: FS.nowBell ?? 0, nudge: true }, true)}</div></div>
    <p class="pop-line pop-rule kh-rule">${L`砦のマスを ${fmtNum(holdTurns(FS))} ターン（${turnsLine(holdTurns(FS))}）続けて保つと、その州はあなたの国のものになります。行を選ぶと命令の紙が開きます（封をするまで何も送られません）。`}</p>
    <p class="pop-line pop-rule">${L`勝ち目は、着いたターンの戦いを記録の守備兵と城壁と地形で計算した目安です。戦いの後に強さ（兵 × 1 人の強さ）が多く残った側がマスに残り、同じなら砦の側が残ります。運の揺れ（±10%）を含め、ほかの軍勢、教義の効果、道中の物見櫓で減る兵（最大 30%）は含みません。`}</p>`;
}
