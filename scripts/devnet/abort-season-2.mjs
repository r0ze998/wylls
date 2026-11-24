#!/usr/bin/env node
// One-off, PREPARED NOT SENT: AbortSeason (0x06) for the announced, never-created devnet Season 2 (on-chain
// name; players never see "season"), sent by its authority before the genesis round time so the 1 SOL creation
// bond returns to the authority (permutation-frontier/src/proc/season.rs abort_season, path a).
//
// Why it exists (devnet-new-world-plan, 2026-11-24): the owner postponed the 11-25 02:20 creation (12:07 U2).
// The new world's preset (territory branch: S1_DEVNET_TERRITORY = the continuous world without ReleaseDormant,
// U3) has another params hash, so CreateSeason can never use Season 2's announcement. Whether to abort it is
// r0ze's call (inbox 2026-11-24-1840 Q-NWP-1). If not aborted before the bond deadline, a later abort burns it.
//
// Same gate and transaction as abort-season-1.mjs (the Season 1 abort that landed 11-24 06:34, verify-pr204);
// only the season checks and the time window differ:
//   node scripts/devnet/abort-season-2.mjs                       # dry run: read + simulate (no key; sigVerify off)
//   node scripts/devnet/abort-season-2.mjs --key FILE            # dry run, also checks the key is the authority
//   node scripts/devnet/abort-season-2.mjs --key FILE --yes-send --i-have-r0ze-approval --approved-sha256 HEX
// It refuses (exit 2) unless Season 2 is exactly the announcement it was written for (PDA ["season", le64(2)]
// with bump 252, magic, owner, status Announced, authority, t_create_min, params hash, bond) and Season 1 is
// still the Aborted account; and it refuses from 01:30 JST 11-25 on (owner rule: no devnet change 01:30–03:30;
// the bond deadline 02:31:06 falls inside it, so after 01:30 there is no refund window this script may use).
// Exit: 0 done / dry run ok, 1 failed, 2 refused.
import { createHash, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  AUTHORITY, BPF_LOADER_UPGRADEABLE, INCINERATOR, PROGRAM, RPC, S1_T_CREATE_MIN, S2_T_CREATE_MIN, SEASON_1, SEASON_2,
  TAG_ABORT_SEASON, APPROVAL_FLAG, EXIT_OK, EXIT_FAILED, EXIT_REFUSED,
  b58d, b58e, decodeSeason, gateFlags, genesisProblem, loadAuthorityKey, parseArgs, pda, programSha256, seasonSeed, Refused,
} from './abort-season-1.mjs';

export { RPC, SEASON_1, SEASON_2, S2_T_CREATE_MIN };
/** Season 2's announced params hash (preset S1_DEVNET_WIDE_CONTINUOUS; reports/devnet-continuous-1.md). */
export const S2_PARAMS_HASH = 'f63f0b363352269127a918bfed4be2f2365d14f29c6fa1dca612bc0162d27a64';
export const S2_BUMP = 252;
export const S1_BUMP = 255;
export const BOND = 1_000_000_000n;
/** 2026-11-25 01:30:00 JST: start of the owner's no-change window (Q-4, U1). */
export const NO_CHANGE_FROM = 1795537800n;
/** The refund deadline: genesis_seed_round(t_create_min, 60) round time on quicknet (02:31:06 JST). */
export const BOND_DEADLINE = 1795541466n;
export const STATUS_ANNOUNCED = 0, STATUS_ABORTED = 6;

/**
 * Every reason the abort is refused, given both seasons as read ({ owner, ...decodeSeason }) and the wall clock.
 * Season 2 must be the announced-not-created world this script was written for; Season 1 must still be the
 * Aborted account (a cross-check that the right cluster/program is being read). Pure.
 */
export function seasonProblems(s1, s2, nowSecs) {
  const out = [];
  if (!s2) out.push('season 2 account missing');
  else {
    if (s2.owner !== PROGRAM) out.push(`season 2 owner ${s2.owner} is not the program`);
    if (s2.magic !== 'PSF1SEAS') out.push(`season 2 magic ${s2.magic}`);
    if (s2.bump !== S2_BUMP || pda(seasonSeed(2), s2.bump, PROGRAM) !== SEASON_2) out.push('season 2 address is not PDA ["season", le64(2)] with bump 252');
    if (s2.status !== STATUS_ANNOUNCED) out.push(`season 2 status ${s2.status} is not Announced (0): only an announced, never-created season is aborted here`);
    if (s2.authority !== AUTHORITY) out.push(`season 2 authority ${s2.authority} is not ${AUTHORITY}`);
    if (s2.tCreateMin !== S2_T_CREATE_MIN) out.push(`season 2 t_create_min ${s2.tCreateMin} is not ${S2_T_CREATE_MIN}`);
    if (s2.paramsHash !== S2_PARAMS_HASH) out.push(`season 2 params hash ${s2.paramsHash} is not the announced ${S2_PARAMS_HASH}`);
    if (s2.bond !== BOND) out.push(`season 2 bond ${s2.bond} is not ${BOND} (nothing to return)`);
  }
  if (!s1) out.push('season 1 account missing');
  else {
    if (s1.owner !== PROGRAM) out.push(`season 1 owner ${s1.owner} is not the program`);
    if (s1.bump !== S1_BUMP || pda(seasonSeed(1), s1.bump, PROGRAM) !== SEASON_1) out.push('season 1 address is not PDA ["season", le64(1)]');
    if (s1.status !== STATUS_ABORTED) out.push(`season 1 status ${s1.status} is not Aborted (6)`);
    if (s1.tCreateMin !== S1_T_CREATE_MIN) out.push(`season 1 t_create_min ${s1.tCreateMin} is not ${S1_T_CREATE_MIN}`);
  }
  if (BigInt(nowSecs) >= NO_CHANGE_FROM) {
    out.push('it is 01:30 JST 11-25 or later: owner no-change window (01:30–03:30), and the bond deadline 02:31:06 is inside it — refused');
  }
  return out;
}

/** The legacy message (one signer: the authority as fee payer, `any` and `authority`), Season 2. Pure. */
export function buildMessage(blockhash) {
  const keys = [b58d(AUTHORITY), b58d(SEASON_2), b58d(INCINERATOR), b58d(PROGRAM)];
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

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(`REFUSE: ${parsed.error}`); return EXIT_REFUSED; }
  const o = parsed.opts;
  const closed = gateFlags(o);
  if (o.yesSend && closed.length) throw new Refused(`SEND GATE: CLOSED\n  - ${closed.join('\n  - ')}\n(nothing was read or sent)`);
  if (BigInt(Math.floor(Date.now() / 1000)) >= NO_CHANGE_FROM) throw new Refused('it is 01:30 JST 11-25 or later (owner no-change window; bond deadline inside it): nothing read or sent');
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
  log(`season 2 Announced, bond ${pre.s2.bond} lamports, params ${pre.s2.paramsHash}; season 1 Aborted`);

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
  log(`season2 lamports diff ${post.s2.lamports - pre.s2.lamports}; incinerator diff ${post.inc - pre.inc}`);
  log(`season1 data unchanged: ${post.s1.sha256 === pre.s1.sha256}`);
  return EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(c => process.exit(c), e => {
    if (e instanceof Refused) { console.log(`REFUSE: ${e.message}`); process.exit(EXIT_REFUSED); }
    console.error(`FAILED: ${e.message}`); process.exit(EXIT_FAILED);
  });
}
