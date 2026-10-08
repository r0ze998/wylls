// Join (web design §7.2; contract §5.9, I-40, I-51; owner decision V2: joining is
// choosing one of the six nations, nothing else): wallet → nation → the in-game key
// (the wallet signs the session text) → Join (relay-paid) → this browser picks up to
// three free sites of the home wedge itself and files the ticket (controller.mjs
// autoTicket) → the first village appears at the next bell (about 11–21 minutes;
// final once the cohort closes). A displaced or ended ticket is filed again
// automatically. There is no site picker.
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum, lang } from '../../lang.mjs';
import { factionName, DOCTRINE_NAMES, HOLDING_STATES, failureText } from '../fi18n.mjs';
import { freeByWedge, ticketTimes, homeWedge } from '../fland.mjs';
import { timeHtml } from './shell.mjs';
import { LEADERS, leaderSvg, DOCTRINE_PITCH } from '../people/leaders.mjs';
import { placeName } from '../people/identity.mjs';
import { holdingName } from '../people/ui.mjs';
import { crestSvg } from '../hud/hud.mjs';
import { icon } from '../hud/icons.mjs';
import { countdown } from '../clock.mjs';
import { cardHead, chip, fold, ring } from './parts.mjs';

const FACTIONS = [0, 1, 2, 3, 4, 5];
/** A candidate place by the name a village there would carry, never by its number. */
const siteText = s => L`${placeName(s.p, s.q, s.site)[lang() === 'en' ? 'en' : 'ja']}（州 ${s.p},${s.q}）`;
const leaderName = f => (lang() === 'en' ? LEADERS[f].name.en : LEADERS[f].name.ja);

function walletButtons(FS) {
  const list = FS.walletList ?? [];
  return list.length ? html`<ul class="wallet-list">${list.map((w, i) => html`<li><button type="button" class="btn" data-act="connect" data-i="${i}" ${raw(w.why ? 'disabled' : '')}>${w.name}</button>${w.why ? html` <span class="muted">${w.why}</span>` : ''}</li>`)}</ul>`
    : html`<p class="muted">${L`ウォレットが見つかりません。Solana のウォレットを入れてから読み込み直してください。`}</p>`;
}

function renderWallets(FS) {
  return html`<section class="vcard" aria-labelledby="join-wallet">${cardHead({ id: 'join-wallet', ic: 'seal', title: L`ウォレットをつなぐ` })}
    <p>${L`参加の署名にだけウォレットを使います。遊ぶ操作はこの端末のゲーム内の鍵が署名し、手数料は中継が払います（テスト用の SOL、価値はありません）。`}</p>
    ${walletButtons(FS)}</section>`;
}

/** The faction cards: name, colour, doctrine, free land of the home wedge (an upper bound from the overviews). */
export function factionCards(FS) {
  const free = freeByWedge(FS.overviews ?? new Map());
  return FACTIONS.map(f => ({ faction: f, name: factionName(f), doctrine: DOCTRINE_NAMES[f], free: free[homeWedge(f)], chosen: FS.joinDraft?.faction === f }));
}

/**
 * The nation choice (UX design 7.2; owner decision V2: joining is choosing
 * one of the six nations, nothing else): six standing banners, each with the
 * leader's portrait and the nation's creed in one line; one choice, one
 * confirm. No site picker. A banner carries `data-nation` (its home wedge is
 * the map's to light: app.mjs sends `wylls:nation-focus` on hover, focus
 * and choice). Without a wallet the confirm line offers to connect one
 * first; the choice itself is already made.
 */
export function renderNations(FS) {
  const cards = factionCards(FS);
  const pick = cards.find(c => c.chosen) ?? null;
  // The season's join gate (I-51), or a relay that answered InviteRequired.
  const gated = FS.inviteRequired || !!FS.season?.joinGate?.some?.(x => x !== 0);
  const banners = cards.map(c => html`<li><button type="button" class="banner-pick bn${c.faction}" data-act="pick-faction" data-f="${c.faction}" data-nation="${c.faction}" aria-pressed="${c.chosen ? 'true' : 'false'}">
    <span class="bn-cloth"><span class="bn-crest">${crestSvg(c.faction, { size: 30 })}</span>${raw(leaderSvg(c.faction, { size: 104 }))}</span>
    <span class="bn-plate"><strong class="bn-name">${c.name}</strong><span class="bn-leader"><span data-name>${leaderName(c.faction)}</span></span><span class="bn-creed">${L`教義：${c.doctrine}`}</span><span class="bn-pitch">${DOCTRINE_PITCH[c.faction]()}</span></span>
  </button></li>`);
  // one confirm: the chosen nation's creed in a line, then the one button (or, without a wallet, the way to connect one)
  const confirm = html`<div class="nation-confirm${pick ? '' : ' nc-empty'}">
    <div class="nc-what" aria-live="polite">${pick ? html`${crestSvg(pick.faction, { size: 34 })}<div class="nc-text"><strong class="nc-name">${pick.name} <span class="nc-title">— <span data-name>${leaderName(pick.faction)}</span> · ${LEADERS[pick.faction].title()}</span></strong>
        <span class="nc-pitch">${DOCTRINE_PITCH[pick.faction]()}</span></div>`
      : html`<span class="nc-hint">${icon('banner')}</span><div class="nc-text"><strong class="nc-name">${L`旗を一つ選んでください`}</strong><span class="nc-pitch">${L`選ぶのは国だけです。最初の村の場所は自動で決まります。`}</span></div>`}</div>
    <div class="nc-go">
      ${gated ? html`<label class="field nc-invite">${L`招待コード`}<input name="invite" autocomplete="off" data-bind="invite" value="${FS.joinDraft?.invite ?? ''}"></label>` : ''}
      ${FS.wallet ? html`<button type="button" class="btn primary nc-btn" data-act="join" ${raw(pick ? '' : 'disabled')}>${icon('banner')}${pick ? L`${pick.name}で始める` : L`国を選んで始める`}</button>`
        : html`<div class="nc-wallet"><span class="nc-wallet-k">${L`始めるには、先にウォレットをつなぎます。`}</span>${walletButtons(FS)}</div>`}
    </div>
    <p class="nc-note">${FS.wallet ? L`ウォレットが2回たずねます：ゲーム内の鍵のための文面への署名と、参加の取引への署名です。` : L`参加の署名にだけウォレットを使います。遊ぶ操作はこの端末のゲーム内の鍵が署名し、手数料は中継が払います（テスト用の SOL、価値はありません）。`}${pick ? html` ${L`本拠の扇区の空き区画 約 ${fmtNum(pick.free)}`}` : ''}</p>
  </div>`;
  return html`<section class="nations" aria-labelledby="join-faction">
    <header class="nations-head"><h3 id="join-faction">${L`国を選ぶ`}</h3><p>${L`六つの国が、鐘のまわりの辺境を分け合っています。国が決めるのは、本拠の扇区と教義です。賞金はありません。`}</p></header>
    <ul class="banners">${banners}</ul>
    ${confirm}
  </section>`;
}

function renderSessionFix(FS) {
  return html`<section class="vcard" aria-labelledby="join-key">${cardHead({ id: 'join-key', ic: 'lock', title: L`ゲーム内の鍵` })}
    <p>${L`この端末にはこのシーズンのゲーム内の鍵がありません。ウォレットで同じ文面に署名すると、同じ鍵を作り直せます。`}</p>
    <div class="actions"><button type="button" class="btn primary" data-act="session">${L`鍵を作り直す`}</button></div></section>`;
}

/** Why the last holding or ticket ended (stored with its bell, review finding 7), as a line. */
function endLine(FS) {
  const e = FS.landRec?.landEnd;
  if (!e) return '';
  const t = { displaced: () => L`第${fmtNum(e.bell)}鐘：仮の村は、同じ鐘のより高い順位の入植希望に押し出されました。`,
    lost: () => L`第${fmtNum(e.bell)}鐘：村を失いました。`,
    ended: () => L`第${fmtNum(e.bell)}鐘：前の入植希望は区画を得られずに終わりました。` }[e.why];
  // once the new ticket has left, the line says so in the past (re-check 7)
  return t ? html`<p class="callout">${t()} ${e.refiled ? L`新しい入植希望を自動で出しました。` : L`空いた区画に、入植希望を自動でもう一度出します。`}</p>` : '';
}

/**
 * The time left in this turn, for the waiting view: `{left (seconds), share
 * (0–1 of the ten minutes gone)}` or null before the season runs. The page
 * refreshes the two marked nodes every second (app.mjs `tickTurn`).
 */
export function turnLeft(FS) {
  const now = FS.chain?.now?.() ?? null, g = FS.clock?.genesisTs;
  if (now === null || !Number.isFinite(g) || now < g) return null;
  const into = (now - g) % 600;
  return { left: Math.ceil(600 - into), share: into / 600 };
}

/** The waiting view's head: who the viewer joined, and the countdown to the next turn. */
function waitHead(FS, title) {
  const f = FS.citizen?.faction;
  const t = turnLeft(FS);
  return html`<div class="wait-top">${Number.isInteger(f) ? html`<span class="wait-face">${raw(leaderSvg(f, { size: 64 }))}</span>` : ''}
    <div class="wait-who">${Number.isInteger(f) ? html`<span class="wait-nation">${crestSvg(f, { size: 20 })}${L`${factionName(f)}に加わりました`}</span>` : ''}<h3 id="join-sites">${title}</h3></div></div>
    ${t ? html`<div class="turn-wait"><span class="turn-ring" data-turn-ring>${ring(t.share)}${icon('bell', 'turn-ring-ic')}</span>
      <div class="turn-wait-t"><span class="turn-wait-k">${L`次のターンまで`}</span><strong class="turn-wait-v" data-turn-left>${countdown(t.left)}</strong></div></div>` : ''}`;
}
const practiceOffer = () => html`<div class="wait-offer"><p>${L`待つあいだに、練習で戦ってみましょう。何も送らず、何も失いません。`}</p>
  <button type="button" class="btn primary" data-act="practice-open">${icon('swords')}${L`待つあいだに練習で戦ってみる`}</button></div>`;

/** While the first holding is being placed (no ticket yet): what this browser is doing about it (review finding 12). */
function renderPlacing(FS) {
  const a = FS.autoTicket;
  const again = !!FS.landRec?.landEnd || FS.land?.stage === 'refugee';
  const retry = html`<button type="button" class="btn small" data-act="auto-ticket">${L`いますぐもう一度出す`}</button>`;
  const line = {
    searching: () => html`<p role="status">${L`本拠の扇区で空いた区画を探して、入植希望を出しています…`}</p>`,
    sent: () => html`<p role="status">${L`入植希望を出しました。チェーンの記録に現れるのを待っています。`}</p>`,
    waiting: () => html`<p role="status">${L`この鐘の入植希望はもう試しました。次の鐘に自動でもう一度出します。`}</p>${FS.landRec?.autoTryFailed ? retry : ''}`,
    room: () => html`<p role="status">${L`空いた区画はありますが、この鐘の入植希望の枠がいっぱいです。次の鐘に自動で出します。`}</p>`,
    nofree: () => html`<p class="warn" role="status">${L`本拠の扇区にも隣の扇区にも空いた区画が見つかりません。鐘ごとに自動で探し直し、新しい輪がひらけばそこを探します。`}</p>${retry}`,
    failed: () => html`<p class="notice error" role="alert">${L`入植希望を出せませんでした：${failureText({ code: a.code })}`} ${L`次の鐘に自動でもう一度出します。`}</p>${retry}`,
  }[a?.state] ?? (() => html`<p role="status">${L`まもなく入植希望を自動で出します。`}</p>`);
  return html`<section class="vcard wait-card" aria-labelledby="join-sites">
    ${waitHead(FS, again ? L`新しい村の場所を探しています` : L`最初の村を置いています`)}
    <div class="wait-state">${line()}</div>
    ${endLine(FS)}
    ${practiceOffer()}
    ${fold('wait-how', L`村の場所の決まり方`, html`<p class="muted">${L`場所は選びません。同じ鐘の入植希望はその鐘の乱数でまとめて公平に決まり、村は次の鐘（約11〜21分後）に決まります。`}</p>
      <p class="muted">${L`入植希望には預け金が要ります（村の口座の賃料。村ができればそこへ移り、できなければ払った人に戻ります）。額は「その他」の詳細にあります。`}</p>`)}</section>`;
}

function renderTicket(FS) {
  const t = FS.land.ticket;
  const times = FS.clock ? ticketTimes(FS.clock, t.bell) : null;
  return html`<section class="vcard wait-card" aria-labelledby="join-sites">
    ${waitHead(FS, L`最初の村を待っています`)}
    <div class="wait-state"><p role="status">${L`入植希望を出しました（第${fmtNum(t.bell)}鐘）。`}${times ? html` ${Lh`結果は ${timeHtml(times.resultAbout)} ごろ（出してから約11〜21分）に、この鐘の乱数で決まります。`}` : ''}</p></div>
    <p class="c-label"><span>${L`村の候補地`}</span></p>
    <ol class="chosen">${t.sites.map((s, i) => html`<li ${raw(i < t.next ? 'class="done"' : '')}>${siteText(s)}${i < t.next ? html` <span class="muted">${L`（ふさがっていた）`}</span>` : ''}</li>`)}</ol>
    ${endLine(FS)}
    ${practiceOffer()}
    ${fold('wait-how', L`村の場所の決まり方`, html`<p class="muted">${FS.landRec?.ticketSource === 'overflow' ? L`本拠の扇区に空きがなかったため、区画は隣の扇区のいちばん外の輪から自動で選びました。区画を得られなければ、自動でもう一度出します。` : L`区画は本拠の扇区から自動で選びました。区画を得られなければ、自動でもう一度出します。`}</p>`)}</section>`;
}

function renderProvisional(FS) {
  const h = activeHolding(FS);
  const times = FS.clock && h ? ticketTimes(FS.clock, h.ticketBell) : null;
  return html`<section class="vcard" aria-labelledby="join-prov">${cardHead({ id: 'join-prov', ic: 'home', title: h ? holdingName(h) : HOLDING_STATES.provisional, side: chip(HOLDING_STATES.provisional, 'warn') })}
    ${h ? html`<p>${L`州 ${h.p},${h.q} に村を得ました。`}</p>` : ''}
    ${times ? html`<p>${Lh`同じ鐘の入植希望がすべて決まると確定します（遅くとも ${timeHtml(times.cohortEndsBy)}）。それまでは、より高い順位の希望に押し出されることがあります。`}</p>` : ''}
    <p class="muted">${L`仮の村でも収穫・建設・訓練はできます（押し出されると失われます）。軍勢の編成・出発・探索は確定してからです。`}</p></section>`;
}

/** The join screen for the viewer's stage. */
export function render(FS) {
  const stage = FS.land?.stage ?? 'none';
  // the nation choice comes first, wallet or not (the confirm line offers to connect one)
  if (stage === 'none') return renderNations(FS);
  if (!FS.wallet) return renderWallets(FS);
  if (!FS.session || FS.sessionProblem) return renderSessionFix(FS);
  if (stage === 'ticket') return renderTicket(FS);
  if (stage === 'provisional') return renderProvisional(FS);
  if (stage === 'final') return html`<p>${L`村が確定しました。「村」から始めましょう。`}</p>`;
  return renderPlacing(FS);
}
