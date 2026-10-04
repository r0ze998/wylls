// AC10a, ruling R9 (contract v1.3 sections 1.1, 6.3, 7.1, 8.4): (1) the stack lock is ONE file shared by every worktree and its stale
// takeover is race-free; (2) a non-smoke run must name AI_MODEL and AI_LLAMA_DIR, the commitments carry the measured hashes (or
// "unmeasured" for a smoke run) and the run script compares the live llama-server with them; (3) no anchor is sent twice, whatever
// two registrar processes do. Nothing here starts a stack or a model: processes are spawned only to race on files, the llama
// server is a recorded /props plus a recorded command line (test/fixtures/ai-llama-live.json, taken from the real pinned server
// on 2026-10-04), the chain is an in-memory fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Keypair, Transaction } from '@solana/web3.js';
import * as G from '../citizens/bin/run-guards.mjs';
import * as L from '../citizens/bin/llama-check.mjs';
import * as R from '../citizens/registrar.mjs';
import { acquireFile, createExclusive, pidAlive } from '../citizens/lock.mjs';

const bin = new URL('../citizens/bin/', import.meta.url).pathname;
const GUARDS = path.join(bin, 'run-guards.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac10a-r9-'));
const read = p => fs.readFileSync(p, 'utf8');
const write = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
const deadPid = () => Number(spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim());
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...a], { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });

// ================================================================== 1. the stack lock
/** Wave A's algorithm (kept ONLY as the oracle that the new tests fail on): wx create, a stale holder is removed with an unconditional rm. */
function waveATake(file, { pid, unit, run_id }, hooks = {}) {
  const body = `${JSON.stringify({ pid, unit, run_id, started: 'x' })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, body, { flag: 'wx' }); return { ok: true }; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let l = null;
      try { l = JSON.parse(read(file)); } catch { /* unreadable: stale */ }
      if (l && pidAlive(l.pid)) return { ok: false, holder: l };
      hooks.afterJudgedStale?.();
      fs.rmSync(file, { force: true });
    }
  }
  return { ok: false };
}
const staleLock = (file) => write(file, JSON.stringify({ pid: deadPid(), unit: 'old', run_id: 'old', started: 'then' }));

test('R9 lock: two starters that read the same stale lock at the same moment cannot both win (deterministic interleaving: B runs inside A\'s pause)', () => {
  const f = path.join(tmp, 'lock-interleave');
  staleLock(f);
  let b;
  const a = G.takeLock(f, { pid: process.pid, unit: 'A', run_id: 'A' }, { afterJudgedStale: () => { b = G.takeLock(f, { pid: process.pid, unit: 'B', run_id: 'B' }); } });
  assert.equal(b.ok, true, 'B, which ran during A\'s pause, took the stale lock');
  assert.equal(a.ok, false, 'A must find B\'s fresh lock and refuse');
  assert.equal(JSON.parse(read(f)).run_id, 'B');
  assert.deepEqual(fs.readdirSync(tmp).filter(n => n.startsWith('lock-interleave.')), [], 'no claim or temp file is left behind');
});

test('R9 lock: the same interleaving makes wave A\'s algorithm give the lock to BOTH starters (the new test fails on the old code)', () => {
  const f = path.join(tmp, 'lock-interleave-old');
  staleLock(f);
  let b;
  const a = waveATake(f, { pid: process.pid, unit: 'A', run_id: 'A' }, { afterJudgedStale: () => { b = waveATake(f, { pid: process.pid, unit: 'B', run_id: 'B' }); } });
  assert.deepEqual([a.ok, b.ok], [true, true], 'the oracle shows the defect: A removed B\'s new lock and both believe they hold it');
});

test('R9 lock: eight processes racing for one stale lock, five rounds: exactly one exit 0 each round', async () => {
  for (let round = 0; round < 5; round++) {
    const f = path.join(tmp, `lock-race-${round}`);
    staleLock(f);
    const runs = Array.from({ length: 8 }, (_, i) => new Promise(resolve => {
      const p = spawn(process.execPath, [GUARDS, 'lock-take', '--lock-file', f, '--unit', `p${i}`, '--run-id', `r${round}-${i}`, '--pid', String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('close', code => resolve({ code, err }));
    }));
    const results = await Promise.all(runs);
    const wins = results.filter(r => r.code === 0).length;
    assert.equal(wins, 1, `round ${round}: ${JSON.stringify(results)}`);
    assert.ok(results.filter(r => r.code !== 0).every(r => /REFUSED/.test(r.err)), 'the losers say why');
    assert.match(JSON.parse(read(f)).run_id, new RegExp(`^r${round}-`));
  }
});

test('R9 lock: a fresh lock is never visible half-written (create is link of a finished temp file); a live holder is refused; a crashed taker\'s claim is cleared', () => {
  const f = path.join(tmp, 'lock-atomic');
  assert.equal(createExclusive(f, '{"pid":1}\n'), true);
  assert.equal(createExclusive(f, '{"pid":2}\n'), false);
  assert.deepEqual(JSON.parse(read(f)), { pid: 1 });
  assert.deepEqual(fs.readdirSync(tmp).filter(n => n.startsWith('lock-atomic.tmp-')), []);
  // a live holder
  const live = path.join(tmp, 'lock-live');
  write(live, `${JSON.stringify({ pid: process.pid, unit: 'x', run_id: 'live', started: 't' })}\n`);
  assert.deepEqual(G.takeLock(live, { pid: process.pid, unit: 'y', run_id: 'y' }), { ok: false, holder: { pid: process.pid, unit: 'x', run_id: 'live', started: 't' } });
  // a stale lock whose taker crashed inside the takeover: its claim names a dead pid and is cleared
  const crashed = path.join(tmp, 'lock-crashed');
  staleLock(crashed);
  const raw = read(crashed);
  const claim = `${crashed}.takeover-${R.sha256hex(raw).slice(0, 16)}`;
  write(claim, JSON.stringify({ pid: deadPid() }));
  const r = G.takeLock(crashed, { pid: process.pid, unit: 'z', run_id: 'z' });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(read(crashed)).run_id, 'z');
  assert.ok(!fs.existsSync(claim));
  // ...and while that taker is ALIVE the second starter is refused, not allowed through
  const busy = path.join(tmp, 'lock-busy');
  staleLock(busy);
  write(`${busy}.takeover-${R.sha256hex(read(busy)).slice(0, 16)}`, JSON.stringify({ pid: process.pid }));
  assert.deepEqual(G.takeLock(busy, { pid: process.pid, unit: 'q', run_id: 'q' }), { ok: false, holder: null });
  assert.equal(acquireFile.length >= 2, true);
});

test('R9 lock: one lock for every worktree of a repository (<git common dir>/wylls-ai-stack.lock); the run script plans exactly that path', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
  write(path.join(root, 'a.txt'), 'x\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const wt = path.join(tmp, `wt-${path.basename(root)}`);
  git(root, 'worktree', 'add', '-q', '-b', 'other', wt);
  const a = G.defaultLockPath(root);
  const b = G.defaultLockPath(wt);
  assert.equal(a, b, 'the main checkout and the worktree resolve to one file');
  assert.equal(path.dirname(fs.realpathSync(path.dirname(a))), fs.realpathSync(path.dirname(path.dirname(a))));
  assert.equal(path.basename(a), 'wylls-ai-stack.lock');
  assert.equal(fs.realpathSync(path.dirname(a)), fs.realpathSync(path.join(root, '.git')), 'it lies under the common git directory');
  // the CLI the script calls
  const cli = spawnSync(process.execPath, [GUARDS, 'lock-path', '--repo', wt], { encoding: 'utf8' });
  assert.equal(cli.stdout.trim(), a);
  // outside a git repository the wave-A path under the repo is the fallback
  const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
  assert.equal(G.defaultLockPath(plain), path.join(plain, '.local', 'frontier', 'ai', 'stack.lock'));
  // the script, run as a dry run in the worktree with no AI_STACK_LOCK, names the shared file
  const env = { ...process.env, AI_REPO: wt, AI_MODEL: path.join(tmp, 'm.gguf'), AI_LLAMA_DIR: tmp };
  delete env.AI_STACK_LOCK;
  write(env.AI_MODEL, 'x');
  const stack = new URL('../citizens/stack/ai-smoke.toml', import.meta.url).pathname;
  const cfg = new URL('./fixtures/ai-run-config.json', import.meta.url).pathname;
  const out = spawnSync('bash', [path.join(bin, 'ai-citizens-run.sh'), '--stack', stack, '--citizens-config', cfg, '--no-busy-check', '--dry-run'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.match(out.stdout, new RegExp(`PLAN lock ${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), out.stdout + out.stderr);
  assert.match(out.stdout, /PLAN run llama-check: .*llama-check\.mjs/, 'the dry run plans the llama check');
});

// ================================================================== 2. measured commitments and the llama check
const FIX = JSON.parse(read(new URL('./fixtures/ai-llama-live.json', import.meta.url).pathname));
const MODEL_PATH = FIX.props.model_path; // /OUTPUTS/.claude/data/models/gemma-4-26B-A4B-it-Q4_0.gguf (a neutral prefix)
const LLAMA_TREE = path.dirname(path.dirname(FIX.binary_realpath));
const commitmentsFor = (over = {}) => {
  const flags = [...R.PINNED_LLAMA_FLAGS];
  return { model: { file: path.basename(MODEL_PATH), sha256: 'a'.repeat(64), alias: 'gemma-4-26b-a4b-it' }, server: { llama_cpp: 'b11146 / 7fe450e19 (Homebrew 0.5.0)', tree_sha256: 'b'.repeat(64), flags, flags_sha256: R.sha256hex(R.canonicalJson(flags)), request_shape: 'response_format', backend: 'Metal, M4 Max' }, ...over };
};
const listener = (over = {}) => ({ ps_args: FIX.ps_args, binary_realpath: FIX.binary_realpath, ...over });

test('R9 llama check: the REAL recorded /props and command line of the pinned server equal the commitments (and AI_MODEL, AI_LLAMA_DIR)', () => {
  const r = L.compareLlama({ props: FIX.props, listener: listener(), commitments: commitmentsFor(), aiModel: MODEL_PATH, aiLlamaDir: LLAMA_TREE });
  assert.deepEqual(r.mismatches, []);
  assert.deepEqual(r.unverified, []);
  assert.ok(r.checks.length >= 8, r.checks.join('\n'));
  // flag order does not matter, a value does
  const m = L.parsePsArgs(FIX.ps_args);
  assert.equal(m.flags.get('-c'), '16384');
  assert.equal(m.flags.get('--jinja'), true);
  assert.equal(path.basename(m.model), 'gemma-4-26B-A4B-it-Q4_0.gguf');
});

test('R9 llama check: each difference is refused for its own reason (alias, a flag value, an extra flag, a missing flag, context, slots, build, model file, model path, binary tree)', () => {
  const c = commitmentsFor();
  const bad = (props, lst, extra = {}) => L.compareLlama({ props, listener: lst, commitments: c, aiModel: MODEL_PATH, aiLlamaDir: LLAMA_TREE, ...extra }).mismatches.join(' | ');
  assert.match(bad({ ...FIX.props, model_alias: 'other' }, listener()), /model alias/);
  assert.match(bad(FIX.props, listener({ ps_args: FIX.ps_args.replace('-c 16384', '-c 8192') })), /flags: the live process has/);
  assert.match(bad(FIX.props, listener({ ps_args: `${FIX.ps_args} --no-mmap` })), /flags/);
  assert.match(bad(FIX.props, listener({ ps_args: FIX.ps_args.replace(' --metrics', '') })), /flags/);
  assert.match(bad(FIX.props, listener({ ps_args: FIX.ps_args.replace('--reasoning off', '--reasoning on') })), /flags/);
  assert.match(bad({ ...FIX.props, default_generation_settings: { n_ctx: 4096 } }, listener()), /context size/);
  assert.match(bad({ ...FIX.props, total_slots: 4 }, listener()), /slots/);
  assert.match(bad({ ...FIX.props, build_info: 'b9999-deadbeef0' }, listener()), /llama\.cpp build/);
  assert.match(bad(FIX.props, listener({ ps_args: FIX.ps_args.replace('gemma-4-26B-A4B-it-Q4_0.gguf', 'other-model.gguf') })), /model file/);
  assert.match(bad(FIX.props, listener(), { aiModel: '/elsewhere/gemma-4-26B-A4B-it-Q4_0.gguf' }), /model path/);
  assert.match(bad(FIX.props, listener(), { aiLlamaDir: '/another/llama-tree' }), /binary/);
  assert.match(bad(FIX.props, listener(), {}) || 'none', /^none$/, 'the unmodified inputs have no difference');
  // the commitments' own flags hash must hash their flags
  assert.match(L.compareLlama({ props: FIX.props, listener: listener(), commitments: commitmentsFor({ server: { ...c.server, flags_sha256: '00' } }), aiModel: MODEL_PATH, aiLlamaDir: LLAMA_TREE }).mismatches.join(), /flags_sha256/);
});

test('R9 llama check: what cannot be verified is listed, never passed: an unreadable command line, no AI_MODEL, no AI_LLAMA_DIR, an unmeasured commitments field', () => {
  const none = L.compareLlama({ props: FIX.props, listener: null, commitments: commitmentsFor(), aiModel: MODEL_PATH, aiLlamaDir: LLAMA_TREE });
  assert.equal(none.ok, true);
  assert.ok(none.unverified.some(u => /command line/.test(u)));
  const noEnv = L.compareLlama({ props: FIX.props, listener: listener(), commitments: commitmentsFor() });
  assert.ok(noEnv.unverified.some(u => /AI_MODEL/.test(u)) && noEnv.unverified.some(u => /AI_LLAMA_DIR/.test(u)));
  const unm = L.compareLlama({ props: FIX.props, listener: listener(), commitments: commitmentsFor({ model: { file: R.UNMEASURED, sha256: R.UNMEASURED, alias: 'gemma-4-26b-a4b-it' }, server: { ...commitmentsFor().server, tree_sha256: R.UNMEASURED } }), aiModel: MODEL_PATH, aiLlamaDir: LLAMA_TREE });
  assert.ok(unm.unverified.some(u => /model\.sha256 is unmeasured/.test(u)) && unm.unverified.some(u => /tree_sha256 is unmeasured/.test(u)));
  assert.equal(unm.mismatches.length, 0);
});

/** A fake llama-server on port 0 that serves the recorded /props. */
async function fakeLlama(props = FIX.props) {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/props' ? JSON.stringify(props) : '{"status":"ok"}'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}
const runCli = (args) => new Promise(resolve => {
  const p = spawn(process.execPath, [path.join(bin, 'llama-check.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('close', code => resolve({ code, out, err }));
});

test('R9 llama check CLI: exit 0 on a match, 1 on a difference, 1 on unverified in a non-smoke run, 0 with --smoke; only loopback URLs', async () => {
  const f = await fakeLlama();
  try {
    const cFile = path.join(tmp, 'commitments-live.json');
    write(cFile, JSON.stringify(commitmentsFor()));
    const argv = path.join(tmp, 'argv-live.json');
    write(argv, JSON.stringify({ ps_args: FIX.ps_args, binary_realpath: FIX.binary_realpath }));
    const base = ['--llm', f.url, '--commitments', cFile, '--argv-json', argv];
    const good = await runCli([...base, '--ai-model', MODEL_PATH, '--ai-llama-dir', LLAMA_TREE]);
    assert.equal(good.code, 0, good.out + good.err);
    assert.match(good.out, /llama check: PASS$/m);
    const wrongArgv = path.join(tmp, 'argv-wrong.json');
    write(wrongArgv, JSON.stringify({ ps_args: FIX.ps_args.replace('-ngl 999', '-ngl 0'), binary_realpath: FIX.binary_realpath }));
    const diff = await runCli(['--llm', f.url, '--commitments', cFile, '--argv-json', wrongArgv, '--ai-model', MODEL_PATH, '--ai-llama-dir', LLAMA_TREE]);
    assert.equal(diff.code, 1);
    assert.match(diff.err, /MISMATCH: flags/);
    const unver = await runCli(base);
    assert.equal(unver.code, 1);
    assert.match(unver.err, /unverified in a non-smoke run/);
    const smoke = await runCli([...base, '--smoke']);
    assert.equal(smoke.code, 0);
    assert.match(smoke.out, /PASS with 2 unverified item\(s\) \(smoke run\)/);
    const remote = await runCli(['--llm', 'http://example.invalid:41901', '--commitments', cFile]);
    assert.equal(remote.code, 2);
    assert.match(remote.err, /not a loopback URL/);
  } finally { await new Promise(r => { f.srv.closeAllConnections?.(); f.srv.close(r); }); }
});

// ---- commitments: measured or "unmeasured", never the pinned constants; non-smoke needs the files
function makeCommitRepo() {
  const root = fs.mkdtempSync(path.join(tmp, 'crepo-'));
  for (const [p, d] of [['permutation-gateway/citizens/a.txt', 'x\n'], ['permutation-server/web/frontier/council/b.txt', 'x\n'], ['docs/x.md', 'x\n']]) write(path.join(root, p), d);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const smokeStack = new URL('../citizens/stack/ai-smoke.toml', import.meta.url).pathname;
const smokeCfg = new URL('../citizens/config/smoke.json', import.meta.url).pathname;
const abCfg = new URL('../citizens/config/ab.json', import.meta.url).pathname;
function slotsFile(dir) {
  const f = path.join(dir, 'ai-slots.json');
  write(f, `${JSON.stringify(R.makeSlots({ seed: 41, n: 6 }))}\n`);
  return f;
}

test('R9 commitments: with nothing measured the model and the llama tree say "unmeasured", not the pinned constants; measured values are carried as measured', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'm1-'));
  const base = { repoRoot: R.REPO_ROOT, aiDir: dir, stackPath: smokeStack, citizensConfigPath: smokeCfg, slotsPath: slotsFile(dir), deck: 'deck-1' };
  const none = R.collectInputs(base);
  assert.deepEqual(none.model, { file: R.UNMEASURED, sha256: R.UNMEASURED, alias: 'gemma-4-26b-a4b-it' });
  assert.equal(none.server.tree_sha256, R.UNMEASURED);
  assert.notEqual(none.model.sha256, R.PINNED_MODEL.sha256, 'the pinned constant is not asserted');
  const tree = path.join(dir, 'tree'); write(path.join(tree, 'bin', 'llama-server'), 'bin');
  const got = R.collectInputs({ ...base, model: { file: 'm.gguf', sha256: 'c'.repeat(64) }, llama: { dir: tree } });
  assert.deepEqual(got.model, { file: 'm.gguf', sha256: 'c'.repeat(64), alias: 'gemma-4-26b-a4b-it' });
  assert.equal(got.server.tree_sha256, R.treeSha256Dir(tree));
  assert.throws(() => R.collectInputs({ ...base, llama: { dir: path.join(dir, 'nope') } }), /does not exist: nothing to measure/);
});

test('R9 registrar commit CLI: a non-smoke config without --model and --llama-dir is refused; the smoke config is not; measured values land in the file', async () => {
  const root = makeCommitRepo();
  void root;
  const dir = fs.mkdtempSync(path.join(tmp, 'm2-'));
  const slots = slotsFile(dir);
  const common = ['commit', '--ai-dir', dir, '--key', path.join(dir, 'keys', 'registrar.json'), '--stack', smokeStack, '--slots', slots, '--deck', 'deck-1', '--run-id', 'r9', '--prepare-only', '--allow-dirty'];
  const quiet = { log: () => {}, out: () => {} };
  await assert.rejects(() => R.main([...common, '--citizens-config', abCfg], quiet), /non-smoke run \(config ab\.json\) needs --model \(AI_MODEL\) and --llama-dir/);
  await assert.rejects(() => R.main([...common, '--citizens-config', abCfg, '--model', path.join(dir, 'm.gguf')], quiet), /needs --model/);
  assert.equal(await R.main([...common, '--citizens-config', smokeCfg], quiet), 0);
  const smoke = JSON.parse(read(path.join(dir, 'pub', 'commitments.json')));
  assert.equal(smoke.model.sha256, R.UNMEASURED);
  assert.equal(smoke.server.tree_sha256, R.UNMEASURED);
  // a non-smoke run with both
  const dir2 = fs.mkdtempSync(path.join(tmp, 'm3-'));
  const model = path.join(dir2, 'tiny.gguf'); write(model, 'tiny model bytes\n');
  const tree = path.join(dir2, 'llama'); write(path.join(tree, 'bin', 'llama-server'), 'bin');
  const args2 = common.map(a => (a === dir ? dir2 : a === path.join(dir, 'keys', 'registrar.json') ? path.join(dir2, 'keys', 'registrar.json') : a === slots ? slotsFile(dir2) : a));
  assert.equal(await R.main([...args2, '--citizens-config', abCfg, '--model', model, '--llama-dir', tree], quiet), 0);
  const c = JSON.parse(read(path.join(dir2, 'pub', 'commitments.json')));
  assert.equal(c.model.sha256, R.sha256hex(read(model)));
  assert.equal(c.model.file, 'tiny.gguf');
  assert.equal(c.server.tree_sha256, R.treeSha256Dir(tree));
});

test('R9 guards: a non-smoke run without AI_MODEL / AI_LLAMA_DIR (or with paths that are not a file / a directory) is refused by --check; smoke.json is not', () => {
  const cfgNonSmoke = abCfg;
  const env = { AI_MODEL: path.join(tmp, 'g.gguf'), AI_LLAMA_DIR: path.join(tmp, 'gtree') };
  write(env.AI_MODEL, 'x'); fs.mkdirSync(env.AI_LLAMA_DIR, { recursive: true });
  assert.deepEqual(G.measurementProblems({ citizensConfigPath: cfgNonSmoke, env }), []);
  const none = G.measurementProblems({ citizensConfigPath: cfgNonSmoke, env: {} });
  assert.equal(none.length, 2);
  assert.match(none[0], /AI_MODEL is not set: a non-smoke run \(config ab\.json\)/);
  assert.match(none[1], /AI_LLAMA_DIR is not set/);
  assert.match(G.measurementProblems({ citizensConfigPath: cfgNonSmoke, env: { ...env, AI_MODEL: tmp } })[0], /is not a file/);
  assert.match(G.measurementProblems({ citizensConfigPath: cfgNonSmoke, env: { ...env, AI_LLAMA_DIR: env.AI_MODEL } })[0], /is not a directory/);
  assert.deepEqual(G.measurementProblems({ citizensConfigPath: smokeCfg, env: {} }), [], 'smoke.json may leave both unset');
  assert.equal(R.isSmokeConfig('/x/main.json'), false);
  assert.equal(R.isSmokeConfig('/x/smoke.json'), true);
  // the whole check, through checkAll, on the real ab.json
  const repo = makeCommitRepo();
  const r = G.checkAll({ repo, stackPath: smokeStack, citizensConfigPath: abCfg, env: {}, ps: [], busy: () => false });
  assert.ok(r.refusals.some(x => /AI_MODEL is not set/.test(x)), r.refusals.join('\n'));
  // and the script's --check (the shell path), without the variables
  const e = { ...process.env, AI_REPO: repo }; delete e.AI_MODEL; delete e.AI_LLAMA_DIR; delete e.AI_STACK_LOCK;
  const out = spawnSync('bash', [path.join(bin, 'ai-citizens-run.sh'), '--stack', smokeStack, '--citizens-config', abCfg, '--no-busy-check', '--check'], { env: e, encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /REFUSED: AI_MODEL is not set/);
  const ok = spawnSync('bash', [path.join(bin, 'ai-citizens-run.sh'), '--stack', smokeStack, '--citizens-config', smokeCfg, '--no-busy-check', '--check'], { env: e, encoding: 'utf8', timeout: 60_000 });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

// ================================================================== 3. no anchor is sent twice
const social = b => String(b).padStart(2, '0').repeat(32).slice(0, 64);
function writeBell(aiDir, bell) {
  write(path.join(aiDir, 'pub', 'talk', `${bell}.json`), JSON.stringify({ bell, root: social(bell), records: [] }));
  write(path.join(aiDir, 'pub', 'minds', `${bell}.json`), JSON.stringify({ bell, root: social(bell + 1), records: [] }));
}
/** An in-memory chain: counts the memos sent, can stall a send, lose a status, or never confirm. */
function fakeRpc({ stall = null, statusLost = false } = {}) {
  const st = { sent: [], statuses: new Map(), n: 0 };
  return {
    st,
    async call(method, params = []) {
      if (method === 'getLatestBlockhash') return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
      if (method === 'sendTransaction') {
        if (stall) await stall;
        const tx = Transaction.from(Buffer.from(params[0], 'base64'));
        const text = Buffer.from(tx.instructions[0].data).toString('utf8');
        const sig = `SIG${++st.n}`;
        st.sent.push({ sig, text });
        st.statuses.set(sig, { slot: 100 + st.n, err: null });
        return sig;
      }
      if (method === 'getSignatureStatuses') return { value: params[0].map(s => (statusLost && !st.revealed ? null : st.statuses.get(s) ?? null)) };
      if (method === 'getTransaction') return { blockTime: 1_790_000_000 };
      throw new Error(`unexpected ${method}`);
    },
  };
}
const OTHER = process.ppid; // a second live process id for "the other registrar"
const kpOf = () => Keypair.generate();

test('R9 anchors: while one registrar process is sending a bell, the other sends NOTHING for it and for later bells; the memo goes out once', async () => {
  const aiDir = fs.mkdtempSync(path.join(tmp, 'a1-'));
  writeBell(aiDir, 10); writeBell(aiDir, 11);
  let release;
  const stall = new Promise(r => { release = r; });
  const rpcRun = fakeRpc({ stall });
  const rpcPublish = fakeRpc();
  const kp = kpOf();
  const run = R.anchorPass({ aiDir, kp, rpc: rpcRun, season: 31, pid: process.pid }); // `registrar run`, stalled inside sendTransaction
  await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(R.anchorClaimFile(aiDir, 10)), 'bell 10 is claimed before the memo is sent');
  const pub = await R.anchorPass({ aiDir, kp, rpc: rpcPublish, season: 31, pid: OTHER }); // `registrar publish`, at the same time
  assert.deepEqual(pub.anchored, []);
  assert.deepEqual(pub.claimed, [10], 'bell 10 is left to its live claimant; the pass stops there (memo order)');
  assert.equal(rpcPublish.st.sent.length, 0, 'the second process sent no memo');
  release();
  const done = await run;
  assert.deepEqual(done.anchored, [10, 11]);
  const again = await R.anchorPass({ aiDir, kp, rpc: rpcPublish, season: 31, pid: OTHER });
  assert.deepEqual(again, { anchored: [], gaps: [] });
  assert.equal(rpcRun.st.sent.length + rpcPublish.st.sent.length, 2, 'exactly one memo per bell in total');
  assert.deepEqual(rpcRun.st.sent.map(s => s.text.split(' ')[2]), ['10', '11']);
});

test('R9 anchors: `publish` waits for the bells a live `run` still has in flight before it writes the index', async () => {
  const aiDir = fs.mkdtempSync(path.join(tmp, 'a2-'));
  writeBell(aiDir, 20);
  let release;
  const stall = new Promise(r => { release = r; });
  const kp = kpOf();
  const run = R.anchorPass({ aiDir, kp, rpc: fakeRpc({ stall }), season: 31, pid: OTHER });
  await new Promise(r => setTimeout(r, 50));
  const quick = await R.waitForClaimedAnchors({ aiDir, pid: process.pid, timeoutMs: 120, intervalMs: 20 });
  assert.deepEqual(quick.pending, [20], 'still in flight after the bounded wait');
  const waiting = R.waitForClaimedAnchors({ aiDir, pid: process.pid, timeoutMs: 5000, intervalMs: 20 });
  setTimeout(release, 80);
  await run;
  assert.deepEqual((await waiting).pending, [], 'it returns once the anchor exists');
  assert.ok(fs.existsSync(path.join(aiDir, 'pub', 'anchors', '20.json')));
});

test('R9 anchors: failure after the signature keeps the claim with it; the next attempt asks the chain first and sends nothing new', async () => {
  const aiDir = fs.mkdtempSync(path.join(tmp, 'a4-'));
  writeBell(aiDir, 40);
  const kp = kpOf();
  const st = { sent: [], statuses: new Map(), n: 0, lost: true };
  const rpc = {
    st,
    async call(method, params = []) {
      if (method === 'getLatestBlockhash') return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
      if (method === 'sendTransaction') { const sig = `SIG${++st.n}`; st.sent.push({ sig }); st.statuses.set(sig, { slot: 7, err: null }); return sig; }
      if (method === 'getSignatureStatuses') throw new Error('rpc went away');
      throw new Error(`unexpected ${method}`);
    },
  };
  const failed = await R.anchorPass({ aiDir, kp, rpc, season: 31, pid: process.pid, state: { failed: new Map() }, log: () => {} });
  assert.deepEqual(failed.anchored, []);
  const claim = JSON.parse(read(R.anchorClaimFile(aiDir, 40)));
  assert.equal(claim.signature, 'SIG1', 'the claim keeps the signature that was sent');
  assert.equal(st.sent.length, 1);
  // the chain is back: the earlier signature landed, so the bell is anchored from it and no new memo goes out
  rpc.call = async (method, params = []) => {
    if (method === 'getSignatureStatuses') return { value: params[0].map(s => st.statuses.get(s) ?? null) };
    throw new Error(`nothing else may be called: ${method}`);
  };
  const ok = await R.anchorPass({ aiDir, kp, rpc, season: 31, pid: process.pid, state: { failed: new Map() }, log: () => {} });
  assert.deepEqual(ok.anchored, [40]);
  assert.equal(st.sent.length, 1, 'still one memo');
  assert.equal(JSON.parse(read(path.join(aiDir, 'pub', 'anchors', '40.json'))).signature, 'SIG1');
});

test('R9 anchors: a claim whose process is dead is taken over race-free; with a landed signature nothing is sent, without one the bell is sent once', async () => {
  const kp = kpOf();
  // dead holder that had sent a memo which landed
  const a = fs.mkdtempSync(path.join(tmp, 'a5-'));
  writeBell(a, 50);
  write(R.anchorClaimFile(a, 50), JSON.stringify({ pid: deadPid(), bell: 50, started: 't', signature: 'SIGX' }));
  const st = { sent: 0 };
  const landed = { async call(m, p) { if (m === 'getSignatureStatuses') return { value: [{ slot: 9, err: null }] }; st.sent++; throw new Error(`no ${m}`); } };
  const r = await R.anchorPass({ aiDir: a, kp, rpc: landed, season: 31, pid: process.pid, log: () => {} });
  assert.deepEqual(r.anchored, [50]);
  assert.equal(st.sent, 0);
  assert.equal(JSON.parse(read(path.join(a, 'pub', 'anchors', '50.json'))).signature, 'SIGX');
  // dead holder with no signature: sent once, by the taker
  const b = fs.mkdtempSync(path.join(tmp, 'a6-'));
  writeBell(b, 51);
  write(R.anchorClaimFile(b, 51), JSON.stringify({ pid: deadPid(), bell: 51, started: 't', signature: null }));
  const rpc = fakeRpc();
  assert.deepEqual((await R.anchorPass({ aiDir: b, kp, rpc, season: 31, pid: process.pid, log: () => {} })).anchored, [51]);
  assert.equal(rpc.st.sent.length, 1);
  // a dead holder's claim for a bell that already has its anchor file: never sent again
  const c = fs.mkdtempSync(path.join(tmp, 'a7-'));
  writeBell(c, 52);
  write(R.anchorClaimFile(c, 52), JSON.stringify({ pid: deadPid(), bell: 52, started: 't', signature: null }));
  write(path.join(c, 'pub', 'anchors', '52.json'), JSON.stringify({ bell: 52, signature: 'S', slot: 1 }));
  const rpc3 = fakeRpc();
  await R.anchorPass({ aiDir: c, kp, rpc: rpc3, season: 31, pid: process.pid, log: () => {} });
  assert.equal(rpc3.st.sent.length, 0);
});

test('R9 anchors: a failure before any signature frees the bell for the next pass; claims never reach PUB and the claim dir is under keys/', async () => {
  const aiDir = fs.mkdtempSync(path.join(tmp, 'a8-'));
  writeBell(aiDir, 60);
  const kp = kpOf();
  const down = { async call() { throw new Error('rpc down'); } };
  const r = await R.anchorPass({ aiDir, kp, rpc: down, season: 31, pid: process.pid, state: { failed: new Map() }, log: () => {} });
  assert.deepEqual(r.anchored, []);
  assert.ok(!fs.existsSync(R.anchorClaimFile(aiDir, 60)), 'nothing was sent: the claim is released');
  const rpc = fakeRpc();
  assert.deepEqual((await R.anchorPass({ aiDir, kp, rpc, season: 31, pid: OTHER, log: () => {} })).anchored, [60], 'the other process can now send it');
  assert.equal(rpc.st.sent.length, 1);
  assert.match(R.anchorClaimFile(aiDir, 60), /\/keys\/anchor-claims\/60\.json$/);
  assert.deepEqual(fs.readdirSync(path.join(aiDir, 'pub')).filter(n => /claim/.test(n)), []);
});

test('R9 anchors: two real processes (node) running `anchorPass` over the same bells send each memo once', async () => {
  const aiDir = fs.mkdtempSync(path.join(tmp, 'a9-'));
  for (const b of [70, 71, 72, 73, 74]) writeBell(aiDir, b);
  const logFile = path.join(aiDir, 'sent.log');
  const script = `
    import * as R from ${JSON.stringify(new URL('../citizens/registrar.mjs', import.meta.url).href)};
    import { Keypair, Transaction } from '@solana/web3.js';
    import fs from 'node:fs';
    const rpc = { async call(m, p = []) {
      if (m === 'getLatestBlockhash') return { value: { blockhash: Keypair.generate().publicKey.toBase58() } };
      if (m === 'sendTransaction') { await new Promise(r => setTimeout(r, 40)); const tx = Transaction.from(Buffer.from(p[0], 'base64')); fs.appendFileSync(${JSON.stringify(logFile)}, Buffer.from(tx.instructions[0].data).toString('utf8') + '\\n'); return 'SIG' + process.pid + Math.random(); }
      if (m === 'getSignatureStatuses') return { value: [{ slot: 5, err: null }] };
      if (m === 'getTransaction') return { blockTime: 1 };
      throw new Error(m);
    } };
    const kp = Keypair.generate();
    for (let i = 0; i < 40; i++) { await R.anchorPass({ aiDir: ${JSON.stringify(aiDir)}, kp, rpc, season: 31 }); await new Promise(r => setTimeout(r, 15)); }
  `;
  // `-e` with the gateway as cwd: bare imports (@solana/web3.js) resolve from there
  const cwd = new URL('..', import.meta.url).pathname;
  const run = () => new Promise(resolve => { const p = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; p.stderr.on('data', d => { err += d; }); p.on('close', code => resolve({ code, err })); });
  const [x, y] = await Promise.all([run(), run()]);
  assert.deepEqual([x.code, y.code], [0, 0], x.err + y.err);
  const lines = read(logFile).trim().split('\n');
  const bells = lines.map(l => l.split(' ')[2]).sort();
  assert.deepEqual(bells, ['70', '71', '72', '73', '74'], `each memo once: ${lines.join(' | ')}`);
});
