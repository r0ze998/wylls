//! The keeper's **real** unsigned Depart Message, joined to the existing
//! original-host departure fixture and the actual handler.
//!
//! Inputs, both committed and both Rust output (never hand-written):
//! - `expedition-depart-accounts.json`: this fixture's accounts and command,
//!   exported below and checked to still be the current fixture;
//! - `expedition-depart-prepared-report.json`: the keeper's
//!   `experimental_expedition_depart_prepare::prepare` report over exactly
//!   those accounts (regenerated and compared by the keeper test
//!   `runtime_contract_departure_report_is_the_committed_fixture`).
//!
//! Route: the Message is strictly decoded (test support), mapped onto
//! transaction accounts in message-key order, and its game instruction is run
//! through `crate::dispatch` on the official native serializer + System
//! bridge. In this **host-only `expedition-dispatch-experimental` build**
//! `dispatch` forwards the versioned `ff02` wrapper to
//! `expedition_dispatch::execute`, the existing private test routing; the
//! deployable build has no such route. The three compute-budget instructions
//! are decoded and compared, not executed. No key, signature, transaction,
//! bank, SBF VM, seal opening or send is involved: signer bits are what the
//! unsigned Message requests, treated as fixture privileges.
use super::*;
use runtime_contract_support::unsigned_message::{self as um, Json};

const ACCOUNTS_FIXTURE: &str =
    include_str!("../../runtime-contract-tests/fixtures/expedition-depart-accounts.json");
const REPORT_FIXTURE: &str =
    include_str!("../../runtime-contract-tests/fixtures/expedition-depart-prepared-report.json");
const ACCOUNTS_SCHEMA: &str = "frontier-runtime-contract-depart-accounts-v1";
const PROGRAM: [u8; 32] = [0x12; 32];
const COMPUTE_BUDGET: Pubkey = Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// This fixture as the keeper's input: every account but the program and
/// the System loader stub, with the request facts of its command.
fn export() -> String {
    let (accounts, roles, _, command) = departure_accounts();
    let key = |role: usize| accounts[roles[role].index_in_transaction as usize].0;
    let standing = &accounts[roles[5].index_in_transaction as usize].1;
    let r = Ro(standing.data());
    let now = prologue::now().unwrap();
    let rows: Vec<String> = accounts
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != roles[6].index_in_transaction as usize)
        .filter(|(_, (k, _))| k.to_bytes() != PROGRAM)
        .map(|(_, (k, a))| {
            format!(
                "{{\"address\":\"{k}\",\"owner\":\"{}\",\"lamports\":\"{}\",\"executable\":false,\"data\":\"{}\"}}",
                a.owner(),
                a.lamports(),
                hexs(a.data())
            )
        })
        .collect();
    format!(
        "{{\"schema\":\"{ACCOUNTS_SCHEMA}\",\"program\":\"{}\",\"season\":\"{}\",\"wallet\":\"{}\",\"payer\":\"{}\",\
\"ruleset_hash\":\"{}\",\"program_version\":\"{}\",\"unix_timestamp\":\"{}\",\"standing\":{{\"p\":\"{}\",\"q\":\"{}\"}},\
\"host\":\"{}\",\"transit_slot\":\"{}\",\"arrive_bell\":\"{}\",\"tip\":\"{}\",\"public_commit\":\"{}\",\"public_seal\":\"{}\",\
\"accounts\":[{}]}}",
        Pubkey::new_from_array(PROGRAM),
        key(2),
        key(0),
        key(1),
        hexs(&crate::RULESET_HASH),
        crate::PROGRAM_VERSION,
        now.ts,
        r.i16(PV::P).unwrap(),
        r.i16(PV::Q).unwrap(),
        hexs(&command.host),
        command.transit_slot,
        command.arrive_bell,
        command.tip,
        hexs(&command.commit),
        hexs(&command.seal),
        rows.join(",")
    )
}

#[test]
fn departure_accounts_export_is_the_committed_fixture() {
    let fresh = export();
    if fresh != ACCOUNTS_FIXTURE.trim_end() {
        println!("{fresh}");
        panic!("expedition-depart-accounts.json is stale: replace it with the line above");
    }
    assert!(Json::parse(ACCOUNTS_FIXTURE).is_ok());
}

/// The parts of a prepared report this boundary consumes.
#[derive(Clone)]
struct Prepared {
    message: um::Message,
    program: String,
    season: String,
    fee_payer: String,
    program_version: String,
    cu_limit: u32,
    loaded_limit: u32,
    /// `(address, signer, writable)` in canonical role order.
    roles: Vec<(String, bool, bool)>,
}

/// A prepared report, refused unless it is a closed, unsigned, host-only
/// Depart whose Message digest matches.
fn prepared(report: &str) -> Prepared {
    let v = Json::parse(report).expect("strict report");
    let s = |path: &[&str]| v.at(path).and_then(Json::str).unwrap_or_else(|| panic!("{path:?}"));
    assert_eq!(s(&["schema"]), "frontier-experimental-expedition-depart-prepare-report-v1");
    assert_eq!(s(&["status"]), "prepared");
    assert_eq!(v.get("host_only"), Some(&Json::Bool(true)));
    for k in ["ready", "deployment_verified", "admitted", "signed", "enqueued", "relay_submission_available", "automatic_send", "seal_verified"] {
        assert_eq!(v.get(k), Some(&Json::Bool(false)), "{k}");
    }
    assert_eq!(s(&["prepared", "action"]), "Depart");
    assert_eq!(v.at(&["prepared", "budget", "cu_price"]).and_then(Json::str), Some("0"));
    assert_eq!(v.at(&["prepared", "budget", "heap"]), Some(&Json::Null));
    let bytes = um::base64_standard(s(&["prepared", "message_b64"])).unwrap();
    assert_eq!(
        hexs(&permutation_rules::hash::sha256(&[&bytes])),
        s(&["prepared", "message_digest"])
    );
    let num = |path: &[&str]| match v.at(path) {
        Some(Json::Num(n)) => n.parse::<u32>().unwrap(),
        other => panic!("{path:?}: {other:?}"),
    };
    let roles = match v.at(&["prepared", "roles"]) {
        Some(Json::Arr(roles)) => roles
            .iter()
            .map(|r| {
                (
                    r.get("address").and_then(Json::str).unwrap().to_owned(),
                    r.get("signer") == Some(&Json::Bool(true)),
                    r.get("writable") == Some(&Json::Bool(true)),
                )
            })
            .collect(),
        other => panic!("roles: {other:?}"),
    };
    Prepared {
        message: um::decode(&bytes).expect("strict legacy message"),
        program: s(&["prepared", "program"]).to_owned(),
        season: s(&["prepared", "season"]).to_owned(),
        fee_payer: s(&["prepared", "fee_payer"]).to_owned(),
        program_version: s(&["prepared", "program_version"]).to_owned(),
        cu_limit: num(&["prepared", "budget", "cu_limit"]),
        loaded_limit: num(&["prepared", "budget", "loaded_limit"]),
        roles,
    }
}

/// The decoded Message as one native boundary call: transaction accounts are
/// the message keys in order (fixture bytes by key; the compute-budget
/// program a native-loader stub that is never invoked), the last instruction
/// is the call. No policy: see `check`.
fn call(m: &um::Message, world: &Accounts) -> Result<(Accounts, u16, Vec<InstructionAccount>, Vec<u8>), &'static str> {
    let game = m.instructions.last().ok_or("Instructions")?;
    let accounts = m
        .keys
        .iter()
        .map(|k| {
            let k = Pubkey::new_from_array(*k);
            match world.iter().find(|(w, _)| *w == k) {
                Some(found) => Ok(found.clone()),
                None if k == COMPUTE_BUDGET => {
                    let mut stub = AccountSharedData::new(1, 0, &Pubkey::from_str_const("NativeLoader1111111111111111111111111111111"));
                    stub.set_executable(true);
                    Ok((k, stub))
                }
                None => Err("UnknownAccount"),
            }
        })
        .collect::<Result<Accounts, _>>()?;
    Ok((accounts, u16::from(game.program), m.privileges(game), game.data.clone()))
}

/// The strict boundary policy against the report: exactly the three
/// compute-budget instructions of its budget then one Depart of this program
/// version; the report's fee payer first; the game accounts exactly the
/// report's roles (key, signer, writable, alias included); no other key and
/// no other signer.
fn check(p: &Prepared) -> Result<(), &'static str> {
    let m = &p.message;
    let b58 = |i: usize| Pubkey::new_from_array(m.keys[i]).to_string();
    if p.program_version != crate::PROGRAM_VERSION.to_string() {
        return Err("Version");
    }
    if m.instructions.len() != 4 {
        return Err("Instructions");
    }
    let mut limit = vec![2];
    limit.extend_from_slice(&p.cu_limit.to_le_bytes());
    let mut price = vec![3];
    price.extend_from_slice(&0u64.to_le_bytes());
    let mut loaded = vec![4];
    loaded.extend_from_slice(&p.loaded_limit.to_le_bytes());
    for (ix, data) in m.instructions.iter().zip([limit, price, loaded]) {
        if b58(ix.program.into()) != COMPUTE_BUDGET.to_string() || !ix.accounts.is_empty() || ix.data != data {
            return Err("ComputeBudget");
        }
    }
    let game = &m.instructions[3];
    if b58(game.program.into()) != p.program || p.program != Pubkey::new_from_array(PROGRAM).to_string() {
        return Err("Program");
    }
    if b58(0) != p.fee_payer || p.roles.get(1).map(|r| &r.0) != Some(&p.fee_payer) {
        return Err("FeePayer");
    }
    match ix::Command::decode(&game.data) {
        Ok(c) if c.kind() == ix::Kind::Depart => {}
        _ => return Err("Instruction"),
    }
    if game.accounts.len() != p.roles.len() {
        return Err("Roles");
    }
    for (&i, (address, signer, writable)) in game.accounts.iter().zip(&p.roles) {
        let i = usize::from(i);
        if b58(i) != *address {
            return Err("Role");
        }
        if m.is_signer(i) != *signer || m.is_writable(i) != *writable {
            return Err("Privilege");
        }
    }
    if p.roles.get(2).map(|r| &r.0) != Some(&p.season) {
        return Err("Role");
    }
    for i in 0..m.keys.len() {
        let named = p.roles.iter().any(|r| r.0 == b58(i)) || b58(i) == p.program || b58(i) == COMPUTE_BUDGET.to_string();
        if !named {
            return Err("ExtraAccount");
        }
        if m.is_signer(i) && !p.roles.iter().any(|r| r.0 == b58(i) && r.1) {
            return Err("Privilege");
        }
    }
    Ok(())
}

/// One native boundary call. `ok`: the handler's result is the call's result.
/// Otherwise the handler must refuse, and the closure returns `Ok` so the
/// official writeback runs and would expose any partial write.
fn run(call: (Accounts, u16, Vec<InstructionAccount>, Vec<u8>), ok: bool) -> rt::system_cpi::Output {
    let (accounts, program, privileges, data) = call;
    // SAFETY: official aligned serializer owns every AccountInfo; the handler
    // keeps no reference; signer bits are fixture privileges.
    unsafe {
        rt::system_cpi::run(accounts, program, privileges, data, |p, a, d| {
            let result = crate::dispatch(p, a, d);
            if ok {
                result.map_err(Into::into)
            } else {
                assert!(result.is_err(), "the handler accepted a refused call");
                Ok(())
            }
        })
    }
    .unwrap()
}

#[track_caller]
fn refused_without_effects(c: (Accounts, u16, Vec<InstructionAccount>, Vec<u8>)) {
    let before: Vec<_> = c.0.iter().map(|(_, a)| a.clone()).collect();
    let out = run(c, false);
    assert!(out.logs.is_empty() && out.cpis.is_empty());
    assert_eq!(out.accounts, before);
}

#[test]
fn keeper_prepared_message_reaches_the_actual_departure_handler_and_writeback() {
    let (world, roles, program_index, command) = departure_accounts();
    let p = prepared(REPORT_FIXTURE);
    check(&p).unwrap();
    let c = call(&p.message, &world).unwrap();
    // The keeper's canonical draft is byte for byte this fixture's command.
    assert_eq!(c.3, ix::encode(ix::Kind::Depart, &command.to_bytes()).unwrap());
    // Role for role the existing fixture: key and privileges, and the
    // standing/home alias is one transaction account on both sides.
    assert_eq!(c.2.len(), roles.len());
    for (i, (m, f)) in c.2.iter().zip(&roles).enumerate() {
        assert_eq!(c.0[m.index_in_transaction as usize].0, world[f.index_in_transaction as usize].0, "role {i}");
        assert_eq!((m.is_signer(), m.is_writable()), (f.is_signer(), f.is_writable()), "role {i}");
    }
    assert_eq!(c.2[5].index_in_transaction, c.2[7].index_in_transaction);
    let accounts = c.0.clone();
    let via_message = run(c, true);
    let via_fixture = run((world.clone(), program_index, roles.clone(), ix::encode(ix::Kind::Depart, &command.to_bytes()).unwrap()), true);
    // The same handler outcome: per key the same writeback, logs and CPIs.
    for ((k, before), out) in accounts.iter().zip(&via_message.accounts) {
        match world.iter().position(|(w, _)| w == k) {
            Some(j) => assert_eq!(out, &via_fixture.accounts[j], "{k}"),
            None => {
                assert_eq!(*k, COMPUTE_BUDGET);
                assert_eq!(out, before);
            }
        }
    }
    assert_eq!(via_message.logs, via_fixture.logs);
    assert_eq!(via_message.cpis, via_fixture.cpis);
    assert_eq!(via_message.logs.len(), 1);
    let at = |role: usize| p.message.instructions[3].accounts[role] as usize;
    assert_eq!(via_message.accounts[at(8)].owner().to_bytes(), PROGRAM);
    assert_eq!(Ro(via_message.accounts[at(4)].data()).u64(H::ESCROW).unwrap(), command.tip);
    assert_eq!(
        via_message.accounts.iter().map(|a| a.lamports() as u128).sum::<u128>(),
        accounts.iter().map(|(_, a)| a.lamports() as u128).sum::<u128>()
    );
}

#[test]
fn real_message_bytes_are_refused_by_the_strict_decoder_when_reshaped() {
    let v = Json::parse(REPORT_FIXTURE).unwrap();
    let bytes = um::base64_standard(v.at(&["prepared", "message_b64"]).and_then(Json::str).unwrap()).unwrap();
    assert!(um::decode(&bytes).is_ok());
    let mut versioned = vec![0x80];
    versioned.extend_from_slice(&bytes);
    let mut trailing = bytes.clone();
    trailing.push(0);
    let mut duplicate = bytes.clone();
    // keys start after the 3-byte header and a one-byte key count
    let first: [u8; 32] = duplicate[4..36].try_into().unwrap();
    duplicate[36..68].copy_from_slice(&first);
    for (bad, e) in [
        (versioned, um::MessageError::Versioned),
        (trailing, um::MessageError::TrailingBytes),
        (bytes[..bytes.len() - 1].to_vec(), um::MessageError::Truncated),
        (duplicate, um::MessageError::DuplicateKey),
    ] {
        assert_eq!(um::decode(&bad), Err(e));
    }
}

/// Every tamper is refused by the boundary policy. For the cases marked as
/// handler refusals, the actual handler also refuses and no log, CPI or
/// account change remains after the forced writeback. (Not every tamper is
/// such a case: a writable wallet is accepted by the handler, pinned below.)
#[test]
fn tampered_prepared_messages_are_refused_before_any_effect() {
    let (world, roles, ..) = departure_accounts();
    let good = prepared(REPORT_FIXTURE);
    let index_of = |role: usize| good.message.instructions[3].accounts[role];
    type Tamper = fn(&mut Prepared, &[u8]);
    let cases: [(&str, Tamper, &str, bool); 13] = [
        // fee payer and wallet swapped: the wallet would pay and be writable
        ("fee payer", |p, _| p.message.keys.swap(0, 1), "FeePayer", true),
        // another program key (no such program account is presented)
        ("program", |p, _| {
            let i = usize::from(p.message.instructions[3].program);
            p.message.keys[i] = [0x13; 32];
        }, "Program", false),
        ("report version", |p, _| p.program_version = (crate::PROGRAM_VERSION ^ 0x0800).to_string(), "Version", false),
        ("wire version", |p, _| p.message.instructions[3].data[2] ^= 1, "Instruction", true),
        ("kind", |p, _| p.message.instructions[3].data[3] = ix::Kind::Dissolve as u8, "Instruction", true),
        ("truncated", |p, _| { p.message.instructions[3].data.pop(); }, "Instruction", true),
        ("extended", |p, _| p.message.instructions[3].data.push(0), "Instruction", true),
        // one more account on the call (a duplicate of the holding)
        ("extra account", |p, _| {
            let h = p.message.instructions[3].accounts[4];
            p.message.instructions[3].accounts.push(h);
        }, "Roles", true),
        ("missing account", |p, _| { p.message.instructions[3].accounts.pop(); }, "Roles", true),
        // the transit role aliased to the writable Holding
        ("alias", |p, r| p.message.instructions[3].accounts[8] = r[4], "Role", true),
        // the read-only signer wallet escalated to writable: refused here
        // by the boundary policy only; the actual handler's role check
        // accepts extra privilege on the wallet (asserted below)
        ("wallet writable", |p, _| p.message.header.readonly_signed = 0, "Privilege", false),
        // one more key escalated to a requested signer
        ("extra signer", |p, _| p.message.header.signatures += 1, "Privilege", true),
        // one extra, unreferenced key in the message
        // (read-only, so no existing key changes privilege)
        ("unreferenced key", |p, _| {
            p.message.keys.push([0x77; 32]);
            p.message.header.readonly_unsigned += 1;
        }, "ExtraAccount", false),
    ];
    let indices: Vec<u8> = (0..9).map(index_of).collect();
    for (name, tamper, code, handler) in cases {
        let mut p = good.clone();
        tamper(&mut p, &indices);
        assert_eq!(check(&p), Err(code), "{name}");
        if handler {
            refused_without_effects(call(&p.message, &world).unwrap());
        }
    }
    // Pinned limit of the handler (not of this boundary): a writable wallet
    // is an over-privilege the existing role check accepts, so the departure
    // succeeds there; only `check` refuses that Message.
    let mut escalated = good.clone();
    escalated.message.header.readonly_signed = 0;
    let out = run(call(&escalated.message, &world).unwrap(), true);
    assert_eq!(out.logs.len(), 1);
    // A Season of another program version: the policy cannot see it, the
    // handler refuses it before any effect.
    let mut other = world.clone();
    let season = roles[2].index_in_transaction as usize;
    let mut sd = other[season].1.data().to_vec();
    Rw(&mut sd).set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION ^ 0x0800).unwrap();
    other[season].1.set_data_from_slice(&sd);
    check(&good).unwrap();
    refused_without_effects(call(&good.message, &other).unwrap());
    // A payer that cannot fund the escrow: the handler refuses it, and with
    // the official writeback forced after the refusal nothing changed (no
    // partial write before the failing check).
    let mut poor = world.clone();
    let payer = roles[1].index_in_transaction as usize;
    poor[payer].1.set_lamports(1);
    refused_without_effects(call(&good.message, &poor).unwrap());
}

/// The same prepared Message replayed on the state its first success left:
/// refused by the actual handler without effects.
#[test]
fn replaying_the_prepared_message_on_its_own_result_is_refused() {
    let (world, ..) = departure_accounts();
    let p = prepared(REPORT_FIXTURE);
    let c = call(&p.message, &world).unwrap();
    let keys: Vec<Pubkey> = c.0.iter().map(|(k, _)| *k).collect();
    let first = run(c, true);
    let after: Accounts = keys.into_iter().zip(first.accounts).collect();
    refused_without_effects(call(&p.message, &after).unwrap());
}
