//! Example manifests for the tests and the demo. **Examples only, not game
//! rules the project has adopted.**

use alloc::string::String;
use alloc::vec;

use frontier_abi::v2::presets::{PROGRAM_VERSION_S1, RULESET_HASH_V3};
use permutation_rules::frontier::holding::{Resource, RESOURCES};

use crate::manifest::{
    ArgSpec, Cmp, CoreVersion, Entry, Field, Manifest, Op, Operand, EFFECT_SET, SCHEMA,
};

/// The S1 core this prototype pins (`PROGRAM_VERSION_S1`, `RULESET_HASH_V3`).
pub fn s1_core() -> CoreVersion {
    CoreVersion {
        program_version: PROGRAM_VERSION_S1,
        ruleset_hash: RULESET_HASH_V3,
    }
}

pub const W: u8 = Resource::Wood as u8;
pub const VOWS: u8 = 0;
pub const UNTIL_BELL: u8 = 1;
pub const RENOWN: u8 = 2;
pub const PLEDGED: u8 = 3;
pub const PLEDGE: u8 = 0;
pub const FULFIL: u8 = 1;
pub const EV_PLEDGED: u8 = 1;
pub const EV_FULFILLED: u8 = 2;

/// "Watch vow" (見張りの誓い): a new state transition the 74 core
/// instructions do not have. A user locks wood for a number of bells; once
/// the time is past, the wood comes back and the user's renown rises.
/// The lock (escrow keyed to a time the user chose) and the renown counter
/// exist nowhere in the core.
///
/// - entry 0 `pledge(amount milli wood 1,000..=20,000, bells 1..=144)`
/// - entry 1 `fulfil()`
pub fn watch_vow(author: [u8; 32]) -> Manifest {
    let mut pay_cap = [0i64; RESOURCES];
    pay_cap[W as usize] = 20_000;
    Manifest {
        schema: SCHEMA,
        effect_set: EFFECT_SET,
        core: s1_core(),
        author,
        name: String::from("watch-vow"),
        fields: vec![
            Field {
                min: 0,
                max: 1_000,
                init: 0,
            },
            Field {
                min: 0,
                max: i64::MAX / 2,
                init: 0,
            },
            Field {
                min: 0,
                max: 1_000,
                init: 0,
            },
            Field {
                min: 0,
                max: 20_000,
                init: 0,
            },
        ],
        max_instances: 3,
        pay_cap,
        entries: vec![
            Entry {
                id: PLEDGE,
                args: vec![
                    ArgSpec {
                        min: 1_000,
                        max: 20_000,
                    },
                    ArgSpec { min: 1, max: 144 },
                ],
                ops: vec![
                    // One open vow at a time.
                    Op::Require(Cmp::Eq, Operand::Field(PLEDGED), Operand::Const(0)),
                    Op::Pay(W, Operand::Arg(0)),
                    Op::Set(PLEDGED, Operand::Arg(0)),
                    Op::Set(UNTIL_BELL, Operand::NowBell),
                    Op::Add(UNTIL_BELL, Operand::Arg(1)),
                    Op::Add(VOWS, Operand::Const(1)),
                    Op::Emit(EV_PLEDGED),
                ],
            },
            Entry {
                id: FULFIL,
                args: vec![],
                ops: vec![
                    Op::Require(Cmp::Gt, Operand::Field(PLEDGED), Operand::Const(0)),
                    Op::Require(Cmp::Ge, Operand::NowBell, Operand::Field(UNTIL_BELL)),
                    Op::Refund(W, Operand::Field(PLEDGED)),
                    Op::Set(PLEDGED, Operand::Const(0)),
                    Op::Add(RENOWN, Operand::Const(1)),
                    Op::Emit(EV_FULFILLED),
                ],
            },
        ],
    }
}

/// The same vow, version 2 by the same author: a shorter minimum lock and
/// renown +2. A different id; grants for version 1 do not reach it.
pub fn watch_vow_v2(author: [u8; 32]) -> Manifest {
    let mut m = watch_vow(author);
    m.name = String::from("watch-vow-2");
    m.entries[0].args[1].min = 0;
    m.entries[1].ops[4] = Op::Add(RENOWN, Operand::Const(2));
    m
}

/// An offering that burns wood and keeps no state: shows the description's
/// warning for resources that never come back. (Proposal A's baseline is
/// not a manifest: it is workstream 03's courier calling SendCaravan.)
pub fn wood_offering(author: [u8; 32]) -> Manifest {
    let mut pay_cap = [0i64; RESOURCES];
    pay_cap[W as usize] = 5_000;
    Manifest {
        schema: SCHEMA,
        effect_set: EFFECT_SET,
        core: s1_core(),
        author,
        name: String::from("wood-offering"),
        fields: vec![],
        max_instances: 100,
        pay_cap,
        entries: vec![Entry {
            id: 0,
            args: vec![],
            ops: vec![Op::Burn(W, Operand::Const(5_000)), Op::Emit(9)],
        }],
    }
}
