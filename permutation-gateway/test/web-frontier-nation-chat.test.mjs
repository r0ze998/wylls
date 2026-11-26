// The page's side of the nation chat (permutation-server/web/frontier/hud/nationchat.mjs; owner Q-PT-11 (a), Q-PT-12):
//   W1 the signed texts are byte for byte the herald's (frontier-node/crates/herald/src/chat.rs post_message /
//      read_message; the same fixed vectors as its unit test `the_signed_texts_are_fixed`)
//   W2 links in their disguises, and the other text rules, as the herald's (`links_are_found_in_their_disguises`,
//      `text_rules`): the page refuses before asking the wallet; the herald checks again
//   W3 the client: a read token is one wallet signature over readText for the page's nation (≤ 12 h), kept in memory;
//      a post asks the herald's turn first and signs postText with a fresh nonce; a refusal is passed on as its code;
//      a wallet that altered the text is not used
//   W4 mute is this browser's own, per world
//   W5 every refusal code the herald sends has words in Japanese and English; every key of the module has English
//   W6 the page mounts it once, from the play start, with the page's own world and nation
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as C from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import { setLang, EN } from '../../permutation-server/web/lang.mjs';
import { encode as b58 } from '../../permutation-server/web/sdk/base58.mjs';

const WEB = new URL('../../permutation-server/web/', import.meta.url);

test('W1 the signed texts are the herald\'s', () => {
  const w = { world: '7', program: 'Prog111' };
  assert.equal(C.postText(w, 2, 120, '00ff', 'Wal1', 'hi\nthere'),
    'WYLLS nation chat message v1\nWorld: 7\nProgram: Prog111\nNation: 2\nTurn: 120\nNonce: 00ff\nWallet: Wal1\nText:\nhi\nthere');
  assert.ok(C.readText(w, 2, 'Wal1', 10, 20).startsWith('WYLLS nation chat read v1\nWorld: 7\nProgram: Prog111\nNation: 2\nWallet: Wal1\nIssued: 10\nExpires: 20\nOnly members'));
  // the read note is the herald's exactly (src/chat.rs READ_NOTE)
  assert.ok(C.readText(w, 2, 'Wal1', 10, 20).endsWith('It cannot post, move tokens or act in the game.'));
});

test('W2 links and the text rules, as the herald\'s', async () => {
  for (const t of ['go to https://example.com now', 'example.com', 'join discord.gg/abc', 't.me/somebody', 'www.something', 'ｅｘａｍｐｌｅ．ｃｏｍ',
    'example。com', 'example(dot)com', 'example [dot] com', 'example dot com', 'example . com', 'h t t p s : / / x', 'ex​ample.c​om',
    'see 192.168.0.1', 'EXAMPLE.COM', 'mailto:a@b', 'a@b.io', 'サイトはexampleドットcomです']) assert.ok(C.linkIn(t), t);
  for (const t of ['march at bell 120, then hold', '3.5 troops? no, 35', 'lol www', 'wwwww', 'ok. Me too', 'e.g. the keep at (3,4)',
    '東の砦を取ろう。明日の朝に集合', 'A・B・C の順で行く', 'gg', 'Mr.Smith says hi', 'v1.2 of the plan']) assert.ok(!C.linkIn(t), t);
  assert.equal(C.textProblem(''), 'EmptyText');
  assert.equal(C.textProblem(' hi'), 'UntrimmedText');
  assert.equal(C.textProblem('a'.repeat(281)), 'TextTooLong');
  assert.equal(C.textProblem('あ'.repeat(280)), null);
  assert.equal(C.textProblem('あ'.repeat(342)), 'TextTooLong');
  assert.equal(C.textProblem('a\nb\nc\nd\ne\nf\ng'), 'TooManyLines');
  assert.equal(C.textProblem('a\u0007b'), 'ControlCharacter');
  assert.equal(C.textProblem('a‮b'), 'ControlCharacter');
  assert.equal(C.textProblem('see example.com'), 'LinkNotAllowed');
  assert.equal(C.textProblem('hold the east keep\nthen march'), null);
  // the same TLD list and swaps as the herald (a drift would let the page send what the herald refuses, or the reverse)
  const rust = await readFile(new URL('../../frontier-node/crates/herald/src/chat.rs', import.meta.url), 'utf8');
  const page = await readFile(new URL('frontier/hud/nationchat.mjs', WEB), 'utf8');
  const tlds = src => { const a = src.indexOf('=', src.indexOf('const TLDS')); return [...src.slice(a, src.indexOf(']', src.indexOf('[\'com\'', a) >= 0 ? src.indexOf('[\'com\'', a) : src.indexOf('"com"', a))).matchAll(/"([a-z]+)"|'([a-z]+)'/g)].map(m => m[1] ?? m[2]); };
  assert.deepEqual(tlds(page), tlds(rust));
  assert.ok(tlds(rust).length > 90);
});

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { address: b58(raw), raw, privateKey, publicKey };
}
const verifies = (kp, text, sigB64) => edVerify(null, Buffer.from(text, 'utf8'), kp.publicKey, Buffer.from(sigB64, 'base64'));

function fakeHerald({ turn = 120, answers = {} } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const path = new URL(url, 'http://h').pathname;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, method: opts.method ?? 'GET', body, headers: opts.headers });
    const a = answers[path]?.(body) ?? (path === '/h/chat/info' ? { ok: true, world: '7', program: 'Prog111', turn } : { ok: true });
    return { status: a.status ?? (a.ok ? 200 : 400), ok: a.ok === true, json: async () => a };
  };
  return { fetch, calls };
}

test('W3 the client signs the read token and each post with the wallet', async () => {
  const kp = keypair();
  let signs = 0;
  const wallet = { address: kp.address, signMessage: async bytes => { signs++; return { signature: new Uint8Array(edSign(null, Buffer.from(bytes), kp.privateKey)) }; } };
  const h = fakeHerald();
  let now = 1_900_000_000_000;
  const c = C.createChatClient({ base: 'http://localhost:41530', fetch: h.fetch, wallet: () => wallet, nation: () => 3, now: () => now, random: n => new Uint8Array(n).fill(0xab) });
  const info = { world: '7', program: 'Prog111' };
  assert.equal(c.token, null);
  const t = await c.open(info);
  assert.equal(signs, 1);
  assert.deepEqual([t.wallet, t.nation, t.expires - t.issued], [kp.address, 3, C.TOKEN_SECS]);
  assert.ok(C.TOKEN_SECS <= 12 * 3600);
  assert.ok(verifies(kp, C.readText(info, 3, kp.address, t.issued, t.expires), t.signature));
  // kept: no second signature while valid
  await c.open(info);
  assert.equal(signs, 1);
  await c.read(null);
  assert.deepEqual(h.calls.at(-1), { path: '/h/chat/read', method: 'POST', body: { token: t }, headers: { 'content-type': 'application/json' } });
  // a post: the herald's turn, a fresh nonce, the wallet's signature over the exact text
  const r = await c.post(info, 'hold the east keep');
  assert.equal(r.ok, true);
  const p = h.calls.at(-1);
  assert.equal(h.calls.at(-2).path, '/h/chat/info', 'the turn is the herald\'s, read just before');
  assert.deepEqual({ ...p.body, signature: '' }, { wallet: kp.address, nation: 3, turn: 120, nonce: 'ab'.repeat(16), text: 'hold the east keep', signature: '' });
  assert.ok(verifies(kp, C.postText(info, 3, 120, 'ab'.repeat(16), kp.address, 'hold the east keep'), p.body.signature));
  // the token expires: asked again
  now += (C.TOKEN_SECS - 30) * 1000;
  assert.equal(c.token, null);
  // a refusal comes back as its code
  const h2 = fakeHerald({ answers: { '/h/chat/post': () => ({ ok: false, code: 'TurnLimit', status: 429 }) } });
  const c2 = C.createChatClient({ fetch: h2.fetch, wallet: () => wallet, nation: () => 3 });
  assert.deepEqual(await c2.post(info, 'x'), { ok: false, code: 'TurnLimit', status: 429 });
  // chat off: said as such
  const off = C.createChatClient({ fetch: async () => ({ status: 404, ok: false, json: async () => ({ ok: false, code: 'ChatOff' }) }), wallet: () => wallet, nation: () => 3 });
  assert.deepEqual(await off.info(), { ok: false, code: 'ChatOff', off: true });
  // no nation: no token is asked for
  const none = C.createChatClient({ fetch: h.fetch, wallet: () => wallet, nation: () => null });
  await assert.rejects(none.open(info), e => e.code === 'NoNation');
  // a wallet that signed another text (a prefix) is not used
  const odd = { address: kp.address, signMessage: async bytes => ({ signedMessage: new Uint8Array([1, ...bytes]), signature: new Uint8Array(64) }) };
  const c3 = C.createChatClient({ fetch: h.fetch, wallet: () => odd, nation: () => 3 });
  await assert.rejects(c3.open(info), e => e.code === 'WalletAlteredMessage');
  assert.deepEqual(await c3.post(info, 'x'), { ok: false, code: 'WalletAlteredMessage' });
  // the socket address
  assert.equal(C.socketUrl('http://localhost:41530'), 'ws://localhost:41530/h/chat/ws');
  assert.equal(C.socketUrl('', { href: 'https://play.example/frontier/' }), 'wss://play.example/h/chat/ws');
});

test('W4 mute is this browser\'s, per world', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = { world: '7', program: 'P' }, b = { world: '8', program: 'P' };
  C.saveMuted(storage, a, new Set(['W1', 'W2']));
  assert.deepEqual([...C.loadMuted(storage, a)], ['W1', 'W2']);
  assert.deepEqual([...C.loadMuted(storage, b)], []);
  assert.equal(C.muteKey(a), 'ps-nation-chat-mute:P:7');
  store.set(C.muteKey(b), 'not json');
  assert.deepEqual([...C.loadMuted(storage, b)], []);
});

test('W5 every refusal has words in both languages; every key has English', async () => {
  const rust = await readFile(new URL('../../frontier-node/crates/herald/src/chat.rs', import.meta.url), 'utf8');
  // the codes a player can meet (posting, reading, reporting); the operator's and the transport's are not shown to players
  const codes = new Set([...rust.matchAll(/"([A-Z][A-Za-z]+)"\)?\)?/g)].map(m => m[1]));
  const player = ['EmptyText', 'UntrimmedText', 'TextTooLong', 'TooManyLines', 'ControlCharacter', 'LinkNotAllowed', 'TurnLimit', 'DayLimit', 'StaleTurn',
    'Replay', 'BadSignature', 'TokenExpired', 'NotACitizen', 'NotJoined', 'NoNation', 'NotThisNation', 'Expelled', 'ReportLimit', 'OwnMessage', 'NoSuchMessage', 'SlowDown', 'NoClockYet'];
  for (const k of player) assert.ok(codes.has(k), `${k} is a herald code`);
  setLang('ja');
  const fallback = C.codeText('SomethingElse');
  for (const k of player) assert.notEqual(C.codeText(k), fallback.replace('SomethingElse', k), k);
  setLang('en');
  try {
    for (const k of player) assert.match(C.codeText(k), /^[\x20-\x7e…—]+$/, `${k} in English: ${C.codeText(k)}`);
  } finally { setLang('ja'); }
  const src = await readFile(new URL('frontier/hud/nationchat.mjs', WEB), 'utf8');
  for (const m of src.matchAll(/\bL`((?:[^`\\]|\\.)*)`/g)) {
    let i = 0;
    const key = m[1].replace(/\$\{[^}]*\}/g, () => `{${i++}}`);
    assert.ok(key in EN, `English for ${key}`);
  }
});

test('W6 the page mounts the chat once, from the play start, with its own world and nation', async () => {
  const app = await readFile(new URL('frontier/app.mjs', WEB), 'utf8');
  assert.ok(app.includes("import { installNationChat } from './hud/nationchat.mjs';"));
  assert.equal([...app.matchAll(/installNationChat\(/g)].length, 1);
  const at = app.indexOf('installNationChat(');
  assert.ok(at > app.indexOf("if (FS.mode === 'play') {", app.indexOf('const startWithSeason')), 'inside the play start');
  assert.ok(app.includes("const nationChatState = () => ({ wallet: FS.wallet, nation: Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : null, world: FS.season?.seasonId ?? null, program: FS.pin?.programId ?? null });"));
  // the page's text never goes in as markup: player text is set with textContent only
  const src = await readFile(new URL('frontier/hud/nationchat.mjs', WEB), 'utf8');
  assert.deepEqual([...src.matchAll(/innerHTML = (.*);/g)].map(m => m[1].startsWith("'<svg class=\"ic\" aria-hidden=\"true\"")), [true, true]);
  assert.ok(!/insertAdjacentHTML|outerHTML|document\.write/.test(src));
});
