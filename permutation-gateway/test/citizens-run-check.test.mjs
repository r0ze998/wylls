// citizens/bin/{ai-citizens-run.sh, run-guards.mjs, ai-hook-check.sh} and the three stack configs (unit AC5; contract
// sections 1.1, 7.1 Guards, 8.4, 0.2, 10.2 G10): the run script's --check refuses a paid-API variable or key file, the old
// gateway, an uncommitted guarded tree, forbidden or busy ports, a non-loopback citizens config and a held stack lock;
// --dry-run prints the start order and starts nothing; the hook check passes its own self-test and the real tree.
// Nothing here starts a stack, a model or any service; the script runs against a throwaway git repository (AI_REPO).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as G from '../citizens/bin/run-guards.mjs';
import { parseStackToml } from '../citizens/registrar.mjs';

const bin = new URL('../citizens/bin/', import.meta.url).pathname;
const STACKS = new URL('../citizens/stack/', import.meta.url).pathname;
const CONFIG = new URL('./fixtures/ai-run-config.json', import.meta.url).pathname;
const REAL_REPO = path.resolve(bin, '..', '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-run-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const read = p => fs.readFileSync(p, 'utf8');
const write = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** A throwaway repository with one committed file under each guarded tree. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
  for (const p of ['permutation-gateway/citizens/a.txt', 'permutation-server/web/frontier/council/b.txt', 'frontier-node/crates/bots/c.txt', 'frontier-node/crates/agents/d.txt', 'frontier-node/crates/herald/e.txt', 'frontier-node/crates/stack/f.txt', 'docs/x.md']) write(path.join(root, p), 'x\n');
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...a], { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { root, git };
}
// R9: a non-smoke run names the gguf and the llama.cpp tree it measures; these tests run no model, so the files are stand-ins
const FAKE_MODEL = path.join(tmp, 'fake-model.gguf');
const FAKE_LLAMA = path.join(tmp, 'fake-llama');
write(FAKE_MODEL, 'a stand-in, not a model\n');
write(path.join(FAKE_LLAMA, 'bin', 'llama-server'), 'a stand-in binary\n');
const cleanEnv = () => {
  const e = { ...process.env, AI_MODEL: FAKE_MODEL, AI_LLAMA_DIR: FAKE_LLAMA };
  for (const k of Object.keys(e)) if (G.API_KEY_ENV.includes(k) || /^(ANTHROPIC|OPENAI)_.*(KEY|TOKEN)$/.test(k)) delete e[k];
  return e;
};
/** Run the script; a throwaway repo and lock by default. */
function run(args, { repo, env = {}, lock = path.join(tmp, `lock-${Math.random().toString(16).slice(2)}`) } = {}) {
  const r = repo ?? makeRepo();
  const out = spawnSync('bash', [path.join(bin, 'ai-citizens-run.sh'), ...args], { env: { ...cleanEnv(), AI_REPO: r.root, AI_STACK_LOCK: lock, ...env }, encoding: 'utf8', timeout: 60_000 });
  return { code: out.status, out: out.stdout, err: out.stderr, text: out.stdout + out.stderr, repo: r, lock };
}
/** The same, without blocking the event loop (a fake llama-server in this process has to answer the script's curl). */
function runAsync(args, { repo, env = {}, lock }) {
  return new Promise(resolve => {
    const p = spawn('bash', [path.join(bin, 'ai-citizens-run.sh'), ...args], { env: { ...cleanEnv(), AI_REPO: repo.root, AI_STACK_LOCK: lock, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err, text: out + err }));
  });
}
const smoke = path.join(STACKS, 'ai-smoke.toml');
const check = (extra = [], opts) => run(['--stack', smoke, '--citizens-config', CONFIG, '--no-busy-check', '--check', ...extra], opts);

// ------------------------------------------------------------------ the stack configs
test('the three stack configs: the pinned values, the test chain, every port in 41901-41999 and the stack\'s own parser rules (bots_args is a string)', () => {
  const want = {
    'ai-citizens': { run_id: 'ai-main', mode: 'accel', beacon: 'test-key', scale: 10, preseason_scale: 2000, days: 3, bots: 180, bot_seed: 31, season_id: 31, base_port: 41900, bots_args: '--follow-council' },
    'ai-ab': { run_id: 'ai-ab', mode: 'accel', beacon: 'test-key', scale: 10, preseason_scale: 2000, game_hours: 16, bots: 120, bot_seed: 33, season_id: 33, base_port: 41900, bots_args: '--follow-council' },
    'ai-smoke': { run_id: 'ai-smoke', mode: 'accel', beacon: 'test-key', scale: 10, preseason_scale: 2000, game_hours: 12, bots: 30, bot_seed: 41, season_id: 41, base_port: 41900, bots_args: '--follow-council' },
  };
  for (const [name, exp] of Object.entries(want)) {
    const t = parseStackToml(read(path.join(STACKS, `${name}.toml`)));
    for (const [k, v] of Object.entries(exp)) assert.equal(t[k], v, `${name}.${k}`);
    assert.equal(typeof t.bots_args, 'string');
    const ports = G.stackPorts(t);
    assert.deepEqual(G.portProblems(ports), [], name);
    assert.deepEqual(ports, { localnet: 41910, localnet_ws: 41911, drand: 41920, relay_operator: 41930, relay_public: 41933, herald: 41940, keeper_a: 41950, keeper_b: 41951, bots: 41970, viewers: 41975 });
    assert.equal(t['chaos.enabled'], false);
    assert.equal(t['adversary.enabled'], false);
  }
  // Only keys the stack's config reader knows (it refuses unknown keys): the list is the one in stack/src/config.rs from_toml.
  const known = new Set(['run_id', 'mode', 'beacon', 'scale', 'preseason_scale', 'drain_scale', 'days', 'game_hours', 'drain_bells', 'bots', 'bot_seed', 'personas', 'bots_args', 'eager_bots', 'season_id', 'base_port', 'g0', 'drand_delay_ms', 'keeper_b', 'season_end_at_play_end', 'keeper_b_backup_delay_slots', 'pause_at_end', 'end_season', 'pools.beneficiary_lamports', 'chaos.enabled', 'adversary.enabled']);
  for (const name of Object.keys(want)) for (const k of Object.keys(parseStackToml(read(path.join(STACKS, `${name}.toml`))))) assert.ok(known.has(k), `${name}: ${k}`);
});

// ------------------------------------------------------------------ the guards as a module
test('port rule: 41901-41999 only; 41900 itself, 41000-41899 and the reserved ports are refused; a duplicate and a busy port are named', () => {
  assert.deepEqual(G.portProblems({ a: 41902, b: 41999, c: 41901 }), []);
  for (const p of [41900, 41899, 41100, 41041, 41300, 41000, 42000, 4185, 4190, 4191, 4194, 18899, 17799, 28899, 27799, 26699, 5185, 5191]) {
    assert.equal(G.portProblems({ x: p }).length, 1, String(p));
  }
  assert.match(G.portProblems({ a: 41930, b: 41930 }).join(), /also a's/);
  assert.match(G.portProblems({ a: 41930 }, { busy: p => p === 41930 }).join(), /already listened on/);
  assert.match(G.portProblems({ a: 'x' }).join(), /not a port/);
  assert.deepEqual(G.stackPorts({ base_port: 41900, 'ports.herald': 41 }).herald, 41941);
});

test('environment: the paid-API variables are refused, an unrelated variable is not', () => {
  assert.deepEqual(G.envProblems({ PATH: '/bin', ANTHROPIC_BASE_URL: 'x', CLAUDE_CODE_TOKEN: 'x' }), []);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_SOMETHING_KEY', 'ANTHROPIC_FOO_TOKEN']) assert.equal(G.envProblems({ [k]: '' }).length, 1, `${k} even when empty`);
});

test('the old gateway is src/server.mjs, not the M1 relay src/frontier/server.mjs', () => {
  assert.equal(G.oldGatewayProblems(['node src/server.mjs', '/usr/bin/node /x/permutation-gateway/src/server.mjs --port 4185']).length, 2);
  assert.deepEqual(G.oldGatewayProblems(['node src/frontier/server.mjs --program x', 'node permutation-gateway/src/frontier/server.mjs', 'vim src/serverless.mjs']), []);
});

test('the citizens config: loopback URLs only, ports in 41901-41999 and none of the stack\'s', () => {
  const ok = JSON.parse(read(CONFIG));
  assert.deepEqual(G.urlProblems(ok), []);
  assert.match(G.urlProblems({ llm: { url: 'http://example.com:41901' } }).join(), /not a loopback/);
  assert.match(G.urlProblems({ a: { b: 'https://127.0.0.1:41901' } }).join(), /not a loopback/);
  assert.match(G.urlProblems({ llm: { url: 'http://127.0.0.1:8080' } }).join(), /outside 41901-41999/);
  assert.deepEqual(G.citizensPorts(ok), { 'llm.url': 41901, 'serve.port': 41902, 'ports.llama': 41901, 'ports.serve': 41902, 'ports.mind': 41980, 'ports.social': 41981, 'ports.registrar': 41982 });
  const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const bad = { ...ok, serve: { port: 41940 } };
  write(path.join(dir, 'c.json'), JSON.stringify(bad));
  const r = G.checkAll({ repo: makeRepo().root, stackPath: smoke, citizensConfigPath: path.join(dir, 'c.json'), env: {}, ps: [], busy: () => false });
  assert.ok(r.refusals.some(x => /serve\.port: port 41940 is the stack's/.test(x)), r.refusals.join('\n'));
});

test('the lock: taken once, refused while its pid lives, replaced when the pid is gone, released only by its owner', () => {
  const f = path.join(tmp, 'lock-unit');
  assert.deepEqual(G.takeLock(f, { pid: process.pid, unit: 'ai-ac5', run_id: 'r1' }), { ok: true, replaced: false });
  assert.deepEqual(JSON.parse(read(f)).run_id, 'r1');
  assert.deepEqual(Object.keys(JSON.parse(read(f))).sort(), ['pid', 'run_id', 'started', 'unit']);
  const second = G.takeLock(f, { pid: process.pid, unit: 'x', run_id: 'r2' });
  assert.equal(second.ok, false);
  assert.equal(second.holder.run_id, 'r1');
  assert.equal(G.lockProblems(f).length, 1);
  assert.equal(G.releaseLock(f, 'other'), false);
  assert.ok(fs.existsSync(f));
  assert.equal(G.releaseLock(f, 'r1'), true);
  assert.ok(!fs.existsSync(f));
  // A stale lock (a pid that is gone) does not hold.
  const dead = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
  write(f, JSON.stringify({ pid: Number(dead), unit: 'old', run_id: 'old', started: 'then' }));
  assert.deepEqual(G.lockProblems(f), []);
  assert.deepEqual(G.takeLock(f, { pid: process.pid, unit: 'ai-ac5', run_id: 'r3' }), { ok: true, replaced: true });
  G.releaseLock(f, 'r3');
});


test('every command-line entry runs when its path goes through a symlink (macOS /var is one) and prints before it exits', () => {
  const link = path.join(tmp, 'citizens-link');
  fs.symlinkSync(path.resolve(bin, '..'), link);
  const out = path.join(tmp, 'slots-via-link.json');
  const r = spawnSync('node', [path.join(link, 'registrar.mjs'), 'slots', '--stack', smoke, '--n', '6', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /slots: .* \(6 AI \+ seat, seed 41\)/);
  assert.ok(fs.existsSync(out));
  const g = spawnSync('node', [path.join(link, 'bin', 'run-guards.mjs'), 'ports', '--stack', smoke], { encoding: 'utf8' });
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /herald=41940/);
  const bad = spawnSync('node', [path.join(link, 'bin', 'run-guards.mjs'), 'bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage/);
  const c = spawnSync('node', [path.join(link, 'scenario', 'census.mjs'), '--herald', 'http://203.0.113.9:41940', '--ai-dir', tmp, '--once'], { encoding: 'utf8' });
  assert.equal(c.status, 2);
  assert.match(c.stderr, /not a loopback URL/);
  const sv = spawnSync('node', [path.join(link, 'serve.mjs'), '--ai-dir', tmp, '--herald', 'http://127.0.0.1:41940', '--social', 'http://127.0.0.1:41981', '--page-dir', tmp, '--port', '41300'], { encoding: 'utf8' });
  assert.equal(sv.status, 2);
  assert.match(sv.stderr, /outside 41901-41999/);
});

// ------------------------------------------------------------------ the run script: --check
test('--check passes on a clean tree with the shipped configs', () => {
  const r = check();
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /guards: PASS/);
});

test('--check refuses a paid-API key variable (set, even empty) and a key file under .local', () => {
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const r = check([], { env: { [k]: 'x' } });
    assert.equal(r.code, 1, k);
    assert.match(r.err, new RegExp(`REFUSED: ${k} is set`));
    assert.doesNotMatch(r.text, /x{5}/, 'a value is never echoed');
  }
  assert.equal(check([], { env: { OPENAI_API_KEY: '' } }).code, 1);
  const repo = makeRepo();
  write(path.join(repo.root, '.local', 'anthropic-key'), 'sk-test');
  const r = check([], { repo });
  assert.equal(r.code, 1);
  assert.match(r.err, /\.local\/anthropic-key exists/);
  assert.doesNotMatch(r.text, /sk-test/);
});

test('--check refuses uncommitted changes under every guarded path and nothing else', () => {
  for (const p of ['permutation-gateway/citizens/a.txt', 'permutation-server/web/frontier/council/b.txt', 'frontier-node/crates/bots/c.txt', 'frontier-node/crates/agents/d.txt', 'frontier-node/crates/herald/e.txt', 'frontier-node/crates/stack/f.txt']) {
    const repo = makeRepo();
    write(path.join(repo.root, p), 'changed\n');
    const r = check([], { repo });
    assert.equal(r.code, 1, p);
    assert.match(r.err, /uncommitted changes under the guarded paths/);
    repo.git('checkout', '--', '.');
    assert.equal(check([], { repo }).code, 0, `${p} after checkout`);
  }
  const repo = makeRepo();
  write(path.join(repo.root, 'permutation-gateway/citizens/new.txt'), 'untracked\n');
  assert.equal(check([], { repo }).code, 1, 'an untracked file counts');
  const other = makeRepo();
  write(other.root + '/docs/x.md', 'changed\n');
  write(other.root + '/scratch.txt', 'x\n');
  assert.equal(check([], { repo: other }).code, 0, 'a change outside the guarded paths is not a refusal');
});

test('--check refuses forbidden ports and a busy port: 41900 itself, 41000-41899, the reserved list, outside 41999', async () => {
  const t = base => { const f = path.join(tmp, `s-${Math.random().toString(16).slice(2)}.toml`); write(f, base); return f; };
  const body = read(smoke);
  const cases = [
    ['base 41000 (the m1-exit block)', body.replace('base_port = 41900', 'base_port = 41000'), /41010|41041|outside 41901|41000-41899/],
    ['base 41300 (MC)', body.replace('base_port = 41900', 'base_port = 41300'), /41000-41899/],
    ['base 41100 (the playtest)', body.replace('base_port = 41900', 'base_port = 41100'), /41000-41899/],
    ['an offset that lands on 41900', body.replace('base_port = 41900', 'base_port = 41890\n[ports]\nlocalnet = 10\n').replace('[pools]', '[pools]'), /41900/],
    ['base 41990 (offsets leave the block)', body.replace('base_port = 41900', 'base_port = 41990'), /outside 41901-41999/],
    ['a reserved port', body.replace('base_port = 41900', 'base_port = 4100\n[ports]\nherald = 85\n'), /reserved|outside/],
  ];
  for (const [what, toml, re] of cases) {
    const r = run(['--stack', t(toml), '--citizens-config', CONFIG, '--no-busy-check', '--check']);
    assert.equal(r.code, 1, what + '\n' + r.text);
    assert.match(r.err, re, what);
  }
  // A listener on one of the stack's ports is named: the viewers' port is moved onto a free port of the block.
  const free = await (async () => {
    for (let p = 41960; p < 41969; p++) {
      const srv = net.createServer();
      const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(p, '127.0.0.1', () => res(true)); });
      if (ok) return { p, s: srv };
    }
    return null;
  })();
  assert.ok(free, 'a free port in 41960-41968 to listen on');
  try {
    const busy = path.join(tmp, 'busy.toml');
    write(busy, `${body}\n[ports]\nviewers = ${free.p - 41900}\n`);
    const r = run(['--stack', busy, '--citizens-config', CONFIG, '--check']);
    assert.equal(r.code, 1, r.text);
    assert.match(r.err, new RegExp(`viewers: port ${free.p} is already listened on`));
  } finally { await new Promise(res => free.s.close(res)); }
});

test('--check refuses a stack that is not the local test chain, and a citizens config that leaves the loopback', () => {
  const body = read(smoke);
  const f1 = path.join(tmp, 'archive.toml'); write(f1, body.replace('beacon = "test-key"', 'beacon = "archive"'));
  const r1 = run(['--stack', f1, '--citizens-config', CONFIG, '--no-busy-check', '--check']);
  assert.equal(r1.code, 1);
  assert.match(r1.err, /only the test-key drand/);
  const f2 = path.join(tmp, 'arr.toml'); write(f2, body.replace('bots_args = "--follow-council"', 'bots_args = ["--follow-council"]'));
  const r2 = run(['--stack', f2, '--citizens-config', CONFIG, '--no-busy-check', '--check']);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /bad value/);
  const cfg = JSON.parse(read(CONFIG)); cfg.llm.url = 'http://203.0.113.9:41901';
  const f3 = path.join(tmp, 'cfg-out.json'); write(f3, JSON.stringify(cfg));
  const r3 = run(['--stack', smoke, '--citizens-config', f3, '--no-busy-check', '--check']);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /not a loopback http URL/);
  const cfg2 = JSON.parse(read(CONFIG)); delete cfg2.caps.march_share;
  const f4 = path.join(tmp, 'cfg-missing.json'); write(f4, JSON.stringify(cfg2));
  const r4 = run(['--stack', smoke, '--citizens-config', f4, '--no-busy-check', '--check']);
  assert.equal(r4.code, 1);
  assert.match(r4.err, /caps\.march_share is missing/);
});

test('--check refuses a held stack lock (a live pid) and says so; a stale lock is a note, not a refusal', () => {
  const lock = path.join(tmp, 'lock-held');
  write(lock, JSON.stringify({ pid: process.pid, unit: 'ai-ac1a', run_id: 'smoke-9', started: '2026-10-05T01:00:00Z' }));
  const r = check([], { lock });
  assert.equal(r.code, 1);
  assert.match(r.err, /the stack lock .* is held by pid \d+ \(ai-ac1a, run smoke-9/);
  const dead = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
  write(lock, JSON.stringify({ pid: Number(dead), unit: 'old', run_id: 'old', started: 'then' }));
  const s = check([], { lock });
  assert.equal(s.code, 0, s.text);
  assert.match(s.out, /note: a stale stack lock/);
});

test('--ab needs --rep (1..3) and --rep needs --ab; the script refuses unknown options', () => {
  assert.equal(check(['--ab', 'A']).code, 2);
  assert.equal(check(['--rep', '1']).code, 2);
  const r = check(['--ab', 'C', '--rep', '1']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--ab C: expected A or B/);
  assert.match(check(['--ab', 'A', '--rep', '4']).err, /--rep 4: expected 1, 2 or 3/);
  assert.equal(check(['--bogus']).code, 2);
  assert.equal(run(['--stack', smoke]).code, 2);
});

// ------------------------------------------------------------------ the run script: --dry-run
test('--dry-run prints the start order of 8.4 and starts and writes nothing', () => {
  const repo = makeRepo();
  const r = run(['--stack', smoke, '--citizens-config', CONFIG, '--no-busy-check', '--dry-run'], { repo });
  assert.equal(r.code, 0, r.text);
  const lines = r.out.split('\n').filter(l => l.startsWith('PLAN'));
  const at = re => { const i = lines.findIndex(l => re.test(l)); assert.ok(i >= 0, `missing ${re}\n${r.out}`); return i; };
  const order = [/PLAN lock/, /PLAN check .*\/health/, /PLAN run slots/, /PLAN run commit-prepare/, /PLAN run runs-add/, /PLAN commit RUNS\.md/, /PLAN start registrar-commit: .*--wait-rpc http:\/\/127\.0\.0\.1:41910/, /PLAN start stack:/, /PLAN wait until/, /PLAN start citizens:/, /PLAN wait for .*serve-health/, /PLAN run registrar-deal/, /PLAN start registrar-run/, /PLAN start fleet:/, /PLAN start census:/].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'start order');
  assert.match(r.out, /6 AI citizens \+ the presenter seat \(deck-1\), bot seed 41, season 41/);
  const text = r.out;
  assert.match(text, /frontier-stack up --config .*\/ai-smoke\/stack\.toml/);
  assert.match(text, /--experimental-permission --allow-fs-read=/);
  assert.match(text, /--allow-fs-write=\S*\/ai-smoke\/state --allow-fs-write=\S*\/ai-smoke\/pub /);
  assert.match(text, /--mind-port 41980 --social-port 41981 --serve-port 41902/);
  assert.match(text, /--first-index 1000 --bots 7 /);
  assert.match(text, /--ai-slots .*ai-slots\.json --brain http:\/\/127\.0\.0\.1:41980 --brain-token-file .*\/state\/mind\.token --follow-council --export-seat-key .*\/keys\/seat\.txt/);
  assert.match(text, /--control 127\.0\.0\.1:41971/);
  const perm = /--allow-fs-read=(\S+)/.exec(text)[1];
  for (const banned of ['/citizens/stack', '/citizens/bin', '/citizens/llama', '/citizens/ab', '/citizens/scenario', '/citizens/probe', '/citizens/injection', 'registrar.mjs', '/keys']) assert.ok(!perm.includes(banned), `the service may not read ${banned}`);
  // Nothing was written under the repository, nothing started (no pids file, no lock).
  assert.ok(!fs.existsSync(path.join(repo.root, '.local')), 'no AI_DIR');
  assert.ok(!fs.existsSync(r.lock));
  assert.ok(!fs.existsSync(path.join(repo.root, 'docs/frontier/ai-citizens/RUNS.md')));
  assert.match(r.out, /dry run: nothing was started or written/);
});

test('--dry-run names the A/B copy: arm and rep in the run id, bot_seed 32 + rep, season = seed, 12 AI citizens (deck-2); a rep 3 uses seed 35', () => {
  const ab = path.join(STACKS, 'ai-ab.toml');
  for (const [arm, rep, seed] of [['A', 1, 33], ['B', 1, 33], ['A', 2, 34], ['B', 3, 35]]) {
    const r = run(['--stack', ab, '--citizens-config', CONFIG, '--no-busy-check', '--dry-run', '--ab', arm, '--rep', String(rep)]);
    assert.equal(r.code, 0, r.text);
    assert.match(r.out, new RegExp(`run ai-ab-${arm}-${rep}: stack ai-ab base 41900 .*12 AI citizens .*\\(deck-2\\), bot seed ${seed}, season ${seed}, arm ${arm} rep ${rep}`));
    assert.match(r.out, new RegExp(`write .*ai-ab-${arm}-${rep}/stack\\.toml \\(run_id ai-ab-${arm}-${rep}, bot_seed ${seed}, season_id ${seed}\\)`));
    assert.match(r.out, /--bots 13 /);
    assert.match(r.out, new RegExp(`--arm ${arm}`) , 'the runs-add line carries arm and rep');
    assert.match(r.out, new RegExp(`runs-add .*--arm ${arm} --rep ${rep}`));
  }
  const main = run(['--stack', path.join(STACKS, 'ai-citizens.toml'), '--citizens-config', CONFIG, '--no-busy-check', '--dry-run']);
  assert.match(main.out, /run ai-main: stack ai-citizens .*18 AI citizens .*\(deck-3\), bot seed 31/);
  assert.match(main.out, /--bots 19 /);
  assert.match(main.out, /--days "?3"? /);
  const odd = run(['--stack', smoke, '--citizens-config', CONFIG, '--no-busy-check', '--dry-run', '--run-id', 'bad id']);
  assert.equal(odd.code, 2);
  const deck = run(['--stack', smoke, '--citizens-config', CONFIG, '--no-busy-check', '--dry-run', '--deck', 'deck-6']);
  assert.equal(deck.code, 2);
});

test('every child is started without the paid-API variables: the script\'s list is the guard\'s list', () => {
  const sh = read(path.join(bin, 'ai-citizens-run.sh'));
  const listed = /^UNSET_VARS="([^"]+)"/m.exec(sh)[1].split(' ').sort();
  assert.deepEqual(listed, [...G.API_KEY_ENV].sort());
  assert.match(sh, /env "\$\{UNSET\[@\]\}" "\$@"/);
  const children = sh.split('\n').filter(l => /^(bg|fg) /.test(l)).length;
  assert.ok(children >= 10, 'bg and fg are the only ways a child starts');
  assert.doesNotMatch(sh.replace(/^bg\(\).*$/m, ''), /^(?!#)\s*(nohup |setsid |exec )/m);
});

test('a real start without the other units refuses before anything is taken: no server.mjs, no binaries', () => {
  const repo = makeRepo();
  const r = run(['--stack', smoke, '--citizens-config', CONFIG, '--no-busy-check'], { repo, env: { FRONTIER_BIN: path.join(tmp, 'no-bin') } });
  assert.equal(r.code, 2);
  assert.match(r.err, /frontier-stack and frontier-bots are not in/);
  assert.ok(!fs.existsSync(path.join(repo.root, '.local')), 'nothing created');
  assert.ok(!fs.existsSync(r.lock), 'no lock taken');
  const bin2 = path.join(tmp, 'fake-bin');
  write(path.join(bin2, 'frontier-stack'), '#!/bin/sh\n'); write(path.join(bin2, 'frontier-bots'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin2, 'frontier-stack'), 0o755); fs.chmodSync(path.join(bin2, 'frontier-bots'), 0o755);
  const r2 = run(['--stack', smoke, '--citizens-config', CONFIG, '--no-busy-check'], { repo, env: { FRONTIER_BIN: bin2 } });
  assert.equal(r2.code, 2);
  assert.match(r2.err, /server\.mjs is missing/);
  assert.ok(!fs.existsSync(r2.lock));
});


// ------------------------------------------------------------------ the run script, started for real, failing at the stack
test('a real start in a throwaway repository: slots, commitments, the RUNS.md entry (committed), the registrar in the background, the stack that dies; the trap stops every child, writes the END line and releases the lock', async () => {
  // A fake llama on 41999 (never 41901: AC1a and the slice gate own that), a fake frontier-stack that exits at once.
  const llamaPort = 41999;
  const llama = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/props' ? '{"model_alias":"gemma-4-26b-a4b-it","total_slots":1,"build_info":"b11146-7fe450e19","default_generation_settings":{"n_ctx":16384}}' : '{"data":[{"id":"gemma-4-26b-a4b-it"}]}');
  });
  const up = await new Promise(res => { llama.once('error', () => res(false)); llama.listen(llamaPort, '127.0.0.1', () => res(true)); });
  if (!up) { llama.close(); return; } // the port is taken by somebody else: nothing to test against
  try {
    const repo = makeRepo();
    const ac = path.join(repo.root, 'permutation-gateway');
    for (const f of ['serve.mjs', 'registrar.mjs', 'lock.mjs']) write(path.join(ac, 'citizens', f), read(path.join(REAL_REPO, 'permutation-gateway', 'citizens', f)));
    for (const f of ['templates-hash.mjs', 'closer.mjs', 'seal.mjs']) write(path.join(ac, 'citizens', 'mind', f), read(path.join(REAL_REPO, 'permutation-gateway', 'citizens', 'mind', f))); // the registrar's imports of the mind's code (closer.mjs and seal.mjs: the season-end seal, integ-B)
    write(path.join(ac, 'citizens', 'server.mjs'), '// stub\n');
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'files');
    fs.symlinkSync(path.join(REAL_REPO, 'permutation-gateway', 'node_modules'), path.join(ac, 'node_modules'));
    const fbin = path.join(tmp, 'fake-fbin');
    const note = path.join(tmp, 'fake-stack-calls.txt');
    write(path.join(fbin, 'frontier-stack'), `#!/bin/sh\necho "$@ | FRONTIER_BIN=$FRONTIER_BIN PSF_REPO=$PSF_REPO" >> ${note}\ncase "$1" in up) exit 3 ;; esac\nexit 0\n`);
    write(path.join(fbin, 'frontier-bots'), '#!/bin/sh\nexit 0\n');
    for (const f of ['frontier-stack', 'frontier-bots']) fs.chmodSync(path.join(fbin, f), 0o755);
    const cfg = JSON.parse(read(CONFIG));
    cfg.llm.url = `http://127.0.0.1:${llamaPort}`; cfg.ports.llama = llamaPort;
    const cfgFile = path.join(tmp, 'cfg-41999.json'); write(cfgFile, JSON.stringify(cfg));
    const lock = path.join(tmp, 'lock-real');
    // R9: the llama check reads the command line of the process on the port; here a recorded one stands in for it (tests only)
    const argvFile = path.join(tmp, 'llama-argv.json');
    write(argvFile, JSON.stringify({ ps_args: `/x/llama-server -m ${FAKE_MODEL} --alias gemma-4-26b-a4b-it --host 127.0.0.1 --port 41901 --jinja --reasoning off -np 1 -c 16384 -ngl 999 -fa on --no-webui --metrics`, binary_realpath: path.join(FAKE_LLAMA, 'bin', 'llama-server') }));
    const r = await runAsync(['--stack', smoke, '--citizens-config', cfgFile, '--no-busy-check', '--run-id', 'ai-trap-1'], { repo, lock, env: { FRONTIER_BIN: fbin, AI_WAIT_STACK_SECS: '30', AI_LLAMA_ARGV_JSON: argvFile } });
    assert.match(r.text, /llama check: PASS/, r.text);
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /frontier-stack exited before it was running/);
    assert.match(r.text, /run ai-trap-1: aborted \(frontier-stack exited before it was running/);
    assert.ok(!fs.existsSync(lock), 'the lock is released');
    // The stack was started the way the contract says: the run's copy of the config, the binaries and the repository named.
    const calls = read(note);
    assert.match(calls, /^up --config .*\/ai-trap-1\/stack\.toml \| FRONTIER_BIN=.*fake-fbin PSF_REPO=/m);
    const copy = read(path.join(repo.root, '.local/frontier/ai/ai-trap-1/stack.toml'));
    assert.match(copy, /^run_id = "ai-trap-1"$/m);
    assert.match(copy, /^bot_seed = 41$/m);
    assert.match(copy, /^bots_args = "--follow-council"$/m);
    // The RUNS.md entry exists before the stack and was committed locally; the END line says aborted.
    const runs = read(path.join(repo.root, 'docs/frontier/ai-citizens/RUNS.md'));
    assert.match(runs, /^## ai-trap-1 \u2014 /m);
    const parsed = (await import('../citizens/registrar.mjs')).parseRunsMd(runs);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].run_id, 'ai-trap-1');
    assert.equal(parsed[0].end.status, 'aborted');
    assert.match(parsed[0].commitments_sha256, /^[0-9a-f]{64}$/);
    assert.equal(repo.git('log', '-1', '--format=%s').trim(), 'Wylls AI run: ai-trap-1');
    assert.equal(repo.git('status', '--porcelain', '--', 'permutation-gateway/citizens').trim(), '');
    // The commitments PUB file is what the RUNS.md line hashed; the key stays in keys/ (mode 700 dir, 600 file) and never in PUB.
    const aiDir = path.join(repo.root, '.local/frontier/ai/ai-trap-1');
    assert.equal(R_sha(read(path.join(aiDir, 'pub', 'commitments.json'))), parsed[0].commitments_sha256);
    assert.equal(fs.statSync(path.join(aiDir, 'keys')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(aiDir, 'keys', 'registrar.json')).mode & 0o777, 0o600);
    const { findKeyLikeFiles } = await import('../citizens/serve.mjs');
    assert.deepEqual(findKeyLikeFiles(path.join(aiDir, 'pub')), []);
    // Every child it started is gone.
    const pids = read(path.join(aiDir, 'pids')).trim().split('\n').map(l => l.split(' '));
    assert.ok(pids.some(([n]) => n === 'registrar-commit') && pids.some(([n]) => n === 'stack'));
    for (const [, pid] of pids) assert.throws(() => process.kill(Number(pid), 0), /ESRCH/, `pid ${pid} is gone`);
    // A run id is used once.
    const again = run(['--stack', smoke, '--citizens-config', cfgFile, '--no-busy-check', '--run-id', 'ai-trap-1'], { repo, lock, env: { FRONTIER_BIN: fbin } });
    assert.equal(again.code, 2);
    assert.match(again.err, /exists: a run id is used once/);
  } finally { await new Promise(res => { llama.closeAllConnections?.(); llama.close(res); }); }
});
const R_sha = text => crypto.createHash('sha256').update(text).digest('hex');

// ------------------------------------------------------------------ the hook check and the G10 greps
test('ai-hook-check.sh: its own self-test passes (every pinned violation shape is reported for its reason)', () => {
  const r = spawnSync('bash', [path.join(bin, 'ai-hook-check.sh'), '--self-test'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /self-test: PASS/);
  assert.doesNotMatch(r.stdout, /FAIL/);
});

test('ai-hook-check.sh on this tree (integ-A: --blank-ok, two spacing blank lines beside AC3a hook blocks): clean (only AI directories, no MC, never-edit or existing file touched since 30ba411)', { skip: spawnSync('git', ['-C', REAL_REPO, 'cat-file', '-e', '30ba411^{commit}']).status !== 0 }, () => {
  // Commits of another line (the unify session's own work, merged into the run tree) are exempt: contract 11.9 step 3.
  const excludeFile = path.join(bin, 'hook-check-exclude.txt');
  const excludes = fs.existsSync(excludeFile)
    ? fs.readFileSync(excludeFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
      .filter(sha => spawnSync('git', ['-C', REAL_REPO, 'cat-file', '-e', `${sha}^{commit}`]).status === 0)
      .flatMap(sha => ['--exclude', sha])
    : [];
  const r = spawnSync('bash', [path.join(bin, 'ai-hook-check.sh'), '--blank-ok', '-q', ...excludes], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS/);
});

test('G10 grep: no paid-API name, no public-network word and no outside URL under citizens/ (bin/ and mind/guards.mjs excepted, as the contract says)', () => {
  const root = path.resolve(bin, '..');
  const hits = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'bin') walk(p); continue; }
      if (e.name === 'guards.mjs') continue;
      const text = fs.readFileSync(p, 'utf8');
      text.split('\n').forEach((l, i) => { if (/anthropic|openai|devnet|https?:\/\/(?!127\.0\.0\.1|\[::1\]|localhost)/i.test(l)) hits.push(`${path.relative(root, p)}:${i + 1}: ${l.trim().slice(0, 100)}`); });
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
