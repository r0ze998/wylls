// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with
// its own approval. Its import closure is bin/mcp-settings.mjs alone (pure: no I/O, no key API); it reads
// bin/wylls-mcp.mjs as text (never imported: importing it would start the server).
//
// The launcher's address settings (bin/mcp-settings.mjs): a client connects only to exactly <issuer>/mcp.
//   P1 unset or empty: the defaults, as before (port 41960, issuer http://127.0.0.1:41960, relay, herald)
//   P2 a port that is not 1..65535 (abc, 0, 65536, 1.5, -1, " 80") is refused, naming the setting only
//   P3 an issuer: an origin is taken as written less one trailing slash; a path, query, fragment, user, another
//      scheme or surrounding spaces are refused; the resource is <issuer>/mcp
//   P4 relay and herald: http(s) URLs (a path such as /gw is kept); anything else refused
//   P5 an error never quotes the value (a URL may carry credentials)
//   P6 connectLine: the resource, and the Claude Code preflight only for a loopback http issuer
//   P7 bin: the check stops the launcher before the store, the relay or the auth server is made; the resource
//      handed to Auth is the checked one; the connect line is logged after listening
// No key is generated, imported, derived or used; nothing is signed, sent, spawned, fetched or bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpSettings, connectLine, MCP_DEFAULTS } from '../bin/mcp-settings.mjs';

test('P1 defaults', () => {
  for (const env of [{}, { WYLLS_MCP_PORT: '', WYLLS_MCP_ISSUER: '', WYLLS_MCP_RELAY: '', WYLLS_MCP_HERALD: '' }]) {
    assert.deepEqual(mcpSettings(env), {
      port: 41960, host: '127.0.0.1', issuer: 'http://127.0.0.1:41960', resource: 'http://127.0.0.1:41960/mcp',
      relay: MCP_DEFAULTS.relay, herald: MCP_DEFAULTS.herald,
    });
  }
  const s = mcpSettings({ WYLLS_MCP_PORT: '41970' });
  assert.deepEqual([s.port, s.issuer, s.resource], [41970, 'http://127.0.0.1:41970', 'http://127.0.0.1:41970/mcp']);
});

test('P2 ports', () => {
  for (const p of ['abc', '0', '65536', '1.5', '-1', ' 80', '123456']) {
    const s = mcpSettings({ WYLLS_MCP_PORT: p });
    assert.ok(s.error?.startsWith('WYLLS_MCP_PORT:'), JSON.stringify(p));
  }
  assert.equal(mcpSettings({ WYLLS_MCP_PORT: '65535' }).port, 65535);
  assert.equal(mcpSettings({ WYLLS_MCP_PORT: '1' }).port, 1);
});

test('P3 issuers', () => {
  const ok = { 'http://127.0.0.1:41960': 'http://127.0.0.1:41960', 'http://127.0.0.1:41960/': 'http://127.0.0.1:41960', 'https://tunnel.example': 'https://tunnel.example', 'http://127.0.0.1:80': 'http://127.0.0.1:80' };
  for (const [given, issuer] of Object.entries(ok)) {
    const s = mcpSettings({ WYLLS_MCP_ISSUER: given });
    assert.deepEqual([s.error, s.issuer, s.resource], [undefined, issuer, `${issuer}/mcp`], given);
  }
  for (const bad of ['http://127.0.0.1:41960/mcp', 'http://x//', 'http://x/a/', 'http://x/?', 'http://x/?a=1', 'http://x/#f', 'http://u:p@x', 'ftp://x', 'x', ' http://x', 'http://x ']) {
    assert.ok(mcpSettings({ WYLLS_MCP_ISSUER: bad }).error?.startsWith('WYLLS_MCP_ISSUER:'), bad);
  }
});

test('P4 relay and herald', () => {
  const s = mcpSettings({ WYLLS_MCP_RELAY: 'http://127.0.0.1:41740/gw', WYLLS_MCP_HERALD: 'http://127.0.0.1:41740' });
  assert.deepEqual([s.relay, s.herald], ['http://127.0.0.1:41740/gw', 'http://127.0.0.1:41740']);
  for (const name of ['WYLLS_MCP_RELAY', 'WYLLS_MCP_HERALD']) {
    for (const bad of ['127.0.0.1:41740', 'http://u:p@x', 'http://x/?q', 'file:///tmp/x']) {
      assert.ok(mcpSettings({ [name]: bad }).error?.startsWith(`${name}:`), `${name} ${bad}`);
    }
  }
});

test('P5 an error does not quote the value', () => {
  const secret = 'http://user:hunter2@127.0.0.1:1/x?token=abc';
  for (const name of ['WYLLS_MCP_ISSUER', 'WYLLS_MCP_RELAY', 'WYLLS_MCP_HERALD', 'WYLLS_MCP_PORT']) {
    const e = mcpSettings({ [name]: secret }).error;
    assert.ok(e && !e.includes('hunter2') && !e.includes('token=abc'), name);
  }
});

test('P6 the connect line', () => {
  for (const r of ['http://127.0.0.1:41960/mcp', 'http://localhost:41960/mcp', 'http://[::1]:41960/mcp']) {
    const line = connectLine(r);
    assert.ok(line.includes(`claude mcp add --transport http <name> ${r}`) && line.includes(`wylls-mcp-preflight.mjs ${r} claude-code`), r);
  }
  assert.equal(connectLine('https://tunnel.example/mcp'), 'connect a client to https://tunnel.example/mcp');
  assert.equal(connectLine('http://192.168.1.5:41960/mcp'), 'connect a client to http://192.168.1.5:41960/mcp');
});

test('P7 bin: checked before anything is made; the checked resource is used', () => {
  const bin = readFileSync(new URL('../bin/wylls-mcp.mjs', import.meta.url), 'utf8');
  const at = s => { const i = bin.indexOf(s); assert.ok(i >= 0, s); return i; };
  const check = at('if (settings.error) { console.error(settings.error); process.exit(2); }');
  for (const later of ['const store = new JsonStore(', 'const game = new Game({ relay: settings.relay, herald: settings.herald });', 'const auth = new Auth({ issuer, resource, store,']) assert.ok(check < at(later), later);
  assert.doesNotMatch(bin, /Number\(env\.WYLLS_MCP_PORT/);
  assert.doesNotMatch(bin, /resource: `\$\{issuer\}\/mcp`/);
  assert.ok(at('await listen(createHandler(') < at('log(connectLine(resource));'));
});
