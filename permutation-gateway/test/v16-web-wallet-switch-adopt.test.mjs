// ⑯ independent verification (flow C, C3) against the controller itself,
// for trees that export `adoptConnectedWallet` (integration ef63544c and
// later). No key is generated, derived or signed: the two accounts are
// fixed address strings, and nothing here builds or signs a transaction.
// The listener that calls it on a Wallet Standard `change` event lives in
// startPlay (needs a page) and is checked by reading, not run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';

const A = 'AccountA111111111111111111111111111111111111';
const B = 'AccountB111111111111111111111111111111111111';

test('V16-C3b: switching to another account leaves none of the previous account\'s identity, session, Citizen or holdings', () => {
  assert.equal(typeof C.adoptConnectedWallet, 'function', 'this tree has no adoptConnectedWallet (C3 not fixed here)');
  C.adoptConnectedWallet({ address: A });
  // The page as account A sees it.
  FS.session = { owner: A };
  FS.sessionProblem = 'SessionMismatch';
  FS.citizen = { wallet: A, faction: 2 };
  FS.holdings = [{ p: 1, q: 0 }];
  FS.isMine = () => true;
  FS.prize = { wallet: A };
  assert.equal(C.adoptConnectedWallet({ address: B }), true, 'a different account is adopted');
  assert.equal(FS.wallet.address, B, 'the page acts as the new account');
  const left = { session: FS.session, sessionProblem: FS.sessionProblem, citizen: FS.citizen, holdings: FS.holdings.length, isMine: FS.isMine({}), prize: FS.prize };
  assert.deepEqual(left, { session: null, sessionProblem: null, citizen: null, holdings: 0, isMine: false, prize: null },
    `the previous account's state must not carry over: ${JSON.stringify(left)}`);
  // The same account again is not a switch (no reset of what it already loaded).
  FS.citizen = { wallet: B };
  assert.equal(C.adoptConnectedWallet({ address: B }), false);
  assert.deepEqual(FS.citizen, { wallet: B });
  // Disconnect: no account, nothing of B left.
  assert.equal(C.adoptConnectedWallet(null), true);
  assert.equal(FS.wallet, null);
  assert.equal(FS.citizen, null);
});
