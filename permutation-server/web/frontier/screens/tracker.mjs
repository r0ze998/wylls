// The march tracker (web design §7.6, §8.4; contract §5.11, §9.1, I-24,
// I-44; UX design 11.13): per march, where it stands in three words a
// player reads — set out, arrived, the result — with the sealed destination
// shown only to this browser ("only you can see this"), the lock on the
// host until its result is collected (HostInTransit), the rout warning when
// the window closed without a reveal, and the button that collects the
// result once it is due (it is normally collected automatically). The
// rules' six steps (departed, the arrival turn, the key of the seal, the
// reveal, the clash resolved, the result collected) wait behind a fold.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { STANCES as STANCE_TEXT, TRANSIT_OUTCOME_TEXT, failureText, unitCount } from '../fi18n.mjs';
import { STANCES, unpack } from '../seal.mjs';
import { materialBytes } from '../marchbook.mjs';
import { tracker } from '../fmarch.mjs';
import { UNIT_ORDER } from '../fland.mjs';
import { lockedText, hostRows } from './host.mjs';
import { icon } from '../hud/icons.mjs';
import { tileName, provinceName } from '../hud/place.mjs';
import { chip, fold } from './parts.mjs';

/** The three things a player follows, each done when a step of the rules is: `[phase, the step that completes it]`. */
export const PHASES = Object.freeze([['depart', 'departed'], ['arrive', 'arrivalBell'], ['result', 'resolved']]);
const PHASE_TEXT = { depart: () => L`出発`, arrive: () => L`到着`, result: () => L`結果` };
/** The rules' six steps, each as what happened (the fold's list and the dots' titles). */
const STEP_TEXT = {
  departed: () => L`出発が記録された`,
  arrivalBell: () => L`到着のターンが始まった`,
  anchored: () => L`封を開ける鍵が出た（到着のターンが終わったあと）`,
  revealed: () => L`封が開けられた`,
  resolved: () => L`衝突が決着した`,
  settled: () => L`結果を受け取った`,
};
/** What a march waits for next (the first step not done). */
const WAIT_TEXT = { departed: () => L`出発が記録されるのを待っています`, arrivalBell: () => L`到着のターンを待っています`, anchored: () => L`到着しました。封を開ける鍵が出るのを待っています（ターンが終わると出ます）。`, revealed: () => L`封が開けられるのを待っています`, resolved: () => L`衝突の結果を待っています`, settled: () => L`結果が出ました。受け取りを待っています。` };
const HINT_TEXT = {
  keepersWillReveal: () => L`この端末には封の控えがありません。封は、到着のターンが終わったあと自動で開けられます。`,
  sealMismatch: () => L`チェーンに記録された封が、この端末で作った封と違います。この端末からは開けません。`,
  sealed: () => L`封をしました（まだ送っていません）`,
  sent: () => L`送りました。記録されるのを待っています。`,
  landed: () => L`出発しました`,
  revealing: () => L`この端末が封を開ける手続きを送りました`,
  revealed: () => L`封が開けられました`,
  settled: () => L`結果を受け取りました`,
  failed: () => L`送れませんでした`,
};

/**
 * The three phases of a tracker `t` (fmarch.mjs tracker): `[{id, state: 'done'|'now'|'next'}]` — the first phase not
 * done is "now".
 */
export function phasesOf(t) {
  const done = id => t.steps.find(s => s.id === id)?.state === 'done';
  let seen = false;
  return PHASES.map(([id, step]) => {
    if (done(step)) return { id, state: 'done' };
    if (!seen) { seen = true; return { id, state: 'now' }; }
    return { id, state: 'next' };
  });
}

/**
 * The private line of a march this browser sealed: destination and orders (never sent before
 * the arrival turn). The destination by its name when the page's store is given; its coordinates are not said.
 */
export function privateLine(entry, FS = null) {
  if (!entry) return null;
  const p = unpack(materialBytes(entry).plain);
  return L`${tileName(FS, p.destP, p.destQ, p.destTile)} · ${STANCE_TEXT[STANCES[p.stance]] ?? ''}`;
}

/** The marching host by its unit and troops (「槍兵 400」), from the province the page holds; null when it is not there. */
function hostName(FS, id) {
  if (!FS || !id) return null;
  let row = null;
  try { row = hostRows(FS).find(r => String(r.id) === String(id)) ?? null; } catch { row = null; }
  return row ? unitCount(UNIT_ORDER[row.unit], row.troops) : null;
}

/** One march card: `m = {entry, transit, facts: {nowBell, pipeline, slotPresent, settled, settleReady}}`. */
export function renderMarch(m, FS = null) {
  const t = tracker({ entry: m.entry, transit: m.transit, ...m.facts });
  const own = m.entry ? unpack(materialBytes(m.entry).plain) : null;
  const host = String(m.entry?.host ?? m.transit?.hostId ?? '');
  const who = hostName(FS, host);
  const stepDone = id => t.steps.find(s => s.id === id)?.state === 'done';
  const resolved = stepDone('resolved');
  const now = t.steps.find(s => s.state === 'now') ?? null;
  const hint = t.route === 'self' ? L`到着のターンが始まると、この端末が封を開けます（ウォレットの操作は要りません）。` : HINT_TEXT[t.hint]?.() ?? '';
  // the march by where it goes when this browser knows it (its own seal, or the record once the seal is open); else by the host
  const title = own ? L`${tileName(FS, own.destP, own.destQ, own.destTile)}へ` : m.dest ? L`${provinceName(FS, m.dest.p, m.dest.q)}へ` : who ? L`進軍：${who}` : L`進軍`;
  // what only this browser knows: the host and its stance, and who can see the destination now
  const sealed = own ? html`<p class="march-secret">${icon('lock')}<span class="secret">${[who, STANCE_TEXT[STANCES[own.stance]] ?? ''].filter(Boolean).join(' · ')}</span> <span class="muted">${stepDone('revealed') ? L`（封は開けられました）` : L`（行き先と構えはあなたにだけ見えます）`}</span></p>` : '';
  const state = s => (s.state === 'now' ? html`<span class="visually-hidden">${L`（いま）`}</span>` : s.state === 'done' ? html`<span class="visually-hidden">${L`（済み）`}</span>` : '');
  const slug = host.replace(/\D/g, '').slice(-8);
  return html`<li class="vcard march-card">
    <div class="march-top">${icon('banner')}<strong class="march-to">${title}</strong>${chip(html`${icon('bell')}${L`ターン ${fmtNum(t.arriveBell ?? 0)} に到着`}`, resolved ? 'ok' : 'info')}</div>
    ${sealed}
    <ol class="track track-phases" aria-label="${L`進軍の流れ`}">${phasesOf(t).map(s => html`<li class="${s.state}"><span class="track-dot" aria-hidden="true"></span><span class="track-name">${PHASE_TEXT[s.id]()}</span>${state(s)}</li>`)}</ol>
    <p class="march-now"><strong>${now ? WAIT_TEXT[now.id]() : L`すべて済みました`}</strong>${hint ? html`<span class="muted march-hint">${hint}</span>` : ''}</p>
    ${t.closedUnrevealed ? html`<p class="warn">${L`封が開けられないまま、受付が終わりました。軍勢は敗走する（兵・体力・チップの半分を失う）か、同じ国の到着が多すぎたときは損失なしで村へ戻ります。`}</p>` : ''}
    ${t.outcome ? html`<p class="march-out">${TRANSIT_OUTCOME_TEXT[t.outcome] ?? t.outcome}</p>` : ''}
    ${m.entry?.failure ? html`<p class="notice error">${failureText({ code: m.entry.failure })}</p>` : ''}
    ${m.dest || m.facts?.settleReady ? html`<div class="actions">
      ${m.facts?.settleReady ? html`<button type="button" class="btn primary small" data-act="settle-transit" data-host="${host}" data-slot="${m.entry?.transitSlot ?? m.transit?.slot ?? ''}">${L`結果を受け取る`}</button>` : ''}
      ${m.dest && resolved && Number.isInteger(t.arriveBell) ? html`<button type="button" class="btn${m.facts?.settleReady ? '' : ' primary'} small" data-act="report-open" data-p="${m.dest.p}" data-q="${m.dest.q}" data-bell="${t.arriveBell}">${icon('scroll')}${L`報告`}</button>
        <button type="button" class="btn small" data-act="battle-play" data-p="${m.dest.p}" data-q="${m.dest.q}" data-bell="${t.arriveBell}">${icon('play')}${L`戦いを再生`}</button>` : ''}
      ${m.dest ? html`<button type="button" class="btn small" data-act="goto" data-p="${m.dest.p}" data-q="${m.dest.q}">${L`地図で見る`}</button>` : ''}</div>` : ''}
    ${fold(`m-steps-${slug}`, L`くわしい段階`, html`<ol class="list track-steps">${t.steps.map(s => html`<li class="${s.state}">${STEP_TEXT[s.id]()}${s.state === 'now' ? html` <span class="muted">${L`（いま）`}</span>` : s.state === 'done' ? html` <span class="muted">${L`（済み）`}</span>` : ''}</li>`)}</ol>`)}
    ${t.locked ? fold(`m-lock-${slug}`, L`この軍勢はまだ動かせません`, html`<p class="locked-note" role="note">${lockedText()}</p>`) : ''}
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
