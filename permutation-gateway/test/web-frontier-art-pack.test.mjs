// The owner's handover pack of 2026-10-10 in the client (permutation-server/web/frontier/art/README.md): the soldiers
// (people/minis.mjs), the illustrated icons (hud/icons.mjs), the sprite-sheet effects (fx/sheetfx.mjs) and the
// characters' new sheets with the victory pose (leader-motion-data.mjs, people/leader-motion.mjs), all behind one
// switch (art/pack.mjs): shown where the season runs the conquest program, and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { artPackOn, forceArtPack, onArtPack } from '../../permutation-server/web/frontier/art/pack.mjs';
import * as MINIS from '../../permutation-server/web/frontier/people/minis.mjs';
import * as ICONS from '../../permutation-server/web/frontier/hud/icons.mjs';
import * as MD from '../../permutation-server/web/frontier/leader-motion-data.mjs';
import * as LM from '../../permutation-server/web/frontier/people/leader-motion.mjs';
import * as SF from '../../permutation-server/web/frontier/fx/sheetfx.mjs';
import { createEngine } from '../../permutation-server/web/frontier/fx/engine.mjs';
import { createClock } from '../../permutation-server/web/frontier/fx/clock.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { PHASE, BATTLE_HITS, battlePlan } from '../../permutation-server/web/frontier/people/battle.mjs';
import { NATION_FILL, NATION_KEYS } from '../../permutation-server/web/frontier/palette.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { project } from '../../permutation-server/web/map.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const ART = new URL('art/', WEB);
const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
const CONQUEST = { layoutVersion: 2, programVersion: 3 }, BASIC = { layoutVersion: 1, programVersion: 2 };

/** Width and height of a WebP file (VP8X, lossless and lossy headers). */
function webpSize(url) {
  const b = readFileSync(url);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.toString('ascii', 8, 12), 'WEBP');
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), alpha: !!(b[20] & 0x10) };
  if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff), alpha: !!((n >> 28) & 1) }; }
  return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, alpha: false };
}
const files = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => fileURLToPath(new URL(e.name, new URL(`file://${e.parentPath ?? e.path}/`))));
const bytes = dir => files(dir).reduce((n, f) => n + statSync(f).size, 0);
const sha = url => createHash('sha256').update(readFileSync(url)).digest('hex');
const with_ = (season, fn) => { const was = FS.season; forceArtPack(null); FS.season = season; try { return fn(); } finally { FS.season = was; forceArtPack(null); } };

// ---- a context that records what is drawn, and images a test loads by hand
function recorder() {
  const calls = [];
  const ctx = new Proxy({ globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' }, { get(t, k) { if (k in t) return t[k]; if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); return (...a) => { calls.push([k, ...a]); }; }, set(t, k, v) { t[k] = v; return true; }, has: (t, k) => k in t });
  return { ctx, calls, draws: () => calls.filter(c => c[0] === 'drawImage') };
}
const requests = [];
class FakeImage { constructor() { requests.push(this); } set src(v) { this._src = v; } get src() { return this._src; } load(w, h) { this.width = w; this.height = h; this.onload?.(); } fail() { this.onerror?.(); } }
const find = part => requests.findLast(r => r.src?.includes(part));

test('the switch: the pack is shown on a conquest season (layout 2, program 3 or more) and nowhere else', () => {
  with_(null, () => assert.equal(artPackOn(), false));
  with_(BASIC, () => assert.equal(artPackOn(), false));
  with_({ layoutVersion: 2, programVersion: 2 }, () => assert.equal(artPackOn(), false));
  with_(CONQUEST, () => assert.equal(artPackOn(), true));
  with_({ layoutVersion: 2, programVersion: 4 }, () => assert.equal(artPackOn(), true));
  // a listener hears the season arrive, once
  const said = [];
  const off = onArtPack(on => said.push(on));
  with_(null, () => { artPackOn(); FS.season = CONQUEST; artPackOn(); artPackOn(); });
  off();
  assert.deepEqual(said.filter(Boolean).length >= 1, true);
  // held by hand (a test, a demo sample)
  forceArtPack(true); assert.equal(artPackOn(), true);
  forceArtPack(false); FS.season = CONQUEST; assert.equal(artPackOn(), false);
  forceArtPack(null); FS.season = null; assert.equal(artPackOn(), false);
});

test('the soldiers: the sheets and cards of the pack in this client\'s own layout; the host painter reads them on a conquest season and the earlier ones elsewhere', () => {
  for (let f = 0; f < 6; f++) {
    assert.deepEqual(webpSize(new URL(`units/${MINIS.MOB_PACK}/@1x/units_${f}.webp`, ART)), { w: 160 * 6, h: 160 * 8, alpha: true });
    assert.deepEqual(webpSize(new URL(`units/${MINIS.MOB_PACK}/@2x/units_${f}.webp`, ART)), { w: 320 * 6, h: 320 * 8, alpha: true });
    for (const k of MINIS.MINI_KINDS) assert.deepEqual((({ w, h }) => [w, h])(webpSize(new URL(`units/${MINIS.MOB_PACK}/cards/${f}_${k}.webp`, ART))), [240, 300], `${f}_${k}`);
  }
  assert.equal(files(new URL(`units/${MINIS.MOB_PACK}/`, ART)).length, 6 + 6 + 48);
  // (the pack's own atlas of Aster at 160 px, byte for byte: 03_モブ8種6陣営/atlas/faction-0@1x.webp)
  assert.equal(statSync(new URL(`units/${MINIS.MOB_PACK}/@1x/units_0.webp`, ART)).size, 217386);
  with_(BASIC, () => assert.ok(MINIS.miniCardUrl(2, 'knight').endsWith('/art/units/cards/2_knight.webp')));
  with_(CONQUEST, () => { assert.ok(MINIS.miniCardUrl(2, 'knight').endsWith('/art/units/mobs-v1/cards/2_knight.webp')); assert.ok(MINIS.miniCardUrl(9, 'nobody').endsWith('/mobs-v1/cards/0_spearman.webp')); });

  const was = globalThis.Image; globalThis.Image = FakeImage;
  try {
    const { ctx, draws } = recorder();
    // the basic game: the earlier sheet, as before
    with_(BASIC, () => { MINIS.paintMini(ctx, 0, 0, 30, 'spearman', { faction: 1 }); });
    assert.ok(find('/art/units/@1x/units_1.webp')); assert.equal(find('/mobs-v1/@1x/units_1.webp'), undefined);
    with_(CONQUEST, () => {
      assert.equal(MINIS.paintMini(ctx, 0, 0, 30, 'spearman', { faction: 1 }), false, 'on its way: the caller draws its stand-in');
      const sheet = find('/art/units/mobs-v1/@1x/units_1.webp');
      assert.ok(sheet);
      assert.equal(find('/mobs-v1/@2x/units_1.webp'), undefined, 'a small figure asks for the small sheet alone: the large one is not fetched as a stand-in');
      sheet.load(960, 1280);
      assert.equal(MINIS.paintMini(ctx, 10, 20, 30, 'archer', { faction: 1, face: -1, walking: true, step: 0.6 }), true);
      const d = draws().at(-1);
      assert.equal(d[1], sheet);
      assert.deepEqual(d.slice(2, 6), [5 * 160, 1 * 160, 160, 160], 'the same cell as before: row by kind, column by facing and step');
      // a sheet of the pack that fails, or has another shape, falls back to the earlier sheet of that nation
      MINIS.paintMini(ctx, 0, 0, 30, 'scout', { faction: 3 });
      find('/mobs-v1/@1x/units_3.webp').fail();
      assert.equal(MINIS.paintMini(ctx, 0, 0, 30, 'scout', { faction: 3 }), false);
      const old = find('/art/units/@1x/units_3.webp');
      assert.ok(old && !old.src.includes('mobs-v1'));
      old.load(960, 1280);
      assert.equal(MINIS.paintMini(ctx, 0, 0, 30, 'scout', { faction: 3 }), true);
      MINIS.paintMini(ctx, 0, 0, 30, 'scout', { faction: 4 });
      find('/mobs-v1/@1x/units_4.webp').load(512, 512);
      assert.equal(MINIS.paintMini(ctx, 0, 0, 30, 'scout', { faction: 4 }), false, 'a file of another shape is not cut into cells');
    });
  } finally { globalThis.Image = was; }
});

test('the icons: thirteen pictures in three sizes; icon() swaps the resources, the wall and the helmet on a conquest season only', () => {
  assert.deepEqual(ICONS.ART_ICONS, ['food', 'wood', 'stone', 'ore', 'horse', 'gold', 'science', 'influence', 'troops', 'stamina', 'walls', 'works', 'territory']);
  for (const k of ICONS.ART_ICONS) for (const s of [32, 64, 128]) assert.deepEqual(webpSize(new URL(`ui/illustrated/${k}-${s}.webp`, ART)), { w: s, h: s, alpha: true }, `${k}-${s}`);
  assert.equal(files(new URL('ui/illustrated/', ART)).length, 39);
  with_(BASIC, () => {
    assert.match(String(ICONS.icon('grain', 'res-ic')), /^<svg class="ic res-ic"[^>]*><use href="art\/ui\/icons\.svg#grain"\/><\/svg>$/);
    assert.match(String(ICONS.resourceIcon('Food')), /#grain/);
    assert.match(String(ICONS.icon('shield', 'res-c-Walls')), /#shield/);
  });
  with_(CONQUEST, () => {
    for (const [glyph, art] of Object.entries(ICONS.ART_OF)) {
      const m = String(ICONS.icon(glyph, 'res-ic'));
      assert.match(m, new RegExp(`^<img class="ic ic-art ic-art-${art} res-ic" src="art/ui/illustrated/${art}-32\\.webp" srcset="art/ui/illustrated/${art}-32\\.webp 1x, art/ui/illustrated/${art}-64\\.webp 2x, art/ui/illustrated/${art}-128\\.webp 4x" width="32" height="32" alt="" aria-hidden="true" decoding="async">$`));
      assert.doesNotMatch(m, /style=|on\w+=/);
    }
    for (const [res, art] of Object.entries(ICONS.RESOURCE_ART)) { assert.match(String(ICONS.icon(ICONS.RESOURCE_ICON[res])), new RegExp(`ic-art-${art}\\b`)); assert.match(String(ICONS.resourceIcon(res)), new RegExp(`ic-art-${art}\\b`)); }
    assert.match(String(ICONS.icon('shield', 'res-c-Walls')), /ic-art-walls/, 'the walls of a village are asked for as a shield in the walls\' colour class');
    assert.match(String(ICONS.icon('shield')), /#shield/, 'a shield anywhere else stays a shield');
    // navigation and action icons stay the sprite's
    for (const name of ['bell', 'sword', 'banner', 'flag', 'home', 'scout', 'hammer', 'close', 'ranks']) assert.match(String(ICONS.icon(name)), /^<svg class="ic"/, name);
    assert.match(String(ICONS.resourceIcon('Nonsense')), /#crate/);
  });
  // by its own name a picture is given on any page (a caller that asks for it wants it); an unknown key is the crate
  assert.match(String(ICONS.artIcon('territory', 'x')), /ic-art-territory x"/);
  assert.match(String(ICONS.artIcon('nonsense')), /#crate/);
  // the stylesheet the pictures are sized by is in the client and carries no remote address
  const css = readFileSync(new URL('art.css', ART), 'utf8');
  assert.match(css, /img\.ic-art/); assert.doesNotMatch(css, /url\(|@import|https?:/);
});

test('the characters: the pack\'s sheets (idle, walk, attack, hit, victory) in two sizes; the first pack\'s table and files are untouched', () => {
  const frames1 = { idle: 4, walk: 8, attack: 8, hit: 4, victory: 12 }, frames2 = { ...frames1, idle: 8 };
  for (const k of KEYS) for (const [m, n] of Object.entries(frames1)) {
    assert.deepEqual(webpSize(new URL(`leaders3d/motion-v2/sprite/${k}_${m}.webp`, ART)), { w: 256 * n, h: 256, alpha: true }, `${k}_${m}`);
    assert.deepEqual(webpSize(new URL(`leaders3d/motion-v2/sprite@2x/${k}_${m}.webp`, ART)), { w: 512 * frames2[m], h: 512, alpha: true }, `${k}_${m}@2x`);
  }
  assert.equal(files(new URL('leaders3d/motion-v2/', ART)).length, 60);
  // (the pack's own files, byte for byte: 01_リーダー最新版/sprite/aster_idle.webp and Aster's corrected walk, 02_歩行最新版/aster_walk.webp)
  assert.equal(sha(new URL('leaders3d/motion-v2/sprite/aster_idle.webp', ART)).slice(0, 12), 'f9dd8085e91a');
  assert.equal(sha(new URL('leaders3d/motion-v2/sprite/aster_walk.webp', ART)).slice(0, 12), '67b720a81f28');
  assert.notEqual(sha(new URL('leaders3d/motion-v2/sprite/aster_walk.webp', ART)), sha(new URL('leaders3d/motion-v1/sprite/aster_walk.webp', ART)), 'Aster walks the corrected walk');
  assert.equal(sha(new URL('leaders3d/motion-v2/sprite/ember_walk.webp', ART)), sha(new URL('leaders3d/motion-v1/sprite/ember_walk.webp', ART)), 'the other five keep their walk, as the pack says');

  assert.deepEqual(MD.LEADER_MOTIONS.map(m => m.key), ['idle', 'walk', 'attack', 'hit'], 'the first pack\'s table: what a scene\'s choreography is timed by');
  assert.deepEqual(MD.LEADER_MOTIONS_V2.map(m => [m.key, m.clip, m.frames, m.duration, m.loop]), [['idle', 'Idle_Action', 4, 2, true], ['walk', 'Walk', 8, 1, true], ['attack', 'Attack_Action', 8, 1, false], ['hit', 'Hit_Action', 4, 0.55, false], ['victory', 'Victory_Action', 12, 1.7, false]]);
  with_(BASIC, () => {
    assert.ok(MD.motionSpriteUrl('cinder', 'attack', '2x').endsWith('/motion-v1/sprite@2x/cinder_attack.webp'));
    assert.equal(MD.motionSelection('cinder', 'victory').motion.key, 'idle', 'the first pack has no victory: it reads as the idle');
    assert.equal(MD.cueLeaderMotion('cinder', 'victory'), null);
  });
  with_(CONQUEST, () => {
    for (const k of KEYS) for (const m of Object.keys(frames1)) for (const [set, folder] of [['1x', 'sprite'], ['2x', 'sprite@2x']]) {
      const url = MD.motionSpriteUrl(k, m, set);
      assert.ok(url.endsWith(`/art/leaders3d/motion-v2/${folder}/${k}_${m}.webp`)); assert.ok(existsSync(new URL(url)));
    }
    assert.equal(MD.motionSelection('aster', 'walk').motion.clip, 'Walk_Kimodo');
    for (const k of KEYS.slice(1)) assert.equal(MD.motionSelection(k, 'walk').motion.clip, 'Walk');
    assert.equal(MD.motionInSet(MD.motionSelection('ember', 'idle').motion, '2x').frames, 8);
    assert.equal(MD.motionInSet(MD.motionSelection('ember', 'victory').motion, '2x').frames, 12);
  });
});

test('the victory pose: a cue turns a standing character\'s idle into the one-shot for its length, near its place only, and never where the pack is not shown', () => {
  const was = globalThis.Image, wasNow = globalThis.__fxNow; globalThis.Image = FakeImage;
  let now = 100; globalThis.__fxNow = () => now;
  try {
    with_(CONQUEST, () => {
      const { ctx, draws } = recorder();
      LM.paintLeaderMotion(ctx, 0, 0, 30, { leader: 'dunmar' });
      find('/motion-v2/sprite/dunmar_idle.webp').load(1024, 256);
      const cue = MD.cueLeaderMotion('dunmar', 'victory', { at: 101, secs: 1.7, near: { x: 0, y: 0, r: 200 } });
      assert.deepEqual(cue, { motion: 'victory', t0: 101, secs: 1.7, near: { x: 0, y: 0, r: 200 } });
      // before it begins: the idle, and the painting asks for the pose's sheet ahead of it
      assert.equal(MD.leaderCueAt('dunmar', 0, 0), null);
      assert.equal(find('/motion-v2/sprite/dunmar_victory.webp'), undefined);
      LM.paintLeaderMotion(ctx, 0, 0, 30, { leader: 'dunmar' });
      const sheet = find('/motion-v2/sprite/dunmar_victory.webp');
      assert.ok(sheet, 'the pose\'s sheet is asked for by the first painting after the cue');
      assert.equal(draws().at(-1)[1].src.endsWith('dunmar_idle.webp'), true);
      now = 101.85;
      { const c = MD.leaderCueAt('dunmar', 0, 0); assert.equal(c.motion, 'victory'); assert.ok(Math.abs(c.share - 0.5) < 1e-9); }
      LM.paintLeaderMotion(ctx, 0, 0, 30, { leader: 'dunmar' });
      assert.equal(draws().at(-1)[1].src.endsWith('dunmar_idle.webp'), true);
      sheet.load(3072, 256);
      LM.paintLeaderMotion(ctx, 0, 0, 30, { leader: 'dunmar', breath: 1 });
      let d = draws().at(-1);
      assert.equal(d[1], sheet);
      assert.ok([5 * 256, 6 * 256].includes(d[2]), 'the frame its share of the pose calls for: the middle of twelve');
      // a figure of that character standing far from the cue's place keeps its idle; one that walks or strikes keeps its clip
      LM.paintLeaderMotion(ctx, 900, 0, 30, { leader: 'dunmar' });
      assert.equal(draws().at(-1)[1].src.endsWith('dunmar_idle.webp'), true);
      assert.equal(MD.leaderCueAt('aster', 0, 0), null, 'another character has no cue');
      // once: after its length the idle is back
      now = 102.8;
      assert.equal(MD.leaderCueAt('dunmar', 0, 0), null);
      LM.paintLeaderMotion(ctx, 0, 0, 30, { leader: 'dunmar' });
      assert.equal(draws().at(-1)[1].src.endsWith('dunmar_idle.webp'), true);
      // a looping clip or an unknown one is no cue; a cue can be taken away
      assert.equal(MD.cueLeaderMotion('dunmar', 'walk'), null);
      assert.equal(MD.cueLeaderMotion('dunmar', 'nonsense'), null);
      MD.cueLeaderMotion('dunmar', 'victory', { at: now });
      assert.ok(MD.leaderCueAt('dunmar', 5000, 5000), 'without a place every standing figure of the character plays it');
      assert.equal(MD.clearLeaderCue('dunmar'), true);
      assert.equal(MD.leaderCueAt('dunmar', 0, 0), null);
      // the module that sets a cue is not a painter: it asks the data module, never the map painter (the truth rule's pin on who draws a character)
      assert.doesNotMatch(readFileSync(new URL('fx/sheetfx.mjs', WEB), 'utf8'), /leader-motion\.mjs|paintLeaderMotion|motionSpriteUrl|leaderMotionSheet/);
    });
  } finally { globalThis.Image = was; globalThis.__fxNow = wasNow; }
});

test('the effects: eleven clips in two sizes, each atlas the grid its clip needs; the frame of a clip by its age and the motion level', () => {
  for (const [name, c] of Object.entries(SF.SHEET_CLIPS)) for (const variant of c.nations ? KEYS : ['neutral']) for (const size of SF.SHEET_SIZES) {
    const url = new URL(`vfx/${SF.SHEET_PACK}/${name}/${variant}/atlas-${size}.webp`, ART);
    assert.deepEqual(webpSize(url), { w: size * SF.SHEET_COLS, h: size * Math.ceil(c.frames / SF.SHEET_COLS), alpha: true }, `${name}/${variant}/${size}`);
    assert.equal(SF.sheetUrl(name, size, c.nations ? KEYS.indexOf(variant) : null), url.href);
  }
  assert.equal(files(new URL('vfx/', ART)).length, 22);
  assert.deepEqual(Object.fromEntries(Object.entries(SF.SHEET_CLIPS).map(([k, c]) => [k, [c.frames, c.secs]])), { select: [18, 0.75], depart: [24, 1], impact: [12, 0.5], hit: [15, 0.625], build_complete: [24, 1], capture: [30, 1.25] });
  for (const c of Object.values(SF.SHEET_CLIPS)) assert.equal(c.frames / SF.SHEET_FPS, c.secs, 'frames at 24 a second');
  assert.deepEqual(NATION_KEYS, KEYS);
  assert.ok(SF.sheetUrl('capture', 256, 9).includes('/capture/aster/'), 'no nation reads as the first');
  // a one-shot: its frames, then nothing; the selection stays on its last frame
  assert.equal(SF.sheetFrame('capture', 0), 0); assert.equal(SF.sheetFrame('capture', 0.5), 12); assert.equal(SF.sheetFrame('capture', 1.24), 29); assert.equal(SF.sheetFrame('capture', 1.25), null);
  assert.equal(SF.sheetFrame('select', 0.74), 17); assert.equal(SF.sheetFrame('select', 500), 17);
  assert.equal(SF.sheetFrame('hit', -0.1), null); assert.equal(SF.sheetFrame('nonsense', 0), null);
  // reduced motion: the poster for a fifth of a second (the selection: its last frame, held); off: nothing
  assert.equal(SF.sheetFrame('build_complete', 0.1, 'reduced'), 11); assert.equal(SF.sheetFrame('build_complete', 0.3, 'reduced'), null);
  assert.equal(SF.sheetFrame('select', 0, 'reduced'), 17); assert.equal(SF.sheetFrame('select', 9, 'reduced'), 17);
  for (const e of Object.keys(SF.SHEET_CLIPS)) assert.equal(SF.sheetFrame(e, 0.1, 'off'), null);
});

test('a clip is drawn with its ground point on the tile\'s centre and its tile as wide as the map\'s', () => {
  const was = globalThis.Image; globalThis.Image = FakeImage;
  try {
    const { ctx, draws } = recorder();
    assert.equal(SF.paintSheet(ctx, 'capture', { x: 100, y: 50, age: 0.5, f: 2 }), false, 'until an atlas is here nothing is drawn');
    const a128 = find('/capture/cinder/atlas-128.webp');
    assert.ok(a128, 'a small cell asks for the 128 px atlas');
    assert.equal(find('/capture/cinder/atlas-256.webp'), undefined, 'and for that one alone');
    a128.load(1024, 512);
    assert.equal(SF.paintSheet(ctx, 'capture', { x: 100, y: 50, age: 0.5, f: 2 }), true);
    const d = draws().at(-1), w = SF.TILE_WIDTH / SF.SHEET_TILE;
    assert.equal(d[1], a128);
    assert.deepEqual(d.slice(2, 6), [(12 % 8) * 128, 1 * 128, 128, 128], 'frame 12 of a grid of 8 columns');
    assert.ok(Math.abs(d[6] - (100 - w * SF.SHEET_ANCHOR[0])) < 1e-9 && Math.abs(d[7] - (50 - w * SF.SHEET_ANCHOR[1])) < 1e-9 && Math.abs(d[8] - w) < 1e-9 && d[9] === d[8]);
    assert.ok(Math.abs(w * SF.SHEET_TILE - Math.sqrt(3) * 44) < 1e-9, 'the clip\'s nominal tile is a tile of the map');
    // drawn large it asks for the 256 px atlas, and draws the one that is here until that has come
    assert.equal(SF.paintSheet(ctx, 'capture', { x: 0, y: 0, age: 0.5, f: 2, px: 2 }), true);
    assert.equal(draws().at(-1)[1], a128);
    find('/capture/cinder/atlas-256.webp').load(2048, 1024);
    SF.paintSheet(ctx, 'capture', { x: 0, y: 0, age: 0.5, f: 2, px: 2 });
    assert.equal(draws().at(-1)[1].src.includes('/atlas-256.webp'), true);
    // an effect that was asked for at the play zoom's size serves a smaller cell too: no second file
    SF.preloadSheets(['depart']);
    const d256 = find('/depart/neutral/atlas-256.webp'); d256.load(2048, 768);
    assert.equal(SF.paintSheet(ctx, 'depart', { x: 0, y: 0, age: 0.5 }), true);
    assert.equal(draws().at(-1)[1], d256);
    assert.equal(find('/depart/neutral/atlas-128.webp'), undefined);
    // over: nothing; an atlas of another shape is never cut into frames
    assert.equal(SF.paintSheet(ctx, 'capture', { x: 0, y: 0, age: 1.3, f: 2 }), false);
    SF.paintSheet(ctx, 'hit', { x: 0, y: 0, age: 0.1 });
    for (const r of requests.filter(q => q.src?.includes('/hit/neutral/'))) r.load(640, 480);
    assert.equal(SF.paintSheet(ctx, 'hit', { x: 0, y: 0, age: 0.1 }), false);
  } finally { globalThis.Image = was; }
});

// ---- the page's events, on an engine and a bus of the test's own
function stage() {
  let ms = 0;
  const clock = createClock({ now: () => ms }), bus = createBus();
  const fx = createEngine({ clock, bus, motion: () => stage.motion, audio: () => ({ play() {} }) });
  const canvas = { ownerDocument: null, clientWidth: 1200, clientHeight: 800, dataset: {} };
  fx.mount({ canvas, camera: () => ({ x: 0, y: 0, zoom: 1 }), size: () => ({ width: 100000, height: 100000 }) });
  const handle = SF.installSheetFx(fx, { bus });
  return { fx, bus, handle, tick: s => { ms += s * 1000; }, sheets: () => fx.playing().filter(n => n.startsWith('sheet')) };
}
stage.motion = 'full';
const SCENE = () => ({ p: 0, q: 0, bell: 9, tiles: [{ idx: 30, attackers: [{ id: 'a', faction: 0, unit: 0, stance: 1, before: 900, after: 700, fate: 'Stays', kind: 'arrival' }], defenders: [{ id: 'd', faction: 2, unit: 3, stance: 0, before: 500, after: 0, fate: 'Destroyed', kind: 'resident' }] }] });

test('the sprites hang on the records\' own events, on a conquest season only; a departure and a finished building are played once', async () => {
  const S = stage();
  // the basic game: the same events add nothing
  with_(BASIC, () => { S.bus.emit('moment', { kind: 'depart', p: 0, q: 0, tile: 30, id: 'h1' }); S.bus.emit('moment', { kind: 'built', p: 0, q: 0, tile: 30, site: 0 }); S.bus.emit('keep:captured', { p: 0, q: 0, tile: 30, from: 1, to: 0, turn: 9, mine: true }); });
  assert.deepEqual(S.sheets(), []);
  FS.season = CONQUEST;
  try {
    S.bus.emit('moment', { kind: 'depart', p: 0, q: 0, tile: 30, id: 'h1' });
    assert.deepEqual(S.sheets(), ['sheet-depart']);
    // the board says the same departure of the viewer's own host: not twice
    S.bus.emit('board:left', { host: 'h1', p: 0, q: 0, tile: 30, faction: 0 });
    assert.deepEqual(S.sheets(), ['sheet-depart']);
    S.bus.emit('board:left', { host: 'h2', p: 0, q: 0, tile: 31, faction: 0 });
    assert.deepEqual(S.sheets(), ['sheet-depart', 'sheet-depart'], 'another tile is another departure');
    S.bus.emit('moment', { kind: 'built', p: 0, q: 0, tile: 30, site: 0, own: true });
    S.bus.emit('moment', { kind: 'built', p: 0, q: 0, tile: 30, site: 0, own: true });
    assert.equal(S.sheets().filter(n => n === 'sheet-build_complete').length, 1);
    // the viewer's own sealed Depart, confirmed: the dust rises under the column the page sets off on that event, once;
    // the record of that host's leaving, served up to a turn later, plays nothing more for it
    assert.equal(SF.SHEET_DEPART_ON_SEAL, true);
    S.bus.emit('march:sealed', { id: 'Depart#1', name: 'Depart', host: 'h7', tile: { p: 0, q: 0, tile: 32 }, dest: { p: 0, q: 0, tile: 40 } });
    assert.equal(S.sheets().length, 4);
    assert.ok(S.fx.pending().some(e => Math.abs(e.in - 0.42) < 1e-6), 'with the column: 0.42 s after the seal');
    S.tick(60);
    S.bus.emit('board:left', { host: 'h7', p: 0, q: 0, tile: 32, faction: 0 });
    S.bus.emit('moment', { kind: 'depart', p: 0, q: 0, tile: 32, id: 'h7' });
    assert.equal(S.sheets().filter(n => n === 'sheet-depart').length, 0, 'nothing new: the earlier ones are over and the record adds none');
    // the other answers of an order play none of them
    for (const t of ['action:landed', 'action:sent', 'action:busy', 'order:accepted']) S.bus.emit(t, { name: 'Depart', host: 'h8', tile: { p: 0, q: 0, tile: 34 } });
    assert.equal(S.sheets().length, 0);
    // other moments are other effects'
    for (const kind of ['harvest', 'muster', 'arrive', 'camp', 'village']) S.bus.emit('moment', { kind, p: 0, q: 0, tile: 33 });
    assert.equal(S.sheets().length, 0);
    // effects off: nothing
    stage.motion = 'off';
    S.bus.emit('moment', { kind: 'depart', p: 0, q: 0, tile: 40, id: 'h9' });
    assert.equal(S.sheets().length, 0);
  } finally { stage.motion = 'full'; FS.season = null; S.handle.off(); S.fx.destroy(); }
});

test('a capture is its own moment: the new holder\'s colour on the keep\'s tile from the capture\'s event, never from a battle; the viewer\'s character strikes its pose when the viewer\'s nation took it', async () => {
  const S = stage(), wasNow = globalThis.__fxNow;
  globalThis.__fxNow = () => S.fx.clock.now();
  FS.season = CONQUEST;
  const wasC = FS.conquest;
  try {
    // a won battle plays no capture
    S.bus.emit('battle', { play: { scene: SCENE(), t0: 0, speed: 1 }, focus: false });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(S.sheets().includes('sheet-capture'), false);
    assert.deepEqual(S.sheets(), ['sheet-battle']);
    MD.clearLeaderCue('aster');
    // the capture's event, with the keep's tile from the page's conquest records
    FS.conquest = { keeps: new Map([['4,-1', { p: 4, q: -1, tile: 17, holder: 3, troops: 0 }]]) };
    S.bus.emit('keep:captured', { p: 4, q: -1, from: 1, to: 3, turn: 83, mine: false });
    assert.equal(S.sheets().filter(n => n === 'sheet-capture').length, 1);
    assert.equal(MD.leaderCueAt('dunmar', 0, 0, S.fx.clock.now() + 0.6), null, 'another nation\'s capture: no pose');
    // said again for the same keep and turn (a second poll): once
    S.bus.emit('keep:captured', { p: 4, q: -1, from: 1, to: 3, turn: 83, mine: false });
    assert.equal(S.sheets().filter(n => n === 'sheet-capture').length, 1);
    // the viewer's own capture: the sprite and, a moment later, the pose
    S.bus.emit('keep:captured', { p: 4, q: -1, from: 3, to: 0, turn: 155, mine: true });
    assert.equal(S.sheets().filter(n => n === 'sheet-capture').length, 2);
    { const c = MD.leaderCueAt('aster', 12345, 678, S.fx.clock.now() + 0.45 + 0.85); assert.equal(c?.motion, 'victory'); assert.ok(Math.abs(c.share - 0.5) < 1e-9, 'every standing figure of the viewer\'s character, wherever it stands'); }
    // a keep whose tile the page does not know, a holder that is no nation: nothing is guessed
    S.bus.emit('keep:captured', { p: 9, q: 9, from: 1, to: 2, turn: 1 });
    S.bus.emit('keep:captured', { p: 4, q: -1, from: 1, to: 6, turn: 2 });
    assert.equal(S.sheets().filter(n => n === 'sheet-capture').length, 2);
    // the event may carry the tile itself
    S.bus.emit('keep:captured', { p: 9, q: 9, tile: 5, from: 1, to: 2, turn: 3 });
    assert.equal(S.sheets().filter(n => n === 'sheet-capture').length, 3);
  } finally { FS.season = null; FS.conquest = wasC; globalThis.__fxNow = wasNow; MD.clearLeaderCue('aster'); S.handle.off(); S.fx.destroy(); }
});

test('a real capture record (run ux-check, keep 4,-1 taken at turn 83) plays the capture in the taker\'s colour on the keep\'s own tile', () => {
  // (the herald's stored record of a finished local run, copied as it was served at /h/keep/4,-1.json:
  // submit-ux/.local/frontier/runs/ux-check/herald/files/h/keep/4,-1.json)
  const RECORD = { v: 1, p: 4, q: -1, tile: 10, holder: 0, since: 84, troops: 241, gen: 1, heartland: false, holders: [{ holder: 5, since: 0 }, { holder: 0, since: 84 }],
    contests: [{ contender: 0, from: 12, to: 83, outcome: 'taken', progress: 72 }],
    captures: [{ bell: 83, from: 5, to: 0, troops: 241, donor: '135244225183744', seq: '10696', sig: '4WwZktjF2KUobqepbfLWNhCPWXAWGcbYLBSAQfwYKkPGge7feRf6SwdcsLX17pee8xmDgXHL6wtM25HuAvidVBMK' }] };
  const cap = RECORD.captures[0];
  const S = stage(), was = globalThis.Image, wasC = FS.conquest, wasNow = globalThis.__fxNow;
  globalThis.Image = FakeImage; globalThis.__fxNow = () => S.fx.clock.now();
  FS.season = CONQUEST;
  try {
    // the page's conquest records hold the keep's tile (controller.mjs: FS.conquest.keeps); the board's event carries the capture's own fields
    FS.conquest = { keeps: new Map([[`${RECORD.p},${RECORD.q}`, { p: RECORD.p, q: RECORD.q, tile: RECORD.tile, holder: RECORD.holder, troops: RECORD.troops }]]) };
    S.bus.emit('keep:captured', { p: RECORD.p, q: RECORD.q, from: cap.from, to: cap.to, turn: cap.bell, mine: true });
    assert.deepEqual(S.sheets(), ['sheet-capture']);
    // Aster's atlas (the taker's), not Fjordal's (the loser's)
    assert.ok(find('/vfx/first-v1/capture/aster/atlas-256.webp'));
    assert.equal(requests.some(r => r.src?.includes('/capture/fjordal/')), false);
    find('/capture/aster/atlas-256.webp').load(2048, 1024);
    // drawn on the keep's tile: the clip's ground point is that tile's centre
    const { ctx, draws } = recorder();
    S.tick(0.5);
    S.fx.drawTop(ctx, { t: S.fx.clock.now(), view: { x: 0, y: 0, zoom: 1 }, size: { width: 100000, height: 100000 }, dpr: 1, ground: true });
    const d = draws()[0], w = SF.TILE_WIDTH / SF.SHEET_TILE;
    assert.ok(d, 'the capture is drawn');
    const h = tileHex(RECORD.p, RECORD.q, RECORD.tile), c = project(h.q, h.r);
    assert.ok(Math.abs(d[6] + w * SF.SHEET_ANCHOR[0] - c.x) < 1e-6 && Math.abs(d[7] + w * SF.SHEET_ANCHOR[1] - c.y) < 1e-6, 'on tile 10 of province 4,-1');
    // the viewer's nation took it: the viewer's character strikes its pose a moment later; the nation that lost it does not
    assert.equal(MD.leaderCueAt('aster', 0, 0, S.fx.clock.now() + 0.5)?.motion, 'victory');
    assert.equal(MD.leaderCueAt('fjordal', 0, 0, S.fx.clock.now() + 0.5), null);
    // the contest that led to it began at turn 12, 72 turns before: no blow is part of this moment
    assert.equal(S.sheets().some(n => n === 'sheet-battle'), false);
  } finally { FS.season = null; FS.conquest = wasC; globalThis.Image = was; globalThis.__fxNow = wasNow; MD.clearLeaderCue('aster'); S.handle.off(); S.fx.destroy(); }
});

test('a staged battle: an impact at each of the scene\'s contacts, a hit on the side that lost the exchange when its losses are known, and the winner\'s pose after the last blow', () => {
  const plan = battlePlan(SCENE()), cues = SF.battleSheetCues(plan);
  const impacts = cues.filter(c => c.effect === 'impact'), hits = cues.filter(c => c.effect === 'hit');
  assert.deepEqual(impacts.map(c => c.at), [...BATTLE_HITS]);
  assert.ok(hits.length >= 1 && hits.length <= BATTLE_HITS.length);
  const T = plan.tiles[0];
  for (const h of hits) { const loser = T.sides.find(s => (s.sgn < 0 ? 'left' : 'right') === h.where); assert.equal(T.wins[h.j], -loser.sgn, 'the side the exchange went against'); assert.ok(loser.loss > 0); }
  // a side whose losses are not known takes no hit sprite
  const unknown = SCENE(); unknown.tiles[0].defenders[0].after = null; unknown.tiles[0].attackers[0].after = null;
  assert.equal(SF.battleSheetCues(battlePlan(unknown)).some(c => c.effect === 'hit'), false);
  // nobody stood against the arrivals: no contact at all
  const alone = SCENE(); alone.tiles[0].defenders = [];
  assert.deepEqual(SF.battleSheetCues(battlePlan(alone)), []);
  // the pose: the nation the fates say holds the tile after a fight
  assert.deepEqual(SF.battleVictoryCue(SCENE()), { faction: 0, at: PHASE.fates + 0.6, secs: 1.7 });
  const held = SCENE(); held.tiles[0].attackers[0] = { ...held.tiles[0].attackers[0], after: 0, fate: 'Destroyed' }; held.tiles[0].defenders[0] = { ...held.tiles[0].defenders[0], after: 400, fate: 'Stays' };
  assert.equal(SF.battleVictoryCue(held).faction, 2);
  const standoff = SCENE(); standoff.tiles[0].defenders[0] = { ...standoff.tiles[0].defenders[0], after: 300, fate: 'Stays' };
  assert.equal(SF.battleVictoryCue(standoff), null, 'a standoff has no winner');
  assert.equal(SF.battleVictoryCue(alone), null, 'an unopposed arrival is no victory');
  const camp = SCENE(); camp.tiles[0].attackers[0] = { ...camp.tiles[0].attackers[0], after: 0, fate: 'Destroyed' }; camp.tiles[0].defenders[0] = { id: 'camp', faction: 6, stance: 0, before: 400, after: 300, fate: 'Stays', kind: 'camp' };
  assert.equal(SF.battleVictoryCue(camp), null, 'a camp has no character');
});

test('the selection: the outline rises when this page selects a tile at the near view, stays, and goes with the selection; a poll that changes nothing restarts nothing', async () => {
  const S = stage();
  const was = { selected: FS.selected, view: FS.view, compose: FS.compose };
  FS.season = CONQUEST;
  const settle = async () => { S.handle.syncSelection(); await Promise.resolve(); };
  try {
    FS.view = { lod: 'tile' }; FS.compose = null; FS.selected = null;
    await settle();
    assert.deepEqual(S.sheets(), []);
    FS.selected = { kind: 'tile', p: 0, q: 0, idx: 30 };
    await settle();
    assert.deepEqual(S.sheets(), ['sheet-select', 'sheet-select-held']);
    const first = S.fx.pending().length;
    await settle(); await settle();
    assert.deepEqual(S.sheets(), ['sheet-select', 'sheet-select-held'], 'the same selection again: nothing is restarted');
    assert.equal(S.fx.pending().length, first);
    // (the map's own pick, as the page holds it: no `kind`)
    FS.selected = { tileQ: 16, tileR: -8, p: 0, q: 0, idx: 31 };
    await settle();
    assert.deepEqual(S.sheets(), ['sheet-select', 'sheet-select-held'], 'another tile: the old outline is gone, the new one rises');
    // a province chosen as a whole, the far view, an order being written: no outline
    for (const change of [() => { FS.selected = { kind: 'province', p: 0, q: 0 }; }, () => { FS.selected = { kind: 'tile', p: 0, q: 0, idx: 31 }; FS.view = { lod: 'world' }; }, () => { FS.view = { lod: 'tile' }; FS.compose = { host: 1 }; }, () => { FS.compose = null; FS.selected = null; }]) {
      change(); await settle();
      assert.deepEqual(S.sheets(), []);
    }
    // the basic game: no outline of the pack
    FS.season = BASIC; FS.selected = { kind: 'tile', p: 0, q: 0, idx: 30 };
    await settle();
    assert.deepEqual(S.sheets(), []);
  } finally { FS.season = null; Object.assign(FS, was); S.handle.off(); S.fx.destroy(); }
});

test('the samples: every moment of the pack can be judged alone under the demo tag', () => {
  assert.deepEqual(Object.keys(SF.ART_SAMPLES), ['art-select', 'art-depart', 'art-impact', 'art-hit', 'art-built', 'art-capture', 'art-capture-six', 'art-effects', 'art-keep', 'art-battle', 'art-victory', 'art-mobs']);
  for (const s of Object.values(SF.ART_SAMPLES)) { assert.ok(s.secs > 0); assert.equal(typeof s.run, 'function'); }
  // the names never collide with the demo switch's own (fx/demo.mjs SAMPLES)
  const demo = readFileSync(new URL('fx/demo.mjs', WEB), 'utf8');
  for (const n of Object.keys(SF.ART_SAMPLES)) assert.equal(demo.includes(`'${n}'`), false, n);
  // without `?fx=` naming one of them nothing starts
  assert.equal(SF.startArtDemo({ search: '' }), null);
  assert.equal(SF.startArtDemo({ search: '?fx=battle,bell' }), null);
});

test('the page: one marked import line in app.mjs; no inline style, no remote address, no Japanese outside L in the new modules; the nations\' colours are the palette\'s', () => {
  const app = readFileSync(new URL('app.mjs', WEB), 'utf8');
  assert.equal(app.split('\n').filter(l => l.includes('sheetfx')).length, 1);
  assert.match(app, /^import '\.\/fx\/sheetfx\.mjs';\s+\/\/ \[uxs-art\]/m);
  for (const f of ['fx/sheetfx.mjs', 'art/pack.mjs']) {
    const src = readFileSync(new URL(f, WEB), 'utf8');
    assert.doesNotMatch(src, /style=|https?:\/\/|Math\.random|[぀-ヿ㐀-鿿]/, f);
  }
  // (the pack's cloth colours are the client's nation colours: nothing is tinted)
  assert.deepEqual(NATION_FILL, ['#cc303b', '#31bedb', '#eac21b', '#a34cd8', '#edeee7', '#f19232']);
  assert.deepEqual(MD.MOTION_LEADERS.map(l => l.color.toLowerCase()), NATION_FILL);
});

test('what the pack adds on disk, and that nothing of it is unnamed', () => {
  const added = bytes(new URL(`units/${MINIS.MOB_PACK}/`, ART)) + bytes(new URL('ui/illustrated/', ART)) + bytes(new URL('vfx/', ART)) + bytes(new URL('leaders3d/motion-v2/', ART));
  assert.equal(added, 10_669_084, 'art/README.md states this number');
  const readme = readFileSync(new URL('README.md', ART), 'utf8');
  assert.match(readme, /10,669,084/);
  for (const part of ['units/mobs-v1/@1x', 'ui/illustrated', 'vfx/first-v1', 'leaders3d/motion-v2/sprite@2x', 'NOT in the pack']) assert.ok(readme.includes(part), part);
  // the first sheet a screen with one host needs is a small part of it
  assert.ok(statSync(new URL(`units/${MINIS.MOB_PACK}/@1x/units_0.webp`, ART)).size < 260_000);
});
