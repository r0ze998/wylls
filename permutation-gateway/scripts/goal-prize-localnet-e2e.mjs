#!/usr/bin/env node
// World goals' prize pool end to end on a LOCALNET (design record docs/design/win-conditions/01-proposal.ja.md §7,
// §10.1): the `scripts/build-prize.sh --features goals` SBF artefact deployed on frontier-localnet (LiteSVM behind
// real JSON-RPC, 400-ms slots, a scaled clock), test USDC minted by a local mint, real signed transactions.
//
//   post a goal → buy passes → [stand-in] flag keeps held → Achieve refused, then achieved on chain → the ledger
//   (goal-prize.mjs `goalShares`, PR #198's shapes) → SetGoalShares → claims paid in test USDC → double claim refused →
//   wrong members refused (another nation, too recent, no pass, the operator's AI resident, forged points) → the claim
//   window ends → GoalSweep → the operator's part → every token accounted for. Compute units of each instruction.
//
// The game program is NOT run: its Season (continuous, running), Provinces and Citizens are written with
// frontier_setAccount (--allow-tamper) at their real addresses with frontier-abi layouts, owned by a stand-in game
// program id. TEST keys only, generated in memory and never written; loopback only; no devnet, no SOL of value.
//
//   node scripts/goal-prize-localnet-e2e.mjs [--port 41640] [--evidence out.json]
//   env FRONTIER_LOCALNET_BIN (default <repo>/target/release/frontier-localnet), PRIZE_GOALS_SO (default
//   permutation-prize/target/deploy-goals/permutation_prize.so). Exit 0 only when every check passed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { LAYOUTS } from '../client/src/frontier/abi-v2-layouts.mjs';
import { excludeIx, PRIZE_ERRORS } from '../client/src/frontier/prize.mjs';
import {
  achieveIx, buyPassIx, decodeGoal, decodeGoalPool, decodePass, goalAddress, goalClaimIx, goalPoolAddresses, goalShares, goalSweepIx,
  goalWithdrawOpsIx, initGoalPoolIx, passAddress, postGoalIx, receiptAddress, RECOMMENDED, setGoalSharesIx,
} from '../client/src/frontier/goal-prize.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const PORT = Number(arg('--port', process.env.GOAL_E2E_PORT ?? 41640));
const EVIDENCE = arg('--evidence', null);
const BIN = process.env.FRONTIER_LOCALNET_BIN || `${ROOT}target/release/frontier-localnet`;
const SO = process.env.PRIZE_GOALS_SO || `${ROOT}permutation-prize/target/deploy-goals/permutation_prize.so`;
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SID = 9n;
const BELL = 600;
const NATION = 2;

const log = (...a) => console.log('[goal-e2e]', ...a);
const results = { checks: [], cu: {}, txs: {} };
function check(name, ok, detail = '') {
  results.checks.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

// ------------------------------------------------------------------ layouts (frontier-abi v2, generated vectors)
const acct = kind => LAYOUTS.accounts.find(a => a.kind === kind);
const fld = (kind, name) => acct(kind).fields.find(f => f.name === name).off;
const rec = (name, f) => LAYOUTS.records.find(r => r.name === name).fields.find(x => x.name === f).off;
const S = { size: acct('Season').size, magic: acct('Season').magic, SEASON_ID: fld('Season', 'SEASON_ID'), STATUS: fld('Season', 'STATUS'), AUTHORITY: fld('Season', 'AUTHORITY'),
  JOIN_GATE: fld('Season', 'JOIN_GATE'), BELL_SECS: fld('Season', 'BELL_SECS'), GENESIS_TS: fld('Season', 'GENESIS_TS'),
  CONTINUOUS: fld('Season', 'CONQUEST_PARAMS') + rec('ConquestParams', 'CONTINUOUS') };
const P = { size: acct('Province').size, magic: acct('Province').magic, SEASON_ID: fld('Province', 'SEASON_ID'), P: fld('Province', 'P'), Q: fld('Province', 'Q'),
  RESOLVED_NEXT: fld('Province', 'RESOLVED_NEXT'), KEEP: fld('Province', 'KEEP'), TILE: rec('Keep', 'TILE'), HOLDER: rec('Keep', 'HOLDER'), SINCE: rec('Keep', 'SINCE_BELL') };
const C = { size: acct('Citizen').size, magic: acct('Citizen').magic, SEASON_ID: fld('Citizen', 'SEASON_ID'), WALLET: fld('Citizen', 'WALLET'),
  FACTION: fld('Citizen', 'FACTION'), JOIN_BELL: fld('Citizen', 'JOIN_BELL') };
const STATUS_RUNNING = 2;

// ------------------------------------------------------------------ the node
async function portFree(p) {
  return new Promise(res => { const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true))).listen(p, '127.0.0.1'); });
}
let child = null;
const stop = () => { if (child && child.exitCode === null) child.kill('SIGINT'); };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

const URL_ = `http://127.0.0.1:${PORT}`;
async function rpc(method, params = []) {
  const r = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const status = () => rpc('frontier_status');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setAccount(address, data, owner) {
  await rpc('frontier_setAccount', [address, { lamports: 1_000_000_000, data: [Buffer.from(data).toString('base64'), 'base64'], owner, executable: false }]);
}

// ------------------------------------------------------------------ transactions
let conn;
const toIx = ix => new TransactionInstruction({ programId: new PublicKey(ix.programId), data: Buffer.from(ix.data),
  keys: ix.keys.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable })) });

/** Sends and waits; → {sig, err, cu, logs}. */
async function send(ixs, signers, label) {
  const tx = new Transaction();
  for (const ix of ixs) tx.add(ix instanceof TransactionInstruction ? ix : toIx(ix));
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 100; i++) {
    const st = (await rpc('getSignatureStatuses', [[sig]])).value[0];
    if (st && (st.err || st.confirmationStatus)) break;
    await sleep(150);
  }
  const t = await rpc('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  const out = { sig, err: t?.meta?.err ?? null, cu: t?.meta?.computeUnitsConsumed ?? null, logs: t?.meta?.logMessages ?? [] };
  if (label) { results.txs[label] = { sig, err: out.err, cu: out.cu }; if (!out.err && out.cu !== null) results.cu[label] = out.cu; }
  return out;
}
const customOf = r => r.err?.InstructionError?.[1]?.Custom ?? null;
async function ok(ixs, signers, label) {
  const r = await send(ixs, signers, label);
  check(`${label} lands`, !r.err, r.err ? `${JSON.stringify(r.err)} ${r.logs.slice(-3).join(' | ')}` : `${r.cu} CU`);
  return r;
}
async function refused(ixs, signers, label, name) {
  const r = await send(ixs, signers);
  const c = customOf(r);
  check(`${label} refused with ${name}`, c !== null && PRIZE_ERRORS[c] === name, r.err ? `got ${c === null ? JSON.stringify(r.err) : PRIZE_ERRORS[c] ?? c}` : 'it landed');
  return r;
}
const data = async a => { const i = await conn.getAccountInfo(new PublicKey(a)); return i ? new Uint8Array(i.data) : null; };
const tokenBal = async a => { const d = await data(a); return d ? Buffer.from(d).readBigUInt64LE(64) : 0n; };

// ------------------------------------------------------------------ SPL test mint
function splIx(programId, keys, d) { return new TransactionInstruction({ programId, keys, data: Buffer.from(d) }); }
async function createMint(operator) {
  const mint = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(82);
  await ok([SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: 82, programId: TOKEN }),
    splIx(TOKEN, [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], [20, 6, ...operator.publicKey.toBytes(), 0])], [operator, mint], 'test mint');
  return mint.publicKey;
}
async function tokenAccount(payer, mint, owner, amount) {
  const ta = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(165);
  const ixs = [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: ta.publicKey, lamports: rent, space: 165, programId: TOKEN }),
    splIx(TOKEN, [{ pubkey: ta.publicKey, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }], [18, ...owner.toBytes()])];
  if (amount > 0n) {
    const d = Buffer.alloc(9); d[0] = 7; d.writeBigUInt64LE(amount, 1);
    ixs.push(splIx(TOKEN, [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: ta.publicKey, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }], d));
  }
  const r = await send(ixs, [payer, ta]);
  if (r.err) throw new Error(`token account: ${JSON.stringify(r.err)}`);
  return ta.publicKey.toBase58();
}

// ------------------------------------------------------------------ stand-in game accounts
function le(n, bytes) { const b = Buffer.alloc(bytes); if (bytes === 8) b.writeBigInt64LE(BigInt(n)); else if (bytes === 4) b.writeUInt32LE(n >>> 0); else b.writeInt16LE(n); return b; }
function seasonData({ authority, gate, genesisTs }) {
  const d = Buffer.alloc(S.size);
  d.write(S.magic, 0, 'latin1'); le(SID, 8).copy(d, S.SEASON_ID); d[S.STATUS] = STATUS_RUNNING;
  Buffer.from(new PublicKey(authority).toBytes()).copy(d, S.AUTHORITY); Buffer.from(new PublicKey(gate).toBytes()).copy(d, S.JOIN_GATE);
  le(BELL, 4).copy(d, S.BELL_SECS); le(genesisTs, 8).copy(d, S.GENESIS_TS); d[S.CONTINUOUS] = 1;
  return d;
}
function provinceData({ p, q, holder, since, resolvedNext }) {
  const d = Buffer.alloc(P.size);
  d.write(P.magic, 0, 'latin1'); le(SID, 8).copy(d, P.SEASON_ID); le(p, 2).copy(d, P.P); le(q, 2).copy(d, P.Q);
  le(resolvedNext, 4).copy(d, P.RESOLVED_NEXT); d[P.KEEP + P.TILE] = 30; d[P.KEEP + P.HOLDER] = holder; le(since, 4).copy(d, P.KEEP + P.SINCE);
  return d;
}
function citizenData({ wallet, faction, joinBell }) {
  const d = Buffer.alloc(C.size);
  d.write(C.magic, 0, 'latin1'); le(SID, 8).copy(d, C.SEASON_ID); Buffer.from(new PublicKey(wallet).toBytes()).copy(d, C.WALLET);
  d[C.FACTION] = faction; le(joinBell, 4).copy(d, C.JOIN_BELL);
  return d;
}

// ------------------------------------------------------------------ the run
async function main() {
  if (!existsSync(BIN)) throw new Error(`${BIN} missing: cargo build --release -p localnet --bin frontier-localnet (frontier-node)`);
  const so = readFileSync(SO);
  if (!so.includes(Buffer.from('PRZ_GOALS_TEST_USDC_BUILD'))) throw new Error(`${SO}: not a --features goals build (marker missing)`);
  for (const p of [PORT, PORT + 1]) if (!(await portFree(p))) throw new Error(`port ${p} is in use`);
  const prizeId = new PublicKey(createHash('sha256').update('goal-prize-localnet-e2e program').digest()).toBase58();
  const gameId = new PublicKey(createHash('sha256').update('goal-prize-localnet-e2e stand-in game').digest()).toBase58();
  const env = { ...process.env }; delete env.FRONTIER_CONTROL_TOKEN;
  child = spawn(BIN, ['--port', String(PORT), '--ws-port', String(PORT + 1), '--allow-tamper', '--scale', '100', '--program', `${prizeId}=${SO}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', b => process.stderr.write(`[localnet] ${b}`));
  for (let i = 0; ; i++) { try { await rpc('getSlot'); break; } catch { if (i > 100) throw new Error('localnet did not start'); await sleep(100); } }
  conn = new Connection(URL_, 'confirmed');
  results.node = { port: PORT, so: SO, soSha256: createHash('sha256').update(so).digest('hex'), soLen: so.length, prizeId, gameId };
  log('localnet up', results.node);

  const fund = async kp => { await rpc('requestAirdrop', [kp.publicKey.toBase58(), 20_000_000_000]); };
  const operator = Keypair.generate(), gate = Keypair.generate();
  await fund(operator); await fund(gate);
  const mint = (await createMint(operator)).toBase58();
  const fa = new FrontierAddresses({ programId: gameId, seasonId: SID });
  const now0 = (await status()).unixTimestamp;
  const genesisTs = now0 - 400 * BELL;
  const bellNow = async () => Math.floor(((await status()).unixTimestamp - genesisTs) / BELL);
  await setAccount(fa.season, seasonData({ authority: operator.publicKey.toBase58(), gate: gate.publicKey.toBase58(), genesisTs }), gameId);
  const gp = goalPoolAddresses({ prizeProgram: prizeId, gameProgram: gameId, seasonId: SID, mint });

  // Members: nation 2 a, b, d (joins late, below), e (operator AI), f (no pass); nation 1 c.
  const mk = async (name, nation, joinBell) => {
    const kp = Keypair.generate(); await fund(kp);
    const token = await tokenAccount(operator, new PublicKey(mint), kp.publicKey, 100_000_000n);
    const citizen = fa.citizen(kp.publicKey.toBase58());
    await setAccount(citizen, citizenData({ wallet: kp.publicKey.toBase58(), faction: nation, joinBell }), gameId);
    return { name, kp, wallet: kp.publicKey.toBase58(), token, citizen, nation, joinBell };
  };
  const a = await mk('a', NATION, 0), b = await mk('b', NATION, 0), c = await mk('c', 1, 0), d = await mk('d', NATION, 0);
  const e = await mk('e', NATION, 0), f = await mk('f', NATION, 0);

  // 1. InitGoalPool (the recommended values, a 10-minute claim window for the run).
  const params = { ...RECOMMENDED, claimSecs: 600 };
  await ok([initGoalPoolIx({ gp, operator: operator.publicKey.toBase58(), season: fa.season, params, paramsHash: createHash('sha256').update('goal-prize-localnet-e2e params').digest() })], [operator], 'InitGoalPool');

  // 2. Passes; the operator's AI resident is marked by the join gate and refused.
  for (const m of [a, b, c, d]) await ok([buyPassIx({ gp, wallet: m.wallet, walletToken: m.token })], [m.kp], m === a ? 'BuyPass (new)' : `BuyPass ${m.name}`);
  await ok([buyPassIx({ gp, wallet: a.wallet, walletToken: a.token })], [a.kp], 'BuyPass (renew)');
  const prizeRef = { program: prizeId, game: gameId, seasonId: String(SID) };
  await ok([excludeIx({ prize: prizeRef, gate: gate.publicKey.toBase58(), payer: gate.publicKey.toBase58(), season: fa.season, wallet: e.wallet })], [gate], 'ExcludeWallet');
  await refused([buyPassIx({ gp, wallet: e.wallet, walletToken: e.token })], [e.kp], 'BuyPass by the operator AI resident', 'OperatorMember');
  let pool = decodeGoalPool(await data(gp.gpool));
  check('5 passes: 125 test USDC in, 25 the operator\'s, 100 to hegemony', pool.collected === 125_000_000n && pool.ops === 25_000_000n && pool.treasury[0] === 100_000_000n,
    `collected ${pool.collected} ops ${pool.ops} treasury ${pool.treasury}`);

  // 3. A hegemony goal: 6 flag keeps (one on ring 40: no ring limit), need 3, held 144 bells, pays 30 %.
  const flags = [{ p: 2, q: 0 }, { p: 0, q: 2 }, { p: -2, q: 0 }, { p: 3, q: -1 }, { p: -1, q: 3 }, { p: 40, q: -10 }];
  const postingHash = createHash('sha256').update(JSON.stringify({ kind: 'flag-keeps', ruleset: 'flag-keeps-v1', round: 1, flags })).digest();
  await ok([postGoalIx({ gp, operator: operator.publicKey.toBase58(), season: fa.season, kind: 0, round: 1, need: 3, holdBells: 144, payoutBps: 3000, postingHash, flags })],
    [operator], 'PostGoal (hegemony, 6 flags)');
  const goal = goalAddress(prizeId, gp.gpool, 0, 1);
  const posted = decodeGoal(await data(goal)).postedBell;
  const holders = [[NATION, posted - 20], [NATION, posted - 5], [NATION, posted + 2], [3, 0], [255, 0], [5, 0]];
  const writeKeeps = async resolvedNext => {
    for (const [i, fl] of flags.entries()) await setAccount(fa.province(fl.p, fl.q), provinceData({ ...fl, holder: holders[i][0], since: holders[i][1], resolvedNext }), gameId);
  };
  await writeKeeps(await bellNow());
  const provinces = flags.map(fl => fa.province(fl.p, fl.q));
  await refused([achieveIx({ gp, goal, season: fa.season, provinces })], [a.kp], 'Achieve before the hold time', 'NotAchieved');

  // 4. Time passes (the clock sped up): 144 bells after the third keep's posting-or-capture bell.
  const target = posted + 2 + 144;
  await rpc('frontier_setScale', [20_000]);
  while ((await bellNow()) < target + 2) await sleep(200);
  await rpc('frontier_setScale', [100]);
  await sleep(600);
  await writeKeeps(await bellNow());
  // verify-pr202 adversarial (SBF): the goal pool in the goal's seat (both 448 B), and the flags out of posted order.
  await refused([achieveIx({ gp, goal: gp.gpool, season: fa.season, provinces })], [c.kp], 'Achieve with the goal pool as the goal', 'BadAccount');
  await refused([achieveIx({ gp, goal, season: fa.season, provinces: [provinces[1], provinces[0], ...provinces.slice(2)] })], [c.kp], 'Achieve with the flags out of order', 'BadAccount');
  await ok([achieveIx({ gp, goal, season: fa.season, provinces })], [c.kp], 'Achieve (6 flag provinces)');
  const g = decodeGoal(await data(goal));
  check('the on-chain judge names nation 2 at the third keep\'s hold bell', g.state === 2 && g.winnersMask === 1 << NATION && g.achievedBell === target,
    `state ${g.state} winners ${g.winners} bell ${g.achievedBell} (want ${target})`);
  check('payout = 30 % of hegemony\'s 100', g.payout === 30_000_000n, String(g.payout));
  await refused([achieveIx({ gp, goal, season: fa.season, provinces })], [a.kp], 'a second Achieve', 'WrongState');

  // d joined 10 bells before the achievement (after the posting): less than 144 bells of membership.
  d.joinBell = g.achievedBell - 10;
  await setAccount(d.citizen, citizenData({ wallet: d.wallet, faction: NATION, joinBell: d.joinBell }), gameId);

  // 5. The ledger (PR #198 shapes): points per wallet, the members list, passes read from the chain.
  const points = new Map([[a.wallet, { nation: NATION, points: 30 }], [b.wallet, { nation: NATION, points: 10 }], [d.wallet, { nation: NATION, points: 5 }],
    [e.wallet, { nation: NATION, points: 20 }], [f.wallet, { nation: NATION, points: 5 }]]);
  const members = [a, b, c, d, e, f].map(m => ({ wallet: m.wallet, nation: m.nation, joinBell: m.joinBell, operator: m === e }));
  const passes = new Map();
  for (const m of [a, b, c, d, e, f]) passes.set(m.wallet, decodePass(await data(passAddress(prizeId, gp.gpool, m.wallet))));
  pool = decodeGoalPool(await data(gp.gpool));
  const shares = goalShares({ goal: { ...g, address: goal }, points, members, passes, rules: { memberBells: pool.memberBells, minPayout: pool.minPayout } });
  results.ledger = { ...shares.ledger, ledgerHash: Buffer.from(shares.ledgerHash).toString('hex') };
  check('the ledger pays a and b only (d too recent, e operator AI, f no pass)', shares.rows.filter(r => r.amount > 0n).map(r => r.wallet).sort().join() === [a.wallet, b.wallet].sort().join(),
    shares.rows.map(r => `${[a, b, c, d, e, f].find(m => m.wallet === r.wallet).name}:${r.why ?? r.amount}`).join(' '));
  await ok([setGoalSharesIx({ gp, operator: operator.publicKey.toBase58(), goal, ...shares.setShares })], [operator], 'SetGoalShares');

  // 6. Claims.
  const claim = (m, nation, pts, proof = []) => goalClaimIx({ gp, goal, wallet: m.wallet, citizen: m.citizen, nation, points: pts, proof, dest: m.token });
  const amt = Object.fromEntries(shares.rows.map(r => [r.wallet, r.amount]));
  const before = await tokenBal(a.token);
  await ok([claim(a, NATION, 30n, shares.proofs.get(a.wallet))], [a.kp], 'GoalClaim');
  check('a received its share in test USDC', (await tokenBal(a.token)) - before === amt[a.wallet], `${(await tokenBal(a.token)) - before} want ${amt[a.wallet]}`);
  await refused([claim(a, NATION, 30n, shares.proofs.get(a.wallet))], [a.kp], 'a second claim by a', 'AlreadyClaimed');
  await refused([claim(b, NATION, 11n, shares.proofs.get(b.wallet))], [b.kp], 'b with forged points', 'BadProof');
  await refused([claim(c, NATION, 30n, shares.proofs.get(a.wallet))], [c.kp], 'c (nation 1) with a\'s leaf', 'NotWinner');
  await refused([claim(d, NATION, 5n)], [d.kp], 'd (joined less than 144 bells before)', 'MemberTooRecent');
  await refused([claim(f, NATION, 5n)], [f.kp], 'f (no pass)', 'PassNotValid');
  await refused([claim(e, NATION, 20n)], [e.kp], 'e (the operator\'s AI resident)', 'OperatorMember');
  // verify-pr202 adversarial (SBF): e dodges its operator-member mark with a's (empty) exclusion address.
  const dodge = claim(e, NATION, 20n);
  dodge.keys[6] = { ...dodge.keys[6], pubkey: claim(a, NATION, 30n).keys[6].pubkey };
  await refused([dodge], [e.kp], 'e with a swapped exclusion account', 'BadAccount');
  // verify-pr202 adversarial (SBF): a griefer pre-funds b's receipt PDA; b's claim must still land, once.
  const rb = receiptAddress(prizeId, goal, b.wallet);
  const grief = await send([SystemProgram.transfer({ fromPubkey: c.kp.publicKey, toPubkey: new PublicKey(rb), lamports: 1_000_000 })], [c.kp]);
  check('a griefer pre-funded b\'s receipt PDA', !grief.err, JSON.stringify(grief.err));
  await ok([claim(b, NATION, 10n, shares.proofs.get(b.wallet))], [b.kp], 'GoalClaim b');
  await refused([claim(b, NATION, 10n, shares.proofs.get(b.wallet))], [b.kp], 'a second claim by b (pre-funded receipt)', 'AlreadyClaimed');

  // 7. The claim window ends; the unclaimed rest returns to hegemony.
  await refused([goalSweepIx({ gp, goal })], [c.kp], 'GoalSweep inside the claim window', 'ClaimWindowOpen');
  const gNow = decodeGoal(await data(goal));
  await rpc('frontier_setScale', [5_000]);
  while ((await status()).unixTimestamp <= gNow.deadlineTs + 5) await sleep(200);
  await rpc('frontier_setScale', [100]);
  await refused([claim(d, NATION, 5n)], [d.kp], 'a claim after the window', 'ClaimClosed');
  const t0 = decodeGoalPool(await data(gp.gpool)).treasury[0];
  await ok([goalSweepIx({ gp, goal })], [c.kp], 'GoalSweep');
  const after = decodeGoalPool(await data(gp.gpool));
  const rest = g.payout - amt[a.wallet] - amt[b.wallet];
  check('the sweep returned the unclaimed rest (dust) to hegemony', after.treasury[0] - t0 === rest && rest === shares.returned, `+${after.treasury[0] - t0} (rest ${rest})`);
  check('the goal is closed', decodeGoal(await data(goal)).state === 4);

  // 8. The operator's part, then every token.
  const opsTo = await tokenAccount(operator, new PublicKey(mint), operator.publicKey, 0n);
  // verify-pr202 adversarial (SBF): a stranger in the operator's seat cannot take the operator's part.
  const cTo = await tokenAccount(operator, new PublicKey(mint), c.kp.publicKey, 0n);
  await refused([goalWithdrawOpsIx({ gp, operator: c.wallet, dest: cTo })], [c.kp], 'GoalWithdrawOps by a stranger', 'NotOperator');
  await ok([goalWithdrawOpsIx({ gp, operator: operator.publicKey.toBase58(), dest: opsTo })], [operator], 'GoalWithdrawOps');
  check('the operator took 20 % of 5 passes', (await tokenBal(opsTo)) === 25_000_000n, String(await tokenBal(opsTo)));
  const fin = decodeGoalPool(await data(gp.gpool));
  const vault = await tokenBal(gp.vault);
  check('the vault holds exactly the treasuries', vault === fin.treasury.reduce((s, x) => s + x, 0n), `vault ${vault} treasuries ${fin.treasury}`);
  check('in = treasuries + paid + operator', fin.collected === fin.treasury.reduce((s, x) => s + x, 0n) + fin.paid + fin.ops, `${fin.collected}`);
  results.final = { vault: String(vault), treasury: fin.treasury.map(String), paid: String(fin.paid), returned: String(fin.returned), ops: String(fin.ops) };

  // 9. Round 2 is postable at once (the world goes on).
  await ok([postGoalIx({ gp, operator: operator.publicKey.toBase58(), season: fa.season, kind: 0, round: 2, need: 3, holdBells: 144, payoutBps: 3000, postingHash, flags })], [operator], 'PostGoal round 2');
}

try {
  await main();
} catch (err) {
  check('the run completed', false, err.stack ?? err);
} finally {
  stop();
  const failed = results.checks.filter(c => !c.ok).length;
  results.summary = { checks: results.checks.length, failed };
  if (EVIDENCE) writeFileSync(EVIDENCE, JSON.stringify(results, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  log(`${results.checks.length} checks, ${failed} failed; CU`, results.cu);
}
