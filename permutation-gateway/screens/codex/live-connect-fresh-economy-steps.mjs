// The fresh ECONOMY test page's steps (browser; also imported by its tests). TEST ONLY: served by
// live-connect-fresh-economy.mjs. The six commands, each built from what the test runner ANNOUNCED and sent through
// the game's own page-side economy path (flocalplay-act.mjs `submitLocalAct`: the relay's context → the game's SDK
// message → the page's wallet signs → ONE POST → asked about by its signature, never sent again).
// It imports nothing of the fresh Join/Home test's page. Nothing here is the game's own screen.
import { createEphemeralWallet } from '../../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { submitLocalAct, localActRead, postLocalAct } from '../../../permutation-server/web/frontier/flocalplay-act.mjs';

/** Seconds kept below the announced expiry bound (the bound is the test chain's clock + 30 days at the announcement). */
export const E_EXPIRY_MARGIN = 600n;
/** The six, in the runner's order, with the announcement each is built from. */
export const E_ORDER = Object.freeze([['Join', 'prereq-ready-for-join'], ['PlaceHome', 'prereq-ready-for-place-home'], ['Build', 'ready-for-build'], ['Train', 'ready-for-train'], ['Muster', 'ready-for-muster'], ['Harvest', 'ready-for-harvest']]);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const INT = /^-?(0|[1-9][0-9]{0,5})$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const siteOf = c => (object(c) && typeof c.p === 'string' && INT.test(c.p) && typeof c.q === 'string' && INT.test(c.q) && Number.isInteger(c.site) && c.site >= 0 && c.site <= 11 ? { p: Number(c.p), q: Number(c.q), site: c.site } : null);

/** The page's memory-only test wallet (never stored, never sent: only its public key leaves the page). */
export const makeTestWallet = () => createEphemeralWallet({ cluster: 'localnet', localPlay: true });
/** The announcement of `name` among the runner's (each comes at most once), or null. */
export function announced(steps, name) { return (Array.isArray(steps) ? steps.find(s => s?.e_step === name) : null) ?? null; }
/** The nations a Join can name: those with at least one announced home province, ascending. */
export function nationsOf(ready) {
  if (!object(ready) || !Array.isArray(ready.home_provinces)) return [];
  return [...new Set(ready.home_provinces.filter(h => Number.isInteger(h?.nation) && h.nation >= 0 && h.nation <= 5).map(h => h.nation))].sort((a, b) => a - b);
}
/** The sites a PlaceHome can name, as numbers, in the announced order. */
export function sitesOf(ready) { return object(ready) && Array.isArray(ready.candidates) ? ready.candidates.map(siteOf).filter(Boolean) : []; }
/** The announced village as numbers, or null. */
export function villageOf(ready) { return siteOf(ready?.village); }

/**
 * The order of `name` from its announcement `ready` and the player's `choice`, as the game's controller hands one to
 * the local path — ONLY within the announcement (anything else throws, and nothing is built):
 *   Join {faction}; PlaceHome {p, q, site}; Build {item}; Train {unit} (n is the announced one: min_n = max_n);
 *   Muster {troops, tile} (the unit is the announced one); Harvest (no choice).
 * Join's expiry is taken from the announcement, not from this computer's clock: the test season's clock is synthetic.
 */
export function orderOf(name, ready, choice = {}) {
  if (!object(ready)) fail('EconomyNotAnnounced');
  const c = object(choice) ? choice : {};
  if (name === 'Join') {
    if (!nationsOf(ready).includes(c.faction)) fail('EconomyNotAnnouncedChoice');
    if (typeof ready.max_session_expiry !== 'string' || !/^[1-9][0-9]{0,18}$/.test(ready.max_session_expiry)) fail('EconomyBadAnnouncement');
    const expiry = BigInt(ready.max_session_expiry) - E_EXPIRY_MARGIN; if (expiry <= 0n) fail('EconomyBadAnnouncement');
    return { name, v: { faction: c.faction }, fields: { faction: c.faction, session_expiry: expiry } };
  }
  if (name === 'PlaceHome') {
    const at = sitesOf(ready).find(x => x.p === c.p && x.q === c.q && x.site === c.site);
    if (!at) fail('EconomyNotAnnouncedChoice'); if (!Number.isInteger(ready.faction)) fail('EconomyBadAnnouncement');
    return { name, v: { holding: { ...at }, faction: ready.faction }, fields: { ...at } };
  }
  const home = villageOf(ready); if (!home) fail('EconomyBadAnnouncement');
  if (name === 'Build') { if (!Array.isArray(ready.items) || !ready.items.includes(c.item)) fail('EconomyNotAnnouncedChoice'); return { name, v: { holding: home, item: c.item }, fields: { item: c.item } }; }
  if (name === 'Train') {
    if (!Array.isArray(ready.units) || !ready.units.includes(c.unit)) fail('EconomyNotAnnouncedChoice');
    // (the runner announces ONE n: min_n = max_n. A range would be a choice this page does not offer.)
    if (!Number.isInteger(ready.min_n) || ready.min_n !== ready.max_n) fail('EconomyBadAnnouncement');
    return { name, v: { holding: home }, fields: { unit: c.unit, n: ready.min_n } };
  }
  if (name === 'Muster') {
    if (!Number.isInteger(ready.unit) || !Number.isInteger(ready.min_troops) || !Number.isInteger(ready.max_troops) || !Array.isArray(ready.tiles)) fail('EconomyBadAnnouncement');
    if (!Number.isInteger(c.troops) || c.troops < ready.min_troops || c.troops > ready.max_troops || !ready.tiles.includes(c.tile)) fail('EconomyNotAnnouncedChoice');
    return { name, v: { holding: home }, fields: { unit: ready.unit, troops: c.troops, tile: c.tile } };
  }
  if (name === 'Harvest') return { name, v: { holding: home }, fields: undefined };
  return fail('EconomyNotOneOfTheSix');
}

/**
 * One run of the page: `state()` → the entry's latest state (null while the last read of it failed), `signer()` →
 * the page's test wallet, `origin` → this page's own origin. Each command is SENT AT MOST ONCE, and only while the
 * entry's state says it is the current one. → `{send(name, choice), status(name), sent()}`; a send answers
 * `{sent: true, signature}` or `{sent: false, code}`.
 */
export function createEconomyRun({ state, signer, origin, post = postLocalAct }) {
  const sent = Object.fromEntries(E_ORDER.map(([n]) => [n, null])), flying = new Set();
  let identity = null;
  const identityNow = () => { const i = state()?.identity; if (!object(i)) return null; if (identity === null || JSON.stringify(identity) !== JSON.stringify(i)) identity = Object.freeze({ ...i }); return identity; };
  const mine = s => s?.phase === 'ready' && s.wallet === signer()?.address;
  const sendsOpen = () => { const s = state(); return mine(s) && s.send === 'open' && s.world === 'running'; };
  const deps = { allowed: () => (sendsOpen() ? { ok: true, relay: origin } : { ok: false, code: 'LocalActClosed' }), identity: identityNow, rulesetHash: () => state()?.ruleset_hash, signer, post };
  const read = localActRead({ allowed: () => (mine(state()) ? { ok: true, relay: origin } : { ok: false, code: 'LocalActClosed' }), post });
  return Object.freeze({
    async send(name, choice) {
      const row = E_ORDER.find(([n]) => n === name); if (!row) fail('EconomyNotOneOfTheSix');
      if (sent[name] !== null) return { sent: true, signature: sent[name].signature, again: true, ...(sent[name].outcome ? { outcome: sent[name].outcome, relayCode: sent[name].relayCode } : {}) };
      if (flying.size > 0) return { sent: false, code: 'EconomyInFlight' };   // (one press at a time, whatever the command)
      const s = state(), ready = announced(s?.steps, row[1]);
      if (!ready) fail('EconomyNotAnnounced');
      if (s.current !== name) return { sent: false, code: 'EconomyNotTheCurrentCommand' };
      const order = orderOf(name, ready, choice);
      flying.add(name);
      try {
        const r = await submitLocalAct(order, deps);
        if (r.ok !== true) return { sent: false, code: r.code };
        // (an answer the relay gave after the POST began that is not "submitted" — no answer, a refusal at its send, or
        //  any other code — is kept as OUTCOME UNKNOWN with the relay's code: never said to be sent, never sent again)
        const unknown = r.outcome === 'unknown' ? { outcome: 'unknown', relayCode: typeof r.relayCode === 'string' ? r.relayCode : null } : {};
        sent[name] = Object.freeze({ signature: r.signature, ...unknown });
        return { sent: true, signature: r.signature, ...unknown };
      } finally { flying.delete(name); }
    },
    status: async name => { if (!sent[name]) fail('EconomyNotSent'); return { signature: sent[name].signature, ...(await read(sent[name].signature)) }; },
    sent: () => ({ ...sent }),
  });
}
