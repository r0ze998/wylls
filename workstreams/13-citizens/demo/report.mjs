// The run's report, in two parts that are never mixed:
//   mechanical  what the code can check: sends, fates, duplicates, budgets, limits, restarts, audit findings
//   observed    what a reader needs to judge character, autonomy and fun: decisions that changed after an
//               outcome, refusals and their alternatives, idle share. These are observations for a human
//               rater (../06-evaluation.ja.md), not a score; nothing here says the residents are autonomous,
//               have a personality or are fun.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { audit } from '../resident/safety.mjs';

const count = (xs, f) => xs.reduce((o, x) => { const k = f(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});

export function decisionsOf(r) {
  const f = path.join(r.dir, 'decisions.jsonl');
  if (!existsSync(f)) return [];
  const byTurn = new Map();
  for (const l of readFileSync(f, 'utf8').split('\n')) if (l.trim()) { const d = JSON.parse(l); if (!byTurn.has(d.turn)) byTurn.set(d.turn, d); }
  return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

function residentMechanics(r, world) {
  const ds = decisionsOf(r);
  const j = Object.values(r.state.journal);
  const rec = r.ledger.get(r.id);
  const sigs = j.filter(x => x.signature).map(x => x.signature);
  const caravansByIntent = j.filter(x => x.action?.name === 'SendCaravan' && x.state === 'landed').map(x => world.s.caravans.filter(k => k.signature === x.signature).length);
  const perDay = {};
  for (const x of j.filter(i => i.port === 'action' && ['sent', 'landed'].includes(i.state))) {
    const d = Math.floor((world.s.requests[`${r.state.citizen}:${x.sendKey}`]?.at ?? 0) / 144);
    perDay[d] = (perDay[d] ?? 0) + 1;
  }
  return {
    citizen: r.state.citizen, address: r.address, goal: r.charter.goal,
    owner: r.charter.owner.name, funder: r.charter.funder.name, stoppedBy: r.charter.stoppedBy,
    decisions: ds.length, by: count(ds, d => d.by), kinds: count(ds, d => d.kind),
    providerRefusals: count(ds.filter(d => d.refusal), d => d.refusal),
    journalLastDay: count(j, x => `${x.port}:${x.state}`), // the journal keeps finished lines for one game day; whole-run duplicates are in the audit
    duplicateSignatures: sigs.length - new Set(sigs).size,
    caravansPerLandedIntent: [...new Set(caravansByIntent)],
    actionsPerGameDay: perDay, actionsPerDayLimit: r.charter.limits.actionsPerDay,
    ledger: { mode: rec.mode, deposited: rec.bal.deposited, available: rec.bal.available, spentInference: rec.bal.spent.inference, reserved: rec.bal.reserved, callsToday: rec.day.calls, check: r.ledger.check(), unresolved: Object.values(rec.holds).filter(h => h.state === 'unresolved').length },
    episodes: r.ports.memory.all().length,
  };
}

function residentObservations(r) {
  const ds = decisionsOf(r);
  const eps = r.ports.memory.all();
  const requests = ds.filter(d => d.kind === 'request');
  const targetChanges = [];
  for (let i = 1; i < requests.length; i++) if (requests[i].act.to !== requests[i - 1].act.to) targetChanges.push({ turn: requests[i].turn, from: requests[i - 1].act.to, to: requests[i].act.to });
  return {
    declines: ds.filter(d => d.kind === 'decline').map(d => ({ bell: d.bell, request: d.act.request, reason: d.act.reason, why: d.act.why, alternative: d.act.alternative })),
    excludedOffers: ds.flatMap(d => d.excluded.map(e => ({ bell: d.bell, ...e }))).filter((e, i, a) => a.findIndex(x => x.request === e.request && x.reason === e.reason) === i),
    outcomesLearned: count(eps, e => e.kind),
    requestTargetChanges: targetChanges,
    idleShare: ds.length ? Math.round(100 * ds.filter(d => d.kind === 'wait').length / ds.length) / 100 : null,
    distinctKinds: [...new Set(ds.map(d => d.kind))],
  };
}

export function summarise(all, { restarts = [] } = {}) {
  const { world, board } = all;
  const residents = [all.asa, all.ren];
  const reqs = board.requests();
  const charters = Object.fromEntries(residents.map(r => [r.state.citizen, { owner: r.charter.owner.address }]));
  const findings = audit({ events: world.s.events, requests: reqs, replies: board.s.posts.filter(p => p.kind === 'reply'), charters });
  const names = Object.fromEntries(Object.values(world.s.citizens).map(c => [c.id, c.name]));
  return {
    stage: { world: 'MOCK local test world (world/testworld.mjs), not the Frontier program', provider: 'fixture (no model, no network)', memory: 'local adapter (stand-in for workstream 12)', execution: 'test-world adapter (stand-in for workstream 4)', board: 'MOCK off-chain board' },
    bells: world.bell, names,
    mechanical: {
      residents: Object.fromEntries(residents.map(r => [r.id, residentMechanics(r, world)])),
      world: { caravans: count(world.s.caravans, k => k.state), events: count(world.s.events, e => e.kind), wasteUnits: Object.fromEntries(Object.entries(world.s.waste).map(([k, v]) => [k, Math.floor(v / 1000)])) },
      board: { requests: reqs.map(r => ({ id: r.id, from: names[r.from], to: r.to ? names[r.to] : 'anyone', want: r.want, offer: r.offer, status: r.status, by: r.by ? names[r.by] : null, returned: r.returned ?? null, reopened: r.reopened ?? false })) },
      audit: findings,
      restarts,
    },
    observed: Object.fromEntries(residents.map(r => [r.id, residentObservations(r)])),
    notAnEvaluation: 'The observed part lists facts a human rater needs. It does not score personality, autonomy or fun (06-evaluation.ja.md).',
  };
}

export function transcript(all, summary) {
  const names = summary.names;
  const n = c => names[c] ?? c ?? 'anyone';
  const lines = [];
  for (const r of [all.asa, all.ren]) for (const d of decisionsOf(r)) {
    if (d.kind === 'wait') continue;
    lines.push({ bell: d.bell, text: `${r.charter.name}（${d.by}）: ${d.candidates.find(c => c.id === d.choice)?.summary ?? d.choice}${d.refusal ? ` [provider refused: ${d.refusal}]` : ''}` });
  }
  for (const p of all.board.s.posts) {
    if (p.kind === 'request') lines.push({ bell: p.bell, text: `board: ${n(p.from)} → ${p.to ? n(p.to) : 'anyone'}: wants ${JSON.stringify(p.want)} offers ${JSON.stringify(p.offer)} by ${p.deadlineBell}` });
    else lines.push({ bell: p.bell, text: `board: ${n(p.from)} ${p.decision}s ${p.re}${p.reason ? ` (${p.reason})` : ''}${p.alternative ? ` alt ${JSON.stringify(p.alternative)}` : ''}` });
  }
  for (const e of all.world.s.events) {
    if (e.kind === 'CaravanArrived') lines.push({ bell: e.bell, text: `world: caravan ${e.caravan} ${n(e.src)} → ${n(e.dst)} arrived with ${JSON.stringify(e.goods)}` });
    if (e.kind === 'CaravanRaided') lines.push({ bell: e.bell, text: `world: caravan ${e.caravan} ${n(e.src)} → ${n(e.dst)} raided` });
    if (e.kind === 'BuildDone') lines.push({ bell: e.bell, text: `world: ${n(e.citizen)} finished building ${e.item}` });
    if (e.kind === 'Failed') lines.push({ bell: e.bell, text: `world: ${n(e.citizen)} ${e.action} failed (${e.code})` });
    if (e.kind === 'BoundaryMarker') lines.push({ bell: e.bell, text: `world: 境界の印（試験用。規則なし）${e.label}` });
  }
  for (const r of summary.mechanical.restarts) lines.push({ bell: r.bell, text: `restart: ${r.resident ?? 'all'} — ${r.why}` });
  lines.sort((a, b) => a.bell - b.bell);
  return [
    '# 試験世界の経過（模擬世界・fixture provider）', '',
    '機械的な結果は summary.json の `mechanical`、人格・自律性・面白さの判断材料は `observed`（評価ではない）。', '',
    ...lines.map(l => `- ターン ${l.bell}: ${l.text}`), '',
  ].join('\n');
}
