// Shared-world conquest views. No ownership or score is inferred from map colours.
// Controller contract: FS.conquest = { status, error?, keeps: Map<PQ, Keep>,
// standings?: {metric:'province-bells',bell,rows}, final?: same, outpost? }.
// Keep: {p,q,tile,holder,troops (whole units),heartland,consolidatedUntil,contender,
// progress,requiredBells,asOfBell}. Rows: {faction,provinces,provinceBells}.
// Outpost: {eligible,pending,reason?,cost? (whole resources)}; the selected free site.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName, UNITS, RESOURCES, RESOURCE_ORDER } from '../fi18n.mjs';
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
  rows.sort((a, b) => a.score === b.score ? a.faction - b.faction : a.score > b.score ? -1 : 1);
  return rows.map((r, i) => ({ ...r, rank: rows.findIndex(x => x.score === r.score) + 1 }));
}

export function keepFor(FS, p, q) {
  const keeps = FS.conquest?.keeps;
  return keeps instanceof Map ? keeps.get(`${p},${q}`) ?? null : keeps?.[`${p},${q}`] ?? null;
}

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
  const hosts = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER && r.state === 1 && !r.inTransit && !r.pending && r.readyBell <= bell && r.stamina >= DEPART_STAMINA
    && !actionBlocks('Depart', { holding: activeHolding(FS), province: r.province, now: FS.chain?.now?.() ?? 0, nowBell: bell, host: r }).length);
  return { ...keep, mine, heartland, protectionKnown, protectedFor, contender, required, progress, remaining, hosts, canContest: protectionKnown && !heartland && !protectedFor };
}

export function renderKeep(FS, keep) {
  if (!conquestEnabled(FS)) return '';
  if (keep?.tile === 255) return html`<p class="muted">${L`この州には砦がありません。`}</p>`;
  const m = keepModel(FS, keep);
  if (!m) return html`<section class="conquest-keep hpanel"><h4>${L`この州の砦`}</h4><p class="muted">${L`砦の情報を確認しています。`}</p></section>`;
  const owner = m.holder < 6 ? factionName(m.holder) : L`中立`;
  const ended = (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity);
  return html`<section class="conquest-keep hpanel" aria-label="${L`この州の砦`}"><h4>⚑ ${L`この州の砦`} <span class="muted">${L`マス ${fmtNum(m.tile + 1)}`}</span></h4>
    <dl class="facts"><div class="row"><dt>${L`支配国`}</dt><dd>${owner}${m.mine ? html` · ${L`あなたの国`}` : ''}</dd></div>
      <div class="row"><dt>${L`砦の守備兵`}</dt><dd>${Number.isFinite(m.troops) ? fmtNum(m.troops) : L`確認中`}</dd></div>
      ${Number.isInteger(m.asOfBell) ? html`<div class="row"><dt>${L`最終確認`}</dt><dd>${L`第${fmtNum(m.asOfBell)}ターン`}</dd></div>` : ''}</dl>
    ${m.heartland ? html`<p class="muted">${L`本国の中核地です。この砦は奪取されません。`}</p>` : m.protectedFor > 0 ? html`<p class="muted">${L`占領後の保護中です。あと${span(m.protectedFor * bellSeconds(FS))}（ゲーム内）で再び争奪できます。`}</p>` : html`<p>${L`砦を保持する国がこの州を支配し、保持した時間が国の得点になります。`}</p>`}
    ${!m.heartland && !m.mine && !m.protectionKnown ? html`<p class="muted">${L`この砦の保護状態を確認しています。`}</p>` : ''}
    ${m.contender !== null ? html`<div class="conquest-progress"><p>${L`${factionName(m.contender)}が争奪中`} · ${Number.isFinite(m.required) ? L`${fmtNum(m.progress)} / ${fmtNum(m.required)}ターン` : L`進捗を確認中`}</p>
      ${Number.isFinite(m.required) && m.required > 0 ? html`<progress max="${m.required}" value="${Math.min(m.progress, m.required)}" aria-label="${L`砦の争奪状況`}"></progress>` : ''}
      ${m.remaining !== null ? html`<p class="muted">${m.remaining > 0 ? L`占拠を保てた場合、あと${span(m.remaining * bellSeconds(FS))}（ゲーム内）。敵の抵抗で進捗は変わります。` : L`争奪の処理結果を待っています。`}</p>` : ''}</div>` : ''}
    ${FS.mode === 'play' && !ended && (m.mine || m.canContest) ? html`<div class="conquest-orders"><p>${m.mine ? L`守りに送る軍勢を選ぶ` : L`この砦へ送る軍勢を選ぶ`}</p>
      ${m.hosts.length ? html`<div class="actions">${m.hosts.map(h => html`<button type="button" class="btn" data-act="cq-march" data-host="${String(h.id)}" data-p="${m.p}" data-q="${m.q}" data-tile="${m.tile}" ${raw(busy(FS) ? 'disabled' : '')}>${UNITS[UNIT_ORDER[h.unit]]} ${fmtNum(h.troops)} · ${L`進軍を準備`}</button>`)}</div>` : html`<p class="muted">${L`出発できる戦闘部隊がいません。兵を訓練し、軍勢を編成してください。`}</p><button type="button" class="btn" data-act="tab" data-tab="holding">${L`村で兵を準備する`}</button>`}
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

export function renderStandings(FS) {
  if (!conquestEnabled(FS)) return '';
  const cq = FS.conquest, ended = (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity);
  const record = ended && cq?.final ? cq.final : cq?.standings;
  const rows = scoreRows(record);
  const isFinal = ended && record === cq?.final && !!rows;
  const seconds = bellSeconds(FS);
  const winners = isFinal ? rows.filter(r => r.rank === 1).map(r => factionName(r.faction)) : [];
  return html`<section class="conquest-standings hpanel" aria-labelledby="conquest-standings-title"><h3 id="conquest-standings-title">${isFinal ? L`シーズンの結果` : L`国の領土と得点`}</h3>
    <p>${L`州を保った時間が得点です。1州を1時間保つと、1州・時間になります。`}</p>
    ${ended ? html`<p class="${isFinal ? 'conquest-result' : 'muted'}">${isFinal ? winners.length === 1 ? L`${winners[0]}の勝利` : L`同点首位：${winners.join(' / ')}` : L`シーズンは終了しました。最後の戦いと得点の確定を待っています。`}</p>` : html`<p class="conquest-season-clock">${L`シーズン終了まで ${span(Math.max(0, Number(FS.season?.endBell ?? 0) - (FS.nowBell ?? 0)) * seconds)}（ゲーム内）`}</p>`}
    ${rows ? html`<table class="stores conquest-scores"><thead><tr><th>${L`順位`}</th><th>${L`国`}</th><th>${L`支配する州`}</th><th>${L`州・時間`}</th></tr></thead><tbody>${rows.map(r => html`<tr class="${r.faction === FS.citizen?.faction ? 'is-mine' : ''}"><td>${fmtNum(r.rank)}</td><th scope="row">${factionName(r.faction)}${r.faction === FS.citizen?.faction ? html` <span class="tag">${L`あなたの国`}</span>` : ''}</th><td>${fmtNum(r.provinces)}</td><td>${fmtNum(Number(r.score) * seconds / 3600)}</td></tr>`)}</tbody></table>
      <p class="muted">${L`第${fmtNum(record.bell)}ターンまでの確定した得点`}</p>` : html`<p class="muted">${cq?.status === 'error' ? L`得点を読み込めませんでした。再取得してください。` : L`確定した得点を読み込んでいます。`}</p>`}
    ${!isFinal ? html`<button type="button" class="btn small" data-act="cq-refresh" ${raw(busy(FS) || cq?.status === 'loading' ? 'disabled' : '')}>${L`世界の状況を更新する`}</button>` : ''}
  </section>`;
}

export function render(FS) {
  if (!conquestEnabled(FS)) return '';
  const selected = FS.selected;
  return html`<div class="conquest-panel">${renderStandings(FS)}${selected ? renderKeep(FS, keepFor(FS, selected.p, selected.q)) : html`<p class="muted">${L`地図の州を選ぶと、砦と争奪の状況を確認できます。`}</p>`}</div>`;
}
