// 乱数で選択肢・出来事・ターンを混ぜて、試作の約束が崩れないかを見る。
// これもルールの確認で、面白さの証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, act, advance, inject, decisionsFor, perform, inventory, needProgress, EVENTS } from '../prototype/model.mjs';

const PEOPLE = ['kei', 'mira', 'sota', 'haru'];
const EVENT_KINDS = Object.keys(EVENTS);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 試作の中で物が生まれ消えるのは、工房・建設・訓練だけ。それ以外の量の変化を数える。 */
function totals(w) {
  return Object.fromEntries(['food', 'wood', 'stone', 'ore', 'arms', 'gold'].map(r => [r, inventory(w, r).total]));
}

for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
  test(`乱数の流れ（seed ${seed}）でも約束が崩れない`, () => {
    const rand = rng(seed);
    const w = createWorld(seed % 2 ? 'preparing' : 'start');
    for (let i = 0; i < 400; i++) {
      const r = rand();
      if (r < 0.08) {
        inject(w, EVENT_KINDS[Math.floor(rand() * EVENT_KINDS.length)], {});
      } else if (r < 0.3) {
        const marches = Object.values(w.marches).filter(m => m.kind !== 'garrison').length;
        advance(w, 1);
        assert.equal(Object.values(w.marches).filter(m => m.kind !== 'garrison').length, marches, 'ターンを進めて軍が出た');
      } else {
        const me = PEOPLE[Math.floor(rand() * PEOPLE.length)];
        const opts = decisionsFor(w, me).flatMap(d => d.options.map(o => ({ d, o })));
        if (!opts.length) continue;
        const { d, o } = opts[Math.floor(rand() * opts.length)];
        if (o.enabled === false) {
          assert.ok(o.reason, `選べない理由がない：${d.title} / ${o.label}`);
          if (o.act) {
            // 閉じた選択肢を無理に実行しても、失敗なら世界は変わらない
            const before = JSON.stringify(w);
            const forced = act(w, me, o.act, o.args ?? {});
            if (!forced.ok) assert.equal(JSON.stringify(w), before, `失敗した ${o.act} が世界を変えた`);
          }
          continue;
        }
        const before = JSON.stringify(w);
        const t0 = totals(w);
        const res = perform(w, me, o);
        assert.ok(res.ok, `押せるのに失敗した：${me} ${d.title} / ${o.label}：${res.error}`);
        assert.ok(o.wait || o.consequence, `結果の説明がない：${o.label}`);
        if (o.wait) assert.equal(JSON.stringify(w), before, '待つで世界が変わった');
        // 発送・依頼・申し出・投票などは物の総量を変えない
        if (['pledge', 'dispatch', 'withdraw', 'request', 'answer', 'vote', 'cosign', 'amend', 'reconfirm', 'gift', 'returnGift', 'pledgeMore', 'ack', 'takeOver', 'closeGoal', 'decline', 'leaveGoal'].includes(o.act)) {
          assert.deepEqual(totals(w), t0, `${o.act} で物の総量が変わった`);
        }
      }
      // 進み具合の「到着済み」は、到着した荷の量を超えない
      for (const g of Object.values(w.goals)) {
        for (const n of g.needs) {
          if (n.kind !== 'deliver') continue;
          const p = needProgress(w, g.id, n.id);
          const arrived = Object.values(w.shipments).filter(s => s.state === '到着済み' && s.pledge && w.pledges[s.pledge].goal === g.id && w.pledges[s.pledge].need === n.id && s.arrivedOwner !== 'enemy').reduce((a, s) => a + s.qty, 0);
          assert.equal(p.arrived, arrived);
        }
        if (g.status === '成立') assert.ok(g.readyAt != null);
      }
      for (const st of Object.values(w.stock)) for (const v of Object.values(st)) assert.ok(v >= 0, '在庫が負になった');
    }
  });
}
