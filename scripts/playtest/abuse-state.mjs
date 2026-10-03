// A burst of well-formed junk against the relay's quota book (PT-E), through the herald, loopback only:
//
//   node scripts/playtest/abuse-state.mjs --herald http://127.0.0.1:41117 --relay-state <run>/relay/relay-state.json [--n 300]
//
// Each request is a Harvest the relay accepts as a SHAPE (right prefix, accounts, signer) but naming a citizen that does not
// exist, signed by a fresh key, from a TEST-NET address given to the herald the way a tunnel gives it (CF-Connecting-IP).
// The relay refuses all of them at the simulation. Before PT-E every such request left a `citizen:<made up>` entry
// in relay-state.json (about 86 bytes each, saved to disk 2 to 3 times per request); an anonymous requester's address bucket
// went into the state file in the clear. Exits 0 when, afterwards, the quota book holds no entry for them, the file holds no
// address and none of the TEST-NET addresses used, and every answer was a refusal (no 5xx).
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { FrontierAddresses } from '../../permutation-gateway/client/src/frontier/addresses.mjs';
import { shapeMessage } from '../../permutation-gateway/client/src/frontier/shapes.mjs';
import { wireTransaction } from '../../permutation-gateway/client/src/solana-tx.mjs';
import { signTalk } from '../../permutation-gateway/client/src/talk-node.mjs';
import { toBase64 } from '../../permutation-gateway/client/src/bytes.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const H = new URL(arg('herald', 'http://127.0.0.1:41117'));
const STATE = arg('relay-state', '');
const N = Number(arg('n', 300));
if (!/^(127\.0\.0\.1|localhost)$/.test(H.hostname) || !(Number(H.port) >= 41100 && Number(H.port) <= 41139)) { console.error('loopback playtest ports only'); process.exit(2); }
if (!STATE) { console.error('--relay-state is required'); process.exit(2); }
const call = (method, path, body, ip) => new Promise(res => {
  const data = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: H.hostname, port: H.port, method, path, agent: false, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), 'CF-Connecting-IP': ip } },
    x => { let s = ''; x.on('data', d => { s += d; }); x.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* not json */ } res({ status: x.statusCode, json: j }); }); });
  r.on('error', e => res({ status: 0, json: { error: e.message } })); if (data) r.write(data); r.end();
});
const season = (await call('GET', '/gw/f/season', undefined, '203.0.113.201')).json;
const A = new FrontierAddresses({ programId: season.programId, seasonId: BigInt(season.seasonId) });
// the file does not exist until the relay first has something to save
const sizeOf = () => { try { return statSync(STATE).size; } catch { return 0; } };
const textOf = () => { try { return readFileSync(STATE, 'utf8'); } catch { return '{}'; } };
const sizeBefore = sizeOf();
const entriesBefore = Object.keys(JSON.parse(textOf()).quota ?? {}).length;
const codes = {}; const ips = new Set();
for (let i = 0; i < N; i++) {
  const ip = `198.51.100.${(i % 200) + 1}`; ips.add(ip); // up to 200 addresses, so no per-address limit is what stops it
  const quota = await call('GET', '/gw/f/relay', undefined, ip);
  const k = Keypair.generate();
  const fake = Keypair.generate().publicKey.toBase58(); // a citizen that does not exist
  const accounts = { actor: k.publicKey.toBase58(), season: A.season, citizen: fake, holding: A.holding(-3, 7, 11), province: A.province(-3, 7), frontier: A.frontier };
  const message = shapeMessage({ programId: season.programId, name: 'Harvest', accounts, fields: {}, feePayer: quota.json.feePayer, recentBlockhash: quota.json.blockhash });
  const tx = toBase64(wireTransaction(message, { [k.publicKey.toBase58()]: signTalk(message, k) }));
  const r = await call('POST', '/gw/f/relay', { tx }, ip);
  const key = r.json?.code ?? String(r.status);
  codes[key] = (codes[key] ?? 0) + 1;
}
await new Promise(r => setTimeout(r, 2500)); // the relay writes its state at most once a second
const text = textOf();
const state = JSON.parse(text);
const entries = Object.keys(state.quota ?? {});
const sizeAfter = sizeOf();
console.log(JSON.stringify({ requests: N, answers: codes, addresses: ips.size, quotaEntriesBefore: entriesBefore, quotaEntriesAfter: entries.length, stateBytes: [sizeBefore, sizeAfter] }));
let bad = 0;
const fail = s => { console.log(`FAIL  ${s}`); bad++; };
if (entries.length > entriesBefore) fail(`the quota book grew by ${entries.length - entriesBefore} entries`);
if (/\b(198\.51\.100|203\.0\.113|192\.0\.2)\./.test(text)) fail('a TEST-NET address is in the state file');
if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text.replace(/"(version|v)":\s*[\d.]+/g, ''))) fail('a dotted quad is in the state file');
if (Object.values(codes).length && Object.keys(codes).some(c => /^(5\d\d|0)$/.test(c))) fail('a 5xx or no answer');
if (sizeAfter > sizeBefore + 2_000) fail(`the state file grew by ${sizeAfter - sizeBefore} bytes`);
console.log(bad ? 'abuse-state: FAILED' : 'abuse-state: ok (nothing left behind, no address in the state)');
process.exit(bad ? 1 : 0);
