// Tests of the read-only devnet health check (scripts/devnet/health.mjs): pure
// helpers and the RPC wrapper with a fake fetch. Nothing here contacts a
// network, reads a key or touches a process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVNET_RPC, alertedReport, decodeSeason, expectedProcs, jst, lagLevel, logLevel, lowerBound, makeRpc, mergeState,
  milestonesFrom, overallOf, parsePs, phaseCheck, procCheck, scanLog, timelineText, tunnelHost,
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
  const ps = parsePs(' 92587 22:45 /bin/zsh ./season-driver.sh 1795516707\n 94463 22:20 /x/frontier-herald --data d --listen 127.0.0.1:41140 --web w\n 1 1-00:00:00 /sbin/launchd\n');
  const before = Object.fromEntries(expectedProcs({}, false).map((s) => [s.key, procCheck(s, ps)]));
  assert.equal(before['proc.season-driver'].level, 'OK');
  assert.equal(before['proc.herald'].level, 'OK');
  assert.equal(before['proc.keeper'].level, 'OK'); // not expected yet
  assert.equal(before['proc.tunnel'].level, 'FAIL'); // always expected
  const after = Object.fromEntries(expectedProcs({ keeperStarted: {}, setupComplete: {}, gatewayStarted: {} }, true).map((s) => [s.key, procCheck(s, ps)]));
  assert.equal(after['proc.keeper'].level, 'FAIL');
  assert.equal(after['proc.gateway'].level, 'FAIL');
  const moved = procCheck({ re: /frontier-herald/, want: true, pid: 1 }, ps);
  assert.equal(moved.level, 'WARN');
  assert.match(moved.detail, /restarted/);
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
