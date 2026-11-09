//! Opt-in, frame-attributed PS2/PSW1/PSWC decoding. This checks supplied runtime
//! log structure, not the authenticity/completeness of an RPC/archive source.
//! Legacy `log::bodies_from_logs` still refuses every PSW1 record.

use base64::Engine;
use frontier_abi::world_index::event::{conquest::SidecarClose, EventError, WideRecord};
use frontier_abi::world_index::{
    event::{conquest, WideKind},
    expedition::AccountResolver,
    expedition_event as source, expedition_producer_event as producer,
    expedition_settlement_event as settlement, legacy_source_event as legacy_source,
};
use frontier_abi::{addr::AddrCtx, world_index::expedition_resident_event as resident};
use solana_address::Address;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExpeditionRecord {
    LegacySource(legacy_source::Record),
    Source(source::Record),
    Producer(producer::Record),
    Settlement(settlement::Record),
}

use crate::{log::Record, ports::TxRecord};

impl ExpeditionRecord {
    pub fn province(&self) -> frontier_abi::world_index::ProvinceKey {
        match self {
            Self::LegacySource(r) => r.source.source.key(),
            Self::Source(r) => r.source.identity.origin,
            Self::Producer(r) => r.target.destination(),
            Self::Settlement(r) => r.identity.destination,
        }
    }
    pub fn host(&self) -> Option<frontier_abi::world_index::WideHostRef> {
        match self {
            Self::LegacySource(r) => Some(r.source.source),
            Self::Source(r) => Some(r.source.identity.host),
            Self::Producer(r) => match r.target {
                producer::Target::Reveal { identity, .. } => Some(identity.host),
                producer::Target::Gather { .. } => None,
            },
            Self::Settlement(r) => Some(r.identity.host),
        }
    }
}

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
    UnsupportedResident,
    Resident(resident::Error),
    ResidentPair,
    UnsupportedExpedition,
    ExpeditionSource(source::Error),
    ExpeditionProducer(producer::Error),
    ExpeditionSettlement(settlement::Error),
    ExpeditionPair,
    LegacySource(legacy_source::Error),
    ConquestPair,
}

/// Validated bytes retained with a distinct format tag. No short legacy key
/// or host alias is substituted for a wide identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProgramRecord {
    ExpeditionOriginal {
        body: Vec<u8>,
    },
    ExpeditionWide {
        body: Vec<u8>,
    },
    ResidentOriginal {
        body: Vec<u8>,
    },
    ResidentWide {
        body: Vec<u8>,
    },
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
            Self::ExpeditionOriginal { body }
            | Self::ExpeditionWide { body }
            | Self::Ps2 { body, .. }
            | Self::Psw1 { body }
            | Self::Pswc { body }
            | Self::ResidentOriginal { body }
            | Self::ResidentWide { body } => body,
        }
    }
    pub fn format(&self) -> &'static str {
        match self {
            Self::Ps2 { .. } | Self::ResidentOriginal { .. } | Self::ExpeditionOriginal { .. } => {
                "PS2"
            }
            Self::Psw1 { .. } | Self::ResidentWide { .. } | Self::ExpeditionWide { .. } => "PSW1",
            Self::Pswc { .. } => "PSWC",
        }
    }
    /// Revalidates even if a library caller constructed the public enum.
    pub fn wide(&self) -> Result<Option<WideRecord<'_>>, DecodeError> {
        match self {
            Self::Ps2 { .. } => Ok(None),
            Self::ExpeditionOriginal { .. } | Self::ExpeditionWide { .. } => {
                Err(DecodeError::UnsupportedExpedition)
            }
            Self::ResidentOriginal { .. } | Self::ResidentWide { .. } => {
                Err(DecodeError::UnsupportedResident)
            }
            Self::Pswc { body } => SidecarClose::decode(body)
                .map(|_| None)
                .map_err(DecodeError::Pswc),
            Self::Psw1 { body } => WideRecord::decode(body)
                .map(Some)
                .map_err(DecodeError::Psw1),
        }
    }
    /// Dedicated canonical decoder; never substitutes generic legacy semantics.
    pub fn resident(&self, ctx: &AddrCtx) -> Result<Option<resident::Record>, DecodeError> {
        let expected = match self {
            Self::ResidentOriginal { .. } => resident::ORIGINAL_KIND,
            Self::ResidentWide { .. } => resident::WIDE_KIND,
            _ => return Ok(None),
        };
        if self.body().get(1) != Some(&expected) {
            return Err(DecodeError::Resident(resident::Error::Shape));
        }
        resident::Record::decode(ctx, self.body())
            .map(Some)
            .map_err(DecodeError::Resident)
    }
    /// Canonical scoped decoding; original address-keyed chains remain unverified.
    pub fn expedition(&self, ctx: &AddrCtx) -> Result<Option<ExpeditionRecord>, DecodeError> {
        let value = match (self, self.body().get(1).copied()) {
            (Self::ExpeditionOriginal { body }, Some(legacy_source::KIND)) => {
                ExpeditionRecord::LegacySource(
                    legacy_source::Record::decode(
                        &AccountResolver::for_season(ctx)
                            .map_err(|_| DecodeError::UnsupportedExpedition)?,
                        body,
                    )
                    .map_err(DecodeError::LegacySource)?,
                )
            }
            (Self::ExpeditionOriginal { body }, Some(source::KIND)) => ExpeditionRecord::Source(
                source::Record::decode(ctx, body).map_err(DecodeError::ExpeditionSource)?,
            ),
            (Self::ExpeditionOriginal { body }, Some(producer::KIND)) => {
                ExpeditionRecord::Producer(
                    producer::Record::decode(ctx, body).map_err(DecodeError::ExpeditionProducer)?,
                )
            }
            (Self::ExpeditionOriginal { body }, Some(settlement::ORIGINAL_KIND))
            | (Self::ExpeditionWide { body }, Some(settlement::WIDE_KIND)) => {
                ExpeditionRecord::Settlement(
                    settlement::Record::decode(ctx, body)
                        .map_err(DecodeError::ExpeditionSettlement)?,
                )
            }
            (Self::ExpeditionOriginal { .. } | Self::ExpeditionWide { .. }, _) => {
                return Err(DecodeError::UnsupportedExpedition)
            }
            _ => return Ok(None),
        };
        Ok(Some(value))
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

fn decode_data(
    data: &str,
    ctx: Option<&AddrCtx>,
    expedition: bool,
) -> Result<ProgramRecord, DecodeError> {
    let parts: Vec<_> = data.split_whitespace().collect();
    if parts.len() != 2 {
        return Err(DecodeError::DataShape);
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let tag = b64.decode(parts[0]).map_err(|_| DecodeError::Base64)?;
    let body = b64.decode(parts[1]).map_err(|_| DecodeError::Base64)?;
    if (tag == b"PS2" && matches!(body.get(1), Some(145..=148)))
        || (tag == b"PSW1" && body.get(1) == Some(&25))
    {
        if !expedition {
            return Err(DecodeError::UnsupportedExpedition);
        }
        let ctx = ctx.ok_or(DecodeError::UnsupportedExpedition)?;
        let record = if tag == b"PS2" {
            ProgramRecord::ExpeditionOriginal { body }
        } else {
            ProgramRecord::ExpeditionWide { body }
        };
        record.expedition(ctx)?;
        return Ok(record);
    }
    if (tag == b"PS2" && body.get(1) == Some(&resident::ORIGINAL_KIND))
        || (tag == b"PSW1" && body.get(1) == Some(&resident::WIDE_KIND))
    {
        let ctx = ctx.ok_or(DecodeError::UnsupportedResident)?;
        let record = match (tag.as_slice(), body.get(1).copied()) {
            (b"PS2", Some(resident::ORIGINAL_KIND)) => ProgramRecord::ResidentOriginal { body },
            (b"PSW1", Some(resident::WIDE_KIND)) => ProgramRecord::ResidentWide { body },
            _ => return Err(DecodeError::Resident(resident::Error::Shape)),
        };
        record.resident(ctx)?;
        return Ok(record);
    }
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
    decode_transaction_inner(tx, program, None, false)
}

/// Explicit scoped opt-in. Every resident operation must contain exactly one
/// canonical original part and one matching wide part in the same committed tx.
pub fn decode_transaction_with_resident(
    tx: &TxRecord,
    program: &Address,
    ctx: &AddrCtx,
) -> Result<TransactionRecords, DecodeError> {
    if ctx.program != program.to_bytes() {
        return Err(DecodeError::Resident(resident::Error::Identity));
    }
    decode_transaction_inner(tx, program, Some(ctx), false)
}
/// Full original-expedition opt-in, including resident pairs. The older resident
/// API deliberately continues to reject kinds 146..148 and 25.
pub fn decode_transaction_with_expedition(
    tx: &TxRecord,
    program: &Address,
    ctx: &AddrCtx,
) -> Result<TransactionRecords, DecodeError> {
    if ctx.program != program.to_bytes() {
        return Err(DecodeError::UnsupportedExpedition);
    }
    decode_transaction_inner(tx, program, Some(ctx), true)
}
fn decode_transaction_inner(
    tx: &TxRecord,
    program: &Address,
    ctx: Option<&AddrCtx>,
    expedition: bool,
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
    let records = data
        .into_iter()
        .map(|d| decode_data(d, ctx, expedition))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(ctx) = ctx {
        let mut pairs = std::collections::BTreeMap::<[u8; 32], Vec<resident::Record>>::new();
        for record in &records {
            if let Some(r) = record.resident(ctx)? {
                let parts = pairs.entry(r.receipt.operation_id).or_default();
                if parts.len() == 2 {
                    return Err(DecodeError::ResidentPair);
                }
                parts.push(r);
            }
        }
        for parts in pairs.values() {
            if parts.len() != 2 {
                return Err(DecodeError::ResidentPair);
            }
            parts[0]
                .pair(&parts[1])
                .map_err(|_| DecodeError::ResidentPair)?;
        }
    }
    if expedition {
        let ctx = ctx.ok_or(DecodeError::UnsupportedExpedition)?;
        let resolver =
            AccountResolver::for_season(ctx).map_err(|_| DecodeError::UnsupportedExpedition)?;
        let world = resolver.adapter().world();
        for record in &records {
            if let ProgramRecord::Psw1 { body } = record {
                let w = WideRecord::decode(body).map_err(DecodeError::Psw1)?;
                if w.province_of().is_none_or(|p| p.world() != world) {
                    return Err(DecodeError::UnsupportedExpedition);
                }
                if w.kind.conquest()
                    && w.province_of().is_none_or(|p| {
                        resolver.family(p).ok()
                            != Some(frontier_abi::world_index::expedition::AccountFamily::Wide)
                    })
                {
                    return Err(DecodeError::ConquestPair);
                }
            }
        }
        validate_conquest_pairs(&records, ctx)?;
        let mut pairs = std::collections::BTreeMap::<[u8; 32], Vec<settlement::Record>>::new();
        for record in &records {
            if let Some(ExpeditionRecord::Settlement(r)) = record.expedition(ctx)? {
                let parts = pairs.entry(r.receipt.operation_id).or_default();
                if parts.len() == 2 {
                    return Err(DecodeError::ExpeditionPair);
                }
                parts.push(r);
            }
        }
        for parts in pairs.values() {
            if parts.len() != 2 {
                return Err(DecodeError::ExpeditionPair);
            }
            parts[0]
                .pair(&parts[1])
                .map_err(|_| DecodeError::ExpeditionPair)?;
        }
    }
    Ok(TransactionRecords::Committed(records))
}

/// Structural operation pairing only. Target-manifest source membership and
/// original account history are not authenticated by log receipts.
fn validate_conquest_pairs(records: &[ProgramRecord], ctx: &AddrCtx) -> Result<(), DecodeError> {
    let resolver =
        AccountResolver::for_season(ctx).map_err(|_| DecodeError::UnsupportedExpedition)?;
    let mut operations = std::collections::BTreeMap::<[u8; 32], Vec<usize>>::new();
    for (i, r) in records.iter().enumerate() {
        let receipt = match r.expedition(ctx)? {
            Some(ExpeditionRecord::LegacySource(x)) => Some(x.source.receipt),
            _ => match r {
                ProgramRecord::Psw1 { body } => {
                    let w = WideRecord::decode(body).map_err(DecodeError::Psw1)?;
                    if w.kind.conquest() {
                        Some(conquest::Receipt::decode(w.payload).map_err(DecodeError::Psw1)?)
                    } else {
                        None
                    }
                }
                ProgramRecord::Pswc { body } => {
                    let c = SidecarClose::decode(body).map_err(DecodeError::Pswc)?;
                    if c.season != ctx.season {
                        return Err(DecodeError::ConquestPair);
                    }
                    Some(c.receipt)
                }
                _ => None,
            },
        };
        if let Some(r) = receipt {
            operations.entry(r.operation_id).or_default().push(i);
        }
    }
    for indexes in operations.values() {
        let mut source = None;
        let mut target = None;
        let mut standalone = false;
        for &i in indexes {
            match &records[i] {
                ProgramRecord::ExpeditionOriginal { .. } => {
                    if source.replace(i).is_some() {
                        return Err(DecodeError::ConquestPair);
                    }
                }
                ProgramRecord::Psw1 { body } => {
                    let w = WideRecord::decode(body).map_err(DecodeError::Psw1)?;
                    let receipt =
                        conquest::Receipt::decode(w.payload).map_err(DecodeError::Psw1)?;
                    match w.kind {
                        WideKind::ConquestDebited | WideKind::ConquestCredited => {
                            if source.replace(i).is_some() {
                                return Err(DecodeError::ConquestPair);
                            }
                        }
                        WideKind::ConquestDeclared | WideKind::ConquestCaptured => {
                            if target.replace(i).is_some() {
                                return Err(DecodeError::ConquestPair);
                            }
                        }
                        WideKind::ConquestSettled if receipt.action == conquest::LAPSE => {
                            if target.replace(i).is_some() {
                                return Err(DecodeError::ConquestPair);
                            }
                        }
                        _ => standalone = true,
                    }
                }
                _ => standalone = true,
            }
        }
        if standalone {
            if indexes.len() != 1 {
                return Err(DecodeError::ConquestPair);
            }
            continue;
        }
        // Canonical settlement/capture omits source credit when the source is
        // absent or stale. A lone target is an unverified observation, never
        // evidence of missing/zero credit. Declaration still requires debit.
        if indexes.len() == 1 && source.is_none() {
            if let Some(i) = target {
                let w = records[i].wide()?.ok_or(DecodeError::ConquestPair)?;
                if matches!(
                    w.kind,
                    WideKind::ConquestSettled | WideKind::ConquestCaptured
                ) {
                    continue;
                }
            }
        }
        if indexes.len() != 2 {
            return Err(DecodeError::ConquestPair);
        }
        let source = &records[source.ok_or(DecodeError::ConquestPair)?];
        let target = records[target.ok_or(DecodeError::ConquestPair)?]
            .wide()?
            .ok_or(DecodeError::ConquestPair)?;
        if let Some(ExpeditionRecord::LegacySource(r)) = source.expedition(ctx)? {
            r.source
                .pair_target(&resolver, &target)
                .map_err(|_| DecodeError::ConquestPair)?;
        } else {
            let s = source.wide()?.ok_or(DecodeError::ConquestPair)?;
            if s.bell != target.bell
                || s.payload != target.payload
                || !matches!(
                    (s.kind, target.kind),
                    (WideKind::ConquestDebited, WideKind::ConquestDeclared)
                        | (
                            WideKind::ConquestCredited,
                            WideKind::ConquestCaptured | WideKind::ConquestSettled
                        )
                )
            {
                return Err(DecodeError::ConquestPair);
            }
        }
    }
    Ok(())
}
