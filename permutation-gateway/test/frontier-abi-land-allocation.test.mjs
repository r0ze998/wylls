// The land preview's ABI numbers (ABI-ALLOCATION rev 7, provisional) stay what the code uses, and stay clear of every
// other band: read as text from frontier-abi's sources and the allocation ledger. Nothing is built, signed or sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const hex = (src, name) => {
  const m = new RegExp(`pub const ${name}: u(?:8|16) = (0x[0-9A-Fa-f]+);`).exec(src);
  assert.ok(m, name);
  return parseInt(m[1], 16);
};
const LAND = read('frontier-abi/src/land_preview.rs');
const LEDGER = read('workstreams/04-execution/contracts/ABI-ALLOCATION-20261106.ja.md');
const REV7 = LEDGER.slice(LEDGER.indexOf('## rev 7'));

test('the ledger\'s rev 7 names exactly the land tags the code uses, and keeps 0xCF unused', () => {
  const fold = hex(LAND, 'TAG_FOLD_LAND'), claim = hex(LAND, 'TAG_CLAIM_LAND_YIELD');
  assert.deepEqual([fold, claim], [0xcd, 0xce]);
  assert.ok(REV7.length > 0 && REV7.includes('**仮**'), 'rev 7 exists and is provisional');
  assert.match(REV7, /命令 tag 0xCD \| FoldLand（`frontier_abi::land_preview::TAG_FOLD_LAND`）/);
  assert.match(REV7, /命令 tag 0xCE \| ClaimLandYield（`TAG_CLAIM_LAND_YIELD`）/);
  assert.match(REV7, /命令 tag 0xCF \| 土地の試験の予備（使わない）/);
  assert.match(LAND, /pub const fn is_land_tag\(t: u8\) -> bool \{\s*t == TAG_FOLD_LAND \|\| t == TAG_CLAIM_LAND_YIELD\s*\}/);
  assert.match(REV7, /seed tag `ld`、magic `PSFLAND1`/);
  assert.match(LAND, /pub const SEED_TAG: \[u8; 2\] = \*b"ld";/);
});

test('the land tags sit outside every other routed band in the sources', () => {
  const bands = [
    ['rights', hex(read('frontier-abi/src/v2/rights.rs'), 'ISSUE_GRANT'), hex(read('frontier-abi/src/v2/rights.rs'), 'CLOSE_GRANT')],
    ['capacity', hex(read('frontier-abi/src/capacity.rs'), 'TAG_FIRST'), hex(read('frontier-abi/src/capacity.rs'), 'TAG_LAST')],
    ['wide drafts', hex(read('frontier-abi/src/world_index/wide_ix.rs'), 'DRAFT_TAG_FIRST'), hex(read('frontier-abi/src/world_index/wide_ix.rs'), 'DRAFT_TAG_LAST')],
    ['wide reveal', hex(read('frontier-abi/src/world_index/wide_ix.rs'), 'TAG_REVEAL'), hex(read('frontier-abi/src/world_index/wide_ix.rs'), 'TAG_REVEAL')],
    ['v2 custody (ledger §2.1)', 0xc2, 0xcc],
    ['resident (ledger §2.1)', 0xe0, 0xe7],
    ['extensions (ledger §2.1)', 0xe8, 0xed],
  ];
  for (const t of [0xcd, 0xce, 0xcf]) for (const [name, lo, hi] of bands) assert.ok(t < lo || t > hi, `${t.toString(16)} in ${name}`);
});

test('the version bit rev 7 reserves for the land preview (0x0400) is used by no build yet', () => {
  const bits = [
    hex(read('frontier-abi/src/world_index/expedition_dispatch_ix.rs'), 'VERSION_BIT'),
    hex(read('frontier-abi/src/capacity.rs'), 'CAPACITY_PREVIEW_VERSION_BIT'),
    hex(read('frontier-abi/src/v2/rights.rs'), 'RIGHTS_EXPERIMENTAL_VERSION_BIT'),
    hex(read('frontier-abi/src/world_index/wide_ix.rs'), 'WIDE_EXPERIMENTAL_VERSION_BIT'),
    0x8000, // workstream 20's bit (permutation-frontier lib.rs; ledger rev 5)
  ];
  assert.deepEqual(bits, [0x0800, 0x1000, 0x2000, 0x4000, 0x8000]);
  assert.ok(bits.every(b => (b & 0x0400) === 0));
  assert.match(REV7, /ビット \*\*0x0400\*\* を予約/);
  assert.doesNotMatch(read('permutation-frontier/src/lib.rs'), /0x0400/, 'not applied: the land build keeps its version');
});

test('the exact version gates the land bit would touch are where CLAUDE-LAND-VERSION-BIT-COMPAT says', () => {
  const doc = read('docs/integration/CLAUDE-LAND-VERSION-BIT-COMPAT-20261116.md');
  const gates = [
    ['permutation-server/web/frontier/flocalplay.mjs', /export const LOCAL_PLAY_PROGRAM_VERSION = 0x4804;/],
    ['permutation-server/web/frontier/flocalplay-conquest.mjs', /program_version === String\(LOCAL_PLAY_PROGRAM_VERSION\)/],
    ['permutation-server/web/frontier/fexpedition-prepare.mjs', /program_version === '18436'/],
    ['permutation-server/web/frontier/fexpedition-depart-prepare.mjs', /DEPART_PREPARE_PROGRAM_VERSION = '18436'/],
    ['permutation-server/web/frontier/hud/hand.mjs', /program_version === '18436'/],
    ['permutation-gateway/src/frontier/expedition-prepare.mjs', /const VERSION = '18436';/],
    ['permutation-gateway/src/frontier/conquest-prepare.mjs', /const VERSION = '18436';/],
    ['permutation-gateway/src/frontier/expedition-depart-prepare.mjs', /DEPART_PREPARE_PROGRAM_VERSION = '18436'/],
    ['frontier-node/crates/herald/src/local_play.rs', /pub const PROGRAM_VERSION: u16 = 0x4804;/],
    ['frontier-node/crates/itest/src/expedition_play.rs', /pub const PROGRAM_VERSION: u16 = 0x4804;/],
  ];
  for (const [file, re] of gates) {
    assert.match(read(file), re, file);
    assert.ok(doc.includes(file.replace(/^permutation-server\/web\/frontier\//, '').split('/').pop()), `the doc names ${file}`);
  }
  assert.equal(0x4804 | 0x0400, 0x4c04);
});
