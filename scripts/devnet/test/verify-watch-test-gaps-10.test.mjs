// test-gaps-10: PR-CI tests for #313 (verify-watch refuses a judge without playable-lane; a misbuilt judge → ERROR).
// verify-pr313 checked these by hand with real release builds. Automated here:
//   - §2 "lying wrapper": a judge that answers the probe with playable-lane but judges like a default build. It reports
//     V0/UnknownProgramVersion and thousands of FAIL findings. Run through verify-watch.mjs itself, it gives ERROR
//     (exit 0, state.json and watch.log say ERROR), never FAIL, and a looping watch keeps going (O-1);
//   - §2 refusals at start (mutated build, missing binary): exit 2, no data dir, the pull never started;
//   - O-3: the guard keys on the UNVERIFIABLE severity of V0/UnknownProgramVersion, so the Rust side is pinned to that
//     severity and that code;
//   - D-verify-pr313-1: verify_core::mutated() does not list every mutate-* feature. It is pinned as a known gap
//     (`todo`), and a NEW gap fails the test.
// Fake binaries only (POSIX sh scripts in a temp dir). No RPC, no port is opened (the --rpc URL is loopback and the
// fake pull never connects), no cargo, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, summarizeReport } from '../verify-watch-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.join(HERE, '..', 'verify-watch.mjs');
const ROOT = path.join(HERE, '..', '..', '..');
const VERIFY = path.join(ROOT, 'frontier-node', 'crates', 'verify');
const rs = f => readFileSync(path.join(VERIFY, f), 'utf8');
const PROGRAM = 'GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr';
const PROBE_OK = '{"bin":"frontier-verify","version":"0.1.0","features":["playable-lane","wide-world-experimental","wide-economy-experimental"],"mutated":null}';

function fakeBin(dir, name, body) {
  const p = path.join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const finding = (check, code, severity) => ({ check, code, severity, entity: 'x', bell: 0, signature: null, detail: '' });
/** A report.json as frontier-verify writes it (report.rs: lower-case severities). */
function report({ unknownVersion, fails = 3 }) {
  const findings = [];
  for (let i = 0; i < fails; i++) findings.push(finding('CQ1', 'FinalStateMismatch', 'fail'));
  if (unknownVersion) findings.push(finding('V0', 'UnknownProgramVersion', 'unverifiable'));
  findings.push(finding('V0', 'HistoryUnproven', 'unverifiable'));
  return { verdict: fails ? 'FAIL' : 'UNVERIFIABLE', findings };
}
/**
 * A judge: answers `features` with `probe`, else (the judging call) records its arguments, writes `report` into --out
 * and exits `code` (frontier-verify: 2 = cannot verify, 1 = FAIL).
 */
function judge(dir, name, { probe = PROBE_OK, rep, code = 2 }) {
  const repFile = path.join(dir, `${name}.report.json`);
  writeFileSync(repFile, JSON.stringify(rep));
  return fakeBin(dir, name, [
    `if [ "$1" = features ]; then echo '${probe}'; exit 0; fi`,
    `echo "$@" >> "${dir}/${name}.calls"`,
    'out=""; while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done',
    `cp "${repFile}" "$out/report.json"; echo judged >&2; exit ${code}`,
  ].join('\n'));
}
/** A pull that never connects: prints the summary line `frontier-verify pull` prints and counts its runs. */
const fakePull = (dir, { throttled = 0 } = {}) => fakeBin(dir, 'fv-pull', `echo pull >> "${dir}/pulls"\necho '{"ok":true,"seq":42,"archived":0,"requests":3,"throttled":${throttled},"finals":{"consistent":true,"final_slot":9},"ruleset":"${'ab'.repeat(32)}"}'`);

function runWatch(dir, verifyBin, extra = [], { judgeOnly = true, timeout = 30000 } = {}) {
  const so = path.join(dir, 'p.so');
  writeFileSync(so, 'x');
  const data = path.join(dir, 'data');
  const args = [WATCH, '--program', PROGRAM, '--season', '3', '--data', data, '--verify-bin', verifyBin, '--program-so', so, '--ruleset', 'cd'.repeat(32), ...extra];
  if (judgeOnly) args.splice(1, 0, '--judge-only');
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout });
  return { ...r, data };
}
/** The data dir of a --judge-only run: the last pull and the fixture, as a live watch leaves them. */
function seedData(dir) {
  const data = path.join(dir, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, 'last-pull.json'), JSON.stringify({ ok: true, seq: 9615, finals: { consistent: true, final_slot: 1 }, ruleset: 'ef'.repeat(32) }));
  writeFileSync(path.join(data, 'input.json.gz'), 'fixture');
  return data;
}
const readState = data => JSON.parse(readFileSync(path.join(data, 'state.json'), 'utf8'));
const logLines = data => readFileSync(path.join(data, 'watch.log'), 'utf8').trim().split('\n');

test('#313 e2e: a misbuilt judge that passes the probe (verify-pr313 §2 "lying wrapper") → ERROR "misbuilt judge", exit 0, never FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-tg10-'));
  try {
    const data = seedData(dir);
    const liar = judge(dir, 'fv-liar', { rep: report({ unknownVersion: true, fails: 7986 }) });
    const r = runWatch(dir, liar);
    assert.equal(r.status, 0, r.stderr);
    const st = readState(data);
    assert.equal(st.level, 'ERROR');
    assert.equal(st.exit, 0);
    assert.match(st.why, /^misbuilt judge: V0\/UnknownProgramVersion .*7986 FAIL findings not counted/);
    const [line] = logLines(data);
    assert.match(line, /^\S+Z ERROR /, 'watch.log says ERROR');
    assert.match(r.stdout, / ERROR /);
    // the judge really ran, on the stored fixture, with the trust roots the watch pins
    const calls = readFileSync(path.join(dir, 'fv-liar.calls'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 1);
    assert.match(calls[0], new RegExp(`--fixture ${path.join(data, 'input.json.gz').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
    assert.match(calls[0], new RegExp(`--ruleset ${'cd'.repeat(32)}`));
    const reports = readdirSync(path.join(data, 'reports'));
    assert.equal(reports.length, 1); assert.match(reports[0], /-judge$/);
    assert.equal(readFileSync(path.join(data, 'reports', reports[0], 'judge.stderr.txt'), 'utf8'), 'judged\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#313 e2e control: the same FAIL findings from a judge that knows the version are a real FAIL (exit 1); on an inconsistent snapshot RACE', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-tg10-'));
  try {
    const data = seedData(dir);
    const honest = judge(dir, 'fv-honest', { rep: report({ unknownVersion: false, fails: 3 }), code: 1 });
    const r = runWatch(dir, honest);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(readState(data).level, 'FAIL');
    assert.equal(readState(data).why, 'CQ1/FinalStateMismatch×3');
    // the misbuilt branch wins over RACE too: an inconsistent snapshot judged by a misbuilt judge is still ERROR
    writeFileSync(path.join(data, 'last-pull.json'), JSON.stringify({ ok: true, seq: 1, finals: { consistent: false }, ruleset: 'ef'.repeat(32) }));
    assert.equal(runWatch(dir, honest).status, 0);
    assert.equal(readState(data).level, 'RACE');
    const liar = judge(dir, 'fv-liar', { rep: report({ unknownVersion: true }) });
    assert.equal(runWatch(dir, liar).status, 0);
    assert.equal(readState(data).level, 'ERROR');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#313 e2e loop (verify-pr313 O-1): with a misbuilt judge every cycle is ERROR and the watch keeps going until --until (exit 0); a real FAIL stops it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-tg10-'));
  try {
    const liar = judge(dir, 'fv-liar', { rep: report({ unknownVersion: true }) });
    const until = String(Math.floor(Date.now() / 1000) + 4);
    const loop = ['--rpc', 'http://127.0.0.1:41550', '--pull-bin', fakePull(dir), '--every', '0.005', '--until', until];
    const r = runWatch(dir, liar, loop, { judgeOnly: false });
    assert.equal(r.status, 0, r.stderr);
    const lines = logLines(r.data);
    assert.ok(lines.length >= 2, `several cycles (${lines.length})`);
    assert.ok(lines.every(l => / ERROR /.test(l)), lines.join('\n'));
    assert.equal(readFileSync(path.join(dir, 'pulls'), 'utf8').trim().split('\n').length, lines.length, 'one pull per cycle');

    rmSync(r.data, { recursive: true, force: true }); rmSync(path.join(dir, 'pulls'));
    const honest = judge(dir, 'fv-honest', { rep: report({ unknownVersion: false }), code: 1 });
    const f = runWatch(dir, honest, ['--rpc', 'http://127.0.0.1:41550', '--pull-bin', fakePull(dir), '--every', '0.005', '--until', String(Math.floor(Date.now() / 1000) + 30)], { judgeOnly: false });
    assert.equal(f.status, 1, f.stderr);
    assert.equal(logLines(f.data).length, 1, 'the first FAIL stops the watch (no --keep-on-fail)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#313 e2e refusals at start (verify-pr313 §2): a mutated build, a missing binary, a probe that is not JSON — exit 2, no data dir, nothing pulled or judged', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-tg10-'));
  try {
    const pull = fakePull(dir);
    const cases = [
      ['mutated', judge(dir, 'fv-mut', { probe: PROBE_OK.replace('"mutated":null', '"mutated":"mutate-vg"'), rep: report({}) }), /is a MUTATED build \(mutate-vg\)/],
      ['missing', path.join(dir, 'no-such-frontier-verify'), /does not report its build features \(`features` probe exit -1/],
      ['not JSON', fakeBin(dir, 'fv-noise', 'echo "frontier-verify 0.1.0"; exit 0'), /does not report its build features \(`features` probe exit 0/],
      ['features not a list', judge(dir, 'fv-str', { probe: '{"bin":"frontier-verify","features":"playable-lane","mutated":null}', rep: report({}) }), /does not report its build features/],
      ['wide only', judge(dir, 'fv-wide', { probe: '{"bin":"frontier-verify","version":"0.1.0","features":["wide-world-experimental"],"mutated":null}', rep: report({}) }), /built without playable-lane \(it reports \[wide-world-experimental\]\)/],
    ];
    for (const [what, bin, why] of cases) {
      const r = runWatch(dir, bin, ['--rpc', 'http://127.0.0.1:41550', '--pull-bin', pull, '--once'], { judgeOnly: false });
      assert.equal(r.status, 2, `${what}: ${r.stderr}`);
      assert.match(r.stderr, /^verify-watch: refusing to start: --verify-bin /, what);
      assert.match(r.stderr, why, what);
      assert.match(r.stderr, /cargo build --release --locked -p verify --features verify\/playable-lane --bin frontier-verify/, `${what}: says how to rebuild`);
      assert.equal(existsSync(r.data), false, `${what}: no data dir`);
      assert.equal(existsSync(path.join(dir, 'pulls')), false, `${what}: the pull never started`);
    }
    assert.equal(readdirSync(dir).some(f => f.endsWith('.calls')), false, 'no judge ran');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#313 ↔ Rust (verify-pr313 O-3): V0/UnknownProgramVersion is emitted once, as UNVERIFIABLE, and report.json spells it as the watch reads it', () => {
  assert.match(rs('src/codes.rs'), /pub const UNKNOWN_PROGRAM_VERSION: &str = "UnknownProgramVersion";/);
  const v0 = rs('src/checks/v0_coverage.rs');
  assert.match(v0, /^const V: &str = "V0";$/m);
  // the argument lines that pass the code (imports and doc comments aside)
  const emits = [...v0.matchAll(/^\s*UNKNOWN_PROGRAM_VERSION,$/gm)].map(m => m.index);
  assert.equal(emits.length, 1, 'one place emits it');
  assert.match(v0.slice(emits[0] - 200, emits[0]), /cx\.unverifiable\(\s*V,\s*$/, 'as cx.unverifiable(V, …): severity Unverifiable, check V0 — never cx.fail');
  // the only emitter in the crate
  const grepCrate = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? grepCrate(path.join(dir, e.name)) : e.name.endsWith('.rs') ? [path.join(dir, e.name)] : []);
  const others = grepCrate(path.join(VERIFY, 'src')).filter(f => !/codes\.rs$|v0_coverage\.rs$/.test(f) && /UNKNOWN_PROGRAM_VERSION/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(others, [], 'no other file emits the code');
  assert.match(rs('src/report.rs'), /Severity::Unverifiable => "unverifiable",/);
  assert.match(rs('src/report.rs'), /"code": f\.code, "severity": sev\(f\.severity\), "check": f\.check,/);
  // the watch's reading of that report: unvCodes['V0/UnknownProgramVersion'] → ERROR
  const s = summarizeReport(report({ unknownVersion: true, fails: 2 }));
  assert.equal(s.unvCodes['V0/UnknownProgramVersion'], 1);
  assert.equal(classify({ pull: { ok: true, finals: { consistent: true } }, verify: { code: 2, report: {}, summary: s } }).level, 'ERROR');
  // O-3 as it stands: the same code at FAIL severity would not be read as a misbuilt judge (hence the Rust pin above)
  const asFail = summarizeReport({ verdict: 'FAIL', findings: [finding('V0', 'UnknownProgramVersion', 'fail')] });
  assert.equal(classify({ pull: { ok: true, finals: { consistent: true } }, verify: { code: 1, report: {}, summary: asFail } }).level, 'FAIL');
});

// ------------------------------------------------------------------ the probe and the mutate-* features (Cargo.toml)
const cargoFeatures = () => {
  const toml = rs('Cargo.toml');
  const sec = toml.slice(toml.indexOf('\n[features]\n'));
  const body = sec.slice(0, sec.indexOf('\n[', 2) > 0 ? sec.indexOf('\n[', 2) : undefined);
  return [...body.matchAll(/^([a-z0-9-]+) = /gm)].map(m => m[1]);
};
const mutatedList = () => {
  const lib = rs('src/lib.rs');
  const fn = lib.slice(lib.indexOf('pub fn mutated() -> Option<&\'static str> {'));
  const call = fn.slice(fn.indexOf('m!('), fn.indexOf(')\n}'));
  return [...call.matchAll(/"(mutate-[a-z0-9]+)"/g)].map(m => m[1]);
};
// D-verify-pr313-1 / D-verify-bin-rebuild-2 (pre-existing): Cargo defines these, mutated() does not report them
const KNOWN_UNREPORTED = ['mutate-vr', 'mutate-vl', 'mutate-vwl'];

test('#313 probe: every feature the probe can report is a real Cargo feature of the verify crate (a typo would read as "built without")', () => {
  const feats = cargoFeatures();
  const main = readFileSync(path.join(VERIFY, 'src', 'main.rs'), 'utf8');
  const probe = main.slice(main.indexOf('fn features_json() -> String {'), main.indexOf('fn main() {'));
  const named = [...probe.slice(probe.indexOf('let features = on!(')).matchAll(/"([a-z0-9-]+)"/g)].map(m => m[1]).filter(f => f !== 'bin');
  assert.deepEqual(named.slice(0, 3), ['playable-lane', 'wide-world-experimental', 'wide-economy-experimental']);
  for (const f of named.slice(0, 3)) assert.ok(feats.includes(f), `${f} is in [features]`);
  assert.match(probe, /"mutated": verify_core::mutated\(\),/, 'the probe reports mutated() — so mutated()\'s list is the guard\'s list');
  // main() answers the probe before the mutated-build refusal (so a mutate-* build reports itself)
  const m = main.slice(main.indexOf('fn main() {'));
  assert.ok(m.indexOf('Some("features")') < m.indexOf('verify_core::mutated()'));
});

test('#313 mutated(): every name it reports is a Cargo mutate-* feature, and no mutate-* feature is unreported beyond the known three', () => {
  const feats = cargoFeatures().filter(f => f.startsWith('mutate-'));
  const listed = mutatedList();
  assert.ok(feats.length >= 18 && listed.length >= 15, `${feats.length} / ${listed.length}`);
  for (const f of listed) assert.ok(feats.includes(f), `${f} is a Cargo feature`);
  const unreported = feats.filter(f => !listed.includes(f));
  assert.deepEqual(unreported.filter(f => !KNOWN_UNREPORTED.includes(f)), [], 'a NEW mutate-* feature must be added to mutated() (else its build passes the watch\'s guard)');
});

test('#313 mutated() reports EVERY mutate-* feature (D-verify-pr313-1: mutate-vr / mutate-vl / mutate-vwl builds say "mutated": null and pass the guard)', { todo: 'D-test-gaps-10-2 / D-verify-pr313-1: not fixed here (tests only); inbox 2026-11-28-1524-test-gaps-10-questions.md Q-TG10-2' }, () => {
  const feats = cargoFeatures().filter(f => f.startsWith('mutate-'));
  assert.deepEqual(feats.filter(f => !mutatedList().includes(f)), []);
});
