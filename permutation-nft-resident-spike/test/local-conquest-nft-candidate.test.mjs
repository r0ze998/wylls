// The LOCAL TEST CANDIDATE lane `localnet-conquest-nft-sbf` (the conquest lane plus NFT residents) as the sources
// declare it, checked without a build: it is a candidate (not an allocation, never deployable), it has its own
// candidate program id, version and marker, it is reachable only through its own wrapper, and every guard it touches
// is narrowed for that one feature only (a build without it sees exactly the old conditions). No cargo, no chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const cargo = read('permutation-frontier/Cargo.toml');
const lib = read('permutation-frontier/src/lib.rs');
const markers = read('permutation-frontier/src/markers.rs');
const dispatch = read('permutation-frontier/src/proc/wide_expedition_dispatch.rs');
const build = read('scripts/build-frontier.sh');
const wrapper = read('scripts/build-frontier-localnet-conquest-nft-sbf.sh');
const NEW = 'localnet-conquest-nft-sbf';

test('a candidate feature: the conquest lane plus nft-experimental, labelled local test only, not built', () => {
  assert.match(cargo, /\nlocalnet-conquest-nft-sbf = \["localnet-conquest-sbf", "nft-experimental"\]\n/);
  assert.match(cargo, /LOCAL TEST CANDIDATE, not an allocation and never deployable/);
  assert.match(cargo, /Not built yet/);
  assert.doesNotMatch(cargo, /\nlocalnet-conquest-sbf = [^\n]*nft/, 'the conquest lane itself is unchanged');
  assert.doesNotMatch(cargo, /\nlocalnet-nft-sbf = [^\n]*conquest/, 'the local NFT lane itself is unchanged');
});

test('its own candidate id and version, distinct from every other lane; the version is the conquest lane\'s with the existing NFT bit', () => {
  assert.match(lib, /pub const LOCALNET_CONQUEST_NFT_PROGRAM_ID: \[u8; 32\] = \[0x4C; 32\];/);
  for (const other of ['0x45', '0x4E']) assert.doesNotMatch(lib, new RegExp(`LOCALNET_CONQUEST_NFT_PROGRAM_ID: \\[u8; 32\\] = \\[${other}; 32\\]`));
  assert.match(lib, /pub const LOCALNET_CONQUEST_NFT_VERSION: u16 =\n\s*frontier_abi::world_index::expedition_dispatch_ix::PROGRAM_VERSION \| 0x8000;/);
  assert.equal(0x4804 | 0x8000, 0xc804);
  assert.match(lib, /#\[cfg\(feature = "localnet-conquest-nft-sbf"\)\]\npub const PROGRAM_VERSION: u16 = LOCALNET_CONQUEST_NFT_VERSION;/);
  assert.match(lib, /LOCAL TEST CANDIDATE \(`localnet-conquest-nft-sbf`\), not an allocation/);
  // the identity check picks the candidate id only under the feature
  assert.match(lib, /#\[cfg\(not\(feature = "localnet-conquest-nft-sbf"\)\)\]\n\s*let want = LOCALNET_EXPEDITION_PROGRAM_ID;\n\s*#\[cfg\(feature = "localnet-conquest-nft-sbf"\)\]\n\s*let want = LOCALNET_CONQUEST_NFT_PROGRAM_ID;/);
  // the expedition route accepts the candidate version only under the feature
  assert.match(dispatch, /#\[cfg\(not\(feature = "localnet-conquest-nft-sbf"\)\)\]\n\s*let want = PROGRAM_VERSION;\n\s*#\[cfg\(feature = "localnet-conquest-nft-sbf"\)\]\n\s*let want = crate::LOCALNET_CONQUEST_NFT_VERSION;/);
});

test('guards: narrowed for the candidate only; the candidate itself excluded from the other lanes and previews', () => {
  // every edited condition adds the new feature only as `not(…)` / inside `any(…)` with the old one
  assert.match(lib, /all\(feature = "nft-experimental", not\(feature = "localnet-conquest-nft-sbf"\)\), feature = "rights-experimental"/);
  assert.match(lib, /not\(any\(feature = "localnet-nft-sbf", feature = "localnet-conquest-nft-sbf"\)\)/);
  const block = lib.slice(lib.indexOf(`feature = "${NEW}",\n    any(`), lib.indexOf(`compile_error!("${NEW} is a local test candidate`));
  for (const f of ['localnet-nft-sbf', 'rights-experimental', 'capacity-preview', 'custody-preview', 'oracle', 'trace']) assert.ok(block.includes(`feature = "${f}"`), `excludes ${f}`);
  // the conquest lane's own guards (no test beacon, no host proof…) still apply: it includes localnet-expedition-sbf
  assert.match(lib, /compile_error!\("localnet-expedition-sbf cannot combine with host proof, crypto, oracle, beacon or trace features"\);/);
  // the other existing exclusions are untouched
  assert.match(lib, /compile_error!\("localnet-nft-sbf is the isolated local NFT lane only"\);/);
  assert.match(lib, /compile_error!\("capacity-preview and nft-experimental together: the program version is undecided \(workstream 4\)"\);/);
});

test('build: only through its wrapper; the three conquest-lane markers required, every other marker refused', () => {
  assert.match(build, /localnet-conquest-nft-sbf\) \[ "\$\{PSF_LOCALNET_CONQUEST_NFT_SBF_LANE:-\}" = 1 \] \|\|/);
  const wants = /case "\$feature:\$m" in\n\s*([^)]*)\) want_m=1/.exec(build)[1].split('|');
  assert.deepEqual(wants.filter(w => w.startsWith(`${NEW}:`)).sort(), [`${NEW}:PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD`, `${NEW}:PSF_LOCALNET_CONQUEST_SBF_BUILD`, `${NEW}:PSF_LOCALNET_EXPEDITION_SBF_BUILD`]);
  assert.deepEqual(wants.filter(w => w.endsWith(':PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD')), [`${NEW}:PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD`], 'no other build may carry its marker');
  assert.match(build, /for m in [^;]*PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD[^;]*; do/);
  assert.match(markers, /pub const LOCALNET_CONQUEST_NFT_SBF: &\[u8\] = b"PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD";/);
  assert.match(markers, /#\[cfg\(feature = "localnet-conquest-nft-sbf"\)\]\n\s*core::hint::black_box\(LOCALNET_CONQUEST_NFT_SBF\.as_ptr\(\)\);/);
  assert.match(wrapper, /export PSF_LOCALNET_CONQUEST_NFT_SBF_LANE=1/);
  assert.match(wrapper, /export CARGO_NET_OFFLINE=true/);
  assert.match(wrapper, /target\/localnet-conquest-nft-sbf/);
  assert.match(wrapper, /NOT BUILT YET/);
  assert.ok(statSync(new URL('scripts/build-frontier-localnet-conquest-nft-sbf.sh', root)).mode & 0o100, 'executable');
});
