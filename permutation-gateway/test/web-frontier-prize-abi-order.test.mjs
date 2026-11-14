// ⑰ (2026-11-15): the NFT pass instructions' account lists agree across the three places that build or read
// them: the prize program's handlers (permutation-prize/src/lib.rs, the order it destructures), the page's SDK
// builders (permutation-gateway/client/src/frontier/prize.mjs, its generated web copy is checked by
// sync-web-sdk) and the TEST ONLY LiteSVM test (permutation-prize/svm-tests/tests/nft_pass.rs `claim_ix`).
// An account out of order, or a read-only flag where the program writes (the class of
// ReadonlyDataModified the review caught in the resident MintResident), fails here before any build.
//
// PURE: source files read as text. No key, no address derivation, no chain, no build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const src = p => readFileSync(new URL(p, root), 'utf8');
const lib = src('permutation-prize/src/lib.rs');
const sdk = src('permutation-gateway/client/src/frontier/prize.mjs');
const svm = src('permutation-prize/svm-tests/tests/nft_pass.rs');

/** The account names a handler destructures: `let [a, b, …] = a else`. */
function rustOrder(fnName) {
  const at = lib.indexOf(`pub fn ${fnName}(`);
  assert.ok(at >= 0, fnName);
  const m = lib.slice(at, at + 2000).match(/let \[([^\]]+)\]\s*=\s*\n?\s*a\s*\n?\s*else/);
  assert.ok(m, `${fnName}: destructuring`);
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/** The SDK builder's keys: [{expr, writable, signer}] from `keys: [R(…), W(…), …]`. */
function sdkKeys(name) {
  const at = sdk.indexOf(name);
  assert.ok(at >= 0, name);
  const body = sdk.slice(at, at + 1500);
  const k = body.slice(body.indexOf('keys: [') + 7);
  const out = [];
  let depth = 0, cur = '', i = 0;
  for (; i < k.length; i++) {
    const c = k[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ']' && depth === 0) break;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(e => ({ expr: e, writable: e.startsWith('W('), signer: /,\s*true\)$/.test(e) }));
}

/** The svm test's ClaimResident AccountMetas: [{expr, writable, signer}]. */
function svmClaimKeys() {
  const at = svm.indexOf('fn claim_ix(');
  assert.ok(at >= 0, 'claim_ix');
  const body = svm.slice(at, svm.indexOf('\n}\n', at));
  return [...body.matchAll(/AccountMeta::(new|new_readonly)\(([^;]*?)\),\n/g)].map(([, kind, args]) => ({
    expr: args.replace(/\s+/g, ' ').trim(),
    writable: kind === 'new',
    signer: /, (true|signed)$/.test(args.replace(/\s+/g, ' ').trim()),
  }));
}

// Each Rust name, how the SDK and the svm test name the same account, and whether the program writes it.
const CLAIM = [
  ['owner', /^R\(owner, true\)$/, /^\*signer, signed$/, false, true],
  ['pool_ai', /prize\.pool/, /w\.pool, false/, true, false],
  ['entry_ai', /entryResidentAddress/, /s\.entry, false/, true, false],
  ['citizen', /^R\(citizen\)$/, /s\.citizen, false/, false, false],
  ['link', /^R\(link\)$/, /link_of/, false, false],
  ['vault', /prize\.vault/, /w\.vault, false/, true, false],
  ['to', /dest \?\? ata\(owner, prize\.mint\)/, /\*to, false/, true, false],
  ['mint', /^R\(prize\.mint\)$/, /w\.mint, false/, false, false],
  ['token', /^R\(TOKEN_PROGRAM\)$/, /TOKEN, false/, false, false],
  ['policy_ai', /^R\(policy\)$/, /w\.policy, false/, false, false],
  ['asset', /^R\(asset\)$/, /s\.pass\.asset, false/, false, false],
  ['resident', /^R\(resident\)$/, /s\.pass\.resident, false/, false, false],
];

test('ClaimResident: the program, the page SDK and the LiteSVM test name the same 12 accounts in the same order with the same write flags', () => {
  const rust = rustOrder('claim_resident');
  assert.deepEqual(rust, CLAIM.map(c => c[0]), 'the program\'s order');
  const js = sdkKeys('export function claimResidentIx');
  const rs = svmClaimKeys();
  assert.equal(js.length, 12, 'SDK: 12 accounts');
  assert.equal(rs.length, 12, 'svm test: 12 accounts');
  CLAIM.forEach(([name, jsRe, svmRe, writable, signer], i) => {
    assert.match(js[i].expr, jsRe, `SDK #${i} is ${name}`);
    assert.equal(js[i].writable, writable, `SDK #${i} ${name} writable=${writable}`);
    assert.equal(js[i].signer, signer, `SDK #${i} ${name} signer=${signer}`);
    assert.match(rs[i].expr, svmRe, `svm #${i} is ${name}`);
    assert.equal(rs[i].writable, writable, `svm #${i} ${name} writable=${writable}`);
  });
  // The program refuses a writable asset or resident (current_owner), so both must stay read-only.
  assert.match(lib, /if asset\.is_writable \|\| resident\.is_writable \{\s*return Err\(E::BadAccount\.into\(\)\);/);
});

test('RecordResidentNation: the program and the page SDK agree (pool read-only, Entry writable, Citizen read-only, no signer)', () => {
  assert.deepEqual(rustOrder('record_resident_nation'), ['pool_ai', 'entry_ai', 'citizen']);
  const js = sdkKeys('export const recordResidentNationIx');
  assert.deepEqual(js.map(k => [k.writable, k.signer]), [[false, false], [true, false], [false, false]]);
  assert.match(js[0].expr, /prize\.pool/);
  assert.match(js[1].expr, /entryResidentAddress/);
  assert.match(js[2].expr, /citizen/);
  // The svm test's call passes the same three in the same order.
  const at = svm.indexOf('tag::RECORD_RESIDENT_NATION');
  const body = svm.slice(svm.lastIndexOf('prize_ix(', at), at);
  assert.deepEqual([...body.matchAll(/AccountMeta::(new|new_readonly)\(([^)]*)\)/g)].map(([, k, a]) => [k, a.split(',')[0].trim()]),
    [['new_readonly', 'w.pool'], ['new', 's.entry'], ['new_readonly', 's.citizen']]);
});

test('the deposit instruction stays refused at dispatch in the program, whatever its accounts', () => {
  assert.match(lib, /tag::PAY_RESIDENT => Err\(E::ResidentDepositsDisabled\.into\(\)\)/);
  assert.match(svm, /fails\(send\(&mut w\.svm, &\[ix\], &\[&a\]\), E::ResidentDepositsDisabled\)/);
});
