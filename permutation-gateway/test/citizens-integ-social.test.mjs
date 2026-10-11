// integ-A (second half): the wiring of the real social store (AC4), the real speech checker and sanitiser (AC1b) and the
// reflection job into the citizens service (server.mjs), against the mind's records (AC1a). The model is a fake
// llama-server on 127.0.0.1:0 and the herald is a `me(wallet)` double (the social kit of AC4); everything else on the
// path is the shipped code: createSocial through server.mjs, mind/speech.mjs, mind/sanitize.mjs, mind/wiring.mjs.
// What it establishes: what the mind hands the brain (say, motion, ballot) is accepted by the store when signed with the
// citizen's session key (provenance equal), once only, and what the store holds comes back into the next prompt through
// the hall; a tampered text is refused as NotFromMind; the ballot of a council call is accepted with the period's
// candidates_hash; the public views hand the prompt no ballot. It does not establish anything about the Rust brain's
// signing (that is the byte vectors, ai_social_vectors.rs) or about a live herald.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCitizensService } from '../citizens/server.mjs';
import { createLlm } from '../citizens/mind/llm.mjs';
import { encodeBallot, encodeTalk, toBase64 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import {
  startFakeLlama, loadWireFixture, sessionAnswer, makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, CONFIG, TAGS,
} from './fixtures/ai-mind-doubles.mjs';
import { makeCitizen, fakeHerald, OPTIONS } from './fixtures/ai-social-kit.mjs';

const { json: wire } = loadWireFixture();
const SEASON = 31;
const GENESIS = 1_800_000_000; // the wire request's now_game 1800024100 is bell 40

const say = (text) => [{ channel: 'nation', text }];
const answerFor = (b, n) => {
  const props = b.response_format.json_schema.schema.properties;
  if (props.council?.properties?.ballot) return { goal_id: 'G1', choose: [], params: {}, say: [], council: { ballot: 2 }, trust: [], mem: [], why: 'Option two fits goal G1.' };
  if (props.council?.properties?.motion) return { goal_id: 'G1', choose: [], params: {}, say: say('Option two is within reach.'), council: { motion: 2 }, trust: [], mem: [], why: 'Option two fits goal G1.' };
  const who = n === 0 ? 'a' : 'b'; // the first session call is AI a's, the next AI b's (b repeating a's line would be refused as an echo of untrusted text: V5)
  return sessionAnswer(b, { kinds: ['build'], say: say(who === 'a' ? 'Our granaries are filling.' : 'Wood is plentiful.'), why: 'Building suits goal G1.' });
};

async function boot() {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-integ-social-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  const a = makeCitizen('ai-a', { faction: 0 });
  const b = makeCitizen('ai-b', { faction: 0 });
  const roster = makeRosterJson({ n: 3 });
  roster.ai[0].wallet = a.b58;
  roster.ai[1].wallet = b.b58;
  roster.season = SEASON;
  writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(roster));
  const llama = await startFakeLlama({ respond: answerFor });
  const herald = fakeHerald([a, b]);
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: SEASON, genesisTs: GENESIS },
    {
      test: true, noCloserTimer: true, config: { ...CONFIG, channel_lang: 'en' }, stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble,
      personaOf: personaOfDouble, nameOf: nameOfDouble, feed: { cursorBell: () => null, wakeEvents: () => [] }, llm: createLlm({ url: llama.url }), socialHerald: herald,
    },
  );
  const req = (who) => {
    const r = JSON.parse(JSON.stringify(wire.request));
    r.deadline_unix_ms = Date.now() + 60_000;
    if (who === 'b') r.ai = { index: roster.ai[1].index, tag: roster.ai[1].tag, wallet: b.b58 };
    else r.ai = { index: roster.ai[0].index, tag: roster.ai[0].tag, wallet: a.b58 };
    return r;
  };
  const post = (path, body) => fetch(`http://127.0.0.1:${svc.ports.social}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const signTalk = (c, it, over = {}) => {
    const bytes = encodeTalk({ season: SEASON, wallet: c.wallet, bell: it.bell, seq: it.seq, channel: it.channel, target: it.target, kind: it.kind, ref: it.ref, origin: 1, lang: it.lang, text: it.text, ...over });
    return { bytes_b64: toBase64(bytes), sig_b64: toBase64(c.key.sign(bytes)) };
  };
  return { aiDir, a, b, roster, llama, svc, req, post, signTalk, async close() { await svc.close(); await llama.close(); } };
}

test('the service builds the real social store, the real speech checker, the reflection job; no stub is left (the wave-B watcher is real)', async () => {
  const h = await boot();
  try {
    assert.equal(h.svc.social.stub, undefined, 'AC4 store, not the stub');
    assert.equal(typeof h.svc.social.book.submit, 'function');
    assert.deepEqual(h.svc.stubs, []);
    assert.ok(h.svc.reflection, 'AC1b reflection job is created');
    assert.equal((await h.svc.mind.health()).speech, 'real');
    assert.equal(typeof h.svc.mind.metrics().speech.reasons, 'object', 'per-word withhold counts reach /v1/metrics');
    assert.ok(h.svc.ports.social > 0, 'the social API listens');
  } finally {
    await h.close();
  }
});

test('say: what the mind hands out is accepted once when signed, comes back through the hall into the next prompt, and a tampered text is NotFromMind', async () => {
  const h = await boot();
  try {
    const d = await h.svc.mind.decide(h.req('a'));
    assert.equal(d.mode, 'model');
    assert.equal(d.social.say.length, 1);
    const it = d.social.say[0];
    assert.equal(it.season, SEASON, 'the mind signs for the stack\'s season (the run script passes --season)');
    const ok = await h.post('/f/ai/talk', { ...h.signTalk(h.a, it), decision_id: d.decision_id, item: it.item });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const again = await h.post('/f/ai/talk', { ...h.signTalk(h.a, it), decision_id: d.decision_id, item: it.item });
    assert.ok(['SeqReplay', 'Duplicate'].includes(again.json.code), `a replay is refused (the store checks seq first): ${again.json.code}`);
    // the store's own file for the bell (what the registrar anchors)
    const closed = h.svc.social.closeBell(40);
    assert.equal(closed.count, 1);
    const file = JSON.parse(readFileSync(join(h.aiDir, 'pub/talk/40.json'), 'utf8'));
    assert.equal(file.records.length, 1);
    assert.match(file.root, /^[0-9a-f]{64}$/);
    // the views the next prompt reads
    const hall = h.svc.social.read.hall(0, 5);
    assert.equal(hall.length, 1);
    assert.equal(hall[0].text, 'Our granaries are filling.');
    assert.equal(hall[0].tag, TAGS[0]);
    assert.equal(hall[0].channel, 1);
    const db = await h.svc.mind.decide(h.req('b'));
    const prompt = h.llama.bodies.at(-1).messages[1].content;
    assert.match(prompt, /Our granaries are filling\./, 'the other AI of the nation reads it in its hall');
    assert.match(prompt, /<untrusted from=/, 'wrapped as data');
    // AC4's rows carry name as {en, ja}: the prompt shows the roster name, never an object
    assert.doesNotMatch(prompt, /object Object/);
    const senderName = h.svc.social.read.hall(0, 5)[0].name;
    assert.equal(typeof senderName, 'object', 'the real store returns {en, ja}');
    assert.ok(prompt.includes(`<untrusted from="${senderName.en} (C1)"`) || prompt.includes(`from="${senderName.en}`), `the sender's name is in the attribute: ${prompt.match(/<untrusted from="[^"]*"/)?.[0]}`);
    // a tampered text is refused: the record is not what the mind produced
    const ib = db.social.say[0];
    const bad = await h.post('/f/ai/talk', { ...h.signTalk(h.b, ib, { text: `${ib.text}!` }), decision_id: db.decision_id, item: ib.item });
    assert.equal(bad.json.code, 'NotFromMind');
    const good = await h.post('/f/ai/talk', { ...h.signTalk(h.b, ib), decision_id: db.decision_id, item: ib.item });
    assert.equal(good.status, 200, JSON.stringify(good.json));
    // a decision id the mind never issued
    const forged = await h.post('/f/ai/talk', { ...h.signTalk(h.b, { ...ib, seq: ib.seq + 1 }), decision_id: 'f'.repeat(64), item: 0 });
    assert.equal(forged.json.code, 'NotFromMind');
  } finally {
    await h.close();
  }
});

test('a human-style record (origin 0) of an AI wallet is refused; an AI record without decision_id is refused', async () => {
  const h = await boot();
  try {
    const d = await h.svc.mind.decide(h.req('a'));
    const it = d.social.say[0];
    const o0 = await h.post('/f/ai/talk', { ...h.signTalk(h.a, it, { origin: 0 }), decision_id: d.decision_id, item: it.item });
    assert.equal(o0.json.code, 'NotFromMind');
    const none = await h.post('/f/ai/talk', h.signTalk(h.a, it));
    assert.equal(none.json.code, 'NotFromMind');
  } finally {
    await h.close();
  }
});

test('council: a motion in the motion window and a ballot in the ballot window are accepted with the mind\'s provenance; the public view carries no ballot', async () => {
  const h = await boot();
  try {
    await h.svc.mind.decide(h.req('a')); // the mind needs the AI's last situation for a council call
    await h.svc.mind.decide(h.req('b'));
    const dl = Date.now() + 60_000;
    // period 1 is in its ballot window at bell 40 (C0 = 37); period 2 in its motion window (C0 = 40)
    h.svc.social.council.open({ faction: 0, period: 1, c0: 37, candidates: OPTIONS });
    h.svc.social.council.open({ faction: 0, period: 2, c0: 40, candidates: OPTIONS });
    const ba = await h.svc.mind.councilCall({ tag: TAGS[0], kind: 'ballot', period: 1, bell: 40, deadline_unix_ms: dl });
    assert.equal(ba.mode, 'model', JSON.stringify(ba));
    const bl = ba.social.ballot;
    assert.equal(typeof bl.candidates_hash, 'string', 'the mind hands the brain the period\'s candidates_hash');
    const bytes = encodeBallot({ season: SEASON, period: bl.period, wallet: h.a.wallet, faction: bl.faction, option: bl.option, candidates_hash: bl.candidates_hash, nonce: bl.nonce, origin: 1 });
    const pb = await h.post('/f/ai/ballot', { bytes_b64: toBase64(bytes), sig_b64: toBase64(h.a.key.sign(bytes)), decision_id: ba.decision_id, item: bl.item });
    assert.equal(pb.status, 200, JSON.stringify(pb.json));
    // the ballot is hidden: only the count is public
    const pub = h.svc.social.read.council(0);
    assert.equal(pub.period, 2, 'the latest period');
    const p1 = h.svc.social.council.publicState(0, 1);
    assert.equal(p1.ballots_cast, 1);
    assert.deepEqual(p1.ballots, []);
    assert.equal('ballots' in h.svc.social.read.council(0), false);
    assert.equal('tally_split' in h.svc.social.read.council(0), false);
    // a motion by the other AI
    const ma = await h.svc.mind.councilCall({ tag: TAGS[1], kind: 'motion', period: 2, bell: 40, deadline_unix_ms: dl });
    assert.equal(ma.mode, 'model', JSON.stringify(ma));
    const m = ma.social.motion;
    assert.deepEqual([m.kind, m.channel, m.ref], [1, 1, 2 * 256 + 2]);
    const pm = await h.post('/f/ai/talk', { ...h.signTalk(h.b, m), decision_id: ma.decision_id, item: m.item });
    assert.equal(pm.status, 200, JSON.stringify(pm.json));
    const st = h.svc.social.read.council(0);
    assert.equal(st.motions.length, 1);
    assert.equal(st.motions[0].tag, TAGS[1]);
    assert.equal(st.motions[0].option, 2);
    // the council file the page reads exists and was rewritten by the store (cache rule: short lifetime, see serve.mjs)
    assert.ok(existsSync(join(h.aiDir, 'pub/council/2-0.json')));
  } finally {
    await h.close();
  }
});

test('through serve.mjs (what the brain talks to on 41902): /f/ai/talk and /gw/f/ai/council reach the social store, and the council file is not cached as immutable', async () => {
  const h = await boot();
  try {
    assert.ok(h.svc.serve?.port > 0, 'serve.mjs listens');
    const base = `http://127.0.0.1:${h.svc.serve.port}`;
    const d = await h.svc.mind.decide(h.req('a'));
    const it = d.social.say[0];
    const r = await fetch(`${base}/f/ai/talk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...h.signTalk(h.a, it), decision_id: d.decision_id, item: it.item }) });
    assert.equal(r.status, 200, await r.text());
    const c = await fetch(`${base}/gw/f/ai/council?faction=0`);
    assert.equal(c.status, 200);
    assert.equal((await c.json()).state, 'none');
    h.svc.social.council.open({ faction: 0, period: 2, c0: 40, candidates: OPTIONS });
    const f = await fetch(`${base}/h/ai/council/2-0.json`);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('cache-control'), 'public, max-age=2', 'a council file is rewritten up to six times per period');
    h.svc.social.closeBell(40);
    const t = await fetch(`${base}/h/ai/talk/40.json`);
    assert.equal(t.status, 200);
    assert.equal(t.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await t.json()).records.length, 1);
  } finally {
    await h.close();
  }
});
