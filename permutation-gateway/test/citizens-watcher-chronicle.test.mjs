// AC6: the minimal chronicle (contract 6.7): template lines in two languages filled only with code numbers and names, "Strike Order" in the
// strings, no target in call_adopted, the tally wording of section 6.5 step 5, one line per fact (dedupe), the journal across a restart,
// latest.json and the per-day files, badges from the roster only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES, KINDS, fillLine, tallyPhrase, lostPhrase, createChronicle, LATEST_LINES, DAY_BELLS } from '../citizens/watcher/chronicle.mjs';
import { isClean } from '../citizens/memory/safe.mjs';
import { fakeRoster, nameOfDouble, nationNameDouble, tmpDir } from './fixtures/ai-watcher-kit.mjs';

const vars = tpl => [...tpl.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('the two template files carry the same kinds, the same placeholders and the same word keys; no markup, no pact vocabulary, "Strike Order" in the English strings', () => {
  assert.deepEqual(Object.keys(TEMPLATES.en.kinds).sort(), [...KINDS].sort());
  assert.deepEqual(Object.keys(TEMPLATES.ja.kinds).sort(), [...KINDS].sort());
  for (const k of KINDS) assert.deepEqual(vars(TEMPLATES.en.kinds[k]), vars(TEMPLATES.ja.kinds[k]), `placeholders of ${k}`);
  const keys = o => (o && typeof o === 'object' ? Object.keys(o).sort().map(k => `${k}:${keys(o[k])}`).join(',') : typeof o);
  assert.equal(keys(TEMPLATES.en.words), keys(TEMPLATES.ja.words));
  const all = JSON.stringify(TEMPLATES);
  assert.doesNotMatch(all, /pact|betray|promise|alliance|truce|treaty|裏切|約束|同盟/i);
  assert.doesNotMatch(all, /\bshade\b|\bCall\b/, 'user-facing strings never say Call or shade (section 0.4)');
  assert.match(TEMPLATES.en.kinds.call_adopted + TEMPLATES.en.kinds.call_declined + TEMPLATES.en.kinds.strike_result, /Strike Order/);
  assert.match(TEMPLATES.ja.kinds.call_adopted + TEMPLATES.ja.kinds.call_declined + TEMPLATES.ja.kinds.strike_result, /攻撃命令/);
});

test('call_adopted names no target: no coordinates, no option, no tile; only the nation, the tally wording and the strike bell', () => {
  for (const l of ['en', 'ja']) {
    const t = fillLine('call_adopted', { b: 54, nation: l === 'en' ? 'Ember' : 'エンバー', with: tallyPhrase({ ai: 1, human: 1, scripted: 0 }, { seatVoted: true }, l), S: 60, O: 62 }, l);
    assert.doesNotMatch(t, /\(\s*-?\d+\s*,\s*-?\d+\s*\)/, 'no coordinates');
    assert.doesNotMatch(t, /option|案|\bcamp\b|\braid\b|野営|襲撃/i);
    const nums = [...t.matchAll(/\d+/g)].map(m => m[0]);
    assert.deepEqual([nums[0], nums.at(-2), nums.at(-1)], ['54', '60', '62'], `the bell, the strike (arrival) bell S and the opening bell S + 2: ${t}`);
    assert.ok(nums.slice(1, -2).every(n => n === '1'), `only ballot counts in between (the JA wording says 1票 for each kind): ${t}`);
  }
  assert.equal(fillLine('call_adopted', { b: 54, nation: 'Ember', with: 'with 1 AI ballot and the presenter\'s ballot', S: 60, O: 62 }, 'en'),
    'At bell 54 the council of Ember adopted a Strike Order with 1 AI ballot and the presenter\'s ballot. Its target stays sealed until the armies arrive at bell 60; the Strike Order is opened at bell 62.');
  // FB5: the line used to say the target "stays sealed until bell S", but the Strike Order is OPENED (council file, call_commit) at S + 2
  assert.doesNotMatch(fillLine('call_adopted', { b: 54, nation: 'Ember', with: 'with 1 AI ballot', S: 60, O: 62 }, 'en'), /sealed until bell 60/);
  assert.throws(() => fillLine('call_adopted', { b: 54, nation: 'Ember', with: 'x', S: 60 }, 'en'), /no value for \{O\}/);
  assert.throws(() => fillLine('call_adopted', { b: 54 }, 'en'), /no value for \{nation\}/);
  assert.throws(() => fillLine('nonsense', {}, 'en'), /no template/);
});

test('tallyPhrase (6.5 step 5): AI ballots, the presenter\'s ballot (origin 0 seat), a scripted seat ballot (origin 2), other humans, none', () => {
  const en = (split, o) => tallyPhrase(split, o, 'en');
  assert.equal(en({ ai: 1, human: 1, scripted: 0 }, { seatVoted: true }), 'with 1 AI ballot and the presenter\'s ballot');
  assert.equal(en({ ai: 1, human: 0, scripted: 1 }, { seatVoted: true }), 'with 1 AI ballot and a scripted seat ballot');
  assert.equal(en({ ai: 2, human: 0, scripted: 0 }, {}), 'with 2 AI ballots');
  assert.equal(en({ ai: 0, human: 2, scripted: 0 }, { seatVoted: true }), 'with the presenter\'s ballot and a human ballot');
  assert.equal(en({ ai: 0, human: 3, scripted: 0 }, {}), 'with 3 human ballots');
  assert.equal(en({ ai: 0, human: 1, scripted: 0 }, {}), 'with a human ballot', 'a human who is not the seat is not "the presenter"');
  assert.equal(en({ ai: 0, human: 0, scripted: 0 }, {}), 'with no ballot counted');
  assert.equal(en(null, {}), 'with no ballot counted');
  const ja = (split, o) => tallyPhrase(split, o, 'ja');
  assert.equal(ja({ ai: 1, human: 1, scripted: 0 }, { seatVoted: true }), 'AIの1票と発表者の1票で');
  assert.equal(ja({ ai: 1, human: 0, scripted: 1 }, { seatVoted: true }), 'AIの1票と台本の席の1票で');
  assert.equal(ja({ ai: 0, human: 0, scripted: 0 }, {}), '票なしで');
});

test('lostPhrase: nations in order with troops, or "no clash was recorded"', () => {
  assert.equal(lostPhrase({ 3: 90, 0: 50 }, 'en', nationNameDouble), 'Nation0 50, Nation3 90');
  assert.equal(lostPhrase({ 3: 90, 0: 50 }, 'ja', nationNameDouble), '国0 50、国3 90');
  assert.equal(lostPhrase({}, 'en', nationNameDouble), 'no clash was recorded');
  assert.equal(lostPhrase(undefined, 'ja', nationNameDouble), '戦闘の記録なし');
});

function chron(extra = {}) {
  const dir = tmpDir('ai-chron-');
  const roster = fakeRoster({ ai: [{ tag: 'aaaaaaaaaaaaaaa1', wallet: 'w1', faction: 1, index: 1000 }] });
  const mk = () => createChronicle({ pubDir: join(dir, 'pub'), stateDir: join(dir, 'state/watcher'), roster, nameOf: nameOfDouble, nationName: nationNameDouble, ...extra });
  return { dir, mk, c: mk() };
}

test('add: both languages, badges from the roster, day number, dedupe by (kind, bell, actors, refs), unknown kinds refused, code text only', () => {
  const { c } = chron();
  const line = c.add({
    kind: 'motion', bell: 150, actors: ['aaaaaaaaaaaaaaa1'], refs: ['council:1:3'],
    vals: l => ({ b: 150, name: nameOfDouble('aaaaaaaaaaaaaaa1')[l], k: 2, kind: TEMPLATES[l].words.option_kind.camp, nation: nationNameDouble(1)[l] }),
  });
  assert.deepEqual([line.kind, line.bell, line.day, line.actors, line.ai, line.refs], ['motion', 150, 1, ['aaaaaaaaaaaaaaa1'], [true], ['council:1:3']]);
  assert.equal(line.text.en, 'At bell 150 Nameaaaa moved option 2 (camp) in the council of Nation1.');
  // the sanitiser's NFKC turns the full-width brackets into ASCII ones, as in every episode text
  assert.equal(line.text.ja, '鐘150で、名aaaaが国1の評議会で案2(野営地)を提案した。');
  assert.equal('by' in line, false);
  assert.match(line.id, /^[0-9a-f]{16}$/);
  assert.equal(c.add({ kind: 'motion', bell: 150, actors: ['aaaaaaaaaaaaaaa1'], refs: ['council:1:3'], vals: () => ({}) }), null, 'the same fact is one line');
  const other = c.add({ kind: 'call_declined', bell: 151, actors: ['bbbbbbbbbbbbbbb2'], by: 'model', refs: ['council:1:3'], vals: l => ({ b: 151, name: 'X', nation: 'N' }) });
  assert.deepEqual([other.ai, other.by], [[false], 'model'], 'a citizen the roster does not list is not an AI; declining is the model\'s own act');
  assert.throws(() => c.add({ kind: 'renown', bell: 1, vals: () => ({}) }), /unknown kind/);
  for (const l of c.lines()) for (const k of ['en', 'ja']) assert.ok(isClean(l.text[k]), l.text[k]);
});

test('flush writes latest.json (last 100, oldest first) and one file per day with its lines; the journal brings the lines back after a restart without duplicates', () => {
  const { dir, mk, c } = chron();
  for (let i = 0; i < 130; i++) c.add({ kind: 'ai_joined', bell: i * 3, actors: [`bbbbbbbbbbbbb${String(i).padStart(3, '0')}`], refs: [`join:${i}`], vals: l => ({ b: i * 3, name: `N${i}`, nation: 'X' }) });
  assert.equal(c.flush(), true);
  assert.equal(c.flush(), false, 'nothing changed');
  const latest = JSON.parse(readFileSync(join(dir, 'pub/chronicle/latest.json'), 'utf8'));
  assert.equal(latest.lines.length, LATEST_LINES);
  assert.equal(latest.lines.at(-1).bell, 129 * 3);
  assert.ok(latest.lines[0].bell < latest.lines.at(-1).bell);
  const day0 = JSON.parse(readFileSync(join(dir, 'pub/chronicle/0.json'), 'utf8'));
  assert.equal(day0.day, 0);
  assert.ok(day0.lines.every(x => x.bell < DAY_BELLS));
  assert.ok(existsSync(join(dir, 'pub/chronicle/2.json')), '129 * 3 = 387 is in day 2');
  // a restart: the journal is read, the same facts are not added again, new ones are
  const again = mk();
  assert.equal(again.lines().length, 130);
  assert.equal(again.add({ kind: 'ai_joined', bell: 3, actors: ['bbbbbbbbbbbbb001'], refs: ['join:1'], vals: () => ({}) }), null);
  assert.ok(again.add({ kind: 'ai_joined', bell: 999, actors: ['bbbbbbbbbbbbb999'], refs: ['join:999'], vals: l => ({ b: 999, name: 'N', nation: 'X' }) }));
  assert.equal(again.flush(), true);
});
