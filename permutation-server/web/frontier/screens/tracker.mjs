// The march tracker (web design §7.6, §8.4; contract §5.11, §9.1, I-24,
// I-44): per march — departed, arrival bell, beacon anchored, revealed (by
// this browser or a keeper), clash resolved, settled — with the secret
// destination shown only to this browser ("only you can see this"), the
// lock on the host until the transit is settled (HostInTransit), the rout
// warning when the window closed without a reveal, and the settle button
// once settlement is due (keepers usually settle first).
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { STANCES as STANCE_TEXT, TRANSIT_OUTCOME_TEXT, failureText } from '../fi18n.mjs';
import { STANCES, unpack } from '../seal.mjs';
import { materialBytes } from '../marchbook.mjs';
import { tracker } from '../fmarch.mjs';
import { lockedText } from './host.mjs';
import { icon } from '../hud/icons.mjs';
import { tileName } from '../hud/place.mjs';
import { chip, fold } from './parts.mjs';

const STEP_TEXT = {
  departed: () => L`出発`,
  arrivalBell: () => L`到着の鐘`,
  anchored: () => L`ビーコンが記録された（誰でも封を開けられる）`,
  revealed: () => L`開封された`,
  resolved: () => L`決着`,
  settled: () => L`精算`,
};
/** The six steps in one word each, for the track. */
const STEP_SHORT = { departed: () => L`出発`, arrivalBell: () => L`到着`, anchored: () => L`記録`, revealed: () => L`開封`, resolved: () => L`決着`, settled: () => L`精算` };
/** What a march waits for next (the first step not done). */
const WAIT_TEXT = { departed: () => L`出発の記録を待っています`, arrivalBell: () => L`到着の鐘を待っています`, anchored: () => L`鐘のビーコンの記録を待っています`, revealed: () => L`封が開くのを待っています`, resolved: () => L`衝突の決着を待っています`, settled: () => L`精算を待っています` };
const HINT_TEXT = {
  keepersWillReveal: () => L`この端末には封の記録がありません。開封はビーコンの後に自動で行われます。`,
  sealMismatch: () => L`チェーン上の封がこの端末で作った封と違います。この封は開封しません。`,
  sealed: () => L`封をしました（まだ送っていません）`,
  sent: () => L`送信しました。記録を待っています`,
  landed: () => L`出発しました`,
  revealing: () => L`この端末が開封を送りました`,
  revealed: () => L`開封されました`,
  settled: () => L`精算されました`,
  failed: () => L`送れませんでした`,
};

/**
 * The private line of a march this browser sealed: destination and orders (never sent before
 * the arrival bell). The destination by its name when the page's store is given.
 */
export function privateLine(entry, FS = null) {
  if (!entry) return null;
  const p = unpack(materialBytes(entry).plain);
  return L`${tileName(FS, p.destP, p.destQ, p.destTile)}（州 ${p.destP},${p.destQ}） · ${STANCE_TEXT[STANCES[p.stance]] ?? ''}`;
}

/** One march card: `m = {entry, transit, facts: {nowBell, pipeline, slotPresent, settled, settleReady}}`. */
export function renderMarch(m, FS = null) {
  const t = tracker({ entry: m.entry, transit: m.transit, ...m.facts });
  const secret = privateLine(m.entry, FS);
  const own = m.entry ? unpack(materialBytes(m.entry).plain) : null;
  const host = String(m.entry?.host ?? m.transit?.hostId ?? '');
  const resolved = t.steps.find(s => s.id === 'resolved')?.state === 'done';
  const now = t.steps.find(s => s.state === 'now') ?? null;
  const hint = t.route === 'self' ? L`到着の鐘の始まりにこの端末が開封を送ります（署名なし）。` : HINT_TEXT[t.hint]?.() ?? '';
  return html`<li class="vcard march-card">
    <div class="march-top">${icon('banner')}<strong class="march-to">${own ? L`${tileName(FS, own.destP, own.destQ, own.destTile)}へ` : m.dest ? L`州 ${m.dest.p},${m.dest.q} へ` : L`進軍`}</strong>${chip(html`${icon('bell')}${L`ターン ${fmtNum(t.arriveBell ?? 0)} に到着`}`, resolved ? 'ok' : 'info')}</div>
    ${secret ? html`<p class="march-secret">${icon('lock')}<span class="secret">${secret}</span> <span class="muted">${L`（あなたにだけ見えます）`}</span></p>` : ''}
    <ol class="track" aria-label="${L`進軍の段階`}">${t.steps.map(s => html`<li class="${s.state}" title="${STEP_TEXT[s.id]()}"><span class="track-dot" aria-hidden="true"></span><span class="track-name">${STEP_SHORT[s.id]()}</span>${s.state === 'now' ? html`<span class="visually-hidden">${L`（いま）`}</span>` : s.state === 'done' ? html`<span class="visually-hidden">${L`（済み）`}</span>` : ''}</li>`)}</ol>
    <p class="march-now"><strong>${now ? WAIT_TEXT[now.id]() : L`精算まで済みました`}</strong>${hint ? html` <span class="muted">${hint}</span>` : ''}</p>
    ${t.closedUnrevealed ? html`<p class="warn">${L`開封の受付が開封なしで閉じました。精算で敗走（兵・体力・チップの半分）になるか、到着枠に入れず損失なしで戻ります。`}</p>` : ''}
    ${t.outcome ? html`<p class="march-out">${TRANSIT_OUTCOME_TEXT[t.outcome] ?? t.outcome}</p>` : ''}
    ${m.entry?.failure ? html`<p class="notice error">${failureText({ code: m.entry.failure })}</p>` : ''}
    ${m.dest || m.facts?.settleReady ? html`<div class="actions">
      ${m.facts?.settleReady ? html`<button type="button" class="btn primary small" data-act="settle-transit" data-host="${host}" data-slot="${m.entry?.transitSlot ?? m.transit?.slot ?? ''}">${L`精算する`}</button>` : ''}
      ${m.dest && resolved && Number.isInteger(t.arriveBell) ? html`<button type="button" class="btn${m.facts?.settleReady ? '' : ' primary'} small" data-act="report-open" data-p="${m.dest.p}" data-q="${m.dest.q}" data-bell="${t.arriveBell}">${icon('scroll')}${L`報告`}</button>
        <button type="button" class="btn small" data-act="battle-play" data-p="${m.dest.p}" data-q="${m.dest.q}" data-bell="${t.arriveBell}">${icon('play')}${L`戦いを再生`}</button>` : ''}
      ${m.dest ? html`<button type="button" class="btn small" data-act="goto" data-p="${m.dest.p}" data-q="${m.dest.q}">${L`地図で見る`}</button>` : ''}</div>` : ''}
    ${t.locked ? fold(`m-lock-${host.replace(/\D/g, '').slice(-8)}`, L`この軍勢はまだ動かせません`, html`<p class="locked-note" role="note">${lockedText()}</p>`) : ''}
  </li>`;
}

export function render(FS) {
  const list = FS.marches ?? [];
  if (!list.length) return html`<section class="vcard" aria-labelledby="tracker-title"><h3 id="tracker-title" class="visually-hidden">${L`進軍`}</h3><p class="muted">${L`進軍中の軍勢はいません`}</p>
    <div class="actions"><button type="button" class="btn" data-act="tab" data-tab="hosts">${L`軍勢を開く`}</button></div></section>`;
  return html`<section class="bare" aria-labelledby="tracker-title"><h3 id="tracker-title" class="visually-hidden">${L`進軍`}</h3><ul class="marches">${list.map(m => renderMarch(m, FS))}</ul></section>`;
}

/** Whether the viewer's march list changed state (for the bell chip's dot and the polite announcement). */
export const stateKey = list => (list ?? []).map(m => `${m.entry?.host ?? m.transit?.hostId}:${m.entry?.state}:${m.transit?.state}:${m.facts?.pipeline}`).join('|');
