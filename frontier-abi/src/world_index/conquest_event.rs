//! Provisional full-state lifecycle commitments, not authorization or replay.
//!
//! Each operation supplies its complete, authenticated wire account manifest,
//! including read-only accounts, absent/prefunded creation destinations, transfer
//! payers and recipients. Roles are ascending one-based wire account indices.
//! Aliases retain each role and must describe the same account consistently.
//! Input preserves chain headers; output normalizes ONLY accounts actually
//! chained by this operation. In particular private tables, rosters, Citizen,
//! JoinShard and escrow bytes must never be normalized. The caller authenticates
//! canonical addresses/owners/Season and completeness of the wire manifest.
//! `present` is the inverse of the runtime account-absence predicate, not
//! nonzero lamports or protocol ownership. External/executable accounts can be
//! present. Absent/prefunded destinations have empty data and explicit
//! owner/lamports; callers use the same predicate before and after execution.
//! Context commits exact command bytes, time, bell, whole authenticated Season,
//! and operation evidence (including Resolve seed). Output outcomes encode actual
//! transfers/refunds and model output (including Resolve clash digest). Neither
//! digest alone proves conservation, authorization or model replay.
use super::{normalize_chained, EventError, WideKind};
use crate::layout::header;
use alloc::vec::Vec;
use permutation_rules::hash::sha256;

pub const RECEIPT_LEN: usize = 100;
pub const DECLARE: u8 = 1;
pub const RESOLVE: u8 = 2;
pub const FAILED: u8 = 3;
pub const LAPSE: u8 = 4;
pub const CAPTURE: u8 = 5;
pub const TABLE_CLOSE: u8 = 6;
pub const ESCROW_CLOSE: u8 = 7;
/// Experimental conquest lane: a siege reservation accepted (DeclareSiege
/// behind the resolved cursor). Outcome bytes as DECLARE.
#[cfg(feature = "conquest-dispatch-experimental")]
pub const RESERVE: u8 = 8;
/// Experimental conquest lane: one SettleReservation (parts of a
/// not-applied reservation's full return).
#[cfg(feature = "conquest-dispatch-experimental")]
pub const RESERVATION_REFUND: u8 = 9;
/// Whether `action` debits a source Holding (ConquestDeclared/Debited).
pub const fn debit_action(action: u8) -> bool {
    #[cfg(feature = "conquest-dispatch-experimental")]
    if action == RESERVE {
        return true;
    }
    action == DECLARE
}
/// Whether `action` may carry a ConquestSettled record.
pub const fn settled_action(action: u8) -> bool {
    #[cfg(feature = "conquest-dispatch-experimental")]
    if action == RESERVATION_REFUND {
        return true;
    }
    action == FAILED || action == LAPSE
}
/// Whether `action` credits a source Holding (ConquestCredited).
pub const fn credit_action(action: u8) -> bool {
    #[cfg(feature = "conquest-dispatch-experimental")]
    if action == RESERVATION_REFUND {
        return true;
    }
    action == LAPSE || action == CAPTURE
}
const fn valid_action(action: u8) -> bool {
    #[cfg(feature = "conquest-dispatch-experimental")]
    if action == RESERVE || action == RESERVATION_REFUND {
        return true;
    }
    DECLARE <= action && action <= ESCROW_CLOSE
}
pub const SIDECAR_LOG_PREFIX: &[u8; 4] = b"PSWC";
/// Version1, season pubkey, Citizen account pubkey, bell, receipt. No chain.
pub const SIDECAR_CLOSE_LEN: usize = 1 + 32 + 32 + 4 + RECEIPT_LEN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub action: u8,
    pub outcome: u8,
    pub operation_id: [u8; 32],
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    pub fn new(
        action: u8,
        outcome: u8,
        input: [u8; 32],
        output: [u8; 32],
    ) -> Result<Self, EventError> {
        if !valid_action(action) || outcome != 0 {
            return Err(EventError::Payload);
        }
        let operation_id = sha256(&[
            b"PSF-WIDE-CONQUEST-OP-v1",
            &[action, outcome],
            &input,
            &output,
        ]);
        Ok(Self {
            action,
            outcome,
            operation_id,
            input,
            output,
        })
    }
    pub fn encode(&self) -> [u8; RECEIPT_LEN] {
        let mut out = [0; RECEIPT_LEN];
        out[0] = 1;
        out[1] = self.action;
        out[2] = self.outcome;
        out[4..36].copy_from_slice(&self.operation_id);
        out[36..68].copy_from_slice(&self.input);
        out[68..100].copy_from_slice(&self.output);
        out
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, EventError> {
        if bytes.len() != RECEIPT_LEN || bytes[0] != 1 || bytes[3] != 0 {
            return Err(EventError::Payload);
        }
        let want = Self::new(
            bytes[1],
            bytes[2],
            bytes[36..68].try_into().unwrap(),
            bytes[68..100].try_into().unwrap(),
        )?;
        if bytes[4..36] != want.operation_id {
            return Err(EventError::Payload);
        }
        Ok(want)
    }
    pub fn validate_kind(&self, kind: WideKind) -> Result<(), EventError> {
        let valid = match kind {
            WideKind::ConquestDeclared | WideKind::ConquestDebited => debit_action(self.action),
            WideKind::ConquestResolved => self.action == RESOLVE,
            WideKind::ConquestSettled => settled_action(self.action),
            WideKind::ConquestCaptured => self.action == CAPTURE,
            WideKind::ConquestCredited => credit_action(self.action),
            WideKind::ConquestTableClosed => self.action == TABLE_CLOSE,
            _ => false,
        };
        if valid {
            Ok(())
        } else {
            Err(EventError::Payload)
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AccountSnapshot<'a> {
    pub role: u16,
    pub address: [u8; 32],
    pub owner: [u8; 32],
    pub present: bool,
    pub lamports: u64,
    pub data: &'a [u8],
    /// True ONLY for an actual chained Province or Holding of this operation.
    pub chained: bool,
}
#[derive(Clone, Copy, Debug)]
pub struct Context<'a> {
    pub command: &'a [u8],
    pub now_ts: i64,
    pub bell: u32,
    pub season: &'a [u8],
    pub evidence: &'a [u8],
}
fn bytes(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u64).to_le_bytes());
    out.extend_from_slice(value);
}
fn digest(
    domain: &[u8],
    context: &Context<'_>,
    accounts: &[AccountSnapshot<'_>],
    outcomes: &[u8],
    output: bool,
) -> Result<[u8; 32], EventError> {
    if context.command.is_empty() || context.season.is_empty() || accounts.is_empty() {
        return Err(EventError::Payload);
    }
    let mut out = Vec::new();
    bytes(&mut out, context.command);
    out.extend_from_slice(&context.now_ts.to_le_bytes());
    out.extend_from_slice(&context.bell.to_le_bytes());
    bytes(&mut out, context.season);
    bytes(&mut out, context.evidence);
    out.extend_from_slice(&(accounts.len() as u64).to_le_bytes());
    let mut previous = 0;
    for (i, account) in accounts.iter().enumerate() {
        if account.role <= previous
            || (!account.present && !account.data.is_empty())
            || (account.chained && account.present && account.data.len() < header::EVENT_HEAD + 32)
        {
            return Err(EventError::Payload);
        }
        // Prevent conflicting alias snapshots. A closed or not-yet-created
        // chained account may be absent, but its attribution stays explicit.
        for prior in &accounts[..i] {
            if prior.address == account.address
                && (prior.owner != account.owner
                    || prior.present != account.present
                    || prior.lamports != account.lamports
                    || prior.data != account.data
                    || prior.chained != account.chained)
            {
                return Err(EventError::Payload);
            }
        }
        previous = account.role;
        out.extend_from_slice(&account.role.to_le_bytes());
        out.extend_from_slice(&account.address);
        out.extend_from_slice(&account.owner);
        out.push(u8::from(account.present));
        out.push(u8::from(account.chained));
        out.extend_from_slice(&account.lamports.to_le_bytes());
        if output && account.chained && account.present {
            bytes(&mut out, &normalize_chained(account.data));
        } else {
            bytes(&mut out, account.data);
        }
    }
    bytes(&mut out, outcomes);
    Ok(sha256(&[domain, &out]))
}
pub fn input_digest(
    context: &Context<'_>,
    accounts: &[AccountSnapshot<'_>],
) -> Result<[u8; 32], EventError> {
    digest(b"PSF-WIDE-CONQUEST-INPUT-v1", context, accounts, &[], false)
}
pub fn output_digest(
    context: &Context<'_>,
    accounts: &[AccountSnapshot<'_>],
    outcomes: &[u8],
) -> Result<[u8; 32], EventError> {
    digest(
        b"PSF-WIDE-CONQUEST-OUTPUT-v1",
        context,
        accounts,
        outcomes,
        true,
    )
}

/// Citizen-address identity is explicitly separate from WideRecord attribution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SidecarClose {
    pub season: [u8; 32],
    pub citizen: [u8; 32],
    pub bell: u32,
    pub receipt: Receipt,
}
impl SidecarClose {
    pub fn encode(&self) -> Result<[u8; SIDECAR_CLOSE_LEN], EventError> {
        if self.receipt.action != ESCROW_CLOSE {
            return Err(EventError::Payload);
        }
        let receipt = self.receipt.encode();
        Receipt::decode(&receipt)?;
        let mut out = [0; SIDECAR_CLOSE_LEN];
        out[0] = 1;
        out[1..33].copy_from_slice(&self.season);
        out[33..65].copy_from_slice(&self.citizen);
        out[65..69].copy_from_slice(&self.bell.to_le_bytes());
        out[69..].copy_from_slice(&receipt);
        Ok(out)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self, EventError> {
        if bytes.len() != SIDECAR_CLOSE_LEN || bytes[0] != 1 {
            return Err(EventError::Payload);
        }
        let receipt = Receipt::decode(&bytes[69..])?;
        if receipt.action != ESCROW_CLOSE {
            return Err(EventError::Payload);
        }
        Ok(Self {
            season: bytes[1..33].try_into().unwrap(),
            citizen: bytes[33..65].try_into().unwrap(),
            bell: u32::from_le_bytes(bytes[65..69].try_into().unwrap()),
            receipt,
        })
    }
}

#[cfg(test)]
mod reservation_action_tests {
    use super::*;
    use crate::world_index::event::{write_body, MAX_BODY};
    use crate::world_index::{ProvinceKey, WideCoord, WorldId};

    fn key() -> [u8; 50] {
        let k = ProvinceKey::new(
            WorldId::new([0x77; 32]).unwrap(),
            WideCoord::checked(129, 0).unwrap(),
        );
        let mut out = [0u8; 50];
        out.copy_from_slice(&k.to_bytes());
        out
    }

    #[cfg(feature = "conquest-dispatch-experimental")]
    #[test]
    fn reserve_and_refund_actions_pass_kind_and_body_validation() {
        let r8 = Receipt::new(RESERVE, 0, [1; 32], [2; 32]).unwrap();
        let r9 = Receipt::new(RESERVATION_REFUND, 0, [1; 32], [2; 32]).unwrap();
        assert_eq!(Receipt::decode(&r8.encode()).unwrap(), r8);
        assert_eq!(Receipt::decode(&r9.encode()).unwrap(), r9);
        r8.validate_kind(WideKind::ConquestDeclared).unwrap();
        r8.validate_kind(WideKind::ConquestDebited).unwrap();
        r9.validate_kind(WideKind::ConquestSettled).unwrap();
        r9.validate_kind(WideKind::ConquestCredited).unwrap();
        for k in [WideKind::ConquestSettled, WideKind::ConquestCredited, WideKind::ConquestResolved] {
            assert!(r8.validate_kind(k).is_err());
        }
        for k in [WideKind::ConquestDeclared, WideKind::ConquestDebited, WideKind::ConquestCaptured] {
            assert!(r9.validate_kind(k).is_err());
        }
        // The real event body path (the program's prepare_wide calls it).
        let mut out = [0u8; MAX_BODY];
        assert!(write_body(WideKind::ConquestDeclared, 20, &key(), &r8.encode(), &mut out).is_some());
        assert!(write_body(WideKind::ConquestSettled, 20, &key(), &r9.encode(), &mut out).is_some());
        assert!(write_body(WideKind::ConquestSettled, 20, &key(), &r8.encode(), &mut out).is_none());
        assert!(debit_action(RESERVE) && !credit_action(RESERVE) && !settled_action(RESERVE));
        assert!(credit_action(RESERVATION_REFUND) && settled_action(RESERVATION_REFUND));
        // Unknown actions stay refused.
        assert!(Receipt::new(10, 0, [1; 32], [2; 32]).is_err());
    }

    #[cfg(not(feature = "conquest-dispatch-experimental"))]
    #[test]
    fn without_the_feature_actions_8_and_9_stay_refused() {
        for a in [8u8, 9] {
            assert!(Receipt::new(a, 0, [1; 32], [2; 32]).is_err());
            assert!(!debit_action(a) && !credit_action(a) && !settled_action(a));
        }
        let r1 = Receipt::new(DECLARE, 0, [1; 32], [2; 32]).unwrap();
        let mut out = [0u8; MAX_BODY];
        assert!(write_body(WideKind::ConquestDeclared, 20, &key(), &r1.encode(), &mut out).is_some());
    }
}
