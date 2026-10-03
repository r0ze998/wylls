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

// ------------------------------------------------------------ SettleSiege

/// X declares on the outpost and the next resolve (crafted, module note)
/// reports `rep` for the site: returns that bell.
fn declare_then(k: &mut Cast, holders: u8, defender: bool) -> u32 {
    expect_lands(k.declare(), "DeclareSiege");
    let b = B0 + 1;
    k.w.set_resolved_next(&mut k.c, &k.o.province, b);
    k.w.cq_resolve(&mut k.c, &k.o.province, b, Some(site_report(k.o.site, holders, defender)));
    k.w.to_bell(&mut k.c, b + 1, 5);
    b
}

/// SettleSiege of the outpost's record: the recipient and the slot
/// Citizen given, the funder X's wallet when a slot is owed.
fn settle_siege_ix(k: &Cast, payer: &Keypair, recipient: Address, slot: bool) -> Instruction {
    qix::settle_siege(
        &k.w.a,
        payer.pubkey(),
        k.o.province,
        recipient,
        if slot { k.x.citizen } else { nowhere("slot-citizen") },
        slot.then(|| k.x.wallet.pubkey()),
        k.o.site,
    )
}

/// §3.4 failure broken by the defender: the stake is owed to the target
/// holding at its generation and the attacker's faction is barred for 36
/// bells; SettleSiege (anyone) pays it into the holding's Gold, releases
/// the reserved slot with one `rent(1,280)` back to the escrow's funder,
/// keeps the immunity and logs SIEGE_SETTLED (reason 0, slot 2).
#[test]
fn g13_cq_settle_siege_pays_the_defender_and_frees_the_slot() {
    let mut k = Cast::new();
    let b = declare_then(&mut k, 0, true);
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    let immune = b + 1 + MC_LOCAL_7D.cq.immunity_bells as u32;
    assert_eq!(
        r,
        Record {
            faction: 0,
            flags: CR::FLAG_STAKE_TO_HOLDING | CR::FLAG_SLOT_OWED,
            progress: 1,
            required: 2,
            bell: immune,
            actor: k.x.citizen_tag(),
            ..Record::ZERO
        }
    );
    let rent = k.c.rent(H::SIZE);
    let g0 = gold(&k.c, &k.o.holding);
    let xw0 = k.c.lamports(&k.x.wallet.pubkey());
    let anyone = k.c.funded(b"cq-anyone", 1);
    let hh = head(&k.c, &k.o.holding);
    let hp = head(&k.c, &k.o.province);
    let ix = settle_siege_ix(&k, &anyone, k.o.holding, true);
    let l = expect_lands(mc_send(&mut k.c, I2::SettleSiege, ix.clone(), &[&anyone]), "settle_siege_ix(");
    let paid = gold(&k.c, &k.o.holding) - g0;
    assert!((500_000..510_000).contains(&paid), "the stake (+ accrual): {paid}");
    assert_eq!(k.c.lamports(&k.x.wallet.pubkey()), xw0 + rent);
    let cd = k.c.data(&k.x.citizen);
    assert_eq!((cd[C::SLOTS], u64_at(&cd, C::TICKET_ESCROW)), (0, 0));
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    assert_eq!((r.kind, r.flags, r.faction, r.bell), (CR::KIND_NONE, 0, 0, immune), "immunity kept");
    let s = one(&l, CqKind::SIEGE_SETTLED);
    assert_eq!(s.u8(0), settle_reason::TO_DEFENDER);
    assert_eq!(s.u64(1), hkey(&k.o));
    assert_eq!((s.u32(9), s.u32(13), s.u8(17)), (500, 0, 2));
    chained(&k.c, &k.o.holding, hh, &s, E2::Holding);
    chained(&k.c, &k.o.province, hp, &s, E2::Province);
    // P10: the defender's immunity bars only the besieging faction. (On
    // this branch M1's codec rewrites a written Holding's shield from M1's
    // constants; CQ2-A writes it once, §3.9. Unshielded by hand.)
    let mut f = k.c.fork();
    unshield(&mut f, &k.o.holding);
    unshield(&mut f, &k.x.holding);
    let y = k.w.cq_estate(&mut f, "y2", 2, ring4(2, 1), 0);
    k.w.enrich(&mut f, &y, 1_000);
    unshield(&mut f, &y.holding);
    k.w.craft_host(&mut f, &y, &k.o.province, 1, 0, 0, HOST, k.o.tile);
    assert_cq(send_declare(&mut f, &k.x, k.declare_ix()), Cq::Immune);
    expect_lands(send_declare(&mut f, &y, declare_on(&k.w, &y, &k.o, 1)), "faction 2 is not barred");
    // A second settle owes nothing.
    assert_code(mc_send(&mut k.c, I2::SettleSiege, ix, &[&anyone]), E::AlreadyDone);
}

/// P10: a deserted siege (the besiegers left, no defender) grants no
/// immunity and burns the stake; the slot is still owed back.
#[test]
fn p_cq_p10_a_deserted_siege_burns_the_stake() {
    let mut k = Cast::new();
    declare_then(&mut k, 0, false);
    let r = k.w.cq_record(&k.c, &k.o.province, k.o.site);
    assert_eq!(
        (r.kind, r.faction, r.flags, r.bell),
        (CR::KIND_NONE, CR::BARRED_NONE, CR::FLAG_SLOT_OWED, 0)
    );
    let anyone = k.c.funded(b"cq-anyone", 1);
    let g0 = gold(&k.c, &k.o.holding);
    let ix = settle_siege_ix(&k, &anyone, k.o.holding, true);
    let l = expect_lands(mc_send(&mut k.c, I2::SettleSiege, ix, &[&anyone]), "settle_siege_ix(");
    assert_eq!(gold(&k.c, &k.o.holding), g0, "nothing paid");
    let s = one(&l, CqKind::SIEGE_SETTLED);
    assert_eq!((s.u8(0), s.u32(9), s.u8(17)), (settle_reason::BURNED, 0, 2));
    assert_eq!(k.w.cq_record(&k.c, &k.o.province, k.o.site), Record { faction: CR::BARRED_NONE, ..Record::ZERO });
    // Immediately besiegeable again by anyone (the source's shield, which
    // M1's codec rewrote at the stake, cleared by hand as above).
    unshield(&mut k.c, &k.x.holding);
    expect_lands(k.declare(), "no immunity after a deserted siege");
}

/// S5: a stake owed at `owed_gen` is burned when the holding has another
/// generation; an absent recipient burns it too.
#[test]
fn g13_cq_settle_siege_burns_a_stake_of_another_generation() {
    let mut k = Cast::new();
    declare_then(&mut k, 0, true);
    let anyone = k.c.funded(b"cq-anyone", 1);
    let mut f = k.c.fork();
    f.edit(&k.o.holding, |d| d[H::GEN] = 7);
    let g0 = gold(&f, &k.o.holding);
    let l = expect_lands(
        mc_send(&mut f, I2::SettleSiege, settle_siege_ix(&k, &anyone, k.o.holding, true), &[&anyone]),
        "settle_siege_ix(",
    );
    assert_eq!(gold(&f, &k.o.holding), g0);
    let s = one(&l, CqKind::SIEGE_SETTLED);
    assert_eq!((s.u8(0), s.u32(9), s.u32(13)), (settle_reason::BURNED, 0, 500));
    let mut f = k.c.fork();
    f.remove(&k.o.holding);
    let l = expect_lands(
        mc_send(&mut f, I2::SettleSiege, settle_siege_ix(&k, &anyone, k.o.holding, true), &[&anyone]),
        "settle_siege_ix(",
    );
    assert_eq!(one(&l, CqKind::SIEGE_SETTLED).u32(13), 500);
}

/// §3.4 season end: a siege still running when the season ends lapses;
/// SettleSiege returns the stake to `src` and releases the slot.
#[test]
fn g13_cq_settle_siege_lapses_a_siege_at_season_end() {
    let mut k = Cast::new();
    expect_lands(k.declare(), "DeclareSiege");
    let anyone = k.c.funded(b"cq-anyone", 1);
    let ix = settle_siege_ix(&k, &anyone, k.x.holding, true);
    assert_code(mc_send(&mut k.c.fork(), I2::SettleSiege, ix.clone(), &[&anyone]), E::AlreadyDone);
    let end = k.w.season_u32(&k.c, frontier_abi::layout::world::season::END_BELL);
    k.w.to_bell(&mut k.c, end + 2, 5);
    let g0 = gold(&k.c, &k.x.holding);
    let l = expect_lands(mc_send(&mut k.c, I2::SettleSiege, ix, &[&anyone]), "settle_siege_ix(");
    assert!(gold(&k.c, &k.x.holding) >= g0 + 500_000);
    let s = one(&l, CqKind::SIEGE_SETTLED);
    assert_eq!((s.u8(0), s.u64(1), s.u32(9), s.u8(17)), (settle_reason::SEASON_END, hkey(&k.x), 500, 2));
    assert_eq!(k.w.cq_record(&k.c, &k.o.province, k.o.site), Record { faction: CR::BARRED_NONE, ..Record::ZERO });
    assert_eq!(k.c.data(&k.x.citizen)[C::SLOTS], 0);
}

/// A-5: a running occupation owes its stake to `src` from the completion
/// bell; SettleSiege pays it and the occupation keeps running.
#[test]
fn g13_cq_settle_siege_pays_an_occupations_stake_to_src() {
    let mut k = Cast::new();
    k.w.craft_host(&mut k.c, &k.x, &k.v.province, 0, 1, 0, HOST, k.v.tile);
    expect_lands(send_declare(&mut k.c, &k.x, declare_on(&k.w, &k.x, &k.v, 0)), "declare_on(");
    let mut r = k.w.cq_record(&k.c, &k.v.province, k.v.site);
    r.progress = r.required - 1;
    k.w.cq_put_record(&mut k.c, &k.v.province, k.v.site, &r);
    k.w.set_resolved_next(&mut k.c, &k.v.province, B0 + 1);
    let out = k.w.cq_resolve(&mut k.c, &k.v.province, B0 + 1, Some(site_report(k.v.site, bit(0), false)));
    assert_eq!(out.events()[0].code, l2::event::OCCUPIED);
    let r = k.w.cq_record(&k.c, &k.v.province, k.v.site);
    assert_eq!((r.kind, r.flags), (CR::KIND_OCCUPATION, CR::FLAG_STAKE_TO_SRC));
    let anyone = k.c.funded(b"cq-anyone", 1);
    let ix = qix::settle_siege(&k.w.a, anyone.pubkey(), k.v.province, k.x.holding, nowhere("sc"), None, k.v.site);
    let g0 = gold(&k.c, &k.x.holding);
    let l = expect_lands(mc_send(&mut k.c, I2::SettleSiege, ix.clone(), &[&anyone]), "qix::settle_siege(");
    assert!(gold(&k.c, &k.x.holding) >= g0 + 500_000);
    assert_eq!(one(&l, CqKind::SIEGE_SETTLED).u8(0), settle_reason::TO_ATTACKER);
    let r2 = k.w.cq_record(&k.c, &k.v.province, k.v.site);
    assert_eq!((r2.kind, r2.flags, r2.bell), (CR::KIND_OCCUPATION, 0, r.bell));
    assert_code(mc_send(&mut k.c, I2::SettleSiege, ix, &[&anyone]), E::AlreadyDone);
}

/// SettleSiege's refusals: a slot owed with no funder position
/// (`TooManyAccounts`), a slot Citizen whose tag is not the record's actor
/// (`BadAddress`), a funder that is not the escrow's (`BadAccount`), a
/// recipient not at the owed key's address (`BadAddress`), a slot Citizen
/// present when none is owed (`BadAccount`).
#[test]
fn g13_cq_settle_siege_refusals() {
    let mut k = Cast::new();
    declare_then(&mut k, 0, true);
    let anyone = k.c.funded(b"cq-anyone", 1);
    let send = |f: &mut Chain, ix: Instruction| mc_send(f, I2::SettleSiege, ix, &[&anyone]);
    let mut ix = settle_siege_ix(&k, &anyone, k.o.holding, true);
    ix.accounts.pop();
    assert_code(send(&mut k.c.fork(), ix), E::TooManyAccounts);
    let mut f = k.c.fork();
    let y = k.w.cq_estate(&mut f, "y", 0, ring4(0, 1), 0);
    let mut ix = settle_siege_ix(&k, &anyone, k.o.holding, true);
    ix.accounts[qix::at::settle_siege::SLOT_CITIZEN].pubkey = y.citizen;
    assert_code(send(&mut f, ix), E::BadAddress);
    let mut ix = settle_siege_ix(&k, &anyone, k.o.holding, true);
    ix.accounts[qix::at::settle_siege::FUNDER].pubkey = anyone.pubkey();
    common_refused(send(&mut k.c.fork(), ix), &[E::BadAccount, E::BadAddress]);
    let ix = settle_siege_ix(&k, &anyone, k.v.holding, true);
    assert_code(send(&mut k.c.fork(), ix), E::BadAddress);
    // Settled once; then the slot positions must be absent.
    let ix = settle_siege_ix(&k, &anyone, k.o.holding, true);
    expect_lands(send(&mut k.c, ix), "settle");
    assert_code(send(&mut k.c.fork(), settle_siege_ix(&k, &anyone, k.o.holding, false)), E::AlreadyDone);
}

// ------------------------------------------------------------ FoldMarch

/// A March around the outpost's Province: six of its seven members
/// crafted as Provinces v2 opened at bell 12 and resolved (crafted, module
/// note) through bell 36, so `snap[]` holds hours 2–6; the seventh member
/// is absent. Returns `(m, n)`, the members and the absent one's index.
fn march_world(k: &mut Cast) -> ((i32, i32), [Address; 7], usize) {
    let (m, n) = frontier_abi::v2::addr::march_of(k.o.p as i32, k.o.q as i32);
    let coords = frontier_abi::v2::addr::march_members(m, n);
    let members = qix::march_members(&k.w.a, m, n);
    let absent = coords
        .iter()
        .position(|&(p, q)| (p, q) != (k.o.p as i32, k.o.q as i32))
        .expect("another member");
    for (i, &(p, q)) in coords.iter().enumerate() {
        if i == absent {
            assert!(k.c.is_absent(&members[i]));
            continue;
        }
        let pk = k.w.cq_province(&mut k.c, p as i16, q as i16);
        k.c.edit(&pk, |d| d[P::OPENED_BELL..P::OPENED_BELL + 4].copy_from_slice(&12u32.to_le_bytes()));
        k.w.set_resolved_next(&mut k.c, &pk, 12);
        k.w.cq_resolve_quiet(&mut k.c, &pk, 12, 36);
    }
    ((m, n), members, absent)
}

fn fold_ix(w: &World, payer: &Keypair, mn: (i32, i32), hour: u32, count: u8) -> Instruction {
    qix::fold_march(&w.a, payer.pubkey(), mn.0, mn.1, hour, count, payer.pubkey().to_bytes())
}

/// §3.10, §5.5 0xA5: the first fold creates the MarchState (`next_hour =
/// ⌈min opened_bell / 6⌉`, rent from the fee payer, `rent_to` the fee
/// payer) and folds `count` hours in order; the outpost's faction controls
/// (strict majority), gets `dominion_per_hour` control-bells per hour; one
/// MARCH_FOLD per hour chains the MarchState; out of order and too early
/// wait; an absent member weighs 0.
#[test]
fn g13_cq_fold_march_folds_hours_in_order() {
    let mut k = Cast::new();
    let (mn, members, _) = march_world(&mut k);
    let march = qix::march_address(&k.w.a, mn.0, mn.1);
    let keeper = k.w.keeper.insecure_clone();
    let k0 = k.c.lamports(&keeper.pubkey());
    let l = expect_lands(mc_send(&mut k.c, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 2, 3), &[&keeper]), "fold_ix(");
    common::assert_program_account(&k.c, &march, MS::MAGIC, MS::SIZE, k.w.id);
    assert_eq!(k.c.lamports(&keeper.pubkey()) + l.fee, k0 - k.c.rent(MS::SIZE));
    let md = k.c.data(&march);
    assert_eq!(u32_at(&md, MS::NEXT_HOUR), 5);
    assert_eq!(md[MS::CONTROLLER], 1);
    assert_eq!(u32_at(&md, MS::dominion_bells(1)), 3 * MC_LOCAL_7D.cq.dominion_per_hour as u32);
    assert_eq!(u32_at(&md, MS::control_hours(1)), 3);
    assert!(u32_at(&md, MS::weight(1)) > 0);
    assert_eq!(md[MS::RENT_TO..MS::RENT_TO + 32], keeper.pubkey().to_bytes());
    let folds: Vec<R2> = recs(&l.logs)
        .into_iter()
        .filter(|r| r.kind == AnyKind::Cq(CqKind::MARCH_FOLD))
        .collect();
    assert_eq!(folds.len(), 3);
    for (i, r) in folds.iter().enumerate() {
        assert_eq!(u32::from_le_bytes(r.key[8..12].try_into().unwrap()), 2 + i as u32);
        assert_eq!((r.u8(28), r.u8(30), r.u8(31)), (1, 1, 0), "controller, credit, lost");
        assert_eq!(r.link(E2::MarchState)[0].seq, 1 + i as u64);
    }
    assert_eq!(head(&k.c, &march).0, 3);
    // Out of order; too early (a member resolved only through 6h).
    assert_cq(mc_send(&mut k.c.fork(), I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 2, 1), &[&keeper]), Cq::FoldOutOfOrder);
    let mut f = k.c.fork();
    let present = members.iter().find(|a| !f.is_absent(a)).copied().unwrap();
    k.w.set_resolved_next(&mut f, &present, 36);
    assert_cq(mc_send(&mut f, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 5, 2), &[&keeper]), Cq::FoldTooEarly);
    // count 0 or above 6; the last hour at or after end_bell.
    assert_code(mc_send(&mut k.c.fork(), I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 5, 0), &[&keeper]), E::BadData);
    assert_code(mc_send(&mut k.c.fork(), I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 5, 7), &[&keeper]), E::BadData);
    let end = k.w.season_u32(&k.c, frontier_abi::layout::world::season::END_BELL);
    assert_code(
        mc_send(&mut k.c.fork(), I2::FoldMarch, fold_ix(&k.w, &keeper, mn, end / 6, 1), &[&keeper]),
        E::WrongStatus,
    );
    // The next hours fold on.
    expect_lands(mc_send(&mut k.c, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 5, 2), &[&keeper]), "fold_ix(");
    assert_eq!(u32_at(&k.c.data(&march), MS::NEXT_HOUR), 7);
}

/// §3.10: a member whose ring slot already moved past the hour makes it
/// lost: no credit, `lost_hours += 1`, the controller kept; the next hour
/// folds normally (lag only waits or loses an hour, never blocks).
#[test]
fn g13_cq_fold_march_loses_an_overwritten_hour() {
    let mut k = Cast::new();
    let (mn, members, _) = march_world(&mut k);
    let keeper = k.w.keeper.insecure_clone();
    expect_lands(mc_send(&mut k.c, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 2, 1), &[&keeper]), "first fold");
    let present = members.iter().find(|a| !k.c.is_absent(a)).copied().unwrap();
    k.c.edit(&present, |d| {
        let o = P::snap(3);
        d[o..o + 4].copy_from_slice(&9u32.to_le_bytes())
    });
    let l = expect_lands(mc_send(&mut k.c, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 3, 2), &[&keeper]), "fold_ix(");
    let folds: Vec<R2> = recs(&l.logs)
        .into_iter()
        .filter(|r| r.kind == AnyKind::Cq(CqKind::MARCH_FOLD))
        .collect();
    assert_eq!((folds[0].u8(30), folds[0].u8(31)), (MS::CONTROLLER_NONE, 1), "hour 3 lost");
    assert_eq!((folds[1].u8(30), folds[1].u8(31)), (1, 0), "hour 4 credited");
    let md = k.c.data(&qix::march_address(&k.w.a, mn.0, mn.1));
    assert_eq!(u32_at(&md, MS::LOST_HOURS), 1);
    assert_eq!(u32_at(&md, MS::control_hours(1)), 2);
}

/// G3 (§5.9): FoldMarch recomputes the March and its seven members: a
/// forged member Province (another province's, or a crafted lookalike at
/// the right position's wrong address) and a forged MarchState address
/// are refused.
#[test]
fn g03_cq_fold_march_forged_members_and_march() {
    let mut k = Cast::new();
    let (mn, _, absent) = march_world(&mut k);
    let keeper = k.w.keeper.insecure_clone();
    let mut ix = fold_ix(&k.w, &keeper, mn, 2, 1);
    // A present v2 Province of another March in place of the absent member.
    ix.accounts[qix::at::fold::MEMBER0 + absent].pubkey = k.x.province;
    assert_code(mc_send(&mut k.c.fork(), I2::FoldMarch, ix, &[&keeper]), E::BadAddress);
    let mut ix = fold_ix(&k.w, &keeper, mn, 2, 1);
    ix.accounts.swap(qix::at::fold::MEMBER0, qix::at::fold::MEMBER0 + 1);
    assert_code(mc_send(&mut k.c.fork(), I2::FoldMarch, ix, &[&keeper]), E::BadAddress);
    let mut ix = fold_ix(&k.w, &keeper, mn, 2, 1);
    ix.accounts[qix::at::fold::MARCH].pubkey = qix::march_address(&k.w.a, mn.0 + 1, mn.1);
    assert_code(mc_send(&mut k.c.fork(), I2::FoldMarch, ix, &[&keeper]), E::BadAddress);
}

/// G2 (§13.2): the MarchState is created pre-funding-safe: pre-funded with
/// 1 lamport, its rent or 10× its rent, the first fold still creates it
/// and the fee payer pays only the shortfall.
#[test]
fn g02_cq_fold_march_prefunded_march_state() {
    let mut k = Cast::new();
    let (mn, _, _) = march_world(&mut k);
    let march = qix::march_address(&k.w.a, mn.0, mn.1);
    let keeper = k.w.keeper.insecure_clone();
    let rent = k.c.rent(MS::SIZE);
    for pre in common::prefunds(rent) {
        let mut f = k.c.fork();
        f.prefund(&march, pre);
        let k0 = f.lamports(&keeper.pubkey());
        let l = expect_lands(mc_send(&mut f, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 2, 1), &[&keeper]), "prefunded fold");
        common::assert_program_account(&f, &march, MS::MAGIC, MS::SIZE, k.w.id);
        let paid = k0 - f.lamports(&keeper.pubkey()) - l.fee;
        common::assert_shortfall_only("MarchState", paid, pre, rent, 0);
    }
}

/// CloseMarch (N, §5.5 0xA7): refused before `end + 72 h` (`TooEarly`) and
/// to another `rent_to` (`BadAccount`); then closes the MarchState to its
/// `rent_to` with a CLOSE record.
#[test]
fn g13_cq_close_march_after_the_grace() {
    let mut k = Cast::new();
    let (mn, _, _) = march_world(&mut k);
    let keeper = k.w.keeper.insecure_clone();
    expect_lands(mc_send(&mut k.c, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 2, 1), &[&keeper]), "fold");
    let march = qix::march_address(&k.w.a, mn.0, mn.1);
    let anyone = k.c.funded(b"cq-anyone", 1);
    let close = |rent_to: Address| qix::close_march(&k.w.a, anyone.pubkey(), mn.0, mn.1, rent_to);
    assert_code(mc_send(&mut k.c.fork(), I2::CloseMarch, close(keeper.pubkey()), &[&anyone]), E::WrongStatus);
    // EndSeason (crafted status, as `world::land` does).
    k.w.craft_status(&mut k.c, frontier_abi::layout::world::season::STATUS_ENDED);
    let end_ts = k.w.end_ts();
    k.c.set_time(end_ts + 72 * 3_600 - 10);
    assert_code(mc_send(&mut k.c.fork(), I2::CloseMarch, close(keeper.pubkey()), &[&anyone]), E::TooEarly);
    k.c.set_time(end_ts + 72 * 3_600);
    assert_code(mc_send(&mut k.c.fork(), I2::CloseMarch, close(anyone.pubkey()), &[&anyone]), E::BadAccount);
    let lam = k.c.lamports(&march);
    let k0 = k.c.lamports(&keeper.pubkey());
    let l = expect_lands(mc_send(&mut k.c, I2::CloseMarch, close(keeper.pubkey()), &[&anyone]), "close(");
    assert!(k.c.is_absent(&march));
    assert_eq!(k.c.lamports(&keeper.pubkey()), k0 + lam);
    let r: Vec<R2> = recs(&l.logs);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].kind, AnyKind::V1(frontier_abi::log::Kind::CLOSE));
}

// ------------------------------------------------------------ RetireHost

/// The cast after X captured V's outpost (SettleCapture through the
/// program); V's host issued by the outpost (generation 1) stands in V's
/// home Province at entry 5. Returns the host id.
fn captured_with_victim_host(k: &mut Cast) -> u64 {
    let id = k.w.craft_host(&mut k.c, &k.o, &k.v.province, 5, 3, 0, 700, k.v.tile);
    complete_capture(k);
    let anyone = k.c.funded(b"cq-capturer", 1);
    let ix = capture_ix(k, &anyone);
    expect_lands(mc_send(&mut k.c, I2::SettleCapture, ix, &[&anyone]), "SettleCapture");
    id
}

/// RetireHost of entry `entry` in `province` signed by `actor` (payer too),
/// naming `victim` as the victim Citizen.
fn retire_ix(k: &Cast, actor: &Keypair, victim: Address, province: Address, entry: u8) -> Instruction {
    qix::retire_host(&k.w.a, actor.pubkey(), actor.pubkey(), victim, province, k.o.holding, k.v.holding, entry)
}

/// The return settle (SettleDeparture, `transit_slot = 0xFF`) of `province`
/// to `holding`.
fn return_ix(k: &Cast, province: Address, holding: Address) -> Instruction {
    qix::settle_return(&k.w.a, k.w.keeper.pubkey(), province, holding)
}

/// K-27, §5.5 0xA6, P7, P11: during the season only the victim (its wallet)
/// retires a host of the captured Holding's previous generation: a pending
/// retire-style Leave at the current bell bound to `prev_home` (RETIRE, by
/// 0); after that bell's resolve the return settle credits the troops to
/// `prev_home`'s reserve, never to the captured Holding; the captor cannot
/// command the host and no third party can retire or disband it.
#[test]
fn p_cq_p7_p11_retire_host_by_the_victim_returns_to_prev_home() {
    let mut k = Cast::new();
    let id = captured_with_victim_host(&mut k);
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.v.province, b);
    // P7: the captor cannot command it (its holding's generation moved).
    let xo = permutation_frontier_svm_tests::world::conquest::estate_view(
        &k.x,
        &k.o.holding,
        &k.o.province,
        (k.o.p, k.o.q, k.o.site),
        2,
        k.o.tile,
    );
    let dis = permutation_frontier_svm_tests::chain::with_account(
        fclient::ix::dissolve(&k.w.a, &xo.player(), xo.href(), id),
        5,
        k.v.province,
    );
    assert_code(k.c.fork().send(&[dis], &[&k.x.wallet]), E::NotOwner);
    // P11: a third party is NotLead (its own Citizen) during the season.
    assert_cq(
        mc_send(&mut k.c.fork(), I2::RetireHost, retire_ix(&k, &k.x.wallet, k.x.citizen, k.v.province, 5), &[&k.x.wallet]),
        Cq::NotLead,
    );
    // ... and cannot sign for the victim.
    let other = k.c.funded(b"cq-other", 1);
    assert_code(
        mc_send(&mut k.c.fork(), I2::RetireHost, retire_ix(&k, &other, k.v.citizen, k.v.province, 5), &[&other]),
        E::Auth,
    );
    // ... nor disband it (retire_hosts = 1, K-27).
    let dsb = fclient::ix::disband_stranded(&k.w.a, other.pubkey(), k.v.p, k.v.q, 5, id);
    assert_code(k.c.fork().send(&[dsb], &[&other]), E::NotDormant);
    // The victim retires it.
    let hp = head(&k.c, &k.v.province);
    let ix = retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 5);
    let l = expect_lands(mc_send(&mut k.c, I2::RetireHost, ix.clone(), &[&k.v.wallet]), "retire_ix(");
    let pd = k.c.data(&k.v.province);
    let en = entry_at(&pd, 5);
    assert_eq!(en.id, id);
    assert!(matches!(en.op, frontier_abi::entry::EntryOp::Leave));
    assert_eq!(en.pend_bell, b);
    assert!(frontier_abi::v2::entry::is_retire(&pd, 5));
    let r = one(&l, CqKind::RETIRE);
    assert_eq!(u64::from_le_bytes(r.key[..8].try_into().unwrap()), id);
    assert_eq!((r.u32(0), r.u64(4), r.u8(12)), (700_000, hkey(&k.v), retire_by::VICTIM));
    chained(&k.c, &k.v.province, hp, &r, E2::Province);
    // A second call finds the host busy.
    assert_code(mc_send(&mut k.c.fork(), I2::RetireHost, ix, &[&k.v.wallet]), E::HostBusy);
    // The bell's resolve (crafted) moves it out; the return settle to the
    // captured Holding finds nothing; to prev_home it credits 700 troops.
    k.w.cq_resolve(&mut k.c, &k.v.province, b, None);
    assert_eq!(entry_at(&k.c.data(&k.v.province), 5).state, frontier_abi::layout::province::entry::STATE_DEPARTED);
    assert_code(k.c.fork().send(&[return_ix(&k, k.v.province, k.o.holding)], &[&k.w.keeper]), E::AlreadyDone);
    let r0 = u32_at(&k.c.data(&k.v.holding), H::reserve(0));
    expect_lands(k.c.send(&[return_ix(&k, k.v.province, k.v.holding)], &[&k.w.keeper]), "return to prev_home");
    assert_eq!(u32_at(&k.c.data(&k.v.holding), H::reserve(0)), r0 + 700);
    assert!(entry_of(&k.c.data(&k.v.province), id).is_none());
}

/// D-6: a Leave of the previous generation already out of the roster
/// (Dissolved before the capture) waits for its victim — the return
/// settle neither credits the captured Holding nor strands it — until
/// RetireHost binds it to `prev_home`.
#[test]
fn g13_cq_retire_host_binds_a_departed_leave() {
    let mut k = Cast::new();
    let id = k.w.craft_host(&mut k.c, &k.o, &k.v.province, 5, 3, 0, 700, k.v.tile);
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.v.province, b);
    let dis = permutation_frontier_svm_tests::chain::with_account(
        fclient::ix::dissolve(&k.w.a, &k.o.player(), k.o.href(), id),
        5,
        k.v.province,
    );
    expect_lands(k.c.send(&[dis], &[&k.v.wallet]), "Dissolve before the capture");
    k.w.cq_resolve(&mut k.c, &k.v.province, b, None);
    unshield(&mut k.c, &k.o.holding);
    complete_capture(&mut k);
    let anyone = k.c.funded(b"cq-capturer", 1);
    let ix = capture_ix(&k, &anyone);
    expect_lands(mc_send(&mut k.c, I2::SettleCapture, ix, &[&anyone]), "SettleCapture");
    // Waiting: no third party strands it, the captured Holding gets nothing.
    assert_code(k.c.fork().send(&[return_ix(&k, k.v.province, k.o.holding)], &[&k.w.keeper]), E::AlreadyDone);
    assert_code(k.c.fork().send(&[return_ix(&k, k.v.province, k.v.holding)], &[&k.w.keeper]), E::AlreadyDone);
    let ix = retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 5);
    let l = expect_lands(mc_send(&mut k.c, I2::RetireHost, ix, &[&k.v.wallet]), "retire_ix(");
    one(&l, CqKind::RETIRE);
    assert_code(
        mc_send(&mut k.c.fork(), I2::RetireHost, retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 5), &[&k.v.wallet]),
        E::AlreadyDone,
    );
    let r0 = u32_at(&k.c.data(&k.v.holding), H::reserve(0));
    expect_lands(k.c.send(&[return_ix(&k, k.v.province, k.v.holding)], &[&k.w.keeper]), "bound return");
    assert_eq!(u32_at(&k.c.data(&k.v.holding), H::reserve(0)), r0 + 700);
}

/// K-27: after `end_bell` anyone retires a previous-generation host, once
/// its Province resolved every bell of the season (D-5): it leaves at once
/// (state departed, RETIRE by 1) and the return settle credits `prev_home`.
#[test]
fn g13_cq_retire_host_after_the_end_by_anyone() {
    let mut k = Cast::new();
    let id = captured_with_victim_host(&mut k);
    let end = k.w.season_u32(&k.c, frontier_abi::layout::world::season::END_BELL);
    k.w.to_bell(&mut k.c, end + 1, 5);
    let other = k.c.funded(b"cq-other", 1);
    let ix = retire_ix(&k, &other, nowhere("victim"), k.v.province, 5);
    k.w.set_resolved_next(&mut k.c, &k.v.province, end - 1);
    assert_code(mc_send(&mut k.c.fork(), I2::RetireHost, ix.clone(), &[&other]), E::TooEarly);
    k.w.set_resolved_next(&mut k.c, &k.v.province, end);
    let l = expect_lands(mc_send(&mut k.c, I2::RetireHost, ix, &[&other]), "retire after the end");
    assert_eq!(one(&l, CqKind::RETIRE).u8(12), retire_by::AFTER_END);
    let en = entry_at(&k.c.data(&k.v.province), 5);
    assert_eq!((en.id, en.state), (id, frontier_abi::layout::province::entry::STATE_DEPARTED));
    let r0 = u32_at(&k.c.data(&k.v.holding), H::reserve(0));
    expect_lands(k.c.send(&[return_ix(&k, k.v.province, k.v.holding)], &[&k.w.keeper]), "return");
    assert_eq!(u32_at(&k.c.data(&k.v.holding), H::reserve(0)), r0 + 700);
}

/// RetireHost's refusals: `retire_hosts = 0` (`WrongStatus`), a Holding
/// never captured (`NotLead`: no victim), an entry of its current
/// generation (`NotOwner`), a
/// home that is not `prev_home` (`BadAddress`), a Province behind
/// (`NotResident`), a free entry (`NotOwner`) and one out of range
/// (`BadData`).
#[test]
fn g13_cq_retire_host_refusals() {
    let mut k = Cast::new();
    captured_with_victim_host(&mut k);
    let b = k.w.bell(&k.c);
    k.w.set_resolved_next(&mut k.c, &k.v.province, b);
    let send = |f: &mut Chain, ix: Instruction| mc_send(f, I2::RetireHost, ix, &[&k.v.wallet]);
    let ok = retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 5);
    let mut f = k.c.fork();
    let mut p0 = MC_LOCAL_7D.cq;
    p0.retire_hosts = 0;
    k.w.cq_set_params(&mut f, &p0);
    assert_code(send(&mut f, ok.clone()), E::WrongStatus);
    // The captured position given V's home (never captured: no previous
    // owner, so V is not its victim).
    let mut ix = ok.clone();
    ix.accounts[qix::at::retire::CAPTURED].pubkey = k.v.holding;
    assert_cq(send(&mut k.c.fork(), ix), Cq::NotLead);
    // An entry of the current generation (the captor's own host).
    let mut f = k.c.fork();
    let xo = permutation_frontier_svm_tests::world::conquest::estate_view(
        &k.x, &k.o.holding, &k.o.province, (k.o.p, k.o.q, k.o.site), 2, k.o.tile,
    );
    k.w.craft_host(&mut f, &xo, &k.v.province, 6, 0, 0, 200, k.v.tile);
    assert_code(send(&mut f, retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 6)), E::NotOwner);
    // Another home.
    let mut ix = ok.clone();
    ix.accounts[qix::at::retire::HOME].pubkey = k.x.holding;
    assert_code(send(&mut k.c.fork(), ix), E::BadAddress);
    // Behind; an empty entry.
    let mut f = k.c.fork();
    k.w.set_resolved_next(&mut f, &k.v.province, b - 2);
    assert_code(send(&mut f, ok.clone()), E::NotResident);
    assert_code(send(&mut k.c.fork(), retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 30)), E::NotOwner);
    assert_code(send(&mut k.c.fork(), retire_ix(&k, &k.v.wallet, k.v.citizen, k.v.province, 200)), E::BadData);
}

// ------------------------------------------------------------ G1

/// The v2 ceilings of an MC instruction (§5.4): the CU gate, the heap gate,
/// the tx bytes (§5.4's value or the worst-case estimate), 64 locks, the v2
/// `L(kind)`.
fn cq_ceilings(ix: I2) -> permutation_frontier_svm_tests::budget::Ceilings {
    use frontier_abi::v2::budgets as b2;
    permutation_frontier_svm_tests::budget::Ceilings {
        cu: b2::budget(ix).cu_budget,
        heap: frontier_abi::budgets::HEAP_GATE,
        tx_bytes: b2::tx_ceiling(ix),
        locks: frontier_abi::budgets::LOCKS_MAX,
        loaded: b2::loaded_limit(ix),
    }
}

/// Measures `ix` on `c` (ladder CU, v2 `L(kind)`) and asserts §5.4's
/// ceilings: CU on the plain builds, the heap on the trace build.
fn cq_measured(c: &Chain, kind: I2, label: &str, ix: Instruction, signers: &[&Keypair]) -> u64 {
    let p = Profile::NONE
        .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
        .with_loaded(frontier_abi::v2::budgets::loaded_limit(kind));
    let need = c
        .measure_with(&p, &[ix], signers)
        .unwrap_or_else(|f| panic!("{label}: refused while measuring: {:?}\n{}", f.code, f.logs.join("\n")));
    permutation_frontier_svm_tests::budget::assert_within(label, &need, &cq_ceilings(kind));
    need.cu
}

/// The builds a G1 test measures: the release `.so` (CU), and the trace
/// build too when `PSF_TRACE=1` (heap; its markers add CU).
fn g1_builds() -> Vec<Build> {
    let mut v = vec![Build::Release];
    if std::env::var("PSF_TRACE").is_ok_and(|x| x == "1") {
        v.push(Build::Trace);
    }
    v
}

/// The §13.1 DeclareSiege fill (v1.1, R-08): Frontier-28 at day 0, the
/// owner's vigil with a pending CL-09 change, `end_bell − now` = 287 (the
/// scan) or ≥ 288 (O(1)), 48 entries on the Province with 6 of the
/// attacker's faction on the tile (the lead-host ranking), a Frontier
/// protection proof through a nearby first holding, a capture target with
/// the slot reservation and the escrow top-up.
fn declare_worst(build: Build, scan: bool) -> (Cast, Instruction) {
    let mut k = Cast::with(mc_world_with(build, &frontier_abi::v2::presets::MC_SEASON_28.cq));
    let c = &mut k.c;
    let w = &k.w;
    if scan {
        let end = B0 + 1 + 287;
        c.edit(&w.a.season, |d| {
            let o = frontier_abi::layout::world::season::END_BELL;
            d[o..o + 4].copy_from_slice(&end.to_le_bytes())
        });
    }
    // The owner's vigil: a change requested, effective at a later midnight.
    let from = (c.now / 86_400 + 2) * 86_400;
    let now_away = w.cq_vigil_away(B0);
    c.edit(&k.v.citizen, |d| {
        d[C::VIGIL_NEXT_MIN..C::VIGIL_NEXT_MIN + 2].copy_from_slice(&((now_away + 180) % 1_440).to_le_bytes());
        d[C::VIGIL_FROM_TS..C::VIGIL_FROM_TS + 8].copy_from_slice(&from.to_le_bytes());
    });
    // 48 entries: 8 per faction; faction 0's six on the target tile (X's
    // the largest at entry 0), the rest elsewhere.
    let pd = c.data(&k.o.province);
    let tiles: Vec<u8> = (0..61u8)
        .filter(|t| u64_at(&pd, P::PASSABLE_MASK) & (1 << t) != 0 && *t != k.o.tile)
        .collect();
    c.edit(&k.o.province, |d| {
        let e = entry_at(d, 0);
        let mut e2 = e;
        e2.troops = 30_000_000;
        frontier_abi::entry::write_entry(d, 0, &e2).unwrap();
    });
    let mut i = 1usize;
    for f in 0..6u8 {
        let e = w.cq_estate(c, &format!("g1-{f}"), f, ring4(f, 3), 0);
        let n = if f == 0 { 7 } else { 8 };
        for s in 0..n {
            let tile = if f == 0 && s < 5 { k.o.tile } else { tiles[(i * 7) % tiles.len()] };
            w.craft_host(c, &e, &k.o.province, i, s as u32, 0, 20_000 + i as u32, tile);
            i += 1;
        }
    }
    assert_eq!(c.data(&k.o.province)[P::N_ENTRIES], 48);
    // Frontier protection, lifted by a faction-0 first holding next door.
    let late = w.genesis_ts() + 2 * 86_400;
    let over = c.now - 1;
    c.edit(&k.o.holding, |d| {
        d[H::FOUNDED_TS..H::FOUNDED_TS + 8].copy_from_slice(&late.to_le_bytes());
        d[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8].copy_from_slice(&over.to_le_bytes());
    });
    let tc = permutation_rules::frontier::geometry::ProvinceCoord::new(k.o.p as i32, k.o.q as i32);
    let nb = tc.neighbors().into_iter().find(|n| n.ring() >= 4).unwrap();
    let z = w.cq_estate(c, "g1-z", 0, (nb.p as i16, nb.q as i16), 0);
    let mut ix = k.declare_ix();
    ix.accounts[qix::at::declare::NEARBY].pubkey = z.province;
    ix.data[3] = z.site;
    (k, ix)
}

/// G1 (§13.1): DeclareSiege at its pinned worst fill, both TooLate paths,
/// within 30,000 CU (§5.4) on the release `.so`.
#[test]
fn g01_cq_declare_worst() {
    for build in g1_builds() {
        for scan in [true, false] {
            let (k, ix) = declare_worst(build, scan);
            let cu = cq_measured(
                &k.c,
                I2::DeclareSiege,
                &format!("DeclareSiege worst ({build:?}, {})", if scan { "287-bell scan" } else { "≥ 288 O(1)" }),
                ix,
                &[&k.x.wallet],
            );
            println!("g01_cq DeclareSiege {build:?} scan={scan}: {cu} CU (budget 30,000)");
        }
    }
}

/// G1 (§13.1): SettleCapture of a holding with 4 transit bonds refunded and
/// the rent swap; a Free City capture with the Holding's init.
#[test]
fn g01_cq_settle_capture_worst() {
    for build in g1_builds() {
        let mut k = Cast::with(mc_world_with(build, &MC_LOCAL_7D.cq));
        for i in 0..4 {
            let id = k.o.host_id(10 + i as u32);
            craft_bonded_transit(&mut k.c, &k.w, &k.o.holding, i, id);
        }
        complete_capture(&mut k);
        let anyone = k.c.funded(b"cq-g1", 1);
        let cu = cq_measured(&k.c, I2::SettleCapture, &format!("SettleCapture 4 bonds ({build:?})"), capture_ix(&k, &anyone), &[&anyone]);
        println!("g01_cq SettleCapture holding {build:?}: {cu} CU (budget 30,000)");
        // Free City.
        let mut k = Cast::with(mc_world_with(build, &MC_LOCAL_7D.cq));
        let fc = ring4(2, 0);
        let pk = k.w.cq_free_city(&mut k.c, fc, 2, 300, 1);
        let tile = k.c.data(&pk)[P::SITES + 2];
        k.w.craft_host(&mut k.c, &k.x, &pk, 0, 1, 0, HOST, tile);
        let ix = declare_free_city(&k.w, &k.x, fc, 2, 0);
        expect_lands(send_declare(&mut k.c, &k.x, ix), "declare");
        let mut r = k.w.cq_record(&k.c, &pk, 2);
        r.progress = r.required - 1;
        k.w.cq_put_record(&mut k.c, &pk, 2, &r);
        k.w.set_resolved_next(&mut k.c, &pk, B0 + 1);
        k.w.cq_resolve(&mut k.c, &pk, B0 + 1, Some(site_report(2, bit(0), false)));
        let cap = Capture {
            fee_payer: anyone.pubkey(),
            holding: k.w.a.holding(fc.0 as i32, fc.1 as i32, 2),
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
        let anyone = k.c.funded(b"cq-g1", 1);
        let cu = cq_measured(&k.c, I2::SettleCapture, &format!("SettleCapture Free City init ({build:?})"), qix::settle_capture(&k.w.a, &cap), &[&anyone]);
        println!("g01_cq SettleCapture Free City {build:?}: {cu} CU (budget 30,000)");
    }
}

/// G1 (§13.1): SettleSiege paying the stake to the defender and releasing
/// a slot with the escrow refund; RetireHost by the victim's session key;
/// CloseMarch.
#[test]
fn g01_cq_settle_siege_retire_close() {
    for build in g1_builds() {
        let mut k = Cast::with(mc_world_with(build, &MC_LOCAL_7D.cq));
        declare_then(&mut k, 0, true);
        let anyone = k.c.funded(b"cq-g1", 1);
        let cu = cq_measured(
            &k.c,
            I2::SettleSiege,
            &format!("SettleSiege stake + slot ({build:?})"),
            settle_siege_ix(&k, &anyone, k.o.holding, true),
            &[&anyone],
        );
        println!("g01_cq SettleSiege {build:?}: {cu} CU (budget 25,000)");
        let mut k = Cast::with(mc_world_with(build, &MC_LOCAL_7D.cq));
        captured_with_victim_host(&mut k);
        let b = k.w.bell(&k.c);
        k.w.set_resolved_next(&mut k.c, &k.v.province, b);
        let session = k.c.funded(b"cq-g1-session", 1);
        let exp = k.c.now + 3_600;
        k.c.edit(&k.v.citizen, |d| {
            d[C::SESSION..C::SESSION + 32].copy_from_slice(&session.pubkey().to_bytes());
            d[C::SESSION_EXPIRY..C::SESSION_EXPIRY + 8].copy_from_slice(&exp.to_le_bytes());
        });
        let cu = cq_measured(
            &k.c,
            I2::RetireHost,
            &format!("RetireHost by session ({build:?})"),
            retire_ix(&k, &session, k.v.citizen, k.v.province, 5),
            &[&session],
        );
        println!("g01_cq RetireHost {build:?}: {cu} CU (budget 17,000)");
        let mut k = Cast::with(mc_world_with(build, &MC_LOCAL_7D.cq));
        let (mn, _, _) = march_world(&mut k);
        let keeper = k.w.keeper.insecure_clone();
        expect_lands(mc_send(&mut k.c, I2::FoldMarch, fold_ix(&k.w, &keeper, mn, 2, 1), &[&keeper]), "fold");
        k.w.craft_status(&mut k.c, frontier_abi::layout::world::season::STATUS_ENDED);
        let end_ts = k.w.end_ts();
        k.c.set_time(end_ts + 72 * 3_600);
        let ix = qix::close_march(&k.w.a, anyone.pubkey(), mn.0, mn.1, keeper.pubkey());
        let anyone = k.c.funded(b"cq-g1", 1);
        let cu = cq_measured(&k.c, I2::CloseMarch, &format!("CloseMarch ({build:?})"), ix, &[&anyone]);
        println!("g01_cq CloseMarch {build:?}: {cu} CU (budget 8,000)");
    }
}

/// G1 (§13.1): FoldMarch with 7 present members, the first fold's init,
/// 6 hours in one call, one lost hour.
#[test]
fn g01_cq_fold_worst() {
    for build in g1_builds() {
        let mut k = Cast::with(mc_world_with(build, &MC_LOCAL_7D.cq));
        let (mn, members, absent) = march_world(&mut k);
        let (p, q) = frontier_abi::v2::addr::march_members(mn.0, mn.1)[absent];
        let pk = k.w.cq_province(&mut k.c, p as i16, q as i16);
        assert_eq!(pk, members[absent]);
        k.c.edit(&pk, |d| d[P::OPENED_BELL..P::OPENED_BELL + 4].copy_from_slice(&12u32.to_le_bytes()));
        k.w.set_resolved_next(&mut k.c, &pk, 12);
        k.w.cq_resolve_quiet(&mut k.c, &pk, 12, 48);
        for m in members.iter().filter(|m| **m != pk) {
            k.w.cq_resolve_quiet(&mut k.c, m, 37, 48);
        }
        k.c.edit(&members[0], |d| {
            let o = P::snap(4);
            d[o..o + 4].copy_from_slice(&99u32.to_le_bytes())
        });
        let keeper = k.w.keeper.insecure_clone();
        // The per-hour figures for the notes (CQ2-C-NOTES, the FoldMarch
        // budget finding): the same fill folding 1..5 hours.
        let p = Profile::NONE
            .with_cu(frontier_abi::budgets::CU_LADDER_MAX)
            .with_loaded(frontier_abi::v2::budgets::loaded_limit(I2::FoldMarch));
        for count in 1..=5u8 {
            let n = k
                .c
                .measure_with(&p, &[fold_ix(&k.w, &keeper, mn, 2, count)], &[&keeper])
                .expect("fold");
            println!("g01_cq FoldMarch {build:?} 7 members, init, {count} hour(s): {}", n);
        }
        // §13.1's pinned fill: 6 hours (one lost) against §5.4's 20,000.
        let cu = cq_measured(&k.c, I2::FoldMarch, &format!("FoldMarch 7 members, init, 6 hours, 1 lost ({build:?})"), fold_ix(&k.w, &keeper, mn, 2, 6), &[&keeper]);
        println!("g01_cq FoldMarch {build:?}: {cu} CU (budget 20,000)");
    }
}
