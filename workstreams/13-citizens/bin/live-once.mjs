#!/usr/bin/env node
// One step of the operator resident's live path, printed as JSON (2026-11-17). An explicit command: it does something
// only when run as `node workstreams/13-citizens/bin/live-once.mjs …`, once, and ends. No daemon, no timer, no loop.
//
//   node workstreams/13-citizens/bin/live-once.mjs \
//     --herald http://127.0.0.1:8080 --wallet <base58> --resident-dir /abs/path/to/resident \
//     [--board http://127.0.0.1:41873] [--rpc-url http://127.0.0.1:8899 --rpc-cluster localnet --rpc-source "<who declares it>"] \
//     [--acts-bin /abs/runexec --acts-db /abs/runs.db --acts-registry <name> --acts-agent <agent id> [--acts-gateway-port 8790] [--acts-bridge]]
//
// Nothing is signed, posted, submitted, registered, cancelled or joined; no model is called (the no-charge rule is
// fixed); no wallet, URL, registry or key is chosen for you: a missing setting is printed and the exit code is 64.
// When the resident is stopped, only its matched submitted keys' results are read (stop-A). With --acts-gateway-port,
// each such read also reads the agent wallet once and records the answer in workstream 4's run store (its own
// behaviour). Exit 0: a result (stopped, wait or proposal); 1: an error (code and a short message only); 64: usage.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { onceConfig, runOnce, RESULT_KIND } from '../resident/live/once.mjs';

const OPTIONS = {
  herald: { type: 'string' }, wallet: { type: 'string' }, 'resident-dir': { type: 'string' }, board: { type: 'string' },
  'rpc-url': { type: 'string' }, 'rpc-cluster': { type: 'string' }, 'rpc-source': { type: 'string' },
  'acts-bin': { type: 'string' }, 'acts-db': { type: 'string' }, 'acts-registry': { type: 'string' }, 'acts-agent': { type: 'string' },
  'acts-gateway-port': { type: 'string' }, 'acts-bridge': { type: 'boolean' },
};

/** The settings from the command line: only what was given; nothing is filled in. */
export function inputOf(v) {
  const any = (...k) => k.some(x => v[x] !== undefined);
  return {
    heraldUrl: v.herald, wallet: v.wallet, residentDir: v['resident-dir'],
    ...(v.board !== undefined ? { boardUrl: v.board } : {}),
    ...(any('rpc-url', 'rpc-cluster', 'rpc-source') ? { rpc: { url: v['rpc-url'], cluster: v['rpc-cluster'], source: v['rpc-source'] } } : {}),
    ...(any('acts-bin', 'acts-db', 'acts-registry', 'acts-agent', 'acts-gateway-port', 'acts-bridge') ? { actsStatus: {
      bin: v['acts-bin'], db: v['acts-db'], registry: v['acts-registry'], agentId: v['acts-agent'],
      ...(v['acts-gateway-port'] !== undefined ? { gatewayPort: /^\d+$/.test(v['acts-gateway-port']) ? Number(v['acts-gateway-port']) : NaN } : {}),
      ...(v['acts-bridge'] ? { bridge: true } : {}),
    } } : {}),
  };
}

/** (2026-11-17) one classification of results for the command: settings → 64, error → 1, a result → 0. */
export const exitOf = r => (r?.outcome === 'config-missing' || r?.outcome === 'usage' ? 64 : r?.outcome === 'error' ? 1 : ['stopped', 'wait', 'proposal'].includes(r?.outcome) ? 0 : 1);

export async function main(argv = process.argv.slice(2), { print = s => process.stdout.write(`${s}\n`), run = runOnce } = {}) {
  let v;
  try { ({ values: v } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false })); }
  catch (e) { print(JSON.stringify({ kind: RESULT_KIND, outcome: 'usage', why: String(e?.message ?? e).slice(0, 160) })); return 64; }
  const c = onceConfig(inputOf(v));
  if (!c.ok) { print(JSON.stringify({ kind: RESULT_KIND, outcome: 'config-missing', missing: c.missing, refused: c.refused })); return 64; }
  const r = await run(c.config);
  print(JSON.stringify(r, null, 2));
  return exitOf(r);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
