// (fix-loop6, LP6-3) The launcher's end on Ctrl-C is bounded: loop-play6 saw a launcher wait in manager.close() for
// ever after its world's TTL (a second Ctrl-C and SIGTERM ignored; only SIGKILL ended it). Key-free, no ports, no
// processes: the server, the manager and the children are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launcherShutdown, LAUNCHER_CLOSE_MAX_MS } from '../src/frontier/local-play-launcher.mjs';

const world = ({ hang = false } = {}) => {
  const calls = { server: 0, exits: [], killed: [], logs: [] };
  const server = { close: () => { calls.server++; }, closeAllConnections: () => {} };
  const manager = { close: () => (hang ? new Promise(() => {}) : Promise.resolve()), list: () => (hang ? [{ state: 'stopping', startedAt: 1, expiry: { expiresAt: 2 } }] : []) };
  const kids = new Set([{ pid: 11, exitCode: null, signalCode: null }, { pid: 12, exitCode: 0, signalCode: null }]);
  const end = launcherShutdown({ server, manager, live: kids, maxMs: 40, exit: c => calls.exits.push(c), log: l => calls.logs.push(JSON.parse(l)), kill: p => calls.killed.push(p.pid) });
  return { end, calls };
};
const settle = ms => new Promise(r => setTimeout(r, ms));

test('Ctrl-C with worlds that close: the port and the worlds close, then exit 0, nothing said, nothing killed by hand', async () => {
  assert.equal(LAUNCHER_CLOSE_MAX_MS, 20000);
  const { end, calls } = world();
  end('SIGINT'); await settle(5);
  assert.equal(calls.server, 1); assert.deepEqual(calls.exits, [0]); assert.deepEqual(calls.logs, []);
  assert.deepEqual(calls.killed, [11], 'a process still alive at the end is ended with it (as the exit hook did)');
});

test('a world that never closes: the end comes after the bound, says which worlds were left, ends the processes, exits 0', async () => {
  const { end, calls } = world({ hang: true });
  end('SIGINT'); await settle(10);
  assert.deepEqual(calls.exits, [], 'still waiting inside the bound');
  await settle(60);
  assert.deepEqual(calls.exits, [0]); assert.deepEqual(calls.killed, [11]);
  assert.equal(calls.logs[0].step, 'launcher-end'); assert.match(calls.logs[0].why, /not closed within 40 ms/);
  assert.deepEqual(calls.logs[0].worlds_left, [{ state: 'stopping', startedAt: 1, expiresAt: 2 }]); assert.deepEqual(calls.logs[0].processes_left, [11]);
});

test('a second Ctrl-C (or SIGTERM) while ending ends it at once; later signals change nothing', async () => {
  const { end, calls } = world({ hang: true });
  end('SIGINT'); end('SIGTERM');
  assert.deepEqual(calls.exits, [0]); assert.equal(calls.logs[0].why, 'second SIGTERM'); assert.equal(calls.server, 1);
  end('SIGINT'); await settle(60);
  assert.deepEqual(calls.exits, [0], 'one exit only');
});
