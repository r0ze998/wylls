// The isolated local NFT world lane (`localnet-nft-sbf`) as the sources declare it,
// checked without a build: the Cargo feature, the program-id guard, the compile-time
// exclusions, and build-frontier.sh's marker rules. The Rust host test
// `markers::tests::the_local_nft_lane_is_isolated` checks the same at compile time;
// this file runs today, with no cargo, no chain, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const cargo = read('permutation-frontier/Cargo.toml');
const lib = read('permutation-frontier/src/lib.rs');
const markers = read('permutation-frontier/src/markers.rs');
const build = read('scripts/build-frontier.sh');
const wrapper = read('scripts/build-frontier-localnet-nft-sbf.sh');
const feature = name => {
  const l = cargo.split('\n').find(x => x.startsWith(`${name} = `));
  assert.ok(l, `feature ${name}`);
  return l;
};

test('the lane is S1 + nft-experimental + test-beacon, and no playable lane carries NFT residents', () => {
  assert.equal(feature('localnet-nft-sbf'), 'localnet-nft-sbf = ["nft-experimental", "test-beacon"]');
  assert.equal(feature('nft-experimental'), 'nft-experimental = ["program"]', 'nft-experimental itself is unchanged');
  for (const other of ['localnet-expedition-sbf', 'localnet-conquest-sbf', 'expedition-dispatch-experimental', 'conquest-dispatch-experimental']) {
    assert.doesNotMatch(feature(other), /nft/, `${other} never carries NFT residents`);
  }
  // The exclusion between the playable expedition lane and NFT residents stays for every build but the local test
  // candidate `localnet-conquest-nft-sbf` (its own candidate id and version: local-conquest-nft-candidate.test.mjs).
  assert.match(lib, /feature = "expedition-dispatch-experimental", any\(\n\s*all\(feature = "nft-experimental", not\(feature = "localnet-conquest-nft-sbf"\)\)/);
});

test('the version is the existing nft-experimental one: no new bit, no change for other lanes', () => {
  assert.match(lib, /\| if cfg!\(feature = "nft-experimental"\) \{\n\s*0x8000/);
  assert.match(lib, /#\[cfg\(all\(feature = "expedition-dispatch-experimental", not\(feature = "localnet-conquest-nft-sbf"\)\)\)\]\npub const PROGRAM_VERSION: u16 = frontier_abi::world_index::expedition_dispatch_ix::PROGRAM_VERSION;/);
  assert.match(lib, /PROGRAM_VERSION_S1 \| 0x8000,\n\s*"the existing nft-experimental version; no new bit"/, 'the lane test pins it');
});

test('one dedicated program id, refused otherwise before any routing', () => {
  assert.match(lib, /pub const LOCALNET_NFT_PROGRAM_ID: \[u8; 32\] = \[0x4E; 32\];/);
  assert.match(lib, /pub const LOCALNET_EXPEDITION_PROGRAM_ID: \[u8; 32\] = \[0x45; 32\];/);
  // The guard sits at the top of dispatch, before the resident tags route.
  const d = lib.slice(lib.indexOf('pub fn dispatch('));
  const guard = d.indexOf('if !localnet_nft_identity_ok(program_id)');
  const resident = d.indexOf('is_resident_tag');
  assert.ok(guard > 0 && resident > guard, 'the id check runs before the NFT tags');
  assert.match(lib, /#\[cfg\(feature = "localnet-nft-sbf"\)\]\n\s*if !localnet_nft_identity_ok\(program_id\) \{\n\s*return Err\(FrontierError::BadAddress\.into\(\)\);/);
});

test('compile-time exclusions: the lane alone, and NFT on SBF only through the lane', () => {
  const block = lib.slice(lib.indexOf('feature = "localnet-nft-sbf",\n    any('), lib.indexOf('compile_error!("localnet-nft-sbf is the isolated'));
  for (const f of ['localnet-expedition-sbf', 'expedition-dispatch-experimental', 'wide-world-experimental', 'rights-experimental', 'capacity-preview', 'custody-preview', 'oracle', 'trace']) {
    assert.ok(block.includes(`feature = "${f}"`), `excludes ${f}`);
  }
  assert.match(lib, /#\[cfg\(all\(\n\s*target_os = "solana",\n\s*feature = "nft-experimental",\n\s*not\(any\(feature = "localnet-nft-sbf", feature = "localnet-conquest-nft-sbf"\)\)\n\)\)\]\ncompile_error!\("nft-experimental on SBF requires localnet-nft-sbf"\);/);
});

test('build-frontier.sh: the lane only through its wrapper; its marker required there and refused everywhere else', () => {
  assert.match(build, /localnet-nft-sbf\) \[ "\$\{PSF_LOCALNET_NFT_SBF_LANE:-\}" = 1 \] \|\|/);
  assert.match(build, /for m in [^;]*PSF_LOCALNET_NFT_SBF_BUILD[^;]*; do/);
  const wants = /case "\$feature:\$m" in\n\s*([^)]*)\) want_m=1/.exec(build)[1].split('|');
  assert.ok(wants.includes('localnet-nft-sbf:PSF_LOCALNET_NFT_SBF_BUILD'));
  assert.ok(wants.includes('localnet-nft-sbf:PSF_TEST_BEACON_BUILD'));
  assert.deepEqual(wants.filter(w => w.endsWith(':PSF_LOCALNET_NFT_SBF_BUILD')), ['localnet-nft-sbf:PSF_LOCALNET_NFT_SBF_BUILD'], 'no other build may carry it');
  assert.deepEqual(wants.filter(w => w.startsWith('localnet-nft-sbf:')).sort(), ['localnet-nft-sbf:PSF_LOCALNET_NFT_SBF_BUILD', 'localnet-nft-sbf:PSF_TEST_BEACON_BUILD'], 'and it carries no other lane marker');
  assert.match(markers, /pub const LOCALNET_NFT_SBF: &\[u8\] = b"PSF_LOCALNET_NFT_SBF_BUILD";/);
  assert.match(markers, /pub fn touch_localnet_nft_sbf\(\)/);
  assert.match(lib, /markers::touch_localnet_nft_sbf\(\);/);
  // The wrapper sets the lane, its own target and output, offline.
  assert.match(wrapper, /export PSF_LOCALNET_NFT_SBF_LANE=1/);
  assert.match(wrapper, /export CARGO_NET_OFFLINE=true/);
  assert.match(wrapper, /target\/localnet-nft-sbf/);
  assert.ok(statSync(new URL('scripts/build-frontier-localnet-nft-sbf.sh', root)).mode & 0o100, 'executable');
});
