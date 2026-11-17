// ⑦ correction to the replay notice (Lane C, 2026-11-17): the notice carries the world it was asked in, and the battle
// state's sync lets go of another world's notice only. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test /
// node:assert / node:fs: app.mjs is read as TEXT, not imported.
//   Expected, case by case:
//   X1 the world changes to B; before the map's next sync the person presses 見る in B → notice {loading, world B};
//      the sync comes (A → B) → the notice stays; the clash cannot be read → the same notice becomes {failed, world B}
//      with the button (it was: the sync cleared it and the failure found no notice — silence again)
//   X2 a notice asked in A, then B pinned: the sync lets it go; the request itself is called off by playBattle
//   X3 A → B → A: the generation differs — the first A's notice is not the last A's
//   X4 the same world, a sync that comes late: syncBattleWorld returns before the notice is looked at
//   X5 two presses in a row: the earlier answer touches nothing (its req is not the notice's)
//   X6 put away while it is read: the press is no longer the last; no scene, no notice
//   X7 the two world strings compared are the same expression (the pin with its generation)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
const fnOf = head => { const at = app.indexOf(head); assert.ok(at >= 0, head); return app.slice(at, app.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const code = s => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const ask = fnOf('async function playAsked(p, q, bell) {'), sync = fnOf('function syncBattleWorld() {');

test('X1 X2 X3 the notice names its world; the sync lets go of another world\'s only', () => {
  order(ask, 'const rep = FS.report ?? null, world = reportWorld();', "FS.replayAsk = rep ? null : { p, q, bell, state: 'loading', req, world };",
    "FS.replayAsk = ok === false && asked() ? { p, q, bell, state: 'failed', req, world } : null;");
  order(sync, 'const world = momentWorld();', 'if (battleWorldNow === world) return world;', 'battleWorldNow = world;',
    'if (FS.replayAsk && FS.replayAsk.world !== world) { FS.replayAsk = null; renderFeed(); }', 'return world;');
  assert.doesNotMatch(code(app), /if \(FS\.replayAsk\) \{ FS\.replayAsk = null; renderFeed\(\); \}/, 'no unconditional clearing is left');
  assert.equal((code(ask).match(/state: '(loading|failed)', req, world/g) ?? []).length, 2, 'both states keep the world');
});

test('X4 the same world: the sync does not reach the notice', () => {
  const before = sync.slice(0, sync.indexOf('battleWorldNow = world;'));
  assert.ok(before.includes('if (battleWorldNow === world) return world;'));
  assert.doesNotMatch(before, /replayAsk/);
});

test('X5 X6 the press\'s own number', () => {
  order(ask, 'const req = ++playAskSeq;', 'if (req !== playAskSeq) return;', 'if (!rep && FS.replayAsk?.req === req) {');
  assert.ok(app.includes("'replay-dismiss': () => { if (FS.replayAsk?.state === 'loading') playAskSeq += 1; FS.replayAsk = null; renderFeed(); },"));
});

test('X7 like is compared with like', () => {
  const expr = name => app.match(new RegExp(`const ${name} = \\(\\) => (.*);\\n`))?.[1];
  assert.ok(expr('reportWorld'));
  assert.equal(expr('reportWorld'), expr('momentWorld'), 'the notice\'s world (reportWorld) and the sync\'s (momentWorld) are one expression');
  assert.ok(expr('momentWorld').includes('${FS.pin.gen ?? 0}|'), 'with the generation: A → B → A are three');
});
