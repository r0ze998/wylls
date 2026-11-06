// ⑳ The page's NFT path (web/frontier/fplay.mjs, fresident.mjs): the shapes
// it builds for an NFT Citizen are the ones the relay classifies.
//
// Key-free: literal 32-byte addresses, no PDA computed (the identity is
// written in, not made by fresident.identityOf), no key generated, derived
// or signed; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode as b58 } from '../client/src/base58.mjs';
import { parseMessage } from '../client/src/solana-tx.mjs';
import { classify } from '../client/src/frontier/shapes.mjs';
import { accountsFor, buildShape, SIGNED_BY } from '../../permutation-server/web/frontier/fplay.mjs';
import { actorContext, joinAccounts } from '../../permutation-server/web/frontier/fresident.mjs';

const key = n => b58(new Uint8Array(32).fill(n));
const PROGRAM = key(0x11), FEE_PAYER = key(0x31), OWNER = key(0xa1), BLOCKHASH = key(0x77);
const addresses = { season: key(0x22), of: kind => ({ Frontier: key(0x42), Citizen: key(0x43) })[kind] ?? key(0x49) };
const id = {
  asset: key(0x5a), citizen: key(0x41), generation: 2, joined: true,
  proof: { policy: key(0x61), link: key(0x62), asset: key(0x5a), resident: key(0x63) },
};
const asTx = message => ({ ...parseMessage(message), signers: parseMessage(message).signers });

test('an NFT Citizen\'s action names its Citizen and the owner, and is a ResidentAct the relay takes', () => {
  const v = { addresses, profile: 3, ...actorContext(id, OWNER) };
  const accounts = accountsFor('SetVigil', v);
  assert.equal(accounts.citizen, id.citizen, 'the resident ID\'s Citizen, not the wallet\'s');
  assert.equal(accounts.actor, OWNER);
  const b = buildShape({ programId: PROGRAM, name: 'SetVigil', accounts, fields: { start_min: 600 }, feePayer: FEE_PAYER, blockhash: BLOCKHASH, profile: 3,
    resident: { generation: id.generation, proof: id.proof } });
  assert.deepEqual(b.signers, [OWNER]);
  const s = classify(asTx(b.message), { programId: PROGRAM, profile: 3 });
  assert.equal(s.ok, true, s.problem);
  assert.equal(s.wrapper, 'ResidentAct');
  assert.equal(s.resident.generation, 2);
  assert.equal(s.accounts.citizen, id.citizen);
  // Without the resident part it is the plain wallet shape (unchanged).
  const plain = buildShape({ programId: PROGRAM, name: 'SetVigil', accounts, fields: { start_min: 600 }, feePayer: FEE_PAYER, blockhash: BLOCKHASH, profile: 3 });
  assert.equal(classify(asTx(plain.message), { programId: PROGRAM, profile: 3 }).wrapper, undefined);
});

test('the first login of an NFT is a JoinResident signed by the owner', () => {
  assert.equal(SIGNED_BY.JoinResident, 'wallet');
  const accounts = accountsFor('JoinResident', { addresses, resident: joinAccounts(id, { addresses, owner: OWNER }) });
  const b = buildShape({ programId: PROGRAM, name: 'JoinResident', accounts, fields: { generation: 2, faction: 3 }, feePayer: FEE_PAYER, blockhash: BLOCKHASH, profile: 3 });
  assert.deepEqual(b.signers, [OWNER]);
  const s = classify(asTx(b.message), { programId: PROGRAM, profile: 3 });
  assert.equal(s.ok, true, s.problem);
  assert.equal(s.wrapper, 'JoinResident');
  assert.equal(s.accounts.citizen, id.citizen);
  assert.deepEqual(s.data, { generation: 2, faction: 3 });
});
