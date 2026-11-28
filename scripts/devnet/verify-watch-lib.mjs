// verify-watch-lib.mjs — the pure part of the read-only verifier watch (world3-verifier-watch, item ⑯ "one read-only
// run on a played devnet world"). No process, no network, no key: verify-watch.mjs runs the binaries; health.mjs can
// read the log through watchHealth(). Node 20+.
//
// One cycle (verify-watch.mjs):
//   1. `frontier-verify pull`  — READ-ONLY RPC: archive the signatures after the stored cursor (findex RpcPoll, the
//      verifier's archive format), then the final states (finalized) + Rent + lookup tables → finals.json, then one
//      listing to prove no transaction landed between the archive's last one and the finals' slot (`consistent`).
//      All calls in ONE process through ONE pacer: --rpc-min-gap-ms apart (≤ maxRps), 429/503 → Retry-After back-off.
//   2. `frontier-verify --archive … --finals … --program-so …` — OFFLINE judge of the whole archive (0 RPC calls).
//   3. one line appended to watch.log; exit 1 only on a real mismatch (classify()).

export const DEFAULTS = Object.freeze({
  everyMin: 30,          // minutes between cycles (loop mode)
  maxRps: 1,             // requests per second, the whole watch (one pacer); devnet's public RPC allows ~1/s per method (B5)
  settleTries: 3,        // finals re-reads when a transaction lands at/before the finals' slot
  staleMin: 90,          // health: no line for this long → WARN stale
  raceWarnStreak: 4,     // health: this many inconsistent snapshots in a row → WARN
  errorWarnStreak: 3,    // health: this many failed cycles in a row → WARN
  maxBackoff: 4,         // loop: at most this × everyMin after throttling
  // health: UNVERIFIABLE codes expected over a public RPC without a witness; any OTHER one (e.g. VG/MissingData when an
  // RPC served balances that are not a chain's — verify-pr251 tamper T3) is a WARN, not a silent OK
  unvBaseline: ['V0/HistoryUnproven'],
});

export const DEVNET_HOST = 'api.devnet.solana.com';
/** drand quicknet's public key (fclient::beacon::QUICKNET_PK): the judge's pinned drand key. */
export const QUICKNET_PK = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';
const REFUSED = [/mainnet/i, /(^|\.)api\.solana\.com$/i, /testnet/i];

/** The RPC the watch may read: loopback always; api.devnet only with allowDevnet; nothing else. */
export function checkRpc(url, { allowDevnet = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, why: `not a URL: ${url}` }; }
  const host = u.hostname;
  if (REFUSED.some(r => r.test(host))) return { ok: false, why: `refused host ${host} (mainnet/testnet)` };
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: `scheme ${u.protocol}` };
    return { ok: true, devnet: false };
  }
  if (host === DEVNET_HOST && u.protocol === 'https:') {
    return allowDevnet ? { ok: true, devnet: true } : { ok: false, why: `${host} needs --devnet (the manager's go; read-only)` };
  }
  return { ok: false, why: `host ${host} is neither loopback nor ${DEVNET_HOST}` };
}

/** The pacer gap for a request-rate cap (ms between two calls of the one process). */
export function gapMsFor(maxRps) {
  const r = Number(maxRps);
  if (!(r > 0) || r > 10) throw new Error(`--max-rps ${maxRps}: 0 < rps ≤ 10`);
  return Math.ceil(1000 / r);
}

/** frontier-verify's report.json → counts per severity and the FAIL / UNVERIFIABLE codes ("check/code×n"). */
export function summarizeReport(rep) {
  const out = { verdict: rep?.verdict ?? null, fail: 0, unverifiable: 0, failCodes: {}, unvCodes: {} };
  for (const f of rep?.findings ?? []) {
    const sev = String(f.severity ?? '').toUpperCase();
    const code = `${f.check ?? '?'}/${f.code ?? '?'}`;
    if (sev === 'FAIL') { out.fail++; out.failCodes[code] = (out.failCodes[code] ?? 0) + 1; }
    else if (sev === 'UNVERIFIABLE') { out.unverifiable++; out.unvCodes[code] = (out.unvCodes[code] ?? 0) + 1; }
  }
  return out;
}

/**
 * The judge's build features the watch needs (verify-bin-rebuild): world 3 runs program version 0x4804, which only a
 * frontier-verify built with `--features verify/playable-lane` implements (VG/VX/VL/VWL/VW1). A default build reports
 * V0/UnknownProgramVersion and, with no VG, thousands of FAIL findings that are the verifier's, not the chain's
 * (watch-fail-investigate, 2026-11-28: 74f60922 → FAIL ×7986).
 */
export const REQUIRED_FEATURES = Object.freeze(['playable-lane']);

/**
 * `frontier-verify features` → may the watch use this binary as its judge? The probe prints one JSON line
 * `{"bin":"frontier-verify","version":…,"features":[…],"mutated":null|"mutate-…"}`; a binary older than the probe
 * exits 2 with "unknown argument features" and is refused too (its features cannot be known).
 */
export function checkVerifierFeatures({ code, stdout, stderr } = {}, required = REQUIRED_FEATURES) {
  const rebuild = `rebuild with \`cargo build --release --locked -p verify --features ${required.map(f => `verify/${f}`).join(',')} --bin frontier-verify\``;
  let p = null;
  try { p = JSON.parse(String(stdout ?? '').trim().split('\n').pop()); } catch { /* not the probe */ }
  if (code !== 0 || !p || !Array.isArray(p.features)) {
    const said = String(stderr ?? stdout ?? '').trim().split('\n')[0]?.slice(0, 160) ?? '';
    return { ok: false, why: `the verify binary does not report its build features (\`features\` probe exit ${code}${said ? `: ${said}` : ''}); it predates the probe or is not frontier-verify — ${rebuild}` };
  }
  if (p.mutated) return { ok: false, why: `the verify binary is a MUTATED build (${p.mutated}): a check is disabled — ${rebuild}` };
  const missing = required.filter(f => !p.features.includes(f));
  if (missing.length) return { ok: false, why: `the verify binary was built without ${missing.join(', ')} (it reports [${p.features.join(', ')}]): it cannot judge the playable lane (0x4804 → UnknownProgramVersion, every VG/VX/VL/VWL check missing) — ${rebuild}` };
  return { ok: true, features: p.features, version: p.version ?? null };
}

const codes = m => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(',');

/**
 * One cycle's outcome. Only a FAIL finding on a CONSISTENT archive/finals pair judged with the pinned program is a
 * real mismatch (exit 1) — the finding, not the verdict: a public-RPC history is never proven, so frontier-verify's
 * history rule (history.rs apply_with) turns a FAIL verdict into UNVERIFIABLE unless the fail is self-contained or a
 * witness agreed. Everything else exits 0 and is logged with its level:
 *   PASS / UNVERIFIABLE — the verifier's verdict, no FAIL finding (UNVERIFIABLE is normal over a public RPC);
 *   RACE    — the verifier FAILed but a transaction landed at/before the finals' slot (finals ahead of the archive);
 *   REPIN   — the deployed program is not the pinned .so: not judged (re-pin after a sanctioned upgrade);
 *   ERROR   — the pull or the judge could not run (RPC down, 429 storm, binary missing), or the judge reported
 *             V0/UnknownProgramVersion (a misbuilt judge, e.g. without the playable-lane feature): nothing judged.
 */
export function classify({ pull, verify, pinnedSha256 = null }) {
  if (!pull || pull.ok === false) return { level: 'ERROR', exit: 0, why: `pull: ${pull?.error ?? 'no summary'}` };
  const deployed = pull.program_hash?.sha256 ?? null;
  if (pinnedSha256 && deployed && deployed !== pinnedSha256) {
    return { level: 'REPIN', exit: 0, why: `deployed program sha256 ${deployed.slice(0, 12)}… ≠ pinned ${pinnedSha256.slice(0, 12)}…` };
  }
  if (!verify) return { level: 'ERROR', exit: 0, why: 'judge did not run' };
  if (verify.code !== 0 && verify.code !== 1 && verify.code !== 2) return { level: 'ERROR', exit: 0, why: `judge exit ${verify.code}` };
  const s = verify.summary ?? summarizeReport(null);
  // The judge does not implement the program's version: its FAIL findings are the verifier's gap, not the chain's
  // (watch-fail-investigate D-2). Nothing was judged.
  if (s.unvCodes['V0/UnknownProgramVersion']) return { level: 'ERROR', exit: 0, why: `misbuilt judge: V0/UnknownProgramVersion (the verify binary lacks the program's lane; ${s.fail} FAIL findings not counted)` };
  if (verify.code === 1 || s.verdict === 'FAIL' || s.fail > 0) {
    if (pull.finals && pull.finals.consistent === false) return { level: 'RACE', exit: 0, why: `FAIL on an inconsistent snapshot (${codes(s.failCodes)})` };
    return { level: 'FAIL', exit: 1, why: codes(s.failCodes) || 'verdict FAIL' };
  }
  if (verify.code === 2 && !verify.report) return { level: 'ERROR', exit: 0, why: `judge refused: ${String(verify.stderr ?? '').trim().split('\n')[0]?.slice(0, 200) ?? ''}` };
  return { level: verify.code === 0 ? 'PASS' : 'UNVERIFIABLE', exit: 0, why: verify.code === 0 ? '' : `${s.unverifiable} unverifiable` };
}

/** The one log line of a cycle (tab-free, stable key=value order; health.mjs reads `level` = 2nd field). */
export function logLine({ at, level, why, pull, verify, reportDir }) {
  const f = pull?.finals ?? {};
  const s = verify?.summary;
  const parts = [
    new Date(at).toISOString(),
    level,
    `seq=${pull?.seq_before ?? '?'}->${pull?.seq ?? '?'}`,
    `new=${pull?.archived ?? '?'}`,
    `last_slot=${pull?.last_slot ?? '-'}`,
    `final_slot=${f.final_slot ?? '-'}`,
    `consistent=${f.consistent ?? '-'}`,
    `tries=${f.tries ?? '-'}`,
    `req=${pull?.requests ?? '?'}`,
    `throttled=${pull?.throttled ?? '?'}`,
    `pull_s=${pull?.seconds != null ? pull.seconds.toFixed(1) : '?'}`,
    `judge_s=${verify?.seconds != null ? verify.seconds.toFixed(1) : '-'}`,
    `verdict=${s?.verdict ?? '-'}`,
    `fail=${s?.fail ?? '-'}`,
    `unv=${s?.unverifiable ?? '-'}`,
  ];
  if (s && s.fail) parts.push(`fail_codes=${codes(s.failCodes)}`);
  if (s && s.unverifiable) parts.push(`unv_codes=${codes(s.unvCodes)}`);
  if (reportDir) parts.push(`report=${reportDir}`);
  if (why) parts.push(`why=${String(why).replace(/\s+/g, ' ').slice(0, 300)}`);
  return parts.join(' ');
}

export function parseLine(line) {
  const m = /^(\S+) (PASS|UNVERIFIABLE|FAIL|RACE|REPIN|ERROR)\b/.exec(line ?? '');
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? { at: t, level: m[2], line } : null;
}

/**
 * The health line for the watch log (proposed `verify.watch` check of health.mjs):
 *   FAIL  — the last judged cycle was FAIL (a real mismatch; it stays FAIL until a later PASS/UNVERIFIABLE);
 *   WARN  — no line for staleMin (stale), or a REPIN, or errorWarnStreak ERRORs / raceWarnStreak RACEs in a row, or
 *           the last judged cycle had an UNVERIFIABLE code outside unvBaseline (its `unv_codes=`);
 *   OK    — otherwise (PASS or UNVERIFIABLE last).
 */
export function watchHealth(text, nowMs, o = {}) {
  const staleMin = o.staleMin ?? DEFAULTS.staleMin;
  const lines = String(text ?? '').split('\n').map(parseLine).filter(Boolean);
  const key = 'verify.watch';
  if (!lines.length) return { level: o.expected ? 'WARN' : 'OK', key, detail: o.expected ? 'no watch line yet' : 'watch not started' };
  const last = lines[lines.length - 1];
  const ageMin = (nowMs - last.at) / 60000;
  const judged = [...lines].reverse().find(l => ['PASS', 'UNVERIFIABLE', 'FAIL'].includes(l.level));
  let streak = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i].level === last.level; i--) streak++;
  const brief = l => l.line.slice(l.line.indexOf(' ') + 1, 220);
  if (judged?.level === 'FAIL') return { level: 'FAIL', key, detail: `mismatch: ${brief(judged)}` };
  if (ageMin > staleMin) return { level: 'WARN', key, detail: `stale: last line ${Math.round(ageMin)} min ago (> ${staleMin}): ${brief(last)}` };
  const unvExtra = judged?.level === 'UNVERIFIABLE'
    ? (/ unv_codes=(\S+)/.exec(judged.line)?.[1] ?? '').split(',').map(c => c.replace(/×\d+$/, '')).filter(c => c && !(o.unvBaseline ?? DEFAULTS.unvBaseline).includes(c))
    : [];
  if (unvExtra.length) return { level: 'WARN', key, detail: `unverifiable beyond the public-RPC baseline (${unvExtra.join(',')}): ${brief(judged)}` };
  if (last.level === 'REPIN') return { level: 'WARN', key, detail: `program changed, not judged: ${brief(last)}` };
  if (last.level === 'ERROR' && streak >= (o.errorWarnStreak ?? DEFAULTS.errorWarnStreak)) return { level: 'WARN', key, detail: `${streak} failed cycles in a row: ${brief(last)}` };
  if (last.level === 'RACE' && streak >= (o.raceWarnStreak ?? DEFAULTS.raceWarnStreak)) return { level: 'WARN', key, detail: `${streak} inconsistent snapshots in a row (busy world): ${brief(last)}` };
  return { level: 'OK', key, detail: `${Math.round(ageMin)} min ago: ${brief(last)}` };
}

/** Next sleep in loop mode: back off ×2 per throttled cycle (≤ maxBackoff ×), back to 1× after a clean one. */
export function nextDelayMin(prevFactor, pull, o = {}) {
  const max = o.maxBackoff ?? DEFAULTS.maxBackoff;
  const throttled = !pull || pull.ok === false || (pull.throttled ?? 0) > 0;
  const factor = throttled ? Math.min(max, Math.max(1, prevFactor) * 2) : 1;
  return { factor, minutes: (o.everyMin ?? DEFAULTS.everyMin) * factor };
}

/**
 * Expected RPC requests of one cycle (frontier-verify pull, src/pull.rs), every call through the one pacer:
 *   archive: ceil(newTx / page) signature pages + 1 continuity page + newTx getTransaction + 1 per new lookup table
 *   balances: newTx getTransaction (pre/post balances, once per transaction; VG needs them)
 *   per finals try: 1 getProgramAccounts + ceil(accounts / 100) getMultipleAccounts + 1 late-signature listing
 *   once: 1 Rent + ceil(tables / 100) lookup tables + 2 program hash (program account, ProgramData)
 * Returns { newTx, perCycle, perHour, seconds } for a cycle every `everyMin` at `maxRps`.
 */
export function expectedLoad({ txPerHour, accounts, everyMin = DEFAULTS.everyMin, page = 1000, tables = 0, settleExtra = 0, maxRps = DEFAULTS.maxRps }) {
  const newTx = Math.ceil(txPerHour * everyMin / 60);
  const archive = Math.ceil(newTx / page) + 1 + 2 * newTx + tables;
  const perTry = 1 + Math.ceil(accounts / 100) + 1;
  const once = 1 + Math.ceil(tables / 100) + 2;
  const perCycle = archive + perTry * (1 + settleExtra) + once;
  return { newTx, perCycle, perHour: Math.round(perCycle * 60 / everyMin), seconds: Math.ceil(perCycle / maxRps) };
}
