//! Immutable native emitted logs, framed here only as supplied archive observations.
//! No execution, private keys, transaction construction, signatures or network.
#![allow(dead_code)]
use base64::Engine;
use frontier_abi::addr::AddrCtx;
pub fn trace() -> (AddrCtx, Vec<fclient::ports::TxRecord>) {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("original_boundary_v1.bin");
    assert_eq!(
        hex::encode(Sha256::digest(bytes)),
        "48e97269e39672bee2f19b7c692a8dca95b608f050c45e2e932922b4de9e47d5"
    );
    fn take<'a>(b: &mut &'a [u8], n: usize) -> &'a [u8] {
        assert!(n <= b.len());
        let (x, rest) = b.split_at(n);
        *b = rest;
        x
    }
    fn u32(b: &mut &[u8]) -> usize {
        u32::from_le_bytes(take(b, 4).try_into().unwrap()) as usize
    }
    let mut b = bytes.as_slice();
    assert_eq!(take(&mut b, 8), b"BTRCv001");
    let ctx = AddrCtx {
        program: take(&mut b, 32).try_into().unwrap(),
        season: take(&mut b, 32).try_into().unwrap(),
    };
    let p = fclient::Address::new_from_array(ctx.program);
    let count = u32(&mut b);
    assert!(count > 0 && count < 256);
    let mut txs = Vec::new();
    for i in 0..count {
        let timestamp = i64::from_le_bytes(take(&mut b, 8).try_into().unwrap());
        let slot = u64::from_le_bytes(take(&mut b, 8).try_into().unwrap());
        let n = u16::from_le_bytes(take(&mut b, 2).try_into().unwrap()) as usize;
        assert!(n < 64);
        let mut logs = Vec::new();
        for _ in 0..n {
            let mut fields = Vec::new();
            for _ in 0..2 {
                let len = u32(&mut b);
                assert!(len < 1024);
                fields.push(base64::engine::general_purpose::STANDARD.encode(take(&mut b, len)));
            }
            logs.push(format!("Program data: {} {}", fields[0], fields[1]));
        }
        txs.push(fclient::ports::TxRecord {
            seq: (i + 1) as u64,
            slot,
            signature: fclient::ports::Signature::from([(i + 1) as u8; 64]),
            block_time: timestamp,
            tx: vec![],
            logs: fclient::log::in_frame(&p, logs),
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![],
        });
    }
    assert!(b.is_empty());
    (ctx, txs)
}
