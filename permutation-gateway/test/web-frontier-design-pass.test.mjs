// The instruments pass (2026-11-10): regressions of what the pass changed, without a browser and without a key.
//   - the spectator's panel: put away, it comes back for a place chosen on the map since, stays away for the selection it
//     was put away with, and goes again when the selection is let go; the practice page's and the play page's are as before;
//   - the chronicle's stamp: a record written before the first turn (the log's `u32::MAX`) is said in words in both
//     languages, never printed as a number; a numbered turn reads as before;
//   - the map's search: an empty answer says what the box finds, in both languages;
//   - the recorded world's key has its icon;
//   - the stylesheet: the map's keys stand clear of the lens chips, the nation filter cuts no name and squeezes no mark,
//     a phone's sheet on the spectator's and practice pages is paper at every height, the map's focus is a neatline.
//   - the selection's card on the keep's own tile is named by its keep (and only there: not on another tile, not in a
//     province without a keep, not over a village or a camp, not in the arrival-control sample, not without conquest).
//   - the drawer's scroll (app.mjs `drawerHeadFor`, `renderDrawer`): a new choice made on the map starts the drawer at
//     its head, so that the chosen place's card is in sight; a re-render with the selection already shown, with none,
//     or after a choice made from inside the drawer leaves the reader's place alone.
//   - what a read and a key answer with (2026-11-11): no false state while the season is unread or could not be read
//     (the spectator's standings, the chronicle's line, the banner's words, the season's word); the keyboard is given
//     back where a popover, the search or the dock had left it on nothing; what the recorded world's sheet covers
//     cannot take the focus; a phone's notices stand clear of three rows of map keys.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { drawerOf, closeDrawer } from '../../permutation-server/web/frontier/hud/drawer.mjs';
import { NO_TURN, stampOf, render as renderChronicle } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { renderResults } from '../../permutation-server/web/frontier/hud/search.mjs';
import { ICONS, MAP_TOOL_ICON } from '../../permutation-server/web/frontier/hud/icons.mjs';
import { render as renderInspect } from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { drawerHeadFor, bannerText } from '../../permutation-server/web/frontier/app.mjs';
import { renderRail, renderStandingsList } from '../../permutation-server/web/frontier/hud/hud.mjs';
import { chronicleState, readLine } from '../../permutation-server/web/frontier/screens/chronicle.mjs';

afterEach(() => setLang('ja'));

const flat = x => [x].flat(Infinity).map(String).join('');
const css = readFileSync(new URL('../../permutation-server/web/frontier/frontier.css', import.meta.url), 'utf8');
/** The declarations of the first rule whose selector is exactly `selector`. */
const ruleOf = selector => {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `the stylesheet has a rule for ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};
/** A selection as the map makes one: a new object for every press (app.mjs onSelect). */
const pressed = (p = 4, q = 0, idx = 30) => ({ kind: 'tile', p, q, idx });

test('the spectator\'s panel: open at first; put away it stays away; a place chosen since brings it back', () => {
  const FS = { mode: 'spectate', selected: null };
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' }, 'open when the page opens');
  closeDrawer(FS);
  assert.equal(drawerOf(FS), null, 'put away');
  FS.selected = pressed();
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' }, 'a village or a keep pressed on the map: its card needs the panel');
});

test('the spectator\'s panel: closed over a selection it stays closed for that one; the same tile pressed again opens it', () => {
  const FS = { mode: 'spectate', selected: pressed() };
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' });
  closeDrawer(FS);
  assert.equal(drawerOf(FS), null, 'the close key closes it although the selection stands');
  assert.equal(FS.selected !== null, true, 'the selection itself is kept: the map still rings the place');
  assert.equal(drawerOf(FS), null, 'and it stays closed however often the page renders');
  FS.selected = pressed();   // the same tile, pressed again: a new object
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' }, 'pressing the same tile again brings the panel back');
  closeDrawer(FS);
  FS.selected = pressed(3, 0, 44);
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' }, 'and so does another place');
});

test('the spectator\'s panel: letting the selection go puts it away again; the dock\'s key opens it for good', () => {
  const FS = { mode: 'spectate', selected: null };
  closeDrawer(FS);
  FS.selected = pressed();
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' });
  FS.selected = null;   // Escape on the map (app.mjs)
  assert.equal(drawerOf(FS), null, 'it was open only for the place: with the place let go it is away again');
  FS.drawerShut = false;   // the dock's "Spectate" (app.mjs 'drawer-open')
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' }, 'opened from the dock it stands with no selection');
  FS.selected = pressed();
  assert.deepEqual(drawerOf(FS), { kind: 'spectate' });
});

test('the practice page\'s panel is as it was: put away, a press on the map does not bring it back', () => {
  const FS = { mode: 'practice', selected: null };
  assert.deepEqual(drawerOf(FS), { kind: 'practice' });
  closeDrawer(FS);
  assert.equal(drawerOf(FS), null);
  FS.selected = pressed();
  assert.equal(drawerOf(FS), null, 'the practice sheet says nothing of a selection: it stays away');
  FS.drawerShut = false;
  assert.deepEqual(drawerOf(FS), { kind: 'practice' });
});

test('the play page\'s drawer is as it was: a selection opens the inspector, closing lets the selection go', () => {
  const FS = { mode: 'play', tab: 'map', playReady: true, land: { stage: 'final' }, holdings: [], provinces: new Map(), selected: pressed(), shutAt: null, drawerShut: true };
  assert.deepEqual(drawerOf(FS), { kind: 'inspect' }, 'the spectator\'s marks mean nothing on the play page');
  closeDrawer(FS);
  assert.equal(FS.selected, null);
  assert.equal(drawerOf(FS), null);
  assert.equal(FS.shutAt, null, 'and closing it leaves them alone');
});

test('the chronicle\'s stamp: a turn by its number, a record from before the first turn in words (Japanese and English)', () => {
  assert.equal(NO_TURN, 0xffffffff, 'the log\'s mark: frontier-abi log.rs, `bell u32`, u32::MAX before genesis');
  assert.equal(stampOf(42), 'ターン 42');
  assert.equal(stampOf(1008), 'ターン 1,008');
  assert.equal(stampOf(0), 'ターン 0', 'turn 0 is a turn');
  assert.equal(stampOf(NO_TURN), '最初のターンの前');
  assert.equal(stampOf(String(NO_TURN)), '最初のターンの前', 'also when the record carries it as text');
  setLang('en');
  assert.equal(stampOf(42), 'Turn 42');
  assert.equal(stampOf(1008), 'Turn 1,008');
  assert.equal(stampOf(0), 'Turn 0');
  assert.equal(stampOf(NO_TURN), 'Before the first turn');
});

test('the chronicle: lands opened before the season began stand under that stamp, never under a number', () => {
  const FS = { chronicle: [{ seq: 1, record: { name: 'RING_OPEN', d: 5, bell: NO_TURN } }, { seq: 2, record: { name: 'RING_OPEN', d: 6, bell: 7 } }], isMine: () => false };
  const ja = flat(renderChronicle(FS));
  assert.match(ja, /class="chron-stamp">[\s\S]*?最初のターンの前<\/h4>/);
  assert.match(ja, /class="chron-stamp">[\s\S]*?ターン 7<\/h4>/, 'a numbered turn is stamped as before');
  assert.doesNotMatch(ja, /4,294,967,295|4294967295/);
  setLang('en');
  const en = flat(renderChronicle(FS));
  assert.match(en, /class="chron-stamp">[\s\S]*?Before the first turn<\/h4>/);
  assert.match(en, /class="chron-stamp">[\s\S]*?Turn 7<\/h4>/);
  assert.doesNotMatch(en, /4,294,967,295|4294967295/);
  assert.doesNotMatch(en, /[぀-ヿ㐀-鿿]/, 'no Japanese left in the English chronicle');
});

test('the map\'s search: an empty answer says what the box finds, in both languages; no query, no answer', () => {
  assert.equal(flat(renderResults([], '')), '');
  assert.equal(flat(renderResults([], '   ')), '');
  const ja = flat(renderResults([], 'zzz'));
  assert.match(ja, /<p class="search-none"><strong>見つかりません<\/strong><span class="search-hint">州の座標（例：4,0）、見えている村の国の名前、領主の名前で探せます<\/span><\/p>/);
  setLang('en');
  const en = flat(renderResults([], 'zzz'));
  assert.match(en, /<strong>Nothing found<\/strong>/);
  assert.match(en, /<span class="search-hint">Search by a province&#39;s coordinates \(for example 4,0\), the name of a nation whose village you can see, or a lord&#39;s name<\/span>|<span class="search-hint">Search by a province's coordinates \(for example 4,0\), the name of a nation whose village you can see, or a lord's name<\/span>/);
  assert.doesNotMatch(en, /[぀-ヿ㐀-鿿]/);
  const hits = flat(renderResults([{ kind: 'province', text: 'Province 4,0', p: 4, q: 0 }], '4,0'));
  assert.match(hits, /class="search-hit search-province" data-act="search-go" data-i="0">Province 4,0</, 'results are listed as before');
});

test('the recorded world\'s key carries an icon of the sprite, like the other map keys', () => {
  assert.equal(MAP_TOOL_ICON.wide, 'tome');
  for (const name of Object.values(MAP_TOOL_ICON)) assert.ok(ICONS.includes(name), name);
});

test('the stylesheet: the map\'s keys stand in a grid beside the minimap, clear of the lens chips (wide screens only)', () => {
  const at = css.indexOf('.map-tools { display: grid; grid-template-columns: auto 36px; grid-template-rows: repeat(3, 36px);');
  assert.ok(at > 0);
  const block = css.slice(css.lastIndexOf('@media', at), css.indexOf('\n}\n', at));
  assert.match(block, /^@media \(min-width: 760px\) \{/, 'a phone keeps its own column of keys');
  for (const [key, area] of [['in', '1 / 2'], ['out', '2 / 2'], ['home', '3 / 2'], ['chart', '2 / 1'], ['wide', '3 / 1']]) assert.ok(block.includes(`.map-tools > [data-map="${key}"] { grid-area: ${area}; }`), `${key} at ${area}`);
  assert.ok(block.includes('.map-tools:not(:has([data-map="wide"])) > [data-map="chart"] { grid-area: 3 / 1; }'), 'without the recorded world\'s key the world chart stands at the foot');
  assert.ok(block.includes('body[data-stage="none"] .map-tools > [data-map="in"] { grid-area: 2 / 2; }'), 'without the home key the zoom keys stand at the foot');
  // three rows of 36 px and two gaps of 8: 124 px, under the lens chips' row (the minimap's 168 px and the 16 px above it)
  assert.ok(3 * 36 + 2 * 8 < 168 + 16);
});

test('the stylesheet: the nation filter cuts no name and squeezes no mark (two columns; three for English on a desktop)', () => {
  const seg = ruleOf('.watch .choice-col .seg');
  assert.match(seg, /display: grid; grid-template-columns: auto repeat\(2, minmax\(0, 1fr\)\);/, 'two columns of nations hold the longest name in either language');
  const key = ruleOf('.watch .choice-col .seg-btn');
  assert.doesNotMatch(key, /white-space:\s*nowrap/, 'a name that does not fit breaks: it is never clipped by the row');
  assert.match(key, /overflow-wrap: anywhere/);
  assert.match(key, /min-width: 0/);
  assert.match(ruleOf('.watch .choice-col .seg-btn > .swatch'), /flex: none/, 'the nation\'s mark keeps its size');
  assert.match(css, /@media \(min-width: 760px\) \{\n  :lang\(en\) \.watch \.choice-col \.seg \{ grid-template-columns: auto repeat\(3, minmax\(0, 1fr\)\); \}/, 'three columns only for English, only on a desktop');
  assert.doesNotMatch(css, /:lang\(ja\) \.watch \.choice-col \.seg \{[^}]*repeat\(3/, 'never three columns in Japanese');
  // 「フィヨルダル」 at 14 px with its mark, the gap and the cell's padding, against a phone 360 px wide (the sheet's paper is 316 px, 「すべて」 62)
  assert.ok(6 * 14 + 13 + 6 + 16 <= (316 - 62) / 2);
});

test('the stylesheet: the notifications\' filter fills its rows when it breaks; a row of choices shows the keyboard\'s ring inside its keys', () => {
  assert.match(ruleOf('.seg:has(> [data-act="feed-filter"])'), /display: flex/);
  assert.match(ruleOf('.seg:has(> [data-act="feed-filter"]) > .seg-btn'), /flex: 1 1 auto/);
  assert.match(ruleOf('.seg-btn:focus-visible'), /outline-offset: -3px/, 'the row clips what lies outside it: the ring stands inside the key');
  assert.match(ruleOf('.seg-btn[aria-pressed="true"]:focus-visible'), /outline-color: #fff8e6/, 'a pale ring on the chosen (ink-teal) key');
});

test('the stylesheet: a phone\'s sheet is paper at every height on the spectator\'s and practice pages; the play page\'s rest is metal as before', () => {
  assert.match(css, /body:is\(\[data-mode="spectate"\], \[data-mode="practice"\]\) \.panel\[data-drawer="closed"\] #panel-body \{[^}]*var\(--paper-sheet\)[^}]*color: var\(--ink\); \}/);
  assert.match(css, /\.panel\[data-drawer="closed"\] #panel-body, \.panel\[data-kind="nation"\] #panel-body \{ margin: 0; border: 0; background: none; color: var\(--hud-ink\); \}/, 'the play page\'s resting sheet keeps its bell metal');
  assert.match(css, /:where\(\.panel\[data-drawer="open"\] #panel-body, body:is\(\[data-mode="spectate"\], \[data-mode="practice"\]\) #panel-body\) > \* \+ \* \{ margin-top: 27px; \}/, 'and its passages keep their rules');
});

test('the stylesheet: the map\'s focus is a neatline (a double line), the warning of the turn\'s end stays one solid band', () => {
  assert.match(css, /\n#frontier-map:focus-visible \{ outline: 6px double var\(--brass-hi\); outline-offset: -7px; box-shadow: inset 0 0 0 8px rgba\(8,18,16,\.5\); \}/);
  assert.match(css, /body\[data-urgency="warn"\] main::after \{ box-shadow: inset 0 0 0 3px #d9a23a; \}/);
  assert.match(css, /body\[data-urgency="crit"\] main::after \{ box-shadow: inset 0 0 0 4px #c8412f; \}/);
});

// ---- the selection's card on the keep's own tile (hud/inspect.mjs): named by its keep, in the words the order card
// already uses for a keep (「{国}の砦」 / "{nation}'s keep"); every other tile, a province without a keep, a village or a
// camp on that tile, and the arrival-control sample keep the names they had.
const KEEP_TILE = 31, VILLAGE_TILE = 30;
const TERRAIN = { terrain: Array(61).fill(0), names: ['Grassland'], sites: [VILLAGE_TILE] };
const terrainOf = () => TERRAIN;
const keepRecord = (extra = {}) => ({ p: 4, q: 0, tile: KEEP_TILE, holder: 1, troops: 100, heartland: true, consolidatedUntil: 0, contender: 0, progress: 0, requiredBells: 72, asOfBell: 0, ...extra });
/** A conquest season's store with one province (4,0: a ring-4 province), one site on tile 30 and the keep's record. */
function keepStore({ idx = KEEP_TILE, keep = keepRecord(), village = false, camp = null, sample = null } = {}) {
  const rec = { p: 4, q: 0, owners: [village ? 2 : 255], sites: [village ? 1 : 0] };
  const province = { p: 4, q: 0, sites: [VILLAGE_TILE], entries: [], relations: 0n, siteMirror: [village ? { state: 1, faction: 2, tier: 0, garrison: 0, shieldUntilBell: 0 } : { state: 0 }], ...(camp ? { camp } : {}) };
  return { mode: 'spectate', season: { programVersion: 3, layoutVersion: 2, endBell: 1008, bellSecs: 600, conquestParams: { keepBells: 72 } }, nowBell: 0, citizen: null, holdings: [],
    selected: { kind: 'tile', p: 4, q: 0, idx }, overviews: new Map([[4, { provinces: [rec] }]]), provinces: new Map([['4,0', { province }]]),
    conquest: { status: 'ready', keeps: new Map([['4,0', keep]]), history: new Map(), standings: null, events: [] }, ...(sample ? { sample } : {}) };
}
const cardOf = FS => flat(renderInspect(FS, terrainOf));
const titleOf = markup => /<h3 id="inspect-title">([^<]*)<\/h3>/.exec(markup)?.[1] ?? null;
const markOf = markup => /<header class="c-head"><span class="c-ic"><svg class="ic"[^>]*><use href="art\/ui\/icons\.svg#([a-z-]+)"/.exec(markup)?.[1] ?? null;

test('the selection\'s card on the keep\'s own tile is named by its keep, with the keep\'s mark (Japanese and English)', () => {
  const ja = cardOf(keepStore());
  assert.equal(titleOf(ja), 'ボレアリスの砦');
  assert.equal(markOf(ja), 'flag');
  assert.match(ja, /<span class="c-sub">草原 · /, 'the land it stands on is said under the name, then where it is');
  assert.match(ja, /class="conquest-keep hpanel kp /, 'and the keep\'s own plate stands in the card as before');
  setLang('en');
  const en = cardOf(keepStore());
  assert.match(titleOf(en), /^Borealis(&#39;|')s keep$/);
  assert.equal(markOf(en), 'flag');
  assert.match(en, /<span class="c-sub">Grassland · /);
});

test('the keep\'s tile of a neutral keep is 「この州の砦」 / "Province keep"', () => {
  assert.equal(titleOf(cardOf(keepStore({ keep: keepRecord({ holder: 6 }) }))), 'この州の砦');
  setLang('en');
  assert.equal(titleOf(cardOf(keepStore({ keep: keepRecord({ holder: 6 }) }))), 'Province keep');
});

test('any other tile of the province keeps its own name; so does every tile of a province without a keep (tile 255)', () => {
  const other = cardOf(keepStore({ idx: 32 }));
  assert.equal(titleOf(other), '草原', 'another tile is the land it is');
  assert.equal(markOf(other), 'mountain');
  assert.match(other, /class="conquest-keep hpanel kp /, 'the province\'s keep is still told in its plate');
  const none = cardOf(keepStore({ keep: keepRecord({ tile: 255 }) }));
  assert.equal(titleOf(none), '草原', 'the sentinel names no tile');
  assert.equal(markOf(none), 'mountain');
  assert.match(none, /この州には砦がありません。/);
  const noneAt255 = cardOf(keepStore({ idx: 32, keep: keepRecord({ tile: 255 }) }));
  assert.equal(titleOf(noneAt255), '草原');
  setLang('en');
  assert.equal(titleOf(cardOf(keepStore({ idx: 32 }))), 'Grassland');
  assert.equal(titleOf(cardOf(keepStore({ keep: keepRecord({ tile: 255 }) }))), 'Grassland');
});

test('a village or a camp on the keep\'s tile keeps the card\'s name: the keep does not rename them', () => {
  const village = cardOf(keepStore({ idx: VILLAGE_TILE, village: true, keep: keepRecord({ tile: VILLAGE_TILE }) }));
  assert.doesNotMatch(titleOf(village), /砦/, 'the village is named as a village');
  assert.equal(markOf(village), null, 'and headed by its picture, not by a mark');
  assert.match(village, /<header class="c-head"><span class="c-pic c-pic-vil">/);
  const camp = cardOf(keepStore({ camp: { state: 1, tile: KEEP_TILE, troops: 300 } }));
  assert.doesNotMatch(titleOf(camp), /砦/, 'the camp is named as a camp');
  assert.equal(markOf(camp), 'tent');
  setLang('en');
  assert.doesNotMatch(titleOf(cardOf(keepStore({ camp: { state: 1, tile: KEEP_TILE, troops: 300 } }))), /keep/i);
});

test('the arrival-control sample has no keep panel, and its tiles keep their names', () => {
  const FS = keepStore({ sample: { territory: { mode: 'arrival-control' } } });
  const out = cardOf(FS);
  assert.equal(titleOf(out), '草原');
  assert.equal(markOf(out), 'mountain');
  assert.doesNotMatch(out, /class="conquest-keep/);
  setLang('en');
  assert.equal(titleOf(cardOf(FS)), 'Grassland');
});

test('a season without conquest names no tile by a keep', () => {
  const FS = keepStore(); FS.season = { ...FS.season, programVersion: 2 };
  assert.equal(titleOf(cardOf(FS)), '草原');
  assert.equal(markOf(cardOf(FS)), 'mountain');
});

// ---- the drawer's scroll for a new choice (app.mjs). The scroll's owner is the paper under the bar on a desktop
// (`#panel-body`) and the sheet itself on a phone (`#panel`): measured in the browser on both, and pinned here.
const appSrc = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const SPECTATE = Object.freeze({ kind: 'spectate' }), INSPECT = Object.freeze({ kind: 'inspect' });

test('a new choice starts the drawer at its head: a place, the same tile pressed again, another place (the spectator\'s panel and the play page\'s inspector)', () => {
  const a = pressed();
  for (const d of [SPECTATE, INSPECT]) {
    assert.deepEqual(drawerHeadFor(d, a, null), { selection: a, toHead: true }, `${d.kind}: the first choice`);
    assert.deepEqual(drawerHeadFor(d, a, a), { selection: a, toHead: false }, `${d.kind}: a re-render with the selection it already shows`);
    const again = pressed();   // the same tile pressed again: the map makes a new object (app.mjs onSelect)
    assert.deepEqual({ ...again }, { ...a }); assert.notEqual(again, a);
    assert.deepEqual(drawerHeadFor(d, again, a), { selection: again, toHead: true }, `${d.kind}: the same tile pressed again`);
    const other = pressed(3, 0, 44);
    assert.deepEqual(drawerHeadFor(d, other, again), { selection: other, toHead: true }, `${d.kind}: another place`);
    const province = { kind: 'province', p: 4, q: 0 };   // Enter on the map from afar, a row that goes to a province
    assert.deepEqual(drawerHeadFor(d, province, other), { selection: province, toHead: true }, `${d.kind}: a province`);
  }
});

test('no selection, or a view the selection\'s card does not head: the drawer\'s scroll is never taken', () => {
  const a = pressed();
  assert.deepEqual(drawerHeadFor(SPECTATE, null, null), { selection: null, toHead: false });
  assert.deepEqual(drawerHeadFor(SPECTATE, undefined, null), { selection: null, toHead: false });
  assert.deepEqual(drawerHeadFor(SPECTATE, null, a), { selection: null, toHead: false }, 'the selection let go: nothing to bring into sight');
  assert.deepEqual(drawerHeadFor(null, a, null), { selection: null, toHead: false }, 'a closed drawer');
  // (the dock's screens keep one line of the selection and their own content; an order, a report, the first minute have none)
  for (const kind of ['holding', 'hosts', 'marches', 'more', 'march', 'guide', 'nation', 'wait', 'join', 'home', 'territory', 'practice', 'report'])
    assert.deepEqual(drawerHeadFor({ kind }, a, null), { selection: null, toHead: false }, kind);
});

test('a choice made from inside the drawer keeps the reader\'s place; the next press on the map is a new choice again', () => {
  const a = pressed(), b = { kind: 'province', p: 5, q: 0 };
  assert.deepEqual(drawerHeadFor(SPECTATE, b, a, true), { selection: b, toHead: false }, '「見る」 on a chronicle line: the map goes there, the line stays');
  assert.deepEqual(drawerHeadFor(SPECTATE, b, b, false), { selection: b, toHead: false }, 'and it is the one shown from then on');
  const c = pressed();
  assert.deepEqual(drawerHeadFor(SPECTATE, c, b, false), { selection: c, toHead: true });
  assert.deepEqual(drawerHeadFor(SPECTATE, a, null), drawerHeadFor(SPECTATE, a, null, false), 'outside the drawer is the default');
});

test('the drawer through a sitting, as the page runs it: only a new choice from outside moves the scroll', () => {
  // (renderDrawer's own three lines, on a scroll owner that is a plain object: the same order, the same conditions)
  let shown = null;
  const scroller = { scrollTop: 0 };
  const render = (d, selected, { fromDrawer = false, same = true } = {}) => {
    const head = drawerHeadFor(d, selected, shown, fromDrawer); shown = head.selection;
    if (!same) scroller.scrollTop = 0;
    if (head.toHead && scroller.scrollTop !== 0) scroller.scrollTop = 0;
    return scroller.scrollTop;
  };
  assert.equal(render(SPECTATE, null, { same: false }), 0, 'the panel opens at its head');
  scroller.scrollTop = 800;
  assert.equal(render(SPECTATE, null), 800, 'reading the chronicle: a re-render with no selection');
  const a = pressed();
  assert.equal(render(SPECTATE, a), 0, 'a village pressed on the map: its card is at the head');
  scroller.scrollTop = 640;
  assert.equal(render(SPECTATE, a), 640, 'the province\'s record arrives, a turn passes: the same selection');
  assert.equal(render(SPECTATE, a), 640);
  assert.equal(render(SPECTATE, pressed()), 0, 'the same tile pressed again');
  scroller.scrollTop = 900;
  const b = { kind: 'province', p: 5, q: 0 };
  assert.equal(render(SPECTATE, b, { fromDrawer: true }), 900, '「見る」 on a line of the chronicle');
  assert.equal(render(SPECTATE, b), 900);
  assert.equal(render(SPECTATE, null), 900, 'Escape on the map lets the selection go');
  assert.equal(render(SPECTATE, a), 0, 'and the village pressed once more');
  scroller.scrollTop = 300;
  assert.equal(render(null, a, { same: false }), 0, 'put away over the selection (the page empties it)');
  assert.equal(shown, null, 'a closed drawer shows no card');
  scroller.scrollTop = 0;
  assert.equal(render(SPECTATE, pressed(), { same: false }), 0, 'and brought back by a new press');
});

test('the page wires the hook to the drawer\'s own scroll owner, at once and without a glide, and it reads no state of the game', () => {
  const fn = appSrc.slice(appSrc.indexOf('function renderDrawer(markupOf)'), appSrc.indexOf('function renderPlay()'));
  assert.ok(fn.length > 400 && fn.length < 3000, 'renderDrawer is found');
  assert.match(fn, /const scroller = phone\(\) \? \$\('panel'\) : body;/, 'the sheet itself on a phone, the paper under the bar on a desktop');
  assert.match(fn, /const head = drawerHeadFor\(d, FS\.selected, lastHeadSelection, inputInDrawer\);\n  lastHeadSelection = head\.selection;/);
  assert.match(fn, /if \(!same && scroller\) scroller\.scrollTop = 0;\n[\s\S]{0,400}if \(head\.toHead && scroller && scroller\.scrollTop !== 0\) scroller\.scrollTop = 0;/, 'after the view\'s own rule, on the same owner');
  assert.equal(fn.match(/scrollTop = 0/g).length, 2, 'the two rules and no third');
  assert.doesNotMatch(fn, /scrollTo\(|scrollIntoView|behavior\s*:/, 'set at once: a later re-render never finds the drawer half-way, and reduced motion needs no other path');
  assert.match(appSrc, /for \(const ev of \['pointerdown', 'keydown'\]\) globalThis\.document\?\.addEventListener\?\.\(ev, e => \{ inputInDrawer = !!e\.target\?\.closest\?\.\('#panel-body'\); \}, true\);/, 'where the last input began: read in the capture phase, nothing else done');
  const pure = appSrc.slice(appSrc.indexOf('export function drawerHeadFor'), appSrc.indexOf('/** Write the drawer'));
  assert.doesNotMatch(pure, /\bFS\b|invalidate|ACTIONS|document|\$\(/, 'drawerHeadFor is pure');
  // the owners themselves, as the stylesheet makes them
  assert.match(css, /\n#panel-body \{ flex: 1 1 auto; min-height: 0; overflow: auto;/, 'a desktop: the paper scrolls');
  assert.match(css, /\.panel, \.panel\[data-drawer="closed"\] \{ position: absolute;[^}]*overflow: auto;/, 'a phone: the sheet scrolls');
  assert.match(css, /\n  #panel-body \{ flex: none; overflow: visible;/, 'a phone: the paper does not');
});

// ---- what a read answers with: nothing is said to be so before it is read, and a read that failed is said as that
const SEASON = Object.freeze({ programVersion: 3, layoutVersion: 2 });
const railOf = FS => flat(renderRail(FS));
const words = markup => markup.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('the spectator\'s standings: while the season is unread the plate says so — never six nations at zero', () => {
  const waiting = railOf({ mode: 'spectate', season: null, overviews: new Map(), error: null });
  assert.match(waiting, /<div class="plate plate-watch">/);
  assert.match(waiting, /<p class="read-state" role="status" data-read="waiting">/);
  assert.match(words(waiting), /^国の順位 記録を読み込んでいます…$/);
  assert.doesNotMatch(waiting, /rail-standings|村 0/, 'no row says a nation has nothing before anything is read');
  setLang('en');
  assert.match(words(railOf({ mode: 'spectate', season: null, overviews: new Map(), error: null })), /^Nation standings Reading the record…$/);
});

test('the spectator\'s standings: a season that could not be read is said as that, with what to do; the first answer brings the list', () => {
  const failed = railOf({ mode: 'spectate', season: null, overviews: new Map(), error: { code: 'HTTP503', text: 'x' } });
  assert.match(failed, /<p class="read-state" role="status" data-read="unread">/);
  assert.match(words(failed), /^国の順位 シーズンの記録を読めません 通信の状態を確かめてください。読み込み直すと、もう一度試します。$/);
  assert.doesNotMatch(failed, /rail-standings|村 0/);
  // an overview has answered (a season without conquest): the six nations, as before
  const rec = { p: 2, q: 0, owners: [0, 1], sites: [1, 1] };
  const listed = railOf({ mode: 'spectate', season: null, overviews: new Map([[2, { provinces: [rec] }]]), error: null });
  assert.match(listed, /<ol class="rail-standings">/);
  assert.match(words(listed), /アステル 村 1 · 1 州/);
  assert.match(listed, /<p class="plate-note">/);
  // the season has answered and the overviews have not: the list as before (a conquest season says its own state)
  assert.match(railOf({ mode: 'spectate', season: { programVersion: 1 }, overviews: new Map(), error: null }), /<ol class="rail-standings">/);
  // the list itself is as it was for an empty map (other surfaces and tests rely on it)
  assert.match(flat(renderStandingsList({ overviews: new Map() })), /<ol class="rail-standings">/);
  // the play page's rail is not the spectator's
  assert.equal(railOf({ mode: 'practice' }), '');
  setLang('en');
  assert.match(words(railOf({ mode: 'spectate', season: null, overviews: new Map(), error: { code: 'HTTP503', text: 'x' } })), /^Nation standings The season(&#39;|')s record cannot be read\. Check your connection\. Reloading tries again\.$/);
});

test('the chronicle\'s line: with the season unread for good it is "could not be read", not "being read"; every other state as before', () => {
  assert.deepEqual(chronicleState({}), { state: 'waiting', code: null });
  assert.deepEqual(chronicleState({ error: null, season: null }), { state: 'waiting', code: null }, 'still being read');
  assert.deepEqual(chronicleState({ error: { code: 'HTTP503' }, season: null }), { state: 'unread', code: 'HTTP503' });
  assert.deepEqual(chronicleState({ error: { code: 'BeaconMismatch' }, season: SEASON }), { state: 'waiting', code: null }, 'an error with the season read is another matter: the record may still come');
  assert.deepEqual(chronicleState({ error: { code: 'HTTP503' }, season: null, chronicle: [] }), { state: 'ok', code: null }, 'pages read before stay read');
  assert.deepEqual(chronicleState({ chronicleRead: { ok: false, code: 'HTTP500' } }), { state: 'unread', code: 'HTTP500' });
  assert.deepEqual(chronicleState({ chronicleRead: { ok: false, code: 'HTTP500' }, chronicle: [] }), { state: 'stale', code: 'HTTP500' });
  assert.deepEqual(chronicleState({ chronicleRead: { ok: true }, chronicle: [] }), { state: 'ok', code: null });
  const line = flat(readLine({ error: { code: 'HTTP503' }, season: null }));
  assert.match(line, /class="blocked read-state" role="status" data-read="unread"/);
  assert.match(line, /出来事の記録を読み込めませんでした（HTTP503）。記録が空という意味ではありません。/);
});

test('the page banner: a read that failed by its HTTP status says what could not be read, with the code; every other error keeps its words', () => {
  assert.equal(bannerText({ code: 'HTTP503', text: '不明なエラー（HTTP503）' }), 'シーズンの記録を読めません（HTTP503）');
  assert.equal(bannerText({ code: 'HTTP404', text: 'x' }, false), 'シーズンの記録を読めません（HTTP404）');
  assert.equal(bannerText({ code: 'HTTP503', text: '不明なエラー（HTTP503）' }, true), '不明なエラー（HTTP503）', 'with the season read, the error is of something else: its own text');
  assert.equal(bannerText({ code: 'BeaconMismatch', text: 'ビーコンが違います' }), 'ビーコンが違います');
  assert.equal(bannerText({ code: 'network', text: '通信できませんでした' }), '通信できませんでした');
  assert.equal(bannerText({ text: 'only words' }), 'only words');
  assert.equal(bannerText(null), '');
  setLang('en');
  assert.equal(bannerText({ code: 'HTTP503', text: 'Unknown error (HTTP503)' }), "The season's record cannot be read. (HTTP503)");
});

test('the page gives the keyboard back: the term\'s popover to its key, the search to the map, the dock to the key pressed', () => {
  // the term's popover: Escape and its close key return the focus; the other ways of closing it do not move it
  assert.match(appSrc, /if \(e\.key === 'Escape' && FS\.term\) \{ e\.preventDefault\(\); closeTermPop\(\{ focus: true \}\); return; \}/);
  assert.match(appSrc, /'term-close': \(\) => closeTermPop\(\{ focus: true \}\),/);
  assert.match(appSrc, /function closeTermPop\(\{ focus = false \} = \{\}\) \{\n  if \(!FS\.term\) return;\n  FS\.term = null; renderTermPop\(\);\n  const from = termFrom; termFrom = null;\n  if \(focus && from\) /);
  assert.equal(appSrc.match(/closeTermPop\(\); /g).length >= 3, true, 'opening the dial, the legend or the glossary closes it without taking the focus');
  // the search: the field is put away, the keyboard goes to the map
  assert.match(appSrc, /setSearch\(false, \{ focus: false \}\);\n[^\n]*\n[^\n]*\n    \$\('frontier-map'\)\?\.focus\?\.\(\{ preventScroll: true \}\);/);
  // the dock: written anew at every render, the key in focus found again
  assert.match(appSrc, /if \(tabs\) keepState\(tabs, \(\) => setHtml\(tabs, renderTabs\(FS, /);
  assert.doesNotMatch(appSrc, /if \(tabs\) setHtml\(tabs, renderTabs\(/);
  // the season's word: nothing while the season could not be read (the banner says it)
  // (devnet-end-season: the word comes from seasonStatusText — the effective status, or "past the end bell, not yet Ended")
  assert.match(appSrc, /const status = s \? seasonStatusText\(s, FS\.chain\?\.now\(\) \?\? 0\) : FS\.error \? '' : L`読み込み中…`;/);
  assert.match(css, /\n#season-status:empty \{ display: none !important; \}/);
});

test('the stylesheet: a read\'s line is one line with its mark; what the recorded world\'s sheet covers cannot be seen or focused; a phone\'s notices clear three rows of keys', () => {
  assert.match(ruleOf('.read-state'), /display: grid; grid-template-columns: auto minmax\(0, 1fr\);/);
  const covered = /\nbody:has\(#wide-world:not\(\[hidden\]\)\) :is\(([^)]*)\) \{ visibility: hidden; \}/.exec(css);
  assert.ok(covered, 'one rule, at every width');
  for (const piece of ['.hud-tl', '.map-tools', '.minimap', '.rail', '.panel', '.feed', '.home-pointer', '#frontier-map']) assert.ok(covered[1].split(', ').includes(piece), piece);
  assert.doesNotMatch(covered[1], /topbar|dial|wide-world/, 'the top strip, which the sheet does not cover, and the sheet itself stay');
  const at = css.indexOf("a phone whose map carries three keys at its right edge");
  const block = css.slice(css.indexOf('@media (max-width: 759px) {', at), css.indexOf('\n}\n', at));
  const three = 'body:not([data-stage="none"]):not(:has(.plate-main[data-act="home"]))';
  assert.ok(block.includes(`${three} .feed { top: calc(var(--strip) + 8px + 3 * var(--target) + 20px); }`), 'the notices start under the third key');
  assert.ok(block.includes(`${three} .banner { top: calc(var(--strip) + 8px + 3 * var(--target) + 20px); max-width: calc(100% - 2 * var(--edge)); }`), 'and so does a banner, at the screen\'s width');
  assert.ok(block.includes(`${three}:has(.banner:not([hidden])) .feed {`), 'the notices stand under a banner');
  // (the third key's foot at 52 + 8 + 3 x 44 + 2 x 6 = 204 px; the notices at 52 + 8 + 132 + 20 = 212)
  assert.ok(52 + 8 + 3 * 44 + 20 > 52 + 8 + 3 * 44 + 2 * 6);
  assert.match(css, /\n  \.feed \{ top: calc\(var\(--strip\) \+ 8px \+ 2 \* var\(--target\) \+ 14px\); left: var\(--edge\); right: var\(--edge\); \}/, 'two rows of keys: as it was');
});
