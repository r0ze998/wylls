// Tests for src/coop-read-adapter.mjs. Fixtures only: an injected fake fetch with fake streamed bodies, fake timers
// (no real timeout ever fires), no filesystem, no network. Independently verified: 34/34 (see COOP-READ-ADAPTER.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoopReadAdapter, normaliseBoardBase, COOP_READ_SCOPE, COOP_READ_LIMITATIONS } from '../src/coop-read-adapter.mjs';

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
  const req1 = {
    id: 'req-000001', goalId: 'g-vault', requester: OWNER, need: { Stone: 300 }, sig: 'SIG-REQUEST-SECRET', note: 'free text from a player',
    responses: { [OTHER]: { id: 'resp-0001', sig: 'SIG-RESPONSE-SECRET', note: 'free text reply' } }, stateNow: 'open',
    arrivals: [
      { requestId: 'req-000001', responder: OTHER, caravanId: 'cv-1', state: 'delivered', counted: { Stone: 120 }, proof: 'PROOF-SECRET' },
      { requestId: 'req-000001', responder: OTHER, caravanId: 'cv-2', state: 'moving', counted: null },
    ],
    fulfilment: { status: 'Partial', detail: 'x' }, sendings: [{ walletSig: 'WALLET-SIG-SECRET', outcome: { status: 'unknown', why: 'w' } }],
  };
  const req2 = {
    id: 'req-000002', goalId: 'g-vault', requester: OTHER, need: { Wood: 50 }, responses: { [OWNER]: { id: 'resp-0002', sig: 'SIG-OWNER-SECRET' } }, stateNow: 'open',
    arrivals: [{ requestId: 'req-000002', responder: OWNER, caravanId: 'cv-3', state: 'delivered', counted: { Wood: 50 } }], fulfilment: 'Fulfilled',
  };
  return {
    requests: [req1, req2],
    arrivals: [...req1.arrivals, ...req2.arrivals],
    joint: [{ goalId: 'g-vault', host: OWNER, contributors: [OTHER], why: 'free text verdict' }],
    nation: { nation: 'North', note: 'board note text', requests: 4, deliveredFromNation: 7 },
    personal: {
      viewer: OWNER, nation: 'North', nationWhy: null,
      myRequests: [{ id: 'req-000001', state: 'open', need: { Stone: 300 }, responses: req1.responses, arrivals: req1.arrivals, fulfilment: req1.fulfilment }],
      myResponses: [{ id: 'req-000002', requester: OTHER, response: req2.responses[OWNER], arrivals: req2.arrivals }],
      myVerified: { Wood: 50 }, left: ['g-vault'],
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
    nation: { nation: 'North', note: 'n', requests: 0, deliveredFromNation: 0 },
    personal: { viewer: OWNER, nation: 'North', nationWhy: null, myRequests: [], myResponses: [], myVerified: {}, left: [] },
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
    v => { v.personal.nation = 'South'; },
    v => { delete v.personal.myRequests; },
    v => { v.personal.myVerified = { Wood: 0 }; },
    v => { v.personal.myRequests[0].id = 'req-missing'; },
    v => { v.personal.myRequests.push({ ...v.personal.myRequests[0] }); },
    v => { v.personal.myRequests[0].need = { Stone: 1.5 }; },
    v => { v.personal.myRequests[0].arrivals = 'many'; },
    v => { v.requests[0].requester = OTHER; },
    v => { v.personal.myResponses[0].arrivals = [{ responder: OTHER, counted: { Wood: 1 } }]; },
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
  assert.deepEqual(r.nation, { status: 'verified', nation: 'North', requests: 0, deliveredFromNation: 0, note: null });
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
    nation: { status: 'verified', nation: 'North', requests: 4, deliveredFromNation: 7, note: null },
    mine: {
      requests: [{ id: 'req-000001', state: 'open', need: { Stone: 300 }, entries: { listed: 2, counted: 1 }, fulfilment: 'Partial' }],
      responses: [{ id: 'req-000002', responded: true, myEntries: { listed: 1, counted: 1 } }],
      verified: { Wood: 50 },
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
