// The first village's place drawn on the wide map: PROVISIONAL, NOT PRODUCTION, NOT ENABLED (2026-11-18).
// WRITTEN, NOT RUN. KEY-FREE: fake overviews and Province envelopes in memory; no herald, page, world, signer or send.
// The core, the growth view, the view state and the screen text are imported (they load fgeo/fland/sdk only, no
// language tables); the page module is read as TEXT (it loads config/herald/map world, which load lang.mjs).
//   D1 reproducible for the same world key, citizen key, candidate snapshot and parameters, whatever the read order
//   D2 no nation is excluded; nations are mixed among draws
//   D3 unknown is never free: an unread ring, an unread Province, an unreadable site → unread, never another place
//   D4 another world: an overview, a Province or a Season of another one → otherWorld
//   D5 full: nothing free, or only Provinces at the density limit
//   D6 taken since the overviews → the next place by score; all taken → contested; only absent slots → unread
//   D7 ticket cohorts: a live one holds the Province; an old one does not; an open one without the herald turn → unknown
//   D8 the chain's view never says accepted: beyond the heartland or another nation → refused-by-rule
//   D9 recheck: free / taken since / another draw
//   D10 map growth read only: ExtendFrontier's conditions as read, never "will grow"
//   D11 the view: a late answer, another wallet or another world is never shown; nothing is stored
//   D12 the screen: escaped, no banned words, test-only banner, limits stated
//   D13 the page (text): gated on loopback + ?provisional=home-draw; GET reads only; no join/confirmHome/signer/send
//   D14 the core (text): no clock, randomness, storage or fetch
//   D15 (correction) the page's requests: each Draw owns a number; wallet typing or a newer Draw ends it; after every
//       await only the current request touches the world, the view, the failure note or the paint; its own herald
//       client (no shared pin); a throw is its own failure; the view's cancel drops an answer under way
//   D16 (correction) reproducibility only within its range: a changed snapshot can move the place; the text says so
//       and claims no reservation or protection against asking again
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drawHome, candidatesFrom, drawRings, siteNow, chainView, recheck, placeScore, DRAW, PROVISIONAL, PROVISIONAL_PARAMS, worldKeyOf, sameWorld } from '../../permutation-server/web/frontier/fhome-draw.mjs';
import { growthView, ringOccupancyMet, GROWTH } from '../../permutation-server/web/frontier/fhome-draw-frontier.mjs';
import { createDrawView, VIEW } from '../../permutation-server/web/frontier/fhome-draw-view.mjs';
import { homeDrawHtml, LIMITS_TEXT } from '../../permutation-server/web/frontier/screens/home-draw.mjs';
import { ringProvinces, homeNation } from '../../permutation-server/web/frontier/fgeo.mjs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const code = src => src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');

const SEASON_ID = 7n;
const WORLD = { cluster: 'localnet', programId: 'Prog1111', seasonId: '7', gen: 1 };
const season = (over = {}) => ({ seasonId: SEASON_ID, genesisSeed: new Uint8Array(32).fill(9), conquestParams: { heartlandMaxRing: 3 }, ...over });
const EXTENT = { ringsOpen: 5, ringsOpened: 5, rMax: 4, ringProvinces: null };
const CONTIGUOUS = 5; // rings 0..4 → drawn 2, 3, 4

function overview(d, { taken = () => false, seasonV = SEASON_ID } = {}) {
  const provinces = ringProvinces(d).map(({ p, q }) => {
    const sites = Array(12).fill(0), owners = Array(12).fill(7);
    for (let i = 0; i < 12; i++) if (taken(p, q, i)) { sites[i] = 1; owners[i] = 2; }
    return { p, q, owners, sites, opened: true };
  }).sort((a, b) => a.p - b.p || a.q - b.q);
  return { ok: true, season: seasonV, ring: d, bell: 40, provinces };
}
const overviews = (opts = {}, rings = [2, 3, 4]) => new Map(rings.map(d => [d, overview(d, opts)]));
function province(p, q, { state = () => 0, cohorts = [], siteCount = 12, seasonV = SEASON_ID } = {}) {
  return { ok: true, bell: 41, province: { p, q, seasonId: seasonV, siteCount, sites: Array.from({ length: 12 }, (_, i) => i + 3),
    siteMirror: Array.from({ length: 12 }, (_, i) => ({ state: state(p, q, i), gen: 0 })), ticketCohorts: cohorts } };
}
const freeReader = (opts = {}) => { const calls = []; const f = async (p, q) => { calls.push(`${p},${q}`); return province(p, q, opts); }; f.calls = calls; return f; };
const base = (over = {}) => ({ world: WORLD, season: season(), extent: EXTENT, contiguous: CONTIGUOUS, citizen: 'Wallet1111', overviews: overviews(), readProvince: freeReader(), nowBell: 50, ...over });

test('D1 reproducible, and the order candidates come in does not matter', async () => {
  const a = await drawHome(base());
  assert.equal(a.kind, DRAW.assigned);
  const b = await drawHome(base());
  assert.deepEqual(b.place, a.place);
  // rings in another order, Provinces of each ring reversed
  const rev = new Map([...overviews()].reverse().map(([d, ov]) => [d, { ...ov, provinces: [...ov.provinces].reverse() }]));
  const c = await drawHome(base({ overviews: rev }));
  assert.deepEqual(c.place, a.place);
  assert.equal(c.score, a.score);
  // another citizen: its own place by its own score
  const scores = new Set();
  for (let i = 0; i < 8; i++) scores.add(JSON.stringify((await drawHome(base({ citizen: `W${i}` }))).place));
  assert.ok(scores.size > 1);
  assert.equal(a.provisional.production, false);
  assert.equal(a.provisional.enabled, false);
});

test('D2 every nation\'s free place is a candidate; draws mix nations', async () => {
  const c = candidatesFrom({ drawKey: season().genesisSeed, citizen: 'Wallet1111', seasonId: '7', rings: [2, 3, 4], overviews: overviews(), params: PROVISIONAL_PARAMS });
  assert.equal(c.ok, true);
  assert.equal(c.candidates.length, (12 + 18 + 24) * 12);
  const nations = new Set();
  for (let i = 0; i < 40; i++) { const r = await drawHome(base({ citizen: `Mix${i}` })); nations.add(homeNation(r.place.p, r.place.q)); }
  assert.ok(nations.size > 1, 'nations are mixed');
  // the score depends on the citizen and the place only
  assert.deepEqual(placeScore(season().genesisSeed, 'A', 2, 0, 1), placeScore(season().genesisSeed, 'A', 2, 0, 1));
  assert.notDeepEqual(placeScore(season().genesisSeed, 'A', 2, 0, 1), placeScore(season().genesisSeed, 'B', 2, 0, 1));
});

test('D3 unknown is never free', async () => {
  const missing = overviews(); missing.delete(3);
  const a = await drawHome(base({ overviews: missing }));
  assert.equal(a.kind, DRAW.unread);
  assert.deepEqual(a.unreadRings, [3]);
  const failed = overviews(); failed.set(4, { ok: false, code: 'Unavailable' });
  assert.equal((await drawHome(base({ overviews: failed }))).kind, DRAW.unread);
  // the drawn Province does not answer: unread, and no other place is tried
  const r = freeReader(); const dead = async (p, q) => { r.calls.push(`${p},${q}`); return { ok: false, code: 'Unavailable' }; };
  dead.calls = r.calls;
  const b = await drawHome(base({ readProvince: dead }));
  assert.equal(b.kind, DRAW.unread);
  assert.equal(r.calls.length, 1);
  // a site whose state cannot be read
  const odd = async (p, q) => { const e = province(p, q); e.province.siteMirror = e.province.siteMirror.map(() => ({})); return e; };
  assert.equal((await drawHome(base({ readProvince: odd }))).kind, DRAW.unread);
  // a Province read that is another place
  const wrong = async () => province(9, 9);
  assert.equal((await drawHome(base({ readProvince: wrong }))).kind, DRAW.unread);
});

test('D4 another world is not drawn from', async () => {
  const other = overviews(); other.set(2, overview(2, { seasonV: 8n }));
  assert.equal((await drawHome(base({ overviews: other }))).kind, DRAW.otherWorld);
  const unnamed = overviews(); unnamed.set(2, { ...overview(2), season: undefined });
  assert.equal((await drawHome(base({ overviews: unnamed }))).kind, DRAW.otherWorld);
  assert.equal((await drawHome(base({ readProvince: freeReader({ seasonV: 8n }) }))).kind, DRAW.otherWorld);
  assert.equal((await drawHome(base({ season: season({ seasonId: 8n }) }))).kind, DRAW.otherWorld);
  for (const w of [null, { ...WORLD, gen: undefined }, { ...WORLD, cluster: '' }]) assert.equal((await drawHome(base({ world: w }))).kind, DRAW.held);
  assert.equal(sameWorld(worldKeyOf(WORLD), worldKeyOf({ ...WORLD, gen: 2 })), false);
  assert.equal(sameWorld(null, null), false);
});

test('D5 full, and the density limit', async () => {
  assert.equal((await drawHome(base({ overviews: overviews({ taken: () => true }) }))).kind, DRAW.full);
  // 9 of 12 taken = 7,500 bps: at the limit, not drawn into
  assert.equal((await drawHome(base({ overviews: overviews({ taken: (p, q, i) => i < 9 }) }))).kind, DRAW.full);
  const r = await drawHome(base({ overviews: overviews({ taken: (p, q, i) => i < 8 }) }));
  assert.equal(r.kind, DRAW.assigned);
  assert.ok(r.place.site >= 8);
  assert.equal((await drawHome(base({ contiguous: 2 }))).kind, DRAW.full);
});

test('D6 taken since the overviews: the next by score; all taken: contested', async () => {
  const first = await drawHome(base());
  const takenFirst = async (p, q) => province(p, q, { state: (pp, qq, i) => (pp === first.place.p && qq === first.place.q && i === first.place.site ? 1 : 0) });
  const second = await drawHome(base({ readProvince: takenFirst }));
  assert.equal(second.kind, DRAW.assigned);
  assert.notDeepEqual(second.place, first.place);
  assert.equal(second.checked[0].now, 'taken');
  const allTaken = await drawHome(base({ readProvince: async (p, q) => province(p, q, { state: () => 1 }), params: { ...PROVISIONAL_PARAMS, maxConfirmReads: 3 } }));
  assert.equal(allTaken.kind, DRAW.contested);
  assert.equal(allTaken.checked.length, 3);
  const noSites = await drawHome(base({ readProvince: async (p, q) => province(p, q, { siteCount: 0 }), params: { ...PROVISIONAL_PARAMS, maxConfirmReads: 2 } }));
  assert.equal(noSites.kind, DRAW.unread);
});

test('D7 ticket cohorts', () => {
  const pv = cohorts => province(2, 0, { cohorts }).province;
  assert.equal(siteNow(pv([{ filed: 2, settled: 1, bell: 40 }]), 0, 50), 'cohort');
  assert.equal(siteNow(pv([{ filed: 2, settled: 1, bell: 10 }]), 0, 50), 'free');
  assert.equal(siteNow(pv([{ filed: 2, settled: 2, bell: 40 }]), 0, null), 'free');
  assert.equal(siteNow(pv([{ filed: 2, settled: 1, bell: 40 }]), 0, null), 'unknown');
  assert.equal(siteNow(pv([{ filed: 'x' }]), 0, 50), 'unknown');
  assert.equal(siteNow({ ...pv([]), ticketCohorts: undefined }, 0, 50), 'unknown');
  assert.equal(siteNow(pv([]), 12, 50), 'absent');
});

test('D8 the chain view never says accepted', () => {
  const beyond = chainView({ p: 4, q: 0 }, { heartlandMaxRing: 3 });
  assert.equal(beyond.placeHome, 'refused-by-rule');
  const inside = chainView({ p: 2, q: 0 }, { heartlandMaxRing: 3 });
  assert.equal(inside.placeHome, 'not-checked');
  const n = inside.nation;
  assert.equal(chainView({ p: 2, q: 0 }, { heartlandMaxRing: 3, faction: (n + 1) % 6 }).placeHome, 'refused-by-rule');
  assert.equal(chainView({ p: 2, q: 0 }, { heartlandMaxRing: 3, faction: n }).placeHome, 'not-checked');
  assert.equal(chainView({ p: 2, q: 0 }, {}).placeHome, 'not-checked');
  assert.doesNotMatch(code(read('fhome-draw.mjs')), /'accepted'|placeHome: 'ok'|placeHome: true/);
});

test('D9 recheck', async () => {
  const d = await drawHome(base());
  const env = s => province(d.place.p, d.place.q, { state: () => s });
  assert.equal(recheck(d, { world: WORLD, citizen: 'Wallet1111', envelope: env(0), nowBell: 50 }).now, 'free');
  assert.equal(recheck(d, { world: WORLD, citizen: 'Wallet1111', envelope: env(1), nowBell: 50 }).now, 'takenSince');
  assert.equal(recheck(d, { world: WORLD, citizen: 'Other', envelope: env(0) }).now, 'otherDraw');
  assert.equal(recheck(d, { world: { ...WORLD, gen: 2 }, citizen: 'Wallet1111', envelope: env(0) }).now, 'otherDraw');
  assert.equal(recheck(d, { world: WORLD, citizen: 'Wallet1111', envelope: null }).now, 'unknown');
});

test('D10 map growth, read only', () => {
  assert.equal(ringOccupancyMet([5, 0, 0, 0, 0, 0], [10, 0, 0, 0, 0, 0], 5000), true);
  assert.equal(ringOccupancyMet([4, 0, 0, 0, 0, 0], [10, 0, 0, 0, 0, 0], 5000), false);
  assert.equal(ringOccupancyMet([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], 0), false);
  assert.equal(ringOccupancyMet(null, null, 1), null);
  const rec = { rMax: 4, rMaxCeiling: 8, ringsOpened: 5, wedgeOpen: [10, 10, 10, 10, 10, 10], wedgeOccupied: [6, 0, 0, 0, 0, 0], genesisTs: 1000, latestUnix: 2000 };
  const se = { endBell: 100000, thetaEarlyBps: 5000, thetaLateBps: 8000, thetaSwitchSecs: 5000 };
  const g = growthView({ record: rec, season: se, nowBell: 10 });
  assert.equal(g.state, GROWTH.maybe);
  assert.equal(g.nextRing, 5);
  assert.equal(g.conditions.find(c => c.id === 'sinceLast').met, null);
  assert.equal(growthView({ record: { ...rec, wedgeOccupied: [1, 0, 0, 0, 0, 0] }, season: se, nowBell: 10 }).state, GROWTH.unmet);
  assert.equal(growthView({ record: { ...rec, rMaxCeiling: 0 }, season: se, nowBell: 10 }).state, GROWTH.none);
  assert.equal(growthView({ record: { ...rec, rMaxCeiling: 4 }, season: se, nowBell: 10 }).state, GROWTH.none);
  assert.equal(growthView({ record: rec, season: se, nowBell: 100000 }).state, GROWTH.none);
  assert.equal(growthView({ record: { ...rec, ringsOpened: 4 }, season: se, nowBell: 10 }).state, GROWTH.unmet);
  assert.equal(growthView({ record: null }).state, GROWTH.unknown);
  // late θ after the switch: 6/10 is below 8,000 bps
  assert.equal(growthView({ record: { ...rec, latestUnix: 9000 }, season: se, nowBell: 10 }).state, GROWTH.unmet);
  const src = code(read('fhome-draw-frontier.mjs'));
  assert.doesNotMatch(src, /fetch\(|submit|sign|Date\.now|ExtendFrontier\(|encode/);
  assert.doesNotMatch(JSON.stringify(Object.values(GROWTH)), /will/);
});

test('D11 the view: a late answer, another wallet or world is never shown; nothing stored', async () => {
  const gates = [];
  const draw = args => new Promise(res => gates.push(() => res(Object.freeze({ kind: DRAW.assigned, world: args.world, citizen: args.citizen, place: { p: 2, q: 0, site: gates.length, ring: 2 } }))));
  const v = createDrawView({ draw, growth: () => null });
  assert.deepEqual(await v.ask({}), { applied: false, why: 'noWallet' });
  v.setWallet('Wallet1111');
  assert.deepEqual(await v.ask({}), { applied: false, why: 'noWorld' });
  v.setWorld(WORLD);
  const one = v.ask({}), two = v.ask({});
  gates[1](); assert.deepEqual(await two, { applied: true });
  gates[0](); assert.deepEqual(await one, { applied: false, why: 'stale' });
  assert.equal(v.state().answer.place.site, 2);
  // another wallet while asking: nothing of the old one stays
  const three = v.ask({});
  v.setWallet('Other');
  assert.equal(v.state().answer, null);
  gates[2](); assert.equal((await three).applied, false);
  assert.equal(v.state().answer, null);
  // another world, or the same Season pinned again (another generation)
  v.setWallet('Wallet1111');
  const four = v.ask({});
  v.setWorld({ ...WORLD, gen: 2 });
  gates[3](); assert.equal((await four).applied, false);
  assert.equal(v.state().status, VIEW.empty);
  // an answer naming another citizen or world is not shown
  const liar = createDrawView({ draw: async a => ({ kind: DRAW.assigned, world: a.world, citizen: 'Someone' }), growth: () => null });
  liar.setWallet('Wallet1111'); liar.setWorld(WORLD);
  assert.deepEqual(await liar.ask({}), { applied: false, why: 'otherWallet' });
  const away = createDrawView({ draw: async a => ({ kind: DRAW.assigned, world: { ...a.world, gen: 9 }, citizen: a.citizen }), growth: () => null });
  away.setWallet('Wallet1111'); away.setWorld(WORLD);
  assert.deepEqual(await away.ask({}), { applied: false, why: 'otherWorld' });
  assert.doesNotMatch(code(read('fhome-draw-view.mjs')), /localStorage|sessionStorage|indexedDB|uiStorage|saveHome|fetch\(/);
});

test('D12 the screen', async () => {
  const d = await drawHome(base({ citizen: '<b>x</b>' }));
  const html = homeDrawHtml({ status: VIEW.shown, answer: d, growth: growthView({ record: null }) });
  assert.match(html, /data-production="false"/);
  assert.match(html, /Test only\. Nothing is joined, placed, signed or sent/);
  assert.match(html, /Your village would be placed in province/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  for (const l of LIMITS_TEXT) assert.ok(html.includes(l.replace(/'/g, '&#39;')), l);
  assert.equal(PROVISIONAL.limits.length, LIMITS_TEXT.length);
  const BANNED_EN = /\bbell \d|\bbells?\b|\btick|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport|minutes?\b|next turn/i;
  const texts = [DRAW.assigned, DRAW.full, DRAW.unread, DRAW.otherWorld, DRAW.contested].map(kind => homeDrawHtml({ status: VIEW.shown, answer: { ...d, kind, unreadRings: [3] }, growth: growthView({ record: { rMax: 4, rMaxCeiling: 8, ringsOpened: 5 }, season: {}, nowBell: null }) }));
  texts.push(homeDrawHtml({ status: VIEW.reading }));
  for (const t of texts) assert.doesNotMatch(t.replace(/<[^>]+>/g, ' '), BANNED_EN);
  assert.doesNotMatch(texts.join(''), /accepted|will be placed/i);
});

test('D13 the page: gated, GET reads only, no join or send', () => {
  const page = code(read('home-draw-page.mjs')), html = read('home-draw.html');
  assert.match(page, /if \(!cfg\?\.dev\) return false;/);
  assert.match(page, /searchParams\.get\(GATE_PARAM\) === GATE_VALUE/);
  assert.match(page, /if \(!gateOpen\(loc, cfg\)\) \{ root\.textContent = 'This test page is not switched on\.'; return; \}/);
  for (const banned of [/controller\.mjs/, /confirmHome/, /placeHome|PlaceHome/, /fplay\.mjs/, /wallet\.mjs/, /fjoin\.mjs/, /submit\(/, /signTransaction|signMessage/, /method:\s*'POST'/, /localStorage|saveHome|saveUi/, /Date\.now|Math\.random/])
    assert.doesNotMatch(page, banned, String(banned));
  assert.match(page, /herald\.season\(\)/);
  assert.match(page, /herald\.overview\(d\)/);
  assert.match(page, /herald\.province\(p, q\)/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(html, /<script(?! type="module" src="home-draw-page\.mjs")/);
  assert.doesNotMatch(html, /style=/);
  // not linked from the play page or the controller
  for (const f of ['index.html', 'controller.mjs', 'app.mjs']) assert.doesNotMatch(read(f), /home-draw/, f);
});

test('D14 the core: no clock, randomness, storage, fetch or send', () => {
  const core = code(read('fhome-draw.mjs'));
  assert.doesNotMatch(core, /Date\.now|new Date|Math\.random|localStorage|fetch\(|submit|signMessage|signTransaction|confirmHome/);
  // the score is order-free: candidates are sorted by score before anything is read
  assert.match(core, /candidates\.sort\(\(a, b\) => cmpBytes\(a\.score, b\.score\)/);
  // no nation filter in the candidates
  const cand = core.slice(core.indexOf('export function candidatesFrom'), core.indexOf('export function siteNow'));
  assert.doesNotMatch(cand, /homeNation|wedgeOf|faction/);
  assert.equal(drawRings(EXTENT, CONTIGUOUS).drawn.join(','), '2,3,4');
  assert.equal(drawRings({ ...EXTENT, rMaxCeiling: 8 }, CONTIGUOUS).near.join(','), '5');
});

test('D15 the page: only the current request touches the page', async () => {
  const page = code(read('home-draw-page.mjs'));
  const start = page.slice(page.indexOf('export async function start('));
  // no herald client shared by requests: it is made inside the Draw handler, after the request's number
  assert.doesNotMatch(start.slice(0, start.indexOf("addEventListener('submit'")), /createHerald\(/);
  const sub = start.slice(start.indexOf("addEventListener('submit'"));
  const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
  order(sub, 'const my = ++current, wallet = input.value.trim();', 'view.cancel();', 'view.setWallet(wallet);',
    "const live = () => my === current && view.state().wallet === (wallet || null);",
    'const fail = () => { if (!live()) return;',
    'try {', 'const herald = createHerald({ base: cfg.herald });',
    'const s = await herald.season();', 'if (!live()) return;', 'if (!s?.ok) return fail();',
    'herald.pin(s.record.season);', 'view.setWorld(worldOfRecord(s.record));', 'paint();',
    'await readRings(herald, rings.drawn)', 'if (!live()) return;',
    'await view.ask(', 'if (!live()) return;', 'paint();', '} catch { fail(); }');
  // every await in the handler is followed by the check before anything else
  const awaits = sub.split('\n').filter(l => /\bawait\b/.test(l)).length;
  assert.equal(awaits, 3);
  // typing ends the request under way
  const inp = start.slice(start.indexOf("input.addEventListener('input'"), start.indexOf("addEventListener('submit'"));
  order(inp, 'current++;', 'view.cancel();', 'view.setWallet(input.value.trim());', 'paint();');
  // the failure note belongs to the request that failed and shows only while it is current
  assert.match(start, /failedFor !== 0 && failedFor === current \?/);
  assert.match(start, /failedFor = my;/);
  // the view: cancel drops an answer under way and keeps what is shown
  let release;
  const v = createDrawView({ draw: a => new Promise(res => { release = () => res({ kind: DRAW.full, world: a.world, citizen: a.citizen }); }), growth: () => null });
  v.setWallet('Wallet1111'); v.setWorld(WORLD);
  const first = v.ask({}); release(); assert.deepEqual(await first, { applied: true });
  const shown = v.state().answer;
  const late = v.ask({});
  v.cancel();
  assert.equal(v.state().status, VIEW.shown);
  release(); assert.deepEqual(await late, { applied: false, why: 'stale' });
  assert.equal(v.state().answer, shown);
});

test('D16 reproducible only for the same snapshot and parameters; no reservation claimed', async () => {
  const a = await drawHome(base());
  assert.deepEqual((await drawHome(base())).place, a.place);
  // the drawn place taken in the next overview: the same wallet in the same world is drawn elsewhere
  const moved = await drawHome(base({ overviews: overviews({ taken: (p, q, i) => p === a.place.p && q === a.place.q && i === a.place.site }) }));
  assert.equal(moved.kind, DRAW.assigned);
  assert.notDeepEqual(moved.place, a.place);
  // the score alone is fixed
  assert.equal(moved.checked.length >= 1, true);
  const core = read('fhome-draw.mjs'), screen = read('screens/home-draw.mjs'), doc = readFileSync(new URL('../../docs/integration/CLAUDE-HOME-DRAW-PROVISIONAL-20261118.md', import.meta.url), 'utf8');
  assert.match(core, /the same candidate snapshot/);
  assert.match(core, /Nothing holds or\n\/\/     reserves a drawn place/);
  assert.ok(LIMITS_TEXT.some(l => l.startsWith('Not a reservation: the same wallet gets the same place only while the free places and these settings stay the same.')));
  for (const t of [core, screen, doc]) {
    assert.doesNotMatch(t, /always (gets? )?the same place|always the same place|give the same place,\n\/\/ +whatever order/i);
    assert.doesNotMatch(t, /reserved for|is reserved|kept for you|guaranteed/i);
  }
});
