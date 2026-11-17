// ⑦ after a failed season read: the next good read clears that error (and only the season poll's), and a change of
// world starts the chain clock again instead of holding it on the former world's samples (Lane C, 2026-11-17).
// WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs, controller.mjs,
// clock.mjs, herald.mjs and stale-banner.mjs are read as TEXT, not imported (app.mjs and controller.mjs load fi18n.mjs
// and lang.mjs, the subjects of refused tests). A text check; it runs no page, herald or world.
//   E1 the season poll's errors (read failed, pin refused, beacon) are set through seasonError, marked source 'season';
//      seasonError never replaces another operation's error; no direct FS.error write is left in loadSeason
//   E2 seasonRecovered clears only a season error, after the pin was accepted and before the beacon check; a stale answer
//      (success or failure) returns before either; the controller's local-play error is not marked and so stays
//   E3 the banner and the "loading" words read FS.error as before
//   C1 why the clock froze: observe drops a lower slot as an older answer, now() never goes back, and FS.chain was made
//      once at boot
//   C2 loadSeason makes a new ChainClock only when adoptPinnedWorld says the world changed, before setAccelerated and the
//      record's own sample; the first pin and the same world keep the clock
//   C3 a clock with no sample is unknown, not fresh: behind() and now() are null, staleness says not stale with behind
//      null, the stale banner is hidden (unchanged)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const app = read('app.mjs'), ctl = read('controller.mjs'), clock = read('clock.mjs'), herald = read('herald.mjs'), banner = read('stale-banner.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const ls = fnOf(app, 'async function loadSeason(herald) {');

test('E1 the season poll\'s errors are marked as its own', () => {
  assert.ok(app.includes("function seasonError(e) { if (!FS.error || FS.error.source === 'season') FS.error = { ...e, source: 'season' }; }"));
  assert.ok(ls.includes("seasonError({ code: r.code, text: clientText(r.code) });"));
  assert.ok(ls.includes('seasonError({ code: e.code, text: e.message });'));
  assert.ok(ls.includes('if (!FS.beacon.ok) seasonError({ code: FS.beacon.code, text: clientText(FS.beacon.code) });'));
  assert.doesNotMatch(ls, /FS\.error = /, 'no direct write is left in loadSeason');
});

test('E2 a good read clears only the season poll\'s error, at the right place', () => {
  assert.ok(app.includes("function seasonRecovered() { if (FS.error?.source === 'season') FS.error = null; }"));
  order(ls, 'const r = await herald.season();', 'if (seasonStale(seq)) return true;', 'if (!r.ok) {', 'FS.pin = setPin({', '} catch (e) {', 'return false;',
    'adoptPinnedWorld();', 'seasonRecovered();', 'FS.beacon = checkBeacon({', 'if (!FS.beacon.ok) seasonError(', 'takeSeason(seq);', 'return true;');
  // another operation's error carries no season mark
  assert.equal((ctl.match(/FS\.error = \{ code: 'LocalPlayIdentityChanged'/g) ?? []).length, 2);
  assert.doesNotMatch(ctl, /source: 'season'/);
});

test('E3 the readers of FS.error are unchanged', () => {
  assert.ok(app.includes("const status = s ? SEASON_STATUS_TEXT[effectiveStatus(s, FS.chain?.now() ?? 0)] : FS.error ? '' : L`読み込み中…`;"));
  assert.ok(app.includes("if (err) { err.hidden = !FS.error; err.textContent = FS.error ? bannerText(FS.error, !!s) : ''; }"));
});

test('C1 why a restarted world\'s clock stood still', () => {
  assert.ok(clock.includes('if (this.last && s.slot < this.last.slot) return; // an older answer arriving late'));
  assert.ok(clock.includes('this.floor = Math.max(this.floor, t);'));
  assert.equal((app.match(/FS\.chain = new ChainClock\(\);/g) ?? []).length, 2, 'once at boot, once on a change of world');
});

test('C2 the clock starts again on a change of world only', () => {
  // (the partial-apply bundle judges the clock by its own world stamp — web-frontier-ws07-season-partial-text.test.mjs)
  order(ls, 'adoptPinnedWorld();', 'FS.clock = seasonClock(season);', 'if (FS.chainWorld !== undefined && FS.chainWorld !== clockWorld) FS.chain = new ChainClock();',
    "FS.chain.setAccelerated(record.cluster === 'localnet');", 'FS.chain.observe(record.latestUnix, record.latestSlot);', 'FS.chain.declare(record.sample?.rate);');
  const adopt = fnOf(ctl, 'export function adoptPinnedWorld() {');
  assert.ok(adopt.includes('if (readsWorld === undefined || readsWorld === world) { readsWorld = world; return false; }'), 'first pin and same world: false');
  assert.ok(adopt.includes('return true;'));
});

test('C3 no sample is unknown, never fresh (unchanged)', () => {
  assert.ok(clock.includes('if (!this.last) return null;'));
  assert.ok(herald.includes('if (latestUnix === null || latestUnix === undefined || chainNow === null || chainNow === undefined) return { behind: null, stale: false };'));
  assert.ok(banner.includes("if (!stale?.stale) return { hidden: true, text: '', reread: false };"));
});
