// The A/B pilot reader (citizens/ab/pilot.mjs): host readiness bell by bell, the invited trace, the follow-window trace of the AIs, one
// period's report from injected chain reads. Synthetic inputs (labelled): no herald, no stack, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBallot, fromBase58, toBase64, toBase58 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { DEPART_STAMINA, aiFollowTrace, hostStatus, invitedTrace, openedBallots, periodReport, pivotCondition, renderPilot, staminaAt } from '../citizens/ab/pilot.mjs';
import { computeT } from '../citizens/ab/run-ab.mjs';

const host = (over = {}) => ({ id: '1', state: 1, from_bell: 10, ready_bell: 20, stamina: 120, stamina_bell: 0, unit: 1, ...over }); // SYNTHETIC

test('hostStatus: ready only when on the roster, mustered, past its ready bell and with the stamina a Depart charges', () => {
  assert.equal(DEPART_STAMINA, 74);
  assert.equal(hostStatus(host(), 30).ready, true);
  assert.equal(hostStatus(null, 30).why, 'away');
  assert.equal(hostStatus(host({ state: 2 }), 30).why, 'not_roster');
  assert.equal(hostStatus(host({ from_bell: 40 }), 30).why, 'not_mustered');
  assert.equal(hostStatus(host({ ready_bell: 35 }), 30).why, 'not_ready');
  const tired = host({ stamina: 60, stamina_bell: 28 });
  assert.equal(hostStatus(tired, 30).why, 'resting');
  assert.equal(staminaAt(tired, 30), 62);
  assert.equal(hostStatus(tired, 42).ready, true, 'stamina comes back one per bell: 60 + 14 = 74 at bell 42');
  assert.equal(staminaAt(host({ stamina: 119, stamina_bell: 0 }), 500), 120, 'capped');
});

test('invitedTrace: the ready count at C0 + 6 and in the window, host by host; computeT from it', () => {
  const c0 = 48, s = 60;
  const table = { 'A': (b) => host({ id: 'A' }), 'B': (b) => (b >= 56 ? host({ id: 'B' }) : host({ id: 'B', ready_bell: 99 })), 'C': () => null };
  const t = invitedTrace({ invited: ['A', 'B', 'C'], c0, s, hostAt: (id, b) => table[id](b), kindOf: (id) => ({ A: 'ai', B: 'script', C: 'ai' })[id] });
  assert.equal(t.invited, 3);
  assert.equal(t.ready_at_c0_plus_6, 1, 'only A is ready at bell 54');
  assert.equal(t.ready_in_window, 2, 'B becomes ready at 56');
  assert.deepEqual(Object.keys(t.rows[0].by_bell).map(Number), [53, 54, 55, 56, 57, 58, 59], 'C0 + 5 to S - 1');
  assert.equal(t.rows[2].by_bell[54].why, 'away');
  assert.deepEqual([0, 1, 2, 3, 4].map(computeT), [2, 2, 2, 3, 3], 'T = min(3, ready), never below 2');
});

function ballotB64(wallet58, option, origin) {
  const bytes = encodeBallot({ season: 1, period: 2, wallet: fromBase58(wallet58), faction: 0, option, candidates_hash: new Uint8Array(32), nonce: new Uint8Array(16), origin });
  return toBase64(bytes);
}
const W_AI = toBase58(new Uint8Array(32).fill(1));
const W_SEAT = toBase58(new Uint8Array(32).fill(2));

test('openedBallots and the pivot condition: at least one nation-0 AI ballots the winning option', () => {
  const file = { open: { ballots: [{ bytes_b64: ballotB64(W_AI, 1, 1) }, { bytes_b64: ballotB64(W_SEAT, 1, 2) }, { sig_b64: 'x' }] } };
  const b = openedBallots(file, new Set([W_AI]));
  assert.deepEqual(b.map((x) => [x.ai, x.option, x.origin]), [[true, 1, 1], [false, 1, 2]]);
  assert.equal(pivotCondition(b, 1), true);
  assert.equal(pivotCondition(b, 2), false);
  assert.equal(pivotCondition(openedBallots({ open: { ballots: [{ bytes_b64: ballotB64(W_SEAT, 1, 2) }] } }, new Set([W_AI])), 1), false, 'a seat ballot alone is not the pivot condition');
});

test('aiFollowTrace: a Strike Order candidate offered in the window and whether the choice named it', () => {
  const body = (extra) => ({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: `NOW\nc1 [autopilot] Routine\nc2 [hold] Hold\n${extra}` }] });
  const requests = { r1: body('c3 [march, Strike Order] Follow the Strike Order with H1'), r2: body('c3 [build] Build'), r3: body('c3 [march, Strike Order] Follow the Strike Order') };
  const records = [
    { id: 'r1', full: { ai: 'aa', bell: 55, kind: 'session', mode: 'model', choice: { ids: ['c3'] } } },
    { id: 'r2', full: { ai: 'aa', bell: 56, kind: 'session', mode: 'model', choice: { ids: ['c3'] } } },
    { id: 'r3', full: { ai: 'bb', bell: 57, kind: 'session', mode: 'model', choice: { ids: ['c1'] } } },
    { id: 'r4', full: { ai: 'bb', bell: 40, kind: 'session', mode: 'model', choice: { ids: ['c1'] } } }, // before the window
    { id: 'r5', full: { ai: 'zz', bell: 56, kind: 'session', mode: 'model', choice: { ids: ['c1'] } } }, // not a nation-0 AI
  ];
  const rows = aiFollowTrace({ records, requestOf: (id) => requests[id] ?? null, aiTags: new Set(['aa', 'bb']), c0: 48, s: 60 });
  assert.deepEqual(rows.map((r) => [r.bell, r.ai, r.strike_order_candidates, r.chose_strike_order]), [[55, 'aa', ['c3'], true], [56, 'aa', [], false], [57, 'bb', ['c3'], false]]);
});

test('periodReport: invited hosts, departures arriving at S, pivot condition, the council file\'s result; renders', () => {
  const roster = { ai: [{ wallet: W_AI, tag: 'aa', faction: 0, name: { en: 'Nerin' } }, { wallet: 'W2', tag: 'bb', faction: 0 }, { wallet: 'W3', tag: 'cc', faction: 2 }], seat: { wallet: W_SEAT, tag: 'ss', faction: 0 } };
  const file = {
    period: 2, c0: 48, strike_bell: 60, follow_from: 54, options_hash: 'oh', candidates_hash: 'ch', candidates: [{ option: 1, kind: 'camp', p: 3, q: 0, ratio: 'even' }],
    motions: [{ wallet: W_AI, option: 1, name: { en: 'Nerin' } }], tally_split: { ai: 1, human: 0, scripted: 1 }, adopted: true,
    open: { option: 1, p: 3, q: 0, tile: 4, invited: ['10', '11', '12'], ballots: [{ bytes_b64: ballotB64(W_AI, 1, 1) }, { bytes_b64: ballotB64(W_SEAT, 1, 2) }] },
    result: { present: 2, bounced: 0, present_hosts: ['10', '11'], clash: { engagements: 1, lost: { 0: 5, 3: 200 } } },
  };
  const kinds = { 10: 'ai', 11: 'ai', 12: 'script', 99: 'script' };
  const factions = { 10: 0, 11: 0, 12: 0, 99: 0, 50: 3 };
  const events = {
    54: [{ kind: 'DEPART', host_id: '10', arrive_bell: 60, depart_bell: 54 }, { kind: 'DEPART', host_id: '50', arrive_bell: 60, depart_bell: 54 }],
    55: [{ kind: 'DEPART', host_id: '11', arrive_bell: 60, depart_bell: 55 }, { kind: 'DEPART', host_id: '99', arrive_bell: 61, depart_bell: 55 }],
    60: [{ kind: 'REVEAL', arrive: 60, faction: 0, p: 3, q: 0, host_id: '10' }, { kind: 'REVEAL', arrive: 60, faction: 0, p: 3, q: 0, host_id: '11' }, { kind: 'REVEAL', arrive: 60, faction: 3, p: 3, q: 0, host_id: '50' }],
  };
  const r = periodReport({ file, roster, hostAt: (id, b) => (id === '12' ? null : host({ id })), eventsAt: (b) => events[b] ?? [], factionOf: (id) => factions[id] ?? null, kindOf: (id) => kinds[id] ?? 'unknown' });
  assert.equal(r.pivot_condition, true);
  assert.equal(r.invited.invited, 3);
  assert.equal(r.ready_invited_at_c0_plus_6, 2, 'hosts 10 and 11 are ready, 12 is away');
  assert.deepEqual(r.nation0_departs_arriving_at_s.map((d) => d.host_id), ['10', '11'], 'a nation-3 host and a march arriving at another bell are not counted');
  assert.equal(r.invited_hosts_departing, 2);
  assert.deepEqual(r.nation0_revealed_at_target_at_s.map((d) => d.host_id), ['10', '11']);
  assert.equal(r.result.present, 2);
  assert.deepEqual(r.ai_motions, [{ name: 'Nerin', option: 1 }]);
  const md = renderPilot({ run_id: 'x', rep: 1, motion_rate: { periods_total: 1, periods_with_options: 1, periods_with_ai_motion: 1, periods_adopted: 1, periods_opened: 1 }, seat: { ballots: [], ineligible_periods: [] }, periods: [r], T: 2, ready_for_T: 2, counters_ai_fleet: {}, counters_script_bots: null, limits: ['l'] });
  assert.match(md, /ready at C0 \+ 6: \*\*2\*\*/);
  assert.match(md, /T \(contract 9\.3\)/);
});
