// The pinned sanitiser (contract section 4.6) and the two wrappers that put text into a prompt as data
// (section 4.7). Applied to ALL player and AI text before it enters a prompt, to model `say` output and to
// model-written memory. Pure: no clock, no randomness, no I/O. Also used by the social service and the page
// preview, so it imports nothing.
//
//   1  Unicode NFKC
//   2  remove every match of /<\|?[A-Za-z_"\/]*\|?>/g (one space): every Gemma 4 special token, Gemma 3's
//      <start_of_turn>, foreign templates' <|im_start|>, <s> ... and a forged </untrusted>
//   3  remove [INST], [/INST], <<SYS>>, <</SYS>> (case-insensitive) and the literal tokens below
//   4  replace every Unicode category C character by a space
//   5  < -> ‹   > -> ›   ` -> '        and, in untrusted text and in model-written summaries, { } [ ] -> fullwidth
//   5b in untrusted text and in summaries every \bM(\d{1,2})\b -> Ｍ$1 (fullwidth M), so that "M2 [bell 388] ..."
//      cannot be read as a Remembered handle
//   6  collapse whitespace, trim, cut to the field limit with "…" (talk 280, name 48)
//
// Invariant (T-S1): the output contains no `<`, `>` or category-C character. Every Gemma 4 CONTROL and
// USER_DEFINED token contains `<` or `>` (the 24 of the pinned GGUF, test/fixtures/ai-gguf-control-tokens.json),
// so no special token can survive step 5; a token that did not contain them would fail T-S1 and be added to
// EXTRA_TOKEN_LITERALS (step 3). The fullwidth `Ｍ` of step 5b is stable under a second pass: NFKC maps it back to
// `M` and step 5b rewrites it again, so sanitize(sanitize(x)) === sanitize(x).

export const TALK_LIMIT = 280;
export const NAME_LIMIT = 48;
export const SUMMARY_LIMIT = 1200;

/** Step 2. */
export const SPECIAL_TOKEN = /<\|?[A-Za-z_"/]*\|?>/g;
/** Step 3 (the pinned foreign-template markers). */
export const LLM_MARKERS = /\[\/?INST\]|<<\/?SYS>>/gi;
/**
 * Step 3 additions found by T-S1: vocabulary tokens that contain neither `<` nor `>` (so step 5 would not break
 * them). On the pinned GGUF (24 CONTROL/USER_DEFINED tokens, sha256 d208665a...) there are none.
 */
export const EXTRA_TOKEN_LITERALS = Object.freeze([]);
const EXTRA_RE = EXTRA_TOKEN_LITERALS.length
  ? new RegExp(EXTRA_TOKEN_LITERALS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  : null;

const HANDLE_M = /\bM(\d{1,2})\b/g;

/**
 * sanitize(text, {limit, untrusted, summary}) -> string.
 *   untrusted: text written by a player or another AI (inbox, hall, names)
 *   summary:   a model-written self-summary
 * Both turn on the `{ } [ ]` rewrite and step 5b. `limit` <= 0 (or not a finite number) means no cut.
 */
export function sanitize(text, { limit = TALK_LIMIT, untrusted = false, summary = false } = {}) {
  let s = String(text ?? '').normalize('NFKC'); // 1
  for (let i = 0; i < 4; i++) {
    // 2 and 3, to a fixed point (every replacement is a space, so a token cannot be re-formed; the loop is belt and braces)
    const before = s;
    s = s.replace(SPECIAL_TOKEN, ' ').replace(LLM_MARKERS, ' ');
    if (EXTRA_RE) s = s.replace(EXTRA_RE, ' ');
    if (s === before) break;
  }
  s = s.replace(/\p{C}/gu, ' '); // 4
  s = s.replace(/</g, '‹').replace(/>/g, '›').replace(/`/g, "'"); // 5
  if (untrusted || summary) {
    s = s.replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\[/g, '［').replace(/\]/g, '］');
    s = s.replace(HANDLE_M, 'Ｍ$1'); // 5b
  }
  s = s.replace(/\s+/g, ' ').trim(); // 6
  if (Number.isFinite(limit) && limit > 0) {
    const cps = [...s];
    if (cps.length > limit) s = cps.slice(0, Math.max(0, limit - 1)).join('') + '…';
  }
  return s;
}

/** True when `s` satisfies the T-S1 invariant. */
export const isClean = (s) => !/[<>]/.test(s) && !/\p{C}/u.test(s);

/**
 * Adapter for AC2's `safeText(input, {kind, limit})` (memory/safe.mjs takes the same pinned steps for code-made text):
 * kind 'trusted' (default), 'untrusted' or 'summary'.
 */
export function safeText(input, { kind = 'trusted', limit = 0 } = {}) {
  return sanitize(input, { limit: limit > 0 ? limit : 0, untrusted: kind === 'untrusted', summary: kind === 'summary' });
}

// ---- wrappers (section 4.6 last paragraph, section 4.7) --------------------------------------------------------
// The wrapper is built by code around sanitised text. A `"` cannot appear in an attribute value (a name such as
// `Bob" ch="nation` must not forge attributes), and the channel and bell are validated, never copied.
const attr = (v, limit) => sanitize(v, { limit, untrusted: true }).replace(/"/g, "'");
const CHANNEL = /^[a-z]{1,12}$/;

/** `<untrusted from="<name>" ch="<channel>" bell="<b>">TEXT</untrusted>` */
export function wrapUntrusted(text, { from, ch, bell, limit = TALK_LIMIT } = {}) {
  const channel = CHANNEL.test(String(ch)) ? ch : 'x';
  const b = Number.isInteger(bell) && bell >= 0 ? bell : 0;
  return `<untrusted from="${attr(from, NAME_LIMIT)}" ch="${channel}" bell="${b}">${sanitize(text, { limit, untrusted: true })}</untrusted>`;
}

/**
 * Memory the AI wrote or was given, as data: `<memory kind="self-summary" bell="b">…</memory>` (model-written, sanitised as a
 * summary) or `<memory kind="episode" id="M2">…</memory>` (code-templated text, still passed through the sanitiser).
 */
export function wrapMemory(text, { kind, bell, id } = {}) {
  if (kind === 'self-summary') {
    const b = Number.isInteger(bell) && bell >= 0 ? bell : 0;
    return `<memory kind="self-summary" bell="${b}">${sanitize(text, { limit: SUMMARY_LIMIT, summary: true })}</memory>`;
  }
  if (kind === 'episode') {
    const h = /^M\d{1,2}$/.test(String(id)) ? id : null;
    return `<memory kind="episode"${h ? ` id="${h}"` : ''}>${sanitize(text, { limit: TALK_LIMIT * 2 })}</memory>`;
  }
  throw new Error(`wrapMemory: unknown kind ${kind}`);
}
