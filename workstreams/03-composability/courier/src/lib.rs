//! **wylls-courier**: workstream 03's minimal external program. Another
//! author's Solana program that acts on the same Wylls world through the
//! Frontier program's public instruction, by CPI, and nothing else.
//!
//! It never reads or writes a game rule itself. Ownership, transport,
//! arrival, raids and the destination's generation stay the Frontier
//! program's: the courier builds one typed `SendCaravan` (0xB1) and lets the
//! core refuse it. What the courier adds is only what an external caller
//! needs to check before it spends a CPI: that the target is the Frontier
//! program it was built for, of the program and ruleset version it was
//! built against, and that its own interface version matches.
//!
//! Instruction data, byte 0 the op, byte 1 the courier interface version
//! ([`IFACE_VERSION`]):
//!
//! | op | name | accounts | data after `[op, ver]` |
//! |---|---|---|---|
//! | 0 | `SendSigned` | `[frontier] [actor s] [payer s,w] [season] [citizen w] [src w] [dst] [caravan w] [system] [province w ×1..4]` | SendCaravan's wire bytes (tag 0xB1 first) |
//! | 1 | `RegisterMandate` (**provisional**) | `[wallet s,w] [season] [citizen] [mandate w] [system]` | `expires i64, max_sends u16, max_cargo [u32;8]` |
//! | 2 | `SendDelegated` (**provisional**) | `[frontier] [cranker s] [mandate w] [session] [purse w] [season] [citizen w] [src w] [dst] [caravan w] [system] [province w ×1..4]` | SendCaravan's wire bytes |
//! | 3 | `RevokeMandate` (**provisional**) | `[wallet s,w] [mandate w]` | — |
//!
//! `SendSigned` forwards the signer and writable flags exactly as given:
//! the courier checks no authority of its own, so whatever the core would
//! refuse at top level it refuses here (a CPI cannot add a signature).
//!
//! **Provisional mandate adapter.** Ops 1–3 are a stand-in for
//! workstream 02's Grant, which this workstream does not implement. The
//! adapter only uses what the core already offers: the Citizen's session
//! key, set by the owner's own `SetSession` to the courier's session PDA
//! `["session", season, citizen]`. The core then treats the courier as the
//! session key, with every session limit (no send to another player,
//! `WalletRequired`; the expiry, `SessionExpired`). The adapter's own
//! limits (expiry, number of sends, cargo per resource) are enforced by
//! this program only, and are not a rights model. The caravan's rent and
//! fee come from the purse PDA `["purse", season, citizen]` the owner
//! funded; its rent goes back to the purse when the caravan settles.

#![allow(unexpected_cfgs)]

use frontier_abi::v2::ix::SendCaravan;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::world::season as S;
use frontier_abi::v2::presets::{PROGRAM_VERSION_S1, RULESET_HASH_V3};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process);

/// The courier's own interface version (byte 1 of every instruction).
pub const IFACE_VERSION: u8 = 1;

/// The Frontier program the courier was built for: `COURIER_FRONTIER_ID_HEX`
/// at build time (64 hex digits), else the LiteSVM harness's fixed test id
/// `sha256("PSF-SVM-TESTS program id v1")`.
pub const FRONTIER_ID: [u8; 32] = hex32(match option_env!("COURIER_FRONTIER_ID_HEX") {
    Some(s) => s,
    None => "06239c188a8a90983da33fcbc16c05866b1da7ee260452117be32424c6ba9eb2",
});

/// Ops.
pub const OP_SEND_SIGNED: u8 = 0;
pub const OP_REGISTER_MANDATE: u8 = 1;
pub const OP_SEND_DELEGATED: u8 = 2;
pub const OP_REVOKE_MANDATE: u8 = 3;
#[cfg(feature = "hostile")]
pub const OP_HOSTILE: u8 = 0xEE;

/// The courier's own error codes (custom program errors, outside the
/// Frontier program's 1–99).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum CourierError {
    /// Byte 1 is not [`IFACE_VERSION`].
    InterfaceVersion = 9001,
    /// The target is not the Frontier program the courier was built for, or
    /// an account that must be the Frontier program's is not.
    WrongFrontier = 9002,
    /// The Season's `program_version` or `ruleset_hash` is not the one the
    /// courier was built against.
    FrontierVersion = 9003,
    /// The forwarded instruction is not a well-formed SendCaravan.
    BadInstruction = 9004,
    /// The mandate is not this program's, or not for this season / citizen,
    /// or a PDA is not the derived one.
    MandateMismatch = 9005,
    /// The mandate's expiry has passed.
    MandateExpired = 9006,
    /// The mandate's sends are used up.
    MandateExhausted = 9007,
    /// The cargo is over the mandate's cap for a resource.
    CargoOverCap = 9008,
    /// The signer is not the Citizen's wallet.
    NotWallet = 9009,
    /// Missing or extra accounts.
    Accounts = 9010,
}

impl From<CourierError> for ProgramError {
    fn from(e: CourierError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// Mandate account (provisional adapter), owned by the courier.
pub mod mandate {
    pub const MAGIC: [u8; 8] = *b"WCMANDT1";
    pub const LAYOUT: u8 = 1;
    pub const HDR_MAGIC: usize = 0;
    pub const LAYOUT_VERSION: usize = 8;
    pub const BUMP: usize = 9;
    pub const SESSION_BUMP: usize = 10;
    pub const PURSE_BUMP: usize = 11;
    pub const SEASON: usize = 12;
    pub const CITIZEN: usize = 44;
    pub const WALLET: usize = 76;
    pub const EXPIRES: usize = 108;
    pub const MAX_SENDS: usize = 116;
    pub const USED: usize = 118;
    pub const MAX_CARGO: usize = 120;
    pub const SIZE: usize = 152;
    pub const SEED: &[u8] = b"mandate";
    pub const SESSION_SEED: &[u8] = b"session";
    pub const PURSE_SEED: &[u8] = b"purse";
}

pub fn process(program_id: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let (&op, rest) = d.split_first().ok_or(CourierError::BadInstruction)?;
    let (&ver, body) = rest.split_first().ok_or(CourierError::InterfaceVersion)?;
    if ver != IFACE_VERSION {
        return Err(CourierError::InterfaceVersion.into());
    }
    match op {
        OP_SEND_SIGNED => send_signed(a, body),
        OP_REGISTER_MANDATE => register_mandate(program_id, a, body),
        OP_SEND_DELEGATED => send_delegated(program_id, a, body),
        OP_REVOKE_MANDATE => revoke_mandate(program_id, a),
        #[cfg(feature = "hostile")]
        OP_HOSTILE => hostile(a, body),
        _ => Err(CourierError::BadInstruction.into()),
    }
}

// ------------------------------------------------------------ checks

/// The target program account is the Frontier program the courier was
/// built for.
fn check_frontier(f: &AccountInfo) -> ProgramResult {
    if f.key.to_bytes() != FRONTIER_ID || !f.executable {
        return Err(CourierError::WrongFrontier.into());
    }
    Ok(())
}

/// The Season is the Frontier program's and of the program and ruleset
/// version the courier was built against (S1: program version 4, ruleset
/// v3). The Frontier program checks the Season itself again (address,
/// status, ruleset); this check only keeps the courier from driving a
/// Frontier it was not built for.
fn check_season(season: &AccountInfo) -> ProgramResult {
    if season.owner.to_bytes() != FRONTIER_ID {
        return Err(CourierError::WrongFrontier.into());
    }
    let d = season.try_borrow_data()?;
    if d.len() < S::SIZE || d[..8] != S::MAGIC {
        return Err(CourierError::WrongFrontier.into());
    }
    let pv = u16::from_le_bytes([d[S::PROGRAM_VERSION], d[S::PROGRAM_VERSION + 1]]);
    if pv != PROGRAM_VERSION_S1 || d[S::RULESET_HASH..S::RULESET_HASH + 32] != RULESET_HASH_V3 {
        msg!(
            "courier: Frontier program_version {} not the courier's {}",
            pv,
            PROGRAM_VERSION_S1
        );
        return Err(CourierError::FrontierVersion.into());
    }
    Ok(())
}

/// The forwarded data is one SendCaravan (tag and exact length).
fn send_caravan(body: &[u8]) -> Result<SendCaravan, ProgramError> {
    SendCaravan::decode(body).map_err(|_| CourierError::BadInstruction.into())
}

fn meta(ai: &AccountInfo) -> AccountMeta {
    AccountMeta {
        pubkey: *ai.key,
        is_signer: ai.is_signer,
        is_writable: ai.is_writable,
    }
}

// ------------------------------------------------------------ 0 SendSigned

/// `[frontier] ‖ SendCaravan's own list`: the owner (or its session key)
/// signed the outer transaction; the flags go through unchanged.
fn send_signed(a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    let (frontier, inner) = a.split_first().ok_or(CourierError::Accounts)?;
    check_frontier(frontier)?;
    let season = inner.get(2).ok_or(CourierError::Accounts)?;
    check_season(season)?;
    let x = send_caravan(body)?;
    let ix = Instruction {
        program_id: *frontier.key,
        accounts: inner.iter().map(meta).collect(),
        data: body.to_vec(),
    };
    invoke(&ix, a)?;
    set_return_data(&x.seq.to_le_bytes());
    msg!("courier: SendCaravan seq {} forwarded", x.seq);
    Ok(())
}

// ------------------------------------------------------------ 1 RegisterMandate (provisional)

/// The System program (`11111111111111111111111111111111`).
const SYSTEM_PROGRAM: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// System `CreateAccount` (solana-program 4 no longer carries the builder).
fn create_account(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM_PROGRAM,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
        data,
    }
}

fn pda(seed: &[u8], season: &Pubkey, citizen: &Pubkey, program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seed, season.as_ref(), citizen.as_ref()], program)
}

fn pda_at(
    seed: &[u8],
    season: &Pubkey,
    citizen: &Pubkey,
    bump: u8,
    program: &Pubkey,
) -> Result<Pubkey, ProgramError> {
    Pubkey::create_program_address(&[seed, season.as_ref(), citizen.as_ref(), &[bump]], program)
        .map_err(|_| CourierError::MandateMismatch.into())
}

/// The Citizen's wallet signs; the mandate PDA is created and holds the
/// adapter's limits. The Citizen is read from the Frontier program's
/// account (owner checked); its address is the core's to check at each
/// send.
fn register_mandate(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    let [wallet, season, citizen, mandate_ai, system] = a else {
        return Err(CourierError::Accounts.into());
    };
    check_season(season)?;
    if citizen.owner.to_bytes() != FRONTIER_ID {
        return Err(CourierError::WrongFrontier.into());
    }
    {
        let cd = citizen.try_borrow_data()?;
        if cd.len() < C::SIZE || cd[..8] != C::MAGIC {
            return Err(CourierError::WrongFrontier.into());
        }
        if !wallet.is_signer || cd[C::WALLET..C::WALLET + 32] != wallet.key.to_bytes() {
            return Err(CourierError::NotWallet.into());
        }
    }
    if body.len() != 8 + 2 + 32 {
        return Err(CourierError::BadInstruction.into());
    }
    let (m, bump) = pda(mandate::SEED, season.key, citizen.key, program);
    if m != *mandate_ai.key {
        return Err(CourierError::MandateMismatch.into());
    }
    let (_, sbump) = pda(mandate::SESSION_SEED, season.key, citizen.key, program);
    let (_, pbump) = pda(mandate::PURSE_SEED, season.key, citizen.key, program);
    let lamports = Rent::get()?.minimum_balance(mandate::SIZE);
    invoke_signed(
        &create_account(wallet.key, &m, lamports, mandate::SIZE as u64, program),
        &[wallet.clone(), mandate_ai.clone(), system.clone()],
        &[&[
            mandate::SEED,
            season.key.as_ref(),
            citizen.key.as_ref(),
            &[bump],
        ]],
    )?;
    let mut d = mandate_ai.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&mandate::MAGIC);
    d[mandate::LAYOUT_VERSION] = mandate::LAYOUT;
    d[mandate::BUMP] = bump;
    d[mandate::SESSION_BUMP] = sbump;
    d[mandate::PURSE_BUMP] = pbump;
    d[mandate::SEASON..mandate::SEASON + 32].copy_from_slice(season.key.as_ref());
    d[mandate::CITIZEN..mandate::CITIZEN + 32].copy_from_slice(citizen.key.as_ref());
    d[mandate::WALLET..mandate::WALLET + 32].copy_from_slice(wallet.key.as_ref());
    d[mandate::EXPIRES..mandate::EXPIRES + 10].copy_from_slice(&body[..10]);
    d[mandate::USED..mandate::USED + 2].copy_from_slice(&0u16.to_le_bytes());
    d[mandate::MAX_CARGO..mandate::MAX_CARGO + 32].copy_from_slice(&body[10..42]);
    Ok(())
}

// ------------------------------------------------------------ 2 SendDelegated (provisional)

fn rd_u16(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

/// Anyone may crank it (it pays only the transaction fee); the courier
/// signs as the Citizen's session key (the session PDA) and as the payer
/// (the purse PDA). The core decides everything else.
fn send_delegated(program: &Pubkey, a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    if a.len() < 12 {
        return Err(CourierError::Accounts.into());
    }
    let (frontier, cranker, mandate_ai, session, purse) = (&a[0], &a[1], &a[2], &a[3], &a[4]);
    let (season, citizen) = (&a[5], &a[6]);
    let tail = &a[7..]; // [src] [dst] [caravan] [system] [province ×n]
    check_frontier(frontier)?;
    check_season(season)?;
    let x = send_caravan(body)?;
    if !cranker.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if mandate_ai.owner != program {
        return Err(CourierError::MandateMismatch.into());
    }
    let (sbump, pbump) = {
        let d = mandate_ai.try_borrow_data()?;
        if d.len() != mandate::SIZE
            || d[..8] != mandate::MAGIC
            || d[mandate::LAYOUT_VERSION] != mandate::LAYOUT
        {
            return Err(CourierError::MandateMismatch.into());
        }
        if d[mandate::SEASON..mandate::SEASON + 32] != season.key.to_bytes()
            || d[mandate::CITIZEN..mandate::CITIZEN + 32] != citizen.key.to_bytes()
        {
            return Err(CourierError::MandateMismatch.into());
        }
        let expires = i64::from_le_bytes(
            d[mandate::EXPIRES..mandate::EXPIRES + 8]
                .try_into()
                .unwrap(),
        );
        if Clock::get()?.unix_timestamp >= expires {
            return Err(CourierError::MandateExpired.into());
        }
        if rd_u16(&d, mandate::USED) >= rd_u16(&d, mandate::MAX_SENDS) {
            return Err(CourierError::MandateExhausted.into());
        }
        for r in 0..8 {
            let at = 4 * r;
            let want = u32::from_le_bytes(x.cargo[at..at + 4].try_into().unwrap());
            let cap = u32::from_le_bytes(
                d[mandate::MAX_CARGO + at..mandate::MAX_CARGO + at + 4]
                    .try_into()
                    .unwrap(),
            );
            if want > cap {
                return Err(CourierError::CargoOverCap.into());
            }
        }
        (d[mandate::SESSION_BUMP], d[mandate::PURSE_BUMP])
    };
    if pda_at(
        mandate::SESSION_SEED,
        season.key,
        citizen.key,
        sbump,
        program,
    )? != *session.key
        || pda_at(mandate::PURSE_SEED, season.key, citizen.key, pbump, program)? != *purse.key
    {
        return Err(CourierError::MandateMismatch.into());
    }
    // SendCaravan's list: [actor s] [payer s,w] [season] [citizen w] ‖ tail.
    let mut accounts = Vec::with_capacity(4 + tail.len());
    accounts.push(AccountMeta::new_readonly(*session.key, true));
    accounts.push(AccountMeta::new(*purse.key, true));
    accounts.push(AccountMeta::new_readonly(*season.key, false));
    accounts.push(meta(citizen));
    accounts.extend(tail.iter().map(meta));
    let ix = Instruction {
        program_id: *frontier.key,
        accounts,
        data: body.to_vec(),
    };
    invoke_signed(
        &ix,
        a,
        &[
            &[
                mandate::SESSION_SEED,
                season.key.as_ref(),
                citizen.key.as_ref(),
                &[sbump],
            ],
            &[
                mandate::PURSE_SEED,
                season.key.as_ref(),
                citizen.key.as_ref(),
                &[pbump],
            ],
        ],
    )?;
    let mut d = mandate_ai.try_borrow_mut_data()?;
    let used = rd_u16(&d, mandate::USED) + 1;
    d[mandate::USED..mandate::USED + 2].copy_from_slice(&used.to_le_bytes());
    set_return_data(&x.seq.to_le_bytes());
    msg!(
        "courier: delegated SendCaravan seq {} ({} sends used)",
        x.seq,
        used
    );
    Ok(())
}

// ------------------------------------------------------------ 3 RevokeMandate (provisional)

/// The wallet closes its mandate (the lamports go back to it). The
/// delegation the core knows of is the session key: the owner's own
/// `SetSession` revokes that.
fn revoke_mandate(program: &Pubkey, a: &[AccountInfo]) -> ProgramResult {
    let [wallet, mandate_ai] = a else {
        return Err(CourierError::Accounts.into());
    };
    if mandate_ai.owner != program {
        return Err(CourierError::MandateMismatch.into());
    }
    {
        let d = mandate_ai.try_borrow_data()?;
        if d.len() != mandate::SIZE || d[..8] != mandate::MAGIC {
            return Err(CourierError::MandateMismatch.into());
        }
        if !wallet.is_signer || d[mandate::WALLET..mandate::WALLET + 32] != wallet.key.to_bytes() {
            return Err(CourierError::NotWallet.into());
        }
    }
    let l = mandate_ai.lamports();
    **mandate_ai.try_borrow_mut_lamports()? = 0;
    **wallet.try_borrow_mut_lamports()? = wallet
        .lamports()
        .checked_add(l)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    mandate_ai.try_borrow_mut_data()?.fill(0);
    mandate_ai.resize(0)?;
    mandate_ai.assign(&SYSTEM_PROGRAM);
    Ok(())
}

// ------------------------------------------------------------ 0xEE hostile (tests only)

/// Tries to go around the core; the runtime must refuse every case:
/// `1` write byte 64 of `a[0]` (a Frontier account), `2` move one lamport
/// from `a[0]` to `a[1]`, `3` invoke `a[0]` (the Frontier program) with
/// `a[1]` marked signer although it did not sign, the rest as given.
#[cfg(feature = "hostile")]
fn hostile(a: &[AccountInfo], body: &[u8]) -> ProgramResult {
    match body.first() {
        Some(1) => {
            let mut d = a[0].try_borrow_mut_data()?;
            d[64] ^= 0xFF;
            Ok(())
        }
        Some(2) => {
            **a[0].try_borrow_mut_lamports()? -= 1;
            **a[1].try_borrow_mut_lamports()? += 1;
            Ok(())
        }
        Some(3) => {
            let (frontier, inner) = a.split_first().ok_or(CourierError::Accounts)?;
            let mut accounts: Vec<AccountMeta> = inner.iter().map(meta).collect();
            accounts[0].is_signer = true;
            let ix = Instruction {
                program_id: *frontier.key,
                accounts,
                data: body[1..].to_vec(),
            };
            invoke(&ix, a)
        }
        _ => Err(CourierError::BadInstruction.into()),
    }
}

// ------------------------------------------------------------ hex

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("COURIER_FRONTIER_ID_HEX: not hex"),
    }
}

const fn hex32(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    assert!(b.len() == 64, "COURIER_FRONTIER_ID_HEX: 64 hex digits");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = nib(b[2 * i]) << 4 | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_frontier_id_is_the_harness_test_id() {
        // sha256("PSF-SVM-TESTS program id v1"), chain::program_id()'s default.
        assert_eq!(FRONTIER_ID[0], 0x06);
        assert_eq!(FRONTIER_ID[31], 0xb2);
    }

    #[test]
    fn mandate_fields_fit() {
        assert_eq!(mandate::MAX_CARGO + 32, mandate::SIZE);
        assert_eq!(mandate::EXPIRES + 8, mandate::MAX_SENDS);
    }
}
