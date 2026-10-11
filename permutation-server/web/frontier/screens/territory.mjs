import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { territoryTotals, territoryEnabled } from '../territory.mjs';
import { cardHead } from './parts.mjs';
import { icon } from '../hud/icons.mjs';

export function render(FS) {
  if (!territoryEnabled(FS)) return '';
  const totals = territoryTotals(FS), faction = FS.citizen?.faction;
  return html`<section class="vcard territory-panel" aria-labelledby="territory-title">
    ${cardHead({ id: 'territory-title', ic: 'banner', title: L`領土を広げる` })}
    <p class="territory-count">${Number.isInteger(faction) ? L`${factionName(faction)}の領地：${fmtNum(totals[faction])}マス` : L`国を選び、最初の村から始めましょう。`}</p>
    <p class="muted">${L`確認できた土地の数です。地図で軍勢を選び、移動先のマスを押すと進軍を準備できます。`}</p>
    <ol class="territory-rules">
      <li><strong>${L`資源を振り分ける`}</strong><p>${L`建物で生産を増やすか、食料・鉱石・金を兵の訓練に使うかを選びます。`}</p></li>
      <li><strong>${L`空き地へ進む`}</strong><p>${L`戦う兵を編成して進軍させると、到着したマスを確保します。通り道は領地になりません。`}</p></li>
      <li><strong>${L`ぶつかったら戦う`}</strong><p>${L`敵の軍勢と重なると戦闘になり、勝ってその場に残った軍勢の国が土地を得ます。`}</p></li>
      <li><strong>${L`広げた土地を守る`}</strong><p>${L`軍勢が離れても領地は残ります。守りがない土地は、敵が到着すると奪われます。`}</p></li>
    </ol>
    <p class="muted">${L`最初の村は保護されています。斥候と開拓者は領地を獲得しません。`}</p>
    <div class="actions"><button class="btn" type="button" data-act="tab" data-tab="holding">${icon('hammer')}${L`建設に配分する`}</button><button class="btn primary" type="button" data-act="tab" data-tab="hosts">${icon('sword')}${L`兵力に配分する`}</button></div>
  </section>`;
}
