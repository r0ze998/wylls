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
// P17 (devnet-p17, `--wide-acts`): then, after `<sync>/go-wide-acts`, the wide village's own acts from its card
// 「この遠方の村への命令」 — a refused muster (empty reserve, JA and EN), Harvest, Build (a building, the walls), Train,
// and (after `<sync>/ready-muster` → the test's `<sync>/go-muster`) Muster — each two presses (「費用を確認」, then
// 「署名して送る」), its result read back on the card; `<sync>/done-wide.json` says what the page showed.
// P18 (devnet-territory-dev, `--territory`): a territory world — the wide claim card's first press previews the site's
// TILE (ore + SOL), the second signs it, the third files the village on it. Then, on the test's `<sync>/go-tile-<n>`
// ({row, en}), 「1マス取る」 on that province row: the preview (and its English, when `en`), 「署名して取る」 → its
// signature in `<sync>/done-tile-<n>.json`; on `<sync>/go-refusal`, the same press while the land is unpaid: refused
// before anything is signed, JA and EN (`done-refusal.json`); `<sync>/go-end` ends.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../../../permutation-gateway/screens/package.json'));
const { chromium } = require('playwright-core');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const WIDE_ACTS = process.argv.includes('--wide-acts');
const TERRITORY = process.argv.includes('--territory');
const URL0 = arg('url'), OUT = arg('out'), SEED = fs.readFileSync(arg('seed-file'), 'utf8').trim(), NATION = Number(arg('nation')), INSPECT = Number(arg('inspect')), SYNC = arg('sync');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => { const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v)))).join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'drive.log'), s + '\n'); };
let shotN = 0;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: process.env.LOCALE ?? 'ja-JP' });
const page = await ctx.newPage();
page.on('pageerror', e => log('pageerror', String(e).slice(0, 300)));
// (fix-devnet-join-wait, herald-load-50 F4: the page's catch-up requests to keeper A — each answer's status, one line each)
page.on('response', r => { if (r.url().includes('/gw/f/nudge')) fs.appendFileSync(path.join(OUT, 'nudge.log'), `${((Date.now() - t0) / 1000).toFixed(1)} ${r.status()}\n`); });
page.on('console', m => { if (m.type() === 'error') fs.appendFileSync(path.join(OUT, 'console.log'), m.text() + '\n'); });
page.on('request', q => { if (q.url().includes('/gw/f/devnet-play/')) fs.appendFileSync(path.join(OUT, 'devnet-play-requests.log'), `${q.method()} ${new URL(q.url()).pathname} ${(q.postData() ?? '').slice(0, 160)}\n`); });
// (P18: every act the gateway took — its name and signature — as the gateway answered the page)
const submits = [];
page.on('response', async r => { if (r.url().includes('/gw/f/devnet-play/act/submit')) { try { const j = await r.json(); submits.push({ name: j?.name ?? null, signature: j?.signature ?? null, status: r.status(), code: j?.code ?? j?.error ?? null }); } catch { submits.push({ status: r.status() }); } } });
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
    homeChoice: FS.homeChoice ? { sel: FS.homeChoice.selected ?? null, n: (FS.homeChoice.candidates ?? []).length, cands: (FS.homeChoice.candidates ?? []).slice(0, 3), err: FS.homeChoice.error?.code ?? null, busy: !!FS.homeChoice.busy,
      // (fix-devnet-join-wait: the wait for the page's own record after a landed send, and the line the card shows for it)
      ownWait: FS.homeChoice.ownWait ?? null, waitLine: document.querySelector('[data-own-wait]')?.textContent?.slice(0, 90) ?? null } : null,
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
// (fix-devnet-join-wait: a herald that reads the chain late — devnet's finalized lag, OPERATOR_HERALD_RPC_URL's delaying
//  proxy offline — shows the season's wide land some seconds after keeper A opened it; a page that chose before then
//  saw a plain season and placed a heartland village. The page is let see the wide season first; at once otherwise.)
s = await until('the herald shows the wide season', x => x.devnetWide === true, { secs: 300, note: x => ({ wide: x.devnetWide, bell: x.bell }) });
log('wide season shown', s.devnetWide);
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
// (fix-devnet-join-wait: while the herald has not shown the page's own record, the card says it waits — a still of it
//  when it shows within a minute; not a step that fails: a herald that keeps up shows no wait at all)
for (let i = 0; i < 60; i++) { const w = await state(); if (w.homeChoice?.waitLine) { log('own-wait', w.homeChoice.ownWait, w.homeChoice.waitLine); await shot('own-wait'); break; } if (w.holdings.length) break; await wait(1000); }
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
    // (P18: the first press previews the site's tile, the second claims it, the third files the village)
    if (TERRITORY) {
      const tp = await ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); return FS.tilePreview ? { step: FS.tilePreview.step, total: String(FS.tilePreview.cost?.total ?? ''), ore: FS.tilePreview.cost?.ore ?? null } : null; });
      log('territory claim press', { preview: tp, submits: submits.slice(-2) });
      if (tp?.step === 'preview') await shot('wide-claim-tile-preview');
      if (submits.some(x => x.name === 'WideClaim' && x.signature)) claimed = true;
      continue;
    }
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
if (WIDE_ACTS) await wideActs();
if (TERRITORY) await territory();
await wait(1000);
await browser.close();
process.exit(0);

// ------------------------------------------------------------------ P17 (devnet-p17): the wide village's own acts
async function wideActs() {
  const exists = f => fs.existsSync(path.join(SYNC, f));
  while (!exists('go-wide-acts')) await wait(1000);
  log('go-wide-acts');
  const ws = () => ev(async () => {
    const { FS } = await import('/frontier/frontier/fstate.mjs'); const W = await import('/frontier/frontier/fwide.mjs');
    const e = W.selectedWide(FS), pv = FS.wideActPreview, x = e?.holding?.economy;
    const j = v => JSON.parse(JSON.stringify(v ?? null, (_, y) => (typeof y === 'bigint' ? String(y) : y)));
    return { sel: FS.wideSelect?.inventorySlot ?? null, card: !!document.querySelector('#wide-acts'), devnetPlayNames: FS.devnetPlay?.lane?.names ?? null,
      econ: x ? { state: x.state, reserve: [...x.reserve], queue: x.queue.filter(q => q.inUse).length, walls: String(x.walls), tier: x.tier, captured: String(e.holding.currentness.capturedSlot) } : null,
      pv: pv ? { step: pv.step, name: pv.name, fields: j(pv.fields), total: pv.cost ? String(pv.cost.total) : null, deposit: pv.cost ? String(pv.cost.deposit) : null, rosterNew: pv.rosterNew ?? null,
        warn: pv.warn ?? null, signature: pv.signature ?? null, result: j(pv.result) } : null,
      notice: FS.notice ? { ok: FS.notice.ok, code: FS.notice.code ?? null, text: typeof FS.notice.text === 'function' ? FS.notice.text() : FS.notice.text ?? null } : null,
      toastText: document.querySelector('.toast.tx-refused .toast-text')?.innerText ?? null, busy: !!FS.homeActionBusy, inFlight: FS.inFlight ?? 0, cardText: document.querySelector('#wide-acts')?.innerText?.slice(0, 2000) ?? null };
  });
  const untilW = async (what, ok, { secs = 120, every = 1000 } = {}) => {
    const end = Date.now() + secs * 1000; let x, n = 0;
    while (Date.now() < end) { x = await ws(); if (ok(x)) return x; if (n++ % 15 === 0) log(what, { pv: x.pv, notice: x.notice, econ: x.econ, card: x.card }); await wait(every); }
    log('TIMEOUT', what, x); return hold(`timeout: ${what}`);
  };
  // the wide village on the village screen: its rail pip (W2)
  const selectWide = async () => {
    for (let i = 0; i < 20; i++) {
      if ((await ws()).card) return;
      // (the village tab toggles its panel: pressed only while no village screen is open)
      const open = await page.locator('#hp-build:visible, .wide-village:visible').count();
      if (!open) await openVillage();
      const pip = page.locator('[data-act="wide-select"]').first();
      if (await pip.count()) await pip.click({ timeout: 5000 }).catch(e => log('pip', String(e).slice(0, 120)));
      await wait(2000);
    }
  };
  await selectWide();
  let x = await untilW('the wide village acts card stands', y => y.card && y.econ, { secs: 180, every: 2000 });
  log('card', { econ: x.econ, names: x.devnetPlayNames });
  await page.locator('#wide-acts').scrollIntoViewIfNeeded().catch(() => {});
  await shot('wide-acts-card');
  const form = name => page.locator(`#wide-acts form[data-wide-act="${name}"]`);
  const clear = () => ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); FS.notice = null; });
  // (a press the page refuses before anything is signed: the notice, in Japanese and in English)
  const refusal = {};
  const Lg = '/frontier/lang.mjs';
  for (const lang of ['ja', 'en']) {
    await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, lang]);
    await wait(1000); await clear();
    const f = form('WideMuster');
    await f.locator('input[name="troops"]').fill('100');
    await f.locator('button[type="submit"]').click({ timeout: 8000 });
    const y = await untilW(`the ${lang} refusal of a muster with an empty reserve`, z => z.notice && z.notice.ok === false && z.notice.code, { secs: 90 });
    refusal[lang] = { code: y.notice.code, text: y.notice.text, preview: y.pv };
    log('refusal', lang, refusal[lang]);
    await shot(`wide-refusal-${lang}`);
    if (lang === 'en') { await page.locator('#wide-acts').scrollIntoViewIfNeeded().catch(() => {}); await shot('wide-acts-card-en'); refusal.cardTextEn = (await ws()).cardText; }
  }
  await ev(async m => { (await import(m)).setLang('ja'); }, Lg);
  await wait(1000); await clear();
  const acts = [];
  const doAct = async (name, label, fill) => {
    await selectWide();
    const f = form(name);
    await fill(f);
    const before = (await ws()).econ;
    await f.locator('button[type="submit"]').click({ timeout: 8000 });
    const p = await untilW(`the preview of ${label}`, z => (z.pv?.step === 'preview' && z.pv.name === name) || (z.notice?.ok === false && !z.busy), { secs: 120 });
    if (p.pv?.step !== 'preview') { acts.push({ name, label, refused: p.notice }); log('refused', label, p.notice); await shot(`wide-${label}-refused`); return; }
    log('preview', label, p.pv);
    await page.locator('#wide-acts').scrollIntoViewIfNeeded().catch(() => {});
    await shot(`wide-${label}-preview`);
    const previewText = p.cardText;
    await page.locator('#wide-acts button[data-act="wide-act-send"]').click({ timeout: 8000 });
    const r = await untilW(`the result of ${label}`, z => (z.pv?.step === 'sent' && z.pv.result) || (!z.pv && z.notice?.ok === false && !z.busy), { secs: 240, every: 1500 });
    log('result', label, r.pv, r.notice);
    await page.locator('#wide-acts').scrollIntoViewIfNeeded().catch(() => {});
    await shot(`wide-${label}-result`);
    acts.push({ name, label, before, preview: p.pv, previewText, sent: r.pv, notice: r.notice, after: r.econ, resultText: r.cardText });
    await clear();
  };
  await doAct('WideHarvest', 'harvest', async () => {});
  await doAct('WideBuild', 'build-farm', async f => { await f.locator('select[name="wide_item"]').selectOption('0'); });
  await doAct('WideBuild', 'build-walls', async f => { await f.locator('select[name="wide_item"]').selectOption('6'); });
  await doAct('WideTrain', 'train-100', async f => { await f.locator('select[name="unit"]').selectOption('0'); await f.locator('input[name="n"]').fill('100'); });
  // (verify-pr151) a muster while the province's previous turn is NOT resolved (the test declares it two bells behind):
  // the page's own checks pass (a lag warning only), the second press is refused by the chain's preflight — not sent,
  // nothing paid — and said in Japanese and in English
  fs.writeFileSync(path.join(SYNC, 'ready-chain-refusal'), String(Date.now()));
  while (!exists('go-chain-refusal')) await wait(500);
  const chainRefusal = {};
  for (const lang of ['ja', 'en']) {
    await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, lang]);
    await wait(1000); await clear();
    await selectWide();
    const f = form('WideMuster');
    await f.locator('select[name="unit"]').selectOption('0'); await f.locator('input[name="troops"]').fill('100'); await f.locator('select[name="tile"]').selectOption('-1');
    await f.locator('button[type="submit"]').click({ timeout: 8000 });
    const p = await untilW(`the ${lang} preview of a muster on an unresolved province`, z => (z.pv?.step === 'preview' && z.pv.name === 'WideMuster') || (z.notice?.ok === false && !z.busy), { secs: 120 });
    if (p.pv?.step !== 'preview') { chainRefusal[lang] = { stage: 'page', code: p.notice?.code ?? null, text: p.notice?.text ?? null }; log('chain-refusal: page refused', lang, p.notice); continue; }
    await page.locator('#wide-acts').scrollIntoViewIfNeeded().catch(() => {});
    await shot(`wide-chain-refusal-preview-${lang}`);
    await clear();
    await page.locator('#wide-acts button[data-act="wide-act-send"]').click({ timeout: 8000 });
    const r = await untilW(`the ${lang} chain refusal of that muster`, z => (z.notice?.ok === false && !z.busy && z.pv?.step !== 'preview' && (z.notice.text || z.toastText)) || z.pv?.step === 'sent', { secs: 180, every: 1500 });
    chainRefusal[lang] = { stage: r.pv?.step === 'sent' ? 'sent' : 'send', warn: p.pv.warn, code: r.notice?.code ?? null, text: r.notice?.text ?? r.toastText ?? null, toastText: r.toastText, pv: r.pv };
    log('chain-refusal', lang, chainRefusal[lang]);
    await shot(`wide-chain-refusal-${lang}`);
  }
  await ev(async m => { (await import(m)).setLang('ja'); }, Lg);
  await wait(1000); await clear();
  // (the muster reads the province's turn: the test declares it resolved now, then says go)
  fs.writeFileSync(path.join(SYNC, 'ready-muster'), String(Date.now()));
  while (!exists('go-muster')) await wait(500);
  await doAct('WideMuster', 'muster-100', async f => { await f.locator('select[name="unit"]').selectOption('0'); await f.locator('input[name="troops"]').fill('100'); await f.locator('select[name="tile"]').selectOption('-1'); });
  const end = await ws();
  fs.writeFileSync(path.join(SYNC, 'done-wide.json'), JSON.stringify({ refusal, chainRefusal, acts, end, stills: shotN }, null, 2));
  log('done-wide');
}

// ------------------------------------------------------------------ P18 (devnet-territory-dev): tiles on the devnet page
async function territory() {
  const exists = f => fs.existsSync(path.join(SYNC, f));
  const Lg = '/frontier/lang.mjs';
  const ts = () => ev(async () => {
    const { FS } = await import('/frontier/frontier/fstate.mjs');
    const pv = FS.tilePreview;
    return { pv: pv ? { step: pv.step, target: pv.target, tile: pv.tile, total: String(pv.cost.total), ore: pv.cost.ore, deposit: String(pv.cost.deposit),
        provinceDeposit: String(pv.cost.provinceDeposit), playerDeposit: String(pv.cost.playerDeposit), fee: String(pv.cost.fee), provinceNew: pv.cost.provinceNew, playerNew: pv.cost.playerNew, tiles: pv.tiles } : null,
      notice: FS.notice ? { ok: FS.notice.ok, code: FS.notice.code ?? null, text: typeof FS.notice.text === 'function' ? FS.notice.text() : FS.notice.text ?? null } : null,
      toastText: document.querySelector('.toast .toast-text')?.innerText ?? null, busy: !!FS.homeActionBusy,
      previewText: document.querySelector('#hp-tile-preview')?.innerText ?? null, devnetTerritory: FS.devnetTerritory ?? null,
      rows: [...document.querySelectorAll('#hp-wide button[data-act="territory-tile"]')].map(b => ({ p: b.dataset.p, q: b.dataset.q, disabled: b.disabled })) };
  });
  const untilT = async (what, ok, { secs = 120, every = 1000 } = {}) => {
    const end = Date.now() + secs * 1000; let x, n = 0;
    while (Date.now() < end) { x = await ts(); if (ok(x)) return x; if (n++ % 15 === 0) log(what, x); await wait(every); }
    log('TIMEOUT', what, x); return hold(`timeout: ${what}`);
  };
  const clear = () => ev(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs'); FS.notice = null; });
  // the village screen with its wide claim card (the tab toggles: pressed only while the card is not shown)
  const showCard = async () => {
    for (let i = 0; i < 10; i++) {
      const x = await ts();
      if (x.rows.length) return x;
      // (the wide village's own screen hides the first home's card: back to the ordinary village first)
      const back = page.locator('button[data-act="wide-close"]:visible').first();
      if (await back.count()) { await back.click({ timeout: 5000 }).catch(() => {}); await wait(1500); continue; }
      const open = await page.locator('#hp-build:visible').count();
      if (!open) await openVillage(); else await wait(1500);
    }
    return ts();
  };
  for (let n = 1; ; n++) {
    while (!exists(`go-tile-${n}`) && !exists('go-refusal') && !exists('go-end')) await wait(500);
    if (!exists(`go-tile-${n}`)) break;
    const go = JSON.parse(fs.readFileSync(path.join(SYNC, `go-tile-${n}`), 'utf8'));
    await clear();
    let x = await showCard();
    log(`tile ${n}: rows`, x.rows, 'devnetTerritory', x.devnetTerritory);
    const row = x.rows.filter(r => !r.disabled)[go.row];
    if (!row) return hold(`tile ${n}: no enabled row ${go.row}: ${JSON.stringify(x.rows)}`);
    await page.locator(`#hp-wide button[data-act="territory-tile"][data-p="${row.p}"][data-q="${row.q}"]`).click({ timeout: 8000 });
    x = await untilT(`tile ${n}: the preview`, y => y.pv?.step === 'preview' || (y.notice?.ok === false && !y.busy), { secs: 120 });
    if (x.pv?.step !== 'preview') return hold(`tile ${n}: refused at the preview: ${JSON.stringify(x.notice)}`);
    await page.locator('#hp-tile-preview').scrollIntoViewIfNeeded().catch(() => {});
    await shot(`tile-${n}-preview`);
    const preview = x.pv, text = x.previewText;
    let textEn = null;
    if (go.en) {
      await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, 'en']);
      await wait(1200);
      textEn = (await ts()).previewText;
      await page.locator('#hp-tile-preview').scrollIntoViewIfNeeded().catch(() => {});
      await shot(`tile-${n}-preview-en`);
      await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, 'ja']);
      await wait(1200);
    }
    const before = submits.length;
    await page.locator('#hp-tile-preview button[data-act="territory-tile"], #hp-tile-preview button[data-act="wide-claim"]').first().click({ timeout: 8000 });
    await untilT(`tile ${n}: the gateway takes the signed claim`, () => submits.slice(before).some(s => s.name === 'TerritoryClaim' && s.signature), { secs: 120 });
    const sent = submits.slice(before).find(s => s.name === 'TerritoryClaim');
    const after = await untilT(`tile ${n}: the page's answer`, y => !y.busy && y.notice, { secs: 120 });
    await shot(`tile-${n}-sent`);
    log(`tile ${n}`, { preview, sent, notice: after.notice });
    fs.writeFileSync(path.join(SYNC, `done-tile-${n}.json`), JSON.stringify({ target: preview.target, tile: preview.tile, preview, signature: sent.signature, notice: after.notice, text, text_en: textEn }, null, 2));
  }
  if (exists('go-refusal')) {
    const go = JSON.parse(fs.readFileSync(path.join(SYNC, 'go-refusal'), 'utf8'));
    const out = { sent: false };
    const before = submits.length;
    for (const lang of ['ja', 'en']) {
      await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, lang]);
      await wait(1200); await clear();
      const x = await showCard();
      const row = x.rows.filter(r => !r.disabled)[go.row] ?? x.rows[0];
      if (!row) return hold(`refusal: no row: ${JSON.stringify(x.rows)}`);
      await page.locator(`#hp-wide button[data-act="territory-tile"][data-p="${row.p}"][data-q="${row.q}"]`).click({ timeout: 8000 });
      const y = await untilT(`the ${lang} refusal of a claim while unpaid`, z => z.notice?.ok === false && !z.busy, { secs: 120 });
      out[lang] = { code: y.notice.code, text: y.notice.text, toast: y.toastText, preview: y.pv };
      log('refusal', lang, out[lang]);
      await shot(`tile-refusal-unpaid-${lang}`);
    }
    await ev(async ([m, l]) => { (await import(m)).setLang(l); }, [Lg, 'ja']);
    out.sent = submits.length > before;
    fs.writeFileSync(path.join(SYNC, 'done-refusal.json'), JSON.stringify(out, null, 2));
  }
  while (!exists('go-end')) await wait(500);
  await shot('territory-end');
  log('done-territory');
}
