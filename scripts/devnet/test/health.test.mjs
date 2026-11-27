// Tests of the read-only devnet health check (scripts/devnet/health.mjs): pure
// helpers, the RPC wrapper with a fake fetch, and runChecks end to end against
// stand-in servers on 127.0.0.1 and temp dirs. Nothing here contacts a
// network beyond 127.0.0.1, reads a key or touches a process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_WINDOW_SECS, DEVNET_RPC, SLOT_S_DEFAULT, alertedReport, bondRefundDeadline, decodeSeason, etimeSeconds, expectedProcs, heraldLag, jst, lagLevel, logLevel, lowerBound, makeRpc, mergeState,
  milestonesFrom, overallOf, parsePs, phaseCheck, postponedFrom, postponedStale, procCheck, procOverrides, scanLog, timelineText, tunnelHost,
} from '../health.mjs';

const T = 1795516707; // CreateSeason opens, 2026-11-24 19:38:27 JST

function seasonBytes({ stored = 0, genesisTs = 0, tCreate = T } = {}) {
  const b = Buffer.alloc(384);
  b.write('PSF1SEAS', 0, 'latin1');
  b[64] = stored;
  b.writeUInt32LE(600, 140);
  b.writeBigInt64LE(BigInt(genesisTs), 144);
  b.writeUInt32LE(1008, 164);
  b.writeBigInt64LE(BigInt(tCreate), 368);
  return b;
}

test('jst formats the scheduled CreateSeason time', () => {
  assert.equal(jst(T), '2026-11-24 19:38:27 JST');
});

test('decodeSeason reads status, genesis and t_create_min; Seeded past genesis is Running', () => {
  const a = decodeSeason(seasonBytes({ stored: 0 }), T - 10);
  assert.equal(a.statusName, 'Announced');
  assert.equal(a.tCreateMin, T);
  assert.equal(a.bellSecs, 600);
  assert.equal(a.endBell, 1008);
  assert.equal(decodeSeason(seasonBytes({ stored: 2, genesisTs: T + 1300 }), T + 1299).statusName, 'Seeded');
  assert.equal(decodeSeason(seasonBytes({ stored: 2, genesisTs: T + 1300 }), T + 1300).statusName, 'Running');
  assert.equal(decodeSeason(Buffer.alloc(10)), null);
});

test('phaseCheck: late CreateSeason and late genesis are flagged', () => {
  const s = (stored, g = 0) => decodeSeason(seasonBytes({ stored, genesisTs: g }), T + 99999);
  assert.equal(phaseCheck(s(0), T - 3600, {}).level, 'OK');
  assert.equal(phaseCheck(s(0), T + 16 * 60, {}).level, 'FAIL');
  assert.equal(phaseCheck(s(1), T + 10 * 60, {}).level, 'OK');
  assert.equal(phaseCheck(s(1), T + 35 * 60, {}).level, 'WARN');
  assert.equal(phaseCheck(s(1), T + 50 * 60, {}).level, 'FAIL');
  assert.equal(phaseCheck(s(2, T + 1300), T + 30 * 60, {}).level, 'OK');
  assert.equal(phaseCheck(s(2, T + 1300), T + 70 * 60, {}).level, 'WARN');
  assert.match(phaseCheck(s(2, T + 1300), T + 70 * 60, { setupComplete: { at: 'x' } }).detail, /joinable/);
  assert.equal(phaseCheck(null, T, {}).level, 'FAIL');
});

test('thresholds', () => {
  assert.equal(lowerBound(3, { warn: 1, fail: 0.2 }), 'OK');
  assert.equal(lowerBound(0.5, { warn: 1, fail: 0.2 }), 'WARN');
  assert.equal(lowerBound(0.1, { warn: 1, fail: 0.2 }), 'FAIL');
  assert.equal(lagLevel(-20), 'OK');
  assert.equal(lagLevel(151), 'WARN');
  assert.equal(lagLevel(1501), 'FAIL');
  assert.equal(lagLevel(NaN), 'FAIL');
});

test('scanLog / logLevel count errors, restarts and STOP lines', () => {
  const ok = scanLog('a\nb\nc\n');
  assert.deepEqual([ok.lines, ok.error, logLevel(ok)], [3, 0, 'OK']);
  const r = scanLog('x\n2026-11-24 20:00:00 JST keeper exited rc=1 after 3s\ny\n');
  assert.equal(r.restart, 1);
  assert.equal(logLevel(r), 'WARN');
  const f = scanLog('2026-11-24 20:00:00 JST STOP: keeper died within 60 s five times in a row\n');
  assert.equal(logLevel(f), 'FAIL');
  const e = scanLog(Array.from({ length: 10 }, (_, i) => (i < 2 ? 'rpc error 429' : 'fine')).join('\n'));
  assert.equal(e.error, 2);
  assert.equal(logLevel(e), 'WARN');
  assert.equal(scanLog('1\n2\n3\n4\n', 2).lines, 2);
});

test('milestonesFrom takes the first matching line and its timestamp', () => {
  const driver = [
    '2026-11-23 19:34:37 JST driver start pid 92587; CreateSeason opens at 1795516707 (2026-11-24 19:38:27 JST)',
    '2026-11-24 19:40:00 JST operator run (create)',
    'operator: sent CreateSeason',
    '2026-11-24 19:41:10 JST operator exit 3',
    '2026-11-24 19:41:10 JST keeper supervisor started pid 1234',
    '2026-11-24 19:42:00 JST rulesetHash ' + 'ab'.repeat(32) + '; starting gateway',
    '2026-11-24 20:03:00 JST operator exit 3',
    '2026-11-24 20:05:00 JST operator exit 0',
    '2026-11-24 20:05:00 JST setup complete (WideSetRules landed or nothing to send)',
  ].join('\n');
  const ms = milestonesFrom({ 'devnet-season-driver.log': driver, 'devnet-join-check.log': '2026-11-24 20:05:30 JST setup complete seen; waiting 3 min for the herald' });
  assert.equal(ms.createLanded.at, '2026-11-24 19:41:10 JST');
  assert.equal(ms.keeperStarted.at, '2026-11-24 19:41:10 JST');
  assert.equal(ms.gatewayStarted.at, '2026-11-24 19:42:00 JST');
  assert.equal(ms.setupComplete.at, '2026-11-24 20:05:00 JST');
  assert.equal(ms.joinCheckStart.at, '2026-11-24 20:05:30 JST');
  assert.equal(ms.driverStop, undefined);
});

test('process expectations follow the milestones', () => {
  const ps = parsePs(' 92587 22:45:00 /bin/zsh ./season-driver.sh 1795516707\n 94463 22:20:00 /x/frontier-herald --data d --listen 127.0.0.1:41140 --web w\n 1 1-00:00:00 /sbin/launchd\n');
  const before = Object.fromEntries(expectedProcs({}, false).map((s) => [s.key, procCheck(s, ps)]));
  assert.equal(before['proc.season-driver'].level, 'OK');
  assert.equal(before['proc.herald'].level, 'OK');
  assert.equal(before['proc.keeper'].level, 'OK'); // not expected yet
  assert.equal(before['proc.tunnel'].level, 'FAIL'); // always expected
  const after = Object.fromEntries(expectedProcs({ keeperStarted: {}, setupComplete: {}, gatewayStarted: {} }, true).map((s) => [s.key, procCheck(s, ps)]));
  assert.equal(after['proc.keeper'].level, 'FAIL');
  assert.equal(after['proc.gateway'].level, 'FAIL');
  // no PID is written in the expectations: a process is found by its command only
  for (const s of expectedProcs({ keeperStarted: {}, gatewayStarted: {} }, false)) assert.equal(s.pid, undefined, s.key);
});

test('etimeSeconds reads every ps etime form', () => {
  assert.equal(etimeSeconds('00:07'), 7);
  assert.equal(etimeSeconds('22:45'), 22 * 60 + 45);
  assert.equal(etimeSeconds('01:02:03'), 3723);
  assert.equal(etimeSeconds('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(etimeSeconds('ELAPSED'), null);
  assert.equal(etimeSeconds(undefined), null);
});

test('process patterns match the program being run, not a line that only mentions it', () => {
  const ms = { keeperStarted: {}, gatewayStarted: {} };
  const spec = Object.fromEntries(expectedProcs(ms, false).map((s) => [s.key, s]));
  // the real stack's command lines (ps on the devnet machine, 11-24) and the forms the scripts launch with
  const real = {
    'proc.season-driver': ['/bin/zsh ./season-driver.sh 1795516707', 'bash /Users/u/wylls-devnet-run/season-driver.sh 1'],
    'proc.gateway-starter': ['/bin/zsh ./gateway-starter.sh'],
    'proc.gateway-supervisor': ['/bin/zsh /Users/u/wylls-devnet-run/run-gateway.sh'],
    'proc.gateway': ['/opt/homebrew/opt/node@20/bin/node permutation-gateway/src/frontier/server.mjs --cluster devnet --port 41130 --public-port 41133'],
    'proc.herald-supervisor': ['/bin/zsh ./run-herald.sh', '/bin/zsh -x /r/run-herald.sh'],
    'proc.herald': ['/Users/u/wylls-devnet-run/bin/frontier-herald --data /r/herald --program G --season 1 --rpc https://api.devnet.solana.com --listen 127.0.0.1:41140 --web w'],
    'proc.keeper-supervisor': ['/bin/zsh /Users/u/wylls-devnet-run/run-keeper.sh'],
    'proc.keeper': ['/Users/u/wylls-devnet-run/bin/frontier-keeper --config keeper-a/keeper.toml'],
    'proc.join-check': ['/bin/zsh ./join-check.sh'],
    'proc.tunnel': ['/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:41140'],
    'proc.caffeinate': ['caffeinate -is', '/usr/bin/caffeinate -is -w 1'],
  };
  for (const [k, cmds] of Object.entries(real)) for (const c of cmds) assert.ok(spec[k].re.test(c), `${k} ${c}`);
  // lookalikes: with the real process gone, each must still be a FAIL (not a "restarted" WARN)
  const fake = {
    'proc.season-driver': ['tail -f season-driver.sh', 'vim ./season-driver.sh', '/bin/zsh ./season-driver-2.sh 1'],
    'proc.herald-supervisor': ['pgrep -f run-herald.sh', 'ugrep -E run-herald.sh /tmp', 'less /r/run-herald.sh', '/bin/zsh ./run-herald-old.sh'],
    'proc.keeper': ['pgrep -f frontier-keeper --config keeper-a/keeper.toml', 'pkill -f frontier-keeper --config keeper-a/keeper.toml'],
    'proc.herald': [
      '/w/target/debug/frontier-herald --data d --listen 127.0.0.1:41520 --web w', // a local test herald on another port
      '/w/target/debug/frontier-herald --data d --listen 127.0.0.1:411400',
      'grep frontier-herald --listen 127.0.0.1:41140',
    ],
    'proc.tunnel': ['/opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:41141', 'cat /r/logs/cloudflared tunnel 127.0.0.1:41140'],
    'proc.gateway': ['node permutation-gateway/src/frontier/server.mjs --port 411300', 'grep permutation-gateway/src/frontier/server.mjs --port 41130'],
    'proc.caffeinate': ['caffeinate -i -t 300', 'pgrep caffeinate -is'],
  };
  for (const [k, cmds] of Object.entries(fake)) for (const c of cmds) {
    const r = procCheck(spec[k], [{ pid: 501, etime: '00:10', cmd: c }], { tracked: true, prev: { pid: 9 } });
    assert.equal(r.level, 'FAIL', `${k} ${c}: ${r.detail}`);
  }
});

test('procCheck without --state: a restart is a WARN only while the process is young', () => {
  const spec = { re: /frontier-herald/, want: true };
  const young = procCheck(spec, parsePs(' 500 12:00 /x/frontier-herald --listen a\n'));
  assert.equal(young.level, 'WARN');
  assert.match(young.detail, /^pid 500 up 12:00 — started 12 min ago \(restarted or first start; WARN until 30 min old\)$/);
  const old = procCheck(spec, parsePs(' 500 30:00 /x/frontier-herald --listen a\n'));
  assert.deepEqual([old.level, old.detail], ['OK', 'pid 500 up 30:00']);
  // the window is a setting; 0 turns the age rule off
  assert.equal(procCheck(spec, parsePs(' 500 12:00 /x/frontier-herald\n'), { warnMin: 10 }).level, 'OK');
  assert.equal(procCheck(spec, parsePs(' 500 00:01 /x/frontier-herald\n'), { warnMin: 0 }).level, 'OK');
  assert.equal(procCheck(spec, parsePs(' 500 01:00:00 /x/frontier-herald\n'), { warnMin: 90 }).level, 'WARN');
  // an unreadable etime is not guessed to be young
  assert.equal(procCheck(spec, [{ pid: 5, etime: '?', cmd: 'frontier-herald' }]).level, 'OK');
  // a process that is no longer wanted is never "restarted"
  assert.equal(procCheck({ re: /join-check/, want: false, gone: 'finished' }, parsePs(' 9 00:05 ./join-check.sh\n')).level, 'OK');
  // this monitor and grep are not the process
  assert.equal(procCheck(spec, parsePs(' 7 00:05 grep frontier-herald\n 8 00:05 node health.mjs frontier-herald\n')).level, 'FAIL');
});

test('procCheck with --state: WARN on the run that finds a new PID, then until N minutes old, then OK', () => {
  const spec = { re: /frontier-herald/, want: true };
  const run = (line, prev, extra = {}) => procCheck(spec, parsePs(line), { tracked: true, prev, ...extra });
  // first sighting by this state file: OK even when young (a first start is not a restart)
  const first = run(' 94463 00:30 /x/frontier-herald\n', undefined);
  assert.deepEqual([first.level, first.detail], ['OK', 'pid 94463 up 00:30']);
  assert.deepEqual(first.rec, { pid: 94463, restarted: false });
  // same PID, any age: OK
  const same = run(' 94463 1-02:00:00 /x/frontier-herald\n', first.rec);
  assert.equal(same.level, 'OK');
  assert.deepEqual(same.rec, first.rec);
  // planned restart: the PID of the previous run is gone
  const moved = run(' 7001 02:10 /x/frontier-herald\n', same.rec);
  assert.equal(moved.level, 'WARN');
  assert.equal(moved.detail, 'pid 7001 up 02:10 — was 94463 at the previous run (restarted)');
  assert.deepEqual(moved.rec, { pid: 7001, restarted: true, was: 94463 });
  // next run, still inside the window: WARN
  const soon = run(' 7001 12:10 /x/frontier-herald\n', moved.rec);
  assert.equal(soon.level, 'WARN');
  assert.equal(soon.detail, 'pid 7001 up 12:10 — restarted 12 min ago, was 94463 (WARN until 30 min old)');
  // past the window: OK with the current PID and uptime — the WARN is not sticky
  const later = run(' 7001 32:10 /x/frontier-herald\n', soon.rec);
  assert.deepEqual([later.level, later.detail], ['OK', 'pid 7001 up 32:10']);
  const days = run(' 7001 3-00:00:00 /x/frontier-herald\n', later.rec);
  assert.deepEqual([days.level, days.detail], ['OK', 'pid 7001 up 3-00:00:00']);
  // a restart found after a long gap between runs is still reported once, whatever its age
  const gap = run(' 7002 05:00:00 /x/frontier-herald\n', days.rec);
  assert.equal(gap.level, 'WARN');
  assert.match(gap.detail, /was 7001 at the previous run/);
  assert.equal(run(' 7002 05:10:00 /x/frontier-herald\n', gap.rec).level, 'OK');
  // gone: FAIL, and the record is kept so the comeback is seen as a restart
  const gone = run(' 1 10:00 /sbin/launchd\n', days.rec);
  assert.equal(gone.level, 'FAIL');
  assert.deepEqual(gone.rec, days.rec);
  assert.equal(run(' 7100 00:20 /x/frontier-herald\n', gone.rec).level, 'WARN');
  // several matches (a supervisor's subshell): the remembered PID is the one reported
  const two = run(' 8000 00:05 /x/frontier-herald\n 7001 3-00:00:00 /x/frontier-herald\n', days.rec);
  assert.deepEqual([two.level, two.detail], ['OK', 'pid 7001 up 3-00:00:00 (+1 more: 8000)']);
});

test('procOverrides + procCheck: an expected PID from health-procs.json or a pidfile', () => {
  const files = {
    '/run/health-procs.json': JSON.stringify({ restartWarnMin: 5, procs: { 'proc.herald': { pid: 7001 }, 'proc.keeper': { pidfile: 'keeper-a/keeper.pid' }, 'proc.tunnel': { pidfile: 'absent.pid' }, 'proc.gateway': { pidfile: 'junk.pid' }, 'proc.caffeinate': {} } }),
    '/run/keeper-a/keeper.pid': '8123\n',
    '/run/junk.pid': 'not a pid',
  };
  const read = (p) => files[p] ?? null;
  const ov = procOverrides('/run', read);
  assert.equal(ov.restartWarnMin, 5);
  assert.deepEqual(ov.expect, { 'proc.herald': { pid: 7001, src: 'health-procs.json' }, 'proc.keeper': { pid: 8123, src: 'pidfile keeper-a/keeper.pid' } });
  assert.deepEqual(ov.problems, [
    'proc.tunnel: pidfile absent.pid not readable; ignored',
    'proc.gateway: pidfile junk.pid holds no PID; ignored',
    'proc.caffeinate: needs "pid" (a number) or "pidfile" (a path); ignored',
  ]);
  // no file: nothing expected, nothing wrong
  assert.deepEqual(procOverrides('/elsewhere', read), { expect: {}, problems: [] });
  // broken files are reported, never thrown
  assert.match(procOverrides('/r', () => '{').problems[0], /^health-procs\.json is not JSON/);
  assert.match(procOverrides('/r', () => '[1]').problems[0], /not an object/);
  assert.match(procOverrides('/r', () => '{"restartWarnMin":"x"}').problems[0], /restartWarnMin "x"/);
  assert.match(procOverrides('/r', () => '{"procs":{"proc.herald":{"pid":-4}}}').problems[0], /proc\.herald: needs/);

  const spec = { re: /frontier-herald/, want: true };
  const expect = ov.expect['proc.herald'];
  // the expected PID is OK at any age (the operator wrote it down after a planned restart) …
  const ok = procCheck(spec, parsePs(' 7001 00:10 /x/frontier-herald\n'), { expect });
  assert.deepEqual([ok.level, ok.detail], ['OK', 'pid 7001 up 00:10 (expected pid, health-procs.json)']);
  // … and any other PID is a WARN at any age, with or without --state
  const other = procCheck(spec, parsePs(' 7002 9-00:00:00 /x/frontier-herald\n'), { expect, tracked: true, prev: { pid: 7002, restarted: false } });
  assert.deepEqual([other.level, other.detail], ['WARN', 'pid 7002 up 9-00:00:00 — expected pid 7001 (health-procs.json) (restarted)']);
  // of several matches the expected one is reported
  assert.equal(procCheck(spec, parsePs(' 7002 00:10 /x/frontier-herald\n 7001 00:10 /x/frontier-herald\n'), { expect }).detail, 'pid 7001 up 00:10 (expected pid, health-procs.json) (+1 more: 7002)');
  // not running stays a FAIL
  assert.equal(procCheck(spec, [], { expect }).level, 'FAIL');
});

test('tunnelHost takes the last trycloudflare name', () => {
  assert.equal(tunnelHost('| https://a-b.trycloudflare.com |\n... https://c-d.trycloudflare.com'), 'c-d.trycloudflare.com');
  assert.equal(tunnelHost('nothing'), null);
});

test('alertedReport adds, keeps and updates one ALERT line', () => {
  const base = '# report\nbody';
  assert.equal(alertedReport(base, { failing: [], runAt: 't0', overall: 'OK' }), base);
  const a = alertedReport(base, { failing: ['herald.lag'], runAt: 't1', overall: 'FAIL' });
  assert.match(a.split('\n')[0], /^ALERT .*t1: herald\.lag — latest run t1 FAIL/);
  const b = alertedReport(a, { failing: [], runAt: 't2', overall: 'OK' });
  assert.match(b.split('\n')[0], /last failing run t1: herald\.lag — latest run t2 OK/);
  assert.equal(b.split('\n').length, 3);
});

test('overallOf and exit levels', () => {
  assert.equal(overallOf([{ level: 'OK' }]).level, 'OK');
  assert.equal(overallOf([{ level: 'OK' }, { level: 'WARN' }]).level, 'WARN');
  assert.equal(overallOf([{ level: 'WARN' }, { level: 'FAIL' }]).level, 'FAIL');
});

test('mergeState keeps first-seen times and timelineText prints them', () => {
  const s1 = mergeState({}, { at: T + 100, ms: { createLanded: { at: 'A' } }, season: { status: 1, statusName: 'Created', genesisTs: 0 } });
  const s2 = mergeState(s1, { at: T + 2000, ms: { createLanded: { at: 'B' } }, season: { status: 2, statusName: 'Seeded', genesisTs: T + 1300 } });
  assert.equal(s2.fromLogs.createLanded, 'A');
  assert.equal(s2.firstSeen['status:Created'], jst(T + 100));
  assert.equal(s2.firstSeen['status:Seeded'], jst(T + 2000));
  assert.match(timelineText(s2), /status:Seeded/);
});

test('makeRpc: devnet only, read-only methods only, spaced calls', async () => {
  assert.throws(() => makeRpc({ url: 'https://api.mainnet-beta.solana.com' }), /only/);
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, t: Date.now(), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ result: 7 }) };
  };
  const rpc = makeRpc({ gapMs: 1000, fetchFn });
  await assert.rejects(rpc.call('sendTransaction', ['x']), /read-only/);
  await assert.rejects(rpc.call('requestAirdrop', ['x', 1]), /read-only/);
  assert.equal(await rpc.call('getSlot'), 7);
  assert.equal(await rpc.call('getGenesisHash'), 7);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.url === DEVNET_RPC));
  assert.ok(seen[1].t - seen[0].t >= 990, 'calls spaced by the gap');
});

// ---------- runChecks end to end, each check passing and failing ----------
// Stand-in herald / gateway / keeper / tunnel on ephemeral 127.0.0.1 ports, a fake RPC fetch, ps/df text and log
// files in a temp dir. No real process, port of the stack, network or key is touched.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEPLOY, DEVNET_GENESIS, runChecks } from '../health.mjs';

function stub(routes) {
  const srv = http.createServer((req, res) => {
    const r = routes[req.url] ?? { status: 404, body: 'nope' };
    res.writeHead(r.status, { 'content-type': typeof r.body === 'string' ? 'text/html' : 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}

// every process five hours old: outside the restart window
const PS_ALL = [
  ' 92587 05:00:00 /bin/zsh ./season-driver.sh 1795516707',
  ' 95878 05:00:00 /bin/zsh ./gateway-starter.sh',
  ' 500 05:00:00 /bin/zsh /r/run-gateway.sh',
  ' 501 05:00:00 node permutation-gateway/src/frontier/server.mjs --cluster devnet --port 41130 --public-port 41133',
  ' 94338 05:00:00 /bin/zsh ./run-herald.sh',
  ' 94463 05:00:00 /r/bin/frontier-herald --data d --listen 127.0.0.1:41140 --web w',
  ' 502 05:00:00 /bin/zsh /r/run-keeper.sh',
  ' 503 05:00:00 /r/bin/frontier-keeper --config keeper-a/keeper.toml',
  ' 14077 05:00:00 /bin/zsh ./join-check.sh',
  ' 93889 05:00:00 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:41140',
  ' 92887 05:00:00 caffeinate -is',
].join('\n');
const DF = (gib) => `Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 999 1 ${Math.round(gib * 1024 * 1024)} 1% /System/Volumes/Data\n`;
const DRIVER_DONE = [
  '2026-11-24 19:40:00 JST operator run (create)',
  '2026-11-24 19:41:10 JST operator exit 3',
  '2026-11-24 19:41:10 JST keeper supervisor started pid 502',
  '2026-11-24 19:42:00 JST rulesetHash ' + 'ab'.repeat(32) + '; starting gateway',
  '2026-11-24 20:05:00 JST setup complete (WideSetRules landed or nothing to send)',
].join('\n');

function fakeRpc({ genesis = DEVNET_GENESIS, slot = 1000, stored = 2, owner = DEPLOY.program, sol = 100, status = 200, seasonData } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    const result = {
      getGenesisHash: genesis,
      getSlot: slot,
      getAccountInfo: { value: { owner, data: [(seasonData ?? seasonBytes({ stored, genesisTs: T + 1300 })).toString('base64'), 'base64'] } },
      getBalance: { value: Math.round((typeof sol === 'function' ? sol(params[0]) : sol) * 1e9) },
    }[method];
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { fn, calls };
}

async function world({ herald, gateway, keeper, pub, driver = DRIVER_DONE, keeperLog = '', tunnelLog, join = '{"ok":true}', ps = PS_ALL, df = 100, rpc = fakeRpc(), now = T + 3600, publicHost, publicOn = true, overrides, marker, keeperJournal = { maxLanded: 990, maxSent: 994, sent: 3 }, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
  const logs = path.join(dir, 'logs');
  const run = path.join(dir, 'run');
  fs.mkdirSync(logs); fs.mkdirSync(run);
  const servers = [];
  // routes === false: nothing listens (port 1)
  const up = async (routes) => { if (routes === false) return 1; const s = await stub(routes); servers.push(s.srv); return s.port; };
  const ph = await up(herald ?? {
    '/h/season': { status: 200, body: { statusName: 'Running', rings: [1, 2], ringsOpened: 2, rMax: 16, rulesetHash: 'ab'.repeat(32) } },
    '/h/status': { status: 200, body: { ingest: { state: 'ok', failures: 0, error: null }, alarms: { badRecords: 0 }, events: '9', provinces: 2, ws: { open: 1 }, live: [995, 0] } },
  });
  const pg = await up(gateway ?? { '/f/season': { status: 200, body: { ok: true } } });
  const pk = await up(keeper ?? { '/v1/status': { status: 401, body: { code: 'Unauthorized' } } });
  const pp = await up(pub ?? { '/frontier/frontier/': { status: 200, body: '<!doctype html><html></html>' }, '/h/season': { status: 200, body: { statusName: 'Running' } } });
  const host = publicHost ?? `127.0.0.1:${pp}`;
  fs.writeFileSync(path.join(run, 'public-host'), host + '\n');
  if (overrides != null) fs.writeFileSync(path.join(run, 'health-procs.json'), typeof overrides === 'string' ? overrides : JSON.stringify(overrides));
  // marker: {run: text} → <run-dir>/world-postponed, {logs: text} → <logs>/devnet-create-postponed
  if (marker?.run != null) fs.writeFileSync(path.join(run, 'world-postponed'), marker.run);
  if (marker?.logs != null) fs.writeFileSync(path.join(logs, 'devnet-create-postponed'), marker.logs);
  fs.writeFileSync(path.join(logs, 'devnet-season-driver.log'), driver + '\n');
  fs.writeFileSync(path.join(logs, 'devnet-keeper-a.log'), keeperLog || '2026-11-24 19:41:10 JST supervisor start pid 502\n');
  fs.writeFileSync(path.join(logs, 'devnet-tunnel.log'), tunnelLog ?? '| https://quick-name.trycloudflare.com |\n');
  let joinResult = path.join(dir, 'absent.json');
  if (join != null) { joinResult = path.join(dir, 'result.json'); fs.writeFileSync(joinResult, join); }
  try {
    const r = await runChecks({
      rpc: true, public: publicOn, logs, runDir: run, logLines: 500, rpcGapMs: 0, rpcFetch: rpc.fn, now,
      ports: { herald: ph, gateway: 1, gatewayPublic: pg, keeper: pk }, joinResult, psText: ps, dfText: DF(df), publicScheme: 'http', keeperJournal, ...extra,
    });
    return { ...r, by: Object.fromEntries(r.out.map((c) => [c.key, c])), rpcCalls: rpc.calls };
  } finally {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runChecks: a healthy, joinable stack is all OK', async () => {
  // tunnelLog 'x': no trycloudflare name in the log, so public-host (the stand-in) is not contradicted
  const r = await world({ tunnelLog: 'x' });
  assert.deepEqual(r.out.filter((c) => c.level !== 'OK'), []);
  assert.equal(overallOf(r.out).level, 'OK');
  for (const k of ['proc.gateway', 'proc.keeper', 'proc.herald', 'rpc.genesis', 'balance.deployer', 'season.phase', 'herald.season',
    'herald.status', 'herald.lag', 'gateway.health', 'keeper.api', 'keeper.landed', 'public.page', 'public.season', 'join.check', 'disk.free']) {
    assert.ok(r.by[k], `check ${k} present`);
  }
  assert.match(r.by['season.phase'].detail, /joinable/);
  assert.match(r.by['herald.lag'].detail, /lag 5 slots/);
  assert.deepEqual(r.rpcCalls, ['getGenesisHash', 'getSlot', 'getAccountInfo', ...DEPLOY.wallets.map(() => 'getBalance')]);
  assert.equal(r.by['rpc.calls'].detail, '9 read-only calls');
});

test('runChecks: a non-devnet genesis stops every further RPC call', async () => {
  const rpc = fakeRpc({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
  const r = await world({ rpc, tunnelLog: 'x' });
  assert.equal(r.by['rpc.genesis'].level, 'FAIL');
  assert.deepEqual(rpc.calls, ['getGenesisHash']);
  assert.equal(r.by['season.phase'].level, 'FAIL');
});

test('runChecks: RPC 429 is a WARN (no retry), the season is then unread', async () => {
  const rpc = fakeRpc({ status: 429 });
  const r = await world({ rpc, tunnelLog: 'x' });
  assert.equal(r.by.rpc.level, 'WARN');
  assert.match(r.by.rpc.detail, /HTTP 429/);
  assert.equal(rpc.calls.length, 1);
});

test('runChecks: wrong owner, low balances and herald lag', async () => {
  const sol = (a) => (a === DEPLOY.wallets[0].address ? 3 : a === DEPLOY.wallets[2].address ? 0.1 : 50);
  const r = await world({ rpc: fakeRpc({ owner: '11111111111111111111111111111111', sol, slot: 5000 }), tunnelLog: 'x' });
  assert.equal(r.by['season.account'].level, 'FAIL');
  assert.equal(r.by['balance.deployer'].level, 'WARN');
  assert.equal(r.by['balance.funder-1'].level, 'FAIL');
  assert.equal(r.by['balance.funder-2'].level, 'OK');
  assert.equal(r.by['herald.lag'].level, 'FAIL');
});

test('runChecks: authority below the CreateSeason need is a WARN only before CreateSeason', async () => {
  const sol = (a) => (a === DEPLOY.wallets[1].address ? 1 : 50);
  const pre = await world({ rpc: fakeRpc({ stored: 0, sol }), now: T - 600, tunnelLog: 'x', driver: '' });
  assert.equal(pre.by['balance.authority'].level, 'WARN');
  const post = await world({ rpc: fakeRpc({ stored: 2, sol }), tunnelLog: 'x' });
  assert.equal(post.by['balance.authority'].level, 'OK');
});

test('runChecks: a Closed tombstone (128 bytes) decodes as Closed, not "not read"', async () => {
  const tomb = Buffer.alloc(128); tomb[64] = 5;
  const r = await world({ rpc: fakeRpc({ seasonData: tomb }), tunnelLog: 'x' });
  assert.equal(r.by['season.phase'].level, 'WARN');
  assert.equal(r.by['season.phase'].detail, 'Closed');
});

test('runChecks: herald, gateway, keeper and public failures', async () => {
  const r = await world({
    herald: { '/h/season': { status: 500, body: 'boom' }, '/h/status': { status: 200, body: { ingest: { state: 'failing', failures: 3, error: 'rpc 429' }, alarms: { writeErrors: 2 }, live: [995] } } },
    gateway: { '/f/season': { status: 502, body: 'bad gateway' } },
    keeper: { '/v1/status': { status: 200, body: { open: true } } },
    pub: { '/frontier/frontier/': { status: 404, body: 'not found' }, '/h/season': { status: 530, body: 'origin down' } },
    tunnelLog: 'x',
  });
  assert.equal(r.by['herald.season'].level, 'FAIL');
  assert.equal(r.by['herald.status'].level, 'WARN');
  assert.match(r.by['herald.status'].detail, /failures 3.*writeErrors=2/);
  assert.equal(r.by['gateway.health'].level, 'FAIL');
  assert.equal(r.by['keeper.api'].level, 'WARN');
  assert.equal(r.by['public.page'].level, 'FAIL');
  assert.equal(r.by['public.season'].level, 'FAIL');
});

test('runChecks: nothing listening is a FAIL per service; herald NoSeasonYet after CreateSeason is a WARN', async () => {
  const dead = await world({ herald: false, gateway: false, keeper: false, tunnelLog: 'x' });
  for (const k of ['herald.season', 'herald.status', 'gateway.health', 'keeper.api']) {
    assert.equal(dead.by[k].level, 'FAIL', `${k}: ${dead.by[k].detail}`);
    assert.match(dead.by[k].detail, /no answer/);
  }
  const r = await world({ herald: { '/h/season': { status: 503, body: { code: 'NoSeasonYet', ok: false } }, '/h/status': { status: 200, body: { ingest: { state: 'ok' }, live: [995] } } }, tunnelLog: 'x' });
  assert.equal(r.by['herald.season'].level, 'WARN');
  assert.match(r.by['herald.season'].detail, /chain says Running/);
});

test('runChecks: tunnel restarted under a new name, join check not PASS, low disk, keeper STOP, herald gone/restarted', async () => {
  const ps = PS_ALL.split('\n').filter((l) => !/frontier-herald/.test(l)).concat([' 777 0:10 /bin/zsh ./run-herald.sh']).filter((l) => !/ 94338 /.test(l)).join('\n');
  const r = await world({
    tunnelLog: '| https://old-name.trycloudflare.com |\n| https://new-name.trycloudflare.com |',
    publicHost: 'old-name.trycloudflare.com',
    publicOn: false, // never fetch a real trycloudflare name from a test
    join: '{"ok":false,"error":"no village"}',
    df: 5,
    keeperLog: '2026-11-24 21:00:00 JST STOP: keeper died within 60 s five times in a row; needs a person\n',
    ps,
  });
  assert.equal(r.by['tunnel.host'].level, 'FAIL');
  assert.match(r.by['tunnel.host'].detail, /new-name/);
  assert.equal(r.by['join.check'].level, 'WARN');
  assert.equal(r.by['disk.free'].level, 'FAIL');
  assert.equal(r.by['log.keeper-a'].level, 'FAIL');
  assert.equal(r.by['proc.herald'].level, 'FAIL');
  assert.equal(r.by['proc.herald-supervisor'].level, 'WARN');
  assert.equal(overallOf(r.out).level, 'FAIL');
});

test('runChecks: before CreateSeason nothing post-create is expected; a finished driver is not a FAIL', async () => {
  const ps = PS_ALL.split('\n').filter((l) => !/run-gateway|server\.mjs|run-keeper|frontier-keeper/.test(l)).join('\n');
  const r = await world({ rpc: fakeRpc({ stored: 0 }), now: T - 3600, driver: '2026-11-23 19:34:37 JST driver start pid 92587', ps, join: null, tunnelLog: 'x',
    herald: { '/h/season': { status: 503, body: { code: 'NoSeasonYet', ok: false } }, '/h/status': { status: 200, body: { ingest: { state: 'ok' }, live: [995] } } } });
  for (const k of ['proc.gateway', 'proc.keeper', 'proc.season-driver', 'gateway.health', 'keeper.api', 'keeper.landed', 'herald.season', 'season.phase', 'join.check']) {
    assert.equal(r.by[k].level, 'OK', `${k}: ${r.by[k].detail}`);
  }
  const done = await world({ ps: PS_ALL.split('\n').filter((l) => !/season-driver|gateway-starter|join-check/.test(l)).join('\n'), tunnelLog: 'x' });
  for (const k of ['proc.season-driver', 'proc.gateway-starter', 'proc.join-check']) assert.equal(done.by[k].level, 'OK', `${k}: ${done.by[k].detail}`);
  const stopped = await world({ driver: DRIVER_DONE.split('\n').slice(0, 1).concat(['2026-11-24 19:50:00 JST STOP: operator failed 6 times before CreateSeason landed; needs a person']).join('\n'), tunnelLog: 'x',
    ps: PS_ALL.split('\n').filter((l) => !/season-driver/.test(l)).join('\n') });
  assert.equal(stopped.by['log.season-driver'].level, 'FAIL');
});

const swapPs = (re, line) => PS_ALL.split('\n').map((l) => (re.test(l) ? line : l)).join('\n');
const HERALD_NEW = ' 7001 02:00 /r/bin/frontier-herald --data d --listen 127.0.0.1:41140 --web w';
const procLevels = (r) => Object.fromEntries(r.out.filter((c) => c.key.startsWith('proc.')).map((c) => [c.key, c.level]));

test('runChecks: a planned herald restart is a WARN for the window, then OK again (--state)', async () => {
  // run 1: a state file from before this change (no procs in it) — every process is a first sighting
  const r1 = await world({ tunnelLog: 'x', extra: { prevState: { firstSeen: {}, fromLogs: {} } } });
  assert.deepEqual(r1.out.filter((c) => c.level !== 'OK'), []);
  assert.equal(r1.procs['proc.herald'].pid, 94463);
  const s1 = mergeState({ firstSeen: { x: 'kept' } }, r1);
  assert.equal(s1.firstSeen.x, 'kept');
  assert.equal(Object.keys(s1.procs).length, 11);
  // run 2: the herald was swapped two minutes ago
  const r2 = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW), extra: { prevState: s1 } });
  assert.equal(r2.by['proc.herald'].level, 'WARN');
  assert.equal(r2.by['proc.herald'].detail, 'pid 7001 up 02:00 — was 94463 at the previous run (restarted)');
  assert.deepEqual(Object.entries(procLevels(r2)).filter(([, l]) => l !== 'OK'), [['proc.herald', 'WARN']]);
  assert.equal(overallOf(r2.out).level, 'WARN');
  const s2 = mergeState(s1, r2);
  // run 3: 12 minutes old, same PID → still inside the 30-minute window
  const r3 = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW.replace('02:00', '12:00')), extra: { prevState: s2 } });
  assert.equal(r3.by['proc.herald'].level, 'WARN');
  assert.match(r3.by['proc.herald'].detail, /restarted 12 min ago, was 94463/);
  const s3 = mergeState(s2, r3);
  // run 4: 42 minutes old → OK with the current PID and uptime, overall OK
  const r4 = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW.replace('02:00', '42:00')), extra: { prevState: s3 } });
  assert.equal(r4.by['proc.herald'].detail, 'pid 7001 up 42:00');
  assert.deepEqual(r4.out.filter((c) => c.level !== 'OK'), []);
  // --restart-warn-min shortens the window
  const r3b = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW.replace('02:00', '12:00')), extra: { prevState: s2, restartWarnMin: 10 } });
  assert.equal(r3b.by['proc.herald'].level, 'OK');
  // a process that was not wanted before and starts now (state has no record of it) is not a restart
  const noKeeper = { ...s1, procs: Object.fromEntries(Object.entries(s1.procs).filter(([k]) => !/keeper/.test(k))) };
  const r5 = await world({ tunnelLog: 'x', ps: swapPs(/frontier-keeper/, ' 503 00:20 /r/bin/frontier-keeper --config keeper-a/keeper.toml'), extra: { prevState: noKeeper } });
  assert.equal(r5.by['proc.keeper'].level, 'OK');
});

test('runChecks: --state reads the previous run from the file; without --state a young process is the WARN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-state-'));
  try {
    const state = path.join(dir, 'state.json');
    // absent state file = first run: all first sightings
    const r1 = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW), extra: { state } });
    assert.equal(r1.by['proc.herald'].level, 'OK');
    assert.equal(fs.existsSync(state), false, 'runChecks writes nothing');
    fs.writeFileSync(state, JSON.stringify(mergeState({}, r1)));
    const before = fs.readFileSync(state, 'utf8');
    const r2 = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW.replace('7001', '7002').replace('02:00', '00:30')), extra: { state } });
    assert.match(r2.by['proc.herald'].detail, /pid 7002 up 00:30 — was 7001 at the previous run \(restarted\)/);
    assert.equal(fs.readFileSync(state, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const bare = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW) });
  assert.equal(bare.by['proc.herald'].level, 'WARN');
  assert.match(bare.by['proc.herald'].detail, /started 2 min ago \(restarted or first start; WARN until 30 min old\)/);
  const bareOld = await world({ tunnelLog: 'x', ps: swapPs(/frontier-herald/, HERALD_NEW.replace('02:00', '31:00')) });
  assert.equal(bareOld.by['proc.herald'].level, 'OK');
});

test('runChecks: <run-dir>/health-procs.json — expected PID, pidfile, window, and a broken file', async () => {
  const young = swapPs(/frontier-herald/, HERALD_NEW);
  // the operator wrote the new PID down: OK straight after the restart
  const ok = await world({ tunnelLog: 'x', ps: young, overrides: { procs: { 'proc.herald': { pid: 7001 } } } });
  assert.equal(ok.by['proc.herald'].detail, 'pid 7001 up 02:00 (expected pid, health-procs.json)');
  assert.deepEqual(ok.out.filter((c) => c.level !== 'OK'), []);
  assert.equal(ok.by['proc.overrides'], undefined, 'no extra line when the file is fine');
  // a stale expected PID is a WARN however old the process is
  const stale = await world({ tunnelLog: 'x', overrides: { procs: { 'proc.herald': { pid: 1 } } } });
  assert.equal(stale.by['proc.herald'].detail, 'pid 94463 up 05:00:00 — expected pid 1 (health-procs.json) (restarted)');
  // the window from the file; the command line wins over it
  const win = await world({ tunnelLog: 'x', ps: young, overrides: { restartWarnMin: 1 } });
  assert.equal(win.by['proc.herald'].level, 'OK');
  const cli = await world({ tunnelLog: 'x', ps: young, overrides: { restartWarnMin: 1 }, extra: { restartWarnMin: 30 } });
  assert.equal(cli.by['proc.herald'].level, 'WARN');
  // broken JSON: one WARN line, the process checks go on by the default rule
  const bad = await world({ tunnelLog: 'x', overrides: '{ "procs": ' });
  assert.equal(bad.by['proc.overrides'].level, 'WARN');
  assert.match(bad.by['proc.overrides'].detail, /^health-procs\.json is not JSON/);
  assert.equal(bad.by['proc.herald'].level, 'OK');
  assert.deepEqual(bad.out.filter((c) => c.level !== 'OK').map((c) => c.key), ['proc.overrides']);
  // a pidfile entry whose file is missing is reported the same way
  const nofile = await world({ tunnelLog: 'x', overrides: { procs: { 'proc.keeper': { pidfile: 'keeper-a/keeper.pid' } } } });
  assert.match(nofile.by['proc.overrides'].detail, /proc\.keeper: pidfile keeper-a\/keeper\.pid not readable; ignored/);
  assert.equal(nofile.by['proc.keeper'].level, 'OK');
});

// ---------- "world creation postponed / no world yet" (owner 2026-11-24 12:07) ----------
// Fixtures: test/fixtures/health-postponed/ (the driver log, marker and ps shapes of the Mac after the driver was stopped).
const FX = (name) => fs.readFileSync(new URL(`./fixtures/health-postponed/${name}`, import.meta.url), 'utf8');
const T2 = 1795540804; // season 2's t_create_min on chain, 2026-11-25 02:20:04 JST
const NO_WORLD_HERALD = {
  '/h/season': { status: 503, body: { code: 'NoSeasonYet', ok: false } },
  '/h/status': { status: 200, body: { ingest: { state: 'ok' }, alarms: {}, events: 3, provinces: 0, ws: { open: 0 }, live: [995] } },
};
const NO_WORLD_PUB = { '/frontier/frontier/': { status: 200, body: '<!doctype html><html></html>' }, '/h/season': { status: 503, body: { code: 'NoSeasonYet' } } };
/** The stack as it stands with no world: Announced on chain, driver log without CreateSeason, no keeper log, no join result. */
const noWorld = (o = {}) => world({
  herald: NO_WORLD_HERALD, pub: NO_WORLD_PUB, driver: FX('season-driver-log.txt').trimEnd(), join: null, tunnelLog: 'x',
  rpc: fakeRpc({ seasonData: seasonBytes({ stored: 0, tCreate: T2 }), sol: 57.6 }), ps: FX('ps-driver-stopped.txt'), now: T2 - 8 * 3600, ...o,
});

test('bondRefundDeadline follows the program (genesis round time of an Announced season)', () => {
  // quicknet: genesis 1692803367, period 3 s; first round at or after t_create_min + 660
  assert.equal(bondRefundDeadline(T2), 1795541466); // 2026-11-25 02:31:06 JST
  assert.equal(jst(bondRefundDeadline(T2)), '2026-11-25 02:31:06 JST');
  assert.equal(bondRefundDeadline(T), T + 660); // season 1: 19:49:27 JST, already on a round
  assert.equal((bondRefundDeadline(T2) - 1692803367) % 3, 0);
  assert.equal(CREATE_WINDOW_SECS, 604800);
});

test('postponedFrom: flag, either marker (first line = reason), neither; stale once CreateSeason was run', () => {
  const files = (m) => (p) => m[p] ?? null;
  const o = { runDir: '/run', logs: '/logs' };
  assert.equal(postponedFrom(o, files({})), null);
  assert.deepEqual(postponedFrom({ ...o, noWorldYet: true }, files({})), { src: '--no-world-yet', reason: '' });
  assert.deepEqual(postponedFrom(o, files({ '/logs/devnet-create-postponed': FX('devnet-create-postponed') })),
    { src: 'marker <logs>/devnet-create-postponed', reason: 'owner t506s1572 11-24 12:07: world creation postponed; season-driver stopped by Grok 12:09' });
  assert.deepEqual(postponedFrom(o, files({ '/run/world-postponed': '\n  until the rules upgrade  \nsecond line\n' })), { src: 'marker <run-dir>/world-postponed', reason: 'until the rules upgrade' });
  assert.deepEqual(postponedFrom(o, files({ '/run/world-postponed': '' })), { src: 'marker <run-dir>/world-postponed', reason: '' }); // an empty marker counts
  assert.equal(postponedFrom(o, files({ '/run/world-postponed': 'x'.repeat(500) })).reason.length, 160);
  // a marker wins over the flag for the text (it carries the reason)
  assert.match(postponedFrom({ ...o, noWorldYet: true }, files({ '/run/world-postponed': 'r' })).src, /marker/);
  assert.equal(postponedStale(milestonesFrom({ 'devnet-season-driver.log': FX('season-driver-log.txt') })), false);
  assert.equal(postponedStale(milestonesFrom({ 'devnet-season-driver.log': DRIVER_DONE })), true);
  assert.equal(postponedStale({ driverCreateRun: {} }), true);
});

test('expectedProcs / procCheck postponed: driver absent OK, driver running FAIL, waiters optional, default unchanged', () => {
  const pp = { src: '--no-world-yet', reason: '' };
  const lv = (ps, postponed) => Object.fromEntries(expectedProcs({}, false, postponed).map((s) => [s.key, procCheck(s, parsePs(FX(ps)))]));
  // default: the stopped driver is the FAIL the owner saw
  const def = lv('ps-driver-stopped.txt', null);
  assert.equal(def['proc.season-driver'].level, 'FAIL');
  assert.equal(def['proc.season-driver'].detail, 'not running');
  assert.equal(lv('ps-waiters-stopped.txt', null)['proc.gateway-starter'].level, 'FAIL');
  assert.equal(lv('ps-waiters-stopped.txt', null)['proc.join-check'].level, 'FAIL');
  // postponed: nothing that makes or waits for the world is wanted
  for (const ps of ['ps-driver-stopped.txt', 'ps-waiters-stopped.txt']) {
    const r = lv(ps, pp);
    for (const k of ['proc.season-driver', 'proc.gateway-starter', 'proc.gateway-supervisor', 'proc.gateway', 'proc.keeper-supervisor', 'proc.keeper', 'proc.join-check']) {
      assert.equal(r[k].level, 'OK', `${ps} ${k}: ${r[k].detail}`);
    }
    assert.match(r['proc.season-driver'].detail, /expected: world creation postponed/);
    assert.match(r['proc.keeper'].detail, /not expected: world creation postponed/);
    for (const k of ['proc.herald-supervisor', 'proc.herald', 'proc.tunnel', 'proc.caffeinate']) assert.equal(r[k].level, 'OK', k);
  }
  assert.match(lv('ps-driver-stopped.txt', pp)['proc.gateway-starter'].detail, /pid 95878 .*still running/);
  assert.match(lv('ps-waiters-stopped.txt', pp)['proc.join-check'].detail, /not needed: world creation postponed/);
  // the driver running while postponed would send CreateSeason: FAIL
  const run = lv('ps-driver-running.txt', pp);
  assert.equal(run['proc.season-driver'].level, 'FAIL');
  assert.match(run['proc.season-driver'].detail, /pid 94632 .*RUNNING although world creation postponed/);
  assert.equal(lv('ps-driver-running.txt', null)['proc.season-driver'].level, 'OK');
  // still wanted in the mode: herald, tunnel, caffeinate
  const none = Object.fromEntries(expectedProcs({}, false, pp).map((s) => [s.key, procCheck(s, [])]));
  for (const k of ['proc.herald-supervisor', 'proc.herald', 'proc.tunnel', 'proc.caffeinate']) assert.equal(none[k].level, 'FAIL', k);
  // the default spec list is what it was (no `forbid`, same wants)
  assert.deepEqual(expectedProcs({}, false).map((s) => [s.key, s.want, s.forbid]), expectedProcs({}, false, null).map((s) => [s.key, s.want, undefined]));
  assert.deepEqual(expectedProcs({}, false).filter((s) => s.want).map((s) => s.key),
    ['proc.season-driver', 'proc.gateway-starter', 'proc.herald-supervisor', 'proc.herald', 'proc.join-check', 'proc.tunnel', 'proc.caffeinate']);
});

test('phaseCheck postponed: Announced past its time is OK with both deadlines; window closed WARN; Aborted OK; created = stale', () => {
  const pp = { src: 'marker <logs>/devnet-create-postponed', reason: 'r' };
  const ann = decodeSeason(seasonBytes({ stored: 0, tCreate: T2 }), T2);
  // default: 16 min after the time with no CreateSeason is the FAIL
  assert.equal(phaseCheck(ann, T2 + 16 * 60, {}).level, 'FAIL');
  const before = phaseCheck(ann, T2 - 3600, {}, pp);
  assert.equal(before.level, 'OK');
  assert.match(before.detail, /creation postponed/);
  assert.match(before.detail, /can still land until 2026-12-02 02:20:04 JST/);
  assert.match(before.detail, /returns the creation bond only before 2026-11-25 02:31:06 JST \(in 71 min\)/);
  const late = phaseCheck(ann, T2 + 16 * 60, {}, pp);
  assert.equal(late.level, 'OK');
  assert.match(late.detail, /bond is no longer returned by AbortSeason \(deadline was 2026-11-25 02:31:06 JST\)/);
  assert.equal(phaseCheck(ann, bondRefundDeadline(T2) - 1, {}, pp).detail.includes('only before'), true);
  assert.equal(phaseCheck(ann, bondRefundDeadline(T2), {}, pp).detail.includes('no longer returned'), true);
  assert.equal(phaseCheck(ann, T2 + CREATE_WINDOW_SECS - 1, {}, pp).level, 'OK');
  const closed = phaseCheck(ann, T2 + CREATE_WINDOW_SECS, {}, pp);
  assert.equal(closed.level, 'WARN');
  assert.match(closed.detail, /create window closed 2026-12-02 02:20:04 JST.*new AnnounceSeason is needed/);
  const aborted = decodeSeason(seasonBytes({ stored: 6, tCreate: T2 }), T2);
  assert.equal(phaseCheck(aborted, T2, {}).level, 'FAIL');
  assert.equal(phaseCheck(aborted, T2, {}, pp).level, 'OK');
  assert.match(phaseCheck(aborted, T2, {}, pp).detail, /no world yet/);
  // the world exists although marked postponed: never quieter than the default, and it says so
  const created = decodeSeason(seasonBytes({ stored: 1, tCreate: T2 }), T2 + 60);
  assert.equal(phaseCheck(created, T2 + 60, {}, pp).level, 'WARN');
  assert.match(phaseCheck(created, T2 + 60, {}, pp).detail, /remove the marker/);
  assert.equal(phaseCheck(created, T2 + 50 * 60, {}, pp).level, 'FAIL');
  const closedSeason = decodeSeason(seasonBytes({ stored: 4, tCreate: T2 }), T2);
  assert.deepEqual(phaseCheck(closedSeason, T2, {}, pp), phaseCheck(closedSeason, T2, {}));
  assert.equal(phaseCheck(null, T2, {}, pp).level, 'FAIL');
});

test('mergeState / timelineText postponed: "world creation POSTPONED" while on, the span after', () => {
  const pp = { src: 'marker <logs>/devnet-create-postponed', reason: 'owner 12:07' };
  const base = { ms: {}, season: { status: 0, statusName: 'Announced', genesisTs: 0 } };
  assert.equal(mergeState({}, { at: T2, ...base }).postponed, undefined);
  assert.match(timelineText(mergeState({}, { at: T2, ...base })), /^last run .*\nscheduled CreateSeason opens 2026-11-25 02:20:04 JST \(driver sends at \+90 s\)/);
  const s1 = mergeState({}, { at: T2 - 7200, ...base, postponed: pp });
  const s2 = mergeState(s1, { at: T2 - 3600, ...base, postponed: pp });
  assert.deepEqual(s2.postponed, { since: jst(T2 - 7200), src: pp.src, reason: 'owner 12:07' });
  const tl = timelineText(s2);
  assert.match(tl, /world creation POSTPONED, no world yet \(first seen 2026-11-25 00:20:04 JST by this monitor; marker <logs>\/devnet-create-postponed: owner 12:07\); CreateSeason was scheduled to open 2026-11-25 02:20:04 JST — not sent/);
  assert.doesNotMatch(tl, /driver sends at/);
  assert.match(tl, /status:Announced/);
  const s3 = mergeState(s2, { at: T2 + 86400, ...base });
  assert.equal(s3.postponed.until, jst(T2 + 86400));
  const s4 = mergeState(s3, { at: T2 + 90000, ...base });
  assert.equal(s4.postponed.until, jst(T2 + 86400));
  assert.match(timelineText(s4), /scheduled CreateSeason opens/);
  assert.match(timelineText(s4), /creation was postponed 2026-11-25 00:20:04 JST → 2026-11-26 02:20:04 JST/);
  // postponed again later: a new span
  assert.equal(mergeState(s4, { at: T2 + 99999, ...base, postponed: pp }).postponed.since, jst(T2 + 99999));
  // --timeline with only the flag / marker (state not written in the mode yet)
  assert.match(timelineText({}, { src: '--no-world-yet', reason: '' }), /world creation POSTPONED, no world yet \(--no-world-yet\)/);
  // verify-pr214: a stale marker (the logs in the state show CreateSeason was run) does not make --timeline say "POSTPONED … not sent"
  const s5 = mergeState(s2, { at: T2 + 600, ms: { driverCreateRun: { at: '2026-11-25 02:21:34 JST', line: 'operator run (create)' } }, season: { status: 1, statusName: 'Created', genesisTs: T2 + 1300 } });
  assert.doesNotMatch(timelineText(s5, pp), /POSTPONED/);
  assert.match(timelineText(s5, pp), /scheduled CreateSeason opens/);
  assert.match(timelineText(s5, pp), /creation was postponed .* → 2026-11-25 02:30:04 JST/);
});

test('runChecks default: the stopped driver FAILs, and CreateSeason not landing FAILs (what the mode is for)', async () => {
  const r = await noWorld();
  assert.equal(r.by['proc.season-driver'].level, 'FAIL');
  assert.equal(r.by['world.creation'], undefined);
  assert.equal(r.postponed, null);
  assert.equal(overallOf(r.out).level, 'FAIL');
  const late = await noWorld({ now: T2 + 3600 });
  assert.equal(late.by['season.phase'].level, 'FAIL');
});

test('runChecks postponed by marker or flag: driver / gateway / keeper absence is OK, the rest is checked as always', async () => {
  for (const [name, o] of [
    ['<logs> marker', { marker: { logs: FX('devnet-create-postponed') } }],
    ['<run-dir> marker', { marker: { run: 'postponed until the rules upgrade\n' } }],
    ['flag', { extra: { noWorldYet: true } }],
    ['flag, waiters stopped too', { extra: { noWorldYet: true }, ps: FX('ps-waiters-stopped.txt') }],
    ['marker, after the scheduled time', { marker: { logs: 'x\n' }, now: T2 + 3 * 3600 }],
  ]) {
    const r = await noWorld(o);
    assert.deepEqual(r.out.filter((c) => c.level !== 'OK'), [], name);
    assert.equal(r.out[0].key, 'world.creation', name);
    assert.match(r.by['world.creation'].detail, /^postponed, no world yet \(/, name);
    assert.match(r.by['season.phase'].detail, /Announced, creation postponed/, name);
    assert.match(r.by['gateway.health'].detail, /world creation postponed/, name);
    assert.match(r.by['keeper.api'].detail, /world creation postponed/, name);
    assert.match(r.by['keeper.landed'].detail, /world creation postponed/, name);
    assert.match(r.by['join.check'].detail, /world creation postponed/, name);
    assert.equal(r.by['herald.season'].detail.startsWith('NoSeasonYet'), true, name);
    assert.ok(r.postponed, name);
    assert.deepEqual(r.rpcCalls.slice(0, 3), ['getGenesisHash', 'getSlot', 'getAccountInfo'], name);
    assert.equal(r.rpcCalls.length, 9, name); // same 9 read-only calls as by default
  }
  const m = await noWorld({ marker: { logs: FX('devnet-create-postponed') } });
  assert.match(m.by['world.creation'].detail, /marker <logs>\/devnet-create-postponed: owner t506s1572 11-24 12:07/);
  // every other line is the default one: the mode adds one line and changes text / level only where it says
  const d = await noWorld();
  const changed = ['proc.season-driver', 'proc.gateway-starter', 'proc.join-check', 'proc.gateway-supervisor', 'proc.gateway', 'proc.keeper-supervisor', 'proc.keeper', 'balance.authority', 'season.phase', 'gateway.health', 'keeper.api', 'keeper.landed', 'join.check'];
  const strip = (c) => ({ ...c, detail: c.detail.replace(/\(\d+ ms\)/g, '(ms)').replace(/127\.0\.0\.1:\d+/g, 'host') });
  assert.deepEqual(m.out.filter((c) => c.key !== 'world.creation' && !changed.includes(c.key)).map(strip), d.out.filter((c) => !changed.includes(c.key)).map(strip));
});

test('runChecks postponed: still FAILs for a running driver, a dead herald / tunnel, low funds; authority short of the create need is not a WARN', async () => {
  const mk = { marker: { logs: 'x\n' } };
  const drv = await noWorld({ ...mk, ps: FX('ps-driver-running.txt') });
  assert.equal(drv.by['proc.season-driver'].level, 'FAIL');
  assert.equal(overallOf(drv.out).level, 'FAIL');
  const dead = await noWorld({ ...mk, herald: false, ps: FX('ps-driver-stopped.txt').split('\n').filter((l) => !/herald|cloudflared/.test(l)).join('\n') });
  for (const k of ['proc.herald', 'proc.herald-supervisor', 'proc.tunnel', 'herald.season', 'herald.status']) assert.equal(dead.by[k].level, 'FAIL', k);
  const poor = await noWorld({ ...mk, rpc: fakeRpc({ seasonData: seasonBytes({ stored: 0, tCreate: T2 }), sol: (a) => (a === DEPLOY.wallets[1].address ? 30 : a === DEPLOY.wallets[2].address ? 0.1 : 50) }) });
  assert.equal(poor.by['balance.authority'].level, 'OK');
  assert.match(poor.by['balance.authority'].detail, /creation postponed, CreateSeason will need ≈56\.13/);
  assert.equal(poor.by['balance.funder-1'].level, 'FAIL');
  // default: the same 30 SOL is the pre-create WARN
  const poorDef = await noWorld({ rpc: fakeRpc({ seasonData: seasonBytes({ stored: 0, tCreate: T2 }), sol: 30 }) });
  assert.equal(poorDef.by['balance.authority'].level, 'WARN');
  // an unread chain is not hidden by the mode
  const noRpc = await noWorld({ ...mk, rpc: fakeRpc({ status: 429 }) });
  assert.equal(noRpc.by.rpc.level, 'WARN');
  assert.equal(noRpc.by['season.phase'].level, 'FAIL');
  // Aborted announcement while postponed: no world yet, OK
  const ab = await noWorld({ ...mk, rpc: fakeRpc({ seasonData: seasonBytes({ stored: 6, tCreate: T2 }), sol: 57 }) });
  assert.equal(ab.by['season.phase'].level, 'OK');
  assert.equal((await noWorld({ rpc: fakeRpc({ seasonData: seasonBytes({ stored: 6, tCreate: T2 }), sol: 57 }) })).by['season.phase'].level, 'FAIL');
});

test('runChecks postponed but the world was created: the marker is stale, default checks apply', async () => {
  // driver log shows CreateSeason and setup: a healthy joinable stack with a forgotten marker → one WARN, nothing hidden
  const r = await world({ tunnelLog: 'x', marker: { logs: FX('devnet-create-postponed') } });
  assert.deepEqual(r.out.filter((c) => c.level !== 'OK').map((c) => c.key), ['world.creation']);
  assert.match(r.by['world.creation'].detail, /marked postponed .* but the driver log shows CreateSeason was run/);
  assert.equal(r.postponed, null);
  // and a dead keeper is the FAIL it always was
  const k = await world({ tunnelLog: 'x', extra: { noWorldYet: true }, keeper: false, ps: PS_ALL.split('\n').filter((l) => !/frontier-keeper/.test(l)).join('\n') });
  assert.equal(k.by['proc.keeper'].level, 'FAIL');
  assert.equal(k.by['keeper.api'].level, 'FAIL');
  // chain says Created while the driver log is silent (created by hand): season.phase says so
  const c = await noWorld({ marker: { logs: 'x\n' }, now: T2 + 120, rpc: fakeRpc({ seasonData: seasonBytes({ stored: 1, tCreate: T2 }), sol: 57 }) });
  assert.equal(c.by['season.phase'].level, 'WARN');
  assert.match(c.by['season.phase'].detail, /the world exists, remove the marker/);
});

// ---------- keeper.landed (keeper-stall-investigate) ----------
import { execFileSync as execSync } from 'node:child_process';
import { KEEPER_LANDED_SLOTS, keeperLandedCheck, readKeeperJournal } from '../health.mjs';

test('keeperLandedCheck: landed age in slots → OK / WARN / FAIL; a busy keeper that lands nothing is a FAIL', () => {
  const live = 1_000_000;
  assert.equal(keeperLandedCheck({ maxLanded: live - 100, maxSent: live - 10, sent: 5 }, live).level, 'OK');
  assert.equal(keeperLandedCheck({ maxLanded: live - KEEPER_LANDED_SLOTS.warn, maxSent: live, sent: 5 }, live).level, 'OK');
  assert.equal(keeperLandedCheck({ maxLanded: live - KEEPER_LANDED_SLOTS.warn - 1, maxSent: live, sent: 5 }, live).level, 'WARN');
  assert.equal(keeperLandedCheck({ maxLanded: live - KEEPER_LANDED_SLOTS.fail - 1, maxSent: live, sent: 5 }, live).level, 'FAIL');
  // devnet 11-27 11:04: newest landed slot 526,502,713 (21:04:37 the day before), herald ≈ 526,711,761, 51,139 sends open
  const real = keeperLandedCheck({ maxLanded: 526_502_713, maxSent: 526_704_145, sent: 51_139 }, 526_711_761);
  assert.equal(real.level, 'FAIL');
  assert.match(real.detail, /newest landed write 209048 slots ago \(≈836 min\); newest send 7616 slots ago .*; 51139 sends unresolved/);
  assert.equal(keeperLandedCheck({ maxLanded: null, maxSent: null, sent: 0 }, live).level, 'FAIL');
  assert.equal(keeperLandedCheck(null, live).level, 'WARN');
  assert.equal(keeperLandedCheck({ maxLanded: 1, maxSent: 1, sent: 0 }, NaN).level, 'WARN');
});

test('runChecks: keeper.landed FAILs when the journal has no recent landing', async () => {
  const r = await world({ tunnelLog: 'x', keeperJournal: { maxLanded: 995 - KEEPER_LANDED_SLOTS.fail - 1, maxSent: 990, sent: 40 } });
  assert.equal(r.by['keeper.landed'].level, 'FAIL');
  assert.equal(overallOf(r.out).level, 'FAIL');
});

test('readKeeperJournal: reads a WAL journal read-only with the sqlite3 CLI (skipped without sqlite3)', (t) => {
  try { execSync('sqlite3', ['-version'], { encoding: 'utf8' }); } catch { t.skip('no sqlite3 CLI'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-journal-'));
  try {
    const f = path.join(dir, 'keeper.journal.sqlite');
    execSync('sqlite3', [f, "PRAGMA journal_mode=WAL; CREATE TABLE attempts(sig TEXT PRIMARY KEY, sent_slot INTEGER, landed_slot INTEGER, status TEXT);"
      + "INSERT INTO attempts VALUES('a', 10, 12, 'landed'), ('b', 20, NULL, 'sent'), ('c', 30, NULL, 'sent'), ('d', 5, 40, 'superseded');"]);
    assert.deepEqual(readKeeperJournal(f), { maxLanded: 12, maxSent: 30, sent: 2 });
    assert.equal(readKeeperJournal(path.join(dir, 'absent.sqlite')), null);
    const empty = path.join(dir, 'empty.sqlite');
    execSync('sqlite3', [empty, 'CREATE TABLE attempts(sig TEXT, sent_slot INTEGER, landed_slot INTEGER, status TEXT);']);
    assert.deepEqual(readKeeperJournal(empty), { maxLanded: null, maxSent: null, sent: 0 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readKeeperJournal: a stopped keeper (no -wal/-shm) is read with immutable=1; a live one never is (verify-pr281)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-journal-'));
  try {
    const f = path.join(dir, 'keeper.journal.sqlite');
    fs.writeFileSync(f, '');
    const calls = [];
    // macOS /usr/bin/sqlite3 refuses mode=ro on a WAL database whose -shm is gone: the fallback reads it immutable.
    const refuseRo = (args) => { calls.push(args[3]); if (!args[3].includes('immutable=1')) throw new Error('unable to open database file'); return '7 9 1\n'; };
    assert.deepEqual(readKeeperJournal(f, refuseRo), { maxLanded: 7, maxSent: 9, sent: 1 });
    assert.deepEqual(calls, [`file:${f}?mode=ro`, `file:${f}?mode=ro&immutable=1`]);
    // -shm present = a connection may have it open: never immutable (it could read a torn or stale state).
    for (const side of ['-shm', '-wal']) {
      fs.writeFileSync(f + side, '');
      calls.length = 0;
      assert.equal(readKeeperJournal(f, refuseRo), null, side);
      assert.deepEqual(calls, [`file:${f}?mode=ro`], side);
      fs.rmSync(f + side);
    }
    // in place first: a working mode=ro read is the only call
    calls.length = 0;
    assert.deepEqual(readKeeperJournal(f, (args) => { calls.push(args[3]); return ' 5 0\n'; }), { maxLanded: null, maxSent: 5, sent: 0 });
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// herald-pull-chunk: herald.lag from /h/status ingest.backlog + lastArchivedSlot (and the previous run's, via --state)
test('heraldLag: a backlog is WARN while lastArchivedSlot advances, FAIL when it stands still', () => {
  assert.equal(SLOT_S_DEFAULT, 0.4);
  assert.deepEqual(heraldLag({ lag: 5, backlog: 0, lastArchived: 900 }), { level: 'OK', note: null });
  assert.equal(heraldLag({ lag: 2000, backlog: NaN }).level, 'FAIL', 'no backlog field: the live-slot lag decides, as before');
  const p = heraldLag({ lag: 3, backlog: 300, lastArchived: 950, prevArchived: 900 });
  assert.equal(p.level, 'WARN');
  assert.match(p.note, /behind, progressing: backlog 300 txs, archived through slot 950 \(\+50 slots/);
  assert.equal(heraldLag({ lag: 3, backlog: 300, lastArchived: 900, prevArchived: 900 }).level, 'FAIL');
  assert.match(heraldLag({ lag: 3, backlog: 300, lastArchived: 900, prevArchived: 900 }).note, /NOT progressing/);
  assert.equal(heraldLag({ lag: 3, backlog: 300, lastArchived: 950 }).level, 'WARN', 'no previous run: WARN, not FAIL');
  assert.equal(heraldLag({ lag: 3, backlog: 300, prevArchived: 900 }).level, 'FAIL', 'no lastArchivedSlot to show progress');
});

test('runChecks: herald.lag behind-progressing / not-progressing, the state keeps lastArchivedSlot, --slot-s', async () => {
  const status = (ingest) => ({
    '/h/season': { status: 200, body: { statusName: 'Running', rings: [1, 2], ringsOpened: 2, rMax: 16, rulesetHash: 'ab'.repeat(32) } },
    '/h/status': { status: 200, body: { ingest: { state: 'ok', failures: 0, error: null, ...ingest }, alarms: { badRecords: 0 }, events: '9', provinces: 2, ws: { open: 1 }, live: [995, 0] } },
  });
  const behind = { backlog: 412, lastArchivedSlot: 900 };
  let r = await world({ herald: status(behind), tunnelLog: 'x', extra: { prevState: { herald: { lastArchivedSlot: 850 } } } });
  assert.equal(r.by['herald.lag'].level, 'WARN');
  assert.match(r.by['herald.lag'].detail, /lag 5 slots \(≈2 s at 0\.4 s\/slot\); behind, progressing: backlog 412 txs/);
  assert.deepEqual(mergeState({}, r).herald.lastArchivedSlot, 900);
  r = await world({ herald: status(behind), tunnelLog: 'x', extra: { prevState: { herald: { lastArchivedSlot: 900 } } } });
  assert.equal(r.by['herald.lag'].level, 'FAIL');
  assert.match(r.by['herald.lag'].detail, /NOT progressing/);
  // caught up (backlog 0) or unknown: the live lag decides; measured seconds a slot when given
  r = await world({ herald: status({ backlog: 0, lastArchivedSlot: 990 }), tunnelLog: 'x', extra: { slotS: 0.24 } });
  assert.equal(r.by['herald.lag'].level, 'OK');
  assert.match(r.by['herald.lag'].detail, /lag 5 slots \(≈1 s at 0\.24 s\/slot\)$/);
  r = await world({ herald: status({ backlog: 'unknown', lastArchivedSlot: 990 }), tunnelLog: 'x' });
  assert.equal(r.by['herald.lag'].level, 'OK');
});
