// AC6: the real watcher inside the citizens service (server.mjs) with the real mind (fake llama-server), the real social store (AC4), the real
// records (AC1a) and the real speech checker (AC1b). The feed, the owners and the herald province files are doubles in the real shapes
// (SYNTHETIC: test/fixtures/ai-watcher-kit.mjs). What it establishes, end to end and under the service's own wiring:
//   - no stub is left; the social store's `fixCall` reaches the watcher; the council opens at C0 from the files of bell C0 - 2,
//   - the AIs' motion and ballot (council calls through the mind) reach the brain with its next decide answer, and the store accepts them when
//     the brain signs them under that answer's decision id (provenance through the outbox),
//   - the Strike Order is adopted, sealed with a tile and an invited list, wakes the AIs (W-CALL), is opened at S + 2 with a result,
//   - a decision made under it is sealed and released at S + 2 into PUB/open/<bell>.json,
//   - the chronicle carries code numbers only (no model text, no target in call_adopted), the cards and the events files exist.
// It does not establish anything about the Rust brain's own post (that is ai_social_post.rs against a fake) or about a live herald.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCitizensService } from '../citizens/server.mjs';
import { createLlm } from '../citizens/mind/llm.mjs';
import { encodeBallot, encodeTalk, toBase64 } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { startFakeLlama, loadWireFixture, sessionAnswer, makeStores, makeEpisode, makeRosterJson, renderMemoryDouble, renderPersonaDouble, personaOfDouble, nameOfDouble, CONFIG, TAGS } from './fixtures/ai-mind-doubles.mjs';
import { makeCitizen, fakeHerald } from './fixtures/ai-social-kit.mjs';
import { fakeFeed, fakeOwners, host, province } from './fixtures/ai-watcher-kit.mjs';
import { ball } from '../citizens/watcher/council_gen.mjs';

const { json: wire } = loadWireFixture();
const SEASON = 31;
const GENESIS = 1_800_000_000;
const C0 = 48;
const S = C0 + 12;
const MARKER = 'Option two is within reach.';

const answerFor = b => {
  const props = b.response_format.json_schema.schema.properties;
  if (props.council?.properties?.ballot) return { goal_id: 'G1', choose: [], params: {}, say: [], council: { ballot: 2 }, trust: [], mem: [], why: 'Option two fits goal G1.' };
  if (props.council?.properties?.motion) return { goal_id: 'G1', choose: [], params: {}, say: [{ channel: 'nation', text: MARKER }], council: { motion: 2 }, trust: [], mem: [], why: 'Option two fits goal G1.' };
  return sessionAnswer(b, { kinds: ['build'], say: [], why: 'Building suits goal G1.' });
};

async function boot() {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-watcher-service-'));
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
  // nation 0: ai-a holds (0,0) and (1,0), ai-b holds (0,1): three villages within two provinces of each other
  const owners = fakeOwners({
    citizens: [
      { tag: TAGS[0], faction: 0, kind: 'ai', wallet: a.b58, holdings: [{ p: 0, q: 0, site: 0, final: true }, { p: 1, q: 0, site: 1, final: true }] },
      { tag: TAGS[1], faction: 0, kind: 'ai', wallet: b.b58, holdings: [{ p: 0, q: 1, site: 2, final: true }] },
    ],
  });
  const feed = fakeFeed({ owners, through: 300, head: 300 });
  for (const t of [TAGS[0], TAGS[1]]) feed.addEvent({ kind: 'SETTLE', bell: 3, seq: t, citizen: t, displaced: null });
  const own = host({ id: 7001, owner: TAGS[0], faction: 0, tile: 30, troops: 300 });
  owners.citizenOfHost = id => (String(id) === '7001' ? TAGS[0] : null);
  // the files of bell C0 - 2 = 46: a camp at (2,0) (value 100) and a stack of nation 3 at (0,1) (value 100); the files of bell C0 + 5 = 53 for the Call
  for (const bell of [C0 - 2, C0 + 5]) {
    feed.files.set(`2,0,${bell}`, province({ p: 2, q: 0, bell, camp: { tile: 44, troops: 200 } }));
    feed.files.set(`0,1,${bell}`, province({ p: 0, q: 1, bell, hosts: [host({ faction: 3, tile: 20, troops: 100 })] }));
    feed.files.set(`1,0,${bell}`, province({ p: 1, q: 0, bell, hosts: [own] }));
  }
  // every other province around exists and is served (empty), as inside the map: a missing file then means "not served yet"
  for (const bell of [C0 - 2, C0 + 5]) for (const c of ball(0, 0, 5)) if (!feed.files.has(`${c.p},${c.q},${bell}`)) feed.files.set(`${c.p},${c.q},${bell}`, province({ p: c.p, q: c.q, bell }));
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: SEASON, genesisTs: GENESIS },
    {
      test: true, noCloserTimer: true, config: { ...CONFIG, channel_lang: 'en' }, stores: makeStores({ episodes: [makeEpisode(1)] }), renderMemory: renderMemoryDouble, renderPersona: renderPersonaDouble,
      personaOf: personaOfDouble, nameOf: nameOfDouble, feed, llm: createLlm({ url: llama.url }), socialHerald: herald,
    },
  );
  const req = (who, bell) => {
    const r = JSON.parse(JSON.stringify(wire.request));
    r.bell = bell;
    r.now_game = GENESIS + bell * 600 + 60;
    r.deadline_unix_ms = Date.now() + 60_000;
    r.ai = who === 'b' ? { index: roster.ai[1].index, tag: roster.ai[1].tag, wallet: b.b58 } : { index: roster.ai[0].index, tag: roster.ai[0].tag, wallet: a.b58 };
    return r;
  };
  const post = (path, body) => fetch(`http://127.0.0.1:${svc.ports.social}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, json: await r.json() }));
  const signTalk = (c, it) => {
    const bytes = encodeTalk({ season: SEASON, wallet: c.wallet, bell: it.bell, seq: it.seq, channel: it.channel, target: it.target, kind: it.kind, ref: it.ref, origin: 1, lang: it.lang, text: it.text });
    return { bytes_b64: toBase64(bytes), sig_b64: toBase64(c.key.sign(bytes)) };
  };
  const signBallot = (c, bl) => {
    const bytes = encodeBallot({ season: SEASON, period: bl.period, wallet: c.wallet, faction: bl.faction, option: bl.option, candidates_hash: bl.candidates_hash, nonce: bl.nonce, origin: 1 });
    return { bytes_b64: toBase64(bytes), sig_b64: toBase64(c.key.sign(bytes)) };
  };
  const settle = async () => { for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 25)); if (svc.watcher.stats().outbox.pending >= 2) return; } };
  return { aiDir, a, b, roster, llama, svc, feed, req, post, signTalk, signBallot, settle, async close() { svc.watcher.stop(); await svc.close(); await llama.close(); } };
}
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

test('the service loads the real watcher (no stub), wires the social store\'s fixCall to it, and the watcher answers the pinned interface', async () => {
  const h = await boot();
  try {
    assert.deepEqual(h.svc.stubs, []);
    assert.equal(h.svc.watcher.stub, false);
    for (const f of ['wakeEvents', 'councilCandidates', 'closeCall', 'result', 'releaseDue', 'start', 'stop']) assert.equal(typeof h.svc.watcher[f], 'function', f);
    const gen = await h.svc.watcher.councilCandidates(0, C0);
    assert.deepEqual(gen.candidates.map(o => [o.option, o.kind, o.p, o.q, o.value, o.own]), [[1, 'strike', 0, 1, 100, 300], [2, 'camp', 2, 0, 100, 300]]);
    assert.equal((await h.svc.mind.health()).watcher.ticks, 0);
  } finally {
    await h.close();
  }
});

test('the whole council beat: open at C0, motions and ballots reach the brain with the next decide answer and are accepted, the Strike Order is adopted, sealed, wakes the AIs, opens at S + 2 with a result; a decision under it is released; chronicle, cards and events are written', async () => {
  const h = await boot();
  try {
    const { svc } = h;
    const tagA = TAGS[0], tagB = TAGS[1];
    // the mind needs each AI's last situation (and the game clock anchor) before a council call
    await svc.mind.decide(h.req('a', C0));
    await svc.mind.decide(h.req('b', C0));
    await svc.watcher.tick(C0);
    assert.ok(svc.social.council.periodOf(0, 2), 'the council of nation 0 opened at C0 = 48');
    const pub = svc.social.council.publicState(0);
    assert.deepEqual(pub.options.map(o => [o.option, o.kind, o.p, o.q]), [[1, 'strike', 0, 1], [2, 'camp', 2, 0]]);
    await h.settle();
    assert.equal(svc.watcher.stats().outbox.pending, 2, 'one motion per AI waits for its brain');
    // bell 49: the brains step; the answers carry the motions; the brain signs and posts under the answer's decision id
    for (const [who, c] of [['a', h.a], ['b', h.b]]) {
      const ans = await svc.mind.decide(h.req(who, C0 + 1));
      assert.ok(ans.social.motion, `AI ${who}: the motion is on the answer`);
      assert.equal(ans.social.motion.text, MARKER);
      const r = await h.post('/f/ai/talk', { ...h.signTalk(c, ans.social.motion), decision_id: ans.decision_id, item: ans.social.motion.item });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    assert.equal(svc.social.council.publicState(0).motions.length, 2);
    assert.equal((await svc.mind.decide(h.req('a', C0 + 1))).social.motion, null, 'a same-bell repeat answers from the cache: nothing is attached twice');
    await svc.watcher.tick(C0 + 1);
    // bell 51: the ballot window opens, the AIs are asked for their ballot
    await svc.watcher.tick(C0 + 3);
    await h.settle();
    for (const [who, c] of [['a', h.a], ['b', h.b]]) {
      const ans = await svc.mind.decide(h.req(who, C0 + 4));
      assert.ok(ans.social.ballot, `AI ${who}: the ballot is on the answer`);
      const r = await h.post('/f/ai/ballot', { ...h.signBallot(c, ans.social.ballot), decision_id: ans.decision_id, item: ans.social.ballot.item });
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    assert.equal(svc.social.council.publicState(0).ballots_cast, 2);
    // the close: both AIs chose option 2 (the camp); no human of nation 0 is eligible, so the AI ballots alone adopt it
    await svc.watcher.tick(C0 + 6);
    const call = svc.social.memberCall(0, 2);
    assert.ok(call, 'the Strike Order is sealed through fixCall -> watcher.closeCall');
    assert.deepEqual([call.option, call.kind, call.p, call.q, call.tile, call.strike_bell, call.follow_from], [2, 'camp', 2, 0, 44, S, C0 + 6]);
    assert.deepEqual(call.invited, ['7001'], 'the one army of the nation within 2 provinces of the target');
    // the public council file shows neither the tile nor the invited hosts before S + 2
    const pubFile = readJson(join(h.aiDir, 'pub/council/2-0.json'));
    for (const k of ['tile', 'invited', 'nonce']) assert.equal(JSON.stringify(pubFile).includes(`"${k}"`), false, k);
    // W-CALL wakes each member once while it may follow
    for (const t of [tagA, tagB]) assert.deepEqual(svc.watcher.wakeEvents(t, C0 + 7).filter(w => w.code === 'W-CALL').map(w => w.period), [2]);
    assert.deepEqual(svc.watcher.wakeEvents(tagA, C0 + 8).filter(w => w.code === 'W-CALL'), [], 'once');
    // a decision under the live Strike Order is sealed, release_bell = S + 2
    const under = await svc.mind.decide(h.req('a', C0 + 8));
    const rec = svc.records.get(under.decision_id);
    assert.deepEqual([rec.sealed, rec.release_bell], [true, S + 2]);
    assert.equal('public' in rec, false, 'nothing of it is published while sealed');
    // S + 2: the Call opens, the result is written, the sealed decision is released
    await svc.watcher.tick(S + 1);
    assert.equal(existsSync(join(h.aiDir, 'pub/open', `${S + 1}.json`)), false);
    await svc.watcher.tick(S + 2);
    const opened = svc.social.council.publicOf(0, 2);
    assert.deepEqual([opened.open.p, opened.open.q, opened.open.tile], [2, 0, 44]);
    assert.deepEqual([opened.result.present, opened.result.clash], [0, null], 'no army arrived and there was no clash row: a result that says so');
    const of = readJson(join(h.aiDir, 'pub/open', `${S + 2}.json`));
    assert.ok(of.records.some(r => r.id === under.decision_id), 'the decision made under the Strike Order is opened at S + 2');
    assert.deepEqual(of.records.find(r => r.id === under.decision_id).destinations, []);
    assert.deepEqual(svc.watcher.stats().errors, {}, `${JSON.stringify(svc.watcher.stats().errors)} ${svc.watcher.stats().last_error}`);
    // after the opening the Strike Order is no longer live: a decision at S + 3 is not sealed (and so is not mute)
    const after = await svc.mind.decide(h.req('a', S + 3));
    assert.equal(svc.records.get(after.decision_id).sealed, false, 'an opened Strike Order does not seal later decisions');
    // the chronicle: code numbers only, the motions, the adoption without a target, the result with it
    const chron = readJson(join(h.aiDir, 'pub/chronicle/latest.json')).lines;
    const kinds = chron.map(l => l.kind);
    assert.deepEqual(kinds.filter(k => k === 'motion').length, 2);
    assert.ok(kinds.includes('call_adopted') && kinds.includes('strike_result'), kinds.join());
    const adopted = chron.find(l => l.kind === 'call_adopted');
    assert.equal(adopted.text.en.includes('(2,0)'), false, 'no target in call_adopted');
    assert.match(adopted.text.en, /Strike Order with 2 AI ballots/);
    // FB5: the strike bell S is when the armies arrive; the Strike Order is OPENED at S + 2 (the file `open/<S + 2>.json` above)
    assert.match(adopted.text.en, new RegExp(`until the armies arrive at bell ${S}; the Strike Order is opened at bell ${S + 2}\\.$`));
    assert.match(adopted.text.ja, new RegExp(`軍が着く鐘${S}まで秘密。攻撃命令は鐘${S + 2}で開かれる。$`));
    assert.match(chron.find(l => l.kind === 'strike_result').text.en, /opened at \(2,0\) \(camp\)/);
    assert.equal(JSON.stringify(chron).includes('within reach'), false, 'model text never enters the chronicle');
    assert.ok(chron.every(l => l.text.en && l.text.ja));
    // cards and events
    const cards = readJson(join(h.aiDir, 'pub/cards/index.json')).cards;
    assert.deepEqual(cards.map(c => c.tag).sort(), [TAGS[0], TAGS[1], TAGS[2]].sort());
    assert.ok(existsSync(join(h.aiDir, 'pub/events/latest.json')));
    const stats = svc.watcher.stats();
    assert.deepEqual(stats.errors, {}, JSON.stringify(stats.errors) + stats.last_error);
    assert.equal(stats.council.councils_opened, 1);
    assert.equal(stats.outbox.outbox_attached, 4);
    assert.equal(stats.calls.strike_results, 1);
    assert.deepEqual(readJson(join(h.aiDir, 'state/watcher/state.json')).calls.sort(), [`ballot:${tagA}:2`, `ballot:${tagB}:2`, `motion:${tagA}:2`, `motion:${tagB}:2`], 'the council calls asked are persisted');
    // every file the watcher wrote under pub is plain data: no key material, no seed
    for (const dir of ['chronicle', 'cards', 'events', 'open']) for (const f of readdirSync(join(h.aiDir, 'pub', dir))) assert.doesNotMatch(readFileSync(join(h.aiDir, 'pub', dir, f), 'utf8'), /secret|seed|private/i, `${dir}/${f}`);
  } finally {
    await h.close();
  }
});

test('start() runs the per-bell job off the mind\'s game clock and stop() halts it; the health route carries the watcher counters', async () => {
  const h = await boot();
  try {
    await h.svc.mind.decide(h.req('a', C0 + 20)); // anchors the clock at bell 68 (no council window there: nothing opens)
    h.svc.watcher.start();
    for (let i = 0; i < 60 && h.svc.watcher.stats().ticks === 0; i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(h.svc.watcher.stats().ticks >= 1, 'the timer ticked');
    const health = await h.svc.mind.health();
    assert.ok(health.watcher.ticks >= 1);
    assert.ok(existsSync(join(h.aiDir, 'pub/cards/index.json')));
    h.svc.watcher.stop();
    const n = h.svc.watcher.stats().ticks;
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(h.svc.watcher.stats().ticks, n, 'stopped');
  } finally {
    await h.close();
  }
});
