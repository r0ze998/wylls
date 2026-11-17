//! Returns after a stop or an ended grant: no second return, no escrow the
//! user can no longer reach. Host-tested only (no Solana runtime).

mod common;

use common::*;
use permutation_rules::frontier::holding::Resource;
use wylls_ext_kernel::examples::{watch_vow, FULFIL, PLEDGE};
use wylls_ext_kernel::exec::ExitReason;
use wylls_ext_kernel::host::Host;
use wylls_ext_kernel::manifest::ManifestId;
use wylls_ext_kernel::receipt::{Call, WITHDRAW};
use wylls_ext_kernel::registry::Status;
use wylls_ext_kernel::verify::{verify, Verdict};
use wylls_ext_kernel::ExtError;

const T: i64 = T0 + 10 * BELL;
const W: usize = Resource::Wood as usize;

fn vow_world() -> (Host, ManifestId) {
    let mut host = world();
    let id = host
        .registry
        .publish(&AUTHOR_A, &watch_vow(AUTHOR_A).encode(), None, T)
        .unwrap();
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 20_000, 1_000_000))
        .unwrap();
    (host, id)
}

fn seq(host: &Host, id: &ManifestId) -> u64 {
    host.instances.get(&(*id, B_CITIZEN)).map_or(0, |i| i.seq)
}

fn escrow(host: &Host, id: &ManifestId) -> i64 {
    host.instances
        .get(&(*id, B_CITIZEN))
        .map_or(0, |i| i.escrow[W])
}

fn withdraw_call(host: &Host, id: ManifestId, now: i64) -> Call {
    call(id, WITHDRAW, &[], seq(host, &id), now)
}

#[test]
fn e01_an_ended_grant_opens_the_exit_once() {
    for end in ["expired", "revoked", "no calls left"] {
        let (mut host, id) = vow_world();
        host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
        // While the grant is live and the extension active, the manifest's
        // own entry is the way out: the exit is shut.
        assert_eq!(
            host.withdraw(&withdraw_call(&host, id, T + BELL)),
            Err(ExtError::ExitNotOpen)
        );
        let mut g = host.grants[&(B_CITIZEN, id)].clone();
        match end {
            "expired" => g.expires_ts = T + 2 * BELL,
            "revoked" => g.revoked = true,
            _ => g.calls_left = 0,
        }
        host.set_grant(&B_WALLET, g).unwrap();
        // Fulfil is now refused by the grant...
        assert!(host.call(&call(id, FULFIL, &[], 1, T + 6 * BELL)).is_err());
        // ...and the exit returns the wood, once.
        let r = host
            .withdraw(&withdraw_call(&host, id, T + 6 * BELL))
            .unwrap();
        assert_eq!(r.events, vec![ExitReason::GrantEnded as u8], "{end}");
        assert_eq!(wood(&host, &B_HOLDING, T + 6 * BELL), WOOD0, "{end}");
        assert_eq!(
            host.withdraw(&withdraw_call(&host, id, T + 7 * BELL)),
            Err(ExtError::InstanceClosed),
            "{end}"
        );
        assert_eq!(wood(&host, &B_HOLDING, T + 7 * BELL), WOOD0, "{end}");
    }
}

#[test]
fn e02_a_core_upgrade_opens_the_exit() {
    let (mut host, id) = vow_world();
    host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    host.core.program_version += 1;
    assert_eq!(
        host.call(&call(id, FULFIL, &[], 1, T + 6 * BELL)),
        Err(ExtError::CoreVersion)
    );
    let r = host
        .withdraw(&withdraw_call(&host, id, T + 6 * BELL))
        .unwrap();
    assert_eq!(r.events, vec![ExitReason::CoreChanged as u8]);
    assert_eq!(wood(&host, &B_HOLDING, T + 6 * BELL), WOOD0);
}

#[test]
fn e03_the_exit_goes_to_the_users_own_holding_only() {
    let (mut host, id) = vow_world();
    host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    host.registry
        .set_status(&AUTHOR_A, &id, Status::Paused, T + BELL)
        .unwrap();
    // Not into C's holding, not signed by C.
    let mut c = withdraw_call(&host, id, T + 2 * BELL);
    c.holding = C_HOLDING;
    assert_eq!(host.withdraw(&c), Err(ExtError::NotOwner));
    let mut c = withdraw_call(&host, id, T + 2 * BELL);
    c.signer = C_WALLET;
    assert_eq!(host.withdraw(&c), Err(ExtError::NotSigned));
    // Into another holding of B's own (the first one may have been lost).
    let second = [0xB4; 32];
    host.holdings.insert(
        second,
        wylls_ext_kernel::host::HoldingAcct {
            owner_citizen: B_CITIZEN,
            holding: holding_with_wood(0),
        },
    );
    let mut c = withdraw_call(&host, id, T + 2 * BELL);
    c.holding = second;
    host.withdraw(&c).unwrap();
    assert_eq!(wood(&host, &second, T + 2 * BELL), 8_000);
    assert_eq!(wood(&host, &C_HOLDING, T + 2 * BELL), WOOD0);
}

#[test]
fn e04_nothing_to_return_is_refused() {
    let (mut host, id) = vow_world();
    host.registry
        .set_status(&AUTHOR_A, &id, Status::Paused, T)
        .unwrap();
    // No instance at all.
    assert_eq!(
        host.withdraw(&withdraw_call(&host, id, T)),
        Err(ExtError::NothingToWithdraw)
    );
    // An instance whose escrow already came back through fulfil.
    let (mut host, id) = vow_world();
    host.call(&call(id, PLEDGE, &[8_000, 1], 0, T)).unwrap();
    host.call(&call(id, FULFIL, &[], 1, T + BELL)).unwrap();
    host.registry
        .set_status(&AUTHOR_A, &id, Status::Revoked, T + 2 * BELL)
        .unwrap();
    assert_eq!(
        host.withdraw(&withdraw_call(&host, id, T + 2 * BELL)),
        Err(ExtError::NothingToWithdraw)
    );
}

#[test]
fn e05_a_replayed_exit_does_not_verify() {
    let (mut host, id) = vow_world();
    host.call(&call(id, PLEDGE, &[8_000, 6], 0, T)).unwrap();
    host.registry
        .set_status(&AUTHOR_A, &id, Status::Paused, T + BELL)
        .unwrap();
    let before = host.clone();
    host.withdraw(&withdraw_call(&host, id, T + 2 * BELL))
        .unwrap();
    let ev = evidence(&before, &host);
    assert_eq!(verify(&ev), Verdict::Pass);
    let mut twice = ev.clone();
    twice.log.push(twice.log[0].clone());
    assert!(!verify(&twice).is_pass(), "{:?}", verify(&twice));
    // An exit recorded while the grant was live and the extension active.
    let mut early = ev.clone();
    early.history.insert(id, vec![(T, Status::Active)]);
    assert!(
        verify(&early).fails_with("ExitNotOpen"),
        "{:?}",
        verify(&early)
    );
}

/// Every sequence of five user, author and clock actions. After every step:
/// holding + escrow is the starting wood, escrow is never negative. After
/// the sequence: the user alone (revoking the user's own grant, then the
/// exit, or fulfil) gets every unit back, and a third party's replay of the
/// whole log is a PASS.
#[test]
fn e06_every_short_history_conserves_and_lets_the_user_out() {
    const ACTIONS: [&str; 7] = [
        "pledge",
        "fulfil",
        "pause",
        "resume",
        "revoke-grant",
        "withdraw",
        "wait",
    ];
    let mut runs = 0;
    let mut refusals = 0;
    let mut exits = 0;
    let mut fulfils = 0;
    for code in 0..ACTIONS.len().pow(5) {
        let (mut host, id) = vow_world();
        let start = host.clone();
        let mut now = T;
        let mut c = code;
        for _ in 0..5 {
            let a = ACTIONS[c % ACTIONS.len()];
            c /= ACTIONS.len();
            now += BELL;
            let s = seq(&host, &id);
            let res: Result<(), ExtError> = match a {
                "pledge" => host
                    .call(&call(id, PLEDGE, &[5_000, 2], s, now))
                    .map(|_| ()),
                "fulfil" => host.call(&call(id, FULFIL, &[], s, now)).map(|_| ()),
                "pause" => host
                    .registry
                    .set_status(&AUTHOR_A, &id, Status::Paused, now),
                "resume" => host
                    .registry
                    .set_status(&AUTHOR_A, &id, Status::Active, now),
                "revoke-grant" => {
                    let mut g = host.grants[&(B_CITIZEN, id)].clone();
                    g.revoked = true;
                    host.set_grant(&B_WALLET, g)
                }
                "withdraw" => host.withdraw(&withdraw_call(&host, id, now)).map(|_| ()),
                _ => {
                    now += 3 * BELL;
                    Ok(())
                }
            };
            refusals += res.is_err() as usize;
            exits += (a == "withdraw" && res.is_ok()) as usize;
            fulfils += (a == "fulfil" && res.is_ok()) as usize;
            let e = escrow(&host, &id);
            assert!(e >= 0);
            assert_eq!(wood(&host, &B_HOLDING, now) + e, WOOD0, "code {code}");
        }
        // The user's own way out, whatever the author did.
        now += 200 * BELL;
        if escrow(&host, &id) > 0 {
            let s = seq(&host, &id);
            if host.call(&call(id, FULFIL, &[], s, now)).is_err() {
                let mut g = host.grants[&(B_CITIZEN, id)].clone();
                g.revoked = true;
                host.set_grant(&B_WALLET, g).unwrap();
                host.withdraw(&withdraw_call(&host, id, now))
                    .unwrap_or_else(|e| panic!("code {code}: stuck escrow, {e:?}"));
            }
        }
        assert_eq!(escrow(&host, &id), 0, "code {code}");
        assert_eq!(wood(&host, &B_HOLDING, now), WOOD0, "code {code}");
        let v = verify(&evidence(&start, &host));
        assert_eq!(v, Verdict::Pass, "code {code}: {v:?}");
        runs += 1;
    }
    println!(
        "e06: {runs} histories, {refusals} refused steps, {exits} exits and {fulfils} fulfils inside them; all conserved and recoverable"
    );
    assert!(exits > 0 && fulfils > 0);
}
