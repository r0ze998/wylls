// ⑯ independent verification (flow C, "別ウォレットでも確認"): what the play
// page does when the user switches accounts inside the wallet.
//
// web/wallet.mjs follows the Wallet Standard `change` event: `connected()`
// returns the new account at once and every onChange listener is called.
// controller.mjs (startPlay) registers exactly one listener:
//     const listWallets = () => { FS.walletList = wallet.list(...); invalidate('panel'); };
//     wallet.onChange(listWallets);
// and sets FS.wallet / FS.session only in `connect` and at boot. So after a
// switch the page keeps the previous account's address, Citizen, holdings
// and session key. This test drives the real wallet.mjs with a fake Wallet
// Standard wallet and MODELS the controller's two lines (a copy, labelled as
// such: the controller itself needs a page to start). The invariant is that
// the page's account follows the wallet's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import * as wallet from '../../permutation-server/web/wallet.mjs';

function fakeWallet(name, accounts) {
  const handlers = [];
  const w = {
    name, icon: '', chains: ['solana:localnet'], accounts,
    features: {
      'standard:connect': { connect: async () => ({ accounts: w.accounts }) },
      'standard:events': { on: (ev, h) => { if (ev === 'change') handlers.push(h); return () => {}; } },
      'solana:signTransaction': { signTransaction: async () => [], supportedTransactionVersions: ['legacy'] },
      'solana:signMessage': { signMessage: async () => [] },
    },
    /** the user picks another account in the wallet UI */
    switchTo(account) { w.accounts = [account]; for (const h of handlers) h({ accounts: w.accounts }); },
  };
  return w;
}
const account = address => ({ address, chains: ['solana:localnet'], features: ['solana:signTransaction', 'solana:signMessage'] });

test('V16-C3: after the user switches accounts in the wallet, the page acts as the new account (model of controller.mjs startPlay)', async () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  const w = fakeWallet('Fake', [account(a)]);
  // The page's state and its one wallet listener, as controller.mjs:1882-1883 has them (copied; see the header).
  const FS = { wallet: null, walletList: [] };
  const listWallets = () => { FS.walletList = wallet.list('solana:localnet'); };
  wallet.onChange(listWallets);
  await wallet.connect(w, { chain: 'solana:localnet' });
  FS.wallet = wallet.connected(); // controller.mjs `connect` action: the only place FS.wallet is set after boot
  assert.equal(FS.wallet.address, a);
  w.switchTo(account(b));
  assert.equal(wallet.connected().address, b, 'wallet.mjs follows the switch (the real module)');
  assert.equal(FS.wallet.address, b, `the page must follow too; it still acts as ${FS.wallet.address === a ? 'the previous account' : FS.wallet.address}`);
});
