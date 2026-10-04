// Constants of the memory feature (contract §5). One place, so the episode
// producer, the retrieval, the ledger and the card agree.
//
// Time: a bell is 10 minutes of game time and a game day is 144 bells
// (`ArrivalDay` checks `day == floor(bell / 144)`, herald.mjs parseEnvelope;
// SHIELD_SECS = 48 h = 288 bells, contract §0.5).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const BELL_SECS = 600;
export const DAY_BELLS = 144;
export const dayOf = bell => Math.floor(bell / DAY_BELLS);

// Episodes (§5.2).
export const EPISODE_VERSION = 1;
export const EPISODE_CAP = 200;
export const HOSTILE_EVAL_LAG = 2; // a hostile act is evaluated at b + 2 (§6.4)
export const HOSTILE_WAIT = 12; // unresolved data waits up to 12 bells, then `unknown` (§6.4)
export const DM_WINDOW_BELLS = 6; // one `dm` episode per sender per 6-bell window
export const DM_PER_DAY = 6;
export const THREAT_RADIUS = 3; // provinces from the AI's home (§3.2, §5.2)
export const NATION_MATE_RADIUS = 2; // provinces from the AI's home (§5.1)
export const IMPORTANCE = Object.freeze({
  attacked_own: 8, strike: 6, clash_own_win: 6, clash_own_loss: 6, camp_cleared_own: 5,
  camp_taken_by: 5, threat: 5, dm: 4, motion: 4, council_result: 4, build_done: 2,
});
export const KINDS = Object.freeze(Object.keys(IMPORTANCE));

// Retrieval (§5.2).
export const HALF_LIFE_BELLS = 72;
export const RETRIEVE_TOP = 8;
export const RETRIEVE_GRIEVANCE_SOURCES = 3;
export const RETRIEVE_NEWEST = 3;

// Ledger (§5.1).
export const TRUST_CODE_HOSTILE_ACT = -15;
export const TRUST_CODE_NATION_MATE = -5;
export const TRUST_CODE_ADOPTED_MOVER = 2;
export const GRIEVANCE_WEIGHT = 8;
export const MODEL_DELTA_MAX = 10;
export const MODEL_DAILY_MAX = 15;
export const GRIEVANCE_ANSWER_BELLS = 12;
export const MAX_GRIEVANCES = 5; // shown on the card
export const MAX_TRUST_EPISODE_IDS = 24;

export const sha256hex = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest('hex');
};
export const readJson = url => JSON.parse(readFileSync(url, 'utf8'));
export const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** Canonical JSON: keys sorted recursively, no whitespace (used for hashes). */
export function canonical(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
  return `{${Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
}
