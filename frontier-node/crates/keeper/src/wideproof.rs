//! **Read-only, opt-in** (feature `wide-world-experimental`): the Depart
//! commitment and the 264-byte wide seal of a *committed* WideDepart,
//! taken from a feed record's transaction **wire** and bound to the
//! `Departed` record the same instruction logged.
//!
//! The wide `Departed` record carries only the seal **root**
//! (`sha256(commit ‖ sha256(seal))`); the commitment and the seal exist in
//! the Depart instruction's data alone. A future keeper settlement needs
//! both, so this module recovers them — and nothing else — from the one
//! source that has them, under rules that make a wrong binding impossible
//! rather than unlikely:
//!
//! * **Bounds first, wire second.** Before the decoder allocates: the wire
//!   is at most the transaction packet (`MAX_WIRE_BYTES`), its signature
//!   count byte is one to 127, and its message is legacy (a versioned
//!   message's first byte has the top bit set and is refused). The log
//!   lines are bounded in count and length before any reader walks them.
//!   `fclient::tx::from_wire` is then a plain bincode decode; after it the
//!   module checks the header arithmetic, that no account key repeats and
//!   at most 256 exist, every instruction's program and account indices,
//!   the signature count, and that re-encoding the decoded transaction
//!   reproduces the supplied bytes exactly (no trailing bytes, no
//!   non-canonical short-vec). The first signature must be the feed
//!   record's. **No signature is verified and no key exists here**: the
//!   identity check only prevents a wire that belongs to another record
//!   from being bound to this one.
//! * **Every record of the program first.** `fclient::typed_log::
//!   decode_transaction` must accept the whole transaction (committed, every
//!   `PS2`/`PSW1` line of the program in every frame well formed) before the
//!   frame-specific binding runs; a malformed record in another frame of
//!   the program refuses this Depart too.
//! * **One frame per instruction.** The runtime logs one depth-1 frame per
//!   top-level instruction of the program and none for ComputeBudget. The
//!   module walks the frames itself (the typed reader flattens records
//!   across frames and cannot say which instruction logged which record)
//!   and requires the sequence of depth-1 frames of the program to match
//!   the sequence of the program's top-level instructions in the wire,
//!   one to one, in order. Any invocation of the program at depth > 1 (a
//!   CPI into it) makes the whole transaction **unavailable**: a nested
//!   frame's records cannot be bound to a top-level instruction without
//!   knowing the caller's semantics.
//! * **Committed only.** A failed transaction (`err` set) is unavailable;
//!   a depth-1 frame that failed is unavailable; a `Log truncated` marker
//!   is unavailable. Nothing rolled back is ever a proof.
//! * **Exact match.** Exactly one `Departed` body must lie inside the
//!   Depart instruction's own frame. Its host reference, standing
//!   province, transit slot, arrival bell, tip and seal root must equal
//!   the instruction's decoded fields and the canonical accounts the
//!   instruction names at the positions the dispatcher reads
//!   (`wide_ix::DEPART`), and the record's header bell must equal the
//!   payload's departure bell. The host's and the standing province's
//!   rings must be wide (`FIRST_WIDE_RING` or beyond) explicitly, and the
//!   seal's first byte must carry the handler's flag syntax (bit 7 set,
//!   bit 6 clear). Account flags follow the prologue's rule under both
//!   authorities: signers signed (the actor too, under an act), writable
//!   positions writable, read-only program-account positions not writable
//!   (a wallet or `Any` position may alias a writable one), and the
//!   departing slot's transit position writable. A WideResidentAct wrapper
//!   is unwrapped only when its inner command is a Depart and the account
//!   list is the Depart list followed by exactly four read-only, unsigned
//!   proof accounts (the dispatcher's shape; `resident_act` is a direct
//!   inner handler, not a CPI).
//! * **Nothing inferred.** The departing mass, the fee, the bond and the
//!   current owner are **not** read from the wire: the record states the
//!   first three and the chain states the fourth. The seal root is
//!   recomputed from the wire's commitment and seal with the ABI's own
//!   functions and compared with the record; a mismatch is a mismatch, not
//!   a cryptographic claim about the seal's contents.
//!
//! The result labels its provenance: the feed sequence, slot and signature
//! bytes it came from, and the fact that the wire's signatures were **not**
//! verified. It is an input a planner may read; it authorizes nothing.

use base64::Engine as _;
use fclient::ports::TxRecord;
use fclient::tx;
use fclient::typed_log::{decode_transaction, ProgramRecord, TransactionRecords};
use frontier_abi::addr::AddrCtx;
use frontier_abi::prologue::{Acc, Wr};
use frontier_abi::world_index::event::{WideKind, WideRecord, MAX_BODY, WIDE_LOG_PREFIX};
use frontier_abi::world_index::wide_ix::{self as wix, WideCommand};
use frontier_abi::world_index::{
    holding as wh, land as wl, march as wm, roster as wro, seal as wseal, ProvinceKey, WideHostRef,
    WorldId, FIRST_WIDE_RING, HOST_REF_LEN, PROVINCE_KEY_LEN, WIDE_SEAL_LEN,
};
use solana_address::Address;

// ------------------------------------------------------------ bounds

/// The largest wire this slice decodes: the runtime's transaction packet
/// (1,232 bytes). A larger byte string is not a transaction the chain
/// accepted.
pub const MAX_WIRE_BYTES: usize = 1_232;
/// The most log lines examined before refusing (the runtime's default log
/// budget is 10 KiB; a record far past that is not a committed program log
/// this slice can bind).
pub const MAX_LOG_LINES: usize = 1_024;
/// The longest log line examined.
pub const MAX_LOG_LINE_BYTES: usize = 4_096;
/// The most `Program data:` lines attributed to one program frame.
pub const MAX_DATA_LINES_PER_FRAME: usize = 64;
/// The longest base64 body of a data line: a `PSW1` body is at most
/// `event::MAX_BODY` bytes.
pub const MAX_BODY_BASE64: usize = MAX_BODY.div_ceil(3) * 4;
/// The deepest invocation the runtime allows (top level + 4 CPI levels).
pub const MAX_INVOKE_DEPTH: usize = 5;
/// A legacy message indexes accounts with one byte.
pub const MAX_ACCOUNT_KEYS: usize = 256;
/// A legacy message has at most 127 signatures (a one-byte short-vec
/// length without the continuation bit).
pub const MAX_SIGNATURES: usize = 127;

/// The program and Season a proof is extracted under (the caller's
/// assertion, as in `wideindex::Scope`). The world is derived from them as
/// the program derives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofScope {
    pub program: Address,
    pub season: Address,
}

impl ProofScope {
    fn ctx(&self) -> AddrCtx {
        AddrCtx {
            season: self.season.to_bytes(),
            program: self.program.to_bytes(),
        }
    }
}

/// Why no proof was extracted. Every variant means "unavailable": the
/// caller has no commitment and no seal, and must not fabricate one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// The feed record is a failed transaction: everything rolled back.
    RolledBack,
    /// The record carries no wire bytes (a public RPC feed may omit them).
    NoWire,
    /// The wire did not decode as a legacy transaction.
    Wire(String),
    /// The wire decoded but is not a canonical legacy transaction (header
    /// arithmetic, indices, trailing bytes, signature count).
    Malformed(&'static str),
    /// The wire's first signature is not the feed record's.
    SignatureMismatch,
    /// The log structure is not a complete, well-nested frame sequence.
    Frame(&'static str),
    /// The logs were truncated by the runtime.
    Truncated,
    /// The program was invoked below depth 1 (a CPI into it): the records
    /// cannot be bound to a top-level instruction.
    NestedInvocation,
    /// The program's depth-1 frames and its top-level instructions differ
    /// in count: no one-to-one binding exists.
    FrameCount { frames: usize, instructions: usize },
    /// The transaction holds no Depart (plain or act-wrapped) of the program.
    NoDepart,
    /// The transaction holds more than one Depart of the program; this
    /// first slice binds one departure per transaction.
    SeveralDeparts,
    /// The typed reader (`fclient::typed_log::decode_transaction`) refused
    /// the transaction's records as a whole: a malformed `PS2` or `PSW1`
    /// line in **any** frame of the program, an unknown data tag, or a log
    /// structure it does not accept.
    Records(String),
    /// A key, record or reference lies inside the legacy disk (ring below
    /// `FIRST_WIDE_RING`): not a wide identity, whatever address it hashes to.
    NotWide(&'static str),
    /// A `Program data:` line in the Depart's frame is not a well-formed
    /// `PSW1` body or `PS2` record line.
    Data(&'static str),
    /// The Depart's frame does not hold exactly one `Departed` body.
    DepartedCount(usize),
    /// The instruction or its wrapper does not decode as the dispatcher
    /// decodes it.
    Instruction(&'static str),
    /// The instruction's account list is not the dispatcher's shape.
    Accounts(&'static str),
    /// A field of the record and the instruction disagree.
    Mismatch(&'static str),
    /// A key of the record or the instruction is not of the scope's world.
    World,
}

/// The commitment and seal of one committed WideDepart, bound to its
/// `Departed` record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepartProof {
    pub host: WideHostRef,
    /// Where the host stood (the record's key and the standing account).
    pub standing: ProvinceKey,
    pub transit_slot: u8,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub tip: u64,
    pub commit: [u8; 32],
    pub seal: [u8; WIDE_SEAL_LEN],
    /// `sha256(commit ‖ sha256(seal))`, equal to the record's.
    pub seal_root: [u8; 32],
    /// The record's escrow facts, **from the record** (never the wire).
    pub dep_mass_milli: u32,
    pub march_stamina: u16,
    pub fee: u64,
    pub bond: u64,
    /// The canonical account addresses the instruction named.
    pub holding: Address,
    pub transit: Address,
    pub origin_province: Address,
    pub roster: Address,
    /// Whether the Depart was carried by a WideResidentAct.
    pub act_wrapped: bool,
    pub provenance: Provenance,
}

/// Where a proof came from and what was not checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provenance {
    pub seq: u64,
    pub slot: u64,
    pub signature: [u8; 64],
    /// The index of the Depart among the transaction's instructions.
    pub instruction_index: usize,
    /// Always `false`: the wire's signatures were not verified here; the
    /// feed source that returned the record is the only authority for its
    /// commitment, and that source is the caller's to trust or not.
    pub signatures_verified: bool,
    /// [`METHOD_FEED`] for a proof this module extracted; a store that
    /// accepts caller-supplied proofs replaces whatever the caller set with
    /// [`METHOD_SUPPLIED`] and clears `signatures_verified`.
    pub method: &'static str,
}

// ------------------------------------------------------------ wire

/// The decoded wire after the canonical-form checks.
struct Wire {
    tx: fclient::Transaction,
}

fn decode_wire(rec: &TxRecord) -> Result<Wire, Unavailable> {
    if rec.tx.is_empty() {
        return Err(Unavailable::NoWire);
    }
    // Bounds and form before any allocation by the decoder: the packet
    // size; a one-byte signature count (no continuation bit); a legacy
    // message (a versioned message's first byte has its top bit set).
    if rec.tx.len() > MAX_WIRE_BYTES {
        return Err(Unavailable::Malformed(
            "wire exceeds the transaction packet size",
        ));
    }
    let n_sigs = rec.tx[0] as usize;
    if n_sigs == 0 || n_sigs > MAX_SIGNATURES {
        return Err(Unavailable::Malformed("signature count byte"));
    }
    let msg_at = 1 + 64 * n_sigs;
    match rec.tx.get(msg_at) {
        None => return Err(Unavailable::Malformed("wire shorter than its signatures")),
        Some(b) if b & 0x80 != 0 => {
            return Err(Unavailable::Malformed("versioned message is not supported"))
        }
        Some(_) => {}
    }
    let tx = tx::from_wire(&rec.tx).map_err(Unavailable::Wire)?;
    // Canonical full consumption: the legacy encoder must reproduce the
    // bytes exactly (bincode's legacy decoder tolerates trailing bytes and
    // a versioned message would not round-trip through the legacy form).
    if tx::wire(&tx) != rec.tx {
        return Err(Unavailable::Malformed(
            "wire is not the canonical legacy encoding",
        ));
    }
    let m = &tx.message;
    let h = &m.header;
    let sig = h.num_required_signatures as usize;
    let ro_sig = h.num_readonly_signed_accounts as usize;
    let ro_unsig = h.num_readonly_unsigned_accounts as usize;
    let keys = m.account_keys.len();
    if sig == 0 {
        return Err(Unavailable::Malformed("no required signature"));
    }
    if tx.signatures.len() != sig {
        return Err(Unavailable::Malformed(
            "signature count differs from the header",
        ));
    }
    if ro_sig > sig || sig > keys || ro_unsig > keys - sig {
        return Err(Unavailable::Malformed(
            "header counts exceed the account keys",
        ));
    }
    if keys > MAX_ACCOUNT_KEYS {
        return Err(Unavailable::Malformed(
            "more account keys than a byte indexes",
        ));
    }
    for (i, k) in m.account_keys.iter().enumerate() {
        if m.account_keys[..i].contains(k) {
            return Err(Unavailable::Malformed("duplicate account key"));
        }
    }
    // The fee payer must be a writable signer.
    if !tx::is_writable_index(m, 0) {
        return Err(Unavailable::Malformed("fee payer is not writable"));
    }
    for ci in &m.instructions {
        let p = ci.program_id_index as usize;
        if p >= keys {
            return Err(Unavailable::Malformed("program index out of range"));
        }
        if p < sig {
            return Err(Unavailable::Malformed("a signer named as a program"));
        }
        if ci.accounts.iter().any(|&i| i as usize >= keys) {
            return Err(Unavailable::Malformed("account index out of range"));
        }
    }
    if tx.signatures[0].as_ref() != rec.signature.as_ref() {
        return Err(Unavailable::SignatureMismatch);
    }
    Ok(Wire { tx })
}

// ------------------------------------------------------------ frames

/// One depth-1 frame of the program: the raw `Program data:` payloads it
/// logged while it was the innermost frame, after any failed CPI subtree
/// below it was discarded.
struct Frame {
    data: Vec<String>,
}

/// Walks the log lines as `fclient::typed_log::decode_transaction` does,
/// keeping the depth-1 frames of `program` apart and refusing any
/// invocation of `program` below depth 1.
/// The log bounds, checked before any reader allocates over the lines.
fn log_bounds(logs: &[String]) -> Result<(), Unavailable> {
    if logs.len() > MAX_LOG_LINES {
        return Err(Unavailable::Frame("too many log lines"));
    }
    if logs.iter().any(|l| l.len() > MAX_LOG_LINE_BYTES) {
        return Err(Unavailable::Frame("log line too long"));
    }
    Ok(())
}

fn frames_of(logs: &[String], program: &Address) -> Result<Vec<Frame>, Unavailable> {
    log_bounds(logs)?;
    let id = program.to_string();
    // (program id, depth-1 frame index this line belongs to or None,
    //  data length at entry for rollback truncation)
    let mut stack: Vec<(String, Option<usize>, usize)> = Vec::new();
    let mut frames: Vec<Frame> = Vec::new();
    for line in logs {
        if line.contains("Log truncated") {
            return Err(Unavailable::Truncated);
        }
        if let Some(rest) = line.strip_prefix("Program data:") {
            let raw = rest.strip_prefix(' ').unwrap_or("");
            let Some((who, owner, _)) = stack.last() else {
                return Err(Unavailable::Frame("data outside any frame"));
            };
            if *who == id {
                if let Some(f) = owner {
                    if frames[*f].data.len() >= MAX_DATA_LINES_PER_FRAME {
                        return Err(Unavailable::Frame("too many data lines in one frame"));
                    }
                    frames[*f].data.push(raw.to_owned());
                }
            }
            continue;
        }
        let Some(rest) = line.strip_prefix("Program ") else {
            continue;
        };
        let Some((who, tail)) = rest.split_once(' ') else {
            continue;
        };
        if let Some(depth) = tail.strip_prefix("invoke [") {
            let depth = depth
                .strip_suffix(']')
                .and_then(|s| s.parse::<usize>().ok());
            if depth != Some(stack.len() + 1) || who.parse::<Address>().is_err() {
                return Err(Unavailable::Frame("invoke depth or program id"));
            }
            if stack.len() + 1 > MAX_INVOKE_DEPTH {
                return Err(Unavailable::Frame(
                    "invocation deeper than the runtime allows",
                ));
            }
            let owner = if who == id {
                if stack.is_empty() {
                    frames.push(Frame { data: Vec::new() });
                    Some(frames.len() - 1)
                } else {
                    return Err(Unavailable::NestedInvocation);
                }
            } else {
                // A foreign frame inherits nothing: its data lines are not
                // the program's and are never attributed.
                None
            };
            let at = owner.map_or(0, |f| frames[f].data.len());
            stack.push((who.to_owned(), owner, at));
        } else if tail == "success" || tail.starts_with("failed:") {
            let Some((active, owner, at)) = stack.pop() else {
                return Err(Unavailable::Frame("exit without an open frame"));
            };
            if active != who {
                return Err(Unavailable::Frame("exit of a frame that is not open"));
            }
            if tail.starts_with("failed:") {
                if stack.is_empty() {
                    // A failed top-level frame fails the transaction; a
                    // feed record with `err: None` and such a line is
                    // inconsistent.
                    return Err(Unavailable::Frame("a failed top-level frame"));
                }
                // A failed CPI subtree: the enclosing program frame (if the
                // program's) loses what it logged since the invoke.
                if let Some(f) = owner {
                    frames[f].data.truncate(at);
                }
                // Anything the program's own enclosing frame logged since
                // this failed child is also discarded by the runtime's
                // rollback of the child only; the parent's own lines stay.
            }
        } else if tail.starts_with("invoke")
            || tail.starts_with("success")
            || tail.starts_with("failed")
        {
            return Err(Unavailable::Frame("malformed invoke/exit line"));
        }
    }
    if !stack.is_empty() {
        return Err(Unavailable::Frame("unclosed frame"));
    }
    Ok(frames)
}

/// The `PSW1` bodies among a frame's data lines (a `PS2` line is allowed
/// and skipped; anything else is a refusal).
fn psw1_bodies(data: &[String]) -> Result<Vec<Vec<u8>>, Unavailable> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut out = Vec::new();
    for d in data {
        let parts: Vec<_> = d.split_whitespace().collect();
        if parts.len() != 2 {
            return Err(Unavailable::Data("data line shape"));
        }
        if parts[0].len() > 8 || parts[1].len() > MAX_BODY_BASE64 {
            return Err(Unavailable::Data("data line too long for a PSW1 body"));
        }
        let tag = b64
            .decode(parts[0])
            .map_err(|_| Unavailable::Data("base64 tag"))?;
        let body = b64
            .decode(parts[1])
            .map_err(|_| Unavailable::Data("base64 body"))?;
        if tag.as_slice() == &WIDE_LOG_PREFIX[..] {
            out.push(body);
        } else if tag.as_slice() == b"PS2" {
            continue;
        } else {
            return Err(Unavailable::Data("unknown data tag"));
        }
    }
    Ok(out)
}

// ------------------------------------------------------------ the binding

/// A Depart found in the wire: its instruction index, its decoded data,
/// its account keys in table order, and whether an act wrapped it.
struct FoundDepart {
    ix_index: usize,
    /// Position among the program's top-level instructions (= frame index).
    frame_index: usize,
    depart: wix::Depart,
    accounts: Vec<(Address, bool, bool)>, // (key, signer, writable)
    act_wrapped: bool,
}

fn find_depart(w: &Wire, program: &Address) -> Result<(FoundDepart, usize), Unavailable> {
    let m = &w.tx.message;
    let sig = m.header.num_required_signatures as usize;
    let mut program_ixs = 0usize;
    let mut found: Option<FoundDepart> = None;
    for (i, ci) in m.instructions.iter().enumerate() {
        if m.account_keys[ci.program_id_index as usize] != *program {
            continue;
        }
        let frame_index = program_ixs;
        program_ixs += 1;
        let Some(tag) = ci.data.first() else {
            continue;
        };
        // Only the two tags that can carry a Depart are decoded; every
        // other instruction of the program (legacy tags, other draft tags)
        // is not ours and is left alone. Data under one of the two tags
        // that the dispatcher's decoder refuses cannot belong to a
        // committed transaction: the record is inconsistent → unavailable.
        let (depart, act_wrapped) = match *tag {
            wix::TAG_DEPART => match WideCommand::decode(&ci.data) {
                Ok(WideCommand::Depart(d)) => (d, false),
                // A 0xDA envelope (Muster, Dissolve): not a Depart.
                Ok(_) => continue,
                Err(_) => return Err(Unavailable::Instruction("undecodable 0xDA data")),
            },
            wix::TAG_RESIDENT_ACT => match WideCommand::decode(&ci.data) {
                Ok(WideCommand::ResidentAct(act)) => match act.command() {
                    Ok(WideCommand::Depart(d)) => (d, true),
                    Ok(_) => continue,
                    Err(_) => return Err(Unavailable::Instruction("undecodable act inner")),
                },
                Ok(_) => continue,
                Err(_) => return Err(Unavailable::Instruction("undecodable 0xDD data")),
            },
            _ => continue,
        };
        if found.is_some() {
            return Err(Unavailable::SeveralDeparts);
        }
        let accounts = ci
            .accounts
            .iter()
            .map(|&k| {
                let k = k as usize;
                (m.account_keys[k], k < sig, tx::is_writable_index(m, k))
            })
            .collect();
        found = Some(FoundDepart {
            ix_index: i,
            frame_index,
            depart,
            accounts,
            act_wrapped,
        });
    }
    match found {
        Some(f) => Ok((f, program_ixs)),
        None => Err(Unavailable::NoDepart),
    }
}

/// The Depart account list as the dispatcher reads it: exactly the `DEPART`
/// table (13 positions) for a plain Depart, plus exactly four read-only
/// unsigned proof accounts for an act-wrapped one. Flags follow the
/// prologue's `check_accounts`, which `depart_as` runs under **both**
/// authorities (the resident start requires the actor's and the payer's
/// signatures too): every signer position signed; every `Wr::W` position
/// writable; a `Wr::R` position of a program-account category
/// (`Acc::Kind`/`Either`) not writable — a wallet or `Any` position may be
/// (an actor that is also the payer; a standing province that is also the
/// holding's own); and of the four `Wr::Either` transit positions the
/// departing slot's must be writable (the handler writes that record).
fn check_shape(f: &FoundDepart) -> Result<&[(Address, bool, bool)], Unavailable> {
    let specs: Vec<_> = wix::DEPART.iter().flat_map(|g| g.specs.iter()).collect();
    let n = specs.len();
    let want = if f.act_wrapped { n + 4 } else { n };
    if f.accounts.len() != want {
        return Err(Unavailable::Accounts("account count"));
    }
    for (spec, (_, signer, writable)) in specs.iter().zip(f.accounts.iter()) {
        if spec.signer && !signer {
            return Err(Unavailable::Accounts("a required signer is unsigned"));
        }
        // The prologue's rule: a writable position must be writable; a
        // read-only **program-account** position must not be writable
        // (a wallet or `Any` position may be, e.g. an actor that is also
        // the payer).
        match spec.wr {
            Wr::W if !writable => {
                return Err(Unavailable::Accounts("a writable position is read-only"))
            }
            Wr::R
                if *writable
                    && matches!(
                        spec.acc,
                        Acc::Kind(_) | Acc::Either(..) | Acc::KindV2(_) | Acc::EitherV2(..)
                    ) =>
            {
                return Err(Unavailable::Accounts("a read-only position is writable"))
            }
            _ => {}
        }
    }
    if f.act_wrapped {
        for (_, signer, writable) in &f.accounts[n..] {
            if *signer || *writable {
                return Err(Unavailable::Accounts(
                    "a proof account is signed or writable",
                ));
            }
        }
    }
    let slot = f.depart.transit_slot as usize;
    if slot >= frontier_abi::layout::player::holding::TRANSIT_N {
        return Err(Unavailable::Instruction("transit slot out of range"));
    }
    if !f.accounts[wix::DEPART_TRANSIT0 + slot].2 {
        return Err(Unavailable::Accounts(
            "the departing transit position is read-only",
        ));
    }
    Ok(&f.accounts[..n])
}

/// Decodes one `Departed` body into its facts.
struct Departed {
    host: WideHostRef,
    standing: ProvinceKey,
    bell: u32,
    slot: u8,
    depart_bell: u32,
    arrive_bell: u32,
    dep_mass: u32,
    stamina: u16,
    tip: u64,
    fee: u64,
    bond: u64,
    seal_root: [u8; 32],
}

fn departed_of(body: &[u8]) -> Result<Option<Departed>, Unavailable> {
    let r = WideRecord::decode(body).map_err(|_| Unavailable::Data("PSW1 body"))?;
    if r.kind != WideKind::Departed {
        return Ok(None);
    }
    if r.key.len() != HOST_REF_LEN + PROVINCE_KEY_LEN {
        return Err(Unavailable::Data("Departed key width"));
    }
    let host = WideHostRef::from_bytes(&r.key[..HOST_REF_LEN])
        .map_err(|_| Unavailable::Data("Departed host ref"))?;
    let standing = ProvinceKey::from_bytes(&r.key[HOST_REF_LEN..])
        .map_err(|_| Unavailable::Data("Departed standing key"))?;
    let p = r.payload;
    let u32at = |o: usize| -> Option<u32> {
        p.get(o..o + 4)
            .map(|s| u32::from_le_bytes(s.try_into().expect("4")))
    };
    let u64at = |o: usize| -> Option<u64> {
        p.get(o..o + 8)
            .map(|s| u64::from_le_bytes(s.try_into().expect("8")))
    };
    let u16at = |o: usize| -> Option<u16> {
        p.get(o..o + 2)
            .map(|s| u16::from_le_bytes(s.try_into().expect("2")))
    };
    let short = Unavailable::Data("Departed payload width");
    let mut root = [0u8; 32];
    root.copy_from_slice(p.get(39..71).ok_or(short.clone())?);
    Ok(Some(Departed {
        host,
        standing,
        bell: r.bell,
        slot: *p.first().ok_or(short.clone())?,
        depart_bell: u32at(1).ok_or(short.clone())?,
        arrive_bell: u32at(5).ok_or(short.clone())?,
        dep_mass: u32at(9).ok_or(short.clone())?,
        stamina: u16at(13).ok_or(short.clone())?,
        tip: u64at(15).ok_or(short.clone())?,
        fee: u64at(23).ok_or(short.clone())?,
        bond: u64at(31).ok_or(short)?,
        seal_root: root,
    }))
}

/// Extracts the commitment and seal of the one committed WideDepart in
/// `rec`, bound to its `Departed` record, under `scope`. Every failure is
/// [`Unavailable`]; nothing is guessed.
pub fn depart_proof(rec: &TxRecord, scope: &ProofScope) -> Result<DepartProof, Unavailable> {
    if rec.err.is_some() {
        return Err(Unavailable::RolledBack);
    }
    let w = decode_wire(rec)?;
    log_bounds(&rec.logs)?;
    let (found, program_ixs) = find_depart(&w, &scope.program)?;
    let frames = frames_of(&rec.logs, &scope.program)?;
    // Every record the program logged in this transaction, in every frame,
    // must pass the typed reader before any frame-specific extraction: a
    // malformed `PS2` or `PSW1` line anywhere in the program's frames (the
    // Depart's or another's) refuses the whole transaction.
    match decode_transaction(rec, &scope.program) {
        Ok(TransactionRecords::Committed(records)) => {
            if records
                .iter()
                .any(|r| matches!(r, ProgramRecord::Pswc { .. }))
            {
                return Err(Unavailable::Records(
                    "PSWC lifecycle sidecar is unsupported by departure proofs".into(),
                ));
            }
        }
        Ok(TransactionRecords::RolledBack) => return Err(Unavailable::RolledBack),
        Err(fclient::typed_log::DecodeError::Truncated) => return Err(Unavailable::Truncated),
        Err(e) => return Err(Unavailable::Records(format!("{e:?}"))),
    }
    if frames.len() != program_ixs {
        return Err(Unavailable::FrameCount {
            frames: frames.len(),
            instructions: program_ixs,
        });
    }
    let frame = &frames[found.frame_index];
    let mut departed: Option<Departed> = None;
    let mut n = 0usize;
    for body in psw1_bodies(&frame.data)? {
        if let Some(d) = departed_of(&body)? {
            n += 1;
            departed = Some(d);
        }
    }
    if n != 1 {
        return Err(Unavailable::DepartedCount(n));
    }
    let rec_d = departed.expect("exactly one");
    let accounts = check_shape(&found)?;
    let x = &found.depart;
    // The instruction's host, as the dispatcher decodes it.
    let host =
        WideHostRef::from_bytes(&x.host).map_err(|_| Unavailable::Instruction("host ref"))?;
    let ctx = scope.ctx();
    let world =
        WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Unavailable::World)?;
    if host.key().world() != world
        || rec_d.host.key().world() != world
        || rec_d.standing.world() != world
    {
        return Err(Unavailable::World);
    }
    // The wide ring domain, explicitly (the handler's `coord.ring() <
    // FIRST_WIDE_RING → BadData`; a legacy province is never a wide
    // standing): not inferred from the PDA equalities below.
    if host.key().coord().ring() < FIRST_WIDE_RING {
        return Err(Unavailable::NotWide("host"));
    }
    if rec_d.standing.coord().ring() < FIRST_WIDE_RING {
        return Err(Unavailable::NotWide("standing province"));
    }
    if rec_d.host != host {
        return Err(Unavailable::Mismatch("host reference"));
    }
    // The seal's syntax the handler checks first (`host::seal_flag_ok`):
    // bit 7 set, bit 6 clear.
    if x.seal[0] & 0x80 == 0 || x.seal[0] & 0x40 != 0 {
        return Err(Unavailable::Instruction("seal flag byte"));
    }
    if rec_d.slot != x.transit_slot {
        return Err(Unavailable::Mismatch("transit slot"));
    }
    if rec_d.arrive_bell != x.arrive_bell {
        return Err(Unavailable::Mismatch("arrival bell"));
    }
    if rec_d.tip != x.tip {
        return Err(Unavailable::Mismatch("tip"));
    }
    if rec_d.bell != rec_d.depart_bell {
        return Err(Unavailable::Mismatch("record bell and departure bell"));
    }
    let seal_root = wseal::seal_root(&x.commit, &wseal::ct_hash(&x.seal));
    if seal_root != rec_d.seal_root {
        return Err(Unavailable::Mismatch("seal root"));
    }
    // The accounts at the dispatcher's positions, at their canonical
    // addresses for this host and this standing province.
    let season = accounts[2].0;
    if season != scope.season {
        return Err(Unavailable::Accounts(
            "season position is not the scope's Season",
        ));
    }
    let coord = host.key().coord();
    let holding = wh::holding_address(&ctx, coord, host.site());
    if accounts[4].0.to_bytes() != holding {
        return Err(Unavailable::Accounts("holding position is not canonical"));
    }
    let standing = wl::province_address(&ctx, rec_d.standing.coord());
    if accounts[5].0.to_bytes() != standing {
        return Err(Unavailable::Accounts(
            "standing province position is not canonical",
        ));
    }
    if accounts[6].0 != fclient::addr::system_program() {
        return Err(Unavailable::Accounts("system position"));
    }
    let own = wl::province_address(&ctx, coord);
    if accounts[7].0.to_bytes() != own {
        return Err(Unavailable::Accounts(
            "holding_province position is not canonical",
        ));
    }
    for s in 0..frontier_abi::layout::player::holding::TRANSIT_N {
        let want = wm::transit_address(&ctx, &holding, s as u8);
        if accounts[wix::DEPART_TRANSIT0 + s].0.to_bytes() != want {
            return Err(Unavailable::Accounts("a transit position is not canonical"));
        }
    }
    let roster = wro::roster_address(&ctx, rec_d.standing);
    if accounts[12].0.to_bytes() != roster {
        return Err(Unavailable::Accounts("roster position is not canonical"));
    }
    let transit = accounts[wix::DEPART_TRANSIT0 + x.transit_slot as usize].0;
    let mut sig = [0u8; 64];
    sig.copy_from_slice(rec.signature.as_ref());
    Ok(DepartProof {
        host,
        standing: rec_d.standing,
        transit_slot: x.transit_slot,
        depart_bell: rec_d.depart_bell,
        arrive_bell: x.arrive_bell,
        tip: x.tip,
        commit: x.commit,
        seal: x.seal,
        seal_root,
        dep_mass_milli: rec_d.dep_mass,
        march_stamina: rec_d.stamina,
        fee: rec_d.fee,
        bond: rec_d.bond,
        holding: accounts[4].0,
        transit,
        origin_province: accounts[5].0,
        roster: accounts[12].0,
        act_wrapped: found.act_wrapped,
        provenance: Provenance {
            seq: rec.seq,
            slot: rec.slot,
            signature: sig,
            instruction_index: found.ix_index,
            signatures_verified: false,
            method: METHOD_FEED,
        },
    })
}

/// The provenance method of a proof this module extracted.
pub const METHOD_FEED: &str = "feed record wire + frame-bound PSW1 Departed";
/// The provenance method a store assigns to a proof a caller handed in:
/// not extracted here; whatever the caller claimed is replaced by this.
pub const METHOD_SUPPLIED: &str =
    "caller-supplied proof: not extracted here; provenance unverified";

/// Convenience: the outcome of a page of feed records, each attempted
/// independently. Rolled-back and legacy records are reported, not hidden.
pub fn depart_proofs(
    page: &[TxRecord],
    scope: &ProofScope,
) -> Vec<(u64, Result<DepartProof, Unavailable>)> {
    page.iter()
        .map(|r| (r.seq, depart_proof(r, scope)))
        .collect()
}
