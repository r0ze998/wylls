// OAuth 2.1 for the MCP server, as ChatGPT's custom MCP connection expects
// it (developers.openai.com/plugins/build/auth, read 2026-10-30; MCP
// authorization 2025-11-25):
//
//   * protected resource metadata (RFC 9728) at /.well-known/oauth-protected-resource, and
//     `WWW-Authenticate: Bearer resource_metadata=…` on every 401;
//   * authorization server metadata (RFC 8414) at /.well-known/oauth-authorization-server, PKCE S256 only,
//     the `resource` parameter on authorize and token (RFC 8707) copied into the token's audience;
//   * dynamic client registration (RFC 7591; ChatGPT still supports it; CIMD, its preferred method, is not
//     implemented here: docs 08 §7); public clients (`token_endpoint_auth_method: none`);
//   * `iss` in the authorization response (RFC 9207); refresh tokens rotated, a reused one revokes the link.
//
// **The authorization server here is a local test one** (WYLLS_MCP_TEST_AS=1): it has no accounts of its own.
// What it authorizes is a *link*: the owner's wallet signs a statement naming this server (`aud`), the OAuth
// client, the scopes, the agent and the grant's limits; for a write scope the wallet also signs the agent
// wallet's owner command that gives this server a capability, which it forwards to the relay to receive the token
// directly (sealed at rest, never shown to anyone): `issue-capability {source: 'mcp'}` on a relay with per-sender
// capabilities (patch 0008: ⑤'s `ai` token keeps working), else the global `rotate-capability` (it stops the others). A production deployment would put this
// behind a real identity provider; nothing here creates a credential outside the local test stack.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonical } from '../../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { verifyTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';
import { fromBase64, utf8 } from '../../../../permutation-gateway/client/src/bytes.mjs';
import { pubkeyBytes } from '../../../../permutation-gateway/client/src/solana-tx.mjs';
import { normaliseGrant } from './ports.mjs';

export const SCOPES = Object.freeze({ READ: 'wylls.read', CARAVAN: 'wylls.caravan' });
export const SCOPE_TEXT = Object.freeze({
  'wylls.read': 'read your village, storehouses, caravans and agent budget (no change)',
  'wylls.caravan': 'ask the relay to send caravans between your own places, within the limits you sign',
});
export const LINK_PREFIX = 'Wylls MCP connection v1\n';
export const REVOKE_PREFIX = 'Wylls MCP revoke v1\n';
export const OWNER_QUERY_PREFIX = 'Wylls MCP owner operations v1\n';
/** ChatGPT's redirect URIs (developers.openai.com/plugins/build/auth): the stable one and the per-connector form. */
export const CHATGPT_REDIRECTS = Object.freeze([/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/]);
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(\/[\w./-]*)?$/;
/** The hosted Claude apps' one callback (claude.com/docs/connectors/building/authentication): web, Desktop, mobile, Cowork. */
export const CLAUDE_REDIRECTS = Object.freeze([/^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/]);
/**
 * Which clients' redirect URIs the authorization server accepts. `loopback` is native clients on this machine
 * (Claude Code, the MCP Inspector, the SDK). The default is the local test set as it was; `claude` is opt-in.
 */
export const REDIRECT_PROFILES = Object.freeze({ chatgpt: CHATGPT_REDIRECTS, claude: CLAUDE_REDIRECTS, loopback: Object.freeze([LOOPBACK]) });
export const DEFAULT_REDIRECT_PROFILES = Object.freeze(['chatgpt', 'loopback']);

/** Bounds on what unauthenticated callers can make the server keep (registrations, pending consents). */
export const LIMITS = Object.freeze({ clients: 1000, pending: 500, pendingPerClient: 20 });

export const TTL = Object.freeze({ code: 60_000, pending: 10 * 60_000, access: 60 * 60_000, refresh: 7 * 86_400_000, link: 30 * 86_400_000 });

const sha = s => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const b64urlSha = s => createHash('sha256').update(s).digest('base64url');

export class OAuthError extends Error {
  constructor(status, error, description, extra = {}) { super(description); this.status = status; this.error = error; this.extra = extra; }
  body() { return { error: this.error, error_description: this.message }; }
}

/** The statement the owner's wallet signs for a link (bytes = prefix ‖ canonical JSON). */
export const linkStatement = s => utf8(LINK_PREFIX + canonical(s));
export const revokeStatement = s => utf8(REVOKE_PREFIX + canonical(s));
/** What the owner signs to read their operations without a connection (after a revocation): `{type, aud, owner, at}`. */
export const ownerQueryStatement = s => utf8(OWNER_QUERY_PREFIX + canonical(s));

function verifySig(bytes, signatureB64, owner) {
  try {
    const sig = fromBase64(String(signatureB64 ?? ''));
    return sig.length === 64 && verifyTalk(bytes, sig, pubkeyBytes(owner));
  } catch { return false; }
}

export class Auth {
  /**
   * @param {object} o
   * @param {string} o.issuer     the server's origin (https in production)
   * @param {string} o.resource   the MCP endpoint's canonical URL (issuer + /mcp)
   * @param {JsonStore} o.store
   * @param {Sealer} o.sealer
   * @param {Game} o.game         relay access (the agent view, the owner's rotate command)
   * @param {string[]} [o.redirects] extra allowed redirect URI prefixes (exact strings)
   * @param {string[]} [o.redirectProfiles] names in REDIRECT_PROFILES (default: chatgpt and loopback)
   */
  constructor({ issuer, resource, store, sealer, game, redirects = [], redirectProfiles = DEFAULT_REDIRECT_PROFILES, now = Date.now, log = () => {} }) {
    const unknown = redirectProfiles.filter(n => !REDIRECT_PROFILES[n]);
    if (unknown.length || !redirectProfiles.length) throw new Error(`redirect profiles: one or more of ${Object.keys(REDIRECT_PROFILES).join(', ')} (got ${redirectProfiles.join(', ') || 'none'})`);
    this.redirectProfiles = [...new Set(redirectProfiles)];
    this.redirectPatterns = this.redirectProfiles.flatMap(n => REDIRECT_PROFILES[n]);
    this.issuer = issuer.replace(/\/+$/, '');
    this.resource = resource;
    this.store = store;
    this.sealer = sealer;
    this.game = game;
    this.redirects = redirects;
    this.now = now;
    this.log = log;
  }

  get db() { return this.store.state; }

  // ------------------------------------------------------------ metadata

  protectedResource() {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: Object.values(SCOPES), bearer_methods_supported: ['header'],
      resource_name: 'Wylls (local test stack)', resource_documentation: `${this.issuer}/docs` };
  }

  serverMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: Object.values(SCOPES),
      authorization_response_iss_parameter_supported: true,
    };
  }

  wwwAuthenticate(extra = '') {
    return `Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource"${extra ? `, ${extra}` : ''}`;
  }

  // ------------------------------------------------------------ clients (RFC 7591)

  redirectAllowed(uri) {
    if (typeof uri !== 'string' || uri.length > 400) return false;
    return this.redirectPatterns.some(r => r.test(uri)) || this.redirects.includes(uri);
  }

  register(body) {
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 5) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris: 1–5 URIs');
    for (const u of uris) if (!this.redirectAllowed(u)) throw new OAuthError(400, 'invalid_redirect_uri', `redirect URI not allowed: ${String(u).slice(0, 80)} (this server accepts: ${this.redirectProfiles.join(', ')})`);
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new OAuthError(400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method none) with PKCE');
    const id = `wmc_${randomBytes(12).toString('base64url')}`;
    const client = { client_id: id, client_id_issued_at: Math.floor(this.now() / 1000), redirect_uris: [...uris], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: String(body.client_name ?? 'MCP client').slice(0, 80) };
    this.db.clients[id] = client;
    const ids = Object.keys(this.db.clients);
    // The oldest registration without a live link goes first (a client that holds a link is kept).
    for (const old of ids.slice(0, Math.max(0, ids.length - LIMITS.clients))) if (!Object.values(this.db.links).some(l => l.clientId === old && !l.revokedAt)) delete this.db.clients[old];
    this.store.save();
    return client;
  }

  // ------------------------------------------------------------ authorize

  /** Checks an authorization request; creates a pending consent (`{reqId, …}`) or throws (no redirect on a bad client or URI). */
  begin(q) {
    const client = this.db.clients[q.client_id];
    if (!client) throw new OAuthError(400, 'invalid_client', 'unknown client_id');
    if (!client.redirect_uris.includes(q.redirect_uri)) throw new OAuthError(400, 'invalid_request', 'redirect_uri is not registered for this client');
    const back = (error, description) => Object.assign(new OAuthError(302, error, description), { redirect: this.#redirect(q.redirect_uri, { error, error_description: description, state: q.state, iss: this.issuer }) });
    if (q.response_type !== 'code') throw back('unsupported_response_type', 'response_type must be code');
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge ?? '')) throw back('invalid_request', 'PKCE S256 is required');
    if (q.resource !== this.resource) throw back('invalid_target', `resource must be ${this.resource}`);
    const scopes = String(q.scope ?? SCOPES.READ).split(' ').filter(Boolean);
    if (!scopes.length || scopes.some(s => !Object.values(SCOPES).includes(s))) throw back('invalid_scope', `scopes: ${Object.values(SCOPES).join(', ')}`);
    if (!scopes.includes(SCOPES.READ)) scopes.unshift(SCOPES.READ);
    const pendingOf = Object.values(this.db.nonces).filter(n => n.clientId === client.client_id);
    if (pendingOf.length >= LIMITS.pendingPerClient) delete this.db.nonces[pendingOf.sort((a, b) => a.expiresAt - b.expiresAt)[0].reqId];
    const all = Object.values(this.db.nonces);
    if (all.length >= LIMITS.pending) delete this.db.nonces[all.sort((a, b) => a.expiresAt - b.expiresAt)[0].reqId];
    const reqId = `req_${randomBytes(12).toString('base64url')}`;
    const nonce = randomBytes(16).toString('base64url');
    this.db.nonces[reqId] = { reqId, nonce, clientId: client.client_id, clientName: client.client_name, redirectUri: q.redirect_uri, state: q.state ?? null,
      codeChallenge: q.code_challenge, scopes, resource: q.resource, expiresAt: this.now() + TTL.pending };
    this.#sweep();
    this.store.save();
    return this.db.nonces[reqId];
  }

  /** The statement a pending consent asks the owner to sign (`grant` only with the caravan scope). */
  /**
   * The owner command that gives this server the agent's capability. With a relay that issues one capability per
   * sender (patch 0008, ④ AUTH-ROUTES A1: its agent view lists `capabilities`), `issue-capability {source: 'mcp'}`:
   * a token for this server only, so ⑤'s `ai` token and any other sender's keep working. With an older relay, the
   * global `rotate-capability`, which stops every other holder's token (the conflict 0008 removes).
   */
  async capabilityCommandFor(owner, agentId, nonce, expiresAt) {
    const v = await this.game.json('GET', `${this.game.relay}/f/agent?id=${encodeURIComponent(String(agentId))}`);
    const perSource = !v.transport && v.status === 200 && v.json && typeof v.json.capabilities === 'object' && v.json.capabilities !== null;
    return perSource
      ? { op: 'issue-capability', owner, agentId, nonce, expiresAt, params: { source: 'mcp' } }
      : { op: 'rotate-capability', owner, agentId, nonce, expiresAt, params: {} };
  }

  statementOf(pending, { owner, agentId, scopes, grant, expiresAt }) {
    return { type: 'wylls-mcp-link/1', aud: this.resource, clientId: pending.clientId, redirectUri: pending.redirectUri, nonce: pending.nonce,
      owner, agentId, scopes: [...scopes].sort(), grant: grant ?? null, expiresAt };
  }

  /**
   * The owner's consent: `{reqId, owner, agentId, scopes?, grant?, expiresAt, signature, rotate?: {command, signature}}`.
   * Verifies the signed statement, that the agent is the owner's (the relay's view), and for the caravan scope
   * obtains the agent's capability with the owner's signed rotate command. Returns the redirect URL with the code.
   */
  async consent(b) {
    const pending = this.db.nonces[b?.reqId];
    if (!pending || pending.expiresAt <= this.now()) throw new OAuthError(400, 'invalid_request', 'this consent request has expired: start the connection again');
    delete this.db.nonces[b.reqId]; // one use, whatever happens next
    this.store.save();
    const back = (error, description) => Object.assign(new OAuthError(302, error, description), { redirect: this.#redirect(pending.redirectUri, { error, error_description: description, state: pending.state, iss: this.issuer }) });
    if (b.deny === true) throw back('access_denied', 'the owner declined');
    const scopes = Array.isArray(b.scopes) ? b.scopes.filter(s => pending.scopes.includes(s)) : pending.scopes;
    if (!scopes.includes(SCOPES.READ)) scopes.unshift(SCOPES.READ);
    const now = this.now();
    if (!Number.isInteger(b.expiresAt) || b.expiresAt <= now || b.expiresAt > now + TTL.link) throw back('invalid_request', 'expiresAt must be within 30 days');
    let grant = null;
    if (scopes.includes(SCOPES.CARAVAN)) {
      try { grant = normaliseGrant(b.grant, { now, maxTtlMs: b.expiresAt - now }); } catch (e) { throw back('invalid_request', e.message); }
    }
    const st = this.statementOf(pending, { owner: b.owner, agentId: b.agentId, scopes, grant, expiresAt: b.expiresAt });
    if (typeof b.owner !== 'string' || !verifySig(linkStatement(st), b.signature, b.owner)) throw back('access_denied', 'the statement is not signed by the owner\'s wallet');
    // The agent must be the owner's, as the relay records it.
    const view = await this.game.json('GET', `${this.game.relay}/f/agent?id=${encodeURIComponent(String(b.agentId))}`);
    if (view.transport || view.status >= 500) throw back('temporarily_unavailable', 'the relay did not answer');
    if (view.status !== 200) throw back('access_denied', `the relay knows no such agent (${view.json?.code ?? view.status})`);
    if (view.json.owner !== b.owner) throw back('access_denied', 'this agent belongs to another owner');
    let sealed = null;
    if (grant) {
      const c = b.rotate?.command;
      const perSource = typeof view.json.capabilities === 'object' && view.json.capabilities !== null;
      const okOp = c && (perSource ? c.op === 'issue-capability' && c.params?.source === 'mcp' : c.op === 'rotate-capability');
      // A relay that issues per-sender capabilities never gets the global rotation from this server: it would stop ⑤'s.
      if (!okOp || c.owner !== b.owner || c.agentId !== b.agentId) throw back('invalid_request', perSource ? 'a caravan grant needs the owner\'s signed issue-capability command (source mcp) for this agent' : 'a caravan grant needs the owner\'s signed rotate-capability command for this agent');
      const r = await this.game.ownerCommand({ command: c, signature: b.rotate.signature });
      if (r.transport || r.status !== 200 || typeof r.json?.capability?.token !== 'string') throw back('access_denied', `the relay refused the owner's command (${r.json?.code ?? r.status ?? 'unreachable'})`);
      sealed = this.sealer.seal(r.json.capability.token);
    }
    const linkId = `lnk_${randomBytes(12).toString('base64url')}`;
    this.db.links[linkId] = { linkId, owner: b.owner, agentId: b.agentId, clientId: pending.clientId, scopes, grant, grantUse: { used: 0, reserved: {} },
      expiresAt: b.expiresAt, createdAt: now, revokedAt: null, capability: sealed, statementHash: sha(linkStatement(st)) };
    const code = token();
    this.db.codes[sha(code)] = { linkId, clientId: pending.clientId, redirectUri: pending.redirectUri, codeChallenge: pending.codeChallenge, resource: pending.resource, scopes, expiresAt: now + TTL.code };
    this.store.save();
    this.log(`mcp: link ${linkId} for ${b.owner} (agent ${b.agentId}, ${scopes.join(' ')})`);
    return { linkId, redirect: this.#redirect(pending.redirectUri, { code, state: pending.state, iss: this.issuer }) };
  }

  #redirect(uri, params) {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  // ------------------------------------------------------------ token

  token(b) {
    if (b.grant_type === 'authorization_code') return this.#code(b);
    if (b.grant_type === 'refresh_token') return this.#refresh(b);
    throw new OAuthError(400, 'unsupported_grant_type', 'authorization_code or refresh_token');
  }

  #code(b) {
    const h = sha(String(b.code ?? ''));
    const c = this.db.codes[h];
    if (!c) throw new OAuthError(400, 'invalid_grant', 'unknown or used code');
    if (c.usedAt) {
      // A code used twice: someone holds a copy. The tokens it gave are revoked with its link (OAuth 2.1 §4.1.3).
      this.revokeLink(c.linkId, 'authorization code reuse');
      throw new OAuthError(400, 'invalid_grant', 'the code was already used: the connection was revoked');
    }
    c.usedAt = this.now();
    this.store.save();
    if (c.expiresAt <= this.now()) throw new OAuthError(400, 'invalid_grant', 'the code has expired');
    if (b.client_id !== c.clientId || b.redirect_uri !== c.redirectUri) throw new OAuthError(400, 'invalid_grant', 'client_id or redirect_uri does not match the code');
    if (b.resource !== undefined && b.resource !== c.resource) throw new OAuthError(400, 'invalid_target', 'resource does not match the authorization');
    const v = String(b.code_verifier ?? '');
    const want = Buffer.from(c.codeChallenge), got = Buffer.from(b64urlSha(v));
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v) || want.length !== got.length || !timingSafeEqual(want, got)) throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed');
    return this.#issue(c.linkId, c.clientId, c.scopes, sha(token()));
  }

  #refresh(b) {
    const h = sha(String(b.refresh_token ?? ''));
    const r = this.db.refresh[h];
    if (!r) throw new OAuthError(400, 'invalid_grant', 'unknown refresh token');
    if (r.usedAt) {
      // A rotated refresh token came back: someone holds a copy. Revoke the whole link (RFC 9700 §4.14.2).
      this.revokeLink(r.linkId, 'refresh token reuse');
      throw new OAuthError(400, 'invalid_grant', 'refresh token reuse: the connection was revoked');
    }
    if (r.expiresAt <= this.now() || b.client_id !== r.clientId) throw new OAuthError(400, 'invalid_grant', 'refresh token expired or of another client');
    if (b.resource !== undefined && b.resource !== this.resource) throw new OAuthError(400, 'invalid_target', 'resource does not match');
    const link = this.db.links[r.linkId];
    if (!link || link.revokedAt || link.expiresAt <= this.now()) throw new OAuthError(400, 'invalid_grant', 'the connection was revoked or has expired');
    r.usedAt = this.now();
    return this.#issue(r.linkId, r.clientId, r.scopes, r.family);
  }

  #issue(linkId, clientId, scopes, family) {
    const link = this.db.links[linkId];
    const now = this.now();
    const access = token(), refresh = token();
    const accessExp = Math.min(now + TTL.access, link.expiresAt);
    this.db.tokens[sha(access)] = { linkId, clientId, scopes, aud: this.resource, expiresAt: accessExp, family };
    this.db.refresh[sha(refresh)] = { linkId, clientId, scopes, expiresAt: Math.min(now + TTL.refresh, link.expiresAt), family, usedAt: null };
    this.#sweep();
    this.store.save();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExp - now) / 1000)), refresh_token: refresh, scope: scopes.join(' ') };
  }

  /** RFC 7009: always 200; an access or refresh token stops working. */
  revokeToken(t) {
    const h = sha(String(t ?? ''));
    delete this.db.tokens[h];
    if (this.db.refresh[h]) this.db.refresh[h].usedAt ??= this.now();
    this.store.save();
  }

  /** The owner's signed revocation `{linkId, owner, at, signature}`, or an internal one (`why`). */
  revokeLink(linkId, why) {
    const link = this.db.links[linkId];
    if (!link) return false;
    link.revokedAt ??= this.now();
    link.revokedWhy ??= why;
    link.capability = null;
    for (const [k, v] of Object.entries(this.db.tokens)) if (v.linkId === linkId) delete this.db.tokens[k];
    for (const v of Object.values(this.db.refresh)) if (v.linkId === linkId) v.usedAt ??= this.now();
    this.store.save();
    this.log(`mcp: link ${linkId} revoked (${why})`);
    return true;
  }

  ownerRevoke(b) {
    const link = this.db.links[b?.linkId];
    if (!link) throw new OAuthError(404, 'invalid_request', 'unknown link');
    const at = Number(b.at);
    if (!Number.isInteger(at) || Math.abs(at - this.now()) > 10 * 60_000) throw new OAuthError(400, 'invalid_request', 'at must be within 10 minutes of now (ms)');
    if (b.owner !== link.owner || !verifySig(revokeStatement({ linkId: link.linkId, owner: link.owner, at }), b.signature, link.owner)) throw new OAuthError(401, 'access_denied', 'not signed by the link\'s owner');
    this.revokeLink(link.linkId, 'owner');
    return { linkId: link.linkId, revokedAt: link.revokedAt };
  }

  // ------------------------------------------------------------ the resource side

  /**
   * The principal of a request's `Authorization` header, or an OAuthError(401 invalid_token). The principal
   * holds no secret: the capability stays in the link and is opened only by `capabilityOf`.
   */
  principal(header) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(header ?? ''));
    if (!m) throw new OAuthError(401, 'invalid_token', 'a Bearer token is required');
    const t = this.db.tokens[sha(m[1])];
    if (!t) throw new OAuthError(401, 'invalid_token', 'unknown or revoked token');
    if (t.expiresAt <= this.now()) throw new OAuthError(401, 'invalid_token', 'the token has expired');
    if (t.aud !== this.resource) throw new OAuthError(401, 'invalid_token', 'the token is for another resource');
    const link = this.db.links[t.linkId];
    if (!link || link.revokedAt) throw new OAuthError(401, 'invalid_token', 'the connection was revoked');
    if (link.expiresAt <= this.now()) throw new OAuthError(401, 'invalid_token', 'the connection has expired');
    return { linkId: link.linkId, owner: link.owner, agentId: link.agentId, scopes: [...t.scopes], clientId: t.clientId, tokenExpiresAt: t.expiresAt };
  }

  link(linkId) { return this.db.links[linkId] ?? null; }

  /**
   * The owner's signed query `{owner, at, signature}` for their own operations, with or without a live connection
   * (a revoked one included). The signature covers this resource and a time within 10 minutes, and is good once.
   * Returns the owner, or throws OAuthError (401 for a bad signature, 400 otherwise).
   */
  ownerQuery(b) {
    const owner = String(b?.owner ?? '');
    const at = Number(b?.at);
    if (!owner || !Number.isInteger(at) || Math.abs(at - this.now()) > 10 * 60_000) throw new OAuthError(400, 'invalid_request', 'owner, and at within 10 minutes of now (ms), are required');
    const st = { type: 'wylls-mcp-owner-operations/1', aud: this.resource, owner, at };
    if (!verifySig(ownerQueryStatement(st), b.signature, owner)) throw new OAuthError(401, 'access_denied', 'not signed by this owner');
    this.db.seen ??= {};
    const h = sha(`oq:${b.signature}`);
    if (this.db.seen[h]) throw new OAuthError(400, 'invalid_request', 'this signed query was used already: sign a new one');
    this.db.seen[h] = { expiresAt: at + 10 * 60_000 };
    this.#sweep();
    this.store.save();
    return owner;
  }

  /** How many links hold a capability this process cannot open (another seal key). Counts only: no value leaves. */
  sealCheck() {
    let sealed = 0, unopenable = 0;
    for (const l of Object.values(this.db.links)) {
      if (!l.capability) continue;
      sealed++;
      try { this.sealer.open(l.capability); } catch { unopenable++; }
    }
    return { sealed, unopenable };
  }

  /** The agent capability of a link, opened for one relay call (never stored opened). */
  capabilityOf(linkId) {
    const l = this.db.links[linkId];
    return l?.capability ? this.sealer.open(l.capability) : null;
  }

  #sweep() {
    const now = this.now();
    for (const k of ['tokens', 'nonces', 'seen']) for (const [h, v] of Object.entries(this.db[k] ?? {})) if (v.expiresAt <= now) delete this.db[k][h];
    // A used code is kept a while as a tombstone, so that its reuse is recognised.
    for (const [h, v] of Object.entries(this.db.codes)) if (v.expiresAt + TTL.pending <= now) delete this.db.codes[h];
    for (const [h, v] of Object.entries(this.db.refresh)) if (v.expiresAt <= now) delete this.db.refresh[h];
  }
}
