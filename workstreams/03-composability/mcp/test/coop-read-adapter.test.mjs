// Final coordinator validation 2026-11-17 UTC: corrected-contract suites passed 74/74 (adapter 41 + integration 33).
// Tests for src/coop-read-adapter.mjs. Fixtures only: an injected fake fetch with fake streamed bodies, fake timers
// (no real timeout ever fires), no filesystem, no network.
// 2026-11-18 real-board contract fix: the earlier fixtures (34/34 passed) invented a string nation ('North') and
// capitalised resources ('Stone'), which the real board never sends. The hand-written fixtures below now use the
// board's shapes (numeric zero-based faction, lowercase resources, fulfilment {status}), and the last section feeds the
// output of the real, pure coopView (coop/goal.mjs) and fold (coop/record.mjs) into the adapter. Not createBoard: no
// board process, no fs write, no signature, no address derivation (no links, no herald file). The suite as it now
// stands has NOT been executed by the session that wrote it (see COOP-READ-ADAPTER.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoopReadAdapter, normaliseBoardBase, COOP_READ_SCOPE, COOP_READ_LIMITATIONS, COOP_FACTIONS, COOP_RESOURCES, COOP_FULFILMENT_STATUSES } from '../src/coop-read-adapter.mjs';
import { coopView, GOALS } from '../../../01-national-strategy/coop/goal.mjs';
import { fold, recordId, RESOURCES } from '../../../01-national-strategy/coop/record.mjs';

const OWNER = 'Hv7mQ9xT3kPz2RbW5cYfN8dLsJ4gAeUq6tBnVr1oXy';
const OTHER = 'Gk3pZ8wR2nTq5vYc7bMd9fHs4jKe6gAu1xWr2tNmPz';
const PROGRAM = 'Prog' + '1'.repeat(40);
const OTHER_PROGRAM = 'Prgm' + '2'.repeat(40);
const BASE = 'https://board.example';
const WORLD = Object.freeze({ programId: PROGRAM, seasonId: '3', cluster: 'localnet' });
const PRINCIPAL = Object.freeze({ owner: OWNER, scopes: ['wylls.read'] });
const ARGS = Object.freeze({ principal: PRINCIPAL, context: WORLD });
const enc = new TextEncoder();

// ------------------------------------------------------------------ fakes

/** A fake streamed body: chunks of `size` bytes; counts reads; records cancel. */
function streamBody(bytes, size = 64) {
  const state = { reads: 0, cancelled: false };
  let at = 0;
  return {
    state,
    getReader() {
      return {
        read: async () => {
          state.reads += 1;
          if (at >= bytes.length) return { done: true, value: undefined };
          const value = bytes.slice(at, at + size);
          at += size;
          return { done: false, value };
        },
        cancel: async () => { state.cancelled = true; },
      };
    },
  };
}

/** A fake Response. text()/json() throw: the adapter must never use them (unbounded reads). */
function response(doc, { status = 200, headers = {}, url = null, redirected = false, type = 'basic', chunk = 64, body } = {}) {
  const bytes = enc.encode(typeof doc === 'string' ? doc : JSON.stringify(doc));
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status, redirected, type, url: url ?? '',
    headers: { get: n => lower[n.toLowerCase()] ?? null },
    body: body === undefined ? streamBody(bytes, chunk) : body,
    text() { throw new Error('text() must not be called'); },
    json() { throw new Error('json() must not be called'); },
  };
}

/** fetch that records every call and answers with handler(url, init, n). */
function fakeFetch(handler) {
  const calls = [];
  const fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve(handler(url, init, calls.length)); };
  fetch.calls = calls;
  return fetch;
}

/** A board: /coop/config answers `config` first and `config2` afterwards; /coop/view answers `view`. */
function boardFetch({ config = configDoc(), config2, view = viewDoc(), viewOpts = {} } = {}) {
  let configReads = 0;
  return fakeFetch(url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/coop/config')) { configReads += 1; return response(configReads === 1 ? config : (config2 ?? config)); }
    if (u.pathname.endsWith('/coop/view')) return response(view, viewOpts);
    return response({ error: 'not here' }, { status: 404 });
  });
}

/** Timers that never fire on their own. */
const idleTimers = () => ({ setTimeout: () => 1, clearTimeout: () => {} });

const adapter = (fetch, extra = {}) => createCoopReadAdapter({ publicViewConfirmed: true, baseUrl: BASE, fetch, timers: idleTimers(), ...extra });

// ------------------------------------------------------------------ fixtures (shapes from coop/board.mjs and coop/goal.mjs)

const ctx = (programId = PROGRAM, seasonId = '3') => ({ programId, seasonId });

function configDoc(over = {}) {
  return {
    season: ctx(), contexts: [ctx()], cluster: 'localnet', page: '/ws01/repo/coop/index.html', goals: { 'g-vault': { id: 'g-vault', title: 'Vault' } },
    judges: [{ id: 'arrivals', label: 'Arrivals', means: 'm' }], judge: 'arrivals', herald: 'http://127.0.0.1:9000', chain: true,
    damaged: [], relay: '/gw', rpcProxy: false, store: { segments: [{ file: '/var/wylls/board/seg-0001.jsonl', bytes: 10 }], problems: [] },
    ...over,
  };
}

function viewDoc(over = {}) {
  // nation 0: the first faction. It is falsy in JS and must still read as a verified nation, never as unknown.
  const req1 = {
    id: 'req-000001', goalId: 'g-vault', requester: OWNER, nation: 4, need: { stone: 300 }, sig: 'SIG-REQUEST-SECRET', note: 'free text from a player',
    responses: { [OTHER]: { id: 'resp-0001', sig: 'SIG-RESPONSE-SECRET', note: 'free text reply' } }, stateNow: 'open',
    arrivals: [
      { requestId: 'req-000001', responder: OTHER, caravanId: 'cv-1', state: 'delivered', counted: { stone: 120 }, proof: 'PROOF-SECRET' },
      { requestId: 'req-000001', responder: OTHER, caravanId: 'cv-2', state: 'moving', counted: null },
    ],
    fulfilment: { status: 'undetermined', lower: { stone: 120 }, shortBy: { stone: 180 }, open: 1 }, sendings: [{ walletSig: 'WALLET-SIG-SECRET', outcome: { status: 'unknown', why: 'w' } }],
  };
  const req2 = {
    id: 'req-000002', goalId: 'g-vault', requester: OTHER, nation: 4, need: { wood: 50 }, responses: { [OWNER]: { id: 'resp-0002', sig: 'SIG-OWNER-SECRET' } }, stateNow: 'open',
    arrivals: [{ requestId: 'req-000002', responder: OWNER, caravanId: 'cv-3', state: 'delivered', counted: { wood: 50 } }], fulfilment: { status: 'fulfilled', lower: { wood: 50 }, shortBy: {}, open: 0 },
  };
  return {
    requests: [req1, req2],
    arrivals: [...req1.arrivals, ...req2.arrivals],
    joint: [{ goalId: 'g-vault', host: OWNER, contributors: [OTHER], why: 'free text verdict' }],
    nation: { nation: 0, note: 'board note text', requests: 4, deliveredFromNation: 7 },
    personal: {
      viewer: OWNER, nation: 0, nationWhy: null,
      myRequests: [{ id: 'req-000001', state: 'open', need: { stone: 300 }, responses: req1.responses, arrivals: req1.arrivals, fulfilment: req1.fulfilment }],
      myResponses: [{ id: 'req-000002', requester: OTHER, response: req2.responses[OWNER], arrivals: req2.arrivals }],
      myVerified: { wood: 50 }, left: ['g-vault'],
    },
    rejected: [{ why: 'rejected free text', rec: { sig: 'SIG-REJECTED' } }],
    judges: [{ id: 'arrivals', label: 'Arrivals', means: 'm' }],
    heraldFeed: { moving: 1, ended: 2 }, chain: true, damaged: [], contexts: [ctx()], store: { segments: 1, problems: [] },
    token: 'TOKEN-SECRET',
    ...over,
  };
}

function emptyViewDoc() {
  return viewDoc({
    requests: [], arrivals: [], joint: [],
    nation: { nation: 0, note: 'n', requests: 0, deliveredFromNation: 0 },
    personal: { viewer: OWNER, nation: 0, nationWhy: null, myRequests: [], myResponses: [], myVerified: {}, left: [] },
  });
}

// ------------------------------------------------------------------ disabled by default, zero fetch

test('disabled by default: no config, no fetch', async () => {
  const a = createCoopReadAdapter();
  assert.equal(a.enabled, false);
  const r = await a.read(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'disabled');
  assert.equal(r.nation, null);
  assert.equal(r.mine, null);
});

test('anything but publicViewConfirmed === true stays disabled and never fetches', async () => {
  for (const v of [undefined, false, 'true', 1, {}, null]) {
    const fetch = boardFetch();
    const a = createCoopReadAdapter({ publicViewConfirmed: v, baseUrl: BASE, fetch });
    assert.equal(a.enabled, false);
    assert.equal((await a.read(ARGS)).status, 'disabled');
    assert.equal(fetch.calls.length, 0);
  }
});

test('enabled config must inject fetch and name a clean http(s) base', () => {
  assert.throws(() => createCoopReadAdapter({ publicViewConfirmed: true, baseUrl: BASE }), TypeError);
  const fetch = boardFetch();
  for (const bad of [undefined, '', 'ftp://board.example', 'https://u:p@board.example', 'https://board.example/?x=1', 'https://board.example/#f', 'not a url', 'https://board.example/a b']) {
    assert.throws(() => createCoopReadAdapter({ publicViewConfirmed: true, baseUrl: bad, fetch }), TypeError, String(bad));
  }
  assert.throws(() => adapter(fetch, { timeoutMs: 0 }), TypeError);
  assert.throws(() => adapter(fetch, { maxBytes: 10 }), TypeError);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual({ ...normaliseBoardBase('https://board.example/ws/') }, { href: 'https://board.example/ws', origin: 'https://board.example', path: '/ws' });
});

// ------------------------------------------------------------------ principal and context, rejected before any fetch

test('missing wylls.read scope is refused before fetch', async () => {
  assert.equal(COOP_READ_SCOPE, 'wylls.read');
  for (const principal of [undefined, null, { owner: OWNER }, { owner: OWNER, scopes: [] }, { owner: OWNER, scopes: ['wylls.caravan'] }, { owner: OWNER, scopes: 'wylls.read' }]) {
    const fetch = boardFetch();
    const r = await adapter(fetch).read({ principal, context: WORLD });
    assert.equal(r.status, 'refused');
    assert.equal(fetch.calls.length, 0);
  }
});

test('malformed owner is refused before fetch', async () => {
  for (const owner of [undefined, '', 'not-a-wallet', '0'.repeat(44), OWNER + 'x'.repeat(10)]) {
    const fetch = boardFetch();
    const r = await adapter(fetch).read({ principal: { owner, scopes: ['wylls.read'] }, context: WORLD });
    assert.equal(r.status, 'refused');
    assert.equal(fetch.calls.length, 0);
  }
});

test('missing, unknown-field or malformed context is refused before fetch (no caller-chosen viewer)', async () => {
  const bad = [
    undefined, null, {},
    { ...WORLD, viewer: OTHER },
    { ...WORLD, wallet: OTHER },
    { ...WORLD, programId: 'nope' },
    { ...WORLD, seasonId: -1 },
    { ...WORLD, seasonId: 's/3' },
    { ...WORLD, cluster: '' },
    { ...WORLD, cluster: 'Main Net' },
    { programId: PROGRAM, seasonId: '3' },
  ];
  for (const context of bad) {
    const fetch = boardFetch();
    const r = await adapter(fetch).read({ principal: PRINCIPAL, context });
    assert.equal(r.status, 'refused', JSON.stringify(context));
    assert.equal(fetch.calls.length, 0);
  }
});

// ------------------------------------------------------------------ requests made

test('reads config, view, config; viewer bound exactly to the owner; GET, no credentials, redirects manual', async () => {
  const fetch = boardFetch();
  const r = await adapter(fetch).read(ARGS);
  assert.equal(r.status, 'ok');
  assert.deepEqual(fetch.calls.map(c => c.url), [`${BASE}/coop/config`, `${BASE}/coop/view?viewer=${OWNER}`, `${BASE}/coop/config`]);
  for (const { init } of fetch.calls) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.body, undefined);
    const names = Object.keys(init.headers).map(k => k.toLowerCase());
    assert.ok(!names.includes('authorization') && !names.includes('cookie'));
  }
});

test('a path prefix in the base is kept; nothing else of the URL can be chosen', async () => {
  const fetch = boardFetch();
  await adapter(fetch, { baseUrl: 'https://board.example/ws01/' }).read(ARGS);
  assert.deepEqual(fetch.calls.map(c => c.url), ['https://board.example/ws01/coop/config', `https://board.example/ws01/coop/view?viewer=${OWNER}`, 'https://board.example/ws01/coop/config']);
});

// ------------------------------------------------------------------ owner / world / cluster

test('owner mismatch: the board answered for another wallet', async () => {
  const v = viewDoc();
  v.personal.viewer = OTHER;
  const r = await adapter(boardFetch({ view: v })).read(ARGS);
  assert.equal(r.status, 'mismatch');
  assert.equal(r.nation, null);
  assert.equal(r.mine, null);
});

test('world mismatch in config stops before the view', async () => {
  for (const config of [configDoc({ season: ctx(PROGRAM, '2'), contexts: [ctx(PROGRAM, '2')] }), configDoc({ season: ctx(OTHER_PROGRAM), contexts: [ctx(OTHER_PROGRAM)] }), configDoc({ cluster: 'devnet' })]) {
    const fetch = boardFetch({ config });
    const r = await adapter(fetch).read(ARGS);
    assert.equal(r.status, 'mismatch');
    assert.equal(fetch.calls.length, 1);
  }
});

test('config without cluster is a mismatch, not an assumed match', async () => {
  const config = configDoc();
  delete config.cluster;
  assert.equal((await adapter(boardFetch({ config })).read(ARGS)).status, 'mismatch');
});

test('view of another world than config is refused', async () => {
  const r = await adapter(boardFetch({ view: viewDoc({ contexts: [ctx(PROGRAM, '2')] }) })).read(ARGS);
  assert.equal(r.status, 'mismatch');
  assert.equal(r.mine, null);
});

test('a listed request of another world is refused', async () => {
  const v = viewDoc();
  v.requests[0].ctx = ctx(OTHER_PROGRAM, '2');
  assert.equal((await adapter(boardFetch({ view: v })).read(ARGS)).status, 'mismatch');
});

// ------------------------------------------------------------------ changed between reads

test('config changed between the reads is refused as changed', async () => {
  const cases = [
    configDoc({ season: ctx(PROGRAM, '4'), contexts: [ctx(PROGRAM, '4')] }),
    configDoc({ cluster: 'devnet' }),
    configDoc({ judge: 'vault' }),
    configDoc({ damaged: [{ file: 'seg', why: 'bad' }] }),
    configDoc({ contexts: [ctx(), ctx(PROGRAM, '2')] }),
  ];
  for (const config2 of cases) {
    const fetch = boardFetch({ config2 });
    const r = await adapter(fetch).read(ARGS);
    assert.equal(r.status, 'changed', JSON.stringify(config2.season));
    assert.equal(r.nation, null);
    assert.equal(fetch.calls.length, 3);
  }
});

test('view store problems while config had none is refused (no partial data)', async () => {
  const r = await adapter(boardFetch({ view: viewDoc({ store: { segments: 1, problems: ['segment 3 unreadable'] } }) })).read(ARGS);
  assert.equal(r.status, 'damaged');
  assert.equal(r.mine, null);
});

// ------------------------------------------------------------------ multi-context, damaged, store problems

test('multi-context board (previous worlds) is unsupported, never partially shown', async () => {
  const fetch = boardFetch({ config: configDoc({ contexts: [ctx(), ctx(PROGRAM, '2')] }) });
  const r = await adapter(fetch).read(ARGS);
  assert.equal(r.status, 'unsupported');
  assert.equal(r.nation, null);
  assert.equal(r.mine, null);
  assert.equal(fetch.calls.length, 1);
});

test('damaged records or store problems are refused as damaged', async () => {
  for (const config of [configDoc({ damaged: [{ file: '/var/x', why: 'sig' }] }), configDoc({ store: { segments: [], problems: ['/var/x: truncated'] } })]) {
    const r = await adapter(boardFetch({ config })).read(ARGS);
    assert.equal(r.status, 'damaged');
    assert.ok(!JSON.stringify(r).includes('/var/x'));
  }
});

// ------------------------------------------------------------------ malformed / partial data

test('malformed or partial view is refused, not shown as none', async () => {
  const mutate = [
    v => { delete v.nation; },
    v => { v.nation.requests = '4'; },
    v => { v.nation.deliveredFromNation = -1; },
    v => { v.nation.nation = 42; },
    v => { delete v.personal; },
    v => { v.personal.nation = 3; },
    v => { delete v.personal.myRequests; },
    v => { v.personal.myVerified = { wood: 0 }; },
    v => { v.personal.myRequests[0].id = 'req-missing'; },
    v => { v.personal.myRequests.push({ ...v.personal.myRequests[0] }); },
    v => { v.personal.myRequests[0].need = { stone: 1.5 }; },
    v => { v.personal.myRequests[0].arrivals = 'many'; },
    v => { v.requests[0].requester = OTHER; },
    v => { v.personal.myResponses[0].arrivals = [{ responder: OTHER, counted: { wood: 1 } }]; },
    v => { delete v.requests[1].responses[OWNER]; },
    v => { v.requests.push({ ...v.requests[0] }); },
    v => { v.heraldFeed = 'yes'; },
    v => { delete v.contexts; },
    v => { v.personal.left = [{}]; },
  ];
  for (const [i, m] of mutate.entries()) {
    const v = viewDoc();
    m(v);
    const r = await adapter(boardFetch({ view: v })).read(ARGS);
    assert.equal(r.ok, false, `case ${i}`);
    assert.equal(r.status, 'malformed', `case ${i}`);
    assert.equal(r.nation, null);
    assert.equal(r.mine, null);
  }
});

test('non-JSON, non-object, HTTP errors and failed fetch are unavailable', async () => {
  const answers = [
    () => response('not json'),
    () => response('[1,2]'),
    () => response('{}', { status: 500 }),
    () => response('{}', { status: 404 }),
    () => { throw new Error('ECONNREFUSED'); },
    () => null,
  ];
  for (const answer of answers) {
    const r = await adapter(fakeFetch(answer)).read(ARGS);
    assert.equal(r.status, 'unavailable');
    assert.equal(r.nation, null);
  }
});

test('redirects are refused', async () => {
  for (const opts of [{ status: 302, headers: { location: 'https://evil.example/' } }, { redirected: true }, { type: 'opaqueredirect', status: 0 }, { url: 'https://evil.example/coop/config' }]) {
    const fetch = fakeFetch(() => response(configDoc(), opts));
    const r = await adapter(fetch).read(ARGS);
    assert.equal(r.status, 'unavailable');
    assert.match(r.why, /redirect|another URL/);
    assert.equal(fetch.calls.length, 1);
  }
});

// ------------------------------------------------------------------ bounded body and timeout

test('declared content-length over maxBytes is refused without reading the body', async () => {
  const res = response(configDoc(), { headers: { 'content-length': String(4096) } });
  const r = await adapter(fakeFetch(() => res), { maxBytes: 1024 }).read(ARGS);
  assert.equal(r.status, 'unavailable');
  assert.match(r.why, /too large/);
  assert.equal(res.body.state.reads, 0);
});

test('a streamed body over maxBytes stops reading at the limit and cancels the stream', async () => {
  const big = 'x'.repeat(512 * 10);
  const res = response(big, { chunk: 512 });
  const r = await adapter(fakeFetch(() => res), { maxBytes: 1024 }).read(ARGS);
  assert.equal(r.status, 'unavailable');
  assert.match(r.why, /too large/);
  assert.equal(res.body.state.reads, 3);
  assert.equal(res.body.state.cancelled, true);
});

test('a response without a readable body stream is refused (no fallback to text())', async () => {
  for (const body of [null, {}, { getReader: 'no' }]) {
    const r = await adapter(fakeFetch(() => response(configDoc(), { body }))).read(ARGS);
    assert.equal(r.status, 'unavailable');
    assert.match(r.why, /no readable body stream/);
  }
});

test('non-Uint8Array chunks and invalid UTF-8 are refused', async () => {
  const strChunks = { getReader: () => { let n = 0; return { read: async () => (n++ ? { done: true } : { done: false, value: '{}' }), cancel: async () => {} }; } };
  assert.equal((await adapter(fakeFetch(() => response('', { body: strChunks }))).read(ARGS)).status, 'unavailable');
  const badUtf8 = streamBody(new Uint8Array([0x7b, 0xff, 0x7d]));
  const r = await adapter(fakeFetch(() => response('', { body: badUtf8 }))).read(ARGS);
  assert.equal(r.status, 'unavailable');
  assert.match(r.why, /UTF-8/);
});

test('timeout: a fetch that never answers ends at the deadline and is aborted (fake timers)', async () => {
  const pending = [];
  const timers = { setTimeout: fn => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  let signal = null;
  const fetch = fakeFetch((url, init) => { signal = init.signal; pending[0](); return new Promise(() => {}); });
  const r = await adapter(fetch, { timers }).read(ARGS);
  assert.equal(r.status, 'unavailable');
  assert.match(r.why, /timed out/);
  assert.equal(fetch.calls.length, 1);
  if (signal) assert.equal(signal.aborted, true);
});

test('timeout while the body streams ends the read and cancels the stream', async () => {
  const pending = [];
  const timers = { setTimeout: fn => { pending.push(fn); return pending.length; }, clearTimeout: () => {} };
  const state = { cancelled: false };
  const body = { getReader: () => ({ read: () => { pending[pending.length - 1](); return new Promise(() => {}); }, cancel: async () => { state.cancelled = true; } }) };
  const r = await adapter(fakeFetch(() => response('', { body })), { timers }).read(ARGS);
  assert.equal(r.status, 'unavailable');
  assert.match(r.why, /timed out/);
  assert.equal(state.cancelled, true);
});

// ------------------------------------------------------------------ unknown nation

test('unknown nation is unknown (null counts), not zero, and the board\'s free-form why is not copied', async () => {
  const v = viewDoc({ nation: { nation: null, why: 'FREEFORM-WHY Citizen account 9xQ… not found', note: 'FREEFORM-NOTE' } });
  v.personal.nation = null;
  v.personal.nationWhy = 'FREEFORM-NATIONWHY';
  const r = await adapter(boardFetch({ view: v })).read(ARGS);
  assert.equal(r.status, 'ok');
  assert.equal(r.nation.status, 'unknown');
  assert.equal(r.nation.nation, null);
  assert.equal(r.nation.requests, null);
  assert.equal(r.nation.deliveredFromNation, null);
  assert.notEqual(r.nation.requests, 0);
  const s = JSON.stringify(r);
  assert.ok(!s.includes('FREEFORM'), s);
  assert.equal(r.mine.requests.length, 1);
});

test('unknown nation in view.nation but a nation in personal is malformed', async () => {
  const v = viewDoc({ nation: { nation: null, why: 'x' } });
  assert.equal((await adapter(boardFetch({ view: v })).read(ARGS)).status, 'malformed');
});

// ------------------------------------------------------------------ valid snapshots and safe projection

test('valid empty snapshot: verified nation with 0 counts and empty lists (distinct from unknown/failed)', async () => {
  const r = await adapter(boardFetch({ view: emptyViewDoc() })).read(ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'ok');
  assert.equal(r.why, null);
  assert.deepEqual(r.nation, { status: 'verified', nation: 0, requests: 0, deliveredFromNation: 0, note: null });
  assert.deepEqual(r.mine, { requests: [], responses: [], verified: {}, left: [] });
  assert.deepEqual(r.world, { programId: PROGRAM, seasonId: '3', cluster: 'localnet' });
  assert.equal(r.owner, OWNER);
});

test('valid populated snapshot: exact projection', async () => {
  const r = await adapter(boardFetch()).read(ARGS);
  assert.deepEqual(r, {
    ok: true, status: 'ok', why: null,
    source: { kind: 'coop-board', origin: BASE, readOnly: true, judge: 'arrivals', heraldFeed: 'read' },
    world: { programId: PROGRAM, seasonId: '3', cluster: 'localnet' },
    owner: OWNER,
    nation: { status: 'verified', nation: 0, requests: 4, deliveredFromNation: 7, note: null },
    mine: {
      requests: [{ id: 'req-000001', state: 'open', need: { stone: 300 }, entries: { listed: 2, counted: 1 }, fulfilment: 'undetermined' }],
      responses: [{ id: 'req-000002', responded: true, myEntries: { listed: 1, counted: 1 } }],
      verified: { wood: 50 },
      left: ['g-vault'],
    },
    limitations: COOP_READ_LIMITATIONS,
  });
});

test('seasonId given as a number matches the board\'s string seasonId', async () => {
  const r = await adapter(boardFetch()).read({ principal: PRINCIPAL, context: { ...WORLD, seasonId: 3 } });
  assert.equal(r.status, 'ok');
  assert.equal(r.world.seasonId, '3');
});

test('herald feed unavailable is reported as such, not as empty', async () => {
  const r = await adapter(boardFetch({ view: viewDoc({ heraldFeed: null }) })).read(ARGS);
  assert.equal(r.status, 'ok');
  assert.equal(r.source.heraldFeed, 'unavailable');
});

test('safe projection: no raw spread, other wallets, signatures, tokens, proofs, free text or internal paths', async () => {
  const r = await adapter(boardFetch()).read(ARGS);
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r).sort(), ['limitations', 'mine', 'nation', 'ok', 'owner', 'source', 'status', 'why', 'world']);
  const s = JSON.stringify({ ...r, limitations: undefined });
  for (const secret of [OTHER, 'SECRET', 'free text', 'board note text', '/var/wylls', '127.0.0.1:9000', '/gw', '/ws01', 'caravanId', 'cv-1', 'resp-000', 'sendings', 'joint', 'rejected', 'contributors']) {
    assert.ok(!s.includes(secret), `leaked ${secret}`);
  }
  // no send authority, recipients, targets, scores, roles
  for (const k of ['recipients', 'targets', 'score', 'role', 'send', 'grant', 'permission']) assert.ok(!(k in r) && !(k in r.mine) && !(k in r.nation));
});

test('the result is not a grant: same fixed shape with no permission fields for any status', async () => {
  const disabled = await createCoopReadAdapter().read(ARGS);
  const refused = await adapter(boardFetch()).read({ principal: { owner: OWNER, scopes: [] }, context: WORLD });
  for (const r of [disabled, refused]) {
    assert.deepEqual(Object.keys(r).sort(), ['limitations', 'mine', 'nation', 'ok', 'owner', 'source', 'status', 'why', 'world']);
    assert.equal(r.ok, false);
  }
});

// ------------------------------------------------------------------ real-board contract: types, bounds, no coercion

test('nation is the zero-based faction number: each of 0..5 is verified and kept as a number (0 is not unknown)', async () => {
  assert.equal(COOP_FACTIONS, 6);
  for (let f = 0; f < COOP_FACTIONS; f++) {
    const v = viewDoc();
    v.nation.nation = f;
    v.personal.nation = f;
    const r = await adapter(boardFetch({ view: v })).read(ARGS);
    assert.equal(r.status, 'ok', `faction ${f}`);
    assert.equal(r.nation.status, 'verified', `faction ${f}`);
    assert.strictEqual(r.nation.nation, f);
    assert.equal(typeof r.nation.nation, 'number');
    assert.equal(r.nation.requests, 4);
  }
});

test('nation of a wrong type or out of 0..5 fails closed: no coercion from strings, names, floats, booleans or -0', async () => {
  const bad = ['North', '0', '5', '', 6, 7, 255, -1, 1.5, true, false, [0], { faction: 0 }];
  for (const n of bad) {
    const v = viewDoc();
    v.nation.nation = n;
    v.personal.nation = n;
    const r = await adapter(boardFetch({ view: v })).read(ARGS);
    assert.equal(r.status, 'malformed', JSON.stringify(n));
    assert.equal(r.nation, null);
    assert.equal(r.mine, null);
  }
  // -0 does not survive JSON.stringify (it becomes 0), so it is sent as raw JSON text.
  const raw = JSON.stringify(viewDoc()).replace('"nation":{"nation":0,', '"nation":{"nation":-0,');
  assert.ok(raw.includes('"nation":{"nation":-0,'));
  assert.equal((await adapter(boardFetch({ view: raw })).read(ARGS)).status, 'malformed');
  // personal.nation must be present and strictly the same value: missing, null or '0' against 0 are all refused.
  for (const m of [v => { delete v.personal.nation; }, v => { v.personal.nation = null; }, v => { v.personal.nation = '0'; }]) {
    const v = viewDoc();
    m(v);
    assert.equal((await adapter(boardFetch({ view: v })).read(ARGS)).status, 'malformed');
  }
});

test('resource names are exactly the board\'s lowercase names; anything else fails closed', async () => {
  assert.deepEqual([...COOP_RESOURCES], [...RESOURCES]); // coop/record.mjs
  for (const name of RESOURCES) {
    const v = viewDoc();
    v.personal.myRequests[0].need = { [name]: 7 };
    v.personal.myVerified = { [name]: 3 };
    const r = await adapter(boardFetch({ view: v })).read(ARGS);
    assert.equal(r.status, 'ok', name);
    assert.deepEqual(r.mine.requests[0].need, { [name]: 7 });
    assert.deepEqual(r.mine.verified, { [name]: 3 });
  }
  for (const name of ['Stone', 'Wood', 'STONE', 'science', 'influence', 'horses', 'mud', '', 'stone ', 'toString', 'constructor']) {
    for (const where of ['need', 'verified']) {
      const v = viewDoc();
      if (where === 'need') v.personal.myRequests[0].need = { [name]: 7 };
      else v.personal.myVerified = { [name]: 3 };
      const r = await adapter(boardFetch({ view: v })).read(ARGS);
      assert.equal(r.status, 'malformed', `${where} ${JSON.stringify(name)}`);
      assert.equal(r.mine, null);
    }
  }
  // "__proto__" as an own JSON key (raw text: an object literal would set the prototype instead).
  const raw = JSON.stringify(viewDoc()).replace('"myVerified":{"wood":50}', '"myVerified":{"__proto__":50}');
  assert.ok(raw.includes('"myVerified":{"__proto__":50}'));
  assert.equal((await adapter(boardFetch({ view: raw })).read(ARGS)).status, 'malformed');
  for (const amount of ['300', 1.5, -1, null, true]) {
    const v = viewDoc();
    v.personal.myRequests[0].need = { stone: amount };
    assert.equal((await adapter(boardFetch({ view: v })).read(ARGS)).status, 'malformed', JSON.stringify(amount));
  }
});

test('fulfilment is the board\'s {status} object with one of its four statuses; any other shape fails closed', async () => {
  for (const status of COOP_FULFILMENT_STATUSES) {
    const v = viewDoc();
    v.personal.myRequests[0].fulfilment = { status, lower: {}, shortBy: {} };
    const r = await adapter(boardFetch({ view: v })).read(ARGS);
    assert.equal(r.status, 'ok', status);
    assert.equal(r.mine.requests[0].fulfilment, status);
  }
  for (const f of ['Fulfilled', 'fulfilled', { status: 'Partial' }, { status: 'Fulfilled' }, {}, { status: 1 }, null, undefined, ['fulfilled']]) {
    const v = viewDoc();
    if (f === undefined) delete v.personal.myRequests[0].fulfilment; else v.personal.myRequests[0].fulfilment = f;
    assert.equal((await adapter(boardFetch({ view: v })).read(ARGS)).status, 'malformed', JSON.stringify(f));
  }
});

// ------------------------------------------------------------------ regression: the REAL coopView into the real adapter
// The view below is what coop/board.mjs view() answers, built the way it builds it (board.mjs: `{...coopView(...),
// heraldFeed, chain, damaged, contexts, store}`), but without createBoard: createBoard makes a data directory and may
// write observed.json. The state is the real fold of unsigned fixture records (fold checks shape and state, not
// signatures; the board's signature check is not part of this). No link records and no herald file, so coopView
// derives no address. checks.citizens is what coop/chain.mjs citizenOf returns: {status: 'verified', faction: <number>}.

const REAL_CTX = Object.freeze({ programId: PROGRAM, seasonId: '3' });
const REAL_NOW = 1_800_000_000;
const citizenKey = wallet => `${PROGRAM}/3|${wallet}`; // goal.mjs: `${ctxKey(season)}|${wallet}`

function realRecords() {
  const base = { v: 1, sig: 'fixture-not-a-signature', season: { ...REAL_CTX } };
  const mine = { ...base, kind: 'request', signer: OWNER, at: REAL_NOW - 100, goalId: 'crossing-storehouse-v1', need: { wood: 200, stone: 150 },
    to: { kind: 'holding', p: 1, q: -2, site: 3, gen: 0 }, nation: 4, expiresAt: REAL_NOW + 86400, nonce: 'fixture-1' };
  const theirs = { ...base, kind: 'request', signer: OTHER, at: REAL_NOW - 90, goalId: 'crossing-storehouse-v1', need: { food: 40, gold: 5 },
    to: { kind: 'holding', p: 4, q: 0, site: 1, gen: 0 }, nation: 1, expiresAt: REAL_NOW + 86400, nonce: 'fixture-2' };
  const reply = { ...base, kind: 'respond', signer: OWNER, at: REAL_NOW - 80, request: recordId(theirs), answer: 'accept', nation: 4, offer: { food: 40 } };
  return { mine, theirs, reply };
}

/** The board's /coop/view body for `viewer`, from the real fold and the real coopView, as JSON would carry it. */
function realBoardView({ records = [], citizens = {}, viewer = OWNER } = {}) {
  const state = fold(records, { goals: GOALS, contexts: [REAL_CTX], current: REAL_CTX });
  assert.deepEqual(state.rejected, [], 'the fixture records are accepted by the real fold');
  assert.equal(state.accepted.length, records.length);
  const v = coopView({ state, file: null, checks: { citizens, holdings: {} }, viewer, now: REAL_NOW, judgeId: 'arrivals', season: REAL_CTX });
  return JSON.parse(JSON.stringify({ ...v, heraldFeed: null, chain: false, damaged: [], contexts: [REAL_CTX], store: { segments: 0, problems: [] } }));
}

test('real coopView, verified nationality: numeric faction 0 and lowercase needs are accepted and projected exactly', async () => {
  const { mine, theirs, reply } = realRecords();
  const view = realBoardView({
    records: [mine, theirs, reply],
    citizens: { [citizenKey(OWNER)]: { status: 'verified', faction: 0, citizen: 'fixture' }, [citizenKey(OTHER)]: { status: 'verified', faction: 2, citizen: 'fixture' } },
  });
  // what the real board sends (the contract this adapter was wrong about)
  assert.strictEqual(view.nation.nation, 0);
  assert.strictEqual(view.personal.nation, 0);
  assert.deepEqual(view.personal.myRequests[0].need, { wood: 200, stone: 150 });
  assert.equal(view.personal.myRequests[0].fulfilment.status, 'none');
  for (const q of view.requests) for (const k of Object.keys(q.need)) assert.ok(RESOURCES.includes(k), k);

  const r = await adapter(boardFetch({ view })).read(ARGS);
  assert.deepEqual(r, {
    ok: true, status: 'ok', why: null,
    source: { kind: 'coop-board', origin: BASE, readOnly: true, judge: 'arrivals', heraldFeed: 'unavailable' },
    world: { programId: PROGRAM, seasonId: '3', cluster: 'localnet' },
    owner: OWNER,
    nation: { status: 'verified', nation: 0, requests: 1, deliveredFromNation: 0, note: null },
    mine: {
      requests: [{ id: recordId(mine), state: 'open', need: { wood: 200, stone: 150 }, entries: { listed: 0, counted: 0 }, fulfilment: 'none' }],
      responses: [{ id: recordId(theirs), responded: true, myEntries: { listed: 0, counted: 0 } }],
      verified: {},
      left: [],
    },
    limitations: COOP_READ_LIMITATIONS,
  });
  // privacy and no authority, on real data: no other wallet, no board free text, no declared nation, no place, no grant
  const s = JSON.stringify({ ...r, limitations: undefined });
  for (const leak of [OTHER, 'fixture-not-a-signature', 'fixture-1', view.nation.note, '"to"', '"offer"', '"joint"', '"rejected"']) assert.ok(!s.includes(leak), `leaked ${leak}`);
  for (const k of ['recipients', 'targets', 'score', 'role', 'send', 'grant', 'permission']) assert.ok(!(k in r) && !(k in r.mine) && !(k in r.nation));
});

test('real coopView, unknown nationality: unknown with null counts (not 0, not malformed), own requests still listed', async () => {
  const { mine, theirs, reply } = realRecords();
  const view = realBoardView({ records: [mine, theirs, reply], citizens: {} });
  assert.strictEqual(view.nation.nation, null);
  assert.strictEqual(view.personal.nation, null);
  assert.equal(typeof view.nation.why, 'string');
  const r = await adapter(boardFetch({ view })).read(ARGS);
  assert.equal(r.status, 'ok');
  assert.deepEqual({ ...r.nation, note: null }, { status: 'unknown', nation: null, requests: null, deliveredFromNation: null, note: null });
  assert.equal(typeof r.nation.note, 'string');
  assert.deepEqual(r.mine.requests.map(q => q.need), [{ wood: 200, stone: 150 }]);
  assert.deepEqual(r.mine.responses.map(q => q.id), [recordId(theirs)]);
  const s = JSON.stringify({ ...r, limitations: undefined });
  for (const leak of [view.nation.why, view.nation.note, view.personal.nationWhy, OTHER]) assert.ok(!s.includes(leak), `leaked ${leak}`);
});

test('real coopView, empty board: every faction 0..5 the real view reports is a verified nation with zero counts', async () => {
  for (let f = 0; f < COOP_FACTIONS; f++) {
    const view = realBoardView({ citizens: { [citizenKey(OWNER)]: { status: 'verified', faction: f, citizen: 'fixture' } } });
    assert.strictEqual(view.nation.nation, f);
    const r = await adapter(boardFetch({ view })).read(ARGS);
    assert.equal(r.status, 'ok', `faction ${f}`);
    assert.deepEqual(r.nation, { status: 'verified', nation: f, requests: 0, deliveredFromNation: 0, note: null });
    assert.deepEqual(r.mine, { requests: [], responses: [], verified: {}, left: [] });
  }
});
