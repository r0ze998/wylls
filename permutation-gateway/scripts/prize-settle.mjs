// The season's result and achievements, from the chain (local test chain,
// test tokens only):
//
//   node scripts/prize-settle.mjs --rpc URL --relay URL --herald URL --out DIR
//        (default)             after the game's Season is Ended: Tally every keep Province in chunks and Finalize
//                              (both permissionless: paid by a fresh key funded by the local airdrop), then the
//                              independent area check, the achievements ledger and the ESTIMATED split
//        --check               only the independent check: area per nation recounted from the Province accounts over
//                              RPC, against the pool's Finalize result and the herald's control file; sends nothing
//        --verify LEDGER.json  re-derive every ledger line from the transactions and accounts it cites
//        --set-shares --operator-seed-file F
//                              DEFERRED step: post the shares root and the ledger's sha256 (SetShares; operator only)
//        --ledger-file F       also write the ledger where the relay serves it (GET /f/prize/ledger)
//
// Decided rules: the winner is the nation holding the most provinces at
// the end; 80% of the fees are the prize. Everything else (tie rule,
// weights, fallbacks) is PROVISIONAL (src/frontier/prize-params.json) and
// every output says so. A split shown here is an ESTIMATE (試算), never a
// completed transfer.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { toHex } from '../client/src/bytes.mjs';
import { FrontierAddresses, ringOf } from '../client/src/frontier/addresses.mjs';
import { decodeAccount } from '../client/src/frontier/codec.mjs';
import { claimAmount, decodeEntry, decodePool, entryAddress, finalizeIx, leafHash, merkleTree, POOL_STATE, PRIZE_ERRORS, setSharesIx, SHARE_MODE, tallyIx } from '../client/src/frontier/prize.mjs';
import { compileMessage, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { Deriver, KINDS, scoreLines } from '../src/frontier/achievements.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const rpcUrl = opt('rpc', 'http://127.0.0.1:41010');
const relayUrl = opt('relay', 'http://127.0.0.1:41033');
const heraldUrl = opt('herald', 'http://127.0.0.1:41040');
for (const u of [rpcUrl, relayUrl, heraldUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local test chain only');
const outDir = opt('out', '.');
const PARAMS_FILE = new URL('../src/frontier/prize-params.json', import.meta.url);
const params = JSON.parse(readFileSync(PARAMS_FILE, 'utf8'));
const TALLY_CHUNK = 16;
const NATIONS = 6;

const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params_ = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params_ }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const account = async address => { const r = await rpc('getAccountInfo', [address, { encoding: 'base64' }]); return r?.value ? Uint8Array.from(Buffer.from(r.value.data[0], 'base64')) : null; };
const units = (v, decimals = 6) => { const s = String(v).padStart(decimals + 1, '0'); return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '') || '0'; };

/** Send `ixs` signed by `signers` (the first pays) and wait for the result; returns the signature. */
async function send(ixs, signers) {
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = compileMessage({ feePayer: signers[0].publicKey.toBase58(), recentBlockhash: value.blockhash, instructions: ixs });
  const wire = wireTransaction(message, Object.fromEntries(signers.map(k => [k.publicKey.toBase58(), signTalk(message, k)])));
  const sig = await rpc('sendTransaction', [Buffer.from(wire).toString('base64'), { encoding: 'base64', skipPreflight: true }]);
  for (let i = 0; i < 120; i++) {
    const st = (await rpc('getSignatureStatuses', [[sig]]))?.value?.[0];
    if (st?.err) {
      const code = st.err?.InstructionError?.[1]?.Custom;
      throw Object.assign(new Error(`transaction ${sig} failed: ${PRIZE_ERRORS[code] ?? JSON.stringify(st.err)}`), { code: PRIZE_ERRORS[code] ?? null, signature: sig });
    }
    if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus)) return sig;
    await sleep(250);
  }
  throw new Error(`transaction ${sig} has no result`);
}

// ------------------------------------------------------------------ the season

const info = await (await fetch(`${relayUrl}/f/season`)).json();
assert.ok(info.prize, 'this season has no prize pool');
const prize = info.prize;
const addresses = new FrontierAddresses({ programId: info.programId, seasonId: BigInt(info.seasonId) });
const seasonOf = async () => decodeAccount('Season', await account(addresses.season), { seasonId: addresses.seasonId });
const poolOf = async () => decodePool(await account(prize.pool));
const profile = 2;

/** Every opened keep Province, read from the chain: `[{address, p, q, province}]` in ring order. */
async function keepProvinces() {
  const fr = await account(addresses.frontier);
  const ringsOpened = fr[64] | (fr[65] << 8);
  const out = [];
  for (let p = -ringsOpened; p <= ringsOpened; p++) {
    for (let q = -ringsOpened; q <= ringsOpened; q++) {
      if (ringOf(p, q) >= ringsOpened) continue;
      const address = addresses.province(p, q);
      const data = await account(address);
      if (!data) continue;
      const province = decodeAccount('Province', data, { seasonId: addresses.seasonId, profile });
      if (Number(province.KEEP[0].TILE) !== 0xff) out.push({ address, p, q, province, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  return { provinces: out, provincesOpened: Buffer.from(fr).readUInt32LE(96) };
}

const areaOf = provinces => provinces.reduce((a, x) => { const h = Number(x.province.KEEP[0].HOLDER); if (h < NATIONS) a[h]++; return a; }, Array(NATIONS).fill(0));
const bellsOf = provinces => provinces.reduce((a, x) => x.province.TERRITORY_BELLS.map((v, i) => a[i] + BigInt(v)), Array(NATIONS).fill(0n));

/** The independent check: the chain's Province accounts against the pool and the herald. */
async function check() {
  const [season, pool, { provinces, provincesOpened }] = [await seasonOf(), await poolOf(), await keepProvinces()];
  const fromChain = areaOf(provinces);
  const top = Math.max(...fromChain);
  const largest = fromChain.flatMap((a, f) => (a === top && top > 0 ? [f] : []));
  const out = { seasonStatus: Number(season.STATUS), endBell: Number(season.END_BELL), keepProvinces: provinces.length, provincesOpened, areaFromProvinceAccounts: fromChain,
    largestAreaNations: largest, territoryBellsFromProvinceAccounts: bellsOf(provinces).map(String),
    notFinal: provinces.filter(x => Number(x.province.RESOLVED_NEXT) < Number(season.END_BELL)).map(x => [x.p, x.q]),
    pool: { state: ['open', 'final', 'shares'][pool.state], counted: pool.counted, expectedKeeps: pool.expectedKeeps, area: pool.area, winners: pool.state >= POOL_STATE.FINAL ? pool.winners : null } };
  out.poolMatchesChain = pool.counted === provinces.length && pool.area.every((a, f) => a === fromChain[f]);
  out.winnerIsLargestArea = pool.state >= POOL_STATE.FINAL ? pool.winners.every(w => largest.includes(w)) && (largest.length === 1 ? pool.winners.length === 1 : true) : null;
  // The herald's control file of the last bell (a second, off-chain reading of the same accounts).
  try {
    const h = createHerald({ base: heraldUrl });
    const c = await h.control();
    if (c.ok) {
      const area = Array(NATIONS).fill(0);
      for (const x of c.control.provinces) if (x.control < NATIONS && ringOf(x.p, x.q) >= 2) area[x.control]++;
      out.herald = { bell: c.control.bell, area, matchesChain: area.every((a, f) => a === fromChain[f]) };
    } else out.herald = { error: c.code ?? 'unavailable' };
  } catch (e) { out.herald = { error: String(e.message ?? e) }; }
  return { out, provinces, season, pool };
}

function printArea(c) {
  console.log('\nProvinces held per nation (keeps, from the Province accounts on chain):');
  console.log(`  nation   ${[...Array(NATIONS).keys()].map(f => String(f).padStart(4)).join('')}`);
  console.log(`  chain    ${c.areaFromProvinceAccounts.map(a => String(a).padStart(4)).join('')}`);
  console.log(`  pool     ${c.pool.area.map(a => String(a).padStart(4)).join('')}   (${c.pool.counted}/${c.pool.expectedKeeps} counted, ${c.pool.state})`);
  if (c.herald?.area) console.log(`  herald   ${c.herald.area.map(a => String(a).padStart(4)).join('')}   (control file, bell ${c.herald.bell})`);
  console.log(`  pool = chain: ${c.poolMatchesChain}; herald = chain: ${c.herald?.matchesChain ?? 'n/a'}; winner(s): ${c.pool.winners === null ? 'not final' : c.pool.winners.join(', ')}`);
}

const io = {
  account,
  transaction: async sig => { const t = await rpc('getTransaction', [sig, { encoding: 'json' }]); return t ? { err: t.meta?.err ?? null, slot: t.slot, logs: t.meta?.logMessages ?? [] } : null; },
  signatures: async (address, limit) => (await rpc('getSignaturesForAddress', [address, { limit }])).map(s => s.signature),
  keep: async (p, q) => { const r = await fetch(`${heraldUrl}/h/keep/${p},${q}.json`); return r.ok ? r.json() : null; },
};
const deriver = new Deriver({ io, addresses, profile });

// ------------------------------------------------------------------ --verify

if (opt('verify')) {
  const ledger = JSON.parse(readFileSync(opt('verify'), 'utf8'));
  let bad = 0;
  for (const [i, line] of ledger.lines.entries()) {
    const v = await deriver.verifyLine(line);
    if (!v.ok) bad++;
    console.log(`${v.ok ? 'ok  ' : 'FAIL'} ${String(i).padStart(3)} ${line.kind.padEnd(13)} (${line.province.p},${line.province.q}) ${line.wallet ?? '-'} ${line.quantity} ${line.unit}${v.ok ? '' : `: ${v.problems.join('; ')}`}`);
  }
  console.log(`\n${ledger.lines.length - bad}/${ledger.lines.length} lines re-derived from their transactions and accounts`);
  process.exit(bad ? 1 : 0);
}

// ------------------------------------------------------------------ --check

if (flag('check')) {
  const { out } = await check();
  printArea(out);
  console.log(json(out));
  process.exit(out.poolMatchesChain && out.herald?.matchesChain !== false && out.winnerIsLargestArea !== false ? 0 : 1);
}

// ------------------------------------------------------------------ tally, finalize

mkdirSync(outDir, { recursive: true });
const transcript = { testAssetsOnly: true, provisional: true, provisionalRules: params.provisionalRules, season: info.seasonId, programId: info.programId, prize, steps: [] };
const step = (name, v) => { transcript.steps.push({ name, ...v }); console.log(name, json(v).slice(0, 600)); };

let season = await seasonOf();
assert.equal(Number(season.STATUS), 4, `the game's Season is not Ended (status ${season.STATUS}): nothing can be counted`);
let pool = await poolOf();
const { provinces } = await keepProvinces();
if (pool.state === POOL_STATE.OPEN) {
  // Permissionless: a key nobody knows, funded by the local airdrop.
  const anyone = Keypair.fromSeed(randomBytes(32));
  await rpc('requestAirdrop', [anyone.publicKey.toBase58(), 1_000_000_000]);
  for (let i = 0; i < 40 && !(await rpc('getBalance', [anyone.publicKey.toBase58()])).value; i++) await sleep(250);
  for (let i = 0; i < provinces.length; i += TALLY_CHUNK) {
    const chunk = provinces.slice(i, i + TALLY_CHUNK);
    const signature = await send([tallyIx({ prize, season: addresses.season, provinces: chunk.map(x => x.address) })], [anyone]);
    step('tally', { signature, provinces: chunk.map(x => [x.p, x.q]), by: anyone.publicKey.toBase58() });
  }
  const signature = await send([finalizeIx({ prize, frontier: addresses.frontier })], [anyone]);
  step('finalize', { signature, by: anyone.publicKey.toBase58() });
  pool = await poolOf();
}
const checked = await check();
transcript.check = checked.out;
printArea(checked.out);
assert.ok(checked.out.poolMatchesChain, 'the pool\'s tally is not the chain\'s');

// ------------------------------------------------------------------ the achievements ledger

const lines = await deriver.lines(provinces);
// The players: every Citizen named by a line, and every wallet with an Entry among them.
const wallets = [...new Set(lines.map(l => l.wallet).filter(Boolean))];
const paid = new Set();
const members = [];
for (const w of wallets) {
  const e = decodeEntry(await account(entryAddress(prize.program, prize.pool, w)));
  if (e) paid.add(w);
  members.push({ wallet: w, nation: lines.find(l => l.wallet === w && l.kind === 'capture')?.detail.ownerNation ?? lines.find(l => l.wallet === w)?.detail.supplierNation, paid: !!e });
}
const extra = opt('members-file') ? JSON.parse(readFileSync(opt('members-file'), 'utf8')) : [];
for (const w of extra) {
  if (members.some(m => m.wallet === w)) continue;
  const c = await account(addresses.citizen(w));
  const e = decodeEntry(await account(entryAddress(prize.program, prize.pool, w)));
  if (e) paid.add(w);
  if (c) members.push({ wallet: w, nation: Number(decodeAccount('Citizen', c, { seasonId: addresses.seasonId, profile }).FACTION), paid: !!e });
}
const scored = scoreLines(lines, { params, winners: pool.winners, paid, members });
const totals = Array(NATIONS).fill(0n);
for (const v of scored.points.values()) totals[v.nation] += BigInt(v.points);
const shareNations = totals.filter(t => t > 0n).length;
const leaves = [...scored.points].map(([wallet, v]) => ({ wallet, ...v, leaf: leafHash(prize.pool, wallet, v.nation, BigInt(v.points)) }));
const tree = merkleTree(leaves.map(l => l.leaf));
const estimatePool = { ...pool, mode: scored.mode === 'refund' ? SHARE_MODE.REFUND : SHARE_MODE.SHARES, shareNations, totalPoints: totals };
const ledger = {
  version: 1, testAssetsOnly: true, token: 'test USDC (a local test mint; no value)',
  provisional: true, provisionalRules: params.provisionalRules, decided: params.decided, paramsFile: 'permutation-gateway/src/frontier/prize-params.json',
  paramsHash: createHash('sha256').update(readFileSync(PARAMS_FILE)).digest('hex'), poolParamsHash: toHex(pool.paramsHash),
  season: info.seasonId, programId: info.programId, prize, endBell: Number(season.END_BELL),
  result: { area: pool.area, territoryBells: pool.bells.map(String), winners: pool.winners, state: ['open', 'final', 'shares'][pool.state] },
  kinds: KINDS, weights: params.contribution,
  lines: scored.lines,
  shares: { mode: scored.mode, totalPoints: totals.map(String), root: toHex(tree.root),
    members: leaves.map(l => ({ wallet: l.wallet, nation: l.nation, points: l.points, proof: tree.proof(l.leaf).map(toHex) })) },
  estimate: { label: 'ESTIMATE (試算): not a completed transfer; the weights and fallbacks are provisional', prize: String(pool.prize), ops: String(pool.ops),
    split: leaves.map(l => ({ wallet: l.wallet, nation: l.nation, points: l.points, amount: String(claimAmount(estimatePool, { points: BigInt(l.points), nation: l.nation }) ?? 0n) })) },
};
const ledgerText = `${json(ledger)}\n`;
const ledgerHash = createHash('sha256').update(ledgerText).digest();
writeFileSync(path.join(outDir, 'ledger.json'), ledgerText);
if (opt('ledger-file')) writeFileSync(opt('ledger-file'), ledgerText);
transcript.ledger = { file: 'ledger.json', sha256: ledgerHash.toString('hex'), lines: lines.length, root: ledger.shares.root, mode: scored.mode };

console.log('\nAchievements (recomputed from the chain; every line cites its transactions):');
for (const [k, v] of Object.entries(KINDS)) console.log(`  ${k.padEnd(14)} ${v.derivable ? 'derivable' : `not derivable: ${v.reason} (missing: ${v.missingRecord})`}`);
console.log('\n  kind           province   nation  quantity         bell  points  player (wallet)                               signature');
for (const l of scored.lines) {
  console.log(`  ${l.kind.padEnd(14)} ${`(${l.province.p},${l.province.q})`.padEnd(10)} ${String(l.nation).padEnd(7)} ${`${l.quantity} ${l.unit}`.padEnd(16)} ${String(l.bell).padEnd(5)} ${String(l.points).padEnd(7)} ${(l.wallet ?? '-').padEnd(45)} ${(l.signatures[0] ?? '-').slice(0, 20)}…${l.eligible ? '' : '  (no points: not a paid member of a winning nation)'}`);
}
console.log(`\n${ledger.estimate.label}`);
console.log(`  prize pool ${units(pool.prize)} test USDC (operator ${units(pool.ops)}); mode ${scored.mode}`);
for (const s of ledger.estimate.split) console.log(`  ${s.wallet}  nation ${s.nation}  ${s.points} points  ≈ ${units(s.amount)} test USDC`);
console.log(`\nPROVISIONAL rules in force: ${params.provisionalRules.map((r, i) => `\n  ${i + 1}. ${r}`).join('')}`);

// ------------------------------------------------------------------ SetShares (deferred step)

if (flag('set-shares')) {
  assert.ok(opt('operator-seed-file'), '--set-shares needs --operator-seed-file (the season authority)');
  const operator = Keypair.fromSeed(Buffer.from(readFileSync(opt('operator-seed-file'), 'utf8').trim(), 'hex'));
  assert.equal(operator.publicKey.toBase58(), pool.operator, 'that key is not the pool\'s operator');
  if (pool.state === POOL_STATE.FINAL) {
    const signature = await send([setSharesIx({ prize, operator: operator.publicKey.toBase58(), mode: estimatePool.mode, totals, root: scored.mode === 'refund' ? new Uint8Array(32) : tree.root, ledgerHash })], [operator]);
    step('set-shares', { signature, mode: scored.mode, root: ledger.shares.root, ledgerSha256: ledgerHash.toString('hex') });
  } else step('set-shares', { skipped: `the pool is ${['open', 'final', 'shares'][pool.state]}` });
}
transcript.poolAfter = await poolOf().then(p => ({ state: ['open', 'final', 'shares'][p.state], area: p.area, winners: p.winners, prize: String(p.prize), ops: String(p.ops), entries: p.entries,
  operator: p.operator, sharesRoot: toHex(p.sharesRoot), ledgerHash: toHex(p.ledgerHash) }));
writeFileSync(path.join(outDir, 'settle.json'), `${json(transcript)}\n`);
console.log(`\nwrote ${path.join(outDir, 'ledger.json')} and ${path.join(outDir, 'settle.json')}`);
