// integ-A review: the memory upkeep is called by the running service (not only unit-tested): across a game-day boundary the
// real mind step decays trust by temperament, resets the day's model-delta cap and writes goal progress computed by code.
// Real stores, real persona library, real memory renderer; the model is a fake llama-server on 127.0.0.1:0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCitizensService } from '../citizens/server.mjs';
import { createLlm } from '../citizens/mind/llm.mjs';
import { startFakeLlama, loadWireFixture, sessionAnswer, makeRosterJson, CONFIG } from './fixtures/ai-mind-doubles.mjs';
import { makeCitizen, fakeHerald } from './fixtures/ai-social-kit.mjs';

const { json: wire } = loadWireFixture();
const GENESIS = 1_800_000_000;
const SEASON = 31;
const OTHER = 'cccccccccccccc01';

async function boot() {
  const aiDir = mkdtempSync(join(tmpdir(), 'ai-integ-upkeep-'));
  mkdirSync(join(aiDir, 'pub'), { recursive: true });
  const a = makeCitizen('ai-a', { faction: 0 });
  const roster = makeRosterJson({ n: 2 });
  roster.ai[0].wallet = a.b58;
  roster.ai[0].persona = 'guardian';
  roster.ai[0].temperament = { aggression: 50, loyalty: 50, ambition: 50, honesty: 50, risk: 50, sociability: 50, grudge: 50 };
  roster.season = SEASON;
  writeFileSync(join(aiDir, 'pub/roster.json'), JSON.stringify(roster));
  const llama = await startFakeLlama({ respond: (b) => sessionAnswer(b, { kinds: ['build'], why: 'Building suits goal G1.' }) });
  const svc = await createCitizensService(
    { aiDir, herald: 'http://127.0.0.1:41940', llm: 'http://127.0.0.1:41901', mindPort: 0, socialPort: 0, servePort: 0, runId: 't', season: SEASON, genesisTs: GENESIS },
    { test: true, noCloserTimer: true, config: { ...CONFIG, channel_lang: 'en' }, feed: { cursorBell: () => null, wakeEvents: () => [] }, llm: createLlm({ url: llama.url }), socialHerald: fakeHerald([a]) },
  );
  const req = (bell) => {
    const r = JSON.parse(JSON.stringify(wire.request));
    r.ai = { index: roster.ai[0].index, tag: roster.ai[0].tag, wallet: a.b58 };
    r.bell = bell;
    r.now_game = GENESIS + bell * 600 + 100;
    r.deadline_unix_ms = Date.now() + 60_000;
    r.situation.bell = bell;
    r.situation.day = Math.floor(bell / 144);
    r.situation.bell_in_day = bell % 144;
    r.situation.me.home.walls = 300;
    return r;
  };
  return { svc, roster, req, async close() { await svc.close(); await llama.close(); } };
}

test('a decision step in the running service rolls the game day (trust decay, model cap reset) and writes goal progress', async () => {
  const h = await boot();
  try {
    const tag = h.roster.ai[0].tag;
    await h.svc.mind.decide(h.req(40));
    const led = h.svc.stores.ledger(tag);
    const prog0 = Object.fromEntries(led.s.goals.map((g) => [g.id, g.progress]));
    assert.equal(prog0.G1, 50, 'guardian G1 (walls 300 of 600) is computed by code at the first step');
    const e = led._entry(OTHER);
    Object.assign(e, { t_code: 10, t_model: 6, model_today: 15 });
    await h.svc.mind.decide(h.req(41));
    assert.deepEqual([e.t_code, e.t_model, e.model_today], [10, 6, 15], 'same game day: nothing moves');
    await h.svc.mind.decide(h.req(190)); // day 1
    // grudge 50 -> d = ceil(50 / 20) = 3 toward zero
    assert.deepEqual([e.t_code, e.t_model, e.model_today], [7, 3, 0], 'the day rolled: decayed by temperament, the model cap is back');
    const m = h.svc.mind.metrics();
    assert.ok(m, 'metrics still answer');
  } finally {
    await h.close();
  }
});
