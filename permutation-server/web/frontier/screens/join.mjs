// Join (web design §7.2; contract §5.9, I-40, I-51; owner decision V2: joining is
// choosing one of the six nations, nothing else): wallet → nation → the in-game key
// (the wallet signs the session text) → Join (relay-paid) → this browser picks up to
// three free sites of the home wedge itself and files the ticket (controller.mjs
// autoTicket) → the first village appears at the next bell (about 11–21 minutes;
// final once the cohort closes). A displaced or ended ticket is filed again
// automatically. There is no site picker. On screen the ticket is called the
// "village request" (村の申し込み) and a bell by its turn's number (UX design 11.13).
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum, lang } from '../../lang.mjs';
import { factionName, DOCTRINE_NAMES, HOLDING_STATES, failureText } from '../fi18n.mjs';
import { freeByWedge, ticketTimes, homeWedge } from '../fland.mjs';
import { timeHtml } from './shell.mjs';
import { LEADERS, leaderFigure, leaderHex, leaderSvg, DOCTRINE_PITCH } from '../people/leaders.mjs';
import { placeName } from '../people/identity.mjs';
import { holdingName } from '../people/ui.mjs';
import { crestSvg } from '../hud/hud.mjs';
import { icon } from '../hud/icons.mjs';
import { provinceName } from '../hud/place.mjs';
import { countdown } from '../clock.mjs';
import { cardHead, stamp, fold, ring } from './parts.mjs';
import { bellStart, BELL_SECS } from '../clock.mjs';

const FACTIONS = [0, 1, 2, 3, 4, 5];
/** A candidate place by the name a village there would carry, never by its number or its coordinates (the row flies there). */
const siteText = s => placeName(s.p, s.q, s.site)[lang() === 'en' ? 'en' : 'ja'];
const leaderName = f => (lang() === 'en' ? LEADERS[f].name.en : LEADERS[f].name.ja);

function walletButtons(FS) {
  const list = FS.walletList ?? [];
  return list.length ? html`<ul class="wallet-list">${list.map((w, i) => html`<li><button type="button" class="btn" data-act="connect" data-i="${i}" ${raw(w.why ? 'disabled' : '')}>${w.name}</button>${w.why ? html` <span class="muted">${w.why}</span>` : ''}</li>`)}</ul>`
    : html`<p class="muted">${L`ウォレットが見つかりません。Solana のウォレットを入れてから読み込み直してください。`}</p>`;
}

function renderWallets(FS) {
  return html`<section class="vcard" aria-labelledby="join-wallet">${cardHead({ id: 'join-wallet', ic: 'seal', title: L`ウォレットをつなぐ` })}
    <p>${L`ウォレットを使うのは、参加の署名のときだけです。そのあとの操作はこの端末のゲーム内の鍵が署名し、手数料はゲーム側が立て替えます（テスト用の SOL で、価値はありません）。`}</p>
    ${walletButtons(FS)}</section>`;
}

/** The faction cards: name, colour, doctrine, free land of the home wedge (an upper bound from the overviews). */
export function factionCards(FS) {
  const free = freeByWedge(FS.overviews ?? new Map());
  return FACTIONS.map(f => ({ faction: f, name: factionName(f), doctrine: DOCTRINE_NAMES[f], free: free[homeWedge(f)], chosen: FS.joinDraft?.faction === f }));
}

/**
 * The nation choice (UX design 7.2 and 11.9; owner decision V2: joining is choosing one of the six nations,
 * nothing else): six standing banners of cloth — the nation's crest on the rail, its leader standing lit before the
 * cloth (breathing while the banner is looked at; the chosen one's flourish plays once: people/leader-sprite.mjs),
 * the nation's name, its leader and its doctrine on the dyed field under it — and one confirm line. One choice, one
 * confirm, no site picker. A banner carries `data-nation`: app.mjs sends `wylls:nation-focus` on hover, focus
 * and choice (the map lights that nation's home wedge) and marks the panel with `data-look`, so the confirm
 * line says the leader and the creed of the banner that is looked at (all six are in the markup; the stylesheet
 * shows one). On a phone the banners are compact (crest, name, doctrine: all six in sight) and the confirm line
 * carries the rest. Without a wallet the confirm line offers to connect one first; the choice is already made.
 */
export function renderNations(FS) {
  const cards = factionCards(FS);
  const pick = cards.find(c => c.chosen) ?? null;
  // The season's join gate (I-51), or a relay that answered InviteRequired.
  const gated = FS.inviteRequired || !!FS.season?.joinGate?.some?.(x => x !== 0);
  const banners = cards.map(c => html`<li><button type="button" class="banner-pick bn${c.faction}" data-act="pick-faction" data-f="${c.faction}" data-nation="${c.faction}" aria-pressed="${c.chosen ? 'true' : 'false'}">
    <span class="bn-rim"><span class="bn-cloth"><span class="bn-face"></span>
      <span class="bn-field"><strong class="bn-name">${c.name}</strong><span class="bn-leader"><span data-name>${leaderName(c.faction)}</span></span><span class="bn-creed">${L`教義：${c.doctrine}`}</span></span></span></span>
    <span class="bn-figure">${raw(leaderFigure(c.faction, { motion: c.chosen ? 'attack' : 'idle', once: c.chosen ? `pick-${c.faction}` : null, when: 'look' }))}</span>
    <span class="bn-hex">${raw(leaderHex(c.faction, { size: 44 }))}</span>
    <span class="bn-crest">${crestSvg(c.faction, { size: 30 })}</span>${c.chosen ? html`<span class="bn-mark" aria-hidden="true">${icon('check')}</span>` : ''}
  </button></li>`);
  // who leads each nation and what it is good at, in a line: the looked-at banner's, else the chosen one's
  const says = cards.map(c => html`<div class="nc-item${c.chosen ? ' nc-def' : ''}" data-n="${c.faction}" ${raw(c.chosen ? 'aria-live="polite"' : 'aria-hidden="true"')}><span class="nc-fig">${raw(leaderFigure(c.faction, { motion: c.chosen ? 'attack' : 'idle', once: c.chosen ? `pick-${c.faction}` : null }))}</span><span class="nc-face">${raw(leaderSvg(c.faction, { size: 76, shape: 'card' }))}</span>${crestSvg(c.faction, { size: 34 })}<div class="nc-text"><strong class="nc-name">${c.name} <span class="nc-title">— <span data-name>${leaderName(c.faction)}</span> · ${LEADERS[c.faction].title()}</span></strong>
      <span class="nc-pitch">${DOCTRINE_PITCH[c.faction]()}</span></div></div>`);
  const confirm = html`<div class="nation-confirm${pick ? '' : ' nc-empty'}">
    <div class="nc-what">${says}${pick ? '' : html`<div class="nc-item nc-def"><span class="nc-hint">${icon('banner')}</span><div class="nc-text"><strong class="nc-name">${L`旗を一つ選んでください`}</strong><span class="nc-pitch">${L`選ぶのは国だけです。最初の村の場所は自動で決まります。`}</span></div></div>`}</div>
    <div class="nc-go">
      ${gated ? html`<label class="field nc-invite">${L`招待コード`}<input name="invite" autocomplete="off" data-bind="invite" value="${FS.joinDraft?.invite ?? ''}"></label>` : ''}
      ${FS.wallet ? html`<button type="button" class="btn primary nc-btn" data-act="join" ${raw(pick ? '' : 'disabled')}>${icon('banner')}${pick ? L`${pick.name}で始める` : L`国を選んで始める`}</button>`
        : html`<div class="nc-wallet"><span class="nc-wallet-k">${L`始めるには、先にウォレットをつなぎます。`}</span>${walletButtons(FS)}</div>`}
    </div>
    <p class="nc-note">${FS.wallet ? L`ウォレットが2回、確認を求めます。ゲーム内の鍵を作るための署名と、参加のための署名です。` : L`ウォレットを使うのは、参加の署名のときだけです。そのあとの操作はこの端末のゲーム内の鍵が署名し、手数料はゲーム側が立て替えます（テスト用の SOL で、価値はありません）。`}${pick ? html` ${L`村を置ける場所 約 ${fmtNum(pick.free)}`}` : ''}</p>
  </div>`;
  return html`<section class="nations" aria-labelledby="join-faction">
    <header class="nations-head"><h3 id="join-faction">${L`国を選ぶ`}</h3><p>${L`六つの国が、鐘のまわりの辺境を分け合っています。国で決まるのは、村を置く方角と教義です。賞金はありません。`}</p></header>
    <ul class="banners">${banners}</ul>
    ${confirm}
  </section>`;
}

function renderSessionFix(FS) {
  return html`<section class="vcard" aria-labelledby="join-key">${cardHead({ id: 'join-key', ic: 'lock', title: L`ゲーム内の鍵` })}
    <p>${L`この端末にはこのシーズンのゲーム内の鍵がありません。ウォレットで同じ文面に署名すると、同じ鍵を作り直せます。`}</p>
    <div class="actions"><button type="button" class="btn primary" data-act="session">${L`鍵を作り直す`}</button></div></section>`;
}

/** Why the last village or village request ended (stored with its turn, review finding 7), as a line. */
function endLine(FS) {
  const e = FS.landRec?.landEnd;
  if (!e) return '';
  const t = { displaced: () => L`ターン ${fmtNum(e.bell)}：仮の村は、同じターンのより順位の高い申し込みに押し出されました。`,
    lost: () => L`ターン ${fmtNum(e.bell)}：村を失いました。`,
    ended: () => L`ターン ${fmtNum(e.bell)}：前の申し込みは場所を得られずに終わりました。` }[e.why];
  // once the new request has left, the line says so in the past (re-check 7)
  return t ? html`<p class="callout">${t()} ${e.refiled ? L`新しい村の申し込みを自動で出しました。` : L`空いた場所に、村の申し込みを自動でもう一度出します。`}</p>` : '';
}

/**
 * The time left in this turn, for the waiting view: `{left (seconds), share
 * (0–1 of the ten minutes gone)}` or null before the season runs.
 */
export function turnLeft(FS) {
  const now = FS.chain?.now?.() ?? null, g = FS.clock?.genesisTs;
  if (now === null || !Number.isFinite(g) || now < g) return null;
  const into = (now - g) % 600;
  return { left: Math.ceil(600 - into), share: into / 600 };
}

/**
 * The waiting view's one clock (UX design 11.10: one state line and one countdown). With a request filed it counts
 * to the bell that decides the village, second for second with the turn dial above it (the second review: "about
 * 11 min (turn 43's bell)" stood under a dial that said turn 43 was 9:22 away, because the figure counted on to the
 * result, a minute after that toll) — `{kind: 'result', left, turn, after (minutes from that toll to the result),
 * tolled, share, text}`; else the time left in this turn, when this browser tries again — `{kind: 'turn', left,
 * share, text}`. Null before the season runs. The page refreshes the marked node (`data-wait-clock`) and its
 * ring every second (app.mjs tickTurn).
 */
export function waitClock(FS) {
  const now = FS.chain?.now?.() ?? null;
  const t = FS.land?.stage === 'ticket' ? FS.land.ticket : null;
  if (t && FS.clock && now !== null) {
    const at = ticketTimes(FS.clock, t.bell).resultAbout, from = bellStart(FS.clock.genesisTs, t.bell);
    // the bell whose toll decides it: the one that ends the turn the request was filed in (the result is drawn a little after)
    const turn = Math.floor((at - FS.clock.genesisTs) / BELL_SECS), toll = bellStart(FS.clock.genesisTs, turn);
    const left = toll - now, tolled = !(left > 0);
    return { kind: 'result', left: Math.max(0, Math.ceil(left)), turn, after: Math.max(1, Math.round((at - toll) / 60)), tolled, share: Math.max(0, Math.min(1, (now - from) / Math.max(1, toll - from))), text: tolled ? L`まもなく` : countdown(Math.ceil(left)) };
  }
  const tl = turnLeft(FS);
  return tl ? { kind: 'turn', ...tl, text: countdown(tl.left) } : null;
}
/** What follows the clock of a request, said once: which bell it is, and that the village is decided a little after it. */
export const waitNote = c => (c?.kind !== 'result' ? '' : c.tolled ? L`鐘が鳴りました。約 ${fmtNum(c.after)} 分で決まります。` : L`ターン ${fmtNum(c.turn)} の鐘です。鐘のあと約 ${fmtNum(c.after)} 分で決まります。`);

/** The waiting view's head: who the viewer joined, and the state in one line (the card's title). */
function waitHead(FS, title) {
  const f = FS.citizen?.faction;
  return html`<div class="wait-top">${Number.isInteger(f) ? html`<span class="wait-face">${raw(leaderFigure(f))}</span>` : ''}
    <div class="wait-who">${Number.isInteger(f) ? html`<span class="wait-nation">${crestSvg(f, { size: 20 })}${L`${factionName(f)}に加わりました`}</span>` : ''}<h3 id="join-sites">${title}</h3></div></div>`;
}
/** The one clock, large: what it counts to, the figure, and (for a result) the turn whose bell decides it. */
function waitClockBox(c, label) {
  if (!c) return '';
  return html`<div class="turn-wait"><span class="turn-ring" data-wait-ring>${ring(c.share)}${icon('bell', 'turn-ring-ic')}</span>
    <div class="turn-wait-t"><span class="turn-wait-k">${label}</span><strong class="turn-wait-v" data-wait-clock>${c.text}</strong>${c.kind === 'result' ? html`<span class="turn-wait-n" data-wait-note>${waitNote(c)}</span>` : ''}</div></div>`;
}
const practiceOffer = () => html`<div class="wait-offer"><p>${L`待つあいだに、練習で戦ってみましょう。何も送らず、何も失いません。`}</p>
  <button type="button" class="btn" data-act="practice-open">${icon('swords')}${L`待つあいだに練習で戦ってみる`}</button></div>`;
const howFold = body => fold('wait-how', L`村の場所の決まり方`, body);
const HOW_PLACE = () => html`<p class="muted">${L`場所は選びません。同じターンの申し込みは、そのターンのくじでまとめて公平に決まり、村は次のターンの鐘のあと（約11〜21分後）に決まります。`}</p>
  <p class="muted">${L`村の申し込みには預け金が要ります（村の記録を置くための費用で、村ができればそこへ移り、できなければ払った人に戻ります）。額は「その他」の詳細にあります。`}</p>`;

/**
 * Joined, no request filed yet: what this browser is doing about it (review finding 12). A refusal is one
 * clear state (UX design 11.10): the heading says the request is not in, a warning chip says why, one
 * button tries again now, and one line says when it is tried again by itself (the one countdown).
 */
function renderPlacing(FS) {
  const a = FS.autoTicket;
  const again = !!FS.landRec?.landEnd || FS.land?.stage === 'refugee';
  const c = waitClock(FS);
  const stuck = a?.state === 'failed' || a?.state === 'nofree';
  if (stuck) {
    const why = a.state === 'nofree' ? L`近くに空いた場所がありません` : L`受け付けられませんでした`;
    const more = a.state === 'nofree' ? L`新しい輪がひらけば、そこも探します。` : failureText({ code: a.code });
    return html`<section class="vcard wait-card wait-stuck" aria-labelledby="join-sites">
      ${waitHead(FS, L`まだ村の申し込みができていません`)}
      <div class="wait-state"><p class="wait-warn" role="alert"><span class="warn-chip">${icon('alert')}${why}</span><span class="wait-why">${more}</span></p>
        <div class="actions wait-acts"><button type="button" class="btn primary" data-act="auto-ticket">${icon('return')}${L`いますぐやり直す`}</button></div>
        <p class="wait-auto">${icon('hourglass')}<span>${c ? Lh`次のターンに自動でやり直します（あと ${html`<span class="wait-left" data-wait-clock>${c.text}</span>`}）` : L`次のターンに自動でやり直します`}</span></p></div>
      ${endLine(FS)}
      ${practiceOffer()}
      ${howFold(HOW_PLACE())}</section>`;
  }
  const line = {
    searching: () => L`村を置ける場所を探して、村の申し込みを出しています…`,
    sent: () => L`村の申し込みを出しました。記録に現れるのを待っています。`,
    waiting: () => L`このターンの申し込みはもう試しました。次のターンに自動でもう一度出します。`,
    room: () => L`空いた場所はありますが、このターンの申し込みの枠がいっぱいです。次のターンに自動で出します。`,
  }[a?.state] ?? (() => L`まもなく村の申し込みを自動で出します。`);
  return html`<section class="vcard wait-card" aria-labelledby="join-sites">
    ${waitHead(FS, again ? L`新しい村の場所を探しています` : L`村の申し込みを出しています`)}
    <div class="wait-state"><p role="status">${line()}</p>
      ${a?.state === 'waiting' && FS.landRec?.autoTryFailed ? html`<div class="actions wait-acts"><button type="button" class="btn" data-act="auto-ticket">${icon('return')}${L`いますぐやり直す`}</button></div>` : ''}</div>
    ${waitClockBox(c, L`次のターンまで`)}
    ${endLine(FS)}
    ${practiceOffer()}
    ${howFold(HOW_PLACE())}</section>`;
}

/**
 * A request is in: the one large number is how long until the village is decided, with the turn whose bell
 * decides it; the candidate places by name, numbered as the map numbers them — each row asks the map to go there
 * (`data-act="site-go"`: app.mjs sends `wylls:fly-to` with the site); the practice battle offered.
 */
function renderTicket(FS) {
  const t = FS.land.ticket;
  const c = waitClock(FS);
  return html`<section class="vcard wait-card" aria-labelledby="join-sites">
    ${waitHead(FS, L`村の場所が決まるのを待っています`)}
    ${waitClockBox(c, L`村が決まる鐘まで`)}
    <div class="wait-state"><p role="status">${L`村の申し込みは済んでいます。候補地のどれかに、あなたの最初の村ができます。`}</p></div>
    <p class="c-label"><span>${L`村の候補地`}</span></p>
    <ol class="doc-rows site-rows">${t.sites.map((s, i) => html`<li ${raw(i < t.next ? 'class="done"' : '')}><button type="button" class="doc-row site-row" data-act="site-go" data-i="${i}" data-p="${s.p}" data-q="${s.q}" data-site="${s.site}" aria-label="${L`${siteText(s)}を地図で見る`}"><span class="site-n" aria-hidden="true">${i + 1}</span><span class="doc-row-t">${siteText(s)}${i < t.next ? html` <span class="muted">${L`（ふさがっていた）`}</span>` : ''}</span>${icon('pin', 'doc-row-go')}</button></li>`)}</ol>
    ${endLine(FS)}
    ${practiceOffer()}
    ${howFold(html`<p class="muted">${FS.landRec?.ticketSource === 'overflow' ? L`自分の国の土地に空きがなかったため、候補地は隣の国の土地のいちばん外の輪から自動で選びました。場所を得られなければ、自動でもう一度申し込みます。` : L`候補地は自分の国の土地から自動で選びました。場所を得られなければ、自動でもう一度申し込みます。`}</p>
      <p class="muted">${L`同じターンの申し込みは、そのターンのくじでまとめて公平に決まります（申し込んでから約11〜21分）。`}</p>`)}</section>`;
}

function renderProvisional(FS) {
  const h = activeHolding(FS);
  const times = FS.clock && h ? ticketTimes(FS.clock, h.ticketBell) : null;
  return html`<section class="vcard" aria-labelledby="join-prov">${cardHead({ id: 'join-prov', ic: 'home', title: h ? holdingName(h) : HOLDING_STATES.provisional, side: stamp(HOLDING_STATES.provisional, 'warn') })}
    ${h ? html`<p>${L`${provinceName(FS, h.p, h.q, { own: false })}に、あなたの村ができました。`}</p>` : ''}
    ${times ? html`<p>${Lh`同じターンの申し込みがすべて決まると確定します（遅くとも ${timeHtml(times.cohortEndsBy)}）。それまでは、より順位の高い申し込みに押し出されることがあります。`}</p>` : ''}
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
