//! TEST ONLY design proof (2026-11-15): the 0x51 A→B→A boundary and a signed-generation transfer, on the real Core
//! binary and three ISOLATED builds of the resident program (never the deployed one, never written over it):
//!   WYLLS_RESIDENT_SO         the default build (0x51 as today; 0x54 unknown → BadData)
//!   WYLLS_RESIDENT_COMPAT_SO  feature `signed-transfer-test-only` (adds 0x54 TransferResidentAt {gen}; 0x51 still served)
//!   WYLLS_RESIDENT_STRICT_SO  feature `transfer-requires-generation-test-only` (0x54, and 0x51 refused)
//!   PSF_CORE_SO               the untrimmed mainnet Core ELF (515541c8…)
//! Every test is #[ignore]: run them explicitly with those four paths (an agreed build slot).
//! World setup adapted from permutation-prize/svm-tests/tests/nft_pass.rs (⑰, branch claude/nft-prize-connect-20261114):
//! InitConfig needs the program's upgrade authority, written into LiteSVM's ProgramData header.
use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SYSTEM: Address = Address::new_from_array([0; 32]);
const CORE: Address = Address::from_str_const("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const LOADER_V3: Address = Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
const SOL: u64 = 1_000_000_000;
const PRICE: u64 = 100_000_000; // TEST VALUE
const GEN: usize = 48;
const SESSION: usize = 52;
const SESSION_EXPIRY: usize = 84;
const SESSION_GEN: usize = 92;
const SESSION_SETTER: usize = 96;
const STALE_GEN: u32 = 1004;
const BAD_DATA: u32 = 1000;

fn bin(env: &str) -> Vec<u8> {
    let p = std::env::var(env)
        .unwrap_or_else(|_| panic!("{env}: the path of the isolated build (see the file's head)"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("{env}={p}: {e}"))
}

struct World {
    svm: LiteSVM,
    program: Address,
    operator: Keypair,
    collection: Address,
    coll_auth: Address,
    config: Address,
    treasury: Address,
}
struct Pass {
    asset: Address,
    resident: Address,
}

fn borsh_str(d: &mut Vec<u8>, s: &str) {
    d.extend_from_slice(&(s.len() as u32).to_le_bytes());
    d.extend_from_slice(s.as_bytes());
}
fn tx(w: &World, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) -> Transaction {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let mut t = Transaction::new_unsigned(Message::new(ixs, Some(&payer.pubkey())));
    t.sign(&signers, w.svm.latest_blockhash());
    t
}
fn send(w: &mut World, t: Transaction) -> Result<(), String> {
    w.svm
        .send_transaction(t)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}
fn custom(r: &Result<(), String>, code: u32) -> bool {
    matches!(r, Err(e) if e.contains(&format!("Custom({code})")))
}

fn world(env: &str) -> World {
    let mut svm = LiteSVM::new();
    svm.add_program(CORE, &bin("PSF_CORE_SO")).expect("Core");
    let program = Keypair::new().pubkey();
    svm.add_program(program, &bin(env))
        .expect("the resident build");
    let operator = Keypair::new();
    svm.airdrop(&operator.pubkey(), 100 * SOL).unwrap();
    let programdata = Address::find_program_address(&[program.as_ref()], &LOADER_V3).0;
    let mut pd = svm.get_account(&programdata).expect("ProgramData");
    pd.data[12] = 1;
    pd.data[13..45].copy_from_slice(operator.pubkey().as_ref());
    svm.set_account(programdata, pd).unwrap();
    let coll_auth = Address::find_program_address(&[b"collection-authority"], &program).0;
    let config = Address::find_program_address(&[b"config"], &program).0;
    let mut w = World {
        svm,
        program,
        operator,
        collection: Address::default(),
        coll_auth,
        config,
        treasury: Keypair::new().pubkey(),
    };
    let coll = Keypair::new();
    let mut d = vec![1u8];
    borsh_str(&mut d, "Wylls Residents (TEST ONLY)");
    borsh_str(&mut d, "https://wylls.test/collection.json");
    d.push(0);
    let ix = Instruction {
        program_id: CORE,
        accounts: vec![
            AccountMeta::new(coll.pubkey(), true),
            AccountMeta::new_readonly(coll_auth, false),
            AccountMeta::new(w.operator.pubkey(), true),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: d,
    };
    let t = tx(&w, &[ix], &w.operator.insecure_clone(), &[&coll]);
    send(&mut w, t).expect("collection");
    w.collection = coll.pubkey();
    let r = |accounts: Vec<AccountMeta>, data: Vec<u8>| Instruction {
        program_id: program,
        accounts,
        data,
    };
    let mut d = vec![0x01];
    d.extend_from_slice(&PRICE.to_le_bytes());
    d.extend_from_slice(w.treasury.as_ref());
    d.extend_from_slice(w.collection.as_ref());
    let op = w.operator.insecure_clone();
    let ix = r(
        vec![
            AccountMeta::new(op.pubkey(), true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new_readonly(program, false),
            AccountMeta::new_readonly(programdata, false),
        ],
        d,
    );
    let t = tx(&w, &[ix], &op, &[]);
    send(&mut w, t).expect("InitConfig");
    let mut d = vec![0x05];
    let (name, uri) = (
        "Wylls Resident (TEST ONLY)",
        "https://wylls.test/resident.json",
    );
    d.push(name.len() as u8);
    d.extend_from_slice(name.as_bytes());
    d.push(uri.len() as u8);
    d.extend_from_slice(uri.as_bytes());
    let cfg = vec![
        AccountMeta::new_readonly(op.pubkey(), true),
        AccountMeta::new(config, false),
    ];
    let t = tx(&w, &[r(cfg.clone(), d)], &op, &[]);
    send(&mut w, t).expect("SetMetadata");
    let mut d = vec![0x03];
    d.extend_from_slice(&100u64.to_le_bytes());
    d.extend_from_slice(&0i64.to_le_bytes());
    d.extend_from_slice(&0i64.to_le_bytes());
    d.extend_from_slice(&0u16.to_le_bytes());
    d.push(1);
    let t = tx(&w, &[r(cfg, d)], &op, &[]);
    send(&mut w, t).expect("SetTerms");
    w
}

fn funded(w: &mut World) -> Keypair {
    let k = Keypair::new();
    w.svm.airdrop(&k.pubkey(), 10 * SOL).unwrap();
    k
}
fn mint(w: &mut World, owner: &Keypair) -> Pass {
    let asset = Keypair::new();
    let resident =
        Address::find_program_address(&[b"resident", asset.pubkey().as_ref()], &w.program).0;
    let minter =
        Address::find_program_address(&[b"minted-by", owner.pubkey().as_ref()], &w.program).0;
    let mut d = vec![0x50];
    d.extend_from_slice(&PRICE.to_le_bytes());
    let ix = Instruction {
        program_id: w.program,
        accounts: vec![
            AccountMeta::new(owner.pubkey(), true),
            AccountMeta::new(w.treasury, false),
            AccountMeta::new(asset.pubkey(), true),
            AccountMeta::new(w.collection, false),
            AccountMeta::new_readonly(w.coll_auth, false),
            AccountMeta::new(resident, false),
            AccountMeta::new(w.config, false),
            AccountMeta::new_readonly(CORE, false),
            AccountMeta::new_readonly(SYSTEM, false),
            AccountMeta::new(minter, false),
        ],
        data: d,
    };
    let t = tx(w, &[ix], owner, &[&asset]);
    send(w, t).expect("MintResident");
    Pass {
        asset: asset.pubkey(),
        resident,
    }
}
/// The transfer instruction: 0x51 (`signed: None`) or 0x54 with the signed generation.
fn transfer_ix(
    w: &World,
    p: &Pass,
    owner: &Address,
    to: &Address,
    signed: Option<u32>,
) -> Instruction {
    let data = match signed {
        None => vec![0x51],
        Some(g) => {
            let mut d = vec![0x54];
            d.extend_from_slice(&g.to_le_bytes());
            d
        }
    };
    Instruction {
        program_id: w.program,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*owner, true),
            AccountMeta::new(p.asset, false),
            AccountMeta::new(w.collection, false),
            AccountMeta::new_readonly(w.coll_auth, false),
            AccountMeta::new(p.resident, false),
            AccountMeta::new_readonly(*to, false),
            AccountMeta::new_readonly(CORE, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    }
}
fn set_session(w: &mut World, p: &Pass, owner: &Keypair, session: &Address) {
    let clock: solana_clock::Clock = w.svm.get_sysvar();
    let mut d = vec![0x52];
    d.extend_from_slice(session.as_ref());
    d.extend_from_slice(&(clock.unix_timestamp + 3_600).to_le_bytes());
    let ix = Instruction {
        program_id: w.program,
        accounts: vec![
            AccountMeta::new_readonly(owner.pubkey(), true),
            AccountMeta::new_readonly(p.asset, false),
            AccountMeta::new(p.resident, false),
        ],
        data: d,
    };
    let t = tx(w, &[ix], owner, &[]);
    send(w, t).expect("SetSession");
}
fn data(w: &World, a: &Address) -> Vec<u8> {
    w.svm.get_account(a).map(|x| x.data).unwrap_or_default()
}
fn gen(w: &World, p: &Pass) -> u32 {
    u32::from_le_bytes(data(w, &p.resident)[GEN..GEN + 4].try_into().unwrap())
}
fn owner_of(w: &World, p: &Pass) -> Address {
    Address::new_from_array(data(w, &p.asset)[1..33].try_into().unwrap())
}
/// Every NON-fee account a transfer may touch — the asset, the record, the collection, the collection authority, the
/// config and the recipient — as (address, exists, lamports, owner, data), to compare before and after a refusal.
fn snapshot(w: &World, p: &Pass, to: &Address) -> Vec<(Address, bool, u64, Address, Vec<u8>)> {
    [
        p.asset,
        p.resident,
        w.collection,
        w.coll_auth,
        w.config,
        *to,
    ]
    .iter()
    .map(|a| match w.svm.get_account(a) {
        Some(x) => (*a, true, x.lamports, x.owner, x.data),
        None => (*a, false, 0, Address::default(), vec![]),
    })
    .collect()
}
fn lamports(w: &World, a: &Address) -> u64 {
    w.svm.get_account(a).map_or(0, |x| x.lamports)
}
/// A refusal: the program's `code`, every non-fee account exactly as before (existence, lamports, owner, data), and the
/// fee payer changed by nothing but the signature fee (5,000 lamports per signature, or 0 if the runtime charged none).
fn refused(
    w: &mut World,
    t: Transaction,
    code: u32,
    p: &Pass,
    to: &Address,
    payer: &Address,
    what: &str,
) {
    let sigs = t.signatures.len() as u64;
    let (before, paid) = (snapshot(w, p, to), lamports(w, payer));
    let r = send(w, t);
    assert!(
        custom(&r, code),
        "{what}: expected Custom({code}), got {r:?}"
    );
    assert_eq!(
        snapshot(w, p, to),
        before,
        "{what}: a non-fee account changed"
    );
    let fee = paid - lamports(w, payer);
    assert!(
        fee == 0 || fee == 5_000 * sigs,
        "{what}: the fee payer changed by {fee}, not the signature fee"
    );
}

const VARIANTS: [&str; 2] = ["WYLLS_RESIDENT_COMPAT_SO", "WYLLS_RESIDENT_STRICT_SO"];
const BAD_ADDRESS: u32 = 1001;
const AUTH: u32 = 1002;
const NOT_OWNER: u32 = 1003;

#[test]
#[ignore = "needs the isolated builds: see the file's head"]
fn default_build_refuses_the_new_tag_and_keeps_0x51() {
    let mut w = world("WYLLS_RESIDENT_SO");
    let (a, b) = (funded(&mut w), funded(&mut w));
    let p = mint(&mut w, &a);
    let t = tx(
        &w,
        &[transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0))],
        &a,
        &[],
    );
    refused(
        &mut w,
        t,
        BAD_DATA,
        &p,
        &b.pubkey(),
        &a.pubkey(),
        "default: 0x54 is unknown",
    );
    let t = tx(
        &w,
        &[transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), None)],
        &a,
        &[],
    );
    send(&mut w, t).expect("0x51 as today");
    assert_eq!((owner_of(&w, &p), gen(&w, &p)), (b.pubkey(), 1));
}

#[test]
#[ignore = "needs the isolated builds: see the file's head"]
fn signed_transfer_current_generation_moves_owner_bumps_generation_and_clears_the_session() {
    for env in VARIANTS {
        let mut w = world(env);
        let (a, b, s) = (funded(&mut w), funded(&mut w), Keypair::new());
        let p = mint(&mut w, &a);
        set_session(&mut w, &p, &a, &s.pubkey());
        assert_ne!(data(&w, &p.resident)[SESSION..SESSION + 32], [0u8; 32]);
        let t = tx(
            &w,
            &[transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0))],
            &a,
            &[],
        );
        send(&mut w, t).unwrap_or_else(|e| panic!("{env}: 0x54 at the current generation: {e}"));
        let r = data(&w, &p.resident);
        assert_eq!((owner_of(&w, &p), gen(&w, &p)), (b.pubkey(), 1), "{env}");
        assert_eq!(
            r[SESSION..SESSION + 32],
            [0u8; 32],
            "{env}: the session is gone"
        );
        assert_eq!(r[SESSION_EXPIRY..SESSION_EXPIRY + 8], [0u8; 8]);
        assert_eq!(r[SESSION_GEN..SESSION_GEN + 4], [0u8; 4]);
        assert_eq!(r[SESSION_SETTER..SESSION_SETTER + 32], [0u8; 32]);
    }
}

#[test]
#[ignore = "needs the isolated builds: see the file's head"]
fn a_signed_generation_that_is_not_the_records_is_refused_and_nothing_changes() {
    for env in VARIANTS {
        let mut w = world(env);
        let (a, b) = (funded(&mut w), funded(&mut w));
        let p = mint(&mut w, &a);
        for wrong in [1u32, 7, u32::MAX] {
            let t = tx(
                &w,
                &[transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(wrong))],
                &a,
                &[],
            );
            refused(
                &mut w,
                t,
                STALE_GEN,
                &p,
                &b.pubkey(),
                &a.pubkey(),
                &format!("{env}: signed {wrong} vs record 0"),
            );
        }
    }
}

#[test]
#[ignore = "needs the isolated builds: see the file's head"]
fn malformed_unsigned_non_holder_and_wrong_proof_are_refused_and_nothing_changes() {
    for env in VARIANTS {
        let mut w = world(env);
        let (a, b, x) = (funded(&mut w), funded(&mut w), funded(&mut w));
        let p = mint(&mut w, &a);
        let q = mint(&mut w, &x); // another pass, another holder
                                  // truncated (3 bytes of generation) and oversized (5 bytes)
        for d in [vec![0x54, 0, 0, 0], vec![0x54, 0, 0, 0, 0, 0]] {
            let mut ix = transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0));
            ix.data = d.clone();
            let t = tx(&w, &[ix], &a, &[]);
            refused(
                &mut w,
                t,
                BAD_DATA,
                &p,
                &b.pubkey(),
                &a.pubkey(),
                &format!("{env}: data of {} bytes", d.len()),
            );
        }
        // the owner not signing (another wallet pays and signs; the owner's role is not a signer)
        let mut ix = transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0));
        ix.accounts[0].is_signer = false;
        ix.accounts[1] = AccountMeta::new(x.pubkey(), true);
        let t = tx(&w, &[ix], &x, &[]);
        refused(
            &mut w,
            t,
            AUTH,
            &p,
            &b.pubkey(),
            &x.pubkey(),
            &format!("{env}: the owner did not sign"),
        );
        // a non-holder signing as the owner
        let t = tx(
            &w,
            &[transfer_ix(&w, &p, &x.pubkey(), &b.pubkey(), Some(0))],
            &x,
            &[],
        );
        refused(
            &mut w,
            t,
            NOT_OWNER,
            &p,
            &b.pubkey(),
            &x.pubkey(),
            &format!("{env}: a non-holder"),
        );
        // another asset's record as the proof
        let mut ix = transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0));
        ix.accounts[5] = AccountMeta::new(q.resident, false);
        let t = tx(&w, &[ix], &a, &[]);
        refused(
            &mut w,
            t,
            BAD_ADDRESS,
            &p,
            &b.pubkey(),
            &a.pubkey(),
            &format!("{env}: another asset's record"),
        );
        assert_eq!(
            (owner_of(&w, &p), gen(&w, &p)),
            (a.pubkey(), 0),
            "{env}: the pass never moved"
        );
    }
}

#[test]
#[ignore = "needs the isolated builds: see the file's head"]
fn aba_an_old_unsent_signed_transfer_is_refused_after_a_to_b_to_a() {
    for env in VARIANTS {
        let mut w = world(env);
        let (a, b, r) = (funded(&mut w), funded(&mut w), funded(&mut w));
        let p = mint(&mut w, &a);
        let old = tx(
            &w,
            &[transfer_ix(&w, &p, &a.pubkey(), &r.pubkey(), Some(0))],
            &a,
            &[],
        );
        let t = tx(
            &w,
            &[transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0))],
            &a,
            &[],
        );
        send(&mut w, t).expect("A→B");
        let t = tx(
            &w,
            &[transfer_ix(&w, &p, &b.pubkey(), &a.pubkey(), Some(1))],
            &b,
            &[],
        );
        send(&mut w, t).expect("B→A");
        assert_eq!((owner_of(&w, &p), gen(&w, &p)), (a.pubkey(), 2));
        refused(
            &mut w,
            old,
            STALE_GEN,
            &p,
            &r.pubkey(),
            &a.pubkey(),
            &format!("{env}: the old transfer signed at 0 after A→B→A"),
        );
        assert_eq!(owner_of(&w, &p), a.pubkey());
    }
}

#[test]
#[ignore = "needs the isolated builds: see the file's head"]
fn the_compatible_variant_still_lets_an_old_0x51_through_the_strict_variant_refuses_it() {
    // COMPATIBLE: 0x51 is still served, so an old unsigned-generation transfer held across A→B→A still lands — the
    // boundary is NOT closed by adding 0x54 alone. STRICT: 0x51 is refused and nothing changes.
    for (env, strict) in [
        ("WYLLS_RESIDENT_COMPAT_SO", false),
        ("WYLLS_RESIDENT_STRICT_SO", true),
    ] {
        let mut w = world(env);
        let (a, b, r) = (funded(&mut w), funded(&mut w), funded(&mut w));
        let p = mint(&mut w, &a);
        let old = tx(
            &w,
            &[transfer_ix(&w, &p, &a.pubkey(), &r.pubkey(), None)],
            &a,
            &[],
        );
        let t = tx(
            &w,
            &[transfer_ix(&w, &p, &a.pubkey(), &b.pubkey(), Some(0))],
            &a,
            &[],
        );
        send(&mut w, t).expect("A→B");
        let t = tx(
            &w,
            &[transfer_ix(&w, &p, &b.pubkey(), &a.pubkey(), Some(1))],
            &b,
            &[],
        );
        send(&mut w, t).expect("B→A");
        if strict {
            refused(
                &mut w,
                old,
                BAD_DATA,
                &p,
                &r.pubkey(),
                &a.pubkey(),
                "strict: 0x51 refused",
            );
        } else {
            let res = send(&mut w, old);
            assert!(
                res.is_ok(),
                "compatible: the old 0x51 still lands (the open boundary): {res:?}"
            );
            assert_eq!(owner_of(&w, &p), r.pubkey());
        }
    }
}
