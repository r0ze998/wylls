// A notification's words in every language (B11, loop-play2 2026-11-18): the
// notices were kept as a string made in the language of the moment they came,
// and a switch of language left them in it while all around them switched.
// A notice is made from what the page knew then (a camp a clash cleared is
// still "the camp" in the line that tells of it), so it is not made again
// from what the page knows now: it is made once per language at that moment
// (lang.mjs inEachLang) and kept as `words: {ja, en}` beside `text`, and the
// list, the cards over the map and the turn's own list show `words` in the
// language in hand (noticeText). `text` stays the words of the moment it was
// made, for whatever reads it as a string; app.mjs words it again on a switch.
import { inEachLang, lang } from '../../lang.mjs';

/** A notice's words in the language in hand: its `words` for that language, else its `text`. */
export const noticeText = x => {
  const w = x?.words?.[lang()];
  return typeof w === 'string' ? w : x?.text;
};

/** The text a thunk gives, in every language now: `{text, words}` to spread into a notice. */
export function said(fn) {
  const words = inEachLang(() => String(fn()));
  return { text: words[lang()], words };
}

/**
 * The notices a pure function gives (an array, one notice, or null), made in every language now: each as the one of
 * the language in hand, with `words` from the same notice (by place and id) of every language. A notice that is not
 * the same in every run — another id at its place — or has no text keeps its text alone.
 */
export function worded(fn) {
  const by = inEachLang(fn), now = by[lang()];
  const one = (x, i) => {
    if (!x || typeof x.text !== 'string') return x;
    const words = {};
    for (const [l, got] of Object.entries(by)) {
      const y = i === null ? got : got?.[i];
      if (!y || y.id !== x.id || typeof y.text !== 'string') return x;
      words[l] = y.text;
    }
    return { ...x, words };
  };
  return Array.isArray(now) ? now.map(one) : one(now, null);
}

/** A notice kept from before a switch, in the language in hand (its `text` follows its `words`). */
export const reworded = x => (x?.words && typeof x.words[lang()] === 'string' && x.text !== x.words[lang()] ? { ...x, text: x.words[lang()] } : x);
