//! Rust side of the ExpeditionReveal parity vector
//! (`vectors/v2/expedition-reveal.txt`, written by the browser builder's test
//! `permutation-gateway/test/web-frontier-expedition-reveal.test.mjs`).
//!
//! Every byte the browser built is recomputed here from the `world_index`
//! functions the program reads: the 242-byte version-2 wire, the seal root,
//! the plaintext's host and arrival bell, and the address of every one of the
//! sixteen fixed accounts (plus any path province) with the privileges of
//! `wide_ix::REVEAL`. Public test values only; no signing, runtime or network.
//!
//! Not covered: the route (`wide_expedition_route::path_tiles` is private to
//! the program crate; this vector's one-step route has no path province), the
//! destination region (an input read from the destination Province), and
//! execution on the SBF artifact.
#![cfg(feature = "world-index-experimental")]
use std::collections::HashMap;

use frontier_abi::addr::{archive_part_of, day_of, AddrCtx};
use frontier_abi::world_index::{
    arrival::{arrival_day_address, arrival_slot_address, clash_inputs_address},
    expedition_dispatch_ix as dx,
    land::province_address,
    march::transit_address,
    seal as wseal, wide_ix as w, ProvinceKey, WideCoord, WideHostRef, WorldId,
};

const VECTOR: &str = include_str!("../vectors/v2/expedition-reveal.txt");
/// `Sysvar1nstructions1111111111111111111111111`.
const IX_SYSVAR: [u8; 32] = [
    0x06, 0xa7, 0xd5, 0x17, 0x18, 0x7b, 0xd1, 0x66, 0x35, 0xda, 0xd4, 0x04, 0x55, 0xfd, 0xc2, 0xc0,
    0xc1, 0x24, 0xc6, 0x8f, 0x21, 0x56, 0x75, 0xa5, 0xdb, 0xba, 0xcb, 0x5f, 0x08, 0x00, 0x00, 0x00,
];

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "odd hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}
fn arr<const N: usize>(s: &str) -> [u8; N] {
    unhex(s).try_into().expect("length")
}

struct Vector {
    kv: HashMap<String, String>,
}
impl Vector {
    fn parse() -> Vector {
        let kv = VECTOR
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
            .map(|l| {
                let (k, v) = l.split_once('=').expect("key=value");
                (k.to_string(), v.to_string())
            })
            .collect();
        Vector { kv }
    }
    fn get(&self, k: &str) -> &str {
        self.kv.get(k).unwrap_or_else(|| panic!("{k} is missing"))
    }
    fn num<T: std::str::FromStr>(&self, k: &str) -> T
    where
        T::Err: std::fmt::Debug,
    {
        self.get(k).parse().expect(k)
    }
    /// `(name, pubkey, signer, writable)` in order.
    fn accounts(&self) -> Vec<(String, [u8; 32], bool, bool)> {
        (0..)
            .map_while(|i| self.kv.get(&format!("account.{i}")))
            .map(|v| {
                let mut it = v.split(':');
                let (name, key, flags) =
                    (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
                assert!(it.next().is_none() && flags.len() == 2);
                (
                    name.to_string(),
                    arr(key),
                    flags.starts_with('s'),
                    flags.ends_with('w'),
                )
            })
            .collect()
    }
    fn path(&self) -> Vec<(i64, i64)> {
        (0..)
            .map_while(|i| self.kv.get(&format!("path.{i}")))
            .map(|v| {
                let (p, q) = v.split_once(',').unwrap();
                (p.parse().unwrap(), q.parse().unwrap())
            })
            .collect()
    }
}

#[test]
fn the_browser_reveal_is_the_rust_reveal() {
    let v = Vector::parse();
    let ctx = AddrCtx {
        program: arr(v.get("program")),
        season: arr(v.get("season")),
    };
    let wallet: [u8; 32] = arr(v.get("wallet"));
    let holding: [u8; 32] = arr(v.get("holding"));
    let host = WideHostRef::from_bytes(&unhex(v.get("host"))).expect("a host reference");
    let (slot, faction, arrive, region, target): (u8, u8, u32, u8, u8) = (
        v.num("transit_slot"),
        v.num("faction"),
        v.num("arrive_bell"),
        v.num("dest_region"),
        v.num("target_i"),
    );
    let plain: [u8; wseal::WIDE_PLAIN_LEN] = arr(v.get("plain"));
    let salt: [u8; 32] = arr(v.get("salt"));
    let ct_hash: [u8; 32] = arr(v.get("ct_hash"));

    // the world the browser keyed everything under is this season's
    let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
    // the holding is the canonical one of the host's site
    let hk = host.key();
    assert_eq!(hk.world(), world);
    assert_eq!(
        holding,
        ctx.holding(hk.coord().p() as i32, hk.coord().q() as i32, host.site()),
        "the holding of the host's site"
    );

    // the plaintext is valid for this transit and its commitment is the seal root
    let pt = wseal::unpack(&plain).expect("a wide plaintext");
    wseal::validate(&pt, &host, arrive).expect("valid for the host and the arrival bell");
    assert_eq!(wseal::pack(&pt), plain, "canonical bytes");
    assert_eq!(
        wseal::seal_root(&wseal::commit(&plain, &salt), &ct_hash),
        arr::<32>(v.get("seal_root"))
    );
    let dest: ProvinceKey = pt.dest;
    assert_eq!(dest.world(), world);

    // the wire: the version-2 wrapper of ExpeditionReveal
    let inner = w::ExpeditionReveal {
        transit_slot: slot,
        target_i: target,
        plain,
        salt,
        ct_hash,
        beneficiary: arr(v.get("beneficiary")),
    };
    let wire = dx::encode(dx::Kind::Reveal, &inner.to_bytes()).expect("a Reveal wire");
    assert_eq!(wire.len(), 242);
    assert_eq!(wire, unhex(v.get("data")), "the browser's 242 wire bytes");

    // the accounts, in REVEAL order, with REVEAL's privileges
    let mut want: Vec<(&str, [u8; 32], bool, bool)> = vec![
        ("fee_payer", wallet, true, true),
        ("season", ctx.season, false, false),
        ("holding", holding, false, false),
        (
            "transit",
            transit_address(&ctx, &holding, slot),
            false,
            false,
        ),
        ("anchor", ctx.bell_anchor(arrive, region), false, false),
        (
            "archive",
            ctx.anchor_archive(region, archive_part_of(arrive)),
            false,
            false,
        ),
        ("beaconlog", ctx.beacon_log(region), false, false),
        (
            "inputs",
            clash_inputs_address(&ctx, dest, arrive),
            false,
            false,
        ),
        (
            "dest_province",
            province_address(&ctx, dest.coord()),
            false,
            false,
        ),
        (
            "arrivalday",
            arrival_day_address(&ctx, dest, day_of(arrive)),
            false,
            true,
        ),
    ];
    for i in 0..4u8 {
        want.push((
            "slot",
            arrival_slot_address(&ctx, dest, arrive, faction, i),
            false,
            i == target,
        ));
    }
    want.push(("ix_sysvar", IX_SYSVAR, false, false));
    want.push(("system", [0; 32], false, false));
    for (p, q) in v.path() {
        let c = WideCoord::checked(p, q).unwrap();
        // original family (ring ≤ 128) at its legacy address, wide otherwise
        let a = if c.ring() <= 128 {
            ctx.province(p as i32, q as i32)
        } else {
            province_address(&ctx, c)
        };
        want.push(("path_province", a, false, false));
    }
    let got = v.accounts();
    assert_eq!(got.len(), want.len());
    assert!(got.len() >= w::REVEAL_FIXED && got.len() <= w::REVEAL_FIXED + 3);
    for (i, (g, x)) in got.iter().zip(&want).enumerate() {
        assert_eq!((g.0.as_str(), g.1, g.2, g.3), *x, "account {i}");
    }
    // the writable positions are the program's: the payer, the day, the target slot
    let writable: Vec<usize> = got
        .iter()
        .enumerate()
        .filter(|(_, a)| a.3)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        writable,
        vec![0, w::REVEAL_DAY, w::REVEAL_SLOT0 + target as usize]
    );
}
