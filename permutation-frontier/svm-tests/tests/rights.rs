//! Workstream 02-rights, **option A** (owner decision ② = A, 2026-11-18):
//! the workshop-stock swap whose output lands in the grantee's **Vault** in
//! the facility's Province and leaves it only by caravan. Runs the
//! `rights-experimental` + `test-beacon` SBF build (`Build::Rights`,
//! `scripts/build-frontier.sh --features rights-test-beacon`, never
//! deployable) in LiteSVM.
//!
//! Every Grant instruction, BuildVault, SendCaravan, SettleCaravan and
//! RaidCaravan goes through the program. Crafted state (as in
//! `caravan.rs`): the estates (`World::cq_estate`), their stores
//! (`enrich`), the facility's workshops (`edit_kholding`), the resolves
//! (`set_resolved_next`), a session key on a Citizen, and the **open raid**
//! in a caravan slot (until stage 1c the clash does not raid caravans; the
//! slot is written as the clash will).
//!
//! What is shown (the brief's list):
//! - swap → the grantee's Vault (none of it reaches a holding);
//! - the arms leave the Vault by caravan (SendCaravan + SettleCaravan);
//! - that haul can be raided (RaidCaravan take: the raider gets the arms);
//! - a session key cannot issue (`WalletRequired`), the wallet can, and
//!   pays `GRANT_ISSUE_COST` (25 gold) from the facility;
//! - a self-issuance to the issuer's own alt account gives the alt arms
//!   only in its Vault, whose haul out is as raidable as anyone's (and a
//!   holding station is refused, `BadStation`).
//!
//! CU of every Grant instruction is printed (`rights-cu …` lines on
//! stderr; run with `--nocapture`).

use fclient::ix::v2::{self as fx, PlaceRef, RaidCaravanArgs, SendCaravanArgs};
use fclient::ix::Player;
use frontier_abi::addr::AddrCtx;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{caravan_slot as CS, province as P};
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use frontier_abi::v2::log::{raid_choice, CqKind};
use frontier_abi::v2::presets::MC_LOCAL_7D;
use frontier_abi::v2::rights::{self as rt, layout as G, RightsError};
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::{
    i64_at, read_kholding, trace, u32_at, u64_at, Estate,
};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{AccountMeta, Address, Instruction, Keypair, Signer};
use permutation_rules::frontier::arms;
use permutation_rules::frontier::caravan::{
    self as kc, caravan_id, CaravanSlot, CARAVAN_FEE, MAX_CARAVAN_SLOTS,
};
use permutation_rules::frontier::holding::Resource;

const B0: u32 = 20;
const MILLI: i64 = 1_000;
const ORE: usize = Resource::Ore as usize;
const WOOD: usize = Resource::Wood as usize;
const GOLD: usize = Resource::Gold as usize;
const ARMS: usize = arms::ARMS as usize;

// ------------------------------------------------------------ helpers

fn k32(a: &Address) -> [u8; 32] {
    <[u8; 32]>::try_from(a.as_ref()).unwrap()
}

fn ix_of(c: &Chain, metas: &[([u8; 32], bool, bool)], data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: c.program,
        accounts: metas
            .iter()
            .map(|(k, s, w)| {
                let a = Address::new_from_array(*k);
                if *w {
                    AccountMeta::new(a, *s)
                } else {
                    AccountMeta::new_readonly(a, *s)
                }
            })
            .collect(),
        data,
    }
}

/// A Grant instruction under the CU ladder's ceiling and a loaded-data
/// limit covering the program and a dozen accounts.
fn send_rights(c: &mut Chain, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let loaded =
        permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), 64 * 1024, 12)
            .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT);
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(loaded);
    c.send_with(&p, &[ix], signers)
}

fn s1_send(c: &mut Chain, kind: I2, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let (bytes, n) = frontier_abi::v2::budgets::loaded_accounts(kind);
    let loaded = permutation_rules::frontier::fees::loaded_limit(c.programdata_len(), bytes, n)
        .max(frontier_abi::budgets::LOADED_LIMIT_WORKING_DEFAULT);
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(loaded);
    c.send_with(&p, &[ix], signers)
}

#[track_caller]
fn assert_rights(r: SendResult, e: RightsError) {
    match r {
        Ok(l) => panic!("expected {e:?}, landed:\n{}", l.logs.join("\n")),
        Err(f) => assert_eq!(
            f.code,
            Some(e.code()),
            "{e:?}: {}\n{}",
            f.err,
            f.logs.join("\n")
        ),
    }
}

fn cu(what: &str, l: &Landed) {
    eprintln!("rights-cu {what} {} tx_bytes {}", l.cu, l.tx_bytes);
}

fn store(c: &Chain, holding: &Address, r: usize) -> i64 {
    read_kholding(&c.data(holding)).stores[r].value
}

fn vault_store(c: &Chain, vault: &Address, r: usize) -> i64 {
    i64_at(&c.data(vault), VA::store(r))
}

/// A shortest path from `from` to `to` over the passable tiles of the
/// estate's Province, never leaving it (as `caravan.rs`).
fn local_dirs(c: &Chain, e: &Estate, from: u8, to: u8) -> Option<Vec<u8>> {
    use std::collections::{HashMap, VecDeque};
    let pass = u64_at(&c.data(&e.province), P::PASSABLE_MASK);
    let (p, q) = (e.p as i32, e.q as i32);
    let mut prev: HashMap<u8, (u8, u8)> = HashMap::new();
    let mut queue = VecDeque::from([from]);
    prev.insert(from, (from, 9));
    while let Some(t) = queue.pop_front() {
        if t == to {
            let mut dirs = vec![];
            let mut x = t;
            while x != from {
                let (pr, d) = prev[&x];
                dirs.push(d);
                x = pr;
            }
            dirs.reverse();
            return Some(dirs);
        }
        for d in 0..6u8 {
            let s = trace((p, q, t), &[d])[0];
            if (s.p, s.q) != (p, q) || pass & (1u64 << s.tile) == 0 || prev.contains_key(&s.tile) {
                continue;
            }
            prev.insert(s.tile, (t, d));
            queue.push_back(s.tile);
        }
    }
    None
}

fn local_path(c: &Chain, e: &Estate, from: u8, to: u8) -> (u8, [u8; 12]) {
    let dirs = local_dirs(c, e, from, to).expect("a path");
    (dirs.len() as u8, kc::pack(&dirs).expect("packs"))
}

/// A non-site tile `n` steps from the estate's holding tile.
fn far_tile(c: &Chain, e: &Estate, n: usize, not: &[u8]) -> u8 {
    let pd = c.data(&e.province);
    let sites = &pd[P::SITES..P::SITES + pd[P::SITE_COUNT] as usize];
    (0..61u8)
        .find(|&t| {
            !sites.contains(&t)
                && !not.contains(&t)
                && local_dirs(c, e, e.tile, t).is_some_and(|d| d.len() == n)
        })
        .expect("a tile n steps away")
}

fn slot_of(c: &Chain, province: &Address, id: u64) -> Option<(usize, CaravanSlot)> {
    let d = c.data(province);
    (0..MAX_CARAVAN_SLOTS)
        .map(|i| CaravanSlot::decode(&d[CS::at(i)..CS::at(i) + CS::SIZE]).unwrap())
        .enumerate()
        .find(|(_, s)| s.id == id)
}

fn put_slot(c: &mut Chain, province: &Address, i: usize, s: &CaravanSlot) {
    c.edit(province, |d| {
        assert!(s.encode(&mut d[CS::at(i)..CS::at(i) + CS::SIZE]).is_some());
    });
}

fn session_of(c: &mut Chain, e: &Estate, label: &[u8]) -> Keypair {
    let session = c.funded(label, 1);
    let exp = c.now + 3_600;
    c.edit(&e.citizen, |d| {
        d[C::SESSION..C::SESSION + 32].copy_from_slice(&session.pubkey().to_bytes());
        d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&exp.to_le_bytes());
    });
    session
}

// ------------------------------------------------------------ the cast

/// Province T (ring 4, every tile open): A (faction 0, site 0) owns the
/// workshop facility; B (faction 0, site 2) is the grantee with a Vault on
/// `vt`; R (faction 1, site 1) is a raider next door.
struct Cast {
    c: Chain,
    w: World,
    a: Estate,
    b: Estate,
    r: Estate,
    vt: u8,
}

impl Cast {
    fn new() -> Cast {
        let mut c = Chain::new(Build::Rights);
        let w = World::running(&mut c, 1);
        w.cq_set_params(&mut c, &MC_LOCAL_7D.cq);
        w.to_bell(&mut c, B0, 5);
        let t = provinces_of(4, Some(0))[0];
        let a = w.cq_estate(&mut c, "a", 0, t, 0);
        let r = w.cq_estate(&mut c, "r", 1, t, 1);
        let b = w.cq_estate(&mut c, "b", 0, t, 2);
        w.open_tiles(&mut c, t.0, t.1, &(0..61).collect::<Vec<u8>>());
        for e in [&a, &b, &r] {
            w.enrich(&mut c, e, 5_000);
        }
        // A's facility: two workshops, no gold income (so the issue cost
        // reads exactly). B and R make no arms of their own (so every arm
        // they hold came by the Grant or a caravan).
        w.edit_kholding(&mut c, &a, |h| {
            h.production[ARMS] = 2 * arms::WORKSHOP_DELTA;
            h.production[GOLD] = 0;
        });
        for e in [&b, &r] {
            w.edit_kholding(&mut c, e, |h| h.production[ARMS] = 0);
        }
        let vt = far_tile(&c, &b, 3, &[]);
        let mut k = Cast { c, w, a, b, r, vt };
        let pv = k.c.data(&k.a.province)[P::SITE_COUNT];
        assert!(pv >= 3, "three sites in T");
        k.build_vault_of(&k.b.clone_estate(), vt);
        k
    }

    fn ctx(&self) -> AddrCtx {
        AddrCtx {
            season: k32(&self.w.a.season),
            program: k32(&self.c.program),
        }
    }

    fn season(&self) -> [u8; 32] {
        k32(&self.w.a.season)
    }

    fn vault_of(&self, e: &Estate, tile: u8) -> Address {
        self.w.a.vault(e.p as i32, e.q as i32, tile)
    }

    fn build_vault_of(&mut self, e: &Estate, tile: u8) {
        let ix = fx::build_vault(&self.w.a, &e.player(), e.href(), (e.p, e.q), tile);
        expect_lands(
            s1_send(&mut self.c, I2::BuildVault, ix, &[&e.wallet]),
            "BuildVault",
        );
    }

    /// Hauls `cargo` (whole units) from `from` to `to` (one Province, the
    /// owner's wallet) and returns the caravan's sequence and address.
    fn send(
        &mut self,
        owner: &Estate,
        src: PlaceRef,
        dst: PlaceRef,
        from: u8,
        to: u8,
        cargo: [u32; 8],
    ) -> (u32, Address) {
        let seq = u32_at(&self.c.data(&owner.citizen), C::CARAVANS);
        let (steps, path) = local_path(&self.c, owner, from, to);
        let x = SendCaravanArgs {
            seq,
            src,
            dst,
            steps,
            path,
            cargo,
            fee: CARAVAN_FEE,
            provinces: vec![(owner.p, owner.q)],
        };
        let ix = fx::send_caravan(&self.w.a, &owner.player(), &x);
        expect_lands(
            s1_send(&mut self.c, I2::SendCaravan, ix, &[&owner.wallet]),
            "SendCaravan",
        );
        (seq, self.w.a.caravan(owner.citizen_tag(), seq))
    }

    fn arrive(&mut self, caravan: &Address) {
        let d = self.c.data(caravan);
        let arrive = i64_at(&d, CV::ARRIVE_TS);
        let last = u32_at(&d, CV::LAST_BELL);
        if self.c.now <= arrive {
            self.c.set_time(arrive + 1);
        }
        let b = self.w.bell(&self.c).max(last + 1);
        let prov = self.a.province;
        self.w.set_resolved_next(&mut self.c, &prov, b);
    }

    fn settle(&mut self, caravan: Address, dst: Address) -> Landed {
        self.arrive(&caravan);
        let keeper = self.c.funded(b"rights-keeper", 1);
        let rent_to = Address::new_from_array(
            self.c.data(&caravan)[CV::RENT_TO..CV::RENT_TO + 32]
                .try_into()
                .unwrap(),
        );
        let ix = fx::settle_caravan(
            &self.w.a,
            keeper.pubkey(),
            caravan,
            dst,
            keeper.pubkey(),
            rent_to,
            &[(self.a.p, self.a.q)],
        );
        expect_lands(
            s1_send(&mut self.c, I2::SettleCaravan, ix, &[&keeper]),
            "SettleCaravan",
        )
    }

    fn vplace(&self, e: &Estate, tile: u8) -> PlaceRef {
        PlaceRef::Vault {
            p: e.p,
            q: e.q,
            tile,
            gen: self.c.data(&self.vault_of(e, tile))[VA::GEN],
        }
    }

    fn hplace(e: &Estate) -> PlaceRef {
        PlaceRef::Holding {
            h: e.href(),
            gen: e.gen,
        }
    }

    /// Ore and wood into `e`'s Vault the only way they get there: a caravan
    /// from its holding.
    fn stock_vault_by_caravan(&mut self, e: &Estate, tile: u8, ore: u32, wood: u32) {
        let mut cargo = [0u32; 8];
        cargo[ORE] = ore;
        cargo[WOOD] = wood;
        let (src, dst) = (Cast::hplace(e), self.vplace(e, tile));
        let (_, cv) = self.send(e, src, dst, e.tile, tile, cargo);
        let v = self.vault_of(e, tile);
        self.settle(cv, v);
    }

    fn grant(&self, nonce: u32) -> [u8; 32] {
        rt::grant(&self.ctx(), self.a.citizen_tag(), nonce)
    }

    fn issue(
        &mut self,
        actor: &Player,
        signer: &Keypair,
        grantee: &Estate,
        station: Address,
        nonce: u32,
    ) -> SendResult {
        let x = rt::IssueGrant {
            nonce,
            kind: rt::KIND_STOCK_SWAP,
            max_swaps: 3,
            max_units: 60,
            expires_ts: self.c.now + 86_400,
        };
        let m = rt::accounts::issue(
            k32(&actor.actor),
            k32(&actor.payer),
            self.season(),
            k32(&self.a.citizen),
            k32(&self.a.holding),
            k32(&self.a.province),
            k32(&grantee.citizen),
            k32(&station),
            self.grant(nonce),
        );
        let ix = ix_of(&self.c, &m, x.to_bytes().to_vec());
        send_rights(&mut self.c, ix, &[signer])
    }

    fn use_ix(
        &self,
        actor: &Player,
        citizen: &Address,
        nonce: u32,
        station: Address,
        data: Vec<u8>,
    ) -> Instruction {
        let m = rt::accounts::use_grant(
            k32(&actor.actor),
            k32(&actor.payer),
            self.season(),
            k32(citizen),
            self.grant(nonce),
            k32(&self.a.holding),
            k32(&station),
            k32(&self.a.province),
        );
        ix_of(&self.c, &m, data)
    }

    fn seq(&self, nonce: u32) -> u16 {
        let d = self.c.data(&Address::new_from_array(self.grant(nonce)));
        u16::from_le_bytes(d[G::SWAPS..G::SWAPS + 2].try_into().unwrap())
    }

    fn reserve(
        &mut self,
        who: &Estate,
        by: &Player,
        signer: &Keypair,
        nonce: u32,
        station: Address,
        units: u32,
    ) -> SendResult {
        let seq = self.seq(nonce);
        let ix = self.use_ix(
            by,
            &who.citizen,
            nonce,
            station,
            rt::ReserveSwap { units, seq }.to_bytes().to_vec(),
        );
        send_rights(&mut self.c, ix, &[signer])
    }

    fn execute(
        &mut self,
        who: &Estate,
        by: &Player,
        signer: &Keypair,
        nonce: u32,
        station: Address,
    ) -> SendResult {
        let seq = self.seq(nonce);
        let ix = self.use_ix(
            by,
            &who.citizen,
            nonce,
            station,
            rt::ExecuteSwap { seq }.to_bytes().to_vec(),
        );
        send_rights(&mut self.c, ix, &[signer])
    }

    /// R's host raids `owner`'s caravan `seq` on its first slot tile (the
    /// slot written as the stage-1c clash will) and takes it home to R's
    /// holding.
    fn raid_take(&mut self, owner: &Estate, seq: u32) -> Landed {
        let id = caravan_id(owner.citizen_tag(), seq);
        let (i, mut s) = slot_of(&self.c, &self.a.province, id).expect("the haul's slot");
        s.raid_off = 0;
        s.raid_pos = 0;
        s.raider = self.r.host_id(0);
        let raid_tile = s.tiles[0];
        put_slot(&mut self.c, &self.a.province, i, &s);
        let raid_bell = s.first_bell;
        self.w.to_bell(&mut self.c, raid_bell + 1, 5);
        let prov = self.a.province;
        self.w.set_resolved_next(&mut self.c, &prov, raid_bell + 1);
        let (steps, path) = local_path(&self.c, &self.r, raid_tile, self.r.tile);
        let x = RaidCaravanArgs {
            caravan: self.w.a.caravan(owner.citizen_tag(), seq),
            raid: (self.a.p, self.a.q),
            raider_holding: self.r.href(),
            choice: raid_choice::TAKE,
            dst: Some(Cast::hplace(&self.r)),
            steps,
            path,
            path_provinces: vec![],
            old_route: vec![(self.a.p, self.a.q)],
        };
        let ix = fx::raid_caravan(&self.w.a, &self.r.player(), &x);
        expect_lands(
            s1_send(&mut self.c, I2::RaidCaravan, ix, &[&self.r.wallet]),
            "RaidCaravan take",
        )
    }
}

trait CloneEstate {
    fn clone_estate(&self) -> Estate;
}

impl CloneEstate for Estate {
    fn clone_estate(&self) -> Estate {
        Estate {
            wallet: self.wallet.insecure_clone(),
            faction: self.faction,
            p: self.p,
            q: self.q,
            site: self.site,
            gen: self.gen,
            tile: self.tile,
            holding: self.holding,
            province: self.province,
            citizen: self.citizen,
        }
    }
}

// ------------------------------------------------------------ the tests

/// Swap → the grantee's Vault; then the haul out by caravan reaches the
/// grantee's holding. CU of IssueGrant, ReserveSwap and ExecuteSwap.
#[test]
fn rights_swap_lands_in_the_vault_and_leaves_only_by_caravan() {
    let mut k = Cast::new();
    let b = k.b.clone_estate();
    let vt = k.vt;
    let v = k.vault_of(&b, vt);
    k.stock_vault_by_caravan(&b, vt, 100, 50);
    assert_eq!(
        (vault_store(&k.c, &v, ORE), vault_store(&k.c, &v, WOOD)),
        (100 * MILLI, 50 * MILLI)
    );

    // The issue: A's wallet; 25 gold from the facility. A second Grant at
    // the same clock shows the cost exactly (the first one also settles
    // the facility's accrual since its last write).
    let ap = k.a.player();
    let aw = k.a.wallet.insecure_clone();
    let l = expect_lands(k.issue(&ap, &aw, &b, v, 0), "IssueGrant");
    cu("IssueGrant", &l);
    let rec = records::one_cq(&l.logs, CqKind::GRANT_ISSUED);
    records::check_any_tail(&rec);
    let gold0 = store(&k.c, &k.a.holding, GOLD);
    expect_lands(k.issue(&ap, &aw, &b, v, 1), "a second IssueGrant");
    let gold1 = store(&k.c, &k.a.holding, GOLD);
    assert_eq!(
        gold0 - gold1,
        rt::grant_issue_cost()[GOLD],
        "the issue cost: 25 gold"
    );

    // Reserve and execute 20 arms (same clock: exact deltas).
    let (fa0, fo0, fw0) = (
        store(&k.c, &k.a.holding, ARMS),
        store(&k.c, &k.a.holding, ORE),
        store(&k.c, &k.a.holding, WOOD),
    );
    let b_arms0 = store(&k.c, &b.holding, ARMS);
    let bp = b.player();
    let l = expect_lands(k.reserve(&b, &bp, &b.wallet, 0, v, 20), "ReserveSwap");
    cu("ReserveSwap", &l);
    records::check_any_tail(&records::one_cq(&l.logs, CqKind::SWAP_RESERVED));
    assert_eq!(vault_store(&k.c, &v, ORE), 60 * MILLI);
    assert_eq!(vault_store(&k.c, &v, WOOD), 30 * MILLI);
    let l = expect_lands(k.execute(&b, &bp, &b.wallet, 0, v), "ExecuteSwap");
    cu("ExecuteSwap", &l);
    records::check_any_tail(&records::one_cq(&l.logs, CqKind::SWAP_EXECUTED));
    assert_eq!(
        vault_store(&k.c, &v, ARMS),
        20 * MILLI,
        "the arms are in B's Vault"
    );
    assert_eq!(
        store(&k.c, &b.holding, ARMS),
        b_arms0,
        "and in none of B's holdings"
    );
    let (fa1, fo1, fw1) = (
        store(&k.c, &k.a.holding, ARMS),
        store(&k.c, &k.a.holding, ORE),
        store(&k.c, &k.a.holding, WOOD),
    );
    assert_eq!(fa0 - fa1, 20 * MILLI);
    assert_eq!(fo1 - fo0, 40 * MILLI);
    assert_eq!(fw1 - fw0, 20 * MILLI);

    // The haul: SendCaravan from the Vault to B's holding, then settled.
    let mut cargo = [0u32; 8];
    cargo[ARMS] = 20;
    let (src, dst) = (k.vplace(&b, vt), Cast::hplace(&b));
    let (_, cv) = k.send(&b, src, dst, vt, b.tile, cargo);
    assert_eq!(
        vault_store(&k.c, &v, ARMS),
        0,
        "the Vault is debited at departure"
    );
    k.settle(cv, b.holding);
    assert!(
        store(&k.c, &b.holding, ARMS) >= b_arms0 + 20 * MILLI,
        "the arms reach B's holding by caravan"
    );
}

/// The haul out of the Vault is a caravan like any other: R raids it and
/// takes the arms home; B gets nothing.
#[test]
fn rights_haul_out_of_the_vault_can_be_raided() {
    let mut k = Cast::new();
    let b = k.b.clone_estate();
    let vt = k.vt;
    let v = k.vault_of(&b, vt);
    k.stock_vault_by_caravan(&b, vt, 100, 50);
    let ap = k.a.player();
    let aw = k.a.wallet.insecure_clone();
    expect_lands(k.issue(&ap, &aw, &b, v, 0), "IssueGrant");
    let bp = b.player();
    expect_lands(k.reserve(&b, &bp, &b.wallet, 0, v, 20), "ReserveSwap");
    expect_lands(k.execute(&b, &bp, &b.wallet, 0, v), "ExecuteSwap");
    let b_arms0 = store(&k.c, &b.holding, ARMS);
    let r_arms0 = store(&k.c, &k.r.holding, ARMS);
    let mut cargo = [0u32; 8];
    cargo[ARMS] = 20;
    let (src, dst) = (k.vplace(&b, vt), Cast::hplace(&b));
    let (seq, cv) = k.send(&b, src, dst, vt, b.tile, cargo);
    let l = k.raid_take(&b, seq);
    let cd = k.c.data(&cv);
    assert_eq!(
        &cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref(),
        "the caravan is R's"
    );
    assert_eq!(
        i64_at(&cd, CV::cargo(ARMS)),
        20 * MILLI,
        "with the whole cargo"
    );
    records::one_cq(&l.logs, CqKind::CARAVAN_RAIDED);
    let rh = k.r.holding;
    k.settle(cv, rh);
    assert!(
        store(&k.c, &k.r.holding, ARMS) >= r_arms0 + 20 * MILLI,
        "R took the arms home"
    );
    assert!(
        store(&k.c, &b.holding, ARMS) < b_arms0 + 20 * MILLI,
        "B's holding got none of them"
    );
    assert_eq!(vault_store(&k.c, &v, ARMS), 0);
}

/// Issuing is wallet-only: A's live session key is refused
/// (`WalletRequired`) and nothing is created or paid; A's wallet issues.
/// The grantee's session may still use the Grant (it only moves the
/// grantee's own Vault stock). Also a revoke, a release and a close, for
/// their CU.
#[test]
fn rights_session_key_cannot_issue() {
    let mut k = Cast::new();
    let b = k.b.clone_estate();
    let vt = k.vt;
    let v = k.vault_of(&b, vt);
    k.stock_vault_by_caravan(&b, vt, 100, 50);
    let a = k.a.clone_estate();
    let sess = session_of(&mut k.c, &a, b"rights-a-session");
    let by_sess = Player {
        actor: sess.pubkey(),
        payer: sess.pubkey(),
        wallet: a.wallet.pubkey(),
    };
    let f0 = k.c.data(&a.holding);
    assert_cq(k.issue(&by_sess, &sess, &b, v, 0), Cq::WalletRequired);
    assert!(
        k.c.data(&Address::new_from_array(k.grant(0))).is_empty(),
        "no Grant"
    );
    assert_eq!(k.c.data(&a.holding), f0, "nothing paid");
    expect_lands(
        k.issue(&a.player(), &a.wallet, &b, v, 0),
        "IssueGrant by the wallet",
    );

    // The grantee's session uses it.
    let bs = session_of(&mut k.c, &b, b"rights-b-session");
    let bsp = Player {
        actor: bs.pubkey(),
        payer: bs.pubkey(),
        wallet: b.wallet.pubkey(),
    };
    expect_lands(
        k.reserve(&b, &bsp, &bs, 0, v, 5),
        "ReserveSwap by the grantee's session",
    );
    let l = expect_lands(
        k.execute(&b, &bsp, &bs, 0, v),
        "ExecuteSwap by the grantee's session",
    );
    cu("ExecuteSwap(session)", &l);
    // A release (grantee), a revoke (issuer's wallet) over an open
    // reservation, then the close.
    expect_lands(
        k.reserve(&b, &b.player(), &b.wallet, 0, v, 5),
        "ReserveSwap",
    );
    let m = rt::accounts::release(
        k32(&b.wallet.pubkey()),
        k.season(),
        k32(&b.citizen),
        k.grant(0),
        k32(&a.holding),
        k32(&v),
        k32(&a.province),
    );
    let ix = ix_of(&k.c, &m, rt::ReleaseSwap {}.to_bytes().to_vec());
    let l = expect_lands(send_rights(&mut k.c, ix, &[&b.wallet]), "ReleaseSwap");
    cu("ReleaseSwap", &l);
    expect_lands(
        k.reserve(&b, &b.player(), &b.wallet, 0, v, 5),
        "ReserveSwap",
    );
    let ix = k.use_ix(
        &a.player(),
        &a.citizen,
        0,
        v,
        rt::RevokeGrant {}.to_bytes().to_vec(),
    );
    let l = expect_lands(send_rights(&mut k.c, ix, &[&a.wallet]), "RevokeGrant");
    cu("RevokeGrant", &l);
    records::check_any_tail(&records::one_cq(&l.logs, CqKind::GRANT_REVOKED));
    let rent_to = a.wallet.pubkey();
    let keeper = k.c.funded(b"rights-closer", 1);
    let m = rt::accounts::close(k32(&keeper.pubkey()), k.season(), k.grant(0), k32(&rent_to));
    let ix = ix_of(&k.c, &m, rt::CloseGrant {}.to_bytes().to_vec());
    let l = expect_lands(send_rights(&mut k.c, ix, &[&keeper]), "CloseGrant");
    cu("CloseGrant", &l);
}

/// 04-PROPOSALS §4: A issues to its own second account A2. A holding as the
/// station is refused (`BadStation`): the swap only fills A2's **Vault**,
/// and A2's haul out of it is raided like anyone's. No raid-free transfer
/// path exists.
#[test]
fn rights_self_issuance_to_an_alt_does_not_create_a_safe_path() {
    let mut k = Cast::new();
    let t = (k.a.p, k.a.q);
    let a2 = k.w.cq_estate(&mut k.c, "a2", 0, t, 3);
    k.w.enrich(&mut k.c, &a2, 5_000);
    k.w.edit_kholding(&mut k.c, &a2, |h| h.production[ARMS] = 0);
    let vt2 = far_tile(&k.c, &a2, 2, &[k.vt]);
    k.build_vault_of(&a2.clone_estate(), vt2);
    let v2 = k.vault_of(&a2, vt2);
    let ap = k.a.player();
    let aw = k.a.wallet.insecure_clone();
    // A2's holding is no station (option A).
    assert_rights(
        k.issue(&ap, &aw, &a2, a2.holding, 7),
        RightsError::BadStation,
    );
    k.stock_vault_by_caravan(&a2, vt2, 100, 50);
    expect_lands(
        k.issue(&ap, &aw, &a2, v2, 7),
        "IssueGrant to the alt's Vault",
    );
    let a2_arms0 = store(&k.c, &a2.holding, ARMS);
    let a2p = a2.player();
    expect_lands(k.reserve(&a2, &a2p, &a2.wallet, 7, v2, 30), "ReserveSwap");
    expect_lands(k.execute(&a2, &a2p, &a2.wallet, 7, v2), "ExecuteSwap");
    assert_eq!(vault_store(&k.c, &v2, ARMS), 30 * MILLI);
    assert_eq!(
        store(&k.c, &a2.holding, ARMS),
        a2_arms0,
        "no arms reach the alt's holding by the Grant"
    );
    // The alt's only way to use them elsewhere: a caravan — raided.
    let r_arms0 = store(&k.c, &k.r.holding, ARMS);
    let mut cargo = [0u32; 8];
    cargo[ARMS] = 30;
    let (src, dst) = (k.vplace(&a2, vt2), Cast::hplace(&a2));
    let (seq, cv) = k.send(&a2, src, dst, vt2, a2.tile, cargo);
    k.raid_take(&a2, seq);
    let rh = k.r.holding;
    k.settle(cv, rh);
    assert!(
        store(&k.c, &k.r.holding, ARMS) >= r_arms0 + 30 * MILLI,
        "the raider has them"
    );
    assert!(
        store(&k.c, &a2.holding, ARMS) < a2_arms0 + 30 * MILLI,
        "the alt does not"
    );
}
