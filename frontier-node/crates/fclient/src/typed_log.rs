//! Opt-in, frame-attributed PS2/PSW1/PSWC decoding. This checks supplied runtime
//! log structure, not the authenticity/completeness of an RPC/archive source.
//! Legacy `log::bodies_from_logs` still refuses every PSW1 record.

use base64::Engine;
use frontier_abi::world_index::event::{conquest::SidecarClose, EventError, WideRecord};
use solana_address::Address;

use crate::{log::Record, ports::TxRecord};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeError {
    MissingProgramFrame,
    Truncated,
    Frame,
    UnframedData,
    DataShape,
    Base64,
    UnknownTag(Vec<u8>),
    Ps2(crate::log::LogError),
    Psw1(EventError),
    Pswc(EventError),
    /// The caller cannot semantically consume Citizen sidecar receipts.
    UnsupportedSidecar,
}

/// Validated bytes retained with a distinct format tag. No short legacy key
/// or host alias is substituted for a wide identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProgramRecord {
    Ps2 {
        body: Vec<u8>,
        record: Record,
    },
    Psw1 {
        body: Vec<u8>,
    },
    /// Citizen-address sidecar, never a Province/Holding chain record.
    Pswc {
        body: Vec<u8>,
    },
}

impl ProgramRecord {
    pub fn body(&self) -> &[u8] {
        match self {
            Self::Ps2 { body, .. } | Self::Psw1 { body } | Self::Pswc { body } => body,
        }
    }
    pub fn format(&self) -> &'static str {
        match self {
            Self::Ps2 { .. } => "PS2",
            Self::Psw1 { .. } => "PSW1",
            Self::Pswc { .. } => "PSWC",
        }
    }
    /// Revalidates even if a library caller constructed the public enum.
    pub fn wide(&self) -> Result<Option<WideRecord<'_>>, DecodeError> {
        match self {
            Self::Ps2 { .. } => Ok(None),
            Self::Pswc { body } => SidecarClose::decode(body)
                .map(|_| None)
                .map_err(DecodeError::Pswc),
            Self::Psw1 { body } => WideRecord::decode(body)
                .map(Some)
                .map_err(DecodeError::Psw1),
        }
    }
    pub fn sidecar(&self) -> Result<Option<SidecarClose>, DecodeError> {
        match self {
            Self::Pswc { body } => SidecarClose::decode(body)
                .map(Some)
                .map_err(DecodeError::Pswc),
            _ => Ok(None),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransactionRecords {
    Committed(Vec<ProgramRecord>),
    /// Transaction failure means all logged effects rolled back. Never feed
    /// its records into an entity chain, even if some invocations succeeded.
    RolledBack,
}

fn decode_data(data: &str) -> Result<ProgramRecord, DecodeError> {
    let parts: Vec<_> = data.split_whitespace().collect();
    if parts.len() != 2 {
        return Err(DecodeError::DataShape);
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let tag = b64.decode(parts[0]).map_err(|_| DecodeError::Base64)?;
    let body = b64.decode(parts[1]).map_err(|_| DecodeError::Base64)?;
    match tag.as_slice() {
        b"PS2" => {
            let record = Record::decode_v2(&body).map_err(DecodeError::Ps2)?;
            Ok(ProgramRecord::Ps2 { body, record })
        }
        b"PSW1" => {
            WideRecord::decode(&body).map_err(DecodeError::Psw1)?;
            Ok(ProgramRecord::Psw1 { body })
        }
        b"PSWC" => {
            SidecarClose::decode(&body).map_err(DecodeError::Pswc)?;
            Ok(ProgramRecord::Pswc { body })
        }
        _ => Err(DecodeError::UnknownTag(tag)),
    }
}

/// Decode only committed records attributed to `program`. Invocation depth
/// and each matching exit must be complete. Failed CPI subtrees are removed
/// (including successful grandchildren); a later caught error cannot turn
/// their rolled-back logs into events. Unrelated innermost frames cannot
/// inject PS2/PSW1 records. Decode occurs after rollback filtering.
pub fn decode_transaction(
    tx: &TxRecord,
    program: &Address,
) -> Result<TransactionRecords, DecodeError> {
    if tx.err.is_some() {
        return Ok(TransactionRecords::RolledBack);
    }
    let id = program.to_string();
    let mut stack: Vec<(&str, usize)> = Vec::new();
    let mut data = Vec::new();
    let mut saw_program = false;
    for line in &tx.logs {
        if line.contains("Log truncated") {
            return Err(DecodeError::Truncated);
        }
        if let Some(rest) = line.strip_prefix("Program data:") {
            // Keep malformed target data in the pending frame so a failed CPI
            // can discard it; a committed malformed line fails decoding.
            let raw = rest.strip_prefix(' ').unwrap_or("");
            let Some((who, _)) = stack.last() else {
                return Err(DecodeError::UnframedData);
            };
            if *who == id {
                data.push(raw);
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
                return Err(DecodeError::Frame);
            }
            saw_program |= who == id;
            stack.push((who, data.len()));
        } else if tail == "success" || tail.starts_with("failed:") {
            let Some((active, start)) = stack.pop() else {
                return Err(DecodeError::Frame);
            };
            if active != who {
                return Err(DecodeError::Frame);
            }
            if tail.starts_with("failed:") {
                if stack.is_empty() {
                    return Err(DecodeError::Frame);
                }
                data.truncate(start);
            }
        } else if tail.starts_with("invoke")
            || tail.starts_with("success")
            || tail.starts_with("failed")
        {
            return Err(DecodeError::Frame);
        }
    }
    if !stack.is_empty() {
        return Err(DecodeError::Frame);
    }
    if !saw_program {
        return Err(DecodeError::MissingProgramFrame);
    }
    Ok(TransactionRecords::Committed(
        data.into_iter()
            .map(decode_data)
            .collect::<Result<_, _>>()?,
    ))
}
