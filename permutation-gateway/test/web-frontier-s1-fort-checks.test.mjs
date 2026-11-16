// The S1 fort form (screens/s1.mjs) checks what structure.rs fort_garrison_as refuses, before anything is signed
// (2026-11-16): a village not final after the lazy flip (NotFinal), a Province behind the turn (NotResident), more troops
// than the selected fort's room (StructureLimit) or than the reserve's Spearmen (Insufficient). The form used to check
// only the reserve (its input max) and FORT_MAX_TROOPS; the rest was refused on send. No rule changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { errorText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('the program\'s refusals, pinned as text, and the room the page computes', () => {
  const s = read('permutation-frontier/src/proc/structure.rs'), at = s.indexOf('fn fort_garrison_as('), f = s.slice(at, s.indexOf('\n}\n', at));
  assert.match(f, /if x\.troops == 0 \|\| x\.troops > kt::FORT_MAX_TROOPS \{\n\s+return Err\(FrontierError::BadData\.into\(\)\);/);
  assert.match(f, /if hold::finality\(&pl, &hh, holding, citizen, province\)\? != H::STATE_FINAL \{\n\s+return Err\(FrontierError::NotFinal\.into\(\)\);/);
  assert.match(f, /if !frontier_abi::prologue::resident_ok\(r\.u32\(P::RESOLVED_NEXT\)\?, b\) \{\n\s+return Err\(FrontierError::NotResident\.into\(\)\);/);
  assert.match(f, /if troops \/ MILLI as u32 \+ pend > kt::FORT_MAX_TROOPS \{\n\s+return Err\(cq\(CqError::StructureLimit\)\);/);
  assert.match(f, /if have < x\.troops \{\n\s+return Err\(FrontierError::Insufficient\.into\(\)\);/);
  assert.ok(f.indexOf('StructureLimit') < f.indexOf('Insufficient'), 'the room before the reserve');
  assert.match(read('frontier-abi/src/prologue.rs'), /pub const fn resident_ok\(resolved_next: u32, b: u32\) -> bool \{\n    resolved_next as u64 \+ 1 >= b as u64/);
  assert.match(read('permutation-rules/src/frontier/structure.rs'), /pub const FORT_MAX_TROOPS: u32 = 2_000;/);
  assert.equal(SCR.FORT_MAX_TROOPS, 2000);
});

const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const village = (extra = {}) => ({ p: 0, q: 0, site: 0, tile: 30, gen: 1, state: 2, tier: 1, faction: 1, finalTs: '0', ticketBell: 1, ownerCitizen: new Uint8Array(32).fill(7),
  stores: Array.from({ length: 8 }, () => store(1000)), reserve: [500, 0, 0, 0, 0, 0, 0, 0], queue: [], ...extra });
const prov = (extra = {}) => ({ p: 0, q: 0, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 1, sites: [5], camp: { state: 0, tile: 7 }, keep: { tile: 8, holder: 1 },
  resolvedNext: 99, structures: [], forts: [{ tile: 40, state: 1, troops: 1_500_000n, pend: 100 }], caravans: [], ticketCohorts: [], siteMirror: [{ state: 1, gen: 1 }], ...extra });
const world = (h = village(), pv = prov(), nowBell = 100) => {
  const base = { mode: 'play', nowBell, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 1, caravans: 0, voted: [0, 0, 0, 0] },
    holdings: [h], activeHolding: 0, provinces: new Map([['0,0', { province: pv }]]) };
  const tag = SCR.viewerTag(base);
  return { ...base, s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [{ p: 0, q: 0, tile: 40, kind: 3, faction: 1, ownerTag: tag, gen: 1 }], sightings: [] }, nations: null } };
};

test('village-wide blocks: not final, Province behind; a due lazy flip counts as final, as the program flips it', () => {
  assert.deepEqual(SCR.s1VillageModel(world()).fortBlocks, []);
  // provisional (state 1), final time not reached: NotFinal
  assert.deepEqual(SCR.s1VillageModel(world(village({ state: 1, finalTs: '5000' }))).fortBlocks, ['NotFinal']);
  // provisional but the flip is due (time passed, its ticket cohort closed): the program flips it inside this action
  assert.deepEqual(SCR.s1VillageModel(world(village({ state: 1, finalTs: '10' }))).fortBlocks, []);
  // the Province two turns behind: NotResident (resolved_next + 1 >= bell is fine)
  assert.deepEqual(SCR.s1VillageModel(world(village(), prov({ resolvedNext: 97 }))).fortBlocks, ['NotResident']);
  assert.deepEqual(SCR.s1VillageModel(world(village(), prov({ resolvedNext: 99 }))).fortBlocks, []);
  // beside the capture lock (order kept: the lock first)
  assert.deepEqual(SCR.s1VillageModel(world(village({ state: 1, finalTs: '5000' }), prov({ siteMirror: [{ state: 1, gen: 2 }], resolvedNext: 97 }))).fortBlocks, ['CapturePending', 'NotFinal', 'NotResident']);
});

test('the numbers: the selected fort\'s room after its pending troops, then the reserve', () => {
  const m = SCR.s1VillageModel(world());
  assert.equal(m.forts[0].room, 400, '2000 − (1500 + 100 pending)');
  assert.equal(m.spearmen, 500);
  assert.equal(SCR.fortGarrisonProblem(m, 40, 400), null, 'exactly the room');
  assert.deepEqual(SCR.fortGarrisonProblem(m, 40, 401), { code: 'FortFull', room: 400 });
  const roomy = SCR.s1VillageModel(world(village(), prov({ forts: [{ tile: 40, state: 1, troops: 0n, pend: 0 }] })));
  assert.deepEqual(SCR.fortGarrisonProblem(roomy, 40, 501), { code: 'Insufficient' }, 'room enough, reserve short');
  assert.deepEqual(SCR.fortGarrisonProblem(m, 41, 10), { code: 'NoFort' });
  assert.deepEqual(SCR.fortGarrisonProblem(m, 40, 0), { code: 'BadTroops' });
  assert.deepEqual(SCR.fortGarrisonProblem(m, 40, 2001), { code: 'BadTroops' });
  const notFinal = SCR.s1VillageModel(world(village({ state: 1, finalTs: '5000' })));
  assert.deepEqual(SCR.fortGarrisonProblem(notFinal, 40, 10), { code: 'NotFinal' }, 'the village-wide block first');
});

test('the words, both languages; the form is closed with the reason while a village-wide block holds', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    try {
      const full = SCR.fortProblemText({ code: 'FortFull', room: 400 });
      assert.equal(full, lang === 'ja' ? 'この要塞にはあと 400 人まで入れられます' : 'This fort has room for 400 more');
      assert.equal(SCR.fortProblemText({ code: 'NotFinal' }), errorText('NotFinal'));
      assert.equal(SCR.fortProblemText({ code: 'BadTroops' }), lang === 'ja' ? '入れる人数は 1 から 2,000 までです' : 'Enter between 1 and 2,000');
      const html = String(SCR.renderS1Village(world(village({ state: 1, finalTs: '5000' }))));
      const form = html.slice(html.indexOf('data-form="s1-fort"'), html.indexOf('</form>', html.indexOf('data-form="s1-fort"')));
      assert.match(form, /<button type="submit" class="btn" disabled>/);
      assert.ok(form.includes(errorText('NotFinal')), `${lang}: says why`);
      if (lang === 'en') for (const t of [full, SCR.fortProblemText({ code: 'NoFort' })]) assert.doesNotMatch(t, /[぀-ヿ㐀-鿿]/);
    } finally { setLang('ja'); }
  }
});
