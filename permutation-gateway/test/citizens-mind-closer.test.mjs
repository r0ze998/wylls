// AC1a: the bell closer and the game clock (section 6.3): every bell is closed at bell_start(b+1) + 20 game-s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClock, createCloser, CLOSE_DELAY_GAME_S } from '../citizens/mind/closer.mjs';
import { createRecords } from '../citizens/mind/records.mjs';
import { createMetrics } from '../citizens/mind/metrics.mjs';

const G0 = 1_800_000_000;
const mk = (scale = 10) => {
  const clock = createClock({ genesisTs: G0, scale });
  return clock;
};

test('the clock is anchored by the brain\'s now_game and scale; bells follow chain time at scale x real time', () => {
  const c = mk();
  assert.equal(c.hasAnchor(), false);
  c.observe({ now_game: G0 + 1200 + 30, scale: 10 }, 1_000_000);
  assert.equal(c.hasAnchor(), true);
  assert.equal(c.bell(1_000_000), 2);
  assert.equal(c.bell(1_000_000 + 56_000), 2, '30 + 560 = 590 game-s into bell 2');
  assert.equal(c.bell(1_000_000 + 57_000), 3);
  assert.equal(c.bellStartGame(3), G0 + 1800);
  assert.equal(Math.round(c.bellStartReal(3)), 1_000_000 + 57_000, 'bell 3 starts 570 game-s after the anchor = 57 s real at 10x');
  assert.equal(c.marginMs(), 6000, 'max(3 s, 60 game-s / 10) = 6 s');
  assert.equal(createClock({ genesisTs: G0, scale: 60 }).marginMs(), 3000);
});

test('the closer closes every bell, empty ones included, once, in order, after the 20 game-s delay', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-close-'));
  const records = createRecords({ aiDir: d });
  const metrics = createMetrics();
  const clock = mk();
  const socialClosed = [];
  const social = { async closeBell(b) { socialClosed.push(b); return { root: '0'.repeat(64) }; } };
  const hooks = [];
  const closer = createCloser({ clock, social, records, metrics, onClosed: (b) => hooks.push(b) });
  assert.deepEqual(await closer.tick(5), [], 'no anchor yet');
  clock.observe({ now_game: G0 + 5, scale: 10 }, 0); // bell 0, 5 game-s in
  assert.deepEqual(await closer.tick(0), []);
  // bell 0 closes at G0 + 600 + 20
  assert.deepEqual(await closer.tick(((600 + CLOSE_DELAY_GAME_S - 5) / 10) * 1000 - 1), []);
  assert.deepEqual(await closer.tick(((600 + CLOSE_DELAY_GAME_S - 5) / 10) * 1000), [0]);
  // jump 3 bells ahead: 1, 2 and 3 close, in order
  assert.deepEqual(await closer.tick(((4 * 600 + 20 - 5) / 10) * 1000), [1, 2, 3]);
  assert.deepEqual(socialClosed, [0, 1, 2, 3]);
  assert.deepEqual(hooks, [0, 1, 2, 3]);
  for (const b of [0, 1, 2, 3]) assert.equal(existsSync(join(d, `pub/minds/${b}.json`)), true);
  assert.equal(JSON.parse(readFileSync(join(d, 'pub/minds/2.json'), 'utf8')).root, '0'.repeat(64));
  assert.deepEqual(await closer.tick(((4 * 600 + 20 - 5) / 10) * 1000), [], 'idempotent');
  assert.equal(metrics.get('bells_closed'), 4);
});

test('a failing social close does not advance; the bell is retried at the next tick', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-close-'));
  const records = createRecords({ aiDir: d });
  const clock = mk();
  clock.observe({ now_game: G0, scale: 10 }, 0);
  let fail = true;
  const closer = createCloser({ clock, social: { async closeBell() { if (fail) throw new Error('down'); } }, records, metrics: createMetrics() });
  const t = ((600 + 20) / 10) * 1000;
  assert.deepEqual(await closer.tick(t), []);
  assert.equal(closer.errors.social, 1);
  assert.equal(existsSync(join(d, 'pub/minds/0.json')), false);
  fail = false;
  assert.deepEqual(await closer.tick(t), [0]);
});

test('setNext resumes after the last closed bell (restart)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-close-'));
  const clock = mk();
  clock.observe({ now_game: G0 + 3030, scale: 10 }, 0);
  const closer = createCloser({ clock, social: { async closeBell() {} }, records: createRecords({ aiDir: d }), metrics: createMetrics() });
  closer.setNext(4);
  assert.deepEqual(await closer.tick(0), [4], 'bell 4 ended at G0 + 3000; its close instant G0 + 3020 has passed; bells 0-3 are not replayed');
  assert.equal(closer.next(), 5);
});

test('records written by the closer carry the roots the registrar will anchor', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-close-'));
  const records = createRecords({ aiDir: d });
  records.add({ v: 2, ai: 'aaaaaaaaaaaaaaa1', index: 1000, bell: 0, kind: 'autopilot', mode: 'autopilot', reason: 'below_gate', wake: [], gate_score: 0, tx: [], choice: { ids: [], params: {}, council: null, goal_id: null, mem: [] }, retrieved: [], public: { say: [], why: null, why_withheld: null } });
  const clock = mk();
  clock.observe({ now_game: G0 + 700, scale: 10 }, 0);
  const closer = createCloser({ clock, social: { async closeBell() {} }, records, metrics: createMetrics() });
  await closer.tick(0);
  const j = JSON.parse(readFileSync(join(d, 'pub/minds/0.json'), 'utf8'));
  assert.equal(j.records.length, 1);
  assert.match(j.root, /^[0-9a-f]{64}$/);
  assert.notEqual(j.root, '0'.repeat(64));
});
