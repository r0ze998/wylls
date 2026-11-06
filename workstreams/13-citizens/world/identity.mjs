// Which identities the test harness hands out. Default (since this round): KEYLESS. No key is generated, derived or
// used anywhere in the harness; addresses are fixed labels (resident/keys.mjs keylessIdentity) and the test world,
// created keyless, trusts the port it handed out. So a run started without the guard (test/keyless-guard.mjs) still
// makes no key. Only WS13_WITH_KEYS=1 (run.sh --with-keys) gives each participant its own ed25519 key and a world
// that checks signatures. A keyless run cannot test signatures or owner commands (those tests skip), and must not be
// read as checking them. WS13_KEYLESS=1 (set by the guard) is still honoured and wins over WS13_WITH_KEYS.
import { keyIdentity, keylessIdentity, loadOrCreateKey, newKeypair } from '../resident/keys.mjs';

export const KEYLESS = process.env.WS13_KEYLESS === '1' || process.env.WS13_WITH_KEYS !== '1';
export const NEEDS_KEYS = KEYLESS ? 'keyless run (the default; WS13_WITH_KEYS=1 for keys): this test signs or checks signatures' : false;

/** A participant's identity: keyless by label, else its key (from `keyFile` when given, made on first use). */
export function identityFor(label, keyFile = null) {
  if (KEYLESS) return keylessIdentity(label);
  return keyIdentity(keyFile ? loadOrCreateKey(keyFile) : newKeypair());
}
