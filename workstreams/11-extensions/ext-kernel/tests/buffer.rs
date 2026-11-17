//! Chunked publication: unfinished, missing, out of order, repeated and
//! conflicting pieces; nothing runs before the content hash is checked.
//! Host-tested only (no Solana runtime, no transaction size limit applied).

mod common;

use common::*;
use wylls_ext_kernel::buffer::Buffers;
use wylls_ext_kernel::examples::{watch_vow, PLEDGE};
use wylls_ext_kernel::host::Host;
use wylls_ext_kernel::manifest::{id_of, Manifest, MAX_BYTES};
use wylls_ext_kernel::verify::{verify, Verdict};
use wylls_ext_kernel::ExtError;

const T: i64 = T0 + 10 * BELL;

fn vow_bytes() -> (Vec<u8>, [u8; 32]) {
    let b = watch_vow(AUTHOR_A).encode();
    let id = id_of(&b);
    (b, id)
}

/// Pieces of `n` bytes: (offset, bytes).
fn pieces(b: &[u8], n: usize) -> Vec<(usize, Vec<u8>)> {
    b.chunks(n)
        .enumerate()
        .map(|(i, c)| (i * n, c.to_vec()))
        .collect()
}

/// A call naming `id` before it is registered runs nothing.
fn cannot_run(host: &mut Host, id: [u8; 32]) {
    host.set_grant(&B_WALLET, grant(B_CITIZEN, id, 10_000, 10_000))
        .unwrap();
    let before = host.clone();
    assert_eq!(
        host.call(&call(id, PLEDGE, &[5_000, 1], 0, T)),
        Err(ExtError::NotRegistered)
    );
    assert_eq!(host.instances, before.instances);
    assert_eq!(wood(host, &B_HOLDING, T), WOOD0);
}

#[test]
fn b01_pieces_in_any_order_with_repeats_then_the_hash_then_it_runs() {
    let mut host = world();
    let mut buf = Buffers::default();
    let (bytes, id) = vow_bytes();
    buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
        .unwrap();
    let mut ps = pieces(&bytes, 100);
    ps.reverse();
    let repeat = ps[1].clone();
    ps.insert(3, repeat);
    for (i, (off, p)) in ps.iter().enumerate() {
        buf.write(&AUTHOR_A, id, *off, p).unwrap();
        if i + 1 < ps.len() {
            assert_eq!(
                buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
                Err(ExtError::Incomplete)
            );
            cannot_run(&mut host, id);
        }
    }
    let got = buf
        .finalize(&mut host.registry, &AUTHOR_A, id, None, T)
        .unwrap();
    assert_eq!(got, id);
    assert!(buf.open.is_empty());
    // A second finalize finds no buffer; the registration stays one.
    assert_eq!(
        buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
        Err(ExtError::NoBuffer)
    );
    let before = host.clone();
    host.call(&call(id, PLEDGE, &[5_000, 1], 0, T)).unwrap();
    assert_eq!(verify(&evidence(&before, &host)), Verdict::Pass);
}

#[test]
fn b02_every_order_of_five_pieces_gives_the_same_id() {
    let (bytes, id) = vow_bytes();
    let ps = pieces(&bytes, bytes.len().div_ceil(5));
    assert_eq!(ps.len(), 5);
    let mut perm: Vec<usize> = (0..5).collect();
    let mut count = 0;
    // Heap's algorithm over the 120 orders.
    fn heap(k: usize, a: &mut Vec<usize>, f: &mut dyn FnMut(&[usize])) {
        if k == 1 {
            f(a);
            return;
        }
        heap(k - 1, a, f);
        for i in 0..k - 1 {
            if k % 2 == 0 {
                a.swap(i, k - 1);
            } else {
                a.swap(0, k - 1);
            }
            heap(k - 1, a, f);
        }
    }
    heap(5, &mut perm, &mut |order| {
        let mut host = world();
        let mut buf = Buffers::default();
        buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
            .unwrap();
        for &i in order {
            buf.write(&AUTHOR_A, id, ps[i].0, &ps[i].1).unwrap();
        }
        assert_eq!(
            buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
            Ok(id)
        );
        count += 1;
    });
    assert_eq!(count, 120);
}

#[test]
fn b03_a_missing_piece_is_unfinished_and_runs_nothing() {
    let mut host = world();
    let mut buf = Buffers::default();
    let (bytes, id) = vow_bytes();
    buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
        .unwrap();
    // Everything but one byte in the middle.
    buf.write(&AUTHOR_A, id, 0, &bytes[..200]).unwrap();
    buf.write(&AUTHOR_A, id, 201, &bytes[201..]).unwrap();
    assert_eq!(buf.open[&(AUTHOR_A, id)].missing(), 1);
    assert_eq!(
        buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
        Err(ExtError::Incomplete)
    );
    assert!(host.registry.get(&id).is_none());
    cannot_run(&mut host, id);
    // The last byte completes it.
    buf.write(&AUTHOR_A, id, 200, &bytes[200..201]).unwrap();
    assert_eq!(
        buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
        Ok(id)
    );
}

#[test]
fn b04_a_piece_that_changes_written_bytes_is_refused_whole() {
    let host = world();
    let mut buf = Buffers::default();
    let (bytes, id) = vow_bytes();
    buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
        .unwrap();
    buf.write(&AUTHOR_A, id, 0, &bytes[..100]).unwrap();
    let snapshot = buf.open[&(AUTHOR_A, id)].clone();
    // Same range, one byte different.
    let mut bad = bytes[..100].to_vec();
    bad[50] ^= 1;
    assert_eq!(
        buf.write(&AUTHOR_A, id, 0, &bad),
        Err(ExtError::ChunkConflict)
    );
    // Overlapping: the new half would be fine, the old half conflicts.
    let mut over = bytes[50..150].to_vec();
    over[0] ^= 1;
    assert_eq!(
        buf.write(&AUTHOR_A, id, 50, &over),
        Err(ExtError::ChunkConflict)
    );
    // Neither write changed anything (not even the new half).
    assert_eq!(buf.open[&(AUTHOR_A, id)], snapshot);
    // The identical piece again is accepted.
    buf.write(&AUTHOR_A, id, 0, &bytes[..100]).unwrap();
    assert_eq!(buf.open[&(AUTHOR_A, id)], snapshot);
}

#[test]
fn b05_bytes_that_are_not_the_promised_content_never_register() {
    let mut host = world();
    let mut buf = Buffers::default();
    let (bytes, id) = vow_bytes();
    // The same length, one argument bound different: another manifest.
    let mut other = watch_vow(AUTHOR_A);
    other.entries[0].args[1].max = 143;
    let other = other.encode();
    assert_eq!(other.len(), bytes.len());
    buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
        .unwrap();
    buf.write(&AUTHOR_A, id, 0, &other).unwrap();
    assert_eq!(
        buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
        Err(ExtError::HashMismatch)
    );
    assert!(host.registry.entries.is_empty());
    cannot_run(&mut host, id);
    cannot_run(&mut host, id_of(&other));
    // Written bytes cannot be changed; the author abandons and starts over.
    buf.abandon(&AUTHOR_A, id).unwrap();
    buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
        .unwrap();
    buf.write(&AUTHOR_A, id, 0, &bytes).unwrap();
    assert_eq!(
        buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
        Ok(id)
    );
}

#[test]
fn b06_a_matching_hash_still_needs_a_valid_manifest() {
    let mut host = world();
    let mut buf = Buffers::default();
    // Bytes of a vocabulary this core does not know, under their own id.
    let mut m = watch_vow(AUTHOR_A);
    m.effect_set = 2;
    let b = m.encode();
    let id = id_of(&b);
    buf.open(&host.registry, &AUTHOR_A, id, b.len()).unwrap();
    buf.write(&AUTHOR_A, id, 0, &b).unwrap();
    assert_eq!(
        buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T),
        Err(ExtError::UnknownEffectSet)
    );
    assert!(host.registry.entries.is_empty());
    // Bytes naming author A, opened and finalized by C.
    let (bytes, vid) = vow_bytes();
    buf.open(&host.registry, &C_WALLET, vid, bytes.len())
        .unwrap();
    buf.write(&C_WALLET, vid, 0, &bytes).unwrap();
    assert_eq!(
        buf.finalize(&mut host.registry, &C_WALLET, vid, None, T),
        Err(ExtError::NotSigned)
    );
    assert!(host.registry.entries.is_empty());
    assert_eq!(Manifest::decode(&bytes).unwrap().author, AUTHOR_A);
}

#[test]
fn b07_bounds_and_ownership_of_a_buffer() {
    let mut host = world();
    let mut buf = Buffers::default();
    let (bytes, id) = vow_bytes();
    assert_eq!(
        buf.open(&host.registry, &AUTHOR_A, id, 0),
        Err(ExtError::TooLarge)
    );
    assert_eq!(
        buf.open(&host.registry, &AUTHOR_A, id, MAX_BYTES + 1),
        Err(ExtError::TooLarge)
    );
    buf.open(&host.registry, &AUTHOR_A, id, bytes.len())
        .unwrap();
    assert_eq!(
        buf.open(&host.registry, &AUTHOR_A, id, bytes.len()),
        Err(ExtError::BufferExists)
    );
    assert_eq!(
        buf.write(&AUTHOR_A, id, bytes.len() - 1, &bytes[..2]),
        Err(ExtError::OutOfBounds)
    );
    assert_eq!(buf.write(&AUTHOR_A, id, 0, &[]), Err(ExtError::OutOfBounds));
    assert_eq!(
        buf.write(&AUTHOR_A, id, usize::MAX, &bytes[..1]),
        Err(ExtError::OutOfBounds)
    );
    // Someone else cannot write into or finalize A's buffer.
    assert_eq!(buf.write(&C_WALLET, id, 0, &bytes), Err(ExtError::NoBuffer));
    assert_eq!(
        buf.finalize(&mut host.registry, &C_WALLET, id, None, T),
        Err(ExtError::NoBuffer)
    );
    assert_eq!(buf.abandon(&C_WALLET, id), Err(ExtError::NoBuffer));
    // Once registered, no buffer can be opened for the id again.
    buf.write(&AUTHOR_A, id, 0, &bytes).unwrap();
    buf.finalize(&mut host.registry, &AUTHOR_A, id, None, T)
        .unwrap();
    assert_eq!(
        buf.open(&host.registry, &AUTHOR_A, id, bytes.len()),
        Err(ExtError::AlreadyRegistered)
    );
}
