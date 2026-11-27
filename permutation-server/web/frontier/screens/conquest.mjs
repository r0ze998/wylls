// Shared-world conquest views. No ownership or score is inferred from map colours.
// Controller contract: FS.conquest = { status, error?, keeps: Map<PQ, Keep>,
// standings?: {metric:'province-bells',bell,rows}, final?: same, outpost? }.
// Keep: {p,q,tile,holder,troops (whole units),heartland,consolidatedUntil,contender,
// progress,requiredBells,asOfBell}. Rows: {faction,provinces,provinceBells}.
// Outpost: {eligible,pending,reason?,cost? (whole resources)}; the selected free site.
// FS.conquest.history: Map<PQ, /h/keep record> (holders, contests, captures) of provinces the viewer selected.
// FS.conquest.reach: the keeps of other nations the viewer's marches can reach (fkeepreach.mjs `cachedReach`;
// the controller's `wantKeepReach` fills it when this tab or a keep panel is shown).
import { html, raw } from '../../util.mjs';
import { fogNow, viewKeeps } from '../map/fog.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName, UNITS, RESOURCES, RESOURCE_ORDER, routeLine, clientText } from '../fi18n.mjs';
import { keepEventSide } from '../fconquest.mjs';
import { activeHolding } from '../fstate.mjs';
import { actionBlocks, UNIT_ORDER, SCOUT, SETTLER } from '../fland.mjs';
import { DEPART_STAMINA } from '../fmarch.mjs';
import { hostRows } from './host.mjs';
import { marchListNow } from './tracker.mjs';
import { routeArrival, waitWords } from './march.mjs';
import { countdown, worldContinues } from '../clock.mjs';
import { turnsLine, termsRate, spanWords } from '../seasonterms.mjs';

/**
 * (fix-loop14, LP14-12) The way to a keep in one line. At the natural clock: fi18n.mjs routeLine (「12 マス · 3 州 · 約 24
 * 分」, the chain's minutes ARE real ones). On a faster TEST clock those minutes are the chain's, not the player's — at
 * ×60 the row said "about 24 min" for 24 real seconds, beside a World goals card that says real time (hud/worldgoals.mjs
 * turnsText) —, so the row says the real time in the card's words; while the pace is not known yet, "in game time".
 */
export function keepRouteLine(route, FS = null) {
  const r = termsRate();
  // (fix-loop15, LP15-9b: with the page's clock at hand the row says what the order card will say for this march —
  //  the arrival turn and the wait until it begins, in the card's own words (screens/march.mjs routeArrival,
  //  waitWords). It said the walk's minutes, 「約 40 分」, beside an order card saying 「ターン 7 · 約 48 分後」: a march
  //  arrives when its arrival turn begins, so the card's time is the one the player waits)
  const a = FS && !FS.proto ? routeArrival(FS, route) : null;
  if (!a && r === 1) return routeLine(route);
  const n = route.hexes, p = route.provinces.length;
  const t = a ? L`到着はターン ${fmtNum(a.bell)}（${waitWords(FS, a.inSecs)}）` : r === null ? L`ゲーム内で約 ${spanWords(route.secs)}` : L`この世界の実時間で約 ${spanWords(route.secs / r)}`;
  if (n === 1 && p === 1) return L`1 マス · 1 州 · ${t}`;
  if (p === 1) return L`${n} マス · 1 州 · ${t}`;
  return L`${n} マス · ${p} 州 · ${t}`;
}
import { icon } from '../hud/icons.mjs';
import { crest, sigChip, hostWaits, renderWaits, hostsOnTile, holdingHereText } from '../hud/keephand.mjs';

// Keep this module independent of the HUD: both the rail and inspector embed it.
const span = seconds => seconds < 3600 ? countdown(seconds) : seconds < 86400 ? L`${Math.floor(seconds / 3600)}時間${Math.floor(seconds % 3600 / 60)}分` : L`${Math.floor(seconds / 86400)}日`;

export const conquestEnabled = FS => Number(FS.season?.programVersion ?? 0) >= 3;
export const bellSeconds = FS => Number(FS.season?.bellSecs ?? FS.clock?.bellSecs ?? 600);
const busy = FS => FS.inFlight > 0 || !!FS.homeActionBusy || !!FS.conquest?.busy;
const uint = n => { if (n === null || n === undefined || n === '' || typeof n === 'boolean') return null; try { const v = BigInt(n); return v >= 0n ? v : null; } catch { return null; } };

/** Refuse the old Dominion/holding-count tables; compare the confirmed score exactly. */
export function scoreRows(record) {
  if (record?.metric !== 'province-bells' || !Array.isArray(record.rows) || record.rows.length !== 6) return null;
  const seen = new Set(), rows = [];
  for (const r of record.rows) {
    const score = uint(r.provinceBells);
    if (!Number.isInteger(r.faction) || r.faction < 0 || r.faction > 5 || seen.has(r.faction) || score === null || !Number.isInteger(r.provinces) || r.provinces < 0) return null;
    seen.add(r.faction); rows.push({ ...r, score });
  }
  // the winner is the nation holding the most provinces at the season's end; nations with the same number share a rank
  // (how a tie for first is settled is not decided, so the time held only orders the rows within a rank)
  rows.sort((a, b) => b.provinces - a.provinces || (a.score === b.score ? a.faction - b.faction : a.score > b.score ? -1 : 1));
  return rows.map(r => ({ ...r, rank: rows.findIndex(x => x.provinces === r.provinces) + 1 }));
}

export function keepFor(FS, p, q) {
  // (the local test world's fog of war, map/fog.mjs: a keep never seen is not told, one seen before is its last-known)
  const keeps = viewKeeps(FS.conquest?.keeps);
  return keeps instanceof Map ? keeps.get(`${p},${q}`) ?? null : keeps?.[`${p},${q}`] ?? null;
}

/** The viewer's combat hosts that can depart now (the keep panel's buttons; the reach list's origins). */
export function readyHosts(FS) {
  const bell = FS.nowBell ?? 0;
  return hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER && r.state === 1 && !r.inTransit && !r.pending && r.readyBell <= bell && r.stamina >= DEPART_STAMINA
    && !actionBlocks('Depart', { holding: activeHolding(FS), province: r.province, now: FS.chain?.now?.() ?? 0, nowBell: bell, host: r }).length);
}

/**
 * Where the reach list measures from: `{home, origins: [{p, q, tile, unit, host?, troops?}]}` —
 * the ready combat hosts, or (none ready) the active village's tile with unit 0.
 */
export function reachOrigins(FS) {
  const hosts = readyHosts(FS);
  if (hosts.length) return { home: false, origins: hosts.map(h => ({ p: h.p, q: h.q, tile: h.tile, unit: h.unit, host: String(h.id), troops: h.troops })) };
  const h = activeHolding(FS);
  return { home: true, origins: h && Number.isInteger(h.tile) ? [{ p: h.p, q: h.q, tile: h.tile, unit: 0 }] : [] };
}

/** Whether the reach list was made from ready hosts and found no route from any of them to this keep. */
export function keepUnreachable(FS, keep) {
  const r = FS.conquest?.reach;
  return !!keep && !!r?.ok && !r.home && r.unreachable.includes(`${keep.p},${keep.q}`);
}

/** The way back to the reach list (the keep panel's note; the composer without a route). */
export const reachLink = FS => (conquestEnabled(FS) && FS.mode === 'play' ? html`<button type="button" class="btn small" data-act="tab" data-tab="territory">${L`届く砦の一覧を見る`}</button>` : '');

export function keepModel(FS, keep) {
  if (!keep || !Number.isInteger(keep.tile) || keep.tile < 0 || keep.tile >= 61 || !Number.isInteger(keep.holder) || keep.holder < 0 || keep.holder > 6) return null;
  const bell = FS.nowBell ?? 0;
  const mine = keep.holder === FS.citizen?.faction;
  const heartland = !!keep.heartland;
  const protectionKnown = Number.isInteger(keep.consolidatedUntil) && keep.consolidatedUntil >= 0;
  const protectedFor = Math.max(0, Number(keep.consolidatedUntil ?? 0) - bell);
  const contender = Number.isInteger(keep.contender) && keep.contender >= 0 && keep.contender < 6 ? keep.contender : null;
  const required = Number(keep.requiredBells);
  const progress = Math.max(0, Number(keep.progress ?? 0));
  const remaining = contender !== null && Number.isFinite(required) && required > 0 ? Math.max(0, required - progress) : null;
  const hosts = readyHosts(FS);
  return { ...keep, mine, heartland, protectionKnown, protectedFor, contender, required, progress, remaining, hosts, canContest: protectionKnown && !heartland && !protectedFor };
}

/**
 * A keep's ownership record from /h/keep: `{rows: [{bell, kind: 'held' |
 * 'taken' | 'contest', holder, from?, troops?, sig?, seq?, to?, progress?,
 * outcome?}], last}`, oldest first; `last` is the latest capture. A capture
 * carries the transaction signature of its record when the herald serves it
 * (`captures[].sig`); a contest is the span of turns a contender held the
 * keep's tile. Null without a readable record.
 */
export function keepHistory(h) {
  const nation = f => Number.isInteger(f) && f >= 0 && f <= 5, bell = b => Number.isInteger(b) && b >= 0;
  if (!h || !Array.isArray(h.holders) || !Array.isArray(h.captures)) return null;
  const taken = h.captures.filter(c => bell(c.bell) && nation(c.from) && nation(c.to)).map(c => ({ bell: c.bell, kind: 'taken', holder: c.to, from: c.from, troops: Number.isFinite(c.troops) ? c.troops : null,
    sig: typeof c.sig === 'string' && c.sig ? c.sig : null, seq: c.seq !== undefined && c.seq !== null ? String(c.seq) : null }));
  const contests = (Array.isArray(h.contests) ? h.contests : []).filter(c => nation(c.contender) && bell(c.from)).map(c => ({ bell: c.from, kind: 'contest', holder: c.contender, to: bell(c.to) ? c.to : null,
    progress: Number.isFinite(c.progress) ? c.progress : null, outcome: ['taken', 'broken', 'running'].includes(c.outcome) ? c.outcome : null }));
  const order = { contest: 0, taken: 1, held: 2 };
  const rows = [...h.holders.filter(x => nation(x.holder) && bell(x.since)).map(x => ({ bell: x.since, kind: 'held', holder: x.holder })), ...taken]
    .sort((a, b) => a.bell - b.bell || (a.kind === 'taken' ? -1 : 1));
  if (!rows.length) return null;
  return { rows, last: taken.at(-1) ?? null, all: [...rows, ...contests].sort((a, b) => a.bell - b.bell || order[a.kind] - order[b.kind]) };
}

/** The history as a ledger: who held it from when, each contest with its count of turns, each capture with the signature of its record. */
function renderHistory(hist) {
  if (!hist) return '';
  const line = r => (r.kind === 'taken'
    ? html`<li class="kp-h kp-h-taken kh-n${r.holder}">${crest(r.holder, 18)}<span class="kp-h-t">${L`第${fmtNum(r.bell)}ターン：${factionName(r.holder)}が${factionName(r.from)}から奪取`}${r.troops !== null ? html` <span class="muted">${L`守備兵 ${fmtNum(r.troops)}`}</span>` : ''}</span>${r.sig ? sigChip(r.sig, { label: L`記録の署名` }) : ''}</li>`
    : r.kind === 'contest'
      ? html`<li class="kp-h kp-h-contest kh-n${r.holder}">${crest(r.holder, 18)}<span class="kp-h-t">${r.outcome === 'running' || r.to === null ? L`第${fmtNum(r.bell)}ターンから：${factionName(r.holder)}が砦のマスを占拠中` : L`第${fmtNum(r.bell)}〜${fmtNum(r.to)}ターン：${factionName(r.holder)}が砦のマスを占拠`}${r.progress !== null ? html` <span class="muted">${L`${fmtNum(r.progress)} ターン`}</span>` : ''}${r.outcome === 'broken' ? html` <span class="muted">${L`（守りきられた）`}</span>` : ''}</span></li>`
      : html`<li class="kp-h kp-h-held kh-n${r.holder}">${crest(r.holder, 18)}<span class="kp-h-t">${L`第${fmtNum(r.bell)}ターンから：${factionName(r.holder)}が保持`}</span></li>`);
  return html`<div class="conquest-history kp-history"><h5>${L`砦の履歴`}</h5>
    <ol class="list kp-hist">${(hist.all ?? hist.rows).map(line)}</ol>
    ${hist.last ? html`<p class="kp-caption">${icon('lock')}<span>${L`占領：チェーンの記録を読んだものです（このブラウザでは計算し直していません）`}</span></p>` : ''}</div>`;
}

/**
 * (2026-11-17, ⑦ the keep and the march toward it; corrected) The viewer's own marches as they bear on this keep, from
 * the list the tracker shows — only when that list is the page's own NOW (screens/tracker.mjs marchListNow: the pinned
 * world, the context number, the viewer and the village in hand, each as the list's reading began):
 * `{read, ctx, bound, province}`.
 *   `read` false → the list is NOT KNOWN for what the page is now (not read yet, another village's, or read before a
 *           change of herald, viewer or world): neither "none on its way" nor anything else follows.
 *   `bound`    marches whose destination tile is KNOWN and is this keep's tile: bound for this keep.
 *   `province` marches of which only the destination's PROVINCE is known, and it is this keep's: whether they are
 *           bound for the keep is not known — they are not counted as "on their way to this keep".
 *   A march to another tile of the province is neither.
 *   each `{host, arriveBell, resolved, unread, who}`; `resolved`: the arrival turn's record says it is resolved (the
 *   tracker's own fact) — what came of it is the tracker's and the report's to say; no capture and no repulse is
 *   claimed from it.
 * Marches of the viewer's OTHER villages are not in the list: nothing is said of them either way.
 */
export function marchesToKeep(FS, keep) {
  const now = marchListNow(FS);
  if (!keep || !now.ok) return { read: now.ok, ctx: null, bound: [], province: [] };
  const rows = (() => { try { return hostRows(FS); } catch { return []; } })();
  const bound = [], province = [];
  for (const m of FS.marches ?? []) {
    const dest = m?.entry ? m.dest : m?.readDest ?? m?.dest ?? null;
    if (!dest || dest.p !== keep.p || dest.q !== keep.q) continue;
    const tileKnown = Number.isInteger(dest.tile);
    if (tileKnown && dest.tile !== keep.tile) continue;
    const host = String(m.entry?.host ?? m.transit?.hostId ?? ''), row = rows.find(r => String(r.id) === host) ?? null;
    const arriveBell = m.entry?.arriveBell ?? m.transit?.arriveBell;
    (tileKnown ? bound : province).push({ host, arriveBell: Number.isInteger(arriveBell) ? arriveBell : null, resolved: m.facts?.pipeline === 'resolved', unread: !!m.unread,
      who: row ? `${UNITS[UNIT_ORDER[row.unit]]} ${fmtNum(row.troops)}` : null });
  }
  return { read: true, ctx: now.ctx, bound, province };
}
/** The keep card's lines for marchesToKeep: the marches bound for the keep, apart from those known only to its province; "not known" said as that. */
function renderKeepMarches(FS, m) {
  if (FS.mode !== 'play') return '';
  const x = marchesToKeep(FS, m);
  if (!x.read) return FS.wallet ? html`<p class="muted kp-marches" role="status" data-marches="unread">${L`この砦へ向かっているあなたの軍勢がいるかどうかは、いま選んでいる村の進軍の記録をまだ読めていないので、分かりません。`}</p>` : '';
  if (!x.bound.length && !x.province.length) return '';
  const when = r => (r.resolved ? L`到着のターン（${fmtNum(r.arriveBell ?? 0)}）は決着済みです。どうなったかは、追跡と報告で確かめられます。`
    : r.arriveBell !== null ? L`ターン ${fmtNum(r.arriveBell)} に着く予定です。` : L`進軍中です。`);
  const line = (r, sure) => html`<li>${icon('march')}<strong>${r.who ?? L`軍勢`}</strong> <span class="muted">${when(r)}${r.unread ? L`（到着先の記録を、まだ読めていません。）` : ''}</span>
      ${x.ctx !== null && /^\d+$/.test(r.host) ? html`<button type="button" class="btn small" data-act="keep-track" data-ctx="${x.ctx}" data-p="${m.p}" data-q="${m.q}" data-tile="${m.tile}" data-sure="${sure ? 1 : 0}" data-host="${r.host}">${L`この進軍の追跡を見る`}</button>` : ''}</li>`;
  return html`<div class="kp-marches" data-marches="${x.bound.length}" data-province="${x.province.length}">
    ${x.bound.length ? html`<p class="kp-orders-k">${L`この砦へ向かっているあなたの軍勢`}</p><ul class="list">${x.bound.map(r => line(r, true))}</ul>` : ''}
    ${x.province.length ? html`<p class="kp-orders-k">${L`この州へ向かっているあなたの軍勢（行き先のマスは、まだ分かりません）`}</p><ul class="list">${x.province.map(r => line(r, false))}</ul>
      <p class="muted">${L`この砦へ向かっているかどうかは、行き先のマスが読めるまで分かりません。`}</p>` : ''}
    <p class="muted">${L`ここに出るのは、いま選んでいる村の進軍だけです。`}</p></div>`;
}

export function renderKeep(FS, keep) {
  if (!conquestEnabled(FS)) return '';
  if (keep?.tile === 255) return html`<p class="muted">${L`この州には砦がありません。`}</p>`;
  // (the local test world's fog of war, map/fog.mjs: a keep never seen is not told — not "loading" either)
  if (!keep && fogNow().on) return html`<section class="conquest-keep hpanel"><h4>${L`この州の砦`}</h4><p class="muted">${L`この州の砦は、まだ見ていません。`}</p></section>`;
  const m = keepModel(FS, keep);
  if (!m) return html`<section class="conquest-keep hpanel"><h4>${L`この州の砦`}</h4><p class="muted">${L`砦の情報を確認しています。`}</p></section>`;
  const owner = m.holder < 6 ? factionName(m.holder) : L`中立`;
  const ended = (!worldContinues(FS.season) && (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity));
  // (a keep out of sight is its last-known look: no live history of contests and captures — map/fog.mjs)
  const hist = keep?.fog === 'memory' ? null : keepHistory(FS.conquest?.history?.get?.(`${m.p},${m.q}`));
  // (no host can depart this moment: the ones on their way to being ready say so, with the turn; hud/keephand.mjs)
  // (and beside the ones that can: a host mustered a moment ago is named with the turn from which it can depart)
  // (a host of the viewer's that stands on the keep's own tile is not offered as one to send there, and is not said to
  // be waiting to depart for it: it is said to be holding the tile — the local test chain, 2026-10-11: under a keep
  // six turns into its contest the panel read 「この砦へ送る軍勢を選ぶ：槍兵 486 は体力が足りません」 of the very host holding it)
  const here = FS.mode === 'play' ? hostsOnTile(FS, m.p, m.q, m.tile) : [], hereIds = new Set(here.map(x => x.id));
  const waits = FS.mode === 'play' ? hostWaits(FS).filter(w => !hereIds.has(w.id) && (m.hosts.length ? ['forming', 'settling', 'resting', 'stamina'].includes(w.why) : true)) : [];
  const holding = here.length ? html`<p class="kp-here" role="note">${icon('flag')}<span>${holdingHereText(here)}</span></p>` : '';
  const hold = Number.isFinite(m.required) && m.required > 0 ? m.required : null;
  // the act (a host to send) stands before the history of another nation's keep; a keep of the viewer's own nation says its
  // history first: the capture and the signature of its record are what is looked at there
  const others = m.hosts.filter(h => !hereIds.has(String(h.id)));
  const orders = FS.mode === 'play' && !ended && (m.mine || m.canContest) && here.length && !others.length && !waits.length ? html`<div class="conquest-orders kp-orders">${holding}</div>`
    : FS.mode === 'play' && !ended && (m.mine || m.canContest) ? html`<div class="conquest-orders kp-orders">${holding}<p class="kp-orders-k">${m.mine ? L`守りに送る軍勢を選ぶ` : L`この砦へ送る軍勢を選ぶ`}</p>
      ${others.length ? html`<div class="actions">${others.map(h => html`<button type="button" class="btn primary kp-go" data-act="cq-march" data-host="${String(h.id)}" data-p="${m.p}" data-q="${m.q}" data-tile="${m.tile}" ${raw(busy(FS) ? 'disabled' : '')}>${icon(m.mine ? 'shield' : 'march')}${UNITS[UNIT_ORDER[h.unit]]} ${fmtNum(h.troops)} · ${m.mine ? L`守りに送る` : L`進軍を準備`}</button>`)}</div>${!m.mine && keepUnreachable(FS, m) ? html`<p class="blocked" role="note">${L`この砦へは届く道がありません（進軍は4州まで）`} ${reachLink(FS)}</p>` : ''}${renderWaits(FS, waits, { max: m.mine ? 1 : 2 })}`
        : waits.length ? html`${renderWaits(FS, waits, { max: m.mine ? 1 : 3 })}<div class="actions"><button type="button" class="btn" data-act="tab" data-tab="hosts">${icon('sword')}${L`軍勢を見る`}</button></div>`
          : html`<p class="muted">${L`出発できる戦闘部隊がいません。兵を訓練し、軍勢を編成してください。`}</p><button type="button" class="btn" data-act="tab" data-tab="holding">${L`村で兵を準備する`}</button>`}
    </div>` : '';
  return html`<section class="conquest-keep hpanel kp kh-n${m.holder < 6 ? m.holder : 6}${m.mine ? ' kp-mine' : ''}" aria-label="${L`この州の砦`} · ${L`マス ${fmtNum(m.tile + 1)}`}">
    <header class="kp-head">${crest(m.holder < 6 ? m.holder : null, 46)}<div class="kp-titles"><h4 class="kp-kicker">${icon('flag')}${L`この州の砦`}</h4>
      <strong class="kp-holder">${m.mine ? L`あなたの国が保持` : L`${owner}が保持`}</strong></div>
      <div class="kp-def"><strong class="num">${Number.isFinite(m.troops) ? fmtNum(m.troops) : L`確認中`}</strong><span>${L`砦の守備兵`}</span></div></header>
    <dl class="facts kp-facts"><div class="row"><dt>${L`支配国`}</dt><dd>${owner}${m.mine ? html` · ${L`あなたの国`}` : ''}</dd></div>
      ${hist?.last ? html`<div class="row"><dt>${L`前の支配国`}</dt><dd>${factionName(hist.last.from)} · ${L`第${fmtNum(hist.last.bell)}ターンに交代`}</dd></div>` : ''}
      ${Number.isInteger(m.asOfBell) ? html`<div class="row"><dt>${L`最終確認`}</dt><dd>${L`第${fmtNum(m.asOfBell)}ターン`}</dd></div>` : ''}</dl>
    ${keep?.fog === 'memory' ? html`<p class="muted kp-fog">${L`最後に見たときのようすです（いまは見えていません）。`}</p>` : ''}
    ${m.heartland ? html`<p class="kp-state kp-state-safe">${icon('shield')}<span>${L`本国の中核地です。この砦は奪取されません。`}</span></p>` : m.protectedFor > 0 ? html`<p class="kp-state kp-state-safe">${icon('shield')}<span>${L`占領後の保護中です。あと${span(m.protectedFor * bellSeconds(FS))}（ゲーム内）で再び争奪できます。`}</span></p>`
      : html`<p class="kp-state">${hold !== null && !m.mine ? html`<strong>${L`敵の軍勢が砦のマスを ${fmtNum(hold)} ターン続けて保つと、州はその国のものになります。`}</strong> ` : ''}${worldContinues(FS.season) ? L`砦を保持する国がこの州を支配します。この世界は続きます。戦期の勝敗と集計は未決定です。` : L`砦を保持する国がこの州を支配します。`}</p>`}
    ${!m.heartland && !m.mine && !m.protectionKnown ? html`<p class="muted">${L`この砦の保護状態を確認しています。`}</p>` : ''}
    ${m.contender !== null ? html`<div class="conquest-progress kp-contest kh-n${m.contender}"><p class="kp-contest-head">${crest(m.contender, 28)}<strong>${L`${factionName(m.contender)}が争奪中`}</strong><span class="kp-count num">${Number.isFinite(m.required) ? L`${fmtNum(m.progress)} / ${fmtNum(m.required)}ターン` : L`進捗を確認中`}</span></p>
      ${Number.isFinite(m.required) && m.required > 0 ? html`<progress max="${m.required}" value="${Math.min(m.progress, m.required)}" aria-label="${L`砦の争奪状況`}"></progress>` : ''}
      ${m.remaining !== null ? html`<p class="muted">${m.remaining > 0 ? L`占拠を保てた場合、あと${span(m.remaining * bellSeconds(FS))}（ゲーム内）。敵の抵抗で進捗は変わります。` : L`争奪の処理結果を待っています。`}</p>` : ''}</div>` : ''}
    ${renderKeepMarches(FS, m)}
    ${m.mine ? html`${renderHistory(hist)}${orders}` : html`${orders}${renderHistory(hist)}`}
  </section>`;
}

export function renderOutpost(FS, site) {
  if (!conquestEnabled(FS) || FS.mode !== 'play' || !site || !activeHolding(FS)) return '';
  const o = FS.conquest?.outpost;
  if (!o) return html`<p class="muted">${L`前哨を築ける条件を確認しています。`}</p>`;
  const ended = (!worldContinues(FS.season) && (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity));
  const targetMatches = !o.target || (o.target.p === site.p && o.target.q === site.q && o.target.site === site.site);
  return html`<section class="conquest-outpost"><h4>${L`前哨を築く`}</h4><p>${L`前哨は、現在の村から領土を広げる足場になります。申請後に場所が確定します。`}</p>
    ${o.cost ? html`<p>${o.cost.map((v, i) => v ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(v)}` : '').filter(Boolean).join(' · ')}</p>` : ''}
    <p class="muted">${L`資源は申請時に支払います。申請の期限切れや、仮の入植地が競合で失われた場合も返還されません。`}</p>
    ${o.reason ? html`<p class="blocked">${o.reason}</p>` : ''}
    <button type="button" class="btn" data-act="cq-outpost" data-p="${site.p}" data-q="${site.q}" data-site="${site.site}" ${raw(busy(FS) || ended || !targetMatches || o.pending || o.eligible !== true ? 'disabled' : '')}>${o.pending ? L`前哨の申請を確認しています` : L`このマスに前哨を申請する`}</button>
  </section>`;
}

/**
 * Whether the reach list is still being worked out (B9): keeps of the control snapshot that the page cannot place yet
 * (controller.mjs keepsPending — a ring's village list not read). An empty list then says so, and never that no keep is
 * within reach.
 */
export const reachLoading = FS => Number(FS?.conquest?.keepsPending ?? 0) > 0 && !fogNow().on;   // (under the fog of war nothing unseen is "pending": map/fog.mjs)

/**
 * (fix-loop6, LP6-10) The viewer's nation's keeps another nation is taking now, from the keep events the page already
 * shows as news (hud/feed.mjs: a contest of the viewer's own nation is news under the fog too — no other keep is told):
 * for each keep, the latest of its events; a contest against the viewer's nation not ended since. → `[{p, q, by, since,
 * progress?, hold?}]`, latest first. loop-play6: 国と領土 said nothing of such a keep out of every host's reach.
 */
export function besiegedOwnKeeps(FS) {
  const f = FS.citizen?.faction, events = FS.conquest?.events;
  if (!Number.isInteger(f) || !Array.isArray(events)) return [];
  const last = new Map();
  for (const e of events) {
    if (!Number.isInteger(e?.p) || !Number.isInteger(e?.q)) continue;
    const k = `${e.p},${e.q}`, was = last.get(k);
    if (!was || Number(e.bell) > Number(was.bell) || (Number(e.bell) === Number(was.bell) && Number(e.seq) > Number(was.seq))) last.set(k, e);
  }
  const seen = FS.conquest?.keeps instanceof Map ? viewKeeps(FS.conquest.keeps) : null;
  return [...last.values()].filter(e => e.kind === 'keep_contest' && keepEventSide(e, f) === 'defend')
    .map(e => { const k = seen?.get?.(`${e.p},${e.q}`); const on = k && k.contender === e.to;
      return { p: e.p, q: e.q, by: e.to, since: Number(e.bell), ...(on && Number.isFinite(Number(k.progress)) ? { progress: Number(k.progress) } : {}) }; })
    .sort((a, b) => b.since - a.since);
}

/**
 * (fix-loop8, LP7-6 rest — loop-play8: after the clash the list still offered 「州 1,0 · ボレアリス · 守備兵 15」, the keep the
 * viewer's own host stood on) Whether a host of the viewer is ON keep `x` (p, q, tile): one standing on its tile
 * (hostsOnTile), or a march of the viewer to that keep past its arrival turn whose host has not come back — its transit
 * record is still open until the program settles it, so the host is in no province's list yet (screens/host.mjs
 * awayHosts) or is shown in transit. Such a keep is not "a keep your army can reach": it is said apart, as held.
 */
export function ownHostOnKeep(FS, x) {
  if (!x || !Number.isInteger(x.p) || !Number.isInteger(x.q)) return false;
  if (Number.isInteger(x.tile) && hostsOnTile(FS, x.p, x.q, x.tile).length) return true;
  const bell = FS.nowBell ?? 0;
  let rows = [];
  try { rows = hostRows(FS); } catch { rows = []; }
  return (FS.marches ?? []).some(m => {
    // (fix-loop9, LP9-2: a kept expedition standing on the keep's tile — 進軍 follows its hold)
    const xp = m?.expedition;
    if (xp) return xp.stage === 'settled' && xp.fate === 'stays' && xp.dest?.p === x.p && xp.dest?.q === x.q && (!Number.isInteger(x.tile) || xp.dest.tile === x.tile) && !(xp.hold?.outcome === 'lost' && xp.hold.why === 'gone');
    const d = m?.dest, arrive = m?.entry?.arriveBell ?? m?.transit?.arriveBell, id = String(m?.entry?.host ?? m?.transit?.hostId ?? '');
    if (!d || d.p !== x.p || d.q !== x.q || (Number.isInteger(d.tile) && Number.isInteger(x.tile) && d.tile !== x.tile)) return false;
    if (!Number.isInteger(arrive) || bell < arrive || !id) return false;
    const r = rows.find(y => String(y.id) === id);
    return !r || r.inTransit || r.state === 3;
  });
}

/**
 * (fix-loop9, LP9-2) The wide keeps the viewer's kept expeditions stand on and still hold (not taken, not lost):
 * `[{p, q, tile, progress, required}]`, from the march rows (flocalplay-expedition.mjs, followed holds).
 */
export function expeditionKeeps(FS) {
  const out = [];
  for (const m of FS?.marches ?? []) {
    const x = m?.expedition, h = x?.hold;
    if (!x || x.stage !== 'settled' || x.fate !== 'stays' || !h || h.outcome || !x.dest) continue;
    if (out.some(y => y.p === x.dest.p && y.q === x.dest.q)) continue;
    out.push({ p: x.dest.p, q: x.dest.q, tile: x.dest.tile, progress: h.progress ?? null, required: h.required ?? null });
  }
  return out;
}

/** The keeps of other nations a march of the viewer can reach now, nearest first. */
export function renderReach(FS) {
  if (!conquestEnabled(FS) || FS.mode !== 'play' || !activeHolding(FS) || !Number.isInteger(FS.citizen?.faction)) return '';
  if ((!worldContinues(FS.season) && (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity))) return '';
  const r = FS.conquest?.reach;
  const row = x => html`<li class="kr-row kh-n${x.holder}">${crest(x.holder, 24)}<span class="kr-main"><strong>${L`州 ${x.p},${x.q}`}</strong> · ${factionName(x.holder)}${Number.isFinite(x.troops) ? html` · ${L`守備兵 ${fmtNum(x.troops)}`}` : ''} · ${keepRouteLine(x.route, FS)}${x.origin?.host ? html` <span class="muted">${UNITS[UNIT_ORDER[x.origin.unit]]} ${fmtNum(x.origin.troops)}</span>` : ''}</span>
    <button type="button" class="btn small" data-act="goto" data-p="${x.p}" data-q="${x.q}" aria-label="${L`そこへ移動`}: ${L`州 ${x.p},${x.q}`}">${L`そこへ移動`}</button></li>`;
  // (the loop-play report B7: a keep of the viewer's OWN nation that another nation is counting on is in this list so
  //  that a host can go and defend it (fkeepreach.mjs defendableKeeps, `defend: true`; the host's forts card says
  //  「守りに向かう」). Here it stood under "keeps of other nations", named by its own nation, with nothing saying
  //  it is to be defended. It has its own list and its own words now; the list of other nations' keeps is theirs alone)
  const defendRow = x => html`<li class="kr-row kr-row-defend kh-n${x.holder}" data-keep-defend="${x.p},${x.q}">${crest(x.holder, 24)}<span class="kr-main"><strong>${L`州 ${x.p},${x.q}`}</strong> · ${L`あなたの国が保持`}${Number.isFinite(x.troops) ? html` · ${L`守備兵 ${fmtNum(x.troops)}`}` : ''} · ${keepRouteLine(x.route, FS)}${x.origin?.host ? html` <span class="muted">${UNITS[UNIT_ORDER[x.origin.unit]]} ${fmtNum(x.origin.troops)}</span>` : ''}
      <span class="kr-defend">${icon('shield')}<strong>${L`守りに向かう`}</strong> · ${L`マスに残れば占拠を止めます`}</span></span>
    <button type="button" class="btn small" data-act="goto" data-p="${x.p}" data-q="${x.q}" aria-label="${L`そこへ移動`}: ${L`州 ${x.p},${x.q}`}">${L`そこへ移動`}</button></li>`;
  const defends = r?.ok ? r.rows.filter(x => x.defend === true) : [], rest = r?.ok ? r.rows.filter(x => x.defend !== true) : [];
  // (fix-loop8, LP7-6: a keep the viewer's own host is on is said apart — held, not to be reached)
  const held = rest.filter(x => ownHostOnKeep(FS, x)), others = rest.filter(x => !held.includes(x));
  // (fix-loop9, LP9-2: a wide keep is in no reach list — the reach covers the rings up to 128 — so a keep the viewer's
  //  expedition holds in the wide land is added here from the expedition itself: verify run, 「見えている他国の砦で、
  //  いま届くものはありません。」 while 1 host counted the hold)
  const wideHeld = expeditionKeeps(FS).filter(x => !held.some(y => y.p === x.p && y.q === x.q));
  const wideRow = x => html`<li class="kr-row kr-row-held" data-keep-held="${x.p},${x.q}" data-keep-wide="1"><span class="kr-main"><strong>${L`州 ${x.p},${x.q}`}</strong> · ${L`広い土地`}${Number.isFinite(x.progress) && Number.isFinite(x.required) ? html` · ${L`占拠 ${fmtNum(x.progress)} / ${fmtNum(x.required)} ターン`}` : ''}
      <span class="muted">${L`あなたの軍勢がこの砦に着いています。占拠の進み具合と結果は「進軍」で確かめられます。`}</span></span>
    <button type="button" class="btn small" data-act="goto" data-p="${x.p}" data-q="${x.q}">${L`そこへ移動`}</button></li>`;
  const heldRow = x => html`<li class="kr-row kr-row-held kh-n${x.holder}" data-keep-held="${x.p},${x.q}">${crest(x.holder, 24)}<span class="kr-main"><strong>${L`州 ${x.p},${x.q}`}</strong> · ${factionName(x.holder)}
      <span class="muted">${L`あなたの軍勢がこの砦に着いています。占拠の進み具合と結果は「進軍」で確かめられます。`}</span></span>
    <button type="button" class="btn small" data-act="goto" data-p="${x.p}" data-q="${x.q}" aria-label="${L`そこへ移動`}: ${L`州 ${x.p},${x.q}`}">${L`そこへ移動`}</button></li>`;
  // (fix-loop6, LP6-10: the nation's keeps under attack that no host of the viewer reaches are said too, with where to look)
  const reached = new Set(defends.map(x => `${x.p},${x.q}`));
  const far = besiegedOwnKeeps(FS).filter(x => !reached.has(`${x.p},${x.q}`));
  const farRow = x => html`<li class="kr-row kr-row-defend kh-n${FS.citizen.faction}" data-keep-defend-far="${x.p},${x.q}">${crest(FS.citizen.faction, 24)}<span class="kr-main"><strong>${L`州 ${x.p},${x.q}`}</strong> · ${L`${factionName(x.by)}が第${fmtNum(x.since)}ターンから占拠を進めています`}${Number.isFinite(x.progress) ? html` · ${L`占拠 ${fmtNum(x.progress)} ターン`}` : ''}
      <span class="muted">${L`いまのあなたの軍勢では届きません。`}</span></span>
    <button type="button" class="btn small" data-act="goto" data-p="${x.p}" data-q="${x.q}" aria-label="${L`そこへ移動`}: ${L`州 ${x.p},${x.q}`}">${L`そこへ移動`}</button></li>`;
  // (measured from the village because no host can depart this moment: a host that is on its way to being ready says so,
  // with the turn from which it can depart; only a player without any combat host is told to train one)
  const waits = r?.ok && r.home ? hostWaits(FS) : [];
  // (the keeps to defend come first, under their own heading; then the other nations' keeps under theirs)
  return html`<section class="conquest-reach hpanel" aria-labelledby="conquest-reach-title">
    ${defends.length || far.length ? html`<h4 class="kr-defend-title" id="conquest-defend-title">${L`他国が占拠を進めている、あなたの国の砦`}</h4><ul class="list kr-rows kr-rows-defend" aria-labelledby="conquest-defend-title">${defends.map(defendRow)}${far.map(farRow)}</ul>` : ''}
    ${held.length || wideHeld.length ? html`<h4 class="kr-held-title" id="conquest-held-title">${L`あなたの軍勢が着いている砦（自分の国のもの以外）`}</h4><ul class="list kr-rows kr-rows-held" aria-labelledby="conquest-held-title">${held.map(heldRow)}${wideHeld.map(wideRow)}</ul>` : ''}
    <h4 id="conquest-reach-title">${L`あなたの軍が届く他国の砦`}</h4>
    ${!r ? html`<p class="muted">${L`届く砦を調べています…`}</p>` : !r.ok ? html`<p class="muted">${clientText(r.code)}</p>` : html`
      ${r.home ? (waits.length ? html`${renderWaits(FS, waits)}<p class="muted">${L`そのあいだは、村からの道のりで調べています。`}</p>` : html`<p class="muted">${L`出発できる戦闘部隊がいないため、村からの道のりで調べています。`}</p>`) : ''}
      ${others.length ? html`<ul class="list kr-rows" aria-labelledby="conquest-reach-title">${others.map(row)}</ul>` : held.length ? html`<p class="muted">${L`ほかに、いま届く他国の砦はありません。`}</p>` : reachLoading(FS) ? html`<p class="muted kr-loading">${L`届く砦を調べています…`}</p>` : fogNow().on ? html`<p>${L`見えている他国の砦で、いま届くものはありません。まだ見ていない土地の砦は表示しません。`}</p>` : html`<p>${L`いま届く他国の砦はありません。進軍が越えられるのは4州までです。`}</p>`}`}
  </section>`;
}

export function renderStandings(FS) {
  if (!conquestEnabled(FS)) return '';
  // (fix-loop13, LP13-1: the owners abolished seasons — 2026-11-23 22:42 — so no world says "the nation with the most
  // provinces wins at the season's end". A world whose program still has an end turn — the --demo / --wide TEST worlds —
  // says that turn as what it is: a test world's limit after which the program takes no new order, never a rule for
  // winning; its last record is shown as a record, without a winner)
  const cq = FS.conquest, continuous = worldContinues(FS.season), endBell = Number(FS.season?.endBell ?? Infinity), ended = (!continuous && (FS.nowBell ?? 0) >= endBell);
  const record = ended && cq?.final ? cq.final : cq?.standings;
  const rows = scoreRows(record);
  const isFinal = ended && record === cq?.final && !!rows;
  const seconds = bellSeconds(FS);
  const intro = L`州・時間は、州を保った時間の記録です（1州を1時間で1州・時間）。`;
  return html`<section class="conquest-standings hpanel" aria-labelledby="conquest-standings-title"><h3 id="conquest-standings-title">${isFinal ? L`この試しの世界の最後の記録` : L`国の領土と支配記録`}</h3>
    <p>${continuous ? L`この世界は続きます。戦期の区切り・勝敗・集計は未決定です。州・時間は、州を保った時間の記録です（1州を1時間で1州・時間）。` : intro}</p>
    ${continuous ? html`<p class="conquest-season-clock">${L`この世界は続きます（終わりの時刻はありません）。戦期は未決定です。`}</p>`
      : ended ? html`<p class="conquest-season-clock muted">${L`この試しの世界は第${fmtNum(endBell)}ターンで新しい命令の受付を終えました。試しの世界の上限で、勝ち負けの決まりではありません。`}${isFinal ? '' : html` ${L`最後の戦いの記録を待っています。`}`}</p>`
      : FS.sample?.demo ? ''   /* (walletless demo: no test-world end turn while it is ahead; seasonterms deadlineLine) */
      : html`<p class="conquest-season-clock">${L`この試しの世界が新しい命令を受け付けるのは第${fmtNum(endBell)}ターンまでです（残り：${turnsLine(Math.max(0, endBell - (FS.nowBell ?? 0)))}）。試しの世界の上限で、勝ち負けの決まりではありません。`}</p>`}
    ${rows ? html`<table class="stores conquest-scores"><thead><tr><th>${L`記録順`}</th><th>${L`国`}</th><th>${L`支配する州`}</th><th>${L`州・時間`}</th></tr></thead><tbody>${rows.map(r => html`<tr class="${r.faction === FS.citizen?.faction ? 'is-mine' : ''}"><td>${fmtNum(r.rank)}</td><th scope="row"><span class="cs-nation kh-n${r.faction}">${crest(r.faction, 22)}<span>${factionName(r.faction)}</span></span>${r.faction === FS.citizen?.faction ? html` <span class="tag">${L`あなたの国`}</span>` : ''}</th><td>${fmtNum(r.provinces)}</td><td>${fmtNum(Math.round(Number(r.score) * seconds / 360) / 10)}</td></tr>`)}</tbody></table>
      <p class="muted">${L`第${fmtNum(record.bell)}ターンまでの州・時間の参考記録です。記録だけで、これで勝ち負けや賞金は決まりません。`}</p>` : html`<p class="muted">${cq?.status === 'error' ? L`記録を読み込めませんでした。再取得してください。` : L`州・時間の記録を読み込んでいます。`}</p>`}
    ${!isFinal ? html`<button type="button" class="btn small" data-act="cq-refresh" ${raw(busy(FS) || cq?.status === 'loading' ? 'disabled' : '')}>${L`世界の状況を更新する`}</button>` : ''}
  </section>`;
}

export function render(FS) {
  if (!conquestEnabled(FS)) return '';
  const selected = FS.selected;
  return html`<div class="conquest-panel">${renderStandings(FS)}${renderReach(FS)}${selected ? renderKeep(FS, keepFor(FS, selected.p, selected.q)) : html`<p class="muted">${L`地図の州を選ぶと、砦と争奪の状況を確認できます。`}</p>`}</div>`;
}
