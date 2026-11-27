// Join (web design §7.2; contract §5.9, I-40, I-51; owner decision V2: joining is
// choosing one of the six nations, nothing else): wallet → nation → the in-game key
// (the wallet signs the session text) → Join (relay-paid). New seasons place a
// confirmed village immediately in the chosen nation's free land. M1 instead
// chooses up to three sites and files a ticket (controller.mjs autoTicket);
// a displaced or ended ticket is filed again automatically. There is no site
// picker. On screen the M1 ticket is called the
// "village request" (村の申し込み) and a bell by its turn's number (UX design 11.13).
import { activeHolding } from '../fstate.mjs';
import { territoryEnabled } from '../territory.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum, lang } from '../../lang.mjs';
import { factionName, DOCTRINE_NAMES, HOLDING_STATES, failureText } from '../fi18n.mjs';
import { freeByNation, ticketTimes } from '../fland.mjs';
import { heartlandFull, noFreeHome, homeRingsOpen, seasonPlace } from '../home.mjs';
import { contiguousRings, worldOf } from '../map/world.mjs';
import { dueHtml } from './shell.mjs';
import { leaderFigure, leaderHex, leaderSvg, DOCTRINE_PITCH } from '../people/leaders.mjs';
import { placeName } from '../people/identity.mjs';
import { holdingName, ownIdentity } from '../people/ui.mjs';
import { displayName } from '../people/identity.mjs';
import { sigilPath } from '../people/avatar.mjs';
import { NATION_FILL, NATION_DARK, NATION_ON } from '../palette.mjs';
import { crestSvg } from '../hud/hud.mjs';
import { icon } from '../hud/icons.mjs';
import { provinceName } from '../hud/place.mjs';
import { countdown } from '../clock.mjs';
import { cardHead, stamp, fold, ring } from './parts.mjs';
import { bellStart, BELL_SECS } from '../clock.mjs';
import { leaderWords } from '../map/waitview.mjs';
import { renderJoinTerms } from './prize.mjs';
import { tokenUnits } from '../fprize.mjs';
import { delegationOf, keyHint, registeredKey, renderDelegated } from '../fdelegation.mjs';
import { deadlineLine, wrongStatusWhy } from '../seasonterms.mjs';
import { renderWorldLines } from '../hud/worldclock.mjs';

const FACTIONS = [0, 1, 2, 3, 4, 5];
/** A candidate place by the name a village there would carry, never by its number or its coordinates (the row flies there). */
const siteText = s => placeName(s.p, s.q, s.site)[lang() === 'en' ? 'en' : 'ja'];

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

/**
 * The faction cards: name, colour, doctrine, free land of the nation's home region (an upper bound from the
 * overviews, under the season's first-home placement: fland.mjs freeByNation). `free` is null when the placement
 * cannot be read (the dispersed placement without its seed): the count is unavailable, and the confirm line says so
 * rather than a number of the wedge. The count stops at the rings a first village may be placed in (home.mjs
 * homeRingsOpen: the open rings, no further than the heartland on a v2 Season), so land a grown map opened past the
 * heartland is not counted as a place for a village; with no season record yet the overviews alone bound it.
 */
export function factionCards(FS) {
  // (the rings a first village may be in are counted from province (0, 0) without a gap — map/world.mjs contiguousRings —
  //  never by the record's length: a sparse world that seeds ring 128 alone has one entry and no ring 0)
  const open = FS.record ? contiguousRings(FS.world ?? worldOf(FS.record)) : undefined;
  const free = freeByNation(FS.overviews ?? new Map(), seasonPlace(FS.season), { ringsOpen: Number.isInteger(open) ? homeRingsOpen(FS.season, open) : Infinity });
  // (fix-loop16, owner Q-LP16-4 (a): `ai` — a local world's launcher says this nation has an operator AI resident)
  const ai = Array.isArray(FS.localPlay?.aiNations) ? FS.localPlay.aiNations : [];
  return FACTIONS.map(f => ({ faction: f, name: factionName(f), doctrine: DOCTRINE_NAMES[f], free: free ? free[f] : null, chosen: FS.joinDraft?.faction === f, ai: ai.includes(f) }));
}

/**
 * The nation choice (UX design 7.2 and 11.9; owner decision V2: joining is choosing one of the six nations,
 * nothing else): six standing banners of cloth — the nation's crest on the rail, its character (the look every player
 * of that nation wears: choosing a nation is choosing your character; no name, no title) standing lit before the
 * cloth (breathing while the banner is looked at; the chosen one's flourish plays once: people/leader-sprite.mjs;
 * the figure is the banner's neighbour in the list item, laid over it: a canvas inside the banner's own shadow filter
 * made the browser work the filter out again on every frame),
 * the nation's name and its doctrine on the dyed field under it — and one confirm line. One choice, one
 * confirm, no site picker. A banner carries `data-nation`: app.mjs sends `wylls:nation-focus` on hover, focus
 * and choice (the map lights that nation's home wedge) and marks the panel with `data-look`, so the confirm
 * line says the doctrine and the creed of the banner that is looked at (all six are in the markup; the stylesheet
 * shows one). On a phone the banners are compact (crest, name, doctrine: all six in sight) and the confirm line
 * carries the rest. Without a wallet the confirm line offers to connect one first; the choice is already made.
 */
/**
 * (2026-11-17, ⑦) Under a failed or empty reading of the first village's candidates: the way to read them again, in
 * another order (controller rereadHomes — reads only). Not while a join / placing or a reading is under way.
 */
const homeReread = (FS, busy) => (FS.mode === 'play' ? html`<div class="actions"><button type="button" class="btn small" data-act="home-reread" ${raw(busy || FS.homeChoice?.loading ? 'disabled' : '')}>${icon('return')}${L`土地の候補を読み直す`}</button></div>` : '');
// (fix-devnet-join-wait, herald-load-50 F3) The confirm's wait for the page's OWN record after a send the chain took
// (controller.mjs waitForOwn: `homeChoice.ownWait = {what, secs}` while it waits; an error with `retry` when it ended
// without the record). The wait is said with what it waits for and how long, and a wait that ended offers to look
// again (home-confirm: the press asks about the noted send and never sends it again) instead of the candidates' reread.
const OWN_WAIT_WHAT = { join: () => L`参加`, ticket: () => L`村の申し込み`, home: () => L`村の確定` };
// (cls: `nc-early` on the nation choice's dark confirm plate — readable there, as its other status lines; `home-status` on the placing card)
const ownWaitLine = (FS, cls = 'home-status') => {
  const w = FS.homeChoice?.ownWait;
  if (!w) return '';
  return html`<p class="${cls}" role="status" data-own-wait="${w.what}">${L`記録を待っています…（${OWN_WAIT_WHAT[w.what]?.() ?? ''}、${fmtNum(w.secs)} 秒）命令は受け付けられました。このページの読み取り先は確定した記録だけを読むので、devnet では反映まで数十秒かかることがあります。押し直す必要はありません。`}</p>`;
};
const homeErrorActions = (FS, busy) => (FS.homeChoice?.error?.retry
  ? html`<div class="actions"><button type="button" class="btn small" data-act="home-confirm" data-own-retry="${FS.homeChoice.error.waited ?? ''}" ${raw(busy ? 'disabled' : '')}>${icon('return')}${L`もう一度確かめる`}</button></div>`
  : homeReread(FS, busy));

/**
 * (2026-11-18, ⑧ doc 31 §1 option A; page only) The heartland — the land where a first village is placed at once — has
 * no free site for the nation: one line that says so and what happens instead (the village request, the program's
 * own FileTicket path, unchanged). `data-home-fallback` = "request" in the request's wait view (a Citizen without a
 * village), "nation" under the nation choice (a visitor: what beginning with this nation will do).
 * (The nation line wears `nc-early`, the confirm plate's own status line: readable on the dark plate, shown on a phone.)
 */
const fallbackLine = () => html`<p class="muted" data-home-fallback="request">${L`すぐに村を置ける本国の土地は、いま空いていません。代わりに、空いている土地へ村の申し込みを出します。`}</p>`;
const fallbackNation = (FS, busy) => { const again = homeReread(FS, busy); return html`<p class="nc-early" role="status" data-home-fallback="nation">${L`この国は、すぐに村を置ける本国の土地がいま空いていません。この国で始めると、代わりに空いている土地へ村の申し込みを出します（村が決まるまで約11〜21分）。本国に空きのある国なら、すぐに村を置けます。`}</p>${again}`; };
/** Whether the nation choice says that line: a wallet that has not joined, in play (not local play: no FileTicket there), the chosen nation full. */
const nationFull = FS => { const f = FS.joinDraft?.faction; return Number(FS.season?.programVersion ?? 1) >= 2 && FS.mode === 'play' && !FS.localPlay && !FS.citizen && !FS.resident && (noFreeHome(FS.homeChoice, f) || (Number.isInteger(f) && FS.homeChoice?.full === f)); };

export function renderNations(FS) {
  // (⑧ doc 31 §1-A: a full heartland is not a failed reading on this screen — the press joins and the village request
  //  follows, controller confirmHome — so the choice is drawn without its error and with `fallbackNation` instead)
  if (nationFull(FS) && FS.homeChoice.error) return renderNations({ ...FS, homeChoice: { ...FS.homeChoice, error: null, full: FS.homeChoice.faction } });
  const cards = factionCards(FS);
  const pick = cards.find(c => c.chosen) ?? null;
  const instant = Number(FS.season?.programVersion ?? 1) >= 2;
  const busy = !!FS.homeChoice?.busy || !!FS.homeChoice?.pending || FS.inFlight > 0 || !!FS.homeConfirmWait;
  // Before the first turn the program has no turn to place a village in (PlaceHome: WrongStatus): say so, no button to fail.
  const now = FS.chain?.now?.() ?? null, g = FS.clock?.genesisTs;
  const early = instant && now !== null && Number.isFinite(g) && now < g ? Math.max(1, Math.ceil((g - now) / 60)) : 0;
  // the season's deadlines, read from the season (frontier/seasonterms.mjs): after the join deadline the program refuses
  // the join (WrongStatus); the button says why instead of failing
  const closed = wrongStatusWhy(FS, 'join');
  // The season's join gate (I-51), or a relay that answered InviteRequired.
  // A season with a prize pool is joined by paying its fee (x402), not with an invite.
  const gated = !FS.prize && (FS.inviteRequired || !!FS.season?.joinGate?.some?.(x => x !== 0));
  const banners = cards.map(c => html`<li><button type="button" class="banner-pick bn${c.faction}" data-act="pick-faction" data-f="${c.faction}" data-nation="${c.faction}" data-flourish="attack" aria-pressed="${c.chosen ? 'true' : 'false'}"${raw(busy ? ' disabled' : '')}>
    <span class="bn-rim"><span class="bn-cloth"><span class="bn-face"></span>
      <span class="bn-field"><strong class="bn-name">${c.name}</strong><span class="bn-creed">${L`教義：${c.doctrine}`}</span>${c.ai ? html`<span class="bn-ai" data-ai="1">${L`AIあり`}</span>` : ''}</span></span></span>
    <span class="bn-hex">${raw(leaderHex(c.faction, { size: 44 }))}</span>
    <span class="bn-crest">${crestSvg(c.faction, { size: 30 })}</span>${c.chosen ? html`<span class="bn-mark" aria-hidden="true">${icon('check')}</span>` : ''}
  </button><span class="bn-figure">${raw(leaderFigure(c.faction, { motion: c.chosen ? 'attack' : 'idle', once: c.chosen ? `pick-${c.faction}` : null, when: 'look' }))}</span></li>`);
  // each nation's character, its doctrine and what it is good at, in a line: the looked-at banner's, else the chosen one's
  const says = cards.map(c => html`<div class="nc-item${c.chosen ? ' nc-def' : ''}" data-n="${c.faction}" ${raw(c.chosen ? 'aria-live="polite"' : 'aria-hidden="true"')}><span class="nc-fig">${raw(leaderFigure(c.faction, { motion: c.chosen ? 'attack' : 'idle', once: c.chosen ? `pick-${c.faction}` : null }))}</span><span class="nc-face">${raw(leaderSvg(c.faction, { size: 76, shape: 'card' }))}</span>${crestSvg(c.faction, { size: 34 })}<div class="nc-text"><strong class="nc-name">${c.name} <span class="nc-title">— ${L`教義：${c.doctrine}`}</span></strong>
      <span class="nc-pitch">${DOCTRINE_PITCH[c.faction]()}</span>${c.ai ? html`<span class="nc-pitch nc-ai">${L`この国にはAIの住民がいます。選ぶと、そのAIは同じ国の仲間になります。`}</span>` : ''}</div></div>`);
  const confirm = html`<div class="nation-confirm${pick ? '' : ' nc-empty'}">
    <div class="nc-what" data-stable="join-says">${says}${pick ? '' : html`<div class="nc-item nc-def"><span class="nc-hint">${icon('banner')}</span><div class="nc-text"><strong class="nc-name">${L`旗を一つ選んでください`}</strong><span class="nc-pitch">${L`選ぶのは国だけです。最初の村の場所は自動で決まります。`}</span></div></div>`}</div>
    <div class="nc-go">
      ${gated ? html`<label class="field nc-invite">${L`招待コード`}<input name="invite" autocomplete="off" data-bind="invite" value="${FS.joinDraft?.invite ?? ''}"></label>` : ''}
      ${FS.wallet ? html`<button type="button" class="btn primary nc-btn" data-stable="join-go" data-act="${instant ? 'home-confirm' : 'join'}" ${raw(pick && !busy && !early && !closed ? '' : 'disabled')}>${icon('banner')}${busy ? L`村を準備しています…` : early ? L`最初のターンの始まりを待っています` : pick ? L`${pick.name}で始める` : L`国を選んで始める`}</button>${early ? html`<p class="nc-early" role="status">${L`最初のターンが始まると参加できます（あと約 ${early} 分）。国はいま選んでおけます。`}</p>` : ''}${closed ? html`<p class="nc-early" role="status">${closed}</p>` : ''}`
        : html`<div class="nc-wallet"><span class="nc-wallet-k">${L`始めるには、先にウォレットをつなぎます。`}</span>${walletButtons(FS)}</div>`}
    </div>
    ${instant && FS.homeChoice?.error ? html`<p class="notice error" role="alert">${FS.homeChoice.error.text ?? failureText(FS.homeChoice.error)}</p>${homeErrorActions(FS, busy)}` : ''}
    ${instant ? ownWaitLine(FS, 'nc-early') : ''}
    ${instant && FS.homeChoice?.loading ? html`<p class="muted" role="status" data-homes="loading">${L`土地の候補を読み込んでいます…`}</p>` : ''}
    ${instant && FS.homeDropped && !busy && !FS.citizen ? html`<p class="notice" role="status" data-home-dropped="${FS.homeDropped.why ?? 'context'}">${FS.homeDropped.why === 'unread'
      ? L`土地の候補を読み終えられなかったので、さきほどの「始める」は取り消しました（何も送っていません）。もう一度押してください。`
      : L`読み込みの間に世界かウォレットの状態が変わったので、さきほどの「始める」は取り消しました（何も送っていません）。もう一度押してください。`}</p>` : ''}
    ${nationFull(FS) ? fallbackNation(FS, busy) : ''}
    <p class="nc-note">${FS.sample?.demo ? L`国を選ぶだけで始められます。ほかの五つの国の村を治めているのが人かAIかは、地図を見てもわかりません。この体験版はブラウザの中だけで動き、ページを開き直すと最初からになります。` : territoryEnabled(FS) ? L`国を選ぶだけで始められます。この開発版の進行は、サーバーを再起動すると最初からになります。` : FS.localPlay ? L`この試験用の世界では、このページのテスト用ウォレットが自分で署名します（ウォレットの確認画面も、ゲーム内の鍵もありません）。` : FS.devnetPlay ? L`devnet では、あなたのウォレットが命令ごとに1回だけ署名し、手数料と家賃もウォレットから払います（devnet の SOL で、価値はありません。ゲーム内の鍵は作りません）。` : FS.wallet ? L`ウォレットが2回、確認を求めます。ゲーム内の鍵を作るための署名と、参加のための署名です。` : L`ウォレットを使うのは、参加の署名のときだけです。そのあとの操作はこの端末のゲーム内の鍵が署名し、手数料はゲーム側が立て替えます（テスト用の SOL で、価値はありません）。`}${pick ? html` ${pick.free === null ? L`この国の土地に村を置ける場所の数は、いまは分かりません。` : L`この国の土地には、村を置ける場所があと約 ${fmtNum(pick.free)} あります。`}` : ''}${deadlineLine(FS) ? html` <span class="nc-deadline-in">${deadlineLine(FS)}</span>` : ''}</p>
    ${deadlineLine(FS) ? html`<p class="nc-note nc-deadline">${deadlineLine(FS)}</p>` : ''}
    ${FS.localPlay?.aiNear ? html`<p class="nc-note nc-ai-near">${L`起動オプション --ai-near：あなたの最初の村が建つと、AIの住民が1人、いちばん近いほかの国に入り、近くに村を出します（その1人は、上の「AIあり」の印には入っていません）。`}</p>` : ''}
    ${renderWorldLines(FS)}
    ${FS.prize && !FS.citizen ? renderJoinTerms(FS) : ''}
  </div>`;
  return html`<section class="nations" aria-labelledby="join-faction">
    <header class="nations-head"><h3 id="join-faction">${L`国を選ぶ`}</h3><p>${L`六つの国が、果てのない辺境を分け合っています。国で決まるのは、村を置く土地と教義、そしてあなたの姿です。`}</p></header>
    <ul class="banners" data-stable="join-banners">${banners}</ul>
    ${confirm}
  </section>`;
}

function renderSessionFix(FS) {
  // A different registered key can belong to another app or device (③'s courier, an agent). SetSession replaces that
  // key on chain: it is never described as merely restoring a missing local key, and never sent from this card's
  // plain button (Q16-3; fdelegation.mjs renders the warning, the controller's `session` refuses to replace).
  const held = delegationOf(FS);
  if (held) return renderDelegated(held, { kept: !!held.foreign && FS.keyKept === held.agentKey });
  return html`<section class="vcard" aria-labelledby="join-key">${cardHead({ id: 'join-key', ic: 'lock', title: L`ゲーム内の鍵` })}
    <p>${L`この端末にはこの世界のゲーム内の鍵がありません。ウォレットで同じ文面に署名すると、同じ鍵を作り直せます。`}</p>
    ${registeredKey(FS.citizen) ? keyHint() : ''}
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
export const waitNote = c => (c?.kind !== 'result' ? '' : c.tolled ? L`ターンが変わりました。約 ${fmtNum(c.after)} 分で決まります。` : L`ターン ${fmtNum(c.turn)} に変わったあと、約 ${fmtNum(c.after)} 分で決まります。`);

/**
 * A nation's standard as a picture for the page (the one the map plants in the home wedge, map/ownland.mjs
 * paintStandard): a pole with a gold finial, a swallow-tail pennon in the nation's colour, the nation's sigil on it.
 * Attributes only (the page's CSP allows no style attribute); decorative: the nation is named beside it.
 */
export function standardSvg(faction, { height = 120 } = {}) {
  const f = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : 0;
  const fill = NATION_FILL[f], dark = NATION_DARK[f], on = NATION_ON[f];
  return raw(`<svg class="standard" viewBox="0 0 80 150" width="${Math.round((height * 80) / 150)}" height="${height}" aria-hidden="true" focusable="false">
    <ellipse cx="13" cy="146" rx="11" ry="3" fill="#000" opacity=".4"/>
    <path d="M13 146V9" stroke="#0c1614" stroke-width="5.5" stroke-linecap="round"/><path d="M13 146V9" stroke="#7a5634" stroke-width="3" stroke-linecap="round"/><path d="M12 146V9" stroke="#b08a5a" stroke-width="1" stroke-linecap="round" opacity=".7"/>
    <path d="M14.5 13C34 10 54 16 76 12L62 30 76 49C54 52 34 46 14.5 49Z" fill="${fill}" stroke="${dark}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M16 15.5C34 13 52 18 70 15.5L66 20.5C50 23 34 18 16 20.5Z" fill="#fff" opacity=".22"/>
    <g transform="translate(36 31)"><path d="${sigilPath(f, 8.6)}" fill="${on}" stroke="${dark}" stroke-width=".8" stroke-linejoin="round"/></g>
    <path d="M13 1.5L17.5 8 13 14.5 8.500 8Z" fill="#f0d48a" stroke="#7d6428" stroke-width="1.2" stroke-linejoin="round"/></svg>`);
}

/**
 * The waiting view's scene and head (UX design 13.6: the wait is a view worth looking at, on a phone too): on a
 * small stage in the dark of the table, lit in the nation's colour, the nation's standard and the player's own
 * character standing by it (breathing; a still under reduced motion: people/leader-sprite.mjs); beside them who the
 * viewer is and which nation was joined, and the state in one line (the card's title). Under the stage the nation's
 * words, with no named speaker (map/waitview.mjs nationWords: the same words the map writes under the standard in
 * the home wedge; while this card stands open the page tells the map, `wait.wordsSaid`, and the map leaves its own out).
 */
function waitHead(FS, title, state = null) {
  const f = FS.citizen?.faction, known = Number.isInteger(f) && f >= 0 && f < 6;
  const say = known && !['granted', 'instant'].includes(state) ? leaderWords(f, state) : null;
  let me = null;
  try { me = known ? ownIdentity(FS) : null; } catch { me = null; }
  return html`<div class="wait-scene${known ? '' : ' wait-scene-plain'}" ${raw(known ? `data-nation="${f}"` : '')}>
      ${known ? html`<span class="ws-cast"><span class="ws-standard">${standardSvg(f)}</span><span class="ws-figure">${raw(leaderFigure(f))}</span></span>` : ''}
      <div class="wait-who">${known ? html`<span class="wait-nation">${crestSvg(f, { size: 20 })}${L`${factionName(f)}に加わりました`}</span>` : ''}
        <h3 id="join-sites">${title}</h3>
        ${known ? html`<span class="ws-you">${me ? html`<span class="ws-name" data-name>${displayName(me, { full: true })}</span>` : ''}<span class="ws-creed">${L`教義：${DOCTRINE_NAMES[f]}`}</span></span>` : ''}</div></div>
    ${say ? html`<p class="wait-says"><span class="wait-says-t">${L`「${say.text}」`}</span></p>` : ''}`;
}
/** The one clock, large: what it counts to, the figure, and (for a result) the turn whose bell decides it. */
function waitClockBox(c, label) {
  if (!c) return '';
  return html`<div class="turn-wait"><span class="turn-ring" data-wait-ring>${ring(c.share)}${icon('bell', 'turn-ring-ic')}</span>
    <div class="turn-wait-t"><span class="turn-wait-k">${label}</span><strong class="turn-wait-v" data-wait-clock>${c.text}</strong>${c.kind === 'result' ? html`<span class="turn-wait-n" data-wait-note>${waitNote(c)}</span>` : ''}</div></div>`;
}
// (two sentences, marked apart: a phone's sheet keeps the button and the second one, so the offer stands in the first sight of the view)
const practiceOffer = () => html`<div class="wait-offer"><p><span class="wo-lead">${L`待つあいだに、練習で戦ってみましょう。`}</span><span class="wo-note">${L`何も送らず、何も失いません。`}</span></p>
  <button type="button" class="btn" data-act="practice-open">${icon('swords')}${L`待つあいだに練習で戦ってみる`}</button></div>`;
const howFold = body => fold('wait-how', L`村の場所の決まり方`, body);
const HOW_PLACE = () => html`<p class="muted">${L`場所は選びません。同じターンの申し込みは、そのターンのくじでまとめて公平に決まり、村は次のターンに変わったあと（約11〜21分後）に決まります。`}</p>
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
      ${waitHead(FS, L`村の申し込みが通っていません`, a.state)}
      ${heartlandFull(FS) ? fallbackLine() : ''}
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
    ${waitHead(FS, again ? L`新しい村の場所を探しています` : L`村の申し込みを出しています`, a?.state ?? null)}
    ${heartlandFull(FS) ? fallbackLine() : ''}
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
    ${waitHead(FS, L`村が決まるのを待っています`, 'ticket')}
    ${waitClockBox(c, L`村が決まるターンまで`)}
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
    ${times ? html`<p>${Lh`同じターンの申し込みがすべて決まると確定します。遅くとも${dueHtml(times.cohortEndsBy, FS.chain?.now?.() ?? null)}です。`} ${L`それまでは、より順位の高い申し込みに押し出されることがあります。`}</p>` : ''}
    <p class="muted">${L`仮の村でも収穫・建設・訓練はできます（押し出されると失われます）。軍勢の編成・出発・探索は確定してからです。`}</p></section>`;
}

/** The confirmed first village uses the same character, standard and card design as joining. */
export function renderGrant(FS) {
  const h = FS.homeGrant;
  if (!h || h.state !== 2) return '';
  const stores = h.stores ?? [];
  const kit = [[0, L`食料`], [1, L`木材`], [2, L`石材`], [3, L`鉱石`], [5, L`金`]];
  return html`<section class="vcard wait-card home-grant" aria-labelledby="join-sites">
    ${waitHead(FS, L`ここが、あなたの村です。`, 'granted')}
    <p class="home-village-name">${holdingName(h)}</p>
    <p>${L`村の旗が立ちました。最初の建物を選び、この土地での暮らしを始めましょう。`}</p>
    ${stores.length ? html`<dl class="home-supplies">${kit.map(([i, name]) => html`<div><dt>${name}</dt><dd>${fmtNum(Math.floor(Number(stores[i]?.value ?? 0) / 1000))}</dd></div>`)}</dl>` : ''}
    ${FS.prizePayment ? html`<p class="prize-receipt">${L`参加費 ${tokenUnits(FS.prizePayment.fee)} テストUSDC を支払いました（支払い前 ${tokenUnits(FS.prizePayment.before)} → 支払い後 ${tokenUnits(FS.prizePayment.after ?? 0)}）。`}</p>` : ''}
    <div class="actions"><button type="button" class="btn primary" data-act="home-begin">${icon('hammer')}${L`最初の建設を選ぶ`}</button></div>
  </section>`;
}

function renderInstantPlacing(FS) {
  const choice = FS.homeChoice ?? {};
  const busy = !!choice.busy || !!choice.pending || FS.inFlight > 0 || !!FS.homeConfirmWait;
  const pending = {
    connecting: () => L`参加の準備をしています…`, joining: () => L`所属国への参加を確認しています…`,
    placing: () => L`選んだ土地に村を築いています…`, confirming: () => L`村の受け取りを確認しています…`,
    // (fix-loop6, LP6-9: the rim village's ticket, settled by the world's runner — said with its turn and the turns gone by)
    ticket: () => {
      const at = choice.ticketBell, now = FS.nowBell, gone = Number.isInteger(at) && Number.isInteger(now) ? Math.max(0, now - at) : null;
      return gone === null || !FS.localPlay ? L`辺境の村の申し込みを送りました。世界の進行役がターンの終わりに決めます。`
        : L`辺境の村の申し込みを送りました（ターン ${fmtNum(at)}、${fmtNum(gone)} ターン前）。世界の進行役がターンの終わりに決めます。マシンの負荷が高いと数十ターン（×60 で数分）かかることがあります。このページは待ち続けます。押し直す必要はありません。`;
    },
  };
  const title = busy ? L`村を準備しています…` : L`最初の村を置いています`;
  return html`<section class="vcard wait-card" aria-labelledby="join-sites" aria-busy="${busy ? 'true' : 'false'}">
    ${waitHead(FS, title, 'instant')}
    ${busy ? html`<p class="home-status" role="status">${(pending[choice.pending] ?? pending.confirming)()}</p>${ownWaitLine(FS)}` : html`<p>${L`選ぶのは国だけです。最初の村の場所は自動で決まります。`}</p>`}
    ${choice.error ? html`<p class="notice error" role="alert">${choice.error.text ?? failureText(choice.error)}</p>${homeErrorActions(FS, busy)}` : ''}
    ${choice.loading ? html`<p class="muted" role="status" data-homes="loading">${L`土地の候補を読み込んでいます…`}</p>` : ''}
    ${!FS.citizen ? renderJoinTerms(FS) : ''}
    ${!busy && !choice.error?.retry ? html`<div class="actions"><button type="button" class="btn primary" data-act="home-confirm">${icon('home')}${L`村を築いて始める`}</button></div>` : ''}
  </section>`;
}

const shortKey = k => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;

/**
 * ⑳ (provisional): the wallet's resident NFTs — one NFT, one Citizen. A
 * joined NFT is played at once; a new one joins the chosen nation first.
 * While an NFT is played, the wallet signs every action (no in-game key).
 */
export function renderNfts(FS) {
  if (FS.resident) {
    return html`<section class="vcard" aria-labelledby="join-nft">${cardHead({ id: 'join-nft', ic: 'seal', title: L`NFTで遊んでいます` })}
      <p>${L`住民NFT ${shortKey(FS.resident.asset)} の住民として遊んでいます。操作のたびにウォレットが署名を求めます。NFTを譲渡すると、この端末からは操作できなくなります。`}</p>
      <div class="actions"><button type="button" class="btn" data-act="nft-logout">${L`ウォレットの住民に戻る`}</button></div></section>`;
  }
  // (workstream 07: a list that could not be read is not an empty one: say so, and offer nothing from it)
  if (FS.wallet && FS.nftsRead && !FS.nftsRead.ok) return html`<section class="vcard" aria-labelledby="join-nft">${cardHead({ id: 'join-nft', ic: 'seal', title: L`住民NFTで入る` })}
    <p class="blocked" role="status" data-read="unread">${L`このウォレットの住民NFTを読み込めませんでした（${FS.nftsRead.code ?? '?'}）。NFTが無いという意味ではありません。もう一度読み込むと、また確かめます`}</p></section>`;
  const list = FS.nfts?.residents ?? [];
  if (!FS.wallet || !list.length) return '';
  const pick = Number.isInteger(FS.joinDraft?.faction);
  return html`<section class="vcard" aria-labelledby="join-nft">${cardHead({ id: 'join-nft', ic: 'seal', title: L`住民NFTで入る` })}
    <p class="muted">${L`1枚のNFTにつき1人の住民です。NFTを譲渡すると、住民を操作できるのは新しい持ち主だけになります。`}</p>
    <ul class="wallet-list">${list.map(n => {
      const ok = Number.isInteger(n.generation);
      const label = !ok ? L`住民の記録がありません` : n.joined ? L`このNFTで遊ぶ` : pick ? L`このNFTで参加する` : L`国を選ぶと参加できます`;
      return html`<li><button type="button" class="btn" data-act="nft-login" data-asset="${n.asset}" ${raw(ok && (n.joined || pick) ? '' : 'disabled')}>${label}</button> <span class="muted">${shortKey(n.asset)}</span></li>`;
    })}</ul></section>`;
}

/** Keep the nation choice; newer seasons place its first final village immediately. */
export function render(FS) {
  const stage = FS.land?.stage ?? 'none';
  const instant = Number(FS.season?.programVersion ?? 1) >= 2;
  if (instant && FS.homeGrant?.state === 2) return renderGrant(FS);
  if (stage === 'none') return html`${renderNfts(FS)}${renderNations(FS)}`;
  if (!FS.wallet) return renderWallets(FS);
  // The key is the owner's agent's (handed over on the agent page), ③'s courier's, or another app's or device's: the
  // key card says so, rather than "this device has no game key" (renderSessionFix; Q16-3).
  // ⑳: an NFT Citizen has no in-game key (its wallet signs); no key to fix.
  // (loop-play4 B-7: local play's page-signed economy signs with the page's own test wallet — there is no in-game key to
  //  make or fix (controller.mjs asks for none in local play); while a wide world's rim request settled, this card read as
  //  a key failure for about a minute. The request's own wait view is shown instead)
  // (verify-pr172: devnet play likewise — the connected wallet is the Join's session key and signs every command, the
  //  page makes no in-game key there (controller.mjs confirmHome `!devnetPlay`; the nation card says 「ゲーム内の鍵は作り
  //  ません」). This card stood over the rim request's wait — its 「記録を待っています…」 line and 「もう一度確かめる」 — and
  //  over the whole ticket turn, offering 「鍵を作り直す」 for a key devnet never uses)
  if (!FS.resident && !FS.localPlay && !FS.devnetPlay && (!FS.session || FS.sessionProblem)) return renderSessionFix(FS);
  if (stage === 'ticket') return renderTicket(FS);
  if (stage === 'provisional') return renderProvisional(FS);
  if (stage === 'final') return html`<p>${L`村が確定しました。「村」から始めましょう。`}</p>`;
  // (⑧ doc 31 §1-A: a full heartland — the request's wait view, with its one line of reason, not the planner)
  if (instant && stage !== 'refugee' && !(Number(FS.citizen?.flags ?? 0) & (32 | 4)) && !heartlandFull(FS)) return renderInstantPlacing(FS);
  return renderPlacing(FS);
}
