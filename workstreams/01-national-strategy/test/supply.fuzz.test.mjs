// 国際供給網の試作を乱数で動かし、数え方と権限の約束が崩れないかを見る。面白さの証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupplyWorld, supplyDecisions, performSupply, advanceSupply, injectSupply, credits, SUPPLY_EVENTS } from '../prototype/supply.mjs';

const PEOPLE = ['nagi', 'tou', 'rin', 'sena', 'kai'];
const EVENTS = Object.keys(SUPPLY_EVENTS);
const rng = seed => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); };

for (const seed of Array.from({ length: 20 }, (_, i) => i + 1)) {
  test(`供給網の乱数の流れ（seed ${seed}）`, () => {
    const rand = rng(seed);
    const w = createSupplyWorld();
    for (let i = 0; i < 300; i++) {
      const r = rand();
      if (r < 0.06) injectSupply(w, EVENTS[Math.floor(rand() * EVENTS.length)]);
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
          assert.ok(p.credit <= p.used && p.credit <= p.net, 'クレジットが「使った量」か「正味の受け取り」を超えた');
        }
      }
      assert.equal(Object.values(w.marches).length, 0, '軍が動いた');
    }
  });
}
