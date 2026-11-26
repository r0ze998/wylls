// devnet-page-outpost: the village screen's 2つめ・3つめの村 card (permutation-server/web/frontier/screens/outpostcard.mjs)
// — when it shows, which provinces it lists, how it says "not opened yet", the fog rule for the site it names, and the
// two-press preview in SOL. Key-free: no wallet, no key, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outpostCandidates, outpostCardModel, outpostSiteOf, outpostCard } from '../../permutation-server/web/frontier/screens/outpostcard.mjs';
import { outpostCost } from '../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { devnetLane } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { createFogger, resetFogNow } from '../../permutation-server/web/frontier/map/fog.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { ringOf } from '../../permutation-server/web/frontier/fgeo.mjs';

const HOME = { p: 128, q: -60, site: 3, order: 1, state: 2, tier: 0, gen: 1 };
const DP = { lane: devnetLane('1', { extra: ['FileOutpost'] }) };
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const provinceOf = (states, n = 6) => ({ siteCount: n, siteMirror: Array.from({ length: n }, (_, j) => ({ state: states[j] ?? 0 })) });
const FSof = (over = {}) => ({ devnetPlay: DP, holdings: [HOME], citizen: { slots: 0, faction: 1 }, season: { conquestParams: { heartlandMaxRing: 3, outpostRange: 3 } },
  provinces: new Map(), provinceReads: new Map(), ...over });
const M = { holding: HOME };
const text = h => String(h?.strings ? h.strings.join('') + h.values.map(String).join('') : h);

test('the candidates are the program\'s own: past the heartland, within range, inside the legacy disk; nearest first', () => {
  const c = outpostCandidates({ p: 128, q: -60 });
  assert.ok(!c.some(x => x.p === 128 && x.q === -60), 'never the home\'s own province (the program: BadAccount)');
  assert.equal(c[0].d, 1);
  assert.ok(c.every(x => x.ring > 3 && x.ring <= 128 && x.d <= 3));
  assert.ok(c.every((x, i) => i === 0 || c[i - 1].d <= x.d));
  const inner = outpostCandidates({ p: 2, q: 0 }, { max: 100 });
  assert.ok(inner.length > 0 && inner.every(x => ringOf(x.p, x.q) >= 4), 'a heartland home: only rings 4+');
});

test('shown only on a devnet page whose gateway carries FileOutpost, for the first home; never in local play', () => {
  assert.ok(outpostCardModel(FSof(), M));
  assert.equal(outpostCardModel(FSof({ devnetPlay: null }), M), null);
  assert.equal(outpostCardModel(FSof({ devnetPlay: { lane: devnetLane('1') } }), M), null, 'an older gateway: no card');
  assert.equal(outpostCardModel(FSof({ localPlay: { address: 'x' } }), M), null);
  assert.equal(outpostCardModel(FSof(), { holding: { ...HOME, order: 2 } }), null);
});

test('a province the herald has no record of says "not opened yet"; one not read yet says so; an open one names a site', () => {
  resetFogNow();
  const FS = FSof();
  FS.provinceReads.set('127,-60', { state: 'missing', code: 'NotFound' });
  FS.provinces.set('127,-59', { province: provinceOf([1, 0]) });
  const o = outpostCardModel(FS, M);
  const row = (p, q) => o.rows.find(r => r.p === p && r.q === q);
  assert.equal(row(127, -60).state, 'unopened');
  assert.equal(row(126, -60).state, 'unknown');
  assert.equal(row(127, -59).state, 'open'); assert.equal(row(127, -59).site, 1, 'the first free site (no fog: the live record)');
  setLang('ja');
  const html = text(outpostCard(FS, M, false));
  assert.match(html, /この州はまだ開かれていません/); assert.match(html, /近くの州を調べる/); assert.match(html, /2つめ・3つめの村を出す/);
  setLang('en');
  assert.match(text(outpostCard(FS, M, false)), /This province is not opened yet/);
  setLang('ja');
});

test('fog: a site is named only where its tile is in sight now (live) or was seen before (the last-known record), never where it was never seen', () => {
  const FS = FSof();
  FS.provinces.set('127,-59', { province: provinceOf([1, 0, 0]) });
  FS.terrainOf = () => ({ sites: [10, 11, 12] });
  const fog = createFogger({ storage: mem() });
  const survey = lv => ({ rev: 1, showAll: false, tiles: new Map(), levelOf: (p, q, t) => lv[t] ?? 1, province: () => ({ max: 1 }) });
  // site 1's tile is never seen, site 2's is in sight: site 2 is named
  fog({ active: true, survey: survey({ 10: 3, 12: 3 }), overviews: new Map() });
  assert.deepEqual(outpostSiteOf(FS, 127, -59), { site: 2, seen: 'sight' });
  // nothing in sight: no site is named, although the live record has free ones
  fog({ active: true, survey: { ...survey({}), rev: 2 }, overviews: new Map() });
  assert.equal(outpostSiteOf(FS, 127, -59), null);
  const o = outpostCardModel(FS, M);
  assert.equal(o.rows.find(r => r.p === 127 && r.q === -59).site, null);
  assert.match(text(outpostCard(FS, M, false)), /見えている空きマスがありません/);
  resetFogNow();
});

test('the preview (first press) names the wallet\'s cost in SOL, the settler cost, and the send button; a pending ticket and the new village are read back', () => {
  setLang('ja');
  const FS = FSof({ outpostPreview: { step: 'preview', target: { p: 127, q: -59, site: 2 }, slot: 2, cost: outpostCost({ holdingRent: 7152640n }), settler: [800, 800, 400, 0, 0, 200, 0, 0], wallet: 'w', at: Date.now() } });
  const h = text(outpostCard(FS, M, false));
  assert.match(h, /最大 0\.00715764 SOL/); assert.match(h, /0\.00715264 SOL/); assert.match(h, /0\.000005 SOL/);
  assert.match(h, /data-act="outpost-send"/); assert.match(h, /2つめの村を申し込みます/);
  const pending = text(outpostCard(FSof({ citizen: { slots: 2, faction: 1 } }), M, false));
  assert.match(pending, /申し込みの結果を待っています/); assert.doesNotMatch(pending, /outpost-preview/);
  const after = text(outpostCard(FSof({ holdings: [HOME, { p: 127, q: -59, site: 2, order: 2, state: 1 }] }), M, false));
  assert.match(after, /2つめの村: 州 127,-59 の村の場所 3/);
});
