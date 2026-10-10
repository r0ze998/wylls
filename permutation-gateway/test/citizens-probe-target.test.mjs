// AC9: the targeted memory comparison (citizens/probe/target.mjs): one stored decision asked with and without the Remembered
// lines of one source. The real body is the VERBATIM slice-4 request 40bfe3dc of test/fixtures/ai-ac9-slice4; the small
// prompt built by `synthetic()` is SYNTHETIC (it follows the mind's line templates and is labelled so). The model is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecords, loadRequests, parseBody } from '../citizens/probe/memory.mjs';
import {
  VARIANTS, CAVEATS, parseTarget, targetText, episodeMatches, loadEpisodes, mapHandles, selectHandles, situationLines, matchSituation, buildWithout, settingsOf,
  targetWording, executedResult, planTarget, finishTarget, renderMarkdown, loadTx, loadOpened, createOutDir, siblingAttempts, writeJson,
} from '../citizens/probe/target.mjs';

const FIX = new URL('./fixtures/ai-ac9-slice4/', import.meta.url).pathname;
const records = loadRecords(`${FIX}state/records.jsonl`);
const requests = loadRequests(`${FIX}state/requests`);
const real = requests.find((r) => r.id.startsWith('40bfe3dc'));
const realRec = records.get(real.id);
const realEps = loadEpisodes(`${FIX}pub/memory`, realRec.ai);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'probe-target-'));

// ---- SYNTHETIC prompt: 2 THREATS lines, 1 clash line, 5 Remembered lines, 3 candidates with refs
const ep = (id, kind, bell, entities, src, facts, en) => ({ v: 1, id, bell, created_bell: bell, kind, entities, text: { en }, importance: 5, src, facts });
const EPS = [
  ep('aaaaaaaaaaaaaaa1', 'threat', 10, ['nation:2', 'pq:-3,1'], ['event:784'], { p: -3, q: 1, nation: 2, mass: 100, arrive_bell: 13 }, 'At bell 10 nation Cinder sent an army of 100 troops from (-3,1); it arrives at bell 13; its destination is not known.'),
  ep('aaaaaaaaaaaaaaa2', 'camp_taken_by', 28, ['nation:2', 'pq:-3,1'], ['event:2556', 'event:2557'], { p: -3, q: 1, nation: 2 }, 'At bell 28 nation Cinder cleared the camp at (-3,1) first.'),
  ep('aaaaaaaaaaaaaaa3', 'build_done', 32, ['pq:-3,0'], ['event:1568'], { p: -3, q: 0, site: 8, item: 0 }, 'At bell 32 your farm was finished.'),
  ep('aaaaaaaaaaaaaaa4', 'threat', 34, ['nation:5', 'pq:0,2'], ['event:2872'], { p: 0, q: 2, nation: 5, mass: 300, arrive_bell: 37 }, 'At bell 34 nation Fjordal sent an army of 300 troops from (0,2); it arrives at bell 37; its destination is not known.'),
  ep('aaaaaaaaaaaaaaa5', 'clash_own_win', 36, ['pq:-2,-1'], ['event:3209', 'host:1'], { p: -2, q: -1, lost_own: 50, lost_enemy: 399, camp: true, nation: null }, 'At bell 36 your army at (-2,-1) beat the camp: you lost 50, they lost 399.'),
  // not retrieved (created at the decision's bell): the wake's own threat
  ep('aaaaaaaaaaaaaaa6', 'threat', 41, ['nation:2', 'pq:-3,1'], ['event:3320'], { p: -3, q: 1, nation: 2, mass: 150, arrive_bell: 44 }, 'At bell 41 nation Cinder sent an army of 150 troops from (-3,1); it arrives at bell 44; its destination is not known.'),
];
const RETRIEVED = EPS.slice(0, 5).map((e) => e.id);
function synthetic({ threats = ['  nation 2 sent an army of 150 troops from (-3,1); it arrives at bell 44; its destination is not known.', '  nation 5 sent an army of 300 troops from (0,2); it arrives at bell 37; its destination is not known.'], clashes = ['  bell 36 at (-2,-1): you lost 50, they lost 399 (won)'] } = {}) {
  const rem = EPS.slice(0, 5).map((e, i) => `M${i + 1} [bell ${e.bell}] <memory kind="episode" id="M${i + 1}">${e.text.en}</memory>`);
  const user = [
    'NOW: bell 41 (day 0, bell 41/144). Season ends at bell 1008.',
    'YOU: nation 3 (D Verdant).',
    'NEIGHBOURHOOD (provinces you can see; d = distance in provinces):',
    '  (-3,1) d=1: no camp; villages nation 2 x2; hosts nation 2 5/487 (hosts/troops)',
    ...(clashes.length ? ['YOUR RECENT CLASHES:', ...clashes] : []),
    '',
    ...(threats.length ? ['THREATS:', ...threats] : ['THREATS: none seen.']),
    'COUNCIL: no council this period.',
    '',
    'PEOPLE: none named in this prompt.',
    'MEMORY',
    'Remembered:',
    ...rem,
    '',
    'INBOX (direct messages to you):',
    'none',
    'NATION HALL (recent messages in your nation channel):',
    'none',
    '',
    'CANDIDATES:',
    'c1 [hold] Hold: duties only | duties duties only',
    'c2 [march] March H3 to a camp | target (-3,0) | see M3 | serves G1',
    'c3 [march] March H3 to an army | target (-3,1) | see M2, M1, M4 | serves G1',
    '',
    'TASK: session at bell 41.',
  ].join('\n');
  const schema = { type: 'object', properties: { choose: { type: 'array', items: { enum: ['c1', 'c2', 'c3'] } }, mem: { type: 'array', maxItems: 3, items: { enum: ['M1', 'M2', 'M3', 'M4', 'M5'] } }, why: { type: 'string' } } };
  return JSON.stringify({ model: 'gemma-4-26b-a4b-it', messages: [{ role: 'system', content: 'SYNTHETIC' }, { role: 'user', content: user }], temperature: 0, top_k: 1, seed: 7, cache_prompt: false, max_tokens: 384, stream: false, response_format: { type: 'json_schema', json_schema: { name: 'session', strict: true, schema } } });
}
const SYN_REC = { ai: 'feedfeedfeedfeed', bell: 41, retrieved: RETRIEVED, choice: { ids: ['c3'], params: { c3: { stance: 'assault' } }, goal_id: 'G1', mem: [EPS[1].id] }, public: { why: 'stored why' }, tx: [], output_hash: null };
const answer = (choose, mem = [], why = 'w') => JSON.stringify({ goal_id: 'G1', choose, params: {}, say: [], council: null, trust: [], mem, why });
const userOf = (text) => JSON.parse(text).messages[1].content;

test('parseTarget: the four selector types, a union by commas, and a place keeps its comma', () => {
  assert.deepEqual(parseTarget('entity:nation:2'), [{ type: 'entity', value: 'nation:2', text: 'entity:nation:2' }]);
  assert.deepEqual(parseTarget('entity:pq:-3,1'), [{ type: 'entity', value: 'pq:-3,1', text: 'entity:pq:-3,1' }]);
  const u = parseTarget('entity:pq:-3,1,kind:threat,event:784,id:aaaaaaaaaaaaaaa1');
  assert.deepEqual(u.map((s) => [s.type, s.value]), [['entity', 'pq:-3,1'], ['kind', 'threat'], ['event', '784'], ['id', 'aaaaaaaaaaaaaaa1']]);
  assert.equal(targetText(u), 'entity:pq:-3,1,kind:threat,event:784,id:aaaaaaaaaaaaaaa1');
  for (const bad of ['', 'nation:2', 'actor:x', 'event:abc', 'id:xyz', 'kind:Threat!', 'entity:a b']) assert.throws(() => parseTarget(bad), /probe:/, bad);
});

test('episodeMatches: by entity, kind, source event and id', () => {
  assert.equal(episodeMatches(EPS[0], parseTarget('entity:nation:2')), true);
  assert.equal(episodeMatches(EPS[2], parseTarget('entity:nation:2')), false);
  assert.equal(episodeMatches(EPS[1], parseTarget('event:2557')), true, 'any event of src');
  assert.equal(episodeMatches(EPS[1], parseTarget('event:255')), false, 'no prefix match');
  assert.equal(episodeMatches(EPS[3], parseTarget('kind:threat')), true);
  assert.equal(episodeMatches(EPS[4], parseTarget('id:aaaaaaaaaaaaaaa5')), true);
  assert.equal(episodeMatches(EPS[4], parseTarget('entity:nation:9,kind:clash_own_win')), true, 'a union');
  assert.equal(episodeMatches(null, parseTarget('kind:threat')), false);
});

test('mapHandles on a real body: Mn is retrieved[n - 1], with the bell and the code text of the episode', () => {
  const p = parseBody(real.text);
  const m = mapHandles(p, realRec, realEps);
  assert.deepEqual(m.map((x) => x.handle), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  assert.deepEqual(m.map((x) => x.id), realRec.retrieved);
  assert.ok(m.every((x) => x.text_equal === true && x.episode.bell === x.bell));
  assert.deepEqual(selectHandles(m, parseTarget('kind:threat')), ['M3']);
  assert.deepEqual(selectHandles(m, parseTarget('entity:nation:3')), ['M3']);
  assert.deepEqual(selectHandles(m, parseTarget('event:2793')), ['M4', 'M5'], 'two episodes share the source event');
  assert.deepEqual(selectHandles(m, parseTarget(`id:${realRec.retrieved[0]}`)), ['M1']);
  assert.deepEqual(selectHandles(m, parseTarget('entity:nation:9')), []);
});

test('mapHandles refuses a mapping that does not hold, and maps an id missing from the file to no episode', () => {
  const p = parseBody(real.text);
  assert.throws(() => mapHandles(p, { ...realRec, retrieved: realRec.retrieved.slice(1) }, realEps), /retrieved 6 episodes, the prompt holds 7/);
  assert.throws(() => mapHandles(p, { ...realRec, retrieved: [...realRec.retrieved].reverse() }, realEps), /the mapping does not hold/);
  assert.throws(() => mapHandles(p, { ai: 'x' }, realEps), /no `retrieved` list/);
  const m = mapHandles(p, realRec, realEps.filter((e) => e.id !== realRec.retrieved[2]));
  assert.equal(m[2].episode, null);
  assert.deepEqual(selectHandles(m, parseTarget('kind:threat')), [], 'an unmapped line is not selected by its source');
  assert.deepEqual(selectHandles(m, parseTarget(`id:${realRec.retrieved[2]}`)), ['M3'], 'only by its id');
});

test('situationLines (synthetic): the THREATS and YOUR RECENT CLASHES lines with their numbers', () => {
  const s = situationLines(parseBody(synthetic()));
  assert.deepEqual(s.threats.map((t) => [t.nation, t.mass, t.p, t.q, t.arrive_bell]), [[2, 150, -3, 1, 44], [5, 300, 0, 2, 37]]);
  assert.deepEqual(s.clashes.map((c) => [c.bell, c.p, c.q, c.lost_own, c.lost_enemy]), [[36, -2, -1, 50, 399]]);
  const none = situationLines(parseBody(real.text));
  assert.deepEqual([none.threats.length, none.clashes.length], [0, 0], 'the real body says "THREATS: none seen."');
});

test('matchSituation (synthetic): a THREATS line is removed only when its numbers equal a targeted episode and no untargeted one', () => {
  const p = parseBody(synthetic());
  // the wake's threat (episode 6, not among the Remembered lines) is nation 2's: it goes with the target
  const a = matchSituation(p, EPS, parseTarget('entity:nation:2'));
  assert.deepEqual(a.remove.map((x) => [x.section, x.episodes]), [['THREATS', ['aaaaaaaaaaaaaaa6']]]);
  assert.deepEqual(a.leak, []);
  // another event (nation 5) fits only an untargeted episode: it stays and is no leak
  assert.ok(!a.remove.some((x) => /nation 5/.test(x.line)));
  const b = matchSituation(p, EPS, parseTarget('event:2872'));
  assert.deepEqual(b.remove.map((x) => x.line), ['  nation 5 sent an army of 300 troops from (0,2); it arrives at bell 37; its destination is not known.']);
  // the clash line and the clash episode
  const c = matchSituation(p, EPS, parseTarget('kind:clash_own_win'));
  assert.deepEqual(c.remove.map((x) => x.section), ['YOUR RECENT CLASHES']);
  assert.deepEqual(matchSituation(p, EPS, parseTarget('kind:build_done')), { remove: [], leak: [], sit: a.sit });
});

test('matchSituation (synthetic): no exact correspondence -> the line is left and named in leak', () => {
  // the THREATS line says 160 troops: no episode has these numbers, and it names the targeted nation
  const off = parseBody(synthetic({ threats: ['  nation 2 sent an army of 160 troops from (-3,1); it arrives at bell 44; its destination is not known.'] }));
  const a = matchSituation(off, EPS, parseTarget('entity:nation:2'));
  assert.deepEqual(a.remove, []);
  assert.equal(a.leak.length, 1);
  assert.match(a.leak[0].why, /no episode has exactly these numbers/);
  assert.equal(matchSituation(off, EPS, parseTarget('id:aaaaaaaaaaaaaaa1')).leak.length, 1, 'the targeted threat episode names the same nation and place');
  assert.equal(matchSituation(off, EPS, parseTarget('kind:build_done')).leak.length, 0, 'an unrelated target: no leak');
  // two episodes with the same numbers, one targeted (by its event), one not: ambiguous, left, leak
  const twin = [...EPS, { ...EPS[5], id: 'aaaaaaaaaaaaaaa7', src: ['event:3321'] }];
  const b = matchSituation(parseBody(synthetic()), twin, parseTarget('event:3320'));
  assert.deepEqual(b.remove, []);
  assert.match(b.leak[0].why, /a targeted and an untargeted episode/);
  // a clash line whose losses differ from the targeted clash episode at the same place
  const cl = parseBody(synthetic({ clashes: ['  bell 36 at (-2,-1): you lost 51, they lost 399 (won)'] }));
  assert.equal(matchSituation(cl, EPS, parseTarget('entity:pq:-2,-1')).leak.length, 1);
});

test('buildWithout (synthetic): the lines, their see refs and mem enum entries go; an emptied section is printed as the renderer prints it', () => {
  const text = synthetic();
  const p = parseBody(text);
  const sel = parseTarget('entity:nation:2');
  const handles = selectHandles(mapHandles(p, SYN_REC, EPS), sel);
  assert.deepEqual(handles, ['M1', 'M2']);
  const w = buildWithout(p, { handles, situation: matchSituation(p, EPS, sel) });
  const u = userOf(w.text);
  assert.ok(!/Cinder/.test(u) && !/nation 2 sent/.test(u), 'neither the Remembered lines nor the THREATS line of the target are left');
  assert.ok(u.includes('THREATS:\n  nation 5 sent an army of 300 troops'), 'the other threat stays under its heading');
  assert.ok(u.includes('c3 [march] March H3 to an army | target (-3,1) | see M4 | serves G1'));
  assert.ok(u.includes('| see M3 |'));
  assert.deepEqual(w.body.response_format.json_schema.schema.properties.mem.items.enum, ['M3', 'M4', 'M5']);
  assert.deepEqual(w.removed_refs, [{ candidate: 'c3', refs: ['M2', 'M1'] }]);
  assert.deepEqual(w.removed_mem_enum, ['M1', 'M2']);
  assert.equal(w.removed_remembered.length, 2);
  assert.equal(w.removed_situation.length, 1);
  // every threat and the clash targeted: "THREATS: none seen." and no clashes heading
  const all = parseTarget('kind:threat,kind:clash_own_win');
  const w2 = buildWithout(p, { handles: selectHandles(mapHandles(p, SYN_REC, EPS), all), situation: matchSituation(p, EPS, all) });
  const u2 = userOf(w2.text);
  assert.ok(u2.includes('\nTHREATS: none seen.\nCOUNCIL:'));
  assert.ok(!u2.includes('YOUR RECENT CLASHES') && !u2.includes('you lost 50'));
  assert.ok(u2.includes('NEIGHBOURHOOD') && u2.includes('hosts nation 2 5/487'), 'the present state is not an episode: it stays');
  // every Remembered line targeted: the renderer's empty-memory line
  const w3 = buildWithout(p, { handles: ['M1', 'M2', 'M3', 'M4', 'M5'] });
  assert.ok(userOf(w3.text).includes('Remembered:\n(nothing remembered yet)\n'));
  assert.deepEqual(w3.body.response_format.json_schema.schema.properties.mem, { type: 'array', maxItems: 0 });
});

test('planTarget on the real body: variant A and D are the stored bytes, B differs only by the target, the settings are equal', async () => {
  const plan = await planTarget({ id: real.id, text: real.text, record: realRec, episodes: realEps, target: 'kind:threat' });
  assert.deepEqual(plan.variants.map((v) => v.name), [...VARIANTS]);
  assert.equal(plan.variants[0].text, real.text, 'A is byte-identical to the stored body');
  assert.equal(plan.variants[3].text, real.text, 'D too');
  assert.equal(sha(plan.variants[0].text), realRec.request_hash);
  const c = plan.comparison;
  assert.equal(c.request_matches_record, true);
  assert.equal(c.dry_run, true);
  assert.equal(c.wording, null, 'nothing is stated before the model answered');
  assert.deepEqual(c.targeted_episodes.map((e) => [e.handle, e.kind, e.bell, e.src]), [['M3', 'threat', 40, ['event:2472']]]);
  assert.deepEqual(c.removed.remembered_lines, [parseBody(real.text).lines.find((l) => l.startsWith('M3 '))]);
  assert.deepEqual(c.removed.diff.removed, c.removed.remembered_lines, 'the only removed line (this body has no see ref to M3)');
  assert.deepEqual(c.removed.mem_enum, ['M3']);
  assert.equal(c.removed.outside_user_and_mem_equal, true);
  assert.equal(c.settings_equal_in_every_variant, true);
  assert.deepEqual(c.settings, settingsOf(JSON.parse(real.text)));
  assert.deepEqual([c.settings.temperature, c.settings.top_k, c.settings.top_p, c.settings.cache_prompt, c.settings.response_format], [0, 1, null, false, 'session']);
  assert.equal(c.settings.seed, realRec.seed);
  assert.ok(!c.control.removed_handles.includes('M3') && !realRec.choice.mem.some((id) => c.control.removed_handles.includes(`M${realRec.retrieved.indexOf(id) + 1}`)), 'the control takes neither the target nor a cited line');
  assert.deepEqual(c.variants.map((v) => v.same_bytes_as_stored_request), [true, false, false, true]);
  assert.match(c.result.not_executed, /NOT executed in a game/);
  await assert.rejects(() => planTarget({ id: real.id, text: real.text, record: realRec, episodes: realEps, target: 'entity:nation:9' }), /nothing to remove/);
});

test('planTarget (synthetic): the control never takes a line about the targeted nation or place; none left -> no control variant', async () => {
  const plan = await planTarget({ id: 'synthetic'.padEnd(64, '0'), text: synthetic(), record: SYN_REC, episodes: EPS, target: 'entity:nation:2' });
  assert.deepEqual(plan.comparison.control.removed_handles, ['M3', 'M5'], 'never M1, M2 (the target) nor M4 (a key-kind line: not in the control pool of memory.mjs)');
  assert.ok(plan.comparison.control.removed_tokens <= plan.comparison.removed.tokens);
  assert.deepEqual(plan.comparison.order, ['with', 'without', 'control', 'with-again']);
  const p2 = await planTarget({ id: 'synthetic'.padEnd(64, '0'), text: synthetic(), record: SYN_REC, episodes: EPS, target: 'entity:pq:-3,0,kind:clash_own_win' });
  assert.ok(p2.comparison.control.unavailable);
  assert.deepEqual(p2.comparison.order, ['with', 'without', 'with-again']);
  const done = finishTarget(p2, { with: { content: answer(['c3']) }, without: { content: answer(['c1']) }, 'with-again': { content: answer(['c3']) } });
  assert.equal(done.wording, 'when the Remembered lines from entity:pq:-3,0,kind:clash_own_win were removed from this 1 logged prompt, the chosen candidate changed (rerun: same; control: none available)');
  assert.match(done.wording_note, /1 situation line/);
});

test('finishTarget: changed_vs_with against variant A of this attempt, the allowed wording, and no statement without an answer', async () => {
  const plan = await planTarget({ id: 'synthetic'.padEnd(64, '0'), text: synthetic(), record: SYN_REC, episodes: EPS, target: 'entity:nation:2' });
  const a = { content: answer(['c3'], ['M2'], 'strike back'), finish_reason: 'stop', latency_ms: 11, usage: { prompt_tokens: 900, completion_tokens: 40 }, raw_sha256: 'r1' };
  const same = finishTarget(plan, { with: a, without: { content: answer(['c3'], ['M4']) }, control: { content: answer(['c3']) }, 'with-again': a });
  assert.deepEqual(same.changed_vs_with, { without: false, control: false, 'with-again': false });
  assert.equal(same.wording, 'when the Remembered lines from entity:nation:2 were removed from this 1 logged prompt, the chosen candidate did not change (rerun: same; control: same)');
  assert.equal(same.dry_run, false);
  const w = same.variants.find((v) => v.name === 'with');
  assert.deepEqual([w.choose, w.mem, w.mem_ids, w.why, w.finish_reason, w.latency_ms, w.prompt_tokens, w.response_sha256], [['c3'], ['M2'], [EPS[1].id], 'strike back', 'stop', 11, 900, 'r1']);
  assert.equal(same.variants.find((v) => v.name === 'with-again').same_bytes_as_with, true);
  const flip = finishTarget(plan, { with: a, without: { content: answer(['c1']) }, control: { content: answer(['c2', 'c1']) }, 'with-again': { content: answer(['c2']) } });
  assert.deepEqual(flip.changed_vs_with, { without: true, control: true, 'with-again': true });
  assert.equal(flip.wording, targetWording({ selector: 'entity:nation:2', without: true, rerun: true, control: true }));
  assert.ok(!/because|improv|want|intent/i.test(flip.wording));
  const broken = finishTarget(plan, { with: a, without: { content: 'not json', error: null }, control: { content: answer(['c3']) }, 'with-again': a });
  assert.equal(broken.wording, null);
  assert.match(broken.wording_unavailable, /no readable answer/);
  assert.equal(broken.changed_vs_with.without, null);
  assert.deepEqual(plan.comparison.wording, null, 'the plan is not mutated');
  // the report a person reads: four rows, the sentence, the three caveats, and the unexecuted branch
  const md = renderMarkdown(flip);
  assert.equal(md.split('\n').filter((l) => /^\| (with|without|control|with-again) \|/.test(l)).length, 4);
  assert.ok(md.includes(flip.wording));
  for (const x of CAVEATS) assert.ok(md.includes(x));
  assert.ok(md.includes('The without-memory branch was not executed in a game.'));
  assert.ok(renderMarkdown(plan.comparison).includes('not asked (dry run)'));
});

test('executedResult, loadTx and loadOpened: the result is read for the stored decision only', () => {
  const dir = tmp();
  const id = 'ab'.repeat(32);
  const lines = [
    { op: 'add', entry: { id, bell: 41, full: { ai: 'x', tx: [] }, pub: {} } },
    { op: 'tx', id: 'cd'.repeat(32), tx: [{ intent: 'build', sig: 'S0', status: 'sent', code: null }] },
    { op: 'tx', id, tx: [{ intent: 'harvest', sig: 'S1', status: 'sent', code: null }, { intent: 'depart', sig: 'S2', status: 'sent', code: null, extra: 1 }] },
  ];
  writeFileSync(path.join(dir, 'records.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const tx = loadTx(path.join(dir, 'records.jsonl'), id);
  assert.deepEqual(tx.map((t) => t.intent), ['harvest', 'depart']);
  assert.equal(loadTx(path.join(dir, 'none.jsonl'), id), null);
  writeFileSync(path.join(dir, '46.json'), JSON.stringify({ v: 1, bell: 46, records: [{ id, opened_bell: 46, release_bell: 45, destinations: [{ host_id: '9', state: 'revealed', p: -3, q: 1, tile: 0, arrive_bell: 45, planned_arrive_bell: 44, depart_bell: 41 }] }] }));
  writeFileSync(path.join(dir, 'index.json'), '{}');
  const opened = loadOpened(dir, id);
  assert.equal(loadOpened(dir, 'ef'.repeat(32)), null);
  const r = executedResult(SYN_REC, tx, opened);
  assert.deepEqual(r.tx, [{ intent: 'harvest', sig: 'S1', status: 'sent', code: null }, { intent: 'depart', sig: 'S2', status: 'sent', code: null }]);
  assert.deepEqual(r.opened.destinations, [{ state: 'revealed', p: -3, q: 1, depart_bell: 41, arrive_bell: 45, planned_arrive_bell: 44 }]);
  assert.deepEqual(r.choice.choose, ['c3']);
  assert.match(r.branch, /the only branch that was executed/);
  assert.equal(executedResult(SYN_REC, null, null).opened, null);
});

test('createOutDir refuses an existing directory; siblingAttempts lists the earlier attempts for the same decision', () => {
  const base = tmp();
  const one = createOutDir(path.join(base, 'runs', 'one'));
  writeJson(path.join(one, 'attempt.json'), { record: 'R', utc: 'T1', target: 'kind:threat', dry_run: true });
  assert.throws(() => createOutDir(one), /exists: an attempt is never overwritten/);
  assert.throws(() => createOutDir(base), /exists/);
  assert.throws(() => createOutDir(''), /--out-dir DIR is required/);
  assert.throws(() => writeJson(path.join(one, 'attempt.json'), {}), /EEXIST/, 'a file of an attempt is never rewritten either');
  const two = createOutDir(path.join(base, 'runs', 'two'));
  assert.deepEqual(siblingAttempts(two, 'R'), [{ dir: 'one', utc: 'T1', target: 'kind:threat', dry_run: true }]);
  assert.deepEqual(siblingAttempts(two, 'other'), []);
});

test('CLI --target --dry: request files, attempt.json and comparison.json, no response, and a second run into the same directory is refused', () => {
  const out = path.join(tmp(), 'attempt-1');
  const cli = new URL('../citizens/probe/memory.mjs', import.meta.url).pathname;
  const argv = [cli, '--requests', `${FIX}state/requests`, '--records', `${FIX}state/records.jsonl`, '--episodes', `${FIX}pub/memory`, '--decision', real.id, '--target', 'kind:threat', '--out-dir', out, '--dry'];
  execFileSync(process.execPath, argv, { encoding: 'utf8' });
  assert.deepEqual(readdirSync(out).sort(), ['attempt.json', 'comparison.json', 'comparison.md', 'control.request.json', 'with-again.request.json', 'with.request.json', 'without.request.json']);
  assert.equal(readFileSync(path.join(out, 'with.request.json'), 'utf8'), real.text, 'the stored body, byte for byte');
  assert.equal(readFileSync(path.join(out, 'with-again.request.json'), 'utf8'), real.text);
  const att = JSON.parse(readFileSync(path.join(out, 'attempt.json'), 'utf8'));
  assert.match(att.utc, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(att.record, real.id);
  assert.equal(att.dry_run, true);
  assert.ok(att.argv.includes('--target'));
  assert.match(att.probe_source_sha256['target.mjs'], /^[0-9a-f]{64}$/);
  assert.match(att.probe_source_sha256['memory.mjs'], /^[0-9a-f]{64}$/);
  const c = JSON.parse(readFileSync(path.join(out, 'comparison.json'), 'utf8'));
  assert.equal(c.dry_run, true);
  assert.equal(c.variants.find((v) => v.name === 'without').request_sha256, sha(readFileSync(path.join(out, 'without.request.json'), 'utf8')));
  assert.throws(() => execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: 'pipe' }), /an attempt is never overwritten/);
  assert.ok(!existsSync(path.join(out, 'with.response.json')));
});
