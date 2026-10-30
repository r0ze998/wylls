// The committed scenario inputs are exactly what scenarios/build.mjs builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canon.mjs';
import { SCENARIOS } from '../scenarios/build.mjs';
import { load } from './helpers.mjs';

test('every committed scenario equals its builder\'s output', () => {
  for (const [name, sc] of Object.entries(SCENARIOS)) assert.equal(canonical(load(name)), canonical(sc), name);
});
