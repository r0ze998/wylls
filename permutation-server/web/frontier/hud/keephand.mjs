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
import { DEPART_STAMINA, DEPART_MARGIN_SECS, arrivalWindow, earliestBell } from '../fmarch.mjs';
import { activeHolding } from '../fstate.mjs';
import { hostRows } from '../screens/host.mjs';
import { sigilPath, FACTION_FILL, FACTION_DARK, FACTION_ON } from '../people/avatar.mjs';
import { icon } from './icons.mjs';
import { provinceName, provinceCoords } from './place.mjs';
import { whyText } from './orderparts.mjs';

const int = Number.isInteger;
const nation = f => int(f) && f >= 0 && f <= 5;
/** A conquest season on a chain: program version 3 or more, and not the sample world (which draws exactly what it drew: no keep is offered there). */
export const conquestOn = FS => Number(FS?.season?.programVersion ?? 0) >= 3 && !FS?.sample;
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
  if (r.inTransit || r.state === 3) return { why: 'march', turn: null };
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

/** A wait in one sentence, naming the host: what it is doing and the turn from which it can depart. */
export function waitText(w) {
  const who = unitCount(UNIT_ORDER[w.unit], w.troops);
  switch (w.why) {
    case 'forming': return L`${who} は編成中です。ターン ${fmtNum(w.turn)} から出発できます。`;
    case 'settling': return L`${who} のいる州が、ターンの処理を進めています。処理が済むと、このターン（ターン ${fmtNum(w.turn)}）から出発できます。`;
    case 'resting': return L`${who} は休息中です。ターン ${fmtNum(w.turn)} から出発できます。`;
    case 'stamina': return L`${who} は体力が足りません（${fmtNum(w.stamina)}/${fmtNum(DEPART_STAMINA)}）。ターン ${fmtNum(w.turn)} から出発できます。`;
    case 'march': return L`${who} は進軍に出ています。結果を受け取ると、また出発できます。`;
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
  return html`<ul class="kh-waits" role="status">${waits.slice(0, max).map(w => html`<li class="kh-wait kh-wait-${w.why}">${icon(w.why === 'march' ? 'march' : 'hourglass')}<span class="kh-wait-t">${waitText(w)}</span>
    ${w.nudge ? html`<button type="button" class="btn small" data-act="nudge" data-p="${w.p}" data-q="${w.q}" ${raw(busy ? 'disabled' : '')}>${L`この州の処理を進める`}</button>` : ''}</li>`)}</ul>`;
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

/**
 * The list of the host's bar: `{state: 'loading' | 'error' | 'ready', code?, wait (the host's own wait, or null),
 * rows: [{p, q, tile, holder, troops, name, coords, hexes, provinces, arrive, hold, contender, progress, key}],
 * unreachable (a count)}` for the host `r` (a hand subject's host). `FS.conquest.hostReach` is the controller's
 * answer for this host (`wantHostReach`): the kernel's routes from the tile it stands on.
 */
export function keepsModel(FS, r) {
  const hr = FS.conquest?.hostReach;
  const wait = waitOf(FS, r);
  if (!hr || hr.host !== String(r?.id)) return { state: 'loading', wait, rows: [], unreachable: 0 };
  if (!hr.ok) return { state: 'error', code: hr.code, wait, rows: [], unreachable: 0 };
  const keeps = FS.conquest?.keeps;
  const rows = hr.rows.map(x => {
    const k = keeps?.get?.(`${x.p},${x.q}`) ?? x;
    const contender = nation(k.contender) ? k.contender : null;
    return { p: x.p, q: x.q, tile: x.tile, holder: x.holder, troops: Number.isFinite(x.troops) ? x.troops : null, name: provinceName(FS, x.p, x.q, { own: false }), coords: provinceCoords(x.p, x.q),
      hexes: x.route.hexes, provinces: x.route.provinces.length, secs: x.route.secs, arrive: arrivalTurn(FS, x.route.secs), hold: holdTurns(FS, k), contender, progress: contender === null ? null : Math.max(0, Number(k.progress ?? 0)), key: `${x.p},${x.q}` };
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
  const off = !!km.wait;
  const row = x => html`<li><button type="button" class="kh-row kh-n${x.holder}${off ? ' off' : ''}" data-act="cq-march" data-host="${r.id}" data-p="${x.p}" data-q="${x.q}" data-tile="${x.tile}" data-keep-row="${x.key}" ${raw(off ? 'aria-disabled="true"' : '')}
      aria-label="${L`${x.name}の砦へ進軍：${factionName(x.holder)}が保持、守備兵 ${x.troops === null ? '—' : fmtNum(x.troops)}、到着はターン ${x.arrive === null || off ? '—' : fmtNum(x.arrive)}`}">
    <span class="kh-row-band" aria-hidden="true"></span>
    <span class="kh-row-where">${crest(x.holder, 26)}<span class="kh-row-names"><strong class="kh-row-name">${x.name}</strong><span class="kh-row-holder">${L`${factionName(x.holder)}が保持`} · <span class="kh-coords">${x.coords}</span></span></span></span>
    <span class="kh-fig kh-fig-def">${icon('shield')}<span class="kh-fig-v num">${x.troops === null ? '—' : fmtNum(x.troops)}</span><span class="kh-fig-k">${L`守備兵`}</span></span>
    <span class="kh-fig kh-fig-arr">${icon('bell')}<span class="kh-fig-v num">${x.arrive === null ? '—' : off ? L`+${fmtNum(Math.max(1, x.arrive - (FS.nowBell ?? 0)))} ターン` : L`ターン ${fmtNum(x.arrive)}`}</span><span class="kh-fig-k">${L`到着（${fmtNum(x.hexes)} マス）`}</span></span>
    <span class="kh-fig kh-fig-hold">${icon('flag')}<span class="kh-fig-v num">${x.contender !== null ? `${fmtNum(x.progress)}/${fmtNum(x.hold)}` : fmtNum(x.hold)}</span><span class="kh-fig-k">${x.contender !== null ? L`${factionName(x.contender)}が占拠中` : L`ターン保てば奪取`}</span></span>
    <span class="kh-row-go" aria-hidden="true">${icon('next')}</span></button></li>`;
  const body = km.state === 'loading' ? html`<p class="pop-line kh-loading">${L`届く砦を調べています…`}</p>`
    : km.state === 'error' ? html`<p class="pop-line pop-why">${clientText(km.code)}</p>`
    : km.rows.length ? html`<ol class="kh-rows" aria-label="${L`${who}が届く砦`}">${km.rows.map(row)}</ol>`
    : html`<p class="pop-line">${L`この軍勢がいま届く他国の砦はありません。進軍が越えられるのは4州までです。`}</p>`;
  return html`${head(L`砦へ進軍`, sub)}
    ${km.wait ? html`<p class="pop-line pop-why kh-wait-line">${icon('hourglass')}<span>${waitText({ ...km.wait, unit: r.unit, troops: r.troops })}</span>${km.wait.nudge ? html` <button type="button" class="btn small" data-act="nudge" data-p="${r.p}" data-q="${r.q}">${L`この州の処理を進める`}</button>` : ''}</p>` : ''}
    ${body}
    <p class="pop-line pop-rule kh-rule">${L`砦のマスを ${fmtNum(holdTurns(FS))} ターン続けて保つと、その州はあなたの国のものになります。行を選ぶと命令の紙が開きます（封をするまで何も送られません）。`}</p>`;
}
