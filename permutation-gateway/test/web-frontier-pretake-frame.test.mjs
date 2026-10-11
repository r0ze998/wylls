// The film's frame (the pre-take pass, 2026-10-11): the demo is filmed with the page laid out at 1280 × 720 CSS px
// in English (device scale 1.5: a 1920 × 1080 picture). What stood cut, covered or colliding at that size on the local
// test chain's world uxs1 was set right in the two stylesheets, by layout only. A stylesheet cannot be laid out here
// (no browser in this suite), so these tests pin the three things a later edit could break without anyone seeing it
// before the take:
//   1. the rules are there, inside the conditions that keep every other width as it was;
//   2. the hooks in the markup that those rules hang on are still what the modules write;
//   3. the clash record's signature is printed when the herald's clash answer carries `sig` at its top level, in the
//      shape herald.mjs hands it to the report (`{report: <the JSON>, inputs}`), and left out when it carries none.
// What was seen in the browser at that size is in the track's report; the figures quoted in comments are measurements
// of world uxs1 (turns 596 to 700).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { render as report } from '../../permutation-server/web/frontier/screens/report.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
/** A stylesheet without its comments. */
const css = f => src(f).replace(/\/\*[\s\S]*?\*\//g, '');
/** The bodies of every `@media <condition> { … }` block of a stylesheet whose condition is exactly `cond`, joined. */
function media(sheet, cond) {
  const out = [], head = `@media ${cond} {`;
  for (let i = sheet.indexOf(head); i !== -1; i = sheet.indexOf(head, i + 1)) {
    let depth = 0, j = i + head.length - 1;
    for (; j < sheet.length; j++) { if (sheet[j] === '{') depth++; else if (sheet[j] === '}' && --depth === 0) break; }
    out.push(sheet.slice(i + head.length, j));
  }
  return out.join('\n');
}
const FRAME = '(min-width: 1100px) and (max-width: 1399px)';
const FRAME_SHORT = '(min-width: 1100px) and (max-width: 1399px) and (max-height: 760px)';
const SHORT = '(min-width: 760px) and (max-height: 800px)';

test('the two stylesheets are whole: every brace closed, nothing fetched from elsewhere, no inline style asked for', () => {
  for (const f of ['frontier.css', 'conquest-hand.css']) {
    const s = css(f);
    assert.equal(s.split('{').length, s.split('}').length, `${f}: braces balance`);
    assert.doesNotMatch(s, /url\(\s*["']?https?:/, `${f}: no remote asset (strict CSP)`);
    assert.doesNotMatch(s, /@import/, `${f}: no import`);
  }
});

test('the spectator page links the conquest stylesheet: its "Provinces held" strip and standings are drawn as the play page draws them', () => {
  const page = src('spectate.html');
  assert.match(page, /<link rel="stylesheet" href="frontier\.css">\n {2}<link rel="stylesheet" href="people\/leaders\.css">\n {2}<link rel="stylesheet" href="conquest-hand\.css">\n<\/head>/);
  assert.doesNotMatch(page, /style="/, 'no inline style (CSP)');
  // the standings in the spectator's corner plate are on bell metal: the table takes the plate's ink
  const s = css('conquest-hand.css');
  assert.match(s, /\.plate-watch \.conquest-scores tbody td, \.plate-watch \.conquest-scores tbody th\[scope="row"\] \{ background: rgba\(255,255,255,\.06\); color: var\(--hud-ink\); \}/);
  assert.match(s, /\.plate-watch \.conquest-standings h3 \{ display: none; \}/, 'the plate has its own heading');
  // the hooks: the plate's class, and the table's
  assert.match(src('hud/hud.mjs'), /<div class="plate plate-watch">/);
  assert.match(src('screens/conquest.mjs'), /<section class="conquest-standings hpanel"[^>]*><h3 id="conquest-standings-title">/);
  assert.match(src('screens/conquest.mjs'), /<table class="stores conquest-scores">/);
});

test('"Provinces held" ends before the turn dial at the film\'s width: all six figures, the viewer\'s nation by name with its mark', () => {
  // (measured: the dial stands at 598 to 682 px of 1280; the strip ran from 64 to 656 with Fjordal, the last of the six, as
  // the viewer's nation: its figure behind the dial. With these rules it ends at 564.)
  const m = media(css('conquest-hand.css'), FRAME);
  assert.match(m, /\.prov-strip \{ left: 44px; \}/);
  assert.match(m, /\.ps-k \.ic, \.ps-go \{ display: none; \}/, 'what gives way is the heading\'s flag and the chevron');
  assert.doesNotMatch(m, /\.ps-(v|n|mine|you|name)[^{]*\{[^}]*display: none/, 'no figure, no nation and no mark is put away');
  const strip = src('hud/provstrip.mjs');
  for (const hook of ['class="ps-k"', 'class="ps-rows"', 'class="ps-name"', 'class="ps-v num"', 'class="ps-you"', 'class="ps-go"']) assert.ok(strip.includes(hook), `provstrip.mjs writes ${hook}`);
  assert.match(strip, /\$\{r\.mine \? ' ps-mine' : ''\}/);
  // outside that width nothing of the strip is changed: the rules stand only inside the condition
  assert.doesNotMatch(css('conquest-hand.css').replace(media(css('conquest-hand.css'), FRAME), ''), /\.ps-go \{ display: none; \}/);
});

test('the film\'s width with the side drawer open: the bar, its card and the dock keep to the map the drawer leaves free', () => {
  const m = media(css('frontier.css'), FRAME);
  // (measured: the drawer stands from 884; the bar stood from 293 to 841 and its card to 1030 — under the drawer —, and the
  // dock's strip of marks from 567 to 949, across the drawer's foot)
  assert.match(m, /body\[data-drawer="open"\]\[data-doc=""\] \.hand, body\[data-drawer="open"\]\[data-doc=""\] \.hand-pop\[data-mode="card"\] \{ left: calc\(\(100% - var\(--drawer-w\) - var\(--edge\)\) \/ 2\); max-width: calc\(100vw - var\(--drawer-w\) - 3 \* var\(--edge\)\); \}/);
  assert.match(m, /body\[data-drawer="open"\]\[data-doc=""\]:is\(\[data-hand="village"\], \[data-hand="host"\]\) \.tabs \{ left: calc\(\(100% - var\(--drawer-w\) - var\(--edge\)\) \/ 2\); translate: -50% 0; \}/);
  assert.match(m, /body\[data-drawer="open"\]\[data-doc=""\]:not\(\[data-hand="village"\], \[data-hand="host"\]\) \.tabs \{ left: calc\(/, 'nothing in hand: the dock between the plate and the map\'s keys');
  // a card of the bar is as wide as the room between the plate and the lens keys: they step back while it is open
  assert.match(m, /body:has\(#hand-pop\[data-mode="card"\]:not\(\[hidden\]\)\) :is\(\.rail, #lenses\) \{ visibility: hidden; \}/);
  // the guide's step on the top strip is said whole
  assert.match(m, /\.next-do \{ display: none; \}/);
  // the hooks: what app.mjs and the page write
  const app = src('app.mjs'), page = src('index.html');
  assert.match(app, /body\.dataset\.hand = kind/);
  assert.match(app, /handPopEl\.dataset\.mode !== mode\) handPopEl\.dataset\.mode = mode/);
  assert.match(app, /el\.id = 'mile-banner'/);
  for (const id of ['id="rail"', 'id="lenses"', 'id="feed"', 'id="tabs"', 'id="panel"']) assert.ok(page.includes(id), `index.html has ${id}`);
  assert.match(src('screens/shell.mjs') + src('app.mjs'), /dataset\.drawer/);
});

test('a short window (720 px high): the training card is lower, and its order keeps to one row', () => {
  const m = media(css('frontier.css'), FRAME_SHORT);
  // (measured: 397 px tall of a 720 px page, the village pushed up under the top strip; 301 px with these rules)
  assert.match(m, /\.hand-pop\[data-pop="train"\] \.unit-tok-good \{ display: none; \}/);
  assert.match(m, /\.hand-pop\[data-pop="train"\] \.unit-tok\[aria-pressed="true"\] \.unit-tok-good \{ display: block; position: absolute;/, 'the chosen kind\'s sentence is one line under the row');
  assert.match(m, /\.hand-pop\[data-pop="train"\] \.pop-line:not\(\.pop-why\) \{ display: none; \}/, 'a reason why the order cannot be given stays');
  const hand = src('hud/hand.mjs');
  assert.match(hand, /class="unit-tok\$\{can \? '' : ' short'\}" data-act="hand-unit" data-unit="\$\{unit\}" aria-pressed="\$\{unit === d\.unit \? 'true' : 'false'\}"/);
  assert.match(hand, /<span class="unit-tok-good">\$\{unitGood\(unit\)\}<\/span>/);
  assert.match(hand, /<p class="pop-line\$\{why \? ' pop-why' : ''\}">/);
  assert.match(src('app.mjs'), /handPopEl\.dataset\.pop/);
});

test('a short window: the dock steps back while a battle has the stage, so the two strength bars can be read', () => {
  // (seen on uxs1, the clash of turn 626 at province 4,0: "594 Fjordal · Aster 50" lay under the dock)
  const m = media(css('frontier.css'), SHORT);
  assert.match(m, /body\[data-fx-piece="battle"\] \.tabs \{ opacity: 0;/);
  assert.match(m, /body\[data-fx-piece="battle"\] \.tabs:focus-within \{ opacity: 1; \}/, 'a key\'s focus brings it back');
  assert.doesNotMatch(m, /data-fx-piece[^{]*\.tabs[^{]*\{[^}]*(display: none|visibility: hidden|pointer-events)/, 'only its look changes: it keeps its place and its presses');
  // the hook: the effects' engine names the piece on the body, and a battle's piece is named "battle"
  assert.match(src('fx/engine.mjs'), /if \(lead\) body\.dataset\.fxPiece = lead\.name; else delete body\.dataset\.fxPiece/);
  assert.match(src('fx/fx.css'), /body\[data-fx-piece\] :is\(#rail, #minimap, \.map-tools, \.home-pointer\) \{ opacity: 0; \}/, 'the corner pieces step back the same way');
});

test('a short window: the clash report\'s "Verify in this browser" and its answer stand in the right-hand column, in sight without a scroll', () => {
  // (measured at 1280 × 720: the sheet shows 504 px and the report was 648 px tall, the key and "Match" below the fold;
  // 489 px before the key is pressed with these rules, 508 px after)
  const m = media(css('frontier.css'), SHORT);
  assert.match(m, /\.panel\[data-doc="wide"\] \.report\.doc \{ display: grid; grid-template-columns: minmax\(0, 5fr\) minmax\(0, 6fr\);/);
  assert.match(m, /\.panel\[data-doc="wide"\] \.report\.doc > \.doc-cols \{ display: contents; \}/);
  assert.match(m, /\.panel\[data-doc="wide"\] \.report\.doc > \.doc-foot \{ grid-column: 2;/);
  assert.match(m, /\.panel\[data-doc="wide"\] \.report\.doc > \.doc-foot > \.notice \{ order: 1;/, 'the answer above the keys');
  // nothing of the proof is put away, nor the foot's note on "Try it in practice" (it stands under the keys): only the
  // note above the folds that says what the key does
  assert.doesNotMatch(m, /\.report[^{]*(\.report-proof|\.rep-recheck|\.rep-ref|\.notice|\.facts|\.verify-steps|\.doc-foot)[^{]*\{[^}]*display: none/);
  assert.match(m, /\.panel\[data-doc="wide"\] \.report\.doc > \.doc-foot > p\.muted \{ order: 3; margin-top: 24px; \}/, 'under the keys, and clear of the sheet\'s foot (a line cut in half at the fold: seen on uxs1)');
  setLang('en');
  const clash = { bell: 626, slot: 43932, anchor: { key: 'an:626,8' }, cache: { key: 'sd:626,8,67' }, inputDigest: '8c7d6c9dcc355bed', outcomeDigest: '6a0417333cfb76a8', decoded: { engagements: 1 } };
  const out = String(report({ mode: 'play', season: { programVersion: 3 }, citizen: { faction: 5 }, holdings: [], provinces: new Map(), nowBell: 640, report: { p: 4, q: 0, bell: 626, clash: { report: clash, inputs: null }, verify: null } }));
  assert.match(out, /<section aria-labelledby="report-title" class="report doc">/);
  assert.match(out, /<div class="doc-cols">\s*<div class="doc-col">/);
  assert.match(out, /<footer class="doc-foot"><p class="rep-recheck">/);
  assert.match(out, /<details class="report-proof fold" data-fold="rep-proof">/);
  assert.match(plain(out), /Clash: recomputed in this browser from the public record \(record slot 43,932\)/);
  assert.match(plain(out), /Verify in this browser/);
  assert.match(src('screens/shell.mjs') + src('app.mjs'), /dataset\.doc/);
});

test('the clash record\'s signature: printed from the herald\'s top-level `sig`, in the shape herald.mjs hands the answer over', () => {
  // herald.mjs `clash()`: {report: <the JSON of /h/clash/{p},{q}/{turn}>, inputs}: the report reads `clash.report.sig`
  assert.match(src('herald.mjs'), /return r\.ok \? guard\(\(\) => \(\{ report: r\.json, inputs: /);
  const reportSrc = src('screens/report.mjs');
  assert.match(reportSrc, /const rep = r\.clash\?\.report \?\? \{\};/);
  assert.match(reportSrc, /const recSig = typeof rep\.sig === 'string' \? rep\.sig : typeof rep\.signature === 'string' \? rep\.signature : null;/);
  assert.doesNotMatch(reportSrc, /it does\s+\/\/ not today|it does not today/, 'the comment no longer says the herald carries no signature');
  setLang('en');
  // (the answer of world uxs1 for the clash of turn 626 at province 4,0, cut to the fields the report prints; that
  // world's herald is of an older build and sends no `sig`: the value below is a fixture, a signature of run ux-check)
  const answer = { bell: 626, slot: 43932, anchor: { key: 'an:626,8' }, cache: { key: 'sd:626,8,67' }, inputDigest: '8c7d6c9dcc355beda714905c7f197e94e03f2b0be8aa233445cd236599896f67', outcomeDigest: '6a0417333cfb76a8', decoded: { engagements: 1 } };
  const SIG = '4WwZktjF2KUobqepbfLWNhCPWXAWGcbYLBSAQfwYKkPGge7feRf6SwdcsLX17pee8xmDgXHL6wtM25HuAvidVBMK';
  const page = (json, season = { programVersion: 3 }, extra = {}) => ({ mode: 'play', season, citizen: { faction: 5 }, holdings: [], provinces: new Map(), nowBell: 640, report: { p: 4, q: 0, bell: 626, clash: { report: json, inputs: null }, verify: null }, ...extra });
  const none = String(report(page(answer)));
  assert.doesNotMatch(none, /kh-sig|rep-ref/, 'an older herald: no line, nothing made up');
  const out = String(report(page({ ...answer, sig: SIG })));
  assert.match(plain(out), /Record slot 43,932 Clash record signature 4WwZktjF…idVBMK Copy/, 'after the facts, with its copy key');
  assert.match(out, new RegExp(`<p class="rep-ref"><span class="kh-sig">.*<code title="${SIG}">4WwZktjF…idVBMK</code>`), 'short on screen, whole in the title');
  assert.match(out, new RegExp(`data-act="kh-copy" data-copy="${SIG}"`), 'the whole signature goes to the clipboard');
  assert.ok(out.indexOf('rep-ref') > out.indexOf('class="report-proof fold"') && out.indexOf('rep-ref') < out.indexOf('class="doc-foot"'), 'it stands in the proof details');
  assert.match(plain(String(report(page({ ...answer, signature: SIG })))), /Clash record signature 4WwZktjF…idVBMK/, '`signature` is read too');
  assert.doesNotMatch(String(report(page({ ...answer, sig: 12345 }))), /rep-ref/, 'only a string is a signature');
  // never outside a conquest season, never in the sample world
  assert.doesNotMatch(String(report(page({ ...answer, sig: SIG }, { programVersion: 2 }))), /rep-ref|rep-recheck/);
  assert.doesNotMatch(String(report(page({ ...answer, sig: SIG }, { programVersion: 3 }, { sample: { name: 'sample' } }))), /rep-ref|rep-recheck/);
  // the line is the size of the facts above it in the proof
  assert.match(css('conquest-hand.css'), /\.report-proof \.rep-ref \{ margin: 8px 0; font-size: var\(--t2\); \}/);
});

test('the prize panel\'s lists keep inside the plate, and the first-village card frames the paid entry fee', () => {
  const s = css('conquest-hand.css'), base = css('frontier.css');
  // (measured: the plate is 360 px wide with 12 px gutters and each list was 360 px wide from its left gutter: its last
  // 12 px, the mark 「勝者」 and the signature's copy key among them, lay outside and were cut off)
  assert.match(base, /\.prize-area, \.prize-lines, \.prize-estimate \{ width: 100%;/, 'the older rule this one answers is still there');
  assert.match(s, /\.pz \.prize-area, \.pz \.prize-lines, \.pz \.prize-estimate \{ width: auto; min-width: 0; font-size: inherit; \}/);
  assert.ok(s.indexOf('.pz .prize-area, .pz .prize-lines') > s.indexOf('.pz > * { margin: 0 12px; }'), 'after the plate\'s own gutters');
  const prize = src('screens/prize.mjs');
  for (const hook of ['class="pz-area prize-area"', 'class="pz-lines prize-lines"', 'class="pz-split prize-estimate"', 'data-act="prize-faucet"']) assert.ok(prize.includes(hook), `prize.mjs writes ${hook}`);
  assert.match(s, /\.nation-confirm \.prize-terms > p:has\(> \[data-act="prize-faucet"\]\) \{ display: flex; align-items: center; gap: 10px; \}/);
  // the fee line of the first-village card
  assert.match(s, /\.home-grant > p\.prize-receipt \{[^}]*box-shadow: inset 0 0 0 1px rgba\(46,107,76,\.45\);[^}]*\}/);
  const join = src('screens/join.mjs');
  assert.match(join, /<section class="vcard wait-card home-grant" aria-labelledby="join-sites">/);
  assert.match(join, /\$\{FS\.prizePayment \? html`<p class="prize-receipt">/);
});

test('everything of the film\'s frame is a rule of layout: no script was changed for it, and the two samples of the season\'s end are still there', () => {
  // the report's module changed by a comment only (its markup is what the tests above render); the samples are asked by `?fx=hand-…`
  assert.match(src('hud/handdemo.mjs'), /hand-season-end/);
  assert.match(src('hud/handdemo.mjs'), /hand-prize/);
  // the conditions used: only the laptop's width, a short window, or a rule keyed to a conquest piece's own class
  // (the block: from the end of its heading's comment to the end of the stylesheet)
  const tail = src('frontier.css').split('the film\'s frame: a laptop\'s width (1280 × 720)')[1] ?? '';
  const added = tail.slice(tail.indexOf('*/') + 2);
  assert.ok(added.length > 400, 'the block is there, under its heading');
  const heads = [...added.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@media ([^{]+)\{/g)].map(x => x[1].trim());
  assert.deepEqual([...new Set(heads)].sort(), [FRAME, FRAME_SHORT, SHORT].sort(), 'no other condition, so no other size of window is touched');
  assert.equal(added.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media [^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').trim(), '', 'no rule of the block stands outside a condition');
});
