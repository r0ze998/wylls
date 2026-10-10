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
import { L, fmtNum } from '../../lang.mjs';
import { factionName, UNITS, RESOURCES, RESOURCE_ORDER, routeLine, clientText } from '../fi18n.mjs';
import { activeHolding } from '../fstate.mjs';
import { actionBlocks, UNIT_ORDER, SCOUT, SETTLER } from '../fland.mjs';
import { DEPART_STAMINA } from '../fmarch.mjs';
import { hostRows } from './host.mjs';
import { countdown } from '../clock.mjs';

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
  const keeps = FS.conquest?.keeps;
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
export const reachLink = FS => (conquestEnabled(FS) && FS.mode === 'play' ? html`<button type="button" class="btn small" data-act="tab" data-tab="nation">${L`届く砦の一覧を見る`}</button>` : '');

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
 * 'taken', holder, from?, troops?}], last}`, oldest first; `last` is the
 * latest capture. Null without a readable record.
 */
export function keepHistory(h) {
  const nation = f => Number.isInteger(f) && f >= 0 && f <= 5, bell = b => Number.isInteger(b) && b >= 0;
  if (!h || !Array.isArray(h.holders) || !Array.isArray(h.captures)) return null;
  const taken = h.captures.filter(c => bell(c.bell) && nation(c.from) && nation(c.to)).map(c => ({ bell: c.bell, kind: 'taken', holder: c.to, from: c.from, troops: Number.isFinite(c.troops) ? c.troops : null }));
  const rows = [...h.holders.filter(x => nation(x.holder) && bell(x.since)).map(x => ({ bell: x.since, kind: 'held', holder: x.holder })), ...taken]
    .sort((a, b) => a.bell - b.bell || (a.kind === 'taken' ? -1 : 1));
  return rows.length ? { rows, last: taken.at(-1) ?? null } : null;
}

function renderHistory(hist) {
  if (!hist) return '';
  return html`<div class="conquest-history"><h5>${L`砦の履歴`}</h5>
    <ol class="list">${hist.rows.map(r => html`<li>${r.kind === 'taken'
      ? html`${L`第${fmtNum(r.bell)}ターン：${factionName(r.holder)}が${factionName(r.from)}から奪取`}${r.troops !== null ? html` <span class="muted">${L`守備兵 ${fmtNum(r.troops)}`}</span>` : ''}`
      : L`第${fmtNum(r.bell)}ターンから：${factionName(r.holder)}が保持`}</li>`)}</ol></div>`;
}

export function renderKeep(FS, keep) {
  if (!conquestEnabled(FS)) return '';
  if (keep?.tile === 255) return html`<p class="muted">${L`この州には砦がありません。`}</p>`;
  const m = keepModel(FS, keep);
  if (!m) return html`<section class="conquest-keep hpanel"><h4>${L`この州の砦`}</h4><p class="muted">${L`砦の情報を確認しています。`}</p></section>`;
  const owner = m.holder < 6 ? factionName(m.holder) : L`中立`;
  const ended = (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity);
  const hist = keepHistory(FS.conquest?.history?.get?.(`${m.p},${m.q}`));
  return html`<section class="conquest-keep hpanel" aria-label="${L`この州の砦`}"><h4>⚑ ${L`この州の砦`} <span class="muted">${L`マス ${fmtNum(m.tile + 1)}`}</span></h4>
    <dl class="facts"><div class="row"><dt>${L`支配国`}</dt><dd>${owner}${m.mine ? html` · ${L`あなたの国`}` : ''}</dd></div>
      ${hist?.last ? html`<div class="row"><dt>${L`前の支配国`}</dt><dd>${factionName(hist.last.from)} · ${L`第${fmtNum(hist.last.bell)}ターンに交代`}</dd></div>` : ''}
      <div class="row"><dt>${L`砦の守備兵`}</dt><dd>${Number.isFinite(m.troops) ? fmtNum(m.troops) : L`確認中`}</dd></div>
      ${Number.isInteger(m.asOfBell) ? html`<div class="row"><dt>${L`最終確認`}</dt><dd>${L`第${fmtNum(m.asOfBell)}ターン`}</dd></div>` : ''}</dl>
    ${m.heartland ? html`<p class="muted">${L`本国の中核地です。この砦は奪取されません。`}</p>` : m.protectedFor > 0 ? html`<p class="muted">${L`占領後の保護中です。あと${span(m.protectedFor * bellSeconds(FS))}（ゲーム内）で再び争奪できます。`}</p>` : html`<p>${L`砦を保持する国がこの州を支配します。シーズンの終わりに支配する州が最も多い国が勝ちます。`}</p>`}
    ${!m.heartland && !m.mine && !m.protectionKnown ? html`<p class="muted">${L`この砦の保護状態を確認しています。`}</p>` : ''}
    ${m.contender !== null ? html`<div class="conquest-progress"><p>${L`${factionName(m.contender)}が争奪中`} · ${Number.isFinite(m.required) ? L`${fmtNum(m.progress)} / ${fmtNum(m.required)}ターン` : L`進捗を確認中`}</p>
      ${Number.isFinite(m.required) && m.required > 0 ? html`<progress max="${m.required}" value="${Math.min(m.progress, m.required)}" aria-label="${L`砦の争奪状況`}"></progress>` : ''}
      ${m.remaining !== null ? html`<p class="muted">${m.remaining > 0 ? L`占拠を保てた場合、あと${span(m.remaining * bellSeconds(FS))}（ゲーム内）。敵の抵抗で進捗は変わります。` : L`争奪の処理結果を待っています。`}</p>` : ''}</div>` : ''}
    ${renderHistory(hist)}
    ${FS.mode === 'play' && !ended && (m.mine || m.canContest) ? html`<div class="conquest-orders"><p>${m.mine ? L`守りに送る軍勢を選ぶ` : L`この砦へ送る軍勢を選ぶ`}</p>
      ${m.hosts.length ? html`<div class="actions">${m.hosts.map(h => html`<button type="button" class="btn" data-act="cq-march" data-host="${String(h.id)}" data-p="${m.p}" data-q="${m.q}" data-tile="${m.tile}" ${raw(busy(FS) ? 'disabled' : '')}>${UNITS[UNIT_ORDER[h.unit]]} ${fmtNum(h.troops)} · ${L`進軍を準備`}</button>`)}</div>${!m.mine && keepUnreachable(FS, m) ? html`<p class="blocked" role="note">${L`この砦へは届く道がありません（進軍は4州まで）`} ${reachLink(FS)}</p>` : ''}` : html`<p class="muted">${L`出発できる戦闘部隊がいません。兵を訓練し、軍勢を編成してください。`}</p><button type="button" class="btn" data-act="tab" data-tab="holding">${L`村で兵を準備する`}</button>`}
    </div>` : ''}
  </section>`;
}

export function renderOutpost(FS, site) {
  if (!conquestEnabled(FS) || FS.mode !== 'play' || !site || !activeHolding(FS)) return '';
  const o = FS.conquest?.outpost;
  if (!o) return html`<p class="muted">${L`前哨を築ける条件を確認しています。`}</p>`;
  const ended = (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity);
  const targetMatches = !o.target || (o.target.p === site.p && o.target.q === site.q && o.target.site === site.site);
  return html`<section class="conquest-outpost"><h4>${L`前哨を築く`}</h4><p>${L`前哨は、現在の村から領土を広げる足場になります。申請後に場所が確定します。`}</p>
    ${o.cost ? html`<p>${o.cost.map((v, i) => v ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(v)}` : '').filter(Boolean).join(' · ')}</p>` : ''}
    <p class="muted">${L`資源は申請時に支払います。申請の期限切れや、仮の入植地が競合で失われた場合も返還されません。`}</p>
    ${o.reason ? html`<p class="blocked">${o.reason}</p>` : ''}
    <button type="button" class="btn" data-act="cq-outpost" data-p="${site.p}" data-q="${site.q}" data-site="${site.site}" ${raw(busy(FS) || ended || !targetMatches || o.pending || o.eligible !== true ? 'disabled' : '')}>${o.pending ? L`前哨の申請を確認しています` : L`この区画に前哨を申請する`}</button>
  </section>`;
}

/** The keeps of other nations a march of the viewer can reach now, nearest first. */
export function renderReach(FS) {
  if (!conquestEnabled(FS) || FS.mode !== 'play' || !activeHolding(FS) || !Number.isInteger(FS.citizen?.faction)) return '';
  if ((FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity)) return '';
  const r = FS.conquest?.reach;
  const row = x => html`<li><strong>${L`州 ${x.p},${x.q}`}</strong> · ${factionName(x.holder)}${Number.isFinite(x.troops) ? html` · ${L`守備兵 ${fmtNum(x.troops)}`}` : ''} · ${routeLine(x.route)}${x.origin?.host ? html` <span class="muted">${UNITS[UNIT_ORDER[x.origin.unit]]} ${fmtNum(x.origin.troops)}</span>` : ''}
    <button type="button" class="btn small" data-act="goto" data-p="${x.p}" data-q="${x.q}">${L`そこへ移動`}</button></li>`;
  return html`<section class="conquest-reach hpanel" aria-labelledby="conquest-reach-title"><h4 id="conquest-reach-title">${L`あなたの軍が届く他国の砦`}</h4>
    ${!r ? html`<p class="muted">${L`届く砦を調べています…`}</p>` : !r.ok ? html`<p class="muted">${clientText(r.code)}</p>` : html`
      ${r.home ? html`<p class="muted">${L`出発できる戦闘部隊がいないため、村からの道のりで調べています。`}</p>` : ''}
      ${r.rows.length ? html`<ul class="list">${r.rows.map(row)}</ul>` : html`<p>${L`いま届く他国の砦はありません。進軍が越えられるのは4州までです。`}</p>`}`}
  </section>`;
}

export function renderStandings(FS) {
  if (!conquestEnabled(FS)) return '';
  const cq = FS.conquest, ended = (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity);
  const record = ended && cq?.final ? cq.final : cq?.standings;
  const rows = scoreRows(record);
  const isFinal = ended && record === cq?.final && !!rows;
  const seconds = bellSeconds(FS);
  const winners = isFinal ? rows.filter(r => r.rank === 1).map(r => factionName(r.faction)) : [];
  return html`<section class="conquest-standings hpanel" aria-labelledby="conquest-standings-title"><h3 id="conquest-standings-title">${isFinal ? L`シーズンの結果` : L`国の領土と得点`}</h3>
    <p>${L`シーズンの終わりに、支配する州が最も多い国が勝ちます。州・時間は、州を保った時間の記録です（1州を1時間で1州・時間）。`}</p>
    ${ended ? html`<p class="${isFinal ? 'conquest-result' : 'muted'}">${isFinal ? winners.length === 1 ? L`${winners[0]}の勝利` : L`同点首位：${winners.join(' / ')}` : L`シーズンは終了しました。最後の戦いと得点の確定を待っています。`}</p>` : html`<p class="conquest-season-clock">${L`シーズン終了まで ${span(Math.max(0, Number(FS.season?.endBell ?? 0) - (FS.nowBell ?? 0)) * seconds)}（ゲーム内）`}</p>`}
    ${rows ? html`<table class="stores conquest-scores"><thead><tr><th>${L`順位`}</th><th>${L`国`}</th><th>${L`支配する州`}</th><th>${L`州・時間`}</th></tr></thead><tbody>${rows.map(r => html`<tr class="${r.faction === FS.citizen?.faction ? 'is-mine' : ''}"><td>${fmtNum(r.rank)}</td><th scope="row">${factionName(r.faction)}${r.faction === FS.citizen?.faction ? html` <span class="tag">${L`あなたの国`}</span>` : ''}</th><td>${fmtNum(r.provinces)}</td><td>${fmtNum(Number(r.score) * seconds / 3600)}</td></tr>`)}</tbody></table>
      <p class="muted">${L`第${fmtNum(record.bell)}ターンまでの確定した得点`}</p>` : html`<p class="muted">${cq?.status === 'error' ? L`得点を読み込めませんでした。再取得してください。` : L`確定した得点を読み込んでいます。`}</p>`}
    ${!isFinal ? html`<button type="button" class="btn small" data-act="cq-refresh" ${raw(busy(FS) || cq?.status === 'loading' ? 'disabled' : '')}>${L`世界の状況を更新する`}</button>` : ''}
  </section>`;
}

export function render(FS) {
  if (!conquestEnabled(FS)) return '';
  const selected = FS.selected;
  return html`<div class="conquest-panel">${renderStandings(FS)}${renderReach(FS)}${selected ? renderKeep(FS, keepFor(FS, selected.p, selected.q)) : html`<p class="muted">${L`地図の州を選ぶと、砦と争奪の状況を確認できます。`}</p>`}</div>`;
}
