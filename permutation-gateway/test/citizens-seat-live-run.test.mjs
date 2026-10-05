// The recording run's command line (docs/frontier/ai-citizens/RECORDING-RUN.md): `ai-citizens-run.sh --seat-live [--hold SECS]`, the seat process flags,
// the operator's info block (`bin/record-info.mjs` as a process) and the hold loop. Nothing here starts a stack, a model or a service: the script runs
// with --dry-run against a throwaway git repository (as citizens-run-check.test.mjs does), the hold loop is the script's own function run in bash with
// stubs, and record-info is run as a process that only prints.
//
// Why each test fails on the code before this change: the script has no --seat-live and no --hold (unknown option, exit 2), no hold_run function, and
// bin/record-info.mjs does not exist.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from '../citizens/bin/run-guards.mjs';

const bin = new URL('../citizens/bin/', import.meta.url).pathname;
const STACKS = new URL('../citizens/stack/', import.meta.url).pathname;
const CONFIG = new URL('./fixtures/ai-run-config.json', import.meta.url).pathname;
const AB_JSON = new URL('../citizens/config/ab.json', import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-seatlive-run-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d); };
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
/** A throwaway repository with a file under each guarded tree, and an ab/seat.mjs stand-in (the script starts the seat only when the file exists). */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'));
  for (const p of ['permutation-gateway/citizens/a.txt', 'permutation-gateway/citizens/ab/seat.mjs', 'permutation-server/web/frontier/council/b.txt', 'frontier-node/crates/bots/c.txt', 'frontier-node/crates/agents/d.txt', 'frontier-node/crates/herald/e.txt', 'frontier-node/crates/stack/f.txt', 'docs/x.md']) write(path.join(root, p), 'x\n');
  const git = (...a) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...a], { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-q', '-m', 'base');
  return { root, git };
}
const FAKE_MODEL = path.join(tmp, 'fake-model.gguf');
const FAKE_LLAMA = path.join(tmp, 'fake-llama');
write(FAKE_MODEL, 'a stand-in, not a model\n');
write(path.join(FAKE_LLAMA, 'bin', 'llama-server'), 'a stand-in binary\n');
const cleanEnv = () => {
  const e = { ...process.env, AI_MODEL: FAKE_MODEL, AI_LLAMA_DIR: FAKE_LLAMA };
  for (const k of Object.keys(e)) if (G.API_KEY_ENV.includes(k) || /^(ANTHROPIC|OPENAI)_.*(KEY|TOKEN)$/.test(k)) delete e[k];
  return e;
};
function run(args) {
  const r = makeRepo();
  const out = spawnSync('bash', [path.join(bin, 'ai-citizens-run.sh'), ...args], { env: { ...cleanEnv(), AI_REPO: r.root, AI_STACK_LOCK: path.join(tmp, `lock-${Math.random().toString(16).slice(2)}`) }, encoding: 'utf8', timeout: 60_000 });
  return { code: out.status, out: out.stdout, err: out.stderr, text: out.stdout + out.stderr, repo: r };
}
const AB = path.join(STACKS, 'ai-ab.toml');
const dry = (extra = []) => run(['--stack', AB, '--citizens-config', CONFIG, '--no-busy-check', '--dry-run', '--deck', 'deck-2', '--run-id', 'ai-record-1', ...extra]);

test('--dry-run --seat-live --hold: deck-2 (12 AIs and the seat), the seat process with --live 1 and neither --arm nor --seat-script, the info block and the hold in the plan; nothing started or written', () => {
  const r = dry(['--seat-live', '--hold', '7200']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.out, /run ai-record-1: stack ai-ab base 41900 .*12 AI citizens .*\(deck-2\), bot seed 33, season 33/);
  assert.match(r.out, /--first-index 1000 --bots 13 /);
  const seat = r.out.split('\n').find((l) => /^PLAN start seat:/.test(l));
  assert.ok(seat, r.out);
  assert.match(seat, /ab\/seat\.mjs --live 1 --ai-dir \S+\/ai-record-1 --herald http:\/\/127\.0\.0\.1:41940 --social http:\/\/127\.0\.0\.1:41981 --relay http:\/\/127\.0\.0\.1:41933 --key-file \S+\/ai-record-1\/keys\/seat\.txt --config \S+ --stop-file \S+\/state\/seat\.stop/);
  assert.doesNotMatch(seat, /--arm|--rep/);
  // no seat script anywhere: the commitments carry none, so the roster says scripted: false and the page shows the presenter
  assert.doesNotMatch(r.out, /--seat-script/);
  assert.match(r.out, /PLAN print: \S+ \S*record-info\.mjs --config \S+ --run-id ai-record-1 --serve http:\/\/127\.0\.0\.1:41902 --keys \S+\/keys --stop-file \S+\/state\/hold\.stop --hold 7200 --scale 10/);
  assert.match(r.out, /PLAN hold: after the run is complete keep the stack and the citizens service up for at most 7200 s \(stop file \S+\/state\/hold\.stop, or Ctrl-C\)/);
  // the order: the fleet (which exports the seat key), then the seat, then the census, then the info block
  const lines = r.out.split('\n').filter((l) => l.startsWith('PLAN'));
  const at = (re) => { const i = lines.findIndex((l) => re.test(l)); assert.ok(i >= 0, `missing ${re}`); return i; };
  assert.ok(at(/PLAN start fleet:/) < at(/PLAN start seat:/) && at(/PLAN start seat:/) < at(/PLAN start census:/) && at(/PLAN start census:/) < at(/PLAN print:/));
  assert.match(r.out, /dry run: nothing was started or written/);
  assert.ok(!fs.existsSync(path.join(r.repo.root, '.local')), 'no AI_DIR');
});

test('--dry-run without --seat-live is unchanged: no seat process, no info block, no hold; with --seat-script the scripted seat is started without --live; --hold alone only adds the hold line', () => {
  const plain = dry();
  assert.equal(plain.code, 0, plain.text);
  assert.doesNotMatch(plain.out, /PLAN start seat:|PLAN print:|PLAN hold:|--live/);
  const scripted = dry(['--seat-script', path.join(bin, '../ab/seat.mjs')]);
  assert.equal(scripted.code, 0, scripted.text);
  assert.match(scripted.out.split('\n').find((l) => /^PLAN start seat:/.test(l)), /ab\/seat\.mjs --ai-dir /);
  assert.doesNotMatch(scripted.out, /--live|PLAN print:/);
  assert.match(scripted.out, /registrar\.mjs commit .*--seat-script /, 'the scripted seat is named in the commitments, which marks it scripted in the roster');
  const holdOnly = dry(['--hold', '60']);
  assert.match(holdOnly.out, /PLAN hold: .* at most 60 s/);
  assert.doesNotMatch(holdOnly.out, /PLAN start seat:/);
});

test('a live seat is refused together with the scripted seat or the A/B; --hold must be a whole number of seconds', () => {
  const withScript = dry(['--seat-live', '--seat-script', path.join(bin, '../ab/seat.mjs')]);
  assert.equal(withScript.code, 2);
  assert.match(withScript.err, /--seat-live cannot be combined with --seat-script/);
  const withAb = dry(['--seat-live', '--ab', 'A', '--rep', '1']);
  assert.equal(withAb.code, 2);
  assert.match(withAb.err, /--seat-live \(the presenter votes on the page\) cannot be combined with --ab/);
  for (const bad of ['x', '-5', '1.5', '10s']) {
    const r = dry(['--hold', bad]);
    assert.equal(r.code, 2, `--hold '${bad}': ${r.text}`);
  }
});

// ---------------------------------------------------------------- the hold loop, the script's own function with stubs
const holdFn = fs.readFileSync(path.join(bin, 'ai-citizens-run.sh'), 'utf8').match(/^hold_run\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
function holdRun({ hold, alive = true, stopAfter = null, poll = 1, leftover = false }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'hold-'));
  if (leftover) fs.writeFileSync(path.join(dir, 'hold.stop'), 'left from an earlier run');
  const script = [
    'set -u',
    `HOLD=${hold}; STATE='${dir}'; NODE=true; HERE='${bin}'; RUN_ID=r; SERVE=http://127.0.0.1:41902; KEYS='${dir}/keys'; DETAIL='stack complete'`,
    `AI_HOLD_POLL_SECS=${poll}`,
    `child_alive() { ${alive ? 'return 0' : 'return 1'}; }`,
    'show_seat_lines() { :; }',
    holdFn,
    stopAfter !== null ? `( sleep ${stopAfter}; touch '${dir}/hold.stop' ) &` : '',
    'hold_run',
    'echo "DETAIL=$DETAIL"',
  ].join('\n');
  const t0 = Date.now();
  const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
  return { out: out.stdout + out.stderr, secs: (Date.now() - t0) / 1000, dir };
}

test('hold_run: the function exists; it holds until SECS pass', () => {
  assert.ok(holdFn, 'hold_run is defined in the run script');
  const r = holdRun({ hold: 2 });
  assert.match(r.out, /HOLD: the run is complete\. The stack and the citizens service stay up for at most 2 s/);
  assert.match(r.out, /HOLD: ended after 2 s/);
  assert.match(r.out, /DETAIL=stack complete; held up for 2 s after the end \(--hold 2\)/);
  assert.ok(r.secs >= 2 && r.secs < 8, `${r.secs}`);
});

test('hold_run: the stop file ends the hold early (and a stop file left from before is not honoured); a dead stack or citizens service ends it too', () => {
  const r = holdRun({ hold: 25, stopAfter: 2 });
  assert.match(r.out, /HOLD: ended by the stop file after [2-4] s/);
  assert.ok(r.secs < 10, `ended early: ${r.secs}`);
  const dead = holdRun({ hold: 25, alive: false });
  assert.match(dead.out, /HOLD: the stack or the citizens service stopped; ending the hold/);
  assert.match(dead.out, /HOLD: ended after 0 s/);
  // a stop file left in a reused AI_DIR does not end the next hold at once
  const left = holdRun({ hold: 2, leftover: true });
  assert.match(left.out, /HOLD: ended after 2 s/);
  assert.doesNotMatch(left.out, /ended by the stop file/);
});

// ---------------------------------------------------------------- record-info as a process
test('record-info (process): prints the info block from the real ab.json (period 24, offset 0, lead 6) and the shorter block with --urls-only; it starts nothing', () => {
  const full = spawnSync(process.execPath, [path.join(bin, 'record-info.mjs'), '--config', AB_JSON, '--run-id', 'ai-record-1', '--serve', 'http://127.0.0.1:41902', '--keys', '/k/keys', '--stop-file', '/k/state/hold.stop', '--hold', '7200', '--scale', '10', '--date', '2026-10-11'], { encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /=== RECORDING RUN \(live seat\), run ai-record-1 ===/);
  assert.match(full.stdout, /council page {3}http:\/\/127\.0\.0\.1:41902\/council\.html\?recorded=2026-10-11/);
  assert.match(full.stdout, /pbcopy < \/k\/keys\/presenter-key\.json/);
  assert.match(full.stdout, /period 1: C0 bell 24 \(\+24 min\)/);
  assert.match(full.stdout, /period 2: C0 bell 48 \(\+48 min\); motions bells 48-50; BALLOT WINDOW bells 51-53 .*strike bell 60 \(\+60 min\); the order opens bell 62 \(\+62 min\)/);
  assert.match(full.stdout, /do not start the scripted seat/);
  assert.match(full.stdout, /touch \/k\/state\/hold\.stop/);
  assert.doesNotMatch(full.stdout, /session_keypair|wallet_keypair/);
  const urls = spawnSync(process.execPath, [path.join(bin, 'record-info.mjs'), '--urls-only', '--run-id', 'r', '--serve', 'http://127.0.0.1:41902', '--keys', '/k/keys', '--stop-file', '/k/state/hold.stop', '--hold', '60'], { encoding: 'utf8' });
  assert.equal(urls.status, 0, urls.stderr);
  assert.doesNotMatch(urls.stdout, /council timeline/);
  assert.match(urls.stdout, /council page/);
  const missing = spawnSync(process.execPath, [path.join(bin, 'record-info.mjs'), '--run-id', 'r'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});
