// 依頼の画面。署名はゲームと同じウォレット（同じ入口の Dev Wallet）で行う。物を動かすのはゲームの隊商だけ。

import { RESOURCE_JA, signRecord, ownerTagOf, RESOURCES } from './record.mjs';
import { STATE_JA } from './arrival.mjs';
import * as W from '../../../permutation-server/web/wallet.mjs';
import { equal } from '../../../permutation-server/web/sdk/bytes.mjs';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = a => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '?');
const nationName = n => `国${Number(n) + 1}`;
const needText = o => Object.entries(o ?? {}).map(([r, v]) => `${RESOURCE_JA[r] ?? r} ${v}`).join('・') || '—';
const REQ_JA = { open: '受付中', cancelled: '取り消し', expired: '期限切れ' };
const CANCEL_JA = { self: '自分で進める', other: 'ほかの理由', done: '足りた', left: '目的から抜けた' };

let cfg = null, view = null, feed = null, signer = null;
const goalId = 'crossing-storehouse-v1';

function say(text, kind = '') { $('msg').innerHTML = text ? `<span class="${kind}">${esc(text)}</span>` : ''; }

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}

async function connectDev() {
  try {
    await W.enableDevWallet({ cluster: 'localnet', allowed: true });
    const dev = W.list('solana:localnet').find(e => e.dev);
    await W.connect(dev, { chain: 'solana:localnet' });
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
          <span class="tag ${j.done ? 'ok' : 'warn'}" data-testid="joint-status">${j.done ? '達成（記録だけ）' : '未達成'}</span></div>
        <div>${j.progress.map(p => `${esc(RESOURCE_JA[p.resource])} <b data-testid="joint-${p.resource}">${p.verified}</b>／${p.need}`).join('　')}（証明できた入荷量だけ。資源ごと。合計しない）</div>
        <div class="note" data-testid="joint-why">${esc(j.judgeLabel)}：${esc(j.why)}</div>
        <div class="note">確かめた他国：${j.otherNations.length ? j.otherNations.map(nationName).join('・') : 'なし'}${j.nationsUnverified.length ? `（<span class="warn" data-testid="nation-unverified">${esc(j.nationsUnverified.join('、'))}</span>）` : ''}。輸送中・不明の隊商 ${j.unverifiedCaravans} 本、届いたが量を証明できない隊商 ${j.unprovenDeliveries} 本（どちらも数えない）</div>
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
    const cands = accepted && open ? myCaravansTo(q) : [];
    return `<div class="req" data-req="${esc(q.id)}">
      <div><b>${esc(needText(q.need))}</b> → ${esc(short(q.requester))}（${esc(nationName(q.nation))}・申告。判定には使わない）の村 (${q.to.p},${q.to.q}) 村${q.to.site}
        <span class="tag" data-testid="req-state">${esc(REQ_JA[q.stateNow] ?? q.stateNow)}${q.cancel ? `：${esc(CANCEL_JA[q.cancel.reason] ?? q.cancel.reason)}` : ''}</span></div>
      <div class="note">応答：${esc(others || 'まだない')}</div>
      <div class="row">
        ${mine && open ? `<button data-act="cancel-self" data-id="${esc(q.id)}">取り消す（自分で進める）</button><button data-act="cancel-other" data-id="${esc(q.id)}">取り消す（ほかの理由）</button>` : ''}
        ${!mine && open && !accepted ? `<button data-act="accept" data-id="${esc(q.id)}">応じる（送るつもり。義務はない）</button><button data-act="decline" data-id="${esc(q.id)}">断る</button>` : ''}
        ${!mine && accepted && open ? `<button data-act="withdraw" data-id="${esc(q.id)}">取り下げる（別の相手を選ぶ）</button>` : ''}
      </div>
      ${!mine && accepted && open ? `<div class="note">送るのはゲームの村の引き出し「交易と防備」から：行き先 (${q.to.p},${q.to.q}) 村${q.to.site}、荷 ${esc(needText(resp.offer))}。他の人の村へ送る隊商は、ウォレットで署名します。</div>
        <div class="row">${cands.length ? cands.map(m => `<button data-act="link" data-id="${esc(q.id)}" data-tag="${esc(m.ownerTag)}" data-seq="${m.seq}">隊商 #${m.seq}（${esc(needText(Object.fromEntries(RESOURCES.map((r, i) => [r, m.cargo[i]]).filter(([, v]) => v > 0))))}）をこの依頼に結び付ける</button>`).join('') : '<span class="note">この届け先へ向かう自分の隊商はまだ見えない</span>'}</div>` : ''}
    </div>`;
  }).join('') : '<div class="note">依頼はまだない</div>';
}

function renderArrivals() {
  const a = view.arrivals;
  const feedNote = view.heraldFeed ? (view.heraldFeed.ended === null ? '<div class="warn">このヘラルドは確定の記録（ended）を出していない。到着は未検証のまま（④のパッチ待ち）</div>' : '') : '<div class="bad">ヘラルドの隊商の一覧が読めない</div>';
  $('arrivals').querySelector('.body').innerHTML = `${feedNote}
    <table><thead><tr><th>依頼</th><th>隊商</th><th>持ち主の印</th><th>状態</th><th>記録の積荷（目減り後）</th><th>証明できた入荷量</th></tr></thead><tbody>
    ${a.map(x => `<tr data-testid="arrival"><td><code>${esc(x.requestId.slice(0, 8))}</code></td><td>${esc(x.caravanId.ownerTag.slice(0, 6))}…#${x.caravanId.seq}</td><td>${esc(x.owner.ownerTag.slice(0, 6))}…</td>
      <td data-testid="arrival-state">${esc(STATE_JA[x.state] ?? x.state)}</td><td>${x.cargo ? esc(needText(x.cargo)) : '—'}</td>
      <td data-testid="arrival-qty">${x.verifiedQty ? `${esc(needText(x.verifiedQty))}${x.qtyKind === 'lower-bound' ? '（下限）' : ''}` : `<span class="note">未検証（数えない）${x.note ? `：${esc(x.note)}` : ''}</span>`}</td></tr>`).join('') || '<tr><td colspan="6" class="note">結び付けた隊商はまだない</td></tr>'}
    </tbody></table>
    <div class="note">積荷は隊商が運んだ量で、宛先に加算された量ではない。村あては上限なしで全部加算される規則なので、記録の積荷を入荷量の下限として数える。倉あては上限で減りうるので数えない。</div>`;
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
    case 'link': return post({ kind: 'link', request: id, caravan: { ownerTag: b.dataset.tag, seq: Number(b.dataset.seq) } }, '隊商を結び付けた。数えるのは確定した到着だけ');
  }
});

$('send').addEventListener('click', () => {
  const need = {};
  const wood = Number($('needWood').value), stone = Number($('needStone').value);
  if (wood > 0) need.wood = wood;
  if (stone > 0) need.stone = stone;
  const at = Math.floor(Date.now() / 1000);
  const to = { kind: 'holding', p: Number($('toP').value), q: Number($('toQ').value), site: Number($('toSite').value), gen: Number($('toGen').value) };
  post({ kind: 'request', goalId, need, to, nation: myNation(), expiresAt: at + Math.round(Number($('hours').value) * 3600), nonce: Math.random().toString(36).slice(2) }, '依頼を出した（応じた人がいても、物は自動では動かない）');
});
$('leave').addEventListener('click', () => post({ kind: 'leave', goalId }, 'この目的から抜けた。自分の依頼は取り消し、応じた答えは取り下げた。送った隊商はそのまま届く'));
$('connect').addEventListener('click', connectDev);
$('nation').addEventListener('change', refresh);
$('judge').addEventListener('change', refresh);

(async () => {
  cfg = await api('/coop/config');
  $('season').textContent = `シーズン ${cfg.season.seasonId}（プログラム ${short(cfg.season.programId)}）`;
  $('goalTitle').textContent = cfg.goals[goalId].title;
  $('judge').innerHTML = cfg.judges.map(j => `<option value="${esc(j.id)}"${j.id === cfg.judge ? ' selected' : ''}>${esc(j.label)}</option>`).join('');
  $('judgeMeans').innerHTML = cfg.judges.map(j => `<li><b>${esc(j.label)}</b>：${esc(j.means)}</li>`).join('');
  if (!cfg.chain) say('この板はチェーンを読まない（--rpc なし）。国籍と届け先の村は未検証になり、国をまたぐ協力の達成は確定しない', 'warn');
  if (cfg.damaged?.length) say(`板の記録に読めない行が ${cfg.damaged.length} 行ある（記録の欠落）`, 'bad');
  const to = new URLSearchParams(location.search).get('to');   // ⑦の入口：?to=p,q,site,gen
  if (to && /^-?\d+,-?\d+,\d+,\d+$/.test(to)) [$('toP').value, $('toQ').value, $('toSite').value, $('toGen').value] = to.split(',');
  await refresh();
  setInterval(() => refresh().catch(() => {}), 4000);
})().catch(e => say(`読み込めない：${e.message ?? e}`, 'bad'));
