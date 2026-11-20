//! ②+⑨+⑩ in ONE local world, on the REAL SBF artefact (`itest::coexist_play`, whose module doc lists the flow and
//! every fixture): a StockSwap, a capacity loan and a custody lot land in one world, the compute units of every
//! step are printed (the first SBF measurement of the three features), and the build keeps apart from other
//! builds' Seasons.
//!
//!   scripts/build-frontier-localnet-coexist-sbf.sh
//!   WYLLS_COEXIST_SBF=<abs path of the .so> WYLLS_COEXIST_SBF_SHA256=<its sha256> \
//!     cargo test --locked -p itest --features localnet-coexist-harness --test localnet_coexist -- --nocapture
use fclient::ix;
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::capacity::CapData;
use frontier_abi::feature_registry as fr;
use frontier_abi::v2::rights as rt;
use itest::coexist_play::{self as cp, LAMPORTS};
use sha2::{Digest, Sha256};

const ENV_PATH: &str = "WYLLS_COEXIST_SBF";
const ENV_SHA: &str = "WYLLS_COEXIST_SBF_SHA256";

fn artifact() -> Vec<u8> {
    let get = |n: &str| {
        std::env::var(n).unwrap_or_else(|_| {
            panic!("{n} is not set ({ENV_PATH} = abs path of the coexist lane .so, {ENV_SHA} = its sha256)")
        })
    };
    let bytes = std::fs::read(get(ENV_PATH)).expect("read the artefact");
    assert_eq!(
        hex::encode(Sha256::digest(&bytes)),
        get(ENV_SHA),
        "the artefact's sha256"
    );
    assert_eq!(cp::artifact_problems(&bytes), Vec::<String>::new());
    bytes
}

#[test]
fn a_stock_swap_a_capacity_loan_and_a_custody_lot_land_in_one_world() {
    let mut w = cp::world(&artifact(), fr::COEXIST_LANE_VERSION, true);
    let d = cp::demo(&mut w);
    assert!(
        d.arms[0] < d.arms[1] && d.arms[1] < d.arms[2],
        "two swaps' arms in B's Vault: {:?}",
        d.arms
    );
    let payer = w.payer.insecure_clone();
    // The same accounts under a Season of another version (the plain lane's 0x4804, custody's ruleset kept):
    // every band refuses before any effect.
    let season = w.a.season;
    w.edit(&season, |d| {
        let o = frontier_abi::v2::layout::world::season::PROGRAM_VERSION;
        d[o..o + 2].copy_from_slice(&0x4804u16.to_le_bytes());
    });
    let before: Vec<Vec<u8>> = [d.facility, d.vault, d.lot, d.pool, d.grant]
        .iter()
        .map(|k| w.data(k))
        .collect();
    let mut m = cp::prologue(&w, &d.a, d.a_citizen);
    m.extend([
        AccountMeta::new(d.facility, false),
        AccountMeta::new(d.pool, false),
    ]);
    let lend = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: CapData::LendCapacity { units: 1, seq: 1 }.encode(),
    };
    let r9 = w.send(
        &[lend],
        &[&d.a, &payer],
        "⑨ LendCapacity on a 0x4804 Season",
    );
    let i = Instruction {
        program_id: w.a.program,
        accounts: cp::use_grant_metas(&w, &d),
        data: rt::ReserveSwap { units: 1, seq: 2 }.to_bytes().to_vec(),
    };
    let r2 = w.send(&[i], &[&d.b, &payer], "② ReserveSwap on a 0x4804 Season");
    let after: Vec<Vec<u8>> = [d.facility, d.vault, d.lot, d.pool, d.grant]
        .iter()
        .map(|k| w.data(k))
        .collect();
    assert_eq!(before, after, "no effect");
    let mut m = cp::prologue(&w, &d.b, d.b_citizen);
    m.extend([
        AccountMeta::new(d.vault, false),
        AccountMeta::new(d.lot, false),
    ]);
    let i = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: frontier_abi::v2::ix::SetLotQuota { quota: 30 }
            .to_bytes()
            .to_vec(),
    };
    let r10 = w.send(&[i], &[&d.b, &payer], "⑩ SetLotQuota on a 0x4804 Season");
    let mismatch = frontier_abi::error::FrontierError::RulesetMismatch as u32;
    println!("on a 0x4804 Season with custody's hash: ⑨ {r9:?} ② {r2:?} ⑩ {r10:?} (RulesetMismatch = {mismatch})");
    assert_eq!(r9, Err(mismatch), "⑨ checks the exact version");
    assert_eq!(r2, Err(mismatch), "② checks the exact version");
    // ⑩, like every base instruction (Join, Harvest, ...), checks the ruleset hash only: this synthetic Season keeps
    // custody's RULESET_HASH_V4, so it runs. A real Season of another build either has another hash (the plain
    // lane's V3: refused, `the_coexist_build_refuses_a_plain_lane_season`) or is refused by CreateSeason's exact
    // version check (the only way a Season comes to exist). Recorded in reports/feature-coexist.md.
    assert_eq!(r10, Ok(()), "⑩ separates builds by the ruleset hash");

    println!("--- compute units (tx total, coexist lane 0x7805)");
    for (what, cu) in &w.cu {
        println!("{what:<44} {cu:>7}");
    }
    let max = w.cu.iter().map(|x| x.1).max().unwrap();
    assert!(max < 1_400_000, "every step under the transaction limit");
}

/// The coexist artefact never plays a Season of the plain lane (0x4804, the S1 ruleset `RULESET_HASH_V3`, as
/// `scripts/play-local.sh` without `--coexist` creates it): a player cannot even Join (`RulesetMismatch`).
#[test]
fn the_coexist_build_refuses_a_plain_lane_season() {
    let mut w = cp::world(&artifact(), 0x4804, false);
    let k = Keypair::new();
    w.c.airdrop(&k.pubkey(), LAMPORTS).unwrap();
    let payer = w.payer.insecure_clone();
    let (_, _, faction) = w.home;
    let mismatch = Err(frontier_abi::error::FrontierError::RulesetMismatch as u32);
    let authority = w.authority.insecure_clone();
    let i = ix::init_shards(&w.a, authority.pubkey(), 0);
    assert_eq!(
        w.send(&[i], &[&authority], "InitShards on a plain-lane Season"),
        mismatch
    );
    let join = ix::join(
        &w.a,
        k.pubkey(),
        payer.pubkey(),
        faction,
        &Address::default(),
        0,
        None,
    );
    assert_eq!(
        w.send(&[join], &[&k, &payer], "Join on a plain-lane Season"),
        mismatch
    );
}
