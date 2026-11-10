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
    if budget.cu_limit == 0
        || budget.loaded_limit == 0
        || budget.cu_price != 0
        || budget.heap.is_some()
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
    let report = preflight::inspect(&message, &expected_signers, observation, limits)
        .map_err(Error::Preflight)?;
    Ok(Prepared {
        instruction,
        message,
        expected_signers,
        report,
    })
}
