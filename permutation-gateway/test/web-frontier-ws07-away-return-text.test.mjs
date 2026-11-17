// ⑦ the way back, as source text (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: returnsum.mjs, returnwords.mjs, app.mjs and the English dictionary are read as TEXT, not
// imported (importing returnwords.mjs loads fi18n.mjs and lang.mjs, the subjects of refused tests; the behaviour checks are
// in web-frontier-ws07-away-return.test.mjs, not run either).
//   T1 unread is not "no new records"; undecodable records are told
//   T2 the mark is written and read back before the device's "last used", which is written apart
//   T3 marks and "last used" carry the pinned world; another world's mark is not used
//   T4 the app passes the world and the reader's bad count, and shows a summary that has only bad records
//   T5 English keys for every new Japanese sentence
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const rs = read('../../permutation-server/web/frontier/hud/returnsum.mjs');
const rw = read('../../permutation-server/web/frontier/hud/returnwords.mjs');
const app = read('../../permutation-server/web/frontier/app.mjs');
const en = read('../../permutation-server/web/lang/en-frontier-play.mjs');

test('T1 unread is not "no new records"; bad records are told', () => {
  assert.ok(rw.includes('const unread = !s.read.n && (s.failed || s.incomplete || !!s.gap);'));
  assert.ok(rw.includes(': unread ? L`新しい記録があるかどうかは、まだわかりません。` : L`新しい記録はありません。`;'));
  assert.ok(rw.includes(": s.failed || s.incomplete ? L`まだ記録を読めていないため、確認の位置は進めません` : L`新しく確認する記録はありません`;"));
  assert.ok(rw.includes('const bad = s.bad > 0 ? L`読めない記録が ${fmtNum(s.bad)} 件ありました。その中身は推測しません。` : \'\';'));
  assert.ok(rs.includes('bad: Number.isSafeInteger(read?.bad) && read.bad > 0 ? read.bad : 0,'));
});

test('T2 the mark decides; the "last used" write is apart', () => {
  const body = rs.slice(rs.indexOf('export function confirm('), rs.indexOf('export function itemOf('));
  const mark = body.indexOf('storage.setItem(storeKey(seasonId, wallet), JSON.stringify(m));');
  const back = body.indexOf('const back = loadMarks(storage, seasonId, wallet, world);');
  const last = body.indexOf("try { storage.setItem('ws07-return:last'");
  assert.ok(mark > 0 && back > mark && last > back, 'mark, read back, then "last used"');
  assert.ok(body.includes('return lastSaved ? { marks: back, moved: true } : { marks: back, moved: true, lastSaved: false };'));
  assert.ok(body.includes('if (back && !c.reset && big(back.confirmedSeq) > big(m.confirmedSeq)) return { marks: back, moved: false };'));
});

test('T3 the pinned world in marks and "last used"', () => {
  assert.ok(rs.includes("if (world && typeof m.world === 'string' && m.world !== world) return null;"));
  assert.ok(rs.includes("(world && typeof last.world === 'string' && last.world !== world)) ? 'newSeason'"));
});

test('T4 the app passes the world and the bad count', () => {
  assert.ok(app.includes("const awayWorld = () => (FS.pin ? `${FS.pin.cluster ?? ''}|${FS.pin.programId ?? ''}|${FS.pin.seasonAddress ?? ''}` : null);"));
  assert.ok(app.includes('read: { after: r.after, complete: r.complete, failed: r.failed, bad: r.bad }'));
  assert.ok(app.includes('confirm: x.away.summary.confirm, at: FS.chain?.now?.() ?? 0, world: awayWorld() });'));
  assert.ok(app.includes("if (!s.items.length && !s.gap && !s.failed && !s.bad && s.windowFrom === null && s.mode !== 'markAhead') return;"));
});

test('T5 English keys', () => {
  for (const k of ['新しい記録があるかどうかは、まだわかりません。', '記録の読み込みに失敗しました。', '記録はまだ続きがあります。', '読めない記録が {0} 件ありました。その中身は推測しません。',
    'まだ記録を読めていないため、確認の位置は進めません', '第{0}ターンまでを確認済みにしました（この端末で最後に使ったウォレットの記録だけは保存できませんでした）']) assert.ok(en.includes(`  '${k}':`), k);
});
