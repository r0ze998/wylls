// A KEY-FREE world for ③'s MCP server: no key is generated, derived or used, and nothing is signed.
//
//   - Identities are fixed address constants (32 bytes, base58), held by no one: the owner, the program.
//   - The agent wallet is the REAL AgentGateway and AgentLedger (WS03_GATEWAY_ROOT) with a fake keyring that hands out
//     a fixed public key string and throws if asked to sign. It does the real things that need no key: the agent
//     record, policy, mode, the capability check (including patch 0008's per-sender tokens), the public view,
//     actionFateView and fateOf (over a scripted node).
//   - What would need a key is scripted (MOCK): the send itself. POST /f/agent/action authenticates with the real
//     gateway (whoami: the same check submit makes), validates the request with the real contract, then records a
//     scripted answer under the idempotency key (once; a repeat is the record's replay) — no transaction is built.
//   - The chain node (for fateOf) and the herald are scripted (MOCK).
//   - POST /f/agent/command runs the owner's command on the real gateway WITHOUT the relay's signature check (MOCK:
//     that check is the relay's unchanged route code, and running it needs a signature). `relay: 'old'` scripts a
//     relay without per-sender capabilities (no `capabilities` in the view; issue-capability unknown; a
//     rotate-capability, with or without params.source, rotates the agent's one token), as before patch 0008; `relay: 'unbound'`
//     lists capabilities but answers issue-capability with the agent's one token (a relay that ignored the source).
//   - Owner-signed steps are not run: the consent's wallet signature, the owner's signed query and revocation
//     statements. The harness calls what runs after those checks (auth.revokeLink, mcp.ownerOperations) and writes
//     the link the consent would write. Sealing at rest uses a fixed constant key (encryption, not signing).
//   - Address computation (program-derived addresses: public, no secret) happens as in production code.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { encode as base58 } from '../../../../../permutation-gateway/client/src/base58.mjs';
import { encodeAccount } from '../../../../../permutation-gateway/client/src/frontier/codec.mjs';
import { PRESETS as V2 } from '../../../../../permutation-gateway/client/src/frontier/abi-v2-presets.mjs';
import { citizenTag } from '../../../../../permutation-server/web/frontier/faddr.mjs';
import { JsonStore } from '../../src/store.mjs';
import { Sealer } from '../../src/seal.mjs';
import { Game } from '../../src/game.mjs';
import { Auth } from '../../src/auth.mjs';
import { createWyllsMcp } from '../../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GATEWAY_ROOT = process.env.WS03_GATEWAY_ROOT ?? path.resolve(here, '../../../../../permutation-gateway');
const gw = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/gateway.mjs')).href);
const { AgentLedger } = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/ledger.mjs')).href);
const { parseActionRequest } = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/contract.mjs')).href);
const fateMod = await import(pathToFileURL(path.join(GATEWAY_ROOT, 'src/frontier/agent/fate.mjs')).href);
/** The wallet tree has GET /f/agent/fate's logic (actionFateView) and patch 0008 (per-sender capabilities). */
export const HAS_FATE = typeof gw.actionFateView === 'function';
export const HAS_0008 = Array.isArray(gw.CAPABILITY_SOURCES);

const constant = n => base58(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 251 + 1));
export const OWNER = constant(11);
export const STRANGER = constant(23);
export const PROGRAM = constant(37);
const AGENT_KEY = constant(53);
export const SEASON_ID = 5n;
/** The world's addresses as fixed constants (Game's `addressesFor`): what production recomputes as PDAs. */
export const CITIZEN = constant(67);
const HOLDING = constant(71);
export function constantAddresses(programId, seasonId) {
  const of = (kind, key = {}) => {
    if (kind === 'Citizen' && key.wallet === OWNER) return CITIZEN;
    if (kind === 'Holding' && key.p === VILLAGE[0] && key.q === VILLAGE[1] && key.site === VILLAGE[2]) return HOLDING;
    throw new Error(`constantAddresses: no constant for ${kind} ${JSON.stringify(key)} (this harness derives no address)`);
  };
  return Object.freeze({ programId, seasonId: String(seasonId), of, used: true });
}
export const GENESIS = 1_800_000_000;
export const NOW = GENESIS + 3_600;
export const VILLAGE = [-3, 7, 11];
const [P, Q, SITE] = VILLAGE;
const VILLAGE_TILE = 30;
const VAULT_TILE = 33;
export const RELAY = 'http://relay.test';
export const HERALD = 'http://herald.test';
export const SEAL_KEY = Buffer.alloc(32, 3).toString('base64url'); // a fixed constant, not generated
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const b64 = u => Buffer.from(u).toString('base64');
const keyBytes = k => { const out = []; let n = 0n; for (const c of k) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c)); for (let i = 0; i < 32; i++) { out.unshift(Number(n & 0xffn)); n >>= 8n; } return Uint8Array.from(out); };
const accrual = v => ({ VALUE: BigInt(v * 1000), RATE: 0n, CAP: 2_000_000_000n, T0: BigInt(NOW - 10), FRAC: 0n });

/** A scripted chain node for fateOf: per signature, its status; and the node's height and first available slot. */
export function scriptedNode() {
  const n = { height: 100, first: null, statuses: new Map(), fail: {}, txs: new Map() };
  n.connection = {
    async getSignatureStatuses([sig]) { if (n.fail.status) throw new Error('node down (scripted)'); return { value: [n.statuses.get(sig) ?? null] }; },
    async getBlockHeight() { if (n.fail.height) throw new Error('node down (scripted)'); return n.height; },
    async getTransaction(sig) { if (n.fail.tx) throw new Error('node down (scripted)'); return n.txs.get(sig) ?? null; },
    async getFirstAvailableBlock() { if (n.first === null) throw new Error('Method not found'); return n.first; },
  };
  return n;
}

/**
 * The world: the real agent wallet (fake keyring), a scripted send, a scripted node and herald.
 * `w.script.next` decides the next new send's answer: 'sent' (default) | 'drop' (sent, the answer lost) |
 * 'failed-signed' (the bytes left, the call failed) | 'failed-unsent' (failed before anything left) | 'unreachable'.
 */
export async function keyfreeWorld({ relay = 'current' } = {}) {
  const keyring = { create: () => AGENT_KEY, isAgentKey: k => k === AGENT_KEY, sign: () => { throw new Error('KEY-FREE: nothing is signed in this harness'); } };
  const citizen = CITIZEN; // a fixed constant: no address is derived in this harness (no PDA)
  const tag = citizenTag(citizen); // reads the address's first 8 bytes
  // The chain as the wallet's real submit reads it before building (MOCK, no key): the Citizen's session is the agent's
  // key and unexpired; `residents` is ⑳'s holder check (ctx.residents, the injectable part of residentRefusal): after
  // an NFT transfer (`transferNft()`), the agent's key is no longer the current holder's session.
  const nft = { transferred: false };
  const ctx = { addresses: { citizen: () => citizen }, log: () => {},
    chain: { season: async () => ({}), clock: async () => ({ unixTimestamp: BigInt(NOW) }), citizen: async () => ({ SESSION: keyBytes(AGENT_KEY), SESSION_EXPIRY: BigInt(NOW + 86_400) }) },
    residents: { check: async () => (nft.transferred ? { ok: false, code: 'ResidentHolderChanged' } : { ok: true }) } };
  const g = new gw.AgentGateway({ ctx, ledger: new AgentLedger(), keyring, log: () => {} });
  const made = g.createAgent({ owner: OWNER, village: VILLAGE, policy: { allowed: ['transport', 'economy'], budget: { total: '1000000', perDay: '1000000' } } });
  const agentId = made.agent.agentId;
  g.setMode(agentId, OWNER, 'auto');
  const node = scriptedNode();
  const state = { caravans: 0, stores: [500, 500, 50, 500, 0, 100, 0, 0], vault: [0, 0, 400, 0, 0, 0, 0, 0], events: [], moving: [], down: null };
  const script = { next: 'sent', sends: new Map(), n: 0, posts: 0, chainSent: 0, commands: [] };
  const history = []; // the wallet's action lines for this harness's sends (the real ledger's shape)

  const v2 = (kind, values) => encodeAccount(kind, { SEASON_ID, LAYOUT_VERSION: 2, ...values }, { profile: 2 });
  const herald = {
    season: () => ({ v: 1, season: String(SEASON_ID), bytes_b64: b64(v2('Season', { RULESET_HASH: hex(V2.ruleset_hash_v3), PROGRAM_VERSION: 4, GENESIS_TS: BigInt(GENESIS), STATUS: 2 })), latestUnix: NOW }),
    me: () => ({ v: 1, citizen: { bytes_b64: b64(v2('Citizen', { WALLET: keyBytes(OWNER), FACTION: 2, HOLDINGS_N: 1, CARAVANS: state.caravans, CITIZEN_TAG: tag,
      HOLDING: [{ P, Q, SITE, GEN: 1 }, { P: 0, Q: 0, SITE: 0, GEN: 255 }, { P: 0, Q: 0, SITE: 0, GEN: 255 }] })) },
    holdings: [{ bytes_b64: b64(v2('Holding', { P, Q, SITE, GEN: 1, TILE: VILLAGE_TILE, STATE: 2, OWNER_CITIZEN: keyBytes(citizen), FACTION: 2, ORDER: 1, STORES: state.stores.map(accrual) })) }] }),
    province: (p, q) => ({ v: 1, key: `pv:${p},${q}`, bell: 30, slot: 1, seq: '1',
      bytes: b64(v2('Province', { P: p, Q: q, SITES: [0, 5, 10, VILLAGE_TILE, 40, 45, 50, 55, 60, 2, 4, 6].map((t, i) => (i === SITE ? VILLAGE_TILE : t)), SITE_COUNT: 12, PASSABLE_MASK: (1n << 61n) - 1n })), slots: [] }),
    caravans: () => ({ v: 1, moving: state.moving, vaults: [{ p: P, q: Q, tile: VAULT_TILE, ownerTag: tag.toString(), faction: 2, gen: 1, stores: state.vault, cap: 2000, ownerCitizen: citizen }] }),
    events: after => { const rows = state.events.filter(e => BigInt(e.seq) > BigInt(after)); return { v: 1, events: rows, next: rows.at(-1)?.seq ?? String(after), full: false }; },
  };

  /** The wallet's GET /f/agent/fate, by the real code: the kept line and fateOf over the scripted node. */
  async function fate(id, key) {
    if (id !== agentId) return { status: 404, json: { error: 'no such agent', code: 'UnknownAgent' } };
    const entry = [...history].reverse().find(e => e.key === key) ?? null;
    if (!entry?.signature) return { status: 200, json: { agentId, ...gw.actionFateView(entry) } };
    const f = await fateMod.fateOf(node.connection, { signature: entry.signature, lastValidBlockHeight: entry.lastValidBlockHeight, slotFloor: entry.slotFloor }, { fullHistory: false });
    return { status: 200, json: { agentId, ...gw.actionFateView(entry, f) } };
  }

  async function action(body) {
    script.posts++;
    // After an NFT transfer the REAL gateway decides: its submit authenticates, gates, holds and refuses in #build
    // (residentRefusal) before building or signing anything (the fake keyring throws if signing were reached).
    if (nft.transferred) {
      let res;
      try { res = await g.submit(body?.request, { capability: body?.capability }); } catch (e) { return { status: e.status ?? 400, json: { error: e.message, code: e.code } }; }
      if (res.status === 'sent') script.chainSent++;
      return { status: 200, json: res };
    }
    let bound;
    try { bound = g.whoami(body?.request?.agentId, { capability: body?.capability }).capabilitySource; } catch (e) { return { status: e.status ?? 401, json: { error: e.message, code: e.code } }; }
    let r;
    try { r = parseActionRequest(body.request); } catch (e) { return { status: 400, json: { error: e.message, code: e.code ?? 'BadRequest' } }; }
    if (bound && r.source !== bound) return { status: 401, json: { error: `this capability is issued for source ${bound}, not ${r.source}`, code: 'BadCapability' } };
    const prior = script.sends.get(r.idempotencyKey);
    if (prior) return { status: 200, json: { ...prior, replayed: true } };
    const mode = script.next; script.next = 'sent';
    if (mode === 'unreachable') return { transport: true };
    const facts = { sent: true, signature: `sig-${++script.n}`, lastValidBlockHeight: 150, slotFloor: 70, signedAt: NOW * 1000 };
    let res;
    // ⑤'s Duplicate AS DESCRIBED: not rebuilt; failed, sent: null, code Duplicate, the earlier send's signature.
    if (mode === 'duplicate') {
      const earlier = `sig-dup-${script.n}`;
      res = { ok: false, requestId: r.idempotencyKey, agentId, status: 'failed', sent: null, charges: [], duplicateOf: earlier, signature: earlier, lastValidBlockHeight: 150, slotFloor: 70,
        error: { code: 'Duplicate', message: 'the same transaction was already sent by an earlier request (scripted)' } };
      script.sends.set(r.idempotencyKey, res);
      history.push({ type: 'action', name: r.action.name, key: r.idempotencyKey, source: r.source, status: 'failed', code: 'Duplicate', signature: earlier, lastValidBlockHeight: 150, slotFloor: 70 });
      return { status: 200, json: res };
    }
    if (mode === 'failed-unsent') res = { ok: false, requestId: r.idempotencyKey, agentId, status: 'failed', sent: false, charges: [], error: { code: 'SendFailed', message: 'RPC down before sending (scripted)' } };
    else if (mode === 'failed-signed') { script.chainSent++; res = { ok: false, requestId: r.idempotencyKey, agentId, status: 'failed', ...facts, charges: [], error: { code: 'SendFailed', message: 'the call failed after the bytes left (scripted)' } }; }
    else { script.chainSent++; res = { ok: true, requestId: r.idempotencyKey, agentId, status: 'sent', ...facts, charges: [] }; }
    script.sends.set(r.idempotencyKey, res);
    history.push({ type: 'action', name: r.action.name, key: r.idempotencyKey, source: r.source, status: res.status, ...(res.sent ? facts : { sent: false }), ...(res.error ? { code: res.error.code } : {}) });
    if (mode === 'drop') return { transport: true };
    return { status: 200, json: res };
  }

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (state.down?.(u)) throw new Error('connect ECONNREFUSED (scripted)');
    const json = (status, data) => ({ status, ok: status < 400, json: async () => data });
    if (u.origin === RELAY) {
      const p = u.pathname;
      if (p === '/f/season') return json(200, { programId: PROGRAM, seasonId: String(SEASON_ID) });
      if (p === '/f/agent') {
        const id = u.searchParams.get('id');
        if (id !== agentId) return json(404, { error: 'no such agent', code: 'UnknownAgent' });
        const v = { ...g.view(id), history: history.slice(-50) };
        if (relay === 'old') delete v.capabilities;
        // `relay: 'ws05'`: ⑤'s contract AS ⑤ DESCRIBED IT (message 2026-11-06, not ⑤'s code): the view lists
        // `senderCapabilities`; rotate-capability {source} issues a sender's token; issue-capability does not exist.
        if (relay === 'ws05') { v.senderCapabilities = v.capabilities; delete v.capabilities; }
        return json(200, v);
      }
      if (p === '/f/agent/command' && init.method === 'POST') {
        const { command: c } = JSON.parse(init.body);
        script.commands.push(c.op);
        try {
          if (relay === 'old') {
            if (c.op === 'rotate-capability') return json(200, { ok: true, ...g.rotateCapability(c.agentId, c.owner) }); // params ignored, as an older relay does
            return json(400, { error: 'unknown op', code: 'BadRequest' });
          }
          // `relay: 'unbound'`: a relay that lists capabilities but answers a sender's request with the agent's one token.
          if (relay === 'ws05' && c.op === 'issue-capability') return json(400, { error: 'unknown op', code: 'BadRequest' });
          if (c.op === 'issue-capability' && relay === 'unbound') return json(200, { ok: true, ...g.rotateCapability(c.agentId, c.owner) });
          if (c.op === 'issue-capability') return json(200, { ok: true, ...g.issueSourceCapability(c.agentId, c.owner, c.params?.source) });
          if (c.op === 'revoke-capability') return json(200, { ok: true, ...g.revokeSourceCapability(c.agentId, c.owner, c.params?.source) });
          if (c.op === 'rotate-capability') return json(200, { ok: true, ...(c.params?.source === undefined ? g.rotateCapability(c.agentId, c.owner) : g.issueSourceCapability(c.agentId, c.owner, c.params.source)) });
          return json(400, { error: 'unknown op', code: 'BadRequest' });
        } catch (e) { return json(e.status ?? 400, { error: e.message, code: e.code }); }
      }
      if (p === '/f/agent/fate') { const r = await fate(u.searchParams.get('id'), u.searchParams.get('key')); return json(r.status, r.json); }
      if (p === '/f/agent/action' && init.method === 'POST') { const r = await action(JSON.parse(init.body)); if (r.transport) throw new Error('socket hang up (scripted)'); return json(r.status, r.json); }
      if (p.startsWith('/f/tx/')) return json(200, { state: 'unknown' });
      return json(404, { error: 'not found', code: 'NotFound' });
    }
    const p = u.pathname;
    let m;
    if (p === '/h/season') return json(200, herald.season());
    if (p === `/h/me/${OWNER}`) return json(200, herald.me());
    if (p.startsWith('/h/me/')) return json(404, { error: 'NotFound' });
    if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/latest$/.exec(p))) return json(200, herald.province(+m[1], +m[2]));
    if (p === '/h/caravans.json') return json(200, herald.caravans());
    if (p === '/h/events') return json(200, herald.events(u.searchParams.get('after') ?? '0'));
    return json(404, { error: 'NotFound' });
  };

  /** 127.0.0.1 in front of GET /f/agent/fate (what ④'s runexec reads). */
  const fatePort = () => new Promise(resolve => {
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      const r = u.pathname === '/f/agent/fate' ? await fate(u.searchParams.get('id'), u.searchParams.get('key')) : { status: 404, json: { code: 'NotFound' } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

  return { g, agentId, legacyToken: made.capability.token, citizen, tag, node, state, script, history, fetch, fatePort, transferNft: () => { nft.transferred = true; } };
}

/**
 * ③'s server on `storeFile` (null: memory) over the world. `connectAs(token)` writes the link the owner's consent
 * would write (its wallet signature is the step not run here) with the agent capability sealed.
 */
export function mcpServer(w, { storeFile = null, acts = null, clock = { t: NOW * 1000 }, allowGlobalRotate = false } = {}) {
  const now = () => clock.t;
  const store = new JsonStore(storeFile);
  const game = new Game({ relay: RELAY, herald: HERALD, fetch: w.fetch, contextTtlMs: 0, addressesFor: constantAddresses });
  const sealer = new Sealer(SEAL_KEY);
  const auth = new Auth({ issuer: 'http://127.0.0.1:9', resource: 'http://127.0.0.1:9/mcp', store, sealer, game, now, allowGlobalRotate });
  const mcp = createWyllsMcp({ auth, game, store, now, ...(acts ? { acts } : {}) });
  let id = 0;
  const principalOf = linkId => { const l = auth.link(linkId); return { linkId, owner: l.owner, agentId: l.agentId, scopes: l.scopes, tokenExpiresAt: l.expiresAt }; };
  const tool = async (linkId, name, args = {}) => (await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }, principalOf(linkId))).result.structuredContent;
  /**
   * The consent's relay step as auth.consent runs it after the owner's signature (not run here): the command this
   * server builds (capabilityCommandFor), the relay's answer, the binding check, and the link with the sealed token.
   */
  async function connectViaRelay({ linkId = 'lnk_keyfree_01' } = {}) {
    const command = await auth.capabilityCommandFor(OWNER, w.agentId, `nonce-${linkId}`, now() + 300_000);
    const view = (await game.json('GET', `${RELAY}/f/agent?id=${w.agentId}`)).json;
    const { sealed, capabilityMeta } = await auth.capabilityFromRelay({ owner: OWNER, agentId: w.agentId, view, command, signature: 'not-run-in-this-harness' });
    const token = sealer.open(sealed);
    connectAs(token, { linkId, meta: capabilityMeta });
    return { linkId, command, meta: capabilityMeta, token };
  }
  function connectAs(token, { linkId = 'lnk_keyfree_01', meta = { source: 'mcp', version: null } } = {}) {
    auth.db.links[linkId] = { linkId, owner: OWNER, agentId: w.agentId, clientId: 'keyfree-client', scopes: ['wylls.read', 'wylls.caravan'],
      grant: { contract: 'wylls.mock-grant/0', actions: ['SendCaravan'], maxSends: 3, maxCargo: Array(8).fill(500), expiresAt: now() + 86_400_000 },
      grantUse: { used: 0, reserved: {} }, expiresAt: now() + 86_400_000, createdAt: now(), revokedAt: null, capability: sealer.seal(token), capabilityMeta: meta, statementHash: 'keyfree' };
    store.save();
    return linkId;
  }
  const plan = async (linkId, n = 10) => {
    const st = await tool(linkId, 'get_village_status');
    return tool(linkId, 'prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: n } });
  };
  return { auth, mcp, store, game, tool, connectAs, connectViaRelay, plan, clock };
}
