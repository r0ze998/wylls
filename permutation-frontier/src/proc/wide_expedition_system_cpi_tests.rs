//! Exact-filter-only native System CPI checks. Literal fixture signer flags
//! are not wallet signatures. PDA derivation is address authorization only.
//! No Transaction, private key, signing, RPC, SBF or public gate is used.
use super::*;
use runtime_contract_support::{
    self as rt, AccountSharedData, InstructionAccount, InstructionError, ReadableAccount, RunError,
    WritableAccount,
};

struct Input {
    accounts: Vec<(Pubkey, AccountSharedData)>,
    roles: Vec<InstructionAccount>,
    command: wix::ExpeditionDepart,
}
fn literal(owner: Pubkey, balance: u64, data: &[u8]) -> AccountSharedData {
    let mut account = AccountSharedData::new(balance, data.len(), &owner);
    account.set_data_from_slice(data);
    account
}
impl Input {
    fn fixture(prefund: u64) -> Self {
        let (a, command) = fixture();
        let mut accounts: Vec<(Pubkey, AccountSharedData)> = vec![];
        let mut roles = vec![];
        for ai in &a {
            let index = accounts
                .iter()
                .position(|(key, _)| key == ai.key)
                .unwrap_or_else(|| {
                    accounts.push((
                        *ai.key,
                        literal(*ai.owner, ai.lamports(), &ai.try_borrow_data().unwrap()),
                    ));
                    accounts.len() - 1
                });
            roles.push(InstructionAccount::new(
                index as u16,
                ai.is_signer,
                ai.is_writable,
            ));
        }
        let mut input = Self {
            accounts,
            roles,
            command,
        };
        input.account_mut(8).set_lamports(prefund);
        let system = input.account_mut(6);
        system.set_owner(Pubkey::from_str_const(
            "NativeLoader1111111111111111111111111111111",
        ));
        system.set_executable(true);
        input
    }
    fn index(&self, role: usize) -> usize {
        self.roles[role].index_in_transaction as usize
    }
    fn account_mut(&mut self, role: usize) -> &mut AccountSharedData {
        let index = self.index(role);
        &mut self.accounts[index].1
    }
    fn run<F>(&self, helper: F) -> Result<rt::system_cpi::Output, RunError>
    where
        F: for<'buffer, 'borrow> FnOnce(
            &'buffer Pubkey,
            &'borrow [AccountInfo<'buffer>],
            &'buffer [u8],
        )
            -> Result<(), solana_program::program_error::ProgramError>,
    {
        let mut accounts = self.accounts.clone();
        let index = accounts.len() as u16;
        let mut program = literal(solana_program::bpf_loader::id(), 1, &[]);
        program.set_executable(true);
        accounts.push((Pubkey::new_from_array(PROGRAM), program));
        // SAFETY: audited helpers release every borrow before CPI and retain
        // no AccountInfo, pointer or reference beyond this scoped callback.
        unsafe { rt::system_cpi::run(accounts, index, self.roles.clone(), vec![], helper) }
    }
    fn depart(&self) -> Result<rt::system_cpi::Output, RunError> {
        self.run(|program, accounts, _| {
            execute_depart(program, accounts, &self.command, &Auth::Wallet).map_err(Into::into)
        })
    }
}

#[test]
fn real_system_cpi_departure_creates_bridge_with_prefunding_and_rejects_replay() {
    let rent = init::rent(OWNED_BRIDGE_LEN).unwrap();
    for prefund in [0, rent - 1, rent + 17] {
        let input = Input::fixture(prefund);
        let before_payer = input.accounts[input.index(1)].1.lamports();
        let before_holding = input.accounts[input.index(4)].1.lamports();
        let output = input
            .depart()
            .expect("actual native System CPIs and official writeback");
        let target = &output.accounts[input.index(8)];
        assert_eq!(target.owner().to_bytes(), PROGRAM);
        assert_eq!(target.data().len(), OWNED_BRIDGE_LEN);
        assert_eq!(target.lamports(), prefund.max(rent));
        assert_eq!(
            output.accounts[input.index(1)].lamports(),
            before_payer - input.command.tip - rent.saturating_sub(prefund)
        );
        assert_eq!(
            output.accounts[input.index(4)].lamports(),
            before_holding + input.command.tip
        );
        let ctx = addr::ctx(&input.accounts[input.index(2)].0.to_bytes(), &PROGRAM);
        let bridge = OwnedBridgeTransit::from_bytes(&ctx, target.data()).unwrap();
        assert_eq!(
            bridge.original_owner(),
            input.accounts[input.index(3)].0.to_bytes()
        );
        assert_eq!(bridge.transit().host.to_bytes(), input.command.host);
        assert_eq!(bridge.transit().state, MarchState::Departed);
        let entry = read_entry(output.accounts[input.index(5)].data(), 0).unwrap();
        assert!(matches!(entry.op, EntryOp::Spend { .. }));
        assert_eq!(entry.troops, 200_000);
        assert_eq!(output.logs.len(), 1);
        assert_eq!(output.logs[0][0], receipt::PREFIX);
        let kinds: Vec<_> = output
            .cpis
            .iter()
            .map(|ix| u32::from_le_bytes(ix.data[..4].try_into().unwrap()))
            .collect();
        assert_eq!(
            kinds,
            if prefund < rent {
                vec![2, 2, 9]
            } else {
                vec![2, 9]
            }
        );
        let before_total: u128 = input
            .accounts
            .iter()
            .map(|(_, account)| account.lamports() as u128)
            .sum();
        assert_eq!(
            output
                .accounts
                .iter()
                .map(|account| account.lamports() as u128)
                .sum::<u128>(),
            before_total + 1
        );
        let mut repeated = Input::fixture(prefund);
        for ((_, account), next) in repeated.accounts.iter_mut().zip(&output.accounts) {
            *account = next.clone();
        }
        assert!(matches!(repeated.depart(), Err(RunError::Helper(_))));
    }
}

#[test]
fn real_system_cpi_rejects_privilege_escalation_bad_seed_and_unauthorized_caller_write() {
    let input = Input::fixture(0);
    assert!(matches!(
        input.run(|_, a, _| init::transfer(&a[1], &a[8], 1_000_000_001).map_err(Into::into)),
        Err(RunError::Cpi(InstructionError::Custom(_)))
    ));
    let mut input = Input::fixture(0);
    let payer = input.roles[1].index_in_transaction;
    input.roles[1] = InstructionAccount::new(payer, false, true);
    assert!(matches!(
        input.run(|_, a, _| init::transfer(&a[1], &a[8], 1).map_err(Into::into)),
        Err(RunError::Cpi(InstructionError::PrivilegeEscalation))
    ));
    let mut input = Input::fixture(0);
    let target = input.roles[8].index_in_transaction;
    input.roles[8] = InstructionAccount::new(target, false, false);
    assert!(matches!(
        input.run(|_, a, _| init::transfer(&a[1], &a[8], 1).map_err(Into::into)),
        Err(RunError::Cpi(InstructionError::PrivilegeEscalation))
    ));
    let input = Input::fixture(0);
    assert!(matches!(
        input.run(|p, a, _| {
            let bump = Ro(&a[2].try_borrow_data()?).u8(S::BUMP).unwrap();
            init::init_with_seed(
                &a[1],
                &a[8],
                &a[2],
                &SeasonSigner::new(SID + 1, bump),
                &wm::transit_seed(&key(&a[4]), 0),
                OWNED_BRIDGE_LEN,
                init::rent(OWNED_BRIDGE_LEN).unwrap(),
                p,
            )
            .map_err(Into::into)
        }),
        Err(RunError::Cpi(_))
    ));
    let input = Input::fixture(0);
    assert!(matches!(
        input.run(|_, a, _| {
            **a[1].try_borrow_mut_lamports()? -= 1;
            **a[8].try_borrow_mut_lamports()? += 1;
            init::transfer(&a[1], &a[8], 1).map_err(Into::into)
        }),
        Err(RunError::Writeback(
            InstructionError::ExternalAccountLamportSpend
        ))
    ));
    let input = Input::fixture(0);
    let before = input.accounts.clone();
    assert!(matches!(
        input.run(|_, a, _| {
            init::transfer(&a[1], &a[8], 1)
                .map_err(solana_program::program_error::ProgramError::from)?;
            Err(solana_program::program_error::ProgramError::Custom(42))
        }),
        Err(RunError::Helper(
            solana_program::program_error::ProgramError::Custom(42)
        ))
    ));
    assert_eq!(input.accounts, before); // disposable-context isolation, not rollback
}

#[test]
fn real_system_cpi_rejects_missing_infos_forged_backing_bad_address_and_program() {
    use solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    };
    let input = Input::fixture(0);
    let missing = input.run(|p, a, _| {
        let seed = wm::transit_seed(&key(&a[4]), 0);
        let bytes = seed.as_bytes();
        let mut data = 9u32.to_le_bytes().to_vec();
        data.extend_from_slice(a[2].key.as_ref());
        data.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        data.extend_from_slice(bytes);
        data.extend_from_slice(&(OWNED_BRIDGE_LEN as u64).to_le_bytes());
        data.extend_from_slice(p.as_ref());
        let instruction = Instruction {
            program_id: init::SYSTEM,
            accounts: vec![
                AccountMeta::new(*a[8].key, false),
                AccountMeta::new_readonly(*a[2].key, true),
            ],
            data,
        };
        let bump = Ro(&a[2].try_borrow_data()?).u8(S::BUMP).unwrap();
        let signer = SeasonSigner::new(SID, bump);
        // The base exists in TransactionContext but is deliberately omitted
        // from the SDK CPI AccountInfo list. It must not be silently supplied.
        invoke_signed(&instruction, &[a[8].clone()], &[&signer.seeds()])
    });
    assert!(matches!(
        missing,
        Err(RunError::Cpi(InstructionError::MissingAccount))
    ));
    let input = Input::fixture(0);
    let forged = input.run(|_, a, _| {
        let mut fake = a[8].clone();
        fake.key = Box::leak(Box::new(*a[8].key));
        init::transfer(&a[1], &fake, 1).map_err(Into::into)
    });
    assert!(matches!(
        forged,
        Err(RunError::Fixture(InstructionError::InvalidArgument))
    ));
    let mut input = Input::fixture(0);
    let target = input.index(8);
    input.accounts[target].0 = Pubkey::new_from_array([0xed; 32]);
    let wrong_address = input.run(|p, a, _| {
        let bump = Ro(&a[2].try_borrow_data()?).u8(S::BUMP).unwrap();
        init::init_with_seed(
            &a[1],
            &a[8],
            &a[2],
            &SeasonSigner::new(SID, bump),
            &wm::transit_seed(&key(&a[4]), 0),
            OWNED_BRIDGE_LEN,
            0,
            p,
        )
        .map_err(Into::into)
    });
    assert!(matches!(
        wrong_address,
        Err(RunError::Cpi(InstructionError::Custom(5)))
    ));
    let mut input = Input::fixture(0);
    input.roles.remove(6); // System account exists globally but is not in caller roles.
    assert!(matches!(
        input.run(|_, a, _| init::transfer(&a[1], &a[7], 1).map_err(Into::into)),
        Err(RunError::Cpi(InstructionError::MissingAccount))
    ));
    let mut input = Input::fixture(0);
    input.account_mut(6).set_executable(false);
    assert!(matches!(
        input.run(|_, a, _| init::transfer(&a[1], &a[8], 1).map_err(Into::into)),
        Err(RunError::Fixture(InstructionError::AccountNotExecutable))
    ));
    let mut input = Input::fixture(0);
    input
        .account_mut(6)
        .set_owner(Pubkey::new_from_array(PROGRAM));
    assert!(matches!(
        input.run(|_, a, _| init::transfer(&a[1], &a[8], 1).map_err(Into::into)),
        Err(RunError::Fixture(InstructionError::IncorrectProgramId))
    ));
}
