// AC8 test doubles: servers on 127.0.0.1:0 that answer from RECORDED data (test/fixtures/ai-audit-slice4/{herald,rpc}.json) and a fake llama-server.
//
//   startRecordedHerald(herald.json content)  GET /h/events?after=<seq>[&limit=<n>] pages of the recorded rows (paging is synthetic: page size 500, `full` when the
//                                             page is full), every other GET from the recorded `gets` map, else 404
//   startRecordedRpc(rpc.json content)        POST JSON-RPC: the recorded result of `<method>|<canonical params>`, else error -32000
//   startFakeLlama(outputOf)                  POST /v1/chat/completions: choices[0].message.content = outputOf(bodyText, parsedBody)
//
// Every server counts the requests it saw (`requests`).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../citizens/mind/guards.mjs';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SLICE4 = path.join(FIXTURE_DIR, 'ai-audit-slice4');
export const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

const listen = async server => { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; };
const closer = server => () => new Promise(r => { server.closeAllConnections?.(); server.close(r); });

export async function startRecordedHerald(data, { pageSize = 500 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    requests.push(u.pathname + u.search);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (u.pathname === '/h/events') {
      const after = BigInt(u.searchParams.get('after') ?? '0');
      const limit = Math.min(pageSize, Number(u.searchParams.get('limit') ?? pageSize));
      const events = data.events.filter(r => BigInt(r.seq) > after).slice(0, limit);
      return send(200, { v: 1, events, next: events.length ? events[events.length - 1].seq : String(after), full: events.length === limit });
    }
    const hit = data.gets[u.pathname + u.search] ?? data.gets[u.pathname];
    if (hit) return send(hit.status, hit.json ?? {});
    return send(404, { code: 'NotYet', ok: false });
  });
  const url = await listen(server);
  return { url, requests, close: closer(server), data };
}

export async function startRecordedRpc(rec, { extra = {} } = {}) {
  const requests = [];
  const calls = { ...rec.calls, ...extra };
  // a transaction the recording never asked for is unknown to the chain (null), and a status query answers from the recorded transactions
  const known = new Map(Object.entries(calls).filter(([k]) => k.startsWith('getTransaction|')).map(([k, v]) => [JSON.parse(k.slice('getTransaction|'.length))[0], v]));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      requests.push(j.method);
      const key = `${j.method}|${canonicalJson(j.params ?? [])}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (Object.hasOwn(calls, key)) res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: calls[key] }));
      else if (j.method === 'getTransaction') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: known.get(j.params[0]) ?? null }));
      else if (j.method === 'getSignatureStatuses') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { value: j.params[0].map(sg => (known.has(sg) ? { slot: known.get(sg).slot, err: null, confirmationStatus: 'finalized' } : null)) } }));
      else res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: `not recorded: ${key.slice(0, 120)}` } }));
    });
  });
  const url = await listen(server);
  return { url, requests, close: closer(server), calls };
}

export async function startFakeLlama(outputOf) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/v1/chat/completions') res.end(JSON.stringify({ choices: [{ message: { content: outputOf(body, JSON.parse(body)) }, finish_reason: 'stop' }] }));
      else res.end('{}');
    });
  });
  const url = await listen(server);
  return { url, requests, close: closer(server) };
}

/** A temporary AI_DIR holding a copy of the fixture's pub/ and state/ (and the run's stack.toml / ai-slots.json). */
export function copyFixture(fixtureDir = SLICE4) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-'));
  const cp = (from, to) => {
    if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n)); } else fs.copyFileSync(from, to);
  };
  for (const n of ['pub', 'state']) cp(path.join(fixtureDir, n), path.join(dir, n));
  for (const n of ['stack.toml', 'ai-slots.json']) if (fs.existsSync(path.join(fixtureDir, n))) fs.copyFileSync(path.join(fixtureDir, n), path.join(dir, n));
  return { dir, pub: path.join(dir, 'pub'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
