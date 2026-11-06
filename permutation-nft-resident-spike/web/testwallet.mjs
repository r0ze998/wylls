// A Wallet Standard wallet for the browser tests only: an Ed25519 key in
// WebCrypto from a seed kept in localStorage (so a reload keeps the same
// address), on a configurable chain, with knobs the tests flip through
// `localStorage`: `wylls-testwallet-reject=1` makes every signature request
// fail as a user rejection. The server offers it only when its config says
// `testWallet: true` (never in a devnet configuration).
import { parseTransaction, wireTransaction } from '/sdk/solana-tx.mjs';
import { encode as toBase58 } from '/sdk/base58.mjs';

const PKCS8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function makeTestWallet({ chain = 'solana:devnet', name = 'Test Wallet (browser tests)' } = {}) {
  let seedHex = localStorage.getItem('wylls-testwallet-seed');
  if (!/^[0-9a-f]{64}$/.test(seedHex ?? '')) { seedHex = hex(crypto.getRandomValues(new Uint8Array(32))); localStorage.setItem('wylls-testwallet-seed', seedHex); }
  const pkcs8 = new Uint8Array([...PKCS8, ...unhex(seedHex)]);
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  const pub = b64url(jwk.x);
  const address = toBase58(pub);
  const chainNow = () => localStorage.getItem('wylls-testwallet-chain') || chain;
  const account = () => ({ address, publicKey: pub, chains: [chainNow()], features: ['solana:signTransaction', 'solana:signMessage'] });
  const rejecting = () => localStorage.getItem('wylls-testwallet-reject') === '1';
  const sign = bytes => crypto.subtle.sign({ name: 'Ed25519' }, priv, bytes);
  const wallet = {
    version: '1.0.0', name, icon: 'data:image/svg+xml;base64,', get chains() { return [chainNow()]; }, get accounts() { return [account()]; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account()] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy'],
        signTransaction: (...inputs) => Promise.all(inputs.map(async ({ transaction }) => {
          if (rejecting()) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          const tx = parseTransaction(transaction);
          const i = tx.signers.indexOf(address);
          if (i < 0) throw new Error('the test wallet is not a signer of this transaction');
          const sigs = tx.signatures.slice();
          sigs[i] = new Uint8Array(await sign(tx.message));
          return { signedTransaction: wireTransaction(tx.message, sigs) };
        })),
      },
      'solana:signMessage': { version: '1.0.0', signMessage: (...inputs) => Promise.all(inputs.map(async ({ message }) => ({ signedMessage: Uint8Array.from(message), signature: new Uint8Array(await sign(message)) }))) },
    },
  };
  return { wallet, address };
}
