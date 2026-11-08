// ⑯ pure-function probe (2026-11-09): permutation-gateway src/frontier/config.mjs validateRelayRecords with the exact
// "good" records of test/frontier-relay-resume.test.mjs:50-63 and its 13 mutations. No fixture, no seed file, no
// persistInitialRelayState, no key: config.mjs is imported (it imports Keypair from @solana/web3.js but calls nothing at
// load) and only validateRelayRecords is called; its wallets are checked with `new PublicKey(x)` (public).
// Usage: node [--import hook] v16-gw-relay-records.mjs <worktree>
const { validateRelayRecords } = await import(`${process.argv[2]}/permutation-gateway/src/frontier/config.mjs`);
const signature = '1'.repeat(64);
const W = '11111111111111111111111111111111';
const good = () => ({
  quota: { 'citizen:valid': { day: 2, left: 3, lamports: 14 } },
  invitesUsed: { ['ab'.repeat(12)]: 123 },
  faucet: { [W]: { status: 'pending', amount: '100000000', signature, at: 123 } },
  claimPending: { [W]: { status: 'pending', signature, at: 123 } },
  relayPending: { ['msg:' + 'ab'.repeat(32)]: { status: 'unknown', signature, lastValidBlockHeight: 123, kind: 'Harvest', quotaKey: 'citizen:valid', day: 2, moved: '1000' } },
});
const bad = [
  s => { s.quota['citizen:valid'].left = -1; }, s => { s.quota['citizen:valid'].left = Number.MAX_SAFE_INTEGER; },
  s => { s.quota['citizen:valid'].lamports = -2; }, s => { s.quota['citizen:valid'].day = 1.5; },
  s => { s.invitesUsed['not-a-nonce'] = 123; }, s => { s.invitesUsed['ab'.repeat(12)] = 'yesterday'; },
  s => { s.faucet[W].amount = '-1'; }, s => { s.faucet[W].amount = '18446744073709551616'; }, s => { s.faucet[W].at = null; },
  s => { s.faucet[W].status = 'cleared'; }, s => { s.claimPending[W].status = 'cleared'; },
  s => { s.relayPending['msg:' + 'ab'.repeat(32)].status = 'cleared'; }, s => { s.relayPending['msg:' + 'ab'.repeat(32)].moved = '-1'; },
];
const out = {};
try { validateRelayRecords(good(), { prize: true }); out.good = 'accepted'; } catch (e) { out.good = `REFUSED: ${e.message}`; }
out.badRefused = bad.map(f => { const s = good(); f(s); try { validateRelayRecords(s, { prize: true }); return false; } catch { return true; } }).filter(Boolean).length + '/' + bad.length;
console.log(JSON.stringify(out));
