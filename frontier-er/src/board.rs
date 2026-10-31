//! The candidate target: one small, value-free, chained account (a
//! "board"), and the one write it accepts. Layout and codes here are
//! **provisional** and local to this candidate: instruction tags, magic,
//! layout version and error numbers are assigned by the integrator's
//! registry (④), not here.
//!
//! The board follows the program's chained-header grammar (frontier-abi
//! `layout/mod.rs`: magic 8, season_id (here: world id) 8, layout u16 @16, `EVENT_SEQ` u64 @24,
//! `EVENT_HEAD` [32] @32) and its head rule
//! `head' = sha256(head ‖ le64(seq') ‖ body)` (`frontier_abi::log::next_head`),
//! so findex, the herald and the verifier can tell versions apart by
//! `(seq, head)` exactly as for the S1 accounts.
//!
//! **Idempotency.** A write names the `seq` it expects (`expect_seq`) and a
//! request id. The board applies it only if its `seq` equals `expect_seq`;
//! a second delivery of the same request therefore cannot apply twice, on
//! the ER or on the base layer, whichever copy it reaches. The request id of
//! the last write is stored, so a sender can tell "already applied" from
//! "another write came first" by reading the account, without trusting a
//! signature status (see [`crate::outcome`]).

use crate::sha256::hashv;

pub const SIZE: usize = 160;
/// Provisional magic, not registered.
pub const MAGIC: [u8; 8] = *b"CANDERB0";
pub const LAYOUT_VERSION: u16 = 2;

/// The world id, in the slot the S1 chained header calls `season_id`: the
/// existing Season PDA stays the world's identifier (renaming it is ④'s
/// migration call), and nothing here ends with it.
pub const WORLD_ID: usize = 8;
pub const LAYOUT: usize = 16;
pub const EVENT_SEQ: usize = 24;
pub const EVENT_HEAD: usize = 32;
pub const LAST_REQ: usize = 64;
pub const WRITES: usize = 96;
pub const PAYLOAD: usize = 104;
pub const PAYLOAD_LEN: usize = 32;
pub const LAST_BELL: usize = 136;
/// Set by the owner program when it restored this board with the delegation
/// program's timeout rollback: writes the ER accepted after the last
/// finalized commit are known lost (`seq` at the rollback, plus one so 0
/// means never).
pub const ROLLED_BACK_AT: usize = 144;

/// A write's outcome on one copy of the board.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteErr {
    /// Not a board of this world (wrong size, magic or world id).
    BadAccount,
    /// The board is at another `seq`; `applied` says whether its last write
    /// is this very request (a duplicate) or another one.
    StaleSeq { at: u64, applied: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Write {
    pub expect_seq: u64,
    pub req_id: [u8; 32],
    pub payload: [u8; PAYLOAD_LEN],
    pub bell: u32,
}

impl Write {
    /// The request id a sender derives before sending: it binds the target,
    /// the version it builds on and the content, so a retry of the same
    /// intent has the same id and a new intent a new one.
    pub fn request_id(target: &[u8; 32], expect_seq: u64, payload: &[u8; PAYLOAD_LEN]) -> [u8; 32] {
        hashv(&[b"wylls-er-req", target, &expect_seq.to_le_bytes(), payload])
    }
}

pub fn new_board(world: u64) -> Vec<u8> {
    let mut d = vec![0u8; SIZE];
    d[..8].copy_from_slice(&MAGIC);
    d[WORLD_ID..WORLD_ID + 8].copy_from_slice(&world.to_le_bytes());
    d[LAYOUT..LAYOUT + 2].copy_from_slice(&LAYOUT_VERSION.to_le_bytes());
    d
}

fn u64_at(d: &[u8], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[o..o + 8]);
    u64::from_le_bytes(b)
}

/// `(seq, head)` of a board, or `None` if the bytes are not a board.
pub fn header(d: &[u8]) -> Option<(u64, [u8; 32])> {
    if d.len() != SIZE || d[..8] != MAGIC {
        return None;
    }
    let mut h = [0u8; 32];
    h.copy_from_slice(&d[EVENT_HEAD..EVENT_HEAD + 32]);
    Some((u64_at(d, EVENT_SEQ), h))
}

pub fn last_req(d: &[u8]) -> [u8; 32] {
    let mut r = [0u8; 32];
    r.copy_from_slice(&d[LAST_REQ..LAST_REQ + 32]);
    r
}

/// `Some(seq)` if the owner program restored this board by a timeout
/// rollback, at that `seq`.
pub fn rolled_back_at(d: &[u8]) -> Option<u64> {
    match u64_at(d, ROLLED_BACK_AT) {
        0 => None,
        n => Some(n - 1),
    }
}

pub fn mark_rolled_back(d: &mut [u8]) {
    let seq = u64_at(d, EVENT_SEQ);
    d[ROLLED_BACK_AT..ROLLED_BACK_AT + 8].copy_from_slice(&(seq + 1).to_le_bytes());
}

pub fn world_of(d: &[u8]) -> u64 {
    u64_at(d, WORLD_ID)
}

/// The record body chained into the head (bell, request id, payload).
pub fn body(w: &Write) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + 32 + PAYLOAD_LEN);
    b.extend_from_slice(&w.bell.to_le_bytes());
    b.extend_from_slice(&w.req_id);
    b.extend_from_slice(&w.payload);
    b
}

pub fn next_head(head: &[u8; 32], seq: u64, body: &[u8]) -> [u8; 32] {
    hashv(&[head, &seq.to_le_bytes(), body])
}

/// Applies `w` to one copy of the board (the program's handler, minus the
/// account checks the runtime does).
pub fn apply(d: &mut [u8], world: u64, w: &Write) -> Result<(u64, [u8; 32]), WriteErr> {
    let (seq, head) = header(d).ok_or(WriteErr::BadAccount)?;
    if world_of(d) != world {
        return Err(WriteErr::BadAccount);
    }
    if seq != w.expect_seq {
        return Err(WriteErr::StaleSeq {
            at: seq,
            applied: last_req(d) == w.req_id,
        });
    }
    let seq2 = seq + 1;
    let head2 = next_head(&head, seq2, &body(w));
    d[EVENT_SEQ..EVENT_SEQ + 8].copy_from_slice(&seq2.to_le_bytes());
    d[EVENT_HEAD..EVENT_HEAD + 32].copy_from_slice(&head2);
    d[LAST_REQ..LAST_REQ + 32].copy_from_slice(&w.req_id);
    let writes = u64_at(d, WRITES) + 1;
    d[WRITES..WRITES + 8].copy_from_slice(&writes.to_le_bytes());
    d[PAYLOAD..PAYLOAD + PAYLOAD_LEN].copy_from_slice(&w.payload);
    d[LAST_BELL..LAST_BELL + 4].copy_from_slice(&w.bell.to_le_bytes());
    Ok((seq2, head2))
}

/// Replays `writes` from a fresh board: the `(seq, head)` every honest copy
/// must reach. A verifier uses it to tie a committed base copy to the
/// records logged on the ER.
pub fn replay(world: u64, writes: &[Write]) -> Result<Vec<u8>, WriteErr> {
    let mut d = new_board(world);
    for w in writes {
        apply(&mut d, world, w)?;
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(seq: u64, p: u8) -> Write {
        let payload = [p; PAYLOAD_LEN];
        Write {
            expect_seq: seq,
            req_id: Write::request_id(&[9; 32], seq, &payload),
            payload,
            bell: 7,
        }
    }

    #[test]
    fn a_duplicate_never_applies_twice() {
        let mut d = new_board(5);
        let a = w(0, 1);
        assert_eq!(apply(&mut d, 5, &a).map(|x| x.0), Ok(1));
        assert_eq!(
            apply(&mut d, 5, &a),
            Err(WriteErr::StaleSeq {
                at: 1,
                applied: true
            })
        );
        let b = w(0, 2); // built on the same version, another content
        assert_eq!(
            apply(&mut d, 5, &b),
            Err(WriteErr::StaleSeq {
                at: 1,
                applied: false
            })
        );
    }

    #[test]
    fn the_head_is_the_replay_of_the_writes() {
        let ws = [w(0, 1), w(1, 2), w(2, 3)];
        let d = replay(5, &ws).unwrap();
        let mut head = [0u8; 32];
        for (i, x) in ws.iter().enumerate() {
            head = next_head(&head, i as u64 + 1, &body(x));
        }
        assert_eq!(header(&d), Some((3, head)));
        assert_eq!(
            apply(&mut new_board(6), 5, &ws[0]),
            Err(WriteErr::BadAccount)
        );
    }
}
