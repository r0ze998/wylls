#!/usr/bin/env node
// readonly-guard: a loopback JSON-RPC guard in front of a PUBLIC devnet RPC,
// for owner-approved read-only runs (B5). Our services accept plain http only
// to loopback, so a binary pointed at http://127.0.0.1:PORT reaches devnet
// only through this guard, which:
//
//   - forwards only an allow-list of READ methods (no sendTransaction,
//     simulateTransaction, requestAirdrop, …); anything else gets a JSON-RPC
//     error and is logged as REFUSED. Batches (JSON arrays) are refused;
//   - forwards only to https:// hosts with "devnet" in the name, and checks
//     each upstream's getGenesisHash is devnet's before forwarding anything;
//   - spaces every forwarded call across ALL listeners (--gap-ms, default
//     250 = 4 req/s) and backs everyone off on an upstream 429/503;
//   - stops forwarding after --budget calls (shared across listeners and,
//     with --budget-file, across processes); further calls get HTTP 503;
//   - logs every call (method, status, latency, bytes) as JSONL (--log) and
//     can record full exchanges for offline fixtures (--record DIR);
//   - can lie on purpose (tests only): `PORT=URL,truncate-before-slot=S`
//     drops getSignaturesForAddress rows below slot S (a pruned history);
//     `PORT=URL,drop-sig=SIG` drops one row (a missing transaction).
//
// usage: node readonly-guard.mjs --listen 41450=https://api.devnet.solana.com
//          [--listen 41452=https://api.devnet.solana.com,truncate-before-slot=123]
//          [--gap-ms 250] [--budget 3000] [--budget-file F] [--log F] [--record DIR]
// No key, no signing, no state written upstream. Ctrl-C stops it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const READ_METHODS = new Set([
  'getVersion', 'getGenesisHash', 'getHealth', 'getSlot', 'getBlockHeight', 'getEpochInfo',
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getProgramAccounts',
  'getSignaturesForAddress', 'getTransaction', 'getBlock', 'getBlockTime',
  'getLatestBlockhash', 'isBlockhashValid', 'getFirstAvailableBlock', 'minimumLedgerSlot',
  'getMinimumBalanceForRentExemption', 'getSignatureStatuses',
]);

function parseArgs(argv) {
  const o = { listen: [], gapMs: 250, budget: 3000, budgetFile: null, log: null, record: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--listen') {
      const a = v();
      const eq = a.indexOf('=');
      if (eq < 1) throw new Error('--listen PORT=URL[,opt=val]');
      const [port, rest] = [a.slice(0, eq), a.slice(eq + 1)];
      const [url, ...opts] = rest.split(',');
      const lie = {};
      for (const kv of opts) {
        const [ok, ov] = kv.split('=');
        lie[ok] = ov;
      }
      o.listen.push({ port: Number(port), url, lie });
    } else if (k === '--gap-ms') o.gapMs = Number(v());
    else if (k === '--budget') o.budget = Number(v());
    else if (k === '--budget-file') o.budgetFile = v();
    else if (k === '--log') o.log = v();
    else if (k === '--record') o.record = v();
    else throw new Error(`unknown argument ${k}`);
  }
  return o;
}
export function checkUpstream(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`${url}: https only`);
  if (!`${u.hostname}${u.pathname}`.includes('devnet')) throw new Error(`${url}: host or path must name devnet`);
  if (/mainnet|testnet/.test(u.hostname)) throw new Error(`${url}: refused host`);
  return u;
}

/** Applies a listener's deliberate lie to a forwarded result (tests only). */
export function lieResult(method, result, lie) {
  if (method !== 'getSignaturesForAddress' || !Array.isArray(result)) return result;
  let out = result;
  if (lie['truncate-before-slot'] !== undefined) {
    const s = Number(lie['truncate-before-slot']);
    out = out.filter((r) => r.slot >= s);
  }
  if (lie['drop-sig'] !== undefined) out = out.filter((r) => r.signature !== lie['drop-sig']);
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.listen.length) throw new Error('no --listen');
  for (const l of o.listen) {
    checkUpstream(l.url);
    if (l.port < 41450 || l.port > 41499) throw new Error(`port ${l.port}: 41450-41499 only`);
  }
  const logf = o.log ? fs.openSync(o.log, 'a') : null;
  const log = (rec) => {
    const line = JSON.stringify({ t: new Date().toISOString(), ...rec });
    if (logf !== null) fs.writeSync(logf, line + '\n');
  };
  if (o.record) fs.mkdirSync(o.record, { recursive: true });
  let used = 0;
  const readBudget = () => {
    if (!o.budgetFile) return used;
    try {
      return JSON.parse(fs.readFileSync(o.budgetFile, 'utf8')).used ?? 0;
    } catch {
      return 0;
    }
  };
  const spend = () => {
    used = readBudget() + 1;
    if (o.budgetFile) fs.writeFileSync(o.budgetFile, JSON.stringify({ used, budget: o.budget }));
    return used;
  };
  // One FIFO queue, one gap, one penalty for every listener.
  let next = 0;
  let penalty = 0;
  let chain = Promise.resolve();
  const turn = () => {
    const p = chain.then(async () => {
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      next = Date.now() + o.gapMs;
    });
    chain = p.catch(() => {});
    return p;
  };
  const genesisOk = new Map();
  const forward = async (url, body) => {
    await turn();
    if (readBudget() >= o.budget) return { status: 503, text: '{"error":"guard budget exhausted"}', ms: 0, budget: true };
    const n = spend();
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return { status: 502, text: JSON.stringify({ error: `guard upstream: ${e.name}` }), ms: Date.now() - t0, n };
    }
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      penalty = Math.min(Math.max(penalty * 2, 1000), 30_000);
      next = Math.max(next, Date.now() + penalty);
    } else if (res.status === 200) penalty = 0;
    return { status: res.status, text, ms: Date.now() - t0, n, retryAfter: res.headers.get('retry-after') };
  };
  const servers = [];
  let recN = 0;
  for (const l of o.listen) {
    const srv = http.createServer(async (req, res) => {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 256 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const reply = (status, obj) => {
        const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
        res.end(s);
      };
      if (Array.isArray(msg) || typeof msg?.method !== 'string') {
        log({ port: l.port, refused: 'batch-or-malformed' });
        return reply(200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'guard: batches refused' } });
      }
      if (!READ_METHODS.has(msg.method)) {
        log({ port: l.port, method: msg.method, refused: 'not-a-read-method' });
        return reply(200, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `guard: ${msg.method} refused (read-only run)` } });
      }
      if (!genesisOk.get(l.url)) {
        const g = await forward(l.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }));
        let gh = null;
        try {
          gh = JSON.parse(g.text).result;
        } catch {}
        log({ port: l.port, method: 'getGenesisHash', guardCheck: true, status: g.status, ms: g.ms, n: g.n, genesis: gh });
        if (gh !== DEVNET_GENESIS) {
          return reply(502, { error: `guard: upstream genesis ${gh} is not devnet's` });
        }
        genesisOk.set(l.url, true);
      }
      const r = await forward(l.url, raw);
      let text = r.text;
      let lied = false;
      if (r.status === 200 && Object.keys(l.lie).length) {
        try {
          const v = JSON.parse(text);
          if (v.result !== undefined) {
            const before = JSON.stringify(v.result);
            v.result = lieResult(msg.method, v.result, l.lie);
            text = JSON.stringify(v);
            lied = JSON.stringify(v.result) !== before;
          }
        } catch {}
      }
      let rpcError = null;
      try {
        const v = JSON.parse(text);
        if (v.error) rpcError = { code: v.error.code, message: String(v.error.message).slice(0, 200) };
      } catch {}
      log({
        port: l.port, method: msg.method, status: r.status, ms: r.ms, bytes: text.length, n: r.n,
        rpcError, lied: lied || undefined, retryAfter: r.retryAfter ?? undefined, budget: r.budget,
        params: JSON.stringify(msg.params ?? []).slice(0, 300),
      });
      if (o.record && text.length <= 512 * 1024) {
        recN += 1;
        fs.writeFileSync(
          path.join(o.record, `${String(recN).padStart(5, '0')}-${l.port}-${msg.method}.json`),
          JSON.stringify({ request: msg, status: r.status, response: text }),
        );
      }
      const h = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
      if (r.retryAfter) h['retry-after'] = r.retryAfter;
      res.writeHead(r.status, h);
      res.end(text);
    });
    await new Promise((ok, bad) => srv.once('error', bad).listen(l.port, '127.0.0.1', ok));
    servers.push(srv);
    console.error(`readonly-guard: 127.0.0.1:${l.port} -> ${new URL(l.url).host}${Object.keys(l.lie).length ? ' LYING ' + JSON.stringify(l.lie) : ''}`);
  }
  const stop = () => {
    for (const s of servers) s.close();
    console.error(`readonly-guard: stopped after ${readBudget()} forwarded calls`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`readonly-guard: ${e.message}`);
    process.exit(2);
  });
}
