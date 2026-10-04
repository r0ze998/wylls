// AC4: the record book (contract §6.1–§6.3, §6.8): signatures and the session
// against a fake /h/me, seq, bell skew, per-citizen limits, AI provenance
// (single use, ±1 bell, signed-ready text), origins, the sanitiser, per-bell
// roots and files, redaction, restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeTalk, fromBase64, fromHex, seqOf, toHex } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { Refusal, createBook, defaultSanitize } from '../citizens/social/book.mjs';
import { socialRoot } from '../citizens/social/merkle.mjs';
import { SEASON, builders, fakeHerald, makeCitizen, makeClock, tmpAiDir } from './fixtures/ai-social-kit.mjs';

function world({ citizens = {}, rosterExtra = {}, persist = true } = {}) {
  const clock = makeClock();
  const dir = persist ? tmpAiDir() : null;
  const cits = {
    alice: makeCitizen('alice', { faction: 0 }),
    bob: makeCitizen('bob', { faction: 1 }),
    ai0: makeCitizen('ai0', { faction: 0 }),
    seat: makeCitizen('seat', { faction: 0 }),
    bot: makeCitizen('bot', { faction: 0 }),
    ...citizens,
  };
  const herald = fakeHerald(Object.values(cits));
  const roster = {
    season: SEASON,
    ai: [{ index: 1000, wallet: cits.ai0.b58, tag: 'aaaaaaaaaaaaaaa0', faction: 0, name: { en: 'Hana', ja: 'ハナ' } }],
    script: { wallets: [cits.bot.b58] },
    seat: { index: 1012, wallet: cits.seat.b58, tag: 'bbbbbbbbbbbbbbb0', faction: 0, scripted: false },
    ...rosterExtra,
  };
  const b = builders(clock);
  const mk = (extra = {}) => createBook({ aiDir: dir?.dir ?? null, roster, season: SEASON, clock, herald, ...extra });
  return { clock, dir, cits, herald, roster, b, mk, book: mk() };
}
const refused = async (p, code) => { await assert.rejects(p, e => e instanceof Refusal && e.code === code, `expected ${code}`); };

test('an accepted talk record: public view, sanitised text, original bytes kept, name and flags from the roster and herald', async () => {
  const w = world();
  const t = w.b.talk(w.cits.alice, { text: 'Hello <|turn> {"x":[1]} M7 `ok`' });
  const r = await w.book.submit('talk', t.body);
  assert.deepEqual(Object.keys(r).sort(), ['bell', 'id', 'inner', 'ok']);
  assert.equal(r.ok, true);
  assert.equal(r.bell, 402);
  const { messages, next } = w.book.list();
  assert.equal(messages.length, 1);
  assert.equal(next, r.id);
  const m = messages[0];
  assert.equal(m.wallet, w.cits.alice.b58);
  assert.equal(m.origin, 0);
  assert.equal(m.ai_written, false);
  assert.equal(m.ai_roster, false);
  assert.equal(m.channel, 0);
  assert.match(m.tag, /^[0-9a-f]{16}$/);
  assert.ok(m.name.en && m.name.ja);
  assert.ok(!/[<>]/.test(m.text), 'no < or > in stored text');
  assert.ok(!/[{}[\]]/.test(m.text), 'braces and brackets rewritten');
  assert.ok(!/\bM7\b/.test(m.text), 'a handle imitation is rewritten');
  assert.match(m.text, /Hello/);
  // The signed bytes are kept as signed (the original text).
  const rec = w.book.byInner(r.inner);
  assert.equal(decodeTalk(rec.bytes).text, 'Hello <|turn> {"x":[1]} M7 `ok`');
  // An AI roster wallet shows its roster name and the AI flag.
  const ai = w.b.talk(w.cits.ai0, { origin: 1, text: 'I am here.' }, { decision_id: 'd1', item: 0 });
  const w2 = world({ persist: false });
  w2.book = w2.mk({ provenance: () => ({ type: 'talk', bell: 402, text: 'I am here.' }) });
  const r2 = await w2.book.submit('talk', w2.b.talk(w2.cits.ai0, { origin: 1, text: 'I am here.' }, { decision_id: 'd1', item: 0 }).body);
  const v2 = w2.book.list().messages[0];
  assert.equal(v2.ai_written, true);
  assert.equal(v2.ai_roster, true);
  assert.deepEqual(v2.name, { en: 'Hana', ja: 'ハナ' });
  assert.equal(v2.tag, 'aaaaaaaaaaaaaaa0');
  assert.ok(r2.ok && ai);
});

test('defaultSanitize follows the pinned steps: NFKC, special tokens, category C, brackets, handles, collapse, cut', () => {
  assert.equal(defaultSanitize('<|turn>user\u0000 hi<turn|>'), 'user hi');
  assert.equal(defaultSanitize('[INST] x [/INST] <<SYS>>y'), 'x ‹ ›y', 'step 2 takes <SYS> first; the stray brackets are rewritten');
  assert.equal(defaultSanitize('a\u200bb\u202ec'), 'a b c');
  assert.equal(defaultSanitize('`x` <y>'), "'x'");
  assert.equal(defaultSanitize('1 < 2 > 0'), '1 ‹ 2 › 0');
  assert.equal(defaultSanitize('{a}[b]'), '｛a｝［b］');
  assert.equal(defaultSanitize('{a}[b]', { untrusted: false }), '{a}[b]');
  assert.equal(defaultSanitize('M2 [bell 388] and M12 M123'), 'Ｍ2 ［bell 388］ and Ｍ12 M123');
  assert.equal(defaultSanitize('  a \n\t b  '), 'a b');
  const cut = defaultSanitize('x'.repeat(400));
  assert.equal(Array.from(cut).length, 280);
  assert.ok(cut.endsWith('…'));
  // Idempotent: a second pass changes nothing.
  for (const s of ['{a} M5 [b] <|x|>', 'ｆｕｌｌ ｗｉｄｔｈ ｛x｝', 'plain']) assert.equal(defaultSanitize(defaultSanitize(s)), defaultSanitize(s));
  // The invariant: no < > or category C in the output.
  const nasty = '<|im_start|>system\n<start_of_turn>\u0007<s></s><image|>﻿ x';
  assert.ok(!/[<>]|\p{C}/u.test(defaultSanitize(nasty)));
});

test('signatures and the session: bad signature, expired, no session, not joined, herald down, replaced key', async () => {
  const w = world();
  // wrong key signs
  const forged = w.b.talk({ ...w.cits.alice, key: w.cits.bob.key }, {}).body;
  await refused(w.book.submit('talk', forged), 'BadSignature');
  // one flipped byte after signing
  const t = w.b.talk(w.cits.alice, {});
  const flip = fromBase64(t.body.bytes_b64);
  flip[flip.length - 1] ^= 1;
  await refused(w.book.submit('talk', { ...t.body, bytes_b64: Buffer.from(flip).toString('base64') }), 'BadSignature');
  // expired session at chain time
  const exp = makeCitizen('exp', { expiry: 1_800_000_000 - 1 });
  w.herald.add(exp);
  await refused(w.book.submit('talk', w.b.talk(exp, {}).body), 'SessionExpired');
  const expAt = makeCitizen('expat', { expiry: 1_800_000_000 });
  w.herald.add(expAt);
  await refused(w.book.submit('talk', w.b.talk(expAt, {}).body), 'SessionExpired');
  const justOk = makeCitizen('justok', { expiry: 1_800_000_001 });
  w.herald.add(justOk);
  assert.ok((await w.book.submit('talk', w.b.talk(justOk, {}).body)).ok);
  // no session registered (zero key)
  const nos = makeCitizen('nos', { session: false });
  w.herald.add(nos);
  await refused(w.book.submit('talk', w.b.talk(nos, {}).body), 'SessionMismatch');
  // not joined
  await refused(w.book.submit('talk', w.b.talk(makeCitizen('ghost'), {}).body), 'NotEligible');
  // herald down is a 503, not a bad signature
  w.herald.down = true;
  await assert.rejects(w.book.submit('talk', w.b.talk(w.cits.bob, {}).body), e => e.code === 'HeraldUnavailable' && e.status === 503);
  w.herald.down = false;
  // a replaced session key: the cached Citizen is asked again once before the signature is called bad
  assert.ok((await w.book.submit('talk', w.b.talk(w.cits.bob, { seq: seqOf(402, 0) }).body)).ok);
  const callsBefore = w.herald.calls;
  const old = w.cits.bob.key;
  w.cits.bob.key = (await import('../citizens/social/vectors.mjs')).testKey('session/bob-rotated');
  const rotated = w.b.talk(w.cits.bob, { seq: seqOf(402, 1) });
  assert.ok((await w.book.submit('talk', rotated.body)).ok, 'the new key is accepted after a refetch');
  assert.ok(w.herald.calls > callsBefore);
  await refused(w.book.submit('talk', w.b.talk({ ...w.cits.bob, key: old }, { seq: seqOf(402, 2) }).body), 'BadSignature');
});

test('malformed posts: not an object, missing fields, bad base64, short signature, wrong type, other season', async () => {
  const w = world();
  const good = w.b.talk(w.cits.alice, {});
  for (const body of [null, [], 'x', {}, { bytes_b64: 1, sig_b64: 'a' }]) await refused(w.book.submit('talk', body), 'BadBytes');
  await refused(w.book.submit('talk', { ...good.body, bytes_b64: '***' }), 'BadBytes');
  await refused(w.book.submit('talk', { ...good.body, sig_b64: Buffer.from('short').toString('base64') }), 'BadBytes');
  await refused(w.book.submit('ballot', good.body), 'BadBytes');
  const other = builders(w.clock, SEASON + 1).talk(w.cits.alice, {});
  await refused(w.book.submit('talk', other.body), 'BadBytes');
  await refused(w.book.submit('talk', { ...good.body, decision_id: '', item: 0 }), 'BadBytes');
  await refused(w.book.submit('talk', { ...good.body, decision_id: 'x' }), 'BadBytes');
  const long = new Uint8Array(1200);
  long.set(fromBase64(good.body.bytes_b64));
  await refused(w.book.submit('talk', { ...good.body, bytes_b64: Buffer.from(long).toString('base64') }), 'BadBytes');
});

test('bell skew ±1, filed under the acceptance bell; seq strictly increases per wallet', async () => {
  const w = world();
  const a = w.cits.alice;
  assert.equal((await w.book.submit('talk', w.b.talk(a, { bell: 401 }).body)).bell, 402, 'filed under the acceptance bell, not the claimed one');
  assert.equal((await w.book.submit('talk', w.b.talk(a, { bell: 403 }).body)).bell, 402);
  await refused(w.book.submit('talk', w.b.talk(a, { bell: 404, seq: seqOf(404, 0) }).body), 'BellSkew');
  await refused(w.book.submit('talk', w.b.talk(a, { bell: 400, seq: seqOf(400, 0) }).body), 'BellSkew');
  // seq: the second record above used 403<<4 (the first 401<<4, so it rose); now equal and lower are replays
  const last = seqOf(403, 0);
  await refused(w.book.submit('talk', w.b.talk(a, { seq: last }).body), 'SeqReplay');
  await refused(w.book.submit('talk', w.b.talk(a, { seq: last - 1 }).body), 'SeqReplay');
  assert.ok((await w.book.submit('talk', w.b.talk(a, { seq: last + 1 }).body)).ok);
  // another wallet has its own counter
  assert.ok((await w.book.submit('talk', w.b.talk(w.cits.bob, { seq: 1 }).body)).ok);
  // before the season starts (no bell)
  w.clock.bell = () => null;
  await refused(w.book.submit('talk', w.b.talk(a, { seq: last + 9, bell: 402 }).body), 'BellSkew');
});

test('limits: 3 talk per bell, 40 per game day, for humans and AIs alike; the counts are per wallet', async () => {
  const w = world();
  const a = w.cits.alice;
  for (let i = 0; i < 3; i++) assert.ok((await w.book.submit('talk', w.b.talk(a, {}).body)).ok);
  await refused(w.book.submit('talk', w.b.talk(a, {}).body), 'RateLimited');
  assert.ok((await w.book.submit('talk', w.b.talk(w.cits.bob, {}).body)).ok, 'another wallet is not limited by alice');
  // 13 more bells of 3 = 39 more; the day total 3 + 39 = 42 > 40: the 40th passes, the 41st does not
  let accepted = 3;
  let bell = 402;
  let limited = false;
  while (!limited && bell < 402 + 20) {
    bell++;
    w.clock.set(bell);
    for (let i = 0; i < 3 && !limited; i++) {
      try { await w.book.submit('talk', w.b.talk(a, {}).body); accepted++; } catch (e) { assert.equal(e.code, 'RateLimited'); limited = true; }
    }
  }
  assert.equal(accepted, 40, 'the 41st message of the game day is refused');
  // the next game day starts at bell 432 (day = floor(bell / 144), day 2 starts at 432)
  w.clock.set(432);
  assert.ok((await w.book.submit('talk', w.b.talk(a, {}).body)).ok, 'a new game day');
});

test('AI provenance: origin 1, a decision_id and an item; the mind\'s signed-ready text; ±1 bell; single use', async () => {
  const outputs = new Map();
  const consumed = [];
  const w = world({ persist: false });
  const prov = { provenance: (id, item, type) => outputs.get(`${id}|${item}|${type}`) ?? null, consume: (id, item) => consumed.push([id, item]) };
  const book = w.mk({ provenance: prov });
  outputs.set('d1|0|talk', { type: 'talk', bell: 402, text: 'Peace to the river camps.', channel: 0, kind: 0, lang: 'en' });
  const ai = w.cits.ai0;
  const say = (f, extra) => w.b.talk(ai, { origin: 1, text: 'Peace to the river camps.', ...f }, extra);
  // origin must be 1
  await refused(book.submit('talk', say({ origin: 0 }, { decision_id: 'd1', item: 0 }).body), 'NotFromMind');
  // decision_id and item are required
  await refused(book.submit('talk', say({}).body), 'NotFromMind');
  // unknown decision
  await refused(book.submit('talk', say({}, { decision_id: 'nope', item: 0 }).body), 'NotFromMind');
  // another item of the same decision is not the output
  await refused(book.submit('talk', say({}, { decision_id: 'd1', item: 1 }).body), 'NotFromMind');
  // text that is not the signed-ready output
  await refused(book.submit('talk', say({ text: 'War to the river camps.' }, { decision_id: 'd1', item: 0 }).body), 'NotFromMind');
  // a field the mind pinned differs (channel)
  await refused(book.submit('talk', say({ channel: 1, target: 0 }, { decision_id: 'd1', item: 0 }).body), 'NotFromMind');
  // the decision is more than one bell from the record
  outputs.set('old|0|talk', { type: 'talk', bell: 399, text: 'x' });
  await refused(book.submit('talk', say({ text: 'x' }, { decision_id: 'old', item: 0 }).body), 'NotFromMind');
  outputs.set('edge|0|talk', { type: 'talk', bell: 401, text: 'y' });
  assert.ok((await book.submit('talk', say({ text: 'y' }, { decision_id: 'edge', item: 0 }).body)).ok, 'one bell apart is fine');
  // the right one
  const r = await book.submit('talk', say({}, { decision_id: 'd1', item: 0 }).body);
  assert.ok(r.ok);
  assert.deepEqual(consumed.at(-1), ['d1', 0]);
  // single use: a repeat (even a fresh seq) is a Duplicate, and nothing more is stored
  const n = book.records.length;
  await refused(book.submit('talk', say({}, { decision_id: 'd1', item: 0 }).body), 'Duplicate');
  assert.equal(book.records.length, n);
  // a ballot output is not accepted for a talk record
  outputs.set('b1|0|talk', { type: 'ballot', bell: 402, option: 1 });
  await refused(book.submit('talk', say({}, { decision_id: 'b1', item: 0 }).body), 'NotFromMind');
  // the wallet or tag pinned by the mind must match
  outputs.set('w1|0|talk', { type: 'talk', bell: 402, text: 'z', tag: 'ffffffffffffffff' });
  await refused(book.submit('talk', say({ text: 'z' }, { decision_id: 'w1', item: 0 }).body), 'NotFromMind');
});

test('a bare provenance function works too, and the book remembers the use itself', async () => {
  const w = world({ persist: false });
  const book = w.mk({ provenance: () => ({ bell: 402, text: 'hi' }) });
  const ai = w.cits.ai0;
  assert.ok((await book.submit('talk', w.b.talk(ai, { origin: 1, text: 'hi' }, { decision_id: 'd', item: 3 }).body)).ok);
  await refused(book.submit('talk', w.b.talk(ai, { origin: 1, text: 'hi' }, { decision_id: 'd', item: 3 }).body), 'Duplicate');
  // an async provenance is awaited
  const book2 = w.mk({ provenance: async () => ({ bell: 402, text: 'hi' }) });
  assert.ok((await book2.submit('talk', w.b.talk(ai, { origin: 1, text: 'hi', seq: seqOf(402, 9) }, { decision_id: 'e', item: 0 }).body)).ok);
});

test('origins: humans may self-declare 1 (never the AI badge); 2 only from the scripted seat; script bots never post', async () => {
  const w = world({ persist: false });
  // a human with origin 1: stored as AI-assisted (self-declared), ai_roster stays false
  assert.ok((await w.book.submit('talk', w.b.talk(w.cits.alice, { origin: 1, text: 'drafted with a helper' }).body)).ok);
  const m = w.book.list().messages[0];
  assert.equal(m.ai_written, true);
  assert.equal(m.ai_roster, false);
  // origin 2 from a human
  await refused(w.book.submit('talk', w.b.talk(w.cits.bob, { origin: 2 }).body), 'NotEligible');
  // the seat: origin 0 live; origin 2 only when the roster says the seat is scripted
  assert.ok((await w.book.submit('talk', w.b.talk(w.cits.seat, { origin: 0 }).body)).ok);
  await refused(w.book.submit('talk', w.b.talk(w.cits.seat, { origin: 2 }).body), 'NotEligible');
  const scripted = world({ persist: false, rosterExtra: {} });
  scripted.roster.seat.scripted = true;
  assert.ok((await scripted.book.submit('talk', scripted.b.talk(scripted.cits.seat, { origin: 2 }).body)).ok);
  assert.equal(scripted.book.list().messages[0].ai_written, false, 'origin 2 is scripted, not AI-written');
  // a script bot
  await refused(w.book.submit('talk', w.b.talk(w.cits.bot, {}).body), 'NotEligible');
  // origin outside 0..2 cannot even be encoded; on the wire it is BadBytes
  const t = w.b.talk(w.cits.alice, {});
  const raw = fromBase64(t.body.bytes_b64);
  raw[80] = 3; // TAG 22 + season 8 + bell 4 + wallet 32 + seq 4 + channel 1 + kind 1 + ref 8 = 80: the origin byte of a world message
  await refused(w.book.submit('talk', { ...t.body, bytes_b64: Buffer.from(raw).toString('base64') }), 'BadBytes');
});

test('channels: a nation message goes to the sender\'s own nation; a direct message to an AI is flagged recipient_ai; inbox and channel filters', async () => {
  const w = world({ persist: false });
  const book = w.mk({ provenance: null });
  await refused(book.submit('talk', w.b.talk(w.cits.alice, { channel: 1, target: 3 }).body), 'NotMember');
  assert.ok((await book.submit('talk', w.b.talk(w.cits.alice, { channel: 1, target: 0, text: 'nation 0' }).body)).ok);
  const d = await book.submit('talk', w.b.talk(w.cits.alice, { channel: 3, target: w.cits.ai0.wallet, text: 'dm to ai' }).body);
  assert.equal(d.recipient_ai, true);
  const d2 = await book.submit('talk', w.b.talk(w.cits.alice, { channel: 3, target: w.cits.bob.wallet, text: 'dm to bob' }).body);
  assert.equal(d2.recipient_ai, undefined);
  assert.ok((await book.submit('talk', w.b.talk(w.cits.bob, { channel: 0, text: 'world' }).body)).ok);
  assert.deepEqual(book.list({ channel: 3 }).messages.map(m => m.text), ['dm to ai', 'dm to bob'], 'direct means addressed, not private: every channel is public');
  assert.deepEqual(book.list({ channel: 1 }).messages.map(m => m.text), ['nation 0']);
  assert.equal(book.list({ limit: 2 }).messages.length, 2);
  const first = book.list({ limit: 2 });
  assert.deepEqual(first.messages.map(m => m.text), ['nation 0', 'dm to ai']);
  assert.deepEqual(book.list({ after: first.next }).messages.map(m => m.text), ['dm to bob', 'world']);
  const inboxAi = await book.inbox({ wallet: w.cits.ai0.b58 });
  assert.deepEqual(inboxAi.messages.map(m => m.text), ['nation 0', 'dm to ai'], 'the AI\'s nation channel and its direct message');
  const inboxBob = await book.inbox({ wallet: w.cits.bob.b58 });
  assert.deepEqual(inboxBob.messages.map(m => m.text), ['dm to bob']);
  // an unknown wallet has an empty inbox
  assert.deepEqual((await book.inbox({ wallet: w.cits.alice.b58, after: 99 })).messages, []);
});

test('closeBell: root over the bell\'s records in acceptance order; file once; latest.json; empty bells; earlier bells close first; a late record is filed in the next bell', async () => {
  const w = world();
  const { book, b, cits, clock, dir } = w;
  const r1 = await book.submit('talk', b.talk(cits.alice, { text: 'one' }).body);
  const r2 = await book.submit('talk', b.talk(cits.bob, { text: 'two' }).body);
  const r3 = await book.submit('talk', b.talk(cits.alice, { text: 'three' }).body);
  clock.advance();
  const r4 = await book.submit('talk', b.talk(cits.bob, { text: 'four' }).body);
  const c = book.closeBell(402);
  assert.equal(c.bell, 402);
  assert.equal(c.count, 3);
  assert.equal(c.root, toHex(socialRoot([r1, r2, r3].map(r => ({ inner: r.inner })))));
  const file = JSON.parse(readFileSync(join(dir.pub, 'talk', '402.json'), 'utf8'));
  assert.equal(file.bell, 402);
  assert.equal(file.root, c.root);
  assert.deepEqual(file.records.map(r => r.inner), [r1.inner, r2.inner, r3.inner]);
  for (const rec of file.records) {
    assert.equal(rec.type, 'talk');
    assert.ok(rec.bytes_b64 && rec.sig_b64);
  }
  assert.equal(JSON.parse(readFileSync(join(dir.pub, 'talk', 'latest.json'), 'utf8')).bell, 402);
  // once: a second call changes nothing and returns the same
  assert.equal(book.closeBell(402), c);
  // a late record (clock still in 403 but bell 403 not closed): filed in 403; once 403 is closed, a record arriving with the clock behind goes to 404
  clock.set(402);
  const late = await book.submit('talk', b.talk(cits.alice, { text: 'late', seq: seqOf(402, 14) }).body);
  assert.equal(late.bell, 403, 'bell 402 is closed: the record is filed under the next open bell');
  // empty bells: zero root; closing 406 closes 403..406 in order
  const c6 = book.closeBell(406);
  assert.equal(c6.bell, 406);
  assert.equal(c6.count, 0);
  assert.equal(c6.root, '0'.repeat(64));
  for (const x of [403, 404, 405, 406]) assert.ok(existsSync(join(dir.pub, 'talk', `${x}.json`)), `bell ${x} written`);
  const f403 = JSON.parse(readFileSync(join(dir.pub, 'talk', '403.json'), 'utf8'));
  assert.deepEqual(f403.records.map(r => r.inner), [r4.inner, late.inner]);
  assert.equal(JSON.parse(readFileSync(join(dir.pub, 'talk', 'latest.json'), 'utf8')).bell, 406);
  // the ballots-as-leaves shape is covered in the council tests
  void dir;
});

test('redaction: a tombstone blanks text and bytes in the API and in the files; the root still verifies from inner', async () => {
  const w = world();
  const { book, b, cits, dir } = w;
  const r1 = await book.submit('talk', b.talk(cits.alice, { text: 'keep me' }).body);
  const r2 = await book.submit('talk', b.talk(cits.bob, { text: 'forget me' }).body);
  const closed = book.closeBell(402);
  mkdirSync(dir.pub, { recursive: true });
  writeFileSync(join(dir.pub, 'redactions.json'), JSON.stringify([{ inner: r2.inner, bell: 402, reason: 'operator request' }]));
  const msgs = book.list().messages;
  assert.equal(msgs[0].text, 'keep me');
  assert.equal(msgs[1].text, '');
  assert.equal(msgs[1].redacted, true);
  const file = JSON.parse(readFileSync(join(dir.pub, 'talk', '402.json'), 'utf8'));
  assert.equal(file.root, closed.root, 'the root is unchanged');
  const red = file.records.find(r => r.inner === r2.inner);
  assert.equal(red.redacted, true);
  assert.equal(red.bytes_b64, '');
  assert.equal(red.sig_b64, '');
  assert.ok(file.records.find(r => r.inner === r1.inner).bytes_b64.length > 10);
  assert.equal(book.byInner(r2.inner).bytes, null, 'the bytes are dropped from memory too');
  // the same root is recomputed from inner values only
  assert.equal(toHex(socialRoot(file.records)), file.root);
  // book.redact() merges and persists
  book.redact([{ inner: r1.inner, bell: 402, reason: 'second' }]);
  const stored = JSON.parse(readFileSync(join(dir.pub, 'redactions.json'), 'utf8'));
  assert.deepEqual(stored.map(t => t.inner).sort(), [r1.inner, r2.inner].sort());
  assert.equal(JSON.parse(readFileSync(join(dir.pub, 'talk', '402.json'), 'utf8')).records.every(r => r.redacted), true);
});

test('restart: the journal restores seq, limits, consumed (decision_id, item) and closed bells', async () => {
  const w = world();
  const outputs = { provenance: () => ({ bell: 402, text: 'hi' }) };
  let book = w.mk({ provenance: outputs });
  const r = await book.submit('talk', w.b.talk(w.cits.alice, { text: 'before' }).body);
  await book.submit('talk', w.b.talk(w.cits.ai0, { origin: 1, text: 'hi' }, { decision_id: 'dd', item: 1 }).body);
  const closed = book.closeBell(402);
  const again = w.mk({ provenance: outputs });
  assert.equal(again.records.length, 2);
  assert.equal(again.list().messages[0].text, 'before');
  assert.equal(again.byInner(r.inner).id, r.id);
  assert.equal(again.lastClosed, 402);
  assert.equal(again.closeBell(402).root, closed.root, 'a closed bell is not re-written with another root');
  w.clock.set(404);
  await refused(again.submit('talk', w.b.talk(w.cits.alice, { seq: r.id, bell: 404 }).body), 'SeqReplay');
  await refused(again.submit('talk', w.b.talk(w.cits.ai0, { origin: 1, text: 'hi', bell: 404 }, { decision_id: 'dd', item: 1 }).body), 'Duplicate');
  const fresh = await again.submit('talk', w.b.talk(w.cits.alice, { bell: 404, seq: seqOf(404, 0), text: 'after' }).body);
  assert.ok(fresh.id > r.id + 1, 'ids continue');
  book = null;
});

test('a book needs a clock; the roster may be a function (it appears after the deal)', async () => {
  assert.throws(() => createBook({ season: 1, herald: fakeHerald() }), TypeError);
  const w = world({ persist: false });
  let dealt = false;
  const book = createBook({ roster: () => (dealt ? w.roster : {}), season: SEASON, clock: w.clock, herald: w.herald });
  assert.equal(book.who(w.cits.ai0.b58).kind, 'human', 'before the deal nobody is on the roster');
  dealt = true;
  assert.equal(book.who(w.cits.ai0.b58).kind, 'ai');
  assert.equal(book.who(w.cits.bot.b58).kind, 'script');
  assert.equal(book.who(w.cits.seat.b58).kind, 'seat');
  void fromHex;
});

test('the herald answers are cached briefly: a joined citizen 15 s, a wallet that has not joined only 2 s', async () => {
  const w = world({ persist: false });
  const t = { ms: 0 };
  const book = w.mk({ now: () => t.ms });
  const late = makeCitizen('late', { faction: 0 });
  await refused(book.submit('talk', w.b.talk(late, {}).body), 'NotEligible');
  const calls = w.herald.calls;
  w.herald.add(late);
  await refused(book.submit('talk', w.b.talk(late, {}).body), 'NotEligible');
  assert.equal(w.herald.calls, calls, 'served from the 2 s negative cache');
  t.ms += 2001;
  assert.ok((await book.submit('talk', w.b.talk(late, {}).body)).ok, 'it joined and is accepted once the entry is stale');
  const after = w.herald.calls;
  await book.submit('talk', w.b.talk(late, {}).body);
  assert.equal(w.herald.calls, after, 'a joined citizen is cached');
  t.ms += 15_001;
  await book.submit('talk', w.b.talk(late, {}).body);
  assert.equal(w.herald.calls, after + 1, 'and asked again after 15 s');
});
