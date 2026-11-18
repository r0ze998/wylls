// TEST-ONLY operator AI residents (⑤ option A): the acting side. THIS FILE MAKES MEMORY-ONLY TEST KEYS (node:crypto
// ed25519 via memoryTestKey) — listed in scripts/ci/node-key-tests.txt, run by the key-tests job. No process, no port,
// no network: the relay is its own validator (local-play-act.mjs localActSubmit) called in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryTestKey, pageShapedSigner, relayPost, residentTurn, parseArgs, chainSecondsOf } from '../src/frontier/local-play-operator-residents.mjs';
import { createResidentMemory, createOperatorBudget } from '../src/frontier/local-play-operator-policy.mjs';
import { localActSubmit, LocalActError } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_SEASON_ID } from '../src/frontier/local-play-relay.mjs';
import { submitLocalAct } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', RULESET = '234c0dc225e5ce323687756b913f78e330757abb969df290745eae1e9aae422d';
const SEASON = seasonAddresses(PROGRAM, String(LOCAL_PLAY_SEASON_ID)).season, BLOCKHASH = encode(new Uint8Array(32).fill(7));

/** A relay in memory: the context answers a blockhash; the submit runs the relay's OWN check (`localActSubmit`) for ITS wallet. */
function memoryRelay(relayWallet, { contextWallet = relayWallet } = {}) {
  const pins = { program: PROGRAM, season: SEASON, seasonId: LOCAL_PLAY_SEASON_ID, wallet: relayWallet, rulesetHash: RULESET };
  const checked = [];
  const post = async (origin, path, body) => {
    if (path.endsWith('/act/context')) return { wallet: contextWallet, blockhash: { hash: BLOCKHASH, last_valid_block_height: '100', context_slot: '5' } };
    if (path.endsWith('/act/submit')) {
      try { const ok = localActSubmit(body, pins); checked.push(ok); return { status: 'submitted', name: ok.intent.name, signature: ok.signature }; }
      catch (e) { if (e instanceof LocalActError) throw Object.assign(new Error('refused'), { code: e.code, refused: true, status: e.status }); throw e; }
    }
    throw new Error(`unexpected ${path}`);
  };
  return { post, checked };
}

test("a resident's command is the page's own: the relay's own check accepts it, for its own wallet only", async () => {
  const key = memoryTestKey(), other = memoryTestKey();
  assert.notEqual(key.address, other.address);
  const identity = { address: key.address, programId: PROGRAM, seasonAddress: SEASON, cluster: 'localnet' };
  const relay = memoryRelay(key.address);
  const deps = { allowed: () => ({ ok: true, relay: 'http://127.0.0.1:41420' }), identity: () => identity, rulesetHash: () => RULESET, signer: (s => () => s)(pageShapedSigner(key)), post: relay.post };
  const join = await submitLocalAct({ name: 'Join', v: { faction: 4 }, fields: { faction: 4, session_expiry: 2_000_000_000n } }, deps);
  assert.equal(join.ok, true, JSON.stringify(join));
  assert.equal(relay.checked[0].intent.name, 'Join'); assert.equal(relay.checked[0].intent.fields.session, key.address);
  const build = await submitLocalAct({ name: 'Build', v: { holding: { p: -1, q: 2, site: 3 } }, fields: { item: 1 } }, deps);
  assert.equal(build.ok, true); assert.equal(relay.checked[1].intent.name, 'Build');
  // the same command signed by another resident's key is refused by the relay pinned to THIS wallet (before any send)
  const lying = memoryRelay(key.address, { contextWallet: other.address });
  const theirs = await submitLocalAct({ name: 'Harvest', v: { holding: { p: -1, q: 2, site: 3 } }, fields: {} }, { ...deps, post: lying.post, identity: (i => () => i)({ ...identity, address: other.address }), signer: (s => () => s)(pageShapedSigner(other)) });
  assert.equal(theirs.ok, false); assert.equal(theirs.code, 'LocalActSigner'); assert.equal(lying.checked.length, 0);
  // and a command no page sends (a march) is not one of the six
  const march = await submitLocalAct({ name: 'Depart', v: {}, fields: {} }, deps);
  assert.equal(march.ok, false); assert.equal(march.code, 'LocalActNotAllowed');
  // the signer signs only its own wallet's transaction
  await assert.rejects(pageShapedSigner(other).wallet.features['solana:signTransaction'].signTransaction({ transaction: (await (async () => { const { wireTransaction } = await import('../../permutation-server/web/sdk/solana-tx.mjs'); return wireTransaction(relay.checked[1].message, []); })()) }));
});

test('the relay post goes to the resident\'s own relay (no /gw prefix), the page\'s three routes only', async () => {
  const urls = [], refusals = [];
  const post = relayPost(async (url, init) => { urls.push(url); return urls.length === 1 ? new Response(JSON.stringify({ ok: 1 }), { status: 200 }) : new Response(JSON.stringify({ error: 'LocalActSendRefused', detail: { message: 'x' } }), { status: 502 }); }, a => refusals.push(a));
  await post('http://127.0.0.1:41420', '/gw/f/local-play/act/context', { schema: 'x' });
  assert.deepEqual(urls, ['http://127.0.0.1:41420/f/local-play/act/context']);
  await assert.rejects(post('http://127.0.0.1:41420', '/gw/f/local-play/act/submit', {}), e => e.refused === true);
  assert.deepEqual(refusals, [{ error: 'LocalActSendRefused', detail: { message: 'x' } }]);
  await assert.rejects(post('http://127.0.0.1:41420', '/gw/f/local-play/march/submit', {}), e => e.code === 'BadLocalActPath');
});

test('one turn: read, decide, send within the budget, follow; a refusal is said as one', async () => {
  const key = memoryTestKey();
  const r = { index: 0, key, memory: createResidentMemory(0), budget: createOperatorBudget({ maxActs: 3, maxRefusals: 5, minGapMs: 0 }) };
  const sent = [];
  let t = 1000;
  const deps = { now: () => t, nowSecs: async () => 1_700_000_000, read: async () => ({ v: 1, citizen: null, holdings: [] }),
    submit: async order => { sent.push(order); return { ok: true, signature: 'S1' }; }, follow: async () => ({ state: 'landed' }) };
  const a = await residentTurn(r, { homes: [{ p: -1, q: 2, nation: 1 }], deps });
  assert.deepEqual([a.step, a.act, a.outcome, a.signature, a.fields.session_expiry], ['act', 'Join', 'landed', 'S1', String(1_700_000_000 + 30 * 86_400 - 600)]);
  assert.equal(sent[0].v.faction, 1);
  // the herald gives no answer: nothing is decided or sent
  const b = await residentTurn(r, { homes: [], deps: { ...deps, read: async () => { throw new Error('down'); } } });
  assert.deepEqual([b.step, b.outcome], ['read', 'no-answer']); assert.equal(sent.length, 1);
  // a pre-send refusal (the page's own "not sent")
  const c = await residentTurn(r, { homes: [], deps: { ...deps, read: async () => ({ v: 1, citizen: null, holdings: [] }), submit: async () => ({ ok: false, code: 'LocalActAlreadyJoined' }) } });
  assert.deepEqual([c.outcome, c.code], ['refused', 'LocalActAlreadyJoined']);
  // out of budget: no send
  r.budget.spent('landed', t); r.budget.spent('landed', t);
  const d = await residentTurn(r, { homes: [], deps });
  assert.deepEqual([d.step, d.outcome], ['budget', 'stopped']); assert.equal(sent.length, 1);
});

test("the Join's clock is the chain's as the herald saw it, never the local clock", () => {
  assert.equal(chainSecondsOf({ live: [9276, 1785633719] }), 1785633719);
  for (const bad of [null, {}, { live: [] }, { live: [1, 'x'] }, { live: [1, 0] }]) assert.equal(chainSecondsOf(bad), null);
});

test('the command line: loopback herald only, a port per resident, at most four', () => {
  const ok = parseArgs(['--count', '2', '--relay-ports', '41420,41421', '--herald', 'http://127.0.0.1:41412', '--homes', '[{"p":1,"q":1,"nation":1}]']);
  assert.deepEqual([ok.count, ok.ports, ok.cadenceMs], [2, [41420, 41421], 6000]);
  for (const bad of [
    ['--count', '5', '--relay-ports', '1,2,3,4,5', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]'],
    ['--count', '2', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://example.com:41412', '--homes', '[1]'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[]'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]', '--key', 'x'],
  ]) assert.throws(() => parseArgs(bad), String(bad));
});

test('the command line: --nations names one nation per resident, up to six; without it, at most four', () => {
  const h = ['--herald', 'http://127.0.0.1:41312', '--homes', '[{"p":1,"q":1,"nation":1}]'];
  const six = parseArgs(['--count', '6', '--relay-ports', '41320,41321,41322,41323,41324,41325', '--nations', '1,4,2,5,0,3', ...h]);
  assert.deepEqual([six.count, six.nations], [6, [1, 4, 2, 5, 0, 3]]);
  assert.equal(parseArgs(['--count', '1', '--relay-ports', '41320', ...h]).nations, undefined);
  for (const bad of [
    ['--count', '6', '--relay-ports', '41320,41321,41322,41323,41324,41325', ...h],
    ['--count', '2', '--relay-ports', '41320,41321', '--nations', '1', ...h],
    ['--count', '2', '--relay-ports', '41320,41321', '--nations', '1,1', ...h],
    ['--count', '1', '--relay-ports', '41320', '--nations', '6', ...h],
  ]) assert.throws(() => parseArgs(bad), String(bad));
});
