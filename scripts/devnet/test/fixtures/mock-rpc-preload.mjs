// Test-only preload (verify-pr215): replaces fetch with an in-memory devnet RPC and shifts the clock, so a sender
// script runs end to end with no network. MOCK_RPC (JSON) = { nowMs, genesis, accounts: { addr: {owner, lamports,
// data(base64)} }, balances: { addr: n }, simErr, logFile }. Every call is appended to logFile as a JSON line.
// Never used by the scripts themselves; it names no key and signs nothing.
import { appendFileSync } from 'node:fs';

const cfg = JSON.parse(process.env.MOCK_RPC);
const realNow = Date.now.bind(Date);
const start = realNow();
Date.now = () => cfg.nowMs + (realNow() - start);

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  appendFileSync(cfg.logFile, JSON.stringify({ url, method: body.method, params: body.params }) + '\n');
  const ok = result => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  const p = body.params ?? [];
  switch (body.method) {
    case 'getGenesisHash': return ok(cfg.genesis);
    case 'getAccountInfo': {
      const a = cfg.accounts[p[0]];
      return ok({ context: { slot: 1 }, value: a ? { owner: a.owner, lamports: a.lamports, data: [a.data, 'base64'], executable: false } : null });
    }
    case 'getBalance': return ok({ context: { slot: 1 }, value: cfg.balances?.[p[0]] ?? 0 });
    case 'getLatestBlockhash': return ok({ context: { slot: 1 }, value: { blockhash: '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn', lastValidBlockHeight: 9 } });
    case 'simulateTransaction': return ok({ context: { slot: 1 }, value: { err: cfg.simErr ?? null, unitsConsumed: 4321, logs: ['Program log: mock abort'] } });
    default: return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: `mock: ${body.method} not served` } }), { status: 200 });
  }
};
