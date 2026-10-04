// integ-B (smoke-b4): the closer's clock follows the chain after the fleet has exited. In smoke-b4 the stack's drain ran at 20x, the clock's last
// scale (from the brain) was 10x, and the registrar published with the closer 12 bells behind the herald (M3 tail_truncated: files to bell 96,
// the herald closed bell 108). These tests fail on the old code: the exports (observeChain, brainSilentMs, catchUpClockFromHerald) did not
// exist, and the service did not read /h/season.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClock, createCloser } from '../citizens/mind/closer.mjs';
import { catchUpClockFromHerald, createCitizensService } from '../citizens/server.mjs';
import { makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, makeSpeech, makeSocial, CONFIG } from './fixtures/ai-mind-doubles.mjs';

const G = 1_000_000;
const season = (latestUnix) => ({ ok: true, status: 200, json: async () => ({ latestUnix, genesisTs: G }) });

function anchored({ nowMs, gameS, scale = 10 }) {
  const clock = createClock({ genesisTs: G, scale, nowMs: () => nowMs.v });
  clock.observe({ now_game: gameS, scale }, nowMs.v);
  return clock;
}

test('observeChain re-anchors without counting as a brain observation (brainSilentMs keeps growing)', () => {
  const t = { v: 1000 };
  const clock = anchored({ nowMs: t, gameS: G + 100 });
  assert.equal(clock.brainSilentMs(t.v), 0);
  t.v += 40_000;
  clock.observeChain(G + 5000, t.v);
  assert.equal(clock.brainSilentMs(t.v), 40_000, 'a chain observation does not reset the brain-silence timer');
  assert.equal(clock.gameNow(t.v), G + 5000);
  assert.equal(createClock({ genesisTs: G }).brainSilentMs(), Infinity, 'never observed by a brain');
});

test('catch-up: the chain is ahead of the clock (the drain at 20x against a clock at 10x): the clock moves forward', async () => {
  const t = { v: 0 };
  const clock = anchored({ nowMs: t, gameS: G + 600 });
  t.v += 10_000; // clock: G + 600 + 100
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(G + 600 + 200)), true);
  assert.equal(clock.gameNow(t.v), G + 800);
});

test('catch-up: while the brain is active the clock is never pulled back to the herald (it lags the brain by a little)', async () => {
  const t = { v: 0 };
  const clock = anchored({ nowMs: t, gameS: G + 600 });
  t.v += 10_000;
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(G + 650)), false);
  assert.equal(clock.gameNow(t.v), G + 700);
});

test('catch-up: once the brain has been silent the clock follows the chain back too, so it stops where a paused chain stops', async () => {
  const t = { v: 0 };
  const clock = anchored({ nowMs: t, gameS: G + 600 });
  t.v += 120_000; // the fleet exited; the extrapolation at 10x ran on to G + 1800
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(G + 900)), true);
  assert.equal(clock.gameNow(t.v), G + 900);
});

test('catch-up: no anchor, a refusing herald, garbage and a thrown fetch all leave the clock alone', async () => {
  const t = { v: 0 };
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', createClock({ genesisTs: G, nowMs: () => t.v }), async () => season(G + 99999)), false);
  const clock = anchored({ nowMs: t, gameS: G + 600 });
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => ({ ok: false, status: 503 })), false);
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => ({ ok: true, json: async () => ({ latestUnix: 'x' }) })), false);
  assert.equal(await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => { throw new Error('down'); }), false);
  assert.equal(clock.gameNow(t.v), G + 600);
});

test('the closer closes the bells a catch-up brings into the past (12 bells at once), and none the paused chain never reached', async () => {
  const t = { v: 0 };
  const clock = anchored({ nowMs: t, gameS: G + 96 * 600 + 100 });
  const closed = [];
  const closer = createCloser({ clock, social: { closeBell: async () => null }, records: { closeBell: () => ({}) }, onClosed: async (b) => closed.push(b), start: 96, nowMs: () => t.v });
  t.v += 120_000;
  await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(G + 108 * 600 + 50));
  assert.deepEqual(await closer.tick(t.v), Array.from({ length: 12 }, (_, i) => 96 + i), 'bells 96..107 are closed; bell 108 needs 20 more game seconds past its end');
  t.v += 300_000; // the chain is paused: the poll keeps pulling the clock to the frozen latestUnix
  await catchUpClockFromHerald('http://127.0.0.1:1', clock, async () => season(G + 108 * 600 + 50));
  assert.deepEqual(await closer.tick(t.v), [], 'no bell past the chain is closed');
});

test('the service polls the herald /h/season: with a fake herald ahead of the clock the clock follows (old code: it did not read /h/season)', async () => {
  let latest = G + 100;
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/h/season') ? { latestUnix: latest, genesisTs: G } : {})); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-clock-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(makeRosterJson({ n: 3 })));
  const svc = await createCitizensService(
    { aiDir, herald: `http://127.0.0.1:${srv.address().port}`, llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: 31, genesisTs: G },
    { test: true, noCloserTimer: true, clockPollMs: 30, config: CONFIG, speech: makeSpeech(), stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble, personaOf: personaOfDouble, nameOf: nameOfDouble, social: makeSocial(), feed: { cursorBell: () => null, wakeEvents: () => [] } },
  );
  try {
    svc.clock.observe({ now_game: G + 100, scale: 10 });
    latest = G + 10 * 600 + 300;
    const t0 = Date.now();
    while (svc.clock.bell() < 10 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
    assert.ok(svc.clock.bell() >= 10, `the clock followed the herald (bell ${svc.clock.bell()})`);
  } finally { await svc.close(); await new Promise((r) => srv.close(r)); }
});
