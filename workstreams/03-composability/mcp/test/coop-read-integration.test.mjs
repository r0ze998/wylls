// get_cooperation_status wired into the real MCP server logic (src/server.mjs createWyllsMcp → handle), with the real
// adapter (src/coop-read-adapter.mjs) and the launcher's pure settings (bin/coop-read-settings.mjs). Fixtures only:
// an injected principal, game, store and auth stub, a fake fetch with fake streamed bodies, idle fake timers. No
// real keys, signatures, network, child processes, timers or filesystem writes. Written by the implementation session; independently executed by the coordinator on 2026-11-17 UTC:
// 26/26 passed (see COOP-READ-ADAPTER.md); separate from the 34/34 adapter unit suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWyllsMcp } from '../src/server.mjs';
import { COOP_TOOL, TOOLS } from '../src/tools.mjs';
import { createCoopReadAdapter } from '../src/coop-read-adapter.mjs';
import { coopReadSettings } from '../bin/coop-read-settings.mjs';
import { STATES, TERMINAL } from '../src/ports.mjs';
import { createHandler } from '../src/http.mjs';

const OWNER = 'Hv7mQ9xT3kPz2RbW5cYfN8dLsJ4gAeUq6tBnVr1oXy';
const OTHER = 'Gk3pZ8wR2nTq5vYc7bMd9fHs4jKe6gAu1xWr2tNmPz';
const PROGRAM = 'Prog' + '1'.repeat(40);
const BASE = 'https://board.example';
const enc = new TextEncoder();
const T0 = 1_800_000_000_000;

// ------------------------------------------------------------------ fakes

function streamBody(bytes, size = 64) {
  let at = 0;
  return { getReader: () => ({
    read: async () => { if (at >= bytes.length) return { done: true, value: undefined }; const value = bytes.slice(at, at + size); at += size; return { done: false, value }; },
    cancel: async () => {},
  }) };
}
function response(doc, { status = 200 } = {}) {
  const bytes = enc.encode(typeof doc === 'string' ? doc : JSON.stringify(doc));
  return { status, redirected: false, type: 'basic', url: '', headers: { get: () => null }, body: streamBody(bytes),
    text() { throw new Error('text() must not be called'); }, json() { throw new Error('json() must not be called'); } };
}
/** A board: /coop/config answers `config` the first time and `config2` after; /coop/view answers `view`. */
function boardFetch({ config = configDoc(), config2, view = viewDoc() } = {}) {
  const calls = [];
  let configReads = 0;
  const fetch = (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/coop/config') { configReads += 1; return Promise.resolve(response(configReads === 1 ? config : (config2 ?? config))); }
    if (u.pathname === '/coop/view') return Promise.resolve(response(view));
    return Promise.resolve(response({ error: 'not here' }, { status: 404 }));
  };
  fetch.calls = calls;
  return fetch;
}
const idleTimers = () => ({ setTimeout: () => 1, clearTimeout: () => {} });
const adapterOf = fetch => createCoopReadAdapter({ publicViewConfirmed: true, baseUrl: BASE, fetch, timers: idleTimers() });

/** The server's game: only context() (and view() for prepare_caravan) are used here. contexts: one per call, the last repeats. */
function fakeGame(contexts = [{ key: `${PROGRAM}:3`, programId: PROGRAM, seasonId: '3', since: '2026-11-18T00:00:00.000Z' }]) {
  const g = {
    contextCalls: 0, viewCalls: 0, contextChanges: [],
    async context() {
      const c = contexts[Math.min(g.contextCalls, contexts.length - 1)];
      g.contextCalls += 1;
      if (c instanceof Error) throw c;
      return c;
    },
    async view() { g.viewCalls += 1; return { agent: { policy: { version: 1, allowed: ['SendCaravan'] }, modeEpoch: 0, village: [0, 0, 0] }, places: [], caravans: [], citizen: { caravans: 0 } }; },
  };
  return g;
}
/** operations: initial db.operations. archive() records and removes, as a store moving it to the archive would. */
function fakeStore(operations = {}) {
  const saves = { n: 0 };
  const archived = [];
  const state = { plans: {}, operations: { ...operations }, links: {} };
  return { saves, archived, state, save() { saves.n += 1; }, operation: () => null, operationsOf: () => [], operationsWithRequestId: () => [],
    operationsOfRun: () => ({ operations: [], total: 0 }), archive(op) { archived.push(op.id); delete state.operations[op.id]; } };
}
/** A finished operation long past ARCHIVE_AFTER_MS at T0: the archive sweep would move it. */
const oldTerminalOp = () => ({ op_old_terminal_0001: { id: 'op_old_terminal_0001', state: TERMINAL.includes(STATES.COMPLETED) ? STATES.COMPLETED : TERMINAL[0], planId: 'pln_old', linkId: 'lnk_test_0001',
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', steps: [] } });
const fakeAuth = () => ({ wwwAuthenticate: params => `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", ${params}`, link: () => null, linksOf: () => [] });

const principalOf = (over = {}) => ({ owner: OWNER, agentId: 'agent-0001', linkId: 'lnk_test_0001', scopes: ['wylls.read'], tokenExpiresAt: T0 + 3600_000, ...over });

function server({ fetch = boardFetch(), coop = true, cluster = 'localnet', game = fakeGame(), store = fakeStore(), now = () => T0 } = {}) {
  const coopRead = coop ? { adapter: adapterOf(fetch), cluster } : null;
  const mcp = createWyllsMcp({ auth: fakeAuth(), game, store, now, coopRead });
  return { mcp, fetch, game, store };
}

let nextId = 1;
const call = (mcp, name, args = {}, principal = principalOf()) => mcp.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, principal);
const list = mcp => mcp.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, null);

// ------------------------------------------------------------------ board fixtures (coop/board.mjs, coop/goal.mjs shapes)

const ctx = (programId = PROGRAM, seasonId = '3') => ({ programId, seasonId });
function configDoc(over = {}) {
  return { season: ctx(), contexts: [ctx()], cluster: 'localnet', page: '/ws01/repo/coop/index.html', goals: {}, judges: [], judge: 'arrivals',
    herald: 'http://127.0.0.1:9000', chain: true, damaged: [], relay: '/gw', rpcProxy: false, store: { segments: [], problems: [] }, ...over };
}
function viewDoc(over = {}) {
  const req1 = { id: 'req-000001', goalId: 'g-vault', requester: OWNER, need: { Stone: 300 }, responses: { [OTHER]: { id: 'resp-0001', sig: 'SIG-SECRET' } }, stateNow: 'open',
    arrivals: [{ responder: OTHER, state: 'delivered', counted: { Stone: 120 } }, { responder: OTHER, state: 'moving', counted: null }], fulfilment: { status: 'Partial' } };
  const req2 = { id: 'req-000002', goalId: 'g-vault', requester: OTHER, need: { Wood: 50 }, responses: { [OWNER]: { id: 'resp-0002' } }, stateNow: 'open',
    arrivals: [{ responder: OWNER, state: 'delivered', counted: { Wood: 50 } }], fulfilment: 'Fulfilled' };
  return {
    requests: [req1, req2], arrivals: [], joint: [],
    nation: { nation: 'North', note: 'n', requests: 4, deliveredFromNation: 7 },
    personal: { viewer: OWNER, nation: 'North', nationWhy: null,
      myRequests: [{ id: 'req-000001', state: 'open', need: { Stone: 300 }, responses: req1.responses, arrivals: req1.arrivals, fulfilment: req1.fulfilment }],
      myResponses: [{ id: 'req-000002', requester: OTHER, response: req2.responses[OWNER], arrivals: req2.arrivals }], myVerified: { Wood: 50 }, left: [] },
    rejected: [], judges: [], heraldFeed: { moving: 0, ended: 0 }, chain: true, damaged: [], contexts: [ctx()], store: { segments: 0, problems: [] }, token: 'TOKEN-SECRET',
    ...over,
  };
}

// ------------------------------------------------------------------ settings (pure)

test('settings: off by default, explicit opt-in with board and cluster', () => {
  assert.deepEqual({ ...coopReadSettings({}) }, { enabled: false });
  assert.deepEqual({ ...coopReadSettings({ WYLLS_MCP_COOP_PUBLIC_BOARD: '' }) }, { enabled: false });
  assert.deepEqual({ ...coopReadSettings({ WYLLS_MCP_COOP_PUBLIC_BOARD: '1', WYLLS_MCP_COOP_BOARD: 'https://board.example/ws01/', WYLLS_MCP_COOP_CLUSTER: 'localnet' }) },
    { enabled: true, baseUrl: 'https://board.example/ws01', origin: 'https://board.example', cluster: 'localnet' });
});

test('settings: half or bad configurations are errors, and errors never echo the value', () => {
  const on = { WYLLS_MCP_COOP_PUBLIC_BOARD: '1', WYLLS_MCP_COOP_BOARD: BASE, WYLLS_MCP_COOP_CLUSTER: 'localnet' };
  const bad = [
    { WYLLS_MCP_COOP_BOARD: BASE },
    { WYLLS_MCP_COOP_CLUSTER: 'localnet' },
    { ...on, WYLLS_MCP_COOP_PUBLIC_BOARD: 'true' },
    { ...on, WYLLS_MCP_COOP_PUBLIC_BOARD: 'yes' },
    { ...on, WYLLS_MCP_COOP_BOARD: undefined },
    { ...on, WYLLS_MCP_COOP_BOARD: 'https://user:SECRETPW@board.example' },
    { ...on, WYLLS_MCP_COOP_BOARD: 'https://board.example/?token=SECRETPW' },
    { ...on, WYLLS_MCP_COOP_BOARD: 'https://board.example/#SECRETPW' },
    { ...on, WYLLS_MCP_COOP_BOARD: 'ftp://board.example' },
    { ...on, WYLLS_MCP_COOP_BOARD: ` ${BASE}` },
    { ...on, WYLLS_MCP_COOP_CLUSTER: undefined },
    { ...on, WYLLS_MCP_COOP_CLUSTER: 'Main Net' },
    { ...on, WYLLS_MCP_COOP_CLUSTER: '-x' },
  ];
  for (const env of bad) {
    const s = coopReadSettings(env);
    assert.equal(typeof s.error, 'string', JSON.stringify(env));
    assert.ok(!s.error.includes('SECRETPW'));
    assert.equal(s.enabled, undefined);
  }
});

// ------------------------------------------------------------------ disabled: not listed, not callable, no fetch

test('disabled (no coopRead): tools/list is exactly the existing TOOLS and the tool is unknown, with zero fetches', async () => {
  const fetch = boardFetch();
  const { mcp } = server({ fetch, coop: false });
  const l = await list(mcp);
  assert.deepEqual(l.result.tools, TOOLS);
  assert.ok(!mcp.tools.includes('get_cooperation_status'));
  const r = await call(mcp, 'get_cooperation_status');
  assert.equal(r.error.code, -32602);
  assert.equal(fetch.calls.length, 0);
});

test('disabled adapter (publicViewConfirmed not true) is off: not listed, not callable, zero fetches', async () => {
  const fetch = boardFetch();
  const adapter = createCoopReadAdapter({ fetch, baseUrl: BASE });
  const mcp = createWyllsMcp({ auth: fakeAuth(), game: fakeGame(), store: fakeStore(), now: () => T0, coopRead: { adapter, cluster: 'localnet' } });
  assert.deepEqual((await list(mcp)).result.tools, TOOLS);
  assert.equal((await call(mcp, 'get_cooperation_status')).error.code, -32602);
  assert.equal(fetch.calls.length, 0);
});

test('a malformed coopRead is a deployment error, not a quiet off', () => {
  const fetch = boardFetch();
  const make = coopRead => () => createWyllsMcp({ auth: fakeAuth(), game: fakeGame(), store: fakeStore(), coopRead });
  assert.throws(make({ adapter: adapterOf(fetch), cluster: 'Main Net' }), TypeError);
  assert.throws(make({ adapter: adapterOf(fetch) }), TypeError);
  assert.throws(make({ adapter: { enabled: true }, cluster: 'localnet' }), TypeError);
  assert.throws(make({ cluster: 'localnet' }), TypeError);
  assert.throws(make('on'), TypeError);
  assert.equal(fetch.calls.length, 0);
});

// ------------------------------------------------------------------ enabled: discovery

test('enabled: tools/list is the existing TOOLS unchanged plus get_cooperation_status, honestly annotated', async () => {
  const { mcp, fetch } = server();
  const tools = (await list(mcp)).result.tools;
  assert.equal(tools.length, TOOLS.length + 1);
  assert.deepEqual(tools.slice(0, TOOLS.length), TOOLS);
  const t = tools.at(-1);
  assert.deepEqual(t, COOP_TOOL);
  assert.equal(t.name, 'get_cooperation_status');
  assert.deepEqual(t.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.deepEqual(t.securitySchemes, [{ type: 'oauth2', scopes: ['wylls.read'] }]);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.equal(t.annotations.destructiveHint, false);
  assert.equal(t.annotations.openWorldHint, true);
  assert.match(t.description, /observation cache/);
  assert.match(t.description, /no send authority/);
  assert.match(t.description, /no recipient or target list/);
  assert.ok(mcp.tools.includes('get_cooperation_status'));
  assert.equal(fetch.calls.length, 0);
});

// ------------------------------------------------------------------ auth, scope, arguments: refused before any fetch

test('unauthenticated call is refused before any fetch', async () => {
  const { mcp, fetch, game } = server();
  const r = await call(mcp, 'get_cooperation_status', {}, null);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.structuredContent.error.code, 'Unauthenticated');
  assert.equal(fetch.calls.length, 0);
  assert.equal(game.contextCalls, 0);
});

test('missing wylls.read scope is refused (step-up) before any fetch', async () => {
  const { mcp, fetch, game } = server();
  for (const scopes of [[], ['wylls.caravan']]) {
    const r = await call(mcp, 'get_cooperation_status', {}, principalOf({ scopes }));
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'InsufficientScope');
    assert.equal(r.result.structuredContent.error.scope, 'wylls.read');
    assert.ok(Array.isArray(r.result._meta['mcp/www_authenticate']));
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal(game.contextCalls, 0);
});

test('any argument (viewer, owner, world, url) is refused before any fetch', async () => {
  const { mcp, fetch, game } = server();
  for (const args of [{ viewer: OTHER }, { owner: OTHER }, { programId: PROGRAM, seasonId: '2' }, { cluster: 'devnet' }, { url: 'https://evil.example' }, { baseUrl: BASE }, [], 'x', 1]) {
    const r = await call(mcp, 'get_cooperation_status', args);
    assert.equal(r.result.isError, true, JSON.stringify(args));
    assert.equal(r.result.structuredContent.error.code, 'BadRequest');
  }
  assert.equal(fetch.calls.length, 0);
  assert.equal(game.contextCalls, 0);
});

test('null or omitted arguments read as no arguments', async () => {
  const { mcp } = server();
  const r = await mcp.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'get_cooperation_status' } }, principalOf());
  assert.equal(r.result.isError, false);
});

// ------------------------------------------------------------------ owner binding and trusted world

test('the viewer is exactly the authenticated owner and the world is the server\'s current context with the configured cluster', async () => {
  const { mcp, fetch, game, store } = server();
  const r = await call(mcp, 'get_cooperation_status');
  assert.equal(r.result.isError, false);
  assert.deepEqual(fetch.calls.map(c => c.url), [`${BASE}/coop/config`, `${BASE}/coop/view?viewer=${OWNER}`, `${BASE}/coop/config`]);
  for (const { init } of fetch.calls) { assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual'); }
  const s = r.result.structuredContent;
  assert.equal(s.ok, true);
  assert.equal(s.owner, OWNER);
  assert.deepEqual(s.world, { programId: PROGRAM, seasonId: '3', cluster: 'localnet' });
  assert.deepEqual(s.nation, { status: 'verified', nation: 'North', requests: 4, deliveredFromNation: 7, note: null });
  assert.deepEqual(s.mine.requests, [{ id: 'req-000001', state: 'open', need: { Stone: 300 }, entries: { listed: 2, counted: 1 }, fulfilment: 'Partial' }]);
  assert.deepEqual(s.mine.responses, [{ id: 'req-000002', responded: true, myEntries: { listed: 1, counted: 1 } }]);
  assert.deepEqual(JSON.parse(r.result.content[0].text), s);
  assert.ok(game.contextCalls >= 1);
  assert.equal(store.saves.n, 0); // the read stores nothing
  const text = JSON.stringify(s);
  for (const leak of [OTHER, 'SIG-SECRET', 'TOKEN-SECRET', '127.0.0.1:9000']) assert.ok(!text.includes(leak), leak);
});

test('another authenticated owner is read as that owner only', async () => {
  const fetch = boardFetch({ view: viewDoc({ personal: { viewer: OTHER, nation: 'North', nationWhy: null, myRequests: [], myResponses: [], myVerified: {}, left: [] } }) });
  const { mcp } = server({ fetch });
  const r = await call(mcp, 'get_cooperation_status', {}, principalOf({ owner: OTHER, linkId: 'lnk_test_0002' }));
  assert.equal(fetch.calls[1].url, `${BASE}/coop/view?viewer=${OTHER}`);
  assert.equal(r.result.structuredContent.owner, OTHER);
});

test('a board that answers for another wallet than the owner fails closed', async () => {
  const fetch = boardFetch({ view: viewDoc({ personal: { ...viewDoc().personal, viewer: OTHER } }) });
  const r = await call(server({ fetch }).mcp, 'get_cooperation_status');
  assert.equal(r.result.isError, true);
  assert.equal(r.result.structuredContent.error.code, 'CoopBoardMismatch');
  assert.equal(r.result.structuredContent.error.cooperation.mine, null);
});

test('current context unavailable or malformed: refused before any board fetch', async () => {
  for (const c of [new Error('relay down'), null, { key: 'x:3', programId: PROGRAM, seasonId: '3' }, { programId: 42, seasonId: '3' }]) {
    const fetch = boardFetch();
    const r = await call(server({ fetch, game: fakeGame([c]) }).mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'ContextUnavailable');
    assert.equal(fetch.calls.length, 0);
  }
});

test('board of another world than the server\'s current context fails closed after the first config read', async () => {
  const fetch = boardFetch();
  const game = fakeGame([{ key: `${PROGRAM}:4`, programId: PROGRAM, seasonId: '4', since: 'x' }]);
  const r = await call(server({ fetch, game }).mcp, 'get_cooperation_status');
  assert.equal(r.result.structuredContent.error.code, 'CoopBoardMismatch');
  assert.equal(fetch.calls.length, 1);
});

test('board of another cluster than the configured one fails closed', async () => {
  const fetch = boardFetch();
  const r = await call(server({ fetch, cluster: 'devnet' }).mcp, 'get_cooperation_status');
  assert.equal(r.result.structuredContent.error.code, 'CoopBoardMismatch');
  assert.equal(fetch.calls.length, 1);
});

test('the server\'s world changing during the read fails closed', async () => {
  const game = fakeGame([{ key: `${PROGRAM}:3`, programId: PROGRAM, seasonId: '3' }, { key: `${PROGRAM}:4`, programId: PROGRAM, seasonId: '4' }]);
  const r = await call(server({ game }).mcp, 'get_cooperation_status');
  assert.equal(r.result.isError, true);
  assert.equal(r.result.structuredContent.error.code, 'ContextChanged');
  assert.equal(r.result.structuredContent.nation, undefined);
});

// ------------------------------------------------------------------ malformed / changed / unsupported / damaged board

test('malformed, changed, multi-context, damaged and unreachable boards fail closed with no partial data', async () => {
  const cases = [
    [{ view: viewDoc({ nation: { nation: 'North', requests: '4', deliveredFromNation: 7 } }) }, 'CoopBoardMalformed'],
    [{ config2: configDoc({ judge: 'vault' }) }, 'CoopBoardChanged'],
    [{ config2: configDoc({ season: ctx(PROGRAM, '4'), contexts: [ctx(PROGRAM, '4')] }) }, 'CoopBoardChanged'],
    [{ config: configDoc({ contexts: [ctx(), ctx(PROGRAM, '2')] }) }, 'CoopBoardUnsupported'],
    [{ config: configDoc({ store: { segments: [], problems: ['truncated'] } }) }, 'CoopBoardDamaged'],
    [{ config: 'not json' }, 'CoopBoardUnavailable'],
  ];
  for (const [board, code] of cases) {
    const r = await call(server({ fetch: boardFetch(board) }).mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, true, code);
    const e = r.result.structuredContent.error;
    assert.equal(e.code, code);
    assert.equal(e.cooperation.ok, false);
    assert.equal(e.cooperation.nation, null);
    assert.equal(e.cooperation.mine, null);
    assert.equal(r.result.structuredContent.ok, false);
  }
});

// ------------------------------------------------------------------ existing dispatch preserved

test('the cooperation tool goes through the same rate limit as every tool', async () => {
  const { mcp } = server();
  for (let i = 0; i < 30; i++) assert.equal((await call(mcp, 'get_cooperation_status')).result.isError, false, `call ${i}`);
  const r = await call(mcp, 'get_cooperation_status');
  assert.equal(r.result.structuredContent.error.code, 'RateLimited');
});

test('existing tools answer the same with the cooperation read on or off, and touch no board', async () => {
  const fetch = boardFetch();
  const on = server({ fetch }).mcp;
  const off = server({ coop: false }).mcp;
  const strip = r => ({ ...r, id: null });
  const calls = [
    ['send_caravan', { planId: 'pln_x', requestId: 'req-000001' }, principalOf()],            // no caravan scope: InsufficientScope
    ['prepare_caravan', { from: 'a', to: 'b', cargo: { Mud: 1 } }, principalOf()],              // unknown resource: BadRequest
    ['list_operations', {}, principalOf()],
    ['get_operation_status', {}, principalOf()],                                               // neither id: BadRequest
    ['get_run_status', { runId: 'x' }, principalOf()],                                          // malformed runId: BadRequest
    ['no_such_tool', {}, principalOf()],
    ['get_village_status', {}, null],                                                          // unauthenticated
  ];
  for (const [name, args, p] of calls) {
    const a = await call(on, name, args, p);
    const b = await call(off, name, args, p);
    assert.deepEqual(strip(a), strip(b), name);
  }
  assert.equal(fetch.calls.length, 0);
  const send = await call(on, 'send_caravan', { planId: 'pln_x', requestId: 'req-000002' });
  assert.equal(send.result.structuredContent.error.code, 'InsufficientScope');
  assert.equal(send.result.structuredContent.error.scope, 'wylls.caravan');
});

// ------------------------------------------------------------------ regression: the read stores nothing (no archive sweep)

test('regression: successful and refused cooperation reads never save or archive, with an old finished operation present', async () => {
  const store = fakeStore(oldTerminalOp());
  const fetch = boardFetch();
  const { mcp } = server({ fetch, store });
  const outcomes = [
    await call(mcp, 'get_cooperation_status'),                                          // ok
    await call(mcp, 'get_cooperation_status', { viewer: OTHER }),                       // BadRequest
    await call(mcp, 'get_cooperation_status', {}, principalOf({ scopes: [] })),         // InsufficientScope
    await call(mcp, 'get_cooperation_status', {}, null),                                // Unauthenticated (before dispatch)
  ];
  assert.equal(outcomes[0].result.isError, false);
  assert.deepEqual(outcomes.slice(1).map(r => r.result.structuredContent.error.code), ['BadRequest', 'InsufficientScope', 'Unauthenticated']);
  const failing = server({ fetch: boardFetch({ config: configDoc({ cluster: 'devnet' }) }), store }).mcp;
  assert.equal((await call(failing, 'get_cooperation_status')).result.structuredContent.error.code, 'CoopBoardMismatch');
  assert.equal(store.saves.n, 0);
  assert.deepEqual(store.archived, []);
  assert.ok(store.state.operations.op_old_terminal_0001);
});

test('regression control: an existing read tool still runs the archive sweep exactly as before', async () => {
  const store = fakeStore(oldTerminalOp());
  const { mcp, fetch } = server({ store });
  const r = await call(mcp, 'list_operations');
  assert.equal(r.result.isError, false);
  assert.deepEqual(store.archived, ['op_old_terminal_0001']);
  assert.ok(store.saves.n >= 1);
  assert.equal(fetch.calls.length, 0);
});

// ------------------------------------------------------------------ in-process HTTP (createHandler), no socket

/** A fake IncomingMessage: async-iterable Buffer chunks; no socket is opened. */
function fakeReq({ method = 'POST', url = '/mcp', headers = {}, body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}
/** A fake ServerResponse: records writeHead and end; body bounded. */
function fakeRes() {
  const r = { status: null, headers: null, body: '', ended: false,
    writeHead(status, headers = {}) { r.status = status; r.headers = headers; return r; },
    end(text = '') { if (r.ended) throw new Error('ended twice'); r.ended = true; r.body = String(text).slice(0, 256 * 1024); } };
  return r;
}
/** auth for createHandler: issuer, now, wwwAuthenticate, principal(Authorization). Only one fixed fake token is known. */
function httpAuth(principal = principalOf()) {
  return { ...fakeAuth(), issuer: 'http://127.0.0.1:41960', resource: 'http://127.0.0.1:41960/mcp', now: () => T0,
    principal(header) {
      if (header === 'Bearer fake-test-token') return principal;
      throw Object.assign(new Error('no valid token'), { error: 'invalid_token' });
    } };
}
async function post(handler, body, headers = { authorization: 'Bearer fake-test-token' }) {
  const res = fakeRes();
  await handler(fakeReq({ body, headers }), res);
  assert.equal(res.ended, true);
  return { status: res.status, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}

test('HTTP: POST /mcp with no or a bad token is 401 and reads no board', async () => {
  const { mcp, fetch } = server();
  const handler = createHandler({ auth: httpAuth(), mcp });
  const msg = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cooperation_status', arguments: {} } };
  for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
    const r = await post(handler, msg, headers);
    assert.equal(r.status, 401);
    assert.ok(r.headers['www-authenticate']);
  }
  assert.equal(fetch.calls.length, 0);
});

test('HTTP: tools/list and tools/call through createHandler answer as handle does (on and off)', async () => {
  const on = server({ store: fakeStore(oldTerminalOp()) });
  const hOn = createHandler({ auth: httpAuth(), mcp: on.mcp });
  const listed = await post(hOn, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.result.tools.map(t => t.name), [...TOOLS.map(t => t.name), 'get_cooperation_status']);
  const r = await post(hOn, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_cooperation_status', arguments: {} } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.isError, false);
  assert.equal(r.json.result.structuredContent.owner, OWNER);
  assert.deepEqual(on.fetch.calls.map(c => c.url), [`${BASE}/coop/config`, `${BASE}/coop/view?viewer=${OWNER}`, `${BASE}/coop/config`]);
  assert.equal(on.store.saves.n, 0);
  assert.deepEqual(on.store.archived, []);
  const extra = await post(hOn, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_cooperation_status', arguments: { viewer: OTHER } } });
  assert.equal(extra.json.result.structuredContent.error.code, 'BadRequest');
  assert.equal(on.fetch.calls.length, 3);

  const off = server({ coop: false });
  const hOff = createHandler({ auth: httpAuth(), mcp: off.mcp });
  assert.deepEqual((await post(hOff, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).json.result.tools, TOOLS);
  const unknown = await post(hOff, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_cooperation_status', arguments: {} } });
  assert.equal(unknown.json.error.code, -32602);
  assert.equal(off.fetch.calls.length, 0);
});

test('HTTP: a missing read scope through createHandler is the step-up error and reads no board', async () => {
  const { mcp, fetch } = server();
  const handler = createHandler({ auth: httpAuth(principalOf({ scopes: ['wylls.caravan'] })), mcp });
  const r = await post(handler, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_cooperation_status', arguments: {} } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.structuredContent.error.code, 'InsufficientScope');
  assert.equal(fetch.calls.length, 0);
});

test('initialize and ping are unchanged by the cooperation read', async () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const a = await server().mcp.handle(init, null);
  const b = await server({ coop: false }).mcp.handle(init, null);
  assert.deepEqual(a, b);
  assert.deepEqual(await server().mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping' }, null), { jsonrpc: '2.0', id: 2, result: {} });
});
