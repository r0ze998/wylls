// Workstream 03: which transaction shapes the sponsor relay accepts, the
// direct SendCaravan against the courier's two shapes.
//
// Execution: [SIMULATED: the relay's own classifier, no chain]. It runs the
// relay's shape allowlist (permutation-gateway/client/src/frontier/shapes.mjs
// `classify`, the first check POST /f/relay makes, before any signature,
// quota, simulation or drain guard) on wire transactions built here. It
// does not start the relay and sends nothing. The relay's checks are not
// disabled or patched.
//
//   node --test workstreams/03-composability/relay-check/relay-shape.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encode as base58 } from '../../../permutation-gateway/client/src/base58.mjs';
import { budgetPrefix, budgetOf } from '../../../permutation-gateway/client/src/frontier/budgets.mjs';
import { classify, frontierIx, shapeMessage } from '../../../permutation-gateway/client/src/frontier/shapes.mjs';
import { compileMessage, wireTransaction, parseTransaction } from '../../../permutation-gateway/client/src/solana-tx.mjs';

const key = label => base58(createHash('sha256').update(`ws03:${label}`).digest());
const PROGRAM = key('frontier program');
const COURIER = key('courier program');
const RELAY = key('relay fee payer');
const BLOCKHASH = key('blockhash');
const PROFILE = 3; // an S1 season

const accounts = {
  actor: key('session key'),
  season: key('season'),
  citizen: key('citizen'),
  src: key('holding'),
  dst: key('vault'),
  caravan: key('caravan'),
  path_province: [key('province')],
};
const fields = {
  seq: 0, dst_kind: 2, dst_p: 3, dst_q: -1, dst_at: 20, dst_gen: 1, steps: 4,
  path: new Uint8Array(12), cargo: new Uint8Array(32), fee: 50000n,
};

const classifyWire = message => {
  const wire = wireTransaction(message);
  return classify(parseTransaction(wire), { programId: PROGRAM, wireBytes: wire.length, profile: PROFILE });
};

/** The courier's op 0 around a Frontier instruction (courier/src/lib.rs). */
const sendSigned = ix => ({
  programId: COURIER,
  keys: [{ pubkey: ix.programId, isSigner: false, isWritable: false }, ...ix.keys],
  data: Uint8Array.from([0, 1, ...ix.data]),
});

/** The courier's op 2: the session and purse PDAs replace actor and payer. */
const sendDelegated = (ix, cranker) => ({
  programId: COURIER,
  keys: [
    { pubkey: ix.programId, isSigner: false, isWritable: false },
    { pubkey: cranker, isSigner: true, isWritable: false },
    { pubkey: key('mandate'), isSigner: false, isWritable: true },
    { pubkey: key('session pda'), isSigner: false, isWritable: false },
    { pubkey: key('purse pda'), isSigner: false, isWritable: true },
    ...ix.keys.slice(2),
  ],
  data: Uint8Array.from([2, 1, ...ix.data]),
});

test('[SIMULATED] SendCaravan is a sponsored player shape; the direct call passes the relay\'s allowlist', () => {
  const message = shapeMessage({ programId: PROGRAM, name: 'SendCaravan', accounts, fields, feePayer: RELAY, recentBlockhash: BLOCKHASH, profile: PROFILE });
  const r = classifyWire(message);
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.name, 'SendCaravan');
  assert.equal(r.kind, 'player');
  assert.equal(r.authority, accounts.actor);
});

test('[SIMULATED] the courier\'s owner-signed shape is refused: the fourth instruction is not the Frontier program\'s', () => {
  const inner = frontierIx(PROGRAM, 'SendCaravan', { ...accounts, payer: RELAY }, fields, PROFILE);
  const message = compileMessage({ feePayer: RELAY, recentBlockhash: BLOCKHASH, instructions: [...budgetPrefix('SendCaravan', { profile: PROFILE }), sendSigned(inner)] });
  const r = classifyWire(message);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RelayRejected');
  assert.match(r.problem, /fourth instruction must be the Frontier program/);
});

test('[SIMULATED] the courier\'s delegated shape is refused for the same reason; its payer is not the relay either', () => {
  const inner = frontierIx(PROGRAM, 'SendCaravan', { ...accounts, actor: key('session pda'), payer: key('purse pda') }, fields, PROFILE);
  const message = compileMessage({ feePayer: RELAY, recentBlockhash: BLOCKHASH, instructions: [...budgetPrefix('SendCaravan', { profile: PROFILE }), sendDelegated(inner, RELAY)] });
  const r = classifyWire(message);
  assert.equal(r.ok, false);
  assert.match(r.problem, /fourth instruction must be the Frontier program/);
});

test('[SIMULATED] the relay\'s budget for SendCaravan, against the local measurements of the courier paths', () => {
  const b = budgetOf('SendCaravan', PROFILE);
  // The relay requires exactly these values (classify: SetComputeUnitLimit
  // must be cuLimit, SetLoadedAccountsDataSizeLimit must be L(kind)).
  console.log(`[relay] SendCaravan cuLimit ${b.cuLimit}, loadedLimit ${b.loadedLimit}, txCeiling ${b.txCeiling}`);
  assert.equal(b.cuLimit, 140000);
  // A courier transaction under the Frontier kind's own prefix is still not
  // a sponsored shape: what is refused is the program, not the budget.
  const inner = frontierIx(PROGRAM, 'SendCaravan', { ...accounts, payer: RELAY }, fields, PROFILE);
  const message = compileMessage({ feePayer: RELAY, recentBlockhash: BLOCKHASH, instructions: [...budgetPrefix('SendCaravan', { profile: PROFILE, loadedLimit: b.loadedLimit }), sendSigned(inner)] });
  assert.equal(classifyWire(message).ok, false);
});
