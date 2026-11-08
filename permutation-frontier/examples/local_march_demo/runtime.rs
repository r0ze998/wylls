//! Bounded, process-private host runtime. No RPC, key creation, signing or
//! chain submission. System CPI is locally emulated.
//! Each dispatch owns its padded account allocation; nothing is leaked. The
//! only unsafe operations reproduce AccountInfo's documented runtime ABI.
use frontier_abi::world_index::event::{WideRecord, WIDE_LOG_PREFIX};
use solana_program::{
    account_info::AccountInfo, instruction::Instruction, program_error::ProgramError,
    pubkey::Pubkey,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard, Once};

pub const PROGRAM: [u8; 32] = [0x12; 32];
const SYSTEM: [u8; 32] = [0; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const ACTOR: [u8; 32] = [0xa1; 32];
const MAX_ACCOUNTS: usize = 128;
const MAX_METAS: usize = 96;
const MAX_DATA: usize = 65_536;
// AccountInfo may zero-extend by this amount before our post-validation.
const ALLOCATION_CAP: usize = MAX_DATA + solana_program::account_info::MAX_PERMITTED_DATA_INCREASE;
const MAX_INSTRUCTION: usize = 16_384;
const MAX_RECORDS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub key: [u8; 32],
    pub owner: [u8; 32],
    pub lamports: u64,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct Meta {
    pub name: String,
    pub signer: bool,
    pub writable: bool,
}

// Address is byte-aligned, so key is exactly four bytes after original_len.
#[repr(C)]
struct KeyBlock {
    original_len: u32,
    key: Pubkey,
}
const _: () = assert!(std::mem::offset_of!(KeyBlock, key) == 4);

struct Owned {
    key: Box<KeyBlock>,
    owner: Box<Pubkey>,
    lamports: u64,
    // u64 storage keeps AccountInfo::resize's preceding length aligned.
    data: Box<[u64]>,
    len: usize,
}
impl Owned {
    fn new(im: &Image) -> Self {
        let mut data = vec![0u64; 1 + ALLOCATION_CAP / 8].into_boxed_slice();
        data[0] = im.data.len() as u64;
        // SAFETY: all bytes of the u64 allocation are initialized. The data
        // portion starts after one aligned length word and has ALLOCATION_CAP bytes.
        unsafe {
            std::slice::from_raw_parts_mut(data.as_mut_ptr().add(1).cast::<u8>(), ALLOCATION_CAP)
                [..im.data.len()]
                .copy_from_slice(&im.data);
        }
        Self {
            key: Box::new(KeyBlock {
                original_len: im.data.len() as u32,
                key: Pubkey::new_from_array(im.key),
            }),
            owner: Box::new(Pubkey::new_from_array(im.owner)),
            lamports: im.lamports,
            data,
            len: im.data.len(),
        }
    }
    fn info(&mut self) -> AccountInfo<'_> {
        // SAFETY: this buffer remains owned and immovable until all AccountInfo
        // aliases have dropped. The active slice is uniquely created here;
        // duplicates clone its Rc<RefCell>, never create another mutable slice.
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(self.data.as_mut_ptr().add(1).cast::<u8>(), self.len)
        };
        AccountInfo::new(
            &self.key.key,
            false,
            false,
            &mut self.lamports,
            bytes,
            &self.owner,
            false,
        )
    }
}
#[derive(Clone, Copy)]
struct Allocation {
    ptr: usize,
    cap: usize,
    writable: bool,
}
#[derive(Default)]
struct Context {
    active: bool,
    allocations: BTreeMap<[u8; 32], Allocation>,
    records: Vec<Vec<u8>>,
    allow_beacon: bool,
    beacon_count: usize,
    holding: Option<[u8; 32]>,
    fault: bool,
}
static SERIAL: Mutex<()> = Mutex::new(());
static CONTEXT: Mutex<Context> = Mutex::new(Context {
    active: false,
    allocations: BTreeMap::new(),
    records: Vec::new(),
    allow_beacon: false,
    beacon_count: 0,
    holding: None,
    fault: false,
});
static INSTALL: Once = Once::new();
fn context() -> MutexGuard<'static, Context> {
    CONTEXT.lock().unwrap_or_else(|e| e.into_inner())
}
struct Scope;
impl Drop for Scope {
    fn drop(&mut self) {
        permutation_frontier::prologue::clear_local_demo_clock();
        permutation_frontier::init::clear_local_march_rent();
        *context() = Context::default();
    }
}
struct Stubs;
impl solana_program::program_stubs::SyscallStubs for Stubs {
    fn sol_log(&self, _: &str) {
        context().fault = true;
    }
    fn sol_log_data(&self, fields: &[&[u8]]) {
        let mut c = context();
        if !c.active || fields.len() != 2 || fields[1].len() > 4096 {
            c.fault = true;
            return;
        }
        if fields[0] == &WIDE_LOG_PREFIX[..]
            && c.records.len() < MAX_RECORDS
            && WideRecord::decode(fields[1]).is_ok()
        {
            c.records.push(fields[1].to_vec());
        } else if c.allow_beacon
            && fields[0] == b"PS2"
            && c.beacon_count < 2
            && frontier_abi::log::decode(fields[1]).is_ok_and(|r| {
                matches!(
                    r.kind,
                    frontier_abi::log::Kind::ANCHOR | frontier_abi::log::Kind::SEED
                )
            })
        {
            c.beacon_count += 1;
        } else {
            c.fault = true;
        }
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let result = emulate(ix, infos, seeds);
        // Any unexpected/failed CPI poisons the stage even if ignored upstream.
        if result.is_err() {
            context().fault = true;
        }
        result
    }
}
fn bad() -> ProgramError {
    ProgramError::InvalidInstructionData
}
fn u64_at(d: &[u8], at: usize) -> Result<u64, ProgramError> {
    let end = at.checked_add(8).ok_or_else(bad)?;
    let bytes: [u8; 8] = d
        .get(at..end)
        .ok_or_else(bad)?
        .try_into()
        .map_err(|_| bad())?;
    Ok(u64::from_le_bytes(bytes))
}
fn emulate(
    ix: &Instruction,
    infos: &[AccountInfo],
    seeds: &[&[&[u8]]],
) -> Result<(), ProgramError> {
    if ix.program_id.to_bytes() != SYSTEM
        || ix.data.len() < 4
        || ix.accounts.len() > 2
        || infos.len() > 3
        || seeds.len() > 2
        || seeds
            .iter()
            .any(|s| s.len() > 16 || s.iter().any(|v| v.len() > 32))
    {
        return Err(bad());
    }
    let c = context();
    if !c.active {
        return Err(bad());
    }
    for a in infos {
        let allocation = c.allocations.get(a.key.as_array()).ok_or_else(bad)?;
        if a.try_borrow_data()?.as_ptr() as usize != allocation.ptr {
            return Err(bad());
        }
    }
    let signed = |a: &AccountInfo| -> bool {
        (a.is_signer && matches!(a.key.to_bytes(), PAYER | ACTOR))
            || seeds.iter().any(|s| {
                Pubkey::create_program_address(s, &Pubkey::new_from_array(PROGRAM))
                    .is_ok_and(|k| &k == a.key)
            })
    };
    for m in &ix.accounts {
        let a = infos.iter().find(|a| *a.key == m.pubkey).ok_or_else(bad)?;
        let allocation = c.allocations.get(a.key.as_array()).ok_or_else(bad)?;
        if (m.is_writable && (!a.is_writable || !allocation.writable))
            || (m.is_signer && !signed(a))
        {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }
    let first = ix.accounts.first().ok_or_else(bad)?;
    let a = infos
        .iter()
        .find(|a| *a.key == first.pubkey)
        .ok_or_else(bad)?;
    let allocation = *c.allocations.get(a.key.as_array()).ok_or_else(bad)?;
    if !first.is_writable || !a.is_writable || !allocation.writable {
        return Err(bad());
    }
    let tag = u32::from_le_bytes(ix.data[..4].try_into().map_err(|_| bad())?);
    let d = &ix.data;
    match tag {
        2 => {
            if d.len() != 12
                || ix.accounts.len() != 2
                || !first.is_signer
                || a.key.to_bytes() != PAYER
                || a.owner.to_bytes() != SYSTEM
                || !a.data_is_empty()
            {
                return Err(bad());
            }
            let second = &ix.accounts[1];
            let to = infos
                .iter()
                .find(|a| *a.key == second.pubkey)
                .ok_or_else(bad)?;
            if !second.is_writable
                || second.is_signer
                || to.key == a.key
                || !((to.owner.to_bytes() == SYSTEM && to.data_is_empty())
                    || (Some(to.key.to_bytes()) == c.holding && to.owner.to_bytes() == PROGRAM))
            {
                return Err(bad());
            }
            let amount = u64_at(d, 4)?;
            let left = a
                .try_lamports()?
                .checked_sub(amount)
                .ok_or(ProgramError::InsufficientFunds)?;
            let right = to
                .try_lamports()?
                .checked_add(amount)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            **a.try_borrow_mut_lamports()? = left;
            **to.try_borrow_mut_lamports()? = right;
        }
        8 => {
            if d.len() != 12 || ix.accounts.len() != 1 || !first.is_signer {
                return Err(bad());
            }
            let n = usize::try_from(u64_at(d, 4)?).map_err(|_| bad())?;
            allocate(a, allocation, n)?;
        }
        1 => {
            if d.len() != 36
                || ix.accounts.len() != 1
                || !first.is_signer
                || a.owner.to_bytes() != SYSTEM
                || d[4..] != PROGRAM
            {
                return Err(bad());
            }
            // AccountInfo::assign implements the runtime's owner-cell write.
            // The cell is this dispatch's private owned Box, never shared externally.
            a.assign(&Pubkey::new_from_array(PROGRAM));
        }
        9 => {
            if ix.accounts.len() != 2 || first.is_signer || d.len() < 84 {
                return Err(bad());
            }
            let base: [u8; 32] = d[4..36].try_into().map_err(|_| bad())?;
            let len = usize::try_from(u64_at(d, 36)?).map_err(|_| bad())?;
            if len > 32 || d.len() != 84 + len {
                return Err(bad());
            }
            let seed = &d[44..44 + len];
            if std::str::from_utf8(seed).is_err() {
                return Err(bad());
            }
            let n = usize::try_from(u64_at(d, 44 + len)?).map_err(|_| bad())?;
            if d[52 + len..] != PROGRAM {
                return Err(bad());
            }
            let base_meta = &ix.accounts[1];
            if base_meta.pubkey.to_bytes() != base || !base_meta.is_signer || base_meta.is_writable
            {
                return Err(bad());
            }
            let base_info = infos
                .iter()
                .find(|a| a.key.to_bytes() == base)
                .ok_or_else(bad)?;
            if base_info.owner.to_bytes() != PROGRAM || !signed(base_info) {
                return Err(bad());
            }
            let wanted = permutation_rules::hash::sha256(&[&base, seed, &PROGRAM]);
            if wanted != a.key.to_bytes() {
                return Err(ProgramError::InvalidSeeds);
            }
            allocate(a, allocation, n)?;
            a.assign(&Pubkey::new_from_array(PROGRAM));
        }
        _ => return Err(bad()),
    }
    Ok(())
}
fn allocate(a: &AccountInfo, allocation: Allocation, n: usize) -> Result<(), ProgramError> {
    if a.owner.to_bytes() != SYSTEM || !a.data_is_empty() || n == 0 || n > allocation.cap {
        return Err(ProgramError::InvalidRealloc);
    }
    let mut data = a.try_borrow_mut_data()?;
    if data.as_ptr() as usize != allocation.ptr {
        return Err(ProgramError::InvalidRealloc);
    }
    // SAFETY: allocation refers only to Owned's aligned padded buffer in
    // this dispatch. It remains alive until every AccountInfo drops; the
    // existing active slice is empty and RefCell excludes outstanding borrows.
    unsafe {
        let ptr = allocation.ptr as *mut u8;
        *ptr.sub(8).cast::<u64>() = n as u64;
        *data = std::slice::from_raw_parts_mut(ptr, n);
    }
    data.fill(0);
    Ok(())
}

/// Executes one real handler, then commits only validated owned snapshots.
/// Signer flags are explicit local fixtures, not cryptographic authentication.
pub fn dispatch(
    images: &mut BTreeMap<String, Image>,
    metas: &[Meta],
    instruction: &[u8],
    now: i64,
    slot: u64,
    allow_beacon_logs: bool,
) -> Result<Vec<Vec<u8>>, String> {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if images.is_empty()
        || images.len() > MAX_ACCOUNTS
        || metas.is_empty()
        || metas.len() > MAX_METAS
        || instruction.is_empty()
        || instruction.len() > MAX_INSTRUCTION
    {
        return Err("Fault_Bounds".into());
    }
    let mut unique = BTreeMap::<[u8; 32], Image>::new();
    for image in images.values() {
        if image.data.len() > MAX_DATA {
            return Err("Fault_AccountBounds".into());
        }
        if let Some(prior) = unique.insert(image.key, image.clone()) {
            if prior != *image {
                return Err("Fault_AliasMismatch".into());
            }
        }
    }
    let mut writable = BTreeSet::new();
    for m in metas {
        let im = images.get(&m.name).ok_or("Fault_UnknownAccount")?;
        if m.signer && !matches!(im.key, PAYER | ACTOR) {
            return Err("Fault_UnknownSigner".into());
        }
        if m.writable {
            writable.insert(im.key);
        }
    }
    INSTALL.call_once(|| {
        solana_program::program_stubs::set_syscall_stubs(Box::new(Stubs));
    });
    let mut owned: Vec<_> = unique.values().map(Owned::new).collect();
    let mut allocations = BTreeMap::new();
    for o in &mut owned {
        allocations.insert(
            o.key.key.to_bytes(),
            Allocation {
                ptr: unsafe { o.data.as_mut_ptr().add(1).cast::<u8>() } as usize,
                cap: MAX_DATA,
                writable: writable.contains(o.key.key.as_array()),
            },
        );
    }
    *context() = Context {
        active: true,
        allocations,
        allow_beacon: allow_beacon_logs,
        holding: images.get("holding").map(|im| im.key),
        ..Context::default()
    };
    let _scope = Scope;
    permutation_frontier::prologue::set_local_demo_clock(now, slot);
    permutation_frontier::init::set_local_march_rent();
    let base: Vec<_> = owned.iter_mut().map(Owned::info).collect();
    let mut accounts = Vec::with_capacity(metas.len());
    for m in metas {
        let im = images.get(&m.name).ok_or("Fault_UnknownAccount")?;
        let mut a = base
            .iter()
            .find(|a| a.key.to_bytes() == im.key)
            .ok_or("Fault_UnknownAccount")?
            .clone();
        a.is_signer = m.signer;
        a.is_writable = m.writable;
        accounts.push(a);
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        permutation_frontier::dispatch(&Pubkey::new_from_array(PROGRAM), &accounts, instruction)
    }));
    if context().fault {
        return Err("Fault_RuntimeBoundary".into());
    }
    match result {
        Err(_) => return Err("Fault_HandlerPanic".into()),
        Ok(Err(e)) => {
            let e: ProgramError = e.into();
            return Err(match e {
                ProgramError::Custom(n) => format!("Refused_{n}"),
                _ => "Refused_Runtime".into(),
            });
        }
        Ok(Ok(())) => {}
    }
    let mut after = BTreeMap::new();
    for a in &base {
        if a.data_len() > MAX_DATA {
            return Err("Fault_AccountBounds".into());
        }
        let im = Image {
            key: a.key.to_bytes(),
            owner: a.owner.to_bytes(),
            lamports: a.lamports(),
            data: a.try_borrow_data().map_err(|_| "Fault_Borrow")?.to_vec(),
        };
        let before = unique.get(&im.key).ok_or("Fault_UnknownAccount")?;
        if !writable.contains(&im.key) && &im != before {
            return Err("Fault_ReadonlyMutation".into());
        }
        if im.owner != before.owner && im.owner != SYSTEM && im.owner != PROGRAM {
            return Err("Fault_OwnerMutation".into());
        }
        after.insert(im.key, im);
    }
    let before_total: u128 = unique.values().map(|im| im.lamports as u128).sum();
    let after_total: u128 = after.values().map(|im| im.lamports as u128).sum();
    if before_total != after_total {
        return Err("Fault_LamportConservation".into());
    }
    if allow_beacon_logs && context().beacon_count != 1 {
        return Err("Fault_BeaconReceipt".into());
    }
    let records = context().records.clone();
    // Nothing mutates the caller's images before all validations complete.
    for im in images.values_mut() {
        *im = after.get(&im.key).ok_or("Fault_UnknownAccount")?.clone();
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image() -> Image {
        Image {
            key: ACTOR,
            owner: SYSTEM,
            lamports: 10,
            data: Vec::new(),
        }
    }
    #[test]
    fn runtime_alias_mismatch_is_refused_before_dispatch() {
        let mut images = BTreeMap::from([("actor".into(), image()), ("alias".into(), image())]);
        images.get_mut("alias").unwrap().lamports += 1;
        let before = images.clone();
        let metas = [Meta {
            name: "actor".into(),
            signer: true,
            writable: true,
        }];
        assert_eq!(
            dispatch(&mut images, &metas, &[255], 1, 1, false),
            Err("Fault_AliasMismatch".into())
        );
        assert_eq!(images, before);
    }
    #[test]
    fn runtime_unknown_signer_is_refused_before_dispatch() {
        let mut im = image();
        im.key = [0x33; 32];
        let mut images = BTreeMap::from([("actor".into(), im)]);
        let before = images.clone();
        let metas = [Meta {
            name: "actor".into(),
            signer: true,
            writable: true,
        }];
        assert_eq!(
            dispatch(&mut images, &metas, &[255], 1, 1, false),
            Err("Fault_UnknownSigner".into())
        );
        assert_eq!(images, before);
    }
    #[test]
    fn runtime_handler_refusal_discards_stage_and_clears_scope() {
        let mut images = BTreeMap::from([("actor".into(), image())]);
        let before = images.clone();
        let metas = [Meta {
            name: "actor".into(),
            signer: true,
            writable: true,
        }];
        assert!(dispatch(&mut images, &metas, &[255], 1, 1, false).is_err());
        assert_eq!(images, before);
        assert!(permutation_frontier::init::rent(1).is_err());
        assert!(!context().active);
    }
}
