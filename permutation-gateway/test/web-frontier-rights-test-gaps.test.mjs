// test-gaps-2 (2026-11-26; tests only, no behaviour changed): what the verifiers of #113 and #119 checked by hand or
// live for ② rights (owner decision ② A: StockSwap → the facility's Vault, hauled by caravan, issuance wallet-only) and
// the ②+⑨+⑩ coexist lane, as key-free unit tests.
//  1. The lane the page plays (flocalplay-lane.mjs, pinned there by hand) is the Rust ABI's: the coexist lane's program
//     version 0x7805 (frontier-abi feature_registry COEXIST_LANE_VERSION, registry rev 8) with RULESET_HASH_V4, the
//     plain lane's 0x4804 with RULESET_HASH_V3 — read from the shared vectors frontier-abi/vectors/custody-addresses.txt.
//  2. A Grant's address (flocalplay-rights.mjs grantSeed / grantAddress, the account the relay reads before a Grant
//     command) is the Rust ABI's v2::rights::grant over the same vectors.
//  3. Wallet-only stays wallet-only everywhere the rule is listed: every RIGHTS_WALLET_ONLY command (② A's IssueGrant /
//     RevokeGrant and ⑨⑩'s GrantCapacity / RevokeCapacity / OpenLot) is NEVER_DELEGATED for an agent, and none of them
//     is a command a resident's relay builds (LOCAL_ACT_COMMANDS: what the operator AI and ⑬'s external residents send).
//     The program itself still accepts a session signer for RevokeGrant (D-verify-pr119-1), so these lists are the only
//     guard — the reason they are pinned against each other here, in CI (frontier-local-play-rights.test.mjs, which
//     checks one of them, signs and is local-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as LANE from '../../permutation-server/web/frontier/flocalplay-lane.mjs';
import * as R from '../../permutation-server/web/frontier/flocalplay-rights.mjs';
import { PREVIEW_WALLET_ONLY, PREVIEW_ACTS } from '../../permutation-server/web/frontier/flocalplay-custody.mjs';
import { NEVER_DELEGATED } from '../src/frontier/agent/contract.mjs';
import { LOCAL_ACT_COMMANDS } from '../src/frontier/local-play-act.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const LINES = readFileSync(new URL('../../frontier-abi/vectors/custody-addresses.txt', import.meta.url), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#'));
const b58 = h => encode(Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))));
const CTX = LINES.find(l => l.startsWith('ctx ')).split(' ');
const WORLD = b58(CTX[1]), PROGRAM = b58(CTX[2]);
const lane = name => { const [, , v, h] = LINES.find(l => l.startsWith(`lane ${name} `)).split(' '); return { version: Number(v), hash: h }; };

test('② the page\'s two lanes are the Rust ABI\'s: coexist 0x7805 with RULESET_HASH_V4, plain 0x4804 with RULESET_HASH_V3', () => {
  const co = lane('coexist'), plain = lane('plain');
  assert.equal(co.version, 0x7805);
  assert.equal(LANE.COEXIST_LANE.programVersion, co.version);
  assert.equal(LANE.COEXIST_LANE.programVersionText, String(co.version));
  assert.equal(LANE.COEXIST_LANE.rulesetHash, co.hash);
  assert.equal(LANE.PLAIN_LANE.programVersion, plain.version);
  assert.equal(LANE.PLAIN_LANE.rulesetHash, plain.hash);
  assert.notEqual(co.hash, plain.hash);
  assert.equal(LANE.laneOfRuleset(co.hash), LANE.COEXIST_LANE);
  assert.equal(LANE.laneOfVersion(co.version), LANE.COEXIST_LANE);
});

test('② a Grant\'s seed and address are the Rust ABI\'s (v2::rights::grant_seed / grant, create_with_seed)', () => {
  const cases = LINES.filter(l => l.startsWith('grant '));
  assert.equal(cases.length, 20);
  for (const l of cases) {
    const [left, right] = l.split(' | ');
    const [, tag, nonce] = left.split(' ');
    const [seed, addr] = right.split(' ');
    assert.equal(R.grantSeed(tag, Number(nonce)), seed, l);
    assert.equal(R.grantAddress(WORLD, PROGRAM, tag, Number(nonce)), b58(addr), l);
  }
});

test('② A: issuing and revoking (Grants, ⑨ capacity grants, ⑩ lots) are wallet-only in every list that says so', () => {
  for (const n of ['IssueGrant', 'RevokeGrant']) assert.ok(R.RIGHTS_WALLET_ONLY.includes(n), n);
  for (const n of PREVIEW_WALLET_ONLY) {
    assert.ok(R.RIGHTS_WALLET_ONLY.includes(n), n);
    assert.ok(PREVIEW_ACTS.includes(n), `${n} is a ⑨/⑩ act`);
  }
  for (const n of R.RIGHTS_WALLET_ONLY) {
    assert.ok(NEVER_DELEGATED.includes(n), `${n} is wallet-only but an agent policy could delegate it`);
    assert.ok(!LOCAL_ACT_COMMANDS.includes(n), `${n} is wallet-only but a resident's relay builds it`);
    assert.ok(R.COEXIST_ACTS.includes(n), `${n} is a coexist act (the page's own lane sends it)`);
  }
});
