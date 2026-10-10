// The onboarding card (web design §7.11): the checklist of the guided first
// bells, driven by onboarding.mjs (chain facts first, local "seen" flags
// only). The current step says what to do and, while the chain works, what
// it is waiting for and about when (O-M1-13 times); each step can be
// skipped and the card dismissed (it returns from the More tab). On the map
// tab the card is open; on the other tabs it is one line that opens.
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { PIPELINE_TEXT, errorText } from '../fi18n.mjs';
import { STEPS, onboardingState, factsOf, reportOffer, overflowProvinces } from '../onboarding.mjs';
import { timeHtml } from './shell.mjs';
import { guideLevel, guideTarget, goText } from '../hud/guide.mjs';
import { activeHolding } from '../fstate.mjs';
import { SCOUT, actionBlocks, ticketTimes } from '../fland.mjs';
import { hostRows } from './host.mjs';
import { countdown } from '../clock.mjs';

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
  welcome: () => L`五つの言葉だけ覚えましょう：村（あなたの土地）、軍勢（動かす兵）、ターン（10分ごとの区切り）、進軍（封をした移動）、探索（斥候で周りを調べる）。`,
  // stage-neutral (a returning or refugee player too), following the automatic ticket (review finding 9)
  join: FS => {
    const stage = FS.land?.stage ?? 'none', st = FS.autoTicket?.state;
    if (stage === 'none') return L`地図のタブで六つの国から一つを選び、ゲーム内の鍵を作って参加します。選ぶのは国だけです。`;
    if (stage === 'ticket' || st === 'sent') return L`入植希望を自動で出しました。次のターン（約11〜21分後）に村が決まります。待つあいだに練習で戦ってみましょう。`;
    if (st === 'nofree') return L`空いた区画が見つかりません。ターンごとに自動で探し直します。`;
    if (st === 'room') return L`このターンの入植希望の枠がいっぱいです。次のターンに自動で出します。`;
    if (st === 'failed') return L`入植希望を出せませんでした。次のターンに自動でもう一度出します（地図のタブからすぐ出し直せます）。`;
    return L`空いた区画に、村の入植希望を自動で出しています。`;
  },
  build: () => L`村のタブで農場と木材所を建てます。`,
  scout: () => L`斥候を訓練して軍勢に編成し、隣の2マスを探索します。`,
  practice: () => L`練習モードで蛮族の野営地を襲ってみます。チェーンには何も送りません。`,
  march: () => L`届く範囲の蛮族の野営地へ、封をした進軍を送ります。行き先と構えは到着のターンまであなたにしか見えません。チップはキーパーへの報酬で、このタブを閉じてもキーパーが開封します。`,
  report: () => L`衝突の報告を読みます。「このブラウザで確かめる」で結果を自分で計算し直せます。`,
  done: () => L`最初のターンの案内は終わりです。ガイドは「その他」からいつでも開けます。`,
};
const GO = {
  join: () => html`<button type="button" class="btn" data-act="tab" data-tab="map">${L`地図を開く`}</button>`,
  build: () => html`<button type="button" class="btn" data-act="tab" data-tab="holding">${L`村を開く`}</button>`,
  scout: () => html`<button type="button" class="btn" data-act="tab" data-tab="hosts">${L`軍勢を開く`}</button>`,
  practice: () => html`<button type="button" class="btn" data-act="practice-open">${L`練習を開く`}</button>`,
  march: () => html`<button type="button" class="btn" data-act="tab" data-tab="marches">${L`進軍を開く`}</button>`,
};

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
  return html`<li class="${s.status === 'done' ? 'done' : s.status === 'current' ? 'now' : ''}" ${raw(s.status === 'current' ? 'aria-current="step"' : '')}>${TITLE[s.id]()}${mark ? html` <span class="visually-hidden">${L`（${mark}）`}</span>` : ''}</li>`;
}

/**
 * The card for the store: `open` shows the current step in full (the map
 * tab), else one summary line that expands. Nothing when dismissed.
 */
export function render(FS, { open = true } = {}) {
  if (guideLevel(FS) !== 'all') return '';
  const st = onboardingState(factsOf(FS), FS.ui?.dismissed ?? [], FS.clock ?? null);
  if (st.dismissed) return '';
  if (Number(FS.season?.programVersion ?? 1) >= 2) return renderHomeGuide(FS, st, FS.tab === 'holding' ? true : open);
  const target = guideTarget(FS);
  const cur = st.steps.find(s => s.id === st.current);
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const total = STEPS.length - 1;
  const body = html`<p>${cur.id === 'join' ? DO.join(FS) : DO[cur.id]()}</p>
    ${cur.wait ? html`<p class="muted">${waitText(cur.wait)}</p>` : ''}
    <p>${cur.id === 'welcome' ? html`<button type="button" class="btn primary" data-act="ob-seen" data-flag="welcome">${L`わかりました`}</button>` : ''}
      ${target && target.step === cur.id ? html`<button type="button" class="btn primary" data-act="ob-go">${goText(target)}</button>` : ''}
      ${cur.id === 'report' ? renderReportGo(FS) : GO[cur.id]?.() ?? ''}
      ${cur.id !== 'done' ? html`<button type="button" class="btn small" data-act="ob-skip" data-step="${cur.id}">${L`この手順を飛ばす`}</button>` : ''}
      <button type="button" class="btn small" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></p>`;
  const head = L`ガイド ${n}/${total}：${TITLE[cur.id]()}`;
  if (!open) return html`<details class="callout onboarding"><summary>${head}</summary><ol class="steps">${st.steps.map(stepItem)}</ol>${body}</details>`;
  return html`<section class="callout onboarding" aria-labelledby="ob-title"><h3 id="ob-title">${head}</h3>
    <ol class="steps">${st.steps.map(stepItem)}</ol>${body}</section>`;
}

/** The next concrete scouting action, always using this citizen's own host. */
export function renderScoutAction(FS) {
  const h = activeHolding(FS);
  if (!h) return '';
  if (FS.inFlight > 0 || FS.homeActionBusy) return html`<p class="home-status" role="status">${L`命令の結果を確認しています。まもなく次の手順が表示されます。`}</p>`;
  if (h.explore?.state > 0) {
    if (FS.exploreSeedReady) return html`<p>${L`斥候から知らせが届きました。探索の結果を受け取りましょう。`}</p><button type="button" class="btn primary" data-act="settle-explore">${L`探索の結果を受け取る`}</button>`;
    return html`<p class="home-status" role="status">${L`斥候が周囲を調べています。結果が届くと、ここで受け取れます。`}</p><p class="muted">${L`探索の解決を待つ間も、村の建設を進められます。`}</p><button type="button" class="btn" data-act="tab" data-tab="holding">${L`村を見る`}</button>`;
  }
  if (Number(FS.citizen?.explores ?? 0) > 0) return html`<p>${L`最初の探索が終わりました。見つけた土地を地図で確認し、次の行き先を考えましょう。`}</p><button type="button" class="btn primary" data-act="ob-seen" data-flag="exploreResult">${L`探索の結果を確認した`}</button>`;
  const bell = FS.nowBell ?? 0;
  const rows = hostRows(FS).filter(r => r.unit === SCOUT);
  const ready = rows.find(r => r.state === 1 && !r.pending && !r.inTransit && r.readyBell <= bell);
  if (ready) {
    const blocks = actionBlocks('Explore', { holding: h, citizen: FS.citizen, province: ready.province, now: FS.chain?.now?.() ?? 0, nowBell: bell, host: ready });
    if (blocks.length) return html`<p class="home-status">${blocks.map(errorText).join(' / ')}</p><button type="button" class="btn" data-act="tab" data-tab="hosts">${L`斥候隊を見る`}</button>`;
    return html`<p>${L`斥候隊の準備ができました。隣の土地を選んで探索に送りましょう。`}</p><button type="button" class="btn primary" data-act="explore-open" data-host="${String(ready.id)}">${L`探索する土地を選ぶ`}</button>`;
  }
  const forming = rows.find(r => r.state === 2);
  if (forming) {
    const now = FS.chain?.now?.() ?? 0;
    const due = FS.clock && Number.isInteger(forming.fromBell) && forming.fromBell > 0 ? ticketTimes(FS.clock, forming.fromBell - 1).resultAbout : null;
    return html`<p class="home-status" role="status">${L`編成の反映を待っています。`}</p>
      ${due !== null && due > now ? html`<p class="guide-build-clock"><span>${L`反映の目安まで（ゲーム内）`}</span><span data-home-deadline="${due}">${countdown(due - now)}</span></p>` : html`<p class="muted">${L`世界の処理で編成が反映されると、ここから探索を始められます。`}</p>`}`;
  }
  const resting = rows.find(r => r.readyBell > bell);
  if (resting) return html`<p class="home-status" role="status">${L`斥候隊は第${fmtNum(resting.readyBell)}ターンまで休息しています。`}</p>`;
  if (rows.length) return html`<p class="home-status">${L`斥候隊は別の命令を実行中です。軍勢の画面で様子を確認できます。`}</p><button type="button" class="btn" data-act="tab" data-tab="hosts">${L`斥候隊を見る`}</button>`;
  if (Number(h.reserve?.[SCOUT] ?? 0) >= 100) return html`<p>${L`訓練した斥候を一つの隊にまとめましょう。世界の処理に反映されると探索できます。目安はゲーム内で約11〜21分です。`}</p><button type="button" class="btn primary" data-act="home-scout-muster">${L`斥候隊を編成する`}</button>`;
  return html`<p>${L`村の周りを調べる斥候を100人、訓練しましょう。訓練はすぐに終わります。`}</p><button type="button" class="btn primary" data-act="home-scout-train">${L`斥候を訓練する`}</button>`;
}

function renderHomeGuide(FS, st, open) {
  if (!activeHolding(FS) || FS.homeGrant || st.current === 'join') return '';
  if (FS.inFlight > 0 || FS.homeActionBusy) return html`<section class="home-guide"><p class="home-status" role="status">${L`命令の結果を確認しています。まもなく次の手順が表示されます。`}</p></section>`;
  const h = activeHolding(FS), now = FS.chain?.now?.() ?? 0;
  const queue = (h.queue ?? []).filter(q => q && q.kind === 1 && Number(q.doneAt) > now).sort((a, b) => Number(a.doneAt) - Number(b.doneAt));
  // The holding panel already presents the build choices; after queuing, the
  // expanded guide gives the player their next action without leaving the tab.
  if (FS.tab === 'holding' && st.current === 'build' && !queue.length) return '';
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const total = st.steps.length - 1;
  const current = st.steps.find(s => s.id === st.current);
  let title = TITLE[st.current](), body;
  if (st.current === 'build') {
    if (queue.length) {
      title = L`建設を待つ間に、周りを知ろう`;
      body = html`<p class="guide-build-clock"><span aria-hidden="true">⚒</span><span>${L`最初の建物が完成するまで`}</span><span data-home-deadline="${Number(queue[0].doneAt)}">${countdown(Number(queue[0].doneAt) - now)}</span></p>${renderScoutAction(FS)}`;
    } else body = html`<p>${L`農場は食料、伐採所は木材を増やします。最初の建物を一つ選び、村が育つ様子を見てみましょう。`}</p><button type="button" class="btn primary" data-act="tab" data-tab="holding">${L`最初の建設を選ぶ`}</button>`;
  } else if (st.current === 'scout') body = renderScoutAction(FS);
  else if (st.current === 'march') {
    const target = guideTarget(FS);
    title = L`次の目標を見つけよう`;
    body = html`<p>${L`周囲の野営地を地図で見て、最初の遠征を計画しましょう。戦うには、斥候とは別に兵を訓練して軍勢に編成します。`}</p>${target ? html`<button type="button" class="btn primary" data-act="ob-go">${goText(target)}</button>` : html`<button type="button" class="btn primary" data-act="tab" data-tab="holding">${L`村で兵を準備する`}</button>`}`;
  } else if (st.current === 'report') body = html`<p>${L`遠征の結果が届いたら、兵の変化と戦った場所を確かめましょう。`}</p>${current.wait ? html`<p class="home-status">${waitText(current.wait)}</p>` : renderReportGo(FS)}`;
  else body = html`<p>${L`村を育て、周囲を知り、軍勢を動かせるようになりました。次は、あなたの目標を選びましょう。`}</p><button type="button" class="btn primary" data-act="ob-dismiss">${L`自分の村へ`}</button>`;
  const content = html`<p class="home-eyebrow">${L`はじめの一歩 ${fmtNum(n)}/${fmtNum(total)}`}</p><h3>${title}</h3>${body}<details class="guide-more"><summary>${L`これからの道のり`}</summary><ol class="steps">${st.steps.map(stepItem)}</ol><div class="actions">${st.current !== 'done' ? html`<button type="button" class="btn small" data-act="ob-skip" data-step="${st.current}">${L`この手順を飛ばす`}</button>` : ''}<button type="button" class="btn small" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></div></details>`;
  return open ? html`<section class="home-guide" aria-label="${L`最初の村のガイド`}">${content}</section>` : html`<details class="home-guide"><summary>${title}</summary>${content}</details>`;
}

function renderReportGo(FS) {
  const r = reportOffer(FS.marches);
  return r ? html`<button type="button" class="btn primary" data-act="report-open" data-p="${r.p}" data-q="${r.q}" data-bell="${r.bell}">${L`報告を開く`}</button>` : '';
}

/** The "show the guide again" control for the More tab (only while the card is dismissed or steps are skipped). */
export function renderRestore(FS) {
  const flags = FS.ui?.dismissed ?? [];
  if (!flags.some(x => x === 'onboarding' || x.startsWith('ob:skip:'))) return '';
  return html`<button type="button" class="btn" data-act="ob-restore">${L`ガイドをもう一度表示する`}</button>`;
}
