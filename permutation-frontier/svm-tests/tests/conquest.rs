//! The MC conquest instructions (MC §3.4–§3.6, §3.10, §5.5; CQ2-C) on the
//! test-beacon build: DeclareSiege, SettleSiege, SettleCapture, FoldMarch,
//! RetireHost, CloseMarch — their effects (`g13_cq_*` with the lands
//! paths), refusals (`g13_cq_*`, one per (instruction, code)), forgery
//! (`g03_cq_*`), pre-funding (`g02_cq_*`), budgets (`g01_cq_*`, release
//! `.so`) and the properties of §13.3 that need them (`p_cq_*`).
//!
//! Crafted state (`world::conquest`, module note): the MC Season's conquest
//! block, Province / Citizen / Holding / JoinShard v2, outposts in slots
//! 2–3 and Free Cities (CQ2-A's instructions), and the conquest step of a
//! resolve through the shared `conquest_model` (CQ2-B's ResolveFromInputs).
//! Every conquest instruction itself goes through the program.

mod common;

use frontier_abi::conquest_model::{self as cm, Record};
use frontier_abi::layout::header::{EVENT_HEAD, EVENT_SEQ};
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::province::{conquest as CR, province as P, site as SM};
use frontier_abi::v2::layout::world::{join_shard as JS, march_state as MS};
use frontier_abi::v2::log::{self as l2, capture_outcome, retire_by, settle_reason, AnyKind, CqKind, EntityKind as E2};
use frontier_abi::v2::presets::{ConquestParams, MC_LOCAL_7D};
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, Build, Chain, Landed, Profile, SendResult,
};
use permutation_frontier_svm_tests::ix::conquest::{self as qix, Capture, Declare};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::{assert_cq, bit, site_report, siege_record};
use permutation_frontier_svm_tests::world::holding::{entry_at, entry_of, i64_at, read_kholding, u32_at, u64_at, Estate};
use permutation_frontier_svm_tests::world::land::provinces_of;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{Address, FrontierError as E, Instruction, Keypair, Rng, Signer};
use permutation_rules::frontier::holding::Resource;

/// The bell the tests start in.
const B0: u32 = 20;
/// The attacker's host on the target hex (whole troops).
const HOST: u32 = 500;
const GOLD: usize = Resource::Gold as usize;

// ------------------------------------------------------------ worlds

/// A running MC season (crafted conquest block, `params`) at `B0`.
fn mc_world_with(build: Build, params: &ConquestParams) -> (Chain, World) {
    let mut c = Chain::new(build);
    let w = World::running(&mut c, 1);
    w.cq_set_params(&mut c, params);
    w.to_bell(&mut c, B0, 5);
    (c, w)
}

fn mc_world() -> (Chain, World) {
    mc_world_with(Build::TestBeacon, &MC_LOCAL_7D.cq)
}

/// Ring-4 provinces of wedge `w` (outside every heartland, MC §3.1).
fn ring4(w: u8, i: usize) -> (i16, i16) {
    provinces_of(4, Some(w))[i]
}

/// The usual cast: X (faction 0) attacks; V (faction 1) owns a first
/// holding and an outpost in slot 2 on site 1 of the target Province T;
/// X's host (entry 0) stands on the outpost's hex.
struct Cast {
    c: Chain,
    w: World,
    x: Estate,
    v: Estate,
    /// V's outpost (slot 2) in T.
    o: Estate,
}

impl Cast {
    fn new() -> Cast {
        Cast::with(mc_world())
    }

    fn with((mut c, w): (Chain, World)) -> Cast {
        let x = w.cq_estate(&mut c, "x", 0, ring4(0, 0), 0);
        w.enrich(&mut c, &x, 20_000);
        let v = w.cq_estate(&mut c, "v", 1, ring4(1, 1), 0);
        w.enrich(&mut c, &v, 1_000);
        // `enrich` rewrites the kernel's shield; the cast is unshielded.
        unshield(&mut c, &x.holding);
        unshield(&mut c, &v.holding);
        let o = w.cq_outpost(&mut c, &v, ring4(1, 0), 1, 2);
        w.craft_host(&mut c, &x, &o.province, 0, 0, 0, HOST, o.tile);
        Cast { c, w, x, v, o }
    }

    /// X's DeclareSiege on the outpost (entry 0).
    fn declare_ix(&self) -> Instruction {
        declare_on(&self.w, &self.x, &self.o, 0)
    }

    /// X declares on the outpost.
    fn declare(&mut self) -> SendResult {
        let ix = self.declare_ix();
        mc_send(&mut self.c, I2::DeclareSiege, ix, &[&self.x.wallet])
    }
}

/// Sets a Holding's `shield_until` to 0.
fn unshield(c: &mut Chain, holding: &Address) {
    c.edit(holding, |d| {
        d[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8].copy_from_slice(&0i64.to_le_bytes())
    });
}

/// An address with no account (a canonical "absent" placeholder).
fn nowhere(label: &str) -> Address {
    permutation_frontier_svm_tests::keypair(format!("cq-nowhere-{label}").as_bytes()).pubkey()
}

/// The DeclareSiege accounts of `by` (src = its first holding) on the
/// holding `target` (owner = `target.citizen`) from entry `entry`.
fn declare_on(w: &World, by: &Estate, target: &Estate, entry: u8) -> Instruction {
    qix::declare_siege(
        &w.a,
        &Declare {
            actor: by.wallet.pubkey(),
            payer: by.wallet.pubkey(),
            citizen: by.citizen,
            src: by.holding,
            province: target.province,
            target: target.holding,
            owner: target.citizen,
            nearby: nowhere("nearby"),
            site: target.site,
            entry,
            nearby_site: 0,
        },
    )
}

/// The DeclareSiege accounts of `by` on the Free City at `(pq, site)`.
fn declare_free_city(w: &World, by: &Estate, pq: (i16, i16), site: u8, entry: u8) -> Instruction {
    qix::declare_siege(
        &w.a,
        &Declare {
            actor: by.wallet.pubkey(),
            payer: by.wallet.pubkey(),
            citizen: by.citizen,
            src: by.holding,
            province: w.a.province(pq.0 as i32, pq.1 as i32),
            target: w.a.holding(pq.0 as i32, pq.1 as i32, site),
            owner: nowhere("owner"),
            nearby: nowhere("nearby"),
            site,
            entry,
            nearby_site: 0,
        },
    )
}

/// Sends an ABI v2 instruction at the ladder's CU and the v2 `L(kind)`.
fn mc_send(c: &mut Chain, kind: I2, ix: Instruction, signers: &[&Keypair]) -> SendResult {
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(frontier_abi::v2::budgets::loaded_limit(kind));
    c.send_with(&p, &[ix], signers)
}

fn send_declare(c: &mut Chain, by: &Estate, ix: Instruction) -> SendResult {
    mc_send(c, I2::DeclareSiege, ix, &[&by.wallet])
}

/// The holding key in host-id form (`index<<44 | site<<40 | gen<<32`).
fn hkey(e: &Estate) -> u64 {
    frontier_abi::addr::host_id(e.p as i32, e.q as i32, e.site, e.gen, 0).expect("key")
}

fn gold(c: &Chain, holding: &Address) -> i64 {
    read_kholding(&c.data(holding)).stores[GOLD].value
}

// ------------------------------------------------------------ v2 records

/// One decoded PS2 record of an ABI v2 log (M1 or MC kind).
#[derive(Clone, Debug)]
struct R2 {
    kind: AnyKind,
    bell: u32,
    key: Vec<u8>,
    payload: Vec<u8>,
    links: Vec<l2::Link>,
}

impl R2 {
    fn u8(&self, o: usize) -> u8 {
        self.payload[o]
    }
    fn u16(&self, o: usize) -> u16 {
        u16::from_le_bytes(self.payload[o..o + 2].try_into().unwrap())
    }
    fn u32(&self, o: usize) -> u32 {
        u32::from_le_bytes(self.payload[o..o + 4].try_into().unwrap())
    }
    fn u64(&self, o: usize) -> u64 {
        u64::from_le_bytes(self.payload[o..o + 8].try_into().unwrap())
    }
    fn link(&self, e: E2) -> Vec<l2::Link> {
        self.links.iter().copied().filter(|l| l.entity == e).collect()
    }
}

fn recs(logs: &[String]) -> Vec<R2> {
    records::bodies(logs)
        .iter()
        .map(|b| {
            let r = l2::decode(b).expect("a v2 record");
            R2 {
                kind: r.kind,
                bell: r.bell,
                key: r.key.to_vec(),
                payload: r.payload.to_vec(),
                links: r.links[..r.n_links].iter().map(|l| l.expect("link")).collect(),
            }
        })
        .collect()
}

fn one(l: &Landed, k: CqKind) -> R2 {
    let v: Vec<R2> = recs(&l.logs)
        .into_iter()
        .filter(|r| r.kind == AnyKind::Cq(k))
        .collect();
    assert_eq!(v.len(), 1, "{} records of {k:?}", v.len());
    v.into_iter().next().unwrap()
}

/// The chain head of a chained account.
fn head(c: &Chain, k: &Address) -> (u64, [u8; 32]) {
    let d = c.data(k);
    (u64_at(&d, EVENT_SEQ), d[EVENT_HEAD..EVENT_HEAD + 32].try_into().unwrap())
}

/// The record advanced `k`'s chain once, by one of its links for `e`.
#[track_caller]
fn chained(c: &Chain, k: &Address, before: (u64, [u8; 32]), r: &R2, e: E2) {
    let links = r.link(e);
    let now = head(c, k);
    assert!(
        links.iter().any(|l| l.seq == now.0 && l.head == now.1),
        "{k}: the record's {e:?} link is the account's head"
    );
    assert_eq!(now.0, before.0 + 1, "{k}: seq advanced once");
}

// ------------------------------------------------------------ the siege

/// The capture-due state of the outpost after X's horn (program) and a
/// completing resolve (crafted, module note): returns the completion bell.
fn complete_capture(k: &mut Cast) -> u32 {
    expect_lands(k.declare(), "DeclareSiege");
    let mut r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    r.progress = r.required - 1;
    k.w.cq_put_record(&mut k.c, &k.o.province, k.o.site, &r);
    let b = B0 + 1;
    k.w.set_resolved_next(&mut k.c, &k.o.province, b);
    let out = k
        .w
        .cq_resolve(&mut k.c, &k.o.province, b, Some(site_report(k.o.site, bit(0), false)));
    assert_eq!(out.events()[0].code & 0x7F, l2::event::CAPTURE_DUE);
    k.w.to_bell(&mut k.c, b + 1, 5);
    b
}

/// SettleCapture of the outpost by anyone (`payer`).
fn capture_ix(k: &Cast, payer: &Keypair) -> Instruction {
    let w = &k.w;
    qix::settle_capture(
        &w.a,
        &Capture {
            fee_payer: payer.pubkey(),
            holding: k.o.holding,
            province: k.o.province,
            captor: k.x.citizen,
            captor_js: w.cq_join_shard(&k.c, &k.x),
            victim: k.v.citizen,
            victim_js: w.cq_join_shard(&k.c, &k.v),
            victim_rent_payer: k.v.wallet.pubkey(),
            stake: k.x.holding,
            site: k.o.site,
            beneficiary: payer.pubkey().to_bytes(),
        },
    )
}

/// §3.4 steps 1–10 on a capture target: the record (siege, attacker,
/// held, required = 36 + walls/50, the outpost's slot 2 reserved, the
/// declarer and the source key), the declarer's slot bit and count, the
/// escrow topped up to one `rent(1,280)` from the payer, the 500-Gold stake
/// paid from the source holding; SIEGE_DECLARED chains the Citizen, the
/// source Holding and the Province.
#[test]
fn g13_cq_declare_siege_on_an_outpost_reserves_a_slot() {
    let mut k = Cast::new();
    let walls = 400u32;
    k.c.edit(&k.o.province, |d| {
        let o = P::site(k.o.site as usize) + SM::WALLS_COMMITTED;
        d[o..o + 4].copy_from_slice(&walls.to_le_bytes())
    });
    let g0 = gold(&k.c, &k.x.holding);
    let rent = k.c.rent(H::SIZE);
    let (cl0, wl0) = (k.c.lamports(&k.x.citizen), k.c.lamports(&k.x.wallet.pubkey()));
    let hc = head(&k.c, &k.x.citizen);
    let hh = head(&k.c, &k.x.holding);
    let hp = head(&k.c, &k.o.province);
    let l = expect_lands(k.declare(), "declare_on(");
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    assert_eq!(r.kind, CR::KIND_SIEGE);
    assert_eq!(r.faction, 0);
    assert_eq!(r.flags, CR::FLAG_HELD);
    assert_eq!((r.progress, r.required), (0, 36 + 8));
    assert_eq!(CR::target_kind(r.target), CR::TARGET_OTHER);
    assert_eq!(CR::target_slot(r.target), 2);
    assert_eq!(r.bell, B0);
    assert_eq!(r.actor, k.x.citizen_tag());
    assert_eq!(r.src, hkey(&k.x));
    let away = k.w.cq_vigil_away(B0);
    assert_eq!((r.vigil_start, r.vigil_next, r.vigil_from_day), (away, away, 0));
    let cd = k.c.data(&k.x.citizen);
    assert_eq!(cd[C::SLOTS], C::SLOTS_RESERVED_2);
    assert_eq!(cd[C::SIEGES_TODAY], 1);
    assert_eq!(u16::from_le_bytes([cd[C::SIEGE_DAY], cd[C::SIEGE_DAY + 1]]), (B0 / 144) as u16);
    assert_eq!(u64_at(&cd, C::TICKET_ESCROW), rent);
    assert_eq!(cd[C::TICKET_FUNDER..C::TICKET_FUNDER + 32], k.x.wallet.pubkey().to_bytes());
    assert_eq!(k.c.lamports(&k.x.citizen), cl0 + rent);
    assert_eq!(k.c.lamports(&k.x.wallet.pubkey()) + l.fee, wl0 - rent);
    assert_eq!(gold(&k.c, &k.x.holding), g0 - 500_000, "the stake (milli-Gold)");
    let s = one(&l, CqKind::SIEGE_DECLARED);
    assert_eq!(s.bell, B0);
    assert_eq!((s.u8(0), s.u8(1), s.u8(2)), (0, 1, r.target));
    assert_eq!(s.u64(3), k.x.citizen_tag());
    assert_eq!(s.u8(11), r.required);
    assert_eq!(s.u32(18), 500, "stake");
    assert_eq!(s.u64(22), hkey(&k.x));
    assert_eq!(s.u64(30), k.v.citizen_tag(), "owner tag");
    assert_eq!(s.u64(38), k.x.host_id(0), "lead host id");
    chained(&k.c, &k.x.citizen, hc, &s, E2::Citizen);
    chained(&k.c, &k.x.holding, hh, &s, E2::Holding);
    chained(&k.c, &k.o.province, hp, &s, E2::Province);
    // A second declaration on a busy site.
    let mut f = k.c.fork();
    assert_cq(send_declare(&mut f, &k.x, k.declare_ix()), Cq::SiegeBusy);
}

/// §3.4 on a first holding (order 1): an occupation target reserves no
/// slot and tops up no escrow.
#[test]
fn g13_cq_declare_siege_on_a_first_holding_reserves_nothing() {
    let mut k = Cast::new();
    k.w.craft_host(&mut k.c, &k.x, &k.v.province, 0, 1, 0, HOST, k.v.tile);
    let cl0 = k.c.lamports(&k.x.citizen);
    let ix = declare_on(&k.w, &k.x, &k.v, 0);
    expect_lands(send_declare(&mut k.c, &k.x, ix), "declare_on(");
    let r = k.w.cq_record(&k.c, &k.v.province, k.v.site);
    assert_eq!(CR::target_kind(r.target), CR::TARGET_FIRST);
    assert_eq!(CR::target_slot(r.target), 0);
    assert_eq!(k.c.data(&k.x.citizen)[C::SLOTS], 0);
    assert_eq!(k.c.lamports(&k.x.citizen), cl0);
}

/// §3.4 on a Free City: no owner, no vigil, `neutral` flag, a slot
/// reserved; the declarer's own shield does not matter (step 8 skipped).
#[test]
fn g13_cq_declare_siege_on_a_free_city() {
    let mut k = Cast::new();
    let fc = ring4(2, 0);
    let pk = k.w.cq_free_city(&mut k.c, fc, 2, 300, 1);
    let tile = k.c.data(&pk)[P::SITES + 2];
    k.w.craft_host(&mut k.c, &k.x, &pk, 0, 1, 0, HOST, tile);
    k.c.edit(&k.x.holding, |d| {
        d[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8].copy_from_slice(&i64::MAX.to_le_bytes())
    });
    let ix = declare_free_city(&k.w, &k.x, fc, 2, 0);
    let l = expect_lands(send_declare(&mut k.c, &k.x, ix), "declare_free_city(");
    let r = k.w.cq_record(&k.c, &pk, 2);
    assert_eq!(r.flags, CR::FLAG_HELD | CR::FLAG_NEUTRAL);
    assert_eq!(CR::target_kind(r.target), CR::TARGET_FREE_CITY);
    assert_eq!(CR::target_slot(r.target), 2);
    assert_eq!((r.vigil_start, r.vigil_next, r.vigil_from_day), (0, 0, 0));
    let s = one(&l, CqKind::SIEGE_DECLARED);
    assert_eq!(s.u8(1), 6, "owner faction 6 = Free City");
    assert_eq!(s.u64(30), 0, "no owner tag");
}

/// DeclareSiege's refusals of §3.4 steps 2–7 (one per code, in step order):
/// `NotFinal` and `CapturePending` on the source, `NotBesiegeable`,
/// `CapturePending` on the target, `NotResident`, `NotOnHex`, `NotLead`,
/// `SiegeBusy`, `StakeUnsettled`, `Immune`, `SiegeCap`, `HoldingsFull`.
#[test]
fn g13_cq_declare_siege_refusals_steps_2_to_7() {
    let k = Cast::new();
    let try_ = |f: &mut Chain, ix: Instruction| send_declare(f, &k.x, ix);
    // 2. The source holding is provisional (not final).
    let mut f = k.c.fork();
    f.edit(&k.x.holding, |d| {
        d[H::STATE] = H::STATE_PROVISIONAL;
        d[H::FINAL_TS..H::FINAL_TS + 8].copy_from_slice(&i64::MAX.to_le_bytes());
    });
    assert_code(try_(&mut f, k.declare_ix()), E::NotFinal);
    // 2. The source holding is capture-locked (its own Province named as
    // `nearby`: the mirror is one generation ahead, §5.8).
    let mut f = k.c.fork();
    f.edit(&k.x.province, |d| d[P::site(k.x.site as usize) + SM::GEN] = k.x.gen + 1);
    let mut ix = k.declare_ix();
    ix.accounts[qix::at::declare::NEARBY].pubkey = k.x.province;
    assert_cq(try_(&mut f, ix), Cq::CapturePending);
    // 3. A free site is not besiegeable.
    let mut f = k.c.fork();
    let mut ix = k.declare_ix();
    ix.data[1] = 3;
    ix.accounts[qix::at::declare::TARGET].pubkey = k.w.a.holding(k.o.p as i32, k.o.q as i32, 3);
    assert_cq(try_(&mut f, ix), Cq::NotBesiegeable);
    // 3. The target holding behind its mirror (a capture completed).
    let mut f = k.c.fork();
    f.edit(&k.o.province, |d| d[P::site(k.o.site as usize) + SM::GEN] = k.o.gen + 1);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::CapturePending);
    // Resident: the target Province resolved only through now − 3.
    let mut f = k.c.fork();
    k.w.set_resolved_next(&mut f, &k.o.province, B0 - 2);
    assert_code(try_(&mut f, k.declare_ix()), E::NotResident);
    // 4. No host of the declarer on the hex: an empty entry, a host on
    // another tile, a civilian (Scout), a host of another holding.
    let mut f = k.c.fork();
    assert_cq(try_(&mut f, declare_on(&k.w, &k.x, &k.o, 9)), Cq::NotOnHex);
    let mut f = k.c.fork();
    let other_tile = k.c.data(&k.o.province)[P::SITES];
    k.w.craft_host(&mut f, &k.x, &k.o.province, 1, 1, 0, HOST, other_tile);
    assert_cq(try_(&mut f, declare_on(&k.w, &k.x, &k.o, 1)), Cq::NotOnHex);
    let mut f = k.c.fork();
    k.w.craft_host(&mut f, &k.x, &k.o.province, 1, 1, 6, HOST, k.o.tile);
    assert_cq(try_(&mut f, declare_on(&k.w, &k.x, &k.o, 1)), Cq::NotOnHex);
    // 4. (K-24) Another faction-0 host with more troops leads the hex.
    let mut f = k.c.fork();
    let y = k.w.cq_estate(&mut f, "y", 0, ring4(0, 1), 0);
    k.w.craft_host(&mut f, &y, &k.o.province, 1, 0, 0, HOST + 1, k.o.tile);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::NotLead);
    // 5. A record that owes a stake; the attacker's own faction barred.
    let mut f = k.c.fork();
    let owed = Record {
        flags: CR::FLAG_STAKE_TO_HOLDING,
        faction: CR::BARRED_NONE,
        ..Record::ZERO
    };
    k.w.cq_put_record(&mut f, &k.o.province, k.o.site, &owed);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::StakeUnsettled);
    let mut f = k.c.fork();
    let immune = Record {
        faction: 0,
        bell: B0 + 1,
        ..Record::ZERO
    };
    k.w.cq_put_record(&mut f, &k.o.province, k.o.site, &immune);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::Immune);
    let mut g = f.fork();
    // ... immunity against every faction (post-capture) bars it too
    k.w.cq_put_record(&mut g, &k.o.province, k.o.site, &Record { faction: CR::BARRED_ALL, ..immune });
    assert_cq(try_(&mut g, k.declare_ix()), Cq::Immune);
    // ... but immunity against faction 2 does not bar faction 0 (K-06),
    // and lapsed immunity bars nobody.
    let mut g = f.fork();
    k.w.cq_put_record(&mut g, &k.o.province, k.o.site, &Record { faction: 2, ..immune });
    expect_lands(try_(&mut g, k.declare_ix()), "declare past another faction's immunity");
    let mut g = f.fork();
    k.w.cq_put_record(&mut g, &k.o.province, k.o.site, &Record { bell: B0, ..immune });
    expect_lands(try_(&mut g, k.declare_ix()), "declare after immune_until_bell");
    // 6. The day's declarations used up (a count of an earlier day resets).
    let day = (B0 / 144) as u16;
    let mut f = k.c.fork();
    f.edit(&k.x.citizen, |d| {
        d[C::SIEGES_TODAY] = MC_LOCAL_7D.cq.sieges_per_day;
        d[C::SIEGE_DAY..C::SIEGE_DAY + 2].copy_from_slice(&day.to_le_bytes());
    });
    assert_cq(try_(&mut f, k.declare_ix()), Cq::SiegeCap);
    let mut f = k.c.fork();
    f.edit(&k.x.citizen, |d| {
        d[C::SIEGES_TODAY] = MC_LOCAL_7D.cq.sieges_per_day;
        d[C::SIEGE_DAY..C::SIEGE_DAY + 2].copy_from_slice(&(day + 7).to_le_bytes());
    });
    expect_lands(try_(&mut f, k.declare_ix()), "another day's count resets");
    assert_eq!(f.data(&k.x.citizen)[C::SIEGES_TODAY], 1);
    // 7. No free slot: both reserved, or slot 2 held and slot 3 ticketed.
    let mut f = k.c.fork();
    f.edit(&k.x.citizen, |d| d[C::SLOTS] = C::SLOTS_RESERVED_2 | C::SLOTS_RESERVED_3);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::HoldingsFull);
    let mut f = k.c.fork();
    k.w.cq_outpost(&mut f, &k.x, ring4(0, 2), 0, 2);
    f.edit(&k.x.citizen, |d| d[C::SLOTS] = 3);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::HoldingsFull);
    // ... a first holding needs no slot
    let mut g = f.fork();
    k.w.craft_host(&mut g, &k.x, &k.v.province, 0, 1, 0, HOST, k.v.tile);
    expect_lands(try_(&mut g, declare_on(&k.w, &k.x, &k.v, 0)), "occupation needs no slot");
}

/// DeclareSiege's refusals of §3.4 steps 8–10 and the prologue:
/// `ReservedSite`, `Friendly`, `Shielded` (target and declarer),
/// `FrontierProtected` (and the nearby first holding that lifts it),
/// `Heartland`, `TooLate`, `Insufficient` (stake and escrow),
/// `RulesetMismatch` (no conquest block), `TooManyAccounts`.
#[test]
fn g13_cq_declare_siege_refusals_steps_8_to_10() {
    let k = Cast::new();
    let try_ = |f: &mut Chain, ix: Instruction| send_declare(f, &k.x, ix);
    // 8. A Free City crafted in a Seat province (ring 1; a Seat or the
    // Concord is never a target).
    let mut f = k.c.fork();
    let seat = provinces_of(1, Some(1))[0];
    let pk = k.w.cq_free_city(&mut f, seat, 0, 300, 1);
    f.edit(&pk, |d| d[P::SITE_COUNT] = d[P::SITE_COUNT].max(1));
    let tile = f.data(&pk)[P::SITES];
    k.w.craft_host(&mut f, &k.x, &pk, 0, 1, 0, HOST, tile);
    assert_code(try_(&mut f, declare_free_city(&k.w, &k.x, seat, 0, 0)), E::ReservedSite);
    // 8. Same faction.
    let mut f = k.c.fork();
    let y = k.w.cq_estate(&mut f, "y", 0, ring4(0, 1), 0);
    let yo = k.w.cq_outpost(&mut f, &y, ring4(1, 0), 2, 2);
    k.w.craft_host(&mut f, &k.x, &yo.province, 1, 1, 0, HOST, yo.tile);
    assert_cq(try_(&mut f, declare_on(&k.w, &k.x, &yo, 1)), Cq::Friendly);
    // 8. The target shielded (not dormant); the declarer's own source
    // shielded (D-2).
    let mut f = k.c.fork();
    f.edit(&k.o.holding, |d| {
        d[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8].copy_from_slice(&i64::MAX.to_le_bytes())
    });
    assert_code(try_(&mut f, k.declare_ix()), E::Shielded);
    // ... a dormant shielded holding can be besieged
    let mut g = f.fork();
    g.edit(&k.o.holding, |d| {
        d[H::LAST_OWNER_ACTION..H::LAST_OWNER_ACTION + 8].copy_from_slice(&i64::MIN.to_le_bytes())
    });
    expect_lands(try_(&mut g, k.declare_ix()), "a dormant holding while shielded");
    let mut f = k.c.fork();
    f.edit(&k.x.holding, |d| {
        d[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8].copy_from_slice(&i64::MAX.to_le_bytes())
    });
    assert_code(try_(&mut f, k.declare_ix()), E::Shielded);
    // 8. Frontier protection: founded late, within the protection after
    // its shield, no first holding of the attacker within 2 provinces.
    let mut f = k.c.fork();
    let late = k.w.genesis_ts() + MC_LOCAL_7D.cq.frontier_protect_after_secs as i64 + 1;
    let shield_over = f.now - 1;
    f.edit(&k.o.holding, |d| {
        d[H::FOUNDED_TS..H::FOUNDED_TS + 8].copy_from_slice(&late.to_le_bytes());
        d[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8].copy_from_slice(&shield_over.to_le_bytes());
    });
    assert_cq(try_(&mut f, k.declare_ix()), Cq::FrontierProtected);
    // ... lifted by a faction-0 first holding next door, named as nearby
    let tc = permutation_rules::frontier::geometry::ProvinceCoord::new(k.o.p as i32, k.o.q as i32);
    let nb = tc
        .neighbors()
        .into_iter()
        .find(|n| n.ring() >= 4)
        .expect("a ring-4+ neighbour");
    let z = k.w.cq_estate(&mut f, "z", 0, (nb.p as i16, nb.q as i16), 0);
    let mut ix = k.declare_ix();
    ix.accounts[qix::at::declare::NEARBY].pubkey = z.province;
    ix.data[3] = z.site;
    expect_lands(try_(&mut f.fork(), ix.clone()), "nearby first holding lifts protection");
    // ... but an outpost there does not count (first holdings only)
    f.edit(&z.province, |d| d[P::site(z.site as usize) + SM::ORDER] = 2);
    assert_cq(try_(&mut f, ix), Cq::FrontierProtected);
    // 8. The owner's heartland (ring 3 of wedge 1).
    let mut f = k.c.fork();
    let ho = k.w.cq_outpost(&mut f, &k.v, provinces_of(3, Some(1))[0], 1, 3);
    k.w.craft_host(&mut f, &k.x, &ho.province, 0, 1, 0, HOST, ho.tile);
    assert_cq(try_(&mut f, declare_on(&k.w, &k.x, &ho, 0)), Cq::Heartland);
    // 9. Cannot finish before end_bell (required 36, 30 bells left, the
    // owner's vigil away from them).
    let mut f = k.c.fork();
    let end = k.w.season_u32(&f, frontier_abi::layout::world::season::END_BELL);
    let late_b = end - 31;
    k.w.to_bell(&mut f, late_b, 5);
    k.w.set_resolved_next(&mut f, &k.o.province, late_b);
    k.w.set_resolved_next(&mut f, &k.x.province, late_b);
    assert_cq(try_(&mut f, k.declare_ix()), Cq::TooLate);
    // 10. The stake: the source holding has no Gold.
    let mut f = k.c.fork();
    k.w.edit_kholding(&mut f, &k.x, |h| h.stores[GOLD].value = 0);
    unshield(&mut f, &k.x.holding);
    assert_code(try_(&mut f, k.declare_ix()), E::Insufficient);
    // 10. The escrow: a payer that cannot top it up.
    let mut f = k.c.fork();
    let poor = f.funded(b"cq-poor-payer", 0);
    f.airdrop(&poor.pubkey(), 2_000_000);
    let mut ix = k.declare_ix();
    ix.accounts[qix::at::declare::PAYER].pubkey = poor.pubkey();
    assert_code(
        mc_send(&mut f, I2::DeclareSiege, ix, &[&k.x.wallet, &poor]),
        E::Insufficient,
    );
    // The prologue: a Season without the conquest block is not an MC
    // season; an account short.
    let mut f = k.c.fork();
    f.edit(&k.w.a.season, |d| {
        let o = frontier_abi::v2::presets::SEASON_CQ_OFFSET;
        d[o..o + frontier_abi::v2::presets::CONQUEST_PARAMS_LEN].fill(0)
    });
    assert_code(try_(&mut f, k.declare_ix()), E::RulesetMismatch);
    let mut f = k.c.fork();
    let mut ix = k.declare_ix();
    ix.accounts.pop();
    assert_code(try_(&mut f, ix), E::TooManyAccounts);
}

// ------------------------------------------------------------ SettleCapture

/// A transit record on `holding`'s slot `i` in flight with its seal bond
/// escrowed (as Depart leaves it), the bond's lamports on the Holding.
fn craft_bonded_transit(c: &mut Chain, w: &World, holding: &Address, i: usize, host_id: u64) -> u64 {
    use frontier_abi::layout::player::transit as T;
    let bond = w.season_u64(c, frontier_abi::layout::world::season::SEAL_BOND);
    c.edit(holding, |d| {
        let o = H::transit(i);
        d[o + T::STATE] = T::STATE_SETTLED;
        d[o + T::HOST_ID..o + T::HOST_ID + 8].copy_from_slice(&host_id.to_le_bytes());
        d[o + T::FLAGS] = T::FLAG_BOND_ESCROWED;
        let e = u64_at(d, H::ESCROW) + bond;
        d[H::ESCROW..H::ESCROW + 8].copy_from_slice(&e.to_le_bytes());
    });
    let l = c.lamports(holding);
    c.edit_lamports(holding, l + bond);
    bond
}

/// §3.6 capture of an outpost (uncredited: the victim held it < 144
/// bells): the Holding keeps its address with the captor as owner in the
/// reserved slot at the mirror's generation, stores zeroed, shield 0,
/// `prev_owner_tag`, `prev_gen`, `prev_home` and `captured_bell`; the
/// victim's escrowed seal bonds refunded to its funder at once (P8); the
/// rent swapped from the captor's escrow to the victim's rent payer; both
/// Citizens' slot lists and JoinShards updated; the stake back at `src`;
/// the record kind 0 with post-capture immunity against every faction from
/// the completion bell. CAPTURE_SETTLED chains Holding, Province, both
/// Citizens and both JoinShards.
#[test]
fn g13_cq_settle_capture_takes_the_outpost() {
    let mut k = Cast::new();
    let bonds: u64 = (0..2)
        .map(|i| {
            let id = k.o.host_id(10 + i as u32);
            craft_bonded_transit(&mut k.c, &k.w, &k.o.holding, i, id)
        })
        .sum();
    let b = complete_capture(&mut k);
    let pd = k.c.data(&k.o.province);
    let m = P::site(k.o.site as usize);
    assert_eq!(
        (pd[m + SM::STATE], pd[m + SM::FACTION], pd[m + SM::ORDER], pd[m + SM::GEN]),
        (SM::STATE_HOLDING, 0, 2, 2),
        "the mirror flipped at the completion bell"
    );
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    assert_eq!((r.kind, r.flags & CR::FLAG_CREDITED, r.bell), (CR::KIND_CAPTURE_DUE, 0, b));
    let rent = k.c.rent(H::SIZE);
    let g_src = gold(&k.c, &k.x.holding);
    let vjs = k.w.cq_join_shard(&k.c, &k.v);
    let xjs = k.w.cq_join_shard(&k.c, &k.x);
    let heads = [
        (k.o.holding, E2::Holding),
        (k.o.province, E2::Province),
        (k.x.citizen, E2::Citizen),
        (k.v.citizen, E2::Citizen),
        (xjs, E2::JoinShard),
        (vjs, E2::JoinShard),
    ]
    .map(|(a, e)| (a, e, head(&k.c, &a)));
    let vw0 = k.c.lamports(&k.v.wallet.pubkey());
    let (xc0, ho0) = (k.c.lamports(&k.x.citizen), k.c.lamports(&k.o.holding));
    let anyone = k.c.funded(b"cq-anyone", 1);
    let ix = capture_ix(&k, &anyone);
    let l = expect_lands(mc_send(&mut k.c, I2::SettleCapture, ix.clone(), &[&anyone]), "capture_ix(");
    // The Holding.
    let hd = k.c.data(&k.o.holding);
    assert_eq!(hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], k.x.citizen.to_bytes());
    assert_eq!((hd[H::ORDER], hd[H::GEN], hd[H::FACTION], hd[H::STATE]), (2, 2, 0, H::STATE_FINAL));
    assert_eq!(i64_at(&hd, H::SHIELD_UNTIL), 0);
    assert_eq!(u64_at(&hd, H::PREV_OWNER_TAG), k.v.citizen_tag());
    assert_eq!(hd[H::PREV_GEN], 1);
    assert_eq!(hd[H::CAPTURE_FLAGS], H::CAPTURE_FLAG_CAPTURED);
    assert_eq!(u32_at(&hd, H::CAPTURED_BELL), b);
    assert_eq!(u64_at(&hd, H::PREV_HOME), hkey(&k.v));
    assert_eq!(hd[H::RENT_PAYER..H::RENT_PAYER + 32], k.x.wallet.pubkey().to_bytes());
    let kh = read_kholding(&hd);
    assert!(kh.stores.iter().all(|s| s.value == 0), "uncredited: stores zeroed");
    assert_eq!(u64_at(&hd, H::ESCROW), 0, "bonds refunded");
    // P8: the bonds and the rent swap go to the victim's funder.
    assert_eq!(k.c.lamports(&k.v.wallet.pubkey()), vw0 + bonds + rent);
    assert_eq!(k.c.lamports(&k.o.holding), ho0 - bonds);
    assert_eq!(k.c.lamports(&k.x.citizen), xc0 - rent);
    // The Citizens and JoinShards.
    let xd = k.c.data(&k.x.citizen);
    let o2 = C::holding_of_slot(2);
    assert_eq!(xd[o2 + 4..o2 + 6], [k.o.site, 2]);
    assert_eq!((xd[C::HOLDINGS_N], xd[C::SLOTS]), (2, 0));
    assert_eq!(u64_at(&xd, C::TICKET_ESCROW), 0);
    let vd = k.c.data(&k.v.citizen);
    assert_eq!(vd[o2 + 5], C::EMPTY_GEN);
    assert_eq!(vd[C::HOLDINGS_N], 1);
    assert_eq!(u32_at(&k.c.data(&xjs), JS::CAPTURED_IN), 1);
    assert_eq!(u32_at(&k.c.data(&xjs), JS::EXTRA_HOLDINGS), 1);
    assert_eq!(u32_at(&k.c.data(&vjs), JS::CAPTURED_OUT), 1);
    assert_eq!(u32_at(&k.c.data(&vjs), JS::EXTRA_HOLDINGS), 0);
    // The stake back at src; the record: immunity against every faction
    // from the completion bell (§3.6).
    // (+ the Gold the source produced since its last settle)
    let back = gold(&k.c, &k.x.holding) - g_src;
    assert!((500_000..510_000).contains(&back), "stake back: {back}");
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    assert_eq!(
        r,
        Record {
            faction: CR::BARRED_ALL,
            bell: b + 1 + MC_LOCAL_7D.cq.immunity_bells as u32,
            ..Record::ZERO
        }
    );
    let s = one(&l, CqKind::CAPTURE_SETTLED);
    assert_eq!((s.u8(0), s.u8(1)), (capture_outcome::CAPTURE, 0));
    assert_eq!((s.u64(2), s.u64(10)), (k.x.citizen_tag(), k.v.citizen_tag()));
    assert_eq!((s.u8(18), s.u8(19)), (2, 2), "new gen, slot");
    assert_eq!((s.u64(20), s.u64(28)), (rent, bonds));
    for (a, e, h0) in heads {
        chained(&k.c, &a, h0, &s, e);
    }
    // A second settle finds nothing due.
    assert_code(mc_send(&mut k.c, I2::SettleCapture, ix, &[&anyone]), E::AlreadyDone);
}

/// K-26: a credited capture (the victim held the site ≥
/// `capture_credit_min_bells`) keeps the stores and counts in
/// `captures_by`.
#[test]
fn g13_cq_settle_capture_credited_keeps_the_stores() {
    let mut params = MC_LOCAL_7D.cq;
    params.capture_credit_min_bells = 2;
    let mut k = Cast::with(mc_world_with(Build::TestBeacon, &params));
    k.c.edit(&k.o.province, |d| {
        let o = P::site(k.o.site as usize) + SM::HELD_SINCE_HOUR;
        d[o..o + 2].copy_from_slice(&0u16.to_le_bytes())
    });
    let g = gold(&k.c, &k.o.holding);
    assert!(g > 0);
    complete_capture(&mut k);
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    assert_eq!(r.flags & CR::FLAG_CREDITED, CR::FLAG_CREDITED);
    assert_eq!(u16::from_le_bytes(k.c.data(&k.o.province)[P::captures_by(0)..P::captures_by(0) + 2].try_into().unwrap()), 1);
    let anyone = k.c.funded(b"cq-anyone", 1);
    let ix = capture_ix(&k, &anyone);
    let l = expect_lands(mc_send(&mut k.c, I2::SettleCapture, ix, &[&anyone]), "capture_ix(");
    assert_eq!(one(&l, CqKind::CAPTURE_SETTLED).u8(1), 1, "credited");
    assert!(gold(&k.c, &k.o.holding) >= g, "the stores stay");
}

/// §3.6 Free City capture: the Holding created at its canonical address
/// from the reservation's rent (Hamlet at the mirror tier, empty stores,
/// the reserved slot, final), outcome 2; victim positions absent.
#[test]
fn g13_cq_settle_capture_of_a_free_city_creates_the_holding() {
    let mut k = Cast::new();
    let fc = ring4(2, 0);
    let pk = k.w.cq_free_city(&mut k.c, fc, 2, 300, 1);
    let tile = k.c.data(&pk)[P::SITES + 2];
    k.w.craft_host(&mut k.c, &k.x, &pk, 0, 1, 0, HOST, tile);
    let ix = declare_free_city(&k.w, &k.x, fc, 2, 0);
    expect_lands(send_declare(&mut k.c, &k.x, ix), "declare_free_city(");
    let mut r = k.w.cq_record(&k.c, &pk, 2);
    r.progress = r.required - 1;
    k.w.cq_put_record(&mut k.c, &pk, 2, &r);
    k.w.set_resolved_next(&mut k.c, &pk, B0 + 1);
    let out = k.w.cq_resolve(&mut k.c, &pk, B0 + 1, Some(site_report(2, bit(0), false)));
    assert_eq!(out.events()[0].code, l2::event::CAPTURE_DUE | l2::event::DETAIL, "a genesis Free City is always credited");
    let hk = k.w.a.holding(fc.0 as i32, fc.1 as i32, 2);
    assert!(k.c.is_absent(&hk));
    let anyone = k.c.funded(b"cq-anyone", 1);
    let cap = Capture {
        fee_payer: anyone.pubkey(),
        holding: hk,
        province: pk,
        captor: k.x.citizen,
        captor_js: k.w.cq_join_shard(&k.c, &k.x),
        victim: nowhere("victim"),
        victim_js: nowhere("victim-js"),
        victim_rent_payer: nowhere("victim-rent"),
        stake: k.x.holding,
        site: 2,
        beneficiary: anyone.pubkey().to_bytes(),
    };
    let rent = k.c.rent(H::SIZE);
    let xc0 = k.c.lamports(&k.x.citizen);
    let l = expect_lands(
        mc_send(&mut k.c, I2::SettleCapture, qix::settle_capture(&k.w.a, &cap), &[&anyone]),
        "qix::settle_capture(",
    );
    common::assert_program_account(&k.c, &hk, H::MAGIC, H::SIZE, k.w.id);
    let hd = k.c.data(&hk);
    assert_eq!(hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], k.x.citizen.to_bytes());
    assert_eq!((hd[H::ORDER], hd[H::GEN], hd[H::STATE], hd[H::TIER]), (2, 2, H::STATE_FINAL, 0));
    assert!(read_kholding(&hd).stores.iter().all(|s| s.value == 0));
    assert_eq!(k.c.lamports(&k.x.citizen), xc0 - rent);
    let s = one(&l, CqKind::CAPTURE_SETTLED);
    assert_eq!((s.u8(0), s.u8(1), s.u64(10)), (capture_outcome::FREE_CITY, 1, 0));
    let xd = k.c.data(&k.x.citizen);
    assert_eq!(xd[C::holding_of_slot(2) + 5], 2);
}

/// SettleCapture's refusals: `AlreadyDone` (nothing due), `NotDue` (a
/// running siege), `BadAddress` (a captor Citizen of the right faction and
/// the wrong tag), `Kernel` (the captor does not reserve the slot,
/// "CaptureRule"), `BadAccount` (the victim, its rent payer or JoinShard
/// not the Holding's), `Insufficient` (the escrow cannot pay the rent).
#[test]
fn g13_cq_settle_capture_refusals() {
    let mut k = Cast::new();
    let anyone = k.c.funded(b"cq-anyone", 1);
    // Nothing due on a quiet site.
    assert_code(
        mc_send(&mut k.c.fork(), I2::SettleCapture, capture_ix(&k, &anyone), &[&anyone]),
        E::AlreadyDone,
    );
    expect_lands(k.declare(), "DeclareSiege");
    assert_cq(
        mc_send(&mut k.c.fork(), I2::SettleCapture, capture_ix(&k, &anyone), &[&anyone]),
        Cq::NotDue,
    );
    let mut r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    r.progress = r.required - 1;
    k.w.cq_put_record(&mut k.c, &k.o.province, k.o.site, &r);
    k.w.set_resolved_next(&mut k.c, &k.o.province, B0 + 1);
    k.w.cq_resolve(&mut k.c, &k.o.province, B0 + 1, Some(site_report(k.o.site, bit(0), false)));
    let send = |f: &mut Chain, ix: Instruction| mc_send(f, I2::SettleCapture, ix, &[&anyone]);
    // A captor of the right faction but not the declarer.
    let mut f = k.c.fork();
    let y = k.w.cq_estate(&mut f, "y", 0, ring4(0, 1), 0);
    let mut ix = capture_ix(&k, &anyone);
    ix.accounts[qix::at::capture::CAPTOR].pubkey = y.citizen;
    ix.accounts[qix::at::capture::CAPTOR_JS].pubkey = k.w.cq_join_shard(&f, &y);
    assert_code(send(&mut f, ix), E::BadAddress);
    // The captor's reservation is gone (a program bug the verifier checks).
    let mut f = k.c.fork();
    f.edit(&k.x.citizen, |d| d[C::SLOTS] = 0);
    assert_code(send(&mut f, capture_ix(&k, &anyone)), E::Kernel);
    // The victim, its rent payer, its JoinShard: not the Holding's.
    let mut f = k.c.fork();
    let z = k.w.cq_estate(&mut f, "z", 1, ring4(1, 2), 0);
    for (pos, a) in [
        (qix::at::capture::VICTIM, z.citizen),
        (qix::at::capture::VICTIM_RENT_PAYER, z.wallet.pubkey()),
        (qix::at::capture::VICTIM_JS, k.w.cq_join_shard(&f, &k.x)),
    ] {
        let mut ix = capture_ix(&k, &anyone);
        ix.accounts[pos].pubkey = a;
        common_refused(send(&mut f.fork(), ix), &[E::BadAccount, E::BadAddress]);
    }
    // The escrow short of the rent.
    let mut f = k.c.fork();
    f.edit(&k.x.citizen, |d| d[C::TICKET_ESCROW..C::TICKET_ESCROW + 8].copy_from_slice(&1u64.to_le_bytes()));
    assert_code(send(&mut f, capture_ix(&k, &anyone)), E::Insufficient);
    // TooManyAccounts.
    let mut ix = capture_ix(&k, &anyone);
    ix.accounts.pop();
    assert_code(send(&mut k.c.fork(), ix), E::TooManyAccounts);
}

/// The program refused with one of `codes` (a forged account may be
/// refused by its address or its kind check first).
#[track_caller]
fn common_refused(r: SendResult, codes: &[E]) {
    match r {
        Ok(l) => panic!("expected one of {codes:?}, landed:\n{}", l.logs.join("\n")),
        Err(f) => assert!(
            codes.iter().any(|e| f.code == Some(e.code())),
            "expected one of {codes:?}, got {:?}\n{}",
            f.code.and_then(E::from_code),
            f.logs.join("\n")
        ),
    }
}
