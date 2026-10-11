// The nation council's store (contract §6.5 steps 2–5 and 7; user-facing name
// "Strike Order", code name Call, §0.4): periods the watcher opens with their
// three code-made options, the motion and ballot windows, the tally, the
// human-present rule, the sealed Call and its member read, and the opening at
// S + 2. Candidates (step 1) and the tile and invited list (step 6) are the
// watcher's: it hands them in through `open` and `seal` (or through the
// `fixCall` hook), and gives the strike result back through `setResult`.
//
// Periods: C0 = k·P + offset. Motion window [C0, C0+3), ballot window
// [C0+3, C0+6), closed from C0+6; the Strike Order lands at S = C0 + 6 +
// strike_lead and opens at S + 2. `period` in every record and route is k.
//
// Ballots stay hidden (leaves only, in the talk files and `ballots_cast`)
// until the Call opens, or until the close when no Call was adopted. The Call
// itself (option, tile, invited, nonce) is readable by members only until
// S + 2. Everything is public; no pact exists here (Appendix A.5).
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIND, ORIGIN, splitMotionRef, sha256, toBase64, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { Refusal, finalHolding, writeJson } from './book.mjs';

export const MOTION_BELLS = 3;
export const BALLOT_BELLS = 3;
export const CLOSE_AFTER = MOTION_BELLS + BALLOT_BELLS;
export const MAX_INVITED = 6;
export const OPEN_AFTER_STRIKE = 2;

// ------------------------------------------------------------------ canonical JSON and hashes
/** Compact JSON with object keys sorted (arrays keep their order): the form every hash below is taken over. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const shaHex = s => toHex(sha256(s));
/** sha256 of the canonical JSON of the options with their values (the ballot commits to it). */
export const candidatesHash = candidates => shaHex(canonicalJson(candidates));
/** sha256 of the canonical JSON of `[{option, kind, p, q}]` only (value, own, ratio omitted: the A/B pair rule uses it, §9.3). */
export const optionsHash = candidates => shaHex(canonicalJson(candidates.map(({ option, kind, p, q }) => ({ option, kind, p, q }))));
/** call_commit = sha256(canonical {option, p, q, tile} ‖ nonce32), hex. */
export const callCommit = ({ option, p, q, tile }, nonce) => toHex(sha256(canonicalJson({ option, p, q, tile }), typeof nonce === 'string' ? Uint8Array.from(Buffer.from(nonce, 'hex')) : nonce));

/** Period k and its C0 for the bell (`null` before the first period). */
export function periodAt(bell, { period: P, offset = 0 }) {
  const k = Math.floor((bell - offset) / P);
  return k >= 1 ? { k, c0: k * P + offset } : null;
}

const refuse = (code, detail) => { throw new Refusal(code, detail); };
const keyOf = (k, f) => `${k}|${f}`;

/**
 * `createCouncil({aiDir, book, config, clock, fixCall, random})`.
 *
 * - `config`: `{period, offset, strike_lead, human_present}` (§6.5).
 * - `fixCall({faction, period, c0, option, kind, p, q, voters}) → {tile, invited} | null` (the watcher's `closeCall`, async allowed), called once when a Call is adopted; without it the watcher calls `seal` itself.
 * - `random(n) → bytes` for the nonce (tests inject a fixed one).
 */
export function createCouncil({ aiDir = null, book, config, clock, fixCall = null, random = randomBytes } = {}) {
  const cfg = { period: 48, offset: 12, strike_lead: 6, human_present: true, ...config };
  const dir = aiDir ? join(aiDir, 'pub', 'council') : null;
  const journalPath = aiDir ? join(aiDir, 'state', 'social', 'council.jsonl') : null;
  const periods = new Map();
  const listeners = new Set();
  const emit = (type, payload) => { for (const fn of listeners) { try { fn({ type, ...payload }); } catch { /* a listener never breaks the council */ } } };
  const journal = e => { if (!journalPath) return; mkdirSync(dirname(journalPath), { recursive: true }); appendFileSync(journalPath, `${JSON.stringify(e)}\n`); };

  const stateOf = (P, bell) => (P.outcome ? 'closed' : bell === null || bell < P.c0 ? 'none' : bell < P.c0 + MOTION_BELLS ? 'motions' : bell < P.c0 + CLOSE_AFTER ? 'ballots' : 'closed');

  // ----------------------------------------------------------------- views and files
  const motionView = m => ({ id: m.id, wallet: m.wallet, tag: m.tag, name: book.nameOf(m.tag, m.entry), option: m.option, text: m.rec.redacted ? '' : m.rec.text, origin: m.origin, ai_written: m.origin === ORIGIN.ai, ai_roster: m.kind === 'ai', bell: m.bell, inner: m.inner });
  function publicOf(P) {
    const closed = P.outcome !== null;
    return {
      v: 1, period: P.period, faction: P.faction, c0: P.c0, closes_bell: P.c0 + CLOSE_AFTER,
      candidates: P.candidates, candidates_hash: P.candidates_hash, options_hash: P.options_hash,
      motions: P.motions.map(motionView),
      ballots: closed ? [...P.ballots.values()].map(b => ({ inner: b.inner, wallet: b.wallet })) : [],
      ballots_cast: P.ballots.size,
      tally_split: closed ? P.outcome.split : null,
      adopted: closed ? P.outcome.adopted : false,
      reason: closed ? P.outcome.reason : null,
      sealed: !!P.call,
      strike_bell: closed && P.outcome.adopted ? P.c0 + CLOSE_AFTER + cfg.strike_lead : null,
      follow_from: closed && P.outcome.adopted ? P.c0 + CLOSE_AFTER : null,
      call_commit: P.call?.commit ?? null,
      ...(P.openFile ? { open: P.openFile } : {}),
      ...(P.result ? { result: P.result } : {}),
    };
  }
  /** Council files are `PUB/council/<k>-<f>.json`; current.json lists per nation only `{period, adopted, S, call_commit}`. */
  function write(P) {
    if (!dir) return;
    writeJson(join(dir, `${P.period}-${P.faction}.json`), publicOf(P));
    const latest = new Map();
    for (const Q of periods.values()) if (!latest.has(Q.faction) || latest.get(Q.faction).period < Q.period) latest.set(Q.faction, Q);
    writeJson(join(dir, 'current.json'), {
      v: 1,
      nations: [...latest.values()].sort((a, b) => a.faction - b.faction).map(Q => {
        const v = publicOf(Q);
        return { faction: Q.faction, period: Q.period, adopted: v.adopted, S: v.strike_bell, call_commit: v.call_commit };
      }),
    });
  }

  // ----------------------------------------------------------------- open
  /**
   * Open period `period` (k) of `faction` with its options (≤ 3, option numbers 1..n,
   * `{option, kind, p, q, value, own, ratio}`). Idempotent for identical options. `eligible`
   * (optional wallets, fixed at C0 by the watcher) overrides the herald-based voter check;
   * `humans` (optional wallets) adds eligible non-AI voters the service has not seen.
   * No options = no council that period (returns null).
   */
  function open({ faction, period, c0, candidates, candidates_hash, options_hash, eligible = null, humans = [] }) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    if (candidates.length > 3) throw new Error('at most three options');
    candidates.forEach((c, i) => { if (c.option !== i + 1) throw new Error('options are numbered 1..n in order'); });
    const ch = candidatesHash(candidates);
    const oh = optionsHash(candidates);
    if (candidates_hash !== undefined && candidates_hash !== ch) throw new Error('candidates_hash does not match the candidates');
    if (options_hash !== undefined && options_hash !== oh) throw new Error('options_hash does not match the candidates');
    const k = keyOf(period, faction);
    const had = periods.get(k);
    if (had) {
      if (had.candidates_hash !== ch) throw new Error('this period is already open with other options');
      return publicOf(had);
    }
    const P = {
      faction, period, c0: c0 ?? period * cfg.period + cfg.offset, candidates, candidates_hash: ch, options_hash: oh,
      eligible: eligible ? new Set(eligible) : null, humans: [...humans], motions: [], motionBy: new Set(), ballots: new Map(),
      outcome: null, voters: null, call: null, openFile: null, result: null, closing: null,
    };
    periods.set(k, P);
    journal({ t: 'open', faction, period, c0: P.c0, candidates, eligible, humans });
    write(P);
    emit('council_open', { faction, period, c0: P.c0, candidates_hash: ch, options_hash: oh });
    return publicOf(P);
  }

  // ----------------------------------------------------------------- the hooks into the book (checks, then commit)
  const eligibleVoter = (P, ctx) => (P.eligible ? P.eligible.has(ctx.wallet) : Number(ctx.me.citizen.faction) === P.faction && ctx.me.holdings.some(h => finalHolding(h, ctx.unix)));

  function check(ctx) {
    if (ctx.type === 'talk' && ctx.rec.kind === KIND.motion) {
      const { period, option } = splitMotionRef(ctx.rec.ref);
      const P = periods.get(keyOf(period, ctx.faction));
      if (!P) refuse('WindowClosed', 'there is no council for this nation and period');
      if (stateOf(P, ctx.bell) !== 'motions') refuse('WindowClosed', 'the motion window is not open');
      if (option > P.candidates.length) refuse('BadBytes', 'no such option');
      if (!eligibleVoter(P, ctx)) refuse('NotEligible', 'only citizens with a final village at the start of the period may move an option');
      if (P.motionBy.has(ctx.wallet)) refuse('Duplicate', 'one motion per period');
    } else if (ctx.type === 'ballot') {
      const r = ctx.rec;
      if (r.faction !== ctx.faction) refuse('NotMember', 'a ballot is for the sender\'s own nation');
      const P = periods.get(keyOf(r.period, r.faction));
      if (!P) refuse('WindowClosed', 'there is no council for this nation and period');
      if (stateOf(P, ctx.bell) !== 'ballots') refuse('WindowClosed', 'the ballot window is not open');
      if (!eligibleVoter(P, ctx)) refuse('NotEligible', 'only citizens with a final village at the start of the period may vote');
      if (toHex(r.candidates_hash) !== P.candidates_hash) refuse('BadBytes', 'candidates_hash is not this period\'s');
      if (r.option > P.candidates.length) refuse('BadBytes', 'no such option');
      if (P.ballots.has(ctx.wallet)) refuse('Duplicate', 'one ballot per period; the first counts');
    }
  }
  function apply(rec) {
    if (rec.type === 'talk' && rec.dec.kind === KIND.motion) {
      const { period, option } = splitMotionRef(rec.dec.ref);
      const P = periods.get(keyOf(period, rec.faction));
      if (!P || P.motionBy.has(rec.wallet)) return null;
      P.motionBy.add(rec.wallet);
      P.motions.push({ id: rec.id, wallet: rec.wallet, tag: rec.tag, entry: rec.entry, kind: rec.kindOfWallet, option, origin: rec.origin, bell: rec.bell, inner: rec.inner, rec });
      return P;
    }
    if (rec.type === 'ballot') {
      const P = periods.get(keyOf(rec.dec.period, rec.dec.faction));
      if (!P || P.ballots.has(rec.wallet)) return null;
      P.ballots.set(rec.wallet, { id: rec.id, wallet: rec.wallet, kind: rec.kindOfWallet, option: rec.dec.option, origin: rec.origin, inner: rec.inner, rec });
      return P;
    }
    return null;
  }
  function commit(rec) {
    const P = apply(rec);
    if (!P) return;
    write(P);
    if (rec.type === 'talk') emit('motion', { faction: P.faction, period: P.period, id: rec.id, wallet: rec.wallet, tag: rec.tag, option: splitMotionRef(rec.dec.ref).option });
    else emit('ballot', { faction: P.faction, period: P.period, ballots_cast: P.ballots.size });
  }
  book.setHooks({
    check,
    commit,
    redacted(rec) { for (const P of periods.values()) if (P.motions.some(m => m.rec === rec)) write(P); },
  });

  // ----------------------------------------------------------------- the tally and the close
  /** The count per option (0 = none) and per origin over the ballots cast so far. */
  function tally(P) {
    const per = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const split = { ai: 0, human: 0, scripted: 0 };
    for (const b of P.ballots.values()) {
      per[b.option]++;
      split[b.origin === ORIGIN.ai ? 'ai' : b.origin === ORIGIN.scripted ? 'scripted' : 'human']++;
    }
    return { per, split };
  }
  /** Eligible non-AI voters the service can name for this period: the seat, the watcher's list, and non-AI wallets that posted a motion or ballot. */
  async function humanVoters(P) {
    const set = new Set(P.humans);
    const seat = book.rosterNow().seat;
    if (seat && seat.faction === P.faction) {
      if (P.eligible) { if (P.eligible.has(seat.wallet)) set.add(seat.wallet); } else {
        const me = await book.resolveMe(seat.wallet);
        const unix = Math.floor(clock.unix());
        // Fail closed: when the herald cannot be asked the seat counts as present (an outage must not switch the rule off).
        if (me.ok ? Number(me.citizen.faction) === P.faction && me.holdings.some(h => finalHolding(h, unix)) : me.code === 'HeraldUnavailable') set.add(seat.wallet);
      }
    }
    for (const b of P.ballots.values()) if (b.kind !== 'ai') set.add(b.wallet);
    for (const m of P.motions) if (m.kind !== 'ai') set.add(m.wallet);
    return set;
  }
  /** The §6.5 step 5 decision, a pure function of the counts. */
  function decide({ per }, ballots, humansPresent) {
    const top = Math.max(per[1], per[2], per[3]);
    if (top < 2) return { adopted: false, reason: 'quorum' };
    const leaders = [1, 2, 3].filter(o => per[o] === top);
    if (leaders.length > 1) return { adopted: false, reason: 'tie' };
    if (per[0] > top) return { adopted: false, reason: 'none_wins' };
    if (per[0] === top) return { adopted: false, reason: 'tie' };
    const option = leaders[0];
    if (cfg.human_present && humansPresent && ![...ballots.values()].some(b => b.option === option && (b.origin === ORIGIN.human || b.origin === ORIGIN.scripted))) return { adopted: false, reason: 'human_present' };
    return { adopted: true, reason: 'adopted', option };
  }

  async function closePeriod(P) {
    if (P.outcome) return;
    const t = tally(P);
    const humans = await humanVoters(P);
    if (P.outcome) return;
    const d = decide(t, P.ballots, humans.size > 0);
    P.outcome = { ...d, split: t.split, per: t.per };
    if (d.adopted) {
      const c = P.candidates[d.option - 1];
      P.winner = { option: d.option, kind: c.kind, p: c.p, q: c.q };
      P.voters = { 1: [], 2: [], 3: [] };
      for (const b of P.ballots.values()) if (b.option > 0) P.voters[b.option].push(b.wallet);
    } else {
      P.openFile = openFileOf(P, false);
    }
    journal({ t: 'close', faction: P.faction, period: P.period, adopted: d.adopted, reason: d.reason, option: d.option ?? null, split: t.split, per: t.per });
    write(P);
    emit('council_closed', { faction: P.faction, period: P.period, adopted: d.adopted, reason: d.reason, strike_bell: d.adopted ? P.c0 + CLOSE_AFTER + cfg.strike_lead : null, tally_split: t.split });
    if (d.adopted && fixCall) {
      try {
        const fixed = await fixCall({ faction: P.faction, period: P.period, c0: P.c0, ...P.winner, voters: P.voters });
        if (fixed?.tile !== undefined) seal(P.faction, P.period, fixed);
      } catch (e) { P.sealError = String(e?.message ?? e); }
    }
  }

  /** What the open record shows: the Call (when there is one), the tally per option and every ballot's bytes. */
  function openFileOf(P, withCall) {
    return {
      ...(withCall ? { option: P.call.option, kind: P.call.kind, p: P.call.p, q: P.call.q, tile: P.call.tile, nonce: P.call.nonce, invited: P.call.invited } : { adopted: false }),
      tally: P.outcome.per,
      ballots: [...P.ballots.values()].map(b => (b.rec.redacted ? { inner: b.inner, bytes_b64: '', sig_b64: '', redacted: true } : { inner: b.inner, bytes_b64: toBase64(b.rec.bytes), sig_b64: toBase64(b.rec.sig) })),
    };
  }

  /**
   * Seal the adopted Call (the watcher's step 6): `{tile, invited}` fixed from the
   * herald's immutable files at the close. Draws the nonce, publishes `call_commit`.
   * `invited` is at most six host ids in the pinned order.
   */
  function seal(faction, period, { tile, invited, nonce }) {
    const P = periods.get(keyOf(period, faction));
    if (!P?.outcome?.adopted) throw new Error('no adopted Call for this nation and period');
    if (P.call) throw new Error('this Call is sealed already');
    if (!Array.isArray(invited) || invited.length > MAX_INVITED) throw new Error(`invited: at most ${MAX_INVITED} host ids`);
    if (!Number.isInteger(tile)) throw new Error('tile: an integer');
    const nonceBytes = nonce ? Uint8Array.from(Buffer.from(nonce, 'hex')) : Uint8Array.from(random(32));
    if (nonceBytes.length !== 32) throw new Error('nonce: 32 bytes');
    const w = P.winner;
    P.call = { option: w.option, kind: w.kind, p: w.p, q: w.q, tile, invited: invited.map(String), nonce: toHex(nonceBytes), commit: callCommit({ option: w.option, p: w.p, q: w.q, tile }, nonceBytes), strike_bell: P.c0 + CLOSE_AFTER + cfg.strike_lead, follow_from: P.c0 + CLOSE_AFTER };
    journal({ t: 'seal', faction, period, call: P.call });
    write(P);
    emit('call_sealed', { faction, period, strike_bell: P.call.strike_bell, call_commit: P.call.commit });
    return { call_commit: P.call.commit, strike_bell: P.call.strike_bell };
  }

  function openCall(P) {
    if (P.openFile || !P.call) return;
    P.openFile = openFileOf(P, true);
    journal({ t: 'opened', faction: P.faction, period: P.period });
    write(P);
    emit('call_opened', { faction: P.faction, period: P.period });
  }

  /** The strike result the watcher computes at S + 2 (`{present, bounced, clash}`): stored and published as `result`. */
  function setResult(faction, period, result) {
    const P = periods.get(keyOf(period, faction));
    if (!P) throw new Error('no such period');
    P.result = result;
    journal({ t: 'result', faction, period, result });
    write(P);
  }

  /** Close what is due at the clock's bell: windows end, Calls open at S + 2. Safe to call often. */
  async function tick(bell = clock.bell()) {
    if (bell === null || bell === undefined) return;
    for (const P of [...periods.values()]) {
      if (!P.outcome && bell >= P.c0 + CLOSE_AFTER) await (P.closing ??= closePeriod(P).finally(() => { P.closing = null; }));
      if (P.call && !P.openFile && bell >= P.call.strike_bell + OPEN_AFTER_STRIKE) openCall(P);
    }
  }

  // ----------------------------------------------------------------- reads
  const latestOf = faction => { let best = null; for (const P of periods.values()) if (P.faction === faction && (!best || P.period > best.period)) best = P; return best; };
  /** `GET /f/ai/council?faction=<f>[&period=k]` (§8.2): the public state of a nation's latest (or given) period; no secrets (ballots_cast only until the close). */
  function publicState(faction, period = null) {
    const P = period === null ? latestOf(faction) : periods.get(keyOf(period, faction));
    if (!P) return { period: null, faction, state: 'none', options: [], motions: [], ballots_cast: 0, closes_bell: null, adopted: false, strike_bell: null, call_commit: null };
    const { candidates, ...rest } = publicOf(P);
    const bell = clock.bell();
    return { ...rest, state: stateOf(P, bell), options: candidates };
  }
  /** The sealed Call of one nation (members only; the route checks membership): the latest sealed period unless `period` is given. */
  function memberCall(faction, period = null) {
    let P = null;
    if (period !== null) P = periods.get(keyOf(period, faction));
    else for (const Q of periods.values()) if (Q.faction === faction && Q.call && (!P || Q.period > P.period)) P = Q;
    if (!P) return null;
    if (!P.outcome) return null;
    if (!P.outcome.adopted || !P.call) return null;
    const c = P.call;
    return { faction, period: P.period, option: c.option, kind: c.kind, p: c.p, q: c.q, tile: c.tile, strike_bell: c.strike_bell, follow_from: c.follow_from, invited: [...c.invited], nonce: c.nonce, call_commit: c.commit, opened: !!P.openFile };
  }
  /** Internal, for the watcher (step 6): who voted for which option. Never published, never in a prompt. */
  function winner(faction, period) {
    const P = periods.get(keyOf(period, faction));
    if (!P?.outcome) return null;
    return P.outcome.adopted ? { adopted: true, c0: P.c0, ...P.winner, voters: P.voters } : { adopted: false, reason: P.outcome.reason, c0: P.c0 };
  }

  // ----------------------------------------------------------------- start: replay the council journal, then the records
  if (journalPath && existsSync(journalPath)) {
    const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const e of lines) {
      const P = periods.get(keyOf(e.period, e.faction));
      if (e.t === 'open') {
        periods.set(keyOf(e.period, e.faction), {
          faction: e.faction, period: e.period, c0: e.c0, candidates: e.candidates, candidates_hash: candidatesHash(e.candidates), options_hash: optionsHash(e.candidates),
          eligible: e.eligible ? new Set(e.eligible) : null, humans: e.humans ?? [], motions: [], motionBy: new Set(), ballots: new Map(), outcome: null, voters: null, call: null, openFile: null, result: null, closing: null,
        });
      } else if (e.t === 'close' && P) {
        P.outcome = { adopted: e.adopted, reason: e.reason, option: e.option ?? undefined, split: e.split, per: e.per };
        if (e.adopted) {
          const c = P.candidates[e.option - 1];
          P.winner = { option: e.option, kind: c.kind, p: c.p, q: c.q };
        }
      } else if (e.t === 'seal' && P) P.call = e.call;
      else if (e.t === 'result' && P) P.result = e.result;
    }
    for (const rec of book.records) apply(rec);
    for (const P of periods.values()) {
      if (P.outcome && P.winner) { P.voters = { 1: [], 2: [], 3: [] }; for (const b of P.ballots.values()) if (b.option > 0) P.voters[b.option].push(b.wallet); }
      if (P.outcome && !P.outcome.adopted) P.openFile = openFileOf(P, false);
    }
    for (const e of lines) if (e.t === 'opened') { const P = periods.get(keyOf(e.period, e.faction)); if (P?.call) P.openFile = openFileOf(P, true); }
  }

  return {
    open, seal, setResult, tick, publicState, memberCall, winner, periodAt: bell => periodAt(bell, cfg), config: cfg,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** The period record (for the watcher and tests): read-only use. */
    periodOf: (faction, period) => periods.get(keyOf(period, faction)) ?? null,
    publicOf: (faction, period) => { const P = periods.get(keyOf(period, faction)); return P ? publicOf(P) : null; },
    latest: latestOf,
    tally: (faction, period) => { const P = periods.get(keyOf(period, faction)); return P ? tally(P) : null; },
  };
}
