// The game's ten-minute step is "turn" / ターン in every text of the citizens service that a person reads: the Japanese
// display templates of the memory (episode text.ja) and of the watcher (chronicle lines). "bell" / 鐘 stay only in code
// names ({b}, arrive_bell, fact keys), which the placeholders and the keys of these files are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { episodes_from_events } from '../citizens/memory/episodes.mjs';
import { fillLine } from '../citizens/watcher/chronicle.mjs';

const CIT = new URL('../citizens/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, CIT), 'utf8');
/** Every string VALUE of a JSON document, with its path (keys are code names and are not read by anyone). */
const strings = (v, at = '') => (typeof v === 'string' ? [[at, v]] : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => strings(x, `${at}/${k}`)) : []);
const OLD_WORD = /\bbells?\b|鐘/i;
const noOldWord = (rel, text) => assert.doesNotMatch(text.replace(/\{\w+\}/g, ''), OLD_WORD, `${rel}: ${text}`);

const DISPLAY_TEMPLATES = ['memory/templates.ja.json', 'watcher/templates.ja.json'];

test('the Japanese display templates say ターン, never 鐘 or "bell" (placeholder names aside)', () => {
  for (const rel of DISPLAY_TEMPLATES) {
    const all = strings(JSON.parse(read(rel)));
    assert.ok(all.length > 10, `${rel}: ${all.length} strings`);
    for (const [at, text] of all) noOldWord(`${rel}${at}`, text);
  }
  assert.match(JSON.parse(read('memory/templates.ja.json')).kinds.threat, /^ターン\{b\}で、.*到着はターン\{a\}。/);
  assert.match(fillLine('ai_joined', { b: 7, name: 'N', nation: 'X' }, 'ja'), /^ターン7で、/);
});

test('a list written when the step was called bell replays with its old word (time_word: bell_v1; implied by the pre-R12 rule), the live text never has it', () => {
  const sender = 'aa'.repeat(8), wallet = 'W';
  const batch = { events: [], talk: [{ id: 1, bell: 80, wallet: 'S', tag: sender, channel: 3, target: wallet, kind: 0, ref: 0, origin: 0, inner: '11'.repeat(32) }], council: [] };
  const make = (config) => episodes_from_events(batch, { ai: { tag: 'bb'.repeat(8), wallet, faction: 0, home: { p: 0, q: 0 }, holdings: [] }, bellNow: 100, owners: {}, config: { genesis_ts: 0, redactions: [], ...config } }).episodes;
  const [now] = make({}), [old] = make({ time_word: 'bell_v1' }), [legacy] = make({ clash_win_rule: 'legacy_v1' });
  assert.match(now.text.ja, /^ターン80で、/);
  assert.match(old.text.ja, /^鐘80で、/);
  assert.match(old.text.en, /^At bell 80 /);
  assert.deepEqual(legacy.text, old.text);
  assert.equal(now.id, old.id, 'the id does not depend on the wording');
  assert.equal(make({ clash_win_rule: 'legacy_v1', time_word: 'turn' })[0].text.ja, now.text.ja, 'an explicit word wins');
});
