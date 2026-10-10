// One world, three kinds of member (a disposable local stack; test tokens
// only; no LLM): a gated conquest season with a prize pool in which
//
//   * a person's dev wallet joins by paying the entry fee over x402 (the real browser modules), places a home and builds;
//   * the stack's script bots and the AI fleet (frontier-bots, here without a brain) join through POST /f/join with
//     invites the operator's stack minted, never paying;
//   * a wallet with neither a payment nor an invite cannot join: the relay refuses it and the game refuses it on chain.
//
// It then reads what each group did (each fleet's own /metrics: accepted Join, PlaceHome, Build, Train, Muster), the pool
// (one entry: 20 prize, 5 operator) and the chain's members: every Citizen without an Entry is an AI citizen or a script
// bot and is not prize-eligible; the eligible set is the one payer.
//
//   PRIZE_MIX_URL=http://127.0.0.1:41192 PRIZE_MIX_RPC=http://127.0.0.1:41162 PRIZE_MIX_BOTS=http://127.0.0.1:41189 \
//   PRIZE_MIX_AI=http://127.0.0.1:41190 PRIZE_MIX_UNTIL_TURN=24 PRIZE_MIX_OUT=.local/prize-e2e/mixed1 \
//   node permutation-gateway/scripts/prize-mixed-check.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { bellAt } from '../../permutation-server/web/frontier/clock.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { encode as base58 } from '../client/src/base58.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { decodeEntry, ENTRY_SIZE, joinViaX402, x402Encode } from '../client/src/frontier/prize.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { PLAYER_KINDS, AREA_NOTE } from '../src/frontier/achievements.mjs';

const env = (k, d) => process.env[k] ?? d;
const base = env('PRIZE_MIX_URL', 'http://127.0.0.1:41192');
const rpcUrl = env('PRIZE_MIX_RPC', 'http://127.0.0.1:41162');
const controls = { scriptBots: env('PRIZE_MIX_BOTS', 'http://127.0.0.1:41189'), aiFleet: env('PRIZE_MIX_AI', 'http://127.0.0.1:41190') };
const untilTurn = Number(env('PRIZE_MIX_UNTIL_TURN', '24'));
for (const u of [base, rpcUrl, ...Object.values(controls)]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local-only test');
const outDir = path.resolve(env('PRIZE_MIX_OUT', `.local/prize-e2e/mixed-${Date.now()}`));
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const report = { mode: 'prize-mixed-world', testAssetsOnly: true, llm: 'none (the AI fleet runs its autopilot, no brain)', base, startedAt: new Date().toISOString(), checks: [] };
const save = () => writeFileSync(path.join(outDir, 'transcript.json'), `${json(report)}\n`);
const check = (name, details = {}) => { report.checks.push({ name, ok: true, ...details }); console.log(name, json(details).slice(0, 900)); save(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); assert.ok(!j.error, json(j.error)); return j.result;
}
async function eventually(label, fn, ms = 180000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(1000); }
  throw new Error(`${label}: timeout; ${json(last)}`);
}
const api = async (p, body, headers = {}) => { const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const h = createHerald({ base });

/** The accepted and refused actions of a fleet, from its own control listener: `{join: {ok, …}, place_home: …}` summed over its groups. */
async function fleetCounts(url) {
  const m = await (await fetch(`${url}/metrics`)).json();
  const out = {};
  for (const g of Object.values(m.groups ?? {})) for (const [action, by] of Object.entries(g)) for (const [k, n] of Object.entries(by)) { out[action] ??= {}; out[action][k] = (out[action][k] ?? 0) + n; }
  return { bots: m.bots, actions: out };
}

async function run() {
  const s = await eventually('season ready', async () => { const r = await h.season(); return r.ok && r.record.rings?.length >= 5 ? r : null; });
  const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); setRelay(gw);
  const A = new FrontierAddresses({ programId: s.record.programId, seasonId: BigInt(s.record.season) });
  const terms = (await api('/f/season')).body;
  assert.ok(terms.prize && terms.joinGate, 'a gated season with a prize pool');
  report.season = s.record.season; report.programId = s.record.programId; report.prize = terms.prize;

  // The person: test USDC from the faucet, the paid Join, a home, a first building.
  const key = await keyFromSeed(randomBytes(32)), session = await keyFromSeed(randomBytes(32));
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  const home = await eventually('a free home site', async () => {
    for (const at of ringProvinces(3)) { const r = await h.province(at.p, at.q); const sites = r.ok ? homeSites(r.province, { ringsOpen: s.record.rings.length }) : []; if (sites.length) return sites[0]; }
    return null;
  });
  assert.equal((await api('/f/faucet', { wallet: wallet.address })).status, 200);
  const before = (await api(`/f/prize?wallet=${wallet.address}`)).body;
  const joined = await joinViaX402(gw, { wallet: wallet.address, sign: m => key.sign(m), faction: home.faction, session: session.publicKeyBytes, sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86400n, maxFee: 25_000_000n });
  const after = (await api(`/f/prize?wallet=${wallet.address}`)).body;
  assert.equal(BigInt(before.wallet.balance) - BigInt(after.wallet.balance), 25_000_000n);
  check('person-x402-join', { wallet: wallet.address, nation: home.faction, signature: joined.signature, paymentResponse: joined.paymentResponse, testUsdcBefore: before.wallet.balance, testUsdcAfter: after.wallet.balance });
  const ctx = { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: home.faction, holding: home, province: home };
  const personActions = {};
  for (const [name, fields, extra] of [['PlaceHome', { p: home.p, q: home.q, site: home.site }, {}], ['Build', { item: 0 }, { item: 0 }]]) {
    if (name === 'Build') await eventually('the home is final', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2; });
    let sent;
    for (let i = 0; i < 6; i++) { sent = await submit({ name, accounts: accountsFor(name, { ...ctx, ...extra }), fields, signer: { session } }); if (sent.ok || !['network', 'Unavailable'].includes(sent.code)) break; await sleep(4000); }
    assert.equal(sent.ok, true, `${name} ${json(sent)}`);
    assert.equal((await track(sent.signature, { tries: 80, every: 500 })).ok, true, name);
    personActions[name] = sent.signature;
  }
  check('person-actions', personActions);

  // Neither paid nor invited: refused by the relay (402, InviteRequired) and by the game on chain.
  {
    const w = Keypair.fromSeed(randomBytes(32)), payer = Keypair.fromSeed(randomBytes(32)), addr = w.publicKey.toBase58();
    const fields = { faction: home.faction, session: Keypair.fromSeed(randomBytes(32)).publicKey.toBytes(), session_expiry: BigInt(s.record.latestUnix) + 86400n };
    const accounts = gate => ({ wallet: addr, season: A.season, frontier: A.frontier, citizen: A.citizen(addr), joinshard: A.joinShardFor(fields.faction, addr), ...(gate ? { join_gate: terms.joinGate } : {}) });
    const req = (await api('/f/x402/join', { wallet: addr })).body.accepts[0];
    const plain = shapeMessage({ programId: pin.programId, name: 'Join', accounts: accounts(true), fields, feePayer: req.extra.feePayer, recentBlockhash: req.extra.recentBlockhash, profile: 2 });
    const tx = toBase64(wireTransaction(plain, { [addr]: signTalk(plain, w) }));
    const x402 = await api('/f/x402/join', { wallet: addr }, { 'X-PAYMENT': x402Encode({ x402Version: 1, scheme: 'exact', network: req.network, payload: { transaction: tx } }) });
    const free = await api('/f/join', { tx });
    const forged = await api('/f/join', { tx, invite: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    await rpc('requestAirdrop', [payer.publicKey.toBase58(), 1_000_000_000]);
    await eventually('airdrop', async () => (await rpc('getBalance', [payer.publicKey.toBase58()])).value > 0, 30000);
    const msg = shapeMessage({ programId: pin.programId, name: 'Join', accounts: accounts(false), fields, feePayer: payer.publicKey.toBase58(), recentBlockhash: (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash, profile: 2 });
    const signature = await rpc('sendTransaction', [toBase64(wireTransaction(msg, { [addr]: signTalk(msg, w), [payer.publicKey.toBase58()]: signTalk(msg, payer) })), { encoding: 'base64', skipPreflight: true }]);
    const st = await eventually('the unpaid Join\'s result', async () => (await rpc('getSignatureStatuses', [[signature]]))?.value?.[0] ?? null, 30000);
    assert.deepEqual([x402.status, free.body.code, forged.body.code], [402, 'InviteRequired', 'InviteRequired']);
    assert.ok(st.err, 'the game refuses a Join without the gate');
    assert.equal((await rpc('getAccountInfo', [A.citizen(addr), { encoding: 'base64' }])).value, null);
    check('unpaid-uninvited-join-refused', { wallet: addr, relayX402: { status: x402.status, code: x402.body.code }, relayJoinWithoutInvite: free.body.code, relayJoinWithForgedInvite: forged.body.code, onChain: { signature, err: st.err } });
  }

  // Let the fleets play for a while, then read what each group did.
  await eventually(`turn ${untilTurn}`, async () => { const r = await h.season(); return r.ok && bellAt(Number(r.season.genesisTs), Number(r.record.latestUnix)) >= untilTurn; }, 30 * 60_000);
  const groups = {};
  for (const [name, url] of Object.entries(controls)) groups[name] = await fleetCounts(url);
  const ok = (g, a) => groups[g].actions[a]?.ok ?? 0;
  const table = Object.fromEntries(Object.keys(controls).map(g => [g, { members: groups[g].bots, join: ok(g, 'join'), placeHome: ok(g, 'place_home'), build: ok(g, 'build'), train: ok(g, 'train'), muster: ok(g, 'muster') }]));
  table.person = { members: 1, join: 1, placeHome: 1, build: 1, train: 0, muster: 0 };
  check('accepted-actions-per-group', { table, refused: Object.fromEntries(Object.keys(controls).map(g => [g, Object.fromEntries(Object.entries(groups[g].actions).map(([a, by]) => [a, Object.fromEntries(Object.entries(by).filter(([k]) => k !== 'ok'))]).filter(([, by]) => Object.keys(by).length))])) });
  for (const g of Object.keys(controls)) { assert.equal(table[g].join, table[g].members, `${g}: every member joined by invite`); assert.ok(table[g].placeHome >= 1 && table[g].build >= 1, `${g} placed homes and built`); }

  // The chain: every Citizen, every Entry. A member without an Entry is an AI citizen or a script bot.
  const accounts = async (program, size) => (await rpc('getProgramAccounts', [program, { encoding: 'base64', filters: [{ dataSize: size }] }])).map(a => ({ address: a.pubkey, data: Uint8Array.from(Buffer.from(a.account.data[0], 'base64')) })).filter(a => a.data.length === size);
  const citizens = (await accounts(s.record.programId, 384)).filter(a => Buffer.from(a.data.subarray(0, 8)).toString() === 'PSF1CITZ').map(a => ({ wallet: base58(a.data.subarray(64, 96)), nation: a.data[136] }));
  const entries = (await accounts(terms.prize.program, ENTRY_SIZE)).map(a => decodeEntry(a.data)).filter(Boolean);
  const paid = new Set(entries.map(e => e.wallet));
  const members = citizens.map(c => ({ ...c, kind: paid.has(c.wallet) ? 'paid' : 'operatorInvited', prizeEligible: paid.has(c.wallet) }));
  const pool = (await api('/f/prize')).body;
  assert.equal(citizens.length, 1 + table.scriptBots.join + table.aiFleet.join, 'the chain\'s Citizens are the person, the script bots and the AI fleet');
  assert.deepEqual([entries.length, pool.entries, pool.collected, pool.prize, pool.ops], [1, 1, '25000000', '20000000', '5000000']);
  assert.deepEqual(members.filter(m => m.prizeEligible).map(m => m.wallet), [wallet.address]);
  check('pool-and-eligibility', { pool: { entries: pool.entries, collected: pool.collected, prize: pool.prize, ops: pool.ops }, citizensOnChain: citizens.length, entriesOnChain: entries.length,
    eligible: members.filter(m => m.prizeEligible).map(m => m.wallet), notEligible: { count: members.filter(m => !m.prizeEligible).length, kind: PLAYER_KINDS.operatorInvited.label, byNation: [0, 1, 2, 3, 4, 5].map(f => members.filter(m => !m.prizeEligible && m.nation === f).length) },
    note: AREA_NOTE });
  report.ok = true;
}
try { await run(); } catch (e) { report.ok = false; report.error = String(e?.stack ?? e); console.error(report.error); process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(`transcript: ${path.join(outDir, 'transcript.json')}`); }
