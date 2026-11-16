// The siege offer (screens/s1.mjs siegeOffer) holds back two more refusals the page can tell (2026-11-16), as
// conquest.rs declare_siege_as decides them: the declaring village must be final (the lazy flip applies only when its own
// Province is the target's) — NotFinal —, and the target Province must be resolved (prologue::resident_ok) —
// NotResident. Both were offered and refused on send. The rest the program decides stays the program's (lead host,
// protection, immunity, the target's generation). No rule changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { errorText } from '../../permutation-server/web/frontier/fi18n.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('the program: the source final (flip only in the target Province), then the target Province resolved (text)', () => {
  const s = read('permutation-frontier/src/proc/conquest.rs'), at = s.indexOf('fn declare_siege_as('), f = s.slice(at, s.indexOf('\n}\n', at));
  assert.match(f, /let state = if \(hh\.p, hh\.q\) == \(tp, tq\) \{\n\s+hold::finality\(&pl, &hh, src, citizen, province\)\?\n\s+\} else \{\n\s+hh\.state\n\s+\};\n\s+if state != H::STATE_FINAL \{\n\s+return Err\(FrontierError::NotFinal\.into\(\)\);/);
  assert.match(f, /if !ap::resident_ok\(rn, b\) \{\n\s+return Err\(FrontierError::NotResident\.into\(\)\);/);
  assert.ok(f.indexOf('NotFinal') < f.indexOf('NotResident'), 'NotFinal first');
});

// another nation's village on site 0 (tile 5) of (0,0); the viewer's fighting host stands there, from the village `src`
const ALL = (1n << 61n) - 1n;
const store = () => ({ value: 10_000n * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, extra = {}) => ({ p, q, site: 0, tile: 30, gen: 1, state: 2, finalTs: '0', ticketBell: 1, stores: Array.from({ length: 8 }, store), ...extra });
const idFor = h => hostId({ p: h.p, q: h.q, site: h.site, gen: h.gen, seq: 3 });
const prov = (extra = {}) => ({ p: 0, q: 0, layoutVersion: 2, passableMask: ALL, siteCount: 1, sites: [5], siteMirror: [{ state: 1, faction: 2 }], resolvedNext: 99, ticketCohorts: [], ...extra });
const world = (src, pv, nowBell = 100) => ({ mode: 'play', nowBell, chain: { now: () => 1000 }, citizen: { faction: 1 }, holdings: [src], activeHolding: 0,
  provinces: new Map([['0,0', { province: { ...pv, entries: [{ state: 1, tile: 5, id: idFor(src), fromBell: 5, unit: 0 }] } }]]) });
const sel = { p: 0, q: 0, idx: 5 };

test('a resolved target and a final source: no new block', () => {
  const h = holding(0, 0);
  assert.ok(idFor(h) !== null, 'a host id of the source village');
  assert.deepEqual(SCR.siegeOffer(world(h, prov()), sel).blocks, []);
});

test('the target Province behind the turn: NotResident (resolved_next + 1 >= bell is fine)', () => {
  const h = holding(0, 0);
  assert.deepEqual(SCR.siegeOffer(world(h, prov({ resolvedNext: 97 })), sel).blocks, ['NotResident']);
  assert.deepEqual(SCR.siegeOffer(world(h, prov({ resolvedNext: 99 })), sel).blocks, []);
});

test('the source not final: NotFinal — a due flip counts only when the source stands in the target Province', () => {
  // a provisional source in the target Province whose flip is due (time passed, its cohort closed): final, as flipped
  assert.deepEqual(SCR.siegeOffer(world(holding(0, 0, { state: 1, finalTs: '10' }), prov()), sel).blocks, []);
  // the same, flip not due yet: NotFinal
  assert.deepEqual(SCR.siegeOffer(world(holding(0, 0, { state: 1, finalTs: '5000' }), prov()), sel).blocks, ['NotFinal']);
  // a provisional source in ANOTHER Province: no flip here, NotFinal even when due
  const far = holding(3, 0, { state: 1, finalTs: '10' });
  const offer = SCR.siegeOffer(world(far, prov()), sel);
  assert.ok(offer, 'the host from another Province still stands on the site');
  assert.deepEqual(offer.blocks, ['NotFinal']);
  // beside another block, in the program's order
  assert.deepEqual(SCR.siegeOffer(world(holding(0, 0, { state: 1, finalTs: '5000' }), prov({ resolvedNext: 97 })), sel).blocks, ['NotFinal', 'NotResident']);
  assert.ok(errorText('NotFinal').length > 0 && errorText('NotResident').length > 0);
});
