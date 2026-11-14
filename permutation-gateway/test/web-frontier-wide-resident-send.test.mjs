// The page's side of 0xDD WideResidentAct (fplay.buildWideResidentShape) against the relay's own code: the message
// the page would send is parsed and classified by shapes.mjs `classify` (refused without a lane that serves the band;
// with one, the proof reaches the shape) and its proof goes through the relay's holder gate (`residentRefusal`): the
// current holder at the signed generation passes, a previous holder or a pre-transfer generation is refused. Behaviour,
// not source text: the bytes built by the page are the bytes the relay reads. No chain, no program run (no deployed
// program has the band; the lane candidate is not built).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWideResidentShape } from '../../permutation-server/web/frontier/fplay.mjs';
import { classify } from '../client/src/frontier/shapes.mjs';
import { parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { residentRefusal } from '../src/frontier/routes/relay.mjs';

const K = n => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let x = 0n; for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(n); let s = ''; while (x > 0n) { s = A[Number(x % 58n)] + s; x /= 58n; } return s; };
const PROGRAM = K(0x4c), OWNER = K(1), RELAY = K(2), HOLDING = K(3), CITIZEN = 'NFT-CITIZEN';
const proof = { policy: K(10), link: K(11), asset: K(12), resident: K(13) };
const inner = { programId: PROGRAM, keys: [{ pubkey: OWNER, isSigner: true, isWritable: false }, { pubkey: HOLDING, isSigner: false, isWritable: true }], data: Uint8Array.of(0xda, 0xff, 0x02, 0x04, 7, 7) };
const lane = { classifyInner: (tx, { programId }) => ({ ok: true, kind: 'player', authority: tx.instructions[3].keys.find(k => k.isSigner)?.pubkey, programId }) };
const sent = (generation = 1) => parseTransaction(wireTransaction(buildWideResidentShape({ inner, resident: { generation, proof }, feePayer: RELAY, blockhash: K(99), budget: { cuLimit: 400000, loadedLimit: 1 << 20 } }).message));

test('the page builds 0xDD with the proof and the lane\'s budget; the owner signs, the relay pays', () => {
  const s = buildWideResidentShape({ inner, resident: { generation: 1, proof }, feePayer: RELAY, blockhash: K(99), budget: { cuLimit: 400000, loadedLimit: 1 << 20 } });
  assert.deepEqual([...s.expected.data.slice(0, 5)], [0xdd, 1, 0, 0, 0]);
  assert.deepEqual(s.signers, [OWNER]);
  assert.throws(() => buildWideResidentShape({ inner, resident: { generation: 1, proof }, feePayer: RELAY, blockhash: K(99) }), /the lane gives the budget/);
  assert.throws(() => buildWideResidentShape({ inner: { ...inner, data: Uint8Array.of(0x00, 1) }, resident: { generation: 1, proof }, feePayer: RELAY, blockhash: K(99), budget: { cuLimit: 1, loadedLimit: 1 } }), /not run inside WideResidentAct/, 'a v2 player instruction goes through 0xE2, never 0xDD');
});

test('the relay: refused on every lane that does not serve the band; served, the proof reaches the shape', () => {
  assert.equal(classify(sent(), { programId: PROGRAM, profile: 2 }).ok, false);
  const shape = classify(sent(), { programId: PROGRAM, profile: 2, wide: lane });
  assert.equal(shape.ok, true);
  assert.equal(shape.wrapper, 'WideResidentAct');
  assert.equal(shape.authority, OWNER);
  assert.deepEqual(shape.resident, { generation: 1, ...proof });
});

test('the holder gate on the page\'s bytes: the current holder at its generation passes; after a transfer, the previous holder and the old generation are refused', async () => {
  // the chain after A→B: B owns the asset at generation 1 (the gate reads it; here a stand-in with the same answer)
  const B = OWNER, A = K(7);
  const ctx = { residents: { check: async ({ actor, resident }) => (actor !== B ? { ok: false, code: 'ResidentHolderChanged' } : resident.generation !== 1 ? { ok: false, code: 'ResidentGenerationStale' } : { ok: true }) } };
  const now = classify(sent(1), { programId: PROGRAM, profile: 2, wide: lane });
  assert.equal(await residentRefusal(ctx, CITIZEN, now.authority, now), null, 'B at generation 1');
  const old = classify(sent(0), { programId: PROGRAM, profile: 2, wide: lane });
  assert.equal(await residentRefusal(ctx, CITIZEN, old.authority, old), 'ResidentGenerationStale', 'signed before the transfer');
  assert.equal(await residentRefusal(ctx, CITIZEN, A, now), 'ResidentHolderChanged', 'the previous holder');
});
