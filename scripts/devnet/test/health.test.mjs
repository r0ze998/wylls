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

const PS_ALL = [
  ' 92587 1:00 /bin/zsh ./season-driver.sh 1795516707',
  ' 95878 1:00 /bin/zsh ./gateway-starter.sh',
  ' 500 1:00 /bin/zsh /r/run-gateway.sh',
  ' 501 1:00 node permutation-gateway/src/frontier/server.mjs --cluster devnet --port 41130 --public-port 41133',
  ' 94338 1:00 /bin/zsh ./run-herald.sh',
  ' 94463 1:00 /r/bin/frontier-herald --data d --listen 127.0.0.1:41140 --web w',
  ' 502 1:00 /bin/zsh /r/run-keeper.sh',
  ' 503 1:00 /r/bin/frontier-keeper --config keeper-a/keeper.toml',
  ' 14077 1:00 /bin/zsh ./join-check.sh',
  ' 93889 1:00 /opt/homebrew/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:41140',
  ' 92887 1:00 caffeinate -is',
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

async function world({ herald, gateway, keeper, pub, driver = DRIVER_DONE, keeperLog = '', tunnelLog, join = '{"ok":true}', ps = PS_ALL, df = 100, rpc = fakeRpc(), now = T + 3600, publicHost, publicOn = true } = {}) {
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
  fs.writeFileSync(path.join(logs, 'devnet-season-driver.log'), driver + '\n');
  fs.writeFileSync(path.join(logs, 'devnet-keeper-a.log'), keeperLog || '2026-11-24 19:41:10 JST supervisor start pid 502\n');
  fs.writeFileSync(path.join(logs, 'devnet-tunnel.log'), tunnelLog ?? '| https://quick-name.trycloudflare.com |\n');
  let joinResult = path.join(dir, 'absent.json');
  if (join != null) { joinResult = path.join(dir, 'result.json'); fs.writeFileSync(joinResult, join); }
  try {
    const r = await runChecks({
      rpc: true, public: publicOn, logs, runDir: run, logLines: 500, rpcGapMs: 0, rpcFetch: rpc.fn, now,
      ports: { herald: ph, gateway: 1, gatewayPublic: pg, keeper: pk }, joinResult, psText: ps, dfText: DF(df), publicScheme: 'http',
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
    'herald.status', 'herald.lag', 'gateway.health', 'keeper.api', 'public.page', 'public.season', 'join.check', 'disk.free']) {
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
  for (const k of ['proc.gateway', 'proc.keeper', 'proc.season-driver', 'gateway.health', 'keeper.api', 'herald.season', 'season.phase', 'join.check']) {
    assert.equal(r.by[k].level, 'OK', `${k}: ${r.by[k].detail}`);
  }
  const done = await world({ ps: PS_ALL.split('\n').filter((l) => !/season-driver|gateway-starter|join-check/.test(l)).join('\n'), tunnelLog: 'x' });
  for (const k of ['proc.season-driver', 'proc.gateway-starter', 'proc.join-check']) assert.equal(done.by[k].level, 'OK', `${k}: ${done.by[k].detail}`);
  const stopped = await world({ driver: DRIVER_DONE.split('\n').slice(0, 1).concat(['2026-11-24 19:50:00 JST STOP: operator failed 6 times before CreateSeason landed; needs a person']).join('\n'), tunnelLog: 'x',
    ps: PS_ALL.split('\n').filter((l) => !/season-driver/.test(l)).join('\n') });
  assert.equal(stopped.by['log.season-driver'].level, 'FAIL');
});
