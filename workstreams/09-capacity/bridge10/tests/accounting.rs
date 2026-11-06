//! The accounts on 10's one lot table under the owner's decided rule
//! (`Release::Decided`, the default), in random interleavings of what can
//! happen to a job fed from M's lot: deposits from the lot (and their
//! resends), the user's wood, settles, cancels, claims (and their resends),
//! payments of what is owed, a seizure of M's vault (10's S1 model: the lot
//! is frozen), the capture of the facility (09's loss rule: the captor takes
//! what is at it), and restarts.
//!
//! After every step, from 10's lot and 09's job accounts together:
//!
//! - the lot's law: `IN_TOTAL = HELD + OUT_TOTAL + CONSUMED + FORFEITED`;
//! - `IN_TOTAL` and `OUT_TOTAL` never move (a return un-consumes);
//! - `CONSUMED = taken − returned` and `returned + owed ≤ taken`;
//! - what 09's jobs sent out of their ore accounts is exactly what went back
//!   into the lot or is owed to it (`Σ job OUT = returned + owed`);
//! - the ore is never made or lost: `100 = lot HELD + Σ job (HELD +
//!   CONSUMED + FORFEITED) + owed`, and the captor holds `Σ job FORFEITED`;
//! - a resend or a refusal changes nothing (the whole bridge is equal before
//!   and after, but for 09's clock, the latest time it saw), and a restart
//!   restores the same bridge.
//!
//! No mixed sources (09 refuses them, undecided) and only ore in lots
//! (undecided): this file does not widen either.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity_bridge10::*;
use wylls_custody::{
    begin_inbound, finish_inbound, open, set_order, OrderSpec, PlaceRef, VaultView, ORDER_USE,
};
use wylls_custody_adapter_09::{vault_id, LotCustody};

const V: Actor = Actor::test(0xD4);
const M: Actor = Actor::test(0x4D);
const HOME: Place = Place::Caravan(78);
const ORE: usize = 0;

struct Rng(u64);
impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % n.max(1)
    }
}

/// A's facility with B's grant (2 copies), B's wood, and M's lot of 100 ore
/// in V's vault in the facility's province with a use order of 80 for B.
fn setup() -> (Bridge, GrantId, LotId, u32) {
    let (w, f) = world_with(LotCustody::new(), 3, 2, 2, Policies::PROVISIONAL);
    let mut b = Bridge::new(w, T0);
    assert_eq!(b.release, Release::Decided);
    b.cap
        .custody
        .import(
            Key {
                scope: 77,
                kind: 100,
                n: 1,
            },
            Place::Caravan(77),
            B,
            Resource::Wood,
            400 * MILLI,
        )
        .unwrap();
    let bell = b.bell(T0);
    let mut v = VaultView {
        p: SITE_A.p,
        q: SITE_A.q,
        tile: 6,
        gen: 1,
        live: true,
        owner: V.0,
        owner_tag: tag_of(V),
        stores: [0; 8],
        cap: 5_000 * MILLI,
        quota: [0; 8],
        lots: 0,
    };
    let mut lot = open(
        &mut v,
        &actor10(V),
        (M.0, tag_of(M)),
        Resource::Ore as u8,
        200 * MILLI,
        bell,
        [0; 32],
    )
    .unwrap();
    begin_inbound(&v, &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    finish_inbound(Some(&v), &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: ORDER_USE,
        grantee: B.0,
        qty: 80 * MILLI,
        expires_bell: bell + 500,
        dst: PlaceRef::default(),
        purpose: PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = set_order(&v, &mut lot, &actor10(M), 0, nonce, &spec, bell).unwrap();
    let id = b.add_lot(v, lot);
    (
        b,
        GrantId {
            facility: f,
            seq: 1,
        },
        id,
        order,
    )
}

/// The accounts above, or the first that fails.
fn accounts(b: &Bridge, lot: LotId, now: i64) {
    b.check(now).unwrap();
    let l = b.lot(lot).unwrap();
    assert_eq!(
        l.in_total,
        l.held + l.out_total + l.consumed + l.forfeited,
        "the lot's law"
    );
    assert_eq!((l.in_total, l.out_total), (100 * MILLI, 0));
    let taken = b.lot_qty_all(lot);
    let (back, owed) = (b.returned(lot), b.owed(lot));
    assert_eq!(l.consumed, taken - back);
    assert!(back + owed <= taken);
    let (mut out, mut kept) = (0, 0);
    let mut forfeited = 0;
    for p in b.cap.ledger.pools.values() {
        for j in &p.jobs {
            let a = j.accounts().inputs[ORE];
            if b.lot_of(j.id) == Some(lot) {
                assert_eq!(a.in_total, b.lot_qty(j.id), "one source per job");
                out += a.out_total;
                kept += a.held + a.consumed + a.forfeited;
                forfeited += a.forfeited;
            } else {
                assert_eq!(a.in_total, 0, "no ore from elsewhere");
            }
        }
    }
    assert_eq!(out, back + owed, "09's ore out = 10's returned + owed");
    assert_eq!(l.held + kept + owed, 100 * MILLI, "no ore made or lost");
    assert_eq!(
        b.cap
            .custody
            .balance(Place::Holding(SITE_A), Resource::Ore)
            .1,
        forfeited,
        "the captor holds what the jobs forfeited"
    );
}

/// Equal but for 09's clock (the latest time it saw, which a resend or a
/// refusal may move on; no account depends on it).
fn same(a: &Bridge, b: &Bridge, ctx: &str) {
    let mut a = a.clone();
    a.cap.clock = b.cap.clock;
    assert!(a == *b, "{ctx}: the bridge changed");
}

trait AllLots {
    fn lot_qty_all(&self, lot: LotId) -> i64;
}
impl AllLots for Bridge {
    fn lot_qty_all(&self, lot: LotId) -> i64 {
        self.links
            .values()
            .filter(|k| k.lot == lot)
            .map(|k| k.qty)
            .sum()
    }
}

#[test]
fn returns_rests_resends_and_seizures_balance_on_one_lot_table() {
    let mut n = [0u64; 12];
    let (mut paid, mut owed_seen, mut frozen_refused, mut captured) = (0, 0, 0, 0);
    let mut returned_seen = 0;
    for seed in 1..=400u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let (mut b, g, lot, order) = setup();
        let vid = vault_id(lot.p, lot.q, lot.tile);
        let mut now = T0 + 20;
        let mut next = 1u32;
        let mut deposits: Vec<(JobId, u64, u32)> = Vec::new();
        let mut claimed: Vec<JobId> = Vec::new();
        let (mut seized, mut lost) = (false, false);
        for _ in 0..80 {
            now += rng.below(900) as i64;
            let k = rng.below(12) as usize;
            let pick = |rng: &mut Rng| JobId {
                grant: g,
                seq: 1 + rng.below(next as u64) as u32,
            };
            match k {
                0 | 1 => {
                    let start = now + 60 + rng.below(3 * HOUR as u64) as i64;
                    let job = JobId {
                        grant: g,
                        seq: next,
                    };
                    let op = Op::Reserve {
                        job,
                        units: 1 + rng.below(2) as u32,
                        start,
                        end: start + (1 + rng.below(3) as i64) * HOUR,
                        max_output: (1 + rng.below(12) as i64) * MILLI,
                    };
                    if b.apply(now, B, &op).is_ok() {
                        next += 1;
                    }
                }
                2 | 3 => {
                    let job = pick(&mut rng);
                    let d = 1 + rng.below(3);
                    let units = 1 + rng.below(15) as u32;
                    let before = b.clone();
                    match b.deposit_from_lot(now, B, job, d, lot, 0, order, units) {
                        Ok(Outcome::Applied(_)) => deposits.push((job, d, units)),
                        Ok(Outcome::AlreadyApplied) => same(&b, &before, "a resend"),
                        Err(e) => {
                            same(&b, &before, &format!("a refusal changes nothing: {e:?}"));
                            if seized && matches!(e, BridgeError::Custody(_)) {
                                frozen_refused += 1;
                            }
                        }
                    }
                }
                4 => {
                    // A resend of a deposit: answered without 10, nothing moves.
                    if let Some(&(job, d, u)) =
                        deposits.get(rng.below(deposits.len() as u64) as usize)
                    {
                        let before = b.clone();
                        assert_eq!(
                            b.deposit_from_lot(now, B, job, d, lot, 0, order, u),
                            Ok(Outcome::AlreadyApplied)
                        );
                        same(&b, &before, "a resend");
                    }
                }
                5 => {
                    let op = Op::Deposit {
                        job: pick(&mut rng),
                        deposit: 10 + rng.below(3),
                        resource: Resource::Wood,
                        amount: (1 + rng.below(8) as i64) * MILLI,
                        from: Place::Caravan(77),
                    };
                    let _ = b.apply(now, B, &op);
                }
                6 => {
                    let _ = b.apply(
                        now,
                        X,
                        &Op::Settle {
                            job: pick(&mut rng),
                        },
                    );
                }
                7 => {
                    let _ = b.apply(
                        now,
                        B,
                        &Op::Cancel {
                            job: pick(&mut rng),
                        },
                    );
                }
                8 => {
                    let job = pick(&mut rng);
                    let before = b.clone();
                    let r = b.apply(now, B, &Op::Claim { job, to: HOME });
                    match r {
                        Ok(Outcome::Applied(_)) => claimed.push(job),
                        Ok(Outcome::AlreadyApplied) | Err(_) => {
                            same(&b, &before, "a refused claim")
                        }
                    }
                    // Its resend: nothing moves.
                    if claimed.contains(&job) {
                        let once = b.clone();
                        assert_eq!(
                            b.apply(now, B, &Op::Claim { job, to: HOME }),
                            Ok(Outcome::AlreadyApplied)
                        );
                        same(&b, &once, "a resent claim");
                    }
                }
                9 => {
                    let owed = b.owed(lot);
                    b.pay_owed(lot).unwrap();
                    let now_owed = b.owed(lot);
                    // 10 pays whole units on every return, so a lot that
                    // can take them is never owed a whole unit; a frozen lot
                    // takes nothing and keeps all of it owed.
                    assert_eq!(now_owed, owed, "nothing left to pay now");
                    if !seized {
                        assert!(owed < MILLI, "an open lot is owed only a rest");
                    }
                    paid += 1;
                }
                10 => {
                    if !seized && rng.below(4) == 0 {
                        b.cap.custody.seize_vault(vid, X).unwrap();
                        seized = true;
                    } else if !lost && rng.below(6) == 0 {
                        b.cap
                            .facilities
                            .get_mut(&SITE_A)
                            .unwrap()
                            .capture(now, X)
                            .unwrap();
                        b.apply(
                            now,
                            X,
                            &Op::FacilityLost {
                                facility: g.facility,
                            },
                        )
                        .unwrap();
                        lost = true;
                        captured += 1;
                    }
                }
                _ => {
                    let again = Bridge::load(&b.save()).expect("restart");
                    assert_eq!(again, b);
                    b = again;
                }
            }
            n[k] += 1;
            owed_seen += (b.owed(lot) > 0) as u64;
            returned_seen += (b.returned(lot) > 0) as u64;
            accounts(&b, lot, now);
        }
    }
    eprintln!(
        "accounting: steps by kind {n:?}; pay_owed calls {paid} (none had whole units to pay), steps with ore returned {returned_seen}, with ore owed {owed_seen}, lot moves refused while frozen {frozen_refused}, captures {captured}"
    );
    assert!(
        paid > 0 && returned_seen > 500 && owed_seen > 500 && frozen_refused > 20 && captured > 50
    );
}

/// A resend of a lot deposit by someone other than the job's user is
/// refused as 09's kernel refuses its own deposits (`NotUser`, checked
/// before the resend is recognised), and changes nothing.
#[test]
fn a_resend_by_someone_else_is_refused_and_changes_nothing() {
    let (mut b, g, lot, order) = setup();
    let job = JobId { grant: g, seq: 1 };
    b.apply(
        T0 + 10,
        B,
        &Op::Reserve {
            job,
            units: 2,
            start: T0 + HOUR,
            end: T0 + 4 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    b.deposit_from_lot(T0 + 20, B, job, 1, lot, 0, order, 10)
        .unwrap();
    let before = b.clone();
    assert_eq!(
        b.deposit_from_lot(T0 + 30, C, job, 1, lot, 0, order, 10),
        Err(BridgeError::Capacity(wylls_capacity::CapError::NotUser))
    );
    same(&b, &before, "a stranger's resend");
    assert_eq!(
        b.deposit_from_lot(T0 + 30, B, job, 1, lot, 0, order, 10),
        Ok(Outcome::AlreadyApplied)
    );
    accounts(&b, lot, T0 + 30);
}
