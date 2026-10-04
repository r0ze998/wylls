// Stand-in for the pinned sanitiser (contract §4.6; the real one is
// citizens/mind/sanitize.mjs, AC1b). The memory renderers and the card must
// pass every string a prompt or a card carries through the sanitiser, and
// this unit builds before AC1b merges, so the same pinned steps live here
// for CODE-MADE text (episode templates, names, goal and creed texts) and for
// model-written summaries. The integrator may replace `safeText` by an import
// of mind/sanitize.mjs at merge: both take (string, {kind, limit}).
//
// kind: 'trusted' (default; code text: steps 1-4, 5 for < > `, 6),
//       'untrusted' or 'summary' (also { } [ ] -> fullwidth, and step 5b: an
//       M<digits> handle imitation -> fullwidth M).
export const SPECIAL_TOKEN = /<\|?[A-Za-z_"\/]*\|?>/g;
export const LLM_MARKERS = /\[\/?INST\]|<<\/?SYS>>/gi;

export function safeText(input, { kind = 'trusted', limit = 0 } = {}) {
  let s = String(input ?? '');
  s = s.normalize('NFKC'); // 1
  s = s.replace(SPECIAL_TOKEN, ' '); // 2
  s = s.replace(LLM_MARKERS, ' '); // 3
  s = s.replace(/\p{C}/gu, ' '); // 4
  s = s.replace(/</g, '‹').replace(/>/g, '›').replace(/`/g, "'"); // 5
  if (kind !== 'trusted') {
    s = s.replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\[/g, '［').replace(/\]/g, '］');
    s = s.replace(/\bM(\d{1,2})\b/g, 'Ｍ$1'); // 5b
  }
  s = s.replace(/\s+/g, ' ').trim(); // 6
  if (limit > 0 && [...s].length > limit) s = `${[...s].slice(0, Math.max(0, limit - 1)).join('')}…`;
  return s;
}

/** True when the string has none of `< > { } [ ]` and no category-C character (the T-S1 style invariant for code text). */
export const isClean = s => !/[<>{}\[\]]/.test(s) && !/\p{C}/u.test(s);
