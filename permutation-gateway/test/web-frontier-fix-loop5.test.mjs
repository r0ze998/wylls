// fix-loop5: the confusing/cosmetic BREAKs of loop-play5 (reports/loop-play5.md §1), the pure parts and the wiring.
//   L5-3  the boundary card: taller, its newest answer scrolled into view, a read the clock dropped is said and read again
//   L5-4  a road ending on an unopened wide province is said at once, with the nearest opened one
//   L5-5  an expedition whose seal is open no longer says "waiting for the seal to open" on the map
//   L5-7  while the first host forms, the guide pill says the wait; a press for meanwhile is 「待つ間に：…」
//   L5-10 the 軍勢 tab shows the exploration card only with a scout or an exploration to speak of
// Local-only (imports page modules through src/), like the other web-frontier-*.test.mjs pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const src = rel => readFileSync(new URL(`../../permutation-server/web/frontier/${rel}`, import.meta.url), 'utf8');

test('L5-3: the boundary card is taller and scrolls; a dropped read is said and read again at most twice (reads only)', async () => {
  const css = src('frontier.css');
  assert.match(css, /body \.hand-pop\[data-pop="expedition-compose"\]\[data-mode="card"\] \{\n  width: min\(600px, calc\(100vw - 2 \* var\(--edge\)\)\);\n[^}]*max-height: min\(480px, calc\(var\(--vvh\) \* \.55\)\);\n  overflow-y: auto;\n\}/);
  assert.doesNotMatch(css, /max-height: min\(300px, calc\(var\(--vvh\) \* \.35\)\)/);
  const app = src('app.mjs');
  assert.ok(app.includes("if (model.pop === OUTBOUND_POP) scrollOutboundResult();"));
  assert.ok(app.includes("const el = handPopEl?.querySelector?.('.outbound-context-report, .outbound-route-report, .outbound-read-dropped');"));
  const c = src('controller.mjs');
  assert.ok(c.includes('export const OUTBOUND_READ_RETRIES = 2;'));
  // (fix-loop6, LP6-8: the same loop, each read made again now said on the card — FS.outboundReread)
  assert.ok(c.includes("if (FS.expeditionCompose?.dropped !== kind || i >= OUTBOUND_READ_RETRIES) return;"));
  assert.ok(c.includes("FS.outboundReread = { kind, n: i + 1, of: OUTBOUND_READ_RETRIES }; invalidate('panel');"));
  const compose = src('fexpedition-compose.mjs');
  assert.ok(compose.includes("const dropped = s.routeCheck?.status === 'loading' ? 'route' : s.contextCheck?.status === 'loading' ? 'context' : null;\n  if (dropped) s.dropped = dropped;"));
  const hand = src('hud/hand.mjs');
  assert.ok(hand.includes('outbound-read-dropped'));
});

test('L5-4: a road ending on an unopened wide province is said at once, with the nearest opened one', async () => {
  const { outboundEndpointOpen } = await import('../../permutation-server/web/frontier/fexpedition-compose.mjs');
  const targets = [{ p: '-68', q: '-61' }, { p: '-70', q: '-58' }];
  assert.deepEqual(outboundEndpointOpen({ p: '-69', q: '-60' }, targets), { open: false, nearest: { p: '-68', q: '-61', away: 1 } }, 'loop-play5: (-69,-60) was not opened; (-68,-61) was');
  assert.deepEqual(outboundEndpointOpen({ p: '-68', q: '-61' }, targets), { open: true, nearest: null });
  assert.equal(outboundEndpointOpen({ p: '1', q: '0' }, targets), null, 'inside the legacy disk: nothing to say');
  assert.equal(outboundEndpointOpen({ p: '-69', q: '-60' }, []), null, 'no list (not a wide world): nothing to say');
  assert.equal(outboundEndpointOpen(null, targets), null);
  const hand = src('hud/hand.mjs');
  assert.ok(hand.includes('${outboundEndpointLine(endpoint, FS.localPlay?.wideLand?.targets)}'));
  assert.match(hand, /いちばん近い開いた州は \$\{o\.nearest\.p\},\$\{o\.nearest\.q\}/);
});

test('L5-5: an opened expedition is no longer tagged "waiting for the seal"', async () => {
  const H = await import('../../permutation-server/web/frontier/map/hostmarks.mjs');
  setLang('ja');
  assert.equal(H.markerTagText({ arrived: false, arriveBell: 270 }), H.marchTagText(270));
  assert.equal(H.markerTagText({ arrived: true, arriveBell: 270 }), H.awaitKeyText());
  assert.equal(H.markerTagText({ arrived: true, revealed: true, arriveBell: 270 }), H.revealedWaitText());
  assert.match(H.revealedWaitText(), /封は開きました/); assert.doesNotMatch(H.revealedWaitText(), /開封を待って/);
  const { ownMarches } = await import('../../permutation-server/web/frontier/map/board.mjs');
  const exp = stage => ({ expedition: { stage, dest: { p: -68, q: -61, tile: 30 }, origin: { p: -68, q: -60, tile: 12 }, arriveBell: 270, host: '7' }, transit: { departBell: 267, hostId: 7n } });
  const rows = ownMarches({ nowBell: 280, marches: [exp('revealed'), exp('arrived')] });
  assert.deepEqual(rows.map(r => [r.arrived, r.revealed]), [[true, true], [true, false]]);
  assert.ok(src('map/fmap.mjs').includes('markerTagText(k.m), { zoom: z, place: \'above\''));
  setLang('en');
  try { assert.match(H.revealedWaitText(), /the seal is open/); } finally { setLang('ja'); }
});

test('L5-7: while the first host forms, the pill says the wait and a press for meanwhile is 「待つ間に：…」', async () => {
  const { nextThing } = await import('../../permutation-server/web/frontier/hud/hud.mjs');
  setLang('ja');
  const guide = { n: 2, total: 7, title: '軍勢を編成する', text: 'x', go: { act: 'cg-go', data: { pop: 'build' }, label: '建設をひらく', aside: true }, wait: '軍勢の整列を待つ' };
  const nx = nextThing({ mode: 'play' }, { guide, items: [] });
  assert.equal(nx.short, '軍勢の整列を待つ'); assert.equal(nx.label, '待つ間に：建設をひらく'); assert.equal(nx.kicker, 'ガイド 2/7');
  // (verify-pr268: the name a screen reader hears says the wait the pill shows — WCAG 2.5.3 label in name)
  assert.match(nx.text, /^ガイド 2\/7：軍勢の整列を待つ（待つ間に：建設をひらく）$/);
  assert.match(nx.hint, /^軍勢の整列を待つ — x$/);
  // a step's own press is unchanged
  const own = nextThing({ mode: 'play' }, { guide: { n: 3, total: 7, title: '進軍する', go: { act: 'cg-go', data: { pop: 'keeps' }, label: '届く砦を見る' } }, items: [] });
  assert.deepEqual([own.short, own.label], ['届く砦を見る', '届く砦を見る']);
  const cg = src('screens/conquestguide.mjs');
  assert.ok(cg.includes("go = s?.kind === 'train' ? { act: 'cg-go', data: { pop: 'train' }, label: L`兵を足す`, aside: true }"));
  assert.ok(cg.includes('wait = L`軍勢の整列を待つ`;'));
  assert.ok(cg.includes('return { id, n: g.n, total: g.total, title, text, go, wait };'));
});

test('L5-10: the 軍勢 tab shows the exploration card only with a scout or an exploration', async () => {
  const { exploreRelevant } = await import('../../permutation-server/web/frontier/screens/explore.mjs');
  const { SCOUT } = await import('../../permutation-server/web/frontier/fland.mjs');
  const FS = { holdings: [{ p: 0, q: 0, site: 1, explore: { state: 0 } }], activeHolding: 0 };
  assert.equal(exploreRelevant(FS, [{ unit: 0 }]), false, 'a spearman host only: no exploration card');
  assert.equal(exploreRelevant(FS, [{ unit: 0 }, { unit: SCOUT }]), true, 'a scout host');
  assert.equal(exploreRelevant({ ...FS, explore: { host: { id: 1 } } }, []), true, 'an exploration being chosen');
  assert.equal(exploreRelevant({ holdings: [{ p: 0, q: 0, site: 1, explore: { state: 1, bell: 3 } }], activeHolding: 0 }, []), true, 'an exploration under way');
  assert.ok(src('app.mjs').includes("exploreScreen.exploreRelevant(FS, hostScreen.hostRows(FS)) ? exploreScreen.render(FS) : ''"));
});

test('B-13: an illustrated icon that failed to load is asked again (retry mark, both src and srcset), then gives way to the sprite glyph', async () => {
  const { watchArtIcons, ART_RETRIES } = await import('../../permutation-server/web/frontier/hud/icons.mjs');
  let handler = null; const timers = [];
  const doc = { addEventListener: (k, f, cap) => { assert.equal(k, 'error'); assert.equal(cap, true); handler = f; }, removeEventListener: () => { handler = null; },
    createElement: () => { const t = { content: { firstChild: null } }; Object.defineProperty(t, 'innerHTML', { set(v) { t.content.firstChild = { html: v }; } }); return t; } };
  const attrs = { src: 'art/ui/illustrated/food-32.webp', srcset: 'art/ui/illustrated/food-32.webp 1x, art/ui/illustrated/food-64.webp 2x' };
  let replaced = null;
  const img = { tagName: 'IMG', className: 'ic ic-art ic-art-food res-ic res-c-Food', classList: { contains: c => c === 'ic-art' }, dataset: {}, isConnected: true,
    getAttribute: k => attrs[k], setAttribute: (k, v) => { attrs[k] = v; }, replaceWith: x => { replaced = x; } };
  const stop = watchArtIcons(doc, { later: (f, ms) => timers.push([f, ms]) });
  for (let i = 1; i <= ART_RETRIES; i++) {
    handler({ target: img }); assert.equal(timers.length, i); timers[i - 1][0]();
    assert.equal(attrs.src, `art/ui/illustrated/food-32.webp?r=${i}`);
    assert.equal(attrs.srcset, `art/ui/illustrated/food-32.webp?r=${i} 1x, art/ui/illustrated/food-64.webp?r=${i} 2x`);
  }
  handler({ target: img });
  assert.match(replaced.html, /^<svg class="ic res-ic res-c-Food" aria-hidden="true" focusable="false"><use href="art\/ui\/icons\.svg#grain"\/><\/svg>$/);
  handler({ target: { tagName: 'IMG', classList: { contains: () => false } } });   // (another picture: not ours)
  assert.equal(timers.length, ART_RETRIES);
  stop(); assert.equal(handler, null);
  assert.ok(src('app.mjs').includes('watchArtIcons(globalThis.document);'));
});
