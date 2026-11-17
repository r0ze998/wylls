// ⑦ a battle already playing when the pinned world changes: its scene and effects end, and the camera's way back after
// a battle is never taken into another world nor after a person touched the map (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs, fx/battle.mjs, fx/stage.mjs,
// fx/sheetfx.mjs, hud/camkeep.mjs and map/fmap.mjs are read as TEXT, not imported (app.mjs loads fi18n.mjs and
// lang.mjs, the subjects of refused tests). A text check; it runs no page, herald or world.
//   T1 playBattle tags its play with the world it was asked in
//   T2 the kept place: a place kept in another world is let go with its timer before this one is kept; the person's
//      last touch is noted when the place is kept; the timer goes back only in the same world and with no touch since,
//      else it lets the place go (never flies)
//   T3 autoBattles, at a change of world, ends the scenes of other worlds: removed from FS.battles, endBattle, and
//      'battle:end' to the effects layer; untagged plays are left alone
//   T4 the effects layer calls off only that play's handles (stage and sheet sprites); another play at the same place stays
//   T5 the follow's `still` also needs the map's touch record unchanged
//   T6 the map's own contracts used: touchedAt on pointerdown (also a halt), wheel and keys; camkeep's drop and back
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), fxb = read('fx/battle.mjs'), stage = read('fx/stage.mjs'), sheet = read('fx/sheetfx.mjs'), keep = read('hud/camkeep.mjs'), fmap = read('map/fmap.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const pb = fnOf(app, 'export async function playBattle(');

test('T1 a play carries its world', () => {
  order(pb, 'const world = momentWorld(), source = heraldRef;', 'const play = startBattle(scene, performance.now() / 1000, BATTLE_SPEEDS[fx] || 1);', 'play.world = world;', 'FS.battles = [', "fxEmit('battle', {");
});

test('T2 the way back after a battle: one world, no touch since', () => {
  assert.ok(app.includes('let battleKeepWorld, battleTouched = null;'));
  order(pb, 'if (focus && mapRef) {', "if (battleKeepWorld !== world) { clearTimeout(battleBack); battleBack = null; camKeep.drop('battle'); }", 'battleKeepWorld = world;',
    "if (camKeep.keep('battle')) battleTouched = mapRef.touchedAt ?? null;", 'mapRef.flyTo({ p, q, tile: scene.tiles[0].idx, zoom: 2.1 }, 500);', 'clearTimeout(battleBack);',
    'battleBack = setTimeout(() => {', 'battleBack = null;', "if (momentWorld() !== world || (mapRef?.touchedAt ?? null) !== battleTouched) { camKeep.drop('battle'); return; }",
    "camKeep.back('battle', { ms: calm() ? 0 : 420, slack: Infinity });");
  assert.doesNotMatch(pb, /setTimeout\(\(\) => camKeep\.back\('battle'/, 'no unconditioned way back is left');
});

test('T3 other worlds\' scenes end where they are drawn', () => {
  assert.ok(app.includes('import { battleScene, startBattle, battleLive, endBattle, BATTLE_SPEEDS, PHASE } from \'./people/battle.mjs\';'));
  const end = fnOf(app, 'function endOtherWorldBattles(world) {');
  order(end, 'const gone = (FS.battles ?? []).filter(b => b.world !== undefined && b.world !== world);', 'if (!gone.length) return;',
    'FS.battles = (FS.battles ?? []).filter(b => !gone.includes(b));', "for (const b of gone) { endBattle(b); fxEmit('battle:end', { play: b }); }");
  assert.ok(app.includes('if (battleSeenWorld !== world) { battleSeen.clear(); battleSeenWorld = world; endOtherWorldBattles(world); }'));
});

test('T4 the effects layer calls off that play only', () => {
  const c = fnOf(fxb, 'export function cancelStagedPlay(play) {');
  assert.ok(c.includes('for (const h of [...staged.values()]) if (h.play === play) { h.cancel(); n++; }'));
  assert.equal(fxb.split('const h = { play, cancel() {').length - 1, 3, 'every staged handle names its play');
  assert.ok(stage.includes("import { stageBattle, cancelStagedPlay } from './battle.mjs';"));
  assert.ok(stage.includes("on('battle:end', p => { if (p?.play) cancelStagedPlay(p.play); });"));
  assert.ok(sheet.includes('scenePlays.set(key, p.play); });'));
  assert.ok(sheet.includes("for (const [key, play] of [...scenePlays]) if (play === p?.play) { for (const h of scenes.get(key) ?? []) h.cancel?.(); scenes.delete(key); scenePlays.delete(key); }"));
});

test('T5 the follow also stops at a touch', () => {
  assert.ok(app.includes('const source = heraldRef, moves = mapRef?.moves ?? 0, touched = mapRef?.touchedAt ?? null;'));
  assert.ok(app.includes('&& (mapRef?.moves ?? 0) === moves && (mapRef?.touchedAt ?? null) === touched;'));
});

test('T6 the existing contracts relied on', () => {
  assert.equal((fmap.match(/this\.touchedAt = clock\(\);/g) ?? []).length, 3, 'pointerdown, wheel, keys');
  order(fmap, "c.addEventListener('pointerdown', e => {", 'this.touchedAt = clock();', 'if (this.cam.halt()) { this.cam.userMoved = true; this.sync(); }');
  assert.ok(keep.includes('drop(key) { return kept.delete(key); },'));
  assert.ok(keep.includes('if (!m?.view || kept.has(key)) return false;'), 'the first keep wins until back or drop');
  assert.doesNotMatch(pb, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
