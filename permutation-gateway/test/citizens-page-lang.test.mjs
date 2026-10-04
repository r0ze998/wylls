// Council page (unit AC7), EN and JA through council/lang.mjs (contract §11.5 AC7, §0.4 words): both languages have
// the same keys and placeholders, every key the modules and council.html use exists, the vocabulary follows §0.4 and the
// claims rules, and the nation names equal the committed table.
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './fixtures/ai-page-src.mjs';
import { DICT, NATIONS, t, tl, setLang, getLang, detectLang, pick, nationName, loadLang, saveLang, LANGS } from '../../permutation-server/web/frontier/council/lang.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const councilDir = path.join(here, '../../permutation-server/web/frontier/council');
const pageFile = path.join(here, '../../permutation-server/web/frontier/council.html');
const names = JSON.parse(fs.readFileSync(path.join(here, '../citizens/memory/names.json'), 'utf8'));

const strip = stripComments;
const modules = fs.readdirSync(councilDir).filter(f => f.endsWith('.mjs') && f !== 'lang.mjs');

test('no Japanese character in any .mjs or .html of the page: Japanese lives in lang.ja.json (the main client\'s translation check scans the others)', () => {
  const files = [...modules, 'lang.mjs'].map(f => [f, fs.readFileSync(path.join(councilDir, f), 'utf8')]);
  files.push(['council.html', fs.readFileSync(pageFile, 'utf8')]);
  for (const [f, src] of files) assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/, f);
});

test('both languages have exactly the same keys', () => {
  const en = Object.keys(DICT.en).sort();
  const ja = Object.keys(DICT.ja).filter(k => !k.startsWith('nation.')).sort();
  assert.deepEqual(ja.filter(k => !en.includes(k)), [], 'keys only in ja');
  assert.deepEqual(en.filter(k => !ja.includes(k)), [], 'keys only in en');
  assert.ok(en.length > 250, `the dictionary is not tiny (${en.length})`);
  const ja2 = Object.keys(DICT.ja).filter(k => k.startsWith('nation.'));
  assert.deepEqual(ja2.sort(), ['nation.0', 'nation.1', 'nation.2', 'nation.3', 'nation.4', 'nation.5', 'nation.fallback', 'nation.unknown']);
});

test('placeholders agree between the languages, and no value contains markup or an empty string', () => {
  const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  for (const k of Object.keys(DICT.en)) {
    assert.equal(ph(DICT.ja[k]), ph(DICT.en[k]), `placeholders of ${k}`);
    for (const l of LANGS) {
      const v = DICT[l][k];
      assert.ok(typeof v === 'string' && v.length > 0, `${l}/${k} is empty`);
      assert.doesNotMatch(v, /[<>]/, `${l}/${k} contains markup characters`);
    }
  }
});

test('Japanese values are Japanese (a kana or kanji), except the few that are only symbols or a proper word', () => {
  const allowed = new Set(['card.progress', 'compose.counter', 'page.at', 'page.lang_toggle']);
  for (const [k, v] of Object.entries(DICT.ja)) {
    if (allowed.has(k)) continue;
    assert.match(v, /[぀-ヿ一-鿿]/, `ja/${k} has no Japanese: ${v}`);
  }
  assert.equal(DICT.en['page.lang_toggle'], '日本語');
  assert.equal(DICT.ja['page.lang_toggle'], 'English');
});

test('every key a module uses exists (literal t() keys, key families and the keys of council.html)', () => {
  const used = new Set();
  const lit = /\b(?:t|tl)\(\s*(?:'[a-z]{2}',\s*)?'([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)'/g;
  const keyProps = /(?:labelKey|shortKey|noteKey):\s*'([a-z0-9_.]+)'|\?\s*'(badge\.[a-z0-9_]+)'\s*:\s*'(badge\.[a-z0-9_]+)'/g;
  for (const f of modules) {
    const src = strip(fs.readFileSync(path.join(councilDir, f), 'utf8'));
    for (const m of src.matchAll(lit)) used.add(m[1]);
    for (const m of src.matchAll(keyProps)) for (const g of m.slice(1)) if (g) used.add(g);
    for (const m of src.matchAll(/'((?:badge|council\.scope)[a-z0-9_.]*)'/g)) if (/\.[a-z0-9_]+$/.test(m[1])) used.add(m[1]);
  }
  const html = fs.readFileSync(pageFile, 'utf8');
  for (const m of html.matchAll(/data-t="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-t-attr="([^"]+)"/g)) for (const pair of m[1].split(';')) used.add(pair.split(':')[1]);
  const families = [
    ...['aggression', 'loyalty', 'ambition', 'honesty', 'risk', 'sociability', 'grudge'].map(k => `temp.${k}`),
    ...[0, 1, 2, 3, 4].map(i => `temp.w${i}`),
    ...['active', 'done', 'dropped'].map(k => `card.status.${k}`),
    ...['world', 'nation', 'direct', 'all'].map(k => `feed.channel.${k}`),
    ...['strike', 'camp', 'raid'].map(k => `council.kind.${k}`),
    ...['favourable', 'even', 'unfavourable'].map(k => `council.ratio.${k}`),
    ...['none', 'motions', 'ballots', 'closed'].map(k => `council.state.${k}`),
    ...['quorum', 'tie', 'none_wins', 'human_present'].map(k => `council.reason.${k}`),
    ...['quorum', 'lead', 'human'].map(k => `council.pivotal.why_${k}`),
    ...['depart', 'clash', 'other'].map(k => `ev.kind.${k}`),
    ...['motion', 'call_adopted', 'call_declined', 'no_call', 'strike_result', 'ai_joined', 'ai_card_changed', 'ai_march_opened'].map(k => `chron.kind.${k}`),
    ...['session', 'reaction', 'reflection', 'motion', 'ballot', 'autopilot'].map(k => `dec.kind.${k}`),
    ...['depart', 'build', 'train', 'muster', 'explore', 'harvest', 'walls', 'reveal'].map(k => `dec.intent.${k}`),
    ...['autopilot', 'hold', 'march', 'recall', 'build', 'walls', 'train', 'muster', 'explore'].map(k => `dec.cand.${k}`),
    ...['BadBytes', 'BadSignature', 'SessionMismatch', 'SessionExpired', 'BellSkew', 'SeqReplay', 'TextTooLong', 'NotFromMind', 'NotEligible', 'NotMember', 'WindowClosed', 'Duplicate', 'RateLimited', 'HeraldUnavailable', 'network', 'unknown'].map(k => `err.${k}`),
    ...['empty', 'format', 'mismatch', 'nosubtle', 'nosaved', 'import', 'no_wallet'].map(k => `keys.err.${k}`),
  ];
  for (const k of families) used.add(k);
  assert.ok(used.size > 150, `scan found the keys (${used.size})`);
  const missing = [...used].filter(k => !(k in DICT.en));
  assert.deepEqual(missing, []);
});

test('every dictionary key is used somewhere (no dead strings) except the spare reason and kind families', () => {
  const src = modules.map(f => strip(fs.readFileSync(path.join(councilDir, f), 'utf8'))).join('\n') + fs.readFileSync(pageFile, 'utf8');
  const spare = /^(dec\.reason\.|dec\.intent\.|dec\.kind\.|dec\.cand\.|chron\.kind\.|ev\.kind\.|err\.|keys\.err\.|temp\.|card\.status\.|council\.reason\.|council\.kind\.|council\.ratio\.|council\.state\.|ev\.fate\.|council\.pivotal\.why_|feed\.channel\.|badge\.)/;
  const dead = Object.keys(DICT.en).filter(k => !spare.test(k) && !src.includes(`'${k}'`) && !src.includes(`"${k}"`) && !src.includes(`:${k}`) && !src.includes(`"${k}`));
  assert.deepEqual(dead, []);
});

test('vocabulary (§0.4): Strike Order, never "Call" or "shade"; no claim that the model wants or intends; "cited", not "remembers"', () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(DICT[l])) {
      assert.doesNotMatch(v, /\bCall\b|\bcall\b(?! read)/, `${l}/${k}: the word Call (the code name) is not a user-facing word: ${v}`);
      assert.doesNotMatch(v, /\bshades?\b|シェード/i, `${l}/${k}: never "shade"`);
      assert.doesNotMatch(v, /\b(wants|intends|desires)\b|\bremembers\b|indistinguishable|devnet or mainnet only/i, `${l}/${k}: ${v}`);
      assert.doesNotMatch(v, /\bpact|\bbetray|\balliance|同盟|協定|裏切/i, `${l}/${k}: pacts and betrayal are deferred (App. A)`);
    }
  }
  assert.match(DICT.en['council.title'], /Strike Order/);
  assert.match(DICT.ja['council.title'], /攻撃命令/);
  assert.equal(DICT.en['dec.words'], "AI's words (model-written, not verified)"); // ASCII apostrophe as in the contract (lines 353, 462, 712)
  assert.equal(DICT.en['dec.remembered'], 'Remembered (cited by the model):');
  assert.equal(DICT.en['card.progress_not_computed'], 'progress not computed');
  assert.equal(DICT.en['badge.ai'], 'AI citizen, Gemma 4 local');
  assert.equal(DICT.en['badge.script'], 'script bot: not AI, not human');
  assert.equal(DICT.en['badge.seat'], 'presenter seat (human operator)');
  assert.equal(DICT.en['badge.assisted'], 'AI-assisted (self-declared)');
  assert.equal(DICT.en['compose.to_ai'], 'You are writing to an AI citizen.');
  assert.equal(DICT.ja['badge.script'], 'スクリプトボット：AIでも人でもない');
  assert.match(DICT.en['page.footer'], /Local test chain — not devnet or mainnet — AI citizens are labelled — Gemma 4 runs locally — the presenter is the operator\./);
  assert.match(DICT.en['banner.localnet'], /LOCAL TEST CHAIN/);
});

test('the card label is the contract\'s text in both languages', () => {
  assert.equal(DICT.en['card.label'], 'AI citizen — run by the operator with Gemma 4 (local). Same rules and quotas as people.');
  assert.equal(DICT.ja['card.label'], 'AI市民（運営がローカルのGemma 4で動かしています）。人と同じルールと回数制限で遊びます。');
});

test('nation names equal citizens/memory/names.json (and the fallback reads like the table\'s)', () => {
  assert.deepEqual(NATIONS.map(n => ({ key: n.key, en: n.en, ja: DICT.ja[`nation.${NATIONS.indexOf(n)}`] })), names.nations.map(n => ({ key: n.key, en: n.en, ja: n.ja })));
  assert.equal(DICT.ja['nation.fallback'], names.fallback.ja.replace('{f}', '{n}'));
  assert.equal(nationName(2, 'ja'), 'シンダー');
  assert.equal(nationName(9, 'en'), names.fallback.en.replace('{f}', '9'));
  assert.equal(nationName(9, 'ja'), names.fallback.ja.replace('{f}', '9'));
  assert.equal(nationName(undefined, 'en'), 'nation ?');
});

test('t(): placeholders are text (markup in a value stays text), unknown keys come back as themselves, language switch and detection', () => {
  assert.equal(tl('en', 'page.bell', { n: '<b>7</b>' }), 'bell <b>7</b>');
  assert.equal(tl('en', 'no.such.key'), 'no.such.key');
  assert.equal(tl('ja', 'no.such.key'), 'no.such.key');
  assert.equal(tl('en', 'page.bell', {}), 'bell {n}', 'an unsupplied placeholder is left as it is');
  assert.equal(getLang(), 'en');
  setLang('ja');
  assert.equal(t('page.bell', { n: 3 }), '鐘3');
  assert.equal(setLang('xx'), 'ja', 'an unknown language is ignored');
  setLang('en');
  assert.equal(detectLang({ stored: 'ja', language: 'en-US' }), 'ja');
  assert.equal(detectLang({ stored: 'zz', language: 'ja-JP' }), 'ja');
  assert.equal(detectLang({ language: 'fr' }), 'en');
  assert.equal(detectLang({}), 'en');
  assert.equal(pick({ en: 'a', ja: 'b' }, 'ja'), 'b');
  assert.equal(pick({ en: 'a' }, 'ja'), 'a');
  assert.equal(pick('plain', 'ja'), 'plain');
  assert.equal(pick(null), '');
  // storage that throws is survived
  assert.equal(loadLang({ getItem() { throw new Error('blocked'); } }, 'ja'), 'ja');
  assert.doesNotThrow(() => saveLang('ja', { setItem() { throw new Error('blocked'); } }));
});
