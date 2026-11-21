// fix-loop7 (TEST/local, D-verify-pr136-2): a launcher world's runner guards its time control (frontier_pause / resume /
// setScale / hold / release) with a per-world token only the launcher holds. Here: the launcher side — the token is made
// per world, handed to the runner process alone (environment, never argv), and sent back in the control header; reads
// carry it only when asked. The runner side (the refusal itself) is frontier-node/crates/localnet server.rs
// `time_control_needs_the_worlds_token_when_one_is_set`. Loopback port 0 only; no key, no chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { runnerRpc, makeRunnerControl, RUNNER_CONTROL_ENV, RUNNER_CONTROL_HEADER } from '../src/frontier/local-play-launcher.mjs';

test('the control token: 32 random bytes per world, base64url; env and header names match the runner\'s', () => {
  const a = makeRunnerControl(), b = makeRunnerControl();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
  assert.equal(RUNNER_CONTROL_ENV, 'FRONTIER_CONTROL_TOKEN');
  assert.equal(RUNNER_CONTROL_HEADER, 'x-frontier-control');
  const rs = readFileSync(new URL('../../frontier-node/crates/localnet/src/server.rs', import.meta.url), 'utf8');
  assert.match(rs, /pub const CONTROL_HEADER: &str = "x-frontier-control";/);
  assert.match(rs, /pub const CONTROL_ENV: &str = "FRONTIER_CONTROL_TOKEN";/);
  // every runner a launcher starts reads it
  for (const f of ['itest/src/natural_play.rs', 'itest/src/expedition_play.rs', 'itest/src/bin/localnet_coexist_play.rs']) {
    assert.match(readFileSync(new URL(`../../frontier-node/crates/${f}`, import.meta.url), 'utf8'), /Policy::MEMORY_ONLY\.with_control_from_env\(\)/, f);
  }
});

test('runnerRpc sends the token in the control header only when given one', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { seen.push({ h: req.headers[RUNNER_CONTROL_HEADER] ?? null, m: JSON.parse(b).method }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { atSlot: 1 } })); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    await runnerRpc(port, 'frontier_status');
    await runnerRpc(port, 'frontier_setScale', [30], 'tok-1');
    await runnerRpc(port, 'requestAirdrop', ['x', 1], null);
    assert.deepEqual(seen, [{ h: null, m: 'frontier_status' }, { h: 'tok-1', m: 'frontier_setScale' }, { h: null, m: 'requestAirdrop' }]);
  } finally { server.close(); }
});

test('the launcher hands the token to the runner process only (env, not argv), and uses it for its own setScale', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /const control = makeRunnerControl\(\);/);
  assert.match(src, /const env = name === 'runner' \? \{ \.\.\.process\.env, \[RUNNER_CONTROL_ENV\]: control \} : \{ \.\.\.process\.env, \[RUNNER_CONTROL_ENV\]: '' \};/);
  // side processes (the AI residents) never get it
  assert.match(src, /launchSide = [\s\S]{0,400}env: \{ \.\.\.process\.env, \[RUNNER_CONTROL_ENV\]: '' \}/);
  assert.match(src, /runnerRpc\(rpc, 'frontier_setScale', \[scale\], control\)/);
  assert.match(src, /runnerRpc\(rpc, 'frontier_setScale', \[1\], control\)/);
  assert.match(src, /prepareWorld\(\{ scale: c\.prepareScale, dir, rpc, herald, meta, stopping: \(\) => stopping !== null, limit, control \}\)/);
  // never on a command line
  assert.doesNotMatch(src, /'--control-token'|--frontier-control/);
});
