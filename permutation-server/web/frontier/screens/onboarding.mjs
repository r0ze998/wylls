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
import { PIPELINE_TEXT, errorText } from '../fi18n.mjs';
import { STEPS, onboardingState, factsOf, reportOffer, overflowProvinces } from '../onboarding.mjs';
import { timeHtml } from './shell.mjs';
import { guideLevel, guideTarget, goText } from '../hud/guide.mjs';
import { sealLine } from '../hud/glossary.mjs';
import { icon } from '../hud/icons.mjs';
import { cardHead } from './parts.mjs';
import { activeHolding } from '../fstate.mjs';
import { SCOUT, SETTLER, actionBlocks, ticketTimes } from '../fland.mjs';
import { hostRows } from './host.mjs';
import { countdown } from '../clock.mjs';
import { territoryEnabled } from '../territory.mjs';
import { DEPART_STAMINA } from '../fmarch.mjs';
import { conquestOn } from '../hud/keephand.mjs';
import { conquestObjective, renderConquestGuide } from './conquestguide.mjs';

const TITLE = {
  welcome: () => L`ようこそ`,
  join: () => L`国と村`,
  build: () => L`最初の建設`,
  scout: () => L`最初の斥候`,
  train: () => L`兵を訓練する`,
  muster: () => L`軍勢を編成する`,
  claim: () => L`領土を確保する`,
  practice: () => L`練習の衝突`,
  march: () => L`最初の封をした進軍`,
  report: () => L`最初の報告`,
  done: () => L`完了`,
};
const DO = {
  welcome: () => L`五つの言葉だけ覚えましょう。村（あなたの拠点）、軍勢（動かす兵）、ターン（10分ごとの区切り）、進軍（封をした移動）、探索（斥候で周りを調べる）です。`,
  // stage-neutral (a returning or refugee player too), following the automatic ticket (review finding 9)
  join: FS => {
    const stage = FS.land?.stage ?? 'none', st = FS.autoTicket?.state;
    if (stage === 'none') return L`六つの国から一つを選び、ゲーム内の鍵を作って参加します。選ぶのは国だけです。`;
    if (stage === 'ticket' || st === 'sent') return L`村の申し込みは済んでいます。次のターンに変わったあと（約11〜21分後）に村が決まります。待つあいだに練習で戦ってみましょう。`;
    if (st === 'nofree') return L`空いた場所が見つかりません。ターンごとに自動で探し直します。`;
    if (st === 'room') return L`このターンの申し込みの枠がいっぱいです。次のターンに自動で出します。`;
    if (st === 'failed') return L`村の申し込みができませんでした。次のターンに自動でやり直します（「様子を見る」からすぐやり直せます）。`;
    return L`空いた場所に、村の申し込みを自動で出しています。`;
  },
  build: () => L`「村」で農場と伐採場を建てます。`,
  train: () => L`食料・鉱石・金の配分を見ながら、最初の兵を訓練しましょう。`,
  muster: () => L`控えの兵を一つの軍勢にまとめます。編成が反映されると、地図上で動かせます。`,
  claim: () => L`空き地は到着して確保します。敵の土地は戦いに勝って占領します。`,
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
  if (territoryEnabled(FS)) return renderArrivalGuide(FS, st, open);
  // a conquest season (program version 3): the seven steps to a province, from the records (screens/conquestguide.mjs)
  if (conquestOn(FS)) return FS.homeGrant ? '' : renderConquestGuide(FS, { open });
  if (Number(FS.season?.programVersion ?? 1) >= 2) return renderHomeGuide(FS, st, FS.tab === 'holding' ? true : open);
  const target = guideTarget(FS);
  const cur = st.steps.find(s => s.id === st.current);
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const total = st.steps.length - 1;
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



/** The arrival-control opening teaches resource allocation, an army and its first held tile. */
export function arrivalObjective(FS, st = onboardingState(factsOf(FS), FS.ui?.dismissed ?? [], FS.clock ?? null)) {
  if (st.dismissed || st.current === 'done') return null;
  const id = st.current, h = activeHolding(FS), now = FS.chain?.now?.() ?? 0;
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  let title = TITLE[id](), text = id === 'join' ? DO.join(FS) : DO[id](), go = GO_ACT[id]?.(FS) ?? null;
  if (id === 'build' || id === 'train' || id === 'muster') {
    const building = id === 'build' && (h?.queue ?? []).some(q => q && q.kind === 1 && Number(q.doneAt) > now);
    const target = guideTarget(FS);
    go = { act: 'ob-go', data: {}, label: target ? goText(target) : L`村を見る` };
    if (building) { title = L`建設を待つ間に、兵を準備`; text = DO.train(); }
  } else if (id === 'march') {
    title = L`空き地へ最初の進軍`;
    text = L`軍勢を選び、届く範囲の空き地を押します。進軍の費用と到着するターンを確かめて出発しましょう。`;
    go = marchObjective(FS);
  } else if (id === 'claim') {
    title = L`到着と領土の確保を待つ`;
    go = { act: 'tab', data: { tab: 'territory' }, label: L`領土の変化を見る` };
  }
  return { id, n, total: st.steps.length - 1, title, text, go };
}

function renderArrivalGuide(FS, st, open) {
  if (FS.homeGrant) return '';
  const o = arrivalObjective(FS, st);
  if (!o) return html`<section class="vcard onboarding"><h3>${factsOf(FS).claimed ? L`最初の領土を確保しました` : TITLE.done()}</h3>
    <p>${L`建設と訓練に資源を配分し、次の土地へ軍勢を送りましょう。斥候の探索や村の昇格も続けられます。`}</p>
    <button type="button" class="btn primary" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></section>`;
  const body = html`<p>${o.text}</p>${o.go ? html`<div class="actions">${goButton(o.go, 'primary')}</div>` : ''}
    <ol class="checklist">${st.steps.map(stepItem)}</ol><div class="actions ck-foot">
      <button type="button" class="btn small quiet" data-act="ob-skip" data-step="${st.current}">${L`この手順を飛ばす`}</button>
      <button type="button" class="btn small quiet" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></div>`;
  const head = L`ガイド ${o.n}/${o.total}：${o.title}`;
  if (!open) return html`<details class="callout onboarding"><summary>${head}</summary>${body}</details>`;
  return html`<section class="vcard onboarding" aria-labelledby="ob-title">${cardHead({ id: 'ob-title', ic: 'compass', title: head })}${body}</section>`;
}

/** Pick the first useful action for the military loop, without spending resources implicitly. */
export function marchObjective(FS) {
  const bell = FS.nowBell ?? 0, h = activeHolding(FS);
  const rows = hostRows(FS).filter(r => r.unit !== SCOUT && r.unit !== SETTLER);
  const ready = rows.find(r => r.state === 1 && !r.pending && !r.inTransit && r.readyBell <= bell && r.stamina >= DEPART_STAMINA
    && !actionBlocks('Depart', { holding: h, citizen: FS.citizen, province: r.province, now: FS.chain?.now?.() ?? 0, nowBell: bell, host: r }).length);
  if (ready) return { act: 'compose', data: { host: String(ready.id), stay: 'map' }, label: L`移動する土地を選ぶ` };
  if (rows.length) return { act: 'tab', data: { tab: 'hosts' }, label: L`軍勢の準備を確かめる` };
  return { act: 'tab', data: { tab: 'holding' }, label: L`村で兵を準備する` };
}

function scoutObjective(FS) {
  const h = activeHolding(FS);
  if (FS.inFlight > 0 || FS.homeActionBusy) return { act: 'guide-open', data: {}, label: L`命令の結果を確認しています。` };
  if (h?.explore?.state > 0) return FS.exploreSeedReady
    ? { act: 'settle-explore', data: {}, label: L`探索の結果を受け取る` }
    : { act: 'guide-open', data: {}, label: L`斥候隊を見る` };
  if (Number(FS.citizen?.explores ?? 0) > 0) return { act: 'ob-seen', data: { flag: 'exploreResult' }, label: L`探索の結果を確認した` };
  const rows = hostRows(FS).filter(r => r.unit === SCOUT);
  const bell = FS.nowBell ?? 0;
  const ready = rows.find(r => r.state === 1 && !r.pending && !r.inTransit && r.readyBell <= bell
    && !actionBlocks('Explore', { holding: h, citizen: FS.citizen, province: r.province, now: FS.chain?.now?.() ?? 0, nowBell: bell, host: r }).length);
  if (ready) return { act: 'explore-open', data: { host: String(ready.id) }, label: L`探索する土地を選ぶ` };
  if (rows.length) return { act: 'guide-open', data: {}, label: L`斥候隊を見る` };
  return Number(h?.reserve?.[SCOUT] ?? 0) >= 100
    ? { act: 'home-scout-muster', data: {}, label: L`斥候隊を編成する` }
    : { act: 'home-scout-train', data: {}, label: L`斥候を訓練する` };
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
  // a conquest season (program version 3): the seven steps to a province, from the records (screens/conquestguide.mjs)
  if (conquestOn(FS) && !territoryEnabled(FS)) return conquestObjective(FS);
  const cur = st.steps.find(s => s.id === st.current);
  if (!cur || cur.id === 'done') return null;
  const target = guideTarget(FS);
  const n = st.steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const r = cur.id === 'report' ? reportOffer(FS.marches) : null;
  let go = cur.id === 'welcome' ? { act: 'ob-seen', data: { flag: 'welcome' }, label: L`わかりました` }
    : target && target.step === cur.id ? { act: 'ob-go', data: {}, label: goText(target) }
    : cur.id === 'report' ? (r ? { act: 'report-open', data: { p: r.p, q: r.q, bell: r.bell }, label: L`報告を開く` } : null)
    : GO_ACT[cur.id]?.(FS) ?? null;
  if (territoryEnabled(FS)) return arrivalObjective(FS, st);
  let title = TITLE[cur.id](), text = cur.id === 'join' ? DO.join(FS) : DO[cur.id]();
  if (Number(FS.season?.programVersion ?? 1) >= 2) {
    const h = activeHolding(FS), now = FS.chain?.now?.() ?? 0;
    const building = (h?.queue ?? []).some(q => q && q.kind === 1 && Number(q.doneAt) > now);
    if (cur.id === 'scout' || (cur.id === 'build' && building)) {
      go = scoutObjective(FS);
      if (cur.id === 'build') { title = L`建設を待つ間に、周りを知ろう`; text = L`探索の解決を待つ間も、村の建設を進められます。`; }
    }
    if (cur.id === 'march') {
      title = L`最初の進軍を準備する`;
      text = L`食料と鉱石を兵の訓練に配分し、軍勢に編成しましょう。軍勢を選ぶと、移動できる土地が地図に表示されます。`;
      go = marchObjective(FS);
    }
  }
  return { id: cur.id, n, total: st.steps.length - 1, title, text, go };
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
  if (FS.inFlight > 0 || FS.homeActionBusy) return html`<section class="vcard onboarding home-guide"><p class="home-status" role="status">${L`命令の結果を確認しています。まもなく次の手順が表示されます。`}</p></section>`;
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
      body = html`<p class="guide-build-clock">${icon('hammer')}<span>${L`最初の建物が完成するまで`}</span><span data-home-deadline="${Number(queue[0].doneAt)}">${countdown(Number(queue[0].doneAt) - now)}</span></p>${renderScoutAction(FS)}`;
    } else body = html`<p>${L`農場は食料、伐採所は木材を増やします。最初の建物を一つ選び、村が育つ様子を見てみましょう。`}</p><button type="button" class="btn primary" data-act="tab" data-tab="holding">${L`最初の建設を選ぶ`}</button>`;
  } else if (st.current === 'scout') body = renderScoutAction(FS);
  else if (st.current === 'march') {
    const target = guideTarget(FS);
    title = L`最初の進軍を準備する`;
    body = html`<p>${L`食料と鉱石を兵の訓練に配分し、軍勢に編成しましょう。軍勢を選ぶと、移動できる土地が地図に表示されます。`}</p>${goButton(marchObjective(FS), 'primary')}`;
  } else if (st.current === 'report') body = html`<p>${L`遠征の結果が届いたら、兵の変化と戦った場所を確かめましょう。`}</p>${current.wait ? html`<p class="home-status">${waitText(current.wait)}</p>` : renderReportGo(FS)}`;
  else body = html`<p>${L`村を育て、周囲を知り、軍勢を動かせるようになりました。次は、あなたの目標を選びましょう。`}</p><button type="button" class="btn primary" data-act="ob-dismiss">${L`自分の村へ`}</button>`;
  const content = html`<p class="home-eyebrow">${L`はじめの一歩 ${fmtNum(n)}/${fmtNum(total)}`}</p><h3>${title}</h3>${body}<details class="guide-more"><summary>${L`これからの道のり`}</summary><ol class="checklist">${st.steps.map(stepItem)}</ol><div class="actions">${st.current !== 'done' ? html`<button type="button" class="btn small" data-act="ob-skip" data-step="${st.current}">${L`この手順を飛ばす`}</button>` : ''}<button type="button" class="btn small" data-act="ob-dismiss">${L`ガイドを閉じる`}</button></div></details>`;
  return open ? html`<section class="vcard onboarding home-guide" aria-label="${L`最初の村のガイド`}">${content}</section>` : html`<details class="vcard onboarding home-guide"><summary>${title}</summary>${content}</details>`;
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
