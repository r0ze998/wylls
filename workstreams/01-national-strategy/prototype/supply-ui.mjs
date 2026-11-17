// 国際供給網の試作：画面。数え方と判断は supply.mjs、行動と時間は model.mjs にある。

import {
  createSupplyWorld, supplyDecisions, performSupply, advanceSupply, injectSupply, jointStatus, personalStatus,
  nationStatus, SUPPLY_EVENTS,
} from './supply.mjs';
import { label, custody } from './model.mjs';
import { SUPPLY_NATIONS, JOINT } from './scenario-supply.mjs';
import { RESOURCES } from './scenario.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ui = { world: createSupplyWorld(), me: 'nagi', options: new Map() };

function render() {
  const w = ui.world;
  ui.options.clear();
  $('#clock').innerHTML = `ターン <b>${w.turn}</b>・共同成果の期限 ターン${JOINT.deadline}`;
  $('#who').innerHTML = Object.values(w.members).map(m => `<button type="button" class="person${m.id === ui.me ? ' on' : ''}" data-ui="me" data-id="${m.id}" aria-pressed="${m.id === ui.me}">
    <b>${esc(m.name)}</b><small>${esc(SUPPLY_NATIONS[m.nation])}・${esc(m.role)}</small>${!m.present ? '<span class="pill warn">不在</span>' : ''}${w.supply.left[m.id] != null ? '<span class="pill">抜けた</span>' : ''}<span class="count">${supplyDecisions(w, m.id).length}</span></button>`).join('');
  renderJoint(w);
  renderEvals(w);
  renderOffers(w);
  renderShips(w);
  renderDecisions(w);
  renderMine(w);
  $('#log').innerHTML = w.log.slice().reverse().slice(0, 80).map(l => `<li class="k-${esc(l.kind)}"><span class="t">T${l.turn}</span> ${esc(l.text)}</li>`).join('');
}

function renderJoint(w) {
  const st = jointStatus(w);
  const j = w.supply.joint;
  const rows = Object.entries(st.credits).flatMap(([id, c]) => Object.entries(c.per).map(([r, p]) => `<tr>
    <td>${esc(w.members[id].name)}</td><td>${esc(label.res(r))}</td><td>${p.received}${p.unverified ? ` <small>＋未検証 ${p.unverified}</small>` : ''}</td><td>${p.sent}</td><td>${p.net}</td><td>${p.used}</td><td><b>${p.credit}</b></td></tr>`)).join('');
  $('#joint').innerHTML = `<article class="card">
    <header><span class="pill ${j.status === '達成' ? 'good' : j.status === '期限切れ' ? 'bad' : 'info'}">${esc(j.status)}</span>${j.achievedAt != null ? ` <small>ターン${j.achievedAt}に一区切り</small>` : ''}
      <h3>三国の交易路が使われる</h3></header>
    <p class="small">一区切りの条件：他の人から届き（④で確かめた到着だけ）、受け取った人が実際に使った（建設・昇格・訓練・工房の材料）量が${JOINT.perPerson}以上の人が、${JOINT.nations}か国・${JOINT.people}人（判断する人の数）以上。期限：ターン${JOINT.deadline}。報酬はない。</p>
    <p>今：${st.people}人・${st.nations.length}か国（${esc(st.qualified.map(id => w.members[id].name).join('・') || 'まだいない')}）</p>
    <div class="tablewrap"><table><thead><tr><th>人</th><th>物</th><th>届いた</th><th>送った</th><th>正味</th><th>使った</th><th>数えた</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">まだない</td></tr>'}</tbody></table></div>
    <p class="small">数えた量＝「正味（届いた−送った）」と「使った」の小さい方。往復・回し合い・通り抜けは0になる。送った量や取引の回数は数えない。</p>
  </article>`;
}

function renderEvals(w) {
  const people = Object.keys(w.members).map(id => ({ id, ...personalStatus(w, id) })).filter(x => x.done !== null);
  const nations = ['A', 'B', 'C'].map(n => ({ n, ...nationStatus(w, n) }));
  const pill = d => d === true ? '<span class="pill good">達成</span>' : d === false ? '<span class="pill warn">まだ</span>' : '<span class="pill">—</span>';
  $('#evals').innerHTML = `<ul class="sites">${people.map(p => `<li>${pill(p.done)} <b>${esc(w.members[p.id].name)}</b>：${esc(p.goal)} <small>${esc(p.progress)}</small></li>`).join('')}</ul>
    <ul class="sites">${nations.map(x => `<li>${pill(x.done)} ${esc(x.goal)} <small>${esc(x.progress)}</small></li>`).join('')}</ul>`;
}

function renderOffers(w) {
  const os = Object.values(w.offers);
  $('#offers').innerHTML = os.length ? `<div class="tablewrap"><table><thead><tr><th>申し出た人</th><th>相手</th><th>渡す</th><th>求める</th><th>状態</th></tr></thead><tbody>
    ${os.map(o => `<tr><td>${esc(w.members[o.from].name)}</td><td>${esc(w.members[o.to].name)}</td><td>${esc(label.res(o.give.res))} ${o.give.qty}</td><td>${esc(label.res(o.want.res))} ${o.want.qty}</td><td><span class="pill">${esc(o.status)}</span></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">まだ申し出はない</p>';
}

function renderShips(w) {
  const ss = Object.values(w.shipments);
  $('#ships').innerHTML = ss.length ? `<ul class="sites">${ss.map(s => {
    const c = custody(w, s.id);
    const st = s.state === '到着済み' ? (s.verified === false ? '到着（未検証）' : `到着済み（ターン${s.arrivedAt}）`) : `${s.state}（見込み ターン${s.eta}${s.delay ? `、遅れ +${s.delay}` : ''}）`;
    return `<li><b>${esc(label.res(s.resource))} ${s.qty}</b> ${esc(w.members[s.owner].name)} → ${esc(w.members[s.to.member]?.name ?? '')} <small>${esc(st)}・今の持ち主：${esc(c.ownerNow ? label.who(w, c.ownerNow) : 'なし')}${s.why ? `・${esc(s.why)}` : ''}</small></li>`;
  }).join('')}</ul>` : '<p class="empty">まだ荷車はない</p>';
}

function renderDecisions(w) {
  const ds = supplyDecisions(w, ui.me);
  if (!ds.length) { $('#decisions').innerHTML = '<p class="empty">いま決めることはない。ターンを進めるか、別の人に切り替える。</p>'; return; }
  $('#decisions').innerHTML = ds.map(d => `<article class="card decision"><h3>${esc(d.title)}</h3><p class="why">${esc(d.why)}</p>
    <ul class="opts">${d.options.map((o, i) => {
      const key = `${d.id}#${i}`;
      ui.options.set(key, o);
      const off = o.enabled === false;
      return `<li class="${o.wait ? 'wait' : ''}${off ? ' off' : ''}"><button type="button" data-ui="opt" data-key="${esc(key)}"${off ? ' disabled' : ''}>${esc(o.label)}</button>
        <p class="conseq">${off ? `<b>選べない：</b>${esc(o.reason ?? '')}` : esc(o.consequence ?? '')}</p></li>`;
    }).join('')}</ul></article>`).join('');
}

function renderMine(w) {
  const st = w.stock[ui.me];
  const m = w.members[ui.me];
  $('#mine').innerHTML = `<p class="small">${esc(m.note)}</p><table class="stock"><tbody>${Object.keys(RESOURCES).map(r => `<tr><td>${esc(RESOURCES[r])}</td><td>${st[r] ?? 0}</td></tr>`).join('')}
    <tr><td>村の段階</td><td>${esc(m.tier)}</td></tr></tbody></table>`;
}

function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.tid);
  toast.tid = setTimeout(() => { t.className = 'toast'; }, 3000);
}

$('#event').innerHTML = Object.entries(SUPPLY_EVENTS).map(([k, e]) => `<option value="${k}" title="${esc(e.fact)}">${esc(e.title)}：${esc(e.detail)}</option>`).join('');
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-ui]');
  if (!b) return;
  const w = ui.world;
  const k = b.dataset.ui;
  if (k === 'me') { ui.me = b.dataset.id; render(); return; }
  if (k === 'advance') { advanceSupply(w, Number(b.dataset.n)); render(); toast(`ターン${w.turn}になった`); return; }
  if (k === 'reset') { ui.world = createSupplyWorld(); render(); toast('やり直した'); return; }
  if (k === 'inject') { const e = $('#event').value; const r = injectSupply(w, e); render(); toast(r.ok ? `出来事：${SUPPLY_EVENTS[e].title}` : r.error, !r.ok); return; }
  if (k === 'opt') {
    const o = ui.options.get(b.dataset.key);
    const r = performSupply(w, ui.me, o);
    render();
    toast(r.ok ? (r.waited ? `待つ：${o.consequence}` : o.label) : r.error, !r.ok);
  }
});
render();
window.__supply = ui;
