// rent-live-rest: the page's rent deposit preview follows the CLUSTER's rent (5,080 and 6,960 lamports per byte), asked
// through its own gateway route (devnet play: the gateway's RPC; local play: the runner), cached, and labelled a MODEL
// when no cluster answered. KEY-FREE: no wallet, no key, no signature; the RPC is a stand-in (no process, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../client/src/base58.mjs';
import { rent, rentAt, rateOfMinimum, RENT_PER_BYTE } from '../client/src/frontier/fees.mjs';
import * as webFees from '../../permutation-server/web/sdk/frontier/fees.mjs';
import { RENT_CONTEXT_SCHEMA, RENT_HOLDING_BYTES, RENT_FRESH_MS, RENT_RETRY_MS, MODEL_RENT, clusterRentAnswer, rentOfAnswer, rentNow, holdingRentNow,
  rentSource, rentDue, rentFailed } from '../../permutation-server/web/frontier/frent.mjs';
import { landState, escrowNeededAt } from '../../permutation-server/web/frontier/fland.mjs';
import { OUTPOST_HOLDING_BYTES, outpostCost } from '../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { createDevnetPlayAct } from '../src/frontier/devnet-play-act.mjs';
import { createLocalPlayAct, LocalActError } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';

const RATES = [5_080, 6_960];
/** The cluster's own getMinimumBalanceForRentExemption at `rate` (SIMD-0194 form: (128 + n) × rate). */
const minimum = rate => n => (128 + n) * rate;
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), WALLET = encode(new Uint8Array(32).fill(0x33));

test('fees: rentAt is the cluster formula; rent is the labelled 5,080 model; the rate a minimum states', () => {
  assert.equal(RENT_PER_BYTE, 5_080n);
  assert.equal(rent(1280), 7_152_640n);
  assert.equal(rentAt(1280, 5_080), rent(1280));
  assert.equal(rentAt(1280, 6_960), 9_799_680n);
  assert.equal(rentAt(0, 6_960), 890_880n);
  for (const rate of RATES) assert.equal(rateOfMinimum(minimum(rate)(1280), 1280), BigInt(rate));
  // (the pre-SIMD-0194 sysvar 3,480 × threshold 2.0 states 6,960 per byte; a minimum that is no whole multiple is no rate)
  assert.equal(rateOfMinimum((128 + 1280) * 3_480 * 2, 1280), 6_960n);
  assert.equal(rateOfMinimum(1408 * 5080 + 1, 1280), null);
  assert.equal(rateOfMinimum(0, 1280), null);
  // the web copy is the client source (sync-web-sdk)
  assert.equal(webFees.rentAt(1280, 6960), 9_799_680n);
  assert.equal(webFees.rateOfMinimum(9_799_680, 1280), 6_960n);
});

test('frent: a cluster answer is checked strictly; anything else is no answer', () => {
  assert.equal(RENT_HOLDING_BYTES, OUTPOST_HOLDING_BYTES);
  for (const rate of RATES) {
    const r = rentOfAnswer({ schema: RENT_CONTEXT_SCHEMA, holding_bytes: 1280, holding_rent: String(minimum(rate)(1280)), lamports_per_byte: String(rate) }, 1000);
    assert.deepEqual([r.source, r.perByte, r.holdingRent, r.at, r.error], ['cluster', BigInt(rate), BigInt(minimum(rate)(1280)), 1000, null]);
  }
  const ok = { schema: RENT_CONTEXT_SCHEMA, holding_bytes: 1280, holding_rent: '9799680', lamports_per_byte: '6960' };
  for (const bad of [null, 'x', {}, { ...ok, schema: 'x' }, { ...ok, holding_bytes: 1024 }, { ...ok, holding_rent: 9799680 }, { ...ok, holding_rent: '-1' },
    { ...ok, holding_rent: '0' }, { ...ok, holding_rent: '01' }, { ...ok, lamports_per_byte: '5080' }, { ...ok, lamports_per_byte: 6960 },
    { ...ok, lamports_per_byte: null } /* a whole multiple must state its rate */, { ...ok, holding_rent: '18446744073709551616', lamports_per_byte: null }])
    assert.equal(rentOfAnswer(bad), null, JSON.stringify(bad));
  // a minimum that is no whole multiple of 1,408 (not a threshold-1/2 cluster): the holding figure stands, no rate is claimed
  const odd = rentOfAnswer({ ...ok, holding_rent: '9799681', lamports_per_byte: null });
  assert.deepEqual([odd.source, odd.perByte, odd.holdingRent], ['cluster', null, 9_799_681n]);
});

test('frent: the model until a cluster answers, labelled; cached; asked again on schedule', () => {
  assert.deepEqual([rentSource(undefined), holdingRentNow(undefined), rentNow(null).perByte], ['model', 7_152_640n, 5_080n]);
  assert.equal(MODEL_RENT.source, 'model');
  assert.equal(rentDue(undefined, 0), true);
  const failed = rentFailed(undefined, 'LocalActNoAnswer', 10_000);
  assert.deepEqual([failed.source, failed.error, failed.holdingRent, failed.askedAt], ['model', 'LocalActNoAnswer', 7_152_640n, 10_000]);
  assert.equal(rentDue(failed, 10_000 + RENT_RETRY_MS - 1), false);
  assert.equal(rentDue(failed, 10_000 + RENT_RETRY_MS), true);
  const c = rentOfAnswer({ schema: RENT_CONTEXT_SCHEMA, holding_bytes: 1280, holding_rent: '9799680', lamports_per_byte: '6960' }, 50_000);
  assert.deepEqual([rentSource(c), holdingRentNow(c)], ['cluster', 9_799_680n]);
  assert.equal(rentDue(c, 50_000 + RENT_FRESH_MS - 1), false);
  assert.equal(rentDue(c, 50_000 + RENT_FRESH_MS), true);
  // a failed re-ask keeps the cluster's earlier answer (the rate moves only by a feature gate) and retries sooner
  const kept = rentFailed(c, 'LocalActRpcUnavailable', 50_000 + RENT_FRESH_MS);
  assert.deepEqual([kept.source, kept.holdingRent, kept.at, kept.error], ['cluster', 9_799_680n, 50_000, 'LocalActRpcUnavailable']);
  assert.equal(rentDue(kept, 50_000 + RENT_FRESH_MS + RENT_RETRY_MS), true);
});

test('escrow preview: the program\'s escrow_need at the cluster\'s rent, minus what the Citizen holds', () => {
  const c = (escrow = 0n) => ({ escrow });
  for (const rate of RATES) {
    const h = BigInt(minimum(rate)(1280));
    assert.equal(escrowNeededAt(landState(null), h), h);
    assert.equal(escrowNeededAt(c(1_000n), h), h - 1_000n);
    assert.equal(escrowNeededAt(c(h), h), 0n);
    assert.equal(escrowNeededAt(c(h + 5n), h), 0n);
    // with capture reservations (Citizen slots bits 2 and 3) one more rent each: as the outpost preview counts them
    assert.equal(escrowNeededAt(c(0n), h, 0x04), 2n * h);
    assert.equal(escrowNeededAt(c(0n), h, 0x0c), 3n * h);
    assert.equal(escrowNeededAt(c(0n), h, 0x0c), outpostCost({ holdingRent: h, escrow: 0n, slots: 0x0c }).deposit);
  }
  // landState's own field stays the 5,080 model (what the page shows is escrowNeededAt at the cluster's rent)
  assert.equal(landState(null).escrowNeeded, 7_152_640n);
});

const devnetCfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: '1', devnetPlay: true, devnetPlayRulesetHash: '07'.repeat(32) };

test('devnet play gateway: the rent context is ONE getMinimumBalanceForRentExemption, at either rate', async () => {
  for (const rate of RATES) {
    const calls = [];
    const flow = createDevnetPlayAct({ cfg: devnetCfg, rpc: async (m, p) => { calls.push([m, p]); return m === 'getMinimumBalanceForRentExemption' ? { result: minimum(rate)(p[0]) } : { error: { code: -1 } }; } });
    const v = await flow.context({ schema: RENT_CONTEXT_SCHEMA });
    assert.deepEqual(v, { schema: RENT_CONTEXT_SCHEMA, holding_bytes: 1280, holding_rent: String(minimum(rate)(1280)), lamports_per_byte: String(rate) });
    assert.deepEqual(calls, [['getMinimumBalanceForRentExemption', [1280, { commitment: 'confirmed' }]]]);
    // the page's side of the same answer: its preview is the lamports the program moves for one Holding at this rate
    assert.equal(escrowNeededAt(landState(null), holdingRentNow(rentOfAnswer(v))), BigInt(minimum(rate)(1280)));
  }
});

test('devnet play gateway: an RPC error or a bad answer is unavailable, never a constant; extra keys are refused', async () => {
  const refuses = async (rpc, body, code) => {
    const flow = createDevnetPlayAct({ cfg: devnetCfg, rpc });
    await assert.rejects(flow.context(body), e => e instanceof LocalActError && e.code === code, code);
  };
  const body = { schema: RENT_CONTEXT_SCHEMA };
  await refuses(async () => { throw new Error('down'); }, body, 'LocalActRpcUnavailable');
  await refuses(async () => ({ error: { code: -32000 } }), body, 'LocalActRpcUnavailable');
  for (const result of [null, '7152640', -1, 0, 1.5, 2 ** 60]) await refuses(async () => ({ result }), body, 'LocalActRpcUnavailable');
  await refuses(async () => ({ result: 7_152_640 }), { schema: RENT_CONTEXT_SCHEMA, wallet: WALLET }, 'LocalActInvalid');
});

test('local play gateway: the same rent context, read from the runner', async () => {
  const season = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0];
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
  for (const rate of RATES) {
    const calls = [];
    const act = createLocalPlayAct({ cfg, rpc: async (m, p) => { calls.push(m); return m === 'getMinimumBalanceForRentExemption' ? { result: minimum(rate)(p[0]) } : { error: { code: -1 } }; } });
    const v = await act.context({ schema: RENT_CONTEXT_SCHEMA });
    assert.equal(v.holding_rent, String(minimum(rate)(1280)));
    assert.equal(v.lamports_per_byte, String(rate));
    assert.deepEqual(calls, ['getMinimumBalanceForRentExemption']);
  }
  const act = createLocalPlayAct({ cfg, rpc: async () => ({ error: { code: -1 } }) });
  await assert.rejects(act.context({ schema: RENT_CONTEXT_SCHEMA }), e => e.code === 'LocalActRpcUnavailable');
});

test('clusterRentAnswer: the answer shape the page checks', async () => {
  const v = await clusterRentAnswer(async () => ({ result: 9_799_680 }), () => { throw new Error('bad'); });
  assert.notEqual(rentOfAnswer(v), null);
  await assert.rejects(clusterRentAnswer(async () => ({ result: 'x' }), () => { throw new Error('bad'); }), /bad/);
});
