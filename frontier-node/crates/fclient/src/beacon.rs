//! drand quicknet beacons: the chain info, off-chain verification with
//! blstrs, the hash-to-curve hints the program checks (ported unchanged
//! from SP-V2 `host/src/drand.rs`), the seed derivation, the test-beacon key
//! (I-53) and the `DrandPort` backends (HTTP and fixture files).
//!
//! quicknet is `bls-unchained-g1-rfc9380`: signatures in G1 (48 B
//! compressed) over `sha256(be64(round))` with the DST below, the group
//! public key in G2 (96 B compressed).

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;

use ark_bls12_381::{g1::Config as G1Config, Fq, G1Affine};
use ark_ec::{
    hashing::curve_maps::{swu::SWUConfig, wb::WBConfig},
    short_weierstrass::{Affine, SWCurveConfig},
    AffineRepr, CurveGroup,
};
use ark_ff::{BigInteger, Field, One, PrimeField};
use group::{prime::PrimeCurveAffine, Curve};
use sha2::{Digest, Sha256};

use crate::ports::{Beacon, ChainInfo, PortError};

pub const DST: &[u8] = b"BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
pub const NET_QUICKNET: u8 = 2;
/// Domain of the seed derived from a round (SP-V2 `seed_of`).
pub const SEED_DOMAIN: &[u8] = b"PSF-SEED-v1";

/// quicknet as published at `https://api.drand.sh/52db9b…/info`.
pub const QUICKNET_PK: &str = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
pub const QUICKNET_CHAIN_HASH: &str =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
pub const QUICKNET_GENESIS: i64 = 1_692_803_367;
pub const QUICKNET_PERIOD: u32 = 3;
pub const QUICKNET_GENESIS_SEED: &str =
    "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e";
pub const SCHEME: &str = "bls-unchained-g1-rfc9380";

pub fn quicknet_info() -> ChainInfo {
    ChainInfo {
        public_key: hex::decode(QUICKNET_PK)
            .expect("hex")
            .try_into()
            .expect("96"),
        period: QUICKNET_PERIOD,
        genesis_time: QUICKNET_GENESIS,
        genesis_seed: hex::decode(QUICKNET_GENESIS_SEED)
            .expect("hex")
            .try_into()
            .expect("32"),
        chain_hash: hex::decode(QUICKNET_CHAIN_HASH)
            .expect("hex")
            .try_into()
            .expect("32"),
        scheme: SCHEME.into(),
        beacon_id: "quicknet".into(),
    }
}

/// `QUICKNET_PK_HASH` as the program embeds it: `sha256(pk96)`.
pub fn pk_hash(pk96: &[u8; 96]) -> [u8; 32] {
    Sha256::digest(pk96).into()
}

/// The message of a round: `sha256(be64(round))`.
pub fn msg(round: u64) -> [u8; 32] {
    Sha256::digest(round.to_be_bytes()).into()
}

/// Off-chain verification with blstrs (hash_to_curve + pairing), as SP-V2
/// `verify_offchain`; false on any malformed input.
pub fn verify(round: u64, sig48: &[u8; 48], pk96: &[u8; 96]) -> bool {
    let Some(sig) = Option::<blstrs::G1Affine>::from(blstrs::G1Affine::from_compressed(sig48))
    else {
        return false;
    };
    let Some(pk) = Option::<blstrs::G2Affine>::from(blstrs::G2Affine::from_compressed(pk96)) else {
        return false;
    };
    let h = blstrs::G1Projective::hash_to_curve(&msg(round), DST, &[]).to_affine();
    blstrs::pairing(&sig, &blstrs::G2Affine::generator()) == blstrs::pairing(&h, &pk)
}

/// The uncompressed 96-B form of a signature (the program keeps both).
pub fn decompress_sig(sig48: &[u8; 48]) -> Option<[u8; 96]> {
    Option::<blstrs::G1Affine>::from(blstrs::G1Affine::from_compressed(sig48))
        .map(|p| p.to_uncompressed())
}

/// `sha256("PSF-SEED-v1" ‖ net ‖ be64(round) ‖ sig96)` (SP-V2 `seed_of`).
pub fn seed_of(round: u64, sig96: &[u8; 96]) -> [u8; 32] {
    Sha256::new()
        .chain_update(SEED_DOMAIN)
        .chain_update([NET_QUICKNET])
        .chain_update(round.to_be_bytes())
        .chain_update(sig96)
        .finalize()
        .into()
}

// ---------------------------------------------------------------- xmd

/// RFC 9380 `expand_message_xmd` with SHA-256.
pub fn expand_xmd(msg: &[u8], dst: &[u8], len: usize) -> Vec<u8> {
    let ell = len.div_ceil(32);
    let dp: Vec<u8> = [dst, &[dst.len() as u8]].concat();
    let b0 = Sha256::new()
        .chain_update([0u8; 64])
        .chain_update(msg)
        .chain_update([(len >> 8) as u8, len as u8, 0])
        .chain_update(&dp)
        .finalize();
    let mut bi = Sha256::new()
        .chain_update(b0)
        .chain_update([1u8])
        .chain_update(&dp)
        .finalize();
    let mut out = bi.to_vec();
    for i in 2..=ell {
        let t: Vec<u8> = b0.iter().zip(bi.iter()).map(|(a, b)| a ^ b).collect();
        bi = Sha256::new()
            .chain_update(&t)
            .chain_update([i as u8])
            .chain_update(&dp)
            .finalize();
        out.extend_from_slice(&bi);
    }
    out.truncate(len);
    out
}

// ---------------------------------------------------------------- hints

fn fe_to_be(f: &Fq, n: usize) -> Vec<u8> {
    let v = f.into_bigint().to_bytes_be();
    let mut out = vec![0u8; n - v.len()];
    out.extend(v);
    out
}

fn sgn0(f: &Fq) -> bool {
    f.into_bigint().is_odd()
}

/// One map's hint: SSWU branch, `1/tv1`, `y`, `1/(xd·yd)` (SP-V2 `Hint`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hint {
    pub branch: u8,
    pub inv_tv1: Fq,
    pub y: Fq,
    pub inv_den: Fq,
}

impl Hint {
    /// `branch u8 ‖ inv_tv1 ‖ y ‖ inv_den` (48 B big-endian each) = 145 B.
    pub fn encode(&self) -> Vec<u8> {
        let mut v = vec![self.branch];
        v.extend(fe_to_be(&self.inv_tv1, 48));
        v.extend(fe_to_be(&self.y, 48));
        v.extend(fe_to_be(&self.inv_den, 48));
        v
    }
}

type Iso = <G1Config as WBConfig>::IsogenousCurve;

fn hash_to_field(round: u64) -> (Fq, Fq) {
    let uu = expand_xmd(&msg(round), DST, 128);
    (
        Fq::from_be_bytes_mod_order(&uu[..64]),
        Fq::from_be_bytes_mod_order(&uu[64..]),
    )
}

fn horner(c: &[Fq], x: Fq) -> Fq {
    c.iter().rev().fold(Fq::from(0u64), |acc, k| acc * x + k)
}

/// SSWU on E' then the 11-isogeny, recording the hints (SP-V2 `map`).
fn map(u: Fq) -> (G1Affine, Hint) {
    let (a, b, z) = (Iso::COEFF_A, Iso::COEFF_B, Iso::ZETA);
    let gp = |x: Fq| (x.square() + a) * x + b;
    let zu2 = z * u.square();
    let tv1 = zu2.square() + zu2;
    let inv_tv1 = tv1
        .inverse()
        .expect("tv1 ≠ 0 except with negligible probability");
    let x1 = -b * a.inverse().expect("a ≠ 0") * (Fq::one() + inv_tv1);
    let (branch, xp, mut y) = match gp(x1).sqrt() {
        Some(y) => (1u8, x1, y),
        None => {
            let x2 = zu2 * x1;
            (2u8, x2, gp(x2).sqrt().expect("SSWU: one branch is square"))
        }
    };
    if sgn0(&y) != sgn0(&u) {
        y = -y;
    }
    let m = &G1Config::ISOGENY_MAP;
    let (xn, xd, yn, yd) = (
        horner(m.x_map_numerator, xp),
        horner(m.x_map_denominator, xp),
        horner(m.y_map_numerator, xp),
        horner(m.y_map_denominator, xp),
    );
    let inv_den = (xd * yd).inverse().expect("isogeny denominators ≠ 0");
    let p = Affine::<G1Config>::new_unchecked(xn * yd * inv_den, y * yn * xd * inv_den);
    (
        p,
        Hint {
            branch,
            inv_tv1,
            y,
            inv_den,
        },
    )
}

/// H(round) with its two hints.
pub fn hash_with_hints(round: u64) -> (G1Affine, [Hint; 2]) {
    let (u0, u1) = hash_to_field(round);
    let (p0, h0) = map(u0);
    let (p1, h1) = map(u1);
    let q = (p0.into_group() + p1).into_affine();
    (G1Config::clear_cofactor(&q), [h0, h1])
}

/// The 290 hint bytes instructions carry (`ix::HINTS_LEN`).
pub fn hints_bytes(round: u64) -> Vec<u8> {
    let (_, hs) = hash_with_hints(round);
    let mut v = hs[0].encode();
    v.extend(hs[1].encode());
    v
}

/// H(round), uncompressed big-endian `x ‖ y` (to compare with blstrs).
pub fn hash_be(round: u64) -> Vec<u8> {
    let (p, _) = hash_with_hints(round);
    let (x, y) = p.xy().expect("not infinity");
    [fe_to_be(&x, 48), fe_to_be(&y, 48)].concat()
}

/// blstrs's H(round), uncompressed.
pub fn hash_blstrs_be(round: u64) -> Vec<u8> {
    blstrs::G1Projective::hash_to_curve(&msg(round), DST, &[])
        .to_affine()
        .to_uncompressed()
        .to_vec()
}

/// A beacon as an instruction carries it.
pub fn beacon_arg(b: &Beacon) -> crate::ix::BeaconArg {
    crate::ix::BeaconArg {
        round: b.round,
        sig48: b.sig48,
        hints: hints_bytes(b.round),
    }
}

// ---------------------------------------------------------------- test key (I-53)

/// Message of the test key: `sk = hash_to_field("PSF-TEST-BEACON-v1")`.
pub const TEST_KEY_MSG: &[u8] = b"PSF-TEST-BEACON-v1";
/// DST of the test key's hash_to_field (RFC 9380 §5.2 with `L = 48` into Fr).
pub const TEST_KEY_DST: &[u8] = b"PSF-TEST-BEACON-KEYGEN-v1";

/// The deterministic local beacon key of `drand-replay --test-key` and the
/// program's `test-beacon` feature. Never deployable (I-53).
pub struct TestKey {
    sk: blstrs::Scalar,
    pub pk96: [u8; 96],
}

impl Default for TestKey {
    fn default() -> Self {
        TestKey::new()
    }
}

impl TestKey {
    pub fn new() -> TestKey {
        let wide = expand_xmd(TEST_KEY_MSG, TEST_KEY_DST, 48);
        let fr = ark_bls12_381::Fr::from_be_bytes_mod_order(&wide);
        let le: [u8; 32] = {
            let mut v = fr.into_bigint().to_bytes_le();
            v.resize(32, 0);
            v.try_into().expect("32")
        };
        let sk = Option::<blstrs::Scalar>::from(blstrs::Scalar::from_bytes_le(&le))
            .expect("reduced scalar");
        let pk96 = (blstrs::G2Affine::generator() * sk)
            .to_affine()
            .to_compressed();
        TestKey { sk, pk96 }
    }

    /// The round's signature: `sk · H(sha256(be64(round)))`, compressed.
    pub fn sign(&self, round: u64) -> [u8; 48] {
        let h = blstrs::G1Projective::hash_to_curve(&msg(round), DST, &[]);
        (h * self.sk).to_affine().to_compressed()
    }

    pub fn beacon(&self, round: u64) -> Beacon {
        Beacon {
            round,
            sig48: self.sign(round),
        }
    }

    /// Chain info with quicknet's clock and this key: `chain_hash =
    /// sha256("PSF-TEST-BEACON-v1" ‖ pk96)`, `beacon_id = "psf-test"`.
    pub fn info(&self) -> ChainInfo {
        let chain_hash: [u8; 32] = Sha256::new()
            .chain_update(TEST_KEY_MSG)
            .chain_update(self.pk96)
            .finalize()
            .into();
        ChainInfo {
            public_key: self.pk96,
            period: QUICKNET_PERIOD,
            genesis_time: QUICKNET_GENESIS,
            genesis_seed: chain_hash,
            chain_hash,
            scheme: SCHEME.into(),
            beacon_id: "psf-test".into(),
        }
    }
}

// ---------------------------------------------------------------- DrandPort backends

/// drand's HTTP API (`/{chain}/public/{round}`): `drand-replay` on loopback
/// over plain HTTP, or live drand (`https://api.drand.sh` and its mirrors)
/// through `http`'s verified curl GET. Every answer is checked as
/// drand-client and drand-rs check it (round equal to the one asked, the
/// signature against the pinned key, `randomness = sha256(signature)` when
/// present); an endpoint that serves nothing usable is skipped for the next
/// one, and "not yet" (425/404) is only the answer when no endpoint served
/// a verified round.
pub struct HttpDrand {
    pub urls: Vec<String>,
    pub info: ChainInfo,
}

impl HttpDrand {
    pub fn new(urls: Vec<String>, info: ChainInfo) -> HttpDrand {
        HttpDrand { urls, info }
    }
}

/// Parses `{"round":…, "signature":"<hex48>"}`.
pub fn parse_beacon_json(v: &serde_json::Value) -> Option<Beacon> {
    let round = v.get("round")?.as_u64()?;
    let sig = hex::decode(v.get("signature")?.as_str()?).ok()?;
    Some(Beacon {
        round,
        sig48: sig.try_into().ok()?,
    })
}

/// Whether a served round is the one asked for and verifies against `pk`,
/// with its `randomness` (when present) equal to `sha256(signature)` (the
/// checks drand-client's `verifyBeacon` makes).
pub fn check_served(v: &serde_json::Value, r: u64, pk: &[u8; 96]) -> Result<Beacon, PortError> {
    let b = parse_beacon_json(v).ok_or_else(|| PortError::Decode("beacon json".into()))?;
    if b.round != r || !verify(r, &b.sig48, pk) {
        return Err(PortError::BadBeacon(r));
    }
    if let Some(rand) = v.get("randomness") {
        let want: [u8; 32] = Sha256::digest(b.sig48).into();
        if rand.as_str().and_then(|x| hex::decode(x).ok()).as_deref() != Some(&want[..]) {
            return Err(PortError::BadBeacon(r));
        }
    }
    Ok(b)
}

/// Parses drand's `/info` JSON: the v2 shape (`chain_hash`,
/// `genesis_seed`, `scheme`, `beacon_id`) and the v1 shape that
/// `/{chain}/info` serves on api.drand.sh (`hash`, `groupHash`, `schemeID`,
/// `metadata.beaconID`; measured 2026-10-30).
pub fn parse_info_json(v: &serde_json::Value) -> Option<ChainInfo> {
    let h = |k: &str| hex::decode(v.get(k)?.as_str()?).ok();
    Some(ChainInfo {
        public_key: h("public_key")?.try_into().ok()?,
        period: u32::try_from(v.get("period")?.as_u64()?).ok()?,
        genesis_time: v.get("genesis_time")?.as_i64()?,
        genesis_seed: h("genesis_seed")
            .or_else(|| h("groupHash"))
            .and_then(|x| x.try_into().ok())
            .unwrap_or([0; 32]),
        chain_hash: h("chain_hash").or_else(|| h("hash"))?.try_into().ok()?,
        scheme: v
            .get("schemeID")
            .or_else(|| v.get("scheme"))
            .and_then(|s| s.as_str())
            .unwrap_or(SCHEME)
            .into(),
        beacon_id: v
            .get("metadata")
            .and_then(|m| m.get("beaconID"))
            .or_else(|| v.get("beacon_id"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .into(),
    })
}

/// Checks served chain info against the pin: the key, the clock, the chain
/// hash, the scheme and (when served) the genesis seed must all be equal
/// (drand-client compares hash and key; the clock is compared too because
/// `T(b)` is computed from it).
pub fn pin_info(got: &ChainInfo, want: &ChainInfo) -> Result<(), String> {
    let mut diff = vec![];
    if got.public_key != want.public_key {
        diff.push("public_key");
    }
    if got.chain_hash != want.chain_hash {
        diff.push("chain_hash");
    }
    if got.period != want.period {
        diff.push("period");
    }
    if got.genesis_time != want.genesis_time {
        diff.push("genesis_time");
    }
    if got.scheme != want.scheme {
        diff.push("scheme");
    }
    if got.genesis_seed != [0; 32] && got.genesis_seed != want.genesis_seed {
        diff.push("genesis_seed");
    }
    if diff.is_empty() {
        Ok(())
    } else {
        Err(format!("drand info differs from the pin in {}", diff.join(", ")))
    }
}

/// The chains a drand client may pin: quicknet always; the I-53 test key
/// only when every endpoint is loopback (a `drand-replay --test-key`), so a
/// keeper pointed at a public host can never settle on the test key.
pub fn pins_for(urls: &[String]) -> Vec<ChainInfo> {
    let mut v = vec![quicknet_info()];
    if !urls.is_empty() && urls.iter().all(|u| crate::http::is_loopback(u)) {
        v.push(TestKey::new().info());
    }
    v
}

/// Finds the pinned chain the endpoints serve: asks `{url}/{chain}/info`
/// for each pin (the chain-addressed route both api.drand.sh and
/// drand-replay serve; the bare `/info` of api.drand.sh is another network)
/// and returns the first pin whose served info equals it ([`pin_info`]).
/// The error lists every endpoint's answer.
pub async fn discover_pinned(urls: &[String], pins: &[ChainInfo]) -> Result<ChainInfo, String> {
    let mut why = vec![];
    for u in urls {
        for pin in pins {
            let url = format!(
                "{}/{}/info",
                u.trim_end_matches('/'),
                hex::encode(pin.chain_hash)
            );
            match crate::http::get(&url).await {
                Ok(r) if r.status == 200 => {
                    match serde_json::from_slice::<serde_json::Value>(&r.body)
                        .ok()
                        .and_then(|v| parse_info_json(&v))
                    {
                        Some(got) => match pin_info(&got, pin) {
                            Ok(()) => return Ok(pin.clone()),
                            Err(e) => why.push(format!("{url}: {e}")),
                        },
                        None => why.push(format!("{url}: not a drand info")),
                    }
                }
                Ok(r) => why.push(format!("{url}: HTTP {}", r.status)),
                Err(e) => why.push(format!("{url}: {e}")),
            }
        }
    }
    Err(why.join("; "))
}

/// `info` as drand serves it.
pub fn info_json(i: &ChainInfo) -> serde_json::Value {
    serde_json::json!({
        "public_key": hex::encode(i.public_key),
        "period": i.period,
        "genesis_time": i.genesis_time,
        "genesis_seed": hex::encode(i.genesis_seed),
        "chain_hash": hex::encode(i.chain_hash),
        "schemeID": i.scheme,
        "metadata": {"beaconID": i.beacon_id},
    })
}

/// A round as drand serves it (unchained: no previous signature).
pub fn beacon_json(b: &Beacon) -> serde_json::Value {
    let rand: [u8; 32] = Sha256::digest(b.sig48).into();
    serde_json::json!({"round": b.round, "randomness": hex::encode(rand), "signature": hex::encode(b.sig48)})
}

impl crate::ports::DrandPort for HttpDrand {
    fn round(&self, r: u64) -> impl Future<Output = Result<Option<Beacon>, PortError>> + Send {
        let urls = self.urls.clone();
        let chain = hex::encode(self.info.chain_hash);
        let pk = self.info.public_key;
        async move {
            let mut last = PortError::Unavailable("no drand url".into());
            let mut not_yet = false;
            for u in &urls {
                let url = format!("{}/{}/public/{}", u.trim_end_matches('/'), chain, r);
                match crate::http::get(&url).await {
                    Ok(resp) if resp.status == 200 => {
                        // A bad answer from one endpoint (garbage, another
                        // round, a forged or foreign signature) moves on to
                        // the next endpoint; it never ends the search.
                        match serde_json::from_slice::<serde_json::Value>(&resp.body)
                            .map_err(|e| PortError::Decode(e.to_string()))
                            .and_then(|v| check_served(&v, r, &pk))
                        {
                            Ok(b) => return Ok(Some(b)),
                            Err(e) => last = e,
                        }
                    }
                    // Not published there yet (or not kept): another
                    // endpoint may already have it.
                    Ok(resp) if resp.status == 425 || resp.status == 404 => not_yet = true,
                    Ok(resp) => last = PortError::Http(resp.status),
                    Err(e) => last = e,
                }
            }
            if not_yet {
                Ok(None)
            } else {
                Err(last)
            }
        }
    }
    fn info(&self) -> ChainInfo {
        self.info.clone()
    }
}

/// Rounds from a directory of `{round}.json` files (the SP-V2 fixture
/// layout), verified on load against `info`.
pub struct FixtureDrand {
    pub info: ChainInfo,
    pub rounds: BTreeMap<u64, Beacon>,
}

impl FixtureDrand {
    pub fn load(dir: &Path, info: ChainInfo) -> Result<FixtureDrand, String> {
        let mut rounds = BTreeMap::new();
        for e in std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let p = e.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let v: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let b =
                parse_beacon_json(&v).ok_or_else(|| format!("{}: not a beacon", p.display()))?;
            if !verify(b.round, &b.sig48, &info.public_key) {
                return Err(format!("{}: signature does not verify", p.display()));
            }
            rounds.insert(b.round, b);
        }
        Ok(FixtureDrand { info, rounds })
    }
}

impl crate::ports::DrandPort for FixtureDrand {
    fn round(&self, r: u64) -> impl Future<Output = Result<Option<Beacon>, PortError>> + Send {
        let b = self.rounds.get(&r).cloned();
        async move { Ok(b) }
    }
    fn info(&self) -> ChainInfo {
        self.info.clone()
    }
}

/// The test key as a `DrandPort` (no clock gating: that is drand-replay's job).
impl crate::ports::DrandPort for TestKey {
    fn round(&self, r: u64) -> impl Future<Output = Result<Option<Beacon>, PortError>> + Send {
        let b = self.beacon(r);
        async move { Ok(Some(b)) }
    }
    fn info(&self) -> ChainInfo {
        TestKey::info(self)
    }
}

/// The fixture rounds shipped with this workspace (SP-V2 `beacons/quicknet`).
pub fn fixture_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/quicknet")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fixture_round_verifies_and_hints_agree_with_blstrs() {
        let f = FixtureDrand::load(&fixture_dir(), quicknet_info()).unwrap();
        assert_eq!(f.rounds.len(), 32, "SP-V2 ships 32 quicknet rounds");
        for (r, b) in f.rounds.iter().take(4) {
            assert!(verify(*r, &b.sig48, &quicknet_info().public_key));
            assert!(
                !verify(r + 1, &b.sig48, &quicknet_info().public_key),
                "wrong round refused"
            );
            assert_eq!(hash_be(*r), hash_blstrs_be(*r), "hinted map = RFC 9380");
            assert_eq!(hints_bytes(*r).len(), crate::ix::HINTS_LEN);
        }
    }

    #[test]
    fn test_key_signs_and_verifies() {
        let k = TestKey::new();
        let k2 = TestKey::new();
        assert_eq!(k.pk96, k2.pk96, "deterministic");
        let b = k.beacon(1_000);
        assert!(verify(1_000, &b.sig48, &k.pk96));
        assert!(!verify(1_000, &b.sig48, &quicknet_info().public_key));
        assert_ne!(k.info().chain_hash, quicknet_info().chain_hash);
        let sig96 = decompress_sig(&b.sig48).unwrap();
        assert_eq!(
            seed_of(1_000, &sig96),
            seed_of(1_000, &decompress_sig(&k.sign(1_000)).unwrap())
        );
    }

    /// `/{chain}/info` as api.drand.sh served it (v1 shape) and
    /// `/v2/chains/{chain}/info` (v2 shape), captured 2026-10-30.
    const LIVE_V1_INFO: &str = r#"{"public_key":"83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a","period":3,"genesis_time":1692803367,"hash":"52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971","groupHash":"f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e","schemeID":"bls-unchained-g1-rfc9380","metadata":{"beaconID":"quicknet"}}"#;
    const LIVE_V2_INFO: &str = r#"{"public_key":"83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a","period":3,"genesis_time":1692803367,"genesis_seed":"f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e","chain_hash":"52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971","scheme":"bls-unchained-g1-rfc9380","beacon_id":"quicknet"}"#;
    /// Round 33533784 as api.drand.sh served it (`/public/latest`, 2026-10-30).
    const LIVE_ROUND: &str = r#"{"round":33533784,"randomness":"3f405a59343324d3409f5dba227a84d731546829e174d7f322f816c38c549d11","signature":"b988d28714ee128f9804f57248a4cfff9db14f04b88ab6eeac2775e11448eb76a196abc6b8d3951d3b2f6b3d84065d71"}"#;

    #[test]
    fn live_info_shapes_parse_and_match_the_pin() {
        for text in [LIVE_V1_INFO, LIVE_V2_INFO] {
            let v: serde_json::Value = serde_json::from_str(text).unwrap();
            let got = parse_info_json(&v).expect("both shapes parse");
            assert_eq!(pin_info(&got, &quicknet_info()), Ok(()));
            assert_eq!(got.beacon_id, "quicknet");
        }
        // The pre-fix parser needed `chain_hash`: the v1 shape (the route
        // `/{chain}/info` on api.drand.sh) did not parse at all.
        let v1: serde_json::Value = serde_json::from_str(LIVE_V1_INFO).unwrap();
        assert!(v1.get("chain_hash").is_none());
    }

    #[test]
    fn pin_info_refuses_every_changed_field() {
        let q = quicknet_info();
        let t = TestKey::new().info();
        assert!(pin_info(&t, &q).is_err(), "the test key is not quicknet");
        let mut x = q.clone();
        x.public_key[5] ^= 1;
        assert!(pin_info(&x, &q).unwrap_err().contains("public_key"));
        let mut x = q.clone();
        x.chain_hash[0] ^= 1;
        assert!(pin_info(&x, &q).unwrap_err().contains("chain_hash"));
        let mut x = q.clone();
        x.period = 30; // the default (mainnet) network's period
        assert!(pin_info(&x, &q).unwrap_err().contains("period"));
        let mut x = q.clone();
        x.genesis_time += 1;
        assert!(pin_info(&x, &q).unwrap_err().contains("genesis_time"));
        let mut x = q.clone();
        x.scheme = "pedersen-bls-chained".into();
        assert!(pin_info(&x, &q).unwrap_err().contains("scheme"));
        let mut x = q.clone();
        x.genesis_seed[0] ^= 1;
        assert!(pin_info(&x, &q).unwrap_err().contains("genesis_seed"));
        let mut x = q.clone();
        x.genesis_seed = [0; 32]; // not served: not compared
        assert_eq!(pin_info(&x, &q), Ok(()));
    }

    #[test]
    fn served_rounds_are_checked_like_drand_client() {
        let pk = quicknet_info().public_key;
        let v: serde_json::Value = serde_json::from_str(LIVE_ROUND).unwrap();
        let r = 33_533_784;
        assert_eq!(check_served(&v, r, &pk).unwrap().round, r);
        // Asked for another round (a replayed or misrouted answer).
        assert_eq!(check_served(&v, r + 1, &pk), Err(PortError::BadBeacon(r + 1)));
        // The same round under another key (wrong network, the test key).
        assert!(check_served(&v, r, &TestKey::new().pk96).is_err());
        // A forged signature: the test key's signature of the same round.
        let mut forged = v.clone();
        forged["signature"] = hex::encode(TestKey::new().sign(r)).into();
        forged["randomness"] = hex::encode(Sha256::digest(TestKey::new().sign(r))).into();
        assert!(check_served(&forged, r, &pk).is_err());
        // A flipped signature byte, a truncated one, and garbage.
        let mut flip = v.clone();
        let mut sig = hex::decode(v["signature"].as_str().unwrap()).unwrap();
        sig[47] ^= 1;
        flip["signature"] = hex::encode(&sig).into();
        assert!(check_served(&flip, r, &pk).is_err());
        let mut short = v.clone();
        short["signature"] = hex::encode(&sig[..47]).into();
        assert!(check_served(&short, r, &pk).is_err());
        assert!(check_served(&serde_json::json!({"round": r}), r, &pk).is_err());
        // randomness that is not sha256(signature).
        let mut rnd = v.clone();
        rnd["randomness"] = hex::encode([0u8; 32]).into();
        assert!(check_served(&rnd, r, &pk).is_err());
        // randomness absent (the v2 rounds route): accepted on the signature.
        let mut v2 = v.clone();
        v2.as_object_mut().unwrap().remove("randomness");
        assert!(check_served(&v2, r, &pk).is_ok());
    }

    #[test]
    fn the_test_key_is_pinned_only_on_loopback() {
        let lo = vec!["http://127.0.0.1:41020".to_string()];
        assert_eq!(pins_for(&lo).len(), 2);
        let mixed = vec![lo[0].clone(), "https://api.drand.sh".to_string()];
        assert_eq!(pins_for(&mixed), vec![quicknet_info()]);
        assert_eq!(pins_for(&[]), vec![quicknet_info()]);
    }

    #[test]
    fn expand_xmd_rfc9380_vector() {
        // RFC 9380 K.1, expand_message_xmd(SHA-256), msg "", len 0x20.
        let out = expand_xmd(b"", b"QUUX-V01-CS02-with-expander-SHA256-128", 0x20);
        assert_eq!(
            hex::encode(out),
            "68a985b87eb6b46952128911f2a4412bbc302a9d759667f87f7a21d803f07235"
        );
    }
}
