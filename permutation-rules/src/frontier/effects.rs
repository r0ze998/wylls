//! ⑪(b) declarative extension effects — the FIRST LOCAL SLICE (feature
//! `declarative-effects`, off by default; plan:
//! `docs/design/extensions/item11b-plan.md`).
//!
//! An extension is DATA, not code: a body of declared per-user fields and
//! entries, each a straight list of ops from a closed vocabulary. The core
//! interprets it; the author's code never runs. This slice carries the two
//! core-resource effects the plan names first:
//!
//! * `Lock(res, x)`    — from the caller's own Holding (`Holding::pay`) into
//!   the caller's escrow under this body (ext-kernel's `Pay`, op 0x04);
//! * `Release(res, x)` — from that escrow back to the same Holding
//!   (`Holding::credit`; ext-kernel's `Refund`, op 0x05);
//!
//! and the state ops they need to be useful (`Require` 0x01, `Set` 0x02,
//! `Add` 0x03). ext-kernel's `Burn` (0x06, owner question D2) and `Emit`
//! (0x07) are NOT in the slice: a body naming them is `NotInSlice`, never
//! run. There is no branch, loop, call out, mint, randomness or read of any
//! account but the caller's instance and Holding, so one run is at most
//! `MAX_OPS` constant-time steps and a pure function of its inputs.
//!
//! The byte form is the body of workstream 11's manifest `WXM1` (everything
//! after the header: fields, `max_instances`, `pay_cap`, entries), op codes
//! unchanged, so a WXM1 manifest restricted to the slice's ops decodes here
//! byte for byte (`workstreams/11-extensions/ext-kernel/tests/kernel_slice.rs`).
//!
//! [`replay`] is the verifier's side: the same function again over an
//! archived run list, PASS / FAIL / UNVERIFIABLE, never PASS on anything it
//! does not know.
//!
//! No program, account layout, instruction tag, record kind, version or
//! hash input of any default build changes: nothing outside this file reads
//! it, and the module exists only with the feature.

use alloc::vec::Vec;

use super::holding::{Holding, HoldingError, Resource, RESOURCES};
use super::travel::BELL_SECS;
use crate::fixed::Milli;
use crate::hash::{sha256, Digest32};

pub const MAX_BYTES: usize = 1_024;
pub const MAX_FIELDS: usize = 8;
pub const MAX_ENTRIES: usize = 4;
pub const MAX_ARGS: usize = 4;
pub const MAX_OPS: usize = 32;
const BODY_DOMAIN: &[u8] = b"WYLLS-EFFECTS-BODY\0";
const STATE_DOMAIN: &[u8] = b"WYLLS-EFFECTS-STATE\0";

pub const OP_REQUIRE: u8 = 0x01;
pub const OP_SET: u8 = 0x02;
pub const OP_ADD: u8 = 0x03;
pub const OP_LOCK: u8 = 0x04;
pub const OP_RELEASE: u8 = 0x05;
/// ext-kernel's Burn and Emit: known to the format, not to this slice.
pub const OPS_NOT_IN_SLICE: [u8; 2] = [0x06, 0x07];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectError {
    // decode / publication
    TooLarge,
    Malformed,
    UnknownOp,
    NotInSlice,
    BadReference,
    BadBounds,
    TooManyOps,
    DuplicateEntry,
    // run
    NoEntry,
    ArgCount,
    ArgBounds,
    StateShape,
    RequireFailed,
    FieldBounds,
    NegativeAmount,
    PayCap,
    Insufficient,
    EscrowInsufficient,
    TimeReversed,
    Overflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Field {
    pub min: i64,
    pub max: i64,
    pub init: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArgSpec {
    pub min: i64,
    pub max: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmp {
    Eq = 0,
    Ne = 1,
    Lt = 2,
    Le = 3,
    Gt = 4,
    Ge = 5,
}

impl Cmp {
    fn from_u8(b: u8) -> Option<Cmp> {
        Some(match b {
            0 => Cmp::Eq,
            1 => Cmp::Ne,
            2 => Cmp::Lt,
            3 => Cmp::Le,
            4 => Cmp::Gt,
            5 => Cmp::Ge,
            _ => return None,
        })
    }
    pub fn holds(self, a: i64, b: i64) -> bool {
        match self {
            Cmp::Eq => a == b,
            Cmp::Ne => a != b,
            Cmp::Lt => a < b,
            Cmp::Le => a <= b,
            Cmp::Gt => a > b,
            Cmp::Ge => a >= b,
        }
    }
}

/// What an op reads: the call, the caller's instance, the time. Nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operand {
    Const(i64),
    Arg(u8),
    Field(u8),
    /// `now_ts.div_euclid(BELL_SECS)`.
    NowBell,
    Escrow(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Require(Cmp, Operand, Operand),
    Set(u8, Operand),
    Add(u8, Operand),
    Lock(u8, Operand),
    Release(u8, Operand),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: u8,
    pub args: Vec<ArgSpec>,
    pub ops: Vec<Op>,
}

/// The data an extension declares (WXM1's body).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Body {
    pub fields: Vec<Field>,
    pub max_instances: u32,
    /// Per call, per resource: the most `Lock` may take (milli).
    pub pay_cap: [Milli; RESOURCES],
    pub entries: Vec<Entry>,
}

pub type BodyId = Digest32;

pub fn id_of(bytes: &[u8]) -> BodyId {
    sha256(&[BODY_DOMAIN, bytes])
}

fn put_operand(o: &Operand, out: &mut Vec<u8>) {
    let (k, v): (u8, i64) = match *o {
        Operand::Const(v) => (0, v),
        Operand::Arg(i) => (1, i as i64),
        Operand::Field(i) => (2, i as i64),
        Operand::NowBell => (3, 0),
        Operand::Escrow(r) => (4, r as i64),
    };
    out.push(k);
    out.extend_from_slice(&v.to_le_bytes());
}

impl Body {
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::new();
        o.push(self.fields.len() as u8);
        for f in &self.fields {
            o.extend_from_slice(&f.min.to_le_bytes());
            o.extend_from_slice(&f.max.to_le_bytes());
            o.extend_from_slice(&f.init.to_le_bytes());
        }
        o.extend_from_slice(&self.max_instances.to_le_bytes());
        for c in &self.pay_cap {
            o.extend_from_slice(&c.to_le_bytes());
        }
        o.push(self.entries.len() as u8);
        for e in &self.entries {
            o.push(e.id);
            o.push(e.args.len() as u8);
            for a in &e.args {
                o.extend_from_slice(&a.min.to_le_bytes());
                o.extend_from_slice(&a.max.to_le_bytes());
            }
            o.push(e.ops.len() as u8);
            for op in &e.ops {
                match op {
                    Op::Require(c, a, b) => {
                        o.push(OP_REQUIRE);
                        o.push(*c as u8);
                        put_operand(a, &mut o);
                        put_operand(b, &mut o);
                    }
                    Op::Set(i, x) | Op::Add(i, x) | Op::Lock(i, x) | Op::Release(i, x) => {
                        o.push(match op {
                            Op::Set(..) => OP_SET,
                            Op::Add(..) => OP_ADD,
                            Op::Lock(..) => OP_LOCK,
                            _ => OP_RELEASE,
                        });
                        o.push(*i);
                        put_operand(x, &mut o);
                    }
                }
            }
        }
        o
    }

    pub fn id(&self) -> BodyId {
        id_of(&self.encode())
    }

    /// Strict: closed vocabulary, canonical bytes only, then [`Body::validate`].
    pub fn decode(b: &[u8]) -> Result<Body, EffectError> {
        if b.len() > MAX_BYTES {
            return Err(EffectError::TooLarge);
        }
        let mut r = Reader { b, at: 0 };
        let nf = r.u8()? as usize;
        if nf > MAX_FIELDS {
            return Err(EffectError::TooLarge);
        }
        let mut fields = Vec::with_capacity(nf);
        for _ in 0..nf {
            fields.push(Field {
                min: r.i64()?,
                max: r.i64()?,
                init: r.i64()?,
            });
        }
        let max_instances = u32::from_le_bytes(r.arr()?);
        let mut pay_cap = [0i64; RESOURCES];
        for c in &mut pay_cap {
            *c = r.i64()?;
        }
        let ne = r.u8()? as usize;
        if ne > MAX_ENTRIES {
            return Err(EffectError::TooLarge);
        }
        let mut entries = Vec::with_capacity(ne);
        for _ in 0..ne {
            let id = r.u8()?;
            let na = r.u8()? as usize;
            if na > MAX_ARGS {
                return Err(EffectError::TooLarge);
            }
            let mut args = Vec::with_capacity(na);
            for _ in 0..na {
                args.push(ArgSpec {
                    min: r.i64()?,
                    max: r.i64()?,
                });
            }
            let no = r.u8()? as usize;
            if no > MAX_OPS {
                return Err(EffectError::TooManyOps);
            }
            let mut ops = Vec::with_capacity(no);
            for _ in 0..no {
                ops.push(r.op()?);
            }
            entries.push(Entry { id, args, ops });
        }
        if r.at != b.len() {
            return Err(EffectError::Malformed);
        }
        let body = Body {
            fields,
            max_instances,
            pay_cap,
            entries,
        };
        if body.encode() != b {
            return Err(EffectError::Malformed);
        }
        body.validate()?;
        Ok(body)
    }

    /// The publication check: every bound and every reference.
    pub fn validate(&self) -> Result<(), EffectError> {
        if self.encode().len() > MAX_BYTES
            || self.fields.len() > MAX_FIELDS
            || self.entries.len() > MAX_ENTRIES
        {
            return Err(EffectError::TooLarge);
        }
        if self.entries.is_empty() || self.max_instances == 0 {
            return Err(EffectError::BadBounds);
        }
        if self
            .fields
            .iter()
            .any(|f| !(f.min <= f.init && f.init <= f.max))
            || self.pay_cap.iter().any(|&c| c < 0)
        {
            return Err(EffectError::BadBounds);
        }
        for (i, e) in self.entries.iter().enumerate() {
            if self.entries[..i].iter().any(|x| x.id == e.id) {
                return Err(EffectError::DuplicateEntry);
            }
            if e.id >= 8 || e.args.iter().any(|a| a.min > a.max) {
                return Err(EffectError::BadBounds);
            }
            if e.args.len() > MAX_ARGS {
                return Err(EffectError::TooLarge);
            }
            if e.ops.is_empty() || e.ops.len() > MAX_OPS {
                return Err(EffectError::TooManyOps);
            }
            for op in &e.ops {
                self.check_op(e, op)?;
            }
        }
        Ok(())
    }

    fn check_operand(&self, e: &Entry, o: &Operand) -> Result<(), EffectError> {
        let ok = match *o {
            Operand::Const(_) | Operand::NowBell => true,
            Operand::Arg(i) => (i as usize) < e.args.len(),
            Operand::Field(i) => (i as usize) < self.fields.len(),
            Operand::Escrow(r) => (r as usize) < RESOURCES,
        };
        ok.then_some(()).ok_or(EffectError::BadReference)
    }

    fn check_op(&self, e: &Entry, op: &Op) -> Result<(), EffectError> {
        match op {
            Op::Require(_, a, b) => {
                self.check_operand(e, a)?;
                self.check_operand(e, b)
            }
            Op::Set(f, x) | Op::Add(f, x) => {
                if (*f as usize) >= self.fields.len() {
                    return Err(EffectError::BadReference);
                }
                self.check_operand(e, x)
            }
            Op::Lock(r, x) | Op::Release(r, x) => {
                if (*r as usize) >= RESOURCES {
                    return Err(EffectError::BadReference);
                }
                // A Lock on a resource without a cap could never succeed.
                if matches!(op, Op::Lock(..)) && self.pay_cap[*r as usize] == 0 {
                    return Err(EffectError::BadBounds);
                }
                self.check_operand(e, x)
            }
        }
    }

    pub fn entry(&self, id: u8) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], EffectError> {
        let end = self.at.checked_add(n).ok_or(EffectError::Malformed)?;
        let s = self.b.get(self.at..end).ok_or(EffectError::Malformed)?;
        self.at = end;
        Ok(s)
    }
    fn arr<const N: usize>(&mut self) -> Result<[u8; N], EffectError> {
        let mut a = [0u8; N];
        a.copy_from_slice(self.take(N)?);
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8, EffectError> {
        Ok(self.take(1)?[0])
    }
    fn i64(&mut self) -> Result<i64, EffectError> {
        Ok(i64::from_le_bytes(self.arr()?))
    }
    fn small(&mut self) -> Result<u8, EffectError> {
        u8::try_from(self.i64()?).map_err(|_| EffectError::Malformed)
    }
    fn operand(&mut self) -> Result<Operand, EffectError> {
        Ok(match self.u8()? {
            0 => Operand::Const(self.i64()?),
            1 => Operand::Arg(self.small()?),
            2 => Operand::Field(self.small()?),
            3 => {
                self.i64()?;
                Operand::NowBell
            }
            4 => Operand::Escrow(self.small()?),
            _ => return Err(EffectError::UnknownOp),
        })
    }
    fn op(&mut self) -> Result<Op, EffectError> {
        let code = self.u8()?;
        Ok(match code {
            OP_REQUIRE => {
                let c = Cmp::from_u8(self.u8()?).ok_or(EffectError::UnknownOp)?;
                Op::Require(c, self.operand()?, self.operand()?)
            }
            OP_SET => Op::Set(self.u8()?, self.operand()?),
            OP_ADD => Op::Add(self.u8()?, self.operand()?),
            OP_LOCK => Op::Lock(self.u8()?, self.operand()?),
            OP_RELEASE => Op::Release(self.u8()?, self.operand()?),
            c if OPS_NOT_IN_SLICE.contains(&c) => return Err(EffectError::NotInSlice),
            _ => return Err(EffectError::UnknownOp),
        })
    }
}

/// One user's state under one body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance {
    pub seq: u64,
    pub fields: Vec<i64>,
    pub escrow: [Milli; RESOURCES],
}

impl Instance {
    pub fn fresh(b: &Body) -> Instance {
        Instance {
            seq: 0,
            fields: b.fields.iter().map(|f| f.init).collect(),
            escrow: [0; RESOURCES],
        }
    }

    pub fn state_hash(&self, id: &BodyId) -> Digest32 {
        let mut b = Vec::with_capacity(9 + 8 * (self.fields.len() + RESOURCES));
        b.extend_from_slice(&self.seq.to_le_bytes());
        b.push(self.fields.len() as u8);
        for f in &self.fields {
            b.extend_from_slice(&f.to_le_bytes());
        }
        for e in &self.escrow {
            b.extend_from_slice(&e.to_le_bytes());
        }
        sha256(&[STATE_DOMAIN, id, &b])
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub instance: Instance,
    pub holding: Holding,
    /// Settled stock after minus settled stock before, at `now_ts`.
    pub holding_delta: [Milli; RESOURCES],
    pub escrow_delta: [Milli; RESOURCES],
}

fn holding_err(e: HoldingError) -> EffectError {
    match e {
        HoldingError::Insufficient => EffectError::Insufficient,
        HoldingError::TimeReversed => EffectError::TimeReversed,
        _ => EffectError::Overflow,
    }
}

fn eval(o: &Operand, args: &[i64], st: &Instance, now_ts: i64) -> i64 {
    // References were checked at publication and the arg count at the call.
    match *o {
        Operand::Const(v) => v,
        Operand::Arg(i) => args.get(i as usize).copied().unwrap_or(0),
        Operand::Field(i) => st.fields.get(i as usize).copied().unwrap_or(0),
        Operand::NowBell => now_ts.div_euclid(BELL_SECS),
        Operand::Escrow(r) => st.escrow.get(r as usize).copied().unwrap_or(0),
    }
}

/// Runs one entry. All or nothing: on a refusal nothing is returned to
/// write (the run works on copies).
pub fn run(
    body: &Body,
    entry: u8,
    args: &[i64],
    now_ts: i64,
    inst: &Instance,
    holding: &Holding,
) -> Result<Outcome, EffectError> {
    let e = body.entry(entry).ok_or(EffectError::NoEntry)?;
    if args.len() != e.args.len() {
        return Err(EffectError::ArgCount);
    }
    if args
        .iter()
        .zip(&e.args)
        .any(|(v, s)| *v < s.min || *v > s.max)
    {
        return Err(EffectError::ArgBounds);
    }
    if inst.fields.len() != body.fields.len() {
        return Err(EffectError::StateShape);
    }
    let before = holding.stock_at(now_ts);
    let mut st = inst.clone();
    let mut h = holding.clone();
    let mut locked = [0i64; RESOURCES];
    for op in &e.ops {
        match op {
            Op::Require(c, a, b) => {
                if !c.holds(eval(a, args, &st, now_ts), eval(b, args, &st, now_ts)) {
                    return Err(EffectError::RequireFailed);
                }
            }
            Op::Set(f, x) | Op::Add(f, x) => {
                let i = *f as usize;
                let v = eval(x, args, &st, now_ts);
                let nv = match op {
                    Op::Set(..) => v,
                    _ => st.fields[i].checked_add(v).ok_or(EffectError::Overflow)?,
                };
                let spec = body.fields[i];
                if nv < spec.min || nv > spec.max {
                    return Err(EffectError::FieldBounds);
                }
                st.fields[i] = nv;
            }
            Op::Lock(r, x) => {
                let ri = *r as usize;
                let amt = eval(x, args, &st, now_ts);
                if amt < 0 {
                    return Err(EffectError::NegativeAmount);
                }
                locked[ri] = locked[ri].checked_add(amt).ok_or(EffectError::Overflow)?;
                if locked[ri] > body.pay_cap[ri] {
                    return Err(EffectError::PayCap);
                }
                let mut cost = [0i64; RESOURCES];
                cost[ri] = amt;
                h.pay(now_ts, &cost).map_err(holding_err)?;
                st.escrow[ri] = st.escrow[ri]
                    .checked_add(amt)
                    .ok_or(EffectError::Overflow)?;
            }
            Op::Release(r, x) => {
                let ri = *r as usize;
                let amt = eval(x, args, &st, now_ts);
                if amt < 0 {
                    return Err(EffectError::NegativeAmount);
                }
                if st.escrow[ri] < amt {
                    return Err(EffectError::EscrowInsufficient);
                }
                st.escrow[ri] -= amt;
                h.credit(now_ts, Resource::ALL[ri], amt)
                    .map_err(holding_err)?;
            }
        }
    }
    h.settle(now_ts).map_err(holding_err)?;
    let after = h.stock_at(now_ts);
    st.seq = inst.seq.checked_add(1).ok_or(EffectError::Overflow)?;
    Ok(Outcome {
        holding_delta: core::array::from_fn(|r| after[r] - before[r]),
        escrow_delta: core::array::from_fn(|r| st.escrow[r] - inst.escrow[r]),
        instance: st,
        holding: h,
    })
}

/// One archived call and what the core said it did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub entry: u8,
    pub args: Vec<i64>,
    pub now_ts: i64,
    pub seq: u64,
    pub holding_delta: [Milli; RESOURCES],
    pub escrow_delta: [Milli; RESOURCES],
    pub post_state: Digest32,
}

impl Step {
    pub fn of(entry: u8, args: &[i64], now_ts: i64, seq: u64, o: &Outcome, id: &BodyId) -> Step {
        Step {
            entry,
            args: args.to_vec(),
            now_ts,
            seq,
            holding_delta: o.holding_delta,
            escrow_delta: o.escrow_delta,
            post_state: o.instance.state_hash(id),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    /// Index of the first step that is wrong (`steps.len()` = the finals).
    Fail(usize, FailCode),
    Unverifiable(Missing),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailCode {
    BodyHashMismatch,
    SeqReplay,
    RulesRefuse,
    StepMismatch,
    FinalStateMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Missing {
    NoBody,
    /// The body uses an op this verifier does not know (or a later slice's):
    /// never PASS, never FAIL.
    UnknownVocabulary,
    NoFinalState,
}

/// The verifier's side: run every archived step again from the archived
/// start and compare. A body whose bytes are absent, or that names an op
/// outside the slice, is UNVERIFIABLE; a different result is FAIL.
pub fn replay(
    body_bytes: Option<&[u8]>,
    expected_id: &BodyId,
    start: (&Instance, &Holding),
    steps: &[Step],
    finals: Option<(&Instance, &Holding)>,
) -> Verdict {
    let Some(bytes) = body_bytes else {
        return Verdict::Unverifiable(Missing::NoBody);
    };
    if id_of(bytes) != *expected_id {
        return Verdict::Fail(0, FailCode::BodyHashMismatch);
    }
    let body = match Body::decode(bytes) {
        Ok(b) => b,
        Err(EffectError::UnknownOp | EffectError::NotInSlice) => {
            return Verdict::Unverifiable(Missing::UnknownVocabulary)
        }
        // The id matches but the bytes are no valid body: the core could
        // never have registered it, so any run under it is false.
        Err(_) => return Verdict::Fail(0, FailCode::RulesRefuse),
    };
    let (mut inst, mut holding) = (start.0.clone(), start.1.clone());
    for (i, s) in steps.iter().enumerate() {
        if s.seq != inst.seq {
            return Verdict::Fail(i, FailCode::SeqReplay);
        }
        let o = match run(&body, s.entry, &s.args, s.now_ts, &inst, &holding) {
            Ok(o) => o,
            Err(_) => return Verdict::Fail(i, FailCode::RulesRefuse),
        };
        if Step::of(s.entry, &s.args, s.now_ts, s.seq, &o, expected_id) != *s {
            return Verdict::Fail(i, FailCode::StepMismatch);
        }
        inst = o.instance;
        holding = o.holding;
    }
    let Some((fi, fh)) = finals else {
        return Verdict::Unverifiable(Missing::NoFinalState);
    };
    if *fi != inst || *fh != holding {
        return Verdict::Fail(steps.len(), FailCode::FinalStateMismatch);
    }
    Verdict::Pass
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const W: u8 = Resource::Wood as u8;
    const UNTIL: u8 = 0;
    const LOCKED: u8 = 1;
    const T0: i64 = 1_800_000_000;

    /// "Timed lock" — an EXAMPLE, not an adopted rule: lock 1..=20 wood for
    /// 1..=144 bells; release only once the bell has come.
    fn timed_lock() -> Body {
        let mut pay_cap = [0; RESOURCES];
        pay_cap[W as usize] = 20_000;
        Body {
            fields: vec![
                Field {
                    min: 0,
                    max: i64::MAX / 2,
                    init: 0,
                },
                Field {
                    min: 0,
                    max: 20_000,
                    init: 0,
                },
            ],
            max_instances: 16,
            pay_cap,
            entries: vec![
                Entry {
                    id: 0,
                    args: vec![
                        ArgSpec {
                            min: 1_000,
                            max: 20_000,
                        },
                        ArgSpec { min: 1, max: 144 },
                    ],
                    ops: vec![
                        Op::Require(Cmp::Eq, Operand::Field(LOCKED), Operand::Const(0)),
                        Op::Lock(W, Operand::Arg(0)),
                        Op::Set(LOCKED, Operand::Arg(0)),
                        Op::Set(UNTIL, Operand::NowBell),
                        Op::Add(UNTIL, Operand::Arg(1)),
                    ],
                },
                Entry {
                    id: 1,
                    args: vec![],
                    ops: vec![
                        Op::Require(Cmp::Gt, Operand::Field(LOCKED), Operand::Const(0)),
                        Op::Require(Cmp::Ge, Operand::NowBell, Operand::Field(UNTIL)),
                        Op::Release(W, Operand::Field(LOCKED)),
                        Op::Set(LOCKED, Operand::Const(0)),
                    ],
                },
            ],
        }
    }

    fn holding_with_wood(milli: Milli) -> Holding {
        let mut h = Holding::found(T0, 0, 1);
        h.credit(T0, Resource::Wood, milli).unwrap();
        h
    }

    fn wood(h: &Holding, t: i64) -> Milli {
        h.stock_at(t)[W as usize]
    }

    /// End to end: bytes → decode → lock → early release refused → release
    /// → the verifier's replay PASSes; Holding + escrow is conserved.
    #[test]
    fn lock_then_release_end_to_end() {
        let body = timed_lock();
        let bytes = body.encode();
        let body = Body::decode(&bytes).unwrap();
        let id = id_of(&bytes);
        let h0 = holding_with_wood(30_000);
        let i0 = Instance::fresh(&body);
        let start_wood = wood(&h0, T0);

        let t1 = T0 + 60;
        let a1 = [10_000, 6];
        let o1 = run(&body, 0, &a1, t1, &i0, &h0).unwrap();
        assert_eq!(o1.holding_delta[W as usize], -10_000);
        assert_eq!(o1.instance.escrow[W as usize], 10_000);
        assert_eq!(
            wood(&o1.holding, t1) + o1.instance.escrow[W as usize],
            start_wood
        );

        // 5 bells later: the rule refuses, nothing to write.
        let early = t1 + 5 * BELL_SECS;
        assert_eq!(
            run(&body, 1, &[], early, &o1.instance, &o1.holding),
            Err(EffectError::RequireFailed)
        );
        // A second lock while one is held: refused before any resource moves.
        assert_eq!(
            run(&body, 0, &a1, early, &o1.instance, &o1.holding),
            Err(EffectError::RequireFailed)
        );

        let t2 = t1 + 6 * BELL_SECS;
        let o2 = run(&body, 1, &[], t2, &o1.instance, &o1.holding).unwrap();
        assert_eq!(o2.holding_delta[W as usize], 10_000);
        assert_eq!(o2.instance.escrow, [0; RESOURCES]);
        assert_eq!(wood(&o2.holding, t2), start_wood);

        let steps = vec![
            Step::of(0, &a1, t1, 0, &o1, &id),
            Step::of(1, &[], t2, 1, &o2, &id),
        ];
        let finals = Some((&o2.instance, &o2.holding));
        assert_eq!(
            replay(Some(&bytes), &id, (&i0, &h0), &steps, finals),
            Verdict::Pass
        );

        // FAIL: a forged delta, a replayed seq, a different final state,
        // other bytes under the id.
        let mut forged = steps.clone();
        forged[1].holding_delta[W as usize] = 20_000;
        assert_eq!(
            replay(Some(&bytes), &id, (&i0, &h0), &forged, finals),
            Verdict::Fail(1, FailCode::StepMismatch)
        );
        let replayed = vec![steps[0].clone(), steps[0].clone()];
        assert_eq!(
            replay(Some(&bytes), &id, (&i0, &h0), &replayed, finals),
            Verdict::Fail(1, FailCode::SeqReplay)
        );
        assert_eq!(
            replay(
                Some(&bytes),
                &id,
                (&i0, &h0),
                &steps,
                Some((&o1.instance, &o2.holding))
            ),
            Verdict::Fail(2, FailCode::FinalStateMismatch)
        );
        let mut other = bytes.clone();
        other[1] ^= 1;
        assert_eq!(
            replay(Some(&other), &id, (&i0, &h0), &steps, finals),
            Verdict::Fail(0, FailCode::BodyHashMismatch)
        );
        // A release with the time requirement skipped is refused by the rules.
        let mut early_steps = steps.clone();
        early_steps[1].now_ts = early;
        assert_eq!(
            replay(Some(&bytes), &id, (&i0, &h0), &early_steps, finals),
            Verdict::Fail(1, FailCode::RulesRefuse)
        );
        // UNVERIFIABLE: no body, no final state.
        assert_eq!(
            replay(None, &id, (&i0, &h0), &steps, finals),
            Verdict::Unverifiable(Missing::NoBody)
        );
        assert_eq!(
            replay(Some(&bytes), &id, (&i0, &h0), &steps, None),
            Verdict::Unverifiable(Missing::NoFinalState)
        );
    }

    #[test]
    fn refusals_are_atomic_and_bounded() {
        let body = timed_lock();
        let i0 = Instance::fresh(&body);
        let poor = holding_with_wood(2_000);
        // Not enough wood: Holding::pay refuses.
        assert_eq!(
            run(&body, 0, &[10_000, 1], T0, &i0, &poor),
            Err(EffectError::Insufficient)
        );
        // Argument out of declared range; unknown entry; wrong arg count.
        assert_eq!(
            run(&body, 0, &[30_000, 1], T0, &i0, &poor),
            Err(EffectError::ArgBounds)
        );
        assert_eq!(
            run(&body, 7, &[], T0, &i0, &poor),
            Err(EffectError::NoEntry)
        );
        assert_eq!(
            run(&body, 1, &[1], T0, &i0, &poor),
            Err(EffectError::ArgCount)
        );
        // Release more than escrowed: no mint.
        let mut b = body.clone();
        b.entries[1].ops = vec![Op::Release(W, Operand::Const(1))];
        assert_eq!(
            run(&b, 1, &[], T0, &i0, &poor),
            Err(EffectError::EscrowInsufficient)
        );
        // Locks beyond the per-call cap (two locks in one entry).
        let mut b = body.clone();
        b.entries[0].ops = vec![Op::Lock(W, Operand::Arg(0)), Op::Lock(W, Operand::Arg(0))];
        let rich = holding_with_wood(100_000);
        assert_eq!(
            run(&b, 0, &[15_000, 1], T0, &i0, &rich),
            Err(EffectError::PayCap)
        );
        // Time going back is the Holding's refusal.
        assert_eq!(
            run(&body, 0, &[1_000, 1], T0 - 10, &i0, &rich),
            Err(EffectError::TimeReversed)
        );
    }

    #[test]
    fn closed_vocabulary_and_publication_checks() {
        let body = timed_lock();
        let bytes = body.encode();
        let id = id_of(&bytes);
        let i0 = Instance::fresh(&body);
        let h0 = holding_with_wood(0);
        // Find the first op byte (entry 0's Require) and turn it into each
        // other code: Burn/Emit are NotInSlice, the rest UnknownOp.
        // fields count + 2 fields, max_instances, pay_cap, entry count,
        // entry 0's id, arg count, 2 args, op count.
        let at = 1 + 2 * 24 + 4 + 8 * RESOURCES + 1 + 1 + 1 + 2 * 16 + 1;
        assert_eq!(bytes[at], OP_REQUIRE);
        assert_eq!(bytes[at - 1], 5, "entry 0 has 5 ops");
        for code in 0u8..=0xFF {
            if (OP_REQUIRE..=OP_RELEASE).contains(&code) {
                continue;
            }
            let mut b = bytes.clone();
            b[at] = code;
            let want = if OPS_NOT_IN_SLICE.contains(&code) {
                EffectError::NotInSlice
            } else {
                EffectError::UnknownOp
            };
            assert_eq!(Body::decode(&b), Err(want), "op {code:#x}");
            // The verifier never PASSes such a body (the id is the forged
            // bytes' own, so the hash matches).
            assert_eq!(
                replay(Some(&b), &id_of(&b), (&i0, &h0), &[], Some((&i0, &h0))),
                Verdict::Unverifiable(Missing::UnknownVocabulary)
            );
        }
        assert_eq!(
            replay(Some(&bytes), &id, (&i0, &h0), &[], Some((&i0, &h0))),
            Verdict::Pass
        );
        // Trailing byte, too large, bad references, uncapped lock.
        let mut t = bytes.clone();
        t.push(0);
        assert_eq!(Body::decode(&t), Err(EffectError::Malformed));
        assert_eq!(
            Body::decode(&[0u8; MAX_BYTES + 1]),
            Err(EffectError::TooLarge)
        );
        let mut b = body.clone();
        b.entries[0].ops.push(Op::Set(9, Operand::Const(0)));
        assert_eq!(b.validate(), Err(EffectError::BadReference));
        let mut b = body.clone();
        b.entries[1]
            .ops
            .push(Op::Require(Cmp::Eq, Operand::Arg(0), Operand::Const(0)));
        assert_eq!(b.validate(), Err(EffectError::BadReference));
        let mut b = body.clone();
        b.pay_cap = [0; RESOURCES];
        assert_eq!(b.validate(), Err(EffectError::BadBounds));
        let mut b = body;
        b.entries[0].ops = vec![Op::Set(0, Operand::Const(0)); MAX_OPS + 1];
        assert_eq!(b.validate(), Err(EffectError::TooManyOps));
    }

    /// Exhaustive small check: every sequence of 4 calls from a menu of
    /// lock / release at several times keeps Holding + escrow constant, and
    /// every successful history replays to PASS.
    #[test]
    fn conservation_over_all_short_histories() {
        let body = timed_lock();
        let bytes = body.encode();
        let id = id_of(&bytes);
        let menu: [(u8, &[i64]); 4] = [(0, &[5_000, 1]), (0, &[20_000, 3]), (1, &[]), (1, &[])];
        let h0 = holding_with_wood(25_000);
        let i0 = Instance::fresh(&body);
        let total = wood(&h0, T0);
        let mut histories = 0;
        for n in 0..4u32.pow(4) {
            let (mut inst, mut h) = (i0.clone(), h0.clone());
            let mut steps = Vec::new();
            for k in 0..4 {
                let (entry, args) = menu[((n >> (2 * k)) & 3) as usize];
                let t = T0 + (k as i64 + 1) * 2 * BELL_SECS;
                if let Ok(o) = run(&body, entry, args, t, &inst, &h) {
                    steps.push(Step::of(entry, args, t, inst.seq, &o, &id));
                    inst = o.instance;
                    h = o.holding;
                }
                assert_eq!(wood(&h, t) + inst.escrow[W as usize], total);
            }
            assert_eq!(
                replay(Some(&bytes), &id, (&i0, &h0), &steps, Some((&inst, &h))),
                Verdict::Pass
            );
            histories += 1;
        }
        assert_eq!(histories, 256);
    }
}
