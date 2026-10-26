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

// ---------------------------------------------------------------- previews of what the client cannot do yet
// Each says which mark of the design document it stands on, and that it does nothing.
const mark = (status, line) => `<p class="pv-mark"><span class="pv-status">${status}</span>${line}</p>`;

const caravan = () => `
  <aside class="pv-card pv-feature">
    ${mark('規則は【決定済み】【S1 に実装】· 画面は未実装', 'このプレビューのボタンは動きません')}
    <header><span class="pv-kind">隊商を送る</span><span class="pv-meta">渡しの倉 → 東の要塞</span></header>
    <table class="pv-cmp"><tbody>
      <tr><th>積み荷</th><td>鉱石 30 <small>（倉の在庫 120）</small></td></tr>
      <tr><th>着く</th><td>ターン 45 <small>（荷車は進軍の 1.5 倍の時間）</small></td></tr>
      <tr><th>見えるもの</th><td>出発・行き先・道・着く時刻・中身。<b>すべての住人に見えます</b></td></tr>
      <tr><th>危険</th><td>ダンマールの物見櫓の範囲を 1 マス通る（道が決まった時点で最大 30% 削られる）</td></tr>
      <tr><th>守り</th><td>護衛は、行き先を隠した進軍で道の途中に先に送る（相手には見えない）</td></tr>
    </tbody></table>
    <footer><button type="button" class="pv-seal" disabled>送る（財布の署名）</button><button type="button" disabled>護衛を先に送る</button></footer>
  </aside>`;

const raid = () => `
  <aside class="pv-card pv-feature">
    ${mark('規則は【決定済み：J2】【S1 に実装】· 画面は未実装', 'このプレビューのボタンは動きません')}
    <header><span class="pv-kind">隊商を止めた</span><span class="pv-meta">シンダーの隊商 · 木材 80</span></header>
    <p>護衛はいませんでした。どうしますか。<b>あと 6 ターン</b>のうちに選ばないと、荷車はあなたの村へ向かいます。</p>
    <table class="pv-cmp"><thead><tr><th>選ぶ</th><th>どうなるか</th></tr></thead><tbody>
      <tr><th>奪う</th><td>荷車ごとあなたの物になり、<b>見える荷車として</b>あなたの村へ進む。取り返しに来られる</td></tr>
      <tr><th>焼く</th><td>荷を全部なくす。誰の物にもならない</td></tr>
    </tbody></table>
    <footer><button type="button" class="pv-seal" disabled>奪う</button><button type="button" disabled>焼く</button><span class="pv-irrev">選んだら取り消せません</span></footer>
  </aside>`;

const ai = () => `
  <aside class="pv-card pv-feature">
    ${mark('【別ブランチ】agent-wallet · この起点に実装なし · 代理の札は【決定済み：方向】', '状態を混ぜない見せ方の案')}
    <header><span class="pv-kind">あなたの村の代理</span></header>
    <ol class="pv-states">
      <li class="on"><b>委任：チェーン上で有効</b><small>AI の鍵があなたの村として署名できます（期限 8 時間）</small></li>
      <li><b>判断：無料の自動操作で動いています</b><small>有料のモデルは予算切れのため止まっています。停止ではありません（A）</small></li>
      <li><b>任せていること</b><small>守り・荷車の出し入れ・決まりの一時停止。<b>軍を出して攻めることは任せられません</b></small></li>
      <li><b>鍵</b><small>財布の鍵はあなたが持っています。AI の鍵は運営のサーバーが持っています</small></li>
    </ol>
    <footer><button type="button" disabled>AI を止める（委任は残る）</button><button type="button" class="pv-seal" disabled>委任を解除する（財布の署名）</button></footer>
  </aside>`;

const season = () => `
  <aside class="pv-card pv-feature">
    ${mark('【決定済み】世界は続き、戦争だけを 2 週間の戦期で区切る · 実装はまだシーズン制', '')}
    <header><span class="pv-kind">戦期 3 · 残り 4 日 6 時間</span></header>
    <table class="pv-cmp"><thead><tr><th>戦期の終わりに</th><th></th></tr></thead><tbody>
      <tr><th>戻る</th><td>勝敗の砦（中立に戻る）、守備の兵は家へ、戦争の状態</td></tr>
      <tr><th>続く</th><td>村、倉、札、決まり、仕組み、隊商</td></tr>
      <tr><th>配る</th><td>勝敗の砦を持った長さで国へ（配分の数は【未決定】）</td></tr>
    </tbody></table>
  </aside>`;

export const FEATURE_FRAMES = { caravan, raid, ai, season };

export function panelHtml(dir, frame) {
  const note = `<p class="pv-sample">見本の場面 · 数値は比較用</p>`;
  if (FEATURE_FRAMES[frame]) return top() + FEATURE_FRAMES[frame]() + `<p class="pv-sample">プレビュー：本番の画面にはありません</p>`;
  if (frame === 'select') return top() + compare() + note;
  if (frame === 'result') return top() + result() + note;
  return top() + `<div class="pv-next">次にすること：<b>隊商がターン 45 に要塞へ着く</b></div>` + note;
}

export const NOTES = `
<h2>読み方</h2>
<p>3 案とも同じ場面（scene.mjs）を描いています。左下にあなたの町ラマール（アステル、赤）、西の丘にオルセン（シンダー、黄）、北東にヴェルデ（ダンマール、紫）。渡しの倉から東の要塞へ、鉱石 30 を積んだ隊商が道を進んでいます。ダンマールの物見櫓が要塞の先を見張り、柵が南の道をふさいでいます。ヴェルデからは封印した進軍が出発しました（行き先は誰にも見えません）。</p>
<p>「選ぶ・比べる」では、長槍兵 600 を選び、3 つの行動を比べています。「結果」では、予測と確定を並べています。数値はすべて比較のための見本です。</p>`;
