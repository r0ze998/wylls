// The MCP server's test world, no network and no chain: the relay with the agent wallet attached over the gateway
// tests' scripted chain (permutation-gateway/test/agent-wallet-fixtures.mjs: the real relay routes, AgentGateway,
// classify, sponsor and drain guard; the chain is a script) and a fake herald serving real v2 account bytes
// (encodeAccount). [SIMULATED CHAIN] — what the program would do with the transaction is not executed here.
//
// WS03_GATEWAY_ROOT picks the permutation-gateway tree (default: this repository's, which lacks patch 0005;
// the tests that need SendCaravan as an agent action run only against a tree that has it).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encode as base58, decode as fromBase58 } from '../../../../permutation-gateway/client/src/base58.mjs';
import { encodeAccount } from '../../../../permutation-gateway/client/src/frontier/codec.mjs';
import { PRESETS as V2 } from '../../../../permutation-gateway/client/src/frontier/abi-v2-presets.mjs';
import { LOGS } from '../../../../permutation-gateway/client/src/frontier/abi-v2-logs.mjs';
import { seasonAddresses, citizenTag } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';
import { Game } from '../src/game.mjs';
import { Auth } from '../src/auth.mjs';
import { createWyllsMcp } from '../src/server.mjs';
import { createHandler, listen } from '../src/http.mjs';

/** An ed25519 keypair shaped as the gateway's helpers use one (`publicKey.toBase58()`, 64-byte `secretKey`). */
export function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const b58 = base58(pub);
  return { publicKey: { toBase58: () => b58, toBytes: () => Uint8Array.from(pub), toString: () => b58 }, secretKey: Uint8Array.from(Buffer.concat([seed, pub])) };
}
const keyBytes = k => Uint8Array.from(fromBase58(k));

const here = path.dirname(fileURLToPath(import.meta.url));
export const GATEWAY_ROOT = process.env.WS03_GATEWAY_ROOT ?? path.resolve(here, '../../../../permutation-gateway');
const fx = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'test/agent-wallet-fixtures.mjs')).href);
export const contract = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/contract.mjs')).href);
/** Whether the gateway tree has patch 0005 (SendCaravan as an agent action). */
export const PATCHED = Object.keys(contract.ACTION_GROUPS).includes('transport');
/** The gateway tree has patch 0007 (GET /f/tx?detail=1: commitment, fee, proven absence). */
export const HAS_0007 = readFileSync(path.join(GATEWAY_ROOT, 'src/frontier/routes/season.mjs'), 'utf8').includes('?detail=1');

export const RELAY = 'http://relay.test';
export const HERALD = 'http://herald.test';
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const b64 = u => Buffer.from(u).toString('base64');
const [P, Q, SITE] = fx.VILLAGE;
export const VILLAGE_TILE = 30;
export const VAULT_TILE = 33;
export const NOW = fx.GENESIS + 3_600;

const accrual = v => ({ VALUE: BigInt(v * 1000), RATE: 0n, CAP: 2_000_000_000n, T0: BigInt(NOW - 10), FRAC: 0n });

export function encodeCaravanRecord(name, { bell = 30, ownerTag, seq, payload = {} }) {
  const spec = LOGS.kinds.find(k => k.name === name);
  const parts = [Uint8Array.from([1, spec.kind]), le(bell, 4)];
  const put = (f, v) => parts.push(f.len <= 8 ? le(BigInt(v ?? 0), f.len) : Uint8Array.from(v ?? new Uint8Array(f.len)));
  put(spec.key[0], ownerTag); put(spec.key[1], seq);
  for (const f of spec.payload) put(f, payload[f.name]);
  parts.push(Uint8Array.from([0]));
  return Buffer.concat(parts.map(Buffer.from));
}
function le(v, n) { const b = new Uint8Array(n); let x = BigInt.asUintN(8 * n, BigInt(v)); for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; }

/**
 * A world: the relay (S1 season), one owner with an agent on VILLAGE, a vault of theirs on VAULT_TILE, a
 * stranger's village next door, and the fake herald. `allowed`: the agent policy's groups.
 */
export async function world({ allowed = PATCHED ? ['transport'] : ['economy'], budget = ['1000000', '1000000'], prices = {}, auto = true, delegated = true, villageStores = [500, 500, 50, 500, 0, 100, 0, 0], vaultStores = [0, 0, 400, 0, 0, 0, 0, 0], now = () => Date.now(), history = null } = {}) {
  const r = fx.relay({ season: { RULESET_HASH: hex(V2.ruleset_hash_v3), LAYOUT_VERSION: 2, PROGRAM_VERSION: 4 }, prices });
  const owner = keypair();
  const o = owner.publicKey.toBase58();
  const made = await fx.createAgent(r, owner, { policy: fx.policy(allowed, ...budget) });
  if (delegated) fx.delegate(r, o, made.agentKey);
  if (auto) await fx.call(r.public, 'POST', '/f/agent/command', { body: fx.ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }) });
  if (history) r.gateway.ledger.get(made.agentId).history.push(...history);
  const W = seasonAddresses(fx.PROGRAM, fx.SEASON_ID);
  const citizen = W.of('Citizen', { wallet: o });
  const tag = citizenTag(citizen);
  const stranger = keypair().publicKey.toBase58();
  const v2 = (kind, values) => encodeAccount(kind, { SEASON_ID: state.seasonId, LAYOUT_VERSION: 2, ...values }, { profile: 2 });
  const state = {
    seasonId: fx.SEASON_ID, // switchContext(id) moves the relay's /f/season answer and the herald's records to another
    caravans: 0,
    stores: villageStores,
    vault: vaultStores,
    events: [],
    moving: [],
    fail: null, // a path → status to fail
  };
  const page = {
    season: () => ({ v: 1, season: String(state.seasonId), bytes_b64: b64(v2('Season', { RULESET_HASH: hex(V2.ruleset_hash_v3), PROGRAM_VERSION: 4, GENESIS_TS: BigInt(fx.GENESIS), STATUS: 2 })), latestUnix: NOW }),
    me: () => ({ v: 1, citizen: { bytes_b64: b64(v2('Citizen', { WALLET: keyBytes(o), FACTION: 2, HOLDINGS_N: 1, CARAVANS: state.caravans, CITIZEN_TAG: tag,
      HOLDING: [{ P, Q, SITE, GEN: 1 }, { P: 0, Q: 0, SITE: 0, GEN: 255 }, { P: 0, Q: 0, SITE: 0, GEN: 255 }] })) },
    holdings: [{ bytes_b64: b64(v2('Holding', { P, Q, SITE, GEN: 1, TILE: VILLAGE_TILE, STATE: 2, OWNER_CITIZEN: keyBytes(citizen), FACTION: 2, ORDER: 1, STORES: state.stores.map(accrual) })) }] }),
    province: (p, q) => ({ v: 1, key: `pv:${p},${q}`, bell: 30, slot: 1, seq: '1',
      bytes: b64(v2('Province', { P: p, Q: q, SITES: [0, 5, 10, VILLAGE_TILE, 40, 45, 50, 55, 60, 2, 4, 6].map((t, i) => (i === SITE ? VILLAGE_TILE : t)), SITE_COUNT: 12, PASSABLE_MASK: (1n << 61n) - 1n })),
      // A march arriving here (another player's): the server must never pass it on.
      slots: [{ key: `ar:${p},${q},31,4,0`, slot: 1, bytes: b64(encodeAccount('ArrivalSlot', { SEASON_ID: fx.SEASON_ID, P: p, Q: q, BELL: 31, FACTION: 4, I: 0, UNIT: 3, TILE: 7, HOST_ID: 0x5ec7e7n, CITIZEN_TAG: 0x5ec7e7n }, { profile: 2 })) }] }),
    caravans: () => ({ v: 1, moving: state.moving, vaults: [
      { p: P, q: Q, tile: VAULT_TILE, ownerTag: tag.toString(), faction: 2, gen: 1, stores: state.vault, cap: 2000, ownerCitizen: citizen },
      { p: P, q: Q, tile: 34, ownerTag: '999', faction: 3, gen: 1, stores: [0, 0, 999, 0, 0, 0, 0, 0], cap: 2000, ownerCitizen: stranger },
    ] }),
    events: after => { const rows = state.events.filter(e => BigInt(e.seq) > BigInt(after)); return { v: 1, events: rows, next: rows.at(-1)?.seq ?? String(after), full: false }; },
  };
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method ?? 'GET'} ${u.origin}${u.pathname}`);
    if (state.fail?.(u)) throw new Error('connect ECONNREFUSED (scripted)');
    if (state.intercept) { const x = await state.intercept(u, init); if (x) return x; }
    if (u.origin === RELAY) {
      const res = await fx.call(r.public, init.method ?? 'GET', u.pathname + u.search, { body: init.body === undefined ? undefined : JSON.parse(init.body) });
      // After switchContext: the relay answers for the other context (only /f/season is rewritten; the scripted
      // relay's own addresses stay the first context's, so tests must not send new plans after a switch).
      if (u.pathname === '/f/season' && res.status === 200 && state.seasonId !== fx.SEASON_ID) return { status: 200, json: async () => ({ ...res.json, seasonId: String(state.seasonId) }) };
      return { status: res.status, json: async () => res.json };
    }
    const json = data => ({ status: 200, ok: true, json: async () => data });
    const p = u.pathname;
    if (p === '/h/season') return json(page.season());
    if (p === `/h/me/${o}`) return json(page.me());
    if (p.startsWith('/h/me/')) return { status: 404, ok: false, json: async () => ({ error: 'NotFound' }) };
    let m;
    if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/latest$/.exec(p))) return json(page.province(+m[1], +m[2]));
    if (p === '/h/caravans.json') return json(page.caravans());
    if (p === '/h/events') return json(page.events(u.searchParams.get('after') ?? '0'));
    return { status: 404, ok: false, json: async () => ({ error: 'NotFound' }) };
  };
  const switchContext = id => { state.seasonId = BigInt(id); };
  return { r, fx, owner, o, agent: made, citizen, tag, stranger, state, fetch, calls, W, P, Q, SITE, switchContext };
}

/** The MCP server over the world, on a loopback port; `clock` is the server's `now` (ms). */
export async function server(w, { storeFile = null, clock = { t: Date.now() }, sealKey = null, uncertainWindowMs, archiveAfterMs, rateLimit = { burst: 10_000, everySecs: 2 }, redirectProfiles } = {}) {
  const now = () => clock.t;
  const store = new JsonStore(storeFile);
  const game = new Game({ relay: RELAY, herald: HERALD, fetch: w.fetch, contextTtlMs: 0 });
  const logs = [];
  const log = m => logs.push(m);
  const sealer = new Sealer(sealKey);
  let auth;
  const srv = await listen(async (req, res) => handler(req, res));
  const issuer = `http://127.0.0.1:${srv.address().port}`;
  auth = new Auth({ issuer, resource: `${issuer}/mcp`, store, sealer, game, now, log, ...(redirectProfiles ? { redirectProfiles } : {}) });
  const mcp = createWyllsMcp({ auth, game, store, now, log, ...(uncertainWindowMs !== undefined ? { uncertainWindowMs } : {}), ...(archiveAfterMs !== undefined ? { archiveAfterMs } : {}) });
  const handler = createHandler({ auth, mcp, log, rateLimit });
  return { srv, issuer, auth, mcp, store, game, logs, clock, close: () => new Promise(r => srv.close(r)) };
}

const sha256url = s => createHash('sha256').update(s).digest('base64url');

/**
 * The OAuth dance a client and the owner's wallet do: register, authorize (the consent page), the statement
 * signed by the owner's keypair (and the rotate command for the caravan scope), the code for tokens.
 * `signer` signs (default the owner): another key = a forged consent.
 */
export async function connect(s, w, { scopes = ['wylls.read', 'wylls.caravan'], grant = { actions: ['SendCaravan'], maxSends: 3, maxCargo: Array(8).fill(500) }, ttlMs = 86_400_000, grantTtlMs = ttlMs, signer = w.owner, agentId = w.agent.agentId, redirect = 'http://127.0.0.1:9/callback', exchange = true } = {}) {
  const post = async (p, body, form = false) => {
    const res = await fetch(`${s.issuer}${p}`, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const reg = await post('/oauth/register', { redirect_uris: [redirect], client_name: 'test client', token_endpoint_auth_method: 'none' });
  assert.equal(reg.status, 201, JSON.stringify(reg.json));
  const verifier = Buffer.alloc(32, 9).toString('base64url') + 'abcdefghij';
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.json.client_id, redirect_uri: redirect, scope: scopes.join(' '), state: 'st-1', code_challenge: sha256url(verifier), code_challenge_method: 'S256', resource: `${s.issuer}/mcp` });
  const page = await fetch(`${s.issuer}/oauth/authorize?${q}`);
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 300));
  const reqId = /const reqId="([^"]+)"/.exec(html)?.[1];
  assert.ok(reqId, 'the consent page names its request');
  const expiresAt = s.clock.t + ttlMs;
  const st = await post('/oauth/statement', { reqId, owner: w.o, agentId, scopes, expiresAt, grant: grant && { ...grant, expiresAt: s.clock.t + grantTtlMs } });
  assert.equal(st.status, 200, JSON.stringify(st.json));
  const sign = bytesB64 => Buffer.from(signTalk(Buffer.from(bytesB64, 'base64'), signer)).toString('base64');
  const consent = await post('/oauth/consent', { ...st.json.request, signature: sign(st.json.statementB64), ...(st.json.rotate ? { rotate: { command: st.json.rotate.command, signature: sign(st.json.rotate.bytesB64) } } : {}) });
  const back = new URL(consent.json.redirect);
  if (!back.searchParams.get('code')) return { refused: back.searchParams.get('error'), description: back.searchParams.get('error_description'), html };
  assert.equal(back.searchParams.get('state'), 'st-1');
  assert.equal(back.searchParams.get('iss'), s.issuer);
  if (!exchange) return { clientId: reg.json.client_id, code: back.searchParams.get('code'), verifier, redirect, post };
  const tok = await post('/oauth/token', { grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, client_id: reg.json.client_id, redirect_uri: redirect, resource: `${s.issuer}/mcp` }, true);
  assert.equal(tok.status, 200, JSON.stringify(tok.json));
  return { ...tok.json, clientId: reg.json.client_id, html, code: back.searchParams.get('code'), verifier, redirect, post };
}

/** An MCP client over HTTP: `rpc(method, params)`, `tool(name, args)` → the tool result. */
export function client(s, token) {
  let id = 0;
  const rpc = async (method, params, { auth = `Bearer ${token}` } = {}) => {
    const res = await fetch(`${s.issuer}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const text = await res.text();
    return { status: res.status, headers: Object.fromEntries(res.headers), json: text ? JSON.parse(text) : null };
  };
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).json.result;
  return { rpc, tool };
}

export { fx };
