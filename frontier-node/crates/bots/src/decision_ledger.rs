//! Durable, single-process record of bot decisions and attempted sends.
//!
//! This is a fail-closed building block, not a bot resume protocol. It has no
//! independent rollback witness, cannot establish chain finality, and cannot
//! restore Pace/AI/Conquest memory. In particular, loading it must not enable
//! `frontier-stack resume` or reuse an old marchbook.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub run_id: String,
    pub world_id: String,
    pub source_digest: String,
    pub roster_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionId {
    pub bot: u32,
    pub seq: u64,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionId {
    pub bot: u32,
    pub seq: u64,
    pub ordinal: u32,
    pub id: String,
    pub intent_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Audit {
    pub header: Header,
    pub decisions: usize,
    pub actions: usize,
    /// ACK is not chain finality. Every action remains unresolved here.
    pub unresolved_actions: usize,
    pub last_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SendState {
    Planned,
    Prepared { route: String, wire_sha256: String },
    MayHaveSent { route: String, wire_sha256: String },
    Ack { route: String, wire_sha256: String },
    Unknown { route: String, wire_sha256: String },
}

#[derive(Clone, Debug)]
struct Action {
    id: ActionId,
    state: SendState,
}

#[derive(Clone, Debug, Default)]
struct State {
    header: Option<Header>,
    last_hash: [u8; 32],
    last_seq: BTreeMap<u32, u64>,
    decisions: BTreeMap<(u32, u64), String>,
    actions: BTreeMap<(u32, u64, u32), Action>,
}

struct Inner {
    file: File,
    state: State,
    poisoned: bool,
    #[cfg(test)]
    fail_after_write: bool,
}

pub struct DecisionLedger {
    path: PathBuf,
    inner: Mutex<Inner>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn event_hash(previous: &[u8; 32], event: &Value) -> io::Result<[u8; 32]> {
    let mut digest = Sha256::new();
    digest.update(previous);
    digest.update(serde_json::to_vec(event)?);
    Ok(digest.finalize().into())
}

fn stable_id(domain: &[u8], parts: &Value) -> io::Result<String> {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update(serde_json::to_vec(parts)?);
    Ok(hex::encode(digest.finalize()))
}

fn decision_id(header: &Header, bot: u32, seq: u64) -> io::Result<String> {
    stable_id(
        b"wylls.bot.decision.v1\0",
        &json!([
            header.run_id,
            header.world_id,
            header.source_digest,
            header.roster_digest,
            bot,
            seq
        ]),
    )
}

fn action_id(header: &Header, bot: u32, seq: u64, ordinal: u32) -> io::Result<String> {
    stable_id(
        b"wylls.bot.action.v1\0",
        &json!([
            header.run_id,
            header.world_id,
            header.source_digest,
            header.roster_digest,
            bot,
            seq,
            ordinal
        ]),
    )
}

fn string<'a>(v: &'a Value, field: &str) -> io::Result<&'a str> {
    v.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("missing or invalid {field}")))
}

fn number(v: &Value, field: &str) -> io::Result<u64> {
    v.get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(format!("missing or invalid {field}")))
}

fn u32_number(v: &Value, field: &str) -> io::Result<u32> {
    number(v, field)?
        .try_into()
        .map_err(|_| invalid(format!("out-of-range {field}")))
}

fn exact_fields(v: &Value, fields: &[&str]) -> io::Result<()> {
    let Some(obj) = v.as_object() else {
        return Err(invalid("ledger event is not an object"));
    };
    if obj.len() != fields.len() || fields.iter().any(|field| !obj.contains_key(*field)) {
        return Err(invalid("ledger event has missing or unknown fields"));
    }
    Ok(())
}

fn digest_hex(value: &str, field: &str) -> io::Result<()> {
    let decoded = hex::decode(value).map_err(|_| invalid(format!("invalid {field}")))?;
    if decoded.len() != 32 || value != hex::encode(decoded) {
        return Err(invalid(format!("invalid {field}")));
    }
    Ok(())
}

fn header_of(state: &State) -> io::Result<&Header> {
    state
        .header
        .as_ref()
        .ok_or_else(|| invalid("missing header"))
}

fn action_key(v: &Value) -> io::Result<(u32, u64, u32)> {
    Ok((
        u32_number(v, "bot")?,
        number(v, "seq")?,
        u32_number(v, "ordinal")?,
    ))
}

fn existing_action<'a>(state: &'a mut State, v: &Value) -> io::Result<&'a mut Action> {
    let key = action_key(v)?;
    let action = state
        .actions
        .get_mut(&key)
        .ok_or_else(|| invalid("action has no intent"))?;
    if string(v, "id")? != action.id.id {
        return Err(invalid("action ID mismatch"));
    }
    Ok(action)
}

fn apply(state: &mut State, v: &Value) -> io::Result<()> {
    match string(v, "ev")? {
        "header" => {
            exact_fields(
                v,
                &[
                    "ev",
                    "version",
                    "run_id",
                    "world_id",
                    "source_digest",
                    "roster_digest",
                ],
            )?;
            if state.header.is_some() || number(v, "version")? != VERSION {
                return Err(invalid("duplicate header or unknown ledger version"));
            }
            let header = Header {
                run_id: string(v, "run_id")?.to_owned(),
                world_id: string(v, "world_id")?.to_owned(),
                source_digest: string(v, "source_digest")?.to_owned(),
                roster_digest: string(v, "roster_digest")?.to_owned(),
            };
            if header.run_id.is_empty() || header.world_id.is_empty() {
                return Err(invalid("empty run or world ID"));
            }
            digest_hex(&header.source_digest, "source_digest")?;
            digest_hex(&header.roster_digest, "roster_digest")?;
            state.header = Some(header);
        }
        "decision" => {
            exact_fields(v, &["ev", "bot", "seq", "id", "bell", "context"])?;
            let header = header_of(state)?;
            let bot = u32_number(v, "bot")?;
            let seq = number(v, "seq")?;
            let _bell = u32_number(v, "bell")?;
            if seq == 0
                || state
                    .last_seq
                    .get(&bot)
                    .copied()
                    .unwrap_or(0)
                    .checked_add(1)
                    != Some(seq)
            {
                return Err(invalid("decision sequence is not contiguous"));
            }
            let expected = decision_id(header, bot, seq)?;
            if string(v, "id")? != expected || v.get("context").is_none_or(Value::is_null) {
                return Err(invalid("decision ID or context mismatch"));
            }
            state.last_seq.insert(bot, seq);
            state.decisions.insert((bot, seq), expected);
        }
        "intent" => {
            exact_fields(
                v,
                &[
                    "ev",
                    "bot",
                    "seq",
                    "ordinal",
                    "id",
                    "intent_hex",
                    "intent_sha256",
                ],
            )?;
            let header = header_of(state)?;
            let key = action_key(v)?;
            if !state.decisions.contains_key(&(key.0, key.1)) || state.actions.contains_key(&key) {
                return Err(invalid("intent has no decision or repeats an ordinal"));
            }
            let id = action_id(header, key.0, key.1, key.2)?;
            let bytes =
                hex::decode(string(v, "intent_hex")?).map_err(|_| invalid("invalid intent_hex"))?;
            let intent_sha256 = hex::encode(sha(&bytes));
            if string(v, "id")? != id || string(v, "intent_sha256")? != intent_sha256 {
                return Err(invalid("intent ID or digest mismatch"));
            }
            state.actions.insert(
                key,
                Action {
                    id: ActionId {
                        bot: key.0,
                        seq: key.1,
                        ordinal: key.2,
                        id,
                        intent_sha256,
                    },
                    state: SendState::Planned,
                },
            );
        }
        "prepared" => {
            exact_fields(
                v,
                &[
                    "ev",
                    "bot",
                    "seq",
                    "ordinal",
                    "id",
                    "route",
                    "wire_hex",
                    "wire_sha256",
                ],
            )?;
            let action = existing_action(state, v)?;
            if action.state != SendState::Planned {
                return Err(invalid("wire already prepared or sent"));
            }
            let route = string(v, "route")?;
            if route.is_empty() {
                return Err(invalid("empty route"));
            }
            let bytes =
                hex::decode(string(v, "wire_hex")?).map_err(|_| invalid("invalid wire_hex"))?;
            if bytes.is_empty() || string(v, "wire_sha256")? != hex::encode(sha(&bytes)) {
                return Err(invalid("wire is empty or digest mismatched"));
            }
            action.state = SendState::Prepared {
                route: route.to_owned(),
                wire_sha256: hex::encode(sha(&bytes)),
            };
        }
        "may_have_sent" => {
            exact_fields(v, &["ev", "bot", "seq", "ordinal", "id"])?;
            let action = existing_action(state, v)?;
            let SendState::Prepared { route, wire_sha256 } = &action.state else {
                return Err(invalid("action was not prepared"));
            };
            action.state = SendState::MayHaveSent {
                route: route.clone(),
                wire_sha256: wire_sha256.clone(),
            };
        }
        "ack" | "unknown" => {
            exact_fields(v, &["ev", "bot", "seq", "ordinal", "id", "signature"])?;
            let outcome = string(v, "ev")?;
            let _signature = v
                .get("signature")
                .and_then(|x| {
                    x.as_str()
                        .map(str::to_owned)
                        .or_else(|| x.is_null().then(String::new))
                })
                .ok_or_else(|| invalid("invalid signature"))?;
            let action = existing_action(state, v)?;
            let SendState::MayHaveSent { route, wire_sha256 } = &action.state else {
                return Err(invalid("outcome without a send attempt"));
            };
            action.state = if outcome == "ack" {
                SendState::Ack {
                    route: route.clone(),
                    wire_sha256: wire_sha256.clone(),
                }
            } else {
                SendState::Unknown {
                    route: route.clone(),
                    wire_sha256: wire_sha256.clone(),
                }
            };
        }
        _ => return Err(invalid("unknown ledger event")),
    }
    Ok(())
}

fn chained(state: &mut State, row: &Value) -> io::Result<()> {
    exact_fields(row, &["prev", "hash", "event"])?;
    let previous = string(row, "prev")?;
    let hash = string(row, "hash")?;
    if previous != hex::encode(state.last_hash) {
        return Err(invalid("ledger hash chain is broken"));
    }
    digest_hex(hash, "hash")?;
    let event = row.get("event").ok_or_else(|| invalid("missing event"))?;
    let expected = event_hash(&state.last_hash, event)?;
    if hash != hex::encode(expected) {
        return Err(invalid("ledger event hash mismatch"));
    }
    apply(state, event)?;
    state.last_hash = expected;
    Ok(())
}

impl DecisionLedger {
    /// Create a private, new-only ledger. Existing ledgers are never reopened
    /// for append because the full bot state is not yet restorable.
    pub fn create_new(path: impl AsRef<Path>, header: Header) -> io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)?;
        let mut options = OpenOptions::new();
        options.create_new(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        File::open(parent)?.sync_all()?;
        let ledger = Self {
            path,
            inner: Mutex::new(Inner {
                file,
                state: State::default(),
                poisoned: false,
                #[cfg(test)]
                fail_after_write: false,
            }),
        };
        ledger.append(json!({
            "ev":"header", "version":VERSION, "run_id":header.run_id,
            "world_id":header.world_id, "source_digest":header.source_digest,
            "roster_digest":header.roster_digest,
        }))?;
        Ok(ledger)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Identity of the new-only ledger, for comparison with the observed
    /// program and world before a bot is allowed to record or send actions.
    pub fn header(&self) -> io::Result<Header> {
        let inner = self.inner.lock().expect("decision ledger mutex");
        if inner.poisoned {
            return Err(invalid("decision ledger is poisoned after a write failure"));
        }
        Ok(header_of(&inner.state)?.clone())
    }

    fn append(&self, event: Value) -> io::Result<()> {
        let mut inner = self.inner.lock().expect("decision ledger mutex");
        if inner.poisoned {
            return Err(invalid("decision ledger is poisoned after a write failure"));
        }
        let mut next = inner.state.clone();
        apply(&mut next, &event)?;
        let hash = event_hash(&inner.state.last_hash, &event)?;
        let row = json!({"prev":hex::encode(inner.state.last_hash), "hash":hex::encode(hash), "event":event});
        let mut bytes = serde_json::to_vec(&row)?;
        bytes.push(b'\n');
        if let Err(error) = inner.file.write_all(&bytes) {
            inner.poisoned = true;
            return Err(error);
        }
        #[cfg(test)]
        if inner.fail_after_write {
            inner.poisoned = true;
            return Err(io::Error::other("injected sync failure"));
        }
        if let Err(error) = inner.file.sync_data() {
            inner.poisoned = true;
            return Err(error);
        }
        next.last_hash = hash;
        inner.state = next;
        Ok(())
    }

    /// Persist a new decision number and its immutable input context before
    /// acting. The caller must include the full planned candidates and any AI
    /// answer required to reproduce the decision; this API cannot infer them.
    pub fn begin_decision(&self, bot: u32, bell: u32, context: Value) -> io::Result<DecisionId> {
        if context.is_null() {
            return Err(invalid("decision context cannot be null"));
        }
        let (header, seq) = {
            let inner = self.inner.lock().expect("decision ledger mutex");
            let header = header_of(&inner.state)?.clone();
            let seq = inner
                .state
                .last_seq
                .get(&bot)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| invalid("decision sequence exhausted"))?;
            (header, seq)
        };
        let id = decision_id(&header, bot, seq)?;
        self.append(
            json!({"ev":"decision", "bot":bot, "seq":seq, "id":id, "bell":bell, "context":context}),
        )?;
        Ok(DecisionId { bot, seq, id })
    }

    /// Persist the ordinal and exact version-bound intent bytes. This is not
    /// yet permission to send: `prepare_wire` and `mark_may_have_sent` follow.
    pub fn record_intent(
        &self,
        decision: &DecisionId,
        ordinal: u32,
        intent: &[u8],
    ) -> io::Result<ActionId> {
        if intent.is_empty() {
            return Err(invalid("empty intent"));
        }
        {
            let inner = self.inner.lock().expect("decision ledger mutex");
            if inner.state.decisions.get(&(decision.bot, decision.seq)) != Some(&decision.id) {
                return Err(invalid("decision ID mismatch"));
            }
        }
        let header = {
            let inner = self.inner.lock().expect("decision ledger mutex");
            header_of(&inner.state)?.clone()
        };
        let id = action_id(&header, decision.bot, decision.seq, ordinal)?;
        let intent_sha256 = hex::encode(sha(intent));
        self.append(json!({"ev":"intent", "bot":decision.bot, "seq":decision.seq,
            "ordinal":ordinal, "id":id, "intent_hex":hex::encode(intent), "intent_sha256":intent_sha256}))?;
        Ok(ActionId {
            bot: decision.bot,
            seq: decision.seq,
            ordinal,
            id,
            intent_sha256,
        })
    }

    fn require_action(&self, action: &ActionId) -> io::Result<()> {
        let inner = self.inner.lock().expect("decision ledger mutex");
        let Some(existing) = inner
            .state
            .actions
            .get(&(action.bot, action.seq, action.ordinal))
        else {
            return Err(invalid("unknown action"));
        };
        if existing.id != *action {
            return Err(invalid("action ID mismatch"));
        }
        Ok(())
    }

    /// Save the exact signed wire/request bytes before any external send.
    /// The file is private because the request may contain sensitive material.
    pub fn prepare_wire(&self, action: &ActionId, route: &str, payload: &[u8]) -> io::Result<()> {
        self.require_action(action)?;
        if route.is_empty() || payload.is_empty() {
            return Err(invalid("empty route or payload"));
        }
        self.append(json!({"ev":"prepared", "bot":action.bot, "seq":action.seq,
            "ordinal":action.ordinal, "id":action.id, "route":route,
            "wire_hex":hex::encode(payload), "wire_sha256":hex::encode(sha(payload))}))
    }

    /// Must be durable immediately before the RPC/HTTP call. Even if the
    /// process dies before calling it, recovery must treat this as unknown.
    pub fn mark_may_have_sent(&self, action: &ActionId) -> io::Result<()> {
        self.require_action(action)?;
        self.append(json!({"ev":"may_have_sent", "bot":action.bot,
            "seq":action.seq, "ordinal":action.ordinal, "id":action.id}))
    }

    /// A transport ACK is not finalized chain success. No terminal/finalized
    /// transition exists until a future reconciliation protocol is verified.
    pub fn note_ack(&self, action: &ActionId, signature: Option<&str>) -> io::Result<()> {
        self.require_action(action)?;
        self.append(json!({"ev":"ack", "bot":action.bot, "seq":action.seq,
            "ordinal":action.ordinal, "id":action.id, "signature":signature}))
    }

    pub fn note_unknown(&self, action: &ActionId) -> io::Result<()> {
        self.require_action(action)?;
        self.append(json!({"ev":"unknown", "bot":action.bot, "seq":action.seq,
            "ordinal":action.ordinal, "id":action.id, "signature":null}))
    }

    /// Read-only validation. It never permits append or automatic resume.
    pub fn inspect(path: impl AsRef<Path>) -> io::Result<Audit> {
        let path = path.as_ref();
        let meta = std::fs::symlink_metadata(path)?;
        if !meta.file_type().is_file() {
            return Err(invalid("ledger is not a regular file"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(invalid("ledger permissions expose signed requests"));
            }
        }
        let mut f = File::open(path)?;
        if f.metadata()?.len() == 0 {
            return Err(invalid("empty ledger"));
        }
        f.seek(SeekFrom::End(-1))?;
        let mut tail = [0];
        f.read_exact(&mut tail)?;
        if tail[0] != b'\n' {
            return Err(invalid("ledger ends with a partial line"));
        }
        f.seek(SeekFrom::Start(0))?;
        let mut state = State::default();
        for (line, row) in BufReader::new(f).lines().enumerate() {
            let row = row?;
            let parsed: Value = serde_json::from_str(&row)
                .map_err(|e| invalid(format!("ledger line {}: {e}", line + 1)))?;
            chained(&mut state, &parsed)
                .map_err(|e| invalid(format!("ledger line {}: {e}", line + 1)))?;
        }
        let header = header_of(&state)?.clone();
        Ok(Audit {
            header,
            decisions: state.decisions.len(),
            actions: state.actions.len(),
            unresolved_actions: state.actions.len(),
            last_hash: hex::encode(state.last_hash),
        })
    }

    /// A reader must compare the complete source/roster identity; matching
    /// just the run ID is insufficient to replay version-bound intent bytes.
    pub fn inspect_expected(path: impl AsRef<Path>, expected: &Header) -> io::Result<Audit> {
        let audit = Self::inspect(path)?;
        if &audit.header != expected {
            return Err(invalid("ledger run, world, source, or roster mismatch"));
        }
        Ok(audit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn temp_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wylls-bot-ledger-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir(&dir).unwrap();
        dir.join("decision.jsonl")
    }

    fn header() -> Header {
        Header {
            run_id: "run-1".into(),
            world_id: "world-1".into(),
            source_digest: "a".repeat(64),
            roster_digest: "b".repeat(64),
        }
    }

    fn create() -> DecisionLedger {
        DecisionLedger::create_new(temp_path(), header()).unwrap()
    }

    #[test]
    fn stable_ids_distinguish_same_bell_repeats_and_identical_intents() {
        let ledger = create();
        let d1 = ledger
            .begin_decision(4, 17, json!({"observation":"a","intents":["Spam","Spam"]}))
            .unwrap();
        let a1 = ledger.record_intent(&d1, 0, b"Spam").unwrap();
        let a2 = ledger.record_intent(&d1, 1, b"Spam").unwrap();
        let d2 = ledger
            .begin_decision(4, 17, json!({"observation":"b"}))
            .unwrap();
        let a3 = ledger.record_intent(&d2, 0, b"Spam").unwrap();
        let d_other = ledger
            .begin_decision(5, 17, json!({"observation":"a"}))
            .unwrap();
        let a_other = ledger.record_intent(&d_other, 0, b"Spam").unwrap();
        assert_eq!((d1.seq, d2.seq, d_other.seq), (1, 2, 1));
        assert_ne!(a1.id, a2.id);
        assert_ne!(a1.id, a3.id);
        assert_ne!(a1.id, a_other.id);
        assert_eq!(
            DecisionLedger::inspect_expected(ledger.path(), &header())
                .unwrap()
                .actions,
            4
        );
    }

    #[test]
    fn wire_is_saved_before_a_send_can_be_marked_and_ack_is_unresolved() {
        let ledger = create();
        let d = ledger
            .begin_decision(2, 9, json!({"observation":"fixed"}))
            .unwrap();
        let action = ledger.record_intent(&d, 0, b"Harvest").unwrap();
        assert!(ledger.mark_may_have_sent(&action).is_err());
        assert!(ledger.note_ack(&action, Some("sig")).is_err());
        ledger
            .prepare_wire(&action, "/f/relay", b"signed-wire")
            .unwrap();
        assert!(ledger
            .prepare_wire(&action, "/f/relay", b"different-wire")
            .is_err());
        ledger.mark_may_have_sent(&action).unwrap();
        assert!(ledger.mark_may_have_sent(&action).is_err());
        ledger.note_ack(&action, Some("sig")).unwrap();
        assert!(ledger.note_unknown(&action).is_err());
        let audit = DecisionLedger::inspect(ledger.path()).unwrap();
        assert_eq!(audit.unresolved_actions, 1);
    }

    #[test]
    fn duplicate_ordinal_forged_action_and_changed_header_are_rejected() {
        let ledger = create();
        let d = ledger
            .begin_decision(2, 9, json!({"observation":"fixed"}))
            .unwrap();
        let action = ledger.record_intent(&d, 0, b"Harvest").unwrap();
        assert!(ledger.record_intent(&d, 0, b"Deposit").is_err());
        // A policy intent skipped by quota keeps its original ordinal.
        let sparse = ledger.record_intent(&d, 2, b"Caravan").unwrap();
        assert_ne!(action.id, sparse.id);
        assert!(ledger.record_intent(&d, 2, b"OtherCaravan").is_err());
        let mut forged = action.clone();
        forged.intent_sha256 = "0".repeat(64);
        assert!(ledger.prepare_wire(&forged, "/f/relay", b"wire").is_err());
        let mut changed = header();
        changed.roster_digest = "c".repeat(64);
        assert!(DecisionLedger::inspect_expected(ledger.path(), &changed).is_err());
    }

    #[test]
    fn source_and_roster_digests_are_part_of_action_identity() {
        let first = create();
        let mut changed = header();
        changed.source_digest = "c".repeat(64);
        let second = DecisionLedger::create_new(temp_path(), changed).unwrap();
        let action_id = |ledger: &DecisionLedger| {
            let d = ledger.begin_decision(2, 9, json!({"x":1})).unwrap();
            ledger.record_intent(&d, 0, b"Harvest").unwrap().id
        };
        assert_ne!(action_id(&first), action_id(&second));
    }

    #[test]
    fn header_exposes_exact_world_binding_and_poisoned_state_refuses_it() {
        let ledger = create();
        assert_eq!(ledger.header().unwrap(), header());
        assert_ne!(ledger.header().unwrap().world_id, "another-program:world-1");
        ledger.inner.lock().unwrap().fail_after_write = true;
        assert!(ledger.begin_decision(1, 2, json!({"x":1})).is_err());
        assert!(ledger.header().is_err());
    }

    #[test]
    fn concurrent_bots_have_distinct_durable_sequences() {
        let ledger = Arc::new(create());
        let mut workers = vec![];
        for bot in 0..8 {
            let ledger = ledger.clone();
            workers.push(std::thread::spawn(move || {
                let d = ledger.begin_decision(bot, 11, json!({"bot":bot})).unwrap();
                ledger.record_intent(&d, 0, b"Join").unwrap().id
            }));
        }
        let ids: std::collections::BTreeSet<_> =
            workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(ids.len(), 8);
        assert_eq!(DecisionLedger::inspect(ledger.path()).unwrap().decisions, 8);
    }

    #[test]
    fn torn_line_and_tampering_are_not_ignored() {
        let ledger = create();
        let path = ledger.path().to_path_buf();
        ledger.begin_decision(1, 2, json!({"x":1})).unwrap();
        {
            let mut f = OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{\"event\":").unwrap();
            f.sync_all().unwrap();
        }
        assert!(DecisionLedger::inspect(&path).is_err());
        let bytes = std::fs::read(&path).unwrap();
        let last_newline = bytes.iter().rposition(|b| *b == b'\n').unwrap();
        std::fs::write(&path, &bytes[..=last_newline]).unwrap();
        assert!(DecisionLedger::inspect(&path).is_ok());
        let mut bytes = std::fs::read(&path).unwrap();
        let at = bytes.windows(3).position(|w| w == b"run").unwrap();
        bytes[at] = b'R';
        std::fs::write(&path, bytes).unwrap();
        assert!(DecisionLedger::inspect(&path).is_err());
    }

    #[test]
    fn unsupported_version_and_unknown_event_are_rejected() {
        let path = temp_path();
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let event = json!({"ev":"header", "version":2, "run_id":"r", "world_id":"w",
            "source_digest":"a".repeat(64), "roster_digest":"b".repeat(64)});
        let row = json!({"prev":hex::encode([0u8;32]), "hash":hex::encode(event_hash(&[0u8;32], &event).unwrap()), "event":event});
        writeln!(f, "{}", row).unwrap();
        f.sync_all().unwrap();
        assert!(DecisionLedger::inspect(&path).is_err());
        let ledger = create();
        let path = ledger.path().to_path_buf();
        let previous = hex::decode(DecisionLedger::inspect(&path).unwrap().last_hash).unwrap();
        let previous: [u8; 32] = previous.try_into().unwrap();
        let event = json!({"ev":"unrecognised"});
        let row = json!({"prev":hex::encode(previous), "hash":hex::encode(event_hash(&previous, &event).unwrap()), "event":event});
        let mut f = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", row).unwrap();
        f.sync_all().unwrap();
        assert!(DecisionLedger::inspect(&path).is_err());
    }

    #[test]
    fn sync_failure_poisons_ledger_and_prevents_another_decision() {
        let ledger = create();
        ledger.inner.lock().unwrap().fail_after_write = true;
        assert!(ledger.begin_decision(1, 2, json!({"x":1})).is_err());
        ledger.inner.lock().unwrap().fail_after_write = false;
        assert!(ledger.begin_decision(1, 2, json!({"x":1})).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn signed_wire_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let ledger = create();
        assert_eq!(
            std::fs::metadata(ledger.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::fs::set_permissions(ledger.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(DecisionLedger::inspect(ledger.path()).is_err());
    }
}
