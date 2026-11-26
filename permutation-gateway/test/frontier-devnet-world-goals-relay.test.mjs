// pt-world-goals-devnet: the relay's public listener serves the off-chain world-goals judge's answer (routes/world-goals.mjs)
// through the real handler (app.mjs createFrontierHandler). A file on disk, a fake request; no chain, no key, no socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { answerOf, initialState, WIDE_FLAGS_RULESET } from '../src/frontier/wide-flags.mjs';

const SEASON = '3';

test('the relay\'s public listener serves GET /f/goals/state (rate limited, no-store), POST is not a route', async () => {
  const { createFrontierHandler, FRONTIER_IP_LIMITS, FRONTIER_FUNDED_ROUTES } = await import('../src/frontier/app.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wgh-'));
  try {
    const file = path.join(dir, 'answer.json');
    await writeFile(file, JSON.stringify(answerOf(initialState(), { seasonId: SEASON })));
    const checked = [];
    const ctx = { cfg: { seasonId: SEASON, worldGoalsFile: file, heraldPeer: '127.0.0.1', publicProxy: 'none' }, log: () => {}, keeperGuard: { count: () => {} }, limiter: { check: (k, l) => checked.push([k, l]) }, funds: { check: async () => { throw new Error('never funded'); } } };
    const h = createFrontierHandler(ctx, { surface: 'public' });
    const call = async (method, url) => {
      const res = { status: 0, headers: null, body: '', writeHead(s, hd) { this.status = s; this.headers = hd; }, end(b) { this.body = String(b); }, once() {}, off() {} };
      await h({ method, url, headers: {}, socket: { remoteAddress: '203.0.113.9' }, once() {}, off() {} }, res);
      return res;
    };
    const r = await call('GET', '/f/goals/state');
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(JSON.parse(r.body).ruleset, WIDE_FLAGS_RULESET);
    assert.ok(checked.some(([k]) => k.startsWith('f-ip:GET /f/goals/state:')), 'per-address limit');
    assert.ok(FRONTIER_IP_LIMITS['GET /f/goals/state'] && !FRONTIER_FUNDED_ROUTES.includes('GET /f/goals/state'));
    assert.equal((await call('POST', '/f/goals/state')).status, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
