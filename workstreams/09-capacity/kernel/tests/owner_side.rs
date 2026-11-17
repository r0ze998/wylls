//! The owner's own continuous production (contract §1, rule 1): lending
//! takes the copies out of A's real Holding conversion at the same time,
//! and nothing else changes.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::{ARMS, WORKSHOP_DELTA};
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::ledger::Op;
use wylls_capacity::model::{GrantId, JobId};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;

#[test]
fn lending_moves_the_copies_out_of_the_owners_conversion() {
    let (w, _) = world(3, 0, 1, Policies::PROVISIONAL);
    let h0 = w.facilities[&SITE_A].holding.clone();
    assert_eq!(h0.stores[ARMS as usize].rate, 3 * WORKSHOP_DELTA);
    for k in 1..=3u32 {
        let (w, _) = world(3, k, 1, Policies::PROVISIONAL);
        let f = &w.facilities[&SITE_A];
        assert_eq!(f.workshops(), 3, "the copies stay built");
        assert_eq!(f.lent, k);
        let h = &f.holding;
        let left = (3 - k) as i64;
        assert_eq!(h.stores[ARMS as usize].rate, left * WORKSHOP_DELTA);
        // Inputs: base production less what the remaining copies use.
        let ore = h0.stores[Resource::Ore as usize].rate + 3 * 8 * MILLI;
        assert_eq!(
            h.stores[Resource::Ore as usize].rate,
            ore - left * 8 * MILLI
        );
        let wood = h0.stores[Resource::Wood as usize].rate + 3 * 4 * MILLI;
        assert_eq!(
            h.stores[Resource::Wood as usize].rate,
            wood - left * 4 * MILLI
        );
    }
}

#[test]
fn the_owner_cannot_lend_more_than_built_nor_reclaim_what_is_booked() {
    let (mut w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    assert_eq!(
        w.apply(
            T0 + 1,
            A,
            &Op::Lend {
                facility: f,
                units: 2,
                seq: 1
            }
        ),
        Err(CapError::NotEnoughWorkshops)
    );
    w.apply(
        T0 + 1,
        A,
        &Op::Lend {
            facility: f,
            units: 1,
            seq: 1,
        },
    )
    .unwrap();
    let j = JobId {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        seq: 1,
    };
    w.apply(
        T0 + 2,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start: T0 + HOUR,
            end: T0 + 2 * HOUR,
            max_output: MILLI,
        },
    )
    .unwrap();
    // 3 lent, 2 booked: one comes back, the second is blocked.
    w.apply(
        T0 + 3,
        A,
        &Op::Reclaim {
            facility: f,
            units: 1,
            seq: 2,
        },
    )
    .unwrap();
    assert_eq!(
        w.apply(
            T0 + 4,
            A,
            &Op::Reclaim {
                facility: f,
                units: 1,
                seq: 3
            }
        ),
        Err(CapError::ReclaimBlocked)
    );
    // After the job's window (it had no materials: it ends at its start).
    w.apply(T0 + HOUR + 1, X, &Op::Settle { job: j }).unwrap();
    w.apply(
        T0 + HOUR + 2,
        A,
        &Op::Reclaim {
            facility: f,
            units: 2,
            seq: 3,
        },
    )
    .unwrap();
    assert_eq!(w.facilities[&SITE_A].lent, 0);
    assert_eq!(
        w.facilities[&SITE_A].holding.stores[ARMS as usize].rate,
        3 * WORKSHOP_DELTA
    );
    assert_eq!(
        w.apply(
            T0 + HOUR + 3,
            B,
            &Op::Lend {
                facility: f,
                units: 1,
                seq: 4
            }
        ),
        Err(CapError::NotOwner)
    );
}

#[test]
fn a_capture_ends_the_lending_on_the_holding() {
    let (mut w, _) = world(3, 2, 2, Policies::PROVISIONAL);
    let fac = w.facilities.get_mut(&SITE_A).unwrap();
    fac.capture(T0 + HOUR, X).unwrap();
    assert_eq!(fac.lent, 0);
    assert_eq!(fac.holding.stores[ARMS as usize].rate, 3 * WORKSHOP_DELTA);
    #[cfg(feature = "core-patch-0001")]
    assert_eq!(fac.holding.lent_workshops, 0);
}

/// With patch 0001 applied: the emulation the unpatched build uses gives
/// the patched Holding's stores exactly, over lends and reclaims at random
/// times, scarce inputs and dormancy.
#[cfg(feature = "core-patch-0001")]
#[test]
fn the_emulation_matches_the_patched_holding() {
    use wylls_capacity::facility::emulated;
    let mut seed = 0x1234_5678_9abc_def1u64;
    let mut rnd = |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    for case in 0..400 {
        let w = 1 + rnd(5) as u32;
        let mut patched = holding(w, rnd(300) as i64, rnd(300) as i64);
        let mut emu = patched.clone();
        let mut lent = 0u32;
        let mut t = T0;
        for _ in 0..12 {
            t += rnd(40 * HOUR as u64) as i64;
            if rnd(2) == 0 && lent < w {
                let n = 1 + rnd((w - lent) as u64) as u32;
                patched.lend_workshops(t, n).unwrap();
                emulated::shift(&mut emu, t, -(n as i64)).unwrap();
                lent += n;
            } else if lent > 0 {
                let n = 1 + rnd(lent as u64) as u32;
                patched.reclaim_workshops(t, n).unwrap();
                emulated::shift(&mut emu, t, n as i64).unwrap();
                lent -= n;
            }
            patched.settle(t + 1).unwrap();
            emu.settle(t + 1).unwrap();
            assert_eq!(patched.stores, emu.stores, "case {case}");
        }
        let end = t + 9 * 86_400;
        patched.settle(end).unwrap();
        emu.settle(end).unwrap();
        assert_eq!(patched.stores, emu.stores, "case {case} at the end");
        assert_eq!(patched.lent_workshops, lent);
    }
}
