// The HUD and the decision over each board: one content, three materials (preview.css .pv-dir-A/B/C). Every number
// is the scene's sample (scene.mjs DECISION); the words are the client's own vocabulary (ターン, 封印, 予測, 確定).
import { DECISION } from './scene.mjs';

const top = () => `
  <div class="pv-top">
    <span class="pv-crest"><i class="pv-sig"></i>アステル</span>
    <span class="pv-res"><b>食料</b> 1,220</span><span class="pv-res"><b>木材</b> 815</span><span class="pv-res"><b>鉱石</b> 305</span><span class="pv-res"><b>兵器</b> 48</span>
    <span class="pv-dial"><small>ターン</small><strong>42</strong><small>6:12</small></span>
  </div>`;

function compare() {
  const [a, ...rest] = DECISION.options;
  const row = (o, on) => `<tr class="${on ? 'on' : ''}"><th>${o.verb}<small>${o.title}</small></th><td>ターン ${o.arrive}</td><td>体力 −${o.stamina}</td><td>${o.towerWear}</td><td>${o.forecast ? `${o.forecast.left[0]}〜${o.forecast.left[1]}` : '—'}</td></tr>`;
  return `
  <aside class="pv-card pv-decide">
    <header><span class="pv-kind">長槍兵 600</span><span class="pv-meta">体力 112/120 · 渡しの倉のそば</span></header>
    <p class="pv-where">行き先：<b>弩兵 420</b> のいるマス（ヴェルデの南）</p>
    <table class="pv-cmp"><thead><tr><th>行動</th><th>到着</th><th>費用</th><th>物見櫓</th><th>残る兵（予測）</th></tr></thead>
      <tbody>${row(a, true)}${rest.map(o => row(o, false)).join('')}</tbody></table>
    <section class="pv-forecast"><span class="pv-tag pv-tag-forecast">予測</span>
      <p>12 回の試算で、残る兵 <b>310〜470</b>。勝つ 9 回・退く 3 回。</p>
      <p class="pv-unknown">分からないこと：同じターンに着く封印中の進軍 1（ダンマール、300）。行き先は着くまで誰にも見えません。</p>
    </section>
    <ul class="pv-risk">${a.risk.map(r => `<li>${r}</li>`).join('')}</ul>
    <footer><button type="button" class="pv-seal">封をして出発</button><span class="pv-irrev">送ったら取り消せません · ターン 45 に開きます</span></footer>
  </aside>`;
}

const result = () => `
  <aside class="pv-card pv-result">
    <header><span class="pv-tag pv-tag-done">確定</span><span class="pv-kind">ターン 45 の衝突</span></header>
    <p class="pv-verdict">撃退した</p>
    <table class="pv-cmp pv-vs"><thead><tr><th></th><th>予測（出発時）</th><th>確定（ターン 45）</th></tr></thead>
      <tbody><tr><th>残る兵</th><td>310〜470</td><td><b>388</b></td></tr><tr><th>物見櫓で</th><td>最大 12%</td><td>−8%（48）</td></tr><tr><th>相手</th><td>弩兵 420</td><td>弩兵 420 → 退いた</td></tr><tr><th>封印中の進軍</th><td>不明</td><td>別の州に着いた</td></tr></tbody></table>
    <p class="pv-why">なぜ：突撃は側撃に強く、相手は待機の構え。物見櫓の範囲を 8 分歩いた。</p>
    <footer><button type="button">戦いを再生</button><button type="button">次の一手</button></footer>
  </aside>`;

export function panelHtml(dir, frame) {
  const note = `<p class="pv-sample">見本の場面 · 数値は比較用</p>`;
  if (frame === 'select') return top() + compare() + note;
  if (frame === 'result') return top() + result() + note;
  return top() + `<div class="pv-next">次にすること：<b>隊商がターン 45 に要塞へ着く</b></div>` + note;
}

export const NOTES = `
<h2>読み方</h2>
<p>3 案とも同じ場面（scene.mjs）を描いています。左下にあなたの町ラマール（アステル、赤）、西の丘にオルセン（シンダー、黄）、北東にヴェルデ（ダンマール、紫）。渡しの倉から東の要塞へ、鉱石 30 を積んだ隊商が道を進んでいます。ダンマールの物見櫓が要塞の先を見張り、柵が南の道をふさいでいます。ヴェルデからは封印した進軍が出発しました（行き先は誰にも見えません）。</p>
<p>「選ぶ・比べる」では、長槍兵 600 を選び、3 つの行動を比べています。「結果」では、予測と確定を並べています。数値はすべて比較のための見本です。</p>`;
