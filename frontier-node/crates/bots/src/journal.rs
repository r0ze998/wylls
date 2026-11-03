//! The bots' marchbook (M1 contract §8.6: "plaintext and salt journalled";
//! §9.1's rule for people: written **before** Depart is signed). One JSON
//! line per event, appended and `fsync`ed, one file per process: a
//! `sealed` line with everything a reveal or a settlement needs, then
//! state lines (`sent`, `failed`, `revealed`, `settled`, …). On restart the
//! file is folded back into each bot's [`Memory`] (the last state wins), so
//! a crash between sealing and sending loses nothing a reveal needs.
//! `k` (the seal key) is never stored; the salt is `salt_of(k)`.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fclient::ix::HoldingRef;
use frontier_agents::obs::{b64, b64_encode};
use frontier_agents::policy::{MarchMemo, SealKind};
use serde_json::{json, Value};

use crate::seal::SealedMarch;

pub struct Journal {
    path: PathBuf,
    file: Mutex<File>,
}

fn kind_name(k: SealKind) -> &'static str {
    match k {
        SealKind::Honest => "honest",
        SealKind::Garbage => "garbage",
        SealKind::BadPlaintext => "bad_plaintext",
    }
}

fn kind_of(s: &str) -> Result<SealKind, String> {
    match s {
        "honest" => Ok(SealKind::Honest),
        "garbage" => Ok(SealKind::Garbage),
        "bad_plaintext" => Ok(SealKind::BadPlaintext),
        _ => Err(format!("unknown seal kind {s}")),
    }
}

impl Journal {
    /// Start a fresh bot run without appending to an older marchbook. Its
    /// march rows alone cannot restore pace, joins or AI decisions.
    pub fn create_new(path: impl AsRef<Path>) -> std::io::Result<Journal> {
        let path = path.as_ref().to_path_buf();
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&path)?;
        Ok(Journal {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Journal> {
        let path = path.as_ref().to_path_buf();
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Journal {
            path,
            file: Mutex::new(file),
        })
    }

    /// Open an already existing marchbook without creating an empty
    /// replacement. This checks its recorded rows before any bot can run;
    /// it does not restore AI decisions outside the marchbook.
    pub fn open_existing(path: impl AsRef<Path>) -> std::io::Result<Journal> {
        let path = path.as_ref().to_path_buf();
        if !std::fs::symlink_metadata(&path)?.file_type().is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "marchbook is not a regular file",
            ));
        }
        Self::load(&path)?;
        let file = OpenOptions::new().append(true).open(&path)?;
        Ok(Journal {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn append(&self, v: &Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(v).map_err(std::io::Error::other)?;
        line.push(b'\n');
        let mut f = self.file.lock().expect("journal lock");
        f.write_all(&line)?;
        f.sync_data()
    }

    /// The sealed march, before its Depart is signed.
    #[allow(clippy::too_many_arguments)]
    pub fn sealed(&self, bot: u32, m: &MarchMemo, s: &SealedMarch) -> std::io::Result<()> {
        self.append(&json!({
            "ev": "sealed",
            "bot": bot,
            "host": m.key.0.to_string(),
            "depart_bell": m.key.1,
            "holding": [m.h.p, m.h.q, m.h.site],
            "transit_slot": m.transit_slot,
            "arrive_bell": m.arrive_bell,
            "dest": [m.dest.0, m.dest.1],
            "path_others": m.path_others.iter().map(|p| json!([p.0, p.1])).collect::<Vec<_>>(),
            "round": s.round,
            "plain_b64": b64_encode(&s.plain),
            "salt_b64": b64_encode(&s.salt),
            "commit_hex": hex::encode(s.commit),
            "seal_b64": b64_encode(&s.seal),
            "ct_hash_hex": hex::encode(s.ct_hash),
            "tip": m.tip.to_string(),
            "kind": kind_name(m.kind),
        }))
    }

    /// A state change of a march (`sent`, `failed`, `revealed`, `reveal_try`,
    /// `late_done`, `settled`, `redeparted`). W6T-3: `revealed` means a
    /// REVEAL was observed; the relay's 2xx is `accepted` ([`Journal::state_with`]).
    pub fn state(&self, bot: u32, key: (u64, u32), state: &str) -> std::io::Result<()> {
        self.append(&json!({
            "ev": state,
            "bot": bot,
            "host": key.0.to_string(),
            "depart_bell": key.1,
        }))
    }

    /// A state change with the route and the refusal code (W6T-3:
    /// `accepted`, `reveal_refused`).
    pub fn state_with(
        &self,
        bot: u32,
        key: (u64, u32),
        state: &str,
        route: &str,
        code: Option<&str>,
    ) -> std::io::Result<()> {
        self.append(&json!({
            "ev": state,
            "bot": bot,
            "host": key.0.to_string(),
            "depart_bell": key.1,
            "route": route,
            "code": code,
        }))
    }

    /// Folds the journal back into per-bot marches.
    pub fn load(path: impl AsRef<Path>) -> std::io::Result<BTreeMap<u32, Vec<MarchMemo>>> {
        let mut out: BTreeMap<u32, Vec<MarchMemo>> = BTreeMap::new();
        let mut f = File::open(path)?;
        if f.metadata()?.len() > 0 {
            f.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            f.read_exact(&mut last)?;
            if last[0] != b'\n' {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "marchbook ends without a complete line",
                ));
            }
            f.seek(SeekFrom::Start(0))?;
        }
        for (index, line) in BufReader::new(f).lines().enumerate() {
            let line = line?;
            // A torn final line may be harmless, but the journal cannot
            // prove that it preceded an external send. Refuse rather than
            // silently erase a pending reveal or a sent state.
            let v = serde_json::from_str::<Value>(&line).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("marchbook line {}: {e}", index + 1),
                )
            })?;
            apply(&mut out, &v).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("marchbook line {}: {e}", index + 1),
                )
            })?;
        }
        Ok(out)
    }
}

fn get_u64(v: &Value, k: &str) -> Option<u64> {
    let x = v.get(k)?;
    x.as_u64().or_else(|| x.as_str()?.parse().ok())
}

fn arr<const N: usize>(v: &Value, k: &str, hexed: bool) -> Option<[u8; N]> {
    let s = v.get(k)?.as_str()?;
    let b = if hexed {
        hex::decode(s).ok()?
    } else {
        b64(s).ok()?
    };
    b.try_into().ok()
}

fn required_u64(v: &Value, field: &str) -> Result<u64, String> {
    get_u64(v, field).ok_or_else(|| format!("invalid {field}"))
}

fn required_number<T: TryFrom<u64>>(v: &Value, field: &str) -> Result<T, String> {
    required_u64(v, field)?
        .try_into()
        .map_err(|_| format!("out-of-range {field}"))
}

fn required_unsigned<T: TryFrom<u64>>(v: &Value, field: &str) -> Result<T, String> {
    v.as_u64()
        .ok_or_else(|| format!("invalid {field}"))?
        .try_into()
        .map_err(|_| format!("out-of-range {field}"))
}

fn required_signed<T: TryFrom<i64>>(v: &Value, field: &str) -> Result<T, String> {
    v.as_i64()
        .ok_or_else(|| format!("invalid {field}"))?
        .try_into()
        .map_err(|_| format!("out-of-range {field}"))
}

fn required_array<'a>(v: &'a Value, field: &str, length: usize) -> Result<&'a [Value], String> {
    let values = v
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("invalid {field}"))?;
    if values.len() != length {
        return Err(format!("invalid {field} length"));
    }
    Ok(values)
}

fn required_bytes<const N: usize>(v: &Value, field: &str, hexed: bool) -> Result<[u8; N], String> {
    arr(v, field, hexed).ok_or_else(|| format!("invalid {field}"))
}

fn apply(out: &mut BTreeMap<u32, Vec<MarchMemo>>, v: &Value) -> Result<(), String> {
    let bot: u32 = required_number(v, "bot")?;
    let key = (required_u64(v, "host")?, required_number(v, "depart_bell")?);
    let ev = v.get("ev").and_then(Value::as_str).ok_or("invalid ev")?;
    let list = out.entry(bot).or_default();
    if ev == "sealed" {
        let h = required_array(v, "holding", 3)?;
        let d = required_array(v, "dest", 2)?;
        let _: u64 = required_number(v, "round")?;
        let seal = b64(v
            .get("seal_b64")
            .and_then(Value::as_str)
            .ok_or("invalid seal_b64")?)
        .map_err(|_| "invalid seal_b64")?;
        if seal.len() != fclient::seal::SEAL_LEN {
            return Err("invalid seal_b64 length".into());
        }
        let path_others = v
            .get("path_others")
            .and_then(Value::as_array)
            .ok_or("invalid path_others")?
            .iter()
            .map(|p| {
                let pair = p.as_array().ok_or("invalid path_others coordinate")?;
                if pair.len() != 2 {
                    return Err("invalid path_others coordinate length".into());
                }
                Ok((
                    required_signed(&pair[0], "path_others p")?,
                    required_signed(&pair[1], "path_others q")?,
                ))
            })
            .collect::<Result<Vec<(i32, i32)>, String>>()?;
        let memo = MarchMemo {
            key,
            h: HoldingRef {
                p: required_signed(&h[0], "holding p")?,
                q: required_signed(&h[1], "holding q")?,
                site: required_unsigned(&h[2], "holding site")?,
            },
            transit_slot: required_number(v, "transit_slot")?,
            arrive_bell: required_number(v, "arrive_bell")?,
            dest: (
                required_signed(&d[0], "dest p")?,
                required_signed(&d[1], "dest q")?,
            ),
            path_others,
            plain: required_bytes(v, "plain_b64", false)?,
            salt: required_bytes(v, "salt_b64", false)?,
            commit: required_bytes(v, "commit_hex", true)?,
            seal,
            ct_hash: required_bytes(v, "ct_hash_hex", true)?,
            tip: required_u64(v, "tip")?,
            kind: kind_of(
                v.get("kind")
                    .and_then(Value::as_str)
                    .ok_or("invalid kind")?,
            )?,
            sent: false,
            reveal_tries: 0,
            revealed: false,
            accepted: false,
            last_code: None,
            late_done: false,
            settled: false,
            redeparted: false,
        };
        if list.iter().any(|m| m.key == key) {
            return Err("duplicate sealed march".into());
        }
        list.push(memo);
        return Ok(());
    }
    let m = list
        .iter_mut()
        .find(|m| m.key == key)
        .ok_or("state for unknown march")?;
    match ev {
        // The signed Depart may have reached the relay. Keep the sealed
        // memo unresolved; `sent` requires chain evidence, not a timeout.
        "send_unknown" => {}
        "sent" => m.sent = true,
        "failed" => {
            list.retain(|m| m.key != key);
        }
        "reveal_try" => m.reveal_tries = m.reveal_tries.saturating_add(1),
        "revealed" => m.revealed = true,
        "accepted" => m.accepted = true,
        "reveal_refused" => m.last_code = v.get("code").and_then(|c| c.as_str()).map(String::from),
        "late_done" => m.late_done = true,
        "settled" => m.settled = true,
        "redeparted" => m.redeparted = true,
        _ => return Err(format!("unknown march state {ev}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo() -> (MarchMemo, SealedMarch) {
        let s = SealedMarch {
            plain: [1; 37],
            salt: [2; 32],
            commit: [3; 32],
            seal: [4; 165],
            ct_hash: [5; 32],
            seal_root: [6; 32],
            round: 99,
        };
        let m = MarchMemo {
            key: (1 << 40 | 7, 40),
            h: HoldingRef {
                p: 2,
                q: -1,
                site: 3,
            },
            transit_slot: 1,
            arrive_bell: 44,
            dest: (3, -1),
            path_others: vec![(2, -1)],
            plain: s.plain,
            salt: s.salt,
            commit: s.commit,
            seal: s.seal.to_vec(),
            ct_hash: s.ct_hash,
            tip: 12_345,
            kind: SealKind::Garbage,
            sent: false,
            reveal_tries: 0,
            revealed: false,
            accepted: false,
            last_code: None,
            late_done: false,
            settled: false,
            redeparted: false,
        };
        (m, s)
    }

    #[test]
    fn round_trips_and_folds_states() {
        let dir = std::env::temp_dir().join(format!("w3e-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("marchbook.jsonl");
        let j = Journal::open(&p).unwrap();
        assert_eq!(
            Journal::create_new(&p).err().unwrap().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        let (m, s) = memo();
        j.sealed(5, &m, &s).unwrap();
        // Nothing but the sealed line: the march is known, not sent.
        let got = Journal::load(&p).unwrap();
        assert_eq!(got[&5], vec![m.clone()]);
        j.state(5, m.key, "send_unknown").unwrap();
        let got = Journal::load(&p).unwrap();
        assert_eq!(got[&5], vec![m.clone()], "unknown is not a landed Depart");
        j.state(5, m.key, "sent").unwrap();
        j.state(5, m.key, "reveal_try").unwrap();
        j.state_with(5, m.key, "reveal_refused", "keeper", Some("Shielded"))
            .unwrap();
        j.state_with(5, m.key, "accepted", "keeper", None).unwrap();
        j.state(5, m.key, "revealed").unwrap();
        // A second march that failed disappears.
        let mut m2 = m.clone();
        m2.key.1 = 41;
        j.sealed(5, &m2, &s).unwrap();
        j.state(5, m2.key, "failed").unwrap();
        let got = Journal::load(&p).unwrap();
        let want = MarchMemo {
            sent: true,
            reveal_tries: 1,
            revealed: true,
            accepted: true,
            last_code: Some("Shielded".into()),
            ..m
        };
        assert_eq!(got[&5], vec![want]);
        let original = std::fs::read_to_string(&p).unwrap();
        // The final state may have been lost after an external send, so a
        // torn line cannot be silently skipped during recovery.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&p)
            .unwrap()
            .write_all(b"{\"ev\":\"sen")
            .unwrap();
        assert_eq!(
            Journal::load(&p).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        // A complete JSON object with only its final newline torn off is
        // still an incomplete append, even if a parser can read the object.
        std::fs::write(&p, original.trim_end_matches('\n')).unwrap();
        assert_eq!(
            Journal::load(&p).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_marchbook_refuses_missing_torn_unknown_and_out_of_range_rows() {
        let dir = std::env::temp_dir().join(format!("bots-strict-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("marchbook.jsonl");
        assert_eq!(
            Journal::open_existing(&p).err().unwrap().kind(),
            std::io::ErrorKind::NotFound
        );
        let j = Journal::open(&p).unwrap();
        let (m, s) = memo();
        j.sealed(5, &m, &s).unwrap();
        let original = std::fs::read_to_string(&p).unwrap();
        let base: Value = serde_json::from_str(original.trim()).unwrap();
        assert!(Journal::open_existing(&p).is_ok());

        for (field, bad) in [
            ("bot", json!(u64::from(u32::MAX) + 1)),
            ("depart_bell", json!(u64::from(u32::MAX) + 1)),
            ("kind", json!("unknown")),
            ("round", json!("not-a-round")),
            ("holding", json!([i64::from(i16::MAX) + 1, 0, 0])),
            ("path_others", json!([[0, 0], [i64::from(i32::MAX) + 1, 0]])),
        ] {
            let mut row = base.clone();
            row[field] = bad;
            std::fs::write(&p, format!("{row}\n")).unwrap();
            assert_eq!(
                Journal::load(&p).unwrap_err().kind(),
                std::io::ErrorKind::InvalidData,
                "{field}"
            );
        }
        let unknown_state =
            json!({"ev":"not-a-state", "bot":5, "host":m.key.0.to_string(), "depart_bell":m.key.1});
        std::fs::write(&p, format!("{original}{unknown_state}\n")).unwrap();
        assert_eq!(
            Journal::load(&p).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        let lost_sealed =
            json!({"ev":"sent", "bot":5, "host":m.key.0.to_string(), "depart_bell":m.key.1});
        std::fs::write(&p, format!("{lost_sealed}\n")).unwrap();
        assert_eq!(
            Journal::load(&p).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
        std::fs::write(&p, original).unwrap();
        assert!(Journal::open_existing(&p).is_ok());
        drop(j);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
