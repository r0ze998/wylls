// 国際供給網の試作を乱数で動かし、数え方と権限の約束が崩れないかを見る。面白さの証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from '../prototype/model.mjs';
import { createSupplyWorld, supplyDecisions, performSupply, advanceSupply, injectSupply, credits, SUPPLY_EVENTS } from '../prototype/supply.mjs';

const PEOPLE = ['nagi', 'tou', 'rin', 'sena', 'kai'];
const EVENTS = Object.keys(SUPPLY_EVENTS);
const rng = seed => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); };

for (const seed of Array.from({ length: 30 }, (_, i) => i + 1)) {
  test(`供給網の乱数の流れ（seed ${seed}）`, () => {
    const rand = rng(seed);
    const w = createSupplyWorld();
    for (let i = 0; i < 300; i++) {
      const r = rand();
      if (r < 0.06) injectSupply(w, EVENTS[Math.floor(rand() * EVENTS.length)]);
      else if (r < 0.14) {
        // 判断の選択肢を通らない、生の行動（でたらめな引数も混ぜる）。失敗なら世界は変わらない
        const me = PEOPLE[Math.floor(rand() * PEOPLE.length)];
        const to = PEOPLE[Math.floor(rand() * PEOPLE.length)];
        const R = ['ore', 'wood', 'stone', 'food', 'arms', 'gold', 'x'];
        const pickR = () => R[Math.floor(rand() * R.length)];
        const q = () => [0, 1, 20, 300, -5, 2.5][Math.floor(rand() * 6)];
        const offers = Object.keys(w.offers);
        const calls = [
          ['offerExchange', { to, give: { res: pickR(), qty: q() }, want: { res: pickR(), qty: q() } }],
          ['answerExchange', { offer: offers[Math.floor(rand() * Math.max(1, offers.length))], accept: rand() < 0.7 }],
          ['withdrawOffer', { offer: offers[Math.floor(rand() * Math.max(1, offers.length))] }],
          ['gift', { to, resource: pickR(), qty: q() }],
          ['tierUp', {}], ['addWorkshop', {}], ['trainPikemen', { n: 100 }],
        ];
        const [k, args] = calls[Math.floor(rand() * calls.length)];
        const before = JSON.stringify(w);
        const res = act(w, me, k, args);
        if (!res.ok) assert.equal(JSON.stringify(w), before, `失敗した ${k} が世界を変えた`);
      }
      else if (r < 0.3) advanceSupply(w, 1);
      else {
        const me = PEOPLE[Math.floor(rand() * PEOPLE.length)];
        const opts = supplyDecisions(w, me).flatMap(d => d.options.map(o => ({ d, o })));
        if (!opts.length) continue;
        const { d, o } = opts[Math.floor(rand() * opts.length)];
        if (o.enabled === false) { assert.ok(o.reason, `理由がない：${d.title} / ${o.label}`); continue; }
        const before = JSON.stringify(w);
        const res = performSupply(w, me, o);
        assert.ok(res.ok, `押せるのに失敗：${me} ${d.title} / ${o.label}：${res.error}`);
        if (o.wait) assert.equal(JSON.stringify(w), before);
      }
      for (const st of Object.values(w.stock)) for (const v of Object.values(st)) assert.ok(v >= 0, '在庫が負');
      for (const c of Object.values(credits(w))) {
        for (const p of Object.values(c.per)) {
          assert.ok(p.credit <= p.used && p.credit <= p.received, 'クレジットが「使った量」か「受け取った量」を超えた');
          assert.ok(p.credit + p.ownUsed === p.used, '使った量＝自分の物＋受け取った物');
        }
      }
      assert.equal(Object.values(w.marches).length, 0, '軍が動いた');
    }
  });
}
