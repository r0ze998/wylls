// The six leaders' pictures (the owner's art of 2026-10-09) and the one way they reach a screen
// (people/leaders.mjs, people/leader-art.mjs). Ported from the other line of work's
// web-frontier-leader-art.test.mjs where it applies: the order of the six, the Aster fallback, inline SVG
// without style or script, the faction cards. What differs here on purpose: there is no atlas (each leader
// has files of its own, sized for its largest use), and no flat vector bust stays underneath: the old
// portraits are gone from every screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as LD from '../../permutation-server/web/frontier/people/leaders.mjs';
import * as ART from '../../permutation-server/web/frontier/people/leader-art.mjs';
import { MOTION_LEADERS, LEADER_MOTIONS, LEADER_SPRITE_CELL, LEADER_SHEET_SETS, motionInSet, motionSpriteUrl } from '../../permutation-server/web/frontier/leader-motion-data.mjs';
import * as P from '../../permutation-server/web/frontier/palette.mjs';
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT, FACTION_ON, FACTION_MARK, avatarSvg } from '../../permutation-server/web/frontier/people/avatar.mjs';
import { FACTION_COLORS, factionName } from '../../permutation-server/web/frontier/fi18n.mjs';
import { leaderCard } from '../../permutation-server/web/frontier/people/ui.mjs';
import { crestSvg, leaderCrest, renderStandingsList, renderPlate } from '../../permutation-server/web/frontier/hud/hud.mjs';
import { renderBanner } from '../../permutation-server/web/frontier/hud/milestones.mjs';
import { emblemSvg } from '../../permutation-server/web/frontier/intro/title.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const ART_DIR = new URL('art/leaders3d/', WEB);
const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
const flat = x => [x].flat(Infinity).map(String).join('');

/** Width and height of a WebP file (VP8X, lossless and lossy headers). */
function webpSize(url) {
  const b = readFileSync(url);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.toString('ascii', 8, 12), 'WEBP');
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), alpha: !!(b[20] & 0x10), bytes: b.length };
  if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff), alpha: !!((n >> 28) & 1), bytes: b.length }; }
  return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, alpha: false, bytes: b.length };
}
const dirBytes = dir => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirBytes(new URL(`${e.name}/`, dir)) : statSync(new URL(e.name, dir)).size), 0);

test('the six leaders follow faction order (red, sky cyan, yellow, purple, white, orange); anything else reads as Aster', () => {
  assert.deepEqual(MOTION_LEADERS.map(l => l.key), KEYS);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(ART.leaderKey), KEYS);
  for (const invalid of [-1, 6, null, undefined, '1', 0.5]) assert.equal(ART.leaderKey(invalid), 'aster');
  assert.deepEqual(LD.CHARACTERS.map(c => [c.faction, c.key]), KEYS.map((k, f) => [f, k]));
  // the six are the players: a character has no name and no title (DECISIONS ZP1, ZP3)
  assert.equal(LD.LEADERS, undefined);
  for (const c of LD.CHARACTERS) assert.deepEqual(Object.keys(c), ['faction', 'key']);
});

test('the package\'s 24 motion sheets are in the client byte for byte, each a row of 256 px frames', () => {
  const dir = new URL('motion-v1/sprite/', ART_DIR);
  const files = readdirSync(dir).filter(f => f.endsWith('.webp')).sort();
  assert.equal(files.length, 24);
  // (the digest of the 24 sha-256 lines of the owner's package "6人の動き", in file-name order)
  const lines = files.map(f => createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex')).join('\n') + '\n';
  assert.equal(createHash('sha256').update(lines).digest('hex'), 'e45415835f23598ac48da5daa66c7cfb5cbfd3663b110b6eb6c498451bbf6674');
  for (const l of MOTION_LEADERS) for (const m of LEADER_MOTIONS) {
    const s = webpSize(new URL(motionSpriteUrl(l.key, m.key)));
    assert.deepEqual([s.w, s.h, s.alpha], [LEADER_SPRITE_CELL * m.frames, LEADER_SPRITE_CELL, true], `${l.key}_${m.key}`);
  }
  // the 3D models are not shipped: the redesign has no 3D viewer
  assert.equal(readdirSync(ART_DIR, { recursive: true }).filter(f => /\.(glb|blend)$/.test(String(f))).length, 0);
});

test('the sharp set: 24 sheets of 512 px frames beside the package\'s own, the idle with eight frames; the package\'s files are untouched by it', () => {
  // (rendered on 2026-10-10 from the owner's models by the owner's own script: docs/frontier/art/leaders3d/STAGE.md)
  const dir = new URL('motion-v1/sprite@2x/', ART_DIR);
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, MOTION_LEADERS.flatMap(l => LEADER_MOTIONS.map(m => `${l.key}_${m.key}.webp`)).sort(), 'the same 24 names, nothing else');
  const S = LEADER_SHEET_SETS['2x'];
  assert.deepEqual([S.folder, S.cell, S.frames], ['sprite@2x', 512, { idle: 8 }]);
  assert.deepEqual([LEADER_SHEET_SETS['1x'].folder, LEADER_SHEET_SETS['1x'].cell, LEADER_SHEET_SETS['1x'].frames], ['sprite', 256, {}]);
  let total = 0;
  for (const l of MOTION_LEADERS) for (const m of LEADER_MOTIONS) {
    const url = new URL(motionSpriteUrl(l.key, m.key, '2x'));
    assert.ok(url.pathname.endsWith(`/motion-v1/sprite%402x/${l.key}_${m.key}.webp`) || url.pathname.endsWith(`/motion-v1/sprite@2x/${l.key}_${m.key}.webp`));
    const frames = motionInSet(m, '2x').frames, s = webpSize(url);
    assert.equal(frames, m.key === 'idle' ? 8 : m.frames, 'only the idle has more frames than the package\'s sheet');
    assert.deepEqual([s.w, s.h, s.alpha], [512 * frames, 512, true], `${l.key}_${m.key}`);
    total += s.bytes;
    // the same clip, the same length, the same way of playing
    assert.deepEqual([motionInSet(m, '2x').clip, motionInSet(m, '2x').duration, motionInSet(m, '2x').loop], [m.clip, m.duration, m.loop]);
    assert.equal(motionInSet(m, '1x'), m);
  }
  // (the digest of the 24 sha-256 lines, in file-name order: the files as assembled on 2026-10-10)
  const lines = files.map(f => createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex')).join('\n') + '\n';
  assert.equal(createHash('sha256').update(lines).digest('hex'), 'a96c727ce7f31d1284c77f3436478ec0907789a12339c5e469038baa8fee5239');
  assert.equal(total, 1_014_998);
  // what one screen asks for: the viewer's idle sheet at the hero frame; a battle's three sheets a nation; a landing's walk
  for (const l of MOTION_LEADERS) {
    const size = m => statSync(new URL(motionSpriteUrl(l.key, m, '2x'))).size;
    assert.ok(size('idle') < 45_000, `${l.key}: the idle sheet is ${size('idle')}`);
    assert.ok(size('idle') + size('attack') + size('hit') < 125_000, `${l.key}: a battle's sheets`);
    assert.ok(size('walk') < 56_000);
  }
});

test('the portrait set: the hexagon icon, the bust, the stage still and its two clips; transparent, no larger than a dpr-2 screen needs, and no file that no screen asks for', () => {
  for (let f = 0; f < 6; f++) {
    const k = KEYS[f];
    assert.ok(ART.leaderHexUrl(f).endsWith(`/art/leaders3d/hex-v1/${k}@128.webp`), 'one icon file a leader: 128 px, sharp up to 64 px on a dpr-2 screen');
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderHexUrl(f)))), [128, 128, true]);
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderPortraitUrl(f)))), [320, 320, true]);
    assert.ok(ART.leaderStillUrl(f).endsWith(`/art/leaders3d/stage-v1/${k}.webp`));
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderStillUrl(f)))), [ART.STAGE_CELL.w, ART.STAGE_CELL.h, true]);
    for (const c of Object.values(ART.STAGE_CLIPS)) {
      assert.ok(ART.leaderStageUrl(f, c.key).endsWith(`/stage-v1/${k}_${c.key}.webp`));
      assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderStageUrl(f, c.key)))), [ART.STAGE_CELL.w * c.frames, ART.STAGE_CELL.h, true], `${k}_${c.key}`);
    }
    assert.ok(ART.leaderStageUrl(f, 'walk').endsWith(`/${k}_idle.webp`), 'a clip the stage does not have reads as idle');
  }
  // (the breath is quiet: four pictures across its two seconds, as the package's own idle sprite has)
  assert.deepEqual(ART.STAGE_CLIPS.idle, { key: 'idle', frames: 4, duration: 2, loop: true });
  assert.deepEqual(ART.STAGE_CLIPS.attack, { key: 'attack', frames: 8, duration: 0.8, loop: false });
  // nothing is shipped that no screen can ask for: every file under art/leaders3d is one the modules name
  const named = new Set();
  for (let f = 0; f < 6; f++) {
    for (const u of [ART.leaderHexUrl(f), ART.leaderPortraitUrl(f), ART.leaderStillUrl(f), ART.leaderStageUrl(f, 'idle'), ART.leaderStageUrl(f, 'attack')]) named.add(fileURLToPath(u));
    for (const m of LEADER_MOTIONS) for (const set of ['1x', '2x']) named.add(fileURLToPath(motionSpriteUrl(KEYS[f], m.key, set)));
  }
  const shipped = readdirSync(ART_DIR, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => fileURLToPath(new URL(e.name, new URL(`file://${e.parentPath ?? e.path}/`))));
  assert.deepEqual(shipped.filter(f => !named.has(f)), [], 'no unused file');
  assert.equal(shipped.length, 6 + 6 + 6 + 12 + 24 + 24);
});

test('the asset budget: the brief\'s 3 MB holds for the set that stays either way; with the sharp walk and hit sheets the total is under 3.5 MB, which awaits the owner\'s yes (DECISIONS ZQ3); a first screen needs a small part of it', () => {
  // (rewritten on 2026-10-10: this pinned 2.4 MB, the brief's limit being 3. The owner's "make it larger" needs frames
  // of 512 px for the characters on the board: 1,014,998 bytes more on disk, of which a screen fetches one sheet.
  // Rewritten again the same day after the review: the limit of the brief is 3 MB and only the owner can raise it. So
  // two things are pinned. What stays whatever the owner answers (everything but the 2x walk and hit sheets: with
  // them gone the landing and a blow taken are drawn from the owner's 256 px frames) is under the brief's 3 MB. The
  // whole as it stands is under 3.5 MB: a ceiling for the build while the question is open, not the brief's rule.)
  const total = dirBytes(ART_DIR);
  const optional = KEYS.reduce((n, k) => n + ['walk', 'hit'].reduce((m, c) => m + statSync(new URL(motionSpriteUrl(k, c, '2x'))).size, 0), 0);
  assert.equal(optional, 464_288, 'the 2x walk and hit sheets: what leaves if the owner keeps the limit at 3 MB');
  assert.ok(total - optional < 3_000_000, `without them art/leaders3d is ${total - optional} bytes: the brief's limit holds`);
  assert.ok(total < 3_500_000, `art/leaders3d is ${total} bytes`);
  // (the brief words the larger number as awaiting the owner's yes, never as the rule)
  const brief = readFileSync(new URL('../../docs/frontier/ux/UX-DESIGN.md', import.meta.url), 'utf8');
  assert.match(brief, /their total stays under 3 MB/);
  assert.match(brief, /awaiting the owner's yes/);
  assert.doesNotMatch(brief, /their total stays under 3\.5 MB/);
  assert.equal(total - dirBytes(new URL('motion-v1/sprite@2x/', ART_DIR)), 2_341_924, 'everything that was there before is as it was');
  const size = url => statSync(new URL(url)).size;
  const stills = KEYS.reduce((n, _, f) => n + size(ART.leaderStillUrl(f)), 0), idles = KEYS.reduce((n, _, f) => n + size(ART.leaderStageUrl(f, 'idle')), 0);
  const hex = KEYS.reduce((n, _, f) => n + size(ART.leaderHexUrl(f)), 0);
  assert.ok(stills < 120_000, `the six stills: ${stills}`);
  assert.ok(stills + idles < 400_000, `the title with motion: ${stills + idles}`);
  assert.ok(hex < 60_000, `the six small icons: ${hex}`);
});

test('leaderSvg: the hexagon icon up to 64 px, the portrait card above it; attributes only; the flat vector busts are gone', () => {
  setLang('ja');
  for (const l of LD.CHARACTERS) {
    const f = l.faction, k = KEYS[f], title = `${factionName(f)}`;
    const small = LD.leaderSvg(f, { size: 34 });
    assert.match(small, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="34" height="34" class="leader leader-hex" data-leader="${k}" aria-hidden="true" focusable="false"><image href="[^"]*/hex-v1/${k}@128\\.webp" width="100" height="100"/></svg>$`));
    assert.equal(LD.leaderSvg(f, { size: 64 }), LD.leaderHex(f, { size: 64 }), 'one source: the same icon whoever asks');
    const big = LD.leaderSvg(f, { size: 120, title });
    assert.match(big, /viewBox="0 0 240 300" width="120" height="150" class="leader leader-card-art"/);
    assert.ok(big.includes(`role="img" aria-label="${title}"`));
    assert.match(big, new RegExp(`<image href="[^"]*/portrait-v1/${k}\\.webp" x="-30" y="4" width="300" height="300"`), 'the bust, unstretched');
    assert.ok(big.includes(`<clipPath id="L${f}c">`) && big.includes(`clip-path="url(#L${f}c)"`), 'inside the rounded frame');
    assert.ok(big.includes(`stop-color="${FACTION_FILL[f]}"`) && big.includes(`stroke="${FACTION_FILL[f]}" stroke-width="7"`), 'a halo and a rim of the nation\'s colour');
    assert.match(big, /<clipPath id="L\d+c"><rect x="8" y="8" width="224" height="284" rx="12"\/><\/clipPath>/);
    assert.ok(big.indexOf('<image') < big.indexOf('<g transform="translate(206 34)">'), 'the sigil badge stays above the picture');
    assert.ok(big.includes(`fill="${FACTION_ON[f]}"`), 'the sigil in the colour that reads on the nation\'s fill');
    assert.match(LD.leaderSvg(f, { size: 40, shape: 'card' }), /leader-card-art/);
    assert.match(LD.leaderSvg(f, { size: 200, shape: 'hex' }), new RegExp(`leader-hex[^>]*>.*hex-v1/${k}@128\\.webp`), 'the one icon file at any size');
    for (const svg of [small, big, LD.leaderSvg(f, { size: 34, sigil: true }), LD.leaderFigure(f)]) {
      assert.doesNotMatch(svg, /style=|onload=|onerror=|<script/);
      // (the old busts: a head ellipse at cx 80, skin gradients, the costume paths)
      assert.doesNotMatch(svg, /<ellipse cx="80"|#e9c3a0|#c99a72|M100 150 L140 150/);
    }
    assert.match(LD.leaderSvg(f, { size: 34, sigil: true }), new RegExp(`<g transform="translate\\(79 79\\)"><circle r="17" fill="${FACTION_FILL[f]}"`));
  }
  assert.equal(LD.leaderSvg(9, { size: 34 }), LD.leaderSvg(0, { size: 34 }));
  assert.equal(LD.leaderSvg('1', { size: 200 }), LD.leaderSvg(0, { size: 200 }));
  // the source no longer draws a face
  const src = readFileSync(new URL('people/leaders.mjs', WEB), 'utf8');
  assert.doesNotMatch(src, /function face\(|function costume\(|const SKIN = /);
});

test('the leader standing: a canvas of one stage cell, marked for the sprite player (it names no picture: the player holds them); named on request, never mirrored', () => {
  const fig = LD.leaderFigure(3);
  assert.equal(fig, '<canvas class="lfig" width="288" height="360" data-leader="dunmar" data-motion="idle" aria-hidden="true" focusable="false"></canvas>');
  // (`flip` is not an option: Aster's badge, Cinder's clasp and Ember's emblem sit on one side, and a mirrored figure would move them)
  const one = LD.leaderFigure(5, { motion: 'attack', once: 'pick-5', when: 'look', flip: true, title: 'Torvald Hride', shadow: false });
  assert.equal(one, '<canvas class="lfig" width="288" height="360" data-leader="fjordal" data-motion="attack" data-once="pick-5" data-when="look" data-shadow="0" role="img" aria-label="Torvald Hride"></canvas>');
  assert.doesNotMatch(readFileSync(new URL('people/leaders.css', WEB), 'utf8'), /data-flip|scaleX\(-1\)/, 'no rule mirrors a figure');
  assert.doesNotMatch(fig + one, /\.webp|href=|src=/, 'no picture in the markup: writing it again fetches nothing');
  assert.match(LD.leaderFigure(0, { motion: 'nonsense' }), /data-motion="idle"/);
  assert.match(LD.leaderFigure(0, { motion: 'still' }), /data-motion="still"/);
});

test('the six characters are on every screen that shows a nation: nation cards, the crest chip, standings, the first-village banner; no leader is named', () => {
  setLang('ja');
  for (const l of LD.CHARACTERS) {
    const card = flat(leaderCard(l.faction));
    assert.match(card, new RegExp(`portrait-v1/${KEYS[l.faction]}\\.webp`));
    assert.ok(card.includes(factionName(l.faction))); assert.doesNotMatch(card, /leader-name|data-name/);
    assert.match(card, /leader-doctrine/); assert.match(card, /leader-text/);
    assert.match(flat(leaderCrest(l.faction)), new RegExp(`class="leader leader-hex" data-leader="${KEYS[l.faction]}"[^>]*>.*<g transform="translate\\(79 79\\)">`), 'the top plaque: the icon with the sigil at its foot');
    const banner = flat(renderBanner({ id: 'first-holding', kind: 'first-holding', p: 2, q: 0, site: 1, tier: 0 }, l.faction));
    assert.match(banner, new RegExp(`<span class="mile-fig"><canvas class="lfig" width="288" height="360" data-leader="${KEYS[l.faction]}" data-motion="idle"`), 'the leader stands by the line and breathes');
    assert.ok(banner.includes(`— ${factionName(l.faction)}</span>`), 'the words are the nation\'s'); assert.doesNotMatch(banner, /data-name/);
  }
  // the village plate: the viewer's face is their nation's character in the gold ring that says "yours" (the six are
  // the players: UX design 13.1), with or without a village
  for (let f = 0; f < 6; f++) {
    const plate = flat(renderPlate({ mode: 'play', playReady: true, citizen: { faction: f }, holdings: [], land: { stage: 'ticket' } }));
    assert.match(plate, new RegExp(`<span class="plate-face"><svg [^>]*width="48" height="48" class="leader leader-hex leader-own" data-leader="${KEYS[f]}" data-own="1"`), `${KEYS[f]}: the plate's face is the nation's character, marked as the viewer's own`);
    assert.doesNotMatch(plate, /class="avatar/);
  }
  const list = flat(renderStandingsList({ overviews: new Map() }));
  assert.deepEqual([...list.matchAll(/class="leader leader-hex" data-leader="(\w+)"/g)].map(m => m[1]), KEYS);
});

test('the nations\' colours are the leaders\' clothes, one table for the client; every mark keeps its contrast', () => {
  assert.deepEqual([...P.NATION_FILL], MOTION_LEADERS.map(l => l.color.toLowerCase()), 'the cloth colours of the motion package');
  assert.equal(FACTION_COLORS, P.NATION_FILL); assert.equal(FACTION_FILL, P.NATION_FILL);
  assert.equal(FACTION_DARK, P.NATION_DARK); assert.equal(FACTION_LIGHT, P.NATION_LIGHT);
  for (let f = 0; f < 6; f++) {
    const c = P.nationColors(f);
    assert.ok(P.contrast('#ffffff', c.dark) >= 4.5, `${KEYS[f]}: white text on the trim ${P.contrast('#ffffff', c.dark).toFixed(2)}`);
    assert.ok(P.contrast(c.on, c.fill) >= 4.5, `${KEYS[f]}: a sigil on the fill ${P.contrast(c.on, c.fill).toFixed(2)}`);
    assert.ok(P.contrast(c.mark, '#fffaf0') >= 3 && P.contrast(c.mark, '#e6d9b8') >= 3, `${KEYS[f]}: the mark on ivory and on parchment`);
    assert.ok(P.contrast(c.ink, '#e6d9b8') >= 4.5, `${KEYS[f]}: the ink on parchment`);
    assert.ok(P.contrast(c.fill, c.deep) >= 2, `${KEYS[f]}: the coat reads against the deep ground ${P.contrast(c.fill, c.deep).toFixed(2)}`);
    assert.ok(P.luminance(c.ink) < P.luminance(c.dark) && P.luminance(c.dark) < P.luminance(c.fill) && P.luminance(c.fill) <= P.luminance(c.light) + 0.02);
    // the crest: the sigil in the colour that reads on the shield; the person chip's badge and the emblem: the mark colour on ivory
    assert.ok(flat(crestSvg(f)).includes(`fill="${FACTION_ON[f]}"`));
    assert.ok(avatarSvg(null, f, { size: 48 }).includes(`fill="${FACTION_MARK[f]}"`));
    assert.ok(emblemSvg().includes(`fill="${FACTION_MARK[f]}"`));
  }
  assert.equal(P.nationColors(6), null); assert.equal(P.nationColors(-1), null);
  // the colour laid on the chart's parchment: the cloth's own for five nations; white is nothing on paper, so Ember's land is blue slate
  assert.deepEqual(P.NATION_LAND.map((c, f) => c === P.NATION_FILL[f]), [true, true, true, true, false, true]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(P.nationPale), [false, false, false, false, true, false, false]);
  assert.ok(P.contrast(P.NATION_FILL[4], '#e6d9b8') < 1.3, 'the white cloth on parchment: nothing');
  assert.ok(P.contrast(P.NATION_LAND[4], '#e6d9b8') >= 3, `Ember's line on parchment ${P.contrast(P.NATION_LAND[4], '#e6d9b8').toFixed(2)}`);
  // the stylesheet that carries them: the banners' cloth, the swatches, the unit cards' grounds
  const css = readFileSync(new URL('people/leaders.css', WEB), 'utf8');
  for (let f = 0; f < 6; f++) {
    assert.match(css, new RegExp(`\\.bn${f} \\{ --bn: ${P.NATION_FILL[f]}; --bn-hi: #[0-9a-f]{6}; --bn-deep-hi: ${P.NATION_DEEP[f]};`), `the banner's border is ${KEYS[f]}'s colour, its field the deep tone of the icon's ground`);
    assert.match(css, new RegExp(`\\.swatch\\.f${f} \\{ background-image: url\\("data:image/svg\\+xml,[^"]*fill='%23${P.NATION_FILL[f].slice(1)}' stroke='%23${P.NATION_INK[f].slice(1)}'`), 'a swatch is the sigil in the fill with an ink edge');
    assert.match(css, new RegExp(`\\.unit-card\\.f${f} \\{ --uc: ${P.NATION_LIGHT[f]}; --ucd: ${P.NATION_FILL[f]};`));
  }
  assert.doesNotMatch(css, /@keyframes|animation:/, 'no CSS animation: a leader\'s motion is the sprite player\'s (a still in reduced motion)');
  assert.match(css, /\.lfig \{ display: block; flex: none; width: auto; height: 120px; aspect-ratio: 4 \/ 5; \}/, 'a figure has a size before it is painted: nothing shifts');
  // every picture the stylesheet or the modules name exists, and the pages link the stylesheet after the client's own
  for (const page of ['index.html', 'practice.html', 'spectate.html']) assert.match(readFileSync(new URL(page, WEB), 'utf8'), /<link rel="stylesheet" href="frontier\.css">\n  <link rel="stylesheet" href="people\/leaders\.css">/);
  assert.ok(fileURLToPath(ART_DIR).endsWith('/frontier/art/leaders3d/'));
});

test('a home wedge on the chart is drawn in the land colour: Ember\'s wash and line are blue slate with a white core, never white on parchment', async () => {
  const { paintWedge } = await import('../../permutation-server/web/frontier/map/chart.mjs');
  // (node has no Path2D: the wedge's outline is built into a stand-in for the length of this test)
  const had = globalThis.Path2D;
  globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  test.after?.(() => { if (had) globalThis.Path2D = had; else delete globalThis.Path2D; });
  const paint = (f, lit) => {
    const ops = []; let alpha = 1, fill = '', stroke = '', width = 0;
    const g = { save() {}, restore() {}, fill() { ops.push(['fill', fill, alpha]); }, stroke() { ops.push(['stroke', stroke, width, alpha]); },
      set globalAlpha(v) { alpha = v; }, get globalAlpha() { return alpha; }, set fillStyle(v) { fill = v; }, set strokeStyle(v) { stroke = v; }, set lineWidth(v) { width = v; }, set lineCap(v) {}, set lineJoin(v) {} };
    paintWedge(g, f, 3, 1, { lit });
    return ops;
  };
  for (let f = 0; f < 6; f++) {
    const ops = paint(f, true);
    assert.equal(ops.length, 5, `${KEYS[f]}: a wash and four strokes`);
    assert.deepEqual(ops[0].slice(0, 2), ['fill', P.NATION_LAND[f]]);
    assert.deepEqual(ops.filter(o => o[0] === 'stroke').map(o => o[1]).slice(0, 3), [P.NATION_LAND[f], 'rgba(22,30,26,.9)', P.NATION_LAND[f]], 'a glow, the dark underlay, the coloured line');
    assert.ok(!ops.some(o => o[1] === P.NATION_FILL[4] && f === 4), 'no white wash or white line of the cloth');
  }
  const ember = paint(4, true), aster = paint(0, true);
  assert.ok(ember[0][2] > aster[0][2], 'the slate veil is laid a little stronger than a colour');
  assert.deepEqual(ember.at(-1).slice(0, 2), ['stroke', '#ffffff'], 'a white core: the white nation\'s border');
  assert.ok(paint(4, false)[0][2] < ember[0][2], 'the wedge that is only waited in is quieter than the one looked at');
});
