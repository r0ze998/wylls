//! ⑳ NFT resident ID, local play check (owner decision 2026-11-18 18:26 JST: local and devnet only, no sale):
//! the REAL SBF artefact of the playable lane WITH NFT residents (`scripts/build-frontier-localnet-nft-sbf.sh`,
//! feature `localnet-nft-sbf`, version 0xC804) in the in-process LiteSVM chain (`localnet::Chain`). A wallet
//! player and an NFT resident play side by side in the same world, through the program's own instructions:
//!
//!   CreateResidentPolicy (0xE0, the deployed program's real upgrade authority)
//!   InitShards (the Season's authority) → OpenProvince (a heartland home province)
//!   wallet:   Join → PlaceHome → Harvest → SetVigil
//!   resident: JoinResident (0xE1) → ResidentAct(PlaceHome) → ResidentAct(Harvest) → ResidentAct(SetVigil)
//!   TransferResident (as the resident program leaves it) → the old holder is refused, the new holder plays on
//!   the same Citizen and Holding.
//!
//! FIXTURES (written with `Chain::set_account`, said here so nothing is mistaken for a real run):
//! - the Season, Frontier, the home ring's RingSeed and ProvinceFund are `expedition_play::Base` (its stated
//!   overrides, with the Season's version set to 0xC804), plus a SEEDED ring-2 RingSeed with a zero seed and a
//!   funded ProvinceFund for that province's wedge (not beacon values);
//! - Metaplex Core and the resident program are NOT run: the Core asset (AssetV1 of the collection with the
//!   frozen Permanent Freeze and Permanent Transfer delegates of the resident program's collection authority)
//!   and the resident record are bytes in the state their instructions leave (⑳'s layout, as
//!   `permutation-frontier/src/resident_runtime_tests.rs` and workstream 04's `chain_nft.rs`). The transfer is
//!   the same: the asset's owner changes and the generation goes up by one, as `TransferResident` does.
//!
//! Keys: `Keypair::new()` in memory per test (the chain verifies real signatures), funded by the disposable
//! chain's airdrop; nothing is read from or written to disk, nothing secret is printed.
//!
//!   scripts/build-frontier-localnet-nft-sbf.sh
//!   WYLLS_NFT_SBF=<abs path of the .so> WYLLS_NFT_SBF_SHA256=<its sha256> \
//!     cargo test --locked -p itest --features localnet-nft-harness --test localnet_nft_resident -- --nocapture
use fclient::addr::Addresses;
use fclient::ix::{self, HoldingRef, Player, Site};
use fclient::ports::Account;
use fclient::tx::{self, TxBudget};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::wr_u16;
use frontier_abi::layout::world::ring_seed as RS;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::presets::S1_LOCAL_7D;
use frontier_abi::world_index::expedition_dispatch_ix::RESIDENT_PROGRAM_VERSION;
use frontier_abi::{resident_citizen as rc, resident_wire as wire};
use itest::expedition_play::{Base, PROGRAM, SEASON_ID};
use localnet::{Chain, Config};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use sha2::{Digest, Sha256};

const ENV_PATH: &str = "WYLLS_NFT_SBF";
const ENV_SHA: &str = "WYLLS_NFT_SBF_SHA256";
const MARKERS: [&[u8]; 4] = [
    b"PSF_LOCALNET_EXPEDITION_SBF_BUILD",
    b"PSF_LOCALNET_CONQUEST_SBF_BUILD",
    b"PSF_LOCALNET_NFT_SBF_BUILD",
    b"PSF_NFT_EXPERIMENTAL_BUILD",
];
/// Public literal program ids of the Core and resident programs (not run; their accounts are bytes).
const CORE: [u8; 32] = [0x44; 32];
const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
const COLLECTION: [u8; 32] = [0x55; 32];
const ASSET: [u8; 32] = [0x5a; 32];
const LAMPORTS: u64 = 10_000_000_000;

// The resident program's errors seen through the Frontier program (⑳'s 170–175).
const STALE: u32 = frontier_abi::v2::error::CqError::ResidentStaleGeneration as u32;
const NOT_CURRENT: u32 = frontier_abi::v2::error::CqError::ResidentNotCurrentAuthority as u32;

fn artifact() -> Vec<u8> {
    let get = |n: &str| {
        std::env::var(n).unwrap_or_else(|_| panic!("{n} is not set ({ENV_PATH} = abs path of the NFT lane .so, {ENV_SHA} = its sha256)"))
    };
    let bytes = std::fs::read(get(ENV_PATH)).expect("read the artefact");
    assert_eq!(
        hex::encode(Sha256::digest(&bytes)),
        get(ENV_SHA),
        "the artefact's sha256"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[48..52].try_into().unwrap()),
        2,
        "SBPF v2"
    );
    for m in MARKERS {
        assert!(
            bytes.windows(m.len()).any(|w| w == m),
            "marker {}",
            String::from_utf8_lossy(m)
        );
    }
    bytes
}

fn guard() -> Address {
    fclient::addr::resident_guard(&Address::new_from_array(RESIDENT_PROGRAM))
}

/// ⑳'s guarded AssetV1 tail: frozen Permanent Freeze Delegate and Permanent Transfer Delegate of `guard`.
fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(guard);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

fn asset_bytes(owner: &Address) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner.as_ref());
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0);
    let base = a.len();
    a.extend_from_slice(&guarded_tail(base, &guard().to_bytes()));
    a
}

/// The resident program's record of `ASSET` (133 B): the holder generation, no session.
fn resident_bytes(generation: u32) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    r
}

fn budget() -> TxBudget {
    TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: Some(256 * 1024),
    }
}

/// Signs, submits and lands one transaction. `Ok(())`, or the program's custom code (`Err(code)`), or a panic
/// with the logs for anything else.
fn send(c: &mut Chain, ixs: &[Instruction], signers: &[&Keypair], what: &str) -> Result<(), u32> {
    let (blockhash, _) = c.latest_blockhash();
    let t = tx::build(ixs, &budget(), signers, &blockhash).expect("build");
    let sig = c
        .submit(&tx::wire(&t))
        .unwrap_or_else(|e| panic!("{what}: refused before landing: {e:?}"));
    c.produce_block();
    let landed = c
        .transaction(&sig)
        .cloned()
        .unwrap_or_else(|| panic!("{what}: did not land"));
    match landed.err {
        None => {
            println!("ok    {what}");
            Ok(())
        }
        Some(err) => match landed.code {
            Some(code) => {
                println!("refused {what}: code {code}");
                Err(code)
            }
            None => panic!("{what}: {err} {:?}", landed.logs),
        },
    }
}

/// Harvest as the v2 program reads it: fclient's `ix::harvest` (the M1 account list) plus the home Province
/// (`proc/holding.rs` `harvest_body`: `[actor, payer, season, citizen, holding, province]`).
fn harvest_v2(a: &Addresses, p: &Player, h: HoldingRef) -> Instruction {
    let mut i = ix::harvest(a, p, h);
    i.accounts.push(AccountMeta::new_readonly(
        a.province(h.p as i32, h.q as i32),
        false,
    ));
    i
}

fn owned(owner: [u8; 32], data: Vec<u8>) -> Account {
    Account {
        lamports: LAMPORTS,
        data,
        owner: Address::new_from_array(owner),
        executable: false,
    }
}

struct World {
    c: Chain,
    a: Addresses,
    upgrade: Keypair,
    authority: Keypair,
    payer: Keypair,
    home: (i16, i16, u8),
}

/// The world: the NFT lane deployed with a real upgrade authority, the Base fixture (version 0xC804), a seeded
/// ring 2, every JoinShard by the real InitShards, and one heartland home Province by the real OpenProvince.
fn world() -> World {
    let bytes = artifact();
    let mut c = Chain::new(Config {
        allow_tamper: false,
        data_dir: None,
        ..Config::default()
    });
    let program = Address::new_from_array(PROGRAM);
    let upgrade = Keypair::new();
    let authority = Keypair::new();
    let payer = Keypair::new();
    c.deploy(
        program,
        &bytes,
        fclient::fees::deploy_max_len(bytes.len() as u64) as usize,
        Some(upgrade.pubkey()),
    )
    .expect("deploy");
    for k in [&upgrade, &authority, &payer] {
        c.airdrop(&k.pubkey(), 100 * LAMPORTS).expect("airdrop");
    }
    c.produce_block();
    let mut base = Base::new(c.unix_timestamp()).expect("base");
    base.set_program_version(RESIDENT_PROGRAM_VERSION);
    base.set_authority(&authority.pubkey());
    base.install(&mut c).expect("install base");
    let a = Addresses::new(program, SEASON_ID);
    let ctx = AddrCtx {
        program: PROGRAM,
        season: a.season.to_bytes(),
    };
    // A heartland home province of ring 2 (zero genesis seed, as the Base Season).
    let cq = S1_LOCAL_7D.cq;
    let (p, q, nation) = (-2i32..=2)
        .flat_map(|p| (-2i32..=2).map(move |q| (p, q)))
        .filter(|&(p, q)| ProvinceCoord::new(p, q).ring() == 2)
        .find_map(|(p, q)| {
            home_nation(
                ProvinceCoord::new(p, q),
                cq.placement,
                cq.heartland_max_ring,
                &[0; 32],
            )
            .map(|n| (p as i16, q as i16, n))
        })
        .expect("a ring-2 heartland province");
    let mut rs = vec![0u8; K2::RingSeed.size()];
    assert!(write_header(&mut rs, K2::RingSeed, SEASON_ID));
    assert!(wr_u16(&mut rs, RS::D, 2));
    rs[RS::STATUS] = RS::STATUS_SEEDED;
    c.set_account(
        Address::new_from_array(ctx.ring_seed(2)),
        owned(PROGRAM, rs),
    )
    .unwrap();
    let wedge = ix::wedge_of(p as i32, q as i32);
    let mut fund = vec![0u8; K2::ProvinceFund.size()];
    assert!(write_header(&mut fund, K2::ProvinceFund, SEASON_ID));
    fund[frontier_abi::layout::world::province_fund::WEDGE] = wedge;
    c.set_account(
        Address::new_from_array(ctx.province_fund(wedge)),
        owned(PROGRAM, fund),
    )
    .unwrap();
    c.produce_block();
    for f in 0..fclient::abi::FACTIONS {
        send(
            &mut c,
            &[ix::init_shards(&a, authority.pubkey(), f)],
            &[&authority],
            "InitShards",
        )
        .expect("InitShards");
    }
    send(
        &mut c,
        &[ix::open_province(&a, payer.pubkey(), p, q)],
        &[&payer],
        "OpenProvince",
    )
    .expect("OpenProvince");
    World {
        c,
        a,
        upgrade,
        authority,
        payer,
        home: (p, q, nation),
    }
}

impl World {
    fn policy_ix(&self) -> Instruction {
        let program = self.a.program;
        let mut d = vec![wire::CREATE_RESIDENT_POLICY];
        for k in [CORE, RESIDENT_PROGRAM, COLLECTION, guard().to_bytes()] {
            d.extend_from_slice(&k);
        }
        Instruction {
            program_id: program,
            accounts: vec![
                AccountMeta::new(self.upgrade.pubkey(), true),
                AccountMeta::new(fclient::addr::resident_policy(&program), false),
                AccountMeta::new_readonly(program, false),
                AccountMeta::new_readonly(fclient::addr::programdata(&program), false),
                AccountMeta::new_readonly(fclient::addr::system_program(), false),
            ],
            data: d,
        }
    }

    fn proof(&self) -> [AccountMeta; 4] {
        let program = self.a.program;
        let asset = Address::new_from_array(ASSET);
        [
            AccountMeta::new_readonly(fclient::addr::resident_policy(&program), false),
            AccountMeta::new_readonly(
                fclient::addr::resident_link(&program, &self.a.season, &asset),
                false,
            ),
            AccountMeta::new_readonly(asset, false),
            AccountMeta::new_readonly(
                fclient::addr::resident_account(&Address::new_from_array(RESIDENT_PROGRAM), &asset),
                false,
            ),
        ]
    }

    fn resident_citizen(&self) -> Address {
        self.a.resident_citizen(&Address::new_from_array(ASSET))
    }

    fn join_resident_ix(&self, owner: &Keypair, generation: u32, faction: u8) -> Instruction {
        let mut d = vec![wire::JOIN_RESIDENT];
        d.extend_from_slice(&generation.to_le_bytes());
        d.push(faction);
        let mut m = vec![
            AccountMeta::new_readonly(owner.pubkey(), true),
            AccountMeta::new(self.payer.pubkey(), true),
            AccountMeta::new_readonly(self.a.season, false),
            AccountMeta::new_readonly(self.a.frontier(), false),
            AccountMeta::new(self.resident_citizen(), false),
            AccountMeta::new_readonly(fclient::addr::system_program(), false),
        ];
        let mut proof = self.proof().to_vec();
        proof[1] = AccountMeta::new(proof[1].pubkey, false); // the link is created here
        m.extend(proof);
        Instruction {
            program_id: self.a.program,
            accounts: m,
            data: d,
        }
    }

    /// ResidentAct: the wallet builder's instruction for `actor`, with the NFT Citizen in place of the wallet
    /// Citizen (account 3), wrapped as `[0xE2, generation, inner…]` with the four proof accounts appended.
    fn act(&self, inner: Instruction, generation: u32) -> Instruction {
        let mut accounts = inner.accounts;
        accounts[3] = AccountMeta::new(self.resident_citizen(), false);
        accounts.extend(self.proof());
        let mut d = vec![wire::RESIDENT_ACT];
        d.extend_from_slice(&generation.to_le_bytes());
        d.extend_from_slice(&inner.data);
        Instruction {
            program_id: self.a.program,
            accounts,
            data: d,
        }
    }

    fn player(&self, actor: &Keypair) -> Player {
        Player {
            actor: actor.pubkey(),
            payer: self.payer.pubkey(),
            wallet: actor.pubkey(),
        }
    }

    /// A FREE site of the home Province (as the program left it).
    fn free_sites(&self) -> Vec<u8> {
        let (p, q, _) = self.home;
        let d = self
            .c
            .account(&self.a.province(p as i32, q as i32))
            .expect("home")
            .data;
        let pv = fclient::decode::Province::decode(&d).expect("province");
        (0..pv.site_count)
            .filter(|&i| {
                pv.site_mirror[i as usize].state == frontier_abi::layout::province::site::STATE_FREE
            })
            .collect()
    }

    fn set_holder(&mut self, owner: &Address, generation: u32) {
        let asset = Address::new_from_array(ASSET);
        self.c
            .set_account(asset, owned(CORE, asset_bytes(owner)))
            .unwrap();
        let r = fclient::addr::resident_account(&Address::new_from_array(RESIDENT_PROGRAM), &asset);
        self.c
            .set_account(r, owned(RESIDENT_PROGRAM, resident_bytes(generation)))
            .unwrap();
        self.c.produce_block();
    }

    fn data(&self, k: &Address) -> Vec<u8> {
        self.c.account(k).map(|a| a.data).unwrap_or_default()
    }
}

#[test]
fn an_nft_resident_plays_like_a_wallet_player_and_its_new_holder_plays_on() {
    let mut w = world();
    let (p, q, faction) = w.home;
    let wallet = Keypair::new();
    let a_owner = Keypair::new();
    let b_owner = Keypair::new();
    for k in [&wallet, &a_owner, &b_owner] {
        w.c.airdrop(&k.pubkey(), LAMPORTS).unwrap();
    }
    w.set_holder(&a_owner.pubkey(), 0);
    let policy = w.policy_ix();
    let up = w.upgrade.insecure_clone();
    send(&mut w.c, &[policy], &[&up], "CreateResidentPolicy")
        .expect("the real upgrade authority writes the policy");
    let payer = w.payer.insecure_clone();

    // The wallet player: Join → PlaceHome → Harvest → SetVigil.
    let join = ix::join(
        &w.a,
        wallet.pubkey(),
        payer.pubkey(),
        faction,
        &Address::default(),
        0,
        None,
    );
    send(&mut w.c, &[join], &[&wallet, &payer], "wallet Join").expect("wallet Join");
    let sites = w.free_sites();
    assert!(sites.len() >= 2, "two free sites on the home: {sites:?}");
    let wallet_shard = frontier_abi::addr::join_shard_of(&wallet.pubkey().to_bytes());
    let ws = Site {
        p,
        q,
        site: sites[0],
    };
    let ph = ix::place_home(&w.a, &w.player(&wallet), ws, faction, wallet_shard);
    send(&mut w.c, &[ph], &[&wallet, &payer], "wallet PlaceHome").expect("wallet PlaceHome");
    let wh = HoldingRef {
        p,
        q,
        site: sites[0],
    };
    let i = harvest_v2(&w.a, &w.player(&wallet), wh);
    send(&mut w.c, &[i], &[&wallet, &payer], "wallet Harvest").expect("wallet Harvest");
    let i = ix::set_vigil(&w.a, &w.player(&wallet), 60);
    send(&mut w.c, &[i], &[&wallet, &payer], "wallet SetVigil").expect("wallet SetVigil");

    // The NFT resident: JoinResident → ResidentAct(PlaceHome, Harvest, SetVigil), owner A at generation 0.
    let jr = w.join_resident_ix(&a_owner, 0, faction);
    send(&mut w.c, &[jr], &[&a_owner, &payer], "JoinResident").expect("JoinResident");
    let citizen = w.resident_citizen();
    let cd = w.data(&citizen);
    assert_eq!(
        rc::resident_asset(&cd),
        Some(ASSET),
        "the Citizen is the asset's NFT Citizen"
    );
    assert_eq!(
        &cd[C::WALLET..C::WALLET + 32],
        &[0u8; 32],
        "an NFT Citizen has no wallet"
    );
    let shard = frontier_abi::addr::join_shard_of(&ASSET);
    let rs = Site {
        p,
        q,
        site: sites[1],
    };
    let rph = w.act(
        ix::place_home(&w.a, &w.player(&a_owner), rs, faction, shard),
        0,
    );
    send(
        &mut w.c,
        &[rph],
        &[&a_owner, &payer],
        "ResidentAct(PlaceHome)",
    )
    .expect("resident PlaceHome");
    let rh = HoldingRef {
        p,
        q,
        site: sites[1],
    };
    let holding = rh.address(&w.a);
    let hd = w.data(&holding);
    assert_eq!(
        &hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32],
        citizen.as_ref(),
        "the home is the NFT Citizen's"
    );
    let harvest = |w: &World, k: &Keypair, g: u32| w.act(harvest_v2(&w.a, &w.player(k), rh), g);
    let vigil =
        |w: &World, k: &Keypair, g: u32, m: u16| w.act(ix::set_vigil(&w.a, &w.player(k), m), g);
    let i = harvest(&w, &a_owner, 0);
    send(
        &mut w.c,
        &[i],
        &[&a_owner, &payer],
        "ResidentAct(Harvest) by A",
    )
    .expect("A harvests");
    let i = vigil(&w, &a_owner, 0, 60);
    send(
        &mut w.c,
        &[i],
        &[&a_owner, &payer],
        "ResidentAct(SetVigil) by A",
    )
    .expect("A sets a vigil");
    let before = w.data(&citizen);

    // TransferResident A → B (generation 1), as the resident program leaves it.
    w.set_holder(&b_owner.pubkey(), 1);
    let i = vigil(&w, &a_owner, 0, 120);
    assert_eq!(
        send(
            &mut w.c,
            &[i],
            &[&a_owner, &payer],
            "A, signed before the transfer"
        ),
        Err(STALE)
    );
    let i = vigil(&w, &a_owner, 1, 120);
    assert_eq!(
        send(&mut w.c, &[i], &[&a_owner, &payer], "A, fresh signature"),
        Err(NOT_CURRENT)
    );
    let i = vigil(&w, &b_owner, 0, 120);
    assert_eq!(
        send(
            &mut w.c,
            &[i],
            &[&b_owner, &payer],
            "B with the old generation"
        ),
        Err(STALE)
    );
    assert_eq!(w.data(&citizen), before, "refused actions write nothing");
    let i = harvest(&w, &b_owner, 1);
    send(
        &mut w.c,
        &[i],
        &[&b_owner, &payer],
        "ResidentAct(Harvest) by B",
    )
    .expect("B acts at once, same home");
    // The resident's own game state moved with it: the vigil A set is still in its cooldown for B.
    let i = vigil(&w, &b_owner, 1, 120);
    assert_eq!(
        send(
            &mut w.c,
            &[i],
            &[&b_owner, &payer],
            "ResidentAct(SetVigil) by B"
        ),
        Err(frontier_abi::error::FrontierError::Cooldown as u32),
        "A's vigil cooldown is the resident's, not the holder's"
    );
    let hd = w.data(&holding);
    assert_eq!(
        &hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32],
        citizen.as_ref(),
        "the home stays the resident's"
    );
    // A wallet Citizen is never reachable through the NFT path, and the wallet player is unaffected.
    let i = harvest_v2(&w.a, &w.player(&wallet), wh);
    send(&mut w.c, &[i], &[&wallet, &payer], "wallet Harvest again")
        .expect("the wallet player still plays");
    let _ = &w.authority;
}

#[test]
fn the_plain_lane_season_is_refused_by_the_nft_lane() {
    // Each lane runs only its own Seasons: a 0x4804 Season (the plain lane's) is a RulesetMismatch here.
    let mut w = world();
    let (p, q, faction) = w.home;
    let program = w.a.program;
    let mut sd = w.data(&w.a.season);
    assert!(wr_u16(
        &mut sd,
        frontier_abi::v2::layout::world::season::PROGRAM_VERSION,
        0x4804
    ));
    let season = w.a.season;
    w.c.set_account(season, owned(program.to_bytes(), sd))
        .unwrap();
    w.c.produce_block();
    let wallet = Keypair::new();
    w.c.airdrop(&wallet.pubkey(), LAMPORTS).unwrap();
    let payer = w.payer.insecure_clone();
    let join = ix::join(
        &w.a,
        wallet.pubkey(),
        payer.pubkey(),
        faction,
        &Address::default(),
        0,
        None,
    );
    send(
        &mut w.c,
        &[join],
        &[&wallet, &payer],
        "wallet Join (0x4804 Season)",
    )
    .expect("Join reads no version");
    let site = w.free_sites()[0];
    let shard = frontier_abi::addr::join_shard_of(&wallet.pubkey().to_bytes());
    let ph = ix::place_home(
        &w.a,
        &w.player(&wallet),
        Site { p, q, site },
        faction,
        shard,
    );
    assert_eq!(
        send(
            &mut w.c,
            &[ph],
            &[&wallet, &payer],
            "PlaceHome on a 0x4804 Season"
        ),
        Err(frontier_abi::error::FrontierError::RulesetMismatch as u32)
    );
}
