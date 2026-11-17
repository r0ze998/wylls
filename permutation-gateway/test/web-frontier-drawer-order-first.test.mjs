// Round 18 (2026-11-14): an order being written on the map comes before the first village's welcome card. In a ×30
// two-person test world the welcome (FS.homeGrant, not yet put away) stood over the order card a fort's row had just
// opened, so the seal could not be reached until the player closed a card they had not asked for. The welcome is not
// put away: it stands again once the order is sent or set aside. Everything else of the drawer's order is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerOf } from '../../permutation-server/web/frontier/hud/drawer.mjs';

const base = (extra = {}) => ({ mode: 'play', tab: 'map', homeGrant: { p: 0, q: 2 }, holdings: [{ p: 0, q: 2 }], citizen: { faction: 1 }, land: { stage: 'final' }, playReady: true, ...extra });
const compose = { host: { id: '1' }, origin: { p: 0, q: 2 }, dest: { p: -2, q: 4, tile: 26 } };

test('an order on the map comes before the welcome; the welcome comes back once the order is gone', () => {
  assert.deepEqual(drawerOf(base()), { kind: 'home' }, 'the welcome, as before, when no order is being written');
  assert.deepEqual(drawerOf(base({ compose })), { kind: 'march' }, 'the order card, not hidden behind the welcome');
  const s = base({ compose }); s.compose = null;
  assert.deepEqual(drawerOf(s), { kind: 'home' }, 'sent or set aside: the welcome stands again (it was not put away)');
});

test('everything else keeps its place: another tab, the title scene, a report, practice', () => {
  assert.deepEqual(drawerOf(base({ compose, tab: 'holding' })), { kind: 'home' }, 'on another tab the welcome still comes first, as before');
  assert.notDeepEqual(drawerOf(base({ titleUp: true })), { kind: 'home' }, 'the title scene: no welcome, as before');
  assert.deepEqual(drawerOf(base({ compose, report: { id: 1 } })), { kind: 'report' }, 'a report before both, as before');
  assert.deepEqual(drawerOf(base({ compose, practice: { id: 1 } })), { kind: 'practice' }, 'practice before both, as before');
  assert.deepEqual(drawerOf(base({ homeGrant: null, compose })), { kind: 'march' }, 'no welcome: the order card, as before');
});
