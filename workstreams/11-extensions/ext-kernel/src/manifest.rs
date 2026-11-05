//! The manifest: what an author publishes (contract §1). One canonical byte
//! form; its hash is the extension's only identity.
//!
//! The vocabulary of ops is closed (effect set 1, contract §2): no branch,
//! no loop, no call out. A manifest that names anything else does not decode.

use alloc::string::String;
use alloc::vec::Vec;

use permutation_rules::frontier::holding::RESOURCES;
use permutation_rules::hash::{sha256, Digest32};

use crate::error::ExtError;

pub const MAGIC: [u8; 4] = *b"WXM1";
pub const SCHEMA: u8 = 1;
/// The effect vocabulary this kernel interprets.
pub const EFFECT_SET: u8 = 1;
pub const MAX_BYTES: usize = 1_024;
pub const MAX_FIELDS: usize = 8;
pub const MAX_ENTRIES: usize = 4;
pub const MAX_ARGS: usize = 4;
pub const MAX_OPS: usize = 32;
pub const MAX_NAME: usize = 32;
const ID_DOMAIN: &[u8] = b"WYLLS-EXT-MANIFEST\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CoreVersion {
    pub program_version: u16,
    pub ruleset_hash: Digest32,
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
    pub fn symbol(self) -> &'static str {
        ["==", "!=", "<", "<=", ">", ">="][self as usize]
    }
}

/// A value an op reads. Nothing outside the call, the instance and the
/// transaction time is readable: the result is a function of those alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operand {
    Const(i64),
    Arg(u8),
    Field(u8),
    /// `now_ts / BELL_SECS`, from the time the core passes in.
    NowBell,
    /// This user's escrow of one resource.
    Escrow(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Require(Cmp, Operand, Operand),
    Set(u8, Operand),
    Add(u8, Operand),
    /// From the caller's own Holding into the caller's escrow.
    Pay(u8, Operand),
    /// From the caller's escrow back to the caller's own Holding.
    Refund(u8, Operand),
    /// From the caller's own Holding, gone.
    Burn(u8, Operand),
    Emit(u8),
}

impl Op {
    pub const REQUIRE: u8 = 0x01;
    pub const SET: u8 = 0x02;
    pub const ADD: u8 = 0x03;
    pub const PAY: u8 = 0x04;
    pub const REFUND: u8 = 0x05;
    pub const BURN: u8 = 0x06;
    pub const EMIT: u8 = 0x07;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: u8,
    pub args: Vec<ArgSpec>,
    pub ops: Vec<Op>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub schema: u8,
    pub effect_set: u8,
    pub core: CoreVersion,
    pub author: [u8; 32],
    pub name: String,
    pub fields: Vec<Field>,
    pub max_instances: u32,
    pub pay_cap: [i64; RESOURCES],
    pub entries: Vec<Entry>,
}

pub type ManifestId = Digest32;

/// The id of a manifest's canonical bytes.
pub fn id_of(bytes: &[u8]) -> ManifestId {
    sha256(&[ID_DOMAIN, bytes])
}

// ---- encoding -------------------------------------------------------------

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

fn put_op(op: &Op, out: &mut Vec<u8>) {
    match op {
        Op::Require(c, a, b) => {
            out.push(Op::REQUIRE);
            out.push(*c as u8);
            put_operand(a, out);
            put_operand(b, out);
        }
        Op::Set(f, x) | Op::Add(f, x) | Op::Pay(f, x) | Op::Refund(f, x) | Op::Burn(f, x) => {
            out.push(match op {
                Op::Set(..) => Op::SET,
                Op::Add(..) => Op::ADD,
                Op::Pay(..) => Op::PAY,
                Op::Refund(..) => Op::REFUND,
                _ => Op::BURN,
            });
            out.push(*f);
            put_operand(x, out);
        }
        Op::Emit(c) => {
            out.push(Op::EMIT);
            out.push(*c);
        }
    }
}

impl Manifest {
    pub fn encode(&self) -> Vec<u8> {
        let mut o = Vec::new();
        o.extend_from_slice(&MAGIC);
        o.push(self.schema);
        o.push(self.effect_set);
        o.extend_from_slice(&self.core.program_version.to_le_bytes());
        o.extend_from_slice(&self.core.ruleset_hash);
        o.extend_from_slice(&self.author);
        o.push(self.name.len() as u8);
        o.extend_from_slice(self.name.as_bytes());
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
                put_op(op, &mut o);
            }
        }
        o
    }

    pub fn id(&self) -> ManifestId {
        id_of(&self.encode())
    }

    /// Strict decoding: the header first (an unknown schema or effect set is
    /// named as such, before any op is read), then every op of the closed
    /// vocabulary; trailing or non-canonical bytes are refused.
    pub fn decode(b: &[u8]) -> Result<Manifest, ExtError> {
        if b.len() > MAX_BYTES {
            return Err(ExtError::TooLarge);
        }
        let mut r = Reader { b, at: 0 };
        if r.take(4)? != MAGIC {
            return Err(ExtError::Malformed);
        }
        let schema = r.u8()?;
        if schema != SCHEMA {
            return Err(ExtError::UnknownSchema);
        }
        let effect_set = r.u8()?;
        if effect_set != EFFECT_SET {
            return Err(ExtError::UnknownEffectSet);
        }
        let program_version = u16::from_le_bytes(r.arr()?);
        let ruleset_hash = r.arr()?;
        let author = r.arr()?;
        let n = r.u8()? as usize;
        let name = String::from_utf8(r.take(n)?.to_vec()).map_err(|_| ExtError::Malformed)?;
        let nf = r.u8()? as usize;
        if nf > MAX_FIELDS {
            return Err(ExtError::TooLarge);
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
            return Err(ExtError::TooLarge);
        }
        let mut entries = Vec::with_capacity(ne);
        for _ in 0..ne {
            let id = r.u8()?;
            let na = r.u8()? as usize;
            if na > MAX_ARGS {
                return Err(ExtError::TooLarge);
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
                return Err(ExtError::TooManyOps);
            }
            let mut ops = Vec::with_capacity(no);
            for _ in 0..no {
                ops.push(r.op()?);
            }
            entries.push(Entry { id, args, ops });
        }
        if r.at != b.len() {
            return Err(ExtError::Malformed);
        }
        let m = Manifest {
            schema,
            effect_set,
            core: CoreVersion {
                program_version,
                ruleset_hash,
            },
            author,
            name,
            fields,
            max_instances,
            pay_cap,
            entries,
        };
        // One byte form per manifest: an operand carrying bits its kind does
        // not use (e.g. a field index ≥ 256) would give two ids one meaning.
        if m.encode() != b {
            return Err(ExtError::Malformed);
        }
        Ok(m)
    }

    /// The publication check (contract §1): every bound, every reference.
    pub fn validate(&self) -> Result<(), ExtError> {
        if self.schema != SCHEMA {
            return Err(ExtError::UnknownSchema);
        }
        if self.effect_set != EFFECT_SET {
            return Err(ExtError::UnknownEffectSet);
        }
        if self.encode().len() > MAX_BYTES
            || self.name.len() > MAX_NAME
            || self.fields.len() > MAX_FIELDS
            || self.entries.len() > MAX_ENTRIES
        {
            return Err(ExtError::TooLarge);
        }
        if self.entries.is_empty() || self.max_instances == 0 {
            return Err(ExtError::BadBounds);
        }
        for f in &self.fields {
            if !(f.min <= f.init && f.init <= f.max) {
                return Err(ExtError::BadBounds);
            }
        }
        if self.pay_cap.iter().any(|&c| c < 0) {
            return Err(ExtError::BadBounds);
        }
        for (i, e) in self.entries.iter().enumerate() {
            if self.entries[..i].iter().any(|x| x.id == e.id) {
                return Err(ExtError::DuplicateEntry);
            }
            // Ids 0–7 (a grant's entry mask); 0xFF is the core's exit.
            if e.id >= 8 {
                return Err(ExtError::BadBounds);
            }
            if e.args.len() > MAX_ARGS {
                return Err(ExtError::TooLarge);
            }
            if e.ops.is_empty() || e.ops.len() > MAX_OPS {
                return Err(ExtError::TooManyOps);
            }
            if e.args.iter().any(|a| a.min > a.max) {
                return Err(ExtError::BadBounds);
            }
            for op in &e.ops {
                self.check_op(e, op)?;
            }
        }
        Ok(())
    }

    fn check_operand(&self, e: &Entry, o: &Operand) -> Result<(), ExtError> {
        let ok = match *o {
            Operand::Const(_) | Operand::NowBell => true,
            Operand::Arg(i) => (i as usize) < e.args.len(),
            Operand::Field(i) => (i as usize) < self.fields.len(),
            Operand::Escrow(r) => (r as usize) < RESOURCES,
        };
        if ok {
            Ok(())
        } else {
            Err(ExtError::BadReference)
        }
    }

    fn check_op(&self, e: &Entry, op: &Op) -> Result<(), ExtError> {
        match op {
            Op::Require(_, a, b) => {
                self.check_operand(e, a)?;
                self.check_operand(e, b)
            }
            Op::Set(f, x) | Op::Add(f, x) => {
                if (*f as usize) >= self.fields.len() {
                    return Err(ExtError::BadReference);
                }
                self.check_operand(e, x)
            }
            Op::Pay(r, x) | Op::Burn(r, x) => {
                if (*r as usize) >= RESOURCES {
                    return Err(ExtError::BadReference);
                }
                // Paying a resource the manifest gave no cap could never
                // succeed: refused at publication, not at the first call.
                if self.pay_cap[*r as usize] == 0 {
                    return Err(ExtError::BadBounds);
                }
                self.check_operand(e, x)
            }
            Op::Refund(r, x) => {
                if (*r as usize) >= RESOURCES {
                    return Err(ExtError::BadReference);
                }
                self.check_operand(e, x)
            }
            Op::Emit(_) => Ok(()),
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
    fn take(&mut self, n: usize) -> Result<&[u8], ExtError> {
        let end = self.at.checked_add(n).ok_or(ExtError::Malformed)?;
        let s = self.b.get(self.at..end).ok_or(ExtError::Malformed)?;
        self.at = end;
        Ok(s)
    }
    fn arr<const N: usize>(&mut self) -> Result<[u8; N], ExtError> {
        let mut a = [0u8; N];
        a.copy_from_slice(self.take(N)?);
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8, ExtError> {
        Ok(self.take(1)?[0])
    }
    fn i64(&mut self) -> Result<i64, ExtError> {
        Ok(i64::from_le_bytes(self.arr()?))
    }
    fn small(&mut self) -> Result<u8, ExtError> {
        let v = self.i64()?;
        u8::try_from(v).map_err(|_| ExtError::Malformed)
    }
    fn operand(&mut self) -> Result<Operand, ExtError> {
        Ok(match self.u8()? {
            0 => Operand::Const(self.i64()?),
            1 => Operand::Arg(self.small()?),
            2 => Operand::Field(self.small()?),
            3 => {
                self.i64()?;
                Operand::NowBell
            }
            4 => Operand::Escrow(self.small()?),
            _ => return Err(ExtError::UnknownOp),
        })
    }
    fn op(&mut self) -> Result<Op, ExtError> {
        let code = self.u8()?;
        Ok(match code {
            Op::REQUIRE => {
                let c = Cmp::from_u8(self.u8()?).ok_or(ExtError::UnknownOp)?;
                Op::Require(c, self.operand()?, self.operand()?)
            }
            Op::SET => Op::Set(self.u8()?, self.operand()?),
            Op::ADD => Op::Add(self.u8()?, self.operand()?),
            Op::PAY => Op::Pay(self.u8()?, self.operand()?),
            Op::REFUND => Op::Refund(self.u8()?, self.operand()?),
            Op::BURN => Op::Burn(self.u8()?, self.operand()?),
            Op::EMIT => Op::Emit(self.u8()?),
            _ => return Err(ExtError::UnknownOp),
        })
    }
}
