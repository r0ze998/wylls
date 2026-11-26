// pt-world-goals-devnet: the world goals card on the DEVNET page (hud/worldgoals.mjs). Owner r0ze 2026-11-26 15:48 JST:
// Q-PT-6 (c) — the goals shown as "planned — not judged yet" first, then the off-chain judge's answer (no money);
// Q-PT-7 (b) — the flag keeps are the neutral keeps and Free Cities of the wide land, held 24 hours. Under the fog of war
// (map/fog.mjs DEVNET_FOG) only the viewer's nation's flags and the flags in sight are told by place; before the first
// village none. No "season" in the text. No chain, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../../permutation-server/web/frontier/map/fog.mjs';
import * as S from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as UI from '../../permutation-server/web/frontier/hud/worldgoals.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { answerOf, initialState, observationOf, stepFlags, WP } from '../src/frontier/wide-flags.mjs';

const VIEWER = 3, ENEMY = 0;
const HOME = { p: 2, q: 0, tile: 7 };
const KEEP = 30;
const sightOn = (p, q, tile, radius = 0) => { const h = tileHex(p, q, tile); return { q: h.q, r: h.r, radius, level: S.L3, kind: 'host' }; };
const sv = anchors => { const s = S.buildSurvey({ ringsOpen: 3, anchors }); s.rev = Math.random(); s.ownHosts = new Set(); s.faction = VIEWER; return s; };
const memStore = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; } }; };
const text = m => String(m).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

/** The devnet judge's answer (wide-flags.mjs answerOf) — flags given directly. */
const answer = (flags, achievements = [], bell = 200) => ({
  ok: true, v: 1, kind: 'world-goals', ruleset: 'wide-flags-v1', effects: { money: 'none', chain: 'none' }, season: { seasonId: '3', programId: 'P' }, bell,
  goals: [{ id: 'flag-keeps', kind: 'hegemony', live: true }],
  wideFlags: { holdBells: 144, firstOnly: true, flags, standings: Array.from({ length: 6 }, (_, n) => ({ nation: n, achieved: achievements.filter(a => a.nation === n).length, holding: flags.filter(f => f.holder === n && !f.achieved).length })) },
  achievements, judge: { observations: 3, inputsHash: '00'.repeat(32) },
});
const flag = (p, q, holder, since, over = {}) => ({ kind: 'keep', p: String(p), q: String(q), tile: KEEP, holder, since, longAt: holder === null ? null : since + 144, resolved: 199, achieved: null, ...over });

/** A devnet play page; `anchors` = sight beyond the home village; `holdings` false = before the first village. */
function page(anchors = [], { holdings = true } = {}) {
  const survey = sv([...S.anchorsOf({ villages: [{ ...HOME, tier: 0 }] }), ...anchors]);
  F.createFogger({ storage: memStore() })({ active: holdings, survey, overviews: new Map(), viewer: VIEWER, memKey: 'w' });
  return { mode: 'play', pin: { cluster: 'devnet', programId: 'P' }, season: { seasonId: '3' }, citizen: { faction: VIEWER }, wallet: { address: 'W' },
    holdings: holdings ? [{ p: 2, q: 0 }] : [] };
}
const run = f => { setLang('ja'); try { return f(); } finally { F.resetFogNow(); setLang('ja'); } };

test('devnet page, no judge: the goals are shown as planned — not judged yet — in Japanese and English, with no season and no prize', () => run(() => {
  const FS = page();
  assert.ok(UI.devnetGoalsPage(FS));
  for (const b of [null, { read: 'absent' }, { read: 'unread', code: 'HTTP409' }]) {
    const ja = text(UI.render(FS, b));
    assert.match(ja, /世界の目標/);
    assert.match(ja, /予定 — まだ判定していません/);
    // (fix-loop22, LP22-5: while Free Cities cannot be taken the goal names the neutral keeps only — Q-PTWG-5)
    assert.match(ja, /広い土地の中立の砦を奪い、144 ターン（24 時間）続けて持つこと/);
    assert.match(ja, /賞金はありません/);
    assert.doesNotMatch(ja, /シーズン|期限/);
  }
  setLang('en');
  const en = text(UI.render(FS, null));
  assert.match(en, /World goals/);
  assert.match(en, /Planned — not judged yet/);
  assert.match(en, /Capture a neutral keep in the wide land and hold it for 144 turns \(24 h(ours)?\)/);
  assert.match(en, /There is no prize/);
  assert.doesNotMatch(en, /[぀-ヿ一-鿿]/, 'no Japanese left');
  assert.doesNotMatch(en, /season/i);
  // planned: no place, no holder (nothing the fog hides), before or after the first village
  assert.doesNotMatch(text(UI.render(page([], { holdings: false }), null)), /\d+,\d+/);
}));

test('the planned card is the devnet page\'s only: local play and a non-devnet page are unchanged', () => run(() => {
  assert.equal(UI.render({ ...page(), localPlay: { port: 41700 } }, null), '');
  assert.equal(UI.render({ ...page(), pin: { cluster: 'localnet', programId: 'P' } }, null), '');
  assert.equal(UI.plannedOf({ ...page(), mode: 'spectate' }), null);
  assert.equal(UI.DEVNET_GOALS_BASE, '/gw/f');
}));

test('a judged answer: own nation\'s flags and flags in sight by place; the rest a count; before the first village no place', () => run(() => {
  const g = answer([flag(-2, 0, ENEMY, 150), flag(-1, 2, VIEWER, 100), flag(1, -2, 5, 120), flag(0, -2, null, null)]);
  assert.ok(UI.goodAnswer(g) && UI.goodWideAnswer(g));
  const FS = page([sightOn(-2, 0, KEEP)]);
  const s = text(UI.render(FS, { read: 'ok', goals: g }));
  assert.match(s, /判定中/);
  assert.match(s, /砦 -2,0/, 'in sight');
  assert.match(s, /満たすまで あと 94 ターン/);
  assert.match(s, /砦 -1,2/, 'own nation');
  assert.doesNotMatch(s, /1,-2|0,-2/, 'out of sight: not by place');
  assert.match(s, /ほかの旗の砦 2 個は、いまは見えていません/);
  assert.match(s, /あなたの国：取った旗の砦 0 · いま持っている旗の砦 1/);
  const pre = text(UI.render(page([sightOn(-2, 0, KEEP)], { holdings: false }), { read: 'ok', goals: g }));
  assert.doesNotMatch(pre, /-2,0/, 'before the first village nothing in sight is told');
  setLang('en');
  // (a new page view: the pre-join page above has no fog view of its own — the page makes one only with a village)
  const en = text(UI.render(page([sightOn(-2, 0, KEEP)]), { read: 'ok', goals: g }));
  assert.match(en, /Being judged \(off chain; no money moves\)/);
  assert.match(en, /The first nation to capture one and hold it for 144 turns/);
  assert.match(en, /2 other flag keeps are out of sight now/);
  assert.doesNotMatch(en, /[぀-ヿ一-鿿]/);
  assert.doesNotMatch(en, /season/i);
}));

test('achievements: by place for the viewer\'s nation (card and feed); another nation\'s out of sight without its place', () => run(() => {
  const g = answer([flag(-1, 2, VIEWER, 10, { achieved: { nation: VIEWER, bell: 154 } }), flag(1, -2, 5, 20, { achieved: { nation: 5, bell: 164 } })],
    [{ kind: 'keep', p: '-1', q: '2', nation: VIEWER, bell: 154 }, { kind: 'keep', p: '1', q: '-2', nation: 5, bell: 164 }]);
  const FS = page();
  const s = text(UI.render(FS, { read: 'ok', goals: g }));
  assert.match(s, /砦 -1,2 を 144 ターン（24 時間）持ち続けて取りました（ターン 154）/);
  assert.match(s, /旗の砦を一つ取りました（ターン 164）/);
  assert.doesNotMatch(s, /1,-2/);
  const news = UI.achievementNews(FS, { read: 'ok', goals: g }, { first: true });
  assert.deepEqual(news.map(n => n.id), ['goal:3:wide:keep:-1,2', 'goal:3:wide:keep:1,-2']);
  assert.ok(news.every(n => n.quiet));
  assert.deepEqual(UI.mapFlags(FS, { read: 'ok', goals: g }), [], 'no map marks from a wide answer');
}));

test('an answer of another world, or with money, is not shown: the planned card stays', () => run(() => {
  const g = answer([flag(-1, 2, VIEWER, 100)]);
  assert.match(text(UI.render(page(), { read: 'ok', goals: { ...g, season: { seasonId: '2', programId: 'P' } } })), /予定 — まだ判定していません/);
  assert.equal(UI.goodWideAnswer({ ...g, effects: { money: 'test-usdc', chain: 'none' } }), false);
  assert.equal(UI.goodWideAnswer({ ...g, wideFlags: { ...g.wideFlags, flags: [{ ...g.wideFlags.flags[0], p: 1.5 }] } }), false);
}));

test('the judge\'s own answer (wide-flags.mjs) is a good answer for the page', () => run(() => {
  const b = new Uint8Array(WP.SIZE), v = new DataView(b.buffer);
  b.set(Buffer.from(WP.MAGIC, 'latin1'), 0); v.setBigUint64(8, 3n, true); v.setUint16(16, 3, true); v.setUint32(72, 300, true);
  v.setUint16(WP.TRAILER, 1, true); b[WP.TRAILER + 2] = 1; b[WP.TRAILER + 3] = 15;
  b[WP.KEEP] = KEEP; b[WP.KEEP + 1] = VIEWER; v.setUint32(WP.KEEP + 12, 101, true); v.setUint32(WP.KEEP + 24, 1, true); b[WP.KEEP + 28] = 0xff;
  const obs = observationOf([{ p: '140', q: '-3', ring: '140', state: 'open', wide: { capture: { slot: '9', bytes_b64: Buffer.from(b).toString('base64') } } }], { seasonId: '3' });
  const a = answerOf(stepFlags(initialState(), obs).state, { seasonId: '3', programId: 'P' });
  assert.ok(UI.goodWideAnswer(a));
  assert.match(text(UI.render(page(), { read: 'ok', goals: a })), /砦 140,-3 を 144 ターン（24 時間）持ち続けて取りました（ターン 245）/);
}));

test('verify-pr260: Free Cities cannot be taken on the devnet build (Q-PTWG-5 (b)): both cards say so, JA and EN; firstOnly false changes the rule line', () => run(() => {
  assert.equal(UI.DEVNET_FREE_CITIES_TAKEABLE, false);
  const FS = page();
  const judged = { read: 'ok', goals: answer([flag(2, 0, VIEWER, 100)]) };
  // (fix-loop22, LP22-5: one card that does not contradict itself — the goal line names no Free City, and the Free Cities stand
  //  apart in their own muted line as not possible YET; both decided by the one constant)
  for (const b of [null, judged]) {
    const html = String(UI.render(FS, b)), t = text(html);
    assert.match(html, /<p class="muted small goal-free-city-note" data-free-cities="not-takeable">自由都市：この世界ではまだできません（奪えるようになったら、旗の砦に数えます）<\/p>/);
    const rule = /<p class="goal-rule">([^<]*)<\/p>/.exec(html)?.[1] ?? '';
    assert.ok(rule && !/自由都市/.test(rule), `the goal line names no Free City: ${rule}`);
    assert.doesNotMatch(t, /自由都市を奪い|中立の砦と自由都市が/);
  }
  assert.match(text(UI.render(FS, judged)), /続けて持った最初の国が/);
  const again = { read: 'ok', goals: { ...judged.goals, wideFlags: { ...judged.goals.wideFlags, firstOnly: false } } };
  assert.match(text(UI.render(FS, again)), /続けて持つたびに、その国が旗の砦を一つ取ります/);
  setLang('en');
  for (const b of [null, judged, again]) {
    const en = text(UI.render(FS, b));
    assert.match(en, /Free Cities: not yet possible in this world \(they count as flag keeps once they can be taken\)/);
    assert.doesNotMatch(en, /neutral keeps? (or|and) (a )?Free Cit/);
    assert.doesNotMatch(en, /[぀-ヿ一-鿿]/, 'no Japanese left');
    assert.doesNotMatch(en, /season/i);
  }
  assert.match(text(UI.render(FS, again)), /Each time a nation captures one and holds it for 144 turns/);
}));
