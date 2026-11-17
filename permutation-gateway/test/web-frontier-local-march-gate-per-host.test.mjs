// Round 27 evidence, with the REAL modules: the march gate (flocalplay-march.mjs localMarchOpen) fed by the REAL sender's
// book of sent-but-unknown marches (createLocalMarchSender().held). controller.mjs localMarchFor(holding, hostId) passes
// exactly these two (`holding`, `held: localMarchSender.held(hostId)`), the bar asks it for the host it shows, and the send
// reads localMarchView = localMarchFor(composed village, composed host) — so the bar is open only where that host's own
// send would be. These cases show the per-host answer never opens what the gate closes: a host with a held march is
// closed, another host of the same village is open, the old page-wide question (no host) is closed for everyone, and a
// village outside the allowed rings is closed for any host. No key, no network, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../permutation-server/web/frontier/flocalplay-march.mjs';
import { ringPosition } from '../../permutation-server/web/frontier/map/wide.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', ORIGIN = 'http://localhost:41926', INST = 'ab'.repeat(32);
const cap = { wallet: WALLET, instance: INST, trial: true, relay: ORIGIN }, gate = { ok: true, relay: ORIGIN };
const HOME = { p: 2, q: 0, site: 11 };
function sender(entries) {
  const s = P.createLocalMarchSender({ allowed: () => gate, open: () => true, identity: () => null, rulesetHash: () => null, signer: () => null });
  s.storage.set(s.bookKey, JSON.stringify(entries));
  return s;
}
// what controller.mjs localMarchFor computes for (holding, hostId) — the same call, the same arguments
const gateFor = (s, holding, hostId) => P.localMarchOpen({ capability: cap, wallet: WALLET, instance: INST, gate, holding, held: s.held(hostId ?? null), trialEntry: true });

test('the real sender holds host A\'s sent march: A is closed (held), B of the same village is open, the page-wide question closes everyone', () => {
  const s = sender([{ host: '111', state: 'sent', signature: 'sigA' }, { host: '222', state: 'landed', signature: 'sigB' }]);
  assert.deepEqual(s.held('111'), ['sigA']); assert.deepEqual(s.held('222'), [], 'a landed march holds nothing');
  const a = gateFor(s, HOME, '111'), b = gateFor(s, HOME, '222'), all = gateFor(s, HOME, null);
  assert.deepEqual([a.open, a.reason], [false, 'LocalMarchHeld'], 'A: its own march is held');
  assert.deepEqual([b.open, b.reason], [true, 'open'], 'B: nothing of its own is held');
  assert.deepEqual([all.open, all.reason], [false, 'LocalMarchHeld'], 'no host (the old page-wide read with no composed order): held for everyone');
  // the id as the page holds it (a bigint host id) is the same host
  assert.equal(gateFor(s, HOME, 111n).reason, 'LocalMarchHeld'); assert.equal(gateFor(s, HOME, 222n).open, true);
  // nothing in A's book opens anything for A, however it is asked
  for (const id of ['111', 111n, ' 111'.trim()]) assert.equal(gateFor(s, HOME, id).open, false, String(id));
});

test('another village: one outside the allowed rings is closed for every host, held or not; a village inside is decided by the host alone', () => {
  const s = sender([{ host: '111', state: 'sent', signature: 'sigA' }]);
  const FAR = { p: 300, q: 0, site: 0 };
  assert.ok(ringPosition(BigInt(FAR.p), BigInt(FAR.q)).ring > 128n, 'the far village is outside the allowed rings');
  for (const id of ['111', '222', null]) {
    const r = gateFor(s, FAR, id);
    assert.equal(r.open, false, `far village, host ${id}`); assert.equal(r.reason, 'LocalMarchWideHolding');
  }
  const NEAR = { p: -2, q: 4, site: 3 };
  assert.ok(ringPosition(BigInt(NEAR.p), BigInt(NEAR.q)).ring <= 128n);
  assert.equal(gateFor(s, NEAR, '222').open, true); assert.equal(gateFor(s, NEAR, '111').open, false);
  // a missing village is closed (the bar then reads refused)
  assert.equal(gateFor(s, null, '222').open, false);
});

test('without the march trial or the capability, every host is closed — the per-host question never opens a closed gate', () => {
  const s = sender([]);
  const closedCap = P.localMarchOpen({ capability: null, wallet: WALLET, instance: INST, gate, holding: HOME, held: s.held('222'), trialEntry: true });
  const noTrial = P.localMarchOpen({ capability: cap, wallet: WALLET, instance: INST, gate, holding: HOME, held: s.held('222'), trialEntry: false });
  const noGate = P.localMarchOpen({ capability: cap, wallet: WALLET, instance: INST, gate: { ok: false }, holding: HOME, held: s.held('222'), trialEntry: true });
  for (const r of [closedCap, noTrial, noGate]) assert.equal(r.open, false, r.reason);
});

test('the controller passes exactly these: the host\'s own village and its own held marches; the send reads the composed order through the same function', () => {
  const c = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const fn = c.slice(c.indexOf('function localMarchFor(h, hostId)'), c.indexOf('function localMarchFor(h, hostId)') + 600);
  assert.match(fn, /holding: h \? \{ p: h\.p, q: h\.q, site: h\.site \} : null, held: localMarchSender \? localMarchSender\.held\(hostId \?\? null\) : \[\], trialEntry: localPlay\.march\?\.trialEntry === true \}\);/);
  assert.doesNotMatch(fn, /ready:/, 'the page never passes its own readiness');
  assert.match(c, /return localMarchFor\(h, FS\.compose\?\.host\?\.id \?\? null\);/);
  assert.match(c, /if \(localPlay && FS\.localMarch\?\.open !== true\) return failed\(localPlayReadOnly\(\)\);/, 'the send still reads the composed order\'s answer');
});
