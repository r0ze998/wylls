// An HTTP transport for the provider adapters, LOOPBACK ONLY. It exists to
// drive the adapters over real HTTP against the local fixture server
// (fixture/http-fixture.mjs): request bytes, status codes, headers, JSON
// bodies, timeouts and dropped connections. It is not the live client.
//
//   - it refuses any host that is not 127.0.0.1 / ::1 / localhost (no outside network, ever)
//   - it never adds a credential and refuses a request that carries one
//   - it tells "not sent" (the connection was refused before any byte left) from "sent, no answer"
//     (timeout or connection lost after the request was written), because only the first costs nothing
//
// A live connection to a provider is an approval item: it would use the provider's official SDK,
// with a credential this code never reads.
import { request as httpRequest } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const CREDENTIAL = /^(authorization|x-api-key|api-key|openai-organization|openai-project|anthropic-api-key)$/i;

export function loopbackTransport({ baseUrl, timeoutMs = 5_000 }) {
  const base = new URL(baseUrl);
  if (!LOOPBACK.has(base.hostname)) throw Object.assign(new Error(`${base.hostname}: this transport talks to loopback fixtures only`), { code: 'NotLoopback' });
  if (base.protocol !== 'http:') throw Object.assign(new Error('loopback fixtures are plain http'), { code: 'NotLoopback' });
  return {
    kind: 'loopback-http (fixture only)',
    async send(wire) {
      for (const k of Object.keys(wire.headers ?? {})) if (CREDENTIAL.test(k)) throw new Error(`loopback transport: a credential header (${k}) is never sent`);
      const body = Buffer.from(JSON.stringify(wire.body), 'utf8');
      return await new Promise((resolve, reject) => {
        let written = false;
        const req = httpRequest({ host: base.hostname.replace(/^\[|\]$/g, ''), port: base.port, path: wire.path, method: 'POST', headers: { ...wire.headers, 'content-length': body.length } }, res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('aborted', () => reject(Object.assign(new Error('response aborted'), { sent: true })));
          res.on('error', e => reject(Object.assign(e, { sent: true })));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch { json = null; }
            if (json === null && res.statusCode === 200) return reject(Object.assign(new Error('a 200 without a JSON body (cut short?)'), { sent: true }));
            resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v])), body: json });
          });
        });
        req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
        req.on('error', e => reject(Object.assign(e, { sent: written && e.code !== 'ECONNREFUSED' })));
        req.end(body, () => { written = true; });
      });
    },
  };
}
