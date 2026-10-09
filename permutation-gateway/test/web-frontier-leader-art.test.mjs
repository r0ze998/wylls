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
import { MOTION_LEADERS, LEADER_MOTIONS, LEADER_SPRITE_CELL, motionSpriteUrl } from '../../permutation-server/web/frontier/leader-motion-data.mjs';
import * as P from '../../permutation-server/web/frontier/palette.mjs';
import { FACTION_FILL, FACTION_DARK, FACTION_LIGHT, FACTION_ON, FACTION_MARK, avatarSvg } from '../../permutation-server/web/frontier/people/avatar.mjs';
import { FACTION_COLORS } from '../../permutation-server/web/frontier/fi18n.mjs';
import { leaderCard } from '../../permutation-server/web/frontier/people/ui.mjs';
import { crestSvg, leaderCrest, renderStandingsList } from '../../permutation-server/web/frontier/hud/hud.mjs';
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
  assert.equal(LD.LEADERS.length, 6);
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

test('the portrait set: hexagon icons at two sizes, the bust, the stage still and its two clips; transparent, and no larger than a dpr-2 screen needs', () => {
  for (let f = 0; f < 6; f++) {
    const k = KEYS[f];
    assert.ok(ART.leaderHexUrl(f, 34).endsWith(`/art/leaders3d/hex-v1/${k}@128.webp`), 'up to 64 px: the 128 px file');
    assert.ok(ART.leaderHexUrl(f, 64).endsWith(`/hex-v1/${k}@128.webp`));
    assert.ok(ART.leaderHexUrl(f, 96).endsWith(`/hex-v1/${k}@256.webp`), 'above it: the 256 px file');
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderHexUrl(f, 64)))), [128, 128, true]);
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderHexUrl(f, 128)))), [256, 256, true]);
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderPortraitUrl(f)))), [320, 320, true]);
    assert.ok(ART.leaderStillUrl(f).endsWith(`/art/leaders3d/stage-v1/${k}.webp`));
    assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderStillUrl(f)))), [ART.STAGE_CELL.w, ART.STAGE_CELL.h, true]);
    for (const c of Object.values(ART.STAGE_CLIPS)) {
      assert.ok(ART.leaderStageUrl(f, c.key).endsWith(`/stage-v1/${k}_${c.key}.webp`));
      assert.deepEqual((({ w, h, alpha }) => [w, h, alpha])(webpSize(new URL(ART.leaderStageUrl(f, c.key)))), [ART.STAGE_CELL.w * c.frames, ART.STAGE_CELL.h, true], `${k}_${c.key}`);
    }
    assert.ok(ART.leaderStageUrl(f, 'walk').endsWith(`/${k}_idle.webp`), 'a clip the stage does not have reads as idle');
  }
  assert.deepEqual(ART.STAGE_CLIPS.idle, { key: 'idle', frames: 8, duration: 2, loop: true });
  assert.deepEqual(ART.STAGE_CLIPS.attack, { key: 'attack', frames: 8, duration: 0.8, loop: false });
});

test('the asset budget: everything the leaders add stays under 3 MB, and a first screen needs a small part of it', () => {
  const total = dirBytes(ART_DIR);
  assert.ok(total < 3_000_000, `art/leaders3d is ${total} bytes`);
  const size = url => statSync(new URL(url)).size;
  const stills = KEYS.reduce((n, _, f) => n + size(ART.leaderStillUrl(f)), 0), idles = KEYS.reduce((n, _, f) => n + size(ART.leaderStageUrl(f, 'idle')), 0);
  const hex = KEYS.reduce((n, _, f) => n + size(ART.leaderHexUrl(f, 34)), 0);
  assert.ok(stills < 120_000, `the six stills: ${stills}`);
  assert.ok(stills + idles < 700_000, `the title with motion: ${stills + idles}`);
  assert.ok(hex < 60_000, `the six small icons: ${hex}`);
});

test('leaderSvg: the hexagon icon up to 64 px, the portrait card above it; attributes only; the flat vector busts are gone', () => {
  setLang('ja');
  for (const l of LD.LEADERS) {
    const f = l.faction, k = KEYS[f], title = `${l.name.ja}、${l.title()}`;
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
    assert.match(LD.leaderSvg(f, { size: 200, shape: 'hex' }), new RegExp(`leader-hex[^>]*>.*hex-v1/${k}@256\\.webp`));
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

test('the leader standing: a canvas of one stage cell, marked for the sprite player (it names no picture: the player holds them); mirrored and named on request', () => {
  const fig = LD.leaderFigure(3);
  assert.equal(fig, '<canvas class="lfig" width="288" height="360" data-leader="dunmar" data-motion="idle" aria-hidden="true" focusable="false"></canvas>');
  const one = LD.leaderFigure(5, { motion: 'attack', once: 'pick-5', when: 'look', flip: true, title: 'Torvald Hride', shadow: false });
  assert.equal(one, '<canvas class="lfig" width="288" height="360" data-leader="fjordal" data-motion="attack" data-once="pick-5" data-when="look" data-flip="1" data-shadow="0" role="img" aria-label="Torvald Hride"></canvas>');
  assert.doesNotMatch(fig + one, /\.webp|href=|src=/, 'no picture in the markup: writing it again fetches nothing');
  assert.match(LD.leaderFigure(0, { motion: 'nonsense' }), /data-motion="idle"/);
  assert.match(LD.leaderFigure(0, { motion: 'still' }), /data-motion="still"/);
});

test('the leaders are on every screen that names them: faction cards, the crest chip, standings, the first-village banner', () => {
  setLang('ja');
  for (const l of LD.LEADERS) {
    const card = flat(leaderCard(l.faction));
    assert.match(card, new RegExp(`portrait-v1/${KEYS[l.faction]}\\.webp`));
    assert.ok(card.includes(l.name.ja) || card.includes(l.name.en));
    assert.match(card, /leader-doctrine/); assert.match(card, /leader-text/);
    assert.match(flat(leaderCrest(l.faction)), new RegExp(`class="leader leader-hex" data-leader="${KEYS[l.faction]}"[^>]*>.*<g transform="translate\\(79 79\\)">`), 'the top plaque: the icon with the sigil at its foot');
    const banner = flat(renderBanner({ id: 'first-holding', kind: 'first-holding', p: 2, q: 0, site: 1, tier: 0 }, l.faction));
    assert.match(banner, new RegExp(`<span class="mile-fig"><canvas class="lfig" width="288" height="360" data-leader="${KEYS[l.faction]}" data-motion="idle"`), 'the leader stands by the line and breathes');
    assert.ok(banner.includes(l.name.ja));
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
