//! The stdio protocol of the local wide-economy demo (`wylls-local-economy-v1`).
//!
//! One bounded ASCII line per command on stdin, one compact JSON line per
//! response on stdout, nothing else on stdout. See
//! `docs/frontier/map-growth/WIDE-ECONOMY-LOCAL-DEMO-PROTOCOL-20261108.md`.
//!
//! ```text
//! get
//! act REV harvest
//! act REV build ITEM            ITEM  0..=8
//! act REV train UNIT COUNT      UNIT  0..=6, COUNT 1..=1000 (transport budget, not a rule)
//! advance REV SECONDS           SECONDS 600 | 3600 | 86400 (demo time skip, not a rule)
//! reset REV
//! ```
//!
//! `REV` is a canonical decimal safe integer (no sign, no leading zero, at
//! most 2^53 - 1). A mutating command must carry the current revision; the
//! revision goes up by one only when the command succeeded (a reset
//! included), never otherwise, and is never reused.

use std::io::{self, BufRead};

use frontier_abi::world_index::economy::Action;

use crate::engine::{ActOutcome, Images, Sandbox, ADVANCE_SECS};

/// Longest accepted line, without its newline. Enforced while reading,
/// before any allocation.
pub const MAX_LINE: usize = 256;
/// The largest JavaScript-safe integer.
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
/// Session bound: the revision never goes past this (a refusal, not a wrap).
pub const MAX_REVISION: u64 = 1_000_000;
/// Transport budget for one Train (not a game rule).
pub const MAX_TRAIN_COUNT: u64 = 1_000;
pub const MAX_ITEM: u64 = 8;
pub const MAX_UNIT: u64 = 6;

pub const PROTOCOL: &str = "wylls-local-economy-v1";
pub const MODE: &str = "local-only";
/// Fixed notice carried by every response.
pub const AUTH: &str = "MOCK_AUTH_NO_SIGNATURE";

// ------------------------------------------------------------ parsing

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Get,
    Reset { rev: u64 },
    Advance { rev: u64, secs: i64 },
    Act { rev: u64, action: Action },
}

/// Canonical decimal: ASCII digits only, no leading zero (except "0"), at
/// most `max_digits` digits, no overflow.
fn number(t: &[u8], max_digits: usize) -> Option<u64> {
    if t.is_empty() || t.len() > max_digits || (t.len() > 1 && t[0] == b'0') {
        return None;
    }
    let mut v: u64 = 0;
    for b in t {
        if !b.is_ascii_digit() {
            return None;
        }
        v = v.checked_mul(10)?.checked_add((b - b'0') as u64)?;
    }
    Some(v)
}

fn revision(t: &[u8]) -> Result<u64, &'static str> {
    number(t, 16)
        .filter(|v| *v <= MAX_SAFE)
        .ok_or("BAD_REVISION")
}

/// Parses one line (without its newline; one trailing CR is tolerated).
/// Rejects extra, missing and malformed fields; the error is a fixed code.
pub fn parse(line: &[u8]) -> Result<Command, &'static str> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.len() > MAX_LINE {
        return Err("LINE_TOO_LONG");
    }
    if line.is_empty() {
        return Err("BAD_COMMAND");
    }
    if !line.iter().all(|b| *b == b' ' || (0x21..=0x7e).contains(b)) {
        return Err("BAD_ENCODING");
    }
    let mut toks: [&[u8]; 5] = [&[]; 5];
    let mut n = 0;
    for t in line.split(|b| *b == b' ') {
        if t.is_empty() || n == toks.len() {
            return Err("BAD_COMMAND");
        }
        toks[n] = t;
        n += 1;
    }
    match (toks[0], n) {
        (b"get", 1) => Ok(Command::Get),
        (b"reset", 2) => Ok(Command::Reset {
            rev: revision(toks[1])?,
        }),
        (b"advance", 3) => {
            let rev = revision(toks[1])?;
            let secs = number(toks[2], 5)
                .and_then(|s| i64::try_from(s).ok())
                .filter(|s| ADVANCE_SECS.contains(s))
                .ok_or("BAD_SECONDS")?;
            Ok(Command::Advance { rev, secs })
        }
        (b"act", 3..=5) => {
            let rev = revision(toks[1])?;
            let action = match (toks[2], n) {
                (b"harvest", 3) => Action::Harvest,
                (b"build", 4) => {
                    let item = number(toks[3], 2)
                        .filter(|v| *v <= MAX_ITEM)
                        .ok_or("BAD_ITEM")?;
                    Action::Build { item: item as u8 }
                }
                (b"train", 5) => {
                    let unit = number(toks[3], 2)
                        .filter(|v| *v <= MAX_UNIT)
                        .ok_or("BAD_UNIT")?;
                    let count = number(toks[4], 4)
                        .filter(|v| (1..=MAX_TRAIN_COUNT).contains(v))
                        .ok_or("BAD_COUNT")?;
                    Action::Train {
                        unit: unit as u8,
                        n: count as u32,
                    }
                }
                _ => return Err("BAD_COMMAND"),
            };
            Ok(Command::Act { rev, action })
        }
        _ => Err("BAD_COMMAND"),
    }
}

// ------------------------------------------------------------ bounded reader

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    /// End of input. A last line without its newline is dropped: a
    /// truncated command must never run.
    Eof,
    /// A complete line of this many bytes is in the buffer.
    Complete(usize),
    /// The line was longer than [`MAX_LINE`]; the rest of it was discarded
    /// without being stored.
    TooLong,
}

/// Reads one line into the fixed buffer. Never stores, and never allocates
/// for, more than [`MAX_LINE`] bytes of a line.
pub fn read_line<R: BufRead>(r: &mut R, buf: &mut [u8; MAX_LINE]) -> io::Result<Line> {
    let mut len = 0usize;
    let mut over = false;
    loop {
        let chunk = match r.fill_buf() {
            Ok(c) => c,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return Ok(Line::Eof);
        }
        let (take, end) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        if !over {
            if len + take <= MAX_LINE {
                buf[len..len + take].copy_from_slice(&chunk[..take]);
                len += take;
            } else {
                over = true;
            }
        }
        r.consume(take + usize::from(end));
        if end {
            return Ok(if over {
                Line::TooLong
            } else {
                Line::Complete(len)
            });
        }
    }
}

// ------------------------------------------------------------ rendering

const HEX: &[u8; 16] = b"0123456789abcdef";

fn push_hex(out: &mut String, b: &[u8]) {
    out.reserve(b.len() * 2 + 2);
    out.push('"');
    for x in b {
        out.push(HEX[(x >> 4) as usize] as char);
        out.push(HEX[(x & 15) as usize] as char);
    }
    out.push('"');
}

/// Fixed strings and codes only: anything outside `[A-Za-z0-9_]` is
/// replaced, so no escaping is ever needed.
fn push_token(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        out.push(if c.is_ascii_alphanumeric() || c == '_' {
            c
        } else {
            '_'
        });
    }
    out.push('"');
}

fn push_opt_token(out: &mut String, s: Option<&str>) {
    match s {
        Some(s) => push_token(out, s),
        None => out.push_str("null"),
    }
}

fn action_name(a: Option<Action>) -> Option<&'static str> {
    match a {
        Some(Action::Harvest) => Some("harvest"),
        Some(Action::Build { .. }) => Some("build"),
        Some(Action::Train { .. }) => Some("train"),
        None => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Ok,
    Refused,
    Fault,
}

impl Status {
    fn name(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Refused => "refused",
            Status::Fault => "fault",
        }
    }
}

/// One compact JSON object, fixed schema, no serializer.
// The fixed wire fields are explicit; no user-selected serialization surface.
#[allow(clippy::too_many_arguments)]
fn render(
    status: Status,
    revision: u64,
    now: i64,
    command: &str,
    action: Option<Action>,
    code: Option<&str>,
    im: &Images,
    record: Option<&[u8]>,
) -> String {
    let mut o = String::with_capacity(
        2 * (im.season.len() + im.citizen.len() + im.holding.len() + im.province.len()) + 512,
    );
    o.push_str("{\"protocol\":\"");
    o.push_str(PROTOCOL);
    o.push_str("\",\"mode\":\"");
    o.push_str(MODE);
    o.push_str("\",\"auth\":\"");
    o.push_str(AUTH);
    o.push_str("\",\"status\":\"");
    o.push_str(status.name());
    o.push_str("\",\"revision\":");
    o.push_str(&revision.to_string());
    o.push_str(",\"now\":\"");
    o.push_str(&now.to_string());
    o.push_str("\",\"command\":");
    push_token(&mut o, command);
    o.push_str(",\"action\":");
    push_opt_token(&mut o, action_name(action));
    o.push_str(",\"code\":");
    push_opt_token(&mut o, code);
    o.push_str(",\"seasonHex\":");
    push_hex(&mut o, &im.season);
    o.push_str(",\"citizenHex\":");
    push_hex(&mut o, &im.citizen);
    o.push_str(",\"holdingHex\":");
    push_hex(&mut o, &im.holding);
    o.push_str(",\"provinceHex\":");
    push_hex(&mut o, &im.province);
    o.push_str(",\"recordHex\":");
    match record {
        Some(r) => push_hex(&mut o, r),
        None => o.push_str("null"),
    }
    o.push('}');
    o
}

// ------------------------------------------------------------ controller

/// The sandbox and its revision: the whole state of one session.
pub struct Controller {
    sandbox: Sandbox,
    revision: u64,
}

impl Controller {
    pub fn new() -> Result<Controller, &'static str> {
        Ok(Controller {
            sandbox: Sandbox::new()?,
            revision: 0,
        })
    }

    #[cfg(test)]
    pub fn with_sandbox(sandbox: Sandbox) -> Controller {
        Controller {
            sandbox,
            revision: 0,
        }
    }

    #[cfg(test)]
    pub fn set_revision_for_test(&mut self, revision: u64) {
        self.revision = revision;
    }

    fn reply(
        &self,
        status: Status,
        command: &str,
        action: Option<Action>,
        code: Option<&str>,
        record: Option<&[u8]>,
    ) -> String {
        render(
            status,
            self.revision,
            self.sandbox.now(),
            command,
            action,
            code,
            self.sandbox.images(),
            record,
        )
    }

    /// The response to a line the reader refused (too long).
    pub fn refuse_line(&self, code: &str) -> String {
        self.reply(Status::Refused, "invalid", None, Some(code), None)
    }

    /// Compare-then-increment gate of every mutating command.
    fn gate(&self, rev: u64) -> Result<(), &'static str> {
        if rev != self.revision {
            return Err("STALE_REVISION");
        }
        if self.revision >= MAX_REVISION {
            return Err("REVISION_LIMIT");
        }
        Ok(())
    }

    /// Runs one command line; the response is exactly one JSON line.
    pub fn handle(&mut self, line: &[u8]) -> String {
        let cmd = match parse(line) {
            Ok(c) => c,
            Err(code) => return self.refuse_line(code),
        };
        match cmd {
            Command::Get => self.reply(Status::Ok, "get", None, None, None),
            Command::Reset { rev } => {
                if let Err(code) = self.gate(rev) {
                    return self.reply(Status::Refused, "reset", None, Some(code), None);
                }
                match self.sandbox.reset() {
                    Ok(()) => {
                        self.revision += 1;
                        self.reply(Status::Ok, "reset", None, None, None)
                    }
                    Err(code) => self.reply(Status::Fault, "reset", None, Some(code), None),
                }
            }
            Command::Advance { rev, secs } => {
                if let Err(code) = self.gate(rev) {
                    return self.reply(Status::Refused, "advance", None, Some(code), None);
                }
                match self.sandbox.advance(secs) {
                    Ok(()) => {
                        self.revision += 1;
                        self.reply(Status::Ok, "advance", None, None, None)
                    }
                    Err(code) => self.reply(Status::Refused, "advance", None, Some(code), None),
                }
            }
            Command::Act { rev, action } => {
                if let Err(code) = self.gate(rev) {
                    return self.reply(Status::Refused, "act", Some(action), Some(code), None);
                }
                match self.sandbox.act(action) {
                    ActOutcome::Done(record) => {
                        self.revision += 1;
                        self.reply(Status::Ok, "act", Some(action), None, Some(&record))
                    }
                    ActOutcome::Refused(code) => {
                        self.reply(Status::Refused, "act", Some(action), Some(&code), None)
                    }
                    ActOutcome::Fault(code) => {
                        self.reply(Status::Fault, "act", Some(action), Some(code), None)
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Images, Sandbox, INITIAL_BELL, INITIAL_NOW};
    use permutation_frontier::layout::player::accrual as AC;
    use permutation_frontier::layout::{holding as H, season as S};
    use permutation_frontier::FrontierError;

    fn fresh() -> Controller {
        Controller::new().unwrap()
    }

    fn has(j: &str, needle: &str) -> bool {
        j.contains(needle)
    }

    /// The text of a string-valued field (`"key":"value"`).
    fn text<'a>(j: &'a str, key: &str) -> &'a str {
        let pat = format!("\"{key}\":\"");
        let at = j.find(&pat).unwrap() + pat.len();
        &j[at..at + j[at..].find('"').unwrap()]
    }

    fn assert_shape(j: &str) {
        assert!(j.starts_with("{\"protocol\":\"wylls-local-economy-v1\",\"mode\":\"local-only\","));
        assert!(j.ends_with('}'));
        assert!(!j.contains(char::is_whitespace), "compact: no whitespace");
        assert!(!j.contains('\n'));
        for k in [
            "\"status\":",
            "\"revision\":",
            "\"now\":\"",
            "\"code\":",
            "\"seasonHex\":\"",
            "\"citizenHex\":\"",
            "\"holdingHex\":\"",
            "\"provinceHex\":\"",
            "\"recordHex\":",
        ] {
            assert!(has(j, k), "missing {k}");
        }
        assert!(j.len() < 64 * 1024, "bounded response: {} bytes", j.len());
    }

    #[test]
    fn parse_accepts_exactly_the_grammar() {
        assert_eq!(parse(b"get"), Ok(Command::Get));
        assert_eq!(parse(b"reset 0"), Ok(Command::Reset { rev: 0 }));
        assert_eq!(parse(b"get\r"), Ok(Command::Get));
        assert_eq!(
            parse(b"act 12 harvest"),
            Ok(Command::Act {
                rev: 12,
                action: Action::Harvest
            })
        );
        assert_eq!(
            parse(b"act 1 build 8"),
            Ok(Command::Act {
                rev: 1,
                action: Action::Build { item: 8 }
            })
        );
        assert_eq!(
            parse(b"act 1 train 6 1000"),
            Ok(Command::Act {
                rev: 1,
                action: Action::Train { unit: 6, n: 1000 }
            })
        );
        for s in [600, 3600, 86400] {
            assert_eq!(
                parse(format!("advance 3 {s}").as_bytes()),
                Ok(Command::Advance { rev: 3, secs: s })
            );
        }
        assert_eq!(
            parse(b"reset 9007199254740991"),
            Ok(Command::Reset { rev: MAX_SAFE })
        );
    }

    #[test]
    fn parse_rejects_malformed_extra_and_overflowing_input() {
        let table: &[(&str, &str)] = &[
            ("", "BAD_COMMAND"),
            (" ", "BAD_COMMAND"),
            ("GET", "BAD_COMMAND"),
            ("get ", "BAD_COMMAND"),
            (" get", "BAD_COMMAND"),
            ("get 0", "BAD_COMMAND"),
            ("get  ", "BAD_COMMAND"),
            ("act  0 harvest", "BAD_COMMAND"),
            ("act\t0 harvest", "BAD_ENCODING"),
            ("act 0 harvest\0", "BAD_ENCODING"),
            ("act 0 harv\u{e9}st", "BAD_ENCODING"),
            ("act 0 harvest extra", "BAD_COMMAND"),
            ("act 0 harvest 1", "BAD_COMMAND"),
            ("act 0", "BAD_COMMAND"),
            ("act", "BAD_COMMAND"),
            ("act 0 sell", "BAD_COMMAND"),
            ("act 0 build", "BAD_COMMAND"),
            ("act 0 build 1 2", "BAD_COMMAND"),
            ("act 0 train 1", "BAD_COMMAND"),
            ("act 0 train 1 2 3", "BAD_COMMAND"),
            ("act -1 harvest", "BAD_REVISION"),
            ("act +1 harvest", "BAD_REVISION"),
            ("act 01 harvest", "BAD_REVISION"),
            ("act 1.0 harvest", "BAD_REVISION"),
            ("act 0x1 harvest", "BAD_REVISION"),
            ("act 9007199254740992 harvest", "BAD_REVISION"),
            ("act 99999999999999999999999 harvest", "BAD_REVISION"),
            ("act 18446744073709551616 harvest", "BAD_REVISION"),
            ("act 0 build 9", "BAD_ITEM"),
            ("act 0 build -1", "BAD_ITEM"),
            ("act 0 build 08", "BAD_ITEM"),
            ("act 0 build 256", "BAD_ITEM"),
            ("act 0 train 7 1", "BAD_UNIT"),
            ("act 0 train x 1", "BAD_UNIT"),
            ("act 0 train 0 0", "BAD_COUNT"),
            ("act 0 train 0 1001", "BAD_COUNT"),
            ("act 0 train 0 4294967296", "BAD_COUNT"),
            ("act 0 train 0 01", "BAD_COUNT"),
            ("advance 0 0", "BAD_SECONDS"),
            ("advance 0 60", "BAD_SECONDS"),
            ("advance 0 7200", "BAD_SECONDS"),
            ("advance 0 86401", "BAD_SECONDS"),
            ("advance 0 -600", "BAD_SECONDS"),
            ("advance 0 0600", "BAD_SECONDS"),
            ("advance 0 99999999999999999999", "BAD_SECONDS"),
            ("advance 0", "BAD_COMMAND"),
            ("reset", "BAD_COMMAND"),
            ("reset 0 0", "BAD_COMMAND"),
            ("reset a", "BAD_REVISION"),
        ];
        for (line, code) in table {
            assert_eq!(parse(line.as_bytes()), Err(*code), "{line:?}");
        }
        assert_eq!(parse(&[b'a'; MAX_LINE + 1]), Err("LINE_TOO_LONG"));
    }

    #[test]
    fn reader_bounds_a_line_before_storing_it() {
        let mut buf = [0u8; MAX_LINE];
        let mut input: &[u8] = b"get\nact 0 harvest\n";
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::Complete(3));
        assert_eq!(&buf[..3], b"get");
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::Complete(13));
        assert_eq!(&buf[..13], &b"act 0 harvest"[..]);
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::Eof);

        // exactly MAX_LINE fits; one more does not, and the next line is intact
        let mut data = vec![b'x'; MAX_LINE];
        data.push(b'\n');
        data.extend_from_slice(&vec![b'y'; MAX_LINE + 1]);
        data.extend_from_slice(b"\nget\n");
        let mut input: &[u8] = &data;
        assert_eq!(
            read_line(&mut input, &mut buf).unwrap(),
            Line::Complete(MAX_LINE)
        );
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::TooLong);
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::Complete(3));

        // a huge line spanning many buffer fills is discarded, not stored
        let big = vec![b'z'; 1 << 20];
        let mut reader =
            io::BufReader::with_capacity(16, io::Cursor::new([big, b"\nget\n".to_vec()].concat()));
        assert_eq!(read_line(&mut reader, &mut buf).unwrap(), Line::TooLong);
        assert_eq!(read_line(&mut reader, &mut buf).unwrap(), Line::Complete(3));

        // EOF mid-line: the truncated command is dropped, never run
        let mut input: &[u8] = b"act 0 train 3 100";
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::Eof);
        let mut input: &[u8] = b"";
        assert_eq!(read_line(&mut input, &mut buf).unwrap(), Line::Eof);
    }

    #[test]
    fn get_has_one_stable_shape_and_changes_nothing() {
        let mut c = fresh();
        let a = c.handle(b"get");
        let b = c.handle(b"get");
        assert_eq!(a, b);
        assert_shape(&a);
        assert_eq!(text(&a, "status"), "ok");
        assert!(has(&a, "\"revision\":0,"));
        assert_eq!(text(&a, "now"), "1800088200");
        assert!(has(&a, "\"code\":null,"));
        assert!(has(&a, "\"recordHex\":null}"));
        assert_eq!(text(&a, "auth"), "MOCK_AUTH_NO_SIGNATURE");
        let orig = Images::original();
        assert_eq!(text(&a, "seasonHex").len(), 2 * orig.season.len());
        assert_eq!(text(&a, "citizenHex").len(), 2 * orig.citizen.len());
        assert_eq!(text(&a, "holdingHex").len(), 2 * orig.holding.len());
        assert_eq!(text(&a, "provinceHex").len(), 2 * orig.province.len());
        assert_eq!(INITIAL_NOW, 1_800_088_200);
        assert_eq!(INITIAL_BELL, 147);
    }

    #[test]
    fn a_success_carries_one_receipt_and_increments_once() {
        let mut c = fresh();
        let r = c.handle(b"act 0 harvest");
        assert_shape(&r);
        assert_eq!(text(&r, "status"), "ok");
        assert!(has(&r, "\"revision\":1,"));
        assert!(has(&r, "\"action\":\"harvest\""));
        assert!(has(&r, "\"code\":null"));
        assert!(!has(&r, "\"recordHex\":null"));
        assert!(!text(&r, "recordHex").is_empty());
        // get / advance / reset carry no new receipt
        assert!(has(&c.handle(b"get"), "\"recordHex\":null}"));
        let adv = c.handle(b"advance 1 600");
        assert_eq!(text(&adv, "status"), "ok");
        assert!(has(&adv, "\"recordHex\":null}"));
        assert!(has(&adv, "\"revision\":2,"));
        assert_eq!(text(&adv, "now"), "1800088800");
        let rst = c.handle(b"reset 2");
        assert!(has(&rst, "\"recordHex\":null}"));
        assert!(has(&rst, "\"revision\":3,"));
    }

    #[test]
    fn stale_and_malformed_requests_change_nothing() {
        let mut c = fresh();
        let before = c.handle(b"get");
        assert_eq!(text(&c.handle(b"act 5 harvest"), "code"), "STALE_REVISION");
        assert_eq!(text(&c.handle(b"advance 1 600"), "code"), "STALE_REVISION");
        assert_eq!(text(&c.handle(b"reset 1"), "code"), "STALE_REVISION");
        for bad in [
            &b"act 0 build 9"[..],
            b"act 0 train 0 0",
            b"nonsense",
            b"act 0",
            b"",
        ] {
            let r = c.handle(bad);
            assert_shape(&r);
            assert_eq!(text(&r, "status"), "refused");
            assert!(has(&r, "\"revision\":0,"));
        }
        assert_eq!(
            c.refuse_line("LINE_TOO_LONG").contains("LINE_TOO_LONG"),
            true
        );
        assert_eq!(
            c.handle(b"get"),
            before,
            "state, time and revision as they were"
        );
        // the revision is not reused: a success at 0 moves it to 1, 0 is stale
        assert_eq!(text(&c.handle(b"act 0 harvest"), "status"), "ok");
        assert_eq!(text(&c.handle(b"act 0 harvest"), "code"), "STALE_REVISION");
    }

    #[test]
    fn a_handler_refusal_leaves_state_revision_and_record_alone() {
        // production settled at the current time, every store emptied: a
        // Build at the same instant cannot be paid
        let mut sb = Sandbox::new().unwrap();
        assert!(matches!(sb.act(Action::Harvest), ActOutcome::Done(_)));
        for r in 0..H::STORES_N {
            let at = H::store(r) + AC::VALUE;
            sb.images_mut().holding[at..at + 8].copy_from_slice(&0i64.to_le_bytes());
        }
        let mut c = Controller::with_sandbox(sb);
        let before = c.handle(b"get");
        let r = c.handle(b"act 0 build 0");
        assert_shape(&r);
        assert_eq!(text(&r, "status"), "refused");
        assert_eq!(
            text(&r, "code"),
            format!("E{}", FrontierError::Insufficient.code())
        );
        assert!(has(&r, "\"recordHex\":null}"));
        assert!(has(&r, "\"revision\":0,"));
        assert_eq!(c.handle(b"get"), before);
        // the same revision is still current and still usable
        assert_eq!(text(&c.handle(b"act 0 harvest"), "status"), "ok");
    }

    #[test]
    fn reset_restores_bytes_but_never_the_revision() {
        let mut c = fresh();
        let original = c.handle(b"get");
        assert_eq!(text(&c.handle(b"act 0 harvest"), "status"), "ok");
        assert_eq!(text(&c.handle(b"act 1 train 0 10"), "status"), "ok");
        assert_eq!(text(&c.handle(b"advance 2 3600"), "status"), "ok");
        let changed = c.handle(b"get");
        assert_ne!(text(&changed, "holdingHex"), text(&original, "holdingHex"));
        let rst = c.handle(b"reset 3");
        assert_eq!(text(&rst, "status"), "ok");
        assert!(has(&rst, "\"revision\":4,"));
        for k in [
            "seasonHex",
            "citizenHex",
            "holdingHex",
            "provinceHex",
            "now",
        ] {
            assert_eq!(text(&rst, k), text(&original, k), "{k}");
        }
        // old revisions stay dead
        assert_eq!(text(&c.handle(b"act 0 harvest"), "code"), "STALE_REVISION");
        assert_eq!(text(&c.handle(b"act 3 harvest"), "code"), "STALE_REVISION");
        assert_eq!(text(&c.handle(b"act 4 harvest"), "status"), "ok");
    }

    #[test]
    fn time_skips_are_bounded_by_the_season_and_change_no_account() {
        let mut im = Images::original();
        im.season[S::END_BELL..S::END_BELL + 4].copy_from_slice(&(INITIAL_BELL + 2).to_le_bytes());
        let mut c = Controller::with_sandbox(Sandbox::from_images(im, INITIAL_NOW).unwrap());
        let before = c.handle(b"get");
        let r = c.handle(b"advance 0 3600");
        assert_eq!(text(&r, "status"), "refused");
        assert_eq!(text(&r, "code"), "TIME_LIMIT");
        assert_eq!(c.handle(b"get"), before);
        let ok = c.handle(b"advance 0 600");
        assert_eq!(text(&ok, "status"), "ok");
        for k in ["seasonHex", "citizenHex", "holdingHex", "provinceHex"] {
            assert_eq!(
                text(&ok, k),
                text(&before, k),
                "{k}: an advance touched an account"
            );
        }
    }

    #[test]
    fn the_revision_is_capped_instead_of_overflowing() {
        let mut c = fresh();
        c.set_revision_for_test(MAX_REVISION);
        for line in [
            &b"act 1000000 harvest"[..],
            b"advance 1000000 600",
            b"reset 1000000",
        ] {
            let r = c.handle(line);
            assert_eq!(text(&r, "status"), "refused");
            assert_eq!(text(&r, "code"), "REVISION_LIMIT");
            assert!(has(&r, "\"revision\":1000000,"));
        }
        assert_eq!(text(&c.handle(b"get"), "status"), "ok");
    }

    #[test]
    fn codes_and_names_are_fixed_tokens() {
        let mut o = String::new();
        push_token(&mut o, "a\"b\\c\nd é");
        assert_eq!(o, "\"a_b_c_d__\"");
        let mut h = String::new();
        push_hex(&mut h, &[0x00, 0x0f, 0xa5, 0xff]);
        assert_eq!(h, "\"000fa5ff\"");
    }
}
