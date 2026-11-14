// ⑰ NFT prize: the pass section of the 賞金 panel and the join terms, in the
// normal English UI, rendered by the page's REAL modules
// (frontier/screens/prize.mjs, fprize.mjs, lang.mjs, frontier.css) in a real
// Chromium, over literal fixtures. Checks what a player sees and what can be
// pressed for: the current owner (claim offered; held while busy), a former
// owner, an earlier generation's claim, the pass's own claim, refund mode and
// the refused new deposit (panel and join terms).
//
// FIXTURE, not gameplay: no wallet, no relay, no chain, no validator, no
// network beyond this test's own GET-only static server on 127.0.0.1:0; any
// non-GET or off-origin request is aborted and fails the test. Nothing is
// built or downloaded: Chromium comes from the local Playwright cache and
// playwright-core from PLAYWRIGHT_CORE (an absolute path to an existing
// install) or this folder's own node_modules. Without either the test is
// skipped and says why.
//
//   PLAYWRIGHT_CORE=/abs/path/node_modules/playwright-core/index.mjs \
//     node --import ./codex/no-key-node.mjs --test prize-pass.screen.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../../permutation-server/web/', import.meta.url));
const SHOT = process.env.PRIZE_PASS_SHOT ?? null;
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };
const JA = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

// Literal identities the page only prints (never derived).
const A = 'WaLLetA111111111111111111111111111111111111';
const B = 'OwnerB22222222222222222222222222222222222222';
const ASSET = 'Asset5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5';
const CITIZEN = 'Citizen41414141414141414141414141414141414141';
const PROOF = { policy: 'Policy61', link: 'Link62', asset: ASSET, resident: 'Resident63' };
const pool = (extra = {}) => ({ testAssetsOnly: true, program: 'PrizeProgram', pool: 'Pool', vault: 'Vault', mint: 'Mint', decimals: 6, fee: '25000000', opsBps: 2000, prizeBps: 8000,
  entries: 2, collected: '50000000', prize: '40000000', ops: '10000000', state: 'open', expectedKeeps: 54, counted: 0, area: null, winners: null, shares: null, ...extra });
const posted = (extra = {}) => pool({ state: 'shares', counted: 54, area: [8, 10, 9, 9, 9, 9], winners: [1],
  shares: { mode: 'shares', shareNations: 1, totalPoints: ['0', '16', '0', '0', '0', '0'], claims: 0, claimed: '0', root: 'ab', ledgerHash: 'cd' }, ...extra });
const entry = (extra = {}) => ({ paid: '25000000', paidBy: A, payGeneration: 0, claimed: false, claimedBy: null, claimGeneration: null, claimAmount: '0', nation: null, ...extra });
const pass = e => ({ asset: ASSET, citizen: CITIZEN, faction: 1, entry: e });
const ledger = { provisional: true, provisionalRules: [], kinds: {}, lines: [], estimate: { split: [] },
  shares: { mode: 'shares', members: [{ wallet: `pass:${ASSET}`, asset: ASSET, nation: 1, points: 10, proof: ['00'.repeat(32)] }] } };
const resident = generation => ({ asset: ASSET, citizen: CITIZEN, generation, joined: true, proof: PROOF });
const fs = (wallet, generation, prize, extra = {}) => ({ wallet: { address: wallet }, inFlight: 0, prize, prizeLedger: ledger, resident: resident(generation), prizePass: null, ...extra });

/** Each case: the store, which screen renders it, and what must (not) be there. */
const CASES = {
  currentOwner: { FS: fs(B, 1, posted({ pass: pass(entry()) })), view: 'panel', text: [/Estimated claim: 25/, /Claim this NFT's prize/, /only its current owner can claim/i], button: 'enabled' },
  currentOwnerBusy: { FS: fs(B, 1, posted({ pass: pass(entry()) }), { inFlight: 1 }), view: 'panel', text: [/Claim this NFT's prize/], button: 'disabled' },
  formerOwner: { FS: fs(A, null, posted({ pass: pass(entry()) })), view: 'panel', text: [/not in this wallet now/i], button: 'none' },
  earlierGeneration: { FS: fs(A, 2, posted({ pass: pass(entry({ claimed: true, claimedBy: B, claimGeneration: 1, claimAmount: '25000000' })) })), view: 'panel', text: [/Claimed by a previous owner: 25/, /generation 1/], button: 'none' },
  claimedOwn: { FS: fs(A, 2, posted({ pass: pass(entry({ claimed: true, claimedBy: A, claimGeneration: 2, claimAmount: '25000000' })) })), view: 'panel', text: [/Claimed: 25 test USDC/, /no second claim/i], button: 'none' },
  refund: { FS: fs(B, 1, posted({ pass: pass(entry()), shares: { mode: 'refund', shareNations: 0, totalPoints: ['0', '0', '0', '0', '0', '0'], claims: 0, claimed: '0', root: 'ab', ledgerHash: 'cd' } })), view: 'panel', text: [/undecided/i], button: 'none' },
  depositRefusedPanel: { FS: fs(B, 1, posted({ pass: pass(null) })), view: 'panel', text: [/not taken until its refund right is decided/i, /cannot pay one now/i], button: 'none', deposit: true },
  depositRefusedJoin: { FS: fs(B, 1, pool({ pass: pass(null) })), view: 'join', text: [/not taken until its refund right is decided/i], button: 'none', deposit: true, noFaucet: true },
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/frontier/frontier.css">
<title>prize pass fixture</title><style>html, body { height: auto !important; overflow: auto !important; }</style></head><body class="frontier"><main id="cases"></main>
<script type="module">
import { setLang } from '/lang.mjs';
import { render, renderJoinTerms } from '/frontier/screens/prize.mjs';
setLang('en');
const cases = await (await fetch('/__cases.json')).json();
const host = document.getElementById('cases');
for (const [name, c] of Object.entries(cases)) {
  const s = document.createElement('section');
  // (a plain block at the drawer's width: the real .panel is position: fixed, one drawer at a time)
  // The real drawer surface (.panel), with only its fixed placement undone so the cases sit side by side.
  s.dataset.case = name; s.className = 'panel';
  s.style.cssText = 'position: relative; inset: auto; top: auto; right: auto; max-height: none; transform: none; display: inline-block; vertical-align: top; width: var(--drawer-w); margin: 10px; padding: 10px 14px; overflow: visible;';
  s.innerHTML = '<p class="fixture-label">FIXTURE · ' + name + '</p><div class="panel-body-fixture">' + String(c.view === 'join' ? renderJoinTerms(c.FS) : render(c.FS)) + '</div>';
  host.append(s);
}
document.body.dataset.ready = '1';
</script></body></html>`;

function startStatic() {
  const seen = [];
  const srv = createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__fixture.html') { res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE); return; }
    if (url.pathname === '/__cases.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(Object.entries(CASES).map(([k, v]) => [k, { FS: v.FS, view: v.view }])))); return; }
    const file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
    if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
    try { res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); }
    catch { res.writeHead(404).end(); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, origin: `http://127.0.0.1:${srv.address().port}` })));
}

async function loadChromium() {
  const spec = process.env.PLAYWRIGHT_CORE ?? 'playwright-core';
  try { return { chromium: (await import(spec)).chromium }; } catch (e) { return { why: `playwright-core not importable from ${spec}: ${e?.code ?? e?.message}` }; }
}

const pw = await loadChromium();

test('the English prize screen over fixtures: who may claim, what is held back, and the refused deposit', { skip: pw.why ?? false }, async () => {
  const { srv, seen, origin } = await startStatic();
  const browser = await pw.chromium.launch();
  const refused = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/*', route => {
      const r = route.request();
      if (r.method() !== 'GET' || !r.url().startsWith(origin)) { refused.push(`${r.method()} ${r.url()}`); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/__fixture.html`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 15000 });
    assert.deepEqual(errors, [], 'the real modules load and render without an error');

    for (const [name, c] of Object.entries(CASES)) {
      const sec = page.locator(`section[data-case="${name}"]`);
      const text = (await sec.innerText()).replace(`FIXTURE · ${name}`, '');
      assert.ok(text.trim().length > 0, `${name}: something is shown`);
      assert.doesNotMatch(text, JA, `${name}: English only`);
      assert.doesNotMatch(text, BANNED_EN, `${name}: no banned word`);
      for (const re of c.text) assert.match(text, re, `${name}: ${re}`);
      const btn = sec.locator('button[data-act="prize-claim-pass"]');
      const n = await btn.count();
      if (c.button === 'none') assert.equal(n, 0, `${name}: no claim button`);
      else {
        assert.equal(n, 1, `${name}: one claim button`);
        assert.equal(await btn.isVisible(), true, `${name}: visible`);
        assert.equal(await btn.isDisabled(), c.button === 'disabled', `${name}: ${c.button}`);
        // Pressable means really on top at its centre (not covered by anything).
        await btn.scrollIntoViewIfNeeded();
        const hit = await btn.evaluate(el => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && (top === el || el.contains(top)); });
        if (c.button === 'enabled') assert.equal(hit, true, `${name}: the button is on top`);
      }
      if (c.deposit) {
        assert.equal(await sec.locator('[data-pass-deposit="refused"]').count(), 1, `${name}: the refusal is marked`);
        // The pass's own block (.pz-pass on the panel, .prize-terms on the join screen) offers nothing to press.
        const own = sec.locator(c.view === 'join' ? '.prize-terms' : '.pz-pass');
        assert.equal(await own.count(), 1, `${name}: the pass's block is there`);
        assert.equal(await own.locator('button, a[href], [data-act]').count(), 0, `${name}: nothing to press for a deposit`);
        assert.ok(await sec.locator('[data-pass-deposit="refused"]').isVisible(), `${name}: the refusal is visible`);
        assert.doesNotMatch(text, /x402|paying the entry fee/i, `${name}: no payment is offered`);
      }
      if (c.noFaucet) assert.equal(await sec.locator('[data-act="prize-faucet"]').count(), 0, `${name}: no faucet`);
    }
    // A forced press on the busy (disabled) button sends nothing.
    const before = seen.length;
    await page.locator('section[data-case="currentOwnerBusy"] button[data-act="prize-claim-pass"]').click({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(200);
    assert.equal(seen.length, before, 'the disabled claim sends no request');
    // Evidence (optional): one image per case of the pass's own block, into the folder PRIZE_PASS_SHOT names.
    if (SHOT) for (const [name, c] of Object.entries(CASES)) {
      const own = page.locator(`section[data-case="${name}"] ${c.view === 'join' ? '.prize-terms' : '.pz-pass'}`);
      writeFileSync(path.join(SHOT, `prize-pass-${name}.png`), await own.screenshot());
    }
  } finally {
    await browser.close();
    srv.close();
  }
  assert.deepEqual(refused, [], 'no off-origin or non-GET request was attempted');
  assert.ok(seen.every(s => s.startsWith('GET ')), 'the static server saw GET only');
});
