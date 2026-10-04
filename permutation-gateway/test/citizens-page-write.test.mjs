// Council page (unit AC7), what the viewer signs and sends (contract §6.1, §6.2, §9.2): keys, talk, ballot and call-read
// records. Real Ed25519 (web/session.mjs keyFromSeed, WebCrypto) and the real record bytes (aisocial.mjs): every
// signature is verified here against the bytes the service would rebuild. No network: `post` and `get` are fakes.
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { keyFromSeed, verify } from '../../permutation-server/web/session.mjs';
import { decodeTalk, decodeBallot, encodeCallRead, fromBase64, toBase58, toBase64, toHex, recordType, ORIGIN, CHANNEL, KIND, splitMotionRef, signRecord } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { parseKeyText, findSavedKeys, makeSigner, signerFaction, signerKind } from '../../permutation-server/web/frontier/council/keys.mjs';
import { nextSeq, buildTalk, sendRecord, normalizeTalk, mergeTalk, filterTalk, outcomeText } from '../../permutation-server/web/frontier/council/feed.mjs';
import { castBallot, buildBallot } from '../../permutation-server/web/frontier/council/ballot.mjs';
import { signCallRead, readCall, normalizeCall, renderCallPanel } from '../../permutation-server/web/frontier/council/call.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { composeNotice, refusalText, noticeAccepted, acceptNotice } from '../../permutation-server/web/frontier/council/notice.mjs';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { t, tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf } from './fixtures/ai-page-dom.mjs';
import { roster, W, T } from './fixtures/ai-page-kit.mjs';

const index = makeRosterIndex(roster());
const seed = crypto.randomBytes(32);
const seedHex = seed.toString('hex');
const unsub = async seedBytes => keyFromSeed(Uint8Array.from(seedBytes));

async function seatSigner() {
  const k = await keyFromSeed(Uint8Array.from(seed));
  return { wallet: W.seat, publicKey: k.publicKey, sign: k.sign, kind: 'seat', faction: 0 };
}

// ------------------------------------------------------------------ keys
test('keys: a seat key file gives the SESSION key only; the wallet secret in the same file is not kept', async () => {
  const k = await keyFromSeed(Uint8Array.from(seed));
  const kp = Buffer.concat([seed, Buffer.from(k.publicKeyBytes)]);
  const walletSecret = crypto.randomBytes(64);
  const file = JSON.stringify({ index: 1003, wallet: W.seat, wallet_keypair_b58: toBase58(walletSecret), session: k.publicKey, session_keypair_b58: toBase58(kp) });
  const p = parseKeyText(file);
  assert.equal(p.ok, true);
  assert.equal(p.source, 'seat-file');
  assert.equal(p.wallet, W.seat);
  assert.equal(p.session, k.publicKey);
  assert.equal(Buffer.from(p.seed).toString('hex'), seedHex);
  const dump = JSON.stringify(p, (kk, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  assert.ok(!dump.includes(toBase58(walletSecret)), 'the wallet keypair is not in the parsed result');
  assert.ok(!('wallet_keypair_b58' in p));
  // a session that does not match its keypair is refused
  assert.equal(parseKeyText(JSON.stringify({ session: W.ai0, session_keypair_b58: toBase58(kp), wallet: W.seat })).code, 'mismatch');
  // not a key file
  for (const bad of ['', '   ', 'hello', '{', '{"a":1}', '{"session_keypair_b58":"zz"}', JSON.stringify({ session_keypair_b58: toBase58(crypto.randomBytes(10)) })]) assert.equal(parseKeyText(bad).ok, false, bad);
  assert.equal(parseKeyText('').code, 'empty');
});

test('keys: a Wylls key backup text and bare hex', async () => {
  const k = await keyFromSeed(Uint8Array.from(seed));
  const backup = `Wylls key\nSeason: 41\nCluster: localnet\nProgram: P\nWallet: ${W.seat}\nSession: ${k.publicKey}\nKey: ${seedHex}\nAnyone holding this key can act as you in this season. Keep it private.\n`;
  const p = parseKeyText(backup);
  assert.deepEqual([p.ok, p.source, p.wallet, p.session], [true, 'backup', W.seat, k.publicKey]);
  assert.equal(parseKeyText(seedHex).source, 'hex');
  assert.equal(parseKeyText(seedHex).wallet, null);
  assert.equal(parseKeyText(`${seedHex}ab`).ok, false, '66 hex digits are not a key');
});

test('keys: makeSigner signs; a wrong stated public key, no wallet and no Ed25519 are refused', async () => {
  const k = await keyFromSeed(Uint8Array.from(seed));
  const ok = await makeSigner({ ok: true, seed: Uint8Array.from(seed), wallet: W.seat, session: k.publicKey }, unsub);
  assert.equal(ok.ok, true);
  const sig = await ok.sign(Uint8Array.of(1, 2, 3));
  assert.equal(await verify(k.publicKey, Uint8Array.of(1, 2, 3), sig), true);
  assert.equal((await makeSigner({ ok: true, seed: Uint8Array.from(seed), wallet: W.seat, session: W.ai0 }, unsub)).code, 'mismatch');
  assert.equal((await makeSigner({ ok: true, seed: Uint8Array.from(seed), wallet: null, session: null }, unsub)).code, 'no_wallet');
  assert.equal((await makeSigner({ ok: true, seed: Uint8Array.from(seed), wallet: W.seat }, async () => { throw new Error('no Ed25519'); })).code, 'nosubtle');
  assert.equal((await makeSigner({ ok: false, code: 'format' }, unsub)).code, 'format');
});

test('keys: the signer\'s faction comes from the roster (the seat), and an AI wallet would be recognised as one', async () => {
  assert.equal(signerFaction(index, { wallet: W.seat }), 0);
  assert.equal(signerFaction(index, { wallet: W.human }), null);
  assert.equal(signerKind(index, { wallet: W.seat }), 'seat');
  assert.equal(signerKind(index, { wallet: W.ai0 }), 'ai');
  assert.equal(signerKind(index, { wallet: W.human }), 'other');
});

test('keys: the key the Frontier client saved in this browser is found by its storage key, and nothing else is', () => {
  const store = new Map([
    [`ps-fsession:localnet:PROG:41:${W.seat}`, seedHex],
    [`ps-fsession:localnet:PROG:41:${W.ai0}`, 'zz'],
    [`ps-fsession:localnet:PROG:40:${W.human}`, seedHex],
    [`ps-fsession:localnet:OTHER:41:${W.human}`, seedHex],
    ['unrelated', seedHex],
  ]);
  const storage = { get length() { return store.size; }, key: i => [...store.keys()][i], getItem: k => store.get(k) ?? null };
  assert.deepEqual(findSavedKeys(storage, { cluster: 'localnet', programId: 'PROG', seasonId: '41' }), [{ wallet: W.seat, seedHex }]);
  assert.deepEqual(findSavedKeys(null, { cluster: 'a', programId: 'b', seasonId: 'c' }), []);
  assert.deepEqual(findSavedKeys({ get length() { throw new Error('blocked'); } }, { cluster: 'a', programId: 'b', seasonId: 'c' }), []);
});

// ------------------------------------------------------------------ talk
test('talk: seq is (bell << 4) | k with k the wallet\'s records already in the bell, and always above the last one', () => {
  const rows = [{ wallet: W.seat, bell: 50 }, { wallet: W.seat, bell: 50 }, { wallet: W.ai0, bell: 50 }, { wallet: W.seat, bell: 49 }];
  assert.equal(nextSeq({ bell: 50, wallet: W.seat, rows }), (50 << 4) | 2);
  assert.equal(nextSeq({ bell: 51, wallet: W.seat, rows }), (51 << 4) | 0);
  assert.equal(nextSeq({ bell: 50, wallet: W.seat, rows, lastSeq: (50 << 4) | 5 }), (50 << 4) | 6);
  assert.equal(nextSeq({ bell: 50, wallet: W.seat, rows: Array.from({ length: 30 }, () => ({ wallet: W.seat, bell: 50 })) }), (50 << 4) | 15);
});

test('talk: a message is origin 0 (a person), signed with the session key, and the service can rebuild and verify the bytes', async () => {
  const signer = await seatSigner();
  const bytes = buildTalk({ season: 41, bell: 50, wallet: signer.wallet, seq: (50 << 4) | 1, channel: 'direct', recipient: W.ai0, text: 'Hello Toa', lang: 'en' });
  assert.equal(recordType(bytes), 'talk');
  const d = decodeTalk(bytes);
  assert.equal(d.origin, ORIGIN.human);
  assert.equal(d.channel, CHANNEL.direct);
  assert.equal(toBase58(d.target), W.ai0);
  assert.equal(d.text, 'Hello Toa');
  assert.equal(d.kind, KIND.say);
  let sent;
  const r = await sendRecord({ bytes, signer, post: async (path, body) => { sent = { path, body }; return { status: 200, json: { ok: true, id: 7, bell: 50, recipient_ai: true } }; }, path: '/f/ai/talk' });
  assert.deepEqual([r.ok, r.id, r.recipientAi], [true, 7, true]);
  assert.equal(sent.path, '/f/ai/talk');
  assert.deepEqual(Object.keys(sent.body).sort(), ['bytes_b64', 'sig_b64'], 'nothing but the bytes and the signature is sent');
  assert.equal(await verify(signer.publicKey, fromBase64(sent.body.bytes_b64), fromBase64(sent.body.sig_b64)), true);
  assert.equal(toBase64(bytes), sent.body.bytes_b64);
  // nation message and motion
  const nat = decodeTalk(buildTalk({ season: 41, bell: 50, wallet: W.seat, seq: 800, channel: 'nation', faction: 0, text: 'x', lang: 'ja' }));
  assert.deepEqual([nat.channel, nat.target, nat.lang], [CHANNEL.nation, 0, 'ja']);
  const mot = decodeTalk(buildTalk({ season: 41, bell: 50, wallet: W.seat, seq: 801, channel: 'nation', faction: 0, text: 'Take the camp', lang: 'en', option: 2, period: 5 }));
  assert.equal(mot.kind, KIND.motion);
  assert.deepEqual(splitMotionRef(mot.ref), { period: 5, option: 2 });
  // refused by the writer, not by the server: text too long, motion to a non-nation channel
  assert.throws(() => buildTalk({ season: 41, bell: 50, wallet: W.seat, seq: 1, channel: 'world', text: 'x'.repeat(281), lang: 'en' }), /at most 280/);
  assert.throws(() => buildTalk({ season: 41, bell: 50, wallet: W.seat, seq: 1, channel: 'world', text: 'x', lang: 'en', option: 1, period: 1 }), /nation channel/);
});

test('talk: refusals map to plain sentences; a network failure and a non-signable byte string are reported, not thrown', async () => {
  const signer = await seatSigner();
  const bytes = buildTalk({ season: 41, bell: 50, wallet: W.seat, seq: 1, channel: 'world', text: 'x', lang: 'en' });
  const refused = await sendRecord({ bytes, signer, post: async () => ({ status: 400, json: { error: 'NotEligible', code: 'NotEligible', detail: 'secret server text' } }), path: '/f/ai/talk' });
  assert.deepEqual([refused.ok, refused.code], [false, 'NotEligible']);
  assert.doesNotMatch(outcomeText(t, refused), /secret server text/, 'the server\'s free text is never printed');
  assert.match(outcomeText(t, refused), /not eligible/);
  assert.match(outcomeText((k, v) => tl('ja', k, v), refused), /資格がありません/);
  assert.equal((await sendRecord({ bytes, signer, post: async () => { throw new Error('down'); }, path: '/f/ai/talk' })).code, 'network');
  assert.equal((await sendRecord({ bytes, signer, post: async () => ({ status: 502, json: null }), path: '/f/ai/talk' })).code, 'network');
  const notSignable = await sendRecord({ bytes: Uint8Array.from([0x80, 1, 2, 3]), signer, post: async () => { throw new Error('must not post'); }, path: '/f/ai/talk' });
  assert.equal(notSignable.ok, false, 'domain separation: bytes that are not a council record are never signed');
  assert.equal(notSignable.code, 'NotSignable');
  assert.match(refusalText(t, 'SomethingNew'), /refused \(SomethingNew\)/);
  assert.equal(refusalText(t, 'RateLimited'), 'too many requests; wait a moment');
});

test('feed rows: normalised, merged by id, filtered by channel; garbage rows dropped', () => {
  const a = normalizeTalk({ messages: [{ id: 2, bell: 5, wallet: W.ai0, tag: T.ai0, origin: 1, channel: 1, target: 0, kind: 0, ref: 0, lang: 'en', text: 'b' }, { id: 1, bell: 4, wallet: W.ai1, tag: T.ai1, origin: 1, channel: 0, target: null, kind: 0, ref: 0, lang: 'en', text: 'a' }, null, { id: 'x' }, { id: 9, channel: 7 }] });
  assert.deepEqual(a.map(r => r.id), [1, 2]);
  assert.deepEqual(filterTalk(a, 'nation').map(r => r.id), [2]);
  assert.deepEqual(mergeTalk(a, [{ ...a[0], text: 'a2' }, { ...a[1], id: 3 }]).map(r => [r.id, r.text]), [[1, 'a2'], [2, 'b'], [3, 'b']]);
  assert.equal(mergeTalk(a, Array.from({ length: 500 }, (_, i) => ({ ...a[0], id: 100 + i }))).length, 300);
  assert.equal(normalizeTalk({ messages: [{ id: 1, bell: 1, channel: 0, text: 'x'.repeat(5000), kind: 0 }] })[0].text.length, 400, 'a long text is cut for display');
});

test('compose notice: writing to an AI citizen is named; a nation or world message says AIs read it; the roster decides', () => {
  assert.deepEqual(composeNotice(index, { channel: 'direct', recipientWallet: W.ai0 }).level, 'ai');
  assert.equal(composeNotice(index, { channel: 'direct', recipientWallet: W.ai0 }).name.en, 'Toa Festead');
  assert.equal(composeNotice(index, { channel: 'direct', recipientWallet: W.human }).level, 'none');
  assert.equal(composeNotice(index, { channel: 'direct', recipientWallet: '' }).level, 'none');
  assert.equal(composeNotice(index, { channel: 'nation' }).level, 'channel');
  assert.equal(composeNotice(index, { channel: 'world' }).level, 'channel');
  assert.equal(composeNotice(makeRosterIndex(null), { channel: 'world' }).level, 'none');
});

test('first-post notice: accepted state is kept in storage when it works and is "not accepted" when it does not', () => {
  const m = new Map();
  const ok = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(noticeAccepted(ok), false);
  assert.equal(acceptNotice(ok), true);
  assert.equal(noticeAccepted(ok), true);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(noticeAccepted(broken), false);
  assert.equal(acceptNotice(broken), false);
  assert.equal(noticeAccepted(undefined), false);
});

// ------------------------------------------------------------------ ballot
test('ballot: origin 0 (a person), the period\'s candidates_hash and a 16-byte nonce; the signature verifies', async () => {
  const signer = await seatSigner();
  const hash = 'ab'.repeat(32);
  let sent;
  const r = await castBallot({ signer, post: async (path, body) => { sent = { path, body }; return { status: 200, json: { ok: true, id: 3, bell: 51, inner: 'x' } }; }, season: 41, period: 2, faction: 0, option: 1, candidatesHash: hash, nonce16: crypto.randomBytes(16) });
  assert.equal(r.ok, true);
  assert.equal(sent.path, '/f/ai/ballot');
  const bytes = fromBase64(sent.body.bytes_b64);
  assert.equal(recordType(bytes), 'ballot');
  const d = decodeBallot(bytes);
  assert.deepEqual([d.period, d.faction, d.option, d.origin, toBase58(d.wallet), toHex(d.candidates_hash), d.nonce.length], [2, 0, 1, ORIGIN.human, W.seat, hash, 16]);
  assert.equal(await verify(signer.publicKey, bytes, fromBase64(sent.body.sig_b64)), true);
  assert.throws(() => buildBallot({ season: 41, period: 2, wallet: W.seat, faction: 0, option: 4, candidatesHash: hash, nonce16: crypto.randomBytes(16) }), /option/);
  assert.throws(() => buildBallot({ season: 41, period: 2, wallet: W.seat, faction: 0, option: 1, candidatesHash: hash, nonce16: crypto.randomBytes(15) }), /16 bytes/);
});

// ------------------------------------------------------------------ call read
test('call read: the signature verifies over the bytes the service rebuilds; the query carries the wallet and the signature and no key', async () => {
  const signer = await seatSigner();
  const q = await signCallRead({ signer, season: 41, faction: 0, period: 2, unix: 1790000000.7 });
  const u = new URL(q.path, 'http://127.0.0.1');
  assert.equal(u.pathname, '/f/ai/council/call');
  assert.deepEqual(Object.fromEntries(u.searchParams), { faction: '0', period: '2', wallet: W.seat, unix: '1790000000', sig: u.searchParams.get('sig') });
  const rebuilt = encodeCallRead({ season: 41, faction: 0, period: 2, wallet: W.seat, unix: 1790000000n });
  assert.equal(recordType(rebuilt), 'callread');
  assert.equal(await verify(signer.publicKey, rebuilt, fromBase64(u.searchParams.get('sig').replace(/ /g, '+'))), true);
  assert.ok(!q.path.includes(seedHex));
});

test('call read: NotMember and other refusals are returned as codes; BellSkew is retried once with a fresh chain time', async () => {
  const signer = await seatSigner();
  const answer = { period: 2, option: 1, kind: 'camp', p: -2, q: 3, tile: 5, strike_bell: 60, follow_from: 54, invited: ['11', '22', '33'], nonce: 'ff'.repeat(32), call_commit: 'cd'.repeat(32) };
  let calls = 0, unixCalls = 0;
  const skewThenOk = async () => { calls++; return calls === 1 ? { status: 400, json: { error: 'BellSkew', code: 'BellSkew' } } : { status: 200, json: answer }; };
  const r = await readCall({ signer, season: 41, faction: 0, period: 2, get: skewThenOk, seasonUnix: async () => { unixCalls++; return 1790000000 + unixCalls; } });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
  assert.equal(unixCalls, 2, 'a fresh chain time for the retry');
  assert.deepEqual([r.call.option, r.call.kind, r.call.p, r.call.q, r.call.strikeBell, r.call.invited, r.call.commit], [1, 'camp', -2, 3, 60, 3, 'cdcdcdcdcdcd']);
  assert.ok(!('nonce' in r.call) && !JSON.stringify(r.call).includes('ffff'), 'the nonce and the host ids never reach the page model');
  const notMember = await readCall({ signer, season: 41, faction: 1, period: 2, get: async () => ({ status: 400, json: { error: 'NotMember', code: 'NotMember', detail: 'x' } }), seasonUnix: async () => 1 });
  assert.deepEqual([notMember.ok, notMember.code], [false, 'NotMember']);
  const net = await readCall({ signer, season: 41, faction: 0, period: 2, get: async () => { throw new Error('down'); }, seasonUnix: async () => 1 });
  assert.equal(net.code, 'network');
  const twice = await readCall({ signer, season: 41, faction: 0, period: 2, get: async () => ({ status: 400, json: { code: 'BellSkew' } }), seasonUnix: async () => 1 });
  assert.equal(twice.code, 'BellSkew');
  assert.equal(normalizeCall({ option: 'x' }), null);
});

test('call panel: members only; shows the option, kind, place, strike bell, invited count and the commitment prefix, never the nonce', async () => {
  const h = makeH(makeFakeDocument());
  const ctx = { h, t, lang: 'en', index, resolve: null };
  const call = normalizeCall({ period: 2, option: 1, kind: 'camp', p: -2, q: 3, tile: 5, strike_bell: 60, follow_from: 54, invited: ['11', '22'], nonce: 'ee'.repeat(32), call_commit: 'cd'.repeat(32) });
  const text = textOf(renderCallPanel(ctx, { me: { wallet: W.seat }, faction: 0, period: 2, state: 'closed', call, error: null, onRead() {} }));
  assert.match(text, /Strike Order for nation Aster: option 1, camp at \(-2,3\), strike at bell 60\./);
  assert.match(text, /invited armies: 2/);
  assert.match(text, /commitment cdcdcdcdcdcd/);
  assert.doesNotMatch(text, /eeee/);
  assert.match(textOf(renderCallPanel(ctx, { me: null, faction: 0, period: 2, state: 'closed', call: null, error: null, onRead() {} })), /Import a key of a citizen of this nation/);
  const ask = renderCallPanel(ctx, { me: { wallet: W.seat }, faction: 0, period: 2, state: 'closed', call: null, error: 'NotMember', onRead() {} });
  assert.match(textOf(ask), /Read the sealed order/);
  assert.match(textOf(ask), /only citizens of the nation may do this/);
  assert.match(textOf(renderCallPanel(ctx, { me: { wallet: W.seat }, faction: 0, period: null, state: 'none', call: null, error: null, onRead() {} })), /No sealed order for this nation and period/);
  assert.match(textOf(renderCallPanel(ctx, { me: { wallet: W.seat }, faction: 0, period: 2, state: 'opened', call: null, error: null, onRead() {} })), /The order has opened/);
  void signRecord;
});
