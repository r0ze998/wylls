// fplay.accountsFor: an S1 season (profile 3) builds the same ABI v2 account
// lists as an MC season (profile 2); only M1 (profile 1) leaves the v2
// accounts out. (On S1 a hand Harvest without its Province was refused.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import * as fplay from '../../permutation-server/web/frontier/fplay.mjs';

const PROGRAM = Keypair.generate().publicKey.toBase58();
io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: 7 });
const v = profile => ({
  addresses: io.pinned().addresses, profile, faction: 0, holding: { p: 1, q: -1, site: 0 },
  wallet: Keypair.generate().publicKey.toBase58(), actor: Keypair.generate().publicKey.toBase58(),
});

test('Harvest and Train name the Province on MC and S1, not on M1', () => {
  for (const name of ['Harvest', 'Train']) {
    assert.equal(fplay.accountsFor(name, v(1)).province, undefined, `${name} on M1`);
    for (const profile of [2, 3]) {
      assert.ok(fplay.accountsFor(name, v(profile)).province, `${name} on profile ${profile}`);
    }
  }
});

test('Dissolve names its holding_province on MC and S1', () => {
  assert.equal(fplay.accountsFor('Dissolve', v(1)).holding_province, undefined);
  assert.ok(fplay.accountsFor('Dissolve', v(3)).holding_province);
  assert.deepEqual(Object.keys(fplay.accountsFor('Dissolve', v(3))), Object.keys(fplay.accountsFor('Dissolve', v(2))));
});
