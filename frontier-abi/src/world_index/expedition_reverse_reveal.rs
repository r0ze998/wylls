//! Private reverse Reveal wire and raw-manifest receipt. No public dispatcher
//! accepts this command. The receipt has no entity-chain links: Reveal changes
//! only the original short-header ArrivalDay and ArrivalSlot accounts.
use super::{expedition_event::AccountSnapshot, seal::WIDE_PLAIN_LEN};
use crate::addr::AddrCtx;
use permutation_rules::hash::sha256;

pub const COMMAND_MAGIC: [u8; 8] = *b"PSRREVL1";
pub const PREFIX: &[u8] = b"PSRREV1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReverseReveal {
    pub transit_slot: u8,
    pub target_i: u8,
    pub plain: [u8; WIDE_PLAIN_LEN],
    pub salt: [u8; 32],
    pub ct_hash: [u8; 32],
    pub beneficiary: [u8; 32],
}
impl ReverseReveal {
    pub const LEN: usize = 10 + WIDE_PLAIN_LEN + 96;
    pub fn to_bytes(&self) -> [u8; Self::LEN] {
        let mut b = [0; Self::LEN];
        b[..8].copy_from_slice(&COMMAND_MAGIC);
        b[8] = self.transit_slot;
        b[9] = self.target_i;
        b[10..10 + WIDE_PLAIN_LEN].copy_from_slice(&self.plain);
        let n = 10 + WIDE_PLAIN_LEN;
        b[n..n + 32].copy_from_slice(&self.salt);
        b[n + 32..n + 64].copy_from_slice(&self.ct_hash);
        b[n + 64..].copy_from_slice(&self.beneficiary);
        b
    }
    pub fn decode(b: &[u8]) -> Option<Self> {
        if b.len() != Self::LEN || b[..8] != COMMAND_MAGIC || b[8] >= 4 || b[9] >= 4 {
            return None;
        }
        let n = 10 + WIDE_PLAIN_LEN;
        Some(Self {
            transit_slot: b[8],
            target_i: b[9],
            plain: b[10..n].try_into().ok()?,
            salt: b[n..n + 32].try_into().ok()?,
            ct_hash: b[n + 32..n + 64].try_into().ok()?,
            beneficiary: b[n + 64..].try_into().ok()?,
        })
    }
}

/// Full ordered manifest, including raw headers, absent-account prefunds,
/// privileges and duplicate roles. No account's chain bytes are normalized.
/// This digest records execution evidence; it is never an authorization token.
pub fn manifest_digest(
    ctx: &AddrCtx,
    command: &ReverseReveal,
    now_ts: i64,
    now_slot: u64,
    accounts: &[AccountSnapshot<'_>],
    outcomes: Option<&[u8]>,
) -> Option<[u8; 32]> {
    ReverseReveal::decode(&command.to_bytes())?;
    raw_manifest_digest(
        ctx,
        b"REVERSE-REVEAL-v1",
        &command.to_bytes(),
        now_ts,
        now_slot,
        accounts,
        outcomes,
    )
}

/// Shared with the private reverse Gather; callers provide a distinct action
/// domain and canonical command bytes. Full raw history chains remain intact.
pub fn raw_manifest_digest(
    ctx: &AddrCtx,
    action_domain: &[u8],
    command: &[u8],
    now_ts: i64,
    now_slot: u64,
    accounts: &[AccountSnapshot<'_>],
    outcomes: Option<&[u8]>,
) -> Option<[u8; 32]> {
    let mut fold = sha256(&[
        b"PSF-REVERSE-CONTEXT-v1",
        &(action_domain.len() as u64).to_le_bytes(),
        action_domain,
        &ctx.program,
        &ctx.season,
        &(command.len() as u64).to_le_bytes(),
        command,
        &now_ts.to_le_bytes(),
        &now_slot.to_le_bytes(),
        &(accounts.len() as u64).to_le_bytes(),
    ]);
    for (i, a) in accounts.iter().enumerate() {
        if a.role as usize != i + 1 || (!a.present && !a.data.is_empty()) {
            return None;
        }
        for prior in &accounts[..i] {
            if prior.address == a.address
                && (prior.owner != a.owner
                    || prior.present != a.present
                    || prior.lamports != a.lamports
                    || prior.data != a.data)
            {
                return None;
            }
        }
        fold = sha256(&[
            b"PSF-REVERSE-REVEAL-ACCOUNT-v1",
            &fold,
            &a.role.to_le_bytes(),
            &a.address,
            &a.owner,
            &[a.present as u8, a.signer as u8, a.writable as u8],
            &a.lamports.to_le_bytes(),
            &(a.data.len() as u64).to_le_bytes(),
            a.data,
        ]);
    }
    Some(match outcomes {
        None => sha256(&[b"PSF-REVERSE-REVEAL-INPUT-v1", &fold]),
        Some(o) => sha256(&[
            b"PSF-REVERSE-REVEAL-OUTPUT-v1",
            &fold,
            &(o.len() as u64).to_le_bytes(),
            o,
        ]),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub input: [u8; 32],
    pub output: [u8; 32],
}
impl Receipt {
    pub fn to_bytes(self) -> [u8; 97] {
        let mut b = [0; 97];
        b[0] = 1;
        b[1..33].copy_from_slice(&sha256(&[
            b"PSF-REVERSE-REVEAL-OPERATION-v1",
            &self.input,
            &self.output,
        ]));
        b[33..65].copy_from_slice(&self.input);
        b[65..97].copy_from_slice(&self.output);
        b
    }
}
