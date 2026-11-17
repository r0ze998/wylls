// 国の卓の試作を本物のブラウザ（Chromium）で開き、3人の立場で押して確かめる煙テスト。
//   node workstreams/01-national-strategy/test/browser.smoke.mjs [--shots]
// --shots を付けると screenshots/ に画面を保存する。押して動くことの確認で、面白さの証拠ではない。

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { start } from '../prototype/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const shots = process.argv.includes('--shots');
const shotDir = join(here, '..', 'screenshots');

const server = await start(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const errors = [];
const results = [];
const step = async (name, f) => {
  try { await f(); results.push(['ok', name]); } catch (e) { results.push(['not ok', name, e.message]); }
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  const who = id => page.click(`[data-ui="me"][data-id="${id}"]`);
  const option = async (text) => {
    const b = page.locator('#decisions button', { hasText: text }).first();
    await b.click();
  };
  const advance = async n => { for (let i = 0; i < n; i++) await page.click('[data-ui="advance"][data-n="1"]'); };

  await step('画面が開き、共同目標と判断が出る', async () => {
    await page.waitForSelector('.goal h3');
    assert.match(await page.textContent('.goal h3'), /国境の共同拠点/);
    assert.ok(await page.locator('#decisions .decision').count() > 0);
  });
  if (shots) await page.screenshot({ path: join(shotDir, '01-start-kei.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  await step('ソウタ：倉の完成後に食料を送ると「送信済み」に入り、到着済みには入らない', async () => {
    await who('sota');
    await advance(3);
    await option('400 を送る');
    const sent = await page.locator('.lane', { hasText: '送信済み' }).locator('.ship').count();
    assert.equal(sent, 1);
    const arrivedFood = await page.locator('.needs li', { hasText: '食料 400' }).locator('.nums b').first().textContent();
    assert.equal(arrivedFood.trim(), '0');
  });

  await step('遅延を起こすと、ケイ・ミラ・ソウタに待つ以外の選択が出る', async () => {
    await page.selectOption('#event', 'delay');
    await page.click('[data-ui="inject"]');
    await advance(1);
    for (const id of ['kei', 'mira', 'sota']) {
      await who(id);
      const enabled = await page.locator('#decisions li:not(.wait):not(.off) button').count();
      assert.ok(enabled > 0, `${id} に選べる行動がない`);
    }
  });
  await who('kei');
  if (shots) await page.screenshot({ path: join(shotDir, '02-delay-kei.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  await step('ケイがハルに頼み、ハルが受けて送る', async () => {
    await who('kei');
    await page.locator('#decisions .decision', { hasText: 'このままだと期限にそろわない' }).locator('button', { hasText: 'ハルに頼む' }).click();
    await who('haru');
    await option('受ける');
    await page.locator('#decisions .decision', { hasText: '発送するか' }).locator('button').first().click();
    const lane = await page.locator('.lane', { hasText: '送信済み' }).textContent();
    assert.match(lane, /ハル/);
    assert.match(lane, /ソウタの物/, '着いたら倉の持ち主（ソウタ）の物と表示される');
  });
  if (shots) await page.screenshot({ path: join(shotDir, '03-haru-sends.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  await step('退出：ミラが抜けると、記録に残り、ケイに兵器の不足が見える', async () => {
    await page.selectOption('#preset', 'preparing');
    await page.click('[data-ui="reset"]');
    await page.selectOption('#event', 'withdraw');
    await page.click('[data-ui="inject"]');
    assert.match(await page.textContent('#log'), /ミラが「国境の共同拠点を準備する」から抜けた/);
    await who('kei');
    assert.match(await page.textContent('#decisions'), /兵器 50/);
  });

  await step('方針の対立：投票が可決すると、調整役に目的の見直しが出る', async () => {
    await page.click('[data-ui="reset"]');
    await page.selectOption('#event', 'stance');
    await page.click('[data-ui="inject"]');
    await who('mira');
    await page.locator('#decisions .decision', { hasText: '議会' }).locator('button', { hasText: '賛成' }).click();
    await advance(6);
    await who('kei');
    assert.match(await page.textContent('#decisions'), /前提が変わった/);
    await option('目的を「交易の中継拠点」に変える');
    assert.match(await page.textContent('.goal .ver'), /第2版/);
    await who('sota');
    assert.match(await page.textContent('#decisions'), /続けるか/);
  });
  if (shots) await page.screenshot({ path: join(shotDir, '04-stance-sota.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  await step('所有者の不在：ソウタが不在だと、ソウタの判断は「戻る」だけになる', async () => {
    await page.click('[data-ui="reset"]');
    await page.selectOption('#event', 'absent');
    await page.click('[data-ui="inject"]');
    await who('sota');
    assert.match(await page.textContent('#decisions'), /不在/);
  });

  await step('競合する目標：3村の賛同でも、判断する人1なら採択されないと表示される', async () => {
    await page.click('[data-ui="reset"]');
    await page.selectOption('#event', 'rival');
    await page.click('[data-ui="inject"]');
    const card = page.locator('.goal', { hasText: '東の砦攻め' });
    assert.match(await card.textContent(), /3村（台本3）・判断する人 1／3/);
    assert.match(await card.locator('.pill').first().textContent(), /提案中/);
  });

  await step('倉を奪われると、拠点の倉の食料は「今ある・使える 0」になり、記録に残る', async () => {
    await page.click('[data-ui="reset"]');
    await advance(3);
    await who('sota');
    await option('400 を送る');
    await advance(13);
    await page.selectOption('#event', 'vaultLost');
    await page.click('[data-ui="inject"]');
    const row = page.locator('.needs li', { hasText: '食料 400 拠点の倉へ' });
    assert.match(await row.textContent(), /今ある・この目標に使える 0 ／ 到着の累計 400/);
    assert.match(await page.textContent('#log'), /倉（拠点（北の峠の手前））が北の国に奪われた/);
  });
  if (shots) await page.screenshot({ path: join(shotDir, '06-vault-lost.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  await step('初期配置の比較：A・B・C を切り替えると、地図と数字が変わる。B が最初に出る', async () => {
    await page.goto(url + 'placement.html');
    await page.waitForSelector('#map svg');
    assert.equal(await page.inputValue('#scheme'), 'B');
    const dotsB = await page.locator('#map .dot').count();
    assert.equal(dotsB, 36);
    const sumB = await page.textContent('#summary');
    await page.selectOption('#scheme', 'A');
    const sumA = await page.textContent('#summary');
    assert.notEqual(sumA, sumB);
    await page.selectOption('#scheme', 'B');
    await page.click('[data-ui="late"]');
    assert.equal(await page.locator('#map .dot').count(), 38);
    await page.locator('#map .dot circle').first().click();
    assert.match(await page.textContent('#pick'), /中心（Concord）までの州の数/);
  });
  if (shots) await page.screenshot({ path: join(shotDir, '07-placement-B.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  await step('初期配置の比較から国の卓を開くと、その配置の距離で作例が動く', async () => {
    await page.click('[data-ui="reset"]');
    await page.click('text=この配置の距離で「国境の共同拠点」を試す');
    await page.waitForSelector('.placementnote');
    assert.match(await page.textContent('.placementnote'), /B：同国が小集団で各地に散る/);
    const t = await page.evaluate(() => window.__table.world.travelOverride);
    assert.ok(t['v:haru|site'] > 3, `B のハル（別の小集団）は拠点まで遠い：${t['v:haru|site']}`);
    await page.click('[data-ui="reset"]');
    assert.ok(await page.evaluate(() => !!window.__table.world.travelOverride), 'やり直しても配置の距離のまま');
  });

  await step('国際供給網：ナギとトウの交換、リンとセナの交換、ナギとリンの交換の後、共同成果が達成と出る', async () => {
    await page.goto(url + 'supply.html');
    await page.waitForSelector('#joint h3');
    const me = id => page.click(`[data-ui="me"][data-id="${id}"]`);
    const opt = async (title, text) => page.locator('#decisions .decision', { hasText: title }).locator('button', { hasText: text }).first().click();
    const adv = async n => { for (let i = 0; i < n; i++) await page.click('[data-ui="advance"][data-n="1"]'); };
    await me('nagi'); await opt('誰と', 'トウ');
    await me('tou'); await opt('ナギ', '受ける');
    await me('rin'); await opt('誰と', 'セナ');
    await me('sena'); await opt('リン', '受ける');
    await adv(13);
    await me('nagi'); await opt('誰と', 'リン');
    await me('rin'); await opt('ナギ', '受ける');
    await me('tou'); await opt('工房を足す', '工房を1基足す');
    await adv(6);
    await me('nagi'); await opt('村を町に', '昇格を始める');
    await me('rin'); await opt('長槍兵', '長槍兵100');
    await adv(2);
    assert.equal((await page.textContent('#joint .pill')).trim(), '達成');
    const closed = await page.locator('#decisions button[disabled]', { hasText: '借りて' }).count();
    await me('nagi');
    assert.ok(await page.locator('#decisions button[disabled]', { hasText: '借りて' }).count() >= closed);
  });
  if (shots) await page.screenshot({ path: join(shotDir, '08-supply.jpg'), fullPage: true, type: 'jpeg', quality: 70 });

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on('pageerror', e => errors.push(String(e)));
  await phone.goto(url);
  await step('スマホの幅で横にはみ出さない', async () => {
    const over = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, `横に ${over}px はみ出す`);
  });
  if (shots) await phone.screenshot({ path: join(shotDir, '05-phone.jpg'), fullPage: false, type: 'jpeg', quality: 70 });

  await step('ページのエラーがない', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.close();
}
for (const [s, n, e] of results) console.log(`${s} - ${n}${e ? `\n    ${e}` : ''}`);
const failed = results.filter(r => r[0] !== 'ok').length;
console.log(`# pass ${results.length - failed}\n# fail ${failed}`);
process.exitCode = failed ? 1 : 0;
