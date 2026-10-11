//! The signed record bytes of the AI citizens' social layer, the Rust mirror
//! of `permutation-server/web/frontier/council/aisocial.mjs` (contract §6.1;
//! unit AC3b). The JS file is the single source; this file must produce the
//! same bytes for the same fields, which `bots/tests/ai_social_vectors.rs`
//! checks against `permutation-gateway/test/fixtures/ai-social-v1.json`
//! (byte conformance only: one producer, one freshness checker, M1 §3.5).
//!
//! Three live records, all integers little-endian, strings UTF-8 with a u16
//! length prefix, every record starting with its own domain TAG:
//!
//! | record | bytes |
//! |---|---|
//! | talk | `TAG ‖ season u64 ‖ bell u32 ‖ wallet[32] ‖ seq u32 ‖ channel u8 (0 world, 1 nation, 3 direct) ‖ target (nation: u8 · direct: wallet[32] · world: nothing) ‖ kind u8 (0 say, 1 motion) ‖ ref u64 ‖ origin u8 ‖ lang[2] ‖ text (u16 len, ≤ 280 code points, ≤ 1,120 bytes)` |
//! | ballot | `TAG ‖ season u64 ‖ period u32 ‖ wallet[32] ‖ faction u8 ‖ option u8 ‖ candidates_hash[32] ‖ nonce[16] ‖ origin u8` |
//! | call read | `TAG ‖ season u64 ‖ faction u8 ‖ period u32 ‖ wallet[32] ‖ unix i64` |
//!
//! **Domain separation.** [`sign_record`] and [`signable`] refuse to sign
//! bytes that do not start with one of the three live TAGs; the TAG
//! `wylls/frontier/pact/v1` is reserved (Appendix A.5) and refused by name.
//! Byte 0 of every TAG is `w` = 0x77, which as a legacy Solana message
//! header claims 119 required signatures and, as a v0 prefix, is not 0x80,
//! so no TAG-prefixed byte string is a valid single-signer transaction
//! message (`bots/tests/ai_sign_domain.rs` asserts it with the message
//! parser).
//!
//! The signature is ed25519 by the citizen's **session key** (the bot's
//! `session` keypair) over exactly these bytes; the social service verifies
//! it against `GET /h/me/{wallet}`.

use fclient::{Keypair, Signer};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const TALK_TAG: &[u8] = b"wylls/frontier/talk/v1";
pub const BALLOT_TAG: &[u8] = b"wylls/frontier/ballot/v1";
pub const CALLREAD_TAG: &[u8] = b"wylls/frontier/callread/v1";
/// Reserved by contract v1.2 (Appendix A.5): never encoded, decoded or signed.
pub const RESERVED_TAG: &[u8] = b"wylls/frontier/pact/v1";

pub const MAX_TEXT_CHARS: usize = 280;
pub const MAX_TEXT_BYTES: usize = 1_120;
/// `seq = (bell << 4) | k`, k = 0..=15.
pub const MAX_SEQ_K: u32 = 15;

/// Which live record a byte string is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordType {
    Talk,
    Ballot,
    CallRead,
}

/// A refusal in the §6.2 vocabulary (`BadBytes`, `TextTooLong`) or
/// `NotSignable` (the domain-separation guard).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignError {
    pub code: &'static str,
    pub detail: String,
}

impl std::fmt::Display for SignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}
impl std::error::Error for SignError {}

fn bad<T>(m: impl Into<String>) -> Result<T, SignError> {
    Err(SignError {
        code: "BadBytes",
        detail: m.into(),
    })
}

fn not_signable<T>(m: impl Into<String>) -> Result<T, SignError> {
    Err(SignError {
        code: "NotSignable",
        detail: m.into(),
    })
}

fn too_long<T>() -> Result<T, SignError> {
    Err(SignError {
        code: "TextTooLong",
        detail: format!("text: at most {MAX_TEXT_CHARS} code points and {MAX_TEXT_BYTES} bytes"),
    })
}

// ------------------------------------------------------------------ records

/// Who a talk record is addressed to; the channel byte follows from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TalkTarget {
    /// Channel 0 (world): no target field.
    World,
    /// Channel 1 (nation): the faction.
    Nation(u8),
    /// Channel 3 (direct): the addressed wallet.
    Direct([u8; 32]),
}

impl TalkTarget {
    pub fn channel(&self) -> u8 {
        match self {
            TalkTarget::World => 0,
            TalkTarget::Nation(_) => 1,
            TalkTarget::Direct(_) => 3,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Talk {
    pub season: u64,
    pub bell: u32,
    pub wallet: [u8; 32],
    pub seq: u32,
    pub target: TalkTarget,
    /// 0 say, 1 motion.
    pub kind: u8,
    /// Say: the reply-to id or 0. Motion: `period << 8 | option`.
    pub reference: u64,
    /// 0 human-written, 1 AI-written, 2 scripted by the operator.
    pub origin: u8,
    pub lang: [u8; 2],
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ballot {
    pub season: u64,
    pub period: u32,
    pub wallet: [u8; 32],
    pub faction: u8,
    /// 0 none, 1..=3.
    pub option: u8,
    pub candidates_hash: [u8; 32],
    pub nonce: [u8; 16],
    pub origin: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallRead {
    pub season: u64,
    pub faction: u8,
    pub period: u32,
    pub wallet: [u8; 32],
    pub unix: i64,
}

/// A decoded record of any live type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record {
    Talk(Talk),
    Ballot(Ballot),
    CallRead(CallRead),
}

/// A motion's `ref`: `period << 8 | option`.
pub fn motion_ref(period: u32, option: u8) -> u64 {
    (period as u64) << 8 | option as u64
}

/// `seq = (bell << 4) | k` for k in 0..=15 (the record's index among this
/// wallet's records of the type in that bell).
pub fn seq_of(bell: u32, k: u32) -> Result<u32, SignError> {
    if k > MAX_SEQ_K {
        return bad("seq: k is 0..15");
    }
    let v = (bell as u64) * 16 + k as u64;
    if v > u32::MAX as u64 {
        return bad("seq: bell too large");
    }
    Ok(v as u32)
}

// ------------------------------------------------------------------ helpers

/// Code points of a string.
fn code_points(s: &str) -> usize {
    s.chars().count()
}

/// JavaScript's `String.prototype.trim` white space (the Unicode `White_Space`
/// property plus U+FEFF), so the empty-text rule matches `aisocial.mjs`.
fn js_blank(s: &str) -> bool {
    s.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

fn text_ok(text: &str) -> Result<(), SignError> {
    if code_points(text) > MAX_TEXT_CHARS || text.len() > MAX_TEXT_BYTES {
        return too_long();
    }
    if js_blank(text) {
        return bad("text: empty");
    }
    Ok(())
}

fn lang_ok(lang: &[u8; 2]) -> Result<(), SignError> {
    if lang.iter().all(u8::is_ascii_lowercase) {
        Ok(())
    } else {
        bad("lang: two lowercase ASCII letters")
    }
}

fn one_of(v: u8, allowed: &[u8], what: &str) -> Result<(), SignError> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        bad(format!("{what}: {v} is not one of {allowed:?}"))
    }
}

fn motion_ok(channel: u8, reference: u64) -> Result<(), SignError> {
    let option = (reference & 0xff) as u8;
    if channel != 1 {
        return bad("a motion goes to the nation channel");
    }
    if !(1..=3).contains(&option) {
        return bad("motion: option 1..3");
    }
    Ok(())
}

// ------------------------------------------------------------------ talk

/// Talk bytes. The checks run in the order of `encodeTalk`, so the first
/// refusal is the same one.
pub fn encode_talk(r: &Talk) -> Result<Vec<u8>, SignError> {
    one_of(r.target.channel(), &[0, 1, 3], "channel")?;
    one_of(r.kind, &[0, 1], "kind")?;
    one_of(r.origin, &[0, 1, 2], "origin")?;
    if r.kind == 1 {
        motion_ok(r.target.channel(), r.reference)?;
    }
    lang_ok(&r.lang)?;
    text_ok(&r.text)?;
    let mut o = Vec::with_capacity(TALK_TAG.len() + 100 + r.text.len());
    o.extend_from_slice(TALK_TAG);
    o.extend_from_slice(&r.season.to_le_bytes());
    o.extend_from_slice(&r.bell.to_le_bytes());
    o.extend_from_slice(&r.wallet);
    o.extend_from_slice(&r.seq.to_le_bytes());
    o.push(r.target.channel());
    match r.target {
        TalkTarget::World => {}
        TalkTarget::Nation(f) => o.push(f),
        TalkTarget::Direct(w) => o.extend_from_slice(&w),
    }
    o.push(r.kind);
    o.extend_from_slice(&r.reference.to_le_bytes());
    o.push(r.origin);
    o.extend_from_slice(&r.lang);
    o.extend_from_slice(&(r.text.len() as u16).to_le_bytes());
    o.extend_from_slice(r.text.as_bytes());
    Ok(o)
}

/// A reader over bytes after a TAG.
struct In<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> In<'a> {
    fn new(b: &'a [u8], tag: &[u8]) -> Result<In<'a>, SignError> {
        if b.len() < tag.len() {
            return bad("too short");
        }
        if &b[..tag.len()] != tag {
            return bad("wrong tag");
        }
        Ok(In { b, o: tag.len() })
    }
    fn raw(&mut self, n: usize) -> Result<&'a [u8], SignError> {
        if self.o + n > self.b.len() {
            return bad("truncated");
        }
        let s = &self.b[self.o..self.o + n];
        self.o += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, SignError> {
        Ok(self.raw(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, SignError> {
        Ok(u16::from_le_bytes(self.raw(2)?.try_into().expect("2")))
    }
    fn u32(&mut self) -> Result<u32, SignError> {
        Ok(u32::from_le_bytes(self.raw(4)?.try_into().expect("4")))
    }
    fn u64(&mut self) -> Result<u64, SignError> {
        Ok(u64::from_le_bytes(self.raw(8)?.try_into().expect("8")))
    }
    fn i64(&mut self) -> Result<i64, SignError> {
        Ok(i64::from_le_bytes(self.raw(8)?.try_into().expect("8")))
    }
    fn w32(&mut self) -> Result<[u8; 32], SignError> {
        Ok(self.raw(32)?.try_into().expect("32"))
    }
    fn end(&self) -> Result<(), SignError> {
        if self.o == self.b.len() {
            Ok(())
        } else {
            bad("trailing bytes")
        }
    }
}

pub fn decode_talk(bytes: &[u8]) -> Result<Talk, SignError> {
    let mut i = In::new(bytes, TALK_TAG)?;
    let season = i.u64()?;
    let bell = i.u32()?;
    let wallet = i.w32()?;
    let seq = i.u32()?;
    let channel = i.u8()?;
    one_of(channel, &[0, 1, 3], "channel")?;
    let target = match channel {
        1 => TalkTarget::Nation(i.u8()?),
        3 => TalkTarget::Direct(i.w32()?),
        _ => TalkTarget::World,
    };
    let kind = i.u8()?;
    one_of(kind, &[0, 1], "kind")?;
    let reference = i.u64()?;
    let origin = i.u8()?;
    one_of(origin, &[0, 1, 2], "origin")?;
    let lang: [u8; 2] = i.raw(2)?.try_into().expect("2");
    let n = i.u16()? as usize;
    let raw = i.raw(n)?;
    i.end()?;
    lang_ok(&lang)?;
    let Ok(text) = std::str::from_utf8(raw) else {
        return bad("text: not UTF-8");
    };
    text_ok(text)?;
    if kind == 1 {
        motion_ok(channel, reference)?;
    }
    Ok(Talk {
        season,
        bell,
        wallet,
        seq,
        target,
        kind,
        reference,
        origin,
        lang,
        text: text.to_string(),
    })
}

// ------------------------------------------------------------------ ballot

pub fn encode_ballot(r: &Ballot) -> Result<Vec<u8>, SignError> {
    one_of(r.option, &[0, 1, 2, 3], "option")?;
    one_of(r.origin, &[0, 1, 2], "origin")?;
    let mut o = Vec::with_capacity(BALLOT_TAG.len() + 100);
    o.extend_from_slice(BALLOT_TAG);
    o.extend_from_slice(&r.season.to_le_bytes());
    o.extend_from_slice(&r.period.to_le_bytes());
    o.extend_from_slice(&r.wallet);
    o.push(r.faction);
    o.push(r.option);
    o.extend_from_slice(&r.candidates_hash);
    o.extend_from_slice(&r.nonce);
    o.push(r.origin);
    Ok(o)
}

pub fn decode_ballot(bytes: &[u8]) -> Result<Ballot, SignError> {
    let mut i = In::new(bytes, BALLOT_TAG)?;
    let season = i.u64()?;
    let period = i.u32()?;
    let wallet = i.w32()?;
    let faction = i.u8()?;
    let option = i.u8()?;
    one_of(option, &[0, 1, 2, 3], "option")?;
    let candidates_hash = i.w32()?;
    let nonce: [u8; 16] = i.raw(16)?.try_into().expect("16");
    let origin = i.u8()?;
    one_of(origin, &[0, 1, 2], "origin")?;
    i.end()?;
    Ok(Ballot {
        season,
        period,
        wallet,
        faction,
        option,
        candidates_hash,
        nonce,
        origin,
    })
}

// ------------------------------------------------------------------ call read

pub fn encode_callread(r: &CallRead) -> Vec<u8> {
    let mut o = Vec::with_capacity(CALLREAD_TAG.len() + 53);
    o.extend_from_slice(CALLREAD_TAG);
    o.extend_from_slice(&r.season.to_le_bytes());
    o.push(r.faction);
    o.extend_from_slice(&r.period.to_le_bytes());
    o.extend_from_slice(&r.wallet);
    o.extend_from_slice(&r.unix.to_le_bytes());
    o
}

pub fn decode_callread(bytes: &[u8]) -> Result<CallRead, SignError> {
    let mut i = In::new(bytes, CALLREAD_TAG)?;
    let season = i.u64()?;
    let faction = i.u8()?;
    let period = i.u32()?;
    let wallet = i.w32()?;
    let unix = i.i64()?;
    i.end()?;
    Ok(CallRead {
        season,
        faction,
        period,
        wallet,
        unix,
    })
}

// ------------------------------------------------------------------ dispatch

fn starts_with(b: &[u8], tag: &[u8]) -> bool {
    b.len() >= tag.len() && &b[..tag.len()] == tag
}

/// The record type by TAG, else `None`.
pub fn record_type(bytes: &[u8]) -> Option<RecordType> {
    if starts_with(bytes, TALK_TAG) {
        Some(RecordType::Talk)
    } else if starts_with(bytes, BALLOT_TAG) {
        Some(RecordType::Ballot)
    } else if starts_with(bytes, CALLREAD_TAG) {
        Some(RecordType::CallRead)
    } else {
        None
    }
}

/// Whether the bytes begin with the reserved (pact) TAG.
pub fn is_reserved(bytes: &[u8]) -> bool {
    starts_with(bytes, RESERVED_TAG)
}

pub fn decode(bytes: &[u8]) -> Result<Record, SignError> {
    match record_type(bytes) {
        Some(RecordType::Talk) => decode_talk(bytes).map(Record::Talk),
        Some(RecordType::Ballot) => decode_ballot(bytes).map(Record::Ballot),
        Some(RecordType::CallRead) => decode_callread(bytes).map(Record::CallRead),
        None if is_reserved(bytes) => bad("a reserved TAG"),
        None => bad("unknown TAG"),
    }
}

/// The domain-separation guard: the record type of bytes a signer may sign;
/// `NotSignable` for any other bytes (the reserved TAG by name).
pub fn signable(bytes: &[u8]) -> Result<RecordType, SignError> {
    if is_reserved(bytes) {
        return not_signable("the reserved TAG is refused");
    }
    match record_type(bytes) {
        Some(t) => Ok(t),
        None => not_signable("only talk, ballot and call-read bytes are signed"),
    }
}

// ------------------------------------------------------------------ signing

/// SHA-256 of the concatenation of `parts`.
pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// `inner = sha256(bytes ‖ sig)` (§6.3, what a redaction keeps).
pub fn inner_of(bytes: &[u8], sig: &[u8]) -> [u8; 32] {
    sha256(&[bytes, sig])
}

/// `leaf = sha256(0x00 ‖ inner)`.
pub fn leaf_of(inner: &[u8; 32]) -> [u8; 32] {
    sha256(&[&[0u8], inner])
}

/// Signed record bytes, ready to POST.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signed {
    pub bytes: Vec<u8>,
    pub sig: [u8; 64],
}

impl Signed {
    pub fn bytes_b64(&self) -> String {
        frontier_agents::obs::b64_encode(&self.bytes)
    }
    pub fn sig_b64(&self) -> String {
        frontier_agents::obs::b64_encode(&self.sig)
    }
    pub fn inner(&self) -> [u8; 32] {
        inner_of(&self.bytes, &self.sig)
    }

    /// The §6.1 POST body: `{bytes_b64, sig_b64}` plus `decision_id` and
    /// `item` (required from AI wallets).
    pub fn post_body(&self, provenance: Option<(&str, u32)>) -> Value {
        let mut v = json!({"bytes_b64": self.bytes_b64(), "sig_b64": self.sig_b64()});
        if let Some((d, item)) = provenance {
            v["decision_id"] = json!(d);
            v["item"] = json!(item);
        }
        v
    }
}

/// Signs `bytes` with `key` after the domain-separation guard.
pub fn sign_record(bytes: &[u8], key: &Keypair) -> Result<Signed, SignError> {
    signable(bytes)?;
    let sig = key.sign_message(bytes);
    Ok(Signed {
        bytes: bytes.to_vec(),
        sig: <[u8; 64]>::from(sig),
    })
}

// ------------------------------------------------------------------ JSON in, bytes out

fn u64_of(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// A 32-byte key from a base58 string (Solana's alphabet) or 64 hex digits.
pub fn key32(s: &str) -> Option<[u8; 32]> {
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return hex::decode(s).ok()?.try_into().ok();
    }
    s.parse::<fclient::Address>().ok().map(|a| a.to_bytes())
}

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a Value, SignError> {
    match v.get(k) {
        Some(x) if !x.is_null() => Ok(x),
        _ => bad(format!("{k}: missing")),
    }
}

fn num<T: TryFrom<u64>>(v: &Value, k: &str) -> Result<T, SignError> {
    let n = u64_of(field(v, k)?);
    n.and_then(|n| T::try_from(n).ok())
        .map_or_else(|| bad(format!("{k}: not an unsigned integer")), Ok)
}

/// The mind's TALK object (§8.1: the §6.1 field names minus `wallet` and
/// the signature, plus `item`) with the brain's `wallet`, as a [`Talk`].
/// `channel` is the number (0, 1, 3) or the name (world, nation, direct);
/// `target` is the faction (nation) or a base58 wallet (direct).
pub fn talk_from_json(v: &Value, wallet: [u8; 32]) -> Result<Talk, SignError> {
    let channel = match field(v, "channel")? {
        Value::String(s) if s == "world" => 0,
        Value::String(s) if s == "nation" => 1,
        Value::String(s) if s == "direct" => 3,
        x => u64_of(x).map_or(99, |n| n.min(99) as u8),
    };
    let target = match channel {
        0 => TalkTarget::World,
        1 => TalkTarget::Nation(num(v, "target")?),
        3 => {
            let w = field(v, "target")?
                .as_str()
                .and_then(key32)
                .map_or_else(|| bad("target: a wallet is expected"), Ok)?;
            TalkTarget::Direct(w)
        }
        _ => return bad("channel: 0, 1, 3 or world, nation, direct"),
    };
    let lang_s = field(v, "lang")?.as_str().unwrap_or("");
    let lang: [u8; 2] = lang_s
        .as_bytes()
        .try_into()
        .map_or_else(|_| bad("lang: two lowercase ASCII letters"), Ok)?;
    Ok(Talk {
        season: num(v, "season")?,
        bell: num(v, "bell")?,
        wallet,
        seq: num(v, "seq")?,
        target,
        kind: num(v, "kind")?,
        reference: v.get("ref").and_then(u64_of).unwrap_or(0),
        origin: num(v, "origin")?,
        lang,
        text: field(v, "text")?
            .as_str()
            .map_or_else(|| bad("text: a string is expected"), |s| Ok(s.to_string()))?,
    })
}

/// The mind's BALLOT object with the brain's `wallet`, as a [`Ballot`].
/// `candidates_hash` is 64 hex digits, `nonce` 32.
pub fn ballot_from_json(v: &Value, wallet: [u8; 32]) -> Result<Ballot, SignError> {
    let hash = field(v, "candidates_hash")?
        .as_str()
        .and_then(|s| hex::decode(s).ok())
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .map_or_else(|| bad("candidates_hash: 32 bytes of hex"), Ok)?;
    let nonce = field(v, "nonce")?
        .as_str()
        .and_then(|s| hex::decode(s).ok())
        .and_then(|b| <[u8; 16]>::try_from(b).ok())
        .map_or_else(|| bad("nonce: 16 bytes of hex"), Ok)?;
    Ok(Ballot {
        season: num(v, "season")?,
        period: num(v, "period")?,
        wallet,
        faction: num(v, "faction")?,
        option: num(v, "option")?,
        candidates_hash: hash,
        nonce,
        origin: num(v, "origin")?,
    })
}

/// A signed call read's query string
/// (`faction=&period=&wallet=&unix=&sig=`, §8.2), the signature as
/// percent-encoded standard base64.
pub fn callread_query(r: &CallRead, signed: &Signed) -> String {
    format!(
        "faction={}&period={}&wallet={}&unix={}&sig={}",
        r.faction,
        r.period,
        fclient::Address::new_from_array(r.wallet),
        r.unix,
        percent_encode(&signed.sig_b64()),
    )
}

/// Percent-encodes everything but the RFC 3986 unreserved characters.
pub fn percent_encode(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// Encodes and signs the call read of `wallet` for `(faction, period)`.
pub fn sign_callread(
    season: u64,
    faction: u8,
    period: u32,
    unix: i64,
    wallet: [u8; 32],
    session: &Keypair,
) -> Result<(CallRead, Signed), SignError> {
    let r = CallRead {
        season,
        faction,
        period,
        wallet,
        unix,
    };
    let s = sign_record(&encode_callread(&r), session)?;
    Ok((r, s))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> Keypair {
        Keypair::new_from_array([n; 32])
    }

    #[test]
    fn talk_round_trips_and_checks_in_the_js_order() {
        let t = Talk {
            season: 31,
            bell: 402,
            wallet: [3; 32],
            seq: seq_of(402, 1).unwrap(),
            target: TalkTarget::Nation(2),
            kind: 0,
            reference: 0,
            origin: 1,
            lang: *b"en",
            text: "Hello.".into(),
        };
        let b = encode_talk(&t).unwrap();
        assert!(b.starts_with(TALK_TAG));
        assert_eq!(decode_talk(&b).unwrap(), t);
        let mut bad_origin = t.clone();
        bad_origin.origin = 3;
        assert_eq!(encode_talk(&bad_origin).unwrap_err().code, "BadBytes");
        let mut blank = t.clone();
        blank.text = " \u{feff} ".into();
        assert_eq!(encode_talk(&blank).unwrap_err().code, "BadBytes");
        let mut long = t;
        long.text = "a".repeat(281);
        assert_eq!(encode_talk(&long).unwrap_err().code, "TextTooLong");
    }

    #[test]
    fn seq_follows_the_pinned_rule() {
        assert_eq!(seq_of(402, 0).unwrap(), 6432);
        assert_eq!(seq_of(402, 15).unwrap(), 6447);
        assert!(seq_of(402, 16).is_err());
        assert!(seq_of(u32::MAX, 0).is_err());
        assert_eq!(motion_ref(5, 2), 1282);
    }

    #[test]
    fn the_guard_refuses_everything_but_the_three_tags() {
        let (r, s) = sign_callread(31, 4, 5, 1_800_000_000, [7; 32], &key(9)).unwrap();
        assert_eq!(decode_callread(&s.bytes).unwrap(), r);
        assert_eq!(signable(&s.bytes), Ok(RecordType::CallRead));
        let mut pact = RESERVED_TAG.to_vec();
        pact.extend_from_slice(&[1, 2, 3]);
        assert_eq!(signable(&pact).unwrap_err().code, "NotSignable");
        assert!(sign_record(&pact, &key(9)).is_err());
        assert!(sign_record(b"", &key(9)).is_err());
        assert!(sign_record(b"anything else", &key(9)).is_err());
    }

    #[test]
    fn json_in_ballot_and_talk() {
        let w = [5u8; 32];
        let talk = json!({"season": "31", "bell": 402, "seq": 6432, "channel": 1, "target": 2,
                          "kind": 0, "ref": 0, "origin": 1, "lang": "en", "text": "Hi.", "item": 0});
        let t = talk_from_json(&talk, w).unwrap();
        assert_eq!((t.season, t.target), (31, TalkTarget::Nation(2)));
        let ballot = json!({"season": 31, "period": 5, "faction": 4, "option": 2,
                            "candidates_hash": "ab".repeat(32), "nonce": "cd".repeat(16),
                            "origin": 1, "item": 0});
        let b = ballot_from_json(&ballot, w).unwrap();
        assert_eq!((b.option, b.nonce[0]), (2, 0xcd));
        let null_hash = json!({"season": 31, "period": 5, "faction": 4, "option": 2,
                               "candidates_hash": null, "nonce": "cd".repeat(16), "origin": 1});
        assert!(ballot_from_json(&null_hash, w).is_err());
        assert_eq!(percent_encode("a+b/c=="), "a%2Bb%2Fc%3D%3D");
    }
}
