// Lane B (2026-11-16), in a real browser on the keyless screens fixture (no chain, no key, no relay): rounds 35–38 and 49
// made a map tap with the March card open say why the selected host cannot set out, ONCE, where a person can see it
// (the host's own tag when it says the same words, else the tapped tile's note). Those rounds checked NotResident only.
// This file checks every other reason the page's march check (hud/subject.mjs marchCheck) can give for a host in hand:
// Forming, HostInTransit, NotFinal, HostBusy, Stamina, Resting, MarchSlots — and NotResident again, as the baseline —
// in English and Japanese at 1440 wide (the phone width is deferred by the owner).
// Test-only, in this page: after the March card is open, the host's own records in the page's memory are put in the
// state that gives the reason (its province entry, its province, or its village's record) and held there for the tap;
// the fixture's files are not changed. Nothing can be sent — the check counts every non-GET request. The tap is a mouse
// click at the tile's position on screen (computed, as in local-march-maptap); a fixture check, not evidence of an
// unaided press. Run from this folder: node --test march-block-reasons.screen.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import * as NK from './ws07/nokey-page.mjs';
import { LATEST_UNIX, HOME } from './world.mjs';

let srv, browser, base;
before(async () => {
  srv = await startServer({ keyless: true });
  srv.stage('holding');
  const port = Number(new URL(srv.url).port);
  base = NK.pageBase(port);
  browser = await chromium.launch(NK.launchOptions(port));
});
after(async () => { await browser?.close(); await srv?.close(); });

async function tileAt(page, at) {
  await page.evaluate(async () => {
    if (window.__map) return;
    const { FrontierMap } = await import('/frontier/map/fmap.mjs');
    const P = FrontierMap.prototype, draw = P.draw;
    P.draw = function (...a) { window.__map = this; return draw.apply(this, a); };
    for (let i = 0; i < 80 && !window.__map; i++) { window.dispatchEvent(new Event('resize')); await new Promise(r => setTimeout(r, 50)); }
  });
  return page.evaluate(async at => {
    const m = window.__map, frame = () => new Promise(r => requestAnimationFrame(r));
    for (let still = 0, i = 0; still < 10 && i < 400; i++) { await frame(); still = m.cam.moving || m.reachFly ? 0 : still + 1; }
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const h = tileHex(at.p, at.q, at.tile), c = project(h.q, h.r);
    return m.project(c.x, c.y);
  }, at);
}

/** Passable tiles of the home province two hexes or more from the village, nearest first. */
async function passableTiles(page) {
  return page.evaluate(async ([p, q, from]) => {
    const { tileHex } = await import('/frontier/fgeo.mjs');
    const { project } = await import('/map.mjs');
    const { kernel } = await import('/frontier/wasm.mjs');
    const { FS } = await import('/frontier/fstate.mjs');
    const k = await kernel();
    const seed = FS.record.rings.find(r => r.d === 2).seed;
    const g = k.call('generate_province', { ring_seed: Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), p, q }).value;
    const at = i => (h => project(h.q, h.r))(tileHex(p, q, i)), a = at(from), h0 = tileHex(p, q, from);
    const hexes = i => { const h = tileHex(p, q, i), dq = h.q - h0.q, dr = h.r - h0.r; return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2; };
    const out = [];
    for (let i = 0; i < 61; i++) if (hexes(i) >= 2 && ((BigInt(g.passableMask) >> BigInt(i)) & 1n)) out.push({ tile: i, d: Math.hypot(at(i).x - a.x, at(i).y - a.y) });
    return out.sort((x, y) => x.d - y.d).map(x => x.tile);
  }, [HOME.p, HOME.q, HOME.tile]);
}

// Every reason the march check can give for a host in hand (hud/subject.mjs marchCheck; fland.mjs actionBlocks for
// 'Depart'), and how this test makes it in the page's memory. Not here: 'HostBusy' for a missing host (no host, no
// tag, no tap) and 'NoTicket' (a host in hand always has its village) — see the lane's doc.
const REASONS = [
  { code: 'NotResident', where: 'province', patch: 'behind' },
  { code: 'Forming', where: 'entry', patch: 'forming' },
  { code: 'HostBusy', where: 'entry', patch: 'pending' },
  { code: 'Stamina', where: 'entry', patch: 'tired' },
  { code: 'Resting', where: 'entry', patch: 'resting' },
  { code: 'HostInTransit', where: 'holding', patch: 'away' },
  { code: 'NotFinal', where: 'holding', patch: 'notFinal' },
  { code: 'MarchSlots', where: 'holding', patch: 'slotsFull' },
];
// Page defects found by this file at round 49 (68e8548d), recorded with file:line and a proposed patch in
// docs/integration/CLAUDE-LANE-B-BLOCK-REASONS-20261116.md. Their tests run and report as todo; they do not fail the
// file. STRICT=1 runs them as ordinary tests: they fail until the page is fixed, then this list is emptied.
//   D1: two different sentences in sight for one block — the host's tag says the map's own wording (map/actions.mjs
//       blockText: Cooldown, TransitState, the program's HostInTransit / NotFinal) and the tapped tile says the march
//       check's (hud/subject.mjs marchCheck); the two are the same words only for NotResident and HostBusy
//   D2: a forming host is no actor on the map (map/actions.mjs actorsAt skips state 2): the tap selects the tile, drops
//       the host from the hand and says nothing — the fall-through round 35 fixed for NotResident
const KNOWN = process.env.STRICT ? {} : {
  Stamina: 'D1 (lane B doc)', Resting: 'D1 (lane B doc)', MarchSlots: 'D1 (lane B doc)', HostInTransit: 'D1 (lane B doc)', NotFinal: 'D1 (lane B doc)',
  Forming: 'D2 (lane B doc)',
};
const JA = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\b(settle|settled|settles|settling|keeper|keepers|beacon|beacons|seed|seeds)\b/i;

for (const R of REASONS) for (const lang of ['en', 'ja']) test(`lane B (${lang} @ 1440): March card open, ${R.code} — a map tap says why once, in sight, and sends nothing`, { timeout: 150_000, todo: KNOWN[R.code] ?? false }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: lang === 'en' ? 'en-GB' : 'ja-JP', timezoneId: 'UTC' });
  await NK.prepare(ctx, srv.viewer, { lang });
  const page = await ctx.newPage();
  const errors = [], posts = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  try {
    await page.clock.setFixedTime(new Date(LATEST_UNIX * 1000 + 500));
    await page.goto(`${base}/frontier/index.html?at=${HOME.p},${HOME.q},${HOME.tile},1.0`);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
    await page.locator('#frontier-map[data-lod="tile"]').waitFor();
    const home = await tileAt(page, HOME);
    await page.mouse.move(home.x, home.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    await page.locator('#hand [data-hand="build"]').waitFor();
    await page.locator('#hand .hand-chip[data-host]:not(.hand-back)', { hasText: /Spear|槍兵/ }).first().click();
    await page.locator('#hand [data-hand="march"][aria-pressed="true"]').waitFor();
    await page.locator('#hand [data-hand="march"]').click();
    await page.waitForFunction(() => document.getElementById('hand-pop')?.dataset.pop === 'march');
    // a tile a person sees beside the card and the bar (the topmost element at its place is the map's canvas)
    let pt = null;
    for (const t of await passableTiles(page)) {
      const q = await tileAt(page, { ...HOME, tile: t });
      if (q.x > 24 && q.x < 1416 && q.y > 140 && await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS', [q.x, q.y])) { pt = q; break; }
    }
    assert.ok(pt, 'a tile in sight beside the card');
    // (test-only, in this page: the host's own records put in the state that gives the reason, and held there for the
    //  tap — a getter keeps the patched record in place even if a read writes it again)
    const at = await page.evaluate(async R => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const H = await import('/frontier/hud/hand.mjs');
      const sub = H.subjectOf(FS), host = sub.host, key = `${host.p},${host.q}`, id = String(host.id), bell = FS.nowBell;
      const entry = {
        forming: e => ({ ...e, state: 2 }),
        pending: e => ({ ...e, pendOp: 1 }),
        tired: e => ({ ...e, staminaValue: 10, staminaBell: bell }),
        resting: e => ({ ...e, readyBell: bell + 3 }),
      }[R.patch];
      if (R.where === 'province' || R.where === 'entry') {
        const map = FS.provinces, get = map.get.bind(map), memo = new WeakMap();
        const patch = env => {
          if (!env) return env;
          if (!memo.has(env)) memo.set(env, R.where === 'province'
            ? { ...env, province: { ...env.province, resolvedNext: bell - 3 } }
            : { ...env, province: { ...env.province, entries: env.province.entries.map(e => (String(e.id) === id ? entry(e) : e)) } });
          return memo.get(env);
        };
        map.get = k => (k === key ? patch(get(k)) : get(k));
      } else {
        const hp = host.holding.p, hq = host.holding.q, ht = host.holding.tile, memo = new WeakMap();
        const one = h => {
          if (R.patch === 'notFinal') return { ...h, state: 1, finalTs: '9999999999' };
          if (R.patch === 'away') return { ...h, transit: h.transit.map((t, i) => (i === 0 ? { ...t, state: 1, hostId: id } : t)) };
          return { ...h, transit: h.transit.map(t => ({ ...t, state: 1, hostId: '987654321987' })) };
        };
        const patch = list => {
          if (!Array.isArray(list)) return list;
          if (!memo.has(list)) memo.set(list, list.map(h => (h.p === hp && h.q === hq && h.tile === ht ? one(h) : h)));
          return memo.get(list);
        };
        let under = FS.holdings;
        Object.defineProperty(FS, 'holdings', { configurable: true, enumerable: true, get: () => patch(under), set: v => { under = v; } });
      }
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 300));
      const now = H.subjectOf(FS);
      const mc = H.marchCheck(FS, now.host);
      return { host: String(now.host.id), code: mc.code, text: mc.text, pop: document.getElementById('hand-pop')?.dataset.pop ?? '' };
    }, R);
    assert.equal(at.code, R.code, `the page's march check gives ${R.code}`);
    assert.equal(at.pop, 'march', 'the March card is still open');
    // the sentence is in the viewer's language (British English has no Japanese in it; the Japanese has it)
    if (lang === 'ja') assert.match(at.text, JA, `Japanese: ${at.text}`);
    else { assert.doesNotMatch(at.text, JA, `English, not Japanese: ${at.text}`); assert.doesNotMatch(at.text, BANNED_EN, `no banned word: ${at.text}`); }
    await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await page.evaluate(async () => {
      const { FS } = await import('/frontier/fstate.mjs');
      const { subjectOf } = await import('/frontier/hud/hand.mjs');
      const n = FS.mapNote, sub = subjectOf(FS);
      return { note: n ? String(typeof n.say === 'function' ? n.say() : n.text ?? '') : null, compose: !!FS.compose, hand: sub?.kind === 'host' ? String(sub.host.id) : sub?.kind ?? null };
    });
    assert.equal(after.compose, false, 'no order drafted');
    assert.equal(after.hand, at.host, `the host stays in hand (${JSON.stringify(after)})`);
    assert.equal(after.note, at.text, 'the tap answers with the march check\'s own reason');
    // Read from the canvas: every drawn text that is a reason a march can be refused for — this one's sentence, and every
    // other code's sentence in either wording the page has (hud/orderparts.mjs whyText, fi18n.mjs errorText; the map's own
    // tag also says Cooldown and TransitState: map/actions.mjs actorsAt) — grouped by
    // animation frame, with whether its place is in sight (the topmost element there is a canvas)
    const drawn = await page.evaluate(async said => {
      const { whyText } = await import('/frontier/hud/orderparts.mjs');
      const { errorText } = await import('/frontier/fi18n.mjs');
      const codes = ['NotResident', 'Forming', 'HostBusy', 'Stamina', 'Resting', 'HostInTransit', 'NotFinal', 'MarchSlots', 'NoTicket', 'Cooldown', 'TransitState'];
      const reasons = new Set([said]);
      for (const c of codes) { try { const w = whyText(c, { stamina: 0, need: 0, turn: 0 }); if (w && !/\d/.test(w)) reasons.add(w); } catch {} try { const e = errorText(c); if (e) reasons.add(e); } catch {} }
      const isReason = t => reasons.has(t) || (/\d/.test(t) && t === said);
      const rows = [];
      let frame = 0, on = true;
      const tick = () => { frame += 1; if (on) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const protos = [globalThis.CanvasRenderingContext2D?.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean);
      const kept = protos.map(P => P.fillText);
      const seen = (g, x, y) => {
        const cv = g.canvas;
        if (!cv?.getBoundingClientRect) return false;
        const b = cv.getBoundingClientRect(), m = g.getTransform().transformPoint(new DOMPoint(x, y));
        const cx = b.left + m.x * (b.width / cv.width), cy = b.top + m.y * (b.height / cv.height);
        return document.elementFromPoint(cx, cy)?.tagName === 'CANVAS';
      };
      protos.forEach((P, i) => { P.fillText = function (t, x, y, ...r) { const s = String(t); if (isReason(s)) rows.push({ frame, text: s, y: Math.round(y), seen: seen(this, x, y) }); return kept[i].call(this, t, x, y, ...r); }; });
      const { invalidate } = await import('/frontier/fstate.mjs');
      invalidate('map');
      await new Promise(r => setTimeout(r, 450));
      on = false; protos.forEach((P, i) => { P.fillText = kept[i]; });
      const frames = [...new Set(rows.map(r => r.frame))];
      const per = f => rows.filter(r => r.frame === f && r.seen);
      const places = f => new Set(per(f).map(r => `${r.y}`)).size;
      const own = f => new Set(per(f).filter(r => r.text === said).map(r => `${r.y}`)).size;
      return {
        calls: rows.length, frames: frames.length,
        ownFewest: Math.min(...frames.map(own)), ownMost: Math.max(0, ...frames.map(own)),
        placesMost: Math.max(0, ...frames.map(places)),
        texts: [...new Set(rows.filter(r => r.seen).map(r => r.text))],
      };
    }, at.text);
    const detail = JSON.stringify(drawn);
    assert.ok(drawn.calls > 0, `the reason is drawn on the map (${detail})`);
    assert.equal(drawn.ownFewest, 1, `in every frame the reason is said at a place in sight (${detail})`);
    assert.equal(drawn.ownMost, 1, `in no frame is it said at two places in sight (${detail})`);
    assert.equal(drawn.placesMost, 1, `in no frame does a second sentence for a refusal stand in sight beside it (${detail})`);
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/block-${R.code}-${lang}-1440.png` });
    // (NotResident only: the page's own catch-up request for a lagging province, made by an ordinary session whenever it
    //  sees one — not an order; the test held the province behind)
    assert.deepEqual(posts.filter(x => !(R.code === 'NotResident' && x.endsWith('/f/nudge'))), [], 'nothing was sent');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
