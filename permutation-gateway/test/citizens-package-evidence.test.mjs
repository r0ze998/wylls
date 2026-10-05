// citizens/bin/package-evidence.mjs (contract 11.9 step 4): the evidence package of a finished run keeps what the contract lists, leaves
// PUB/full out, refuses key-like files (by name, by content, by a property name) before copying anything, refuses symlinks, and writes a
// manifest whose sha256 values match the copied files. Temp directories only; no stack, no network, no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageRun, keyFindings, walk, EXCLUDED_DIRS } from '../citizens/bin/package-evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'citizens', 'bin', 'package-evidence.mjs');
const write = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** A finished run's AI_DIR as the run script leaves it (the parts the packager looks at). */
function fixture(root, id = 'run-x') {
  const ai = path.join(root, id);
  write(path.join(ai, 'pub', 'commitments.json'), '{"v":1,"run_id":"run-x"}');
  write(path.join(ai, 'pub', 'roster.json'), '{"v":1,"genesis_seed":"public test seed"}');
  write(path.join(ai, 'pub', 'verify-minds.json'), '{"verdict":"PASS"}');
  write(path.join(ai, 'pub', 'minds', '5.json'), '{"bell":5,"records":[]}');
  write(path.join(ai, 'pub', 'open', '9.json'), '{"v":1,"bell":9,"records":[]}');
  write(path.join(ai, 'pub', 'anchors', '5.json'), '{"bell":5}');
  write(path.join(ai, 'pub', 'memory', 'aa11', 'episodes.json'), '{"v":1,"episodes":[]}');
  write(path.join(ai, 'pub', 'cards', 'aa11.json'), '{"v":1}');
  write(path.join(ai, 'pub', 'chronicle', 'latest.json'), '{"lines":[]}');
  write(path.join(ai, 'pub', 'full', 'req-1.json'), '{"request":"a stored prompt body that must stay offline"}');
  write(path.join(ai, 'report.json'), '{"v":1,"kind":"run-report"}');
  write(path.join(ai, 'report.md'), '# report\n');
  write(path.join(ai, 'fleet', 'ai-brain.json'), '{"counters":{}}');
  write(path.join(ai, 'keys', 'seat.txt'), 'SECRET-SEAT-KEY-MATERIAL');
  write(path.join(ai, 'state', 'mind.token'), 'token');
  write(path.join(ai, 'logs', 'stack.log'), 'log');
  return ai;
}

test('packages the contract list, leaves PUB/full, keys, state and logs out, and the manifest hashes match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  const out = path.join(root, 'out', 'run-x');
  const m = packageRun({ aiDir: ai, outDir: out });
  const paths = m.files.map(f => f.path);
  for (const p of ['commitments.json', 'roster.json', 'verify-minds.json', 'minds/5.json', 'open/9.json', 'anchors/5.json', 'memory/aa11/episodes.json', 'cards/aa11.json', 'chronicle/latest.json', 'report.json', 'report.md', 'brain/ai-brain.json']) {
    assert.ok(paths.includes(p), `${p} is packaged`);
    assert.ok(fs.existsSync(path.join(out, p)));
  }
  assert.ok(!fs.existsSync(path.join(out, 'full')), 'PUB/full stays out');
  assert.ok(!paths.some(p => p.startsWith('full/') || p.startsWith('keys/') || p.startsWith('state/') || p.startsWith('logs/')));
  assert.ok(!fs.readdirSync(out).includes('keys'));
  for (const f of m.files) assert.equal(f.sha256, sha(path.join(out, f.path)), `manifest hash of ${f.path}`);
  const onDisk = JSON.parse(fs.readFileSync(path.join(out, 'MANIFEST.json'), 'utf8'));
  assert.equal(onDisk.run_id, 'run-x');
  assert.equal(onDisk.key_check.findings, 0);
  assert.ok(onDisk.excluded.includes('pub/full/'));
  assert.deepEqual(EXCLUDED_DIRS, ['full']);
});

test('a key-like file name in PUB refuses the whole packaging and copies nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  write(path.join(ai, 'pub', 'registrar.json'), '{"x":1}');
  const out = path.join(root, 'out');
  assert.throws(() => packageRun({ aiDir: ai, outDir: out }), /key-like files in the source, nothing copied.*registrar\.json/);
  assert.ok(!fs.existsSync(out), 'nothing was created');
});

test('a Solana keypair array and a PEM block are refused by content, whatever the file is called', () => {
  for (const [name, body] of [
    ['notes.txt', JSON.stringify(Array.from({ length: 64 }, (_, i) => i))],
    ['memo.txt', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
    const ai = fixture(root);
    write(path.join(ai, 'pub', name), body);
    assert.throws(() => packageRun({ aiDir: ai, outDir: path.join(root, 'out') }), new RegExp(`${name.replace('.', '\\.')}`));
    assert.ok(!fs.existsSync(path.join(root, 'out')));
  }
});

test('a JSON property named like a keypair or a secret is refused; an ordinary seed word is not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  write(path.join(ai, 'pub', 'seat', 'live.json'), '{"session_keypair_b58":"x"}');
  assert.throws(() => packageRun({ aiDir: ai, outDir: path.join(root, 'out') }), /seat\/live\.json.*property named like a key/);
  fs.rmSync(path.join(ai, 'pub', 'seat'), { recursive: true });
  // roster.json carries "genesis_seed" (a public test seed) and must pass
  const m = packageRun({ aiDir: ai, outDir: path.join(root, 'out2') });
  assert.ok(m.files.some(f => f.path === 'roster.json'));
});

test('a key-like file inside PUB/full does not matter (it is not packaged) but a report with a key property does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  write(path.join(ai, 'pub', 'full', 'wallet-1.json'), '{"secret":"never packaged"}');
  const m = packageRun({ aiDir: ai, outDir: path.join(root, 'out') });
  assert.ok(!m.files.some(f => f.path.startsWith('full/')));
  write(path.join(ai, 'report.json'), '{"private_key":"x"}');
  assert.throws(() => packageRun({ aiDir: ai, outDir: path.join(root, 'out2') }), /report\.json/);
});

test('a symlink in PUB is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  fs.symlinkSync(path.join(ai, 'report.md'), path.join(ai, 'pub', 'link.json'));
  assert.throws(() => packageRun({ aiDir: ai, outDir: path.join(root, 'out') }), /symlink or special file in PUB/);
  assert.ok(!fs.existsSync(path.join(root, 'out')));
});

test('--report and --report-md replace the run-time report and the note lands in the manifest; --dry-run writes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  write(path.join(root, 'new-report.json'), '{"v":1,"regenerated":true}');
  write(path.join(root, 'new-report.md'), '# regenerated\n');
  const dry = packageRun({ aiDir: ai, outDir: path.join(root, 'out'), report: path.join(root, 'new-report.json'), reportMd: path.join(root, 'new-report.md'), dryRun: true });
  assert.ok(!fs.existsSync(path.join(root, 'out')));
  assert.equal(dry.files.find(f => f.path === 'report.json').sha256, sha(path.join(root, 'new-report.json')));
  const m = packageRun({ aiDir: ai, outDir: path.join(root, 'out'), report: path.join(root, 'new-report.json'), reportMd: path.join(root, 'new-report.md'), reportNote: 'regenerated with the current report.mjs' });
  assert.equal(fs.readFileSync(path.join(root, 'out', 'report.json'), 'utf8'), '{"v":1,"regenerated":true}');
  assert.equal(m.report_note, 'regenerated with the current report.mjs');
});

test('packaging twice into the same directory is stable (same manifest hashes)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  const a = packageRun({ aiDir: ai, outDir: path.join(root, 'out') });
  const b = packageRun({ aiDir: ai, outDir: path.join(root, 'out') });
  assert.deepEqual(a.files, b.files);
});

test('keyFindings and walk: names, content and the top-level skip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  write(path.join(root, 'a', 'seat.txt'), 'x');
  write(path.join(root, 'full', 'big.json'), '{}');
  write(path.join(root, 'sub', 'full', 'keep.json'), '{}');
  const w = walk(root, ['full']);
  assert.deepEqual(w.files, ['a/seat.txt', 'sub/full/keep.json']);
  const f = keyFindings([{ abs: path.join(root, 'a', 'seat.txt'), rel: 'a/seat.txt' }]);
  assert.equal(f.length, 1);
  assert.match(f[0].why, /file name/);
});

test('the command line: exit 0 and a summary line on success, exit 1 and nothing copied on a key file, exit 2 without arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-ev-'));
  const ai = fixture(root);
  const out = path.join(root, 'out');
  const ok = execFileSync(process.execPath, [script, '--ai-dir', ai, '--out', out], { encoding: 'utf8' });
  assert.match(ok, /packaged run-x: \d+ files, \d+ bytes, key check 0 findings, PUB\/full excluded/);
  write(path.join(ai, 'pub', 'id.json'), '{}');
  const bad = spawnSync(process.execPath, [script, '--ai-dir', ai, '--out', path.join(root, 'out2')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /id\.json/);
  assert.ok(!fs.existsSync(path.join(root, 'out2')));
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
