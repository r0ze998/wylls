// 初期配置の比較の画面。計算はすべて placement.mjs にあり、ここは表示と入力だけ。

import {
  place, summary, metrics, provinces, addLate, remove, tableTravel, seatOf, TOLERANCE, SCHEMES, NATION_NAMES,
  HEARTLAND_MAX_RING, TURNS_PER_PROVINCE,
} from './placement.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#c1504a', '#2f8f84', '#c28f2c', '#7a5fb0', '#3f78c2', '#b5527f'];   // permutation-server/web/i18n.mjs CIV_COLORS と同じ並び
const FIELD = {
  toCenter: '中心（Concord）までの州の数',
  toSeat: '自国の首都までの州の数',
  nearestSame: 'いちばん近い同国までの州の数',
  nearestOtherBand: '自分の小集団の外の同国まで（B）',
  sameNear: '隣の州までにいる同国の人数',
  otherNear: '隣の州までにいる他国の人数',
  otherNationsNear: '隣の州までにいる他国の数',
  richness: '州の豊かさ（仮、1〜5）',
};

const state = { result: null, events: [], picked: null };

function params() {
  return {
    scheme: $('#scheme').value,
    groupSize: Number($('#group').value),
    sizes: $('#sizes').value.split(',').map(Number),
    seed: Math.max(1, Number($('#seed').value) | 0),
  };
}

function build() {
  const p = params();
  let r = place(p.scheme, p.sizes, { groupSize: p.groupSize, seed: p.seed });
  for (const e of state.events) r = e.kind === 'late' ? addLate(r, 0, 2) : remove(r, [firstOfNation0(r)].filter(Boolean));
  state.result = r;
}

function firstOfNation0(r) {
  return r.placed.filter(p => p.nation === 0 && p.at).sort((a, b) => a.join - b.join)[0]?.id;
}

// ------------------------------------------------------------------ 地図（SVG）

const SIZE = 22;
const px = h => ({ x: SIZE * Math.sqrt(3) * (h.q + h.r / 2), y: SIZE * 1.5 * h.r });
const hexPath = (c, s) => Array.from({ length: 6 }, (_, i) => {
  const a = (Math.PI / 180) * (60 * i - 30);
  return `${(c.x + s * Math.cos(a)).toFixed(1)},${(c.y + s * Math.sin(a)).toFixed(1)}`;
}).join(' ');

function renderMap() {
  const r = state.result;
  const rMax = r.opts.rMax;
  const ps = provinces(rMax);
  const ext = SIZE * Math.sqrt(3) * (rMax + 1);
  const cells = ps.map(p => {
    const c = px(p);
    const fill = p.kind === 'concord' ? 'var(--panel)' : p.wedge != null ? COLORS[p.wedge] : '#888';
    const op = p.kind === 'seat' ? 0.45 : p.ring >= 2 && p.ring <= HEARTLAND_MAX_RING ? 0.22 : 0.08;
    return `<polygon points="${hexPath(c, SIZE - 1)}" fill="${fill}" fill-opacity="${op}" stroke="var(--line)" stroke-width="1"><title>州 (${p.q},${p.r}) リング${p.ring}${p.kind === 'seat' ? '・首都（奪えない）' : p.kind === 'concord' ? '・Concord（中心、拠点は予約済み）' : p.wedge != null ? `・${NATION_NAMES[p.wedge]}の扇形` : ''}</title></polygon>`;
  }).join('');
  // 中心の鐘楼（描画だけの目印）
  const tower = `<g aria-label="中心の鐘楼"><rect x="-4" y="-16" width="8" height="18" fill="var(--ink)" opacity="0.85"/><polygon points="-6,-16 0,-24 6,-16" fill="var(--ink)" opacity="0.85"/></g>`;
  const seats = Array.from({ length: 6 }, (_, k) => { const c = px(seatOf(k)); return `<text x="${c.x}" y="${c.y + 4}" text-anchor="middle" font-size="10" fill="var(--ink)">首都${k}</text>`; }).join('');
  // 村の点：同じ州の中で少しずつずらす
  const byProv = new Map();
  for (const pl of r.placed.filter(p => p.at)) {
    const k = `${pl.at.q},${pl.at.r}`;
    byProv.set(k, [...(byProv.get(k) ?? []), pl]);
  }
  const tt = tableTravel(r);
  const roles = tt ? Object.fromEntries(Object.entries(tt.where).map(([name, w]) => [w.id, name])) : {};
  const ROLE = { kei: 'ケ', mira: 'ミ', sota: 'ソ', haru: 'ハ' };
  const dots = [...byProv.values()].flatMap(list => list.map((pl, i) => {
    const c = px(pl.at);
    const a = (2 * Math.PI * i) / Math.max(1, list.length);
    const rad = list.length > 1 ? SIZE * 0.55 : 0;
    const x = c.x + rad * Math.cos(a), y = c.y + rad * Math.sin(a);
    const on = state.picked === pl.id;
    const role = roles[pl.id];
    return `<g class="dot" data-id="${esc(pl.id)}" tabindex="0" role="button" aria-label="${esc(`${NATION_NAMES[pl.nation]}の村 ${pl.id}`)}">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 6 : 4.2}" fill="${COLORS[pl.nation]}" stroke="${on || role ? 'var(--ink)' : 'none'}" stroke-width="${role ? 1.6 : 1}"${pl.late ? ' stroke-dasharray="2 1"' : ''}/>
      ${role ? `<text x="${(x + 6).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9" fill="var(--ink)">${ROLE[role]}</text>` : ''}</g>`;
  })).join('');
  $('#map').innerHTML = `<svg viewBox="${-ext} ${-ext} ${2 * ext} ${2 * ext}" role="img" aria-label="配置の地図">${cells}${seats}${tower}${dots}</svg>`;
  const unplaced = r.placed.filter(p => !p.at).length;
  $('#legend').innerHTML = `${esc(SCHEMES[r.scheme].title)}。濃い色の州＝首都（リング1）、中くらい＝最初の村を置ける土地（リング2〜${HEARTLAND_MAX_RING}）。点線の丸＝途中参加。ケ・ミ・ソ・ハ＝国の卓の作例に当てはめた国0の4人。${unplaced ? ` <b>置けなかった人：${unplaced}</b>` : ''}`;
}

// ------------------------------------------------------------------ 数字

function renderSummary() {
  const s = summary(state.result);
  const rows = Object.entries(FIELD).map(([f, label]) => {
    const a = s.all[f];
    const tol = TOLERANCE[f];
    const over = s.over.includes(f);
    return `<tr${over ? ' class="over"' : ''}><td>${esc(label)}</td><td>${a.min ?? '—'}</td><td>${a.mean ?? '—'}</td><td>${a.max ?? '—'}</td><td>${s.between[f] ?? '—'}${tol?.between != null ? ` <small>（許容 ${tol.between}）</small>` : ''}${over ? ' <small>許容を超える</small>' : ''}</td></tr>`;
  }).join('');
  $('#summary').innerHTML = `<p class="small">村 ${s.n}・置けなかった人 ${s.unplaced}・隣の州までに同国がいない人 <b>${s.alone}</b>・自国の本拠（包囲されない土地）の外にいる人 <b>${s.outsideHeartland}</b> <small>（今の S1 の守りを受けない）</small></p>
    <div class="tablewrap"><table><thead><tr><th>数字</th><th>最小</th><th>平均</th><th>最大</th><th>国の間の差</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="small">「国の間の差」は、国ごとの平均の最大と最小の差。許容は提案（docs/12 の 12-5）。道のりの近似：1州 ≈ ${TURNS_PER_PROVINCE} ターン［仮］。</p>`;
  $('#nations').innerHTML = `<div class="tablewrap"><table><thead><tr><th>国</th><th>人数</th><th>中心まで</th><th>近い同国まで</th><th>小集団の外の同国まで</th><th>隣の同国</th><th>隣の他国</th><th>豊かさ</th></tr></thead><tbody>
    ${s.perNation.map(x => `<tr><td><span class="sw" style="background:${COLORS[x.nation]}"></span>${esc(NATION_NAMES[x.nation])}</td><td>${x.n}</td><td>${x.toCenter}</td><td>${x.nearestSame ?? '—'}</td><td>${x.nearestOtherBand ?? '—'}</td><td>${x.sameNear}</td><td>${x.otherNear}</td><td>${x.richness}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function renderPick() {
  const m = metrics(state.result).find(x => x.id === state.picked);
  if (!m) { $('#pick').innerHTML = '<p class="empty">地図の点を押すと、その村から見た数字が出る。</p>'; return; }
  $('#pick').innerHTML = `<p><b>${esc(NATION_NAMES[m.nation])}</b> の村 ${esc(m.id)}（参加順 ${m.join}、州 (${m.at.q},${m.at.r})${m.inOwnWedge ? '・自国の扇形' : '・他国の扇形'}）</p>
    <ul class="small">${Object.entries(FIELD).map(([f, l]) => `<li>${esc(l)}：<b>${m[f] ?? '—'}</b></li>`).join('')}
    <li>中心までの行軍の回数（一度に4州まで）：<b>${m.marchesToCenter}</b></li></ul>`;
}

function renderTable() {
  const tt = tableTravel(state.result);
  if (!tt) { $('#table').innerHTML = '<p class="empty">国0に4人以上いないので、作例に当てはめられない。</p>'; return; }
  const p = params();
  const q = new URLSearchParams({ placement: p.scheme, k: String(p.groupSize), sizes: p.sizes.join(','), seed: String(p.seed), ev: state.events.map(e => e.kind).join(',') });
  const rows = [['ケイ→ミラ', 'v:kei|v:mira'], ['ケイ→ソウタ', 'v:kei|v:sota'], ['ソウタ→拠点', 'v:sota|site'], ['ハル→拠点', 'v:haru|site'], ['ミラ→ケイ', 'v:kei|v:mira']];
  $('#table').innerHTML = `<p class="small">${esc(tt.note)}</p>
    <ul class="small">${rows.slice(0, 4).map(([l, k]) => `<li>${esc(l)}：${tt.travel[k] ?? '—'} ターン</li>`).join('')}</ul>
    <p><a class="btnlink" href="index.html?${esc(q.toString())}">この配置の距離で「国境の共同拠点」を試す</a></p>
    <p class="small">卓の作例（ケイ・ミラ・ソウタ・ハル）の移動ターンだけを、この配置の国0の4人の距離に置き換えて開く。持ち物や期限は同じ。</p>`;
}

function render() {
  build();
  renderMap();
  renderSummary();
  renderPick();
  renderTable();
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast show';
  clearTimeout(toast.tid);
  toast.tid = setTimeout(() => { t.className = 'toast'; }, 2400);
}

document.addEventListener('change', e => { if (e.target.closest('#controls')) { state.events = []; state.picked = null; render(); } });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ui]');
  if (b) {
    if (b.dataset.ui === 'late') { state.events.push({ kind: 'late' }); toast('国0に2人が途中参加した（すでにいる人は動かさない）'); }
    if (b.dataset.ui === 'leave') { state.events.push({ kind: 'leave' }); toast('国0の最初の1人が離脱した'); }
    if (b.dataset.ui === 'reset') { state.events = []; state.picked = null; }
    render();
    return;
  }
  const d = e.target.closest('.dot');
  if (d) { state.picked = d.dataset.id; renderMap(); renderPick(); }
});
document.addEventListener('keydown', e => {
  const d = e.target.closest?.('.dot');
  if (d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.picked = d.dataset.id; renderMap(); renderPick(); }
});

render();
window.__placement = state;
