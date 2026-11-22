// The board's English (coop/tr.mjs, coop/lang/en.mjs): the table covers every Japanese text the board's code can
// show, its entries are well formed, and real texts made by the board's own modules come out in English. Display
// only: the modules keep writing Japanese (the other coop tests pin that), and coop-ui.mjs is not run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { literalsOf, segmentsOf, htmlTexts } from './lang-extract.mjs';
import EN from '../coop/lang/en.mjs';
import { translator, toEnglish, JA, plainKey, format, needsEnglish } from '../coop/tr.mjs';
import { fulfilBoundsText, jointPrecisionText, lowerBoundText } from '../coop/fulfil-bounds.mjs';
import { compositionText } from '../coop/composition.mjs';
import { ARRIVED_JA, renderArrived } from '../coop/arrived.mjs';

// the resource names as record.mjs RESOURCE_JA gives them (not imported: this file stays free of modules that name a key API,
// so CI's key-free job runs it; the modules that do are read in coop.lang-modules.test.mjs)
const RESOURCE_JA = { food: '食料', wood: '木材', stone: '石材', ore: '鉱石', arms: '兵器', gold: '金' };

const dir = new URL('../coop/', import.meta.url);
const read = f => readFileSync(new URL(f, dir), 'utf8');
const MODULES = readdirSync(dir).filter(f => f.endsWith('.mjs') && !['lang.mjs', 'tr.mjs'].includes(f));
/** Texts that never reach the page: the board server's command line. */
const NOT_SHOWN = new Set([
  '--program と --season が要る（frontier-stack の state.json の program id とシーズン番号）',
  '依頼の板：http://127.0.0.1:{0}/ws01/  ゲーム：http://127.0.0.1:{1}/frontier/frontier/  （ヘラルド {2}、記録 {3}）',
]);
const sourceKeys = () => {
  const out = new Map();
  for (const k of htmlTexts(read('index.html'))) out.set(k, 'index.html');
  for (const f of MODULES) for (const l of literalsOf(read(f))) for (const k of segmentsOf(l.text)) if (!NOT_SHOWN.has(k)) out.set(k, `${f}:${l.line}`);
  return out;
};
const PLAIN = new Set(Object.keys(EN).map(plainKey));
const sample = k => k.replace(/\{(\d+)(?::[a-z])?\}/g, (m, d) => String(3 + +d));

test('the extractor reads strings, templates and nested templates, and skips comments and regular expressions', () => {
  const src = "// コメント\nconst a = 'ひとつ'; const r = /[\"'`]/g; /* 二つ */ const b = `前 ${x ? `中 ${y}` : '外'} 後 <b>${z}</b>：終`;";
  assert.deepEqual(literalsOf(src).map(l => l.text), ['ひとつ', '前 {0} 後 <b>{1}</b>：終', '中 {0}', '外']);
  assert.deepEqual(segmentsOf('前 {0} 後 <b>{1}</b>：終'), ['前 {0} 後', '：終']);
  assert.deepEqual(segmentsOf('<span class="{0}">数えた量 {1}（下限）</span>{2}'), ['数えた量 {0}（下限）']);
  assert.ok(htmlTexts(read('index.html')).includes('国をまたぐ依頼'));
  assert.ok(sourceKeys().size > 450, 'the board has about 500 texts');
});

test('every Japanese text of the board has English: the key itself, or the text comes out without Japanese', () => {
  const lacking = [];
  for (const [k, where] of sourceKeys()) {
    if (PLAIN.has(k)) continue;
    const en = toEnglish(sample(k));
    if (JA.test(en) || needsEnglish(en)) lacking.push(`${where}: ${k} → ${en}`);
  }
  assert.deepEqual(lacking, []);
});

test('the table: no Japanese in the English, every value of a key is said, neighbours stay neighbours, no key twice', () => {
  const src = read('lang/en.mjs');
  const bad = [];
  for (const [key, en] of Object.entries(EN)) {
    const n = [...key.matchAll(/\{(\d+)(?::[a-z])?\}/g)].map(m => +m[1]);
    const args = n.map((_, i) => String(2 + i));
    const text = typeof en === 'function' ? en(...args) : en;
    if (typeof text !== 'string') { bad.push(`${key}: not a text for sample values`); continue; }
    if (needsEnglish(text)) bad.push(`${key}: Japanese or full-width punctuation in the English`);
    for (const i of n) if (!new RegExp(`\\{${i}\\^?\\}`).test(text)) bad.push(`${key}: {${i}} is not in the English`);
    if (/\{\d+\}/.test(key) && !/[^{}\d]/.test(plainKey(key).replace(/\{\d+\}/g, ''))) bad.push(`${key}: a key needs fixed text`);
    for (const m of key.matchAll(/\{(\d+)(?::[a-z])?\}\{(\d+)(?::[a-z])?\}/g)) if (!text.includes(`{${m[1]}}{${m[2]}}`)) bad.push(`${key}: {${m[1]}}{${m[2]}} must stay side by side`);
    const lastKey = /\{(\d+)\}$/.exec(key);
    if (lastKey && !/^\{/.test(key) && !new RegExp(`\\{${lastKey[1]}\\}\\s*$`).test(text)) bad.push(`${key}: a value at the end of the key must end the English`);
    if (/[<>&]/.test(text.replace(/->|→/g, ''))) bad.push(`${key}: no markup in the English`);
    assert.equal(format(text, args).includes('{'), /\{"|\{$/.test(text) ? true : false, `${key}: placeholders filled`);
  }
  assert.deepEqual(bad, []);
  const keys = [...src.matchAll(/^\s*'((?:[^'\\]|\\.)+)':/gm)].map(m => m[1]);
  const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(twice, [], 'a key written twice silently overrides the first');
  // the words of the game page's glossary
  assert.equal(EN['木材'], 'Wood'); assert.equal(EN['隊商'], 'Caravan'); assert.equal(EN['国1'], 'Nation 1 – Aster'); assert.equal(EN['国6'], 'Nation 6 – Fjordal');
  assert.match(EN['依頼に「応じる」は、送るつもりがあるという表明だけです。物は動かず、送る義務もありません。物が動くのは、送る人がゲームの村の引き出し「交易と防備」から自分のウォレットで署名して出した隊商だけです。 物々交換・加工の貸出・届いたら払う、はありません（贈り物です。届いた物は受け取った人の物になります）。数えるのは、確定の記録で確かめた到着だけです。'], /“Trade and defences”/);
});

test('texts as the page shows them: lists, nested reasons, brackets, parts next to markup', () => {
  const eq = (ja, en) => assert.equal(toEnglish(ja), en);
  eq('応答：abcd…wxyz（国1）：送るつもり 木材 200・石材 200 / efgh…ijkl（国3）：断った', 'Responses: abcd…wxyz (Nation 1 – Aster): means to send Wood 200 · Stone 200 / efgh…ijkl (Nation 3 – Cinder): declined');
  eq('取り消し：自分で進める', 'Cancelled: going on alone');
  eq('／200　石材 ', '/200 · Stone ');
  eq('（', ' (');
  eq('）の貯蔵庫：', '), storehouse: ');
  eq('の隊商 #3（送り元 (1,2) 村3）：木材 200。', ': caravan #3 (from (1,2) site 3): Wood 200.');
  eq('(1,2) 村3・世代 1：持ち主は自分（読んだ時点。送るときにもう一度確かめる）（選択中）', '(1,2) site 3 · generation 1: yours (when read; checked again on sending) (chosen)');
  eq('数えていない（到着時の受取人が未検証：村の世代が変わった（到着時 1、今 2：占領か再入植）。到着時の持ち主は今の口座からは確定できない。まだ決まっていない）',
    'Not counted (the recipient on arrival is unverified: the village\'s generation changed (on arrival 1, now 2: captured or settled again). The owner on arrival cannot be decided from the present account. Not decided yet)');
  eq('受け付けられなかった：依頼は取り消された', 'Not accepted: the request was cancelled');
  eq('国2（チェーンの Citizen で確かめた）：依頼 1 件、この国の人が届けた証明できる到着 2 本', 'Nation 2 – Borealis (confirmed by the Citizen account on the chain): 1 request, 2 provable arrivals delivered by people of this nation');
  eq('読み込めない：HTTP 502。表示は 12:00:01 の読み込みのまま（古い）。自動で読み直しを続けます', 'Cannot load: HTTP 502. The view is still the one loaded at 12:00:01 (old). Reloading continues automatically');
  eq('依頼した人（世代 1）', 'the requester (generation 1)');
  // confirm(): the page gives it line by line (lang.mjs shown)
  eq('村 (1,2) 村3 から 5 マス、隊商 #2 で 木材 200・石材 200 を送ります。', 'Sending Wood 200 · Stone 200 from village (1,2) site 3, 5 tiles, as caravan #2.');
  eq('送り元の在庫（見込み）：木材 500・石材 100。不足（見込み）：石材 100。足りるかの最終判定は、送信の時にプログラムが行う', 'Stock at the source (estimate): Wood 500 · Stone 100. Short (estimate): Stone 100. Whether it is enough is finally decided by the program at the time of sending');
  eq('ウォレットで署名しますか？', 'Sign with the wallet?');
  eq('受け付けられなかった：この目的から抜けた人は依頼できない', 'Not accepted: someone who left this goal cannot make a request');
  eq('  \n   依頼はまだない\n ', '  \n   No requests yet\n ');
  eq('abcd…wxyz', 'abcd…wxyz');
  eq('12 / 200', '12 / 200');
});

test('texts made by the board\'s own modules come out in English (bounds, the same-world line, the closed-caravan row)', () => {
  const clean = s => { const en = toEnglish(s); assert.ok(!JA.test(en) && !needsEnglish(en), `${s} → ${en}`); return en; };
  clean(fulfilBoundsText({ status: 'undetermined', lower: { wood: 196, stone: 0 }, upper: { wood: 200, stone: 1 } }, RESOURCE_JA));
  clean(fulfilBoundsText({ status: 'not-reached', lower: { wood: 0 }, upper: { wood: 0 } }, RESOURCE_JA));
  clean(jointPrecisionText([{ resource: 'wood', verified: 196, need: 200, underBy: 1, arrivals: 1 }, { resource: 'stone', verified: 0, need: 200, underBy: 0, arrivals: 0 }], RESOURCE_JA));
  clean(lowerBoundText({ wood: 196, stone: 0 }, RESOURCE_JA));
  const cfg = { season: { programId: 'P', seasonId: '7' }, cluster: 'localnet' };
  clean(compositionText({ state: 'same' }, cfg));
  clean(compositionText({ state: 'different', differs: ['season', 'cluster'], herald: { season: '8' } }, cfg));
  clean(compositionText({ state: 'unknown', why: 'この入口のヘラルドを読めない（HTTP 502）' }, cfg));
  // the page's own row for closed caravans (the function coop-ui.mjs calls): its texts, tag by tag
  const q = { id: 'r1', to: { p: 1, q: 2, site: 3, gen: 1 }, need: { wood: 200 } };
  const rows = [renderArrived({ ready: true, pick: undefined, request: q, ctx: cfg.season, view: { requests: [] }, ctxKey: c => `${c.programId}:${c.seasonId}`, names: RESOURCE_JA }),
    renderArrived({ ready: true, pick: { status: 'loading' }, request: q, ctx: cfg.season, view: { requests: [] }, ctxKey: c => `${c.programId}:${c.seasonId}`, names: RESOURCE_JA }),
    renderArrived({ ready: true, pick: { status: 'unread', why: 'チェーンを読めない：HTTP 502' }, request: q, ctx: cfg.season, view: { requests: [] }, ctxKey: c => `${c.programId}:${c.seasonId}`, names: RESOURCE_JA }),
    renderArrived({ ready: true, pick: { status: 'ok', scanned: { from: 0, to: 2 }, unread: [{ seq: 1 }], cands: [{ ownerTag: '9', seq: 2, state: 'delivered', sent: { wood: 200 } }, { ownerTag: '9', seq: 0, state: 'lost', sent: { wood: 1 } }] }, request: q, ctx: cfg.season, view: { requests: [] }, ctxKey: c => `${c.programId}:${c.seasonId}`, names: RESOURCE_JA })];
  for (const html of rows) for (const piece of String(html).split(/<[^<>]*>/)) if (piece.trim()) clean(piece);
});

test('the states of a closed caravan are said in English', () => {
  for (const v of Object.values(ARRIVED_JA)) assert.ok(!JA.test(toEnglish(v)), v);
});

test('a text without an entry stays as it is and is remembered; a key is never read out of the middle of a word', () => {
  const t = translator({ '依頼': 'Request', '木材': 'Wood', '{0}を待つ': 'waiting for {0}' });
  assert.equal(t.tr('依頼の板を見る'), '依頼の板を見る');
  assert.deepEqual(t.missing(), ['依頼の板を見る']);
  assert.equal(t.tr('木材 3・依頼'), 'Wood 3 · Request');
  assert.equal(t.tr('木材を待つ'), 'waiting for Wood');
  const n = translator({ '国{0:n}': 'Nation {0}' });
  assert.equal(n.tr('国3'), 'Nation 3');
  assert.equal(n.tr('国の記録'), '国の記録', 'a number only');
});

test('the page: the display layer is loaded by the page code, confirm() goes through it, and nothing else of coop-ui.mjs changed', () => {
  const ui = read('coop-ui.mjs'), page = read('index.html'), layer = read('lang.mjs');
  assert.match(ui, /import \{ shown \} from '\.\/lang\.mjs';/);
  assert.equal((ui.match(/shown\(/g) ?? []).length, 1, 'only confirm()');
  assert.match(ui, /if \(!confirm\(shown\(`村 \(/);
  assert.match(page, /<html lang="ja">/, 'Japanese is the source; lang.mjs of the game page sets the attribute');
  assert.match(page, /html\[lang="en"\] \.req\.focus::before \{ content: var\(--focus-label, '入口で選んだ依頼'\); \}/);
  assert.match(layer, /from '\.\.\/\.\.\/\.\.\/permutation-server\/web\/lang\.mjs';/, 'the game page\'s language, toggle and saved choice');
  assert.match(layer, /if \(lang\(\) !== 'en'\) return;/, 'in Japanese nothing is touched');
  assert.match(layer, /export const shown = text => \(lang\(\) === 'en' \? String\(text\)\.split\('\\n'\)\.map\(toEnglish\)\.join\('\\n'\) : text\);/, 'confirm(): the same text in Japanese');
  assert.doesNotMatch(layer, /fetch\(|localStorage|sign[A-Z]\w*\(|\/coop\//, 'display only: no request, no storage, no signing');
});
