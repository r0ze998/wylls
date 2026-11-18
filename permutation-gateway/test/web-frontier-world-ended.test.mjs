// The loop-play report B5 (2026-11-18): after its launcher stopped a world on turn 8 the page went on — "Turn 19",
// "Host arrived on turn 10 · loading its position", "This view is 639 s behind", "Could not connect" — and never said
// that the world had ended. Now: a herald read that fails by the network asks the launcher once whether it still runs
// this world (flocalplay-ended.mjs); its WorldNotFound is the end, confirmed; the clock then stands at the herald's last
// sample (clock.mjs halt), the banner says the world ended, and "arrived" is judged by the herald's own latest sample.
//
// THIS FILE MAKES NO KEY: pure modules (the clock, the watch, the banner's view, the notice's sentence). No page, no
// network, no process, no timer.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { ChainClock, bellAt, bellChip, pollCap } from '../../permutation-server/web/frontier/clock.mjs';
import { createWorldWatch, worldStateOf, worldEndedText, worldEndedWord, WORLD_ENDED_ASK_GAP_MS, WORLD_NOT_FOUND } from '../../permutation-server/web/frontier/flocalplay-ended.mjs';
import { staleBannerView, endedBannerView } from '../../permutation-server/web/frontier/stale-banner.mjs';
import { keeperText } from '../../permutation-server/web/frontier/flocalplay-session.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const read = f => readFileSync(new URL(f, WEB), 'utf8');
const GENESIS = 1_000_000;
/** A localnet clock at ×30 that was last told "turn 8, 100 s in", `wallSecs` of this machine's time ago. */
function stoppedWorld(wallSecs) {
  let wall = 0;
  const c = new ChainClock({ wall: () => wall });
  c.setAccelerated(true); c.declare(30);
  c.observe(GENESIS + 8 * 600 + 100, 5000);
  wall = wallSecs * 1000;
  return c;
}

test('the fault: a clock whose herald went away goes on by this machine\'s time — turn 8 reads turn 19', () => {
  const c = stoppedWorld(220);
  assert.equal(bellAt(GENESIS, c.now()), 19, 'what the page showed');
  assert.equal(bellAt(GENESIS, c.seen()), 8, 'what the herald last reported');
});

test('halt: the clock of a world confirmed ended stands at the herald\'s last sample, for good', () => {
  const c = stoppedWorld(220);
  c.now();                                    // (the page had already shown turn 19: the floor is there)
  c.halt();
  assert.equal(c.halted, true);
  assert.equal(c.now(), GENESIS + 8 * 600 + 100, 'the last sample, not a second more');
  assert.equal(bellAt(GENESIS, c.now()), 8);
  assert.equal(c.now(), c.now(), 'it does not tick');
  assert.equal(c.behind(), 0, 'nothing later to read: not "behind"');
  assert.equal(pollCap(c), Infinity, 'and no fast poll');
  // a later sample (another world on the same port) is not this world's: ignored
  c.observe(GENESIS + 50 * 600, 9000);
  assert.equal(bellAt(GENESIS, c.now()), 8);
  assert.equal(c.seen(), GENESIS + 8 * 600 + 100);
  // the dial's chip is that turn's
  assert.equal(bellChip({ genesisTs: GENESIS, endBell: 4294967295, continuous: true }, c.now()).bell, 8);
});

test('a clock that was never halted is exactly as before: it runs, a lagging herald does not freeze it', () => {
  const c = stoppedWorld(220);
  assert.equal(c.halted, false);
  assert.ok(c.now() > c.seen());
  assert.ok(c.behind() > 200);
  const fresh = new ChainClock();
  assert.equal(fresh.seen(), null); assert.equal(fresh.now(), null);
  fresh.halt(); assert.equal(fresh.now(), null, 'halted before any sample: still no time');
});

test('the launcher\'s answer: only its own WorldNotFound is the end', () => {
  assert.equal(WORLD_NOT_FOUND, 'WorldNotFound');
  assert.equal(worldStateOf({ ok: true, body: { keeper: null } }), 'running');
  assert.equal(worldStateOf({ ok: false, launcher: 'WorldNotFound', code: 'LauncherKeeperFailed' }), 'ended');
  for (const r of [null, undefined, 'ended', {}, { ok: false, launcher: null, code: 'LauncherKeeperFailed' }, { ok: false, launcher: 'LauncherClosed', code: 'LauncherClosed' }, { ok: false, launcher: 'InvalidWallet' }, { ok: 'yes', launcher: 'WorldNotFound' }])
    assert.equal(worldStateOf(r), 'unknown', JSON.stringify(r));
  // the launcher's own code for it is what this page compares with
  const launcher = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /if \(!record \|\| record\.stopping \|\| !record\.keeper\) throw fault\('WorldNotFound', 404\);/);
});

test('the watch: asked only on a failed read, one at a time, spaced, and never again once ended', async () => {
  let t = 0, answer = 'unknown', ended = 0;
  const asked = [];
  const w = createWorldWatch({ ask: async () => { asked.push(t); return answer; }, onEnded: () => { ended += 1; }, now: () => t });
  assert.equal(w.asks(), 0, 'nothing is asked before a read fails');
  const a = w.readFailed();
  assert.equal(w.readFailed(), null, 'one question at a time');
  assert.equal(await a, 'unknown');
  assert.equal(w.isEnded(), false); assert.equal(ended, 0);
  t += WORLD_ENDED_ASK_GAP_MS - 1;
  assert.equal(w.readFailed(), null, 'not again within the gap');
  t += 1; answer = 'running';
  assert.equal(await w.readFailed(), 'unknown', 'a world that runs: nothing changes');
  t += WORLD_ENDED_ASK_GAP_MS; answer = 'ended';
  assert.equal(await w.readFailed(), 'ended');
  assert.equal(w.isEnded(), true); assert.equal(ended, 1);
  t += 10 * WORLD_ENDED_ASK_GAP_MS; answer = 'running';
  assert.equal(w.readFailed(), null, 'an ended world is not asked about again');
  assert.equal(ended, 1); assert.equal(w.isEnded(), true, 'and the end is not taken back');
  assert.deepEqual(asked, [0, WORLD_ENDED_ASK_GAP_MS, 2 * WORLD_ENDED_ASK_GAP_MS]);
});

test('the watch fails closed: a question that throws, no question, a clock that is not a number', async () => {
  let ended = 0;
  const thrown = createWorldWatch({ ask: () => { throw new Error('x'); }, onEnded: () => { ended += 1; }, now: () => 0 });
  assert.equal(await thrown.readFailed(), 'unknown');
  assert.equal(createWorldWatch({ onEnded: () => { ended += 1; } }).readFailed(), null);
  assert.equal(createWorldWatch({ ask: async () => 'ended', now: () => NaN, onEnded: () => { ended += 1; } }).readFailed(), null);
  assert.equal(ended, 0);
  // a display that throws does not undo the end
  const w = createWorldWatch({ ask: async () => 'ended', onEnded: () => { throw new Error('paint'); }, now: () => 0 });
  assert.equal(await w.readFailed(), 'ended'); assert.equal(w.isEnded(), true);
});

test('the banner: "this world has ended" in either language, no re-read key, in place of "N s behind"', () => {
  const stale = { stale: true, behind: 639 };
  setLang('en');
  const en = endedBannerView();
  assert.deepEqual(en, { hidden: false, text: 'This world has ended. Its turns no longer advance and no order can be sent. To play on, open the start page again and start a new world.', reread: false, ended: true });
  assert.doesNotMatch(en.text, /639|behind|[぀-ヿ一-鿿]/);
  setLang('ja');
  const ja = endedBannerView();
  assert.equal(ja.text, 'この世界は終了しました。ターンはもう進まず、命令も送れません。新しい世界は、開始ページを開き直して始めてください。');
  assert.equal(ja.hidden, false, 'said even when nothing is "behind" (the halted clock is not)');
  assert.match(ja.text, /ターン/); assert.doesNotMatch(ja.text, /鐘/);
  // not ended: exactly as before
  assert.deepEqual(staleBannerView({ stale: { stale: false }, localPlay: true }), { hidden: true, text: '', reread: false });
  assert.equal(staleBannerView({ stale, localPlay: true }).reread, true);
  assert.equal(staleBannerView({ stale, localPlay: true }).ended, undefined);
  assert.match(staleBannerView({ stale, localPlay: true }).text, /639/, 'a world that only lags still says how far behind');
});

test('the notice\'s "check the world" key says the end as the end, not as a failed check', () => {
  setLang('en');
  assert.equal(keeperText({ state: 'ended' }), worldEndedText());
  assert.match(keeperText({ state: 'ended' }), /^This world has ended\./);
  assert.notEqual(keeperText({ state: 'unavailable' }), keeperText({ state: 'ended' }));
  assert.equal(worldEndedWord(), 'ended');
  setLang('ja');
  assert.equal(worldEndedWord(), '終了済み');
});

test('the page: the dial, the season poll, the gate and the map are wired to the confirmed end (source)', () => {
  const app = read('app.mjs'), gate = read('flocalplay.mjs');
  // the dial: the last turn and "world ended", through the one-line text a screen reader gets
  assert.match(app, /if \(chip\.stopped\) return L`ターン \$\{fmtNum\(chip\.bell\)\} · 終了済み`;/);
  assert.match(app, /left: chip\.stopped \? worldEndedWord\(\) : chip\.ended \?/);
  assert.match(app, /dialMarkup\(FS\.clock \? stoppedChip\(bellChip\(FS\.clock, now\), FS\.worldEnded\) : null\)/);
  // the season poll asks only on a network failure, and says no "could not connect" once the end is known
  assert.match(app, /\n  if \(!r\.ok && r\.code === 'network'\) worldWatch\?\.readFailed\(\);\n  if \(!r\.ok && FS\.worldEnded\) \{ clearInspection\(FS\); clearOutbound\(FS\); return false; \}\n  if \(!r\.ok\) \{ clearInspection\(FS\); clearOutbound\(FS\); seasonError\(/);
  assert.match(app, /\{ const check = localPlayWorldCheck\(cfg\); if \(check\) worldWatch = createWorldWatch\(\{ ask: \(\) => check\(\)\.then\(worldStateOf\), onEnded: worldEnded \}\); \}/);
  // the end: the clock halted, the season's own error cleared, the panels' turn the halted clock's
  assert.match(app, /export function worldEnded\(\) \{\n  FS\.worldEnded = \{ at: Date\.now\(\) \};\n  FS\.chain\?\.halt\?\.\(\);\n  if \(FS\.error\?\.source === 'season'\) FS\.error = null;/);
  assert.match(app, /const v = FS\.worldEnded \? endedBannerView\(\) : staleBannerView\(\{ stale: FS\.stale, localPlay: !!FS\.localPlay \}\);/);
  // the gate's question: the keeper route, this page's own address, only a connected launcher world
  assert.match(gate, /const checkWorld = async \(\) => \{\n    if \(!launcher \|\| !done \|\| !handle \|\| handle\.destroyed\) return null;\n    const wallet = handle\.address;\n    const result = await askLauncher\('\/local-play\/keeper', \{ wallet \}, 'LauncherKeeperFailed'\);/);
  assert.match(gate, /if \(launcher\) worldChecks\.set\(cfgOut, checkWorld\);/, 'only a launcher world\'s cfg carries the question');
  assert.equal(gate.split('checkWorld').length - 1, 4, 'defined, registered for the cfg, returned by the gate (and named once in a comment): never called by the gate itself');
  // the English dial text holds the word the dial cuts out of it
  const en = readFileSync(new URL('../../permutation-server/web/lang/en-frontier-play.mjs', import.meta.url), 'utf8');
  assert.match(en, /'ターン \{0\} · 終了済み': 'Turn \{0\} · ended',/);
  assert.match(en, /'終了済み': 'ended',/);
});
