// ⑦ the way back, as source text (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: returnsum.mjs, returnwords.mjs, app.mjs and the English dictionary are read as TEXT, not
// imported (importing returnwords.mjs loads fi18n.mjs and lang.mjs, the subjects of refused tests; the behaviour checks are
// in web-frontier-ws07-away-return.test.mjs, not run either).
//   T1 unread is not "no new records"; undecodable records are told
//   T2 the mark is written and read back before the device's "last used", which is written apart
//   T3 marks and "last used" carry the pinned world; another world's mark is not used
//   T4 the app passes the world and the reader's bad count, and shows a summary that has only bad records
//   T5 English keys for every new Japanese sentence
//   T6 the scope names the world (from setPin's checked season account, never made up); "seen" saves under the world the
//      summary was read in; an auxiliary-only save failure keeps the head with confirmedText's words
//   T7 the queue's hand-off passes only items of the scope of that moment (none without a scope), before the next reading
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
  assert.ok(rw.includes(': s.failed || s.incomplete ? L`まだ記録を読めていないため、確認の位置は進めません`'));
  assert.ok(rw.includes(': s.bad > 0 ? L`読めない記録のほかに、新しく確認する記録はありません` : L`新しく確認する記録はありません`;'));
  assert.ok(rw.includes(': unread ? L`新しい記録があるかどうかは、まだわかりません。` : s.bad > 0 ? L`中身を読めた新しい記録はありません。` : L`新しい記録はありません。`;'), 'a bad-only reading is not "no new records"');
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
  assert.ok(app.includes('read: { after: r.after, complete: r.complete, failed: r.failed, bad: r.bad }'));
  assert.ok(app.includes("if (!s.items.length && !s.gap && !s.failed && !s.bad && s.windowFrom === null && s.mode !== 'markAhead') return;"));
});

test('T5 English keys', () => {
  for (const k of ['新しい記録があるかどうかは、まだわかりません。', '記録の読み込みに失敗しました。', '記録はまだ続きがあります。', '読めない記録が {0} 件ありました。その中身は推測しません。',
    'まだ記録を読めていないため、確認の位置は進めません', '第{0}ターンまでを確認済みにしました（この端末で最後に使ったウォレットの記録だけは保存できませんでした）',
    '中身を読めた新しい記録はありません。', '読めない記録のほかに、新しく確認する記録はありません']) assert.ok(en.includes(`  '${k}':`), k);
});

test('T6 one world from reading to saving; an auxiliary-only failure is shown', () => {
  assert.ok(app.includes("const awayWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"));
  assert.ok(app.includes("return season && wallet && world ? returnRead.awayScope({ herald: `${String(FS.season?.genesisTs ?? '')}|${FS.pin?.gen ?? 0}|${world}`, seasonId: season, wallet }) : null;"), 'no world, no scope');
  assert.ok(app.includes('away: { ok: s.confirm.ok, summary: s, world } },'), 'the head keeps the world it was read in');
  assert.ok(app.includes("if (!x?.away?.summary?.confirm?.ok || x.scope !== awayScopeNow() || !x.away.world || x.away.world !== awayWorld()) return;"));
  assert.ok(app.includes('confirm: x.away.summary.confirm, at: FS.chain?.now?.() ?? 0, world: x.away.world });'));
  assert.ok(app.includes('const keepHead = saved.lastSaved === false;'));
  assert.ok(app.includes('if (keepHead) FS.feed = FS.feed.map(y => (y.id === x.id ? { ...y, text: awayHeadText(y.away.summary, saved), away: { ...y.away, ok: false, saved } } : y));'));
  assert.ok(app.includes('&& !(keepHead && y.id === x.id)).map(y => y.id)]);'), 'the head is not dismissed then');
  assert.doesNotMatch(app, /FS\.pin\.seasonAddress/, 'setPin has no seasonAddress field: never read as one');
});

test('T7 the hand-off passes only the current scope\'s items', () => {
  const body = app.slice(app.indexOf('function awayTake() {'), app.indexOf('function awayTake() {') + 400);
  const now = body.indexOf('const sc = awayScopeNow();');
  const take = body.indexOf('const out = awayQueue.splice(0).filter(x => sc !== null && x.scope === sc);');
  const pump = body.indexOf('awayPump();');
  assert.ok(now > 0 && take > now && pump > take, 'the scope of this moment, then the filtered hand-off, then the next reading');
  assert.doesNotMatch(app, /function awayTake\(\) \{ const out = awayQueue\.splice\(0\); awayPump\(\); return out; \}/, 'the unfiltered hand-off is gone');
  // every item put in the queue carries its scope
  for (const push of [/awayQueue\.push\(\{ id: `away:\$\{sc\}:[^\n]*kind: 'away', scope: sc,/, /\.map\(i => \(\{ \.\.\.awayItem\(i\), scope: sc \}\)\)\);/]) assert.match(app, push);
});
