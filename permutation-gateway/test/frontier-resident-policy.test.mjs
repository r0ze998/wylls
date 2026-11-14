// ⑳ CreateResidentPolicy's JS builder (client/src/frontier/resident.mjs) against the program's
// source: the wire (frontier-abi resident_wire.rs `decode`), the account order and flags
// (permutation-frontier nft_registration.rs), the guard rule (resident_binding.rs: the resident
// program's collection-authority address) and the resident program's own derivation
// (permutation-nft-resident-spike). No build, key or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createResidentPolicyIx, guardAuthorityAddress, policyAddress, CREATE_RESIDENT_POLICY_TAG } from '../client/src/frontier/resident.mjs';
import { programDataAddress, SYSTEM_PROGRAM } from '../client/src/frontier/addresses.mjs';
import { decode as fromB58 } from '../client/src/base58.mjs';
import { pdas } from '../../permutation-nft-resident-spike/src/resident-ix.mjs';

const src = p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const PROGRAM = '4eoSXjBJHcpLvMeT8XhxN2hdTpu4bAgAs8ys3VFhZEwN';
const AUTH = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const RESIDENT = '68TBCtDEfvunEQYEb4cZSBnkPWnu2h6XuvSTmLctZyv5';
const COLLECTION = '32BAc86QRafuU5kBhBDCbMdAF66DHPqtsho6Ny9espxj';

test('data: 0xE0 then core, resident program, collection, guard (4 × 32), as resident_wire::decode reads it', () => {
  const ix = createResidentPolicyIx({ programId: PROGRAM, authority: AUTH, coreProgram: CORE, residentProgram: RESIDENT, collection: COLLECTION });
  assert.equal(ix.programId, PROGRAM);
  assert.equal(ix.data.length, 1 + 128);
  assert.equal(ix.data[0], CREATE_RESIDENT_POLICY_TAG);
  assert.equal(CREATE_RESIDENT_POLICY_TAG, 0xe0);
  assert.deepEqual([...ix.data.slice(1, 33)], [...fromB58(CORE)]);
  assert.deepEqual([...ix.data.slice(33, 65)], [...fromB58(RESIDENT)]);
  assert.deepEqual([...ix.data.slice(65, 97)], [...fromB58(COLLECTION)]);
  assert.deepEqual([...ix.data.slice(97, 129)], [...fromB58(guardAuthorityAddress(RESIDENT))]);
  const wire = src('frontier-abi/src/resident_wire.rs');
  assert.match(wire, /\[CREATE_RESIDENT_POLICY, rest @ \.\.\] if rest\.len\(\) == 128/);
  assert.match(wire, /core_program: rest\[0\.\.32\][\s\S]*resident_program: rest\[32\.\.64\][\s\S]*collection: rest\[64\.\.96\][\s\S]*guard_authority: rest\[96\.\.128\]/);
});

test('accounts: [authority s w] [policy w] [program] [programdata] [system], as nft_registration.rs takes them', () => {
  const ix = createResidentPolicyIx({ programId: PROGRAM, authority: AUTH, coreProgram: CORE, residentProgram: RESIDENT, collection: COLLECTION });
  assert.deepEqual(ix.keys, [
    { pubkey: AUTH, isSigner: true, isWritable: true },
    { pubkey: policyAddress(PROGRAM), isSigner: false, isWritable: true },
    { pubkey: PROGRAM, isSigner: false, isWritable: false },
    { pubkey: programDataAddress(PROGRAM), isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
  ]);
  const reg = src('permutation-frontier/src/nft_registration.rs');
  assert.match(reg, /let \[authority, config, program_account, programdata, system\] = accounts else/);
  assert.match(reg, /!authority\.is_signer\n\s*\|\| !authority\.is_writable\n\s*\|\| !config\.is_writable/);
});

test('the guard is the resident program\'s collection-authority address, the same the resident program derives', () => {
  assert.equal(guardAuthorityAddress(RESIDENT), pdas(RESIDENT).collectionAuthority);
  const binding = src('permutation-frontier/src/resident_binding.rs');
  assert.match(binding, /find_program_address\(&\[GUARD_SEED\], &resident_program\)/);
  assert.match(binding, /GUARD_SEED: &\[u8\] = b"collection-authority"/);
});
