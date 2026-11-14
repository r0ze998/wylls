// The wide band's player commands as the page would encode them for an NFT Citizen on the LOCAL TEST CANDIDATE lane:
// every encoder against the expected bytes of frontier-abi/vectors/v2/wide-resident-candidate.json (hand-derived from
// the Rust encoders; the Rust side checks the same file's bytes in frontier-abi/tests/wide_resident_candidate_vectors.rs,
// not compiled yet), the account lists against wide_ix.rs's groups (positions, signers, writables), the refusals the
// Rust has no wire form for, and the candidate-only 0xDD builder: refused for any other lane, and its bytes go through
// the relay's classifier (served only by the candidate lane gate) with the proof and the generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wideCommandData, wideCommandKeys, wideMirrorWrite, candidateWideActIx, wideResidentActIx, LOCAL_CONQUEST_NFT_CANDIDATE as C, wideLaneFor, WIDE_BAND } from '../client/src/frontier/resident.mjs';
import { SYSTEM_PROGRAM } from '../client/src/frontier/addresses.mjs';
import { DECLARE_SIEGE_SHAPE } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { WIDE_SEAL_LEN } from '../../permutation-server/web/frontier/seal-wide.mjs';
import { classify } from '../client/src/frontier/shapes.mjs';
import { budgetPrefix } from '../client/src/frontier/budgets.mjs';
import { compileMessage, wireTransaction, parseTransaction } from '../client/src/solana-tx.mjs';

const V = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/wide-resident-candidate.json', import.meta.url), 'utf8'));
const hex = b => Buffer.from(b).toString('hex');
const K = n => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let x = 0n; for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(n); let s = ''; while (x > 0n) { s = A[Number(x % 58n)] + s; x /= 58n; } return s; };
const cmdOf = c => ({ name: c.name, ...c.input });

test('every command\'s data is exactly the expected bytes; out-of-range inputs have no wire form', () => {
  for (const c of V.commands) assert.equal(hex(wideCommandData(cmdOf(c))), c.hex, `${c.name} ${JSON.stringify(c.input)}`);
  for (const c of V.refused) assert.throws(() => wideCommandData(cmdOf(c)), `${c.name} ${JSON.stringify(c.input)} is refused`);
  for (const c of V.commands.filter(x => x.name === 'Economy')) assert.equal(wideMirrorWrite(cmdOf(c)), !!c.mirrorWrite);
  assert.equal(wideMirrorWrite({ name: 'Economy', action: 'Build', item: 7 }), true, 'the tier-up writes the mirror too');
  assert.throws(() => wideCommandData({ name: 'ClaimSite', p: 0, q: 0, site: 1, slot: 1 }), /slot 2 or 3/);
  assert.throws(() => wideCommandData({ name: 'Nope' }), /not a wide player command/);
});

test('the 0xDD wrapping is exactly the expected bytes', () => {
  for (const x of V.wrapped) {
    const inner = { programId: C.programId, keys: [], data: Uint8Array.from(Buffer.from(x.inner, 'hex')) };
    const proof = { policy: K(10), link: K(11), asset: K(12), resident: K(13) };
    assert.equal(hex(wideResidentActIx(inner, { generation: x.generation, ...proof }).data), x.hex);
  }
});

test('the account lists follow wide_ix.rs\'s groups: positions, signers, writables', () => {
  const a = { actor: K(1), payer: K(2), season: K(3), citizen: K(4), holding: K(5), province: K(6), roster: K(7), holding_province: K(8), transits: [K(20), K(21), K(22), K(23)],
    frontier: K(9), wide_ticket: K(30), anchor_holding: K(31), anchor_province: K(32), previous_holding: K(33), previous_province: K(34) };
  const shape = keys => keys.map(k => `${k.isSigner ? 's' : '-'}${k.isWritable ? 'w' : 'r'}`).join(' ');
  // the deployed player prologue [actor s] [payer s,w] [season r] [citizen w]
  assert.equal(shape(wideCommandKeys({ name: 'Muster' }, a)), 'sr sw -r -w -w -w -w -r');
  assert.equal(wideCommandKeys({ name: 'Muster' }, a).at(-1).pubkey, SYSTEM_PROGRAM);
  assert.equal(shape(wideCommandKeys({ name: 'Dissolve' }, a)), 'sr sw -r -w -w -w -r -r -r -r -r -r');
  assert.equal(shape(wideCommandKeys({ name: 'Economy', action: 'Harvest' }, a)), 'sr sw -r -w -w -r', 'an ordinary action: province read-only (Wr::Either)');
  assert.equal(shape(wideCommandKeys({ name: 'Economy', action: 'Build', item: 6 }, a)), 'sr sw -r -w -w -w', 'walls: ECONOMY_MIRROR');
  assert.equal(shape(wideCommandKeys({ name: 'Garrison', delta: 1 }, a)), 'sr sw -r -w -w -w', 'GARRISON = ECONOMY_MIRROR');
  assert.equal(shape(wideCommandKeys({ name: 'ClaimSite', slot: 2 }, a)), 'sr sw -r -w -r -w -w -w -r -w -r -r');
  // WideDepart: exactly the departing slot's transit writable, the roster last
  assert.equal(shape(wideCommandKeys({ name: 'Depart', transitSlot: 2 }, a)), 'sr sw -r -w -w -w -r -r -r -r -w -r -r');
  assert.equal(wideCommandKeys({ name: 'Depart', transitSlot: 2 }, a).at(-1).pubkey, a.roster);
  // DeclareSiege: canonical's order and flags (fconquest-identity.mjs), the actor read-only (owner ≠ payer for an NFT)
  const siegeAccounts = { ...a, source_holding: K(40), target_province: K(41), target_roster: K(42), source_province: K(43), target_holding_position: K(44), conquest: K(45), capture_escrow: K(46) };
  const siege = wideCommandKeys({ name: 'DeclareSiege' }, siegeAccounts);
  assert.deepEqual(siege.map(k => [k.isSigner, k.isWritable]), DECLARE_SIEGE_SHAPE.map(([name, signer, writable]) => [signer, writable]));
  assert.equal(siege[0].isWritable, false, 'the actor: the Rust shape (not writable)');
  assert.throws(() => wideCommandKeys({ name: 'Dissolve' }, { ...a, transits: [K(20)] }), /four transit/);
  // the Rust groups say the same (names and order), read from the source
  const src = readFileSync(new URL('../../frontier-abi/src/world_index/wide_ix.rs', import.meta.url), 'utf8');
  const group = name => { const i = src.indexOf(`pub const ${name}: &[Group] = &[one(&[`); return [...src.slice(i, src.indexOf('])];', i)).matchAll(/s\("([a-z_]+)"/g)].map(m => m[1]); };
  assert.deepEqual(group('MUSTER'), ['actor', 'payer', 'season', 'citizen', 'holding', 'province', 'roster', 'system']);
  assert.deepEqual(group('ECONOMY'), ['actor', 'payer', 'season', 'citizen', 'holding', 'province']);
  assert.deepEqual(group('DISSOLVE'), ['actor', 'payer', 'season', 'citizen', 'holding', 'province', 'roster', 'holding_province', 'transit', 'transit', 'transit', 'transit']);
  assert.deepEqual(group('DEPART'), ['actor', 'payer', 'season', 'citizen', 'holding', 'province', 'system', 'holding_province', 'transit', 'transit', 'transit', 'transit', 'roster']);
  assert.deepEqual(group('CLAIM_SITE'), ['actor', 'payer', 'season', 'citizen', 'frontier', 'province', 'wide_ticket', 'anchor_holding', 'anchor_province', 'previous_holding', 'previous_province', 'system']);
});

test('the candidate-only builder: refused for any other lane; its bytes pass the relay only through the candidate gate, with the proof', () => {
  const accounts = { actor: K(1), payer: K(2), season: K(3), citizen: K(4), holding: K(5), province: K(6) };
  const resident = { generation: 1, proof: { policy: K(10), link: K(11), asset: K(12), resident: K(13) } };
  const cmd = { name: 'Economy', action: 'Train', unit: 3, n: 500 };
  for (const lane of [{ programId: K(0x45), programVersion: 0x4804 }, { programId: K(0x4e), programVersion: 0x8004 }, { programId: C.programId, programVersion: 0x4804 }]) {
    assert.throws(() => candidateWideActIx({ lane, cmd, accounts, resident }), /only for the local test candidate lane/, JSON.stringify(lane));
  }
  const ix = candidateWideActIx({ lane: { programId: C.programId, programVersion: C.programVersion }, cmd, accounts, resident });
  assert.equal(hex(ix.data), `dd01000000${'daff0103'}0203f4010000`);
  const tx = parseTransaction(wireTransaction(compileMessage({ feePayer: K(2), recentBlockhash: K(99), instructions: [...budgetPrefix('Harvest', { profile: 2, cuLimit: 400000, loadedLimit: 1 << 20 }), ix] })));
  const inner = () => ({ ok: true, kind: 'player', authority: K(1) });
  assert.equal(classify(tx, { programId: C.programId, profile: 2 }).ok, false, 'no lane gate: refused');
  const ok = classify(tx, { programId: C.programId, profile: 2, wide: wideLaneFor({ programId: C.programId, season: { PROGRAM_VERSION: C.programVersion }, classifyInner: inner }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.resident, { generation: 1, ...resident.proof });
  assert.equal(WIDE_BAND.TRAIN_UNITS, 7, 'permutation-rules arms.rs TRAIN_ARMS_PER_100 has 7 entries');
  assert.equal(WIDE_BAND.WIDE_SEAL_LEN, WIDE_SEAL_LEN, 'the seal length is seal-wide.mjs\'s');
});
