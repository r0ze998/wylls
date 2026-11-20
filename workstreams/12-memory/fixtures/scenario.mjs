// Workstream 12: the deterministic fixture of the demo (fixture v2) with its live signer: deterministic TEST-ONLY
// ed25519 keys (seed = a constant per principal, from the first character of its handle). These are fixture keys for
// a local test, not keys of any real account. Everything else is in scenario-core.mjs; key-free tests import
// presigned.mjs instead, which has the same exports and signs nothing.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { installSigner } from './scenario-core.mjs';

const seedOf = tag => Buffer.alloc(32, tag.charCodeAt(0));
const privOf = tag => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedOf(tag)]), format: 'der', type: 'pkcs8' });
/** The fixture key's public half (32 bytes hex) and its signature over `bytes` (64 bytes hex). */
export const fixturePublicKey = tag => createPublicKey(privOf(tag)).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
export const fixtureSignature = (tag, bytes) => sign(null, bytes, privOf(tag)).toString('hex');
installSigner({ name: 'live', publicHex: fixturePublicKey, signatureHex: fixtureSignature });
export * from './scenario-core.mjs';
