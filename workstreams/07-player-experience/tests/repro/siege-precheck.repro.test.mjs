// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
// Workstream 07, claim 2 of the brief: sieges the program refuses, told before the send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siegeOffer } from '../../../../permutation-server/web/frontier/screens/s1.mjs';
import { hostId } from '../../../../permutation-server/web/frontier/faddr.mjs';
import { siegeExtraBlocks, SIEGE_UNJUDGED, CR } from '../../src/siege-precheck.mjs';

const CONQUEST_RS = readFileSync(new URL('../../../../permutation-frontier/src/proc/conquest.rs', import.meta.url), 'utf8');
const LAYOUT_RS = readFileSync(new URL('../../../../frontier-abi/src/v2/layout/province.rs', import.meta.url), 'utf8');
const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile, extra = {}) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => store(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [], shieldUntil: 0, ...extra });
const mine = { state: 1, tile: 5, id: hostId({ p: 0, q: 0, site: 0, gen: 1, seq: 3 }), fromBell: 5, unit: 0, faction: 1, troops: 300_000 };
const prov = (extra = {}) => ({ p: 0, q: 0, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], siteMirror: [{ state: 1, faction: 2 }, { state: 5, faction: 6 }], camp: { state: 1, tile: 7 }, resolvedNext: 10, entries: [mine], conquest: Array.from({ length: 12 }, () => ({ kind: 0, flags: 0 })), ...extra });
const world = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 100_000 }, citizen: { faction: 1 }, holdings: [holding(0, 0, 0, 30)], provinces: new Map([['0,0', { province: prov() }]]), ...extra });
const sel = { p: 0, q: 0, idx: 5 };

test('REPRO: a new player whose own village is still shielded is offered the siege button (the program refuses Shielded)', () => {
  const fs = world({ holdings: [holding(0, 0, 0, 30, { shieldUntil: 100_000 + 48 * 3600 })] });
  const o = siegeOffer(fs, sel);
  assert.deepEqual(o.blocks, [], 'nothing on the page holds the button back');
  assert.deepEqual(siegeExtraBlocks(fs, sel, o), [{ code: 'SourceShielded', until: 100_000 + 48 * 3600 }]);
});

test('REPRO: a village already under siege, or owing a stake, is offered a second siege', () => {
  const busy = world({ provinces: new Map([['0,0', { province: prov({ conquest: [{ kind: CR.KIND_SIEGE, flags: 1 }, ...Array(11).fill({ kind: 0, flags: 0 })] }) }]]) });
  assert.deepEqual(siegeOffer(busy, sel).blocks, []);
  assert.deepEqual(siegeExtraBlocks(busy, sel, siegeOffer(busy, sel)), [{ code: 'SiegeBusy', kind: 1 }]);
  const owed = world({ provinces: new Map([['0,0', { province: prov({ conquest: [{ kind: 0, flags: 1 << 2 }, ...Array(11).fill({ kind: 0, flags: 0 })] }) }]]) });
  assert.deepEqual(siegeExtraBlocks(owed, sel, siegeOffer(owed, sel)), [{ code: 'StakeUnsettled' }]);
});
