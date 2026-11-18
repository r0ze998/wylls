// Q16-3: the key card while another key — ③'s courier (a program's key), another app or device — holds the
// resident's session, shown on its own, English and Japanese, at 1440 × 900 and 390 × 844, with the page's own
// stylesheets (base.css, frontier/frontier.css). The cards are rendered in Node by screens/join.mjs from fixture state
// (each inside the page's own drawer markup, `.panel` > `#panel-body`, where the card is read) and set as the page's content: no server, no page script, no network (every request is refused and counted), no key.
// Asserts the warning is drawn and readable (non-zero box, inside the card, wrapped), that keeping the delegation and
// replacing the key are two separate buttons that fit the card, that the plain "re-make the key" button is not there,
// and that the card says the shown language. REKEY_OUT=<dir> also writes the screenshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { render } from '../../permutation-server/web/frontier/screens/join.mjs';
import { handNote } from '../../permutation-server/web/frontier/fdelegation.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { encode as toBase58 } from '../../permutation-server/web/sdk/base58.mjs';
import { isOnCurve } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { CONTRAST } from './contrast.mjs';

// (round 3: the play page's own stylesheets, as frontier/index.html links them — it does not load base.css, which this
//  test once did, and which hid that the page had no `.btn.danger` of its own: verify-pr61 F4)
const css = ['frontier/frontier.css', 'frontier/people/leaders.css', 'frontier/proto-hand.css', 'frontier/proto-board.css', 'frontier/conquest-hand.css', 'frontier/uplift.css'].map(f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8'));
const JP = /[぀-ヿ㐀-鿿]/;
// A program-held key (off the curve: the courier's session PDA is one) and an ordinary key (another device's).
// (no key is made here: the off-curve one is a well-known program id, the on-curve one is the curve's base point)
const PDA = 'BPFLoaderUpgradeab1e11111111111111111111111', DEVICE = toBase58(Uint8Array.from([0x58, ...new Array(31).fill(0x66)]));
assert.equal(isOnCurve(PDA), false); assert.equal(isOnCurve(DEVICE), true);
const base = { land: { stage: 'joined' }, wallet: { address: 'owner' }, session: { publicKey: 'ThisDevice' }, sessionProblem: 'SessionMismatch', delegation: null, keyKept: null };
const citizen = (session, sessionExpiry = 10n ** 12n) => ({ session, sessionExpiry });
const CASES = [
  { id: 'courier', held: 'program', fs: { ...base, citizen: citizen(PDA) } },
  { id: 'other-device', held: 'other', fs: { ...base, citizen: citizen(DEVICE) } },
  { id: 'expired', held: 'program', fs: { ...base, citizen: citizen(PDA, 5n), chain: { now: () => 10 } } },
  { id: 'kept', held: 'kept', fs: { ...base, citizen: citizen(PDA), keyKept: PDA } },
  { id: 'no-device-key-courier', held: 'program', fs: { ...base, session: null, sessionProblem: null, citizen: citizen(PDA) } },
  { id: 'no-device-key-unknown', held: null, fs: { ...base, session: null, sessionProblem: null, citizen: citizen(DEVICE) } },
];
const VIEWS = [{ w: 1440, h: 900, card: 420 }, { w: 390, h: 844, card: 358 }];

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

for (const lang of ['en', 'ja']) for (const view of VIEWS) test(`the key card over a delegation (${lang} @ ${view.w}): warned, two separate choices, wrapped, in the shown language, no request`, { timeout: 60_000 }, async () => {
  setLang(lang);
  const cards = CASES.map(c => String(render(c.fs)));
  const bar = String(handNote({ agentId: null, agentKey: PDA, mode: 'foreign', foreign: true, program: true, expired: false }));
  setLang('ja');
  const ctx = await browser.newContext({ viewport: { width: view.w, height: view.h }, javaScriptEnabled: false });
  const requests = [];
  await ctx.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  const page = await ctx.newPage();
  try {
    await page.setContent(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${css.join('\n')}</style></head>
      <body><main style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:12px">${cards.map((c, i) => `<section class="panel" data-drawer="open" data-case="${CASES[i].id}" style="position:static;width:${view.card}px;max-height:none"><div id="panel-body"><div>${c}</div></div></section>`).join('')}
      <div data-case="bar" style="width:${view.card}px"><p class="hand-note hand-note-agent">${bar}</p></div></main></body></html>`);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-case]')].map(wrap => {
      const sec = wrap.querySelector('section.vcard') ?? wrap, box = sec.getBoundingClientRect();
      const seen = el => { const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        return { text: el.textContent.trim().replace(/\s+/g, ' '), w: r.width, h: r.height, inside: r.left >= box.left - 1 && r.right <= box.right + 1,
          overflow: el.scrollWidth > el.clientWidth + 1, visible: st.visibility !== 'hidden' && st.display !== 'none', act: el.dataset?.act ?? null, key: el.dataset?.key ?? null, top: r.top }; };
      return { id: wrap.dataset.case, held: sec.dataset?.keyHeld ?? null, w: box.width, h: box.height,
        lines: [...sec.querySelectorAll('h3, p')].map(seen), alert: [...sec.querySelectorAll('[role="alert"]')].map(seen), buttons: [...sec.querySelectorAll('button')].map(seen) };
    }));
    assert.deepEqual(rows.map(r => r.id), [...CASES.map(c => c.id), 'bar']);
    for (const r of rows) {
      assert.ok(r.w > 100 && r.h > 20, `${r.id} drawn (${r.w}×${r.h})`);
      for (const l of [...r.lines, ...r.buttons]) {
        assert.ok(l.visible && l.w > 0 && l.h > 0, `${r.id}: drawn: ${l.text}`);
        assert.ok(l.inside, `${r.id}: inside the card: ${l.text}`);
        assert.ok(!l.overflow, `${r.id}: wraps, not cut: ${l.text}`);
        if (lang === 'ja') assert.match(l.text, JP, l.text); else assert.doesNotMatch(l.text, JP, l.text);
      }
    }
    const by = Object.fromEntries(rows.map(r => [r.id, r]));
    for (const id of ['courier', 'other-device', 'expired', 'no-device-key-courier']) {
      const r = by[id];
      assert.equal(r.held, CASES.find(c => c.id === id).held, id);
      assert.equal(r.alert.length, 1, `${id}: one warning`);
      assert.match(r.alert[0].text, lang === 'ja' ? /現在登録されている鍵は使えなくなります。.*止まります/ : /currently registered key unusable\..*stops/, id);
      assert.deepEqual(r.buttons.map(b => b.act), ['session-keep', 'session-replace'], `${id}: keep first, replace second, no plain re-make`);
      assert.equal(r.buttons[1].key, id === 'other-device' ? DEVICE : PDA, `${id}: the consent names the registered key`);
      assert.ok(r.buttons.every(b => b.h >= 24 && b.w >= 60), `${id}: buttons are pressable (${r.buttons.map(b => `${b.w}×${b.h}`)})`);
    }
    assert.match(by.courier.lines.map(l => l.text).join(' '), lang === 'ja' ? /プログラムが持つ鍵です（配送の委任など）/ : /held by a program \(a delivery delegation, for example\)/);
    assert.doesNotMatch(by['other-device'].lines.map(l => l.text).join(' '), lang === 'ja' ? /プログラムが持つ鍵/ : /held by a program/);
    assert.match(by.expired.lines.map(l => l.text).join(' '), lang === 'ja' ? /期限は切れています/ : /has expired/);
    assert.deepEqual(by.kept.buttons.map(b => b.act), ['session-keep'], 'kept: only "choose again"');
    assert.deepEqual(by['no-device-key-unknown'].buttons.map(b => b.act), ['session'], 'a key that may be this wallet\'s own: the recovery button…');
    assert.match(by['no-device-key-unknown'].lines.map(l => l.text).join(' '), lang === 'ja' ? /黙って置き換えることはありません/ : /never replaced silently/, '…with its promise');
    // (round 2, verify-pr61 F2: the bar opens the whole warning first — its keep and replace are in that view)
    assert.deepEqual(by.bar.buttons.map(b => b.act), ['session-review']);
    // (round 3) every button and line of every card is readable on the drawer as the play page paints it
    for (const c of [...CASES.map(k => k.id), 'bar']) {
      if (c === 'bar') continue; // the bar is dark: tested on the real page (rekey-delegation-bar.screen.mjs)
      const rows = await page.evaluate(CONTRAST, `[data-case="${c}"]`);
      for (const r of rows) assert.ok(r.contrast >= 4.5, `${lang}@${view.w} ${c}: "${r.text}" (${r.act ?? r.tag}) contrast ${r.contrast} < 4.5 (${r.paint})`);
    }
    assert.deepEqual(requests, [], 'the cards ask for nothing');
    if (process.env.REKEY_OUT) {
      await page.screenshot({ path: `${process.env.REKEY_OUT}/rekey-warning-all-${lang}-${view.w}.png`, fullPage: true });
      await page.locator('[data-case="courier"]').screenshot({ path: `${process.env.REKEY_OUT}/rekey-warning-courier-${lang}-${view.w}.png` });
      await page.locator('[data-case="kept"]').screenshot({ path: `${process.env.REKEY_OUT}/rekey-kept-${lang}-${view.w}.png` });
    }
  } finally {
    await ctx.close();
  }
});
