#!/usr/bin/env node
// LOCAL TEST WORLD ONLY — what an external AI resident (⑤ option B) can NOT do, checked against a RUNNING local-play
// world (launcher with --external-residents <the resident's address>, the read-only MCP server, the resident admitted).
// Run by the tester, not by the resident. Every probe is an attempt the resident itself could make with what it has
// (its own key file, the launcher's page routes, its own world proxy, the MCP server), plus one read of the chain by the
// tester (the runner's loopback RPC, read-only) to show the resident's transactions have exactly one writer: itself.
//
//   node e2e/external-resident-probes.mjs --launcher http://localhost:41400 --key <resident key file> \
//     --proxy http://localhost:41428 --owner-proxy http://localhost:41412 --mcp http://127.0.0.1:41440/mcp \
//     --rpc http://127.0.0.1:41410 --owner <the world owner's address> --log <the resident's agent.mjs output> [--out probes.json]
//
// Prints one JSON line per probe ({probe, pass, ...}) and exits 1 if any probe fails. Makes one extra TEST key in
// memory only (the "someone else" signer of P9). Sends nothing that could land for anyone but the resident itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { loadKeyFile } from '../examples/external-resident/key.mjs';
import { connectMcp } from '../examples/external-resident/mcp-client.mjs';
import { localActIntentOf, localActMessage, postLocalAct, LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH, LOCAL_ACT_CONTEXT_SCHEMA, LOCAL_ACT_SUBMIT_SCHEMA } from '../../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { wireTransaction } from '../../../../permutation-server/web/sdk/solana-tx.mjs';
import { encode } from '../../../../permutation-server/web/sdk/base58.mjs';

const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
for (const k of ['launcher', 'key', 'proxy', 'owner-proxy', 'mcp', 'rpc', 'owner', 'log']) if (!a[k]) { console.error(`--${k} is required`); process.exit(64); }
const key = loadKeyFile(a.key), me = key.address;
const results = [];
const probe = (name, pass, extra = {}) => { const r = { probe: name, pass: !!pass, ...extra }; results.push(r); console.log(JSON.stringify(r)); };
const req = async (url, { method = 'GET', body, origin, headers = {} } = {}) => {
  const r = await fetch(url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t.slice(0, 200); }
  return { status: r.status, json: j, headers: r.headers };
};
const page = a.launcher;
const lp = (p, wallet) => req(`${page}/local-play/${p}`, { method: 'POST', body: p === 'worlds' ? {} : { wallet }, origin: page });

// ---- A. the launcher's page routes: the resident owns no world
const before = await lp('worlds');
probe('A1 the resident is not listed as a world owner', before.status === 200 && before.json.worlds.every(w => w.wallet !== me) && before.json.worlds.some(w => w.wallet === a.owner), { worlds: before.json.worlds?.map(w => w.wallet) });
const st = await lp('stop', me);
const after = await lp('worlds');
probe('A2 the resident cannot end the world it lives in', st.status === 403 && st.json?.error === 'NotWorldOwner' && after.json.worlds.some(w => w.wallet === a.owner && w.state === 'running'), { status: st.status, error: st.json?.error });
const kp = await lp('keeper', me);
probe('A3 the owner\'s keeper view is not the resident\'s', kp.status === 404, { status: kp.status, error: kp.json?.error });
const again = await lp('start', me);
const after2 = await lp('worlds');
probe('A4 a second start press makes no world: the same proxy again', again.status === 200 && again.json.herald === a.proxy && after2.json.worlds.length === before.json.worlds.length, { herald: again.json?.herald, worlds: after2.json.worlds?.length });

// ---- B. its world proxy: the page's routes only
const routes = [['GET', '/operators.json'], ['GET', '/externals.json'], ['POST', '/'], ['GET', '/gw/f/agent'], ['POST', '/gw/f/agent/action'], ['POST', '/gw/f/agent/command'], ['GET', '/gw/f/season'], ['POST', '/gw/frontier_setScale'], ['POST', '/gw/f/local-play/depart/submit']];
for (const [m, p] of routes) {
  const r = await req(`${a.proxy}${p}`, { method: m, origin: page, ...(m === 'POST' ? { body: { jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [me, 1e12] } } : {}) });
  // (depart/submit IS a page route of the proxy: it must be refused by the relay for this world — no expedition here —
  //  never succeed; every other path is not a route of the proxy at all)
  // (refused = a 4xx from the proxy or the relay, never a JSON-RPC result or a 2xx)
  const refused = r.status >= 400 && r.status < 500 && !(r.json && typeof r.json === 'object' && 'result' in r.json);
  const ok = p === '/gw/f/local-play/depart/submit' || p === '/' ? refused : refused && r.status === 404 && r.json?.error === 'WorldRouteDenied';
  probe(`B ${m} ${p} is refused`, ok, { status: r.status, error: r.json?.error ?? r.json?.code ?? null });
}
const noOrigin = await req(`${a.proxy}${LOCAL_ACT_CONTEXT_PATH}`, { method: 'POST', body: { schema: LOCAL_ACT_CONTEXT_SCHEMA } });
probe('B a write without the page\'s Origin is refused', noOrigin.status === 403, { status: noOrigin.status, error: noOrigin.json?.error });
const rpcDirect = await req(`${a.proxy}/`, { method: 'POST', origin: page, body: { jsonrpc: '2.0', id: 1, method: 'frontier_setScale', params: [10] } });
probe('B the runner\'s time control is not reachable through the proxy', rpcDirect.status >= 400 && rpcDirect.status < 500 && !(rpcDirect.json && typeof rpcDirect.json === 'object' && 'result' in rpcDirect.json), { status: rpcDirect.status, error: rpcDirect.json?.error ?? null });

// ---- C. the relays: one wallet each, payer = actor = sole signer
const info = (await req(`${a.proxy}/gw/f/local-play/info`)).json;
const holding = (() => { for (const l of readFileSync(a.log, 'utf8').split('\n')) { try { const j = JSON.parse(l); if (j.step === 'act' && j.seen?.village) return j.seen.village.split(',').map(Number); } catch { /* not a line */ } } return null; })();
const post = origin => (o, path, body) => postLocalAct(o, path, body, { fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: page } }) });
const identity = w => ({ address: w, programId: info.program, seasonAddress: info.season, cluster: 'localnet' });
async function signedHarvest(proxy, actor, signMessage) {
  const ctx = await post()(proxy, LOCAL_ACT_CONTEXT_PATH, { schema: LOCAL_ACT_CONTEXT_SCHEMA });
  const intent = localActIntentOf('Harvest', { holding: { p: holding[0], q: holding[1], site: holding[2] } }, {}, actor);
  const message = localActMessage(intent, identity(actor), info.rulesetHash, ctx.blockhash.hash);
  const wire = wireTransaction(message, [signMessage(message)]);
  try { const r = await post()(proxy, LOCAL_ACT_SUBMIT_PATH, { schema: LOCAL_ACT_SUBMIT_SCHEMA, name: intent.name, subject: intent.subject, fields: intent.fields, transaction_b64: Buffer.from(wire).toString('base64') }); return { sent: true, answer: r }; }
  catch (e) { return { sent: false, code: e.code, status: e.status }; }
}
const other = generateKeyPairSync('ed25519');
const otherAddr = encode(other.publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
const otherSign = m => new Uint8Array(edSign(null, Buffer.from(m), other.privateKey));
if (holding) {
  const p9 = await signedHarvest(a.proxy, me, otherSign);
  probe('C1 its relay refuses its order signed by another key', !p9.sent, p9);
  const p9b = await signedHarvest(a.proxy, otherAddr, otherSign);
  probe('C2 its relay refuses an order of another wallet', !p9b.sent, p9b);
  const p10 = await signedHarvest(a['owner-proxy'], me, key.signMessage);
  probe('C3 the owner\'s relay refuses the resident\'s own signed order', !p10.sent, p10);
} else probe('C the resident has no village yet: relay probes skipped', false, { why: 'no village in the log' });

// ---- D. MCP: read-only, the resident's own link
const meta = (await req(`${new URL(a.mcp).origin}/.well-known/oauth-authorization-server`)).json;
probe('D1 the authorization server offers the read scope only', JSON.stringify(meta.scopes_supported) === '["wylls.read"]', { scopes: meta.scopes_supported });
const reg = (await req(`${new URL(a.mcp).origin}/oauth/register`, { method: 'POST', body: { redirect_uris: ['http://127.0.0.1:9/cb'], token_endpoint_auth_method: 'none' } })).json;
const authz = s => req(`${new URL(a.mcp).origin}/oauth/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'x'.repeat(43), resource: a.mcp, scope: s, state: 's' })}`);
const w = await authz('wylls.read wylls.caravan');
probe('D2 a request for the caravan (write) scope is refused', w.status === 302 && /error=invalid_scope/.test(w.headers.get('location') ?? ''), { status: w.status, location: (w.headers.get('location') ?? '').slice(0, 160) });
const r = await authz('wylls.read');
const reqId = /const reqId="([^"]+)"/.exec(typeof r.json === 'string' ? r.json : '')?.[1] ?? /const reqId="([^"]+)"/.exec(await (await fetch(`${new URL(a.mcp).origin}/oauth/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9/cb', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'y'.repeat(43), resource: a.mcp, scope: 'wylls.read', state: 's' })}`)).text())?.[1];
const stmt = (await req(`${new URL(a.mcp).origin}/oauth/statement`, { method: 'POST', body: { reqId, owner: me, agentId: a.owner, scopes: ['wylls.read'], expiresAt: Date.now() + 600000 } })).json;
const cons = await req(`${new URL(a.mcp).origin}/oauth/consent`, { method: 'POST', body: { ...stmt.request, signature: Buffer.from(key.signMessage(Buffer.from(stmt.statementB64, 'base64'))).toString('base64') } });
probe('D3 a link naming another wallet as its agent is refused (self links only)', /error=access_denied/.test(cons.json?.redirect ?? ''), { redirect: String(cons.json?.redirect ?? cons.json?.error ?? '').slice(0, 160) });
const mcp = await connectMcp(a.mcp, key);
const names = mcp.tools.map(t => t.name);
probe('D4 tools/list: every tool is readOnlyHint, none destructive, no caravan tools', mcp.tools.length > 0 && mcp.tools.every(t => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true) && !names.includes('send_caravan') && !names.includes('prepare_caravan'), { tools: names });
let sendErr = null;
try { const x = await mcp.client.callTool({ name: 'send_caravan', arguments: { planId: 'p', requestId: 'probe-req-0001' } }); sendErr = x.isError ? 'isError' : 'NOT REFUSED'; } catch (e) { sendErr = String(e?.message ?? e).slice(0, 120); }
probe('D5 tools/call send_caravan is an unknown tool', /unknown tool|-32602|not found/i.test(sendErr), { answer: sendErr });
const conn = await mcp.call('get_connection');
probe('D6 the connection is the resident\'s own, read only', conn.value?.owner === me && conn.value?.agentId === me && conn.value?.write === false && JSON.stringify(conn.value?.scopes) === '["wylls.read"]', { owner: conn.value?.owner, agentId: conn.value?.agentId, scopes: conn.value?.scopes, write: conn.value?.write });
await mcp.close();

// ---- E. the chain (the tester's read of the runner's loopback RPC): exactly one writer for the resident
const rpc = async (method, params) => (await req(a.rpc, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } })).json?.result;
const sigs = (await rpc('getSignaturesForAddress', [me, { limit: 1000 }])) ?? [];
// (`own`: every signature the resident made; `landedOwn`: those its own follow saw land ON the chain — an order the
//  runner refused before execution (LocalActSendRefused) never reaches the chain, so it is not in the chain's list)
const own = new Set(), landedOwn = new Set();
for (const l of readFileSync(a.log, 'utf8').split('\n')) { try { const j = JSON.parse(l); if (typeof j.signature === 'string') { own.add(j.signature); if (j.outcome === 'landed') landedOwn.add(j.signature); } for (const s of j.tally?.signatures ?? []) own.add(s); } catch { /* not a line */ } }
let signedByMe = 0, bad = [], funding = 0;
for (const s of sigs) {
  const tx = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  const m = tx?.transaction?.message, keys = m?.accountKeys ?? [], nsig = m?.header?.numRequiredSignatures ?? 0;
  const i = keys.indexOf(me);
  if (i >= 0 && i < nsig) {
    signedByMe++;
    if (!(tx.transaction.signatures.length === 1 && nsig === 1 && keys[0] === me && own.has(s.signature))) bad.push({ sig: s.signature, signatures: tx.transaction.signatures.length, payer: keys[0], inMyLog: own.has(s.signature) });
  } else funding++;
}
probe('E1 every transaction the resident signs has one signature, its own, as payer, and is in its own log', signedByMe > 0 && bad.length === 0, { signedByMe, othersTouchingIt: funding, bad: bad.slice(0, 5) });
probe('E2 every order its own log saw land is on the chain as its transaction', [...landedOwn].every(x => sigs.some(s => s.signature === x)), { signedInLog: own.size, landedInLog: landedOwn.size, onChainSignedByIt: signedByMe });

const fails = results.filter(x => !x.pass);
if (a.out) writeFileSync(a.out, JSON.stringify({ at: new Date().toISOString(), resident: me, owner: a.owner, results, fails: fails.length }, null, 1));
console.log(JSON.stringify({ probes: results.length, passed: results.length - fails.length, failed: fails.length }));
process.exit(fails.length ? 1 : 0);
