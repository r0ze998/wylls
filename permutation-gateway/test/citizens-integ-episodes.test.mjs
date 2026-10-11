// integ-A review: the episode pump over AC4's REAL social store. dm, motion and council_result episodes are made from the
// store's accepted talk rows and closed council file (closes_bell, candidates: AC4's shape, adapted for the producer), and a
// redaction of the record blanks the stored episode. Citizens and signing come from AC4's test kit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { motionRef } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { createMemoryStore } from '../citizens/memory/store.mjs';
import { createEpisodePump, socialEpisodeSource, councilFileForEpisodes } from '../citizens/mind/wiring.mjs';
import { tagHex } from '../citizens/persona/names.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPTIONS, SEASON, UNIX0, builders, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';

const K = 2;
const C0 = 48;
const CFG = { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } };

async function setup() {
  const clock = makeClock({ bell: C0 });
  const cits = { ai0: makeCitizen('ai0', { faction: 0 }), ai1: makeCitizen('ai1', { faction: 0 }), alice: makeCitizen('alice', { faction: 0 }) };
  const herald = fakeHerald(Object.values(cits));
  const aiEntry = (c, i) => ({ index: 1000 + i, wallet: c.b58, tag: tagHex(c.tag), faction: 0, name: { en: `AI${i}`, ja: `AI${i}` } });
  const roster = { season: SEASON, ai: [aiEntry(cits.ai0, 0), aiEntry(cits.ai1, 1)], script: { wallets: [] }, seat: { index: 1012, wallet: 'seatseatseatseatseatseatseatseatseatseatseat0', tag: 'bbbbbbbbbbbbbbb0', faction: 0, scripted: false } };
  const outputs = new Map();
  const provenance = { provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, consume: () => true };
  const aiDir = tmpAiDir('ai-pump-soc-');
  const social = createSocial({ herald, aiDir: aiDir.dir, roster, clock, provenance, config: CFG, season: SEASON, random: (n) => new Uint8Array(n).fill(0x11) });
  return { clock, cits, social, b: builders(clock), outputs, aiDir };
}

test('pump over AC4\'s real store: dm, motion and council_result episodes are produced; a redaction blanks them; unclosed periods give no result', async () => {
  const w = await setup();
  const { social, cits } = w;
  social.council.open({ faction: 0, period: K, c0: C0, candidates: OPTIONS });
  // an open period is not a result yet
  assert.equal(councilFileForEpisodes(social.council.publicOf(0, K)), null);
  // alice (human) moves option 2 in the nation channel; alice sends ai0 a direct message
  await social.book.submit('talk', w.b.talk(cits.alice, { channel: 1, target: 0, kind: 1, ref: motionRef(K, 2), origin: 0, text: 'I move this option.' }).body);
  await social.book.submit('talk', w.b.talk(cits.alice, { channel: 3, target: cits.ai0.wallet, kind: 0, origin: 0, text: 'Hello ai0.' }).body);
  w.clock.set(C0 + 3);
  await social.book.submit('ballot', w.b.ballot(cits.alice, { period: K, option: 2, candidates_hash: social.council.publicOf(0, K).candidates_hash, origin: 0 }).body);
  w.outputs.set('bd1|0|ballot', { type: 'ballot', bell: C0 + 3, option: 2, period: K, faction: 0, candidates_hash: social.council.publicOf(0, K).candidates_hash });
  await social.book.submit('ballot', w.b.ballot(cits.ai1, { period: K, option: 2, candidates_hash: social.council.publicOf(0, K).candidates_hash, origin: 1 }, { decision_id: 'bd1', item: 0 }).body);
  w.clock.set(C0 + 6);
  await social.tick();
  const file = social.council.publicOf(0, K);
  assert.equal(file.adopted, true);
  assert.ok('closes_bell' in file && 'candidates' in file && !('close_bell' in file), 'AC4 writes closes_bell and candidates');
  const adapted = councilFileForEpisodes(file);
  assert.deepEqual([adapted.close_bell, adapted.adopted, adapted.options.map((o) => o.kind)], [C0 + 6, true, ['strike', 'camp', 'raid']]);

  // the pump (a feed with nothing in the log: only the social rows matter)
  const dir = mkdtempSync(join(tmpdir(), 'ai-pump-soc-'));
  const stores = createMemoryStore({ stateDir: join(dir, 'state'), pubDir: join(dir, 'pub') });
  const tag = tagHex(cits.ai0.tag);
  const feed = {
    state: { through: 60 },
    completeThrough() { return this.state.through; },
    cursor: () => '1',
    events: () => [],
    owners: { homeOf: (t) => (t === tag ? { p: 0, q: 0, site: 0 } : null), factionOfTag: () => 0, holdingsOf: () => [{ p: 0, q: 0, site: 0 }], citizenOfHost: () => null },
    async prepare() { return { province: () => null, clash: () => null, clashDetail: () => null, owners: this.owners, missing: [] }; },
  };
  const views = { ownState: (t, bell) => ({ ledger: stores.ledger(t, { goals: [], bell }) }) };
  const pump = createEpisodePump({
    feed, stores, views, roster: { ready: true, ai: [{ tag, wallet: cits.ai0.b58, faction: 0 }] }, clock: { genesis: () => UNIX0 },
    social: socialEpisodeSource({ book: social.book, council: social.council, pubDir: w.aiDir.pub }),
  });
  await pump.tick();
  assert.equal(pump.stats.errors, 0, pump.stats.last_error);
  const eps = stores.episodes(tag).list();
  const kinds = eps.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['council_result', 'dm', 'motion'], JSON.stringify(eps.map((e) => [e.kind, e.bell, e.created_bell])));
  const motion = eps.find((e) => e.kind === 'motion');
  assert.match(motion.text.en, /camp/, 'the motion text names the option kind from the council candidates, not "unknown"');
  assert.equal(eps.find((e) => e.kind === 'council_result').facts.adopted, true);
  assert.ok(pump.stats.talk_rows >= 2, `talk rows ${pump.stats.talk_rows}`);
  assert.equal(pump.stats.councils, 1);

  // a redaction of the dm record blanks the stored dm episode on the next pass
  const dmRow = social.book.list({ after: 0, limit: 50 }).messages.find((m) => m.channel === 3);
  social.book.redact([{ inner: dmRow.inner, bell: 60, reason: 'test' }]);
  feed.state.through = 61;
  await pump.tick();
  const dm = stores.episodes(tag).list().find((e) => e.kind === 'dm');
  assert.equal(dm.redacted, true);
  assert.deepEqual(dm.text, { en: '', ja: '' });
  assert.ok(pump.stats.redacted >= 1);
  const motionAfter = stores.episodes(tag).list().find((e) => e.kind === 'motion');
  assert.equal(motionAfter.redacted, undefined, 'only the redacted record\'s episode is blanked');
});
