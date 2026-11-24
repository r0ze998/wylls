// （2026-11-17 に書いた。2026-11-18 コーディネーターが実行：coop.entry-focus-world.test.mjs と合わせて 17/17 通過）⑦の村カードから来た届け先は、その村の世界（program・シーズン）がこの板のいまの世界と
// 同じときだけ入れる。違う・分からないときは入れずに理由を言う。読み直しの古い答えは新しい表示を上書きしない。
// 画面（coop-ui.mjs）はブラウザで動くので、ここでは文として固定する（ブラウザの試験は鍵の都合で別）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');

test('the entry fills the destination only for this board\'s present world', () => {
  assert.match(ui, /const sameWorld = sameCtx\(\{ programId: qs\.get\('program'\), seasonId: qs\.get\('season'\) \}, cfg\.season\);/);
  assert.match(ui, /if \(to && \/\^-\?\\d\+,-\?\\d\+,\\d\+,\\d\+\$\/\.test\(to\) && sameWorld\) \[\$\('toP'\)\.value/);
  // another world, or a world not named: not filled, and why (the broken-format case keeps its own words)
  assert.match(ui, /入口の村が、どの世界（世界の番号・プログラム）の村か分からないため、届け先に入れていない/);
  assert.match(ui, /入口の村は別の世界（世界の番号 \$\{qs\.get\('season'\)\.slice\(0, 20\)\}）の村のため、届け先に入れていない/);
  assert.match(ui, /入口から渡された届け先（\?to=\$\{to\.slice\(0, 40\)\}）が読めない。届け先の村を入れてください/);
});

test('a refresh answer older than the one shown, or asked for another viewer, is not applied', () => {
  const r = ui.slice(ui.indexOf('async function refresh()'), ui.indexOf('function staleSay('));
  assert.match(r, /const seq = \+\+refreshSeq, viewerAt = signer\?\.address \?\? null;/);
  assert.match(r, /if \(seq <= appliedSeq \|\| \(signer\?\.address \?\? null\) !== viewerAt\) return false;/);
});

// (2026-11-17, read failures; run and passed by the coordinator 2026-11-18) a failed or partial read never shows as success or empty; a view is
// applied whole or not at all; actions use only the snapshot shown for this viewer; POST outcomes are told apart
test('reads: GET fails on anything but a 2xx JSON; the config too', () => {
  const a = ui.slice(ui.indexOf('async function apiRead('), ui.indexOf('const viewShapeOk'));
  assert.match(a, /if \(!r\.ok\) throw new Error\(`HTTP \$\{r\.status\}`\);/);
  assert.match(a, /catch \{ throw new Error\('答えが JSON でない'\); \}/);
  assert.match(ui, /cfg = await apiRead\('\/coop\/config'\);/);
  assert.match(ui, /apiRead\(`\/coop\/view\?\$\{v\}`\)/);
  // the POST of a record reads the status itself (post()); api() stays for the other callers (sendOnce/followSend)
  // (2026-11-18, B13) every path of the board's origin is read under the page's mount (mount.mjs; '' at the root)
  assert.match(ui, /const res = await fetch\(at\('\/coop\/records'\), \{ method: 'POST',/);
  assert.match(ui, /async function api\(path, body\) \{\n\s+const r = await fetch\(at\(path\), body \? \{ method: 'POST'/);
  assert.match(a, /try \{ r = await fetch\(at\(path\)\); \}/);
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
  // (2026-11-18) count the say() sites, not the comment that names the three cases
  assert.equal((p.match(/say\(`署名できない/g) ?? []).length, 1, 'only the signing failure is called that');
});

// (2026-11-17, second tip; run and passed by the coordinator 2026-11-18) the caravan list's read state: unknown is not "none"
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

// (2026-11-17, one request; run and passed by the coordinator 2026-11-18) the board page points at a named request only after checking it
test('a named request: kept only for this world, then checked against the view (present, this world, to the entry\'s village)', () => {
  assert.match(ui, /const entryOk = !!to && \/\^-\?\\d\+,-\?\\d\+,\\d\+,\\d\+\$\/\.test\(to\);/);
  assert.match(ui, /focus = entryOk && sameWorld && typeof reqParam === 'string' && reqParam && reqParam\.length <= 128 \? \{ id: reqParam, to, seen: false \} : null;/);
  assert.match(ui, /入口で選んだ依頼は、入口の村が渡されていないか読めないため開いていません/);
  assert.match(ui, /入口で選んだ依頼は、入口の村がこの板の世界の村だと確かめられないため開いていません/);
  assert.match(ui, /入口で選んだ依頼の名前が読めないため開いていません/);
  const f = ui.slice(ui.indexOf('function applyFocus()'), ui.indexOf('function staleSay('));
  assert.match(f, /const ctxOk = sameCtx\(q\.ctx, cfg\.season\);/);
  assert.match(f, /const toOk = q\.to && \[q\.to\.p, q\.to\.q, q\.to\.site, q\.to\.gen\]\.join\(','\) === focus\.to;/);
  assert.match(f, /この板にありません（消えたか、別の世界の依頼です）。一覧から選び直してください/);
  assert.match(f, /いまの表示にありません（記録が変わったか、別の世界の依頼です）/);
  assert.match(f, /入口の村あての、この板の世界の依頼ではありません/);
  assert.doesNotMatch(f, /post\(|sendFor\(|sendOnce\(|click\(\)/, 'nothing is accepted, signed or sent by pointing at it');
  // checked again on every view that is applied (after a reload too)
  const r = ui.slice(ui.indexOf('async function refresh()'), ui.indexOf('function staleSay('));
  assert.ok(r.indexOf('try { applyFocus(); }') > r.indexOf("readState('');"));
});

// (2026-11-17, correction; run and passed by the coordinator 2026-11-18) the named request is decided apart from the destination's branches:
// the 'another world' warning stays bound to the fill line, so a same-world entry (with or without a request) never warns
test('the destination branches stay one chain; the named request is decided after them, on its own', () => {
  const i = ui.slice(ui.indexOf('const sameWorld = sameCtx('),ui.indexOf('await refresh();\n  setInterval('));
  const fill = i.indexOf("if (to && /^-?\\d+,-?\\d+,\\d+,\\d+$/.test(to) && sameWorld) [$('toP').value");
  const other = i.indexOf("else if (to && /^-?\\d+,-?\\d+,\\d+,\\d+$/.test(to)) {");
  const broken = i.indexOf("} else if (to !== null) {");
  const req = i.indexOf("const reqParam = qs.get('request');");
  assert.ok(fill >= 0 && other > fill && broken > other && req > broken, 'fill → another world → broken, then the request');
  assert.match(i.slice(fill, other + 'else if'.length), /to\.split\(','\);\n  else if/,'the another-world branch follows the fill line directly');
  assert.doesNotMatch(i.slice(0, req), /reqParam|focus/, 'nothing about the request inside the destination chain');
  assert.doesNotMatch(i.slice(req), /entryWarn|toP'\)\.value/, 'the request part neither fills nor warns about the destination');
});

test('the request pointed at is visible: its own style on the board page', () => {
  const page = readFileSync(new URL('../coop/index.html', import.meta.url), 'utf8');
  assert.match(page, /\.req\.focus \{ background: #fff3d6; box-shadow: inset 4px 0 0 var\(--warn\); padding-left: 12px; \}/);
  assert.match(page, /\.req\.focus::before \{ content: '入口で選んだ依頼';/);
  assert.match(ui, /el\.classList\.add\('focus'\);/);
});
