// The launcher's TEST-ONLY capture demo: `--capture-demo capture-demo-v1 --demo-scale <10-60>`, both or neither, a
// natural world with the march trial only. No key is made here and no process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../src/frontier/local-play-launcher.mjs';

const abs = ['--root', '/r', '--data', '/d', '--runner', '/x/runner', '--herald', '/x/herald', '--depart', '/x/depart', '--preview', '/x/preview', '--resident', '/x/resident', '--artifact', '/x/a.so', '--artifact-sha', 'ab'.repeat(32)];
const natural = [...abs, '--world-preset', 'local-natural-v1', '--natural-runner', '/x/natural', '--economy', 'page-signed-v1'];
const trial = [...natural, '--march-trial', L.MARCH_TRIAL_MODE];
const demo = (scale = '20', mode = L.CAPTURE_DEMO_MODE) => ['--capture-demo', mode, '--demo-scale', scale];
const fault = async (args, code) => assert.rejects(L.parseConfig(args), e => e.code === code, code);
const pathsOnly = async args => assert.rejects(L.parseConfig(args), e => !['InvalidCaptureDemo', 'CaptureDemoNeedsNaturalTrial', 'InvalidArguments', 'InvalidMarchTrial', 'MarchTrialNeedsNatural'].includes(e.code));

test('the words: exactly capture-demo-v1 and a plain whole scale 10..60', () => {
  assert.equal(L.CAPTURE_DEMO_MODE, 'capture-demo-v1');
  for (const [raw, want] of [['10', 10], ['20', 20], ['60', 60], ['9', null], ['61', null], ['020', null], ['2e1', null], ['20.0', null], ['-20', null], ['', null], [undefined, null], [20, null]]) assert.equal(L.parseDemoScale(raw), want, String(raw));
});

test('parseConfig: both words or neither, exact, and only on a natural world started with the march trial', async () => {
  await fault([...trial, '--capture-demo', L.CAPTURE_DEMO_MODE], 'InvalidCaptureDemo');
  await fault([...trial, '--demo-scale', '20'], 'InvalidCaptureDemo');
  await fault([...trial, ...demo('20', 'capture-demo-v2')], 'InvalidCaptureDemo');
  for (const bad of ['9', '61', '020', '2e1']) await fault([...trial, ...demo(bad)], 'InvalidCaptureDemo');
  await fault([...natural, ...demo()], 'CaptureDemoNeedsNaturalTrial');
  await fault([...abs, '--economy', 'page-signed-v1', ...demo()], 'CaptureDemoNeedsNaturalTrial');
  // (well-formed: these checks pass; it fails only later, at the paths, which do not exist here)
  await pathsOnly([...trial, ...demo()]);
  // (without the demo words the natural trial is as before)
  await pathsOnly(trial);
});

test('startWorld refuses a demo that is not on a natural world with the march trial and a valid scale, before anything starts', async () => {
  const base = { worldPreset: 'local-natural-v1', naturalRunner: '/x/natural', economy: 'page-signed-v1' };
  const refused = async (c, why) => assert.rejects(L.startWorld(c, 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT', 0, () => {}), e => e.code === 'InvalidWorldPreset', why);
  await refused({ ...base, captureDemo: { scale: 20 } }, 'no march trial');
  await refused({ ...base, marchTrial: true, captureDemo: { scale: 5 } }, 'scale below 10');
  await refused({ ...base, marchTrial: true, captureDemo: { scale: 61 } }, 'scale above 60');
  await refused({ ...base, marchTrial: true, captureDemo: { scale: '20' } }, 'a scale that is not a number');
  await refused({ economy: 'page-signed-v1', marchTrial: true, captureDemo: { scale: 20 } }, 'not a natural world');
});

test('the demo reaches the runner, the start answer and the page address only from the launcher\'s own options', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(demo !== null \? \['--capture-demo', CAPTURE_DEMO_MODE, '--demo-scale', String\(demo\.scale\)\] : \[\]\)/, 'the runner gets both words only for a demo world');
  assert.match(src, /\.\.\.\(demo !== null \? \{ captureDemo: \{ scale: demo\.scale \} \} : \{\}\)/, 'the start answer states it');
  assert.match(src, /demoWord = c\.captureDemo \? 'capture' : ''/, 'the address word comes from the launcher\'s config, never from a request');
  assert.match(src, /\(url\.searchParams\.get\('demo'\) \?\? ''\) !== demoWord\)\) \{/, 'a page address whose demo word disagrees is redirected');
  assert.match(src, /if \(demoWord\) query\.set\('demo', demoWord\); else query\.delete\('demo'\);/, 'and the redirect drops a demo word the launcher was not started with');
  assert.ok(!/searchParams\.get\('demo'\)[^\n]*captureDemo/.test(src), 'no request turns the demo on');
});

test('the runner\'s first line must state exactly this launcher\'s demo (mode, scale, test-only) — or nothing on a plain world', () => {
  const st = { mode: L.CAPTURE_DEMO_MODE, scale: 20, test_only: true };
  assert.equal(L.runnerDemoAgrees({ capture_demo: st }, { scale: 20 }), true);
  assert.equal(L.runnerDemoAgrees({}, null), true, 'a plain natural world: no statement');
  for (const [meta, demo, why] of [[{}, { scale: 20 }, 'the runner did not start the demo'], [{ capture_demo: st }, null, 'the runner runs a demo this launcher did not ask for'],
    [{ capture_demo: { ...st, scale: 30 } }, { scale: 20 }, 'another scale'], [{ capture_demo: { ...st, mode: 'capture-demo-v2' } }, { scale: 20 }, 'another mode'],
    [{ capture_demo: { mode: st.mode, scale: 20 } }, { scale: 20 }, 'not marked test-only'], [{ capture_demo: { ...st, extra: 1 } }, { scale: 20 }, 'anything more'], [{ capture_demo: null }, null, 'a null statement']]) {
    assert.equal(L.runnerDemoAgrees(meta, demo), false, why);
  }
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(!runnerDemoAgrees\(meta, demo\)\) throw fault\('RunnerNotReady', 503\);/, 'a disagreement fails the start like any unready runner (its processes are stopped by the same path)');
});

test('the usage text names the demo words, test-only, with the march trial', () => {
  assert.match(L.USAGE, /\[--capture-demo capture-demo-v1 --demo-scale <10-60>: TEST-ONLY, both or neither, natural preset with\n\s+--march-trial only:/);
});
