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

test('the wait for the village: the leader\'s line stands in the card (phones), the state fits one line, the practice battle is offered', async () => {
  const joinScreen = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const { leaderWords } = await import('../../permutation-server/web/frontier/map/waitview.mjs');
  setLang('ja');
  const clock = { genesisTs: 1_000, window: () => 60, margin: 6 };
  const base = { mode: 'play', tab: 'map', playReady: true, wallet: { address: 'W' }, session: { publicKey: 'S' }, citizen: { faction: 0 }, clock, chain: { now: () => 1_000 + 42 * 600 + 150 },
    overviews: new Map(), holdings: [], view: { fog: true }, ui: { dismissed: [] } };
  const failed = flat(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'failed', code: 'Unavailable' } }));
  // one clear state: a title of one line, one retry, one labelled countdown
  assert.match(failed, /<h3 id="join-sites">村の申し込みが通っていません<\/h3>/);
  assert.equal((failed.match(/data-act="auto-ticket"/g) ?? []).length, 1, 'one retry');
  assert.match(text(failed), /次のターンに自動でやり直します（あと 7:30 ）/, 'the countdown says what it counts');
  // the nation's words, the same the map writes under the standard, with no named speaker
  const say = leaderWords(0, 'failed');
  assert.ok(failed.includes(`<span class="wait-says-t">「${say.text}」</span>`), failed.slice(0, 900));
  assert.doesNotMatch(failed, /wait-says-who|data-name/);
  const ticket = flat(joinScreen.render({ ...base, land: { stage: 'ticket', ticket: { bell: 42, sites: [{ p: 2, q: 0, site: 3 }], next: 0 } } }));
  assert.match(ticket, /<h3 id="join-sites">村が決まるのを待っています<\/h3>/);
  assert.ok(ticket.includes(`「${leaderWords(0, 'ticket').text}」`), 'the ticket view has the line too (a phone\'s map leaves it out)');
  // the practice battle: the button, and the two sentences marked apart (a phone keeps the second)
  for (const m of [failed, ticket]) {
    assert.match(m, /<span class="wo-lead">待つあいだに、練習で戦ってみましょう。<\/span><span class="wo-note">何も送らず、何も失いません。<\/span>/);
    assert.match(m, /data-act="practice-open"/);
  }
  setLang('en');
  try {
    const en = text(joinScreen.render({ ...base, land: { stage: 'joined' }, autoTicket: { state: 'failed', code: 'Unavailable' } }));
    assert.doesNotMatch(en, JP, en);
    assert.match(en, /“First, the village request\. Once it is in, the candidate sites appear on the map\.”/);
    assert.doesNotMatch(en, /Oriane|Marshal/);
  } finally { setLang('ja'); }
  // the stylesheet: the line is the phone's; the wait's first sight there holds the practice battle before the list of places
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  assert.match(css, /\n\.wait-says \{ display: none; \}/);
  assert.match(css, /\.wait-card > \.wait-offer \{ order: 1;/);
  // the page tells the map when the card says the line, and the map then leaves its own out
  assert.match(readFileSync(new URL('app.mjs', WEB), 'utf8'), /const wordsSaid = phone\(\) && drawerOf\(FS\)\?\.kind === 'wait' && sheetRef\?\.state\(\) !== 'peek';/);
  assert.match(readFileSync(new URL('map/fmap.mjs', WEB), 'utf8'), /say: src\.wait\?\.wordsSaid \? null : leaderWords\(/);
});

test('a phone\'s order after a refusal keeps its seal on screen; an order rests on a whole row at every height', async () => {
  const { rowGap, ROW_GAP_MAX, GAP_MARK_MIN } = await import('../../permutation-server/web/frontier/hud/drawer.mjs');
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  // the resting sheet of an order is as tall as its foot needs, not a fixed height (the refusal's line pushed the seal under the tab bar)
  assert.match(css, /\.panel\[data-sheet="peek"\]:has\(#panel-body > \.order\) \{ max-height: min\(calc\(var\(--vvh\) \* \.5\), 380px\); \}/);
  // a full sheet ends under the dial
  assert.match(css, /\.panel\[data-sheet="full"\] \{ max-height: min\(calc\(100% - var\(--dial\) - 18px\)/);
  // a selection at rest: its head and its actions, whole
  assert.match(css, /\.panel\[data-sheet="peek"\]\[data-kind="inspect"\] \.inspect > :not\(\.c-head, \.insp-acts\) \{ display: none; \}/);
  // the sheet's height changes: the rows are settled again
  assert.match(readFileSync(new URL('app.mjs', WEB), 'utf8'), /attributeFilter: \['data-sheet'\]/);
  // a heading is never left as the last whole row above what it heads
  const rows = [{ top: 0, bottom: 70, leaf: true }, { top: 80, bottom: 120, leaf: true }, { top: 130, bottom: 174, leaf: true, head: true }, { top: 178, bottom: 265, leaf: true }];
  assert.equal(rowGap(200, rows), 80, 'the heading goes below the fold with its row');
  assert.equal(rowGap(176, rows), 56, 'also when its row is wholly below');
  assert.equal(rowGap(270, rows), 0, 'everything whole: no gap');
  assert.equal(rowGap(200, rows.map(r => ({ ...r, head: false }))), 26, 'a plain row may be the last');
  assert.ok(GAP_MARK_MIN > 0 && GAP_MARK_MIN < ROW_GAP_MAX);
  assert.match(css, /\.order-body\[data-gap="more"\] \+ \.order-foot::before/);
});

test('words: a chip explains itself, a due time says what it is', async () => {
  const inspect = await import('../../permutation-server/web/frontier/hud/inspect.mjs');
  const { dueHtml } = await import('../../permutation-server/web/frontier/screens/shell.mjs');
  setLang('ja');
  const prov = {
    p: 2, q: 0, relations: 0n, sites: Uint8Array.from([9, 20]), resolveSummary: { bell: 41 },
    siteMirror: [{ state: 1, faction: 2, tier: 1, garrison: 300000, shieldUntilBell: 0 }, { state: 1, faction: 0, tier: 1, garrison: 100000, shieldUntilBell: 0 }],
    entries: [], camp: { state: 0 },
  };
  const FS = { mode: 'play', citizen: { faction: 0 }, holdings: [{ p: 2, q: 0, site: 1, tile: 20, tier: 1, state: 2 }], nowBell: 42, land: { stage: 'final' },
    overviews: new Map([[2, { provinces: [{ p: 2, q: 0, owners: [2, 0, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], clash: false }] }]]),
    provinces: new Map([['2,0', { province: prov }]]), selected: { p: 2, q: 0, idx: 20 } };
  const terrainOf = () => ({ terrain: Array(61).fill(0), sites: [9, 20], names: ['Grassland'] });
  // the viewer's own village: no chip about another nation; the province's other nations wait under details, said in full
  const own = flat(inspect.render(FS, terrainOf));
  const chips = /<p class="fact-chips">([\s\S]*?)<\/p>/.exec(own)?.[1] ?? '';
  assert.doesNotMatch(chips, /敵対|友好/, 'the second check: 「シンダー 敵対」 on the own village said nothing about whose stance');
  assert.match(own, /<dt>この州に村を持つほかの国<\/dt>/);
  assert.match(text(own), /（あなたの国と敵対）/);
  // another nation's village: the chip says how that nation stands toward the viewer's
  const theirs = flat(inspect.render({ ...FS, selected: { p: 2, q: 0, idx: 9 } }, terrainOf));
  assert.match(/<p class="fact-chips">([\s\S]*?)<\/p>/.exec(theirs)?.[1] ?? '', /あなたの国と敵対/);
  // a due time: how long from now, then the clock; never a bare 03:30
  assert.match(text(dueHtml(3600 * 5, 3600 * 1 + 120)), /^あと約 3時間58分（ \S+ ごろ）$/);
  assert.match(text(dueHtml(600, 0)), /^あと約 10 分（ \S+ ごろ）$/);
  assert.match(text(dueHtml(600, 900)), /^\S+ ごろ$/);
  setLang('en');
  try {
    assert.match(text(dueHtml(3600 * 5, 3600 * 1 + 120)), /^in about 3 h 58 min \(around \S+ \)$/);
    assert.match(text(inspect.render({ ...FS, selected: { p: 2, q: 0, idx: 9 } }, terrainOf)), /Hostile to your nation/);
  } finally { setLang('ja'); }
});

test('English: a place inside a sentence takes its article; one spelling; a village is provisional, then confirmed', async () => {
  const { inText, atPlace } = await import('../../permutation-server/web/lang/helpers.mjs');
  assert.equal(inText('Town of Ramar'), 'the town of Ramar');
  assert.equal(inText('Stronghold of Elwell'), 'the stronghold of Elwell');
  assert.equal(inText('Barbarian camp'), 'the barbarian camp');
  assert.equal(inText('Hills'), 'the hills');
  assert.equal(inText('Mountain'), 'the mountains');
  assert.equal(inText('Free City'), 'the Free City');
  assert.equal(inText('The Concord'), 'the Concord');
  assert.equal(inText("Town of Ramar's province"), "the town of Ramar's province");
  assert.equal(inText('Aster side, ring 2'), 'the Aster side (ring 2)');
  assert.equal(inText('600 Spearmen'), '600 Spearmen', 'anything else is left as it is');
  assert.equal(atPlace('Town of Ramar'), 'at the town of Ramar');
  assert.equal(atPlace("Town of Ramar's province"), "in the town of Ramar's province");
  assert.equal(atPlace('Aster side, ring 2'), 'on the Aster side (ring 2)');
  assert.equal(atPlace('Province 3,0'), 'in Province 3,0');
  assert.equal(atPlace('Forest'), 'in the forest');
  const { holdingName } = await import('../../permutation-server/web/frontier/people/ui.mjs');
  const { L } = await import('../../permutation-server/web/lang.mjs');
  setLang('en');
  try {
    const town = holdingName({ p: 2, q: 0, site: 3 }, 1);
    assert.match(town, /^Town of /, 'a label keeps its capitals and takes no article');
    const lower = town.replace(/^Town/, 'the town');
    assert.equal(L`${town}にいます`, `At ${lower}`, 'the second check: "In Town of Ramar"');
    assert.equal(L`${town}から`, `From ${lower}`);
    assert.equal(L`${town}へ移動`, `Go to ${lower}`);
    assert.equal(L`進軍は送られていません（${'600 Spearmen'} は${town}にいます）。`, `The march was not sent (600 Spearmen are still at ${lower}).`, 'the second check: "at Town of Ramar"');
    assert.equal(L`${town}に来襲の恐れがあります`, `${lower.replace(/^the/, 'The')} may come under attack`);
    assert.equal(L`${town}が確定しました`, `${lower.replace(/^the/, 'The')} is now confirmed`);
    assert.equal(L`${'Ramar'}の村が${'Town'}になりました`, 'The village of Ramar is now a town');
  } finally { setLang('ja'); }
  // one spelling in the two dictionaries of the Frontier client: British
  const dict = ['en-frontier.mjs', 'en-frontier-play.mjs'].map(f => readFileSync(new URL(`../lang/${f}`, WEB), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')).join('\n');
  const american = dict.match(/\b(colors?|colored|centers?|centered|neighbou?ring (?!\w)|neighbor\w*|defenses?|favor\w*|honor\w*|armor\w*|gray|traveled|traveling|practicing|practiced)\b/gi) ?? [];
  assert.deepEqual(american.filter(w => !/^neighbouring/i.test(w)), [], 'American spellings in the Frontier dictionaries');
  assert.doesNotMatch(dict, /can practice\b|to practice\b|Start practic/, 'the verb is "practise"');
  assert.match(dict, /nation\\'s colour/);
  assert.doesNotMatch(dict, /\b(is|not|now|became|until it is) final\b/, 'a village is "confirmed", as its stamp says');
});

test('the craft pass: keys keep their material under the pointer, rings stand on every material, no white surface is left', () => {
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  // the plain teal key keeps its metal on hover; the seal, the brass keys and the keys on metal are not touched by that rule
  assert.match(css, /\.btn\.primary:where\(:not\(\[disabled\], \.seal-btn, \.nc-btn, \.intro-go\)\):hover \{ background: linear-gradient\(/);
  assert.doesNotMatch(css, /\.btn\.primary:not\(\[disabled\]\):hover/, 'a heavier selector would repaint the seal and the brass keys');
  assert.match(css, /\.btn\.primary\[disabled\]:not\(\.seal-btn, \.nc-btn, \.intro-go\) \{ color: var\(--ink-2\);/);
  // focus: brass on the metal inside the panel; a halo for what floats over the map; rings inside plaques and the dock
  assert.match(css, /\.panel\[data-drawer="closed"\] #panel-body :focus-visible, \.panel\[data-kind="nation"\] #panel-body :focus-visible[^{]*\{ outline-color: var\(--brass-hi\); \}/);
  assert.match(css, /\.map-btn:focus-visible, \.lens:focus-visible[^{]*\{ box-shadow: 0 0 0 7px rgba\(8,18,16,\.8\); \}/);
  assert.match(css, /\.res:focus-visible, \.brand:focus-visible[^{]*\{ outline-offset: -3px; \}/);
  // the popovers of the HUD are bell metal
  const pop = css.slice(css.lastIndexOf('\n.res-pop {'));
  assert.match(pop, /^\n\.res-pop \{[^}]*background: var\(--tex-metal, none\), var\(--plate-bg\); color: var\(--hud-ink\);/);
  assert.match(css, /\n\.res-row \{[^}]*border: 0;[^}]*background: none; color: var\(--hud-ink\); \}/);
  // beside an open drawer on a narrow desktop the world-chart key is its glyph alone
  assert.match(css, /@media \(min-width: 760px\) and \(max-width: 1279px\) \{\s*body\[data-drawer="open"\]\[data-doc=""\] \.map-btn\[data-worded\] \{ width: 36px;/);
  // the spectator's status is a word in the bar, and the map is given its own top edge
  assert.match(css, /\.panel\[data-kind="spectate"\] #season-status \{ position: absolute;/);
  assert.match(readFileSync(new URL('app.mjs', WEB), 'utf8'), /rects\.push\(\{ id: 'edge-top',/);
});

test('a phone\'s refusal notice: the retry on the first row, the words on the full width; the order rests on the destination\'s lines', async () => {
  const status = await import('../../permutation-server/web/frontier/hud/status.mjs');
  setLang('ja');
  const FS = { notice: { ok: false, code: 'Unavailable' }, lastAct: { name: 'march-send' }, compose: { host: { unit: 0, troops: 600, tile: 7 }, origin: { p: 2, q: 0 } }, provinces: new Map() };
  const out = flat(status.renderStatus(status.statusOf(FS, { canRetry: true })));
  // what was not done and why are two marked parts (a phone lays each on the full width)
  assert.match(out, /<strong class="tx-what">進軍は送られていません[^<]*<\/strong> <span class="tx-why">サーバーが応じませんでした。[^<]*<\/span><\/span>/);
  assert.match(out, /data-act="notice-retry"/);
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  assert.match(css, /\.tx-refused \.toast-text \{ display: contents; \}/);
  assert.match(css, /\.tx-refused \.toast-acts \{ grid-column: 3; grid-row: 1;/);
  assert.match(css, /\.feed \{ top: calc\(var\(--strip\) \+ 8px \+ 2 \* var\(--target\) \+ 14px\); left: var\(--edge\); right: var\(--edge\); \}/);
  // the destination block's lines are rows of their own for the order's resting place
  const drawer = readFileSync(new URL('hud/drawer.mjs', WEB), 'utf8');
  assert.match(drawer, /:scope \.mc-dest > \*'\)/);
});

test('the map\'s search: results on bell metal, the clear mark in the HUD\'s ink, a phone\'s field clear of the dial', () => {
  const css = readFileSync(new URL('frontier.css', WEB), 'utf8');
  const last = css.slice(css.lastIndexOf('\n.search-results {'));
  assert.match(last, /^\n\.search-results \{[^}]*background: var\(--tex-metal, none\), var\(--plate-bg\);/);
  assert.match(css, /\.map-search input::-webkit-search-cancel-button \{ -webkit-appearance: none;/);
  assert.match(css, /\.map-search \{ top: calc\(var\(--target\) \+ 6px\); \}\s*body:has\(#search-btn\[aria-expanded="true"\]\) \.map-tools \{ visibility: hidden; \}/);
});
