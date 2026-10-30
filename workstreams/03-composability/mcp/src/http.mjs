// The HTTP face: MCP over Streamable HTTP at /mcp (POST, one JSON-RPC
// message, a JSON answer; GET has no server stream here and answers 405),
// the OAuth endpoints (auth.mjs) and the owner's consent page.
//
// Never logged: the Authorization header, request bodies, tokens, codes,
// signatures. A request with a foreign Origin is refused (DNS rebinding).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { toBase64 } from '../../../../permutation-gateway/client/src/bytes.mjs';
import { commandBytes } from '../../../../permutation-gateway/src/frontier/agent/owner-auth.mjs';
import { linkStatement, ownerQueryStatement, OAuthError, SCOPE_TEXT, SCOPES, TTL } from './auth.mjs';
import { PROTOCOL_VERSIONS } from './server.mjs';

const MAX_BODY = 64 * 1024;

async function body(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new OAuthError(413, 'invalid_request', 'body too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new OAuthError(400, 'invalid_request', 'body is not JSON'); }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const hostOf = u => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return String(u ?? ''); } };
const isLoopback = u => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

/** The owner's page for their operations without a connection (after a revocation): the wallet signs a query; nothing else. */
function ownerPage(nonce) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wylls operations</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 16px;color:#1b1b1b;background:#fafaf7}input{font:inherit;width:100%;box-sizing:border-box}pre{white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #ccc;padding:.6rem;border-radius:6px}button{font:inherit;padding:.5rem 1rem;margin-top:.5rem}</style></head><body>
<h1>Wylls の操作の確認</h1>
<p>接続を取り消した後も、あなたの隊商の操作の状態を、ウォレットの署名で確かめられます。署名は読取だけに使い、10 分以内に 1 回だけ有効です（ローカルのテスト環境）。</p>
<form id="f"><label>ウォレットのアドレス <input name="owner" required autocomplete="off"></label><button type="submit">ウォレットで署名して確認</button></form>
<pre id="out"></pre>
<script nonce="${nonce}">
const b64=u=>btoa(String.fromCharCode(...u)), unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const wallet=()=>window.solana??window.phantom?.solana??null;
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.error_description??j.error);return j;}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const out=document.getElementById('out');
try{const owner=new FormData(e.target).get('owner');const st=await post('/owner/statement',{owner});const w=wallet();if(!w)throw new Error('ブラウザのウォレットが見つかりません');await w.connect?.();
const r=await w.signMessage(unb64(st.statementB64),'utf8');const j=await post('/owner/operations',{owner,at:st.at,signature:b64(r.signature??r)});out.textContent=JSON.stringify(j,null,2);}catch(err){out.textContent=err.message;}};
</script></body></html>`;
}

/** The owner's consent page: what is asked, then the wallet signs (a browser wallet's signMessage; no key is typed). */
function consentPage(p, nonce) {
  const write = p.scopes.includes(SCOPES.CARAVAN);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wylls connection</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 16px;color:#1b1b1b;background:#fafaf7}
fieldset{border:1px solid #ccc;border-radius:8px;margin:1rem 0}label{display:block;margin:.4rem 0}input{font:inherit;width:100%;box-sizing:border-box}
.warn{background:#fff4d6;border:1px solid #e0c060;padding:.6rem;border-radius:6px}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}code{word-break:break-all}</style></head><body>
<h1>Wylls に接続</h1>
<p><b>${esc(p.clientName)}</b> があなたの村への接続を求めています（ローカルのテスト環境・テスト資産のみ）。</p>
<p>許可した後の戻り先: <code>${esc(hostOf(p.redirectUri))}</code></p>
${isLoopback(p.redirectUri) ? '<p class="warn">戻り先はこの機械の上のアドレス（loopback）です。この機械で動くプログラムなら、どれでもその番号を使えます。自分で起動したクライアント（Claude Code など）からの接続でなければ、拒否してください。</p>' : ''}
<ul>${p.scopes.map(s => `<li><code>${esc(s)}</code>: ${esc(SCOPE_TEXT[s])}</li>`).join('')}</ul>
<p class="warn">署名は、あなたのウォレットが「この接続を許す」ことを証明します。チャットで表示される確認は、この署名の代わりになりません。</p>
<form id="f"><fieldset><legend>あなたと代理人</legend>
<label>ウォレットのアドレス <input name="owner" required autocomplete="off"></label>
<label>代理人の ID（代理人ページに表示） <input name="agentId" required autocomplete="off"></label></fieldset>
${write ? `<fieldset><legend>隊商を送る上限（このサーバーが守る）</legend>
<label>送れる回数 <input name="maxSends" type="number" min="1" max="100" value="3"></label>
<label>1回あたりの各資源の上限 <input name="maxEach" type="number" min="0" max="1000000" value="500"></label>
<label>有効期限（時間） <input name="hours" type="number" min="1" max="720" value="24"></label>
<p class="warn">隊商を許すと、代理人の capability（relay に行動を頼むための権限。代理人の session 鍵ではありません）が作り直され、このサーバーだけが封印して持ちます。以前の capability を使う接続は止まります。</p></fieldset>` : ''}
<button type="submit">ウォレットで署名して接続</button><button type="button" id="deny">拒否</button></form>
<p id="msg"></p>
<script nonce="${nonce}">
const reqId=${JSON.stringify(p.reqId)}, scopes=${JSON.stringify(p.scopes)};
const b64=u=>btoa(String.fromCharCode(...u)), unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const wallet=()=>window.solana??window.phantom?.solana??null;
async function sign(bytes){const w=wallet();if(!w)throw new Error('ブラウザのウォレットが見つかりません');await w.connect?.();const r=await w.signMessage(bytes,'utf8');return b64(r.signature??r);}
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok&&!j.redirect)throw new Error(j.error_description??j.error);return j;}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const m=document.getElementById('msg');
try{const hours=Number(f.get('hours')??24),each=Number(f.get('maxEach')??0);
const req={reqId,owner:f.get('owner'),agentId:f.get('agentId'),scopes,expiresAt:Date.now()+hours*3600e3,
grant:scopes.includes('wylls.caravan')?{actions:['SendCaravan'],maxSends:Number(f.get('maxSends')),maxCargo:Array(8).fill(each),expiresAt:Date.now()+hours*3600e3}:undefined};
const st=await post('/oauth/statement',req);
const signature=await sign(unb64(st.statementB64));
const rotate=st.rotate?{command:st.rotate.command,signature:await sign(unb64(st.rotate.bytesB64))}:undefined;
const done=await post('/oauth/consent',{...st.request,signature,rotate});location.href=done.redirect;}catch(err){m.textContent=err.message;}};
document.getElementById('deny').onclick=async()=>{const j=await post('/oauth/consent',{reqId,deny:true});location.href=j.redirect;};
</script></body></html>`;
}

/**
 * @param {object} o
 * @param {Auth} o.auth
 * @param {object} o.mcp            createWyllsMcp(...)
 * @param {string[]} [o.origins]    Origins allowed on /mcp and the consent posts (besides the issuer's own)
 */
export function createHandler({ auth, mcp, origins = [], log = () => {}, rateLimit = { burst: 20, everySecs: 2 } }) {
  const allowed = new Set([new URL(auth.issuer).origin, 'https://chatgpt.com', ...origins]);
  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(obj === null ? '' : JSON.stringify(obj));
  };
  const oauthFail = (res, e) => {
    if (e.redirect) return send(res, 200, { redirect: e.redirect, error: e.error });
    send(res, e.status ?? 400, e.body?.() ?? { error: 'server_error' }, e.status === 401 ? { 'www-authenticate': auth.wwwAuthenticate(`error="${e.error}"`) } : {});
  };
  const originOk = req => !req.headers.origin || allowed.has(req.headers.origin);
  // Unauthenticated routes that make the server keep something: `rateLimit.burst`, then 1 every `everySecs`, per address.
  const buckets = new Map();
  const limited = req => {
    const k = req.socket?.remoteAddress ?? 'unknown';
    const t = auth.now() / 1000;
    const b = buckets.get(k) ?? { tokens: rateLimit.burst, t };
    b.tokens = Math.min(rateLimit.burst, b.tokens + (t - b.t) / rateLimit.everySecs);
    b.t = t;
    buckets.set(k, b);
    if (buckets.size > 10_000) buckets.clear();
    if (b.tokens < 1) return true;
    b.tokens -= 1;
    return false;
  };
  const KEEPING = new Set(['POST /oauth/register', 'GET /oauth/authorize', 'POST /oauth/statement', 'POST /oauth/consent', 'POST /owner/statement', 'POST /owner/operations']);

  return async function handler(req, res) {
    const url = new URL(req.url, auth.issuer);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (!originOk(req)) return send(res, 403, { error: 'forbidden', error_description: 'origin not allowed' });
      if (KEEPING.has(route) && limited(req)) return send(res, 429, { error: 'slow_down', error_description: 'too many requests from this address' }, { 'retry-after': '2' });
      switch (route) {
        case 'GET /.well-known/oauth-protected-resource':
        case 'GET /.well-known/oauth-protected-resource/mcp':
          return send(res, 200, auth.protectedResource(), { 'cache-control': 'public, max-age=300' });
        case 'GET /.well-known/oauth-authorization-server':
          return send(res, 200, auth.serverMetadata(), { 'cache-control': 'public, max-age=300' });
        case 'POST /oauth/register':
          return send(res, 201, auth.register(await body(req)));
        case 'GET /oauth/authorize': {
          let pending;
          try { pending = auth.begin(Object.fromEntries(url.searchParams)); } catch (e) {
            if (e.redirect) { res.writeHead(302, { location: e.redirect }); return res.end(); }
            throw e;
          }
          const nonce = randomBytes(16).toString('base64');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
            'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
          return res.end(consentPage(pending, nonce));
        }
        case 'POST /oauth/statement': {
          // What the wallet signs, built here so the page and the server agree byte for byte.
          const b = await body(req);
          const pending = auth.db.nonces[b.reqId];
          if (!pending || pending.expiresAt <= auth.now()) throw new OAuthError(400, 'invalid_request', 'this consent request has expired');
          const scopes = (Array.isArray(b.scopes) ? b.scopes : pending.scopes).filter(s => pending.scopes.includes(s));
          if (!scopes.includes(SCOPES.READ)) scopes.unshift(SCOPES.READ);
          const expiresAt = Math.min(Number(b.expiresAt), auth.now() + TTL.link);
          const grant = scopes.includes(SCOPES.CARAVAN) && b.grant ? { ...b.grant, expiresAt: Math.min(Number(b.grant.expiresAt), expiresAt), contract: 'wylls.mock-grant/0' } : null;
          const request = { reqId: b.reqId, owner: String(b.owner ?? ''), agentId: String(b.agentId ?? ''), scopes, expiresAt, grant: grant ?? undefined };
          // The statement holds the grant as the server will store it (normaliseGrant's shape).
          const stGrant = grant ? { contract: grant.contract, actions: [...new Set(grant.actions)], maxSends: grant.maxSends, maxCargo: grant.maxCargo, expiresAt: grant.expiresAt } : null;
          const st = auth.statementOf(pending, { owner: request.owner, agentId: request.agentId, scopes, grant: stGrant, expiresAt });
          const out = { request, statementB64: toBase64(linkStatement(st)) };
          if (grant) {
            const command = { op: 'rotate-capability', owner: request.owner, agentId: request.agentId, nonce: randomBytes(12).toString('base64url'), expiresAt: auth.now() + 5 * 60_000, params: {} };
            out.rotate = { command, bytesB64: toBase64(commandBytes(command)) };
          }
          return send(res, 200, out);
        }
        case 'POST /oauth/consent': {
          const r = await auth.consent(await body(req));
          return send(res, 200, { redirect: r.redirect });
        }
        case 'POST /oauth/token':
          return send(res, 200, auth.token(await body(req)), { pragma: 'no-cache' });
        case 'POST /oauth/revoke':
          auth.revokeToken((await body(req)).token);
          return send(res, 200, {});
        case 'POST /link/revoke':
          return send(res, 200, auth.ownerRevoke(await body(req)));
        case 'GET /owner': {
          const nonce = randomBytes(16).toString('base64');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
            'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'` });
          return res.end(ownerPage(nonce));
        }
        case 'POST /owner/statement': {
          // The bytes the owner's wallet signs to read their operations (built here so page and server agree).
          const owner = String((await body(req))?.owner ?? '');
          if (!owner) throw new OAuthError(400, 'invalid_request', 'owner is required');
          const at = auth.now();
          return send(res, 200, { at, statementB64: toBase64(ownerQueryStatement({ type: 'wylls-mcp-owner-operations/1', aud: auth.resource, owner, at })) });
        }
        case 'POST /owner/operations': {
          const owner = auth.ownerQuery(await body(req));
          return send(res, 200, await mcp.ownerOperations(owner));
        }
        case 'GET /mcp': case 'DELETE /mcp':
          res.writeHead(405, { allow: 'POST' });
          return res.end();
        case 'POST /mcp': {
          let principal;
          try { principal = auth.principal(req.headers.authorization); } catch (e) {
            return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: e.message } }, { 'www-authenticate': auth.wwwAuthenticate(`error="${e.error ?? 'invalid_token'}", error_description="${String(e.message).replace(/"/g, '')}"`) });
          }
          const v = req.headers['mcp-protocol-version'];
          if (v && !PROTOCOL_VERSIONS.includes(v)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: `unsupported MCP-Protocol-Version ${String(v).slice(0, 20)}` } });
          const msg = await body(req);
          if (!msg || typeof msg !== 'object') return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'a JSON-RPC message is required' } });
          if (Array.isArray(msg)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batches are not supported' } });
          const out = await mcp.handle(msg, principal);
          if (out === null) { res.writeHead(202); return res.end(); }
          const headers = msg.method === 'initialize' ? { 'mcp-session-id': randomBytes(16).toString('hex') } : {};
          return send(res, 200, out, headers);
        }
        default:
          return send(res, 404, { error: 'not_found' });
      }
    } catch (e) {
      if (e instanceof OAuthError) return oauthFail(res, e);
      log(`mcp-http: ${route} failed: ${String(e?.message ?? e).slice(0, 200)}`);
      return send(res, 500, { error: 'server_error' });
    }
  };
}

export function listen(handler, { port = 0, host = '127.0.0.1' } = {}) {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    s.listen(port, host, () => resolve(s));
  });
}
