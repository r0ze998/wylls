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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
// Scenario 'unresolved' (DESIGN.md §6.5, the deadline rule tried on localnet): the stand-in holds the first model call open,
// the relay is killed (-9) while the call runs, the stack's supervisor restarts it, the hold comes back 'unresolved'
// (reserved, not charged, not refunded); the owner stops the agent and withdraws: the unresolved amount stays. With
// AGENT_E2E_WAIT_RELEASE_MS > 0 the run then waits for the relay's deadline (FRONTIER_AGENT_UNRESOLVED_RELEASE_MS) and
// checks the release: the money is available again, the day's call count did not go back, the operator's record has the
// call, a withdrawal empties the agent. Needs AGENT_E2E_RUN_DIR (the stack's run directory: the relay's pid is found by
// its state file; the operator token is read from relay/operator.token) and AGENT_E2E_OPERATOR_URL (the relay's operator
// listener, loopback).
const scenario = process.env.AGENT_E2E_SCENARIO ?? null;
const runDir = process.env.AGENT_E2E_RUN_DIR ?? null;
const operatorUrl = process.env.AGENT_E2E_OPERATOR_URL ?? null;
const waitReleaseMs = Number(process.env.AGENT_E2E_WAIT_RELEASE_MS ?? 0);
if (scenario === 'unresolved') { assert.ok(runDir && operatorUrl, 'AGENT_E2E_RUN_DIR and AGENT_E2E_OPERATOR_URL are needed'); assert.ok(!realModel, 'the scenario uses the stand-in (a held call)'); }
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
const model = { calls: 0, stalled: null, onStall: null };
const modelServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    model.calls++;
    const b = JSON.parse(body || '{}');
    assert.equal(JSON.stringify(b).includes('capability'), false, 'the model never sees a token');
    // Scenario 'unresolved': the first call is held open (never answered); the relay is killed while it waits. Later calls rest.
    if (scenario === 'unresolved' && model.calls === 1) { model.stalled = { at: new Date().toISOString(), messages: b.messages?.length ?? null }; model.onStall?.(); req.socket.on('close', () => { model.stalledClosed = new Date().toISOString(); }); return; }
    const answer = scenario === 'unresolved' ? { action: 'rest', fields: {}, reason: 'e2e scenario: rest' } : { action: 'Harvest', fields: {}, reason: 'e2e' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 6 } }));
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
} else report.model = { mode: 'stand-in', port: modelPort, answers: scenario === 'unresolved' ? 'the first call is held open, later calls rest' : 'Harvest, every call' };

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
// The operator listener (loopback) with the stack's token: never printed, never in the transcript.
const operatorToken = scenario === 'unresolved' ? readFileSync(path.join(runDir, 'relay', 'operator.token'), 'utf8').trim() : null;
const operatorApi = async (method, p, body) => { const r = await fetch(operatorUrl + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
/** The relay's pid under the stack: the node process whose command names this run's relay state file. */
function relayPid() {
  const out = execSync(`pgrep -f -- "${path.join(runDir, 'relay', 'relay-state.json')}" || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  const pids = out.filter(pid => { try { return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).includes('server.mjs'); } catch { return false; } });
  assert.equal(pids.length, 1, `relay pid: ${JSON.stringify(out)}`);
  return pids[0];
}

/**
 * Scenario 'unresolved' (see the header): a model call in flight, the relay killed and restarted, the hold unresolved;
 * stop and withdraw around it; then (optionally) the deadline release.
 */
async function unresolvedScenario({ agentId, keypair, price, total, wallet }) {
  const sc = (report.scenario = { name: 'unresolved', releaseMs: null, steps: [] });
  const step = (name, details) => { sc.steps.push({ name, at: new Date().toISOString(), ...details }); check(`scenario-${name}`, details); };
  // a. The runner asks the stand-in; the call is held open; the ledger shows a running hold.
  await new Promise(res => { if (model.stalled) res(); else model.onStall = res; });
  const running = await eventually('a running inference hold', async () => { const v = await agentView(agentId); const h = v.holds.find(x => x.category === 'inference' && x.state === 'running'); return h ? { v, h } : null; }, 30_000);
  const pid = relayPid();
  step('call-in-flight', { holdId: running.h.id, key: running.h.key, amount: running.h.amount, state: running.h.state, callsToday: running.v.day.calls, reserved: running.v.balance.reserved, modelCalls: model.calls, relayPid: pid });
  // b. kill -9 the relay while the call runs; the supervisor restarts it (2 s); recover() marks the running hold unresolved.
  process.kill(pid, 'SIGKILL');
  const killedAt = Date.now();
  const back = await eventually('the relay back after the kill', async () => { try { const t = await api('/f/agent/terms'); return t.status === 200 ? t.body : null; } catch { return null; } }, 120_000);
  const pid2 = await eventually('a new relay pid', async () => { try { const p = relayPid(); return p !== pid ? p : null; } catch { return null; } }, 30_000);
  const unresolved = await eventually('the hold unresolved', async () => { const v = await agentView(agentId); const h = v.holds.find(x => x.id === running.h.id); return h?.state === 'unresolved' ? { v, h } : null; }, 60_000);
  const rec = await operatorApi('GET', '/f/agent/unresolved');
  assert.equal(rec.status, 200, json(rec));
  const mine = rec.body.holds.find(x => x.id === running.h.id);
  assert.ok(mine, json(rec.body));
  assert.equal(mine.unresolvedReason, 'restart');
  const cost = rec.body.operatorCosts.find(x => x.holdId === running.h.id && x.kind === 'unknown-call');
  assert.ok(cost, 'the operator record has the unknown call');
  sc.releaseMs = rec.body.unresolvedReleaseMs ?? null;
  assert.equal(unresolved.v.balance.unresolved, String(price));
  assert.equal(unresolved.v.balance.reserved, String(price));
  assert.equal(unresolved.v.balance.spent.inference, '0', 'nothing charged for a call whose outcome the relay never saw');
  step('relay-restarted', { killedAt: new Date(killedAt).toISOString(), downMs: Date.now() - killedAt, oldPid: pid, newPid: pid2, stalledClosed: model.stalledClosed ?? null, runner: back.runner,
    hold: { id: running.h.id, state: unresolved.h.state, reason: mine.unresolvedReason }, balance: unresolved.v.balance, callsToday: unresolved.v.day.calls, operatorRecord: cost, unresolvedReleaseMs: sc.releaseMs, modelCallsAfterRestart: model.calls - 1 });
  // c. The owner stops the agent and withdraws everything: the unresolved amount stays reserved (not withdrawable, not charged).
  const manual = await api('/f/agent/command', command(keypair, 'mode', { agentId, params: { mode: 'manual' } }));
  assert.equal(manual.body.agent.mode, 'manual', json(manual));
  const callsAtStop = (await agentView(agentId)).day.calls;
  const walletBefore = await tokenBalance(wallet.address);
  const w1 = await api('/f/agent/command', command(keypair, 'withdraw', { agentId, params: { all: true } }));
  assert.equal(w1.status, 200, json(w1));
  const done1 = await eventually('first withdrawal done', async () => { const v = await agentView(agentId); const x = v.withdrawals.find(y => y.id === w1.body.withdrawal.id); return x?.state === 'done' ? { v, x } : null; }, 60_000);
  const b1 = done1.v.balance;
  assert.equal(b1.available, '0');
  assert.equal(b1.unresolved, String(price), 'the unresolved call stays reserved through a full withdrawal');
  assert.equal(b1.reserved, String(price));
  assert.equal(BigInt(done1.x.amount), total - price - BigInt(b1.spent.inference), 'everything but the unresolved call (and any charged rest) came back');
  step('stopped-and-withdrew', { withdrawal: { id: done1.x.id, amount: done1.x.amount, signature: done1.x.signature }, balance: b1, walletDelta: String((await tokenBalance(wallet.address)) - walletBefore), callsToday: callsAtStop });
  if (!(waitReleaseMs > 0)) { report.finishedAt = new Date().toISOString(); save(); console.log(`agent-wallet-e2e (scenario unresolved, no wait): ${report.checks.length} checks passed; transcript ${path.join(outDir, 'transcript.json')}`); return; }
  // d. The deadline: the relay releases the unresolved hold after FRONTIER_AGENT_UNRESOLVED_RELEASE_MS (reconcile); nothing is charged.
  assert.ok(sc.releaseMs > 0, 'the relay was started without FRONTIER_AGENT_UNRESOLVED_RELEASE_MS');
  const t0 = Date.now();
  const released = await eventually('the deadline release', async () => { const v = await agentView(agentId); if (v.balance.unresolved !== '0') return null; return v; }, waitReleaseMs);
  const waited = Date.now() - t0;
  const rel = released.history.find(x => x.type === 'release' && x.key === running.h.key);
  assert.ok(rel && rel.reason === 'auto-release', json(released.history.slice(-5)));
  assert.equal(released.balance.available, String(price), 'the money is available again');
  assert.equal(released.balance.reserved, '0');
  assert.equal(released.balance.spent.inference, b1.spent.inference, 'nothing charged by the release');
  assert.equal(released.day.calls, callsAtStop, 'the day\'s call count does not go back when a hold is released');
  const rec2 = await operatorApi('GET', '/f/agent/unresolved');
  const relCost = rec2.body.operatorCosts.find(x => x.holdId === running.h.id && x.kind === 'released-call');
  assert.ok(relCost, json(rec2.body.operatorCosts));
  assert.equal(rec2.body.holds.find(x => x.id === running.h.id), undefined);
  step('released-at-deadline', { waitedMs: waited, sinceUnresolvedMs: Date.now() - killedAt, releaseMs: sc.releaseMs, release: rel, balance: released.balance, callsToday: released.day.calls, operatorRecord: relCost, settlements: rec2.body.settlements.length });
  // e. The owner's cap counts the released call: with callsPerDay = today's count, auto makes no model call (the autopilot plays, free).
  const cap = released.day.calls;
  const pol = await api('/f/agent/command', command(keypair, 'policy', { agentId, params: { policy: { allowed: ['economy'], budget: { total: '1000000', perDay: '500000', callsPerDay: cap } } } }));
  assert.equal(pol.status, 200, json(pol));
  const callsBefore = model.calls;
  const auto2 = await api('/f/agent/command', command(keypair, 'mode', { agentId, params: { mode: 'auto' } }));
  assert.equal(auto2.body.agent.mode, 'auto', json(auto2));
  const acted = await eventually('the autopilot acted without a model call', async () => { const v = await agentView(agentId); const ai = v.history.filter(x => x.type === 'action' && x.source === 'ai' && x.status === 'sent'); return ai.length >= 1 ? { v, ai } : null; }, 60_000);
  await sleep(2.5 * back.runner.tickMs);
  assert.equal(model.calls, callsBefore, 'the stand-in was not asked: the cap counted the released call');
  const v2 = await agentView(agentId);
  assert.equal(v2.day.calls, cap);
  assert.equal(v2.balance.spent.inference, released.balance.spent.inference, 'no charge');
  const manual2 = await api('/f/agent/command', command(keypair, 'mode', { agentId, params: { mode: 'manual' } }));
  assert.equal(manual2.body.agent.mode, 'manual');
  step('cap-counts-released-call', { callsPerDay: cap, callsToday: v2.day.calls, modelCallsDuringAuto: model.calls - callsBefore, autopilotActions: acted.ai.map(x => ({ name: x.name, signature: x.signature ?? null })), spentInference: v2.balance.spent.inference });
  // f. The rest comes back; the books balance.
  const w2 = await api('/f/agent/command', command(keypair, 'withdraw', { agentId, params: { all: true } }));
  assert.equal(w2.status, 200, json(w2));
  const done2 = await eventually('second withdrawal done', async () => { const v = await agentView(agentId); const x = v.withdrawals.find(y => y.id === w2.body.withdrawal.id); return x?.state === 'done' ? { v, x } : null; }, 60_000);
  const b2 = done2.v.balance;
  assert.equal(b2.available, '0'); assert.equal(b2.reserved, '0'); assert.equal(b2.unresolved, '0');
  assert.equal(BigInt(b2.deposited), BigInt(b2.spent.inference) + BigInt(b2.spent.game) + BigInt(b2.withdrawn) + BigInt(b2.reserved) + BigInt(b2.pendingWithdraw), 'deposited = spent + withdrawn');
  assert.equal(BigInt(b2.withdrawn) + BigInt(b2.spent.inference), total);
  step('withdrawn-all', { withdrawal: { id: done2.x.id, amount: done2.x.amount, signature: done2.x.signature }, balance: b2, walletDelta: String((await tokenBalance(wallet.address)) - walletBefore) });
  report.finishedAt = new Date().toISOString();
  save();
  console.log(`agent-wallet-e2e (scenario unresolved): ${report.checks.length} checks passed; transcript ${path.join(outDir, 'transcript.json')}`);
}

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
  if (scenario === 'unresolved') return unresolvedScenario({ agentId, keypair, price, total, wallet });

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
    const statsAtStart = (await api('/f/agent/terms')).body.runner?.stats ?? null;
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
    // The breakdown (DESIGN.md §12.2): calls the model answered with an action it sent, calls refused on chain, calls the code refused
    // (a failed call: the autopilot then plays free), rests; and the autopilot's own free actions. Each model call is charged once.
    // A refusal on chain leaves no action line in the ledger's history (the independent review of 2026-10-17 found the count read as
    // a rest), so the refusals and the rests come from the runner's own outcome counters (terms.runner.stats.outcomes, the window's
    // delta; this agent is the only one in auto on the relay during the window), the rest from the history.
    const since = v1.history.slice(v0.history.length);
    const isModel = x => typeof x.reason === 'string' && x.reason.startsWith('model:');
    const byModelSent = since.filter(x => x.type === 'action' && x.source === 'ai' && x.status === 'sent' && isModel(x)).length;
    const autopilotSent = since.filter(x => x.type === 'action' && x.source === 'ai' && x.status === 'sent' && !isModel(x)).length;
    const failedCalls = since.filter(x => x.type === 'spend' && x.category === 'inference' && x.ok === false).length;
    const delta = k => (termsNow.runner?.stats?.outcomes?.[k] ?? 0) - (statsAtStart?.outcomes?.[k] ?? 0);
    const byModelRefused = termsNow.runner?.stats?.outcomes ? delta('refused') : null;
    const rests = termsNow.runner?.stats?.outcomes ? delta('rest') : Math.max(0, calls - byModelSent - failedCalls);
    report.window = { ms: windowMs, modelCalls: calls, costBaseUnits: String(BigInt(v1.balance.spent.inference) - BigInt(v0.balance.spent.inference)), actionsSent: sent, actionsRefused: refused,
      breakdown: { modelActionsSent: byModelSent, modelActionsRefusedOnChain: byModelRefused, callsRefusedByCode: failedCalls, rests, autopilotActionsFree: autopilotSent, source: 'history for sent/failed; runner outcomes for refused/rests' },
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
