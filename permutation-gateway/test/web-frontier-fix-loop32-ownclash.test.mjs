// fix-loop32, LP32 BREAK-1: the player's own defensive clashes in the walletless demo (a castle host attacked, pushed back,
// lost) are told and listed — map/keepmount.mjs ownClashOn: the own-clash watch (map/ownclash.mjs) runs on a conquest
// season and in a sample world's arrival-control territory. Keyless: the fixture's records, no key is made or used.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { mountKeepBoard, keepFeedOf, ownClashOn } from '../../permutation-server/web/frontier/map/keepmount.mjs';

afterEach(() => setLang('ja'));
const tick = () => new Promise(r => setTimeout(r, 0));
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TERRITORY = { territory: { mode: 'arrival-control', authority: 'local-preview' } };

// ------------------------------------------------------------------ BREAK-1
// loop-play31's real defender record (a host standing on a keep tile, attacked in turn 620), as fix-loop31's test reads it
const FIX = JSON.parse(read('./fixtures/uxs1-keep-two-turns.json'));
const [P, Q] = FIX.province;
const rec = bell => { const r = FIX.records[bell]; return { report: r, inputs: decode('ClashInputs', fromBase64(r.inputs_b64)), before: decode('Province', fromBase64(r.province_before_b64)) }; };

function board(fs) {
  const map = { setKeepFeed(fn) { this.feed = fn; }, keeps: { reachOwn: true, setReach() {} } };
  const mounted = mountKeepBoard({ map, state: () => fs, clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }) });
  return { map, mounted };
}
const page = extra => ({ mode: 'play', citizen: { faction: FIX.viewer.faction }, holdings: [FIX.viewer.holding], marches: [], nowBell: 622, chronicle: [], feed: [], ownClashes: [],
  ui: { autoPan: false, battleFx: 'off' }, provinces: new Map([[`${P},${Q}`, { province: rec(621).before }]]), season: { programVersion: 2, layoutVersion: 1 }, ...extra });

test('BREAK-1 the own-clash watch is on in a sample world with arrival-control territory (the demo), as on a conquest season; never in the basic game', () => {
  assert.equal(ownClashOn({ season: { programVersion: 2, layoutVersion: 1 } }), false, 'the basic game');
  assert.equal(ownClashOn({ season: { programVersion: 3, layoutVersion: 2 } }), true, 'a conquest season');
  // the walletless demo: program 2 / layout 1 and the sample world's territory (what the live page reads)
  const demo = { season: { programVersion: 2, layoutVersion: 1 }, sample: TERRITORY };
  assert.equal(ownClashOn(demo), true);
  assert.equal(keepFeedOf(demo).enabled, false, 'the keep board itself stays off there');
});

test('BREAK-1 in the demo a clash of the viewer\'s host where it stands (a castle defended) is told — notice + "your clash reports" — and not in the basic game', async () => {
  for (const [name, extra, told] of [['demo', { sample: TERRITORY }, true], ['basic', {}, false]]) {
    const fs = page(extra), { map } = board(fs);
    map.feed();                       // the first reading is not news
    fs.chronicle = [{ seq: '1', record: { name: 'CLASH', p: P, q: Q, bell: 620, engagements: 1 } }];
    map.feed(); await tick(); await tick();
    assert.equal(fs.feed.length, told ? 1 : 0, `${name}: the notice`);
    assert.deepEqual(fs.ownClashes.map(c => [c.p, c.q, c.bell]), told ? [[P, Q, 620]] : [], `${name}: the list of clash reports`);
    if (told) {
      assert.equal(fs.feed[0].id, `cl:${P},${Q},620`);
      assert.equal(fs.feed[0].kind, 'battle');
      assert.deepEqual(fs.feed[0].battle, { p: P, q: Q, bell: 620 }, 'with the record\'s own 報告');
      assert.doesNotMatch(JSON.stringify(fs.feed[0].words ?? {}), /season|シーズン/i);
    }
  }
});
