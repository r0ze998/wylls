// TEST-ONLY page driver of operator_playable PPOST (devnet-page-outpost): headless Chromium plays the participant of a
// devnet wide season on the exact devnet .so, offline, and founds its SECOND village by FileOutpost from the village
// screen's 「2つめ・3つめの村を出す」 card. The page is served by the herald in its devnet mode; its sends go through the
// gateway's devnet play routes behind the herald's /gw (wallet-signed, wallet-paid).
//
//   node page_outpost_driver.mjs --url http://127.0.0.1:H/frontier/ --out DIR --seed-file F --nation N --inspect PORT --sync DIR
//
// The wallet is a Wallet Standard TEST wallet on `solana:devnet` registered into the page (as page_driver.mjs). Nothing
// here builds or sends a transaction: every command is pressed on the page. Sync files with the Rust test:
//   <sync>/go-scan     (test → page) the absent neighbours; the page presses 「近くの州を調べる」 → <sync>/scan1.json
//   <sync>/go-outpost  (test → page) they are opened; the page scans again each bell and, once a row is ready, presses
//                      「ここに村を出す」 (the preview), then 「署名して送る」 → <sync>/filed.json
//   <sync>/go-final    (test → page) keeper A settled it; the page shows the second village → <sync>/done.json
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../../../permutation-gateway/screens/package.json'));
const { chromium } = require('playwright-core');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const URL0 = arg('url'), OUT = arg('out'), SEED = fs.readFileSync(arg('seed-file'), 'utf8').trim(), NATION = Number(arg('nation')), INSPECT = Number(arg('inspect')), SYNC = arg('sync');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => { const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'drive.log'), s + '\n'); };
let shotN = 0;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: process.env.LOCALE ?? 'ja-JP' });
const page = await ctx.newPage();
page.on('pageerror', e => log('pageerror', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') fs.appendFileSync(path.join(OUT, 'console.log'), m.text() + '\n'); });
page.on('request', q => { if (q.url().includes('/gw/f/devnet-play/')) fs.appendFileSync(path.join(OUT, 'devnet-play-requests.log'), `${q.method()} ${new URL(q.url()).pathname} ${(q.postData() ?? '').slice(0, 160)}\n`); });
const shot = async name => { const f = `${String(++shotN).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(OUT, f) }); log('still', f); return f; };
const ev = (fn, a) => page.evaluate(fn, a);
const wait = ms => page.waitForTimeout(ms);
// (inspection, loopback: {js} evaluates in the page, {shot} takes a still)
http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', async () => {
  let out; try { const c = JSON.parse(b); out = c.shot ? await shot(c.shot) : await page.evaluate(c.js); } catch (e) { out = { error: String(e).slice(0, 400) }; }
  res.end(JSON.stringify(out ?? null, (_, v) => (typeof v === 'bigint' ? String(v) : v))); }); }).listen(INSPECT, '127.0.0.1');

const state = () => ev(async () => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  const hs = (FS.holdings ?? []).map(h => ({ p: h.p, q: h.q, site: h.site, order: h.order, state: h.state, tier: h.tier }));
  let wide = null, wideSlots = [];
  try { const H = await import('/frontier/frontier/screens/holding.mjs'); const m = H.holdingModel(FS); const w = m ? H.wideClaimModel(FS, m) : null; wide = w ? { targets: w.targets.slice(0, 3), short: w.short, slot: w.slot } : null; } catch (e) { wide = { err: String(e).slice(0, 200) }; }
  let outpost = null;
  try { const H = await import('/frontier/frontier/screens/holding.mjs'); const O = await import('/frontier/frontier/screens/outpostcard.mjs'); const m = H.holdingModel(FS); const o = m ? O.outpostCardModel(FS, m) : null;
    outpost = o ? { rows: o.rows.map(r => ({ p: r.p, q: r.q, ring: r.ring, d: r.d, state: r.state, site: r.site, seen: r.seen, eligible: r.offer?.eligible === true, reason: r.offer?.reason ?? null })), own: o.own, pending: o.pending,
      preview: o.preview ? { step: o.preview.step, target: o.preview.target, slot: o.preview.slot ?? null, signature: o.preview.signature ?? null, total: o.preview.cost ? String(o.preview.cost.total) : null, deposit: o.preview.cost ? String(o.preview.cost.deposit) : null, fee: o.preview.cost ? String(o.preview.cost.fee) : null, settler: o.preview.settler ?? null } : null } : null; } catch (e) { outpost = { err: String(e).slice(0, 200) }; }
  try { const W = await import('/frontier/frontier/fwide.mjs'); wideSlots = W.wideSlots(FS).map(e => ({ slot: e.inventorySlot ?? e.slot ?? null, status: e.status ?? null, p: e.holding?.p != null ? String(e.holding.p) : null, q: e.holding?.q != null ? String(e.holding.q) : null, state: e.holding?.economy?.state ?? e.holding?.state ?? null })); } catch (e) { wideSlots = [{ err: String(e).slice(0, 200) }]; }
  return { bell: FS.nowBell ?? null, cluster: FS.record?.cluster ?? null, devnetPlay: FS.devnetPlay ? { relay: FS.devnetPlay.relay, seasonId: FS.devnetPlay.seasonId } : null, devnetWide: FS.devnetWide ?? null,
    wallet: FS.wallet?.address ?? null, walletList: (FS.walletList ?? []).map(w => ({ name: w.name, why: w.why ?? null })), faction: FS.citizen?.faction ?? null, slots: FS.citizen?.slots ?? null, holdings: hs, wide, wideSlots, outpost, fog: (await import('/frontier/frontier/map/fog.mjs')).fogNow().on === true,
    homeChoice: FS.homeChoice ? { sel: FS.homeChoice.selected ?? null, n: (FS.homeChoice.candidates ?? []).length, cands: (FS.homeChoice.candidates ?? []).slice(0, 3), err: FS.homeChoice.error?.code ?? null, busy: !!FS.homeChoice.busy } : null,
    notice: FS.notice ? { ok: FS.notice.ok, code: FS.notice.code ?? null, text: typeof FS.notice.text === 'function' ? FS.notice.text() : FS.notice.text ?? null } : null };
});
// (the village screen: its real tab button — a synthetic press does not open it)
const openVillage = async () => { await page.locator('[data-act="tab"][data-tab="holding"]').first().click({ timeout: 8000 }).catch(e => log('village tab', String(e).slice(0, 120))); await wait(1500); };
const act = (a, data = {}) => ev(([a, data]) => { const b = document.createElement('button'); b.dataset.act = a; for (const [k, v] of Object.entries(data)) b.dataset[k] = v; b.style.display = 'none'; document.body.appendChild(b); b.click(); b.remove(); }, [a, data]);
/** A failed step: say so, keep the page up for inspection (PAGE_DRIVER_HOLD_SECS, default 300), then exit 1. Never returns. */
const hold = async why => {
  log('FAILED', why);
  try { await shot('failed'); } catch { /* the page may be gone */ }
  fs.writeFileSync(path.join(SYNC, 'failed.txt'), why);
  await new Promise(r => setTimeout(r, Number(process.env.PAGE_DRIVER_HOLD_SECS ?? 300) * 1000));
  process.exit(1);
};
const until = async (what, ok, { secs = 120, every = 1000, note = null } = {}) => {
  const end = Date.now() + secs * 1000; let s, n = 0;
  while (Date.now() < end) { s = await state(); if (ok(s)) return s; if (note && n++ % 15 === 0) log(what, note(s)); await wait(every); }
  log('TIMEOUT', what, s); return hold(`timeout: ${what}`);
};

// (a step that fails leaves the page up for inspection — PAGE_DRIVER_HOLD_SECS, default 300 — and says so; the test's own limits end the run)
process.on('unhandledRejection', async e => {
  log('FAILED', String(e?.stack ?? e).slice(0, 600));
  try { await shot('failed'); } catch { /* the page may be gone */ }
  fs.writeFileSync(path.join(SYNC, 'failed.txt'), String(e?.message ?? e));
  setTimeout(() => process.exit(1), Number(process.env.PAGE_DRIVER_HOLD_SECS ?? 300) * 1000);
});
// (rent-live-rest: a page that read the world before the declared rim growth reached the herald offers a heartland
//  home — PlaceHome, from which the ring-4 neighbours stay under the fog and no outpost site is ever seen (verify-pr141's
//  ppost1 hit it too). Asking the planner again reuses that read, so the page is LOADED again (up to 5 times, 15 s apart)
//  until it offers the rim (ring >= 126); else it goes on as before.)
const ringOf = (p, q) => Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));
let s;
for (let attempt = 0; ; attempt++) {
  await page.goto(URL0, { waitUntil: 'load' });
  await wait(2500);
  // The TEST wallet: the page's own Wallet Standard builder (wallet.mjs devWallet) over the TEST seed, on solana:devnet.
  await ev(async seedHex => {
    const W = await import('/frontier/wallet.mjs'); const S = await import('/frontier/session.mjs');
    const seed = Uint8Array.from(seedHex.match(/../g).map(h => parseInt(h, 16)));
    const w = W.devWallet(await S.keyFromSeed(seed));
    const acct = Object.freeze({ ...w.accounts[0], chains: ['solana:devnet'] });
    const wallet = { ...w, name: 'Test Wallet (devnet, offline)', chains: ['solana:devnet'], accounts: [acct],
      features: { ...w.features, 'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [acct] }) } } };
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(wallet) }));
  }, SEED);
  s = await until('the page reads the devnet season and verifies devnet play', x => x.devnetPlay && x.walletList.some(w => w.name.startsWith('Test Wallet') && !w.why), { secs: 120, note: x => ({ cluster: x.cluster, devnetPlay: x.devnetPlay, wallets: x.walletList }) });
  log('devnet play', s.devnetPlay, 'wide', s.devnetWide, 'cluster', s.cluster);
  if (attempt === 0) await shot('devnet-season-before-connect');
  await act('connect', { i: String(s.walletList.findIndex(w => w.name.startsWith('Test Wallet'))) });
  s = await until('the wallet is connected', x => !!x.wallet, { secs: 60 });
  log('wallet', s.wallet);
  // The nation, then the page's own first-village choice (outward: an opened rim province of that nation).
  await page.getByText(/^(国を選ぶ|Choose a nation)$/).first().click({ timeout: 8000 }).catch(() => log('no 国を選ぶ button (continuing)'));
  await wait(1000);
  await act('pick-faction', { f: String(NATION) });
  s = await until('the home planner offers a rim site', x => x.homeChoice?.sel, { secs: 180, note: x => x.homeChoice });
  if (ringOf(s.homeChoice.sel.p, s.homeChoice.sel.q) >= 126 || attempt >= 4) break;
  log('home choice in the heartland: loading the page again', s.homeChoice.sel);
  await wait(15000);
}
log('home choice', s.homeChoice, 'devnetWide', s.devnetWide, 'ring', ringOf(s.homeChoice.sel.p, s.homeChoice.sel.q));
await shot('home-choice-rim');
// rent-live-rest: the village ticket's escrow preview as the details render it (「村の申し込みの預け金（いま要る額）」), once the
// page has the cluster's rent from its gateway route; the test compares it with the lamports the FileTicket debits.
const rentRead = async () => ev(async () => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  const app = await import('/frontier/frontier/app.mjs'); const U = await import('/frontier/util.mjs');
  const R = await import('/frontier/frontier/frent.mjs'); const Ld = await import('/frontier/frontier/fland.mjs');
  const d = document.createElement('div'); U.setHtml(d, app.detailsMarkup(FS));
  const tag = d.querySelector('[data-rent-source]'), dd = tag?.closest('dd');
  const shown = dd ? (dd.textContent.match(/^\s*([0-9,]+)/)?.[1] ?? '').replace(/,/g, '') : null;
  const r = R.rentNow(FS.rent);
  return { source: tag?.dataset.rentSource ?? null, perByte: r.perByte === null ? null : String(r.perByte), holdingRent: String(r.holdingRent), error: FS.rent?.error ?? null,
    shownLamports: shown, computed: String(Ld.escrowNeededAt(FS.land, R.holdingRentNow(FS.rent), FS.citizen?.slots)), text: dd?.textContent?.trim() ?? null, citizen: !!FS.citizen };
});
let rentSeen = await rentRead();
for (let i = 0; i < 90 && rentSeen.source !== 'cluster'; i++) { await wait(1000); rentSeen = await rentRead(); }
log('escrow preview (details)', rentSeen);
fs.writeFileSync(path.join(SYNC, 'escrow-preview.json'), JSON.stringify(rentSeen, null, 2));
const confirm = page.locator('button[data-act="home-confirm"]:visible').first();
if (await confirm.count()) { log('pressing', await confirm.innerText().catch(() => '?')); await confirm.click({ timeout: 8000 }); } else { log('no visible confirm: pressing home-confirm'); await act('home-confirm'); }
await wait(4000);
await shot('join-and-request-sent');
s = await until('the rim village is settled and shown', x => x.holdings.length > 0, { secs: 600, every: 1500, note: x => ({ bell: x.bell, faction: x.faction, notice: x.notice?.text?.slice(0, 120) ?? null, hc: x.homeChoice }) });
log('village', s.holdings, 'bell', s.bell);
await openVillage();
await shot('rim-village');

const exists = f => fs.existsSync(path.join(SYNC, f));
const cardText = () => page.locator('#hp-outpost').innerText({ timeout: 5000 }).catch(() => null);
/** Press a card button for real (the village screen open); `sel` a CSS selector. */
const press = async (sel, what) => {
  // (the village tab is clicked only when the card is not on screen: a click on it re-renders the panel)
  if (!(await page.locator('#hp-outpost:visible').count())) await openVillage();
  const b = page.locator(`${sel}:visible`).first();
  if (!(await b.count())) { log('no visible', what, sel); return false; }
  await b.scrollIntoViewIfNeeded().catch(() => {});
  const info = await b.evaluate(x => ({ ...x.dataset, text: x.innerText, disabled: x.disabled })).catch(e => ({ err: String(e) }));
  log('pressing', what, info);
  if (info.disabled) return false;
  await b.click({ timeout: 8000 }).catch(e => log('press failed', String(e).slice(0, 200)));
  return true;
};
const scan = async () => { const ok = await press('#hp-outpost button[data-act="outpost-scan"]', 'scan'); await wait(4000); return ok; };

// 1. The first scan, before the test opens the neighbours: the absent ones are "not opened yet".
while (!exists('go-scan')) { await wait(1000); }
const wanted = fs.readFileSync(path.join(SYNC, 'go-scan'), 'utf8').trim().split('\n').map(l => l.split(' ').map(Number));
log('go-scan', wanted);
await openVillage();
s = await state();
log('outpost card before the scan', s.outpost);
await shot('outpost-card-before-scan');
await scan();
s = await until('the card read the nearby provinces', x => x.outpost?.rows?.some(r => r.state !== 'unknown'), { secs: 120, every: 2000, note: x => x.outpost });
log('scan 1', s.outpost.rows, 'fog', s.fog);
await page.locator('#hp-outpost').scrollIntoViewIfNeeded().catch(() => {});
await shot('outpost-card-not-opened-yet');
const text1 = await cardText();
// (verify-pr141) The refusal a press on a province not opened yet gets (the map's 「前哨を築く」 lands on the same
// preview), in Japanese and in English: nothing is signed, the notice names why.
const refusal = {};
const absent = s.outpost.rows.find(r => r.state === 'unopened');
if (absent) {
  const Lg = '/frontier/lang.mjs';
  for (const lang of ['ja', 'en']) {
    await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, lang]);
    await wait(800);
    await act('outpost-preview', { p: String(absent.p), q: String(absent.q), site: '0' });
    const x = await until(`the ${lang} refusal of an unopened province`, y => y.notice && y.notice.ok === false && y.notice.code, { secs: 60 });
    refusal[lang] = { code: x.notice.code, text: x.notice.text, preview: x.outpost?.preview ?? null };
    log('refusal', lang, refusal[lang]);
    await shot(`refusal-unopened-${lang}`);
  }
  await ev(async m => { (await import(m)).setLang('ja'); }, Lg);
  await wait(800);
}
fs.writeFileSync(path.join(SYNC, 'scan1.json'), JSON.stringify({ rows: s.outpost.rows, fog: s.fog, cardText: text1, wanted, refusal }, null, 2));
const unopened1 = new Set(s.outpost.rows.filter(r => r.state === 'unopened').map(r => `${r.p},${r.q}`));

// 2. Harvest at every bell; after go-outpost, scan once a bell and file on the first ready row (an opened neighbour first).
let lastBell = -1, filed = false, scansSinceReady = 0;
while (!exists('go-final')) {
  s = await state();
  if (!filed && s.outpost?.pending) { filed = true; log('the ticket is pending (filed)'); }
  if (s.bell !== null && s.bell !== lastBell && s.holdings.length) {
    lastBell = s.bell;
    await act('harvest');
    await wait(3000);
    const a = await state();
    log('harvest', { bell: s.bell, notice: a.notice?.text?.slice(0, 100) ?? null, holding: a.holdings[0] });
    if (filed || !exists('go-outpost')) continue;
    await scan();
    const b = await state();
    const rows = b.outpost?.rows ?? [];
    log('scan', rows.map(r => `${r.p},${r.q}:${r.state}${r.site !== null ? `#${r.site}${r.seen === 'memory' ? 'm' : ''}` : ''}${r.eligible ? ':ready' : r.reason ? `:${r.reason.slice(0, 40)}` : ''}`).join(' '));
    const ready = rows.filter(r => r.eligible && r.site !== null);
    const pick = ready.find(r => unopened1.has(`${r.p},${r.q}`)) ?? (++scansSinceReady >= 3 ? ready[0] : null);
    if (!pick) continue;
    if (!(await page.locator('#hp-outpost:visible').count())) await openVillage();
    await page.locator('#hp-outpost').scrollIntoViewIfNeeded().catch(() => {});
    await shot('outpost-card-ready');
    // FIRST press: the preview (nothing is signed)
    if (!(await press(`#hp-outpost button[data-act="outpost-preview"][data-p="${pick.p}"][data-q="${pick.q}"]`, 'preview'))) continue;
    const p1 = await until('the preview shows the SOL cost', x => x.outpost?.preview?.step === 'preview' || (x.notice && x.notice.ok === false), { secs: 60, every: 1000 });
    if (p1.outpost?.preview?.step !== 'preview') { log('preview refused', p1.notice); continue; }
    await page.locator('#hp-outpost').scrollIntoViewIfNeeded().catch(() => {});
    await shot('outpost-preview');
    const previewText = await cardText();
    log('preview', p1.outpost.preview, previewText);
    const sigBefore = (await state()).outpost?.preview;
    // SECOND press: sign and send
    await press('#hp-outpost button[data-act="outpost-send"]', 'send');
    const p2 = await until('the send is answered', x => x.outpost?.preview?.step === 'sent' || x.outpost?.pending || (x.notice && x.notice.ok === false && !x.notice.busy), { secs: 120, every: 1000 });
    await wait(3000);
    await page.locator('#hp-outpost').scrollIntoViewIfNeeded().catch(() => {});
    await shot('outpost-sent');
    const sentText = await cardText();
    log('after send', p2.outpost?.preview, p2.notice, sentText);
    if (p2.outpost?.preview?.step === 'sent' || p2.outpost?.pending) {
      filed = true;
      fs.writeFileSync(path.join(SYNC, 'filed.json'), JSON.stringify({ target: { p: pick.p, q: pick.q, site: pick.site, seen: pick.seen, wasUnopened: unopened1.has(`${pick.p},${pick.q}`) },
        preview: { totalLamports: sigBefore.total, depositLamports: sigBefore.deposit, feeLamports: sigBefore.fee, settler: sigBefore.settler, slot: sigBefore.slot, text: previewText },
        sent: { signature: p2.outpost?.preview?.signature ?? null, notice: p2.notice, text: sentText } }, null, 2));
    }
    continue;
  }
  await wait(1500);
}
log('go-final', fs.readFileSync(path.join(SYNC, 'go-final'), 'utf8').trim());
const [fp, fq, fsite] = fs.readFileSync(path.join(SYNC, 'go-final'), 'utf8').trim().split(' ').map(Number);
// 3. Read back: the herald's record of the Citizen has the second village; the card names it.
let shown = null;
for (let i = 0; i < 60 && !shown; i++) {
  await act('me-retry').catch(() => {});
  await wait(3000);
  const x = await state();
  if (x.outpost?.own?.some(o => o.p === fp && o.q === fq && o.site === fsite && o.order === 2) && x.holdings.some(h => h.order === 2)) shown = x;
}
await openVillage();
await page.locator('#hp-outpost').scrollIntoViewIfNeeded().catch(() => {});
await shot('outpost-second-village-on-card');
const finalText = await cardText();
const fin = shown ?? await state();
log('final', fin.outpost, fin.holdings, finalText);
// the second village's own screen (the village rail), and the map
const second = fin.holdings.findIndex(h => h.order === 2);
// (verify-pr141: the village switch is the page's own key `]` — app.mjs cycleHolding; there is no 'holding-go' action)
const activeOrder = () => ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); return Number(FS.holdings?.[FS.activeHolding ?? 0]?.order ?? 0); });
const toOrder = async want => { for (let i = 0; i < 4 && (await activeOrder()) !== want; i++) { await ev(() => document.activeElement?.blur?.()); await page.keyboard.press(']'); await wait(1200); } return activeOrder(); };
if (second >= 0) { log('active order', await toOrder(2)); await openVillage(); await shot('second-village-screen'); }
await page.keyboard.press('Escape').catch(() => {});
await shot('map-final');
// (verify-pr141) The new village is usable: after the test moves the clock (its stores fill), the page harvests it and
// presses a real 「建てる」 and 「訓練する」 on ITS screen — each one wallet-signed act through the devnet lane.
const use = {};
if (second >= 0) {
  fs.writeFileSync(path.join(SYNC, 'want-use'), 'go\n');
  while (!exists('go-use')) { await wait(1000); }
  for (let i = 0; i < 10; i++) { await act('me-retry').catch(() => {}); await wait(2000); }
  use.order = await toOrder(2);
  // (a click on the village tab while the screen is open closes it: open it only when it is not on screen)
  const ensureVillage = async sel => { if (!(await page.locator(`${sel}:visible`).count())) await openVillage(); };
  await ensureVillage('#hp-build');
  await act('harvest'); await wait(5000);
  use.harvest = (await state()).notice;
  await ensureVillage('#hp-build');
  const bb = page.locator('#hp-build button[data-act="build"]:visible:not([disabled])').first();
  use.buildEnabled = await page.locator('#hp-build button[data-act="build"]:visible:not([disabled])').count();
  if (await bb.count()) { use.buildItem = await bb.getAttribute('data-item'); await bb.scrollIntoViewIfNeeded().catch(() => {}); await bb.click({ timeout: 8000 }); }
  await wait(6000);
  use.build = (await state()).notice;
  await shot('second-village-build');
  await ensureVillage('#hp-train');
  const tf = page.locator('#hp-train button[type="submit"]:visible').first();
  if (!(await tf.count())) { await page.locator('#hp-train').scrollIntoViewIfNeeded().catch(() => {}); }
  await page.locator('#hp-train input[name="n"]').first().fill('100').catch(() => {});
  await wait(600);
  use.trainEnabled = await page.locator('#hp-train button[type="submit"]:not([disabled])').count();
  const tb = page.locator('#hp-train button[type="submit"]').first();
  if (use.trainEnabled) { await tb.scrollIntoViewIfNeeded().catch(() => {}); await tb.click({ timeout: 8000 }).catch(e => log('train press', String(e).slice(0, 160))); }
  else use.trainBlocked = await page.locator('#hp-train').innerText().catch(() => null);
  await wait(6000);
  use.train = (await state()).notice;
  use.activeOrderAfter = await activeOrder();
  await shot('second-village-train');
  log('use', use);
}
// the same card in English (the language toggle)
await ev(async () => { const Lg = await import('/frontier/lang.mjs'); Lg.setLang('en'); }).catch(() => {});
await wait(1500);
if (second >= 0) await toOrder(1);
await openVillage();
await page.locator('#hp-outpost').scrollIntoViewIfNeeded().catch(() => {});
await shot('outpost-card-en');
const enText = await cardText();
fs.writeFileSync(path.join(SYNC, 'done.json'), JSON.stringify({ outpostVillageShown: !!shown, outpost: fin.outpost, holdings: fin.holdings, cardText: finalText, cardTextEn: enText, use, devnetPlay: fin.devnetPlay, stills: shotN }, null, 2));
log('done');
await wait(1000);
await browser.close();
process.exit(0);
