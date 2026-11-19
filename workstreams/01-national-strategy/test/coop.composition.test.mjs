// 板とゲームの同じ入口（2026-11-17。WRITTEN ONLY, NOT RUN）：composition.mjs の比べ方、画面の結線、板の入口の決まり（board.mjs、変えていない）。
// 鍵・署名・送信・起動・HTTP なし。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAME_PAGE, compositionOf, compositionText } from '../coop/composition.mjs';

const cfg = { season: { programId: 'Prog111', seasonId: '90' }, cluster: 'localnet' };
const season = (o = {}) => ({ v: 1, programId: 'Prog111', cluster: 'localnet', season: '90', ...o });   // herald views.rs の形

test('the same world only when program, Season and network all match', () => {
  assert.equal(compositionOf(season(), cfg).state, 'same');
  assert.equal(compositionOf(season({ season: 90 }), cfg).state, 'same', 'a number Season is the same Season');
  assert.deepEqual(compositionOf(season({ programId: 'Other' }), cfg).differs, ['program']);
  assert.deepEqual(compositionOf(season({ season: '91' }), cfg).differs, ['season']);
  assert.deepEqual(compositionOf(season({ cluster: 'devnet' }), cfg).differs, ['cluster']);
  assert.deepEqual(compositionOf(season({ programId: 'Other', season: '1', cluster: 'devnet' }), cfg).differs, ['program', 'season', 'cluster']);
});

test('what cannot be compared is unknown, never the same', () => {
  for (const j of [null, undefined, 'x', {}, { programId: 'Prog111' }, { season: '90' }, season({ programId: 7 })]) assert.equal(compositionOf(j, cfg).state, 'unknown', JSON.stringify(j));
  assert.equal(compositionOf(season({ cluster: undefined }), cfg).state, 'unknown', 'no network named');
  assert.equal(compositionOf(season(), { season: cfg.season }).state, 'unknown', 'the board names no network');
  assert.equal(compositionOf(season(), null).state, 'unknown');
  assert.equal(compositionOf(season(), { season: { programId: 'Prog111' }, cluster: 'localnet' }).state, 'unknown');
  // a known difference stays different even when the network cannot be compared
  assert.equal(compositionOf(season({ season: '91', cluster: undefined }), cfg).state, 'different');
});

test('the words: same names the world; different says nothing is sent; unknown never says the same', () => {
  assert.match(compositionText(compositionOf(season(), cfg), cfg), /同じ世界（シーズン 90・localnet）/);
  assert.match(compositionText(compositionOf(season({ season: '91' }), cfg), cfg), /別の世界（シーズンが違う：ヘラルドはシーズン 91）。この板から隊商は送らない/);
  const u = compositionText(compositionOf(null, cfg), cfg);
  assert.match(u, /確かめられない/);
  assert.doesNotMatch(u, /同じ世界（/);
  assert.equal(GAME_PAGE, '/frontier/frontier/');
});

// the page and the board (pinned as text)
const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');
const board = readFileSync(new URL('../coop/board.mjs', import.meta.url), 'utf8');
const between = (a, b) => ui.slice(ui.indexOf(a), ui.indexOf(b, ui.indexOf(a)));

test('the page reads the same origin herald world, says it, and links only the same-origin game when the same', () => {
  const r = between('async function readComposition()', '\n}\n');
  assert.match(r, /compositionOf\(await apiRead\('\/h\/season'\), cfg\)/, 'a GET on this origin (the board passes it to its herald)');
  assert.match(r, /catch \(e\) \{ next = \{ state: 'unknown'/, 'a failed read is unknown');
  const s = between('function composeSay()', '\n}\n');
  assert.match(s, /if \(composed\.state === 'same'\) \{/);
  assert.match(s, /a\.href = GAME_PAGE;/, 'a fixed same-origin path, never an address from an answer');
  assert.doesNotMatch(s, /innerHTML/, 'text only');
  assert.match(ui, /\$\('season'\)\.textContent = .*\n  await readComposition\(\);/);
});

test('a different world stops planning and sending from this page, re-read before each send; unknown keeps the old behaviour; nothing else is gated', () => {
  const send = between('async function sendOnce(', '\n}\n');
  assert.ok(send.indexOf("if ((await readComposition()).state === 'different') return say(") < send.indexOf('await planSend('));
  assert.ok(send.indexOf("if (b?.kind === 'unknown') return followSend(q, b.sending);") < send.indexOf('readComposition()'), 'an unknown earlier send is still followed');
  const pv = between('async function previewSource(', '\n}\n');
  assert.ok(pv.indexOf("if (composed.state === 'different') return say(") < pv.indexOf('await planSend('));
  for (const f of ['async function followSend(', 'async function post(']) assert.doesNotMatch(between(f, '\n}\n'), /composed|readComposition/, `${f} not gated`);
  assert.doesNotMatch(ui, /composed\.state !== 'same'/, 'unknown is not turned into a refusal');
});

test('the board is the one origin (board.mjs, unchanged here): /coop/*, its page under /ws01/, everything else to its herald, on loopback', () => {
  // (2026-11-18, B13) the /coop/* answers moved into answerCoop, which createServer asks first (the launcher mounts the same)
  assert.match(board, /if \(url\.pathname === '\/coop\/config'\) return \{ status: 200, body: board\.config\(\) \};/);
  assert.match(board, /const coop = await answerCoop\(board, req, url\);\n\s+if \(coop\) return send\(res, coop\.status, coop\.body\);/);
  assert.match(board, /if \(url\.pathname\.startsWith\('\/ws01\/repo\/'\)\) return serveStatic\(res, url\.pathname\.slice\('\/ws01\/repo\/'\.length\)\);/);
  assert.match(board, /\/\/ ヘラルドへ転送（ゲームの画面と h\/\*\.json）/);
  assert.match(board, /\.listen\(port, '127\.0\.0\.1'/);
  assert.match(board, /const SERVE = \[path\.join\(repo, 'workstreams\/01-national-strategy\/coop'\), path\.join\(repo, 'permutation-server\/web'\)\];/);
  assert.match(board, /ゲーム：http:\/\/127\.0\.0\.1:\$\{port\}\/frontier\/frontier\//, 'the game path the page links to');
});
