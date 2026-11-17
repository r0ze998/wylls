//! Local inspection of an existing unsigned legacy message. No draft conversion,
//! account reads, signatures, simulation, admission or send occurs here.
//!
//! Blockhash observations and expected signers are caller-supplied public data,
//! not authenticated RPC evidence or wallet authorization. A successful report
//! must never open a closed dispatch gate.
use crate::tx::Shape;
use solana_address::Address;
use solana_message::Message;

/// Existing relay wire limit, including the eventual signature slots.
pub const PACKET_BYTES: usize = 1232;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Deployment-specific lock policy; do not infer it from a client version.
    pub max_locks: usize,
    pub max_writes: usize,
    pub min_context_slot: u64,
    pub min_remaining_block_heights: u64,
}

/// Observations for exactly the message's blockhash. The caller must obtain
/// these from the intended cluster with its chosen commitment/minContextSlot.
/// This struct does not assert common-response provenance or freshness.
#[derive(Clone, Copy, Debug)]
pub struct BlockhashObservation {
    pub blockhash: [u8; 32],
    pub context_slot: u64,
    pub valid: bool,
    pub block_height: u64,
    pub last_valid_block_height: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Limits,
    Header,
    DuplicateAccount,
    Signers,
    InstructionIndex,
    EmptyInstructions,
    PacketSize,
    AccountLocks,
    WritableLocks,
    BlockhashMismatch,
    BlockhashContext,
    BlockhashInvalid,
    BlockhashExpired,
    BlockhashMargin,
    Encoding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Report {
    pub shape: Shape,
    pub remaining_block_heights: u64,
}
impl Report {
    pub const fn admitted(&self) -> bool {
        false
    }
    pub const fn public_dispatch_available(&self) -> bool {
        false
    }
    pub const fn rpc_authority_verified(&self) -> bool {
        false
    }
}

/// Check layout before calling any helper that indexes/subtracts header fields.
/// `expected_signers` is the exact ordered public signer list, payer first;
/// merely finding a wallet somewhere in the account list is insufficient.
pub fn inspect(
    message: &Message,
    expected_signers: &[Address],
    observation: BlockhashObservation,
    limits: Limits,
) -> Result<Report, Error> {
    if limits.max_locks == 0
        || limits.max_locks > 256
        || limits.max_writes == 0
        || limits.max_writes > limits.max_locks
    {
        return Err(Error::Limits);
    }
    let keys = message.account_keys.len();
    let h = &message.header;
    let sigs = usize::from(h.num_required_signatures);
    let ro_sig = usize::from(h.num_readonly_signed_accounts);
    let ro_unsig = usize::from(h.num_readonly_unsigned_accounts);
    // The first header byte's high bit is reserved for versioned messages.
    if keys > 256
        || sigs == 0
        || sigs >= 128
        || sigs > keys
        || ro_sig >= sigs
        || ro_unsig > keys - sigs
    {
        return Err(Error::Header);
    }
    if keys > limits.max_locks {
        return Err(Error::AccountLocks);
    }
    for (i, key) in message.account_keys.iter().enumerate() {
        if message.account_keys[..i].contains(key) {
            return Err(Error::DuplicateAccount);
        }
    }
    if message.account_keys[..sigs] != *expected_signers {
        return Err(Error::Signers);
    }
    if message.instructions.is_empty() {
        return Err(Error::EmptyInstructions);
    }
    // Bound serialization work as well as the eventual packet. Every compiled
    // instruction takes at least three bytes, even when both vectors are empty.
    if message.instructions.len() > PACKET_BYTES / 3 {
        return Err(Error::PacketSize);
    }
    let mut payload = 0usize;
    for ix in &message.instructions {
        if usize::from(ix.program_id_index) >= keys
            || ix.program_id_index == 0
            || ix.accounts.iter().any(|i| usize::from(*i) >= keys)
        {
            return Err(Error::InstructionIndex);
        }
        payload = payload
            .checked_add(ix.data.len())
            .and_then(|n| n.checked_add(ix.accounts.len()))
            .ok_or(Error::PacketSize)?;
        if payload > PACKET_BYTES {
            return Err(Error::PacketSize);
        }
    }
    let writes = keys - ro_sig - ro_unsig;
    if writes > limits.max_writes {
        return Err(Error::WritableLocks);
    }
    let message_bytes = bincode::serialized_size(message).map_err(|_| Error::Encoding)? as usize;
    // One-byte short_vec signature count, then 64 signature bytes each.
    // Count is below 128 after header validation; no signature is constructed.
    let bytes = message_bytes + 1 + 64 * sigs;
    if bytes > PACKET_BYTES {
        return Err(Error::PacketSize);
    }
    if observation.blockhash == [0; 32]
        || observation.blockhash != message.recent_blockhash.to_bytes()
    {
        return Err(Error::BlockhashMismatch);
    }
    if observation.context_slot < limits.min_context_slot {
        return Err(Error::BlockhashContext);
    }
    if !observation.valid {
        return Err(Error::BlockhashInvalid);
    }
    let remaining_block_heights = observation
        .last_valid_block_height
        .checked_sub(observation.block_height)
        .ok_or(Error::BlockhashExpired)?;
    if remaining_block_heights < limits.min_remaining_block_heights {
        return Err(Error::BlockhashMargin);
    }
    Ok(Report {
        shape: Shape {
            bytes,
            locks: keys,
            writes,
            sigs,
        },
        remaining_block_heights,
    })
}
