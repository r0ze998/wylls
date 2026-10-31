/*
 * 表示検証スクリプト（開発用）
 *   node scripts/verify.cjs http://localhost:8080 docs/screenshots
 * - PC(1440x900) / SP(390x844) でトップとフォームを撮影
 * - 横はみ出し、最小フォントサイズ、タップ領域、リンク切れ、フォームの流れ、キーボード操作を確認
 * Playwright は環境にプリインストールされているものを使う
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const base = process.argv[2] || 'http://localhost:8080';
const out = process.argv[3] || 'docs/screenshots';
fs.mkdirSync(out, { recursive: true });

const results = [];
const log = (ok, msg) => { results.push({ ok, msg }); console.log((ok ? 'PASS ' : 'FAIL ') + msg); };

(async () => {
  const browser = await chromium.launch();

  for (const [kind, vp, isMobile] of [['pc', { width: 1440, height: 900 }, false], ['sp', { width: 390, height: 844 }, true]]) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile, locale: 'ja-JP' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => errors.push('requestfailed ' + r.url()));

    for (const file of ['index.html', 'contact.html']) {
      await page.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      // reveal をすべて表示させるためにスクロール
      // scroll-behavior: smooth を無効にして確実に全要素を通過させる
      await page.evaluate(async () => {
        document.documentElement.style.scrollBehavior = 'auto';
        for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 40)); }
        await new Promise(r => setTimeout(r, 300));
        window.scrollTo(0, 0);
        document.documentElement.style.scrollBehavior = '';
      });
      await page.waitForTimeout(900);
      const revealed = await page.evaluate(() => ({ total: document.querySelectorAll('.reveal').length, visible: document.querySelectorAll('.reveal.is-visible').length }));
      log(revealed.total === revealed.visible, `${file} ${kind}: スクロール後に全 reveal 要素が表示 (${revealed.visible}/${revealed.total})`);
      const name = file.replace('.html', '');
      await page.screenshot({ path: `${out}/${name}-${kind}-fold.png` });
      await page.screenshot({ path: `${out}/${name}-${kind}-full.png`, fullPage: true });

      const audit = await page.evaluate(() => {
        const docW = document.documentElement.clientWidth;
        const overflow = document.documentElement.scrollWidth > docW;
        const offenders = [];
        const small = [];
        const tiny = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > docW + 1 && getComputedStyle(el).position !== 'fixed') offenders.push(el.tagName + '.' + (el.className && el.className.baseVal === undefined ? String(el.className).split(' ')[0] : ''));
          const cs = getComputedStyle(el);
          if (el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && cs.display !== 'none') {
            const fs = parseFloat(cs.fontSize);
            if (fs < 12) small.push(el.tagName + ':' + fs.toFixed(1) + ':' + el.textContent.trim().slice(0, 20));
          }
          if ((el.matches('a,button,input,select,textarea,summary')) && cs.display !== 'none' && r.width && r.height) {
            // チェックボックスは label 全体、本文中のリンクは行の高さが基準
            const target = el.type === 'checkbox' ? (el.closest('label') || el) : el;
            const inline = el.tagName === 'A' && el.closest('p');
            const h = target.getBoundingClientRect().height;
            if (!inline && h < 32) tiny.push(el.tagName + ':' + Math.round(h) + ':' + (el.textContent || el.id).trim().slice(0, 20));
          }
        }
        const links = [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
        const missingAnchors = links.filter(h => h.startsWith('#') && h.length > 1 && !document.querySelector(h));
        const imgsNoAlt = [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).length;
        return { overflow, offenders: [...new Set(offenders)].slice(0, 10), small: small.slice(0, 10), tiny: tiny.slice(0, 10), links, missingAnchors, imgsNoAlt, height: document.documentElement.scrollHeight, bodyFont: getComputedStyle(document.body).fontSize };
      });
      log(!audit.overflow, `${name} ${kind}: 横はみ出しなし (scrollWidth<=clientWidth) ${audit.offenders.join(',')}`);
      log(audit.small.length === 0, `${name} ${kind}: 12px 未満の本文テキストなし ${audit.small.join(' | ')}`);
      log(audit.tiny.length === 0, `${name} ${kind}: 高さ32px未満の操作要素なし ${audit.tiny.join(' | ')}`);
      log(audit.missingAnchors.length === 0, `${name} ${kind}: ページ内リンク先が存在 ${audit.missingAnchors.join(',')}`);
      log(audit.imgsNoAlt === 0, `${name} ${kind}: alt のない画像なし`);
      console.log(`  info: ${name} ${kind} height=${audit.height}px bodyFont=${audit.bodyFont}`);

      // 外部ファイルへのリンク（同一サイト）が 200 を返すか
      const fileLinks = [...new Set(audit.links.filter(h => !h.startsWith('#') && !h.startsWith('http') && !h.startsWith('mailto')))];
      for (const h of fileLinks) {
        const url = new URL(h, `${base}/${file}`).toString();
        const res = await page.request.get(url);
        log(res.ok(), `${name} ${kind}: link ${h} -> ${res.status()}`);
      }
    }

    // ---- モバイルメニュー ----
    if (isMobile) {
      await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
      await page.click('.nav-toggle');
      await page.waitForTimeout(400);
      const open = await page.evaluate(() => document.getElementById('nav-panel').classList.contains('is-open') && document.querySelector('.nav-toggle').getAttribute('aria-expanded') === 'true' && document.getElementById('main').hasAttribute('inert'));
      log(open, 'sp: メニューが開き、aria-expanded=true、本文が inert');
      await page.screenshot({ path: `${out}/index-sp-menu.png` });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const closed = await page.evaluate(() => !document.getElementById('nav-panel').classList.contains('is-open') && !document.getElementById('main').hasAttribute('inert'));
      log(closed, 'sp: Escape でメニューが閉じ、inert が外れる');
      await page.click('.nav-toggle');
      await page.click('#nav-panel a[href="#estimate"]');
      await page.waitForTimeout(2500);
      const navigated = await page.evaluate(() => { const r = document.getElementById('estimate').getBoundingClientRect(); return { top: Math.round(r.top), open: document.getElementById('nav-panel').classList.contains('is-open'), inert: document.getElementById('main').hasAttribute('inert') }; });
      console.log('  info: after menu link', JSON.stringify(navigated));
      log(navigated.top < 200 && navigated.top > -200 && !navigated.open && !navigated.inert, 'sp: メニューのリンクで該当セクションへ移動し、メニューが閉じる');
    }

    // ---- フォームの流れ ----
    await page.goto(`${base}/contact.html`, { waitUntil: 'networkidle' });
    await page.click('#contact-form button[type=submit]');
    await page.waitForTimeout(300);
    const errState = await page.evaluate(() => ({
      summaryVisible: document.getElementById('error-summary').classList.contains('is-visible'),
      count: document.querySelectorAll('#error-summary li').length,
      invalid: document.querySelectorAll('[aria-invalid="true"]').length,
      focusInSummary: document.activeElement === document.getElementById('error-summary'),
      confirmHidden: document.getElementById('view-confirm').hidden
    }));
    log(errState.summaryVisible && errState.count === 5 && errState.invalid === 5 && errState.confirmHidden, `${kind}: 未入力で送信 → エラー要約5件・aria-invalid 5件・確認画面に進まない (${JSON.stringify(errState)})`);
    await page.screenshot({ path: `${out}/contact-${kind}-errors.png` });

    await page.fill('#f-company', 'サンプル株式会社 テスト店');
    await page.fill('#f-person', '確認 太郎');
    await page.fill('#f-email', 'not-an-email');
    await page.fill('#f-tel', '12');
    await page.fill('#f-message', 'テスト');
    await page.check('#f-consent');
    await page.click('#contact-form button[type=submit]');
    await page.waitForTimeout(300);
    const fmt = await page.evaluate(() => [...document.querySelectorAll('.field.has-error .field__error')].map(e => e.textContent));
    log(fmt.length === 3 && fmt.some(t => t.includes('メールアドレス')) && fmt.some(t => t.includes('電話番号')) && fmt.some(t => t.includes('10文字')), `${kind}: 形式不備（メール・電話・文字数）を個別に表示 (${fmt.join(' / ')})`);

    await page.fill('#f-email', 'sample@example.co.jp');
    await page.fill('#f-tel', '03-0000-0000');
    await page.selectOption('#f-pref', '東京都');
    await page.selectOption('#f-building', 'オフィス');
    await page.fill('#f-units', '天井埋込形 6台（型番不明）');
    await page.fill('#f-message', '会議室のエアコンから送風時にニオイがします。営業時間外の作業が可能か知りたいです。');
    await page.click('#contact-form button[type=submit]');
    await page.waitForTimeout(600);
    const confirm = await page.evaluate(() => ({
      shown: !document.getElementById('view-confirm').hidden && document.getElementById('view-input').hidden,
      rows: document.querySelectorAll('#confirm-body tr').length,
      company: document.querySelector('#confirm-body tr td').textContent,
      step: document.querySelector('.steps li[aria-current=step]').textContent.trim(),
      focusOnHeading: document.activeElement && document.activeElement.tagName === 'H2'
    }));
    log(confirm.shown && confirm.rows === 11 && confirm.company.includes('サンプル株式会社') && confirm.step.includes('確認') && confirm.focusOnHeading, `${kind}: 確認画面へ遷移、11行表示、見出しにフォーカス (${JSON.stringify(confirm)})`);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/contact-${kind}-confirm.png`, fullPage: true });

    // 修正に戻って値が保持されているか
    await page.click('#btn-back');
    await page.waitForTimeout(400);
    const kept = await page.evaluate(() => document.getElementById('f-company').value === 'サンプル株式会社 テスト店' && !document.getElementById('view-input').hidden);
    log(kept, `${kind}: 「修正する」で入力画面に戻り、値が保持される`);
    await page.click('#contact-form button[type=submit]');
    await page.waitForTimeout(600);

    // 二重送信：連打しても結果画面は一度だけ
    const disabledDuring = await page.evaluate(() => {
      const b = document.getElementById('btn-send');
      b.click(); const d1 = b.disabled; b.click(); b.click();
      return d1 && b.getAttribute('aria-busy') === 'true';
    });
    await page.waitForTimeout(900);
    const document_title_ok = r => r.title.includes('送信は行われていません') && !r.text.includes('受付完了');
    const result = await page.evaluate(() => ({
      shown: !document.getElementById('view-result').hidden,
      demoShown: !document.getElementById('result-demo').hidden,
      sentHidden: document.getElementById('result-sent').hidden,
      text: document.getElementById('result-demo').textContent,
      title: document.querySelector('#result-demo .result__title').textContent,
      step: document.querySelector('.steps li[aria-current=step]').textContent.trim()
    }));
    log(disabledDuring, `${kind}: 送信中はボタンが無効化される`);
    log(result.shown && result.demoShown && result.sentHidden && document_title_ok(result), `${kind}: デモ結果画面。「送信は行われていません」を表示し「受付完了」は出さない`);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/contact-${kind}-result.png`, fullPage: true });

    // 外部通信がないこと（フォント・自サイト以外のリクエストが無い）
    const reqs = [];
    page.on('request', r => reqs.push(r.url()));
    await page.click('#btn-restart');
    await page.waitForTimeout(300);
    const external = reqs.filter(u => !u.startsWith(base) && !u.includes('fonts.g'));
    log(external.length === 0, `${kind}: フォーム操作で外部へのリクエストなし ${external.join(',')}`);

    // ---- キーボード操作（PCのみ）----
    if (!isMobile) {
      await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
      await page.keyboard.press('Tab');
      const skip = await page.evaluate(() => document.activeElement.className);
      log(skip.includes('skip-link'), 'pc: 最初の Tab でスキップリンクにフォーカス');
      const order = [];
      for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => (document.activeElement.textContent || document.activeElement.getAttribute('aria-label') || '').trim().slice(0, 16))); }
      log(order.some(t => t.includes('困りごと')) && order.some(t => t.includes('見積もり・相談')), 'pc: Tab でヘッダーのナビとCTAに順に到達 ' + order.join(' > '));
      // FAQ を Enter で開く
      await page.focus('.faq details:first-of-type summary');
      await page.keyboard.press('Enter');
      const faqOpen = await page.evaluate(() => document.querySelector('.faq details:first-of-type').open);
      log(faqOpen, 'pc: FAQ の summary を Enter で開ける');
      // チェックリストのコピー（clipboard 権限を付与）
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await page.check('.check-item input >> nth=0');
      await page.click('#copy-checklist');
      await page.waitForTimeout(300);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      log(clip.includes('[x] 室内機の形状') && clip.includes('現場について'), 'pc: チェックリストのコピーがチェック状態を含む');
      const status = await page.textContent('#checklist-status');
      log(status.includes('コピーしました'), 'pc: コピー後にステータスが表示される');
    }

    log(errors.length === 0, `${kind}: コンソールエラー・読み込み失敗なし ${errors.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }

  // 中間幅（タブレット／小さめPC）での横はみ出しとヘッダーの収まり
  for (const w of [768, 1024, 1200]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'ja-JP' });
    const page = await ctx.newPage();
    await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
    const r = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, headerOk: (() => { const h = document.querySelector('.site-header .container'); return h.scrollWidth <= h.clientWidth + 1; })() }));
    log(!r.overflow && r.headerOk, `index ${w}px: 横はみ出しなし・ヘッダーが収まる`);
    await page.screenshot({ path: `${out}/index-${w}-fold.png` });
    await ctx.close();
  }
  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  fs.writeFileSync(path.join(out, 'verify-results.json'), JSON.stringify(results, null, 2));
  process.exit(fails.length ? 1 : 0);
})();
