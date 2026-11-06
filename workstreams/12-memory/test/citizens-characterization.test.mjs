// Workstream 12: what the EXISTING AI-citizen memory (permutation-gateway/citizens/memory, unchanged) does when a new
// Season account starts and its bells and tags restart, and what the read-only adapter shows instead.
// All episodes and ledgers here are SYNTHETIC (built in this file in the stored shapes); no live data.
// These tests pin current behaviour; they are not a statement that it is intended for a continuing world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve } from '../../../permutation-gateway/citizens/memory/retrieve.mjs';
import { Ledger } from '../../../permutation-gateway/citizens/memory/ledger.mjs';
import { dayOf } from '../../../permutation-gateway/citizens/memory/config.mjs';
import { advanceDayWorld, retrieveWorld, trustByPrincipal, worldEpisodes } from '../continuity/citizens-adapter.mjs';

// 4's mapping in this fixture: partition p1 starts at world bell 0, p2 at world bell 6000 (Season bells restart at 0)
const GENESIS = { p1: 0, p2: 6000 };
const toWorldBell = (partition, bell) => GENESIS[partition] + bell;
const TAG_P1 = '00000000000000b1', TAG_P2 = '00000000000000b2'; // one wallet, two Season-derived citizen tags
const principalOf = (partition, tag) => ({ [`p1|${TAG_P1}`]: 'wallet:B', [`p2|${TAG_P2}`]: 'wallet:B' })[`${partition}|${tag}`] ?? null;
const episode = (id, bell, kind = 'attacked_own', importance = 8) => ({ v: 1, id, bell, created_bell: bell + 2, kind, importance,
  entities: [TAG_P1], text: { en: `synthetic ${id}`, ja: '' }, src: [`event:${id}`], facts: {} });
const P1_EPISODES = [episode('e1', 4000), episode('e2', 4200, 'threat', 5), episode('e3', 5900, 'dm', 4)];
const temperament = { grudge: 50, loyalty: 50 };

test('existing retrieve: after a new Season starts, every episode of the previous one is invisible', () => {
  const ids = retrieve(P1_EPISODES, [TAG_P1], 100); // p2's bell 100, Season-relative
  assert.deepEqual(ids, [], 'created_bell (4002..5902) is not below the new Season\'s bell 100');
});

test('adapter: on the world clock the previous Season\'s episodes are retrieved, aged by world bells', () => {
  const eps = worldEpisodes([{ partition: 'p1', episodes: P1_EPISODES }], toWorldBell);
  const ids = retrieveWorld(eps, [TAG_P1], toWorldBell('p2', 100));
  assert.deepEqual(ids, ['p1:e1', 'p1:e2', 'p1:e3']);
  const e1 = eps.find(e => e.id === 'p1:e1');
  assert.deepEqual(e1.origin, { partition: 'p1', id: 'e1', bell: 4000, created_bell: 4002 }, 'the stored episode is kept as it was');
  assert.equal(P1_EPISODES[0].id, 'e1', 'input not modified');
  // an open grievance's source is still protected from the cut, by its stored id and partition
  const many = [...eps, ...Array.from({ length: 20 }, (_, i) => ({ ...episode(`n${i}`, 6050 + i, 'build_done', 2), id: `p2:n${i}` }))];
  const withG = retrieveWorld(many, [], toWorldBell('p2', 100), { grievances: [{ partition: 'p1', event: 'e1', bell: 4000, answered: false }] });
  assert.ok(withG.includes('p1:e1'));
});

test('existing ledger: with Season-relative days, decay and the daily reset stop after a new Season starts', () => {
  const led = Ledger.create({ tag: '00000000000000a1', bell: 30 * 144 });
  led.apply({ kind: 'trust', who: TAG_P1, amount: -15, id: 'd1', bell: 30 * 144 });
  assert.equal(led.trustOf(TAG_P1).t_code, -15);
  // the new Season's day 1 is "before" day 30: nothing happens
  assert.equal(led.advanceDay(dayOf(150), { temperament, ownNation: 1 }), false);
  assert.equal(led.trustOf(TAG_P1).t_code, -15);
  // the adapter's world day (6000 + 150 -> day 42) runs the same existing rule: decay toward 0, by the rule's own cap
  assert.equal(advanceDayWorld(led, toWorldBell('p2', 150), { temperament, ownNation: 1 }), true);
  assert.ok(led.trustOf(TAG_P1).t_code > -15 && led.trustOf(TAG_P1).t_code <= 0);
});

test('existing ledger: trust is keyed by the Season-derived tag, so the same wallet starts again at 0', () => {
  const p1 = Ledger.create({ tag: '00000000000000a1', bell: 0 });
  p1.apply({ kind: 'trust', who: TAG_P1, amount: -15, id: 'd1', bell: 10 });
  const p2 = Ledger.create({ tag: '00000000000000a1', bell: 0 });
  assert.equal(p2.trustOf(TAG_P2).total, 0, 'no memory of the grievance under the new tag');
  const view = trustByPrincipal([{ partition: 'p1', ledger: p1, tags: [TAG_P1] }, { partition: 'p2', ledger: p2, tags: [TAG_P2] }], principalOf);
  assert.equal(view.principals['wallet:B'].total, -15);
  assert.deepEqual(view.principals['wallet:B'].parts.map(x => [x.partition, x.tag]), [['p1', TAG_P1], ['p2', TAG_P2]]);
  const unknown = trustByPrincipal([{ partition: 'p2', ledger: p2, tags: ['00000000000000ff'] }], principalOf);
  assert.equal(unknown.unattributed.length, 1, 'a tag 4 has not attributed stays apart');
});

test('existing episode store: beyond 200 episodes the lowest-importance ones are evicted from the stored list', async () => {
  const { Episodes } = await import('../../../permutation-gateway/citizens/memory/store.mjs');
  const eps = new Episodes(Array.from({ length: 250 }, (_, i) => episode(`h${i}`, i * 10, i < 50 ? 'build_done' : 'threat', i < 50 ? 2 : 5)));
  assert.equal(eps.size, 200);
  assert.equal(eps.get('h0'), null, 'the oldest low-importance episode is gone from the store, not only from retrieval');
  // in a world that does not end, this cap is a history limit, not a per-Season one (reported as a decision for the owner)
});
