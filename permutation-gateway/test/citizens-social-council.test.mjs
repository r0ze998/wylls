// AC4: the nation council's store (contract §6.5 steps 2-5 and 7): windows,
// motions, hidden ballots, tally (ties, quorum, none), the human-present rule
// and its scope, the sealed Call and its member read, the opening at S + 2,
// restart. Candidates and the tile are the watcher's: here a test double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromBase64, fromHex, motionRef, seqOf, sha256, toHex } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { Refusal } from '../citizens/social/book.mjs';
import { callCommit, candidatesHash, canonicalJson, optionsHash, periodAt } from '../citizens/social/council.mjs';
import { createSocial } from '../citizens/social/routes.mjs';
import { OPTIONS, SEASON, builders, fakeHerald, get, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';

const CFG = { council: { period: 24, offset: 0, strike_lead: 6, human_present: true } };
const K = 2;
const C0 = 48;
const CH = candidatesHash(OPTIONS);
const NONCE = '11'.repeat(32);

function world({ config = CFG, fixCall = null, persist = true } = {}) {
  const clock = makeClock({ bell: C0 });
  const dir = persist ? tmpAiDir() : null;
  const cits = {
    alice: makeCitizen('alice', { faction: 0 }),
    carl: makeCitizen('carl', { faction: 0 }),
    seat: makeCitizen('seat', { faction: 0 }),
    ai0: makeCitizen('ai0', { faction: 0 }),
    ai1: makeCitizen('ai1', { faction: 0 }),
    bot: makeCitizen('bot', { faction: 0 }),
    bob: makeCitizen('bob', { faction: 1 }),
    ai2: makeCitizen('ai2', { faction: 2 }),
    ai3: makeCitizen('ai3', { faction: 2 }),
    prov: makeCitizen('prov', { faction: 0, final: false }),
  };
  const herald = fakeHerald(Object.values(cits));
  const aiEntry = (c, i, f) => ({ index: 1000 + i, wallet: c.b58, tag: `${i}`.padStart(16, '0'), faction: f, name: { en: `AI${i}`, ja: `AI${i}` } });
  const roster = {
    season: SEASON,
    ai: [aiEntry(cits.ai0, 0, 0), aiEntry(cits.ai1, 1, 0), aiEntry(cits.ai2, 2, 2), aiEntry(cits.ai3, 3, 2)],
    script: { wallets: [cits.bot.b58] },
    seat: { index: 1012, wallet: cits.seat.b58, tag: 'bbbbbbbbbbbbbbb0', faction: 0, scripted: false },
  };
  // The mind's signed-ready outputs (provenance double): every AI record is allowed once per (decision, item).
  const outputs = new Map();
  const provenance = (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null;
  const social = createSocial({ herald, aiDir: dir?.dir ?? null, roster, clock, provenance, config, season: SEASON, random: n => new Uint8Array(n).fill(0x11), fixCall });
  const b = builders(clock);
  let seqn = 0;
  return {
    clock, dir, cits, herald, roster, social, b, outputs,
    open(opts = {}) { return social.council.open({ faction: 0, period: K, c0: C0, candidates: OPTIONS, ...opts }); },
    motion: (c, option, f = {}, extra = {}) => social.book.submit('talk', b.talk(c, { channel: 1, target: c.faction, kind: 1, ref: motionRef(K, option), origin: 0, text: 'I move this option.', ...f }, extra).body),
    ballot: (c, option, f = {}, extra = {}) => social.book.submit('ballot', b.ballot(c, { period: K, option, candidates_hash: CH, ...f }, extra).body),
    /** An AI ballot: register the mind's output, then send with its decision id. */
    aiBallot(c, option, f = {}) {
      const id = `bd${seqn++}`;
      outputs.set(`${id}|0|ballot`, { type: 'ballot', bell: C0 + 3, option, period: K, faction: c.faction, candidates_hash: CH });
      return social.book.submit('ballot', b.ballot(c, { period: K, option, candidates_hash: CH, origin: 1, ...f }, { decision_id: id, item: 0 }).body);
    },
    aiMotion(c, option, text = 'AI motion.') {
      const id = `md${seqn++}`;
      outputs.set(`${id}|0|talk`, { type: 'talk', bell: C0, text });
      return social.book.submit('talk', b.talk(c, { channel: 1, target: c.faction, kind: 1, ref: motionRef(K, option), origin: 1, text }, { decision_id: id, item: 0 }).body);
    },
    file: name => JSON.parse(readFileSync(join(dir.pub, 'council', name), 'utf8')),
  };
}
const refused = async (p, code) => { await assert.rejects(p, e => e instanceof Refusal && e.code === code, `expected ${code}`); };

test('open: options, hashes, idempotence; no options = no council; the public state before and after', () => {
  const w = world();
  assert.equal(w.social.council.publicState(0).state, 'none');
  assert.equal(w.social.council.publicState(0).period, null);
  assert.equal(w.open({ candidates: [] }), null, 'no option, no council');
  assert.throws(() => w.open({ candidates: [{ ...OPTIONS[0], option: 2 }] }), /numbered/);
  assert.throws(() => w.open({ candidates: [...OPTIONS, { ...OPTIONS[0], option: 4 }] }), /three/);
  assert.throws(() => w.open({ candidates_hash: '00'.repeat(32) }), /candidates_hash/);
  assert.throws(() => w.open({ options_hash: '00'.repeat(32) }), /options_hash/);
  const v = w.open({ candidates_hash: CH, options_hash: optionsHash(OPTIONS) });
  assert.equal(v.candidates_hash, CH);
  assert.equal(v.options_hash, optionsHash(OPTIONS));
  assert.notEqual(optionsHash(OPTIONS), CH, 'options_hash omits value, own and ratio');
  // options_hash does not change when only value/own/ratio change (the A/B pair rule)
  assert.equal(optionsHash(OPTIONS.map(o => ({ ...o, value: o.value + 1, own: 1, ratio: 'x' }))), optionsHash(OPTIONS));
  assert.notEqual(candidatesHash(OPTIONS.map(o => ({ ...o, value: o.value + 1 }))), CH);
  assert.equal(w.open().period, K, 'idempotent for identical options');
  assert.throws(() => w.open({ candidates: OPTIONS.slice(0, 2) }), /already open/);
  const s = w.social.council.publicState(0);
  assert.equal(s.state, 'motions');
  assert.equal(s.closes_bell, C0 + 6);
  assert.equal(s.ballots_cast, 0);
  assert.equal(s.adopted, false);
  assert.equal(s.options.length, 3);
  assert.equal(s.strike_bell, null);
  assert.equal(w.file(`${K}-0.json`).candidates_hash, CH);
  assert.deepEqual(w.file('current.json').nations, [{ faction: 0, period: K, adopted: false, S: null, call_commit: null }]);
  assert.deepEqual(periodAt(49, CFG.council), { k: 2, c0: 48 });
  assert.equal(periodAt(23, CFG.council), null);
  assert.deepEqual(periodAt(60, { period: 48, offset: 12 }), { k: 1, c0: 60 });
});

test('canonicalJson sorts keys, keeps array order, is compact; call_commit = sha256(canonical{option,p,q,tile} ‖ nonce32)', () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { d: 1, c: 'x' }] }), '{"a":[3,{"c":"x","d":1}],"b":1}');
  const nonce = fromHex(NONCE);
  const c = callCommit({ option: 2, p: 4, q: 0, tile: 17 }, nonce);
  assert.equal(c, toHex(sha256('{"option":2,"p":4,"q":0,"tile":17}', nonce)));
  assert.equal(callCommit({ tile: 17, q: 0, p: 4, option: 2, extra: 'ignored' }, NONCE), c, 'only the four fields, key order irrelevant, hex nonce accepted');
});

test('motion window [C0, C0+3): eligible citizens, one motion each, public at once', async () => {
  const w = world();
  await refused(w.motion(w.cits.alice, 1), 'WindowClosed'); // not open yet
  w.open();
  const m = await w.motion(w.cits.alice, 2, { text: 'Strike the river camp.' });
  assert.ok(m.ok);
  let s = w.social.council.publicState(0);
  assert.equal(s.motions.length, 1);
  assert.equal(s.motions[0].option, 2);
  assert.equal(s.motions[0].text, 'Strike the river camp.');
  assert.equal(s.motions[0].wallet, w.cits.alice.b58);
  assert.equal(s.motions[0].ai_roster, false);
  assert.equal(w.file(`${K}-0.json`).motions.length, 1, 'the file is rewritten at once');
  await refused(w.motion(w.cits.alice, 1, { seq: seqOf(48, 7) }), 'Duplicate');
  await refused(w.motion(w.cits.carl, 1, { ref: motionRef(K, 1) , kind: 1, channel: 1, target: 1 }), 'NotMember');
  await refused(w.motion(w.cits.prov, 1), 'NotEligible'); // provisional village: not final yet
  await refused(w.motion(w.cits.bob, 1), 'WindowClosed'); // nation 1 has no council this period
  await refused(w.motion(w.cits.carl, 1, { ref: motionRef(K + 1, 1) }), 'WindowClosed'); // another period
  // option 4 does not exist here (2 options)
  const w2 = world();
  w2.open({ candidates: OPTIONS.slice(0, 2) });
  await refused(w2.motion(w2.cits.carl, 3), 'BadBytes');
  // an AI moves an option through the mind's output
  const a = await w.aiMotion(w.cits.ai0, 3);
  assert.ok(a.ok);
  s = w.social.council.publicState(0);
  assert.equal(s.motions.length, 2);
  assert.equal(s.motions[1].ai_roster, true);
  assert.equal(s.motions[1].ai_written, true);
  assert.deepEqual(s.motions[1].name, { en: 'AI0', ja: 'AI0' });
  // the window ends at C0+3
  w.clock.set(C0 + 3);
  await refused(w.motion(w.cits.carl, 1), 'WindowClosed');
  assert.equal(w.social.council.publicState(0).state, 'ballots');
});

test('ballot window [C0+3, C0+6): hidden until the close; one ballot (the first counts); options and hash checked', async () => {
  const w = world();
  w.open();
  await refused(w.ballot(w.cits.alice, 1), 'WindowClosed'); // still the motion window
  w.clock.set(C0 + 3);
  await refused(w.ballot(w.cits.alice, 1, { candidates_hash: '00'.repeat(32) }), 'BadBytes');
  await refused(w.ballot(w.cits.alice, 1, { period: K + 1 }), 'WindowClosed');
  await refused(w.ballot(w.cits.alice, 1, { faction: 1 }), 'NotMember');
  await refused(w.ballot(w.cits.bob, 1, { faction: 1 }), 'WindowClosed'); // nation 1 has no period
  await refused(w.ballot(w.cits.prov, 1), 'NotEligible');
  const r1 = await w.ballot(w.cits.alice, 2);
  assert.ok(r1.ok);
  await refused(w.ballot(w.cits.alice, 3), 'Duplicate');
  assert.equal(w.social.council.publicState(0).ballots_cast, 1);
  assert.equal(w.social.council.tally(0, K).per[2], 1, 'the first ballot counts');
  const s = w.social.council.publicState(0);
  assert.equal(s.state, 'ballots');
  assert.deepEqual(s.ballots ?? [], [], 'no ballot is shown before the close');
  assert.equal(s.tally_split, null, 'no counts per origin before the close');
  assert.ok(!JSON.stringify(s).includes(r1.inner), 'not even the leaf');
  // the file: no ballots before the close; the talk file shows the leaf only
  assert.deepEqual(w.file(`${K}-0.json`).ballots, []);
  const closed = w.social.closeBell(C0 + 3);
  const talk = JSON.parse(readFileSync(join(w.dir.pub, 'talk', `${C0 + 3}.json`), 'utf8'));
  assert.deepEqual(talk.records, [{ type: 'ballot', id: r1.id ?? talk.records[0].id, inner: r1.inner, wallet: w.cits.alice.b58, period: K }]);
  assert.ok(!('bytes_b64' in talk.records[0]) && !('sig_b64' in talk.records[0]) && !('option' in talk.records[0]));
  assert.equal(closed.count, 1);
  // an AI ballot needs the mind's output with its decision
  await refused(w.social.book.submit('ballot', w.b.ballot(w.cits.ai0, { period: K, option: 2, candidates_hash: CH, origin: 1 }, { decision_id: 'zz', item: 0 }).body), 'NotFromMind');
  await refused(w.social.book.submit('ballot', w.b.ballot(w.cits.ai0, { period: K, option: 2, candidates_hash: CH, origin: 0 }).body), 'NotFromMind');
  // the mind produced option 2, the record says 3
  w.outputs.set('q|0|ballot', { type: 'ballot', bell: C0 + 3, option: 2, period: K, faction: 0, candidates_hash: CH });
  await refused(w.social.book.submit('ballot', w.b.ballot(w.cits.ai0, { period: K, option: 3, candidates_hash: CH, origin: 1 }, { decision_id: 'q', item: 0 }).body), 'NotFromMind');
  assert.ok((await w.social.book.submit('ballot', w.b.ballot(w.cits.ai0, { period: K, option: 2, candidates_hash: CH, origin: 1 }, { decision_id: 'q', item: 0 }).body)).ok);
  // the window ends at C0+6
  w.clock.set(C0 + 6);
  await refused(w.ballot(w.cits.carl, 1), 'WindowClosed');
});

async function cast(w, ballots) {
  w.open();
  w.clock.set(C0 + 3);
  for (const [who, opt, kind] of ballots) {
    if (kind === 'ai') await w.aiBallot(w.cits[who], opt);
    else if (kind === 'scripted') await w.ballot(w.cits[who], opt, { origin: 2 });
    else await w.ballot(w.cits[who], opt);
  }
  w.clock.set(C0 + 6);
  await w.social.tick();
  return w.social.council.publicState(0);
}

test('close at C0+6: the winner needs ≥ 2 ballots and strictly more than every option and than none', async () => {
  // adopted: 2 AND human present (alice, origin 0)
  let w = world();
  w.roster.seat.scripted = false;
  let s = await cast(w, [['ai0', 2, 'ai'], ['alice', 2, 'human'], ['ai1', 3, 'ai']]);
  assert.equal(s.state, 'closed');
  assert.equal(s.adopted, true);
  assert.equal(s.reason, 'adopted');
  assert.equal(s.strike_bell, C0 + 6 + 6);
  assert.equal(s.follow_from, C0 + 6);
  assert.deepEqual(s.tally_split, { ai: 2, human: 1, scripted: 0 });
  assert.equal(s.ballots.length, 3);
  assert.deepEqual(s.ballots.map(b => Object.keys(b).sort()), s.ballots.map(() => ['inner', 'wallet']), 'leaves only: no option');
  // quorum: a single ballot never adopts
  w = world();
  s = await cast(w, [['alice', 2, 'human']]);
  assert.equal(s.adopted, false);
  assert.equal(s.reason, 'quorum');
  // no ballots at all
  w = world();
  s = await cast(w, []);
  assert.equal(s.reason, 'quorum');
  // tie between two options
  w = world();
  s = await cast(w, [['ai0', 1, 'ai'], ['alice', 1, 'human'], ['ai1', 2, 'ai'], ['carl', 2, 'human']]);
  assert.equal(s.reason, 'tie');
  // none strictly more
  w = world();
  s = await cast(w, [['ai0', 1, 'ai'], ['alice', 1, 'human'], ['ai1', 0, 'ai'], ['carl', 0, 'human'], ['seat', 0, 'human']]);
  assert.equal(s.reason, 'none_wins');
  // none equal to the top: a tie, not a win
  w = world();
  s = await cast(w, [['ai0', 1, 'ai'], ['alice', 1, 'human'], ['ai1', 0, 'ai'], ['carl', 0, 'human']]);
  assert.equal(s.reason, 'tie');
  // the top beats none
  w = world();
  s = await cast(w, [['ai0', 1, 'ai'], ['alice', 1, 'human'], ['carl', 1, 'human'], ['ai1', 0, 'ai'], ['seat', 0, 'human']]);
  assert.equal(s.adopted, true);
});

test('human-present rule (O-AI-4): a nation with an eligible non-AI voter needs one of the winner\'s ballots from origin 0 or 2; a scripted seat ballot is printed as scripted', async () => {
  // Nation 0 has the seat (eligible, not voting) and alice: AI ballots alone do not adopt.
  let w = world();
  let s = await cast(w, [['ai0', 2, 'ai'], ['ai1', 2, 'ai']]);
  assert.equal(s.adopted, false);
  assert.equal(s.reason, 'human_present');
  assert.deepEqual(s.tally_split, { ai: 2, human: 0, scripted: 0 });
  assert.equal(w.file(`${K}-0.json`).open.adopted, false, 'a council without a Call publishes its ballots at the close');
  assert.equal(w.file(`${K}-0.json`).open.ballots.length, 2);
  // a human ballot for another option does not satisfy it
  w = world();
  s = await cast(w, [['ai0', 2, 'ai'], ['ai1', 2, 'ai'], ['alice', 3, 'human']]);
  assert.equal(s.reason, 'human_present');
  // the scripted seat ballot (origin 2) satisfies it and is counted as scripted
  w = world();
  w.roster.seat.scripted = true;
  s = await cast(w, [['ai0', 2, 'ai'], ['ai1', 2, 'ai'], ['seat', 2, 'scripted']]);
  assert.equal(s.adopted, true);
  assert.deepEqual(s.tally_split, { ai: 2, human: 0, scripted: 1 });
  // scope: nation 2 has only AI citizens; its council adopts on AI ballots alone (G6)
  w = world();
  w.social.council.open({ faction: 2, period: K, c0: C0, candidates: OPTIONS });
  w.clock.set(C0 + 3);
  const ch = candidatesHash(OPTIONS);
  for (const c of [w.cits.ai2, w.cits.ai3]) {
    w.outputs.set(`n${c.name}|0|ballot`, { type: 'ballot', bell: C0 + 3, option: 1 });
    await w.social.book.submit('ballot', w.b.ballot(c, { period: K, faction: 2, option: 1, candidates_hash: ch, origin: 1 }, { decision_id: `n${c.name}`, item: 0 }).body);
  }
  w.clock.set(C0 + 6);
  await w.social.tick();
  const s2 = w.social.council.publicState(2);
  assert.equal(s2.adopted, true);
  assert.deepEqual(s2.tally_split, { ai: 2, human: 0, scripted: 0 });
  // the flag turns the rule off
  w = world({ config: { council: { ...CFG.council, human_present: false } } });
  s = await cast(w, [['ai0', 2, 'ai'], ['ai1', 2, 'ai']]);
  assert.equal(s.adopted, true);
  // a seat that does not hold a final village is not an eligible non-AI voter
  w = world();
  w.cits.seat.holdings = [{ state: 1, finalTs: BigInt(2 ** 40) }];
  w.herald.add(w.cits.seat);
  s = await cast(w, [['ai0', 2, 'ai'], ['ai1', 2, 'ai']]);
  assert.equal(s.adopted, true, 'no eligible human in nation 0');
  // fail closed: a herald outage at the close does not switch the rule off
  w = world();
  w.open();
  w.clock.set(C0 + 3);
  await w.aiBallot(w.cits.ai0, 2);
  await w.aiBallot(w.cits.ai1, 2);
  w.herald.down = true;
  w.clock.set(C0 + 6);
  await w.social.tick();
  assert.equal(w.social.council.publicState(0).reason, 'human_present');
  // the watcher can name humans the service has not seen
  w = world();
  w.cits.seat.holdings = [];
  w.herald.add(w.cits.seat);
  w.open({ humans: [w.cits.alice.b58] });
  w.clock.set(C0 + 3);
  await w.aiBallot(w.cits.ai0, 2);
  await w.aiBallot(w.cits.ai1, 2);
  w.clock.set(C0 + 6);
  await w.social.tick();
  assert.equal(w.social.council.publicState(0).reason, 'human_present');
});

test('eligibility by an explicit set (the watcher fixes it at C0) overrides the herald-based check', async () => {
  const w = world();
  w.open({ eligible: [w.cits.alice.b58, w.cits.ai0.b58] });
  await refused(w.motion(w.cits.carl, 1), 'NotEligible');
  assert.ok((await w.motion(w.cits.alice, 1)).ok);
  w.clock.set(C0 + 3);
  assert.ok((await w.ballot(w.cits.alice, 1)).ok);
  await refused(w.ballot(w.cits.carl, 1), 'NotEligible');
});

test('the sealed Call: seal draws the nonce, publishes only call_commit; members read it with a signed read; the open record at S + 2', async () => {
  const fixed = [];
  const w = world({ fixCall: async info => { fixed.push(info); return { tile: 17, invited: ['9007199254740993', '12', '13'] }; } });
  const s = await cast(w, [['ai0', 2, 'ai'], ['alice', 2, 'human'], ['ai1', 3, 'ai']]);
  assert.equal(s.adopted, true);
  assert.equal(fixed.length, 1);
  assert.deepEqual({ ...fixed[0], voters: undefined }, { faction: 0, period: K, c0: C0, option: 2, kind: 'camp', p: 4, q: 0, voters: undefined });
  assert.deepEqual(fixed[0].voters[2].sort(), [w.cits.ai0.b58, w.cits.alice.b58].sort(), 'the watcher sees who voted for the winner (for the invited order)');
  assert.deepEqual(fixed[0].voters[3], [w.cits.ai1.b58]);
  const commit = callCommit({ option: 2, p: 4, q: 0, tile: 17 }, NONCE);
  assert.equal(s.call_commit, commit);
  assert.equal(w.file('current.json').nations[0].call_commit, commit);
  assert.equal(w.file('current.json').nations[0].S, 60);
  // public views never carry the target before the open
  const pub = JSON.stringify([w.social.council.publicState(0), w.file(`${K}-0.json`)]);
  assert.ok(!pub.includes(NONCE) && !pub.includes('"tile"') && !pub.includes('9007199254740993'), 'no nonce, tile or invited host in a public file');
  assert.equal(w.file(`${K}-0.json`).open, undefined);
  // member read through the routes
  const reads = (c, f = {}) => get(w.social, '/f/ai/council/call', w.b.callRead(c, { period: K, ...f }));
  let r = await reads(w.cits.alice);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { period: K, option: 2, kind: 'camp', p: 4, q: 0, tile: 17, strike_bell: 60, follow_from: 54, invited: ['9007199254740993', '12', '13'], nonce: NONCE, call_commit: commit });
  // an AI of the nation and a script bot of the nation are members too (the bots read the Call, §6.6)
  assert.equal((await reads(w.cits.ai0)).status, 200);
  assert.equal((await reads(w.cits.bot)).status, 200);
  // a third read of the same wallet in the same bell is rate limited (≤ 2 per bell)
  assert.equal((await reads(w.cits.alice)).status, 200);
  r = await reads(w.cits.alice);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'RateLimited');
  // a citizen of another nation: NotMember
  r = await reads(w.cits.bob, { faction: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NotMember');
  // a forged read: signed by someone else's session key
  r = await reads(w.cits.carl, { signer: w.cits.alice });
  assert.equal(r.body.code, 'BadSignature');
  // stale unix
  r = await reads(w.cits.carl, { unix: w.clock.unix() - 601 });
  assert.equal(r.body.code, 'BellSkew');
  // a period without a Call
  r = await reads(w.cits.carl, { period: K + 1 });
  assert.equal(r.body.code, 'WindowClosed');
  // memberCall for the mind's memberView
  assert.equal(w.social.memberCall(0).tile, 17);
  assert.equal(w.social.memberCall(0, K).call_commit, commit);
  assert.equal(w.social.memberCall(1), null);
  // S + 2: the opening
  w.clock.set(60 + 2 - 1);
  await w.social.tick();
  assert.equal(w.file(`${K}-0.json`).open, undefined, 'not before S + 2');
  w.clock.set(62);
  await w.social.tick();
  const f = w.file(`${K}-0.json`);
  assert.deepEqual({ ...f.open, ballots: undefined }, { option: 2, kind: 'camp', p: 4, q: 0, tile: 17, nonce: NONCE, invited: ['9007199254740993', '12', '13'], tally: { 0: 0, 1: 0, 2: 2, 3: 1 }, ballots: undefined });
  // every ballot's bytes hash to its earlier leaf (M3), and the commit opens
  assert.equal(f.open.ballots.length, 3);
  w.social.closeBell(C0 + 3);
  const talk = JSON.parse(readFileSync(join(w.dir.pub, 'talk', `${C0 + 3}.json`), 'utf8'));
  const leaves = new Set(talk.records.filter(x => x.type === 'ballot').map(x => x.inner));
  for (const b of f.open.ballots) {
    assert.equal(toHex(sha256(fromBase64(b.bytes_b64), fromBase64(b.sig_b64))), b.inner);
    assert.ok(leaves.has(b.inner), 'the opened ballot is the leaf published earlier');
  }
  assert.equal(callCommit({ option: f.open.option, p: f.open.p, q: f.open.q, tile: f.open.tile }, f.open.nonce), f.call_commit);
  // the result is the watcher's
  w.social.council.setResult(0, K, { present: 3, bounced: 0, clash: { engagements: 1, lost: { 0: 40, 4: 120 } } });
  assert.equal(w.file(`${K}-0.json`).result.present, 3);
  assert.equal(w.social.memberCall(0).opened, true);
});

test('without fixCall the watcher seals: errors for unadopted, double seal, too many invited; an unsealed Call is not readable', async () => {
  const w = world();
  await cast(w, [['ai0', 2, 'ai'], ['alice', 2, 'human']]);
  const p = w.social.council.publicState(0);
  assert.equal(p.adopted, true);
  assert.equal(p.call_commit, null, 'adopted, not sealed yet');
  assert.equal(p.strike_bell, 60);
  const r = await get(w.social, '/f/ai/council/call', w.b.callRead(w.cits.alice, { period: K }));
  assert.equal(r.body.code, 'WindowClosed');
  assert.throws(() => w.social.council.seal(0, K, { tile: 1, invited: new Array(7).fill('1') }), /at most 6/);
  assert.throws(() => w.social.council.seal(0, K, { tile: 'x', invited: [] }), /tile/);
  assert.throws(() => w.social.council.seal(0, 9, { tile: 1, invited: [] }), /no adopted/);
  const sealed = w.social.council.seal(0, K, { tile: 5, invited: [] });
  assert.equal(sealed.strike_bell, 60);
  assert.equal(sealed.call_commit, callCommit({ option: 2, p: 4, q: 0, tile: 5 }, NONCE));
  assert.throws(() => w.social.council.seal(0, K, { tile: 5, invited: [] }), /sealed already/);
  assert.equal((await get(w.social, '/f/ai/council/call', w.b.callRead(w.cits.alice, { period: K }))).status, 200);
  // not adopted: nothing to seal
  const n = world();
  await cast(n, [['ai0', 2, 'ai']]);
  assert.throws(() => n.social.council.seal(0, K, { tile: 5, invited: [] }), /no adopted/);
  assert.equal(n.social.memberCall(0), null);
  assert.equal((await get(n.social, '/f/ai/council/call', n.b.callRead(n.cits.alice, { period: K }))).body.code, 'WindowClosed');
});

test('events for the watcher and chronicle: open, motion, ballot, closed, sealed, opened; nothing secret in them', async () => {
  const w = world({ fixCall: async () => ({ tile: 3, invited: ['1'] }) });
  const seen = [];
  w.social.subscribe(e => { if (e.type !== 'record' && e.type !== 'closed') seen.push(e); });
  w.open();
  await w.motion(w.cits.alice, 2);
  w.clock.set(C0 + 3);
  await w.ballot(w.cits.alice, 2);
  await w.aiBallot(w.cits.ai0, 2);
  w.clock.set(C0 + 6);
  await w.social.tick();
  w.clock.set(62);
  await w.social.tick();
  assert.deepEqual(seen.map(e => e.type), ['council_open', 'motion', 'ballot', 'ballot', 'council_closed', 'call_sealed', 'call_opened']);
  const text = JSON.stringify(seen);
  assert.ok(!text.includes(NONCE) && !text.includes('"tile"'), 'events carry no tile or nonce');
  assert.equal(seen.find(e => e.type === 'call_sealed').call_commit, callCommit({ option: 2, p: 4, q: 0, tile: 3 }, NONCE));
});

test('restart: the council journal and the records restore periods, ballots, the close, the seal and the opening', async () => {
  const w = world({ fixCall: async () => ({ tile: 9, invited: ['7', '8'] }) });
  await cast(w, [['ai0', 2, 'ai'], ['alice', 2, 'human']]);
  await w.motion(w.cits.carl, 1).catch(() => {});
  w.clock.set(62);
  await w.social.tick();
  w.social.council.setResult(0, K, { present: 1 });
  const before = { state: w.social.council.publicState(0), call: w.social.memberCall(0), file: w.file(`${K}-0.json`) };
  const again = createSocial({ herald: w.herald, aiDir: w.dir.dir, roster: w.roster, clock: w.clock, provenance: () => null, config: CFG, season: SEASON });
  assert.deepEqual({ ...again.council.publicState(0), state: 'closed' }, { ...before.state, state: 'closed' });
  assert.deepEqual(again.memberCall(0), before.call);
  assert.equal(again.council.publicState(0).ballots_cast, 2);
  assert.ok(again.council.publicState(0).open, 'the opening is restored');
  assert.equal(again.council.publicState(0).result.present, 1);
  await refused(again.book.submit('ballot', w.b.ballot(w.cits.carl, { period: K, option: 1, candidates_hash: CH }).body), 'WindowClosed');
});

test('restart in the ballot window: a restored ballot and motion still block a second one', async () => {
  const w = world();
  w.open();
  await w.motion(w.cits.alice, 1);
  w.clock.set(C0 + 3);
  await w.ballot(w.cits.alice, 2);
  const again = createSocial({ herald: w.herald, aiDir: w.dir.dir, roster: w.roster, clock: w.clock, provenance: () => null, config: CFG, season: SEASON });
  assert.equal(again.council.publicState(0).ballots_cast, 1);
  assert.equal(again.council.publicState(0).motions.length, 1);
  await refused(again.book.submit('ballot', w.b.ballot(w.cits.alice, { period: K, option: 3, candidates_hash: CH }).body), 'Duplicate');
  w.clock.set(C0 + 1);
  await refused(again.book.submit('talk', w.b.talk(w.cits.alice, { channel: 1, target: 0, kind: 1, ref: motionRef(K, 2), text: 'again' }).body), 'Duplicate');
});
