#!/usr/bin/env node
// One-off: AbortSeason (0x06) for the never-created devnet Season 1, sent by
// its authority before the genesis round time so the creation bond returns
// to the authority (permutation-frontier/src/proc/season.rs abort_season,
// path a). No dependencies: legacy transaction built by hand, ed25519 via
// node:crypto. DEVNET ONLY: the RPC URL is fixed (no override) and the
// cluster's genesis hash must be devnet's. Never prints key bytes.
//
// DONE: sent 2026-11-24 06:34 JST (devnet-s1-cancel-1, owner t486u), tx
// 54y4Whm3…WujV, bond RETURNED. Season 1 is now Aborted (status 6), so every
// run of this script now refuses ("season 1 status 6 is not Announced").
//
// Gate (as `frontier-operator end-season`, #180):
//   node scripts/devnet/abort-season-1.mjs                       # dry run: read + simulate (no key; sigVerify off)
//   node scripts/devnet/abort-season-1.mjs --key FILE            # dry run, also checks the key is the authority
//   node scripts/devnet/abort-season-1.mjs --key FILE --yes-send --i-have-r0ze-approval --approved-sha256 HEX
//     HEX = sha256 of the deployed program's ELF (read from its ProgramData), as end-season's --approved-sha256.
// It refuses (exit 2) unless Season 1 is exactly the announced-not-created season it was written for (PDA
// ["season", le64(1)], magic, owner, status Announced, stored authority, t_create_min) and Season 2 is the
// continuous world's account (PDA ["season", le64(2)], t_create_min); it never takes a season id or address.
// Exit: 0 done / dry run ok, 1 failed, 2 refused.
//
// Accounts (frontier-abi prologue Ix::AbortSeason, fclient ix::abort_season):
//   [any s] [season w] [authority w] [incinerator w], data = [0x06].
import { readFileSync, lstatSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RPC = 'https://api.devnet.solana.com';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const PROGRAM = 'GGFRJr9dwzq5g4Dj4w1gN9DdSwhVz1McfUGtekiECMrr';
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const SEASON_1 = 'HgP9VNZJnWGECaT1ubc8FSJdkUrWNsSG7MuKp8u5jSXk';
export const SEASON_2 = '47GBAC71CZXDMBsrGLntFDWJbLPRPwtcD2wXGfsXDxnP';
export const AUTHORITY = '7sVNs9v5E3Euv5A2aeZEwmzABwc6zhDHskzqo8jz9CbA';
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
export const S1_T_CREATE_MIN = 1795516707n; // 2026-11-24 19:38:27 JST
export const S2_T_CREATE_MIN = 1795540804n; // on chain 2026-11-25 02:20:04 JST (older docs/brief say ...802)
export const TAG_ABORT_SEASON = 0x06;
export const APPROVAL_FLAG = '--i-have-r0ze-approval';
/** ProgramData header before the ELF (loader v3: enum tag 4, slot 8, Option<Pubkey> 33), as operator.rs. */
export const PROGRAMDATA_HEADER = 45;
export const EXIT_OK = 0, EXIT_FAILED = 1, EXIT_REFUSED = 2;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58d(s) {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
export function b58e(buf) {
  let n = BigInt('0x' + (Buffer.from(buf).toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}

/** Flags → options, or { error } (nothing is read or sent on an error). Pure. */
export function parseArgs(argv) {
  const o = { key: null, yesSend: false, approval: false, approvedSha256: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--key') { o.key = argv[++i]; if (!o.key || o.key.startsWith('--')) return { error: 'need --key FILE' }; }
    else if (a === '--yes-send') o.yesSend = true;
    else if (a === APPROVAL_FLAG) o.approval = true;
    else if (a === '--approved-sha256') {
      const h = (argv[++i] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) return { error: '--approved-sha256 HEX (64 hex digits)' };
      o.approvedSha256 = h;
    } else if (a === '--send') return { error: '--send was replaced by --yes-send (with --i-have-r0ze-approval and --approved-sha256)' };
    else return { error: `unknown argument ${a} (this script takes no RPC URL, season id or address)` };
  }
  if ((o.approval || o.approvedSha256) && !o.yesSend) {
    return { error: `${APPROVAL_FLAG} / --approved-sha256 belong to a send: add --yes-send (or drop them for a dry run)` };
  }
  if (o.yesSend && !o.key) return { error: '--yes-send needs --key FILE' };
  return { opts: o };
}

/** Why a send is refused by its flags alone (empty = the flags allow a send). Pure. */
export function gateFlags(o) {
  const out = [];
  if (!o.yesSend) out.push('--yes-send is not given (dry run)');
  if (!o.approval) out.push(`${APPROVAL_FLAG} is not given (devnet: r0ze's go-ahead)`);
  if (!o.approvedSha256) out.push('--approved-sha256 <sha256 of the deployed program> is not given');
  return out;
}

/** The genesis rule: devnet only; mainnet-beta is named. Pure. */
export function genesisProblem(g) {
  if (g === MAINNET_GENESIS) return `genesis ${g} is mainnet-beta: refused (devnet only)`;
  if (g !== DEVNET_GENESIS) return `genesis ${g} is not devnet's: refused`;
  return null;
}

/** A Solana CLI key file the user owns, regular (no symlink), mode 600 or stricter. Returns a problem or null. */
export function keyFileProblem(path, st = null) {
  try { st ??= lstatSync(path); } catch { return `key file ${path}: cannot stat`; }
  if (st.isSymbolicLink()) return `key file ${path}: a symlink (refused)`;
  if (!st.isFile()) return `key file ${path}: not a regular file`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `key file ${path}: not owned by this user`;
  if ((st.mode & 0o077) !== 0) return `key file ${path}: mode ${(st.mode & 0o777).toString(8)} is readable by others (needs 600 or stricter)`;
  return null;
}

/** Season's Address for id via its stored bump (the PDA hash). Pure. */
export function pda(seeds, bump, program) {
  const h = createHash('sha256');
  for (const s of seeds) h.update(s);
  h.update(Buffer.from([bump])); h.update(b58d(program)); h.update(Buffer.from('ProgramDerivedAddress'));
  return b58e(h.digest());
}
export function seasonSeed(id) { const le = Buffer.alloc(8); le.writeBigUInt64LE(BigInt(id)); return [Buffer.from('season'), le]; }

/** Season account bytes → the fields this script checks. Pure. */
export function decodeSeason(buf) {
  if (!buf || buf.length < 392) return null;
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

/**
 * Every reason the abort is refused, given both seasons as read ({ owner, ...decodeSeason }) and the wall clock.
 * Season 1 must be the announced-not-created season this script was written for; Season 2 must be the
 * continuous world's account. Pure.
 */
export function seasonProblems(s1, s2, nowSecs) {
  const out = [];
  if (!s1) out.push('season 1 account missing');
  else {
    if (s1.owner !== PROGRAM) out.push(`season 1 owner ${s1.owner} is not the program`);
    if (s1.magic !== 'PSF1SEAS') out.push(`season 1 magic ${s1.magic}`);
    if (pda(seasonSeed(1), s1.bump, PROGRAM) !== SEASON_1) out.push('season 1 address is not PDA ["season", le64(1)]');
    if (s1.status !== 0) out.push(`season 1 status ${s1.status} is not Announced (0): only an announced, never-created season is aborted here`);
    if (s1.authority !== AUTHORITY) out.push(`season 1 authority ${s1.authority} is not ${AUTHORITY}`);
    if (s1.tCreateMin !== S1_T_CREATE_MIN) out.push(`season 1 t_create_min ${s1.tCreateMin} is not ${S1_T_CREATE_MIN}`);
  }
  if (!s2) out.push('season 2 account missing');
  else {
    if (s2.owner !== PROGRAM) out.push(`season 2 owner ${s2.owner} is not the program`);
    if (pda(seasonSeed(2), s2.bump, PROGRAM) !== SEASON_2) out.push('season 2 address is not PDA ["season", le64(2)]');
    if (s2.tCreateMin !== S2_T_CREATE_MIN) out.push(`season 2 t_create_min ${s2.tCreateMin} is not ${S2_T_CREATE_MIN}`);
  }
  // Bond returns only before the genesis round time (≈ t_create_min + 660 s for an Announced season); keep a margin.
  if (BigInt(nowSecs) > S1_T_CREATE_MIN + 300n) out.push('too close to the bond deadline; would risk burning the bond');
  return out;
}

/** The program ELF's sha256 from ProgramData bytes (the `.so`'s sha256sum, as operator.rs program_info). Pure. */
export function programSha256(programdata) {
  const d = programdata.subarray(PROGRAMDATA_HEADER);
  if (d.length < 64 || d.readUInt32BE(0) !== 0x7f454c46 || d[4] !== 2 || d[5] !== 1) return null;
  const shoff = Number(d.readBigUInt64LE(0x28));
  const len = shoff + d.readUInt16LE(0x3A) * d.readUInt16LE(0x3C);
  if (len < 64 || len > d.length) return null;
  return createHash('sha256').update(d.subarray(0, len)).digest('hex');
}

/** The legacy message (one signer: the authority as fee payer, `any` and `authority`). Pure. */
export function buildMessage(blockhash) {
  const keys = [b58d(AUTHORITY), b58d(SEASON_1), b58d(INCINERATOR), b58d(PROGRAM)];
  for (const k of keys) if (k.length !== 32) throw new Error('bad key length');
  const bh = b58d(blockhash);
  if (bh.length !== 32) throw new Error('bad blockhash');
  return Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 signer, 0 ro signed, 1 ro unsigned (program)
    Buffer.from([keys.length]), ...keys,
    bh,
    Buffer.from([1]), // one instruction
    Buffer.from([3, 4, 0, 1, 0, 2, 1, TAG_ABORT_SEASON]), // program idx 3; accounts [any=0, season=1, authority=0, incinerator=2]; data [0x06]
  ]);
}

// ---------------------------------------------------------------- the run (only when executed)

const log = (...a) => console.log(...a);

/** The authority's key from a Solana CLI key file (checked; bytes zeroed). Also used by abort-season-2.mjs. */
export function loadAuthorityKey(path) {
  const p = keyFileProblem(path);
  if (p) throw new Refused(p);
  let raw;
  try {
    const arr = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every(b => Number.isInteger(b) && b >= 0 && b < 256)) throw 0;
    raw = Buffer.from(arr);
  } catch { throw new Refused(`key file ${path}: not a Solana CLI key file (a JSON array of 64 bytes)`); }
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const pub = pubDer.subarray(pubDer.length - 32);
  const ok = pub.equals(raw.subarray(32));
  raw.fill(0);
  if (!ok) throw new Refused('key file public half does not match its seed');
  if (b58e(pub) !== AUTHORITY) throw new Refused(`key is ${b58e(pub)}, not the season authority ${AUTHORITY}`);
  return priv;
}
export class Refused extends Error {}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(`REFUSE: ${parsed.error}`); return EXIT_REFUSED; }
  const o = parsed.opts;
  const closed = gateFlags(o);
  if (o.yesSend && closed.length) throw new Refused(`SEND GATE: CLOSED\n  - ${closed.join('\n  - ')}\n(nothing was read or sent)`);
  log(o.yesSend ? 'SEND (--yes-send)' : 'DRY RUN: nothing is sent without --yes-send');
  const priv = o.key ? loadAuthorityKey(o.key) : null;
  if (priv) log(`signer ${AUTHORITY} (key file matches; bytes not printed)`);

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
  async function raw(addr) {
    const a = await rpc('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
    return a.value ? { owner: a.value.owner, lamports: BigInt(a.value.lamports), data: Buffer.from(a.value.data[0], 'base64') } : null;
  }
  async function account(addr) {
    const a = await raw(addr);
    if (!a) return null;
    return { lamports: a.lamports, owner: a.owner, size: a.data.length, sha256: createHash('sha256').update(a.data).digest('hex'), ...decodeSeason(a.data) };
  }
  const show = (name, x) => log(`${name}: ${x ? JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v) : 'MISSING'}`);
  const balance = async addr => BigInt((await rpc('getBalance', [addr, { commitment: 'confirmed' }])).value);
  async function snapshot(label) {
    log(`--- ${label} ${new Date().toISOString()} ---`);
    const s1 = await account(SEASON_1), s2 = await account(SEASON_2);
    const auth = await balance(AUTHORITY), inc = await balance(INCINERATOR);
    show('season1', s1); show('season2', s2);
    log(`authority lamports ${auth} (${Number(auth) / 1e9} SOL)`);
    log(`incinerator lamports ${inc}`);
    return { s1, s2, auth, inc };
  }

  const g = await rpc('getGenesisHash');
  const gp = genesisProblem(g);
  if (gp) throw new Refused(gp);
  log(`cluster devnet (genesis ${g})`);

  const pre = await snapshot('pre');
  const problems = seasonProblems(pre.s1, pre.s2, Math.floor(Date.now() / 1000));
  if (problems.length) throw new Refused(problems.join('; '));
  log(`season 1 Announced, bond ${pre.s1.bond} lamports; season 2 status ${pre.s2.status}, t_create_min ${pre.s2.tCreateMin}`);

  if (o.yesSend) {
    const prog = await raw(PROGRAM);
    if (!prog || prog.owner !== BPF_LOADER_UPGRADEABLE || prog.data.length < 36) throw new Refused('program account is not an upgradeable program');
    const pd = await raw(b58e(prog.data.subarray(4, 36)));
    const have = pd ? programSha256(pd.data) : null;
    if (have !== o.approvedSha256) throw new Refused(`--approved-sha256 ${o.approvedSha256} is not the deployed program's sha256 ${have}`);
    log(`program sha256 ${have} (approved)`);
  }

  const bh = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const msg = buildMessage(bh.blockhash);
  const sig = priv ? sign(null, msg, priv) : Buffer.alloc(64);
  const tx = Buffer.concat([Buffer.from([1]), sig, msg]);
  log(`tx ${tx.length} bytes, blockhash ${bh.blockhash}${priv ? `, signature ${b58e(sig)}` : ' (unsigned: simulated with sigVerify off)'}`);

  const sim = await rpc('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', commitment: 'confirmed', sigVerify: !!priv }]);
  log(`simulate: err=${JSON.stringify(sim.value.err)} units=${sim.value.unitsConsumed}`);
  for (const l of sim.value.logs ?? []) log(`  sim| ${l}`);
  if (sim.value.err) throw new Refused('simulation failed');
  if (!o.yesSend) { log(`DRY RUN: nothing sent. A send needs --key, --yes-send, ${APPROVAL_FLAG} and --approved-sha256.`); return EXIT_OK; }

  const sent = await rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
  log(`sent ${sent}`);
  let st = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    st = (await rpc('getSignatureStatuses', [[sent], { searchTransactionHistory: true }])).value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break;
  }
  log(`status ${JSON.stringify(st)}`);
  if (!st || st.err) { log('NOT CONFIRMED or failed'); return EXIT_FAILED; }
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
  return EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(c => process.exit(c), e => {
    if (e instanceof Refused) { console.log(`REFUSE: ${e.message}`); process.exit(EXIT_REFUSED); }
    console.error(`FAILED: ${e.message}`); process.exit(EXIT_FAILED);
  });
}
