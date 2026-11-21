// One step of ⑬'s local resident (2026-11-22): observe → reconcile its journal → stop? → one action per turn? →
// wake gate → candidates → decide → journal → ONE order (signature saved before the submit) → follow → memory.
// KEY-FREE: the ports are injected —
//   observe()                      observe.mjs (public herald, own records only)
//   send(order, {onSigned})        the external-resident path (agent.mjs sendOrder): the page's own submitLocalAct
//                                  and followLocalAct; `onSigned(signature)` is called inside the signing step, before
//                                  the one submit. → {outcome, code, signature, detail}
//   follow(signature)              the relay's status read of an earlier signature → 'landed' | 'failed' | 'pending' | null
//   bellNow()                      the chain's turn after the send (the later turn books the action, as the operator
//                                  residents book theirs: local-play-operator-residents.mjs)
//   halted()                       the operator's halt file (resident.mjs charter.haltFile): a pause, results still read
//   log(step, fields)              one JSON line per step (the decision log)
import { localCandidates, decideLocal, noteOutcome, seenOf, LOCAL_LIMITS, BELLS_PER_DAY } from './brain.mjs';
import { blockedWhy, beginLine, openLines, enterWorld, prune, OPEN_LINE_MS } from './journal.mjs';

/** Relay codes that prove nothing reached the chain for a passing reason: no hold, the turn stays open. */
export const PASSING = Object.freeze(new Set(['LocalActNoAnswer', 'LocalActFailed', 'BadLocalActContext', 'LocalActChanged', 'LocalActBusy', 'LocalActRpcUnavailable', 'ResidentTurnUnavailable']));

const fieldsFor = order => (order.name === 'Join' ? { ...order.fields, session_expiry: BigInt(order.fields.session_expiry) } : order.fields);

export async function localStep({ store, observe, send, follow, bellNow, halted = () => false, log = () => {}, provider = null, limits = LOCAL_LIMITS, nowMs = () => Date.now() }) {
  const st = store.state;
  const obs = await observe();
  if (!obs || obs.unreadable) { log('observe', { outcome: 'unreadable', why: obs?.unreadable ?? 'no answer' }); return { did: 'unreadable' }; }
  const worldKey = `${obs.seasonId}:${obs.genesisTs}`;
  if (enterWorld(st, worldKey)) { store.save(); log('world', { outcome: 'entered', world: worldKey, worlds: st.worlds }); }
  // reconcile: an open line is followed by its signature, never sent again
  for (const l of openLines(st)) {
    const line = st.journal[l.key];
    let r = null;
    try { r = await follow(l.signature); } catch { r = null; }
    if (r === 'landed' || r === 'failed') {
      line.state = r; line.settledBy = 'follow';
      noteOutcome(st, { kind: l.kind, order: { name: l.order, fields: l.fields } }, r, { bell: obs.bell, limits });
      log('reconcile', { line: l.key, order: l.order, outcome: r, signature: l.signature });
    } else if (nowMs() - (line.signedAtMs ?? 0) >= OPEN_LINE_MS) {
      line.state = 'expired-unknown'; log('reconcile', { line: l.key, order: l.order, outcome: 'expired-unknown', why: 'no landing seen within the blockhash life; never sent again', signature: l.signature });
    }
  }
  store.save();
  if (halted()) { log('stop', { why: 'halted-by-operator', bell: obs.bell }); return { did: 'halted' }; }
  if (st.decisions >= limits.maxTurns) { log('stop', { why: 'max-turns', decisions: st.decisions }); return { did: 'max-turns' }; }
  const blocked = blockedWhy(st, obs.bell, nowMs());
  if (blocked) return { did: 'blocked', why: blocked, bell: obs.bell };
  if (obs.bell < st.nextDecisionBell) return { did: 'asleep', until: st.nextDecisionBell, bell: obs.bell };
  const day = Math.floor(obs.bell / BELLS_PER_DAY);
  if (st.day.n !== day) st.day = { n: day, acts: 0 };
  // decide
  const c = localCandidates(obs, st, { limits });
  if (st.day.acts >= limits.actionsPerDay) c.candidates.forEach(x => { x.held = [...(x.held ?? []), `the day's ${limits.actionsPerDay} actions are used`]; });
  const d = decideLocal({ candidates: c.candidates, obs }, provider);
  st.decisions += 1;
  const summary = c.candidates.map(x => ({ id: x.id, score: Math.round(x.score * 100) / 100, ...(x.held ? { held: x.held } : {}) }));
  if (d.choice === 'wait') {
    st.wakeInterval = Math.min(limits.idleBackoffMaxBells, Math.max(1, st.wakeInterval) * 2);
    st.nextDecisionBell = obs.bell + st.wakeInterval;
    store.save();
    log('decide', { bell: obs.bell, goal: st.goal, choice: 'wait', by: d.by, why: d.why, nextLook: st.nextDecisionBell, seen: seenOf(obs), assessment: c.assessment, candidates: summary, notes: c.why });
    return { did: 'wait', bell: obs.bell };
  }
  st.wakeInterval = limits.wakeEveryBells;
  st.nextDecisionBell = obs.bell + limits.wakeEveryBells;
  const cand = c.candidates.find(x => x.id === d.choice);
  const key = beginLine(st, obs.bell, cand, nowMs());
  store.save();   // (1) intended, before anything is asked of the relay
  log('decide', { bell: obs.bell, goal: st.goal, choice: cand.id, order: cand.order.name, fields: cand.order.fields, by: d.by, why: d.why, seen: seenOf(obs), assessment: c.assessment, candidates: summary });
  const line = st.journal[key];
  const r = await send({ name: cand.order.name, v: cand.order.v, fields: fieldsFor(cand.order) }, {
    onSigned: sig => { line.signature = sig; line.state = 'signed'; line.signedAtMs = nowMs(); store.save(); },   // (2) before the submit
  });
  let outcome = r.outcome;
  // (refused before a signature existed, or for a passing reason: nothing reached the chain, no hold)
  if (outcome === 'refused' && (!line.signature || PASSING.has(r.code))) outcome = 'not-sent';
  line.state = outcome === 'unknown' ? (line.signature ? 'unknown' : 'not-sent') : outcome;
  line.code = r.code ?? null;
  if (r.code === 'ResidentAlreadyActed') { st.lastActBell = Math.max(st.lastActBell, obs.bell); line.state = 'refused'; outcome = 'refused-turn-used'; }
  if (line.signature && line.state !== 'not-sent' && outcome !== 'refused-turn-used') {
    // (the world's cap does not count the Join: local-play-act.mjs `--resident-turns`, "Join is none" — a landed Join
    //  leaves the turn open for the first real order, as it does for every resident)
    if (!(cand.kind === 'join' && line.state === 'landed')) {
      let after = null; try { after = await bellNow(); } catch { after = null; }
      st.lastActBell = Math.max(st.lastActBell, obs.bell, Number.isInteger(after) ? after : obs.bell);
      st.day.acts += 1;
    }
    st.acted += 1;
  }
  // (nothing reached the chain: the turn stays open for another attempt, journal.mjs MAX_ATTEMPTS_PER_TURN)
  if (line.state === 'not-sent') st.nextDecisionBell = obs.bell;
  if (r.signature && line.signature && r.signature !== line.signature) log('warning', { why: 'the relay named another signature than the one saved', saved: line.signature, relay: r.signature });
  if (outcome !== 'refused-turn-used') noteOutcome(st, cand, line.state === 'unknown' ? 'unknown' : outcome, { bell: obs.bell, code: r.code ?? null, limits });
  prune(st);
  store.save();   // (3)
  log('act', { bell: obs.bell, order: cand.order.name, fields: cand.order.fields, outcome: line.state, ...(r.code ? { code: r.code } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(line.signature ? { signature: line.signature } : {}), bookedTurn: st.lastActBell, seen: { village: seenOf(obs)?.village ?? null } });
  return { did: 'act', outcome: line.state, order: cand.order.name, bell: obs.bell };
}
