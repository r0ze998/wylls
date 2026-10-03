// A stand-in for the Cloudflare tunnel, for rehearsals on this machine only (PT-B): an HTTPS server
// with a throw-away self-signed certificate that forwards to the herald exactly as the tunnel does,
// adding the client's address as `X-Forwarded-For` (and `CF-Connecting-IP`) and replacing any such
// header the client sent. The browser reaches it as https://wylls.test:<port> (Chromium started with
// --host-resolver-rules and --ignore-certificate-errors), so the page is a non-loopback, secure page: no
// dev wallet, WebCrypto available, the herald sees a loopback peer with a forwarded address, as behind
// cloudflared. It starts no real tunnel and listens on 127.0.0.1 only.
//
//   node scripts/playtest/fake-tunnel.mjs --listen 41131 --herald 127.0.0.1:41110 --client-ip 203.0.113.77
//     [--cert-dir DIR]   (default: a fresh temp dir; the key never leaves it)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const LISTEN = Number(arg('listen', 41131));
const [HHOST, HPORT] = String(arg('herald', '127.0.0.1:41110')).split(':');
const CLIENT_IP = arg('client-ip', '203.0.113.77');
if (!(LISTEN >= 41100 && LISTEN <= 41139)) { console.error('--listen must be in 41100-41139'); process.exit(2); }
if (HHOST !== '127.0.0.1') { console.error('the herald must be on 127.0.0.1'); process.exit(2); }
const dir = arg('cert-dir', null) ?? mkdtempSync(path.join(os.tmpdir(), 'wylls-fake-tunnel-'));
const key = path.join(dir, 'key.pem');
const cert = path.join(dir, 'cert.pem');
try { readFileSync(cert); } catch {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=wylls.test', '-addext', 'subjectAltName=DNS:wylls.test'], { stdio: 'ignore' });
}
const clientIp = req => (arg('client-ip-from-header', '') && req.headers[arg('client-ip-from-header')]) || CLIENT_IP;
const fwdHeaders = (req, extra = {}) => {
  const h = { ...req.headers, ...extra };
  h['x-forwarded-for'] = `${req.headers['x-forwarded-for'] ?? ''}${req.headers['x-forwarded-for'] ? ', ' : ''}${clientIp(req)}`; // a tunnel appends the real address after the browser's own claim
  h['cf-connecting-ip'] = clientIp(req); // and sets this one itself, replacing the browser's
  h['x-forwarded-proto'] = 'https';
  return h;
};
const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const up = http.request({ host: HHOST, port: HPORT, method: req.method, path: req.url, headers: fwdHeaders(req) }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
  req.pipe(up);
});
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(HPORT), HHOST, () => {
    const h = fwdHeaders(req);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
server.listen(LISTEN, '127.0.0.1', () => console.log(`fake tunnel https://wylls.test:${LISTEN} -> ${HHOST}:${HPORT} (client ${CLIENT_IP}); certificate dir ${dir}`));
