// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. It imports
// src/game.mjs, which imports permutation-server/web/frontier modules (herald, faddr, fland, fcaravan, fplay) — the same
// closure the existing ③ tests load through the server, not re-checked for this file and NOT claimed key-free: run it
// only through the repository's key-free guard once runs are allowed again.
//
// A storehouse that could not be read is "not known", never "not yours" — and still refused (fail closed):
//   P1 feed not read + an unlisted storehouse id → Unknown (retryable, reason CaravanFeedUnavailable), not NotYourPlace
//   P2 feed read + an unlisted storehouse id → NotYourPlace (unchanged)
//   P3 feed not read + another village's id, or any other id → NotYourPlace (the village does not come from the feed)
//   P4 the own village (feed down or not) and a listed storehouse resolve as before
//   P5 the advice reads again; it never suggests sending
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../src/game.mjs';

const village = { kind: 'holding', placeId: 'village:1,1,0' };
const known = { kind: 'vault', placeId: 'vault:1,1,33', known: true };
const view = (feedOk, places = []) => ({ feedOk, places: [village, ...places] });
const code = fn => { try { fn(); return null; } catch (e) { assert.ok(e instanceof GameError); return e; } };

test('P1 feed not read: an unlisted storehouse is Unknown, not NotYourPlace', () => {
  const e = code(() => Game.placeOf(view(false), 'vault:1,1,33'));
  assert.equal(e.code, 'Unknown');
  assert.deepEqual(e.extra, { retryable: true, reason: 'CaravanFeedUnavailable' });
});

test('P2 feed read: an unlisted storehouse is NotYourPlace', () => {
  assert.equal(code(() => Game.placeOf(view(true, [known]), 'vault:-2,7,34')).code, 'NotYourPlace');
});

test('P3 feed not read: a village or any other id is still NotYourPlace', () => {
  for (const id of ['village:9,9,1', 'field:1,1,2', 'nonsense', '']) assert.equal(code(() => Game.placeOf(view(false), id)).code, 'NotYourPlace', id);
});

test('P4 own places resolve as before', () => {
  assert.equal(Game.placeOf(view(false), 'village:1,1,0'), village);
  assert.equal(Game.placeOf(view(true, [known]), 'vault:1,1,33'), known);
});

test('P5 the advice is to read again, never to send', () => {
  const e = code(() => Game.placeOf(view(false), 'vault:1,1,33'));
  assert.match(e.message, /read village_status again, then prepare again/);
  assert.doesNotMatch(e.message, /send/);
});
