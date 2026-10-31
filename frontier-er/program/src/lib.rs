//! `frontier-er-board`: **candidate, not adopted, not deployed.** The board
//! of `frontier_er::board` as a program a continuing world can delegate to
//! a MagicBlock ER and bring home, with the delegation program's escape.
//! It is a separate program with its own id: the S1 program
//! (`permutation-frontier`) is untouched, and none of these instructions is
//! an S1 tag (the integrator's registry, ④, assigns those if it is ever
//! adopted).
//!
//! One board per world: the PDA `["wylls-er-board", le64 world_id]`. It
//! holds no value (rent only) and no ownership record; nothing the
//! settlement or the ownership rules read.
//!
//! | disc (u64 LE) | instruction | accounts | who |
//! |---|---|---|---|
//! | 0 | Init `{world}` | payer s,w · board w · system | the world's authority (stored) |
//! | 1 | Write `{world, expect_seq, req_id, payload, bell}` | writer s · board w | any signer (who may write is the use's rule, not decided) |
//! | 2 | Delegate `{world}` | authority s,w · system · board w · owner program · buffer w · record w · metadata w · DLP · validator | authority (it is the rent payer the escape needs) |
//! | 3 | Commit `{world}` | payer s · board w · magic program · magic context | anyone, on the ER |
//! | 4 | CommitAndUndelegate `{world}` | authority s · board w · magic program · magic context | authority, on the ER |
//! | 5 | RequestUndelegation `{world}` | authority s,w · board · owner program · request w · record · metadata w · system · DLP | authority, on the base |
//! | 6 | RollbackAfterTimeout `{world}` | board w · owner program · request w · record w · metadata w · rent payer w · commit state w · commit record w · reimbursement w · DLP | anyone, on the base, after the request expired |
//! | `[196,28,41,206,48,37,51,167]` | the DLP's undelegate callback `{seeds}` | board w · buffer s · payer s,w · system | the DLP only (buffer owned by it, signer) |
//!
//! Every write follows `frontier_er::board::apply`: compare-and-set on
//! `seq`, so a duplicate applies at most once whichever layer it reaches.

#![allow(unexpected_cfgs)]

use borsh::BorshDeserialize;
use ephemeral_rollups_sdk::consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID};
use ephemeral_rollups_sdk::cpi::{
    delegate_account, undelegate_account, DelegateAccounts, DelegateConfig, DELEGATION_PROGRAM_ID,
};
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use frontier_er::board::{self, Write, WriteErr};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::instruction as system_instruction;

pub const BOARD_SEED: &[u8] = b"wylls-er-board";
/// The delegation program's undelegate callback (dlp-api 3.1.0
/// `EXTERNAL_UNDELEGATE_DISCRIMINATOR`).
pub const UNDELEGATE_CALLBACK: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
/// `DlpDiscriminator::RequestUndelegation` / `UndelegateWithRollbackAfterTimeout`
/// (delegation program v2.0.1 `interface/src/legacy/discriminator.rs`).
pub const DLP_REQUEST_UNDELEGATION: u64 = 26;
pub const DLP_ROLLBACK_AFTER_TIMEOUT: u64 = 27;
/// Commit frequency asked of the validator; the keeper's planner commits
/// explicitly, so this only bounds how stale the base copy may get.
pub const COMMIT_FREQUENCY_MS: u32 = 60_000;

/// Program errors (custom codes, local to this candidate).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum BoardError {
    BadData = 1,
    WrongBoard = 2,
    NotAuthority = 3,
    StaleSeq = 4,
    Duplicate = 5,
    WrongDelegationProgram = 6,
    WrongMagicProgram = 7,
    NotDelegated = 8,
    BadContent = 9,
}

impl From<BoardError> for ProgramError {
    fn from(e: BoardError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub fn board_address(program: &Pubkey, world: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BOARD_SEED, &world.to_le_bytes()], program)
}

fn hashv(parts: &[&[u8]]) -> [u8; 32] {
    solana_program::hash::hashv(parts).to_bytes()
}

#[cfg(all(target_os = "solana", not(feature = "no-entrypoint")))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 8 {
        return Err(BoardError::BadData.into());
    }
    let (disc, rest) = data.split_at(8);
    if disc == UNDELEGATE_CALLBACK {
        let seeds = Vec::<Vec<u8>>::try_from_slice(rest).map_err(|_| BoardError::BadData)?;
        return undelegate_callback(program_id, accounts, seeds);
    }
    let disc = u64::from_le_bytes(disc.try_into().map_err(|_| BoardError::BadData)?);
    if rest.len() < 8 {
        return Err(BoardError::BadData.into());
    }
    let world = u64::from_le_bytes(rest[..8].try_into().map_err(|_| BoardError::BadData)?);
    let args = &rest[8..];
    match disc {
        0 => init(program_id, accounts, world),
        1 => write(program_id, accounts, world, args),
        2 => delegate(program_id, accounts, world),
        3 => commit(program_id, accounts, world, false),
        4 => commit(program_id, accounts, world, true),
        5 => request_undelegation(program_id, accounts, world),
        6 => rollback_after_timeout(program_id, accounts, world),
        _ => Err(BoardError::BadData.into()),
    }
}

fn account<'a, 'b>(a: &'a [AccountInfo<'b>], i: usize) -> Result<&'a AccountInfo<'b>, ProgramError> {
    a.get(i).ok_or(ProgramError::NotEnoughAccountKeys)
}

/// The board of `world` at its address, owned by this program (on the base
/// while not delegated; on the ER while delegated).
fn expect_board(program_id: &Pubkey, board: &AccountInfo, world: u64) -> Result<u8, ProgramError> {
    let (addr, bump) = board_address(program_id, world);
    if *board.key != addr {
        return Err(BoardError::WrongBoard.into());
    }
    Ok(bump)
}

fn owned_board(program_id: &Pubkey, board: &AccountInfo, world: u64) -> Result<u8, ProgramError> {
    let bump = expect_board(program_id, board, world)?;
    if board.owner != program_id {
        return Err(BoardError::NotDelegated.into());
    }
    let d = board.try_borrow_data()?;
    if board::header(&d).is_none() || board::world_of(&d) != world {
        return Err(BoardError::WrongBoard.into());
    }
    Ok(bump)
}

fn authority_of(d: &[u8]) -> Pubkey {
    let mut k = [0u8; 32];
    k.copy_from_slice(&d[board::AUTHORITY..board::AUTHORITY + 32]);
    Pubkey::new_from_array(k)
}

fn require_authority(board: &AccountInfo, who: &AccountInfo) -> ProgramResult {
    if !who.is_signer || authority_of(&board.try_borrow_data()?) != *who.key {
        return Err(BoardError::NotAuthority.into());
    }
    Ok(())
}

fn init(program_id: &Pubkey, a: &[AccountInfo], world: u64) -> ProgramResult {
    let payer = account(a, 0)?;
    let board_ai = account(a, 1)?;
    let system = account(a, 2)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let bump = expect_board(program_id, board_ai, world)?;
    if board_ai.lamports() != 0 || !board_ai.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let lamports = Rent::get()?.minimum_balance(board::SIZE);
    invoke_signed(
        &system_instruction::create_account(payer.key, board_ai.key, lamports, board::SIZE as u64, program_id),
        &[payer.clone(), board_ai.clone(), system.clone()],
        &[&[BOARD_SEED, &world.to_le_bytes(), &[bump]]],
    )?;
    let mut d = board_ai.try_borrow_mut_data()?;
    d.copy_from_slice(&board::new_board(world));
    d[board::AUTHORITY..board::AUTHORITY + 32].copy_from_slice(payer.key.as_ref());
    msg!("ERB init world {}", world);
    Ok(())
}

fn write(program_id: &Pubkey, a: &[AccountInfo], world: u64, args: &[u8]) -> ProgramResult {
    let writer = account(a, 0)?;
    let board_ai = account(a, 1)?;
    if !writer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    owned_board(program_id, board_ai, world)?;
    if args.len() != 8 + 32 + 32 + 4 {
        return Err(BoardError::BadData.into());
    }
    let mut w = Write {
        expect_seq: u64::from_le_bytes(args[..8].try_into().map_err(|_| BoardError::BadData)?),
        req_id: [0; 32],
        payload: [0; 32],
        bell: u32::from_le_bytes(args[72..76].try_into().map_err(|_| BoardError::BadData)?),
    };
    w.req_id.copy_from_slice(&args[8..40]);
    w.payload.copy_from_slice(&args[40..72]);
    let mut d = board_ai.try_borrow_mut_data()?;
    match board::apply_with(&mut d, world, &w, hashv) {
        Ok((seq, head)) => {
            // The record a reader chains: (seq, head, request).
            solana_program::log::sol_log_data(&[b"ERB", &seq.to_le_bytes(), &head, &w.req_id, &w.payload]);
            Ok(())
        }
        Err(WriteErr::StaleSeq { applied: true, .. }) => Err(BoardError::Duplicate.into()),
        Err(WriteErr::StaleSeq { .. }) => Err(BoardError::StaleSeq.into()),
        Err(WriteErr::BadAccount) => Err(BoardError::WrongBoard.into()),
    }
}

fn delegate(program_id: &Pubkey, a: &[AccountInfo], world: u64) -> ProgramResult {
    let authority = account(a, 0)?;
    let system = account(a, 1)?;
    let board_ai = account(a, 2)?;
    let owner_program = account(a, 3)?;
    let buffer = account(a, 4)?;
    let record = account(a, 5)?;
    let metadata = account(a, 6)?;
    let dlp = account(a, 7)?;
    let validator = account(a, 8)?;
    owned_board(program_id, board_ai, world)?;
    require_authority(board_ai, authority)?;
    if owner_program.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *dlp.key != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    let id = world.to_le_bytes();
    delegate_account(
        DelegateAccounts {
            payer: authority,
            pda: board_ai,
            owner_program,
            buffer,
            delegation_record: record,
            delegation_metadata: metadata,
            delegation_program: dlp,
            system_program: system,
        },
        &[BOARD_SEED, &id],
        DelegateConfig {
            commit_frequency_ms: COMMIT_FREQUENCY_MS,
            validator: Some(*validator.key),
        },
    )?;
    msg!("ERB delegated world {} to {}", world, validator.key);
    Ok(())
}

/// On the ER: schedule a commit, or commit-and-undelegate (the session's
/// end, authority only: sessions cost fees, so nobody else may churn them).
fn commit(program_id: &Pubkey, a: &[AccountInfo], world: u64, undelegate: bool) -> ProgramResult {
    let payer = account(a, 0)?;
    let board_ai = account(a, 1)?;
    let magic_program = account(a, 2)?;
    let magic_context = account(a, 3)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *magic_program.key != MAGIC_PROGRAM_ID || *magic_context.key != MAGIC_CONTEXT_ID {
        return Err(BoardError::WrongMagicProgram.into());
    }
    owned_board(program_id, board_ai, world)?;
    let b = MagicIntentBundleBuilder::new(payer.clone(), magic_context.clone(), magic_program.clone());
    if undelegate {
        require_authority(board_ai, payer)?;
        b.commit_and_undelegate(&[board_ai.clone()]).build_and_invoke()?;
    } else {
        b.commit(&[board_ai.clone()]).build_and_invoke()?;
    }
    msg!("ERB {} world {}", if undelegate { "undelegate" } else { "commit" }, world);
    Ok(())
}

/// The DLP hands the board back: only to its own address, with board bytes
/// of this world.
fn undelegate_callback(program_id: &Pubkey, a: &[AccountInfo], seeds: Vec<Vec<u8>>) -> ProgramResult {
    let board_ai = account(a, 0)?;
    let buffer = account(a, 1)?;
    let payer = account(a, 2)?;
    let system = account(a, 3)?;
    if *buffer.owner != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    let world = match seeds.as_slice() {
        [s, w] if s.as_slice() == BOARD_SEED && w.len() == 8 => {
            u64::from_le_bytes(w.as_slice().try_into().map_err(|_| BoardError::BadData)?)
        }
        _ => return Err(BoardError::WrongBoard.into()),
    };
    expect_board(program_id, board_ai, world)?;
    {
        let d = buffer.try_borrow_data()?;
        if board::header(&d).is_none() || board::world_of(&d) != world {
            return Err(BoardError::BadContent.into());
        }
    }
    undelegate_account(board_ai, program_id, buffer, payer, system, seeds)?;
    msg!("ERB undelegated world {}", world);
    Ok(())
}

/// The escape, first step: the authority (the delegation's rent payer)
/// asks the DLP to take the board back from an unresponsive validator.
fn request_undelegation(program_id: &Pubkey, a: &[AccountInfo], world: u64) -> ProgramResult {
    let authority = account(a, 0)?;
    let board_ai = account(a, 1)?;
    let owner_program = account(a, 2)?;
    let request = account(a, 3)?;
    let record = account(a, 4)?;
    let metadata = account(a, 5)?;
    let system = account(a, 6)?;
    let dlp = account(a, 7)?;
    let bump = expect_board(program_id, board_ai, world)?;
    if *dlp.key != DELEGATION_PROGRAM_ID || *board_ai.owner != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    if owner_program.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    // While delegated the base copy is the last committed board; its
    // authority field is the one the session started with.
    require_authority(board_ai, authority)?;
    let ix = Instruction {
        program_id: DELEGATION_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*authority.key, true),
            AccountMeta::new_readonly(*board_ai.key, true),
            AccountMeta::new_readonly(*program_id, false),
            AccountMeta::new(*request.key, false),
            AccountMeta::new_readonly(*record.key, false),
            AccountMeta::new(*metadata.key, false),
            AccountMeta::new_readonly(*system.key, false),
        ],
        data: DLP_REQUEST_UNDELEGATION.to_le_bytes().to_vec(),
    };
    invoke_signed(
        &ix,
        &[
            authority.clone(),
            board_ai.clone(),
            owner_program.clone(),
            request.clone(),
            record.clone(),
            metadata.clone(),
            system.clone(),
            dlp.clone(),
        ],
        &[&[BOARD_SEED, &world.to_le_bytes(), &[bump]]],
    )?;
    msg!("ERB undelegation requested world {}", world);
    Ok(())
}

/// The escape, second step (permissionless once the request expired): the
/// DLP hands the board back emptied; the base copy saved first (the last
/// finalized commit) is written back and marked rolled back.
fn rollback_after_timeout(program_id: &Pubkey, a: &[AccountInfo], world: u64) -> ProgramResult {
    let board_ai = account(a, 0)?;
    let owner_program = account(a, 1)?;
    let rest: Vec<&AccountInfo> = (2..9).map(|i| account(a, i)).collect::<Result<_, _>>()?;
    let dlp = account(a, 9)?;
    let bump = expect_board(program_id, board_ai, world)?;
    if *dlp.key != DELEGATION_PROGRAM_ID || *board_ai.owner != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    if owner_program.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let saved = board_ai.try_borrow_data()?.to_vec();
    if board::header(&saved).is_none() || board::world_of(&saved) != world {
        return Err(BoardError::BadContent.into());
    }
    let mut metas = vec![
        AccountMeta::new(*board_ai.key, true),
        AccountMeta::new_readonly(*program_id, false),
    ];
    metas.extend(rest.iter().map(|x| AccountMeta::new(*x.key, false)));
    let mut infos = vec![board_ai.clone(), owner_program.clone()];
    infos.extend(rest.iter().map(|x| (*x).clone()));
    infos.push(dlp.clone());
    invoke_signed(
        &Instruction {
            program_id: DELEGATION_PROGRAM_ID,
            accounts: metas,
            data: DLP_ROLLBACK_AFTER_TIMEOUT.to_le_bytes().to_vec(),
        },
        &infos,
        &[&[BOARD_SEED, &world.to_le_bytes(), &[bump]]],
    )?;
    if board_ai.owner != program_id {
        return Err(BoardError::NotDelegated.into());
    }
    board_ai.resize(saved.len())?;
    {
        let mut d = board_ai.try_borrow_mut_data()?;
        d.copy_from_slice(&saved);
        board::mark_rolled_back(&mut d);
    }
    // Rent: the DLP left the lamports; top up only if the resize needs it.
    let need = Rent::get()?.minimum_balance(board::SIZE);
    if board_ai.lamports() < need {
        return Err(ProgramError::AccountNotRentExempt);
    }
    let (seq, head) = board::header(&saved).ok_or(BoardError::BadContent)?;
    solana_program::log::sol_log_data(&[b"ERB_ROLLBACK", &world.to_le_bytes(), &seq.to_le_bytes(), &head]);
    msg!("ERB world {} rolled back to seq {}", world, seq);
    Ok(())
}
