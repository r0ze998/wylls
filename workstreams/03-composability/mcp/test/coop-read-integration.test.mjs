// Final world-cache coordinator verification 2026-11-17 UTC: 83/83 passed (adapter 41 + integration 42).
// Final coordinator validation 2026-11-17 UTC: corrected-contract suites passed 74/74 (adapter 41 + integration 33).
// get_cooperation_status wired into the real MCP server logic (src/server.mjs createWyllsMcp → handle), with the real
// adapter (src/coop-read-adapter.mjs) and the launcher's pure settings (bin/coop-read-settings.mjs). Fixtures only:
// an injected principal, game, store and auth stub, a fake fetch with fake streamed bodies, idle fake timers. No
// real keys, signatures, network, child processes or filesystem writes; SDK request timeout timers are real. Written by the implementation session; independently executed by the coordinator on 2026-11-17 UTC:
// 31/31 passed including SDK transport tests (see COOP-READ-ADAPTER.md); separate from the 34/34 adapter unit suite.
// 2026-11-18 real-board contract fix: those runs used fixtures with an invented string nation ('North') and capitalised
// resources ('Stone'), which the real board never sends. The fixtures now use the board's shapes (numeric zero-based
// faction, lowercase resources, fulfilment {status}), and two regression tests at the end pass the output of the real,
// pure coopView (coop/goal.mjs) and fold (coop/record.mjs) through the real adapter and the real MCP dispatch. Not
// createBoard: no board process, no fs write, no signature, no address derivation. The suite as it now stands has NOT
// been executed by the session that wrote it.
// 2026-11-18 Game context cache fix: the tests at the end ("real Game …") use the real src/game.mjs Game with a fake relay
// fetch, a fixed clock and injected addressesFor constants (no address derivation, no herald request). Written, NOT
// executed by the session that wrote them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWyllsMcp } from '../src/server.mjs';
import { Game, GameError } from '../src/game.mjs';
import { COOP_TOOL, TOOLS } from '../src/tools.mjs';
import { createCoopReadAdapter } from '../src/coop-read-adapter.mjs';
import { coopReadSettings } from '../bin/coop-read-settings.mjs';
import { STATES, TERMINAL } from '../src/ports.mjs';
import { createHandler } from '../src/http.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { coopView, GOALS } from '../../../01-national-strategy/coop/goal.mjs';
import { fold, recordId } from '../../../01-national-strategy/coop/record.mjs';

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
  const req1 = { id: 'req-000001', goalId: 'g-vault', requester: OWNER, need: { stone: 300 }, responses: { [OTHER]: { id: 'resp-0001', sig: 'SIG-SECRET' } }, stateNow: 'open',
    arrivals: [{ responder: OTHER, state: 'delivered', counted: { stone: 120 } }, { responder: OTHER, state: 'moving', counted: null }], fulfilment: { status: 'undetermined' } };
  const req2 = { id: 'req-000002', goalId: 'g-vault', requester: OTHER, need: { wood: 50 }, responses: { [OWNER]: { id: 'resp-0002' } }, stateNow: 'open',
    arrivals: [{ responder: OWNER, state: 'delivered', counted: { wood: 50 } }], fulfilment: { status: 'fulfilled' } };
  return {
    requests: [req1, req2], arrivals: [], joint: [],
    nation: { nation: 2, note: 'n', requests: 4, deliveredFromNation: 7 },
    personal: { viewer: OWNER, nation: 2, nationWhy: null,
      myRequests: [{ id: 'req-000001', state: 'open', need: { stone: 300 }, responses: req1.responses, arrivals: req1.arrivals, fulfilment: req1.fulfilment }],
      myResponses: [{ id: 'req-000002', requester: OTHER, response: req2.responses[OWNER], arrivals: req2.arrivals }], myVerified: { wood: 50 }, left: [] },
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
  assert.deepEqual(s.nation, { status: 'verified', nation: 2, requests: 4, deliveredFromNation: 7, note: null });
  assert.deepEqual(s.mine.requests, [{ id: 'req-000001', state: 'open', need: { stone: 300 }, entries: { listed: 2, counted: 1 }, fulfilment: 'undetermined' }]);
  assert.deepEqual(s.mine.verified, { wood: 50 });
  assert.deepEqual(s.mine.responses, [{ id: 'req-000002', responded: true, myEntries: { listed: 1, counted: 1 } }]);
  assert.deepEqual(JSON.parse(r.result.content[0].text), s);
  assert.ok(game.contextCalls >= 1);
  assert.equal(store.saves.n, 0); // the read stores nothing
  const text = JSON.stringify(s);
  for (const leak of [OTHER, 'SIG-SECRET', 'TOKEN-SECRET', '127.0.0.1:9000']) assert.ok(!text.includes(leak), leak);
});

test('another authenticated owner is read as that owner only', async () => {
  const fetch = boardFetch({ view: viewDoc({ personal: { viewer: OTHER, nation: 2, nationWhy: null, myRequests: [], myResponses: [], myVerified: {}, left: [] } }) });
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
    [{ view: viewDoc({ nation: { nation: 2, requests: '4', deliveredFromNation: 7 } }) }, 'CoopBoardMalformed'],
    [{ view: viewDoc({ nation: { nation: 'North', requests: 4, deliveredFromNation: 7 }, personal: { ...viewDoc().personal, nation: 'North' } }) }, 'CoopBoardMalformed'], // a name is not the board's nation
    [{ view: viewDoc({ nation: { nation: 6, requests: 4, deliveredFromNation: 7 }, personal: { ...viewDoc().personal, nation: 6 } }) }, 'CoopBoardMalformed'],             // beyond the six factions
    [{ view: viewDoc({ personal: { ...viewDoc().personal, myVerified: { Wood: 50 } } }) }, 'CoopBoardMalformed'],                                                         // capitalised resource
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

// ------------------------------------------------------------------ official SDK client transport, in-process HTTP
// The pinned @modelcontextprotocol/sdk Client and StreamableHTTPClientTransport, with an injected fetch that hands each
// request to the real createHandler as fake request/response objects. No socket, no listen, no network, no real
// OAuth (stub auth, one fixed fake bearer string), no world. This is SDK transport evidence, not a live client/server
// OAuth or world proof.

const SDK_ORIGIN = 'http://127.0.0.1:41960'; // httpAuth().issuer
const SDK_URL = `${SDK_ORIGIN}/mcp`;
const SDK_TIMEOUT = { timeout: 5000 };
const FAKE_BEARER = 'Bearer fake-test-token'; // the one value httpAuth() accepts

/** fetch for the SDK transport → createHandler. Exact origin and /mcp only; POST/GET/DELETE only; bounded bodies. */
function bridgeFetch(handler) {
  const seen = [];
  const f = async (input, init = {}) => {
    let url, method, body = null;
    let headers = new Headers();
    if (typeof Request === 'function' && input instanceof Request) {
      url = new URL(input.url); method = input.method; headers = new Headers(input.headers);
      if (input.body) body = await input.text();
    } else if (input instanceof URL) url = new URL(input.href);
    else if (typeof input === 'string') url = new URL(input);
    else throw new TypeError('bridge: unsupported fetch input');
    method = String(init.method ?? method ?? 'GET').toUpperCase();
    if (init.headers) for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
    if (init.body !== undefined && init.body !== null) body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (url.origin !== SDK_ORIGIN || url.pathname !== '/mcp' || url.search !== '' || url.hash !== '') throw new TypeError('bridge: only the test origin\'s /mcp');
    if (!['POST', 'GET', 'DELETE'].includes(method)) throw new TypeError(`bridge: method ${method} not bridged`);
    if (body !== null && Buffer.byteLength(body, 'utf8') > 64 * 1024) throw new TypeError('bridge: body too large');
    const reqHeaders = Object.fromEntries(headers); // Headers names are lower case, as node:http gives them
    const res = fakeRes();
    await handler(fakeReq({ method, url: '/mcp', headers: reqHeaders, body }), res);
    if (!res.ended) throw new Error('bridge: the handler did not end the response');
    seen.push({ method, status: res.status, authorization: reqHeaders.authorization ?? null, rpc: body ? (() => { try { return JSON.parse(body).method ?? null; } catch { return null; } })() : null });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers ?? {})) if (v !== undefined && v !== null) out.set(k, String(v));
    const empty = res.body === '' || [204, 205, 304].includes(res.status);
    return new Response(empty ? null : res.body, { status: res.status, headers: out });
  };
  f.seen = seen;
  return f;
}

/** Runs fn with globalThis.fetch replaced by a thrower (restored after): the SDK must use only the injected fetch. */
async function noGlobalFetch(fn) {
  const original = globalThis.fetch;
  let used = 0;
  globalThis.fetch = async () => { used += 1; throw new Error('global fetch must not be used'); };
  try { await fn(); } finally { globalThis.fetch = original; }
  assert.equal(used, 0, 'global fetch was used');
}

/** An SDK client over the bridge; always closed by the caller (finally). */
function sdkClient(handler, { authorization = FAKE_BEARER } = {}) {
  const fetch = bridgeFetch(handler);
  const transport = new StreamableHTTPClientTransport(new URL(SDK_URL), { fetch, requestInit: authorization ? { headers: { Authorization: authorization } } : {} });
  const client = new Client({ name: 'wylls-coop-read-sdk-test', version: '0.0.0' });
  return { client, transport, fetch };
}

test('SDK transport (in-process HTTP): enabled discovery and a successful read bound to the owner and current world', async () => {
  await noGlobalFetch(async () => {
    const { mcp, fetch: board, store } = server({ store: fakeStore(oldTerminalOp()) });
    const { client, transport, fetch } = sdkClient(createHandler({ auth: httpAuth(), mcp }));
    try {
      await client.connect(transport, SDK_TIMEOUT);
      const { tools } = await client.listTools(undefined, SDK_TIMEOUT);
      assert.deepEqual(tools.map(t => t.name), [...TOOLS.map(t => t.name), 'get_cooperation_status']);
      const coop = tools.find(t => t.name === 'get_cooperation_status');
      assert.equal(coop.annotations.readOnlyHint, true);
      assert.equal(coop.annotations.openWorldHint, true);
      const r = await client.callTool({ name: 'get_cooperation_status', arguments: {} }, undefined, SDK_TIMEOUT);
      assert.equal(r.isError, false);
      assert.equal(r.structuredContent.owner, OWNER);
      assert.deepEqual(r.structuredContent.world, { programId: PROGRAM, seasonId: '3', cluster: 'localnet' });
      assert.deepEqual(r.structuredContent.nation, { status: 'verified', nation: 2, requests: 4, deliveredFromNation: 7, note: null });
      assert.deepEqual(board.calls.map(c => c.url), [`${BASE}/coop/config`, `${BASE}/coop/view?viewer=${OWNER}`, `${BASE}/coop/config`]);
      assert.equal(store.saves.n, 0);
      assert.deepEqual(store.archived, []);
    } finally {
      await client.close();
    }
    // The transport's own traffic: initialize (200), notifications/initialized (202), an optional GET for a server
    // stream (405: none here), then the calls. Every POST carried the fixed fake bearer; nothing left /mcp.
    const posts = fetch.seen.filter(s => s.method === 'POST');
    assert.equal(posts[0].rpc, 'initialize');
    assert.equal(posts[0].status, 200);
    assert.ok(posts.some(s => s.rpc === 'notifications/initialized' && s.status === 202));
    for (const s of fetch.seen.filter(x => x.method === 'GET')) assert.equal(s.status, 405);
    for (const s of posts) assert.equal(s.authorization, FAKE_BEARER);
    assert.ok(fetch.seen.length <= 10, `bounded traffic: ${fetch.seen.length} requests`);
  });
});

test('SDK transport (in-process HTTP): disabled read is not discovered, and calling it is a protocol error with no board fetch', async () => {
  await noGlobalFetch(async () => {
    const { mcp, fetch: board } = server({ coop: false });
    const { client, transport } = sdkClient(createHandler({ auth: httpAuth(), mcp }));
    try {
      await client.connect(transport, SDK_TIMEOUT);
      const { tools } = await client.listTools(undefined, SDK_TIMEOUT);
      assert.deepEqual(tools.map(t => t.name), TOOLS.map(t => t.name));
      await assert.rejects(client.callTool({ name: 'get_cooperation_status', arguments: {} }, undefined, SDK_TIMEOUT), e => e?.code === -32602);
    } finally {
      await client.close();
    }
    assert.equal(board.calls.length, 0);
  });
});

test('SDK transport (in-process HTTP): invalid arguments and a missing read scope are tool errors with no board fetch', async () => {
  await noGlobalFetch(async () => {
    const a = server();
    const c1 = sdkClient(createHandler({ auth: httpAuth(), mcp: a.mcp }));
    try {
      await c1.client.connect(c1.transport, SDK_TIMEOUT);
      const r = await c1.client.callTool({ name: 'get_cooperation_status', arguments: { viewer: OTHER } }, undefined, SDK_TIMEOUT);
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent.error.code, 'BadRequest');
    } finally {
      await c1.client.close();
    }
    assert.equal(a.fetch.calls.length, 0);

    const b = server();
    const c2 = sdkClient(createHandler({ auth: httpAuth(principalOf({ scopes: ['wylls.caravan'] })), mcp: b.mcp }));
    try {
      await c2.client.connect(c2.transport, SDK_TIMEOUT);
      const r = await c2.client.callTool({ name: 'get_cooperation_status', arguments: {} }, undefined, SDK_TIMEOUT);
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent.error.code, 'InsufficientScope');
    } finally {
      await c2.client.close();
    }
    assert.equal(b.fetch.calls.length, 0);
  });
});

test('SDK transport (in-process HTTP): a client without a valid bearer is rejected at connect (401), no board fetch', async () => {
  await noGlobalFetch(async () => {
    for (const authorization of [null, 'Bearer not-the-fake-token']) {
      const { mcp, fetch: board } = server();
      const { client, transport, fetch } = sdkClient(createHandler({ auth: httpAuth(), mcp }), { authorization });
      try {
        await assert.rejects(client.connect(transport, SDK_TIMEOUT));
      } finally {
        await client.close();
      }
      assert.ok(fetch.seen.length >= 1);
      assert.equal(fetch.seen[0].status, 401);
      assert.ok(fetch.seen.every(s => s.method !== 'POST' || s.status === 401));
      assert.equal(board.calls.length, 0);
    }
  });
});

test('SDK bridge refuses other origins, paths and methods (no fallback)', async () => {
  const { mcp } = server();
  const f = bridgeFetch(createHandler({ auth: httpAuth(), mcp }));
  await assert.rejects(f('http://127.0.0.1:41961/mcp', { method: 'POST', body: '{}' }), TypeError);
  await assert.rejects(f(`${SDK_ORIGIN}/oauth/token`, { method: 'POST', body: '{}' }), TypeError);
  await assert.rejects(f(`${SDK_URL}?x=1`, { method: 'POST', body: '{}' }), TypeError);
  await assert.rejects(f(SDK_URL, { method: 'PUT', body: '{}' }), TypeError);
  await assert.rejects(f(42), TypeError);
  const del = await f(new URL(SDK_URL), { method: 'DELETE' });
  assert.equal(del.status, 405);
  assert.equal(await del.text(), '');
  assert.equal(f.seen.length, 1);
});

test('initialize and ping are unchanged by the cooperation read', async () => {
  const init ={ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
  const a = await server().mcp.handle(init, null);
  const b = await server({ coop: false }).mcp.handle(init, null);
  assert.deepEqual(a, b);
  assert.deepEqual(await server().mcp.handle({ jsonrpc: '2.0', id: 2, method: 'ping' }, null), { jsonrpc: '2.0', id: 2, result: {} });
});

// ------------------------------------------------------------------ regression: the REAL coopView through the real adapter and MCP dispatch
// The view is what coop/board.mjs view() answers, built as it builds it (`{...coopView(...), heraldFeed, chain, damaged,
// contexts, store}`), without createBoard (which makes a data directory and may write observed.json). The state is the
// real fold of unsigned fixture records (fold checks shape and state, not signatures). No link records and no herald
// file, so coopView derives no address. checks.citizens is what coop/chain.mjs citizenOf returns: a numeric faction.

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

function realBoardView({ records = [], citizens = {}, viewer = OWNER } = {}) {
  const state = fold(records, { goals: GOALS, contexts: [REAL_CTX], current: REAL_CTX });
  assert.deepEqual(state.rejected, [], 'the fixture records are accepted by the real fold');
  assert.equal(state.accepted.length, records.length);
  const v = coopView({ state, file: null, checks: { citizens, holdings: {} }, viewer, now: REAL_NOW, judgeId: 'arrivals', season: REAL_CTX });
  return JSON.parse(JSON.stringify({ ...v, heraldFeed: null, chain: false, damaged: [], contexts: [REAL_CTX], store: { segments: 0, problems: [] } }));
}

test('regression (real coopView): a healthy board with a verified numeric nation 0 and lowercase needs is read, not refused', async () => {
  const { mine, theirs, reply } = realRecords();
  const view = realBoardView({
    records: [mine, theirs, reply],
    citizens: { [citizenKey(OWNER)]: { status: 'verified', faction: 0, citizen: 'fixture' }, [citizenKey(OTHER)]: { status: 'verified', faction: 2, citizen: 'fixture' } },
  });
  assert.strictEqual(view.nation.nation, 0);
  assert.strictEqual(view.personal.nation, 0);
  const { mcp, fetch, store } = server({ fetch: boardFetch({ view }) });
  const r = await call(mcp, 'get_cooperation_status');
  assert.equal(r.result.isError, false, JSON.stringify(r.result.structuredContent));
  const s = r.result.structuredContent;
  assert.equal(s.ok, true);
  assert.equal(s.owner, OWNER);
  assert.deepEqual(s.world, { programId: PROGRAM, seasonId: '3', cluster: 'localnet' });
  assert.deepEqual(s.nation, { status: 'verified', nation: 0, requests: 1, deliveredFromNation: 0, note: null });
  assert.deepEqual(s.mine, {
    requests: [{ id: recordId(mine), state: 'open', need: { wood: 200, stone: 150 }, entries: { listed: 0, counted: 0 }, fulfilment: 'none' }],
    responses: [{ id: recordId(theirs), responded: true, myEntries: { listed: 0, counted: 0 } }],
    verified: {}, left: [],
  });
  assert.equal(s.source.heraldFeed, 'unavailable');
  assert.deepEqual(JSON.parse(r.result.content[0].text), s);
  assert.deepEqual(fetch.calls.map(c => c.url), [`${BASE}/coop/config`, `${BASE}/coop/view?viewer=${OWNER}`, `${BASE}/coop/config`]);
  assert.equal(store.saves.n, 0);
  const text = JSON.stringify({ ...s, limitations: undefined });
  for (const leak of [OTHER, 'fixture-not-a-signature', 'fixture-1', view.nation.note, '"to"', '"offer"']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  for (const k of ['recipients', 'targets', 'score', 'role', 'send', 'grant', 'permission']) assert.ok(!(k in s) && !(k in s.mine) && !(k in s.nation));
});

test('regression (real coopView): unknown nationality is a successful read with unknown nation and null counts', async () => {
  const { mine, theirs, reply } = realRecords();
  const view = realBoardView({ records: [mine, theirs, reply], citizens: {} });
  assert.strictEqual(view.nation.nation, null);
  assert.strictEqual(view.personal.nation, null);
  const r = await call(server({ fetch: boardFetch({ view }) }).mcp, 'get_cooperation_status');
  assert.equal(r.result.isError, false, JSON.stringify(r.result.structuredContent));
  const s = r.result.structuredContent;
  assert.equal(s.nation.status, 'unknown');
  assert.strictEqual(s.nation.nation, null);
  assert.strictEqual(s.nation.requests, null);
  assert.strictEqual(s.nation.deliveredFromNation, null);
  assert.deepEqual(s.mine.requests.map(q => q.need), [{ wood: 200, stone: 150 }]);
  const text = JSON.stringify({ ...s, limitations: undefined });
  for (const leak of [view.nation.why, view.nation.note, view.personal.nationWhy, OTHER]) assert.ok(!text.includes(leak), `leaked ${leak}`);
});

// ------------------------------------------------------------------ regression: the REAL Game's context cache (2026-11-18)
// src/game.mjs Game, constructed with a fake relay fetch (GET /f/season only), a fixed clock and addressesFor returning
// constants (no program-derived address is computed). herald.pin is wrapped to record its calls; nothing is fetched
// from the herald by context(). The board is the same fake as above.

const RELAY = 'https://relay.example';
const S3 = Object.freeze({ programId: PROGRAM, seasonId: 3 });
const S4 = Object.freeze({ programId: PROGRAM, seasonId: 4 });
/** addressesFor fixture: constants, never derived. `refuse`: seasonIds for which it throws (as faddr would on a bad id). */
const fixedAddressesFor = (refuse = []) => {
  const fn = (programId, seasonId) => {
    fn.calls.push(seasonId);
    if (refuse.includes(seasonId)) throw new Error(`fixture: addresses for season ${seasonId} cannot be built`);
    return Object.freeze({ programId, seasonId, of: (kind, key) => `fixture-${kind}-${seasonId}-${JSON.stringify(key ?? null)}` });
  };
  fn.calls = [];
  return fn;
};
const relayAnswer = doc => ({ status: 200, json: async () => doc });
/** A relay: one answer per GET /f/season, the last repeats. An Error is a transport failure; {status} an HTTP failure. */
function relayFetch(answers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, method: init?.method });
    assert.equal(url, `${RELAY}/f/season`, 'context() reads only GET /f/season');
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    if (a.status) return { status: a.status, json: async () => ({ code: 'Unavailable' }) };
    return relayAnswer(a);
  };
  f.calls = calls;
  return f;
}
/** A relay whose answers the test releases one by one (pending[i] resolves the i-th read, rejects[i] fails it). */
function gatedRelay() {
  const pending = [];
  const rejects = [];
  const f = () => new Promise((resolve, reject) => { pending.push(resolve); rejects.push(reject); });
  f.pending = pending;
  f.rejects = rejects;
  return f;
}
function realGame({ fetch, addressesFor = fixedAddressesFor(), clock = { t: T0 } } = {}) {
  const game = new Game({ relay: RELAY, herald: 'https://herald.example', fetch, now: () => clock.t, addressesFor });
  const pins = [];
  const pin = game.herald.pin.bind(game.herald);
  game.herald.pin = (seasonId, addresses) => { pins.push(seasonId); return pin(seasonId, addresses); };
  return { game, pins, clock, addressesFor };
}
const isGameError = code => e => e instanceof GameError && e.code === code && e.extra?.retryable === true;

test('real Game: default context() still caches for 15 s (the reproduced hole); {fresh: true} reads the relay now', async () => {
  const relay = relayFetch([S3, S4]);
  const { game, pins, clock } = realGame({ fetch: relay });
  assert.equal((await game.context()).seasonId, '3');
  assert.equal(relay.calls.length, 1);
  // The relay now serves season 4; the default call within the TTL is the cached season 3 with no read (unchanged).
  assert.equal((await game.context()).seasonId, '3');
  assert.equal(relay.calls.length, 1);
  // A forced read sees the switch and publishes it atomically: context, addresses, herald pin, history.
  const c = await game.context({ fresh: true });
  assert.equal(relay.calls.length, 2);
  assert.deepEqual({ key: c.key, seasonId: c.seasonId }, { key: `${PROGRAM}:4`, seasonId: '4' });
  assert.equal(game.addresses.seasonId, '4');
  assert.deepEqual(pins, ['3', '4']);
  assert.deepEqual(game.contextChanges.map(x => x.key), [`${PROGRAM}:3`]);
  // Default semantics afterwards: cached again until the TTL passes, then read again.
  assert.equal((await game.context()).seasonId, '4');
  assert.equal(relay.calls.length, 2);
  clock.t += 15_000;
  assert.equal((await game.context()).seasonId, '4');
  assert.equal(relay.calls.length, 3);
  assert.deepEqual(pins, ['3', '4']); // same key: not re-pinned
});

test('real Game through get_cooperation_status: both boundaries read the relay; a switch during the board read fails closed', async () => {
  // No switch: ok, one relay read per boundary.
  {
    const relay = relayFetch([S3]);
    const { game } = realGame({ fetch: relay });
    const { mcp, fetch: board } = server({ game });
    const r = await call(mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, false, JSON.stringify(r.result.structuredContent));
    assert.deepEqual(r.result.structuredContent.world, { programId: PROGRAM, seasonId: '3', cluster: 'localnet' });
    assert.equal(relay.calls.length, 2);
    assert.equal(board.calls.length, 3);
  }
  // The relay switches 3 → 4 between the two boundaries (within the 15 s TTL, fixed clock): ContextChanged, no data.
  {
    const relay = relayFetch([S3, S4]);
    const { game, pins } = realGame({ fetch: relay });
    const { mcp, fetch: board } = server({ game });
    const r = await call(mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'ContextChanged');
    assert.equal(r.result.structuredContent.error.retryable, true);
    assert.equal(r.result.structuredContent.nation, undefined);
    assert.equal(r.result.structuredContent.mine, undefined);
    assert.equal(r.result.structuredContent.error.cooperation, undefined);
    assert.equal(relay.calls.length, 2);
    assert.equal(board.calls.length, 3);
    assert.deepEqual(pins, ['3', '4']);
  }
  // A warm cache of season 3 does not stand in for the "before" boundary: the relay now serves 4, the board 3.
  {
    const relay = relayFetch([S3, S4]);
    const { game } = realGame({ fetch: relay });
    await game.context();
    const { mcp, fetch: board } = server({ game });
    const r = await call(mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'CoopBoardMismatch');
    assert.equal(relay.calls.length, 3); // the warm read, then the fresh "before" and the fresh "after" boundary
    assert.equal(board.calls.length, 1);
  }
});

test('real Game: an initial relay failure returns no data and reads no board, even with a warm cache', async () => {
  for (const answers of [[new Error('relay down')], [{ status: 503 }], [S3, new Error('relay down')], [S3, { status: 500 }]]) {
    const relay = relayFetch(answers);
    const { game } = realGame({ fetch: relay });
    if (answers.length === 2) { assert.equal((await game.context()).seasonId, '3'); } // warm, within the TTL
    const { mcp, fetch: board } = server({ game });
    const r = await call(mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'ContextUnavailable');
    assert.equal(r.result.structuredContent.nation, undefined);
    assert.equal(board.calls.length, 0);
    assert.equal(relay.calls.length, answers.length);
  }
});

test('real Game: a final relay failure returns no data (ContextChanged), whatever the board said', async () => {
  for (const last of [new Error('relay down'), { status: 500 }]) {
    const relay = relayFetch([S3, last]);
    const { game } = realGame({ fetch: relay });
    const { mcp, fetch: board } = server({ game });
    const r = await call(mcp, 'get_cooperation_status');
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'ContextChanged');
    assert.equal(r.result.structuredContent.nation, undefined);
    assert.equal(r.result.structuredContent.mine, undefined);
    assert.equal(board.calls.length, 3);
    assert.equal(relay.calls.length, 2);
  }
});

test('real Game: addresses for the new context that cannot be built leave the old context, addresses, pin and history', async () => {
  const relay = relayFetch([S3, S4]);
  const { game, pins, addressesFor } = realGame({ fetch: relay, addressesFor: fixedAddressesFor(['4']) });
  const old = await game.context();
  const before = { pinned: game.pinned, addresses: game.addresses, pinnedAt: game.pinnedAt, published: game.contextPublishedSeq };
  await assert.rejects(game.context({ fresh: true }), /cannot be built/);
  assert.strictEqual(game.pinned, old);
  assert.strictEqual(game.pinned, before.pinned);
  assert.strictEqual(game.addresses, before.addresses);
  assert.equal(game.addresses.seasonId, '3');
  assert.equal(game.pinnedAt, before.pinnedAt);
  assert.equal(game.contextPublishedSeq, before.published);
  assert.deepEqual(game.contextChanges, []);
  assert.deepEqual(pins, ['3']);
  assert.deepEqual(addressesFor.calls, ['3', '4']);
  // Through the tool: the "before" boundary cannot be built → ContextUnavailable, no board read, old state kept.
  const { mcp, fetch: board } = server({ game });
  const r = await call(mcp, 'get_cooperation_status');
  assert.equal(r.result.structuredContent.error.code, 'ContextUnavailable');
  assert.equal(board.calls.length, 0);
  assert.strictEqual(game.pinned, old);
  assert.deepEqual(pins, ['3']);
  // At the "after" boundary: 3 published, then 4 cannot be built → ContextChanged, no data, pin still 3.
  const relay2 = relayFetch([S3, S4]);
  const g2 = realGame({ fetch: relay2, addressesFor: fixedAddressesFor(['4']) });
  const s2 = server({ game: g2.game });
  const r2 = await call(s2.mcp, 'get_cooperation_status');
  assert.equal(r2.result.structuredContent.error.code, 'ContextChanged');
  assert.equal(r2.result.structuredContent.nation, undefined);
  assert.equal(s2.fetch.calls.length, 3);
  assert.equal(g2.game.pinned.seasonId, '3');
  assert.deepEqual(g2.pins, ['3']);
});

test('real Game: an older overlapping read that answers last never rolls back a newer published context', async () => {
  const relay = gatedRelay();
  const { game, pins } = realGame({ fetch: relay });
  const older = game.context({ fresh: true });
  const newer = game.context({ fresh: true });
  assert.equal(relay.pending.length, 2);
  relay.pending[1](relayAnswer(S4));
  assert.equal((await newer).seasonId, '4');
  relay.pending[0](relayAnswer(S3));
  const o = await older;
  assert.equal(o.seasonId, '4'); // the newer observation, never the older read's season 3
  assert.equal(game.pinned.seasonId, '4');
  assert.equal(game.addresses.seasonId, '4');
  assert.deepEqual(pins, ['4']);
  assert.deepEqual(game.contextChanges, []);
  // In order (older answers first), both publish as before.
  const relay2 = gatedRelay();
  const g2 = realGame({ fetch: relay2 });
  const a = g2.game.context({ fresh: true });
  const b = g2.game.context({ fresh: true });
  relay2.pending[0](relayAnswer(S3));
  assert.equal((await a).seasonId, '3');
  relay2.pending[1](relayAnswer(S4));
  assert.equal((await b).seasonId, '4');
  assert.deepEqual(g2.pins, ['3', '4']);
  assert.deepEqual(g2.game.contextChanges.map(x => x.key), [`${PROGRAM}:3`]);
});

test('real Game: an older read answering after a newer read that could not publish fails closed, old state kept', async () => {
  const relay = gatedRelay();
  const { game, pins } = realGame({ fetch: relay, addressesFor: fixedAddressesFor(['4']) });
  const warm = game.context();
  relay.pending[0](relayAnswer(S3));
  const old = await warm;
  const older = game.context({ fresh: true });
  const newer = game.context({ fresh: true });
  assert.equal(relay.pending.length, 3);
  relay.pending[2](relayAnswer(S4));
  await assert.rejects(newer, /cannot be built/);
  relay.pending[1](relayAnswer(S3));
  await assert.rejects(older, isGameError('ContextUnavailable'));
  assert.strictEqual(game.pinned, old);
  assert.equal(game.addresses.seasonId, '3');
  assert.deepEqual(pins, ['3']);
  assert.deepEqual(game.contextChanges, []);
});

const S5 = Object.freeze({ programId: PROGRAM, seasonId: 5 });

test('real Game: three overlapping reads — B publishes 4, C answers 5 but cannot build, then A answers 3: A fails closed', async () => {
  const relay = gatedRelay();
  const { game, pins } = realGame({ fetch: relay, addressesFor: fixedAddressesFor(['5']) });
  const A = game.context({ fresh: true });
  const B = game.context({ fresh: true });
  const C = game.context({ fresh: true });
  assert.equal(relay.pending.length, 3);
  relay.pending[1](relayAnswer(S4));
  assert.equal((await B).seasonId, '4');
  relay.pending[2](relayAnswer(S5));
  await assert.rejects(C, /cannot be built/);
  relay.pending[0](relayAnswer(S3));
  // Not B's season 4 (from before C's failed observation of 5), and not A's own older 3.
  await assert.rejects(A, isGameError('ContextUnavailable'));
  assert.equal(game.pinned.seasonId, '4');
  assert.equal(game.addresses.seasonId, '4');
  assert.deepEqual(pins, ['4']);
  assert.deepEqual(game.contextChanges, []);
  // Recovery: a read started after the failure that succeeds publishes as usual.
  const D = game.context({ fresh: true });
  relay.pending[3](relayAnswer(S4));
  assert.equal((await D).seasonId, '4');
  assert.deepEqual(pins, ['4']);
});

test('real Game: a newer read that fails at the relay (transport or HTTP) stops an older overlapping read from publishing; a later read recovers', async () => {
  for (const [kind, settle] of [
    ['transport', relay => relay.rejects[2](new Error('relay down'))],
    ['HTTP 503', relay => relay.pending[2]({ status: 503, json: async () => ({ code: 'Unavailable' }) })],
  ]) {
    const relay = gatedRelay();
    const { game, pins } = realGame({ fetch: relay });
    const warm = game.context();
    relay.pending[0](relayAnswer(S3));
    const old = await warm;
    const older = game.context({ fresh: true });
    const newer = game.context({ fresh: true });
    assert.equal(relay.pending.length, 3, kind);
    settle(relay);
    await assert.rejects(newer, isGameError('RelayUnreachable'), kind);
    relay.pending[1](relayAnswer(S4));
    await assert.rejects(older, isGameError('ContextUnavailable'), kind); // its season-4 answer is not published
    assert.strictEqual(game.pinned, old, kind);
    assert.equal(game.addresses.seasonId, '3', kind);
    assert.deepEqual(pins, ['3'], kind);
    assert.deepEqual(game.contextChanges, [], kind);
    // Recovery on a later successful fresh read.
    const later = game.context({ fresh: true });
    relay.pending[3](relayAnswer(S4));
    assert.equal((await later).seasonId, '4', kind);
    assert.equal(game.addresses.seasonId, '4', kind);
    assert.deepEqual(pins, ['3', '4'], kind);
    assert.deepEqual(game.contextChanges.map(x => x.key), [`${PROGRAM}:3`], kind);
  }
});
