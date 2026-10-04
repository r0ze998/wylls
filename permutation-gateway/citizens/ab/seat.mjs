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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBallot, signRecord, fromBase58, toBase58, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { assertLoopbackUrl } from '../mind/guards.mjs';

export const BALLOT_AT = 4; // C0 + 4 (the ballot window is [C0 + 3, C0 + 6))
export const OBSERVE_AFTER_STRIKE = 3; // read the clash report at S + 3
export const ORIGIN_SCRIPTED = 2;
export const NATION = 0; // the seat's nation; the A/B is nation 0 only

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

/**
 * The seat's loop. All I/O is injected so a test runs it in a few milliseconds:
 *   getJson(url) -> object, postJson(url, body) -> {status, body}, bellNow() -> bell (null before genesis), sleep(ms),
 *   observeAt(p, q, bell) -> clashDetail-like or null.
 */
export async function runSeat({ arm, rep, aiDir, social, key, config = {}, getJson, postJson, bellNow, sleep, observeAt = null, pollMs = 3000, maxPolls = 400, now = () => Date.now() }) {
  if (arm !== 'A' && arm !== 'B') throw new Error('seat: --arm A or B');
  const roster = readJson(path.join(aiDir, 'pub/roster.json'));
  const season = roster?.season;
  if (season == null) throw new Error('seat: pub/roster.json has no season (the registrar writes it after the deal)');
  const aiWallets = new Set((roster.ai ?? []).filter((a) => a.faction === NATION).map((a) => a.wallet));
  if (roster.seat?.wallet && roster.seat.wallet !== key.wallet) throw new Error('seat: the key file is not the roster seat');
  const log = { v: 1, kind: 'ab-seat', arm, rep, nation: NATION, origin: ORIGIN_SCRIPTED, season, seat_wallet_listed: Boolean(roster.seat), started_unix: Math.floor(now() / 1000), period: null, option_x: null, ai_mover: null, ballot: null, observed: null, skipped_periods: [], notes: [] };
  const file = path.join(aiDir, 'ab', `seat-${arm}-${rep}.json`);
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(log, null, 1)); };
  const seenNoMotion = new Set();
  let state = null;
  for (let i = 0; i < maxPolls; i++) {
    let st = null;
    try { st = await getJson(`${social}/f/ai/council?faction=${NATION}`); } catch { st = null; }
    const bell = await bellNow();
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
        log.ballot = { option, bell, status: r.status, ok: r.status === 200, inner: body.inner, origin: ORIGIN_SCRIPTED, code: r.body?.code ?? null };
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
  log.notes.push(`gave up after ${maxPolls} polls`);
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
  for (const k of ['arm', 'rep', 'ai-dir', 'herald', 'social', 'key-file']) if (!a[k]) { console.error(`seat: --${k} is required`); process.exit(2); }
  assertLoopbackUrl(a.herald, 'herald');
  assertLoopbackUrl(a.social, 'social');
  const aiDir = path.resolve(a['ai-dir']);
  const config = a.config ? readJson(path.resolve(a.config)) ?? {} : {};
  const key = loadSeatKey(path.resolve(a['key-file']));
  const getJson = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
  const postJson = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const { bellOf } = await import('../scenario/census.mjs');
  const bellNow = async () => { try { return bellOf(await getJson(`${a.herald}/h/season`)); } catch { return null; } };
  let feed = null;
  try {
    const { createFeed } = await import('../watcher/feed.mjs');
    feed = createFeed({ herald: a.herald, roster: readJson(path.join(aiDir, 'pub/roster.json')) });
  } catch { feed = null; }
  const log = await runSeat({ arm: a.arm, rep: Number(a.rep), aiDir, social: a.social.replace(/\/+$/, ''), key, config, getJson, postJson, bellNow, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), observeAt: feed ? async (p, q, b) => { for (let i = 0; i < 5; i++) { const r = await feed.poll(); if (r.ok) break; } return feed.clashDetail(p, q, b); } : null });
  console.log(JSON.stringify({ arm: log.arm, rep: log.rep, period: log.period, option_x: log.option_x, ballot: log.ballot && { option: log.ballot.option, ok: log.ballot.ok }, observed: Boolean(log.observed) }));
  process.exit(log.ballot?.ok ? 0 : 1);
}
