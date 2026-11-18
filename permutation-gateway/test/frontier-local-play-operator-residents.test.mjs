// TEST-ONLY operator AI residents (⑤ option A): the acting side. THIS FILE MAKES MEMORY-ONLY TEST KEYS (node:crypto
// ed25519 via memoryTestKey) — listed in scripts/ci/node-key-tests.txt, run by the key-tests job. No process, no port,
// no network: the relay is its own validator (local-play-act.mjs localActSubmit) called in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryTestKey, pageShapedSigner, relayPost, residentTurn, parseArgs, chainSecondsOf, createQuietLog, delay, genesisOf, main, RESIDENT_ALREADY_ACTED } from '../src/frontier/local-play-operator-residents.mjs';
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

test('one bell: the budget first, then read, decide, ONE send, follow; never a second action in that bell (Q16-2)', async () => {
  const key = memoryTestKey();
  const r = { index: 0, key, memory: createResidentMemory(0), budget: createOperatorBudget({ maxActs: 3, maxRefusals: 5, minGapMs: 0 }) };
  const sent = [], reads = [];
  let t = 1000;
  const deps = { now: () => t, nowSecs: async () => 1_700_000_000, read: async w => { reads.push(w); return { v: 1, citizen: null, holdings: [] }; },
    submit: async order => { sent.push(order); return { ok: true, signature: 'S1' }; }, follow: async () => ({ state: 'landed' }) };
  const a = await residentTurn(r, { homes: [{ p: -1, q: 2, nation: 1 }], deps, bell: 5 });
  assert.deepEqual([a.step, a.act, a.outcome, a.signature, a.fields.session_expiry], ['act', 'Join', 'landed', 'S1', String(1_700_000_000 + 30 * 86_400 - 600)]);
  assert.equal(sent[0].v.faction, 1);
  // the bell's one action is taken: nothing is read or sent until the next bell
  const n = reads.length;
  const w = await residentTurn(r, { homes: [], deps, bell: 5 });
  assert.deepEqual([w.step, w.outcome, w.why], ['budget', 'later', "this bell's one action is taken: the next bell"]); assert.equal(reads.length, n); assert.equal(sent.length, 1);
  // the herald gives no answer: nothing is decided or sent, and the next bell's action is still there
  const b = await residentTurn(r, { homes: [], deps: { ...deps, read: async () => { throw new Error('down'); } }, bell: 6 });
  assert.deepEqual([b.step, b.outcome], ['read', 'no-answer']); assert.equal(sent.length, 1);
  // a pre-send refusal (the page's own "not sent") uses the bell's one action
  const c = await residentTurn(r, { homes: [], deps: { ...deps, submit: async () => ({ ok: false, code: 'LocalActAlreadyJoined' }) }, bell: 6 });
  assert.deepEqual([c.outcome, c.code], ['refused', 'LocalActAlreadyJoined']);
  assert.equal((await residentTurn(r, { homes: [], deps, bell: 6 })).outcome, 'later');
  // PR #62's relay-side hold: "already acted in this bell" — a wait, nothing marked tried, the bell used up, no retry in it
  const tried = r.memory.triedHomes.length, decisions = r.memory.decisions;
  const h = await residentTurn(r, { homes: [], deps: { ...deps, submit: async () => ({ ok: false, code: RESIDENT_ALREADY_ACTED }) }, bell: 7 });
  assert.deepEqual([h.step, h.outcome, h.code], ['act', 'wait', 'ResidentAlreadyActed']);
  assert.deepEqual([r.memory.triedHomes.length, r.memory.decisions, r.budget.state().refusalsInRow], [tried, decisions, 1]);
  assert.equal((await residentTurn(r, { homes: [], deps, bell: 7 })).outcome, 'later');
  // no bell known (chain clock or genesis unread): nothing sent
  assert.equal((await residentTurn(r, { homes: [], deps, bell: null })).outcome, 'later');
  // the world cap (only when set) is spent: stopped for good, said as such
  r.budget.spent('landed', t, 8); r.budget.spent('landed', t, 9);
  const d = await residentTurn(r, { homes: [], deps, bell: 10 });
  assert.deepEqual([d.step, d.outcome], ['budget', 'stopped']); assert.equal(sent.length, 1);
});

test("the Season's genesis for the bell: the herald's /h/season record, decoded; anything unreadable is null", () => {
  const dec = (kind, bytes) => { assert.equal(kind, 'Season'); return { genesisTs: BigInt(bytes[0]) * 1000n }; };
  assert.equal(genesisOf({ v: 1, bytes_b64: Buffer.from([7]).toString('base64') }, null, dec), 7000);
  for (const bad of [null, {}, { v: 2, bytes_b64: 'AA==' }, { v: 1 }]) assert.equal(genesisOf(bad, null, dec), null);
  assert.equal(genesisOf({ v: 1, bytes_b64: 'AA==' }, null, () => { throw new Error('short'); }), null);
  assert.equal(genesisOf({ v: 1, bytes_b64: 'AA==' }), null, 'one byte is no Season');
});

test('(B12) every resident stopped for good: one line each, the summary, exit 0 (main, loopback 41285–41287)', { timeout: 30000 }, async t => {
  const http = await import('node:http');
  const lines = [];
  let wallets = [];
  const listen = (port, h) => new Promise(r => { const s = http.createServer(h); s.listen(port, '127.0.0.1', () => r(s)); t.after(() => new Promise(q => { s.closeAllConnections?.(); s.close(() => q()); })); });
  const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  for (const [i, port] of [41285, 41286].entries()) await listen(port, (req, res) => json(res, { localPlay: true, wallet: wallets[i], cluster: 'localnet', program: PROGRAM, season: SEASON, rulesetHash: RULESET }));
  const heraldReads = [];
  await listen(41287, (req, res) => { heraldReads.push(req.url); json(res, req.url === '/h/status' ? { live: [1, 1_700_000_000] } : { v: 1, bytes_b64: '' }); });
  const rc = await main(['--count', '2', '--relay-ports', '41285,41286', '--herald', 'http://127.0.0.1:41287', '--homes', '[{"p":1,"q":1,"nation":1}]', '--max-refusals', '0', '--cadence-ms', '10'],
    { print: s => { const l = JSON.parse(s); lines.push(l); if (l.wallets) wallets = l.wallets; } });
  assert.equal(rc, 0);
  assert.deepEqual(lines.filter(l => l.step === 'budget').map(l => [l.resident, l.outcome]), [[0, 'stopped'], [1, 'stopped']]);
  const last = lines.at(-1);
  assert.deepEqual([last.step, last.why, last.residents.length], ['stopped', 'every resident is stopped for good', 2]);
  assert.equal(lines.filter(l => l.step === 'stopped').length, 1, 'the summary once');
  assert.ok(!heraldReads.some(u => u.startsWith('/h/me/')), 'a stopped resident reads nothing');
});

test('(B12) the log does not repeat a resident\'s same wait; a send is always said', () => {
  const q = createQuietLog();
  const later = { resident: 0, step: 'budget', outcome: 'later', why: "this bell's one action is taken: the next bell" };
  assert.equal(q.fresh(later), true);
  assert.equal(q.fresh({ ...later }), false);
  assert.equal(q.fresh({ ...later, resident: 1 }), true);   // (another resident's own line)
  assert.equal(q.fresh({ resident: 0, step: 'act', act: 'Harvest', outcome: 'landed' }), true);
  assert.equal(q.fresh({ resident: 0, step: 'act', act: 'Harvest', outcome: 'landed' }), true);
  assert.equal(q.fresh(later), true);                         // (after a send, the next wait is said again)
  assert.equal(q.fresh({ ...later, why: 'too soon after the last send' }), true);
  // 1200 rounds of the same wait print one line
  let printed = 0;
  for (let i = 0; i < 1200; i++) printed += q.fresh({ resident: 2, step: 'decide', outcome: 'wait', why: 'x', seen: { joined: true } }) ? 1 : 0;
  assert.equal(printed, 1);
});

test('(B12) the round wait leaves no abort listener behind; an abort still cuts it short', async () => {
  const { getEventListeners } = await import('node:events');
  const stop = new AbortController();
  for (let i = 0; i < 30; i++) await delay(1, stop.signal);
  assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
  const t0 = Date.now(); const w = delay(10_000, stop.signal); stop.abort('x'); await w;
  assert.ok(Date.now() - t0 < 1000);
});

test("the Join's clock is the chain's as the herald saw it, never the local clock", () => {
  assert.equal(chainSecondsOf({ live: [9276, 1785633719] }), 1785633719);
  for (const bad of [null, {}, { live: [] }, { live: [1, 'x'] }, { live: [1, 0] }]) assert.equal(chainSecondsOf(bad), null);
});

test('the command line: loopback herald only, a port per resident, at most four', () => {
  const ok = parseArgs(['--count', '2', '--relay-ports', '41420,41421', '--herald', 'http://127.0.0.1:41412', '--homes', '[{"p":1,"q":1,"nation":1}]']);
  assert.deepEqual([ok.count, ok.ports, ok.cadenceMs, ok.maxActs, 'perTurn' in ok], [2, [41420, 41421], 6000, null, false]);
  assert.equal(parseArgs(['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[{"p":1,"q":1,"nation":1}]', '--max-acts', '500']).maxActs, 500);
  for (const bad of [
    ['--count', '5', '--relay-ports', '1,2,3,4,5', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]'],
    ['--count', '2', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://example.com:41412', '--homes', '[1]'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[]'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]', '--key', 'x'],
    // (one action per bell is not a setting, Q16-2)
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]', '--per-turn', '2'],
    ['--count', '1', '--relay-ports', '41420', '--herald', 'http://127.0.0.1:41412', '--homes', '[1]', '--turn-secs', '60'],
  ]) assert.throws(() => parseArgs(bad), String(bad));
});
