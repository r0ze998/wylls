// parseExact reads ④'s raw JSON text with u64 tags kept exact, on every
// JavaScript: with JSON.parse's source text (Node 21+) and without it (Node 20,
// the repository's CI version, where the other contract tests used to throw).
// The fallback quotes every unsafe integer literal before parsing; these tests
// pin that it gives the value the source-text path gives, refuses what
// JSON.parse refuses, and leaves strings, fractions and exponents alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { HAS_JSON_SOURCE, parseExact, quoteUnsafeIntegers } from '../src/adapters/ws04.mjs';

const fallback = text => JSON.parse(quoteUnsafeIntegers(text));
/** The source-text path, where this JavaScript has it (the reviver parseExact uses). */
const native = text => JSON.parse(text, (k, v, ctx) => (typeof v === 'number' && !Number.isSafeInteger(v) && /^-?\d+$/.test(ctx.source) ? ctx.source : v));

const CASES = [
  ['{"owner":18446744073709551557,"seq":0}', { owner: '18446744073709551557', seq: 0 }],
  ['[ 9223372036854775809 , -9223372036854775809,1,-1,0 ]', ['9223372036854775809', '-9223372036854775809', 1, -1, 0]],
  ['{"a":{"b":[9007199254740993]}}', { a: { b: ['9007199254740993'] } }],
  ['9007199254740991', 9007199254740991],
  ['9007199254740992', '9007199254740992'],
  ['{"x":0.5,"y":-2.25,"z":1e20,"w":12345678901234567890.5,"v":1E3}', { x: 0.5, y: -2.25, z: 1e20, w: 12345678901234567890.5, v: 1000 }],
  ['{"s":"12345678901234567890","t":"a\\"18446744073709551557\\\\","u":18446744073709551557}',
    { s: '12345678901234567890', t: 'a"18446744073709551557\\', u: '18446744073709551557' }],
  ['{"18446744073709551557":18446744073709551557}', { '18446744073709551557': '18446744073709551557' }],
  ['{"cargo":[0,4,0,0,0,0,0,0],"ok":true,"none":null}', { cargo: [0, 4, 0, 0, 0, 0, 0, 0], ok: true, none: null }],
];

test('unsafe integers become their decimal strings; safe integers, fractions, exponents and strings stay as they are', () => {
  for (const [text, want] of CASES) {
    assert.deepEqual(fallback(text), want, text);
    assert.deepEqual(parseExact(text), want, text);
  }
});

test('text with no unsafe integer is returned unchanged (same string), so the plain parse is the same parse', () => {
  const t = '{"a":1,"b":[2,3.5,"9223372036854775809"],"c":"x\\"y"}';
  assert.equal(quoteUnsafeIntegers(t), t);
});

test('what JSON.parse refuses is still refused: leading zeros, a lone minus, truncation, an unterminated string, a number as a key', () => {
  for (const bad of ['{"a":012345678901234567890}', '[-]', '{"a":18446744073709551557', '{"a":"18446744073709551557}', '[1,]', '--18446744073709551557', '{18446744073709551557:1}', '{18446744073709551557 :1}']) {
    assert.throws(() => fallback(bad), SyntaxError, bad);
    assert.throws(() => parseExact(bad), SyntaxError, bad);
  }
});

test('where this JavaScript has the source text, the fallback reads every case as the source-text path does', { skip: !HAS_JSON_SOURCE && 'no JSON.parse source text here (Node 20): the fallback is the only path' }, () => {
  for (const [text] of CASES) assert.deepEqual(fallback(text), native(text), text);
  // seeded generated documents: nested objects and arrays, u64-sized and small integers, fractions, escaped strings
  let seed = 15;
  const rnd = k => ((seed = (seed * 1103515245 + 12345) % 2147483648) % k);
  const big = () => `${rnd(2) ? '-' : ''}${1 + rnd(9)}${Array.from({ length: 15 + rnd(5) }, () => rnd(10)).join('')}`;
  const str = () => JSON.stringify(`${['a', '"', '\\', '1844674407370955155', ':', ' '][rnd(6)]}${big()}`);
  const val = d => {
    const r = rnd(d > 2 ? 5 : 7);
    if (r === 0) return big();
    if (r === 1) return String(rnd(1000) - 500);
    if (r === 2) return `${rnd(100)}.${rnd(100)}${rnd(2) ? 'e3' : ''}`;
    if (r === 3) return str();
    if (r === 4) return ['true', 'false', 'null'][rnd(3)];
    if (r === 5) return `[ ${Array.from({ length: rnd(4) }, () => val(d + 1)).join(' ,')} ]`;
    return `{${Array.from({ length: rnd(4) }, (_, i) => `${i ? str() : JSON.stringify(big())} :\n${val(d + 1)}`).join(',')}}`;
  };
  for (let k = 0; k < 500; k++) { const t = val(0); assert.deepEqual(fallback(t), native(t), t); }
});

test('④\'s raw texts in the fixtures read the same either way, and their u64 tags past 2^53 are exact', () => {
  const root = new URL('../scenarios/fixtures/', import.meta.url);
  const texts = [];
  for (const d of readdirSync(root).filter(n => n.startsWith('ws04-') && !n.endsWith('.json'))) {
    for (const f of readdirSync(new URL(`${d}/`, root)).filter(n => n.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(new URL(`${d}/${f}`, root), 'utf8'));
      for (const r of j.receipts ?? []) for (const k of ['body_json', 'body']) if (typeof r[k] === 'string') texts.push(r[k]);
      for (const v of Object.values(j.run_specs_json ?? {})) if (typeof v === 'string') texts.push(v);
      for (const r of j.runs ?? []) for (const k of ['spec', 'detail']) if (typeof r[k] === 'string') texts.push(r[k]);
    }
  }
  assert.ok(texts.length >= 10, `raw texts found: ${texts.length}`);
  let unsafe = 0;
  for (const t of texts) {
    const a = fallback(t);
    if (HAS_JSON_SOURCE) assert.deepEqual(a, native(t));
    assert.deepEqual(parseExact(t), a);
    if (quoteUnsafeIntegers(t) !== t) unsafe++;
  }
  // chain-flow's run spec carries u64 tags past 2^53 (1973050754706772817): the cases the old code threw on in Node 20
  assert.ok(unsafe > 0, 'some fixture text has an integer past 2^53');
  assert.ok(texts.some(t => JSON.stringify(parseExact(t)).includes('"1973050754706772817"')));
});
