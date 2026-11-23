// ⑬ local resident's memory and journal (2026-11-22): one state file, written by rename (permutation-gateway config.mjs
// createStateStore: temp file 0600, fsync, rename, fsync of the directory), so a decision, its journal line and the
// memory it changed move together. KEY-FREE: no key material is ever written here (the key file is the client's own).
//
// The rule that keeps a restarted resident from acting twice (resident.mjs's durable-execution rule, for the page's
// local route):
//   1 a line `intended` is saved BEFORE anything is asked of the relay, keyed by the turn: `b<bell>`;
//   2 the transaction's signature is saved (state `signed`) inside the signing step, BEFORE the one submit;
//   3 after the submit: `sent`, then `landed` / `failed` / `unknown` by its signature (followed, never sent again).
// On restart: an `intended` line has no signature, so nothing of it can have reached the chain: it becomes `not-sent`.
// A `signed` / `sent` / `unknown` line is followed by its signature; while it is open (and younger than
// OPEN_LINE_MS) no new order is made at all. One line per turn that got further than `not-sent`: a second is never
// made in that turn (the world's rule, owner Q16-2; the relay's ResidentAlreadyActed is the world's own guard on top).
import { createStateStore } from '../../../../permutation-gateway/src/config.mjs';
import path from 'node:path';

export const STATE_SCHEMA = 'ws13-local-resident-state/1';
/** How long an open line (signed, sent, unknown) blocks new orders: past a local blockhash's life (≈150 slots). */
export const OPEN_LINE_MS = 120_000;
export const OPEN_STATES = Object.freeze(['signed', 'sent', 'unknown']);
export const FINAL_STATES = Object.freeze(['landed', 'failed', 'refused', 'not-sent', 'expired-unknown']);
const KEEP_LINES = 96;
/** Attempts in one turn that never reached the chain (not-sent) before the resident lets the turn go. */
export const MAX_ATTEMPTS_PER_TURN = 3;

export function freshState({ wallet, goal, nation }) {
  return { schema: STATE_SCHEMA, wallet, goal, nation, world: null, decisions: 0, acted: 0, wakeInterval: 1, nextDecisionBell: -1, lastActBell: -1, lastTouchBell: null,
    day: { n: -1, acts: 0 }, failures: {}, triedHomes: [], journal: {}, worlds: 0, village: null, refusals: {} };
}

/**
 * Open (or make) the resident's state in `dir`. A state of another wallet or schema is refused (never overwritten).
 * `goal` / `nation` given here are the charter's; a stored state keeps its own unless they are the same.
 */
export function openState({ dir, wallet, goal, nation, store = null }) {
  const s = store ?? createStateStore(path.join(dir, 'state.json'));
  const st = s.load();
  if (st === null) { s.save(freshState({ wallet, goal, nation })); return s; }
  if (st.schema !== STATE_SCHEMA) throw new Error(`state.json is not a ${STATE_SCHEMA}`);
  if (st.wallet !== wallet) throw new Error('state.json belongs to another wallet');
  if (st.goal !== goal || st.nation !== nation) throw new Error(`state.json was made with goal ${st.goal} and nation ${st.nation}: use a new directory to change them`);
  return s;
}

/**
 * A new world (another program, Season or genesis): the world's own memory starts again (journal, failures, homes
 * tried, turns, the village's landed builds and resource refusals: brain.mjs `village` / `refusals`); the resident's goal, nation and allowance of decisions stay. → true when it was a new world.
 */
export function enterWorld(st, worldKey) {
  if (st.world === worldKey) return false;
  Object.assign(st, { world: worldKey, journal: {}, failures: {}, triedHomes: [], ticket: null, village: null, refusals: {}, oreSeen: null, wide: null, nextDecisionBell: -1, lastActBell: -1, lastTouchBell: null, wakeInterval: 1, day: { n: -1, acts: 0 }, worlds: (st.worlds ?? 0) + 1 });
  return true;
}

/** Restart: an `intended` line never got a signature, so it never left: `not-sent`. → the keys changed. */
export function settleIntendedOnOpen(st) {
  const changed = [];
  for (const [k, l] of Object.entries(st.journal)) if (l.state === 'intended') { l.state = 'not-sent'; l.why = 'restart: no signature was recorded, so nothing was submitted'; changed.push(k); }
  return changed;
}

export const openLines = st => Object.entries(st.journal).filter(([, l]) => OPEN_STATES.includes(l.state)).map(([k, l]) => ({ key: k, ...l }));

/**
 * Whether a new order may be made in turn `bell` now (`nowMs` wall clock for an open line's age). → null or why not.
 */
export function blockedWhy(st, bell, nowMs) {
  const open = openLines(st).filter(l => nowMs - (l.signedAtMs ?? 0) < OPEN_LINE_MS);
  if (open.length) return `an earlier order is not settled yet (turn ${open[0].bell}, ${open[0].state}): no new order until it is`;
  if (st.lastActBell >= bell) return `already acted in turn ${st.lastActBell} (one action per turn)`;
  const line = st.journal[`b${bell}`];
  if (line && line.state !== 'not-sent') return `this turn's line is ${line.state} (one action per turn)`;
  if (line && line.attempts >= MAX_ATTEMPTS_PER_TURN) return `${line.attempts} attempts in turn ${bell} never reached the relay: the next turn`;
  return null;
}

export function beginLine(st, bell, cand, nowMs) {
  // (a Join has its own line: the world does not count it as the turn's action, so the turn's order gets `b<bell>`)
  const key = cand.kind === 'join' ? `b${bell}:join` : `b${bell}`;
  const prev = st.journal[key];
  // (external-wide-orders: a wide claim's site and a wide march's summary ride along — the reconcile's memory needs them)
  st.journal[key] = { bell, id: cand.id, kind: cand.kind, order: cand.order.name, fields: cand.order.fields, ...(cand.site ? { site: cand.site } : {}), ...(cand.meta ? { meta: cand.meta } : {}),
    state: 'intended', at: nowMs, attempts: (prev?.attempts ?? 0) + 1 };
  return key;
}

export function prune(st) {
  const keys = Object.keys(st.journal).sort((a, b) => st.journal[a].bell - st.journal[b].bell);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_LINES))) if (!OPEN_STATES.includes(st.journal[k].state)) delete st.journal[k];
}
