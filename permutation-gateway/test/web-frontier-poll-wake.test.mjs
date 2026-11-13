// The page's poll loop wakes when the page is shown again: the next tick runs at once, then the visible cadence —
// not the hidden wait that was pending — and a wake never runs two ticks side by side. Reads only (no world here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPollLoop } from '../../permutation-server/web/frontier/poll-loop.mjs';
import { pollDelay, HIDDEN_POLL } from '../../permutation-server/web/frontier/controller.mjs';

// a fake clock: timers fire only when `advance` passes them
function clock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimer: (f, ms) => { timers.set(++id, { at: now + ms, f }); return id; },
    clearTimer: h => { timers.delete(h); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].f();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
    },
    count: () => timers.size,
    now: () => now,
  };
}

test('hidden, the next tick waits the hidden delay; a wake runs it at once, then the visible cadence', async () => {
  const c = clock(); const page = { hidden: true }; const ticks = [];
  const loop = createPollLoop({ tick: () => { ticks.push({ at: c.now(), hidden: page.hidden }); }, delay: () => pollDelay({ hidden: page.hidden, cap: 7.5 }), setTimer: c.setTimer, clearTimer: c.clearTimer });
  loop.start(0);
  await c.advance(0);
  assert.deepEqual(ticks, [{ at: 0, hidden: true }]);
  assert.equal(pollDelay({ hidden: true, cap: 7.5 }), 15, 'at ×20 a hidden page waits two quarter-turns');
  await c.advance(5000);
  assert.equal(ticks.length, 1, 'still waiting the hidden delay');
  page.hidden = false; loop.wake();
  await c.advance(0);
  assert.deepEqual(ticks.at(-1), { at: 5000, hidden: false }, 'the full read comes at once on return');
  await c.advance(7499);
  assert.equal(ticks.length, 2);
  await c.advance(1);
  assert.deepEqual(ticks.at(-1), { at: 12500, hidden: false }, 'then the visible cadence (7.5 s), not the old hidden wait');
  assert.equal(c.count(), 1, 'one timer only');
});

test('a wake during a running tick never starts a second one beside it: one more tick right after', async () => {
  const c = clock(); let release; let running = 0, most = 0, n = 0;
  const loop = createPollLoop({
    tick: () => { n++; running++; most = Math.max(most, running); return new Promise(r => { release = () => { running--; r(); }; }); },
    delay: () => 30, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  loop.start(0); await c.advance(0);
  assert.equal(n, 1); assert.equal(loop.running(), true);
  loop.wake(); loop.wake(); await c.advance(0);
  assert.equal(n, 1, 'no second tick while one runs');
  release(); for (let i = 0; i < 5; i++) await Promise.resolve();
  await c.advance(0);
  assert.equal(n, 2, 'the asked-for tick runs as soon as the first ends'); assert.equal(most, 1);
  release(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(c.count(), 1, 'back to one timer at the normal delay');
});

test('a failing tick does not stop the loop; a wake with nothing pending just runs the tick', async () => {
  const c = clock(); let n = 0;
  const loop = createPollLoop({ tick: () => { n++; if (n === 1) throw new Error('read failed'); }, delay: () => 10, setTimer: c.setTimer, clearTimer: c.clearTimer });
  loop.start(0); await c.advance(0); assert.equal(n, 1);
  await c.advance(10_000); assert.equal(n, 2, 'the loop went on after the throw');
  loop.wake(); await c.advance(0); assert.equal(n, 3);
  assert.equal(HIDDEN_POLL, 60, 'the hidden poll itself is unchanged');
});

test('the controller wires the wake to visibility and pageshow, and the loop only reads', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ createPollLoop \} from '\.\/poll-loop\.mjs';/);
  assert.match(src, /addEventListener\?\.\('visibilitychange', \(\) => \{ if \(!hidden\(\)\) poll\.wake\(\); \}\);/);
  assert.match(src, /addEventListener\?\.\('pageshow', e => \{ if \(e\?\.persisted && !hidden\(\)\) poll\.wake\(\); \}\);/);
  assert.ok(!/visibilitychange', \(\) => \{ if \(!hidden\(\)\) refreshSoon\(0\)/.test(src), 'no second read path beside the loop');
  const at = src.indexOf('const poll = pollLoop = createPollLoop({'), block = src.slice(at, src.indexOf('poll.start(', at));
  assert.match(block, /if \(hidden\(\)\) await revealTick\(\); else await refresh\(\);/);
  assert.ok(!/\bact\(|ACTIONS|send|sign/i.test(block.replace(/console\.error\('frontier refresh:', e\)/, '')), 'the loop builds, signs and sends nothing');
  const mod = readFileSync(new URL('../../permutation-server/web/frontier/poll-loop.mjs', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|send|sign/i.test(mod.replace(/builds, signs and sends nothing/, '')), 'the loop module itself reads and sends nothing');
});

// ---- negative cases: repeated events, hidden/in-flight, failure then return

test('repeated wakes (visibilitychange and pageshow together, or twice) are one read, and never more than one timer', async () => {
  const c = clock(); let n = 0;
  const loop = createPollLoop({ tick: () => { n++; }, delay: () => 30, setTimer: c.setTimer, clearTimer: c.clearTimer });
  loop.start(30); await c.advance(1000);
  loop.wake(); loop.wake(); loop.wake();
  assert.equal(c.count(), 1, 'one timer after three wakes');
  await c.advance(0);
  assert.equal(n, 1, 'three wakes, one read');
  await c.advance(29_999); assert.equal(n, 1);
  await c.advance(1); assert.equal(n, 2, 'then the normal delay');
});

test('a hidden page is not woken, and its in-flight reads stay one at a time', async () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  // (both wakes require the page to be shown; a pageshow from a fresh load, not the cache, is the boot's own read)
  assert.match(src, /'visibilitychange', \(\) => \{ if \(!hidden\(\)\) poll\.wake\(\); \}/);
  assert.match(src, /'pageshow', e => \{ if \(e\?\.persisted && !hidden\(\)\) poll\.wake\(\); \}/);
  // in flight: wakes while a slow read runs never overlap it, and the loop keeps one timer
  const c = clock(); const pend = []; let running = 0, most = 0, n = 0;
  const loop = createPollLoop({ tick: () => { n++; running++; most = Math.max(most, running); return new Promise(r => pend.push(() => { running--; r(); })); }, delay: () => 10, setTimer: c.setTimer, clearTimer: c.clearTimer });
  loop.start(0); await c.advance(0);
  for (let i = 0; i < 4; i++) { loop.wake(); await c.advance(500); }
  assert.equal(n, 1); assert.equal(most, 1); assert.equal(c.count(), 0, 'no timer stacked while the read runs');
  pend.shift()(); for (let i = 0; i < 5; i++) await Promise.resolve(); await c.advance(0);
  assert.equal(n, 2, 'exactly one more read for all four wakes');
  pend.shift()(); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(c.count(), 1); assert.equal(most, 1);
});

test('a read that fails on return: the loop goes on, backs off by the page\'s own rule, and the next wake reads again', async () => {
  const c = clock(); let errors = 0, n = 0, fail = true;
  const loop = createPollLoop({
    tick: async () => { n++; try { if (fail) throw new Error('herald down'); errors = 0; } catch { errors++; } },
    delay: () => pollDelay({ hidden: false, errors, cap: 7.5 }), setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  loop.start(60); loop.wake(); await c.advance(0);
  assert.equal(n, 1); assert.equal(errors, 1);
  await c.advance(14_999); assert.equal(n, 1, 'one error doubles the 7.5 s cadence');
  await c.advance(1); assert.equal(n, 2); assert.equal(errors, 2);
  fail = false; loop.wake(); await c.advance(0);
  assert.equal(n, 3); assert.equal(errors, 0, 'recovered on the next wake');
  await c.advance(7500); assert.equal(n, 4, 'back to the visible cadence');
});

// ---- the stale banner on local play: re-read, never reload; the ordinary page unchanged

test('the stale banner: the ordinary page keeps its words; local play says not to reload and offers a re-read', async () => {
  const { staleBannerView, rereadLabel } = await import('../../permutation-server/web/frontier/stale-banner.mjs');
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  assert.deepEqual(staleBannerView({ stale: { stale: false, behind: 3 }, localPlay: true }), { hidden: true, text: '', reread: false });
  const web = staleBannerView({ stale: { stale: true, behind: 180.4 }, localPlay: false });
  assert.equal(web.text, '表示が 180 秒遅れています。最新の状態が必要な操作の前に再読み込みしてください。'); assert.equal(web.reread, false);
  const lp = staleBannerView({ stale: { stale: true, behind: 180.4 }, localPlay: true });
  assert.equal(lp.reread, true);
  assert.match(lp.text, /再読み込みはしないでください（この世界の鍵が消え、続けられなくなります）/);
  assert.ok(!/再読み込みしてください/.test(lp.text), 'local play is never told to reload');
  assert.equal(rereadLabel(), '最新の状態を読み直す');
  setLang('en');
  try {
    assert.match(staleBannerView({ stale: { stale: true, behind: 61 }, localPlay: true }).text, /^This view is 61 s behind\. Do not reload/);
    assert.equal(rereadLabel(), 'Read the latest state');
  } finally { setLang('ja'); }
});

test('the re-read is a read: an action of its own, not a send, waking the poll loop', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(ctl, /'state-reread': \(\) => rereadState\(\),/);
  assert.match(ctl, /export function rereadState\(\) \{ pollLoop\?\.wake\(\); \}/);
  const sends = /export const SENDS = Object\.freeze\(new Set\(\[([^\]]+)\]/.exec(app)[1];
  assert.ok(!/state-reread/.test(sends), 'not among the sends');
  assert.match(app, /staleBannerView\(\{ stale: FS\.stale, localPlay: !!FS\.localPlay \}\)/);
  assert.match(app, /btn\.dataset\.act = 'state-reread'/);
});
