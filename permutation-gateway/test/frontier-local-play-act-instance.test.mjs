// The context route's read-only instance answer (src/frontier/local-play-act.mjs `LOCAL_ACT_INSTANCE_SCHEMA`), next to
// the unchanged v1 context answer.
//
// THIS FILE MAKES NO KEY and runs under the no-key guard:
//   node --import ./screens/codex/no-key-node.mjs --test ./test/frontier-local-play-act-instance.test.mjs
// The relay's wallet is a fixed public address; a stub RPC answers. One loopback listener on a free port for the HTTP
// part; no runner, chain, world, key or signature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalPlayAct, LocalActError, LOCAL_ACT_CONTEXT_SCHEMA, LOCAL_ACT_INSTANCE_SCHEMA, LOCAL_ACT_ROUTES, LOCAL_ACT_PRESEND_REFUSALS } from '../src/frontier/local-play-act.mjs';
import { createLocalPlayRelay, LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { serveLocalPlayRelay } from '../src/frontier/local-play-relay-server.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode } from '../client/src/base58.mjs';

const ME = 'BbPGAbHDvV5U43zQ5E8FmSnEzZ7r2vwWAZWTNAPTTSUT';
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], HASH = encode(new Uint8Array(32).fill(7));
const INSTANCE = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: ME, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
const good = (over = {}) => ({ result: { context: { slot: 92, apiVersion: 'x', instance: INSTANCE, ...over }, value: [] } });
/** The flow over a stub RPC: `answer(method, params)` is what the runner says; `calls` what was asked. */
function flow({ answer = () => good(), runnerInstance = INSTANCE } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
    return answer(method, params);
  };
  const act = createLocalPlayAct(runnerInstance === null ? { cfg, rpc } : { cfg, rpc, runnerInstance });
  return { act, calls };
}
const rejects = (p, code) => assert.rejects(p, e => e instanceof LocalActError && e.code === code, code);
const V1 = { wallet: ME, blockhash: { hash: HASH, last_valid_block_height: '300', context_slot: '90' } };

test('the v1 context request and answer are exactly as before, with or without a pinned instance', async () => {
  for (const runnerInstance of [INSTANCE, null]) {
    const h = flow({ runnerInstance });
    assert.deepEqual(await h.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA }), V1);
    assert.deepEqual(h.calls, [['getLatestBlockhash', [{ commitment: 'confirmed' }]]], 'one blockhash read, nothing else');
    await rejects(h.act.context({ schema: LOCAL_ACT_CONTEXT_SCHEMA, instance: true }), 'LocalActInvalid');
    await rejects(h.act.context({}), 'LocalActInvalid'); await rejects(h.act.context({ schema: 'x' }), 'LocalActInvalid');
    await rejects(h.act.context(null), 'LocalActInvalid');
    assert.equal(h.calls.length, 1, 'a refused request asks nothing');
  }
  // (the routes and the pre-send refusals the page relies on are unchanged)
  assert.deepEqual(LOCAL_ACT_ROUTES, { context: 'POST /f/local-play/act/context', submit: 'POST /f/local-play/act/submit', status: 'POST /f/local-play/act/status' });
  assert.ok(!LOCAL_ACT_PRESEND_REFUSALS.includes('LocalActNoInstance'));
  assert.equal(LOCAL_ACT_INSTANCE_SCHEMA, 'frontier-local-play-act-instance-v1');
});

test('the instance answer: one empty-list status read; exactly {wallet, instance} when the runner states the pinned instance', async () => {
  const h = flow();
  const got = await h.act.context({ schema: LOCAL_ACT_INSTANCE_SCHEMA });
  assert.deepEqual(got, { wallet: ME, instance: INSTANCE });
  assert.deepEqual(Object.keys(got), ['wallet', 'instance']);
  assert.deepEqual(h.calls, [['getSignatureStatuses', [[]]]], 'no signature looked up, nothing sent, no blockhash');
});

test('no pinned instance: refused with its own code and nothing is asked (the pin is never assumed)', async () => {
  const h = flow({ runnerInstance: null });
  await rejects(h.act.context({ schema: LOCAL_ACT_INSTANCE_SCHEMA }), 'LocalActNoInstance');
  assert.deepEqual(h.calls, []);
  assert.equal(new LocalActError('LocalActNoInstance').status, 404);
});

test('a body with anything more than the schema is refused before any read', async () => {
  const h = flow();
  for (const b of [{ schema: LOCAL_ACT_INSTANCE_SCHEMA, wallet: ME }, { schema: LOCAL_ACT_INSTANCE_SCHEMA, instance: INSTANCE }, { schema: [LOCAL_ACT_INSTANCE_SCHEMA] }, { schema: LOCAL_ACT_INSTANCE_SCHEMA.toUpperCase() }, [LOCAL_ACT_INSTANCE_SCHEMA]]) {
    await rejects(h.act.context(b), 'LocalActInvalid');
  }
  assert.deepEqual(h.calls, []);
});

test('the runner\'s answer must be that very instance, an empty value and a safe slot: otherwise unavailable, the pin is not returned', async () => {
  const bad = [
    good({ instance: OTHER }), good({ instance: undefined }), good({ instance: INSTANCE.toUpperCase() }), good({ instance: '0'.repeat(64) }),
    good({ slot: -1 }), good({ slot: 1.5 }), good({ slot: Number.MAX_SAFE_INTEGER + 1 }), good({ slot: '92' }), good({ slot: undefined }),
    { result: { context: { slot: 92, instance: INSTANCE }, value: [null] } }, { result: { context: { slot: 92, instance: INSTANCE }, value: {} } },
    { result: { context: { slot: 92, instance: INSTANCE } } }, { result: { context: null, value: [] } }, { result: { value: [] } },
    { error: { code: -32602, message: 'x' } }, { ...good(), error: { code: -1 } }, null, undefined, 'x',
  ];
  for (const answer of bad) {
    const h = flow({ answer: () => answer });
    await rejects(h.act.context({ schema: LOCAL_ACT_INSTANCE_SCHEMA }), 'LocalActRpcUnavailable');
    assert.equal(h.calls.length, 1);
  }
  const thrown = flow({ answer: () => { throw new Error('down'); } });
  await rejects(thrown.act.context({ schema: LOCAL_ACT_INSTANCE_SCHEMA }), 'LocalActRpcUnavailable');
});

test('a closing relay answers nothing: closed before, or while the runner was asked', async () => {
  const a = flow(); a.act.close();
  await rejects(a.act.context({ schema: LOCAL_ACT_INSTANCE_SCHEMA }), 'LocalActClosed'); assert.deepEqual(a.calls, []);
  let release; const held = new Promise(r => { release = r; });
  const b = flow({ answer: async () => { await held; return good(); } });
  const asked = b.act.context({ schema: LOCAL_ACT_INSTANCE_SCHEMA });
  await new Promise(r => setImmediate(r)); b.act.close(); release();
  await rejects(asked, 'LocalActClosed');
});

test('over HTTP: no economy routes → 404; no pin → 404 LocalActNoInstance; pinned → 200 {wallet, instance}; v1 unchanged beside it', async () => {
  const depart = () => createLocalPlayRelay({ cfg, prepare: { prepare: async () => ({ status: 'blocked' }), close() {} } });
  const call = async (s, b) => { const r = await fetch(`http://127.0.0.1:${s.port}/f/local-play/act/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return [r.status, await r.json()]; };
  const bare = await serveLocalPlayRelay(depart(), 0);
  try { assert.equal((await call(bare, { schema: LOCAL_ACT_INSTANCE_SCHEMA }))[0], 404); } finally { await bare.close(); }
  const none = flow({ runnerInstance: null }), s1 = await serveLocalPlayRelay(depart(), 0, { act: none.act });
  try {
    const [st, v] = await call(s1, { schema: LOCAL_ACT_INSTANCE_SCHEMA }); assert.deepEqual([st, v.code], [404, 'LocalActNoInstance']);
    assert.deepEqual(await call(s1, { schema: LOCAL_ACT_CONTEXT_SCHEMA }), [200, V1]);
  } finally { await s1.close(); }
  const h = flow(), s2 = await serveLocalPlayRelay(depart(), 0, { act: h.act });
  try {
    assert.deepEqual(await call(s2, { schema: LOCAL_ACT_INSTANCE_SCHEMA }), [200, { wallet: ME, instance: INSTANCE }]);
    assert.deepEqual(await call(s2, { schema: LOCAL_ACT_CONTEXT_SCHEMA }), [200, V1]);
    assert.deepEqual((await call(s2, { schema: LOCAL_ACT_INSTANCE_SCHEMA, more: 1 })).map((x, i) => (i ? x.code : x)), [400, 'LocalActInvalid']);
    assert.deepEqual(h.calls.map(c => c[0]), ['getSignatureStatuses', 'getLatestBlockhash'], 'nothing else was asked of the runner');
  } finally { await s2.close(); }
  const other = flow({ answer: () => good({ instance: OTHER }) }), s3 = await serveLocalPlayRelay(depart(), 0, { act: other.act });
  try { assert.deepEqual((await call(s3, { schema: LOCAL_ACT_INSTANCE_SCHEMA })).map((x, i) => (i ? x.code : x)), [503, 'LocalActRpcUnavailable']); } finally { await s3.close(); }
});

test('the v1 lines of the context answer are the same text as before', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-act.mjs', import.meta.url), 'utf8');
  for (const line of [
    "      check(exact(body, ['schema']) && body.schema === LOCAL_ACT_CONTEXT_SCHEMA);",
    "      const r = await ask('getLatestBlockhash', [{ commitment: 'confirmed' }]);",
    "      return { wallet: pins.wallet, blockhash: { hash: v.blockhash, last_valid_block_height: String(v.lastValidBlockHeight), context_slot: String(slot) } };",
  ]) assert.equal(src.split(line).length - 1, 1, line.trim());
  assert.equal(src.split("ask('getSignatureStatuses', [[]])").length - 1, 1, 'one empty-list read');
});
