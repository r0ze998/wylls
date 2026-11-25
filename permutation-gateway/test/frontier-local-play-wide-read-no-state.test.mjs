// pr227-post-check (owner 2026-11-25 09:33, Q-W13T-3): the read the loopback MCP server makes as a POST —
// `POST /f/local-play/act/context` with the schema `frontier-local-play-act-wide-read-v1` — CHANGES NO STATE.
// Pinned here on the relay itself (createLocalPlayAct) and over its HTTP listener (serveLocalPlayRelay):
//   - the runner is asked ONE thing per request, `getMultipleAccounts` with exactly the asked addresses; never a
//     send, an airdrop, a blockhash, a signature status or anything else;
//   - the same request twice gives the same answer;
//   - the relay's replay barrier (the 256 unsettled-acts cap, `stats().history`) stays at 0, also after more reads
//     than the cap holds;
//   - a resident relay's one-action-per-turn lease is never claimed, and its lease directory stays empty;
//   - the route's other answers are the same before and after.
// Key-free: no key is made or used, nothing is signed, no chain. The runner is a stand-in that records every call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalPlayAct, LOCAL_ACT_WIDE_READ_SCHEMA, LOCAL_ACT_WIDE_READ_MAX, LOCAL_ACT_CONTEXT_SCHEMA, LOCAL_ACT_MAX_HISTORY } from '../src/frontier/local-play-act.mjs';
import { createLocalPlayRelay, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { serveLocalPlayRelay } from '../src/frontier/local-play-relay-server.mjs';
import { createResidentTurns } from '../src/frontier/resident-turns.mjs';
import { seasonPda, seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';

const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', OTHER_PROGRAM = '11111111111111111111111111111111';
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = '4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn';
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11');
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: WALLET, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
// three addresses: a program account, an absent one, and one another program owns (answered as absent)
const ADDRS = [A.of('Holding', { p: 3, q: -2, site: 4 }), A.of('Holding', { p: 3, q: -2, site: 5 }), A.of('Citizen', { wallet: WALLET })];
const ROWS = new Map([
  [ADDRS[0], { owner: LOCAL_PLAY_PROGRAM, executable: false, lamports: 1, data: [Buffer.from('PSF1HOLD-test').toString('base64'), 'base64'] }],
  [ADDRS[1], null],
  [ADDRS[2], { owner: OTHER_PROGRAM, executable: false, lamports: 1, data: [Buffer.from('not ours').toString('base64'), 'base64'] }],
]);
const WANT = { schema: LOCAL_ACT_WIDE_READ_SCHEMA, context_slot: '91', accounts: [{ data_b64: Buffer.from('PSF1HOLD-test').toString('base64') }, null, null] };
const READ = { schema: LOCAL_ACT_WIDE_READ_SCHEMA, addresses: ADDRS };

/** A relay over a recording stand-in runner; with `turns`, a resident's relay (one action per turn). */
function relay({ turns = null } = {}) {
  const calls = [];
  const act = createLocalPlayAct({ cfg, turns, rpc: async (method, params) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => ROWS.get(a) ?? null) } };
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
    return { error: { code: -1 } };
  } });
  return { act, calls };
}
const ONE_READ = { method: 'getMultipleAccounts', params: [ADDRS, { encoding: 'base64', commitment: 'confirmed' }] };

test('the wide read asks the runner one getMultipleAccounts and nothing else; twice gives the same answer; the act cap is untouched', async () => {
  const h = relay();
  assert.deepEqual(h.act.stats(), { history: 0 });
  const first = await h.act.context(READ), second = await h.act.context(READ);
  assert.deepEqual(first, WANT); assert.deepEqual(second, first, 'the same request twice: the same answer');
  assert.deepEqual(h.calls, [ONE_READ, ONE_READ], 'one runner call per read, a read, with exactly the asked addresses');
  assert.deepEqual(h.act.stats(), { history: 0 }, 'nothing entered the replay barrier (the 256 unsettled-acts cap)');
  // more reads than the cap holds: still answered, still nothing kept, never a retirement question (isBlockhashValid)
  for (let i = 0; i < LOCAL_ACT_MAX_HISTORY + 44; i++) assert.deepEqual(await h.act.context(READ), WANT);
  assert.equal(h.calls.length, LOCAL_ACT_MAX_HISTORY + 46);
  assert.deepEqual([...new Set(h.calls.map(c => c.method))], ['getMultipleAccounts']);
  assert.deepEqual(h.act.stats(), { history: 0 });
  // the route's other answer is what a relay that never made a wide read gives
  const fresh = relay();
  assert.deepEqual(await h.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA }), await fresh.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA }));
  // a refused read (too many addresses, none, a non-address) asks the runner nothing
  const before = h.calls.length;
  for (const addresses of [[], Array(LOCAL_ACT_WIDE_READ_MAX + 1).fill(ADDRS[0]), ['x'], 'x']) await assert.rejects(h.act.context({ schema: LOCAL_ACT_WIDE_READ_SCHEMA, addresses }), e => e.code === 'LocalActInvalid');
  assert.equal(h.calls.length, before);
});

test('a resident relay: the wide read claims no turn (the lease is never asked, its directory stays empty)', async () => {
  // a lease stand-in that fails the test when anything claims
  let claims = 0;
  const strict = relay({ turns: { claim() { claims++; throw new Error('a read must not claim a turn'); } } });
  assert.deepEqual(await strict.act.context(READ), WANT); assert.deepEqual(await strict.act.context(READ), WANT);
  assert.equal(claims, 0); assert.deepEqual(strict.calls, [ONE_READ, ONE_READ], 'and the turn\'s bell is not even read');
  // the real file lease (resident-turns.mjs, what `--resident-turns <dir>` makes): no file is written by reads
  const dir = mkdtempSync(path.join(tmpdir(), 'wide-read-no-state-'));
  try {
    const real = relay({ turns: createResidentTurns({ dir }) });
    for (let i = 0; i < 20; i++) assert.deepEqual(await real.act.context(READ), WANT);
    assert.deepEqual(readdirSync(dir), [], 'no lease file, no directory');
    assert.deepEqual(real.act.stats(), { history: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('over the relay\'s HTTP listener: the POST read twice gives the same bytes and the runner saw only reads', async () => {
  const h = relay();
  const depart = createLocalPlayRelay({ cfg, prepare: { prepare: async () => ({ status: 'blocked' }), close() {} }, rpc: async (method, params) => { h.calls.push({ method, params }); return { error: { code: -1 } }; } });
  const s = await serveLocalPlayRelay(depart, 0, { act: h.act });
  try {
    const post = async b => { const r = await fetch(`http://127.0.0.1:${s.port}/f/local-play/act/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, r.headers.get('cache-control'), await r.text()]; };
    const info = async () => (await fetch(`http://127.0.0.1:${s.port}/f/local-play/info`)).text();
    const infoBefore = await info();
    const a = await post(READ), b = await post(READ);
    assert.deepEqual(a, [200, 'no-store', JSON.stringify(WANT)]); assert.deepEqual(b, a);
    assert.deepEqual(h.calls, [ONE_READ, ONE_READ]);
    assert.equal(await info(), infoBefore, 'the relay\'s public pins are the same');
    assert.deepEqual(h.act.stats(), { history: 0 });
  } finally { await s.close(); }
});

test('the source: the wide-read answer names no barrier, no turn gate and no send (it is the code between its schema test and the next answer)', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-act.mjs', import.meta.url), 'utf8');
  const from = src.indexOf("if (exact(body, ['schema', 'addresses']) && body.schema === LOCAL_ACT_WIDE_READ_SCHEMA) {"), to = src.indexOf('// (rent-live-rest: the runner\'s rent of one Holding', from);
  assert.ok(from > 0 && to > from && src.indexOf('body.schema === LOCAL_ACT_WIDE_READ_SCHEMA', from + 80) < 0, 'one such answer');
  const block = src.slice(from, to);
  assert.deepEqual([...block.matchAll(/ask\('([A-Za-z]+)'/g)].map(m => m[1]), ['getMultipleAccounts']);
  assert.doesNotMatch(block, /\bseen\b|\bgate\b|\bturns\b|sendTransaction|requestAirdrop|writeFile|\.claim\(|\.add\(|\.set\(/);
  // and the relay's listener keeps nothing per request: no counter, limiter or log of its own
  const server = readFileSync(new URL('../src/frontier/local-play-relay-server.mjs', import.meta.url), 'utf8');
  const listen = server.slice(server.indexOf('const server = http.createServer(async (req, res) => {'), server.indexOf('return new Promise((resolve, reject) => {\n    server.once(\'error\', reject);'));
  assert.ok(listen.length > 500);
  assert.doesNotMatch(listen, /writeFile|appendFile|\+\+|\.set\(|\.add\(|console\./);
});
