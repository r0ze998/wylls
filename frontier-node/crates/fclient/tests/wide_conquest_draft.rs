#![cfg(feature = "wide-records-experimental")]
//! Pure public-address construction for the wide DeclareSiege proposal, and
//! the Rust-produced vector the JavaScript derivation
//! (permutation-server/web/frontier/fconquest-identity.mjs) is compared with.
//! No keys, signatures, processes, RPC, transactions or filesystem writes.
use fclient::wide_conquest_draft::{Draft, Error, CONTENT_DIGEST_DOMAIN};
use fclient::Address;
use frontier_abi::{
    addr::AddrCtx,
    prologue::Wr,
    world_index::{
        expedition::AccountResolver,
        wide_ix::{self, DeclareSiege},
        ProvinceKey, WideCoord, WideHostRef,
    },
};
use serde_json::{json, Value};

const VECTOR: &str = include_str!("fixtures/wide_conquest_declare_siege_v1.json");

fn address(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn context() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
fn selection(ctx: &AddrCtx, standing: (i64, i64)) -> (WideHostRef, ProvinceKey) {
    let r = AccountResolver::for_season(ctx).unwrap();
    (
        r.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
            .unwrap(),
        ProvinceKey::new(
            r.adapter().world(),
            WideCoord::checked(standing.0, standing.1).unwrap(),
        ),
    )
}
fn case(ctx: &AddrCtx, standing: (i64, i64), site: u8, entry: u8, wallet: Address) -> Value {
    let (host, key) = selection(ctx, standing);
    let d = Draft::declare_siege(ctx, host, key, site, entry, wallet).unwrap();
    json!({
        "standing": { "p": standing.0.to_string(), "q": standing.1.to_string() },
        "site": site, "entry": entry, "wallet": wallet.to_string(),
        "host": hex::encode(host.to_bytes()),
        "standing_key": hex::encode(key.to_bytes()),
        "inner_hex": hex::encode(d.inner_bytes()),
        "content_digest": hex::encode(d.content_digest()),
        "roles": d.roles().iter().map(|a| json!({"name": a.name, "address": a.address.to_string(), "signer": a.signer, "writable": a.writable})).collect::<Vec<_>>(),
    })
}
/// The whole vector: one context, several selections (another site, another
/// province, another wallet), so a substitution between them is visible.
fn vector() -> Value {
    let ctx = context();
    json!({
        "schema": "frontier-wide-conquest-declare-siege-vector-v1",
        "source": "frontier-node/crates/fclient/tests/wide_conquest_draft.rs (Rust: frontier-abi address helpers)",
        "program": Address::new_from_array(ctx.program).to_string(),
        "season": Address::new_from_array(ctx.season).to_string(),
        "home": { "p": 128, "q": 0, "site": 1, "gen": 2, "seq": 0 },
        "cases": [
            case(&ctx, (129, 0), 3, 0, address(7)),
            case(&ctx, (129, 0), 4, 0, address(7)),
            case(&ctx, (129, 0), 11, 55, address(7)),
            case(&ctx, (130, 0), 3, 0, address(7)),
            case(&ctx, (129, -1), 0, 9, address(7)),
            case(&ctx, (129, 0), 3, 0, address(8)),
        ],
    })
}

#[test]
fn declare_siege_roles_are_the_abi_table_and_the_inner_bytes_the_abi_codec() {
    let ctx = context();
    let (host, key) = selection(&ctx, (129, 0));
    let d = Draft::declare_siege(&ctx, host, key, 3, 0, address(7)).unwrap();
    let specs = wide_ix::DECLARE_SIEGE[0].specs;
    assert_eq!(d.roles().len(), 12);
    assert_eq!(specs.len(), 12);
    for (i, (role, spec)) in d.roles().iter().zip(specs.iter()).enumerate() {
        assert_eq!(role.name, spec.name);
        assert_eq!(role.signer, spec.signer);
        // the wallet stands twice (actor read-only, payer writable): both
        // positions carry the globalized writable flag
        assert_eq!(role.writable, spec.wr == Wr::W || i == 0, "{}", role.name);
    }
    assert_eq!(d.roles()[0].address, address(7));
    assert_eq!(d.roles()[1].address, address(7));
    assert_eq!(d.roles()[2].address, Address::new_from_array(ctx.season));
    assert_eq!(
        d.roles()[3].address,
        Address::new_from_array(ctx.citizen(&[7; 32]))
    );
    assert_eq!(d.roles()[11].address, Address::default());
    assert_eq!(d.inner_bytes(), [0xDA, 0xFF, 0x01, 0x05, 3, 0]);
    assert_eq!(
        DeclareSiege::decode(&d.inner_bytes()).unwrap(),
        DeclareSiege { site: 3, entry: 0 }
    );
    assert_eq!(CONTENT_DIGEST_DOMAIN, b"PSF-ORIGINAL-CONQUEST-DRAFT-v1");
    assert!(!d.public_dispatch_available());
    assert!(!d.admitted());
    assert!(!d.not_proven().is_empty());
    // another site moves only the target holding position; another province
    // moves the province, its roster, the position and the conquest table;
    // another wallet moves the Citizen and its escrow
    let roles = |standing, site, wallet| {
        let (h, k) = selection(&ctx, standing);
        Draft::declare_siege(&ctx, h, k, site, 0, wallet)
            .unwrap()
            .roles()
            .to_vec()
    };
    let base = roles((129, 0), 3, address(7));
    let moved = |other: &[fclient::wide_conquest_draft::Role]| {
        (0..12)
            .filter(|i| other[*i].address != base[*i].address)
            .collect::<Vec<_>>()
    };
    assert_eq!(moved(&roles((129, 0), 4, address(7))), vec![8]);
    assert_eq!(moved(&roles((130, 0), 3, address(7))), vec![5, 6, 8, 9]);
    assert_eq!(moved(&roles((129, 0), 3, address(8))), vec![0, 1, 3, 10]);
}

#[test]
fn refusals() {
    let ctx = context();
    let (host, key) = selection(&ctx, (129, 0));
    let w = address(7);
    assert_eq!(
        Draft::declare_siege(&ctx, host, key, 12, 0, w),
        Err(Error::SiteOrEntry)
    );
    assert_eq!(
        Draft::declare_siege(&ctx, host, key, 0, 56, w),
        Err(Error::SiteOrEntry)
    );
    let same = AddrCtx {
        program: [4; 32],
        season: [4; 32],
    };
    assert_eq!(
        Draft::declare_siege(&same, host, key, 0, 0, w),
        Err(Error::ContextOrHost)
    );
    // the standing province must be wide; the home key (ring 128) is not
    assert_eq!(
        Draft::declare_siege(&ctx, host, host.key(), 0, 0, w),
        Err(Error::StandingFamily)
    );
    // the wallet may not be the program
    assert_eq!(
        Draft::declare_siege(&ctx, host, key, 0, 0, Address::new_from_array(ctx.program)),
        Err(Error::ZeroOrProgramRecipient)
    );
    assert_eq!(
        Draft::declare_siege(&ctx, host, key, 0, 0, Address::default()),
        Err(Error::ZeroOrProgramRecipient)
    );
}

/// The vector is printed (so a first run can record it) and must equal the
/// recorded fixture byte for byte as JSON values.
#[test]
fn rust_vector_matches_the_recorded_fixture() {
    let v = vector();
    println!("CONQUEST_VECTOR_BEGIN{}CONQUEST_VECTOR_END", v);
    let recorded: Value = serde_json::from_str(VECTOR).unwrap();
    assert_eq!(recorded, v, "record the printed vector into the fixture");
}
