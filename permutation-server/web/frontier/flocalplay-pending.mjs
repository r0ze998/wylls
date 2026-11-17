// TEST-ONLY local play, the ordinary march's test entry only: "press now, send when ready" (2026-11-14).
//
// On a capture-demo world at ×60 a turn is 10 s, and the seal of a march is possible only while the origin province has
// settled the previous turn (fmarch.mjs checkMarch: NotResident — the program's own rule — and NotFinal). Those moments
// fell under one second, so a person's press often missed them. This module lets ONE press arm ONE pending send of the
// exact order the player composed; the page sends that order once, the first moment every check passes. Nothing is
// loosened: the same checks, the same send (controller.mjs sendTheMarch: one attempt, no resend), the same key.
//
// The order is frozen when armed (`intentOf`): world, wallet, holding, host, troops, origin, destination, route, arrival
// turn, stance, retreat, tip. If any of it is different at the moment it could be sent — the arrival turn included, which
// moves when a turn passes — the pending send is withdrawn and the player is told; nothing is changed silently.
// It is withdrawn too when the march's own gate closes (world ended or expired, gate, a march held by its signature), when
// an earlier send's outcome is unknown, after its turn limit, on any problem that is not a settling one, or on cancel.
// It lives in the page's memory only (on FS.compose): a reload never revives it.

/** The only problems a pending send may wait through: the province settling its previous turn. */
export const SETTLE_CODES = Object.freeze(['NotResident', 'NotFinal']);
/** At most this many turns after it was armed; then it is withdrawn. */
export const PENDING_MAX_TURNS = 2;
/** How often the page looks while a send is pending (ms). */
export const PENDING_TICK_MS = 100;

/**
 * The order's identity: everything the send would carry or depend on, as one string. `null` when anything needed is
 * missing (nothing can be armed or sent then). `m` is screens/march.mjs composerMarch's answer.
 */
export function intentOf({ world, wallet, holding, host, origin, m }) {
  if (typeof world !== 'string' || !world || typeof wallet !== 'string' || !wallet || !holding || !host || !origin || !m) return null;
  const route = m.route && Array.isArray(m.route.dirs) ? { dirs: m.route.dirs.join(''), provinces: (m.route.provinces ?? []).map(p => `${p.p},${p.q}`).join(';') } : null;
  if (!route || !m.dest || !Number.isInteger(m.arriveBell)) return null;
  return JSON.stringify({
    world, wallet,
    holding: [holding.p, holding.q, holding.site, holding.gen ?? null],
    host: String(host.id), troops: host.troops ?? null, unit: host.unit ?? null,
    origin: [origin.p, origin.q, host.tile ?? null],
    dest: [m.dest.p, m.dest.q, m.dest.tile],
    route, arriveBell: m.arriveBell, stance: m.stance ?? null,
    retreat: m.retreat ? [m.retreat.choice ?? null, m.retreat.ratio ?? null] : null,
    tip: m.tip === undefined || m.tip === null ? null : String(m.tip),
  });
}

/** Whether a press may arm a pending send: there are problems, and every one is a settling one. */
export function pendable(problems) {
  return Array.isArray(problems) && problems.length > 0 && problems.every(p => SETTLE_CODES.includes(p));
}

/** A pending send, armed now for this exact order. */
export function armPending({ intent, nowBell }) {
  if (typeof intent !== 'string' || !intent || !Number.isInteger(nowBell)) return null;
  return Object.freeze({ intent, armedBell: nowBell, untilBell: nowBell + PENDING_MAX_TURNS });
}

/**
 * One look at a pending send → `{act: 'wait'}`, `{act: 'send'}` or `{act: 'withdraw', why}`. `open`: the march's own gate
 * (FS.localMarch.open: capability, readiness, gate, village, no held march); `held`: an earlier send of this host whose
 * outcome is unknown; `busy`: a send in flight. The caller withdraws the pending send BEFORE it sends (never twice).
 */
export function pendingStep(p, { intent, problems, nowBell, open, held, busy, sameCard }) {
  if (!p) return { act: 'withdraw', why: 'none' };
  // (an unknown earlier outcome first: the march's gate is closed then too (LocalMarchHeld), and the player is told the
  //  same as the page's guide says — nothing is sent again)
  if (held) return { act: 'withdraw', why: 'unknown' };
  if (open !== true) return { act: 'withdraw', why: 'closed' };
  if (sameCard !== true) return { act: 'withdraw', why: 'changed' };
  if (intent !== p.intent) return { act: 'withdraw', why: 'changed' };
  if (!Number.isInteger(nowBell) || nowBell > p.untilBell) return { act: 'withdraw', why: 'expired' };
  if (busy) return { act: 'wait' };
  if (!Array.isArray(problems)) return { act: 'withdraw', why: 'problem' };
  if (problems.length === 0) return { act: 'send' };
  if (pendable(problems)) return { act: 'wait' };
  return { act: 'withdraw', why: 'problem' };
}

/** While a send is pending: the origin province is read again (read only) at most this often, one read at a time. */
export const PENDING_REFRESH_MS = 400;

/**
 * The pending send's driver. Everything it touches is given, so its calls can be counted:
 * - `look(card)` → `{intent, problems, nowBell, open, held, busy, sameCard, keyAlive, endsAt}`: the order as it is now
 *   (the same functions the card uses), the march's gate, an unknown earlier outcome, a send in flight, whether the card is
 *   still the page's card, whether the page's memory-only key is alive, and the world's absolute end (ms, this machine's clock);
 * - `refresh(card)`: ONE read-only read of the origin province (never a write, never a send);
 * - `send(card)`: the ordinary single send, called at most once per arming;
 * - `withdrawn(card, why)`: told once per arming when it ends without a send;
 * - `onPageHide(f)` → an undo: the page being hidden for good (pagehide) withdraws at once.
 * A refresh that resolves after the send was withdrawn, sent, or armed again never sends (its generation is old).
 */
export function createPendingDriver({ look, refresh, send, withdrawn, now = () => Date.now(), setTimer = (f, ms) => setInterval(f, ms), clearTimer = id => clearInterval(id), onPageHide = null, tickMs = PENDING_TICK_MS, refreshMs = PENDING_REFRESH_MS }) {
  let armed = null, gen = 0, timer = null, refreshing = false, lastRefresh = -Infinity, hideOff = null;
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } if (hideOff) { const off = hideOff; hideOff = null; off(); } };
  const end = () => { const a = armed; armed = null; gen += 1; stop(); return a; };
  const withdraw = why => { if (!armed) return; const a = end(); withdrawn(a.card, why); };
  function tick() {
    if (!armed) return;
    const a = armed, s = look(a.card) ?? {};
    if (s.keyAlive !== true) return withdraw('closed');
    if (!Number.isFinite(s.endsAt) || now() >= s.endsAt) return withdraw('closed');
    const step = pendingStep(a.pending, s);
    if (step.act === 'withdraw') return withdraw(step.why);
    if (step.act === 'send') { end(); send(a.card); return; }
    // waiting: one read-only read at a time, not more often than refreshMs; its answer counts only for this arming
    if (!refreshing && now() - lastRefresh >= refreshMs) {
      const mine = gen; refreshing = true; lastRefresh = now();
      let read; try { read = Promise.resolve(refresh(a.card)); } catch { read = Promise.resolve(); }
      read.catch(() => null).then(() => { refreshing = false; if (mine === gen && armed === a) tick(); });
    }
  }
  return Object.freeze({
    /** Arms one pending send for `card` (refused while another is armed). */
    arm(card, pending) {
      if (armed || !card || !pending) return false;
      armed = { card, pending }; gen += 1; timer = setTimer(tick, tickMs);
      if (onPageHide) hideOff = onPageHide(() => withdraw('closed'));
      return true;
    },
    cancel(why = 'cancel') { withdraw(why); },
    tick,
    get armed() { return armed?.card ?? null; },
    get refreshing() { return refreshing; },
  });
}
