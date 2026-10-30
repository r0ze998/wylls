// Workstream 07, claim 2 of the brief: sieges the program refuses, told before the send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siegeOffer } from '../../../permutation-server/web/frontier/screens/s1.mjs';
import { hostId } from '../../../permutation-server/web/frontier/faddr.mjs';
import { siegeExtraBlocks, SIEGE_UNJUDGED, CR } from '../src/siege-precheck.mjs';

const CONQUEST_RS = readFileSync(new URL('../../../permutation-frontier/src/proc/conquest.rs', import.meta.url), 'utf8');
const LAYOUT_RS = readFileSync(new URL('../../../frontier-abi/src/v2/layout/province.rs', import.meta.url), 'utf8');
const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile, extra = {}) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => store(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [], shieldUntil: 0, ...extra });
const mine = { state: 1, tile: 5, id: hostId({ p: 0, q: 0, site: 0, gen: 1, seq: 3 }), fromBell: 5, unit: 0, faction: 1, troops: 300_000 };
const prov = (extra = {}) => ({ p: 0, q: 0, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], siteMirror: [{ state: 1, faction: 2 }, { state: 5, faction: 6 }], camp: { state: 1, tile: 7 }, resolvedNext: 10, entries: [mine], conquest: Array.from({ length: 12 }, () => ({ kind: 0, flags: 0 })), ...extra });
const world = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 100_000 }, citizen: { faction: 1 }, holdings: [holding(0, 0, 0, 30)], provinces: new Map([['0,0', { province: prov() }]]), ...extra });
const sel = { p: 0, q: 0, idx: 5 };

test('the program\'s refusals named here are declare_siege\'s, in its order', () => {
  for (const code of ['SiegeBusy', 'StakeUnsettled', 'Immune', 'NotLead', 'HoldingsFull', 'TooLate']) assert.match(CONQUEST_RS, new RegExp(`CqError::${code}`), code);
  assert.match(CONQUEST_RS, /the declarer's source\s*\n\s*\/\/ Holding must not be shielded unless dormant/);
  assert.match(CONQUEST_RS, /if src_shielded \{\s*return Err\(FrontierError::Shielded\.into\(\)\);/);
  assert.match(LAYOUT_RS, /pub const OWED_MASK: u8 = FLAG_STAKE_TO_HOLDING \| FLAG_STAKE_TO_SRC \| FLAG_SLOT_OWED;/);
  assert.equal(CR.OWED_MASK, 0b100110);
  assert.ok(SIEGE_UNJUDGED.includes('FrontierProtected'));
});

test('an unshielded village and a free record add nothing; a shield that ended adds nothing', () => {
  const fs = world();
  assert.deepEqual(siegeExtraBlocks(fs, sel, siegeOffer(fs, sel)), []);
  const ended = world({ holdings: [holding(0, 0, 0, 30, { shieldUntil: 99_999 })] });
  assert.deepEqual(siegeExtraBlocks(ended, sel, siegeOffer(ended, sel)), []);
  assert.deepEqual(siegeExtraBlocks(fs, sel, null), []);
});
