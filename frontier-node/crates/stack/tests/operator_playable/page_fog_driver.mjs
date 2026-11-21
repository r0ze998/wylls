// TEST-ONLY observer driver of operator_playable PFOG (fog-devnet): the fog of war on the DEVNET page path, offline.
// Two more players of the devnet season — B (the nation holding the keep player A marches on) and C (a third nation, far
// away) — whose Join and rim tickets the Rust test sent with TEST keys, each open the devnet page in headless Chromium
// with a Wallet Standard TEST wallet on `solana:devnet` (as page_war_driver.mjs registers player A's). Nothing here
// sends anything: the observers only look. Player A's own page (page_war_driver.mjs) is read through its inspection
// listener (`--a-inspect`): the same snapshot code runs in all three pages.
//
//   node page_fog_driver.mjs --url U --out DIR --sync DIR --seed-b F --seed-c F --a-inspect PORT --focus JSON
//
// On the test's word `<sync>/fog-go-<label>.json` every page writes `<sync>/fog-<who>-<label>.json`: what its survey
// says of the focus places (player A's march origin, the keep, each player's village), the RAW records the page read
// from the herald beside the FOGGED copies its surfaces show, the chronicle's DEPART / CLASH records raw vs told, the
// clash report gate, the keep lists, the spectate links and the 「記録」 button — and stills of the map at the keep and of
// 全体図 (`<out>/<who>/`). `<sync>/fog-ready.json` once both observers have their village and the fog is on.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../../../../permutation-gateway/screens/package.json'));
const { chromium } = require('playwright-core');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const URL0 = arg('url'), OUT = arg('out'), SYNC = arg('sync'), A_INSPECT = Number(arg('a-inspect'));
const FOCUS = JSON.parse(arg('focus'));
const SEEDS = { B: fs.readFileSync(arg('seed-b'), 'utf8').trim(), C: fs.readFileSync(arg('seed-c'), 'utf8').trim() };
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => { const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`; console.log(s); fs.appendFileSync(path.join(OUT, 'fog-drive.log'), s + '\n'); };
const fail = why => { log('FAILED', why); fs.writeFileSync(path.join(SYNC, 'fog-failed.txt'), String(why)); setTimeout(() => process.exit(1), 2000); };
process.on('unhandledRejection', e => fail(String(e?.stack ?? e).slice(0, 600)));

// ---- the snapshot, evaluated in a page (a string: it also goes through player A's inspection listener)
const SNAP = focus => `(async (focus) => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  const F = await import('/frontier/frontier/map/fog.mjs');
  const sv = FS.survey, fog = F.fogNow();
  const lv = (p, q, t) => (sv && Number.isInteger(t) ? sv.levelOf(p, q, t) : null);
  const kind = (p, q) => { try { return sv?.province?.(p, q)?.kind ?? null; } catch { return null; } };
  const find = (ovs, p, q) => { for (const o of ovs?.values?.() ?? []) { const r = (o?.provinces ?? []).find(x => x.p === p && x.q === q); if (r) return r; } return null; };
  const brief = r => r && { owners: [...(r.owners ?? [])], sites: [...(r.sites ?? [])], hosts: [...(r.hosts ?? [])], clash: !!r.clash, control: r.control ?? null, keepTile: r.keepTile ?? null, keepTroops: r.keepTroops ?? null, fog: r.fog ?? null };
  const places = {};
  for (const [name, x] of Object.entries(focus)) places[name] = { p: x.p, q: x.q, tile: x.tile ?? null, level: lv(x.p, x.q, x.tile), province: kind(x.p, x.q),
    raw: brief(find(FS.overviews, x.p, x.q)), shown: brief(find(F.viewOverviews(FS), x.p, x.q)) };
  const mine = r => { try { return !!FS.isMine?.(r); } catch { return false; } };
  const recs = (FS.chronicle ?? []).map(x => x.record ?? x).filter(r => r.name === 'DEPART' || r.name === 'CLASH');
  const chronicle = recs.map(r => ({ name: r.name, bell: Number(r.bell), p: r.p ?? null, q: r.q ?? null, host: r.host_id != null ? String(r.host_id) : null,
    origin: r.origin_p != null ? [Number(r.origin_p), Number(r.origin_q), Number(r.origin_tile)] : null, arrive: r.arrive_bell != null ? Number(r.arrive_bell) : null, told: F.viewRecord(r, mine), mine: mine(r) }));
  const K = focus.keep;
  const keepsRaw = FS.conquest?.keeps instanceof Map ? [...FS.conquest.keeps.keys()] : [];
  const keepsShown = FS.conquest?.keeps instanceof Map ? [...F.viewKeeps(FS.conquest.keeps).keys()] : [];
  return { bell: FS.nowBell ?? null, faction: FS.citizen?.faction ?? null, wallet: FS.wallet?.address ?? null,
    holdings: (FS.holdings ?? []).map(h => ({ p: h.p, q: h.q, site: h.site, tile: h.tile })),
    fogMode: F.fogModeOf(FS), fogActive: F.fogActive(FS), fogOn: !!fog.on, devnetPlay: !!FS.devnetPlay, cluster: FS.pin?.cluster ?? null,
    surveyTiles: sv?.tiles?.size ?? null, places, chronicle,
    clashAtKeep: { offered: F.viewClash({ p: K.p, q: K.q, keepTile: K.tile }), keepTileLevel: lv(K.p, K.q, K.tile) },
    keeps: { raw: keepsRaw, shown: keepsShown }, incoming: (FS.incoming ?? []).map(w => ({ bell: w.bell })),
    spectateLinks: document.querySelectorAll('a[href="spectate.html"]').length,
    recordSheetButton: !!document.querySelector('[data-map="wide"]'),
    fogMemoryKeys: Object.keys(localStorage).filter(k => k.startsWith('ps-ffog:')),
    legendFog: !!document.querySelector('.survey-fog') };
})(${JSON.stringify(focus)})`;

const SHOT_JS = (p, q, zoom) => `(() => { document.querySelector('[data-act=hand-close]')?.click(); globalThis.__wyllsMap?.flyTo?.({ p: ${p}, q: ${q}, zoom: ${zoom} }); return 1; })()`;
const CHART_JS = `(() => { const b = document.querySelector('[data-map=chart]'); if (b) b.click(); return !!b; })()`;

// ---- player A's page, through its driver's inspection listener
const postA = body => new Promise((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port: A_INSPECT, method: 'POST', path: '/' }, r => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
  q.on('error', rej); q.end(JSON.stringify(body));
});
const pageA = { who: 'A', eval: js => postA({ js }), shot: name => postA({ shot: `fog-${name}` }) };

// ---- the two observers
const browser = await chromium.launch({ headless: true });
const register = (page, seedHex) => page.evaluate(async seedHex => {
  const W = await import('/frontier/wallet.mjs'); const S = await import('/frontier/session.mjs');
  const seed = Uint8Array.from(seedHex.match(/../g).map(h => parseInt(h, 16)));
  const w = W.devWallet(await S.keyFromSeed(seed));
  const acct = Object.freeze({ ...w.accounts[0], chains: ['solana:devnet'] });
  const wallet = { ...w, name: 'Test Wallet (devnet, offline)', chains: ['solana:devnet'], accounts: [acct],
    features: { ...w.features, 'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [acct] }) } } };
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: api => api.register(wallet) }));
}, seedHex);
const stateOf = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/frontier/fstate.mjs');
  return { devnetPlay: !!FS.devnetPlay, wallet: FS.wallet?.address ?? null, walletList: (FS.walletList ?? []).map(w => ({ name: w.name, why: w.why ?? null })), holdings: (FS.holdings ?? []).length, fogOn: !!FS.fog?.on, bell: FS.nowBell ?? null };
});
async function open(who) {
  const dir = path.join(OUT, who); fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: process.env.LOCALE ?? 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', e => log(who, 'pageerror', String(e).slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error') fs.appendFileSync(path.join(dir, 'console.log'), m.text() + '\n'); });
  // (an observer sends nothing: any devnet play POST is logged, and the test asserts there is none)
  page.on('request', q => { if (q.method() === 'POST' && q.url().includes('/gw/')) fs.appendFileSync(path.join(dir, 'posts.log'), `${q.method()} ${new URL(q.url()).pathname}\n`); });
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  await register(page, SEEDS[who]);
  const until = async (what, ok, secs) => { const end = Date.now() + secs * 1000; let s; while (Date.now() < end) { s = await stateOf(page); if (ok(s)) return s; await page.waitForTimeout(1500); } throw new Error(`${who}: timeout: ${what} ${JSON.stringify(s)}`); };
  const s = await until('devnet play and the test wallet', x => x.devnetPlay && x.walletList.some(w => w.name.startsWith('Test Wallet') && !w.why), 180);
  await page.evaluate(i => { const b = document.createElement('button'); b.dataset.act = 'connect'; b.dataset.i = String(i); b.style.display = 'none'; document.body.appendChild(b); b.click(); b.remove(); }, s.walletList.findIndex(w => w.name.startsWith('Test Wallet')));
  const v = await until('the observer\'s village and the fog', x => !!x.wallet && x.holdings > 0 && x.fogOn, 600);
  // (a returning player first sees the title: its 「村へ戻る」 opens the map)
  await page.locator('button[data-act="intro-close"]:visible').first().click({ timeout: 8000 }).catch(() => log(who, 'no title button (continuing)'));
  await page.waitForTimeout(2500);
  log(who, 'ready', v);
  let n = 0;
  // (between snapshots an observer's tab is FROZEN — CDP Page.setWebLifecycleState — so three pages do not compete with
  //  player A's for the machine: run1's A tab crashed under load. It is made active again, and given 20 s to read the
  //  herald, before each snapshot)
  const cdp = await ctx.newCDPSession(page);
  const life = state => cdp.send('Page.setWebLifecycleState', { state }).catch(e => log(who, 'lifecycle', state, String(e).slice(0, 120)));
  return { who, page, life, eval: js => page.evaluate(js), shot: async name => { const f = `${String(++n).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(dir, f) }); return f; } };
}
const B = await open('B'), C = await open('C');
await B.life('frozen'); await C.life('frozen');
fs.writeFileSync(path.join(SYNC, 'fog-ready.json'), JSON.stringify({ at: Date.now() }));
log('both observers ready');

const K = FOCUS.keep;
const WAIT_JS = w => `(async () => { const { FS } = await import('/frontier/frontier/fstate.mjs');
  for (const o of FS.overviews?.values?.() ?? []) { const r = (o?.provinces ?? []).find(x => x.p === ${w.p} && x.q === ${w.q}); if (r) return (r.hosts?.[${w.faction}] ?? 0) > 0; } return false; })()`;
async function snapshot(pg, label, go) {
  // (the herald's record catching up: at most 90 s for the host the test says stands there)
  if (go?.waitHosts) { const end = Date.now() + 90_000; let got = false; while (Date.now() < end && !(got = !!(await pg.eval(WAIT_JS(go.waitHosts)).catch(() => false)))) await new Promise(r => setTimeout(r, 3000)); log(pg.who, label, 'raw host there', got); }
  const s = await pg.eval(SNAP(FOCUS));
  const shots = [];
  // (player A's own driver is pressing its march: its camera is not moved before the end, only its view is shot)
  if (pg.who === 'A' && label !== 'final') { try { shots.push(await pg.shot(`${label}-view`)); } catch (e) { log('A', 'still failed', String(e).slice(0, 200)); } s.stills = shots; fs.writeFileSync(path.join(SYNC, `fog-${pg.who}-${label}.json`), JSON.stringify(s)); fs.mkdirSync(path.join(OUT, 'A'), { recursive: true }); fs.writeFileSync(path.join(OUT, 'A', `snapshot-${label}.json`), JSON.stringify(s, null, 1)); return; }
  try {
    await pg.eval(SHOT_JS(K.p, K.q, 0.6)); await new Promise(r => setTimeout(r, 3500));
    shots.push(await pg.shot(`${label}-map-at-keep`));
    const own = s.holdings?.[0];
    if (own) { await pg.eval(SHOT_JS(own.p, own.q, 0.35)); await new Promise(r => setTimeout(r, 3500)); shots.push(await pg.shot(`${label}-map-own`)); }
    if (await pg.eval(CHART_JS)) { await new Promise(r => setTimeout(r, 3500)); shots.push(await pg.shot(`${label}-chart`)); await pg.eval(CHART_JS); }
  } catch (e) { log(pg.who, 'still failed', String(e).slice(0, 200)); }
  s.stills = shots;
  fs.writeFileSync(path.join(SYNC, `fog-${pg.who}-${label}.json`), JSON.stringify(s));
  fs.mkdirSync(path.join(OUT, pg.who), { recursive: true });
  fs.writeFileSync(path.join(OUT, pg.who, `snapshot-${label}.json`), JSON.stringify(s, null, 1));
  log(pg.who, label, { fogOn: s.fogOn, mode: s.fogMode, clash: s.clashAtKeep, keeps: s.keeps.shown, told: s.chronicle.filter(c => c.told).map(c => c.name), raw: s.chronicle.map(c => c.name) });
}
const done = new Set();
for (;;) {
  for (const f of fs.readdirSync(SYNC)) {
    const m = /^fog-go-(.+)\.json$/.exec(f);
    if (!m || done.has(m[1])) continue;
    done.add(m[1]);
    let go = null; try { go = JSON.parse(fs.readFileSync(path.join(SYNC, f), 'utf8')); } catch { go = null; }
    await B.life('active'); await C.life('active');
    await new Promise(r => setTimeout(r, 20_000));
    for (const pg of [pageA, B, C]) await snapshot(pg, m[1], go).catch(e => log(pg.who, 'snapshot failed', String(e).slice(0, 300)));
    if (m[1] !== 'final') { await B.life('frozen'); await C.life('frozen'); }
    fs.writeFileSync(path.join(SYNC, `fog-done-${m[1]}.json`), JSON.stringify({ at: Date.now() }));
    if (m[1] === 'final') { await browser.close(); process.exit(0); }
  }
  await new Promise(r => setTimeout(r, 1000));
}
