//! Unsigned, disposable native runtime-contract boundary.
//!
//! This does not emulate signatures, CPI, the SBF VM, or a bank transaction.
//! Signer bits below are fixture privileges, never authenticated signatures.
//! The SDK's unsafe entrypoint deserializer remains part of this test route.

pub use solana_account::{AccountSharedData, ReadableAccount, WritableAccount};
pub use solana_instruction::error::InstructionError;
pub use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
pub use solana_transaction_context::instruction_accounts::InstructionAccount;

use solana_program_runtime::serialization::{deserialize_parameters, serialize_parameters};
use solana_rent::Rent;
use solana_transaction_context::transaction::TransactionContext;

#[derive(Debug, PartialEq)]
pub enum RunError {
    Fixture(InstructionError),
    Helper(ProgramError),
    Writeback(InstructionError),
    Balance(InstructionError),
    Cpi(InstructionError),
}

/// Run a private program helper against official runtime-serialized accounts.
///
/// Account snapshots are exposed only after successful helper execution,
/// official writeback, and the runtime's instruction balance check. On any
/// error the entire disposable context is dropped, including any partial
/// writeback; the caller's originals should be retained outside this function.
/// No successful CPI stub or transaction/signing API is installed or invoked.
///
/// # Safety
/// This deliberately exercises the SDK's unsafe native entrypoint ABI, not a
/// Rust soundness proof. The closure must not retain or leak AccountInfo clones,
/// references, or pointers and must obey the SDK AccountInfo mutation contract.
/// Do not invoke it with arbitrary bytes: this function only passes its own
/// official aligned serializer output to the SDK. Use a non-deprecated loader
/// owner for the program account; ABIv0 is rejected before deserialization.
pub unsafe fn run<F>(
    accounts: Vec<(Pubkey, AccountSharedData)>,
    program_index: u16,
    privileges: Vec<InstructionAccount>,
    instruction_data: Vec<u8>,
    helper: F,
) -> Result<Vec<AccountSharedData>, RunError>
where
    F: for<'buffer, 'borrow> FnOnce(
        &'buffer Pubkey,
        &'borrow [AccountInfo<'buffer>],
        &'buffer [u8],
    ) -> Result<(), ProgramError>,
{
    validate_fixture(&accounts, program_index, &privileges, &instruction_data)?;
    let mut context = TransactionContext::new(accounts, Rent::default(), 1, 1, 1);
    context
        .configure_top_level_instruction_for_tests(program_index, privileges, instruction_data)
        .map_err(RunError::Fixture)?;
    context.push().map_err(RunError::Fixture)?;
    {
        let instruction = context
            .get_current_instruction_context()
            .map_err(RunError::Fixture)?;
        let (mut buffer, regions, metadata, _) =
            serialize_parameters(&instruction, false, false, false).map_err(RunError::Fixture)?;
        // No direct-account pointers or split address-space mapping. The
        // official serializer owns the complete aligned ABIv1 allocation and
        // original-length/growth metadata required by realloc/assign.
        drop(regions);
        {
            // SAFETY: fresh official ABIv1 serialization; owned aligned buffer
            // stays alive and unmoved through this bounded closure. The caller
            // is responsible for the SDK mutation contract documented above.
            let (program_id, infos, data) = unsafe {
                solana_program::entrypoint::deserialize(buffer.as_slice_mut().as_mut_ptr())
            };
            helper(program_id, &infos, data).map_err(RunError::Helper)?;
            // Drop every AccountInfo before reading the serialized memory again.
            drop(infos);
        }
        deserialize_parameters(&instruction, false, false, buffer.as_slice(), &metadata)
            .map_err(RunError::Writeback)?;
    }
    context.pop().map_err(RunError::Balance)?;
    context
        .deconstruct_without_keys()
        .map_err(RunError::Fixture)
}

fn validate_fixture(
    accounts: &[(Pubkey, AccountSharedData)],
    program_index: u16,
    privileges: &[InstructionAccount],
    instruction_data: &[u8],
) -> Result<(), RunError> {
    if accounts.len() > 256
        || privileges.len() > 255
        || usize::from(program_index) >= accounts.len()
        || privileges
            .iter()
            .any(|a| usize::from(a.index_in_transaction) >= accounts.len())
        || instruction_data.len() > 10 * 1024
        || accounts.iter().any(|(_, account)| {
            account.data().len() as u64 > solana_transaction_context::MAX_ACCOUNT_DATA_LEN
        })
    {
        return Err(RunError::Fixture(InstructionError::InvalidArgument));
    }
    // The SDK reuses the first serialized AccountInfo for duplicates. Reject
    // conflicting privileges instead of silently letting account order choose
    // which signer/writable bits the helper observes. Identical duplicates are
    // still supported and share the official serializer's backing storage.
    for (index, account) in privileges.iter().enumerate() {
        if privileges[..index].iter().any(|prior| {
            prior.index_in_transaction == account.index_in_transaction
                && (prior.is_signer() != account.is_signer()
                    || prior.is_writable() != account.is_writable())
        }) {
            return Err(RunError::Fixture(InstructionError::InvalidArgument));
        }
    }
    if accounts[usize::from(program_index)].1.owner()
        == &solana_program::bpf_loader_deprecated::id()
    {
        return Err(RunError::Fixture(InstructionError::IncorrectProgramId));
    }
    // Identical keys must be represented by one transaction index plus duplicate
    // instruction indices. Distinct storage for the same key is not a fixture.
    for (index, (key, _)) in accounts.iter().enumerate() {
        if accounts[..index].iter().any(|(prior, _)| prior == key) {
            return Err(RunError::Fixture(InstructionError::InvalidArgument));
        }
    }
    Ok(())
}

#[cfg(feature = "system-cpi")]
pub mod system_cpi;
