//! (test-gaps-2) ⑨ capacity / ⑩ custody: the **shared address vectors**
//! `frontier-abi/vectors/custody-addresses.txt`, which the page's one builder
//! (`permutation-server/web/frontier/flocalplay-custody.mjs` poolAddress /
//! jobAddress / lotAddress / tagOf) replays in the key-free gateway test
//! `web-frontier-custody-test-gaps.test.mjs`.
//!
//! verify-pr140 found by playing that a lot's address carries its
//! storehouse's generation and a pool's its village's generation (SeizeVault
//! moves the Vault to gen + 1; a capture moves the Holding on), so a page that
//! derives an address from the wrong generation never sees a loss. The page's
//! seeds were pinned by hand against these functions; here both sides read the
//! same file, and the file fails this test when it is stale.
//!
//! No key: every address is the public `create_with_seed` hash (sha256) over
//! literal bytes. Rewrite after a deliberate layout change (a new seed tag or
//! raw key, never a reinterpretation):
//! `CUSTODY_ADDRESS_WRITE=1 cargo test -p frontier-abi --features capacity-preview --lib custody_address_vectors`.

extern crate std;

use std::fmt::Write as _;
use std::string::String;

use crate::addr::{citizen_tag, AddrCtx};
use crate::capacity;
use crate::feature_registry as fr;
use crate::v2::addr as v2a;

const VECTORS: &str = include_str!("../vectors/custody-addresses.txt");

/// The fixed context: the world account the seeds hang under and a program id (literal bytes, no key).
fn ctx() -> AddrCtx {
    let mut season = [0u8; 32];
    let mut program = [0u8; 32];
    for i in 0..32 {
        season[i] = (i as u8).wrapping_mul(7).wrapping_add(3);
        program[i] = 0xF0 ^ (i as u8).wrapping_mul(13);
    }
    AddrCtx { season, program }
}

fn hex(b: &[u8]) -> String {
    let mut s = String::new();
    for x in b {
        write!(s, "{x:02x}").unwrap();
    }
    s
}

/// A deterministic generator (no dependency): the same numbers on every machine.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn coord(&mut self) -> i16 {
        // province coordinates of an infinite map: small and large, both signs, the i16 edges
        match self.next() % 8 {
            0 => i16::MIN,
            1 => i16::MAX,
            2 => -1,
            _ => (self.next() % 4_001) as i16 - 2_000,
        }
    }
    fn byte(&mut self) -> u8 {
        match self.next() % 6 {
            0 => 0,
            1 => 255,
            _ => (self.next() % 256) as u8,
        }
    }
}

fn render() -> String {
    let c = ctx();
    let mut s = String::from(
        "# ⑨ capacity pools/jobs, ⑩ custody lots and ② grants: seeds and create_with_seed addresses (hex), test-gaps-2.\n\
         # Written by frontier-abi custody_address_vectors_tests (CUSTODY_ADDRESS_WRITE=1); replayed by the page's builder\n\
         # (permutation-server/web/frontier/flocalplay-custody.mjs) in permutation-gateway/test/web-frontier-custody-test-gaps.test.mjs.\n\
         # A generation byte is part of every address: a seized storehouse's lots (Vault gen + 1) and a captured village's\n\
         # pool (Holding PREV_GEN) stay at the address of the generation they were made at (verify-pr140).\n",
    );
    writeln!(s, "ctx {} {}", hex(&c.season), hex(&c.program)).unwrap();
    // ② + ⑨ + ⑩'s lane (verify-pr113/119: registry rev 8, 0x7805 = the plain lane 0x4804 + custody base 5 + rights and
    // capacity bits) and the plain lane, each with its ruleset hash: the page's flocalplay-lane.mjs pins them by hand.
    let plain = fr::BASE_S1 | fr::WIDE_BIT | fr::EXPEDITION_BIT;
    writeln!(
        s,
        "lane coexist {} {}",
        fr::COEXIST_LANE_VERSION,
        hex(&crate::v2::presets::RULESET_HASH_V4)
    )
    .unwrap();
    writeln!(
        s,
        "lane plain {} {}",
        plain,
        hex(&crate::v2::presets::RULESET_HASH_V3)
    )
    .unwrap();
    let mut r = Lcg(0x0910_c0de);
    for _ in 0..40 {
        let (p, q, site, gen) = (r.coord(), r.coord(), r.byte(), r.byte());
        let seed = capacity::pool_seed(p, q, site, gen);
        let a = capacity::pool(&c, p, q, site, gen);
        writeln!(
            s,
            "pool {p} {q} {site} {gen} | {} {}",
            core::str::from_utf8(seed.as_bytes()).unwrap(),
            hex(&a)
        )
        .unwrap();
    }
    for _ in 0..40 {
        let (p, q, site, gen) = (r.coord(), r.coord(), r.byte(), r.byte());
        let grant = match r.next() % 4 {
            0 => 0,
            1 => u32::MAX,
            _ => r.next() as u32,
        };
        let job = match r.next() % 4 {
            0 => 0,
            1 => u32::MAX,
            _ => r.next() as u32,
        };
        let seed = capacity::job_seed(p, q, site, gen, grant, job);
        let a = capacity::job(&c, p, q, site, gen, grant, job);
        writeln!(
            s,
            "job {p} {q} {site} {gen} {grant} {job} | {} {}",
            core::str::from_utf8(seed.as_bytes()).unwrap(),
            hex(&a)
        )
        .unwrap();
    }
    for _ in 0..60 {
        let (p, q, tile, gen) = (r.coord(), r.coord(), r.byte(), r.byte());
        let owner_tag = match r.next() % 4 {
            0 => 0,
            1 => u64::MAX,
            _ => (r.next() << 31) ^ r.next(),
        };
        let resource = (r.next() % 6) as u8;
        let seed = v2a::lot_seed(p, q, tile, gen, owner_tag, resource);
        let a = v2a::lot(&c, p, q, tile, gen, owner_tag, resource);
        writeln!(
            s,
            "lot {p} {q} {tile} {gen} {owner_tag} {resource} | {} {}",
            core::str::from_utf8(seed.as_bytes()).unwrap(),
            hex(&a)
        )
        .unwrap();
    }
    // ② A's Grant (the right a ⑨ pool's use and a swap rest on): `gr‖hex(le64 issuer_tag ‖ le32 nonce)`
    for _ in 0..20 {
        let issuer_tag = match r.next() % 3 {
            0 => 0,
            1 => u64::MAX,
            _ => (r.next() << 31) ^ r.next(),
        };
        let nonce = match r.next() % 3 {
            0 => 0,
            1 => u32::MAX,
            _ => r.next() as u32,
        };
        let seed = crate::v2::rights::grant_seed(issuer_tag, nonce);
        let a = crate::v2::rights::grant(&c, issuer_tag, nonce);
        writeln!(
            s,
            "grant {issuer_tag} {nonce} | {} {}",
            core::str::from_utf8(seed.as_bytes()).unwrap(),
            hex(&a)
        )
        .unwrap();
    }
    for _ in 0..20 {
        let mut citizen = [0u8; 32];
        for b in citizen.iter_mut() {
            *b = r.next() as u8;
        }
        writeln!(s, "tag {} | {}", hex(&citizen), citizen_tag(&citizen)).unwrap();
    }
    s
}

#[test]
fn custody_address_vectors_are_current() {
    let want = render();
    if std::env::var_os("CUSTODY_ADDRESS_WRITE").is_some() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/custody-addresses.txt");
        std::fs::write(path, &want).unwrap();
        return;
    }
    assert_eq!(
        VECTORS, want,
        "frontier-abi/vectors/custody-addresses.txt is stale (CUSTODY_ADDRESS_WRITE=1 rewrites it after a deliberate change)"
    );
}

/// The generation is in every address, and only the generation moves it: a seizure (Vault gen + 1) gives every lot
/// of that storehouse a new address, a capture (Holding gen + 1) every pool and job of that village, and nothing else
/// of the key does — the reason the page must read the generation(s) before (verify-pr140 lotReadPlan/poolReadPlan).
#[test]
fn custody_addresses_move_with_the_generation_only() {
    let c = ctx();
    let mut r = Lcg(0x1010_9090);
    for _ in 0..500 {
        let (p, q, t, g) = (r.coord(), r.coord(), r.byte(), r.byte());
        let tag = (r.next() << 31) ^ r.next();
        let g1 = g.wrapping_add(1);
        let lot0 = v2a::lot(&c, p, q, t, g, tag, 3);
        let lot1 = v2a::lot(&c, p, q, t, g1, tag, 3);
        assert_ne!(
            lot0, lot1,
            "a seized storehouse's lot must move address (p {p} q {q} tile {t} gen {g})"
        );
        assert_eq!(lot0, v2a::lot(&c, p, q, t, g, tag, 3), "deterministic");
        let pool0 = capacity::pool(&c, p, q, t, g);
        let pool1 = capacity::pool(&c, p, q, t, g1);
        assert_ne!(pool0, pool1, "a captured village's pool must move address");
        assert_ne!(
            capacity::job(&c, p, q, t, g, 0, 0),
            capacity::job(&c, p, q, t, g1, 0, 0),
            "a captured village's jobs must move address"
        );
        assert_ne!(lot0, pool0, "a lot and a pool never share an address");
    }
}
