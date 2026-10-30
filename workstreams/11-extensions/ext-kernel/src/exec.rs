//! The interpreter: one entry of one manifest over one user's instance and
//! that user's own Holding. A pure function of its inputs (no clock but the
//! `now_ts` given, no randomness, no other account), so a verifier that
//! runs it again gets the same bytes.
//!
//! Core resources move only through the rules kernel's `Holding::pay` and
//! `Holding::credit`; the interpreter never writes a store.

use alloc::vec::Vec;

use permutation_rules::frontier::holding::{Holding, HoldingError, Resource, RESOURCES};
use permutation_rules::frontier::travel::BELL_SECS;
use permutation_rules::hash::{sha256, Digest32};

use crate::error::ExtError;
use crate::manifest::{Manifest, ManifestId, Op, Operand};

pub type Key = [u8; 32];
const STATE_DOMAIN: &[u8] = b"WYLLS-EXT-STATE\0";

/// One user's state under one manifest (contract §5). Fixed size per
/// manifest: `fields.len()` is the manifest's field count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance {
    pub seq: u64,
    pub fields: Vec<i64>,
    pub escrow: [i64; RESOURCES],
    /// The receipt chain's head (zero before the first call).
    pub last_receipt: Digest32,
}

impl Instance {
    pub fn fresh(m: &Manifest) -> Instance {
        Instance {
            seq: 0,
            fields: m.fields.iter().map(|f| f.init).collect(),
            escrow: [0; RESOURCES],
            last_receipt: [0; 32],
        }
    }

    /// The hash a receipt names as pre/post state. It leaves out
    /// `last_receipt` (the receipt names its predecessor itself), so a
    /// receipt can commit to the state it leaves.
    pub fn state_hash(&self, id: &ManifestId, citizen: &Key) -> Digest32 {
        let mut b = Vec::with_capacity(8 + 8 * (self.fields.len() + RESOURCES));
        b.extend_from_slice(&self.seq.to_le_bytes());
        b.extend_from_slice(&(self.fields.len() as u8).to_le_bytes());
        for f in &self.fields {
            b.extend_from_slice(&f.to_le_bytes());
        }
        for e in &self.escrow {
            b.extend_from_slice(&e.to_le_bytes());
        }
        sha256(&[STATE_DOMAIN, id, citizen, &b])
    }
}

/// What one successful run changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub instance: Instance,
    pub holding: Holding,
    /// Settled stock after minus settled stock before, at `now_ts`.
    pub holding_delta: [i64; RESOURCES],
    pub escrow_delta: [i64; RESOURCES],
    pub burned: [i64; RESOURCES],
    /// Pay + Burn per resource: what left the Holding by this call's own
    /// choice (the amount grants cap).
    pub spent: [i64; RESOURCES],
    pub events: Vec<u8>,
}

fn holding_err(e: HoldingError) -> ExtError {
    match e {
        HoldingError::Insufficient => ExtError::Insufficient,
        HoldingError::TimeReversed => ExtError::TimeReversed,
        _ => ExtError::Overflow,
    }
}

fn eval(o: &Operand, args: &[i64], inst: &Instance, now_ts: i64) -> i64 {
    // Every reference was checked at publication (`Manifest::validate`) and
    // the argument count at the call; the fallbacks are unreachable.
    match *o {
        Operand::Const(v) => v,
        Operand::Arg(i) => args.get(i as usize).copied().unwrap_or(0),
        Operand::Field(i) => inst.fields.get(i as usize).copied().unwrap_or(0),
        Operand::NowBell => now_ts.div_euclid(BELL_SECS),
        Operand::Escrow(r) => inst.escrow.get(r as usize).copied().unwrap_or(0),
    }
}

fn one(r: u8, amount: i64) -> [i64; RESOURCES] {
    let mut c = [0i64; RESOURCES];
    c[r as usize] = amount;
    c
}

/// Runs `entry` with `args`. All or nothing: on any refusal the caller's
/// copies are left as they were (the run works on clones).
pub fn run_entry(
    m: &Manifest,
    entry: u8,
    args: &[i64],
    now_ts: i64,
    inst: &Instance,
    holding: &Holding,
) -> Result<Outcome, ExtError> {
    let e = m.entry(entry).ok_or(ExtError::NoEntry)?;
    if args.len() != e.args.len() {
        return Err(ExtError::ArgCount);
    }
    if args
        .iter()
        .zip(&e.args)
        .any(|(v, s)| *v < s.min || *v > s.max)
    {
        return Err(ExtError::ArgBounds);
    }
    if inst.fields.len() != m.fields.len() {
        return Err(ExtError::FieldBounds);
    }
    let before = holding.stock_at(now_ts);
    let mut st = inst.clone();
    let mut h = holding.clone();
    let mut burned = [0i64; RESOURCES];
    let mut spent = [0i64; RESOURCES];
    let mut events = Vec::new();
    for op in &e.ops {
        match op {
            Op::Require(c, a, b) => {
                if !c.holds(eval(a, args, &st, now_ts), eval(b, args, &st, now_ts)) {
                    return Err(ExtError::RequireFailed);
                }
            }
            Op::Set(f, x) | Op::Add(f, x) => {
                let i = *f as usize;
                let v = eval(x, args, &st, now_ts);
                let nv = match op {
                    Op::Set(..) => v,
                    _ => st.fields[i].checked_add(v).ok_or(ExtError::Overflow)?,
                };
                let spec = m.fields[i];
                if nv < spec.min || nv > spec.max {
                    return Err(ExtError::FieldBounds);
                }
                st.fields[i] = nv;
            }
            Op::Pay(r, x) | Op::Burn(r, x) => {
                let ri = *r as usize;
                let amt = eval(x, args, &st, now_ts);
                if amt < 0 {
                    return Err(ExtError::NegativeAmount);
                }
                spent[ri] = spent[ri].checked_add(amt).ok_or(ExtError::Overflow)?;
                if spent[ri] > m.pay_cap[ri] {
                    return Err(ExtError::PayCap);
                }
                h.pay(now_ts, &one(*r, amt)).map_err(holding_err)?;
                if matches!(op, Op::Pay(..)) {
                    st.escrow[ri] = st.escrow[ri].checked_add(amt).ok_or(ExtError::Overflow)?;
                } else {
                    burned[ri] += amt;
                }
            }
            Op::Refund(r, x) => {
                let ri = *r as usize;
                let amt = eval(x, args, &st, now_ts);
                if amt < 0 {
                    return Err(ExtError::NegativeAmount);
                }
                if st.escrow[ri] < amt {
                    return Err(ExtError::EscrowInsufficient);
                }
                st.escrow[ri] -= amt;
                h.credit(now_ts, Resource::ALL[ri], amt)
                    .map_err(holding_err)?;
            }
            Op::Emit(c) => events.push(*c),
        }
    }
    // A run with no core effect still settles the Holding to `now_ts`
    // (the same view `stock_at` gives), so the delta below is the effect's.
    h.settle(now_ts).map_err(holding_err)?;
    let after = h.stock_at(now_ts);
    let holding_delta = core::array::from_fn(|r| after[r] - before[r]);
    let escrow_delta = core::array::from_fn(|r| st.escrow[r] - inst.escrow[r]);
    st.seq = inst.seq.checked_add(1).ok_or(ExtError::Overflow)?;
    Ok(Outcome {
        instance: st,
        holding: h,
        holding_delta,
        escrow_delta,
        burned,
        spent,
        events,
    })
}

/// The core-defined exit (contract §3): the whole escrow back to the same
/// user's Holding. Runs no manifest op.
pub fn run_withdraw(now_ts: i64, inst: &Instance, holding: &Holding) -> Result<Outcome, ExtError> {
    let before = holding.stock_at(now_ts);
    let mut st = inst.clone();
    let mut h = holding.clone();
    for (r, e) in inst.escrow.iter().enumerate() {
        if *e > 0 {
            h.credit(now_ts, Resource::ALL[r], *e)
                .map_err(holding_err)?;
        }
        st.escrow[r] = 0;
    }
    h.settle(now_ts).map_err(holding_err)?;
    let after = h.stock_at(now_ts);
    st.seq = inst.seq.checked_add(1).ok_or(ExtError::Overflow)?;
    Ok(Outcome {
        holding_delta: core::array::from_fn(|r| after[r] - before[r]),
        escrow_delta: core::array::from_fn(|r| -inst.escrow[r]),
        burned: [0; RESOURCES],
        spent: [0; RESOURCES],
        events: Vec::new(),
        instance: st,
        holding: h,
    })
}
