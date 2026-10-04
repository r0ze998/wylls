// AC9: the run report (contract 10.1). test/fixtures/ai-ac9-slice4 is a VERBATIM subset of the wave-A slice-4 run (4 of its
// 85 minds files, all 6 episode files, the final metrics snapshot, the brain counters, the private journal lines of those
// bells), so every number computed here is of the subset; where the full run's snapshot is mixed in the test says so. A test that
// builds records by hand (valid-rate cases, an opened record) says "synthetic".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, renderMarkdown, parseRuns, wilson, decisionsSection, loadRun } from '../citizens/report.mjs';

const FIX = new URL('./fixtures/ai-ac9-slice4/', import.meta.url).pathname;
const copyFix = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-report-'));
  cpSync(FIX, d, { recursive: true });
  return d;
};

test('wilson interval: known values', () => {
  assert.deepEqual(wilson(14, 14), [78.5, 100]);
  assert.deepEqual(wilson(0, 0), null);
  const [lo, hi] = wilson(285, 300);
  assert.ok(lo > 91 && lo < 93 && hi > 96 && hi < 97.5, `${lo} ${hi}`);
});

test('RUNS.md: every RUN line, with its END line or none (an aborted run stays listed)', () => {
  const text = [
    '# Wylls AI runs', '', '## a — 2026', 'RUN {"arm":null,"commitments_sha256":"aa","configs":{},"rep":null,"run_id":"a","start_unix":10}', 'END {"detail":"stopped before the end","end_unix":20,"run_id":"a","status":"aborted"}',
    '## ai-ab-A-1', 'RUN {"arm":"A","commitments_sha256":"bb","configs":{},"rep":1,"run_id":"ai-ab-A-1","start_unix":30}',
    '## c', 'RUN {"arm":null,"rep":null,"run_id":"c","start_unix":40}', 'END {"detail":"stack complete","end_unix":50,"run_id":"c","status":"complete"}', 'not json', 'END {not json}',
  ].join('\n');
  const runs = parseRuns(text);
  assert.deepEqual(runs.map((r) => [r.run_id, r.status, r.arm, r.rep]), [['a', 'aborted', null, null], ['ai-ab-A-1', 'no END line: aborted or still running', 'A', 1], ['c', 'complete', null, null]]);
  const real = parseRuns(readFileSync(new URL('../../docs/frontier/ai-citizens/RUNS.md', import.meta.url), 'utf8'));
  assert.ok(real.length >= 4 && real.some((r) => r.run_id === 'slice-4' && r.status === 'complete'), 'the real RUNS.md of this branch lists slice-1 to slice-4');
});

test('report on the slice-4 subset: decisions, by:model, marches (private host ids), memory, brain counters', () => {
  const r = buildReport({ aiDir: FIX, runsFile: new URL('../../docs/frontier/ai-citizens/RUNS.md', import.meta.url).pathname });
  assert.equal(r.local_test_chain_only, true);
  assert.equal(r.run_id, 'slice-4');
  assert.equal(r.sources.private_records, true);
  assert.equal(r.sources.minds_files, 4);
  // the 4 kept bells (24 records: 6 AIs x 4 bells): 12 below_gate, 4 feed_lag, 8 model sessions, all valid
  const d = r.decisions;
  assert.equal(d.records, 24);
  assert.equal(d.model_decisions, 8);
  assert.equal(d.valid_choices, 8);
  assert.equal(d.valid_rate_pct, 100);
  assert.equal(d.gate_open, 12);
  assert.equal(d.feed_lag.n, 4);
  assert.equal(d.fallbacks.total, 0);
  assert.equal(d.g1_threshold.underpowered, true);
  assert.equal(d.g1_threshold.met, false);
  assert.deepEqual(d.by_reason, { below_gate: 12, ok: 8, feed_lag: 4 });
  // by:model: the metrics snapshot is the FULL run's (21 of 146 sent actions); the records' tx are of the subset (13 of 15)
  assert.equal(r.by_model.total.actions_by_model, 21);
  assert.equal(r.by_model.total.actions_by_autopilot, 125);
  assert.equal(r.by_model.total.by_model_share_pct, 14.4);
  assert.equal(r.by_model.from_records_tx.actions_in_model_records, 13);
  assert.equal(r.by_model.from_records_tx.actions_in_autopilot_records, 2);
  // marches: 7 model marches in the 4 bells, none opened, each army has a clash episode (6 won, 1 lost)
  const m = r.marches;
  assert.equal(m.model_marches_sent, 7);
  assert.equal(m.opened, 0);
  assert.equal(m.y_strict, 0, 'Y counts opened records only: the wave-A run had no release job');
  assert.equal(m.g12_met, false);
  assert.equal(m.y_clash_without_opening, 7);
  assert.deepEqual(m.clash_results, { win: 6, loss: 1 });
  assert.equal(m.marches_without_known_host, 0);
  assert.match(m.y_clash_without_opening_note, /NOT Y/);
  assert.deepEqual(m.marches.map((x) => `${x.bell}:${x.index}`), ['40:1001', '40:1003', '40:1004', '52:1000', '64:1003', '64:1004', '70:1001']);
  assert.ok(m.marches.every((x) => x.clashes.length === 1 && x.clashes[0].camp === true));
  // memory
  const me = r.memory;
  assert.equal(me.episodes_total, 61);
  assert.deepEqual(me.episodes_by_kind, { build_done: 36, threat: 13, clash_own_win: 6, camp_cleared_own: 4, camp_taken_by: 1, clash_own_loss: 1 });
  assert.equal(me.decisions_citing_memory.of_model_decisions_with_known_choice, 8);
  assert.equal(me.decisions_citing_memory.from_records, 6);
  assert.deepEqual(me.cited_episode_kinds, { build_done: 14, clash_own_win: 1, camp_cleared_own: 1 }, 'most citations are of build_done lines: the report says so');
  assert.deepEqual(me.citation_among_key_kind_decisions, { n_with_key_episode_retrieved: 3, n_citing_at_least_one: 2, share_pct: 66.7, key_kinds: ['attacked_own', 'camp_taken_by', 'threat'], note: me.citation_among_key_kind_decisions.note });
  assert.equal(me.cited_episode_ages_bells.older_than_72, 0);
  assert.equal(me.cited_episode_ages_bells.earlier_in_the_season_may_be_said, false);
  assert.equal(me.mem_dropped, 0);
  assert.deepEqual(me.why_withheld_by_rule, { sealed_coordinate: 1 });
  // brain (the full run's counters)
  const b = r.brain;
  assert.equal(b.brain_steps, 423);
  assert.equal(b.no_session, 36);
  assert.match(b.no_session_source, /derived/);
  assert.equal(b.gets_per_step, null);
  assert.match(b.gets_note, /not measured/);
  assert.equal(b.steps_equal_records_plus_no_session, false, 'only 24 of the 387 records are in this fixture: the check is a real check');
  assert.equal(r.checks.records_equal_metrics_decisions_total, false);
  assert.equal(r.checks.model_marches_equal_brain_counter, true, 'the 7 model marches of the full run are all in the 4 kept bells');
  // runs listed
  assert.ok(r.runs_listed.length >= 4);
});

test('--public-only: nothing private is read; a sealed decision stays unknown and no host id is guessed', () => {
  const r = buildReport({ aiDir: FIX, privateOk: false });
  assert.equal(r.sources.private_records, false);
  assert.equal(r.marches.model_marches_sent, 7, 'the count of marches needs only the public tx');
  assert.equal(r.marches.marches_without_known_host, 7);
  assert.equal(r.marches.y_clash_without_opening, 0);
  assert.equal(r.marches.y_strict, 0);
  assert.equal(r.memory.decisions_with_unknown_choice, 7);
  assert.equal(r.memory.decisions_citing_memory.of_model_decisions_with_known_choice, 1, 'the one unsealed model decision');
  assert.match(r.memory.unknown_choice_note, /sealed/);
});

test('Y counts only OPENED records that produced a clash (synthetic: opened records added to a copy of the fixture)', () => {
  const dir = copyFix();
  const run = loadRun(dir);
  const sealed = run.records.filter((x) => x.mode === 'model' && x.sealed && x.tx.some((t) => t.intent === 'depart'));
  const pick = (index, bell) => sealed.find((x) => x.index === index && x.bell === bell);
  const a = pick(1001, 40);
  const b = pick(1004, 64);
  const c = pick(1000, 52);
  const host = (d) => String(d.candidates.find((k) => d.choice.ids.includes(k.id) && String(k.kind).startsWith('march')).facts.host_id);
  mkdirSync(join(dir, 'pub/open'), { recursive: true });
  // an opened record of a (a clash exists), b (a clash exists) and c, but c's destination names a host that never fought (synthetic)
  const open = (d, hostId) => ({ id: d.id, nonce: 'n', choice: d.choice, retrieved: d.retrieved, candidates: d.candidates, destinations: [{ host_id: hostId, p: 0, q: 0, tile: 1, planned_arrive_bell: d.release_bell - 1, arrive_bell: d.release_bell - 1 }] });
  writeFileSync(join(dir, 'pub/open/45.json'), JSON.stringify({ bell: 45, records: [open(a, host(a)), open(b, host(b)), open(c, '999999999999999')] }));
  const r = buildReport({ aiDir: dir });
  assert.equal(r.marches.opened, 3);
  assert.equal(r.marches.y_strict, 2, 'a and b opened and clashed; c opened, its host has no clash episode');
  assert.equal(r.marches.g12_met, true);
  assert.equal(r.marches.y_clash_without_opening, 7 - 1, 'c has no clash by its destination host id; the other six match through the private candidates');
  const mc = r.marches.marches.find((x) => x.record === c.id);
  assert.equal(mc.opened, true);
  assert.deepEqual(mc.clashes, []);
  assert.equal(mc.hosts_source, 'opened record');
  assert.match(renderMarkdown(r), /Y \(strict\) = 2/);
});

// ---- synthetic minds files for the valid-rate and fallback arithmetic -----------------------------------------------------
function synthetic(records, { metrics = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-report-syn-'));
  mkdirSync(join(dir, 'pub/minds'), { recursive: true });
  const byBell = {};
  records.forEach((r, i) => {
    const full = { v: 2, id: `${i.toString(16).padStart(3, '0')}`.padEnd(64, 'f'), ai: 'a'.repeat(16), index: 1000, bell: 10 + Math.floor(i / 4), sealed: false, tx: [], wake: [], public: { say: [], why: null }, attempts: 1, ...r };
    (byBell[full.bell] ??= []).push(full);
  });
  for (const [b, recs] of Object.entries(byBell)) writeFileSync(join(dir, `pub/minds/${b}.json`), JSON.stringify({ bell: Number(b), root: '0'.repeat(64), records: recs }));
  if (metrics) { mkdirSync(join(dir, 'pub/metrics'), { recursive: true }); writeFileSync(join(dir, 'pub/metrics/latest.json'), JSON.stringify(metrics)); }
  return dir;
}

test('valid-choice and fallback arithmetic (synthetic records): reflections, no_time and feed_lag are kept out of the rate', () => {
  const choice = (ids) => ({ ids, params: {}, council: null, goal_id: 'G1', mem: [] });
  const sent = [{ intent: 'build', sig: 's', status: 'sent' }];
  const dir = synthetic([
    { kind: 'session', mode: 'model', reason: 'ok', choice: choice(['c3']), tx: sent },
    { kind: 'session', mode: 'model', reason: 'ok', choice: choice(['c1']), tx: [] }, // autopilot choice: valid with no tx
    { kind: 'session', mode: 'model', reason: 'ok', choice: choice(['c2']), tx: [] }, // hold: valid
    { kind: 'session', mode: 'model', reason: 'ok', choice: choice(['c3']), tx: [{ intent: 'build', status: 'refused', sig: 'x' }] }, // nothing survived V6
    { kind: 'session', mode: 'autopilot', reason: 'invalid:V1', tx: [] },
    { kind: 'session', mode: 'autopilot', reason: 'timeout', tx: [] },
    { kind: 'reaction', mode: 'model', reason: 'ok', tx: [] },
    { kind: 'motion', mode: 'autopilot', reason: 'llm_error', tx: [] },
    { kind: 'session', mode: 'autopilot', reason: 'late', tx: [] },
    { kind: 'session', mode: 'autopilot', reason: 'no_time', tx: [] },
    { kind: 'autopilot', mode: 'autopilot', reason: 'feed_lag', tx: [] },
    { kind: 'autopilot', mode: 'autopilot', reason: 'below_gate', tx: [] },
    { kind: 'autopilot', mode: 'autopilot', reason: 'season_end', tx: [] },
    { kind: 'reflection', mode: 'autopilot', reason: 'invalid:V5b', tx: [] },
    { kind: 'reflection', mode: 'model', reason: 'ok', tx: [] },
    { kind: 'ballot', mode: 'model', reason: 'ok', tx: [] },
  ]);
  const d = decisionsSection(loadRun(dir), null);
  assert.equal(d.records, 16);
  assert.equal(d.model_decisions, 10, 'sessions, reactions, motions, ballots that reached the model, no_time and reflections excluded');
  assert.equal(d.valid_choices, 5);
  assert.deepEqual(d.fallbacks.by_reason, { 'v6_all_refused': 1, 'invalid:V1': 1, timeout: 1, llm_error: 1, late: 1 });
  assert.equal(d.fallbacks.total, 5);
  assert.equal(d.fallbacks.rate_pct, 50);
  assert.equal(d.dropped_for_time.n, 1);
  assert.equal(d.feed_lag.n, 1);
  assert.equal(d.gate_open, 12, 'everything except below_gate, season_end and the reflection jobs (they pass no gate)');
  assert.deepEqual(d.reflections, { n: 2, ok: 1, refused_or_failed: 1, by_reason: { 'invalid:V5b': 1, ok: 1 }, note: 'listed on their own; not in the valid-choice rate' });
  assert.equal(d.g1_threshold.min_n, 300);
});

test('markdown: states local test chain, Y strict, underpowered n and every run; no flattering words', () => {
  const md = renderMarkdown(buildReport({ aiDir: FIX, runsFile: new URL('../../docs/frontier/ai-citizens/RUNS.md', import.meta.url).pathname }));
  for (const must of ['Local test chain only', 'Not devnet, not mainnet', 'Y (strict) = 0', 'underpowered', 'slice-1', 'slice-4', 'not measured', 'do not show', 'NOT Y']) assert.ok(md.includes(must), `missing: ${must}`);
  for (const bad of ['devnet is', 'mainnet is', 'stronger than', 'indistinguishable', 'the ai wants', 'traction is', 'earn']) assert.equal(md.toLowerCase().includes(bad.toLowerCase()), false, bad);
  assert.ok(/does not show|do not show/i.test(md) && /wants or intends anything/.test(md), 'the words "wants" and "intends" appear only in the sentence that disclaims them');
});

test('CLI: node report.mjs --ai-dir writes JSON and Markdown and exits 0', () => {
  const out = mkdtempSync(join(tmpdir(), 'ai-report-cli-'));
  const r = spawnSync(process.execPath, [new URL('../citizens/report.mjs', import.meta.url).pathname, '--ai-dir', FIX, '--out', join(out, 'r.json'), '--md', join(out, 'r.md')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(out, 'r.json'), 'utf8'));
  assert.equal(j.kind, 'run-report');
  assert.ok(readFileSync(join(out, 'r.md'), 'utf8').startsWith('# AI citizens run report: slice-4'));
  assert.equal(spawnSync(process.execPath, [new URL('../citizens/report.mjs', import.meta.url).pathname], { encoding: 'utf8' }).status, 2);
});
