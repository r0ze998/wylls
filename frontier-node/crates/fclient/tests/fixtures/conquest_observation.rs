//! Synthetic canonical wire observations, no native execution or signing.
#![allow(dead_code)]
#[path = "resident.rs"]
mod resident;
use frontier_abi::world_index::{
    event::{self, conquest, WideKind},
    expedition::AccountResolver,
    ProvinceKey, WideCoord, WideHostRef,
};
pub use resident::{ctx, tx};
pub fn body(kind: WideKind, action: u8, digest: u8) -> Vec<u8> {
    let c = ctx();
    let resolver = AccountResolver::for_season(&c).unwrap();
    let key = ProvinceKey::new(
        resolver.adapter().world(),
        WideCoord::checked(129, 0).unwrap(),
    );
    let key = if kind.holding_keyed() {
        WideHostRef::new(key, 0, 1, 0).unwrap().to_bytes().to_vec()
    } else {
        key.to_bytes().to_vec()
    };
    let receipt = conquest::Receipt::new(action, 0, [digest; 32], [8; 32])
        .unwrap()
        .encode();
    let mut raw = vec![0; 800];
    let n = event::write_body(kind, 10, &key, &receipt, &mut raw).unwrap();
    raw.truncate(n);
    let links: Vec<_> = kind
        .links()
        .iter()
        .map(|entity| event::advance(*entity, 0, &[0; 32], &raw).unwrap())
        .collect();
    event::encode(kind, 10, &key, &receipt, &links).unwrap()
}
