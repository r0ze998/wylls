// (ws13-territory, 2026-11-25) get_territory_status on the READ-ONLY local-play MCP server: the connected owner's own
// land in a world with PLAYER TERRITORY (#209), as that player sees it — its own tiles, the next claim's price, its
// upkeep and unpaid state always; another tile's owner only in its sight (the page's fog). The tool exists only when
// the server was started with the page origin; its one extra read is the page's read-only account read on the world's
// relay (a POST that signs and sends nothing). No write tool appears with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, connect, client, RELAY, HERALD, fx } from './fixture.mjs';
import { seasonAddresses } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Auth } from '../src/auth.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { createHandler, listen } from '../src/http.mjs';
import { LocalPlayGame } from '../src/local-play-game.mjs';
import { TOOLS, TERRITORY_TOOL } from '../src/tools.mjs';
import { localPlaySettings } from '../bin/local-play-settings.mjs';
import { WIDE_READ_SCHEMA } from '../src/local-play-territory.mjs';
import { fakeTerritoryWorld, captureBytes, provinceRecord, playerRecord, PROGRAM, WALLET, OTHER, SEASON_ID } from './territory-fixture.mjs';

const PAGE = 'http://localhost:41920';
async function readOnlyServer(w, { pageOrigin = PAGE, game = null } = {}) {
  const sent = [];
  const season = seasonAddresses(fx.PROGRAM, fx.SEASON_ID).season;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    sent.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.origin === RELAY && u.pathname === '/gw/f/local-play/info') return { status: 200, ok: true, json: async () => ({ localPlay: true, cluster: 'localnet', program: fx.PROGRAM, season, wallet: w.o }) };
    if (u.origin === RELAY) return { status: 404, ok: false, json: async () => ({ error: 'not a local-play route' }) };
    return w.fetch(url, init);
  };
  const clock = { t: Date.now() };
  const store = new JsonStore(null);
  const g = game ?? new LocalPlayGame({ relay: `${RELAY}/gw`, herald: HERALD, fetch, contextTtlMs: 0, ...(pageOrigin ? { pageOrigin } : {}) });
  let handler;
  const srv = await listen(async (req, res) => handler(req, res));
  const issuer = `http://127.0.0.1:${srv.address().port}`;
  const auth = new Auth({ issuer, resource: `${issuer}/mcp`, store, sealer: new Sealer(null), game: g, now: () => clock.t, redirectProfiles: ['loopback'], readOnly: true });
  const mcp = createWyllsMcp({ auth, game: g, store, now: () => clock.t, readOnly: true });
  handler = createHandler({ auth, mcp, rateLimit: { burst: 10_000, everySecs: 2 } });
  return { srv, issuer, auth, mcp, game: g, clock, sent, close: () => new Promise(r => srv.close(r)) };
}
const READ_NAMES = TOOLS.filter(t => t.annotations.readOnlyHint === true && t.name !== 'prepare_caravan').map(t => t.name);

test('T1 the tool is listed only with the page origin; it is read-only, takes no arguments, and no write tool comes with it', async () => {
  const w = await world();
  const on = await readOnlyServer(w), off = await readOnlyServer(w, { pageOrigin: null });
  try {
    for (const [s, names] of [[on, [...READ_NAMES, 'get_territory_status']], [off, READ_NAMES]]) {
      const tok = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: w.o });
      const c = client(s, tok.access_token);
      const list = (await c.rpc('tools/list', {})).json.result.tools;
      assert.deepEqual(list.map(t => t.name), names);
      assert.ok(list.every(t => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false));
      s.c = c;
    }
    assert.equal((await off.c.rpc('tools/call', { name: 'get_territory_status', arguments: {} })).json.error?.code, -32602, 'not a tool without the page origin');
    const bad = await on.c.tool('get_territory_status', { wallet: w.stranger });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.code, 'BadRequest', 'no tool takes a wallet: the owner is the connection\'s');
    // the fixture's village is in the heartland (ring 7): no tile is within reach — said, not guessed, and nothing is POSTed
    const far = await on.c.tool('get_territory_status');
    assert.equal(far.isError, false, JSON.stringify(far.structuredContent));
    assert.equal(far.structuredContent.on, null);
    assert.match(far.structuredContent.why, /more than 3 provinces from the wide land/);
    assert.equal(far.structuredContent.owner, w.o);
    assert.ok(on.sent.every(x => x.startsWith('GET ')), on.sent.join('\n'));
    assert.equal(TERRITORY_TOOL.annotations.readOnlyHint, true);
    assert.ok(!TOOLS.some(t => t.name === 'get_territory_status'), 'not a tool of the write server');
  } finally { await on.close(); await off.close(); }
});

test('T2 settings: WYLLS_MCP_PAGE_ORIGIN is the launcher page\'s loopback origin and nothing else', () => {
  const base = { WYLLS_MCP_TEST_AS: '1', WYLLS_MCP_HERALD: 'http://localhost:41930', WYLLS_MCP_RELAY: 'http://localhost:41930/gw' };
  assert.equal(localPlaySettings(base).pageOrigin, null);
  assert.equal(localPlaySettings({ ...base, WYLLS_MCP_PAGE_ORIGIN: PAGE }).pageOrigin, PAGE);
  for (const bad of ['https://localhost:41920', 'http://example.com:41920', 'http://localhost:41920/', 'http://localhost:41920/x', 'localhost:41920']) {
    assert.match(localPlaySettings({ ...base, WYLLS_MCP_PAGE_ORIGIN: bad }).error ?? '', /WYLLS_MCP_PAGE_ORIGIN/, bad);
  }
});

// A rim home next to territory provinces: the game's reads are stubbed (context, season, the owner's own record); the
// herald's route and the relay's account read answer from the fake world's bytes.
const NOW = 1_800_000_000, GENESIS = NOW - 30_000, BELL = 50;
const holding = (stores = [500, 500, 300, 200, 0, 200, 0, 0], prod = [40, 30, 20, 15, 0, 15, 5, 0]) => ({ p: -64, q: -64, site: 5, tile: 7, tier: 0,
  stores: stores.map((v, i) => ({ value: BigInt(v * 1000), rate: BigInt(prod[i] * 1000), cap: 9_000_000n, t0: BigInt(NOW), frac: 0n })), production: prod.map(x => BigInt(x * 1000)), upkeep: Array(8).fill(0n), queue: [], reserve: [0, 0, 0, 0, 0, 0, 0, 0], transit: [] });
function rimGame(fw, { origin = PAGE, relayStatus = 200, raw = holding() } = {}) {
  const posts = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'GET') { try { const j = await fw.getJson(url); return { status: 200, json: async () => j }; } catch { return { status: 404, json: async () => ({}) }; } }
    posts.push({ path: u.pathname, origin: init.headers?.origin ?? null, body: JSON.parse(init.body) });
    if (relayStatus !== 200) return { status: relayStatus, json: async () => ({ error: 'WorldOriginDenied' }) };
    const b = JSON.parse(init.body), rows = await fw.read(b.addresses);
    return { status: 200, json: async () => ({ schema: b.schema, context_slot: '9', accounts: rows.map(r => (r ? { data_b64: Buffer.from(r).toString('base64') } : null)) }) };
  };
  const g = new LocalPlayGame({ relay: `${RELAY}/gw`, herald: HERALD, fetch, pageOrigin: origin });
  g.context = async () => ({ key: `${PROGRAM}:${SEASON_ID}`, programId: PROGRAM, seasonId: SEASON_ID });
  g.season = async () => ({ season: { genesisTs: GENESIS }, now: NOW });
  g.addresses = fw.addresses;
  g.herald = { me: async wallet => (wallet === WALLET ? { ok: true, citizen: { faction: 3 }, holdings: [raw], record: {} } : { ok: false, code: 'NotFound' }) };
  return { g, posts };
}
function territoryWorld() {
  const fw = fakeTerritoryWorld();
  const me = fw.tagOf(WALLET), other = fw.tagOf(OTHER);
  fw.capture(-65, -64, captureBytes({ sites: [{ tile: 5 }, { tile: 20 }], keepTile: 30, keepHolder: 3 }));   // my nation's keep: in my sight
  fw.capture(-65, -65, captureBytes({ sites: [{ tile: 5 }, { tile: 40 }], keepTile: 30, keepHolder: 1 }));   // another nation's: out of it
  fw.record(-65, -64, provinceRecord({ owners: { 5: me, 8: other }, dist: { 5: 1, 8: 1 } }));
  fw.record(-65, -65, provinceRecord({ owners: { 13: other }, dist: { 13: 2 } }));
  fw.player(WALLET, playerRecord({ tag: me, tiles: 1, lastClaimBell: BELL, claimsInBell: 1 }));
  return fw;
}

test('T3 the owner\'s land: own tiles, the next price, upkeep, this turn\'s claim; free / taken only in sight; the read is the page\'s account read with the page origin', async () => {
  const fw = territoryWorld(), { g, posts } = rimGame(fw);
  const t = await g.territory({ owner: WALLET, agentId: WALLET });
  const v = t.view;
  assert.equal(v.on, true);
  assert.equal(v.bell, BELL);
  assert.deepEqual([v.own.tiles, v.own.nextClaimOre, v.own.upkeepMilliFoodPerHour, v.own.unpaid, v.own.claimsThisTurn], [1, 10, 990, false, 1]);
  assert.deepEqual(v.own.list.map(x => `${x.p},${x.q},${x.tile}`), ['-65,-64,5']);
  assert.equal(t.ore, 200);
  assert.deepEqual(t.claim, { ok: false, why: ['this turn\'s claim is used (1 a turn)'] });
  const a = v.provinces.find(x => x.q === '-64'), b = v.provinces.find(x => x.q === '-65');
  assert.deepEqual([a.own, a.taken, a.unseen], [[5], [8], []]);
  assert.ok(!b.taken.includes(13) && b.unseen.includes(13), 'another player\'s tile out of my sight is not named');
  // every POST: the relay's context route, the wide-read schema, the page origin — and nothing else
  assert.ok(posts.length > 0);
  for (const p of posts) assert.deepEqual([p.path, p.origin, p.body.schema, Object.keys(p.body).sort().join()], ['/gw/f/local-play/act/context', PAGE, WIDE_READ_SCHEMA, 'addresses,schema']);
  assert.ok(posts.every(p => p.body.addresses.length >= 1 && p.body.addresses.length <= 16));
  // a link that is not the owner's own, and a relay that refuses the read: an error, never a made-up view
  await assert.rejects(g.territory({ owner: WALLET, agentId: OTHER }), e => e.code === 'NotOwner');
  await assert.rejects(rimGame(fw, { relayStatus: 403 }).g.territory({ owner: WALLET, agentId: WALLET }), e => e.code === 'RelayUnreachable');
  await assert.rejects(rimGame(fw, { origin: null }).g.territory({ owner: WALLET, agentId: WALLET }), e => e.code === 'TerritoryReadOff');
  await assert.rejects(g.territory({ owner: OTHER, agentId: OTHER }), e => e.code === 'HeraldUnavailable');
});

test('T4 the tool\'s answer over MCP: whole units, the fog said, a claim possible when the turn is free and the ore covers it', async () => {
  const w = await world();
  const fw = territoryWorld();
  fw.player(WALLET, playerRecord({ tag: fw.tagOf(WALLET), tiles: 1, lastClaimBell: BELL - 1, claimsInBell: 1 }));
  const { g } = rimGame(fw);
  // (the link is the fixture owner's; the stubbed game answers its territory as WALLET's rim village)
  const inner = g.territory.bind(g);
  g.territory = async () => inner({ owner: WALLET, agentId: WALLET });
  const real = new LocalPlayGame({ relay: `${RELAY}/gw`, herald: HERALD, fetch: async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === RELAY && u.pathname === '/gw/f/local-play/info') return { status: 200, ok: true, json: async () => ({ localPlay: true, cluster: 'localnet', program: fx.PROGRAM, season: seasonAddresses(fx.PROGRAM, fx.SEASON_ID).season, wallet: w.o }) };
    return w.fetch(url, init);
  }, contextTtlMs: 0, pageOrigin: PAGE });
  real.territory = g.territory;
  const s = await readOnlyServer(w, { game: real });
  try {
    const tok = await connect(s, w, { scopes: ['wylls.read'], grant: null, agentId: w.o });
    const r = await client(s, tok.access_token).tool('get_territory_status');
    assert.equal(r.isError, false, JSON.stringify(r.structuredContent));
    const x = r.structuredContent;
    assert.deepEqual([x.on, x.turn, x.own.tiles, x.own.nextClaimOre, x.own.firstHomeOre, x.own.upkeepFoodPerHour, x.own.firstHomeFoodPerHour, x.own.unpaid, x.own.claimsThisTurn, x.own.claimsPerTurn], [true, BELL, 1, 10, 200, 0.99, 40, false, 0, 1]);
    assert.deepEqual(x.claim, { canAskNow: true, why: [] });
    assert.deepEqual(x.own.where, [{ p: '-65', q: '-64', tile: 5, upkeepFoodPerHour: 0.99 }]);
    assert.equal(x.rule.claimsPerTurn, 1);
    assert.deepEqual(x.provinces.map(p => `${p.p},${p.q}`), ['-65,-64', '-65,-65']);
    assert.deepEqual(x.provinces[0].reach, { kind: 'home' });
    assert.equal(x.provinces[0].tileUpkeepFoodPerHour, 0.99);
    assert.match(x.fog, /only for tiles in the owner's sight/);
    assert.ok(!JSON.stringify(x).includes(fw.tagOf(OTHER)), 'no other player\'s tag is in the answer');
  } finally { await s.close(); }
});
