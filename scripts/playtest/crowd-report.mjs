// The numbers of a crowd run (PT-C), from crowd-events.jsonl and nothing else:
//
//   node scripts/playtest/crowd-report.mjs crowd-events.jsonl [--json out.json]
//
// Every figure is a count or a percentile of events the crowd wrote while it ran (crowd.mjs documents them).
// "Village" times are from the crowd's own poller of the herald (`village_chain`: the first time /h/me/<wallet>
// listed a holding, so independent of whether the tester was looking) and from the page (`village_seen`: when
// the tester's page first showed it; the tester may be away, so this one is only an upper bound). Percentiles
// use the nearest rank. Times are milliseconds in the events and seconds in the report.
import { readFileSync, writeFileSync } from 'node:fs';

export const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };
const dist = xs => (xs.length ? { n: xs.length, min: Math.min(...xs), p50: pct(xs, 0.5), p90: pct(xs, 0.9), p99: pct(xs, 0.99), max: Math.max(...xs) } : { n: 0 });
const inMs = d => d;
const inSec = d => (d.n ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'n' ? v : +(v / 1000).toFixed(1)])) : d);
const tally = (xs, key) => xs.reduce((m, x) => { const k = typeof key === 'function' ? key(x) : x[key]; m[k] = (m[k] ?? 0) + 1; return m; }, {});

/** Everything the report says, from the parsed events. Pure. */
export function summarise(events, { frozen = [] } = {}) {
  // intervals [from, to] in ms during which the stack was frozen (the pause drill): subtracted from the "since" times as the second variant
  const overlap = (a, b) => frozen.reduce((n, [f, t]) => n + Math.max(0, Math.min(b, t) - Math.max(a, f)), 0);
  const active = e => (e.sinceDepartMs ?? e.sinceJoinOkMs) - overlap(e.t - (e.sinceDepartMs ?? e.sinceJoinOkMs), e.t);
  const by = ev => events.filter(e => e.ev === ev);
  const start = by('crowd_start')[0] ?? null;
  const friends = new Set(by('tester_plan').map(e => e.tester));
  const joined = new Set(by('join_ok').map(e => e.tester));
  const sessions = by('session_start');
  const sessionEnds = by('session_end');
  const perTesterSessions = [...friends].map(t => sessions.filter(s => s.tester === t).length);
  const returnedSessions = sessions.filter(s => s.kind === 'return');
  const relay = by('relay_http');
  const relayBy = path => relay.filter(r => r.path === path);
  const codeKey = r => `${r.status}${r.code ? ` ${r.code}` : ''}`;
  const departAttempts = by('depart_attempt');
  const firstDeparts = new Map();
  for (const a of departAttempts) if (!firstDeparts.has(a.tester)) firstDeparts.set(a.tester, a);
  const marches = by('march_departed');
  const chainReports = by('clash_report_chain');
  const pageReports = by('clash_report_page');
  const firstOf = (list, f = e => e.sinceDepartMs) => { const m = new Map(); for (const e of list) if (!m.has(e.tester)) m.set(e.tester, f(e)); return [...m.values()]; };
  const actions = by('action');
  const actionKinds = {};
  for (const a of actions) { const k = actionKinds[a.kind] ??= { ok: 0, refused: 0, unavailable: 0, timeout: 0, ms: [] }; k[a.outcome] = (k[a.outcome] ?? 0) + 1; if (a.outcome === 'ok' && a.ms) k.ms.push(a.ms); }
  for (const k of Object.values(actionKinds)) { k.latencyS = inSec(dist(k.ms)); delete k.ms; }
  const unavailable = tally(actions.filter(a => a.outcome === 'unavailable'), a => `${a.kind}: ${a.why ?? '?'}`);
  const refusedTexts = tally(actions.filter(a => a.outcome === 'refused'), a => `${a.kind}: ${a.notice ?? '?'}`);
  const httpAgg = by('http_fail_agg');
  const httpFail = {};
  for (const e of httpAgg) { const m = httpFail[e.key] ??= { n: 0, testers: new Set(), first: e.first, last: e.last }; m.n += e.n; m.testers.add(e.tester); m.first = Math.min(m.first, e.first); m.last = Math.max(m.last, e.last); }
  for (const m of Object.values(httpFail)) { m.testers = m.testers.size; m.first = new Date(m.first).toISOString(); m.last = new Date(m.last).toISOString(); }
  const consoleAgg = {};
  for (const e of by('console_agg')) { const m = consoleAgg[e.key] ??= { n: 0, testers: new Set() }; m.n += e.n; m.testers.add(e.tester); }
  for (const m of Object.values(consoleAgg)) m.testers = m.testers.size;
  const t0 = events[0]?.t ?? null; const t1 = events.at(-1)?.t ?? null;
  return {
    run: { start: t0 ? new Date(t0).toISOString() : null, end: t1 ? new Date(t1).toISOString() : null, minutes: t0 ? +((t1 - t0) / 60000).toFixed(1) : 0, config: start },
    testers: { friends: friends.size, joined: joined.size, neverJoined: friends.size - joined.size, personas: tally(by('tester_plan'), 'persona'),
      sessions: sessions.length, sessionsPerTesterMedian: pct(perTesterSessions, 0.5), returnSessions: returnedSessions.length,
      testersWithAReturn: new Set(returnedSessions.map(s => s.tester)).size, sessionEndReasons: tally(sessionEnds, e => String(e.reason).replace(/:.*/, '')) },
    landing: { cards: tally(by('landing'), e => `${e.kind}: ${e.card?.title}`), latencyS: inSec(dist(by('landing').map(e => e.ms))), pageReadyS: inSec(dist(by('page_ready').map(e => e.ms))), badInvites: by('bad_invite_result').map(e => ({ kind: e.kind, title: e.title, offersStart: e.offersStart })) },
    join: { clicks: by('join_click').length, results: tally(by('join_result'), e => (e.ok ? 'ok' : e.notice ?? 'fail')), clickToOkS: inSec(dist(by('join_ok').map(e => e.sinceFirstClickMs))), perClickLatencyS: inSec(dist(by('join_result').map(e => e.ms))) },
    joinToVillage: { chainS: inSec(dist(by('village_chain').map(e => e.sinceJoinOkMs))), chainExcludingFreezeS: inSec(dist(by('village_chain').map(active))), pageS: inSec(dist(by('village_seen').map(e => e.sinceJoinOkMs))), villagesFromChain: by('village_chain').length, villagesFromPage: by('village_seen').length, joinedWithoutVillage: [...joined].filter(t => !by('village_chain').some(e => e.tester === t) && !by('village_seen').some(e => e.tester === t)).length },
    depart: { attempts: departAttempts.length, outcomes: tally(departAttempts, 'outcome'), refusals: tally(departAttempts.filter(a => a.outcome !== 'ok'), a => `${a.outcome}: ${a.notice ?? (a.blocked ? a.blocked.slice(0, 90) : '-')}`),
      relayAnswers: tally(relay.filter(r => r.action === 'Depart'), codeKey), marchesDeparted: marches.length, testersWithAMarch: new Set(marches.map(e => e.tester)).size,
      firstAttemptAccepted: [...firstDeparts.values()].filter(a => a.outcome === 'ok').length, firstAttemptsTotal: firstDeparts.size,
      acceptedPerAttempt: departAttempts.length ? +(departAttempts.filter(a => a.outcome === 'ok').length / departAttempts.length).toFixed(3) : null,
      sealAndSendS: inSec(dist(departAttempts.filter(a => a.outcome === 'ok').map(a => a.ms))) },
    firstClashReport: { fromChainS: inSec(dist(firstOf(chainReports))), fromChainExcludingFreezeS: inSec(dist(firstOf(chainReports, active))), allMarchesExcludingFreezeS: inSec(dist(chainReports.map(active))), allMarchesS: inSec(dist(chainReports.map(e => e.sinceDepartMs))), fromPageS: inSec(dist(firstOf(pageReports))), marchesWithChainReport: chainReports.length, marchesWithPageReport: pageReports.length },
    relay: { join: tally(relayBy('join'), codeKey), relay: tally(relayBy('relay'), codeKey), nudge: tally(relayBy('nudge'), codeKey), reveal: tally(relayBy('reveal'), codeKey),
      latencyMs: { join: inMs(dist(relayBy('join').map(r => r.ms))), relay: inMs(dist(relayBy('relay').map(r => r.ms))), nudge: inMs(dist(relayBy('nudge').map(r => r.ms))) },
      serverErrors5xx: relay.filter(r => r.status >= 500).length, rateLimited429: relay.filter(r => r.status === 429).length },
    actions: actionKinds, unavailable, refusedTexts,
    errors: { testerErrors: tally(by('tester_error'), e => String(e.message).slice(0, 80)), actionErrors: tally(by('action_error'), e => `${e.action}: ${String(e.message).slice(0, 60)}`), httpFailures: httpFail, console: consoleAgg, visitsUnreachable: by('visit_unreachable').length, slowRequests: by('slow_http').length, browserDisconnects: by('browser_disconnected').length },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error('usage: crowd-report.mjs crowd-events.jsonl [--json out.json]'); process.exit(2); }
  const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const di = process.argv.indexOf('--drills');
  const frozen = [];
  if (di > 0) for (const l of readFileSync(process.argv[di + 1], 'utf8').split('\n').filter(Boolean)) { try { const j = JSON.parse(l); if (j.ev === 'pause_start') frozen.push([j.t, j.t + j.minutes * 60_000]); } catch { /* skip */ } }
  const s = summarise(events, { frozen });
  const out = process.argv.indexOf('--json');
  if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify(s, null, 1));
  console.log(JSON.stringify(s, null, 1));
}
