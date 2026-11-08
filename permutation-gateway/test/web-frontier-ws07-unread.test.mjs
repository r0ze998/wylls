// Workstream 07: a record not read is never shown as "none". The troops screen (screens/host.mjs) and the guide
// (screens/onboarding.mjs) read the village's hosts from its province's record: until that record is read, they say
// it is not read (and offer no Train or Muster) instead of "no hosts".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render as hosts, homeProvinceUnread } from '../../permutation-server/web/frontier/screens/host.mjs';
import { marchObjective } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const site = { p: 2, q: 0, site: 2, gen: 1, tile: 20, faction: 0 };
const village = { ...site, state: 2, tier: 0, flags: 0, reserve: Array(8).fill(0), queue: [], transit: [], explore: { state: 0 } };
const fs = provinces => ({ mode: 'play', citizen: { faction: 0 }, holdings: [village], activeHolding: 0, provinces, nowBell: 10, chain: { now: () => 1000 } });
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('the troops screen: the village\'s province not read is said, with 読み込み直す; read and empty is "no hosts"', () => {
  setLang('ja');
  const unread = fs(new Map());
  assert.equal(homeProvinceUnread(unread), true);
  const u = String(hosts(unread));
  assert.match(plain(u), /記録をまだ読み込めていません/);
  assert.match(u, /data-act="reload"/);
  assert.doesNotMatch(plain(u), /軍勢はいません/, 'never "no hosts" for a record not read');
  const read = fs(new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [] } }]]));
  assert.equal(homeProvinceUnread(read), false);
  assert.match(plain(hosts(read)), /軍勢はいません/, 'read, and none: said as before');
  assert.equal(homeProvinceUnread({ holdings: [], provinces: new Map() }), false, 'no village: nothing to read');
});

test('in English too', () => {
  setLang('en');
  try { assert.match(plain(hosts(fs(new Map()))), /Your record has not loaded yet/); } finally { setLang('ja'); }
});

test('the guide\'s march step: the village\'s province not read is not "prepare troops" (workstream 16\'s review)', () => {
  setLang('ja');
  const unread = marchObjective(fs(new Map()));
  assert.deepEqual([unread.act, unread.label], ['guide-open', '記録を読み込んでいます…']);
  const read = marchObjective(fs(new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [] } }]])));
  assert.deepEqual([read.act, read.data], ['tab', { tab: 'holding' }], 'read, and no host: prepare troops, as before');
});
