// test-gaps-3: writes chat-signed.json, the LITERAL signed posts and read tokens that tests/chat_keyfree.rs replays.
//
// KEY-USING BY DESIGN, NEVER RUN BY CI: it derives the throwaway TEST wallets of tests/chat.rs (`Player::new(seed)` =
// the ed25519 secret seed [seed; 32]) and signs the herald's exact texts with them. CI only reads the written file: the
// Rust test verifies the stored signatures (verification uses public bytes only) and generates, derives and signs
// nothing. Re-run by hand only when the signed texts (herald chat.rs post_message / read_message) change:
//   node frontier-node/crates/herald/tests/vectors/make-chat-signed.mjs
// (tweetnacl and bs58 from permutation-gateway/node_modules: `npm ci` there first.)
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../../../permutation-gateway/package.json', import.meta.url));
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const b58 = b => (bs58.default ?? bs58).encode(Uint8Array.from(b));

// tests/chat.rs / src/fixture.rs: SEASON_ID 5, program [0x5E; 32], BELL0 300, T0_MS 1_900_000_000_000
const WORLD = { season: 5, program: b58(new Uint8Array(32).fill(0x5e)) };
const BELL0 = 300, T0_S = 1_900_000_000;
const POST_DOMAIN = 'WYLLS nation chat message v1', READ_DOMAIN = 'WYLLS nation chat read v1';
const READ_NOTE = 'Only members of this nation can read its chat. This signature lets this browser read and report messages there until the time above. It cannot post, move tokens or act in the game.';
const postMessage = (nation, turn, nonce, wallet, text) =>
  `${POST_DOMAIN}\nWorld: ${WORLD.season}\nProgram: ${WORLD.program}\nNation: ${nation}\nTurn: ${turn}\nNonce: ${nonce}\nWallet: ${wallet}\nText:\n${text}`;
const readMessage = (nation, wallet, issued, expires) =>
  `${READ_DOMAIN}\nWorld: ${WORLD.season}\nProgram: ${WORLD.program}\nNation: ${nation}\nWallet: ${wallet}\nIssued: ${issued}\nExpires: ${expires}\n${READ_NOTE}`;

// who: [seed, nation] — a1, a2, c1 members of nation 1, b1 of nation 4 (tests/chat.rs cast(), c1 new here)
const CAST = { a1: [11, 1], a2: [12, 1], c1: [13, 1], b1: [21, 4] };
const kp = {}, wallets = {};
for (const [who, [seed, nation]] of Object.entries(CAST)) {
  kp[who] = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  wallets[who] = { nation, address: b58(kp[who].publicKey), hex: Buffer.from(kp[who].publicKey).toString('hex') };
}
const sign = (who, m) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(m), kp[who].secretKey)).toString('base64');
let n = 0;
const nonce = () => (0x7e570000 + n++).toString(16).padStart(32, '0');
const posts = [];
const post = (id, who, nation, turn, text) => {
  const nc = nonce(), message = postMessage(nation, turn, nc, wallets[who].address, text);
  posts.push({ id, who, nation, turn, nonce: nc, text, message, signature: sign(who, message) });
};
// P1 twelve posts of a2 for the herald's turn, sent at once: PER_TURN (3) accepted
for (let i = 0; i < 12; i++) post(`parallel-${i}`, 'a2', 1, BELL0, `parallel ${i}`);
// P2 c1 signs three for each of turn-1, turn, turn+1 (the ±1 window): still 3 in the herald's one turn (verify-pr263 F1)
for (const t of [BELL0 - 1, BELL0, BELL0 + 1]) for (let i = 0; i < 3; i++) post(`window-${t}-${i}`, 'c1', 1, t, `window ${t} ${i}`);
// P3 a1 three a turn for 14 turns of one bell-day (288..431): 40 accepted, then DayLimit; the next day again
for (let t = BELL0; t < BELL0 + 14; t++) for (let i = 0; i < 3; i++) post(`day-${t}-${i}`, 'a1', 1, t, `day ${t} ${i}`);
post('nextday', 'a1', 1, 432, 'the next day');
// P4 b1 (nation 4) in its own nation, and signed for nation 1 (a valid signature, not a member there)
post('b1-own', 'b1', 4, BELL0, 'dunmar only');
post('b1-as-1', 'b1', 1, BELL0, 'b1 claims nation 1');
// read tokens (issued/expires as decimal text: the overflow window is outside a JS number's exact range)
const tokens = [];
const token = (id, who, nation, issued, expires) => {
  const message = readMessage(nation, wallets[who].address, issued, expires);
  tokens.push({ id, who, nation, issued: String(issued), expires: String(expires), message, signature: sign(who, message) });
};
token('a1', 'a1', 1, T0_S - 10, T0_S + 3600);
token('b1', 'b1', 4, T0_S - 10, T0_S + 3600);
token('b1-claims-1', 'b1', 1, T0_S - 10, T0_S + 3600);
token('a1-overflow', 'a1', 1, -(2n ** 63n), 2n ** 63n - 1n);
token('a1-13h', 'a1', 1, T0_S - 10, T0_S - 10 + 13 * 3600);
const out = {
  note: 'test-gaps-3: literal signed chat posts and read tokens of throwaway TEST wallets (seeds of tests/chat.rs). Written by make-chat-signed.mjs (key-using, never run by CI); read by tests/chat_keyfree.rs, which verifies and signs nothing new.',
  world: WORLD, bell0: BELL0, t0Ms: T0_S * 1000, wallets, posts, tokens,
};
const file = fileURLToPath(new URL('./chat-signed.json', import.meta.url));
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${file}: ${posts.length} posts, ${tokens.length} tokens`);
