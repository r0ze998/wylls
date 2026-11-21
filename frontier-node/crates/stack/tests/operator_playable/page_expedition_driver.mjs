// TEST-ONLY page driver of the devnet BOUNDARY DEPARTURE (devnet-p15-p9, devnet gap P15; built on P9's
// page_war_driver.mjs): headless Chromium plays the participant of a devnet wide season on the exact devnet .so,
// offline. The page is served by the herald in its devnet mode (`--cluster devnet --web`); its sends go through the
// gateway's devnet play routes behind the herald's /gw (wallet-signed, wallet-paid).
//
//   node page_expedition_driver.mjs --url http://127.0.0.1:H/frontier/frontier/ --out DIR --seed-file F --nation N
//        --inspect PORT --sync DIR
//
// The wallet is a Wallet Standard TEST wallet on `solana:devnet` registered into the page (the page's own dev-wallet
// builder over a TEST seed the Rust test made for this chain only); it signs what the page asks. Nothing here builds
// or sends a transaction: every command is pressed on the page.
//
// The sync protocol (files in <sync>; the test writes go-*, the driver writes the rest):
//   (the page founds its rim village by its home planner, then Harvests at every new bell)
//   go-muster      {troops, tile}            → the page musters on its rim village;            → mustered.json
//   go-expedition  {host, directions:[0..5], arrive}
//                  → the hand takes the host, 「境界への道を準備」 opens, the steps and the arrival turn are entered,
//                    「地形・時間を確認」 is read, 「送る内容を確認」 shows the preview      → preview.json {preview, text}
//                    「ウォレットで署名して送る」, then 「状況を確かめる」 until settled     → departed.json {status, signature, preview}
//                  → the page reloads and reconnects; the reveal half must still be in the encrypted book
//                                                                                    → reloaded.json {reveal_kept, reveals}
//   go-final       {…}                       → stills                                         → done.json
// done.json (and the last stdout line, prefixed `RESULT `) = {ok, signature, status, preview, reveal_kept, posts}; `posts` =
// every POST the page made to /gw/f/devnet-play/* as {path, body (first 400 chars)} — the plaintext and the salt are never
// in any body (asserted here too: `secret_posted` false). A failed step writes <sync>/failed.txt and holds the page
// up for PAGE_DRIVER_HOLD_SECS (default 300), then exits 1.
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
const posts = [], fullBodies = [];
page.on('pageerror', e => log('pageerror', String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') fs.appendFileSync(path.join(OUT, 'console.log'), m.text() + '\n'); });
page.on('request', q => {
  const p = new URL(q.url()).pathname;
  if (!p.includes('/gw/f/devnet-play/') && !p.endsWith('/gw/f/reveal')) return;
  const body = (q.postData() ?? '').slice(0, 400);
  if (q.method() === 'POST') { posts.push({ path: p, body }); fullBodies.push(q.postData() ?? ''); }
  fs.appendFileSync(path.join(OUT, 'devnet-play-requests.log'), `${q.method()} ${p} ${body.slice(0, 160)}\n`);
});
const shot = async name => { const f = `${String(++shotN).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(OUT, f) }); log('still', f); return f; };
const ev = (fn, a) => page.evaluate(fn, a);
const wait = ms => page.waitForTimeout(ms);
http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', async () => {
  let out; try { const c = JSON.parse(b); out = c.shot ? await shot(c.shot) : await page.evaluate(c.js); } catch (e) { out = { error: String(e).slice(0, 400) }; }
  res.end(JSON.stringify(out ?? null, (_, v) => (typeof v === 'bigint' ? String(v) : v))); }); }).listen(INSPECT, '127.0.0.1');

const state = () => ev(async () => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  const D = await import('/frontier/frontier/fdevnet-depart.mjs');
  const s = FS.expeditionCompose ?? null, d = D.devnetDepartOf(FS);
  return { bell: FS.nowBell ?? null, cluster: FS.record?.cluster ?? null, devnetPlay: FS.devnetPlay ? { relay: FS.devnetPlay.relay, seasonId: FS.devnetPlay.seasonId } : null, devnetWide: FS.devnetWide ?? null,
    wallet: FS.wallet?.address ?? null, walletList: (FS.walletList ?? []).map(w => ({ name: w.name, why: w.why ?? null })), holdings: (FS.holdings ?? []).map(h => ({ p: h.p, q: h.q, site: h.site, state: h.state })),
    homeChoice: FS.homeChoice ? { sel: FS.homeChoice.selected ?? null, err: FS.homeChoice.error?.code ?? null } : null,
    hand: FS.hand ? { host: FS.hand.host ?? null, pop: FS.hand.pop ?? null } : null,
    compose: s ? { status: s.status, error: s.error ?? null, directions: s.directions, arriveBell: s.arriveBell, endpoint: s.trace?.endpoint ? { p: String(s.trace.endpoint.p), q: String(s.trace.endpoint.q), tile: s.trace.endpoint.tile } : null,
      source: !!s.source, transitSlot: s.review?.transitSlot ?? null, route: s.routeCheck ? { status: s.routeCheck.status, code: s.routeCheck.code ?? s.routeCheck.report?.code ?? null, ok: s.routeCheck.report?.ok ?? null, min: s.routeCheck.report?.min ?? null, max: s.routeCheck.report?.max ?? null } : null } : null,
    depart: { status: d.status, busy: d.busy, error: d.error, code: d.code, signature: d.signature, sent: d.sent, chain: d.chain, preview: d.preview },
    notice: FS.notice ? { ok: FS.notice.ok, code: FS.notice.code ?? null, text: typeof FS.notice.text === 'function' ? FS.notice.text() : FS.notice.text ?? null } : null };
});
const openVillage = async () => { await page.locator('[data-act="tab"][data-tab="holding"]').first().click({ timeout: 8000 }).catch(e => log('village tab', String(e).slice(0, 120))); await wait(1500); };
const act = (a, data = {}) => ev(([a, data]) => { const b = document.createElement('button'); b.dataset.act = a; for (const [k, v] of Object.entries(data)) b.dataset[k] = v; b.style.display = 'none'; document.body.appendChild(b); b.click(); b.remove(); }, [a, data]);
/** A real, visible, enabled (not aria-disabled) button of the card. */
const press = async (a, what) => {
  const b = page.locator(`button[data-act="${a}"]:visible:not([aria-disabled="true"])`).first();
  for (let i = 0; i < 60 && !(await b.count()); i++) await wait(1000);
  if (!(await b.count())) return hold(`no enabled ${what} button (${a})`);
  log('pressing', a, await b.innerText().catch(() => '?'));
  await b.click({ timeout: 8000 });
};
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
  const s = await until('the page reads the devnet season and verifies devnet play', x => x.devnetPlay && x.walletList.some(w => w.name.startsWith('Test Wallet') && !w.why), { secs: 120, note: x => ({ cluster: x.cluster, devnetPlay: x.devnetPlay, wallets: x.walletList }) });
  await act('connect', { i: String(s.walletList.findIndex(w => w.name.startsWith('Test Wallet'))) });
  return until('the wallet is connected', x => !!x.wallet, { secs: 60 });
};
const syncWait = async (name, secs = 3600) => {
  const f = path.join(SYNC, name), end = Date.now() + secs * 1000;
  while (!fs.existsSync(f)) { if (Date.now() > end) return hold(`timeout waiting for ${name}`); await wait(1000); }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
/** The reveal halves as the page's encrypted devnet book keeps them, read through the page's own controller (never the key; the halves are reduced to "present"). */
const revealsNow = () => ev(async () => {
  const C = await import('/frontier/frontier/controller.mjs');
  const list = await C.devnetPlayDepartReveals();
  return list === null ? null : list.map(e => ({ host: e.host, transitSlot: e.transitSlot, commit: e.commit, arriveBell: e.arriveBell, signature: e.signature,
    hasPlain: typeof e.plain === 'string' && e.plain.length === 272, hasSalt: typeof e.salt === 'string' && e.salt.length === 64 }));
});

// ------------------------------------------------------------------ the rim village (as P9)
await page.goto(URL0, { waitUntil: 'load' });
await wait(2500);
let s = await connect();
log('devnet play', s.devnetPlay, 'wide', s.devnetWide, 'wallet', s.wallet);
await shot('devnet-season-connected');
await page.getByText(/^(国を選ぶ|Choose a nation)$/).first().click({ timeout: 8000 }).catch(() => log('no 国を選ぶ button (continuing)'));
await wait(1000);
await act('pick-faction', { f: String(NATION) });
s = await until('the home planner offers a rim site', x => x.homeChoice?.sel, { secs: 180, note: x => x.homeChoice });
const confirm = page.locator('button[data-act="home-confirm"]:visible').first();
if (await confirm.count()) await confirm.click({ timeout: 8000 }); else await act('home-confirm');
await wait(4000);
s = await until('the rim village is settled and shown', x => x.holdings.length > 0, { secs: 900, every: 1500, note: x => ({ bell: x.bell, notice: x.notice?.text?.slice(0, 120) ?? null }) });
log('village', s.holdings, 'bell', s.bell);
await openVillage();
await shot('rim-village');
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
await act('muster', { unit: '0', troops: String(m.troops), tile: String(m.tile) });
await wait(5000);
s = await state(); log('after muster', { notice: s.notice });
await shot('muster-sent');
fs.writeFileSync(path.join(SYNC, 'mustered.json'), JSON.stringify({ notice: s.notice }));

// ------------------------------------------------------------------ the boundary departure (P15)
const g = await syncWait('go-expedition');
log('go-expedition', g);
await page.keyboard.press('Escape').catch(() => {});
// the hand takes the host: the bar's own 次の軍勢 (one host: it), else the page's own selection by the host row
let took = 'hand-next';
for (let i = 0; i < 5; i++) { s = await state(); if (s.hand?.host === String(g.host)) break; await act('hand-next'); await wait(1500); }
s = await state();
if (s.hand?.host !== String(g.host)) {
  took = 'FS.hand (the host row, as selectHost)';
  await ev(async ({ host, p, q, tile }) => { const { FS } = await import('/frontier/frontier/fstate.mjs'); FS.selected = { kind: 'tile', p, q, idx: tile }; FS.hand = { host: String(host), pop: null }; }, { host: String(g.host), p: g.p, q: g.q, tile: g.tile });
  await wait(1500);
}
log('the hand took the host via', took, (await state()).hand);
await act('hand-pop', { pop: 'expedition-compose' });
s = await until('the boundary card opens on the host', x => x.hand?.pop === 'expedition-compose' && x.compose?.source, { secs: 60, note: x => ({ hand: x.hand, compose: x.compose }) });
for (const d of g.directions) { await act('outbound-step', { direction: String(d) }); await wait(400); }
await ev(async a => { const C = await import('/frontier/frontier/controller.mjs'); C.editOriginalOutbound('arriveBell', String(a)); }, g.arrive);
await wait(800);
s = await state();
log('the draft', s.compose);
if (s.compose?.status !== 'review') await hold(`the draft is not reviewed: ${JSON.stringify(s.compose)}`);
// the devnet card has no departure-conditions read (local play's keyless inspector)
const ctxButtons = await page.locator('button[data-act="outbound-context-read"]:visible').count();
log('context-read buttons on the devnet card', ctxButtons);
await shot('boundary-draft');
await press('outbound-route-read', '地形・時間を確認');
s = await until('the route read is in', x => x.compose?.route && x.compose.route.status !== 'loading', { secs: 60 });
log('route', s.compose.route);
if (s.compose.route.ok !== true) await hold(`the route read does not admit the draft: ${JSON.stringify(s.compose.route)}`);
await shot('route-read');
await press('outbound-devnet-preview', '送る内容を確認');
s = await until('the preview', x => !x.depart.busy && x.depart.status !== 'idle', { secs: 120, note: x => x.depart });
if (s.depart.status !== 'preview') await hold(`no preview: ${JSON.stringify(s.depart)}`);
const previewText = await page.locator('.devnet-depart-preview').first().innerText().catch(() => null);
log('preview', s.depart.preview, previewText);
fs.writeFileSync(path.join(SYNC, 'preview.json'), JSON.stringify({ preview: s.depart.preview, text: previewText, contextButtons: ctxButtons }, null, 2));
await shot('preview');
await press('outbound-devnet-send', 'ウォレットで署名して送る');
s = await until('the send ends', x => !x.depart.busy && !['preview', 'signing', 'submitting'].includes(x.depart.status), { secs: 120, note: x => x.depart });
for (let i = 0; i < 40 && ['submitted', 'unknown'].includes(s.depart.status); i++) {
  await wait(4000); await act('outbound-devnet-reconcile'); await wait(1500); s = await state(); log('status', s.depart.status, s.depart.chain, s.depart.error);
}
log('departed', s.depart);
fs.writeFileSync(path.join(SYNC, 'departed.json'), JSON.stringify({ status: s.depart.status, signature: s.depart.signature, code: s.depart.code, error: s.depart.error, preview: s.depart.preview }, null, 2));
await shot('departed');
const signature = s.depart.signature, status = s.depart.status, preview = s.depart.preview;
const before = await revealsNow();
// RELOAD: the reveal half must still be in the encrypted book
await page.reload({ waitUntil: 'load' });
await wait(2500);
s = await connect();
await wait(4000);
const after = await revealsNow();
const reveal_kept = Array.isArray(after) && after.some(e => e.signature === signature && e.hasPlain && e.hasSalt);
log('reveals', { before, after, reveal_kept });
fs.writeFileSync(path.join(SYNC, 'reloaded.json'), JSON.stringify({ reveal_kept, before, after }, null, 2));
await shot('after-reload');
// keeper A drives the rest; the page shows the map until the test says it is settled
let lastShot = 0;
while (!fs.existsSync(path.join(SYNC, 'go-final'))) {
  s = await state();
  if (Date.now() - lastShot > 45_000) { lastShot = Date.now(); log('waiting', { bell: s.bell }); await shot(`map-bell-${s.bell}`); }
  await wait(5000);
}
const fin = await syncWait('go-final');
log('go-final', fin);
await page.locator('[data-act="tab"][data-tab="marches"]').first().click({ timeout: 3000 }).catch(() => {});
await wait(1500);
await shot('marches-final');
await page.keyboard.press('Escape').catch(() => {});
await shot('map-final');
const devnetPosts = posts.filter(p => p.path.includes('/gw/f/devnet-play/'));
// (checked inside the page, against the book's own halves: only a yes/no comes out; the bodies are the full POSTs)
const secret_posted = posts.some(p => p.path.endsWith('/gw/f/reveal')) || await ev(async bodies => {
  const C = await import('/frontier/frontier/controller.mjs');
  const list = (await C.devnetPlayDepartReveals()) ?? [];
  const b64 = h => btoa(String.fromCharCode(...h.match(/../g).map(x => parseInt(x, 16))));
  return list.some(e => bodies.some(b => [e.plain, e.salt, b64(e.plain), b64(e.salt)].some(x => typeof x === 'string' && x.length > 0 && b.includes(x))));
}, fullBodies);
const result = { ok: status === 'confirmed' && reveal_kept && !secret_posted, signature, status, preview, reveal_kept, secret_posted, posts: devnetPosts, stills: shotN };
fs.writeFileSync(path.join(SYNC, 'done.json'), JSON.stringify(result, null, 2));
console.log('RESULT ' + JSON.stringify(result));
log('done');
await wait(1000);
await browser.close();
process.exit(0);
