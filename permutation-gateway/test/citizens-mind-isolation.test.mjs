// AC1a: T-K4, isolation inside the one mind process (section 5.6). A has a sealed march, a private ledger and
// episodes; a human has a cast ballot and a client IP; nation 1 has a live Strike Order. None of those values
// appear in B's rendered prompt or llama request body, and nation 1's Call is in no prompt of a nation-0 AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMindHarness, loadWireFixture, sessionAnswer, makeSocial, makeEpisode, makeStores, TAGS, WALLETS } from './fixtures/ai-mind-doubles.mjs';

const { json: wire } = loadWireFixture();
const reqFor = (idx, over = {}) => {
  const r = JSON.parse(JSON.stringify(wire.request));
  r.deadline_unix_ms = Date.now() + 60_000;
  r.ai = { index: 3 + idx, tag: TAGS[idx], wallet: WALLETS[idx] };
  r.situation.me.faction = idx === 2 ? 1 : 0;
  return Object.assign(r, over);
};

test('T-K4: one AI\'s private state never reaches another AI\'s prompt or llama request body', async () => {
  const MARK = {
    episodeA: 'EPISODE_A_PRIVATE_MARKER',
    ledgerA: 'LEDGER_A_PRIVATE_MARKER',
    ballotA: 'BALLOT_A_NONCE_MARKER',
    ip: '203.0.113.99',
    humanBallot: 'HUMAN_BALLOT_MARKER',
    call1: '(66,77)',
  };
  const stores = makeStores({ episodes: [] });
  stores.episodes(TAGS[0]).add(makeEpisode(1, { text: { en: `At bell 10 ${MARK.episodeA} happened to you.`, ja: 'x' }, entities: [TAGS[0], 'nation:0', 'pq:2,0'] }));
  stores.ledger(TAGS[0]).s.trust.citizens[TAGS[2]] = { t_code: -20, t_model: 0, episodes: [], note: MARK.ledgerA };
  const councils = {
    0: { period: 4, state: 'motions', options: [{ option: 1, kind: 'camp', p: 3, q: 4, ratio: 'favourable' }], motions: [], ballots_cast: 1, closes_bell: 60, ballot_secret: MARK.ballotA },
    1: { period: 4, state: 'closed', options: [{ option: 2, kind: 'strike', p: 66, q: 77, ratio: 'even' }], motions: [], adopted: true, strike_bell: 50, humanBallot: MARK.humanBallot, ip: MARK.ip },
  };
  const calls = { 1: { option: 2, kind: 'strike', p: 66, q: 77, tile: 4, strike_bell: 50, follow_from: 46, invited: [1], nonce: 'n1' } };
  const social = makeSocial();
  social.read.council = (f) => councils[f] ?? null;
  social.memberCall = (f) => calls[f] ?? null;
  const h = await makeMindHarness({ stores, social, respond: (b) => sessionAnswer(b, { kinds: ['march'] }) });
  try {
    // A sealed-set entry and a march of A
    h.sealed.add(TAGS[0], [{ decision_id: 'dA', pq: [91, 92], arrive_bell: 70, names: ['SEALED_A_NAME'], numbers: [], via: 'model' }]);
    const a = await h.mind.decide(reqFor(0));
    const b = await h.mind.decide(reqFor(1));
    const c = await h.mind.decide(reqFor(2));
    assert.equal(h.llama.bodies.length, 3);
    const [bodyA, bodyB, bodyC] = h.llama.bodies.map((x) => JSON.stringify(x));
    assert.ok(bodyA.includes(MARK.episodeA), 'A sees its own episode (sanity)');
    for (const m of [MARK.episodeA, MARK.ledgerA, MARK.ballotA, MARK.ip, MARK.humanBallot, 'SEALED_A_NAME', '(91,92)', '91,92']) {
      assert.equal(bodyB.includes(m), false, `B's request body leaks ${m}`);
      assert.equal(bodyC.includes(m), false, `C's request body leaks ${m}`);
    }
    // A's march target and hashes of A's private values are not in B's prompt
    const hashes = [MARK.episodeA, MARK.ledgerA].map((v) => require_sha(v));
    for (const hs of hashes) assert.equal(bodyB.includes(hs), false);
    // nation 1's Strike Order option appears in no prompt of a nation-0 AI
    for (const body of [bodyA, bodyB]) {
      assert.equal(body.includes('66,77'), false, 'nation 1\'s call target');
      assert.equal(body.includes('"p":66'), false);
    }
    assert.ok(a && b && c);
    // the sealed set of C holds its own nation's live Call; A's and B's do not
    assert.deepEqual(h.sealed.list(TAGS[2]).map((e) => e.via), ['call']);
    assert.deepEqual(h.sealed.list(TAGS[1]), []);
    assert.deepEqual(h.sealed.list(TAGS[0]).map((e) => e.via), ['model'], 'A keeps only its own entry');
  } finally {
    await h.close();
  }
});

import { createHash } from 'node:crypto';
function require_sha(v) { return createHash('sha256').update(v).digest('hex'); }

test('the prompt renderer takes the three views and nothing else: ownState is keyed by the AI tag and cannot list other AIs', async () => {
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    const own0 = h.views.ownState(TAGS[0]);
    const own1 = h.views.ownState(TAGS[1]);
    assert.notEqual(own0.ledger, own1.ledger);
    assert.notEqual(own0.episodes, own1.episodes);
    assert.equal(own0.tag, TAGS[0]);
    assert.deepEqual(Object.keys(own0).sort(), ['doc', 'episodes', 'faction', 'index', 'ledger', 'name', 'persona', 'sealed', 'summary', 'tag', 'wallet']);
    const pub = h.views.publicView();
    assert.deepEqual(Object.keys(pub).sort(), ['bell', 'council', 'feedCursorBell', 'hallRows', 'inboxRows', 'nameOf', 'roster']);
    assert.deepEqual(Object.keys(h.views.memberView(0)), ['call']);
  } finally {
    await h.close();
  }
});

test('client IPs and ballot bytes are not part of anything the mind stores: no IP-shaped string reaches STATE or PUB', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const h = await makeMindHarness({ respond: (b) => sessionAnswer(b) });
  try {
    await h.mind.decide(reqFor(0));
    h.records.closeBell(40);
    const walk = (p) => readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]));
    for (const f of [...walk(join(h.aiDir, 'state')), ...walk(join(h.aiDir, 'pub'))]) {
      const t = readFileSync(f, 'utf8');
      assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(t.replace(/127\.0\.0\.1/g, '')), false, f);
    }
  } finally {
    await h.close();
  }
});
