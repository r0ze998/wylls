#![cfg(feature = "wide-records-experimental")]
//! Pure, public construction/codec checks only. Synthetic bytes are not seals,
//! transactions, native account snapshots, signatures or runtime authorization.
use fclient::original_expedition_depart_draft::{Draft, Error};
use fclient::Address;
use frontier_abi::{
    addr::AddrCtx,
    world_index::{
        expedition::AccountResolver,
        expedition_event::{Action, Record},
        seal::{self as wide_seal, WidePlain},
        tiles::{TileAddress, WideTile},
        wide_ix::{ExpeditionDepart, ResidentAct, WideCommand, EXPEDITION_DEPART},
        ProvinceKey, WideCoord, WideHostRef,
    },
};
use serde_json::{json, Value};

fn context() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
fn address(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn key(ctx: &AddrCtx, p: i64, q: i64) -> ProvinceKey {
    ProvinceKey::new(
        AccountResolver::for_season(ctx).unwrap().adapter().world(),
        WideCoord::checked(p, q).unwrap(),
    )
}
fn host(ctx: &AddrCtx, p: i64, q: i64) -> WideHostRef {
    WideHostRef::new(key(ctx, p, q), 1, 2, 7).unwrap()
}
// Public literal shape bytes, deliberately no claim of encryption or binding.
const PUBLIC_COMMIT: [u8; 32] = [0x31; 32];
const PUBLIC_SEAL: [u8; 264] = {
    let mut b = [0; 264];
    b[0] = 0x80;
    b
};
fn draft(
    ctx: &AddrCtx,
    h: WideHostRef,
    standing: ProvinceKey,
    wallet: Address,
    payer: Address,
    slot: u8,
) -> Result<Draft, Error> {
    Draft::for_wallet(
        ctx,
        h,
        standing,
        wallet,
        payer,
        slot,
        12,
        2500,
        PUBLIC_COMMIT,
        PUBLIC_SEAL,
    )
}
fn tile_json(t: WideTile) -> Value {
    let c = t.province_coord();
    json!({"world": hex::encode(t.world().as_bytes()), "key": hex::encode(t.province().to_bytes()),
        "p": c.p().to_string(), "q": c.q().to_string(), "tile": t.local(),
        "tileQ": t.q().to_string(), "tileR": t.r().to_string(), "ring": c.ring().to_string()})
}
fn host_json(h: WideHostRef) -> Value {
    json!({"world": hex::encode(h.key().world().as_bytes()), "p": h.key().coord().p().to_string(),
        "q": h.key().coord().q().to_string(), "site": h.site(), "gen": h.gen(), "seq": h.seq()})
}
fn origin_json(t: WideTile) -> Value {
    json!({"p": t.province_coord().p().to_string(), "q": t.province_coord().q().to_string(), "tile": t.local()})
}
fn route(origin: WideTile, directions: &[u8]) -> (WideTile, Vec<WideTile>, Vec<String>) {
    assert!(directions.len() <= 32);
    let mut current = origin;
    let mut steps = vec![];
    for &d in directions {
        assert!(d < 6);
        current = current.neighbors()[d as usize].unwrap();
        steps.push(current);
    }
    // Match canonical path_tiles: destination first, then other first-entered
    // provinces, not the origin unless a traversed tile lies in that province.
    let mut keys = if directions.is_empty() {
        vec![]
    } else {
        vec![hex::encode(current.province().to_bytes())]
    };
    for t in &steps {
        let k = hex::encode(t.province().to_bytes());
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    assert!(keys.len() <= 4);
    (current, steps, keys)
}
fn boundary_origin(ctx: &AddrCtx, p: i64, q: i64, direction: usize) -> WideTile {
    let original = key(ctx, p, q);
    (0..61)
        .find_map(|local| {
            let border = WideTile::of(TileAddress::new(original, local).unwrap());
            let next = border.neighbors()[direction]?;
            let prev = border.neighbors()[(direction + 3) % 6]?;
            (next.province_coord().ring() > 128 && prev.province() == original).then_some(prev)
        })
        .unwrap()
}
fn plain_vector(
    name: &str,
    ctx: &AddrCtx,
    h: WideHostRef,
    origin: WideTile,
    dirs: &[u8],
    bell: u32,
    stance: u8,
    retreat: u16,
) -> Value {
    let (end, steps, keys) = route(origin, dirs);
    let (path_len, path) = permutation_rules::frontier::seal::encode_path(dirs).unwrap();
    let plain = WidePlain {
        version: wide_seal::WIDE_PLAIN_VERSION,
        host: h,
        arrive_bell: bell,
        dest: end.province(),
        dest_tile: end.local(),
        stance,
        retreat_bps: retreat,
        path_len,
        path,
        reserved: [0; 8],
    };
    wide_seal::validate(&plain, &h, bell).unwrap();
    let packed = wide_seal::pack(&plain);
    assert_eq!(wide_seal::unpack(&packed).unwrap(), plain);
    json!({"name": name, "program": Address::new_from_array(ctx.program).to_string(),
        "season": Address::new_from_array(ctx.season).to_string(), "programHex": hex::encode(ctx.program),
        "seasonHex": hex::encode(ctx.season), "world": hex::encode(h.key().world().as_bytes()),
        "host": hex::encode(h.to_bytes()), "hostHex": hex::encode(h.to_bytes()), "hostFields": host_json(h),
        "origin": origin_json(origin), "directions": dirs, "arriveBell": bell, "stance": stance, "retreatBps": retreat,
        "plainHex": hex::encode(packed), "pathHex": hex::encode(path), "pathLen": path_len,
        "endpoint": tile_json(end), "steps": steps.into_iter().map(tile_json).collect::<Vec<_>>(), "accountKeys": keys})
}
fn geometry_vector(name: &str, origin: WideTile, dirs: &[u8]) -> Value {
    let (end, steps, keys) = route(origin, dirs);
    json!({"name": name, "world": hex::encode(origin.world().as_bytes()), "origin": origin_json(origin),
        "directions": dirs, "endpoint": tile_json(end),
        "steps": steps.into_iter().map(tile_json).collect::<Vec<_>>(), "accountKeys": keys})
}
fn depart_vector(
    name: &str,
    ctx: &AddrCtx,
    h: WideHostRef,
    standing: ProvinceKey,
    wallet: Address,
    payer: Address,
    slot: u8,
) -> Value {
    let d = draft(ctx, h, standing, wallet, payer, slot).unwrap();
    json!({"name": name, "program": d.program().to_string(), "season": d.season().to_string(),
        "programHex": hex::encode(ctx.program), "seasonHex": hex::encode(ctx.season),
        "world": hex::encode(h.key().world().as_bytes()), "host": hex::encode(h.to_bytes()),
        "hostHex": hex::encode(h.to_bytes()), "hostFields": host_json(h),
        "hostId": AccountResolver::for_season(ctx).unwrap().legacy_host_id(&h).unwrap().to_string(),
        "standing": {"p": standing.coord().p().to_string(), "q": standing.coord().q().to_string()},
        "wallet": wallet.to_string(), "payer": payer.to_string(), "transitSlot": slot, "arriveBell": 12,
        "tip": "2500", "commitHex": hex::encode(PUBLIC_COMMIT), "sealHex": hex::encode(PUBLIC_SEAL),
        "wireHex": hex::encode(d.proposed_bytes()), "sealVerified": false, "admitted": false,
        "roles": d.roles().iter().map(|r| json!({"name": r.name, "address": r.address.to_string(),
            "addressHex": hex::encode(r.address.to_bytes()), "signer": r.signer, "writable": r.writable})).collect::<Vec<_>>()})
}
fn public_vectors() -> Value {
    let ctx = context();
    let origin = boundary_origin(&ctx, 128, 0, 0);
    let negative = boundary_origin(&ctx, -128, 0, 3);
    let big = WideTile::of(TileAddress::new(key(&ctx, (1i64 << 53) + 1, -2), 60).unwrap());
    let big_negative = WideTile::of(TileAddress::new(key(&ctx, -(1i64 << 53) - 1, 17), 0).unwrap());
    json!({"schema": 1, "provenance": "synthetic-public-codec-vectors-not-native-execution",
    "plain": [
        plain_vector("boundary-128-to-129", &ctx, host(&ctx, 128, 0), origin, &[0, 0], 12, 0, 0),
        plain_vector("different-issuer-and-current-origin", &ctx, host(&ctx, 127, 0), origin, &[0, 0], u32::MAX, 3, 60000),
        plain_vector("negative-original-boundary", &ctx, host(&ctx, -127, 0), negative, &[3, 3], 500, 2, 12345)
    ],
    "geometry": [
        geometry_vector("positive-past-js-safe-integer", big, &[0, 1, 2, 3, 4, 5, 0, 5]),
        geometry_vector("negative-past-js-safe-integer", big_negative, &[3, 3, 3, 3, 3, 3, 3, 3]),
        geometry_vector("empty-path-is-geometry-only", origin, &[])
    ],
    "genericPlain": [plain_vector("generic-wide-host-full-width", &ctx, host(&ctx, (1i64 << 53) + 1, -2), big, &[0, 1, 2, 3, 4, 5, 0, 5], 42, 1, 1)],
    "depart": [
        depart_vector("standing-is-home", &ctx, host(&ctx, 128, 0), key(&ctx, 128, 0), address(7), address(8), 0),
        depart_vector("actor-payer-and-standing-home-aliases", &ctx, host(&ctx, 128, 0), key(&ctx, 128, 0), address(7), address(7), 3),
        depart_vector("different-issuer-and-current-origin", &ctx, host(&ctx, 127, 0), key(&ctx, 128, 0), address(7), address(8), 2)
    ]})
}

#[test]
fn immutable_public_json_matches_canonical_rust_bytes() {
    let actual = format!(
        "{}\n",
        serde_json::to_string_pretty(&public_vectors()).unwrap()
    );
    let expected = include_bytes!("fixtures/original_outbound_v1.json");
    assert_eq!(expected.as_slice(), actual.as_bytes());
}

#[test]
fn nine_roles_are_exact_and_alias_privileges_are_globalized() {
    let ctx = context();
    for same_wallet in [false, true] {
        for same_province in [false, true] {
            let h = host(&ctx, 127, 0);
            let standing = key(&ctx, if same_province { 127 } else { 128 }, 0);
            let d = draft(
                &ctx,
                h,
                standing,
                address(7),
                address(if same_wallet { 7 } else { 8 }),
                2,
            )
            .unwrap();
            let names = d.roles().iter().map(|r| r.name).collect::<Vec<_>>();
            assert_eq!(
                names,
                EXPEDITION_DEPART[0]
                    .specs
                    .iter()
                    .map(|s| s.name)
                    .collect::<Vec<_>>()
            );
            assert_eq!(
                d.roles().map(|r| r.signer),
                [true, true, false, false, false, false, false, false, false]
            );
            assert_eq!(
                d.roles().map(|r| r.writable),
                [
                    same_wallet,
                    true,
                    false,
                    true,
                    true,
                    true,
                    false,
                    same_province,
                    true
                ]
            );
            assert_eq!(
                d.roles()[3].address.to_bytes(),
                ctx.citizen(&address(7).to_bytes())
            );
            assert_eq!(d.roles()[4].address.to_bytes(), ctx.holding(127, 0, 1));
            assert_eq!(
                d.roles()[5].address.to_bytes(),
                ctx.province(if same_province { 127 } else { 128 }, 0)
            );
            assert_eq!(d.roles()[6].address, Address::default());
            assert_eq!(d.roles()[7].address.to_bytes(), ctx.province(127, 0));
            assert_eq!(
                d.roles()[8].address.to_bytes(),
                frontier_abi::world_index::march::transit_address(&ctx, &ctx.holding(127, 0, 1), 2)
            );
            assert_eq!(d.standing(), standing);
        }
    }
}
#[test]
fn invalid_context_family_slot_and_aliases_are_refused() {
    let ctx = context();
    let h = host(&ctx, 127, 0);
    let standing = key(&ctx, 128, 0);
    let d = draft(&ctx, h, standing, address(7), address(8), 0).unwrap();
    for other in [
        AddrCtx {
            program: [0; 32],
            ..ctx
        },
        AddrCtx {
            season: [0; 32],
            ..ctx
        },
        AddrCtx {
            season: ctx.program,
            ..ctx
        },
        AddrCtx {
            season: [6; 32],
            ..ctx
        },
    ] {
        assert_eq!(
            draft(&other, h, standing, address(7), address(8), 0),
            Err(Error::ContextOrHost)
        );
    }
    assert_eq!(
        draft(
            &ctx,
            host(&ctx, 129, 0),
            standing,
            address(7),
            address(8),
            0
        ),
        Err(Error::ContextOrHost)
    );
    for other in [
        key(&ctx, 129, 0),
        key(
            &AddrCtx {
                season: [6; 32],
                ..ctx
            },
            128,
            0,
        ),
    ] {
        assert_eq!(
            draft(&ctx, h, other, address(7), address(8), 0),
            Err(Error::StandingFamily)
        );
    }
    for slot in [4, 255] {
        assert_eq!(
            draft(&ctx, h, standing, address(7), address(8), slot),
            Err(Error::TransitSlot)
        );
    }
    for bad in [Address::default(), Address::new_from_array(ctx.program)] {
        assert_eq!(
            draft(&ctx, h, standing, bad, address(8), 0),
            Err(Error::ZeroOrProgramRecipient)
        );
        assert_eq!(
            draft(&ctx, h, standing, address(7), bad, 0),
            Err(Error::ZeroOrProgramRecipient)
        );
    }
    for role in d.roles().iter().skip(2).filter(|r| r.name != "system") {
        assert_eq!(
            draft(&ctx, h, standing, address(7), role.address, 0),
            Err(Error::Alias)
        );
    }
    for role in d
        .roles()
        .iter()
        .skip(2)
        .filter(|r| !["system", "citizen"].contains(&r.name))
    {
        assert_eq!(
            draft(&ctx, h, standing, role.address, address(8), 0),
            Err(Error::Alias)
        );
    }
}
#[test]
fn full_identity_is_preserved_while_only_issuer_and_slot_seed_addresses() {
    let ctx = context();
    let base = host(&ctx, 127, 0);
    let other = WideHostRef::new(base.key(), base.site(), 255, u32::MAX).unwrap();
    let a = draft(&ctx, base, key(&ctx, 128, 0), address(7), address(8), 0).unwrap();
    let b = draft(&ctx, other, key(&ctx, 128, 0), address(7), address(8), 0).unwrap();
    assert_ne!(a.command().host, b.command().host);
    assert_eq!(a.roles(), b.roles());
    assert_eq!(WideHostRef::from_bytes(&b.command().host).unwrap(), other);
    let bridges = (0..4)
        .map(|slot| {
            draft(&ctx, base, base.key(), address(7), address(8), slot)
                .unwrap()
                .roles()[8]
                .address
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(bridges.len(), 4);
}

#[test]
fn current_369_byte_abi_is_recognized_but_never_admitted() {
    let ctx = context();
    let h = host(&ctx, 128, 0);
    let d = draft(&ctx, h, h.key(), address(7), address(8), 0).unwrap();
    let b = d.proposed_bytes();
    assert_eq!(b.len(), 369);
    assert_eq!(ExpeditionDepart::decode(&b), Ok(d.command()));
    assert_eq!(
        WideCommand::decode(&b),
        Ok(WideCommand::ExpeditionDepart(d.command()))
    );
    assert!(!WideCommand::decode(&b).unwrap().is_player());
    assert!(frontier_abi::v2::ix::tag_of(&b).is_err());
    let mut wrapped = vec![0; b.len() + ResidentAct::HEAD];
    ResidentAct {
        generation: 1,
        inner: &b,
    }
    .encode_into(&mut wrapped)
    .unwrap();
    assert!(ResidentAct::decode(&wrapped).is_err());
    for n in 0..b.len() {
        assert!(ExpeditionDepart::decode(&b[..n]).is_err());
    }
    let mut extra = b.to_vec();
    extra.push(0);
    assert!(ExpeditionDepart::decode(&extra).is_err());
    let mut slot = b;
    slot[60] = 4;
    assert!(ExpeditionDepart::decode(&slot).is_err());
    assert_eq!(&b[4..60], &h.to_bytes());
    assert_eq!(&b[65..73], &2500u64.to_le_bytes());
    assert_eq!(&b[73..105], &PUBLIC_COMMIT);
    assert_eq!(&b[105..], &PUBLIC_SEAL);
    assert!(!d.admitted() && !d.public_dispatch_available() && !d.seal_verified());
    assert!(d.not_proven().iter().any(|s| s.contains("issuance")));
    // Deliberately invalid cryptographic bytes and unchecked time/economics
    // remain shape inputs. A draft must never assert they are live or sealed.
    let opaque = Draft::for_wallet(
        &ctx,
        h,
        h.key(),
        address(7),
        address(8),
        3,
        0,
        u64::MAX,
        [0; 32],
        [0; 264],
    )
    .unwrap();
    assert!(!opaque.seal_verified() && !opaque.admitted());
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        a
    }
    fn arr<const N: usize>(&mut self) -> [u8; N] {
        self.take(N).try_into().unwrap()
    }
    fn sized(&mut self) -> &'a [u8] {
        let n = u32::from_le_bytes(self.arr()) as usize;
        assert!(n < 1024);
        self.take(n)
    }
}
#[test]
fn native_boundary_log_matches_identity_only_not_role_or_wire_snapshots() {
    let bytes = include_bytes!("fixtures/original_boundary_v1.bin");
    assert_eq!(
        hex::encode(permutation_rules::hash::sha256(&[bytes])),
        "48e97269e39672bee2f19b7c692a8dca95b608f050c45e2e932922b4de9e47d5"
    );
    let mut r = Reader(bytes);
    assert_eq!(r.take(8), b"BTRCv001");
    let ctx = AddrCtx {
        program: r.arr(),
        season: r.arr(),
    };
    let n = u32::from_le_bytes(r.arr());
    assert!(n < 256);
    let mut found = 0;
    for _ in 0..n {
        r.take(16);
        let logs = u16::from_le_bytes(r.arr());
        assert!(logs < 64);
        for _ in 0..logs {
            let tag = r.sized();
            let body = r.sized();
            if tag == b"PS2" && body.get(1) == Some(&146) {
                let record = Record::decode(&ctx, body).unwrap();
                if record.source.receipt.action != Action::Depart {
                    continue;
                }
                let id = record.source.identity;
                // Public wallet/payer constants from native lifecycle source.
                // The log carries identity, not these proposed flags or wire.
                let d = draft(
                    &ctx,
                    id.host,
                    id.origin,
                    address(0xa1),
                    address(0xd4),
                    id.slot,
                )
                .unwrap();
                assert_eq!(d.roles()[3].address.to_bytes(), id.citizen);
                assert_eq!(d.roles()[4].address.to_bytes(), id.holding);
                assert_eq!(d.roles()[5].address.to_bytes(), id.province);
                assert_eq!(d.roles()[8].address.to_bytes(), id.external);
                found += 1;
            }
        }
    }
    assert!(r.0.is_empty());
    assert!(found > 0);
}
