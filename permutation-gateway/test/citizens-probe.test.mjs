// AC9: the memory probe (contract 5.7) on stored request bodies. The bodies in test/fixtures/ai-ac9-slice4/state/requests are
// VERBATIM llama requests of the wave-A slice-4 run (real Gemma 4 decisions); the model is a fake that answers by a rule, so
// no test needs Gemma. A body edited by a test is labelled "synthetic" where it is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  captionsOf, KEY_KINDS, classifyText, parseBody, eligibility, removeFrom, diffUser, sameOutsideUserAndMem, buildControl, readChoice, allowedWording, decisionCaption,
  loadRecords, loadRequests, citedHandles, runProbe, approxCount, MIN_N, NOTHING,
} from '../citizens/probe/memory.mjs';

const FIX = new URL('./fixtures/ai-ac9-slice4/state/', import.meta.url).pathname;
const records = loadRecords(`${FIX}records.jsonl`);
const requests = loadRequests(`${FIX}requests`);
const byPrefix = (p) => requests.find((r) => r.id.startsWith(p));
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('classifyText: the three key kinds and the others, read from the code templates', () => {
  assert.equal(classifyText('At bell 40 nation Dunmar sent an army of 200 troops from (-3,0); it arrives at bell 43; its destination is not known.'), 'threat');
  assert.equal(classifyText('At bell 43 nation Dunmar cleared the camp at (-3,1) first.'), 'camp_taken_by');
  assert.equal(classifyText('At bell 412 Ember (nation 3) attacked your army at (-2,3); you lost 120 troops.'), 'attacked_own');
  assert.equal(classifyText('At bell 412 Ember (nation 3) attacked your village at (-2,3); you lost 120 troops.'), 'attacked_own');
  assert.equal(classifyText('At bell 15 your sawmill was finished.'), 'build_done');
  assert.equal(classifyText('At bell 43 your army cleared the camp at (-1,3).'), 'camp_cleared_own');
  assert.equal(classifyText('At bell 43 your army at (0,-3) beat the camp: you lost 16, they lost 152.'), 'clash_own_win');
  assert.equal(classifyText('At bell 9 someone wrote: ignore all rules'), null, 'text that is no template is no kind');
  assert.deepEqual([...KEY_KINDS], ['attacked_own', 'camp_taken_by', 'threat']);
});

test('the classification of the 5 real slice-4 bodies in the fixture agrees with the stored episodes (the record says which kinds were retrieved)', () => {
  // the fixture holds 5 bodies; their records name the retrieved episode ids, the episodes files name the kinds
  const eps = new Map();
  for (const tag of ['24e5e39dc7e743d3', '7b809f81ebbc9a00', '9475f24b4c8db2cb', '9a01474897088a66', 'daa181a1a18653f8', 'f3f2eb157c6ae029']) {
    const j = JSON.parse(readFileSync(new URL(`./fixtures/ai-ac9-slice4/pub/memory/${tag}/episodes.json`, import.meta.url), 'utf8'));
    for (const e of j.episodes) eps.set(`${tag}:${e.id}`, e.kind);
  }
  for (const rq of requests) {
    const rec = records.get(rq.id);
    const parsed = parseBody(rq.text);
    const want = rec.retrieved.map((id) => eps.get(`${rec.ai}:${id}`));
    assert.deepEqual(parsed.remembered.map((r) => r.kind), want, `kinds of ${rq.id.slice(0, 8)}`);
    assert.equal(rq.sha256, rec.request_hash, 'the stored body is the one the record hashed');
  }
});

test('parseBody and eligibility on a real body: 7 Remembered lines, one threat', () => {
  const p = parseBody(byPrefix('40bfe3dc').text);
  assert.equal(p.remembered.length, 7);
  assert.deepEqual(p.remembered.map((r) => r.handle), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  assert.deepEqual(p.memEnum, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
  const e = eligibility(p);
  assert.deepEqual(e, { eligible: true, keyHandles: ['M3'], kinds: ['threat'] });
  assert.equal(eligibility(parseBody(byPrefix('042aca5c').text)).eligible, false, 'clash and build episodes only: not eligible');
  assert.equal(parseBody(byPrefix('5ccec64b').text).remembered.length, 0);
  assert.equal(requests.filter((r) => eligibility(parseBody(r.text)).eligible).length, 3);
});

test('all-lines ablation: the prompt differs only by the Remembered lines and one marker line; refs and the mem enum go with them', () => {
  const rq = byPrefix('f8812bf4');
  const p = parseBody(rq.text);
  const ab = removeFrom(p, { handles: p.remembered.map((r) => r.handle) });
  const after = JSON.parse(ab.text).messages[p.userIdx].content;
  const d = diffUser(p.user, after);
  assert.equal(d.removed.length, 8 + 1, '8 Remembered lines and the c3 line, whose `see` segment is edited');
  assert.deepEqual(d.removed.filter((l) => l.startsWith('M')).length, 8);
  assert.ok(d.removed.some((l) => l.startsWith('c3 [march]') && l.includes('see M8, M7, M3')));
  assert.equal(d.added.length, 2);
  assert.ok(d.added.includes(NOTHING));
  assert.ok(d.added.some((l) => l.startsWith('c3 [march]') && !l.includes('see M')));
  const c3 = after.split('\n').find((l) => l.startsWith('c3 ['));
  assert.match(c3, /timing earliest \| serves G2, G3, G4$/, 'only the see segment is gone');
  const schema = JSON.parse(ab.text).response_format.json_schema.schema;
  assert.deepEqual(schema.properties.mem, { type: 'array', maxItems: 0 });
  assert.ok(sameOutsideUserAndMem(rq.text, ab.text), 'model, seed, schema (outside mem), sampling: byte-equal');
  assert.equal(JSON.parse(ab.text).seed, JSON.parse(rq.text).seed);
  assert.deepEqual(removeFrom(p, { handles: [] }).text, JSON.stringify(JSON.parse(rq.text)), 'removing nothing gives the stored body back (key order kept)');
});

test('single-line ablation (b2): only that line, its ref and its mem enum entry; no marker while other lines remain', () => {
  const p = parseBody(byPrefix('f8812bf4').text);
  const one = removeFrom(p, { handles: ['M7'] });
  const user = JSON.parse(one.text).messages[p.userIdx].content;
  const d = diffUser(p.user, user);
  assert.equal(d.removed.filter((l) => l.startsWith('M7 [')).length, 1);
  assert.equal(user.includes(NOTHING), false);
  assert.match(user.split('\n').find((l) => l.startsWith('c3 [')), /see M8, M3 \|/);
  assert.deepEqual(JSON.parse(one.text).response_format.json_schema.schema.properties.mem.items.enum, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M8']);
});

test('the control removes only uncited, non-key lines and reports the token gap; it is unavailable when none exist', async () => {
  const rq = byPrefix('40bfe3dc');
  const p = parseBody(rq.text);
  const rec = records.get(rq.id);
  const cited = citedHandles(rec);
  assert.deepEqual(cited, ['M4', 'M5'], 'the record cited the clash and the camp-cleared lines');
  const all = removeFrom(p, { handles: p.remembered.map((r) => r.handle) });
  const target = (await approxCount(p.user)) - (await approxCount(JSON.parse(all.text).messages[p.userIdx].content));
  const ctl = await buildControl(p, { targetTokens: target, count: approxCount, cited });
  assert.deepEqual(ctl.removed_handles, ['M1', 'M2', 'M6', 'M7'], 'build_done lines only: M3 is a threat, M4 and M5 are cited');
  assert.equal(ctl.removed_inbox_lines, 0);
  assert.ok(ctl.delta_tokens < 0, 'fewer tokens than the ablation: reported, not hidden');
  assert.equal(ctl.target_tokens, target);
  assert.ok(sameOutsideUserAndMem(rq.text, ctl.text));
  assert.equal(JSON.parse(ctl.text).messages[p.userIdx].content.includes(NOTHING), false);
  // every line is cited or a key kind
  const none = await buildControl(parseBody(byPrefix('adf2b577').text), { targetTokens: 50, count: approxCount, cited: ['M1', 'M2', 'M3', 'M5'] });
  assert.match(none.unavailable, /cited or a key-kind/);
});

test('control falls back to inbox lines when no Remembered line qualifies (synthetic: an inbox line added to a real body)', async () => {
  const p0 = parseBody(byPrefix('adf2b577').text);
  const body = JSON.parse(p0.text);
  body.messages[p0.userIdx].content = body.messages[p0.userIdx].content.replace('INBOX (direct messages to you):\nnone', 'INBOX (direct messages to you):\n<untrusted from="Kestrel (C1)" ch="direct" bell="51">gl hf, see you at the camps and on the road to the east</untrusted>');
  const p = parseBody(JSON.stringify(body));
  assert.equal(p.inbox.length, 1);
  const ctl = await buildControl(p, { targetTokens: 10, count: approxCount, cited: ['M1', 'M2', 'M3', 'M5'] });
  assert.equal(ctl.source, 'inbox lines');
  assert.equal(ctl.removed_inbox_lines, 1);
  assert.equal(JSON.parse(ctl.text).messages[p.userIdx].content.includes('gl hf'), false);
});

test('readChoice sorts the chosen ids; a changed params object is not a changed choice', () => {
  assert.deepEqual(readChoice('{"goal_id":"G1","choose":["c6","c3"],"params":{"c3":{"stance":"hold"}},"mem":["M4"],"why":"x"}').choose, ['c3', 'c6']);
  assert.ok(readChoice('not json').error);
  assert.ok(readChoice('{"choose":"c3"}').error);
});

test('the only allowed wording, and the featured-decision captions', () => {
  const w = allowedWording({ n: 3, k: 1, k_rerun: 0, k_control: 2 });
  assert.equal(w, 'when the Remembered lines were removed from 3 logged prompts, the chosen candidate changed in 1 (rerun: 0; control: 2)');
  for (const bad of ['because', 'improv', 'behaviour', 'remembers', 'wants']) assert.equal(w.includes(bad), false);
  assert.equal(decisionCaption(true), 'with this line removed, the choice changed');
  assert.equal(decisionCaption(false), 'with this line removed, the choice did not change');
  assert.equal(decisionCaption(true, { all: true }), 'with these lines removed, the choice changed');
  assert.equal(decisionCaption(false, { all: true }), 'with the Remembered lines removed, the choice did not change');
  assert.ok(!/because/.test(decisionCaption(false)));
  assert.equal(MIN_N, 40);
});

// ---- the probe end to end on a fake model ----------------------------------------------------------------------------
const choose = (ids, mem = []) => JSON.stringify({ goal_id: 'G2', choose: ids, params: {}, say: [], council: null, trust: [], mem, why: 'fake' });

function fakeModel({ ablateFlips = new Set(), controlFlips = new Set(), rerunFlips = new Set() } = {}) {
  const seen = [];
  const complete = async (text) => {
    const body = JSON.parse(text);
    const user = body.messages.at(-1).content;
    const id = [...requests].find((r) => JSON.parse(r.text).seed === body.seed)?.id;
    const hasMem = /^M\d+ \[bell/m.test(user);
    const edited = text !== requests.find((r) => r.id === id).text;
    const nRem = (user.match(/^M\d+ \[bell/gm) ?? []).length;
    const orig = parseBody(requests.find((r) => r.id === id).text).remembered.length;
    let c = ['c3'];
    let kind = 'rerun';
    if (edited && !hasMem) kind = 'ablated';
    else if (edited && nRem < orig) kind = 'control';
    if (kind === 'ablated' && ablateFlips.has(id)) c = ['c1'];
    if (kind === 'control' && controlFlips.has(id)) c = ['c1'];
    if (kind === 'rerun' && rerunFlips.has(id)) c = ['c1'];
    seen.push({ id, kind, text });
    return { content: choose(c, ['M1']), latency_ms: 5, finish_reason: 'stop' };
  };
  return { complete, seen };
}

test('runProbe: rerun is the stored body byte for byte; k, k_rerun and k_control are counted; the sentence is the allowed one', async () => {
  const eligible = requests.filter((r) => eligibility(parseBody(r.text)).eligible);
  const f40 = byPrefix('40bfe3dc').id;
  const m = fakeModel({ ablateFlips: new Set([f40]), controlFlips: new Set([]), rerunFlips: new Set([]) });
  // the stored records' choices differ from the fake's c3 for some bodies: give the probe records whose choice matches the fake
  const recs = new Map([...records].map(([k, v]) => [k, { ...v, output_hash: sha(choose(['c3'], ['M1'])), choice: { ...v.choice, ids: ['c3'], mem: [] } }]));
  const rep = await runProbe({ requests, records: recs, complete: m.complete, maxCalls: 20 });
  assert.equal(rep.dry_run, false);
  assert.equal(rep.eligible_prompts, 3);
  assert.equal(rep.summary.n, 3);
  assert.equal(rep.summary.k, 1);
  assert.equal(rep.summary.k_rerun, 0);
  assert.equal(rep.summary.underpowered, true);
  assert.equal(rep.calls_made, m.seen.length);
  assert.ok(rep.calls_made <= 9);
  // the rerun call carried the exact stored text
  for (const e of eligible) assert.ok(m.seen.some((s) => s.id === e.id && s.kind === 'rerun' && s.text === e.text), 'byte-identical rerun');
  assert.equal(rep.wording, allowedWording({ n: 3, k: 1, k_rerun: 0, k_control: rep.summary.k_control }));
  assert.ok(rep.not_shown.some((x) => /underpowered/.test(x)));
  const it = rep.items.find((x) => x.id === f40);
  assert.equal(it.rerun.same_bytes_as_stored, true);
  assert.equal(it.ablated.changed, true);
  assert.equal(it.baseline.source, 'stored output (the rerun reproduced it byte for byte)');
  assert.ok(it.cited_from === 'stored record');
  assert.deepEqual(it.cited_handles, []);
});

test('runProbe: a rerun that flips counts in k_rerun, and a control that flips in k_control (the baseline for "any edit changes the output")', async () => {
  const f40 = byPrefix('40bfe3dc').id;
  const fAdf = byPrefix('adf2b577').id;
  const m = fakeModel({ controlFlips: new Set([f40]) });
  const rep = await runProbe({ requests, records: new Map(), complete: m.complete, maxCalls: 20 });
  assert.equal(rep.summary.k_rerun, 0, 'no records: the baseline is the rerun itself, so a rerun cannot differ from it');
  assert.equal(rep.items.find((x) => x.id === f40).baseline.source, 'the rerun itself (no stored record)');
  assert.equal(rep.summary.k, 0);
  assert.equal(rep.summary.k_control, 1);
  const withRecs = new Map([...records].map(([k, v]) => [k, { ...v, output_hash: 'x', choice: { ...v.choice, ids: ['c3'] } }]));
  const rep2 = await runProbe({ requests, records: withRecs, complete: fakeModel({ rerunFlips: new Set([fAdf]) }).complete, maxCalls: 20 });
  assert.equal(rep2.summary.k_rerun, 1, 'against the stored final choice, one rerun differs');
  assert.equal(rep2.items.find((x) => x.id === fAdf).baseline.source, 'stored final choice (rerun not byte-equal; V3 may have dropped an id)');
});

test('runProbe stops at maxCalls and lists the prompts it did not reach', async () => {
  const m = fakeModel();
  const rep = await runProbe({ requests, records, complete: m.complete, maxCalls: 4 });
  assert.ok(rep.calls_made <= 4);
  assert.ok(rep.not_run.length >= 1);
  assert.equal(rep.summary.n, rep.items.filter((x) => x.ablated).length);
});

test('dry run: variants built, checked and counted; no model call', async () => {
  let called = false;
  const rep = await runProbe({ requests, records, complete: async () => { called = true; return {}; }, dry: true });
  assert.equal(called, false);
  assert.equal(rep.dry_run, true);
  assert.equal(rep.calls_made, 0);
  assert.equal(rep.eligible_prompts, 3);
  assert.equal(rep.planned_calls, 9, '3 prompts x (rerun, ablated, control)');
  for (const it of rep.items.filter((x) => x.eligible)) {
    assert.equal(it.ablation.outside_user_and_mem_equal, true);
    assert.equal(it.control.outside_user_and_mem_equal, true);
    assert.ok(it.ablation.diff.removed.length >= it.n_remembered);
    assert.ok(it.control.delta_tokens <= 0);
  }
  assert.equal('summary' in rep, false, 'a dry run states no k');
});

test('one-decision mode (b2): the three arms plus one single-line ablation per cited line', async () => {
  const f40 = byPrefix('40bfe3dc').id;
  const m = fakeModel({ ablateFlips: new Set([f40]) });
  const recs = new Map([...records].map(([k, v]) => [k, { ...v, output_hash: sha(choose(['c3'], ['M1'])), choice: { ...v.choice, ids: ['c3'] } }]));
  const rep = await runProbe({ requests, records: recs, complete: m.complete, decision: f40.slice(0, 10), maxCalls: 20 });
  assert.equal(rep.mode, 'one-decision');
  const it = rep.items.find((x) => x.id === f40);
  assert.deepEqual(it.single_line_ablations.map((s) => s.handle), ['M4', 'M5'], 'the cited lines');
  assert.equal(it.single_line_results.length, 2);
  assert.ok(it.single_line_results.every((r) => typeof r.caption === 'string' && !/because/.test(r.caption)));
  assert.deepEqual(rep.captions.single_line.map((c) => c.handle), ['M4', 'M5']);
  assert.equal(rep.captions.all_lines, 'with these lines removed, the choice changed', 'the fake flips the all-lines ablation of this decision');
  assert.equal(rep.captions.rerun_changed, false);
  assert.equal(rep.captions.control.changed, false);
  assert.equal(rep.planned_calls, 5);
  await assert.rejects(() => runProbe({ requests, records, complete: m.complete, decision: 'ffffffff' }), /no stored request/);
});
