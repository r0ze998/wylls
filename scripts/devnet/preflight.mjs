#!/usr/bin/env node
// Deploy-day preflight (runbook §8 step 0): checks every MUST item of the devnet
// deploy READ-ONLY and prints one PASS / FAIL / WARN / SKIP line per item with the fix.
// It never sends a transaction, never reads or makes a key, never spends SOL; it
// contacts a cluster only with an explicit --rpc. See preflight-checks.mjs for the
// rules and scripts/devnet/README.md for the flags.
//
// This file only wires the real file system, processes and network into preflight().
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execAllowed, formatResults, preflight } from './preflight-checks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The Solana CLIs run `--version` only, with an empty HOME: they read no user config and no key.
const emptyHome = mkdtempSync(path.join(tmpdir(), 'wylls-preflight-home-'));

function request(url, { method = 'GET', headers = {}, body, ca, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) { reject(new Error(`${u.protocol} not supported`)); return; }
    const req = lib.request(u, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }, ca: ca ? readFileSync(ca) : undefined, agent: false, timeout: timeoutMs }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => { size += c.length; if (size <= 4 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function tcpOpen(host, port, timeoutMs = 2_000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = v => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

let buildScript = null;
const io = {
  repoRoot,
  home: homedir(),
  uid: process.getuid?.(),
  readFile: p => readFileSync(p),
  exists: p => existsSync(p),
  stat: p => statSync(p),
  exec: (cmd, args, { cwd } = {}) => {
    if (!execAllowed(cmd, args, { buildScript })) throw new Error(`preflight refuses to start ${cmd} ${args.join(' ')}`);
    const isBuild = cmd === buildScript;
    const env = path.basename(cmd) === 'solana' ? { ...process.env, HOME: emptyHome } : process.env;
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: isBuild ? ['ignore', 'pipe', 'inherit'] : 'pipe', maxBuffer: 64 * 1024 * 1024 });
    if (isBuild && r.stdout) process.stderr.write(r.stdout);
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  http: request,
  tcpOpen,
  sleep: ms => new Promise(res => setTimeout(res, ms)),
  now: () => Date.now(),
};

const argv = process.argv.slice(2);
// The build script the allow-list may start (--build only): the profile's own build line.
try {
  const pi = argv.indexOf('--profile');
  const prof = JSON.parse(readFileSync(pi >= 0 ? argv[pi + 1] : `${repoRoot}/scripts/devnet/devnet-playable-profile.json`, 'utf8'));
  if (argv.includes('--build')) buildScript = `${repoRoot}/${prof.program.build}`;
} catch { /* preflight() reports a bad profile */ }

// The gateway's own startup check (config.mjs loadFrontierConfig: pure, no side effects), when its modules are installed.
let gatewayConfig = null;
try {
  const m = await import(pathToFileURL(`${repoRoot}/permutation-gateway/src/frontier/config.mjs`).href);
  gatewayConfig = a => m.loadFrontierConfig(a, {});
} catch { gatewayConfig = null; }

const res = await preflight(argv, io, { gatewayConfig });
if (res.error) { console.error(res.error); process.exit(res.exitCode); }
if (res.help) { console.log(res.help); process.exit(0); }
if (argv.includes('--json')) console.log(JSON.stringify({ results: res.results, rpcCalls: res.rpcLog, exitCode: res.exitCode }, null, 2));
else console.log(formatResults(res.results));
process.exit(res.exitCode);
