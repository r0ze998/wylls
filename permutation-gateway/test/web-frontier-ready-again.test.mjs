// Round 33b: the march card's "ready again" estimate on the program's own rules (hud/marchcard.mjs readyAgain): a Depart
// in turn b with stamina s stores s − 74 at b (permutation-rules host.rs Stamina::spend); the arrival brings
// min(120, (s − 74) + max(0, a − (b + 1))) stored at the arrival turn a (frontier-abi clash_model.rs arrival_stamina);
// unopposed it may depart from a + 1, after a fight from a + 2 (ready_bell_after); a fight costs 20 saturating at 0
// unless the damage-ratio refund applies. Cross-checked against a host's entry decoded from a ×10 world (29 stored at
// turn 10 after a fight, 30 at 11) and fmarch.mjs staminaAt (the page's mirror of the lazy +1 a turn). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlook, readyAgain } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { staminaAt, DEPART_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
/** The first turn from `from` at which a stored (value, bell) reaches 74 and the ready turn has come. */
const firstTurn = (entry, readyBell, from) => { for (let t = from; t < from + 500; t++) if (t >= readyBell && staminaAt(entry, t) >= DEPART_STAMINA) return t; return null; };
/** The same rules step by step on the page's own staminaAt, for a cross-check. */
const model = (s, b, a, fight, refund = false) => {
  const arrive = staminaAt({ staminaValue: s - DEPART_STAMINA, staminaBell: b + 1 }, a);
  const v = fight && !refund ? Math.max(0, arrive - 20) : arrive;
  return firstTurn({ staminaValue: v, staminaBell: a }, fight ? a + 2 : a + 1, a);
};

test('the recorded world: 35 without a fight, 55 after the fight at the keep (its decoded entry: 29 stored at turn 10)', () => {
  assert.deepEqual(readyAgain(120, 6, 10), { calm: 35, fought: 55, arrive: 49 });
  assert.equal(firstTurn({ staminaValue: 29, staminaBell: 10 }, 12, 10), 55);
  assert.equal(staminaAt({ staminaValue: 30, staminaBell: 11 }, 33), 52, 'the host panel\'s 52/120 at turn 33');
});

test('saturation, a long march, the cooldown, the refund — each against the step-by-step rules', () => {
  // the review's case: s 74, depart 0, arrive 2: 1 on arrival, 0 after a fight → 76 (not 95)
  assert.deepEqual(readyAgain(74, 0, 2), { calm: 75, fought: 76, arrive: 1 });
  // the cap: a very long march arrives full; the turn after arrival (calm) or the cooldown (fought) decides
  assert.deepEqual(readyAgain(120, 0, 200), { calm: 201, fought: 202, arrive: 120 });
  for (const [s, b, a] of [[120, 6, 10], [74, 0, 2], [120, 0, 200], [100, 5, 7], [80, 3, 60], [120, 40, 42], [75, 1, 3]]) {
    const r = readyAgain(s, b, a);
    assert.equal(r.calm, model(s, b, a, false), `calm ${s},${b},${a}`);
    assert.equal(r.fought, model(s, b, a, true), `fought ${s},${b},${a}`);
    assert.ok(r.calm > a && r.fought >= a + 2, `never before the arrival nor the cooldown (${s},${b},${a})`);
    // a fight with the refund: no stamina cost, but the cooldown — between the two turns said
    const refunded = model(s, b, a, true, true);
    assert.ok(refunded >= r.calm && refunded <= r.fought, `refund within the range (${s},${b},${a}: ${refunded})`);
  }
  assert.equal(readyAgain(73, 0, 2), null, 'cannot set out now: nothing promised');
  assert.equal(readyAgain(120, 5, 5), null);
});
