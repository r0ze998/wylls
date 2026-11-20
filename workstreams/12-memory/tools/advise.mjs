// Workstream 12's optional public-evidence reader as a command (adapters/public-evidence-reader.mjs), for an external
// AI resident (⑤ B) written in any language: one read-only answer about some wallets, printed as one JSON line.
//   node workstreams/12-memory/tools/advise.mjs --herald URL --about WALLET[,WALLET…]
//        [--rpc URL --rpc-cluster CLUSTER --rpc-source TEXT]                      (finality: one getSlot(finalized))
//        [--store PATH --ws04-world ID --binding-program ID --binding-season ADDRESS --binding-source TEXT]
//                                                     (4's store, read-only, and who declares it is this herald's world)
//        [--max-counterparties N] [--max-facts N] [--max-event-pages N]
// Off unless run: nothing in the game or in ⑤ A calls it. It sends only GETs to the herald (and the one RPC read when
// given), writes nothing, signs nothing and makes no key. Exit 0 with the answer; 64 on a usage error.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPublicEvidenceReader } from '../adapters/public-evidence-reader.mjs';
import { readWs04Store } from '../adapters/canonical.mjs';

export async function getJson(url, { ms = 5000 } = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { ok: r.ok, status: r.status, body };
}
export async function rpc(url, method, params, { ms = 5000 } = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? 'error'}`);
  return j.result;
}

const int = v => (v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : NaN);

export async function main(argv = process.argv.slice(2), { io = { getJson, rpc, readStore: readWs04Store }, print = s => process.stdout.write(`${s}\n`) } = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, options: {
      herald: { type: 'string' }, about: { type: 'string' },
      rpc: { type: 'string' }, 'rpc-cluster': { type: 'string' }, 'rpc-source': { type: 'string' },
      store: { type: 'string' }, 'ws04-world': { type: 'string' }, 'binding-program': { type: 'string' }, 'binding-season': { type: 'string' }, 'binding-source': { type: 'string' },
      'max-counterparties': { type: 'string' }, 'max-facts': { type: 'string' }, 'max-event-pages': { type: 'string' },
    } }).values;
    if (!a.herald || !a.about) throw new Error('--herald and --about are required');
    if (a.rpc && !(a['rpc-cluster'] && a['rpc-source'])) throw new Error('--rpc needs --rpc-cluster and --rpc-source (which world the RPC serves is a declaration)');
    if (a.store && !['ws04-world', 'binding-program', 'binding-season', 'binding-source'].every(k => a[k])) throw new Error('--store needs --ws04-world, --binding-program, --binding-season and --binding-source');
    for (const k of ['max-counterparties', 'max-facts', 'max-event-pages']) if (Number.isNaN(int(a[k]))) throw new Error(`--${k} must be a whole number`);
  } catch (e) { process.stderr.write(`advise: ${e.message}\n`); return 64; }
  const reader = createPublicEvidenceReader({
    heraldUrl: a.herald, io,
    ...(a.rpc ? { rpcUrl: a.rpc, rpcBinding: { rpcUrl: a.rpc, cluster: a['rpc-cluster'], source: a['rpc-source'] } } : {}),
    ...(a.store ? { storePath: a.store, binding: { ws04World: a['ws04-world'], programId: a['binding-program'], seasonAddress: a['binding-season'], source: a['binding-source'] } } : {}),
    recall: { counterparties: int(a['max-counterparties']), factsPerCounterparty: int(a['max-facts']), eventPages: int(a['max-event-pages']) },
  });
  const answer = await reader.advise({ about: a.about.split(',').map(s => s.trim()).filter(Boolean) });
  print(JSON.stringify(answer, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
