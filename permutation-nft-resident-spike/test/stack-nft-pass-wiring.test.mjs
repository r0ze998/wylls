// frontier-stack `up --nft-pass` (frontier-node/crates/stack/src/nftpass.rs and its use in up.rs,
// config.rs, resume.rs) checked against what it depends on, WITHOUT compiling it: the constants
// against their sources, the command lines against the Node scripts and the relay that take them,
// the localnet's `--program` format against its parser, the mint port against the stack's offsets.
// The Rust itself (and its unit tests) is not compiled here: it waits for a host build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TEST_PROGRAM_ID } from '../src/localnet.mjs';
import { base58 } from '../src/crypto.mjs';
import { MPL_CORE_PROGRAM } from '../src/core-asset.mjs';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const stack = p => read(`frontier-node/crates/stack/src/${p}`);
const nft = stack('nftpass.rs');
const rustStr = name => {
  const m = new RegExp(`pub const ${name}: &str =\\s*"([^"]+)";`).exec(nft);
  assert.ok(m, name);
  return m[1];
};

test('constants: the lane id, Core, the resident test id and the binaries\' paths are the sources\'', () => {
  assert.match(nft, /pub const LOCALNET_NFT_PROGRAM_ID: \[u8; 32\] = \[0x4E; 32\];/);
  assert.match(read('permutation-frontier/src/lib.rs'), /pub const LOCALNET_NFT_PROGRAM_ID: \[u8; 32\] = \[0x4E; 32\];/);
  assert.match(nft, /pub const LANE_MARKER: &\[u8\] = b"PSF_LOCALNET_NFT_SBF_BUILD";/);
  assert.equal(rustStr('CORE_PROGRAM'), MPL_CORE_PROGRAM);
  assert.match(read('permutation-nft-resident-spike/docs/ENV-RECORD.ja.md'), new RegExp(rustStr('CORE_SO_SHA256')));
  const label = /pub const RESIDENT_ID_LABEL: &\[u8\] = b"([^"]+)";/.exec(nft)[1];
  assert.equal(base58(createHash('sha256').update(label).digest()), TEST_PROGRAM_ID);
  assert.match(nft, new RegExp(`"${TEST_PROGRAM_ID}"`), 'the unit test pins the same id');
  for (const k of ['SETUP_SCRIPT', 'MINT_SCRIPT', 'RESIDENT_RECORD']) assert.ok(existsSync(new URL(rustStr(k), root)), `${k} exists in the repository`);
  assert.equal(rustStr('CORE_SO'), 'permutation-nft-resident-spike/.local/programs/mpl_core.so');
  assert.equal(rustStr('RESIDENT_SO'), 'permutation-nft-resident-spike/program/target/deploy/wylls_resident_program.so');
  const local = new URL(rustStr('CORE_SO'), root);
  if (existsSync(local)) assert.equal(createHash('sha256').update(readFileSync(local)).digest('hex'), rustStr('CORE_SO_SHA256'), 'the local Core ELF is the verified one');
});

test('the setup and mint command lines use flags their scripts take', () => {
  const setup = read('permutation-nft-resident-spike/src/nft-world-setup.mjs');
  for (const f of ['--rpc', '--frontier', '--resident', '--authority-seed-file', '--test-sale']) {
    assert.ok(nft.includes(`"${f}".into()`), `nftpass.rs passes ${f}`);
    assert.ok(setup.includes(`'${f}'`), `nft-world-setup.mjs reads ${f}`);
  }
  assert.match(nft, /rd\.path\("keys\/operator\.seed"\)/, 'the operator seed the stack writes (up.rs Keys: keys/operator.seed)');
  assert.match(stack('up.rs'), /authority: kp\("keys\/operator\.seed"\)\?/);
  const demo = read('permutation-nft-resident-spike/src/mint-demo.mjs');
  for (const f of ['--rpc', '--program', '--port']) {
    assert.ok(nft.includes(`"${f}".into()`), `mint spec passes ${f}`);
    assert.ok(demo.includes(`'${f}'`), `mint-demo.mjs reads ${f}`);
  }
  assert.match(nft, /vec!\["--mint-url"\.into\(\), self\.mint_url\(\)\]/);
  assert.match(read('permutation-gateway/src/frontier/config.mjs'), /mintUrl: pick\('mint-url', 'FRONTIER_MINT_URL', d\.mintUrl\)/);
  assert.match(nft, /format!\("http:\/\/127\.0\.0\.1:\{\}\/web\/mint\.html", self\.mint_port\)/, 'a loopback http link (the relay accepts only that, on localnet)');
});

test('the localnet deploys: frontier-localnet --program ID=PATH[:MAXLEN][@AUTHORITY]', () => {
  const main = stack('../../localnet/src/main.rs');
  assert.match(main, /\[--program <id>=<path\.so>\[:<max_len>\]\[@<authority>\]\]/);
  assert.match(nft, /format!\("\{CORE_PROGRAM\}=\{\}", self\.core_so\.display\(\)\)/, 'Core: no upgrade authority');
  assert.match(nft, /"\{\}=\{\}:\{\}@\{authority\}",\n\s*self\.resident,/, 'the resident program: upgradeable by the operator key');
});

test('the mint page port is free among the stack\'s offsets and inside 41000–41999 for the default bases', () => {
  const cfg = stack('config.rs');
  const block = /impl Default for Offsets \{[\s\S]*?Offsets \{([\s\S]*?)\}/.exec(cfg)[1];
  const offsets = [...block.matchAll(/(\w+): (\d+),/g)].map(m => Number(m[2]));
  const localnet = Number(/localnet: (\d+),/.exec(block)[1]);
  const extra = Number(/pub const MINT_PORT_FROM_LOCALNET: u16 = (\d+);/.exec(nft)[1]);
  assert.ok(!offsets.includes(localnet + extra), `offset ${localnet + extra} is no other component's`);
  assert.match(nft, /crate::ports::check\(mint_port\)\?;/, 'and the stack\'s port rule is applied');
});

test('up.rs, config.rs, resume.rs, main.rs: the switch, its rules, the id, the checks, the steps', () => {
  const up = stack('up.rs'), cfg = stack('config.rs');
  assert.match(cfg, /"nft-pass" => c\.nft_pass = true,/);
  assert.match(cfg, /pub const SWITCHES: &\[&str\] = &\[[\s\S]*"nft-pass",[\s\S]*\];/);
  assert.match(cfg, /if let Some\(v\) = b!\("nft_pass"\) \{/);
  assert.match(cfg, /--nft-pass: not with --prize-so/);
  assert.match(cfg, /--nft-pass: the NFT lane runs with --beacon test-key/);
  assert.match(cfg, /v\["nft_pass"\] = json!\(self\.nft_pass\);/);
  assert.match(up, /crate::nftpass::check_lane_so\(&bytes\)\.map_err\(bad\)\?;/);
  assert.match(up, /let program = if cfg\.nft_pass \{\n\s*crate::nftpass::frontier_program\(\)\n\s*\} else \{\n\s*program_id\(&cfg\.run_id\)/);
  assert.match(up, /spec\.args\s*\.extend\(nft\.deploy_args\(&self\.keys\.authority\.pubkey\(\)\)\);/);
  assert.match(up, /spec\.args\.extend\(nft\.relay_args\(\)\);/);
  assert.match(up, /out\.push\(nft\.mint_spec\(&self\.repo, &node, r, &p\.rpc\(\)\)\);/);
  // The pass setup runs after the Season exists and before the keepers and the relay start.
  const seq = up.slice(up.indexOf('async fn run_all('));
  const season = seq.indexOf('let season = setup::run(');
  const nftSetup = seq.indexOf('nft.setup_command(');
  const relayStart = seq.indexOf('// 4. Payers, keepers, relay.');
  assert.ok(season > 0 && nftSetup > season && (relayStart < 0 || nftSetup < relayStart), 'order');
  assert.match(stack('resume.rs'), /resume of --nft-pass worlds is not implemented/);
  assert.match(stack('main.rs'), /\[--nft-pass\]/);
  assert.match(stack('lib.rs'), /pub mod nftpass;/);
});

test('CreateSeason for the lane: the stack writes S1 | 0x8000 and range-checks exactly that version as S1, as the program does', () => {
  const nftRs = stack('nftpass.rs'), setup = stack('setup.rs'), up = stack('up.rs'), cfg = stack('config.rs');
  const season = read('permutation-frontier/src/proc/season.rs');
  assert.match(nftRs, /pub const LANE_PROGRAM_VERSION: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_S1 \| 0x8000;/);
  assert.match(setup, /if let Some\(v\) = self\.program_version \{\n\s*p\.base\.program_version = v;/);
  assert.match(setup, /if y\.base\.program_version == crate::nftpass::LANE_PROGRAM_VERSION \{\n\s*y\.base\.program_version = frontier_abi::v2::presets::PROGRAM_VERSION_S1;/);
  assert.match(setup, /range_view\(&p\)\n\s*\.validate\(\)/);
  assert.match(up, /program_version: st\n\s*\.cfg\n\s*\.nft_pass\n\s*\.then_some\(crate::nftpass::LANE_PROGRAM_VERSION\),/);
  assert.match(cfg, /--nft-pass: an S1 world \(--conquest\)/);
  // The program: the same view for exactly the lane's version, in the lane only; the generic validate unchanged.
  assert.match(season, /#\[cfg\(any\(feature = "localnet-expedition-sbf", feature = "localnet-nft-sbf"\)\)\]\nfn range_view\(/);
  assert.match(season, /#\[cfg\(not\(any\(feature = "localnet-expedition-sbf", feature = "localnet-nft-sbf"\)\)\)\]\nfn range_view\(/);
  assert.match(season, /fn the_nft_lane_accepts_exactly_its_own_version\(\)/);
  assert.match(read('frontier-abi/src/v2/presets.rs'), /if self\.base\.program_version != PROGRAM_VERSION_V2\n\s*&& self\.base\.program_version != PROGRAM_VERSION_S1\n\s*&& self\.base\.program_version != PROGRAM_VERSION_CUSTODY/, 'validate is not relaxed');
});

test('processes: the mint page starts after the herald and before the bots, stops first on every path, and the setup has a deadline', () => {
  const up = stack('up.rs'), nftRs = stack('nftpass.rs');
  const seq = up.slice(up.indexOf('async fn run_all('));
  const herald = seq.indexOf('st.start(specs["herald"].clone())?;');
  const mint = seq.indexOf('if let (Some(spec), Some(port)) = (specs.get("mint").cloned(), mint_port) {');
  const bots = seq.indexOf('// 6. Bots.');
  assert.ok(herald > 0 && mint > herald && bots > mint, 'herald → mint page → bots');
  assert.match(seq, /st\.start\(spec\)\?;\n\s*chain::wait_tcp\(port, Duration::from_secs\(30\)\)\.await\?;/, 'its port must answer, or the run fails (and stop_all runs)');
  // stop_all (failure, Ctrl-C, end) and `down` both stop it, before the herald.
  for (const list of [up.slice(up.indexOf('pub fn stop_all(&mut self)')), up.slice(up.indexOf('pub fn down(rd: &RunDir)'))]) {
    const block = list.slice(0, list.indexOf('"localnet",'));
    assert.match(block, /"bots",\n\s*"mint",\n\s*"herald",/);
  }
  assert.match(up, /Err\(e\) => \{\n\s*log_line\(&format!\("run failed: \{e\}"\)\);[\s\S]{0,200}st\.stop_all\(\);/, 'a failed run stops every component');
  assert.match(up, /crate::nftpass::run_with_deadline\(&prog, &args, Duration::from_secs\(180\)\)\?/);
  assert.match(nftRs, /None if t0\.elapsed\(\) >= limit => \{\n\s*let _ = child\.kill\(\);/);
});
