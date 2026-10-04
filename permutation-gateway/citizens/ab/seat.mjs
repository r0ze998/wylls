// The seat script of the A/B (contract 9.2, 9.3; unit AC9). Local test chain only.
//
// The seat is index 1000 + n of the AI fleet (kind "seat", no brain, no records): its routine moves are the published
// autopilot; its BALLOTS here are scripted by the operator and signed with the seat's own session key through aisocial.mjs
// with origin = 2 ("scripted"). The roster marks `scripted: true` and the page says "scripted for the A/B test". What the A/B
// supports is "a Strike Order adopted with an operator-scripted seat ballot" (origin 2), nation 0 only; it never supports
// "humans and AI decide together" (only the live recorded session, with the presenter casting the ballot, does).
//
// The ONLY difference between the arms is this script's ballot in the FIRST period in which an AI of nation 0 moved an option X:
//   arm A  ballot X   at bell C0 + 4
//   arm B  ballot 0   ("none") at bell C0 + 4
// In every other period the script casts no ballot, in both arms. Ballots are hidden and counts never reach a prompt, so the
// AIs' inputs do not depend on the seat's ballot.
//
// After the ballot it waits for the strike (S = C0 + 6 + strike_lead = C0 + 12 in the A/B config) and observes, from the
// herald's public clash report at the option's province, what arrived there (nation 0's armies present, bounced) and what the
// clash cost each side. Observations and the ballot are written to AI_DIR/ab/seat-<arm>-<rep>.json, which run-ab.mjs reads.
//
//   node citizens/ab/seat.mjs --arm A|B --rep N --ai-dir DIR --herald URL --social URL --key-file KEYS/seat.txt --config F
//
// (the flags are the ones citizens/bin/ai-citizens-run.sh passes). Loopback only; it holds the seat's key and reads it from the
// key file only; it never prints it.
//
// SEAT BALLOT FIX (2026-10-05, owner decision 2026-10-04). The nation council needs two ballots for the leading option and each
// nation has one AI, so nation 0 needs the operator's seat. Without --arm this file runs the COUNCIL SCRIPT (`runSeatScript`):
// in EVERY council period of nation 0 that has options, with no AI motion needed, the seat casts ONE scripted ballot (origin 2,
// signed with the seat key exactly as above): for the option most chosen by the nation-0 AI ballots already cast, else for the
// option with the highest ratio word (ties: the lowest option number). It polls until the run ends (stop file, SIGTERM/SIGINT or
// an optional end bell), never a poll count, and it waits through preseason. The ballot is scripted: the log, the published seat
// record (PUB/seat/ballots.json) and every log line say so. A Strike Order adopted this way is a scripted seat vote plus AI votes;
// it is never "humans and AI decided together" (only the recorded session, where the owner votes, can say that).
// With --arm A|B the A/B behaviour of contract 9.3 is unchanged (the ballot rule above is not used there).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBallot, encodeBallot, signRecord, fromBase58, fromBase64, toBase58, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { assertLoopbackUrl } from '../mind/guards.mjs';

export const BALLOT_AT = 4; // C0 + 4 (the ballot window is [C0 + 3, C0 + 6))
export const OBSERVE_AFTER_STRIKE = 3; // read the clash report at S + 3
export const ORIGIN_SCRIPTED = 2;
export const NATION = 0; // the seat's nation; the A/B is nation 0 only
export const LAST_BALLOT_BELL = 5; // C0 + 5: the last bell of the ballot window [C0 + 3, C0 + 6)
export const STOP_FILE_NAME = 'seat.stop'; // AI_DIR/state/seat.stop: creating it ends the seat loop
/** What every log line, log file and the published seat record say about the seat's ballot (never "human"). */
export const SEAT_BALLOT_LABEL = Object.freeze({
  en: 'scripted seat ballot: written by the operator\'s script (origin 2), not a live human ballot',
  ja: '運営の台本による席の票(origin 2)。人間がその場で投じた票ではない',
});
export const SEAT_NEVER_LIVE = 'A Strike Order adopted with this ballot is the product of a scripted seat vote plus AI votes. It is not "humans and AI decided together"; only the recorded session, where the owner votes, can say that.';
/** The pinned choice rule of the council script (contract 9.3 pins none for a run without an AI motion; recorded in integ-B-NOTES.md). */
export const SEAT_RULE_TEXT = 'in every council period of nation 0 that has options: ballot for the option most chosen by the nation-0 AI ballots already cast (ties: the lowest option number; none only when every AI cast none); with no AI ballot by the last ballot bell (C0 + 5): the option with the highest ratio word (favourable, even, unfavourable), ties the lowest option number';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The seat's session key from the file `--export-seat-key` wrote: {wallet, session, session_keypair_b58} (seed 32 + public 32). */
export function loadSeatKey(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kp = fromBase58(j.session_keypair_b58);
  if (kp.length !== 64) throw new Error('seat key: session_keypair_b58 must decode to 64 bytes');
  const seed = Buffer.from(kp.subarray(0, 32));
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (toBase58(pub) !== j.session) throw new Error('seat key: the seed does not give the listed session public key');
  return { wallet: j.wallet, walletBytes: fromBase58(j.wallet), sessionB58: j.session, index: j.index ?? null, sign: (bytes) => crypto.sign(null, Buffer.from(bytes), key) };
}

/** X = the option of the first AI motion of the period (the motion list is in acceptance order); null when no AI moved one. */
export function aiMotionOption(state, aiWallets) {
  const m = (state?.motions ?? []).find((x) => (x.ai_roster === true || aiWallets.has(x.wallet)) && Number.isInteger(x.option) && x.option > 0);
  return m ? { option: m.option, wallet: m.wallet, tag: m.tag ?? null } : null;
}
/** The seat's ballot option: arm A casts X, arm B casts 0 (none). */
export const ballotOption = (arm, x) => (arm === 'A' ? x : 0);

/** The signed ballot body {bytes_b64, sig_b64, inner} for the seat. */
export async function buildSeatBallot({ key, season, state, option, nonce = crypto.randomBytes(16) }) {
  const bytes = encodeBallot({ season, period: state.period, wallet: key.walletBytes, faction: NATION, option, candidates_hash: state.candidates_hash, nonce, origin: ORIGIN_SCRIPTED });
  return signRecord(bytes, (b) => key.sign(b));
}

/** What the clash report at the option's province says about nation 0 and the enemy. `detail` is feed.clashDetail's shape. */
export function summariseClash(detail, nation = NATION) {
  if (!detail) return { clash_report: false, engagements: 0, present: 0, bounced: 0, engaged_own: 0, own_lost: 0, enemy_lost: 0, nation0_involved: false };
  const f = detail.fighters ?? [];
  const mine = f.filter((x) => x.faction === nation);
  const lost = (x) => (Number.isFinite(x.lost) ? Math.max(0, x.lost) : 0);
  return {
    clash_report: true,
    engagements: detail.engagements ?? 0,
    present: mine.filter((x) => x.arrival).length,
    bounced: mine.filter((x) => x.arrival && /^Bounced/.test(String(x.fate))).length,
    engaged_own: mine.filter((x) => x.engaged).length,
    own_lost: mine.reduce((s, x) => s + lost(x), 0),
    enemy_lost: f.filter((x) => x.faction !== nation && x.faction !== null && x.faction !== undefined).reduce((s, x) => s + lost(x), 0),
    nation0_involved: mine.some((x) => x.arrival || x.engaged),
    unknown_owner_fighters: f.filter((x) => x.faction === null || x.faction === undefined).length,
  };
}

// ---- the council script: choice rule, journal read, published record, loop control ------------------------------------------
const RATIO_RANK = { favourable: 3, even: 2, unfavourable: 1 };
/**
 * The scripted seat's option. `aiBallots` = the nation-0 AI ballots already cast this period ([{wallet, option}]), `options` = the
 * period's code-made options. Pure and deterministic. Returns {option, rule, ai_ballots} or null when there is no option.
 */
export function chooseScriptedOption({ aiBallots = [], options = [] }) {
  const valid = new Set(options.map((o) => o.option));
  const cast = aiBallots.filter((b) => b.option === 0 || valid.has(b.option));
  if (cast.length) {
    const n = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const b of cast) n[b.option]++;
    // plurality; the order 1, 2, 3, 0 makes a tie go to the lowest option number and "none" last
    const pick = [1, 2, 3, 0].filter((o) => o === 0 || valid.has(o)).sort((a, b) => n[b] - n[a])[0];
    return { option: pick, rule: 'follow_ai_ballots', ai_ballots: cast.map((b) => ({ wallet: b.wallet, option: b.option })) };
  }
  if (!options.length) return null;
  const best = [...options].sort((a, b) => (RATIO_RANK[b.ratio] ?? 0) - (RATIO_RANK[a.ratio] ?? 0) || a.option - b.option)[0];
  return { option: best.option, rule: 'highest_ratio_word', ai_ballots: [] };
}

/** Every ballot the social service has accepted, decoded from its record journal (AI_DIR/state/social/records.jsonl); [] when there is none. */
export function readJournalBallots(aiDir) {
  let text;
  try { text = fs.readFileSync(path.join(aiDir, 'state', 'social', 'records.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.t !== 'rec' || e.type !== 'ballot') continue;
    try {
      const d = decodeBallot(fromBase64(e.bytes_b64));
      out.push({ wallet: e.wallet, kind: e.kind ?? null, origin: d.origin, faction: d.faction, period: d.period, option: d.option });
    } catch { /* an undecodable line is skipped */ }
  }
  return out;
}

/**
 * The published seat record (PUB/seat/ballots.json). It says the ballot is scripted. The option of a period is withheld until that
 * period closes (ballots are hidden until then), so the file never shows a live ballot early.
 */
export function seatRecordOf(log, bell, now) {
  const closed = (p) => bell != null && p.closes_bell != null && bell >= p.closes_bell;
  const rows = log.mode === 'ab'
    ? (log.ballot ? [{ period: log.period, closes_bell: log.c0 != null ? log.c0 + 6 : null, option: log.ballot.option, bell: log.ballot.bell, ok: log.ballot.ok, rule: log.arm === 'A' ? 'ab_arm_a_ai_motion' : 'ab_arm_b_none', ai_ballots: [] }] : [])
    : log.periods;
  return {
    v: 1, kind: 'seat-ballots', scripted: true, origin: ORIGIN_SCRIPTED, nation: NATION, mode: log.mode,
    label: { ...SEAT_BALLOT_LABEL }, statement: SEAT_NEVER_LIVE, rule: log.mode === 'ab' ? 'contract 9.3: arm A ballots the AI motion option X, arm B ballots none' : SEAT_RULE_TEXT,
    ballots: rows.map((r) => (closed(r)
      ? { period: r.period, option: r.option, bell: r.bell, ok: r.ok, rule: r.rule, ai_ballots_followed: (r.ai_ballots ?? []).length, origin: ORIGIN_SCRIPTED, scripted: true }
      : { period: r.period, option: null, bell: r.bell, ok: r.ok, origin: ORIGIN_SCRIPTED, scripted: true, withheld_until_bell: r.closes_bell })),
    skipped_periods: log.skipped_periods ?? [],
    updated_unix: Math.floor(now() / 1000),
  };
}
/** A publisher that writes PUB/seat/ballots.json (atomically) only when the record changed; `updated_unix` is not part of the comparison. */
function makeSeatPublisher(aiDir, now) {
  const file = path.join(aiDir, 'pub', 'seat', 'ballots.json');
  let last = null;
  return (log, bell) => {
    try {
      const rec = seatRecordOf(log, bell, now);
      const key = JSON.stringify({ ...rec, updated_unix: 0 });
      if (key === last) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
      fs.renameSync(tmp, file);
      last = key;
    } catch { /* the private log is the source */ }
  };
}

/** Why the loop must stop now, or null. Bound to game time (stop file or signal, the end bell), never to a poll count unless a test asks. */
async function stopReason({ i, bell, maxPolls, endBell, shouldStop }) {
  if (shouldStop && (await shouldStop())) return 'stopped: stop file or signal';
  if (endBell != null && bell != null && bell >= endBell) return `run ended: bell ${bell} reached the end bell ${endBell}`;
  if (maxPolls != null && i >= maxPolls) return `gave up after ${maxPolls} polls`;
  return null;
}

/**
 * The seat's loop (A/B). All I/O is injected so a test runs it in a few milliseconds:
 *   getJson(url) -> object, postJson(url, body) -> {status, body}, bellNow() -> bell (null before genesis), sleep(ms),
 *   observeAt(p, q, bell) -> clashDetail-like or null.
 */
export async function runSeat({ arm, rep, aiDir, social, key, config = {}, getJson, postJson, bellNow, sleep, observeAt = null, pollMs = 3000, maxPolls = null, endBell = null, shouldStop = null, now = () => Date.now() }) {
  if (arm !== 'A' && arm !== 'B') throw new Error('seat: --arm A or B');
  const roster = readJson(path.join(aiDir, 'pub/roster.json'));
  const season = roster?.season;
  if (season == null) throw new Error('seat: pub/roster.json has no season (the registrar writes it after the deal)');
  const aiWallets = new Set((roster.ai ?? []).filter((a) => a.faction === NATION).map((a) => a.wallet));
  if (roster.seat?.wallet && roster.seat.wallet !== key.wallet) throw new Error('seat: the key file is not the roster seat');
  const log = { v: 1, kind: 'ab-seat', mode: 'ab', scripted: true, ballot_label: { ...SEAT_BALLOT_LABEL }, arm, rep, nation: NATION, origin: ORIGIN_SCRIPTED, season, seat_wallet_listed: Boolean(roster.seat), started_unix: Math.floor(now() / 1000), period: null, option_x: null, ai_mover: null, ballot: null, observed: null, skipped_periods: [], notes: [] };
  const file = path.join(aiDir, 'ab', `seat-${arm}-${rep}.json`);
  let lastBell = null;
  const publish = makeSeatPublisher(aiDir, now);
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(log, null, 1)); publish(log, lastBell); };
  console.log(`seat: ${SEAT_BALLOT_LABEL.en} (A/B arm ${arm}, rep ${rep})`);
  save();
  const seenNoMotion = new Set();
  let state = null;
  for (let i = 0; ; i++) {
    const why = await stopReason({ i, bell: lastBell, maxPolls, endBell, shouldStop });
    if (why) { log.notes.push(why); break; }
    let st = null;
    try { st = await getJson(`${social}/f/ai/council?faction=${NATION}`); } catch { st = null; }
    const bell = await bellNow();
    lastBell = bell;
    publish(log, lastBell); // a ballot's option is published only once its period has closed
    if (st?.period != null) state = st;
    if (state?.period != null && bell != null) {
      const c0 = state.c0 ?? state.closes_bell - 6;
      if (log.period === null) {
        const mv = aiMotionOption(state, aiWallets);
        if (mv) { log.period = state.period; log.option_x = mv.option; log.ai_mover = { wallet: mv.wallet, tag: mv.tag }; log.c0 = c0; save(); }
        else if (bell >= c0 + 3 && !seenNoMotion.has(state.period)) { seenNoMotion.add(state.period); log.skipped_periods.push({ period: state.period, reason: 'no AI citizen of nation 0 moved an option in the motion window' }); save(); }
      }
      if (log.period !== null && !log.ballot && state.period === log.period && bell >= c0 + BALLOT_AT && bell < c0 + 6) {
        const option = ballotOption(arm, log.option_x);
        const body = await buildSeatBallot({ key, season, state, option });
        const r = await postJson(`${social}/f/ai/ballot`, { bytes_b64: body.bytes_b64, sig_b64: body.sig_b64 });
        log.ballot = { option, bell, status: r.status, ok: r.status === 200, inner: body.inner, origin: ORIGIN_SCRIPTED, scripted: true, code: r.body?.code ?? null };
        console.log(`seat: ${SEAT_BALLOT_LABEL.en}: period ${state.period}, bell ${bell}, status ${r.status}`);
        save();
      }
      if (log.ballot && !log.observed) {
        const strike = c0 + 6 + (config.council?.strike_lead ?? 6);
        const cand = (state.options ?? state.candidates ?? []).find((o) => o.option === log.option_x);
        if (bell >= strike + OBSERVE_AFTER_STRIKE && cand) {
          const detail = observeAt ? await observeAt(cand.p, cand.q, strike) : null;
          log.observed = { x: { option: log.option_x, kind: cand.kind, p: cand.p, q: cand.q }, s: strike, observed_at_bell: bell, observer: observeAt ? 'herald clash report through the AC6a feed' : 'none', ...summariseClash(detail) };
          // the council file's own opening, if the service has published it
          const ps = await getJson(`${social}/f/ai/council?faction=${NATION}&period=${log.period}`).catch(() => null);
          log.council_at_end = ps ? { adopted: ps.adopted ?? null, reason: ps.reason ?? null, tally_split: ps.tally_split ?? null, options_hash: ps.options_hash ?? null, candidates_hash: ps.candidates_hash ?? null } : null;
          save();
          return log;
        }
      }
    }
    await sleep(pollMs);
  }
  save();
  return log;
}

/**
 * The council script (seat ballot fix; see the header). One scripted ballot (origin 2) in every council period of nation 0 that has
 * options, with no AI motion needed. All I/O is injected like `runSeat`; plus
 *   readBallots(aiDir) -> [{wallet, kind, origin, faction, period, option}]  (the default reads the service's record journal)
 *   shouldStop() -> bool (stop file or signal), endBell (optional run end), maxPolls (tests only; null = bound to game time).
 * It waits through preseason (no roster season, no period, bell before genesis) and keeps polling until the run ends.
 */
export async function runSeatScript({ aiDir, social, key, config = {}, getJson, postJson, bellNow, sleep, readBallots = readJournalBallots, pollMs = 3000, maxPolls = null, endBell = null, shouldStop = null, now = () => Date.now(), maxAttempts = 20 }) {
  const log = { v: 1, kind: 'seat-script-log', mode: 'council-script', scripted: true, ballot_label: { ...SEAT_BALLOT_LABEL }, never_live: SEAT_NEVER_LIVE, rule: SEAT_RULE_TEXT, nation: NATION, origin: ORIGIN_SCRIPTED, season: null, seat_wallet_listed: false, started_unix: Math.floor(now() / 1000), periods: [], skipped_periods: [], notes: [] };
  const file = path.join(aiDir, 'seat', 'seat-script-log.json');
  const publish = makeSeatPublisher(aiDir, now);
  let lastBell = null;
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(log, null, 1)); publish(log, lastBell); };
  console.log(`seat: ${SEAT_BALLOT_LABEL.en}; council script for nation ${NATION}, polling until the run ends`);
  save();
  const done = new Set(); // periods with a final answer (cast, refused for good, or already voted): never a second ballot
  const skipped = new Set();
  const attempts = new Map();
  let roster = null;
  let aiWallets = new Set();
  let state = null;
  for (let i = 0; ; i++) {
    const why = await stopReason({ i, bell: lastBell, maxPolls, endBell, shouldStop });
    if (why) { log.notes.push(why); break; }
    if (!roster?.season) {
      roster = readJson(path.join(aiDir, 'pub/roster.json'));
      if (roster?.season != null) {
        if (roster.seat?.wallet && roster.seat.wallet !== key.wallet) throw new Error('seat: the key file is not the roster seat');
        log.season = roster.season;
        log.seat_wallet_listed = Boolean(roster.seat);
        aiWallets = new Set((roster.ai ?? []).filter((a) => a.faction === NATION).map((a) => a.wallet));
        for (const b of readBallots(aiDir)) if (b.wallet === key.wallet && b.faction === NATION) done.add(b.period); // a restart never votes twice
        save();
      }
    }
    let st = null;
    try { st = await getJson(`${social}/f/ai/council?faction=${NATION}`); } catch { st = null; }
    const bell = await bellNow();
    lastBell = bell;
    publish(log, lastBell); // a ballot's option is published only once its period has closed
    if (st?.period != null) state = st;
    if (roster?.season != null && state?.period != null && bell != null && bell >= 0) {
      const c0 = state.c0 ?? state.closes_bell - 6;
      const P = state.period;
      const options = state.options ?? state.candidates ?? [];
      if (!done.has(P) && options.length > 0 && bell >= c0 + 3 && bell < c0 + 6 && state.state !== 'closed') {
        const ai = readBallots(aiDir).filter((b) => b.period === P && b.faction === NATION && b.wallet !== key.wallet && (aiWallets.has(b.wallet) || b.kind === 'ai'));
        const aiVoted = new Set(ai.map((b) => b.wallet));
        const everyAiVoted = aiWallets.size > 0 && [...aiWallets].every((w) => aiVoted.has(w));
        // cast once every AI of nation 0 has voted, or at the last ballot bell with whatever there is (the rule's ratio word if no AI voted)
        if (everyAiVoted || bell >= c0 + LAST_BALLOT_BELL) {
          const pick = chooseScriptedOption({ aiBallots: ai, options });
          const body = await buildSeatBallot({ key, season: roster.season, state: { period: P, candidates_hash: state.candidates_hash }, option: pick.option });
          let r;
          try { r = await postJson(`${social}/f/ai/ballot`, { bytes_b64: body.bytes_b64, sig_b64: body.sig_b64 }); } catch { r = { status: 0, body: null }; }
          const code = r.body?.code ?? null;
          const n = (attempts.get(P) ?? 0) + 1;
          attempts.set(P, n);
          const retry = r.status === 0 || r.status >= 500 || (r.status >= 400 && code === 'WindowClosed');
          if (!retry || n >= maxAttempts) {
            done.add(P);
            log.periods.push({ period: P, c0, closes_bell: c0 + 6, option: pick.option, rule: pick.rule, ai_ballots: pick.ai_ballots, bell, status: r.status, ok: r.status === 200, code, attempts: n, inner: body.inner, origin: ORIGIN_SCRIPTED, scripted: true });
            console.log(`seat: ${SEAT_BALLOT_LABEL.en}: period ${P}, option ${pick.option} by rule ${pick.rule}, bell ${bell}, status ${r.status}${code ? ` ${code}` : ''}`);
            save();
          }
        }
      } else if (!done.has(P) && !skipped.has(P) && bell >= c0 + 6) {
        skipped.add(P);
        log.skipped_periods.push({ period: P, reason: options.length ? 'the ballot window passed without a seat ballot (the seat saw the period too late or its posts failed)' : 'the period had no options' });
        save();
      }
    }
    await sleep(pollMs);
  }
  save();
  return log;
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  for (const k of ['ai-dir', 'herald', 'social', 'key-file']) if (!a[k]) { console.error(`seat: --${k} is required`); process.exit(2); }
  const ab = a.arm !== undefined;
  if (ab && (!a.rep || (a.arm !== 'A' && a.arm !== 'B'))) { console.error('seat: --arm A|B needs --rep N (without --arm the seat runs the council script)'); process.exit(2); }
  assertLoopbackUrl(a.herald, 'herald');
  assertLoopbackUrl(a.social, 'social');
  const aiDir = path.resolve(a['ai-dir']);
  const config = a.config ? readJson(path.resolve(a.config)) ?? {} : {};
  const stopFile = path.resolve(a['stop-file'] ?? path.join(aiDir, 'state', STOP_FILE_NAME));
  const endBell = a['end-bell'] !== undefined ? Number(a['end-bell']) : (Number.isFinite(Number(config.end_bell)) ? Number(config.end_bell) : null);
  // the loop is bound to game time: it ends with the run (the run script's SIGTERM, SIGINT, the stop file or an end bell), not after a poll count
  let stopping = false;
  const wakers = new Set();
  const stop = () => { stopping = true; for (const w of wakers) w(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const shouldStop = () => stopping || fs.existsSync(stopFile);
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(() => { wakers.delete(wake); r(); }, ms); const wake = () => { clearTimeout(t); wakers.delete(wake); r(); }; wakers.add(wake); });
  // the seat key is written by the fleet (--export-seat-key) a few seconds after it starts: wait for it (preseason start)
  let key = null;
  for (let bad = 0; !key && !shouldStop();) {
    try { key = loadSeatKey(path.resolve(a['key-file'])); } catch (e) { if (fs.existsSync(path.resolve(a['key-file'])) && ++bad > 15) { console.error(`seat: ${e.message}`); process.exit(2); } await sleep(2000); }
  }
  if (!key) { console.log('seat: stopped before the seat key existed'); process.exit(0); }
  const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
  const postJson = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const { bellOf } = await import('../scenario/census.mjs');
  const bellNow = async () => { try { return bellOf(await getJson(`${a.herald}/h/season`)); } catch { return null; } };
  const social = a.social.replace(/\/+$/, '');
  if (!ab) {
    const log = await runSeatScript({ aiDir, social, key, config, getJson, postJson, bellNow, sleep, shouldStop, endBell });
    console.log(JSON.stringify({ mode: log.mode, scripted: true, ballots: log.periods.map((p) => ({ period: p.period, option: p.option, rule: p.rule, ok: p.ok })), skipped: log.skipped_periods.length, stopped: log.notes.at(-1) ?? null }));
    process.exit(0);
  }
  let feed = null;
  try {
    const { createFeed } = await import('../watcher/feed.mjs');
    feed = createFeed({ herald: a.herald, roster: readJson(path.join(aiDir, 'pub/roster.json')) });
  } catch { feed = null; }
  const log = await runSeat({ arm: a.arm, rep: Number(a.rep), aiDir, social, key, config, getJson, postJson, bellNow, sleep, shouldStop, endBell, observeAt: feed ? async (p, q, b) => { for (let i = 0; i < 5; i++) { const r = await feed.poll(); if (r.ok) break; } return feed.clashDetail(p, q, b); } : null });
  console.log(JSON.stringify({ arm: log.arm, rep: log.rep, period: log.period, option_x: log.option_x, ballot: log.ballot && { option: log.ballot.option, ok: log.ballot.ok }, observed: Boolean(log.observed) }));
  process.exit(log.ballot?.ok ? 0 : 1);
}
