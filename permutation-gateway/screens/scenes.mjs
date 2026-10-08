// The screens of the smoke matrix (contract §13.6 E7, web design §13.2):
// the 10 screens — join/faction, site picker, the map's opening view (the
// viewer's village), map world LOD (one press out), map tile LOD
// with the survey, holding, march composer, march tracker, bell sheet, clash
// report, practice result — plus the onboarding card, the spectator, and
// (UX brief §3) the wait for the village, a provisional village and the
// survey's legend, and (UX brief §5) the village selected with its host's
// tiles lit and the pointer home.
// Each scene names its page, the viewer stage the fixture herald answers,
// and how the test reaches it: clicks on the page's own controls
// (`data-act`, tabs, forms), never state written into the page.
import { HOSTS } from './world.mjs';

const click = async (page, sel) => { await page.locator(sel).first().waitFor({ state: 'visible' }); await page.locator(sel).first().click(); };
const tab = (page, id) => click(page, `#tabs [data-act="tab"][data-tab="${id}"]`);
/** Open the bottom sheet fully on a phone (no-op on desktop, where the panel is a column). */
async function sheetFull(page) {
  const h = page.locator('[data-sheet-handle]');
  if (!(await h.isVisible().catch(() => false))) return;
  for (let i = 0; i < 3 && (await page.locator('#panel').getAttribute('data-sheet')) !== 'full'; i++) await h.click();
}
/** Wait until the page's text no longer contains `text` (a pending state). */
const gone = (page, text) => page.waitForFunction(t => !document.body.textContent.includes(t), text);

export const SCENES = [
  {
    // (wave 2, UX design 11.9) the title is an opaque scene of its own: while it stands nothing of the game shows
    // (frontier.screen.mjs checks that for a scene marked `intro`), and its button says where it leads
    id: 'intro', title: 'title scene (first visit)', page: 'index.html', stage: 'holding', intro: true,
    async go(page) {
      await page.locator('#intro:not([hidden]) .intro-go').waitFor();
      // the viewer has a village: the button leads back to it (it read "enter the Frontier" until the page knew)
      await page.waitForFunction(() => /村へ戻る|Back to your village/.test(document.querySelector('.intro-go')?.textContent ?? ''));
      if ((await page.evaluate(() => document.body.dataset.title)) !== 'up') throw new Error('the page is not marked while the title stands');
      await page.waitForTimeout(4600);   // the scene's entrance has played
    },
  },
  {
    id: 'join', title: 'join and faction', page: 'index.html', stage: 'none',
    async go(page) {
      await click(page, '[data-act="pick-faction"][data-f="2"]');
      await page.locator('[data-act="join"]:not([disabled])').waitFor();
    },
  },
  {
    id: 'sites', title: 'first village placed automatically', page: 'index.html', stage: 'joined',
    async go(page) {
      // owner decision V2: no site picker; the page files the ticket itself (the fixture relay refuses, so it shows the retry)
      await page.locator('#join-sites').waitFor();
      await page.locator('[data-act="pick-province"], [data-act="toggle-site"], [data-act="file-ticket"]').count().then(n => { if (n) throw new Error(`site picker controls: ${n}`); });
      // the refusal shows once, on the card, with the retry; the retry files again at once (review findings 1, 11)
      const posts = [];
      page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/f/relay')) posts.push(r.url()); });
      await page.locator('section[aria-labelledby="join-sites"] [role="alert"]').waitFor();
      await page.locator('[data-act="auto-ticket"]').waitFor();
      const alerts = await page.locator('[role="alert"]:visible').count();
      if (alerts !== 1) throw new Error(`${alerts} alerts (one live region expected)`);
      const before = posts.length;
      await page.locator('[data-act="auto-ticket"]').click();
      for (let i = 0; i < 50 && posts.length <= before; i++) await page.waitForTimeout(100);
      if (posts.length <= before) throw new Error('the retry sent nothing');
      await page.locator('section[aria-labelledby="join-sites"] [role="alert"]').waitFor();
    },
  },
  {
    // UX brief §4: a player with a village opens on that village, close up, never on the whole world
    id: 'map-open', title: 'map, the opening view: the viewer\'s village at tile LOD', page: 'index.html', stage: 'holding',
    async go(page) {
      // (wave 2: the guide's step is named by the one "next thing" control, not by a chip on the map)
      await page.locator('#attn-pill[data-next="guide"]').waitFor({ state: 'attached' });
      await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
      const at = await page.evaluate(() => document.getElementById('frontier-map').dataset.lod);
      if (at !== 'tile') throw new Error(`the opening view is at ${at} LOD`);
    },
  },
  {
    // the world view is one press away (the world chart button, or M) and one press back
    id: 'map-world', title: 'map, world LOD by the world chart button', page: 'index.html', stage: 'holding',
    async go(page) {
      await page.locator('#frontier-map[data-lod="tile"]').waitFor();
      await click(page, '[data-map="chart"]');
      await page.locator('#frontier-map[data-lod="world"]').waitFor();
      await page.locator('[data-map="chart"][aria-pressed="true"]').waitFor();
    },
  },
  {
    id: 'map-tile', title: 'map, tile LOD with the survey', page: 'index.html', stage: 'holding',
    async go(page) {
      await click(page, '[data-map="home"]');
      // (wave 2: a touch screen has no plus and minus buttons; the key zooms on every size)
      await page.locator('#frontier-map').focus();
      for (let i = 0; i < 16 && !(await page.locator('#frontier-map[data-lod="tile"]').count()); i++) await page.keyboard.press('+');
      await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
    },
  },
  {
    // UX brief §3: the wait for the village. The map opens on the first candidate's province: chart, with the
    // candidate sites as small discs of painted land
    id: 'ticket', title: 'the wait for the village: candidate sites on the chart', page: 'index.html', stage: 'ticket',
    async go(page) {
      // (integration: the wait is the HUD track's waiting view in the drawer, with its countdown to the next turn)
      // (wave 2, UX design 11.10: one clock — how long until the village is decided; the candidate rows are buttons to their sites)
      await page.locator('.wait-card #join-sites').waitFor();
      const clocks = await page.locator('[data-wait-clock]').count();
      if (clocks !== 1) throw new Error(`${clocks} clocks in the wait view (one expected)`);
      if (!/\d/.test(await page.locator('[data-wait-clock]').textContent())) throw new Error('the wait has no figure');
      await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
      await page.evaluate(() => { window.__fly = []; addEventListener('wylls:fly-to', e => window.__fly.push(e.detail)); });
      if ((await page.locator('.site-row[data-act="site-go"]').count()) !== 3) throw new Error('three candidate rows expected');
      await sheetFull(page);
      await page.locator('.site-row[data-act="site-go"]').nth(1).click();
      const fly = await page.evaluate(() => window.__fly);
      if (fly.length !== 1 || fly[0].index !== 1 || !Number.isInteger(fly[0].site)) throw new Error(`a candidate row did not ask the map to go to its site: ${JSON.stringify(fly)}`);
      // (the row took a phone's sheet back to its peek: the wait view is shown open again for the picture)
      await page.locator('#panel[data-drawer="open"] .wait-card').waitFor();
      const h = page.locator('[data-sheet-handle]');
      if (await h.isVisible().catch(() => false)) { for (let i = 0; i < 3 && (await page.locator('#panel').getAttribute('data-sheet')) === 'peek'; i++) await h.click(); }
    },
  },
  {
    id: 'provisional', title: 'a provisional village: its disc of sight on the chart', page: 'index.html', stage: 'provisional',
    async go(page) {
      // (integration: with a village the drawer starts closed; the provisional card stands with the guide's steps, on demand)
      await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
      await page.locator('[data-act="guide-open"]:visible').first().click();
      await page.locator('#join-prov').waitFor();
    },
  },
  {
    // UX brief §3: the play page has no "show everything" switch; it has the legend, the help line and the way to the spectator page
    id: 'survey', title: 'the survey\'s legend and help line', page: 'index.html', stage: 'holding',
    async go(page) {
      await tab(page, 'more');
      await page.locator('.survey-help a[href="spectate.html"]').waitFor();
      const n = await page.locator('[data-act="fog"]').count();
      if (n) throw new Error(`a show-everything switch on the play page: ${n}`);
      if ((await page.locator('.survey-legend li').count()) !== 4) throw new Error('the legend has four levels');
      if ((await page.locator('.lit-legend li').count()) !== 4) throw new Error('the lit tiles have four kinds');
      await sheetFull(page);
      await page.locator('.survey-help').scrollIntoViewIfNeeded();
    },
  },
  {
    // UX brief §5.2: selecting the viewer's village on the map lights what its host can do; a tap on the village
    // again takes the next host (nothing is sent: the fixture's relay refuses every write)
    id: 'lit', title: 'the village selected on the map: its host\'s tiles are lit', page: 'index.html', stage: 'holding',
    async go(page) {
      await page.locator('#frontier-map[data-lod="tile"][data-terrain="ready"]').waitFor();
      const at = await page.evaluate(async () => {
        const { coveredInsets } = await import('/frontier/map/fmap.mjs');
        const cv = document.getElementById('frontier-map'), b = cv.getBoundingClientRect(), i = coveredInsets(cv);
        return { x: b.left + i.left + (b.width - i.left - i.right) / 2, y: b.top + i.top + (b.height - i.top - i.bottom) / 2 };
      });
      await page.mouse.click(at.x, at.y);
      await page.mouse.move(2, 2);   // (a mouse resting on the map keeps its hover tip up; a finger leaves none)
      const ok = await page.evaluate(async () => { const { FS } = await import('/frontier/fstate.mjs'); return Number.isInteger(FS.selected?.idx) && (FS.holdings ?? []).some(h => h.p === FS.selected.p && h.q === FS.selected.q && h.tile === FS.selected.idx); });
      if (!ok) throw new Error('the tap in the middle of the opening view did not select the viewer\'s village');
      await page.locator('#inspect-title').waitFor();
    },
  },
  {
    // UX brief §5.3: with the village out of the picture a button at the map's edge points home
    id: 'pointer', title: 'the pointer home at the edge of the map', page: 'index.html', stage: 'holding',
    async go(page) {
      await page.locator('#frontier-map[data-lod="tile"]').waitFor();
      await page.locator('#frontier-map').focus();
      for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowRight');
      await page.locator('[data-map="home-pointer"]').waitFor({ state: 'visible' });
      const name = await page.locator('[data-map="home-pointer"]').getAttribute('aria-label');
      if (!/\d/.test(name ?? '')) throw new Error(`the pointer does not say how far: ${name}`);
    },
  },
  {
    id: 'holding', title: 'holding', page: 'index.html', stage: 'holding',
    async go(page) {
      await tab(page, 'holding');
      await page.locator('#holding-title').waitFor();
      await sheetFull(page);
    },
  },
  {
    id: 'march', title: 'march composer', page: 'index.html', stage: 'holding',
    async go(page) {
      await tab(page, 'hosts');
      await click(page, `[data-act="compose"][data-host="${HOSTS.free}"]`);
      // the order is one document written on the map (hud/marchcard.mjs): a nearby destination by its name, then the seal
      await page.locator('#mc-title').waitFor();
      await click(page, '[data-act="dest-quick"]');
      await gone(page, '道のりを探しています');
      // The planner found the way (the order can be sealed: no refusal).
      await page.locator('section[aria-labelledby="mc-title"] [data-act="march-send"]:not([disabled])').waitFor();
      await sheetFull(page);
    },
  },
  {
    id: 'tracker', title: 'march tracker', page: 'index.html', stage: 'holding',
    async go(page) {
      await tab(page, 'marches');
      await page.locator('#tracker-title').waitFor();
      await sheetFull(page);
    },
  },
  {
    id: 'bell', title: 'bell sheet', page: 'index.html', stage: 'holding',
    async go(page) {
      await tab(page, 'more');
      await page.locator('#bell-title').waitFor();
      await sheetFull(page);
    },
  },
  {
    id: 'report', title: 'clash report', page: 'index.html', stage: 'holding',
    async go(page) {
      await tab(page, 'more');
      await click(page, '[data-act="report-open"]');
      await page.locator('#report-title').waitFor();
      await page.locator('[data-act="report-verify"]').waitFor();
      await sheetFull(page);
    },
  },
  {
    id: 'practice', title: 'practice result', page: 'practice.html', stage: 'none',
    async go(page) {
      await click(page, 'form[data-form="practice-run"] button[type="submit"]');
      await page.locator('#practice-title ~ div[role="status"] table, [role="status"] h4').first().waitFor();
      await sheetFull(page);
    },
  },
  {
    // the guide is one objective at a time by the village plate; its steps open on demand as a checklist in the drawer
    // (it was the seven-chip card under the join flow of a viewer without a village)
    id: 'onboarding', title: 'the guide\'s steps, on demand', page: 'index.html', stage: 'holding',
    async go(page) {
      // (wave 2, UX design 11.11: the guide is named in one place — the "next thing" control of the top strip, or the line
      // under the plate on a phone — and its steps open from the small button beside it; there is no chip on the map)
      await page.locator('#attn-pill[data-next="guide"]').waitFor({ state: 'attached' });
      if (await page.locator('.ob-chip, #ob-map').count()) throw new Error('a second guide surface is on the page');
      await click(page, '[data-act="guide-open"]:visible');
      await page.locator('#panel-body .checklist').waitFor();
      await page.locator('#panel-body [aria-current="step"]').waitFor();
      await sheetFull(page);
    },
  },
  {
    id: 'spectate', title: 'spectator', page: 'spectate.html', stage: 'none',
    async go(page) {
      await page.locator('#bell-title').waitFor();
      await page.locator('[data-act="report-open"]').first().waitFor();
      await sheetFull(page);
    },
  },
];

export const VIEWPORTS = [
  { id: '360', width: 360, height: 740, phone: true },
  { id: '390', width: 390, height: 844, phone: true },
  { id: '1440', width: 1440, height: 900, phone: false },
];
