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
//     [--ws04-observation page.json | --runexec <bin> (--ws04-store <findex store dir> | --ws04-db <index.sqlite>)
//      [--ws04-after <n>] [--ws04-limit <1..=256>]]
//
//   binding.json      {"ws04World": "…", "programId": "…", "seasonAddress": "…", "source": "who declares it"}
//   rpc-binding.json  {"rpcUrl": "http://…", "cluster": "<as /h/season says>", "source": "who declares it"}
//   page.json         workstream 4's `ws04-observation/0` page (runexec observation::read_observations): shown held,
//                     with every reason as given; never ingested (12 adapters/ws04-observation.mjs). runexec's
//                     `observe store|db` prints such a page (one JSON line).
//   --runexec + --ws04-store / --ws04-db  instead of a file: runs `runexec observe store|db` once, read-only, through
//                     resident/ports/ws04-observe.mjs (execFile, no shell), and hands its page to 12 the same way. A
//                     failure is printed as `ws04Read` with runexec's own code (BadRequest, ObservationNotRead, Spawn),
//                     never as "no record"; the rest of the observation goes on. At most one page source is given.
//
// Requests: GET to the herald only (/h/season, /h/events, /h/me/{wallet}); one POST to the RPC, JSON-RPC getSlot
// at commitment 'finalized' (live-observation.mjs RPC_METHODS). The store is opened read-only. Nothing is written,
// signed or sent; no key is read or made. Exit 0: connected; 2: held or no world; 64: usage.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { observeLive, RPC_METHODS } from '../../12-memory/adapters/live-observation.mjs';
import { ws12EvidencePort } from '../../12-memory/adapters/canonical.mjs';
import { parseJsonU64 } from '../../12-memory/adapters/ws04-receipts.mjs';
import { liveCanonicalEvidence } from '../resident/ports/live-canonical.mjs';
import { seasonClock } from '../resident/frame.mjs';
import { readOnlyResidentPreflight } from '../resident/assembly.mjs';
import { ws04ObserveClient } from '../resident/ports/ws04-observe.mjs';
import { execFile as nodeExecFile } from 'node:child_process';

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

export async function main(argv = process.argv.slice(2), { io = { getJson, rpc }, print = s => process.stdout.write(`${s}\n`), execFile = nodeExecFile } = {}) {
  let a;
  try {
    a = parseArgs({ args: argv, options: {
      herald: { type: 'string' }, rpc: { type: 'string' }, store: { type: 'string' },
      binding: { type: 'string' }, 'rpc-binding': { type: 'string' },
      'herald-kind': { type: 'string' }, 'rpc-kind': { type: 'string' }, 'store-kind': { type: 'string' },
      wallet: { type: 'string', multiple: true }, about: { type: 'string', multiple: true }, 'max-event-pages': { type: 'string' },
      'ws04-observation': { type: 'string' },
      runexec: { type: 'string' }, 'ws04-store': { type: 'string' }, 'ws04-db': { type: 'string' },
      'ws04-after': { type: 'string' }, 'ws04-limit': { type: 'string' },
    }, strict: true }).values;
  } catch (e) { print(json({ error: 'usage', why: e.message })); return 64; }
  if (!a.herald || !a.rpc || !a.store) { print(json({ error: 'usage', why: '--herald, --rpc and --store are required' })); return 64; }
  const pages = a['max-event-pages'] === undefined ? undefined : Number(a['max-event-pages']);
  if (pages !== undefined && !(Number.isSafeInteger(pages) && pages > 0)) { print(json({ error: 'usage', why: '--max-event-pages' })); return 64; }
  // 4's page: from a file, or from `runexec observe` (one source at most; checked before anything is read or started)
  const sources = ['ws04-observation', 'ws04-store', 'ws04-db'].filter(k => a[k] !== undefined);
  if (sources.length > 1) { print(json({ error: 'usage', why: `one of --${sources.join(', --')}` })); return 64; }
  const viaRunexec = a['ws04-store'] !== undefined || a['ws04-db'] !== undefined;
  if (viaRunexec !== (a.runexec !== undefined)) { print(json({ error: 'usage', why: '--runexec goes with --ws04-store or --ws04-db, and they need it' })); return 64; }
  if (!viaRunexec && (a['ws04-after'] !== undefined || a['ws04-limit'] !== undefined)) { print(json({ error: 'usage', why: '--ws04-after / --ws04-limit go with --ws04-store or --ws04-db' })); return 64; }
  for (const k of ['runexec', 'ws04-store', 'ws04-db', 'ws04-after', 'ws04-limit']) if (a[k] === '') { print(json({ error: 'usage', why: `--${k} is empty` })); return 64; }
  let binding, rpcBinding, ws04Observation, ws04Read = null;
  try {
    binding = readDecl(a.binding); rpcBinding = readDecl(a['rpc-binding']);
    // owner and raider are u64: parsed exact (as decimal strings), as 12 parses 4's receipts
    if (a['ws04-observation']) ws04Observation = parseJsonU64(readFileSync(a['ws04-observation'], 'utf8'));
  } catch (e) { print(json({ error: 'usage', why: `declaration file: ${e.message}` })); return 64; }
  if (viaRunexec) {
    try {
      const client = ws04ObserveClient({ bin: a.runexec, execFile, parse: parseJsonU64 });
      const o = { after: a['ws04-after'], limit: a['ws04-limit'] };
      ws04Observation = a['ws04-store'] !== undefined ? await client.store(a['ws04-store'], o) : await client.db(a['ws04-db'], o);
      ws04Read = { status: 'read', mode: a['ws04-store'] !== undefined ? 'store' : 'db' };
    } catch (e) {
      // not read: nothing is handed to 12, and nothing is concluded about any caravan or run
      ws04Read = { status: 'not_read', code: String(e?.code ?? 'Spawn'), message: String(e?.message ?? '').slice(0, 200) };
    }
  }
  const obs = await observeLive({
    heraldUrl: a.herald, rpcUrl: a.rpc, storePath: a.store, binding, rpcBinding,
    wallets: [...(a.wallet ?? []), ...(a.about ?? [])], maxEventPages: pages,
    kinds: { herald: a['herald-kind'], rpc: a['rpc-kind'], store: a['store-kind'] }, io, ws04Observation,
  });
  // The resident's clock here is the Season bell of the same numbers (a resident on another clock reads nothing).
  const residentClock = obs.clock ? seasonClock(obs.clock) : undefined;
  const port = liveCanonicalEvidence({ ws12EvidencePort, observation: obs, residentClock });
  const bell = obs.observedBell ?? null;
  print(json({
    status: obs.status, reasons: obs.reasons, world: obs.world, clock: obs.clock, provenance: obs.provenance,
    basis: port.basis, basisWhy: port.basisWhy, inputs: obs.inputs, ingest: obs.ingest ?? null, identity: obs.identitySummary ?? null,
    held: obs.held,
    ws04: obs.ws04 ?? null,
    ws04Read,
    // No resident is made: what a read-only assembly would refuse, and why (resident/assembly.mjs).
    resident: readOnlyResidentPreflight({ ports: { evidence: port } }),
    worldBell: bell,
    about: (a.about ?? []).map(w => ({ wallet: w, ...(Number.isSafeInteger(bell) ? port.read({ counterparty: w, worldBell: bell }) : { status: 'clock_unverified', lines: [], facts: [] }) })),
  }));
  return obs.status === 'ok' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
