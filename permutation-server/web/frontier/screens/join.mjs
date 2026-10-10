// Join (web design §7.2; contract §5.9, I-40, I-51; owner decision V2: joining is
// choosing one of the six nations, nothing else): wallet → nation → the in-game key
// (the wallet signs the session text) → Join (relay-paid) → this browser picks up to
// three free sites of the home wedge itself and files the ticket (controller.mjs
// autoTicket) → the first village appears at the next bell (about 11–21 minutes;
// final once the cohort closes). A displaced or ended ticket is filed again
// automatically. There is no site picker.
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, Lh, fmtNum } from '../../lang.mjs';
import { factionName, DOCTRINE_NAMES, HOLDING_STATES, failureText } from '../fi18n.mjs';
import { freeByWedge, ticketTimes, homeWedge } from '../fland.mjs';
import { lamports, swatch, timeHtml } from './shell.mjs';
import { leaderCard, ownIdentity, personChip, holdingName } from '../people/ui.mjs';
import { identityOf } from '../people/identity.mjs';
import { renderJoinTerms } from './prize.mjs';
import { tokenUnits } from '../fprize.mjs';

const FACTIONS = [0, 1, 2, 3, 4, 5];
const siteText = s => L`州 ${s.p},${s.q} の区画 ${s.site + 1}`;

function renderWallets(FS) {
  const list = FS.walletList ?? [];
  const items = list.map((w, i) => html`<li><button type="button" class="btn" data-act="connect" data-i="${i}" ${raw(w.why ? 'disabled' : '')}>${w.name}</button>${w.why ? html` <span class="muted">${w.why}</span>` : ''}</li>`);
  return html`<section aria-labelledby="join-wallet"><h3 id="join-wallet">${L`ウォレットをつなぐ`}</h3>
    <p>${L`参加の署名にだけウォレットを使います。遊ぶ操作はこの端末のゲーム内の鍵が署名し、手数料は中継が払います（テスト用の SOL、価値はありません）。`}</p>
    ${items.length ? html`<ul class="list">${items}</ul>` : html`<p class="muted">${L`ウォレットが見つかりません。Solana のウォレットを入れてから読み込み直してください。`}</p>`}</section>`;
}

/** The faction cards: name, colour, doctrine, free land of the home wedge (an upper bound from the overviews). */
export function factionCards(FS) {
  const free = freeByWedge(FS.overviews ?? new Map());
  return FACTIONS.map(f => ({ faction: f, name: factionName(f), doctrine: DOCTRINE_NAMES[f], free: free[homeWedge(f)], chosen: FS.joinDraft?.faction === f }));
}

function renderFactions(FS) {
  const cards = factionCards(FS).map(c => html`<li><button type="button" class="card" data-act="pick-faction" data-f="${c.faction}" aria-pressed="${c.chosen ? 'true' : 'false'}">
    ${leaderCard(c.faction, { size: 88 })}<span class="muted">${L`本拠の扇区の空き区画 約 ${fmtNum(c.free)}`}</span></button></li>`);
  // The season's join gate (I-51), or a relay that answered InviteRequired.
  // A season with a prize pool is joined by paying its fee (x402), not with an invite.
  const gated = !FS.prize && (FS.inviteRequired || !!FS.season?.joinGate?.some?.(x => x !== 0));
  const ready = Number.isInteger(FS.joinDraft?.faction);
  return html`<section aria-labelledby="join-faction"><h3 id="join-faction">${L`国を選ぶ`}</h3>
    <p>${L`選ぶのは六つの国のどれか一つだけです。最初の村の入植希望は、本拠の扇区の空いた区画にこのページが自動で出し、村は次のターン（約11〜21分後）に決まります。`}</p>
    ${FS.prize ? html`<p class="muted">${L`国は本拠の扇区と教義を決めます。季節の終わりに最も多くの州を持つ国が、賞金プール（テストUSDC）を得ます。`}</p>${renderJoinTerms(FS)}`
      : html`<p class="muted">${L`M1 では賞金はありません。国は本拠の扇区と教義を決めます。`}</p>`}
    <ul class="cards">${cards}</ul>
    ${gated ? html`<label class="field">${L`招待コード`}<input name="invite" autocomplete="off" data-bind="invite" value="${FS.joinDraft?.invite ?? ''}"></label>` : ''}
    <button type="button" class="btn primary" data-act="join" ${raw(ready ? '' : 'disabled')}>${L`ゲーム内の鍵を作って参加する`}</button>
    <p class="muted">${L`ウォレットが2回たずねます：ゲーム内の鍵のための文面への署名と、参加の取引への署名です。`}</p></section>`;
}

function renderSessionFix(FS) {
  return html`<section aria-labelledby="join-key"><h3 id="join-key">${L`ゲーム内の鍵`}</h3>
    <p>${L`この端末にはこのシーズンのゲーム内の鍵がありません。ウォレットで同じ文面に署名すると、同じ鍵を作り直せます。`}</p>
    <button type="button" class="btn primary" data-act="session">${L`鍵を作り直す`}</button></section>`;
}

/** Why the last holding or ticket ended (stored with its bell, review finding 7), as a line. */
function endLine(FS) {
  const e = FS.landRec?.landEnd;
  if (!e) return '';
  const t = { displaced: () => L`第${fmtNum(e.bell)}ターン：仮の村は、同じターンのより高い順位の入植希望に押し出されました。`,
    lost: () => L`第${fmtNum(e.bell)}ターン：村を失いました。`,
    ended: () => L`第${fmtNum(e.bell)}ターン：前の入植希望は区画を得られずに終わりました。` }[e.why];
  // once the new ticket has left, the line says so in the past (re-check 7)
  return t ? html`<p class="callout">${t()} ${e.refiled ? L`新しい入植希望を自動で出しました。` : L`空いた区画に、入植希望を自動でもう一度出します。`}</p>` : '';
}

/** While the first holding is being placed (no ticket yet): what this browser is doing about it (review finding 12). */
function renderPlacing(FS) {
  const a = FS.autoTicket;
  const again = !!FS.landRec?.landEnd || FS.land?.stage === 'refugee';
  const retry = html`<button type="button" class="btn" data-act="auto-ticket">${L`いますぐもう一度出す`}</button>`;
  const line = {
    searching: () => html`<p role="status">${L`本拠の扇区で空いた区画を探して、入植希望を出しています…`}</p>`,
    sent: () => html`<p role="status">${L`入植希望を出しました。チェーンの記録に現れるのを待っています。`}</p>`,
    waiting: () => html`<p role="status">${L`このターンの入植希望はもう試しました。次のターンに自動でもう一度出します。`}</p>${FS.landRec?.autoTryFailed ? retry : ''}`,
    room: () => html`<p role="status">${L`空いた区画はありますが、このターンの入植希望の枠がいっぱいです。次のターンに自動で出します。`}</p>`,
    nofree: () => html`<p class="warn" role="status">${L`本拠の扇区にも隣の扇区にも空いた区画が見つかりません。ターンごとに自動で探し直し、新しい輪がひらけばそこを探します。`}</p>${retry}`,
    failed: () => html`<p class="notice error" role="alert">${L`入植希望を出せませんでした：${failureText({ code: a.code })}`} ${L`次のターンに自動でもう一度出します。`}</p>${retry}`,
  }[a?.state] ?? (() => html`<p role="status">${L`まもなく入植希望を自動で出します。`}</p>`);
  return html`<section aria-labelledby="join-sites"><h3 id="join-sites">${again ? L`新しい村の場所を探しています` : L`最初の村を置いています`}</h3>
    ${line()}
    ${endLine(FS)}
    <p class="muted">${L`場所は選びません。同じターンの入植希望はそのターンの乱数でまとめて公平に決まり、村は次のターン（約11〜21分後）に決まります。`}</p>
    <p class="muted">${Lh`預け金：<strong>${lamports(FS.land?.escrowNeeded ?? 0n)}</strong>（村の口座の賃料。村ができればそこへ移り、できなければ払った人に戻ります）`}</p>
    <p><button type="button" class="btn" data-act="practice-open">${L`待つあいだに練習で戦ってみる`}</button></p></section>`;
}

function renderTicket(FS) {
  const t = FS.land.ticket;
  const times = FS.clock ? ticketTimes(FS.clock, t.bell) : null;
  return html`<section aria-labelledby="join-ticket"><h3 id="join-ticket">${L`入植希望（第${fmtNum(t.bell)}ターン）`}</h3>
    <ol class="chosen">${t.sites.map((s, i) => html`<li ${raw(i < t.next ? 'class="done"' : '')}>${siteText(s)}${i < t.next ? html` <span class="muted">${L`（ふさがっていた）`}</span>` : ''}</li>`)}</ol>
    ${times ? html`<p>${Lh`結果は ${timeHtml(times.resultAbout)} ごろ（出してから約11〜21分）に、このターンの乱数で決まります。`}</p>` : ''}
    ${endLine(FS)}
    <p class="muted">${FS.landRec?.ticketSource === 'overflow' ? L`本拠の扇区に空きがなかったため、区画は隣の扇区のいちばん外の輪から自動で選びました。区画を得られなければ、自動でもう一度出します。` : L`区画は本拠の扇区から自動で選びました。区画を得られなければ、自動でもう一度出します。`}</p>
    <p><button type="button" class="btn" data-act="practice-open">${L`待つあいだに練習で戦ってみる`}</button></p></section>`;
}

function renderProvisional(FS) {
  const h = activeHolding(FS);
  const times = FS.clock && h ? ticketTimes(FS.clock, h.ticketBell) : null;
  return html`<section aria-labelledby="join-prov"><h3 id="join-prov">${HOLDING_STATES.provisional}</h3>
    ${h ? html`<p>${L`州 ${h.p},${h.q} の区画 ${h.site + 1} を得ました。`}</p>` : ''}
    ${times ? html`<p>${Lh`同じターンの入植希望がすべて決まると確定します（遅くとも ${timeHtml(times.cohortEndsBy)}）。それまでは、より高い順位の希望に押し出されることがあります。`}</p>` : ''}
    <p class="muted">${L`仮の村でも収穫・建設・訓練はできます（押し出されると失われます）。軍勢の編成・出発・探索は確定してからです。`}</p></section>`;
}

/** The lottery flow remains usable on the seasons that were created with M1. */
function renderLegacy(FS) {
  if (!FS.wallet) return renderWallets(FS);
  const stage = FS.land?.stage ?? 'none';
  if (stage === 'none') return renderFactions(FS);
  if (!FS.session || FS.sessionProblem) return renderSessionFix(FS);
  if (stage === 'ticket') return renderTicket(FS);
  if (stage === 'provisional') return renderProvisional(FS);
  if (stage === 'final') return html`<p>${L`村が確定しました。「村」から始めましょう。`}</p>`;
  return renderPlacing(FS);
}

const sameSite = (a, b) => !!a && !!b && a.p === b.p && a.q === b.q && a.site === b.site;

/** A player has a visible place in the interface before they own any land. */
export function renderHomeIdentity(FS, faction = FS.citizen?.faction ?? FS.homeChoice?.selected?.faction ?? 0) {
  const identity = ownIdentity(FS) ?? { ...identityOf(0n), given: { ja: L`あなた`, en: L`あなた` }, house: { ja: '', en: '' } };
  return html`<div class="home-identity">${personChip(identity, faction, { size: 44 })}<span class="home-identity-role">${FS.citizen ? factionName(FS.citizen.faction) : L`これから始まる、あなたの物語`}</span></div>`;
}

function renderGrant(FS) {
  const h = FS.homeGrant;
  const stores = h.stores ?? [];
  const kit = [[0, L`食料`], [1, L`木材`], [2, L`石材`], [3, L`鉱石`], [5, L`金`]];
  return html`<section class="home-start home-grant" aria-labelledby="home-grant-title">
    ${renderHomeIdentity(FS, h.faction)}
    <div class="home-grant-seal" aria-hidden="true">⚑</div>
    <p class="home-eyebrow">${L`あなたの最初の土地`}</p>
    <h3 id="home-grant-title">${L`ここが、あなたの村です。`}</h3>
    <p class="home-village-name">${holdingName(h)}</p>
    <p>${L`村の旗が立ちました。最初の建物を選び、この土地での暮らしを始めましょう。`}</p>
    <div class="home-allegiance">${swatch(h.faction)}${factionName(h.faction)}<span>${L`所属国`}</span></div>
    ${stores.length ? html`<dl class="home-supplies">${kit.map(([i, label]) => html`<div><dt>${label}</dt><dd>${fmtNum(Number(stores[i]?.value ?? 0) / 1000)}</dd></div>`)}</dl>` : ''}
    ${FS.prizePayment ? html`<p class="prize-receipt">${L`参加費 ${tokenUnits(FS.prizePayment.fee)} テストUSDC を支払いました（支払い前 ${tokenUnits(FS.prizePayment.before)} → 支払い後 ${tokenUnits(FS.prizePayment.after ?? 0)}）。`}</p>` : ''}
    <button type="button" class="btn primary home-primary" data-act="home-begin">${L`最初の建設を選ぶ`}</button>
  </section>`;
}

const HOME_PENDING = {
  connecting: () => L`参加の準備をしています…`,
  joining: () => L`所属国への参加を確認しています…`,
  placing: () => L`選んだ土地に村を築いています…`,
  confirming: () => L`村の受け取りを確認しています…`,
};

function renderChoices(FS) {
  const choice = FS.homeChoice ?? {};
  const candidates = choice.candidates ?? [];
  const selected = choice.selected;
  const busy = !!choice.busy || !!choice.pending;
  const loading = choice.loading || (FS.wallet && FS.meStatus === 'loading');
  const err = choice.error ?? (FS.meStatus === 'error' ? FS.meError ?? { code: 'Unavailable' } : null);
  const gated = !FS.prize && (FS.inviteRequired || !!FS.season?.joinGate?.some?.(x => x !== 0));
  const valid = selected && (!FS.citizen || selected.faction === FS.citizen.faction);
  return html`<section class="home-start" aria-labelledby="home-choice-title" aria-busy="${busy || loading ? 'true' : 'false'}">
    ${renderHomeIdentity(FS)}
    <p class="home-eyebrow">${L`01 / はじまりの土地`}</p>
    <h3 id="home-choice-title">${L`どこから、物語を始めますか。`}</h3>
    <p class="home-intro">${FS.citizen ? L`あなたの国の中から、最初の村を築く土地を選びましょう。` : L`土地を選ぶと、所属する国が決まります。ここが、あなたの村の始まりです。`}</p>
    ${loading ? html`<p class="home-status" role="status">${L`村を築ける土地を探しています…`}</p>` : ''}
    ${err ? html`<p class="notice error" role="alert">${err.text ?? failureText(err)}</p>` : ''}
    <ul class="home-candidates" aria-label="${L`最初の土地の候補`}">${candidates.map((s, i) => {
      const picked = sameSite(s, selected);
      const foreign = FS.citizen && s.faction !== FS.citizen.faction;
      return html`<li><button type="button" class="home-site" data-act="home-pick" data-i="${i}" aria-pressed="${picked ? 'true' : 'false'}" ${raw(busy || foreign ? 'disabled' : '')}>
        <span class="home-site-mark f${s.faction}" aria-hidden="true">${picked ? '⚑' : '⌂'}</span>
        <span class="home-site-copy"><strong>${holdingName(s)}</strong><span>${swatch(s.faction)}${factionName(s.faction)}</span><small>${L`州 ${s.p},${s.q} · 区画 ${s.site + 1}`}</small></span>
        <span class="home-site-check" aria-hidden="true">${picked ? '✓' : '○'}</span>
      </button></li>`;
    })}</ul>
    ${!loading && !candidates.length ? html`<p class="home-status">${L`いま選べる土地が見つかりません。候補を探し直してください。`}</p>` : ''}
    ${valid ? html`<div class="home-nation"><p class="home-eyebrow">${L`この土地で暮らす国`}</p>${leaderCard(selected.faction, { size: 64 })}<button type="button" class="btn small" data-act="home-preview" ${raw(busy ? 'disabled' : '')}>${L`地図で場所を見る`}</button></div>` : ''}
    ${gated && !FS.citizen ? html`<label class="field">${L`招待コード`}<input name="invite" autocomplete="off" data-bind="invite" value="${FS.joinDraft?.invite ?? ''}" ${raw(busy ? 'disabled' : '')}></label>` : ''}
    ${!FS.citizen ? renderJoinTerms(FS) : ''}
    <div class="home-confirm"><button type="button" class="btn primary home-primary" data-act="home-confirm" ${raw(!valid || busy || loading || FS.meStatus === 'error' ? 'disabled' : '')}>${busy ? L`村を準備しています…` : L`この土地に村を築く`}</button>
      ${busy ? html`<p class="home-status" role="status">${(HOME_PENDING[choice.pending] ?? HOME_PENDING.confirming)()}</p>` : html`<p class="muted">${L`確定すると、選んだ土地があなたの村になります。`}</p>`}</div>
    <button type="button" class="btn small home-refresh" data-act="home-refresh" ${raw(busy || loading ? 'disabled' : '')}>${L`候補を探し直す`}</button>
    ${!FS.wallet && selected ? html`<details class="home-wallet"><summary>${L`参加に使うウォレット`}</summary>${renderWallets(FS)}</details>` : ''}
  </section>`;
}

/** New seasons grant a real, final village; old seasons retain their lottery. */
export function render(FS) {
  if (Number(FS.season?.programVersion ?? 1) < 2) return html`<p class="muted home-legacy">${L`このシーズンは、土地が抽選で決まる以前のルールです。土地を選んですぐに始める体験は、新しいシーズンで遊べます。`}</p>${renderLegacy(FS)}`;
  if (FS.homeGrant?.state === 2) return renderGrant(FS);
  const stage = FS.land?.stage ?? 'none';
  if (FS.citizen && (!FS.session || FS.sessionProblem)) return html`${renderHomeIdentity(FS)}${renderSessionFix(FS)}`;
  if (!(FS.holdings?.length) && (stage === 'refugee' || (Number(FS.citizen?.flags ?? 0) & (32 | 4)))) return html`${renderHomeIdentity(FS)}${renderPlacing(FS)}`;
  // An in-flight legacy ticket must finish before a new land action is possible.
  if (stage === 'ticket') return html`${renderHomeIdentity(FS)}${renderTicket(FS)}`;
  if (stage === 'provisional') return html`${renderHomeIdentity(FS)}${renderProvisional(FS)}`;
  if (stage === 'final') return html`${renderHomeIdentity(FS)}<p>${L`村が確定しました。「村」から始めましょう。`}</p>`;
  return renderChoices(FS);
}
