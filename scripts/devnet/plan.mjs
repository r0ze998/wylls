// Devnet deploy planning for permutation-frontier: the cost model, the
// artefact checks, the send gate and the exact commands. DRAFT, 2026-11-18.
//
// This module has no side effects of its own: every file read, stat, process
// start and print goes through the `io` object `run()` is given
// (scripts/devnet/dry-run.mjs wires the real ones; the tests wire fakes). It
// never reads a key file: key files are passed to the Solana CLI by path,
// and only their mode, owner and location are checked here.
//
// Nothing is sent unless ALL of these hold (sendProblems):
//   --i-have-r0ze-approval, --keypair <fee payer file>, --program-keypair
//   <program id file>, --upgrade-authority <authority file>,
//   --approved-sha256 <the .so's sha256>; the profile's placeholders filled
//   with valid addresses; the RPC URL a devnet host of the profile; the .so
//   passing every check; each key file a regular file, mode 0600, outside
//   the repository; and the CLI's own reading of the key files matching the
//   profile's addresses; and a Solana CLI new enough to know the program's
//   syscalls (MIN_SOLANA_CLI). There is no airdrop, no mainnet and no --final path.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Account storage overhead counted by rent (solana-rent ACCOUNT_STORAGE_OVERHEAD). */
export const ACCOUNT_OVERHEAD = 128n;
/** LoaderV3 sizes: Program account, ProgramData header, Buffer header. */
export const PROGRAM_ACCOUNT_LEN = 36n;
export const PROGRAMDATA_META = 45n;
export const BUFFER_META = 37n;
export const APPROVAL_FLAG = '--i-have-r0ze-approval';
/** Host fragments refused whatever the profile says (a --profile file cannot widen this). */
export const HARD_REFUSED_RPC_HOST_PATTERNS = ['mainnet', 'testnet'];
/**
 * The oldest Solana CLI that can deploy this program. `solana program deploy` verifies the ELF locally with the
 * CLI's own syscall table before it sends anything, and agave v3.1.9 does not register `sol_curve_decompress` or
 * `sol_curve_pairing_map` (the BLS12-381 calls of permutation-frontier/src/crypto/sys.rs); v4.0.0 does
 * (agave syscalls/src/lib.rs). The build still uses cargo-build-sbf 3.1.9.
 */
export const MIN_SOLANA_CLI = [4, 0, 0];

// ---------------------------------------------------------------- numbers

/** `--max-len = round_up(1.25 × so_len, 4,096)` (I-45; frontier-abi budgets::max_len_for). */
export function maxLenFor(soLen) {
  const x = Math.ceil((soLen * 5) / 4);
  return Math.ceil(x / 4096) * 4096;
}

/** Rent-exempt minimum of an account of `len` data bytes at `rate` lamports per byte. */
export function rentExempt(len, rate) {
  return (ACCOUNT_OVERHEAD + BigInt(len)) * BigInt(rate);
}

export function sol(lamports) {
  const l = BigInt(lamports);
  const whole = l / LAMPORTS_PER_SOL;
  const frac = (l % LAMPORTS_PER_SOL).toString().padStart(9, '0').slice(0, 4);
  return `${whole}.${frac}`;
}

/**
 * What `solana program deploy` costs the fee payer for a FIRST deploy (agave v3.1.9 cli/src/program.rs
 * `do_process_program_deploy`, programs/bpf_loader `DeployWithMaxDataLen`):
 *   1. the CLI creates the Buffer (37 + so_len bytes) but funds it with the rent of the final ProgramData
 *      (45 + max_len bytes), not of the buffer's own size;
 *   2. one Write per chunk, each signed by the fee payer AND the buffer authority (= the upgrade authority);
 *   3. the deploy instruction drains the Buffer to the payer FIRST, then the payer pays the ProgramData rent,
 *      and the payer funds the 36-byte Program account.
 * So the payer's peak is ProgramData rent + Program rent + fees: the buffer is not an extra hold on top.
 * `upgradeFloat` is what a later upgrade holds for a while (a buffer funded with rent(45 + so_len), returned).
 */
export function deployCost({ soLen, maxLen, rate, lamportsPerSignature = 5000, writeChunkBytes = 850, signaturesPerWrite = 2 }) {
  const programdata = rentExempt(PROGRAMDATA_META + BigInt(maxLen), rate);
  const program = rentExempt(PROGRAM_ACCOUNT_LEN, rate);
  const upgradeFloat = rentExempt(PROGRAMDATA_META + BigInt(soLen), rate);
  const writes = Math.ceil(soLen / writeChunkBytes);
  // create buffer (2: payer, buffer) + writes (payer + authority each) + deploy (3: payer, program, authority)
  const signatures = 2 + writes * signaturesPerWrite + 3;
  const fees = BigInt(signatures) * BigInt(lamportsPerSignature);
  const kept = programdata + program;
  return { rate, programdata, program, writes, signatures, fees, kept, peak: kept + fees, upgradeFloat };
}

/** Per-season lines: [name, lamports, kind]. */
export function seasonCost(season, rate) {
  const lines = [];
  const L = season.lamports;
  lines.push(['Creation bond (returned after a normal season)', BigInt(L.creationBond), 'returned']);
  lines.push([`ProvinceFunds pfund_initial (${season.preset})`, BigInt(L.pfundInitial), 'float']);
  lines.push([`DefencePool dpool_initial (${season.preset})`, BigInt(L.dpoolInitial), 'returned if unspent']);
  for (const a of season.accounts) lines.push([`${a.name}: ${a.count} x ${a.bytes} B`, BigInt(a.count) * rentExempt(a.bytes, rate), 'float']);
  const per = season.perPlayerAccounts.reduce((s, a) => s + rentExempt(a.bytes, rate), 0n);
  lines.push([`Player rent, ${season.players} players (${season.perPlayerAccounts.map(a => a.name).join(' + ')} = ${sol(per)} SOL each)`, per * BigInt(season.players), 'float']);
  lines.push(['Keeper A+B reveal pools (150 payers each, up to 2 x floor)', BigInt(L.keeperRevealPools), 'float']);
  lines.push(['Keeper A+B delay pools (32 payers each, up to 2 x 0.05 SOL)', BigInt(L.keeperDelayPools), 'float']);
  lines.push(['Keeper beneficiaries (ClaimDefence fee payer)', BigInt(L.keeperBeneficiaries), 'float']);
  lines.push(['Relay payer pool (150 x 0.05 SOL)', BigInt(L.relayPool), 'float']);
  lines.push([`Fees and tips over 7 days (${season.players} players)`, BigInt(L.feesAndTipsPer50Players) * BigInt(season.players) / 50n, 'spent']);
  const total = lines.reduce((s, l) => s + l[1], 0n);
  const perDay = (season.continuousWorldPerDay ?? []).reduce((s, a) => s + BigInt(a.count) * rentExempt(a.bytes, rate), 0n);
  return { lines, total, continuousPerDay: perDay };
}

// ---------------------------------------------------------------- addresses

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 decode; null when the text is not base58. */
export function base58Decode(s) {
  if (typeof s !== 'string' || !s.length) return null;
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
export const isAddress = s => base58Decode(s)?.length === 32;
export const isPlaceholder = s => typeof s !== 'string' || s.includes('SET-BY-R0ZE') || /^<.*>$/.test(s);

// ---------------------------------------------------------------- profile and RPC

export function rpcProblem(url, profile) {
  let u;
  try { u = new URL(url); } catch { return `RPC URL ${url} is not a URL`; }
  if (u.protocol !== 'https:') return `RPC URL ${url}: https only`;
  if (u.username || u.password) return `RPC URL ${url}: no credentials in the URL`;
  const host = u.hostname.toLowerCase();
  for (const p of HARD_REFUSED_RPC_HOST_PATTERNS) if (host.includes(p)) return `RPC URL ${url}: host ${host} is refused (${p}); devnet only`;
  for (const p of profile.refusedRpcHostPatterns ?? []) if (host.includes(p)) return `RPC URL ${url}: host ${host} is refused (${p}); devnet only`;
  if (!(profile.allowedRpcHosts ?? []).includes(host)) return `RPC URL ${url}: host ${host} is not in the profile's allowedRpcHosts`;
  return null;
}

export function profileProblems(profile) {
  const out = [];
  if (profile.schema !== 'wylls-devnet-profile-v1') out.push('profile schema is not wylls-devnet-profile-v1');
  if (profile.cluster !== 'devnet') out.push(`profile cluster ${profile.cluster}: devnet only`);
  const r = rpcProblem(profile.rpcUrl, profile);
  if (r) out.push(r);
  if (!profile.rent?.lamportsPerByteCandidates?.includes(profile.rent?.assume)) out.push('rent.assume must be one of rent.lamportsPerByteCandidates');
  return out;
}

/** Problems that block a send but not a dry run: the placeholders. */
export function addressProblems(profile) {
  const out = [];
  for (const k of ['programId', 'upgradeAuthority']) {
    if (isPlaceholder(profile[k])) out.push(`${k} is still a placeholder (r0ze fills it in)`);
    else if (!isAddress(profile[k])) out.push(`${k} ${profile[k]} is not a 32-byte base58 address`);
  }
  if (!out.length && profile.programId === profile.upgradeAuthority) out.push('programId and upgradeAuthority must differ');
  return out;
}

// ---------------------------------------------------------------- the artefact

const count = (buf, re) => (buf.toString('latin1').match(re) ?? []).length;

/** R_SBF_64_RELATIVE relocations of non-text sections with a non-zero low word (build-frontier.sh's check, ported). */
export function dataRelocsWithAddend(d) {
  if (d.length < 64) return 0;
  const shoff = Number(d.readBigUInt64LE(0x28)), shes = d.readUInt16LE(0x3a), shn = d.readUInt16LE(0x3c);
  if (!shoff || shoff + shes * shn > d.length) return 0;
  const sh = [];
  for (let i = 0; i < shn; i++) {
    const o = shoff + i * shes;
    sh.push({ type: d.readUInt32LE(o + 4), flags: Number(d.readBigUInt64LE(o + 8)), addr: Number(d.readBigUInt64LE(o + 16)), off: Number(d.readBigUInt64LE(o + 24)), size: Number(d.readBigUInt64LE(o + 32)) });
  }
  let bad = 0;
  for (const s of sh) {
    if (s.type !== 9) continue;
    for (let o = s.off; o + 16 <= s.off + s.size; o += 16) {
      const rOff = Number(d.readBigUInt64LE(o)), type = d.readUInt32LE(o + 8);
      if (type !== 8) continue;
      const t = sh.find(x => x.addr && rOff >= x.addr && rOff < x.addr + x.size);
      if (!t || (t.flags & 4)) continue;
      if (d.readUInt32LE(t.off + (rOff - t.addr)) !== 0) bad++;
    }
  }
  return bad;
}

/** Checks the deployable .so the way scripts/build-frontier.sh does, plus the L(kind) size cap. */
export function checkSo(buf, profile) {
  const problems = [];
  const isElf = buf.length >= 64 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  if (!isElf) return { problems: ['not an ELF file'] };
  const eFlags = buf.readUInt32LE(48);
  if (eFlags !== 2) problems.push(`e_flags ${eFlags}, not 2 (SBPF v2)`);
  const overflowPanics = count(buf, /attempt to (add|subtract|multiply) with overflow/g);
  if (!overflowPanics) problems.push('built without overflow checks (no overflow panic message)');
  const markers = profile.program.refusedMarkers.filter(m => buf.includes(Buffer.from(m, 'latin1')));
  for (const m of markers) problems.push(`carries ${m} (a test or localnet build; never deployable)`);
  const relocs = dataRelocsWithAddend(buf);
  if (relocs) problems.push(`${relocs} data relocation(s) with a non-zero addend`);
  const soLen = buf.length;
  if (soLen > profile.program.soLenCap) problems.push(`so_len ${soLen} > ${profile.program.soLenCap}: the S1 L(kind) loaded-data limits no longer cover the program (regenerate frontier-abi v2 budgets first)`);
  let n = buf.length;
  while (n && buf[n - 1] === 0) n--;
  const maxLen = maxLenFor(soLen);
  return {
    problems, eFlags, overflowPanics, markers, relocs, soLen, maxLen,
    programdataLen: maxLen + Number(PROGRAMDATA_META),
    sha256: createHash('sha256').update(buf).digest('hex'),
    programHash: createHash('sha256').update(buf.subarray(0, n)).digest('hex'),
  };
}

// ---------------------------------------------------------------- the send gate

/**
 * Whether a key file may be handed to the CLI: a regular file, mode 0600 (no
 * group/other bits), owned by this user, outside the repository. Its content
 * is never read here.
 */
export function keyFileProblems(label, file, { stat, repoRoot, uid }) {
  if (!file) return [`${label} <file> is required`];
  let st;
  try { st = stat(file); } catch { return [`${label} ${file}: not found`]; }
  const out = [];
  if (!st.isFile()) out.push(`${label} ${file}: not a regular file`);
  if ((st.mode & 0o077) !== 0) out.push(`${label} ${file}: mode ${(st.mode & 0o777).toString(8)}, must be 600`);
  if (uid !== undefined && st.uid !== uid) out.push(`${label} ${file}: not owned by this user`);
  const abs = file.startsWith('/') ? file : null;
  if (!abs) out.push(`${label} ${file}: give an absolute path`);
  else if (path.posix.normalize(abs) !== abs) out.push(`${label} ${file}: give a normalised path (no "..", "." or doubled "/")`);
  else if (abs === repoRoot || abs.startsWith(repoRoot.endsWith('/') ? repoRoot : repoRoot + '/')) out.push(`${label} ${file}: key files never live inside the repository`);
  return out;
}

export function sendProblems(opts, { profile, so, stat, repoRoot, uid }) {
  const out = [];
  if (!opts.approval) out.push(`${APPROVAL_FLAG} not given: dry run only`);
  out.push(...keyFileProblems('--keypair', opts.keypair, { stat, repoRoot, uid }));
  out.push(...keyFileProblems('--program-keypair', opts.programKeypair, { stat, repoRoot, uid }));
  out.push(...keyFileProblems('--upgrade-authority', opts.upgradeAuthority, { stat, repoRoot, uid }));
  if (opts.programKeypair && opts.programKeypair === opts.upgradeAuthority) out.push('--program-keypair and --upgrade-authority must be different files');
  out.push(...addressProblems(profile));
  const r = rpcProblem(opts.rpcUrl ?? profile.rpcUrl, profile);
  if (r) out.push(r);
  if (!so || so.problems.length) out.push('the .so does not pass its checks');
  if (!opts.approvedSha256) out.push('--approved-sha256 <sha256 of the .so r0ze approved> is required');
  else if (so && opts.approvedSha256 !== so.sha256) out.push(`--approved-sha256 ${opts.approvedSha256} is not this .so (${so.sha256})`);
  return out;
}

/** "solana-cli 4.4.1 (src:…)" → [4, 4, 1]; null when it is not a version line. */
export function parseCliVersion(text) {
  const m = /^solana-cli (\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function cliTooOld(v, min = MIN_SOLANA_CLI) {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] < min[i];
  return false;
}

// ---------------------------------------------------------------- the commands

/** The deploy and verification commands, as argv arrays (never a shell string). */
export function deployCommands({ profile, so, soPath, rpcUrl, keypair, programKeypair, upgradeAuthority, dumpPath }) {
  const url = rpcUrl ?? profile.rpcUrl;
  return [
    ['solana', ['--version']],
    ['solana', ['address', '--keypair', programKeypair]],
    ['solana', ['address', '--keypair', upgradeAuthority]],
    ['solana', ['balance', '--keypair', keypair, '--url', url]],
    ['solana', ['program', 'deploy', soPath, '--url', url, '--keypair', keypair, '--fee-payer', keypair,
      '--program-id', programKeypair, '--upgrade-authority', upgradeAuthority, '--max-len', String(so.maxLen),
      '--use-rpc', '--commitment', 'confirmed']],
    ['solana', ['program', 'show', profile.programId, '--url', url]],
    ['solana', ['program', 'dump', profile.programId, dumpPath, '--url', url]],
  ];
}

// ---------------------------------------------------------------- arguments

export function parseArgs(argv) {
  const o = { approval: false, build: false, twice: false, json: false };
  const val = (i, f) => { if (i + 1 >= argv.length) throw new Error(`${f} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case APPROVAL_FLAG: o.approval = true; break;
      case '--build': o.build = true; break;
      case '--twice': o.twice = true; break;
      case '--json': o.json = true; break;
      case '--profile': o.profile = val(i, a); i++; break;
      case '--so': o.so = val(i, a); i++; break;
      case '--rpc': o.rpcUrl = val(i, a); i++; break;
      case '--rate': o.rate = Number(val(i, a)); i++; break;
      case '--players': o.players = Number(val(i, a)); i++; break;
      case '--keypair': o.keypair = val(i, a); i++; break;
      case '--program-keypair': o.programKeypair = val(i, a); i++; break;
      case '--upgrade-authority': o.upgradeAuthority = val(i, a); i++; break;
      case '--approved-sha256': o.approvedSha256 = val(i, a); i++; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return o;
}

export const USAGE = `scripts/devnet/dry-run.mjs [--build [--twice]] [--so FILE] [--profile FILE] [--rate LAMPORTS_PER_BYTE] [--players N] [--json]
  Dry run (default): checks the .so, computes the devnet cost and prints the plan. Sends nothing.
  Send (r0ze only): add ${APPROVAL_FLAG} --keypair FILE --program-keypair FILE --upgrade-authority FILE --approved-sha256 HEX
  (key files: absolute paths, mode 600, outside the repository; never read by this script;
   Solana CLI ${MIN_SOLANA_CLI.join('.')} or newer: 3.1.x cannot verify this program's BLS12-381 syscalls).`;

// ---------------------------------------------------------------- the run

function planText({ profile, so, soPath, costs, season, rate, commands, blocked }) {
  const L = [];
  L.push('WYLLS devnet deploy plan (DRY RUN unless the gate below says OPEN)');
  L.push(`cluster ${profile.cluster}  rpc ${profile.rpcUrl}`);
  L.push(`program ${profile.programId}`);
  L.push(`upgrade authority ${profile.upgradeAuthority}`);
  L.push('');
  L.push(`artefact ${soPath}`);
  if (so) {
    L.push(`  so_len ${so.soLen}  max_len ${so.maxLen}  programdata ${so.programdataLen}  e_flags ${so.eFlags}  overflow_panic ${so.overflowPanics}`);
    L.push(`  file_sha256  ${so.sha256}`);
    L.push(`  program_hash ${so.programHash}`);
    L.push(`  checks ${so.problems.length ? 'FAIL: ' + so.problems.join('; ') : 'pass'}`);
  }
  L.push('');
  L.push('Program deploy cost, rent_exempt(len) = (128 + len) x lamports_per_byte:');
  L.push('  (first deploy: the CLI funds the buffer with the ProgramData rent and the deploy returns it before');
  L.push('   paying for the ProgramData, so the peak is programdata + program + fees; "upgrade" is the');
  L.push('   returned float a later upgrade holds)');
  L.push('  rate   programdata  program  fees     peak     kept     upgrade(temp)');
  for (const c of costs) L.push(`  ${String(c.rate).padEnd(5)}  ${sol(c.programdata).padStart(11)}  ${sol(c.program).padStart(7)}  ${sol(c.fees).padStart(6)}  ${sol(c.peak).padStart(7)}  ${sol(c.kept).padStart(7)}  ${sol(c.upgradeFloat).padStart(13)}`);
  L.push('');
  L.push(`One season (${profile.season.preset}, ${profile.season.players} players) at ${rate} lamports/byte:`);
  for (const [n, l, k] of season.lines) L.push(`  ${sol(l).padStart(9)} SOL  ${k.padEnd(19)} ${n}`);
  L.push(`  ${sol(season.total).padStart(9)} SOL  total to hold at season start`);
  L.push(`  continuous world (no end): + ${sol(season.continuousPerDay)} SOL per day of AnchorArchives [model]`);
  const dc = costs.find(c => c.rate === rate);
  L.push('');
  L.push(`TOTAL to hold (deploy peak + one season) at ${rate}: ${sol(dc.peak + season.total)} SOL`);
  L.push('');
  L.push('Commands (argv; run only with the gate open):');
  for (const [c, a] of commands) L.push(`  ${c} ${a.join(' ')}`);
  L.push('');
  L.push('Not covered here (no tool exists yet, see reports/devnet-readiness.md): AnnounceSeason, CreateSeason, InitBeaconLogs, InitShards (G4).');
  L.push('');
  L.push(blocked.length ? `SEND GATE: CLOSED\n${blocked.map(b => `  - ${b}`).join('\n')}` : 'SEND GATE: OPEN');
  return L.join('\n');
}

/**
 * The whole dry run. `io`: { repoRoot, readFile(path) → Buffer, writeFile(path, text), mkdir(path), exists(path), stat(path),
 * exec(cmd, args, {cwd}) → {status, stdout}, log(text), err(text), uid, tmpDir }.
 * Returns the exit code: 0 dry run done (or sent), 2 bad arguments/profile, 3 artefact refused, 4 send step failed.
 */
export function run(argv, io) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { io.err(`${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { io.log(USAGE); return 0; }
  const profilePath = opts.profile ?? `${io.repoRoot}/scripts/devnet/devnet-profile.json`;
  let profile;
  try { profile = JSON.parse(io.readFile(profilePath).toString('utf8')); } catch (e) { io.err(`profile ${profilePath}: ${e.message}`); return 2; }
  const pp = profileProblems(profile);
  if (opts.rpcUrl) { const r = rpcProblem(opts.rpcUrl, profile); if (r) pp.push(r); }
  if (pp.length) { io.err(`profile refused:\n${pp.map(p => `  - ${p}`).join('\n')}`); return 2; }
  if (opts.players !== undefined) {
    if (!Number.isInteger(opts.players) || opts.players < 0) { io.err('--players must be a whole number'); return 2; }
    profile.season.players = opts.players;
  }
  const rate = opts.rate ?? profile.rent.assume;
  if (!profile.rent.lamportsPerByteCandidates.includes(rate)) { io.err(`--rate ${rate}: one of ${profile.rent.lamportsPerByteCandidates.join(', ')}`); return 2; }

  const soPath = opts.so ?? `${io.repoRoot}/${profile.program.so}`;
  if (opts.build) {
    // cargo-build-sbf writes <name>-keypair.json next to the .so when the file is missing
    // (agave v3.1.9 platform-tools-sdk/cargo-build-sbf/src/post_processing.rs: `if !program_keypair.exists()`),
    // and never reads it. A placeholder that is not a key keeps the build key-free; a real file is left alone.
    const holder = soPath.replace(/\.so$/, '-keypair.json');
    // (--twice builds into two temporary directories; scripts/build-frontier.sh puts the same kind of placeholder there.)
    try {
      if (!io.exists(holder)) { io.mkdir(path.posix.dirname(holder)); io.writeFile(holder, 'PLACEHOLDER: not a key. Exists so cargo-build-sbf skips program-keypair generation (scripts/devnet/dry-run.mjs).\n'); }
    } catch (e) { io.err(`cannot write the keypair placeholder ${holder}: ${e.message}`); return 3; }
    const r = io.exec(`${io.repoRoot}/${profile.program.build}`, opts.twice ? ['--twice'] : [], { cwd: io.repoRoot });
    if (r.status !== 0) { io.err(`build failed (${profile.program.build}, exit ${r.status})`); return 3; }
  }
  if (!io.exists(soPath)) { io.err(`${soPath} not found: run with --build (scripts/build-frontier.sh)`); return 3; }
  const so = checkSo(io.readFile(soPath), profile);
  const costs = profile.rent.lamportsPerByteCandidates.map(r => deployCost({ soLen: so.soLen ?? 0, maxLen: so.maxLen ?? 0, rate: r, ...profile.fees }));
  const season = seasonCost(profile.season, rate);
  const dumpPath = `${io.tmpDir}/wylls-devnet-dump.so`;
  const commands = deployCommands({ profile, so, soPath, rpcUrl: opts.rpcUrl, keypair: opts.keypair ?? '<FEE_PAYER_FILE>', programKeypair: opts.programKeypair ?? '<PROGRAM_KEYPAIR_FILE>', upgradeAuthority: opts.upgradeAuthority ?? '<UPGRADE_AUTHORITY_FILE>', dumpPath });
  const blocked = sendProblems(opts, { profile, so, stat: io.stat, repoRoot: io.repoRoot, uid: io.uid });
  if (opts.json) {
    const big = (_, v) => (typeof v === 'bigint' ? v.toString() : v);
    io.log(JSON.stringify({ profile: { cluster: profile.cluster, rpcUrl: profile.rpcUrl, programId: profile.programId }, so, rate, costs, season, commands, gate: blocked.length ? 'closed' : 'open', blocked }, big, 2));
  } else io.log(planText({ profile, so, soPath, costs, season, rate, commands, blocked }));
  if (so.problems.length) return 3;
  if (blocked.length) return 0;

  // ---- the gate is open: r0ze's run. Each step must succeed before the next.
  const [version, progAddr, authAddr, balance, deploy, show, dump] = commands;
  const step = ([c, a]) => io.exec(c, a, { cwd: io.repoRoot });
  const ver = step(version);
  if (ver.status !== 0) { io.err('solana CLI not found'); return 4; }
  const cli = parseCliVersion(ver.stdout);
  if (!cli || cliTooOld(cli)) { io.err(`Solana CLI ${cli ? cli.join('.') : '(unreadable version)'}: need ${MIN_SOLANA_CLI.join('.')} or newer to deploy this program (its local ELF check must know sol_curve_decompress and sol_curve_pairing_map)`); return 4; }
  const pa = step(progAddr), aa = step(authAddr);
  if (pa.status !== 0 || String(pa.stdout).trim() !== profile.programId) { io.err(`--program-keypair is not ${profile.programId}`); return 4; }
  if (aa.status !== 0 || String(aa.stdout).trim() !== profile.upgradeAuthority) { io.err(`--upgrade-authority is not ${profile.upgradeAuthority}`); return 4; }
  if (step(balance).status !== 0) { io.err('balance check failed'); return 4; }
  for (const s of [deploy, show, dump]) if (step(s).status !== 0) { io.err(`step failed: ${s[0]} ${s[1].slice(0, 2).join(' ')}`); return 4; }
  const got = io.readFile(dumpPath);
  let n = got.length;
  while (n && got[n - 1] === 0) n--;
  const h = createHash('sha256').update(got.subarray(0, n)).digest('hex');
  if (h !== so.programHash) { io.err(`on-chain program_hash ${h} != ${so.programHash}`); return 4; }
  io.log(`deployed and verified: program_hash ${h}`);
  return 0;
}
