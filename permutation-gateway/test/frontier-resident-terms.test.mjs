// ⑳ NFT resident ID: the relay's terms table equals the program's
// (`frontier-abi/src/resident_terms.rs` DEFAULT), and the private scope
// separates holder generations unless private data is carried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESIDENT_TERMS, privateScope } from '../src/frontier/resident-terms.mjs';
import { residentRoutes } from '../src/frontier/routes/residents.mjs';

const RUST = readFileSync(new URL('../../frontier-abi/src/resident_terms.rs', import.meta.url), 'utf8');

test('the relay table is the Rust DEFAULT, field by field', () => {
  const block = /pub const DEFAULT: Terms = Terms \{([\s\S]*?)\};/.exec(RUST)[1];
  const rust = Object.fromEntries([...block.matchAll(/(\w+): \w+::(\w+),/g)].map(m => [m[1].replace(/_(\w)/g, (_, c) => c.toUpperCase()), m[2]]));
  assert.deepEqual(rust, { ...RESIDENT_TERMS });
});

test('private data is scoped to the holder generation (U9 default: not carried)', () => {
  assert.equal(privateScope('A55et', 0), 'A55et#g0');
  assert.notEqual(privateScope('A55et', 0), privateScope('A55et', 1));
  assert.notEqual(privateScope('A55et', 0), privateScope('A55et', 2), 'a buy-back is a new generation');
  assert.equal(privateScope('A55et', 0, { ...RESIDENT_TERMS, private: 'Carried' }), privateScope('A55et', 5, { ...RESIDENT_TERMS, private: 'Carried' }));
  assert.throws(() => privateScope('A55et', -1));
  assert.throws(() => privateScope('', 0));
});

test('GET /f/residents states the terms with the list', async () => {
  const ctx = {
    programId: '11111111111111111111111111111112',
    addresses: { season: '11111111111111111111111111111113' },
    connection: { getAccountInfo: async () => null },
  };
  const url = new URL('http://x/f/residents?owner=11111111111111111111111111111114');
  const r = await residentRoutes['GET /f/residents'](ctx, { url });
  assert.deepEqual(r.body, { residents: [], policy: null, terms: RESIDENT_TERMS });
});
