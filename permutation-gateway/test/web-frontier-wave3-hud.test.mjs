// Wave 3 of the presentation redesign, the HUD's part (UX design section 12, items 3, 5 and 6): no false state at
// load, the phone's order card after a refusal, the wait for the village as one clear state, the last words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { drawerOf, joinOpen, viewerState, viewerKnown } from '../../permutation-server/web/frontier/hud/drawer.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const JP = /[぀-ヿ㐀-鿿]/;

test('no false state at load: the page says what it knows about the viewer, and the HUD waits for the answer', () => {
  // what the page knows (hud/drawer.mjs viewerState)
  assert.equal(viewerState({ mode: 'play' }), 'pending', 'before the first look');
  assert.equal(viewerState({ mode: 'play', wallet: { address: 'W' } }), 'pending', 'while the record is asked for');
  assert.equal(viewerState({ mode: 'play', playReady: true }), 'known', 'nobody to ask about: a visitor without a wallet');
  assert.equal(viewerState({ mode: 'play', playReady: true, wallet: { address: 'W' }, land: { stage: 'none' } }), 'known', 'the record answered: not joined');
  assert.equal(viewerState({ mode: 'play', wallet: { address: 'W' }, land: { stage: 'final' } }), 'known', 'the record answered before the rest of the first refresh');
  assert.equal(viewerState({ mode: 'play', playReady: true, wallet: { address: 'W' }, viewerMissed: true }), 'unreachable', 'asked, and no answer came');
  assert.equal(viewerState({ mode: 'play', playReady: true, wallet: { address: 'W' }, viewerMissed: true, land: { stage: 'joined' } }), 'known', 'a later answer mends it');
  assert.equal(viewerState({ mode: 'play', error: { code: 'X' } }), 'unreachable', 'the season itself did not come');
  assert.equal(viewerState({ mode: 'play', error: { code: 'X' }, record: {} }), 'pending', 'an error beside a season that did come is not this');
  assert.equal(viewerState({ mode: 'spectate' }), 'known');
  assert.equal(viewerState({ mode: 'practice' }), 'known');
  assert.equal(viewerKnown({ mode: 'play' }), false);
  // the join flow never opens on a guess
  assert.equal(joinOpen({ mode: 'play', playReady: true, wallet: { address: 'W' }, viewerMissed: true }), false);
  assert.equal(drawerOf({ mode: 'play', tab: 'map', playReady: true, wallet: { address: 'W' }, viewerMissed: true }), null);
  assert.equal(drawerOf({ mode: 'play', tab: 'map', playReady: true }).kind, 'nation', 'a visitor without a wallet is shown the nations');
  // the plate: one quiet line, no key; then, if no answer came, what to do about it
  const asking = flat(hud.renderPlate({ mode: 'play', citizen: null, holdings: [] }));
  assert.match(asking, /^<div class="plate plate-load" role="status"><span class="plate-spin" aria-hidden="true"><\/span>/);
  assert.equal(text(asking), '記録を読み込んでいます…');
  assert.doesNotMatch(asking, /<button/);
  const missed = flat(hud.renderPlate({ mode: 'play', citizen: null, holdings: [], playReady: true, wallet: { address: 'W' }, viewerMissed: true }));
  assert.match(missed, /記録をまだ読み込めていません/);
  assert.match(missed, /data-act="reload"/);
  assert.doesNotMatch(missed, /join-open|国を選ぶ|加わっていません/, 'never "not joined" on a guess');
  // a village's plate needs no other answer
  assert.doesNotMatch(flat(hud.renderPlate({ mode: 'play', citizen: { faction: 2 }, holdings: [], land: { stage: 'ticket' } })), /plate-load/);
  setLang('en');
  try {
    assert.equal(text(hud.renderPlate({ mode: 'play', citizen: null, holdings: [] })), 'Reading the record…');
    assert.doesNotMatch(text(hud.renderPlate({ mode: 'play', citizen: null, holdings: [], playReady: true, wallet: { address: 'W' }, viewerMissed: true })), JP);
  } finally { setLang('ja'); }
  // the page and the stylesheet: the play page starts as `loading`, and while it is, the dock's tabs, the lenses, the
  // way home and the search are not offered
  assert.match(readFileSync(new URL('index.html', WEB), 'utf8'), /<body data-mode="play" data-drawer="closed" data-stage="loading">/);
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  assert.match(css, /body\[data-stage="loading"\] :is\(\.hud-tl, \.minimap, \.map-tools\) \{ visibility: hidden; \}/);
  assert.match(css, /body\[data-stage="loading"\] \.tabs > \* \{ visibility: hidden; \}/);
  const app = readFileSync(new URL('app.mjs', WEB), 'utf8');
  assert.match(app, /viewerState\(FS\) === 'known' \? FS\.land\?\.stage \?\? 'none' : 'loading'/, 'the stage mark of the page follows the same answer');
});
