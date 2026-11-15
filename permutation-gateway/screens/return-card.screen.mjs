// The expedition return card shown on its own, English and Japanese, at 1440 × 900, with the page's own stylesheets
// (base.css, frontier/frontier.css). The card is rendered in Node by hud/returncard.mjs from fixture models and set
// as the page's content: no server, no page script, no network (every request is refused and counted), no key.
// Asserts each line is drawn (non-zero box, in the card), wraps instead of overflowing, and says the shown language.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { returnCard } from '../../permutation-server/web/frontier/hud/returncard.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const css = ['base.css', 'frontier/frontier.css'].map(f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8'));
const S = (a, b, c) => [['dissolve', a], ['resolve-leave', b], ['return-reserve', c]].map(([id, status]) => ({ id, status }));
const MODELS = [
  { phase: 'unavailable', detail: 'unavailable', steps: S('waiting', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { phase: 'expedition-pending', detail: 'OriginDestroyedSettlementOrCleanupEvidence', steps: S('waiting', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { phase: 'resident', detail: 'resident', steps: S('proposal', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { phase: 'leave-pending', detail: 'leave-pending', steps: S('observed', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { phase: 'return-pending', detail: 'return-pending', steps: S('observed', 'observed', 'proposal'), returnUnits: '600', reserveAfter: '1000' },
];
const JP = /[぀-ヿ㐀-鿿]/;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

for (const lang of ['en', 'ja']) test(`the return card (${lang} @ 1440): every phase drawn, wrapped, in the shown language, no request`, { timeout: 60_000 }, async () => {
  setLang(lang);
  const cards = MODELS.map(m => String(returnCard(m)));
  setLang('ja');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const requests = [];
  await ctx.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  const page = await ctx.newPage();
  try {
    await page.setContent(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${css.join('\n')}</style></head>
      <body><main>${cards.map((c, i) => `<div class="hand-pop" data-card="${i}" style="position:static;width:360px;margin:12px">${c}</div>`).join('')}</main></body></html>`);
    const rows = await page.evaluate(() => [...document.querySelectorAll('section.expedition-return')].map(sec => {
      const box = sec.getBoundingClientRect();
      return {
        phase: sec.dataset.returnPhase, w: box.width, h: box.height,
        lines: [...sec.querySelectorAll('p, li')].map(el => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent.trim(), w: r.width, h: r.height, inside: r.left >= box.left - 1 && r.right <= box.right + 1,
            overflow: el.scrollWidth > el.clientWidth + 1, visible: getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none' };
        }),
      };
    }));
    assert.deepEqual(rows.map(r => r.phase), MODELS.map(m => m.phase));
    for (const r of rows) {
      assert.ok(r.w > 100 && r.h > 40, `${r.phase} card drawn (${r.w}×${r.h})`);
      assert.ok(r.lines.length >= 5, `${r.phase}: title, detail, 3 steps, closing line`);
      for (const l of r.lines) {
        assert.ok(l.visible && l.w > 0 && l.h > 0, `${r.phase}: drawn: ${l.text}`);
        assert.ok(l.inside, `${r.phase}: inside the card: ${l.text}`);
        assert.ok(!l.overflow, `${r.phase}: wraps, not cut: ${l.text}`);
        if (lang === 'ja') assert.match(l.text, JP, l.text); else assert.doesNotMatch(l.text, JP, l.text);
      }
    }
    assert.deepEqual(requests, [], 'the card asks for nothing');
    if (process.env.RETURN_CARD_OUT) await page.screenshot({ path: `${process.env.RETURN_CARD_OUT}/return-card-${lang}-1440.png`, fullPage: true });
  } finally {
    await ctx.close();
  }
});
