// ⑦ correction to the spectator's follow (Lane C, 2026-11-17): one request keeps its origin — herald object and pinned
// world — from the ask to the fallback; a called-off request (null) is not "no scene" (false) and never falls back; a
// camera move the map counts since the ask calls the follow off; an older automatic answer does not replace a newer scene
// of the same province. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs and
// map/fmap.mjs are read as TEXT, not imported (app.mjs loads fi18n.mjs and lang.mjs, the subjects of refused tests).
//   S1 playBattle asks the herald it took (`source.clash`), and after its one wait answers null for a change of world or
//      herald or a failed `still`, and false only for "no scene"
//   S2 an automatic scene (auto or still) whose answer comes after a later bell's live scene of the same province is
//      called off (null); a scene asked for by name is not
//   S3 followBattles' `still`: same world, same herald object, watch on, no report, the map's move count unchanged;
//      the fallback flies only on false and only while `still` holds
//   S4 the move count is the map's own: every non-auto setView (drag, wheel, pinch, keys, a move by name) adds one, and
//      restore's ifStill reads it; a touch that only halts a flight adds none (seen through map.touchedAt since the battle-world bundle)
//   S5 every caller copes with null: the turn's scene, autoBattles and 見る ignore the answer; the preview tests `if (ok)`
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), fmap = read('map/fmap.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const pb = fnOf(app, 'export async function playBattle(');
const follow = fnOf(app, 'function followBattles() {');

test('S1 one origin per request; called off is not "no scene"', () => {
  order(pb, 'const world = momentWorld(), source = heraldRef;', 'const r = await source.clash(p, q, bell).catch(() => null);',
    'if (momentWorld() !== world || heraldRef !== source || (still && !still())) return null;', 'if (!r?.ok || !r.inputs) return false;',
    'if (!scene) return false;', 'if (focus && mapRef) {', 'FS.battles = [');
  const code = pb.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.split('await ').length - 1, 1, 'one wait; everything after it is one stretch');
  assert.doesNotMatch(code, /heraldRef\.clash/, 'the herald asked is the one taken');
});

test('S2 an older automatic answer does not replace a newer scene', () => {
  order(pb, 'return null;',
    'if ((auto || still) && (FS.battles ?? []).some(b => b.scene.p === p && b.scene.q === q && b.scene.bell > bell && battleLive(b, performance.now() / 1000))) return null;',
    'if (!r?.ok || !r.inputs) return false;', 'FS.battles = [...(FS.battles ?? []).filter(b => !(b.scene.p === p && b.scene.q === q)), play];');
});

test('S3 the follow\'s fallback: only "no scene", only while still', () => {
  order(follow, 'const still = () => momentWorld() === world && heraldRef === source', 'playBattle(c.p, c.q, c.bell, { focus: true, still })',
    'if (ok === false && still()) mapRef?.flyTo({ p: c.p, q: c.q, zoom: 0.6 });');
  // (the battle-world bundle adds the map's touch record — web-frontier-ws07-battle-world-text.test.mjs)
  assert.ok(follow.includes('const source = heraldRef, moves = mapRef?.moves ?? 0, touched = mapRef?.touchedAt ?? null;'));
  assert.ok(follow.includes('&& !FS.report && (mapRef?.moves ?? 0) === moves && (mapRef?.touchedAt ?? null) === touched;'));
  assert.doesNotMatch(follow, /if \(!ok && still\(\)\)/, 'a called-off request never falls back');
});

test('S4 the move count is the map\'s existing contract', () => {
  assert.ok(fmap.includes('if (!auto) { this.cam.userMoved = true; this.moves = (this.moves ?? 0) + 1; }'));
  assert.ok(fmap.includes('if (ifStill && Number.isInteger(memo.moves) && (this.moves ?? 0) !== memo.moves) return false;'));
  assert.ok(fmap.includes("this.setView({ x: v.x - (p.x - prev.x) / v.zoom, y: v.y - (p.y - prev.y) / v.zoom }, { clamp: true, soft: 1 });"), 'a drag is a counted move');
  assert.ok(fmap.includes('if (this.cam.halt()) { this.cam.userMoved = true; this.sync(); }'), 'a touch that only halts a flight: not counted here (map.touchedAt sees it)');
});

test('S5 every caller copes with null', () => {
  assert.ok(app.includes("fxOn('turn:scene', x => { if (FS.mode === 'play' && x?.battle) playBattle(x.battle.p, x.battle.q, x.battle.bell, { auto: true, focus: !!x.focus }); });"));
  assert.ok(app.includes('playBattle(env.province.p, env.province.q, b, { auto: true });'));
  assert.ok(app.includes("'battle-play': d => { leaveReport(); closeDialPop(); playBattle(num(d.p), num(d.q), num(d.bell), { focus: true }); },"));
  assert.ok(app.includes('const go = () => playBattle(bq[0], bq[1], bq[2], { focus: !FS.battleFocused }).then(ok => { if (ok) FS.battleFocused = true; });'));
  assert.equal(app.split('playBattle(').length - 1, 6, 'the definition and five callers');
  assert.doesNotMatch(pb + follow, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
