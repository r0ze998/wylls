//! Synthetic public receipt observations; not native execution or proof of rewards.
//! Only fixed public identifiers, SHA-256 and public address derivation are used.
#![allow(dead_code)]
use base64::Engine;
use frontier_abi::{
    addr::AddrCtx,
    log,
    world_index::{
        event as e, expedition::AccountResolver, expedition_settlement_event as settlement, march,
        ProvinceKey, WideCoord,
    },
};
use sha2::{Digest, Sha256};
pub fn ctx() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
pub fn province() -> ProvinceKey {
    ProvinceKey::new(
        AccountResolver::for_season(&ctx())
            .unwrap()
            .adapter()
            .world(),
        WideCoord::checked(129, 0).unwrap(),
    )
}
pub fn zero() -> e::WideLink {
    e::WideLink {
        entity: e::WideEntity::Province,
        seq: 0,
        head: [0; 32],
    }
}
pub fn pair(prior: e::WideLink) -> (Vec<u8>, Vec<u8>, e::WideLink) {
    let c = ctx();
    let r = AccountResolver::for_season(&c).unwrap();
    let host = r
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    let holding = r.holding_address(&host).unwrap();
    let input = [1; 32];
    let output = [2; 32];
    let operation: [u8; 32] = Sha256::new()
        .chain_update(b"PSF-BOUNDARY-CAMP-SETTLEMENT-OP-v2")
        .chain_update(input)
        .chain_update(output)
        .finalize()
        .into();
    let body = |wide| {
        let mut b = vec![
            if wide {
                e::WIDE_EVENT_VERSION
            } else {
                log::VERSION
            },
            if wide { 25 } else { 148 },
        ];
        b.extend_from_slice(&10u32.to_le_bytes());
        b.extend_from_slice(&[2, 4, 0, 0]); // camp version, Citizen present, slot, reserved
        b.extend_from_slice(&host.to_bytes());
        for a in [[7; 32], holding, march::transit_address(&c, &holding, 0)] {
            b.extend_from_slice(&a);
        }
        b.extend_from_slice(&province().to_bytes());
        b.extend_from_slice(&r.province_address(province()).unwrap());
        b.extend_from_slice(&[0; frontier_abi::world_index::key::PROVINCE_KEY_LEN]);
        b.extend_from_slice(&[0; 32]);
        b.extend_from_slice(&[7; 32]);
        for d in [operation, input, output] {
            b.extend_from_slice(&d);
        }
        assert_eq!(b.len(), settlement::BODY_LEN);
        b
    };
    let mut original = body(false);
    let links: Vec<_> = [log::EntityKind::Holding, log::EntityKind::Citizen]
        .into_iter()
        .map(|kind| log::advance(kind, 0, &[0; 32], &original).unwrap())
        .collect();
    original.push(links.len() as u8);
    for link in links {
        original.push(link.entity as u8);
        original.extend_from_slice(&link.seq.to_le_bytes());
        original.extend_from_slice(&link.head);
    }
    let mut wide = body(true);
    let link = e::advance(prior.entity, prior.seq, &prior.head, &wide).unwrap();
    wide.push(1);
    wide.push(link.entity as u8);
    wide.extend_from_slice(&link.seq.to_le_bytes());
    wide.extend_from_slice(&link.head);
    (original, wide, link)
}
pub fn tx(seq: u64, parts: &[(&[u8], &[u8])]) -> fclient::ports::TxRecord {
    let b64 = base64::engine::general_purpose::STANDARD;
    fclient::ports::TxRecord {
        seq,
        slot: seq + 100,
        signature: fclient::ports::Signature::from([seq as u8; 64]),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(
            &fclient::Address::new_from_array(ctx().program),
            parts.iter().map(|(tag, body)| {
                format!("Program data: {} {}", b64.encode(tag), b64.encode(body))
            }),
        ),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
