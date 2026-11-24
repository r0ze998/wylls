// expansion-gameplay-1, the relay half (owner t491u 2026-11-24: nations should visibly spread across the map): REACH FROM THE NATION'S
// LAND. A wide claim (0xD9) may name a reach witness — a wide province of the claimer's nation (a village of it, or a
// keep it won) — and then reaches OUTPOST_RANGE provinces from there, not only from the first home (frontier-abi
// world_index/reach.rs, program proc/wide.rs). This file checks the page's and the relay's one builder, the nation's
// land read from captured province bytes, the page card's targets, and the operator AI's choice of where to expand.
// THIS FILE MAKES NO KEY: nothing is signed, sent or served; no chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import * as A from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { localActIntent, localActMessage } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import * as P from '../src/frontier/local-play-operator-policy.mjs';

const WALLET = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const HASH = '11111111111111111111111111111111';
// a rim first home (ring 128) and wide provinces along ring 129 (distance from the home = |q| + small)
const HOME = { p: 128, q: 0, site: 0 };
const NEAR = { p: '129', q: '0' };        // 1 from home
const FAR = { p: '129', q: '-8' };        // 8 from home
const LAND = { p: '129', q: '-6' };       // 6 from home, 2 from FAR
const refused = (f, code) => assert.throws(f, e => e.code === code, code);

/** A wide province's captured bytes (4,864): villages `[{site, faction}]` in the site mirror, a keep `{holder, changes}`. */
function bytesOf({ villages = [], keep = null, siteCount = 12 } = {}) {
  const b = new Uint8Array(4864);
  b[262] = siteCount;
  for (const v of villages) { const o = 296 + v.site * 64; b[o] = 1; b[o + 1] = v.faction; }
  if (keep) { b[4480] = 30; b[4481] = keep.holder; b[4486] = keep.changes & 0xff; b[4487] = keep.changes >> 8; } else b[4480] = 0xff;
  return b;
}
const b64 = b => Buffer.from(b).toString('base64');

test('the page and the relay build the same bytes for a claim through the nation\'s land', () => {
  const v = { holding: HOME, target: FAR, reach: LAND }, f = { site: 1, slot: 2 };
  const page = A.localActIntentOf('WideClaim', v, f, WALLET);
  assert.deepEqual(JSON.parse(JSON.stringify(page.subject.reach)), LAND);
  const relay = localActIntent(JSON.parse(JSON.stringify(page)), { wallet: WALLET });
  assert.deepEqual(JSON.parse(JSON.stringify(relay)), JSON.parse(JSON.stringify(page)));
  const identity = { address: WALLET, programId: LOCAL_PLAY_PROGRAM, seasonAddress: seasonAddresses(LOCAL_PLAY_PROGRAM, '11').season, cluster: 'localnet' };
  const pins = { program: LOCAL_PLAY_PROGRAM, season: identity.seasonAddress, seasonId: 11, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH };
  const a = A.localActMessage(page, identity, LOCAL_PLAY_RULESET_HASH, HASH);
  const b = localActMessage(relay, pins, HASH).message;
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  // a stated far target without its witness is refused by the relay
  assert.throws(() => localActIntent({ name: 'WideClaim', subject: { holding: HOME, target: FAR }, fields: f }, { wallet: WALLET }), e => e.code === 'LocalActInvalid');
});

test('the AI policy files the claim with its witness (and without one inside home range)', () => {
  const m = P.createResidentMemory(0);
  const v1 = { joined: true, faction: 1, holding: { p: 128, q: 0, site: 0, tile: 5 }, wide: 0 };
  const d = P.decideNext(m, v1, { homes: [], wide: { targets: [{ ...FAR, reach: LAND, free: [2] }], canClaim: true }, nowSecs: 1 });
  assert.equal(d.name, 'WideClaim');
  assert.deepEqual(JSON.parse(JSON.stringify(d.v)), { holding: { p: 128, q: 0, site: 0 }, target: FAR, reach: LAND });
  assert.match(d.why, /through the nation's land at 129,-6/);
  const intent = A.localActIntentOf('WideClaim', { holding: { p: 128, q: 0, site: 0 }, target: d.v.target, reach: d.v.reach }, d.fields, WALLET);
  assert.equal(intent.subject.reach.q, '-6');
  const d2 = P.decideNext(P.createResidentMemory(0), v1, { homes: [], wide: { targets: [{ ...NEAR, free: [0] }], canClaim: true }, nowSecs: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(d2.v)), { holding: { p: 128, q: 0, site: 0 }, target: NEAR });
});
