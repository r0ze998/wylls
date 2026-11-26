// en-ui-audit-2 (English-first audit of the game page, 2026-11-26): what the live English walk found, held here.
//  1 a dictionary file names each Japanese key once: a second entry in the same object literal silently replaces the
//    first (en-a11y-sweep D-6). 25 such pairs were left (en-frontier.mjs 17 — the wide-history block twice —, en-frontier-
//    play.mjs 8); the earlier copy of each was dead, so removing it changed no text on screen
//  2 counts that do reach 1 in play take the singular ("Surveyed 1 new tile", "Read 1 record …", "Aster's territory: 1
//    tile", "1 holding", "Loaded 1 record …")
//  3 one wording for one thing: training is "instant" (the panel and the guide step said "instant", the hand bar's hint
//    and the scout tip "immediate"); the caravan shortcut names the village fold by its label "Trade and defences"
//  4 a11y: a "Claim a tile" / "Found a village here" button that is off (or will be refused) names the card's line that
//    says why (aria-describedby), so a screen reader hears the reason with the button
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { EN, setLang, L } from '../../permutation-server/web/lang.mjs';
import { tileWhy } from '../../permutation-server/web/frontier/screens/holding.mjs';

const webUrl = f => new URL(`../../permutation-server/web/${f}`, import.meta.url);
const web = f => readFileSync(webUrl(f), 'utf8');

/** Every key of the object literal(s) in a dictionary file, with its line: an entry starts a line or follows a comma. */
function keysOf(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/(?:^\s*|,\s+)(['"])((?:\\.|(?!\1).)*)\1\s*:/g)) out.push({ key: m[2], line: i + 1 });
  });
  return out;
}

test('1 every dictionary file names each key once (a second entry would silently replace the first)', () => {
  const files = readdirSync(webUrl('lang/')).filter(f => /^en-.*\.mjs$/.test(f));
  assert.ok(files.length >= 11, 'the eleven English groups');
  const twice = [];
  for (const f of files) {
    const seen = new Map();
    for (const { key, line } of keysOf(web(`lang/${f}`))) {
      if (seen.has(key)) twice.push(`${f}:${seen.get(key)} and :${line} ${key.slice(0, 40)}`);
      else seen.set(key, line);
    }
  }
  assert.deepEqual(twice, []);
  // (the scan sees entries written as the files write them: one known entry of each shape)
  const keys = keysOf(web('lang/en-frontier-play.mjs')).map(k => k.key);
  assert.ok(keys.includes('進軍と来襲') && keys.includes('交易と防備') && keys.includes('{0}の領地：{1}マス'));
});

test('2 counts that reach 1 in play take the singular', () => {
  setLang('en');
  try {
    const n = 1, m = 3;
    assert.equal(L`新しく ${n} マスを測量しました`, 'Surveyed 1 new tile');
    assert.equal(L`新しく ${m} マスを測量しました`, 'Surveyed 3 new tiles');
    assert.equal(L`第${10}〜${12}ターンの記録 ${n} 件を読みました。`, 'Read 1 record of turns 10–12.');
    assert.equal(L`第${10}〜${12}ターンの記録 ${m} 件を読みました。`, 'Read 3 records of turns 10–12.');
    assert.equal(L`${'Aster'}の領地：${n}マス`, "Aster's territory: 1 tile");
    assert.equal(L`${'Aster'}の領地：${m}マス`, "Aster's territory: 3 tiles");
    assert.equal(L`保有地 ${n} 件`, '1 holding');
    assert.equal(L`保有地 ${m} 件`, '3 holdings');
    assert.match(L`このページで ${n} 件取得。取得元の完全性・アカウントとの一致は未検証です。土地やプレイ可能状態は示しません。`, /^Loaded 1 record on this page\. /);
    assert.match(L`このページで ${m} 件取得。取得元の完全性・アカウントとの一致は未検証です。土地やプレイ可能状態は示しません。`, /^Loaded 3 records on this page\. /);
    // (the surviving entries are the ones the page showed before: the later copy of each pair)
    assert.equal(L`城砦 ${'Aster'}`, 'Keep: Aster');
    assert.equal(L`読み取り専用`, 'Read-only');
  } finally { setLang('ja'); }
});

test('3 one wording for one thing: "instant" training, the fold named by its label', () => {
  assert.equal(EN['訓練はすぐに終わり、兵は控えに入ります'], 'Training is instant; the troops join the reserve');
  assert.equal(EN['訓練はすぐに終わり、兵は控えに入ります。'], 'Training is instant; the troops join the reserve.');
  assert.match(EN['村の周りを調べる斥候を100人、訓練しましょう。訓練はすぐに終わります。'], /Training is instant\.$/);
  const english = Object.values(EN).filter(v => typeof v === 'string');
  assert.equal(english.filter(v => /Training is immediate/.test(v)).length, 0);
  assert.equal(EN['交易と防備'], 'Trade and defences');
  assert.match(EN['押すと、村の画面の「交易と防備」が開き、この場所が入ります。運ぶものと量は、そこであなたが入れます。まだ何も送りません。'], /opens "Trade and defences" on the village screen/);
  assert.equal(english.filter(v => /"Trade and defence"/.test(v)).length, 0);
});

test('4 a11y: an off "Claim a tile" / "Found a village here" button names the line that says why', () => {
  assert.equal(tileWhy({}), '');
  assert.equal(tileWhy({ territory: true, tileShort: true }), ' aria-describedby="hp-tile-why-ore"');
  assert.equal(tileWhy({ territory: true, tilePriceShort: true }), ' aria-describedby="hp-tile-why-price"');
  assert.equal(tileWhy({ territory: true, land: { unpaid: true } }), ' aria-describedby="hp-tile-why-unpaid hp-own-land-unpaid"');
  assert.equal(tileWhy({ territory: true, tileShort: true, land: { unpaid: true } }), ' aria-describedby="hp-tile-why-ore hp-tile-why-unpaid hp-own-land-unpaid"');
  const src = web('frontier/screens/holding.mjs');
  // every id named is on the card's reason line
  for (const id of ['hp-tile-why-ore', 'hp-tile-why-price', 'hp-tile-why-unpaid', 'hp-own-land-unpaid', 'hp-wide-short']) assert.ok(src.includes(`id="${id}"`), id);
  // every "Claim a tile" button carries it, and "Found a village here" names the short resources while it is off for them
  assert.equal((src.match(/data-act="territory-tile"[^>]*\$\{raw\(tileWhy\(w\)\)\} aria-label=/g) ?? []).length, 3);
  assert.match(src, /data-act="wide-claim"[^>]*\$\{raw\(w\.short\.length \? ' aria-describedby="hp-wide-short"' : ''\)\} aria-label=[^>]*\$\{raw\(busy \|\| w\.short\.length \? 'disabled' : ''\)\}>/);
});
