// The A/B harness (contract 9.3; unit AC9). Local test chain only. Nothing here changes a result: it plans the runs, reads what
// the two arms left, decides whether a pair is valid by the PRE-REGISTERED rules, evaluates the pass rule, and writes the table.
//
//   node citizens/ab/run-ab.mjs plan      --rep N                      the commands of both arms, nothing started
//   node citizens/ab/run-ab.mjs run       --arm A|B --rep N [--dry]    one arm through citizens/bin/ai-citizens-run.sh (arm B behind the replay proxy)
//   node citizens/ab/run-ab.mjs threshold --ready K [--followers N] [--append-runs RUNS.md]   T = min(3, K), never below 2 (from the pilot); N = bots that can follow
//   node citizens/ab/run-ab.mjs analyze   --rep N --a DIR --b DIR [--t T] [--out F]   one pair
//   node citizens/ab/run-ab.mjs result    --pairs F1,F2,F3 [--t T] [--runs RUNS.md] [--out AB-RESULT.md] [--json F]
//
// The experiment (9.3): two arms of the same rep (same bot seed, deck-2, ab.json, same llama flags) differ only in the seat's
// ballot in the first period in which an AI of nation 0 moved an option X: arm A ballots X, arm B ballots none. The seat's ballot
// is scripted by the operator (origin 2). Arm B replays arm A's AI council answers (replay.mjs) so the AIs' council inputs are
// equal by construction.
//
// PAIR VALIDITY (pre-registered, relaxed in the contract review): the pair counts only if
//   (a) both arms have the same options_hash for the period (kind and target of the three options; the full candidates_hash
//       also covers values and ratios that depend on script-bot timing, so it is REPORTED, not required), the same AI motion
//       option and the same AI ballot options for that period (compared after the open; text hashes are not compared), and
//   (b) in arm B the tally does not adopt X (the seat is pivotal).
// PASS (for 2 valid pairs of reps 1 to 3, stop at 2): arm A has Call = X, >= T hosts of nation 0 present at X at S, and the CLASH
// at X at S has >= 1 engagement with enemy troops lost > 0; arm B has no Call X, 0 hosts of nation 0 arrive at X at S, and no CLASH
// at X at S involving nation 0. PRE-REGISTERED REDUCED CLAIM: if only 1 valid pair is reached in 3 reps, "1 valid pair" is claimed
// and the others are reported. Every rep is reported, valid or not.
//
// What the A/B shows (9.2): "a Strike Order adopted with an operator-scripted seat ballot", nation 0 only. Not "humans and AI
// decide together". The word "human" is never used for the seat's scripted ballot.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBallot, fromBase64, toBase58 } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { parseRuns } from '../report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

export const T_MIN = 2;
export const T_MAX = 3;
export const NATION = 0;
/** T = min(3, the number of invited hosts the pilot saw ready at C0 + 6), never below 2 (9.3). */
export const computeT = (readyInvited) => Math.max(T_MIN, Math.min(T_MAX, Number.isFinite(readyInvited) ? Math.floor(readyInvited) : 0));

const num = (x) => (Array.isArray(x) ? x.length : Number.isFinite(x) ? x : null);

// ---------------------------------------------------------------- reading one arm
/** The council file of nation 0 for `period` (or the first period with an AI motion when none is given). */
function periodFile(pub, period, aiWallets) {
  const dir = path.join(pub, 'council');
  const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((f) => /^(\d+)-(\d+)\.json$/.exec(f)).filter((m) => m && Number(m[2]) === NATION).map((m) => ({ k: Number(m[1]), f: m[0] })).sort((a, b) => a.k - b.k);
  const all = files.map(({ f }) => readJson(path.join(dir, f))).filter(Boolean);
  if (period != null) return all.find((j) => j.period === period) ?? null;
  return all.find((j) => (j.motions ?? []).some((m) => aiWallets.has(m.wallet))) ?? null;
}

/** Everything one arm left that the pair rules read. `aiDir` is AI_DIR (pub/ inside), `arm` A or B, `rep` the rep number. */
export function readArm({ aiDir, arm, rep }) {
  const pub = path.join(aiDir, 'pub');
  const roster = readJson(path.join(pub, 'roster.json'));
  const seat = readJson(path.join(aiDir, 'ab', `seat-${arm}-${rep}.json`));
  const replay = readJson(path.join(aiDir, 'ab', `replay-${arm}-${rep}.json`));
  const ai = (roster?.ai ?? []).filter((a) => a.faction === NATION);
  const aiWallets = new Set(ai.map((a) => a.wallet));
  const nameOf = new Map((roster?.ai ?? []).map((a) => [a.wallet, a.name?.en ?? null]));
  const errors = [];
  const P = periodFile(pub, seat?.period ?? null, aiWallets);
  if (!P) errors.push(seat?.period != null ? `no council file for nation 0 period ${seat.period}` : 'no council file of nation 0 with an AI motion');
  const motions = (P?.motions ?? []).filter((m) => aiWallets.has(m.wallet)).map((m) => ({ wallet: m.wallet, name: nameOf.get(m.wallet) ?? null, option: m.option, text: m.text ?? '' })).sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const ballots = [];
  for (const b of P?.open?.ballots ?? []) {
    if (!b.bytes_b64) continue;
    try {
      const d = decodeBallot(fromBase64(b.bytes_b64));
      ballots.push({ wallet: toBase58(d.wallet), option: d.option, origin: d.origin });
    } catch { errors.push('an opened ballot does not decode'); }
  }
  const aiBallots = ballots.filter((b) => aiWallets.has(b.wallet)).map((b) => ({ ...b, name: nameOf.get(b.wallet) ?? null })).sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const seatBallot = ballots.find((b) => b.origin === 2) ?? null;
  const optionX = seat?.option_x ?? null;
  const adopted = Boolean(P?.adopted);
  const callOption = adopted ? (P?.open?.option ?? null) : null;
  const res = P?.result ?? null;
  const obs = seat?.observed ?? null;
  // the measures of the pass rule: the seat's herald observation when it has a clash report, else the council file's own result
  let measures = null;
  if (obs?.clash_report) measures = { source: 'seat observation (herald clash report)', present: obs.present, bounced: obs.bounced, engagements: obs.engagements, enemy_lost: obs.enemy_lost, own_lost: obs.own_lost, nation0_involved: obs.nation0_involved };
  else if (res) {
    const c = res.clash ?? {};
    const lostBy = c.lost_by_nation ?? c.lost ?? c.troops_lost ?? null;
    // enemy troops lost = the other nations' fighters' losses plus, for a camp target, the camp's own loss (the report lists hosts only, calls.mjs campLoss)
    const enemyHosts = c.enemy_lost ?? (lostBy && typeof lostBy === 'object' ? Object.entries(lostBy).filter(([n]) => Number(n) !== NATION).reduce((s, [, v]) => s + (Number(v) || 0), 0) : null);
    const enemy = enemyHosts == null && c.camp_lost == null ? null : (enemyHosts ?? 0) + (Number(c.camp_lost) || 0);
    const own = c.own_lost ?? (lostBy && typeof lostBy === 'object' ? Number(lostBy[NATION] ?? lostBy[String(NATION)] ?? 0) : null);
    measures = { source: 'council file result (watcher)', present: num(res.present), bounced: num(res.bounced), engagements: num(c.engagements), enemy_lost: enemy, own_lost: own, nation0_involved: (num(res.present) ?? 0) > 0 || (own ?? 0) > 0 };
  } else if (obs) measures = { source: 'seat observation without a clash report (no clash record at X at S)', present: obs.present ?? 0, bounced: obs.bounced ?? 0, engagements: 0, enemy_lost: 0, own_lost: 0, nation0_involved: Boolean(obs.nation0_involved) };
  return {
    arm, rep, run_id: path.basename(aiDir),
    period: P?.period ?? null, c0: P?.c0 ?? seat?.c0 ?? null, strike_bell: P?.strike_bell ?? seat?.observed?.s ?? null,
    option_x: optionX, options_hash: P?.options_hash ?? null, candidates_hash: P?.candidates_hash ?? null,
    ai_motions: motions, ai_ballots: aiBallots, seat_ballot: seatBallot ? { option: seatBallot.option, origin: seatBallot.origin, from: 'opened ballot bytes' } : (seat?.ballot ? { option: seat.ballot.option, origin: seat.ballot.origin, from: 'seat log (not yet opened)', ok: seat.ballot.ok } : null),
    seat_ballot_ok: seat?.ballot?.ok ?? null,
    adopted, reason: P?.reason ?? null, call_option: callOption, tally: P?.open?.tally ?? null, tally_split: P?.tally_split ?? null,
    option_values: (P?.candidates ?? P?.options ?? []).map((o) => ({ option: o.option, kind: o.kind, p: o.p, q: o.q })),
    measures, replay: replay ? { council_replayed: replay.council_replayed ?? 0, miss: replay.miss?.length ?? 0, passed_through: replay.passed_through ?? null } : null,
    motions_equal_top_option: motions.map((m) => m.option === 1),
    errors,
  };
}

// ---------------------------------------------------------------- the pair rules
const sameList = (a, b, f) => JSON.stringify(a.map(f)) === JSON.stringify(b.map(f));

export function pairValidity(a, b) {
  const x = a.option_x;
  const checks = {
    a_arm_a_has_period: Boolean(a.period != null && a.options_hash),
    a_arm_b_has_period: Boolean(b.period != null && b.options_hash),
    a_same_period: a.period != null && a.period === b.period,
    a_options_hash_equal: Boolean(a.options_hash && a.options_hash === b.options_hash),
    a_same_ai_motion_option: a.ai_motions.length > 0 && sameList(a.ai_motions, b.ai_motions, (m) => [m.wallet, m.option]),
    a_same_ai_ballot_options: a.ai_ballots.length > 0 && sameList(a.ai_ballots, b.ai_ballots, (m) => [m.wallet, m.option]),
    b_seat_pivotal_x_not_adopted_in_b: x != null && !(b.adopted && b.call_option === x),
    seat_ballots_cast_as_designed: a.seat_ballot_ok === true && b.seat_ballot_ok === true && a.seat_ballot?.option === x && b.seat_ballot?.option === 0,
  };
  const reasons = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  return { valid: reasons.length === 0, checks, reasons, candidates_hash_equal: Boolean(a.candidates_hash && a.candidates_hash === b.candidates_hash), candidates_hash_note: 'reported, not required (values and ratios depend on script-bot timing)' };
}

export function armAPass(a, T) {
  const m = a.measures;
  const checks = {
    call_is_x: a.adopted && a.call_option === a.option_x,
    hosts_present_at_least_T: m != null && m.present != null && m.present >= T,
    clash_with_engagement_and_enemy_loss: m != null && (m.engagements ?? 0) >= 1 && (m.enemy_lost ?? 0) > 0,
  };
  return { pass: Object.values(checks).every(Boolean), checks, T };
}
export function armBPass(b, x) {
  const m = b.measures;
  const checks = {
    no_call_x: !(b.adopted && b.call_option === x),
    zero_hosts_of_nation_0_arrive_at_x: m != null && m.present === 0,
    no_clash_at_x_involving_nation_0: m != null && m.nation0_involved === false,
  };
  const notObserved = m == null;
  return { pass: !notObserved && Object.values(checks).every(Boolean), checks, not_observed: notObserved };
}

export function evaluatePair(a, b, T) {
  const validity = pairValidity(a, b);
  const A = armAPass(a, T);
  const B = armBPass(b, a.option_x);
  return {
    rep: a.rep, T, valid: validity.valid, validity, arm_a: { ...A, measures: a.measures, call_option: a.call_option, adopted: a.adopted, seat_ballot: a.seat_ballot }, arm_b: { ...B, measures: b.measures, call_option: b.call_option, adopted: b.adopted, seat_ballot: b.seat_ballot },
    pass: validity.valid && A.pass && B.pass,
    option_x: a.option_x, period: a.period, options_hash: a.options_hash,
    council_replayed: b.replay?.council_replayed ?? null, replay_misses: b.replay?.miss ?? null,
    ai_motion_options: a.ai_motions.map((m) => ({ name: m.name, option: m.option })),
    motions_equal_top_option: [...a.motions_equal_top_option, ...b.motions_equal_top_option],
  };
}

/** The claim over the pairs of the reps run so far (reps in order; at most 3 reps, stop at 2 valid pairs). */
export function abOutcome(pairs) {
  const ordered = [...pairs].sort((x, y) => x.rep - y.rep);
  const valid = ordered.filter((p) => p.valid);
  const used = valid.slice(0, 2);
  const passing = used.filter((p) => p.pass);
  let claim;
  if (used.length === 2 && passing.length === 2) claim = { kind: 'pass', text: 'G7 met: 2 valid pairs, both passed (a Strike Order adopted with an operator-scripted seat ballot, nation 0 only)' };
  else if (used.length === 2) claim = { kind: 'fail', text: `G7 not met: 2 valid pairs, ${passing.length} passed` };
  else if (ordered.length >= 3 && used.length === 1) claim = passing.length === 1 ? { kind: 'reduced', text: 'pre-registered reduced claim: 1 valid pair in 3 reps, and it passed; the other reps are reported below' } : { kind: 'fail', text: 'G7 not met: 1 valid pair in 3 reps and it did not pass' };
  else if (ordered.length >= 3) claim = { kind: 'fail', text: 'G7 not met: no valid pair in 3 reps' };
  else claim = { kind: 'incomplete', text: `not decided: ${used.length} valid pair(s) after ${ordered.length} rep(s)` };
  return { reps_reported: ordered.length, valid_pairs: valid.length, pairs_used: used.map((p) => p.rep), passed: passing.map((p) => p.rep), claim };
}

export function renderAbResult({ pairs, T, outcome, runs = null }) {
  const L = [];
  const row = (...c) => `| ${c.join(' | ')} |`;
  const yn = (x) => (x ? 'yes' : 'no');
  L.push('# A/B result: the seat\'s scripted ballot and the Strike Order', '', 'Local test chain only (no public network). Nation 0 only. The seat\'s ballot is scripted by the operator (origin 2): this shows a Strike Order adopted with an operator-scripted seat ballot, not that humans and AI citizens decide together.', '');
  L.push(`Threshold T = ${T} hosts of nation 0 present at X at S (T = min(3, the ready invited hosts the pilot saw), never below 2). ${outcome.claim.text}.`, '');
  L.push(`Reps reported: ${outcome.reps_reported}; valid pairs: ${outcome.valid_pairs}; pairs used for the claim: ${JSON.stringify(outcome.pairs_used)}; passed: ${JSON.stringify(outcome.passed)}. n is tiny: this is a pre-registered two-arm demonstration, not a rate.`, '');
  L.push(row('rep', 'valid', 'why not valid', 'pass', 'X', 'arm A: Call, present, engagements, enemy lost', 'arm B: Call, present, nation 0 in clash', 'council replayed'), row('---', '---', '---', '---', '---', '---', '---', '---'));
  for (const p of [...pairs].sort((a, b) => a.rep - b.rep)) {
    const A = p.arm_a;
    const B = p.arm_b;
    const am = A.measures ?? {};
    const bm = B.measures ?? {};
    L.push(row(p.rep, yn(p.valid), p.validity.reasons.join(', ') || '-', yn(p.pass), p.option_x ?? 'n/a', `${A.adopted ? `Call option ${A.call_option}` : 'no Call'}, ${am.present ?? 'n/a'}, ${am.engagements ?? 'n/a'}, ${am.enemy_lost ?? 'n/a'}`, `${B.adopted ? `Call option ${B.call_option}` : 'no Call'}, ${bm.present ?? 'n/a'}, ${bm.nation0_involved == null ? 'n/a' : yn(bm.nation0_involved)}`, p.council_replayed ?? 'n/a'));
  }
  L.push('', '## Pair validity checks (pre-registered)', '');
  for (const p of [...pairs].sort((a, b) => a.rep - b.rep)) L.push(`- rep ${p.rep}: ${Object.entries(p.validity.checks).map(([k, v]) => `${k}=${v}`).join(', ')}; candidates_hash equal (reported only): ${p.validity.candidates_hash_equal}`);
  L.push('', '## Disclosures', '', '- Arm B replays arm A\'s AI council answers (option and speech) through a loopback proxy in front of llama-server, so the AIs\' council inputs are equal by construction; the replayed jobs are counted above (`council replayed`). A replayed record is an arm B record whose request was not sent to the model: it is not an audit claim.',
    '- The arm B citizens config differs from arm A\'s by `replay_council_from` and the proxy URL: its sha256 differs.',
    '- Memory differs between arms in ways the run does not control (episodes derive from public records that may differ between two runs): reported, not claimed equal.',
    '- Whether each AI motion equals the code\'s top-scored option (option 1): ' + `${pairs.flatMap((p) => p.motions_equal_top_option).filter(Boolean).length} of ${pairs.flatMap((p) => p.motions_equal_top_option).length} motions over the reps reported.`,
    '- The measures are read from the herald\'s public clash report through the seat script, or from the council file\'s result when the watcher wrote one; `nation 0` fighters whose owner the feed could not resolve are counted in `unknown_owner_fighters` of the seat log.');
  if (runs?.length) {
    L.push('', '## Every run in RUNS.md', '', row('run', 'arm', 'rep', 'status', 'detail'), row('---', '---', '---', '---', '---'));
    for (const r of runs) L.push(row(r.run_id, r.arm ?? '-', r.rep ?? '-', r.status, r.detail ?? '-'));
  }
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- planning and running
export function armPlan({ arm, rep, repoRoot, stack = null, config = null, shimPort = 41990, llamaUrl = 'http://127.0.0.1:41901' }) {
  const stackF = stack ?? path.join(repoRoot, 'permutation-gateway/citizens/stack/ai-ab.toml');
  const base = config ?? path.join(repoRoot, 'permutation-gateway/citizens/config/ab.json');
  const runId = `ai-ab-${arm}-${rep}`;
  const cfgB = path.join(repoRoot, '.local/frontier/ai/ab-config', `ab-B-${rep}.json`);
  // --seat-script names the seat script (ab/seat.mjs) in the commitments: seat_script_sha256 is then its sha256 and the roster marks the seat `scripted: true`
  const run = ['bash', path.join(repoRoot, 'permutation-gateway/citizens/bin/ai-citizens-run.sh'), '--stack', stackF, '--citizens-config', arm === 'B' ? cfgB : base, '--ab', arm, '--rep', String(rep), '--seat-script', path.join(repoRoot, 'permutation-gateway/citizens/ab/seat.mjs')];
  return {
    arm, rep, run_id: runId, ai_dir: path.join(repoRoot, '.local/frontier/ai', runId),
    steps: arm === 'B'
      ? [`write ${cfgB} (ab.json + replay_council_from ${path.join(repoRoot, '.local/frontier/ai', `ai-ab-A-${rep}`, 'pub')} + llm.url http://127.0.0.1:${shimPort})`, `start the replay proxy on ${shimPort} in front of ${llamaUrl}`, run.join(' '), 'stop the replay proxy']
      : [run.join(' ')],
    run, config_b: arm === 'B' ? cfgB : null, shim_port: shimPort,
  };
}

async function runArm({ arm, rep, repoRoot, dry, shimPort = 41990 }) {
  const plan = armPlan({ arm, rep, repoRoot, shimPort });
  if (dry) return { dry: true, ...plan };
  let proxy = null;
  if (arm === 'B') {
    const { createReplayProxy, makeArmBConfig } = await import('./replay.mjs');
    const armAPub = path.join(repoRoot, '.local/frontier/ai', `ai-ab-A-${rep}`, 'pub');
    if (!fs.existsSync(path.join(armAPub, 'roster.json'))) throw new Error(`arm B needs arm A's PUB first: ${armAPub} has no roster.json`);
    makeArmBConfig({ baseConfigPath: path.join(repoRoot, 'permutation-gateway/citizens/config/ab.json'), armAPub, shimUrl: `http://127.0.0.1:${shimPort}`, outPath: plan.config_b });
    proxy = createReplayProxy({ from: armAPub, upstream: 'http://127.0.0.1:41901', log: path.join(plan.ai_dir, 'ab', `replay-B-${rep}.json`) });
    await proxy.listen(shimPort);
  }
  try {
    const code = await new Promise((resolve) => {
      const child = spawn(plan.run[0], plan.run.slice(1), { stdio: 'inherit', env: process.env });
      child.on('exit', (c) => resolve(c ?? 1));
    });
    return { dry: false, exit_code: code, ...plan };
  } finally {
    await proxy?.close();
  }
}

// ---------------------------------------------------------------- CLI
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); a[k] = ['dry'].includes(k) ? true : rest[++i]; }
  const repoRoot = path.resolve(HERE, '../../..');
  const out = (obj) => console.log(JSON.stringify(obj, null, 2));
  if (cmd === 'plan') {
    if (!a.rep) { console.error('plan: --rep N'); process.exit(2); }
    out({ A: armPlan({ arm: 'A', rep: a.rep, repoRoot }), B: armPlan({ arm: 'B', rep: a.rep, repoRoot }) });
  } else if (cmd === 'run') {
    if (!a.arm || !a.rep) { console.error('run: --arm A|B --rep N'); process.exit(2); }
    const r = await runArm({ arm: a.arm, rep: a.rep, repoRoot, dry: Boolean(a.dry) });
    out(r);
    process.exit(r.dry ? 0 : r.exit_code);
  } else if (cmd === 'threshold') {
    const t = computeT(Number(a.ready));
    // `--followers N` (optional): how many bots could follow at all. Each bot follows a Call at most once (6.6), so the hosts present at X
    // cannot exceed the number of followers; a T above it can never be met. The line says so; the rule itself is not changed here.
    const followers = a.followers !== undefined ? Number(a.followers) : null;
    const line = `PILOT ${JSON.stringify({ kind: 'ab-threshold', ready_invited_at_c0_plus_6: Number(a.ready), T: t, rule: 'T = min(3, ready invited hosts), never below 2', ...(followers != null ? { bots_that_can_follow: followers, T_attainable: t <= followers } : {}) })}`;
    if (a['append-runs']) fs.appendFileSync(path.resolve(a['append-runs']), `\n${line}\n`);
    out({ T: t, line, appended: Boolean(a['append-runs']) });
  } else if (cmd === 'analyze') {
    for (const k of ['rep', 'a', 'b']) if (!a[k]) { console.error(`analyze: --${k} is required`); process.exit(2); }
    const A = readArm({ aiDir: path.resolve(a.a), arm: 'A', rep: Number(a.rep) });
    const B = readArm({ aiDir: path.resolve(a.b), arm: 'B', rep: Number(a.rep) });
    const pair = evaluatePair(A, B, Number(a.t ?? T_MIN));
    if (a.out) fs.writeFileSync(a.out, JSON.stringify(pair, null, 2) + '\n');
    out(pair);
  } else if (cmd === 'result') {
    if (!a.pairs) { console.error('result: --pairs f1,f2,f3'); process.exit(2); }
    const pairs = a.pairs.split(',').map((f) => readJson(path.resolve(f))).filter(Boolean);
    const T = Number(a.t ?? pairs[0]?.T ?? T_MIN);
    const outcome = abOutcome(pairs);
    const runs = a.runs ? parseRuns(fs.readFileSync(path.resolve(a.runs), 'utf8')).filter((r) => /^ai-ab-/.test(r.run_id) || r.arm) : null;
    const md = renderAbResult({ pairs, T, outcome, runs });
    if (a.out) fs.writeFileSync(path.resolve(a.out), md);
    if (a.json) fs.writeFileSync(path.resolve(a.json), JSON.stringify({ outcome, pairs }, null, 2) + '\n');
    if (!a.out) process.stdout.write(md);
  } else {
    console.error('usage: run-ab.mjs plan|run|threshold|analyze|result (see the header)');
    process.exit(2);
  }
}
