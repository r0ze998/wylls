// fix-tg3 (Q-TG3-1 (a)): the shared vectors of the nation chat's "empty" and "trim" rule, written from the PAGE's rule
// (permutation-server/web/frontier/hud/nationchat.mjs). The herald checks itself against the same file
// (src/chat.rs test `invisible_rule_is_the_vectors`), the page's test (permutation-gateway/test/web-frontier-fix-tg3.test.mjs)
// re-derives it, so the two cannot drift. Key-free: nothing is signed.
//
//   node frontier-node/crates/herald/tests/vectors/make-chat-invisible.mjs        # rewrite chat-invisible.json
//   node frontier-node/crates/herald/tests/vectors/make-chat-invisible.mjs --check # exit 1 when stale
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRIM_RANGES, INVISIBLE_RANGES, textProblem } from '../../../../../permutation-server/web/frontier/hud/nationchat.mjs';

export const FILE = fileURLToPath(new URL('./chat-invisible.json', import.meta.url));
/** One letter per refusal code. */
export const LETTER = { null: '-', EmptyText: 'E', UntrimmedText: 'U', TextTooLong: 'T', TooManyLines: 'M', ControlCharacter: 'C', LinkNotAllowed: 'L' };
/** Every scalar value c is put in these texts ('c' is the character). */
export const TEMPLATES = ['c', 'ac', 'ca', 'aca', 'c c'];
const fill = (tpl, ch) => [...tpl].map(x => (x === 'c' ? ch : x)).join('');

/** The outcome of every Unicode scalar value in every template, run-length coded: [[first, last, "letters"], ...]. */
export function outcomes(problem = textProblem) {
  const runs = [];
  for (let u = 0; u < 0x110000; u++) {
    if (u >= 0xD800 && u <= 0xDFFF) continue;
    const ch = String.fromCodePoint(u);
    const k = TEMPLATES.map(t => LETTER[problem(fill(t, ch))] ?? '?').join('');
    const last = runs[runs.length - 1];
    if (last && last[2] === k && (last[1] === u - 1 || (last[1] === 0xD7FF && u === 0xE000))) last[1] = u;
    else runs.push([u, u, k]);
  }
  return runs;
}

/** Hand cases (Q-TG3-1): the code each side must answer. */
export const CASES = [
  ['﻿', 'EmptyText'], ['﻿﻿', 'EmptyText'], ['﻿hi', 'UntrimmedText'], ['hi﻿', 'UntrimmedText'],
  ['​', 'EmptyText'], ['⁠', 'EmptyText'], ['ㅤ', 'EmptyText'], ['⠀', 'EmptyText'],
  ['​ ⁠ㅤ⠀­', 'EmptyText'], [' ​ ', 'EmptyText'], ['​hi', null], ['hi⠀', null],
  ['a​b', null], ['\u0085hi', 'UntrimmedText'], ['hi\u0085', 'UntrimmedText'], ['a\u0085b', 'ControlCharacter'],
  ['　hi', 'UntrimmedText'], ['', 'EmptyText'], ['  ', 'EmptyText'], [' hi', 'UntrimmedText'], ['hi', null],
  ['‮', 'EmptyText'], ['a‮b', 'ControlCharacter'], ['️', 'EmptyText'], ['\u{E0041}\u{E0042}', 'EmptyText'],
  ['ex​ample.com', 'LinkNotAllowed'], ['東の砦​へ', null],
];

export function build() {
  return {
    about: 'Nation chat text rule shared by the page (hud/nationchat.mjs) and the herald (src/chat.rs): EmptyText when every character is in trim or invisible; UntrimmedText when the first or last is in trim. Written by make-chat-invisible.mjs from the page; checked by both sides (fix-tg3, Q-TG3-1 (a)).',
    trim: TRIM_RANGES.map(r => [...r]),
    invisible: INVISIBLE_RANGES.map(r => [...r]),
    templates: TEMPLATES,
    letters: LETTER,
    outcomes: outcomes(),
    cases: CASES.map(([text, code]) => ({ text, code })),
  };
}

export const render = v => `${JSON.stringify(v, null, 0).replace(/\],\[/g, '],\n[')}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(build());
  if (process.argv.includes('--check')) {
    if (readFileSync(FILE, 'utf8') !== text) { console.error('chat-invisible.json is stale: run make-chat-invisible.mjs'); process.exit(1); }
    console.log('chat-invisible.json: current');
  } else { writeFileSync(FILE, text); console.log(`wrote ${FILE}`); }
}
