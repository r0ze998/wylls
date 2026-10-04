// V5b (reason) and the reflection validator (contract sections 4.5 V5b, 4.7, 5.3). Pure functions: no clock, no
// randomness, no I/O, no model call.
//
// What this file adds to the V5 checks of speech.mjs (the `base` that createSpeech injects):
//   (1) number grounding: every number and bell number in the text occurs in the prompt's facts or in the text of a
//       retrieved episode (for a `say`: the facts or an episode the decision cited), and, when the text gives the
//       number a unit word, the same unit word occurs within 3 tokens of that number in the source;
//   (2) the memory-claim rule: "remember", "last time", 「覚え」「以前」 ... while `mem` is empty is refused, in `why`
//       and equally in every `say`; the reflection summary is exempt (its answer has no `mem`) and is held to the
//       "every coordinate, bell and number occurs in the window's episodes" rule instead (section 4.7).
// What the checks can and cannot do (also in the notes): they verify digits and kanji numerals and the pinned word
// lists; fluent false prose that avoids numbers and memory words passes (section 4.5 last paragraph).
import { sanitize } from './sanitize.mjs';

// ---- numbers with unit words ----------------------------------------------------------------------------------
// Unit classes. A number has the classes of the unit words within 3 tokens of it (Latin: 3 word or number tokens
// either side; CJK: the adjacent unit characters). A text number with at least one class must meet a source
// occurrence that shares one; a text number with none only has to occur. Words not listed here are no unit.
const UNIT_WORDS = [
  ['troops', /^(troops?|soldiers?|men|spearmen|spearman|archers?|horsemen|horseman|pikemen|pikeman|crossbowmen|crossbowman|knights?|scouts?|units?)$/i],
  ['bell', /^bells?$/i],
  ['hex', /^(hex|hexes|tiles?)$/i],
  ['province', /^provinces?$/i],
  ['minute', /^(min|mins|minutes?)$/i],
  ['hour', /^(hr|hrs|hours?)$/i],
  ['day', /^days?$/i],
  ['works', /^works$/i],
  ['stamina', /^stamina$/i],
  ['percent', /^(%|percent|pct)$/i],
  ['host', /^(hosts?|armies|army)$/i],
  ['food', /^food$/i],
  ['wood', /^wood$/i],
  ['stone', /^stone$/i],
  ['ore', /^ore$/i],
  ['horses', /^horses$/i],
  ['gold', /^gold$/i],
  ['science', /^science$/i],
  ['influence', /^influence$/i],
  ['wall', /^walls?$/i],
];
const CJK_AFTER = [
  [/^兵/, 'troops'], [/^鐘/, 'bell'], [/^時間/, 'hour'], [/^分/, 'minute'], [/^日/, 'day'],
  [/^(ヘクス|マス|タイル)/, 'hex'], [/^(州|地方)/, 'province'], [/^(%|パーセント)/, 'percent'], [/^(軍|部隊)/, 'host'],
];
const CJK_BEFORE = [[/兵$/, 'troops'], [/鐘$/, 'bell'], [/(第|日目)$/, null]];
const classOfWord = (w) => {
  for (const [cls, re] of UNIT_WORDS) if (re.test(w)) return cls;
  return null;
};

const KANJI_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KANJI_UNIT = { 十: 10, 百: 100, 千: 1000 };
const KANJI_RUN = /[〇零一二三四五六七八九十百千万]+/gu;
const kanjiBelowMan = (s) => {
  let total = 0;
  let digit = null;
  for (const ch of s) {
    if (ch in KANJI_DIGIT) digit = KANJI_DIGIT[ch];
    else {
      total += (digit ?? 1) * KANJI_UNIT[ch];
      digit = null;
    }
  }
  return total + (digit ?? 0);
};
/** 三百二十 -> 320, 二〇二五 -> 2025, 万 -> 10000. */
export function kanjiToInt(run) {
  if (/^[〇零一二三四五六七八九]+$/.test(run)) return Number([...run].map((c) => KANJI_DIGIT[c]).join(''));
  const at = run.indexOf('万');
  let v = 0;
  if (at >= 0) {
    const hi = run.slice(0, at);
    v += (hi === '' ? 1 : kanjiBelowMan(hi)) * 10000;
    v += run.slice(at + 1) ? kanjiBelowMan(run.slice(at + 1).replace(/万/g, '')) : 0;
  } else v = kanjiBelowMan(run);
  return Number.isFinite(v) ? v : null;
}

const NUM_RE = /(?<![A-Za-z\d.])\d+(?:,\d{3})*(?:\.\d+)?/gu;
const TOKEN_RE = /\d+(?:,\d{3})*(?:\.\d+)?|[\p{L}\p{M}%]+/gu;
const canonNum = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : null;
};

/**
 * Every number of `text`: [{value: "600", start, end, units: Set<class>, near: Set<class>}]. Digits (a digit run directly after an ASCII
 * letter is a handle such as H1, C2, c4, not a number) and kanji numerals (value >= 10, or followed by a counter).
 * The text is NFKC-normalised first, so fullwidth digits count.
 */
export function numbersIn(raw) {
  const text = String(raw ?? '').normalize('NFKC');
  const found = [];
  for (const m of text.matchAll(NUM_RE)) {
    const v = canonNum(m[0]);
    if (v !== null) found.push({ value: v, start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(KANJI_RUN)) {
    const v = kanjiToInt(m[0]);
    if (v === null) continue;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 3);
    const counter = CJK_AFTER.some(([re]) => re.test(after)) || /^[つ人回度個]/.test(after);
    if (v >= 10 || counter) found.push({ value: String(v), start: m.index, end });
  }
  if (!found.length) return found;
  found.sort((a, b) => a.start - b.start);
  // words and numbers are the tokens of the 3-token window
  // a window never crosses a line break or a sentence end
  const breaks = [...text.matchAll(/[\n;!?]|\.(?=\s|$)/g)].map((m) => m.index);
  const segOf = (pos) => breaks.filter((b) => b < pos).length;
  const toks = [...text.matchAll(TOKEN_RE)].map((t) => ({ s: t.index, e: t.index + t[0].length, w: t[0], isNum: /^\d/.test(t[0]), seg: segOf(t.index) }));
  // a unit word belongs to the nearest number token (a tie leaves it to both): "120 troops at (-2,3)" gives troops to 120 only
  const owns = (i, j) => {
    const d = Math.abs(i - j);
    for (let k = Math.max(0, j - d + 1); k <= Math.min(toks.length - 1, j + d - 1); k++) if (k !== i && toks[k].isNum && toks[k].seg === toks[j].seg && Math.abs(k - j) < d) return false;
    return true;
  };
  for (const n of found) {
    const units = new Set();
    const near = new Set();
    const i = toks.findIndex((t) => t.s === n.start && t.isNum);
    if (i >= 0) {
      for (let j = Math.max(0, i - 3); j <= Math.min(toks.length - 1, i + 3); j++) {
        if (j === i || toks[j].isNum || toks[j].seg !== toks[i].seg) continue;
        const c = classOfWord(toks[j].w);
        if (c && owns(i, j)) {
          units.add(c);
          if (Math.abs(j - i) === 1) near.add(c);
        }
      }
    }
    const tail = text.slice(n.end, n.end + 4);
    const head = text.slice(Math.max(0, n.start - 3), n.start);
    for (const [re, cls] of CJK_AFTER) if (re.test(tail)) { units.add(cls); near.add(cls); }
    for (const [re, cls] of CJK_BEFORE) if (cls && re.test(head)) { units.add(cls); near.add(cls); }
    n.units = units; // every unit class within 3 tokens (what a source occurrence offers)
    n.near = near.size ? near : units; // the adjacent one if there is one (what a claim names)
  }
  return found;
}

/**
 * groundNumbers(text, sources) -> {ok, bad:[{value, units:[...]}]}. `sources` is an array of strings (the prompt's facts,
 * episode texts). A number is grounded when it occurs in a source and, if the text gives it a unit class, a source
 * occurrence has one of the same classes within its 3-token window.
 */
export function groundNumbers(text, sources) {
  const claim = numbersIn(text);
  if (!claim.length) return { ok: true, bad: [] };
  const occ = new Map();
  for (const src of sources ?? []) {
    if (!src) continue;
    for (const n of numbersIn(src)) {
      if (!occ.has(n.value)) occ.set(n.value, []);
      occ.get(n.value).push(n.units);
    }
  }
  const bad = [];
  for (const n of claim) {
    const list = occ.get(n.value);
    if (!list) bad.push({ value: n.value, units: [...n.near] });
    else if (n.near.size && !list.some((u) => [...n.near].some((c) => u.has(c)))) bad.push({ value: n.value, units: [...n.near] });
  }
  return { ok: bad.length === 0, bad };
}

/**
 * The prompt's facts: the user message without anything model-, player- or memory-written: <untrusted> blocks, <memory>
 * blocks (episode lines and the self-summary), the Remembered handle lines and the PEOPLE legend (names are player text).
 * What is left is code-made: state, threats, council, goals, relations, candidates and the task line.
 */
export function stripToFacts(promptText) {
  return String(promptText ?? '')
    .replace(/<untrusted\b[^>]*>[\s\S]*?<\/untrusted>/g, ' ')
    .replace(/<memory\b[^>]*>[\s\S]*?<\/memory>/g, ' ')
    .replace(/^M\d{1,2} \[bell \d+\].*$/gm, ' ')
    .replace(/^PEOPLE\b.*$/gm, ' ');
}

// ---- the memory-claim rule (V5b (2)) ----------------------------------------------------------------------------
// Pinned EN/JA. "recall" is a game action (a recall candidate brings an arrived army home), so only its memory senses count.
export const MEMORY_CLAIM_EN = Object.freeze([
  String.raw`remember(?:s|ed|ing)?`,
  String.raw`i\s+(?:still\s+)?recall`,
  String.raw`(?:as|if)\s+i\s+recall`,
  String.raw`recall(?:s|ed|ing)?\s+(?:that|how|when|what|the\s+(?:attack|clash|battle|time|day))`,
  'earlier',
  String.raw`last\s+time`,
  'previously',
  'formerly',
  String.raw`back\s+then`,
  String.raw`long\s+ago`,
  String.raw`(?:i|we|you|they|he|she)\s+used\s+to`, // "stores used to train" (a purpose) is not a memory claim
  String.raw`forg[eo]t(?:ten)?`,
  String.raw`never\s+forget`,
  'memory',
  'memories',
  String.raw`the\s+other\s+day`,
]);
export const MEMORY_CLAIM_JA = Object.freeze(['覚え', '思い出', '以前', '前回', '先日', 'かつて', '昔', '忘れ', '記憶']);
const MEMORY_RE_EN = new RegExp(String.raw`\b(?:${MEMORY_CLAIM_EN.join('|')})\b`, 'i');
const MEMORY_RE_JA = new RegExp(MEMORY_CLAIM_JA.join('|'));

/** The memory-claim word found in `text`, or null. */
export function memoryClaim(text) {
  const s = String(text ?? '').normalize('NFKC');
  return MEMORY_RE_EN.exec(s)?.[0]?.toLowerCase() ?? MEMORY_RE_JA.exec(s)?.[0] ?? null;
}

// ---- V5b: `why` ---------------------------------------------------------------------------------------------------
/** The code string that replaces a withheld reason (section 4.5 V5b). */
export const withheldText = (rule) => `(reason withheld by the checker: ${rule})`;

/**
 * checkWhy(text, ctx, base) -> {ok, text, reason, word?}. `base` is speech.mjs's V5 check (sanitise, length, URL, tokens,
 * sealed set, identifying numbers, human claims, abuse, capture claims, the pinned word denylist, echo) without the language rule. ctx:
 *   promptText   the user message of the prompt (untrusted, memory and PEOPLE parts are removed here)
 *   facts        JSON text of the candidates' facts
 *   episodeTexts the texts of every retrieved episode (both languages)
 *   mem          the episode ids the decision cited (empty -> a memory claim is refused)
 */
export function checkWhy(text, ctx, base) {
  const b = base(text, ctx, { kind: 'why' });
  if (!b.ok) return b;
  const sources = [ctx.facts, stripToFacts(ctx.promptText), ...(ctx.episodeTexts ?? [])];
  const g = groundNumbers(b.text, sources);
  if (!g.ok) return { ok: false, reason: 'number_ungrounded', word: g.bad[0].value };
  if (!(ctx.mem?.length > 0)) {
    const w = memoryClaim(b.text);
    if (w) return { ok: false, reason: 'uncited_memory_claim', word: w };
  }
  return b;
}

/** The V5 `say` extras that belong to the reason family: numbers from the facts or a cited episode, and the memory-claim rule. */
export function checkSayExtras(text, ctx) {
  const sources = [ctx.facts, stripToFacts(ctx.promptText), ...(ctx.citedTexts ?? [])];
  const g = groundNumbers(text, sources);
  if (!g.ok) return { ok: false, reason: 'number_ungrounded', word: g.bad[0].value };
  if (!(ctx.mem?.length > 0)) {
    const w = memoryClaim(text);
    if (w) return { ok: false, reason: 'uncited_memory_claim', word: w };
  }
  return { ok: true };
}

// ---- the reflection validator (section 4.7) -------------------------------------------------------------------------
// Imperatives aimed at the AI (pinned EN/JA). A summary is the AI's own notes, so none of these may be in it.
export const IMPERATIVE_EN = Object.freeze([
  'always', 'never', 'must', 'ignore', 'system', 'operator', 'admin', 'administrator', 'disregard', 'obey', 'override',
  'instructions?', String.raw`you\s+(?:should|must|need\s+to|have\s+to)`, String.raw`do\s+not`, String.raw`don't`,
  String.raw`from\s+now\s+on`, String.raw`make\s+sure`, String.raw`new\s+rules?`,
]);
export const IMPERATIVE_JA = Object.freeze(['必ず', '絶対', '無視', '運営', 'システム', '指示', '命令', '従え', '従うこと', '忘れろ', '以降は']);
const IMPERATIVE_RE_EN = new RegExp(String.raw`\b(?:${IMPERATIVE_EN.join('|')})\b`, 'i');
const IMPERATIVE_RE_JA = new RegExp(IMPERATIVE_JA.join('|'));
const NON_LATIN_LETTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\P{L}]/u;
const HANDLE_IMITATION = /\bM\d{1,2}\b|\[\s*bell\s*\d+\s*\]|\b[CHGNc]\d{1,2}\b/;
const COORD_PAIR = /\(\s*[-−–]?\d{1,3}\s*,\s*[-−–]?\d{1,3}\s*\)/g;
const normPair = (s) => s.replace(/[−–]/g, '-').replace(/\s+/g, '');

/**
 * checkSummary(text, win, base) -> {ok, text, reason, word?}. The summary is English (Latin script only), contains no handle
 * or `[bell N]` imitation, no imperative aimed at the AI, no coordinate pair, bell or number that is not in the window's episodes
 * (the 12 episodes the reflection prompt showed; `win.previous`, the previous validated summary, is added only when
 * `win.allowPrevious`), and passes the V5 checks of `base` except the language rule; the memory-claim rule (2) does not apply.
 *   win = {episodes: [text...], previous?: string, allowPrevious?: boolean, sealed?, inFlight?, untrusted?}
 * The returned text is sanitised as a summary (braces and brackets fullwidth, step 5b).
 */
export function checkSummary(text, win, base) {
  const raw = String(text ?? '').normalize('NFKC');
  if (HANDLE_IMITATION.test(raw)) return { ok: false, reason: 'handle_imitation', word: HANDLE_IMITATION.exec(raw)[0] };
  if (NON_LATIN_LETTER.test(raw)) return { ok: false, reason: 'non_latin' };
  const imp = IMPERATIVE_RE_EN.exec(raw)?.[0] ?? IMPERATIVE_RE_JA.exec(raw)?.[0];
  if (imp) return { ok: false, reason: 'imperative', word: imp.toLowerCase() };
  const sources = [...(win.episodes ?? []), ...(win.allowPrevious && win.previous ? [win.previous] : [])];
  const have = new Set(sources.flatMap((s) => [...String(s).normalize('NFKC').matchAll(COORD_PAIR)].map((m) => normPair(m[0]))));
  for (const m of raw.matchAll(COORD_PAIR)) if (!have.has(normPair(m[0]))) return { ok: false, reason: 'coordinate_not_in_window', word: normPair(m[0]) };
  const g = groundNumbers(raw, sources);
  if (!g.ok) return { ok: false, reason: 'number_not_in_window', word: g.bad[0].value };
  const b = base(text, { ...win, mem: [] }, { kind: 'summary' });
  if (!b.ok) return b;
  return { ok: true, text: sanitize(text, { limit: 1200, summary: true }) };
}
