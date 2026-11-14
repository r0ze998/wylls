// Round 33b, the card's own words (hud/marchcard.mjs outlook): a conditional estimate with both turns, from the
// program's rules (see web-frontier-ready-again.test.mjs for the rule itself). This file imports only the card, so on
// the previous code it fails on what the card says, not on a missing export. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlook } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the card: a conditional estimate with both turns, also where no defenders are recorded; English', () => {
  setLang('ja');
  for (const def of [{ total: 100 }, { total: 0 }, null]) {
    const out = text(outlook({ w: { value: 10 }, stam: 120, nowB: 6, def, sight: 3 }));
    assert.match(out, /見込み（今出発し、軍勢が残り、ほかの戦いがない場合）：次はターン 35 から。到着で戦った場合は遅くともターン 55 から/, JSON.stringify(def));
  }
  assert.doesNotMatch(text(outlook({ w: { value: 10 }, stam: 60, nowB: 6, def: null, sight: 3 })), /見込み/, 'short of stamina: no promise');
  setLang('en');
  assert.match(text(outlook({ w: { value: 10 }, stam: 120, nowB: 6, def: { total: 0 }, sight: 3 })), /Estimate if it sets out now, survives and meets no other fight: ready again from turn 35; after a fight on arrival, from turn 55 at the latest/);
  setLang('ja');
});
