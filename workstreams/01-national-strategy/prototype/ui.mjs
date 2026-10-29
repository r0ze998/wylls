// 国の卓の試作：画面。ルールはすべて model.mjs にあり、ここは表示と入力だけ。

import {
  createWorld, advance, inject, needProgress, readiness, custody, decisionsFor, perform, pledgeTotals,
  label, EVENTS, describeNeed, seemsAbsent, stanceName,
} from './model.mjs';
import { BENEFITS, RESOURCES, ADOPT_COSIGNERS, MINUTES_PER_TURN } from './scenario.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ui = {
  world: createWorld('preparing'),
  me: 'kei',
  options: new Map(),
};
const ROLE_HINT = { kei: '国境・砦', mira: '丘・工房', sota: '平地・倉と荷車', haru: '川・ふだんは自給' };

// ------------------------------------------------------------------ 描画

function render() {
  const w = ui.world;
  ui.options.clear();
  const mins = w.turn * MINUTES_PER_TURN;
  $('#clock').innerHTML = `ターン <b>${w.turn}</b> <small>（開始から${Math.floor(mins / 60)}時間${mins % 60}分）</small>・北の国への構え：<b>${esc(stanceName(w.nation.stance.north))}</b>`;
  renderWho(w);
  renderGoals(w);
  renderFlow(w);
  renderPledges(w);
  renderSites(w);
  renderDecisions(w);
  renderMine(w);
  renderOthers(w);
  renderLog(w);
}

function renderWho(w) {
  $('#who').innerHTML = Object.values(w.members).filter(m => m.playable).map(m => {
    const n = decisionsFor(w, m.id).length;
    const absent = !m.present ? '<span class="pill warn">不在</span>' : '';
    return `<button type="button" class="person${m.id === ui.me ? ' on' : ''}" data-ui="me" data-id="${m.id}" aria-pressed="${m.id === ui.me}">
      <b>${esc(m.name)}</b><small>${esc(ROLE_HINT[m.id] ?? '')}</small>${absent}<span class="count" title="判断の数">${n}</span></button>`;
  }).join('');
}

const STATUS_CLASS = { 提案中: 'info', 準備中: 'info', 成立: 'good', 期限切れ: 'bad', 中止: 'bad', 不成立: 'bad' };

function renderGoals(w) {
  const html = Object.values(w.goals).map(g => {
    const r = readiness(w, g.id);
    const left = g.deadline - w.turn;
    const needs = g.needs.map(n => needRow(w, g, n)).join('');
    const conflict = g.conflict && !g.conflict.answered ? `<p class="alert">前提が変わった：${esc(g.conflict.text)}</p>` : '';
    const history = g.history.length ? `<details class="hist"><summary>方針の変更 ${g.history.length} 回</summary><ul>${g.history.map(h => `<li>第${h.version}版→第${h.version + 1}版（ターン${h.turn}）：${esc(h.changes.join('、'))}</li>`).join('')}</ul></details>` : '';
    const outcome = g.status === '成立' ? `<p class="okline">成立（ターン${g.readyAt}）：必要なものが実際にそろった。軍をどうするかは各持ち主が決める。</p>`
      : g.status === '期限切れ' ? `<p class="alert">期限切れ：${esc(g.outcome.missing.map(id => describeNeed(w, g.needs.find(n => n.id === id))).join('、'))} がそろわなかった。届いた物は受け取った人の物のまま。</p>`
      : g.status === '中止' ? `<p class="alert">中止：${esc(g.outcome.reason || '')}</p>` : '';
    return `<article class="card goal">
      <header><span class="pill ${STATUS_CLASS[g.status] ?? ''}">${esc(g.status)}</span> <span class="ver">第${g.version}版</span>
        <h3>${esc(g.title)}</h3></header>
      <p class="purpose">${esc(g.purpose)}</p>
      <dl class="meta">
        <dt>場所</dt><dd>${esc(label.place(g.site))}</dd>
        <dt>期限</dt><dd>ターン${g.deadline}${g.status === '準備中' || g.status === '提案中' ? `（あと${left}）` : ''}</dd>
        <dt>提案</dt><dd>${esc(label.who(w, g.proposer))}</dd>
        <dt>調整役</dt><dd>${esc(label.who(w, g.coordinator))}${seemsAbsent(w, g.coordinator) ? ' <span class="pill warn">不在の可能性</span>' : ''}<br><small>できるのは計画の編集と依頼だけ。人の物は動かせない</small></dd>
        <dt>賛同</dt><dd>${g.cosigners.length}/${ADOPT_COSIGNERS}（${esc(g.cosigners.map(c => label.who(w, c)).join('・'))}）<br><small>賛同は「卓に出す」ことへの同意で、何かを出す約束ではない</small></dd>
        <dt>参加の条件</dt><dd>この国の仲間（追放中でない）なら誰でも、何でも、どれだけでも。投票権は要らない。出す量の上限は各自が決め、発送までいつでも取り下げられる</dd>
      </dl>
      ${conflict}${outcome}
      <h4>必要なもの <small>（成立は「到着済み」「稼働」だけで判定）</small></h4>
      <ul class="needs">${needs}</ul>
      <p class="ready">${r.ready ? 'すべてそろっている' : `まだそろっていない：${esc(r.missing.map(id => describeNeed(w, g.needs.find(n => n.id === id))).join('、'))}`}</p>
      ${history}
    </article>`;
  }).join('');
  $('#goals').innerHTML = html || '<p class="empty">目標はまだない</p>';
}

function bar(p) {
  const req = Math.max(1, p.required);
  const pct = v => `${Math.min(100, (100 * v) / req).toFixed(1)}%`;
  const onTimeTransit = Math.max(0, p.inTransit - (p.lateTransit ?? 0));
  return `<div class="bar" role="img" aria-label="到着済み ${p.arrived}、輸送中 ${p.inTransit}、申し出 ${p.pledged}、必要 ${p.required}">
    <span class="arrived" style="width:${pct(p.arrived)}"></span><span class="moving" style="width:${pct(onTimeTransit)}"></span><span class="late" style="width:${pct(p.lateTransit ?? 0)}"></span><span class="pledged" style="width:${pct(p.pledged)}"></span></div>`;
}

function needRow(w, g, n) {
  const p = needProgress(w, g.id, n.id);
  const state = n.kind === 'escort' || (n.optional && !p.satisfied) ? '<span class="pill">任意</span>' : p.satisfied ? '<span class="pill good">そろった</span>' : '<span class="pill warn">まだ</span>';
  let detail = '';
  if (n.kind === 'deliver') {
    const to = n.to.kind === 'village' ? `${label.who(w, n.to.member)}の村` : '拠点の倉（倉の持ち主の物になる）';
    detail = `${bar(p)}<p class="nums">到着済み <b>${p.arrived}</b> ／ 輸送中 ${p.inTransit}${p.lateTransit ? `（うち期限後 ${p.lateTransit}）` : ''} ／ 申し出 ${p.pledged}${p.unconfirmed ? ` ／ 再確認待ち ${p.unconfirmed}` : ''}${p.pledgedAbsent ? ` ／ 不在の人の申し出 ${p.pledgedAbsent}（見込みに数えない）` : ''}${p.lost ? ` ／ 失った ${p.lost}` : ''} ／ 必要 ${p.required}</p>
      <p class="small">届け先：${esc(to)}。使う人：${esc(n.usedBy === 'vault-owner' ? '倉の持ち主（ケイの守備兵へ送るかは倉の持ち主が決める）' : label.who(w, n.usedBy))}</p>`;
  } else if (n.kind === 'build') {
    detail = `<p class="nums">${p.satisfied ? `稼働中（持ち主：${esc(label.who(w, p.owner))}）` : p.inTransit ? `建設中（持ち主：${esc(label.who(w, p.owner))}、完成ターン${p.eta}）` : p.pledgedBy.length ? `${esc(p.pledgedBy.map(x => label.who(w, x)).join('・'))}が建てると申し出` : '引き受け手なし'}</p>`;
  } else if (n.kind === 'garrison') {
    detail = `${bar(p)}<p class="nums">砦にいる <b>${p.arrived}</b> ／ 向かっている ${p.inTransit} ／ 申し出 ${p.pledged} ／ 必要 ${p.required}${p.owner ? `（砦の持ち主：${esc(label.who(w, p.owner))}）` : ''}</p>`;
  } else if (n.kind === 'watch') {
    detail = `<p class="nums">${p.satisfied ? `満たしている：${esc(p.by)}` : p.inTransit ? '偵察中または塔の建設中' : p.pledged ? '申し出あり' : '引き受け手なし'}</p>`;
  } else if (n.kind === 'escort') {
    detail = `<p class="nums">護衛の申し出：${p.pledged} 件（誰が・どこにかは封）</p>`;
  }
  return `<li><div class="needhead">${state} <b>${esc(describeNeed(w, n))}</b></div><p class="small">${esc(n.use)}</p>${detail}</li>`;
}

const COLUMNS = [
  ['準備中', '作っている・まだ送っていない'],
  ['送信済み', '命令は出したが、まだ確定していない'],
  ['輸送中', '地図の上を動いている'],
  ['到着済み', '受け取った人の物になった'],
  ['失った', '奪われた・行き先がなかった'],
];

function flowCard(w, s) {
  const c = custody(w, s.id);
  const toText = s.to.kind === 'village' ? `${label.who(w, s.to.member)}の村` : `${label.who(w, w.facilities[s.to.id]?.owner)}の倉（${label.place(w.facilities[s.to.id]?.at)}）`;
  const late = s.delay ? `<span class="pill warn">遅れ +${s.delay}</span>` : '';
  return `<li class="ship"><b>${esc(label.res(s.resource))} ${s.qty}</b> ${late}
    <span class="route">${esc(label.place(s.from))} → ${esc(toText)}</span>
    <dl class="custody"><dt>提供</dt><dd>${esc(label.who(w, c.provider))}</dd>
      <dt>今の持ち主</dt><dd>${c.ownerNow ? esc(label.who(w, c.ownerNow)) : 'なし'}</dd>
      ${s.state === '到着済み' || s.state === '失われた' || s.state === '奪われた' ? '' : `<dt>着いたら</dt><dd>${esc(label.who(w, c.ownerAfter))}の物</dd>`}
      ${c.user ? `<dt>使う人</dt><dd>${esc(label.who(w, c.user))}</dd>` : ''}</dl>
    <span class="eta">${s.state === '到着済み' ? `ターン${s.arrivedAt}に到着` : s.state === '失われた' || s.state === '奪われた' ? esc(s.state) : `到着見込み ターン${s.eta}`}</span></li>`;
}

function renderFlow(w) {
  const bins = Object.fromEntries(COLUMNS.map(([k]) => [k, []]));
  for (const p of Object.values(w.pledges)) {
    if (!p.resource || !['申し出', '準備中', '一部発送', '再確認待ち', '供給元を失った'].includes(p.status)) continue;
    const left = p.qty - p.sent;
    if (left <= 0) continue;
    const have = w.stock[p.provider][p.resource] ?? 0;
    bins['準備中'].push(`<li class="ship pledge"><b>${esc(label.res(p.resource))} ${left}</b> <span class="pill">${esc(p.status)}</span>
      <span class="route">${esc(label.who(w, p.provider))}の手元（今 ${have}）</span>
      <span class="small">${p.status === '準備中' ? '工房で作っている' : p.status === '供給元を失った' ? '作る場所を失った' : p.status === '再確認待ち' ? '本人の再確認を待っている' : '発送は持ち主が決める'}</span></li>`);
  }
  for (const s of Object.values(w.shipments)) {
    if (s.state === '送信失敗') continue;
    const col = s.state === '失われた' || s.state === '奪われた' ? '失った' : s.state;
    bins[col]?.push(flowCard(w, s));
  }
  $('#flow').innerHTML = `<div class="kanban">${COLUMNS.map(([k, hint]) => `<div class="lane"><h3>${k} <span class="n">${bins[k].length}</span></h3><p class="hint">${hint}</p><ul>${bins[k].join('') || '<li class="empty">なし</li>'}</ul></div>`).join('')}</div>`;
}

function renderPledges(w) {
  const rows = Object.values(w.pledges).map(p => {
    const g = w.goals[p.goal];
    const n = g.needs.find(x => x.id === p.need);
    const sealed = n.kind === 'escort' && p.provider !== ui.me;
    const c = custody(w, p.id);
    return `<tr><td>${sealed ? '（封）' : esc(label.who(w, p.provider))}</td><td>${esc(describeNeed(w, n))}<br><small>${esc(g.title)}</small></td>
      <td>${p.resource ? `${p.qty}<small>（上限 ${p.cap}、発送済み ${p.sent}）</small>` : '—'}</td>
      <td>${esc(sealed ? '護衛' : c.method ?? p.method)}</td><td><span class="pill">${esc(p.status)}</span>${p.version < g.version && p.status === '再確認待ち' ? `<br><small>第${p.version}版の申し出</small>` : ''}</td></tr>`;
  }).join('');
  $('#pledges').innerHTML = rows ? `<div class="tablewrap"><table><thead><tr><th>提供する人</th><th>何に</th><th>量</th><th>方法</th><th>状態</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="empty">まだ申し出はない</p>';
}

function renderSites(w) {
  const fs = Object.values(w.facilities).filter(f => f.at === 'site' || f.at === 'pass' || f.kind === '工房');
  $('#sites').innerHTML = `<ul class="sites">${fs.map(f => `<li><b>${esc(f.kind)}</b>（${esc(label.place(f.at))}）持ち主：${esc(label.who(w, f.owner))}・<span class="pill ${f.status === '稼働' ? 'good' : f.status === '奪われた' ? 'bad' : ''}">${esc(f.status)}</span>
    ${f.kind === '倉' ? `<small>中身：${Object.entries(f.contents).map(([r, v]) => `${esc(label.res(r))} ${v}`).join('・') || 'なし'}（${esc(label.who(w, f.owner))}の物）</small>` : ''}
    ${f.kind === '砦' ? `<small>守備兵 ${f.troops}</small>` : ''}${f.status === '建設中' ? `<small>完成ターン${f.readyAt}</small>` : ''}</li>`).join('')}</ul>`;
}

function renderDecisions(w) {
  const ds = decisionsFor(w, ui.me);
  const me = w.members[ui.me];
  const head = `<p class="small">${esc(me.name)}の立場。ここに出るのは提案・お願い・知らせで、命令ではありません。</p>`;
  if (!ds.length) {
    $('#decisions').innerHTML = `${head}<p class="empty">いま${esc(me.name)}が決めることはない。ターンを進めるか、別の人に切り替える。</p>`;
    return;
  }
  $('#decisions').innerHTML = head + ds.map(d => `<article class="card decision" data-goal="${esc(d.goal ?? '')}">
    <h3>${esc(d.title)}</h3><p class="why">${esc(d.why)}</p>
    ${d.benefit ? `<p class="benefit"><b>協力するあなたの得：</b>${esc(d.benefit)}</p>` : ''}
    <ul class="opts">${d.options.map((o, i) => optionHtml(d, o, i)).join('')}</ul></article>`).join('');
}

function optionHtml(d, o, i) {
  const key = `${d.id}#${i}`;
  ui.options.set(key, o);
  const form = o.form?.kind === 'qty'
    ? `<label class="qty">量 <input type="number" min="1" max="${o.form.max}" value="${o.form.value}" data-qty="${esc(key)}" inputmode="numeric"> ${esc(RESOURCES[o.form.resource] ?? '')}</label>` : '';
  const disabled = o.enabled === false;
  return `<li class="${o.wait ? 'wait' : ''}${disabled ? ' off' : ''}">
    <button type="button" data-ui="opt" data-key="${esc(key)}"${disabled ? ' disabled' : ''}>${esc(o.label)}</button>${form}
    <p class="conseq">${disabled ? `<b>選べない：</b>${esc(o.reason ?? '')}` : esc(o.consequence ?? '')}</p></li>`;
}

function renderMine(w) {
  const me = ui.me;
  const st = w.stock[me];
  const totals = pledgeTotals(w, me);
  const facilities = Object.values(w.facilities).filter(f => f.owner === me);
  const b = BENEFITS[me];
  $('#mine').innerHTML = `<table class="stock"><thead><tr><th>資源</th><th>村にある</th><th>申し出の残り</th></tr></thead><tbody>
    ${Object.keys(RESOURCES).map(r => `<tr${(totals[r] ?? 0) > (st[r] ?? 0) ? ' class="over"' : ''}><td>${esc(RESOURCES[r])}</td><td>${st[r] ?? 0}</td><td>${totals[r] ?? 0}${(totals[r] ?? 0) > (st[r] ?? 0) ? ' <small>手元を超えている</small>' : ''}</td></tr>`).join('')}
    <tr><td>予備の兵</td><td>${w.reserve[me]}</td><td></td></tr></tbody></table>
    <p class="small">施設：${facilities.map(f => `${esc(f.kind)}（${esc(label.place(f.at))}・${esc(f.status)}）`).join('、') || 'なし'}</p>
    ${b ? `<div class="stand"><p><b>協力すると：</b>${esc(b.join)}</p><p><b>自給を選ぶと：</b>${esc(b.alone)}</p></div>` : ''}`;
}

function renderOthers(w) {
  $('#others').innerHTML = `<ul class="others">${Object.values(w.members).filter(m => m.id !== ui.me).map(m => {
    const n = m.playable ? decisionsFor(w, m.id).length : null;
    return `<li><b>${esc(m.name)}</b> ${!m.present ? '<span class="pill warn">不在</span>' : m.playable && seemsAbsent(w, m.id) ? '<span class="pill">しばらく動いていない</span>' : ''}
      <small>${esc(m.note)}${n != null ? `・判断 ${n} 件` : '・台本で動く'}</small></li>`;
  }).join('')}</ul>`;
}

function renderLog(w) {
  $('#log').innerHTML = w.log.slice().reverse().slice(0, 80).map(l => `<li class="k-${esc(l.kind)}"><span class="t">T${l.turn}</span> ${esc(l.text)}</li>`).join('');
}

// ------------------------------------------------------------------ 入力

function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toast.tid);
  toast.tid = setTimeout(() => { t.className = 'toast'; }, 3200);
}

function fillEvents() {
  $('#event').innerHTML = Object.entries(EVENTS).map(([k, e]) => `<option value="${k}" title="${esc(e.fact)}">${esc(e.title)}：${esc(e.detail)}</option>`).join('');
}

document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-ui]');
  if (!b) return;
  const w = ui.world;
  const kind = b.dataset.ui;
  if (kind === 'me') { ui.me = b.dataset.id; render(); return; }
  if (kind === 'advance') { advance(w, Number(b.dataset.n)); render(); toast(`ターン${w.turn}になった`); return; }
  if (kind === 'reset') { ui.world = createWorld($('#preset').value); render(); toast('やり直した'); return; }
  if (kind === 'inject') {
    const k = $('#event').value;
    const r = inject(w, k, {});
    render();
    toast(r.ok ? `出来事：${EVENTS[k].title}（${EVENTS[k].fact}）` : r.error, !r.ok);
    return;
  }
  if (kind === 'opt') {
    const key = b.dataset.key;
    const o = ui.options.get(key);
    const over = {};
    const q = document.querySelector(`[data-qty="${CSS.escape(key)}"]`);
    if (q) over.qty = Number(q.value);
    if (q && o.args && 'cap' in o.args) over.cap = Number(q.value);
    const r = perform(w, ui.me, o, over);
    render();
    toast(r.ok ? (r.waited ? `待つ：${o.consequence}` : `${o.label}`) : r.error, !r.ok);
  }
});

fillEvents();
render();
// テストと手で試すための入口（本番の画面には置かない）
window.__table = ui;
