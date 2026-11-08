const s = await import('${WORKTREE}/permutation-server/web/session.mjs');
const w = await import('${WORKTREE}/permutation-server/web/wallet.mjs');
for (const [name, f] of [['publicKeyOf', () => s.publicKeyOf(new Uint8Array(32))], ['keyFromSeed', () => s.keyFromSeed(new Uint8Array(32))], ['enableDevWallet', () => w.enableDevWallet({})]]) {
  try { await f(); console.log(name, 'RAN (hook failed)'); } catch (e) { console.log(name, 'refused:', String(e.message).slice(0, 60)); }
}
