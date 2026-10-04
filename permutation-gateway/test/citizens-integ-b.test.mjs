// integ-B: the wiring the wave-B units left to the integrator, at service level and across units.
//   1. the service builds AC8's season-end watcher: once the registrar's trigger STATE/season-end.json exists, PUB/full/index.json appears
//      (and no stub is reported), and the council page (AC7) and PUB (/h/ai/*) are served by the service's own serve.mjs;
//   2. an opening in the shape AC6's release job writes (destinations with `state`: revealed | unrevealed | not_sent) is read by AC8's M3
//      the same way as the shape of AC8's own buildOpening (`source`): timing and destination checks do not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCitizensService } from '../citizens/server.mjs';
import { createLlm } from '../citizens/mind/llm.mjs';
import { startFakeLlama, loadWireFixture, sessionAnswer, makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, CONFIG } from './fixtures/ai-mind-doubles.mjs';
import { makeCitizen, fakeHerald } from './fixtures/ai-social-kit.mjs';
import { verifyMinds } from '../citizens/verify-minds.mjs';
import { buildMiniRun } from './fixtures/ai-audit-mini.mjs';

const { json: wire } = loadWireFixture();
const SEASON = 31;
const GENESIS = 1_800_000_000;

async function boot() {
  const aiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-integ-b-'));
  fs.mkdirSync(path.join(aiDir, 'pub'), { recursive: true });
  const a = makeCitizen('ai-a', { faction: 0 });
  const b = makeCitizen('ai-b', { faction: 0 });
  const roster = makeRosterJson({ n: 3 });
  roster.ai[0].wallet = a.b58;
  roster.ai[1].wallet = b.b58;
  roster.season = SEASON;
  fs.writeFileSync(path.join(aiDir, 'pub/roster.json'), JSON.stringify(roster));
  const llama = await startFakeLlama({ respond: bd => sessionAnswer(bd, { kinds: ['build'], say: [], why: 'Building suits goal G1.' }) });
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: SEASON, genesisTs: GENESIS },
    {
      test: true, noCloserTimer: true, config: { ...CONFIG, channel_lang: 'en', audit: { poll_ms: 40 } }, stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble,
      personaOf: personaOfDouble, nameOf: nameOfDouble, feed: { cursorBell: () => null, wakeEvents: () => [] }, llm: createLlm({ url: llama.url }), socialHerald: fakeHerald([a, b]),
    },
  );
  return { aiDir, roster, a, llama, svc, async close() { await svc.close(); await llama.close(); } };
}

test('the service builds the season-end watcher: the registrar\'s trigger makes PUB/full appear once, and the page and PUB are served', async () => {
  const h = await boot();
  try {
    assert.ok(h.svc.audit, 'createAudit is built');
    assert.ok(!h.svc.stubs.includes('audit'));
    assert.equal(fs.existsSync(path.join(h.aiDir, 'pub/full/index.json')), false, 'nothing is published before the trigger');
    fs.writeFileSync(path.join(h.aiDir, 'state/season-end.json'), `${JSON.stringify({ v: 1, season: SEASON, last_bell: 41, requested_unix: 1 })}\n`);
    let idx = null;
    for (let i = 0; i < 100 && !idx; i++) { await new Promise(r => setTimeout(r, 40)); try { idx = JSON.parse(fs.readFileSync(path.join(h.aiDir, 'pub/full/index.json'), 'utf8')); } catch { /* not yet */ } }
    assert.ok(idx, 'PUB/full/index.json was written by the service itself');
    assert.equal(idx.season, SEASON);
    assert.equal(idx.last_bell, 41);
    assert.equal(idx.forced, false);
    // the council page and PUB through serve.mjs (same origin)
    const base = `http://127.0.0.1:${h.svc.serve.port}`;
    const page = await fetch(`${base}/council.html`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>[^<]*<\/title>/);
    assert.equal((await fetch(`${base}/council/main.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/council/council.css`)).status, 200);
    const r = await fetch(`${base}/h/ai/roster.json`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).season, SEASON);
    const fi = await fetch(`${base}/h/ai/full/index.json`);
    assert.equal(fi.status, 200, 'the season-end bundle is public once written');
    assert.match(fi.headers.get('cache-control'), /max-age=2$/);
  } finally {
    await h.close();
  }
});

test('a model decision stores its exact retrieval focus privately (priv.focus), so the season-end bundle can give M11 an exact replay', async () => {
  const h = await boot();
  try {
    const r = JSON.parse(JSON.stringify(wire.request));
    r.deadline_unix_ms = Date.now() + 60_000;
    r.ai = { index: h.roster.ai[0].index, tag: h.roster.ai[0].tag, wallet: h.a.b58 };
    const d = await h.svc.mind.decide(r);
    assert.equal(d.mode, 'model');
    const e = h.svc.records.getPrivate(d.decision_id);
    assert.ok(Array.isArray(e.priv.focus) && e.priv.focus.length >= 3, `focus: ${JSON.stringify(e.priv.focus)}`);
    assert.ok(e.priv.focus.includes(h.roster.ai[0].tag), 'the AI\'s own tag is in the focus');
    assert.deepEqual([...e.priv.focus], [...e.priv.focus].sort(), 'sorted, as memory.focusOf returns it');
    assert.equal(JSON.stringify(h.svc.records.open?.(d.decision_id) ?? null).includes('"focus"'), false, 'an opening never carries the focus');
  } finally {
    await h.close();
  }
});

test('the service\'s permission flags let serve.mjs read the page shell: under the flags GET /council.html is 200 (live: it was 404 because the file was not on the read list)', async () => {
  const { execFileSync, spawn } = await import('node:child_process');
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const flags = execFileSync(process.execPath, [path.join(repo, 'permutation-gateway/citizens/server.mjs'), '--print-permission-flags', '--ai-dir', '/tmp/x-ai'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(flags.some(f => f.endsWith('web/frontier/council.html')), 'council.html is on the read list');
  // a process under the same flags reads the file (probe-only mode of server.mjs)
  const out = execFileSync(process.execPath, [...flags, path.join(repo, 'permutation-gateway/citizens/server.mjs'), '--probe-only', '--probe-paths', path.join(repo, 'permutation-server/web/frontier/council.html')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  assert.equal(Object.values(JSON.parse(out).probe)[0], 'READ');
});

// ---- AC6 opening shape through AC8's M3 ------------------------------------------------------------------------------------------
const rj = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const cp = (from, to) => { if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n)); } else fs.copyFileSync(from, to); };

test('M3 reads the destinations of AC6\'s release job (state: revealed | unrevealed | not_sent) like AC8\'s own (source: reveal | unrevealed)', async () => {
  const run = await buildMiniRun({ council: false });
  try {
    const verify = async edit => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-integ-b-m3-'));
      try {
        cp(run.pub, path.join(dir, 'pub'));
        cp(run.state, path.join(dir, 'state'));
        for (const f of ['stack.toml', 'ai-slots.json']) fs.copyFileSync(path.join(run.aiDir, f), path.join(dir, f));
        edit(path.join(dir, 'pub'));
        return await verifyMinds({ ...run.verifyOpts({ only: ['M3'] }), aiDir: path.join(dir, 'pub') });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const base = await verify(() => {});
    assert.equal(base.checks.M3.pass, true, JSON.stringify(base.checks.M3.failures.slice(0, 3)));
    // AC6's vocabulary: `state` instead of `source` (revealed destinations keep p, q, tile and both arrival bells)
    const converted = await verify(pub => {
      for (const n of fs.readdirSync(path.join(pub, 'open')).filter(f => /^\d+\.json$/.test(f))) {
        const f = path.join(pub, 'open', n);
        const j = rj(f);
        for (const r of j.records) r.destinations = r.destinations.map(({ source, ...x }) => ({ ...x, state: source === 'reveal' ? 'revealed' : source }));
        fs.writeFileSync(f, JSON.stringify(j));
      }
    });
    assert.equal(converted.checks.M3.pass, true, JSON.stringify(converted.checks.M3.failures.slice(0, 3)));
    assert.equal(converted.checks.M3.openings_checked_for_timing, base.checks.M3.openings_checked_for_timing);
    // a destination that AC6 says was revealed but the chain does not show must still fail (the state is not a free pass)
    const wrong = await verify(pub => {
      const n = fs.readdirSync(path.join(pub, 'open')).filter(f => /^\d+\.json$/.test(f))[0];
      const f = path.join(pub, 'open', n);
      const j = rj(f);
      const d = j.records[0].destinations[0];
      d.state = 'revealed'; delete d.source; d.tile = (d.tile + 1) % 100;
      fs.writeFileSync(f, JSON.stringify(j));
    });
    assert.ok(wrong.checks.M3.failures.some(x => x.code === 'destination_mismatch'), 'a revealed destination is still compared with the public REVEAL');
    // a march the brain never sent (AC6: state not_sent, arrive_bell null, destination "not_sent") is due at release_bell and has nothing to reveal
    const notSent = await verify(pub => {
      const n = fs.readdirSync(path.join(pub, 'open')).filter(f => /^\d+\.json$/.test(f))[0];
      const f = path.join(pub, 'open', n);
      const j = rj(f);
      const r = j.records[0];
      r.destinations = r.destinations.map(d => ({ host_id: d.host_id, planned_arrive_bell: d.planned_arrive_bell, via: 'model', state: 'not_sent', destination: 'not_sent', arrive_bell: null }));
      fs.writeFileSync(f, JSON.stringify(j));
    });
    const bad = notSent.checks.M3.failures.map(x => x.code);
    assert.ok(!bad.includes('destination_unrevealed') && !bad.includes('destination_mismatch'), `not_sent is not compared with a REVEAL: ${bad}`);
  } finally { await run.close(); }
});

test('the report reads the brain\'s GET counters named gets:* (the colon form) and no_session', async () => {
  const { brainSection } = await import('../citizens/report.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-integ-b-brain-'));
  fs.writeFileSync(path.join(dir, 'ai-brain.json'), JSON.stringify({ counters: { steps: 100, no_session: 10, 'gets:me': 90, 'gets:digest': 300, 'gets:reobserve': 60, answers_model: 5, answers_autopilot: 85 } }));
  const b = brainSection(dir, { records: new Array(90).fill(0), aiByTag: new Map() });
  assert.equal(b.gets_per_step.gets, 450);
  assert.equal(b.gets_per_step.per_step, 4.5);
  assert.equal(b.no_session, 10);
  assert.equal(b.steps_equal_records_plus_no_session, true);
  assert.equal(b.gets_note, null);
});
