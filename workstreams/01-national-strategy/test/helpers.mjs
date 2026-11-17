// テストで共有する手順。画面と同じ道（decisionsFor → perform）を通る。

import assert from 'node:assert/strict';
import { act, advance, needProgress, readiness, decisionsFor, perform } from '../prototype/model.mjs';

/** 判断の中から、id の頭とラベルの頭で選択肢を探して実行する。見つからなければ失敗させる。 */
export function choose(w, me, idPrefix, labelPrefix, over) {
  const ds = decisionsFor(w, me);
  const d = ds.find(x => x.id.startsWith(idPrefix));
  assert.ok(d, `${me} に「${idPrefix}」の判断がない：${ds.map(x => x.id).join(', ')}`);
  const o = d.options.find(x => x.label.startsWith(labelPrefix));
  assert.ok(o, `${me} の「${d.title}」に「${labelPrefix}」がない：${d.options.map(x => x.label).join(' / ')}`);
  const r = perform(w, me, o, over);
  assert.ok(r.ok, `${me}：${o.label} が失敗：${r.error}`);
  return r;
}

/**
 * ケイ・ミラ・ソウタ（とハルの偵察1回）で、拠点の条件をそろえる。
 * stopWhenReady=true なら、条件がそろった時点（期限の前）で止める。false なら期限の判定まで進める。
 */
export function playToReady(w, { stopWhenReady = false } = {}) {
  // ミラ：残りの兵器を作りながら送る（生産）
  while (needProgress(w, 'outpost', 'arms').inTransit + needProgress(w, 'outpost', 'arms').arrived < 50) {
    const p = Object.values(w.pledges).find(x => x.provider === 'mira' && x.need === 'arms');
    if (w.stock.mira.arms >= p.qty - p.sent) act(w, 'mira', 'dispatch', { pledge: p.id, qty: p.qty - p.sent });
    advance(w, 1);
  }
  // ソウタ：倉が建つのを待ってから、自分の倉へ食料を置く（輸送）
  while (w.facilities[Object.keys(w.facilities).find(k => w.facilities[k].kind === '倉')].status !== '稼働') advance(w, 1);
  choose(w, 'sota', 'send-', '400 を送る');
  // ハル：偵察を一度だけ（短い参加）
  choose(w, 'haru', 'need-outpost-watch', '偵察を一度出す');
  // ケイ：材料が届いたら砦を建て、兵を訓練して置く（軍事）
  while (!decisionsFor(w, 'kei').find(d => d.id.startsWith('build-'))?.options[0].enabled) advance(w, 1);
  choose(w, 'kei', 'build-', '建て始める');
  choose(w, 'kei', 'garrison-', '槍兵');
  while (needProgress(w, 'outpost', 'fort').arrived === 0) advance(w, 1);
  choose(w, 'kei', 'garrison-', '予備の兵');
  choose(w, 'haru', 'watch-', '偵察を出す');
  for (let i = 0; i < 60 && w.goals.outpost.status === '準備中'; i++) {
    if (stopWhenReady && readiness(w, 'outpost').ready) return;
    advance(w, 1);
  }
}
