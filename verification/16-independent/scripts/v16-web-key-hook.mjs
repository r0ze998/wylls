// ⑯: a strict preload for web-client tests, on top of scripts/ci/no-keys-guard.mjs. That guard refuses node:crypto,
// WebCrypto private-key use, web3.js and noble signing, but the web client also derives an Ed25519 public key in pure
// JS (permutation-server/web/session.mjs `publicKeyOf`, scalar multiplication over a SHA-512 digest) before its
// guarded importKey. This hook rewrites the web's own key entry points as they load, so ANY call is recorded to
// $V16_KEY_HOOK_LOG and throws:
//   session.mjs   publicKeyOf, keyFromSeed, importBackup
//   wallet.mjs    devWallet, enableDevWallet
//   fsession.mjs  importBackup
// A test that passes under this hook made none of those calls (a caught throw is still in the log).
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const LOG = process.env.V16_KEY_HOOK_LOG;
globalThis.__V16_KEY_HOOK__ = what => { if (LOG) appendFileSync(LOG, `${process.pid} ${what}\n`); throw new Error(`⑯ key hook: ${what} refused`); };
const RULES = [
  ['/permutation-server/web/session.mjs', ['publicKeyOf', 'keyFromSeed', 'importBackup']],
  ['/permutation-server/web/wallet.mjs', ['devWallet', 'enableDevWallet']],
  ['/permutation-server/web/frontier/fsession.mjs', ['importBackup']],
];
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    const rule = RULES.find(([suffix]) => url.endsWith(suffix));
    if (!rule) return r;
    let src = String(r.source);
    for (const n of rule[1]) {
      const re = new RegExp(`export (async )?function ${n}\\(`);
      if (!re.test(src)) { if (LOG) appendFileSync(LOG, `${process.pid} HOOK-MISS ${rule[0]} ${n}\n`); continue; }
      src = src.replace(re, (_m, a) => `${a ?? ''}function __v16_${n}(`);
      src += `\nexport function ${n}() { return globalThis.__V16_KEY_HOOK__('${rule[0].split('/').pop()} ${n}'); }\n`;
    }
    return { ...r, source: src };
  },
});
