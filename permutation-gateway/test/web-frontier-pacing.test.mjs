// world4-pacing-impl: the page's and the AI residents' mirrors of the next world's pacing bytes (frontier-abi
// `v2::pacing`): legacy for every world before the bytes (world 3), the decided values for a `pacing` 1 world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pacingOf, minLeadOf, earliestArrivalBell, LEGACY, DEPART_STAMINA_LEGACY } from '../../permutation-server/web/frontier/fpacing.mjs';
import { arrivalWindow, earliestBell, DEPART_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';
import { createResidentMemory, decideNext, noteOutcome } from '../src/frontier/local-play-operator-policy.mjs';

const presets = JSON.parse(readFileSync(new URL('../../frontier-abi/vectors/v2/presets.json', import.meta.url), 'utf8'));
const s1 = name => {
  const p = presets.presets_s1.find(x => x.name === name);
  assert.ok(p, name);
  return p.fields;
};
// (a decoded Season as the page holds it: base fields at the top, the conquest block as conquestParams)
const camel = n => n.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const seasonOf = f => ({ minLead: f.base.min_lead, revealWindow: f.base.reveal_window,
  conquestParams: Object.fromEntries(Object.entries(f.conquest).map(([k, v]) => [camel(k), v])) });

test('world 3 reads the legacy pacing, world 4 its decided bytes', () => {
  const w3 = seasonOf(s1('S1_DEVNET_TERRITORY')), w4 = seasonOf(s1('S1_DEVNET_TERRITORY_FAST'));
  assert.deepEqual(pacingOf(w3), LEGACY);
  assert.equal(minLeadOf(w3), 2);
  const f = pacingOf(w4);
  assert.deepEqual({ ...f }, { mode: 1, minLead: 1, departStamina: 74, starterHost: 500, firstHomeAtOnce: true });
  assert.equal(w4.revealWindow, 300);
  assert.equal(w4.conquestParams.keepBells, 36);
  assert.deepEqual(pacingOf(null), LEGACY);
  assert.deepEqual(pacingOf({ minLead: 1, conquestParams: { pacing: 0, departStamina: 37 } }), LEGACY, 'pacing 0 ignores the other bytes');
});

test('the page still charges the legacy 74 everywhere it hard-codes it: world 4 keeps 74 (Q-PKM-3 open)', () => {
  // (guard: a change of world 4's depart_stamina must also move fmarch.mjs DEPART_STAMINA and its importers —
  //  calendar, dialcard, hand, hud, keephand, marchcard, subject — which read the constant, not the Season)
  assert.equal(DEPART_STAMINA, DEPART_STAMINA_LEGACY);
  assert.equal(pacingOf(seasonOf(s1('S1_DEVNET_TERRITORY_FAST'))).departStamina, DEPART_STAMINA,
    'world 4 depart_stamina differs from the page constant: make the page read pacingOf(FS.season).departStamina');
});

test('the earliest arrival takes the lead: lead 2 is the kernel arithmetic, lead 1 moves only short marches', () => {
  const g = 1_800_000_000;
  // departs in bell 10 (6,030 s after genesis), 30 s of travel
  assert.equal(earliestArrivalBell(g, g + 6030, 30, 2), 12);
  assert.equal(earliestArrivalBell(g, g + 6030, 30, 1), 11);
  // a march longer than a bell is bound by its travel time either way
  assert.equal(earliestArrivalBell(g, g + 6030, 1800, 1), 14);
  assert.equal(earliestArrivalBell(g, g + 6030, 1800, 2), 14);
  // before genesis: bell 0
  assert.equal(earliestArrivalBell(g, g - 50, 10, 1), 1);
  // the page asks the kernel at lead 2, and answers lead 1 itself
  const kernel = { call: (name, a) => ({ ok: true, value: earliestArrivalBell(a.genesis_ts, a.depart_ts, a.secs, 2) }) };
  assert.equal(earliestBell(kernel, { genesisTs: g, departTs: g + 6030, secs: 30 }), 12);
  assert.equal(earliestBell(kernel, { lead: 1, genesisTs: g, departTs: g + 6030, secs: 30 }), 11);
  assert.equal(earliestBell(null, { lead: 1, genesisTs: g, departTs: g + 6030, secs: 30 }), null);
  // the window's minimum is the Season's own minLead
  assert.equal(arrivalWindow({ minLead: 1, maxLead: 72 }, 10, 11).min, 11);
  assert.equal(arrivalWindow({ minLead: 2, maxLead: 72 }, 10, 11).min, 12);
});

test('AI residents: a paced world places the rim village at once, a refusal falls back to the request lottery', () => {
  const homes = [{ p: 128, q: 0, nation: 0 }];
  const view = { joined: true, faction: 0, holding: null };
  const m = createResidentMemory(0, 0);
  const wide = { targets: [] };
  const at = decideNext(m, view, { homes, wide, atOnce: true });
  assert.equal(at.name, 'PlaceHome');
  assert.equal(at.atOnce, true);
  assert.deepEqual(at.fields, { p: 128, q: 0, site: 0 });
  noteOutcome(m, at, 'refused');
  const back = decideNext(m, view, { homes, wide, atOnce: true });
  assert.equal(back.name, 'FileTicket', 'the same site by request after the refusal');
  assert.deepEqual(back.fields.sites[0], { p: 128, q: 0, site: 0 });
  // TicketState (an open cohort in the province): wait, then place at once again — no request
  const m2 = createResidentMemory(0, 0);
  const a2 = decideNext(m2, view, { homes, wide, atOnce: true });
  noteOutcome(m2, a2, 'failed', { code: 'LocalActRejected', programCode: 45 });
  assert.equal(decideNext(m2, view, { homes, wide, atOnce: true }).wait, true);
  noteOutcome(m2, { wait: true }, 'wait');
  noteOutcome(m2, { wait: true }, 'wait');
  const again = decideNext(m2, view, { homes, wide, atOnce: true });
  assert.equal(again.name, 'PlaceHome');
  assert.equal(again.atOnce, true);
  assert.deepEqual(again.fields, { p: 128, q: 0, site: 0 });
  // (verify-pr279) TicketState again on the same site: the site itself is taken (a rim settler's village answers
  // TicketState too) — no endless retry: the next site of the province is placed at once
  noteOutcome(m2, again, 'failed', { code: 'LocalActRejected', programCode: 45 });
  const moved = decideNext(m2, view, { homes, wide, atOnce: true });
  assert.equal(moved.name, 'PlaceHome');
  assert.equal(moved.atOnce, true);
  assert.deepEqual(moved.fields, { p: 128, q: 0, site: 1 });
  // a world before the byte (world 3) files the rim request as before
  const legacy = decideNext(createResidentMemory(0, 0), view, { homes, wide });
  assert.equal(legacy.name, 'FileTicket');
});

test('source pins: the program and the page read the pacing bytes', () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  assert.match(read('permutation-frontier/src/proc/host.rs'), /let lo = b\.checked_add\(pace\.min_lead\)/);
  assert.match(read('permutation-frontier/src/proc/citizen.rs'), /if pace\.first_home_at_once\(\)/);
  assert.match(read('permutation-server/web/frontier/controller.mjs'), /pacingOf\(FS\.season\)\.firstHomeAtOnce/);
  assert.match(read('permutation-server/web/frontier/fexpedition-ready.mjs'), /min: bell \+ pace\.minLead/);
});
