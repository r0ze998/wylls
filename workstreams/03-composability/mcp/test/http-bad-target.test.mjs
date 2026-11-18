// WRITTEN, NOT RUN (2026-11-17): no part of this file has been executed. Run it only with its own approval.
//
// src/http.mjs: a request target the URL parser refuses is answered 400 inside the handler, instead of rejecting the
// handler's promise outside its try (node:http does not await it, so the rejection was unhandled). KEY-FREE: reads
// src/http.mjs as TEXT only (importing it would load server.mjs and game.mjs); the premise is checked with the
// built-in URL only. No server, socket, request or key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const http = readFileSync(new URL('../src/http.mjs', import.meta.url), 'utf8');
const ISSUER = 'http://127.0.0.1:41960';

test('U1 the premise: targets a client can send that the URL parser refuses, even with a base', () => {
  for (const t of ['http://a:70000/', '//[', 'http://[::1/', 'http://exa mple/']) assert.throws(() => new URL(t, ISSUER), TypeError, t);
  for (const t of ['/mcp', '/oauth/authorize?x=1', '/.well-known/oauth-authorization-server', '/%zz']) assert.doesNotThrow(() => new URL(t, ISSUER), t);
});

test('U2 the handler parses the target inside its own try and answers 400 without echoing it', () => {
  const h = http.slice(http.indexOf('return async function handler(req, res) {'));
  assert.match(h, /let url;\n\s+try \{ url = new URL\(req\.url, auth\.issuer\); \} catch \{ return send\(res, 400, \{ error: 'invalid_request', error_description: 'the request target could not be parsed' \}\); \}/);
  const parse = h.indexOf('url = new URL(req.url, auth.issuer)');
  const route = h.indexOf('const route = `${req.method} ${url.pathname}`;');
  assert.ok(parse > 0 && parse < route, 'parsed before the route is built');
  assert.doesNotMatch(h.slice(0, route), /log\(/, 'nothing logged on the way');
  assert.doesNotMatch(h.slice(0, route), /req\.url\}|\$\{req\.url/, 'the raw target is not put in a response or a log');
});

test('U3 unchanged: the main try, Origin and rate-limit checks and the outer catch', () => {
  // (2026-11-18) the Host check (DNS rebinding, test/exposure.test.mjs) comes first inside the same try, then Origin
  assert.match(http, /const route = `\$\{req\.method\} \$\{url\.pathname\}`;\n\s+try \{\n\s+if \(!hostOk\(req\)\) return send\(res, 403[^\n]*\n\s+if \(!originOk\(req\)\) return send\(res, 403/);
  assert.match(http, /if \(e instanceof OAuthError\) return oauthFail\(res, e\);/);
  assert.equal((http.match(/new URL\(req\.url/g) ?? []).length, 1, 'one parse of the target');
});
