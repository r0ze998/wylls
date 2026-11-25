// One step of ⑬'s local resident (2026-11-22): observe → reconcile its journal → stop? → one action per turn? →
// wake gate → candidates → decide → journal → ONE order (signature saved before the submit) → follow → memory.
// KEY-FREE: the ports are injected —
//   observe()                      observe.mjs (public herald, own records only)
//   send(order, {onSigned})        the external-resident path (agent.mjs sendOrder): the page's own submitLocalAct
//                                  and followLocalAct; `onSigned(signature)` is called inside the signing step, before
//                                  the one submit. → {outcome, code, signature, detail}
//   follow(signature, order)       the relay's status read of an earlier signature → 'landed' | 'failed' | 'pending' | null
//                                  (`order`: the journal's order name — an Expedition is read on the depart route)
//   wide                           (optional, a local wide-land world: wide.mjs createWideEyes) `look(obs, st)` → the wide
//                                  land as the resident sees it this turn (obs.wideLand), read after the reconcile
//   territory                      (optional, a local wide-land world: territory.mjs createTerritoryEyes) `look(obs, st)` →
//                                  the resident's own land and the tiles it could claim (obs.territory), read before `wide`
//   bellNow()                      the chain's turn after the send (the later turn books the action, as the operator
//                                  residents book theirs: local-play-operator-residents.mjs)
//   halted()                       the operator's halt file (resident.mjs charter.haltFile): a pause, results still read
//   log(step, fields)              one JSON line per step (the decision log)
//   plan                           (optional) workstream 04's plan executor (executor.mjs): when it has a step for
//                                  this turn, that step is the order (the brain does not choose); its intent and its
//                                  signature are written to the plan store BEFORE the journal's and before the
//                                  submit, and its outcome after. Without a plan (no village yet, the cap) the brain
//                                  decides as before.
import { localCandidates, decideLocal, noteOutcome, seenOf, trackVillage, villageOre, refusedForResources, LOCAL_LIMITS, BELLS_PER_DAY } from './brain.mjs';
import { territorySeen } from './territory.mjs';
import { blockedWhy, beginLine, openLines, enterWorld, prune, OPEN_LINE_MS } from './journal.mjs';

/** Relay codes that prove nothing reached the chain for a passing reason: no hold, the turn stays open. */
export const PASSING = Object.freeze(new Set(['LocalActNoAnswer', 'LocalActFailed', 'BadLocalActContext', 'LocalActChanged', 'LocalActBusy', 'LocalActRpcUnavailable', 'ResidentTurnUnavailable']));

const fieldsFor = order => (order.name === 'Join' ? { ...order.fields, session_expiry: BigInt(order.fields.session_expiry) } : order.fields);

export async function localStep({ store, observe, send, follow, bellNow, halted = () => false, log = () => {}, provider = null, limits = LOCAL_LIMITS, nowMs = () => Date.now(), plan = null, wide = null, territory = null }) {
  const st = store.state;
  const obs = await observe();
  if (!obs || obs.unreadable) { log('observe', { outcome: 'unreadable', why: obs?.unreadable ?? 'no answer' }); return { did: 'unreadable' }; }
  const worldKey = `${obs.seasonId}:${obs.genesisTs}`;
  if (enterWorld(st, worldKey)) { store.save(); log('world', { outcome: 'entered', world: worldKey, worlds: st.worlds }); }
  // reconcile: an open line is followed by its signature, never sent again
  for (const l of openLines(st)) {
    const line = st.journal[l.key];
    let r = null;
    try { r = await follow(l.signature, l.order); } catch { r = null; }
    if (r === 'landed' || r === 'failed') {
      line.state = r; line.settledBy = 'follow';
      noteOutcome(st, { kind: l.kind, order: { name: l.order, fields: l.fields }, ...(l.site ? { site: l.site } : {}), ...(l.meta ? { meta: l.meta } : {}) }, r, { bell: l.kind === 'tile' ? l.bell : obs.bell, limits });
      log('reconcile', { line: l.key, order: l.order, outcome: r, signature: l.signature });
    } else if (nowMs() - (line.signedAtMs ?? 0) >= OPEN_LINE_MS) {
      line.state = 'expired-unknown'; log('reconcile', { line: l.key, order: l.order, outcome: 'expired-unknown', why: 'no landing seen within the blockhash life; never sent again', signature: l.signature });
    }
  }
  // (the plan store's open steps too: the same signatures, read again, settled there)
  if (plan) { try { await plan.reconcile({ obs, follow }); } catch (e) { log('plan', { what: 'reconcile-failed', code: e.code ?? null, why: String(e.message ?? e).slice(0, 200) }); } }
  // (LP9-4: my village's record of landed builds, after the reconcile has counted what landed; on S1 its terrain ore
  //  said to the rulebook before any copy is counted — said in the log once, when it changes)
  const vnote = trackVillage(st, obs);
  if (vnote) log('village', { why: vnote });
  const ore = villageOre(obs, st);
  if (ore) {
    const seen = `${st.village?.key}:${ore.extra}:${ore.by}`;
    if (st.oreSeen !== seen) {
      st.oreSeen = seen;
      log('village', { what: 'terrain-ore', village: st.village?.key ?? null, extra: ore.extra, by: ore.by,
        why: ore.by === 'record' ? 'S1: mines are counted above my Holding\'s own terrain ore' : ore.by === 'landed' ? 'S1: my Holding does not say its terrain ore; mines are counted from my own landed builds' : 'S1: my terrain ore is not known (no TERRAIN_ORE, no complete record of my builds): ore copies are counted above the tier\'s base and may read low; a refusal for resources holds the build' });
    }
  }
  // (ws13-territory: the resident's own land and the tiles it could claim — reads only; before the wide land's look, whose
  //  claim order needs it in a world with player territory)
  if (territory && obs.holding) {
    try { obs.territory = await territory.look(obs, st); } catch (e) { obs.territory = { on: null, why: `territory look failed: ${String(e?.message ?? e).slice(0, 160)}` }; }
    const seenT = obs.territory ? JSON.stringify(territorySeen(obs.territory)) : null;
    if (seenT && st.territorySeen !== seenT) { st.territorySeen = seenT; log('territory', { what: 'seen', bell: obs.bell, ...territorySeen(obs.territory) }); }
  }
  // (external-wide-orders: the wide land, read once per turn and memory change — reads only, nothing is sent)
  if (wide && obs.holding) {
    try { obs.wideLand = await wide.look(obs, st); } catch (e) { obs.wideLand = null; log('wide', { what: 'look-failed', why: String(e?.message ?? e).slice(0, 200) }); }
    const seen = obs.wideLand ? JSON.stringify(seenOf(obs).wide).replace(/[0-9]+/g, '#') : null;   // (said when it changes, not each turn's numbers)
    if (seen && st.wideSeen !== seen) { st.wideSeen = seen; log('wide', { what: 'seen', bell: obs.bell, ...seenOf(obs).wide }); }
  }
  store.save();
  if (halted()) { log('stop', { why: 'halted-by-operator', bell: obs.bell }); return { did: 'halted' }; }
  if (st.decisions >= limits.maxTurns) { log('stop', { why: 'max-turns', decisions: st.decisions }); return { did: 'max-turns' }; }
  const blocked = blockedWhy(st, obs.bell, nowMs());
  if (blocked) return { did: 'blocked', why: blocked, bell: obs.bell };
  // (a plan in progress is looked at every turn; the brain's idle back-off is for the brain's own waits)
  if (obs.bell < st.nextDecisionBell && !(plan && st.planActive)) return { did: 'asleep', until: st.nextDecisionBell, bell: obs.bell };
  const day = Math.floor(obs.bell / BELLS_PER_DAY);
  if (st.day.n !== day) st.day = { n: day, acts: 0 };
  // decide
  const c = localCandidates(obs, st, { limits });
  if (st.day.acts >= limits.actionsPerDay) c.candidates.forEach(x => { x.held = [...(x.held ?? []), `the day's ${limits.actionsPerDay} actions are used`]; });
  let planned = null;
  // (ws13-territory: the tile of my next village's site is the brain's own order, not a plan step — workstream 04's plan
  //  store knows no TerritoryClaim —: when it can be asked this turn, the plan is not asked for a step and stays as it is)
  const siteTile = c.candidates.find(x => x.kind === 'tile' && x.meta?.purpose === 'site' && !x.held) ?? null;
  if (plan && !siteTile) {
    let p;
    try { p = await plan.next({ obs, mem: st }); } catch (e) { p = { wait: `plan store: ${e.code ?? ''} ${String(e.message ?? e).slice(0, 160)}` }; }
    st.planActive = !p.none;
    if (p.wait) { store.save(); return { did: 'plan-wait', bell: obs.bell, why: p.wait }; }
    if (p.use && st.day.acts >= limits.actionsPerDay) { store.save(); return { did: 'plan-wait', bell: obs.bell, why: `the day's ${limits.actionsPerDay} actions are used` }; }
    if (p.use) planned = p.use;
  }
  const d = planned ? { choice: planned.cand.id, by: 'ws04-plan', why: `${planned.plan} step ${planned.idx + 1}/${planned.of}: ${planned.cand.why}` }
    : plan && siteTile ? { choice: siteTile.id, by: 'ws13-territory', why: siteTile.why } : decideLocal({ candidates: c.candidates, obs }, provider);
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
  const cand = planned ? planned.cand : c.candidates.find(x => x.id === d.choice);
  if (planned) {
    // (0) the plan store's intent first: it refuses a used turn, an open step, a stale holder
    try { await plan.intend(planned, obs.bell); }
    catch (e) { store.save(); log('plan', { what: 'intend-refused', plan: planned.plan, planStep: planned.idx, bell: obs.bell, code: e.code ?? null, why: String(e.message ?? e).slice(0, 200) }); return { did: 'blocked', why: `plan store: ${e.code}`, bell: obs.bell }; }
  }
  const key = beginLine(st, obs.bell, cand, nowMs());
  store.save();   // (1) intended, before anything is asked of the relay
  log('decide', { bell: obs.bell, goal: st.goal, choice: cand.id, order: cand.order.name, fields: cand.order.fields, by: d.by, why: d.why, seen: seenOf(obs), assessment: c.assessment, candidates: summary });
  const line = st.journal[key];
  const r = await send({ name: cand.order.name, v: cand.order.v, fields: fieldsFor(cand.order), ...(cand.plan ? { plan: cand.plan } : {}) }, {
    onSigned: async sig => {
      if (planned) await plan.signed(planned, sig);   // (2a) the plan store first; a throw here stops the submit
      line.signature = sig; line.state = 'signed'; line.signedAtMs = nowMs(); store.save();   // (2b) before the submit
    },
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
  // (an order the world refused before anything was signed — an expedition's prepare: the program's check on the depart
  //  route — holds that order as a refusal does; another order may still go in this turn)
  const holdNotSent = line.state === 'not-sent' && r.holdNotSent === true;
  if (r.signature && line.signature && r.signature !== line.signature) log('warning', { why: 'the relay named another signature than the one saved', saved: line.signature, relay: r.signature });
  if (outcome !== 'refused-turn-used') noteOutcome(st, cand, holdNotSent ? 'refused' : line.state === 'unknown' ? 'unknown' : outcome, { bell: obs.bell, code: r.code ?? null, limits, resources: refusedForResources(r), obs, programCode: Number.isInteger(r.programCode) ? r.programCode : null });
  if (planned) {
    const outcome4 = line.state === 'refused' && r.code === 'ResidentAlreadyActed' ? 'not-sent' : line.state;
    try { await plan.settle(planned, { outcome: outcome4, signature: line.signature ?? null, code: r.code ?? null, bookedBell: line.signature ? st.lastActBell : null }); }
    catch (e) { log('plan', { what: 'settle-failed', plan: planned.plan, planStep: planned.idx, outcome: outcome4, code: e.code ?? null, why: String(e.message ?? e).slice(0, 200), note: 'the step stays open in the store and is read again by its signature' }); }
  }
  prune(st);
  store.save();   // (3)
  log('act', { bell: obs.bell, ...(planned ? { plan: planned.plan, planStep: planned.idx } : {}), order: cand.order.name, fields: cand.order.fields, outcome: line.state, ...(r.code ? { code: r.code } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(line.signature ? { signature: line.signature } : {}), bookedTurn: st.lastActBell, seen: { village: seenOf(obs)?.village ?? null } });
  return { did: 'act', outcome: line.state, order: cand.order.name, bell: obs.bell };
}
