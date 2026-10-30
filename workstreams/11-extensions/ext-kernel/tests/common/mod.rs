#![allow(dead_code)]

use permutation_rules::frontier::holding::{Holding, Resource, RESOURCES};
use permutation_rules::frontier::travel::BELL_SECS;
use wylls_ext_kernel::examples::s1_core;
use wylls_ext_kernel::exec::Key;
use wylls_ext_kernel::grant::Grant;
use wylls_ext_kernel::host::{CitizenKeys, HoldingAcct, Host};
use wylls_ext_kernel::manifest::ManifestId;
use wylls_ext_kernel::receipt::Call;
use wylls_ext_kernel::verify::Evidence;

pub const T0: i64 = 1_800_000_000;
pub const BELL: i64 = BELL_SECS;
pub const OPERATOR: Key = [0x0F; 32];
pub const AUTHOR_A: Key = [0xA1; 32];
pub const B_WALLET: Key = [0xB1; 32];
pub const B_SESSION: Key = [0xB2; 32];
pub const B_CITIZEN: Key = [0xB0; 32];
pub const B_HOLDING: Key = [0xB3; 32];
pub const C_WALLET: Key = [0xC1; 32];
pub const C_CITIZEN: Key = [0xC0; 32];
pub const C_HOLDING: Key = [0xC3; 32];
pub const WOOD0: i64 = 50_000;

pub fn holding_with_wood(wood: i64) -> Holding {
    let mut h = Holding::found(T0, 1, 1);
    h.credit(T0, Resource::Wood, wood).unwrap();
    h
}

pub fn add_user(host: &mut Host, citizen: Key, wallet: Key, session: Key, holding: Key) {
    host.citizens.insert(
        citizen,
        CitizenKeys {
            wallet,
            session,
            session_expiry: T0 + 100 * BELL,
        },
    );
    host.holdings.insert(
        holding,
        HoldingAcct {
            owner_citizen: citizen,
            holding: holding_with_wood(WOOD0),
        },
    );
}

/// The world before anything: the S1 core, an operator, user B and user C.
pub fn world() -> Host {
    let mut host = Host::new(s1_core(), OPERATOR);
    add_user(&mut host, B_CITIZEN, B_WALLET, B_SESSION, B_HOLDING);
    add_user(&mut host, C_CITIZEN, C_WALLET, [0; 32], C_HOLDING);
    host
}

pub fn grant(citizen: Key, id: ManifestId, per_call_wood: i64, budget_wood: i64) -> Grant {
    let mut per_call = [0i64; RESOURCES];
    per_call[Resource::Wood as usize] = per_call_wood;
    let mut budget = [0i64; RESOURCES];
    budget[Resource::Wood as usize] = budget_wood;
    Grant {
        citizen,
        manifest_id: id,
        entries: 0b11,
        per_call,
        budget,
        calls_left: 10,
        expires_ts: T0 + 1_000 * BELL,
        revoked: false,
    }
}

pub fn call(id: ManifestId, entry: u8, args: &[i64], seq: u64, now_ts: i64) -> Call {
    Call {
        manifest_id: id,
        citizen: B_CITIZEN,
        holding: B_HOLDING,
        entry,
        args: args.to_vec(),
        seq,
        signer: B_WALLET,
        now_ts,
    }
}

pub fn wood(host: &Host, holding: &Key, now_ts: i64) -> i64 {
    host.holdings[holding].holding.stock_at(now_ts)[Resource::Wood as usize]
}

/// What a third party has: the published bytes and registry history, the
/// state before, the log of calls and receipts since, the state after.
pub fn evidence(before: &Host, after: &Host) -> Evidence {
    Evidence {
        core: Some(after.core),
        manifests: after
            .registry
            .entries
            .iter()
            .map(|(k, r)| (*k, r.bytes.clone()))
            .collect(),
        history: after
            .registry
            .entries
            .iter()
            .map(|(k, r)| (*k, r.history.clone()))
            .collect(),
        citizens: after.citizens.clone(),
        holdings_before: before.holdings.clone(),
        grants_before: before.grants.clone(),
        instances_before: before.instances.clone(),
        created_before: before.created.clone(),
        log: after.log[before.log.len()..].to_vec(),
        instances_after: Some(after.instances.clone()),
        holdings_after: Some(after.holdings.clone()),
    }
}
