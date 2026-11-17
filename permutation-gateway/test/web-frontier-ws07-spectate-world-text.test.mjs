// ⑦ the spectator's follow and the battle scenes belong to one pinned world (with its generation): another world's last
// clash never makes this one's first "new"; a clash that answers after the world changed — or after the watch was turned
// off or a report opened — neither plays nor flies (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free
// beyond node:test / node:assert / node:fs: app.mjs and controller.mjs are read as TEXT, not imported (they load
// fi18n.mjs and lang.mjs, the subjects of refused tests). A text check; it runs no page, herald or world.
//   W1 followBattles: compares only a chronicle read for this world (FS.chronicleWorld); a new world starts with no
//      baseline, and its first clash is the baseline; the existing checks (watch off, report open, faction) stay before
//      the play
//   W2 the follow passes `still` (same world, watch on, no report) and flies to the fallback only while it holds
//   W3 playBattle: world and herald taken before the clash is asked; after the wait another world, another herald or a
//      failed `still` returns false before anything is staged or flown to
//   W4 autoBattles: what was seen in another world is forgotten; another world's envelopes still held are skipped
//   W5 unchanged: the spectator's tick (refresh, bell items, follow; a failed read follows nothing); the report's own
//      world checks; the provenance the follow relies on (refreshChronicle sets FS.chronicleWorld with the generation)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), ctl = read('controller.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const follow = fnOf(app, 'function followBattles() {');
const pb = fnOf(app, 'export async function playBattle(');
const auto = fnOf(app, 'function autoBattles() {');

test('W1 the follow compares within one world', () => {
  assert.ok(app.includes('let watchSeen = null, watchWorld;'));
  order(follow, 'const world = momentWorld();', 'if (FS.chronicleWorld !== world) return;', 'if (watchWorld !== world) { watchWorld = world; watchSeen = null; }',
    'const c = reportScreen.clashesFrom(FS.chronicle ?? [], 1)[0];', 'if (!c) return;', 'if (watchSeen === null) { watchSeen = key; return; }',
    'if (key === watchSeen) return;', 'watchSeen = key;',
    'if (FS.watch?.auto === false || FS.report || (Number.isInteger(f) && !provinceFactions(FS.overviews, c.p, c.q).includes(f))) return;');
});

test('W2 the follow\'s play and fallback hold only while still', () => {
  // (corrected by the source bundle — web-frontier-ws07-spectate-source-text.test.mjs: the same herald and no counted
  //  camera move belong to `still`, and only "no scene" (false) falls back)
  // (the battle-world bundle adds the map's touch record to `still` — web-frontier-ws07-battle-world-text.test.mjs)
  order(follow, 'const source = heraldRef, moves = mapRef?.moves ?? 0, touched = mapRef?.touchedAt ?? null;',
    "const still = () => momentWorld() === world && heraldRef === source && FS.watch?.auto !== false && !FS.report && (mapRef?.moves ?? 0) === moves && (mapRef?.touchedAt ?? null) === touched;",
    'playBattle(c.p, c.q, c.bell, { focus: true, still }).then(ok => { if (ok === false && still()) mapRef?.flyTo({ p: c.p, q: c.q, zoom: 0.6 }); });');
  assert.doesNotMatch(follow, /\{ if \(!ok\) mapRef/, 'no unconditioned fallback flight is left');
});

test('W3 playBattle drops a clash the change overtook', () => {
  order(pb, '{ focus = false, auto = false, still = null } = {}) {', 'const world = momentWorld(), source = heraldRef;',
    'const r = await source.clash(p, q, bell).catch(() => null);', 'if (momentWorld() !== world || heraldRef !== source || (still && !still())) return null;',
    'if (!r?.ok || !r.inputs) return false;', 'const scene = battleScene({', 'if (focus && mapRef) {', 'mapRef.flyTo({ p, q, tile: scene.tiles[0].idx, zoom: 2.1 }, 500);',
    'FS.battles = [', "fxEmit('battle', {");
  const code = pb.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.split('await ').length - 1, 1, 'one wait, checked right after');
});

test('W4 the scenes the page plays by itself: one world', () => {
  assert.ok(app.includes('let battleSeenWorld;'));
  // (the battle-world bundle also ends other worlds' scenes there — web-frontier-ws07-battle-world-text.test.mjs)
  order(auto, 'const world = momentWorld();', 'if (battleSeenWorld !== world) { battleSeen.clear(); battleSeenWorld = world; endOtherWorldBattles(world); }', 'for (const [key, env] of FS.provinces) {',
    'if (env.world !== undefined && env.world !== world) continue;', 'const prev = battleSeen.get(key);', 'if (prev === undefined || prev >= b) continue;',
    'playBattle(env.province.p, env.province.q, b, { auto: true });');
});

test('W5 unchanged around it', () => {
  const sp = fnOf(app, 'function startSpectate(herald) {');
  order(sp, 'await refreshPlay();', 'FS.bellItems = spectateScreen.spectateBells(FS, FS.chain?.now() ?? 0);', 'followBattles();', "} catch (e) { errors++; console.error('frontier spectate:', e); }");
  assert.ok(app.includes("if (reportWorld() !== world) { FS.report = null; invalidate('panel'); return; }"), 'the report keeps its own world checks');
  assert.ok(ctl.includes('FS.chronicleSource = h0; FS.chronicleWorld = w0;'));
  assert.ok(ctl.includes("const worldNow = () => { const p = io.pinned(); return p?.programId && p?.addresses?.season ? `${p.gen ?? 0}|${p.cluster ?? ''}|${p.programId}|${p.addresses.season}` : null; };"));
  assert.ok(ctl.includes('r.world = world;'), 'envelopes carry the world they were read for');
  assert.doesNotMatch(follow + pb + auto, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
