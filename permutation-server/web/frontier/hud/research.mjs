// World goal ② "world-first technology" — the research part of the world goals card (hud/worldgoals.mjs), read from the
// judge's answer (`research`, permutation-gateway world-research.mjs; owner r0ze 2026-11-25 08:56, every Q-RS
// recommendation). Read only: the pledge itself is the village card's button (screens/holding.mjs → flocalplay-research.mjs).
//
// Fog (Q-RS-9 (1) (b)): the world's era, which nations know which tech and the world firsts are public; how far a nation
// has got ("120 / 300") is told for the viewer's own nation only — the judge answers it for `?nation=` alone.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { TECHS } from '../flocalplay-research.mjs';

const nation = f => Number.isInteger(f) && f >= 0 && f < 6;
const int = x => Number.isSafeInteger(x);
const intOrNull = x => x === null || Number.isSafeInteger(x);

/** The tech's name (design 01 §5.2; the EN table carries the English). */
export const techName = key => ({
  agriculture: L`農耕`, masonry: L`石工`, bronze: L`青銅`, roads: L`道`, writing: L`筆記`, wallcraft: L`城壁術`, iron: L`鉄`,
  cartography: L`地図作り`, currency: L`通貨`, fortification: L`築城`, navigation: L`航海`, administration: L`行政`,
}[key] ?? key);

/** The tech's effect (the existing numeric knob it moves; Q-RS-9 (2) readings for eras 2–3). */
export const techEffect = key => ({
  agriculture: L`食料の産出 +10%`, masonry: L`建設の時間 −10%`, bronze: L`兵の訓練費（鉱石）−10%`, roads: L`隊商・行軍の時間 −5%`,
  writing: L`科学の産出 +10%`, wallcraft: L`村の包囲に要るターン +10%`, iron: L`兵の強さ +5%`, cartography: L`霧の見える範囲 +1（ページの表示）`,
  currency: L`金の産出 +10%`, fortification: L`砦を取るのに要るターン +10%`, navigation: L`村を置く費用 −10%`, administration: L`倉庫の上限 +10%`,
}[key] ?? '');

const goodTech = t => t && int(t.id) && t.id >= 0 && t.id < TECHS.length && typeof t.key === 'string' && int(t.era) && typeof t.open === 'boolean' && intOrNull(t.firstBell)
  && Array.isArray(t.firstNations) && t.firstNations.every(nation) && Array.isArray(t.knownBy) && t.knownBy.every(nation)
  && (t.mine === undefined || (t.mine && typeof t.mine.known === 'boolean' && int(t.mine.pledged) && int(t.mine.cost) && int(t.mine.left)));
/** Whether the answer's research part is well formed (null = research never started in this world). */
export function goodResearch(r) {
  return r === null || r === undefined || (!!r && r.view && int(r.view.era) && int(r.view.startBell) && typeof r.view.paused === 'boolean' && Array.isArray(r.view.techs) && r.view.techs.every(goodTech)
    && Array.isArray(r.history) && r.history.every(h => h && int(h.tech) && int(h.bell) && Array.isArray(h.nations) && h.nations.every(nation) && h.prize?.simulated === true && Array.isArray(h.prize.rows)));
}

/** The query that asks the judge for the viewer's nation's totals (`?nation=f`), or ''. */
export const researchQuery = FS => (nation(FS?.citizen?.faction) ? `?nation=${FS.citizen.faction}` : '');

/** The tech the viewer's nation may pledge now, by id (null: the judge said no, or there is no answer). */
export function pledgeableTechs(g) {
  return (g?.research?.view?.techs ?? []).filter(t => t.mine && t.mine.refusal === null);
}

function techRow(t, view, me, bell) {
  const firstNames = t.firstNations.map(n => factionName(n)).join(L`、`);
  const first = t.firstBell !== null ? L`世界初：${firstNames}（ターン ${fmtNum(t.firstBell)}）` : L`世界初はまだです`;
  const known = t.knownBy.length ? L`覚えた国 ${fmtNum(t.knownBy.length)}` : '';
  let mine = '';
  if (t.mine) {
    mine = t.mine.known
      ? html`<span class="tech-mine known" data-known="1">${L`あなたの国は覚えました`}</span>`
      : html`<span class="tech-mine" data-pledged="${t.mine.pledged}" data-cost="${t.mine.cost}"><meter min="0" max="${t.mine.cost}" value="${Math.min(t.mine.pledged, t.mine.cost)}"></meter> ${L`あなたの国 ${fmtNum(t.mine.pledged)} / ${fmtNum(t.mine.cost)}`}${t.knownBy.some(n => n !== me) ? html` <small class="muted">${L`（ほかの国が覚えたので安くなっています）`}</small>` : ''}</span>`;
  }
  const roads = t.key === 'roads' && view.roadsEffectLive === false ? html` <small class="muted" data-effect="not-live">${L`効果はまだ動いていません（準備中）`}</small>` : '';
  return html`<li class="goal-tech${t.firstNations.includes(me) ? ' mine' : ''}" data-tech="${t.key}" data-first-bell="${t.firstBell ?? ''}"><b>${techName(t.key)}</b> · <small>${techEffect(t.key)}</small>${roads}<br><small class="muted">${first}${known ? ` · ${known}` : ''}</small>${mine ? html`<br>${mine}` : ''}</li>`;
}

/** The research part of the card for an answer `g` (the world goals' judge), '' when research never started. */
export function renderResearch(FS, g) {
  const r = g?.research;
  if (!r || !goodResearch(r)) return '';
  const v = r.view, me = FS?.citizen?.faction, bell = g.bell;
  const open = v.techs.filter(t => t.open);
  const state = v.paused ? html`<p class="warn" data-research="paused">${L`研究は止まっています（運営の安全弁）。覚えた技術と効果はそのままです`}</p>`
    : int(bell) && bell < v.startBell ? html`<p class="muted" data-research="soon">${L`研究はターン ${fmtNum(v.startBell)} に始まります。それまでに作った科学は差し出せません（始まった後に作った科学だけが数えられます）`}</p>` : '';
  const head = html`<h4 class="goal-research-title">${L`世界初の技術（学術）：時代 ${fmtNum(v.era)}`}</h4>`;
  const rule = html`<p class="muted small">${L`村の科学を国の研究に差し出し（村のカード）、費用に届いた国がその技術を覚えます。世界で最初に覚えた国が「世界初」です（同じターンなら同点）。ほかの国が覚えた技術は、1 国につき 20% 安くなります（最大 60%）。国が同じ時代の技術を 3 つ覚えると、次の時代が開きます`}</p>`;
  const later = v.techs.some(t => !t.open) ? html`<p class="muted small">${L`時代 2・3 の技術は準備中です（この世界では、まだ差し出せません）`}</p>` : '';
  const mine = r.history.filter(h => nation(me) && h.nations.includes(me));
  const hist = r.history.length ? html`<ul class="goal-research-firsts">${[...r.history].reverse().slice(0, 6).map(h => {
    const row = typeof FS?.wallet?.address === 'string' ? h.prize.rows.find(x => x.wallet === FS.wallet.address) : null;
    const you = row ? (row.eligible ? L`賞金が有効なら、あなたは ${usdcText(row.amount)} テスト USDC を受け取っていました（貢献 ${fmtNum(row.points)} 点）` : L`賞金が有効でも、あなたの受け取りは 0 です（貢献 ${fmtNum(row.points)} 点）`) : '';
    const names = h.nations.map(n => factionName(n)).join(L`、`);
    return html`<li data-first="${h.tech}">${L`${techName(TECHS[h.tech]?.key)}：${names}が世界初（ターン ${fmtNum(h.bell)}）`}${you ? html`<br><small>${you}</small>` : ''}</li>`;
  })}</ul>` : '';
  return html`<div class="goal-research" data-era="${v.era}" data-firsts="${r.history.length}" data-mine="${mine.length}">${head}${state}${rule}
    <ol class="goal-techs">${open.map(t => techRow(t, v, me, bell))}</ol>${later}${hist}</div>`;
}

const usdcText = v => {
  const s = String(v).padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0';
};

/**
 * The research refusal's own words (the program answers with shared error numbers; proc/wide_research.rs
 * refusal_err): what happened, why, what to do. null for a code this does not explain.
 */
export const researchRefusalText = pc => (pc === 13 ? L`研究はまだ始まっていないか、運営が止めています。始まりのターンを過ぎてから、もう一度差し出してください。`
  : pc === 12 ? L`この技術の時代はまだ開いていません。今の時代の技術を差し出してください。`
  : pc === 40 ? L`前提の技術を、あなたの国がまだ覚えていません。先に前提の技術を差し出してください。`
  : pc === 52 ? L`この技術は、あなたの国がもう覚えました。ほかの技術を選んでください。`
  : pc === 21 ? L`村の科学が足りません。研究の始まりより前に貯めた科学は数えられません（始まった後に作った分だけです）。`
  : pc === 43 ? L`国から追放されているので、研究に差し出せません。`
  : pc === 99 ? L`この世界では研究が始まっていません。`
  : null);

/**
 * The village card's research part: the techs the viewer's nation may pledge to (its totals, from the judge's answer
 * `b` = worldGoals.current()), the two-press pledge of the village's science, and the effects of the techs the nation
 * knows that have not reached this village yet. '' without research or a nation.
 */
export function villageResearchCard(FS, h, { science, busy = false, answer = null } = {}) {
  const g = answer?.read === 'ok' ? answer.goals : null;
  const r = g?.research, me = FS?.citizen?.faction;
  if (!r || !goodResearch(r) || !nation(me) || !h) return '';
  const v = r.view, bell = g.bell;
  const started = !v.paused && !(int(bell) && bell < v.startBell);
  const sci = Math.max(0, Math.floor(Number(science) || 0));
  const mask = h.researchMask ?? null;
  const inVillage = mask && mask.nation === me ? mask.techs : 0;
  const known = v.techs.filter(t => t.mine?.known).reduce((a, t) => a | (1 << t.id), 0);
  const pending = known & ~inVillage;
  const at = `${h.p},${h.q},${h.site}`;
  const arm = FS.ui?.researchArm && FS.ui.researchArm.at === at ? FS.ui.researchArm : null;
  const open = v.techs.filter(t => t.mine && t.mine.refusal === null);
  const rows = open.map(t => {
    const amount = Math.min(sci, t.mine.left || 1);
    const armed = arm && arm.tech === t.id;
    const line = html`<span>${techName(t.key)} <small class="muted">${techEffect(t.key)}</small><br><small>${L`あなたの国 ${fmtNum(t.mine.pledged)} / ${fmtNum(t.mine.cost)}（あと ${fmtNum(t.mine.left)}）`}</small></span>`;
    if (armed) return html`<li class="research-armed" data-tech="${t.key}">${line}<p class="warn">${L`科学 ${fmtNum(arm.amount)} を「${techName(t.key)}」に差し出します。差し出した科学は戻りません。`}</p>
      <div class="actions"><button type="button" class="btn small primary" data-act="research-pledge" data-tech="${t.id}" data-amount="${arm.amount}" ${raw(busy ? 'disabled' : '')}>${L`署名して差し出す`}</button>
      <button type="button" class="btn small ghost" data-act="research-cancel">${L`やめる`}</button></div></li>`;
    return html`<li data-tech="${t.key}">${line}<button type="button" class="btn small" data-act="research-arm" data-tech="${t.id}" data-amount="${amount}" aria-label="${L`研究に差し出す`}: ${techName(t.key)}" ${raw(busy || !started || amount < 1 ? 'disabled' : '')}>${L`差し出す（${fmtNum(amount)}）`}</button></li>`;
  });
  const fx = pending ? html`<p class="research-pending" data-pending="${pending}">${L`国が覚えた技術の効果が、まだこの村に届いていません`}: ${v.techs.filter(t => pending & (1 << t.id)).map(t => techName(t.key)).join(L`、`)}
      <button type="button" class="btn small" data-act="research-apply" ${raw(busy ? 'disabled' : '')}>${L`効果を村に届ける`}</button></p>`
    : inVillage ? html`<p class="muted small" data-in-village="${inVillage}">${L`この村で効いている技術`}: ${v.techs.filter(t => inVillage & (1 << t.id)).map(t => techName(t.key)).join(L`、`)}</p>` : '';
  const cut = mask?.rebased ? '' : html`<p class="muted small">${L`研究の始まり（ターン ${fmtNum(v.startBell)}）より前に貯めた科学は数えられません。この村から最初に差し出すときに、始まった後に作った分まで切り下げられます。`}</p>`;
  return html`<section class="vcard village-research" aria-labelledby="hp-research-h" data-science="${sci}">
    <header class="c-head"><span class="c-titles"><h3 id="hp-research-h">${L`研究に差し出す`}</h3><span class="c-sub">${L`村の科学 ${fmtNum(sci)}`}</span></span></header>
    ${started ? '' : html`<p class="muted">${v.paused ? L`研究は止まっています（運営の安全弁）。` : L`研究はターン ${fmtNum(v.startBell)} に始まります。`}</p>`}
    ${open.length ? html`<ul class="build-list research-list">${rows}</ul>` : html`<p class="muted">${L`今の時代で、あなたの国が差し出せる技術はありません`}</p>`}
    ${cut}${fx}</section>`;
}
