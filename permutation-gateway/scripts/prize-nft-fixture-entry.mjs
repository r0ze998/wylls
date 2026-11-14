#!/usr/bin/env node
// TEST ONLY tamper fixture (⑰, 2026-11-15): place ONE existing NFT pass Entry on a LOOPBACK frontier-localnet
// started with --allow-tamper, through its frontier_setAccount method. It stands for an Entry that existed on a
// chain from before pass deposits were refused. IT IS NOT A DEPOSIT and must never be reported as one: the
// prize program refuses every PayResident (ResidentDepositsDisabled), and nothing here calls it.
//
//   node permutation-gateway/scripts/prize-nft-fixture-entry.mjs --tamper-fixture-test-only \
//     --rpc http://127.0.0.1:<port> --prize <prize program> --pool <pool> --asset <asset> \
//     --paid-by <wallet> --amount <units> [--pay-generation <n>]
//
// What it writes: only the Entry account (192 B, magic WYPRNFTE, owner = the prize program, rent-exempt
// lamports), at entryResidentAddress(prize, pool, asset) with its bump. It does NOT mint tokens into the vault
// and does NOT change the pool's counters: the pass's fee is therefore not in the prize; the prize is funded only
// by real wallet Pay instructions. It refuses: no --tamper-fixture-test-only; a non-loopback RPC; a pool that is
// absent or not the prize program's; an absent asset; an Entry that already exists. It reads the account back
// and checks it decodes to what was asked. Prints one JSON line. No key is read, made or printed.
import { decodeEntryResident, ENTRY_RESIDENT_SIZE } from '../client/src/frontier/prize.mjs';
import { findProgramAddress, pubkeyBytes } from '../client/src/solana-tx.mjs';
import { utf8 } from '../client/src/bytes.mjs';

/** The Entry's bytes as the program's `entry_resident` layout (permutation-prize/src/lib.rs, NFT-PRIZE.md §2). */
export function fixtureEntryBytes({ bump, pool, asset, amount, paidBy, payGeneration = 0 }) {
  const amt = BigInt(amount);
  if (!Number.isInteger(bump) || bump < 0 || bump > 255) throw new Error('bump: u8');
  if (!Number.isInteger(payGeneration) || payGeneration < 0 || payGeneration > 0xffffffff) throw new Error('payGeneration: u32');
  if (amt < 0n || amt > 0xffff_ffff_ffff_ffffn) throw new Error('amount: u64');
  const d = new Uint8Array(ENTRY_RESIDENT_SIZE);
  d.set(utf8('WYPRNFTE'), 0);
  d[8] = bump;
  // claimed (9), nation_recorded (10), nation (11) stay 0: unclaimed, no nation recorded.
  new DataView(d.buffer).setUint32(12, payGeneration, true);
  d.set(pubkeyBytes(pool), 16);
  d.set(pubkeyBytes(asset), 48);
  new DataView(d.buffer).setBigUint64(80, amt, true);
  // paid_slot (88), claim_amount (96), claimed_by (136), claim_generation (168), reserved (172..191): 0.
  d.set(pubkeyBytes(paidBy), 104);
  return d;
}

/** Only a loopback RPC (127.0.0.0/8, ::1, localhost) is accepted. */
export function isLoopbackRpc(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tamper-fixture-test-only') { o.tamper = true; continue; }
    if (!a.startsWith('--')) throw new Error(`unexpected ${a}`);
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

const info = async (url, k) => (await rpc(url, 'getAccountInfo', [k, { encoding: 'base64' }]))?.value ?? null;

export async function main(argv) {
  const o = args(argv);
  if (!o.tamper) throw new Error('refusing: --tamper-fixture-test-only is required (this writes a fixture account; it is not a deposit)');
  if (!isLoopbackRpc(o.rpc)) throw new Error(`refusing: ${o.rpc} is not a loopback RPC`);
  for (const k of ['prize', 'pool', 'asset', 'paid-by', 'amount']) if (!o[k]) throw new Error(`--${k} is required`);
  const pool = await info(o.rpc, o.pool);
  if (!pool || pool.owner !== o.prize) throw new Error(`refusing: the pool ${o.pool} is absent or not owned by ${o.prize}`);
  if (!(await info(o.rpc, o.asset))) throw new Error(`refusing: the asset ${o.asset} does not exist`);
  const [entry, bump] = findProgramAddress([utf8('entry-nft'), pubkeyBytes(o.pool), pubkeyBytes(o.asset)], o.prize);
  if (await info(o.rpc, entry)) throw new Error(`refusing: the Entry ${entry} already exists`);
  // The fee the Entry records (informational on the Entry; not moved anywhere): given explicitly, never guessed.
  if (o.amount === undefined) throw new Error('--amount is required (the fee the Entry records)');
  const amount = BigInt(o.amount);
  const data = fixtureEntryBytes({ bump, pool: o.pool, asset: o.asset, amount, paidBy: o['paid-by'], payGeneration: Number(o['pay-generation'] ?? 0) });
  const lamports = await rpc(o.rpc, 'getMinimumBalanceForRentExemption', [ENTRY_RESIDENT_SIZE]);
  await rpc(o.rpc, 'frontier_setAccount', [entry, { lamports, data: [Buffer.from(data).toString('base64'), 'base64'], owner: o.prize, executable: false }]);
  const back = await info(o.rpc, entry);
  const e = back && back.owner === o.prize ? decodeEntryResident(Buffer.from(back.data[0], 'base64')) : null;
  if (!e || e.asset !== o.asset || e.pool !== o.pool || e.paidBy !== o['paid-by'] || e.claimed) throw new Error('the Entry read back does not match');
  const out = { testOnly: 'tamper fixture: an existing NFT Entry, NOT a deposit', entry, bump, pool: o.pool, asset: o.asset, paidBy: o['paid-by'], payGeneration: e.payGeneration, amount: String(amount), feeInPool: false };
  console.log(JSON.stringify(out));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(e => { console.error(String(e?.message ?? e)); process.exit(3); });
}
