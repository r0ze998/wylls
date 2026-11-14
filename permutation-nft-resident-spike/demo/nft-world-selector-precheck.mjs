// Pre-check of the world screen check's selectors (demo/nft-world-screen-check.mjs) on the real game page, before a
// world is spent on them: the fixture server's live world (stage holding, reserve 40; no chain, no key), the same flow
// (the dock's Village tab once, the troops card and its forms, Harvest, the Hosts tab, a march order with a destination
// by coordinates, its send button). Each: found, visible, unique, and whether it is the element at its own centre.
// The NFT-only parts (mint page, NFT join card, first village, intro) are not in this fixture and are listed as such.
//   node permutation-nft-resident-spike/demo/nft-world-selector-precheck.mjs <out.json>
import { createRequire } from 'node:module'; import { writeFileSync } from 'node:fs';
const { chromium } = createRequire(new URL('../../permutation-gateway/screens/package.json', import.meta.url))('playwright-core');
import { startServer } from '../../permutation-gateway/screens/server.mjs';
import { storageFor } from '../../permutation-gateway/screens/world.mjs';
const out = process.argv[2];
const srv = await startServer(); const browser = await chromium.launch();
const rows = [];
try {
  srv.stage('holding'); srv.live(true, { turn: 20, delay: 8, reserve: [40, 0, 0, 0, 0, 0, 0, 0] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' });
  await ctx.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storageFor(srv.viewer, { stage: 'holding', lang: 'en' }));
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/frontier/index.html`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? '') && document.body.dataset.stage !== 'loading');
  const probe = async (step, sel, { visible = true, unique = false } = {}) => {
    const r = await page.evaluate(sel => { const all = [...document.querySelectorAll(sel)]; const v = all.filter(e => e.offsetParent !== null && e.getClientRects().length); const c = v[0]?.getBoundingClientRect(); const top = c ? document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2) : null; return { count: all.length, visible: v.length, hit: !!(top && v[0] && (top === v[0] || v[0].contains(top))) }; }, sel);
    const ok = r.count > 0 && (!visible || r.visible > 0) && (!unique || r.count === 1);
    rows.push({ step, sel, ...r, ok }); return ok;
  };
  await page.locator('#tabs [data-tab="holding"]').waitFor({ state: 'visible', timeout: 30000 });   // (as the fixed harness waits)
  await probe('village tab (dock, exactly one)', '#tabs [data-tab="holding"]', { unique: true });
  rows.push({ step: 'note', sel: '[data-act="tab"][data-tab="holding"] (the old selector)', count: await page.locator('[data-act="tab"][data-tab="holding"]').count(), ok: true });
  // open the village as the fixed harness does: press the dock tab once, then the title
  await page.locator('#tabs [data-tab="holding"]').click(); await page.locator('#holding-title').waitFor({ timeout: 10000 });
  await probe('village tab current', '#tabs [data-tab="holding"][aria-current="page"]', { unique: true });
  await probe('village title', '#holding-title', { unique: true });
  await probe('build button', '[data-act="build"][data-item].br-go:not([disabled])');
  await probe('troops card (one, not the drawer)', 'section.vcard[aria-labelledby="hp-troops-h"]', { unique: true });
  rows.push({ step: 'note', sel: 'section:has(#hp-troops-h) (the old selector)', count: await page.locator('section:has(#hp-troops-h)').count(), ok: true });
  await probe('reserve count', 'section.vcard[aria-labelledby="hp-troops-h"] .c-count');
  await probe('train form', '#hp-train', { unique: true });
  await probe('train count field', '#hp-train #f-n', { unique: true });
  await probe('train submit', '#hp-train button[type="submit"]', { unique: true });
  await probe('muster form (in DOM; folded while reserve < 100)', '#hp-muster', { visible: false, unique: true });
  await probe('muster fold summary', 'details:has(#hp-muster) > summary');
  await probe('muster count field', '#hp-muster #f-troops', { visible: false, unique: true });
  await probe('harvest button', '[data-act="harvest"]');
  await probe('hosts tab (dock)', '#tabs [data-tab="hosts"]', { unique: true });
  await page.locator('#tabs [data-tab="hosts"]').click(); await page.waitForTimeout(800);
  await probe('march (compose) button on a host', '[data-act="compose"]', { visible: false });
  const composable = page.locator('[data-act="compose"]:not([disabled])');
  if (await composable.count()) {
    await composable.first().click(); await page.waitForTimeout(800);
    await probe('destination form (in DOM)', 'form[data-form="dest"]', { visible: false, unique: true });
    await probe('destination fold summary', 'details:has(form[data-form="dest"]) > summary');
    // a destination first (by coordinates, as the harness does): the send button exists only for an order with one
    let sent = false;
    for (const tile of [1, 2, 3, 4, 5, 6, 7, 8]) {
      if (!(await page.locator('form[data-form="dest"]').isVisible())) await page.locator('details:has(form[data-form="dest"]) > summary').first().click();
      const f = page.locator('form[data-form="dest"]');
      await f.locator('input[name="p"]').fill('128'); await f.locator('input[name="q"]').fill('0'); await f.locator('input[name="tile"]').fill(String(tile));
      await f.locator('button[type="submit"]').click(); await page.waitForTimeout(1500);
      if (await page.locator('[data-act="march-send"]').count()) { sent = true; break; }
    }
    await probe('send march button (after a destination)', '[data-act="march-send"]', { visible: false, unique: true });
  } else rows.push({ step: 'compose: no enabled host in this fixture right now (not checked)', ok: null });
  const missing = rows.filter(r => r.ok === false);
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), not_covered: ['mint page (#t-*, data-testid)', 'NFT join card ([data-act="nft-reload"], [data-act="pick-faction"], [data-act="nft-login"])', 'first village ([data-act="home-confirm"])', 'intro ([data-act="intro-close"])'], rows }, null, 2));
  for (const r of rows) console.log(r.ok === false ? 'MISSING' : r.ok === null ? 'SKIP   ' : 'ok     ', r.step, r.count ?? '', r.visible ?? '', r.hit === undefined ? '' : (r.hit ? 'hit' : 'covered'));
  console.log(missing.length ? `${missing.length} missing` : 'all found');
} finally { await browser.close(); await srv.close(); }
