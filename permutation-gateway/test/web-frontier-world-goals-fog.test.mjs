// verify-pr198: the world goals card (hud/worldgoals.mjs) under the fog of war of a LOCAL TEST world (map/fog.mjs).
// The judge's answer carries every flag keep's LIVE holder, since bell and siege. Owner rule (t387u): only current
// vision; last-known for ownership; no leaks. So the card tells a flag keep as the keep board and the conquest screen
// do (viewKeeps over FS.conquest.keeps): in sight → live (holder, hold timer, siege); seen before → its last-known
// holder only; never seen → its place alone (the posting itself is public). Without the fog: everything, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as UI from '../../permutation-server/web/frontier/hud/worldgoals.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VIEWER = 3, ENEMY = 0, OTHER = 1;
const HOME = { p: 2, q: 0, tile: 7 };
const SITES = Array.from({ length: 12 }, (_, j) => 7 + 2 * j);
const terrainOf = () => ({ sites: SITES, terrain: Array(61).fill(0), names: ['Grassland'] });
const rec = (p, q, over = {}) => ({ p, q, owners: Array(12).fill(7), sites: Array(12).fill(0), hosts: Array(7).fill(0), clash: false, dormant: false, opened: true, resolvedNext: 0,
  occupiers: Array(12).fill(7), siegeStates: Array(12).fill(0), siteKinds: Array(12).fill(3), keepTile: null, keepTroops: 0, immune: Array(12).fill(false), ...over });
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; }, m }; };
const homeSight = () => S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] });
const sightOn = (p, q, tile, radius = 0) => { const h = tileHex(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };
const sv = anchors => { const s = S.buildSurvey({ ringsOpen: 3, anchors }); s.rev = Math.random(); s.ownHosts = new Set(); s.faction = VIEWER; return s; };
const KEEP = 30;
const KEEPSIGHT = () => [sightOn(-2, 0, KEEP)], NONE = () => [];
const KNOWN = () => [{ ...sightOn(-2, 0, KEEP, 2), level: S.L2, kind: 'explored' }];

/** The enemy flag keep (-2, 0) on tile 30, held by ENEMY since 60, besieged by OTHER (12 / 72). */
const liveKeep = (holder = ENEMY) => ({ p: -2, q: 0, tile: KEEP, holder, troops: 288, heartland: false, contender: OTHER, progress: 12, requiredBells: 72, asOfBell: 100 });
const answer = (holder = ENEMY) => ({
  ok: true, v: 1, kind: 'world-goals', ruleset: 'flag-keeps-v1', testOnly: true, season: { programId: 'P', seasonId: '11' }, effects: { money: 'none', chain: 'none' }, bell: 100, error: null,
  goals: [{ id: 'flag-keeps', kind: 'hegemony', live: true }],
  flagKeeps: { round: 1, postedBell: 0, seed: '07'.repeat(32), hash: 'ab'.repeat(32), need: 1, holdBells: 144,
    flags: [{ p: -2, q: 0, nation: ENEMY, holder, since: 60, from: 60, longAt: 204, contender: OTHER, progress: 12, required: 72 }],
    progress: [{ nation: ENEMY, held: 1, heldLong: 0, need: 1, reachAt: 204 }] },
  achievements: [],
});

function world(anchors, { storage = memStore(), holder = ENEMY } = {}) {
  const survey = sv([...homeSight(), ...anchors]);
  const overviews = new Map([[2, { ring: 2, bell: 100, provinces: [rec(2, 0, { control: VIEWER }), rec(-2, 0, { keepTile: KEEP, keepTroops: 288, control: holder })] }]]);
  const fog = F.createFogger({ storage })({ active: true, survey, overviews, viewer: VIEWER, terrainOf, memKey: 'w' });
  // the page's keep map holds the live keep (as the controller fills it); only the fog decides what is told
  F.viewKeeps(new Map([['-2,0', liveKeep(holder)]]));
  return { season: { seasonId: '11' }, pin: { programId: 'P' }, citizen: { faction: VIEWER }, wallet: { address: 'W' }, survey, fog,
    overviews, conquest: { keeps: new Map([['-2,0', liveKeep(holder)]]) } };
}
const text = m => String(m).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const card = (FS, holder = ENEMY) => text(UI.render(FS, { read: 'ok', goals: answer(holder) }));
const run = f => { setLang('ja'); try { return f(); } finally { F.resetFogNow(); setLang('ja'); } };

test('world goals card: a flag keep in sight is told live (holder, hold timer, siege)', () => run(() => {
  const s = card(world(KEEPSIGHT()));
  assert.match(s, /持ち主 [^ ]+/);
  assert.match(s, /満たすまで あと 104 ターン/);
  assert.match(s, /包囲中 12 \/ 72/);
  assert.equal(UI.seenFlag(world(KEEPSIGHT()), answer().flagKeeps.flags[0]).seen, 'live');
}));

test('world goals card: a flag keep never seen tells its place only — no holder, no timer, no siege', () => run(() => {
  const FS = world(NONE());
  const s = card(FS);
  assert.match(s, /州 \(-2, -?0\)|州 \(-2, 0\)/);
  assert.match(s, /この州の砦は、まだ見ていません/);
  assert.doesNotMatch(s, /持ち主 /, 'no holder');
  assert.doesNotMatch(s, /包囲中/, 'no siege');
  assert.doesNotMatch(s, /満たすまで/, 'no hold timer (it tells since_bell)');
  setLang('en');
  const en = card(FS);
  assert.match(en, /not seen this province(&#39;|')s keep/i);
  assert.doesNotMatch(en, /[぀-ヿ一-鿿]/, 'no Japanese left in English');
}));

test('world goals card: a flag keep seen before tells its last-known holder — not the live one, no timer or siege', () => run(() => {
  const storage = memStore();
  world(KEEPSIGHT(), { storage, holder: ENEMY });          // seen in ENEMY's hands
  const FS = world(KNOWN(), { storage, holder: OTHER });    // OTHER took it out of sight
  const f = UI.seenFlag(FS, answer(OTHER).flagKeeps.flags[0]);
  assert.equal(f.seen, 'memory');
  assert.equal(f.holder, ENEMY, 'the last-known holder, not the live one');
  const s = card(FS, OTHER);
  assert.match(s, /前に見たときの持ち主です/);
  assert.doesNotMatch(s, /包囲中/);
  assert.doesNotMatch(s, /満たすまで/);
  setLang('en');
  assert.match(card(FS, OTHER), /holder as last seen/);
}));

test('world goals card: the viewer\'s own nation\'s flag keep is always told live', () => run(() => {
  const FS = world(NONE(), { holder: VIEWER });
  const s = card(FS, VIEWER);
  assert.match(s, /（あなたの国）/);
  assert.match(s, /満たすまで あと 104 ターン/);
}));

test('world goals card: without the fog every flag keep is told live (as before)', () => run(() => {
  F.resetFogNow();
  const FS = { season: { seasonId: '11' }, pin: { programId: 'P' }, citizen: { faction: VIEWER }, wallet: { address: 'W' }, conquest: { keeps: new Map() } };
  const s = card(FS);
  assert.match(s, /包囲中 12 \/ 72/);
  assert.match(s, /満たすまで あと 104 ターン/);
}));

test('world goals card: before the viewer\'s first village (a fogged local page, no fog view yet) no flag keep is told but by its place', () => run(() => {
  F.resetFogNow();
  const FS = { mode: 'play', localPlay: { address: 'W' }, holdings: [], season: { seasonId: '11' }, pin: { programId: 'P' }, wallet: { address: 'W' }, conquest: { keeps: new Map([['-2,0', liveKeep()]]) } };
  assert.equal(F.fogActive(FS), true);
  const s = card(FS);
  assert.match(s, /この州の砦は、まだ見ていません/);
  assert.doesNotMatch(s, /持ち主 /);
  assert.doesNotMatch(s, /包囲中/);
  assert.doesNotMatch(s, /満たすまで/);
  // a page without the fog (not a local test world, e.g. the sample): told live, as before
  assert.match(card({ ...FS, localPlay: undefined }), /包囲中 12 \/ 72/);
}));
