// Run-tree capture: the latest web client served by a live AI stack on 127.0.0.1 (smoke-r2).
//   node capture.mjs OUTDIR RUN_DIR [BASE=http://127.0.0.1:41902] [PLAYWRIGHT_NODE_MODULES]
// RUN_DIR is the run's directory (it has pub/cards/*.json: the AI citizens' public names).
// Per AI citizen: search the name in the map's search box, take the place (the "Hosts on this tile" panel shows the unit
// cards), zoom in with the + button and take the tile (the painted miniature on the map), record every /art/units/ request
// with its HTTP status. Then the Join tab of the client with the local dev wallet connected (a random key in this throwaway
// browser's storage; nothing is signed, no non-GET request is made: the script records them and fails if there is one),
// the highlights count against the chronicle window, and the council page. EN and JA. Loopback only.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const [OUT, RUN, BASEARG, PW] = process.argv.slice(2);
const BASE = BASEARG ?? 'http://127.0.0.1:41902';
const require = createRequire((PW ?? '/Users/r0ze/.npm/_npx/e41f203b7505f1fb/node_modules') + '/');
const { chromium } = require('playwright');
fs.mkdirSync(OUT, { recursive: true });
const ais = fs.readdirSync(`${RUN}/pub/cards`).filter(f => /^[0-9a-f]{16}\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(`${RUN}/pub/cards/${f}`, 'utf8'))).sort((a, b) => a.index - b.index);
const report = { base: BASE, at: new Date().toISOString(), ais: [], join: {}, council: {}, nonGet: [] };
const browser = await chromium.launch();
async function open(url, { w = 1280, h = 800, lang = 'en' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const o = { ctx, page, art: new Map(), logs: [], nonGet: [] };
  page.on('response', r => { const u = r.url(); if (/\/art\/units\//.test(u)) o.art.set(u.replace(BASE, ''), r.status()); });
  page.on('request', r => { if (r.method() !== 'GET') o.nonGet.push(`${r.method()} ${r.url().replace(BASE, '')}`); });
  page.on('pageerror', e => o.logs.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) o.logs.push(`error: ${m.text().slice(0, 200)}`); });
  await page.goto(BASE + url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(3500);
  const b = page.locator('#intro button').first(); if (await b.count()) await b.click().catch(() => {});
  await page.waitForTimeout(1500);
  if (lang === 'ja') { await page.getByRole('button', { name: '日本語' }).first().click().catch(() => {}); await page.waitForTimeout(1500); }
  return o;
}
const bellOf = async page => (await page.locator('header, body').first().innerText()).match(/(?:Bell|鐘) (\d+)/)?.[1] ?? null;

for (const ai of ais) {
  for (const lang of ['en', 'ja']) {
    if (lang === 'ja' && ai.index !== 1000) continue;   // one JA shot of the language switch is enough
    const o = await open('/frontier/frontier/spectate.html?art=1', { lang });
    const { page } = o;
    await page.getByRole('button', { name: /Military|軍事/ }).first().click().catch(() => {});
    const q = ai.name[lang === 'ja' ? 'ja' : 'en'].split(/[ ・]/)[0];
    await page.locator('#map-search-q').fill(q);
    await page.waitForTimeout(1500);
    const res = page.locator('#map-search-results button, .search-results button, [role=listbox] [role=option], #map-search-results li');
    const nres = await res.count();
    const rec = { index: ai.index, name: ai.name.en, faction: ai.faction, lang, query: q, results: nres };
    if (nres) {
      await res.first().click();
      await page.waitForTimeout(3000);
      await page.waitForFunction(() => !/Loading the province|州の詳細を読み込/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => { rec.detailsStillLoading = true; });
      await page.waitForTimeout(1500);
      rec.bell = await bellOf(page);
      const txt = await page.locator('body').innerText();
      rec.hostsPanel = /Hosts on this tile|この区画の軍勢/.test(txt);
      rec.hostLines = txt.split('\n').filter(l => /Spearman|Archer|Horseman|Pikeman|Crossbowman|Knight|Scout|Settler|槍兵|弓兵|騎兵|斥候|入植/.test(l)).slice(0, 6);
      await page.screenshot({ path: `${OUT}/ai${ai.index}-${lang}-place.png` });
      if (rec.hostsPanel) {
        for (let i = 0; i < 3; i++) { await page.locator('button:has-text("+")').first().click(); await page.waitForTimeout(1200); }
        await page.waitForTimeout(3000);
        await page.screenshot({ path: `${OUT}/ai${ai.index}-${lang}-zoom.png` });
      }
    }
    rec.units_art = Object.fromEntries(o.art); rec.logs = o.logs; report.nonGet.push(...o.nonGet);
    report.ais.push(rec);
    await o.ctx.close();
  }
}

// a clash highlight moves the map to the province and replays the battle (people/battle.mjs: the same miniatures as tokens)
{
  const o = await open('/frontier/frontier/spectate.html?art=1');
  const { page } = o;
  await page.getByRole('button', { name: /Military|軍事/ }).first().click().catch(() => {});
  const hl = page.locator('.highlights button').filter({ hasText: /clash|衝突/ }).first();
  const rec = { clashHighlight: (await hl.count()) > 0 };
  if (rec.clashHighlight) {
    rec.text = (await hl.innerText()).slice(0, 80);
    await hl.click();
    for (const [i, ms] of [4000, 4000, 4000].entries()) { await page.waitForTimeout(ms); await page.screenshot({ path: `${OUT}/clash-replay-${i}.png` }); }
  }
  rec.units_art = Object.fromEntries(o.art); rec.logs = o.logs; report.clash = rec; report.nonGet.push(...o.nonGet);
  await o.ctx.close();
}

for (const lang of ['en', 'ja']) {
  const o = await open('/frontier/frontier/spectate.html?art=1', { w: 1280, h: 900, lang });
  const { page } = o;
  await page.getByText(lang === 'ja' ? '参加する' : 'Join', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/join-${lang}-1-before-wallet.png` });
  const dev = page.getByRole('button', { name: /Dev Wallet/ }).first();
  const rec = { devWalletButton: (await dev.count()) > 0 };
  if (rec.devWalletButton) { await dev.click(); await page.waitForTimeout(4000); await page.screenshot({ path: `${OUT}/join-${lang}-2-nation.png` }); }
  const txt = await page.locator('body').innerText();
  rec.nationStep = lang === 'ja' ? /国を選ぶ/.test(txt) : /Choose a nation/.test(txt);
  rec.sitePicker = /site picker|pick a site|区画を選ぶ/i.test(txt);
  rec.nationNames = ['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'].filter(n => txt.includes(n)).length;
  rec.logs = o.logs; report.join[lang] = rec; report.nonGet.push(...o.nonGet);
  await o.ctx.close();
}

{
  const o = await open('/frontier/frontier/spectate.html?art=1');
  await o.page.waitForTimeout(4000);
  const listed = await o.page.locator('.highlights li').count();
  const sj = await (await fetch(`${BASE}/h/season`)).json();
  const head = sj.headSeq ?? sj.head_seq ?? null;
  report.highlights = { bell: await bellOf(o.page), listed, headSeq: head, chronicleWindowFrom: head === null ? null : Math.max(0, Number(head) - 500), note: 'a fresh page reads the chronicle from headSeq - 500 (controller.mjs CHRONICLE_WINDOW)' };
  await o.page.screenshot({ path: `${OUT}/highlights.png` });
  await o.ctx.close();
}

for (const lang of ['en', 'ja']) {
  const o = await open('/council.html', { w: 1280, h: 900, lang: 'en' });
  if (lang === 'ja') { await o.page.getByRole('button', { name: /日本語|JA/ }).first().click().catch(() => {}); await o.page.waitForTimeout(1500); }
  await o.page.waitForTimeout(3000);
  const decs = o.page.locator('#decisions');
  const txt = await decs.innerText().catch(() => '');
  report.council[lang] = {
    reflectionBodies: await o.page.locator('.reflection-body').count(),
    reflectionWithChoseNone: (txt.match(/reflection[\s\S]{0,400}?(no candidate named|候補が特定できません)/gi) ?? []).length,
    sessionDecisions: await o.page.locator('article.decision .chose').count(),
    logs: o.logs,
  };
  await decs.scrollIntoViewIfNeeded().catch(() => {});
  await o.page.waitForTimeout(800);
  await o.page.screenshot({ path: `${OUT}/council-${lang}-decisions.png` });
  await o.page.evaluate(() => window.scrollTo(0, 0)); await o.page.waitForTimeout(500);
  await o.page.screenshot({ path: `${OUT}/council-${lang}-top.png` });
  report.nonGet.push(...o.nonGet);
  await o.ctx.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/capture-report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ais: report.ais.map(a => [a.index, a.lang, a.results, a.hostsPanel, Object.keys(a.units_art).length]), join: report.join, highlights: report.highlights, council: report.council, nonGet: report.nonGet }));
if (report.nonGet.length) { console.error('a non-GET request was made:', report.nonGet); process.exit(1); }
