// Walkthrough of the AI stack's screens (smoke-r3), made DURING the play phase (the client reads only the last 500 events).
//   node walk3.mjs OUTDIR RUN_DIR [--shots-only] [BASE] [PLAYWRIGHT_NODE_MODULES]
// Part (a) the map with ?art=1 at the Military layer, zoomed to an AI citizen's village/army (3D miniatures), the Japanese switch.
// Part (b) the council page: roster, a Wyll card, a released march decision with its Remembered lines, the council with its options,
// the ballots by who cast them, the Strike Order if adopted. Reads only: nothing is signed or sent; non-GET requests are recorded and fail the script.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const shotsOnly = argv.includes('--shots-only');
const [OUT, RUN, BASEARG, PW] = argv.filter(a => !a.startsWith('--'));
const BASE = BASEARG ?? 'http://127.0.0.1:41902';
const require = createRequire((PW ?? '/Users/r0ze/.npm/_npx/e41f203b7505f1fb/node_modules') + '/');
const { chromium } = require('playwright');
fs.mkdirSync(OUT, { recursive: true });
const ais = fs.readdirSync(`${RUN}/pub/cards`).filter(f => /^[0-9a-f]{16}\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(`${RUN}/pub/cards/${f}`, 'utf8'))).sort((a, b) => a.index - b.index);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(shotsOnly ? {} : { recordVideo: { dir: OUT + '/webm', size: { width: 1280, height: 800 } } }) });
const page = await ctx.newPage();
const nonGet = [], errs = [];
page.on('request', r => { if (r.method() !== 'GET') nonGet.push(`${r.method()} ${r.url()}`); });
page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
const w = ms => page.waitForTimeout(ms);
const shot = async name => { await page.screenshot({ path: `${OUT}/runtree-r3-${name}.png` }); };
const info = { shots: [], notes: {} };
const bellText = async () => (await page.locator('body').innerText()).match(/(?:Bell|bell|鐘) (\d+)/)?.[1] ?? null;
const search = async q => {
  await page.locator('#map-search-q').fill(q); await w(1500);
  const res = page.locator('#map-search-results button, .search-results button, [role=listbox] [role=option], #map-search-results li');
  if (await res.count()) await res.first().click();
  await w(3000);
  await page.waitForFunction(() => !/Loading the province|州の詳細を読み込/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  await w(1500);
};
const zoom = async (sign, n, gap = 1100) => { for (let i = 0; i < n; i++) { await page.locator(`button:has-text("${sign}")`).first().click().catch(() => {}); await w(gap); } };

// ---------------------------------------------------------------- (a) the map
await page.goto(`${BASE}/frontier/frontier/spectate.html?art=1`, { waitUntil: 'load' }); await w(3000);
await page.locator('#intro button').first().click().catch(() => {}); await w(2000);
await page.getByRole('button', { name: /Military/ }).first().click().catch(() => {}); await w(2000);
info.notes.map_bell = await bellText();
await shot('map-art-overview');
const pick = ais.filter(a => [1000, 1005, 1001].includes(a.index));
for (const ai of pick.slice(0, 2)) {
  await search(ai.name.en.split(' ')[0]);
  await zoom('+', 3);
  await w(4500);
  if (ai === pick[0]) await shot('map-art');
  await zoom('−', 2, 800);
}
await zoom('−', 2, 900);
await shot('map-armies-out');
await zoom('−', 2, 900);
await page.getByRole('button', { name: 'Realms' }).first().click().catch(() => {}); await w(2500);
await page.getByRole('button', { name: '日本語' }).first().click().catch(() => {}); await w(4500);
await shot('map-art-ja');
await page.getByRole('button', { name: 'EN' }).first().click().catch(() => {}); await w(2000);
// the Join tab and the nation step (local dev wallet, nothing signed)
await page.getByText('Join', { exact: true }).first().click().catch(() => {}); await w(2500);
const dev = page.getByRole('button', { name: /Dev Wallet/ }).first();
if (await dev.count()) { await dev.click(); await w(3000); await page.mouse.move(1100, 500); await page.mouse.wheel(0, 300); await w(1500); }
await shot('client-join-tab');

// ---------------------------------------------------------------- (b) the council page
await page.goto(`${BASE}/council.html`, { waitUntil: 'load' }); await w(4500);
info.notes.council_bell = await bellText();
await shot('council-top');
await w(1500);
// a Wyll with a released march decision: the one whose card says "model marches N (opened M)" with M > 0, else the first
const items = page.locator('.roster-item');
const n = await items.count();
let chosen = 0;
for (let i = 0; i < n; i++) {
  await items.nth(i).click().catch(() => {}); await w(700);
  const t = await page.locator('#card-body').innerText().catch(() => '');
  const m = t.match(/model marches (\d+) \(opened (\d+)\)/);
  info.notes[`card_${i}`] = m ? m[0] : 'no match';
  if (m && Number(m[2]) > 0) { chosen = i; break; }
}
await items.nth(chosen).click().catch(() => {}); await w(2500);
await page.locator('#card').scrollIntoViewIfNeeded().catch(() => {}); await w(1500);
await shot('wyll-card');
// the decisions list: a released march decision with Remembered lines
await page.locator('#dec-filter').scrollIntoViewIfNeeded().catch(() => {}); await w(1200);
const decs = page.locator('#decisions-body .decision');
const nd = await decs.count();
let target = -1;
const cls = await decs.evaluateAll(es => es.map(e => e.className));
const texts = [];
for (let i = 0; i < nd; i++) texts.push(await decs.nth(i).innerText());
// preference: a RELEASED march decision (the march opened) citing memory; then any released one; then any decision citing memory
const cites = t => /Remembered/.test(t) && !/nothing cited/.test(t);
for (const pred of [i => /decision-released/.test(cls[i]) && cites(texts[i]), i => /decision-released/.test(cls[i]), i => cites(texts[i])]) {
  for (let i = 0; i < nd && target < 0; i++) if (pred(i)) target = i;
  if (target >= 0) break;
}
info.notes.decisions = nd; info.notes.decision_target = target; info.notes.decision_class = cls[target] ?? null;
if (target >= 0) { await decs.nth(target).scrollIntoViewIfNeeded(); await decs.nth(target).evaluate(e => e.scrollIntoView({ block: 'center' })); info.notes.decision_text = (await decs.nth(target).innerText()).slice(0, 600); }
await w(3000); await shot('released-decision'); await w(3000);
// the council of nation 0 (Aster) and the others
await page.locator('#council').evaluate(e => e.scrollIntoView({ block: 'start' })); await w(2500);
const tabs = page.locator('#council-body .tab');
const nt = await tabs.count();
for (let i = 0; i < nt; i++) {
  await tabs.nth(i).click().catch(() => {}); await w(1500);
  const t = await page.locator('#council-body').innerText();
  info.notes[`council_tab_${i}`] = (t.match(/Strike Order adopted[^\n]*|No Strike Order adopted[^\n]*|No council this period/) ?? ['?'])[0];
  info.notes[`council_split_${i}`] = (t.match(/Ballots by who cast them[^\n]*/) ?? [''])[0];
  if (i === 0) { await w(2500); await shot('council'); await page.mouse.move(640, 500); await page.mouse.wheel(0, 300); await w(2500); await shot('council-ballots'); await page.mouse.wheel(0, -300); await w(800); }
}
await tabs.nth(0).click().catch(() => {}); await w(3000);
await page.locator('#council').evaluate(e => e.scrollIntoView({ block: 'start' })); await w(3500);
await ctx.close(); await browser.close();
fs.writeFileSync(`${OUT}/walk3-report.json`, JSON.stringify({ ...info, nonGet, errs, shotsOnly, at: new Date().toISOString() }, null, 1));
console.log(JSON.stringify({ ...info, nonGet, errs }, null, 1));
if (nonGet.length) process.exit(1);
