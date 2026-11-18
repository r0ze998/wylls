#!/usr/bin/env node
// A test stack over REAL loopback HTTP for the MCP server, the cooperation board and the residents (2026-11-18).
//
//   node e2e/http-stack.mjs --port 41510      prints one JSON line {"ready": …} once listening on 127.0.0.1
//
// What is real and what is not:
//   * /f/*  the real relay routes with the agent wallet (permutation-gateway: AgentGateway, owner-auth, classify, the
//           drain guard), as test/fixture.mjs world() builds them. The CHAIN behind them is the agent wallet tests'
//           scripted chain [SIMULATED CHAIN]: it signs-checks and "finalizes" at once; the program is not executed.
//   * /h/*  test/fixture.mjs's fake herald (real v2 account bytes from encodeAccount, a fixed village and vault), with
//           the real herald's /h/season and /h/me fields that the fixture leaves out (heraldShape below).
//   * /__test/*  TEST ORACLES, loopback only, for a driver standing in for the owner's browser wallet:
//           GET  /__test/world                  the owner's address, the agent id, the program and season
//           POST /__test/sign {bytesB64}        the owner's ed25519 signature of those bytes (a test key made in
//                                               memory at start; never written, never a real wallet)
//           POST /__test/sign-as-stranger {bytesB64}  another test key's signature (a forged consent)
//           GET  /__test/chain                  how many transactions the scripted chain received
//
// Nothing here reaches a network beyond 127.0.0.1, a real chain, a real key or a paid API. Bound to 127.0.0.1 only.
import http from 'node:http';
import { parseArgs } from 'node:util';
import { signTalk } from '../../../../permutation-gateway/client/src/talk-node.mjs';
import { world, keypair, RELAY, HERALD, fx } from '../test/fixture.mjs';
import { seasonAddresses } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { BELL_SECS } from '../../../../permutation-server/web/frontier/clock.mjs';

const { values: v } = parseArgs({ options: { port: { type: 'string' } }, strict: true });
const port = Number(v.port ?? 0);
const w = await world();
const stranger = keypair();
const MAX = 256 * 1024;

// The fixture's herald pages are a subset of the real herald's (frontier-node/crates/herald/src/views.rs season_json,
// me_json/acct). Workstream 13's live reader needs the rest: /h/season's programId, cluster, seasonAddress, genesisTs,
// bellSecs and continuous, and the `address` of the Citizen and of each holding on /h/me. They are added here with the
// values the real herald would give for this fixture world (bellSecs: web/frontier/clock.mjs BELL_SECS).
const W = seasonAddresses(fx.PROGRAM, fx.SEASON_ID);
function heraldShape(pathname, status, body) {
  if (status !== 200 || !body || typeof body !== 'object') return body;
  if (pathname === '/h/season') return { ...body, programId: fx.PROGRAM, cluster: 'localnet', seasonAddress: W.season, genesisTs: fx.GENESIS, bellSecs: BELL_SECS, continuous: true, slot: 1 };
  if (pathname === `/h/me/${w.o}` && body.citizen) return { ...body, citizen: { address: w.citizen, ...body.citizen }, holdings: (body.holdings ?? []).map(h => ({ address: fx.A.holding(...fx.VILLAGE), ...h })) };
  return body;
}
const json = (res, status, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); };
const sign = (kp, b64) => Buffer.from(signTalk(Buffer.from(String(b64 ?? ''), 'base64'), kp)).toString('base64');

const server = http.createServer(async (req, res) => {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX) return json(res, 413, { error: 'too large' }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  let u;
  try { u = new URL(req.url, 'http://127.0.0.1'); } catch { return json(res, 400, { error: 'bad target' }); }
  try {
    if (u.pathname === '/__test/world') return json(res, 200, { owner: w.o, agentId: w.agent.agentId, stranger: stranger.publicKey.toBase58(), programId: fx.PROGRAM, seasonId: String(fx.SEASON_ID), village: fx.VILLAGE });
    if (u.pathname === '/__test/sign' && req.method === 'POST') return json(res, 200, { signature: sign(w.owner, JSON.parse(raw).bytesB64) });
    if (u.pathname === '/__test/sign-as-stranger' && req.method === 'POST') return json(res, 200, { signature: sign(stranger, JSON.parse(raw).bytesB64) });
    if (u.pathname === '/__test/chain') return json(res, 200, { sent: w.r.chain.sent.length });
    const base = u.pathname.startsWith('/f/') ? RELAY : u.pathname.startsWith('/h/') ? HERALD : null;
    if (!base) return json(res, 404, { error: 'NotFound' });
    const r = await w.fetch(`${base}${u.pathname}${u.search}`, { method: req.method, ...(raw ? { body: raw } : {}) });
    return json(res, r.status ?? 200, heraldShape(u.pathname, r.status ?? 200, await r.json()));
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e).slice(0, 200) });
  }
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ ready: true, port: server.address().port, owner: w.o, agentId: w.agent.agentId, programId: fx.PROGRAM, seasonId: String(fx.SEASON_ID) })}\n`);
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => server.close(() => process.exit(0)));
