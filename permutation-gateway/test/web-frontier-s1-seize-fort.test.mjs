// Seizing another's fort (screens/s1.mjs seizeOffer) is blocked while it is manned as the program counts it
// (structure.rs seize_structure_as → fort_troops: troops + pending troops > 0, FortManned). The page counted troops only,
// so a fort whose garrison was still coming in was offered and refused on send (2026-11-16). No rule changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { errorText } from '../../permutation-server/web/frontier/fi18n.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('the program counts pending troops as manning a fort (pinned as text)', () => {
  const s = read('permutation-frontier/src/proc/structure.rs');
  assert.match(s, /fn fort_troops\(pd: &\[u8\], i: usize\) -> R<u64> \{\n    let r = Ro\(pd\);\n    let o = FR::at\(i\);\n    Ok\(r\.u32\(o \+ FR::TROOPS\)\? as u64 \+ r\.u16\(o \+ FR::PEND\)\? as u64 \* 1_000\)/);
  const at = s.indexOf('fn seize_structure_as(');
  assert.match(s.slice(at, at + 1500), /if fort_troops\(&pd, i\)\? > 0 \{\n\s+return Err\(cq\(CqError::FortManned\)\);/);
});

// the viewer's host stands on tile 40 of province (0,0); another citizen's structure stands there
const viewerHolding = { p: 0, q: 0, site: 0, tile: 30, gen: 1 };
const FS0 = holdings => ({ holdings, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0 } });
const fortProv = (troops, pend) => ({ p: 0, q: 0, resolvedNext: 99, forts: [{ tile: 40, state: 1, troops: BigInt(troops), pend }], entries: [] });
const target = kind => ({ kind, ownerCitizen: 'Owner1111111111111111111111111111111111111', mine: false });

test('a fort with pending troops is manned; an empty one is not; other kinds are unaffected', () => {
  const fs = FS0([viewerHolding]);
  const manned = (troops, pend, kind = 3) => SCR.seizeOffer(fs, fortProv(troops, pend), 40, target(kind), 'structure').blocks.includes('FortManned');
  assert.equal(manned(1000, 0), true, 'troops in it');
  assert.equal(manned(0, 50), true, 'troops on the way in (pending): manned, as fort_troops counts');
  assert.equal(manned(0, 0), false, 'empty: may be seized');
  assert.equal(manned(0, 50, 1), false, 'a watchtower has no garrison');
  // a vault is never FortManned
  assert.ok(!SCR.seizeOffer(fs, fortProv(0, 50), 40, target(1), 'vault').blocks.includes('FortManned'));
  assert.ok(errorText('FortManned').length > 0 && !/Unknown|不明/.test(errorText('FortManned')));
});
