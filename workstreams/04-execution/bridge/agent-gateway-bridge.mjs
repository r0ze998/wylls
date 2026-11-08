// Test bridge (workstream 04): the agent wallet's gateway — with workstream
// 03's patch 0005 (SendCaravan) and workstream 05's patch 0001 (limits)
// applied on this branch — served over loopback HTTP to the run executor's
// gateway port (src/gateway.rs).
//
// MOCK: the chain behind the gateway is the agent wallet tests' scripted
// chain (permutation-gateway/test/agent-wallet-fixtures.mjs): it simulates,
// signs-checks and "finalizes" every transaction at once. Nothing reaches a
// real chain, a real relay key, a wallet or a paid API. Test keys are made
// fresh in memory and never written.
//
//   node agent-gateway-bridge.mjs        prints "PORT <n>" once listening on 127.0.0.1
//
//   POST /setup   {allowed?, expiresAt?, prices?, budget?}  a fresh relay, owner and agent in auto mode
//   POST /action  {request, fault?: 'drop'|'sendThrows'}   the gateway's POST /f/agent/action
//   GET  /history                                          the agent's public view (GET /f/agent?id=)
//   GET  /tx?sig=                                          a sent transaction: its SendCaravan data, source
//   GET  /fate?key=                                        the gateway's GET /f/agent/fate for this agent and key
//   POST /mode    {mode}                                   the owner's mode command (auto | manual)
//   GET  /chain                                            how many transactions the chain received
//   GET  /oracle/sent                                      test oracle: every signature the chain received
import http from 'node:http';
import { createRequire } from 'node:module';
import { A, VILLAGE, call, createAgent, delegate, ownerCommand, policy, relay } from '../../../permutation-gateway/test/agent-wallet-fixtures.mjs';
import { PRESETS as V2 } from '../../../permutation-gateway/client/src/frontier/abi-v2-presets.mjs';

const require = createRequire(new URL('../../../permutation-gateway/package.json', import.meta.url));
const { Keypair } = require('@solana/web3.js');

const hexBytes = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const S1 = { RULESET_HASH: hexBytes(V2.ruleset_hash_v3), LAYOUT_VERSION: 2, PROGRAM_VERSION: 4 };
const hex = b => Buffer.from(b).toString('hex');

let world = null;

async function setup({ allowed = ['transport'], expiresAt, prices = {}, budget } = {}) {
  const r = relay({ season: S1, prices });
  const owner = Keypair.generate();
  const p = { ...policy(allowed), ...(budget ? { budget } : {}), ...(expiresAt ? { expiresAt } : {}) };
  const made = await createAgent(r, owner, { policy: p });
  delegate(r, owner.publicKey.toBase58(), made.agentKey);
  await call(r.public, 'POST', '/f/agent/command', { body: ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }), ip: '127.0.0.1' });
  world = { r, owner, ...made, sendThrows: false };
  // A send that leaves (the chain records and finalizes it) but whose call
  // throws on the way back: the gateway signed it, cannot say it landed.
  const send = r.chain.sendRawTransaction;
  r.chain.sendRawTransaction = async raw => {
    const sig = await send(raw);
    if (world.sendThrows) {
      world.sendThrows = false;
      throw new Error('bridge fault: the RPC connection dropped after the send');
    }
    return sig;
  };
  return { agentId: made.agentId, agentKey: made.agentKey, policyVersion: 1, village: VILLAGE };
}

async function action({ request, fault }) {
  world.actions = (world.actions ?? 0) + 1;
  if (fault === 'sendThrows') world.sendThrows = true;
  const res = await call(world.r.public, 'POST', '/f/agent/action', { body: { capability: world.capability, request: { agentId: world.agentId, ...request } }, ip: '127.0.0.1' });
  if (fault === 'drop') return { status: 504, body: { error: 'bridge fault: response dropped after the gateway answered' } };
  return { status: res.status ?? 200, body: res.json };
}

function tx(sig) {
  const t = world.r.chain.sent.find(x => Buffer.from(x.signatures[0]).equals(Buffer.from(require('bs58').decode(sig))));
  if (!t) return { found: false };
  const ix = t.instructions.at(-1);
  const src = ix.keys[4].pubkey;
  return {
    found: true,
    data: hex(ix.data),
    actor: ix.keys[0].pubkey,
    srcIsVillage: src === A.holding(VILLAGE[0], VILLAGE[1], VILLAGE[2]),
    finalized: world.r.chain.statuses.get(sig)?.confirmationStatus === 'finalized',
  };
}

async function route(method, url, body) {
  const u = new URL(url, 'http://x');
  if (method === 'POST' && u.pathname === '/setup') return { status: 200, body: await setup(body) };
  if (!world) return { status: 409, body: { error: 'POST /setup first' } };
  if (method === 'POST' && u.pathname === '/action') return action(body);
  if (method === 'GET' && u.pathname === '/history') {
    const v = await call(world.r.public, 'GET', `/f/agent?id=${encodeURIComponent(world.agentId)}`, { ip: '127.0.0.1' });
    return { status: 200, body: v.json };
  }
  if (method === 'GET' && u.pathname === '/tx') return { status: 200, body: tx(u.searchParams.get('sig')) };
  if (method === 'GET' && u.pathname === '/fate') {
    const v = await call(world.r.public, 'GET', `/f/agent/fate?id=${encodeURIComponent(world.agentId)}&key=${encodeURIComponent(u.searchParams.get('key') ?? '')}`, { ip: '127.0.0.1' });
    return { status: v.status ?? 200, body: v.json };
  }
  if (method === 'POST' && u.pathname === '/mode') {
    const r = await call(world.r.public, 'POST', '/f/agent/command', { body: ownerCommand(world.owner, 'mode', { agentId: world.agentId, params: { mode: body.mode } }), ip: '127.0.0.1' });
    return { status: 200, body: r.json };
  }
  if (method === 'GET' && u.pathname === '/chain') return { status: 200, body: { sent: world.r.chain.sent.length, actions: world.actions ?? 0 } };
  // Test oracle only: every signature the scripted chain received (a caller
  // of the gateway has no such view; the tests use it to model "the chain
  // has it" when the gateway's answer names no signature).
  if (method === 'GET' && u.pathname === '/oracle/sent') {
    const bs58 = require('bs58');
    return { status: 200, body: { signatures: world.r.chain.sent.map(t => bs58.encode(Buffer.from(t.signatures[0]))) } };
  }
  return { status: 404, body: { error: 'no such route' } };
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', async () => {
    let out;
    try {
      out = await route(req.method, req.url, raw ? JSON.parse(raw) : {});
    } catch (e) {
      out = { status: 500, body: { error: String(e?.stack ?? e) } };
    }
    const b = Buffer.from(JSON.stringify(out.body));
    res.writeHead(out.status, { 'content-type': 'application/json', 'content-length': b.length, connection: 'close' });
    res.end(b);
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`PORT ${server.address().port}\n`));
