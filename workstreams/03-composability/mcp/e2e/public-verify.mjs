#!/usr/bin/env node
// (2026-11-20, ③ public exposure) Drives a running bin/wylls-mcp-public.mjs over real loopback HTTP with the OFFICIAL
// MCP SDK client (a static API key in the Authorization header, as a headless agent would configure it) and raw
// probes, and writes a transcript (JSON lines; tokens redacted).
//
//   node e2e/public-verify.mjs --public http://127.0.0.1:41850 --keys <keys.json> --token-file <file> --out <t.jsonl>
//
// --token-file holds the key's token (made by bin/wylls-mcp-key.mjs add); the file is read, never printed. The revoke
// probe runs bin/wylls-mcp-key.mjs revoke on --keys and waits for the server to re-read the file.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values: v } = parseArgs({ options: { public: { type: 'string' }, keys: { type: 'string' }, 'token-file': { type: 'string' }, out: { type: 'string' }, 'key-id': { type: 'string' } }, strict: true });
const base = v.public.replace(/\/$/, '');
const url = new URL(`${base}/public/mcp`);
const token = readFileSync(v['token-file'], 'utf8').trim();
const rows = [];
let pass = 0; let fail = 0;
const redact = s => String(s).replaceAll(token, '[token]');
const check = (id, what, ok, detail = {}) => { rows.push({ id, what, result: ok ? 'PASS' : 'FAIL', ...JSON.parse(redact(JSON.stringify(detail))) }); ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${what}`); };
const post = async (body, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, www: r.headers.get('www-authenticate'), retry: r.headers.get('retry-after'), body: t ? JSON.parse(t) : null };
};
const rawHost = (host, origin) => new Promise((resolve, reject) => {
  const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', setHost: false, headers: { host, 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } }, res => {
    let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject);
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
});
const auth = { authorization: `Bearer ${token}` };

// A — the official SDK client with the key
const client = new Client({ name: 'public-verify', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: auth } }));
check('A1', 'SDK client initializes with an API key', client.getServerVersion()?.name === 'wylls-mcp-public', { server: client.getServerVersion() });
const { tools } = await client.listTools();
check('A2', 'tools/list = the 6 public read tools, all readOnlyHint', tools.length === 6 && tools.every(t => t.annotations?.readOnlyHint === true), { tools: tools.map(t => t.name) });
const season = await client.callTool({ name: 'get_world_season', arguments: {} });
check('A3', 'get_world_season reads the herald\'s real Season record', season.isError === false && /^\d+$/.test(season.structuredContent?.season), { season: season.structuredContent?.season, recordKeys: Object.keys(season.structuredContent?.record ?? {}) });
const holding = await client.callTool({ name: 'get_public_holding', arguments: { p: 0, q: 0, site: 0 } });
check('A4', 'get_public_holding on a herald without the file → NotFound (a result, not a crash)', holding.isError === true && holding.structuredContent?.error?.code === 'NotFound', { error: holding.structuredContent?.error });
// the SDK's own requests (initialize, the initialized notification, its GET stream probe) spend the burst too
await new Promise(r => setTimeout(r, 6000));
let threw = null;
try { await client.callTool({ name: 'send_caravan', arguments: { planId: 'p', requestId: 'aaaaaaaa' } }); } catch (e) { threw = e.message; }
check('A5', 'send_caravan does not exist here', /unknown tool/.test(String(threw)), { error: threw });
await client.close();

// B — auth refusals (none of these is charged to the key)
const none = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
check('B1', 'no key → 401 with a realm challenge', none.status === 401 && none.www === 'Bearer realm="wylls-public"', { status: none.status, www: none.www });
const oauthLike = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${'Q'.repeat(43)}` });
check('B2', 'an OAuth-shaped (owner link) token → 401 invalid_token, not passed anywhere', oauthLike.status === 401 && /invalid_token/.test(oauthLike.www), { status: oauthLike.status, message: oauthLike.body?.error?.message });
const forged = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}` });
check('B3', 'same key id, wrong secret → 401 unknown key', forged.status === 401 && forged.body?.error?.message === 'unknown key', { status: forged.status });

// C — exposure guards still first
const evil = await rawHost('evil.example');
check('C1', 'Host: evil.example → 403 host not allowed (DNS rebinding)', evil.status === 403 && /host not allowed/.test(evil.body), { status: evil.status });
const evilOrigin = await rawHost(`${url.hostname}:${url.port}`, 'https://evil.example');
check('C2', 'foreign Origin → 403 origin not allowed', evilOrigin.status === 403 && /origin not allowed/.test(evilOrigin.body), { status: evilOrigin.status });
const get = await fetch(url);
check('C3', 'GET /public/mcp → 405', get.status === 405, { status: get.status });
const owner = await fetch(`${base}/mcp`, { method: 'POST' });
const oauth = await fetch(`${base}/.well-known/oauth-authorization-server`);
check('C4', 'no owner endpoint and no authorization server on the public server (404)', owner.status === 404 && oauth.status === 404, { mcp: owner.status, as: oauth.status });

// D — rate limit (the server was started with WYLLS_MCP_PUBLIC_RATE=5/2)
await new Promise(r => setTimeout(r, 10_000));
let first429 = null; let retry = null;
for (let i = 1; i <= 12; i++) {
  const r = await post({ jsonrpc: '2.0', id: i, method: 'ping' }, auth);
  if (r.status === 429) { first429 = i; retry = r.retry; break; }
}
check('D1', 'per-key burst → 429 with retry-after', first429 !== null && /^\d+$/.test(String(retry)), { first429, retryAfter: retry });
await new Promise(r => setTimeout(r, Number(retry) * 1000 + 200));
const after = await post({ jsonrpc: '2.0', id: 99, method: 'ping' }, auth);
check('D2', 'after retry-after the key works again', after.status === 200, { status: after.status });

// E — revoke via the key file, no restart
execFileSync(process.execPath, [new URL('../bin/wylls-mcp-key.mjs', import.meta.url).pathname, 'revoke', '--file', v.keys, '--id', v['key-id']], { stdio: ['ignore', 'ignore', 'ignore'] });
let revoked = null;
for (let i = 0; i < 16 && revoked === null; i++) {
  await new Promise(r => setTimeout(r, 1000));
  const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, auth);
  if (r.status === 401) revoked = { afterSecs: i + 1, message: r.body?.error?.message };
}
check('E1', 'a revoked key (key file edited, no restart) → 401 within ~6 s', revoked !== null && revoked.message === 'the key was revoked', revoked ?? {});

writeFileSync(v.out, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
