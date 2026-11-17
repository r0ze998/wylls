//! Test-only native SDK to official System-program bridge.
//!
//! Before each CPI, official ABIv1 writeback validates the caller's changes.
//! InvokeContext then derives PDA signers and checks CPI privileges, and the
//! cached official System Entrypoint performs the transfer/allocation/assign.
//! Only its successful state is copied back into the same SDK ABI buffer.
//! This adapter is not the SBF CPI syscall/VM and does not authenticate wallets.
//! A fresh per-CPI budget is used; transaction-wide compute accounting is not tested.
use super::*;
use solana_program::{
    instruction::Instruction,
    program_stubs::{set_syscall_stubs, SyscallStubs},
};
use solana_program_runtime::{
    execution_budget::{SVMTransactionExecutionBudget, SVMTransactionExecutionCost},
    invoke_context::{EnvironmentConfig, InvokeContext},
    loaded_programs::{
        ProgramCacheForTxBatch, ProgramRuntimeEnvironment, ProgramRuntimeEnvironments,
    },
    memory_context::SerializedAccountMetadata,
    program_cache_entry::ProgramCacheEntry,
    solana_sbpf::{
        aligned_memory::AlignedMemory,
        ebpf::{HOST_ALIGN, MM_INPUT_START},
        program::{BuiltinFunctionDefinition, BuiltinProgram},
        vm::Config,
    },
    sysvar_cache::SysvarCache,
};
use solana_svm_callback::InvokeContextCallback;
use solana_svm_feature_set::SVMFeatureSet;
use std::{
    cell::RefCell,
    sync::{Arc, Mutex},
};

pub type Logs = Vec<Vec<Vec<u8>>>;
#[derive(Debug)]
pub struct Output {
    pub accounts: Vec<AccountSharedData>,
    pub logs: Logs,
    pub cpis: Vec<Instruction>,
}
struct Callback;
impl InvokeContextCallback for Callback {}
struct State {
    context: TransactionContext<'static>,
    buffer: AlignedMemory<HOST_ALIGN>,
    metadata: Vec<SerializedAccountMetadata>,
    logs: Logs,
    cpis: Vec<Instruction>,
    failure: Option<RunError>,
}
thread_local! { static ACTIVE: RefCell<Option<State>> = const { RefCell::new(None) }; }
static SERIAL: Mutex<()> = Mutex::new(());

impl State {
    fn flush(&self) -> Result<(), RunError> {
        let current = self
            .context
            .get_current_instruction_context()
            .map_err(RunError::Fixture)?;
        deserialize_parameters(
            &current,
            false,
            false,
            self.buffer.as_slice(),
            &self.metadata,
        )
        .map_err(RunError::Writeback)
    }
    fn cpi(
        &mut self,
        instruction: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), RunError> {
        if instruction.program_id != solana_system_program::id() {
            return Err(RunError::Cpi(InstructionError::UnsupportedProgramId));
        }
        // Only the two audited boundary-initializer operations are admitted.
        let opcode = instruction
            .data
            .get(..4)
            .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
            .map(u32::from_le_bytes);
        if !matches!(opcode, Some(2 | 9)) {
            return Err(RunError::Cpi(InstructionError::InvalidInstructionData));
        }
        // Refuse fabricated AccountInfos, even if their public keys match.
        // Every account passed must address this exact official ABI allocation.
        let caller = self
            .context
            .get_current_instruction_context()
            .map_err(RunError::Fixture)?;
        let system_index = self
            .context
            .find_index_of_account(&instruction.program_id)
            .ok_or(RunError::Cpi(InstructionError::MissingAccount))?;
        {
            let system = self
                .context
                .accounts()
                .try_borrow(system_index)
                .map_err(RunError::Fixture)?;
            if !system.executable() {
                return Err(RunError::Fixture(InstructionError::AccountNotExecutable));
            }
            if system.owner()
                != &Pubkey::from_str_const("NativeLoader1111111111111111111111111111111")
            {
                return Err(RunError::Fixture(InstructionError::IncorrectProgramId));
            }
        }
        for info in infos {
            let mut matched = false;
            for (role, meta) in self.metadata.iter().enumerate() {
                if caller
                    .get_key_of_instruction_account(role as u16)
                    .map_err(RunError::Fixture)?
                    != info.key
                {
                    continue;
                }
                let host =
                    |vm| self.buffer.as_slice().as_ptr() as usize + (vm - MM_INPUT_START) as usize;
                if info.key as *const _ as usize != host(meta.vm_key_addr)
                    || info.owner as *const _ as usize != host(meta.vm_owner_addr)
                    || info.try_borrow_data().map_err(RunError::Helper)?.as_ptr() as usize
                        != host(meta.vm_data_addr)
                    || (&**info.try_borrow_lamports().map_err(RunError::Helper)?) as *const u64
                        as usize
                        != host(meta.vm_lamports_addr)
                {
                    return Err(RunError::Fixture(InstructionError::InvalidArgument));
                }
                matched = true;
                break;
            }
            if !matched {
                return Err(RunError::Fixture(InstructionError::MissingAccount));
            }
        }
        if instruction
            .accounts
            .iter()
            .any(|meta| !infos.iter().any(|info| *info.key == meta.pubkey))
        {
            return Err(RunError::Cpi(InstructionError::MissingAccount));
        }
        drop(caller);
        self.flush()?;
        let mut cache = ProgramCacheForTxBatch::new(1);
        cache.replenish(
            solana_system_program::id(),
            Arc::new(ProgramCacheEntry::new_builtin(
                0,
                0,
                solana_system_program::system_processor::Entrypoint::register,
            )),
        );
        let runtime =
            ProgramRuntimeEnvironment::from(BuiltinProgram::new_loader(Config::default()));
        let environments = ProgramRuntimeEnvironments::new(runtime.clone(), runtime);
        let features = SVMFeatureSet::default();
        let sysvars = SysvarCache::default();
        let environment = EnvironmentConfig::new(
            Default::default(),
            0,
            false,
            &Callback,
            &features,
            &environments,
            &sysvars,
        );
        let mut invoke = InvokeContext::new(
            &mut self.context,
            &mut cache,
            environment,
            None,
            SVMTransactionExecutionBudget::new_with_defaults(false),
            SVMTransactionExecutionCost::default(),
        );
        // The root SDK caller already has a live TransactionContext frame.
        // System is a native builtin, so no SBF memory mapping is installed.
        invoke.memory_contexts.push_placeholder();
        invoke
            .native_invoke_signed(instruction.clone(), seeds)
            .map_err(RunError::Cpi)?;
        drop(invoke);
        // Synchronization only; never synthesize System results. Bounds are the
        // SDK's original-length limit. No native account/reference escapes run.
        for info in infos {
            let index = self
                .context
                .find_index_of_account(info.key)
                .ok_or(RunError::Fixture(InstructionError::MissingAccount))?;
            let account = self
                .context
                .accounts()
                .try_borrow(index)
                .map_err(RunError::Fixture)?;
            if info.data_len() != account.data().len() {
                info.resize(account.data().len())
                    .map_err(RunError::Helper)?;
            }
            if &**info.try_borrow_data().map_err(RunError::Helper)? != account.data() {
                info.try_borrow_mut_data()
                    .map_err(RunError::Helper)?
                    .copy_from_slice(account.data());
            }
            if info.lamports() != account.lamports() {
                **info.try_borrow_mut_lamports().map_err(RunError::Helper)? = account.lamports();
            }
            if info.owner != account.owner() {
                info.assign(account.owner());
            }
        }
        self.cpis.push(instruction.clone());
        Ok(())
    }
}
struct Stubs;
impl SyscallStubs for Stubs {
    fn sol_invoke_signed(
        &self,
        instruction: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        ACTIVE.with(|active| {
            let mut active = active.borrow_mut();
            let state = active
                .as_mut()
                .expect("CPI outside bounded runtime-contract run");
            if state.failure.is_some() {
                return Err(ProgramError::InvalidArgument);
            }
            match state.cpi(instruction, infos, seeds) {
                Ok(()) => Ok(()),
                Err(error) => {
                    state.failure = Some(error);
                    Err(ProgramError::InvalidArgument)
                }
            }
        })
    }
    fn sol_log_data(&self, fields: &[&[u8]]) {
        ACTIVE.with(|active| {
            active
                .borrow_mut()
                .as_mut()
                .expect("log outside bounded run")
                .logs
                .push(fields.iter().map(|v| v.to_vec()).collect())
        });
    }
}
struct Guard(Option<Box<dyn SyscallStubs>>);
impl Drop for Guard {
    fn drop(&mut self) {
        set_syscall_stubs(self.0.take().unwrap());
        ACTIVE.with(|active| {
            active.borrow_mut().take();
        });
    }
}

/// Execute an audited native helper with real official System CPI processing.
///
/// No Transaction, keypair, signing, RPC, bank, SBF or rollback is involved.
/// Any failed CPI poisons this disposable run, even if the helper catches it;
/// failure returns neither account snapshots nor successful records.
///
/// # Safety
/// In addition to `super::run`'s SDK aliasing contract, the helper must release
/// all data/lamport borrows before invoking CPI. This process-global syscall
/// hook must run in an isolated, serial filtered test process. The official
/// aligned buffer is kept alive until all native AccountInfos have been dropped.
/// The shim's SDK refresh is operational ABI coverage, not a Rust soundness proof
/// or evidence for SBF caller-memory synchronization.
pub unsafe fn run<F>(
    accounts: Vec<(Pubkey, AccountSharedData)>,
    program_index: u16,
    privileges: Vec<InstructionAccount>,
    instruction_data: Vec<u8>,
    helper: F,
) -> Result<Output, RunError>
where
    F: for<'buffer, 'borrow> FnOnce(
        &'buffer Pubkey,
        &'borrow [AccountInfo<'buffer>],
        &'buffer [u8],
    ) -> Result<(), ProgramError>,
{
    validate_fixture(&accounts, program_index, &privileges, &instruction_data)?;
    ACTIVE.with(|active| {
        assert!(
            active.borrow().is_none(),
            "nested runtime-contract runs forbidden"
        )
    });
    let _serial = SERIAL.lock().unwrap();
    let mut context = TransactionContext::new(accounts, Rent::default(), 4, 64, 1);
    context
        .configure_top_level_instruction_for_tests(program_index, privileges, instruction_data)
        .map_err(RunError::Fixture)?;
    context.push().map_err(RunError::Fixture)?;
    let (buffer, regions, metadata, _) = {
        let current = context
            .get_current_instruction_context()
            .map_err(RunError::Fixture)?;
        serialize_parameters(&current, false, false, false).map_err(RunError::Fixture)?
    };
    drop(regions);
    ACTIVE.with(|active| {
        *active.borrow_mut() = Some(State {
            context,
            buffer,
            metadata,
            logs: vec![],
            cpis: vec![],
            failure: None,
        })
    });
    let guard = Guard(Some(set_syscall_stubs(Box::new(Stubs))));
    let ptr = ACTIVE.with(|active| {
        active
            .borrow_mut()
            .as_mut()
            .unwrap()
            .buffer
            .as_slice_mut()
            .as_mut_ptr()
    });
    let result = {
        // SAFETY: official aligned ABIv1 backing, owned by ACTIVE for this run.
        // No value referring to it survives this scope or is returned by helper.
        let (program, infos, data) = unsafe { solana_program::entrypoint::deserialize(ptr) };
        let result = helper(program, &infos, data);
        drop(infos);
        result
    };
    let mut state = ACTIVE.with(|active| active.borrow_mut().take().unwrap());
    drop(guard);
    if let Some(error) = state.failure.take() {
        return Err(error);
    }
    result.map_err(RunError::Helper)?;
    state.flush()?;
    state.context.pop().map_err(RunError::Balance)?;
    Ok(Output {
        accounts: state
            .context
            .deconstruct_without_keys()
            .map_err(RunError::Fixture)?,
        logs: state.logs,
        cpis: state.cpis,
    })
}
