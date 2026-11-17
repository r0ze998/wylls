// Proposing to expel a village (screens/s1.mjs expelOffer) is held back when that village is already expelled, as
// nation.rs propose_as decides it (KIND_EXPEL requires the target Citizen's expelled_since == 0, else ProposalState).
// The offer's own doc said "not expelled already" but its code did not check it (2026-11-16). The page knows from the
// nation's expelled list, which names each expelled village's holdings; with an older herald that names none, the
// program decides. No rule changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import * as S1 from '../../permutation-server/web/frontier/fs1.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('the program refuses to expel an expelled village (pinned as text), after the voter check', () => {
  const s = read('permutation-frontier/src/proc/nation.rs'), at = s.indexOf('fn propose_as('), f = s.slice(at, s.indexOf('\n}\n', at));
  assert.match(f, /let ok = tf == faction\n\s+&& if x\.kind == KIND_EXPEL \{\n\s+since == 0\n/);
  assert.match(f, /if !ok \{\n\s+return Err\(cq\(CqError::ProposalState\)\);/);
  assert.ok(f.indexOf('eligible(&pl, citizen)') < f.indexOf('since == 0'), 'the voter first');
});

const ALL = (1n << 61n) - 1n;
const store = () => ({ value: 10n ** 9n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, store), reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [] });
const prov = () => ({ p: 0, q: 0, layoutVersion: 2, passableMask: ALL, siteCount: 2, sites: [5, 6], siteMirror: [{ state: 1, faction: 1 }, { state: 1, faction: 1 }], resolvedNext: 449, structures: [], forts: [], caravans: [], entries: [] });
const world = expelled => ({ mode: 'play', nowBell: 450, chain: { now: () => 1000 }, citizen: { faction: 1, joinBell: 0, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 0, voted: [0, 0, 0, 0] },
  holdings: [holding(1, 0, 2, 20)], activeHolding: 0, provinces: new Map([['0,0', { province: prov() }]]),
  s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: { v: 1, stances: Array.from({ length: 6 }, () => Array(6).fill(0)), proposals: [], expelled, domesticRaids: [] } } });
const withS1 = fn => { S1.setS1({ layoutVersion: 2, programVersion: 4 }); try { return fn(); } finally { S1.setS1(null); } };

test('an expelled village on the chosen site: TargetExpelled; another village of the nation: as before', () => withS1(() => {
  const expelled = [{ tag: '44', faction: 1, since: 10, holdings: [{ p: 0, q: 0, site: 0 }] }];
  assert.deepEqual(SCR.expelOffer(world(expelled), { p: 0, q: 0, idx: 5 }).blocks, ['TargetExpelled']);
  assert.deepEqual(SCR.expelOffer(world(expelled), { p: 0, q: 0, idx: 6 }).blocks, [], 'site 1 is not expelled');
  assert.deepEqual(SCR.expelOffer(world([]), { p: 0, q: 0, idx: 5 }).blocks, [], 'nobody expelled');
  // an older herald names no holdings: the page cannot tell, the program decides
  assert.deepEqual(SCR.expelOffer(world([{ tag: '44', faction: 1, since: 10, holdings: [] }]), { p: 0, q: 0, idx: 5 }).blocks, []);
  // beside the voter check, in the program's order
  const early = { ...world(expelled), nowBell: 100 };
  assert.deepEqual(SCR.expelOffer(early, { p: 0, q: 0, idx: 5 }).blocks, ['NotVoter', 'TargetExpelled']);
}));

test('the card and its words, both languages', () => withS1(() => {
  const w = world([{ tag: '44', faction: 1, since: 10, holdings: [{ p: 0, q: 0, site: 0 }] }]);
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    try {
      const t = SCR.expelBlockText('TargetExpelled');
      if (lang === 'ja') assert.match(t, /もう追放されています/); else { assert.match(t, /already been expelled/); assert.doesNotMatch(t, /[぀-ヿ㐀-鿿]/); }
      const html = String(SCR.renderS1Tile(w, { p: 0, q: 0, idx: 5 }));
      assert.match(html, /data-act="s1-expel"[^>]*disabled|disabled[^>]*data-act="s1-expel"/, `${lang}: the expel button is disabled`);
      assert.ok(html.includes(t.replace(/'/g, '&#39;')), `${lang}: the card says why`);
    } finally { setLang('ja'); }
  }
}));
