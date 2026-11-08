// ⑯ v2 web key hook, proof of installation by SOURCE TEXT ONLY (no entry point is called). Run as:
//   node --import <this dir>/v16-web-key-hook2.mjs <this file> <worktree>
// Exit 0 only if every guarded export is the refusal; otherwise exit 1 naming what is missing. Also loads
// @solana/web3.js (no key use) to show the v1 link failure is gone.
const root = process.argv[2];
const bad = [];
const s = await import(`${root}/permutation-server/web/session.mjs`);
const w = await import(`${root}/permutation-server/web/wallet.mjs`);
const f = await import(`${root}/permutation-server/web/frontier/fsession.mjs`);
for (const [m, names, label] of [[s, ['publicKeyOf', 'keyFromSeed', 'importBackup'], 'session.mjs'], [w, ['devWallet', 'enableDevWallet'], 'wallet.mjs'], [f, ['importBackup'], 'fsession.mjs']]) {
  for (const n of names) if (typeof m[n] !== 'function' || !String(m[n]).includes('⑯ key hook')) bad.push(`${label} ${n}`);
}
let web3 = 'not tried';
try { const { createRequire } = await import('node:module'); const req = createRequire(`${root}/permutation-gateway/package.json`); const p = req.resolve('@solana/web3.js'); await import(p.endsWith('.cjs') ? p : p); web3 = 'loads'; } catch (e) { web3 = `fails: ${String(e.message).slice(0, 90)}`; }
console.log(JSON.stringify({ installed: bad.length === 0, missing: bad, web3 }));
process.exit(bad.length ? 1 : 0);
