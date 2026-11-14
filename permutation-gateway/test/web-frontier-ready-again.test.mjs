// Round 33: the march card's "Ready again from turn N" is the program's own stamina clock (permutation-rules host.rs
// Stamina, frontier-abi clash_model.rs arrival_stamina; fmarch.mjs staminaAt mirrors the lazy +1 a turn): a Depart in
// turn b with stamina s leaves s − 74 stored at b; the arrival brings it refilled from b + 1, stored at the arrival
// turn; a fight on arrival without the damage-ratio refund costs 20 more. The card said b + 148 − s. Vector from a ×10
// world (live31, the host's entry decoded from that world's records): departed in turn 6 with 120, arrived at a defended
// keep on turn 10 and fought: 29 stored at turn 10 — the card had promised turn 34. Pure; no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlook } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { staminaAt, DEPART_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const firstTurn = (entry, from) => { for (let t = from; t < from + 400; t++) if (staminaAt(entry, t) >= DEPART_STAMINA) return t; return null; };

test('the vector of the recorded world: ready from 35, or from 55 after a fight on arrival — both on the program\'s own clock', () => {
  setLang('ja');
  const out = text(outlook({ w: { value: 10 }, stam: 120, nowB: 6, def: { total: 100 }, odds: null, fc: null, sight: 3 }));
  assert.match(out, /次はターン 35 から（到着で戦えばターン 55 から）/);
  // the recorded entry after the fight: 29 stored at turn 10 (and 30 at 11, the same clock) — 74 again at turn 55
  assert.equal(firstTurn({ staminaValue: 29, staminaBell: 10 }, 10), 55);
  assert.equal(staminaAt({ staminaValue: 30, staminaBell: 11 }, 33), 52, 'the host panel\'s 52/120 at turn 33');
  // without a fight: 46 stored at 6, refilled from 7 → 49 stored at the arrival turn 10 — 74 again at turn 35
  const arrival = staminaAt({ staminaValue: 120 - DEPART_STAMINA, staminaBell: 6 + 1 }, 10);
  assert.equal(arrival, 49);
  assert.equal(firstTurn({ staminaValue: arrival, staminaBell: 10 }, 10), 35);
});

test('no defenders recorded: one turn only; none known (out of sight): both turns; English', () => {
  setLang('ja');
  assert.match(text(outlook({ w: { value: 10 }, stam: 120, nowB: 6, def: { total: 0 }, sight: 3 })), /次はターン 35 から(?!（)/);
  assert.doesNotMatch(text(outlook({ w: { value: 10 }, stam: 120, nowB: 6, def: { total: 0 }, sight: 3 })), /戦えば/);
  assert.match(text(outlook({ w: { value: 10 }, stam: 100, nowB: 6, def: null, sight: 1 })), /次はターン 55 から（到着で戦えばターン 75 から）/);
  setLang('en');
  assert.match(text(outlook({ w: { value: 10 }, stam: 120, nowB: 6, def: { total: 100 }, sight: 3 })), /Ready again from turn 35 \(turn 55 if it fights on arrival\)/);
  setLang('ja');
});
