//! `frontier-er-board`: **candidate, not adopted, not deployed.** The board
//! of `frontier_er::board` as a program a continuing world can delegate to
//! a MagicBlock ER and bring home, with the delegation program's escape.
//! It is a separate program with its own id: the S1 program
//! (`permutation-frontier`) is untouched, and none of these instructions is
//! an S1 tag (the integrator's registry, ④, assigns those if it is ever
//! adopted).
//!
//! One board per world and authority: the PDA
//! `["wylls-er-board", le64 world_id, authority]`. The authority is part of
//! the address, so whoever inits first cannot take over the board the
//! world's configuration names (a squatter only makes another address),
//! and an address funded in advance still inits. It holds no value (rent
//! only) and no ownership record; nothing the settlement or the ownership
//! rules read.
//!
//! Instruction data: `disc u64 ‖ world u64 ‖ authority [32] ‖ args`.
//!
//! | disc | instruction | accounts | who |
//! |---|---|---|---|
//! | 0 | Init | authority s,w · board w · system | the authority |
//! | 1 | Write `{expect_seq, expect_head, req_id, payload, bell}` | writer s · board w | any signer (who may write is the use's rule, not decided; see DESIGN §4) |
//! | 2 | Delegate | authority s,w · system · board w · owner program · buffer w · record w · metadata w · DLP · validator | authority (it becomes the rent payer the escape needs) |
//! | 3 | Commit | authority s · board w · magic program · magic context | authority, on the ER (commits spend the session's budget) |
//! | 4 | CommitAndUndelegate | authority s · board w · magic program · magic context | authority, on the ER |
//! | 5 | RequestUndelegation | authority s,w · board · owner program · request w · record · metadata w · system · DLP | the DLP checks the signer is the delegation's rent payer |
//! | 6 | RollbackAfterTimeout | board w · owner program · request w · record w · metadata w · rent payer w · commit state w · commit record w · reimbursement w · DLP · payer s,w · system | anyone, on the base, after the request expired |
//! | `[196,28,41,206,48,37,51,167]` | the DLP's undelegate callback `{seeds}` | board w · buffer s · payer s,w · system | the DLP only (the SDK checks the buffer is DLP-owned, signs and is this board's) |
//!
//! While the board is delegated, its base bytes are whatever the validator
//! last committed (the DLP does not re-check them). The escape therefore
//! never depends on them: RequestUndelegation leaves the rent-payer check to
//! the DLP, and RollbackAfterTimeout restores the saved bytes if they are a
//! board of this world and authority, else a fresh board, marked either
//! way, topping rent up from its payer.
//!
//! Every write follows `frontier_er::board::apply`: compare-and-set on
//! `(seq, head)`, so a duplicate applies at most once whichever layer it
//! reaches, and never on another history at the same `seq`.

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
    program::{invoke, invoke_signed},
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

pub fn board_address(program: &Pubkey, world: u64, authority: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[BOARD_SEED, &world.to_le_bytes(), authority.as_ref()],
        program,
    )
}

fn hashv(parts: &[&[u8]]) -> [u8; 32] {
    solana_program::hash::hashv(parts).to_bytes()
}

#[cfg(all(target_os = "solana", not(feature = "no-entrypoint")))]
solana_program::entrypoint!(process_instruction);

/// The board an instruction names: world, authority and the PDA's bump.
struct Id {
    world: u64,
    authority: Pubkey,
    bump: u8,
}

impl Id {
    fn seeds(&self) -> Vec<Vec<u8>> {
        vec![
            BOARD_SEED.to_vec(),
            self.world.to_le_bytes().to_vec(),
            self.authority.to_bytes().to_vec(),
        ]
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 8 {
        return Err(BoardError::BadData.into());
    }
    let (disc, rest) = data.split_at(8);
    if disc == UNDELEGATE_CALLBACK {
        let seeds = Vec::<Vec<u8>>::try_from_slice(rest).map_err(|_| BoardError::BadData)?;
        return undelegate_callback(program_id, accounts, seeds);
    }
    let disc = u64::from_le_bytes(disc.try_into().map_err(|_| BoardError::BadData)?);
    if rest.len() < 40 {
        return Err(BoardError::BadData.into());
    }
    let world = u64::from_le_bytes(rest[..8].try_into().map_err(|_| BoardError::BadData)?);
    let authority =
        Pubkey::new_from_array(rest[8..40].try_into().map_err(|_| BoardError::BadData)?);
    let args = &rest[40..];
    let board_ai = match disc {
        0 | 1 | 3 | 4 | 5 => account(accounts, 1)?,
        2 => account(accounts, 2)?,
        6 => account(accounts, 0)?,
        _ => return Err(BoardError::BadData.into()),
    };
    let (addr, bump) = board_address(program_id, world, &authority);
    if *board_ai.key != addr {
        return Err(BoardError::WrongBoard.into());
    }
    let id = Id {
        world,
        authority,
        bump,
    };
    match disc {
        0 => init(program_id, accounts, &id),
        1 => write(program_id, accounts, &id, args),
        2 => delegate(program_id, accounts, &id),
        3 => commit(program_id, accounts, &id, false),
        4 => commit(program_id, accounts, &id, true),
        5 => request_undelegation(program_id, accounts, &id),
        _ => rollback_after_timeout(program_id, accounts, &id),
    }
}

fn account<'a, 'b>(
    a: &'a [AccountInfo<'b>],
    i: usize,
) -> Result<&'a AccountInfo<'b>, ProgramError> {
    a.get(i).ok_or(ProgramError::NotEnoughAccountKeys)
}

/// Bytes that are a board of this world and authority.
fn valid_board(d: &[u8], id: &Id) -> bool {
    board::header(d).is_some()
        && board::world_of(d) == id.world
        && d[board::AUTHORITY..board::AUTHORITY + 32] == id.authority.to_bytes()
}

/// A board of this world owned by this program (on the base while not
/// delegated; on the ER while delegated).
fn owned_board(program_id: &Pubkey, board: &AccountInfo, id: &Id) -> ProgramResult {
    if board.owner != program_id {
        return Err(BoardError::NotDelegated.into());
    }
    if !valid_board(&board.try_borrow_data()?, id) {
        return Err(BoardError::WrongBoard.into());
    }
    Ok(())
}

fn require_authority(who: &AccountInfo, id: &Id) -> ProgramResult {
    if !who.is_signer || *who.key != id.authority {
        return Err(BoardError::NotAuthority.into());
    }
    Ok(())
}

fn fresh(id: &Id) -> Vec<u8> {
    let mut d = board::new_board(id.world);
    d[board::AUTHORITY..board::AUTHORITY + 32].copy_from_slice(id.authority.as_ref());
    d
}

/// Init: creates the board, also at an address someone funded in advance
/// (transfer the shortfall, allocate, assign; `create_account` would fail).
fn init(program_id: &Pubkey, a: &[AccountInfo], id: &Id) -> ProgramResult {
    let authority = account(a, 0)?;
    let board_ai = account(a, 1)?;
    let system = account(a, 2)?;
    require_authority(authority, id)?;
    if board_ai.owner != system.key || !board_ai.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let w = id.world.to_le_bytes();
    let bump = [id.bump];
    let signer: &[&[u8]] = &[BOARD_SEED, &w, id.authority.as_ref(), &bump];
    let need = Rent::get()?.minimum_balance(board::SIZE);
    let short = need.saturating_sub(board_ai.lamports());
    if short > 0 {
        invoke(
            &system_instruction::transfer(authority.key, board_ai.key, short),
            &[authority.clone(), board_ai.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(board_ai.key, board::SIZE as u64),
        &[board_ai.clone(), system.clone()],
        &[signer],
    )?;
    invoke_signed(
        &system_instruction::assign(board_ai.key, program_id),
        &[board_ai.clone(), system.clone()],
        &[signer],
    )?;
    board_ai.try_borrow_mut_data()?.copy_from_slice(&fresh(id));
    msg!("ERB init world {}", id.world);
    Ok(())
}

fn write(program_id: &Pubkey, a: &[AccountInfo], id: &Id, args: &[u8]) -> ProgramResult {
    let writer = account(a, 0)?;
    let board_ai = account(a, 1)?;
    if !writer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    owned_board(program_id, board_ai, id)?;
    // expect_seq ‖ expect_head ‖ req_id ‖ payload ‖ bell
    if args.len() != 8 + 32 + 32 + 32 + 4 {
        return Err(BoardError::BadData.into());
    }
    let arr = |r: std::ops::Range<usize>| -> Result<[u8; 32], ProgramError> {
        args[r].try_into().map_err(|_| BoardError::BadData.into())
    };
    let w = Write {
        expect_seq: u64::from_le_bytes(args[..8].try_into().map_err(|_| BoardError::BadData)?),
        expect_head: arr(8..40)?,
        req_id: arr(40..72)?,
        payload: arr(72..104)?,
        bell: u32::from_le_bytes(args[104..108].try_into().map_err(|_| BoardError::BadData)?),
    };
    let mut d = board_ai.try_borrow_mut_data()?;
    match board::apply_with(&mut d, id.world, &w, hashv) {
        Ok((seq, head)) => {
            // The record a reader chains: (seq, head, request, payload).
            solana_program::log::sol_log_data(&[
                b"ERB",
                &seq.to_le_bytes(),
                &head,
                &w.req_id,
                &w.payload,
            ]);
            Ok(())
        }
        Err(WriteErr::StaleSeq { applied: true, .. }) => Err(BoardError::Duplicate.into()),
        Err(WriteErr::StaleSeq { .. }) => Err(BoardError::StaleSeq.into()),
        Err(WriteErr::BadAccount) => Err(BoardError::WrongBoard.into()),
    }
}

fn delegate(program_id: &Pubkey, a: &[AccountInfo], id: &Id) -> ProgramResult {
    let authority = account(a, 0)?;
    let system = account(a, 1)?;
    let board_ai = account(a, 2)?;
    let owner_program = account(a, 3)?;
    let buffer = account(a, 4)?;
    let record = account(a, 5)?;
    let metadata = account(a, 6)?;
    let dlp = account(a, 7)?;
    let validator = account(a, 8)?;
    owned_board(program_id, board_ai, id)?;
    require_authority(authority, id)?;
    if owner_program.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *dlp.key != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    let w = id.world.to_le_bytes();
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
        &[BOARD_SEED, &w, id.authority.as_ref()],
        DelegateConfig {
            commit_frequency_ms: COMMIT_FREQUENCY_MS,
            validator: Some(*validator.key),
        },
    )?;
    msg!("ERB delegated world {} to {}", id.world, validator.key);
    Ok(())
}

/// On the ER: schedule a commit, or commit-and-undelegate (the session's
/// end). Both are the authority's: commits spend the session's sponsored
/// budget, so nobody else may spend it or churn sessions.
fn commit(program_id: &Pubkey, a: &[AccountInfo], id: &Id, undelegate: bool) -> ProgramResult {
    let payer = account(a, 0)?;
    let board_ai = account(a, 1)?;
    let magic_program = account(a, 2)?;
    let magic_context = account(a, 3)?;
    require_authority(payer, id)?;
    if *magic_program.key != MAGIC_PROGRAM_ID || *magic_context.key != MAGIC_CONTEXT_ID {
        return Err(BoardError::WrongMagicProgram.into());
    }
    owned_board(program_id, board_ai, id)?;
    let b =
        MagicIntentBundleBuilder::new(payer.clone(), magic_context.clone(), magic_program.clone());
    if undelegate {
        b.commit_and_undelegate(std::slice::from_ref(board_ai))
            .build_and_invoke()?;
    } else {
        b.commit(std::slice::from_ref(board_ai))
            .build_and_invoke()?;
    }
    msg!(
        "ERB {} world {}",
        if undelegate { "undelegate" } else { "commit" },
        id.world
    );
    Ok(())
}

/// The DLP hands the board back: only to its own address, with board bytes
/// of this world and authority. (A validator that committed other bytes
/// makes this fail; the escape below does not depend on them.)
fn undelegate_callback(
    program_id: &Pubkey,
    a: &[AccountInfo],
    seeds: Vec<Vec<u8>>,
) -> ProgramResult {
    let board_ai = account(a, 0)?;
    let buffer = account(a, 1)?;
    let payer = account(a, 2)?;
    let system = account(a, 3)?;
    if *buffer.owner != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    let (world, authority) = match seeds.as_slice() {
        [s, w, k] if s.as_slice() == BOARD_SEED && w.len() == 8 && k.len() == 32 => (
            u64::from_le_bytes(w.as_slice().try_into().map_err(|_| BoardError::BadData)?),
            Pubkey::new_from_array(k.as_slice().try_into().map_err(|_| BoardError::BadData)?),
        ),
        _ => return Err(BoardError::WrongBoard.into()),
    };
    let (addr, bump) = board_address(program_id, world, &authority);
    if *board_ai.key != addr {
        return Err(BoardError::WrongBoard.into());
    }
    let id = Id {
        world,
        authority,
        bump,
    };
    if !valid_board(&buffer.try_borrow_data()?, &id) {
        return Err(BoardError::BadContent.into());
    }
    undelegate_account(board_ai, program_id, buffer, payer, system, id.seeds())?;
    msg!("ERB undelegated world {}", world);
    Ok(())
}

/// The escape, first step: the authority asks the DLP to take the board
/// back from an unresponsive validator. The DLP checks the signer is the
/// delegation's rent payer; the board's committed bytes are not read (a
/// validator controls them).
fn request_undelegation(program_id: &Pubkey, a: &[AccountInfo], id: &Id) -> ProgramResult {
    let authority = account(a, 0)?;
    let board_ai = account(a, 1)?;
    let owner_program = account(a, 2)?;
    let request = account(a, 3)?;
    let record = account(a, 4)?;
    let metadata = account(a, 5)?;
    let system = account(a, 6)?;
    let dlp = account(a, 7)?;
    if *dlp.key != DELEGATION_PROGRAM_ID || *board_ai.owner != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    if owner_program.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    require_authority(authority, id)?;
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
    let w = id.world.to_le_bytes();
    let bump = [id.bump];
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
        &[&[BOARD_SEED, &w, id.authority.as_ref(), &bump]],
    )?;
    msg!("ERB undelegation requested world {}", id.world);
    Ok(())
}

/// The escape, second step (permissionless once the request expired): the
/// DLP hands the board back emptied. The base bytes saved first (the last
/// finalized commit) are written back if they are a board of this world
/// and authority; otherwise (a validator committed something else) a fresh
/// board is written. Either way it is marked rolled back, and a payer tops
/// the rent up if the committed lamports fell short.
fn rollback_after_timeout(program_id: &Pubkey, a: &[AccountInfo], id: &Id) -> ProgramResult {
    let board_ai = account(a, 0)?;
    let owner_program = account(a, 1)?;
    let rest: Vec<&AccountInfo> = (2..9).map(|i| account(a, i)).collect::<Result<_, _>>()?;
    let dlp = account(a, 9)?;
    let payer = account(a, 10)?;
    let system = account(a, 11)?;
    if *dlp.key != DELEGATION_PROGRAM_ID || *board_ai.owner != DELEGATION_PROGRAM_ID {
        return Err(BoardError::WrongDelegationProgram.into());
    }
    if owner_program.key != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let saved = board_ai.try_borrow_data()?.to_vec();
    let kept = saved.len() == board::SIZE && valid_board(&saved, id);
    let mut metas = vec![
        AccountMeta::new(*board_ai.key, true),
        AccountMeta::new_readonly(*program_id, false),
    ];
    metas.extend(rest.iter().map(|x| AccountMeta::new(*x.key, false)));
    let mut infos = vec![board_ai.clone(), owner_program.clone()];
    infos.extend(rest.iter().map(|x| (*x).clone()));
    infos.push(dlp.clone());
    let w = id.world.to_le_bytes();
    let bump = [id.bump];
    invoke_signed(
        &Instruction {
            program_id: DELEGATION_PROGRAM_ID,
            accounts: metas,
            data: DLP_ROLLBACK_AFTER_TIMEOUT.to_le_bytes().to_vec(),
        },
        &infos,
        &[&[BOARD_SEED, &w, id.authority.as_ref(), &bump]],
    )?;
    if board_ai.owner != program_id {
        return Err(BoardError::NotDelegated.into());
    }
    let need = Rent::get()?.minimum_balance(board::SIZE);
    let short = need.saturating_sub(board_ai.lamports());
    if short > 0 {
        if !payer.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        invoke(
            &system_instruction::transfer(payer.key, board_ai.key, short),
            &[payer.clone(), board_ai.clone(), system.clone()],
        )?;
    }
    board_ai.resize(board::SIZE)?;
    let restored = if kept { saved } else { fresh(id) };
    {
        let mut d = board_ai.try_borrow_mut_data()?;
        d.copy_from_slice(&restored);
        board::mark_rolled_back(&mut d);
    }
    let (seq, head) = board::header(&restored).ok_or(BoardError::BadContent)?;
    solana_program::log::sol_log_data(&[
        b"ERB_ROLLBACK",
        &id.world.to_le_bytes(),
        &seq.to_le_bytes(),
        &head,
        &[u8::from(kept)],
    ]);
    msg!(
        "ERB world {} rolled back to seq {} (kept {})",
        id.world,
        seq,
        kept
    );
    Ok(())
}
