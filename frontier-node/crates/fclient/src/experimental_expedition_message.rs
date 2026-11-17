//! Explicit unsigned construction for the host-only expedition dispatch build.
//! The default client still exposes closed proposals only. Enabling this module
//! does not prove deployment, ownership, custody, seal validity or relay policy.
//! No signing/send API or secret-key parameter exists here.
use crate::tx::TxBudget;
use crate::unsigned_message_preflight::{self as preflight, BlockhashObservation, Limits, Report};
use crate::{original_expedition_depart_draft, wide_resident_draft};
use frontier_abi::world_index::{expedition_dispatch_ix as wire, expedition_resident_ix::Action};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::Message;

/// The heap frame every original-host Depart requests: fixed, the runtime's maximum (256 KiB), never a caller's
/// choice. Measured on the real `localnet-expedition-sbf` program (itest `localnet_expedition_depart`): with the
/// default 32 KiB heap the Depart ends in an access violation in the heap region; with this frame it completes
/// (88,405 CU). Exactly this value, or the Depart is not prepared; resident actions have their separately fixed frame below.
pub const DEPART_HEAP_FRAME: u32 = 256 * 1024;

/// Resident snapshot pairs plus receipt validation exceed 32 KiB even before allocator overhead.
/// Fixed frame for Dissolve/Return; not a caller setting or a claim of SBF success.
pub const RESIDENT_HEAP_FRAME: u32 = 256 * 1024;

/// Explicit caller-selected public target. This is not a verified deployment
/// observation; the actual program must repeat Season/version/ownership checks.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub program: Address,
    pub season: Address,
    pub program_version: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Target,
    Version,
    Budget,
    Envelope,
    Encoding,
    Preflight(preflight::Error),
}

/// Instructions and Message contain only public bytes. The report describes
/// shape/blockhash checks, never runtime execution, authorization or admission.
pub struct Prepared {
    instruction: Instruction,
    message: Message,
    expected_signers: Vec<Address>,
    report: Report,
}
impl Prepared {
    /// Serialize only the public unsigned Message, without signature slots or
    /// a Transaction envelope. The caller cannot mistake this for signed wire.
    pub fn message_bytes(&self) -> Result<Vec<u8>, Error> {
        bincode::serialize(&self.message).map_err(|_| Error::Encoding)
    }
    pub fn instruction(&self) -> &Instruction {
        &self.instruction
    }
    pub fn message(&self) -> &Message {
        &self.message
    }
    pub fn expected_signers(&self) -> &[Address] {
        &self.expected_signers
    }
    pub const fn report(&self) -> Report {
        self.report
    }
    pub const fn admitted(&self) -> bool {
        false
    }
    pub const fn deployment_verified(&self) -> bool {
        false
    }
    pub const fn relay_submission_available(&self) -> bool {
        false
    }
}

/// Use the canonical wallet departure roles, never caller-selected role bytes.
/// Commit/ciphertext stay opaque inputs of the original proposal; this does not
/// create or validate a seal. Every call compiles against a fresh observation.
pub fn prepare_depart(
    draft: &original_expedition_depart_draft::Draft,
    target: Target,
    observation: BlockhashObservation,
    budget: TxBudget,
    limits: Limits,
) -> Result<Prepared, Error> {
    let roles = draft.roles();
    let keys = roles
        .iter()
        .map(|r| AccountMeta {
            pubkey: r.address,
            is_signer: r.signer,
            is_writable: r.writable,
        })
        .collect();
    let mut signers = vec![roles[1].address];
    if roles[0].address != roles[1].address {
        signers.push(roles[0].address);
    }
    prepare(
        draft.program(),
        draft.season(),
        target,
        wire::Kind::Depart,
        &draft.proposed_bytes(),
        keys,
        signers,
        observation,
        budget,
        limits,
    )
}

/// Dissolve requires actor and payer; Return requires only its canonical payer.
/// No capture/leave-resolution transition is inferred from the selected action.
pub fn prepare_resident(
    draft: &wide_resident_draft::Draft,
    target: Target,
    observation: BlockhashObservation,
    budget: TxBudget,
    limits: Limits,
) -> Result<Prepared, Error> {
    let roles = draft.roles();
    let (kind, payer_index) = match draft.command().action() {
        Action::Dissolve => (wire::Kind::Dissolve, 1),
        Action::Return => (wire::Kind::Return, 0),
    };
    let keys = roles
        .iter()
        .map(|r| AccountMeta {
            pubkey: r.address,
            is_signer: r.signer,
            is_writable: r.writable,
        })
        .collect();
    let mut signers = vec![roles[payer_index].address];
    if payer_index == 1 && roles[0].address != roles[1].address {
        signers.push(roles[0].address);
    }
    prepare(
        draft.program(),
        draft.season(),
        target,
        kind,
        &draft.proposed_bytes(),
        keys,
        signers,
        observation,
        budget,
        limits,
    )
}

/// The heap frame of a wrapped DeclareSiege. LOCAL DECISION, not a published
/// contract value: the conquest dispatch contract names no heap. It enters
/// through the same versioned wrapper and Season admission as Depart and the
/// resident steps, which needed exactly this frame on the real program, so the
/// same frame is requested. To be confirmed (or corrected) by the first real
/// SBF execution of the conquest lane.
#[cfg(feature = "conquest-dispatch-experimental")]
pub const CONQUEST_DECLARE_HEAP_FRAME: u32 = 256 * 1024;

/// The wallet-signed DeclareSiege (kind 12): the canonical roles of the draft,
/// the ABI's own inner bytes, one signer (the wallet acts and pays). The kind
/// is the ABI's `Kind::of_conquest` of those bytes, never a number chosen here.
#[cfg(feature = "conquest-dispatch-experimental")]
pub fn prepare_conquest_declare(
    draft: &crate::wide_conquest_draft::Draft,
    target: Target,
    observation: BlockhashObservation,
    budget: TxBudget,
    limits: Limits,
) -> Result<Prepared, Error> {
    let roles = draft.roles();
    if roles.len() != 12 || roles[0].address != roles[1].address {
        return Err(Error::Envelope);
    }
    let inner = draft.inner_bytes();
    let kind = wire::Kind::of_conquest(&inner).ok_or(Error::Envelope)?;
    if kind != wire::Kind::DeclareSiege {
        return Err(Error::Envelope);
    }
    let keys = roles
        .iter()
        .map(|r| AccountMeta {
            pubkey: r.address,
            is_signer: r.signer,
            is_writable: r.writable,
        })
        .collect();
    prepare(
        draft.program(),
        draft.season(),
        target,
        kind,
        &inner,
        keys,
        vec![roles[1].address],
        observation,
        budget,
        limits,
    )
}

#[allow(clippy::too_many_arguments)]
fn prepare(
    program: Address,
    season: Address,
    target: Target,
    kind: wire::Kind,
    inner: &[u8],
    accounts: Vec<AccountMeta>,
    expected_signers: Vec<Address>,
    observation: BlockhashObservation,
    budget: TxBudget,
    limits: Limits,
) -> Result<Prepared, Error> {
    if target.program != program || target.season != season {
        return Err(Error::Target);
    }
    if target.program_version != wire::PROGRAM_VERSION {
        return Err(Error::Version);
    }
    // Keep the existing sponsored-player prefix (limit/zero price/data limit).
    // Limits are explicit inputs, not measurements of this host-only program.
    // The heap frame is part of the kind, not of the caller's budget: a Depart carries exactly
    // DEPART_HEAP_FRAME, Dissolve/Return carry RESIDENT_HEAP_FRAME, other kinds none.
    let heap = match kind {
        wire::Kind::Depart => Some(DEPART_HEAP_FRAME),
        wire::Kind::Dissolve | wire::Kind::Return => Some(RESIDENT_HEAP_FRAME),
        #[cfg(feature = "conquest-dispatch-experimental")]
        wire::Kind::DeclareSiege => Some(CONQUEST_DECLARE_HEAP_FRAME),
        _ => None,
    };
    if budget.cu_limit == 0
        || budget.loaded_limit == 0
        || budget.cu_price != 0
        || budget.heap != heap
    {
        return Err(Error::Budget);
    }
    let data = wire::encode(kind, inner).map_err(|_| Error::Envelope)?;
    let instruction = Instruction {
        program_id: program,
        accounts,
        data,
    };
    let payer = expected_signers[0];
    let message = crate::tx::message(
        std::slice::from_ref(&instruction),
        &budget,
        &payer,
        &Hash::new_from_array(observation.blockhash),
    );
    // The compiled prefix is exactly: limit, zero price, loaded-data limit, then the one fixed heap frame of the supported kind;
    // the dispatch instruction is last. Nothing else is in the message.
    let prefix = budget.instructions();
    if prefix.len() != 3 + usize::from(heap.is_some())
        || message.instructions.len() != prefix.len() + 1
        || prefix.iter().zip(&message.instructions).any(|(want, got)| {
            message.account_keys.get(usize::from(got.program_id_index)) != Some(&want.program_id)
                || !got.accounts.is_empty()
                || got.data != want.data
        })
    {
        return Err(Error::Budget);
    }
    let report = preflight::inspect(&message, &expected_signers, observation, limits)
        .map_err(Error::Preflight)?;
    Ok(Prepared {
        instruction,
        message,
        expected_signers,
        report,
    })
}
