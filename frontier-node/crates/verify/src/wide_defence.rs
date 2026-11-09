//! Independent, opt-in consistency check of one WideClaimDefence transition.
//!
//! The caller supplies the exact instruction, ordered account images, Clock,
//! Rent and PS2 record. Arithmetic and gates are restated here, not delegated
//! to a handler, keeper planner or the legacy V13 payment accumulator. A pass
//! means these supplied facts are mutually consistent. DEFENCE_CLAIM commits
//! neither slot identities, timestamp nor before/after state, so it cannot
//! authenticate those facts or establish receipt-driven or whole-Season replay.
//! Existing claim accounts only: allocation and System CPI are unsupported.

use frontier_abi::addr::{defence_claim_seed, keeper_tag8, AddrCtx};
use frontier_abi::bytes::*;
use frontier_abi::layout::{
    beacon::{bell_anchor as BA, defence_claim as DC},
    world::{defence_pool as DP, season as S},
};
use frontier_abi::log::{self, Kind};
use frontier_abi::prologue::ids::SYSTEM_PROGRAM;
use frontier_abi::v2::presets::{PROGRAM_VERSION_S1, RULESET_HASH_V3};
use frontier_abi::world_index::{
    arrival::{arrival_slot_address, wide_arrival_slot as AS, WideArrivalSlot},
    rules::REGION_DOMAIN_WIDE,
    wide_ix::{ClaimDefence, WIDE_EXPERIMENTAL_VERSION_BIT},
    WorldId,
};
use permutation_rules::hash::sha256;

pub const FULL_SEASON_REPLAY_SUPPORTED: bool = false;
pub const AUTHENTICATED_RECEIPT_REPLAY_SUPPORTED: bool = false;
pub const NOT_PROVEN: &[&str] = &[
    "instruction execution, transaction success or keeper signature validity",
    "program binary identity or provenance/freshness of supplied account images",
    "Clock/Rent provenance or anchor/evidence authenticity",
    "binding the PS2 receipt to these slots, timestamp or state images",
    "allocation/CPI, transaction fees, unrelated accounts or other instructions",
    "earlier/later transitions, shared legacy claims or a complete Season",
];

/// Complete supplied account image, ordered as the instruction's metas.
/// Signer/writable are assertions about invocation privileges, not proof of
/// signatures. Lamports are instruction-boundary balances, excluding tx fees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub key: [u8; 32],
    pub owner: [u8; 32],
    pub executable: bool,
    pub rent_epoch: u64,
    pub is_signer: bool,
    pub is_writable: bool,
    pub lamports: u64,
    pub data: Vec<u8>,
}

/// Supplied Clock fields. Only unix_timestamp is read by this instruction;
/// slot is not substituted for the slot recorded in reveal/anchor evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clock {
    pub slot: u64,
    pub epoch_start_timestamp: i64,
    pub epoch: u64,
    pub leader_schedule_epoch: u64,
    pub unix_timestamp: i64,
}

/// The 17-byte Rent fields used by the program's solana-rent 4.4 adapter.
/// No live sysvar read occurs. Nonstandard floating-point thresholds refuse:
/// the supported subset is the exact 1.0 and 2.0 integer Rent calculation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rent {
    pub lamports_per_byte: u64,
    pub exemption_threshold: [u8; 8],
    pub burn_percent: u8,
}
impl Rent {
    fn minimum_balance(self, space: usize) -> Result<u64, Refusal> {
        let multiplier = if self.exemption_threshold == 1f64.to_le_bytes() {
            1
        } else if self.exemption_threshold == 2f64.to_le_bytes() {
            2
        } else {
            return Err(Refusal::Unsupported("nonstandard Rent threshold"));
        };
        // solana-rent validates the rate against the maximum account size,
        // not merely this pool's length. Refuse its would-panic inputs.
        if space > 10 * 1024 * 1024
            || self.lamports_per_byte > u64::MAX / (10 * 1024 * 1024 + 128) / multiplier
        {
            return Err(Refusal::Overflow("Rent"));
        }
        Ok((space as u64 + 128) * self.lamports_per_byte * multiplier)
    }
}

pub struct Transition<'a> {
    pub program: [u8; 32],
    pub season: [u8; 32],
    pub instruction: &'a [u8],
    pub clock: Clock,
    pub rent: Rent,
    /// keeper, Season, shared pool, existing claim, System, (slot, anchor)*n.
    pub before: &'a [Account],
    pub after: &'a [Account],
    /// Exact first sol_log_data field; must equal b"PS2".
    pub receipt_prefix: &'a [u8],
    /// Exact second field, including the zero-link tail, without the prefix.
    pub receipt_body: &'a [u8],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Instruction,
    Accounts(&'static str),
    Account { index: usize, reason: &'static str },
    Season(&'static str),
    Ineligible { index: usize, reason: &'static str },
    Overflow(&'static str),
    Unsupported(&'static str),
    Receipt,
    PostState { index: usize },
}
impl core::fmt::Display for Refusal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Refusal {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub season_id: u64,
    pub bell: u32,
    pub day: u32,
    pub slots: u8,
    pub per_slot_refunds: Vec<u64>,
    pub region_capped: u64,
    pub day_capped: u64,
    pub paid: u64,
    pub partial: bool,
}
impl Verified {
    pub fn full_season(&self) -> bool {
        FULL_SEASON_REPLAY_SUPPORTED
    }
    pub fn authenticated_receipt_replay(&self) -> bool {
        AUTHENTICATED_RECEIPT_REPLAY_SUPPORTED
    }
    pub fn not_proven(&self) -> &'static [&'static str] {
        NOT_PROVEN
    }
}

fn present(
    a: &Account,
    index: usize,
    program: &[u8; 32],
    magic: [u8; 8],
    size: usize,
    id: u64,
) -> Result<(), Refusal> {
    if a.owner != *program
        || a.data.len() < size
        || rd_arr::<8>(&a.data, 0) != Some(magic)
        || rd_u64(&a.data, 8) != Some(id)
    {
        return Err(Refusal::Account {
            index,
            reason: "owner, size, magic or Season id",
        });
    }
    Ok(())
}
fn address(a: &Account, index: usize, expected: [u8; 32]) -> Result<(), Refusal> {
    if a.key != expected {
        return Err(Refusal::Account {
            index,
            reason: "noncanonical address",
        });
    }
    Ok(())
}

// Independent integer transcription of fee cost, ceiling price payment,
// floored defence cap and minimum-tip deduction. No kernel refund call.
fn cost(limit: u32, loaded: u32, created_day: bool) -> u128 {
    limit as u128 + 720 + 300 * (2 + created_day as u128) + 8 * (loaded as u128).div_ceil(32_768)
}
fn refund(s: &WideArrivalSlot, season: &[u8]) -> u64 {
    let baseline = (rd_u32(season, S::MIN_REVEAL_PRIORITY_MILLI).unwrap() as u128
        * cost(
            rd_u32(season, S::REVEAL_CU_LIMIT).unwrap(),
            rd_u32(season, S::REVEAL_LOADED_LIMIT).unwrap(),
            false,
        ))
    .div_ceil(1_000);
    let c = cost(s.ev_limit, s.ev_loaded, s.flags & AS::FLAG_CREATED_DAY != 0);
    let cap = (rd_u32(season, S::DEFENCE_CAP_MILLI).unwrap() as u128 * c / 1_000)
        .saturating_sub(2_500)
        .min(u64::MAX as u128);
    let fee = (s.ev_price as u128 * s.ev_limit as u128)
        .div_ceil(1_000_000)
        .min(u64::MAX as u128);
    // With u32 Season inputs baseline fits u64 (even with the 2,500 tip
    // addition), so the kernel's saturating tip conversion is identical.
    fee.min(cap).saturating_sub(baseline) as u64
}

/// Verify only consistency of the supplied successful instruction transition.
/// Does not fetch, stage via the keeper, dispatch, sign or submit anything.
pub fn verify_transition(t: &Transition<'_>) -> Result<Verified, Refusal> {
    let ix = ClaimDefence::decode(t.instruction).map_err(|_| Refusal::Instruction)?;
    let n = 5 + 2 * ix.n as usize;
    if t.before.len() != n || t.after.len() != n {
        return Err(Refusal::Accounts("exact instruction account count"));
    }
    let a = t.before;
    // Match the handler's account-table privilege rules, including the
    // System position's identity-only check and extra signer privileges.
    for (i, account) in a.iter().enumerate() {
        let writable = matches!(i, 0 | 2 | 3) || (i >= 5 && i % 2 == 1);
        if (writable && !account.is_writable)
            || (!writable && i != 4 && account.is_writable)
            || (i == 0 && !account.is_signer)
        {
            return Err(Refusal::Account {
                index: i,
                reason: "instruction privileges",
            });
        }
        for j in 0..i {
            if account.key == a[j].key {
                // Repeated live anchor metas are legitimate. Anything else
                // aliases a mutable/structurally different role; fail closed.
                if i < 6 || j < 6 || i % 2 != 0 || j % 2 != 0 {
                    return Err(Refusal::Accounts("duplicate slot or aliased account roles"));
                }
                if *account != a[j] || t.after[i] != t.after[j] {
                    return Err(Refusal::Accounts("inconsistent repeated anchor image"));
                }
            }
        }
    }
    address(&a[4], 4, SYSTEM_PROGRAM)?;
    address(&a[1], 1, t.season)?;
    let sd = &a[1].data;
    if sd.len() < S::SIZE || a[1].owner != t.program || rd_arr::<8>(sd, 0) != Some(S::MAGIC) {
        return Err(Refusal::Season("owner, size or magic"));
    }
    let id = rd_u64(sd, S::SEASON_ID).unwrap();
    let bump = rd_u8(sd, S::BUMP).unwrap();
    address(
        &a[1],
        1,
        sha256(&[
            S::PDA_PREFIX,
            &id.to_le_bytes(),
            &[bump],
            &t.program,
            b"ProgramDerivedAddress",
        ]),
    )?;
    let genesis = rd_i64(sd, S::GENESIS_TS).unwrap();
    let now = t.clock.unix_timestamp;
    let stored = rd_u8(sd, S::STATUS).unwrap();
    let status = if stored == S::STATUS_SEEDED && now >= genesis {
        S::STATUS_RUNNING
    } else {
        stored
    };
    if status != S::STATUS_RUNNING && status != S::STATUS_ENDED {
        return Err(Refusal::Season("requires Running or Ended"));
    }
    if rd_arr::<32>(sd, S::RULESET_HASH) != Some(RULESET_HASH_V3) {
        return Err(Refusal::Season("requires S1 ruleset"));
    }
    let version = rd_u16(sd, S::PROGRAM_VERSION).unwrap();
    let wide_s1 = PROGRAM_VERSION_S1 | WIDE_EXPERIMENTAL_VERSION_BIT;
    if version != wide_s1 && version != (wide_s1 | 0x8000) {
        return Err(Refusal::Unsupported(
            "program version is not pinned wide S1 (NFT bit allowed)",
        ));
    }
    let elapsed = now
        .checked_sub(genesis)
        .filter(|x| *x >= 0)
        .ok_or(Refusal::Season("clock before genesis or overflow"))?;
    let bell = u32::try_from(elapsed / 600).map_err(|_| Refusal::Season("bell overflow"))?;
    // Settle does not impose economy's now_bell < end_bell gate.
    if ix.day != bell / 144 {
        return Err(Refusal::Instruction);
    }
    let ctx = AddrCtx {
        season: t.season,
        program: t.program,
    };
    let world = WorldId::derive_legacy_season(&t.season, &t.program)
        .map_err(|_| Refusal::Season("world identity"))?;
    address(&a[2], 2, ctx.defence_pool())?;
    present(&a[2], 2, &t.program, DP::MAGIC, DP::SIZE, id)?;
    address(
        &a[3],
        3,
        ctx.of(&defence_claim_seed(&keeper_tag8(&a[0].key), ix.day)),
    )?;
    if a[3].owner == SYSTEM_PROGRAM && a[3].data.is_empty() {
        return Err(Refusal::Unsupported(
            "absent claim requires allocation/System CPI",
        ));
    }
    present(&a[3], 3, &t.program, DC::MAGIC, DC::SIZE, id)?;
    if rd_arr::<32>(&a[3].data, DC::BENEFICIARY) != Some(a[0].key)
        || rd_u32(&a[3].data, DC::DAY) != Some(ix.day)
    {
        return Err(Refusal::Account {
            index: 3,
            reason: "claim beneficiary or day",
        });
    }
    let region_cap = rd_u64(&a[2].data, DP::PER_BELL_REGION_CAP).unwrap();
    let day_cap = rd_u64(&a[2].data, DP::PER_KEEPER_DAY_CAP).unwrap();
    let claimed = rd_u64(&a[3].data, DC::CLAIMED).unwrap();
    let lateness = rd_u8(sd, S::LATENESS_SLOTS).unwrap() as u64;
    let mut groups: Vec<(u32, u8, u64)> = Vec::new(); // reset on EVERY call
    let mut total = 0u64;
    let mut refunds = Vec::with_capacity(ix.n as usize);
    let mut expected = a.to_vec();
    for k in 0..ix.n as usize {
        let i = 5 + k * 2;
        let fail = |reason| Refusal::Ineligible { index: i, reason };
        if a[i].owner != t.program {
            return Err(fail("slot owner"));
        }
        let s = WideArrivalSlot::read(&a[i].data).map_err(|_| fail("wide slot encoding"))?;
        if s.season_id != id || s.dest.world() != world {
            return Err(fail("slot Season or world"));
        }
        address(
            &a[i],
            i,
            arrival_slot_address(&ctx, s.dest, s.bell, s.faction, s.i),
        )?;
        if s.beneficiary != a[0].key || s.claimed {
            return Err(fail("beneficiary or already claimed"));
        }
        let region = sha256(&[REGION_DOMAIN_WIDE, &s.dest.coord().sort_key()])[0] % 16;
        address(&a[i + 1], i + 1, ctx.bell_anchor(s.bell, region))?;
        present(&a[i + 1], i + 1, &t.program, BA::MAGIC, BA::SIZE, id)?;
        let ad = &a[i + 1].data;
        if rd_u32(ad, BA::BELL) != Some(s.bell) || rd_u8(ad, BA::REGION) != Some(region) {
            return Err(fail("anchor bell or region"));
        }
        let from = rd_u32(sd, S::WINDOW_FROM_BELL).unwrap();
        let window = if from != u32::MAX && s.bell >= from {
            rd_u32(sd, S::WINDOW_NEXT).unwrap()
        } else {
            rd_u32(sd, S::REVEAL_WINDOW).unwrap()
        };
        let close = rd_i64(ad, BA::A).unwrap().saturating_add(window as i64);
        let grace = close
            .checked_add(6 * 600)
            .ok_or(Refusal::Overflow("anchor grace"))?;
        if now >= grace {
            return Err(fail("claim grace closed"));
        }
        if s.ev_slot.saturating_sub(rd_u64(ad, BA::SLOT).unwrap()) < lateness {
            return Err(fail("not late enough"));
        }
        let amount = refund(&s, sd);
        if amount == 0 {
            return Err(fail("zero eligible refund"));
        }
        refunds.push(amount);
        let group_index = if let Some(index) = groups
            .iter()
            .position(|(b, r, _)| *b == s.bell && *r == region)
        {
            index
        } else {
            groups.push((s.bell, region, 0));
            groups.len() - 1
        };
        let group = &mut groups[group_index];
        let admitted = amount.min(region_cap.saturating_sub(group.2));
        group.2 += admitted; // at most the u64 region cap
        total = total
            .checked_add(admitted)
            .ok_or(Refusal::Overflow("refund total"))?;
        // The strict codec establishes canonical bytes; its full rewrite is
        // identical to flipping this one byte. Preserve all other bytes.
        expected[i].data[AS::CLAIMED] = 1;
    }
    let capped = total.min(day_cap.saturating_sub(claimed));
    let floor = t.rent.minimum_balance(DP::SIZE)?;
    // The handler reads claim Rent even on the existing-account branch.
    t.rent.minimum_balance(DC::SIZE)?;
    let paid = capped.min(a[2].lamports.saturating_sub(floor));
    let partial = paid < capped;
    let paid_claim = claimed
        .checked_add(paid)
        .ok_or(Refusal::Overflow("claim claimed"))?;
    let count = rd_u32(&a[3].data, DC::COUNT)
        .unwrap()
        .checked_add(ix.n as u32)
        .ok_or(Refusal::Overflow("claim count"))?;
    let pool_paid = rd_u64(&a[2].data, DP::PAID_TOTAL)
        .unwrap()
        .checked_add(paid)
        .ok_or(Refusal::Overflow("pool paid total"))?;
    let pool_claims = rd_u64(&a[2].data, DP::CLAIMS)
        .unwrap()
        .checked_add(ix.n as u64)
        .ok_or(Refusal::Overflow("pool claims"))?;
    wr_u64(&mut expected[3].data, DC::CLAIMED, paid_claim);
    wr_u32(&mut expected[3].data, DC::COUNT, count);
    wr_u64(&mut expected[2].data, DP::PAID_TOTAL, pool_paid);
    wr_u64(&mut expected[2].data, DP::CLAIMS, pool_claims);
    expected[0].lamports = a[0]
        .lamports
        .checked_add(paid)
        .ok_or(Refusal::Overflow("keeper balance"))?;
    expected[2].lamports = a[2]
        .lamports
        .checked_sub(paid)
        .ok_or(Refusal::Overflow("pool balance"))?;
    // Exact PS2 field, body, key, current bell, payload and zero-link tail.
    let record = log::decode(t.receipt_body).map_err(|_| Refusal::Receipt)?;
    let mut payload = [0u8; 14];
    wr_u32(&mut payload, 0, ix.day);
    payload[4] = ix.n;
    wr_u64(&mut payload, 5, paid);
    payload[13] = partial as u8;
    if t.receipt_prefix != log::PREFIX
        || record.kind != Kind::DEFENCE_CLAIM
        || record.bell != bell
        || record.key != a[0].key
        || record.payload != payload
        || record.n_links != 0
    {
        return Err(Refusal::Receipt);
    }
    for (index, (want, got)) in expected.iter().zip(t.after).enumerate() {
        if want != got {
            return Err(Refusal::PostState { index });
        }
    }
    Ok(Verified {
        season_id: id,
        bell,
        day: ix.day,
        slots: ix.n,
        per_slot_refunds: refunds,
        region_capped: total,
        day_capped: capped,
        paid,
        partial,
    })
}
