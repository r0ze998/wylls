// fix-loop15 (loop-play15 LP15-6 … LP15-9): the page-side fixes that wait on no owner answer, each pinned with what main
// did. Nothing here signs, sends or holds a key. (LP15-6: web-frontier-land.test.mjs, the home tab's words; LP15-7:
// web-frontier-hud.test.mjs, the turn's summary; LP15-8: frontier-local-play-custody.test.mjs, the booking's materials.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ LP15-9b: one march, one time
test('LP15-9b: the way to a keep says the arrival turn and the wait until it begins, as the order card does (main: the walk\'s minutes)', async () => {
  const { keepRouteLine } = await import('../../permutation-server/web/frontier/screens/conquest.mjs');
  const { routeArrival, waitWords } = await import('../../permutation-server/web/frontier/screens/march.mjs');
  const MC = await import('../../permutation-server/web/frontier/hud/marchcard.mjs');
  const { setTermsPace } = await import('../../permutation-server/web/frontier/seasonterms.mjs');
  assert.equal(MC.waitWords, waitWords, 'the order card and the keep rows word a wait with one function');
  // loop-play15's kept world: turn 2 at 12 min in, a walk of 40 min (20 tiles, 3 provinces). The march leaves 90 s from
  // now and walks 2,400 s: it is there at 3,210 s, inside turn 5 — and arrives when turn 6 begins, 48 min from now
  const GENESIS = 1_000_000, now = GENESIS + 720;
  const calls = [];
  const kernel = { call: (name, a) => { calls.push([name, a]); return { ok: true, value: Math.ceil((a.depart_ts + a.secs - a.genesis_ts) / 600) }; } };
  const FS = { clock: { genesisTs: GENESIS }, kernel, season: { minLead: 1, maxLead: 432 }, chain: { now: () => now } };
  const route = { hexes: 20, provinces: [{}, {}, {}], secs: 2400 };
  assert.deepEqual(routeArrival(FS, route), { bell: 6, inSecs: 2880 });
  assert.deepEqual(calls[0], ['earliest_arrival_bell', { genesis_ts: GENESIS, depart_ts: now + 90, secs: 2400 }], 'the composer\'s own question to the kernel');
  try {
    setTermsPace(() => 1);
    setLang('en');
    assert.equal(keepRouteLine(route), '20 tiles · 3 provinces · about 40 min', 'without the page\'s clock: the walk, as before');
    assert.equal(keepRouteLine(route, FS), '20 tiles · 3 provinces · arrives turn 6 (in about 48 min)');
    assert.equal(keepRouteLine({ hexes: 1, provinces: [{}], secs: 60 }, FS), '1 tile · 1 province · arrives turn 2 (in about 8 min)', 'never earlier than the next turn');
    setLang('ja');
    assert.equal(keepRouteLine(route, FS), '20 マス · 3 州 · 到着はターン 6（約 48 分後）');
    // a faster TEST clock: the wait in the wall's time, named the test clock — the order card's words there too
    setTermsPace(() => 60);
    setLang('en');
    assert.equal(keepRouteLine(route, { ...FS, localPlay: { clockScale: 60 } }), '20 tiles · 3 provinces · arrives turn 6 (in about 48 s on the test clock)');
    // what the page cannot tell it does not say: no kernel, no clock, a kernel that refuses, the banner prototype's clock
    setTermsPace(() => 1);
    for (const fs of [{ ...FS, kernel: null }, { ...FS, clock: null }, { ...FS, kernel: { call: () => ({ ok: false }) } }, { ...FS, kernel: { call: () => { throw new Error('x'); } } }, { ...FS, proto: {} }])
      assert.equal(keepRouteLine(route, fs), '20 tiles · 3 provinces · about 40 min');
  } finally { setLang('ja'); setTermsPace(null); }
  // both lists of the reach card hand the page's state to the row
  const src = read('permutation-server/web/frontier/screens/conquest.mjs');
  assert.equal(src.match(/keepRouteLine\(x\.route, FS\)/g)?.length, 2);
  assert.doesNotMatch(src, /keepRouteLine\(x\.route\)/);
});

// ------------------------------------------------------------------ LP15-9a: the Hosts drawer's lines span the card
test('LP15-9a: a host card\'s lines under its head span the card (main: they fell into the 60 px picture column)', () => {
  const css = read('permutation-server/web/frontier/frontier.css');
  assert.match(css, /\.host-card \{ display: grid; grid-template-columns: 60px minmax\(0, 1fr\);/, 'the card is a two-column grid: picture, head');
  assert.match(css, /\.host-card > p, \.host-card > \.host-ways \{ grid-column: 1 \/ -1; margin: 0; \}/);
  // every direct child the card writes is the picture, the head, or covered by a spanning rule
  const host = read('permutation-server/web/frontier/screens/host.mjs');
  const card = host.slice(host.indexOf('<li class="vcard host-card'), host.indexOf('</li>', host.indexOf('<li class="vcard host-card')));
  assert.match(card, /<p class="muted">\$\{formWait > 0/); assert.match(host, /<div class="actions host-ways">/); assert.match(card, /<div class="actions host-acts">/);
});
