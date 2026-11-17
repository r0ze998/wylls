// ⑦ correction (Lane C, 2026-11-17): the battle state is made the pinned world's before the people cache is returned or
// built and before playBattle compares scenes. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: app.mjs is read as TEXT, not imported (it loads fi18n.mjs and lang.mjs, the subjects of refused
// tests). A text check of the order the cases below rely on; it runs no page, herald or world.
//   Y1 syncBattleWorld: the same world changes nothing; a change forgets the sightings, ends other worlds' scenes, lets
//      a camera place kept in another world go with its timer, and empties the people cache
//   Y2 the same second: peopleSource syncs before its cache check, so a cache built just before the change is not
//      returned for the new world (its battles included)
//   Y3 an older world's scene with a higher bell vs. this world's lower bell: playBattle syncs after its wait, before
//      the comparison, and compares only this world's scenes — the new world's auto or follow request is not called off
//   Y4 a new play of this world placed where an old one stood is kept: endOtherWorldBattles ends only plays tagged with
//      another world, and the effects layer cancels by play, not by place
//   Y5 autoBattles takes its world from the same sync
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const fxb = readFileSync(new URL('../../permutation-server/web/frontier/fx/battle.mjs', import.meta.url), 'utf8');
const fnOf = head => { const at = app.indexOf(head); assert.ok(at >= 0, head); return app.slice(at, app.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const sync = fnOf('function syncBattleWorld() {');

test('Y1 one place makes the battle state this world\'s', () => {
  order(sync, 'const world = momentWorld();', 'if (battleWorldNow === world) return world;', 'battleWorldNow = world;', 'battleSeen.clear();',
    'endOtherWorldBattles(world);', "if (battleKeepWorld !== undefined && battleKeepWorld !== world) { clearTimeout(battleBack); battleBack = null; camKeep.drop('battle'); battleKeepWorld = undefined; }",
    'peopleCache.at = -1;', 'return world;');
});

test('Y2 the same second: the cache is not another world\'s', () => {
  const ps = fnOf('export function peopleSource() {');
  order(ps, 'syncBattleWorld();', 'const sec = Math.floor(Date.now() / 1000);', 'if (peopleCache.at === sec && peopleCache.lang === lang() && peopleCache.value) {',
    'peopleCache = { at: sec, lang: lang(), value: {', 'autoBattles();');
});

test('Y3 an older world\'s higher bell does not call off this world\'s lower one', () => {
  const pb = fnOf('export async function playBattle(');
  order(pb, 'const r = await source.clash(p, q, bell).catch(() => null);', 'if (momentWorld() !== world || heraldRef !== source || (still && !still()) || (asked && !asked())) return null;',
    'syncBattleWorld();',
    'if ((auto || still) && (FS.battles ?? []).some(b => (b.world === undefined || b.world === world) && b.scene.p === p && b.scene.q === q && b.scene.bell > bell && battleLive(b, performance.now() / 1000))) return null;');
});

test('Y4 a new play where an old one stood is kept', () => {
  const end = fnOf('function endOtherWorldBattles(world) {');
  assert.ok(end.includes('const gone = (FS.battles ?? []).filter(b => b.world !== undefined && b.world !== world);'));
  assert.ok(fnOf('export async function playBattle(').includes('play.world = world;'));
  assert.ok(fxb.includes('for (const h of [...staged.values()]) if (h.play === play) { h.cancel(); n++; }'), 'by play, not by place');
});

test('Y5 autoBattles uses the same sync', () => {
  const ab = fnOf('function autoBattles() {');
  order(ab, 'const world = syncBattleWorld();', 'for (const [key, env] of FS.provinces) {', 'if (env.world !== undefined && env.world !== world) continue;');
  assert.doesNotMatch(app, /battleSeenWorld/, 'one world variable for the battle state');
});
