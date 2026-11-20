// (2026-11-20, ③ public exposure) The audit log: one JSON line per HTTP request, for abuse investigation and quota
// disputes. Off unless a file is configured (WYLLS_MCP_AUDIT / WYLLS_MCP_PUBLIC_AUDIT).
//
// What a line holds: time, which server, method + path (no query), status, duration, who (a kind and an id that is
// not a secret: a public key's id, or a salted hash of an owner link's id), the client address as a salted hash (or
// nothing), the JSON-RPC method, the tool name, the outcome (ok, or the tool's error code) and the answer's size.
// What a line NEVER holds: the Authorization header, a token, a code, a signature, a request body, tool arguments, an
// owner's wallet address, a raw IP address, a query string. (A wallet is public on chain, but tying a connection's
// network address to a wallet is exactly what the log must not make easy.)
//
// The salt is random per process unless one is configured: by default hashes cannot be linked across restarts.
// Retention is the operator's (r0ze's: reports/ws03-mcp-public.md Q6); the file is rotated once to `<file>.1` past
// `maxBytes`, so at most two files exist.
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';

const OUTCOME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const RPC = /^[a-z][a-zA-Z/_]{0,47}$/;

export function createAudit({ file = null, write = null, salt = null, ip = 'hash', maxBytes = 10 * 1024 * 1024, now = Date.now, server = 'owner' } = {}) {
  if (!file && !write) return null;
  if (!['hash', 'off'].includes(ip)) throw new Error('audit ip: hash or off');
  const key = salt ? Buffer.from(String(salt)) : randomBytes(32);
  const hash = v => createHmac('sha256', key).update(String(v)).digest('hex').slice(0, 16);
  let size = 0;
  if (file) { try { size = statSync(file).size; } catch { size = 0; } }
  const out = write ?? (line => {
    if (size + line.length > maxBytes && size > 0) { try { renameSync(file, `${file}.1`); } catch { /* the next append starts a new file anyway */ } size = 0; }
    appendFileSync(file, line, { mode: 0o600 });
    size += line.length;
  });
  return {
    hash,
    /**
     * @param {object} e  {route, status, ms, who?: {kind, id?, linkId?}, addr?, rpc?, tool?, outcome?, bytes?}
     */
    record(e) {
      const who = e.who ? { kind: String(e.who.kind), ...(e.who.id ? { id: String(e.who.id).slice(0, 32) } : {}), ...(e.who.linkId ? { id: `l:${hash(`link:${e.who.linkId}`)}` } : {}) } : { kind: 'none' };
      const line = {
        t: new Date(now()).toISOString(),
        srv: server,
        route: String(e.route ?? '').slice(0, 80),
        status: Number(e.status) || 0,
        ms: Math.max(0, Math.round(Number(e.ms) || 0)),
        who,
        ...(ip === 'hash' && e.addr ? { addr: hash(`addr:${e.addr}`) } : {}),
        ...(e.rpc && RPC.test(e.rpc) ? { rpc: e.rpc } : {}),
        ...(e.tool && TOOL.test(e.tool) ? { tool: e.tool } : e.tool ? { tool: '(unknown)' } : {}),
        ...(e.outcome && OUTCOME.test(e.outcome) ? { outcome: e.outcome } : {}),
        ...(Number.isInteger(e.bytes) ? { bytes: e.bytes } : {}),
      };
      try { out(`${JSON.stringify(line)}\n`); } catch { /* an audit failure never fails a request */ }
    },
  };
}

/**
 * Wraps a request handler so that every request is recorded when it finishes. The route code fills `req.wyllsAudit`
 * ({who, rpc, tool, outcome}) as it learns them; the wrapper adds route, status, duration, size and address.
 */
export function audited(handler, audit, { addressOf = req => req.socket?.remoteAddress ?? null, now = Date.now } = {}) {
  if (!audit) return handler;
  return async function (req, res) {
    const t0 = now();
    req.wyllsAudit = {};
    let bytes = 0;
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => { if (chunk) bytes += Buffer.byteLength(chunk); return end(chunk, ...rest); };
    res.once('finish', () => {
      let path = '';
      try { path = new URL(req.url, 'http://x').pathname; } catch { path = '(unparseable)'; }
      audit.record({ route: `${req.method} ${path}`, status: res.statusCode, ms: now() - t0, addr: addressOf(req), bytes, ...req.wyllsAudit });
    });
    return handler(req, res);
  };
}

/**
 * The client's address. Without a trusted proxy: the socket's peer. With one (`trustProxy`): the right-most
 * X-Forwarded-For entry — the one the operator's own proxy appended; entries to its left are the client's to write
 * and are never trusted. A missing header falls back to the peer.
 */
export function clientAddress(req, trustProxy = false) {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  if (!trustProxy) return peer;
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff !== 'string' || !xff.trim()) return peer;
  const last = xff.split(',').map(s => s.trim()).filter(Boolean).pop();
  return last && last.length <= 64 ? last : peer;
}
