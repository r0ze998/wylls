// FB2: fixes C1-C5 of the integ-B review of citizens/report.mjs. Every test builds a SYNTHETIC run (records written by hand, none of the
// slice-4 numbers) and says what the old code printed. Each test fails on the report.mjs of frontier/ai-integ 0cc0973.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, renderMarkdown, brainSection, decisionsSection, loadRun } from '../citizens/report.mjs';

const TAG = 'a'.repeat(16);
const idOf = (i) => `${i.toString(16).padStart(3, '0')}`.padEnd(64, 'f');
const sent = (intent = 'depart') => [{ intent, sig: `sig-${intent}`, status: 'sent' }];

/**
 * records: [{kind, mode, reason, bell?, tx?, sealed?, choice?, candidates?, intended?}]. A record with `candidates` gets a private-journal
 * line (the operator side, state/records.jsonl) so its choice can be read; `opened` adds an opened record under pub/open.
 */
function synth(records, { brain = null, episodes = null, opened = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-report-fb2-'));
  mkdirSync(join(dir, 'pub/minds'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  const byBell = {};
  const journal = [];
  const openRecs = [];
  records.forEach((r, i) => {
    const { candidates, intended, ...rest } = r;
    const full = { v: 2, id: idOf(i), ai: TAG, index: 1000, bell: 10 + Math.floor(i / 4), sealed: false, tx: [], wake: [], public: { say: [], why: null }, attempts: 1, ...rest };
    (byBell[full.bell] ??= []).push(full);
    if (candidates || intended) journal.push(JSON.stringify({ op: 'add', entry: { id: full.id, bell: full.bell, index: 1000, kind: full.kind, seq: i, full: { choice: r.choice ?? null, retrieved: [] }, priv: { candidates: candidates ?? null, intended: intended ?? [] } } }));
    if (opened[i]) openRecs.push({ id: full.id, nonce: 'n', choice: r.choice, retrieved: [], candidates: candidates ?? null, destinations: opened[i] });
  });
  for (const [b, recs] of Object.entries(byBell)) writeFileSync(join(dir, `pub/minds/${b}.json`), JSON.stringify({ bell: Number(b), root: '0'.repeat(64), records: recs }));
  writeFileSync(join(dir, 'state/records.jsonl'), journal.join('\n') + (journal.length ? '\n' : ''));
  if (openRecs.length) { mkdirSync(join(dir, 'pub/open'), { recursive: true }); writeFileSync(join(dir, 'pub/open/99.json'), JSON.stringify({ bell: 99, records: openRecs })); }
  if (episodes) { mkdirSync(join(dir, `pub/memory/${TAG}`), { recursive: true }); writeFileSync(join(dir, `pub/memory/${TAG}/episodes.json`), JSON.stringify({ tag: TAG, episodes })); }
  if (brain) { mkdirSync(join(dir, 'fleet'), { recursive: true }); writeFileSync(join(dir, 'fleet/ai-brain.json'), JSON.stringify(brain)); }
  return dir;
}

const march = (id, host, extra = {}) => ({ id, kind: 'march', label: 'march', facts: { host_id: String(host), target_kind: 'camp' }, flags: {}, ...extra });
const choice = (ids) => ({ ids, params: {}, council: null, goal_id: 'G1', mem: [] });
const clash = (id, host, bell) => ({ id, kind: 'clash_own_win', bell, created_bell: bell + 1, src: [`host:${host}`], facts: { camp: true, lost_own: 5, lost_enemy: 9 } });

// ---- C1 ---------------------------------------------------------------------------------------------------------------------
test('C1: a council job refused with feed_lag (kind ballot or motion, mode autopilot) is not a model decision; valid + fallbacks = model decisions', () => {
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', choice: choice(['c2']), candidates: [{ id: 'c2', kind: 'hold' }] },
    { kind: 'ballot', mode: 'model', reason: 'ok' },
    { kind: 'motion', mode: 'model', reason: 'ok' },
    { kind: 'ballot', mode: 'autopilot', reason: 'feed_lag' },
    { kind: 'ballot', mode: 'autopilot', reason: 'feed_lag' },
    { kind: 'motion', mode: 'autopilot', reason: 'feed_lag' },
    { kind: 'motion', mode: 'autopilot', reason: 'not_ready' }, // a council job that never reached the model either
    { kind: 'ballot', mode: 'autopilot', reason: 'timeout' }, // a real fallback
    { kind: 'autopilot', mode: 'autopilot', reason: 'feed_lag' }, // the session path (the old test's only case)
    { kind: 'autopilot', mode: 'autopilot', reason: 'below_gate' },
  ]);
  const d = decisionsSection(loadRun(dir), null);
  assert.equal(d.model_decisions, 4, 'the session, the ballot, the motion and the timeout reached the model; feed_lag and not_ready did not');
  assert.equal(d.valid_choices, 3);
  assert.equal(d.fallbacks.total, 1);
  assert.deepEqual(d.fallbacks.by_reason, { timeout: 1 });
  assert.equal(d.valid_choices + d.fallbacks.total, d.model_decisions, 'the invariant');
  assert.equal(d.invariant_valid_plus_fallbacks_equals_model_decisions, true);
  assert.equal(d.model_decisions_unclassified, 0);
  assert.equal(d.valid_rate_pct, 75);
  assert.equal(d.feed_lag.n, 4, 'the feed_lag line counts every kind');
  assert.deepEqual(d.feed_lag.by_kind, { ballot: 2, motion: 1, autopilot: 1 });
  const r = buildReport({ aiDir: dir });
  assert.equal(r.checks.valid_plus_fallbacks_equal_model_decisions, true);
  assert.match(renderMarkdown(r), /feed_lag \(gate open, job refused before the model; all kinds\) \| 4 /);
});

test('C1: a model decision that is neither valid nor a fallback shows up, the invariant turns false (the check can fail)', () => {
  const dir = synth([{ kind: 'ballot', mode: 'autopilot', reason: 'ok' }, { kind: 'session', mode: 'model', reason: 'ok', choice: choice(['c2']), candidates: [{ id: 'c2', kind: 'hold' }] }]);
  const d = decisionsSection(loadRun(dir), null);
  assert.equal(d.model_decisions, 2);
  assert.equal(d.model_decisions_unclassified, 1);
  assert.equal(d.invariant_valid_plus_fallbacks_equals_model_decisions, false);
});

// ---- C2 ---------------------------------------------------------------------------------------------------------------------
test('C2: GETs are the gets:* counters only; follow_fetch_gets (the same figure as gets:fetch_path) is not added; per step per AI from per_bot; herald load is not measured', () => {
  const dir = synth([], {
    brain: {
      ai_bots: 2,
      counters: { steps: 20, no_session: 2, answers_model: 3, answers_autopilot: 15, answers_reused: 0, 'gets:me': 30, 'gets:fetch_path': 12, follow_fetch_gets: 12, 'gets:reobserve': 8 },
      per_bot: {
        1000: { steps: 10, no_session: 1, 'gets:me': 14, 'gets:fetch_path': 12, follow_fetch_gets: 12, 'gets:reobserve': 4 },
        1001: { steps: 10, no_session: 1, 'gets:me': 16, 'gets:reobserve': 4 },
      },
    },
  });
  const b = brainSection(join(dir, 'fleet'), loadRun(dir));
  assert.equal(b.gets_per_step.gets, 50, '30 + 12 + 8; the old pattern also added follow_fetch_gets (62)');
  assert.deepEqual(b.gets_per_step.keys, ['gets:me', 'gets:fetch_path', 'gets:reobserve']);
  assert.equal(b.gets_per_step.per_step, 2.5);
  const pa = b.gets_per_step.per_step_per_ai;
  assert.deepEqual(pa.per_ai.map((x) => [x.index, x.steps, x.gets, x.per_step]), [[1000, 10, 30, 3], [1001, 10, 20, 2]]);
  assert.equal(pa.min, 2); assert.equal(pa.max, 3); assert.equal(pa.mean, 2.5);
  assert.equal(pa.per_bot_sum_equals_total, true);
  assert.match(b.herald_load, /^not measured/);
  const r = buildReport({ aiDir: dir });
  assert.equal(r.checks.gets_per_bot_sum_equals_total, true);
  assert.ok(r.not_measured.some((x) => /herald load/.test(x)), 'the herald load is listed under not_measured');
  const md = renderMarkdown(r);
  assert.match(md, /GETs per step per AI: min 2, mean 2.5, max 3/);
  assert.match(md, /Herald load during the run: not measured/);
  assert.match(md, /no_session/);
});

test('C2: without per_bot the per-AI figure is stated as unavailable, not invented', () => {
  const dir = synth([], { brain: { ai_bots: 2, counters: { steps: 20, no_session: 2, 'gets:me': 30 } } });
  const b = brainSection(join(dir, 'fleet'), loadRun(dir));
  assert.equal(b.gets_per_step.gets, 30);
  assert.equal(b.gets_per_step.per_step_per_ai, null);
  assert.match(b.gets_per_step.per_step_per_ai_note, /per_bot/);
});

// ---- C3 ---------------------------------------------------------------------------------------------------------------------
test('C3: a model march is a chosen own-march candidate that was sent: a follow depart under a hold choice, a recall and a Call-flagged march are not', () => {
  const cands = [{ id: 'c1', kind: 'autopilot' }, { id: 'c2', kind: 'hold' }, march('c4', 111), { id: 'c5', kind: 'recall:H1', facts: { host_id: '222' } }, march('c6', 333, { facts: { host_id: '333', target_kind: 'call' }, council: true })];
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', bell: 20, tx: sent(), choice: choice(['c4']), candidates: cands }, // a real model march
    { kind: 'session', mode: 'model', reason: 'ok', bell: 21, tx: sent(), choice: choice(['c2']), candidates: cands }, // hold chosen; the depart is the brain's Strike-Order follow
    { kind: 'session', mode: 'model', reason: 'ok', bell: 22, tx: sent(), choice: choice(['c5']), candidates: cands }, // a recall (a depart in the tx too)
    { kind: 'session', mode: 'model', reason: 'ok', bell: 23, tx: sent(), choice: choice(['c6']), candidates: cands }, // the Strike Order's march
    { kind: 'session', mode: 'model', reason: 'ok', bell: 24, tx: [{ intent: 'depart', status: 'refused', sig: 'x' }], choice: choice(['c4']), candidates: cands }, // refused: nothing sent
  ], { brain: { ai_bots: 1, counters: { steps: 5, no_session: 0, answers_model: 5, model_marches_sent: 1, model_strike_order_marches_sent: 1 } }, episodes: [clash('e1', 111, 25), clash('e2', 222, 25), clash('e3', 333, 25)] });
  const m = buildReport({ aiDir: dir }).marches;
  assert.equal(m.model_marches_sent, 1, 'the old report counted all four sent departs');
  assert.deepEqual(m.marches.map((x) => x.bell), [20]);
  assert.deepEqual(m.excluded_from_model_marches, { records_with_recall_chosen: 1, records_with_strike_order_chosen: 1 });
  assert.equal(m.model_marches_unclassified, 0);
  assert.equal(m.chosen_march_candidates_all_kinds, 3, 'the mind counts every chosen march candidate: c4, c6, c4 (refused)');
  const r = buildReport({ aiDir: dir });
  assert.equal(r.checks.model_marches_equal_brain_counter, true);
  assert.equal(r.brain.model_strike_order_marches_sent_brain, 1);
});

test('C3: Y does not count a follow: an opened record whose destination is a Strike-Order follow with a clash episode adds nothing', () => {
  const cands = [{ id: 'c2', kind: 'hold' }, march('c4', 111)];
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', bell: 20, sealed: true, tx: sent(), choice: choice(['c2']), candidates: cands },
    { kind: 'session', mode: 'model', reason: 'ok', bell: 30, sealed: true, tx: sent(), choice: choice(['c4']), candidates: cands },
  ], { episodes: [clash('e1', 111, 33)], opened: { 0: [{ host_id: '111', via: 'strike_order', planned_arrive_bell: 22 }], 1: [{ host_id: '111', via: 'model', planned_arrive_bell: 32 }] } });
  const m = buildReport({ aiDir: dir }).marches;
  assert.equal(m.model_marches_sent, 1);
  assert.equal(m.opened, 1);
  assert.equal(m.y_strict, 1, 'only the model march at bell 30 counts; the old report counted the follow at bell 20 as a second Y');
});

test('C3: a model record with a sent depart whose choice cannot be read is unclassified: neither counted nor ruled out, and the brain check is unknown', () => {
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', bell: 20, sealed: true, tx: sent() }, // sealed, no private line, not opened
  ], { brain: { ai_bots: 1, counters: { steps: 1, no_session: 0, answers_model: 1, model_marches_sent: 1 } } });
  const r = buildReport({ aiDir: dir });
  assert.equal(r.marches.model_marches_sent, 0);
  assert.equal(r.marches.model_marches_unclassified, 1);
  assert.match(r.marches.model_marches_unclassified_note, /neither counted as model marches nor ruled out/);
  assert.equal(r.checks.model_marches_equal_brain_counter, null);
  assert.equal(r.checks.chosen_march_candidates_equal_mind_counter, null);
  assert.match(renderMarkdown(r), /1 sent departs in model records are unclassified/);
});

// ---- C4 ---------------------------------------------------------------------------------------------------------------------
test('C4: brain steps are compared with the records of kinds session, reaction and autopilot only (reflection, motion and ballot are mind jobs)', () => {
  const hold = { choice: choice(['c2']), candidates: [{ id: 'c2', kind: 'hold' }] };
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', ...hold },
    { kind: 'session', mode: 'model', reason: 'ok', ...hold },
    { kind: 'reaction', mode: 'model', reason: 'ok' },
    { kind: 'autopilot', mode: 'autopilot', reason: 'below_gate' },
    { kind: 'autopilot', mode: 'autopilot', reason: 'below_gate' },
    { kind: 'reflection', mode: 'model', reason: 'ok' },
    { kind: 'reflection', mode: 'autopilot', reason: 'invalid:V5b' },
    { kind: 'motion', mode: 'model', reason: 'ok' },
    { kind: 'ballot', mode: 'model', reason: 'ok' },
  ], { brain: { ai_bots: 1, counters: { steps: 9, no_session: 2, answers_reused: 2, answers_model: 3, answers_autopilot: 2 } } });
  const r = buildReport({ aiDir: dir });
  const b = r.brain;
  assert.equal(b.records_in_pub, 9);
  assert.equal(b.step_records_in_pub, 5);
  assert.equal(b.job_records_in_pub, 4);
  assert.equal(b.steps_equal_records_plus_no_session, true, 'steps 9 = 5 step records + 2 no_session + 2 same-bell repeats; the old code compared 9 with all 9 records + 2');
  assert.equal(r.checks.brain_first_call_answers_equal_step_records, true, 'first-call answers 5 = step records 5; the old code compared with all 9 records');
  assert.match(b.steps_equation, /4 further records are mind jobs/);
});

test('C4: the check can still fail: a missing step record makes it false', () => {
  const dir = synth([
    { kind: 'autopilot', mode: 'autopilot', reason: 'below_gate' },
    { kind: 'motion', mode: 'model', reason: 'ok' },
    { kind: 'ballot', mode: 'model', reason: 'ok' },
  ], { brain: { ai_bots: 1, counters: { steps: 3, no_session: 0, answers_model: 0, answers_autopilot: 3 } } });
  const r = buildReport({ aiDir: dir });
  assert.equal(r.brain.steps_equal_records_plus_no_session, false, '3 steps, 1 step record: two steps left no record');
  assert.equal(r.checks.brain_first_call_answers_equal_step_records, false);
});

// ---- C5 ---------------------------------------------------------------------------------------------------------------------
test('C5: the Y proxy is named and disclosed; an episode before the march does not count (a reused host id); y_strict carries the proxy note', () => {
  const cands = [{ id: 'c2', kind: 'hold' }, march('c4', 111)];
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', bell: 20, sealed: true, tx: sent(), choice: choice(['c4']), candidates: cands },
    { kind: 'session', mode: 'model', reason: 'ok', bell: 40, sealed: true, tx: sent(), choice: choice(['c4']), candidates: cands },
  ], { episodes: [clash('e1', 111, 25)], opened: { 0: [{ host_id: '111', via: 'model' }], 1: [{ host_id: '111', via: 'model' }] } });
  const r = buildReport({ aiDir: dir });
  const m = r.marches;
  assert.equal(m.model_marches_sent, 2);
  assert.equal(m.y_strict, 1, 'the clash at bell 25 belongs to the march at bell 20; the march at bell 40 left after it (the old code credited both, Y = 2)');
  assert.deepEqual(m.marches.map((x) => x.clashes.length), [1, 0]);
  assert.equal('y_clash_without_opening' in m, false, 'the mislabelled name is gone');
  assert.equal(m.y_proxy_clash_any_opening, 1);
  assert.equal(m.y_proxy_clash_unopened_only, 0, 'both records were opened: the old caption said "the record was not opened" next to a number of opened ones');
  assert.equal(m.y_basis, 'episode_proxy');
  for (const k of ['y_strict_definition', 'y_proxy_note']) assert.match(m[k], /EPISODE PROXY|episode proxy/i, k);
  assert.match(m.y_proxy_note, /engaged: true, contract 10\.1\) were not read/);
  assert.ok(r.not_measured.some((x) => /clash report rows \(engaged: true\)/.test(x)));
  const md = renderMarkdown(r);
  assert.match(md, /Y is an episode proxy: the herald clash rows \(engaged: true\) were not read/);
  assert.match(md, /Y \(strict\) = 1\*\*, an episode proxy/);
  assert.doesNotMatch(md, /the record was not opened/);
});

test('C5: y_proxy_clash_unopened_only counts only records that were not opened', () => {
  const cands = [march('c4', 111), march('c5', 222)];
  const dir = synth([
    { kind: 'session', mode: 'model', reason: 'ok', bell: 20, sealed: true, tx: sent(), choice: choice(['c4']), candidates: cands },
    { kind: 'session', mode: 'model', reason: 'ok', bell: 30, sealed: true, tx: sent(), choice: choice(['c5']), candidates: cands },
  ], { episodes: [clash('e1', 111, 25), clash('e2', 222, 35)], opened: { 0: [{ host_id: '111', via: 'model' }] } });
  const m = buildReport({ aiDir: dir }).marches;
  assert.equal(m.y_strict, 1);
  assert.equal(m.y_proxy_clash_any_opening, 2);
  assert.equal(m.y_proxy_clash_unopened_only, 1);
});
