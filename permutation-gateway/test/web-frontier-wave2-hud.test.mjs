// Wave 2 of the presentation redesign, the HUD's part (UX design section 11, items 9 to 12): the title as an opaque
// scene whose button says where it leads; the materials drawn by code; the rectangles of the HUD the map keeps out
// of; the guide's objective as data (the one "next thing"); the pages' plaques.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as title from '../../permutation-server/web/frontier/intro/title.mjs';
import * as scene from '../../permutation-server/web/frontier/intro/scene.mjs';
import { TOWER } from '../../permutation-server/web/frontier/map/belltower.mjs';
import * as tex from '../../permutation-server/web/frontier/hud/textures.mjs';
import { noGoRects, NO_GO } from '../../permutation-server/web/frontier/hud/insets.mjs';
import { drawerOf } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import * as card from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { FLAG } from '../../permutation-server/web/frontier/onboarding.mjs';
import { stamp } from '../../permutation-server/web/frontier/screens/parts.mjs';
import { ICONS } from '../../permutation-server/web/frontier/hud/icons.mjs';
import { QUOTA_LOW, restMarkup } from '../../permutation-server/web/frontier/app.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const flat = x => [x].flat(Infinity).map(String).join('');
const text = x => flat(x).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ');
const JP = /[぀-ヿ㐀-鿿]/;

// Rewritten with the fix pass on the second review ("an emblem page, not a game title"): the scene's picture is drawn
// into a canvas (intro/scene.mjs: the bell's tower on the chart at dusk, the six standards round it); the emblem and
// the SVG backdrop are gone; the three lines are one sentence; the tagline's ornaments are elements pinned to its box.
test('the title: an opaque scene of its own (the bell\'s tower and the six standards as a picture, the six leaders, one line and one sentence); its button says where it leads; nothing of the game is in it', () => {
  setLang('ja');
  // the call to action follows the stage (UX design 7.1)
  assert.equal(title.ctaText('play', null), '辺境へ入る', 'before the viewer is known');
  assert.equal(title.ctaText('play', 'none'), '国を選ぶ');
  assert.equal(title.ctaText('play', 'final'), '村へ戻る');
  assert.equal(title.ctaText('play', 'provisional'), '村へ戻る');
  for (const st of ['joined', 'ticket', 'refugee']) assert.equal(title.ctaText('play', st), '辺境へ戻る', st);
  assert.equal(title.ctaText('spectate', 'final'), '観戦をはじめる');
  assert.equal(title.ctaText('practice'), '練習をはじめる');
  const out = flat(title.render({ mode: 'play', live: title.liveLine({ seasonId: 1, bell: 42, holdings: 44 }), stage: 'none' }));
  assert.match(out, /^<canvas class="intro-scene" aria-hidden="true"><\/canvas><div class="intro-veil" aria-hidden="true"><\/div>/, 'the picture, then the veil the words stand on');
  assert.match(out, /<h2 class="intro-title" id="intro-title" data-name>Wylls<\/h2>/);
  assert.equal((out.match(/<li class="intro-leader intro-leader-\d">/g) ?? []).length, 6, 'the six leaders');
  assert.equal((out.match(/<p class="intro-lore">/g) ?? []).length, 1, 'one sentence of what the game is');
  assert.match(out, /<p class="intro-tagline"><span class="intro-orn" aria-hidden="true"><\/span><span class="intro-tag"><span class="nowrap">六つの国。<\/span><wbr><span class="nowrap">十分ごとの鐘。<\/span><wbr><span class="nowrap">封じられた進軍。<\/span><wbr><\/span><span class="intro-orn intro-orn-r" aria-hidden="true"><\/span><\/p>/, 'the line breaks between its sentences only, its ornaments are pinned to it');
  assert.match(out, /<button type="button" class="btn primary intro-go" data-act="intro-close">国を選ぶ<svg/);
  assert.equal((out.match(/<button/g) ?? []).length, 1, 'one button');
  assert.doesNotMatch(out, /banner-pick|data-act="pick-faction"|data-tab=|data-map=|class="lens/, 'nothing of the nation choice, the dock or the map buttons');
  assert.doesNotMatch(out, /\sstyle=|<style|<script|https?:\/\/(?!www\.w3\.org)/, 'no inline style, no remote asset');
  // the numbered reference is a turn; nothing claims secrecy
  assert.equal(title.liveLine({ seasonId: 1, bell: 1034, holdings: 1055 }), '第1季 · ターン 1,034 · 1,055 の村 · 6 つの国');
  assert.doesNotMatch(text(out), /誰にもわからない|秘密|第\d+鐘|知るのは送った者だけ/);
  assert.match(text(out), /十分ごとに鐘が鳴り、封をして送り出した進軍がいっせいに着いて、同じ州の軍勢とぶつかる。/);
  assert.deepEqual(title.sentences('Six nations. A bell every ten minutes. Every march sealed.'), ['Six nations. ', 'A bell every ten minutes. ', 'Every march sealed.']);
  // the picture: the tower's foot in the upper half, the six standards round it inside the picture, far ones first
  for (const [w, h] of [[1440, 900], [390, 844], [2560, 1300]]) {
    const view = scene.titleView(w, h);
    assert.ok(view.footY > h * 0.3 && view.footY < h * 0.5, `${w}: the tower's foot at ${Math.round(view.footY)}`);
    assert.ok(view.tower * TOWER.height < view.footY, `${w}: the tower is whole in the picture`);
    const st = scene.titleStandards(view);
    assert.deepEqual(st.map(s => s.faction).sort(), [0, 1, 2, 3, 4, 5]);
    for (let i = 1; i < st.length; i++) assert.ok(st[i].z <= st[i - 1].z, 'the far ones first');
    for (const s of st) assert.ok(s.x > 20 && s.x < w - 40 && s.y > view.footY - h * 0.2 && s.y < h * 0.66, `${w}: nation ${s.faction}'s standard at ${Math.round(s.x)}, ${Math.round(s.y)}`);
    assert.ok(st.every(s => s.k > 0.3), 'never a speck');
  }
  assert.equal(scene.paintTitleScene(null, 100, 100), null, 'nothing without a canvas');
  // while it stands nothing of the first minute opens behind it (hud/drawer.mjs)
  const fs = { mode: 'play', playReady: true, land: { stage: 'none' }, tab: 'map' };
  assert.equal(drawerOf(fs).kind, 'nation');
  assert.equal(drawerOf({ ...fs, titleUp: true }), null);
  setLang('en');
  const en = text(title.render({ mode: 'play', live: title.liveLine({ seasonId: 1, bell: 42, holdings: 44 }), stage: 'final' }));
  assert.doesNotMatch(en.replace(/Wylls/g, ''), JP, en);
  assert.match(en, /Back to your village/);
  assert.match(en, /Season 1 · Turn 42/);
  assert.equal(title.ctaText('play', 'none'), 'Choose a nation');
  assert.equal(title.ctaText('play', 'ticket'), 'Back to the Frontier');
  assert.equal(title.ctaText('play', null), 'Enter the Frontier');
  setLang('ja');
  // the stylesheet: the scene is opaque and hides the game while it stands
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  assert.match(css, /\.intro \{[^}]*background: #0a0d0c;/, 'a solid ground under the scene');
  assert.match(css, /\.intro-scene \{ position: fixed; inset: 0; display: block; width: 100%; height: 100%; \}/, 'the picture fills the scene');
  assert.match(css, /\.intro-tagline \{ display: grid; grid-template-columns: 64px minmax\(0, max-content\) 64px;/, 'the ornaments stand beside the line\'s own box');
  assert.match(css, /body\[data-title="up"\] :is\(main, main \*, \.tabs, \.strip-l, \.dial,[^)]*\) \{ visibility: hidden !important; \}/);
});

test('the materials drawn by code: seeded, the sheet\'s edge repeats without a seam, nothing without a canvas', () => {
  const a = tex.seeded(7), b = tex.seeded(7), c = tex.seeded(8);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()), 'the same picture on every load');
  assert.notDeepEqual(xs, Array.from({ length: 5 }, () => c()));
  assert.ok(xs.every(x => x >= 0 && x < 1));
  for (const side of [0, 1, 2, 3]) {
    assert.ok(Math.abs(tex.deckleOffset(0, side) - tex.deckleOffset(1, side)) < 1e-9, 'a side meets itself where it repeats');
    for (let t = 0; t <= 1; t += 0.01) { const o = tex.deckleOffset(t, side); assert.ok(o >= 0.6 && o < tex.DECKLE.slice / 2, `the edge stays inside its slice: ${o}`); }
  }
  assert.equal(tex.DECKLE.css * 2, tex.DECKLE.slice, 'drawn at twice the size it is shown');
  assert.deepEqual(tex.TEXTURES, ['--tex-paper', '--tex-deckle', '--tex-cloth', '--tex-metal', '--tex-stamp']);
  assert.deepEqual(tex.mountTextures(undefined), [], 'no document: nothing, and no error');
  assert.deepEqual(tex.mountTextures({ documentElement: { style: { setProperty() {} } }, createElement: () => { throw new Error('no canvas'); } }), [], 'no canvas: the flat colours stand');
  // the stylesheet reads each with a fallback, and the paper's colour is the one the edge is painted in
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  for (const name of tex.TEXTURES) assert.match(css, new RegExp(`var\\(${name}, none\\)`), name);
  assert.match(css, new RegExp(`--paper-sheet: ${tex.PAPER};`));
  assert.match(css, new RegExp(`border-image-slice: ${tex.DECKLE.slice}; border-image-width: ${tex.DECKLE.css}px;`));
});

test('what the map keeps out of: the HUD\'s pieces as client rectangles', () => {
  const rect = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
  const els = {
    '#topbar .strip-l': { r: rect(8, 8, 560, 44) }, '#bell-pill': { r: rect(678, 3, 84, 84) }, '#topbar .strip-r': { r: rect(940, 8, 492, 44) },
    '#search-btn': { r: rect(12, 64, 36, 36) }, '#map-search': { r: rect(54, 64, 262, 36), hidden: true }, '#rail .plate': { r: rect(12, 812, 288, 76) }, 'nav.tabs': { r: rect(530, 826, 380, 62) },
    '#lenses': { r: rect(1244, 670, 184, 34) }, '#minimap-canvas': { r: rect(1260, 720, 168, 168) }, '.map-tools': { r: rect(1206, 718, 38, 170) },
    '#feed': { r: rect(0, 0, 0, 0) }, '#rail .todo-tab': { r: rect(26, 784, 210, 28), hidden: true }, '#panel': { r: rect(1044, 64, 384, 824), dataset: { drawer: 'closed' } },
  };
  const page = { querySelector: sel => (els[sel] ? { getBoundingClientRect: () => els[sel].r, hidden: !!els[sel].hidden, dataset: els[sel].dataset ?? {} } : null),
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', position: 'fixed' }) } };
  const got = noGoRects(page);
  assert.deepEqual(got.map(r => r.id), ['plaque-left', 'dial', 'plaque-right', 'search', 'plate', 'dock', 'lenses', 'minimap', 'map-tools'], 'what is shown, in order; an empty stack, a hidden list and a closed drawer are not there');
  assert.deepEqual(got[1], { id: 'dial', x: 678, y: 3, width: 84, height: 84 });
  els['#panel'].dataset.drawer = 'open';
  assert.deepEqual(noGoRects(page).at(-1), { id: 'drawer', x: 1044, y: 64, width: 384, height: 824 }, 'the open drawer');
  // a phone's sheet is there even when the drawer is closed (it rests at its peek over the map)
  els['#panel'].dataset.drawer = 'closed';
  const phone = { ...page, defaultView: { getComputedStyle: () => ({ display: 'flex', visibility: 'visible', position: 'absolute' }) } };
  assert.equal(noGoRects(phone).at(-1).id, 'drawer');
  assert.deepEqual(noGoRects(undefined), []);
  // (integration of wave 2: a milestone's banner is listed, and each notice of the stack is a piece of its own instead of the column they stand in)
  assert.deepEqual(NO_GO.map(x => x[0]), ['plaque-left', 'dial', 'plaque-right', 'search', 'search-field', 'todo', 'todo-list', 'plate', 'dock', 'lenses', 'minimap', 'map-tools', 'notices', 'banner', 'drawer']);
  const toasts = [rect(1080, 64, 348, 60), rect(1080, 132, 348, 44)];
  const withNotices = { ...page, querySelectorAll: sel => (sel === '#feed > *' ? toasts.map(r => ({ getBoundingClientRect: () => r, hidden: false, dataset: {} })) : []) };
  assert.deepEqual(noGoRects(withNotices).filter(r => r.id === 'notices'), [{ id: 'notices', x: 1080, y: 64, width: 348, height: 60 }, { id: 'notices', x: 1080, y: 132, width: 348, height: 44 }]);
  els['#mile-banner'] = { r: rect(420, 60, 600, 72) };
  assert.deepEqual(noGoRects(page).find(r => r.id === 'banner'), { id: 'banner', x: 420, y: 60, width: 600, height: 72 });
});

test('the guide\'s objective as data: the step, its sentence and its one action; the phone\'s rest shows the plate and the one next thing', () => {
  setLang('ja');
  const base = { mode: 'play', ui: { dismissed: [] }, holdings: [], chain: { now: () => 0 }, marches: [] };
  const welcome = card.objectiveModel({ ...base, land: { stage: 'none' } });
  assert.deepEqual([welcome.id, welcome.n, welcome.total, welcome.go.act, welcome.go.data.flag], ['welcome', 0, 7, 'ob-seen', 'welcome']);
  const seen = { ...base, ui: { dismissed: [FLAG.welcome] } };
  const join = card.objectiveModel({ ...seen, land: { stage: 'none' } });
  assert.deepEqual([join.id, join.go.act, join.go.label], ['join', 'join-open', '国を選ぶ'], 'before joining the step leads to the nation choice');
  assert.equal(card.objectiveModel({ ...seen, land: { stage: 'ticket' }, citizen: { faction: 0 } }).go.label, '様子を見る', 'after joining it shows how the wait stands');
  assert.doesNotMatch(card.objectiveModel({ ...seen, land: { stage: 'ticket' }, citizen: { faction: 0 } }).text, /入植希望|第\d+鐘/);
  assert.equal(card.objectiveModel({ ...base, ui: { dismissed: [], guide: 'warn' } }), null, 'the guide is off');
  assert.equal(card.objectiveModel({ ...base, mode: 'spectate' }), null);
  // the chip is the same data as markup (one action button, the count that opens the steps)
  const chip = String(card.renderObjective({ ...base, land: { stage: 'none' } }));
  assert.match(chip, /data-act="guide-open"[\s\S]*<h3 id="ob-title">ようこそ<\/h3>[\s\S]*<button type="button" class="btn primary small" data-act="ob-seen" data-flag="welcome">わかりました<\/button>/);
  // a viewer without a village: the plate alone carries the one button (no second prompt beside it)
  const rest = flat(restMarkup({ ...base, land: { stage: 'none' }, citizen: null }));
  assert.match(rest, /data-act="join-open">国を選ぶ</);
  assert.doesNotMatch(rest, /next-row|ob-chip/);
  setLang('ja');
});

test('small parts: a state as a stamped word; the relay\'s count shows only when low; the new icons are in the sprite', () => {
  assert.equal(String(stamp('確定した村', 'ok')), '<span class="stamp-word stamp-ok"><span class="stamp-ink">確定した村</span></span>');
  assert.equal(String(stamp('x')), '<span class="stamp-word"><span class="stamp-ink">x</span></span>');
  assert.ok(QUOTA_LOW > 0 && QUOTA_LOW <= 10);
  const sprite = readFileSync(new URL('art/ui/icons.svg', WEB), 'utf8');
  for (const name of ['layers', 'list']) { assert.ok(ICONS.includes(name), name); assert.match(sprite, new RegExp(`<symbol id="${name}" viewBox="0 0 24 24">`)); }
  // the three pages carry the same strip: two plaques around the dial, and the steps button beside the next thing
  for (const page of ['index.html', 'practice.html', 'spectate.html']) {
    const html = readFileSync(new URL(page, WEB), 'utf8');
    // (rewritten with the fix pass on the second review: the dial is a button; it was a div that took no press, and a
    // press on it fell through to the tile under it)
    assert.match(html, /<div class="plaque strip-side strip-l">[\s\S]*<button type="button" class="dial" id="bell-pill" data-act="dial"[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*<\/button>\s*<div class="plaque strip-side strip-r">/, page);
    assert.match(html, /id="attn-pill" data-act="attn" hidden><\/button>\s*<button type="button" class="hud-btn next-steps" id="next-steps" data-act="guide-open" hidden>/, page);
    assert.doesNotMatch(html, /\sstyle=|<style/, page);
  }
});
