// Two ordinary PC screens on the keyless fixture (no chain, no key, no relay, no world; a FIXTURE REPLAY of page state,
// not a real world), English and Japanese at 1440 × 900, through the page's own map renderer and cards:
//  A. the land preview's layer: a tile of the home province held by another nation (with the viewer's take count running
//     on it), then the same tile the viewer's nation's — the map's own canvases change colour towards the viewer's
//     nation, the selected tile's card says who holds it (and the take count), and the strip's land chip counts it;
//  B. a host away on a march: the village's tag says it is on the march and its arrival turn, then that it has arrived.
// Test-only, in this page's memory: A sets the home province's land record (built with the page's own LAND layout and
// parsed by its own parseLand); B keeps the fixture's lead host as it is (already on a sealed march, 'away') and gives the
// march book that host's transit with no route and an arrival turn, as a march of another browser looks. The fixture's files are not changed; every
// non-GET request is counted (none allowed). Run from this folder: node --test land-arrival.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX, HOME } from './world.mjs';

const JA = /[぀-ヿ㐀-鿿]/;
let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

async function open(lang) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: lang === 'en' ? 'en-GB' : 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
  await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  await page.locator('#frontier-map[data-lod="tile"]').waitFor();
  await page.evaluate(async () => {
    const { FrontierMap } = await import('/frontier/map/fmap.mjs');
    const P = FrontierMap.prototype, draw = P.draw;
    P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
    for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
  });
  return { ctx, page, errors, posts };
}

const settle = page => page.evaluate(async () => {
  const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
  for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
});

/** The screen point of tile (p, q, i) and whether the topmost element there is a map canvas. */
const pointOf = (page, at) => page.evaluate(async at => {
  const { tileHex } = await import('/frontier/fgeo.mjs');
  const { project } = await import('/map.mjs');
  const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r), s = window.__map.project(c.x, c.y);
  return { ...s, canvas: document.elementFromPoint(s.x, s.y)?.tagName === 'CANVAS' };
}, at);

// ------------------------------------------------------------------ A. the land layer
for (const lang of ['en', 'ja']) test(`land layer (${lang} @ 1440): another nation's tile, then the viewer's — colour, card, chip (fixture replay)`, { timeout: 150_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang);
  try {
    await settle(page);
    // a passable tile of the home province, 2+ hexes from the village, in sight
    const tiles = await page.evaluate(async ([p, q, from]) => {
      const { tileHex } = await import('/frontier/fgeo.mjs');
      const { kernel } = await import('/frontier/wasm.mjs');
      const { FS } = await import('/frontier/fstate.mjs');
      const k = await kernel();
      const seed = FS.record.rings.find(r => r.d === 2).seed;
      const g = k.call('generate_province', { ring_seed: Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), p, q }).value;
      const h0 = tileHex(p, q, from), hexes = i => { const h = tileHex(p, q, i), dq = h.q - h0.q, dr = h.r - h0.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
      // (open ground only: not the keep's tile nor a village's — their sprites stand over the land wash)
      const env = FS.provinces.get(`${p},${q}`), pv = env?.province;
      const { keepFromProvince } = await import('/frontier/fconquest.mjs');
      let keep = null; try { keep = keepFromProvince(pv)?.tile ?? null; } catch { keep = null; }
      const sites = new Set((pv?.siteMirror ?? []).filter(x => x && x.state !== 0 && Number.isInteger(x.tile)).map(x => x.tile));
      const out = [];
      for (let i = 1; i < 61; i++) if (i !== keep && !sites.has(i) && hexes(i) >= 2 && hexes(i) <= 3 && ((BigInt(g.passableMask) >> BigInt(i)) & 1n)) out.push(i);
      return out;
    }, [HOME.p, HOME.q, HOME.tile]);
    let T = null, pt = null;
    for (const t of tiles) { const q = await pointOf(page, { p: HOME.p, q: HOME.q, tile: t }); if (q.canvas && q.x > 200 && q.x < 1240 && q.y > 160 && q.y < 760) { T = t; pt = q; break; } }
    assert.ok(T !== null, 'a passable tile in sight');
    // seven points inside the tile (its centre and six at 0.45 of its radius), on screen: a sprite may stand on one
    const pts = await page.evaluate(async at => {
      const { tileHex } = await import('/frontier/fgeo.mjs');
      const { project, RADIUS } = await import('/map.mjs');
      const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r), m = window.__map;
      return [[0, 0], ...[0, 1, 2, 3, 4, 5].map(k => [Math.cos(k * Math.PI / 3) * RADIUS * 0.45, Math.sin(k * Math.PI / 3) * RADIUS * 0.45])].map(([dx, dy]) => m.project(c.x + dx, c.y + dy));
    }, { p: HOME.p, q: HOME.q, tile: T });

    // set the home province's land record: tile T (and its province's other claimed tiles) held by `owner`
    const setLand = (owner, take) => page.evaluate(async ([p, q, T, owner, take]) => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const { LAND, parseLand } = await import('/frontier/land.mjs');
      const { toBase64 } = await import('/sdk/bytes.mjs');
      const me = FS.citizen?.faction, f = owner === 'me' ? me : (me + 1) % 6;
      const b = new Uint8Array(LAND.SIZE), dv = new DataView(b.buffer);
      b.set([...LAND.MAGIC].map(c => c.charCodeAt(0)), 0);
      dv.setUint16(LAND.VERSION, 1, true); dv.setUint32(LAND.NEXT_BELL, (FS.nowBell ?? 0) + 1, true);
      dv.setInt16(LAND.P, p, true); dv.setInt16(LAND.Q, q, true);
      b.fill(255, LAND.OWNER, LAND.OWNER + LAND.TILES); b.fill(255, LAND.BY, LAND.BY + LAND.TILES);
      b[LAND.OWNER + T] = f;
      if (take) { b[LAND.BY + T] = me; b[LAND.COUNT + T] = 71; }
      const land = parseLand({ key: `ld:${p},${q}`, bytes: toBase64(b) }, { p, q });
      const env = FS.provinces.get(`${p},${q}`);
      FS.provinces.set(`${p},${q}`, { ...env, land });
      invalidate('map', 'panel', 'hud');
      return { me, f, ok: !!land };
    }, [HOME.p, HOME.q, T, owner, take]);

    // the colour at the tile, averaged over 7 × 7 device pixels, on every 2D canvas of the page that covers it
    const sample = () => page.evaluate(P => P.flatMap(({ x, y }, k) => [...document.querySelectorAll('canvas')].map((cv, i) => {
      const b = cv.getBoundingClientRect();
      if (!b.width || x < b.left || x > b.right || y < b.top || y > b.bottom) return null;
      let g = null; try { g = cv.getContext('2d', { willReadFrequently: true }); } catch {} if (!g) return null;
      const cx = Math.round((x - b.left) * cv.width / b.width), cy = Math.round((y - b.top) * cv.height / b.height);
      const d = g.getImageData(cx - 3, cy - 3, 7, 7).data, s = [0, 0, 0, 0];
      for (let k = 0; k < d.length; k += 4) for (let j = 0; j < 4; j++) s[j] += d[k + j];
      return { i: `${k}:${i}`, rgba: s.map(v => v / 49) };
    }).filter(Boolean)), pts);

    // a baseline with no land record, then the other nation's tile: wait until the map has painted it (the first frames
    // after loading may still be the opening, and the ground layer is re-baked a few frames after a change)
    await settle(page);
    const bare = await sample();
    const theirs = await setLand('other', true);
    assert.ok(theirs.ok && Number.isInteger(theirs.me), 'the record parses');
    const differs = (a, b) => a.some(x => { const y = b.find(z => z.i === x.i); return y && Math.hypot(...[0, 1, 2].map(j => x.rgba[j] - y.rgba[j])) > 2; });
    let before = [];
    for (let i = 0; i < 20; i++) { await settle(page); await page.waitForTimeout(200); before = await sample(); if (differs(before, bare)) break; }
    const diag = differs(before, bare) ? null : await page.evaluate(async ([p, q, T]) => {
      const m = window.__map, { FS } = await import('/frontier/fstate.mjs');
      const sv = FS.survey;
      return { landKeys: [...(m.landKeys ?? [])], kept: m.kept?.landmarks ?? null, level: sv?.levelOf?.(p, q, T) ?? null, showAll: !!sv?.showAll,
        lod: document.getElementById('frontier-map')?.dataset.lod, moving: !!m.cam?.moving, piece: !!m.piece, land: !!FS.provinces.get(`${p},${q}`)?.land };
    }, [HOME.p, HOME.q, T]);
    assert.ok(differs(before, bare), `the other nation's land is painted at the tile: ${JSON.stringify({ T, pt, diag, bare, before })}`);
    const mine = await setLand('me', false);
    const colours = await page.evaluate(async ([a, b]) => { const { FACTION_COLORS } = await import('/frontier/fi18n.mjs'); return [FACTION_COLORS[a], FACTION_COLORS[b]]; }, [mine.me, theirs.f]);
    const rgb = c => { const h = String(c).replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
    const [own, other] = colours.map(rgb);
    // the map's own pixels at the tile moved towards the viewer's nation's colour, away from the other nation's (sampled
    // again every 200 ms for up to 4 s: the ground layer is re-baked a few frames after the record changes)
    const movedOf = after => after.map(a => { const b0 = before.find(x => x.i === a.i); if (!b0) return null; const d = [0, 1, 2].map(j => a.rgba[j] - b0.rgba[j]); return { i: a.i, d, dot: d.reduce((s, v, j) => s + v * (own[j] - other[j]), 0), size: Math.hypot(...d) }; }).filter(x => x && x.size > 2);
    let after = [], moved = [];
    for (let i = 0; i < 20 && !moved.some(m => m.dot > 0); i++) { await settle(page); await page.waitForTimeout(200); after = await sample(); moved = movedOf(after); }
    assert.ok(moved.length > 0, `a canvas changed at the tile (${JSON.stringify(after.map(a => a.i))})`);
    assert.ok(moved.some(m => m.dot > 0), `towards the viewer's colour: ${JSON.stringify(moved)}`);

    // the selected tile's card: the viewer's land now; then the other nation's with the viewer's take count
    await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    const own1 = lang === 'en' ? 'Your nation\'s land (territory trial)' : 'あなたの国が持つ土地（領土の試験）';
    await page.waitForFunction(t => document.body.innerText.includes(t), own1, { timeout: 10_000 });
    await setLand('other', true); await settle(page);
    const name = await page.evaluate(async f => { const { factionName } = await import('/frontier/fi18n.mjs'); return factionName(f); }, theirs.f);
    const held = lang === 'en' ? `Land held by ${name} (territory trial)` : `${name}が持つ土地（領土の試験）`;
    const taking = lang === 'en' ? /Your nation is taking it: turn 71 of 72/ : /あなたの国が奪取中：71 \/ 72 ターン/;
    await page.waitForFunction(t => document.body.innerText.includes(t), held, { timeout: 10_000 });
    assert.match(await page.evaluate(() => document.body.innerText), taking);
    // the strip's land chip counts the viewer's claimed tile in this province when it is the viewer's
    await setLand('me', false); await settle(page);
    const chip = await page.locator('#land-chip-box .land-chip').first().textContent();
    assert.match(chip, lang === 'en' ? /Fields in this province: 1 tile/ : /この州の耕地 1 マス/);
    for (const t of [chip, held]) if (lang === 'en') assert.doesNotMatch(t, JA); else assert.match(t, JA);
    assert.deepEqual(posts, [], 'nothing is sent');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

// ------------------------------------------------------------------ B. away on a march, then arrived
for (const lang of ['en', 'ja']) test(`away on a march (${lang} @ 1440): the village's tag says the arrival turn, then that it arrived (fixture replay)`, { timeout: 150_000 }, async () => {
  const { ctx, page, errors, posts } = await open(lang);
  try {
    await settle(page);
    // the fixture's lead host is already on a sealed march this browser holds no order of (map/board.mjs characterPlace
    // 'away'); the march book gets that host's transit with no route and an arrival turn, and the map draws
    // awayText(arriveBell, bell) under the village. Nothing else is changed (sealing other hosts would start the page's
    // own "host left" effect, which rightly puts the village's labels away while it plays: fx/engine.mjs hideLabelsAt).
    const setAway = delta => page.evaluate(async delta => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const { boardRecords } = await import('/frontier/map/board.mjs');
      const { awayText } = await import('/frontier/map/hostmarks.mjs');
      const place = boardRecords(FS).place, bell = FS.nowBell, arrive = bell + delta;
      if (place?.at !== 'away') return { place: place?.at ?? null };
      FS.marches = [{ transit: { hostId: BigInt(place.host), arriveBell: arrive, state: 1 } }];
      invalidate('map', 'panel', 'hud');
      return { place: place.at, arrive, bell, want: awayText(arrive, bell) };
    }, delta);
    const drawn = want => page.evaluate(async want => {
      const rows = [];
      const protos = [globalThis.CanvasRenderingContext2D?.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean);
      const kept = protos.map(P => P.fillText);
      const seen = (g, x, y) => {
        const cv = g.canvas;
        if (!cv?.getBoundingClientRect) return false;
        const b = cv.getBoundingClientRect(), m = g.getTransform().transformPoint(new DOMPoint(x, y));
        return document.elementFromPoint(b.left + m.x * (b.width / cv.width), b.top + m.y * (b.height / cv.height))?.tagName === 'CANVAS';
      };
      protos.forEach((P, i) => { P.fillText = function (t, x, y, ...r) { const s = String(t); if (s === want) rows.push(seen(this, x, y)); return kept[i].call(this, t, x, y, ...r); }; });
      const { invalidate } = await import('/frontier/fstate.mjs');
      for (let i = 0; i < 6 && !rows.some(Boolean); i++) { invalidate('map'); await new Promise(r => setTimeout(r, 500)); }
      protos.forEach((P, i) => { P.fillText = kept[i]; });
      return { calls: rows.length, inSight: rows.filter(Boolean).length };
    }, want);

    const going = await setAway(4);
    assert.equal(going.place, 'away', "the fixture's lead host is away on a sealed march");
    assert.match(going.want, lang === 'en' ? new RegExp(`turn ${going.arrive}\\b`) : new RegExp(`ターン ${going.arrive}`));
    assert.doesNotMatch(going.want, lang === 'en' ? /arrived/ : /到着 ·/);
    await settle(page);
    const g = await drawn(going.want);
    assert.ok(g.inSight > 0, `the on-the-march tag is drawn in sight: ${JSON.stringify(g)} "${going.want}"`);

    const there = await setAway(-2);
    assert.equal(there.want, lang === 'en' ? `Host arrived on turn ${there.arrive} · loading its position` : `軍勢はターン ${there.arrive} に到着 · 位置を読み込んでいます`);
    await settle(page);
    const a = await drawn(there.want);
    assert.ok(a.inSight > 0, `the arrived tag is drawn in sight: ${JSON.stringify(a)} "${there.want}"`);
    if (lang === 'en') assert.doesNotMatch(going.want + there.want, JA); else assert.match(going.want + there.want, JA);
    assert.deepEqual(posts, [], 'nothing is sent');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
