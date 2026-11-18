#!/usr/bin/env node
// Drives a RUNNING MCP server (bin/wylls-mcp.mjs) over real loopback HTTP, as an MCP client and the owner's wallet
// would, and checks each answer (2026-11-18). Happy paths, bad auth, bad input and replays. Writes one JSON line per
// exchange to --out (tokens, codes and signatures redacted) and prints a PASS/FAIL table; exit 1 when any check fails.
//
//   node e2e/http-verify.mjs --mcp http://127.0.0.1:41530 --stack http://127.0.0.1:41510 --board http://127.0.0.1:41520 \
//        --out transcript.jsonl [--phase main|board-down|rate-limit]
//
// The stack is e2e/http-stack.mjs (its /__test/sign stands in for the owner's browser wallet: a test key in memory).
// The board is workstream 01's coop/board.mjs, started against that stack's herald. Loopback only; no real key.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import nodeHttp from 'node:http';
import { messageOf } from '../../../01-national-strategy/coop/record.mjs';

const { values: a } = parseArgs({ options: { mcp: { type: 'string' }, stack: { type: 'string' }, board: { type: 'string' }, out: { type: 'string' }, phase: { type: 'string' } }, strict: true });
const MCP = a.mcp, STACK = a.stack, BOARD = a.board, OUT = a.out, PHASE = a.phase ?? 'main';
if (!MCP || !STACK || !OUT) { console.error('usage: --mcp <url> --stack <url> [--board <url>] --out <file> [--phase main|board-down|rate-limit]'); process.exit(64); }
for (const u of [MCP, STACK, BOARD].filter(Boolean)) if (!['127.0.0.1', 'localhost'].includes(new URL(u).hostname)) { console.error('loopback only'); process.exit(64); }
if (PHASE === 'main') writeFileSync(OUT, '');
// One request id per run: the server keeps ids per agent across connections (a reused id on another connection is
// refused, RequestIdUsedOnAnotherConnection), so a second run against the same store must not reuse the first one's.
const RID = `verify-${Date.now().toString(36)}`;

const SECRET = /((?:access_token|refresh_token|code|code_verifier|signature|token|statementB64|bytesB64|sig)\\?"?\s*[:=]\s*\\?"?)([A-Za-z0-9_\-+/=.~]{12,})/g;
const redact = s => String(s).replace(SECRET, (m, k, v) => (/^[A-Za-z]+$/.test(v) ? m : `${k}${v.slice(0, 6)}…[redacted]`)).replace(/Bearer [A-Za-z0-9_-]+/g, 'Bearer …[redacted]').replace(/([?&](?:code|code_challenge)=)[^&"]+/g, '$1…[redacted]');
const results = [];
let step = 0;

async function http(label, method, url, { headers = {}, body, form = false, raw } = {}) {
  const h = { ...headers };
  let b;
  if (raw !== undefined) b = raw;
  else if (body !== undefined) { h['content-type'] ??= form ? 'application/x-www-form-urlencoded' : 'application/json'; b = form ? new URLSearchParams(body).toString() : JSON.stringify(body); }
  let res = await fetch(url, { method, headers: h, body: b, redirect: 'manual' });
  // A well-behaved client waits out the per-address limit (429 + Retry-After) on the unauthenticated OAuth routes; the
  // rate-limit phase does not, it counts them. Each 429 is still written to the transcript.
  for (let i = 0; res.status === 429 && PHASE !== 'rate-limit' && i < 20; i++) {
    appendFileSync(OUT, `${JSON.stringify({ n: ++step, phase: PHASE, label: `${label} (429, waiting ${res.headers.get('retry-after')}s)`, res: { status: 429 } })}\n`);
    await res.text();
    await new Promise(r => setTimeout(r, 1000 * Number(res.headers.get('retry-after') ?? 2) + 100));
    res = await fetch(url, { method, headers: h, body: b, redirect: 'manual' });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
  const keep = ['www-authenticate', 'mcp-session-id', 'location', 'retry-after', 'content-type', 'allow', 'cache-control'];
  const rh = Object.fromEntries(keep.filter(k => res.headers.get(k) !== null).map(k => [k, k === 'mcp-session-id' ? '<set>' : res.headers.get(k)]));
  appendFileSync(OUT, `${redact(JSON.stringify({ n: ++step, phase: PHASE, label, req: { method, url, headers: h, body: b === undefined ? undefined : String(b).slice(0, 600) }, res: { status: res.status, headers: rh, body: text.slice(0, 1200) } }))}\n`);
  return { status: res.status, headers: res.headers, text, json };
}
/** One request with exactly this Host header (node:http: fetch would replace it). */
function rawHost(label, method, url, host, body) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, setHost: false, headers: { host, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => {
        appendFileSync(OUT, `${redact(JSON.stringify({ n: ++step, phase: PHASE, label, req: { method, url, headers: { host }, body }, res: { status: res.statusCode, body: text.slice(0, 600) } }))}\n`);
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
function check(id, what, ok, detail = '') {
  results.push({ id, what, ok: !!ok, detail });
  appendFileSync(OUT, `${redact(JSON.stringify({ check: id, what, verdict: ok ? 'PASS' : 'FAIL', detail }))}\n`);
}
const sha256url = s => createHash('sha256').update(s).digest('base64url');
const world = await (await fetch(`${STACK}/__test/world`)).json();
const signAs = async (who, bytesB64) => (await (await fetch(`${STACK}/__test/${who === 'stranger' ? 'sign-as-stranger' : 'sign'}`, { method: 'POST', body: JSON.stringify({ bytesB64 }) })).json()).signature;
const chainSent = async () => (await (await fetch(`${STACK}/__test/chain`)).json()).sent;

/** register → authorize → statement → consent → (code). `signer`: 'owner' | 'stranger'. */
async function consent({ scopes = ['wylls.read', 'wylls.caravan'], signer = 'owner', redirect = 'http://127.0.0.1:41599/callback', clientId = null, label = 'connect' } = {}) {
  if (!clientId) {
    const reg = await http(`${label}: register`, 'POST', `${MCP}/oauth/register`, { body: { redirect_uris: [redirect], client_name: 'verify-3-4-13 driver', token_endpoint_auth_method: 'none' } });
    clientId = reg.json?.client_id;
  }
  const verifier = createHash('sha256').update(`${label}${Math.random()}`).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: scopes.join(' '), state: 'st', code_challenge: sha256url(verifier), code_challenge_method: 'S256', resource: `${MCP}/mcp` });
  const page = await http(`${label}: authorize`, 'GET', `${MCP}/oauth/authorize?${q}`);
  const reqId = /const reqId="([^"]+)"/.exec(page.text)?.[1];
  const caravan = scopes.includes('wylls.caravan');
  const exp = Date.now() + 3_600_000;
  const st = await http(`${label}: statement`, 'POST', `${MCP}/oauth/statement`, { body: { reqId, owner: world.owner, agentId: world.agentId, scopes, expiresAt: exp, ...(caravan ? { grant: { actions: ['SendCaravan'], maxSends: 3, maxCargo: Array(8).fill(500), expiresAt: exp } } : {}) } });
  const sig = await signAs(signer, st.json.statementB64);
  const rotate = st.json.rotate ? { command: st.json.rotate.command, signature: await signAs(signer, st.json.rotate.bytesB64) } : undefined;
  const c = await http(`${label}: consent`, 'POST', `${MCP}/oauth/consent`, { body: { ...st.json.request, signature: sig, ...(rotate ? { rotate } : {}) } });
  const back = c.json?.redirect ? new URL(c.json.redirect) : null;
  return { clientId, verifier, redirect, reqId, st, consent: c, code: back?.searchParams.get('code') ?? null, error: back?.searchParams.get('error') ?? null, page };
}
const exchange = (label, c, verifier = c.verifier) => http(label, 'POST', `${MCP}/oauth/token`, { form: true, body: { grant_type: 'authorization_code', code: c.code, code_verifier: verifier, client_id: c.clientId, redirect_uri: c.redirect, resource: `${MCP}/mcp` } });
let rpcId = 0;
const rpc = (label, token, method, params, { headers = {}, id = ++rpcId } = {}) => http(label, 'POST', `${MCP}/mcp`, { headers: { accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) } });
const tool = async (label, token, name, args = {}) => (await rpc(label, token, 'tools/call', { name, arguments: args })).json?.result;

if (PHASE === 'main') {
  // ---------------------------------------------------------------- A. discovery and unauthenticated access
  const prm = await http('A1 protected resource metadata', 'GET', `${MCP}/.well-known/oauth-protected-resource`);
  check('A1', 'RFC 9728 metadata names exactly <issuer>/mcp', prm.status === 200 && prm.json?.resource === `${MCP}/mcp`, prm.json?.resource);
  const asm = await http('A2 authorization server metadata', 'GET', `${MCP}/.well-known/oauth-authorization-server`);
  check('A2', 'RFC 8414 metadata: PKCE S256 only', asm.status === 200 && JSON.stringify(asm.json?.code_challenge_methods_supported) === '["S256"]');
  const noAuth = await rpc('A3 initialize without a token', null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
  check('A3', 'no token → 401 + WWW-Authenticate resource_metadata', noAuth.status === 401 && /resource_metadata=/.test(noAuth.headers.get('www-authenticate') ?? ''));
  const bad = await rpc('A4 garbage bearer', 'x'.repeat(40), 'tools/list');
  check('A4', 'unknown bearer → 401 invalid_token', bad.status === 401 && /invalid_token/.test(bad.headers.get('www-authenticate') ?? ''));
  const evil = await http('A5 foreign Origin on /mcp', 'POST', `${MCP}/mcp`, { headers: { origin: 'https://evil.example' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  check('A5', 'foreign Origin → 403 (DNS rebinding / CSRF guard)', evil.status === 403);
  const g = await http('A6 GET /mcp', 'GET', `${MCP}/mcp`);
  check('A6', 'GET /mcp → 405 (no SSE stream)', g.status === 405);
  const nf = await http('A7 unknown route', 'GET', `${MCP}/admin`);
  check('A7', 'unknown route → 404', nf.status === 404);
  const evilOriginReg = await http('A8 foreign Origin on DCR', 'POST', `${MCP}/oauth/register`, { headers: { origin: 'https://evil.example' }, body: { redirect_uris: ['http://127.0.0.1:41599/cb'] } });
  check('A8', 'foreign Origin on an OAuth POST → 403', evilOriginReg.status === 403);

  // ---------------------------------------------------------------- B. dynamic client registration
  const r1 = await http('B1 DCR with a foreign redirect', 'POST', `${MCP}/oauth/register`, { body: { redirect_uris: ['https://evil.example/cb'] } });
  check('B1', 'DCR refuses a redirect outside the allowed profiles', r1.status === 400, r1.json?.error);
  const r2 = await http('B2 DCR with a loopback redirect', 'POST', `${MCP}/oauth/register`, { body: { redirect_uris: ['http://127.0.0.1:41599/callback'], token_endpoint_auth_method: 'none' } });
  check('B2', 'DCR accepts a loopback public client (anyone may register: open DCR)', r2.status === 201 && !!r2.json?.client_id);
  const r3 = await http('B3 DCR body not JSON', 'POST', `${MCP}/oauth/register`, { headers: { 'content-type': 'application/json' }, raw: '{nope' });
  check('B3', 'DCR malformed body → 400', r3.status === 400);

  // ---------------------------------------------------------------- C. authorize
  const cid = r2.json.client_id;
  const noPkce = await http('C1 authorize without PKCE', 'GET', `${MCP}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: 'http://127.0.0.1:41599/callback', scope: 'wylls.read', state: 's', resource: `${MCP}/mcp` })}`);
  check('C1', 'authorize without code_challenge → refused (redirect with error or 400)', (noPkce.status === 302 && /error=/.test(noPkce.headers.get('location') ?? '')) || noPkce.status === 400, `${noPkce.status} ${noPkce.headers.get('location') ?? ''}`.slice(0, 160));
  const wrongRes = await http('C2 authorize for another resource', 'GET', `${MCP}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: 'http://127.0.0.1:41599/callback', scope: 'wylls.read', state: 's', code_challenge: 'b'.repeat(43), code_challenge_method: 'S256', resource: 'http://127.0.0.1:1/mcp' })}`);
  check('C2', 'authorize with a foreign resource (RFC 8707) → refused', wrongRes.status === 302 ? /error=/.test(wrongRes.headers.get('location') ?? '') : wrongRes.status >= 400, `${wrongRes.status}`);
  const unkClient = await http('C3 authorize for an unknown client', 'GET', `${MCP}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'nope', redirect_uri: 'http://127.0.0.1:41599/callback', scope: 'wylls.read', state: 's', code_challenge: 'b'.repeat(43), code_challenge_method: 'S256', resource: `${MCP}/mcp` })}`);
  check('C3', 'unknown client_id → 400, no redirect to an unverified URI', unkClient.status === 400);

  // ---------------------------------------------------------------- D. consent (the owner's wallet signature)
  const forged = await consent({ signer: 'stranger', label: 'D1 forged' });
  check('D1', 'consent signed by another key → access_denied, no code', forged.error === 'access_denied' && !forged.code, forged.error);
  const replayConsent = await http('D2 consent replay (same reqId)', 'POST', `${MCP}/oauth/consent`, { body: { ...forged.st.json.request, signature: 'AAAA' } });
  check('D2', 'a consent request is one-use: replaying its reqId → 400', replayConsent.status === 400);
  const c1 = await consent({ label: 'D3 owner' });
  check('D3', 'owner-signed consent (read + caravan, ⑤ per-sender rotate) → code', !!c1.code, c1.error ?? '');
  check('D4', 'consent page is CSP-locked and frame-denied', /default-src 'none'/.test(c1.page.headers.get('content-security-policy') ?? '') && c1.page.headers.get('x-frame-options') === 'DENY');

  // ---------------------------------------------------------------- E. token endpoint
  const t1 = await exchange('E1 code → tokens', c1);
  check('E1', 'code + PKCE verifier → access + refresh token', t1.status === 200 && !!t1.json?.access_token && !!t1.json?.refresh_token);
  const t1again = await exchange('E2 code replay', c1);
  check('E2', 'code reuse → invalid_grant (and the link is revoked)', t1again.status === 400 && t1again.json?.error === 'invalid_grant', t1again.json?.error_description);
  const afterReuse = await rpc('E3 token after code reuse', t1.json.access_token, 'tools/list');
  check('E3', 'the token issued from a replayed code stops working (401)', afterReuse.status === 401);
  const c2 = await consent({ label: 'E4 owner (wrong verifier)' });
  const wrongV = await exchange('E4 wrong PKCE verifier', c2, 'z'.repeat(43));
  check('E4', 'wrong PKCE verifier → invalid_grant', wrongV.status === 400 && wrongV.json?.error === 'invalid_grant');
  const c3 = await consent({ label: 'E5 owner' });
  const tok = await exchange('E5 code → tokens', c3);
  const T = tok.json?.access_token;
  check('E5', 'fresh connection: tokens issued', !!T);
  const badGrant = await http('E6 unsupported grant type', 'POST', `${MCP}/oauth/token`, { form: true, body: { grant_type: 'password', username: 'a', password: 'b' } });
  check('E6', 'grant_type=password → unsupported_grant_type', badGrant.status === 400 && badGrant.json?.error === 'unsupported_grant_type');

  // ---------------------------------------------------------------- F. MCP with the token
  const init = await rpc('F1 initialize', T, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } });
  check('F1', 'initialize → 200 with a session id', init.status === 200 && init.json?.result?.serverInfo?.name === 'wylls-mcp' && init.headers.get('mcp-session-id'));
  const note = await rpc('F2 notifications/initialized', T, 'notifications/initialized', undefined, { id: null });
  check('F2', 'a notification → 202, no body', note.status === 202);
  const pv = await rpc('F3 unsupported protocol version header', T, 'tools/list', undefined, { headers: { 'mcp-protocol-version': '1999-01-01' } });
  check('F3', 'unsupported MCP-Protocol-Version → 400', pv.status === 400);
  const list = await rpc('F4 tools/list', T, 'tools/list');
  const names = (list.json?.result?.tools ?? []).map(t => t.name);
  check('F4', 'tools/list → 9 tools incl. get_cooperation_status (opted in)', names.length === 9 && names.includes('get_cooperation_status'), names.join(','));
  const conn = await tool('F5 get_connection', T, 'get_connection');
  check('F5', 'get_connection names the owner and scopes', conn?.structuredContent?.owner === world.owner || JSON.stringify(conn ?? {}).includes(world.owner));
  const vs = await tool('F6 get_village_status', T, 'get_village_status');
  check('F6', 'get_village_status reads the owner\'s village through relay + herald', vs?.isError === false && vs?.structuredContent?.owner === world.owner);
  const sf = await tool('F7 check_resource_shortfall', T, 'check_resource_shortfall', { goal: { kind: 'vault' } });
  check('F7', 'check_resource_shortfall: Stone short 150', sf?.structuredContent?.rows?.find(r => r.resource === 'Stone')?.short === 150);
  const from = vs?.structuredContent?.storehouses?.[0]?.placeId, to = vs?.structuredContent?.village?.placeId;
  const plan = await tool('F8 prepare_caravan', T, 'prepare_caravan', { from, to, cargo: { Stone: 150 } });
  const planId = plan?.structuredContent?.planId;
  check('F8', 'prepare_caravan → a plan', !!planId);
  const before = await chainSent();
  const sent = await tool('F9 send_caravan', T, 'send_caravan', { planId, requestId: RID });
  const after1 = await chainSent();
  check('F9', 'send_caravan → sent through the agent wallet; one transaction on the (scripted) chain', sent?.isError === false && after1 === before + 1, JSON.stringify(sent?.structuredContent ?? {}).slice(0, 200));
  const again = await tool('F10 send_caravan replay (same requestId)', T, 'send_caravan', { planId, requestId: RID });
  const after2 = await chainSent();
  check('F10', 'replay with the same requestId → the same operation, no second transaction', after2 === after1 && (again?.structuredContent?.operationId ?? again?.structuredContent?.operation?.operationId) === (sent?.structuredContent?.operationId ?? sent?.structuredContent?.operation?.operationId), JSON.stringify(again?.structuredContent ?? {}).slice(0, 200));
  const plan2 = await tool('F11a prepare_caravan (second plan)', T, 'prepare_caravan', { from, to, cargo: { Stone: 10 } });
  const clash = await tool('F11 same requestId, another plan', T, 'send_caravan', { planId: plan2?.structuredContent?.planId, requestId: RID });
  const after3 = await chainSent();
  check('F11', 'the same requestId for another plan → refused, nothing sent', after3 === after2 && (clash?.isError === true || !!clash?.structuredContent?.error), JSON.stringify(clash?.structuredContent?.error ?? clash?.structuredContent ?? {}).slice(0, 200));
  const opId = sent?.structuredContent?.operationId ?? sent?.structuredContent?.operation?.operationId;
  const os = await tool('F12 get_operation_status', T, 'get_operation_status', { operationId: opId });
  check('F12', 'get_operation_status reads the operation', os?.isError === false, JSON.stringify(os?.structuredContent ?? {}).slice(0, 160));
  const lo = await tool('F13 list_operations', T, 'list_operations');
  check('F13', 'list_operations lists it', JSON.stringify(lo?.structuredContent ?? {}).includes(String(opId)));
  const unk = await rpc('F14 unknown tool', T, 'tools/call', { name: 'drain_wallet', arguments: {} });
  check('F14', 'unknown tool → an error, nothing done', !!unk.json?.error || unk.json?.result?.isError === true);
  const badCargo = await tool('F15 prepare_caravan bad input', T, 'prepare_caravan', { from, to, cargo: { Stone: -5, Unobtainium: 1 } });
  check('F15', 'bad cargo → refused', badCargo?.isError === true || !!badCargo?.structuredContent?.error);
  const otherOwner = await tool('F16 get_cooperation_status for another owner', T, 'get_cooperation_status', { owner: world.stranger });
  check('F16', 'get_cooperation_status refuses caller-supplied owner/world (BadRequest)', otherOwner?.structuredContent?.error?.code === 'BadRequest');
  const pj = await http('F17 body not JSON', 'POST', `${MCP}/mcp`, { headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, raw: '{"jsonrpc":' });
  check('F17', 'unparseable body → 400 JSON-RPC -32700', pj.status === 400 && pj.json?.error?.code === -32700);
  const batch = await http('F18 batch', 'POST', `${MCP}/mcp`, { headers: { authorization: `Bearer ${T}` }, body: [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }] });
  check('F18', 'a batch → 400 -32600', batch.status === 400 && batch.json?.error?.code === -32600);
  const big = await http('F19 70 KB body', 'POST', `${MCP}/mcp`, { headers: { authorization: `Bearer ${T}`, 'content-type': 'application/json' }, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(70_000) } }) });
  check('F19', 'a body over 64 KiB → 413', big.status === 413);

  // ---------------------------------------------------------------- J. the cooperation board read (real board)
  const coop0 = await tool('J1 get_cooperation_status (no records yet)', T, 'get_cooperation_status');
  check('J1', 'get_cooperation_status reads the real board for the authenticated owner', coop0?.isError === false, JSON.stringify(coop0?.structuredContent ?? {}).slice(0, 240));
  if (BOARD) {
    const [p, q, site] = world.village;
    const now = Math.floor(Date.now() / 1000);
    const body = { v: 1, season: { programId: world.programId, seasonId: world.seasonId }, at: now, kind: 'request', goalId: 'crossing-storehouse-v1', need: { wood: 200, stone: 200 }, to: { kind: 'holding', p, q, site, gen: 1 }, nation: 2, expiresAt: now + 86_400, nonce: 'verify-3-4-13', signer: world.owner };
    const sig = await signAs('owner', Buffer.from(messageOf(body)).toString('base64'));
    const post = await http('J2 board: owner posts a signed request record', 'POST', `${BOARD}/coop/records`, { body: { ...body, sig } });
    check('J2', 'the real board accepts the owner-signed request record', post.status === 200 && post.json?.ok === true, JSON.stringify(post.json).slice(0, 160));
    const forgedRec = await http('J3 board: the same record re-signed by another key', 'POST', `${BOARD}/coop/records`, { body: { ...body, nonce: 'forged', sig: await signAs('stranger', Buffer.from(messageOf({ ...body, nonce: 'forged' })).toString('base64')) } });
    check('J3', 'the board refuses a record not signed by its signer', forgedRec.status === 400);
    const dup = await http('J4 board: the same record again', 'POST', `${BOARD}/coop/records`, { body: { ...body, sig } });
    check('J4', 'the board refuses a duplicate record', dup.status === 400, JSON.stringify(dup.json).slice(0, 120));
    const coop1 = await tool('J5 get_cooperation_status (with the request)', T, 'get_cooperation_status');
    const s = JSON.stringify(coop1?.structuredContent ?? {});
    check('J5', 'the adapter accepts the REAL board shape (lowercase resources, numeric/null nation) and shows the request', coop1?.isError === false && /"wood"/.test(s) && /200/.test(s), s.slice(0, 300));
  }

  // ---------------------------------------------------------------- G. scope: a read-only connection
  const ro = await consent({ scopes: ['wylls.read'], label: 'G read-only' });
  const roTok = (await exchange('G1 read-only tokens', ro)).json?.access_token;
  const roVs = await tool('G2 read-only: get_village_status', roTok, 'get_village_status');
  check('G2', 'read-only token can read', roVs?.isError === false);
  const roPlan = await tool('G3a read-only: prepare_caravan', roTok, 'prepare_caravan', { from, to, cargo: { Stone: 1 } });
  const s0 = await chainSent();
  const roSend = await tool('G3 read-only: send_caravan', roTok, 'send_caravan', { planId: roPlan?.structuredContent?.planId ?? planId, requestId: `${RID}-ro` });
  check('G3', 'read-only token cannot send (scope), nothing sent', (roSend?.isError === true || !!roSend?.structuredContent?.error) && (await chainSent()) === s0, JSON.stringify(roSend?.structuredContent?.error ?? {}).slice(0, 160));

  // ---------------------------------------------------------------- H. refresh rotation and reuse detection
  const ref1 = await http('H1 refresh', 'POST', `${MCP}/oauth/token`, { form: true, body: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: c3.clientId } });
  check('H1', 'refresh → new tokens (rotation)', ref1.status === 200 && ref1.json?.refresh_token && ref1.json.refresh_token !== tok.json.refresh_token);
  const ref2 = await http('H2 old refresh token reused', 'POST', `${MCP}/oauth/token`, { form: true, body: { grant_type: 'refresh_token', refresh_token: tok.json.refresh_token, client_id: c3.clientId } });
  check('H2', 'reuse of a rotated refresh token → invalid_grant', ref2.status === 400 && ref2.json?.error === 'invalid_grant');
  const dead = await rpc('H3 new access token after refresh reuse', ref1.json.access_token, 'tools/list');
  check('H3', 'refresh reuse revokes the whole link: the new token is 401 too', dead.status === 401);
  const revoked = await http('H4 RFC 7009 revoke an unknown token', 'POST', `${MCP}/oauth/revoke`, { form: true, body: { token: 'nope' } });
  check('H4', 'revocation endpoint answers 200 for any token', revoked.status === 200);

  // ---------------------------------------------------------------- L. exposure probes (findings, not pass/fail of the code's own contract)
  // fetch drops a Host header it is given (a forbidden header), so this probe uses node:http with the Host as written.
  const hostProbe = await rawHost('L1 DCR with a foreign Host header, no Origin', 'POST', `${MCP}/oauth/register`, 'evil.example', JSON.stringify({ redirect_uris: ['http://127.0.0.1:41599/cb'] }));
  check('L1', 'a foreign Host header (DNS rebinding) → 403 before any route (2026-11-18 fix; without allowedHosts it is accepted: test X3)', hostProbe.status === 403, `status ${hostProbe.status}`);
  const hostOk = await rawHost('L1b loopback Host with another port', 'GET', `${MCP}/.well-known/oauth-protected-resource`, 'localhost:1');
  check('L1b', 'a loopback Host name passes, port-agnostic', hostOk.status === 200);
  const lrs = await http('L2 /link/revoke/statement for an unknown link', 'POST', `${MCP}/link/revoke/statement`, { body: { linkId: 'lnk_nope' } });
  check('L2', 'unauthenticated revoke statement for an unknown link → 404', lrs.status === 404);
  // the cooperation board itself: public by design (loopback bound); anyone can read any wallet's involvement
  if (BOARD) {
    const pub = await http('L3 board /coop/view?viewer=<owner> without any credential', 'GET', `${BOARD}/coop/view?viewer=${world.owner}`);
    check('L3', 'INFO: the board\'s /coop/view answers any caller about any viewer (public by design)', pub.status === 200, `myRequests ${pub.json?.personal?.myRequests?.length ?? pub.json?.myRequests?.length ?? '?'}`);
  }
  // keep the token for the next phases
  writeFileSync(`${OUT}.token`, JSON.stringify({ T: ro ? roTok : null }), { mode: 0o600 });
}

if (PHASE === 'board-down') {
  const { T } = JSON.parse((await import('node:fs')).readFileSync(`${OUT}.token`, 'utf8'));
  const r = await tool('K1 get_cooperation_status with the board stopped', T, 'get_cooperation_status');
  check('K1', 'board down → CoopBoardUnavailable, retryable, nothing invented', r?.structuredContent?.error?.code === 'CoopBoardUnavailable' && r?.structuredContent?.error?.retryable === true, JSON.stringify(r?.structuredContent?.error ?? r).slice(0, 200));
}

if (PHASE === 'rate-limit') {
  let limited = 0, first = null;
  for (let i = 0; i < 30; i++) {
    const r = await http(`I${i + 1} DCR burst`, 'POST', `${MCP}/oauth/register`, { body: { redirect_uris: ['http://127.0.0.1:41599/cb'] } });
    if (r.status === 429) { limited++; first ??= i + 1; }
  }
  check('I1', 'unauthenticated state-keeping routes are rate limited per address (429 after the burst)', limited > 0, `first 429 at request ${first}, ${limited}/30 limited`);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(4)} ${r.what}${r.detail && !r.ok ? `  [${String(r.detail).slice(0, 200)}]` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed (${PHASE})`);
process.exitCode = failed ? 1 : 0;
