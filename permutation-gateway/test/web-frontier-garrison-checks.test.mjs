// The village Garrison form against host.rs garrison_as (2026-11-16): after the capture lock, finality and the
// Province's turn, the program refuses a change of n whole Spearmen when n ≤ 0 (BadData), when the reserve is short
// (Insufficient), and when n is above the garrison's room — 30,000 less the troops and the changes still pending, after
// the changes of turns before resolved_next are applied (GarrisonState::change, HOST_TOO_LARGE). The form sent any
// number. Rust conditions are pinned as text; nothing here changes a rule. Nothing is built, signed or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { garrisonRoom, GARRISON_MAX_TROOPS, NO_BELL } from '../../permutation-server/web/frontier/fland.mjs';
import { garrisonProblem, garrisonProblemText } from '../../permutation-server/web/frontier/screens/holding.mjs';
import { errorText, clientText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const body = (file, fn) => { const s = read(file), at = s.indexOf(`fn ${fn}(`); assert.ok(at >= 0, `${file} ${fn}`); return s.slice(at, s.indexOf('\n}\n', at)); };

test('the program: the order of the checks, the room and the settle (pinned as text)', () => {
  const g = body('permutation-frontier/src/proc/host.rs', 'garrison_as');
  const order = ['lock_own(province, &hh)?;', 'FrontierError::NotFinal', 'FrontierError::NotResident', 'if x.delta <= 0', 'Ro(&hd).u32(H::reserve(GARRISON_UNIT))?', 'FrontierError::Insufficient', 'g.change(b, delta_milli, rn)'];
  const at = order.map(x => g.indexOf(x));
  assert.ok(at.every(i => i >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order');
  assert.match(read('permutation-frontier/src/proc/host.rs'), /pub const GARRISON_UNIT: usize = 0;/);
  assert.match(read('permutation-frontier/src/proc/host.rs'), /Ok\(\(bell != SM::NO_BELL && delta != 0\)\.then_some\(\(bell, delta\)\)\)/, 'garrison_of: an empty pending item');
  const rules = read('permutation-rules/src/frontier/host.rs');
  assert.match(rules, new RegExp(`pub const MAX_HOST_TROOPS: MilliTroops = ${GARRISON_MAX_TROOPS.toLocaleString('en').replace(',', '_')} \\* MILLI as MilliTroops;`));
  assert.match(body('permutation-rules/src/frontier/host.rs', 'change'), /self\.settle\(resolved_next\);\s*if delta > 0 && delta > self\.room\(\) as i64 \{\s*return Err\(HostError::TooLarge\);/);
  assert.match(rules, /\(MAX_HOST_TROOPS as i64 - self\.projected\(\)\)\.clamp\(0, MAX_HOST_TROOPS as i64\) as MilliTroops/);
  assert.match(rules, /if b < resolved_next \{\s*let v = \(self\.troops as i64\)\s*\.saturating_add\(d\)\s*\.clamp\(0, MAX_HOST_TROOPS as i64\);/);
  assert.match(read('frontier-abi/src/layout/province.rs'), new RegExp(`pub const NO_BELL: u32 = u32::MAX;`));
  assert.equal(NO_BELL, 2 ** 32 - 1);
});

const mirror = (garrison, p0 = [NO_BELL, 0], p1 = [NO_BELL, 0], extra = {}) => ({ state: 1, gen: 7, garrison, pend0Bell: p0[0], pend0Delta: String(p0[1]), pend1Bell: p1[0], pend1Delta: String(p1[1]), ...extra });

test('garrisonRoom: 30,000 less the troops and what is still pending; a resolved change is applied first, clamped', () => {
  assert.equal(garrisonRoom(mirror(0), 10), 30_000);
  assert.equal(garrisonRoom(mirror(29_000_000), 10), 1_000);
  assert.equal(garrisonRoom(mirror(20_000_000, [10, 5_000_000]), 10), 5_000, 'turn 10 not resolved yet (resolved_next 10): still pending');
  assert.equal(garrisonRoom(mirror(20_000_000, [9, 5_000_000]), 10), 5_000, 'turn 9 resolved: applied — the same room');
  assert.equal(garrisonRoom(mirror(28_000_000, [9, 5_000_000], [10, 1_000_000]), 10), 0, 'applied and clamped to 30,000, then 1,000 pending');
  assert.equal(garrisonRoom(mirror(30_000_000), 10), 0);
  assert.equal(garrisonRoom(mirror(10_500), 10), 29_989, 'milli-troops: the whole troops that fit');
});

const village = (extra = {}) => ({ p: 2, q: 0, site: 1, tile: 30, gen: 7, state: 2, faction: 2, explore: null, finalTs: '0', reserve: [500, 0, 0, 0, 0, 0, 0, 0], ...extra });
const world = (m, { h = village(), resolvedNext = 99, p = 2 } = {}) => ({ nowBell: 100, chain: { now: () => 1 }, citizen: { faction: 2 }, holdings: [h], activeHolding: 0,
  provinces: new Map([[`${h.p},${h.q}`, { province: { p, q: 0, resolvedNext, siteMirror: [{ state: 0, gen: 0 }, m], entries: [], ticketCohorts: [] } }]]) });

test('garrisonProblem: the number itself, in the program\'s order, before anything is signed', () => {
  assert.equal(garrisonProblem(world(mirror(0)), 100), null);
  assert.deepEqual(garrisonProblem(world(mirror(0)), 0), { code: 'BadTroops' });
  assert.deepEqual(garrisonProblem(world(mirror(0)), NaN), { code: 'BadTroops' });
  assert.deepEqual(garrisonProblem(world(mirror(0)), 501), { code: 'Insufficient' }, 'the Spearman reserve is 500');
  assert.deepEqual(garrisonProblem(world(mirror(29_800_000)), 300), { code: 'GarrisonFull', room: 200 });
  assert.deepEqual(garrisonProblem(world(mirror(29_800_000)), 600), { code: 'Insufficient' }, 'the reserve before the room, as the program');
  assert.equal(garrisonProblem(world(mirror(29_800_000)), 200), null);
  assert.equal(garrisonProblem(world(mirror(29_800_000, [NO_BELL, 0], [NO_BELL, 0], { state: 3 })), 300), null, 'not this village\'s mirror: the program decides the room');
  assert.equal(garrisonProblem(world(mirror(29_800_000), { p: 9 }), 300), null, 'another Province: the program decides the room');
  assert.equal(garrisonProblem(world(mirror(0), { h: village({ reserve: undefined }) }), 501), null, 'no reserve read: the program decides');
  assert.equal(garrisonProblem({ holdings: [], activeHolding: 0, provinces: new Map() }, 100), null);
});

test('the controller asks it before signing, and only outside the wide card (WideReadOnly answers there first)', () => {
  const src = read('permutation-server/web/frontier/controller.mjs');
  const at = src.indexOf('function garrisonOrder(n) {'), g = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(g, /const pr = FS\.wideSelect \? null : garrisonProblem\(FS, k\);/);
  assert.ok(g.indexOf('garrisonProblem(FS, k)') < g.indexOf("act('Garrison'"), 'before the act');
});

test('the words, in both languages', () => {
  assert.equal(garrisonProblemText({ code: 'GarrisonFull', room: 200 }), '守備隊にはあと 200 人まで入れられます');
  assert.equal(garrisonProblemText({ code: 'BadTroops' }), '増やす人数は 1 以上の整数です');
  assert.equal(garrisonProblemText({ code: 'Insufficient' }), errorText('Insufficient'));
  setLang('en');
  try {
    assert.equal(garrisonProblemText({ code: 'GarrisonFull', room: 200 }), 'The garrison has room for 200 more');
    assert.equal(garrisonProblemText({ code: 'BadTroops' }), 'Enter a whole number from 1');
    assert.equal(clientText('GarrisonFull'), 'The garrison has no room for that many', 'the page\'s own code (fi18n CLIENT_TEXT)');
  } finally { setLang('ja'); }
});
