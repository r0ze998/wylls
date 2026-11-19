//! The PLAYABLE lane (program version 0x4804: S1 | wide 0x4000 | dispatch
//! revision 0x0800; the devnet build `devnet-playable-sbf` =
//! conquest-dispatch-experimental + land-preview) under the verifier's
//! `playable-lane` feature (Q16-1 = A, 2026-11-18).
//!
//! * `record_playable_lane_natural` (ignored; needs the artefact): a REAL
//!   season of the devnet-playable `.so` (built from main faf1a520) in the in-process LiteSVM
//!   chain (`localnet::Chain`), by its own instructions only, as the natural
//!   local-play world builds it (AnnounceSeason → CreateSeason →
//!   InitBeaconLogs → InitShards → ConsumeGenesisSeed → OpenRing →
//!   OpenProvince), then a player's Join, PlaceHome, Harvest, Build, Train
//!   and Muster, and the land lane's FoldLand / ClaimLandYield crank. The
//!   genesis round is one of the 32 REAL quicknet rounds the workspace ships
//!   (`fclient/fixtures/quicknet`, BLS-verified on load), so no network is
//!   used: the Season's clock is aligned to it (`svm-tests` `Beacons::align`).
//!   It saves the archive to `PLAYABLE_DUMP` when set.
//! * The other tests load the committed recording
//!   (`fixtures/verify/playable-lane-natural.json.gz`) and need nothing.
//!
//! Run the recorder:
//! `PSF_PLAYABLE_SO=/abs/devnet-playable.so PLAYABLE_DUMP=/abs/out.json.gz \
//!  cargo test -p verify --features playable-lane --test playable_lane -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::land_preview as fl;
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D};
use permutation_rules::frontier::beacon::{
    genesis_seed_round, genesis_ts as beacon_genesis_ts, round_time, BeaconClock,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use verify_core::input::{Config, Input};
use verify_core::Verdict;

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
const PLAYABLE_SHA256: &str = "ec511123493c23e9ab1f83295e4bf666bc48c8e3f8dcfee2298d9371cc483ca3";

fn params() -> SeasonParamsV2 {
    let mut p = S1_LOCAL_7D;
    p.base.program_version = PROGRAM_VERSION;
    p
}

struct Rec {
    c: localnet::Chain,
    a: Addresses,
    log: Vec<String>,
}

fn budget() -> tx::TxBudget {
    tx::TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: None,
    }
}

impl Rec {
    fn try_send(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str) -> bool {
        let (bh, _) = self.c.latest_blockhash();
        let t = tx::build(ixs, &budget(), signers, &bh).expect("build");
        let sig = match self.c.submit(&tx::wire(&t)) {
            Ok(s) => s,
            Err(e) => {
                self.log
                    .push(format!("{what}: refused before landing: {e}"));
                return false;
            }
        };
        self.c.produce_block();
        let l = self.c.transaction(&sig).cloned().expect("landed");
        let ok = l.err.is_none();
        self.log.push(format!(
            "{what}: {}",
            if ok {
                "ok".to_string()
            } else {
                format!("failed {:?} code {:?}", l.err, l.code)
            }
        ));
        ok
    }
    fn send(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str) {
        assert!(self.try_send(signers, ixs, what), "{:#?}", self.log);
    }
    /// Synthetic time in steps (the chain's scale control, as natural_play).
    fn advance_to(&mut self, to: i64) {
        while self.c.unix_timestamp() < to {
            let gap = to - self.c.unix_timestamp();
            self.c.set_scale((gap as f64 / 0.4).clamp(1.0, 2_000.0));
            self.c.produce_block();
        }
        self.c.set_scale(1.0);
    }
    fn data(&self, k: &Address) -> Option<Vec<u8>> {
        self.c.account(k).map(|a| a.data)
    }
}

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    }
}

fn land_address(a: &Addresses, p: i16, q: i16) -> Address {
    Address::new_from_array(fl::land_address(&ctx_of(a), p, q))
}

/// The land lane's FoldLand (`itest::land_lane::fold_ix`).
fn fold_ix(a: &Addresses, payer: &Address, p: i16, q: i16, max_bells: u8) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new_readonly(a.province(p.into(), q.into()), false),
            AccountMeta::new(land_address(a, p, q), false),
            AccountMeta::new_readonly(Address::new_from_array([0; 32]), false),
        ],
        data: vec![fl::TAG_FOLD_LAND, max_bells],
    }
}

/// The land lane's ClaimLandYield (`itest::land_lane::claim_ix`).
fn claim_ix(a: &Addresses, payer: &Address, p: i16, q: i16, site: u8) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new_readonly(a.province(p.into(), q.into()), false),
            AccountMeta::new(land_address(a, p, q), false),
            AccountMeta::new(a.holding(p.into(), q.into(), site), false),
        ],
        data: vec![fl::TAG_CLAIM_LAND_YIELD],
    }
}

#[test]
#[ignore = "needs the devnet-playable .so: set PSF_PLAYABLE_SO (sha256 ec511123…), run with --ignored"]
fn record_playable_lane_natural() {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    assert_eq!(
        hex::encode(so_hash),
        PLAYABLE_SHA256,
        "not the devnet-playable build"
    );
    assert_eq!(localnet::bls_and_sbpf_v2_active(), (true, true));

    // The genesis round: a REAL quicknet round the workspace ships.
    let rounds = FixtureDrand::load(&fb::fixture_dir(), fb::quicknet_info())
        .expect("fixture rounds verify")
        .rounds;
    let (&round, beacon) = rounds.iter().next().expect("a round");
    let p = params();
    let clock = BeaconClock {
        genesis: p.base.drand_genesis,
        period: p.base.drand_period as i64,
    };
    let margin = p.base.seed_margin;
    let t_create_min = round_time(clock.genesis, p.base.drand_period, round)
        - permutation_rules::frontier::beacon::SEED_LEAD_SECS
        - margin as i64;
    assert_eq!(genesis_seed_round(&clock, t_create_min, margin), round);
    let genesis_ts = beacon_genesis_ts(&clock, round);
    let g0 = t_create_min - frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS - 3_600;

    let program = Address::new_from_array([0x45; 32]);
    let a = Addresses::new(program, SEASON_ID);
    let mut c = localnet::Chain::new(localnet::Config {
        g0,
        allow_tamper: false,
        data_dir: None,
        ..localnet::Config::default()
    });
    let upgrade = Keypair::new_from_array([0xA1; 32]);
    let payer = Keypair::new_from_array([0xA2; 32]);
    let wallet = Keypair::new_from_array([0xB1; 32]);
    let session = Keypair::new_from_array([0xB2; 32]);
    c.deploy(
        program,
        &so,
        fclient::fees::deploy_max_len(so.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )
    .expect("deploy");
    c.airdrop(&upgrade.pubkey(), 500_000_000_000).unwrap();
    c.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    c.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    c.produce_block();
    let mut r = Rec { c, a, log: vec![] };
    let a = r.a.clone();

    let sp = p.to_bytes();
    let payout = permutation_rules::frontier::payout::PayoutParams::REV3.to_borsh();
    r.send(
        &[&upgrade],
        &[ix::announce_season(
            &a,
            upgrade.pubkey(),
            params_hash_v2(&sp, &payout),
            t_create_min,
            frontier_abi::presets::MIN_CREATION_BOND,
        )],
        "AnnounceSeason",
    );
    r.advance_to(t_create_min);
    r.send(
        &[&upgrade],
        &[ix::create_season(&a, upgrade.pubkey(), &sp, &payout)],
        "CreateSeason",
    );
    r.send(
        &[&upgrade],
        &[ix::init_beacon_logs(&a, upgrade.pubkey())],
        "InitBeaconLogs",
    );
    for f in 0..fclient::abi::FACTIONS {
        r.send(
            &[&upgrade],
            &[ix::init_shards(&a, upgrade.pubkey(), f)],
            "InitShards",
        );
    }
    r.advance_to(round_time(clock.genesis, p.base.drand_period, round) + 1);
    let arg = ix::BeaconArg {
        round,
        sig48: beacon.sig48,
        hints: fb::hints_bytes(round),
    };
    r.send(
        &[&payer],
        &[ix::consume_genesis_seed(&a, payer.pubkey(), &arg)],
        "ConsumeGenesisSeed",
    );
    // Open the map two bells after genesis: a Province's `resolved_next`
    // is its opening bell, so the land crank has a bell to fold.
    r.advance_to(genesis_ts + 2 * 600 + 1);
    let sd = r.data(&a.season).expect("season");
    let cq = ConquestParams::of_season(&sd).expect("conquest params");
    let seed: [u8; 32] = sd[frontier_abi::v2::layout::world::season::GENESIS_SEED..][..32]
        .try_into()
        .unwrap();
    let rings_opened = |r: &Rec| -> u16 {
        let fd = r.data(&a.frontier()).expect("frontier");
        u16::from_le_bytes(
            fd[frontier_abi::layout::world::frontier::RINGS_OPENED..][..2]
                .try_into()
                .unwrap(),
        )
    };
    while rings_opened(&r) <= cq.heartland_max_ring as u16 {
        let d = rings_opened(&r);
        r.send(
            &[&payer],
            &[ix::open_ring(&a, payer.pubkey(), d)],
            "OpenRing",
        );
    }
    let mut homes: Vec<(i16, i16, u8)> = vec![];
    for ring in 2..=cq.heartland_max_ring as i32 {
        for pp in -ring..=ring {
            for qq in -ring..=ring {
                let coord = ProvinceCoord::new(pp, qq);
                if coord.ring() as i32 != ring {
                    continue;
                }
                if let Some(n) = home_nation(coord, cq.placement, cq.heartland_max_ring, &seed) {
                    if homes.iter().any(|h| h.2 == n) {
                        continue; // one home province per nation is enough here
                    }
                    r.send(
                        &[&payer],
                        &[ix::open_province(&a, payer.pubkey(), pp as i16, qq as i16)],
                        "OpenProvince",
                    );
                    homes.push((pp as i16, qq as i16, n));
                }
            }
        }
    }

    // The player: Join, then PlaceHome on its nation's home province.
    let (hp, hq, faction) = homes[0];
    let now = r.c.unix_timestamp();
    r.send(
        &[&wallet],
        &[ix::join(
            &a,
            wallet.pubkey(),
            wallet.pubkey(),
            faction,
            &session.pubkey(),
            now + 6 * 3_600,
            None,
        )],
        "Join",
    );
    let cd = r.data(&a.citizen(&wallet.pubkey())).expect("citizen");
    let shard = cd[144];
    let player = ix::Player {
        actor: wallet.pubkey(),
        payer: wallet.pubkey(),
        wallet: wallet.pubkey(),
    };
    let mut home = None;
    for site in 0..frontier_abi::v2::layout::province::province::SITES_N as u8 {
        let s = ix::Site { p: hp, q: hq, site };
        if r.try_send(
            &[&wallet],
            &[ix::place_home(&a, &player, s, faction, shard)],
            &format!("PlaceHome site {site}"),
        ) {
            home = Some(site);
            break;
        }
    }
    let site = home.expect("a PlaceHome lands");
    let h = ix::HoldingRef { p: hp, q: hq, site };
    // ABI v2 (§5.6): Harvest and Train gain `[province r]`, Build `[province r|w]`.
    let with_province = |mut i: Instruction, writable: bool| {
        let k = a.province(hp.into(), hq.into());
        if !i.accounts.iter().any(|m| m.pubkey == k) {
            i.accounts.push(if writable {
                AccountMeta::new(k, false)
            } else {
                AccountMeta::new_readonly(k, false)
            });
        }
        i
    };

    // The economy, in natural time (a few minutes of play).
    let t = r.c.unix_timestamp();
    r.advance_to(t + 300);
    r.try_send(
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest",
    );
    for item in 0..4u8 {
        r.try_send(
            &[&wallet],
            &[with_province(
                ix::build_item(&a, &player, h, item, false),
                false,
            )],
            &format!("Build {item}"),
        );
    }
    let t = r.c.unix_timestamp();
    r.advance_to(t + 600);
    r.try_send(
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest",
    );
    for unit in 0..2u8 {
        r.try_send(
            &[&wallet],
            &[with_province(ix::train(&a, &player, h, unit, 10), false)],
            &format!("Train {unit}"),
        );
    }

    // A host on the home's own tile (Muster: P + `[holding w] [province w]`).
    let tile = r
        .data(&a.holding(hp.into(), hq.into(), site))
        .expect("holding")[frontier_abi::v2::layout::player::holding::TILE];
    let t = r.c.unix_timestamp();
    r.advance_to(t + 3 * 3_600); // the training queue finishes
    r.try_send(
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest (trained)",
    );
    for unit in 0..2u8 {
        r.try_send(
            &[&wallet],
            &[ix::muster(&a, &player, h, unit, 5, tile)],
            &format!("Muster {unit}"),
        );
    }

    // The land lane's crank on the home province.
    r.try_send(
        &[&payer],
        &[fold_ix(&a, &payer.pubkey(), hp, hq, 8)],
        "FoldLand",
    );
    r.try_send(
        &[&payer],
        &[claim_ix(&a, &payer.pubkey(), hp, hq, site)],
        "ClaimLandYield",
    );
    let t = r.c.unix_timestamp();
    r.advance_to(t + 120);
    r.try_send(
        &[&payer],
        &[fold_ix(&a, &payer.pubkey(), hp, hq, 8)],
        "FoldLand again",
    );
    r.try_send(
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest after the claim",
    );

    // The archive: every program transaction, the post-states of program
    // accounts, and the final states of every account the program owned.
    let mut txs: Vec<fclient::ports::TxRecord> =
        r.c.feed(0, usize::MAX, Some(&program))
            .into_iter()
            .map(|l| l.record())
            .collect();
    let mut owned = std::collections::BTreeSet::new();
    for t in txs.iter_mut() {
        t.post
            .retain(|(_, a)| a.as_ref().is_some_and(|a| a.owner == program));
        for (k, _) in &t.post {
            owned.insert(*k);
        }
    }
    let finals = owned
        .into_iter()
        .map(|k| {
            (
                k.to_bytes(),
                r.c.account(&k)
                    .filter(|a| a.lamports > 0 || !a.data.is_empty()),
            )
        })
        .collect();
    let input = Input {
        cfg: Config {
            program,
            season_id: SEASON_ID,
            quicknet_pk: fb::quicknet_info().public_key,
            ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
            program_hash: Some(so_hash),
        },
        txs,
        finals,
        final_slot: r.c.slot(),
        program_hashes: vec![(0, so_hash)],
        provenance: format!(
            "verify/tests/playable_lane.rs record_playable_lane_natural: the devnet-playable .so (sha256 {PLAYABLE_SHA256}) in localnet::Chain (LiteSVM, in process), a real season by its own instructions at program version 0x4804, genesis on the shipped real quicknet round {round}; steps: {}",
            r.log.join("; ")
        ),
        scenarios: vec!["playable-lane-natural".into()],
        history: Default::default(),
        resident_feed: None,
    };
    for l in &r.log {
        println!("{l}");
    }
    let rep = verify_core::verify(&input);
    for f in &rep.findings {
        println!(
            "{:?} {} {} {} {}",
            f.severity, f.check, f.code, f.entity, f.detail
        );
    }
    println!("verdict {:?}", rep.verdict);
    if let Ok(out) = std::env::var("PLAYABLE_DUMP") {
        input.save(std::path::Path::new(&out)).expect("save");
        println!("saved {out}");
    }
}

/// The committed recording.
fn recorded() -> Input {
    common::fixture("playable-lane-natural.json.gz")
}

#[test]
fn the_honest_playable_lane_recording_passes() {
    let input = recorded();
    let rep = verify_core::verify(&input);
    assert_eq!(
        rep.verdict,
        Verdict::Pass,
        "{:#?}",
        rep.findings
            .iter()
            .map(|f| (f.check, f.code.clone(), f.detail.clone()))
            .collect::<Vec<_>>()
    );
    assert!(rep.checks_run.contains(&"VL:land"), "{:?}", rep.checks_run);
}

// ------------------------------------------------------------ tampers

/// The successful transactions whose program instruction has tag `tag`.
fn txs_with(inp: &Input, tag: u8) -> Vec<usize> {
    (0..inp.txs.len())
        .filter(|&t| {
            inp.txs[t].err.is_none()
                && fclient::tx::from_wire(&inp.txs[t].tx).is_ok_and(|tx| {
                    let keys = &tx.message.account_keys;
                    tx.message.instructions.iter().any(|c| {
                        keys[c.program_id_index as usize] == inp.cfg.program
                            && c.data.first() == Some(&tag)
                    })
                })
        })
        .collect()
}

/// The `n`th account of the first program instruction of transaction `t`.
fn ix_key(inp: &Input, t: usize, n: usize) -> [u8; 32] {
    let tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let keys = &tx.message.account_keys;
    let ci = tx
        .message
        .instructions
        .iter()
        .find(|c| keys[c.program_id_index as usize] == inp.cfg.program)
        .unwrap();
    keys[ci.accounts[n] as usize].to_bytes()
}

fn edit_post(inp: &mut Input, t: usize, k: &[u8; 32], f: impl FnOnce(&mut Vec<u8>)) {
    let (_, a) = inp.txs[t]
        .post
        .iter_mut()
        .find(|(x, _)| x.to_bytes() == *k)
        .expect("a post-state");
    f(&mut a.as_mut().expect("present").data);
}

fn has(rep: &verify_core::Report, check: &str, code: &str) -> bool {
    rep.findings
        .iter()
        .any(|f| f.check == check && f.code == code)
}

fn show(rep: &verify_core::Report) -> Vec<(String, String, String)> {
    rep.findings
        .iter()
        .map(|f| (f.check.to_string(), f.code.clone(), f.detail.clone()))
        .collect()
}

#[test]
fn the_recording_has_every_land_path() {
    let inp = recorded();
    assert_eq!(
        txs_with(&inp, fl::TAG_FOLD_LAND).len(),
        2,
        "a creating and a later fold"
    );
    assert_eq!(txs_with(&inp, fl::TAG_CLAIM_LAND_YIELD).len(), 1);
    // S1's own instructions under 0x4804 (judged by the S1 checks).
    for tag in [
        0x38u8, /* PlaceHome */
        0x40,   /* Harvest */
        0x41,   /* Build */
        0x42,   /* Train */
    ] {
        assert!(!txs_with(&inp, tag).is_empty(), "tag {tag:#04x}");
    }
}

/// A ClaimLandYield that credited the Holding more than the land rule pays.
#[test]
fn a_forged_land_yield_credit_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, fl::TAG_CLAIM_LAND_YIELD)[0];
    let k = ix_key(&inp, t, 4);
    edit_post(&mut inp, t, &k, |d| {
        let o = frontier_abi::v2::layout::player::holding::STORES;
        d[o + 9] = d[o + 9].wrapping_add(1); // food stores +256 milli-units·2^8
    });
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(has(&rep, "VL", "LandReplayMismatch"), "{:#?}", show(&rep));
}

/// A FoldLand whose land record says a tile is owned that the kernel leaves open.
#[test]
fn a_forged_land_fold_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, fl::TAG_FOLD_LAND)[0];
    let k = ix_key(&inp, t, 3);
    edit_post(&mut inp, t, &k, |d| d[fl::land::OWNER] ^= 0x01);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(has(&rep, "VL", "LandReplayMismatch"), "{:#?}", show(&rep));
}

/// A land instruction whose data the program refuses, yet it succeeded.
#[test]
fn an_undecodable_land_instruction_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, fl::TAG_FOLD_LAND)[1];
    verify_core::tamper::edit_ix_tag(&mut inp, t, fl::TAG_FOLD_LAND, |d| d.push(0));
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(has(&rep, "VL", "Undecodable"), "{:#?}", show(&rep));
}

/// A claim paid to a Holding that is not at its address: the program refuses it.
#[test]
fn a_land_claim_to_another_holding_fails() {
    let mut inp = recorded();
    let t = txs_with(&inp, fl::TAG_CLAIM_LAND_YIELD)[0];
    let k = ix_key(&inp, t, 4);
    // The state before the claim names another site.
    let before = (0..t)
        .rev()
        .find(|&u| {
            inp.txs[u].err.is_none()
                && inp.txs[u]
                    .post
                    .iter()
                    .any(|(x, a)| x.to_bytes() == k && a.is_some())
        })
        .unwrap();
    edit_post(&mut inp, before, &k, |d| {
        d[frontier_abi::v2::layout::player::holding::SITE] ^= 1
    });
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(has(&rep, "VL", "LandAccounts"), "{:#?}", show(&rep));
}

/// A wide instruction in a playable-lane season: no check re-judges it, so
/// the season is never a PASS (and V0 names what it was).
#[test]
fn a_wide_instruction_is_never_a_pass() {
    for data in [
        vec![0xD8u8],           // decodes as nothing
        vec![0xDA, 0xff, 2, 0], // an envelope header with no body
    ] {
        let mut inp = recorded();
        let t = txs_with(&inp, fl::TAG_FOLD_LAND)[1];
        verify_core::tamper::edit_ix_tag(&mut inp, t, fl::TAG_FOLD_LAND, |d| *d = data.clone());
        let rep = verify_core::verify(&inp);
        assert_ne!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
        assert!(has(&rep, "V0", "WideUnmodelled"), "{:#?}", show(&rep));
    }
}

/// A tag no build of the playable lane runs (② Grant, ⑳ resident, ⑨
/// capacity): the program refuses it, so its success is a FAIL.
#[test]
fn a_tag_the_playable_build_refuses_fails() {
    for tag in [0xD0u8, 0xE1, 0xF0, 0xFE] {
        let mut inp = recorded();
        let t = txs_with(&inp, fl::TAG_FOLD_LAND)[1];
        verify_core::tamper::edit_ix_tag(&mut inp, t, fl::TAG_FOLD_LAND, |d| d[0] = tag);
        let rep = verify_core::verify(&inp);
        assert_eq!(
            rep.verdict,
            Verdict::Fail,
            "tag {tag:#04x}: {:#?}",
            show(&rep)
        );
        assert!(
            has(&rep, "V0", "UnknownInstruction"),
            "tag {tag:#04x}: {:#?}",
            show(&rep)
        );
    }
}

/// A land instruction bundled with another program instruction: the archive
/// has no state between them, so VL cannot re-run it.
#[test]
fn a_bundled_land_instruction_is_unverifiable() {
    let mut inp = recorded();
    let t = txs_with(&inp, fl::TAG_FOLD_LAND)[1];
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let ci = tx
        .message
        .instructions
        .iter()
        .find(|c| tx.message.account_keys[c.program_id_index as usize] == inp.cfg.program)
        .unwrap()
        .clone();
    tx.message.instructions.push(ci);
    inp.txs[t].tx = fclient::tx::wire(&tx);
    let rep = verify_core::verify(&inp);
    assert_ne!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
    assert!(has(&rep, "VL", "MissingData"), "{:#?}", show(&rep));
}

/// A program account of no layout the playable lane writes (no wide
/// instruction ran): FAIL; once a wide instruction ran it may be one of the
/// wide build's own records: UNVERIFIABLE, never a PASS.
#[test]
fn an_unknown_program_account_fails_unless_a_wide_instruction_ran() {
    // The forged account: written by the second FoldLand's transaction (its
    // post-state) and so the final state too (CQ1 sees a consistent archive).
    let forge = |inp: &mut Input| {
        let t = txs_with(inp, fl::TAG_FOLD_LAND)[1];
        let mut a = inp
            .finals
            .values()
            .flatten()
            .find(|a| a.owner == inp.cfg.program)
            .cloned()
            .unwrap();
        a.data = b"NOTALAYOUT-forged".to_vec();
        let k = Address::new_from_array([0x77; 32]);
        inp.txs[t].post.push((k, Some(a.clone())));
        inp.finals.insert(k.to_bytes(), Some(a));
    };
    let mut inp = recorded();
    forge(&mut inp);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(has(&rep, "VR", "UnknownAccount"), "{:#?}", show(&rep));

    let mut inp = recorded();
    forge(&mut inp);
    let t = txs_with(&inp, fl::TAG_FOLD_LAND)[1];
    verify_core::tamper::edit_ix_tag(&mut inp, t, fl::TAG_FOLD_LAND, |d| *d = vec![0xD8]);
    assert!(!rep.findings.iter().any(|f| f.code == "FinalStateMismatch"));
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Unverifiable, "{:#?}", show(&rep));
    let f = rep
        .findings
        .iter()
        .find(|f| f.code == "UnknownAccount")
        .unwrap();
    assert_eq!(f.severity, verify_core::Severity::Unverifiable);
}

/// A wide command that wrote a Holding (here the claim's transaction under
/// a wide tag): its rules are not modelled, so the season is UNVERIFIABLE,
/// and no check calls the write a forgery.
#[test]
fn a_holding_written_by_a_wide_command_is_unverifiable_not_a_fail() {
    let mut inp = recorded();
    let t = txs_with(&inp, fl::TAG_CLAIM_LAND_YIELD)[0];
    verify_core::tamper::edit_ix_tag(&mut inp, t, fl::TAG_CLAIM_LAND_YIELD, |d| *d = vec![0xD8]);
    let rep = verify_core::verify(&inp);
    assert_eq!(rep.verdict, Verdict::Unverifiable, "{:#?}", show(&rep));
    assert!(
        has(&rep, "V7", "UnverifiedInstruction"),
        "{:#?}",
        show(&rep)
    );
}
