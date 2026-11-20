//! ②+⑨+⑩ in ONE local world (owner t412u/t413u, 2026-11-20; workstream 4's allocation rev 8,
//! `frontier_abi::feature_registry`): the world and the three features' first flow on the REAL SBF artefact of the
//! playable lane WITH ② rights, ⑨ capacity and ⑩ custody (`scripts/build-frontier-localnet-coexist-sbf.sh`, feature
//! `localnet-coexist-sbf`, version 0x7805, `RULESET_HASH_V4`) in the in-process LiteSVM chain (`localnet::Chain`).
//! Shared by the test `tests/localnet_coexist.rs` and the TEST-ONLY node `localnet-coexist-play`
//! (`scripts/play-local.sh --coexist`). Through the program's own instructions:
//!
//!   InitShards (the Season's authority) → OpenProvince (a heartland home province)
//!   A: Join → PlaceHome → Harvest                (A owns the facility F: a workshop holding)
//!   B: Join → PlaceHome → Harvest → BuildVault   (B's Vault V on a tile of the same Province: ②'s station, ⑩'s keeper)
//!   ⑨ capacity: OpenCapacityPool(F) → LendCapacity(1 workshop)          (A lends a workshop's processing capacity)
//!   ② rights:   IssueGrant(A → B, F, V) → ReserveSwap(1) → ExecuteSwap   (a StockSwap: arms land in V)
//!   ⑩ custody:  OpenLot(V, A's ore lot) → SetLotQuota                    (B keeps a lot of A's in V)
//!   ② again:    ReserveSwap(1) → ExecuteSwap on the same Vault, beside the lot
//!
//! FIXTURES (written with `Chain::set_account`, said here so nothing is mistaken for a real run):
//! - the Season, Frontier, the home ring's RingSeed and ProvinceFund are `expedition_play::Base` (its stated
//!   overrides, with the Season's version set to 0x7805 and its ruleset to custody's `RULESET_HASH_V4` / rules 13),
//!   plus a SEEDED ring-2 RingSeed with a zero seed and a funded ProvinceFund for that province's wedge;
//! - after the real PlaceHome, F's production carries three workshop copies (`production[ARMS] = 3 ×
//!   WORKSHOP_DELTA`, as three finished Builds leave it) and F's and B's home stores are topped up (ore, wood,
//!   stone, gold, arms; value at the current time), and after the real BuildVault, V holds 200 ore and 200 wood
//!   (a delivered caravan's effect). Only plain store/production fields are written; every other byte is the
//!   program's.
//!
//! Keys: `Keypair::new()` in memory (the chain verifies real signatures), funded by the disposable chain's airdrop;
//! nothing is read from or written to disk, nothing secret is printed.
use crate::expedition_play::{Base, PROGRAM, SEASON_ID};
use fclient::addr::Addresses;
use fclient::ix::{self, HoldingRef, Player, Site};
use fclient::ports::Account;
use fclient::tx::{self, TxBudget};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::wr_u16;
use frontier_abi::capacity::{self as fc, CapData};
use frontier_abi::layout::player::accrual;
use frontier_abi::layout::world::ring_seed as RS;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::s1::vault as VA;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::presets::{RULESET_HASH_V4, RULES_VERSION_CUSTODY, S1_LOCAL_7D};
use frontier_abi::v2::rights as rt;
use localnet::{Chain, Config};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::{ARMS, WORKSHOP_DELTA};
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use permutation_rules::frontier::holding::Resource;

pub const MARKERS: [&[u8]; 5] = [
    b"PSF_LOCALNET_EXPEDITION_SBF_BUILD",
    b"PSF_LOCALNET_CONQUEST_SBF_BUILD",
    b"PSF_LOCALNET_COEXIST_SBF_BUILD",
    b"PSF_RIGHTS_EXPERIMENTAL_BUILD",
    b"PSF_CUSTODY_PREVIEW_BUILD",
];
pub const LAMPORTS: u64 = 10_000_000_000;
pub const VAULT_TILE: u8 = 22;

/// Why `bytes` is not the coexist lane artefact (SBPF v2, its five markers, no devnet or NFT marker).
pub fn artifact_problems(bytes: &[u8]) -> Vec<String> {
    let has = |m: &[u8]| bytes.windows(m.len()).any(|w| w == m);
    let mut out = Vec::new();
    if bytes.len() < 52 || u32::from_le_bytes(bytes[48..52].try_into().unwrap()) != 2 {
        out.push("not SBPF v2".to_string());
    }
    for m in MARKERS {
        if !has(m) {
            out.push(format!("marker {} missing", String::from_utf8_lossy(m)));
        }
    }
    for m in [
        &b"PSF_DEVNET_PLAYABLE_BUILD"[..],
        b"PSF_NFT_EXPERIMENTAL_BUILD",
    ] {
        if has(m) {
            out.push(format!("carries {}", String::from_utf8_lossy(m)));
        }
    }
    out
}

pub fn budget() -> TxBudget {
    TxBudget {
        cu_limit: 1_400_000,
        cu_price: 0,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: Some(256 * 1024),
    }
}

pub fn owned(owner: [u8; 32], data: Vec<u8>) -> Account {
    Account {
        lamports: LAMPORTS,
        data,
        owner: Address::new_from_array(owner),
        executable: false,
    }
}

pub fn meta(m: &(Address, bool, bool)) -> AccountMeta {
    if m.2 {
        AccountMeta::new(m.0, m.1)
    } else {
        AccountMeta::new_readonly(m.0, m.1)
    }
}

pub fn metas(ms: &[([u8; 32], bool, bool)]) -> Vec<AccountMeta> {
    ms.iter()
        .map(|(k, s, w)| meta(&(Address::new_from_array(*k), *s, *w)))
        .collect()
}

pub struct World {
    pub c: Chain,
    pub a: Addresses,
    pub ctx: AddrCtx,
    pub payer: Keypair,
    pub authority: Keypair,
    pub home: (i16, i16, u8),
    /// (step, compute units) of every landed step.
    pub cu: Vec<(String, u64)>,
}

/// The world: the coexist lane deployed, the Base fixture (version 0x7805, custody's ruleset), a seeded ring 2,
/// every JoinShard by the real InitShards, and one heartland home Province by the real OpenProvince.
pub fn world(bytes: &[u8], version: u16, coexist_ruleset: bool) -> World {
    let mut c = Chain::new(Config {
        allow_tamper: false,
        data_dir: None,
        ..Config::default()
    });
    let program = Address::new_from_array(PROGRAM);
    let authority = Keypair::new();
    let payer = Keypair::new();
    c.deploy(
        program,
        bytes,
        fclient::fees::deploy_max_len(bytes.len() as u64) as usize,
        None,
    )
    .expect("deploy");
    for k in [&authority, &payer] {
        c.airdrop(&k.pubkey(), 100 * LAMPORTS).expect("airdrop");
    }
    c.produce_block();
    let mut base = Base::new(c.unix_timestamp()).expect("base");
    base.set_program_version(version);
    if coexist_ruleset {
        base.set_ruleset(&RULESET_HASH_V4, RULES_VERSION_CUSTODY);
    }
    base.set_authority(&authority.pubkey());
    base.install(&mut c).expect("install base");
    let a = Addresses::new(program, SEASON_ID);
    let ctx = AddrCtx {
        program: PROGRAM,
        season: a.season.to_bytes(),
    };
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
    let mut w = World {
        c,
        a,
        ctx,
        payer,
        authority: authority.insecure_clone(),
        home: (p, q, nation),
        cu: Vec::new(),
    };
    if !coexist_ruleset {
        return w;
    }
    for f in 0..fclient::abi::FACTIONS {
        let i = ix::init_shards(&w.a, authority.pubkey(), f);
        w.send(&[i], &[&authority], "InitShards")
            .expect("InitShards");
    }
    let i = ix::open_province(&w.a, w.payer.pubkey(), p, q);
    let payer = w.payer.insecure_clone();
    w.send(&[i], &[&payer], "OpenProvince")
        .expect("OpenProvince");
    w
}

impl World {
    /// Signs, submits and lands one transaction. `Ok(())`, or the program's custom code (`Err(code)`), or a panic
    /// with the logs for anything else.
    pub fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
        what: &str,
    ) -> Result<(), u32> {
        let (blockhash, _) = self.c.latest_blockhash();
        let t = tx::build(ixs, &budget(), signers, &blockhash).expect("build");
        let sig = self
            .c
            .submit(&tx::wire(&t))
            .unwrap_or_else(|e| panic!("{what}: refused before landing: {e:?}"));
        self.c.produce_block();
        let landed = self
            .c
            .transaction(&sig)
            .cloned()
            .unwrap_or_else(|| panic!("{what}: did not land"));
        match landed.err {
            None => {
                println!("ok      {what:<40} {:>7} CU", landed.units);
                self.cu.push((what.to_string(), landed.units));
                Ok(())
            }
            Some(err) => match landed.code {
                Some(code) => {
                    println!("refused {what:<40} code {code}");
                    Err(code)
                }
                None => panic!("{what}: {err} {:?}", landed.logs),
            },
        }
    }

    pub fn player(&self, k: &Keypair) -> Player {
        Player {
            actor: k.pubkey(),
            payer: self.payer.pubkey(),
            wallet: k.pubkey(),
        }
    }

    pub fn data(&self, k: &Address) -> Vec<u8> {
        self.c.account(k).map(|a| a.data).unwrap_or_default()
    }

    pub fn edit(&mut self, k: &Address, f: impl FnOnce(&mut Vec<u8>)) {
        let mut acc = self.c.account(k).expect("present");
        f(&mut acc.data);
        self.c.set_account(*k, acc).unwrap();
        self.c.produce_block();
    }

    pub fn free_sites(&self) -> Vec<u8> {
        let (p, q, _) = self.home;
        let d = self.data(&self.a.province(p as i32, q as i32));
        let pv = fclient::decode::Province::decode(&d).expect("province");
        (0..pv.site_count)
            .filter(|&i| {
                pv.site_mirror[i as usize].state == frontier_abi::layout::province::site::STATE_FREE
            })
            .collect()
    }

    /// Join → PlaceHome on `site` → Harvest: a wallet player's real first home.
    pub fn settle_in(&mut self, k: &Keypair, site: u8, who: &str) -> HoldingRef {
        let (p, q, faction) = self.home;
        let payer = self.payer.insecure_clone();
        let join = ix::join(
            &self.a,
            k.pubkey(),
            payer.pubkey(),
            faction,
            &Address::default(),
            0,
            None,
        );
        self.send(&[join], &[k, &payer], &format!("{who} Join"))
            .expect("Join");
        let shard = frontier_abi::addr::join_shard_of(&k.pubkey().to_bytes());
        let ph = ix::place_home(
            &self.a,
            &self.player(k),
            Site { p, q, site },
            faction,
            shard,
        );
        self.send(&[ph], &[k, &payer], &format!("{who} PlaceHome"))
            .expect("PlaceHome");
        let h = HoldingRef { p, q, site };
        let i = self.harvest(k, h);
        self.send(&[i], &[k, &payer], &format!("{who} Harvest"))
            .expect("Harvest");
        h
    }

    pub fn harvest(&self, k: &Keypair, h: HoldingRef) -> Instruction {
        let mut i = ix::harvest(&self.a, &self.player(k), h);
        i.accounts.push(AccountMeta::new_readonly(
            self.a.province(h.p as i32, h.q as i32),
            false,
        ));
        i
    }

    /// FIXTURE: tops up the holding's stores (whole units at the current time) and, with `workshops`, sets
    /// `production[ARMS]` to that many workshop copies.
    pub fn stock_holding(&mut self, h: HoldingRef, units: i64, workshops: Option<i64>) {
        let now = self.c.unix_timestamp();
        let k = h.address(&self.a);
        self.edit(&k, |d| {
            for r in [
                Resource::Ore,
                Resource::Wood,
                Resource::Stone,
                Resource::Gold,
                ARMS,
            ] {
                let o = H::store(r as usize);
                d[o + accrual::VALUE..o + accrual::VALUE + 8]
                    .copy_from_slice(&(units * MILLI).to_le_bytes());
                d[o + accrual::T0..o + accrual::T0 + 8].copy_from_slice(&now.to_le_bytes());
                d[o + accrual::FRAC..o + accrual::FRAC + 8].copy_from_slice(&0i64.to_le_bytes());
                let cap = i64::from_le_bytes(
                    d[o + accrual::CAP..o + accrual::CAP + 8]
                        .try_into()
                        .unwrap(),
                );
                if cap < units * MILLI {
                    d[o + accrual::CAP..o + accrual::CAP + 8]
                        .copy_from_slice(&(units * MILLI).to_le_bytes());
                }
            }
            if let Some(n) = workshops {
                let o = H::PRODUCTION + 8 * ARMS as usize;
                d[o..o + 8].copy_from_slice(&(n * WORKSHOP_DELTA).to_le_bytes());
            }
        });
    }

    pub fn vault_store(&self, v: &Address, r: Resource) -> i64 {
        let d = self.data(v);
        i64::from_le_bytes(
            d[VA::store(r as usize)..VA::store(r as usize) + 8]
                .try_into()
                .unwrap(),
        )
    }
}

/// The accounts the flow created or used (for the node's metadata and the test's refusals).
pub struct Demo {
    pub a: Keypair,
    pub b: Keypair,
    pub a_citizen: Address,
    pub b_citizen: Address,
    pub facility: Address,
    pub province: Address,
    pub vault: Address,
    pub pool: Address,
    pub grant: Address,
    pub lot: Address,
    pub arms: [i64; 3],
}

/// The flow of the module doc on `w` (a world of [`world`] with the coexist version and ruleset). Panics on any
/// refusal (a test, or a node that must not come up half-made).
pub fn demo(w: &mut World) -> Demo {
    let (p, q, _) = w.home;
    let (ka, kb) = (Keypair::new(), Keypair::new());
    for k in [&ka, &kb] {
        w.c.airdrop(&k.pubkey(), LAMPORTS).unwrap();
    }
    let payer = w.payer.insecure_clone();
    let sites = w.free_sites();
    assert!(sites.len() >= 2, "two free sites on the home: {sites:?}");

    // A's facility F and B's home, both real first homes in the one Province.
    let f = w.settle_in(&ka, sites[0], "A");
    let bh = w.settle_in(&kb, sites[1], "B");
    w.stock_holding(f, 400, Some(3));
    w.stock_holding(bh, 400, None);
    let (ca, cb) = (w.a.citizen(&ka.pubkey()), w.a.citizen(&kb.pubkey()));
    let fk = f.address(&w.a);
    let prov = w.a.province(p as i32, q as i32);

    // B's Vault V on a tile of the Province: the real BuildVault.
    let i = fclient::ix::v2::build_vault(&w.a, &w.player(&kb), bh, (p, q), VAULT_TILE);
    w.send(&[i], &[&kb, &payer], "B BuildVault")
        .expect("BuildVault");
    let v = w.a.vault(p as i32, q as i32, VAULT_TILE);
    // FIXTURE: a delivered caravan's ore and wood in V.
    w.edit(&v, |d| {
        for r in [Resource::Ore, Resource::Wood] {
            d[VA::store(r as usize)..VA::store(r as usize) + 8]
                .copy_from_slice(&(200 * MILLI).to_le_bytes());
        }
    });

    // ⑨ capacity: A opens F's pool and lends one workshop's capacity.
    let gen = w.data(&fk)[H::GEN];
    let pool = Address::new_from_array(fc::pool(&w.ctx, p, q, f.site, gen));
    let season = w.a.season;
    let pro = |k: &Keypair, citizen: Address| {
        vec![
            AccountMeta::new_readonly(k.pubkey(), true),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(season, false),
            AccountMeta::new(citizen, false),
        ]
    };
    let mut m = pro(&ka, ca);
    m.extend([
        AccountMeta::new_readonly(fk, false),
        AccountMeta::new(pool, false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ]);
    let open = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: CapData::OpenCapacityPool {
            policies: [0, 0, 0],
        }
        .encode(),
    };
    w.send(&[open], &[&ka, &payer], "⑨ OpenCapacityPool")
        .expect("OpenCapacityPool");
    let mut m = pro(&ka, ca);
    m.extend([AccountMeta::new(fk, false), AccountMeta::new(pool, false)]);
    let lend = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: CapData::LendCapacity { units: 1, seq: 0 }.encode(),
    };
    w.send(&[lend], &[&ka, &payer], "⑨ LendCapacity(1)")
        .expect("LendCapacity");
    let lent = u32::from_le_bytes(
        w.data(&fk)[frontier_abi::v2::layout::player::holding::LENT_WORKSHOPS..][..4]
            .try_into()
            .unwrap(),
    );
    assert_eq!(lent, 1, "F lends one workshop");
    assert!(!w.data(&pool).is_empty(), "the pool account exists");

    // ② rights: A issues a StockSwap Grant to B (facility F, station V); B reserves and executes one swap.
    let a_tag = fclient::addr::citizen_tag_u64(&ca);
    let grant = Address::new_from_array(rt::grant(&w.ctx, a_tag, 1));
    let issue = rt::IssueGrant {
        nonce: 1,
        kind: rt::KIND_STOCK_SWAP,
        max_swaps: 3,
        max_units: 30,
        expires_ts: w.c.unix_timestamp() + 86_400,
    };
    let ms = rt::accounts::issue(
        ka.pubkey().to_bytes(),
        payer.pubkey().to_bytes(),
        w.a.season.to_bytes(),
        ca.to_bytes(),
        fk.to_bytes(),
        prov.to_bytes(),
        cb.to_bytes(),
        v.to_bytes(),
        grant.to_bytes(),
    );
    let i = Instruction {
        program_id: w.a.program,
        accounts: metas(&ms),
        data: issue.to_bytes().to_vec(),
    };
    w.send(&[i], &[&ka, &payer], "② IssueGrant")
        .expect("IssueGrant");
    let use_grant = |w: &World| {
        metas(&rt::accounts::use_grant(
            kb.pubkey().to_bytes(),
            payer.pubkey().to_bytes(),
            w.a.season.to_bytes(),
            cb.to_bytes(),
            grant.to_bytes(),
            fk.to_bytes(),
            v.to_bytes(),
            prov.to_bytes(),
        ))
    };
    let arms_before = w.vault_store(&v, ARMS);
    let swap = |w: &mut World, seq: u16, what: &str| {
        let i = Instruction {
            program_id: w.a.program,
            accounts: use_grant(w),
            data: rt::ReserveSwap { units: 1, seq }.to_bytes().to_vec(),
        };
        w.send(&[i], &[&kb, &payer], &format!("② ReserveSwap(1) {what}"))
            .expect("ReserveSwap");
        let i = Instruction {
            program_id: w.a.program,
            accounts: use_grant(w),
            data: rt::ExecuteSwap { seq }.to_bytes().to_vec(),
        };
        w.send(&[i], &[&kb, &payer], &format!("② ExecuteSwap {what}"))
            .expect("ExecuteSwap");
    };
    swap(w, 0, "(StockSwap 1)");
    let arms_after = w.vault_store(&v, ARMS);
    assert!(
        arms_after > arms_before,
        "the swap's arms landed in B's Vault: {arms_before} -> {arms_after}"
    );

    // ⑩ custody: B (V's keeper) opens a lot of A's ore in V, then changes its quota.
    let a_citizen_tag = u64::from_le_bytes(
        w.data(&ca)[C::CITIZEN_TAG..C::CITIZEN_TAG + 8]
            .try_into()
            .unwrap(),
    );
    let vgen = w.data(&v)[VA::GEN];
    let ore = Resource::Ore as u8;
    let lot = Address::new_from_array(frontier_abi::v2::addr::lot(
        &w.ctx,
        p,
        q,
        VAULT_TILE,
        vgen,
        a_citizen_tag,
        ore,
    ));
    let mut m = pro(&kb, cb);
    m.extend([
        AccountMeta::new(v, false),
        AccountMeta::new_readonly(ca, false),
        AccountMeta::new(lot, false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ]);
    let i = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: frontier_abi::v2::ix::OpenLot {
            resource: ore,
            quota: 50,
        }
        .to_bytes()
        .to_vec(),
    };
    w.send(&[i], &[&kb, &payer], "⑩ OpenLot(A's ore, 50)")
        .expect("OpenLot");
    assert!(!w.data(&lot).is_empty(), "the lot exists");
    let mut m = pro(&kb, cb);
    m.extend([AccountMeta::new(v, false), AccountMeta::new(lot, false)]);
    let i = Instruction {
        program_id: w.a.program,
        accounts: m,
        data: frontier_abi::v2::ix::SetLotQuota { quota: 40 }
            .to_bytes()
            .to_vec(),
    };
    w.send(&[i], &[&kb, &payer], "⑩ SetLotQuota(40)")
        .expect("SetLotQuota");

    // ② again on the same Vault, beside the lot: the second StockSwap lands.
    swap(w, 1, "(StockSwap 2, beside the lot)");
    assert!(
        w.vault_store(&v, ARMS) > arms_after,
        "the second swap's arms landed"
    );

    let arms_final = w.vault_store(&v, ARMS);
    Demo {
        a: ka,
        b: kb,
        a_citizen: ca,
        b_citizen: cb,
        facility: fk,
        province: prov,
        vault: v,
        pool,
        grant,
        lot,
        arms: [arms_before, arms_after, arms_final],
    }
}

/// The grant's use accounts (ReserveSwap / ExecuteSwap) of `d`'s grantee.
pub fn use_grant_metas(w: &World, d: &Demo) -> Vec<AccountMeta> {
    metas(&rt::accounts::use_grant(
        d.b.pubkey().to_bytes(),
        w.payer.pubkey().to_bytes(),
        w.a.season.to_bytes(),
        d.b_citizen.to_bytes(),
        d.grant.to_bytes(),
        d.facility.to_bytes(),
        d.vault.to_bytes(),
        d.province.to_bytes(),
    ))
}

/// The player prologue `[actor s] [payer s,w] [season r] [citizen w]`.
pub fn prologue(w: &World, k: &Keypair, citizen: Address) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(k.pubkey(), true),
        AccountMeta::new(w.payer.pubkey(), true),
        AccountMeta::new_readonly(w.a.season, false),
        AccountMeta::new(citizen, false),
    ]
}
