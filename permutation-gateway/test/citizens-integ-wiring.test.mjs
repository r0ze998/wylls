// integ-A: the wave-A wiring between units built in parallel (citizens/mind/wiring.mjs): the feed view the mind reads, the
// feed-wake watcher stub, and the episode pump (feed -> episodes_from_events -> AC2 stores -> published episodes file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedView, createWaveAWatcher, createEpisodePump } from '../citizens/mind/wiring.mjs';
import { createMemoryStore } from '../citizens/memory/store.mjs';

const TAG = '0123456789abcdef';
const GENESIS = 1_800_000_000;

function fakeFeed({ through = 10, head = 11, events = {}, wakes = {}, reveals = new Set() } = {}) {
  return {
    state: { through, head },
    completeThrough() { return this.state.through; },
    headBell() { return this.state.head; },
    cursor: () => '99',
    revealOf: (h, a) => (reveals.has(`${h}/${a}`) ? { ok: 1 } : null),
    events: (b) => events[b] ?? [],
    wakeEvents: (tag, b) => (tag === TAG ? wakes[b] ?? [] : []),
    owners: {
      homeOf: (t) => (t === TAG ? { p: 1, q: 2, site: 0 } : null),
      factionOfTag: () => 3,
      holdingsOf: (t) => (t === TAG ? [{ p: 1, q: 2, site: 0 }] : []),
      citizenOfHost: () => null,
    },
    async prepare() { return { province: () => null, clash: () => null, clashDetail: () => null, owners: this.owners, missing: [] }; },
  };
}

test('feedView: cursorBell is the lower of the feed and the pump; revealed reads the REVEAL, or gives up 7 bells after arrival', () => {
  const feed = fakeFeed({ through: 10, reveals: new Set(['77/5']) });
  const pump = { throughBell: () => 8 };
  const v = feedView(feed, pump);
  assert.equal(v.cursorBell(), 8);
  pump.throughBell = () => 12;
  assert.equal(v.cursorBell(), 10);
  feed.state.through = -1;
  assert.equal(v.cursorBell(), -1, 'a feed that has not reached the end of the log reports -1 (the mind refuses a model session: feed_lag)');
  assert.equal(v.revealed({ host_id: '77', arrive_bell: 5 }), true);
  assert.equal(v.revealed({ host_id: '78', arrive_bell: 5 }), false, 'head 11 is not past 5 + 7');
  feed.state.head = 13;
  assert.equal(v.revealed({ host_id: '78', arrive_bell: 5 }), true);
  assert.equal(feedView(null), null);
});

test('wave-A watcher: wakes are delivered once per range, a repeated bell returns the same list, THREAT carries the prompt facts', () => {
  const wakes = {
    8: [{ code: 'W-CLASH', weight: 4, bell: 8, seq: '1' }],
    9: [{ code: 'W-THREAT', weight: 2, bell: 9, seq: '2', nation: 4, dep_mass: 300, origin: { p: 0, q: 1 }, arrive_bell: 14, big: true }],
    10: [{ code: 'W-CLASH', weight: 4, bell: 10, seq: '3' }],
  };
  const w = createWaveAWatcher({ feed: fakeFeed({ wakes }) });
  const first = w.wakeEvents(TAG, 9); // first ask: the last 7 bells up to 9
  assert.deepEqual(first.map((x) => x.code), ['W-CLASH', 'W-THREAT']);
  assert.deepEqual(first[1].facts, { nation: 4, mass: 300, origin: { p: 0, q: 1 }, arrive_bell: 14 });
  assert.deepEqual(w.wakeEvents(TAG, 9), first, 'the same (tag, bell) answers the same');
  const next = w.wakeEvents(TAG, 10);
  assert.deepEqual(next.map((x) => x.seq), ['3'], 'only what is new since the previous decision');
  assert.deepEqual(w.wakeEvents(TAG, 8), [], 'an older bell is never asked again');
  assert.deepEqual(w.wakeEvents('ffffffffffffffff', 10), []);
});

test('episode pump: BUILD of the AI\'s own village becomes an episode in its store and a published episodes.json; idempotent; waits for the feed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-pump-'));
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const doneAt = GENESIS + 5 * 600 + 30;
  const feed = fakeFeed({ through: 3, events: { 5: [{ kind: 'BUILD', seq: '40', bell: 5, p: 1, q: 2, site: 0, item: 1, done_at: doneAt }] } });
  const views = { ownState: (tag, bell) => ({ ledger: stores.ledger(tag, { goals: [], bell }) }) };
  const roster = { ready: true, ai: [{ tag: TAG, wallet: 'W', faction: 3 }] };
  const pump = createEpisodePump({ feed, stores, views, roster, clock: { genesis: () => GENESIS } });
  assert.equal(pump.throughBell(), -1);
  await pump.tick();
  assert.equal(pump.throughBell(), 3);
  assert.equal(stores.episodes(TAG).size, 0, 'the BUILD is logged in bell 5, after the complete-through bell 3');
  feed.state.through = 8;
  await pump.tick();
  assert.equal(pump.throughBell(), 8);
  const eps = stores.episodes(TAG).list();
  assert.equal(eps.length, 1);
  assert.equal(eps[0].kind, 'build_done');
  assert.ok(eps[0].created_bell < 9);
  const file = join(dir, 'pub/memory', TAG, 'episodes.json');
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).count, 1);
  assert.equal(pump.published().length, 1);
  const sha = stores.episodes(TAG).sha256();
  feed.state.through = 9;
  await pump.tick();
  assert.equal(stores.episodes(TAG).sha256(), sha, 'a second pass over the same rows adds nothing');
  assert.equal(pump.stats.errors, 0);
});

test('episode pump: an AI with no village yet is skipped; a not-ready roster does nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-pump-'));
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const feed = fakeFeed({ through: 4 });
  const views = { ownState: (tag, bell) => ({ ledger: stores.ledger(tag, { goals: [], bell }) }) };
  const idle = createEpisodePump({ feed, stores, views, roster: { ready: false, ai: [] }, clock: { genesis: () => GENESIS } });
  await idle.tick();
  assert.equal(idle.throughBell(), -1);
  const pump = createEpisodePump({ feed, stores, views, roster: { ready: true, ai: [{ tag: 'aaaaaaaaaaaaaaaa', wallet: 'W2', faction: 1 }] }, clock: { genesis: () => GENESIS } });
  await pump.tick();
  assert.equal(pump.stats.ai_runs, 0);
  assert.equal(pump.throughBell(), 4);
});

test('feedView.waitCursor: pulls the feed and the pump until the cursor reaches the bell, or gives up after maxMs (the brain steps at the start of a bell)', async () => {
  const feed = fakeFeed({ through: 5 });
  let polls = 0;
  feed.poll = async () => { polls++; if (polls === 2) feed.state.through = 8; };
  const pump = { done: 5, throughBell() { return this.done; }, async tick() { this.done = feed.state.through; } };
  const v = feedView(feed, pump);
  assert.equal(await v.waitCursor(8, 3000), true);
  assert.equal(v.cursorBell(), 8);
  assert.ok(polls >= 2);
  feed.poll = async () => {};
  assert.equal(await v.waitCursor(20, 400), false, 'a feed that cannot vouch for the bell stays lagging after the bounded wait');
});
