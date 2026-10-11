// AC10a, rulings R5 and R6 (contract v1.3 sections 3.1, 4.3, 7.2, 10.1): the brain's `no_session` count and its GETs-per-step counters
// reach GET /v1/metrics and PUB/metrics/latest.json (the report's inputs). The brain (bots/src/ai) posts cumulative counters per AI to
// POST /v1/brain-stats; the mind keeps the latest per AI and reports them per AI (by tag) and in total. The Rust side of the wire is
// tested in frontier-node/crates/bots/tests/ai_brain_stats.rs against a fake mind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCitizensService } from '../citizens/server.mjs';
import { makeMindHarness, makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, makeSpeech, makeSocial, loadWireFixture, sessionAnswer, startFakeLlama, CONFIG, TAGS } from './fixtures/ai-mind-doubles.mjs';

const { json: wire } = loadWireFixture();
const post = (h, body) => h.mind.brainStats(body);
const AI0 = 3; // makeRosterJson({n:3}) gives indices 3, 4, 5
const base = (over = {}) => ({ v: 1, index: AI0, bell: 50, counters: { steps: 20, no_session: 4, 'no_session:no_home': 3, 'no_session:no_session': 1, 'gets:me': 16, 'gets:digest': 40, 'gets:recall_events': 8, 'gets:reobserve_provinces': 24, reobserved: 6 }, ...over });

test('R5/R6: posted counters come back in /v1/metrics per AI (by tag) and in total, with GETs per step and the no_session share', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    assert.deepEqual(h.mind.metrics().brain ?? null, null, 'nothing before the first post');
    assert.deepEqual(post(h, base()), { ok: true, applied: true });
    post(h, base({ index: AI0 + 1, counters: { steps: 10, no_session: 0, 'gets:me': 10, 'gets:digest': 10 } }));
    const m = h.mind.metrics().brain;
    assert.equal(m.ais_reporting, 2);
    assert.equal(m.posts, 2);
    const a = m.per_ai[TAGS[0]];
    assert.equal(a.steps, 20);
    assert.equal(a.no_session, 4);
    assert.equal(a.gets_total, 16 + 40 + 8 + 24);
    assert.equal(a.gets_per_step, 4.4);
    assert.equal(m.per_ai[TAGS[1]].gets_per_step, 2);
    assert.equal(m.totals.steps, 30);
    assert.equal(m.totals.no_session, 4);
    assert.equal(m.totals.no_session_share, 0.133);
    assert.equal(m.totals.gets_total, 88 + 20);
    assert.equal(m.totals.gets_per_step, 3.6);
    assert.equal(m.totals['no_session:no_home'], 3);
    assert.match(m.note, /lower bounds/);
  } finally { await h.close(); }
});

test('R5/R6: the latest cumulative post replaces the earlier one; a stale post (fewer steps) is ignored and counted', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    post(h, base());
    assert.deepEqual(post(h, base({ counters: { steps: 25, no_session: 6, 'gets:me': 20 } })), { ok: true, applied: true });
    assert.equal(h.mind.metrics().brain.per_ai[TAGS[0]].steps, 25);
    assert.equal(h.mind.metrics().brain.per_ai[TAGS[0]].gets_total, 20, 'replaced, not added: counters are cumulative');
    assert.deepEqual(post(h, base({ counters: { steps: 24, no_session: 5 } })), { ok: true, applied: false });
    assert.equal(h.mind.metrics().brain.per_ai[TAGS[0]].steps, 25);
    assert.equal(h.metrics.get('brain_stats_stale'), 1);
  } finally { await h.close(); }
});

test('R5/R6: a malformed post is refused (version, index, counters object, names, values, count, unknown AI)', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    const err = (b, status, re) => assert.throws(() => post(h, b), (e) => e.status === status && re.test(e.message), JSON.stringify(b).slice(0, 80));
    err(null, 400, /v: 1/);
    err({ ...base(), v: 2 }, 400, /v: 1/);
    err({ ...base(), index: '3' }, 400, /index/);
    err({ ...base(), counters: [1] }, 400, /counters/);
    err({ ...base(), counters: null }, 400, /counters/);
    err({ ...base(), counters: { 'Bad Name': 1 } }, 400, /not allowed/);
    err({ ...base(), counters: { '__proto__x': 1 } }, 400, /not allowed/);
    err({ ...base(), counters: { steps: -1 } }, 400, /non-negative integer/);
    err({ ...base(), counters: { steps: 1.5 } }, 400, /non-negative integer/);
    err({ ...base(), counters: { steps: '3' } }, 400, /non-negative integer/);
    err({ ...base(), counters: Object.fromEntries(Array.from({ length: 97 }, (_, i) => [`k${i}`, 1])) }, 400, /at most 96/);
    err({ ...base(), index: 99 }, 404, /no AI citizen/);
    assert.equal(h.mind.metrics().brain ?? null, null, 'nothing was stored');
  } finally { await h.close(); }
});

test('R5/R6: counter names that are also Object.prototype names do not corrupt the totals', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    post(h, base({ counters: { steps: 2, constructor: 3, valueof: 1, tostring: 2 } }));
    post(h, base({ index: AI0 + 1, counters: { steps: 2, constructor: 4 } }));
    const t = h.mind.metrics().brain.totals;
    assert.equal(t.constructor, 7);
    assert.equal(t.steps, 4);
    assert.equal(t.valueof, 1);
  } finally { await h.close(); }
});

// ---- over HTTP, in the running service, down to PUB/metrics/latest.json ---------------------------------------------------------
async function start() {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-brainstats-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(makeRosterJson({ n: 3 })));
  const llama = await startFakeLlama({ respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: llama.url, mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: 31, genesisTs: 1800000000 },
    { test: true, noCloserTimer: true, config: CONFIG, speech: makeSpeech(), stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble, personaOf: personaOfDouble, nameOf: nameOfDouble, social: makeSocial(), feed: { cursorBell: () => null, wakeEvents: () => [] } },
  );
  return { svc, aiDir, llama };
}
const call = async (svc, path, { method = 'GET', body, token = svc.token } = {}) => {
  const r = await fetch(`http://127.0.0.1:${svc.ports.mind}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test('R5/R6 over HTTP: the route needs the bearer token, answers {ok, applied}, and /v1/metrics and PUB/metrics/latest.json carry the brain block', async () => {
  const { svc, aiDir, llama } = await start();
  try {
    assert.equal((await call(svc, '/v1/brain-stats', { method: 'POST', body: base(), token: 'wrong' })).status, 401);
    assert.equal((await call(svc, '/v1/brain-stats', { method: 'POST', body: base(), token: null })).status, 401);
    const ok = await call(svc, '/v1/brain-stats', { method: 'POST', body: base() });
    assert.deepEqual([ok.status, ok.json], [200, { ok: true, applied: true }]);
    assert.equal((await call(svc, '/v1/brain-stats', { method: 'POST', body: base({ index: 77 }) })).status, 404);
    assert.equal((await call(svc, '/v1/brain-stats', { method: 'POST', body: { v: 1, index: AI0, counters: { 'x y': 1 } } })).status, 400);
    const m = await call(svc, '/v1/metrics');
    assert.equal(m.json.brain.per_ai[TAGS[0]].no_session, 4);
    assert.equal(m.json.brain.totals.gets_per_step, 4.4);
    // a decision still works beside it, and the bell closer writes the same block to the report's input file
    const r = JSON.parse(JSON.stringify(wire.request));
    r.deadline_unix_ms = Date.now() + 60000;
    assert.equal((await call(svc, '/v1/decide', { method: 'POST', body: r })).status, 200);
    await svc.closer.tick(Date.now() + 700_000);
    const latest = JSON.parse(readFileSync(join(aiDir, 'pub/metrics/latest.json'), 'utf8'));
    assert.equal(latest.brain.per_ai[TAGS[0]].gets_total, 88);
    assert.equal(latest.brain.totals.no_session_share, 0.2);
    assert.equal(latest.counters.decisions_model, 1);
  } finally { await svc.close(); await llama.close(); }
});
