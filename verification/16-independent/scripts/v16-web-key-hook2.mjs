// ⑯ v2 of the web key hook (2026-11-09). v1 (v16-web-key-hook.mjs) used node:module registerHooks (in-thread sync
// hooks); on Node 22.22 merely registering its `load` hook breaks require(esm) of uuid's ESM build (reached from
// @solana/web3.js through jayson): "request for './max.js' is from a module not been linked" — 37 gateway results were
// inconclusive for that reason, and passed as NODE_OPTIONS it also reached child processes run under the permission
// model (ERR_ACCESS_DENIED on the hook file). v2 uses module.register (off-thread async hooks): `require` is left alone.
// It rewrites the web's own key entry points as they load, so ANY call is recorded to $V16_KEY_HOOK_LOG and throws:
//   session.mjs publicKeyOf, keyFromSeed, importBackup; wallet.mjs devWallet, enableDevWallet; fsession.mjs importBackup
// Pass it with --import on the test process only (never NODE_OPTIONS). Proof of installation is by source text
// (v16-web-key-hook2-proof.mjs), never by calling an entry point.
import { register } from 'node:module';
register('./v16-web-key-hook2-loader.mjs', import.meta.url);
