#!/usr/bin/env node
// One read-only observation of the live canonical sources, as a resident would see it (2026-11-16). The composition
// root: it imports workstream 12's live observation and workstream 13's live evidence port and prints, as JSON:
// the world, the clock, the provenance and its basis, every held receipt and missing input with its reason, and
// what the port answers about each `--about` wallet at the current world bell.
//
// This is a command, not a resident: it starts no resident, no world and no server, and it is not the gateway's
// operator agent runner. No single production assembly of a resident exists in this tree (the only one is
// world/harness.mjs, a test world on its own clock); this command does not make one.
//
//   node workstreams/13-citizens/bin/observe-canonical.mjs \
//     --herald http://127.0.0.1:8080 --rpc http://127.0.0.1:8899 --store path/to/runexec.sqlite \
//     --binding binding.json --rpc-binding rpc-binding.json \
//     --herald-kind chain --rpc-kind chain --store-kind integration-output \
//     --wallet <base58> [--wallet …] [--about <base58> …] [--max-event-pages 64]
//
//   binding.json      {"ws04World": "…", "programId": "…", "seasonAddress": "…", "source": "who declares it"}
//   rpc-binding.json  {"rpcUrl": "http://…", "cluster": "<as /h/season says>", "source": "who declares it"}
//
// Requests: GET to the herald only (/h/season, /h/events, /h/me/{wallet}); one POST to the RPC, JSON-RPC getSlot
// at commitment 'finalized' (live-observation.mjs RPC_METHODS). The store is opened read-only. Nothing is written,
// signed or sent; no key is read or made. Exit 0: connected; 2: held or no world; 64: usage.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { observeLive, RPC_METHODS } from '../../12-memory/adapters/live-observation.mjs';
import { ws12EvidencePort } from '../../12-memory/adapters/canonical.mjs';
import { liveCanonicalEvidence } from '../resident/ports/live-canonical.mjs';
import { seasonClock } from '../resident/frame.mjs';

const TIMEOUT_MS = 10_000;

/** GET only, JSON only. */
export async function getJson(url) {
  const r = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, status: r.status, body: await r.json() };
}

/** One JSON-RPC read; any method outside RPC_METHODS is refused before a request is made. */
export async function rpc(url, method, params) {
  if (!RPC_METHODS.includes(method)) throw new Error(`rpc method ${method} is not a read this command makes`);
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`rpc error ${j.error.code ?? ''}`);
  return j?.result;
}

const json = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 1);
const readDecl = p => (p ? JSON.parse(readFileSync(p, 'utf8')) : null);

export async function main(argv = process.argv.slice(2), { io = { getJson, rpc }, print = s => process.stdout.write(`${s}\n`) } = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, options: {
      herald: { type: 'string' }, rpc: { type: 'string' }, store: { type: 'string' },
      binding: { type: 'string' }, 'rpc-binding': { type: 'string' },
      'herald-kind': { type: 'string' }, 'rpc-kind': { type: 'string' }, 'store-kind': { type: 'string' },
      wallet: { type: 'string', multiple: true }, about: { type: 'string', multiple: true }, 'max-event-pages': { type: 'string' },
    }, strict: true }).values;
  } catch (e) { print(json({ error: 'usage', why: e.message })); return 64; }
  if (!a.herald || !a.rpc || !a.store) { print(json({ error: 'usage', why: '--herald, --rpc and --store are required' })); return 64; }
  const pages = a['max-event-pages'] === undefined ? undefined : Number(a['max-event-pages']);
  if (pages !== undefined && !(Number.isSafeInteger(pages) && pages > 0)) { print(json({ error: 'usage', why: '--max-event-pages' })); return 64; }
  let binding, rpcBinding;
  try { binding = readDecl(a.binding); rpcBinding = readDecl(a['rpc-binding']); } catch (e) { print(json({ error: 'usage', why: `declaration file: ${e.message}` })); return 64; }
  const obs = await observeLive({
    heraldUrl: a.herald, rpcUrl: a.rpc, storePath: a.store, binding, rpcBinding,
    wallets: [...(a.wallet ?? []), ...(a.about ?? [])], maxEventPages: pages,
    kinds: { herald: a['herald-kind'], rpc: a['rpc-kind'], store: a['store-kind'] }, io,
  });
  // The resident's clock here is the Season bell of the same numbers (a resident on another clock reads nothing).
  const residentClock = obs.clock ? seasonClock(obs.clock) : undefined;
  const port = liveCanonicalEvidence({ ws12EvidencePort, observation: obs, residentClock });
  const bell = obs.observedBell ?? null;
  print(json({
    status: obs.status, reasons: obs.reasons, world: obs.world, clock: obs.clock, provenance: obs.provenance,
    basis: port.basis, basisWhy: port.basisWhy, inputs: obs.inputs, ingest: obs.ingest ?? null, identity: obs.identitySummary ?? null,
    held: obs.held,
    worldBell: bell,
    about: (a.about ?? []).map(w => ({ wallet: w, ...(Number.isSafeInteger(bell) ? port.read({ counterparty: w, worldBell: bell }) : { status: 'clock_unverified', lines: [], facts: [] }) })),
  }));
  return obs.status === 'ok' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
