//! Localnet connection harness for the host-only expedition dispatch build: a REAL SBF artifact loaded into the
//! in-process LiteSVM chain (`localnet::Chain`), a REAL ed25519 signature from an in-memory test wallet, and the
//! original-host Depart sent through the version-2 dispatch wrapper only (`expedition_dispatch_ix`, Kind::Depart).
//! Raw Depart, conquest and wide→wide are not exercised.
//!
//! Nothing here is a stand-in for execution: there is no native program, no forced signer flag and no assumed
//! success. Without the artifact the Depart test FAILS and says what it needs; it is `#[ignore]`d so that the
//! always-runnable checks can be run on their own.
//!
//! Inputs of the artifact test (environment, read at run time):
//!   WYLLS_EXPEDITION_SBF          absolute path of the `.so` built with `localnet-expedition-sbf`
//!   WYLLS_EXPEDITION_SBF_SHA256   its SHA-256, 64 lowercase hex (the file must match)
//! The build marker is fixed (`MARKER`): the artifact must contain it, whatever the caller says.
//!
//! The wallet: `Keypair::new()` in memory, per test, funded by the disposable chain's airdrop. No key file, seed,
//! session or existing wallet is read; no secret is printed or stored. Only public keys and results are printed.
//!
//! LIMITS OF THE INITIAL STATE. The Season, Citizen, Holding and home Province are a FIXTURE written with
//! `Chain::set_account`; they were not created by the program's own instructions (CreateSeason, Join, the ticket
//! path, Muster). Their layout follows the keeper's depart-preparation fixture
//! (crates/keeper/tests/experimental_expedition_depart_prepare.rs), re-scoped to the program id under test, the
//! chain's clock, the real S1 ruleset hash and the test wallet. So a passing Depart shows that the real program
//! executes this instruction and writes these accounts from such a state; it does not show that the program's own
//! lifecycle produces that state, nor anything about rent, fees or economy before it.
//! The commit and seal are fixed public filler bytes with the seal's first-byte syntax, for this FIRST Depart only:
//! Depart checks syntax, and a march sealed with them could never be revealed or settled. Real play needs a real seal.
//!
//!   cargo +1.95.0 test --offline --locked -p itest --features localnet-expedition-harness --test localnet_expedition_depart
//!   … -- --ignored --nocapture      (with the two variables set: the artifact test)
use fclient::experimental_expedition_message::{prepare_depart, Target, DEPART_HEAP_FRAME};
use fclient::original_expedition_depart_draft::Draft;
use fclient::tx::{self, TxBudget};
use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
use fclient::{Address, Keypair, Signer};
use frontier_abi::addr::{host_id, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_i16, wr_u16, wr_u32, wr_u64};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::{
    header,
    player::{citizen as C1, holding_ref as HR},
    province::entry as E,
    world::season as S1,
};
use frontier_abi::v2::layout::{
    player::{citizen as C, holding as H},
    province::province as P,
    world::season as S,
};
use frontier_abi::v2::presets::RULESET_HASH_V3;
use frontier_abi::world_index::{expedition::AccountResolver, expedition_dispatch_ix as wire, WideHostRef};
use localnet::{Chain, Config};
use sha2::{Digest, Sha256};

/// The dedicated localnet program id of the `localnet-expedition-sbf` build.
const PROGRAM: [u8; 32] = [0x45; 32];
/// S1 (4) | wide 0x4000 | host-only dispatch 0x0800.
const PROGRAM_VERSION: u16 = 0x4804;
/// The marker the dedicated build embeds. Fixed: not an input.
const MARKER: &[u8] = b"PSF_LOCALNET_EXPEDITION_SBF_BUILD";
const SEASON_ID: u64 = 11;
/// Fixed public filler, not a commitment to or a seal of anything (see the module doc).
const COMMIT: [u8; 32] = [1; 32];
const SEAL: [u8; 264] = [0xa7; 264];
const BELL_SECS: u32 = 600;
/// The chain's clock stands this many seconds after the Season's genesis: bell 10.
const INTO_SEASON: i64 = 6_000;

const ENV_PATH: &str = "WYLLS_EXPEDITION_SBF";
const ENV_SHA: &str = "WYLLS_EXPEDITION_SBF_SHA256";

fn dedicated() -> Address {
    Address::new_from_array(PROGRAM)
}

// ------------------------------------------------------------------ the artifact

#[derive(Debug, PartialEq, Eq)]
struct Artifact {
    bytes: Vec<u8>,
    sha256: String,
}

/// The artifact's checks, on bytes: an ELF, the expected digest and the fixed build marker. Every failure names
/// what was expected; none is waived.
fn inspect(bytes: Vec<u8>, expected_sha: &str) -> Result<Artifact, String> {
    if bytes.len() < 64 || bytes[..4] != [0x7f, b'E', b'L', b'F'] {
        return Err("the artifact is not an ELF file".into());
    }
    if expected_sha.len() != 64 || !expected_sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(format!("{ENV_SHA} must be 64 lowercase hex characters"));
    }
    let sha256 = hex::encode(Sha256::digest(&bytes));
    if sha256 != expected_sha {
        return Err(format!("the artifact's SHA-256 is {sha256}, not the expected {expected_sha}"));
    }
    if !bytes.windows(MARKER.len()).any(|w| w == MARKER) {
        return Err("the build marker PSF_LOCALNET_EXPEDITION_SBF_BUILD is not in the artifact".into());
    }
    // (The dedicated id is NOT looked for as 32 contiguous bytes: the compiler need not store it so, and the real
    // artifact does not. That the build runs only as the dedicated program is measured at run time, by deploying
    // the same artifact at another id.)
    Ok(Artifact { bytes, sha256 })
}

/// The artifact named by the environment. A missing variable or file is an error that says so, never a skip.
fn artifact_from_env() -> Result<Artifact, String> {
    let need = |name: &str| std::env::var(name).map_err(|_| format!("{name} is not set (needed: {ENV_PATH} = absolute path of the .so, {ENV_SHA} = its SHA-256)"));
    let (path, sha) = (need(ENV_PATH)?, need(ENV_SHA)?);
    if !std::path::Path::new(&path).is_absolute() {
        return Err(format!("{ENV_PATH} must be an absolute path"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("{ENV_PATH}: cannot read the artifact: {e}"))?;
    inspect(bytes, &sha)
}

// ------------------------------------------------------------------ the fixture world

/// The original host (128, 0) site 1 gen 2 seq 0 of `wallet`, final and resident at home, in a running Season of
/// the dispatch revision (the real S1 ruleset hash) whose bell 10 is the chain's present, under `program`.
struct World {
    program: Address,
    ctx: AddrCtx,
    season: Address,
    host: WideHostRef,
    accounts: Vec<(Address, Vec<u8>)>,
}

fn header_bytes(size: usize, magic: [u8; 8]) -> Vec<u8> {
    let mut data = vec![0; size];
    assert!(wr_arr(&mut data, header::MAGIC, &magic));
    assert!(wr_u64(&mut data, header::SEASON_ID, SEASON_ID));
    assert!(wr_u16(&mut data, header::LAYOUT_VERSION, 2));
    data
}

impl World {
    fn new(program: Address, wallet: &Address, now: i64) -> World {
        let (season, bump) = fclient::addr::season_pda(&program, SEASON_ID);
        let ctx = AddrCtx { program: program.to_bytes(), season: season.to_bytes() };
        let resolver = AccountResolver::for_season(&ctx).expect("a resolver for the program's Season");
        let id = host_id(128, 0, 1, 2, 0).expect("an original host id");
        let host = resolver.legacy_host_ref(id).expect("the host's full reference");
        let citizen_key = Address::new_from_array(ctx.citizen(&wallet.to_bytes()));

        let mut s = header_bytes(S::SIZE, S::MAGIC);
        s[S::STATUS] = S::STATUS_RUNNING;
        s[S::BUMP] = bump;
        assert!(wr_u16(&mut s, S::PROGRAM_VERSION, PROGRAM_VERSION));
        assert!(wr_arr(&mut s, S::RULESET_HASH, &RULESET_HASH_V3));
        assert!(wr_arr(&mut s, S::GENESIS_TS, &(now - INTO_SEASON).to_le_bytes()));
        assert!(wr_u32(&mut s, S::BELL_SECS, BELL_SECS));
        assert!(wr_u32(&mut s, S::END_BELL, 1008));
        assert!(wr_u16(&mut s, S1::BUCKET_RATE_PER_H, 60));
        assert!(wr_u16(&mut s, S1::BUCKET_BURST, 10));

        let mut h = header_bytes(H::SIZE, H::MAGIC);
        assert!(wr_i16(&mut h, H::P, 128));
        h[H::SITE] = host.site();
        h[H::GEN] = host.gen();
        h[H::STATE] = H::STATE_FINAL;
        h[H::ORDER] = 1;
        assert!(wr_arr(&mut h, H::OWNER_CITIZEN, &citizen_key.to_bytes()));
        assert!(wr_u32(&mut h, H::HOST_SEQ, 1));

        let mut home = header_bytes(P::SIZE, P::MAGIC);
        assert!(wr_i16(&mut home, P::P, 128));
        assert!(wr_u32(&mut home, P::RESOLVED_NEXT, 10));
        let entry = Entry {
            id,
            unit: 2,
            faction: 0,
            state: E::STATE_ROSTER,
            troops: 12_000,
            stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
            op: EntryOp::None,
            ..Entry::FREE
        };
        write_entry(&mut home, 0, &entry).expect("the host's roster entry");
        home[P::N_ENTRIES] = 1;

        let mut citizen = header_bytes(C::SIZE, C::MAGIC);
        assert!(wr_arr(&mut citizen, C::WALLET, &wallet.to_bytes()));
        assert!(wr_u32(&mut citizen, C1::BUCKET_MILLI, 5_000));
        let slot = C::holding_of_slot(1);
        assert!(wr_i16(&mut citizen, slot + HR::P, 128));
        citizen[slot + HR::SITE] = host.site();
        citizen[slot + HR::GEN] = host.gen();

        let holding_key = Address::new_from_array(resolver.holding_address(&host).expect("the Holding's address"));
        let home_key = Address::new_from_array(resolver.province_address(host.key()).expect("the home Province's address"));
        World { program, ctx, season, host, accounts: vec![(season, s), (citizen_key, citizen), (holding_key, h), (home_key, home)] }
    }

    /// Write the fixture into the chain, owned by the program under test (see the module doc for its limits).
    fn install(&self, c: &mut Chain, funded: &Address) {
        for (key, data) in &self.accounts {
            // (the chain's own Account type, taken from an existing system account and restated in full)
            let mut account = c.account(funded).expect("the funded wallet's account");
            account.data = data.clone();
            account.owner = self.program;
            account.lamports = 10_000_000_000;
            account.executable = false;
            c.set_account(*key, account).expect("the fixture account");
        }
    }

    fn min_tip(&self) -> u64 {
        let s = fclient::decode::Season::decode(&self.accounts[0].1).expect("the fixture Season decodes");
        fclient::fees::min_tip_lamports(s.min_reveal_priority_milli, s.reveal_cu_limit, s.reveal_loaded_limit)
    }

    /// The canonical wallet-path draft: the wallet acts and pays.
    fn draft(&self, wallet: &Address, arrive: u32, tip: u64) -> Draft {
        Draft::for_wallet(&self.ctx, self.host, self.host.key(), *wallet, *wallet, 0, arrive, tip, COMMIT, SEAL).expect("the canonical Depart draft")
    }

    /// Every game account of the departure, whole (lamports, owner, executable, data) or absent: the four fixture
    /// accounts and the transit record's address.
    fn state(&self, c: &Chain, transit: &Address) -> Vec<(Address, Option<(u64, Address, bool, Vec<u8>)>)> {
        self.accounts.iter().map(|(k, _)| *k).chain([*transit]).map(|k| (k, c.account(&k).map(|a| (a.lamports, a.owner, a.executable, a.data)))).collect()
    }
}

/// The Depart of `draft` as a wire transaction really signed by `signer` over the chain's latest blockhash: the
/// CANONICAL prepared message of fclient's `prepare_depart` (version-2 dispatch wrapper, the three budget
/// instructions and the one fixed heap frame), signed as it is. Nothing is added to it after it is prepared.
fn signed_depart(c: &Chain, w: &World, draft: &Draft, signer: &Keypair) -> Result<Vec<u8>, String> {
    let prepared = prepared_depart(c, w, draft)?;
    assert_eq!(prepared.expected_signers(), [signer.pubkey()], "one signer: the wallet that also pays");
    assert_eq!(prepared.message().instructions.len(), 5, "limit, price, loaded-data limit, heap frame, dispatch");
    let t = tx::sign(prepared.message().clone(), &[signer])?;
    Ok(tx::wire(&t))
}
fn budget() -> TxBudget {
    TxBudget { cu_limit: 1_000_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(DEPART_HEAP_FRAME) }
}
fn prepared_depart(c: &Chain, w: &World, draft: &Draft) -> Result<fclient::experimental_expedition_message::Prepared, String> {
    let (blockhash, last_valid) = c.latest_blockhash();
    let observation = BlockhashObservation { blockhash: blockhash.to_bytes(), context_slot: c.slot(), valid: true, block_height: last_valid.saturating_sub(100), last_valid_block_height: last_valid };
    let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
    let target = Target { program: w.program, season: w.season, program_version: PROGRAM_VERSION };
    let prepared = prepare_depart(draft, target, observation, budget(), limits).map_err(|e| format!("prepare_depart: {e:?}"))?;
    let data = &prepared.instruction().data;
    assert_eq!(data[..4], [wire::Kind::Depart.tag(), 0xff, wire::VERSION, wire::Kind::Depart as u8], "the version-2 dispatch wrapper, Kind::Depart");
    Ok(prepared)
}
/// REGRESSION EVIDENCE ONLY: the canonical shape of before the heap frame (three budget instructions and the same
/// dispatch instruction, the default 32 KiB heap). `prepare_depart` no longer builds it; it is assembled here from
/// the canonical instruction to keep on record why the frame is required.
fn signed_depart_without_heap_frame(c: &Chain, w: &World, draft: &Draft, signer: &Keypair) -> Result<Vec<u8>, String> {
    let prepared = prepared_depart(c, w, draft)?;
    let (blockhash, _) = c.latest_blockhash();
    let t = tx::build(&[prepared.instruction().clone()], &TxBudget { heap: None, ..budget() }, &[signer], &blockhash)?;
    assert_eq!(t.message.instructions.len(), 4);
    Ok(tx::wire(&t))
}

/// What one submitted transaction did, as the chain recorded it.
#[derive(Debug)]
struct Outcome {
    landed: bool,
    err: Option<String>,
    code: Option<u32>,
    units: u64,
    fee: u64,
    logs: Vec<String>,
}
fn send(c: &mut Chain, wire: &[u8]) -> Outcome {
    match c.submit(wire) {
        Err(e) => Outcome { landed: false, err: Some(format!("refused before landing: {e}")), code: None, units: 0, fee: 0, logs: vec![] },
        Ok(sig) => {
            c.produce_block();
            match c.transaction(&sig) {
                Some(l) => Outcome { landed: true, err: l.err.clone(), code: l.code, units: l.units, fee: l.fee, logs: l.logs.clone() },
                None => Outcome { landed: false, err: Some(format!("not landed (dropped: {})", c.is_dropped(&sig))), code: None, units: 0, fee: 0, logs: vec![] },
            }
        }
    }
}
/// A fresh chain, an in-memory funded wallet and the fixture for it under `program`.
fn fresh(program: Address) -> (Chain, Keypair, World) {
    let mut c = Chain::new(Config::default());
    let wallet = Keypair::new();
    c.airdrop(&wallet.pubkey(), 10_000_000_000).expect("the disposable chain's airdrop");
    c.produce_block();
    let w = World::new(program, &wallet.pubkey(), c.unix_timestamp());
    w.install(&mut c, &wallet.pubkey());
    (c, wallet, w)
}

// ------------------------------------------------------------------ always runnable (no artifact)

#[test]
fn the_constants_are_the_dedicated_build_s() {
    assert_eq!(wire::PROGRAM_VERSION, PROGRAM_VERSION, "expedition_dispatch_ix::PROGRAM_VERSION is 0x4804");
    assert_eq!(wire::VERSION, 2);
    assert_eq!(dedicated().to_bytes(), [0x45; 32]);
    assert_eq!(MARKER, b"PSF_LOCALNET_EXPEDITION_SBF_BUILD");
    assert_ne!(RULESET_HASH_V3, [0; 32]);
    assert_ne!(RULESET_HASH_V3, [9; 32], "the Season carries the real S1 ruleset hash, not the keeper fixture's filler");
}

#[test]
fn the_artifact_checks_refuse_what_is_not_the_named_build() {
    let mut elf = vec![0x7f, b'E', b'L', b'F'];
    elf.extend_from_slice(&[0; 96]);
    elf.extend_from_slice(MARKER);
    elf.extend_from_slice(&PROGRAM);
    let sha = hex::encode(Sha256::digest(&elf));
    assert_eq!(inspect(elf.clone(), &sha).map(|a| a.sha256), Ok(sha.clone()));
    assert!(inspect(elf.clone(), &"0".repeat(64)).unwrap_err().contains("SHA-256"));
    assert!(inspect(elf.clone(), &sha.to_uppercase()).unwrap_err().contains("lowercase hex"));
    let mut not_elf = elf.clone();
    not_elf[0] = 0;
    assert!(inspect(not_elf.clone(), &hex::encode(Sha256::digest(&not_elf))).unwrap_err().contains("ELF"));
    let mut other_marker = elf.clone();
    other_marker[100] ^= 0x20; // one letter of the marker
    assert!(inspect(other_marker.clone(), &hex::encode(Sha256::digest(&other_marker))).unwrap_err().contains("marker"));
}

/// The whole pipeline short of the program: fixture, canonical draft, version-2 wrapper, a real signature the chain
/// verifies. With NO program deployed the Depart must fail and write nothing: this harness has no stand-in.
#[test]
fn without_the_program_a_really_signed_depart_lands_as_a_failure_and_writes_nothing() {
    let (mut c, wallet, w) = fresh(dedicated());
    let draft = w.draft(&wallet.pubkey(), 15, w.min_tip());
    let transit = draft.roles()[8].address;
    let before = w.state(&c, &transit);
    assert!(c.account(&dedicated()).is_none(), "no program is deployed in this test");
    let wire = signed_depart(&c, &w, &draft, &wallet).expect("a signed Depart");
    let t = tx::from_wire(&wire).expect("the wire decodes");
    assert!(t.verify().is_ok(), "a real ed25519 signature over the message");
    let out = send(&mut c, &wire);
    assert!(out.err.is_some(), "no deployed program: the Depart cannot succeed ({out:?})");
    assert_eq!(out.code, None, "and it is not a program's refusal: there is no program");
    assert_eq!(before, w.state(&c, &transit), "nothing was written and no transit record exists");
    // a signature by another key over the same message is not this wallet's and is refused before landing
    let stranger = Keypair::new();
    assert!(tx::sign(t.message.clone(), &[&stranger]).and_then(|bad| c.submit(&tx::wire(&bad)).map_err(|e| e.to_string())).is_err(), "a foreign signature is not accepted");
    let mut forged = wire.clone();
    forged[1] ^= 1; // first byte of the signature
    assert!(c.submit(&forged).is_err(), "a corrupted signature is refused by the chain");
}

// ------------------------------------------------------------------ the artifact test

/// A refusal BY THE PROGRAM: the transaction landed, failed with exactly this custom code, wrote none of the game
/// accounts, created no transit record, and cost the payer its transaction fee and nothing else.
#[allow(clippy::too_many_arguments)]
fn refused_by_the_program(name: &str, c: &mut Chain, w: &World, draft: &Draft, signer: &Keypair, expected: u32, wrong: &mut Vec<String>) {
    let transit = draft.roles()[8].address;
    let wire = signed_depart(c, w, draft, signer).expect("a signed Depart");
    let (before, lamports) = (w.state(c, &transit), c.balance(&signer.pubkey()));
    let out = send(c, &wire);
    eprintln!("{name}: landed {} err {:?} code {:?} units {} fee {}", out.landed, out.err, out.code, out.units, out.fee);
    assert!(out.landed, "{name}: the transaction must reach the program, not be refused before landing ({:?})", out.err);
    assert!(out.units > 0, "{name}: the program ran");
    if out.code != Some(expected) {
        // (collected, so one run names every code that differs; the test fails on any at its end)
        wrong.push(format!("{name}: expected custom code {expected}, the program answered {:?} ({:?}); last log: {:?}", out.code, out.err, out.logs.last()));
    }
    assert_eq!(before, w.state(c, &transit), "{name}: every game account is as it was (data, lamports, owner, executable) and no transit record exists");
    assert_eq!(c.balance(&signer.pubkey()), lamports - out.fee, "{name}: the payer lost the transaction fee and nothing else");
}

/// The first departure through the real SBF program. Fails (never skips) when an input is missing or the artifact
/// is not the named build.
#[test]
#[ignore = "needs the localnet-expedition-sbf artifact: set WYLLS_EXPEDITION_SBF and WYLLS_EXPEDITION_SBF_SHA256, then run with --ignored"]
fn the_real_sbf_takes_the_original_host_depart_and_refuses_what_it_must() {
    let artifact = artifact_from_env().unwrap_or_else(|e| panic!("the SBF artifact is required and was not usable: {e}"));
    eprintln!("artifact: {} bytes, sha256 {}, marker present", artifact.bytes.len(), artifact.sha256);
    let deploy = |c: &mut Chain, at: Address| c.deploy(at, &artifact.bytes, artifact.bytes.len(), None).expect("the artifact deploys under LoaderV3");

    // ---- regression evidence: the OLD canonical shape (no heap frame) runs out of the default 32 KiB heap
    {
        let (mut c, wallet, w) = fresh(dedicated());
        deploy(&mut c, dedicated());
        let draft = w.draft(&wallet.pubkey(), 15, w.min_tip());
        let transit = draft.roles()[8].address;
        let wire = signed_depart_without_heap_frame(&c, &w, &draft, &wallet).expect("the old-shape signed Depart");
        let (before, lamports) = (w.state(&c, &transit), c.balance(&wallet.pubkey()));
        let out = send(&mut c, &wire);
        eprintln!("OLD shape (no heap frame): landed {} err {:?} code {:?} units {}; last log: {:?}", out.landed, out.err, out.code, out.units, out.logs.last());
        assert!(out.landed && out.units > 0, "the real program ran the old-shape message");
        assert_eq!(out.code, None, "it is not a game refusal");
        assert!(out.err.as_deref().is_some_and(|e| e.contains("ProgramFailedToComplete")), "the old shape does not complete: {:?}", out.err);
        assert!(out.logs.last().is_some_and(|l| l.contains("Access violation") && l.contains("heap region")), "and the reason is the heap: {:?}", out.logs.last());
        assert_eq!(before, w.state(&c, &transit), "a Depart that ran out of heap wrote nothing");
        assert_eq!(c.balance(&wallet.pubkey()), lamports - out.fee, "and cost its fee only");
    }

    // ---- the departure: the canonical prepared message (its one fixed 256 KiB heap frame included), signed as it is
    let (mut c, wallet, w) = fresh(dedicated());
    deploy(&mut c, dedicated());
    assert!(c.account(&dedicated()).is_some_and(|a| a.executable), "the dedicated id is an executable program");
    let tip = w.min_tip();
    let draft = w.draft(&wallet.pubkey(), 15, tip);
    let roles = draft.roles();
    let (citizen, holding, province, transit) = (roles[3].address, roles[4].address, roles[5].address, roles[8].address);
    let wire = signed_depart(&c, &w, &draft, &wallet).expect("a signed Depart");
    let (before, lamports_before) = (w.state(&c, &transit), c.balance(&wallet.pubkey()));
    assert!(before.last().is_some_and(|(k, a)| *k == transit && a.is_none()), "no transit record yet");
    let out = send(&mut c, &wire);
    eprintln!("depart: landed {} err {:?} code {:?} units {} fee {}", out.landed, out.err, out.code, out.units, out.fee);
    for line in &out.logs {
        eprintln!("  log: {line}");
    }
    assert!(out.landed && out.err.is_none(), "the real program refused the fixture's Depart: {:?} (code {:?}); logs above", out.err, out.code);
    assert!(out.units > 0, "the SBF program ran");
    // ---- the writeback, read from the chain
    let after = w.state(&c, &transit);
    let of = |s: &Vec<(Address, Option<(u64, Address, bool, Vec<u8>)>)>, k: &Address| s.iter().find(|(a, _)| a == k).and_then(|(_, v)| v.clone());
    let changed = |k: &Address| of(&before, k).zip(of(&after, k)).map_or(0, |(a, b)| a.3.iter().zip(&b.3).filter(|(x, y)| x != y).count());
    assert_eq!(of(&before, &w.season), of(&after, &w.season), "the Season is read only");
    assert!(changed(&holding) > 0, "the Holding was written (transit slot, escrow)");
    assert!(changed(&province) > 0, "the standing Province was written (the host's entry)");
    assert!(changed(&citizen) > 0, "the Citizen was written (bucket, arrivals)");
    for k in [&citizen, &holding, &province] {
        let (a, b) = (of(&before, k).unwrap(), of(&after, k).unwrap());
        assert_eq!((a.1, a.2, a.3.len()), (b.1, b.2, b.3.len()), "owner, executable flag and size are unchanged");
    }
    let record = of(&after, &transit).expect("the transit record exists");
    assert_eq!(record.1, dedicated(), "and is the program's");
    assert!(!record.2, "and is not executable");
    let paid = lamports_before - c.balance(&wallet.pubkey());
    assert!(paid > out.fee, "the wallet paid the fee and funded the departure");
    eprintln!("writeback: citizen {} bytes changed, holding {}, province {}, transit record {} bytes ({} lamports), wallet -{} lamports (fee {})",
        changed(&citizen), changed(&holding), changed(&province), record.3.len(), record.0, paid, out.fee);

    // ---- refusals by the program, each landed with its own code and rolled back whole
    let mut wrong = Vec::new();
    // the same host again, in the next slot it would use: it is no longer on the roster
    let again = Draft::for_wallet(&w.ctx, w.host, w.host.key(), wallet.pubkey(), wallet.pubkey(), 1, 16, tip, COMMIT, SEAL).expect("a draft for slot 1");
    refused_by_the_program("the same host a second time", &mut c, &w, &again, &wallet, REPLAY, &mut wrong);

    // a wallet that is not the host's owner (its own Citizen does not exist)
    let (mut c, _owner, w) = fresh(dedicated());
    deploy(&mut c, dedicated());
    let stranger = Keypair::new();
    c.airdrop(&stranger.pubkey(), 10_000_000_000).expect("airdrop");
    c.produce_block();
    refused_by_the_program("a wallet that does not own the host", &mut c, &w, &w.draft(&stranger.pubkey(), 15, tip), &stranger, NOT_OWNER, &mut wrong);

    // the arrival turn outside the program's window (present bell 10: 12..=82, before the Season's end)
    for (name, arrive, code) in [("an arrival turn too early", 11u32, ARRIVAL), ("an arrival turn too late", 10 + 73, ARRIVAL), ("an arrival turn at the season's end", 1008, ARRIVAL)] {
        let (mut c, wallet, w) = fresh(dedicated());
        deploy(&mut c, dedicated());
        refused_by_the_program(name, &mut c, &w, &w.draft(&wallet.pubkey(), arrive, tip), &wallet, code, &mut wrong);
    }

    // a tip below the Season's minimum, when the Season has one
    if tip > 0 {
        let (mut c, wallet, w) = fresh(dedicated());
        deploy(&mut c, dedicated());
        refused_by_the_program("a tip below the minimum", &mut c, &w, &w.draft(&wallet.pubkey(), 15, tip - 1), &wallet, TIP, &mut wrong);
    } else {
        eprintln!("a tip below the minimum: NOT MEASURED (the fixture Season's minimum tip is 0)");
    }

    // ---- the same artifact under another id: the build runs only as the dedicated program
    let other = Address::new_from_array([0x46; 32]);
    let (mut c, wallet, w) = fresh(other);
    deploy(&mut c, other);
    refused_by_the_program("the same artifact deployed at another program id", &mut c, &w, &w.draft(&wallet.pubkey(), 15, tip), &wallet, WRONG_PROGRAM, &mut wrong);
    assert!(wrong.is_empty(), "refusals with another code than expected:\n{}", wrong.join("\n"));
}

// The program's refusal codes, as measured on the artifact (sha256 e258bbdf…74d7) and named by the ABI's error table.
use frontier_abi::error::FrontierError as Fe;
/// The host is already in a transit slot.
const REPLAY: u32 = Fe::HostInTransit as u32;
/// The stranger's own Citizen account does not exist: the player prologue refuses the account.
const NOT_OWNER: u32 = Fe::BadAccount as u32;
const ARRIVAL: u32 = Fe::ArrivalBell as u32;
const TIP: u32 = Fe::TipTooLow as u32;
/// Under any id but the dedicated one the build's own address check refuses.
const WRONG_PROGRAM: u32 = Fe::BadAddress as u32;
