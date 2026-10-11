// AC8: record a mini-run fixture from a real run directory by READ-ONLY reads (unit AC8, contract 11.5).
//
//   node test/fixtures/ai-audit-capture.mjs --ai-dir <AI_DIR of the run> --herald http://127.0.0.1:<p> --rpc http://127.0.0.1:<p> --out test/fixtures/ai-audit-slice4
//
// The source of the checked-in fixture is the slice-4 run of the wave-A slice gate (local test chain, 6 AI citizens, 12 game hours),
// with its herald and localnet restarted read-only from a COPY of the run's data directories (the original was never touched).
// What it writes under --out (see test/fixtures/ai-audit-slice4/README.md for which parts are real and which are derived):
//   pub/                  the run's PUB, verbatim (metrics/ left out)
//   state/                the subset of the private state season-end publication needs for the model and sealed decisions: records.jsonl
//                         (the journal lines of those records, verbatim), requests/<id>.json (verbatim), ledger/*.json (verbatim), season-end.json
//   stack.toml, ai-slots.json   the run's copies (verbatim)
//   herald.json           {events: rows of the kinds the audit reads (verbatim rows; paging is synthetic), gets: {path: {status, json}} for every
//                         other GET the verification made (verbatim)}
//   rpc.json              {calls: {"<method>|<params>": result}} for every JSON-RPC call the verification made; transactions keep slot, blockTime and the
//                         message (account keys, header, instructions); `meta` (logs, balances) is dropped
// Nothing here posts, signs or writes to the herald or the chain.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Rpc, canonicalJson } from '../../citizens/registrar.mjs';
import { createAudit } from '../../citizens/audit/season_end.mjs';
import { verifyMinds } from '../../citizens/verify-minds.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
for (const k of ['ai-dir', 'herald', 'rpc', 'out']) if (!args[k]) { console.error(`--${k} is required`); process.exit(2); }
const SRC = path.resolve(args['ai-dir']);
const OUT = path.resolve(args.out);
const HERALD = args.herald.replace(/\/$/, '');
const READ_KINDS = new Set(['SEASON_CREATED', 'GENESIS_SEED', 'JOIN', 'SETTLE', 'RELEASE', 'HOLDING_FINAL', 'BUILD', 'TRAIN', 'MUSTER', 'DISSOLVE', 'STRANDED', 'DEPART', 'REVEAL', 'DEPARTURE_SETTLED', 'TRANSIT_SETTLED', 'CLASH', 'CAMP']);

const copyDir = (from, to, skip = () => false) => {
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) {
    if (skip(n)) continue;
    const a = path.join(from, n), b = path.join(to, n);
    if (fs.statSync(a).isDirectory()) copyDir(a, b, skip); else fs.copyFileSync(a, b);
  }
};
fs.rmSync(OUT, { recursive: true, force: true });
copyDir(path.join(SRC, 'pub'), path.join(OUT, 'pub'), n => n === 'metrics' || n === 'full' || n === 'verify-minds.json');
for (const f of ['stack.toml', 'ai-slots.json']) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));

// ---- the private state subset: the journal lines of the model and sealed records, their requests, the ledgers
const lines = fs.readFileSync(path.join(SRC, 'state', 'records.jsonl'), 'utf8').split('\n').filter(Boolean);
const keep = new Set();
for (const l of lines) { const op = JSON.parse(l); if (op.op === 'add' && (op.entry.full.mode === 'model' || op.entry.full.sealed)) keep.add(op.entry.id); }
const subset = lines.filter(l => { const op = JSON.parse(l); return (op.op === 'add' && keep.has(op.entry.id)) || (op.id !== undefined && keep.has(op.id)); });
fs.mkdirSync(path.join(OUT, 'state', 'requests'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'state', 'records.jsonl'), `${subset.join('\n')}\n`);
for (const id of keep) { const f = path.join(SRC, 'state', 'requests', `${id}.json`); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(OUT, 'state', 'requests', `${id}.json`)); }
copyDir(path.join(SRC, 'state', 'ledger'), path.join(OUT, 'state', 'ledger'));
fs.copyFileSync(path.join(SRC, 'state', 'season-end.json'), path.join(OUT, 'state', 'season-end.json'));

// ---- run the verification over a working copy, recording every GET and JSON-RPC call
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-capture-'));
copyDir(OUT, work);
createAudit({ aiDir: work }).publishSeasonEnd();

const gets = {};
const eventRows = new Map();
const realGet = async p => {
  const r = await fetch(HERALD + p, { signal: AbortSignal.timeout(20_000) });
  const bytes = Buffer.from(await r.arrayBuffer());
  const text = bytes.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, bytes };
};
const heraldDouble = {
  base: HERALD,
  async get(p) {
    const r = await realGet(p);
    if (p.startsWith('/h/events')) { for (const e of r.json?.events ?? []) eventRows.set(String(e.seq), e); }
    else gets[p] = { status: r.status, json: r.json };
    return r;
  },
};
const realRpc = new Rpc(args.rpc);
const calls = {};
const slim = r => (r && r.transaction && r.slot !== undefined ? { slot: r.slot, blockTime: r.blockTime, transaction: { message: r.transaction.message, signatures: r.transaction.signatures } } : r);
const rpcDouble = {
  async call(method, params) {
    const r = await realRpc.call(method, params);
    calls[`${method}|${canonicalJson(params)}`] = method === 'getTransaction' ? slim(r) : r;
    return r;
  },
};
const stackPath = path.join(OUT, 'stack.toml'), slotsPath = path.join(OUT, 'ai-slots.json');
const report = await verifyMinds({ herald: heraldDouble, rpc: rpcDouble, aiDir: path.join(work, 'pub'), stackPath, slotsPath, log: m => console.error(m) });
fs.writeFileSync(path.join(OUT, 'herald.json'), JSON.stringify({ v: 1, source: 'slice-4 herald restarted read-only from a copy of its data directory', events: [...eventRows.values()].filter(e => READ_KINDS.has(e.decoded?.name)).sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1)), gets }));
fs.writeFileSync(path.join(OUT, 'rpc.json'), JSON.stringify({ v: 1, source: 'slice-4 localnet restarted read-only from a copy of its data directory; getTransaction results keep slot, blockTime and the message only', calls }));
fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ out: OUT, verdict: report.verdict, events: [...eventRows.values()].filter(e => READ_KINDS.has(e.decoded?.name)).length, gets: Object.keys(gets).length, rpc_calls: Object.keys(calls).length }));
