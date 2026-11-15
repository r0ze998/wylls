// The expedition return card on its own (permutation-server/web/frontier/hud/returncard.mjs), English and Japanese, from
// fixture models of every phase, detail and step state that fexpedition-return.mjs originalReturnModel can return.
// Display only: the card and the language helpers are the only modules loaded, and the test checks that their import
// graph names no NFT, resident, wallet, session, guard, prize or transfer module and that the card sends nothing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnCard, returnWords } from '../../permutation-server/web/frontier/hud/returncard.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../permutation-server/web');
const CARD = resolve(WEB, 'frontier/hud/returncard.mjs');
const JP = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\b(settle[ds]?|settlement|keeper|beacon|seed|bell)\b/i;
const AMERICAN = /\b(color|center|favor|honor|defense|neighbor|armor|labor|gray)\b/i;

afterEach(() => setLang('ja'));

/** Every module the card loads (relative imports), from its source. */
function graph(entry) {
  const seen = new Set(), stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)[^;]*?from\s+['"](\.[^'"]+)['"]/gm)) stack.push(resolve(dirname(f), m[1]));
  }
  return [...seen].map(f => relative(WEB, f));
}

// fixture models, as originalReturnModel returns them (ids only)
const S = (a, b, c) => [['dissolve', a], ['resolve-leave', b], ['return-reserve', c]].map(([id, status]) => ({ id, status }));
const MODELS = [
  { name: 'unavailable', phase: 'unavailable', detail: 'unavailable', steps: S('waiting', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  ...['OriginalDepartureResolution', 'OriginalDepartureSettlement', 'RevealOrGatherEvidence', 'OriginDestroyedSettlementOrCleanupEvidence', 'DestinationResolveOrSettlementEvidence']
    .map(d => ({ name: `expedition-pending ${d}`, phase: 'expedition-pending', detail: d, steps: S('waiting', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null })),
  { name: 'resident', phase: 'resident', detail: 'resident', steps: S('proposal', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { name: 'resident without a proposal', phase: 'resident', detail: 'no-proposal', steps: S('waiting', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { name: 'leave-pending', phase: 'leave-pending', detail: 'leave-pending', steps: S('observed', 'waiting', 'waiting'), returnUnits: null, reserveAfter: null },
  { name: 'return-pending', phase: 'return-pending', detail: 'return-pending', steps: S('observed', 'observed', 'proposal'), returnUnits: '600', reserveAfter: '1000' },
];

const ENT = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };
const textOf = h => String(h).replace(/<[^>]+>/g, '\n').split('\n').map(s => s.replace(/&(amp|#39|quot|lt|gt);/g, e => ENT[e]).trim()).filter(Boolean);

test('the card loads only the language and markup helpers: no restricted module, no send, no signature, no storage', () => {
  const g = graph(CARD);
  assert.deepEqual(g.filter(f => /nft|resident|wallet|session|guard|prize|transfer|seal|keeper/i.test(f)), [], g.join(' '));
  assert.ok(g.every(f => f === 'frontier/hud/returncard.mjs' || f === 'util.mjs' || f.startsWith('lang')), g.join(' '));
  const src = readFileSync(CARD, 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '');
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|sendTransaction|signMessage|signTransaction|localStorage|sessionStorage|postMessage|WebSocket/);
});

for (const lang of ['ja', 'en']) for (const m of MODELS) test(`the return card (${lang}): ${m.name}`, () => {
  setLang(lang);
  const out = String(returnCard(m)), lines = textOf(out);
  assert.match(out, new RegExp(`data-return-phase="${m.phase}"`));
  // title, detail and each step say the card's own words, once each, in the shown language
  const title = returnWords.title(m.phase), detail = returnWords.detail(m.detail), steps = m.steps.map(s => returnWords.step(s.id));
  for (const w of [title, detail, ...steps]) {
    assert.ok(w.length > 0, 'a word for every id');
    assert.equal(lines.filter(l => l === w).length, 1, w);
  }
  assert.equal((out.match(/<li /g) ?? []).length, 3);
  for (const s of m.steps) assert.match(out, new RegExp(`data-return-step="${s.id}" data-step-state="${s.status}"`));
  const strong = [...out.matchAll(/<li [^>]*><strong>([^<]+)<\/strong>/g)].map(x => x[1]);
  assert.deepEqual(strong, m.steps.filter(s => s.status === 'proposal').map(s => returnWords.step(s.id)), 'only a proposal step is bold');
  // the reserve lines only when the model has them; the closing line always (nothing is sent from this card)
  assert.equal(lines.some(l => /600/.test(l)), m.returnUnits !== null);
  assert.equal(lines.some(l => /1,000|1000/.test(l)), m.reserveAfter !== null);
  assert.ok(lines.at(-1).length > 0);
  if (lang === 'ja') {
    for (const l of lines) assert.match(l, JP, l);
    assert.equal(lines.at(-1), '帰還の送信はまだ利用できません。予備兵への加算も行っていません。');
  } else {
    for (const l of lines) {
      assert.doesNotMatch(l, JP, `untranslated: ${l}`);
      assert.doesNotMatch(l, BANNED_EN, l);
      assert.doesNotMatch(l, AMERICAN, l);
    }
    assert.equal(lines.at(-1), 'Sending a return is not yet available. No troops have been added to reserves.');
  }
});

test('an id the card does not know says the unavailable words, never the raw id', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    assert.equal(returnWords.title('SomethingNew'), returnWords.title('unavailable'));
    assert.equal(returnWords.detail('SomethingNew'), returnWords.detail('unavailable'));
    assert.equal(returnWords.step('SomethingNew'), '');
    assert.doesNotMatch(String(returnCard({ ...MODELS[0], phase: 'SomethingNew', detail: 'SomethingNew' })), />SomethingNew</);
  }
});
