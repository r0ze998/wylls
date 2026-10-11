//! ABI v2 Province-entry helpers (MC contract §3.1, §3.2, §5.5): the
//! retire-style Leave (`op_a = 1`, RetireHost and the keep donor) and the
//! lead-host ranking (DeclareSiege's `NotLead` check and the keep donor).
//!
//! The M1 entry codec ([`crate::entry`]) is unchanged: it reads op 5 as
//! `Leave` whatever `op_a` holds and writes `op_a = 0` for a plain Leave,
//! so a retire is marked and read here with raw byte access.

use crate::entry::unit_from_u8;
use crate::layout::province::entry as E;
use crate::v2::layout::province::province as P;

/// `op_a` of a retire-style Leave: the return settle credits `prev_home`
/// when the host's Holding was captured (§5.6 0x52).
pub const RETIRE_OP_A: u8 = 1;

/// One lead-host candidate: (entry index, host id, MilliTroops).
pub type Candidate = (u8, u64, u32);

/// Most candidates on one hex (`HEX_HOST_CAP` is 6; ≤ 8 per faction).
pub const MAX_CANDIDATES: usize = 8;

fn rd32(e: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]])
}

fn rd64(e: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&e[o..o + 8]);
    u64::from_le_bytes(b)
}

/// The qualifying hosts of `faction` on `tile` at bell `b` (§3.1 lead
/// host): roster state, `from_bell ≤ b`, no pending op, a non-civilian
/// unit, troops > 0. At most [`MAX_CANDIDATES`], in entry order.
pub fn candidates(
    pd: &[u8],
    tile: u8,
    faction: u8,
    b: u32,
) -> ([Candidate; MAX_CANDIDATES], usize) {
    let mut out = [(0u8, 0u64, 0u32); MAX_CANDIDATES];
    let mut n = 0;
    let Some(block) = pd.get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE) else {
        return (out, 0);
    };
    for (i, e) in block.chunks_exact(E::SIZE).enumerate() {
        if e[E::STATE] != E::STATE_ROSTER
            || e[E::TILE] != tile
            || e[E::FACTION] != faction
            || e[E::PEND_OP] != E::OP_NONE
            || rd32(e, E::FROM_BELL) > b
        {
            continue;
        }
        let civilian = unit_from_u8(e[E::UNIT]).is_none_or(|u| u.is_civilian());
        let troops = rd32(e, E::TROOPS);
        if civilian || troops == 0 {
            continue;
        }
        if n < MAX_CANDIDATES {
            out[n] = (i as u8, rd64(e, E::ID), troops);
            n += 1;
        }
    }
    (out, n)
}

/// The lead host of `faction` on `tile` at bell `b`: most troops, then the
/// lowest host id (`keep::lead_host`).
pub fn lead_host(pd: &[u8], tile: u8, faction: u8, b: u32) -> Option<Candidate> {
    let (c, n) = candidates(pd, tile, faction, b);
    let i = crate::v2::kernel::keep::lead_host(&c[..n])?;
    c[..n].iter().copied().find(|x| x.0 == i)
}

/// Marks entry `i` with a retire-style Leave issued at `bell` (RetireHost:
/// effective after that bell's clash, settled by `settle_bell`).
pub fn mark_retire(pd: &mut [u8], i: usize, bell: u32) -> bool {
    let o = P::entry(i);
    let Some(e) = pd.get_mut(o..o + E::SIZE) else {
        return false;
    };
    if e[E::STATE] != E::STATE_ROSTER || e[E::PEND_OP] != E::OP_NONE {
        return false;
    }
    e[E::PEND_OP] = E::OP_LEAVE;
    e[E::OP_A] = RETIRE_OP_A;
    e[E::PEND_BELL..E::PEND_BELL + 4].copy_from_slice(&bell.to_le_bytes());
    true
}

/// Whether entry `i` carries a retire-style Leave.
pub fn is_retire(pd: &[u8], i: usize) -> bool {
    let o = P::entry(i);
    pd.get(o..o + E::SIZE)
        .is_some_and(|e| e[E::PEND_OP] == E::OP_LEAVE && e[E::OP_A] == RETIRE_OP_A)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{write_entry, Entry, EntryOp};

    fn host(id: u64, faction: u8, unit: u8, tile: u8, troops: u32) -> Entry {
        Entry {
            id,
            faction,
            unit,
            tile,
            state: E::STATE_ROSTER,
            troops,
            stamina_value: 100,
            dealt_bps: 10_000,
            stamina_bell: 0,
            ready_bell: 0,
            from_bell: 0,
            pend_bell: 0,
            op: EntryOp::None,
        }
    }

    #[test]
    fn cq_lead_host_ranks_troops_then_id() {
        let mut pd = std::vec![0u8; P::SIZE];
        write_entry(&mut pd, 0, &host(30, 2, 0, 9, 5_000_000)).unwrap();
        write_entry(&mut pd, 1, &host(20, 2, 0, 9, 7_000_000)).unwrap();
        write_entry(&mut pd, 2, &host(10, 2, 0, 9, 7_000_000)).unwrap();
        // a Scout never leads; another faction or tile never counts
        write_entry(&mut pd, 3, &host(1, 2, 6, 9, 9_000_000)).unwrap();
        write_entry(&mut pd, 4, &host(2, 3, 0, 9, 9_000_000)).unwrap();
        write_entry(&mut pd, 5, &host(3, 2, 0, 8, 9_000_000)).unwrap();
        assert_eq!(lead_host(&pd, 9, 2, 0), Some((2, 10, 7_000_000)));
        // a host with a pending op does not qualify
        assert!(mark_retire(&mut pd, 2, 5));
        assert!(is_retire(&pd, 2));
        assert_eq!(lead_host(&pd, 9, 2, 0), Some((1, 20, 7_000_000)));
        assert!(!mark_retire(&mut pd, 2, 5), "busy");
        // the M1 codec still reads it as a Leave
        assert_eq!(crate::entry::read_entry(&pd, 2).unwrap().op, EntryOp::Leave);
        assert_eq!(lead_host(&pd, 7, 2, 0), None);
    }
}
