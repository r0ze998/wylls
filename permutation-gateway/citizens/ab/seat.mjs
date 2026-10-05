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
// LIVE SEAT (2026-10-05, the recording run; docs/frontier/ai-citizens/RECORDING-RUN.md). `--live 1` (instead of --arm or the council script): the
// presenter (the operator) votes for real on the council page, so this process casts NO ballot and posts nothing (`runSeatLive` has no `postJson`).
// It only (1) finalises the seat's own village, exactly as below, labelled as the run harness's act (`mode: 'live'`, `scripted: false`), (2) writes
// KEYS/presenter-key.json, the seat's session key in the form the council page takes (no wallet secret), and (3) prints where the council of
// nation 0 stands, with clock times, so the presenter knows when to be at the keyboard. Log: AI_DIR/seat/seat-live-log.json; published record:
// PUB/seat/live.json. The roster says `scripted: false` when the run names no --seat-script (the run script refuses both together).
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
//
// SEAT ELIGIBILITY FIX (2026-10-05, smoke-r3). The scripted seat posted its ballot at bell 52 and the social service answered 400
// NotEligible: the council's eligible list for nation 0 at C0 held only the AI, because the seat's village was still PROVISIONAL (Holding
// STATE 1; every AI's was STATE 2). The program flips provisional to final lazily (I-29, I-47: state 1, now >= final_ts, ticket cohort
// closed, at most 24 bells after the village appears) and only inside an instruction that carries the holding's own Province; the seat
// is the fleet's Idle archetype and sends nothing, so it never flipped. The watcher's census lists a citizen as a voter only after the
// HOLDING_FINAL row is in the herald log. So the seat script now finalises its own village: `createSeatFinaliser` (below) reads the seat's
// holding from the herald and, once the flip is due, sends ONE harmless instruction that carries the holding's Province, a Build of walls
// (item 6; +100 walls for 300 stone), signed with the seat's session key through the relay exactly as the web client does. Harvest, the
// cheapest instruction, does NOT work: it carries no Province and the program applies the flip only where `finality()` is called (Build
// walls, Muster, Garrison, Dissolve, Explore, Depart). Garrison/Muster would need a reserve and a caught-up province. It stops when the
// holding reads as final, with a quota guard and a cap on attempts; log lines say "scripted seat: finalising its village".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBallot, encodeBallot, signRecord, fromBase58, fromBase64, toBase58, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { assertLoopbackUrl } from '../mind/guards.mjs';
import { campLoss } from '../watcher/calls.mjs';

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

/** The live seat (recording run, `--live 1`): the presenter casts the ballot on the council page (origin 0); this process casts none. */
export const SEAT_LIVE_LABEL = Object.freeze({
  en: 'live seat: the presenter casts the ballot on the council page (origin 0); this process casts no ballot',
  ja: '席は実演者本人が操作する(origin 0)。この処理は投票しない',
});
export const SEAT_LIVE_FINALISE_STATEMENT = 'the run harness touches the seat\'s own village (one Build of walls, signed with the seat key) so that it counts as a final village and the presenter is eligible; it casts no vote and moves no troops. The presenter\'s ballot is cast by the presenter on the council page.';
export const SEAT_LIVE_STATEMENT = 'A ballot of the live seat is cast by the presenter on the council page (origin 0, counted as human). This process never casts one. Only that live ballot supports "a human and AI citizens decided together", for nation 0, the operator being the human. The one Build of walls that makes the seat\'s village final is the run harness\'s act, not the presenter\'s.';
export const PRESENTER_KEY_FILE = 'presenter-key.json'; // KEYS/presenter-key.json: the session key of the seat in the form the council page takes (see writePresenterKey)
export const LIVE_LOG_FILE = 'seat-live-log.json'; // AI_DIR/seat/seat-live-log.json (private) and PUB/seat/live.json (published)

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

/** The 32-byte seed of the seat's session key (the finaliser signs a transaction with it; it is never logged or written). */
export function loadSeatSeed(file) {
  const kp = fromBase58(JSON.parse(fs.readFileSync(file, 'utf8')).session_keypair_b58);
  if (kp.length !== 64) throw new Error('seat key: session_keypair_b58 must decode to 64 bytes');
  return Buffer.from(kp.subarray(0, 32));
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
  // a camp target: the clash report lists hosts only, so the camp's loss comes from the province files (calls.mjs campLoss, attached as detail.camp_lost)
  const campLost = Number.isFinite(detail.camp_lost) ? Math.max(0, detail.camp_lost) : 0;
  return {
    clash_report: true,
    camp_lost: campLost,
    engagements: detail.engagements ?? 0,
    present: mine.filter((x) => x.arrival).length,
    bounced: mine.filter((x) => x.arrival && /^Bounced/.test(String(x.fate))).length,
    engaged_own: mine.filter((x) => x.engaged).length,
    own_lost: mine.reduce((s, x) => s + lost(x), 0),
    enemy_lost: f.filter((x) => x.faction !== nation && x.faction !== null && x.faction !== undefined).reduce((s, x) => s + lost(x), 0) + campLost,
    nation0_involved: mine.some((x) => x.arrival || x.engaged),
    unknown_owner_fighters: f.filter((x) => x.faction === null || x.faction === undefined).length,
  };
}

// ---- the seat's own village: provisional -> final (seat eligibility fix) --------------------------------------------------------
export const FINALISE_LINE = 'scripted seat: finalising its village';
/** The live seat's line: the Build of walls is the run harness's, not the presenter's, and nothing here votes (live seat mode, see the end of this file). */
export const FINALISE_LINE_LIVE = 'live seat (run harness): finalising its village';
export const ITEM_WALLS = 6; // catalog ITEM_WALLS: the only Build that names the holding's Province, hence the only one that runs the lazy flip
export const WALL_STONE_NEEDED = 300; // catalog WALL_COST_STONE (a doctrine may cut it by 5 %: 300 is the safe upper bound), whole units
export const FINALISE_MIN_QUOTA = 6; // the seat shares the relay's per-citizen daily quota: it sends nothing below this many left
export const FINALISE_MAX_ATTEMPTS = 3; // sent walls that landed without the village turning final (the wall queue has two slots)
export const FINALISE_MAX_TRIES = 12; // every send, landed or not (a refused or lost transaction counts here only)
export const FINALISE_SPACING_BELLS = 3; // bells between two sends

/**
 * The finaliser of the scripted seat's own village. All chain I/O is injected:
 *   readSeat() -> null (herald unreachable) | {holding: null | {state: 1|2, ...}, due: bool, stone: number|null}
 *     `due` = the program would take the lazy flip now (frontier-abi finality_due: state 1, now >= final_ts, cohort closed), `stone` = whole units
 *   sendWalls() -> {ok, code?, state?, signature?, error?}   (a landed transaction is ok: true)
 *   quotaLeft() -> number | null
 * `mode: 'live'` (live seat) only changes the labels: `scripted: false`, the line prefix FINALISE_LINE_LIVE and the statement; the actions are the same.
 * `step({bell})` does at most one thing per bell and never throws: read; final -> done; not due -> wait; not enough stone -> wait; quota
 * low -> wait; else one Build of walls. State (JSON, no key): {status, final, attempts, tries, last_attempt_bell, final_bell, last_result, note}.
 */
export function createSeatFinaliser({ readSeat, sendWalls, quotaLeft = null, log = (m) => console.log(m), maxAttempts = FINALISE_MAX_ATTEMPTS, maxTries = FINALISE_MAX_TRIES, spacingBells = FINALISE_SPACING_BELLS, minQuota = FINALISE_MIN_QUOTA, stoneNeeded = WALL_STONE_NEEDED, mode = 'scripted' } = {}) {
  const LIVE = mode === 'live'; // live seat: the same single Build of walls, labelled as the run harness's act (the presenter votes on the page)
  const st = LIVE
    ? { scripted: false, mode: 'live', statement: SEAT_LIVE_FINALISE_STATEMENT, status: 'not_started', final: false, attempts: 0, tries: 0, last_attempt_bell: null, last_checked_bell: null, final_bell: null, last_result: null, note: null }
    : { scripted: true, statement: 'the operator\'s script touches the seat\'s own village so that it counts as a final village; it casts no vote and moves no troops', status: 'not_started', final: false, attempts: 0, tries: 0, last_attempt_bell: null, last_checked_bell: null, final_bell: null, last_result: null, note: null };
  const say = (m) => { try { log(`${LIVE ? FINALISE_LINE_LIVE : FINALISE_LINE}${m ? ` ${m}` : ''}`); } catch { /* a log failure must not stop the seat */ } };
  const to = (status, text = null) => { if (st.status !== status) { st.status = status; if (text) say(`(${text})`); } };
  return {
    state: () => ({ ...st }),
    async step({ bell }) {
      if (st.final || bell == null || bell < 0 || st.last_checked_bell === bell) return st;
      st.last_checked_bell = bell;
      let snap = null;
      try { snap = await readSeat(); } catch { snap = null; }
      if (!snap) { to('herald_unreachable'); return st; }
      const h = snap.holding;
      if (!h) { to('no_village_yet'); return st; }
      if (h.state === 2) { st.final = true; st.final_bell = bell; st.status = 'final'; say(`: its village is final (seen at bell ${bell})`); return st; }
      if (!snap.due) { to('waiting_final_due', `waiting: the program flips it only when its time has come and its ticket cohort has closed; provisional at bell ${bell}`); return st; }
      if (snap.stone != null && snap.stone < stoneNeeded) { to('waiting_stone', `waiting for ${stoneNeeded} stone, has ${snap.stone}`); return st; }
      if (st.attempts >= maxAttempts || st.tries >= maxTries) { to('gave_up', `gave up after ${st.attempts} landed and ${st.tries} sent attempts; still provisional`); return st; }
      if (st.last_attempt_bell != null && bell - st.last_attempt_bell < spacingBells) return st;
      let q = null;
      try { q = quotaLeft ? await quotaLeft() : null; } catch { q = null; }
      if (q != null && q < minQuota) { to('waiting_quota', `waiting: only ${q} sponsored transactions left today, the seat keeps ${minQuota} back`); return st; }
      say(`: a Build of walls touches its holding at bell ${bell} (no vote, no troops)`);
      st.tries++;
      st.last_attempt_bell = bell;
      let r;
      try { r = await sendWalls(); } catch (e) { r = { ok: false, code: 'threw', error: String(e?.message ?? e).slice(0, 200) }; }
      st.last_result = { bell, ok: Boolean(r?.ok), code: r?.code ?? null, state: r?.state ?? null, signature: r?.signature ?? null };
      if (r?.ok) { st.attempts++; st.status = 'sent'; say(`: landed (${r.signature ? String(r.signature).slice(0, 12) : 'no signature'}); waiting for the herald to show it final`); }
      else { st.status = 'send_failed'; st.note = `${r?.code ?? 'failed'}: ${String(r?.error ?? '').slice(0, 160)}`; say(`: the send failed (${st.note}); trying again later`); }
      return st;
    },
  };
}

/**
 * The real chain I/O of the finaliser (CLI only): the herald for reading, the relay for sending, the seat's session key signing through the
 * web client's own modules (permutation-server/web/frontier/fplay.mjs, the same path the page uses). Imports are lazy so the pure file
 * loads without them. Throws nothing the finaliser does not catch.
 *   herald: base URL; relay: base URL of the relay (the herald's /gw proxy by default); key: loadSeatKey's result plus `seed`.
 */
export async function makeChainFinaliserIO({ herald, relay, key, seed, fetchImpl = globalThis.fetch, track = { tries: 30, every: 1500 } }) {
  const web = new URL('../../../permutation-server/web/', import.meta.url);
  const mod = (rel) => import(new URL(rel, web).href);
  const [{ createHerald }, io, play, land, sess] = await Promise.all([mod('frontier/herald.mjs'), mod('frontier/fchainio.mjs'), mod('frontier/fplay.mjs'), mod('frontier/fland.mjs'), mod('session.mjs')]);
  const h = createHerald({ base: herald, fetch: fetchImpl });
  const session = await sess.keyFromSeed(seed);
  if (session.publicKey !== key.sessionB58) throw new Error('seat: the key seed does not give the session key');
  io.setRelay(relay);
  let pinned = false;
  let lastSeason = null;
  const ensurePin = async () => {
    const s = await h.season();
    if (!s.ok) return null;
    lastSeason = s;
    if (!pinned) {
      io.setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: Buffer.from(s.season.rulesetHash).toString('hex') });
      pinned = true;
    }
    return s;
  };
  let holdingRef = null;
  const STONE = 2;
  return {
    async readSeat() {
      const s = await ensurePin();
      if (!s) return null;
      const me = await h.me(key.wallet);
      if (!me.ok) return me.code === 'NotFound' ? { holding: null, due: false, stone: null } : null;
      const hd = me.holdings.find((x) => x.state === 1 || x.state === 2) ?? null;
      if (!hd) return { holding: null, due: false, stone: null };
      holdingRef = { p: hd.p, q: hd.q, site: hd.site };
      if (hd.state === 2) return { holding: { state: 2, ...holdingRef }, due: true, stone: null };
      const pv = await h.province(hd.p, hd.q, 'latest');
      const now = Number(s.record.latestUnix);
      const nowBell = Number(s.record.genesisTs) > now ? -1 : Math.floor((now - Number(s.record.genesisTs)) / Number(s.record.bellSecs));
      const due = Boolean(pv.ok && land.finalityDue(hd, pv.province, now, nowBell));
      let stone = null;
      try { stone = Number(land.accrualAt(hd.stores[STONE], now) / 1000n); } catch { stone = null; }
      return { holding: { state: 1, ...holdingRef, final_ts: Number(hd.finalTs), ticket_bell: hd.ticketBell }, due, stone };
    },
    async quotaLeft() {
      if (!pinned) return null;
      const citizen = io.pinned().addresses.of('Citizen', { wallet: key.wallet });
      const r = await io.quota(citizen);
      return r.ok && Number.isFinite(Number(r.left)) ? Number(r.left) : null;
    },
    async sendWalls() {
      if (!pinned || !holdingRef) return { ok: false, code: 'NoHolding', error: 'the seat\'s holding has not been read yet' };
      const A = io.pinned().addresses;
      const accounts = play.accountsFor('Build', { addresses: A, wallet: key.wallet, actor: session.publicKey, holding: holdingRef, province: holdingRef, item: ITEM_WALLS });
      const r = await play.submit({ name: 'Build', accounts, fields: { item: ITEM_WALLS }, signer: { session } });
      if (!r.ok) return { ok: false, code: r.code ?? 'SendFailed', error: r.error ?? null };
      const t = await play.track(r.signature, track);
      return { ok: t.ok, state: t.state, code: t.ok ? null : (t.code ?? 'NotLanded'), signature: r.signature, error: t.ok ? null : `${t.state ?? ''} ${t.programCode ?? ''}`.trim() };
    },
    season: () => lastSeason,
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

/** One finaliser step in a loop, after the bell is known. The seat's private log carries the finaliser's state (`finalise`); it never throws. */
async function finaliseTick(finaliser, bell, log, save) {
  if (!finaliser || bell == null || bell < 0) return;
  try {
    const before = JSON.stringify(log.finalise ?? null);
    log.finalise = { ...(await finaliser.step({ bell })) };
    if (JSON.stringify(log.finalise) !== before) save();
  } catch { /* the seat's votes do not depend on it */ }
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
export async function runSeat({ arm, rep, aiDir, social, key, config = {}, getJson, postJson, bellNow, sleep, observeAt = null, pollMs = 3000, maxPolls = null, endBell = null, shouldStop = null, now = () => Date.now(), finaliser = null }) {
  if (arm !== 'A' && arm !== 'B') throw new Error('seat: --arm A or B');
  const roster = readJson(path.join(aiDir, 'pub/roster.json'));
  const season = roster?.season;
  if (season == null) throw new Error('seat: pub/roster.json has no season (the registrar writes it after the deal)');
  const aiWallets = new Set((roster.ai ?? []).filter((a) => a.faction === NATION).map((a) => a.wallet));
  if (roster.seat?.wallet && roster.seat.wallet !== key.wallet) throw new Error('seat: the key file is not the roster seat');
  const log = { v: 1, kind: 'ab-seat', mode: 'ab', scripted: true, ballot_label: { ...SEAT_BALLOT_LABEL }, arm, rep, nation: NATION, origin: ORIGIN_SCRIPTED, season, seat_wallet_listed: Boolean(roster.seat), started_unix: Math.floor(now() / 1000), period: null, option_x: null, ai_mover: null, ballot: null, observed: null, skipped_periods: [], ineligible_periods: [], ballot_retries: 0, notes: [] };
  const file = path.join(aiDir, 'ab', `seat-${arm}-${rep}.json`);
  let lastBell = null;
  const publish = makeSeatPublisher(aiDir, now);
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(log, null, 1)); publish(log, lastBell); };
  console.log(`seat: ${SEAT_BALLOT_LABEL.en} (A/B arm ${arm}, rep ${rep})`);
  save();
  const seenNoMotion = new Set();
  const ineligible = new Set(); // periods in which the council refused the seat's ballot as NotEligible (its village was not final at C0)
  let state = null;
  for (let i = 0; ; i++) {
    const why = await stopReason({ i, bell: lastBell, maxPolls, endBell, shouldStop });
    if (why) { log.notes.push(why); break; }
    let st = null;
    try { st = await getJson(`${social}/f/ai/council?faction=${NATION}`); } catch { st = null; }
    const bell = await bellNow();
    lastBell = bell;
    publish(log, lastBell); // a ballot's option is published only once its period has closed
    await finaliseTick(finaliser, bell, log, save); // the seat's village must count as final before the period opens
    if (st?.period != null) state = st;
    if (state?.period != null && bell != null) {
      const c0 = state.c0 ?? state.closes_bell - 6;
      if (log.period === null && !ineligible.has(state.period)) {
        const mv = aiMotionOption(state, aiWallets);
        if (mv) { log.period = state.period; log.option_x = mv.option; log.ai_mover = { wallet: mv.wallet, tag: mv.tag }; log.c0 = c0; save(); }
        else if (bell >= c0 + 3 && !seenNoMotion.has(state.period)) { seenNoMotion.add(state.period); log.skipped_periods.push({ period: state.period, reason: 'no AI citizen of nation 0 moved an option in the motion window' }); save(); }
      }
      if (log.period !== null && !log.ballot && state.period === log.period && bell >= c0 + BALLOT_AT && bell < c0 + 6) {
        const option = ballotOption(arm, log.option_x);
        const body = await buildSeatBallot({ key, season, state, option });
        let r;
        try { r = await postJson(`${social}/f/ai/ballot`, { bytes_b64: body.bytes_b64, sig_b64: body.sig_b64 }); } catch { r = { status: 0, body: null }; } // a lost post is a retry, never the end of the seat
        const code = r.body?.code ?? null;
        if (r.status === 400 && code === 'NotEligible') {
          // The council refused the seat (its village was not final at C0). No ballot is possible in this period, so it cannot test anything:
          // it is recorded and the next period in which an AI moves an option is used (disclosed in the pilot and A/B results; both arms do this).
          ineligible.add(state.period);
          log.ineligible_periods.push({ period: state.period, c0, bell, option, code });
          log.skipped_periods.push({ period: state.period, reason: 'the seat was not eligible (its village was not final at C0): no ballot was possible, the period is not testable' });
          log.period = null; log.option_x = null; log.ai_mover = null; log.c0 = null;
          console.log(`seat: ${SEAT_BALLOT_LABEL.en}: period ${state.period} refused NotEligible at bell ${bell}; waiting for the next period with an AI motion`);
          save();
        } else if ((r.status === 0 || r.status >= 500) && ++log.ballot_retries < 20) {
          save(); // not final: the next poll tries again while the ballot window lasts
        } else {
          log.ballot = { option, bell, status: r.status, ok: r.status === 200, inner: body.inner, origin: ORIGIN_SCRIPTED, scripted: true, code };
          console.log(`seat: ${SEAT_BALLOT_LABEL.en}: period ${state.period}, bell ${bell}, status ${r.status}`);
          save();
        }
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
export async function runSeatScript({ aiDir, social, key, config = {}, getJson, postJson, bellNow, sleep, readBallots = readJournalBallots, pollMs = 3000, maxPolls = null, endBell = null, shouldStop = null, now = () => Date.now(), maxAttempts = 20, finaliser = null }) {
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
    await finaliseTick(finaliser, bell, log, save); // the seat's village must count as final before the period opens
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

// ---- the live seat (recording run; `--live 1`) -------------------------------------------------------------------------------
// In the recording run the presenter (the operator) votes for real on the council page, so no ballot may be scripted: this mode runs the
// seat's finaliser ONLY (the same single Build of walls as above, labelled as the run harness's act, `scripted: false`) and tells the
// operator's terminal where the council of nation 0 stands, so the presenter knows when to be at the keyboard. It posts NOTHING to the
// social service (`runSeatLive` takes no `postJson`), never touches the council and writes no ballot record. The roster flag is unchanged:
// a run started without `--seat-script` has `scripted: false`, so the page badges the seat "presenter seat (human operator)" and the
// presenter's ballot from the page (origin 0) is counted as human. Honesty: the Build of walls is the harness's, the ballot is the presenter's.

/**
 * The seat's session key in the form the council page takes: `{wallet, session, session_keypair_b58}` (the page's `parseKeyText` reads
 * exactly these; the seat file of `--export-seat-key` also holds the WALLET keypair, which the page must never be shown, so it is left
 * out). Written next to the key file as KEYS/presenter-key.json, mode 600, one line (a pasted multi-line JSON would fill the textarea).
 * Throws when the file is not a seat key file (the seed must give the listed session public key). Never logs the key.
 */
export function writePresenterKey({ keyFile, outFile = path.join(path.dirname(keyFile), PRESENTER_KEY_FILE) }) {
  const key = loadSeatKey(keyFile);
  const j = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const out = { wallet: key.wallet, session: key.sessionB58, session_keypair_b58: j.session_keypair_b58 };
  const tmp = `${outFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, outFile);
  try { fs.chmodSync(outFile, 0o600); } catch { /* the mode of the temp file already holds */ }
  return outFile;
}

/** PUB/seat/live.json: what the footage may say about the live seat. No key, no ballot, no option. */
export function liveRecordOf(log, now) {
  const f = log.finalise;
  return {
    v: 1, kind: 'seat-live', mode: 'live', scripted: false, casts_ballots: false, origin: 0, nation: NATION,
    label: { ...SEAT_LIVE_LABEL }, statement: SEAT_LIVE_STATEMENT,
    finalise: f ? { status: f.status ?? null, final: Boolean(f.final), final_bell: f.final_bell ?? null, attempts: f.attempts ?? 0, by: 'run harness' } : null,
    updated_unix: Math.floor(now() / 1000),
  };
}
function makeLivePublisher(aiDir, now) {
  const file = path.join(aiDir, 'pub', 'seat', 'live.json');
  let last = null;
  return (log) => {
    try {
      const rec = liveRecordOf(log, now);
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

/** The bells of council period k (contract 6.5): C0 = k * period + offset; motions [C0, C0+3), ballots [C0+3, C0+6), close at C0+6, strike S = C0+6+lead, open at S+2. */
export function councilSchedule(council = {}, k) {
  const period = council.period ?? 48, offset = council.offset ?? 12, lead = council.strike_lead ?? 6;
  const c0 = k * period + offset;
  return { k, c0, motions_from: c0, motions_to: c0 + 2, ballots_from: c0 + 3, ballots_to: c0 + 5, close: c0 + 6, follow_from: c0 + 6, strike: c0 + 6 + lead, opens: c0 + 6 + lead + 2 };
}
/** Real milliseconds in one bell: bell_secs of game time at `scale`x. */
export const bellMsOf = (config = {}) => (Number(config.time?.bell_secs ?? 600) / Number(config.time?.scale ?? 10)) * 1000;
const defaultClock = (ms) => new Date(ms).toLocaleTimeString('en-GB');
/** Estimated clock times of the next councils from the bell now (`nowMs` falls somewhere inside `bell`, so the error is up to one bell; the page's bell chip is exact). */
export function scheduleLines({ bell, nowMs, config = {}, periods = 3, clock = defaultClock }) {
  const bm = bellMsOf(config);
  const at = (b) => clock(nowMs + (b - bell) * bm).slice(0, 5);
  const lines = [];
  for (let k = 1; lines.length < periods && k < 200; k++) {
    const c = councilSchedule(config.council, k);
    if (c.close < bell) continue;
    lines.push(`period ${k}: motions from about ${at(c.motions_from)} (bell ${c.motions_from}); BALLOT WINDOW about ${at(c.ballots_from)} to ${at(c.close)} (bells ${c.ballots_from} to ${c.ballots_to}); strike about ${at(c.strike)} (bell ${c.strike}); the order opens about ${at(c.opens)} (bell ${c.opens})`);
  }
  return lines;
}

/**
 * The live seat's loop. All I/O is injected like `runSeat`; there is NO `postJson`: this loop cannot cast a ballot or write a message.
 *   getJson(url) -> object, bellNow() -> bell (null before genesis), sleep(ms), finaliser (createSeatFinaliser({mode: 'live'})), say(line)
 * Each poll: one finaliser step (the seat's village must count as final before C0), then a read of the nation-0 council; a line is
 * printed when a period changes state (motion window, BALLOT WINDOW, closed: adopted or why not). It ends on the stop file or signal, an
 * end bell or (tests only) maxPolls, never on a poll count by default. Returns the private log (AI_DIR/seat/seat-live-log.json).
 */
export async function runSeatLive({ aiDir, social, key, config = {}, getJson, bellNow, sleep, pollMs = 3000, maxPolls = null, endBell = null, shouldStop = null, now = () => Date.now(), finaliser = null, say = (m) => console.log(m), clock = defaultClock }) {
  const out = (m) => { try { say(`[${clock(now())}] ${m}`); } catch { /* a log failure must not stop the seat */ } };
  const log = { v: 1, kind: 'seat-live-log', mode: 'live', scripted: false, casts_ballots: false, ballot_label: { ...SEAT_LIVE_LABEL }, statement: SEAT_LIVE_STATEMENT, nation: NATION, origin: 0, season: null, seat_wallet_listed: false, started_unix: Math.floor(now() / 1000), finalise: null, councils: [], notes: [] };
  const file = path.join(aiDir, 'seat', LIVE_LOG_FILE);
  const publish = makeLivePublisher(aiDir, now);
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(log, null, 1)); publish(log); };
  const strikeLead = config.council?.strike_lead ?? 6;
  out(`seat: ${SEAT_LIVE_LABEL.en}; it finalises the seat's village and watches the council of nation ${NATION}`);
  save();
  const seen = new Map(); // period -> last state announced
  let roster = null;
  let lastBell = null;
  let scheduled = false;
  for (let i = 0; ; i++) {
    const why = await stopReason({ i, bell: lastBell, maxPolls, endBell, shouldStop });
    if (why) { log.notes.push(why); break; }
    if (!roster?.season) {
      roster = readJson(path.join(aiDir, 'pub/roster.json'));
      if (roster?.season != null) {
        if (roster.seat?.wallet && roster.seat.wallet !== key.wallet) throw new Error('seat: the key file is not the roster seat');
        if (roster.seat?.scripted === true) throw new Error('seat: the roster marks the seat scripted, but this is a live seat run (start the run without --seat-script)');
        log.season = roster.season;
        log.seat_wallet_listed = Boolean(roster.seat);
        save();
      }
    }
    let st = null;
    try { st = await getJson(`${social}/f/ai/council?faction=${NATION}`); } catch { st = null; }
    const bell = await bellNow();
    lastBell = bell;
    await finaliseTick(finaliser, bell, log, save);
    if (!scheduled && bell != null && bell >= 0) {
      scheduled = true; // once: the clock times of the next councils (estimates; the page's bell chip is exact)
      for (const l of scheduleLines({ bell, nowMs: now(), config, clock })) out(`seat (live): ${l}`);
    }
    if (st?.period != null && st.state && bell != null && bell >= 0 && seen.get(st.period) !== st.state) {
      seen.set(st.period, st.state);
      const c0 = st.c0 ?? (st.closes_bell != null ? st.closes_bell - 6 : null);
      const k = st.period;
      const fin = finaliser?.state?.() ?? null;
      // A missing finaliser (it could not start, or --finalise 0) counts as NOT final: the village then stays provisional and the presenter is refused NotEligible.
      const finWarning = !fin ? `. WARNING: the seat's village is not being finalised (the finaliser is not running); the presenter would be refused NotEligible in this period`
        : fin.final ? '' : `. WARNING: the seat's village is not final (${fin.status}); the presenter would be refused NotEligible in this period`;
      const strike = st.strike_bell ?? (c0 != null ? c0 + 6 + strikeLead : null);
      let line = null;
      if (st.state === 'motions') {
        const wall = (b) => clock(now() + (b - bell) * bellMsOf(config)).slice(0, 5);
        line = `council of nation ${NATION}, period ${k}: OPEN at bell ${bell}. Motions until the end of bell ${c0 + 2}; BALLOT WINDOW bells ${c0 + 3} to ${c0 + 5} (about ${wall(c0 + 3)} to ${wall(c0 + 6)}; closes at bell ${c0 + 6}); ${(st.options ?? []).length} option(s)`;
        line += finWarning;
      } else if (st.state === 'ballots') line = `council of nation ${NATION}, period ${k}: BALLOT WINDOW OPEN at bell ${bell}: the presenter votes on the council page now (last bell to vote: ${c0 + 5}); ballots cast so far: ${st.ballots_cast ?? 0}${finWarning}`;
      else if (st.state === 'closed') {
        line = st.adopted
          ? `council of nation ${NATION}, period ${k}: CLOSED, Strike Order ADOPTED; strike at bell ${strike}, it opens at bell ${strike + 2}; read the sealed order on the page (members only)`
          : `council of nation ${NATION}, period ${k}: CLOSED, no Strike Order (${st.reason ?? 'no reason given'})`;
      }
      if (line) { out(`seat (live): ${line}`); log.councils.push({ period: k, state: st.state, bell, c0, adopted: st.state === 'closed' ? Boolean(st.adopted) : null, reason: st.reason ?? null, ballots_cast: st.ballots_cast ?? null }); save(); }
    }
    publish(log);
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
  const live = a.live !== undefined && a.live !== '0';
  if (live && ab) { console.error('seat: --live (the presenter votes on the page) cannot be combined with --arm (the A/B script casts the ballot)'); process.exit(2); }
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
  // seat eligibility fix: the seat finalises its own village (a Build of walls through the relay, signed with its session key) so that it
  // is on the council's eligible list at C0. `--finalise 0` turns it off; `--relay URL` names the relay (default: the herald's /gw proxy).
  let finaliser = null;
  if (a.finalise !== '0') {
    try {
      const relay = (a.relay ?? `${a.herald.replace(/\/+$/, '')}/gw`).replace(/\/+$/, '');
      assertLoopbackUrl(relay, 'relay');
      const io = await makeChainFinaliserIO({ herald: a.herald.replace(/\/+$/, ''), relay, key, seed: loadSeatSeed(path.resolve(a['key-file'])) });
      finaliser = createSeatFinaliser({ readSeat: io.readSeat, sendWalls: io.sendWalls, quotaLeft: io.quotaLeft, mode: live ? 'live' : 'scripted' });
    } catch (e) { console.error(`seat: the village finaliser could not start (${String(e?.message ?? e).slice(0, 200)}); the seat's village may stay provisional and its ballot be refused NotEligible`); }
  }
  if (live) {
    // the presenter's key in the form the page takes (no wallet secret): KEYS/presenter-key.json, written once the fleet has exported the seat key
    try { const f = writePresenterKey({ keyFile: path.resolve(a['key-file']) }); console.log(`seat (live): the presenter key for the council page is ${f}`); } catch (e) { console.error(`seat (live): the presenter key file could not be written (${String(e?.message ?? e).slice(0, 160)})`); }
    const log = await runSeatLive({ aiDir, social, key, config, getJson, bellNow, sleep, shouldStop, endBell, finaliser });
    console.log(JSON.stringify({ mode: log.mode, scripted: false, casts_ballots: false, councils: log.councils.length, finalise: log.finalise?.status ?? null, stopped: log.notes.at(-1) ?? null }));
    process.exit(0);
  }
  if (!ab) {
    const log = await runSeatScript({ aiDir, social, key, config, getJson, postJson, bellNow, sleep, shouldStop, endBell, finaliser });
    console.log(JSON.stringify({ mode: log.mode, scripted: true, ballots: log.periods.map((p) => ({ period: p.period, option: p.option, rule: p.rule, ok: p.ok })), skipped: log.skipped_periods.length, stopped: log.notes.at(-1) ?? null }));
    process.exit(0);
  }
  let feed = null;
  try {
    const { createFeed } = await import('../watcher/feed.mjs');
    feed = createFeed({ herald: a.herald, roster: readJson(path.join(aiDir, 'pub/roster.json')) });
  } catch { feed = null; }
  const log = await runSeat({ arm: a.arm, rep: Number(a.rep), aiDir, social, key, config, getJson, postJson, bellNow, sleep, shouldStop, endBell, finaliser, observeAt: feed ? async (p, q, b) => { for (let i = 0; i < 5; i++) { const r = await feed.poll(); if (r.ok) break; } const d = await feed.clashDetail(p, q, b); if (d) { try { d.camp_lost = campLoss(await feed.provinceAt(p, q, b - 1), await feed.provinceAt(p, q, b))?.lost; } catch { /* the hosts' losses stand alone */ } } return d; } : null });
  console.log(JSON.stringify({ arm: log.arm, rep: log.rep, period: log.period, option_x: log.option_x, ballot: log.ballot && { option: log.ballot.option, ok: log.ballot.ok }, observed: Boolean(log.observed) }));
  process.exit(log.ballot?.ok ? 0 : 1);
}
