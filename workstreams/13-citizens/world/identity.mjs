// Which identities the test harness hands out. Default: each participant makes its own ed25519 key (the world checks
// signatures). WS13_KEYLESS=1: no key is generated, derived or used anywhere in the harness; addresses are fixed
// labels (resident/keys.mjs keylessIdentity) and the test world, created keyless, trusts the port it handed out.
// A keyless run cannot test signatures or owner commands (those tests skip), and must not be read as checking them.
import { keyIdentity, keylessIdentity, loadOrCreateKey, newKeypair } from '../resident/keys.mjs';

export const KEYLESS = process.env.WS13_KEYLESS === '1';
export const NEEDS_KEYS = KEYLESS ? 'keyless run (WS13_KEYLESS=1): this test signs or checks signatures' : false;

/** A participant's identity: keyless by label, else its key (from `keyFile` when given, made on first use). */
export function identityFor(label, keyFile = null) {
  if (KEYLESS) return keylessIdentity(label);
  return keyIdentity(keyFile ? loadOrCreateKey(keyFile) : newKeypair());
}
