// （2026-11-17、書いただけ・未実行）⑦の村カードから来た届け先は、その村の世界（program・シーズン）がこの板のいまの世界と
// 同じときだけ入れる。違う・分からないときは入れずに理由を言う。読み直しの古い答えは新しい表示を上書きしない。
// 画面（coop-ui.mjs）はブラウザで動くので、ここでは文として固定する（ブラウザの試験は鍵の都合で別）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');

test('the entry fills the destination only for this board\'s present world', () => {
  assert.match(ui, /const sameWorld = qs\.get\('program'\) === cfg\.season\.programId && qs\.get\('season'\) === String\(cfg\.season\.seasonId\);/);
  assert.match(ui, /if \(to && \/\^-\?\\d\+,-\?\\d\+,\\d\+,\\d\+\$\/\.test\(to\) && sameWorld\) \[\$\('toP'\)\.value/);
  // another world, or a world not named: not filled, and why (the broken-format case keeps its own words)
  assert.match(ui, /入口の村が、どの世界（シーズン・プログラム）の村か分からないため、届け先に入れていない/);
  assert.match(ui, /入口の村は別の世界（シーズン \$\{qs\.get\('season'\)\.slice\(0, 20\)\}）の村のため、届け先に入れていない/);
  assert.match(ui, /入口から渡された届け先（\?to=\$\{to\.slice\(0, 40\)\}）が読めない。届け先の村を入れてください/);
});

test('a refresh answer older than the one shown, or asked for another viewer, is not applied', () => {
  const r = ui.slice(ui.indexOf('async function refresh()'), ui.indexOf('function staleSay('));
  assert.match(r, /const seq = \+\+refreshSeq, viewerAt = signer\?\.address \?\? null;/);
  assert.match(r, /if \(seq <= appliedSeq \|\| \(signer\?\.address \?\? null\) !== viewerAt\) return false;/);
});

// (2026-11-17, read failures; WRITTEN ONLY, NOT RUN) a failed or partial read never shows as success or empty; a view is
// applied whole or not at all; actions use only the snapshot shown for this viewer; POST outcomes are told apart
test('reads: GET fails on anything but a 2xx JSON; the config too', () => {
  const a = ui.slice(ui.indexOf('async function apiRead('), ui.indexOf('const viewShapeOk'));
  assert.match(a, /if \(!r\.ok\) throw new Error\(`HTTP \$\{r\.status\}`\);/);
  assert.match(a, /catch \{ throw new Error\('答えが JSON でない'\); \}/);
  assert.match(ui, /cfg = await apiRead\('\/coop\/config'\);/);
  assert.match(ui, /apiRead\(`\/coop\/view\?\$\{v\}`\)/);
  // the POST of a record reads the status itself (post()); api() stays for the other callers (sendOnce/followSend)
  assert.match(ui, /const res = await fetch\('\/coop\/records', \{ method: 'POST',/);
  assert.match(ui, /async function api\(path, body\) \{\n\s+const r = await fetch\(path, body \? \{ method: 'POST'/);
});

test('a view is applied whole: shape checked, five renders or none, the old view and DOM restored on a failure, said as old', () => {
  const r = ui.slice(ui.indexOf('async function refresh()'), ui.indexOf('function staleSay('));
  assert.match(r, /if \(!viewShapeOk\(v2\)\) \{ staleSay\('板の答えの形が違う'\); return false; \}/);
  assert.match(r, /const before = RENDER_TARGETS\.map\(id => \$\(id\)\.querySelector\('\.body'\)\.innerHTML\);/);
  assert.match(r, /\[view, feed\] = \[pv, pf\];\n\s+RENDER_TARGETS\.forEach\(\(id, i\) => \{ \$\(id\)\.querySelector\('\.body'\)\.innerHTML = before\[i\]; \}\);/);
  assert.ok(r.indexOf('appliedSeq = seq; shownFor = viewerAt;') > r.indexOf('renderArrivals();'), 'marked applied only after all five renders');
  assert.match(ui, /RENDER_TARGETS = \['joint', 'nationPanel', 'personal', 'requests', 'arrivals'\]/);
  assert.match(ui, /表示は \$\{shownAt \? shownAt\.toLocaleTimeString\(\) : '前'\} の読み込みのまま（古い）/);
  assert.match(ui, /まだ表示できるものがありません/);
  // the timer does not swallow a failure: refresh never throws and says it
  assert.match(ui, /setInterval\(\(\) => \{ refresh\(\); \}, 4000\);/);
  assert.doesNotMatch(ui, /refresh\(\)\.catch\(\(\) => \{\}\)/);
});

test('actions use only the snapshot shown for this viewer', () => {
  const c = ui.slice(ui.indexOf("document.addEventListener('click'"), ui.indexOf('async function sendFor('));
  assert.match(c, /if \(!view \|\| shownFor !== \(signer\?\.address \?\? null\)\) return say\('表示を読み直しています。/);
  assert.ok(c.indexOf('shownFor !==') < c.indexOf('view.requests.find'), 'checked before the snapshot is used');
});

test('post: signing failed, not known to have reached the board, refused, and accepted are four different answers', () => {
  const p = ui.slice(ui.indexOf('async function post('), ui.indexOf('const myNation'));
  assert.match(p, /catch \(e\) \{ return say\(`署名できない：\$\{e\.message \?\? e\}`, 'bad'\); \}/);
  assert.match(p, /板に届いたか分からない（\$\{e\.message \?\? e\}）。読み直した表示で確かめてください/);
  // only the board's explicit refusal (400 with {ok: false, why}) is "refused"; only 200 with {ok: true} is accepted
  assert.match(p, /if \(status === 200 && body\?\.ok === true\) \{ say\(done, 'ok'\); await refresh\(\); return; \}/);
  assert.match(p, /if \(status === 400 && body\?\.ok === false && typeof body\.why === 'string'\) return say\(`受け付けられなかった：\$\{body\.why\}`, 'bad'\);/);
  assert.match(p, /return say\(`板に届いたか分からない（HTTP \$\{status\}）。読み直した表示で確かめてください`, 'warn'\);/);
  assert.equal((p.match(/受け付けられなかった/g) ?? []).length, 1, 'refused said only for the explicit refusal');
  // after acceptance, a failed re-read is not "cannot sign": refresh says it on its own line
  assert.ok(p.indexOf("say(done, 'ok'); await refresh();") > 0, 'accepted, then a re-read whose failure goes to the read-state line');
  assert.equal((p.match(/署名できない/g) ?? []).length, 1, 'only the signing failure is called that');
});

// (2026-11-17, second tip; WRITTEN ONLY, NOT RUN) the caravan list's read state: unknown is not "none"
test('the herald caravan list: read or not read, applied with the view; not read is said, never as no caravan', () => {
  const r = ui.slice(ui.indexOf('async function refresh()'), ui.indexOf('function staleSay('));
  assert.match(r, /if \(!r\.ok\) return \{ state: 'unread', why: `HTTP \$\{r\.status\}` \};/);
  assert.match(r, /return j && typeof j === 'object' && Array\.isArray\(j\.moving\) \? \{ state: 'ok', data: j \} : \{ state: 'unread', why: '形が違う' \};/);
  assert.doesNotMatch(r, /j\.moving === undefined/, '(third tip) a list without moving is not read: the herald always writes it');
  assert.match(r, /\.catch\(e => \(\{ state: 'unread', why: `届かない（\$\{e\.message \?\? e\}）` \}\)\);/);
  const m = ui.slice(ui.indexOf('function myCaravansTo('), ui.indexOf('function renderRequests('));
  assert.match(m, /if \(feed\?\.state !== 'ok'\) return null;/);
  assert.match(m, /return \(feed\.data\.moving \?\? \[\]\)\.filter\(/);
  assert.match(ui, /cands === null \? `<span class="warn" data-testid="caravans-unknown">隊商の一覧（ヘラルド）を読めないため、この届け先へ向かう自分の隊商があるかは分からない/);
});
