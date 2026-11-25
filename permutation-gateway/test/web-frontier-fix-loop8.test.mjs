// fix-loop8: LP8-8 (the boundary card's words) and the rest of LP7-6 (国と領土 offered the keep the viewer's own host stood on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ownHostOnKeep } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import EN_HAND from '../../permutation-server/web/lang/en-frontier-hand.mjs';

const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');

test('LP8-8: the road read names the WATCHTOWERS\' wear (物見櫓, not the abolished central tower), in percent, and says what WideDestinationRequired means', () => {
  const hand = src('hud/hand.mjs');
  assert.doesNotMatch(hand, /塔の消耗/, 'no 「塔の消耗」');
  assert.ok(hand.includes('L`記録上の移動時間 ${r.travelSecs} 秒・物見櫓に見張られる道で兵の ${fmtNum(r.wearBps / 100)}% を失います`'));
  assert.ok(hand.includes('L`記録上の移動時間 ${r.travelSecs} 秒（物見櫓に見張られる区間はありません）`'));
  assert.ok(hand.includes(": r.code === 'WideDestinationRequired' ? L`終点はまだリング 128 の内側です。境界の外まで道を続けてください。`"));
  assert.equal(EN_HAND['記録上の移動時間 {0} 秒・物見櫓に見張られる道で兵の {1}% を失います'], 'Recorded travel time: {0} seconds; watchtowers along the road cost {1}% of the troops');
  assert.equal(EN_HAND['記録上の移動時間 {0} 秒・塔の消耗 {1} bps'], undefined);
  assert.doesNotMatch(JSON.stringify(EN_HAND), /tower wear/);
});

test('LP7-6 (rest): a keep the viewer\'s host stands on, or has arrived at with its march record still open, is not a keep to reach', () => {
  const keep = { p: 1, q: 0, tile: 8, holder: 1 };
  const march = { dest: { p: 1, q: 0, tile: 8 }, entry: { arriveBell: 6, host: '4294967296' } };
  const fs = (extra = {}) => ({ nowBell: 8, holdings: [], provinces: new Map(), marches: [march], ...extra });
  assert.equal(ownHostOnKeep(fs(), keep), true, 'arrived (turn 6 < 8), the host in no list yet');
  assert.equal(ownHostOnKeep(fs({ nowBell: 5 }), keep), false, 'still on its way: the keep is a destination');
  assert.equal(ownHostOnKeep(fs(), { ...keep, tile: 9 }), false, 'another tile');
  assert.equal(ownHostOnKeep(fs(), { ...keep, p: 2 }), false, 'another province');
  assert.equal(ownHostOnKeep(fs({ marches: [] }), keep), false, 'no march, no host there');
  assert.equal(ownHostOnKeep(fs({ marches: [{ ...march, dest: null }] }), keep), false);
  const c = src('screens/conquest.mjs');
  assert.ok(c.includes('const held = rest.filter(x => ownHostOnKeep(FS, x)), others = rest.filter(x => !held.includes(x));'));
  assert.ok(c.includes('あなたの軍勢が着いている砦（自分の国のもの以外）'));
  assert.ok(c.includes('${others.length ? html`<ul class="list kr-rows" aria-labelledby="conquest-reach-title">${others.map(row)}</ul>`'), 'the reach list is the others only');
});

test('LP8-5: after the keep is taken the wide host card follows look-only — the capture line stays, nothing is sent by itself, the button comes back when a step exists', async () => {
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  const W = await import('../../permutation-server/web/frontier/screens/wideholding.mjs');
  setLang('ja');
  const line = String(W.wideHostWaitLine({ reason: 'captured', lag: 2, hold: { outcome: 'taken', to: { p: '-64', q: '-65' }, at: 628 } }));
  assert.match(line, /data-wide-host-wait="captured"/);
  assert.match(line, /砦を奪った軍勢は、その砦に残って守っています。/);
  assert.match(line, /自動では送りません/);
  assert.doesNotMatch(line, /送れるようになったら一手を送ります/, 'not the auto-send words of the other waits');
  const c = src('controller.mjs');
  // (w2-wipeout: a NEW host after the capture — the planner's rebuild step — goes through the rebuild offer instead, same rule)
  assert.ok(c.includes("if (w.decision && !w.decision.rebuild && auto && mem.waiting?.reason === 'captured') { wideHostStopWait(mem); FS.ui = { ...FS.ui, wideHostReady: true }; invalidate('panel'); return { ok: false, code: 'WideHostReady' }; }"), 'a step found while following after a capture is NOT sent');
  assert.ok(c.includes("if (!w.decision && w.wait === 'march' && mem.wideHold?.outcome === 'taken') { wideHostWait(mem, { reason: 'captured', lag: w.lag ?? null, hold: mem.wideHold });"));
  assert.ok(c.includes("try { return await wideHostStep(e, mem0, { auto: d.auto === true }); }"));
  const w = src('screens/wideholding.mjs');
  assert.ok(w.includes("${FS.ui?.wideHostSay?.kind === 'decision' && FS.ui.wideHostSay.hold?.outcome ? html`<p class=\"wide-host-held\" role=\"status\">${wideHoldOutcomeText(FS.ui.wideHostSay.hold)}</p>` : ''}"), 'the capture line stays beside a new cycle\'s step');
  assert.match(w, /次の一手を送れます（新しい軍勢の訓練から）。押すと送ります。/);
});
