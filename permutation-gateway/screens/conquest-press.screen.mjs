// The real page, the fixture's live sample world (Chromium; no chain, no key): what a person meets on the way from a
// fort's row to the seal, checked with person-like presses (mouse down, a hold, mouse up at the control's centre; no
// state-watch timing, no retry, no coordinates measured in the middle of a press). Rounds 16–18 (2026-11-14):
//   * the fort card's rows stay where they are when its settling wait line comes and goes (round 16, .kh-wait-slot);
//   * a press on a fort's row survives the card being written again between down and up (round 17a, hand press gates):
//     the click fires on the row the press began on, and the held write runs after the release;
//   * an order being written is shown before the first village's welcome (round 18, hud/drawer.mjs).
// The fixture's world is a sample with no keeps, so the test gives the page a conquest season and one fort row for one
// of the viewer's hosts IN THE PAGE (FS) — the card, its styles and the page's own redraws are the real ones. Nothing
// here is sent to any world. Everything observed goes to $CONQUEST_PRESS_OUT (default: the system temp dir).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import { storageFor } from './world.mjs';

const OUT = process.env.CONQUEST_PRESS_OUT ?? path.join(tmpdir(), 'wylls-conquest-press');
mkdirSync(OUT, { recursive: true });
let browser, srv;
before(async () => { srv = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

/** The play page at the fixture's `holding` stage, with one of the viewer's hosts holding a one-row fort card. */
async function openForts(t, name) {
  srv.stage('holding');
  srv.live(true, { turn: 20, delay: 8 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
  await context.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storageFor(srv.viewer, { stage: 'holding', lang: 'en' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); srv.live(false); });
  await page.goto(`${srv.url}/frontier/index.html`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  // (the viewer's provinces are read a moment after the page stands: wait for one with a host of the viewer)
  await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs');
    for (let i = 0; i < 120; i++) { if ([...FS.provinces.values()].some(e => (e.province?.entries ?? []).some(x => x.state === 1))) return true; await new Promise(r => setTimeout(r, 250)); }
    return false; });
  const host = await page.evaluate(async () => {
    const { FS, invalidate } = await import('/frontier/fstate.mjs');
    const pv = [...FS.provinces.values()].map(e => e.province).find(p => (p.entries ?? []).some(e => e.state === 1));
    const e = pv?.entries.find(x => x.state === 1);
    if (!e) return null;
    // (test-only, in this page: a conquest season, so the fort card exists, and one fort row for this host)
    FS.sample = false; FS.season = { ...FS.season, programVersion: 3, conquestParams: { keepBells: 72 } };
    const fort = { p: pv.p + 2, q: pv.q, tile: 26, holder: 5, troops: 100 };
    FS.conquest = { status: 'ready', keeps: new Map(), history: new Map(), events: [], standings: null, final: null,
      hostReach: { key: 'test', host: String(e.id), ok: true, unreachable: [], rows: [{ ...fort, route: { hexes: 12, provinces: [0, 1], secs: 1200 } }] } };
    FS.selected = { p: pv.p, q: pv.q, idx: e.tile };
    FS.hand = { host: String(e.id), pop: 'keeps' };
    invalidate('panel', 'map');
    return { id: String(e.id), p: pv.p, q: pv.q };
  });
  assert.ok(host, 'a host of the viewer stands in the fixture');
  await page.waitForSelector('#hand-pop .kh-row', { timeout: 10_000 });
  await page.evaluate(() => {
    globalThis.__ev = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, e => {
      const t = e.target instanceof Element ? e.target : null;
      globalThis.__ev.push({ type: e.type, t: Math.round(performance.now()), act: t?.closest('[data-act]')?.dataset.act ?? null, row: !!t?.closest('.kh-row'), connected: !!t?.isConnected });
    }, true);
    globalThis.__rows = []; let node = document.querySelector('#hand-pop .kh-row');
    clearInterval(globalThis.__rowTimer);
    globalThis.__rowTimer = setInterval(() => { const n = document.querySelector('#hand-pop .kh-row'); if (n && n !== node) { globalThis.__rows.push(Math.round(performance.now())); node = n; } }, 10);
  });
  return { page, errors, host, name };
}
const rowBox = page => page.evaluate(() => { const q = s => document.querySelector(s)?.getBoundingClientRect(); const r = q('#hand-pop .kh-row'); const slot = q('#hand-pop .kh-wait-slot'), line = q('#hand-pop .kh-wait-slot > .kh-wait-line'), pop = q('#hand-pop');
  return r ? { x: r.left + r.width / 2, y: Math.round(r.top), h: Math.round(r.height), slotH: slot ? Math.round(slot.height) : null, lineH: line ? Math.round(line.height) : null, popTop: pop ? Math.round(pop.top) : null, popH: pop ? Math.round(pop.height) : null, handH: Math.round(document.getElementById('hand')?.getBoundingClientRect().height ?? -1), handKids: [...(document.getElementById('hand')?.children ?? [])].map(c => `${c.className}:${Math.round(c.getBoundingClientRect().height)}`), handText: (document.getElementById('hand')?.innerText ?? '').slice(0, 300) } : null; });
async function failed(page, name, e) {
  await page.screenshot({ path: path.join(OUT, `${name}-failed.png`), fullPage: true }).catch(() => {});
  writeFileSync(path.join(OUT, `${name}-failed.html`), await page.content().catch(() => ''));
  throw e;
}

test('round 16: the fort row stays where it is when the settling wait line comes and goes', async t => {
  const { page, host, name } = await openForts(t, 'row-stays');
  try {
    const before = await rowBox(page);
    assert.ok(before, 'the fort row is on screen');
    const slot = await page.evaluate(() => !!document.querySelector('#hand-pop .kh-wait-slot'));
    assert.equal(slot, true, 'the wait slot is there even without a wait');
    // the host's province falls two turns behind: the card says it is settling (the line comes)
    const said = await page.evaluate(async h => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const env = FS.provinces.get(`${h.p},${h.q}`); env.province = { ...env.province, resolvedNext: FS.nowBell - 3 };
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 600));
      return !!document.querySelector('#hand-pop .kh-wait-slot > .kh-wait-line');
    }, host);
    assert.equal(said, true, 'the settling line is said');
    const during = await rowBox(page);
    // and goes again
    const gone = await page.evaluate(async h => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const env = FS.provinces.get(`${h.p},${h.q}`); env.province = { ...env.province, resolvedNext: FS.nowBell };
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 600));
      return !document.querySelector('#hand-pop .kh-wait-slot > .kh-wait-line');
    }, host);
    const after = await rowBox(page);
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ before, during, after, gone }, null, 2)}\n`);
    assert.equal(during.y, before.y, `the row did not move when the line came (${before.y} → ${during.y})`);
    // both ways are required: the wait must really go again, and the row must be where it was
    assert.equal(gone, true, 'the settling line went again once the province was in step');
    assert.equal(after.y, before.y, `nor when it went (${before.y} → ${after.y})`);
  } catch (e) { await failed(page, name, e); }
});

test('round 17a: a press on a fort row survives the card being written again between down and up', async t => {
  const { page, name } = await openForts(t, 'row-press');
  try {
    const at = await rowBox(page);
    await page.mouse.move(at.x, at.y + at.h / 2 - 4);
    await page.mouse.down();
    // while the button is down, the card's content changes (the fort's garrison), so the page writes the card again
    await page.evaluate(async () => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      FS.conquest.hostReach = { ...FS.conquest.hostReach, rows: FS.conquest.hostReach.rows.map(r => ({ ...r, troops: r.troops + 37 })) };
      invalidate('panel', 'map');
    });
    await page.waitForTimeout(400);
    const heldDuring = await page.evaluate(() => globalThis.__rows.length);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const ev = await page.evaluate(() => ({ events: globalThis.__ev, replaced: globalThis.__rows }));
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ heldDuring, ...ev }, null, 2)}\n`);
    assert.equal(heldDuring, 0, 'the row was not replaced while it was pressed');
    const click = ev.events.find(e => e.type === 'click');
    assert.ok(click && click.act === 'cq-march' && click.row, `the click fired on the row: ${JSON.stringify(click)}`);
    assert.ok(ev.replaced.length >= 1, 'the held write ran after the release (the new garrison is shown)');
  } catch (e) { await failed(page, name, e); }
});

test('round 18: an order being written is shown before the first village\'s welcome, which comes back after', async t => {
  const { page, host, name } = await openForts(t, 'order-first');
  try {
    const kinds = await page.evaluate(async h => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const { drawerOf } = await import('/frontier/hud/drawer.mjs');
      const { ACTIONS } = await import('/frontier/controller.mjs');
      FS.homeGrant = FS.holdings?.[0] ?? { p: h.p, q: h.q };
      FS.hand = { host: h.id };
      ACTIONS.compose({ host: h.id, stay: 'map' });
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 400));
      const withOrder = { kind: drawerOf(FS)?.kind, order: !!document.querySelector('section.order') };
      FS.compose = null; invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 400));
      const after = { kind: drawerOf(FS)?.kind, order: !!document.querySelector('section.order') };
      return { withOrder, after };
    }, host);
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(kinds, null, 2)}\n`);
    assert.deepEqual(kinds.withOrder, { kind: 'march', order: true }, 'the order card is shown, not hidden behind the welcome');
    assert.equal(kinds.after.kind, 'home', 'the welcome comes back once the order is set aside');
  } catch (e) { await failed(page, name, e); }
});

test('round 20: the fort row stays where it is when a forming host stands (its longer forming line goes away)', async t => {
  const { page, host, name } = await openForts(t, 'row-stands');
  try {
    // the host formed this turn: it stands from the next turn (state 2), so the card says the forming line
    const forming = await page.evaluate(async h => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const env = FS.provinces.get(`${h.p},${h.q}`);
      env.province = { ...env.province, resolvedNext: FS.nowBell, entries: env.province.entries.map(e => String(e.id) === h.id ? { ...e, state: 2, fromBell: FS.nowBell + 1 } : e) };
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 600));
      return document.querySelector('#hand-pop .kh-wait-slot > .kh-wait-line')?.textContent ?? null;
    }, host);
    const during = await rowBox(page);
    // it stands (state 1, in step): no wait any more
    const stood = await page.evaluate(async h => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      const env = FS.provinces.get(`${h.p},${h.q}`);
      env.province = { ...env.province, resolvedNext: FS.nowBell, entries: env.province.entries.map(e => String(e.id) === h.id ? { ...e, state: 1, fromBell: FS.nowBell - 1 } : e) };
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 600));
      return !document.querySelector('#hand-pop .kh-wait-slot > .kh-wait-line');
    }, host);
    const after = await rowBox(page);
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ forming, during, after, stood }, null, 2)}\n`);
    assert.ok(forming, 'the forming line was said');
    assert.equal(stood, true, 'the host stood and the line went');
    assert.equal(after.y, during.y, `the row did not move when the host stood (${during.y} → ${after.y})`);
    assert.equal(after.handH, during.handH, `the bar under the card kept its height (${during.handH} → ${after.handH}): the jump did not move to the bar`);
    assert.equal(await page.evaluate(() => document.querySelector('#hand-pop .kh-wait-ghost')?.getAttribute('aria-hidden') === 'true' && document.querySelector('#hand-pop .kh-wait-ghost')?.hasAttribute('inert')), true, 'the stand-in stays hidden from readers and inert');
  } catch (e) { await failed(page, name, e); }
});

test('round 20: at 1280 px in English with the first village\'s drawer open, a host bar with every button fits in the bar and on the screen', async t => {
  const { page, name } = await openForts(t, 'bar-fits');
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // (the local play program's version: the bar also offers the read-only expedition and the boundary route)
    const box = await page.evaluate(async () => {
      const { FS, invalidate } = await import('/frontier/fstate.mjs');
      FS.season = { ...FS.season, programVersion: 0x4804 };
      // (the first village's welcome stands in the drawer, as on a new player's first turns: the bar has less room)
      FS.homeGrant = FS.holdings?.[0] ?? FS.homeGrant;
      FS.hand = { host: FS.hand.host };
      invalidate('panel', 'map');
      await new Promise(r => setTimeout(r, 600));
      const bar = document.getElementById('hand');
      const buttons = [...(bar?.querySelectorAll('.hand-acts > *') ?? [])].map(b => { const r = b.getBoundingClientRect(); return { text: b.innerText.split('\n')[0], left: Math.round(r.left), right: Math.round(r.right) }; });
      return { drawer: document.body.dataset.drawer ?? null, width: innerWidth, bar: bar ? Math.round(bar.getBoundingClientRect().right) : null, barLeft: bar ? Math.round(bar.getBoundingClientRect().left) : null, buttons };
    });
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(box, null, 2)}\n`);
    assert.ok(box.buttons.length >= 5, `the host bar is shown (${box.buttons.length} buttons)`);
    assert.equal(box.drawer, 'open', 'the drawer is open');
    // inside the screen, and inside the bar itself (a button outside its bar was cut off by the screen's edge in the world)
    const out = box.buttons.filter(b => b.right > box.width || b.left < 0 || b.right > box.bar + 1 || b.left < box.barLeft - 1);
    assert.deepEqual(out, [], `every button is inside the bar (${box.barLeft}–${box.bar}) and the ${box.width} px screen`);
  } catch (e) { await failed(page, name, e); }
});
