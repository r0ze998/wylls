// 0xDD WideResidentAct for an NFT resident (local test lanes only; no deployed program has the wide band):
// the builder (same shape and proof accounts as 0xE2, only the band's act-run tags inside), the relay's classification
// (refused unless the lane passes its own inner classifier; proof accounts read-only, unsigned, distinct; a player
// shape only) and the holder gate (the relay passes 0xDD's proof — asset and signed generation — to the gate exactly
// as 0xE2's, so a previous holder or a pre-transfer generation is refused before anything is sponsored).
// No chain, no program run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wideResidentActIx, WIDE_RESIDENT_ACT_TAG, WIDE_ACT_INNER_TAGS, RESIDENT_ACT_TAG } from '../client/src/frontier/resident.mjs';
import { classify } from '../client/src/frontier/shapes.mjs';
import { budgetPrefix } from '../client/src/frontier/budgets.mjs';
import { compileMessage, wireTransaction, parseTransaction } from '../client/src/solana-tx.mjs';
import { residentRefusal } from '../src/frontier/routes/relay.mjs';
import { readFileSync } from 'node:fs';

const K = n => { const b = new Uint8Array(32).fill(n); let s = ''; const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); while (x > 0n) { s = A[Number(x % 58n)] + s; x /= 58n; } return s; };
const PROGRAM = K(0x4e), OWNER = K(1), PAYER = K(2), HOLDING = K(3);
const proof = { policy: K(10), link: K(11), asset: K(12), resident: K(13) };
const innerDepart = { programId: PROGRAM, keys: [{ pubkey: OWNER, isSigner: true, isWritable: false }, { pubkey: HOLDING, isSigner: false, isWritable: true }], data: Uint8Array.of(0xda, 0xff, 0x02, 0x04, 9, 9) };

function txOf(ix) {
  const msg = compileMessage({ feePayer: PAYER, recentBlockhash: K(99), instructions: [...budgetPrefix('Harvest', { profile: 2, cuLimit: 300000, loadedLimit: 1 << 20 }), ix] });
  return parseTransaction(wireTransaction(msg));
}
const lane = (shape = { ok: true, kind: 'player', authority: OWNER }) => ({ classifyInner: () => shape });

test('the builder: 0xDD ‖ generation u32 ‖ inner, the inner accounts then the four read-only proof accounts', () => {
  const ix = wideResidentActIx(innerDepart, { generation: 3, ...proof });
  assert.equal(WIDE_RESIDENT_ACT_TAG, 0xdd);
  assert.notEqual(WIDE_RESIDENT_ACT_TAG, RESIDENT_ACT_TAG);
  assert.deepEqual([...ix.data.slice(0, 5)], [0xdd, 3, 0, 0, 0]);
  assert.deepEqual([...ix.data.slice(5)], [...innerDepart.data]);
  assert.deepEqual(ix.keys.slice(-4).map(k => [k.pubkey, k.isSigner, k.isWritable]), Object.values(proof).map(p => [p, false, false]));
  assert.deepEqual(WIDE_ACT_INNER_TAGS, [0xd9, 0xda]);
  for (const t of [0x00, 0xdb, 0xdd, 0xe2, 0xee]) assert.throws(() => wideResidentActIx({ ...innerDepart, data: Uint8Array.of(t, 1) }, { generation: 0, ...proof }), /not run inside WideResidentAct/, `0x${t.toString(16)}`);
  assert.throws(() => wideResidentActIx(innerDepart, { generation: -1, ...proof }), /generation u32/);
});

test('the program\'s act-run list is the one the builder uses (frontier-abi wide_ix.rs act_runs: ClaimSite, Depart)', () => {
  const src = readFileSync(new URL('../../frontier-abi/src/world_index/wide_ix.rs', import.meta.url), 'utf8');
  assert.match(src, /pub const fn act_runs\(self\) -> bool \{\s*matches!\(self, WideIx::ClaimSite \| WideIx::Depart\)/);
  assert.match(src, /pub const TAG_CLAIM_SITE: u8 = 0xD9;/);
  assert.match(src, /pub const TAG_DEPART: u8 = 0xDA;/);
  assert.match(src, /pub const TAG_RESIDENT_ACT: u8 = 0xDD;/);
});

test('the relay: refused unless the lane serves the band; then the proof and the inner shape decide', () => {
  const tx = txOf(wideResidentActIx(innerDepart, { generation: 3, ...proof }));
  const off = classify(tx, { programId: PROGRAM, profile: 2 });
  assert.equal(off.ok, false);
  assert.match(off.problem, /not served on this lane/);
  const on = classify(tx, { programId: PROGRAM, profile: 2, wide: lane() });
  assert.equal(on.ok, true);
  assert.equal(on.wrapper, 'WideResidentAct');
  assert.deepEqual(on.resident, { generation: 3, ...proof });
  // the inner shape must be a player one
  assert.match(classify(tx, { programId: PROGRAM, profile: 2, wide: lane({ ok: true, kind: 'settle' }) }).problem, /player shape only/);
  assert.equal(classify(tx, { programId: PROGRAM, profile: 2, wide: lane({ ok: false, code: 'RelayRejected', problem: 'x' }) }).ok, false);
  // a proof account that signs or is writable, or repeats an inner account
  const bad = wideResidentActIx(innerDepart, { generation: 3, ...proof });
  bad.keys[bad.keys.length - 1] = { ...bad.keys[bad.keys.length - 1], isWritable: true };
  assert.match(classify(txOf(bad), { programId: PROGRAM, profile: 2, wide: lane() }).problem, /read-only/);
  const dup = wideResidentActIx(innerDepart, { generation: 3, ...proof, asset: HOLDING });
  assert.equal(classify(txOf(dup), { programId: PROGRAM, profile: 2, wide: lane() }).ok, false);
  // an inner tag outside the act-run list, built by hand
  const raw = { programId: PROGRAM, keys: [...innerDepart.keys, ...Object.values(proof).map(p => ({ pubkey: p, isSigner: false, isWritable: false }))], data: Uint8Array.of(0xdd, 0, 0, 0, 0, 0xdb, 1) };
  assert.match(classify(txOf(raw), { programId: PROGRAM, profile: 2, wide: lane() }).problem, /not run inside it/);
});

test('the holder gate gets 0xDD\'s proof like 0xE2\'s: a previous holder or a stale generation is refused', async () => {
  const seen = [];
  const ctx = { residents: { check: async q => { seen.push(q); return q.resident?.generation === 3 && q.actor === OWNER ? { ok: true } : { ok: false, code: q.actor !== OWNER ? 'ResidentHolderChanged' : 'ResidentGenerationStale' }; } } };
  const shape = { wrapper: 'WideResidentAct', resident: { generation: 3, ...proof } };
  assert.equal(await residentRefusal(ctx, 'CITIZEN', OWNER, shape), null);
  assert.deepEqual(seen[0].resident, shape.resident, 'the proof reached the gate');
  assert.equal(await residentRefusal(ctx, 'CITIZEN', K(7), shape), 'ResidentHolderChanged', 'the previous holder');
  assert.equal(await residentRefusal(ctx, 'CITIZEN', OWNER, { ...shape, resident: { ...shape.resident, generation: 2 } }), 'ResidentGenerationStale', 'signed before the transfer');
});
