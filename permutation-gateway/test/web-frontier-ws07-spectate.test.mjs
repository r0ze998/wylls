// Workstream 07: the spectator page when /h/events cannot be read (found by workstream 08). Before, the first poll's
// failure left FS.chronicle undefined and refreshChronicle threw on it (`FS.chronicle.filter`), so the refresh never
// finished; and a record never read was shown as an empty one ("No clash yet", "Nothing recorded yet"). Now the read
// state is kept (FS.chronicleRead) and said. No wallet, no key, no signature: a fake herald answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import * as spectate from '../../permutation-server/web/frontier/screens/spectate.mjs';
import * as chronicle from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

/** A herald that answers nothing but what a test gives it (every other read: not ok). */
const herald = events => new Proxy({ events }, { get: (o, k) => (k in o ? o[k] : async () => ({ ok: false, code: 'NotFound' })) });
const text = FS => spectate.render(FS).map(String).join('\n').replace(/<[^>]+>/g, ' ');
const spectator = () => ({ mode: 'spectate', wallet: null, citizen: null, holdings: [], season: { seasonId: 7n, endBell: 2016, bellSecs: 600 }, clock: { genesisTs: 0 }, chain: { now: () => 6000 },
  record: { headSeq: '120', latestSlot: 1 }, provinces: new Map(), overviews: new Map(), chronicle: undefined, chronicleRead: undefined, feed: [], watch: {} });

async function withFS(fake, fn) {
  const saved = { ...FS };
  try { Object.assign(FS, spectator()); C.useHerald(fake); await fn(); } finally { C.useHerald(null); for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k]; Object.assign(FS, saved); }
}

test('no page read (an HTTP error or a thrown fetch): the refresh finishes, and the page says the record was not read — never "nothing yet"', async () => {
  for (const events of [async () => ({ ok: false, code: 'HTTP503' }), async () => { throw Object.assign(new Error('down'), { code: 'network' }); }]) {
    await withFS(herald(events), async () => {
      await C.refresh();
      assert.equal(FS.chronicle, undefined, 'nothing read is not an empty record');
      assert.equal(FS.chronicleRead.ok, false);
      assert.deepEqual(chronicle.chronicleState(FS).state, 'unread');
      setLang('en');
      const t = text(FS);
      assert.match(t, /The record of events could not be loaded \((HTTP503|network)\)\. This does not mean the record is empty/);
      assert.match(t, /whether there was a clash is not known/);
      assert.doesNotMatch(t, /No clash yet|No highlights yet|Nothing recorded yet/, 'an unread record is not an empty one');
      setLang('ja');
      assert.doesNotMatch(text(FS), /まだ衝突はありません|まだ見どころはありません|まだ記録はありません/);
    });
  }
});

test('pages read, then a poll fails: what was read stays, said as older; a later good poll clears it', async () => {
  let down = false;
  const page = { ok: true, events: [], next: '120', full: false };
  await withFS(herald(async () => (down ? { ok: false, code: 'HTTP502' } : page)), async () => {
    await C.refresh();
    assert.deepEqual(FS.chronicle, [], 'a page read with no records: an empty record, known');
    setLang('en');
    assert.match(text(FS), /No clash yet/);
    down = true; await C.refresh();
    assert.equal(chronicle.chronicleState(FS).state, 'stale');
    assert.match(text(FS), /The latest record of events could not be loaded \(HTTP502\)\. What is shown here is what was loaded before/);
    down = false; await C.refresh();
    assert.equal(chronicle.chronicleState(FS).state, 'ok');
    assert.doesNotMatch(text(FS), /could not be loaded/);
    setLang('ja');
  });
});

test('before any poll the page says it is loading, not that nothing happened', () => {
  setLang('en');
  const fs = spectator();
  assert.match(String(chronicle.render(fs)).replace(/<[^>]+>/g, ' '), /Loading the record of events/);
  assert.doesNotMatch(text(fs), /No clash yet|No highlights yet|Nothing recorded yet|could not be loaded/, 'loading is not "could not be loaded" either');
  setLang('ja');
});
