#!/usr/bin/env node
// Drives a RUNNING agent-gateway-bridge.mjs over real loopback HTTP (2026-11-18): ④'s send path through the agent
// wallet's gateway (real gateway code, scripted chain [MOCK]). Happy path, replays under the same idempotency key, a
// lost answer, a send that throws after signing, the fate read, the owner's stop and bad input. One JSON line per
// exchange to --out, a PASS/FAIL table on stdout; exit 1 on any failure.
//
//   WS04_BRIDGE_PORT=41540 node bridge/agent-gateway-bridge.mjs &
//   node bridge/http-verify.mjs --bridge http://127.0.0.1:41540 --out transcript.jsonl
//
// The request body is the one src/gateway.rs builds (source mcp, idempotencyKey, policyVersion, SendCaravan fields).
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { placeData, cargoBytes } from '../../../permutation-server/web/frontier/fplay.mjs';

const { values: a } = parseArgs({ options: { bridge: { type: 'string' }, out: { type: 'string' } }, strict: true });
const B = a.bridge, OUT = a.out;
if (!B || !OUT || !['127.0.0.1', 'localhost'].includes(new URL(B).hostname)) { console.error('usage: --bridge http://127.0.0.1:<port> --out <file>'); process.exit(64); }
writeFileSync(OUT, '');
let n = 0;
const results = [];
async function call(label, method, path, body, { raw } = {}) {
  const res = await fetch(`${B}${path}`, { method, headers: body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  appendFileSync(OUT, `${JSON.stringify({ n: ++n, label, req: { method, path, body: raw ?? body }, res: { status: res.status, body: text.slice(0, 1500) } })}\n`);
  return { status: res.status, json, text };
}
const check = (id, what, ok, detail = '') => { results.push({ id, what, ok: !!ok, detail }); appendFileSync(OUT, `${JSON.stringify({ check: id, what, verdict: ok ? 'PASS' : 'FAIL', detail })}\n`); };
const chain = async () => (await call('chain count', 'GET', '/chain')).json.sent;

const pre = await call('W1 action before setup', 'POST', '/action', { request: {} });
check('W1', 'an action before /setup → 409, nothing sent', pre.status === 409);
const setup = await call('W2 setup', 'POST', '/setup', {});
const [P, Q, SITE] = setup.json.village;
check('W2', '/setup: a fresh relay, owner and agent in auto mode', setup.status === 200 && !!setup.json.agentId);
const VAULT = { kind: 'vault', p: P, q: Q, tile: 20 };
const req = (key, seq, stone = 100) => ({ source: 'mcp', idempotencyKey: key, policyVersion: setup.json.policyVersion, reason: 'verify-3-4-13', action: { name: 'SendCaravan', holding: [P, Q, SITE], fields: { seq, ...placeData({ ...VAULT, gen: 1 }), steps: 3, path: Array(12).fill(0), cargo: Array.from(cargoBytes([0, stone, 0, 0, 0, 0, 0, 0])), fee: '50000' }, route: { dst: VAULT, provinces: [{ p: P, q: Q }] } } });

// ---------------------------------------------------------------- the happy path and replays
const c0 = await chain();
const s1 = await call('W3 SendCaravan k1 (seq 0)', 'POST', '/action', { request: req('ws04:verify:k1', 0) });
const c1 = await chain();
check('W3', 'SendCaravan → sent with a signature; one transaction', s1.json?.status === 'sent' && !!s1.json?.signature && c1 === c0 + 1, JSON.stringify(s1.json).slice(0, 200));
const tx = await call('W3b the sent transaction', 'GET', `/tx?sig=${s1.json?.signature}`);
check('W3b', 'the transaction on the chain is a SendCaravan from the agent\'s village, finalized', tx.json?.found && tx.json?.srcIsVillage && tx.json?.finalized);
const r1 = await call('W4 the same request again (k1)', 'POST', '/action', { request: req('ws04:verify:k1', 0) });
check('W4', 'replay under the same key → the remembered answer (same signature), no second transaction', r1.json?.signature === s1.json?.signature && (await chain()) === c1, JSON.stringify(r1.json).slice(0, 160));
const k1other = await call('W5 key k1 with other content', 'POST', '/action', { request: req('ws04:verify:k1', 0, 7) });
check('W5', 'the same key with different content → refused, nothing sent', k1other.json?.status !== 'sent' && (await chain()) === c1, JSON.stringify(k1other.json?.error ?? k1other.json).slice(0, 200));

// ---------------------------------------------------------------- the same seq under another key
const dupSeq = await call('W6 seq 0 again under a new key k1b', 'POST', '/action', { request: req('ws04:verify:k1b', 0) });
const c6 = await chain();
check('W6', 'INFO: the same seq under a new key (different bytes) — the gateway does not refuse seq reuse itself; the program\'s Citizen.CARAVANS check is not run by the scripted chain', true, `status ${dupSeq.json?.status}, chain ${c1}→${c6}`);

// ---------------------------------------------------------------- a lost answer, then a retry with the same key
const lost = await call('W7 k2 (seq 1) with the answer dropped', 'POST', '/action', { request: req('ws04:verify:k2', 1), fault: 'drop' });
const c7 = await chain();
const retry = await call('W7b retry k2', 'POST', '/action', { request: req('ws04:verify:k2', 1) });
check('W7', 'answer lost after the send (504) → retry under the same key returns the first send, no second transaction', lost.status === 504 && c7 === c6 + 1 && retry.json?.status === 'sent' && (await chain()) === c7, `retry ${retry.json?.status} ${String(retry.json?.signature).slice(0, 12)}`);
const fate2 = await call('W7c fate k2', 'GET', '/fate?key=ws04:verify:k2');
check('W7c', 'GET /f/agent/fate for k2 names its signature and a final state', fate2.status === 200 && fate2.json?.signature === retry.json?.signature, JSON.stringify(fate2.json).slice(0, 240));

// ---------------------------------------------------------------- a send that throws after signing
const thrown = await call('W8 k3 (seq 2): the RPC drops after the send', 'POST', '/action', { request: req('ws04:verify:k3', 2), fault: 'sendThrows' });
const c8 = await chain();
check('W8', 'send threw after signing → failed WITH its signature (never "not sent"); the tx did reach the chain', thrown.json?.status === 'failed' && !!thrown.json?.signature && c8 === (await chain()) && c8 === c7 + 1, JSON.stringify(thrown.json).slice(0, 220));
const fate3 = await call('W8b fate k3', 'GET', '/fate?key=ws04:verify:k3');
check('W8b', 'the fate read follows the chain for k3 (the uncertain send is resolved by reading, not by resending)', fate3.status === 200 && fate3.json?.signature === thrown.json?.signature, JSON.stringify(fate3.json).slice(0, 240));
const again3 = await call('W8c retry k3', 'POST', '/action', { request: req('ws04:verify:k3', 2) });
check('W8c', 'retrying k3 → the remembered failure, no resend', (await chain()) === c8 && again3.json?.signature === thrown.json?.signature, JSON.stringify(again3.json).slice(0, 160));

// ---------------------------------------------------------------- unknown key, bad input, the owner's stop
const fateNone = await call('W9 fate of an unknown key', 'GET', '/fate?key=ws04:verify:never');
check('W9', 'an unknown key → explicit "unqueryable, not retained" (④\'s seven states), never "landed" or "not-sent"', fateNone.json?.state === 'unqueryable' && fateNone.json?.retained === false && !fateNone.json?.signature, `${fateNone.status} ${JSON.stringify(fateNone.json).slice(0, 200)}`);
const bad = await call('W10 action without a name', 'POST', '/action', { request: { source: 'mcp', idempotencyKey: 'ws04:verify:bad', policyVersion: 1, action: {} } });
check('W10', 'malformed action → refused, nothing sent', bad.json?.status !== 'sent' && (await chain()) === c8, JSON.stringify(bad.json?.error ?? bad.json).slice(0, 160));
const noKey = await call('W11 action without an idempotency key', 'POST', '/action', { request: { ...req('', 3), idempotencyKey: undefined } });
check('W11', 'no idempotency key → refused, nothing sent', noKey.json?.status !== 'sent' && (await chain()) === c8, JSON.stringify(noKey.json?.error ?? noKey.json).slice(0, 160));
const stale = await call('W12 stale policyVersion', 'POST', '/action', { request: { ...req('ws04:verify:k4', 3), policyVersion: 99 } });
check('W12', 'a stale policy version → refused, nothing sent', stale.json?.status !== 'sent' && (await chain()) === c8, JSON.stringify(stale.json?.error ?? stale.json).slice(0, 160));
await call('W13a owner: manual mode', 'POST', '/mode', { mode: 'manual' });
const stopped = await call('W13 SendCaravan while stopped', 'POST', '/action', { request: req('ws04:verify:k5', 3) });
check('W13', 'the owner\'s manual mode stops the agent: refused, nothing sent', stopped.json?.status !== 'sent' && (await chain()) === c8, JSON.stringify(stopped.json?.error ?? stopped.json).slice(0, 160));
await call('W13b owner: auto mode', 'POST', '/mode', { mode: 'auto' });
const resumed = await call('W13c k5 again after auto', 'POST', '/action', { request: req('ws04:verify:k5', 3) });
check('W13c', 'INFO: the same key after the owner resumes', true, `status ${resumed.json?.status} (${resumed.json?.error?.code ?? ''})`);
const junk = await call('W14 body not JSON', 'POST', '/action', undefined, { raw: '{nope' });
check('W14', 'INFO: test bridge answers unparseable JSON with 500 and the stack trace (test-only, loopback)', true, `status ${junk.status}, stack in body: ${/at .*\.mjs/.test(junk.text)}`);
const hist = await call('W15 the agent\'s public view', 'GET', '/history');
check('W15', 'the agent\'s history records each key once', hist.status === 200, `${(hist.json?.history ?? []).length} history rows`);

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(5)} ${r.what}${r.detail ? `  [${String(r.detail).slice(0, 220)}]` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
