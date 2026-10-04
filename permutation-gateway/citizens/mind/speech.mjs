// V5 speech (contract section 4.5) for the model's `say` messages, the base that V5b (reason.mjs) and the reflection
// validator reuse, and the pinned EN/JA word lists. `createSpeech({config})` is what server.mjs constructs; it returns
//   {sanitize, checkSay, checkWhy, checkSummary, counts}
// and the three call sites are validate.mjs applySpeech (checkSay per message, checkWhy once), prompt.mjs (sanitize) and
// reflection.mjs (checkSummary). Each check returns {ok, text, reason, word?}: `text` is the sanitised text that may be
// published; on refusal `reason` is the rule that fired and `word` the word or number that fired it (counted per word).
// Pure: no clock, no randomness, no I/O.
//
// The V5 rules, in the order they are applied (the first that fires wins):
//   empty, too_long (> 280 for a say, 200 for a why)                       sanitise (section 4.6)
//   url, long_token                                                         no URL, no base58 or hex run of 32 or more
//   sealed_coordinate, sealed_name                                          section 5.6: coordinates, province handles,
//                                                                           names and nation names of a sealed target
//   sealed_direction                                                        a direction word with a target-kind word while any target is sealed
//   sealed_number, target_kind                                              while a march is in flight or a Call is live:
//                                                                           no number equal to a sealed target's troop count or distance,
//                                                                           and no target-kind word in any text of that AI
//   human_claim, abuse, capture_claim, pact_word                            pinned denylists
//   echo                                                                    a verbatim run of 24 code points of untrusted prompt text
//   wrong_script (say only)                                                 `ja` needs kana or kanji, `en` Latin
//   number_ungrounded, uncited_memory_claim                                 reason.mjs
// A hit on these lists means "withheld and counted", never "the model is lying": they are word lists, not a judge of intent.
import { sanitize } from './sanitize.mjs';
import { checkWhy, checkSayExtras, checkSummary, numbersIn, plainApostrophe } from './reason.mjs';

export const SAY_LIMIT = 280;
export const WHY_LIMIT = 200;
export const SUMMARY_LIMIT = 1200;
export const ECHO_RUN = 24;

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (words) => words.join('|');

// ---- pinned lists (EN and JA). Every list is exported so the injection corpus (AC9) and the tests read the same words.
/** Pact words (section 4.5 V5): those mechanics do not exist in this build (Appendix A). The only place in the tree that names them. */
export const PACT_EN = Object.freeze([
  String.raw`betray(?:s|ed|ing|al|als|er|ers)?`, String.raw`pacts?`, String.raw`treat(?:y|ies)`, String.raw`alliances?`,
  String.raw`promis(?:e|es|ed|ing)`, String.raw`truces?`, String.raw`non-?aggression`,
]);
export const PACT_JA = Object.freeze(['裏切', '約束', '同盟', '条約', '協定']);
const PACT_RE_EN = new RegExp(String.raw`(?<![\p{L}])(${alt(PACT_EN)})(?![\p{L}])`, 'iu');
const PACT_RE_JA = new RegExp(`(${alt(PACT_JA)})`);
const PACT_STEM = [[/^betray/i, 'betray'], [/^pact/i, 'pact'], [/^treat/i, 'treaty'], [/^alliance/i, 'alliance'], [/^promis/i, 'promise'], [/^truce/i, 'truce'], [/^non-?aggression/i, 'non-aggression']];
const pactWord = (s) => {
  const w = PACT_RE_EN.exec(s)?.[1] ?? PACT_RE_JA.exec(s)?.[1] ?? null;
  if (!w) return null;
  return PACT_STEM.find(([re]) => re.test(w))?.[1] ?? w.toLowerCase();
};

/** Human and operator claims. The disclosure sentence "I am an AI citizen run by the operator" must not match. */
export const HUMAN_CLAIM_EN = Object.freeze([
  String.raw`i\s*(?:am|'?m)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|living\s+|normal\s+)?(?:human|person|man|woman|girl|boy|guy)`,
  String.raw`(?:i\s*(?:am|'?m)\s+(?:not|no)|this\s+is\s+not|not)\s+(?:an?\s+)?(?:ai|a\.i\.|bot|robot|machine|program|language\s+model|llm|npc)`,
  String.raw`i\s*(?:am|'?m)\s+(?:just\s+)?(?:a\s+)?real\s+(?:human|person|player)`,
  String.raw`i\s*(?:am|'?m)\s+(?:the\s+|an?\s+|your\s+)?(?:operator|admin|administrator|developer|moderator|owner|staff|game\s+master|gm)`,
  String.raw`(?:this\s+is|it's|it\s+is)\s+(?:the\s+)?(?:operator|admin|administrator|developer|moderator|game\s+master)`,
  String.raw`as\s+(?:the\s+)?(?:operator|admin|administrator|developer|moderator)\b`,
  String.raw`official\s+(?:message|notice|announcement)\s+from\s+the\s+(?:operator|admin|developer|staff)`,
]);
export const HUMAN_CLAIM_JA = Object.freeze([
  '私は人間', 'わたしは人間', 'ワタシは人間', '僕は人間', 'ぼくは人間', '俺は人間', 'おれは人間', 'あたしは人間', '人間です', '人間だ', '人間ですよ', '中の人', 'AIではない', 'AIじゃない', 'AIではありません', 'ボットではない', 'ボットじゃない',
  'ボットではありません', '運営です', '運営だ', '運営者です', '運営からの', '管理者です', '開発者です', 'GMです',
]);
const HUMAN_RE_EN = new RegExp(String.raw`\b(?:${alt(HUMAN_CLAIM_EN)})(?![\p{L}-])`, 'iu');
const HUMAN_RE_JA = new RegExp(alt(HUMAN_CLAIM_JA), 'i');

/** Capture claims (D9: no land can be captured in this build). The persona name "Conqueror" must not match. */
const CAPTURE_VERBS = String.raw`(?:captur(?:e|es|ed|ing)|conquer(?:s|ed|ing)?|occup(?:y|ies|ied|ying)|annex(?:es|ed|ing)?|seiz(?:e|es|ed|ing)|tak(?:e|es|ing)\s+over|took\s+over|taken\s+over)`;
const CAPTURE_OBJECTS = String.raw`(?:villages?|lands?|provinces?|territor(?:y|ies)|cit(?:y|ies)|towns?|hamlets?|strongholds?|regions?|holdings?|hex(?:es)?|tiles?|realms?|kingdoms?)`;
export const CAPTURE_EN = Object.freeze([
  String.raw`${CAPTURE_VERBS}\b(?:\W+\w+){0,4}?\W+${CAPTURE_OBJECTS}`,
  String.raw`annex(?:ation|es|ed|ing)?`,
  // a bare "conquest" or "occupation" is not a land-taking claim ("prepare for conquest"): they count with a land object
  String.raw`(?:conquest|occupation)\s+of\s+(?:\w+\s+){0,3}${CAPTURE_OBJECTS}`,
  String.raw`take\s*over`,
  String.raw`took\s+over`,
  String.raw`taken\s+over`,
]);
export const CAPTURE_JA = Object.freeze(['占領', '征服した', '征服する', '征服され', '征服を', '征服へ', '領土を奪', '領地を奪', '村を奪', '併合', '乗っ取']);
const CAPTURE_RE_EN = new RegExp(String.raw`\b(?:${alt(CAPTURE_EN)})\b`, 'i');
const CAPTURE_RE_JA = new RegExp(alt(CAPTURE_JA));

/** A small abuse list: slurs, sexual content, self-harm, threats of real-world harm. Not a toxicity model. */
export const ABUSE_EN = Object.freeze([
  String.raw`fuck\w*`, String.raw`motherfuck\w*`, String.raw`shit\w*`, String.raw`bitch\w*`, String.raw`asshole\w*`, String.raw`cunt\w*`,
  String.raw`dickhead\w*`, String.raw`whores?`, String.raw`sluts?`, String.raw`retard\w*`, String.raw`faggot\w*`, 'fag', String.raw`nigg\w*`,
  String.raw`spics?`, String.raw`kikes?`, String.raw`tranny`,
  String.raw`porn\w*`, String.raw`nudes?`, String.raw`sexual\w*`, 'sex', String.raw`erotic\w*`, 'horny', 'pussy', String.raw`rap(?:e|ed|es|ing|ist|ists)`,
  String.raw`kill\s+yourself`, 'kys', String.raw`commit\s+suicide`, String.raw`suicid\w*`, String.raw`self[- ]?harm`, String.raw`hang\s+yourself`,
  String.raw`go\s+die`, String.raw`end\s+your\s+life`,
  String.raw`(?:kill|murder|stab|shoot|hurt)\s+(?:you|your\s+(?:family|mother|mom|dad|kids|children))\b`,
  String.raw`know\s+where\s+you\s+live`, String.raw`in\s+real\s+life`, 'irl', String.raw`dox+(?:ing|ed)?`, String.raw`swatting`, String.raw`bomb\s+threat`,
]);
export const ABUSE_JA = Object.freeze([
  '死ね', '氏ね', '殺してやる', '殺すぞ', 'ぶっ殺', '自殺', '首を吊', 'レイプ', '強姦', 'ファック', 'ちんこ', 'まんこ', 'セックス', 'エロ画像',
  'キチガイ', 'ガイジ', 'ニガー', '現実で会', '住所を特定',
]);
const ABUSE_RE_EN = new RegExp(String.raw`\b(?:${alt(ABUSE_EN)})\b`, 'i');
const ABUSE_RE_JA = new RegExp(alt(ABUSE_JA));

/** Direction words (section 4.5): a direction word with a target-kind word, while any target is sealed, is refused. */
export const DIRECTION_EN = Object.freeze([
  String.raw`north(?:-?(?:east|west))?(?:ern|ward|wards)?`, String.raw`south(?:-?(?:east|west))?(?:ern|ward|wards)?`, String.raw`east(?:ern|ward|wards)?`, String.raw`west(?:ern|ward|wards)?`,
]);
export const DIRECTION_JA = Object.freeze(['北', '南', '東', '西']);
const DIRECTION_RE_EN = new RegExp(String.raw`\b(?:${alt(DIRECTION_EN)})\b`, 'i');
const DIRECTION_ABBR = /\b(?:NE|NW|SE|SW)\b/; // case-sensitive: "se" and "ne" are not directions in running text
const DIRECTION_RE_JA = new RegExp(alt(DIRECTION_JA));

/** Target-kind words: what the public province files would let a reader match to a sealed target. */
export const TARGET_KIND_EN = Object.freeze([
  String.raw`camps?`, String.raw`stacks?`, String.raw`villages?`, String.raw`hamlets?`, String.raw`towns?`, String.raw`cit(?:y|ies)`, String.raw`strongholds?`,
  String.raw`raid(?:s|ed|er|ers|ing)?`, String.raw`barbarians?`, String.raw`outposts?`, String.raw`settlements?`, String.raw`holdings?`,
]);
export const TARGET_KIND_JA = Object.freeze(['野営地', 'キャンプ', '陣地', '村', '集落', '町', '街', '都市', '砦', '要塞', '襲撃', '襲う', '野蛮', '蛮族', '敵軍', '敵部隊', '野戦']);
const KIND_RE_EN = new RegExp(String.raw`\b(?:${alt(TARGET_KIND_EN)})\b`, 'i');
const KIND_RE_JA = new RegExp(alt(TARGET_KIND_JA));

// ---- helpers ------------------------------------------------------------------------------------------------------------
const URL_RE = /https?:\/\/|\bwww\.|\bt\.me\/|discord\.(?:gg|com)|\b[a-z0-9][a-z0-9-]{1,}\.(?:com|net|org|io|gg|xyz|app|dev|me|co|jp|ly|link|tv|info|biz|ru|cn|top|site|online|club|page|sh|to|cc|ws)\b/i;
const HEX_RUN = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/;
const B58_RUN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,}(?![1-9A-HJ-NP-Za-km-z])/;
const MINUS = /[−–—﹣－‐‑‒]/g;
const KANA_KANJI = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const FOREIGN_LETTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\P{L}]/u;

const hasCjk = (s) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(s);
const pqOf = (e) => (Array.isArray(e?.pq) && e.pq.length === 2 ? e.pq.map(Number) : null);

// contract 5.6: a coordinate that appears in the text of an episode retrieved for this prompt is never refused
function sealedCoordinate(s, sealed, episodeTexts = []) {
  const t = s.replace(MINUS, '-');
  const eps = (episodeTexts ?? []).map((x) => String(x ?? '').replace(MINUS, '-'));
  for (const e of sealed) {
    const pq = pqOf(e);
    if (!pq || pq.some((x) => !Number.isFinite(x))) continue;
    const [p, q] = pq;
    const pair = new RegExp(String.raw`(?<![\d])${p}\s*[,;/:·・、 ]\s*${q}(?![\d])`);
    const axial = new RegExp(String.raw`\bp\s*[=:]?\s*-?${Math.abs(p)}\b[^\d]{1,8}\bq\s*[=:]?\s*-?${Math.abs(q)}\b`, 'i');
    if ((pair.test(t) || axial.test(t)) && !eps.some((x) => pair.test(x) || axial.test(x))) return `${p},${q}`;
  }
  return null;
}

function sealedName(s, sealed) {
  const low = s.toLowerCase();
  for (const e of sealed) {
    for (const n of e.names ?? []) {
      if (!n) continue;
      const name = String(n).toLowerCase();
      if (hasCjk(name)) {
        if (low.includes(name)) return String(n);
      } else if (new RegExp(String.raw`(?<![\p{L}\p{N}])${esc(name)}(?![\p{L}\p{N}])`, 'iu').test(low)) return String(n);
    }
    for (const nat of e.nations ?? []) {
      const k = Number(nat);
      if (!Number.isFinite(k)) continue;
      if (new RegExp(String.raw`\bnations?\s*${k}\b|\bN${k}\b|国\s*${k}(?!\d)|(?<!\d)${k}\s*国`, 'i').test(s)) return `nation ${k}`;
    }
  }
  return null;
}

// English number words ("six", "two hundred and fifty", "one-sixty") as values, for the identifying-number rule only: a spelled
// number must not defeat "no number equal to a sealed target's troop count or distance" (contract 4.5). Not used for grounding.
const NW_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const NW_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export function spelledNumbersIn(text) {
  const words = String(text ?? '').normalize('NFKC').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const out = [];
  let cur = null; // {total, part, last}
  const flush = () => {
    if (cur) out.push(String(cur.total + cur.part));
    cur = null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isUnit = w in NW_UNITS;
    const isTens = w in NW_TENS;
    if (isUnit || isTens) {
      const v = isUnit ? NW_UNITS[w] : NW_TENS[w];
      // "twenty one" and "two hundred (and) fifty" continue one number; "six six" or "ten four" start a new one
      if (cur && ['hundred', 'thousand', 'and'].includes(cur.last) && v < 100) (cur.part += v), (cur.last = isTens ? 'tens' : 'unit');
      else if (cur && cur.last === 'tens' && isUnit && v < 10) (cur.part += v), (cur.last = 'unit');
      else {
        flush();
        cur = { total: 0, part: v, last: isTens ? 'tens' : 'unit' };
      }
    } else if (w === 'hundred' && !cur) {
      cur = { total: 0, part: 100, last: 'hundred' }; // "a hundred"
    } else if (w === 'hundred' && cur && cur.last !== 'hundred' && cur.part < 100) {
      cur.part = (cur.part || 1) * 100;
      cur.last = 'hundred';
    } else if (w === 'thousand' && !cur) {
      cur = { total: 1000, part: 0, last: 'thousand' }; // "a thousand"
    } else if (w === 'thousand' && cur) {
      cur.total += (cur.part || 1) * 1000;
      cur.part = 0;
      cur.last = 'thousand';
    } else if (w === 'and' && cur && (cur.last === 'hundred' || cur.last === 'thousand') && i + 1 < words.length && (words[i + 1] in NW_UNITS || words[i + 1] in NW_TENS)) {
      cur.last = 'and';
    } else flush();
  }
  flush();
  return out;
}

const norm = (t) => sanitize(t, { limit: 0, untrusted: true }).toLowerCase();
function echoHit(s, untrusted) {
  const mine = [...norm(s)];
  if (mine.length < ECHO_RUN) return false;
  const seen = new Set();
  for (const u of untrusted ?? []) {
    const cps = [...norm(u)];
    for (let i = 0; i + ECHO_RUN <= cps.length; i++) seen.add(cps.slice(i, i + ECHO_RUN).join(''));
  }
  if (!seen.size) return false;
  for (let i = 0; i + ECHO_RUN <= mine.length; i++) if (seen.has(mine.slice(i, i + ECHO_RUN).join(''))) return true;
  return false;
}

/**
 * The V5 base check shared by say, why and the reflection summary.
 *   kind: 'say' | 'why' | 'summary' (sets the length limit)
 * ctx: {sealed: [{pq, names, nations?, numbers, kinds}], inFlight, untrusted: [texts shown in the prompt]}
 * Returns {ok:true, text} or {ok:false, reason, word?}.
 */
export function v5Base(text, ctx = {}, { kind = 'say' } = {}) {
  const limit = kind === 'why' ? WHY_LIMIT : kind === 'summary' ? SUMMARY_LIMIT : SAY_LIMIT;
  const s = sanitize(text, { limit: 0 });
  if (!s) return { ok: false, reason: 'empty' };
  if ([...s].length > limit) return { ok: false, reason: 'too_long' };
  if (URL_RE.test(s)) return { ok: false, reason: 'url' };
  if (HEX_RUN.test(s) || B58_RUN.test(s)) return { ok: false, reason: 'long_token' };
  const sealed = ctx.sealed ?? [];
  const coord = sealedCoordinate(s, sealed, ctx.episodeTexts);
  if (coord) return { ok: false, reason: 'sealed_coordinate', word: coord };
  const name = sealedName(s, sealed);
  if (name) return { ok: false, reason: 'sealed_name', word: name };
  const kindHit = KIND_RE_EN.exec(s)?.[0]?.toLowerCase() ?? KIND_RE_JA.exec(s)?.[0] ?? null;
  if (sealed.length > 0 && kindHit && (DIRECTION_RE_EN.test(s) || DIRECTION_ABBR.test(s) || DIRECTION_RE_JA.test(s))) return { ok: false, reason: 'sealed_direction', word: kindHit };
  const active = Boolean(ctx.inFlight) || sealed.length > 0;
  if (active) {
    const ids = new Set(sealed.flatMap((e) => (e.numbers ?? []).map((n) => String(Number(n)))).filter((n) => n !== 'NaN'));
    if (ids.size) {
      for (const n of numbersIn(s)) if (ids.has(n.value)) return { ok: false, reason: 'sealed_number', word: n.value };
      for (const v of spelledNumbersIn(s)) if (ids.has(v)) return { ok: false, reason: 'sealed_number', word: v };
    }
    if (kindHit) return { ok: false, reason: 'target_kind', word: kindHit };
  }
  const sa = plainApostrophe(s); // "I’m" (U+2019) is "I'm"
  const human = HUMAN_RE_EN.exec(sa)?.[0] ?? HUMAN_RE_JA.exec(sa)?.[0] ?? null;
  if (human) return { ok: false, reason: 'human_claim', word: human.toLowerCase() };
  const abuse = ABUSE_RE_EN.exec(s)?.[0] ?? ABUSE_RE_JA.exec(s)?.[0] ?? null;
  if (abuse) return { ok: false, reason: 'abuse' };
  const cap = CAPTURE_RE_EN.exec(sa)?.[0] ?? CAPTURE_RE_JA.exec(sa)?.[0] ?? null;
  if (cap) return { ok: false, reason: 'capture_claim', word: cap.toLowerCase() };
  const pact = pactWord(sa);
  if (pact) return { ok: false, reason: 'pact_word', word: pact };
  if (echoHit(s, ctx.untrusted)) return { ok: false, reason: 'echo' };
  return { ok: true, text: s };
}

/** `ja` needs kana or kanji (and not mostly Latin), `en` needs Latin letters and no kana, kanji or other script. */
export function scriptMatches(s, lang) {
  if (lang === 'ja') {
    if (!KANA_KANJI.test(s) || FOREIGN_LETTER.test(s)) return false;
    const letters = [...s].filter((c) => /\p{L}/u.test(c));
    const latin = letters.filter((c) => LATIN_LETTER.test(c)).length;
    return letters.length > 0 && latin / letters.length <= 0.5;
  }
  if (lang === 'en') return LATIN_LETTER.test(s) && !KANA_KANJI.test(s) && !FOREIGN_LETTER.test(s);
  return true;
}

export function createSpeech({ config = {} } = {}) {
  const defaultLang = config.channel_lang ?? 'ja';
  const counts = { reasons: {}, words: {} };
  const tally = (r) => {
    if (!r.ok) {
      counts.reasons[r.reason] = (counts.reasons[r.reason] ?? 0) + 1;
      if (r.word != null) {
        counts.words[r.reason] ??= {};
        counts.words[r.reason][r.word] = (counts.words[r.reason][r.word] ?? 0) + 1;
      }
    }
    return r;
  };
  const langOf = (ctx) => {
    if (ctx.channel === 'direct' && ctx.recipientLang) return ctx.recipientLang;
    return ctx.channelLang?.[ctx.channel] ?? ctx.speechLang ?? ctx.lang ?? defaultLang;
  };
  return {
    stub: false,
    sanitize,
    /** V5 for one `say` item. ctx also carries channel, to, speechLang (and recipientLang for a direct message). */
    checkSay(text, ctx = {}) {
      const b = v5Base(text, ctx, { kind: 'say' });
      if (!b.ok) return tally(b);
      if (!scriptMatches(b.text, langOf(ctx))) return tally({ ok: false, reason: 'wrong_script' });
      const x = checkSayExtras(b.text, ctx);
      return tally(x.ok ? b : x);
    },
    /** V5b for `why`: V5 without the language rule, plus number grounding and the memory-claim rule. */
    checkWhy(text, ctx = {}) {
      return tally(checkWhy(text, ctx, v5Base));
    },
    /** The reflection validator (section 4.7). win = {episodes: [texts], previous?, allowPrevious?, sealed?, inFlight?}. */
    checkSummary(text, win = {}) {
      return tally(checkSummary(text, win, v5Base));
    },
    /** Counters by rule and, for word-list rules, by word: {reasons: {pact_word: 2}, words: {pact_word: {betray: 1}}}. */
    counts: () => JSON.parse(JSON.stringify(counts)),
  };
}
