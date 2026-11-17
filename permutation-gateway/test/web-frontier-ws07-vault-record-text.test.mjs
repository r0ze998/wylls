// A storehouse's arrival shows the settle record's cargo as the record's numbers, never "最大" (Lane C, 2026-11-17).
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: statusview.mjs, the English
// dictionary and the producer are read as TEXT (importing statusview.mjs loads fi18n.mjs and lang.mjs, the subjects of
// refused tests; the behaviour checks are the corrected cases in web-frontier-ws07-contracts.test.mjs, not run either).
//   V1 the producer: cargo_log is floor(milli / 1000) saturated at u32::MAX (no upper bound of a storehouse's intake)
//   V2 statusview.mjs: atMostText is gone; the vault text says "記録の積荷：" with recordedText, whose all-zero is '0'
//   V3 the English dictionary has the new keys and no longer the "at most" ones; no banned word in them
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const sv = read('../../permutation-server/web/frontier/hud/statusview.mjs');
const en = read('../../permutation-server/web/lang/en-frontier-play.mjs');
const rs = read('../../permutation-frontier/src/proc/caravan.rs');

test('V1 the record is floor(milli / 1000), saturated: no upper bound', () => {
  assert.ok(rs.includes('let u = (v.max(&0) / MILLI).min(u32::MAX as i64) as u32;'));
});

test('V2 the vault arrival shows the record as the record', () => {
  assert.doesNotMatch(sv, /atMostText/);
  assert.ok(sv.includes("export const recordedText = c => c.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(Math.floor(n))}` : null)).filter(Boolean).join(L`・`) || '0';"));
  assert.ok(sv.includes('L`到着しましたが、入った量は確認できません（記録の積荷：${recordedText(x.recorded)}）`'));
  assert.ok(sv.includes('const rec = isCargo(x.recorded) ? recordedText(x.recorded) : null;'));
  assert.ok(sv.includes('L`記録の数は 1 未満を切り捨て、大きすぎる値は上限で止まるため、入った量の上限も記録からは決まりません`'));
  const vault = sv.slice(sv.indexOf("if (x.state === 'settledUnverified') {"), sv.indexOf("if (x.state === 'lost') {"));
  assert.doesNotMatch(vault, /最大/);
});

test('V3 English keys follow; no banned word', () => {
  for (const k of ["'到着しましたが、入った量は確認できません（記録の積荷：{0}）':", "'記録の数は 1 未満を切り捨て、大きすぎる値は上限で止まるため、入った量の上限も記録からは決まりません':"]) assert.ok(en.includes(k), k);
  assert.ok(!en.includes("'{0} 最大 {1}':") && !en.includes("'最大 0':"), 'the at-most keys are gone');
  const lines = en.split('\n').filter(l => l.includes('記録の積荷：{0}') || l.includes('入った量の上限も記録からは決まりません'));
  assert.equal(lines.length, 2);
  for (const l of lines) assert.doesNotMatch(l.split("': ")[1] ?? '', /\b(settle[ds]?|settling|keeper|beacon|seed)\b|at most/i);
});
