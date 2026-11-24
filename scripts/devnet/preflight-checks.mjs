// Deploy-day preflight for the devnet PLAYABLE lane (B7): every MUST item of the
// NEEDS-R0ZE block and DEVNET-DEPLOY-RUNBOOK §8 / §8a, checked READ-ONLY, one
// line per item with PASS / FAIL / WARN / SKIP and the fix.
//
// What this code can never do (and the tests pin it):
//   - send a transaction, sign, airdrop or spend SOL: the only processes it starts are
//     `<cli> --version`, `rustup toolchain list` and (with --build only) the key-free
//     build script, through an allow-list (EXEC_ALLOWED);
//   - read or create a private key: key files are stat()ed (exists, mode, owner,
//     place) and never opened; the keeper's seed and token files the same;
//   - contact a cluster without an explicit `--rpc <url>`: the RPC checks use only the
//     read methods of RPC_METHODS, at most RPC_BUDGET calls, and refuse mainnet/testnet
//     hosts whatever the profile says;
//   - print a secret: RPC URLs are shown as their host only, env assignments in the
//     services file by name only.
//
// Every effect goes through the `io` object (scripts/devnet/preflight.mjs wires the real
// one; test/preflight.test.mjs wires fakes): { repoRoot, home, uid, readFile(p) → Buffer,
// exists(p), stat(p), exec(cmd, args, {cwd}) → {status, stdout, stderr}, http(url, opts) →
// Promise<{status, headers, body}>, tcpOpen(host, port) → Promise<bool>, sleep(ms), now() }.
import path from 'node:path';
import { checkSo, isAddress, isPlaceholder, maxLenFor, MAX_PERMITTED_DATA_LENGTH, MIN_SOLANA_CLI, parseCliVersion, cliTooOld, run as planRun } from './plan.mjs';

// ------------------------------------------------------------------ constants (each names its source)

/** The devnet .so r0ze is asked to approve (runbook §1a, NEEDS-R0ZE ARTEFACT; P14 b, #139). */
export const EXPECTED_ARTEFACT = Object.freeze({
  sha256: '67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3',
  programHash: '8dcaef873758b981df191a33f5e38bfb90afbf9ae673d2589641adf9f40174bb',
  soLen: 3_447_064,
  maxLen: 4_308_992,
});
/** `solana genesis-hash --url devnet` (runbook §3, measured 2026-11-18). */
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** Feature gates the runbook §3 reads (agave feature ids). */
export const FEATURES = Object.freeze({
  bls: { id: 'b1sgUiJ3qu7hYm3tNDyyqZNQd6gLGJmJppnLNa93PCQ', want: true, name: 'BLS12-381 syscalls (SIMD-0388)' },
  sbpfV2: { id: 'F6UVKh1ujTEFK3en2SyAL3cdVnqko1FVEXWhmdLRu6WP', want: true, name: 'SBPF v2 deployment' },
  simd0500: { id: 'B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g', want: false, name: 'SIMD-0500 (disables SBPF v0-v2 deploys)' },
});
/** Keeper A's roles and rings duty as runbook §8 step 5 / §6b list them (and the profile's services.keeperA). */
export const RUNBOOK_KEEPER_ROLES = Object.freeze(['beacon', 'archive', 'rings', 'fold', 'tickets', 'wide-tickets', 'reveal', 'settle-departure', 'gather', 'resolve', 'skip', 'settle', 'close', 'claims', 'expeditions', 'wide-resolve']);
/** devnet-territory-dev: a territory world's keeper A runs the runbook's roles AND `territory` (the upkeep settles, decay
 * and conquest transfer; owner NWP-2: territory must be playable on devnet before world 3). */
export const TERRITORY_KEEPER_ROLES = Object.freeze([...RUNBOOK_KEEPER_ROLES, 'territory']);
/** The roles a profile's keeper A must list: the runbook's, plus `territory` for the S1_DEVNET_TERRITORY world. */
export const keeperRolesFor = profile => (profile?.season?.preset === 'S1_DEVNET_TERRITORY' ? TERRITORY_KEEPER_ROLES : RUNBOOK_KEEPER_ROLES);
export const RUNBOOK_RINGS_DUTY = Object.freeze({ extend: true, extend_max_ring: 128, lazy_provinces: true, rim_per_wedge: 6, provinces_reach: 3, wide_rings: 3, wide_per_wedge: 6 });
/** Runbook §8 step 5's keeper.toml value (the herald's and keeper's own default is 150 ms). */
export const KEEPER_RPC_MIN_GAP_MS = 250;
/** Runbook §8 step 6 (fix-devnet-join-wait / herald-load-50). */
export const HERALD_FLAGS = Object.freeze({ 'rpc-min-gap-ms': '100', 'poll-ms': '1000', source: 'rpc', cluster: 'devnet' });
/** §8a: 15 nudges, burst 10 then 0.5/s (app.mjs FRONTIER_IP_LIMITS 'POST /f/nudge'). */
export const XFF_NUDGES = 15;
export const XFF_BURST = 10;
/** Ports that must not answer from outside (§8a table). */
export const PRIVATE_PORTS = Object.freeze([41040, 41050, 41030, 41033]);
/** RPC read methods the preflight may call, and the hard budget per run. */
export const RPC_METHODS = Object.freeze(['getGenesisHash', 'getVersion', 'getMinimumBalanceForRentExemption', 'getMultipleAccounts', 'getBalance']);
export const RPC_BUDGET = 8;
export const RPC_GAP_MS = 300;
const HARD_REFUSED_HOSTS = ['mainnet', 'testnet', 'api.solana.com'];
const LAMPORTS = 1_000_000_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// ------------------------------------------------------------------ results

export const r = (id, must, status, detail, fix = '') => ({ id, must, status, detail, fix });
const pass = (id, must, detail) => r(id, must, 'PASS', detail);
const fail = (id, must, detail, fix) => r(id, must, 'FAIL', detail, fix);
const warn = (id, must, detail, fix) => r(id, must, 'WARN', detail, fix);
const skip = (id, must, detail, fix) => r(id, must, 'SKIP', detail, fix);

/** An error's text: Node's ECONNREFUSED to "localhost" is an AggregateError with an EMPTY message (verify-pr181). */
export function errText(e) {
  if (e?.message) return e.message;
  const inner = Array.isArray(e?.errors) ? e.errors.map(x => x?.message || x?.code).filter(Boolean) : [];
  return inner.length ? [...new Set(inner)].join('; ') : (e?.code ?? String(e));
}

/** "https://key@host/path?api-key=…" → "https://host" (never print a provider key). */
export function redactUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname && x.pathname !== '/' ? '/…' : ''}`; } catch { return '<not a URL>'; }
}

// ------------------------------------------------------------------ process allow-list

/**
 * The only processes the preflight may start. Anything else throws before spawning:
 * `<solana> --version`, `cargo-build-sbf --version`, `node --version`, `cargo --version`,
 * `rustup toolchain list`, and the profile's key-free build script with `--twice`.
 */
export function execAllowed(cmd, args, { buildScript } = {}) {
  const base = path.basename(cmd);
  if (args.length === 1 && args[0] === '--version' && ['solana', 'cargo-build-sbf', 'node', 'cargo'].includes(base)) return true;
  if (base === 'rustup' && args.length === 2 && args[0] === 'toolchain' && args[1] === 'list') return true;
  if (buildScript && cmd === buildScript && args.length === 1 && args[0] === '--twice') return true;
  return false;
}

// ------------------------------------------------------------------ MUST 1: local play-check (manual)

export function checkPlayLocal() {
  return skip('play-local', '1', 'manual (t341u): cannot be checked by a script', 'run scripts/play-local.sh, then scripts/play-local.sh --wide, and play through Join → village → march');
}

// ------------------------------------------------------------------ MUST 3: toolchain

export function checkToolchain(io, opts) {
  const out = [];
  const ver = (cmd, args = ['--version']) => {
    if (!execAllowed(cmd, args)) throw new Error(`preflight refuses to start ${cmd} ${args.join(' ')}`);
    try { return io.exec(cmd, args, { cwd: io.repoRoot }); } catch (e) { return { status: -1, stdout: '', stderr: String(e.message) }; }
  };
  // The 4.x CLI beside 3.1.9 (runbook §1a "Two tool versions"; plan.mjs MIN_SOLANA_CLI).
  const s4 = opts.solana4 ?? `${io.home}/solana-4x/bin/solana`;
  if (path.basename(s4) !== 'solana') out.push(fail('tool.solana4', '3', `--solana4 ${s4}: not a bin/solana (the preflight starts only a file named solana, with --version)`, `pass the 4.x release's bin/solana (e.g. ~/solana-4x/bin/solana)`));
  else if (!io.exists(s4)) out.push(fail('tool.solana4', '3', `no Solana CLI at ${s4}`, `unpack an agave >= ${MIN_SOLANA_CLI.join('.')} release there (runbook §1a; keep active_release on 3.1.9), or pass --solana4 <path to its bin/solana>`));
  else {
    const v = ver(s4);
    const p = v.status === 0 ? parseCliVersion(v.stdout) : null;
    if (!p) out.push(fail('tool.solana4', '3', `${s4} --version did not print a solana-cli version`, 'reinstall the 4.x release'));
    else if (cliTooOld(p)) out.push(fail('tool.solana4', '3', `${s4} is solana-cli ${p.join('.')} (< ${MIN_SOLANA_CLI.join('.')}: cannot verify sol_curve_decompress / sol_curve_pairing_map)`, `install agave >= ${MIN_SOLANA_CLI.join('.')} beside 3.1.9 (runbook §1a)`));
    else out.push(pass('tool.solana4', '3', `solana-cli ${p.join('.')} at ${s4}`));
  }
  // The build pair: cargo-build-sbf 3.1.9 + platform-tools v1.52 (scripts/build-frontier.sh refuses any other).
  const rel = opts.solanaBuildBin ?? `${io.home}/.local/share/solana/install/active_release/bin`;
  const cbs = `${rel}/cargo-build-sbf`;
  if (!io.exists(cbs)) out.push(fail('tool.build-sbf', '3/6', `no cargo-build-sbf at ${cbs}`, 'install agave 3.1.9 as the active release (scripts/build-frontier.sh needs exactly 3.1.9)'));
  else {
    const v = ver(cbs);
    const okVer = /cargo-build-sbf 3\.1\.9\b/.test(v.stdout ?? '');
    const okTools = /platform-tools v1\.52\b/.test(v.stdout ?? '');
    const s3 = ver(`${rel}/solana`);
    const p3 = s3.status === 0 ? parseCliVersion(s3.stdout) : null;
    const tail = p3 ? `; solana-cli ${p3.join('.')} beside it` : '';
    if (okVer && okTools) out.push(pass('tool.build-sbf', '3/6', `solana-cargo-build-sbf 3.1.9, platform-tools v1.52${tail}`));
    else out.push(fail('tool.build-sbf', '3/6', `cargo-build-sbf: ${String(v.stdout ?? '').trim().replace(/\n/g, ' ') || 'no version'}`, 'the build is pinned to cargo-build-sbf 3.1.9 + platform-tools v1.52 (scripts/build-frontier.sh)'));
  }
  // node: the gateway and the dry run (CI uses 20; the ⑬ suites need 20, see play-local docs).
  const n = path.basename(opts.nodeBin ?? 'node') === 'node' ? ver(opts.nodeBin ?? 'node') : { status: -1, stdout: '' };
  const nm = /^v(\d+)\./.exec(String(n.stdout ?? '').trim());
  if (!nm) out.push(fail('tool.node', '3', 'node --version failed', 'install Node.js >= 20'));
  else if (Number(nm[1]) < 20) out.push(fail('tool.node', '3', `node ${String(n.stdout).trim()} (< 20)`, 'install Node.js >= 20 (the gateway and CI use 20)'));
  else out.push(pass('tool.node', '3', `node ${String(n.stdout).trim()}`));
  // cargo + the two pinned toolchains (rust-toolchain.toml 1.89.0, frontier-node/rust-toolchain.toml 1.95.0).
  const c = ver('cargo');
  const t = ver('rustup', ['toolchain', 'list']);
  const want = ['1.89.0', '1.95.0'];
  const have = String(t.stdout ?? '');
  const missing = want.filter(w => !have.split('\n').some(l => l.startsWith(w)));
  if (c.status !== 0) out.push(fail('tool.cargo', '6', 'cargo --version failed', 'install rustup + cargo'));
  else if (t.status !== 0) out.push(warn('tool.cargo', '6', `${String(c.stdout).trim()}; rustup toolchain list failed`, `make sure toolchains ${want.join(' and ')} are installed (rust-toolchain.toml, frontier-node/rust-toolchain.toml)`));
  else if (missing.length) out.push(fail('tool.cargo', '6', `${String(c.stdout).trim()}; toolchain(s) ${missing.join(', ')} not installed`, `rustup toolchain install ${missing.join(' ')} (offline builds cannot fetch them on the day)`));
  else out.push(pass('tool.cargo', '6', `${String(c.stdout).trim()}; toolchains ${want.join(' + ')} installed`));
  return out;
}

// ------------------------------------------------------------------ MUST 4: profile and key files

/** The playable lane's presets (frontier-operator `is_wide_preset`): the continuous devnet world
 * (devnet-continuous-1, seasons abolished 2026-11-23), the 7-day preset it was made from, and the new world
 * (devnet-new-world-plan: S1_DEVNET_TERRITORY, defined in frontier-abi by #209; scripts/devnet/devnet-new-world-profile.json). */
export const PLAYABLE_PRESETS = ['S1_DEVNET_WIDE_CONTINUOUS', 'S1_DEVNET_WIDE_7D', 'S1_DEVNET_TERRITORY'];
/** frontier-operator KEEP_HOLDER_NAMES (wide.keepHolder; absent = MixedInterleaved) and the ones whose wide keeps all open
 * unowned (owner 2026-11-24 12:07: the new world starts with ALL wide land unowned). */
export const KEEP_HOLDERS = ['MixedInterleaved', 'OrbitBalanced', 'Neutral', 'NeutralTerritoryV1'];
export const NEUTRAL_KEEP_HOLDERS = ['Neutral', 'NeutralTerritoryV1'];

export function checkProfile(profile, { profilePath } = {}) {
  const out = [];
  const shape = [];
  if (profile.schema !== 'wylls-devnet-profile-v1') shape.push('schema is not wylls-devnet-profile-v1');
  if (profile.cluster !== 'devnet') shape.push(`cluster ${profile.cluster} (devnet only)`);
  if (profile.lane !== 'playable') shape.push(`lane ${profile.lane} (the playable lane, B7)`);
  if (profile.program?.programVersion !== '0x4804') shape.push(`program.programVersion ${profile.program?.programVersion} (0x4804)`);
  if (!(profile.program?.requiredMarkers ?? []).includes('PSF_DEVNET_PLAYABLE_BUILD')) shape.push('program.requiredMarkers lacks PSF_DEVNET_PLAYABLE_BUILD');
  if (!PLAYABLE_PRESETS.includes(profile.season?.preset)) shape.push(`season.preset ${profile.season?.preset} (${PLAYABLE_PRESETS.join(' or ')})`);
  if (profile.operator?.beacon !== 'quicknet') shape.push(`operator.beacon ${profile.operator?.beacon} (quicknet)`);
  const kh = profile.wide?.keepHolder;
  if (kh !== undefined && !KEEP_HOLDERS.includes(kh)) shape.push(`wide.keepHolder ${kh} (${KEEP_HOLDERS.join(', ')})`);
  if (kh === 'OrbitBalanced') shape.push('wide.keepHolder OrbitBalanced (placement 2 refuses it)');
  if (profile.season?.preset === 'S1_DEVNET_TERRITORY' && !NEUTRAL_KEEP_HOLDERS.includes(kh)) shape.push(`wide.keepHolder ${kh ?? '(absent: MixedInterleaved)'} (S1_DEVNET_TERRITORY needs ${NEUTRAL_KEEP_HOLDERS.join(' or ')}: all wide land unowned)`);
  try {
    const host = new URL(profile.rpcUrl).hostname;
    if (!(profile.allowedRpcHosts ?? []).includes(host)) shape.push(`rpcUrl host ${host} not in allowedRpcHosts`);
    if (HARD_REFUSED_HOSTS.some(p => host.includes(p))) shape.push(`rpcUrl host ${host} is refused`);
  } catch { shape.push('rpcUrl is not a URL'); }
  const ka = profile.services?.keeperA ?? {};
  const roles = ka.roles ?? [];
  const wantRoles = keeperRolesFor(profile);
  const missingRoles = wantRoles.filter(x => !roles.includes(x));
  const extraRoles = roles.filter(x => !wantRoles.includes(x));
  if (missingRoles.length || extraRoles.length) shape.push(`services.keeperA.roles differ from runbook §8 (missing ${missingRoles.join(',') || '-'}; extra ${extraRoles.join(',') || '-'})`);
  for (const [k, v] of Object.entries(RUNBOOK_RINGS_DUTY)) if (ka.ringsDuty?.[k] !== v) shape.push(`services.keeperA.ringsDuty.${k} = ${ka.ringsDuty?.[k]} (runbook: ${v})`);
  if (shape.length) out.push(fail('profile.shape', '4', shape.join('; '), `restore ${profilePath ?? 'the profile'} from origin/main; only programId and upgradeAuthority are r0ze's to change`));
  else out.push(pass('profile.shape', '4', `cluster devnet, lane playable 0x4804, marker PSF_DEVNET_PLAYABLE_BUILD, preset ${profile.season.preset}${kh ? `, keep holder ${kh}` : ''}, keeper A roles + rings duty = runbook`));
  const addr = [];
  for (const k of ['programId', 'upgradeAuthority']) {
    if (isPlaceholder(profile[k])) addr.push(`${k} is still a placeholder`);
    else if (!isAddress(profile[k])) addr.push(`${k} "${profile[k]}" is not a 32-byte base58 address`);
  }
  if (!addr.length && profile.programId === profile.upgradeAuthority) addr.push('programId and upgradeAuthority are the same address');
  if (addr.length) out.push(fail('profile.keys', '4', addr.join('; '), 'solana address -k ~/wylls-devnet-keys/program-playable.json → "programId"; solana address -k ~/wylls-devnet-keys/authority.json → "upgradeAuthority" (runbook §2, §8 step 2)'));
  else out.push(pass('profile.keys', '4', `programId ${profile.programId}, upgradeAuthority ${profile.upgradeAuthority}`));
  return out;
}

/**
 * The 3 deploy key files: exists, regular file, mode 600, owned by this user, absolute,
 * outside the repository. stat() only: the content is never read.
 */
export function keyFileFindings(file, { stat, repoRoot, uid }) {
  let st;
  try { st = stat(file); } catch { return ['not found']; }
  const out = [];
  if (!st.isFile()) out.push('not a regular file');
  if ((st.mode & 0o077) !== 0) out.push(`mode ${(st.mode & 0o777).toString(8)} (must be 600)`);
  if (uid !== undefined && st.uid !== uid) out.push('not owned by this user');
  if (!path.isAbsolute(file)) out.push('not an absolute path');
  else {
    const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
    if (path.resolve(file).startsWith(root)) out.push('inside the repository');
  }
  return out;
}

export function checkKeyFiles(io, opts) {
  const dir = opts.keysDir ?? `${io.home}/wylls-devnet-keys`;
  const files = {
    deployer: opts.deployerKey ?? `${dir}/deployer.json`,
    'program-playable': opts.programKey ?? `${dir}/program-playable.json`,
    authority: opts.authorityKey ?? `${dir}/authority.json`,
  };
  const bad = [], good = [];
  for (const [name, f] of Object.entries(files)) {
    const p = keyFileFindings(f, { stat: io.stat, repoRoot: io.repoRoot, uid: io.uid });
    (p.length ? bad : good).push(p.length ? `${name} ${f}: ${p.join(', ')}` : name);
  }
  if (new Set(Object.values(files)).size !== 3) bad.push('the three key paths must be three different files');
  const out = [];
  if (bad.length) out.push(fail('keys.files', '4', bad.join('; '), `make them offline with runbook §2's commands into ${dir} (mkdir -m 700; never --final; chmod 600 *.json) — or pass --keys-dir / --deployer-key / --program-key / --authority-key`));
  else out.push(pass('keys.files', '4', `deployer, program-playable, authority: present, mode 600, yours, outside the repo (stat only, never read) in ${dir}`));
  try {
    const st = io.stat(dir);
    if ((st.mode & 0o077) !== 0) out.push(warn('keys.dir', '4', `${dir} mode ${(st.mode & 0o777).toString(8)}`, `chmod 700 ${dir} (runbook §2: mkdir -m 700)`));
  } catch { /* reported above */ }
  return out;
}

// ------------------------------------------------------------------ MUST 6: the artefact

export function expectedArtefact(profile, opts = {}) {
  return {
    sha256: opts.expectSha256 ?? profile.program?.expectedSha256 ?? EXPECTED_ARTEFACT.sha256,
    programHash: opts.expectProgramHash ?? profile.program?.expectedProgramHash ?? EXPECTED_ARTEFACT.programHash,
  };
}

export function checkArtefact(io, profile, opts) {
  const out = [];
  const soPath = opts.so ?? `${io.repoRoot}/${profile.program.so}`;
  if (opts.build) {
    const script = `${io.repoRoot}/${profile.program.build}`;
    if (!execAllowed(script, ['--twice'], { buildScript: script })) throw new Error('preflight refuses the build command');
    const b = io.exec(script, ['--twice'], { cwd: io.repoRoot });
    const twice = /twice\s+([0-9a-f]{64}) \(both builds\)/.exec(b.stdout ?? '');
    if (b.status !== 0) out.push(fail('so.build', '6', `${profile.program.build} --twice exit ${b.status}`, 'read the build output; a mismatch between the two builds exits 4, a replaced keypair placeholder 5'));
    else out.push(pass('so.build', '6', `${profile.program.build} --twice: both builds ${twice ? twice[1].slice(0, 16) + '…' : 'identical'}`));
  } else out.push(skip('so.build', '6', 'no rebuild (checking the .so on disk)', `rebuild on deploy day: node scripts/devnet/preflight.mjs --build (runs ${profile.program.build} --twice, key-free)`));
  if (!io.exists(soPath)) {
    out.push(fail('so.checks', '6', `${soPath} not found`, `${profile.program.build} --twice (or pass --so FILE)`));
    return { results: out, so: null, soPath };
  }
  const so = checkSo(io.readFile(soPath), profile);
  if (so.problems.length) out.push(fail('so.checks', '6', so.problems.join('; '), `rebuild with ${profile.program.build} --twice; only that build's artefact is deployable with this profile`));
  else out.push(pass('so.checks', '6', `ELF SBPF v2, overflow checks, marker PSF_DEVNET_PLAYABLE_BUILD, no refused marker, no bad data reloc (${soPath})`));
  const want = expectedArtefact(profile, opts);
  if (so.sha256 === want.sha256) out.push(pass('so.sha256', '6', `file_sha256 ${so.sha256} = the approved one`));
  else out.push(fail('so.sha256', '6', `file_sha256 ${so.sha256} ≠ expected ${want.sha256}`, 'something the build links changed since the approval: do NOT deploy; ask r0ze to approve the new sha256 (runbook §1a), then pass --expect-sha256 <new>'));
  if (so.programHash === want.programHash) out.push(pass('so.program_hash', '6', `program_hash ${so.programHash} (what program dump must hash to)`));
  else out.push(fail('so.program_hash', '6', `program_hash ${so.programHash} ≠ expected ${want.programHash}`, 'same as above: a different build; pass --expect-program-hash only with a newly approved artefact'));
  const sizeBad = [];
  if (so.soLen > profile.program.soLenCap) sizeBad.push(`so_len ${so.soLen} > soLenCap ${profile.program.soLenCap}`);
  if (so.maxLen + 45 > MAX_PERMITTED_DATA_LENGTH) sizeBad.push(`ProgramData ${so.maxLen + 45} > ${MAX_PERMITTED_DATA_LENGTH}`);
  if (so.maxLen !== maxLenFor(so.soLen)) sizeBad.push('max_len rule mismatch');
  if (sizeBad.length) out.push(fail('so.size', '6', sizeBad.join('; '), 'the program grew past the loader limit: needs a smaller build (blocked on r0ze)'));
  else out.push(pass('so.size', '6', `so_len ${so.soLen} ≤ cap ${profile.program.soLenCap}; --max-len ${so.maxLen}; ProgramData ${so.maxLen + 45} ≤ ${MAX_PERMITTED_DATA_LENGTH}`));
  return { results: out, so, soPath };
}

// ------------------------------------------------------------------ MUST 2 / 5: the planner (offline)

/** plan.mjs's own dry run, offline, at one rate; returns {peak, season, total} in lamports or an error. */
export function planAt(io, { profilePath, soPath, rate }) {
  const logs = [], errs = [];
  const planIo = {
    repoRoot: io.repoRoot, tmpDir: '/nonexistent-preflight', uid: io.uid,
    readFile: p => io.readFile(p), exists: p => io.exists(p), stat: p => io.stat(p),
    // The planner is called without --build and without the gate: nothing may be written or started.
    writeFile: () => { throw new Error('preflight: the planner must not write'); },
    mkdir: () => { throw new Error('preflight: the planner must not write'); },
    exec: () => { throw new Error('preflight: the planner must not start processes'); },
    log: t => logs.push(t), err: t => errs.push(t),
  };
  const code = planRun(['--profile', profilePath, '--so', soPath, '--rate', String(rate), '--json'], planIo);
  if (!logs.length) return { error: `dry run exit ${code}: ${errs.join(' ').trim()}` };
  const j = JSON.parse(logs[0]);
  const c = j.costs.find(x => x.rate === rate);
  const peak = BigInt(c.peak), season = BigInt(j.season.total);
  return { code, gate: j.gate, peak, season, total: peak + season, soProblems: j.so.problems };
}

const solStr = l => (Number(l) / LAMPORTS).toFixed(2);
const faucetRequests = l => Math.ceil(Number(l) / (5 * LAMPORTS));

export function checkPlanner(io, profile, { profilePath, soPath, rates }) {
  const out = [];
  if (!soPath || !io.exists(soPath)) return [fail('plan', '2/5', 'no .so to plan for', 'build it first (or pass --so)')];
  for (const { rate, why } of rates) {
    const id = `plan.${rate}`;
    if (!profile.rent.lamportsPerByteCandidates.includes(rate)) {
      out.push(fail(id, '2/5', `rate ${rate} (${why}) is not one of the profile's candidates ${profile.rent.lamportsPerByteCandidates.join(', ')}`, 'a rate outside the SIMD-0437 steps means the rent model changed: stop and re-read runbook §3/§4'));
      continue;
    }
    const p = planAt(io, { profilePath, soPath, rate });
    if (p.error) { out.push(fail(id, '2/5', p.error, 'node scripts/devnet/dry-run.mjs --profile scripts/devnet/devnet-playable-profile.json --rate ' + rate)); continue; }
    if (p.gate !== 'closed') { out.push(fail(id, '2/5', 'the dry run reports its send gate OPEN', 'the preflight never passes send flags: investigate')); continue; }
    out.push(pass(id, '2/5', `at ${rate} lamports/byte (${why}): deploy peak ${solStr(p.peak)} + season ${solStr(p.season)} = ${solStr(p.total)} SOL; faucet 5-SOL requests: ${faucetRequests(p.peak)} for the deploy, ${faucetRequests(p.total)} with one season; + keeper A fees (~3 small, ≤10 full; §4b)`));
  }
  return out;
}

// ------------------------------------------------------------------ MUST 2 / 5: read-only RPC (only with --rpc)

export function rpcUrlProblem(url, profile, { expectGenesis } = {}) {
  let u;
  try { u = new URL(url); } catch { return 'not a URL'; }
  if (u.username || u.password) return 'no credentials in the URL user part';
  const host = u.hostname.toLowerCase();
  const loop = LOOPBACK.has(host);
  // 'api.devnet.solana.com' contains none of these; a --profile file cannot widen the hard list.
  for (const p of [...HARD_REFUSED_HOSTS, ...(profile.refusedRpcHostPatterns ?? [])]) if (host.includes(p)) return `host ${host} is refused (${p}): devnet only`;
  if (!loop && u.protocol !== 'https:') return 'https only (plain http is allowed for a loopback test chain)';
  if (expectGenesis && !loop) return '--expect-genesis is for a loopback test chain only';
  return null;
}

/** A metered, allow-listed JSON-RPC client: read methods only, RPC_BUDGET calls, RPC_GAP_MS apart. */
export function rpcClient(io, url) {
  let calls = 0, last = 0;
  const log = [];
  const call = async (method, params = []) => {
    if (!RPC_METHODS.includes(method)) throw new Error(`preflight refuses RPC method ${method}`);
    if (calls >= RPC_BUDGET) throw new Error(`preflight RPC budget (${RPC_BUDGET}) spent`);
    const wait = last + RPC_GAP_MS - io.now();
    if (wait > 0) await io.sleep(wait);
    calls++; last = io.now();
    log.push(method);
    const res = await io.http(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }), timeoutMs: 15_000 });
    if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status}`);
    const j = JSON.parse(res.body);
    if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  };
  return { call, log, get calls() { return calls; } };
}

/** A feature account (bincode Option<u64>): activated iff it exists and its first byte is 1. */
export function featureState(acct) {
  if (!acct) return { active: false, why: 'no account' };
  const data = Buffer.from(Array.isArray(acct.data) ? acct.data[0] : '', 'base64');
  if (data[0] === 1 && data.length >= 9) return { active: true, slot: Number(data.readBigUInt64LE(1)) };
  return { active: false, why: 'pending (account without activation slot)' };
}

export async function checkRpc(io, profile, opts) {
  if (!opts.rpc) return { results: [skip('rpc', '2', 'read-only devnet checks are OFF by default', 'right before the deploy (r0ze approves, B5): --rpc https://api.devnet.solana.com — reads genesis, version, rent, BLS / SBPF v2 / SIMD-0500 features, the program id and the authority balance; sends nothing')], rate: null };
  const bad = rpcUrlProblem(opts.rpc, profile, opts);
  if (bad) return { results: [fail('rpc', '2', `--rpc ${redactUrl(opts.rpc)}: ${bad}`, 'give the devnet RPC (https)')], rate: null };
  const c = rpcClient(io, opts.rpc);
  const out = [];
  let rate = null;
  try {
    const g = await c.call('getGenesisHash');
    const want = opts.expectGenesis ?? DEVNET_GENESIS;
    if (g !== want) {
      out.push(fail('rpc.genesis', '2', `${redactUrl(opts.rpc)} serves genesis ${g}, not devnet's ${DEVNET_GENESIS}`, 'point --rpc at devnet; nothing else was read'));
      return { results: out, rate: null, rpcLog: c.log };
    }
    out.push(pass('rpc.genesis', '2', `${redactUrl(opts.rpc)}: genesis ${g}${opts.expectGenesis ? ' (loopback test chain, --expect-genesis)' : ' (devnet)'}`));
    const v = await c.call('getVersion');
    out.push(pass('rpc.version', '2', `cluster ${v['solana-core']} (feature-set ${v['feature-set']})`));
    const r0 = await c.call('getMinimumBalanceForRentExemption', [0]);
    const r1k = await c.call('getMinimumBalanceForRentExemption', [1000]);
    rate = r0 / 128;
    const consistent = Number.isInteger(rate) && r1k === rate * 1128;
    if (!consistent) out.push(fail('rpc.rent', '2', `rent(0) ${r0}, rent(1000) ${r1k}: not (128 + len) × rate`, 'the rent model changed: stop, re-read runbook §3/§4'));
    else if (!profile.rent.lamportsPerByteCandidates.includes(rate)) out.push(fail('rpc.rent', '2', `${rate} lamports/byte is not a SIMD-0437 step (${profile.rent.lamportsPerByteCandidates.join(', ')})`, 'stop: the planner, keeper floor and costs assume one of those steps'));
    else if (rate !== profile.rent.assume) out.push(warn('rpc.rent', '2', `${rate} lamports/byte ≠ the profile's ${profile.rent.assume}: totals at ${rate} below`, `fund to the plan.${rate} line; after keeper A starts, check GET /v1/status duties.rent shows ${rate} and usable (#147)`));
    else out.push(pass('rpc.rent', '2', `${rate} lamports/byte = the profile's rent.assume`));
    const acc = await c.call('getMultipleAccounts', [[FEATURES.bls.id, FEATURES.sbpfV2.id, FEATURES.simd0500.id, ...(isAddress(profile.programId) ? [profile.programId] : [])], { encoding: 'base64' }]);
    const vals = acc.value;
    const fbad = [], fok = [];
    Object.values(FEATURES).forEach((f, i) => {
      const s = featureState(vals[i]);
      if (s.active !== f.want) fbad.push(`${f.name} ${s.active ? 'ACTIVE' : 'inactive'} (need ${f.want ? 'active' : 'inactive'})`);
      else fok.push(`${f.name} ${s.active ? `active since slot ${s.slot}` : 'inactive'}`);
    });
    if (fbad.length) out.push(fail('rpc.features', '2', fbad.join('; '), fbad.some(x => x.startsWith('SIMD-0500')) ? 'SIMD-0500 active: this SBPF v2 .so can no longer be deployed (blocked on r0ze: SBPF v3 build)' : 'stop: the deploy cannot work (runbook §3; never --skip-feature-verify)'));
    else out.push(pass('rpc.features', '2', fok.join('; ')));
    if (!isAddress(profile.programId)) out.push(skip('rpc.program', '3', 'programId still a placeholder', 'fill the profile first'));
    else if (vals[3]) out.push(warn('rpc.program', '3', `${profile.programId} already exists (owner ${vals[3].owner}, executable ${vals[3].executable})`, 'a first deploy needs a fresh program keypair; for an upgrade follow runbook §5 (upgrade float)'));
    else out.push(pass('rpc.program', '3', `${profile.programId} is free (first deploy)`));
    if (isAddress(profile.upgradeAuthority)) {
      const b = await c.call('getBalance', [profile.upgradeAuthority]);
      const need = 57.14 * LAMPORTS;
      const have = b.value;
      if (have >= need) out.push(pass('rpc.funds', '5', `authority holds ${solStr(have)} SOL (season start needs 57.14 at 5,080)`));
      else out.push(warn('rpc.funds', '5', `authority holds ${solStr(have)} SOL; season start needs ~57.14`, 'faucet (5 SOL a request) before §6b; the deploy itself needs only the deployer'));
    }
    if (opts.deployerAddress) {
      if (!isAddress(opts.deployerAddress)) out.push(fail('rpc.funds.deployer', '5', `--deployer-address ${opts.deployerAddress} is not an address`, 'solana address -k deployer.json'));
      else {
        const b = await c.call('getBalance', [opts.deployerAddress]);
        // verify-pr181: the deploy peak at the rate just READ (30.03 SOL at 6,960), not always the 5,080 figure.
        const planned = rate && opts.soPath && opts.profilePath && profile.rent.lamportsPerByteCandidates.includes(rate) ? planAt(io, { profilePath: opts.profilePath, soPath: opts.soPath, rate }) : null;
        const atRate = planned && !planned.error ? { need: Number(planned.peak), rate } : { need: 21.93 * LAMPORTS, rate: 5080 };
        const peakText = `deploy peak ${solStr(atRate.need)} at ${atRate.rate.toLocaleString('en-US')}`;
        if (b.value >= atRate.need) out.push(pass('rpc.funds.deployer', '5', `deployer holds ${solStr(b.value)} SOL (${peakText})`));
        else out.push(warn('rpc.funds.deployer', '5', `deployer holds ${solStr(b.value)} SOL; ${peakText}`, 'faucet into the deployer before §8 step 3 (5 SOL a request)'));
      }
    }
  } catch (e) {
    out.push(fail('rpc.error', '2', `${redactUrl(opts.rpc)}: ${String(errText(e)).split(opts.rpc).join(redactUrl(opts.rpc))}`, 'retry later (public devnet: ~10 calls/method/10 s, Retry-After 10)'));
  }
  return { results: out, rate, rpcLog: c.log };
}

// ------------------------------------------------------------------ MUST 7 / 7b: the public endpoint (only with --public-url)

export async function checkEndpoint(io, profile, opts) {
  if (!opts.publicUrl) return [skip('endpoint', '7/7b', 'no --public-url given', 'once the TLS proxy + herald + gateway run: --public-url https://<host> (run it from a machine OUTSIDE the host)')];
  const out = [];
  let base;
  try { base = new URL(opts.publicUrl); } catch { return [fail('endpoint', '7b', `--public-url ${opts.publicUrl} is not a URL`, 'https://<host>')]; }
  const origin = `${base.protocol}//${base.host}`;
  const get = (p, extra = {}) => io.http(`${origin}${p}`, { method: 'GET', ca: opts.ca, timeoutMs: 10_000, ...extra });
  // TLS
  let season = null;
  if (base.protocol !== 'https:') out.push(fail('ep.tls', '7b', `${origin} is not https`, 'TLS ends at the proxy in front of the herald (runbook §8a "TLS"); players need https for the wallet'));
  try {
    const s = await get('/h/season');
    if (base.protocol === 'https:') out.push(pass('ep.tls', '7b', `TLS handshake to ${base.host} verified${opts.ca ? ' (with --ca)' : ''}; /h/season HTTP ${s.status}`));
    if (s.status === 200) { try { season = JSON.parse(s.body); } catch { season = null; } }
    const hsts = s.headers['strict-transport-security'];
    if (base.protocol === 'https:') {
      if (hsts) out.push(pass('ep.hsts', '7b', `Strict-Transport-Security: ${hsts}`));
      else out.push(warn('ep.hsts', '7b', 'no Strict-Transport-Security header', 'add HSTS at the proxy (§8a "TLS": the herald does not send it)'));
    }
    let code = null;
    try { code = JSON.parse(s.body)?.code ?? null; } catch { code = null; }
    if (s.status === 503 && code === 'NoSeasonYet') out.push(warn('ep.season', '7b', '/h/season: the herald answers through the proxy but has no season yet (NoSeasonYet)', 'run again after §6b (CreateSeason) to check the cluster and program id it serves'));
    else if (s.status !== 200 || !season) out.push(fail('ep.season', '7b', `/h/season answered HTTP ${s.status}`, 'the herald behind the proxy is not serving: check the proxy upstream 127.0.0.1:41040, the Host rule (--public-host) and the herald log'));
    else {
      const p = [];
      if (season.cluster !== 'devnet') p.push(`cluster "${season.cluster}" (herald --cluster devnet)`);
      if (isAddress(profile.programId) && season.programId && season.programId !== profile.programId) p.push(`programId ${season.programId} ≠ profile ${profile.programId}`);
      if (p.length) out.push(fail('ep.season', '7b', p.join('; '), 'start the herald with the runbook §8 step 6 flags'));
      else out.push(pass('ep.season', '7b', `/h/season: cluster ${season.cluster}${season.programId ? `, program ${season.programId}` : ''}${season.rulesetHash ? `, ruleset ${String(season.rulesetHash).slice(0, 12)}…` : ''}`));
    }
  } catch (e) {
    out.push(fail(base.protocol === 'https:' ? 'ep.tls' : 'ep.season', '7b', `${origin}/h/season: ${errText(e)}`, base.protocol === 'https:' ? 'a valid certificate for the public name (or --ca FILE for a test CA); proxy listening on 443' : 'start the proxy'));
  }
  // The game page (§8 step 8, §8a "The page's address").
  try {
    const g = await get('/frontier/frontier/');
    const isGame = g.status === 200 && /<html/i.test(g.body) && /frontier/i.test(g.body) && !/\/api\//.test(g.body.slice(0, 4000));
    if (isGame) out.push(pass('ep.game', '7b', `${origin}/frontier/frontier/ HTTP 200 (${g.body.length} B, the game page)`));
    else out.push(fail('ep.game', '7b', `${origin}/frontier/frontier/ HTTP ${g.status}${g.status === 200 ? ' but not the game page' : ''}`, 'herald --web permutation-server/web, proxy /frontier/* to it; players open /frontier/frontier/ (§8a)'));
    const root = await get('/');
    const loc = root.headers.location ?? '';
    if ([301, 302, 307, 308].includes(root.status) && loc.endsWith('/frontier/frontier/')) out.push(pass('ep.root', '7b', `/ → ${loc}`));
    else out.push(warn('ep.root', '7b', `/ answers ${root.status}${loc ? ` → ${loc}` : ''} (the old v9 lobby path, not the game)`, 'let the proxy redirect exactly / and /frontier/ to /frontier/frontier/ (§8a)'));
  } catch (e) {
    out.push(fail('ep.game', '7b', `${origin}/frontier/frontier/: ${errText(e)}`, 'start the proxy and herald'));
  }
  // §8a X-Forwarded-For check: 15 nudges from this machine, each with a forged X-Forwarded-For.
  try {
    const statuses = [];
    for (let i = 0; i < XFF_NUDGES; i++) {
      const forged = i % 2 === 0 ? '127.0.0.1' : `203.0.113.${10 + i}`;
      const res = await io.http(`${origin}/gw/f/nudge`, { method: 'POST', ca: opts.ca, timeoutMs: 10_000, headers: { 'content-type': 'application/json', 'x-forwarded-for': forged }, body: '{}' });
      statuses.push(res.status);
    }
    const first = statuses.slice(0, XFF_BURST), rest = statuses.slice(XFF_BURST);
    const n429 = statuses.filter(s => s === 429).length;
    const summary = statuses.join(' ');
    const odd = [...new Set(statuses.filter(s => s !== 400 && s !== 429))];
    if (odd.length) out.push(fail('ep.xff', '7b', `15 nudges: ${summary} — HTTP ${odd.join(', ')} is neither the gateway's 400 (empty nudge) nor its 429 (limited): the check cannot judge the bucket`, '502/504: the herald could not reach the gateway (herald log "/gw/f/nudge: …"; --relay 127.0.0.1:41033, gateway --public-port 41033) — wait 20 s and run again; 404: the proxy must pass /gw/* to the herald'));
    else if (rest.every(s => s === 429) && first.filter(s => s === 429).length === 0) out.push(pass('ep.xff', '7b', `15 nudges with forged X-Forwarded-For: ${summary} → one bucket (burst ${XFF_BURST}, then 429). Also confirm from a SECOND outside address that it gets its own 400s (a proxy sending no header passes this one-client test too)`));
    else if (n429 === 0) out.push(fail('ep.xff', '7b', `15 nudges: ${summary} — no 429: the client's own X-Forwarded-For reaches the gateway`, 'nginx: proxy_set_header X-Forwarded-For $remote_addr; (NOT $http_x_forwarded_for) / Caddy default / HAProxy http-request set-header X-Forwarded-For %[src] (§8a); gateway with --public-proxy xff'));
    else if (first.some(s => s === 429)) out.push(fail('ep.xff', '7b', `15 nudges: ${summary} — 429 inside the first ${XFF_BURST}: the bucket was not full`, 'wait 20 s (refill 0.5/s) and run again; if it repeats, other clients share this address'));
    else out.push(fail('ep.xff', '7b', `15 nudges: ${summary} — only ${n429} × 429 after the burst`, 'some forged addresses got their own bucket: the proxy appends or passes the client header; set it to the address it saw (§8a)'));
  } catch (e) {
    out.push(fail('ep.xff', '7b', `POST /gw/f/nudge: ${errText(e)}`, 'the proxy must pass /gw/* to the herald, which forwards it to the gateway (--relay 127.0.0.1:41033)'));
  }
  // §8a: ports that must not be reachable from outside.
  if (opts.portsHost !== false) {
    const host = opts.portsHost ?? base.hostname;
    if (LOOPBACK.has(host) && !opts.portsHost) out.push(skip('ep.ports', '7b', `public host is loopback (${host}): closed-port probe not meaningful here`, 'run from outside the host, or pass --ports-host <public name>'));
    else {
      const open = [];
      for (const p of opts.privatePorts ?? PRIVATE_PORTS) if (await io.tcpOpen(host, p)) open.push(p);
      if (open.length) out.push(fail('ep.ports', '7b', `${host}: port(s) ${open.join(', ')} answer`, 'firewall: inbound 443 and 80 only; herald --listen 127.0.0.1:41040 (§8a table)'));
      else out.push(pass('ep.ports', '7b', `${host}: ${(opts.privatePorts ?? PRIVATE_PORTS).join(', ')} closed`));
    }
  }
  return out;
}

// ------------------------------------------------------------------ MUST 7b: service command lines and keeper.toml

/** Shell words of one script (quotes, backslash-newline, comments); commands split on newline, ; and &&. */
export function shellCommands(text) {
  const cmds = [];
  let words = [], cur = null, i = 0, q = null;
  const endWord = () => { if (cur !== null) { words.push(cur); cur = null; } };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < text.length) { cur += text[++i]; }
      else cur += ch;
      i++; continue;
    }
    if (ch === '$' && text[i + 1] === '(') { // $( … ): one word, kept as written
      let depth = 0, j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
      cur = (cur ?? '') + text.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '\\' && text[i + 1] === '\n') { i += 2; continue; }
    if (ch === '\\' && i + 1 < text.length) { cur = (cur ?? '') + text[i + 1]; i += 2; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur = cur ?? ''; i++; continue; }
    if (ch === '#' && cur === null) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '\n' || ch === ';') { endCmd(); i++; continue; }
    if (ch === '&' && text[i + 1] === '&') { endCmd(); i += 2; continue; }
    if (ch === '(' || ch === ')') { endCmd(); i++; continue; }
    if (ch === ' ' || ch === '\t') { endWord(); i++; continue; }
    cur = (cur ?? '') + ch; i++;
  }
  endCmd();
  return cmds;
}

/** {env: [names], prog, flags: Map(name → value | true), positional} of one command. */
export function parseCommand(words, booleanFlags = []) {
  const env = [];
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) env.push(words[k++].split('=')[0]);
  let prog = words[k++];
  const positional = [];
  if (prog && path.basename(prog) === 'node') positional.push(words[k++]);
  const flags = new Map();
  for (; k < words.length; k++) {
    const w = words[k];
    if (!w.startsWith('--')) { positional.push(w); continue; }
    const name = w.slice(2);
    if (booleanFlags.includes(name) || k + 1 >= words.length || words[k + 1].startsWith('--')) flags.set(name, true);
    else flags.set(name, words[++k]);
  }
  return { env, prog, positional, flags };
}

export function findServices(text) {
  const out = {};
  for (const w of shellCommands(text)) {
    const at = w.findIndex(x => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    if (at < 0) continue;
    const prog = w[at] ?? '';
    const next = w[at + 1] ?? '';
    if (prog.endsWith('frontier-herald')) out.herald = parseCommand(w, ['test-key']);
    else if (prog.endsWith('frontier-keeper')) out.keeper = parseCommand(w, ['dev', 'init-seed', 'print-addresses', 'require-existing-journal', 'observe-wide', 'follow-wide']);
    else if (path.basename(prog) === 'node' && next.endsWith('frontier/server.mjs')) out.gateway = parseCommand(w, ['dev', 'agent-wallet', 'agent-runner', 'agent-llm-strict-schema', 'require-existing-state', 'devnet-play', 'devnet-play-offline-rpc']);
  }
  return out;
}

const loopbackHostPort = v => { const m = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(String(v)); return m ? Number(m[2]) : null; };
const loopbackUrl = v => { try { const u = new URL(v); return LOOPBACK.has(u.hostname) ? Number(u.port) : null; } catch { return null; } };
const isPlaceholderValue = v => typeof v !== 'string' || /^<.*>$/.test(v) || v.includes('$');
const rpcValueProblem = v => {
  if (typeof v !== 'string') return 'missing';
  if (v.startsWith('$')) return null; // a shell variable ($RPC): checked on the day by the operator
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:') return 'not https';
    if (HARD_REFUSED_HOSTS.some(p => u.hostname.includes(p))) return `host ${u.hostname} refused (devnet only)`;
    return null;
  } catch { return 'not a URL'; }
};

export function checkHeraldCmd(h, profile) {
  if (!h) return fail('cfg.herald', '7b', 'no frontier-herald command in the services file', 'add the runbook §8 step 6 line');
  const p = [];
  for (const [k, v] of Object.entries(HERALD_FLAGS)) if (h.flags.get(k) !== v) p.push(`--${k} ${h.flags.get(k) ?? '(missing)'} (runbook: ${v})`);
  const listen = h.flags.get('listen') ?? '127.0.0.1:41040';
  if (loopbackHostPort(listen) === null) p.push(`--listen ${listen}: must be loopback (only the proxy is public; the herald checks only the port)`);
  if (!h.flags.get('public-host') || h.flags.get('public-host') === true) p.push('--public-host <the public name> missing (Host / Origin rule, §8a)');
  for (const bad of ['test-key', 'fixture', 'local-play-metadata', 'drand-info']) if (h.flags.has(bad)) p.push(`--${bad} must not be set on devnet`);
  const rp = rpcValueProblem(h.flags.get('rpc'));
  if (rp) p.push(`--rpc ${rp}`);
  const prog = h.flags.get('program');
  if (isPlaceholderValue(prog)) p.push(`--program ${prog ?? '(missing)'}: fill the program id`);
  else if (isAddress(profile.programId) && prog !== profile.programId) p.push(`--program ${prog} ≠ profile ${profile.programId}`);
  if (String(h.flags.get('season')) !== String(profile.operator?.seasonId ?? 1)) p.push(`--season ${h.flags.get('season')} (profile operator.seasonId ${profile.operator?.seasonId})`);
  const web = h.flags.get('web');
  if (typeof web !== 'string' || !/(^|\/)permutation-server\/web\/?$/.test(web)) p.push(`--web ${web ?? '(missing)'}: permutation-server/web and nothing wider (§8a)`);
  if (loopbackHostPort(h.flags.get('relay')) !== 41033) p.push(`--relay ${h.flags.get('relay') ?? '(missing)'} (127.0.0.1:41033, the gateway's public listener)`);
  if (p.length) return fail('cfg.herald', '7b', p.join('; '), 'use the runbook §8 step 6 line as written');
  return pass('cfg.herald', '7b', `--source rpc --cluster devnet --rpc-min-gap-ms 100 --poll-ms 1000, listen ${listen}, public-host ${h.flags.get('public-host')}, relay 127.0.0.1:41033, no test flags (rpc ${h.flags.get('rpc')?.startsWith('$') ? h.flags.get('rpc') : redactUrl(h.flags.get('rpc'))})`);
}

export async function checkGatewayCmd(g, profile, { gatewayConfig } = {}) {
  if (!g) return [fail('cfg.gateway', '7b', 'no `node permutation-gateway/src/frontier/server.mjs` command in the services file', 'add the runbook §8 step 7 line')];
  const p = [];
  if (g.flags.get('public-proxy') !== 'xff') p.push(`--public-proxy ${g.flags.get('public-proxy') ?? '(missing)'} (xff: the TLS proxy sets X-Forwarded-For)`);
  if (g.flags.has('dev')) p.push('--dev must not be set (it lifts the pool-size and proxy rules)');
  if (g.flags.has('devnet-play-offline-rpc')) p.push('--devnet-play-offline-rpc is the TEST form');
  if (g.flags.get('cluster') !== 'devnet') p.push(`--cluster ${g.flags.get('cluster') ?? '(missing: defaults to localnet)'} (devnet)`);
  if (!g.flags.has('devnet-play')) p.push('--devnet-play missing (the wallet-paid page routes)');
  const rh = g.flags.get('devnet-play-ruleset-hash');
  if (!(typeof rh === 'string' && (/^[0-9a-f]{64}$/.test(rh) || rh.startsWith('$')))) p.push(`--devnet-play-ruleset-hash ${rh ?? '(missing)'}: the herald's /h/season rulesetHash (64 hex)`);
  const pool = Number(g.flags.get('pool-size') ?? 150);
  if (!(pool >= 150)) p.push(`--pool-size ${pool} (≥ 150 without --dev)`);
  if (Number(g.flags.get('port') ?? 41030) !== 41030 || Number(g.flags.get('public-port')) !== 41033) p.push(`--port ${g.flags.get('port') ?? 41030} / --public-port ${g.flags.get('public-port') ?? '(missing)'} (41030 / 41033, what the herald's --relay names)`);
  if (loopbackUrl(g.flags.get('herald')) === null) p.push(`--herald ${g.flags.get('herald') ?? '(missing)'} (http://127.0.0.1:41040)`);
  if (loopbackUrl(g.flags.get('keeper')) === null || !g.flags.get('keeper-token-file')) p.push('--keeper http://127.0.0.1:41050 --keeper-token-file keeper-a/keeper.token missing');
  const rp = rpcValueProblem(g.flags.get('rpc'));
  if (rp) p.push(`--rpc ${rp}`);
  const prog = g.flags.get('program');
  if (isPlaceholderValue(prog)) p.push(`--program ${prog ?? '(missing)'}: fill the program id`);
  else if (isAddress(profile.programId) && prog !== profile.programId) p.push(`--program ${prog} ≠ profile ${profile.programId}`);
  if (String(g.flags.get('season')) !== String(profile.operator?.seasonId ?? 1)) p.push(`--season ${g.flags.get('season')} (profile operator.seasonId ${profile.operator?.seasonId})`);
  for (const f of ['master-seed-file', 'invite-secret-file', 'state-file']) if (!g.flags.get(f)) p.push(`--${f} missing (relay/…; §8 step 7)`);
  const out = [];
  // The gateway's own startup check (config.mjs checkFrontierConfig), when its modules are installed.
  if (gatewayConfig) {
    const argv = [];
    for (const [k, v] of g.flags) { argv.push(`--${k}`); if (v !== true) argv.push(String(v).startsWith('$') ? (k === 'devnet-play-ruleset-hash' ? '0'.repeat(64) : 'https://api.devnet.solana.com') : String(v)); }
    try { gatewayConfig(argv); } catch (e) {
      const rpc = String(g.flags.get('rpc') ?? '');
      let m = String(e.message).replace(/^frontier relay config: /, '');
      if (rpc) m = m.split(rpc).join(redactUrl(rpc)); // never print a provider key
      p.push(`the gateway's own config check refuses it: ${m}`);
    }
  }
  if (p.length) out.push(fail('cfg.gateway', '7b', p.join('; '), 'use the runbook §8 step 7 line as written (--public-proxy xff, no --dev)'));
  else out.push(pass('cfg.gateway', '7b', `--public-proxy xff, no --dev, cluster devnet, --devnet-play, pool ${pool}, ports 41030/41033, keeper link${gatewayConfig ? '; config.mjs checkFrontierConfig accepts it' : ' (gateway modules not installed: its own check skipped)'}`));
  if (g.env.length) out.push(pass('cfg.gateway.env', '7b', `environment set by name: ${g.env.join(', ')} (values not shown)`));
  return out;
}

/** keeper.toml's flat TOML subset (frontier-node/crates/keeper/src/config.rs parse_toml), returned as plain values. */
export function parseKeeperToml(text) {
  const out = {};
  text.split('\n').forEach((raw, n) => {
    let line = '', inStr = false;
    for (const ch of raw) { if (ch === '"') inStr = !inStr; if (ch === '#' && !inStr) break; line += ch; }
    line = line.trim();
    if (!line) return;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`line ${n + 1}: expected key = value`);
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error(`line ${n + 1}: bad key ${k}`);
    if (k in out) throw new Error(`line ${n + 1}: ${k} given twice`);
    const val = s => {
      if (s.startsWith('[')) return s.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean).map(val);
      if (s.startsWith('"')) return s.slice(1, -1);
      if (s === 'true' || s === 'false') return s === 'true';
      const num = Number(s.replace(/_/g, ''));
      if (Number.isNaN(num)) throw new Error(`line ${n + 1}: cannot parse ${s}`);
      return num;
    };
    out[k] = val(v);
  });
  return out;
}

export function checkKeeperConfig(io, profile, { keeperConfig, keeperCmd } = {}) {
  const out = [];
  if (keeperCmd?.flags.has('dev')) out.push(fail('cfg.keeper.cmd', '7b', 'frontier-keeper started with --dev', 'drop --dev (runbook §8 step 5)'));
  const file = keeperConfig ?? (typeof keeperCmd?.flags.get('config') === 'string' ? keeperCmd.flags.get('config') : null);
  if (!file) { out.push(skip('cfg.keeper', '7b', 'no keeper.toml given', 'pass --keeper-config keeper-a/keeper.toml (or a services file whose frontier-keeper line names --config)')); return out; }
  const abs = path.isAbsolute(file) ? file : path.join(io.repoRoot, file);
  if (!io.exists(abs)) { out.push(fail('cfg.keeper', '7b', `${file} not found`, 'write keeper-a/keeper.toml from runbook §8 step 5')); return out; }
  let k;
  try { k = parseKeeperToml(io.readFile(abs).toString('utf8')); } catch (e) { out.push(fail('cfg.keeper', '7b', `${file}: ${e.message}`, 'the keeper reads a flat TOML subset (config.rs parse_toml)')); return out; }
  const p = [];
  if (k.rpc_min_gap_ms === undefined) p.push(`rpc_min_gap_ms missing (runbook: ${KEEPER_RPC_MIN_GAP_MS}; the code default is 150)`);
  else if (!(k.rpc_min_gap_ms >= KEEPER_RPC_MIN_GAP_MS)) p.push(`rpc_min_gap_ms ${k.rpc_min_gap_ms} (< ${KEEPER_RPC_MIN_GAP_MS})`);
  if (k.dev === true) p.push('dev = true');
  if (k.feed !== 'rpc') p.push(`feed ${k.feed ?? '(missing)'} (rpc)`);
  if (isPlaceholderValue(k.program)) p.push(`program ${k.program ?? '(missing)'}: fill the program id`);
  else if (isAddress(profile.programId) && k.program !== profile.programId) p.push(`program ${k.program} ≠ profile ${profile.programId}`);
  if (Number(k.season) !== Number(profile.operator?.seasonId ?? 1)) p.push(`season ${k.season} (profile ${profile.operator?.seasonId})`);
  if (!Array.isArray(k.rpc) || !k.rpc.length) p.push('rpc = ["<https devnet RPC>"] missing');
  else for (const u of k.rpc) { const e = rpcValueProblem(u); if (e && !/^<.*>$/.test(u)) p.push(`rpc ${redactUrl(u)}: ${e}`); else if (/^<.*>$/.test(u)) p.push('rpc is still a placeholder'); }
  if (!Array.isArray(k.drand) || !k.drand.every(u => String(u).startsWith('https://'))) p.push('drand must be https URLs (api.drand.sh, drand.cloudflare.com)');
  if (loopbackHostPort(k.api) !== 41050) p.push(`api ${k.api ?? '(missing)'} (127.0.0.1:41050)`);
  const want = profile.services?.keeperA ?? {};
  const roles = Array.isArray(k.roles) ? k.roles : [];
  const miss = (want.roles ?? RUNBOOK_KEEPER_ROLES).filter(x => !roles.includes(x));
  const extra = roles.filter(x => !(want.roles ?? RUNBOOK_KEEPER_ROLES).includes(x));
  if (miss.length || extra.length) p.push(`roles: missing ${miss.join(',') || '-'}; extra ${extra.join(',') || '-'}`);
  for (const [key, v] of Object.entries(RUNBOOK_RINGS_DUTY)) if (k[key] !== (want.ringsDuty?.[key] ?? v)) p.push(`${key} = ${k[key]} (runbook ${v})`);
  if (isPlaceholderValue(k.beneficiary)) p.push('beneficiary is still a placeholder');
  // The keeper's own secrets: stat only, never read.
  for (const key of ['token_file', 'master_seed_file']) {
    if (!k[key]) { p.push(`${key} missing`); continue; }
    // config.rs keeps these as plain PathBufs: a relative path is relative to the keeper's working directory,
    // which runbook §8 step 5 makes the repository root.
    const f = path.isAbsolute(k[key]) ? k[key] : path.join(io.repoRoot, k[key]);
    let st = null;
    try { st = io.stat(f); } catch { st = null; }
    if (!st) p.push(`${key} ${k[key]} not found${f !== k[key] ? ` (looked at ${f}: relative to the repository root, the keeper's working directory)` : ''} (keeper --init-seed / openssl rand; stat only)`);
    else if ((st.mode & 0o077) !== 0) p.push(`${key} ${k[key]} mode ${(st.mode & 0o777).toString(8)} (600)`);
  }
  if (p.length) out.push(fail('cfg.keeper', '7b', p.join('; '), 'use the runbook §8 step 5 keeper.toml as written'));
  else out.push(pass('cfg.keeper', '7b', `rpc_min_gap_ms ${k.rpc_min_gap_ms}, feed rpc, api 127.0.0.1:41050, ${roles.length} roles + rings duty = profile, seed/token mode 600 (stat only)`));
  return out;
}

export async function checkServices(io, profile, opts) {
  if (!opts.services && !opts.keeperConfig) return [skip('cfg', '7b', 'no --services / --keeper-config given', 'pass --services <the script with the herald / gateway / keeper lines> and --keeper-config keeper-a/keeper.toml')];
  const out = [];
  let svc = {};
  if (opts.services) {
    if (!io.exists(opts.services)) return [fail('cfg', '7b', `${opts.services} not found`, 'the shell script or notes file holding the §8 step 5–7 command lines')];
    svc = findServices(io.readFile(opts.services).toString('utf8'));
    out.push(checkHeraldCmd(svc.herald, profile));
    out.push(...await checkGatewayCmd(svc.gateway, profile, { gatewayConfig: opts.gatewayConfig }));
  }
  out.push(...checkKeeperConfig(io, profile, { keeperConfig: opts.keeperConfig, keeperCmd: svc.keeper }));
  return out;
}

// ------------------------------------------------------------------ MUST 8: witness RPC (manual)

export function checkWitness(opts) {
  if (opts.witness) return skip('witness', '8', `--witness ${redactUrl(opts.witness)} noted; its retention cannot be read by a script`, 'confirm with the provider that it keeps the whole season (the free one keeps ~7 days); only for a verifier PASS / the prize');
  return skip('witness', '8', 'only for a verifier PASS / the prize', 'an archival witness RPC that keeps the whole season (runbook §7.0 W1)');
}

// ------------------------------------------------------------------ the whole run

export const USAGE = `node scripts/devnet/preflight.mjs [options]   (read-only: never sends, never reads a key, never spends SOL)
  --profile FILE          default scripts/devnet/devnet-playable-profile.json
  --so FILE               the .so to check (default: the profile's program.so)
  --build                 rebuild first: the profile's build script with --twice (key-free, cargo-build-sbf 3.1.9)
  --expect-sha256 HEX     the approved file_sha256 (default ${EXPECTED_ARTEFACT.sha256.slice(0, 8)}…, or profile program.expectedSha256)
  --expect-program-hash HEX
  --rate N                planner rate (default: the profile's rent.assume, 5080)
  --measured-rate N       also plan at the rate read on devnet (automatic with --rpc)
  --solana4 PATH          the Solana CLI >= 4.0.0 (default ~/solana-4x/bin/solana)
  --solana-build-bin DIR  where cargo-build-sbf 3.1.9 lives (default ~/.local/share/solana/install/active_release/bin)
  --keys-dir DIR          default ~/wylls-devnet-keys (deployer.json, program-playable.json, authority.json)
  --deployer-key F --program-key F --authority-key F
  --services FILE         a script holding the herald / gateway / keeper command lines (runbook §8 steps 5-7)
  --keeper-config FILE    keeper-a/keeper.toml
  --public-url URL        https://<host>: TLS, /h/season, the game page, the §8a X-Forwarded-For check, closed ports
  --ca FILE               a test CA for --public-url (loopback rehearsals)
  --ports-host HOST       probe 41040/41050/41030/41033 on HOST (default: the public URL's host unless loopback)
  --private-ports LIST    the ports --ports-host probes (default 41040,41050,41030,41033)
  --rpc URL               read-only devnet RPC checks (OFF by default; B5): genesis, version, rent, features, program, balance
  --deployer-address ADDR with --rpc: also read the deployer's balance
  --expect-genesis HASH   with a LOOPBACK --rpc only: the test chain's genesis instead of devnet's (rehearsals)
  --witness URL           note the witness RPC (MUST 8; nothing is read)
  --json                  machine-readable output
Exit: 0 no FAIL, 1 at least one FAIL, 2 bad arguments.`;

export function parsePreflightArgs(argv) {
  const o = {};
  const val = (i, f) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${f} needs a value`); return argv[i + 1]; };
  const map = { '--profile': 'profile', '--so': 'so', '--expect-sha256': 'expectSha256', '--expect-program-hash': 'expectProgramHash', '--solana4': 'solana4', '--solana-build-bin': 'solanaBuildBin', '--keys-dir': 'keysDir', '--deployer-key': 'deployerKey', '--program-key': 'programKey', '--authority-key': 'authorityKey', '--services': 'services', '--keeper-config': 'keeperConfig', '--public-url': 'publicUrl', '--ca': 'ca', '--ports-host': 'portsHost', '--rpc': 'rpc', '--deployer-address': 'deployerAddress', '--witness': 'witness', '--expect-genesis': 'expectGenesis', '--node-bin': 'nodeBin' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build') o.build = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--rate' || a === '--measured-rate') { const n = Number(val(i, a)); if (!Number.isInteger(n) || n <= 0) throw new Error(`${a} must be a positive integer`); o[a === '--rate' ? 'rate' : 'measuredRate'] = n; i++; }
    else if (a === '--private-ports') { o.privatePorts = val(i, a).split(',').map(Number); if (!o.privatePorts.every(n => Number.isInteger(n) && n > 0 && n < 65536)) throw new Error('--private-ports: comma-separated ports'); i++; }
    else if (map[a]) { o[map[a]] = val(i, a); i++; }
    else if (['--i-have-r0ze-approval', '--keypair', '--program-keypair', '--upgrade-authority', '--approved-sha256', '--yes-send'].includes(a)) throw new Error(`${a}: the preflight never sends; use scripts/devnet/dry-run.mjs for the deploy (runbook §8 step 3)`);
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** All checks in MUST order. Returns { results, exitCode }. */
export async function preflight(argv, io, extra = {}) {
  let opts;
  try { opts = parsePreflightArgs(argv); } catch (e) { return { error: `${e.message}\n${USAGE}`, exitCode: 2, results: [] }; }
  if (opts.help) return { help: USAGE, exitCode: 0, results: [] };
  Object.assign(opts, extra);
  const profilePath = opts.profile ?? `${io.repoRoot}/scripts/devnet/devnet-playable-profile.json`;
  let profile;
  try { profile = JSON.parse(io.readFile(profilePath).toString('utf8')); } catch (e) { return { error: `profile ${profilePath}: ${e.message}`, exitCode: 2, results: [] }; }
  const results = [];
  results.push(checkPlayLocal());
  results.push(...checkToolchain(io, opts));
  results.push(...checkProfile(profile, { profilePath }));
  results.push(...checkKeyFiles(io, opts));
  const art = checkArtefact(io, profile, opts);
  results.push(...art.results);
  const rpc = await checkRpc(io, profile, { ...opts, profilePath, soPath: art.so ? art.soPath : null });
  results.push(...rpc.results);
  const rates = [{ rate: opts.rate ?? profile.rent.assume, why: opts.rate ? '--rate' : 'profile rent.assume' }];
  const measured = rpc.rate ?? opts.measuredRate;
  if (measured && measured !== rates[0].rate) rates.push({ rate: measured, why: rpc.rate ? 'read with --rpc' : '--measured-rate' });
  results.push(...checkPlanner(io, profile, { profilePath, soPath: art.so ? art.soPath : null, rates }));
  results.push(skip('faucet', '5', 'funding is r0ze\'s (no airdrop here)', 'faucet 5 SOL a request into the deployer (count above) and the authority (57.14 SOL); +1–2 for keeper A'));
  results.push(...await checkEndpoint(io, profile, opts));
  results.push(...await checkServices(io, profile, opts));
  results.push(checkWitness(opts));
  const exitCode = results.some(x => x.status === 'FAIL') ? 1 : 0;
  return { results, exitCode, rpcLog: rpc.rpcLog ?? [] };
}

export function formatResults(results) {
  const L = ['WYLLS devnet deploy preflight (read-only: no transaction, no key read, no SOL)', ''];
  for (const x of results) {
    L.push(`${x.status.padEnd(4)}  [${x.must.padEnd(4)}] ${x.id.padEnd(18)} ${x.detail}`);
    if (x.fix && x.status !== 'PASS') L.push(`${' '.repeat(32)}fix: ${x.fix}`);
  }
  const n = s => results.filter(x => x.status === s).length;
  L.push('', `${n('PASS')} PASS, ${n('FAIL')} FAIL, ${n('WARN')} WARN, ${n('SKIP')} SKIP${n('FAIL') ? '  →  NOT READY' : '  →  no FAIL (SKIP lines are manual or need a flag)'}`);
  return L.join('\n');
}
