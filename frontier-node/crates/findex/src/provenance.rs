//! What an archived post-state proves (offchain design §8.2; candidate of
//! the ER work, `docs/frontier/er-candidate/`).
//!
//! The local node's feed carries the exact bytes each transaction wrote. A
//! public RPC carries none; [`crate::Enriched`] reads the written accounts
//! with `getMultipleAccounts(minContextSlot = s)`, which returns **the state
//! at some slot ≥ s**: a later write can show through, and an account the
//! base layer has handed to the delegation program shows the last bytes
//! committed to the base, not the live ones. Such bytes are stored with the
//! transaction, so they must not be read as "the state right after it".
//!
//! [`post_checks`] says, per written account, what the archive can prove:
//! only a chained account whose header carries exactly a `(seq, head)` this
//! transaction's records produced is that transaction's post-state. It
//! changes nothing in the archive or the index; readers (herald, verifier)
//! call it to label or skip.

use fclient::ports::TxRecord;
use solana_address::Address;

/// The delegation program (MagicBlock, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`):
/// a program account it owns is delegated, its bytes the last committed.
pub const DELEGATION_PROGRAM: Address = Address::new_from_array([
    181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229,
    25, 152, 204, 98, 126, 24, 147, 128, 167, 62,
]);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostCheck {
    /// The header's `(seq, head)` is one this transaction's records made:
    /// the exact bytes it wrote.
    Exact,
    /// A chained account at another version (a later write showed through,
    /// or the transaction wrote it without chaining it): bytes at some
    /// slot ≥ the transaction's, version `seq`.
    Unverified { seq: u64 },
    /// Program-owned but not chained: nothing tells its version.
    Unchained,
    /// Owned by the delegation program: the last committed bytes; the live
    /// state is on the ER.
    Delegated,
    /// Owned by another program (or a wallet).
    Foreign,
    /// Closed or never created at the read.
    Absent,
}

/// Per written account of `r`, what its archived bytes prove. With
/// `exact_source` (the local node's feed) every present program account is
/// [`PostCheck::Exact`].
pub fn post_checks(
    r: &TxRecord,
    program: &Address,
    exact_source: bool,
) -> Vec<(Address, PostCheck)> {
    let links: Vec<(u64, [u8; 32])> = if r.err.is_some() {
        vec![]
    } else {
        crate::records(r, program)
            .map(|recs| {
                recs.iter()
                    .flat_map(|rec| rec.links.iter().map(|l| (l.seq, l.head)))
                    .collect()
            })
            .unwrap_or_default()
    };
    r.post
        .iter()
        .map(|(k, a)| {
            let c = match a {
                None => PostCheck::Absent,
                Some(a) if a.owner == DELEGATION_PROGRAM => PostCheck::Delegated,
                Some(a) if a.owner != *program => {
                    if fclient::decode::is_absent(&a.owner, &a.data) {
                        PostCheck::Absent
                    } else {
                        PostCheck::Foreign
                    }
                }
                Some(_) if exact_source => PostCheck::Exact,
                Some(a) if !is_chained(&a.data) => PostCheck::Unchained,
                Some(a) => match fclient::decode::chained_header(&a.data) {
                    None => PostCheck::Unchained,
                    Some(h) if links.contains(&(h.event_seq, h.event_head)) => PostCheck::Exact,
                    Some(h) => PostCheck::Unverified { seq: h.event_seq },
                },
            };
            (*k, c)
        })
        .collect()
}

/// A kind with the chained header (its magic names a chained kind).
fn is_chained(d: &[u8]) -> bool {
    d.get(..8)
        .and_then(|m| frontier_abi::v2::layout::AccountKind::from_magic(m.try_into().ok()?))
        .is_some_and(|k| k.chained())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fclient::ports::{Account, Signature};
    use frontier_abi::log::{advance, write_body, write_tail, EntityKind, Kind};

    fn chained(magic: &[u8; 8], seq: u64, head: [u8; 32]) -> Vec<u8> {
        let mut d = vec![0u8; 2_048];
        d[..8].copy_from_slice(magic);
        d[24..32].copy_from_slice(&seq.to_le_bytes());
        d[32..64].copy_from_slice(&head);
        d
    }

    #[test]
    fn only_a_header_the_records_made_is_the_post_state() {
        let program = Address::new_from_array([0xAB; 32]);
        let acct = |owner: Address, data: Vec<u8>| {
            Some(Account {
                lamports: 1,
                data,
                owner,
                executable: false,
            })
        };
        // One GENESIS_SEED record chaining the Season from (4, h0) to l1.
        let key = 3u64.to_le_bytes();
        let payload = [2u8; 40];
        let mut bwt = vec![0u8; 64];
        let n = write_body(Kind::GENESIS_SEED, u32::MAX, &key, &payload, &mut bwt).unwrap();
        let l1 = advance(EntityKind::Season, 4, &[9u8; 32], &bwt[..n]).unwrap();
        let mut body = vec![0u8; 512];
        let n2 = write_body(Kind::GENESIS_SEED, u32::MAX, &key, &payload, &mut body).unwrap();
        let m = write_tail(&[l1], &mut body, n2).unwrap();
        body.truncate(m);
        let logs = fclient::log::in_frame(&program, [fclient::log::log_line(&body)]);
        let k = |i: u8| Address::new_from_array([i; 32]);
        let post = vec![
            (k(1), acct(program, chained(b"PSF1SEAS", l1.seq, l1.head))),
            // The same account read later: one more write showed through.
            (
                k(2),
                acct(program, chained(b"PSF1SEAS", l1.seq + 1, [5; 32])),
            ),
            (k(3), acct(program, vec![0u8; 144])),
            (
                k(4),
                acct(DELEGATION_PROGRAM, chained(b"PSF1SEAS", l1.seq, l1.head)),
            ),
            (
                k(5),
                acct(Address::new_from_array([0x77; 32]), vec![1, 2, 3]),
            ),
            (k(6), None),
        ];
        let r = TxRecord {
            seq: 1,
            slot: 10,
            signature: Signature::from([1; 64]),
            block_time: 0,
            tx: vec![],
            logs,
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post,
        };
        let got: Vec<PostCheck> = post_checks(&r, &program, false)
            .into_iter()
            .map(|x| x.1)
            .collect();
        assert_eq!(
            got,
            vec![
                PostCheck::Exact,
                PostCheck::Unverified { seq: l1.seq + 1 },
                PostCheck::Unchained,
                PostCheck::Delegated,
                PostCheck::Foreign,
                PostCheck::Absent,
            ]
        );
        // A failed transaction proves no version.
        let failed = TxRecord {
            err: Some("x".into()),
            ..r.clone()
        };
        assert_eq!(
            post_checks(&failed, &program, false)[0].1,
            PostCheck::Unverified { seq: l1.seq }
        );
        // The local feed's bytes are exact.
        assert_eq!(post_checks(&r, &program, true)[1].1, PostCheck::Exact);
    }
}
