// The local-play submit-only Reveal route (src/frontier/local-play-reveal.mjs).
// The transaction is built by the browser builder (fexpedition-reveal.mjs)
// from a seal made with fixed test k/σ and signed by an in-memory test
// Ed25519 wallet (never printed or stored); the runner's RPC is a stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { encode } from '../client/src/base58.mjs';
import { seasonPda, withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey, traceWideDirections, encodeWideDirections }
  from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { sealWideWith } from '../../permutation-server/web/frontier/seal-wide.mjs';
import { QUICKNET } from '../../permutation-server/web/frontier/abi.mjs';
import { compileMessage } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { buildExpeditionReveal, revealMessage } from '../../permutation-server/web/frontier/fexpedition-reveal.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, LocalPlayError } from '../src/frontier/local-play-relay.mjs';
import { createLocalPlayReveal, REVEAL_SUBMIT_SCHEMA, REVEAL_STATUS_SCHEMA, MAX_REVEAL_HISTORY } from '../src/frontier/local-play-reveal.mjs';

const key = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { address: encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), privateKey };
};
const W = key(), OTHER = key();
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0];
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address,
  rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/bin', cuLimit: '1000000', loadedLimit: '1048576' };
const WORLD = worldIdOf(SEASON, LOCAL_PLAY_PROGRAM);
const HOST = canonicalOriginalHostRef({ world: WORLD, p: '128', q: '0', site: 1, gen: 2, seq: 0 });
const HOLDING = withSeed(SEASON, seedOf('Holding', { p: 128, q: 0, site: 1 }), LOCAL_PLAY_PROGRAM);
const DEST = canonicalWideProvinceKey({ world: WORLD, p: '129', q: '0' });
const route = (() => {
  for (let tile = 0; tile < 61; tile++) for (let d = 0; d < 6; d++) {
    const t = traceWideDirections({ world: WORLD, origin: { p: '128', q: '0', tile }, directions: [d] });
    if (t.endpoint.key === DEST) return { tile, d, destTile: t.endpoint.tile };
  }
  throw new Error('no step');
})();
const plain = { version: 2, host: HOST, arriveBell: 15, dest: DEST, destTile: route.destTile, stance: 1, retreatBps: 0,
  ...encodeWideDirections([route.d]), reserved: '00'.repeat(8) };
const sealed = sealWideWith({ plain, round: 30913812, publicKey: QUICKNET.publicKey, k: new Uint8Array(16).fill(0x11), sigma: new Uint8Array(16).fill(0x22) });
let hashSeq = 0;
function revealTx({ wallet = W, signer = W, blockhash, mutate } = {}) {
  const ix = buildExpeditionReveal({ program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: wallet.address, holding: HOLDING,
    transit: { slot: 0, faction: 0, host: HOST, arriveBell: 15, sealRoot: Buffer.from(sealed.sealRoot).toString('hex'), origin: { p: 128, q: 0, tile: route.tile } },
    destRegion: 5, targetI: 0, reveal: sealed.reveal, ctHash: sealed.ctHash });
  const bh = blockhash ?? encode(new Uint8Array(32).fill(++hashSeq));
  let message = revealMessage({ instruction: ix, wallet: wallet.address, recentBlockhash: bh, cuLimit: 400_000, loadedLimit: 1_867_776, heapFrame: 256 * 1024 });
  if (mutate) message = mutate(ix, bh);
  const signers = Array.isArray(signer) ? signer : [signer];
  return Buffer.concat([Buffer.from([signers.length]), ...signers.map(s => sign(null, message, s.privateKey)), message]).toString('base64');
}
function relay({ send = null, valid = true } = {}) {
  const calls = [];
  const r = createLocalPlayReveal({ cfg, rpc: async (method, params) => {
    calls.push(method);
    if (method === 'sendTransaction') {
      if (send) return send(params);
      const w = Buffer.from(params[0], 'base64');
      return { result: encode(w.subarray(1, 65)) };
    }
    if (method === 'isBlockhashValid') return { result: { value: typeof valid === 'function' ? valid(params[0]) : valid } };
    if (method === 'getSignatureStatuses') return { result: { value: [{ slot: 3, confirmationStatus: 'confirmed', err: null }] } };
    return { error: { code: -1 } };
  } });
  return { r, calls };
}
const body = tx => ({ schema: REVEAL_SUBMIT_SCHEMA, transaction_b64: tx });
const code = (p, want) => assert.rejects(p, e => e instanceof LocalPlayError && e.code === want);

test('the player\'s signed reveal is forwarded once; a replay is refused; status answers', async () => {
  const { r, calls } = harnessOk();
  const tx = revealTx();
  const out = await r.submit(body(tx));
  assert.equal(out.status, 'submitted');
  await code(r.submit(body(tx)), 'LocalPlayMessageUsed');
  assert.equal(calls.filter(m => m === 'sendTransaction').length, 1);
  assert.deepEqual(await r.status({ schema: REVEAL_STATUS_SCHEMA, signature: out.signature }), { signature: out.signature, status: 'confirmed', err: null, slot: 3 });
  await code(r.status({ schema: REVEAL_STATUS_SCHEMA, signature: encode(new Uint8Array(64).fill(1)) }), 'LocalPlayUnknownSignature');
  assert.deepEqual(Object.keys(r.stats()), ['history'], 'counts only: no bytes kept');
});
function harnessOk() { return relay(); }

test('anything but the pinned wallet\'s single exact reveal is refused before sending', async () => {
  const { r, calls } = relay();
  // signed by another key for the pinned wallet's message
  await code(r.submit(body(revealTx({ signer: OTHER }))), 'LocalPlayBadSignature');
  // another wallet's reveal
  await code(r.submit(body(revealTx({ wallet: OTHER, signer: OTHER }))), 'LocalPlayBadTransaction');
  // reshaped messages (re-compiled from the real instruction)
  const recompile = f => (ix, bh) => compileMessage({ feePayer: W.address, recentBlockhash: bh, instructions: f(ix) });
  const budget = (tag, v, size) => { const d = new Uint8Array(size + 1); d[0] = tag; const dv = new DataView(d.buffer); size === 8 ? dv.setBigUint64(1, BigInt(v), true) : dv.setUint32(1, v, true);
    return { programId: 'ComputeBudget111111111111111111111111111111', keys: [], data: d }; };
  const base = ix => [budget(2, 400_000, 4), budget(3, 0, 8), budget(4, 1_867_776, 4), budget(1, 256 * 1024, 4), { programId: ix.programId, keys: ix.keys, data: ix.data }];
  const keysAt = (i, f) => ix => [...base(ix).slice(0, 4), { ...base(ix)[4], keys: ix.keys.map((k, j) => j === i ? f(k, ix.keys) : k) }];
  const cases = {
    'missing heap': ix => [...base(ix).slice(0, 3), base(ix)[4]],
    'wrong heap': ix => [...base(ix).slice(0, 3), budget(1, 32768, 4), base(ix)[4]],
    'wrong heap tag': ix => [...base(ix).slice(0, 3), budget(2, 256 * 1024, 4), base(ix)[4]],
    'duplicate heap': ix => [...base(ix).slice(0, 4), base(ix)[3], base(ix)[4]],
    'misordered heap': ix => [base(ix)[3], ...base(ix).slice(0, 3), base(ix)[4]],
    'heap with accounts': ix => [...base(ix).slice(0, 3), { ...base(ix)[3], keys: [ix.keys[0]] }, base(ix)[4]],
    'nonzero price': ix => [budget(2, 400_000, 4), budget(3, 7, 8), budget(4, 1_867_776, 4), base(ix)[3], base(ix)[4]],
    'no budget': ix => [base(ix)[4]],
    'extra instruction': ix => [...base(ix), base(ix)[4]],
    'another program': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], programId: encode(new Uint8Array(32).fill(0x12)) }],
    'not a reveal head': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], data: Uint8Array.from(ix.data, (b, i) => i === 3 ? 0 : b) }],
    'truncated data': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], data: ix.data.slice(0, 241) }],
    'another season': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], keys: ix.keys.map((k, i) => i === 1 ? { ...k, pubkey: encode(new Uint8Array(32).fill(3)) } : k) }],
    'season writable': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], keys: ix.keys.map((k, i) => i === 1 ? { ...k, isWritable: true } : k) }],
    'extra account': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], keys: [...ix.keys, ...ix.keys.slice(2, 6).map(k => ({ ...k, pubkey: encode(new Uint8Array(32).fill(0x66)) }))] }],
    ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map(i => [`account ${i} writable`, keysAt(i, k => ({ ...k, isWritable: true }))])),
    // (this route has no path province: one is appended, writable)
    'path province writable': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], keys: [...ix.keys, { pubkey: encode(new Uint8Array(32).fill(0x69)), isSigner: false, isWritable: true }] }],
    'arrival day read-only': keysAt(9, k => ({ ...k, isWritable: false })),
    'a non-target slot writable': keysAt(11, k => ({ ...k, isWritable: true })),
    'the target slot read-only': keysAt(10, k => ({ ...k, isWritable: false })),
    'another ix sysvar': keysAt(14, k => ({ ...k, pubkey: encode(new Uint8Array(32).fill(0x77)) })),
    'another system program': keysAt(15, k => ({ ...k, pubkey: encode(new Uint8Array(32).fill(0x78)) })),
    'a duplicated account': keysAt(5, (k, keys) => ({ ...k, pubkey: keys[4].pubkey })),
    'another beneficiary': ix => [...base(ix).slice(0, 4), { ...base(ix)[4], data: Uint8Array.from(ix.data, (b, i) => i === 241 ? b ^ 1 : b) }],
  };
  for (const [name, f] of Object.entries(cases)) {
    await assert.rejects(r.submit(body(revealTx({ mutate: recompile(f) }))), e => e.code === 'LocalPlayBadTransaction', name);
  }
  // a second signer
  const two = (ix, bh) => compileMessage({ feePayer: W.address, recentBlockhash: bh, instructions: [...base(ix).slice(0, 4),
    { ...base(ix)[4], keys: ix.keys.map((k, i) => i === 2 ? { ...k, pubkey: OTHER.address, isSigner: true } : k) }] });
  await code(r.submit(body(revealTx({ mutate: two, signer: [W, OTHER] }))), 'LocalPlayBadTransaction');
  await code(r.submit({ schema: REVEAL_SUBMIT_SCHEMA, transaction_b64: 'not base64!' }), 'LocalPlayBadTransaction');
  await code(r.submit({ ...body(revealTx()), extra: 1 }), 'LocalPlayInvalidRequest');
  assert.equal(calls.length, 0, 'nothing reached the runner');
});

test('an unknown outcome is never resent; a runner refusal is reported and consumes the digest', async () => {
  const lost = relay({ send: () => { throw new LocalPlayError('LocalPlayRpcUnavailable'); } });
  const tx = revealTx();
  const out = await lost.r.submit(body(tx));
  assert.equal(out.status, 'unknown');
  assert.ok(out.signature);
  await code(lost.r.submit(body(tx)), 'LocalPlayMessageUsed');
  assert.equal((await lost.r.status({ schema: REVEAL_STATUS_SCHEMA, signature: out.signature })).status, 'confirmed', 'looked up by status');
  const refused = relay({ send: () => ({ error: { code: -32002, message: 'WindowClosed' } }) });
  const tx2 = revealTx();
  await assert.rejects(refused.r.submit(body(tx2)), e => e.code === 'LocalPlaySendRefused' && e.detail.code === -32002);
  await code(refused.r.submit(body(tx2)), 'LocalPlayMessageUsed');
});

test('the replay barrier is retired only when the runner says the blockhash expired, else fails closed', async () => {
  let expired = false;
  const { r } = relay({ valid: () => !expired });
  for (let i = 0; i < MAX_REVEAL_HISTORY; i++) await r.submit(body(revealTx()));
  await code(r.submit(body(revealTx())), 'LocalPlayBusy');
  assert.equal(r.stats().history, MAX_REVEAL_HISTORY);
  expired = true; // the runner now reports those blockhashes invalid
  assert.equal((await r.submit(body(revealTx()))).status, 'submitted');
  assert.equal(r.stats().history, 1);
});

test('a duplicate is refused while the first sendTransaction is still unresolved', async () => {
  let release;
  const pending = new Promise(res => { release = res; });
  const sends = [];
  const r = createLocalPlayReveal({ cfg, rpc: async (method, params) => {
    if (method === 'sendTransaction') { sends.push(params[0]); await pending; return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    return { error: { code: -1 } };
  } });
  const tx = revealTx();
  const first = r.submit(body(tx)); // its sendTransaction is now waiting
  await new Promise(res => setImmediate(res));
  assert.equal(sends.length, 1, 'the first send is in flight');
  await code(r.submit(body(tx)), 'LocalPlayMessageUsed'); // refused before the first resolves
  assert.equal(sends.length, 1, 'no second send');
  release();
  assert.equal((await first).status, 'submitted');
  assert.equal(sends.length, 1);
});

test('a failed or malformed retirement answer keeps every tombstone (fail closed)', async () => {
  const answers = [
    () => { throw new LocalPlayError('LocalPlayRpcUnavailable'); },
    () => ({ error: { code: -32601, message: 'no such method' } }),
    () => ({ result: {} }),
    () => ({ result: { value: 'false' } }),
    () => ({ result: { value: 0 } }),
    () => ({}),
    // contradictory: an error beside a result that would retire
    () => ({ error: { code: -1 }, result: { value: false } }),
  ];
  for (const answer of answers) {
    const calls = [];
    const r = createLocalPlayReveal({ cfg, rpc: async (method, params) => {
      calls.push(method);
      if (method === 'sendTransaction') return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) };
      if (method === 'isBlockhashValid') return answer();
      return { error: { code: -1 } };
    } });
    const first = revealTx();
    for (let i = 0; i < MAX_REVEAL_HISTORY; i++) await r.submit(body(i === 0 ? first : revealTx()));
    await code(r.submit(body(revealTx())), 'LocalPlayBusy');
    assert.equal(r.stats().history, MAX_REVEAL_HISTORY, String(answer));
    // the tombstones still refuse their digests
    await code(r.submit(body(first)), 'LocalPlayMessageUsed');
    assert.equal(calls.filter(m => m === 'sendTransaction').length, MAX_REVEAL_HISTORY);
  }
});

// ------------------------------------------------------------------ the read-only context route
import { REVEAL_CONTEXT_SCHEMA, REVEAL_ROUTES, MAX_CONTEXT_ACCOUNTS, MAX_CONTEXT_ACCOUNT_BYTES } from '../src/frontier/local-play-reveal.mjs';
import { createLocalPlayRelay } from '../src/frontier/local-play-relay.mjs';
import { serveLocalPlayRelay } from '../src/frontier/local-play-relay-server.mjs';

const ADDR = n => encode(new Uint8Array(32).fill(n));
const HASH = ADDR(0x55);
/** A reveal relay whose runner answers `getMultipleAccounts` from `world` (address → {owner, bytes}) at `slot`, then a blockhash at `hashSlot`. */
function reader({ world = new Map(), slot = 700, hashSlot = 701, accounts = null, blockhash = null } = {}) {
  const calls = [];
  const r = createLocalPlayReveal({ cfg, rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === 'getMultipleAccounts') {
      if (accounts) return accounts(params);
      return { result: { context: { slot }, value: params[0].map(a => { const x = world.get(a); return x ? { owner: x.owner, lamports: 1, executable: false, data: [Buffer.from(x.bytes).toString('base64'), 'base64'] } : null; }) } };
    }
    if (method === 'getLatestBlockhash') return blockhash ? blockhash(params) : { result: { context: { slot: hashSlot }, value: { blockhash: HASH, lastValidBlockHeight: 950 } } };
    return { error: { code: -1 } };
  } });
  return { r, calls };
}
const refusedAs = (p, want) => assert.rejects(p, e => e instanceof LocalPlayError && e.code === want);
const ask = addresses => ({ schema: REVEAL_CONTEXT_SCHEMA, addresses });

test('context: the named accounts at one confirmed slot and a blockhash no older than it; a read, nothing kept or sent', async () => {
  const a = ADDR(1), b = ADDR(2), c = ADDR(3);
  const world = new Map([[a, { owner: LOCAL_PLAY_PROGRAM, bytes: Uint8Array.of(1, 2, 3) }], [c, { owner: ADDR(9), bytes: new Uint8Array(0) }]]);
  const { r, calls } = reader({ world });
  const out = await r.context(ask([a, b, c]));
  assert.deepEqual(out, { context_slot: '700', blockhash: { hash: HASH, last_valid_block_height: '950', context_slot: '701' },
    accounts: [{ address: a, owner: LOCAL_PLAY_PROGRAM, data_b64: 'AQID' }, { address: b, owner: null, data_b64: null }, { address: c, owner: ADDR(9), data_b64: '' }] });
  assert.deepEqual(calls.map(x => x.method), ['getMultipleAccounts', 'getLatestBlockhash'], 'two reads; nothing is sent');
  assert.deepEqual(calls[0].params, [[a, b, c], { encoding: 'base64', commitment: 'confirmed' }]);
  assert.deepEqual(calls[1].params, [{ commitment: 'confirmed', minContextSlot: 700 }], 'the blockhash is asked for at no older a slot than the accounts');
  // a second identical read is simply another read (no replay barrier on reads)
  assert.deepEqual(await r.context(ask([a, b, c])), out); assert.equal(calls.length, 4);
});

test('context: only a closed request of 1..16 distinct canonical addresses is read; anything else reaches no RPC', async () => {
  const { r, calls } = reader();
  const many = Array.from({ length: MAX_CONTEXT_ACCOUNTS + 1 }, (_, i) => ADDR(i + 1));
  assert.equal(MAX_CONTEXT_ACCOUNTS, 16);
  for (const body of [null, [], 'x', {}, { schema: REVEAL_CONTEXT_SCHEMA }, { addresses: [ADDR(1)] }, ask([]), ask(many), ask('x'), ask([ADDR(1), ADDR(1)]), ask([ADDR(1), 'x']), ask([ADDR(1), 7]), ask([null]),
    ask([ADDR(1) + '11']), ask([ADDR(1).slice(0, 20)]), ask([' ' + ADDR(1)]), ask(['0' + ADDR(1).slice(1)]), { ...ask([ADDR(1)]), commitment: 'processed' }, { ...ask([ADDR(1)]), rpc: 'http://127.0.0.1:1' },
    { schema: 'frontier-local-play-reveal-submit-v1', addresses: [ADDR(1)] }, { schema: REVEAL_STATUS_SCHEMA, addresses: [ADDR(1)] }]) {
    await refusedAs(r.context(body), 'LocalPlayInvalidRequest');
  }
  assert.equal(calls.length, 0);
  assert.equal((await r.context(ask(many.slice(0, 16)))).accounts.length, 16, 'sixteen is the most');
});

test('context: an answer that is not one coherent read is no answer (slot order, shape, size), never a partial one', async () => {
  const a = ADDR(1), row = bytes => ({ owner: LOCAL_PLAY_PROGRAM, lamports: 1, executable: false, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
  const value = v => () => ({ result: { context: { slot: 700 }, value: v } });
  // the blockhash's slot older than the accounts' (the runner ignored minContextSlot), or not a slot at all
  for (const hashSlot of [699, 0, -1, 700.5, '701', null]) await refusedAs(reader({ hashSlot }).r.context(ask([a])), 'LocalPlayRpcUnavailable');
  assert.equal((await reader({ hashSlot: 700 }).r.context(ask([a]))).blockhash.context_slot, '700', 'the same slot is not older');
  for (const blockhash of [() => ({ error: { code: -32016, message: 'Minimum context slot has not been reached' } }), () => { throw new Error('socket'); }, () => ({ result: { context: { slot: 701 }, value: { blockhash: 'x', lastValidBlockHeight: 9 } } }),
    () => ({ result: { context: { slot: 701 }, value: { blockhash: HASH, lastValidBlockHeight: -1 } } }), () => ({ result: { context: { slot: 701 }, value: { blockhash: HASH, lastValidBlockHeight: '9' } } }), () => ({})]) {
    await refusedAs(reader({ blockhash }).r.context(ask([a])), 'LocalPlayRpcUnavailable');
  }
  // the accounts' answer
  for (const accounts of [() => ({ error: { code: -1 } }), () => { throw new Error('socket'); }, () => ({ result: { context: { slot: -1 }, value: [null] } }), () => ({ result: { context: { slot: '700' }, value: [null] } }),
    () => ({ result: { context: {}, value: [null] } }), value([]), value([null, null]), value('x'), value([{ ...row([1]), owner: 'x' }]), value([{ ...row([1]), owner: 7 }]), value([{ ...row([1]), data: ['AQ', 'base64'] }]),
    value([{ ...row([1]), data: ['AQ==', 'base58'] }]), value([{ ...row([1]), data: 'AQ==' }]), value([{}]), value([7])]) {
    const h = reader({ accounts });
    await refusedAs(h.r.context(ask([a])), 'LocalPlayRpcUnavailable');
    assert.ok(!h.calls.some(x => x.method === 'getLatestBlockhash'), 'no blockhash is asked for over a bad read');
  }
  // the size boundary: an account of exactly the limit is answered, one byte more is not
  assert.equal(MAX_CONTEXT_ACCOUNT_BYTES, 8192);
  const at = await reader({ accounts: value([row(new Uint8Array(MAX_CONTEXT_ACCOUNT_BYTES).fill(7))]) }).r.context(ask([a]));
  assert.equal(Buffer.from(at.accounts[0].data_b64, 'base64').length, MAX_CONTEXT_ACCOUNT_BYTES);
  await refusedAs(reader({ accounts: value([row(new Uint8Array(MAX_CONTEXT_ACCOUNT_BYTES + 1))]) }).r.context(ask([a])), 'LocalPlayRpcUnavailable');
  // the largest read a reveal makes (fourteen accounts: the archive, the Province, the Season, the village, …) fits
  const sizes = [336, 1280, 4864, 0, 0, 2048, 40, 288, 288, 288, 288, 144, 6144, 128], addresses = sizes.map((_, i) => ADDR(i + 1));
  const whole = await reader({ world: new Map(addresses.map((x, i) => [x, { owner: LOCAL_PLAY_PROGRAM, bytes: new Uint8Array(sizes[i]).fill(1) }])) }).r.context(ask(addresses));
  assert.ok(JSON.stringify(whole).length < 64 * 1024, 'and its answer is under the page\'s 64 KiB limit');
});

test('context over HTTP: dispatched only when the reveal routes are served; the body limit and refusals are the listener\'s own', async () => {
  const dep = () => createLocalPlayRelay({ cfg, prepare: { prepare: async () => ({ status: 'blocked', blocker: { code: 'X' } }), close() {} }, rpc: async () => ({ error: { code: -1 } }) });
  const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal(REVEAL_ROUTES.context, 'POST /f/local-play/reveal/context');
  const bare = await serveLocalPlayRelay(dep(), 0);
  try { assert.equal((await post(bare.port, '/f/local-play/reveal/context', ask([ADDR(1)]))).status, 404); } finally { await bare.close(); }
  const a = ADDR(1), h = reader({ world: new Map([[a, { owner: LOCAL_PLAY_PROGRAM, bytes: Uint8Array.of(9) }]]) });
  const s = await serveLocalPlayRelay(dep(), 0, { reveal: h.r });
  try {
    const res = await post(s.port, '/f/local-play/reveal/context', ask([a, ADDR(2)]));
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await res.json()).accounts, [{ address: a, owner: LOCAL_PLAY_PROGRAM, data_b64: 'CQ==' }, { address: ADDR(2), owner: null, data_b64: null }]);
    for (const [body, status, code] of [[ask([a, a]), 400, 'LocalPlayInvalidRequest'], [ask(['x']), 400, 'LocalPlayInvalidRequest'], [{ schema: 'x', addresses: [a] }, 400, 'LocalPlayInvalidRequest'],
      ['{', 400, 'InvalidJson'], [JSON.stringify({ schema: REVEAL_CONTEXT_SCHEMA, addresses: [a], pad: 'x'.repeat(17 * 1024) }), 413, 'BodyTooLarge']]) {
      const bad = await post(s.port, '/f/local-play/reveal/context', body);
      assert.equal(bad.status, status, code); assert.equal((await bad.json()).code, code);
    }
    assert.equal(h.calls.length, 2, 'only the one good request reached the runner');
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/f/local-play/reveal/context`)).status, 404, 'POST only');
  } finally { await s.close(); }
});
