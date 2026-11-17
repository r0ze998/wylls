// Pure public-identity wire fixture. No account execution, keys or signing.
use frontier_abi::{
    addr::AddrCtx,
    log,
    world_index::{
        event, expedition::AccountResolver, expedition_resident_event as resident, ProvinceKey,
        WideCoord,
    },
};
pub fn ctx() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [3; 32],
    }
}
pub fn pair(action: resident::Action, previous: event::WideLink) -> (Vec<u8>, Vec<u8>) {
    let c = ctx();
    let resolver = AccountResolver::for_season(&c).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
        .unwrap();
    let standing = ProvinceKey::new(
        resolver.adapter().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    let receipt = resident::Receipt::new([7; 32], [8; 32]);
    let mut b = vec![log::VERSION, resident::ORIGINAL_KIND];
    b.extend_from_slice(&10u32.to_le_bytes());
    b.extend_from_slice(&[1, action as u8, 0, 0]);
    b.extend_from_slice(&host.to_bytes());
    b.extend_from_slice(&[9; 32]);
    b.extend_from_slice(&resolver.holding_address(&host).unwrap());
    b.extend_from_slice(&standing.to_bytes());
    b.extend_from_slice(&resolver.province_address(standing).unwrap());
    b.extend_from_slice(&[2, 2]);
    b.extend_from_slice(&24000u32.to_le_bytes());
    b.extend_from_slice(&10u32.to_le_bytes());
    b.extend_from_slice(
        &(if action == resident::Action::Return {
            24u32
        } else {
            0
        })
        .to_le_bytes(),
    );
    for d in [receipt.operation_id, receipt.input, receipt.output] {
        b.extend_from_slice(&d);
    }
    assert_eq!(b.len(), resident::BODY_LEN);
    let mut w = b.clone();
    w[0] = event::WIDE_EVENT_VERSION;
    w[1] = resident::WIDE_KIND;
    let l = event::advance(
        event::WideEntity::Province,
        previous.seq,
        &previous.head,
        &w,
    )
    .unwrap();
    w.push(1);
    w.push(l.entity as u8);
    w.extend_from_slice(&l.seq.to_le_bytes());
    w.extend_from_slice(&l.head);
    let links: Vec<_> = action
        .entities()
        .iter()
        .map(|e| log::advance(*e, 0, &[0; 32], &b).unwrap())
        .collect();
    b.push(links.len() as u8);
    for l in links {
        b.push(l.entity as u8);
        b.extend_from_slice(&l.seq.to_le_bytes());
        b.extend_from_slice(&l.head);
    }
    (b, w)
}
pub fn zero() -> event::WideLink {
    event::WideLink {
        entity: event::WideEntity::Province,
        seq: 0,
        head: [0; 32],
    }
}
#[allow(dead_code)] // Shared by decoder/index fixtures; herald tests only format rows.
pub fn tx(parts: &[(&[u8], &[u8])]) -> fclient::ports::TxRecord {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD;
    let logs: Vec<_> = parts
        .iter()
        .map(|(tag, body)| format!("Program data: {} {}", b.encode(tag), b.encode(body)))
        .collect();
    fclient::ports::TxRecord {
        seq: 1,
        slot: 1,
        signature: fclient::ports::Signature::from([1; 64]),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(&fclient::Address::new_from_array(ctx().program), logs),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
