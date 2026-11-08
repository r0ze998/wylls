// Workstream 07: what the page shows when the viewer's record (/h/me) fails, through the real controller
// (controller.applyMeResult, adoptConnectedWallet, adoptResident, useHerald) and hud/drawer.mjs viewerState.
// - The first read fails (no answer yet for this viewer and world): 'unreachable' — never the nation choice.
// - "Not joined" (NotFound) answered, then a read fails: what was shown stays (the nation choice), until a newer answer.
// - The kept answer is this viewer's and this world's only: a wallet switch, a disconnect, another NFT (or none),
//   another herald (world) each clear it, so a failure right after is 'unreachable' again — never the former
//   identity's "not joined". (A reply still in flight for the former viewer is dropped by refresh's currentViewer check.)
// No key is made or used: the wallets are names only; nothing is signed or sent.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const C = await import('../../permutation-server/web/frontier/controller.mjs');
const { FS } = await import('../../permutation-server/web/frontier/fstate.mjs');
const { viewerState, joinOpen } = await import('../../permutation-server/web/frontier/hud/drawer.mjs');
const { encode: b58 } = await import('../../permutation-server/web/sdk/base58.mjs');

const name = n => b58(new Uint8Array(32).fill(n));
const A = { address: name(0xa1) }, B = { address: name(0xb2) };
const FAIL = { ok: false, code: 'Unavailable' }, NOT_JOINED = { ok: false, code: 'NotFound' };
const state = () => [viewerState(FS), joinOpen(FS)];

beforeEach(() => {
  C.adoptConnectedWallet(null);
  C.adoptConnectedWallet(A);
  FS.mode = 'play'; FS.playReady = true; FS.titleUp = false; FS.joinShut = false;
});

test('a first read that fails is unreachable; "not joined" then a failure keeps the nation choice', () => {
  assert.equal(FS.meAnswered, false);
  C.applyMeResult(FAIL);
  assert.deepEqual(state(), ['unreachable', false], 'no answer yet: never the nation choice');
  C.applyMeResult(NOT_JOINED);
  assert.deepEqual(state(), ['known', true], 'answered: not joined');
  C.applyMeResult(FAIL);
  assert.equal(FS.meStatus, 'error');
  assert.deepEqual(state(), ['known', true], 'answered before, failing now: the nation choice stays');
});

for (const [what, change] of [
  ['another wallet', () => C.adoptConnectedWallet(B)],
  ['a disconnect and the same wallet again', () => { C.adoptConnectedWallet(null); C.adoptConnectedWallet(A); }],
  ['an NFT played', () => C.adoptResident({ asset: name(0x5a), citizen: name(0x5b), joined: true })],
  ['another herald (world)', () => C.useHerald({ me: async () => FAIL })],
]) {
  test(`${what}: the former answer is not kept`, () => {
    C.applyMeResult(NOT_JOINED);
    assert.deepEqual(state(), ['known', true]);
    change();
    assert.equal(FS.meAnswered, false, 'cleared');
    C.applyMeResult(FAIL);
    assert.deepEqual(state(), ['unreachable', false], 'a failure now is "not read", not the former "not joined"');
    if (FS.resident) C.adoptResident(null);
  });
}

test('the NFT given up: the wallet\'s own record must answer again', () => {
  C.adoptResident({ asset: name(0x5a), citizen: name(0x5b), joined: true });
  C.applyMeResult(NOT_JOINED);
  C.adoptResident(null);
  assert.equal(FS.meAnswered, false);
  C.applyMeResult(FAIL);
  assert.deepEqual(state(), ['unreachable', false]);
});
