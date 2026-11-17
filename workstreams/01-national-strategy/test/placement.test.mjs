// 初期配置の比較（A・B・C）の模型のテスト。模型が定義どおりに置くかの確認で、
// どの案が面白いかの証拠ではない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  provinces, sextant, seatOf, ring, hexDistance, place, metrics, summary, addLate, remove, tableTravel,
  richness, rotateBy, HEARTLAND_MAX_RING, SITES_PER_PROVINCE,
} from '../prototype/placement.mjs';
import { createWorld, act, advance, needProgress } from '../prototype/model.mjs';

const EVEN = [6, 6, 6, 6, 6, 6];

test('地図の形は S1 と同じ：リングdに6d州、首都は (1,0) を回した州、扇形は回転で入れ替わる', () => {
  const ps = provinces(5);
  assert.equal(ps.length, 1 + 3 * 5 * 6);
  for (let d = 1; d <= 5; d++) assert.equal(ps.filter(p => p.ring === d).length, 6 * d);
  for (let k = 0; k < 6; k++) {
    assert.equal(sextant(seatOf(k)), k, '国 k の首都は第 k 扇形');
    assert.equal(ring(seatOf(k)), 1);
  }
  for (const p of ps.filter(x => x.ring > 0)) assert.equal(sextant(rotateBy(p, 1)), (p.wedge + 1) % 6);
  // 1国の最初の村の土地：リング2に2州、リング3に3州
  assert.equal(ps.filter(p => p.wedge === 0 && p.ring >= 2 && p.ring <= HEARTLAND_MAX_RING).length, 5);
});

test('州の豊かさ（仮）は6か国で同じ形（回転対称）', () => {
  const rich = richness(5, 11);
  for (const p of provinces(5).filter(x => x.ring >= 2)) {
    assert.equal(rich.get(`${p.q},${p.r}`), rich.get(`${rotateBy(p, 1).q},${rotateBy(p, 1).r}`));
  }
});

test('A：全員が自国の扇形のリング2〜3に置かれる（現行の S1 の決まり）', () => {
  const r = place('A', EVEN);
  for (const p of r.placed) {
    assert.ok(p.at);
    assert.equal(sextant(p.at), p.nation);
    assert.ok(ring(p.at) >= 2 && ring(p.at) <= HEARTLAND_MAX_RING);
  }
});

test('本拠の守り：A は全員が自国の本拠の中、B・C は自国の本拠の外にいる人が出る（今の S1 では包囲されうる）', () => {
  assert.equal(summary(place('A', EVEN)).outsideHeartland, 0);
  assert.ok(summary(place('B', EVEN, { groupSize: 3 })).outsideHeartland > 0);
  assert.ok(summary(place('C', EVEN)).outsideHeartland > 0);
});

test('A：各国同じ人数なら、どの数字も国の間の差は0（同じ順で置く）', () => {
  for (const n of [6, 20]) {
    const s = summary(place('A', Array(6).fill(n)));
    for (const [f, v] of Object.entries(s.between)) if (v != null) assert.equal(v, 0, `${n}人：${f}`);
  }
});

test('A：国の人数が自国の土地（5州×12）を超えると、置けない人が出る', () => {
  const r = place('A', [61, 1, 1, 1, 1, 1]);
  assert.equal(r.placed.filter(p => !p.at).length, 61 - 5 * SITES_PER_PROVINCE);
});

test('B：小集団は一つの国だけでできていて、同じ地域に同じ国の小集団は二つ入らない', () => {
  const r = place('B', [12, 12, 12, 12, 12, 12], { groupSize: 3 });
  const bands = new Map();
  for (const p of r.placed) bands.set(p.band, [...(bands.get(p.band) ?? []), p]);
  for (const ms of bands.values()) {
    assert.equal(new Set(ms.map(m => m.nation)).size, 1);
    assert.ok(ms.length >= 2 && ms.length <= 4, `小集団の人数 ${ms.length}`);
  }
  const perRegion = new Map();
  for (const ms of bands.values()) {
    const g = ms[0].group;
    const nations = perRegion.get(g) ?? [];
    assert.ok(!nations.includes(ms[0].nation), '同じ地域に同じ国の小集団が二つ');
    perRegion.set(g, [...nations, ms[0].nation]);
  }
  assert.ok([...perRegion.values()].some(ns => ns.length >= 2), '一つの地域に複数の国が入る');
});

test('B：各国同じ人数なら、中心までの距離と豊かさの国の間の差は0（回転対称に置く）', () => {
  for (const k of [2, 3, 4]) {
    const s = summary(place('B', EVEN, { groupSize: k }));
    assert.equal(s.between.toCenter, 0, `k=${k}`);
    assert.equal(s.between.richness, 0, `k=${k}`);
    assert.equal(s.unplaced, 0);
  }
});

test('B：同国の他の小集団は遠くにいる（小集団の外の同国まで1州以上）。隣には他国がいる', () => {
  const m = metrics(place('B', EVEN, { groupSize: 3 }));
  assert.ok(m.every(x => x.nearestOtherBand >= 1));
  assert.ok(m.every(x => x.otherNear >= 1));
});

test('C：国に関係なく散るので、自国の扇形の外に置かれる人がいて、同国が隣にいない人が出る', () => {
  const r = place('C', EVEN, { seed: 7 });
  const m = metrics(r);
  assert.ok(m.some(x => !x.inOwnWedge));
  assert.ok(summary(r).alone > 0);
});

test('少人数の国（1人）は、B でも一人の小集団になり「隣に同国がいない」と数えられる', () => {
  const r = place('B', [3, 3, 2, 2, 1, 1], { groupSize: 3 });
  const m = metrics(r).filter(x => x.nation === 5);
  assert.equal(m.length, 1);
  assert.equal(m[0].sameNear, 0);
  assert.equal(m[0].nearestSame, null);
});

test('途中参加：すでにいる人は動かない。B では人数の足りない同国の小集団に入るか、新しい小集団になる', () => {
  for (const scheme of ['A', 'B', 'C']) {
    const r = place(scheme, [4, 6, 6, 6, 6, 6], { groupSize: 3 });
    const before = JSON.stringify(r.placed.map(p => [p.id, p.at]));
    const l = addLate(r, 0, 2);
    assert.equal(JSON.stringify(l.placed.filter(p => !p.late).map(p => [p.id, p.at])), before);
    assert.equal(l.placed.filter(p => p.late && p.at).length, 2, scheme);
  }
  // 4人＝3人と1人ではなく4人の小集団にまとまる → 足りない小集団はないので、新しい小集団（同国のいない地域）になる
  const b = addLate(place('B', [4, 6, 6, 6, 6, 6], { groupSize: 3 }), 0, 1);
  const late = b.placed.find(p => p.late);
  assert.ok(!b.placed.some(p => !p.late && p.band === late.band));
  assert.ok(!b.placed.some(p => !p.late && p.nation === 0 && p.group === late.group), '同国のいない地域に入る');
  // 5人＝3人と2人 → 2人の小集団に入る
  const c = addLate(place('B', [5, 6, 6, 6, 6, 6], { groupSize: 3 }), 0, 1);
  const late2 = c.placed.find(p => p.late);
  assert.equal(c.placed.filter(p => !p.late && p.band === late2.band).length, 2);
});

test('離脱：小集団が一人になると、その人は「隣に同国がいない」と数えられる', () => {
  const r = place('B', EVEN, { groupSize: 2 });
  const band = r.placed.find(p => p.nation === 0).band;
  const ms = r.placed.filter(p => p.band === band);
  const after = remove(r, [ms[0].id]);
  const left = metrics(after).find(x => x.id === ms[1].id);
  assert.equal(left.sameNear, 0);
});

test('配置から作った移動ターンで国の卓を開ける。B では遠くの小集団の人からの荷が遅い', () => {
  const ta = tableTravel(place('A', EVEN));
  const tb = tableTravel(place('B', EVEN, { groupSize: 3 }));
  assert.ok(tb.travel['v:haru|site'] > ta.travel['v:haru|site'], 'B のハル（別の小集団）は拠点まで遠い');
  const w = createWorld('preparing', { travel: tb.travel, note: tb.note });
  const r = act(w, 'haru', 'pledge', { goal: 'outpost', need: 'food', qty: 100 });
  advance(w, 3);
  const s = act(w, 'haru', 'dispatch', { pledge: r.pledge, qty: 100 });
  assert.ok(s.ok);
  assert.equal(w.shipments[s.shipment].eta, w.turn + 1 + tb.travel['v:haru|site']);
  assert.ok(needProgress(w, 'outpost', 'food').inTransit >= 100);
});

test('偏りの許容を超えた項目は、許容を決めた項目だけから出る', () => {
  for (const scheme of ['A', 'B', 'C']) {
    for (const seed of [1, 3, 7]) {
      const s = summary(place(scheme, [12, 8, 6, 4, 2, 1], { seed }));
      for (const f of s.over) assert.ok(['toCenter', 'richness', 'otherNear', 'sameNear'].includes(f));
    }
  }
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 2, r: -1 }), 2);
});
