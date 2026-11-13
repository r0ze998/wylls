// A LIMITED TEST CAPABILITY for one disposable live-connection run of the conquest routes
// (docs/integration/FABLE-CONQUEST-LIVE-CONNECT-TEST-PLAN-20261112.md §3).
//
// What it is: a statement, made by a TEST ENTRY for one run, that the run proceeds PAST named opening conditions that
// are not established — on a synthetic memory-only world, for at most 240 seconds, for one runner instance, one
// wallet, one loopback RPC in the test port range, one artefact. It names what is unconfirmed; it does not confirm it.
//
// What it is not: an opening. `CONQUEST_OPEN_CONDITIONS` stays as it is before, during and after; a run that passes
// under this object establishes nothing by itself. It is not the launcher's world capability either (that one says
// which world can be besieged; this one says a test may proceed there despite unconfirmed conditions) — both are
// required together.
//
// Who can give it: only code that calls `createLocalPlayConquest({…, testCapability})` directly. The relay's command
// line (local-play-relay-server.mjs) has no argument for it and the launcher never builds one; tests pin that the
// word does not appear in either. A page URL cannot carry it.
//
// Pure checks: no clock but the `now` given, no network, no key.
import { CONQUEST_ARTIFACT_CURRENT } from './conquest-table-read.mjs';

export const TEST_CAPABILITY_SCHEMA = 'frontier-local-play-conquest-test-capability-v1';
export const TEST_CAPABILITY_PURPOSE = 'live-connect-test';
/** The longest a test capability may live, from the moment it is checked: the run's whole wall. */
export const TEST_CAPABILITY_MAX_MS = 240000;
/** The loopback ports a test run may use: the fixture range, never the launcher's 41000-41999. */
export const TEST_PORT_MIN = 47000, TEST_PORT_MAX = 47999;
const KEYS = Object.freeze(['schema', 'purpose', 'synthetic', 'unconfirmed', 'artifact_sha256', 'runner_instance', 'rpc', 'wallet', 'expires_at_ms']);
const HEX64 = /^[0-9a-f]{64}$/;

/** The port of `url` when it is exactly `http://127.0.0.1:<port>` with a port of the test range, else null. */
export function testLoopbackPort(url) {
  const m = typeof url === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{4})$/.exec(url) : null;
  const port = m ? Number(m[1]) : NaN;
  return Number.isInteger(port) && port >= TEST_PORT_MIN && port <= TEST_PORT_MAX ? port : null;
}

/**
 * Why `tc` does not let THIS relay proceed, or [] when it does.
 *   cfg             the relay's closed configuration (its `rpc`, `wallet`)
 *   capability      the world capability of this start (already checked against `cfg`); its artefact must be the same
 *   runnerInstance  the instance this relay is pinned to (64 hex); none → refused: a status answer could not be tied to the run
 *   unconfirmed     the names of the opening conditions that are not established NOW — `tc.unconfirmed` must be exactly
 *                   these, in this order: a capability that names fewer hides one, one that names more is stale
 *   now             milliseconds
 */
export function testCapabilityProblems(tc, { cfg, capability, runnerInstance, unconfirmed, now }) {
  if (tc === null || typeof tc !== 'object' || Array.isArray(tc) || Object.keys(tc).length !== KEYS.length || !KEYS.every(k => Object.hasOwn(tc, k))) return ['test capability must have exactly ' + KEYS.join(', ')];
  const out = [];
  if (tc.schema !== TEST_CAPABILITY_SCHEMA) out.push('schema');
  if (tc.purpose !== TEST_CAPABILITY_PURPOSE) out.push('purpose');
  if (tc.synthetic !== true) out.push('synthetic must be true: a test capability is only for a synthetic world');
  if (!Array.isArray(unconfirmed) || unconfirmed.length === 0) out.push('nothing is unconfirmed: a test capability has nothing to proceed past');
  else if (!Array.isArray(tc.unconfirmed) || tc.unconfirmed.length !== unconfirmed.length || tc.unconfirmed.some((k, i) => k !== unconfirmed[i])) out.push('unconfirmed must name exactly: ' + unconfirmed.join(', '));
  if (typeof tc.artifact_sha256 !== 'string' || tc.artifact_sha256 !== CONQUEST_ARTIFACT_CURRENT) out.push('artifact is not the current one');
  if (capability === null || typeof capability !== 'object' || capability.artifact_sha256 !== tc.artifact_sha256) out.push('artifact is not the world capability\'s');
  if (typeof runnerInstance !== 'string' || !HEX64.test(runnerInstance) || /^0{64}$/.test(runnerInstance)) out.push('this relay is not pinned to a runner instance');
  else if (tc.runner_instance !== runnerInstance) out.push('runner_instance is not this relay\'s');
  if (testLoopbackPort(tc.rpc) === null) out.push(`rpc must be http://127.0.0.1:<${TEST_PORT_MIN}-${TEST_PORT_MAX}>`);
  if (tc.rpc !== cfg?.rpc) out.push('rpc is not this relay\'s runner');
  if (typeof tc.wallet !== 'string' || tc.wallet !== cfg?.wallet) out.push('wallet is not this relay\'s');
  if (!Number.isSafeInteger(now)) out.push('no clock');
  else if (!Number.isSafeInteger(tc.expires_at_ms) || tc.expires_at_ms <= now) out.push('expired');
  else if (tc.expires_at_ms - now > TEST_CAPABILITY_MAX_MS) out.push(`expires more than ${TEST_CAPABILITY_MAX_MS} ms from now`);
  return out;
}

/** Whether `tc` (already accepted) is past its end at `now`. An unreadable clock counts as past. */
export const testCapabilityExpired = (tc, now) => !Number.isSafeInteger(now) || now >= tc.expires_at_ms;

/**
 * The LIFETIME of one accepted test capability: `{alive()}`.
 *   - two clocks, either one ends it: the wall clock against `expires_at_ms`, AND a monotonic deadline fixed when the
 *     lifetime is made (`mono() + (expires_at_ms - now())`, at most 240 s). Setting the wall clock back does not
 *     lengthen the run: the monotonic deadline still falls.
 *   - a LATCH: once it has been found over — by either clock, or because a clock could not be read — it is over for
 *     good. No later reading, of any clock, brings it back.
 * `now` is the wall clock in ms; `mono` a monotonic clock in ms (performance.now). Made only after
 * `testCapabilityProblems` accepted `tc` at this same `now`.
 */
export function createTestLifetime(tc, { now, mono }) {
  const t0 = now(), m0 = mono();
  const span = Number.isSafeInteger(t0) && Number.isFinite(m0) ? tc.expires_at_ms - t0 : NaN;
  let over = !(span > 0 && span <= TEST_CAPABILITY_MAX_MS);
  const deadline = m0 + span;
  return Object.freeze({
    alive() {
      if (over) return false;
      const t = now(), m = mono();
      if (!Number.isSafeInteger(t) || !Number.isFinite(m) || t >= tc.expires_at_ms || m >= deadline || m < m0) over = true;
      return !over;
    },
    /**
     * Milliseconds left, for display: the SMALLER of what the wall clock and the monotonic deadline leave, never
     * more than the span it was made with, 0 once over. A wall clock set back does not make it grow.
     */
    /** End it now, for good (the entry is closing): the same latch — nothing after this is alive. */
    end() { over = true; },
    remainingMs() {
      if (!this.alive()) return 0;
      const left = Math.min(tc.expires_at_ms - now(), deadline - mono(), span);
      return Number.isFinite(left) && left > 0 ? Math.floor(left) : 0;
    },
  });
}

/**
 * ONE TEST RUN for several relays (Stage A: Depart, Reveal, the preview, beside the conquest routes): the test
 * capability is checked once against this relay's pins, ONE lifetime is made, and every flow of the run asks that
 * same lifetime — one run, one end, never lengthened (a second `createTestRun` is a second check of the same
 * `expires_at_ms`, not more time).
 * → `{alive(), live(), within(work), relay, reveal, rpcOk, public}`:
 *   live()        throws `ConquestTestCapabilityExpired` (410) once the run is over
 *   within(work)  asks on entry, runs `work`, asks again: an answer OR a refusal that would cross the end is not given
 *   relay         `{sendGuard, rpcOk}` for `createLocalPlayRelay({…, test})` (the Depart flow)
 *   reveal        `{sendGuard, rpcOk, instance}` for `createLocalPlayReveal({…, test})`
 *   rpcOk         for `createLocalPlayPreview({…, testRpcOk})`
 *   public        what the page is shown (`testCapabilityPublic`)
 * Throws when the capability does not hold for this relay. `expired` makes the error a route answers with.
 */
// `life` (optional): a lifetime that ALREADY RUNS — the entry's own, made when the entry started. With it the run does
// not make a second one: its monotonic deadline is the one fixed at the entry's start, so nothing that happened to the
// wall clock between the start and this call (set back, then a capability checked against the earlier reading) can
// give the run more real time. Without it a lifetime is made here, from now.
export function createTestRun(tc, { cfg, capability, runnerInstance, unconfirmed, now, mono, expired, life: given = null }) {
  const problems = testCapabilityProblems(tc, { cfg, capability, runnerInstance, unconfirmed, now: now() });
  if (problems.length) throw new Error('test run refused (test capability: ' + problems.join('; ') + ')');
  if (typeof expired !== 'function') throw new Error('test run refused: no expiry error');
  if (given !== null && (typeof given.alive !== 'function' || typeof given.remainingMs !== 'function' || !given.alive())) throw new Error('test run refused: the lifetime given is over or is not one');
  const frozen = Object.freeze({ ...tc, unconfirmed: Object.freeze([...tc.unconfirmed]) });
  const life = given ?? createTestLifetime(frozen, { now, mono });
  const live = () => { if (!life.alive()) throw expired(); };
  const within = async work => { live(); let r; try { r = await work(); } catch (e) { live(); throw e; } live(); return r; };
  const rpcOk = url => testLoopbackPort(url) !== null;
  return Object.freeze({ alive: () => life.alive(), live, within, rpcOk, relay: Object.freeze({ sendGuard: live, rpcOk }),
    reveal: Object.freeze({ sendGuard: live, rpcOk, instance: runnerInstance }), public: testCapabilityPublic(frozen),
    remainingMs: () => life.remainingMs() });
}

/**
 * What a test entry may show the page of an accepted test capability: that this is a test on a synthetic world, what
 * is not confirmed, and when it ends — and the identity the page must itself match (wallet, artefact). The runner
 * instance and the RPC address stay with the relay.
 */
export const testCapabilityPublic = tc => Object.freeze({ schema: tc.schema, purpose: tc.purpose, synthetic: true, unconfirmed: Object.freeze([...tc.unconfirmed]),
  artifact_sha256: tc.artifact_sha256, wallet: tc.wallet, expires_at_ms: tc.expires_at_ms });
