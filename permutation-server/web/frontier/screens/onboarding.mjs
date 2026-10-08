// The onboarding card (web design §7.11): the checklist of the guided first
// turns, driven by onboarding.mjs (chain facts first, local "seen" flags
// only). The current step says what to do and, while the chain works, what
// it is waiting for and about when (O-M1-13 times); each step can be
// skipped and the card dismissed (it returns from "More"). On the map the
// guide is one objective at a time (renderObjective: a small card with the
// step and one button; UX design 7.4); the whole card with the list of steps
// opens in the drawer on demand and stands in the join flow.
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { PIPELINE_TEXT } from '../fi18n.mjs';
import { STEPS, onboardingState, factsOf, reportOffer, overflowProvinces } from '../onboarding.mjs';
import { timeHtml } from './shell.mjs';
import { guideLevel, guideTarget, goText } from '../hud/guide.mjs';
import { sealLine } from '../hud/glossary.mjs';
import { icon } from '../hud/icons.mjs';
import { cardHead } from './parts.mjs';

const TITLE = {
  welcome: () => L`ようこそ`,
  join: () => L`国と村`,
  build: () => L`最初の建設`,
  scout: () => L`最初の斥候`,
  practice: () => L`練習の衝突`,
  march: () => L`最初の封をした進軍`,
  report: () => L`最初の報告`,
  done: () => L`完了`,
};
const DO = {
  welcome: () => L`五つの言葉だけ覚えましょう。村（あなたの土地）、軍勢（動かす兵）、ターン（10分ごとの区切り。鐘が鳴ると進みます）、進軍（封をした移動）、探索（斥候で周りを調べる）です。`,
  // stage-neutral (a returning or refugee player too), following the automatic ticket (review finding 9)
  join: FS => {
    const stage = FS.land?.stage ?? 'none', st = FS.autoTicket?.state;
    if (stage === 'none') return L`六つの国から一つを選び、ゲーム内の鍵を作って参加します。選ぶのは国だけです。`;
    if (stage === 'ticket' || st === 'sent') return L`村の申し込みは済んでいます。次のターンの鐘のあと（約11〜21分後）に村が決まります。待つあいだに練習で戦ってみましょう。`;
    if (st === 'nofree') return L`空いた場所が見つかりません。ターンごとに自動で探し直します。`;
    if (st === 'room') return L`このターンの申し込みの枠がいっぱいです。次のターンに自動で出します。`;
    if (st === 'failed') return L`村の申し込みができませんでした。次のターンに自動でやり直します（「様子を見る」からすぐやり直せます）。`;
    return L`空いた場所に、村の申し込みを自動で出しています。`;
  },
  build: () => L`「村」で農場と伐採場を建てます。`,
  scout: () => L`斥候を訓練して軍勢に編成し、隣の2マスを探索します。`,
  practice: () => L`練習モードで蛮族の野営地を襲ってみます。チェーンには何も送りません。`,
  // (the seal in the one sentence the order card, the legend and the help say: hud/glossary.mjs sealLine)
  march: () => `${L`届く範囲の蛮族の野営地へ、封をした進軍を送ります。`}${sealLine()}${L`このタブを閉じても、封は自動で開けられます。`}`,
  report: () => L`衝突の報告を読みます。「このブラウザで確かめる」で結果を自分で計算し直せます。`,
  done: () => L`はじめの案内はここまでです。ガイドは「その他」からいつでも開けます。`,
};
/** What a step's one button does: the action (`data-act`), its data and its words. */
const GO_ACT = {
  join: FS => ({ act: 'join-open', data: {}, label: (FS?.land?.stage ?? 'none') === 'none' ? L`国を選ぶ` : L`様子を見る` }),
  build: () => ({ act: 'tab', data: { tab: 'holding' }, label: L`村を開く` }),
  scout: () => ({ act: 'tab', data: { tab: 'hosts' }, label: L`軍勢を開く` }),
  practice: () => ({ act: 'practice-open', data: {}, label: L`練習を開く` }),
  march: () => ({ act: 'tab', data: { tab: 'hosts' }, label: L`軍勢を開く` }),
};
const attrs = d => raw(Object.entries(d ?? {}).map(([k, v]) => `data-${String(k).replace(/[^\w-]/g, '')}="${String(v).replace(/[^\w.,:-]/g, '')}"`).join(' '));
const goButton = (g, c = '') => (g ? html`<button type="button" class="btn ${c}" data-act="${g.act}" ${attrs(g.data)}>${g.label}</button>` : '');
const GO = Object.fromEntries(Object.keys(GO_ACT).map(k => [k, (c = '', FS = null) => goButton(GO_ACT[k](FS), c)]));

/** The wait line of a step: expected time, or the pipeline state of the march being waited for. */
export function waitText(w) {
  if (!w) return '';
  const range = L`約${w.minutes[0]}〜${w.minutes[1]}分`;
  if (w.kind === 'ticket') return w.at ? Lh`結果は ${timeHtml(w.at)} ごろ（出してから${range}）。待つあいだに練習できます。` : L`結果は出してから${range}で決まります。`;
  if (w.kind === 'explore') return L`探索の結果は送ってから${range}で出ます。`;
  if (w.kind === 'report') return html`${L`報告は出発から${range}でできます。いまは：`}${PIPELINE_TEXT[w.pipeline] ?? ''}`;
  return '';
}

function stepItem(s) {
  const mark = s.status === 'done' ? L`済み` : s.status === 'skipped' ? L`飛ばした` : s.status === 'current' ? L`いま` : '';
  return html`<li class="${s.status === 'done' ? 'done' : s.status === 'current' ? 'now' : s.status === 'skipped' ? 'skipped' : ''}" ${raw(s.status === 'current' ? 'aria-current="step"' : '')}><span class="ck-mark" aria-hidden="true">${s.status === 'done' ? icon('check') : ''}</span><span class="ck-name">${TITLE[s.id]()}</span>${mark ? html` <span class="visually-hidden">${L`（${mark}）`}</span>` : ''}</li>`;
}

/**
 * The guide's steps, on demand (the drawer): the list as a checklist with
 * the current step's text and its buttons under it. `open` false gives the
 * same behind one summary line. Nothing when dismissed.
 */
export function render(FS, { open = true } = {}) {
  if (guideLevel(FS) !== 'all') return '';
  const st = onboardingState(factsOf(FS), FS.ui?.dismissed ?? [], FS.clock ?? null);
  if (st.dismissed) return '';
  const target = guideTarget(FS);
  const cur = st.steps.find(s => s.id === st.current);
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const total = STEPS.length - 1;
  const body = html`<div class="ck-now"><p>${cur.id === 'join' ? DO.join(FS) : DO[cur.id]()}</p>
    ${cur.wait ? html`<p class="muted">${waitText(cur.wait)}</p>` : ''}
    <div class="actions">${cur.id === 'welcome' ? html`<button type="button" class="btn primary" data-act="ob-seen" data-flag="welcome">${L`わかりました`}</button>` : ''}
      ${target && target.step === cur.id ? html`<button type="button" class="btn primary" data-act="ob-go">${goText(target)}</button>`
        : cur.id === 'report' ? renderReportGo(FS) : GO[cur.id]?.(cur.id === 'welcome' ? '' : 'primary', FS) ?? ''}</div></div>
    <div class="actions ck-foot">${cur.id !== 'done' ? html`<button type="button" class="btn small quiet" data-act="ob-skip" data-step="${cur.id}">${L`この手順を飛ばす`}</button>` : ''}
      <button type="button" class="btn small quiet" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></div>`;
  const head = L`ガイド ${n}/${total}：${TITLE[cur.id]()}`;
  if (!open) return html`<details class="callout onboarding"><summary>${head}</summary><ol class="checklist">${st.steps.map(stepItem)}</ol>${body}</details>`;
  return html`<section class="vcard onboarding" aria-labelledby="ob-title">${cardHead({ id: 'ob-title', ic: 'compass', title: head })}
    <ol class="checklist">${st.steps.map(stepItem)}</ol>${body}</section>`;
}

/**
 * The guide's one objective as data (UX design 7.4 and 11.11: one "next thing" at a time): which step
 * (`n` of `total` done), its name, what to do in a sentence, and its one action `{act, data, label}` — "show
 * me" for a target on the map, else the screen the step needs. Null when the guide is off, dismissed or done.
 */
export function objectiveModel(FS) {
  if (guideLevel(FS) !== 'all' || FS.mode !== 'play') return null;
  let st;
  try { st = onboardingState(factsOf(FS), FS.ui?.dismissed ?? [], FS.clock ?? null); } catch { return null; }
  if (st.dismissed) return null;
  const cur = st.steps.find(s => s.id === st.current);
  if (!cur || cur.id === 'done') return null;
  const target = guideTarget(FS);
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const r = cur.id === 'report' ? reportOffer(FS.marches) : null;
  const go = cur.id === 'welcome' ? { act: 'ob-seen', data: { flag: 'welcome' }, label: L`わかりました` }
    : target && target.step === cur.id ? { act: 'ob-go', data: {}, label: goText(target) }
    : cur.id === 'report' ? (r ? { act: 'report-open', data: { p: r.p, q: r.q, bell: r.bell }, label: L`報告を開く` } : null)
    : GO_ACT[cur.id]?.(FS) ?? null;
  return { id: cur.id, n, total: STEPS.length - 1, title: TITLE[cur.id](), text: cur.id === 'join' ? DO.join(FS) : DO[cur.id](), go };
}

/**
 * The same as a chip: which step, what to do in a line, and its single button; its count ("guide 4/7") opens
 * the list of steps in the drawer. (The page shows the objective in one place: the "next thing" button of the top
 * strip, or the line under the village plate on a phone — app.mjs. This chip is kept for a screen that wants the
 * sentence too.)
 */
export function renderObjective(FS) {
  const o = objectiveModel(FS);
  if (!o) return '';
  return html`<section class="ob-chip" aria-labelledby="ob-title">
    <button type="button" class="ob-steps" data-act="guide-open" aria-label="${L`ガイドの手順を見る（${o.n}/${o.total}）`}"><span class="ob-ring" aria-hidden="true"></span><span>${L`ガイド ${o.n}/${o.total}`}</span>${icon('chevron')}</button>
    <h3 id="ob-title">${o.title}</h3>
    <p class="ob-do">${o.text}</p>
    ${o.go ? html`<p class="ob-acts">${goButton(o.go, 'primary small')}</p>` : ''}
  </section>`;
}

function renderReportGo(FS, c = '') {
  const r = reportOffer(FS.marches);
  return r ? html`<button type="button" class="btn primary ${c}" data-act="report-open" data-p="${r.p}" data-q="${r.q}" data-bell="${r.bell}">${L`報告を開く`}</button>` : '';
}

/** The "show the guide again" control for the More tab (only while the card is dismissed or steps are skipped). */
export function renderRestore(FS) {
  const flags = FS.ui?.dismissed ?? [];
  if (!flags.some(x => x === 'onboarding' || x.startsWith('ob:skip:'))) return '';
  return html`<button type="button" class="btn" data-act="ob-restore">${L`ガイドをもう一度表示する`}</button>`;
}
