// ⑯ independent check of ⑬'s run port (resident/ports/ws04-run.mjs) against REAL run views of ④'s candidate
// 20db3313: every run ④'s own fault/state tests stored, read with `runexec run view` (p04-run/0.1) and saved to
// V16_VIEWS (JSON lines). Keyless: reads JSON only.
//   R1 on real views, the effect fields never disagree (no contradictory unknown);
//   R2 on real views, a run whose attempts or receipts show the caravan left is never `failed`/`cancelled`;
//   R3 defensive: a stopped view whose effect fields are all empty but whose ship attempt landed (or whose receipts
//      hold caravan_sent, or which is still in flight) — does the port say `failed` (re-decidable) or `unknown`?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fateOfRun } from '../../../workstreams/13-citizens/resident/ports/ws04-run.mjs';

const VIEWS = readFileSync(process.env.V16_VIEWS, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const shipLanded = v => (v.attempts ?? []).some(a => a.step === 'ship' && a.status === 'landed');
const receiptSent = v => (v.receipts ?? []).some(r => String(r.kind ?? r.body?.kind ?? '').includes('caravan_sent') || JSON.stringify(r).includes('"caravan_sent"'));

test('R1: no real view is contradictory', () => {
  const bad = VIEWS.filter(x => /contradictory/.test(fateOfRun(x.view)?.why ?? ''));
  assert.equal(bad.length, 0, bad.map(b => `${b.store} ${b.run_id}`).join(', '));
  assert.ok(VIEWS.length > 100, `views read: ${VIEWS.length}`);
});

test('R2: no real view that shows the caravan left is read as failed or cancelled', () => {
  const bad = VIEWS.filter(x => (shipLanded(x.view) || receiptSent(x.view)) && ['failed', 'cancelled'].includes(fateOfRun(x.view).fate));
  assert.equal(bad.length, 0, bad.map(b => `${b.store} ${b.run_id} ${b.view.state}`).join(', '));
});

test('R3: a stopped view with empty effect fields but other evidence of a departure', () => {
  const base = VIEWS.find(x => x.view.state === 'Fulfilled' && shipLanded(x.view)).view;
  const empty = { effects: [], sent: false, outcome: { ...(base.outcome ?? {}), effects: [] } };
  const out = {};
  for (const state of ['Failed', 'Expired', 'Cancelled']) {
    out[`${state}+ship landed`] = fateOfRun({ ...base, ...empty, state, terminal: true, receipts: [] }).fate;
    out[`${state}+receipt caravan_sent`] = fateOfRun({ ...base, ...empty, state, terminal: true, attempts: [] }).fate;
    out[`${state}+in_flight`] = fateOfRun({ ...base, ...empty, state, terminal: true, attempts: [], receipts: [], in_flight: true }).fate;
    out[`${state}+fees unconfirmed`] = fateOfRun({ ...base, ...empty, state, terminal: true, attempts: [], receipts: [], fees: { ...base.fees, unconfirmed: 5000 } }).fate;
  }
  console.log('R3', JSON.stringify(out));
  // Recorded, not asserted: this is the port's current reading of fields it does not consult.
});
