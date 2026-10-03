// The playtest's monitor (scripts/playtest-watch.mjs, PT-A): the literal definitions behind the health report
// and the alarm files, on a fixture run directory and a fake chain RPC. No network except 127.0.0.1:0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DATA = mkdtempSync(path.join(tmpdir(), 'psf-ptops-'));
const RUN = path.join(DATA, 'runs', 'fix');
mkdirSync(path.join(RUN, 'relay'), { recursive: true });
process.env.PT_DATA = DATA;
process.env.PT_RUN = RUN;
process.env.PT_RUN_ID = 'fix';
const { collect, render, readEvents, LIMITS } = await import('../../scripts/playtest-watch.mjs');

const free = () => new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const state = over => ({ phase: 'running', program: 'P', season_id: 7, supervisor_pid: 99999999, ports: {}, components: {}, season: { genesis_ts: 1_000_000, bell_secs: 600, end_bell: 1008, join_close_bell: 756 }, ...over });
const write = s => writeFileSync(path.join(RUN, 'state.json'), JSON.stringify(s));
const kinds = r => r.alarms.map(a => a.kind);

test('no state.json: a no-run alarm, nothing else', async () => {
  const r = await collect();
  assert.equal(r.state, 'no-run');
  assert.deepEqual(kinds(r), ['no-run']);
});

test('dead processes and closed ports are health alarms; the lag class is only for the chain', async () => {
  const [pl, ph] = [await free(), await free()];
  write(state({ ports: { localnet: pl, herald: ph, 'relay-operator': await free(), 'relay-public': await free(), 'keeper-a': await free(), 'keeper-b': await free(), bots: await free(), 'drand-replay': await free() },
    components: { localnet: { pid: 99999998, spec: { program: '/x/frontier-localnet' } }, herald: { pid: 99999997, spec: { program: '/x/frontier-herald' } } } }));
  const r = await collect();
  assert.equal(r.state, 'ALARM');
  for (const k of ['supervisor-down', 'babysitter-down', 'down:localnet', 'down:herald', 'port-closed:localnet', 'port-closed:herald', 'herald-unreachable', 'relay-unreachable']) assert.ok(kinds(r).includes(k), `${k} in ${kinds(r)}`);
  assert.equal(r.alarms.find(a => a.kind === 'down:localnet').class, 'health');
  assert.equal(r.alarms.find(a => a.kind === 'chain-unreachable').class, 'lag');
  // After `playtest-down.sh` (STOP exists) a stopped stack is not an alarm.
  writeFileSync(path.join(DATA, 'STOP'), '');
  const stopped = await collect();
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(stopped.alarms, []);
  rmSync(path.join(DATA, 'STOP'));
  // While the stack starts, a closed port is a warning, not an alarm.
  write(state({ phase: 'setup', updated_wall_ms: Date.now(), ports: { localnet: pl, herald: ph }, components: {} }));
  const starting = await collect();
  assert.ok(!kinds(starting).includes('port-closed:localnet'), kinds(starting));
  assert.ok(starting.warnings.some(w => w.kind.startsWith('starting:')));
});

test('the monitor (debounce) raises a down process only on the second tick in a row; the live status alarms at once', async () => {
  const ph = await free();
  write(state({ ports: { herald: ph }, components: { herald: { pid: 99999997, spec: { program: '/x/frontier-herald' } } } }));
  const first = await collect({ debounce: true });
  assert.ok(!kinds(first).includes('down:herald'), 'one sighting is a warning');
  assert.ok(first.warnings.some(w => w.kind === 'once:down:herald'));
  assert.ok(first.candidates.includes('down:herald'));
  const second = await collect({ prev: first, debounce: true });
  assert.ok(kinds(second).includes('down:herald'), 'two in a row is an alarm');
  assert.ok(kinds(await collect()).includes('down:herald'), 'status without debounce alarms at once');
  // health that is not a restartable process is never debounced
  assert.ok(kinds(first).includes('babysitter-down'), 'a missing babysitter is not restarted by anything: no debounce');
});

function fakeChain({ slot, unix, paused = false }) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const m = JSON.parse(b);
      calls.push(m.method);
      const result = m.method === 'frontier_status' ? { slot, unixTimestamp: unix, scale: 1, paused } : m.method === 'getSignaturesForAddress' ? [] : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, calls })));
}

test('the bell, and the slot-rate rule: stalled is an alarm, a suspended monitor (a gap) is only recorded', async () => {
  const c = await fakeChain({ slot: 10_000, unix: 1_000_000 + 600 * 5 + 77 });
  try {
    write(state({ ports: { localnet: c.port } }));
    const r = await collect();
    assert.deepEqual(r.bell, { now: 5, day: 0, bell_of_day: 5, genesis_in_secs: 0, into_bell_secs: 77 });
    const now = Date.now();
    // 40 s ago the slot was 9,990: 10 slots in 40 s = 0.25 per second, a healthy chain makes 2.5
    const stalled = await collect({ prev: { wall_ms: now - 40_000, wall: 'x', chain: { slot: 9_990, game_unix: 1_000_000 + 600 * 5 + 37 } } });
    assert.ok(kinds(stalled).includes('chain-stalled'), kinds(stalled));
    assert.equal(stalled.alarms.find(a => a.kind === 'chain-stalled').class, 'lag');
    // A healthy interval (100 slots in 40 s) is fine.
    const fine = await collect({ prev: { wall_ms: now - 40_000, wall: 'x', chain: { slot: 9_900, game_unix: 1_000_000 + 600 * 5 + 37 } } });
    assert.ok(!kinds(fine).includes('chain-stalled'));
    assert.ok(fine.slot_rate > 2.3 && fine.slot_rate <= 2.5, String(fine.slot_rate));
    // The monitor was not running for 10 minutes and the chain made 0 slots: the machine slept; that is a gap, not a stall.
    const slept = await collect({ prev: { wall_ms: now - 600_000, wall: 'x', chain: { slot: 10_000, game_unix: 1_000_000 + 600 * 5 + 77 } } });
    assert.ok(!kinds(slept).includes('chain-stalled'));
    assert.equal(slept.gap.slots, 0);
    assert.ok(slept.gap.wall_secs >= 599);
    assert.equal(slept.gap.game_secs, 0);
    // A paused chain is its own lag alarm.
    const p = await fakeChain({ slot: 1, unix: 1_000_100, paused: true });
    write(state({ ports: { localnet: p.port } }));
    assert.ok(kinds(await collect()).includes('chain-paused'));
    p.srv.close();
    // Before genesis: no bell, no division by a missing genesis.
    write(state({ ports: { localnet: c.port }, season: {} }));
    assert.equal((await collect()).bell, undefined);
  } finally {
    c.srv.close();
  }
});

test('invite and join counts come from the relay event log, by batch label', () => {
  const f = path.join(DATA, 'events.jsonl');
  writeFileSync(f, [
    { t: 1, event: 'invites_issued', label: 'bots', count: 2, nonces: ['aa', 'bb'] },
    { t: 2, event: 'invites_issued', label: 'friends-1', count: 2, nonces: ['cc', 'dd'] },
    { t: 3, event: 'join', invite: 'aa', wallet: 'W1', signature: 's1' },
    { t: 4, event: 'join', invite: 'cc', wallet: 'W2', signature: 's2' },
    { t: 5, event: 'seen', citizen: 'C' },
    { t: 6, event: 'join', invite: 'zz', wallet: 'W3', signature: 's3' },
    { t: 7, event: 'join', invite: null, wallet: 'W4', signature: 's4' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n{not json\n');
  const e = readEvents(f);
  assert.deepEqual([e.total_issued, e.total_joined], [4, 4]);
  assert.deepEqual(e.issued, { bots: 2, 'friends-1': 2 });
  assert.deepEqual(e.joined_by_label, { bots: 1, 'friends-1': 1, unknown: 1, open: 1 });
  assert.deepEqual(readEvents(path.join(DATA, 'nope.jsonl')).total_joined, 0);
});

test('the report prints the figures the runbook defines, and the limits are the documented ones', () => {
  const text = render({ run_id: 'fix', host: 'h', wall: 'now', state: 'up', phase: 'running', resumes: 1,
    bell: { now: 12, day: 0, bell_of_day: 12, into_bell_secs: 30 }, season: { id: 7, join_close_bell: 756, end_bell: 1008 }, last_resolved_bell: 9, lag_bells: 3,
    world: { resolved_through_min: 9, resolved_through_max: 11, lag_p50: 1, lag_p99: 3, lagging_over_2: 4, provinces: 37 }, alarms: [], warnings: [{ kind: 'w', detail: 'd' }],
    processes: [{ name: 'localnet', pid: 1, alive: true, up: '01:00', starts: 2 }], ports: [{ name: 'herald', port: 41117, open: true, bind: '127.0.0.1', exposed: true }],
    invites: { total_issued: 3, issued: { bots: 3 }, total_joined: 1, joined_by_label: { bots: 1 } }, load: [1, 2, 3], alarm_files: { lag: false, health: false } });
  for (const want of ['bell 12', 'resolved through bell 9', 'lag 3 bells', 'the one port the tunnel points at', 'starts 2', 'LAG-ALARM absent']) assert.ok(text.includes(want), `${want}\n${text}`);
  assert.equal(LIMITS.worldLagAlarm, 36);
  assert.equal(LIMITS.heraldLagSlots, 150);
  assert.ok(LIMITS.worldLagWarn < LIMITS.worldLagAlarm);
  assert.ok(!existsSync(path.join(DATA, 'LAG-ALARM')), 'collect alone writes no alarm file');
});

test('cleanup', () => { rmSync(DATA, { recursive: true, force: true }); });
