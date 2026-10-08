// The Frontier page's shell pieces: config (same-origin endpoints; the
// ?herald= override only on a loopback page, only to a loopback herald),
// the render scheduler (one pass per task, order kept, a failing renderer
// isolated, a language switch re-renders all), the turn dial's text in
// both languages (UX design section 6: the HUD clock counts turns), the one
// drawer state, the icon sprite, the enum tables and a JA/EN text for every
// program error code of the ABI, and the pages' static markup (landmarks,
// the HUD's hooks, the map's accessible name, no inline script).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../../permutation-server/web/frontier/config.mjs';
import * as fstate from '../../permutation-server/web/frontier/fstate.mjs';
import { chipText, dialParts, dialMarkup, panelMarkup } from '../../permutation-server/web/frontier/app.mjs';
import { drawerOf, closeDrawer, drawerTitle, WIDE, STAGE, LIFTS, DRAWER_ICON } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import { ICONS, icon, RESOURCE_ICON, MAP_TOOL_ICON } from '../../permutation-server/web/frontier/hud/icons.mjs';
import { renderTabs, TAB_ICON } from '../../permutation-server/web/frontier/screens/shell.mjs';
import { hudInsets, freeCentre } from '../../permutation-server/web/frontier/hud/insets.mjs';
import * as fi18n from '../../permutation-server/web/frontier/fi18n.mjs';
import { ERRORS } from '../../permutation-server/web/frontier/abi.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const loc = href => { const u = new URL(href); return { href, origin: u.origin, hostname: u.hostname }; };
const JP = /[぀-ヿ㐀-鿿]/;

test('config: same origin by default; ?herald= only from and to a loopback host', () => {
  assert.deepEqual(config(loc('https://play.example/frontier/'), { body: { dataset: { mode: 'spectate' } } }), { origin: 'https://play.example', herald: 'https://play.example', relay: 'https://play.example/gw', dev: false, mode: 'spectate' });
  assert.equal(config(loc('https://play.example/frontier/?herald=http://127.0.0.1:41040')).herald, 'https://play.example', 'ignored on a public host');
  assert.equal(config(loc('http://127.0.0.1:5000/frontier/?herald=http://127.0.0.1:41040')).herald, 'http://127.0.0.1:41040');
  assert.equal(config(loc('http://127.0.0.1:5000/frontier/?herald=https://evil.example')).herald, 'http://127.0.0.1:5000', 'never a remote herald');
  assert.equal(config(loc('http://localhost:5000/?herald=javascript:alert(1)')).herald, 'http://localhost:5000');
  assert.equal(config(loc('http://localhost:5000/'), { body: { dataset: { mode: 'bogus' } } }).mode, 'play');
});

test('the render scheduler: one pass per task, in order, a failing renderer isolated', async () => {
  const ran = [];
  fstate.registerRenderers([['a', () => ran.push('a')], ['b', () => { ran.push('b'); throw new Error('boom'); }], ['c', s => ran.push(s === fstate.FS ? 'c' : '?')]]);
  const err = console.error; console.error = () => {};
  try {
    fstate.invalidate('c', 'a');
    fstate.invalidate('a');
    await Promise.resolve();
    assert.deepEqual(ran, ['a', 'c']);
    fstate.invalidate('all');
    await Promise.resolve();
    assert.deepEqual(ran, ['a', 'c', 'a', 'b', 'c']);
    setLang('en');
    await Promise.resolve();
    assert.deepEqual(ran.slice(5), ['a', 'b', 'c'], 'a language switch re-renders every part');
  } finally { console.error = err; }
});

// Rewritten with the redesign (UX design section 6, turn wording): the HUD clock reads ターン / Turn
// (it read 鐘 / Bell); the bell stays the thing that tolls and the word of the mechanics copy.
test('the turn dial: one line of text in both languages, cut into the dial\'s three places', () => {
  const run = { bell: 1034, secondsLeft: 372, beforeGenesis: false, ended: false };
  assert.equal(chipText(run), 'ターン 1,034 · 残り 6:12');
  assert.equal(chipText(null), 'ターン —');
  assert.equal(chipText({ bell: null, secondsLeft: 65, beforeGenesis: true }), '開始まで 1:05');
  assert.deepEqual(dialParts(run), { label: 'ターン', num: '1,034', left: '6:12' });
  assert.deepEqual(dialParts({ bell: null, secondsLeft: 65, beforeGenesis: true }), { label: '開始まで', num: '1:05', left: '' });
  const textOf = chip => dialMarkup(chip).map(String).join('').replace(/<[^>]*>/g, '');
  setLang('en');
  assert.equal(chipText(run), 'Turn 1,034 · 6:12 left');
  assert.equal(chipText({ bell: 1008, secondsLeft: 1, ended: true }), 'Turn 1,008 · ended');
  // the dial's markup reads exactly as the one line (the glue between the places is visually hidden, not dropped)
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    for (const chip of [run, null, { bell: null, secondsLeft: 65, beforeGenesis: true }, { bell: 1008, secondsLeft: 1, ended: true }]) assert.equal(textOf(chip), chipText(chip), `${lang}: ${chipText(chip)}`);
    const m = dialMarkup(run).map(String).join('');
    assert.match(m, /<span class="dial-label">(ターン|Turn)<\/span>/);
    assert.match(m, /<span class="dial-num">1,034<\/span>/);
    assert.match(m, /<span class="dial-left">6:12<\/span>/);
  }
});

test('the drawer: one state from the store; closed when nothing is selected or open; "map" closes it', () => {
  const base = { mode: 'play', tab: 'map', land: { stage: 'final' }, playReady: true };
  assert.equal(drawerOf(base), null, 'nothing selected or open: the world has the screen');
  assert.equal(drawerOf({ ...base, selected: { kind: 'tile', p: 2, q: 0, idx: 7 } }).kind, 'inspect');
  assert.equal(drawerOf({ ...base, selected: { kind: 'tile', p: 2, q: 0, idx: 7 }, compose: {} }).kind, 'march', 'an order being composed comes before the selection');
  assert.equal(drawerOf({ ...base, tab: 'holding', selected: { kind: 'province', p: 2, q: 0 } }).kind, 'holding', 'a dock press');
  assert.equal(drawerOf({ ...base, tab: 'more', report: { p: 2, q: 0, bell: 39 } }).kind, 'report');
  assert.equal(drawerOf({ ...base, practice: {} }).kind, 'practice');
  assert.equal(drawerOf({ ...base, guideOpen: true }).kind, 'guide');
  // the first minute opens by itself until a village exists, once the first answer about the viewer is in (UX design section 7;
  // it was one kind, "join"): the six banners while the viewer has not joined, the wait once it has, "join" only to mend something
  assert.equal(drawerOf({ ...base, land: { stage: 'none' } }).kind, 'nation');
  assert.equal(drawerOf({ ...base, land: { stage: 'none' }, wallet: { address: 'W' } }).kind, 'nation');
  const joined = { wallet: { address: 'W' }, session: { publicKey: 'S' } };
  assert.equal(drawerOf({ ...base, ...joined, land: { stage: 'ticket' } }).kind, 'wait');
  assert.equal(drawerOf({ ...base, ...joined, land: { stage: 'joined' } }).kind, 'wait');
  assert.equal(drawerOf({ ...base, ...joined, land: { stage: 'refugee' } }).kind, 'wait');
  assert.equal(drawerOf({ ...base, ...joined, session: null, land: { stage: 'ticket' } }).kind, 'join', 'the in-game key must be made again first');
  assert.equal(drawerOf({ ...base, ...joined, sessionProblem: 'Expired', land: { stage: 'joined' } }).kind, 'join');
  // documents over the map are wide; the nation choice is a stage of its own; everything else is the side drawer
  assert.deepEqual([...WIDE].sort(), ['practice', 'report']);
  assert.deepEqual([...STAGE], ['nation']);
  for (const k of ['nation', 'wait']) assert.ok(LIFTS.has(k) && DRAWER_ICON[k], k);
  assert.equal(drawerOf({ ...base, land: { stage: 'none' }, playReady: false }), null, 'not before the page knows the viewer');
  assert.equal(drawerOf({ ...base, land: { stage: 'provisional' } }), null);
  // closing
  const open = { ...base, tab: 'hosts', selected: { kind: 'province', p: 1, q: 1 }, report: { p: 1, q: 1, bell: 3 }, guideOpen: true };
  assert.equal(drawerOf(closeDrawer(open)), null);
  assert.deepEqual([open.tab, open.selected, open.report, open.guideOpen], ['map', null, null, false]);
  const draft = { ...base, compose: { host: {} }, selected: { kind: 'tile', p: 2, q: 0, idx: 7 } };
  assert.equal(drawerOf(closeDrawer(draft)).kind, 'march', 'a march being composed is an order, not a panel: it stays');
  const visitor = { ...base, land: { stage: 'none' } };
  assert.equal(drawerOf(closeDrawer(visitor)), null, 'the join flow can be put away (the plate opens it again)');
  // the practice and spectator pages: one panel, put away and brought back
  assert.equal(drawerOf({ mode: 'spectate' }).kind, 'spectate');
  assert.equal(drawerOf(closeDrawer({ mode: 'practice' })), null);
  // the closed drawer's content on the game page is the phone sheet's rest: the plate (never a tab screen)
  const rest = panelMarkup({ ...base, citizen: { faction: 0 }, holdings: [], view: { fog: true }, ui: { dismissed: ['onboarding'] } }).flat(Infinity).map(String).join('');
  assert.match(rest, /class="plate/);
  assert.doesNotMatch(rest, /holding-title|bell-title/);
  setLang('en');
  assert.equal(drawerTitle({ kind: 'holding' }), 'Village');
  assert.equal(drawerTitle(null), 'Map');
});

test('what the HUD covers: the strip above, the open drawer at the right, the sheet or the dock below; the free centre', () => {
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const page = ({ panel, position, drawer, dock }) => {
    const els = {
      'frontier-map': { getBoundingClientRect: () => rect(0, 0, 1440, 900) },
      topbar: { getBoundingClientRect: () => rect(0, 0, 1440, 48) },
      panel: { dataset: { drawer }, hidden: false, getBoundingClientRect: () => panel, position },
    };
    const nav = { getBoundingClientRect: () => dock, hidden: false };
    return { getElementById: id => els[id] ?? null, querySelector: () => nav, defaultView: { getComputedStyle: el => ({ position: el.position ?? 'fixed', display: 'block', visibility: el === els.panel && drawer === 'closed' && position !== 'absolute' ? 'hidden' : 'visible' }) } };
  };
  const dock = rect(530, 826, 380, 62);
  assert.deepEqual(hudInsets(page({ panel: rect(1044, 60, 384, 828), drawer: 'closed', dock })), { top: 48, right: 0, bottom: 74, left: 0 });
  assert.deepEqual(hudInsets(page({ panel: rect(1044, 60, 384, 828), drawer: 'open', dock })), { top: 48, right: 396, bottom: 74, left: 0 });
  assert.deepEqual(freeCentre(page({ panel: rect(1044, 60, 384, 828), drawer: 'open', dock })), { x: 522, y: 437, width: 1044, height: 778 });
  // a phone: the sheet is laid over the map's lower part whether the drawer is open or not
  assert.deepEqual(hudInsets(page({ panel: rect(0, 689, 1440, 211), position: 'absolute', drawer: 'closed', dock: rect(0, 900, 1440, 58) })), { top: 48, right: 0, bottom: 211, left: 0 });
  assert.deepEqual(hudInsets(undefined), { top: 0, right: 0, bottom: 0, left: 0 }, 'no page: nothing is covered');
});

test('the dock and the icon sprite: icon-and-label buttons, every icon a symbol of art/ui/icons.svg, no glyph as an icon', () => {
  const sprite = readFileSync(new URL('../../permutation-server/web/frontier/art/ui/icons.svg', import.meta.url), 'utf8');
  const symbols = [...sprite.matchAll(/<symbol id="([\w-]+)" viewBox="0 0 24 24">/g)].map(m => m[1]);
  assert.deepEqual([...symbols].sort(), [...ICONS].sort(), 'hud/icons.mjs lists exactly the sprite\'s symbols (24 px grid)');
  for (const need of ['grain', 'wood', 'stone', 'ore', 'horse', 'bell', 'sword', 'banner', 'scroll', 'compass', 'home', 'eye', 'seal', 'shield', 'scout', 'hammer', 'speaker', 'speaker-off', 'chart', 'plus', 'minus', 'close']) assert.ok(symbols.includes(need), `the brief's icon: ${need}`);
  assert.doesNotMatch(sprite, /\sstyle=|<style|<script/, 'the CSP allows no style attribute and no script');
  assert.equal((sprite.match(/stroke-width="1\.75"/g) ?? []).length, symbols.length, 'one hand: 1.75 px strokes');
  for (const name of [...Object.values(RESOURCE_ICON), ...Object.values(MAP_TOOL_ICON), ...Object.values(TAB_ICON)]) assert.ok(ICONS.includes(name), name);
  assert.equal(String(icon('bell')), '<svg class="ic" aria-hidden="true" focusable="false"><use href="art/ui/icons.svg#bell"/></svg>');
  const dock = renderTabs({ tab: 'map', land: { stage: 'final' } }, 'holding').map(String).join('');
  assert.equal((dock.match(/class="tab"/g) ?? []).length, 5);
  assert.match(dock, /data-act="tab" data-tab="holding" aria-current="page"><svg class="ic"[^>]*><use href="art\/ui\/icons\.svg#home"\/><\/svg><span class="tab-label">村<\/span>/);
  assert.doesNotMatch(renderTabs({ tab: 'map', land: { stage: 'final' } }, 'report').map(String).join(''), /aria-current/, 'a report over a tab leaves no dock button current');
  assert.match(renderTabs({ tab: 'map', land: { stage: 'none' } }, 'map').map(String).join(''), /data-tab="map" aria-current="page"/, 'closed: "Map" is current');
  // the three pages reference the sprite and carry no symbol character as an icon
  for (const page of ['index.html', 'practice.html', 'spectate.html']) {
    const html = readFileSync(new URL(`../../permutation-server/web/frontier/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<use href="art\/ui\/icons\.svg#bell"\/>/, page);
    assert.doesNotMatch(html.replace(/<svg[\s\S]*?<\/svg>/g, ''), /[←-⯿\u{1f300}-\u{1faff}]/u, `${page}: a glyph used as an icon`);
  }
});

test('tables and every program error code have Japanese and English text', () => {
  const names = new Set(ERRORS.map(e => e[1]));
  assert.deepEqual([...names].filter(n => !fi18n.ERROR_NAMES.includes(n)), [], 'every ABI error has a text');
  for (const [code, name] of ERRORS) {
    setLang('ja');
    const ja = fi18n.errorText(code);
    assert.equal(fi18n.errorText(name), ja);
    assert.match(ja, JP, `${name}: Japanese`);
    setLang('en');
    const en = fi18n.errorText(code);
    assert.doesNotMatch(en, JP, `${name}: English`);
    assert.notEqual(en, ja);
  }
  assert.equal(fi18n.errorText(12345), 'Unknown error (12345)');
  setLang('en');
  assert.equal(fi18n.UNITS.Scout, 'Scout');
  assert.equal(fi18n.STANCES.Brace, 'Brace');
  assert.equal(fi18n.DOCTRINE_C(), 'Flame');
  assert.equal(fi18n.factionName(4), 'Ember');
  assert.equal(fi18n.factionName(6), 'Neutral');
  assert.equal(fi18n.RESOURCE_ORDER.map(r => fi18n.RESOURCES[r]).join(','), 'Food,Wood,Stone,Ore,Horses,Gold,Science,Influence');
  for (const code of ['network', 'SealAuditFailed', 'NotQuicknet', 'TestBeaconOffLocalnet', 'Kernel']) assert.doesNotMatch(fi18n.clientText(code), JP, code);
  assert.equal(fi18n.STANCES.Hold, 'Hold', 'the stance, not v9\'s "Idle" (W3-F D9)');
  assert.equal(fi18n.FATES.Bounced, 'Bounced home', 'no "(no loss)": a host that lost the field fought first (W4-E D10)');
  setLang('ja');
  assert.equal(fi18n.STANCES.Hold, '待機の構え');
});

test('the pages: landmarks, the HUD\'s hooks, an accessible map, a module script and no inline code', () => {
  for (const page of ['index.html', 'practice.html', 'spectate.html']) {
    const html = readFileSync(new URL(`../../permutation-server/web/frontier/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<html lang="ja">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
    for (const re of [/<header /, /<main /, /<nav /, /id="bell-chip"/, /id="lang-box"/, /<canvas id="frontier-map" tabindex="0" aria-label="[^"]+"[^>]*aria-describedby="map-summary"/]) assert.match(html, re, `${page}: ${re}`);
    // the hooks the page, the tests and the other tracks hold on to (UX design section 2)
    for (const id of ['bell-pill', 'bell-fill', 'attn-pill', 'quota-chip', 'faction-chip', 'res-strip', 'sound-btn', 'search-btn', 'map-search', 'objective', 'rail', 'minimap', 'lenses', 'panel', 'panel-title', 'panel-body', 'feed', 'bell-toll', 'map-tip', 'intro']) assert.match(html, new RegExp(`id="${id}"`), `${page}: #${id}`);
    assert.match(html, /<nav class="tabs"/, `${page}: nav.tabs`);
    assert.match(html, /<body data-mode="(play|practice|spectate)" data-drawer="closed">/, `${page}: the drawer starts closed`);
    assert.match(html, /data-act="drawer-close"/, `${page}: the drawer's close button`);
    assert.doesNotMatch(html, /\sstyle="/, `${page}: inline style (the CSP allows none)`);
    assert.match(html, /<script type="module" src="app\.mjs"><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${page}: inline script (the CSP allows 'self' only)`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${page}: inline handler`);
    assert.doesNotMatch(html, /https?:\/\//, `${page}: no third-party origin`);
  }
});
