//! Did a write land? Decided from the target's **state**, not from a
//! signature status, and stated with what it rests on.
//!
//! A signature status ("not found") proves absence only when every one of
//! these holds; [`absent_by_status`] encodes them so a runner can share the
//! rule (the integrator's executor decides its own `SigStatus::Absent`;
//! this is the candidate's proposal for ER-routed sends):
//!
//! 1. the status was read at `finalized`;
//! 2. the node searched its whole history (`searchTransactionHistory`) and
//!    its retained history starts at or before the send's slot;
//! 3. the transaction's blockhash can no longer land (finalized block
//!    height past its `lastValidBlockHeight`).
//!
//! On an ER none of 2–3 is established by this work (history retention and
//! blockhash expiry of the ER are unverified), so an ER-routed send is
//! **never** declared absent by status. The board's compare-and-set makes
//! that safe: resending the same request cannot apply it twice
//! ([`crate::board`]), so "unknown" only ever means "resend the same
//! request" or "look", never "send a new one".

use crate::board::{self, Write, PAYLOAD_LEN};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Landed {
    /// The copy's last write is this request, one step past the version it
    /// built on.
    Yes { seq: u64 },
    /// The copy is still at the version the request built on: not applied
    /// yet. Resending the **same** request is safe.
    NotYet,
    /// The copy moved past the version the request built on, and its last
    /// write is another request: this one either landed earlier and was
    /// followed, or lost the race. Only the log tells which; it can no
    /// longer apply. The sender rebuilds on the new version if still wanted.
    Superseded { at: u64 },
    /// The copy is older than the version the request built on (a stale
    /// endpoint, or a timeout rollback dropped it): nothing is known.
    Behind { at: u64 },
    /// The copy is at the request's `seq` with another head: the version it
    /// built on was lost (a wiped ER re-cloned the base copy and took other
    /// writes). It can never apply; the sender looks again.
    Orphaned { at: u64 },
}

/// Classifies a request `(expect_seq, expect_head, req_id)` against one
/// copy's bytes.
pub fn classify(copy: &[u8], w: &Write) -> Option<Landed> {
    let (seq, head) = board::header(copy)?;
    Some(if seq == w.expect_seq && head == w.expect_head {
        Landed::NotYet
    } else if seq < w.expect_seq {
        Landed::Behind { at: seq }
    } else if seq == w.expect_seq {
        // Same seq, another head: the version it built on is gone.
        Landed::Orphaned { at: seq }
    } else if seq == w.expect_seq + 1 && board::last_req(copy) == w.req_id {
        Landed::Yes { seq }
    } else {
        Landed::Superseded { at: seq }
    })
}

/// Resolves [`Landed::Superseded`] with a log of writes (the ER's or the
/// base's transaction log, in order, from the version the request built on).
pub fn in_log(log: &[(u64, [u8; 32])], expect_seq: u64, req_id: &[u8; 32]) -> bool {
    log.iter()
        .any(|(seq_before, r)| *seq_before == expect_seq && r == req_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StatusRead {
    pub commitment_finalized: bool,
    pub searched_history: bool,
    /// First slot the node still holds (`getFirstAvailableBlock` /
    /// `minimumLedgerSlot`).
    pub first_available_slot: u64,
    pub sent_at_slot: u64,
    pub finalized_block_height: u64,
    pub last_valid_block_height: u64,
    pub found: bool,
    /// The read went to an ER endpoint.
    pub ephemeral: bool,
}

/// `true` only when a "not found" proves the transaction can never land.
pub fn absent_by_status(r: &StatusRead) -> bool {
    !r.found
        && !r.ephemeral
        && r.commitment_finalized
        && r.searched_history
        && r.first_available_slot <= r.sent_at_slot
        && r.finalized_block_height > r.last_valid_block_height
}

/// The request id a sender stores in its journal before sending.
pub fn journal_entry(
    target: &[u8; 32],
    expect_seq: u64,
    expect_head: &[u8; 32],
    payload: &[u8; PAYLOAD_LEN],
) -> [u8; 32] {
    Write::request_id(target, expect_seq, expect_head, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read() -> StatusRead {
        StatusRead {
            commitment_finalized: true,
            searched_history: true,
            first_available_slot: 10,
            sent_at_slot: 20,
            finalized_block_height: 200,
            last_valid_block_height: 150,
            found: false,
            ephemeral: false,
        }
    }

    #[test]
    fn absence_needs_every_condition() {
        assert!(absent_by_status(&read()));
        let no = [
            StatusRead {
                found: true,
                ..read()
            },
            StatusRead {
                ephemeral: true,
                ..read()
            },
            StatusRead {
                commitment_finalized: false,
                ..read()
            },
            StatusRead {
                searched_history: false,
                ..read()
            },
            // History pruned below the send: a gap, not an absence.
            StatusRead {
                first_available_slot: 21,
                ..read()
            },
            // The blockhash can still land.
            StatusRead {
                finalized_block_height: 150,
                ..read()
            },
        ];
        for r in no {
            assert!(!absent_by_status(&r), "{r:?}");
        }
    }
}
