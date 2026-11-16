// Muster's ProvinceFull (host.rs muster_as): before it writes the new host, the program counts the village's own Province
// — hosts standing or forming (entry states 1 and 2), 48 in all (PROVINCE_HOST_CAP) and 8 of the village's nation
// (FACTION_RESIDENT_CAP) — and needs a free entry. The page offered the Muster and only the send was refused
// (2026-11-16). Rust conditions are pinned as text; nothing here changes a rule. Nothing is built, signed or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionBlocks, provinceFull, PROVINCE_HOST_CAP, FACTION_RESIDENT_CAP, PROVINCE_ENTRIES } from '../../permutation-server/web/frontier/fland.mjs';
import { errorText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const body = (file, fn) => { const s = read(file), at = s.indexOf(`fn ${fn}(`); assert.ok(at >= 0, `${file} ${fn}`); return s.slice(at, s.indexOf('\n}\n', at)); };

test('the program: the caps over states 1–2 and a free entry, with these numbers (pinned as text)', () => {
  const m = body('permutation-frontier/src/proc/host.rs', 'muster_as');
  assert.match(m, /E::STATE_FREE => \{\s*if free\.is_none\(\) \{\s*free = Some\(i\);/);
  assert.match(m, /E::STATE_ROSTER \| E::STATE_MUSTER_PENDING => \{\s*total \+= 1;\s*if Ro\(&pd\)\.u8\(o \+ E::FACTION\)\? == faction \{\s*own \+= 1;/);
  assert.match(m, /if total >= P::ROSTER_CAP \|\| own >= P::FACTION_CAP \{\s*return Err\(FrontierError::ProvinceFull\.into\(\)\);/);
  assert.match(m, /free\.ok_or\(FrontierError::ProvinceFull\)\?/);
  assert.match(m, /r\.u8\(H::FACTION\)\?,/, 'the faction is the holding\'s');
  const rules = read('permutation-rules/src/frontier/host.rs');
  assert.match(rules, new RegExp(`pub const PROVINCE_HOST_CAP: usize = ${PROVINCE_HOST_CAP};`));
  assert.match(rules, new RegExp(`pub const FACTION_RESIDENT_CAP: usize = ${FACTION_RESIDENT_CAP};`));
  assert.match(read('permutation-rules/src/frontier/clash.rs'), new RegExp(`pub const STORAGE: u8 = ${PROVINCE_ENTRIES};`));
  const layout = read('frontier-abi/src/layout/province.rs');
  assert.match(layout, /pub const ROSTER_CAP: usize = permutation_rules::frontier::host::PROVINCE_HOST_CAP;/);
  assert.match(layout, /pub const FACTION_CAP: usize = permutation_rules::frontier::host::FACTION_RESIDENT_CAP;/);
  assert.match(layout, /pub const STATE_FREE: u8 = 0;\s*pub const STATE_ROSTER: u8 = 1;\s*pub const STATE_MUSTER_PENDING: u8 = 2;/);
});

const entry = (state, faction) => ({ state, faction });
// a full decode: 56 entries, the rest free
const full = list => [...list, ...Array.from({ length: PROVINCE_ENTRIES - list.length }, () => entry(0, 0))];
const n = (k, state, faction) => Array.from({ length: k }, () => entry(state, faction));

test('provinceFull: 8 of the nation, 48 in all, or no free entry — and only standing or forming hosts count', () => {
  assert.equal(provinceFull({ entries: full(n(7, 1, 2)) }, 2), false);
  assert.equal(provinceFull({ entries: full([...n(7, 1, 2), entry(2, 2)]) }, 2), true, 'a forming host counts');
  assert.equal(provinceFull({ entries: full([...n(7, 1, 2), entry(3, 2)]) }, 2), false, 'a departed one does not');
  assert.equal(provinceFull({ entries: full(n(8, 1, 3)) }, 2), false, 'another nation\'s eight');
  assert.equal(provinceFull({ entries: full([...n(7, 1, 1), ...n(7, 1, 3), ...n(7, 1, 4), ...n(7, 1, 5), ...n(7, 1, 0), ...n(7, 2, 6), ...n(5, 1, 7)]) }, 2), false, '47 in all');
  assert.equal(provinceFull({ entries: full([...n(7, 1, 1), ...n(7, 1, 3), ...n(7, 1, 4), ...n(7, 1, 5), ...n(7, 1, 0), ...n(7, 2, 6), ...n(6, 1, 7)]) }, 2), true, '48 in all');
  assert.equal(provinceFull({ entries: n(PROVINCE_ENTRIES, 3, 1) }, 2), true, 'no free entry');
  assert.equal(provinceFull({ entries: n(3, 3, 1) }, 2), false, 'a partial decode: the free-entry check is the program\'s');
  assert.equal(provinceFull({}, 2), false);
  assert.equal(provinceFull(null, 2), false);
});

const village = { p: 2, q: 0, site: 1, tile: 30, gen: 7, state: 2, faction: 2, explore: null, finalTs: '0' };
const prov = (entries, extra = {}) => ({ p: 2, q: 0, resolvedNext: 99, siteMirror: [{ state: 0, gen: 0 }, { state: 1, gen: 7 }], entries, ticketCohorts: [], ...extra });
const ctx = province => ({ holding: village, province, now: 1, nowBell: 100 });

test('the Muster is held back on the village\'s own full Province, after NotFinal/NotResident; other actions are not', () => {
  assert.deepEqual(actionBlocks('Muster', ctx(prov(full(n(7, 1, 2))))), []);
  assert.deepEqual(actionBlocks('Muster', ctx(prov(full(n(8, 1, 2))))), ['ProvinceFull']);
  assert.deepEqual(actionBlocks('Muster', ctx(prov(full(n(8, 1, 2)), { resolvedNext: 50 }))), ['NotResident', 'ProvinceFull']);
  for (const a of ['Harvest', 'Build', 'Train', 'Garrison']) assert.ok(!actionBlocks(a, ctx(prov(full(n(8, 1, 2))))).includes('ProvinceFull'), a);
  assert.deepEqual(actionBlocks('Muster', ctx(prov(full(n(8, 1, 2)), { p: 3 }))), [], 'another Province is not the one Muster writes');
});

test('the sentence, in both languages', () => {
  assert.equal(errorText('ProvinceFull'), 'この州の枠がいっぱいです');
  setLang('en');
  try { assert.equal(errorText('ProvinceFull'), 'This province is full.'); } finally { setLang('ja'); }
});
