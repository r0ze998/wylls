// 依頼の画面。署名はゲームと同じウォレット（同じ入口の Dev Wallet）で行う。物を動かすのはゲームの隊商だけ。

import { RESOURCE_JA, signRecord, ownerTagOf, RESOURCES, ctxKey } from './record.mjs';
import { pendingSendOf } from './pending.mjs';
import { deliveredText, FULFILMENT_JA } from './ws04.mjs';
import { fulfilBoundsText, jointPrecisionText, lowerBoundText } from './fulfil-bounds.mjs';
import { STATE_JA } from './arrival.mjs';
import { OUTCOME_JA, requestHistory } from './history.mjs';
import { jointOfRequest, requestsOfJoint, personalLinks, sameCtx } from './crosslinks.mjs';
import * as W from '../../../permutation-server/web/wallet.mjs';
import { mountOf, under } from './mount.mjs';
import { equal } from '../../../permutation-server/web/sdk/bytes.mjs';
import { parseTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { encode as toBase58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { planSend, sendPlanned } from './send.mjs';
import { rpcReader, sendOutcome } from './chain.mjs';
import { sourceCandidates, sourceToUse, placeKey, planBasisOf } from './sources.mjs';
import { GAME_PAGE, compositionOf, compositionText } from './composition.mjs';
import { arrivedCandidates, excludedCaravans, createArrivedPicks, renderArrived, arrivedClick } from './arrived.mjs';
import { shown } from './lang.mjs';   // 表示の言語（日本語か英語）。この画面の文は日本語のまま書き、表示だけを lang.mjs が英語にする

// (fix-loop14, LP14-14) A wallet's name is its own (the wallet standard's `name`: whatever the wallet calls itself). The
// local test world's page key calls itself in English (permutation-server/web/frontier/hud/coopboard-local.mjs
// COOP_WALLET_NAME), so the Japanese board read 「署名する人：GMqY…XsTU（Local Play Wallet (memory only) — co-op records
// only）」. That one name is said in the board's own words (the English table gives the English back); any other wallet's
// name is shown as it is.
// (verify-pr217: the wallet chooser's row above the line said the same English name; it uses the same words.)
const LOCAL_TEST_WALLET = 'Local Play Wallet (memory only) — co-op records only';
const walletWords = name => (name === LOCAL_TEST_WALLET ? 'このページのテスト用の鍵（メモリのみ・協力の記録だけに署名）' : name);

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = a => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '?');
// (fix-loop9, LP9-8: the nations by their names — the game page's (permutation-server/web/i18n.mjs CIV_NAMES), in the
//  program's order — not 「国1…国6」, which read as a different nation: Borealis was listed as 「…（国1）」)
export const NATION_JA = Object.freeze(['アステル', 'ボレアリス', 'シンダー', 'ダンマール', 'エンバー', 'フィヨルダル']);
const nationName = n => NATION_JA[Number(n)] ?? `国${Number(n) + 1}`;
const needText = o => Object.entries(o ?? {}).map(([r, v]) => `${RESOURCE_JA[r] ?? r} ${v}`).join('・') || '—';
const VERIFICATION_JA = { RuleDerived: '規則から', Recorded: '記録から', Unverifiable: '確認できない', KnownZero: '0 と分かっている' };
const REQ_JA = { open: '受付中', cancelled: '取り消し', expired: '期限切れ' };
const CANCEL_JA = { self: '自分で進める', other: 'ほかの理由', done: '足りた', left: '目的から抜けた' };

let cfg = null, view = null, feed = null, signer = null;
/** 送った後に結果を確かめる回数（1.5 秒ごと）。?follow= で変えられる（試験用）。 */
const FOLLOW_TRIES = Math.max(1, Math.min(60, Number(new URLSearchParams(location.search).get('follow')) || 20));
const goalId = 'crossing-storehouse-v1';

function say(text, kind = '') { $('msg').innerHTML = text ? `<span class="${kind}">${esc(text)}</span>` : ''; }

// （2026-11-18、B13）板が入口の下の道に置かれたとき（ローカルプレイの世界ごとの板）、/coop/*・/h/* はその下で読む
const MOUNT = mountOf(globalThis.location?.pathname);
const at = p => under(MOUNT, p);

async function api(path, body) {
  const r = await fetch(at(path), body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}
/**
 * （2026-11-17）読むだけ（GET）：2xx の JSON だけを答えにする。それ以外（4xx・5xx・JSON でない・届かない）は失敗として投げる
 * （空や成功にしない）。POST（記録を出す）は api() のまま：板は断りを 400 の {ok: false, why} で返し、post() がそれを読む。
 */
async function apiRead(path) {
  let r;
  try { r = await fetch(at(path)); } catch (e) { throw new Error(`届かない（${e.message ?? e}）`); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try { return await r.json(); } catch { throw new Error('答えが JSON でない'); }
}
/** （2026-11-17）板の view（goal.mjs coopView ＋ board.mjs view）が、この画面の描く形か。違えば当てない。 */
const viewShapeOk = v => !!v && typeof v === 'object' && Array.isArray(v.requests) && Array.isArray(v.arrivals) && Array.isArray(v.joint)
  && (v.nation === null || v.nation === undefined || typeof v.nation === 'object') && (v.personal === null || v.personal === undefined || typeof v.personal === 'object');
/** （2026-11-17）読み込みの状態の一行（操作の知らせ msg とは別の欄。無ければ作る）。 */
function readState(text) {
  let p = document.getElementById('readState');
  if (!p) { p = document.createElement('p'); p.id = 'readState'; p.className = 'warn'; p.dataset.testid = 'read-state'; $('msg').after(p); }
  p.textContent = text ?? ''; p.hidden = !text;
}

/** 板のネットワーク（Wallet Standard の chain）。板の --cluster（既定 localnet）。 */
const chainOf = () => W.chainOf(cfg?.cluster ?? 'localnet');
const DEV = 'dev';

/**
 * ウォレットを選ぶ：ゲームと同じ wallet.mjs で、ブラウザにある Wallet Standard のウォレットを並べる（Phantom などの拡張）。
 * Dev Wallet（localnet だけ）は、選んで押したときに初めて有効にする（有効にすると、この画面の localStorage に鍵の種を作るため）。
 */
let walletPicked = false;
function renderWallets() {
  const list = W.list(chainOf()).filter(e => !e.dev);
  const opts = [...list.map((e, i) => `<option value="${i}"${e.why ? ' disabled' : ''}>${esc(walletWords(e.name))}${e.why ? `（${esc(e.why)}）` : ''}</option>`),
    ...(chainOf() === 'solana:localnet' ? [`<option value="${DEV}">Dev Wallet（ローカル）</option>`] : [])];
  // （2026-11-18、B13）人が選ぶ前は、あとから見つかったウォレット（ゲームの画面が渡すローカルプレイの鍵など）を Dev Wallet より先に選ぶ
  const keep = walletPicked ? $('wallet').value : null;
  $('wallet').innerHTML = opts.join('') || '<option disabled>使えるウォレットが見つからない</option>';
  if ([...$('wallet').options].some(o => o.value === keep && !o.disabled)) $('wallet').value = keep;
  else { const first = [...$('wallet').options].find(o => !o.disabled); if (first) $('wallet').value = first.value; }
}

async function connectWallet() {
  try {
    const chain = chainOf();
    let entry;
    if ($('wallet').value === DEV) {
      await W.enableDevWallet({ cluster: 'localnet', allowed: chain === 'solana:localnet' });
      entry = W.list(chain).find(e => e.dev);
    } else entry = W.list(chain).filter(e => !e.dev)[Number($('wallet').value)];
    if (!entry) return say('ウォレットを選んでください', 'warn');
    await W.connect(entry, { chain });
    const c = W.connected();
    signer = {
      address: c.address,
      signMessage: async bytes => {
        const r = await W.signMessage(bytes);
        if (!equal(r.signedMessage, bytes)) throw new Error('ウォレットが別の文に署名した');
        return r.signature;
      },
    };
    $('who').textContent = `署名する人：${short(c.address)}（${walletWords(c.name)}）`;
    say('');
    await refresh();
  } catch (e) { say(`接続できない：${e.message ?? e}`, 'bad'); }
}

/** 記録に署名して板へ出す。 */
async function post(rec, done) {
  if (!signer) return say('先に署名する人を接続してください', 'warn');
  // （2026-11-17）三つを分ける：署名できなかった／板に届いたか分からない／受け付けられたあとの読み直しの失敗。
  // 受け付けられたあとに読み直せなくても「署名できない」「送られていない」とは言わない（読み直しは refresh が状態を言う）。
  let signed;
  try { signed = await signRecord(signer, { v: 1, season: cfg.season, at: Math.floor(Date.now() / 1000), ...rec }); }
  catch (e) { return say(`署名できない：${e.message ?? e}`, 'bad'); }
  // （2026-11-17）板の答え（board.mjs /coop/records）：受け付け＝200 で {ok: true}、断り＝400 で {ok: false, why}。この二つと
  // はっきり分かるもの以外（ほかの状態・空・形の違う答え・届かない）は「届いたか分からない」：未送信とも断りとも言わない。
  let status, body = null;
  try {
    const res = await fetch(at('/coop/records'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
    status = res.status;
    try { body = await res.json(); } catch { body = null; }
  } catch (e) { await refresh(); return say(`板に届いたか分からない（${e.message ?? e}）。読み直した表示で確かめてください`, 'warn'); }
  if (status === 200 && body?.ok === true) { say(done, 'ok'); await refresh(); return; }
  if (status === 400 && body?.ok === false && typeof body.why === 'string') return say(`受け付けられなかった：${body.why}`, 'bad');
  await refresh();
  return say(`板に届いたか分からない（HTTP ${status}）。読み直した表示で確かめてください`, 'warn');
}

const myNation = () => Number($('nation').value);

function renderJoint() {
  const rows = view.joint;
  $('joint').querySelector('.body').innerHTML = `
    <div class="note">${esc(cfg.goals[goalId].what)}。費用：${esc(needText(cfg.goals[goalId].cost))}。ほかの人から：${esc(needText(cfg.goals[goalId].fromOthers))}［仮］。報酬はない。</div>
    ${rows.length ? rows.map(j => `
      <div class="req" data-host="${esc(j.host)}" data-goal="${esc(j.goalId)}">
        <div><b>${esc(short(j.host))}</b>（${j.hostNation === null ? `<span class="warn">国籍未検証</span>` : esc(nationName(j.hostNation))}）の貯蔵庫：
          <span class="tag ${j.done ? 'ok' : 'warn'}" data-testid="joint-status">${j.done ? '達成（記録だけ）' : 'まだ達成と言えない'}</span></div>
        <div>${j.progress.map(p => `${esc(RESOURCE_JA[p.resource])} <b data-testid="joint-${p.resource}">${p.verified}</b>／${p.need}`).join('　')}（数えた入荷量の下限。資源ごと。合計しない）</div>
        <div class="note" data-testid="joint-precision">${esc(jointPrecisionText(j.progress, RESOURCE_JA))}</div>
        <div class="note" data-testid="joint-why">${esc(j.judgeLabel)}：${esc(j.why)}</div>
        ${jointRequestsHtml(j)}
        <div class="note">確かめた他国：${j.otherNations.length ? j.otherNations.map(nationName).join('・') : 'なし'}${j.nationsUnverified.length ? `（<span class="warn" data-testid="nation-unverified">${esc(j.nationsUnverified.join('、'))}</span>）` : ''}。輸送中・不明の隊商 ${j.unverifiedCaravans} 本、到着したが数えられない隊商（入った量を確認できない・受取人や時刻が未検証）${j.unprovenDeliveries} 本（どちらも数えない。0 個とは言わない）</div>
      </div>`).join('') : '<div class="note">まだ依頼はない</div>'}`;
}

/**
 * （2026-11-17、往復）自分・依頼・協力の進捗を、板の view の既存の鍵（依頼の id、goalId と依頼した人、依頼の世界 ctx）だけで結ぶ
 * （crosslinks.mjs）。読むだけ：押すと、この画面の中のその場所へ動くだけ（送る・結び付ける・記録を出すことはしない）。
 * 一つに決まらないもの・前の世界が混ざるものは結ばず、理由を言う。
 */
const navBtn = (kind, attrs, text, testid) => `<button type="button" class="nav" data-nav="${kind}"${attrs} data-testid="${testid}">${esc(text)}</button>`;
function jointRequestsHtml(j) {
  const r = requestsOfJoint(view, j, cfg.season);
  if (r.state !== 'ok') return `<div class="note" data-testid="joint-requests" data-state="${esc(r.state)}">この進捗の依頼：${esc(r.why)}</div>`;
  return `<div class="row" data-testid="joint-requests" data-state="ok"><span class="note">この進捗の依頼 ${r.ids.length} 件：</span>${r.ids.map((id, i) => navBtn('req', ` data-target="${esc(id)}"`, `依頼 ${i + 1}（${short(id)}）の記録へ`, 'nav-req')).join('')}</div>`;
}
function personalLinksHtml() {
  const l = personalLinks(view);
  if (!l) return '';
  const item = (x, text) => (x.found ? navBtn('req', ` data-target="${esc(x.id)}"`, text, 'nav-req') : `<span class="note">${esc(text)}：いまの表示にない</span>`);
  const st = x => REQ_JA[x.state] ?? (x.state ?? '?');
  return `<div class="row" data-testid="my-request-links"><span class="note">自分の依頼：</span>${l.requests.length ? l.requests.map(x => item(x, `${short(x.id)}（${st(x)}）`)).join('') : '<span class="note">ない</span>'}</div>
    <div class="row" data-testid="my-response-links"><span class="note">自分の応答：</span>${l.responses.length ? l.responses.map(x => item(x, `${short(x.id)}（${st(x)}・${x.answer === 'accept' ? (x.withdrawn ? '取り下げた' : '送るつもり') : x.answer === 'decline' ? '断った' : '?'}）`)).join('') : '<span class="note">ない</span>'}</div>`;
}
function requestLinksHtml(q, mine, resp) {
  const j = jointOfRequest(view, q, cfg.season);
  const toJoint = j.state === 'one' ? navBtn('joint', ` data-goal="${esc(j.goalId)}" data-host="${esc(j.host)}"`, `協力の進捗（${short(j.host)} の貯蔵庫）へ`, 'nav-joint')
    : `<span class="note" data-testid="req-joint" data-state="${esc(j.state)}">協力の進捗とは結ばない：${esc(j.why)}</span>`;
  const toMe = mine || resp ? navBtn('personal', '', '自分の欄へ', 'nav-personal') : '';
  return `<div class="row" data-testid="req-links">${toJoint}${toMe}</div>`;
}
/** 画面の中で動くだけ（送る・記録を出す・読み直すことはしない）。探す相手は属性を比べて見つける（文字を選択子に入れない）。 */
function onNav(e) {
  const b = e.target.closest?.('button[data-nav]');
  if (!b) return;
  let el = null;
  if (b.dataset.nav === 'req') {
    el = [...document.querySelectorAll('#requests .req')].find(x => x.dataset.req === b.dataset.target) ?? null;
    if (el) { historyOpen.add(b.dataset.target); el.querySelector('details.req-history')?.setAttribute('open', ''); }
  } else if (b.dataset.nav === 'joint') el = [...document.querySelectorAll('#joint .req')].find(x => x.dataset.goal === b.dataset.goal && x.dataset.host === b.dataset.host) ?? null;
  else if (b.dataset.nav === 'personal') el = document.getElementById('personal');
  if (!el) return say('その場所は、いまの表示にない。読み直した表示で確かめてください', 'warn');
  el.scrollIntoView?.({ block: 'center' });
}
for (const id of ['joint', 'personal', 'requests']) $(id).addEventListener('click', onNav);

// (fix-loop9, LP9-8: the self-declared nation follows the chain's Citizen once it is known — unless the person chose
//  one: it is still only a declaration, never used to judge — so a request no longer says 「国1」 by default)
let nationChosen = false;
function renderNation() {
  const n = view.nation;
  if (n && Number.isInteger(n.nation) && !nationChosen && $('nation').value !== String(n.nation)) $('nation').value = String(n.nation);
  $('nationPanel').querySelector('.body').innerHTML = !n ? '<div class="note">署名する人を接続すると出る</div>'
    : n.nation === null ? `<div class="warn" data-testid="my-nation">国籍未検証：${esc(n.why)}</div><div class="note">${esc(n.note)}</div>`
    : `<div data-testid="my-nation">${esc(nationName(n.nation))}（チェーンの Citizen で確かめた）：依頼 ${n.requests} 件、この国の人が届けた証明できる到着 ${n.deliveredFromNation} 本</div>
    <div class="note">${esc(n.note)}。国は持ち主の物を動かせない。</div>`;
}

function renderPersonal() {
  const p = view.personal;
  $('personal').querySelector('.body').innerHTML = p ? `
    <div>自分の依頼 ${p.myRequests.length} 件・自分の応答 ${p.myResponses.length} 件</div>
    ${personalLinksHtml()}
    <div>自分が届けた確定の到着の量（数えた入荷量の下限。資源ごと）：<b data-testid="my-verified">${esc(lowerBoundText(p.myVerified, RESOURCE_JA))}</b></div>
    ${p.left.length ? '<div class="warn">この目的から抜けている（送った隊商はそのまま届く）</div>' : ''}
    <div class="note">協力しないで自分で進めてもよい。自分の物で建てれば、依頼は「自分で進める」で取り消せる。</div>` : '<div class="note">署名する人を接続すると出る</div>';
}

/** 自分の隊商のうち、この依頼の届け先へ向かうもの（ヘラルドの一覧から）。 */
/**
 * 自分の、この届け先へ向かう隊商（ヘラルドの一覧から）。（2026-11-17）一覧を読めていない・形が違うときは null（分からない）：
 * 「見えない」（空の一覧）と分ける。
 */
function myCaravansTo(q) {
  if (!signer) return [];
  if (feed?.state !== 'ok') return null;
  const tag = ownerTagOf(cfg.season, signer.address);
  return (feed.data.moving ?? []).filter(m => String(m.ownerTag) === tag && !m.raided && m.dst?.kind === 1 && m.dst.p === q.to.p && m.dst.q === q.to.q && m.dst.at === q.to.site && m.dst.gen === q.to.gen);
}

function renderRequests() {
  const me = signer?.address;
  const list = view.requests;
  $('requests').querySelector('.body').innerHTML = list.length ? list.map(q => {
    const mine = q.requester === me;
    const resp = me ? q.responses[me] : null;
    const accepted = resp && resp.answer === 'accept' && !resp.withdrawn;
    const open = q.stateNow === 'open';
    const others = Object.entries(q.responses).map(([w, x]) => `${short(w)}（${nationName(x.nation)}）：${x.answer === 'accept' ? (x.withdrawn ? '取り下げ' : `送るつもり ${needText(x.offer)}`) : '断った'}`).join(' / ');
    // 届け先が、いま依頼した人の村（同じ世代）と確かめられないなら、送る・結び付けるを出さない（送っても数えられない）
    const badDst = ['mismatch', 'unknown'].includes(q.destination?.status);
    const cands = accepted && open && !badDst ? myCaravansTo(q) : [];
    return `<div class="req" data-req="${esc(q.id)}">
      <div><b>${esc(needText(q.need))}</b> → ${esc(short(q.requester))}（${esc(nationName(q.nation))}・申告。判定には使わない）の村 (${q.to.p},${q.to.q}) 村${q.to.site}
        <span class="tag" data-testid="req-state">${esc(REQ_JA[q.stateNow] ?? q.stateNow)}${q.cancel ? `：${esc(CANCEL_JA[q.cancel.reason] ?? q.cancel.reason)}` : ''}</span></div>
      <div class="note">応答：${esc(others || 'まだない')}</div>
      ${open && q.destination?.status === 'mismatch' ? `<div class="warn" data-testid="req-destination" data-status="mismatch">届け先が、いま依頼した人の村ではない：${esc(q.destination.why)}。この依頼に送っても、届いた量は数えられない（送る・結び付けるは出さない）</div>` : ''}
      ${open && q.destination?.status === 'unknown' ? `<div class="warn" data-testid="req-destination" data-status="unknown">届け先の村を今は確かめられない：${esc(q.destination.why)}。確かめられるまで、送る・結び付けるは出さない（読み直すと、また確かめる）</div>` : ''}
      <div class="note" data-testid="req-fulfilment" data-status="${esc(q.fulfilment?.status ?? '')}">依頼の充足：${esc(FULFILMENT_JA[q.fulfilment?.status] ?? '—')}${q.fulfilment && q.fulfilment.status !== 'none' ? `。${esc(fulfilBoundsText(q.fulfilment, RESOURCE_JA))}${q.fulfilment.open ? `、終わっていない ${q.fulfilment.open} 本${q.fulfilment.held ? `（うち原因を確認中 ${q.fulfilment.held}）` : ''}` : ''}${q.fulfilment.unproven ? `、到着したが数えられない ${q.fulfilment.unproven} 本` : ''}${q.fulfilment.knownZero ? `、届かなかった ${q.fulfilment.knownZero} 本` : ''}` : ''}</div>
      ${requestLinksHtml(q, mine, resp)}
      <div class="row">
        ${mine && open ? `<button data-act="cancel-self" data-id="${esc(q.id)}">取り消す（自分で進める）</button><button data-act="cancel-other" data-id="${esc(q.id)}">取り消す（ほかの理由）</button>` : ''}
        ${!mine && open && !accepted ? `<button data-act="accept" data-id="${esc(q.id)}">応じる（送るつもり。義務はない）</button><button data-act="decline" data-id="${esc(q.id)}">断る</button>` : ''}
        ${!mine && accepted && open ? `<button data-act="withdraw" data-id="${esc(q.id)}">取り下げる（別の相手を選ぶ）</button>` : ''}
      </div>
      ${!mine && accepted && open && !badDst && cfg.relay && cfg.rpcProxy ? (blocking(q)
        ? (blocking(q).kind === 'landed-unlinked'
          ? `<div class="row"><button data-act="link" data-id="${esc(q.id)}" data-tag="${esc(blocking(q).sending.caravan.ownerTag)}" data-seq="${blocking(q).sending.caravan.seq}" data-testid="pending-link">着地した隊商 #${blocking(q).sending.caravan.seq} をこの依頼に結び付ける</button><span class="warn">結び付けるまで次は署名・送付しない（同じ物を二度送らない）</span></div>`
          : `<div class="row"><button data-act="send" data-id="${esc(q.id)}" data-testid="pending-send"${sendingNow.has(q.id) ? ' disabled aria-busy="true"' : ''}>前の送信（隊商 #${blocking(q).sending.caravan.seq}）の結果を確かめる</button><span class="warn">結果が分かるまで次は署名・送付しない</span>${blocking(q).sending.src ? `<span class="note" data-testid="pending-src">送り元 (${esc(blocking(q).sending.src.p)},${esc(blocking(q).sending.src.q)}) 村${esc(blocking(q).sending.src.site)}（送り元を選び直しても、この送信の確かめは続く）</span>` : ''}</div>`)
        : `${srcPickHtml(q)}<div class="row"><button data-act="send" data-id="${esc(q.id)}" data-testid="send"${sendingNow.has(q.id) ? ' disabled aria-busy="true"' : ''}>この画面から送る（${esc(needText(resp.offer))}。ウォレットで署名）</button>${sendingNow.has(q.id) ? '<span class="note" data-testid="send-busy">送る手続きの途中（ウォレットの画面を確かめてください）</span>' : ''}</div>`) : ''}
      ${!mine && accepted && open && !badDst ? `<div class="note">ゲームの村の引き出し「交易と防備」からも送れる：行き先 (${q.to.p},${q.to.q}) 村${q.to.site}、荷 ${esc(needText(resp.offer))}。他の人の村へ送る隊商は、ウォレットで署名します。</div>
        <div class="row">${cands === null ? `<span class="warn" data-testid="caravans-unknown">隊商の一覧（ヘラルド）を読めないため、この届け先へ向かう自分の隊商があるかは分からない（${esc(feed?.why ?? '?')}）。読み直しを続けます</span>` : cands.length ? cands.map(m => `<button data-act="link" data-id="${esc(q.id)}" data-tag="${esc(m.ownerTag)}" data-seq="${m.seq}">隊商 #${m.seq}（${esc(needText(Object.fromEntries(RESOURCES.map((r, i) => [r, m.cargo[i]]).filter(([, v]) => v > 0))))}）をこの依頼に結び付ける</button>`).join('') : '<span class="note">この届け先へ向かう自分の隊商はまだ見えない</span>'}</div>${arrivedHtml(q)}` : ''}
      ${historyHtml(q, me)}
    </div>`;
  }).join('') : '<div class="note">依頼はまだない</div>';
}

/**
 * （2026-11-17、依頼の記録）この依頼について板が持っている記録を、状態にかかわらず（受付中・取り消し・期限切れ、応答の取り下げ後も）
 * 読むだけで並べる：送信（sending の記録と、板が表示の度に確かめる結果 outcome）、結び付け（links）、到着（arrivals）、算入（counted）。
 * 板の記録は追記で保存されるので、読み込み直し・板の再起動の後も同じものが出る。ここからは何も送らない・結び付けない・確かめ直さない
 * （followSend は結び付けの記録を出すので、ここでは呼ばない）。分からないものは分からないと言い、送っていない・成功・0 にしない。
 */
const historyOpen = new Set();   // 開いている「この依頼の記録」（依頼の ID）。読み直しで閉じない
function historyHtml(q, me) {
  const { sendings, arrivals } = requestHistory(q, me);
  const sendRows = sendings === null ? '<li class="warn">送信の記録が読めない（ないとは言わない）</li>'
    : !sendings.length ? '<li class="note">この依頼への送信の記録はまだない（ゲームの画面から送った隊商は、結び付けた分だけ下の到着に出る）</li>'
    : sendings.map(z => `<li data-testid="history-sending" data-status="${esc(z.status)}">${z.mine ? '<b>自分</b>' : esc(short(z.responder))}の隊商 #${esc(z.seq ?? '?')}${z.src ? `（送り元 (${esc(z.src.p)},${esc(z.src.q)}) 村${esc(z.src.site)}）` : ''}：${z.cargo ? esc(needText(z.cargo)) : '荷は記録にない'}。<span class="${z.status === 'landed' ? 'ok' : z.status === 'unknown' || !z.known ? 'warn' : 'bad'}">${esc(z.known ? OUTCOME_JA[z.status] : `分からない（${z.status}）`)}</span>${z.link === 'linked' ? '・この依頼に結び付けた' : z.link === 'unlinked' ? '・まだこの依頼に結び付けていない（結び付けるまで数えない）' : ''}${z.why ? `<span class="note">（${esc(z.why)}）</span>` : ''}</li>`).join('');
  const arrRows = arrivals === null ? '<li class="warn">到着の記録が読めない（ないとは言わない）</li>'
    : !arrivals.length ? '<li class="note">この依頼に結び付けた隊商の到着はまだない（数えた量はない。届かなかったとは言わない）</li>'
    : arrivals.map(x => `<li data-testid="history-arrival" data-state="${esc(x.state)}">${esc(short(x.ownerTag))}#${esc(x.seq ?? '?')}：${esc(STATE_JA[x.state] ?? x.state)}・${esc(deliveredText(x.raw, RESOURCE_JA, x.raw.shipped).text)}・${x.counted
      ? `<span class="ok">数えた量 ${esc(needText(x.counted))}（下限）</span>` : `<span class="note">数えていない（${esc(x.why ?? '理由は記録にない')}${x.final === false ? '。まだ決まっていない' : ''}）</span>`}</li>`).join('');
  const n = sendings?.length ?? '?', m = arrivals?.length ?? '?';
  return `<details class="req-history" data-testid="req-history" data-req="${esc(q.id)}"${historyOpen.has(q.id) ? ' open' : ''}>
        <summary>この依頼の記録（送信 ${n}・到着 ${m}）</summary>
        <div class="note">板に保存された記録（読み込み直し・板の再起動の後も同じ）。読むだけ：ここからは送らない・結び付けない</div>
        <div>送信</div><ul>${sendRows}</ul>
        <div>到着と算入</div><ul>${arrRows}</ul>
      </details>`;
}
document.addEventListener('toggle', e => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('req-history')) return;
  if (d.open) historyOpen.add(d.dataset.req); else historyOpen.delete(d.dataset.req);
}, true);

/**
 * （2026-11-18、口座の閉じた隊商の結び付け）ゲームの「隊商を送る」から送った自分の隊商が、結び付ける前に口座が閉じて輸送中の一覧から
 * 消えたとき、結び付けの候補をチェーンから探す（arrived.mjs。読むだけ）。「着いた」と言うのは確定の記録が届け先で成功したときだけ。押したときだけ読む（4 秒ごとの読み直しでは読まない）。
 * 候補は既存の「結び付ける」（link の記録）で出し、確かめるのは板（元の送信・応答との前後・届け先・積荷）。
 * 鍵は 送る人｜プログラム｜シーズン｜依頼。読み直した表示で結び付いた・送信の記録がある隊商は、出すときにもう一度除く。
 */
// 状態の持ち方は arrived.mjs createArrivedPicks（答えは始めた鍵にだけ当てる。同じ鍵の新しい読みが古い答えを捨てる）
const arrivedPicks = createArrivedPicks({ scan: a => arrivedCandidates(rpcReader(at('/coop/rpc')), a.season, a.wallet, a.request, a.opts), changed: () => { if (view) renderRequests(); } });
const arrivedPickKey = q => (signer && cfg ? [signer.address, cfg.season.programId, cfg.season.seasonId, q.id].join('|') : null);
// 行の描き方は arrived.mjs renderArrived（試験と同じ関数）。着いたと言うのは delivered だけ・量は言わない
const arrivedHtml = q => renderArrived({ ready: !!(signer && cfg?.chain && cfg?.rpcProxy), pick: arrivedPicks.get(arrivedPickKey(q)), request: q, ctx: q.ctx ?? cfg.season, view, ctxKey, names: RESOURCE_JA });
function loadArrived(q) {
  const p = arrivedPicks.press(arrivedPickKey(q), { season: cfg.season, wallet: signer?.address, request: q, opts: { resources: RESOURCES, ctxKey, exclude: excludedCaravans(view) } });
  if (!p.started) return say(p.why === 'loading' ? 'この依頼の隊商を探している途中' : '先に署名する人を接続してください', 'warn');   // 連打：同じ鍵の読みを重ねない
  return p.done;
}

function renderArrivals() {
  const a = view.arrivals;
  // （2026-11-18）ヘラルドに確定の記録（ended）が無いことと、各行の確かめは別：チェーンを読む板（view.chain）は行ごとにチェーンの取引の
  // 記録で確かめる（arrival.mjs arrivalOf）。どの行が確かめられたかは、その行の状態と数えた量だけが言う（ここでは量・成功を言わない）
  const feedNote = view.heraldFeed ? (view.heraldFeed.ended === null ? (view.chain
    ? '<div class="note" data-testid="feed-note" data-state="chain">このヘラルドは確定の記録（ended）を出していない。到着は行ごとにチェーンの取引の記録で確かめる（確かめられたかは各行の状態と数えた量を見る）</div>'
    : '<div class="warn" data-testid="feed-note" data-state="none">このヘラルドは確定の記録（ended）を出さず、板もチェーンを読まない（--rpc なし）。到着は未検証のまま</div>') : '') : '<div class="bad">ヘラルドの隊商の一覧が読めない</div>';
  $('arrivals').querySelector('.body').innerHTML = `${feedNote}
    <table><thead><tr><th>依頼</th><th>隊商</th><th>状態</th><th>到着量（④の分類）</th><th>④の終わり（隊商ごと）</th><th>記録の cargo（上限）</th><th>到着時の受取人</th><th>今の持ち主</th><th>数えた量</th></tr></thead><tbody>
    ${a.map(x => `<tr data-testid="arrival"><td><code>${esc(x.requestId.slice(0, 8))}</code></td><td>${esc(x.caravanId.ownerTag.slice(0, 6))}…#${x.caravanId.seq}</td>
      <td data-testid="arrival-state">${esc(STATE_JA[x.state] ?? x.state)}</td>
      <td data-testid="arrival-qty" data-kind="${esc(deliveredText(x, RESOURCE_JA, x.shipped).kind)}">${esc(deliveredText(x, RESOURCE_JA, x.shipped).text)}${x.verification ? `<span class="note">（${esc(VERIFICATION_JA[x.verification] ?? x.verification)}）</span>` : ''}</td>
      <td data-testid="arrival-terminal">${x.terminal ? esc(x.terminal) : '—'}${x.terminal === 'Delivered' ? '<span class="note">（送った荷が分からないので Fulfilled／Partial を決めない）</span>' : ''}</td>
      <td>${x.cargoLogged ? esc(needText(x.cargoLogged)) : '—'}</td>
      <td data-testid="arrival-recipient">${!x.recipient ? '—' : x.recipient.status === 'verified' ? (x.recipient.isRequester ? '依頼した人（世代 ' + x.recipient.gen + '）' : '<span class="warn">依頼した人ではない</span>') : `<span class="warn">未検証：${esc(x.recipient.why)}</span>`}</td>
      <td>${x.currentOwner ? `世代 ${x.currentOwner.gen}・${esc(String(x.currentOwner.ownerCitizen).slice(0, 4))}…` : '—'}</td>
      <td data-testid="arrival-counted">${x.counted ? esc(needText(x.counted)) : `<span class="note">算入 0（${esc(x.notCountedWhy ?? '')}）</span>`}</td></tr>`).join('') || '<tr><td colspan="9" class="note">結び付けた隊商はまだない</td></tr>'}
    </tbody></table>
    <div class="note">到着量の分類は④の契約に合わせた。村あては規則から（RuleDerived：記録の cargo を整数単位の入荷量とする）、倉あては credited が記録にないので分からない（Unverifiable）、届かなかったものは 0 と分かっている（KnownZero）。記録の cargo は上限で、数えない。量を確認できない到着は「0 個」「失敗」ではなく、数えた量（算入量）が 0 なだけ。村あての量は下限（資源ごとに 1 未満多く入っていうる）。④の終わりは隊商ごとに送った荷と下限を比べ（以上 Fulfilled・未満 Partial）、0 と分かるのは焼却・奪取・LOST の証拠があるときだけ（Failed）。別の場所に着いたものは原因を確認中で、奪われたとは言わない。依頼の充足は、下限が依頼量以上なら届いた、すべて終わって上限が依頼量以下なら届かなかった、その間は判定できない。到着時の受取人は、村の世代が到着の記録と同じときだけ今の口座から決まる（世代が変わったら未検証）。</div>`;
}

// （2026-11-17）読み直しは 4 秒ごとと自分の操作のあとに重なりうる。古い答え（先に始めた読み）や、答えが来る前にウォレットが
// 変わった読みの答えは、新しい表示を上書きしない。最後に当てたものより新しい読みだけを当てる（遅いサーバーでも、来た新しい答えは当たる）。
let refreshSeq = 0, appliedSeq = 0;
// （2026-11-17）表示しているものが誰のどの読みか：shownFor（閲覧者）・shownAt（当てた時刻）。操作はこの表示と同じものにだけ行う。
let shownFor = undefined, shownAt = null;
const RENDER_TARGETS = ['joint', 'nationPanel', 'personal', 'requests', 'arrivals'];
/**
 * 読み直す。投げない（失敗は読み込みの状態の一行で言う）。true：新しい表示を当てた。
 * （2026-11-17）当てるのは、新しい読み・同じ閲覧者・形の正しい view で、五つの描画がすべて成り立ったときだけ。途中で描画が
 * 失敗したら、view・feed・五つの欄を元に戻す（古い DOM と新しい view が混ざらない）。前の表示を残すときは、古いことを言う。
 */
async function refresh() {
  const seq = ++refreshSeq, viewerAt = signer?.address ?? null;
  const v = new URLSearchParams({ judge: $('judge').value || cfg.judge, ...(signer ? { viewer: signer.address } : {}) });
  let v2, f2;
  try {
    // （2026-11-17）ヘラルドの隊商の一覧は、読めたかどうかを持つ：{state: 'ok', data} | {state: 'unread', why}（view と同じ snapshot で当てる）
    const feedRead = fetch(at('/h/caravans.json')).then(async r => {
      if (!r.ok) return { state: 'unread', why: `HTTP ${r.status}` };
      let j;
      try { j = await r.json(); } catch { return { state: 'unread', why: 'JSON でない' }; }
      // （第3版）ヘラルドの一覧は moving を必ず配列で書く（frontier-node/crates/herald/src/caravan.rs file()、from_file も必須）：
      // 無い・配列でないなら読めていない（空の一覧として扱わない）
      return j && typeof j === 'object' && Array.isArray(j.moving) ? { state: 'ok', data: j } : { state: 'unread', why: '形が違う' };
    }).catch(e => ({ state: 'unread', why: `届かない（${e.message ?? e}）` }));
    [v2, f2] = await Promise.all([apiRead(`/coop/view?${v}`), feedRead]);
  } catch (e) { if (seq > appliedSeq) staleSay(`読み込めない：${e.message ?? e}`); return false; }
  if (seq <= appliedSeq || (signer?.address ?? null) !== viewerAt) return false;
  if (!viewShapeOk(v2)) { staleSay('板の答えの形が違う'); return false; }
  const before = RENDER_TARGETS.map(id => $(id).querySelector('.body').innerHTML);
  const [pv, pf] = [view, feed];
  try {
    [view, feed] = [v2, f2];
    renderJoint(); renderNation(); renderPersonal(); renderRequests(); renderArrivals();
  } catch (e) {
    [view, feed] = [pv, pf];
    RENDER_TARGETS.forEach((id, i) => { $(id).querySelector('.body').innerHTML = before[i]; });
    staleSay(`表示できない：${e.message ?? e}`);
    return false;
  }
  appliedSeq = seq; shownFor = viewerAt; shownAt = new Date();
  readState('');
  try { applyFocus(); } catch (e) { focusSay(`入口で選んだ依頼を示せませんでした（${e.message ?? e}）。一覧から選び直してください`); }
  return true;
}
/** 最新の読みが当たらなかった：前の表示が残っていれば、それが古いことを言う。 */
/**
 * （2026-11-17、一つの依頼）入口が名指しした依頼：{id, to, seen}。入口の村の世界がこの板の世界と同じときだけ持つ。
 * 当てた表示ごとに確かめる：その依頼が表示にあり、この板の世界の依頼で、入口の村あてのときだけ目印を付ける（最初の一回だけ
 * そこへ動かす）。無い・消えた・別の村や世界なら理由を言い、一覧から選び直してもらう。応じる・署名・準備・送信はしない。
 */
let focus = null;
function focusSay(text) {
  let p = document.getElementById('focusState');
  if (!p) { p = document.createElement('p'); p.id = 'focusState'; p.className = 'warn'; p.dataset.testid = 'focus-state'; $('msg').after(p); }
  p.textContent = text ?? ''; p.hidden = !text;
}
function applyFocus() {
  if (!focus || !view) return;
  const q = view.requests.find(x => x.id === focus.id);
  if (!q) return focusSay(focus.seen ? '入口で選んだ依頼は、いまの表示にありません（記録が変わったか、別の世界の依頼です）。一覧から選び直してください'
    : '入口で選んだ依頼は、この板にありません（消えたか、別の世界の依頼です）。一覧から選び直してください');
  const ctxOk = sameCtx(q.ctx, cfg.season);   // （2026-11-18）世界が読めない依頼・板は同じと言わない（crosslinks.mjs と同じ比べ方）
  const toOk = q.to && [q.to.p, q.to.q, q.to.site, q.to.gen].join(',') === focus.to;
  if (!ctxOk || !toOk) return focusSay('入口で選んだ依頼は、入口の村あての、この板の世界の依頼ではありません。一覧から選び直してください');
  const el = [...document.querySelectorAll('#requests .req')].find(e => e.dataset.req === q.id);
  if (!el) return focusSay('入口で選んだ依頼を表示できませんでした。一覧から選び直してください');
  el.classList.add('focus');
  if (!focus.seen) { historyOpen.add(q.id); el.querySelector('details.req-history')?.setAttribute('open', ''); }   // 入口から開いた依頼は、その記録も開く（最初の一回）
  if (!focus.seen) el.scrollIntoView?.({ block: 'center' });
  focus.seen = true;
  focusSay('');
}

function staleSay(why) {
  readState(view ? `${why}。表示は ${shownAt ? shownAt.toLocaleTimeString() : '前'} の読み込みのまま（古い）。自動で読み直しを続けます` : `${why}。まだ表示できるものがありません。自動で読み直しを続けます`);
}

document.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  // （2026-11-17）表示しているものと同じ読みにだけ操作する：まだ何も表示していない、または別の閲覧者の表示のままなら何もしない
  if (!view || shownFor !== (signer?.address ?? null)) return say('表示を読み直しています。表示が新しくなってから、もう一度押してください', 'warn');
  const q = view.requests.find(x => x.id === id);
  if (!q && b.dataset.act !== undefined) return say('この依頼は、いまの表示にありません。読み直した表示で確かめてください', 'warn');
  switch (b.dataset.act) {
    case 'accept': {
      const offer = Object.fromEntries(Object.entries(q.need));
      return post({ kind: 'respond', request: id, answer: 'accept', offer, nation: myNation() }, '応じた（送るつもり）。物はまだ動いていない');
    }
    case 'decline': return post({ kind: 'respond', request: id, answer: 'decline', nation: myNation() }, '断った');
    case 'withdraw': return post({ kind: 'withdraw', request: id }, '取り下げた。送った隊商があれば、それはそのまま届く');
    case 'cancel-self': return post({ kind: 'cancel', request: id, reason: 'self' }, '取り消した（自分で進める）');
    case 'cancel-other': return post({ kind: 'cancel', request: id, reason: 'other' }, '取り消した');
    case 'send': return sendFor(q);
    case 'src-load': return loadSources(q);
    case 'src': return chooseSource(q, b.dataset.src || null);
    case 'src-preview': return previewSource(q);
    // 探す・結び付けるの分け方は arrived.mjs arrivedClick（試験と同じ関数。link の形はこれまでと同じ）
    case 'arrived-load':
    case 'link': {
      const r = arrivedClick(b.dataset);
      return r.act === 'arrived-load' ? loadArrived(q) : post({ kind: 'link', request: id, caravan: r.caravan }, '隊商を結び付けた。数えるのは確定した到着だけ');
    }
  }
});

/**
 * この画面から送る：ゲームと同じコード（send.mjs → fplay.submit）で SendCaravan を組み立て、接続したウォレットで署名して中継へ送る。
 * チェーンに隊商の口座が見えたら、結び付けの記録に署名して板へ出す。
 */
/** この依頼への自分の送信のうち、次の送付を止めるもの（結果が分からない・着地したのに結び付けていない。板の sending の記録から。再読込・板の再起動の後も残る）。 */
const blocking = q => (signer ? pendingSendOf(q, signer.address, z => z.outcome) : null);

/**
 * 送る手続きの途中の依頼（依頼の ID）。同じ依頼の「送る」をもう一度押しても、計画・確認・ウォレットへの署名の求めを二重に始めない。
 * 手続きが終われば（送った・断られた・取り消した・失敗した・結果を追い終えた）、finally で外してボタンを戻す。
 */
const sendingNow = new Set();

async function sendFor(q) {
  if (sendingNow.has(q.id)) return say('この依頼の送る手続きが進んでいる。終わるまで待ってください（ウォレットの画面を確かめてください）', 'warn');
  sendingNow.add(q.id);
  renderRequests();
  try {
    return await sendOnce(q);
  } finally {
    sendingNow.delete(q.id);
    renderRequests();
  }
}

/**
 * （2026-11-17、同じ入口）この入口のゲーム（板が転送するヘラルドの /h/season）と板の世界が同じか。
 * 別の世界なら、この画面から隊商は送らない（見込みも出さない）。分からないときは「分からない」と言い、これまでどおり止めない。
 * 前の送信の結果を確かめる（followSend）・記録を出す（post）は止めない（板の世界の記録で、ヘラルドへは送らない）。
 */
let composed = { state: 'unknown', why: 'まだ読んでいない' };
function composeSay() {
  let p = document.getElementById('composeState');
  if (!p) { p = document.createElement('p'); p.id = 'composeState'; p.dataset.testid = 'compose-state'; $('msg').after(p); }
  p.className = composed.state === 'same' ? 'note' : composed.state === 'different' ? 'bad' : 'warn';
  p.dataset.state = composed.state;
  p.textContent = compositionText(composed, cfg);
  if (composed.state === 'same') {   // 同じ入口のゲームへ（固定の道。ほかの入口へは出さない）
    const a = document.createElement('a');
    a.href = GAME_PAGE; a.textContent = 'ゲームを開く'; a.dataset.testid = 'game-link';
    p.append(' ', a);
  }
}
async function readComposition() {
  let next;
  try { next = compositionOf(await apiRead('/h/season'), cfg); } catch (e) { next = { state: 'unknown', why: `この入口のヘラルドを読めない（${e.message ?? e}）` }; }
  composed = next;
  try { composeSay(); } catch { /* 表示の欄が作れなくても、確かめた結果は持つ */ }
  return composed;
}

/**
 * （2026-11-17、送り元）送る人・世界・依頼ごとの送り元の選択。準備だけ：応じる・署名・送信はしない。
 * 鍵は 送る人｜プログラム｜シーズン｜依頼。送る人・世界・依頼が変われば別の鍵なので、前の読み・選択・見込みは当たらない。
 * {seq, status: 'loading'|'ok'|'unread', why, cands, chosen: placeKey|null（null は最初の村＝これまでどおり）, preview}
 * ページを読み込み直すと消える（選ばなかったのと同じ：送った記録の送り元は板の sending に残る）。
 */
const srcPicks = new Map();
let srcSeq = 0;
const srcKey = q => (signer && cfg ? [signer.address, cfg.season.programId, cfg.season.seasonId, q.id].join('|') : null);
const OWNER_JA = { mine: '持ち主は自分（読んだ時点。送るときにもう一度確かめる）', other: '今の持ち主は自分ではない（選べない）', unverified: '持ち主を確かめられない（送るときに確かめる）' };

/** 送る前の見込みの文（判定ではない）。送るときの確かめの文と、選んだ送り元の見込みの文で同じものを使う。 */
function estText(plan) {
  const lack = Object.entries(plan.estimate.shortfall);
  return `送り元の在庫（見込み）：${needText(plan.estimate.have)}${lack.length ? `。不足（見込み）：${needText(Object.fromEntries(lack))}` : '。不足なし（見込み）'}。足りるかの最終判定は、送信の時にプログラムが行う`;
}

function srcPickHtml(q) {
  const key = srcKey(q), pick = key ? srcPicks.get(key) : null, busy = sendingNow.has(q.id) ? ' disabled' : '', id = esc(q.id);
  if (!pick) return `<div class="row" data-testid="src-pick"><button data-act="src-load" data-id="${id}" data-testid="src-load"${busy}>送り元の村を選ぶ</button><span class="note">選ばなければ、これまでどおり Citizen の最初の村から送る</span></div>`;
  const on = k => (pick.chosen === k ? ' aria-pressed="true"' : ' aria-pressed="false"');
  const mark = k => (pick.chosen === k ? '（選択中）' : '');
  const state = pick.status === 'loading' ? '<span class="note" data-testid="src-state" data-status="loading">送り元の村の候補を読んでいる…</span>'
    : pick.status === 'unread' ? `<span class="warn" data-testid="src-state" data-status="unread">送り元の村の候補を読めない（${esc(pick.why ?? '?')}）。村がないとは限らない。読み直してください</span>`
    : !pick.cands.length ? '<span class="note" data-testid="src-state" data-status="none">Citizen に載っている村がない（読んだ時点）</span>' : '';
  const cands = pick.status === 'ok' ? pick.cands.map(c => `<button data-act="src" data-id="${id}" data-src="${esc(placeKey(c))}" data-owner="${esc(c.owner)}" data-testid="src-cand"${on(placeKey(c))}${c.owner === 'other' || busy ? ' disabled' : ''}>(${esc(c.p)},${esc(c.q)}) 村${esc(c.site)}${c.gen === null ? '' : `・世代 ${esc(c.gen)}`}：${esc(OWNER_JA[c.owner])}${c.why ? `（${esc(c.why)}）` : ''}${mark(placeKey(c))}</button>`).join('') : '';
  const lost = pick.status === 'ok' && pick.chosen !== null && !pick.cands.some(c => placeKey(c) === pick.chosen)
    ? `<span class="warn" data-testid="src-lost">選んでいた村 (${esc(pick.chosen)}) は、読み直した候補にない。選び直してください（最初の村に替えては送らない）</span>` : '';
  // 見込みは、同じ選択で、同じ依頼の中身（planBasisOf）のときだけ出す（読み直しで依頼・答えが変わったら古い見込みを出さない）
  const pv = pick.preview && pick.preview.chosen === pick.chosen && pick.preview.basis === planBasisOf(q, signer?.address) ? pick.preview : null;
  return `<div class="src-pick" data-testid="src-pick">
    <div class="row"><span>送り元の村：</span><button data-act="src" data-id="${id}" data-src="" data-testid="src-first"${on(null)}${busy}>Citizen の最初の村（これまでどおり）${mark(null)}</button>${cands}</div>
    <div class="row">${state}${lost}<button data-act="src-load" data-id="${id}" data-testid="src-load"${busy}>候補を読み直す</button><button data-act="src-preview" data-id="${id}" data-testid="src-preview"${busy || pick.status === 'loading' ? ' disabled' : ''}>この送り元で見込みを出す（署名しない）</button></div>
    ${pv ? `<div class="${pv.status === 'ok' ? 'note' : pv.status === 'loading' ? 'note' : 'warn'}" data-testid="src-estimate" data-status="${esc(pv.status)}">${esc(pv.text)}</div>` : ''}
  </div>`;
}

/** 候補を読む（読むだけ）。読んでいる間に読み直したら、古い読みは当てない。読めなければ「読めない」（空にしない）。選んでいた村は残す。 */
async function loadSources(q) {
  const key = srcKey(q);
  if (!W.connected() || !key) return say('先に署名する人を接続してください', 'warn');
  if (sendingNow.has(q.id)) return say('送る手続きの途中は、送り元を読み直さない', 'warn');
  const prev = srcPicks.get(key);
  const pick = { seq: ++srcSeq, status: 'loading', why: null, cands: null, chosen: prev ? prev.chosen : null, preview: null };
  srcPicks.set(key, pick);
  renderRequests();
  const r = await sourceCandidates(rpcReader(at('/coop/rpc')), cfg.season, signer.address);
  if (srcPicks.get(key) !== pick) return;
  Object.assign(pick, r.status === 'ok' ? { status: 'ok', why: null, cands: r.cands } : { status: 'unread', why: r.why, cands: null });
  renderRequests();
}

/** 送り元を選ぶ（準備だけ）。前の見込みは消す（別の村の見込みを当てない）。結果の分からない前の送信は、これで解かない（blocking は板の記録から）。 */
function chooseSource(q, chosen) {
  const key = srcKey(q), pick = key ? srcPicks.get(key) : null;
  if (!pick) return say('先に送り元の村の候補を読んでください', 'warn');
  if (sendingNow.has(q.id)) return say('送る手続きの途中は、送り元を変えない', 'warn');
  pick.chosen = chosen;
  pick.preview = null;
  renderRequests();
  say(chosen === null ? '送り元：Citizen の最初の村（これまでどおり）。まだ送らない' : `送り元に村 (${chosen}) を選んだ。準備だけで、まだ送らない`);
}

/** 選んだ送り元で、送る前の見込みを出す（planSend：在庫・不足・道・番号・手数料）。署名・送信はしない。読み終えたとき選択が変わっていれば当てない。 */
async function previewSource(q) {
  const c = W.connected(), key = srcKey(q), pick = key ? srcPicks.get(key) : null;
  if (!c || !pick) return say('先に署名する人を接続し、送り元の村の候補を読んでください', 'warn');
  const use = sourceToUse(pick, pick.chosen);
  if (!use.ok) return say(use.why, 'warn');
  if (composed.state === 'different') return say(compositionText(composed, cfg), 'bad');
  const resp = q.responses[signer.address];
  if (!resp?.offer) return say('この依頼に応じた量が見えない。読み直した表示で確かめてください', 'warn');
  const seq = ++srcSeq, chosenAt = pick.chosen, basis = planBasisOf(q, signer.address);
  pick.previewSeq = seq;
  pick.preview = { chosen: chosenAt, basis, status: 'loading', text: '見込みをチェーンから読んでいる…' };
  renderRequests();
  let plan;
  try { plan = await planSend({ reader: rpcReader(at('/coop/rpc')), season: cfg.season, wallet: c.address, request: q, cargo: resp.offer, source: use.source }); }
  catch (e) { plan = { ok: false, why: `チェーンを読めない：${e.message ?? e}` }; }
  if (srcPicks.get(key) !== pick || pick.previewSeq !== seq || pick.chosen !== chosenAt || srcKey(q) !== key || W.connected()?.address !== c.address) return;
  // 読んでいる間に、依頼の中身（状態・届け先・量・世界・自分の答え）が変わったら、古い依頼で立てた見込みは出さない
  if (planBasisOf(view?.requests.find(x => x.id === q.id), signer?.address) !== basis) { pick.preview = null; renderRequests(); return say('見込みを読んでいる間に依頼か自分の答えが変わった。もう一度見込みを出してください', 'warn'); }
  pick.preview = { chosen: chosenAt, basis, status: plan.ok ? 'ok' : 'failed',
    text: plan.ok ? `見込み（送るときに読み直す）：送り元 (${plan.src.p},${plan.src.q}) 村${plan.src.site}・道 ${plan.plan.dirs.length} マス・隊商 #${plan.fields.seq}・手数料 ${plan.fields.fee}（ゲームの隊商と同じ）。${estText(plan)}`
      : `この送り元からは送れない（見込み）：${plan.why}` };
  renderRequests();
}

async function sendOnce(q) {
  const c = W.connected();
  if (!c || !signer) return say('先に署名する人を接続してください', 'warn');
  const b = blocking(q);
  if (b?.kind === 'unknown') return followSend(q, b.sending);
  if (b?.kind === 'landed-unlinked') return post({ kind: 'link', request: q.id, caravan: { ownerTag: b.sending.caravan.ownerTag, seq: b.sending.caravan.seq } }, `着地していた隊商 #${b.sending.caravan.seq} をこの依頼に結び付けた`);
  const resp = q.responses[signer.address];
  // （2026-11-17、送り元）選んだ送り元（選んでいなければ null：これまでどおり Citizen の最初の村）。使えない選択なら送らない（黙って替えない）
  const key = srcKey(q), pick = srcPicks.get(key) ?? null, chosenAt = pick ? pick.chosen : null;
  const basis = planBasisOf(q, signer.address);   // 計画に効く依頼の中身（押した時の表示）
  const use = sourceToUse(pick, chosenAt);
  if (!use.ok) return say(`送れない：${use.why}`, 'warn');
  // （2026-11-17、同じ入口）送る前に、この入口のヘラルドの世界を読み直す。別の世界なら送らない（分からないときは、これまでどおり）
  if ((await readComposition()).state === 'different') return say(`送れない：${compositionText(composed, cfg)}`, 'bad');
  const reader = rpcReader(at('/coop/rpc'));
  say('送り元・道・番号をチェーンから読んでいます…');
  const plan = await planSend({ reader, season: cfg.season, wallet: c.address, request: q, cargo: resp.offer, source: use.source });
  // 計画を読んでいる間に、送る人・依頼・送り元の選択が変わったら、この計画は使わない（新しい選択に古い計画を当てない）
  const pickNow = srcPicks.get(key) ?? null, qNow = view?.requests.find(x => x.id === q.id) ?? null;
  if (srcKey(q) !== key || W.connected()?.address !== c.address || pickNow !== pick || (pickNow ? pickNow.chosen : null) !== chosenAt || !qNow)
    return say('計画を読んでいる間に、送る人・依頼・送り元の選択が変わった。この計画では送らない。もう一度押してください', 'warn');
  // （2026-11-17）読み直した依頼の中身が、計画を立てた時と違えば（状態・届け先・量・世界・届け先の確かめ・自分の答え）、古い計画は使わない。
  // 中身で比べるので、変わっていない読み直しでは止めない
  if (planBasisOf(qNow, signer.address) !== basis)
    return say('計画を読んでいる間に、依頼か自分の答えが変わった（状態・届け先・量・答えなど）。この計画では送らない。読み直した表示で確かめて、もう一度押してください', 'warn');
  // 読み直しで、この依頼への自分の前の送信（結果が分からない・着地して結び付けていない）が見えたら、既存の決まりどおり次は送らない
  if (blocking(qNow)) return say(`送らない：${blocking(qNow).why}。読み直した表示のボタンで確かめてください`, 'warn');
  if (!plan.ok) return say(`送れない：${plan.why}`, 'bad');
  if (use.source && placeKey(plan.src) !== placeKey(use.source)) return say('計画の送り元が、選んだ村と違う。送らない', 'bad');
  // 送る前の見込み（判定ではない）
  const short = Object.entries(plan.estimate.shortfall);
  const est = estText(plan);
  if (!confirm(shown(`村 (${plan.src.p},${plan.src.q}) 村${plan.src.site} から ${plan.plan.dirs.length} マス、隊商 #${plan.fields.seq} で ${needText(resp.offer)} を送ります。\n${est}\nウォレットで署名しますか？`))) return say(`送らなかった。${est}`, short.length ? 'warn' : '');
  say(`${est}。ウォレットで署名してください`);
  // ウォレットが署名した直後、中継へ出す前に、板へ sending の記録を残す（再読込・板の再起動の後も結果を追え、二重に送らない）。
  // 板が断ったら（結果の分からない送信が残っている等）、中継へは出さない。
  let sending = null;
  const wallet = {
    address: c.address,
    signTransaction: async wire => {
      const signed = await c.signTransaction(wire);
      const tx = parseTransaction(signed);
      const i = tx.signers.indexOf(c.address);
      sending = { kind: 'sending', request: q.id, caravan: plan.caravan, walletSig: toBase58(tx.signatures[i]), blockhash: tx.recentBlockhash,
        cargo: Object.fromEntries(Object.entries(resp.offer)), src: { p: plan.src.p, q: plan.src.q, site: plan.src.site, gen: plan.src.gen } };
      const signedRec = await signRecord(signer, { v: 1, season: cfg.season, at: Math.floor(Date.now() / 1000), ...sending });
      const r = await api('/coop/records', signedRec);
      if (!r.ok) throw Object.assign(new Error(`板が送信の記録を受けなかった：${r.why}`), { code: 'SendingRefused' });
      return signed;
    },
  };
  const r = await sendPlanned(plan, { relay: cfg.relay, season: cfg.season, wallet });
  if (!r.ok && !sending) return say(`送れなかった：${r.error ?? r.code}`, 'bad');
  if (!r.ok && r.code === 'SendingRefused') return say(r.error, 'bad');
  await refresh();
  const z = (view.requests.find(x => x.id === q.id)?.sendings ?? []).find(x => x.walletSig === sending.walletSig);
  return followSend(q, z ?? { ...sending, responder: c.address }, r.ok ? r.signature : null);
}

/**
 * 送った取引の結果を確かめる（chain.mjs sendOutcome）。取引の中身（プログラム・命令・番号・送り元・届け先・荷）が計画と一致して
 * 成功したときだけ結び付ける。失敗・不一致・番号を取られた・期限切れなら、送り直せる。分からないままなら、板の記録が残るので次は送らない。
 */
async function followSend(q, z, signature = null) {
  const reader = rpcReader(at('/coop/rpc'));
  const plan = { wallet: z.responder, caravan: z.caravan, src: z.src, dst: q.to, cargo: RESOURCES.map(r => z.cargo[r] ?? 0) };
  for (let i = 0; i < FOLLOW_TRIES; i++) {
    const o = await sendOutcome(reader, cfg.season, plan, { signature, walletSig: z.walletSig, blockhash: z.blockhash });
    if (o.status === 'landed') return post({ kind: 'link', request: q.id, caravan: z.caravan }, `隊商 #${z.caravan.seq} が着地し（取引の中身が依頼と一致）、この依頼に結び付けた。数えるのは確定した到着だけ`);
    if (o.status !== 'unknown') { await refresh(); return say(`送信は成り立たなかった（${o.status}）：${o.why}。物は動いていない。計画し直して送れる`, 'bad'); }
    await new Promise(res => setTimeout(res, 1500));
  }
  await refresh();
  say(`送信の結果がまだ分からない（隊商 #${z.caravan.seq}）。板に記録があるので、再読込しても次は送らない。もう一度押すと確かめ直す`, 'warn');
}

$('send').addEventListener('click', () => {
  const need = {};
  const wood = Number($('needWood').value), stone = Number($('needStone').value);
  if (wood > 0) need.wood = wood;
  if (stone > 0) need.stone = stone;
  const at = Math.floor(Date.now() / 1000);
  // 届け先は入口（?to=）か手で入れた値だけ。空欄を 0 として送らない（村 (0,0) の 0 番・世代 0 に依頼してしまう）
  const raw = ['toP', 'toQ', 'toSite', 'toGen'].map(k => $(k).value.trim());
  if (raw.some(v => !/^-?\d+$/.test(v))) return say('届け先の村（P・Q・村の番号・世代）を入れてください。ゲームの村のカードから開くと入る', 'warn');
  const to = { kind: 'holding', p: Number(raw[0]), q: Number(raw[1]), site: Number(raw[2]), gen: Number(raw[3]) };
  post({ kind: 'request', goalId, need, to, nation: myNation(), expiresAt: at + Math.round(Number($('hours').value) * 3600), nonce: Math.random().toString(36).slice(2) }, '依頼を出した（応じた人がいても、物は自動では動かない）');
});
$('leave').addEventListener('click', () => post({ kind: 'leave', goalId }, 'この目的から抜けた。自分の依頼は取り消し、応じた答えは取り下げた。送った隊商はそのまま届く'));
$('connect').addEventListener('click', connectWallet);
$('wallet').addEventListener('change', () => { walletPicked = true; });
$('nation').addEventListener('change', () => { nationChosen = true; refresh(); });
$('judge').addEventListener('change', refresh);

(async () => {
  cfg = await apiRead('/coop/config');   // （2026-11-17）読めなければ投げる：下の catch が「読み込めない」と言う
  W.discover();
  W.onChange(renderWallets);
  renderWallets();
  $('season').textContent = `世界の番号 ${cfg.season.seasonId}（プログラム ${short(cfg.season.programId)}）`;
  await readComposition();   // （2026-11-17、同じ入口）投げない：読めなければ「分からない」と言う
  $('goalTitle').textContent = cfg.goals[goalId].title;
  $('judge').innerHTML = cfg.judges.map(j => `<option value="${esc(j.id)}"${j.id === cfg.judge ? ' selected' : ''}>${esc(j.label)}</option>`).join('');
  $('judgeMeans').innerHTML = cfg.judges.map(j => `<li><b>${esc(j.label)}</b>：${esc(j.means)}</li>`).join('');
  if (!cfg.chain) say('この板はチェーンを読まない（--rpc なし）。国籍と届け先の村は未検証になり、国をまたぐ協力の達成は確定しない', 'warn');
  if (cfg.damaged?.length) say(`板の記録に読めない行が ${cfg.damaged.length} 行ある（記録の欠落）`, 'bad');
  if (cfg.store?.problems?.length) say(`板の記録の区間に問題がある：${cfg.store.problems.join('、')}`, 'bad');
  const qs = new URLSearchParams(location.search);
  const to = qs.get('to');   // ⑦の入口：?to=p,q,site,gen&program=…&season=…（入口の村の世界）
  // （2026-11-17）入口の村の世界（program・シーズン）が、この板のいまの世界と同じときだけ届け先を入れる。違う・分からないときは
  // 入れずに理由を言う（同じ座標でも別の世界の村になるため）。届け先は手で入れられる（依頼の確かめはこれまでどおり）。
  // （2026-11-18）空・無い世界どうしを同じにしない：比べ方は crosslinks.mjs の sameCtx だけ
  const sameWorld = sameCtx({ programId: qs.get('program'), seasonId: qs.get('season') }, cfg.season);
  if (to && /^-?\d+,-?\d+,\d+,\d+$/.test(to) && sameWorld) [$('toP').value, $('toQ').value, $('toSite').value, $('toGen').value] = to.split(',');
  else if (to && /^-?\d+,-?\d+,\d+,\d+$/.test(to)) {
    $('entryWarn').textContent = qs.get('program') === null || qs.get('season') === null
      ? '入口の村が、どの世界（世界の番号・プログラム）の村か分からないため、届け先に入れていない。この板の世界の届け先の村を入れてください'
      : `入口の村は別の世界（世界の番号 ${qs.get('season').slice(0, 20)}）の村のため、届け先に入れていない。この板の世界（世界の番号 ${cfg.season.seasonId}）の届け先の村を入れてください`;
    $('entryWarn').hidden = false;
  } else if (to !== null) { $('entryWarn').textContent = `入口から渡された届け先（?to=${to.slice(0, 40)}）が読めない。届け先の村を入れてください`; $('entryWarn').hidden = false; }   // 接続などの知らせで消えない欄
  // （2026-11-17、一つの依頼）名指しされた依頼は、届け先と同じく、入口の村の世界がこの板の世界のときだけ持つ。
  // 届け先の分岐（上）とは別に決める（届け先の入れ方・知らせは変えない）
  const reqParam = qs.get('request');
  const entryOk = !!to && /^-?\d+,-?\d+,\d+,\d+$/.test(to);
  focus = entryOk && sameWorld && typeof reqParam === 'string' && reqParam && reqParam.length <= 128 ? { id: reqParam, to, seen: false } : null;
  if (reqParam !== null && !focus) focusSay(!entryOk ? '入口で選んだ依頼は、入口の村が渡されていないか読めないため開いていません。一覧から選んでください'
    : !sameWorld ? '入口で選んだ依頼は、入口の村がこの板の世界の村だと確かめられないため開いていません。一覧から選んでください'
    : '入口で選んだ依頼の名前が読めないため開いていません。一覧から選んでください');
  await refresh();
  setInterval(() => { refresh(); }, 4000);   // （2026-11-17）refresh は投げず、失敗は読み込みの状態の一行で言う（黙らない）
})().catch(e => say(`読み込めない：${e.message ?? e}`, 'bad'));
