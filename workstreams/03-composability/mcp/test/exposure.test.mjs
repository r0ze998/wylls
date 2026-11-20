// (2026-11-18) Exposure of the MCP server (bin/mcp-settings.mjs, src/http.mjs, bin/wylls-mcp.mjs):
//   X1 the listen host is loopback unless WYLLS_MCP_ALLOW_REMOTE_BIND=1 (the only authorization server is the local
//      test one; a tunnel connects to loopback and needs no opt-in); the opt-in takes exactly 1
//   X2 allowedHosts: loopback names, the issuer's host name, WYLLS_MCP_ALLOWED_HOSTS; a malformed extra is refused,
//      and the error never quotes the value
//   X3 the handler with allowedHosts: a foreign, missing or unparseable Host is 403 before anything is read (DNS
//      rebinding); loopback names and the issuer's host pass, any port; without allowedHosts nothing changes
//   X4 bin: the checked allowedHosts reach createHandler; a remote bind is logged as a warning
// Real loopback sockets for X3 (node:http); no key, relay or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mcpSettings } from '../bin/mcp-settings.mjs';
import { createHandler, listen } from '../src/http.mjs';

test('X1 loopback only unless opted in', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(mcpSettings({ WYLLS_MCP_HOST: host }).remoteBind, false, host);
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) {
    const e = mcpSettings({ WYLLS_MCP_HOST: host });
    assert.match(e.error, /^WYLLS_MCP_HOST: a loopback host/, host);
    assert.ok(!e.error.includes(host === '::' ? '::)' : host) || host === '::', 'the value is not quoted');
    const ok = mcpSettings({ WYLLS_MCP_HOST: host, WYLLS_MCP_ALLOW_REMOTE_BIND: '1' });
    assert.equal(ok.error, undefined, host);
    assert.equal(ok.remoteBind, true);
  }
  for (const v of ['true', 'yes', '0', ' 1']) assert.match(mcpSettings({ WYLLS_MCP_HOST: '0.0.0.0', WYLLS_MCP_ALLOW_REMOTE_BIND: v }).error, /^WYLLS_MCP_ALLOW_REMOTE_BIND: 1/);
  // a tunnel: https issuer, loopback bind, no opt-in
  const t = mcpSettings({ WYLLS_MCP_ISSUER: 'https://wylls-test.example.org' });
  assert.equal(t.error, undefined);
  assert.equal(t.remoteBind, false);
});

test('X2 allowedHosts', () => {
  assert.deepEqual(mcpSettings({}).allowedHosts, ['127.0.0.1', 'localhost', '[::1]']);
  assert.deepEqual(mcpSettings({ WYLLS_MCP_ISSUER: 'https://Wylls-Test.example.org' }).allowedHosts, ['127.0.0.1', 'localhost', '[::1]', 'wylls-test.example.org']);
  assert.deepEqual(mcpSettings({ WYLLS_MCP_ALLOWED_HOSTS: ' proxy.internal , [fd00::1] ' }).allowedHosts, ['127.0.0.1', 'localhost', '[::1]', 'proxy.internal', '[fd00::1]']);
  for (const bad of ['http://x.example', 'x.example:8080', 'x.example/path', 'a b']) {
    const e = mcpSettings({ WYLLS_MCP_ALLOWED_HOSTS: bad });
    assert.match(e.error, /^WYLLS_MCP_ALLOWED_HOSTS:/, bad);
    assert.ok(!e.error.includes(bad), 'the value is not quoted');
  }
});

/** A raw request with exactly this Host header (or none), over a real socket. */
function raw(port, host, path = '/.well-known/oauth-protected-resource') {
  return new Promise((resolve, reject) => {
    const headers = host === null ? {} : { host };
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('X3 the Host check over a real socket', async () => {
  const issuer = 'http://127.0.0.1:41999';
  let reached = 0;
  const auth = { issuer, now: () => Date.now(), protectedResource: () => { reached++; return { resource: `${issuer}/mcp` }; } };
  const on = await listen(createHandler({ auth, mcp: {}, allowedHosts: mcpSettings({ WYLLS_MCP_ISSUER: 'https://wylls-test.example.org' }).allowedHosts }));
  const off = await listen(createHandler({ auth, mcp: {} }));
  try {
    const p = on.address().port;
    for (const h of [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, 'LOCALHOST', 'wylls-test.example.org', 'wylls-test.example.org:443']) {
      assert.equal((await raw(p, h)).status, 200, h);
    }
    const before = reached;
    for (const h of ['evil.example', `evil.example:${p}`, '127.0.0.1.evil.example', 'wylls-test.example.org.evil.example', '[::1']) {
      const r = await raw(p, h);
      assert.equal(r.status, 403, String(h));
      assert.equal(JSON.parse(r.body).error_description, 'host not allowed');
    }
    // No Host at all: node:http itself answers 400 (requireHostHeader) before the handler; the handler's own check
    // (hostOk: a missing Host is false) is the second line for a server built without that default.
    assert.equal((await raw(p, null)).status, 400);
    assert.equal(reached, before, 'a refused Host reaches no route');
    // without allowedHosts: as before (not checked)
    assert.equal((await raw(off.address().port, 'evil.example')).status, 200);
  } finally {
    await new Promise(r => on.close(r));
    await new Promise(r => off.close(r));
  }
});

test('X4 bin: the checked allowedHosts reach the handler; a remote bind is a warning', () => {
  const bin = readFileSync(new URL('../bin/wylls-mcp.mjs', import.meta.url), 'utf8');
  assert.match(bin, /const \{ port, host, issuer, resource, remoteBind, allowedHosts \} = settings;/);
  // (2026-11-20) plus the opt-in audit log, proxy address and daily quota per link (all off when unset)
  assert.match(bin, /await listen\(createHandler\(\{ auth, mcp, log, allowedHosts, audit, trustProxy, linkQuota \}\), \{ port, host \}\);/);
  assert.match(bin, /if \(remoteBind\) log\(`warning: listening on/);
});
