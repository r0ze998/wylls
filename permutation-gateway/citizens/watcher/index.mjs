// AC6: the watcher (contract section 1.3 C5, section 11.6): `createWatcher({feed, social, ledgers, records, aiDir, config, ...})`
//   -> {start(), stop(), wakeEvents(tag, bell), councilCandidates(f, c0), closeCall(f, period), result(f, period), releaseDue(bell), ...}
// It replaces the wave-A stub of `mind/wiring.mjs` (feed wakes only). Wave B adds:
//   - the wakes of the social layer (W-DM, W-HALL, W-CALL; wakes.mjs) besides the feed's W-CLASH and W-THREAT,
//   - the nation councils: the three code-made options at C0 and the AI members' motion and ballot calls (council_gen.mjs),
//   - the Strike Order: its tile and invited hosts at the close, its result at S + 2 (calls.mjs),
//   - the release job: sealed decisions opened once their march is public, PUB/open/<bell>.json written once (release.mjs),
//   - the minimal chronicle (chronicle.mjs), the Wyll cards (cards_job.mjs) and PUB/events/latest.json (events_pub.mjs).
// The watcher no longer derives episodes (AC2 owns `episodes_from_events`, run by the episode pump).
//
// Collaborators (all optional except feed, records, aiDir): `social` (AC4's store: social.council, social.book, social.subscribe),
// `ledgers` (AC2's memory store), `clock` (the mind's game clock), `roster`, `mind` (an object or a getter: the mind is built after the
// watcher, `attachMind` completes it), `nameOf`, `nationName`, `personaOf`.
//
// `aiDir` is AI_DIR (the watcher writes PUB = AI_DIR/pub and keeps its small state under AI_DIR/state/watcher); `pubDir` and `stateDir`
// override. A job never throws into the service: every step is counted in `stats().errors` and carries on at the next tick.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as b58 from '../../../permutation-server/web/sdk/base58.mjs';
import { nameOf as defaultNameOf, nationName as defaultNationName } from '../persona/names.mjs';
import { personaOf as defaultPersonaOf } from '../persona/deal.mjs';
import { createWaveAWatcher, socialRowCache } from '../mind/wiring.mjs';
import { createCensus } from './census.mjs';
import { createCouncilGen } from './council_gen.mjs';
import { createOutcomes, OUTCOMES_FILE } from './outcomes.mjs';
import { createCallLedger, CALLS_FILE } from './call_ledger.mjs';
import { createCalls } from './calls.mjs';
import { createRelease } from './release.mjs';
import { createChronicle, tallyPhrase, lostPhrase, words, withCount } from './chronicle.mjs';
import { createCardsJob } from './cards_job.mjs';
import { createEventsPub } from './events_pub.mjs';
import { createSocialWakes } from './wakes.mjs';
import { createOutbox } from './outbox.mjs';

export const RELEASE_WAIT_MS = 20_000; // the job of a bell runs when the feed is complete through bell - 1, or this long after the bell began

export function createWatcher({
  feed, social = null, ledgers = null, records, aiDir, pubDir = null, stateDir = null, config = {}, clock = null, roster = null, mind = null,
  nameOf = defaultNameOf, nationName = defaultNationName, personaOf = defaultPersonaOf, nowMs = () => Date.now(), intervalMs = 1000,
  releaseWaitMs = RELEASE_WAIT_MS, onError = () => {},
} = {}) {
  if (!aiDir && !(pubDir && stateDir)) throw new Error('createWatcher: aiDir is required');
  const PUB = pubDir ?? `${aiDir}/pub`;
  const STATE = `${stateDir ?? `${aiDir}/state`}/watcher`;
  mkdirSync(STATE, { recursive: true });
  const stats = { ticks: 0, errors: {}, last_error: null };
  let mindRef = typeof mind === 'function' ? mind : () => mind;
  const getMind = () => mindRef();
  const emptyRoster = { ai: [], seat: null, byTag: () => null, byWallet: () => null, isScript: () => false, isAi: () => false };
  const rosterNow = () => roster ?? emptyRoster;
  // a stable view over a roster that may be replaced (the service swaps it when roster.json appears)
  const rosterView = {
    get ai() { return rosterNow().ai ?? []; },
    get seat() { return rosterNow().seat ?? null; },
    byTag: t => rosterNow().byTag?.(t) ?? null,
    byWallet: w => rosterNow().byWallet?.(w) ?? null,
    isScript: w => Boolean(rosterNow().isScript?.(w)),
    isAi: t => Boolean(rosterNow().isAi?.(t)),
  };
  const err = (where, e) => {
    stats.errors[where] = (stats.errors[where] ?? 0) + 1;
    stats.last_error = `${where}: ${String(e?.stack ?? e).slice(0, 400)}`;
    try { onError(e, where); } catch { /* the hook must not break a job */ }
  };

  // ---- persisted state: which council calls were asked (a restart does not ask again)
  const statePath = `${STATE}/state.json`;
  const store = { calls: new Set(), dirty: false };
  if (existsSync(statePath)) {
    try { for (const k of JSON.parse(readFileSync(statePath, 'utf8')).calls ?? []) store.calls.add(k); } catch { /* start clean */ }
  }
  const flushState = () => {
    if (!store.dirty) return;
    const tmp = `${statePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ v: 1, calls: [...store.calls].sort() }));
    renameSync(tmp, statePath);
    store.dirty = false;
  };

  const councilStats = {}, callStats = {}, releaseStats = {}, outboxStats = {};
  const census = createCensus({ feed, roster: rosterView });
  // seatfix2 review: what became of every council call (a decided ballot is delivered only by a later brain answer) is written to STATE/council-calls.json
  const callLedger = createCallLedger({ file: `${STATE}/${CALLS_FILE}`, nowMs, onError: e => err('council_calls', e) });
  const outbox = createOutbox({ records, stats: outboxStats, ledger: callLedger });
  const chronicle = createChronicle({ pubDir: PUB, stateDir: STATE, roster: rosterView, nameOf, nationName, onError: e => err('chronicle', e) });
  // smoke-r3: why a nation got no council in a period is written to STATE/council-outcomes.json (the report reads it)
  const outcomes = createOutcomes({ file: `${STATE}/${OUTCOMES_FILE}`, nowMs, onError: e => err('council_outcomes', e) });
  const councilGen = createCouncilGen({ feed, social, roster: rosterView, census, clock, mind: getMind, store, config, stats: councilStats, onError: e => err('council', e), nowMs, outbox, outcomes });
  const nationOfTag = tag => rosterView.byTag(tag)?.faction ?? feed?.owners?.factionOfTag?.(tag) ?? null;
  const optionKindWord = (l, kind) => words(l).option_kind[kind] ?? words(l).option_kind.unknown;

  const calls = createCalls({
    feed, social, roster: rosterView, census, hintOf: councilGen.hintOf, stats: callStats, onError: e => err('calls', e),
    onResult: ({ faction, period, result, call }) => {
      const bell = call.strike_bell + 2;
      chronicle.add({
        kind: 'strike_result', bell, actors: [], refs: [`council:${faction}:${period}`],
        vals: l => ({
          b: bell, nation: nationName(faction)[l], p: call.p, q: call.q, kind: optionKindWord(l, call.kind), present: result.present,
          extra: `${result.bounced ? withCount(words(l).bounced, result.bounced) : ''}${result.displaced ? withCount(words(l).displaced, result.displaced) : ''}`,
          lost: lostPhrase(result.clash?.lost ?? {}, l, nationName),
        }),
      });
    },
  });

  const cards = ledgers && records
    ? createCardsJob({
      roster: rosterView, stores: ledgers, records, mind: getMind, personaOf, nameOf, nationName, config, pubDir: PUB,
      onChanged: ({ tag, bell, what }) => {
        chronicle.add({ kind: 'ai_card_changed', bell, actors: [tag], refs: [`card:${tag}:${bell}`], vals: l => ({ b: bell, name: nameOf(tag)[l], what: words(l).card_what[what] }) });
      },
      onError: e => err('cards', e),
    })
    : null;

  const release = createRelease({
    feed, records, pubDir: PUB, stats: releaseStats, onError: e => err('release', e),
    onOpened: o => {
      cards?.addOpened(o);
      if (o.mode !== 'model') return; // an autopilot Strike-Order follow has no reason to publish: its result is the strike line
      const d = (o.destinations ?? []).find(x => x.state === 'revealed' && x.via === 'model');
      if (!d) return;
      chronicle.add({
        kind: 'ai_march_opened', bell: o.opened_bell, actors: [o.ai], by: 'model', refs: [`decision:${o.id}`],
        vals: l => ({ b: o.opened_bell, name: nameOf(o.ai)[l], p: d.p, q: d.q, a: d.arrive_bell }),
      });
    },
  });

  const eventsPub = feed ? createEventsPub({ feed, roster: rosterView, nameOf, pubDir: PUB, onError: e => err('events', e) }) : null;
  const rowCache = social?.book ? socialRowCache({ book: social.book, pubDir: PUB }) : null;
  const socialWakes = rowCache ? createSocialWakes({ rows: () => rowCache.rows(), council: social.council ?? null, roster: rosterView, nameOf }) : null;
  const feedWakes = createWaveAWatcher({ feed });

  // ---- chronicle sources

  function onSocialEvent(ev) {
    try {
      const council = social?.council;
      if (ev.type === 'motion') {
        const P = council?.periodOf?.(ev.faction, ev.period);
        const m = P?.motions.find(x => x.id === ev.id);
        const bell = m?.bell ?? clock?.bell?.() ?? 0;
        const kind = P?.candidates?.find(o => o.option === ev.option)?.kind ?? 'unknown';
        chronicle.add({
          kind: 'motion', bell, actors: [ev.tag], refs: [`council:${ev.faction}:${ev.period}`, `motion:${ev.id}`],
          vals: l => ({ b: bell, name: nameOf(ev.tag)[l], k: ev.option, kind: optionKindWord(l, kind), nation: nationName(ev.faction)[l] }),
        });
      } else if (ev.type === 'council_closed') {
        const P = council?.periodOf?.(ev.faction, ev.period);
        const bell = (P?.c0 ?? 0) + 6;
        if (ev.adopted) {
          const seatWallet = rosterView.seat?.wallet;
          const seatVoted = Boolean(seatWallet && council?.publicOf?.(ev.faction, ev.period)?.ballots?.some(b => b.wallet === seatWallet));
          chronicle.add({
            kind: 'call_adopted', bell, actors: [], refs: [`council:${ev.faction}:${ev.period}`],
            vals: l => ({ b: bell, nation: nationName(ev.faction)[l], with: tallyPhrase(ev.tally_split, { seatVoted }, l), S: ev.strike_bell, O: ev.strike_bell + 2 }), // FB5: opened at S + 2 (the council file's open block), not at S
          });
        } else {
          chronicle.add({
            kind: 'no_call', bell, actors: [], refs: [`council:${ev.faction}:${ev.period}`],
            vals: l => ({ b: bell, nation: nationName(ev.faction)[l], why: words(l).no_call_why[ev.reason] ?? words(l).no_call_why.unknown }),
          });
        }
      }
    } catch (e) { err('chronicle_social', e); }
  }
  function onMindEvent(ev) {
    try {
      if (ev?.type !== 'call_declined') return;
      const f = nationOfTag(ev.tag);
      if (f == null) return;
      chronicle.add({
        kind: 'call_declined', bell: ev.bell, actors: [ev.tag], by: 'model', refs: [`council:${f}:${ev.period}`],
        vals: l => ({ b: ev.bell, name: nameOf(ev.tag)[l], nation: nationName(f)[l] }),
      });
    } catch (e) { err('chronicle_mind', e); }
  }

  // ---- AI joins, from the public JOIN rows (the roster may arrive after the row: matched at each tick)
  const joins = new Map(); // wallet (base58) -> bell
  const announced = new Set();
  function indexEvents(events) {
    for (const ev of events ?? []) if (ev.kind === 'JOIN' && typeof ev.wallet === 'string') {
      try { joins.set(b58.encode(Uint8Array.from(Buffer.from(ev.wallet, 'hex'))), ev.bell); } catch { /* not a wallet */ }
    }
  }
  function announceJoins() {
    for (const a of rosterView.ai) {
      if (announced.has(a.tag) || !joins.has(a.wallet)) continue;
      announced.add(a.tag);
      const bell = joins.get(a.wallet);
      chronicle.add({ kind: 'ai_joined', bell, actors: [a.tag], refs: [`join:${a.tag}`], vals: l => ({ b: bell, name: nameOf(a.tag)[l], nation: nationName(a.faction)[l] }) });
    }
  }

  // ---- wakes
  const lastWake = new Map();
  function wakeEvents(tag, bell) {
    const prev = lastWake.get(tag);
    if (prev && prev.bell === bell) return prev.list; // a repeated (tag, bell) answers the same
    if (prev && bell < prev.bell) return []; // an older bell is never asked again
    let list = [];
    try { list = [...feedWakes.wakeEvents(tag, bell), ...(socialWakes?.wakes(tag, bell) ?? [])]; } catch (e) { err('wakes', e); }
    lastWake.set(tag, { bell, list });
    return list;
  }

  // ---- the per-tick job
  let running = false;
  let lastBell = -1;
  let lastRelease = -1;
  const guard = async (name, fn) => { try { return await fn(); } catch (e) { err(name, e); return null; } };

  const releaseReady = bell => {
    if ((feed?.completeThrough?.() ?? -1) >= bell - 1) return true;
    if (!clock?.hasAnchor?.()) return true; // no game clock (tests, early start): the feed gate alone cannot apply
    return nowMs() - clock.bellStartReal(bell) >= releaseWaitMs;
  };

  async function tick(bell) {
    if (running || !Number.isInteger(bell)) return false;
    running = true;
    stats.ticks++;
    try {
      census.start();
      announceJoins();
      await guard('council_tick', () => social?.council?.tick?.(bell));
      await guard('council', () => councilGen.step(bell));
      await guard('seal', () => calls.sealPending(bell));
      await guard('result', () => calls.resultStep(bell));
      if (bell !== lastRelease && releaseReady(bell)) {
        lastRelease = bell;
        await guard('release', () => release.releaseDue(bell));
      }
      if (bell !== lastBell) {
        lastBell = bell;
        await guard('cards', () => cards?.update(bell));
        await guard('events', () => eventsPub?.update(bell));
      }
      guard('chronicle_flush', () => chronicle.flush());
      guard('state', () => flushState());
      return true;
    } finally {
      running = false;
    }
  }

  let timer = null;
  let unsub = [];
  // the subscriptions (public feed rows, social events) are made at construction, so a tick driven by hand sees the same lines as a timer
  function subscribe() {
    if (unsub.length) return;
    try { indexEvents(feed?.batchSince?.('0')?.events); } catch { /* the feed is not up yet */ }
    const u1 = feed?.subscribe?.(({ events }) => indexEvents(events));
    if (typeof u1 === 'function') unsub.push(u1);
    const u2 = social?.subscribe?.(onSocialEvent);
    if (typeof u2 === 'function') unsub.push(u2);
    if (!unsub.length) unsub.push(() => {});
  }
  cards?.loadOpened();
  subscribe();
  const api = {
    kind: 'wave-b', stub: false,
    stats: () => ({ ...stats, council: { ...councilStats, attempts: councilGen.attempts().length, outcomes: outcomes.summary() }, calls: { ...callStats }, release: { ...releaseStats }, outbox: { ...outboxStats, pending: rosterView.ai.reduce((n, a) => n + outbox.pendingCount(a.tag), 0), delivery: callLedger.summary() }, council_calls_known: store.calls.size, chronicle_lines: chronicle.lines().length }),
    wakeEvents,
    /** section 6.5 step 1: the options of nation f for the period starting at c0 -> {candidates, candidates_hash, options_hash, hints, meta} */
    councilCandidates: (f, c0) => councilGen.councilCandidates(f, c0),
    /** section 6.5 step 6: `{tile, invited}` for the adopted Strike Order of nation f, period k, or null (also the council store's `fixCall`: closeCall({faction, period, ...})) */
    closeCall: (f, period) => (typeof f === 'object' && f !== null ? calls.closeCall(f.faction, f.period) : calls.closeCall(f, period)),
    /** section 6.5 step 7: the strike result of nation f, period k (written into the council file), or null while the log is not complete through S + 2 */
    result: (f, period) => calls.result(f, period),
    /** section 7.2: open what is due at `bell` (once per bell) */
    releaseDue: bell => release.releaseDue(bell),
    tick,
    /** attach the answer of the council calls to a decide answer (outbox.mjs); `req` is the decide request */
    decorateAnswer: (req, ans) => outbox.decorate(req, ans),
    attachMind(m) {
      mindRef = () => m;
      const un = m?.subscribe?.(onMindEvent);
      if (typeof un === 'function') unsub.push(un);
    },
    start() {
      if (timer) return;
      subscribe();
      timer = setInterval(() => {
        const bell = clock?.bell?.() ?? null;
        if (bell != null) tick(bell).catch(e => err('tick', e));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const u of unsub) { try { u(); } catch { /* gone */ } }
      unsub = [];
      guard('chronicle_flush', () => chronicle.flush());
      guard('state', () => flushState());
    },
    // for the service's health route and the tests
    parts: { census, councilGen, outcomes, callLedger, calls, release, cards, eventsPub, chronicle, outbox, socialWakes },
  };
  return api;
}
