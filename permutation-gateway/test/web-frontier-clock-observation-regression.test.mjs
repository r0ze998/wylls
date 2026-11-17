// Regression: an invalid herald sample must not poison the chain clock
// (permutation-server/web/frontier/clock.mjs, ChainClock.observe).
//
// Before the fix, observe(undefined, slot) stored {unix: NaN}; now() then
// returned NaN, the NaN floor held forever (Math.max(NaN, x) is NaN), and the
// bell chip showed NaN bell / secondsLeft even after a later valid sample.
// An invalid unix or slot (missing, null, non-numeric, non-finite, or an
// object that would only coerce to a number) is now ignored whole: it changes
// no clock state and does not throw. Valid numbers, numeric strings
// (including '0') and BigInts keep their earlier meaning.
//
// Pure: a fixed injected wall clock, only the clock module's own methods; no
// I/O, timers, network or decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainClock, bellChip } from '../../permutation-server/web/frontier/clock.mjs';

/** Every field observe could touch, copied. */
const snap = c => ({
  last: c.last && { ...c.last },
  prev: c.prev && { ...c.prev },
  rate: c.rate,
  declared: c.declared,
  floor: c.floor,
  minOffset: c.minOffset,
  advancedAt: c.advancedAt,
  accelerated: c.accelerated,
});

const INVALID = [
  ['undefined', undefined],
  ['null', null],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['empty string', ''],
  ['blank string', '   '],
  ['non-numeric string', 'abc'],
  ['partly numeric string', '12abc'],
  ["string 'NaN'", 'NaN'],
  ["string 'Infinity'", 'Infinity'],
  ["string '-Infinity'", '-Infinity'],
  ['string overflowing to Infinity', '1e400'],
  ['true', true],
  ['false', false],
  ['empty object', {}],
  ['empty array', []],
  ['one-element array', [5]],
  ['object with valueOf', { valueOf: () => 5 }],
  ['object with toString', { toString: () => '5' }],
  ['object whose valueOf throws', { valueOf() { throw new Error('coerced'); } }],
  ['Number wrapper object', Object(5)],
  ['String wrapper object', Object('5')],
  ['Date', new Date(5000)],
  ['function', () => 5],
  ['symbol', Symbol('5')],
  ['BigInt beyond a double', 10n ** 400n],
];

/** Feed every invalid value as unix, as slot, and as both; assert no throw and no state change. */
function rejectsAll(c, goodUnix, goodSlot) {
  const before = snap(c);
  for (const [label, bad] of INVALID) {
    for (const [what, u, s] of [['unix', bad, goodSlot], ['slot', goodUnix, bad], ['both', bad, bad]]) {
      assert.doesNotThrow(() => c.observe(u, s), `${what} = ${label} must not throw`);
      assert.deepEqual(snap(c), before, `${what} = ${label} must not change the clock`);
    }
  }
}

const CHIP_CLOCK = { genesisTs: 400, endBell: 100, continuous: false };

test('the reported reproduction: a missing unix between two good samples no longer leaves now() NaN', () => {
  const W = 1_000_000;
  const c = new ChainClock({ wall: () => W });
  c.observe(1000, 1);
  assert.equal(c.now(), 1000);
  c.observe(undefined, 2);
  assert.equal(c.now(), 1000, 'the bad sample is ignored');
  assert.equal(c.last.slot, 1);
  c.observe(1001, 3);
  assert.equal(c.now(), 1001, 'the next good sample is taken');
  const chip = bellChip(CHIP_CLOCK, c.now());
  assert.deepEqual(chip, { bell: 1, secondsLeft: 599, beforeGenesis: false, ended: false });
  assert.ok(Number.isFinite(chip.bell) && Number.isFinite(chip.secondsLeft));
});

test('a cold clock: invalid samples leave it unsampled; a valid one then starts it', () => {
  const W = 1_000_000;
  const c = new ChainClock({ wall: () => W });
  const fresh = snap(c);
  rejectsAll(c, 1000, 1);
  assert.deepEqual(snap(c), fresh);
  assert.equal(c.now(), null);
  assert.equal(c.age(), null);
  assert.equal(c.behind(), null);
  assert.equal(c.offset(), 0);
  c.observe(1000, 1);
  assert.equal(c.now(), 1000);
  assert.deepEqual(c.last, { unix: 1000, slot: 1, at: W });
  assert.equal(c.prev, null);
});

test('a warm clock: invalid samples change nothing; extrapolation and recovery continue', () => {
  let wall = 1_000_000;
  const c = new ChainClock({ wall: () => wall });
  c.observe(1000, 5);
  wall += 1500;
  assert.equal(c.now(), 1001.5);
  rejectsAll(c, 1002, 6);
  assert.equal(c.now(), 1001.5, 'still extrapolating the last good sample');
  assert.equal(c.age(), 1.5);
  c.observe(1003, 6);
  assert.equal(c.now(), 1003);
  assert.equal(c.last.slot, 6);
  assert.equal(c.prev.slot, 5, 'prev is the last good sample, not a bad one');
  assert.equal(c.age(), 0);
  assert.equal(c.minOffset, -1.5);
});

test('older slots are still ignored, and an invalid slot cannot defeat that check', () => {
  const W = 1_000_000;
  const c = new ChainClock({ wall: () => W });
  c.observe(1000, 10);
  const before = snap(c);
  c.observe(900, 3);
  assert.deepEqual(snap(c), before, 'an older answer arriving late (unchanged behaviour)');
  c.observe(900, undefined);
  c.observe(900, null);
  c.observe(900, NaN);
  c.observe(undefined, 3);
  assert.deepEqual(snap(c), before);
  c.observe(800, 4);
  assert.deepEqual(snap(c), before, 'the slot was not poisoned: older slots are still refused');
  c.observe(1005, 11);
  assert.equal(c.last.slot, 11);
  assert.equal(c.now(), 1005);
});

test('zero and numeric strings (and BigInts) are still valid samples', () => {
  const W = 1_000_000;
  const z = new ChainClock({ wall: () => W });
  z.observe(0, 0);
  assert.deepEqual(z.last, { unix: 0, slot: 0, at: W });
  assert.equal(z.now(), 0);

  const c = new ChainClock({ wall: () => W });
  c.observe('0', '0');
  assert.deepEqual(c.last, { unix: 0, slot: 0, at: W });
  assert.equal(c.now(), 0);
  const before = snap(c);
  c.observe('', '1');
  c.observe('0', '');
  assert.deepEqual(snap(c), before, 'blank strings are not zero');
  c.observe(' 1000 ', '7');
  assert.deepEqual(c.last, { unix: 1000, slot: 7, at: W });
  assert.equal(c.now(), 1000);
  c.observe(1001n, 8n);
  assert.deepEqual(c.last, { unix: 1001, slot: 8, at: W });
  assert.equal(c.now(), 1001);
});

test('an accelerated clock: invalid samples neither estimate a rate nor disturb the next estimate', () => {
  let wall = 1_000_000;
  const c = new ChainClock({ wall: () => wall, accelerated: true });
  c.observe(5000, 1);
  wall += 2000;
  rejectsAll(c, 5040, 2);
  assert.equal(c.rate, 1);
  c.observe(5040, 2); // 40 chain seconds in 2 wall seconds against the last good sample: 20×
  assert.equal(c.rate, 20);
  wall += 1000;
  assert.equal(c.now(), 5060);
  assert.equal(c.behind(), 1);
  rejectsAll(c, 5100, 3);
  assert.equal(c.rate, 20);
  assert.equal(c.now(), 5060);
  assert.equal(c.behind(), 1);
});

/** A fixed wall that counts its calls. */
function countedWall(start) {
  const w = { ms: start, calls: 0 };
  w.fn = () => { w.calls++; return w.ms; };
  return w;
}

test('an invalid sample never reads the injected wall; a valid one reads it once', () => {
  for (const warm of [false, true]) {
    const w = countedWall(1_000_000);
    const c = new ChainClock({ wall: w.fn });
    if (warm) c.observe(1000, 1);
    const calls = w.calls;
    rejectsAll(c, 1001, 2);
    assert.equal(w.calls, calls, `${warm ? 'warm' : 'cold'}: no wall read for any invalid sample`);
    c.observe(1001, 2);
    assert.equal(w.calls, calls + 1, 'a valid sample reads the wall once');
  }
});

test('hostile objects are never coerced or inspected', () => {
  let touched = 0;
  const boom = () => { touched++; throw new Error('coerced'); };
  const prim = { valueOf: boom, toString: boom, [Symbol.toPrimitive]: boom };
  // Any trap lookup at all (get, has, getPrototypeOf, ownKeys, …) counts and throws.
  const handler = new Proxy({}, { get() { touched++; return () => { throw new Error('trapped'); }; } });
  const proxy = new Proxy({}, handler);
  const proxyFn = new Proxy(function () {}, handler);
  const getter = Object.defineProperty({}, 'valueOf', { get: boom });
  const hostile = [prim, proxy, proxyFn, getter];
  const w = countedWall(1_000_000);
  for (const warm of [false, true]) {
    const c = new ChainClock({ wall: w.fn });
    if (warm) c.observe(1000, 1);
    const before = snap(c), calls = w.calls;
    for (const h of hostile) {
      for (const [u, s] of [[h, 2], [1001, h], [h, h]]) {
        assert.doesNotThrow(() => c.observe(u, s));
        assert.deepEqual(snap(c), before);
      }
    }
    assert.equal(w.calls, calls);
  }
  assert.equal(touched, 0, 'no valueOf / toString / toPrimitive / proxy trap ran');
});

test('a declared accelerated clock (rate 0): invalid samples change nothing, then a valid sample is taken', () => {
  const w = countedWall(1_000_000);
  const c = new ChainClock({ wall: w.fn, accelerated: true });
  assert.equal(c.declare(0), true);
  let calls = w.calls;
  rejectsAll(c, 5000, 1); // cold
  assert.equal(w.calls, calls);
  assert.equal(c.last, null);
  assert.equal(c.declared, 0);
  assert.equal(c.rate, 0);
  c.observe(5000, 1);
  w.ms += 2000;
  calls = w.calls;
  rejectsAll(c, 5040, 2); // warm
  assert.equal(w.calls, calls);
  assert.equal(c.declared, 0);
  assert.equal(c.rate, 0);
  assert.deepEqual(c.last, { unix: 5000, slot: 1, at: 1_000_000 });
  assert.equal(c.minOffset, 1000 - 5000);
  assert.equal(c.behind(), 0, 'a world that stands still is not behind');
  assert.equal(c.offset(), 0);
  assert.equal(c.now(), 5000, 'rate 0: the chain time stands');
  c.observe(5040, 2);
  assert.equal(c.declared, 0, 'the declared rate is kept; no estimate');
  assert.equal(c.rate, 0);
  assert.deepEqual(c.last, { unix: 5040, slot: 2, at: 1_002_000 });
  assert.equal(c.prev.slot, 1);
  assert.equal(c.now(), 5040);
  assert.equal(c.behind(), 0);
});

test('a declared accelerated clock (rate 20): invalid samples change nothing, then a valid sample is taken', () => {
  const w = countedWall(1_000_000);
  const c = new ChainClock({ wall: w.fn, accelerated: true });
  assert.equal(c.declare(20), true);
  let calls = w.calls;
  rejectsAll(c, 5000, 1); // cold
  assert.equal(w.calls, calls);
  assert.equal(c.last, null);
  assert.equal(c.declared, 20);
  assert.equal(c.rate, 20);
  c.observe(5000, 1);
  w.ms += 1000;
  calls = w.calls;
  rejectsAll(c, 5100, 2); // warm
  assert.equal(w.calls, calls);
  assert.equal(c.declared, 20);
  assert.equal(c.rate, 20);
  assert.deepEqual(c.last, { unix: 5000, slot: 1, at: 1_000_000 });
  assert.equal(c.minOffset, 1000 - 5000);
  assert.equal(c.advancedAt, 1_000_000);
  assert.equal(c.behind(), 1);
  assert.equal(c.offset(), 0, 'no offset off rate 1');
  assert.equal(c.now(), 5020);
  w.ms += 2000; // 3 s after the first sample, 100 chain seconds later: no estimate replaces the declared rate
  c.observe(5100, 2);
  assert.equal(c.declared, 20);
  assert.equal(c.rate, 20);
  assert.deepEqual(c.last, { unix: 5100, slot: 2, at: 1_003_000 });
  assert.equal(c.advancedAt, 1_003_000);
  assert.equal(c.now(), 5100);
  w.ms += 1000;
  assert.equal(c.now(), 5120);
  assert.equal(c.behind(), 1);
});

test('a real cluster on a fixed wall: offset and behind stay finite after invalid samples', () => {
  const W = 2_000_000_000;
  const c = new ChainClock({ wall: () => W });
  c.observe(W / 1000 - 3, 1);
  assert.equal(c.offset(), 3);
  assert.equal(c.behind(), 0);
  rejectsAll(c, W / 1000 - 3, 2);
  assert.equal(c.minOffset, 3);
  assert.equal(c.offset(), 3);
  assert.equal(c.behind(), 0);
  assert.equal(c.rate, 1);
  c.observe(W / 1000 - 3, 2);
  assert.equal(c.last.slot, 2);
  assert.equal(c.offset(), 3);
  assert.equal(c.behind(), 0);
});
