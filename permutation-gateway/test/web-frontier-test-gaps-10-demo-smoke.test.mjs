// test-gaps-10: PR-CI tests for #309 (the walletless demo's PR smoke at the real Pages host, pre-join; Q-FDW-1 = B,
// Q-FDW-2 = A, Q-FDW-3 = A). finish-pr309 proved the smoke's signature counting by hand: seven scratch commits (N1–N7)
// that each made the browser run fail. This file runs the counting itself in Node, on every PR.
//
// THIS FILE MAKES NO KEY AND SIGNS NOTHING. It reads permutation-gateway/demo/smoke.mjs as TEXT. It takes out the init
// script that smoke.mjs hands to Playwright (`context.addInitScript(() => { … })`) and runs it against a STAND-IN
// SubtleCrypto. That stand-in is a plain object: its methods return fixed placeholder objects and bytes, it holds no
// key material, and it never calls the real WebCrypto. The counter wraps the stand-in exactly as it wraps the
// browser's. The test then makes the calls the page would make, and reads the counters back. Nothing is imported from
// the demo, the page or the screens world (no key closure); the doc, the workflows and the seed constants are read as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const text = p => readFileSync(new URL(p, ROOT), 'utf8');
const SMOKE = text('permutation-gateway/demo/smoke.mjs');

/** The body of the arrow function passed to `context.addInitScript(() => { … })` in smoke.mjs (brace-matched). */
function initScriptBody(src) {
  const at = src.indexOf('await context.addInitScript(() => {');
  assert.ok(at > 0, 'smoke.mjs hands one init script to the browser context');
  assert.equal(src.indexOf('addInitScript(', at + 'await context.addInitScript('.length), -1, 'exactly one init script');
  const open = src.indexOf('{', at + 'await context.addInitScript(() '.length);
  let depth = 0, i = open, quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; } // a line comment (its apostrophes are prose)
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) break;
  }
  return src.slice(open + 1, i);
}
const BODY = initScriptBody(SMOKE);

// the real pkcs8 layout session.mjs keyFromSeed imports: a 16-byte Ed25519 prefix + the 32-byte seed
const PREFIX_HEX = text('permutation-server/web/session.mjs').match(/const PKCS8_PREFIX = fromHex\('([0-9a-f]+)'\)/)?.[1];
const PREFIX = Uint8Array.from(PREFIX_HEX.match(/../g), h => parseInt(h, 16));
const pkcs8 = (fill, n = 32) => { const b = new Uint8Array(PREFIX.length + n); b.set(PREFIX); b.fill(fill, PREFIX.length); return b; };
const ED = { name: 'Ed25519' };
const PRE = new TextEncoder().encode('Wylls demo preflight');

/**
 * A fresh page: a stand-in SubtleCrypto (placeholder handles only), smoke.mjs's init script run over it, and `call`,
 * which makes the call the page would make. Returns the counters as the smoke reads them at the end.
 */
function page({ subtle = true } = {}) {
  const handles = [];
  class StandIn {}
  // method names spelled out as properties; every one answers a placeholder (no key material, no real WebCrypto)
  Object.assign(StandIn.prototype, {
    importKey: async function (format) { const h = Object.freeze({ standIn: handles.length, format }); handles.push(h); return h; },
    generateKey: async function () { return Object.freeze({ standIn: 'generated' }); },
    sign: async function () { return new ArrayBuffer(64); },
  });
  const g = subtle ? { SubtleCrypto: StandIn } : {};
  new Function('globalThis', BODY)(g);
  const inst = new StandIn();
  const call = (method, ...a) => StandIn.prototype[method].apply(inst, a);
  const read = () => ({ signs: g.__smokeSigns ?? null, preflight: g.__smokePreflight ?? null, otherKeys: g.__smokeOtherKeys ?? null });
  return { call, read };
}

// The three checks the smoke makes at the end under --pre-join, taken from its own lines and run on given counts.
const CHECKS = (() => {
  const block = SMOKE.slice(SMOKE.indexOf('const otherKeys = await demo('));
  const pre = block.slice(block.indexOf('if (opt[\'pre-join\']) {'), block.indexOf('result.preflight = preflight;'));
  const conds = [...pre.matchAll(/check\((.+?), `/g)].map(m => m[1]);
  assert.equal(conds.length, 3, `three end checks under --pre-join (${conds.join(' | ')})`);
  return conds.map(c => new Function('signs', 'preflight', 'otherKeys', `return (${c});`));
})();
const passes = ({ signs, preflight, otherKeys }) => CHECKS.map(f => f(signs, preflight, otherKeys));

test('#309 counter: the load-time Ed25519 test (seed 0x07 + the fixed text) is counted apart, once; the run passes', async () => {
  const p = page();
  // what boot.mjs cryptoCheck → session.mjs keyFromSeed does: two pkcs8 imports of 0x07 (one extractable for the JWK), then one signature
  const k1 = await p.call('importKey', 'pkcs8', pkcs8(7), ED, true, ['sign']);
  const k = await p.call('importKey', 'pkcs8', pkcs8(7), ED, false, ['sign']);
  assert.notEqual(k1, k);
  await p.call('sign', ED, k, PRE);
  // the Dev Wallet and the sample session: public keys only, from the fixed seeds 0x11 and 0x22 (Q-FDW-1 B, Q-FDW-3 A)
  for (const s of [0x11, 0x11, 0x22]) await p.call('importKey', 'pkcs8', pkcs8(s), ED, true, ['sign']);
  await p.call('importKey', 'raw', new Uint8Array(32), ED, true, ['verify']);
  await p.call('importKey', 'jwk', { kty: 'OKP', crv: 'Ed25519', x: 'AA' }, ED, true, ['verify']);
  const r = p.read();
  assert.deepEqual(r, { signs: 0, preflight: 1, otherKeys: [] });
  assert.deepEqual(passes(r), [true, true, true]);
  // and a page that never ran the test (an insecure context): 0 is allowed too
  assert.deepEqual(passes({ signs: 0, preflight: 0, otherKeys: [] }), [true, true, true]);
});

test('#309 counter: N1 a second preflight → fails "at most once"; N2 another text with the 0x07 key → an ordinary signature', async () => {
  const n1 = page();
  const k = await n1.call('importKey', 'pkcs8', pkcs8(7), ED, false, ['sign']);
  await n1.call('sign', ED, k, PRE); await n1.call('sign', ED, k, PRE);
  assert.deepEqual(n1.read(), { signs: 0, preflight: 2, otherKeys: [] });
  assert.deepEqual(passes(n1.read()), [true, false, true]);

  const n2 = page();
  const k2 = await n2.call('importKey', 'pkcs8', pkcs8(7), ED, false, ['sign']);
  await n2.call('sign', ED, k2, PRE);
  await n2.call('sign', ED, k2, new TextEncoder().encode('Wylls demo preflight!'));
  await n2.call('sign', ED, k2, new Uint8Array([0xff, 0xfe])); // not UTF-8 at all
  assert.deepEqual(n2.read(), { signs: 2, preflight: 1, otherKeys: [] });
  assert.deepEqual(passes(n2.read()), [false, true, true]);
});

test('#309 counter: the fixed text signed by any key but the 0x07 one is an ordinary signature (finish-pr309 D-2: text alone is not enough)', async () => {
  const p = page();
  const dev = await p.call('importKey', 'pkcs8', pkcs8(0x11), ED, false, ['sign']);
  const sess = await p.call('importKey', 'pkcs8', pkcs8(0x22), ED, false, ['sign']);
  await p.call('sign', ED, dev, PRE); await p.call('sign', ED, sess, PRE);
  await p.call('sign', ED, { standIn: 'never imported' }, PRE);
  // the text as a view with an offset, and as a DataView: still read (the counter's `bytes`)
  const k = await p.call('importKey', 'pkcs8', pkcs8(7), ED, false, ['sign']);
  const padded = new Uint8Array(PRE.length + 4); padded.set(PRE, 2);
  await p.call('sign', ED, k, new DataView(padded.buffer, 2, PRE.length));
  assert.deepEqual(p.read(), { signs: 3, preflight: 1, otherKeys: [] });
  assert.deepEqual(passes(p.read()), [false, true, true]);
});

test('#309 counter: N3/N4 any private import from another seed, a private JWK or a key generation fails "no private key but the fixed seeds"', async () => {
  const cases = [
    ['seed 0x08 (N3)', p => p.call('importKey', 'pkcs8', pkcs8(8), ED, false, ['sign'])],
    ['seed 0x01', p => p.call('importKey', 'pkcs8', pkcs8(1), ED, false, ['sign'])],
    ['a seed that is not one byte repeated', p => { const b = pkcs8(7); b[b.length - 1] = 8; return p.call('importKey', 'pkcs8', b, ED, false, ['sign']); }],
    ['0x07 but 31 bytes (not the 48-byte layout)', p => p.call('importKey', 'pkcs8', pkcs8(7, 31), ED, false, ['sign'])],
    ['0x07 but 33 bytes', p => p.call('importKey', 'pkcs8', pkcs8(7, 33), ED, false, ['sign'])],
    ['a private JWK (has d)', p => p.call('importKey', 'jwk', { kty: 'OKP', crv: 'Ed25519', x: 'AA', d: 'BB' }, ED, false, ['sign'])],
    ['generation', p => p.call('generateKey', ED, false, ['sign', 'verify'])],
  ];
  for (const [what, act] of cases) {
    const p = page();
    await act(p);
    const r = p.read();
    assert.equal(r.otherKeys.length, 1, what);
    assert.deepEqual(passes(r), [true, true, false], what);
  }
  // a 0x07 key imported in a malformed layout does not become the preflight key either
  const p = page();
  const odd = await p.call('importKey', 'pkcs8', pkcs8(7, 33), ED, false, ['sign']);
  await p.call('sign', ED, odd, PRE);
  assert.deepEqual({ signs: p.read().signs, preflight: p.read().preflight }, { signs: 1, preflight: 0 });
});

test('#309 counter: a page where the counter never ran (no SubtleCrypto) fails every end check — null never passes (finish-pr309 D-2)', () => {
  const r = page({ subtle: false }).read();
  assert.deepEqual(r, { signs: null, preflight: null, otherKeys: null });
  assert.deepEqual(passes(r), [false, false, false]);
  for (const bad of [undefined, -1, 1.5, '1', true]) assert.equal(passes({ signs: 0, preflight: bad, otherKeys: [] })[1], false, String(bad));
});

test('#309 drift: the counter\'s text, seeds and layout are the page\'s own (boot.mjs, session.mjs, screens/world.mjs) and the doc\'s', () => {
  const boot = text('permutation-gateway/demo/src/boot.mjs');
  const check = boot.slice(boot.indexOf('export async function cryptoCheck('), boot.indexOf('const CRYPTO = cryptoCheck();'));
  assert.match(check, /keyFromSeed\(new Uint8Array\(32\)\.fill\(7\)\)/, 'boot.mjs cryptoCheck: the throwaway seed 32 × 0x07');
  assert.match(check, /new TextEncoder\(\)\.encode\('Wylls demo preflight'\)/, 'and the fixed text');
  assert.equal((check.match(/\.sign\(msg\)/g) ?? []).length, 1, 'one signature in the test');
  assert.equal((boot.match(/cryptoCheck\(\)/g) ?? []).length, 1, 'boot.mjs runs the test once per load');
  assert.match(BODY, /const PRE = 'Wylls demo preflight'/);
  assert.match(BODY, /const SEEDS = \{ 7: 'preflight', 17: 'dev', 34: 'session' \};/);
  const world = text('permutation-gateway/screens/world.mjs');
  assert.match(world, /export const DEV_SEED = new Uint8Array\(32\)\.fill\(0x11\);/);
  assert.match(world, /export const SESSION_SEED = new Uint8Array\(32\)\.fill\(0x22\);/);
  assert.equal(PREFIX.length, 16, 'session.mjs PKCS8_PREFIX is 16 bytes: the counter\'s 48-byte length and subarray(16) match');
  assert.match(BODY, /b\.length !== 48\) return null; const s = b\.subarray\(16\)/);
  const doc = text('docs/ci/KEY-FREE-CI.ja.md');
  for (const s of ['0x11', '0x22', '0x07', 'Wylls demo preflight', '--pre-join']) assert.ok(doc.includes(s), `KEY-FREE-CI.ja.md names ${s}`);
});

/** One step of a workflow file (by its `- name:` line), as text, up to the next step or job. */
function stepText(yml, name) {
  const lines = yml.split('\n');
  const i = lines.findIndex(l => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `step "${name}"`);
  const ind = lines[i].indexOf('-');
  let j = i + 1;
  while (j < lines.length && !(lines[j].trim() && lines[j].search(/\S/) <= ind)) j++;
  return { text: lines.slice(i, j).join('\n'), line: i };
}

test('#309 CI wiring: the PR job runs the smoke at the real Pages host, 2 entries × EN/JA × desktop/phone, all --pre-join, on the bundle Pages builds', () => {
  const ci = text('.github/workflows/ci.yml');
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:/m, 'ci.yml runs on every pull request');
  const { text: step, line } = stepText(ci, 'Walletless demo at the real Pages host, pre-join (Playwright; only the load-time Ed25519 test signs)');
  // it sits in the walletless-demo job, not in key-tests
  const before = ci.split('\n').slice(0, line).join('\n');
  assert.ok(before.lastIndexOf('\n  walletless-demo:') > before.lastIndexOf('\n  key-tests:'), 'in the walletless-demo job');
  const job = ci.slice(before.lastIndexOf('\n  walletless-demo:'), ci.indexOf('\n  key-tests:'));
  assert.doesNotMatch(job, /\n {4}if:/, 'the job has no condition: it runs on push and pull_request');
  assert.match(step, /ORIGIN: https:\/\/\$\{\{ github\.repository_owner \}\}\.github\.io/, 'the real Pages host (not a loopback one)');
  assert.match(step, /BASE: \/\$\{\{ github\.event\.repository\.name \}\}\//);
  assert.match(step, /node build\.mjs --out dist-pages --base "\$BASE" --live-url "\$LIVE_URL"\n/, 'built as pages-demo.yml builds it');
  assert.match(step, /node check\.mjs --dir dist-pages\n/);
  assert.match(step, /for entry in '' frontier\/index\.html; do for lang in en ja; do for view in '' --mobile; do\n/);
  const runs = step.split('\n').filter(l => /smoke(-[\w-]+)?\.mjs/.test(l) && !l.trim().startsWith('#'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trim(), 'node smoke.mjs --dir dist-pages --origin "$ORIGIN" --prefix "$BASE" --path "$entry" --lang "$lang" $view --pre-join');
  const pages = text('.github/workflows/pages-demo.yml');
  assert.match(pages, /BASE: \/\$\{\{ github\.event\.repository\.name \}\}\//);
  assert.match(pages, /node build\.mjs --base "\$BASE" --live-url "\$LIVE_URL"\n/, 'pages-demo.yml: the same build arguments');
  // the smoke under --pre-join stops before the start button is pressed
  const preJoin = SMOKE.slice(SMOKE.indexOf('if (opt[\'pre-join\']) {\n  check(true'), SMOKE.indexOf('} else {\nconst tReady'));
  assert.doesNotMatch(preJoin, /go\.click\(\)/, 'never presses the start button');
  assert.match(preJoin, /!joined\.me && !joined\.session && !joined\.citizen/, 'and checks that nothing joined');
});
