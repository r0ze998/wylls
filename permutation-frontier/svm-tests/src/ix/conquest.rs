//! Builders of the MC conquest instructions (MC §5.5): DeclareSiege,
//! SettleSiege, SettleCapture, FoldMarch, RetireHost, CloseMarch, and the
//! v2 SettleTransit with `prev_home_holding` (§5.6). The account order and
//! flags are `frontier_abi::v2::prologue::accounts_of`'s (a test sends what
//! a client sends; `fclient` gains these builders with CQ2-D). The
//! positions in [`at`] serve forgeries.

use fclient::addr::{system_program, Addresses};
use frontier_abi::v2::ix as ix2;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

fn ro(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn rw(k: Address) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn signer_ro(k: Address) -> AccountMeta {
    AccountMeta::new_readonly(k, true)
}
fn signer_rw(k: Address) -> AccountMeta {
    AccountMeta::new(k, true)
}

/// Account positions of the conquest instructions (§5.5).
pub mod at {
    pub mod declare {
        pub const ACTOR: usize = 0;
        pub const PAYER: usize = 1;
        pub const SEASON: usize = 2;
        pub const CITIZEN: usize = 3;
        pub const SRC: usize = 4;
        pub const PROVINCE: usize = 5;
        pub const TARGET: usize = 6;
        pub const OWNER: usize = 7;
        pub const NEARBY: usize = 8;
        pub const SYSTEM: usize = 9;
    }
    pub mod settle_siege {
        pub const PAYER: usize = 0;
        pub const SEASON: usize = 1;
        pub const PROVINCE: usize = 2;
        pub const RECIPIENT: usize = 3;
        pub const SLOT_CITIZEN: usize = 4;
        pub const FUNDER: usize = 5;
    }
    pub mod capture {
        pub const FEE_PAYER: usize = 0;
        pub const SEASON: usize = 1;
        pub const HOLDING: usize = 2;
        pub const PROVINCE: usize = 3;
        pub const CAPTOR: usize = 4;
        pub const CAPTOR_JS: usize = 5;
        pub const VICTIM: usize = 6;
        pub const VICTIM_JS: usize = 7;
        pub const VICTIM_RENT_PAYER: usize = 8;
        pub const STAKE: usize = 9;
        pub const SYSTEM: usize = 10;
    }
    pub mod fold {
        pub const FEE_PAYER: usize = 0;
        pub const SEASON: usize = 1;
        pub const MARCH: usize = 2;
        pub const MEMBER0: usize = 3;
        pub const SYSTEM: usize = 10;
    }
    pub mod retire {
        pub const ACTOR: usize = 0;
        pub const PAYER: usize = 1;
        pub const SEASON: usize = 2;
        pub const VICTIM: usize = 3;
        pub const PROVINCE: usize = 4;
        pub const CAPTURED: usize = 5;
        pub const HOME: usize = 6;
    }
    pub mod close {
        pub const ANY: usize = 0;
        pub const SEASON: usize = 1;
        pub const MARCH: usize = 2;
        pub const RENT_TO: usize = 3;
    }
}

/// The accounts of a DeclareSiege.
#[derive(Clone, Copy, Debug)]
pub struct Declare {
    pub actor: Address,
    pub payer: Address,
    pub citizen: Address,
    pub src: Address,
    pub province: Address,
    pub target: Address,
    pub owner: Address,
    pub nearby: Address,
    pub site: u8,
    pub entry: u8,
    pub nearby_site: u8,
}

/// 0xA0 DeclareSiege.
pub fn declare_siege(a: &Addresses, d: &Declare) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![
            signer_ro(d.actor),
            signer_rw(d.payer),
            ro(a.season),
            rw(d.citizen),
            rw(d.src),
            rw(d.province),
            ro(d.target),
            ro(d.owner),
            ro(d.nearby),
            ro(system_program()),
        ],
        data: ix2::DeclareSiege {
            site: d.site,
            entry: d.entry,
            nearby_site: d.nearby_site,
        }
        .to_bytes()
        .to_vec(),
    }
}

/// 0xA1 SettleSiege: `funder` only when a slot is owed (D-6 of CQ1-C).
pub fn settle_siege(
    a: &Addresses,
    payer: Address,
    province: Address,
    recipient: Address,
    slot_citizen: Address,
    funder: Option<Address>,
    site: u8,
) -> Instruction {
    let mut accounts = vec![
        signer_ro(payer),
        ro(a.season),
        rw(province),
        rw(recipient),
        rw(slot_citizen),
    ];
    if let Some(f) = funder {
        accounts.push(rw(f));
    }
    Instruction {
        program_id: a.program,
        accounts,
        data: ix2::SettleSiege { site }.to_bytes().to_vec(),
    }
}

/// The accounts of a SettleCapture.
#[derive(Clone, Copy, Debug)]
pub struct Capture {
    pub fee_payer: Address,
    pub holding: Address,
    pub province: Address,
    pub captor: Address,
    pub captor_js: Address,
    pub victim: Address,
    pub victim_js: Address,
    pub victim_rent_payer: Address,
    pub stake: Address,
    pub site: u8,
    pub beneficiary: [u8; 32],
}

/// 0xA2 SettleCapture.
pub fn settle_capture(a: &Addresses, x: &Capture) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![
            signer_rw(x.fee_payer),
            ro(a.season),
            rw(x.holding),
            rw(x.province),
            rw(x.captor),
            rw(x.captor_js),
            rw(x.victim),
            rw(x.victim_js),
            rw(x.victim_rent_payer),
            rw(x.stake),
            ro(system_program()),
        ],
        data: ix2::SettleCapture {
            site: x.site,
            beneficiary: x.beneficiary,
        }
        .to_bytes()
        .to_vec(),
    }
}

/// The MarchState of `(m, n)`.
pub fn march_address(a: &Addresses, m: i32, n: i32) -> Address {
    let ctx = frontier_abi::addr::AddrCtx {
        season: a.season.to_bytes(),
        program: a.program.to_bytes(),
    };
    Address::new_from_array(frontier_abi::v2::addr::march_state(&ctx, m, n))
}

/// The seven member Provinces of `(m, n)` in FoldMarch's order.
pub fn march_members(a: &Addresses, m: i32, n: i32) -> [Address; 7] {
    frontier_abi::v2::addr::march_members(m, n).map(|(p, q)| a.province(p, q))
}

/// 0xA5 FoldMarch.
pub fn fold_march(
    a: &Addresses,
    fee_payer: Address,
    m: i32,
    n: i32,
    hour: u32,
    count: u8,
    beneficiary: [u8; 32],
) -> Instruction {
    let mut accounts = vec![
        signer_rw(fee_payer),
        ro(a.season),
        rw(march_address(a, m, n)),
    ];
    for k in march_members(a, m, n) {
        accounts.push(ro(k));
    }
    accounts.push(ro(system_program()));
    Instruction {
        program_id: a.program,
        accounts,
        data: ix2::FoldMarch {
            m,
            n,
            hour,
            count,
            beneficiary,
        }
        .to_bytes()
        .to_vec(),
    }
}

/// 0xA6 RetireHost.
#[allow(clippy::too_many_arguments)]
pub fn retire_host(
    a: &Addresses,
    actor: Address,
    payer: Address,
    victim: Address,
    province: Address,
    captured: Address,
    home: Address,
    entry: u8,
) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![
            signer_ro(actor),
            signer_rw(payer),
            ro(a.season),
            ro(victim),
            rw(province),
            ro(captured),
            ro(home),
        ],
        data: ix2::RetireHost { entry }.to_bytes().to_vec(),
    }
}

/// 0xA7 CloseMarch.
pub fn close_march(a: &Addresses, any: Address, m: i32, n: i32, rent_to: Address) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![
            signer_ro(any),
            ro(a.season),
            rw(march_address(a, m, n)),
            rw(rent_to),
        ],
        data: ix2::CloseMarch {}.to_bytes().to_vec(),
    }
}

/// SettleDeparture's return settle (`transit_slot = 0xFF`): `[payer s]
/// [season] [province w] [holding w]`.
pub fn settle_return(
    a: &Addresses,
    payer: Address,
    province: Address,
    holding: Address,
) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: vec![signer_ro(payer), ro(a.season), rw(province), rw(holding)],
        data: frontier_abi::ix::SettleDeparture { transit_slot: 0xFF }
            .to_bytes()
            .to_vec(),
    }
}
