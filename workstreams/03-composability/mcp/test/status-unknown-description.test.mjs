// get_village_status's description tells how to read what was not read (Lane C, 2026-11-17). WRITTEN, NOT RUN.
// KEY-FREE: no imports beyond node:test / node:assert / node:fs; tools.mjs is read as text (it imports auth.mjs, so it is
// not imported here — the same convention as instructions-flow.test.mjs). A text check of the description only; the data,
// the schema, server.mjs (status) and game.mjs (view) are not touched and not exercised here.
//   U1 caravanFeed "unavailable": empty storehouses / caravansOnTheRoad are "not read", not "none"
//      (game.mjs view: feed not ok → vaults and moving are []; server.mjs status: caravanFeed 'unavailable')
//   U2 a storehouse with known: false has stores: null: not known, not 0 (game.mjs view: !Array.isArray(v.stores))
//   U3 the sentences that were there before are unchanged
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
const start = src.indexOf("name: 'get_village_status'");
const end = src.indexOf("name: 'check_resource_shortfall'");
const block = start >= 0 && end > start ? src.slice(start, end) : '';
const desc = (block.match(/description: '((?:[^'\\]|\\.)*)'/) ?? [])[1] ?? '';

test('U1 an unavailable caravan feed means not read, not none', () => {
  assert.ok(desc, 'the get_village_status description is found');
  assert.match(desc, /caravanFeed says whether the caravan feed was read: when it is "unavailable", storehouses and caravansOnTheRoad are empty because they were not read, not because there are none\./);
});

test('U2 known: false stores are not known, not 0', () => {
  assert.match(desc, /A storehouse with known: false has stores: null: its stores are not known, not 0\./);
});

test('U3 the earlier sentences are unchanged', () => {
  assert.ok(desc.startsWith("The connected owner\\'s village now: stores, production per hour and caps; the owner\\'s storehouses and their stores;"));
  assert.match(desc, /Places carry a placeId to use with prepare_caravan\. Read this first\. No change\.$/);
});
