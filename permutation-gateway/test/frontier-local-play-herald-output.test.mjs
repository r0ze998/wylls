// The launcher's TEST-ONLY compact herald output: `--herald-output compact-v1`, only with the capture demo. Each new world's
// herald keeps only the .gz of each output file (herald `--output compact-v1`) to reduce its output; the launcher's own
// 128 MiB output guard is unchanged, and whether a long world stays under it must be measured. Without the option nothing changes. No key is made and no process is
// started here (the stand-in world tests are in frontier-local-play-launcher.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../src/frontier/local-play-launcher.mjs';

const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
const trial = [...natural, '--march-trial', L.MARCH_TRIAL_MODE];
const demo = ['--capture-demo', L.CAPTURE_DEMO_MODE, '--demo-scale', '60'];
const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, code);
const OPTION_CODES = ['InvalidHeraldOutput', 'HeraldOutputNeedsCaptureDemo', 'InvalidArguments', 'InvalidCaptureDemo', 'CaptureDemoNeedsNaturalTrial'];
const pathsOnly = async args => assert.rejects(L.parseConfig(args), e => !OPTION_CODES.includes(e.code));

test('the word and the record: exactly compact-v1, recorded with its newline', () => {
  assert.equal(L.HERALD_OUTPUT_MODE, 'compact-v1');
  assert.equal(L.heraldOutputRecorded('compact-v1\n'), true);
  for (const bad of ['compact-v1', 'compact-v2\n', '', null, undefined, ' compact-v1\n', 'compact-v1\n\n']) assert.equal(L.heraldOutputRecorded(bad), false, String(bad));
});

test('parseConfig: exactly its word, only for capture-demo test worlds; without it nothing changes', async () => {
  await fault([...trial, ...demo, '--herald-output', 'compact-v2'], 'InvalidHeraldOutput');
  await fault([...trial, ...demo, '--herald-output', 'gzip'], 'InvalidHeraldOutput');
  await fault([...trial, '--herald-output', 'compact-v1'], 'HeraldOutputNeedsCaptureDemo');
  await fault([...natural, '--herald-output', 'compact-v1'], 'HeraldOutputNeedsCaptureDemo');
  await fault([...abs, '--herald-output', 'compact-v1'], 'HeraldOutputNeedsCaptureDemo');
  await fault([...trial, ...demo, '--herald-output', 'compact-v1', '--herald-output', 'compact-v1'], 'InvalidArguments');
  // (well-formed: these checks pass; it fails only later, at the paths, which do not exist here)
  await pathsOnly([...trial, ...demo, '--herald-output', 'compact-v1']);
  await pathsOnly([...trial, ...demo]);
});

test('the herald gets the option only from the launcher\'s own config, and the world is handed over only once the herald recorded it', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(out\['herald-output'\] !== undefined \? \{ heraldOutput: HERALD_OUTPUT_MODE \} : \{\}\)/, 'the config states it only when the option was given');
  assert.match(src, /'--relay', `127\.0\.0\.1:\$\{relay\}`, \.\.\.\(c\.heraldOutput === HERALD_OUTPUT_MODE \? \['--output', HERALD_OUTPUT_MODE\] : \[\]\)\]\);/, 'the herald gets it last, only then');
  assert.match(src, /if \(c\.heraldOutput === HERALD_OUTPUT_MODE && !heraldOutputRecorded\(await fs\.readFile\(path\.join\(dir, 'herald', 'output-mode'\), 'utf8'\)\.catch\(\(\) => null\)\)\) throw fault\('HeraldOutputNotCompact', 503\);/);
  assert.ok(src.indexOf("throw fault('HeraldOutputNotCompact', 503)") > src.indexOf("if (!ready || stopping) throw fault('HeraldNotReady', 503);"), 'checked once the herald answers');
  assert.ok(!/searchParams[^\n]*herald-?[Oo]utput|body\??\.heraldOutput/.test(src), 'no request turns it on');
  // the launcher's own output guard is unchanged
  assert.equal(L.WORLD_OUTPUT_MAX, 128 * 1024 ** 2);
  assert.equal(L.DISK_FLOOR, 5.25 * 1024 ** 3);
});

test('the usage text and the ready line name it', () => {
  assert.match(L.USAGE, /\[--herald-output compact-v1: TEST-ONLY, only with --capture-demo:/);
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /herald_output: config\.heraldOutput \?\? 'default'/);
});
