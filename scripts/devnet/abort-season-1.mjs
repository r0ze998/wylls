#!/usr/bin/env node
// One-off: AbortSeason (0x06) for the never-created devnet Season 1, sent by
// its authority before the genesis round time so the creation bond returns
// to the authority (permutation-frontier/src/proc/season.rs abort_season,
// path a). No dependencies: legacy transaction built by hand, ed25519 via
// node:crypto. DEVNET ONLY (the RPC URL is fixed and the genesis hash is
// checked). Never prints key bytes.
//
//   node scripts/devnet/abort-season-1.mjs --key ~/wylls-devnet-keys/authority.json          # read + simulate
//   node scripts/devnet/abort-season-1.mjs --key ~/wylls-devnet-keys/authority.json --send   # send
//
// Accounts (frontier-abi prologue Ix::AbortSeason, fclient ix::abort_season):
//   [any s] [season w] [authority w] [incinerator w], data = [0x06].
import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

const RPC = 'https://api.devnet.solana.com';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM = 'GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr';
const SEASON_ID = 1n;
const SEASON_1 = 'HgP9VNZJnWGECaT1ubc8FSJdkUrWNsSG7MuKp8u5jSXk';
const SEASON_2 = '47GBAC71CZXDMBsrGLntFDWJbLPRPwtcD2wXGfsXDxnP';
const AUTHORITY = '7sVNs9v5E3Euv5A2aeZEwmzABwc6zhDHskzqo8jz9CbA';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const S1_T_CREATE_MIN = 1795516707n; // 2026-11-24 19:38:27 JST
const S2_T_CREATE_MIN = 1795540804n; // on chain 2026-11-25 02:20:04 JST (docs/brief say ...802)
const TAG_ABORT_SEASON = 0x06;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58d(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
function b58e(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const keyPath = args[args.indexOf('--key') + 1];
if (!args.includes('--key') || !keyPath) { console.error('need --key FILE'); process.exit(2); }

let lastCall = 0;
async function rpc(method, params = []) {
  const wait = lastCall + 1200 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await new Promise(res => setTimeout(res, 11000)); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${method}: rate limited 5 times`);
}
const log = (...a) => console.log(...a);

// --- key (never printed) ---
const raw = Buffer.from(JSON.parse(readFileSync(keyPath, 'utf8')));
if (raw.length !== 64) throw new Error('key file is not a 64-byte keypair');
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' });
const pub = pubDer.subarray(pubDer.length - 32);
if (!pub.equals(raw.subarray(32))) throw new Error('key file public half does not match its seed');
if (b58e(pub) !== AUTHORITY) throw new Error(`key is ${b58e(pub)}, not the season authority ${AUTHORITY}`);
log(`signer ${AUTHORITY} (key file matches; bytes not printed)`);

// --- PDA check: Season = ["season", le64(1)] + stored bump ---
function pda(seeds, bump, program) {
  const h = createHash('sha256');
  for (const s of seeds) h.update(s);
  h.update(Buffer.from([bump])); h.update(b58d(program)); h.update(Buffer.from('ProgramDerivedAddress'));
  return b58e(h.digest());
}

function decode(buf) {
  return {
    magic: buf.subarray(0, 8).toString('latin1'),
    status: buf[64], bump: buf[65],
    authority: b58e(buf.subarray(72, 104)),
    genesisTs: buf.readBigInt64LE(144),
    genesisRound: buf.readBigUInt64LE(232),
    paramsHash: buf.subarray(336, 368).toString('hex'),
    tCreateMin: buf.readBigInt64LE(368),
    announcedTs: buf.readBigInt64LE(376),
    bond: buf.readBigUInt64LE(384),
  };
}
async function account(addr) {
  const a = await rpc('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!a.value) return null;
  const data = Buffer.from(a.value.data[0], 'base64');
  return { lamports: BigInt(a.value.lamports), owner: a.value.owner, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), ...decode(data) };
}
const show = (name, x) => log(`${name}: ${x ? JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v) : 'MISSING'}`);
async function balance(addr) { return BigInt((await rpc('getBalance', [addr, { commitment: 'confirmed' }])).value); }

async function snapshot(label) {
  log(`--- ${label} ${new Date().toISOString()} ---`);
  const s1 = await account(SEASON_1);
  const s2 = await account(SEASON_2);
  const auth = await balance(AUTHORITY);
  const inc = await balance(INCINERATOR);
  show('season1', s1); show('season2', s2);
  log(`authority lamports ${auth} (${Number(auth) / 1e9} SOL)`);
  log(`incinerator lamports ${inc}`);
  return { s1, s2, auth, inc };
}

const g = await rpc('getGenesisHash');
if (g !== DEVNET_GENESIS) throw new Error(`genesis ${g} is not devnet; refusing`);
log(`cluster devnet (genesis ${g})`);

const pre = await snapshot('pre');
const { s1, s2 } = pre;
const fail = m => { log(`REFUSE: ${m}`); process.exit(2); };
if (!s1) fail('season 1 account missing');
if (s1.owner !== PROGRAM) fail(`season 1 owner ${s1.owner}`);
if (s1.magic !== 'PSF1SEAS') fail(`season 1 magic ${s1.magic}`);
const le = Buffer.alloc(8); le.writeBigUInt64LE(SEASON_ID);
if (pda([Buffer.from('season'), le], s1.bump, PROGRAM) !== SEASON_1) fail('season 1 address is not PDA ["season", le64(1)]');
if (s1.status !== 0) fail(`season 1 status ${s1.status} is not Announced (0)`);
if (s1.authority !== AUTHORITY) fail(`season 1 authority ${s1.authority}`);
if (s1.tCreateMin !== S1_T_CREATE_MIN) fail(`season 1 t_create_min ${s1.tCreateMin}`);
const le2 = Buffer.alloc(8); le2.writeBigUInt64LE(2n);
if (!s2 || pda([Buffer.from('season'), le2], s2.bump, PROGRAM) !== SEASON_2 || s2.tCreateMin !== S2_T_CREATE_MIN) fail('season 2 check failed');
// genesis round time for an Announced season ≈ t_create_min + 660 s (season.rs genesis_round_time); keep a 5-min margin
const now = BigInt(Math.floor(Date.now() / 1000));
if (now > S1_T_CREATE_MIN + 600n - 300n) fail('too close to the bond deadline; would risk burning the bond');
log(`season 1 Announced, bond ${s1.bond} lamports; season 2 status ${s2.status}, t_create_min ${s2.tCreateMin}`);

// --- legacy transaction ---
// keys: [authority (signer, w, fee payer = any + authority), season1 (w), incinerator (w), program (ro)]
const keys = [b58d(AUTHORITY), b58d(SEASON_1), b58d(INCINERATOR), b58d(PROGRAM)];
for (const k of keys) if (k.length !== 32) throw new Error('bad key length');
const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
const msg = Buffer.concat([
  Buffer.from([1, 0, 1]), // 1 signer, 0 ro signed, 1 ro unsigned (program)
  Buffer.from([keys.length]), ...keys,
  b58d(bh.blockhash),
  Buffer.from([1]), // one instruction
  Buffer.from([3, 4, 0, 1, 0, 2, 1, TAG_ABORT_SEASON]), // program idx 3; accounts [any=0, season=1, authority=0, incinerator=2]; data [0x06]
]);
const sig = sign(null, msg, priv);
const tx = Buffer.concat([Buffer.from([1]), sig, msg]);
const sigB58 = b58e(sig);
log(`tx ${tx.length} bytes, blockhash ${bh.blockhash}, signature ${sigB58}`);

const sim = await rpc('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: true }]);
log(`simulate: err=${JSON.stringify(sim.value.err)} units=${sim.value.unitsConsumed}`);
for (const l of sim.value.logs ?? []) log(`  sim| ${l}`);
if (sim.value.err) fail('simulation failed');
if (!SEND) { log('DRY RUN only (no --send)'); process.exit(0); }

const sent = await rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
log(`sent ${sent}`);
let st = null;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 2000));
  st = (await rpc('getSignatureStatuses', [[sent], { searchTransactionHistory: true }])).value[0];
  if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
}
log(`status ${JSON.stringify(st)}`);
if (!st || st.err) { log('NOT CONFIRMED or failed'); process.exit(1); }
const txr = await rpc('getTransaction', [sent, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
log(`getTransaction: slot ${txr?.slot} fee ${txr?.meta?.fee} err ${JSON.stringify(txr?.meta?.err)}`);
log(`  accounts ${JSON.stringify(txr?.transaction?.message?.accountKeys)}`);
log(`  pre ${JSON.stringify(txr?.meta?.preBalances)} post ${JSON.stringify(txr?.meta?.postBalances)}`);
for (const l of txr?.meta?.logMessages ?? []) log(`  tx| ${l}`);
const post = await snapshot('post');
const dAuth = post.auth - pre.auth;
log(`authority diff ${dAuth} lamports (${Number(dAuth) / 1e9} SOL; fee ${txr?.meta?.fee})`);
log(`season1 lamports diff ${post.s1.lamports - pre.s1.lamports}; incinerator diff ${post.inc - pre.inc}`);
log(`season2 data unchanged: ${post.s2.sha256 === pre.s2.sha256} lamports unchanged: ${post.s2.lamports === pre.s2.lamports}`);
