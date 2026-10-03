// One scripted "friend" for the playtest rehearsals (PT-B): opens the game page in a
// headless Chromium, connects the wallet the page offers (the dev wallet on a
// loopback page, or the playtest guest key), joins a nation, waits for the
// village, builds, trains and musters Spearmen, composes a sealed march on the
// nearest camp (or home tile) and departs. It logs every step with a time, every
// non-2xx answer of the relay and every notice the page shows, and exits 0 only
// when the Depart landed. It reads the page; it never edits it.
//
//   node scripts/playtest/play-one.mjs --herald http://127.0.0.1:41110 [--faction 1]
//        [--lang en|ja] [--entry /frontier/frontier/index.html] [--invite CODE]
//        [--wait-min 25] [--shots DIR] [--until join|village|march]
//
// Needs scripts/playtest/node_modules -> a playwright-core install (a symlink
// to permutation-gateway/screens/node_modules of a worktree that has one).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const HERALD = String(arg('herald', 'http://127.0.0.1:41110')).replace(/\/$/, '');
const FACTION = Number(arg('faction', 1));
const LANG = arg('lang', 'en');
const ENTRY = arg('entry', '/frontier/frontier/index.html');
const INVITE = arg('invite', '');
const WAIT_MS = Number(arg('wait-min', 25)) * 60_000;
const SHOTS = arg('shots', '');
const UNTIL = arg('until', '');
const STALE = process.argv.includes('--stale-depart');
// --emulate-tunnel: the page is opened as https://wylls.test:<port> (scripts/playtest/fake-tunnel.mjs: mapped
// to 127.0.0.1, a throw-away certificate), so it is NOT a loopback page: no dev wallet, exactly what a friend behind the tunnel
// sees (only the guest key). --landing: start at the playtest start page with the invitation in the fragment.
const TUNNEL = process.argv.includes('--emulate-tunnel');
const LANDING = process.argv.includes('--landing');
const HAMMER = Number(arg('hammer', 0)); // after the village appears: send this many Harvests as fast as the page can (quota / signer-limit check)
if (/:(4185|4190|4191|4194|41300|41[4-9]\d\d)\b/.test(HERALD)) { console.error(`refusing ${HERALD}`); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { refusals: [], notices: [], http: [] };

const hu = new URL(HERALD);
const browser = await chromium.launch(TUNNEL ? { args: [`--host-resolver-rules=MAP ${hu.hostname} 127.0.0.1`] } : {});
const context = await browser.newContext({ ignoreHTTPSErrors: TUNNEL, viewport: { width: 1280, height: 900 }, locale: LANG === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'Asia/Tokyo' });
const page = await context.newPage();
page.on('pageerror', e => log('PAGEERROR', String(e.message).slice(0, 200)));
const relayCodes = {};
page.on('response', async r => {
  const u = r.url();
  if (/\/gw\/f\/relay$/.test(u) && r.request().method() === 'POST') { let c = String(r.status()); try { const j = await r.json(); c = j.code ? `${r.status()} ${j.code}` : c; } catch { /* not JSON */ } relayCodes[c] = (relayCodes[c] ?? 0) + 1; }
  if (!/\/gw\//.test(u) || r.status() < 400) return;
  let body = '';
  try { body = (await r.text()).slice(0, 220); } catch { /* gone */ }
  const line = `${r.request().method()} ${new URL(u).pathname} -> ${r.status()} ${body}`;
  out.http.push(line);
  log('HTTP', line);
});

const shot = async id => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${id}.png`) }).catch(() => {}); };
const fs = expr => page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); return (${expr}); })()`).catch(() => null);
const has = sel => page.locator(sel).count().then(n => n > 0);
const click = async (sel, what) => { log('click', what ?? sel); await page.locator(sel).first().click({ timeout: 15_000 }); };
const waitSel = async (sel, what, timeout = WAIT_MS) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await has(sel)) return; await sleep(700); }
  await shot(`timeout-${what.replace(/\W+/g, '-')}`);
  throw new Error(`timed out waiting for ${what} (${sel})`);
};
const notice = async () => page.evaluate(() => { const x = document.querySelector('.notice'); return x ? { cls: x.className, text: x.textContent.trim() } : null; });
/**
 * Wait for the action notice to settle (not busy) and return it. A previous refusal stays on screen
 * while a march is sealed (about 1-2 s, no busy notice yet), so the notice that was there when the
 * action was pressed (`before`) is not accepted as the answer: wait for a busy notice or for a
 * different one first (the 2026-10-01 recorder read the stale refusal this way and gave up on a
 * Depart that had in fact landed).
 */
async function settled(what, timeout = 180_000, before = null) {
  const end = Date.now() + timeout;
  const key = n => (n ? `${n.cls}|${n.text}` : '');
  const startWait = Date.now() + 12_000;
  while (Date.now() < startWait) {
    const n = await notice();
    if (n && (/\bbusy\b/.test(n.cls) || key(n) !== key(before))) break;
    await sleep(150);
  }
  while (Date.now() < end) {
    const n = await notice();
    if (n && !/\bbusy\b/.test(n.cls)) { log('notice', what, JSON.stringify(n)); out.notices.push({ what, ...n }); return n; }
    await sleep(400);
  }
  throw new Error(`no notice for ${what}`);
}
const okNotice = n => n && /\bok\b/.test(n.cls);
const nudgeIfOffered = async () => { if (await has('[data-act="nudge"]:not([disabled])')) { log('click nudge (catch-up)'); await page.locator('[data-act="nudge"]:not([disabled])').first().click().catch(() => {}); } };

async function submitForm(form, values, what) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const noticeBefore = await notice();
    const ok = await page.evaluate(([form, values]) => {
      const f = document.querySelector(`form[data-form="${form}"]`);
      const b = f?.querySelector('button[type="submit"]:not([disabled])');
      if (!f || !b) return false;
      for (const [name, value] of Object.entries(values)) {
        const el = f.querySelector(`[name="${name}"]`);
        if (!el || (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(value)))) return false;
        el.value = String(value);
      }
      b.click();
      return true;
    }, [form, values]);
    if (ok) { const n = await settled(what, 180_000, noticeBefore); if (okNotice(n)) return true; out.refusals.push(`${what}: ${n.text}`); }
    await sleep(3000);
  }
  return false;
}

try {
  if (LANDING) {
    await page.goto(`${HERALD}/frontier/frontier/playtest/${INVITE ? `#${INVITE}` : ''}`);
    await page.waitForFunction(() => document.getElementById('card-title')?.textContent && !/…|Checking|確認しています/.test(document.getElementById('card-title').textContent), null, { timeout: 30_000 });
    const card = await page.evaluate(() => ({ title: document.getElementById('card-title').textContent, body: document.getElementById('card-body').textContent, tone: document.getElementById('card').dataset.tone, go: !document.getElementById('go').hidden }));
    log('landing', JSON.stringify(card));
    await shot('00-landing');
    if (!card.go) throw new Error(`the start page does not offer to start: ${card.title}`);
    await page.locator('#go').click();
  }
  else await page.goto(`${HERALD}${ENTRY}`);
  await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? ''), null, { timeout: 60_000 });
  if (LANG === 'en' && (await page.evaluate(() => document.documentElement.lang)) !== 'en') {
    await page.locator('#lang-box [data-lang-toggle]').click(); await page.waitForFunction(() => document.documentElement.lang === 'en');
  }
  if (LANG === 'ja' && (await page.evaluate(() => document.documentElement.lang)) !== 'ja') {
    await page.locator('#lang-box [data-lang-toggle]').click(); await page.waitForFunction(() => document.documentElement.lang === 'ja');
  }
  await sleep(1500);
  if (await has('[data-act="intro-close"]')) await click('[data-act="intro-close"]', 'close the intro');
  if (await has('[data-act="ob-dismiss"]')) await click('[data-act="ob-dismiss"]', 'close the guide');
  await shot('01-start');

  // ------------------------------------------------------------ join
  await waitSel('[data-act="connect"]:not([disabled]), [data-act="pick-faction"]', 'a wallet button or the nation cards');
  if (await has('[data-act="connect"]:not([disabled])')) {
    const wallets = await page.locator('[data-act="connect"]').evaluateAll(es => es.map(e => e.textContent.trim()));
    log('wallets offered:', JSON.stringify(wallets));
    await click('[data-act="connect"]:not([disabled])', 'connect wallet');
  } else log('no wallet step: the page reconnected the wallet it remembers');
  await waitSel(`[data-act="pick-faction"][data-f="${FACTION}"]`, 'the nation cards');
  await click(`[data-act="pick-faction"][data-f="${FACTION}"]`, `nation ${FACTION}`);
  if (INVITE && !LANDING && (await has('input[data-bind="invite"]'))) { await page.locator('input[data-bind="invite"]').fill(INVITE); log('invite typed'); }
  log('invite field value:', JSON.stringify(await page.evaluate(() => document.querySelector('input[data-bind="invite"]')?.value ?? null)));
  await shot('02-join-form');
  let joined = false;
  for (let i = 0; i < 6 && !joined; i++) {
    await waitSel('[data-act="join"]:not([disabled])', 'the Join button');
    await click('[data-act="join"]:not([disabled])', 'join');
    const n = await settled('Join', 240_000);
    if (okNotice(n)) joined = true; else { out.refusals.push(`Join: ${n.text}`); await sleep(15_000); }
  }
  if (!joined) throw new Error('Join never landed');
  await shot('03-joined');
  if (UNTIL === 'join') { log('until join: done'); await browser.close(); process.exit(0); }

  // ------------------------------------------------------------ village
  const end = Date.now() + WAIT_MS;
  while (Date.now() < end) {
    const hold = await fs('FS.holdings?.[0] ? { p: FS.holdings[0].p, q: FS.holdings[0].q, state: FS.holdings[0].state } : null');
    if (hold) { log('village', JSON.stringify(hold)); break; }
    await sleep(3000);
  }
  await waitSel('#tabs [data-act="tab"][data-tab="holding"], [data-act="tab"][data-tab="holding"]', 'the village tab');
  await shot('04-village');
  if (UNTIL === 'village') { log('until village: done'); await browser.close(); process.exit(0); }

  if (HAMMER > 0) {
    // Abuse from one citizen: HAMMER Harvests at once through the page's own sender. The relay's per-key limit
    // (24 burst, 1/s) and the daily quota (40, burst 60) answer 429; nothing refused is charged.
    const before = await page.evaluate(`(async () => { const r = await fetch('/gw/f/quota?citizen=' + (await import('./fstate.mjs')).FS.citizen?.address); return r.status; })()`).catch(() => null);
    const t1 = Date.now();
    const res = await page.evaluate(`(async () => { const { ACTIONS } = await import('./controller.mjs'); const out = {}; await Promise.all(Array.from({ length: ${HAMMER} }, async () => { try { const r = await ACTIONS.harvest(); const k = r?.ok === false ? String(r.code) : 'ok'; out[k] = (out[k] ?? 0) + 1; } catch (e) { out.threw = (out.threw ?? 0) + 1; } })); return out; })()`);
    await sleep(1500);
    log('hammer', HAMMER, 'harvests in', Date.now() - t1, 'ms; page outcomes', JSON.stringify(res), '; relay answers', JSON.stringify(relayCodes), '; quota probe status', before);
    const q = await page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); return FS.quota ?? null; })()`);
    log('quota as the page sees it', JSON.stringify(q));
  }
  const tab = async id => { const sel = `[data-act="tab"][data-tab="${id}"]`; if (!(await has(`${sel}[aria-current="page"]`))) await click(sel, `tab ${id}`); };
  await tab('holding');
  await waitSel('[data-act="build"]:not([disabled])', 'Build enabled');
  await click('[data-act="build"]:not([disabled])', 'build');
  okNotice(await settled('Build'));

  await waitSel('form[data-form="train"] button[type="submit"]:not([disabled])', 'Train enabled');
  if (!(await submitForm('train', { unit: 0, n: 100 }, 'Train'))) throw new Error('Train refused');
  const musterEnd = Date.now() + WAIT_MS;
  let mustered = false;
  while (Date.now() < musterEnd && !mustered) {
    if (await has('form[data-form="muster"] select[name="unit"] option[value="0"]')) {
      await nudgeIfOffered();
      mustered = await submitForm('muster', { unit: 0, troops: 100 }, 'Muster');
    }
    if (!mustered) await sleep(4000);
  }
  if (!mustered) throw new Error('Muster never landed');
  await tab('hosts');
  const spear = 'li.host[data-unit="0"] [data-act="compose"]:not([disabled])';
  const hostEnd = Date.now() + WAIT_MS;
  while (Date.now() < hostEnd && !(await has(spear))) { await nudgeIfOffered(); await sleep(3000); }
  await waitSel(spear, 'the Spearmen host ready to march', 60_000);
  await shot('05-host-ready');
  await click(spear, 'compose march');
  await waitSel('[data-act="dest-quick"]', 'a quick destination');
  const dests = await page.locator('[data-act="dest-quick"]').evaluateAll(es => es.map(e => ({ txt: e.textContent.trim().slice(0, 40), ...e.dataset })));
  log('destinations', JSON.stringify(dests));
  const camp = dests.find(d => /camp|野営/i.test(d.txt)) ?? dests[0];
  await click(`[data-act="dest-quick"][data-p="${camp.p}"][data-q="${camp.q}"][data-tile="${camp.tile}"]`, `destination ${camp.p},${camp.q}/${camp.tile}`);
  await waitSel('[data-act="march-send"]:not([disabled])', 'march ready to seal', 60_000);
  await shot('06-march-ready');

  // ------------------------------------------------------------ depart (the 10-01 failure)
  if (STALE) {
    // The 10-01 condition made deterministic: the page believes its home province is resolved (a
    // poll up to 10 s old, or a bell that has just turned) while the chain's province lags two bells.
    // Auto-catch-up is switched off in the page, the page waits until the chain really lags, then the
    // page's cached view is set to "fresh" (test only) and Depart is pressed.
    await page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); Object.defineProperty(FS, 'autoNudgeBell', { get() { return FS.nowBell; }, set() {}, configurable: true }); })()`);
    log('stale-depart: waiting for the chain to lag two bells (auto catch-up off)');
    const lagEnd = Date.now() + 10 * 60_000;
    for (;;) {
      const lag = await page.evaluate(async () => { const r = await fetch(`/h/province/${(await import('./fstate.mjs')).FS.holdings[0].p},${(await import('./fstate.mjs')).FS.holdings[0].q}/latest`); const j = await r.json(); const { FS } = await import('./fstate.mjs'); return { bell: j.bell, nowBell: FS.nowBell }; });
      if (Date.now() % 20000 < 2500) log('lag probe', JSON.stringify(lag));
      if (lag.nowBell - lag.bell >= 3 || (lag.nowBell - lag.bell >= 2 && false)) { log('chain lag', JSON.stringify(lag)); break; }
      if (Date.now() > lagEnd) throw new Error('the province never lagged');
      await sleep(2000);
    }
    await page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); const h = FS.holdings[0]; const e = FS.provinces.get(h.p + ',' + h.q); e.province.resolvedNext = FS.nowBell; if (FS.compose) FS.compose.arriveBell = FS.nowBell + 6; (await import('./fstate.mjs')).invalidate('panel'); })()`);
    await sleep(300);
    if (!(await has('[data-act="march-send"]:not([disabled])'))) {
      const dump = await page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); const b = document.querySelector('[data-act="march-send"]'); return { btn: !!b, disabled: b?.disabled, nowBell: FS.nowBell, arrive: FS.compose?.arriveBell, rn: FS.provinces.get(FS.holdings[0].p + ',' + FS.holdings[0].q)?.province.resolvedNext, panel: document.querySelector('#panel-body')?.innerText.slice(-600) }; })()`);
      throw new Error('march-send not enabled after the fake-fresh view: ' + JSON.stringify(dump));
    }
  }
  let departed = false;
  for (let i = 0; i < 8 && !departed; i++) {
    const before = await fs('({ nowBell: FS.nowBell, resolvedNext: FS.provinces.get(`${FS.holdings[0].p},${FS.holdings[0].q}`)?.province.resolvedNext })');
    log('depart attempt', i + 1, JSON.stringify(before));
    if (!(await has('[data-act="march-send"]:not([disabled])'))) {
      log('march-send disabled; waiting (and nudging) up to 90 s');
      const e2 = Date.now() + 90_000;
      while (Date.now() < e2 && !(await has('[data-act="march-send"]:not([disabled])'))) { await nudgeIfOffered(); await sleep(2000); }
      if (!(await has('[data-act="march-send"]:not([disabled])'))) { await shot(`depart-stuck-${i}`); throw new Error('march-send stays disabled'); }
    }
    const noticeBefore = await notice();
    await click('[data-act="march-send"]:not([disabled])', 'march-send');
    const n = await settled('Depart', 240_000, noticeBefore);
    if (okNotice(n)) { departed = true; break; }
    out.refusals.push(`Depart: ${n.text}`);
    await shot(`depart-refused-${i}`);
    const st = await fs('({ nowBell: FS.nowBell, resolvedNext: FS.provinces.get(`${FS.holdings[0].p},${FS.holdings[0].q}`)?.province.resolvedNext, autoNudgeBell: FS.autoNudgeBell })');
    log('depart refused', JSON.stringify(st));
    await sleep(5000);
  }
  await shot('07-after-depart');
  log(departed ? 'DEPART OK' : 'DEPART FAILED', JSON.stringify(out));
  await browser.close();
  process.exit(departed ? 0 : 1);
} catch (e) {
  log('FAILED', String(e.message ?? e), JSON.stringify(out));
  await shot('zz-failed');
  await browser.close().catch(() => {});
  process.exit(1);
}
