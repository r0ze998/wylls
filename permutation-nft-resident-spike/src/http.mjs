// A minimal HTTP face for the contract (docs/CONTRACT.ja.md §2), so ④ can see
// the request and answer shapes over the wire. Loopback only; node:http only.
//
//   GET  /r/status?wallet=            entitlement: published, residents held, canLogin, onWaitlist
//   GET  /r/waitlist                  the projection (eligible / unconfirmed rows)
//   POST /r/challenge {address, assetId}   → {nonce, text, expiresAt}
//   POST /r/login {address, assetId, nonce, text, signature(base64)} → {token, residentId, epoch} | 409 NotPublished (+entitlement)
//   POST /r/op {token, op, idempotencyKey, signature?}   a holder-signed op: the body carries the presigned mock tx
//   POST /r/notify {event}            an indexer/webhook event: only a prompt to read the chain
//   POST /r/publish                   the test publish switch (operator only in the real relay)
import { createServer } from 'node:http';
import { Refusal } from './errors.mjs';

const STATUS = { NotPublished: 409, NotHolder: 403, OwnerChanged: 409, BadSignature: 401, BadCredential: 401, Expired: 401, NonceUsed: 409, NonceUnknown: 400, BadMessage: 400, WrongDomain: 400, StaleRead: 503, ChainUnavailable: 503, Unconfirmed: 503, BadRequest: 400 };

export function createResidentHandler({ registry, auth, gateway }) {
  const routes = {
    'GET /r/status': async (q) => registry.entitlement(q.get('wallet')),
    'GET /r/waitlist': async () => ({ published: registry.published, rows: registry.waitlist() }),
    'POST /r/challenge': async (_q, b) => auth.challenge(b),
    'POST /r/login': async (_q, b) => auth.login(b),
    'POST /r/op': async (_q, b) => gateway.submit({ credential: b.token, op: b.op, idempotencyKey: b.idempotencyKey, presigned: b.presigned ?? null, approvalId: b.approvalId ?? null }),
    'POST /r/approve': async (_q, b) => gateway.approve({ credential: b.token, approvalId: b.approvalId }),
    'POST /r/notify': async (_q, b) => registry.ingest(b.event),
    'POST /r/publish': async () => registry.publish(),
  };
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = routes[`${req.method} ${url.pathname}`];
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!route) return send(404, { ok: false, code: 'NotFound' });
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { ok: false, code: 'InvalidJson' }); }
    }
    try {
      send(200, await route(url.searchParams, body));
    } catch (e) {
      if (e instanceof Refusal) return send(STATUS[e.code] ?? 400, e.toJSON());
      send(500, { ok: false, code: 'Internal', message: e.message });
    }
  };
}

export function serve({ registry, auth, gateway, port = 0, host = '127.0.0.1' }) {
  const server = createServer(createResidentHandler({ registry, auth, gateway }));
  return new Promise(resolve => server.listen(port, host, () => resolve({ server, port: server.address().port, url: `http://${host}:${server.address().port}` })));
}
