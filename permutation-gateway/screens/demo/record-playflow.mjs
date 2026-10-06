// The play-flow recorder: one player's first session on the new Frontier
// UI (map art, HUD, left rail), recorded as a video for a human viewer at
// 1920 × 1080, once in Japanese and once in English.
//
//   join → faction and site → first holding → build → scout/explore →
//   sealed march (destination hidden) → the bell → clash report →
//   verify in this browser
//
// It is the scripted onboarding run (live/onboarding.live.mjs) re-paced:
// the same page controls (tabs, `data-act` buttons, forms) through the
// page's own dev wallet on a local stack, but every step opens with a
// caption, a visible pointer glides to each control and rings it before
// the press, and the waits for the chain (a bell every 30 s at 20×) are
// marked so the finished video can fast-forward them. The overlay
// (overlay.mjs) is injected by this recorder with `addInitScript`; no file
// of the page is edited.
//
//   DEMO_HERALD=http://127.0.0.1:41240 DEMO_LANGS=ja,en \
//   DEMO_OUT=/path/outside/git node demo/record-playflow.mjs
//
// Environment:
//   DEMO_HERALD   the herald of a local stack (never the paused m1-exit one: it takes no joins)
//   DEMO_LANGS    ja,en (default) — one recording per language, each with a fresh wallet
//   DEMO_OUT      the output directory (videos, summary.json); required, outside the repository
//   DEMO_UNTIL    stop after this step id (a short proof run), e.g. `holding`
//   DEMO_PACE     1 (default) scales every pause; 0.5 is brisker, 2 slower
//   DEMO_COMPRESS 1 (default) also writes a cut with the waits fast-forwarded
//   DEMO_WAIT_MS  the longest wait for one chain event (default 20 min)
//   DEMO_RECUT    a summary.json: only re-encode its cuts from the .raw.mp4 files, then exit
//   DEMO_VERBOSE  1 (default) logs every press and wait; 0 logs the steps only
//
// Output per language: playflow-<lang>-<stamp>.raw.mp4 (real time),
// playflow-<lang>-<stamp>.mp4 (waits fast-forwarded), -<step>.png stills,
// and summary.json (steps, wait segments, the march, the clash, the verdict).
import { mkdirSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { installOverlay } from './overlay.mjs';
import { CAPTIONS, STEPS } from './captions.mjs';

const HERALD = (process.env.DEMO_HERALD ?? 'http://127.0.0.1:41240').replace(/\/$/, '');
const PAGE = `${HERALD}/frontier/frontier/index.html`;
const LANGS = (process.env.DEMO_LANGS ?? 'ja,en').split(',').map(s => s.trim()).filter(Boolean);
const OUT = process.env.DEMO_OUT;
const UNTIL = process.env.DEMO_UNTIL || null;
const PACE = Number(process.env.DEMO_PACE ?? 1);
const COMPRESS = process.env.DEMO_COMPRESS !== '0';
const WAIT_MS = Number(process.env.DEMO_WAIT_MS ?? 20 * 60_000);
const VERBOSE = process.env.DEMO_VERBOSE !== '0';
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const FONT = process.env.DEMO_FONT ?? '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc';
const VP = { width: 1920, height: 1080 };
/** Faction per language (two fresh wallets on one stack; different wedges so they do not contend). */
const FACTION = { ja: 1, en: 4 };

// Re-cut only: DEMO_RECUT=<summary.json> re-encodes each run's cut from its .raw.mp4 (same timing) and exits.
if (process.env.DEMO_RECUT) {
  const { readFileSync } = await import('node:fs');
  const sum = JSON.parse(readFileSync(process.env.DEMO_RECUT, 'utf8'));
  let ok = true;
  for (const r of sum.runs) {
    if (!r.video?.endsWith('.raw.mp4')) continue;
    const cut = r.video.replace(/\.raw\.mp4$/, '.mp4');
    ok = encode(r.video, cut, cutPlan(r.waits, r.wallS), r.lang) && ok;
    console.log(ok ? 'cut' : 'FAILED', cut);
  }
  process.exit(ok ? 0 : 1);
}
if (!OUT) { console.error('DEMO_OUT is required (a directory outside the repository)'); process.exit(2); }
if (/41040|41041/.test(HERALD)) { console.error(`refusing ${HERALD}: 41040/41041 belong to the paused m1-exit season and the design chat`); process.exit(2); }
mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pause = ms => sleep(ms * PACE);
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)} s]`, ...a);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

const summary = { herald: HERALD, viewport: VP, pace: PACE, stamp, runs: [] };
const browser = await chromium.launch();
let failed = false;
try {
  for (const lang of LANGS) {
    const run = await recordOne(lang).catch(e => ({ lang, error: String(e?.stack ?? e) }));
    summary.runs.push(run);
    if (run.error || (!UNTIL && run.verify !== 'match')) failed = true;
    writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
  }
} finally {
  summary.chromium = browser.version();
  await browser.close();
  writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`);
}
log(failed ? 'FAILED' : 'done', JSON.stringify(summary.runs.map(r => ({ lang: r.lang, verify: r.verify, video: r.video, cut: r.cut, error: r.error?.split('\n')[0] }))));
process.exit(failed ? 1 : 0);

async function recordOne(lang) {
  const C = CAPTIONS[lang];
  const run = { lang, steps: [], waits: [], console: [] };
  const rawDir = join(OUT, `.raw-${lang}-${stamp}`);
  const context = await browser.newContext({
    viewport: VP, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'ja-JP', timezoneId: 'UTC',
    // The herald's CSP allows no inline style; the overlay's own <style> needs it lifted (recorder only).
    bypassCSP: true,
    recordVideo: { dir: rawDir, size: VP },
  });
  await context.addInitScript(installOverlay);
  const page = await context.newPage();
  const t0 = Date.now();
  const at = () => (Date.now() - t0) / 1000;
  page.on('console', m => { if (m.type() === 'error' && !/status of 404/.test(m.text())) run.console.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => run.console.push(`page error: ${e.message}`));

  // ---------------------------------------------------------------- helpers bound to this page
  const demo = (fn, ...args) => page.evaluate(([f, a]) => window.__demo?.[f]?.(...a), [fn, args]).catch(() => {});
  let n = 0;
  const caption = async (id, total = STEPS.length) => {
    const c = C[id];
    n = STEPS.indexOf(id) + 1;
    await demo('caption', { n, total, kicker: C.kicker, title: c.title, body: c.body });
    await pause(3800);
  };
  /** A wait for the chain: the caption's wait line, and a segment the cut fast-forwards. */
  const waiting = async (text, fn) => {
    const seg = { text, start: at() };
    if (VERBOSE) log(lang, '  wait:', text);
    await demo('wait', `${text} …`);
    try { return await fn(); } finally {
      seg.end = at();
      run.waits.push(seg);
      await demo('wait', null);
    }
  };
  const glideTo = async locator => {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(150);
    const b = await locator.boundingBox();
    if (!b) return null;
    const x = b.x + Math.min(b.width / 2, 40), y = b.y + b.height / 2;
    await demo('pointTo', x, y);
    await demo('ring', { x: b.x, y: b.y, width: b.width, height: b.height });
    await pause(900);
    return { x, y };
  };
  /** Point at a control, ring it, press it, and let the viewer see the result. */
  const act = async (sel, { timeout = WAIT_MS, after = 1200 } = {}) => {
    if (VERBOSE) log(lang, '  act:', sel);
    const l = page.locator(sel).first();
    await l.waitFor({ state: 'visible', timeout });
    const p = await glideTo(l);
    if (p) await demo('tap', p.x, p.y);
    await l.click();
    await pause(after);
  };
  const waitFor = async (sel, what, timeout = WAIT_MS) => {
    try { await page.locator(sel).first().waitFor({ state: 'attached', timeout }); } catch (e) {
      throw new Error(`waited ${Math.round(timeout / 1000)} s for ${what} (${sel}): ${e.message.split('\n')[0]}`);
    }
  };
  const tab = async id => {
    const sel = `#tabs [data-act="tab"][data-tab="${id}"]`;
    if ((await page.locator(`${sel}[aria-current="page"]`).count()) === 0) await act(sel, { after: 900 });
  };
  const notice = async (what, timeout = 180_000) => {
    await page.waitForFunction(() => { const x = document.querySelector('.notice'); return x && !x.classList.contains('busy'); }, null, { timeout });
    const x = page.locator('.notice').first();
    if (!/\bok\b/.test((await x.getAttribute('class')) ?? '')) throw new Error(`${what}: ${await x.textContent()}`);
    await glideTo(x);
  };
  /** Wait for `sel`; while the page offers "catch up" (the province lags), press it as a player would, at most once a minute. */
  const enabledOrNudge = async (sel, what, timeout = WAIT_MS) => {
    const end = Date.now() + timeout;
    let last = 0;
    while (Date.now() < end) {
      if (await page.locator(sel).count()) return;
      const nudge = page.locator('[data-act="nudge"]:not([disabled])').first();
      if (Date.now() - last > 60_000 && (await nudge.count()) && (await nudge.isVisible().catch(() => false))) {
        await act('[data-act="nudge"]:not([disabled])', { after: 600 });
        last = Date.now();
        (run.nudges ??= []).push(what);
      }
      await sleep(1500);
    }
    throw new Error(`waited ${Math.round(timeout / 1000)} s for ${what} (${sel})`);
  };
  const fillSlow = async (sel, text) => {
    const l = page.locator(sel).first();
    await glideTo(l);
    await l.fill('');
    await l.pressSequentially(String(text), { delay: 90 });
    await pause(400);
  };
  const choose = async (sel, value) => {
    const l = page.locator(sel).first();
    await glideTo(l);
    await l.selectOption(String(value));
    await pause(500);
  };
  /**
   * Fill a data-form the way a viewer can follow (pick, type, point at the
   * button), then press it. The panel re-renders on every poll and a
   * re-render resets the form's fields (the first proof run trained
   * spearmen instead of scouts that way), so the press itself sets the
   * same values again and clicks in one synchronous tick of the page: the
   * page's own submit handler reads the form then.
   */
  const submitForm = async (form, values, what) => {
    for (const [name, value] of Object.entries(values)) {
      const sel = `form[data-form="${form}"] [name="${name}"]`;
      if ((await page.locator(sel).first().evaluate(e => e.tagName)) === 'SELECT') await choose(sel, value); else await fillSlow(sel, value);
    }
    const btn = `form[data-form="${form}"] button[type="submit"]:not([disabled])`;
    if (VERBOSE) log(lang, '  submit:', form, JSON.stringify(values));
    const p = await glideTo(page.locator(btn).first());
    if (p) await demo('tap', p.x, p.y);
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
    if (!ok) throw new Error(`${what}: the ${form} form changed under the press`);
    await notice(what);
    await pause(1200);
  };
  const train = async (unit, count) => {
    await waiting(C.waitBell, () => waitFor('form[data-form="train"] button[type="submit"]:not([disabled])', 'Train enabled'));
    await submitForm('train', { unit, n: count }, `Train ${unit}`);
  };
  const muster = async (unit, troops) => {
    await waiting(C.waitBell, async () => {
      await waitFor(`form[data-form="muster"] select[name="unit"] option[value="${unit}"]`, `unit ${unit} in the reserve`);
      await page.locator('form[data-form="muster"] select[name="unit"]').selectOption(String(unit));
      await enabledOrNudge('form[data-form="muster"] button[type="submit"]:not([disabled])', 'Muster enabled');
    });
    await submitForm('muster', { unit, troops }, `Muster ${unit}`);
  };
  /** An expression over the page's own state (read only). */
  const fs = expr => page.evaluate(`(async () => { const { FS } = await import('./fstate.mjs'); return (${expr}); })()`).catch(() => null);
  const shot = id => page.screenshot({ path: join(OUT, `playflow-${lang}-${stamp}-${id}.png`) }).catch(() => {});
  const step = async (id, fn) => {
    const s = { id, start: at() };
    run.steps.push(s);
    log(lang, 'step', id);
    try { await fn(); s.ok = true; } catch (e) {
      s.ok = false;
      s.error = String(e?.message ?? e).split('\n')[0];
      await page.screenshot({ path: join(OUT, `playflow-${lang}-${stamp}-${id}-FAILED.png`) }).catch(() => {});
      throw e;
    } finally { s.end = at(); }
    await shot(id);
    return UNTIL === id;
  };

  // ---------------------------------------------------------------- the flow
  try {
    await page.goto(PAGE);
    await page.waitForFunction(() => /\d/.test(document.getElementById('bell-chip')?.textContent ?? ''));
    if (lang === 'en' && (await page.evaluate(() => document.documentElement.lang)) !== 'en') {
      await page.locator('#lang-box [data-lang-toggle]').click();
      await page.waitForFunction(() => document.documentElement.lang === 'en');
    }
    if (lang === 'ja' && (await page.evaluate(() => document.documentElement.lang)) !== 'ja') {
      await page.locator('#lang-box [data-lang-toggle]').click();
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
    }
    await sleep(1500);
    await demo('pointTo', VP.width / 2, VP.height / 2 + 80);
    await demo('card', C.intro.title, C.intro.sub, C.intro.small);
    await pause(5200);
    await demo('hideCard');
    await pause(1200);
    // The guide's first card (the five words); the guide stays open and follows the flow.
    if (await page.locator('[data-act="ob-seen"][data-flag="welcome"]').count()) await act('[data-act="ob-seen"][data-flag="welcome"]', { after: 800 });

    const stop = async () => {
      if (await step('join', async () => {
        await caption('join');
        await act('[data-act="connect"]', { after: 1800 });
      })) return true;
      if (await step('site', async () => {
        await caption('site');
        await act(`[data-act="pick-faction"][data-f="${FACTION[lang] ?? 1}"]`, { after: 1500 });
        // Join, and join again after a refusal (a season that has just opened), as a player would.
        const end = Date.now() + WAIT_MS;
        let sent = false;
        await waiting(C.waitJoin, async () => {
          while (!(await page.locator('[data-act="pick-province"], [data-act="toggle-site"]').count())) {
            if (Date.now() > end) throw new Error(`no site picker after Join (${JSON.stringify(run.joinRefusals ?? [])})`);
            const err = page.locator('.notice.error');
            if (!sent || (await err.count())) {
              if (sent) { (run.joinRefusals ??= []).push(await err.first().textContent()); await sleep(15_000); }
              if (await page.locator('[data-act="join"]:not([disabled])').count()) { await act('[data-act="join"]:not([disabled])', { after: 500 }); sent = true; }
            }
            await sleep(1000);
          }
        });
        await pause(800);
        if (!(await page.locator('[data-act="toggle-site"]').count())) await act('[data-act="pick-province"]', { after: 1200 });
        await waitFor('[data-act="toggle-site"]', 'the free sites of the province');
        const sites = page.locator('[data-act="toggle-site"]');
        const k = Math.min(3, await sites.count());
        for (let i = 0; i < k; i++) {
          const p = await glideTo(sites.nth(i));
          if (p) await demo('tap', p.x, p.y);
          await sites.nth(i).click();
          await page.locator('[data-act="toggle-site"][aria-pressed="true"]').nth(i).waitFor({ state: 'attached' });
          await pause(700);
        }
        await act('[data-act="file-ticket"]:not([disabled])', { after: 1000 });
      })) return true;
      if (await step('holding', async () => {
        await caption('holding');
        await waiting(C.waitHolding, () => waitFor('#tabs [data-act="tab"][data-tab="holding"]', 'the Holding tab (a holding)'));
        run.holding = await fs('FS.holdings?.[0] ? { p: FS.holdings[0].p, q: FS.holdings[0].q, site: FS.holdings[0].site, tier: FS.holdings[0].tier } : null');
        // The map flies to the holding and zooms in to the tile art.
        if (await page.locator('.map-btn[data-map="home"]').count()) {
          await act('.map-btn[data-map="home"]', { after: 1500 });
          for (let i = 0; i < 2; i++) await act('.map-btn[data-map="in"]', { after: 900 });
        }
        const rail = page.locator('#rail .rail-holding').first();
        if (await rail.count()) { await glideTo(rail); await pause(1500); }
        await tab('holding');
        await waitFor('#holding-title', 'the holding panel');
        await pause(2000);
      })) return true;
      if (await step('build', async () => {
        await caption('build');
        await tab('holding');
        await waiting(C.waitBell, () => waitFor('[data-act="build"]:not([disabled])', 'Build enabled'));
        await act('[data-act="build"]:not([disabled])', { after: 400 });
        await notice('Build');
        await pause(2000);
      })) return true;
      if (await step('scout', async () => {
        await caption('scout');
        await tab('holding');
        await train(6, 100);
        await muster(6, 100);
        await tab('hosts');
        await waiting(C.waitHost, () => enabledOrNudge('[data-act="explore-open"]:not([disabled])', 'a scout host that can explore'));
        await act('[data-act="explore-open"]:not([disabled])', { after: 1200 });
        const tiles = page.locator('[data-act="explore-tile"]');
        await tiles.first().waitFor();
        const k = Math.min(2, await tiles.count());
        for (let i = 0; i < k; i++) {
          const p = await glideTo(tiles.nth(i));
          if (p) await demo('tap', p.x, p.y);
          await tiles.nth(i).click();
          await pause(600);
        }
        await act('[data-act="explore-send"]:not([disabled])', { after: 400 });
        await notice('Explore');
        await pause(2000);
      })) return true;
      if (await step('march', async () => {
        await caption('march');
        await tab('holding');
        await train(0, 100);
        await muster(0, 100);
        await tab('hosts');
        // The Spearman host (unit 0): scouts do not contest a tile. The panel re-renders on every poll, so the
        // composer's host is checked in the page's state and chosen again if a click landed on another row.
        const spear = 'li.host[data-unit="0"] [data-act="compose"]:not([disabled])';
        for (let i = 0; ; i++) {
          await waiting(C.waitHost, () => enabledOrNudge(spear, 'the Spearman host ready to march'));
          await act(spear, { after: 1000 });
          await waitFor('#march-title', 'the march composer');
          const unit = await fs('FS.compose?.host?.unit ?? null');
          if (unit === 0) break;
          if (i >= 3) throw new Error(`the composer holds unit ${unit}, not the Spearmen`);
          await act('[data-act="compose-close"]', { after: 600 });
          await tab('hosts');
        }
        // The sealed line: the destination is inside the seal.
        const sealed = page.locator('#march-title ~ fieldset .sealed, .sealed').first();
        if (await sealed.count()) { await glideTo(sealed); await pause(2600); }
        await waitFor('[data-act="dest-quick"]', 'a quick destination (the camp)');
        const camp = page.locator('[data-act="dest-quick"]').filter({ hasText: lang === 'en' ? /camp/i : /野営地/ });
        const campSel = (await camp.count()) ? `[data-act="dest-quick"][data-p="${await camp.first().getAttribute('data-p')}"][data-q="${await camp.first().getAttribute('data-q')}"][data-tile="${await camp.first().getAttribute('data-tile')}"]` : '[data-act="dest-quick"]';
        await act(campSel, { after: 1500 });
        await waitFor('[data-act="march-send"]:not([disabled])', 'the march ready to seal');
        // One bell of slack on the arrival (the paced viewer flow takes seconds a bell can run out in): the
        // composer's own arrival select, one bell after the earliest it offers.
        const bellSel = 'select[data-bind="arriveBell"]';
        if (await page.locator(bellSel).count()) {
          const opts = await page.locator(`${bellSel} option`).evaluateAll(os => os.map(o => o.value));
          const cur = await fs('Number(FS.compose?.arriveBell)');
          const next = opts.find(v => Number(v) === cur + 1);
          if (next) await choose(bellSel, next);
        }
        // Seal and depart. A refusal for a stale arrival bell ("does not fit the path") moves the composer's bell
        // to the new earliest; a player presses again, and so does the recorder (at most three times).
        for (let i = 0; ; i++) {
          await waitFor('[data-act="march-send"]:not([disabled])', 'the march ready to seal');
          run.march = await fs('FS.compose?.dest ? { unit: FS.compose.host?.unit ?? null, p: FS.compose.dest.p, q: FS.compose.dest.q, tile: FS.compose.dest.tile, arriveBell: Number(FS.compose.arriveBell) } : null');
          await act('[data-act="march-send"]:not([disabled])', { after: 400 });
          try { await notice('Depart'); break; } catch (e) {
            (run.departRefusals ??= []).push(String(e.message));
            if (i >= 2 || !(await page.locator('[data-act="march-send"]').count())) throw e;
            await pause(1500);
          }
        }
        await pause(2000);
      })) return true;
      if (await step('bell', async () => {
        await caption('bell');
        await tab('marches');
        await pause(2500);
        const m = run.march;
        if (m && Number.isInteger(m.arriveBell)) {
          await page.evaluate(async () => { window.__demoFS = (await import('./fstate.mjs')).FS; });
          await waiting(C.waitArrival(m.arriveBell), () => page.waitForFunction(b => Number(window.__demoFS?.nowBell) >= b, m.arriveBell, { timeout: WAIT_MS, polling: 1000 }));
          const pill = page.locator('#bell-pill');
          if (await pill.count()) { await glideTo(pill); await pause(2200); }
        }
        const sel = m && Number.isInteger(m.arriveBell) ? `[data-act="report-open"][data-p="${m.p}"][data-q="${m.q}"][data-bell="${m.arriveBell}"]` : '[data-act="report-open"]';
        await tab('marches');
        await waiting(C.waitReport, () => waitFor(sel, 'the report of the march (resolved)'));
        const d = await page.locator(sel).first().evaluate(e => ({ ...e.dataset }));
        run.clash = { p: Number(d.p), q: Number(d.q), bell: Number(d.bell) };
        run.reportSel = sel;
        await pause(1200);
      })) return true;
      if (await step('report', async () => {
        await caption('report');
        await act(run.reportSel, { after: 1500 });
        await waitFor('#report-title', 'the clash report');
        // Let the viewer read the report: glide down its sections.
        for (const s of ['#report-title', '#panel-body section h3, #panel-body h4', '[data-act="report-verify"]']) {
          const l = page.locator(s).first();
          if (await l.count()) { await glideTo(l); await pause(1800); }
        }
      })) return true;
      if (await step('verify', async () => {
        await caption('verify');
        await act('[data-act="report-verify"]', { after: 400 });
        await waiting(C.waitVerify, () => page.waitForFunction(() => { const v = document.querySelector('[data-verify-result]'); return v && v.dataset.verifyResult !== 'running'; }, null, { timeout: 180_000 }));
        const r = page.locator('[data-verify-result]').first();
        run.verify = await r.getAttribute('data-verify-result');
        await glideTo(r);
        await pause(3500);
        if (run.verify !== 'match') throw new Error(`verify: ${run.verify}`);
      })) return true;
      return false;
    };
    const stopped = await stop();
    run.wallet = await fs('FS.wallet?.address ?? null');
    await demo('hideCaption');
    if (!stopped) {
      await demo('card', C.outro.title, C.outro.sub, C.outro.small);
      await pause(5000);
    } else {
      await pause(1500);
    }
  } catch (e) {
    run.error = String(e?.message ?? e).split('\n')[0];
    await sleep(1500);
  } finally {
    run.wallS = at();
    const video = page.video();
    await context.close();
    const raw = video ? await video.path() : null;
    if (raw && existsSync(raw)) {
      const base = join(OUT, `playflow-${lang}-${stamp}`);
      const webm = `${base}.webm`;
      renameSync(raw, webm);
      run.video = encode(webm, `${base}.raw.mp4`, [{ start: 0, end: Infinity, speed: 1 }], lang) ? `${base}.raw.mp4` : webm;
      if (COMPRESS && run.video.endsWith('.mp4')) run.cut = encode(webm, `${base}.mp4`, cutPlan(run.waits, run.wallS), lang) ? `${base}.mp4` : null;
      if (run.video.endsWith('.mp4')) rmSync(webm, { force: true });
    }
    rmSync(rawDir, { recursive: true, force: true });
  }
  return run;
}

/**
 * The cut: normal speed everywhere but the long waits, whose middle plays
 * fast (each wait keeps 1.5 s at its start and 1 s at its end; the middle is
 * squeezed to about 4 s, at 4× to 40×).
 */
function cutPlan(waits, total) {
  const plan = [];
  let t = 0;
  for (const w of [...waits].sort((a, b) => a.start - b.start)) {
    const a = w.start + 1.5, b = w.end - 1;
    if (b - a < 6 || a < t) continue;
    plan.push({ start: t, end: a, speed: 1 });
    plan.push({ start: a, end: b, speed: Math.min(40, Math.max(4, Math.round((b - a) / 4))) });
    t = b;
  }
  plan.push({ start: t, end: total + 5, speed: 1 });
  return plan.filter(s => s.end > s.start);
}

function encode(input, output, plan, lang) {
  const font = FONT.replace(/'/g, "\\'");
  const label = CAPTIONS[lang]?.fast ?? 'Waiting (fast-forward)';
  const parts = plan.map((s, i) => {
    const trim = `trim=start=${s.start.toFixed(3)}${Number.isFinite(s.end) ? `:end=${s.end.toFixed(3)}` : ''}`;
    const speed = s.speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${s.speed},fps=30`;
    const badge = s.speed === 1 ? '' : `,drawtext=fontfile='${font}':text='${label} ×${s.speed}':x=312:y=76:fontsize=30:fontcolor=white:box=1:boxcolor=0x162622@0.85:boxborderw=14`;
    return `[0:v]${trim},${speed}${badge},fps=30[v${i}]`;
  });
  const graph = `${parts.join(';\n')};\n${plan.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.length}:v=1:a=0[out]`;
  const script = `${output}.filter.txt`;
  writeFileSync(script, graph);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-/filter_complex', script, '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(`ffmpeg ${output}: ${r.stderr}`); return false; }
  rmSync(script, { force: true });
  return true;
}
