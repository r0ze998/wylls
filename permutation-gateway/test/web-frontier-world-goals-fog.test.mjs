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

const VIEWER = 3, ENEMY = 0, OTHER = 1, DRAWN = 5;
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
  ok: true, v: 1, kind: 'world-goals', ruleset: 'flag-keeps-v2', testOnly: true, season: { programId: 'P', seasonId: '11' }, effects: { money: 'none', chain: 'none' }, bell: 100, error: null,
  goals: [{ id: 'flag-keeps', kind: 'hegemony', live: true }],
  flagKeeps: { round: 1, postedBell: 0, seed: '07'.repeat(32), hash: 'ab'.repeat(32), need: 1, holdBells: 144,
    // (flag-keeps-v2: the flag keep was drawn for DRAWN and CAPTURED by its holder — a captured flag keep has the hold timer)
    flags: [{ p: -2, q: 0, nation: DRAWN, holder, since: 60, captured: true, from: 60, longAt: 204, contender: OTHER, progress: 12, required: 72 }],
    progress: [{ nation: holder, held: 1, own: 0, captured: 1, capturedLong: 0, need: 1, reachAt: 204 }] },
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
  assert.match(s, /州 -2,-?0/); // (owner-answers-ui, Q-EUA2-7: one coordinate format)
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

test('fix-loop13 LP13-11: an own-nation flag keep missing from the page\'s keep map (a far --wide rim keep) is told live; another nation\'s is not', () => run(() => {
  // the page's keep map has no entry for the flag keep at all (in --wide it holds ~45 keeps, not the far rim ones)
  const bare = FS => { F.viewKeeps(new Map()); return { ...FS, conquest: { keeps: new Map() } }; };
  const mine = bare(world(NONE(), { holder: VIEWER }));
  assert.equal(UI.seenFlag(mine, answer(VIEWER).flagKeeps.flags[0]).seen, 'live');
  const s = card(mine, VIEWER);
  assert.match(s, /（あなたの国）/);
  assert.match(s, /満たすまで あと 104 ターン/);
  assert.doesNotMatch(s, /まだ見ていません/);
  setLang('en');
  assert.doesNotMatch(card(mine, VIEWER), /not seen/i);
  setLang('ja');
  // the same keep held by another nation stays unseen: no holder, no timer, no siege
  const theirs = bare(world(NONE(), { holder: ENEMY }));
  const t = card(theirs, ENEMY);
  assert.match(t, /この州の砦は、まだ見ていません/);
  assert.doesNotMatch(t, /持ち主 |包囲中|満たすまで/);
  // and a viewer with no nation read yet gets no shortcut
  const none = { ...theirs, citizen: null };
  assert.equal(UI.seenFlag(none, answer(VIEWER).flagKeeps.flags[0]).seen, 'never');
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

test('fix-loop13 LP13-8: on a faster TEST clock the card says the real time, at the natural clock the chain hours', async () => {
  const T = await import('../../permutation-server/web/frontier/seasonterms.mjs');
  try {
    setLang('ja');
    T.setTermsPace(() => 1);
    assert.equal(UI.turnsText(42), '42 ターン（7 時間）');
    T.setTermsPace(() => 60);
    assert.equal(UI.turnsText(42), '42 ターン（この世界の実時間で約 7 分）');
    assert.equal(UI.turnsText(144), '144 ターン（この世界の実時間で約 24 分）', 'guide §14: 24 minutes at the ×60 TEST clock');
    setLang('en');
    assert.equal(UI.turnsText(42), '42 turns (about 7 minutes of real time in this world)');
    T.setTermsPace(() => null);
    assert.equal(UI.turnsText(42), '42 turns (7 h)', 'a fast clock whose pace is not known yet: the chain hours, never a guessed real time');
  } finally { T.setTermsPace(() => 1); setLang('ja'); }
});

test('fix-loop13 LP13-9: an achievement is a feed line in both languages — quiet on the first read, a notice later, never twice', () => run(() => {
  const FS = { season: { seasonId: '11' }, pin: { programId: 'P' }, citizen: { faction: VIEWER }, wallet: { address: 'W' }, conquest: { keeps: new Map() } };
  const ach = { round: 1, bell: 162, nations: [VIEWER], prize: { simulated: true, vaultBefore: '940000000', payout: '282000000', paid: '282000000', returned: '658000000', rows: [{ wallet: 'W', nation: VIEWER, points: 10, eligible: true, amount: '282000000' }] } };
  const read = achievements => ({ read: 'ok', goals: { ...answer(), achievements } });
  assert.equal(UI.achievementNews(FS, { read: 'absent' }), null);
  assert.equal(UI.achievementNews({ ...FS, season: { seasonId: '12' } }, read([ach])), null, 'another world: nothing learned');
  assert.deepEqual(UI.achievementNews(FS, read([])), []);
  const [first] = UI.achievementNews(FS, read([ach]), { first: true });
  assert.equal(first.quiet, true, 'on record before the page read it: in the list, no toast');
  const [later] = UI.achievementNews(FS, read([ach]));
  assert.equal(later.id, 'goal:11:1');
  assert.equal(later.kind, 'goal');
  assert.equal(later.bell, 162);
  assert.equal(later.quiet, undefined);
  assert.equal(later.words.ja, '世界の目標：第 1 回の旗の砦を、あなたの国（' + later.words.ja.match(/（(.+?)）/)[1] + '）が達成しました（ターン 162）。賞金が有効なら、あなたは 282 テスト USDC を受け取っていました');
  assert.match(later.words.en, /^World goals: your nation \(.+\) achieved round 1 of the flag keeps \(turn 162\)\. If prizes were on, you would have received 282 test USDC$/);
  const other = UI.achievementNews(FS, read([{ ...ach, nations: [ENEMY], prize: { ...ach.prize, rows: [] } }]))[0];
  assert.match(other.words.en, /^World goals: .+ achieved round 1 of the flag keeps \(turn 162\)$/);
  assert.doesNotMatch(other.words.en, /your nation|USDC/);
  assert.doesNotMatch(other.words.en, /[぀-ヿ一-鿿]/);
  // (verify-pr208) two nations achieving at one turn: "your nation (…)" names the viewer's nation alone
  const joint = UI.achievementNews(FS, read([{ ...ach, nations: [ENEMY, VIEWER] }]))[0];
  const own = /your nation \((.+?)\)/.exec(joint.words.en)[1], solo = /your nation \((.+?)\)/.exec(later.words.en)[1];
  assert.equal(own, solo, 'the viewer\'s nation, not the list of all achieving nations');
  assert.doesNotMatch(own, /,|、/);
}));

test('fix-loop13: the turn summary names an achievement line (it said "Turn 179 in brief:" and nothing)', async () => {
  const FEED = await import('../../permutation-server/web/frontier/hud/feed.mjs');
  const s = FEED.bellSummary([{ id: 'goal:11:1', kind: 'goal', bell: 179, text: 'x' }], 179);
  assert.equal(s.words.ja, 'ターン 179 のまとめ：世界の目標 1');
  assert.equal(s.words.en, 'Turn 179 in brief: 1 world goal');
});
