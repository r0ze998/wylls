// Local play only: ONE player-signed step at a time for the host the expedition card observes, and ONE record of the
// observations a step was sent on, shared by every step module (the return's Dissolve / Return in
// flocalplay-return.mjs, the siege's DeclareSiege in flocalplay-conquest.mjs).
//
// Without this each module only guarded itself: from the same observation a Dissolve and a DeclareSiege could each be
// prepared, and while one was being signed, submitted or of unknown outcome, the other could still be sent. Both act
// on the same host, so the second would be signed over a state the first may already have changed.
//
// The rule, per page state:
//   * while ANY step is in flight (preparing, signing, submitting) or its outcome is not settled (submitted, unknown),
//     no OTHER step may be prepared or sent: `HostStepInFlight`;
//   * a step that is merely prepared (unsigned) does not block: preparing another step DISCARDS it, so two prepared
//     messages never stand side by side, and the discarded one can no longer be sent;
//   * an observation any step was sent on is used up for EVERY step until the card reads again.
//
// Memory only. Nothing here signs, sends or stores; it holds no message and no key.
const steps = new Map();       // name → probe(fs) → {busy, open, prepared, discard()}
const spent = new WeakMap();   // fs → the report object a step was last sent on

/**
 * A step module announces itself once: `probe(fs)` → `{busy, open, prepared, discard}`.
 *   busy      a run of this step is in progress (preparing, signing, submitting, asking for status)
 *   open      its outcome is not settled (submitted or unknown)
 *   prepared  it holds a prepared, unsigned message
 *   discard() forget that prepared message (called when another step is prepared)
 */
export function registerHostStep(name, probe) {
  if (typeof name !== 'string' || !name || typeof probe !== 'function' || steps.has(name)) throw new Error('bad host step');
  steps.set(name, probe);
}
/**
 * FAIL CLOSED: what a step says about itself is believed only in its exact shape (three booleans and a function).
 * A probe that throws, or answers null, `{}`, a truthy non-boolean or anything else, is a step whose state is not
 * known, and a step whose state is not known is treated as in flight: nothing else may be prepared or sent beside it.
 */
const UNKNOWN = Object.freeze({ busy: true, open: true, prepared: false, discard() { throw new Error('unknown step'); }, known: false });
function stateOf(probe, fs) {
  let s; try { s = probe(fs); } catch { return UNKNOWN; }
  if (s === null || typeof s !== 'object' || typeof s.busy !== 'boolean' || typeof s.open !== 'boolean' || typeof s.prepared !== 'boolean' || typeof s.discard !== 'function') return UNKNOWN;
  return s;
}
const others = (fs, me) => [...steps].filter(([name]) => name !== me).map(([name, probe]) => [name, stateOf(probe, fs), probe]);

/** The step, other than `me`, that is in flight, of unsettled outcome, or of unknown state: its name, or null. */
export function hostStepInFlight(fs, me) {
  for (const [name, s] of others(fs, me)) if (s.busy || s.open) return name;
  return null;
}
/**
 * `me` is about to prepare: refused (`HostStepInFlight`) while another step is in flight or unsettled; otherwise every
 * other step's merely prepared message is discarded, and `me` may go on.
 */
export function claimHostStep(fs, me) {
  if (!steps.has(me)) throw Object.assign(new Error('HostStepUnknown'), { code: 'HostStepUnknown' });
  if (hostStepInFlight(fs, me) !== null) throw Object.assign(new Error('HostStepInFlight'), { code: 'HostStepInFlight' });
  // (a prepared message that cannot be forgotten, or is still there after being told to go, still stands: the claim
  // fails, and `me` prepares nothing beside it)
  for (const [, s, probe] of others(fs, me)) {
    if (!s.prepared) continue;
    try { s.discard(); } catch { throw Object.assign(new Error('HostStepInFlight'), { code: 'HostStepInFlight' }); }
    const after = stateOf(probe, fs);
    if (after.busy || after.open || after.prepared) throw Object.assign(new Error('HostStepInFlight'), { code: 'HostStepInFlight' });
  }
}
/** `me` is about to sign or send: no other step may be in flight, unsettled, of unknown state, or even prepared. */
export function holdHostStep(fs, me) {
  if (!steps.has(me)) throw Object.assign(new Error('HostStepUnknown'), { code: 'HostStepUnknown' });
  if (hostStepInFlight(fs, me) !== null) throw Object.assign(new Error('HostStepInFlight'), { code: 'HostStepInFlight' });
  for (const [, s] of others(fs, me)) if (s.prepared) throw Object.assign(new Error('HostStepInFlight'), { code: 'HostStepInFlight' });
}
/** The observation (the card's report object) a step is being sent on is used up for every step. */
export function spendHostObservation(fs, report) { if (fs && report) spent.set(fs, report); }
/** Whether `report` is the observation some step was already sent on. */
export const hostObservationSpent = (fs, report) => !!fs && !!report && spent.get(fs) === report;
