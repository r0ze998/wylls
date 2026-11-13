// THE TEST FORM CANNOT BE REACHED FROM AN ORDINARY START. Two small hooks exist for test entries on the test port
// range — `localPlayRelayConfigProblems(cfg, {testRpcOk})` (local-play-relay.mjs) and
// `createLocalPlayAct({…, test: {rpcOk, sendGuard}})` (local-play-act.mjs). This file shows, with negatives, that:
//   - without them nothing differs: the ordinary port range and its refusals are as they were;
//   - the relay's own listener (its command line) and the launcher (its configuration and its HTTP routes) have no
//     word for them and build the economy relay without them;
//   - no request body can carry them: the economy routes take exactly their fields.
// Pure: no key, no process, no network. It runs in the canonical checkout as well as in the isolated copy (it names
// no test entry's file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localPlayRelayConfigProblems, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { createLocalPlayAct, LocalActError, LOCAL_ACT_CONTEXT_SCHEMA, LOCAL_ACT_STATUS_SCHEMA, LOCAL_ACT_SUBMIT_SCHEMA } from '../src/frontier/local-play-act.mjs';
import { actFromArgs, parseArgs as relayArgs, ECONOMY_MODE } from '../src/frontier/local-play-relay-server.mjs';
import { WORLD_POST_ROUTES, WORLD_GET_ROUTES, USAGE } from '../src/frontier/local-play-launcher.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';

const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], WALLET = seasonPda(LOCAL_PLAY_PROGRAM, 12)[0], INSTANCE = 'ab'.repeat(32);
const cfg = rpc => ({ localPlay: true, rpc, program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' });
const ORDINARY = 'http://127.0.0.1:41964', TEST = 'http://127.0.0.1:47001';
const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('WITHOUT the option the relay\'s configuration check is as it always was: 41000-41999 except 41970, loopback http only — and a test-range RPC is refused', () => {
  assert.deepEqual(localPlayRelayConfigProblems(cfg(ORDINARY)), []);
  for (const o of [undefined, {}, { testRpcOk: null }]) assert.deepEqual(localPlayRelayConfigProblems(cfg(ORDINARY), o), []);
  for (const rpc of [TEST, 'http://127.0.0.1:47999', 'http://127.0.0.1:40999', 'http://127.0.0.1:42000', 'http://127.0.0.1:41970', 'http://127.0.0.1:8899', 'https://127.0.0.1:41964', 'http://localhost:41964', 'http://10.0.0.1:41964',
    'http://127.0.0.1:41964/x', 'https://api.mainnet-beta.solana.com', undefined])
    assert.ok(localPlayRelayConfigProblems(cfg(rpc)).some(p => /^rpc must be http:\/\/127\.0\.0\.1:PORT \(41000-41999, never 41970\)$/.test(p)), String(rpc));
});

test('WITH the option: the RPC must satisfy it AND must not be an ordinary one — a test relay never points at a launcher\'s world; anything that is not a function refuses', () => {
  const rpcOk = url => url === TEST;
  assert.deepEqual(localPlayRelayConfigProblems(cfg(TEST), { testRpcOk: rpcOk }), []);
  for (const rpc of [ORDINARY, 'http://127.0.0.1:47002', 'http://127.0.0.1:41970', 'https://api.mainnet-beta.solana.com', undefined]) assert.ok(localPlayRelayConfigProblems(cfg(rpc), { testRpcOk: rpcOk }).some(p => /test runner/.test(p)), String(rpc));
  // an option that would accept an ORDINARY port is still refused for it
  assert.ok(localPlayRelayConfigProblems(cfg(ORDINARY), { testRpcOk: () => true }).some(p => /test runner/.test(p)));
  for (const bad of [true, 'yes', 1, {}, []]) assert.ok(localPlayRelayConfigProblems(cfg(TEST), { testRpcOk: bad }).length > 0, String(bad));
  // every other field is checked as before, with or without it
  assert.ok(localPlayRelayConfigProblems({ ...cfg(TEST), rulesetHash: 'ab'.repeat(32) }, { testRpcOk: rpcOk }).some(p => /rulesetHash/.test(p)));
});

test('the economy relay: without `test` a test-range RPC is refused and the ordinary one is built as before; `test` needs both functions AND a pinned runner instance', () => {
  const t = { rpcOk: u => u === TEST, sendGuard: () => {} };
  assert.doesNotThrow(() => createLocalPlayAct({ cfg: cfg(ORDINARY) })); assert.doesNotThrow(() => createLocalPlayAct({ cfg: cfg(ORDINARY), runnerInstance: INSTANCE }));
  assert.throws(() => createLocalPlayAct({ cfg: cfg(TEST) }), /refused/); assert.throws(() => createLocalPlayAct({ cfg: cfg(TEST), runnerInstance: INSTANCE }), /refused/);
  assert.throws(() => createLocalPlayAct({ cfg: cfg(ORDINARY), runnerInstance: INSTANCE, test: t }), /refused/, 'a test relay over an ordinary RPC');
  assert.throws(() => createLocalPlayAct({ cfg: cfg(TEST), test: t }), /bad test form/, 'no pinned runner instance');
  for (const bad of [{}, { rpcOk: t.rpcOk }, { sendGuard: t.sendGuard }, { rpcOk: true, sendGuard: true }, 'x', 1, true]) assert.throws(() => createLocalPlayAct({ cfg: cfg(TEST), runnerInstance: INSTANCE, test: bad }), /bad test form/);
  assert.doesNotThrow(() => createLocalPlayAct({ cfg: cfg(TEST), runnerInstance: INSTANCE, test: t }));
});

test('NO REQUEST CAN CARRY IT: the economy routes take exactly their fields — a body with `test`, `testRpcOk`, `sendGuard`, `rpc` or `runnerInstance` is refused before anything is read or sent', async () => {
  const calls = [], act = createLocalPlayAct({ cfg: cfg(ORDINARY), runnerInstance: INSTANCE, rpc: async m => { calls.push(m); return { error: { code: -1 } }; } });
  const extra = [{ test: { rpcOk: 'x', sendGuard: 'y' } }, { testRpcOk: true }, { sendGuard: true }, { rpc: TEST }, { runnerInstance: 'cd'.repeat(32) }, { rpcOk: true }];
  for (const x of extra) {
    await assert.rejects(act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA, ...x }), e => e instanceof LocalActError && e.code === 'LocalActInvalid');
    await assert.rejects(act.status({ schema: LOCAL_ACT_STATUS_SCHEMA, signature: 'S', ...x }), e => e instanceof LocalActError && e.code === 'LocalActInvalid');
    await assert.rejects(act.submit({ schema: LOCAL_ACT_SUBMIT_SCHEMA, name: 'Harvest', subject: { holding: { p: 2, q: 0, site: 3 } }, fields: {}, transaction_b64: 'AAAA', ...x }), e => e instanceof LocalActError && e.code === 'LocalActInvalid');
  }
  assert.deepEqual(calls, [], 'the runner was asked nothing');
});

test('THE RELAY\'S OWN LISTENER: its command line has no word for the test form or a test-range RPC, and it builds the economy relay with exactly {cfg} or {cfg, runnerInstance}', () => {
  const seen = [], create = o => { seen.push(o); return {}; };
  assert.equal(actFromArgs({ cfg: cfg(ORDINARY), economy: false, runnerInstance: INSTANCE }, { create }), null);
  actFromArgs({ cfg: cfg(ORDINARY), economy: true }, { create }); actFromArgs({ cfg: cfg(ORDINARY), economy: true, runnerInstance: INSTANCE }, { create });
  // (whatever else a caller hands it — it is not passed on)
  actFromArgs({ cfg: cfg(ORDINARY), economy: true, runnerInstance: INSTANCE, test: { rpcOk: () => true, sendGuard: () => {} }, testRpcOk: () => true }, { create });
  assert.deepEqual(seen.map(o => Object.keys(o).sort()), [['cfg'], ['cfg', 'runnerInstance'], ['cfg', 'runnerInstance']]);
  const good = ['--local-play', '--listen-port', '41966', '--rpc', ORDINARY, '--program', LOCAL_PLAY_PROGRAM, '--season', SEASON, '--wallet', WALLET, '--ruleset-hash', LOCAL_PLAY_RULESET_HASH,
    '--prepare-bin', '/x/depart', '--cu-limit', '1000000', '--loaded-limit', '67108864'];
  assert.doesNotThrow(() => relayArgs([...good, '--economy', ECONOMY_MODE]));
  for (const more of [['--test', '1'], ['--test-rpc-ok', '1'], ['--test-rpc', TEST], ['--send-guard', '1'], ['--economy', 'test'], ['--economy', 'page-signed-v1-test']]) assert.throws(() => relayArgs([...good, ...more]), undefined, more.join(' '));
  // a test-range RPC on the command line: parsed or not, the configuration it gives is refused by the ordinary check
  let parsed = null; try { parsed = relayArgs(good.map(a => (a === ORDINARY ? TEST : a))); } catch { parsed = null; }
  if (parsed !== null) assert.ok(localPlayRelayConfigProblems(parsed.cfg).some(p => /41000-41999/.test(p)));
  const listener = src('../src/frontier/local-play-relay-server.mjs');
  assert.doesNotMatch(listener, /testRpcOk|sendGuard|rpcOk|test\s*:/, 'the listener\'s source names none of it');
});

test('THE LAUNCHER: its configuration, its usage text and its HTTP routes name none of it', () => {
  const launcher = src('../src/frontier/local-play-launcher.mjs');
  assert.doesNotMatch(launcher, /testRpcOk|sendGuard|rpcOk|createLocalPlayAct|test\s*:\s*\{/);
  assert.doesNotMatch(USAGE, /test-rpc|send-guard|47[0-9]{3}/);
  for (const r of [...WORLD_POST_ROUTES, ...WORLD_GET_ROUTES]) assert.doesNotMatch(String(r), /test|\/e\/|\/f\/wallet|\/f\/state|\/a\//, String(r));
  // the page's own code and the gateway's general server name none of it either
  for (const f of ['../src/frontier/server.mjs', '../src/frontier/app.mjs', '../../permutation-server/web/frontier/controller.mjs', '../../permutation-server/web/frontier/flocalplay-act.mjs'])
    assert.doesNotMatch(src(f), /testRpcOk|sendGuard|createTestLifetime|conquest-test-capability/, f);
});
