// ⑦ a season read that only partly applied, or that failed at boot, does not leave the page stuck: the chain clock is
// judged by the world of its own samples, and what needs a season starts at the first good read — at boot or later
// (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs,
// controller.mjs and hud/drawer.mjs are read as TEXT, not imported (they load fi18n.mjs and lang.mjs, the subjects of
// refused tests). A text check; it runs no page, herald or world.
//   K1 the clock carries the world of its samples (FS.chainWorld, the pin with its generation): a new clock only when
//      that world is not the pinned one, never on the first read; set before setAccelerated and the record's sample;
//      adoptPinnedWorld's one-time answer no longer decides it
//   K2 loadSeason's order is kept: one wait, stale check, failure, pin, forget another world, recover, beacon, record,
//      clock, record as applied last
//   S1 why play never started: the viewer's start lived only in boot's `if (await loadSeason(herald))`, and the drawer
//      says "pending" while play is not ready and the record is there
//   S2 startWithSeason runs its body once, only with a pin and a season; boot calls it after a read that may throw
//      (caught, so the season poll still starts); the season poll calls it after each good read
//   S3 the body is the former boot block: overviews, practice, spectating, play (cooperation board, startPlay and its
//      readiness), the map tab
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), drawer = read('hud/drawer.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const ls = fnOf(app, 'async function loadSeason(herald) {');
const boot = fnOf(app, 'export async function boot() {');

test('K1 the clock is judged by the world of its own samples', () => {
  order(ls, 'adoptPinnedWorld();', 'FS.clock = seasonClock(season);', 'const clockWorld = momentWorld();',
    'if (FS.chainWorld !== undefined && FS.chainWorld !== clockWorld) FS.chain = new ChainClock();', 'FS.chainWorld = clockWorld;',
    "FS.chain.setAccelerated(record.cluster === 'localnet');", 'FS.chain.observe(record.latestUnix, record.latestSlot);');
  assert.doesNotMatch(ls, /worldChanged/, 'the one-time answer no longer decides the clock');
  assert.ok(app.includes("const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);"), 'with the generation: A → B → A are three');
});

test('K2 loadSeason keeps its order', () => {
  const code = ls.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.split('await ').length - 1, 1);
  order(code, 'const seq = askSeason();', 'const r = await herald.season();', 'if (seasonStale(seq)) return true;', 'if (!r.ok) {', 'FS.pin = setPin({',
    'adoptPinnedWorld();', 'seasonRecovered();', 'FS.beacon = checkBeacon({', 'applySeasonRecord(FS, record,', 'FS.chainWorld = clockWorld;', 'takeSeason(seq);\n  return true;\n}');
});

test('S1 why play never started after a failed first read', () => {
  assert.ok(drawer.includes("if (!FS.playReady) return FS.error && !FS.record ? 'unreachable' : 'pending';"));
  assert.doesNotMatch(boot, /if \(await loadSeason\(herald\)\) \{/, 'the start no longer lives only in boot\'s read');
});

test('S2 start once, at the first good read', () => {
  // (the late-start bundle marks each step and the whole done only after they ran — web-frontier-ws07-late-start-text.test.mjs)
  order(boot, 'let seasonStarted = false;', 'const startWithSeason = () => {', 'if (seasonStarted || !FS.pin || !FS.season) return;', "seasonStarted = FS.mode !== 'play' || started.coop;",
    'let bootRead = false;', "try { bootRead = await loadSeason(herald); } catch (e) { console.error('frontier season:', e); }", 'if (bootRead) startWithSeason();',
    'FS.overviewsBooted = true;', 'const seasonLoop = createPollLoop({', 'const ok = await loadSeason(herald);', 'errors = ok ? 0 : errors + 1;', 'if (ok) startWithSeason();',
    'seasonLoop.start(Math.min(30, pollCap(FS.chain)));');
  assert.equal(boot.split('startWithSeason()').length - 1, 2, 'boot and the poll');
});

test('S3 the body is the former boot block, unchanged', () => {
  const body = boot.slice(boot.indexOf('const startWithSeason = () => {'), boot.indexOf('let bootRead = false;'));
  order(body, "loadOverviews(herald).catch(e => console.error('frontier overviews:', e));",
    "FS.ui = loadUi(uiStorage, uiKey(scope())); invalidate('panel');",
    'startSpectate(herald);', "if (FS.mode === 'play') {", "installCoopBoard({ changed: () => invalidate('panel'), ...(coopOptions ?? {}) });",
    "startPlay({ herald, cfg }).catch(e => console.error('frontier play:', e)).then(() => { FS.playReady = true; FS.viewerMissed = !!FS.wallet && !FS.land;",
    "FS.tab = 'map';");
  assert.doesNotMatch(body, /prize|faucet|payAndJoin|paidJoin|claim/i);
});
