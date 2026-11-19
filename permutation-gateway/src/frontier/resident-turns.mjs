// ONE ACTION PER RESIDENT PER TURN (owner decision 2026-11-18 21:44, Q16-2): a resident's own MCP/external agent,
// the operator AI runner, the ⑬ resident loop, the owner's browser — any two writers — must not both act for the same
// resident in the same turn. The first writer in a turn wins; every other gets `ResidentAlreadyActed` with the turn.
//
// THE TURN is the chain's bell, exactly as the program counts it (permutation-rules frontier::beacon `bell_at`,
// web clock.mjs `bellAt`): bell = floor((t − Season.GENESIS_TS) / 600), t = the Clock sysvar's unix_timestamp, no bell
// before genesis. Never the local clock: a local-play chain may run on a synthetic clock far from it.
//
// THE LEASE is one file per (resident, bell): `<dir>/<citizen>/<bell>`, created with O_CREAT|O_EXCL ('wx') and fsynced
// before the claim is answered. So:
//   - two writers in ONE process: the claim is synchronous (no await between the check and the create);
//   - two writers in two PROCESSES on this machine (two gateways, a gateway and a relay, two relays of one wallet)
//     that are given the same directory: the filesystem decides, exactly one create succeeds;
//   - a RESTART keeps every lease (the file is on disk before anything is signed or sent);
//   - a claim whose action is then refused BEFORE its bytes leave is released (the file is removed), so a refused
//     action does not spend the resident's turn; once the bytes may have left, the lease stays for good.
// Any filesystem failure other than "already there" refuses the action (`ResidentTurnUnavailable`): fail closed.
// Leases of bells older than the previous one are removed, for that resident, when it next claims.
import fs from 'node:fs';
import path from 'node:path';

export const RESIDENT_ALREADY_ACTED = 'ResidentAlreadyActed';
export const RESIDENT_TURN_UNAVAILABLE = 'ResidentTurnUnavailable';
/** Seconds per bell: permutation-rules travel.rs BELL_SECS, web clock.mjs BELL_SECS (pinned by the tests). */
export const BELL_SECS = 600;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOURCE = /^[a-z0-9][a-z0-9:._-]{0,39}$/;

/** The bell containing chain time `t` (unix seconds) of a Season that began at `genesisTs`, or null before genesis. */
export function bellAt(genesisTs, t) {
  const g = Number(genesisTs), now = Number(t);
  if (!Number.isSafeInteger(g) || !Number.isSafeInteger(now)) throw new TypeError('bellAt: integer seconds');
  return now < g ? null : Math.floor((now - g) / BELL_SECS);
}

/**
 * One action per resident per turn (Q16-2, owner decision 2026-11-18 21:44), with `ctx.residentTurns`
 * (this module): whether this sponsored write is a RESIDENT's action, and so takes the resident's turn lease.
 * It is when it comes through the agent wallet (`viaAgent`: the operator runner, the resident's own MCP, the ⑬
 * resident loop, the owner's browser command — every source of POST /f/agent/action), or when the Citizen it acts for
 * has an agent in auto mode (`ctx.agents.residentCitizen`, agent/gateway.mjs): the owner's own page then shares the resident. A human's
 * Citizen without such an agent is not a resident: unaffected. Settles (anyone may crank) and Joins (no resident yet)
 * are no turn action.
 */
export function residentTurnOf(ctx, shape, { viaAgent = false, limitKind = 'relay' } = {}) {
  if (!ctx.residentTurns || limitKind !== 'relay' || shape.kind === 'settle' || !shape.authority) return null;
  const citizen = shape.accounts?.citizen ?? null;
  if (typeof citizen !== 'string') return null;
  if (viaAgent || ctx.agents?.residentCitizen?.(citizen) === true) return citizen;
  return null;
}

export class ResidentTurnError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}

/**
 * The lease over `dir` (absolute; made if missing). → `{dir, claim({citizen, bell, source}), held(citizen, bell)}`.
 * `claim` → a ticket `{citizen, bell, source, release(), sent(signature)}`, or throws ResidentTurnError
 * (`ResidentAlreadyActed` with `{bell, citizen, by}`; `ResidentTurnUnavailable`). `io` (tests): the fs functions used.
 */
export function createResidentTurns({ dir, io = fs, now = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw new Error('resident turns: dir must be an absolute path');
  io.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (citizen, bell) => path.join(dir, citizen, String(bell));
  const readHolder = file => { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; } };
  const prune = (citizen, bell) => {
    let names = [];
    try { names = io.readdirSync(path.join(dir, citizen)); } catch { return; }
    for (const n of names) if (/^\d+$/.test(n) && Number(n) < bell - 1) { try { io.unlinkSync(path.join(dir, citizen, n)); } catch { /* best effort */ } }
  };
  return Object.freeze({
    dir,
    claim({ citizen, bell, source }) {
      if (typeof citizen !== 'string' || !B58.test(citizen)) throw new TypeError('resident turns: citizen must be a base58 address');
      if (!Number.isSafeInteger(bell) || bell < 0) throw new TypeError('resident turns: bell must be a non-negative integer');
      const src = typeof source === 'string' && SOURCE.test(source) ? source : 'unknown';
      const file = fileOf(citizen, bell);
      let fd;
      try {
        io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fd = io.openSync(file, 'wx', 0o600);
      } catch (e) {
        if (e?.code === 'EEXIST') {
          const by = readHolder(file);
          throw new ResidentTurnError(RESIDENT_ALREADY_ACTED, `this resident already acted in bell ${bell}; it may act again from bell ${bell + 1}`,
            { bell, nextBell: bell + 1, citizen, by: by?.source ?? null });
        }
        throw new ResidentTurnError(RESIDENT_TURN_UNAVAILABLE, 'the resident turn lease cannot be recorded; nothing was sent', { bell, citizen });
      }
      const record = { citizen, bell, source: src, at: now() };
      try { io.writeSync(fd, JSON.stringify(record)); io.fsyncSync(fd); }
      catch {
        try { io.closeSync(fd); } catch { /* closing */ }
        try { io.unlinkSync(file); } catch { /* the lease then stays: fail closed */ }
        throw new ResidentTurnError(RESIDENT_TURN_UNAVAILABLE, 'the resident turn lease cannot be recorded; nothing was sent', { bell, citizen });
      }
      try { io.closeSync(fd); } catch { /* written and synced */ }
      prune(citizen, bell);
      let state = 'held';
      return Object.freeze({
        citizen, bell, source: src,
        /** Before the bytes left: the turn is not spent. Never after `sent`. */
        release() { if (state !== 'held') return; state = 'released'; try { io.unlinkSync(file); } catch { /* stays: fail closed */ } },
        /** The bytes may have left: the lease stays (and names the signature, for the record). */
        sent(signature) {
          if (state !== 'held') return; state = 'sent';
          try { io.writeFileSync(file, JSON.stringify({ ...record, signature: String(signature ?? '') })); } catch { /* the lease itself is already on disk */ }
        },
        state: () => state,
      });
    },
    /** The holder record of (citizen, bell), or null. A read. */
    held(citizen, bell) { return B58.test(String(citizen)) && Number.isSafeInteger(bell) ? readHolder(fileOf(citizen, bell)) : null; },
  });
}
