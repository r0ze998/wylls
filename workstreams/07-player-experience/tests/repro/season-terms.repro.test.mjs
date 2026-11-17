// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
// Workstream 07, claim 5 and brief item 4: times read from the season.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonTimes, turnText, deadlineText, whyWrongStatus, s1Terms, spanText } from '../../src/season-terms.mjs';

const WEB = new URL('../../../../permutation-server/web/frontier/', import.meta.url);
const read = p => readFileSync(new URL(p, WEB), 'utf8');
const PRESETS_V2 = readFileSync(new URL('../../../../frontier-abi/src/v2/presets.rs', import.meta.url), 'utf8');

test('REPRO: the page writes the turn\'s length into its words and never names the join deadline', () => {
  assert.match(read('hud/glossary.mjs'), /L`10分ごとの区切りがターンです/);
  assert.match(read('screens/onboarding.mjs'), /ターン（10分ごとの区切り）/);
  assert.match(read('intro/title.mjs'), /十分ごとにターンが変わり/);
  const all = ['app.mjs', 'controller.mjs', 'screens/join.mjs', 'screens/onboarding.mjs', 'hud/hud.mjs', 'fjoin.mjs'].map(read).join('\n');
  assert.doesNotMatch(all, /joinCloseBell/, 'no screen reads the season\'s join deadline');
});
