// Round 22: local play's own messages in English. Four controller texts had no English entry (an English player saw
// Japanese — at the moment an order's outcome was unknown, among others), and the start page said 精算 ("settlement" in
// English, a word kept off the play screen). Dictionary and wording only; nothing else changes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;

test('the controller\'s local-play texts are in English, clean of the play screen\'s banned words', () => {
  setLang('en');
  const sig = '5xHNXfJzgPcUsPekoXSYXE86';
  const texts = [
    L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`,
    L`この命令は送信済みですが、まだ確認できていません。同じ命令は送り直しません。もう一度押すと結果を確認します。署名 ${sig}`,
    L`送信済みの命令の結果を確認しています…`,
    L`ローカルプレイの接続先が、確認したときと変わりました。ページを開き直してください。`,
  ];
  for (const t of texts) { assert.doesNotMatch(t, CJK, t); assert.doesNotMatch(t, BANNED_EN, t); }
  assert.match(texts[1], new RegExp(`Signature ${sig}$`), 'the signature is still said');
  assert.match(texts[1], /not sent again/, 'it still says nothing is sent again');
  // (they are the texts the controller uses)
  const c = src('controller.mjs');
  for (const k of ['ローカルプレイでは、まだ命令を送れません（読み取りのみ）。', '送信済みの命令の結果を確認しています…', 'ローカルプレイの接続先が、確認したときと変わりました。ページを開き直してください。'])
    assert.ok(c.includes(`L\`${k}\``), k);
});

test('the start page says the turn waits for marches and their results — not 精算 / "settlement"', () => {
  const lp = src('flocalplay.mjs');
  assert.doesNotMatch(lp, /精算/);
  assert.ok(lp.includes('L`通常速度では1ターン10分です。世界の開始後も、進軍やその結果の受け取りにはターンの進行を待ちます。`'));
  setLang('en');
  const en = L`通常速度では1ターン10分です。世界の開始後も、進軍やその結果の受け取りにはターンの進行を待ちます。`;
  assert.doesNotMatch(en, CJK); assert.doesNotMatch(en, BANNED_EN, en); assert.match(en, /10 minutes/);
});
