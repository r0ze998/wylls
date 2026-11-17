// Workstream 07: the away summary's way in on a phone (app.mjs renderAwayEntry). A phone shows one notice over the
// map, so the summary waited under this turn's card and only the list under その他 had it; a line under the strip now
// says something is not yet seen and opens it. The screen tests (ws07-s1-page, ws07-s1-pure) press it in Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import enPlay from '../../permutation-server/web/lang/en-frontier-play.mjs';
import { L, setLang } from '../../permutation-server/web/lang.mjs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');

test('the line is drawn with the notices, while a summary of this scope is not confirmed; "seen" takes it away, × does not', () => {
  const feedFn = app.slice(app.indexOf('function renderFeed() {'), app.indexOf('/** How long a notice of how a fight ended'));
  assert.match(feedFn, /renderAwayEntry\(\);\n\}/, 'renderFeed ends by drawing it');
  const entry = app.slice(app.indexOf('function renderAwayEntry()'), app.indexOf('/** What the away reading found'));
  assert.match(entry, /data(set)?\.act = 'away-open'/);
  assert.match(app, /const awayHeadNow = \(\) => \{[^\n]*x\.scope === sc && !awayConfirmed\.has\(x\.id\)/, 'this scope only, until confirmed');
  const seen = app.slice(app.indexOf("'away-seen': d => {"), app.indexOf("'feed-filter'"));
  assert.match(seen, /awayConfirmed\.add\(x\.id\)/);
  assert.ok(seen.indexOf('awayConfirmed.add') > seen.indexOf('if (!saved)'), 'only once the mark is saved');
  const dismiss = app.slice(app.indexOf("'feed-dismiss': d =>"), app.indexOf('\n', app.indexOf("'feed-dismiss': d =>")));
  assert.doesNotMatch(dismiss, /awayConfirmed/, '× does not confirm');
});

test('pressing it opens the list under その他 at the summary, with its "seen" in focus', () => {
  const open = app.slice(app.indexOf("'away-open': () => {"), app.indexOf("'away-seen': d => {"));
  assert.match(open, /HUD_ACTIONS\.tab\(\{ tab: 'more' \}\)/);
  assert.match(open, /FS\.feedFilter = 'all'/);
  assert.match(open, /\.feed-away[\s\S]*\[data-act="away-seen"\][\s\S]*focus/);
});

test('a phone draws the line under the strip and moves the notices down; a wide screen does not draw it', () => {
  assert.match(css, /\.away-entry \{ display: none; \}\n@media \(max-width: 759px\) \{\n  body\[data-away-entry="1"\] \.away-entry:not\(\[hidden\]\) \{ display: inline-flex;/);
  assert.match(css, /body\[data-away-entry="1"\] \.feed \{ top: calc\(var\(--strip\) \+ 34px \+ var\(--target\) \+ 6px\); \}/);
});

test('English words for the line', () => {
  setLang('en');
  try {
    assert.equal(L`留守中の未確認の出来事 ${3} 件`, '3 events while you were away, not yet marked as seen');
    assert.equal(L`留守中の未確認の出来事 ${1} 件`, '1 event while you were away, not yet marked as seen');
  } finally { setLang('ja'); }
  assert.ok(enPlay['留守中の記録に未確認があります'] && enPlay['{0}（押すと要約を開きます）']);
});
