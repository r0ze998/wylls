#!/usr/bin/env node
// verify-watch.mjs — READ-ONLY independent-verifier watch of one world (world3-verifier-watch, item ⑯).
// No key, no transaction, no write to the chain. Node 20+.
//
//   node scripts/devnet/verify-watch.mjs --rpc URL --program ID --season N --data DIR
//        --verify-bin PATH [--pull-bin PATH] --program-so SO [--pinned-sha256 HEX] [--ruleset HEX]
//        [--once | --every MIN] [--max-rps 1] [--settle-tries 3] [--until UNIX] [--devnet]
//        [--keep-on-fail] [--skip-no-program-ix]
//   node scripts/devnet/verify-watch.mjs --judge-only --data DIR … (re-judge DIR/input.json.gz, no RPC)
//
// Each cycle: `PULL_BIN pull` (archive the new signatures since the stored cursor in DIR/findex — the verifier's
// findex archive —, the finals, each new transaction's balances once, then the whole verifier input as the fixture
// DIR/input.json.gz; ≤ --max-rps through one pacer, 429 → Retry-After back-off), then `VERIFY_BIN --fixture
// DIR/input.json.gz --program-so SO --ruleset R --quicknet-pk Q [--program-hash PIN]` (offline, 0 RPC), then ONE line
// appended to DIR/watch.log (verify-watch-lib.mjs logLine) and DIR/state.json. Reports per cycle:
// DIR/reports/<UTC stamp>/report.{json,md} (the last 48 are kept).
// Exit: 0 every cycle PASS / UNVERIFIABLE / RACE / REPIN / ERROR; 1 a real mismatch (a FAIL finding on a consistent
// snapshot judged with the pinned program — a public-RPC history is never "proven", so the verifier's VERDICT stays
// UNVERIFIABLE even with FAIL findings: the watch reads the findings); 2 bad arguments, another watch holds DIR's
// lock, or a refused RPC.
// --pull-bin defaults to --verify-bin (the pull subcommand needs a frontier-verify built from this branch or later;
// the judge may be an older build, e.g. the devnet run dir's).
// RPC: loopback always; https://api.devnet.solana.com only with --devnet; nothing else (checkRpc).
// Owner questions Q-W3VW-1..4 are flags (defaults = the safe choice): --max-rps (default 1), --every MIN,
// --keep-on-fail (default: the first FAIL stops the loop, exit 1; with it the loop goes on and exits 1 at --until),
// --skip-no-program-ix (default off; pull leaves out transactions with no top-level instruction to the program).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULTS, QUICKNET_PK, checkRpc, classify, gapMsFor, logLine, nextDelayMin, summarizeReport } from './verify-watch-lib.mjs';

const KEEP_REPORTS = 48;

function parseArgs(argv) {
  const o = { once: false, judgeOnly: false, devnet: false, keepOnFail: false, skipNoProgramIx: false, maxRps: DEFAULTS.maxRps, settleTries: DEFAULTS.settleTries, every: null, until: null };
  const need = (i, k) => { if (i + 1 >= argv.length) usage(`${k} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '--rpc': o.rpc = need(i, k); i++; break;
      case '--program': o.program = need(i, k); i++; break;
      case '--season': o.season = need(i, k); i++; break;
      case '--data': o.data = path.resolve(need(i, k)); i++; break;
      case '--verify-bin': o.verifyBin = path.resolve(need(i, k)); i++; break;
      case '--pull-bin': o.pullBin = path.resolve(need(i, k)); i++; break;
      case '--program-so': o.so = path.resolve(need(i, k)); i++; break;
      case '--pinned-sha256': o.pinned = need(i, k).toLowerCase(); i++; break;
      case '--ruleset': o.ruleset = need(i, k).toLowerCase(); i++; break;
      case '--max-rps': o.maxRps = Number(need(i, k)); i++; break;
      case '--settle-tries': o.settleTries = Number(need(i, k)); i++; break;
      case '--every': o.every = Number(need(i, k)); i++; break;
      case '--until': o.until = Number(need(i, k)); i++; break;
      case '--once': o.once = true; break;
      case '--judge-only': o.judgeOnly = true; o.once = true; break;
      case '--devnet': o.devnet = true; break;
      case '--keep-on-fail': o.keepOnFail = true; break;
      case '--skip-no-program-ix': o.skipNoProgramIx = true; break;
      case '-h': case '--help': usage(null); break;
      default: usage(`unknown argument ${k}`);
    }
  }
  for (const [k, flag] of [['program', '--program'], ['season', '--season'], ['data', '--data'], ['verifyBin', '--verify-bin'], ['so', '--program-so']]) {
    if (!o[k]) usage(`${flag} is required`);
  }
  if (!o.judgeOnly) {
    if (!o.rpc) usage('--rpc is required');
    const r = checkRpc(o.rpc, { allowDevnet: o.devnet });
    if (!r.ok) usage(`--rpc: ${r.why}`);
  }
  if (!o.once && !(o.every > 0)) usage('give --once or --every MIN');
  o.pullBin ??= o.verifyBin;
  o.gapMs = gapMsFor(o.maxRps);
  return o;
}

function usage(msg) {
  const head = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, all) => all.slice(0, i + 1).every(x => x.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
  if (msg) console.error(`verify-watch: ${msg}\n`);
  console.error(head);
  process.exit(msg ? 2 : 0);
}

function run(bin, args, { cwd } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let out = '', err = '';
    let p;
    try { p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: -1, stdout: '', stderr: String(e), seconds: 0 }); return; }
    p.stdout.on('data', d => { out += d; if (out.length > 64 << 20) out = out.slice(-(32 << 20)); });
    p.stderr.on('data', d => { err += d; if (err.length > 4 << 20) err = err.slice(-(2 << 20)); });
    p.on('error', e => resolve({ code: -1, stdout: out, stderr: err + String(e), seconds: (Date.now() - t0) / 1000 }));
    p.on('close', code => resolve({ code, stdout: out, stderr: err, seconds: (Date.now() - t0) / 1000 }));
  });
}

function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

// One watch per data dir (a cycle can outlast --every after a backlog).
function lock(dir) {
  const p = path.join(dir, 'watch.lock');
  try {
    const fd = openSync(p, 'wx');
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
  } catch {
    const pid = Number(readFileSync(p, 'utf8').trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
    if (alive) { console.error(`verify-watch: ${dir} is held by pid ${pid}`); process.exit(2); }
    writeFileSync(p, `${process.pid}\n`);
  }
  const free = () => { try { if (readFileSync(p, 'utf8').trim() === String(process.pid)) rmSync(p); } catch { /* ok */ } };
  process.on('exit', free);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { free(); process.exit(130); });
}

function pruneReports(dir) {
  const r = path.join(dir, 'reports');
  if (!existsSync(r)) return;
  const all = readdirSync(r).sort();
  for (const d of all.slice(0, Math.max(0, all.length - KEEP_REPORTS))) rmSync(path.join(r, d), { recursive: true, force: true });
}

async function cycle(o) {
  const at = Date.now();
  let pull;
  if (o.judgeOnly) {
    pull = JSON.parse(readFileSync(path.join(o.data, 'last-pull.json'), 'utf8'));
    pull = { ...pull, archived: 0, seq_before: pull.seq, requests: 0, throttled: 0, seconds: 0, judge_only: true };
  } else {
    const r = await run(o.pullBin, ['pull', '--program', o.program, '--season', String(o.season), '--rpc', o.rpc,
      '--data', o.data, '--rpc-min-gap-ms', String(o.gapMs), '--settle-tries', String(o.settleTries),
      ...(o.ruleset ? ['--ruleset', o.ruleset] : []), ...(o.skipNoProgramIx ? ['--skip-no-program-ix'] : [])]);
    const last = r.stdout.trim().split('\n').pop();
    try { pull = JSON.parse(last); } catch { pull = { ok: false, error: `exit ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 200)}` }; }
    if (pull.ok !== false) writeFileSync(path.join(o.data, 'last-pull.json'), JSON.stringify(pull, null, 1));
  }
  let verify = null, reportDir = null;
  const pre = classify({ pull, verify: { code: 0 }, pinnedSha256: o.pinned });
  if (pull.ok !== false && pre.level !== 'REPIN') {
    const stamp = new Date(at).toISOString().replace(/[:.]/g, '').replace('T', '-');
    reportDir = path.join(o.data, 'reports', stamp + (o.judgeOnly ? '-judge' : ''));
    mkdirSync(reportDir, { recursive: true });
    // The fixture's trust roots are pinned here, never taken from it: the drand key, the ruleset (the flag, else the one
    // the pull wrote = S1's v3, which world 3's Season carries), the program's sha256.
    const args = ['--fixture', path.join(o.data, 'input.json.gz'), '--program-so', o.so, '--out', reportDir,
      '--quicknet-pk', QUICKNET_PK, '--ruleset', o.ruleset ?? pull.ruleset];
    if (o.pinned) args.push('--program-hash', o.pinned);
    const r = await run(o.verifyBin, args);
    writeFileSync(path.join(reportDir, 'judge.stderr.txt'), r.stderr);
    let report = null;
    try { report = JSON.parse(readFileSync(path.join(reportDir, 'report.json'), 'utf8')); } catch { /* none */ }
    verify = { code: r.code, seconds: r.seconds, report, stderr: r.stderr, summary: summarizeReport(report) };
    pruneReports(o.data);
  }
  const c = classify({ pull, verify, pinnedSha256: o.pinned });
  const line = logLine({ at, level: c.level, why: c.why, pull, verify, reportDir: reportDir && path.relative(o.data, reportDir) });
  appendFileSync(path.join(o.data, 'watch.log'), line + '\n');
  const st = path.join(o.data, 'state.json');
  writeFileSync(st + '.tmp', JSON.stringify({ at: new Date(at).toISOString(), level: c.level, exit: c.exit, why: c.why, line, seq: pull.seq ?? null }, null, 1));
  renameSync(st + '.tmp', st);
  console.log(line);
  return { c, pull };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.data, { recursive: true });
  lock(o.data);
  if (o.pinned) {
    const have = sha256File(o.so);
    if (have !== o.pinned) usage(`--program-so ${o.so} is sha256 ${have}, not --pinned-sha256 ${o.pinned}`);
  }
  if (o.once) { const { c } = await cycle(o); process.exit(c.exit); }
  let factor = 1;
  let worst = 0;
  for (;;) {
    const { c, pull } = await cycle(o);
    // a real mismatch stops the watch (the log and the report say what) unless --keep-on-fail (Q-W3VW-3)
    if (c.exit && !o.keepOnFail) process.exit(c.exit);
    worst = Math.max(worst, c.exit);
    const d = nextDelayMin(factor, pull, { everyMin: o.every });
    factor = d.factor;
    const wake = Date.now() + d.minutes * 60000;
    if (o.until && wake / 1000 > o.until) process.exit(worst);
    await new Promise(r => setTimeout(r, d.minutes * 60000));
  }
}

main().catch(e => { console.error(`verify-watch: ${e.stack ?? e}`); process.exit(2); });
