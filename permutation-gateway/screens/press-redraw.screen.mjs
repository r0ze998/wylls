// Presses and typing in the drawer while the page redraws itself (Chromium, the fixture server's live sample world:
// its clock moves, so the village's numbers change and the drawer is written again on its own; no chain, no key).
// What it watches, for a person-like press (mouse down, a hold, mouse up at the control's centre; no Playwright
// actionability waits, no retry):
//   * pointerdown / pointerup / click: the target's action, whether it is in the drawer (#panel-body: the only place
//     app.mjs makePressGate guards; the hand pop-ups are not covered), whether it is still in the page, and what the
//     element at the press point is (an overlay would show here);
//   * the drawer's redraws: the watched control's node replaced (a mark on the node), with times, and whether one ran
//     right after the release (a redraw that was held during the press);
//   * the drawer's scroll position before and after;
//   * for Build: whether the order reached the fixture world (its `orders`) or the page answered.
// Typing: one click into the troops form's count, keyboard typing, then the world's redraws while the field keeps
// the focus; the value, the focus and the form's place (not folded) must survive (screens/holding.mjs troopsOrder,
// app.mjs keepState). Everything observed, and on a failure a screenshot and the page's DOM, go to $PRESS_OUT
// (default: the system temp dir, wylls-press-redraw/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';
import { storageFor } from './world.mjs';

const OUT = process.env.PRESS_OUT ?? path.join(tmpdir(), 'wylls-press-redraw');
mkdirSync(OUT, { recursive: true });
let browser, srv;
before(async () => { srv = await startServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

async function openVillage(t, name, liveOpts = {}) {
  srv.stage('holding');
  srv.live(true, { turn: 20, delay: 8, ...liveOpts });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
  await context.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storageFor(srv.viewer, { stage: 'holding', lang: 'en' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await context.close(); srv.live(false); });
  await page.goto(`${srv.url}/frontier/index.html`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  await page.locator('#tabs [data-tab="holding"]').click();
  await page.locator('#holding-title').waitFor();
  await page.evaluate(() => {
    globalThis.__ev = [];
    const panel = () => document.getElementById('panel-body');
    const info = (e, watchSel) => {
      const t = e.target instanceof Element ? e.target : null;
      const at = Number.isFinite(e.clientX) ? document.elementFromPoint(e.clientX, e.clientY) : null;
      return { type: e.type, t: Math.round(performance.now()), act: t?.closest('[data-act]')?.dataset.act ?? t?.tagName ?? null,
        inDrawer: !!t?.closest('#panel-body'), connected: !!t?.isConnected, isWatched: !!watchSel && !!t?.closest(watchSel) && t.closest(watchSel) === document.querySelector(watchSel),
        atPoint: at ? (at.closest('[data-act]')?.dataset.act ?? at.id ?? at.tagName) : null, atPointInDrawer: !!at?.closest('#panel-body'), scroll: panel()?.scrollTop ?? null };
    };
    for (const type of ['pointerdown', 'pointerup', 'click', 'keydown']) document.addEventListener(type, e => globalThis.__ev.push(info(e, globalThis.__watchSel)), true);
    globalThis.__watch = sel => {
      globalThis.__watchSel = sel; globalThis.__rep = []; let node = document.querySelector(sel);
      clearInterval(globalThis.__watchTimer);
      globalThis.__watchTimer = setInterval(() => { const n = document.querySelector(sel); if (n && n !== node) { globalThis.__rep.push(Math.round(performance.now())); node = n; } }, 10);
    };
  });
  return { page, errors, name };
}
async function evidence(page, name, extra = {}) {
  const ev = await page.evaluate(() => ({ events: globalThis.__ev, replaced: globalThis.__rep }));
  writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify({ ...ev, ...extra }, null, 2)}\n`);
  return ev;
}
async function failed(page, name, e) {
  await page.screenshot({ path: path.join(OUT, `${name}-failed.png`), fullPage: true }).catch(() => {});
  writeFileSync(path.join(OUT, `${name}-failed.html`), await page.content().catch(() => ''));
  throw e;
}
/** A person-like press at the centre of `sel` (scrolled into view first), held `holdMs`. Returns the press's times. */
async function press(page, sel, holdMs) {
  const at = await page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel);
  if (!at) throw new Error(`no ${sel} on screen`);
  await page.waitForTimeout(100);
  const at2 = await page.evaluate(sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; }, sel) ?? at;
  await page.mouse.move(at2.x, at2.y);
  const down = await page.evaluate(() => Math.round(performance.now()));
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
  const up = await page.evaluate(() => Math.round(performance.now()));
  return { down, up };
}

test('the fixture redraws the drawer on its own (else nothing below could be shown)', async t => {
  const { page, name } = await openVillage(t, 'redraw-rate');
  try {
    await page.evaluate(() => globalThis.__watch('#hp-build'));
    await page.waitForTimeout(12_000);
    const ev = await evidence(page, name);
    assert.ok(ev.replaced.length >= 3, `the village card was replaced ${ev.replaced.length} times in 12 s`);
  } catch (e) { await failed(page, name, e); }
});

test('typing a troops count: value, focus and the form\'s place survive the drawer\'s own redraws', async t => {
  const { page, name } = await openVillage(t, 'troops-typing');
  try {
    const open = await page.evaluate(() => { const t = document.querySelector('#hp-train'), m = document.querySelector('#hp-muster'); return t && !t.closest('details:not([open])') ? 'train' : m && !m.closest('details:not([open])') ? 'muster' : null; });
    assert.ok(open, 'one troops form stands open');
    const formSel = open === 'train' ? '#hp-train' : '#hp-muster', fieldSel = `${formSel} ${open === 'train' ? '#f-n' : '#f-troops'}`;
    await page.evaluate(sel => globalThis.__watch(sel), formSel);
    await page.locator(fieldSel).click();
    await page.locator(fieldSel).press('ControlOrMeta+a');
    // slowly (about one key a second), so the drawer's own redraws (every 0.3–3 s here) fall between the keys
    for (const ch of '120') { await page.keyboard.type(ch); await page.waitForTimeout(900); }
    const keys = await page.evaluate(() => globalThis.__ev.filter(e => e.type === 'keydown').map(e => e.t));
    const between = await page.evaluate(([a, b]) => globalThis.__rep.filter(x => x > a && x < b).length, [keys.at(-3), keys.at(-1)]);
    const samples = [];
    const t0 = Date.now();
    for (;;) {
      await page.waitForTimeout(1_000);
      const s = await page.evaluate(([formSel, fieldSel]) => { const i = document.querySelector(fieldSel), f = document.querySelector(formSel); return { replaced: globalThis.__rep.length, value: i?.value ?? null, focused: document.activeElement === i, folded: !!f?.closest('details:not([open])') }; }, [formSel, fieldSel]);
      samples.push({ t: Math.round((Date.now() - t0) / 1000), ...s });
      assert.equal(s.value, '120', `the typed value after ${s.replaced} redraws`);
      assert.equal(s.focused, true, `the focus after ${s.replaced} redraws`);
      assert.equal(s.folded, false, `the form's place after ${s.replaced} redraws`);
      if (s.replaced >= 3) break;
      assert.ok(Date.now() - t0 < 60_000, `only ${s.replaced} redraws in 60 s: not enough to show anything`);
    }
    await evidence(page, name, { form: open, samples, keystrokes: keys.slice(-3), redrawsBetweenKeys: between, note: 'the Train/Muster swap at reserve 100 does not happen in this fixture: holding.mjs troopsOrder is covered by its unit test only' });
    assert.ok(between >= 1, `no redraw fell between the keystrokes (${between}): the case was not exercised`);
  } catch (e) { await failed(page, name, e); }
});

test('presses on a drawer control while it redraws: each press ends on the node it began on, and the click fires', async t => {
  const { page, name } = await openVillage(t, 'drawer-presses');
  try {
    // a control whose click changes nothing in the world: the village's fold of other buildings (a <summary>)
    const sel = '#hp-build details[data-fold] > summary';
    assert.ok(await page.locator(sel).count(), 'the build card has a fold');
    await page.evaluate(sel => globalThis.__watch(sel), sel);
    await page.waitForTimeout(1_500);
    const presses = [];
    for (let i = 0; i < 12; i++) {
      const before = await page.evaluate(() => globalThis.__ev.length);
      const p = await press(page, sel, 300);
      await page.waitForTimeout(250);
      const r = await page.evaluate(([before, p]) => {
        const ev = globalThis.__ev.slice(before);
        const rep = globalThis.__rep;
        return { ev, replacedDuring: rep.filter(x => x > p.down && x < p.up).length, replacedRightAfterUp: rep.filter(x => x >= p.up && x <= p.up + 80).length };
      }, [before, p]);
      const down = r.ev.find(e => e.type === 'pointerdown'), click = r.ev.find(e => e.type === 'click');
      presses.push({ i, ...p, down, click: click ?? null, replacedDuring: r.replacedDuring, heldRedrawReleased: r.replacedRightAfterUp > 0 });
    }
    await evidence(page, name, { presses });
    for (const x of presses) {
      assert.ok(x.down?.inDrawer, `press ${x.i}: began in the drawer (the gate's scope)`);
      assert.ok(x.down?.atPointInDrawer, `press ${x.i}: nothing over the control at the press point (${x.down?.atPoint})`);
      assert.equal(x.replacedDuring, 0, `press ${x.i}: the control was not replaced while pressed`);
      assert.ok(x.click, `press ${x.i}: the click fired`);
    }
  } catch (e) { await failed(page, name, e); }
});

test('a person-like press on Build reaches the page\'s handler: the order goes to the world, or the page answers', async t => {
  const { page, name } = await openVillage(t, 'build-press');
  try {
    const sel = '#hp-build [data-act="build"][data-item].br-go:not([disabled])';
    assert.ok(await page.locator(sel).count(), 'an enabled Build button in the drawer');
    const inDrawer = await page.evaluate(sel => !!document.querySelector(sel)?.closest('#panel-body'), sel);
    await page.evaluate(sel => globalThis.__watch(sel), sel);
    const ordersBefore = (srv.world()?.orders ?? []).length;
    const p = await press(page, sel, 150);
    let reached = false, answer = null;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.waitForTimeout(250);
      const n = (srv.world()?.orders ?? []).length;
      answer = await page.evaluate(() => document.querySelector('#notice, [role="status"]')?.textContent?.trim() ?? null);
      reached = n > ordersBefore || /building begun|did not work|refus/i.test(answer ?? '');
    }
    const ev = await evidence(page, name, { inDrawer, press: p, ordersBefore, ordersAfter: (srv.world()?.orders ?? []).length, answer });
    const click = ev.events.find(e => e.type === 'click');
    assert.ok(inDrawer, 'Build is in the drawer (the gate\'s scope), not a hand pop-up');
    assert.ok(click?.connected, 'the click fired on a node still in the page');
    assert.ok(reached, `the handler was reached (orders ${ordersBefore} → ${(srv.world()?.orders ?? []).length}; answer ${answer})`);
  } catch (e) { await failed(page, name, e); }
});

/**
 * The case that used to swap the two troops forms: the reserve crosses 100 while the player is typing. The town starts
 * with 40 in reserve (Train stands open, Muster in its fold); during the typing the world itself trains 100 more for
 * the viewer (`world.order('Train')`: the world's own path, as another tab of the same player would), so the page sees
 * the reserve go 40 → 140 on its own. `which`: the form typed into ('train' open, or 'muster' opened from its fold).
 */
async function typingWhileReserveCrosses(t, which) {
  const name = `reserve-crossing-${which}`;
  const { page } = await openVillage(t, name, { reserve: [40, 0, 0, 0, 0, 0, 0, 0] });
  try {
    const reserve = () => page.evaluate(() => Number((document.querySelector('#hp-troops-h')?.closest('section')?.querySelector('.c-count')?.textContent ?? '').replace(/[^\d]/g, '')) || 0);
    const place = () => page.evaluate(() => ({ train: !!document.querySelector('#hp-train')?.closest('details:not([open])'), muster: !!document.querySelector('#hp-muster')?.closest('details:not([open])') }));
    const r0 = await reserve();
    assert.ok(r0 < 100, `the town starts below 100 in reserve (${r0})`);
    const p0 = await place();
    assert.deepEqual(p0, { train: false, muster: true }, 'below 100: Train open, Muster in its fold');
    const formSel = which === 'train' ? '#hp-train' : '#hp-muster', fieldSel = `${formSel} ${which === 'train' ? '#f-n' : '#f-troops'}`;
    if (which === 'muster') await page.locator('details:has(#hp-muster) > summary').first().click();
    await page.evaluate(sel => globalThis.__watch(sel), formSel);
    await page.locator(fieldSel).click();
    await page.locator(fieldSel).press('ControlOrMeta+a');
    await page.keyboard.type('1');
    await page.waitForTimeout(900);
    // the world trains 100 for the viewer now: the reserve crosses 100 while the field has the focus
    const ordered = srv.world().order('Train', { unit: 0, n: 100 });
    await page.keyboard.type('2');
    await page.waitForTimeout(900);
    await page.keyboard.type('0');
    const samples = [];
    const t0 = Date.now();
    for (;;) {
      await page.waitForTimeout(1_000);
      const s = await page.evaluate(([formSel, fieldSel]) => { const i = document.querySelector(fieldSel), f = document.querySelector(formSel); return { replaced: globalThis.__rep.length, value: i?.value ?? null, focused: document.activeElement === i, folded: !!f?.closest('details:not([open])') }; }, [formSel, fieldSel]);
      const r = await reserve(), pl = await place();
      samples.push({ t: Math.round((Date.now() - t0) / 1000), reserve: r, ...s, place: pl });
      assert.equal(s.value, '120', `the typed value (reserve ${r}, ${s.replaced} redraws)`);
      assert.equal(s.focused, true, `the focus (reserve ${r}, ${s.replaced} redraws)`);
      assert.equal(s.folded, false, `the ${which} form stays where the player is typing (reserve ${r})`);
      assert.deepEqual(pl, which === 'train' ? { train: false, muster: true } : { train: false, muster: false }, `the forms did not swap (reserve ${r})`);
      if (r >= 100 && s.replaced >= 2) break;
      assert.ok(Date.now() - t0 < 60_000, `the page did not see the reserve cross 100 within 60 s (reserve ${r}, order ${JSON.stringify(ordered)})`);
    }
    await evidence(page, name, { which, reserveAtStart: r0, ordered, samples });
  } catch (e) { await failed(page, name, e); }
}
test('Train open, the reserve crosses 100 while typing its count: value, focus and the open form stay', async t => typingWhileReserveCrosses(t, 'train'));
test('Muster opened from its fold, the reserve crosses 100 while typing its count: value, focus and the open fold stay', async t => typingWhileReserveCrosses(t, 'muster'));

test('nobody in the troops card: the open form follows the reserve (40 → Train; the world trains 100 → Muster opens, Train folds)', async t => {
  const name = 'reserve-crossing-idle';
  const { page } = await openVillage(t, name, { reserve: [40, 0, 0, 0, 0, 0, 0, 0] });
  try {
    const place = () => page.evaluate(() => ({ active: document.activeElement?.closest?.('section[aria-labelledby="hp-troops-h"]') ? 'troops card' : document.activeElement?.tagName, train: !!document.querySelector('#hp-train')?.closest('details:not([open])'), muster: !!document.querySelector('#hp-muster')?.closest('details:not([open])') }));
    const p0 = await place();
    assert.deepEqual([p0.train, p0.muster], [false, true], 'reserve 40: Train open');
    const ordered = srv.world().order('Train', { unit: 0, n: 100 });
    let p1 = p0;
    const t0 = Date.now();
    while (!(p1.train === true && p1.muster === false) && Date.now() - t0 < 60_000) { await page.waitForTimeout(1_000); p1 = await place(); }
    await evidence(page, name, { ordered, before: p0, after: p1 });
    assert.notEqual(p1.active, 'troops card', 'nobody was in the card');
    assert.deepEqual([p1.train, p1.muster], [true, false], 'reserve 140 with no input pending: Muster open, Train in its fold');
  } catch (e) { await failed(page, name, e); }
});
