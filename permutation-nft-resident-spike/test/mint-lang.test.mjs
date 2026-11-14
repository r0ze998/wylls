// The mint page's English (web/mint-lang.mjs): the language choice, the placeholders, and that every Japanese
// text the page can show has an English entry — every T`…` template in web/mint.mjs (parsed from the source,
// nested templates included), every [data-i18n] text and the title in web/mint.html, every sale refusal and the
// server's TEST price label. No browser, no chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EN, T, pickLang, setLang, tr } from '../web/mint-lang.mjs';
import { SALE_TEXT } from '../web/sale.mjs';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const CJK = /[぀-ヿ一-鿿]/;

/** Every T`…` template's key in `src` (its literal parts with {0}, {1}… for the values), nested ones included. */
function templateKeys(src) {
  const keys = [];
  const parse = i => { // i: index just after the opening backtick; returns [key, index after the closing backtick]
    let key = '', n = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { key += src[i + 1]; i += 2; continue; }
      if (c === '`') return [key, i + 1];
      if (c === '$' && src[i + 1] === '{') {
        let depth = 1; i += 2;
        while (depth > 0) {
          if (src[i] === '`') { const nested = src.slice(i - 1, i) === 'T'; const [k, j] = parse(i + 1); if (nested) keys.push(k); i = j; continue; }
          if (src[i] === '{') depth++;
          if (src[i] === '}') depth--;
          i++;
        }
        key += `{${n++}}`;
        continue;
      }
      key += c; i++;
    }
    throw new Error('unterminated template');
  };
  for (let i = src.indexOf('T`'); i >= 0; i = src.indexOf('T`', i + 1)) {
    if (/[\w$]/.test(src[i - 1] ?? '')) continue;
    const [k, j] = parse(i + 2);
    keys.push(k);
    i = j - 1;
  }
  return keys;
}

test('the language: ?lang first (kept), then the saved choice, then English for every browser (Japanese only when asked)', () => {
  assert.deepEqual(pickLang({ search: '?lang=en', saved: 'ja' }), { lang: 'en', save: true });
  assert.deepEqual(pickLang({ search: '?lang=ja', saved: 'en' }), { lang: 'ja', save: true });
  assert.deepEqual(pickLang({ search: '', saved: 'en' }), { lang: 'en', save: false });
  assert.deepEqual(pickLang({ search: '', saved: 'ja' }), { lang: 'ja', save: false });
  assert.deepEqual(pickLang({ search: '?lang=xx', saved: null }), { lang: 'en', save: false });
  assert.deepEqual(pickLang({ search: '', saved: null }), { lang: 'en', save: false }, 'a Japanese browser too: English is the default');
});

test('T fills the values in either language; an unknown text stays as written', () => {
  try {
    setLang('en', { save: false });
    assert.equal(T`約 ${'0.1 SOL'}`, 'about 0.1 SOL');
    assert.equal(T`プログラムが拒否しました：${'SoldOut'}（課金なし）`, 'Refused by the program: SoldOut (nothing charged)');
    assert.equal(tr('not a key'), 'not a key');
    setLang('ja', { save: false });
    assert.equal(T`約 ${'0.1 SOL'}`, '約 0.1 SOL');
  } finally { setLang('ja', { save: false }); }
});

test('every Japanese text the page can show has English, with the same placeholders, and keeps TEST', () => {
  const keys = templateKeys(read('../web/mint.mjs'));
  assert.ok(keys.length >= 45, `found ${keys.length} templates`);
  const html = read('../web/mint.html');
  const statics = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n\b[^>]*>([^<]*)<\/\1>/g)].map(m => m[2].trim());
  const title = /<title>([^<]*)<\/title>/.exec(html)[1];
  const all = [...keys, ...statics, title, ...Object.values(SALE_TEXT), 'TEST PRICE — 試験用の仮値、本番価格ではない'];
  const placeholders = s => (s.match(/\{\d+\}/g) ?? []).sort().join();
  for (const k of all.filter(k => CJK.test(k))) {
    assert.ok(Object.hasOwn(EN, k), `English for: ${k}`);
    assert.doesNotMatch(EN[k], CJK, `no Japanese in: ${EN[k]}`);
    assert.equal(placeholders(EN[k]), placeholders(k), `placeholders of: ${k}`);
  }
  assert.match(EN['TEST PRICE — 試験用の仮値、本番価格ではない'], /^TEST PRICE/);
  assert.match(EN['価格はテスト用で、本番の販売条件ではありません。費用は見込みで、確定値は取引で決まります。'], /TEST value/);
  assert.equal(statics.filter(s => CJK.test(s)).length, statics.length, 'every marked element is Japanese in the page');
});
