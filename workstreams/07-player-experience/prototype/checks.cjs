// Workstream 07: the prototype's screen checks and recordings.
//   python3 -m http.server 41777 --bind 127.0.0.1   (from the repository root)
//   node workstreams/07-player-experience/prototype/checks.cjs
// Writes shots/*.jpg, shots/video/*.webm and shots/checks.json. A pass here
// shows the screens behave as specified; it is no evidence that they are fun
// or that a newcomer understands them (PLAYTEST.ja.md).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.WS07_BASE ?? 'http://127.0.0.1:41777/workstreams/07-player-experience/prototype/';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(path.join(OUT, 'video'), { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 120)}` : ''}`); };

async function flow(browser, { label, viewport, mobile = false, scheme = 'light', video = false }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile, colorScheme: scheme, locale: 'ja-JP', ...(video ? { recordVideo: { dir: path.join(OUT, 'video'), size: viewport } } : {}) });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = async name => p.screenshot({ path: path.join(OUT, `${label}-${name}.jpg`), type: 'jpeg', quality: 80 });
  const panelTitle = () => p.textContent('#panel h2');
  await p.goto(BASE + 'index.html');
  await p.waitForSelector('#drawer:not([hidden]) h2');
  check(`${label}: on a first look the away summary opens by itself, unconfirmed`, (await p.textContent('#drawer')).includes('確認したのは第559ターンまで'));
  await shot('01-away');
  // later: closes, keeps unconfirmed
  await p.click('#drawer [data-act="close"]:not(.close)');
  check(`${label}: "later" closes it and the strip still says not confirmed`, (await p.isHidden('#drawer')) && (await p.textContent('#alerts')).includes('まだ確認していません'));
  await shot('02-map');
  // reload: the mark is still not moved
  await p.reload(); await p.waitForTimeout(300);
  check(`${label}: after a reload nothing was confirmed by the reload`, (await p.textContent('#alerts')).includes('まだ確認していません'));
  // the village: the shortfall comparison, then the browser's back
  await p.click('#alerts >> text=知らせを開く');
  await p.click('#drawer >> text=地図で見る >> nth=0');
  check(`${label}: "show on map" selects the place and closes the summary`, (await p.isHidden('#drawer')) && (await panelTitle()).includes('ハルデン'));
  await p.click('text=都市へ昇格：足りない分をそろえる');
  check(`${label}: the shortfall compares at "all there"`, (await p.textContent('#panel')).includes('全部そろう'));
  await shot('03-shortfall');
  await p.goBack(); await p.waitForTimeout(200);
  check(`${label}: the browser's back returns from the comparison to the tile`, (await panelTitle()).includes('ハルデン'));
  // the caravan: preview, an over-full cargo, a double press, a failure, a cancel
  await p.click('text=都市へ昇格：足りない分をそろえる');
  await p.click('#panel >> text=隊商の準備へ >> nth=0');
  await p.waitForSelector('text=送る前の見通し');
  check(`${label}: the caravan preview names its arrival turn and its tower wear before sending`, /第612ターン/.test(await p.textContent('#panel')) && /13.5% 減ります/.test(await p.textContent('#panel')));
  check(`${label}: the road went round the palisade (the map marks it)`, (await p.$$('.avoid')).length === 1 && (await p.textContent('#panel')).includes('柵を避けた道'));
  await shot('04-caravan');
  await p.fill('[data-cargo="1"]', '700');
  check(`${label}: a cargo over what the storehouse holds turns the send off, with the reason`, (await p.getAttribute('[data-act="send"]', 'aria-disabled')) === 'true' && (await p.textContent('#panel')).includes('貯蔵庫にある量を超えています'));
  await p.fill('[data-cargo="1"]', '600');
  await p.check('[data-act="failnext"]');
  await p.click('[data-act="send"]');
  await p.waitForSelector('.status.err');
  check(`${label}: a failed send says nothing left and keeps the cargo`, (await p.textContent('.status.err')).includes('隊商は出発していません') && (await p.inputValue('[data-cargo="2"]')) === '900');
  await shot('05-send-failed');
  await p.click('.status.err >> text=もう一度送る');
  await p.click('[data-act="send"]', { force: true }).catch(() => {});
  await p.dblclick('[data-act="send"]', { force: true }).catch(() => {});
  await p.waitForSelector('.status.ok', { timeout: 5000 });
  const sends = await p.evaluate(() => document.querySelectorAll('.status').length);
  check(`${label}: pressing send again while it is under way sends once`, sends === 1, `${sends} status lines`);
  check(`${label}: once the record is in, the arrival is marked confirmed, apart from the plan`, (await p.textContent('.status.ok')).includes('確定') && (await p.textContent('#panel')).includes('予定'));
  await shot('06-sent');
  await p.click('#panel [data-act="cancel"]');
  check(`${label}: closing the caravan card returns to the tile`, !(await p.textContent('#panel')).includes('積荷'));
  // keyboard: the map takes arrows and Enter, Esc closes
  if (!mobile) {
    await p.selectOption('#goto', '0,0,30');
    await p.focus('#map svg');
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter');
    const t = await panelTitle();
    check(`${label}: arrows move the focus between tiles and Enter selects`, /0,0・(\d+)/.test(t) && !t.includes('・30'), t);
    await p.click('#alerts >> text=知らせを開く');
    await p.keyboard.press('Escape');
    check(`${label}: Esc closes the summary`, await p.isHidden('#drawer'));
  }
  // the forecast check and the terms on a faster clock
  await p.click('a:has-text("予測の点検")');
  await p.waitForSelector('text=プログラムと同じ組み立て', { timeout: 8000 });
  const fc = await p.textContent('#panel');
  check(`${label}: the forecast check shows the page's 500 against the model's 487–489 (recorded 488)`, fc.includes('残る兵 500') && /残る兵 48\d〜48\d/.test(fc), fc.match(/残る兵 [\d〜,]+/g));
  await p.fill('[data-act="wear"]', '900');
  await p.waitForTimeout(200);
  check(`${label}: tower wear moves the model forecast and not the page's`, /物見櫓で 500 → 4\d\d/.test(await p.textContent('#panel')) && (await p.textContent('#panel')).includes('残る兵 500'));
  await shot('07-forecast');
  await p.selectOption('#rate', '10');
  await p.click('a:has-text("用語と締め切り")');
  const terms = await p.textContent('#drawer');
  check(`${label}: on a 10× clock a turn is said as 10 game minutes, about 60 real seconds`, terms.includes('実時間では約 60 秒'));
  check(`${label}: the join deadline is read from the season`, terms.includes('第1,512ターンまで'));
  await shot('08-terms');
  await p.click('#drawer >> [data-act="close"] >> nth=0');
  // confirm: the mark moves, a reload keeps it, and the summary is then empty
  await p.click('#alerts >> text=知らせを開く');
  await p.click('#drawer [data-act="confirm"]');
  await p.reload(); await p.waitForTimeout(300);
  check(`${label}: after "seen" and a reload there is nothing unconfirmed`, (await p.textContent('#alerts')).trim() === '');
  await p.click('a:has-text("用語と締め切り")'); await p.click('#drawer >> [data-act="close"] >> nth=0');
  // the cases: another device, another wallet, a new season, a gap
  await p.evaluate(() => { location.hash = '#panel=tile&sel=0,0,30&drawer=away'; });
  await p.waitForSelector('#drawer:not([hidden])');
  for (const [v, words] of [['firstOnDevice', '初めてか、別の端末か'], ['otherWallet', '前に使ったウォレットとは別'], ['newSeason', '前のシーズンの出来事は含みません'], ['gap', '欠けた分の出来事は推測しません']]) {
    await p.selectOption('[data-act="scenario"]', v);
    check(`${label}: the summary says the case "${v}"`, (await p.textContent('#drawer')).includes(words));
    if (!mobile) await shot(`09-case-${v}`);
  }
  await p.click('text=確認の記録を消す');
  // English
  await p.click('#drawer >> [data-act="close"] >> nth=0').catch(() => {});
  await p.click('#lang');
  check(`${label}: English`, (await p.textContent('#alerts')).includes('While you were away') || (await p.textContent('#panel')).includes('Terrain'));
  await shot('10-en');
  await p.click('#lang');
  check(`${label}: no page error`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  await flow(browser, { label: 'pc', viewport: { width: 1440, height: 900 }, video: true });
  await flow(browser, { label: 'phone', viewport: { width: 390, height: 844 }, mobile: true, video: true });
  // dark scheme, desk; and the comparison page in colour, greyscale and the colour-vision approximation
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  await p.goto(BASE + 'index.html#panel=caravan&sel=1,0,30');
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(OUT, 'pc-11-dark-caravan.jpg'), type: 'jpeg', quality: 80 });
  await p.goto(BASE + 'compare.html'); await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(OUT, 'compare-color.jpg'), type: 'jpeg', quality: 80, fullPage: true });
  await p.check('input[value="gray"]'); await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'compare-gray.jpg'), type: 'jpeg', quality: 80, fullPage: true });
  await p.check('input[value="cvd"]'); await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, 'compare-cvd.jpg'), type: 'jpeg', quality: 80, fullPage: true });
  await ctx.close();
  const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const q = await pc.newPage(); await q.goto(BASE + 'compare.html'); await q.waitForTimeout(600);
  await q.screenshot({ path: path.join(OUT, 'phone-compare.jpg'), type: 'jpeg', quality: 80, fullPage: true });
  const overflow = await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('phone: the comparison page has no sideways scroll', !overflow);
  await q.goto(BASE + 'index.html'); await q.waitForTimeout(500);
  check('phone: the prototype page has no sideways scroll (the map scrolls inside its frame)', !(await q.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await pc.close();
  await browser.close();
  // name the videos by their flow
  const vids = fs.readdirSync(path.join(OUT, 'video')).filter(f => f.endsWith('.webm')).map(f => ({ f, t: fs.statSync(path.join(OUT, 'video', f)).mtimeMs })).sort((a, b) => a.t - b.t);
  ['pc-flow.webm', 'phone-flow.webm'].forEach((name, i) => { if (vids[i] && vids[i].f !== name) fs.renameSync(path.join(OUT, 'video', vids[i].f), path.join(OUT, 'video', name)); });
  fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, pass: results.filter(r => r.ok).length, fail: results.filter(r => !r.ok).length, results }, null, 1));
  console.log(`\n${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed`);
  process.exit(results.some(r => !r.ok) ? 1 : 0);
})();
