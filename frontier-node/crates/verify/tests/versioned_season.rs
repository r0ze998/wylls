//! verifier-v0v1: a season whose players send **v0** (address lookup
//! tables) and **v1** (SIMD-0385) transactions, re-verified offline.
//!
//! * `record_versioned_season` (ignored: it signs with fixed TEST keys, CI's
//!   key-free rule): a REAL season of the committed devnet `.so`
//!   (`devnet-playable-67a33c92.so.gz`, the P14 b devnet build) in the
//!   in-process LiteSVM chain (`localnet::Chain`, which takes v0/v1 since
//!   #154), built like `playable_lane.rs`'s natural season, but with the
//!   map crank's OpenProvince sent as **v0** through one lookup table, the
//!   player's Join as **v1**, PlaceHome / Harvest / Muster as **v0** through
//!   a second table (a Harvest through both tables at once), two Builds and a
//!   FoldLand as **v1**, the rest legacy. Lookup tables are created and
//!   extended by the real address-lookup-table program. It saves the
//!   archive (post-states, `meta.loadedAddresses` as `loaded`, balances,
//!   Rent sysvar, and the lookup table accounts read at the final slot) to
//!   `VERSIONED_DUMP` when set.
//! * Every other test reads the committed recording
//!   (`fixtures/verify/playable-versioned-67a33c92.json.gz`) and signs
//!   nothing.
//!
//! Re-record: `VERSIONED_DUMP=$PWD/../../fixtures/verify/playable-versioned-67a33c92.json.gz \
//!  cargo test -p verify --features playable-lane --test versioned_season -- --ignored --nocapture`
#![cfg(feature = "playable-lane")]

mod common;

use fclient::addr::Addresses;
use fclient::beacon::{self as fb, FixtureDrand};
use fclient::vtx::{self, Version, VersionedTransaction};
use fclient::{ix, tx, AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::v2::presets::{params_hash_v2, ConquestParams, SeasonParamsV2, S1_LOCAL_7D};
use permutation_rules::frontier::beacon::{
    genesis_seed_round, genesis_ts as beacon_genesis_ts, round_time, BeaconClock,
};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use solana_message::{v0, v1, AddressLookupTableAccount, VersionedMessage};
use verify_core::input::{Config, Input, LookupTables};
use verify_core::{Report, Severity, Verdict};

const SEASON_ID: u64 = 9;
const PROGRAM_VERSION: u16 = 0x4804;
const SO_GZ: &str = "devnet-playable-67a33c92.so.gz";
const SO_SHA256: &str = "67a33c9231560fe95280d00d56b02dc778213c83030e403e3d853ebb651206b3";
const FIXTURE: &str = "playable-versioned-67a33c92.json.gz";

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    assert_eq!(hex::encode(p.sha256()), SO_SHA256);
    std::sync::Arc::new(p.so.as_ref().clone())
}

// ------------------------------------------------------------ recorder

#[derive(Clone, Copy)]
enum How {
    Legacy,
    /// v0 through these of the recorder's tables (indexes into `Rec::tables`).
    V0(&'static [usize]),
    V1,
}

struct Rec {
    c: localnet::Chain,
    a: Addresses,
    log: Vec<String>,
    tables: Vec<AddressLookupTableAccount>,
}

const CU: u32 = 1_400_000;

impl Rec {
    fn wire(&self, how: How, signers: &[&Keypair], ixs: &[Instruction]) -> Vec<u8> {
        let (bh, _) = self.c.latest_blockhash();
        let payer = signers[0].pubkey();
        let budget = [
            tx::set_compute_unit_limit(CU),
            tx::set_loaded_accounts_data_size_limit(fclient::fees::RUNTIME_MAX_LOADED),
        ];
        let with_budget: Vec<Instruction> = budget.iter().chain(ixs).cloned().collect();
        match how {
            How::Legacy => {
                let t = tx::build(
                    ixs,
                    &tx::TxBudget {
                        cu_limit: CU,
                        cu_price: 0,
                        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
                        heap: None,
                    },
                    signers,
                    &bh,
                )
                .expect("build");
                tx::wire(&t)
            }
            How::V0(which) => {
                let tables: Vec<AddressLookupTableAccount> =
                    which.iter().map(|&i| self.tables[i].clone()).collect();
                let m = v0::Message::try_compile(&payer, &with_budget, &tables, bh)
                    .expect("v0 compile");
                assert!(
                    !m.address_table_lookups.is_empty(),
                    "a v0 send looks something up"
                );
                let t = VersionedTransaction::try_new(VersionedMessage::V0(m), signers)
                    .expect("sign v0");
                vtx::wire(&t).expect("v0 wire")
            }
            How::V1 => {
                // SIMD-0385: an absent limit is 0, so both are stated.
                let m = v1::Message::try_compile_with_config(
                    &payer,
                    ixs,
                    bh,
                    v1::TransactionConfig {
                        compute_unit_limit: Some(CU),
                        loaded_accounts_data_size_limit: Some(fclient::fees::RUNTIME_MAX_LOADED),
                        ..v1::TransactionConfig::empty()
                    },
                )
                .expect("v1 compile");
                let t = VersionedTransaction::try_new(VersionedMessage::V1(m), signers)
                    .expect("sign v1");
                vtx::wire(&t).expect("v1 wire")
            }
        }
    }
    fn try_send_as(
        &mut self,
        how: How,
        signers: &[&Keypair],
        ixs: &[Instruction],
        what: &str,
    ) -> bool {
        let w = self.wire(how, signers, ixs);
        let v = vtx::decode(&w).expect("decodes").version;
        let sig = match self.c.submit(&w) {
            Ok(s) => s,
            Err(e) => {
                self.log
                    .push(format!("{what} ({v:?}): refused before landing: {e}"));
                return false;
            }
        };
        self.c.produce_block();
        let l = self.c.transaction(&sig).cloned().expect("landed");
        let ok = l.err.is_none();
        self.log.push(format!(
            "{what} ({v:?}{}): {}",
            if l.loaded.writable.is_empty() && l.loaded.readonly.is_empty() {
                String::new()
            } else {
                format!(
                    ", {}+{} looked up",
                    l.loaded.writable.len(),
                    l.loaded.readonly.len()
                )
            },
            if ok {
                "ok".to_string()
            } else {
                format!("failed {:?} code {:?}", l.err, l.code)
            }
        ));
        ok
    }
    fn send_as(&mut self, how: How, signers: &[&Keypair], ixs: &[Instruction], what: &str) {
        assert!(self.try_send_as(how, signers, ixs, what), "{:#?}", self.log);
    }
    fn send(&mut self, signers: &[&Keypair], ixs: &[Instruction], what: &str) {
        self.send_as(How::Legacy, signers, ixs, what)
    }
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
    /// A lookup table holding `addrs` (deduplicated), created and extended
    /// by the real program (legacy transactions; they do not name the game
    /// program, so the season's archive does not hold them).
    fn make_table(&mut self, owner: &Keypair, addrs: Vec<Address>) -> usize {
        let mut list: Vec<Address> = vec![];
        for a in addrs {
            if !list.contains(&a) {
                list.push(a);
            }
        }
        assert!(list.len() <= 256);
        let recent = self.c.slot() - 1;
        let (table, create) =
            localnet::chain::lookup_table_create(&owner.pubkey(), &owner.pubkey(), recent);
        self.send(&[owner], &[create], "CreateLookupTable");
        for chunk in list.chunks(20) {
            let ext = localnet::chain::lookup_table_extend(
                &table,
                &owner.pubkey(),
                &owner.pubkey(),
                chunk,
            );
            self.send(&[owner], &[ext], "ExtendLookupTable");
        }
        // (addresses extended in the current slot are not usable yet)
        self.c.produce_block();
        self.c.produce_block();
        let acc = self.c.svm.get_account(&table).expect("the table");
        let idx: Vec<u8> = (0..list.len() as u16).map(|i| i as u8).collect();
        assert_eq!(
            localnet::chain::lookup_table_addresses(&acc, &idx).expect("a table"),
            list
        );
        self.tables.push(AddressLookupTableAccount {
            key: table,
            addresses: list,
        });
        self.tables.len() - 1
    }
}

fn params() -> SeasonParamsV2 {
    let mut p = S1_LOCAL_7D;
    p.base.program_version = PROGRAM_VERSION;
    p
}

fn non_signers(ixs: &[Instruction]) -> Vec<Address> {
    ixs.iter()
        .flat_map(|i| i.accounts.iter().filter(|m| !m.is_signer).map(|m| m.pubkey))
        .collect()
}

fn land_address(a: &Addresses, p: i16, q: i16) -> Address {
    let ctx = frontier_abi::addr::AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    };
    Address::new_from_array(frontier_abi::land_preview::land_address(&ctx, p, q))
}

/// The land lane's FoldLand (as `playable_lane.rs`).
fn fold_ix(a: &Addresses, payer: &Address, p: i16, q: i16, max_bells: u8) -> Instruction {
    use frontier_abi::land_preview as fl;
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

/// The land lane's ClaimLandYield (as `playable_lane.rs`).
fn claim_ix(a: &Addresses, payer: &Address, p: i16, q: i16, site: u8) -> Instruction {
    use frontier_abi::land_preview as fl;
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

fn build_versioned(so: &[u8]) -> (Rec, Address, Keypair, u64) {
    assert_eq!(localnet::bls_and_sbpf_v2_active(), (true, true));
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
        so,
        fclient::fees::deploy_max_len(so.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )
    .expect("deploy");
    c.airdrop(&upgrade.pubkey(), 500_000_000_000).unwrap();
    c.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    c.airdrop(&wallet.pubkey(), 20_000_000_000).unwrap();
    c.produce_block();
    let mut r = Rec {
        c,
        a,
        log: vec![],
        tables: vec![],
    };
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
    // One home province per nation (pure: the seed decides).
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
                        continue;
                    }
                    homes.push((pp as i16, qq as i16, n));
                }
            }
        }
    }
    // Table 0: the map crank's (every OpenProvince's accounts).
    let opens: Vec<Instruction> = homes
        .iter()
        .map(|&(pp, qq, _)| ix::open_province(&a, payer.pubkey(), pp, qq))
        .collect();
    r.make_table(&payer, non_signers(&opens));
    for (n, o) in opens.iter().enumerate() {
        r.send_as(
            How::V0(&[0]),
            &[&payer],
            std::slice::from_ref(o),
            &format!("OpenProvince {n}"),
        );
    }

    // The player: Join as v1.
    let (hp, hq, faction) = homes[0];
    let now = r.c.unix_timestamp();
    r.send_as(
        How::V1,
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
    let province = a.province(hp.into(), hq.into());
    let with_province = |mut i: Instruction, writable: bool| {
        if !i.accounts.iter().any(|m| m.pubkey == province) {
            i.accounts.push(if writable {
                AccountMeta::new(province, false)
            } else {
                AccountMeta::new_readonly(province, false)
            });
        }
        i
    };
    // Table 1: the player's (every site's PlaceHome, Harvest and Muster accounts).
    let sites = frontier_abi::v2::layout::province::province::SITES_N as u8;
    let mut player_accounts = vec![];
    for site in 0..sites {
        let s = ix::Site { p: hp, q: hq, site };
        let h = ix::HoldingRef { p: hp, q: hq, site };
        player_accounts.extend(non_signers(&[
            ix::place_home(&a, &player, s, faction, shard),
            with_province(ix::harvest(&a, &player, h), false),
            ix::muster(&a, &player, h, 0, 5, 0),
        ]));
    }
    r.make_table(&wallet, player_accounts);

    let mut home = None;
    for site in 0..sites {
        let s = ix::Site { p: hp, q: hq, site };
        if r.try_send_as(
            How::V0(&[1]),
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

    let t = r.c.unix_timestamp();
    r.advance_to(t + 300);
    r.try_send_as(
        How::V0(&[1]),
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest",
    );
    for item in 0..4u8 {
        r.try_send_as(
            if item < 2 { How::V1 } else { How::Legacy },
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
    r.try_send_as(
        How::V0(&[0, 1]),
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest (two tables)",
    );
    for unit in 0..2u8 {
        r.try_send_as(
            How::Legacy,
            &[&wallet],
            &[with_province(ix::train(&a, &player, h, unit, 10), false)],
            &format!("Train {unit}"),
        );
    }
    let tile = r
        .data(&a.holding(hp.into(), hq.into(), site))
        .expect("holding")[frontier_abi::v2::layout::player::holding::TILE];
    let t = r.c.unix_timestamp();
    r.advance_to(t + 3 * 3_600);
    r.try_send_as(
        How::V0(&[1]),
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest (trained)",
    );
    for unit in 0..2u8 {
        r.try_send_as(
            How::V0(&[1]),
            &[&wallet],
            &[ix::muster(&a, &player, h, unit, 5, tile)],
            &format!("Muster {unit}"),
        );
    }
    r.try_send_as(
        How::Legacy,
        &[&payer],
        &[fold_ix(&a, &payer.pubkey(), hp, hq, 8)],
        "FoldLand",
    );
    r.try_send_as(
        How::Legacy,
        &[&payer],
        &[claim_ix(&a, &payer.pubkey(), hp, hq, site)],
        "ClaimLandYield",
    );
    let t = r.c.unix_timestamp();
    r.advance_to(t + 120);
    r.try_send_as(
        How::V1,
        &[&payer],
        &[fold_ix(&a, &payer.pubkey(), hp, hq, 8)],
        "FoldLand again",
    );
    r.try_send_as(
        How::V0(&[1]),
        &[&wallet],
        &[with_province(ix::harvest(&a, &player, h), false)],
        "Harvest after the claim",
    );
    (r, program, upgrade, round)
}

#[test]
#[ignore = "signs the recorder's TEST transactions (CI key-free rule); writes VERSIONED_DUMP when set"]
fn record_versioned_season() {
    let so = so();
    let so_hash = common::sha2_256(&so);
    let (r, program, upgrade, round) = build_versioned(&so);
    let rent_acc =
        r.c.account(&fclient::rent::rent_sysvar())
            .expect("Rent sysvar");
    let rent = verify_core::input::RentRead::from_chain(&rent_acc.data, r.c.slot()).expect("rent");
    let landed = r.c.feed(0, usize::MAX, Some(&program));
    let mut txs: Vec<fclient::ports::TxRecord> = landed.iter().map(|l| l.record()).collect();
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
        // The lookup tables as read with the final states.
        lookup_tables: Some(LookupTables {
            slot: Some(r.c.slot()),
            accounts: r
                .tables
                .iter()
                .map(|t| (t.key.to_bytes(), r.c.account(&t.key)))
                .collect(),
        }),
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
        .map(|k| (k.to_bytes(), r.c.account(&k)))
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
            "verify/tests/versioned_season.rs record_versioned_season: the devnet .so (sha256 {}) in localnet::Chain (LiteSVM, in process), a real season by its own instructions at program version 0x4804 with v0 (lookup tables) and v1 transactions, genesis on the shipped real quicknet round {round}; steps: {}",
            hex::encode(so_hash),
            r.log.join("; ")
        ),
        scenarios: vec!["playable-versioned".into()],
        history: Default::default(),
        resident_feed: None,
        program_so: None,
        declared: vec![],
        chain,
    };
    for l in &r.log {
        println!("{l}");
    }
    let mut with_so = input.clone();
    with_so.program_so = Some(so.clone());
    let rep = verify_core::verify(&with_so);
    println!("{}", show(&rep).join("\n"));
    println!("verdict {:?} checks {:?}", rep.verdict, rep.checks_run);
    if let Ok(out) = std::env::var("VERSIONED_DUMP") {
        input.save(std::path::Path::new(&out)).expect("save");
        println!("saved {out}");
    }
}

// ------------------------------------------------------------ the recording

fn recorded() -> Input {
    let mut i = common::fixture(FIXTURE);
    i.program_so = Some(so());
    i
}

/// As a public RPC serves it: no post-states (VG re-executes from genesis).
fn rpc_shaped() -> Input {
    let mut i = recorded();
    for t in i.txs.iter_mut() {
        t.post.clear();
    }
    i
}

fn show(r: &Report) -> Vec<String> {
    r.findings
        .iter()
        .map(|f| {
            format!(
                "{:?} {} {} {} {}",
                f.severity,
                f.check,
                f.code,
                f.entity,
                f.detail.chars().take(400).collect::<String>()
            )
        })
        .collect()
}

fn version(i: &Input, t: usize) -> Version {
    vtx::decode(&i.txs[t].tx).expect("decodes").version
}

/// The successful transactions with lookups, in order.
fn with_lookups(i: &Input) -> Vec<usize> {
    (0..i.txs.len())
        .filter(|&t| i.txs[t].err.is_none() && !i.txs[t].loaded.writable.is_empty())
        .collect()
}

fn has(r: &Report, check: &str, code: &str) -> bool {
    r.findings
        .iter()
        .any(|f| f.check == check && f.code == code)
}

/// `Undecodable` from the chain walk: V1, or CQ1 in its place (this
/// season's program version runs the conquest audit's chain walk, R-22).
fn undecodable(r: &Report) -> bool {
    has(r, "V1", "Undecodable") || has(r, "CQ1", "Undecodable")
}

fn assert_fail(i: &Input, what: &str) -> Report {
    let r = verify_core::verify(i);
    assert_eq!(r.verdict, Verdict::Fail, "{what}: {:#?}", show(&r));
    r
}

#[test]
fn the_recording_mixes_legacy_v0_and_v1_player_transactions() {
    let i = recorded();
    let n = |v: Version| (0..i.txs.len()).filter(|&t| version(&i, t) == v).count();
    assert!(n(Version::Legacy) >= 10, "legacy {}", n(Version::Legacy));
    assert!(n(Version::V0) >= 6, "v0 {}", n(Version::V0));
    assert!(n(Version::V1) >= 3, "v1 {}", n(Version::V1));
    // The v0 ones resolve accounts through lookups, writable and readonly.
    let l = with_lookups(&i);
    assert!(l.len() >= 6);
    assert!(l.iter().any(|&t| !i.txs[t].loaded.readonly.is_empty()));
    // A Join and a PlaceHome that succeeded as v1 / v0.
    assert!(i.provenance.contains("Join (V1): ok"), "{}", i.provenance);
    assert!(i.provenance.contains("(V0, "), "{}", i.provenance);
    // Two lookup tables, read with the final states.
    let t = i.chain.lookup_tables.as_ref().expect("lookup tables");
    assert_eq!(t.accounts.len(), 2);
    assert!(t.accounts.values().all(|a| a.is_some()));
    // The legacy decoder refuses every versioned one (fail-safe kept).
    for t in 0..i.txs.len() {
        assert_eq!(
            fclient::tx::from_wire(&i.txs[t].tx).is_ok(),
            version(&i, t) == Version::Legacy
        );
    }
}

#[test]
fn the_honest_mixed_season_passes_with_post_states() {
    let i = recorded();
    let r = verify_core::verify(&i);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(
        r.checks_run.contains(&"VT:lookup-tables"),
        "{:?}",
        r.checks_run
    );
    assert!(
        r.checks_run.contains(&"VX:re-execution"),
        "{:?}",
        r.checks_run
    );
}

#[test]
fn the_honest_mixed_season_passes_by_genesis_replay_without_post_states() {
    let i = rpc_shaped();
    let r = verify_core::verify(&i);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(
        r.checks_run.contains(&"VG:genesis-replay"),
        "{:?}",
        r.checks_run
    );
    assert!(
        r.checks_run.contains(&"VT:lookup-tables"),
        "{:?}",
        r.checks_run
    );
}

#[test]
fn the_recording_round_trips_through_the_fixture_format() {
    let i = common::fixture(FIXTURE);
    let back = Input::from_json(&i.to_json()).expect("round trip");
    assert_eq!(back.chain, i.chain);
    assert_eq!(
        back.txs
            .iter()
            .map(|t| t.loaded.clone())
            .collect::<Vec<_>>(),
        i.txs.iter().map(|t| t.loaded.clone()).collect::<Vec<_>>()
    );
}

// ------------------------------------------------------------ tampers

/// A recorded looked-up writable address replaced by another account of
/// the season (one the transaction does not name): VT FAILs, and the
/// re-execution / replays read the wrong account.
#[test]
fn a_forged_loaded_address_fails() {
    for post in [true, false] {
        let mut i = if post { recorded() } else { rpc_shaped() };
        let t = with_lookups(&i)[1];
        let other = *i
            .finals
            .keys()
            .map(|k| Address::new_from_array(*k))
            .collect::<Vec<_>>()
            .iter()
            .find(|k| {
                !fclient::vtx::decode(&i.txs[t].tx)
                    .unwrap()
                    .mentions(k, &i.txs[t].loaded)
            })
            .expect("another account");
        i.txs[t].loaded.writable[0] = other;
        let r = assert_fail(&i, "forged loadedAddresses");
        assert!(has(&r, "VT", "LookupMismatch"), "{:#?}", show(&r));
    }
}

/// Two recorded looked-up addresses swapped (both of the same table, so the
/// set is the same): FAIL.
#[test]
fn swapped_loaded_addresses_fail() {
    let mut i = recorded();
    let t = *with_lookups(&i)
        .iter()
        .find(|&&t| i.txs[t].loaded.writable.len() >= 2)
        .expect("a lookup of two writable addresses");
    i.txs[t].loaded.writable.swap(0, 1);
    let r = assert_fail(&i, "swapped loadedAddresses");
    assert!(has(&r, "VT", "LookupMismatch"), "{:#?}", show(&r));
}

/// The lookup table's own state edited (an index holding another address):
/// the archive's meta then disagrees with the table: FAIL.
#[test]
fn a_tampered_lookup_table_state_fails() {
    let mut i = recorded();
    let ts = i.chain.lookup_tables.as_mut().unwrap();
    let (_, acc) = ts.accounts.iter_mut().next().unwrap();
    let acc = acc.as_mut().unwrap();
    let n = verify_core::vmsg::TABLE_META;
    for b in &mut acc.data[n..] {
        *b ^= 0x5a;
    }
    let r = assert_fail(&i, "tampered table");
    assert!(has(&r, "VT", "LookupMismatch"), "{:#?}", show(&r));
}

/// A table truncated (fewer addresses than an index used): FAIL.
#[test]
fn a_truncated_lookup_table_fails() {
    let mut i = recorded();
    for a in i
        .chain
        .lookup_tables
        .as_mut()
        .unwrap()
        .accounts
        .values_mut()
    {
        a.as_mut()
            .unwrap()
            .data
            .truncate(verify_core::vmsg::TABLE_META);
    }
    let r = assert_fail(&i, "truncated table");
    assert!(has(&r, "VT", "LookupMismatch"), "{:#?}", show(&r));
}

/// An account that is not a lookup table in the table's place: FAIL.
#[test]
fn a_table_owned_by_another_program_fails() {
    let mut i = recorded();
    for a in i
        .chain
        .lookup_tables
        .as_mut()
        .unwrap()
        .accounts
        .values_mut()
    {
        a.as_mut().unwrap().owner = i.cfg.program;
    }
    let r = assert_fail(&i, "foreign owner");
    assert!(has(&r, "VT", "LookupMismatch"), "{:#?}", show(&r));
}

/// No table read: the looked-up addresses rest on meta alone — never PASS.
#[test]
fn unread_lookup_tables_are_unverifiable_not_a_pass() {
    for post in [true, false] {
        let mut i = if post { recorded() } else { rpc_shaped() };
        i.chain.lookup_tables = None;
        let r = verify_core::verify(&i);
        assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
        assert!(r.findings.iter().all(|f| f.severity != Severity::Fail));
        assert!(has(&r, "VT", "LookupTableUnread"), "{:#?}", show(&r));
        // and only that
        assert!(
            r.findings
                .iter()
                .filter(|f| f.severity == Severity::Unverifiable)
                .all(|f| f.code == "LookupTableUnread"),
            "{:#?}",
            show(&r)
        );
    }
}

/// A table closed by the pinned slot: UNVERIFIABLE, never PASS.
#[test]
fn a_closed_lookup_table_is_unverifiable() {
    let mut i = recorded();
    for a in i
        .chain
        .lookup_tables
        .as_mut()
        .unwrap()
        .accounts
        .values_mut()
    {
        *a = None;
    }
    let r = verify_core::verify(&i);
    assert_eq!(r.verdict, Verdict::Unverifiable, "{:#?}", show(&r));
    assert!(has(&r, "VT", "LookupTableUnread"));
}

/// The archive lost a v0 transaction's `loadedAddresses`: its accounts are
/// unknown — FAIL `Undecodable` (V1 / CQ1), never PASS.
#[test]
fn a_v0_record_without_its_loaded_addresses_fails_undecodable() {
    for post in [true, false] {
        let mut i = if post { recorded() } else { rpc_shaped() };
        let t = with_lookups(&i)[0];
        i.txs[t].loaded = Default::default();
        let r = assert_fail(&i, "meta.loadedAddresses missing");
        assert!(undecodable(&r), "{:#?}", show(&r));
    }
}

/// Looked-up addresses on a legacy record (no lookups to fill): FAIL.
#[test]
fn loaded_addresses_on_a_legacy_record_fail_undecodable() {
    let mut i = recorded();
    let t = (0..i.txs.len())
        .find(|&t| version(&i, t) == Version::Legacy && i.txs[t].err.is_none())
        .unwrap();
    i.txs[t]
        .loaded
        .readonly
        .push(Address::new_from_array([7; 32]));
    let r = assert_fail(&i, "loaded on legacy");
    assert!(undecodable(&r), "{:#?}", show(&r));
}

/// An unknown message version (0x82) or a v0 / v1 wire with a byte past its
/// end: FAIL `Undecodable`, never PASS.
#[test]
fn unknown_versions_and_malformed_versioned_wires_fail() {
    let base = recorded();
    let v1 = (0..base.txs.len())
        .find(|&t| version(&base, t) == Version::V1)
        .unwrap();
    let v0 = with_lookups(&base)[0];
    let mut cases: Vec<(&str, Input)> = vec![];
    let mut i = base.clone();
    i.txs[v1].tx[0] = 0x82;
    cases.push(("v1 prefix → 0x82", i));
    let mut i = base.clone();
    i.txs[v1].tx.push(0);
    cases.push(("v1 + trailing byte", i));
    let mut i = base.clone();
    i.txs[v0].tx.push(0);
    cases.push(("v0 + trailing byte", i));
    let mut i = base.clone();
    let m = 1 + 64 * i.txs[v0].tx[0] as usize;
    i.txs[v0].tx[m] = 0x83; // v0 → v3 message prefix
    cases.push(("v0 message prefix → 0x83", i));
    for (what, i) in cases {
        let r = assert_fail(&i, what);
        assert!(undecodable(&r), "{what}: {:#?}", show(&r));
    }
}

/// A v0 transaction's signature no longer matches (one lookup index
/// changed in the signed bytes): never PASS.
#[test]
fn an_edited_lookup_index_in_the_signed_bytes_is_never_a_pass() {
    let mut i = rpc_shaped();
    let t = with_lookups(&i)[0];
    let d = vtx::decode(&i.txs[t].tx).unwrap();
    let VersionedMessage::V0(mut m) = d.tx.message.clone() else {
        panic!("v0")
    };
    let l = &mut m.address_table_lookups[0];
    l.writable_indexes[0] = l.writable_indexes[0].wrapping_add(1);
    let forged = VersionedTransaction {
        signatures: d.tx.signatures.clone(),
        message: VersionedMessage::V0(m),
    };
    i.txs[t].tx = vtx::wire(&forged).unwrap();
    let r = verify_core::verify(&i);
    assert_ne!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
}

// ------------------------------------------------------------ legacy unchanged

/// A legacy-only archive's report is the one it was: VT does not run, and
/// the committed genesis recording still passes by its own tests
/// (`playable_genesis.rs`); here: no VT entry, same verdict as the recorded
/// land fixture's without the new code path.
#[test]
fn a_legacy_only_archive_does_not_run_vt() {
    let mut i = common::fixture("playable-lane-genesis.json.gz");
    i.program_so = Some(
        verify_core::reexec::Program::load(
            &common::fixtures_dir().join("devnet-playable-da3dc1aa.so.gz"),
        )
        .unwrap()
        .so,
    );
    assert!((0..i.txs.len()).all(|t| version(&i, t) == Version::Legacy));
    let r = verify_core::verify(&i);
    assert!(!r.checks_run.iter().any(|c| c.starts_with("VT")));
    assert!(r.findings.iter().all(|f| f.check != "VT"));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
}

// ------------------------------------------------------------ live node + CLI

/// The same season served by a live local node (`localnet::server`,
/// 127.0.0.1:41850 by default, `VERSIONED_LIVE_PORT`) and read by the real
/// `frontier-verify` binary over RPC — the path a devnet run takes: the
/// program's history through findex `RpcPoll`, `getTransaction` with
/// `maxSupportedTransactionVersion` (v0/v1 and `meta.loadedAddresses`), the
/// lookup tables read with the final states (`--rpc`), the balances
/// (`--balances`) and the pinned `.so`:
///
/// - read as public RPC (no post-states: VG re-executes from genesis,
///   v0/v1 included): no FAIL; the only open item is ⑲'s unproven public
///   history (UNVERIFIABLE, as `playable_lane.rs`'s live test);
/// - its `--save`d input, with the history the recorder vouches for: PASS;
/// - read as the local node's ledger feed (`--localnet`, post-states: VX):
///   no FAIL, VT ran.
///
/// Ignored: it signs with the recorder's fixed TEST keys and binds a port.
#[test]
#[ignore = "binds 127.0.0.1:41850 (VERSIONED_LIVE_PORT) and signs the recorder's TEST transactions; run with --ignored"]
fn a_live_node_with_v0_v1_players_is_verified_by_the_cli() {
    let so = so();
    let (r, program, _upgrade, _) = build_versioned(&so);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let state = std::sync::Arc::new(std::sync::Mutex::new(r.c));
    let port: u16 = std::env::var("VERSIONED_LIVE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(41_850);
    let node = rt
        .block_on(localnet::server::start(state, port))
        .expect("the port free");
    let url = node.url();
    let so_path = common::fixtures_dir().join(SO_GZ);
    let out = std::env::temp_dir().join(format!("verifier-v0v1-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let run = |extra: &[&str], tag: &str| -> (i32, serde_json::Value) {
        let dir = out.join(tag);
        let mut args: Vec<String> = vec![
            "--rpc".into(),
            url.clone(),
            "--program".into(),
            program.to_string(),
            "--season".into(),
            SEASON_ID.to_string(),
            "--ruleset".into(),
            hex::encode(frontier_abi::v2::presets::RULESET_HASH_V3),
            "--program-hash".into(),
            SO_SHA256.into(),
            "--program-so".into(),
            so_path.display().to_string(),
            "--json".into(),
            "--out".into(),
            dir.display().to_string(),
            "--save".into(),
            dir.join("input.json.gz").display().to_string(),
        ];
        args.extend(extra.iter().map(|s| s.to_string()));
        let o = std::process::Command::new(env!("CARGO_BIN_EXE_frontier-verify"))
            .args(&args)
            .output()
            .expect("frontier-verify runs");
        let stderr = String::from_utf8_lossy(&o.stderr);
        println!("--- {tag}: exit {:?}\n{stderr}", o.status.code());
        let rep: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("report.json")).expect("report.json"))
                .expect("json");
        (o.status.code().unwrap_or(-1), rep)
    };
    let findings = |rep: &serde_json::Value| -> Vec<(String, String, String)> {
        rep["findings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["severity"].as_str().unwrap().to_string(),
                    f["check"].as_str().unwrap().to_string(),
                    f["code"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    };
    let checks = |rep: &serde_json::Value| -> Vec<String> {
        rep["checks_run"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect()
    };
    // 1. as public RPC (VG)
    let (code, rep) = run(&["--balances"], "public");
    let f = findings(&rep);
    println!("public: {} {:?}\n{f:#?}", rep["verdict"], checks(&rep));
    assert!(f.iter().all(|x| x.0 != "fail"), "{f:#?}");
    assert!(
        f.iter()
            .filter(|x| x.0 == "unverifiable")
            .all(|x| x.2 == verify_core::codes::HISTORY_UNPROVEN),
        "{f:#?}"
    );
    assert_eq!(rep["verdict"], "UNVERIFIABLE");
    assert_eq!(code, verify_core::EXIT_UNVERIFIABLE);
    assert!(checks(&rep).iter().any(|c| c == "VG:genesis-replay"));
    assert!(checks(&rep).iter().any(|c| c == "VT:lookup-tables"));
    let mut saved = Input::load(&out.join("public").join("input.json.gz")).expect("saved input");
    let tables = saved
        .chain
        .lookup_tables
        .as_ref()
        .expect("the CLI read the tables");
    assert_eq!(tables.accounts.len(), 2);
    assert!(tables.accounts.values().all(|a| a.is_some()));
    assert!(saved.txs.iter().any(|t| !t.loaded.writable.is_empty()));
    assert!(saved
        .txs
        .iter()
        .any(|t| vtx::decode(&t.tx).unwrap().version == Version::V1));
    // 2. the same read with a vouched history: PASS
    saved.history = Default::default();
    saved.program_so = Some(so.clone());
    let rep2 = verify_core::verify(&saved);
    assert_eq!(rep2.verdict, Verdict::Pass, "{:#?}", show(&rep2));
    // 3. the local node's ledger feed (VX over post-states)
    let (code3, rep3) = run(&["--localnet"], "localnet");
    let f3 = findings(&rep3);
    println!("localnet: {} {:?}\n{f3:#?}", rep3["verdict"], checks(&rep3));
    assert!(f3.iter().all(|x| x.0 != "fail"), "{f3:#?}");
    assert!(checks(&rep3).iter().any(|c| c == "VT:lookup-tables"));
    assert!(checks(&rep3).iter().any(|c| c == "VX:re-execution"));
    println!("localnet exit {code3}");
    node.stop();
    let _ = std::fs::remove_dir_all(&out);
}
