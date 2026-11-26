// test-gaps-3 (#263 nation chat): the page's half of the chat rules, pinned to the herald's, with no key.
//
// The herald and the page must refuse the same texts (verify-pr263: "the page and the herald must stay byte-identical";
// a refused text stays in the composer with the reason) and sign the same texts. Both chat test files that existed
// (herald tests/chat.rs, web-frontier-nation-chat) sign with keys, so CI ran neither. Here:
//   1 SHARED VECTORS frontier-node/crates/herald/tests/vectors/chat-text-rules.json: the verifier's link probes
//     (evasions, false positives, control characters) and 3,000 seeded random texts from an alphabet of look-alike dots,
//     invisible characters, full-width letters, schemes and plain words → the page's textProblem / linkIn verdicts.
//     This test fails when the file is not what the page says now (TG3_WRITE_VECTORS=1 rewrites it); the herald's
//     tests/chat_keyfree.rs replays the same file against chat.rs text_problem / link_in.
//   2 the herald's rule lists read from chat.rs itself: TLDs, the "(dot)" swaps, the scheme keys, the folded
//     characters, the limits and the report reasons = the page's; the refusal words say the herald's 3 and 40.
//   3 the signed texts: postText / readText give exactly the "message" of every literal post and token of
//     tests/vectors/chat-signed.json (the herald's post_message / read_message give them too: chat_keyfree.rs).
// Nothing here signs, derives or generates a key; the module's wallet call is never reached (no client is made).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { linkIn, textProblem, postText, readText, MAX_CHARS, MAX_BYTES, MAX_LINES, POST_DOMAIN, READ_DOMAIN, REASONS, codeText } from '../../permutation-server/web/frontier/hud/nationchat.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const VEC = new URL('../../frontier-node/crates/herald/tests/vectors/chat-text-rules.json', import.meta.url);
const SIGNED = new URL('../../frontier-node/crates/herald/tests/vectors/chat-signed.json', import.meta.url);
const CHAT_RS = readFileSync(new URL('../../frontier-node/crates/herald/src/chat.rs', import.meta.url), 'utf8');

// ------------------------------------------------------------------ the corpus
// verify-pr263 linkprobe.mjs (evidence/verify-pr263): what it found caught, missed (Q-NC-8) and wrongly refused.
const PROBES = [
  'hxxp://evil', 'hxxps[:]//evil[.]com', 'xn--80ak6aa92e.com', 'discord .gg/abc', 'discord. gg/abc', 'пример.рф', '例え.jp',
  'evil·com', 'evil．com', 'evil。com', 'e v i l . c o m', 'evil,com', 'evilDOTcom', 'evil dot c o m', 'bit.ly/x', 'evil.ninja',
  'evil.cоm (cyrillic o)', 'discord gg/abc', '1.2.3.4', '0x7f000001', 'evil․com', 'evil﹒com', 'EVIL.COM', 'evil . com',
  'evil(.)com', 'telegram: @evilbot', 'ｈｔｔｐｓ：／／x', 'evil\u200b.com', 'evil.c\u00adom', 'evil。ｃｏｍ', 'evil ドット com',
  'evil 。 com', 'Ready.No more waiting', 'OK.me too', 'Hold.It is ours', 'vs.AI residents', 'OK。it works', 'done.so',
  'Mr.Smith', 'e.g. east keep', 'v1.2', '3.5 troops', 'at 12.30', 'go.to the keep', 'turn 120. Then march', 'lol', 'www',
  'I.E. the north', 'U.S. style', 'No.1 keep', '東の砦を取ろう。明日の朝に集合', '了解。in the morning', 'gg wp', 'Sat.Sun',
  'pls.co-op', 'A・B・C', 'yes.in 5 turns', 'keep (3.4)', 'node.js', 'a b', 'a\u200eb', 'a\u202eb', 'a\u0000b', 'a\u2028b',
  // edges of the other rules
  '', ' ', ' x', 'x ', '\u3000x', 'x\u00a0', '\ufeffx', 'x\ufeff', '\ufeff', '\u0085x', 'x\u0085', '\u0085', 'a\u0085b',
  'a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne\nf\ng', 'a\r\nb', 'a\tb', 'x'.repeat(280), 'x'.repeat(281), '砦'.repeat(280), '砦'.repeat(342),
  '😀'.repeat(256), '😀'.repeat(257), 'mailto:x', 'javascript:alert(1)', 'data:text/html', 'ftp:x', 'WWW.x', 'http : //x',
  'h t t p s : / / x', '10.0.0.1', '1.2.3', '1234.5.6.7', '1.2.3.4444', 'evil[dot]com', 'evil{.}com', 'evil<dot>com',
  'evil(dot)com', 'x(:)//y', 'x[/]y', 'evil . . com', 'a-b.gg', 'a_b.io', '-.com', '.com', 'x.', 'x..com', 'ＥＶＩＬ．ＣＯＭ',
  'Kelvin\u212a.com', 'evil.\u212aom', 'İ.com', 'ΣΣ.com', 'é.com', 'x.comx', 'x.com1', 'x.co.jp',
];
// seeded random texts (mulberry32): pieces chosen to sit on the folding rules' edges
const PIECES = ['a', 'b', 'x', 'evil', 'discord', 'com', 'gg', 'io', 'jp', 'ninja', 'me', 'No', 'OK', '.', ' ', '. ', ' .',
  '。', '．', '․', '﹒', '·', '・', '(dot)', '[.]', '{.}', ' dot ', 'ドット', ':', '/', '://', '(:)', '[/]', 'http', 'https', 'www',
  'hxxp', 'ftp', 'mailto', '1', '2', '3', '12', '255', '-', '_', 'xn--', '@', 'e.g.', 'v1.2', '\u200b', '\u200d', '\u2060',
  '\u00ad', '\u180e', '\u3000', '\u00a0', '\u2028', 'ｃｏｍ', 'ＨＴＴＰ', '：', '／', '東', '砦', '集合', 'é', 'Σ', 'İ', '\u212a', '😀',
  '\n', '\t', '\u202e', '\u2066', '\u0007', '\u007f', '\u0085', '\ufeff'];
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function corpus() {
  const r = rng(0x7e5763), out = [...PROBES];
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(r() * 9);
    let s = '';
    for (let j = 0; j < n; j++) s += PIECES[Math.floor(r() * PIECES.length)];
    out.push(s);
  }
  return [...new Set(out)];
}
const verdicts = () => corpus().map(text => ({ text, problem: textProblem(text), link: linkIn(text) }));

test('shared text-rule vectors: the page\'s verdict on every probe and random text is the one the herald replays (file current)', () => {
  const now = { note: 'test-gaps-3: the page\'s nationchat.mjs textProblem / linkIn on the verify-pr263 probes and 3,000 seeded random texts. Written by permutation-gateway/test/web-frontier-test-gaps-3-chat.test.mjs (TG3_WRITE_VECTORS=1); replayed against chat.rs by tests/chat_keyfree.rs.', cases: verdicts() };
  const text = `${JSON.stringify(now, null, 0).replace(/\},\{/g, '},\n{')}\n`;
  if (process.env.TG3_WRITE_VECTORS === '1') writeFileSync(VEC, text);
  const file = JSON.parse(readFileSync(VEC, 'utf8'));
  assert.equal(file.cases.length, now.cases.length, 'the vectors file has every case (rewrite with TG3_WRITE_VECTORS=1)');
  for (let i = 0; i < now.cases.length; i++) assert.deepEqual(file.cases[i], now.cases[i], `case ${i} ${JSON.stringify(now.cases[i].text)}: the page's verdict changed — rewrite the vectors and check chat.rs agrees`);
  // the corpus reaches every refusal and both sides of the link rule
  const seen = new Set(now.cases.map(c => c.problem));
  for (const c of [null, 'EmptyText', 'UntrimmedText', 'TextTooLong', 'TooManyLines', 'ControlCharacter', 'LinkNotAllowed']) assert.ok(seen.has(c), `the corpus reaches ${c}`);
  assert.ok(now.cases.filter(c => c.link).length > 300 && now.cases.filter(c => !c.link).length > 300, 'many links and many non-links');
  // what verify-pr263 measured stays what the vectors say (Q-NC-8 is r0ze's: these pin today's rule, not a wish)
  const v = Object.fromEntries(now.cases.map(c => [c.text, c]));
  for (const t of ['hxxps[:]//evil[.]com', 'evil。ｃｏｍ', 'evil\u200b.com', 'xn--80ak6aa92e.com', '1.2.3.4', 'evil ドット com']) assert.equal(v[t].problem, 'LinkNotAllowed', t);
  for (const t of ['discord .gg/abc', 'пример.рф', 'evil·com', 'evil.ninja']) assert.equal(v[t].problem, null, `${t}: a known miss (Q-NC-8)`);
  for (const t of ['Ready.No more waiting', 'OK.me too', 'go.to the keep']) assert.equal(v[t].problem, 'LinkNotAllowed', `${t}: a known false positive (Q-NC-8)`);
  for (const t of ['Mr.Smith', 'e.g. east keep', 'v1.2', 'node.js', '東の砦を取ろう。明日の朝に集合']) assert.equal(v[t].problem, null, t);
});

// ------------------------------------------------------------------ the herald's lists, read from chat.rs
const block = (re, what) => { const m = re.exec(CHAT_RS); assert.ok(m, `chat.rs: ${what} found`); return m[1]; };
const quoted = s => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`));
const rsConst = name => Number(block(new RegExp(`pub const ${name}: [a-z0-9]+ = ([0-9_ *]+);`), name).replace(/_/g, '').split('*').reduce((a, b) => a * Number(b), 1));

test('the herald\'s rule lists = the page\'s: TLDs, "(dot)" swaps, scheme keys, folded characters, limits, reasons, domains', () => {
  const tlds = quoted(block(/const TLDS: &\[&str\] = &\[([\s\S]*?)\];/, 'TLDS'));
  // (the page's list is module-private: compared by behaviour, both ways)
  assert.ok(tlds.length > 90);
  for (const t of tlds) assert.equal(linkIn(`evil.${t}`), true, `.${t} is a link on the page as in the herald`);
  for (const t of ['ninja', 'zz', 'local', 'js', 'so', 'smith']) { assert.equal(tlds.includes(t), false, `.${t} not a herald TLD`); assert.equal(linkIn(`evil.${t}`), false, `.${t} not a link on the page`); }
  const swaps = [...block(/for \(from, to\) in \[([\s\S]*?)\] \{\s*while s\.contains/, 'swaps').matchAll(/\("((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\)/g)].map(m => [m[1], m[2]]);
  assert.equal(swaps.length, 14);
  for (const [from, to] of swaps) {
    const t = to === '.' ? `evil${from}com` : to === ':' ? `https${from}//x` : `x:/${from}y`;
    assert.equal(linkIn(t), true, `the herald's swap ${JSON.stringify(from)} → ${to} is folded on the page too (${t})`);
  }
  const keys = quoted(block(/for k in \[([\s\S]*?)\] \{\s*if s\.contains\(k\)/, 'scheme keys'));
  assert.deepEqual(keys, ['://', 'http:', 'https:', 'www.', 'ftp:', 'mailto:', 'javascript:', 'data:text']);
  for (const k of keys) assert.equal(linkIn(`a ${k}b`), true, k);
  // the folded characters: full-width, the look-alike full stops, the dropped invisibles
  for (const c of ['\u3002', '\uff61', '\u2024', '\ufe52', '\u2e31']) { assert.match(CHAT_RS, new RegExp(`0x${c.codePointAt(0).toString(16).toUpperCase()}`)); assert.equal(linkIn(`evil${c}com`), true, `U+${c.codePointAt(0).toString(16)}`); }
  for (const c of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u180e']) assert.equal(linkIn(`evil.c${c}om`), true, `U+${c.codePointAt(0).toString(16)} dropped`);
  // limits, reasons, domains
  assert.equal(rsConst('MAX_CHARS'), MAX_CHARS);
  assert.equal(rsConst('MAX_BYTES'), MAX_BYTES);
  assert.equal(rsConst('MAX_LINES'), MAX_LINES);
  assert.deepEqual(quoted(block(/pub const REPORT_REASONS: \[&str; \d+\] = \[([^\]]*)\];/, 'REPORT_REASONS')), [...REASONS]);
  assert.equal(block(/pub const POST_DOMAIN: &str = "([^"]*)";/, 'POST_DOMAIN'), POST_DOMAIN);
  assert.equal(block(/pub const READ_DOMAIN: &str = "([^"]*)";/, 'READ_DOMAIN'), READ_DOMAIN);
  // the page's own read token is inside the herald's window (TOKEN_MAX_SECS)
  assert.ok(6 * 3600 <= rsConst('TOKEN_MAX_SECS'));
  // the refusal words name the herald's limits (they are written as numbers in the sentence)
  setLang('ja');
  assert.match(codeText('TurnLimit'), new RegExp(`${rsConst('PER_TURN')} 回`));
  assert.match(codeText('DayLimit'), new RegExp(`${rsConst('PER_DAY')} 回`));
  assert.match(codeText('TextTooLong'), new RegExp(`${MAX_CHARS} 文字`));
  setLang('en');
  assert.match(codeText('TurnLimit'), new RegExp(`\\b${rsConst('PER_TURN')}\\b`));
  assert.match(codeText('DayLimit'), new RegExp(`\\b${rsConst('PER_DAY')}\\b`));
  setLang('ja');
});

test('the signed texts: postText / readText give exactly every literal post and token the herald replays', () => {
  const s = JSON.parse(readFileSync(SIGNED, 'utf8'));
  const info = { world: String(s.world.season), program: s.world.program };
  assert.ok(s.posts.length >= 60 && s.tokens.length >= 5);
  for (const p of s.posts) assert.equal(postText(info, p.nation, p.turn, p.nonce, s.wallets[p.who].address, p.text), p.message, p.id);
  for (const t of s.tokens) assert.equal(readText(info, t.nation, s.wallets[t.who].address, t.issued, t.expires), t.message, t.id);
  // every post text is one the page itself would let through, and every nonce is the herald's shape
  for (const p of s.posts) { assert.equal(textProblem(p.text), null, p.id); assert.match(p.nonce, /^[0-9a-f]{32}$/); }
  assert.equal(new Set(s.posts.map(p => p.nonce)).size, s.posts.length, 'no two posts share a nonce');
});
