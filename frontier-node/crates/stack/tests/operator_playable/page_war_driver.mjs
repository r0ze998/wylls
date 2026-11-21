// TEST-ONLY page driver of operator_playable P9 (devnet-page-war; built on P7's page_driver.mjs): headless Chromium plays the participant of a devnet
// wide season on the exact devnet .so, offline. The page is served by the herald in its devnet mode (`--cluster devnet
// --web`); its sends go through the gateway's devnet play routes behind the herald's /gw (wallet-signed, wallet-paid).
//
//   node page_driver.mjs --url http://127.0.0.1:H/frontier/ --out DIR --seed-file F --nation N --inspect PORT --sync DIR
//
// The wallet is a Wallet Standard TEST wallet on `solana:devnet` registered into the page (the page's own dev-wallet
// builder over a TEST seed the Rust test made for this chain only); it signs what the page asks, like a browser
// wallet extension would. Nothing here builds or sends a transaction: every command is pressed on the page.
// The war: the page founds its rim village, harvests, then — on the test's word, written into <sync> — musters
// (`go-muster`), composes and sends ONE sealed march onto the keep the test names (`go-march`: the page's own keep
// march, 'cq-march', and its real 出発 button), reloads itself (its encrypted march book must survive), and shows the
// march's stages while keeper A reveals, resolves and settles it. It writes `<sync>/done.json` after `go-final`.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../../../permutation-gateway/screens/package.json'));
const { chromium } = require('playwright-core');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const SCENARIO = arg('scenario') ?? 'keep';   // 'keep' (P9) | 'home' (P10, devnet-page-war-2: the return march, keeper outages)
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
// (P10: the self-reveal POSTs and their answers — the path, the status and the answer's code/track only: the body the page
//  posts carries the plaintext and the salt, and is never logged)
page.on('request', q => { if (new URL(q.url()).pathname.endsWith('/gw/f/reveal')) fs.appendFileSync(path.join(OUT, 'devnet-play-requests.log'), `${q.method()} /gw/f/reveal (material not logged)\n`); });
page.on('response', async q => { if (!new URL(q.url()).pathname.endsWith('/gw/f/reveal')) return; let b = null; try { b = await q.json(); } catch { b = null; }
  fs.appendFileSync(path.join(OUT, 'reveal-responses.log'), JSON.stringify({ at: Date.now(), status: q.status(), body: b ? { code: b.code ?? null, error: b.error ?? null, track: b.track ?? null, state: b.state ?? null } : null }) + '\n'); });
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

const register = () => ev(async seedHex => {
  const W = await import('/frontier/wallet.mjs'); const S = await import('/frontier/session.mjs');
  const seed = Uint8Array.from(seedHex.match(/../g).map(h => parseInt(h, 16)));
  const w = W.devWallet(await S.keyFromSeed(seed));
  const acct = Object.freeze({ ...w.accounts[0], chains: ['solana:devnet'] });
  const wallet = { ...w, name: 'Test Wallet (devnet, offline)', chains: ['solana:devnet'], accounts: [acct],
    features: { ...w.features, 'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [acct] }) } } };
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(wallet) }));
}, SEED);
const connect = async () => {
  await register();
  let s = await until('the page reads the devnet season and verifies devnet play', x => x.devnetPlay && x.walletList.some(w => w.name.startsWith('Test Wallet') && !w.why), { secs: 120, note: x => ({ cluster: x.cluster, devnetPlay: x.devnetPlay, wallets: x.walletList }) });
  await act('connect', { i: String(s.walletList.findIndex(w => w.name.startsWith('Test Wallet'))) });
  return until('the wallet is connected', x => !!x.wallet, { secs: 60 });
};
/** The page's march book as the page keeps it (devnet: the encrypted book; read through the page's own modules). */
const bookNow = () => ev(async () => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  const C = await import('/frontier/frontier/controller.mjs'); const B = await import('/frontier/frontier/marchbook.mjs');
  const D = await import('/frontier/frontier/fdevnetbook.mjs');
  const dp = FS.devnetPlay; const key = C.bookKey();
  if (!dp || !key || !FS.wallet) return { key, entries: null };
  const bk = await D.openDevnetBook(dp, FS.wallet.address);
  const plain = B.loadBook(B.browserStorage, key);
  return { key, db: D.DEVNET_BOOK_DB, entries: B.loadBook(bk.storage, key).map(e => ({ host: String(e.host), arriveBell: e.arriveBell, state: e.state, transitSlot: e.transitSlot ?? null, attempts: (e.attempts ?? []).map(a => ({ t: a.t ?? null, route: a.route, result: a.result })), hasPlain: typeof e.plain_b64 === 'string' && e.plain_b64.length > 0 && typeof e.salt_b64 === 'string', signature: e.signature ?? null })),
    plainLocalStorageEntries: plain.length };
});
const syncWait = async (name, secs = 3600) => {
  const f = path.join(SYNC, name), end = Date.now() + secs * 1000;
  while (!fs.existsSync(f)) { if (Date.now() > end) return hold(`timeout waiting for ${name}`); await wait(1000); }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
const marchesNow = () => ev(async () => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  return (FS.marches ?? []).map(m => ({ host: String(m.entry?.host ?? ''), arriveBell: m.entry?.arriveBell ?? null, state: m.entry?.state ?? null, pipeline: m.facts?.pipeline ?? null, slotPresent: !!m.facts?.slotPresent, transit: m.transit ? { state: m.transit.state, slot: m.transit.slot } : null }));
});

await page.goto(URL0, { waitUntil: 'load' });
await wait(2500);
let s = await connect();
log('devnet play', s.devnetPlay, 'wide', s.devnetWide, 'wallet', s.wallet);
await shot('devnet-season-connected');
await page.getByText(/^(国を選ぶ|Choose a nation)$/).first().click({ timeout: 8000 }).catch(() => log('no 国を選ぶ button (continuing)'));
await wait(1000);
await act('pick-faction', { f: String(NATION) });
s = await until('the home planner offers a rim site', x => x.homeChoice?.sel, { secs: 180, note: x => x.homeChoice });
log('home choice', s.homeChoice);
const confirm = page.locator('button[data-act="home-confirm"]:visible').first();
if (await confirm.count()) await confirm.click({ timeout: 8000 }); else await act('home-confirm');
await wait(4000);
s = await until('the rim village is settled and shown', x => x.holdings.length > 0, { secs: 900, every: 1500, note: x => ({ bell: x.bell, notice: x.notice?.text?.slice(0, 120) ?? null }) });
log('village', s.holdings, 'bell', s.bell);
await openVillage();
await shot('rim-village');
// Harvest at every new bell until the test says muster (the first harvest after final_ts flips the village final).
let lastBell = -1;
while (!fs.existsSync(path.join(SYNC, 'go-muster'))) {
  s = await state();
  if (s.bell !== null && s.bell !== lastBell && s.holdings.length) {
    lastBell = s.bell; await act('harvest'); await wait(3000);
    const a = await state(); log('harvest', { bell: s.bell, notice: a.notice?.text?.slice(0, 100) ?? null, holding: a.holdings[0] });
    continue;
  }
  await wait(1500);
}
const m = await syncWait('go-muster');
log('go-muster', m);
await openVillage();
await shot('village-before-muster');
await act('muster', { unit: '0', troops: String(m.troops), tile: String(m.tile) });
await wait(5000);
s = await state(); log('after muster', { notice: s.notice });
await shot('muster-sent');
fs.writeFileSync(path.join(SYNC, 'mustered.json'), JSON.stringify({ notice: s.notice }));
if (SCENARIO === 'home') await home();
const g = await syncWait('go-march');
log('go-march', g);
// the page's own keep march: compose onto the keep (stance by the keep's holder), the destination's route, the card
await act('cq-march', { host: String(g.host), p: String(g.p), q: String(g.q), tile: String(g.tile) });
const comp = () => ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); const c = FS.compose; return c ? { arriveBell: c.arriveBell, earliest: c.earliest ?? null, dest: c.dest, route: c.route ? { secs: c.route.secs ?? null, dirs: c.route.dirs?.length ?? null } : null, stance: c.stance, sending: !!c.sending } : null; });
let c = null; for (let i = 0; i < 40; i++) { c = await comp(); if (c?.route) break; await wait(1000); }
log('compose', c);
if (!c?.route) await hold('the keep march has no route on the page');
// (the arrival bell the test needs: the card's own stepper)
for (let i = 0; i < 6 && c.arriveBell !== g.arrive; i++) { await act('mc-bell', { d: String(Math.sign(g.arrive - c.arriveBell)) }); await wait(500); c = await comp(); }
log('compose (arrival set)', c);
if (c.arriveBell !== g.arrive) await hold(`the card cannot arrive at bell ${g.arrive}: ${JSON.stringify(c)}`);
await shot('keep-march-card');
// (the card's 封をして出発する stays disabled while the page's own read of the home province says it is not resolved
//  through b − 2 yet (fmarch.mjs NotResident): the herald folds behind the chain. Wait for the real button, composing
//  the order again every 30 s so the card reads the province anew; never dispatch a disabled send)
// (fog-devnet: since #122 a verified devnet page's card has ONE main button, 「確認した命令で出発」 — data-act
//  march-send-wait, controller.mjs armMarchWait: ready → the ordinary single send — in place of 封をして出発する; either is
//  the page's own send)
const send = page.locator('button[data-act="march-send"]:visible:enabled, button[data-act="march-send-wait"]:visible:enabled').first();
const t0send = Date.now();
while (!(await send.count())) {
  if (Date.now() - t0send > 360_000) await hold('the 封をして出発する button never became enabled');
  await wait(3000);
  if ((Date.now() - t0send) % 30_000 < 3000) {
    const cur = await comp();
    log('waiting for the send button', { compose: cur, notice: (await state()).notice });
    if (!cur) { await act('cq-march', { host: String(g.host), p: String(g.p), q: String(g.q), tile: String(g.tile) }); await wait(3000); }
  }
}
c = await comp();
if (c.arriveBell !== g.arrive) await hold(`the card moved the arrival to ${c.arriveBell}`);
log('pressing', await send.innerText().catch(() => '?'), c);
await send.click({ timeout: 8000 });
let after = null;
for (let i = 0; i < 90; i++) { await wait(1000); after = await state(); if (i > 3 && after.notice && (after.notice.ok === true || after.notice.ok === false)) break; }
log('after march-send', { notice: after?.notice });
await shot('march-sent');
const b1 = await bookNow();
log('book after the send', b1);
// RELOAD: the encrypted book must survive (the page re-reads it for the reconnected wallet)
await page.reload({ waitUntil: 'load' });
await wait(2500);
s = await connect();
await wait(4000);
const b2 = await bookNow();
log('book after the reload', b2);
fs.writeFileSync(path.join(SYNC, 'reloaded.json'), JSON.stringify({ before: b1, after: b2 }, null, 2));
await shot('after-reload');
// the march's stages as the page shows them, until the test says the war is settled
let lastShot = 0;
while (!fs.existsSync(path.join(SYNC, 'go-final'))) {
  const ms = await marchesNow(); s = await state();
  const bk = await bookNow().catch(() => null);
  log('marches', { bell: s.bell, marches: ms, book: bk?.entries ?? null });
  if (Date.now() - lastShot > 45_000) { lastShot = Date.now(); await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 3000 }).catch(() => {}); await wait(800); await shot(`marches-bell-${s.bell}`); }
  await wait(5000);
}
const fin = await syncWait('go-final');
log('go-final', fin);
await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 3000 }).catch(() => {});
await wait(1500);
await shot('marches-final');
await openVillage();
await shot('village-final');
await page.keyboard.press('Escape').catch(() => {});
await shot('map-final');
const bf = await bookNow();
fs.writeFileSync(path.join(SYNC, 'done.json'), JSON.stringify({ book: bf, marches: await marchesNow(), holdings: (await state()).holdings, stills: shotN }, null, 2));
log('done');
await wait(1000);
await browser.close();
process.exit(0);

// ------------------------------------------------------------------ P10 (devnet-page-war-2): the return march home
async function home() {
  const g = await syncWait('go-march-home');
  log('go-march-home', g);
  // the page's own way home: 「村へ戻す」 (app 'host-return' → controller 'march-home': the draft from the host to its
  // village's tile; the 軍勢 screen opens where the order card stands)
  await act('host-return', { host: String(g.host) });
  await wait(1500);
  const composed = () => ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); return !!FS.compose; });
  let via = 'host-return';
  if (!(await composed())) {
    // (the hand's own host row may not be read yet: the controller's 'march-home' — the entry host-return calls — then
    //  the 軍勢 tab, as host-return opens it)
    via = 'march-home + 軍勢 tab';
    await act('march-home', { host: String(g.host) });
    await wait(1000);
    await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 5000 }).catch(e => log('marches tab', String(e).slice(0, 120)));
    await wait(1500);
  }
  log('the way home opened via', via);
  const comp = () => ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); const c = FS.compose; return c ? { arriveBell: c.arriveBell, earliest: c.earliest ?? null, dest: c.dest, home: !!c.home, route: c.route ? { secs: c.route.secs ?? null, dirs: c.route.dirs?.length ?? null } : null, pending: c.pending ? { untilBell: c.pending.untilBell } : null, sending: !!c.sending } : null; });
  let c = null; for (let i = 0; i < 40; i++) { c = await comp(); if (c?.route) break; await wait(1000); }
  log('compose (home)', c);
  if (!c?.route || !c.home) await hold('the march home has no route on the page');
  for (let i = 0; i < 6 && c.arriveBell !== g.arrive; i++) { await act('mc-bell', { d: String(Math.sign(g.arrive - c.arriveBell)) }); await wait(500); c = await comp(); }
  if (c.arriveBell !== g.arrive) await hold(`the card cannot arrive at bell ${g.arrive}: ${JSON.stringify(c)}`);
  await shot('home-march-card');
  // what the page's own read says now: the home province's resolvedNext against the page's turn (fmarch NotResident)
  const read = () => ev(async ({ p, q }) => { const { FS } = await import('/frontier/frontier/fstate.mjs'); const rn = FS.provinces.get(`${p},${q}`)?.province?.resolvedNext ?? null;
    const items = [...document.querySelectorAll('.problems li')].map(x => x.textContent);
    return { nowBell: FS.nowBell ?? null, resolvedNext: rn, notResident: rn === null || rn + 1 < FS.nowBell, problemTexts: items, waitOn: FS.marchWaitOn === true,
      notice: FS.notice ? (typeof FS.notice.text === 'function' ? FS.notice.text() : FS.notice.text ?? null) : null }; }, { p: c.dest.p, q: c.dest.q });
  const main = page.locator('button[data-act="march-send-wait"]:visible').first();
  if (!(await main.count())) { await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 5000 }).catch(() => {}); await wait(1500); }
  const r0 = await read();
  log('before the press', r0, 'main button', await main.count(), await main.isEnabled().catch(() => null));
  if (!(await main.count())) await hold('no waiting-send button on the devnet card (FS.marchWaitOn)');
  if (!(await main.isEnabled())) await hold(`the card's main button is disabled while the home read lags: ${JSON.stringify(r0)}`);
  // ONE press (never again)
  await main.click({ timeout: 8000 });
  await wait(1500);
  const c1 = await comp(); const r1 = await read();
  fs.writeFileSync(path.join(SYNC, 'pressed.json'), JSON.stringify({ problems: r0.notResident ? ['NotResident'] : [], read: r0, armed: !!c1?.pending, compose: c1, after: r1, presses: 1 }, null, 2));
  log('pressed once', { compose: c1, read: r1 });
  await shot('home-march-waiting');
  // wait by itself: no more presses; note what the card says, until the order has left (the card closes)
  let toldWait = false;
  for (let i = 0; i < 600; i++) {
    const cur = await comp(), rd = await read();
    if (!toldWait && cur?.pending) { toldWait = true; fs.writeFileSync(path.join(SYNC, 'waiting.json'), JSON.stringify({ compose: cur, read: rd, label: await main.innerText().catch(() => null) }, null, 2)); }
    if (i % 6 === 0) log('waiting (no press)', { compose: cur, read: rd });
    if (!cur) break;
    await wait(1000);
  }
  s = await state(); log('after the waiting send', { notice: s.notice });
  await shot('home-march-sent');
  const b1 = await bookNow();
  await page.reload({ waitUntil: 'load' });
  await wait(2500);
  s = await connect();
  await wait(4000);
  const b2 = await bookNow();
  fs.writeFileSync(path.join(SYNC, 'reloaded.json'), JSON.stringify({ before: b1, after: b2 }, null, 2));
  await shot('after-reload');
  let lastShot = 0;
  while (!fs.existsSync(path.join(SYNC, 'go-final'))) {
    const ms = await marchesNow(); s = await state();
    const bk = await bookNow().catch(() => null);
    if (bk) fs.writeFileSync(path.join(SYNC, 'book.json.tmp'), JSON.stringify(bk)), fs.renameSync(path.join(SYNC, 'book.json.tmp'), path.join(SYNC, 'book.json'));
    log('marches', { bell: s.bell, marches: ms, book: bk?.entries ?? null });
    if (Date.now() - lastShot > 45_000) { lastShot = Date.now(); await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 3000 }).catch(() => {}); await wait(800); await shot(`marches-bell-${s.bell}`); }
    await wait(3000);
  }
  const fin = await syncWait('go-final');
  log('go-final', fin);
  await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 3000 }).catch(() => {});
  await wait(1500);
  await shot('marches-final');
  await openVillage();
  await shot('village-final');
  const bf = await bookNow();
  fs.writeFileSync(path.join(SYNC, 'done.json'), JSON.stringify({ book: bf, marches: await marchesNow(), holdings: (await state()).holdings, stills: shotN }, null, 2));
  log('done');
  await wait(1000);
  await browser.close();
  process.exit(0);
}
