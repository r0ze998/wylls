//! Strict test-support decoding of an **unsigned legacy Solana Message** (as
//! the keeper's unsigned preparers emit it) and its mapping onto this crate's
//! native boundary. Nothing here signs, verifies a signature, builds a
//! transaction or talks to a bank: a decoded signer bit is only what the
//! message *requests*; the boundary then treats it as a fixture privilege.
//!
//! Also a minimal strict reader for the preparer's compact JSON report (no
//! escapes, no duplicate keys) and strict standard base64, so the runtime
//! tests consume the real Rust output without new dependencies.

use crate::InstructionAccount;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageError {
    Truncated,
    /// A versioned (v0+) message: only legacy is accepted.
    Versioned,
    /// A compact-u16 that is not its minimal encoding or exceeds u16.
    NonCanonicalLength,
    Header,
    DuplicateKey,
    ProgramIndex,
    /// An invoked program requested signer or writable privileges.
    ProgramPrivilege,
    AccountIndex,
    TrailingBytes,
    Base64,
    Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub signatures: u8,
    pub readonly_signed: u8,
    pub readonly_unsigned: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledInstruction {
    pub program: u8,
    pub accounts: Vec<u8>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub header: Header,
    pub keys: Vec<[u8; 32]>,
    pub blockhash: [u8; 32],
    pub instructions: Vec<CompiledInstruction>,
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], MessageError> {
        let end = self.at.checked_add(n).ok_or(MessageError::Truncated)?;
        let s = self.b.get(self.at..end).ok_or(MessageError::Truncated)?;
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, MessageError> {
        Ok(self.take(1)?[0])
    }
    /// Solana compact-u16, minimal encoding only.
    fn shortvec(&mut self) -> Result<usize, MessageError> {
        let mut n = 0usize;
        for i in 0..3 {
            let x = self.u8()?;
            n |= usize::from(x & 0x7f) << (7 * i);
            if x & 0x80 == 0 {
                if (i > 0 && x == 0) || n > usize::from(u16::MAX) {
                    return Err(MessageError::NonCanonicalLength);
                }
                return Ok(n);
            }
        }
        Err(MessageError::NonCanonicalLength)
    }
}

/// Decode a legacy Message exactly: consistent header, unique keys, every
/// index in range, no invoked program as fee payer, signer or writable, and
/// no trailing byte.
pub fn decode(bytes: &[u8]) -> Result<Message, MessageError> {
    let mut r = Reader { b: bytes, at: 0 };
    let first = r.u8()?;
    if first & 0x80 != 0 {
        return Err(MessageError::Versioned);
    }
    let header = Header {
        signatures: first,
        readonly_signed: r.u8()?,
        readonly_unsigned: r.u8()?,
    };
    let n = r.shortvec()?;
    if n > 256
        || header.signatures == 0
        || header.readonly_signed >= header.signatures
        || usize::from(header.signatures) > n
        || usize::from(header.readonly_unsigned) > n - usize::from(header.signatures)
    {
        return Err(MessageError::Header);
    }
    let mut keys: Vec<[u8; 32]> = Vec::with_capacity(n);
    for _ in 0..n {
        let k: [u8; 32] = r.take(32)?.try_into().map_err(|_| MessageError::Truncated)?;
        if keys.contains(&k) {
            return Err(MessageError::DuplicateKey);
        }
        keys.push(k);
    }
    let blockhash = r.take(32)?.try_into().map_err(|_| MessageError::Truncated)?;
    let m = r.shortvec()?;
    let mut instructions = Vec::with_capacity(m);
    let mut message = Message { header, keys, blockhash, instructions: Vec::new() };
    for _ in 0..m {
        let program = r.u8()?;
        let p = usize::from(program);
        if p >= n || p == 0 {
            return Err(MessageError::ProgramIndex);
        }
        if message.is_signer(p) || message.is_writable(p) {
            return Err(MessageError::ProgramPrivilege);
        }
        let k = r.shortvec()?;
        let accounts = r.take(k)?.to_vec();
        if accounts.iter().any(|&i| usize::from(i) >= n) {
            return Err(MessageError::AccountIndex);
        }
        let d = r.shortvec()?;
        let data = r.take(d)?.to_vec();
        instructions.push(CompiledInstruction { program, accounts, data });
    }
    if r.at != bytes.len() {
        return Err(MessageError::TrailingBytes);
    }
    message.instructions = instructions;
    Ok(message)
}

impl Message {
    pub fn is_signer(&self, i: usize) -> bool {
        i < usize::from(self.header.signatures)
    }
    /// The legacy header's writable bit (fee payer always writable since
    /// `readonly_signed < signatures`).
    pub fn is_writable(&self, i: usize) -> bool {
        let s = usize::from(self.header.signatures);
        if i < s {
            i < s - usize::from(self.header.readonly_signed)
        } else {
            i < self.keys.len() - usize::from(self.header.readonly_unsigned)
        }
    }
    /// The instruction's accounts as boundary privileges, with transaction
    /// indices equal to message key indices (the transaction account list
    /// is the message key list, in order). Aliased roles stay one index.
    pub fn privileges(&self, ix: &CompiledInstruction) -> Vec<InstructionAccount> {
        ix.accounts
            .iter()
            .map(|&i| {
                let i = usize::from(i);
                InstructionAccount::new(i as u16, self.is_signer(i), self.is_writable(i))
            })
            .collect()
    }
}

/// Strict RFC 4648 standard base64 with required padding and zero pad bits.
pub fn base64_standard(s: &str) -> Result<Vec<u8>, MessageError> {
    let b = s.as_bytes();
    if b.is_empty() || b.len() % 4 != 0 {
        return Err(MessageError::Base64);
    }
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    for (q, chunk) in b.chunks(4).enumerate() {
        let last = q == b.len() / 4 - 1;
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return Err(MessageError::Base64);
        }
        let mut n = 0u32;
        for &c in &chunk[..4 - pad] {
            n = (n << 6) | val(c).ok_or(MessageError::Base64)?;
        }
        n <<= 6 * pad as u32;
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        // the discarded low bits of a padded quantum must be zero
        if (pad == 1 && bytes[2] != 0) || (pad == 2 && (bytes[1] != 0 || bytes[2] != 0)) {
            return Err(MessageError::Base64);
        }
        out.extend_from_slice(&bytes[..3 - pad]);
    }
    Ok(out)
}

/// A JSON value of the report subset: no string escapes; numbers are kept
/// as their literal text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Json<'a> {
    Null,
    Bool(bool),
    Num(&'a str),
    Str(&'a str),
    Arr(Vec<Json<'a>>),
    Obj(Vec<(&'a str, Json<'a>)>),
}

impl<'a> Json<'a> {
    /// Parse a whole document (one trailing newline allowed).
    pub fn parse(text: &'a str) -> Result<Self, MessageError> {
        let t = text.strip_suffix('\n').unwrap_or(text);
        let mut at = 0;
        let v = Self::value(t, &mut at, 0)?;
        if at != t.len() {
            return Err(MessageError::Json);
        }
        Ok(v)
    }
    fn value(t: &'a str, at: &mut usize, depth: usize) -> Result<Self, MessageError> {
        let b = t.as_bytes();
        if depth > 16 {
            return Err(MessageError::Json);
        }
        match b.get(*at).ok_or(MessageError::Json)? {
            b'"' => Ok(Json::Str(Self::string(t, at)?)),
            b'{' => {
                *at += 1;
                let mut members: Vec<(&str, Json)> = Vec::new();
                if b.get(*at) == Some(&b'}') {
                    *at += 1;
                    return Ok(Json::Obj(members));
                }
                loop {
                    let k = Self::string(t, at)?;
                    if b.get(*at) != Some(&b':') || members.iter().any(|(m, _)| *m == k) {
                        return Err(MessageError::Json);
                    }
                    *at += 1;
                    members.push((k, Self::value(t, at, depth + 1)?));
                    match b.get(*at) {
                        Some(b',') => *at += 1,
                        Some(b'}') => {
                            *at += 1;
                            return Ok(Json::Obj(members));
                        }
                        _ => return Err(MessageError::Json),
                    }
                }
            }
            b'[' => {
                *at += 1;
                let mut items = Vec::new();
                if b.get(*at) == Some(&b']') {
                    *at += 1;
                    return Ok(Json::Arr(items));
                }
                loop {
                    items.push(Self::value(t, at, depth + 1)?);
                    match b.get(*at) {
                        Some(b',') => *at += 1,
                        Some(b']') => {
                            *at += 1;
                            return Ok(Json::Arr(items));
                        }
                        _ => return Err(MessageError::Json),
                    }
                }
            }
            _ => {
                for (lit, v) in [("null", Json::Null), ("true", Json::Bool(true)), ("false", Json::Bool(false))] {
                    if t[*at..].starts_with(lit) {
                        *at += lit.len();
                        return Ok(v);
                    }
                }
                // strict integer: -?(0|[1-9][0-9]*), no fraction or exponent
                let start = *at;
                if b.get(*at) == Some(&b'-') {
                    *at += 1;
                }
                match b.get(*at) {
                    Some(b'0') => *at += 1,
                    Some(b'1'..=b'9') => {
                        while matches!(b.get(*at), Some(b'0'..=b'9')) {
                            *at += 1;
                        }
                    }
                    _ => return Err(MessageError::Json),
                }
                if matches!(b.get(*at), Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')) {
                    return Err(MessageError::Json);
                }
                Ok(Json::Num(&t[start..*at]))
            }
        }
    }
    fn string(t: &'a str, at: &mut usize) -> Result<&'a str, MessageError> {
        let b = t.as_bytes();
        if b.get(*at) != Some(&b'"') {
            return Err(MessageError::Json);
        }
        let start = *at + 1;
        let len = t[start..].find('"').ok_or(MessageError::Json)?;
        let s = &t[start..start + len];
        if s.bytes().any(|c| c == b'\\' || c < 0x20) {
            return Err(MessageError::Json);
        }
        *at = start + len + 1;
        Ok(s)
    }
    pub fn get(&self, key: &str) -> Option<&Json<'a>> {
        match self {
            Json::Obj(m) => m.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&'a str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn at(&self, path: &[&str]) -> Option<&Json<'a>> {
        path.iter().try_fold(self, |v, k| v.get(k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy(header: [u8; 3], keys: &[[u8; 32]], ixs: &[(u8, &[u8], &[u8])]) -> Vec<u8> {
        let mut b = header.to_vec();
        b.push(keys.len() as u8);
        for k in keys {
            b.extend_from_slice(k);
        }
        b.extend_from_slice(&[7; 32]);
        b.push(ixs.len() as u8);
        for (p, a, d) in ixs {
            b.push(*p);
            b.push(a.len() as u8);
            b.extend_from_slice(a);
            b.push(d.len() as u8);
            b.extend_from_slice(d);
        }
        b
    }

    #[test]
    fn decodes_a_legacy_message_and_its_privileges() {
        let m = decode(&legacy([2, 1, 1], &[[1; 32], [2; 32], [3; 32], [4; 32]], &[(3, &[0, 1, 2, 2], &[9])])).unwrap();
        let p = m.privileges(&m.instructions[0]);
        let bits: Vec<_> = p.iter().map(|a| (a.index_in_transaction, a.is_signer(), a.is_writable())).collect();
        assert_eq!(bits, vec![(0, true, true), (1, true, false), (2, false, true), (2, false, true)]);
    }

    #[test]
    fn refuses_every_malformed_shape() {
        let k = [[1; 32], [2; 32], [3; 32]];
        let ok = legacy([1, 0, 1], &k, &[(2, &[0, 1], &[1])]);
        assert!(decode(&ok).is_ok());
        let mut trailing = ok.clone();
        trailing.push(0);
        let mut versioned = ok.clone();
        versioned.insert(0, 0x80);
        let mut noncanonical = ok.clone();
        noncanonical.splice(3..4, [0x83, 0x00]);
        for (bad, e) in [
            (ok[..ok.len() - 1].to_vec(), MessageError::Truncated),
            (trailing, MessageError::TrailingBytes),
            (versioned, MessageError::Versioned),
            (noncanonical, MessageError::NonCanonicalLength),
            (legacy([0, 0, 0], &k, &[]), MessageError::Header),
            (legacy([1, 1, 0], &k, &[]), MessageError::Header),
            (legacy([1, 0, 3], &k, &[]), MessageError::Header),
            (legacy([1, 0, 1], &[[1; 32], [1; 32], [3; 32]], &[]), MessageError::DuplicateKey),
            (legacy([1, 0, 1], &k, &[(3, &[], &[])]), MessageError::ProgramIndex),
            (legacy([1, 0, 1], &k, &[(0, &[], &[])]), MessageError::ProgramIndex),
            (legacy([1, 0, 0], &k, &[(2, &[], &[])]), MessageError::ProgramPrivilege),
            (legacy([2, 1, 1], &k, &[(1, &[], &[])]), MessageError::ProgramPrivilege),
            (legacy([1, 0, 1], &k, &[(2, &[3], &[])]), MessageError::AccountIndex),
        ] {
            assert_eq!(decode(&bad), Err(e), "{bad:?}");
        }
    }

    #[test]
    fn base64_and_json_are_strict() {
        assert_eq!(base64_standard("AAEC").unwrap(), vec![0, 1, 2]);
        assert_eq!(base64_standard("AAE=").unwrap(), vec![0, 1]);
        assert_eq!(base64_standard("AA==").unwrap(), vec![0]);
        for bad in ["", "AAE", "AAF=", "AB==", "A===", "AA==AAAA", "AA-_", "AAE\n"] {
            assert_eq!(base64_standard(bad), Err(MessageError::Base64), "{bad}");
        }
        let v = Json::parse("{\"a\":{\"b\":\"x\",\"n\":[1,-2,null,true]}}\n").unwrap();
        assert_eq!(v.at(&["a", "b"]).and_then(Json::str), Some("x"));
        for bad in ["{\"a\":1,\"a\":2}", "{\"a\":\"\\u0041\"}", "{\"a\":1} ", "[1,]", "{\"a\" :1}"] {
            assert_eq!(Json::parse(bad), Err(MessageError::Json), "{bad}");
        }
        for ok in ["0", "-0", "7", "-7", "10", "1234567890"] {
            assert_eq!(Json::parse(ok), Ok(Json::Num(ok)), "{ok}");
            assert!(Json::parse(&format!("[{ok},{ok}]")).is_ok(), "{ok}");
        }
        for bad in ["-", "--1", "1-2", "01", "-01", "00", "1.5", "1e3", "+1", "1+", "-a", "[-]", "[01]", "{\"a\":1-2}"] {
            assert_eq!(Json::parse(bad), Err(MessageError::Json), "{bad}");
        }
    }

    /// One message whose key count is encoded by `count` bytes.
    fn with_count(count: &[u8]) -> Result<usize, MessageError> {
        let mut r = Reader { b: count, at: 0 };
        let n = r.shortvec()?;
        if r.at != count.len() {
            return Err(MessageError::TrailingBytes);
        }
        Ok(n)
    }

    #[test]
    fn compact_u16_boundaries_are_exact() {
        for (bytes, n) in [
            (&[0x00][..], 0),
            (&[0x7f], 127),
            (&[0x80, 0x01], 128),
            (&[0xff, 0x7f], 16_383),
            (&[0x80, 0x80, 0x01], 16_384),
            (&[0xff, 0xff, 0x03], 65_535),
        ] {
            assert_eq!(with_count(bytes), Ok(n), "{bytes:?}");
        }
        for (bytes, e) in [
            // overflow beyond u16 and a fourth byte
            (&[0x80, 0x80, 0x04][..], MessageError::NonCanonicalLength),
            (&[0xff, 0xff, 0x7f], MessageError::NonCanonicalLength),
            (&[0x80, 0x80, 0x80, 0x01], MessageError::NonCanonicalLength),
            // non-minimal encodings of 0, 127 and 128
            (&[0x80, 0x00], MessageError::NonCanonicalLength),
            (&[0xff, 0x00], MessageError::NonCanonicalLength),
            (&[0x80, 0x81, 0x00], MessageError::NonCanonicalLength),
            // truncated continuation
            (&[0x80], MessageError::Truncated),
            (&[0xff, 0xff], MessageError::Truncated),
            (&[], MessageError::Truncated),
        ] {
            assert_eq!(with_count(bytes), Err(e), "{bytes:?}");
        }
        // a canonical count of 257 keys exceeds the u8 index space
        let mut b = vec![1, 0, 0, 0x81, 0x02];
        b.extend(std::iter::repeat(0).take(32));
        assert_eq!(decode(&b), Err(MessageError::Header));
    }
}
