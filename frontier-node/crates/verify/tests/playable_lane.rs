//! The PLAYABLE lane (program version 0x4804: S1 | wide 0x4000 | dispatch
//! revision 0x0800; the devnet build `devnet-playable-sbf` =
//! conquest-dispatch-experimental + land-preview for the recorded
//! `da3dc1aa…` / `ec511123…` binaries, expedition-dispatch-experimental +
//! land-preview since P14 b, `p14b_devnet_no_conquest.rs`) under the verifier's
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
/// The devnet-playable `.so` of main c889f6cf (committed gzipped for VX/VG):
/// the recorder also runs it (`playable-lane-genesis.json.gz`).
const MAIN_SHA256: &str = "da3dc1aae66d262ba79321ca9031b4b3510acc13b690154f02b2e304b38b9741";

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

/// The natural season of `so` in the in-process chain (the recorder's
/// steps): the chain, the program id and the upgrade authority.
fn build_natural(so: &[u8]) -> (Rec, Address, Keypair, u64) {
    build_natural_at(so, localnet::chain::LAMPORTS_PER_BYTE)
}

/// [`build_natural`] on a chain charging `lamports_per_byte` (rent-live-rest:
/// 6,960, the pre-SIMD-0194 rate, as well as the local node's 5,080).
fn build_natural_at(so: &[u8], lamports_per_byte: u64) -> (Rec, Address, Keypair, u64) {
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
        lamports_per_byte,
        ..localnet::Config::default()
    });
    let upgrade = Keypair::new_from_array([0xA1; 32]);
    let payer = Keypair::new_from_array([0xA2; 32]);
    let wallet = Keypair::new_from_array([0xB1; 32]);
    let session = Keypair::new_from_array([0xB2; 32]);
    c.deploy(
        program,
        so,
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

    (r, program, upgrade, round)
}

#[test]
#[ignore = "needs the devnet-playable .so: set PSF_PLAYABLE_SO (sha256 ec511123… or da3dc1aa…), run with --ignored"]
fn record_playable_lane_natural() {
    record_natural(localnet::chain::LAMPORTS_PER_BYTE);
}

/// rent-live-rest: the same natural season on a chain charging 6,960
/// lamports per byte, with the chain's Rent sysvar recorded beside it
/// (`playable-lane-genesis-6960.json.gz`, `PLAYABLE_DUMP=…`; the committed
/// da3dc1aa `.so` serves as `PSF_PLAYABLE_SO` after gunzip).
#[test]
#[ignore = "needs the devnet-playable .so: set PSF_PLAYABLE_SO (sha256 ec511123… or da3dc1aa…), run with --ignored"]
fn record_playable_lane_natural_6960() {
    record_natural(6_960);
}

fn record_natural(lamports_per_byte: u64) {
    let so_path = std::env::var("PSF_PLAYABLE_SO").expect("PSF_PLAYABLE_SO");
    let so = std::fs::read(&so_path).expect("the artefact");
    let so_hash = common::sha2_256(&so);
    assert!(
        [PLAYABLE_SHA256, MAIN_SHA256].contains(&hex::encode(so_hash).as_str()),
        "not the devnet-playable build"
    );
    let (r, program, upgrade, round) = build_natural_at(&so, lamports_per_byte);
    // rent-live-rest: the chain's own Rent sysvar, as an RPC serves it.
    let rent_key = fclient::rent::rent_sysvar();
    let rent_acc = r.c.account(&rent_key).expect("the chain's Rent sysvar");
    let rent = verify_core::input::RentRead::from_chain(&rent_acc.data, r.c.slot())
        .expect("a Rent sysvar");
    assert_eq!(rent.lamports_per_byte(), Some(lamports_per_byte));
    let a = r.a.clone();
    let _ = &a;
    // The archive: every program transaction, the post-states of program
    // accounts, and the final states of every account the program owned.
    let landed = r.c.feed(0, usize::MAX, Some(&program));
    let mut txs: Vec<fclient::ports::TxRecord> = landed.iter().map(|l| l.record()).collect();
    // What getTransaction serves beside them (`meta.preBalances` /
    // `postBalances`) and the ProgramData's upgrade authority: VG's input.
    let chain = verify_core::input::ChainWitness {
        balances: landed
            .iter()
            .map(|l| {
                (
                    l.signature.to_string(),
                    verify_core::input::Balances {
                        pre: l.pre_balances.clone(),
                        post: l.post_balances.clone(),
                    },
                )
            })
            .collect(),
        upgrade_authority: Some(upgrade.pubkey()),
        cross: None,
        rent: Some(rent),
        lookup_tables: None,
    };
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
            "verify/tests/playable_lane.rs record_playable_lane_natural: the devnet-playable .so (sha256 {}) in localnet::Chain (LiteSVM, in process) at {lamports_per_byte} lamports per byte, a real season by its own instructions at program version 0x4804, genesis on the shipped real quicknet round {round}; steps: {}",
            hex::encode(so_hash),
            r.log.join("; ")
        ),
        scenarios: vec!["playable-lane-natural".into()],
        history: Default::default(),
        resident_feed: None,
        program_so: None,
        declared: vec![],
        chain,
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
    // (D-verify-pr89-3) Its OpenProvince transactions are VX's now, and
    // this build's `.so` (ec511123…) is not committed: every other check
    // passes it, VX leaves exactly those UNVERIFIABLE. The same season of
    // the committed binary PASSes outright (`playable_genesis.rs`).
    let input = recorded();
    let rep = verify_core::verify(&input);
    assert_eq!(rep.verdict, Verdict::Unverifiable);
    assert!(
        common::only_open_province_unexecuted(&rep),
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
    // VR leaves the unknown account to the wide instruction (UNVERIFIABLE);
    // the forged post-state, on an account the transaction does not name,
    // is V0E's FAIL (D-verify-pr89-3).
    assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
    assert!(has(&rep, "V0E", "UnwritablePost"), "{:#?}", show(&rep));
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

// ------------------------------------------------------------ ⑭ R3 spawn

/// The recording's PlaceHome with a 10th account (the instruction's own
/// account at position `from`, a key the archive already holds).
fn place_home_with_witness(inp: &mut Input, from: usize) -> usize {
    let t = txs_with(inp, 0x38)[0];
    let mut tx = fclient::tx::from_wire(&inp.txs[t].tx).unwrap();
    let keys = tx.message.account_keys.clone();
    let ci = tx
        .message
        .instructions
        .iter_mut()
        .find(|c| {
            keys[c.program_id_index as usize] == inp.cfg.program && c.data.first() == Some(&0x38)
        })
        .unwrap();
    let k = ci.accounts[from];
    ci.accounts.push(k);
    inp.txs[t].tx = fclient::tx::wire(&tx);
    t
}

/// The recording's season with `spawn_reach` set in its CreateSeason.
fn with_spawn_reach(inp: &mut Input, reach: u8) {
    use frontier_abi::presets::SEASON_PARAMS_LEN;
    use frontier_abi::v2::presets::cq_layout;
    let t = txs_with(inp, 0x01)[0];
    verify_core::tamper::edit_ix_tag(inp, t, 0x01, |d| {
        d[1 + SEASON_PARAMS_LEN + cq_layout::SPAWN_REACH] = reach;
    });
}

fn home_mismatch(rep: &verify_core::Report) -> bool {
    has(rep, "V11", "HomePlacementMismatch")
        || rep
            .findings
            .iter()
            .any(|f| f.check == "V11" && f.detail.contains("first-home"))
}

/// ⑭ R3, ring rule (the recording's season, `spawn_reach` 0): a PlaceHome
/// naming a witness is one the program refuses, so a recorded success with
/// one is a FAIL.
#[test]
fn a_witness_under_the_ring_rule_fails() {
    let mut inp = recorded();
    place_home_with_witness(&mut inp, 5); // its own Province
    let rep = verify_core::verify(&inp);
    assert_ne!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
    assert!(home_mismatch(&rep), "{:#?}", show(&rep));
}

/// ⑭ R3, hull rule (`spawn_reach` 2): the same witness (a Province of the
/// season at its own PDA) is accepted by V11; a witness that is not the
/// Province PDA of its stored (P, Q) is not.
#[test]
fn a_witness_under_the_hull_rule_is_judged_by_its_pda() {
    let mut inp = recorded();
    with_spawn_reach(&mut inp, 2);
    place_home_with_witness(&mut inp, 5);
    let rep = verify_core::verify(&inp);
    assert!(!home_mismatch(&rep), "{:#?}", show(&rep));
    let mut inp = recorded();
    with_spawn_reach(&mut inp, 2);
    place_home_with_witness(&mut inp, 4); // the Frontier: not a Province
    let rep = verify_core::verify(&inp);
    assert_ne!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
}

// ------------------------------------------- VG over a live local node

/// The natural season served by the local node's JSON-RPC
/// (`localnet::server`, 127.0.0.1:41510 by default, `VG_LIVE_PORT`) and read
/// the way a PUBLIC RPC is read: `getSignaturesForAddress` +
/// `getTransaction` (findex `RpcPoll`, no post-states), the finals by
/// `getMultipleAccounts`, and `--balances`' witness (`input::fetch_chain`).
/// With the committed pinned `.so`, VG re-executes it from the Season's
/// creation: no FAIL, every check judged, and the only thing that keeps it
/// from a PASS is ⑲'s rule that a public-RPC history is unproven.
/// Ignored: it signs with the recorder's fixed test keypairs and binds a
/// local port (CI's key-free rule); run with `--ignored`.
#[test]
#[ignore = "binds 127.0.0.1:41510-41511 (VG_LIVE_PORT) and signs the recorder's test transactions; run with --ignored"]
fn a_live_local_node_read_as_public_rpc_is_re_executed_from_genesis() {
    live_genesis_replay(localnet::chain::LAMPORTS_PER_BYTE, "VG_LIVE_PORT", 41_510);
}

/// rent-live-rest: the same over a live node charging 6,960 lamports per
/// byte — the verifier reads the node's Rent sysvar with the final states
/// and re-executes under it; under the assumed 5,080 the same read FAILs.
#[test]
#[ignore = "binds 127.0.0.1:41512-41513 (VG_RENT_LIVE_PORT) and signs the recorder's test transactions; run with --ignored"]
fn a_live_6960_node_is_re_executed_under_its_own_rent_sysvar() {
    live_genesis_replay(6_960, "VG_RENT_LIVE_PORT", 41_512);
}

fn live_genesis_replay(lamports_per_byte: u64, port_var: &str, default_port: u16) {
    let so = verify_core::reexec::Program::load(
        &common::fixtures_dir().join("devnet-playable-da3dc1aa.so.gz"),
    )
    .expect("the committed .so");
    let (r, program, upgrade, _) = build_natural_at(&so.so, lamports_per_byte);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let state = std::sync::Arc::new(std::sync::Mutex::new(r.c));
    // (the run's port range 41500–41549; `VG_LIVE_PORT` / `VG_RENT_LIVE_PORT` to move it)
    let port: u16 = std::env::var(port_var)
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(default_port);
    let node = rt
        .block_on(localnet::server::start(state, port))
        .expect("the port free");
    let url = node.url();
    let (txs, history) = rt
        .block_on(verify_core::input::fetch_txs(
            &url, &program, false, None, None,
        ))
        .expect("the program's history");
    assert!(
        txs.iter().all(|t| t.post.is_empty()),
        "an RPC read has no post-states"
    );
    let keys = verify_core::input::written_keys(&txs);
    let (finals, final_slot) = rt
        .block_on(verify_core::input::fetch_finals(&url, &keys))
        .expect("finals");
    let mut chain = rt
        .block_on(verify_core::input::fetch_chain(&url, &program, &txs))
        .expect("balances");
    assert_eq!(chain.upgrade_authority, Some(upgrade.pubkey()));
    assert_eq!(chain.balances.len(), txs.len());
    // rent-live-rest: the node's Rent sysvar, read at the final states' slot (as frontier-verify --rpc does)
    let rent = rt
        .block_on(verify_core::input::fetch_rent(&url, final_slot))
        .expect("the node's Rent sysvar");
    assert!(!rent.declared);
    assert_eq!(rent.lamports_per_byte(), Some(lamports_per_byte));
    chain.rent = Some(rent);
    let (_, h) = rt
        .block_on(verify_core::input::program_hash(&url, &program))
        .expect("the deployed hash");
    node.stop();
    let mut input = Input {
        cfg: Config {
            program,
            season_id: SEASON_ID,
            quicknet_pk: fb::quicknet_info().public_key,
            ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
            program_hash: Some(so.sha256()),
        },
        txs,
        finals,
        final_slot,
        program_hashes: vec![(0, h)],
        provenance: format!("live local node {url}, read as public RPC"),
        scenarios: vec![],
        history,
        resident_feed: None,
        program_so: None,
        declared: vec![],
        chain,
    };
    let show = |rep: &verify_core::Report| {
        rep.findings
            .iter()
            .map(|f| format!("{:?} {} {} {}", f.severity, f.check, f.code, f.detail))
            .collect::<Vec<_>>()
    };
    // Without the pinned binary: never PASS (the old state of such a read).
    let before = verify_core::verify(&input);
    assert_ne!(before.verdict, Verdict::Pass);
    input.program_so = Some(std::sync::Arc::new(so.so.as_ref().clone()));
    let rep = verify_core::verify(&input);
    for l in show(&rep) {
        println!("{l}");
    }
    println!(
        "verdict {:?} (without the .so: {:?})",
        rep.verdict, before.verdict
    );
    assert!(rep.checks_run.contains(&"VG:genesis-replay"));
    assert!(!rep.findings.iter().any(|f| f.fail()), "{:#?}", show(&rep));
    let open: Vec<_> = rep
        .findings
        .iter()
        .filter(|f| f.severity == verify_core::Severity::Unverifiable)
        .collect();
    assert!(
        open.iter()
            .all(|f| f.code == verify_core::codes::HISTORY_UNPROVEN),
        "{:#?}",
        show(&rep)
    );
    assert_eq!(rep.verdict, Verdict::Unverifiable);
    assert_eq!(rep.rent.as_ref().unwrap()["source"], "chain");
    assert_eq!(
        rep.rent.as_ref().unwrap()["lamports_per_byte"],
        lamports_per_byte
    );
    // The same archive as a fixture whose history the recorder vouches for: PASS.
    input.history = Default::default();
    let rep = verify_core::verify(&input);
    assert_eq!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
    // Without the node's rent the re-execution assumes 5,080: exact only on a 5,080 node.
    input.chain.rent = None;
    let rep = verify_core::verify(&input);
    assert_eq!(rep.rent.as_ref().unwrap()["source"], "assumed");
    if lamports_per_byte == localnet::chain::LAMPORTS_PER_BYTE {
        assert_eq!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
    } else {
        assert_eq!(rep.verdict, Verdict::Fail, "{:#?}", show(&rep));
        assert!(rep
            .findings
            .iter()
            .any(|f| f.code == verify_core::codes::RENT_ASSUMED));
    }
}

// ------------------------------------------- VS over two live local nodes

/// What a lying RPC proxy changes in the honest node's answers
/// (verifier-witness: the primary that serves a consistent false season).
#[derive(Clone, Default)]
struct Lie {
    /// Hidden everywhere: the signature list, `getTransaction`, `getBlock`.
    drop: Option<String>,
    /// A signed transaction that never landed, served as landed at `slot`
    /// (listed, served by `getTransaction`, in its slot's block).
    inject: Option<(String, u64, serde_json::Value)>,
    /// Its `meta.computeUnitsConsumed` served one higher.
    units_of: Option<String>,
    /// This account's data served with one byte flipped.
    flip_final: Option<String>,
}

impl Lie {
    fn apply(&self, method: &str, params: &serde_json::Value, v: &mut serde_json::Value) {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        match method {
            "getSignaturesForAddress" => {
                let Some(a) = v.as_array_mut() else { return };
                if let Some(d) = &self.drop {
                    a.retain(|x| x["signature"].as_str() != Some(d));
                }
                if let Some((s, slot, _)) = &self.inject {
                    if params
                        .get(1)
                        .and_then(|c| c.get("before"))
                        .is_none_or(|b| b.is_null())
                    {
                        let at = a
                            .iter()
                            .position(|x| x["slot"].as_u64().unwrap_or(0) < *slot)
                            .unwrap_or(a.len());
                        a.insert(
                            at,
                            serde_json::json!({"signature": s, "slot": slot,
                            "err": {"InstructionError": [0, {"Custom": 1}]}, "memo": null,
                            "blockTime": null, "confirmationStatus": "finalized"}),
                        );
                    }
                }
            }
            "getTransaction" => {
                let s = params[0].as_str().unwrap_or("");
                if self.drop.as_deref() == Some(s) {
                    *v = serde_json::Value::Null;
                }
                if let Some((i, _, t)) = &self.inject {
                    if i == s {
                        *v = t.clone();
                    }
                }
                if self.units_of.as_deref() == Some(s) {
                    let u = v["meta"]["computeUnitsConsumed"].as_u64().unwrap_or(0);
                    v["meta"]["computeUnitsConsumed"] = serde_json::json!(u + 1);
                }
            }
            "getBlock" => {
                let Some(sigs) = v.get_mut("signatures").and_then(|x| x.as_array_mut()) else {
                    return;
                };
                if let Some(d) = &self.drop {
                    sigs.retain(|x| x.as_str() != Some(d));
                }
                if let Some((s, slot, _)) = &self.inject {
                    if params[0].as_u64() == Some(*slot) {
                        sigs.push(serde_json::json!(s));
                    }
                }
            }
            "getMultipleAccounts" => {
                let Some(k) = &self.flip_final else { return };
                let Some(i) = params[0]
                    .as_array()
                    .and_then(|a| a.iter().position(|x| x.as_str() == Some(k)))
                else {
                    return;
                };
                let d = &mut v["value"][i]["data"][0];
                if let Some(mut bytes) = d.as_str().and_then(|x| b64.decode(x).ok()) {
                    if let Some(b) = bytes.get_mut(150) {
                        *b ^= 1;
                    }
                    *d = serde_json::json!(b64.encode(&bytes));
                }
            }
            _ => {}
        }
    }
}

/// A JSON-RPC proxy on `port` that forwards to `upstream` and lies by `lie`.
async fn lying_proxy(
    upstream: String,
    lie: Lie,
    port: u16,
) -> (String, tokio::task::JoinHandle<()>) {
    use axum::{extract::State, routing::post, Json, Router};
    type S = std::sync::Arc<(fclient::rpc::RpcClient, Lie)>;
    async fn handle(
        State(s): State<S>,
        Json(req): Json<serde_json::Value>,
    ) -> Json<serde_json::Value> {
        let id = req["id"].clone();
        let method = req["method"].as_str().unwrap_or("").to_string();
        let params = req.get("params").cloned().unwrap_or(serde_json::json!([]));
        Json(match s.0.call(&method, params.clone()).await {
            Ok(mut v) => {
                s.1.apply(&method, &params, &mut v);
                serde_json::json!({"jsonrpc": "2.0", "id": id, "result": v})
            }
            Err(fclient::ports::PortError::Rpc { code, message }) => {
                serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
            }
            Err(e) => {
                serde_json::json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": e.to_string()}})
            }
        })
    }
    let state: S = std::sync::Arc::new((fclient::rpc::RpcClient::new(upstream), lie));
    let app = Router::new().route("/", post(handle)).with_state(state);
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("the proxy port free");
    let h = tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
    });
    (format!("http://127.0.0.1:{port}"), h)
}

/// The season read from `primary` the way `frontier-verify --rpc P
/// --balances --witness W…` reads it (no G3 witness for the pull when
/// `g3` is false, so that VS itself, not findex, meets a dropped range).
async fn read_witnessed(
    primary: &str,
    witnesses: &[String],
    program: &Address,
    so: &verify_core::reexec::Program,
    g3: bool,
) -> Result<Input, String> {
    use verify_core::input as vi;
    let (txs, history) = vi::fetch_txs(
        primary,
        program,
        false,
        None,
        if g3 {
            witnesses.first().map(String::as_str)
        } else {
            None
        },
    )
    .await?;
    let mut keys = vi::written_keys(&txs);
    for k in vi::program_accounts(primary, program, SEASON_ID).await? {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let (finals, final_slot) = vi::fetch_finals(primary, &keys).await?;
    let mut chain = vi::fetch_chain(primary, program, &txs).await?;
    let (_, h) = vi::program_hash(primary, program).await?;
    chain.cross = Some(
        verify_core::witness::cross_check(
            primary, witnesses, program, SEASON_ID, &txs, &keys, final_slot,
        )
        .await,
    );
    Ok(Input {
        cfg: Config {
            program: *program,
            season_id: SEASON_ID,
            quicknet_pk: fb::quicknet_info().public_key,
            ruleset_hash: frontier_abi::v2::presets::RULESET_HASH_V3,
            program_hash: Some(so.sha256()),
        },
        txs,
        finals,
        final_slot,
        program_hashes: vec![(0, h)],
        provenance: format!(
            "live local node {primary}, read as public RPC, witnesses {witnesses:?}"
        ),
        scenarios: vec![],
        history,
        resident_feed: None,
        program_so: Some(std::sync::Arc::new(so.so.as_ref().clone())),
        declared: vec![],
        chain,
    })
}

/// ⑰ Q-P1 = (a)+(b) over HTTP: the natural season on one in-process chain,
/// served by two JSON-RPC servers (the primary and an independent-looking
/// witness), and by lying proxies in front of the primary. Ports
/// 41520–41527 (`VS_LIVE_PORT` moves the base); 41549 is the witness that
/// does not answer. Ignored: it signs with the recorder's fixed test
/// keypairs and binds local ports (CI's key-free rule); run with
/// `--ignored`. Each case prints its verdict and VS's findings.
#[test]
#[ignore = "binds 127.0.0.1:41520-41527 (VS_LIVE_PORT) and signs the recorder's test transactions; run with --ignored"]
fn a_live_two_node_season_is_judged_with_a_witness() {
    use verify_core::codes as c;
    let so = verify_core::reexec::Program::load(
        &common::fixtures_dir().join("devnet-playable-da3dc1aa.so.gz"),
    )
    .expect("the committed .so");
    let (r, program, upgrade, _) = build_natural(&so.so);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let base: u16 = std::env::var("VS_LIVE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(41_520);
    let state = std::sync::Arc::new(std::sync::Mutex::new(r.c));
    let primary = rt
        .block_on(localnet::server::start(state.clone(), base))
        .expect("the port free");
    let witness = rt
        .block_on(localnet::server::start(state.clone(), base + 2))
        .expect("the port free");
    let (p, w) = (primary.url(), witness.url());
    let show = |rep: &verify_core::Report| {
        rep.findings
            .iter()
            .filter(|f| f.severity != verify_core::Severity::Warn)
            .map(|f| {
                format!(
                    "{:?} {} {} {} {}",
                    f.severity,
                    f.check,
                    f.code,
                    f.entity,
                    f.detail.chars().take(240).collect::<String>()
                )
            })
            .collect::<Vec<_>>()
    };
    let judge = |name: &str, inp: &Input| -> verify_core::Report {
        let rep = verify_core::verify(inp);
        println!(
            "== {name}: verdict {:?}, basis {}",
            rep.verdict,
            rep.history
                .as_ref()
                .map_or("-".into(), |h| h["basis"].to_string())
        );
        for l in show(&rep) {
            println!("   {l}");
        }
        rep
    };
    let has = |rep: &verify_core::Report, code: &str| rep.findings.iter().any(|f| f.code == code);

    // 1. honest primary, honest witness: PASS, basis witnessed.
    let inp = rt
        .block_on(read_witnessed(
            &p,
            std::slice::from_ref(&w),
            &program,
            &so,
            true,
        ))
        .expect("read");
    assert_eq!(inp.chain.upgrade_authority, Some(upgrade.pubkey()));
    let cross = inp.chain.cross.as_ref().unwrap();
    assert!(
        cross.witnesses[0].errors.is_empty(),
        "{:?}",
        cross.witnesses[0].errors
    );
    assert!(
        cross.witnesses[0].blocks.values().all(|b| b.is_some()),
        "getBlock served"
    );
    let rep = judge("honest primary + honest witness", &inp);
    assert_eq!(rep.verdict, Verdict::Pass, "{:#?}", show(&rep));
    assert_eq!(rep.history.as_ref().unwrap()["basis"], "witnessed");
    // the same without a witness: ⑲'s unproven
    let mut alone = inp.clone();
    alone.chain.cross = None;
    let rep = judge("honest primary, no witness", &alone);
    assert_eq!(rep.verdict, Verdict::Unverifiable);

    let failed: Vec<(String, u64)> = inp
        .txs
        .iter()
        .filter(|t| t.err.is_some())
        .map(|t| (t.signature.to_string(), t.slot))
        .collect();
    let (drop_sig, drop_slot) = failed.last().cloned().expect("a failed transaction");
    let program_account = inp
        .finals
        .iter()
        .find(|(_, a)| {
            a.as_ref()
                .is_some_and(|a| a.owner == program && a.data.len() > 200)
        })
        .map(|(k, _)| Address::new_from_array(*k).to_string())
        .unwrap();
    // A signed transaction that never landed: the season's payer key over
    // an instruction the program refuses, served as a failure at the slot
    // of a real one (a consistent liar: listed, served, in the block).
    let payer = Keypair::new_from_array([0xA2; 32]);
    let fake = tx::build(
        &[Instruction::new_with_bytes(
            program,
            &[0xff, 0xee],
            vec![AccountMeta::new(payer.pubkey(), true)],
        )],
        &budget(),
        &[&payer],
        &fclient::Hash::new_from_array([9; 32]),
    )
    .unwrap();
    let fake_sig = tx::signature(&fake).to_string();
    let template = rt
        .block_on(fclient::rpc::RpcClient::new(p.clone()).call(
            "getTransaction",
            serde_json::json!([drop_sig, {"encoding": "base64", "commitment": "finalized"}]),
        ))
        .unwrap();
    let mut injected = template.clone();
    {
        use base64::Engine as _;
        injected["transaction"] = serde_json::json!([
            base64::engine::general_purpose::STANDARD.encode(tx::wire(&fake)),
            "base64"
        ]);
        let n = fake.message.account_keys.len();
        let pre = template["meta"]["preBalances"][0]
            .as_u64()
            .unwrap_or(10_000_000);
        let fee = template["meta"]["fee"].as_u64().unwrap_or(5_000);
        let mut pre_v = vec![1u64; n];
        pre_v[0] = pre;
        let mut post_v = pre_v.clone();
        post_v[0] = pre - fee;
        injected["meta"]["preBalances"] = serde_json::json!(pre_v);
        injected["meta"]["postBalances"] = serde_json::json!(post_v);
        injected["meta"]["logMessages"] = serde_json::json!([
            format!("Program {program} invoke [1]"),
            format!("Program {program} failed: custom program error: 0x1")
        ]);
    }

    let cases: Vec<(&str, Lie, bool, &[&str])> = vec![
        (
            "lying primary drops a failed tx (findex G3 off)",
            Lie {
                drop: Some(drop_sig.clone()),
                ..Lie::default()
            },
            false,
            &[c::WITNESS_MISSING_TX],
        ),
        (
            "lying primary injects a never-landed signed tx",
            Lie {
                inject: Some((fake_sig.clone(), drop_slot, injected.clone())),
                ..Lie::default()
            },
            true,
            &[c::WITNESS_UNKNOWN_TX, c::WITNESS_MISMATCH],
        ),
        (
            "lying primary alters a tx's meta (units)",
            Lie {
                units_of: Some(drop_sig.clone()),
                ..Lie::default()
            },
            true,
            &[c::WITNESS_MISMATCH],
        ),
        (
            "lying primary alters a program account's final",
            Lie {
                flip_final: Some(program_account.clone()),
                ..Lie::default()
            },
            true,
            &[c::WITNESS_MISMATCH],
        ),
    ];
    for (k, (name, lie, g3, want)) in cases.into_iter().enumerate() {
        let (lp, h) = rt.block_on(lying_proxy(p.clone(), lie, base + 4 + k as u16));
        let inp = rt
            .block_on(read_witnessed(
                &lp,
                std::slice::from_ref(&w),
                &program,
                &so,
                g3,
            ))
            .expect("read");
        let rep = judge(name, &inp);
        h.abort();
        assert_ne!(rep.verdict, Verdict::Pass, "{name}");
        for code in want {
            assert!(has(&rep, code), "{name}: want {code}: {:#?}", show(&rep));
        }
        assert_eq!(rep.history.as_ref().unwrap()["basis"], "unproven", "{name}");
    }
    // The dropped tx with findex's G3 witness on: the pull itself stops at
    // the gap (frontier-verify exits 2, nothing verified).
    let (lp, h) = rt.block_on(lying_proxy(
        p.clone(),
        Lie {
            drop: Some(drop_sig.clone()),
            ..Lie::default()
        },
        base + 4,
    ));
    let got = rt.block_on(read_witnessed(
        &lp,
        std::slice::from_ref(&w),
        &program,
        &so,
        true,
    ));
    h.abort();
    println!(
        "== lying primary drops a failed tx (G3 on): {:?}",
        got.as_ref().err()
    );
    assert!(
        got.as_ref().is_err_and(|e| e.contains("history gap")),
        "{:?}",
        got.err()
    );

    // 3. the witness missing: nothing listens on 41549.
    let inp = rt
        .block_on(read_witnessed(
            &p,
            &["http://127.0.0.1:41549".to_string()],
            &program,
            &so,
            false,
        ))
        .expect("read");
    let rep = judge("honest primary, witness unreachable", &inp);
    assert_eq!(rep.verdict, Verdict::Unverifiable);
    assert!(has(&rep, c::WITNESS_UNAVAILABLE));

    // 4. both lying identically (two proxies, one lie): the stated residual.
    let lie = Lie {
        drop: Some(drop_sig.clone()),
        ..Lie::default()
    };
    let (lp, h1) = rt.block_on(lying_proxy(p.clone(), lie.clone(), base + 4));
    let (lw, h2) = rt.block_on(lying_proxy(w.clone(), lie, base + 5));
    let inp = rt
        .block_on(read_witnessed(&lp, &[lw], &program, &so, true))
        .expect("read");
    let rep = judge("primary and witness lying identically (the residual)", &inp);
    h1.abort();
    h2.abort();
    primary.stop();
    witness.stop();
    assert_eq!(
        rep.verdict,
        Verdict::Pass,
        "the residual: {:#?}",
        show(&rep)
    );
}
