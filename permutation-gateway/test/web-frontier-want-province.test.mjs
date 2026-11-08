// workstream 16 (REPORT §29.33): controller.mjs wantProvince's interval for a Province whose read failed (workstream 7,
// 1fc0a5aa), by explicit clocks and a stub herald, and nothing else:
//   - the first read of a Province is never held back;
//   - after a failed read: not asked again at once, nor within WANT_REFRESH_MS (even at a new bell); asked again at the
//     interval's end (the boundary is `<`: at exactly WANT_REFRESH_MS it is asked);
//   - a read that succeeds after a failure is stored, and from then on the existing rule for a stored copy applies;
//   - a Province whose first read succeeds keeps the existing rule (same bell: never; a newer bell: only after the
//     interval).
// Static call-path review (§29.33): wantProvince -> loadEnvelope -> the stub herald's province(), latestEnvelope,
// protoLand (FS.proto is null), keepFromProvince (pure; FS.conquest is null); useHerald -> fwide.clearWide. No pin, no
// network, no key: the herald below is a function that answers with fixed objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CTRL from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';

const T = CTRL.WANT_REFRESH_MS;
let asked = 0, answer = () => ({ ok: false, code: 'NotFound' });
CTRL.useHerald({ province: async () => { asked++; return answer(); } });
FS.proto = null; FS.conquest = null;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };
const want = (p, now, bell) => CTRL.wantProvince(p, 0, () => {}, { now, bell });
const ok = bell => () => ({ ok: true, bell, seq: bell, province: { p: 0, q: 0 } });

test('the first read of a Province is never held back', async () => {
  asked = 0; answer = () => ({ ok: false, code: 'NotFound' });
  assert.equal(want(101, 0, 1), true);
  await settle();
  assert.equal(asked, 1);
});

test('after a failed read: not again at once nor within the interval (even at a new bell); again at its end', async () => {
  asked = 0; answer = () => ({ ok: false, code: 'NotFound' });
  assert.equal(want(102, 0, 1), true); await settle();
  assert.equal(FS.provinces.has('102,0'), false, 'the failed read stored nothing');
  assert.equal(want(102, 1000, 1), false, 'not again at once (the redraw after the failure)');
  assert.equal(want(102, T - 1, 2), false, 'not within the interval, even at a new bell');
  assert.equal(asked, 1);
  assert.equal(want(102, T, 2), true, 'at the interval\'s end it is asked again');
  await settle();
  assert.equal(asked, 2);
});

test('a read that succeeds after a failure is stored; then the existing rule for a stored copy applies', async () => {
  asked = 0; answer = () => ({ ok: false, code: 'Unavailable' });
  assert.equal(want(103, 0, 1), true); await settle();
  answer = ok(1);
  assert.equal(want(103, T, 1), true); await settle();
  assert.equal(FS.provinces.get('103,0')?.bell, 1, 'recovered');
  assert.equal(want(103, 3 * T, 1), false, 'same bell: never again');
  assert.equal(want(103, T + T - 1, 2), false, 'a newer bell, within the interval of the last read: not yet');
  answer = ok(2);
  assert.equal(want(103, 2 * T, 2), true, 'a newer bell after the interval: asked');
  await settle();
  assert.equal(FS.provinces.get('103,0')?.bell, 2);
  assert.equal(asked, 3);
});

test('a Province whose first read succeeds keeps the existing rule', async () => {
  asked = 0; answer = ok(5);
  assert.equal(want(104, 0, 5), true); await settle();
  assert.equal(want(104, 1000, 5), false, 'same bell');
  assert.equal(want(104, T - 1, 6), false, 'newer bell, within the interval');
  answer = ok(6);
  assert.equal(want(104, T, 6), true, 'newer bell, at the interval');
  await settle();
  assert.equal(asked, 2);
});
