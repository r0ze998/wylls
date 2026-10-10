// The prize pool end to end on a disposable local stack (test tokens only;
// conquest-smoke.mjs's flow with paid entry). Through the real browser
// modules, relay, herald, keepers and programs:
//
//   1. three dev wallets take test USDC from the faucet and join over x402 (25 each): the attacker and the
//      supporter one nation, the third another; a fourth wallet shows that an unpaid Join is refused by the
//      relay (402) and by the game itself on chain (JoinGate);
//   2. the attacker and the supporter march on an enemy keep; the keep falls to the attacker's host, the
//      supporter's host stays on it;
//   3. the clock is advanced to the season's end, the keeper ends the season;
//   4. scripts/prize-settle.mjs tallies and finalises (permissionless), checks the area three ways, writes the
//      achievements ledger and the ESTIMATED split, and --verify re-derives every line;
//   5. with PRIZE_E2E_CLAIM=1 (the deferred step): SetShares, both claims, WithdrawOps, balances after.
//
//   PRIZE_E2E_URL=http://127.0.0.1:41192 PRIZE_E2E_RPC=http://127.0.0.1:41162 PRIZE_E2E_OUT=.local/prize-e2e/run1 \
//   PRIZE_E2E_OPERATOR_SEED=<run dir>/keys/operator.seed node permutation-gateway/scripts/prize-e2e.mjs
//
// The stack: `frontier-stack up --conquest … --game-hours 72 --season-end-at-play-end --prize-so …`.
// The test clock's scale is restored at the end. Wallet keys are ephemeral.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay, nudge, reveal } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { bellAt, seasonClock } from '../../permutation-server/web/frontier/clock.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostsIn } from '../../permutation-server/web/frontier/fland.mjs';
import { loadKernel } from '../../permutation-server/web/frontier/wasm.mjs';
import { planRoute, earliestBell, plaintextOf, tipOptions, freeTransitSlot } from '../../permutation-server/web/frontier/fmarch.mjs';
import { sealMarch } from '../../permutation-server/web/frontier/seal.mjs';
import { claimIx, joinViaX402, withdrawOpsIx, x402Encode, ata } from '../client/src/frontier/prize.mjs';
import { createAtaIdempotentIx } from '../client/src/player.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { compileMessage, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { readFileSync } from 'node:fs';

const base = process.env.PRIZE_E2E_URL ?? 'http://127.0.0.1:41192';
const rpcUrl = process.env.PRIZE_E2E_RPC ?? 'http://127.0.0.1:41162';
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local-only test');
const outDir = path.resolve(process.env.PRIZE_E2E_OUT ?? fileURLToPath(new URL(`../../.local/prize-e2e/${new Date().toISOString().replace(/[:.]/g, '-')}`, import.meta.url)));
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
let report = { mode: 'prize-e2e-real-localnet', testAssetsOnly: true, token: 'test USDC (local test mint, no value)', base, rpcUrl, startedAt: new Date().toISOString(), checks: [] };
const save = () => writeFileSync(path.join(outDir, 'transcript.json'), `${json(report)}\n`);
const check = (name, details = {}) => { report.checks.push({ name, ok: true, ...details }); console.log(name, json(details).slice(0, 700)); save(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); assert.ok(!j.error, json(j.error)); return j.result;
}
async function eventually(label, fn, ms = 180000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(500); }
  throw new Error(`${label}: timeout; ${json(last)}`);
}
const api = async (p, body, headers = {}) => { const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const poolNow = async wallet => (await api(`/f/prize${wallet ? `?wallet=${wallet}` : ''}`)).body;
const h = createHerald({ base });
let pin, kernel, originalScale, A;

async function action(name, player, fields, extra = {}) {
  const sent = await submit({ name, accounts: accountsFor(name, { ...player.context, ...extra }), fields, signer: { session: player.session } });
  assert.equal(sent.ok, true, `${name} submit ${json(sent)}`);
  const landed = await track(sent.signature, { tries: 80, every: 500 });
  assert.equal(landed.ok, true, `${name} track ${json(landed)}`);
  check(name, { player: player.wallet.address, signature: sent.signature });
  return sent.signature;
}
async function advanceTo(targetBell) {
  const current = await h.season(); const target = Number(current.season.genesisTs) + targetBell * 600 + 1;
  await rpc('frontier_setScale', [1000]);
  try { await eventually(`clock bell ${targetBell}`, async () => (await rpc('frontier_status')).unixTimestamp >= target, 240000); }
  finally { await rpc('frontier_setScale', [10]); }
  check('test-clock-advanced', { targetBell });
}
async function resident(home) {
  const [s, p] = await Promise.all([h.season(), h.province(home.p, home.q)]);
  if (!s.ok || !p.ok) return null;
  const bell = bellAt(Number(s.season.genesisTs), Number(s.record.latestUnix));
  if (p.province.resolvedNext + 1 < bell) { await nudge(home.p, home.q, p.province.resolvedNext); return null; }
  return { s, province: p.province, bell };
}
/** Send `ixs` directly to the chain, signed by web3 keypairs (the first pays); returns `{signature, err}`. */
async function sendDirect(ixs, signers) {
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = compileMessage({ feePayer: signers[0].publicKey.toBase58(), recentBlockhash: value.blockhash, instructions: ixs });
  const wire = wireTransaction(message, Object.fromEntries(signers.map(k => [k.publicKey.toBase58(), signTalk(message, k)])));
  const signature = await rpc('sendTransaction', [toBase64(wire), { encoding: 'base64', skipPreflight: true }]);
  const st = await eventually(`result of ${signature}`, async () => (await rpc('getSignatureStatuses', [[signature]]))?.value?.[0] ?? null, 30000);
  return { signature, err: st.err ?? null };
}

async function run() {
  originalScale = (await rpc('frontier_status')).scale;
  const s = await eventually('CQ season and outer frontier ready', async () => { const r = await h.season(); return r.ok && r.record.rings?.length >= 5 ? r : null; });
  assert.equal(s.record.cluster, 'localnet');
  pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); setRelay(gw);
  A = new FrontierAddresses({ programId: s.record.programId, seasonId: BigInt(s.record.season) });
  const terms = (await api('/f/season')).body;
  assert.ok(terms.prize, 'the stack runs without --prize-so');
  report.season = s.record.season; report.programId = s.record.programId; report.endBell = s.season.endBell; report.prize = terms.prize; report.joinGate = terms.joinGate;
  const pool0 = await poolNow();
  check('pool-opened', { fee: pool0.fee, opsBps: pool0.opsBps, prize: pool0.prize, ops: pool0.ops, entries: pool0.entries, paramsHash: pool0.paramsHash });
  kernel = await loadKernel({ url: `${base}/frontier/frontier/wasm/frontier-v2.wasm`, ruleset: toHex(s.season.rulesetHash) });
  const seeds = s.record.rings.map(r => ({ ring: r.d, seed: r.seed }));

  // Homes and a target: the nearest enemy keep of the outer ring, two homes of one nation with a route to it.
  const provinces = [];
  for (const at of ringProvinces(3)) { const r = await h.province(at.p, at.q); if (r.ok) provinces.push(r.province); }
  const targets = [];
  for (const at of ringProvinces(4)) { const r = await h.province(at.p, at.q); if (r.ok && r.province.keep?.tile < 61) targets.push(r.province); }
  const choices = [];
  for (const province of provinces) for (const home of homeSites(province, { ringsOpen: s.record.rings.length })) {
    for (const target of targets) {
      if (target.keep.holder === home.faction) continue;
      const dest = { p: target.p, q: target.q, tile: target.keep.tile };
      const p = planRoute(kernel, { from: home, to: dest, unit: 0, seeds });
      if (p.ok) choices.push({ home, dest, route: p.route, defender: target.keep.holder });
    }
  }
  choices.sort((a, b) => a.route.secs - b.route.secs);
  const sameHome = (a, b) => a.p === b.p && a.q === b.q && a.site === b.site;
  const sameDest = (a, b) => a.p === b.p && a.q === b.q;
  let first, support;
  for (const c of choices) {
    support = choices.find(x => x.home.faction === c.home.faction && !sameHome(x.home, c.home) && sameDest(x.dest, c.dest));
    if (support) { first = c; break; }
  }
  assert.ok(first && support, 'two homes of one nation reach the same enemy keep');
  const other = choices.find(x => x.home.faction !== first.home.faction && !sameHome(x.home, first.home));
  assert.ok(other, 'a second nation can join');

  // 1. Faucet, then the paid Join over x402.
  const players = [];
  for (const [role, choice] of [['attacker', first], ['other-nation', other], ['supporter', support]]) {
    const key = await keyFromSeed(randomBytes(32)), session = await keyFromSeed(randomBytes(32));
    const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
    const player = { role, wallet, session, home: choice.home, context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: choice.home.faction, holding: choice.home, province: choice.home } };
    const faucet = await api('/f/faucet', { wallet: wallet.address });
    assert.equal(faucet.status, 200, json(faucet));
    const before = (await poolNow(wallet.address)).wallet;
    const joined = await joinViaX402(gw, { wallet: wallet.address, signTransaction: w => wallet.signTransaction(w), faction: choice.home.faction, session: session.publicKeyBytes,
      sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86400n, maxFee: 25_000_000n });
    const after = await poolNow(wallet.address);
    assert.equal(BigInt(before.balance) - BigInt(after.wallet.balance), 25_000_000n, 'the wallet paid exactly the fee');
    assert.equal(after.wallet.faction, choice.home.faction);
    check('x402-join', { role, wallet: wallet.address, nation: choice.home.faction, faucet: faucet.body.signature, signature: joined.signature, paymentResponse: joined.paymentResponse,
      requirements: { scheme: joined.requirements.scheme, network: joined.requirements.network, maxAmountRequired: joined.requirements.maxAmountRequired, payTo: joined.requirements.payTo, asset: joined.requirements.asset },
      testUsdcBefore: before.balance, testUsdcAfter: after.wallet.balance, pool: { entries: after.entries, collected: after.collected, prize: after.prize, ops: after.ops } });
    if (players.length === 1) {
      // Two payers: 2 × 25 = 50 collected, 40 prize, 10 operator.
      assert.deepEqual([after.collected, after.prize, after.ops], ['50000000', '40000000', '10000000']);
      check('pool-after-two-payers', { collected: after.collected, prize: after.prize, ops: after.ops });
    }
    players.push(player);
  }
  const pool3 = await poolNow();
  assert.deepEqual([pool3.entries, pool3.collected, pool3.prize, pool3.ops], [3, '75000000', '60000000', '15000000']);
  check('pool-after-three-payers', { collected: pool3.collected, prize: pool3.prize, ops: pool3.ops });

  // An unpaid wallet: the relay answers 402, and the game refuses the Join on chain without the gate's signature.
  {
    const w = Keypair.fromSeed(randomBytes(32)), payer = Keypair.fromSeed(randomBytes(32)), wallet = w.publicKey.toBase58();
    const fields = { faction: other.home.faction, session: Keypair.fromSeed(randomBytes(32)).publicKey.toBytes(), session_expiry: BigInt(s.record.latestUnix) + 86400n };
    const accounts = gate => ({ wallet, season: A.season, frontier: A.frontier, citizen: A.citizen(wallet), joinshard: A.joinShardFor(fields.faction, wallet), ...(gate ? { join_gate: terms.joinGate } : {}) });
    const req = (await api('/f/x402/join', { wallet })).body.accepts[0];
    const plain = shapeMessage({ programId: pin.programId, name: 'Join', accounts: accounts(true), fields, feePayer: req.extra.feePayer, recentBlockhash: req.extra.recentBlockhash, profile: 2 });
    const refused = await api('/f/x402/join', { wallet }, { 'X-PAYMENT': x402Encode({ x402Version: 1, scheme: 'exact', network: req.network, payload: { transaction: toBase64(wireTransaction(plain, { [wallet]: signTalk(plain, w) })) } }) });
    assert.equal(refused.status, 402, json(refused));
    const free = await api('/f/join', { tx: toBase64(wireTransaction(plain, { [wallet]: signTalk(plain, w) })) });
    assert.equal(free.body.code, 'InviteRequired', json(free));
    // Straight to the chain, paying its own fee, without the gate: the program's JoinGate.
    await rpc('requestAirdrop', [payer.publicKey.toBase58(), 1_000_000_000]);
    await eventually('airdrop', async () => (await rpc('getBalance', [payer.publicKey.toBase58()])).value > 0, 30000);
    const direct = [];
    for (const gate of [false, true]) {
      const msg = shapeMessage({ programId: pin.programId, name: 'Join', accounts: accounts(gate), fields, feePayer: payer.publicKey.toBase58(), recentBlockhash: (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash, profile: 2 });
      // (with the gate named but unsigned the cluster refuses the transaction before it runs: a missing signature)
      const wire = wireTransaction(msg, { [wallet]: signTalk(msg, w), [payer.publicKey.toBase58()]: signTalk(msg, payer) });
      let out;
      try {
        const signature = await rpc('sendTransaction', [toBase64(wire), { encoding: 'base64', skipPreflight: true }]);
        const st = await eventually('unpaid join result', async () => (await rpc('getSignatureStatuses', [[signature]]))?.value?.[0] ?? null, 30000);
        out = { signature, err: st.err ?? null };
      } catch (e) { out = { refusedBeforeExecution: String(e.message).slice(0, 300) }; }
      direct.push({ gateNamed: gate, ...out });
    }
    assert.ok(direct[0].err, `a Join without the gate must fail on chain: ${json(direct)}`);
    assert.ok(direct[1].err || direct[1].refusedBeforeExecution, 'a Join naming the gate without its signature cannot land');
    const citizen = await rpc('getAccountInfo', [A.citizen(wallet), { encoding: 'base64' }]);
    assert.equal(citizen.value, null, 'the unpaid wallet has no Citizen');
    const poolSame = await poolNow();
    assert.equal(poolSame.entries, 3);
    check('unpaid-join-refused', { wallet, relayX402: { status: refused.status, code: refused.body.code }, relayFreeJoin: free.body.code, onChain: direct });
  }

  // 2. Homes, troops, the march.
  for (const player of players) {
    await action('PlaceHome', player, { p: player.home.p, q: player.home.q, site: player.home.site });
    const me = await eventually('immediate final home', async () => { const r = await h.me(player.wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; });
    player.holding = me.holdings[0];
    await action('Build', player, { item: 0 }, { item: 0 });
  }
  report.players = players.map(p => ({ role: p.role, wallet: p.wallet.address, nation: p.home.faction, home: p.home })); report.target = first.dest; save();
  const marchers = [{ player: players[0], troops: 1000, route: first.route }, { player: players[2], troops: 400, route: support.route }];
  const foundedBell = Math.max(...players.map(p => bellAt(Number(s.season.genesisTs), Number(p.holding.finalTs))));
  const readyAt = Math.max(150, foundedBell + 150);
  await advanceTo(readyAt);
  for (const m of marchers) {
    await action('Harvest', m.player, {});
    await eventually('home province current', () => resident(m.player.home));
    await action('Train', m.player, { unit: 0, n: m.troops });
    await action('Muster', m.player, { unit: 0, troops: m.troops, tile: m.player.home.tile });
  }
  await advanceTo(readyAt + 4);
  for (const m of marchers) {
    m.ready = await eventually('muster resolved', async () => {
      const p = await resident(m.player.home); if (!p) return null;
      const host = hostsIn(p.province, m.player.holding, p.bell).find(x => x.state === 1 && x.unit === 0 && !x.pending && x.readyBell <= p.bell);
      return host ? { ...p, host } : null;
    });
  }
  const now = await h.season();
  const arriveBell = Math.max(...marchers.map(m => Math.max(m.ready.bell + now.season.minLead, earliestBell(kernel, { genesisTs: Number(now.season.genesisTs), departTs: Number(now.record.latestUnix) + 150, secs: m.route.secs }))));
  for (const m of marchers) {
    const plain = plaintextOf({ host: m.ready.host, arriveBell, dest: first.dest, route: m.route, stance: 1, retreat: { choice: 'never' } });
    const sealed = await sealMarch({ plain, clock: seasonClock(now.season), publicKey: now.record.drand.publicKey, hostId: m.ready.host.id, arriveBell }, { inline: true });
    assert.ok(sealed.ok, json(sealed));
    const me = await h.me(m.player.wallet.address); const transitSlot = freeTransitSlot(me.holdings[0]);
    m.depart = await action('Depart', m.player, { host_id: m.ready.host.id, commit: sealed.commit, seal: sealed.seal, arrive_bell: arriveBell, tip: tipOptions(now.season)[0].lamports, transit_slot: transitSlot });
    const revealed = await reveal({ holding: pin.addresses.of('Holding', m.player.home), transit_slot: transitSlot, plain_b64: Buffer.from(plain).toString('base64'), salt_b64: Buffer.from(sealed.salt).toString('base64'), ct_hash_b64: Buffer.from(sealed.ctHash).toString('base64') });
    assert.ok(revealed.ok, json(revealed));
    check('march-sealed', { role: m.player.role, hostId: String(m.ready.host.id), troops: m.troops, arriveBell, target: first.dest });
  }
  await advanceTo(arriveBell + 3);
  const arrived = await eventually('hosts arrived at the keep', async () => {
    const p = await h.province(first.dest.p, first.dest.q); if (!p.ok) return null;
    return marchers.every(m => p.province.entries.find(x => x.id === m.ready.host.id && x.state === 1)) ? p.province : null;
  });
  check('marches-arrived', { keep: arrived.keep, hosts: marchers.map(m => String(m.ready.host.id)) });
  await advanceTo(arriveBell + 80);
  const captured = await eventually('keep captured', async () => { const p = await h.province(first.dest.p, first.dest.q); return p.ok && p.province.keep.holder === first.home.faction ? p.province : null; }, 300000);
  check('keep-captured', { province: [first.dest.p, first.dest.q], keep: captured.keep, from: first.defender, by: first.home.faction });

  // 3. The end of the season.
  await advanceTo(s.season.endBell + 2);
  await eventually('the game\'s Season is Ended on chain', async () => { const a = await rpc('getAccountInfo', [A.season, { encoding: 'base64' }]); return Buffer.from(a.value.data[0], 'base64')[64] === 4; }, 360000);
  await eventually('every keep province is resolved to the end bell', async () => {
    for (const d of [2, 3, 4]) for (const at of ringProvinces(d)) { const p = await h.province(at.p, at.q); if (!p.ok || p.province.resolvedNext < s.season.endBell) { await nudge(at.p, at.q, p.province?.resolvedNext ?? 0).catch(() => {}); return null; } }
    return true;
  }, 360000);
  check('season-ended', { endBell: s.season.endBell });

  // 4. Tally, Finalize, the checks, the ledger.
  const settle = fileURLToPath(new URL('./prize-settle.mjs', import.meta.url));
  const common = ['--rpc', rpcUrl, '--relay', gw, '--herald', base];
  const runSettle = (name, extra) => { const out = execFileSync(process.execPath, [settle, ...common, ...extra], { encoding: 'utf8' }); writeFileSync(path.join(outDir, `${name}.txt`), out); console.log(out); return out; };
  runSettle('settle', ['--out', outDir, ...(process.env.PRIZE_E2E_LEDGER_FILE ? ['--ledger-file', process.env.PRIZE_E2E_LEDGER_FILE] : [])]);
  runSettle('check', ['--check']);
  runSettle('verify', ['--verify', path.join(outDir, 'ledger.json')]);
  const ledger = JSON.parse(readFileSync(path.join(outDir, 'ledger.json'), 'utf8'));
  const final = await poolNow();
  assert.deepEqual(final.winners, [first.home.faction], 'the capturing nation holds the most provinces');
  assert.equal(final.area[first.home.faction], 10);
  const lineOf = (kind, wallet) => ledger.lines.find(l => l.kind === kind && l.wallet === wallet && l.province.p === first.dest.p && l.province.q === first.dest.q);
  const [cap, sup] = [lineOf('capture', players[0].wallet.address), lineOf('reinforcement', players[2].wallet.address)];
  assert.ok(cap?.signatures.length, 'the attacker\'s capture is in the ledger with its transaction');
  assert.ok(sup?.signatures.length && sup.quantity > 0, 'the supporter\'s troops are in the ledger with their transaction');
  check('result', { state: final.state, area: final.area, winners: final.winners, capture: cap, reinforcement: sup, estimate: ledger.estimate });

  // 5. The deferred step, on request: shares, claims, the operator's part.
  if (process.env.PRIZE_E2E_CLAIM === '1') {
    const seedFile = process.env.PRIZE_E2E_OPERATOR_SEED;
    assert.ok(seedFile, 'PRIZE_E2E_OPERATOR_SEED: the stack run\'s keys/operator.seed');
    runSettle('set-shares', ['--out', path.join(outDir, 'shares'), '--set-shares', '--operator-seed-file', seedFile, ...(process.env.PRIZE_E2E_LEDGER_FILE ? ['--ledger-file', process.env.PRIZE_E2E_LEDGER_FILE] : [])]);
    const posted = JSON.parse(readFileSync(path.join(outDir, 'shares', 'ledger.json'), 'utf8'));
    const claims = [];
    for (const player of players) {
      const wallet = player.wallet.address;
      const m = posted.shares.members.find(x => x.wallet === wallet);
      const before = (await poolNow(wallet)).wallet.balance;
      const { feePayer, blockhash } = (await api('/f/relay')).body;
      const ix = claimIx({ prize: terms.prize, wallet, citizen: A.citizen(wallet), nation: m?.nation ?? player.home.faction, points: BigInt(m?.points ?? 0), proof: (m?.proof ?? []).map(x => Buffer.from(x, 'hex')) });
      const wire = await player.wallet.signTransaction(wireTransaction(compileMessage({ feePayer, recentBlockhash: blockhash, instructions: [ix] })));
      const r = await api('/f/prize/claim', { tx: toBase64(wire) });
      const after = (await poolNow(wallet)).wallet.balance;
      claims.push({ role: player.role, wallet, nation: player.home.faction, points: m?.points ?? 0, status: r.status, code: r.body.code ?? null, signature: r.body.signature ?? null, testUsdcBefore: before, testUsdcAfter: after, received: String(BigInt(after) - BigInt(before)) });
    }
    const operator = Keypair.fromSeed(Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'hex'));
    const op = operator.publicKey.toBase58();
    const ops = await sendDirect([createAtaIdempotentIx({ payer: op, owner: op, mint: terms.prize.mint }), withdrawOpsIx({ prize: terms.prize, operator: op })], [operator]);
    assert.equal(ops.err, null, json(ops));
    const opBalance = await rpc('getAccountInfo', [ata(op, terms.prize.mint), { encoding: 'base64' }]);
    const end = await poolNow();
    check('claims', { note: 'shares by the PROVISIONAL weights', claims, operator: { wallet: op, signature: ops.signature, testUsdc: String(Buffer.from(opBalance.value.data[0], 'base64').readBigUInt64LE(64)) }, pool: { state: end.state, shares: end.shares, opsWithdrawn: end.opsWithdrawn } });
    assert.equal(claims.filter(c => c.status === 200).reduce((a, c) => a + BigInt(c.received), 0n) <= BigInt(end.prize), true);
    assert.ok(claims.find(c => c.role === 'other-nation').status !== 200, 'a member of a losing nation cannot claim');
  }
  report.ok = true;
}
try { await run(); } catch (e) { report.ok = false; report.error = String(e?.stack ?? e); console.error(report.error); process.exitCode = 1; }
finally {
  if (originalScale !== undefined) { await rpc('frontier_setScale', [originalScale]); report.restoredScale = originalScale; }
  report.finishedAt = new Date().toISOString(); save();
  console.log(`transcript: ${path.join(outDir, 'transcript.json')}`);
}
