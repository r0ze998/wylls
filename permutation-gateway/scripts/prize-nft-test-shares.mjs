#!/usr/bin/env node
// TEST ONLY: post a test shares ledger's root with the operator's real SetShares on a LOOPBACK local chain
// (⑰, 2026-11-15). The ledger (scripts/prize-nft-test-shares-ledger.mjs) is built from a given member list, not
// from achievements: it exercises the claim path; it is not a prize allocation and decides no weight or rule.
//
//   node permutation-gateway/scripts/prize-nft-test-shares.mjs --test-only-shares \
//     --rpc http://127.0.0.1:<port> --expect-run-id <hex> --prize <program> --game <program> --season-id <n> \
//     --members members.json --out ledger.json [--ledger-file <where the relay serves it>] \
//     [--set-shares --operator-seed-file <the run's 0600 seed file>]
//
// Refuses: no --test-only-shares; a non-loopback RPC; any redirect; another world's runId; a pool off its address,
// of another game/season, or not Final; members outside the winners (the ledger builder). With --set-shares, the
// key must be the pool's operator. The seed is read from the file only; it is never printed. Prints JSON lines.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { decodePool, POOL_STATE, poolAddress, PRIZE_ERRORS, setSharesIx, SHARE_MODE } from '../client/src/frontier/prize.mjs';
import { compileMessage, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { isLoopbackRpc } from './prize-nft-fixture-entry.mjs';
import { testSharesLedger } from './prize-nft-test-shares-ledger.mjs';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const fail = m => { console.error(m); process.exit(3); };

if (!flag('test-only-shares')) fail('refusing: --test-only-shares is required (a test ledger, not a prize allocation)');
const url = opt('rpc');
if (!isLoopbackRpc(url)) fail(`refusing: ${url} is not a loopback RPC`);
for (const k of ['expect-run-id', 'prize', 'game', 'season-id', 'members', 'out']) if (!opt(k)) fail(`--${k} is required`);

async function rpc(method, params) {
  const r = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const st = await rpc('frontier_status', []);
if (st?.runId?.toLowerCase() !== opt('expect-run-id').toLowerCase()) fail(`refusing: runId ${st?.runId} is not --expect-run-id (another world)`);
const seasonId = BigInt(opt('season-id'));
const program = opt('prize');
const poolKey = poolAddress(program, opt('game'), seasonId);
const pa = (await rpc('getAccountInfo', [poolKey, { encoding: 'base64' }]))?.value;
const pool = pa && pa.owner === program ? decodePool(Buffer.from(pa.data[0], 'base64')) : null;
if (!pool) fail(`refusing: no pool at ${poolKey}`);
if (pool.gameProgram !== opt('game') || pool.seasonId !== seasonId) fail('refusing: the pool names another game or season');
if (pool.state !== POOL_STATE.FINAL) fail(`refusing: the pool is not Final (state ${pool.state})`);
const prize = { program, pool: poolKey, vault: pool.vault, mint: pool.mint };
const { ledger, root, totals, ledgerText } = testSharesLedger({ prize, pool, members: JSON.parse(readFileSync(opt('members'), 'utf8')) });
writeFileSync(opt('out'), ledgerText);
if (opt('ledger-file')) writeFileSync(opt('ledger-file'), ledgerText);
const ledgerHash = createHash('sha256').update(ledgerText).digest();
console.log(JSON.stringify({ testOnly: ledger.label, root: ledger.shares.root, totals: totals.map(String), ledgerSha256: ledgerHash.toString('hex'), out: opt('out') }));

if (flag('set-shares')) {
  if (!opt('operator-seed-file')) fail('--set-shares needs --operator-seed-file');
  const operator = Keypair.fromSeed(Buffer.from(readFileSync(opt('operator-seed-file'), 'utf8').trim(), 'hex'));
  if (operator.publicKey.toBase58() !== pool.operator) fail('refusing: that key is not the pool\'s operator');
  const ix = setSharesIx({ prize, operator: pool.operator, mode: SHARE_MODE.SHARES, totals, root, ledgerHash });
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = compileMessage({ feePayer: pool.operator, recentBlockhash: value.blockhash, instructions: [ix] });
  const wire = wireTransaction(message, { [pool.operator]: signTalk(message, operator) });
  const sig = await rpc('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', skipPreflight: true }]);
  for (let i = 0; i < 120; i++) {
    const s = (await rpc('getSignatureStatuses', [[sig]]))?.value?.[0];
    if (s?.err) fail(`SetShares ${sig} failed: ${PRIZE_ERRORS[s.err?.InstructionError?.[1]?.Custom] ?? JSON.stringify(s.err)}`);
    if (s && ['confirmed', 'finalized'].includes(s.confirmationStatus)) { console.log(JSON.stringify({ setShares: sig, testOnly: true })); process.exit(0); }
    await sleep(250);
  }
  fail(`SetShares ${sig}: no result`);
}
