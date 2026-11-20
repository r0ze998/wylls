// TEST-ONLY page driver of operator_playable P6 (devnet gap P1): headless Chromium plays the participant of a devnet
// wide season on the exact devnet .so, offline. The page is served by the herald in its devnet mode (`--cluster devnet
// --web`); its sends go through the gateway's devnet play routes behind the herald's /gw (wallet-signed, wallet-paid).
//
//   node page_driver.mjs --url http://127.0.0.1:H/frontier/ --out DIR --seed-file F --nation N --inspect PORT --sync DIR
//
// The wallet is a Wallet Standard TEST wallet on `solana:devnet` registered into the page (the page's own dev-wallet
// builder over a TEST seed the Rust test made for this chain only); it signs what the page asks, like a browser
// wallet extension would. Nothing here builds or sends a transaction: every command is pressed on the page.
// It writes `<sync>/done.json` once the page shows the wide village as final (after the test writes `<sync>/go-final`).
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
  try { const W = await import('/frontier/frontier/fwide.mjs'); wideSlots = W.wideSlots(FS).map(e => ({ slot: e.inventorySlot ?? e.slot ?? null, status: e.status ?? null, p: e.holding?.p != null ? String(e.holding.p) : null, q: e.holding?.q != null ? String(e.holding.q) : null, state: e.holding?.economy?.state ?? e.holding?.state ?? null })); } catch (e) { wideSlots = [{ err: String(e).slice(0, 200) }]; }
  return { bell: FS.nowBell ?? null, cluster: FS.record?.cluster ?? null, devnetPlay: FS.devnetPlay ? { relay: FS.devnetPlay.relay, seasonId: FS.devnetPlay.seasonId } : null, devnetWide: FS.devnetWide ?? null,
    wallet: FS.wallet?.address ?? null, walletList: (FS.walletList ?? []).map(w => ({ name: w.name, why: w.why ?? null })), faction: FS.citizen?.faction ?? null, holdings: hs, wide, wideSlots,
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
let s = await until('the page reads the devnet season and verifies devnet play', x => x.devnetPlay && x.walletList.some(w => w.name.startsWith('Test Wallet') && !w.why), { secs: 120, note: x => ({ cluster: x.cluster, devnetPlay: x.devnetPlay, wallets: x.walletList }) });
log('devnet play', s.devnetPlay, 'wide', s.devnetWide, 'cluster', s.cluster);
await shot('devnet-season-before-connect');
await act('connect', { i: String(s.walletList.findIndex(w => w.name.startsWith('Test Wallet'))) });
s = await until('the wallet is connected', x => !!x.wallet, { secs: 60 });
log('wallet', s.wallet);
// The nation, then the page's own first-village choice (outward: an opened rim province of that nation).
await page.getByText(/^(国を選ぶ|Choose a nation)$/).first().click({ timeout: 8000 }).catch(() => log('no 国を選ぶ button (continuing)'));
await wait(1000);
await act('pick-faction', { f: String(NATION) });
s = await until('the home planner offers a rim site', x => x.homeChoice?.sel, { secs: 180, note: x => x.homeChoice });
log('home choice', s.homeChoice, 'devnetWide', s.devnetWide);
await shot('home-choice-rim');
const confirm = page.locator('button[data-act="home-confirm"]:visible').first();
if (await confirm.count()) { log('pressing', await confirm.innerText().catch(() => '?')); await confirm.click({ timeout: 8000 }); } else { log('no visible confirm: pressing home-confirm'); await act('home-confirm'); }
await wait(4000);
await shot('join-and-request-sent');
s = await until('the rim village is settled and shown', x => x.holdings.length > 0, { secs: 600, every: 1500, note: x => ({ bell: x.bell, faction: x.faction, notice: x.notice?.text?.slice(0, 120) ?? null, hc: x.homeChoice }) });
log('village', s.holdings, 'bell', s.bell);
await openVillage();
await shot('rim-village');
// Harvest at every new bell (the test moves the clock 4 h at a time); press the wide claim once its card is ready.
let lastBell = -1, claimed = false;
while (!fs.existsSync(path.join(SYNC, 'go-final'))) {
  s = await state();
  if (!claimed && s.wide && !s.wide.err && s.wide.short.length === 0 && s.wide.targets.length) {
    await openVillage();
    await shot('wide-claim-card-ready');
    const btn = page.locator('button[data-act="wide-claim"]:visible:enabled').first();
    const info = await btn.evaluate(b => ({ ...b.dataset, text: b.innerText })).catch(e => ({ err: String(e) }));
    log('pressing the wide claim card button', info);
    await btn.click({ timeout: 8000 }).catch(e => log('press failed', String(e).slice(0, 200)));
    await wait(5000);
    const a = await state();
    log('after the wide claim', { notice: a.notice });
    await shot('wide-claim-sent');
    if (a.notice?.ok === true) claimed = true;
    continue;
  }
  if (s.bell !== null && s.bell !== lastBell && s.holdings.length) {
    lastBell = s.bell;
    await act('harvest');
    await wait(3000);
    const a = await state();
    log('harvest', { bell: s.bell, notice: a.notice?.text?.slice(0, 100) ?? null, holding: a.holdings[0], wide: a.wide });
    continue;
  }
  await wait(1500);
}
log('go-final', fs.readFileSync(path.join(SYNC, 'go-final'), 'utf8').trim());
s = await until('the page shows the wide village as final', x => x.wideSlots.some(e => e.p !== null && (e.state === 2 || e.status === 'final' || e.status === 'ok')), { secs: 240, every: 2000, note: x => x.wideSlots }).catch(() => null);
const fin = s ?? await state();
log('wide slots', fin.wideSlots);
await openVillage();
await shot('final-rim-village-with-wide');
// the wide village's own screen, if the page offers it
const wideBtn = page.locator('[data-act="wide-select"]:visible, [data-act="select-wide"]:visible').first();
if (await wideBtn.count()) { await wideBtn.click({ timeout: 5000 }).catch(() => {}); await wait(2000); await shot('wide-village-screen'); }
await page.keyboard.press('Escape').catch(() => {});
await shot('map-final');
fs.writeFileSync(path.join(SYNC, 'done.json'), JSON.stringify({ wideVillageFinal: !!s, wideSlots: fin.wideSlots, holdings: fin.holdings, devnetPlay: fin.devnetPlay, stills: shotN }, null, 2));
log('done');
await wait(1000);
await browser.close();
process.exit(0);
