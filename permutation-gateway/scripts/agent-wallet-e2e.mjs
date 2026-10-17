// The agent wallet end to end on a disposable local stack (test tokens
// only; docs/agent-wallet/DESIGN.md §8). Through the real browser modules,
// relay, herald and programs:
//
//   1. a dev wallet takes test USDC from the faucet, joins over x402 and places its home (manual play, its own
//      session key); a manual Harvest lands;
//   2. the owner creates an agent (a wallet-signed command), deposits 10 test USDC into the operator's custody
//      account (an owner-signed TransferChecked, credited after the relay verified it on chain), and gives the
//      agent's key the village by SetSession (wallet-signed, through the relay);
//   3. auto: an outside caller (the MCP shape) sends a Harvest with the capability token; a repeat replays; a
//      march and another village are refused; the relay's own runner (a stand-in model server on loopback,
//      charged per call) acts on its own and the balance goes down by the inference price;
//   4. the agent's key on POST /f/relay is refused (AgentKeyDirect);
//   5. manual: the owner stops the agent; its requests are refused, the runner stops, the owner takes the
//      session key back and plays by hand again;
//   6. the owner withdraws the unused balance to their own wallet; the books balance.
//
//   Start the stack with the agent wallet and its runner on (the relay reads FRONTIER_* from its environment):
//     RUN=agent-e2e-1; R=$PWD/frontier-node/.local/frontier/$RUN/relay
//     FRONTIER_AGENT_WALLET=1 FRONTIER_AGENT_RUNNER=1 FRONTIER_AGENT_TICK_MS=5000 FRONTIER_AGENT_RECONCILE_MS=3000 \
//     FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41998 FRONTIER_AGENT_CUSTODY_KEY_FILE=$R/agent-custody.json FRONTIER_AGENT_KEYS_DIR=$R/agent-keys \
//     frontier-node/target/release/frontier-stack up --conquest --mode accel --beacon test-key --preseason-scale 2000 --scale 10 \
//       --game-hours 16 --season-end-at-play-end --bots 0 --personas off --prize-so permutation-prize/target/deploy/permutation_prize.so \
//       --entry-fee 25000000 --run-id $RUN --base-port 41900 --season 91
//   then
//     AGENT_E2E_URL=http://127.0.0.1:41940 AGENT_E2E_RPC=http://127.0.0.1:41910 AGENT_E2E_MODEL_PORT=41998 \
//     node permutation-gateway/scripts/agent-wallet-e2e.mjs
//   The transcript goes to AGENT_E2E_OUT (default .local/agent-wallet-e2e/<time>/transcript.json). Keys are ephemeral.
//
//   Real model (no stand-in): start the pinned llama-server (citizens/llama/start-pinned.sh, port 41901), start the
//   stack with FRONTIER_AGENT_LLM_URL=http://127.0.0.1:41901, then run with AGENT_E2E_MODEL=real
//   AGENT_E2E_LLM=http://127.0.0.1:41901. The transcript then records the server's model (/props), every decision the
//   runner recorded with the model's own reason, and the charges, under "model" — kept apart from a stand-in run.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin, setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { homeSites } from '../../permutation-server/web/frontier/home.mjs';
import { submit, track, accountsFor } from '../../permutation-server/web/frontier/fplay.mjs';
import { keyFromSeed } from '../../permutation-server/web/session.mjs';
import { devWallet, connect } from '../../permutation-server/web/wallet.mjs';
import { toBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { joinViaX402, ata } from '../client/src/frontier/prize.mjs';
import { createAtaIdempotentIx } from '../client/src/player.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { shapeMessage } from '../client/src/frontier/shapes.mjs';
import { compileMessage, wireTransaction } from '../client/src/solana-tx.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { transferCheckedIx } from '../src/frontier/agent/custody.mjs';
import { signCommand } from '../src/frontier/agent/owner-auth.mjs';

const base = process.env.AGENT_E2E_URL ?? 'http://127.0.0.1:41940';
const rpcUrl = process.env.AGENT_E2E_RPC ?? 'http://127.0.0.1:41910';
const modelPort = Number(process.env.AGENT_E2E_MODEL_PORT ?? 41998);
const realModel = process.env.AGENT_E2E_MODEL === 'real';
// A measurement window (ms): after auto is on, leave the agent alone this long and report what the runner did (calls, cost, actions).
const windowMs = Number(process.env.AGENT_E2E_WINDOW_MS ?? 0);
const llmUrl = process.env.AGENT_E2E_LLM ?? 'http://127.0.0.1:41901';
for (const u of [base, rpcUrl]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(u).hostname), 'local-only test');
const outDir = path.resolve(process.env.AGENT_E2E_OUT ?? fileURLToPath(new URL(`../../.local/agent-wallet-e2e/${new Date().toISOString().replace(/[:.]/g, '-')}`, import.meta.url)));
mkdirSync(outDir, { recursive: true });
const gw = `${base}/gw`;
const json = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v), 2);
const report = { mode: 'agent-wallet-e2e-real-localnet', testAssetsOnly: true, token: 'test USDC (local test mint, no value)', base, rpcUrl, startedAt: new Date().toISOString(), checks: [] };
const save = () => writeFileSync(path.join(outDir, 'transcript.json'), `${json(report)}\n`);
const check = (name, details = {}) => { report.checks.push({ name, ok: true, ...details }); console.log(name, json(details).slice(0, 600)); save(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params = []) {
  const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json(); assert.ok(!j.error, json(j.error)); return j.result;
}
async function eventually(label, fn, ms = 180_000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(500); }
  throw new Error(`${label}: timeout; ${json(last)}`);
}
const api = async (p, body, headers = {}) => { const r = await fetch(gw + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const h = createHerald({ base });

// A stand-in for llama-server on loopback: every decision is a Harvest. The relay's runner calls it; each call is charged.
const model = { calls: 0 };
const modelServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    model.calls++;
    const b = JSON.parse(body || '{}');
    assert.equal(JSON.stringify(b).includes('capability'), false, 'the model never sees a token');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'Harvest', fields: {}, reason: 'e2e' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } }));
  });
});
if (!realModel) await new Promise(r => modelServer.listen(modelPort, '127.0.0.1', r));
let modelInfo = null;
if (realModel) {
  const props = await (await fetch(`${llmUrl}/props`)).json().catch(() => null);
  const models = await (await fetch(`${llmUrl}/v1/models`)).json().catch(() => null);
  modelInfo = { mode: 'real', url: llmUrl, alias: models?.data?.[0]?.id ?? null, modelPath: props?.model_path ?? props?.default_generation_settings?.model ?? null, props: props ? { n_ctx: props.default_generation_settings?.n_ctx ?? null, total_slots: props.total_slots ?? null, chat_template: props.chat_template ? 'present' : null } : null };
  assert.ok(modelInfo.alias, `no model at ${llmUrl}`);
  report.model = modelInfo;
} else report.model = { mode: 'stand-in', port: modelPort, answers: 'Harvest, every call' };

let pin, A, s;
async function action(name, player, fields, extra = {}) {
  let sent;
  for (let i = 0; i < 6; i++) {
    sent = await submit({ name, accounts: accountsFor(name, { ...player.context, ...extra }), fields, signer: { session: player.session } });
    if (sent.ok || !['network', 'Unavailable', 'HTTP502', 'HTTP504'].includes(sent.code)) break;
    await sleep(5000);
  }
  assert.equal(sent.ok, true, `${name} submit ${json(sent)}`);
  const landed = await track(sent.signature, { tries: 80, every: 500 });
  assert.equal(landed.ok, true, `${name} track ${json(landed)}`);
  check(`manual-${name}`, { wallet: player.wallet.address, signature: sent.signature });
  return sent.signature;
}
/** A wallet-signed shape through the relay (SetSession: the wallet is the actor). */
async function walletShape(name, player, fields) {
  const info = (await api('/f/relay')).body;
  const message = shapeMessage({ programId: pin.programId, name, accounts: accountsFor(name, player.context), fields, feePayer: info.feePayer, recentBlockhash: info.blockhash, profile: 2 });
  const r = await api('/f/relay', { tx: toBase64(wireTransaction(message, { [player.wallet.address]: signTalk(message, player.keypair) })), lastValidBlockHeight: info.lastValidBlockHeight });
  assert.equal(r.status, 200, `${name}: ${json(r)}`);
  const landed = await track(r.body.signature, { tries: 80, every: 500 });
  assert.equal(landed.ok, true, `${name} track ${json(landed)}`);
  return r.body.signature;
}
async function sendDirect(ixs, signers) {
  const { value } = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const message = compileMessage({ feePayer: signers[0].publicKey.toBase58(), recentBlockhash: value.blockhash, instructions: ixs });
  const wire = wireTransaction(message, Object.fromEntries(signers.map(k => [k.publicKey.toBase58(), signTalk(message, k)])));
  const signature = await rpc('sendTransaction', [toBase64(wire), { encoding: 'base64', skipPreflight: true }]);
  const st = await eventually(`result of ${signature}`, async () => (await rpc('getSignatureStatuses', [[signature]]))?.value?.[0] ?? null, 30_000);
  return { signature, err: st.err ?? null };
}
const command = (keypair, op, { agentId, params = {} }) => {
  const c = { op, owner: keypair.publicKey.toBase58(), nonce: randomBytes(12).toString('hex'), expiresAt: Date.now() + 60_000, params, ...(agentId ? { agentId } : {}) };
  return { command: c, signature: signCommand(c, keypair) };
};
const agentView = async id => (await api(`/f/agent?id=${id}`)).body;
const tokenBalance = async wallet => BigInt((await api(`/f/prize?wallet=${wallet}`)).body.wallet.balance);

async function run() {
  // The world is ready when its outer rings exist and play has begun (a Join before genesis is WrongStatus).
  s = await eventually('CQ season in play with its outer frontier', async () => { const r = await h.season(); return r.ok && r.record.rings?.length >= 5 && Number(r.record.latestUnix) >= Number(r.record.genesisTs) ? r : null; }, 300_000);
  assert.equal(s.record.cluster, 'localnet');
  pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
  h.pin(s.record.season, pin.addresses); setRelay(gw);
  A = new FrontierAddresses({ programId: s.record.programId, seasonId: BigInt(s.record.season) });
  const season = (await api('/f/season')).body;
  assert.ok(season.prize, 'the stack runs without --prize-so');
  const terms = await api('/f/agent/terms');
  assert.equal(terms.status, 200, `the relay was started without FRONTIER_AGENT_WALLET=1: ${json(terms)}`);
  assert.equal(terms.body.mint, season.prize.mint, 'the custody holds the season\'s test USDC');
  assert.ok(terms.body.runner, 'the relay was started without FRONTIER_AGENT_RUNNER=1');
  const price = BigInt(terms.body.prices.inference);
  report.season = s.record.season; report.terms = terms.body;
  check('agent-wallet-enabled', { mint: terms.body.mint, custodyAccount: terms.body.custodyAccount, prices: terms.body.prices, runner: terms.body.runner });

  // 1. The owner: a dev wallet (its key is also a web3 Keypair for the commands and the deposit), faucet, join, home, a manual Harvest.
  const seed = randomBytes(32);
  const keypair = Keypair.fromSeed(seed);
  const key = await keyFromSeed(seed);
  assert.equal(key.publicKey, keypair.publicKey.toBase58(), 'one ed25519 key, two libraries');
  const wallet = await connect(devWallet(key), { chain: 'solana:localnet' });
  const session = await keyFromSeed(randomBytes(32));
  const home = await eventually('a free home site', async () => {
    for (const at of ringProvinces(3)) {
      const r = await h.province(at.p, at.q);
      if (!r.ok) continue;
      const sites = homeSites(r.province, { ringsOpen: s.record.rings.length });
      if (sites.length) return sites[0];
    }
    return null;
  });
  const player = { keypair, key, wallet, session, home, context: { addresses: pin.addresses, wallet: wallet.address, actor: session.publicKey, faction: home.faction, holding: home, province: home } };
  const faucet = await api('/f/faucet', { wallet: wallet.address });
  assert.equal(faucet.status, 200, json(faucet));
  await rpc('requestAirdrop', [wallet.address, 1_000_000_000]);
  await eventually('airdrop', async () => (await rpc('getBalance', [wallet.address])).value > 0, 30_000);
  const joined = await joinViaX402(gw, { wallet: wallet.address, sign: m => key.sign(m), faction: home.faction, session: session.publicKeyBytes, sessionExpiry: BigInt(s.record.latestUnix) + 7n * 86_400n, maxFee: 25_000_000n });
  check('owner-joined', { wallet: wallet.address, nation: home.faction, faucet: faucet.body.signature, join: joined.signature, testUsdc: String(await tokenBalance(wallet.address)) });
  await action('PlaceHome', player, { p: home.p, q: home.q, site: home.site });
  const me = await eventually('final home', async () => { const r = await h.me(wallet.address); return r.ok && r.holdings[0]?.state === 2 ? r : null; });
  const holding = me.holdings[0];
  const village = [holding.p, holding.q, holding.site];
  player.context.holding = holding; player.context.province = holding;
  await action('Harvest', player, {});
  check('village', { village });

  // 2. The agent: created by an owner command, funded by an owner-signed deposit, delegated by SetSession.
  const policy = { allowed: ['economy'], budget: { total: '1000000', perDay: '500000' } };
  const created = await api('/f/agent/command', command(keypair, 'create', { params: { village, policy } }));
  assert.equal(created.status, 200, json(created));
  const { agentId, agentKey } = created.body.agent;
  const capability = created.body.capability.token;
  assert.equal(created.body.agent.mode, 'manual');
  assert.equal(JSON.stringify(created.body.agent).includes(capability), false);
  check('agent-created', { agentId, agentKey, policy: created.body.agent.policy, sessionTerms: created.body.sessionTerms });
  const forged = command(keypair, 'policy', { agentId, params: { policy } });
  forged.command.owner = Keypair.generate().publicKey.toBase58();
  assert.equal((await api('/f/agent/command', forged)).body.code, 'BadOwnerSignature');
  const stranger = command(Keypair.generate(), 'mode', { agentId, params: { mode: 'auto' } });
  assert.equal((await api('/f/agent/command', stranger)).body.code, 'NotOwner');
  check('owner-commands-guarded', { forged: 'BadOwnerSignature', stranger: 'NotOwner' });
  // The browser's path: a sponsored deposit (the owner signs, a pool key pays, the relay co-signs, sends, waits and credits).
  const depositAmount = 9_000_000n;
  const before = await tokenBalance(wallet.address);
  const relayInfo = (await api('/f/relay')).body;
  const depMessage = compileMessage({ feePayer: relayInfo.feePayer, recentBlockhash: relayInfo.blockhash, instructions: [
    createAtaIdempotentIx({ payer: relayInfo.feePayer, owner: terms.body.custodyAuthority, mint: terms.body.mint }),
    transferCheckedIx({ source: ata(wallet.address, terms.body.mint), mint: terms.body.mint, dest: terms.body.custodyAccount, authority: wallet.address, amount: depositAmount, decimals: 6 }),
  ] });
  const sponsored = await api('/f/agent/deposit', { agentId, tx: toBase64(wireTransaction(depMessage, { [wallet.address]: signTalk(depMessage, keypair) })), lastValidBlockHeight: relayInfo.lastValidBlockHeight });
  assert.equal(sponsored.status, 200, json(sponsored));
  assert.deepEqual([sponsored.body.credited, sponsored.body.sponsored, sponsored.body.amount], [true, true, String(depositAmount)]);
  const sponsoredAgain = await api('/f/agent/deposit', { agentId, tx: toBase64(wireTransaction(depMessage, { [wallet.address]: signTalk(depMessage, keypair) })), lastValidBlockHeight: relayInfo.lastValidBlockHeight });
  assert.equal(sponsoredAgain.body.code, 'Duplicate', json(sponsoredAgain));
  // The other path: an owner-paid transfer sent straight to the chain, then its signature claimed.
  const directAmount = 1_000_000n;
  const dep = await sendDirect([
    transferCheckedIx({ source: ata(wallet.address, terms.body.mint), mint: terms.body.mint, dest: terms.body.custodyAccount, authority: wallet.address, amount: directAmount, decimals: 6 }),
  ], [keypair]);
  assert.equal(dep.err, null, json(dep));
  const credited = await eventually('deposit credited', async () => { const r = await api('/f/agent/deposit', { agentId, signature: dep.signature }); return r.status === 200 ? r.body : (r.body.code === 'DepositPending' ? null : assert.fail(json(r))); }, 60_000);
  assert.equal(credited.credited, true);
  assert.equal(credited.balance.available, String(depositAmount + directAmount));
  const again = await api('/f/agent/deposit', { agentId, signature: dep.signature });
  assert.deepEqual([again.body.credited, again.body.already], [false, true]);
  assert.equal(before - (await tokenBalance(wallet.address)), depositAmount + directAmount, 'the owner\'s wallet paid exactly the deposits');
  const total = depositAmount + directAmount;
  check('deposited', { sponsored: { signature: sponsored.body.signature, amount: String(depositAmount), feePayer: relayInfo.feePayer, replay: sponsoredAgain.body.code }, direct: { signature: dep.signature, amount: String(directAmount) }, balance: credited.balance, creditedTwice: false });
  const setSession = await walletShape('SetSession', player, { session: new PublicKey(agentKey).toBytes(), expiry: BigInt(s.record.latestUnix) + 7n * 86_400n });
  check('session-delegated', { setSession, agentKey });
  const auto = await api('/f/agent/command', command(keypair, 'mode', { agentId, params: { mode: 'auto' } }));
  assert.equal(auto.body.agent.mode, 'auto', json(auto));
  const epoch = auto.body.agent.modeEpoch;
  check('mode-auto', { modeEpoch: epoch });

  // 3. Actions: an outside caller with the capability (the MCP shape), then the relay's own runner.
  const request = (over = {}) => ({ agentId, source: 'mcp', idempotencyKey: `e2e-${randomBytes(6).toString('hex')}`, policyVersion: 1, modeEpoch: epoch, action: { name: 'Harvest', holding: village, fields: {} }, ...over });
  const r1 = request();
  const a1 = await api('/f/agent/action', { capability, request: r1 });
  assert.equal(a1.body.status, 'sent', json(a1));
  const landed = await track(a1.body.signature, { tries: 80, every: 500 });
  assert.equal(landed.ok, true, json(landed));
  const a1again = await api('/f/agent/action', { capability, request: r1 });
  assert.equal(a1again.body.replayed, true);
  assert.equal(a1again.body.signature, a1.body.signature);
  const march = await api('/f/agent/action', { capability, request: request({ action: { name: 'Depart', holding: village, fields: {} } }) });
  assert.equal(march.body.error?.code, 'ActionNotAllowed', json(march));
  const elsewhere = await api('/f/agent/action', { capability, request: request({ action: { name: 'Harvest', holding: [village[0], village[1], (village[2] + 1) % 12], fields: {} } }) });
  assert.equal(elsewhere.body.error?.code, 'WrongVillage', json(elsewhere));
  const badToken = await api('/f/agent/action', { capability: 'nope', request: request() });
  assert.equal(badToken.body.code, 'BadCapability');
  check('capability-actions', { sent: a1.body.signature, replayed: true, march: march.body.error.code, elsewhere: elsewhere.body.error.code, badToken: badToken.body.code });
  // (an event-driven runner may rest after its first action: in window mode one sent action and one charged call are enough before the window)
  const ran = await eventually(windowMs > 0 ? 'the runner acted once and was charged' : 'the runner acted twice and was charged', async () => {
    const v = await agentView(agentId);
    const ai = v.history.filter(x => x.type === 'action' && x.source === 'ai' && x.status === 'sent');
    const need = windowMs > 0 ? 1n : 2n;
    return BigInt(ai.length) >= need && BigInt(v.balance.spent.inference) >= need * price ? { v, ai } : null;
  }, realModel ? 600_000 : 120_000);
  if (realModel) {
    const decided = ran.v.history.filter(x => x.type === 'action' && x.source === 'ai');
    const byModel = decided.filter(x => typeof x.reason === 'string' && x.reason.startsWith(`model:${modelInfo.alias}`));
    assert.ok(byModel.length >= 1, `no action carries the real model\'s reason: ${json(decided)}`);
    const calls = ran.v.history.filter(x => x.type === 'spend' && x.category === 'inference');
    assert.ok(calls.every(x => x.model === `model:${modelInfo.alias}`), json(calls));
    report.model.decisions = decided.map(x => ({ name: x.name, status: x.status, reason: x.reason ?? null, signature: x.signature ?? null }));
    report.model.calls = calls.map(x => ({ amount: x.amount, ok: x.ok, tokens: x.tokens ?? null, late: x.late ?? false }));
    report.model.fallbacks = decided.filter(x => typeof x.reason !== 'string' || !x.reason.startsWith('model:')).length;
  }
  if (windowMs > 0) {
    const t0 = Date.now();
    const v0 = await agentView(agentId);
    const chainFrom = Number((await h.season()).record.latestUnix);
    await sleep(windowMs);
    const v1 = await agentView(agentId);
    const count = (v, type, pred = () => true) => v.history.filter(x => x.type === type && pred(x)).length;
    const calls = count(v1, 'spend', x => x.category === 'inference') - count(v0, 'spend', x => x.category === 'inference');
    const sent = count(v1, 'action', x => x.source === 'ai' && x.status === 'sent') - count(v0, 'action', x => x.source === 'ai' && x.status === 'sent');
    const refused = count(v1, 'action', x => x.source === 'ai' && x.status !== 'sent') - count(v0, 'action', x => x.source === 'ai' && x.status !== 'sent');
    const bells = { from: chainFrom, elapsedMs: Date.now() - t0 };
    const termsNow = (await api('/f/agent/terms')).body;
    const s1 = await h.season();
    report.window = { ms: windowMs, modelCalls: calls, costBaseUnits: String(BigInt(v1.balance.spent.inference) - BigInt(v0.balance.spent.inference)), actionsSent: sent, actionsRefused: refused,
      spentBefore: v0.balance.spent, spentAfter: v1.balance.spent, callsToday: v1.day?.calls ?? null, runner: termsNow.runner, chainSecondsElapsed: Number(s1.record.latestUnix) - bells.from,
      turnsElapsed: Math.floor((Number(s1.record.latestUnix) - bells.from) / 600) };
    check('measurement-window', report.window);
    ran.v = v1;
  }
  const aiLanded = await track(ran.ai[0].signature, { tries: 80, every: 500 });
  assert.equal(aiLanded.ok, true, json(aiLanded));
  if (!realModel) assert.ok(model.calls >= 2, 'the model server was called');
  const spends = ran.v.history.filter(x => x.type === 'spend');
  assert.ok(spends.length >= (windowMs > 0 ? 1 : 2) && spends.every(x => x.category === 'inference' && x.amount === String(price)), 'every USDC spend is a model call at the fixed price');
  assert.equal(ran.v.balance.spent.game, '0', 'Harvest stays free: no game charge');
  assert.equal(ran.v.balance.spent.network, '0', 'network fees are the relay\'s: recorded in lamports, never charged');
  const fees = ran.v.history.filter(x => x.type === 'network');
  assert.ok(fees.length >= 1 && fees.every(x => x.paidBy === 'relay' && x.amount === '0' && BigInt(x.lamports) > 0n));
  assert.equal(ran.v.delegation?.delegated, true, 'the chain names the agent key as the session key');
  check('runner-acted', { aiActions: ran.ai.length, modelCalls: realModel ? 'see report.model' : model.calls, landed: ran.ai[0].signature, tokens: spends[0]?.tokens ?? null, model: report.model,
    breakdown: { inferencePrice: String(price), inferenceCalls: spends.length, spent: ran.v.balance.spent, networkLamportsRecorded: fees.map(f => f.lamports) },
    history: ran.v.history.filter(x => ['spend', 'network', 'action'].includes(x.type)).slice(-12) });

  // 4. The agent's key around the gateway.
  const info = (await api('/f/relay')).body;
  const msg = shapeMessage({ programId: pin.programId, name: 'Harvest', accounts: accountsFor('Harvest', { ...player.context, actor: agentKey }), fields: {}, feePayer: info.feePayer, recentBlockhash: info.blockhash, profile: 2 });
  const forgedSig = new Uint8Array(64);
  const direct = await api('/f/relay', { tx: toBase64(wireTransaction(msg, { [agentKey]: forgedSig })) });
  assert.equal(direct.body.code, 'AgentKeyDirect', json(direct));
  check('agent-key-direct-refused', { code: direct.body.code, status: direct.status });

  // 5. Manual again: the agent stops, the runner stops, the owner takes the key back.
  const manual = await api('/f/agent/command', command(keypair, 'mode', { agentId, params: { mode: 'manual' } }));
  assert.equal(manual.body.agent.mode, 'manual', json(manual));
  const stopped = await api('/f/agent/action', { capability, request: request() });
  assert.equal(stopped.body.error?.code, 'AgentStopped', json(stopped));
  const stale = await api('/f/agent/action', { capability, request: request({ modeEpoch: epoch }) });
  assert.equal(stale.body.error?.code, 'AgentStopped');
  const callsAtStop = model.calls;
  const spendsAtStop = (await agentView(agentId)).history.filter(x => x.type === 'spend').length;
  const actionsAtStop = (await agentView(agentId)).history.filter(x => x.type === 'action' && x.source === 'ai').length;
  await sleep(2.5 * terms.body.runner.tickMs);
  const after = await agentView(agentId);
  assert.equal(after.history.filter(x => x.type === 'action' && x.source === 'ai').length, actionsAtStop, 'no new agent action after the stop');
  assert.equal(model.calls, callsAtStop, 'no model call after the stop');
  assert.equal(after.history.filter(x => x.type === 'spend').length, spendsAtStop, 'no new charge after the stop');
  assert.equal(after.balance.reserved, '0', 'nothing left reserved');
  assert.equal(after.delegation?.delegated, true, 'a server-side stop does not revoke the on-chain delegation: the owner\'s SetSession does');
  check('stopped', { modeEpoch: after.modeEpoch, refused: stopped.body.error.code, spentInference: after.balance.spent.inference, stillDelegatedOnChain: after.delegation.delegated });
  const back = await walletShape('SetSession', player, { session: session.publicKeyBytes, expiry: BigInt(s.record.latestUnix) + 7n * 86_400n });
  await action('Harvest', player, {});
  const revoked = await agentView(agentId);
  assert.equal(revoked.delegation?.delegated, false, 'after the owner\'s SetSession the chain no longer names the agent key');
  check('owner-plays-again', { setSession: back, delegatedOnChain: revoked.delegation.delegated });

  // 6. The unused balance goes back to the owner's wallet.
  const walletBefore = await tokenBalance(wallet.address);
  const w = await api('/f/agent/command', command(keypair, 'withdraw', { agentId, params: { all: true } }));
  assert.equal(w.status, 200, json(w));
  const done = await eventually('withdrawal done', async () => { const v = await agentView(agentId); const x = v.withdrawals.find(y => y.id === w.body.withdrawal.id); return x?.state === 'done' ? { v, x } : null; }, 60_000);
  const walletAfter = await tokenBalance(wallet.address);
  assert.equal(walletAfter - walletBefore, BigInt(done.x.amount), 'the owner\'s wallet received the withdrawal');
  const b = done.v.balance;
  assert.equal(b.available, '0');
  assert.equal(BigInt(b.deposited), BigInt(b.spent.inference) + BigInt(b.spent.game) + BigInt(b.withdrawn) + BigInt(b.reserved) + BigInt(b.pendingWithdraw), 'deposited = spent + withdrawn');
  assert.equal(BigInt(b.withdrawn) + BigInt(b.spent.inference) + BigInt(b.unresolved ?? 0) + BigInt(b.reserved), total);
  check('withdrawn', { signature: done.x.signature, amount: done.x.amount, balance: b, walletDelta: String(walletAfter - walletBefore) });
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`agent-wallet-e2e: ${report.checks.length} checks passed; transcript ${path.join(outDir, 'transcript.json')}`);
}

try {
  await run();
} finally {
  if (!realModel) modelServer.close();
}
