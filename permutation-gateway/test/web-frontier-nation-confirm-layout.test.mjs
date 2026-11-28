// The nation choice's confirm line (frontier.css .nation-confirm; markup: screens/join.mjs renderNations).
// Found in the browser at 1200 × 1125 with no wallet connected and three wallets listed, two of them not supported:
// the action column was an `auto` track, took the wallet list's max-content width (755 of 960 px) and left the
// words and the refusal line 67 px, one character a line.
// Source text only: no page, no layout engine, no wallet. The widths themselves are the browser check's.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css=readFileSync(new URL('../../permutation-server/web/frontier/frontier.css',import.meta.url),'utf8');
const join=readFileSync(new URL('../../permutation-server/web/frontier/screens/join.mjs',import.meta.url),'utf8');
/** The declarations of every rule whose whole selector is `selector`, in source order. */
function rules(selector) {
  const esc=selector.replace(/[.*+?^${}()|[\]\\>]/g,'\\$&').replace(/ /g,'\\s+');
  return [...css.matchAll(new RegExp(`(?:^|[}{;\\n])\\s*${esc}\\s*\\{([^}]*)\\}`,'g'))].map(m=>m[1]);
}
const columns=block=>/grid-template-columns:\s*([^;]+);/.exec(block)?.[1].trim()??null;

test('the words keep a readable width and the action column cannot take more than is left',()=>{
  const all=rules('.nation-confirm').map(columns).filter(Boolean);
  assert.ok(all.length>=3,'the base rule and both one-column widths');
  const [base]=all;
  const tracks=/^minmax\(([^,]+),\s*1fr\)\s+minmax\(0,\s*auto\)$/.exec(base);
  assert.ok(tracks,`two tracks, the second shrinkable: ${base}`);
  assert.match(tracks[1].trim(),/^\d+(\.\d+)?rem$/,'the words have a floor of their own');
  assert.ok(parseFloat(tracks[1])>=18,'wide enough for a sentence');
  for(const narrow of all.slice(1)) assert.equal(narrow,'minmax(0, 1fr)','one column that cannot be widened by its content');
  assert.ok(!all.some(c=>/(^|\s)auto(\s|$)/.test(c)),'no bare auto track');
});

test('the wallets wrap inside the action column and a refusal spans the plaque',()=>{
  assert.ok(rules('.nc-go').some(b=>/flex-wrap:\s*wrap/.test(b)));
  assert.ok(rules('.nc-go').some(b=>/min-width:\s*0/.test(b)));
  assert.ok(rules('.nc-wallet').some(b=>/min-width:\s*0/.test(b)&&/max-width:\s*100%/.test(b)));
  assert.ok(rules('.wallet-list').some(b=>/flex-wrap:\s*wrap/.test(b)));
  assert.ok(rules('.nc-wallet .wallet-list li').some(b=>/min-width:\s*0/.test(b)));
  assert.ok(rules('.nc-wallet .muted').some(b=>/overflow-wrap:\s*anywhere/.test(b)),'a long reason breaks rather than widen the column');
  assert.ok(rules('.nation-confirm > .notice').some(b=>/grid-column:\s*1\s*\/\s*-1/.test(b)));
});

test('a phone holds only the short line to the foot: with the wallet list it lies in the flow',()=>{
  // Found at 390 × 844 with no wallet connected: the held line, as tall as its wallet list, covered the banners
  // (the middle of a banner answered .nc-wallet, and a tap did not choose the nation).
  /** The condition of the last `@media` opened at the start of a line before `at` (the stylesheet nests no at-rules). */
  const mediaAt=at=>/^@media ([^{]+?) \{/.exec(css.slice(css.lastIndexOf('\n@media ',at)+1))?.[1]??null;
  const held=/\n\s*\.nation-confirm \{ position: sticky; bottom: 0;/.exec(css);
  assert.ok(held,'the connected line, the one button, is still held to the foot');
  assert.equal(mediaAt(held.index),'(max-width: 759px)');
  const flow=/\n\s*\.nation-confirm:has\(\.nc-wallet\) \{ position: static; \}/.exec(css);
  assert.ok(flow,'with the wallet list the line is not held');
  assert.equal(mediaAt(flow.index),'(max-width: 759px)','only on a phone: a wide screen\'s plaque is not held and needs no exception');
  assert.ok(flow.index>held.index&&!css.slice(held.index,flow.index).includes('\n}\n'),'in the same phone block as the held rule');
  assert.equal(css.split('.nation-confirm:has(.nc-wallet)').length-1,1,'one exception, no other rule on that condition');
  // the condition is the markup's: .nc-wallet exists exactly when no wallet is connected
  // (demo-polish-2: in the walletless demo, a browser without Ed25519 gets its notice in the button's place first)
  assert.match(join,/\$\{demoCrypto \? demoCryptoNotice\(demoCrypto\) : FS\.wallet \? html`<button type="button" class="btn primary nc-btn"[\s\S]*?: html`<div class="nc-wallet">/);
});

test('the markup these rules are written for',()=>{
  // the refusal is a direct child of the confirm line; the wallets and their reasons sit in .nc-wallet inside .nc-go
  assert.match(join,/<div class="nation-confirm\$\{pick \? '' : ' nc-empty'\}">/);
  assert.match(join,/<div class="nc-go">[\s\S]*?<div class="nc-wallet">[\s\S]*?walletButtons\(FS\)\}<\/div>`\}\s*<\/div>\s*\$\{instant && FS\.homeChoice\?\.error \? html`<p class="notice error" role="alert">/);
  assert.match(join,/<ul class="wallet-list">[\s\S]*?<span class="muted">\$\{w\.why\}<\/span>/);
});
