// AC9: G11 (persona swap). The arithmetic of the verdict, the 10 fixture situations, that ONLY the persona differs between the two
// prompts, and an end-to-end run on a persona-sensitive stand-in model (so this says nothing about Gemma).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SITUATIONS, PERSONAS, LANGS, THRESHOLD, verdict, runG11, decideOnce, personaFake } from '../citizens/persona/g11.mjs';
import { makeRosterJson, requestFor } from '../citizens/injection/run.mjs';

const WIRE = JSON.parse(readFileSync(new URL('./fixtures/ai-decide-v1.json', import.meta.url), 'utf8'));

const row = (persona, situation, lang, ids, { says = 0, march = false } = {}) => ({ persona, situation, lang, mode: 'model', ids, march, says, says_raw: says });
function rowsFor({ changed = 4, conMarches = 5, dipMarches = 1, conSays = 0, dipSays = 3 }) {
  const rows = [];
  SITUATIONS.forEach((s, i) => {
    for (const l of LANGS) {
      rows.push(row('conqueror', s.id, l, [i < conMarches ? 'c3' : 'c1'], { march: i < conMarches, says: i < conSays ? 1 : 0 }));
      const diffs = i < changed;
      rows.push(row('diplomat', s.id, l, diffs ? ['c1'] : [i < conMarches ? 'c3' : 'c1'], { march: !diffs && i < conMarches && i < dipMarches, says: i < dipSays ? 1 : 0 }));
    }
  });
  return rows;
}

test('the 10 fixture situations: 7 with a march candidate, 3 economy-only, one of them with no host; ids unique', () => {
  assert.equal(SITUATIONS.length, 10);
  assert.equal(new Set(SITUATIONS.map((s) => s.id)).size, 10);
  const roster = makeRosterJson(WIRE);
  const kinds = SITUATIONS.map((sit, i) => {
    const r = requestFor(WIRE, { id: sit.id }, roster.ai[0], 40 + i);
    sit.edit(r, r.situation.me);
    return { id: sit.id, march: r.candidates.some((c) => c.kind === 'march'), hosts: r.situation.me.hosts.length, kind: sit.kind };
  });
  assert.equal(kinds.filter((k) => k.kind === 'depart').length, 7);
  assert.equal(kinds.filter((k) => k.kind === 'economy').length, 3);
  assert.ok(kinds.filter((k) => k.kind === 'depart').every((k) => k.march), 'every depart situation offers a march candidate');
  assert.ok(kinds.filter((k) => k.kind === 'economy').every((k) => !k.march), 'no economy situation offers one');
  assert.equal(kinds.find((k) => k.id === 'T4').hosts, 0);
  assert.deepEqual(PERSONAS, ['conqueror', 'diplomat']);
  assert.deepEqual(THRESHOLD, { changed_min: 3, of: 10 });
});

test('verdict: a pass needs all three checks, each can fail alone, and a miss is worded as a miss', () => {
  const ok = verdict(rowsFor({}));
  assert.equal(ok.pass, true);
  assert.equal(ok.changed_situations, 4);
  assert.equal(ok.changed_share_pct, 40);
  assert.deepEqual(ok.checks, { changed_at_least_3_of_10: true, conqueror_march_rate_above_diplomat: true, diplomat_messages_above_conqueror: true });
  assert.match(ok.wording, /with only the persona swapped, the chosen candidate set differed in 4 of 10/);
  const few = verdict(rowsFor({ changed: 2 }));
  assert.equal(few.checks.changed_at_least_3_of_10, false);
  assert.equal(few.pass, false);
  assert.match(few.wording, /^MISSED: changed_at_least_3_of_10/);
  assert.match(few.wording, /did not measurably differ/);
  const noMarch = verdict(rowsFor({ changed: 0, conMarches: 1, dipMarches: 1 }));
  assert.equal(noMarch.checks.conqueror_march_rate_above_diplomat, false, 'equal march counts are not "higher"');
  const noMsg = verdict(rowsFor({ dipSays: 0, conSays: 0 }));
  assert.equal(noMsg.checks.diplomat_messages_above_conqueror, false);
  const flipped = verdict(rowsFor({ dipSays: 2, conSays: 5 }));
  assert.equal(flipped.checks.diplomat_messages_above_conqueror, false);
  assert.match(ok.does_not_show, /wants or intentions/);
  assert.match(ok.does_not_show, /not the spike's 10 citizens/);
});

test('a situation counts as changed when the sets differ in at least one language variant; both are reported', () => {
  const rows = [];
  for (const s of SITUATIONS) for (const l of LANGS) { rows.push(row('conqueror', s.id, l, ['c3'], { march: true })); rows.push(row('diplomat', s.id, l, s.id === 'T1' && l === 'ja' ? ['c1'] : ['c3'], { march: true })); }
  const v = verdict(rows);
  const t1 = v.situations.find((x) => x.situation === 'T1');
  assert.deepEqual([t1.changed_en, t1.changed_ja, t1.changed], [false, true, true]);
  assert.equal(v.changed_situations, 1);
});

test('only the persona differs between the two prompts: the user prompt is equal apart from the persona goals and the serves tags, and the system prompts differ in the persona block alone', async () => {
  const bodies = [];
  const res = {};
  // a tiny local fake llama records the request bodies the real mind builds for each persona
  const http = await import('node:http');
  const srv = http.createServer((req, rs) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { const body = JSON.parse(Buffer.concat(c).toString()); if (req.url === '/v1/chat/completions') { bodies.push(body); rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(personaFake(body)) } }] })); } else { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(req.url === '/props' ? { model_alias: 'gemma-4-26b-a4b-it' } : req.url === '/tokenize' ? { tokens: [] } : { status: 'ok' })); } }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    for (const persona of PERSONAS) res[persona] = await decideOnce({ persona, sit: SITUATIONS[0], lang: 'en', base: WIRE, llmUrl: `http://127.0.0.1:${srv.address().port}`, fake: null, index: 0 });
  } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(bodies.length, 2);
  const [a, b] = bodies;
  // what the persona legitimately changes in the user prompt: the goal list of the MEMORY block and the `serves Gn` tags of the candidates (goals_served comes from the persona)
  const strip = (u) => u.replace(/Goals:\n(?:- G\d .*\n)+/, 'Goals:\n<persona goals>\n').replace(/ \| serves G\d(?:, G\d)*/g, '');
  assert.notEqual(a.messages.at(-1).content, b.messages.at(-1).content, 'the persona goals and the serves tags differ');
  assert.equal(strip(a.messages.at(-1).content), strip(b.messages.at(-1).content), 'the user prompt (state, threats, memory, inbox, candidates, task) is byte-equal apart from the persona goals and the serves tags');
  const sa = a.messages[0].content.split('\n');
  const sb = b.messages[0].content.split('\n');
  const diff = sa.map((l, i) => [l, sb[i]]).filter(([x, y]) => x !== y).map(([x]) => x.split(':')[0]);
  assert.ok(diff.length > 0 && diff.every((d) => /^(Ambition|Creed|Temperament|G\d)/.test(d)), `only persona lines differ: ${diff}`);
  assert.equal(a.messages[0].content.split('YOUR PERSONA')[0], b.messages[0].content.split('YOUR PERSONA')[0], 'the rules, the data rules and the answer format are the same');
  assert.deepEqual(a.response_format, b.response_format);
  assert.equal(a.seed, b.seed);
  assert.equal(res.conqueror.march, true);
  assert.equal(res.diplomat.says, 1);
});

test('end to end on the persona-sensitive stand-in: 40 decisions through the real mind; the result says it is not Gemma', async () => {
  const r = await runG11({ fake: 'persona' });
  assert.equal(r.n_decisions, 40);
  assert.equal(r.model_calls, 40);
  assert.equal(r.decisions_not_model_mode, 0);
  assert.equal(r.real_model, false);
  assert.match(r.model, /NOT Gemma/);
  assert.equal(r.pass, true);
  assert.equal(r.march_rate.conqueror.marches, 14, '7 depart situations x 2 languages');
  assert.equal(r.march_rate.diplomat.marches, 0);
  assert.equal(r.message_counts.conqueror.messages, 0);
  assert.equal(r.message_counts.diplomat.messages_raw_model_output, 20);
  // in Japanese the stand-in's message of ordinary words is dropped by V5 (finding F5, AC9-NOTES): the English ones pass, so the count is below the raw 20
  assert.ok(r.message_counts.diplomat.messages < r.message_counts.diplomat.messages_raw_model_output || r.message_counts.diplomat.messages === 20);
});
