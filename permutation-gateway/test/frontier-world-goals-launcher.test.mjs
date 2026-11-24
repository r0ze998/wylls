// flag-keeps-slice-1: the launcher's `--world-goals flag-keeps-v2` option and its read-only route
// (src/frontier/local-play-launcher.mjs, src/frontier/local-play-world-goals.mjs). Loopback 41648 only; no world is
// started (a stand-in manager answers for the world), no chain, no key. Also the map's flag-keep marks (map/keeps.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import * as G from '../src/frontier/world-goals.mjs';
import * as W from '../src/frontier/local-play-world-goals.mjs';
import { createLauncherServer, parseConfig } from '../src/frontier/local-play-launcher.mjs';

const LAUNCHER = 41648;
const raw = ({ method = 'GET', path: p, headers = {} }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: LAUNCHER, method, path: p, headers: { host: `127.0.0.1:${LAUNCHER}`, ...headers } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject); req.end();
});

test('launcher: --world-goals in its one word, its TEST overrides only with it; GET /goals-world/<port>/goals/state only', async t => {
  const tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'wylls-goals-argv-')));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const bin = path.join(tmp, 'bin'); await fsp.writeFile(bin, 'x');
  await fsp.mkdir(path.join(tmp, 'permutation-server/web'), { recursive: true });
  await fsp.mkdir(path.join(tmp, 'permutation-gateway/src/frontier'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'permutation-gateway/src/frontier/local-play-relay-server.mjs'), '');
  const base = { root: tmp, data: path.join(tmp, 'data'), runner: bin, herald: bin, depart: bin, preview: bin, resident: bin, artifact: bin, 'artifact-sha': 'cd'.repeat(32), port: String(LAUNCHER), 'world-port': '41604' };
  const argv = o => Object.entries(o).flatMap(([key, v]) => [`--${key}`, String(v)]);
  assert.equal((await parseConfig(argv(base))).worldGoals, undefined);
  const c = await parseConfig(argv({ ...base, 'world-goals': W.WORLD_GOALS_MODE, 'flag-keeps-hold': '30', 'flag-keeps-need': '2' }));
  assert.equal(c.worldGoals.holdBells, 30); assert.equal(c.worldGoals.need, 2); assert.equal(c.worldGoals.memberBells, 144);
  await assert.rejects(parseConfig(argv({ ...base, 'world-goals': 'yes' })), e => e.code === 'InvalidWorldGoals');
  await assert.rejects(parseConfig(argv({ ...base, 'flag-keeps-hold': '30' })), e => e.code === 'InvalidWorldGoals');
  await assert.rejects(parseConfig(argv({ ...base, 'world-goals': W.WORLD_GOALS_MODE, 'flag-keeps-need': '0' })), e => e.code === 'InvalidFlagKeepsNeed');
  // (flag-keeps-v2) the option word is the new ruleset; the older word still turns the same judge on; anything else is refused
  assert.equal(W.WORLD_GOALS_MODE, 'flag-keeps-v2');
  assert.equal((await parseConfig(argv({ ...base, 'world-goals': 'flag-keeps-v1', 'flag-keeps-need': '2' }))).worldGoals.need, 2);
  await assert.rejects(parseConfig(argv({ ...base, 'world-goals': 'flag-keeps-v3' })), e => e.code === 'InvalidWorldGoals');
  // the route
  const entry = { answer: () => ({ ok: true, kind: 'world-goals' }), ports: [41649] };
  const manager = { goalsFor: port => (entry.ports.includes(port) ? entry : null), coopFor: () => null, close: () => {} };
  const { server } = createLauncherServer({ port: LAUNCHER, worldPort: 41604, web: tmp, worldGoals: G.FLAG_KEEPS_DEFAULTS }, manager);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(LAUNCHER, '127.0.0.1', resolve); });
  t.after(() => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); }));
  const ok = await raw({ path: '/goals-world/41649/goals/state' });
  assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.text).kind, 'world-goals'); assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal((await raw({ path: '/goals-world/41647/goals/state' })).status, 404, 'no such world');
  assert.equal((await raw({ path: '/goals-world/41649/goals/other' })).status, 404);
  assert.equal((await raw({ method: 'POST', path: '/goals-world/41649/goals/state', headers: { origin: `http://127.0.0.1:${LAUNCHER}` } })).status, 405);
  assert.equal((await raw({ path: '/goals-world/41649/goals/state', headers: { origin: 'http://evil.test' } })).status, 403);
});

test('map: the KeepBoard keeps the flag keeps it is handed and redraws only on a change', async () => {
  const { KeepBoard } = await import('../../permutation-server/web/frontier/map/keeps.mjs');
  let n = 0;
  const kb = new KeepBoard({ invalidate: () => { n++; } });
  assert.equal(kb.setGoalFlags([{ p: 1, q: 0 }, { p: -1, q: 1 }]), true);
  assert.deepEqual([...kb.goalFlags].sort(), ['-1,1', '1,0']);
  assert.equal(kb.setGoalFlags([{ p: -1, q: 1 }, { p: 1, q: 0 }]), false);
  assert.equal(n, 1);
  assert.equal(kb.setGoalFlags(null), true);
  assert.equal(kb.goalFlags.size, 0);
});
