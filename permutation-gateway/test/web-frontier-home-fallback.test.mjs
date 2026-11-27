// ⑧ doc 31 §1 option A (2026-11-18; page only — no program, ABI or rule change): when the heartland (rings 2 ..
// heartland_max_ring, the only rings PlaceHome places a first village in) has no free site for the viewer's nation, the
// page goes to the program's existing village request (FileTicket, the "札" of doc 31) instead of stopping at
// "no land found yet":
//   - 60 occupied heartland sites (5 provinces × 12) → the planner reads NoFreeHome → `heartlandFull` → the join screen
//     shows the request's wait view with one line of reason (ja / en), the plate's line follows the request, and the
//     request planner picks sites past the heartland;
//   - one open site → the planner, the instant card and the plate are exactly what they were;
//   - a visitor who has not joined is told what beginning with a full nation does, and the one button still begins.
// Pure: decoded records in memory; no network, no key, no chain.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ringProvinces, ringOf, wedgeOf, homeNation } from '../../permutation-server/web/frontier/fgeo.mjs';
import { homeWedge } from '../../permutation-server/web/frontier/fland.mjs';
import { planTicket } from '../../permutation-server/web/frontier/fjoin.mjs';
import { heartlandFull, noFreeHome, homeRingsOpen, planHomes, seasonPlace } from '../../permutation-server/web/frontier/home.mjs';
import { render as join } from '../../permutation-server/web/frontier/screens/join.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/', import.meta.url);
const source = f => readFileSync(new URL(f, WEB), 'utf8');
const seed = n => new Array(32).fill(n);
/** Instant-home Seasons whose heartland is rings 2 .. 3: the wedge rule, and the dispersed rule with its seed. */
const v2 = { layoutVersion: 2, programVersion: 4, conquestParams: { placement: 0, heartlandMaxRing: 3 } };
const v2d = { ...v2, conquestParams: { placement: 1, heartlandMaxRing: 3 }, genesisSeed: Uint8Array.from(seed(1)) };
const m1 = { layoutVersion: 1, programVersion: 1 };
const OPEN = 5;   // rings 0 .. 4 are open: the map has grown one ring past the heartland
const SITES = 12;
const nationOf = (p, q, season) => (seasonPlace(season) ? homeNation(p, q, seasonPlace(season)) : wedgeOf(p, q));

/**
 * A world of rings 2 .. 4 as the herald serves it (ring overviews and decoded Provinces). `held(p, q, site)` says which
 * sites are occupied; an occupied site is held by the province's own nation.
 */
function world(season, held) {
  const provs = [2, 3, 4].flatMap(ring => ringProvinces(ring).map(pr => ({ p: pr.p, q: pr.q, ring })));
  const overviews = new Map([2, 3, 4].map(ring => [ring, { ring, provinces: provs.filter(x => x.ring === ring).map(x => ({ p: x.p, q: x.q,
    sites: Array.from({ length: SITES }, (_, s) => (held(x.p, x.q, s) ? 1 : 0)),
    owners: Array.from({ length: SITES }, (_, s) => (held(x.p, x.q, s) ? nationOf(x.p, x.q, season) ?? 0 : 7)) })) }]));
  const province = (p, q) => ({ p, q, siteCount: SITES, sites: Array.from({ length: SITES }, (_, s) => s * 5),
    siteMirror: Array.from({ length: SITES }, (_, s) => ({ state: held(p, q, s) ? 1 : 0, gen: 0 })), ticketCohorts: [] });
  return { overviews, read: async (p, q) => province(p, q), provs };
}
/** The heartland provinces of nation `f` (rings 2 .. 3 under the season's placement). */
const heartOf = (season, f) => [2, 3].flatMap(ring => ringProvinces(ring)).filter(pr => nationOf(pr.p, pr.q, season) === f);
const inHeart = (season, f) => { const keys = new Set(heartOf(season, f).map(pr => `${pr.p},${pr.q}`)); return (p, q) => keys.has(`${p},${q}`); };
const plan = (season, w, f) => planHomes({ overviews: w.overviews, read: w.read, faction: f, ringsOpen: homeRingsOpen(season, OPEN), seed: 'x', place: seasonPlace(season) });
/** The choice as controller refreshHomes leaves it after a reading (its sentence for NoFreeHome included). */
const choiceOf = (result, f) => ({ ...result, faction: f, selected: result.candidates[0] ?? null, loading: false,
  error: result.error ? { code: result.error, text: L`入植できる土地がまだ見つかりません。候補を更新してください。` } : null });
/** A Citizen of nation `f` that has joined and has no village, on the page in play. */
const joined = (season, f, homeChoice, extra = {}) => ({ mode: 'play', season, meStatus: 'ready', wallet: { address: 'W' }, session: {}, citizen: { faction: f, flags: 1 }, holdings: [],
  provinces: new Map(), nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'joined' }, ui: { dismissed: [] }, homeChoice, ...extra });
const visitor = (season, f, homeChoice, extra = {}) => ({ ...joined(season, f, homeChoice), citizen: null, session: null, land: { stage: 'none' }, joinDraft: { faction: f }, ...extra });
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const REASON = { ja: /すぐに村を置ける本国の土地は、いま空いていません。代わりに、空いている土地へ村の申し込みを出します。/, en: /The heartland, where a first village is placed at once, has no free site right now\. A village request is sent to open land instead\./ };
const NO_LAND = { ja: /入植できる土地がまだ見つかりません/, en: /No land to settle has been found yet|No free land/ };

test('60 occupied heartland sites: the planner reads NoFreeHome and the page shows the village request, with its reason, in both languages', async () => {
  for (const season of [v2, v2d]) for (const f of [0, 3]) {
    const heart = heartOf(season, f);
    assert.equal(heart.length * SITES, 60, 'the heartland of one nation is 5 provinces of 12 sites');
    const full = inHeart(season, f), w = world(season, (p, q) => full(p, q));
    const result = await plan(season, w, f);
    assert.deepEqual({ n: result.candidates.length, error: result.error }, { n: 0, error: 'NoFreeHome' });
    // (an overview that is behind — it still lists the sites as free — changes nothing: the Provinces themselves are read)
    const stale = { ...w, overviews: world(season, () => false).overviews };
    assert.equal((await plan(season, stale, f)).error, 'NoFreeHome', 'a stale overview: the decoded Provinces decide');

    const FS = joined(season, f, choiceOf(result, f));
    assert.equal(heartlandFull(FS), true);
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      const markup = String(join(FS)), text = plain(markup);
      assert.match(markup, /class="vcard wait-card"/, `${lang}: the request's wait view`);
      assert.match(markup, /data-home-fallback="request"/);
      assert.match(text, REASON[lang], `${lang}: one line of reason`);
      assert.doesNotMatch(markup, /data-act="home-confirm"|data-act="home-reread"/, `${lang}: no button of the planner, which has nowhere to place`);
      assert.doesNotMatch(text, NO_LAND[lang], `${lang}: not the planner's dead end`);
      if (lang === 'en') assert.doesNotMatch(text, /[぀-ヿ一-鿿]/, 'en: no Japanese left in the card');
      // the plate's line follows the request (hud waitingLine), not the planner's sentence
      const line = String(hud.waitingLine(FS));
      assert.doesNotMatch(line, NO_LAND[lang]);
      assert.equal(line, String(hud.waitingLine({ ...FS, season: m1, homeChoice: null })), `${lang}: the same line as a request season's`);
    }
    setLang('ja');
    // a request that was refused or found nothing keeps the reason above its warning
    for (const state of ['failed', 'nofree']) {
      const stuck = String(join({ ...FS, autoTicket: { state, bell: 10, code: 'Unavailable' } }));
      assert.match(stuck, /wait-stuck/); assert.match(stuck, /data-home-fallback="request"/);
      assert.match(stuck, /data-act="auto-ticket"/, 'the one button tries the request again');
    }
  }
});

test('with the heartland full the request planner (unchanged) finds land past it, in the nation\'s own wedge', async () => {
  for (const season of [v2, v2d]) for (const f of [0, 3]) {
    const full = inHeart(season, f), w = world(season, (p, q) => full(p, q));
    const got = await planTicket({ overviews: w.overviews, place: seasonPlace(season), faction: f, ringsOpen: OPEN, seed: 'x', nowBell: 10, read: w.read, homeFull: null });
    assert.equal(got.ok, true); assert.equal(got.source, 'home');
    assert.ok(got.sites.length >= 1 && got.sites.length <= 3);
    for (const s of got.sites) {
      assert.equal(ringOf(s.p, s.q), 4, 'past the heartland: the ring the map grew by');
      assert.equal(wedgeOf(s.p, s.q), homeWedge(f), 'FileTicket\'s wedge rule past the heartland');
      assert.equal(full(s.p, s.q), false);
    }
  }
});

test('one open heartland site: the planner, the instant card and the plate are unchanged', async () => {
  for (const season of [v2, v2d]) for (const f of [0, 3]) {
    const heart = heartOf(season, f), last = heart[heart.length - 1], full = inHeart(season, f);
    // 59 of the 60 are held: site 7 of one province is free
    const w = world(season, (p, q, s) => full(p, q) && !(p === last.p && q === last.q && s === 7));
    const result = await plan(season, w, f);
    assert.equal(result.error, null);
    assert.deepEqual(result.candidates.map(c => [c.p, c.q, c.site]), [[last.p, last.q, 7]], 'the one free site is the candidate');
    const FS = joined(season, f, choiceOf(result, f));
    assert.equal(heartlandFull(FS), false);
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      const markup = String(join(FS));
      assert.match(markup, /data-act="home-confirm"/, `${lang}: the planner's one button`);
      assert.doesNotMatch(markup, /data-home-fallback/);
      assert.equal(markup, String(join({ ...FS, localPlay: { any: 1 } })), 'and the same card as where the fallback is off');
      assert.equal(String(hud.waitingLine(FS)), L`村を築ける土地を探しています…`);
    }
    setLang('ja');
    // a visitor choosing that nation: the nation choice, no fallback line
    const v = String(join(visitor(season, f, choiceOf(result, f))));
    assert.match(v, /data-act="home-confirm"/); assert.doesNotMatch(v, /data-home-fallback/);
  }
});

test('heartlandFull is only a finished "no free home" reading for the Citizen\'s own nation, in an instant-home Season, outside local play', () => {
  const none = { faction: 2, candidates: [], selected: null, error: { code: 'NoFreeHome' } };
  const FS = joined(v2, 2, none);
  assert.equal(heartlandFull(FS), true);
  assert.equal(heartlandFull({ ...FS, homeChoice: { ...none, error: { code: 'Unavailable' } } }), false, 'a reading that failed is not a full heartland');
  assert.equal(heartlandFull({ ...FS, homeChoice: { ...none, error: null, loading: true } }), false, 'a reading under way');
  assert.equal(heartlandFull({ ...FS, homeChoice: { ...none, faction: 3 } }), false, 'another nation\'s reading');
  assert.equal(heartlandFull({ ...FS, homeChoice: null }), false);
  assert.equal(heartlandFull({ ...FS, citizen: null }), false, 'a visitor: the nation choice says it (noFreeHome)');
  assert.equal(heartlandFull({ ...FS, citizen: { flags: 1 }, homeChoice: { candidates: [], error: { code: 'NoFreeHome' } } }), false, 'no nation on either side is not a match');
  assert.equal(heartlandFull({ ...FS, holdings: [{ p: 2, q: 0 }] }), false, 'a village is held');
  assert.equal(heartlandFull({ ...FS, season: m1 }), false, 'a request season has no instant home to fall back from');
  assert.equal(heartlandFull({ ...FS, localPlay: { any: 1 } }), false, 'local play serves no FileTicket: the planner\'s sentence stays');
  assert.equal(heartlandFull(null), false); assert.equal(heartlandFull({}), false);
  assert.equal(noFreeHome(none, 2), true); assert.equal(noFreeHome(none, 3), false); assert.equal(noFreeHome(none, null), false); assert.equal(noFreeHome(null, 2), false);
  // where the fallback is off, the page is what it was: the planner's card with its sentence and its re-read
  const local = String(join({ ...FS, localPlay: { any: 1 }, homeChoice: { ...none, error: { code: 'NoFreeHome', text: '入植できる土地がまだ見つかりません。候補を更新してください。' } } }));
  assert.match(local, /data-act="home-confirm"/); assert.match(local, /入植できる土地がまだ見つかりません/); assert.doesNotMatch(local, /data-home-fallback/);
});

test('a visitor whose chosen nation is full is told what beginning does, and the one button still begins (ja / en)', async () => {
  const f = 1, full = inHeart(v2d, f), result = await plan(v2d, world(v2d, (p, q) => full(p, q)), f);
  assert.equal(result.error, 'NoFreeHome');
  const WORDS = { ja: /この国は、すぐに村を置ける本国の土地がいま空いていません。.*村の申し込みを出します（村が決まるまで約11〜21分）。本国に空きのある国なら、すぐに村を置けます。/,
    en: /This nation has no free site right now in its heartland.*a village request is sent to open land instead \(about 11 to 21 minutes until the village is decided\)\. A nation with free sites in its heartland places your village at once\./ };
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const FS = visitor(v2d, f, choiceOf(result, f));
    const markup = String(join(FS)), text = plain(markup);
    assert.match(markup, /data-home-fallback="nation"/); assert.match(text, WORDS[lang], lang);
    assert.match(markup, /data-act="home-confirm" >|data-act="home-confirm">/, `${lang}: the button is not disabled`);
    assert.doesNotMatch(markup, /class="notice error"/, `${lang}: not an error`);
    assert.doesNotMatch(text, NO_LAND[lang]);
    assert.match(markup, /data-act="home-reread"/, 'the candidates can still be read again');
    assert.equal((markup.match(/data-act="pick-faction"/g) ?? []).length, 6, 'another nation can be chosen');
    // another nation looked at, a failed reading, local play: the page's own error line, as before
    for (const other of [visitor(v2d, 2, choiceOf(result, f)), visitor(v2d, f, { ...choiceOf(result, f), error: { code: 'Unavailable', text: 'x' } }), visitor(v2d, f, choiceOf(result, f), { localPlay: { any: 1 } })]) {
      const m = String(join(other));
      assert.doesNotMatch(m, /data-home-fallback/); assert.match(m, /class="notice error"/);
    }
  }
});

test('the controller: a full heartland needs no home choice, the request is filed at once, and a visitor\'s press joins without PlaceHome', () => {
  const ctl = source('frontier/controller.mjs');
  const needs = ctl.slice(ctl.indexOf('function needsHomeChoice()'), ctl.indexOf('function updateHomeGrant()'));
  assert.match(needs, /if \(!FS\.citizen\) return true;[\s\S]*if \(heartlandFull\(FS\)\) return false;[\s\S]*return FS\.land\?\.stage === 'joined'/, 'needsHomeChoice');
  assert.ok(ctl.includes('if (needsHomeChoice()) { await refreshHomes(); if (heartlandFull(FS)) autoTicket().catch('), 'the poll hands a new "full" reading to the request');
  assert.match(ctl, /export async function autoTicket\(\{ force = false \} = \{\}\) \{\n  if \(needsHomeChoice\(\)\) \{ FS\.autoTicket = null; return; \}/, 'autoTicket runs only when no home choice is needed');
  const confirm = ctl.slice(ctl.indexOf('export async function confirmHome()'), ctl.indexOf('// ------------------------------------------------------------------ the first holding, placed automatically'));
  assert.ok(confirm.includes('const requestInstead = !FS.homeChoice?.selected && !FS.citizen && !FS.resident && !localPlay && noFreeHome(FS.homeChoice, faction);'));
  // one flow: the same Join and key steps as a placed village; the request-instead press has no place to check and
  // returns before PlaceHome
  assert.ok(confirm.includes('if (requestInstead) site = { faction };'));
  assert.equal(confirm.split('await ACTIONS.join()').length - 1, 1, 'one Join per confirm, as before');
  const tail = confirm.slice(confirm.indexOf('if (!mine() || !FS.session || FS.sessionProblem) return;'));
  const stop = tail.indexOf('if (requestInstead) {'), place = tail.indexOf("pending('placing');");
  assert.ok(stop > 0 && place > stop, 'the request-instead press ends before the placing step');
  assert.match(tail.slice(stop, place), /if \(heartlandFull\(FS\)\) \{[^\n]*autoTicket\(\)[^\n]*\}\n\s+return;\n\s+\}\n\s*$/, 'it hands over to the request and returns: no PlaceHome');
  assert.ok(confirm.includes('if (reading) run.choice.error = reading;'), 'the reading the press was made on stays');
  // no new order: the request is the program's FileTicket, sent where it always was
  // (wide-local-playable: and the local wide world's one-site rim request, in the confirm, local wide worlds only)
  assert.equal(ctl.split("act('FileTicket'").length - 1, 2);
  // (world4-pacing-impl: the rim request is skipped only in a `pacing` 1 world whose rim province is settled — atOnce)
  assert.equal(ctl.split("if (!atOnce && wideHomes() && ringOf(site.p, site.q) > Number(FS.season?.conquestParams?.heartlandMaxRing ?? 3)) {").length - 1, 1);
  // both languages have the two sentences
  const en = source('lang/en-frontier-play.mjs');
  assert.ok(en.includes('"すぐに村を置ける本国の土地は、いま空いていません。代わりに、空いている土地へ村の申し込みを出します。":'));
  assert.ok(en.includes('"この国は、すぐに村を置ける本国の土地がいま空いていません。この国で始めると、代わりに空いている土地へ村の申し込みを出します（村が決まるまで約11〜21分）。本国に空きのある国なら、すぐに村を置けます。":'));
});
