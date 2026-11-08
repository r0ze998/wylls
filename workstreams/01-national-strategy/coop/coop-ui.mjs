// 依頼の画面。署名はゲームと同じウォレット（同じ入口の Dev Wallet）で行う。物を動かすのはゲームの隊商だけ。

import { RESOURCE_JA, signRecord, ownerTagOf, RESOURCES } from './record.mjs';
import { pendingSendOf } from './pending.mjs';
import { deliveredText, FULFILMENT_JA } from './ws04.mjs';
import { STATE_JA } from './arrival.mjs';
import * as W from '../../../permutation-server/web/wallet.mjs';
import { equal } from '../../../permutation-server/web/sdk/bytes.mjs';
import { parseTransaction } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { encode as toBase58 } from '../../../permutation-server/web/sdk/base58.mjs';
import { planSend, sendPlanned } from './send.mjs';
import { rpcReader, sendOutcome } from './chain.mjs';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = a => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '?');
const nationName = n => `国${Number(n) + 1}`;
const needText = o => Object.entries(o ?? {}).map(([r, v]) => `${RESOURCE_JA[r] ?? r} ${v}`).join('・') || '—';
const VERIFICATION_JA = { RuleDerived: '規則から', Recorded: '記録から', Unverifiable: '確認できない', KnownZero: '0 と分かっている' };
const REQ_JA = { open: '受付中', cancelled: '取り消し', expired: '期限切れ' };
const CANCEL_JA = { self: '自分で進める', other: 'ほかの理由', done: '足りた', left: '目的から抜けた' };

let cfg = null, view = null, feed = null, signer = null;
/** 送った後に結果を確かめる回数（1.5 秒ごと）。?follow= で変えられる（試験用）。 */
const FOLLOW_TRIES = Math.max(1, Math.min(60, Number(new URLSearchParams(location.search).get('follow')) || 20));
const goalId = 'crossing-storehouse-v1';

function say(text, kind = '') { $('msg').innerHTML = text ? `<span class="${kind}">${esc(text)}</span>` : ''; }

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}

/** 板のネットワーク（Wallet Standard の chain）。板の --cluster（既定 localnet）。 */
const chainOf = () => W.chainOf(cfg?.cluster ?? 'localnet');
const DEV = 'dev';

/**
 * ウォレットを選ぶ：ゲームと同じ wallet.mjs で、ブラウザにある Wallet Standard のウォレットを並べる（Phantom などの拡張）。
 * Dev Wallet（localnet だけ）は、選んで押したときに初めて有効にする（有効にすると、この画面の localStorage に鍵の種を作るため）。
 */
function renderWallets() {
  const list = W.list(chainOf()).filter(e => !e.dev);
  const opts = [...list.map((e, i) => `<option value="${i}"${e.why ? ' disabled' : ''}>${esc(e.name)}${e.why ? `（${esc(e.why)}）` : ''}</option>`),
    ...(chainOf() === 'solana:localnet' ? [`<option value="${DEV}">Dev Wallet（ローカル）</option>`] : [])];
  const keep = $('wallet').value;
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
    $('who').textContent = `署名する人：${short(c.address)}（${c.name}）`;
    say('');
    await refresh();
  } catch (e) { say(`接続できない：${e.message ?? e}`, 'bad'); }
}

/** 記録に署名して板へ出す。 */
async function post(rec, done) {
  if (!signer) return say('先に署名する人を接続してください', 'warn');
  try {
    const signed = await signRecord(signer, { v: 1, season: cfg.season, at: Math.floor(Date.now() / 1000), ...rec });
    const r = await api('/coop/records', signed);
    if (!r.ok) return say(`受け付けられなかった：${r.why}`, 'bad');
    say(done, 'ok');
    await refresh();
  } catch (e) { say(`署名できない：${e.message ?? e}`, 'bad'); }
}

const myNation = () => Number($('nation').value);

function renderJoint() {
  const rows = view.joint;
  $('joint').querySelector('.body').innerHTML = `
    <div class="note">${esc(cfg.goals[goalId].what)}。費用（S1）：${esc(needText(cfg.goals[goalId].cost))}。ほかの人から：${esc(needText(cfg.goals[goalId].fromOthers))}［仮］。報酬はない。</div>
    ${rows.length ? rows.map(j => `
      <div class="req" data-host="${esc(j.host)}">
        <div><b>${esc(short(j.host))}</b>（${j.hostNation === null ? `<span class="warn">国籍未検証</span>` : esc(nationName(j.hostNation))}）の貯蔵庫：
          <span class="tag ${j.done ? 'ok' : 'warn'}" data-testid="joint-status">${j.done ? '達成（記録だけ）' : 'まだ達成と言えない'}</span></div>
        <div>${j.progress.map(p => `${esc(RESOURCE_JA[p.resource])} <b data-testid="joint-${p.resource}">${p.verified}</b>／${p.need}`).join('　')}（数えた入荷量の下限。資源ごと。合計しない）</div>
        <div class="note" data-testid="joint-precision">整数単位。記録は到着1件ごとにミリ単位を切り捨てた値なので、本当の量は表示より ${j.progress.map(p => `${esc(RESOURCE_JA[p.resource])} ${p.underBy} 未満`).join('・')} 多いことがある（件数ぶん）</div>
        <div class="note" data-testid="joint-why">${esc(j.judgeLabel)}：${esc(j.why)}</div>
        <div class="note">確かめた他国：${j.otherNations.length ? j.otherNations.map(nationName).join('・') : 'なし'}${j.nationsUnverified.length ? `（<span class="warn" data-testid="nation-unverified">${esc(j.nationsUnverified.join('、'))}</span>）` : ''}。輸送中・不明の隊商 ${j.unverifiedCaravans} 本、到着したが数えられない隊商（入った量を確認できない・受取人や時刻が未検証）${j.unprovenDeliveries} 本（どちらも数えない。0 個とは言わない）</div>
      </div>`).join('') : '<div class="note">まだ依頼はない</div>'}`;
}

function renderNation() {
  const n = view.nation;
  $('nationPanel').querySelector('.body').innerHTML = !n ? '<div class="note">署名する人を接続すると出る</div>'
    : n.nation === null ? `<div class="warn" data-testid="my-nation">国籍未検証：${esc(n.why)}</div><div class="note">${esc(n.note)}</div>`
    : `<div data-testid="my-nation">${esc(nationName(n.nation))}（チェーンの Citizen で確かめた）：依頼 ${n.requests} 件、この国の人が届けた証明できる到着 ${n.deliveredFromNation} 本</div>
    <div class="note">${esc(n.note)}。国は持ち主の物を動かせない。</div>`;
}

function renderPersonal() {
  const p = view.personal;
  $('personal').querySelector('.body').innerHTML = p ? `
    <div>自分の依頼 ${p.myRequests.length} 件・自分の応答 ${p.myResponses.length} 件</div>
    <div>自分が届けた確定の量：<b data-testid="my-verified">${esc(needText(p.myVerified))}</b></div>
    ${p.left.length ? '<div class="warn">この目的から抜けている（送った隊商はそのまま届く）</div>' : ''}
    <div class="note">協力しないで自分で進めてもよい。自分の物で建てれば、依頼は「自分で進める」で取り消せる。</div>` : '<div class="note">署名する人を接続すると出る</div>';
}

/** 自分の隊商のうち、この依頼の届け先へ向かうもの（ヘラルドの一覧から）。 */
function myCaravansTo(q) {
  if (!signer || !feed) return [];
  const tag = ownerTagOf(cfg.season, signer.address);
  return (feed.moving ?? []).filter(m => String(m.ownerTag) === tag && !m.raided && m.dst?.kind === 1 && m.dst.p === q.to.p && m.dst.q === q.to.q && m.dst.at === q.to.site && m.dst.gen === q.to.gen);
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
      <div class="note" data-testid="req-fulfilment" data-status="${esc(q.fulfilment?.status ?? '')}">依頼の充足：${esc(FULFILMENT_JA[q.fulfilment?.status] ?? '—')}${q.fulfilment && q.fulfilment.status !== 'none' ? `。数えた量の下限 ${esc(needText(q.fulfilment.lower))}${q.fulfilment.upperExclusive ? `、上限 ${esc(needText(q.fulfilment.upperExclusive))} 未満` : ''}${q.fulfilment.open ? `、終わっていない ${q.fulfilment.open} 本${q.fulfilment.held ? `（うち原因を確認中 ${q.fulfilment.held}）` : ''}` : ''}${q.fulfilment.unproven ? `、到着したが数えられない ${q.fulfilment.unproven} 本` : ''}${q.fulfilment.knownZero ? `、届かなかった ${q.fulfilment.knownZero} 本` : ''}` : ''}</div>
      <div class="row">
        ${mine && open ? `<button data-act="cancel-self" data-id="${esc(q.id)}">取り消す（自分で進める）</button><button data-act="cancel-other" data-id="${esc(q.id)}">取り消す（ほかの理由）</button>` : ''}
        ${!mine && open && !accepted ? `<button data-act="accept" data-id="${esc(q.id)}">応じる（送るつもり。義務はない）</button><button data-act="decline" data-id="${esc(q.id)}">断る</button>` : ''}
        ${!mine && accepted && open ? `<button data-act="withdraw" data-id="${esc(q.id)}">取り下げる（別の相手を選ぶ）</button>` : ''}
      </div>
      ${!mine && accepted && open && !badDst && cfg.relay && cfg.rpcProxy ? (blocking(q)
        ? (blocking(q).kind === 'landed-unlinked'
          ? `<div class="row"><button data-act="link" data-id="${esc(q.id)}" data-tag="${esc(blocking(q).sending.caravan.ownerTag)}" data-seq="${blocking(q).sending.caravan.seq}" data-testid="pending-link">着地した隊商 #${blocking(q).sending.caravan.seq} をこの依頼に結び付ける</button><span class="warn">結び付けるまで次は署名・送付しない（同じ物を二度送らない）</span></div>`
          : `<div class="row"><button data-act="send" data-id="${esc(q.id)}" data-testid="pending-send">前の送信（隊商 #${blocking(q).sending.caravan.seq}）の結果を確かめる</button><span class="warn">結果が分かるまで次は署名・送付しない</span></div>`)
        : `<div class="row"><button data-act="send" data-id="${esc(q.id)}">この画面から送る（${esc(needText(resp.offer))}。ウォレットで署名）</button></div>`) : ''}
      ${!mine && accepted && open && !badDst ? `<div class="note">ゲームの村の引き出し「交易と防備」からも送れる：行き先 (${q.to.p},${q.to.q}) 村${q.to.site}、荷 ${esc(needText(resp.offer))}。他の人の村へ送る隊商は、ウォレットで署名します。</div>
        <div class="row">${cands.length ? cands.map(m => `<button data-act="link" data-id="${esc(q.id)}" data-tag="${esc(m.ownerTag)}" data-seq="${m.seq}">隊商 #${m.seq}（${esc(needText(Object.fromEntries(RESOURCES.map((r, i) => [r, m.cargo[i]]).filter(([, v]) => v > 0))))}）をこの依頼に結び付ける</button>`).join('') : '<span class="note">この届け先へ向かう自分の隊商はまだ見えない</span>'}</div>` : ''}
    </div>`;
  }).join('') : '<div class="note">依頼はまだない</div>';
}

function renderArrivals() {
  const a = view.arrivals;
  const feedNote = view.heraldFeed ? (view.heraldFeed.ended === null ? '<div class="warn">このヘラルドは確定の記録（ended）を出していない。到着は未検証のまま（④のパッチ待ち）</div>' : '') : '<div class="bad">ヘラルドの隊商の一覧が読めない</div>';
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

async function refresh() {
  const v = new URLSearchParams({ judge: $('judge').value || cfg.judge, ...(signer ? { viewer: signer.address } : {}) });
  [view, feed] = await Promise.all([api(`/coop/view?${v}`), fetch('/h/caravans.json').then(r => (r.ok ? r.json() : null)).catch(() => null)]);
  renderJoint(); renderNation(); renderPersonal(); renderRequests(); renderArrivals();
}

document.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const q = view.requests.find(x => x.id === id);
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
    case 'link': return post({ kind: 'link', request: id, caravan: { ownerTag: b.dataset.tag, seq: Number(b.dataset.seq) } }, '隊商を結び付けた。数えるのは確定した到着だけ');
  }
});

/**
 * この画面から送る：ゲームと同じコード（send.mjs → fplay.submit）で SendCaravan を組み立て、接続したウォレットで署名して中継へ送る。
 * チェーンに隊商の口座が見えたら、結び付けの記録に署名して板へ出す。
 */
/** この依頼への自分の送信のうち、次の送付を止めるもの（結果が分からない・着地したのに結び付けていない。板の sending の記録から。再読込・板の再起動の後も残る）。 */
const blocking = q => (signer ? pendingSendOf(q, signer.address, z => z.outcome) : null);

async function sendFor(q) {
  const c = W.connected();
  if (!c || !signer) return say('先に署名する人を接続してください', 'warn');
  const b = blocking(q);
  if (b?.kind === 'unknown') return followSend(q, b.sending);
  if (b?.kind === 'landed-unlinked') return post({ kind: 'link', request: q.id, caravan: { ownerTag: b.sending.caravan.ownerTag, seq: b.sending.caravan.seq } }, `着地していた隊商 #${b.sending.caravan.seq} をこの依頼に結び付けた`);
  const resp = q.responses[signer.address];
  const reader = rpcReader('/coop/rpc');
  say('送り元・道・番号をチェーンから読んでいます…');
  const plan = await planSend({ reader, season: cfg.season, wallet: c.address, request: q, cargo: resp.offer });
  if (!plan.ok) return say(`送れない：${plan.why}`, 'bad');
  // 送る前の見込み（判定ではない）
  const short = Object.entries(plan.estimate.shortfall);
  const est = `送り元の在庫（見込み）：${needText(plan.estimate.have)}${short.length ? `。不足（見込み）：${needText(Object.fromEntries(short))}` : '。不足なし（見込み）'}。足りるかの最終判定は、送信の時にプログラムが行う`;
  if (!confirm(`村 (${plan.src.p},${plan.src.q}) から ${plan.plan.dirs.length} マス、隊商 #${plan.fields.seq} で ${needText(resp.offer)} を送ります。\n${est}\nウォレットで署名しますか？`)) return say(`送らなかった。${est}`, short.length ? 'warn' : '');
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
  const reader = rpcReader('/coop/rpc');
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
$('nation').addEventListener('change', refresh);
$('judge').addEventListener('change', refresh);

(async () => {
  cfg = await api('/coop/config');
  W.discover();
  W.onChange(renderWallets);
  renderWallets();
  $('season').textContent = `シーズン ${cfg.season.seasonId}（プログラム ${short(cfg.season.programId)}）`;
  $('goalTitle').textContent = cfg.goals[goalId].title;
  $('judge').innerHTML = cfg.judges.map(j => `<option value="${esc(j.id)}"${j.id === cfg.judge ? ' selected' : ''}>${esc(j.label)}</option>`).join('');
  $('judgeMeans').innerHTML = cfg.judges.map(j => `<li><b>${esc(j.label)}</b>：${esc(j.means)}</li>`).join('');
  if (!cfg.chain) say('この板はチェーンを読まない（--rpc なし）。国籍と届け先の村は未検証になり、国をまたぐ協力の達成は確定しない', 'warn');
  if (cfg.damaged?.length) say(`板の記録に読めない行が ${cfg.damaged.length} 行ある（記録の欠落）`, 'bad');
  if (cfg.store?.problems?.length) say(`板の記録の区間に問題がある：${cfg.store.problems.join('、')}`, 'bad');
  const to = new URLSearchParams(location.search).get('to');   // ⑦の入口：?to=p,q,site,gen
  if (to && /^-?\d+,-?\d+,\d+,\d+$/.test(to)) [$('toP').value, $('toQ').value, $('toSite').value, $('toGen').value] = to.split(',');
  else if (to !== null) { $('entryWarn').textContent = `入口から渡された届け先（?to=${to.slice(0, 40)}）が読めない。届け先の村を入れてください`; $('entryWarn').hidden = false; }   // 接続などの知らせで消えない欄
  await refresh();
  setInterval(() => refresh().catch(() => {}), 4000);
})().catch(e => say(`読み込めない：${e.message ?? e}`, 'bad'));
