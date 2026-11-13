//! **Local-play keeper assembly** (feature `localnet-expedition-play`): the
//! minimum a keeper does so the temporary local-play chain's home Province
//! stays resident, with REAL instructions only:
//!
//! 1. for each bell `b` from the Province's `resolved_next` up to the last
//!    bell whose end has passed, the round `T(b)` of the Season's clock is
//!    fetched from the PUBLIC drand API (the fixed Quicknet chain at
//!    `https://api.drand.sh`, the only endpoint; read-only GETs through
//!    fclient's hardened curl path) and accepted only if its signature
//!    verifies against the pinned Quicknet key (`beacon::HttpDrand`, which
//!    also refuses another round). At most [`MAX_ROUNDS`] rounds per call;
//!    each one's provenance is returned;
//! 2. `PostAnchor(region, b)` with that round, its signature and hints: the
//!    program verifies the signature itself (BLS12-381 syscalls);
//! 3. once every posted anchor's reveal window has closed on the chain's
//!    clock, `FastForward(to, days)` with the Province's ArrivalDays and the
//!    anchors as evidence: the program advances `resolved_next` as far as
//!    they prove.
//!
//! Nothing here writes an account directly, forges a round, a time or a
//! result: a refusal of the program is returned as it is. The fee payer is
//! the caller's (a fresh in-memory key in the tests); no key is read or
//! stored. No transaction goes anywhere but the given local chain.
use fclient::addr::Addresses;
use fclient::beacon::{hints_bytes, quicknet_info, HttpDrand};
use fclient::ix::{post_anchor, post_anchor_multi, BeaconArg};
use fclient::ports::DrandPort;
use fclient::tx::{self, TxBudget};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::clash_model::DAY_BELLS;
use localnet::Chain;
use permutation_rules::frontier::geometry::{region_of, ProvinceCoord};

/// The only beacon endpoint: drand's public API, fixed Quicknet chain.
pub const DRAND_URL: &str = "https://api.drand.sh";
/// The most rounds one call fetches (bounded network use).
pub const MAX_ROUNDS: usize = 48;
/// The most bells one FastForward may name: its anchors are one account key
/// each, so a batch must fit the 1232-byte packet with the budget prefix
/// (checked on the encoded transaction by `fits_packet`). Longer backlogs
/// are advanced in several batches.
pub const MAX_FAST_FORWARD_BELLS: u32 = 16;
/// Solana's transaction packet.
pub const PACKET_BYTES: usize = 1232;

/// The encoded size of `ixs` signed by one fee payer with the keeper's budget.
pub fn encoded_len(ixs: &[Instruction], payer: &Keypair) -> Result<usize, String> {
    let t = tx::build(ixs, &budget(), &[payer], &fclient::Hash::new_from_array([1; 32]))?;
    Ok(tx::wire(&t).len())
}

/// A served beacon is accepted for `round` only if it IS that round and its
/// signature verifies against the pinned Quicknet key `pk`.
pub fn accept_round(round: u64, served: &fclient::ports::Beacon, pk: &[u8; 96]) -> Result<[u8; 48], String> {
    if served.round != round {
        return Err(format!("drand answered round {} for {round}", served.round));
    }
    if !fclient::beacon::verify(round, &served.sig48, pk) {
        return Err(format!("drand round {round}: not the pinned Quicknet signature"));
    }
    Ok(served.sig48)
}

/// The landing time A of THE anchor of (`b`, `region`), read only after its
/// identity is checked: present, owned by the program, not executable, the
/// exact BellAnchor size and magic, this Season, this bell and region.
pub fn anchor_landed(c: &Chain, a: &Addresses, b: u32, region: u8) -> Result<Option<i64>, String> {
    use frontier_abi::layout::beacon::bell_anchor as BA;
    let Some(acc) = c.account(&a.anchor(b, region)) else { return Ok(None) };
    let d = &acc.data;
    let kind = frontier_abi::v2::layout::AccountKind::BellAnchor;
    if acc.owner != a.program || acc.executable || d.len() != kind.size() || d.get(..8) != Some(kind.magic().as_slice())
        || d.get(8..16).map(|x| u64::from_le_bytes(x.try_into().unwrap())) != Some(a.season_id)
        || d.get(BA::BELL..BA::BELL + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap())) != Some(b)
        || d.get(BA::REGION) != Some(&region)
    {
        return Err(format!("the account at the anchor address of bell {b} is not that anchor"));
    }
    Ok(Some(i64::from_le_bytes(d[BA::A..BA::A + 8].try_into().map_err(|_| "anchor")?)))
}

/// One fetched round and where it came from (public data only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundProvenance {
    pub bell: u32,
    pub round: u64,
    pub signature_hex: String,
    pub source: String,
    pub verified_against: &'static str,
}

/// What the keeper did, instruction by instruction.
#[derive(Clone, Debug, Default)]
pub struct KeeperReport {
    pub rounds: Vec<RoundProvenance>,
    pub anchors_posted: Vec<(u32, String)>,
    pub fast_forward: Option<(u32, u32, String)>,
}

/// The facts the keeper reads from the chain.
#[derive(Clone, Copy, Debug)]
pub struct HomeView {
    pub resolved_next: u32,
    pub bell_now: u32,
    pub region: u8,
}

fn season_of(c: &Chain, a: &Addresses) -> Result<fclient::decode::Season, String> {
    let d = c.account(&a.season).ok_or("no Season")?.data;
    fclient::decode::Season::decode(&d).map_err(|e| format!("Season: {e:?}"))
}

/// The home Province's `resolved_next`, the chain's current bell and the
/// Province's region.
pub fn view(c: &Chain, a: &Addresses, p: i16, q: i16) -> Result<HomeView, String> {
    let season = season_of(c, a)?;
    let clock = fclient::clock::SeasonClock::from_season(&season);
    let bell_now = clock.bell_at(c.unix_timestamp()).ok_or("before genesis")?;
    let pd = c.account(&a.province(p.into(), q.into())).ok_or("no Province")?.data;
    let pv = fclient::decode::Province::decode(&pd).map_err(|e| format!("Province: {e:?}"))?;
    Ok(HomeView { resolved_next: pv.resolved_next, bell_now, region: region_of(ProvinceCoord::new(p.into(), q.into())) })
}

/// The bells a keeper can anchor now: from `resolved_next` to the last bell
/// whose end (T(b)'s time) has passed, at most [`MAX_ROUNDS`].
pub fn anchorable(v: &HomeView) -> std::ops::Range<u32> {
    let end = v.bell_now.min(v.resolved_next.saturating_add(MAX_ROUNDS as u32));
    v.resolved_next..end.max(v.resolved_next)
}

/// The Season's clock (read once; the chain need not stay locked afterwards).
pub fn season_clock(c: &Chain, a: &Addresses) -> Result<fclient::clock::SeasonClock, String> {
    Ok(fclient::clock::SeasonClock::from_season(&season_of(c, a)?))
}

/// Fetches and verifies T(b) for each bell from the public drand API.
pub async fn fetch_rounds(clock: &fclient::clock::SeasonClock, bells: std::ops::Range<u32>) -> Result<Vec<RoundProvenance>, String> {
    if bells.len() > MAX_ROUNDS {
        return Err(format!("at most {MAX_ROUNDS} rounds per call"));
    }
    let info = quicknet_info();
    let drand = HttpDrand::new(vec![DRAND_URL.into()], info.clone());
    let mut out = Vec::with_capacity(bells.len());
    for bell in bells {
        let round = clock.tlock_round(bell);
        let b = drand.round(round).await.map_err(|e| format!("drand round {round}: {e:?}"))?
            .ok_or(format!("drand round {round} is not published yet"))?;
        // (HttpDrand::round already refused anything that does not verify; re-check)
        let sig48 = accept_round(round, &b, &info.public_key)?;
        out.push(RoundProvenance {
            bell,
            round,
            signature_hex: hex::encode(sig48),
            source: format!("{DRAND_URL}/{}/public/{round}", hex::encode(info.chain_hash)),
            verified_against: "fclient::beacon::quicknet_info().public_key (pinned Quicknet key)",
        });
    }
    Ok(out)
}

/// One round from the public drand API, verified against the pinned key
/// (the seed rounds S(b, A) are not T(b)).
pub async fn fetch_round_at(round: u64) -> Result<[u8; 48], String> {
    let info = quicknet_info();
    let drand = HttpDrand::new(vec![DRAND_URL.into()], info.clone());
    let b = drand.round(round).await.map_err(|e| format!("drand round {round}: {e:?}"))?
        .ok_or(format!("drand round {round} is not published yet"))?;
    accept_round(round, &b, &info.public_key)
}

fn send(c: &mut Chain, payer: &Keypair, ixs: &[Instruction], what: &str) -> Result<String, String> {
    let (blockhash, _) = c.latest_blockhash();
    let t = tx::build(ixs, &budget(), &[payer], &blockhash)?;
    let sig = c.submit(&tx::wire(&t)).map_err(|e| format!("{what} refused before landing: {e}"))?;
    c.produce_block();
    let landed = c.transaction(&sig).cloned().ok_or(format!("{what} did not land"))?;
    if let Some(err) = landed.err {
        let tail: Vec<_> = landed.logs.iter().rev().take(6).rev().cloned().collect();
        return Err(format!("{what} failed: {err} (code {:?}) {tail:?}", landed.code));
    }
    Ok(sig.to_string())
}

/// The PostAnchor instruction of one verified round.
pub fn post_anchor_ix(a: &Addresses, payer: &Address, region: u8, r: &RoundProvenance) -> Result<Instruction, String> {
    let sig48: [u8; 48] = hex::decode(&r.signature_hex).map_err(|e| e.to_string())?.try_into().map_err(|_| "signature length")?;
    let arg = BeaconArg { round: r.round, sig48, hints: hints_bytes(r.round) };
    Ok(post_anchor(a, *payer, region, r.bell, &arg, payer))
}

// ------------------------------------------------------------ destination anchors
//
// A transit's destination is sealed until its reveal, so the keeper cannot
// know the destination's region: it anchors the arrival bell in EVERY region
// (`REGIONS`), with PostAnchorMulti batches of at most `MULTI_MAX_REGIONS`.
// The anchors are the program's beacon evidence for that bell (one verified
// round each, present ones skipped); they never decide an arrival. Posting
// one starts that bell's reveal window in its region (`reveal_close(b, A)`),
// as the program's rule for every keeper; the program's Reveal itself does
// not require the anchor to exist.

/// The regions an anchor may name (`geometry::REGIONS`).
pub const REGIONS: u8 = permutation_rules::frontier::geometry::REGIONS;
/// Regions per PostAnchorMulti (the packet bound).
pub const MULTI_REGIONS: usize = frontier_abi::budgets::MULTI_MAX_REGIONS;

/// The arrival bells of `holding`'s transits that still need their
/// destination resolved: a program-owned bridge record in state Departed or
/// Settled (not gathered, not destroyed at origin, not free), ascending and
/// distinct. An unreadable program-owned record is an error (never skipped).
pub fn pending_arrival_bells(c: &Chain, a: &Addresses, holding: &Address) -> Result<Vec<u32>, String> {
    use frontier_abi::world_index::{expedition_transport::OwnedBridgeTransit, march::{transit_address, MarchState}};
    let ctx = AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() };
    let mut out = vec![];
    for slot in 0..4u8 {
        let key = Address::new_from_array(transit_address(&ctx, &holding.to_bytes(), slot));
        let Some(acc) = c.account(&key) else { continue };
        if acc.owner != a.program {
            continue;
        }
        let b = OwnedBridgeTransit::from_bytes(&ctx, &acc.data).map_err(|e| format!("transit slot {slot}: unreadable bridge record ({e:?})"))?;
        let t = b.transit();
        if matches!(t.state, MarchState::Departed | MarchState::Settled) {
            out.push(t.arrive_bell);
        }
    }
    // (a LEGACY village's ordinary march: its inline transits, Departed or Settled at origin, need their arrival
    //  bell anchored in every region too — the destination is sealed until the reveal)
    if let Some(h) = c.account(holding).filter(|acc| acc.owner == a.program).and_then(|acc| fclient::decode::Holding::decode(&acc.data).ok()) {
        out.extend(h.transit.iter().filter(|t| matches!(t.state, 1 | 2)).map(|t| t.arrive_bell));
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// The PostAnchorMulti masks that would create the anchors of `bell` still
/// absent in any region: ascending regions, at most [`MULTI_REGIONS`] each.
/// A region counts as anchored only when its account IS that anchor
/// ([`anchor_landed`]: program-owned, exact size and magic, this Season,
/// this bell and region); any other account at an anchor address is an
/// error, never a finished region.
pub fn missing_region_masks(c: &Chain, a: &Addresses, bell: u32) -> Result<Vec<u16>, String> {
    let mut absent = vec![];
    for rg in 0..REGIONS {
        if anchor_landed(c, a, bell, rg)?.is_none() {
            absent.push(rg);
        }
    }
    Ok(region_masks(absent.into_iter()))
}

/// The regions of `mask` whose anchor of `bell` is still absent, re-read
/// with the same identity check (an invalid account is an error).
pub fn still_absent(c: &Chain, a: &Addresses, bell: u32, mask: u16) -> Result<u16, String> {
    let mut out = 0u16;
    for rg in (0..REGIONS).filter(|rg| mask & (1 << rg) != 0) {
        if anchor_landed(c, a, bell, rg)?.is_none() {
            out |= 1 << rg;
        }
    }
    Ok(out)
}

/// Groups ascending regions into masks of at most [`MULTI_REGIONS`] bits.
pub fn region_masks(regions: impl Iterator<Item = u8>) -> Vec<u16> {
    let regions: Vec<u8> = regions.collect();
    regions.chunks(MULTI_REGIONS).map(|ch| ch.iter().fold(0u16, |m, &rg| m | (1 << rg))).collect()
}

/// The PostAnchorMulti instruction of one verified round over `mask`.
pub fn post_anchor_multi_ix(a: &Addresses, payer: &Address, mask: u16, r: &RoundProvenance) -> Result<Instruction, String> {
    let k = mask.count_ones() as usize;
    if k == 0 || k > MULTI_REGIONS || u32::from(mask) >> REGIONS != 0 {
        return Err(format!("PostAnchorMulti mask {mask:#06x}: 1..={MULTI_REGIONS} regions"));
    }
    let sig48: [u8; 48] = hex::decode(&r.signature_hex).map_err(|e| e.to_string())?.try_into().map_err(|_| "signature length")?;
    let arg = BeaconArg { round: r.round, sig48, hints: hints_bytes(r.round) };
    Ok(post_anchor_multi(a, *payer, r.bell, &arg, mask, payer))
}

/// The bells of `range` whose anchor of `region` is not on the chain yet.
pub fn missing_anchors(c: &Chain, a: &Addresses, region: u8, range: std::ops::Range<u32>) -> Vec<u32> {
    range.filter(|b| c.account(&a.anchor(*b, region)).is_none()).collect()
}

/// The first bell from `from` whose anchor is absent or whose reveal window
/// has not closed at the chain's present: FastForward can prove up to there.
pub fn closed_through(c: &Chain, a: &Addresses, region: u8, from: u32, limit: u32) -> Result<u32, String> {
    let clock = season_clock(c, a)?;
    let now = c.unix_timestamp();
    let mut b = from;
    while b < limit {
        let Some(landed) = anchor_landed(c, a, b, region)? else { break };
        if now < clock.reveal_close(b, landed) {
            break;
        }
        b += 1;
    }
    Ok(b)
}

/// PostAnchor for each verified round (the program verifies the signature again).
pub fn post_anchors(c: &mut Chain, a: &Addresses, payer: &Keypair, region: u8, rounds: &[RoundProvenance]) -> Result<Vec<(u32, String)>, String> {
    let mut out = vec![];
    for r in rounds {
        let ix = post_anchor_ix(a, &payer.pubkey(), region, r)?;
        out.push((r.bell, send(c, payer, &[ix], &format!("PostAnchor(bell {})", r.bell))?));
    }
    Ok(out)
}

/// The latest time any of `bells`' anchors' reveal window closes on the
/// chain's clock (`reveal_close(b, A)` from each anchor's landing time).
pub fn reveal_closed_at(c: &Chain, a: &Addresses, region: u8, bells: std::ops::Range<u32>) -> Result<i64, String> {
    let clock = fclient::clock::SeasonClock::from_season(&season_of(c, a)?);
    let mut latest = i64::MIN;
    for b in bells {
        let landed = anchor_landed(c, a, b, region)?.ok_or(format!("no anchor of bell {b}"))?;
        latest = latest.max(clock.reveal_close(b, landed));
    }
    Ok(latest)
}

/// FastForward(to, days) of the Province with its ArrivalDays from
/// day(resolved_next) and the anchors of `bells` as evidence.
pub fn fast_forward(c: &mut Chain, a: &Addresses, payer: &Keypair, p: i16, q: i16, v: &HomeView, to: u32) -> Result<String, String> {
    let ix = fast_forward_ix(a, &payer.pubkey(), p, q, v, to)?;
    send(c, payer, &[ix], &format!("FastForward(to {to})"))
}

/// The FastForward instruction (see [`fast_forward`]).
pub fn fast_forward_ix(a: &Addresses, payer: &Address, p: i16, q: i16, v: &HomeView, to: u32) -> Result<Instruction, String> {
    if to <= v.resolved_next {
        return Err("nothing to advance".into());
    }
    if to - v.resolved_next > MAX_FAST_FORWARD_BELLS {
        return Err(format!("at most {MAX_FAST_FORWARD_BELLS} bells per FastForward"));
    }
    let ctx = AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() };
    let d0 = v.resolved_next / DAY_BELLS;
    let days = u8::try_from((to - 1) / DAY_BELLS - d0 + 1).map_err(|_| "too many days")?;
    let mut metas = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(a.province(p.into(), q.into()), false),
    ];
    for k in 0..days as u32 {
        metas.push(AccountMeta::new_readonly(Address::new_from_array(ctx.arrival_day(p.into(), q.into(), d0 + k)), false));
    }
    for b in v.resolved_next..to {
        metas.push(AccountMeta::new_readonly(a.anchor(b, v.region), false));
    }
    let data = frontier_abi::v2::ix::FastForward { to, days }.to_bytes().to_vec();
    Ok(Instruction { program_id: a.program, accounts: metas, data })
}

/// Simulates `ix` paid by `payer` on the node (nothing is sent).
pub fn simulate_ix(c: &Chain, payer: &Keypair, ix: &Instruction) -> Result<fclient::ports::SimResult, String> {
    let (blockhash, _) = c.latest_blockhash();
    let t = tx::build(std::slice::from_ref(ix), &budget(), &[payer], &blockhash)?;
    c.simulate(&tx::wire(&t), false).map_err(|e| format!("simulation refused: {e}"))
}

/// The program's NotQuiet code (a bell with a pending clash, arrival or departure).
pub const NOT_QUIET: u32 = frontier_abi::FrontierError::NotQuiet as u32;

/// The keeper's transaction budget (PostAnchor's verification needs the heap frame).
pub fn budget() -> TxBudget {
    TxBudget { cu_limit: 1_400_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(256 * 1024) }
}

/// With the real artifact and the PUBLIC drand API: on a fresh isolated chain
/// of the runner (its home opened by the real OpenProvince), the clock is
/// moved on with the node's own scale control (this test chain only), the
/// rounds T(10..12) are fetched and verified, PostAnchor runs for each, and
/// once their reveal windows closed FastForward advances the home: the host
/// is resident again. Ignored without `WYLLS_EXPEDITION_SBF(_SHA256)` and
/// `WYLLS_PUBLIC_DRAND=1` (it reads api.drand.sh). Keys: fresh in-memory.
#[cfg(test)]
mod public_quicknet {
    use super::*;
    use crate::expedition_play::{inspect, launch, PROGRAM, REFUSED_PORT, SEASON_ID};
    use localnet::server;

    fn advance(c: &mut Chain, to_unix: i64) {
        c.set_scale(1000.0);
        while c.unix_timestamp() < to_unix {
            c.produce_block();
        }
        c.set_scale(1.0);
        c.produce_block();
    }

    #[test]
    #[ignore]
    fn public_quicknet_anchors_and_fast_forward_keep_the_home_resident() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        assert_eq!(need("WYLLS_PUBLIC_DRAND"), "1", "reads the public drand API");
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let artifact = inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let p = (41_930..41_945u16).find(|p| *p != REFUSED_PORT && server::check_port(*p).is_ok()).unwrap();
            let q = (p + 1..41_946u16).find(|x| server::check_port(*x).is_ok()).unwrap();
            let player = Keypair::new();
            let play = launch(&artifact, player.pubkey(), p, q).await.unwrap();
            let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
            let payer = Keypair::new();
            let (v0, rounds): (HomeView, std::ops::Range<u32>) = {
                let mut c = server::lock(&play.running.state);
                c.airdrop(&payer.pubkey(), 20_000_000_000).unwrap();
                let v0 = view(&c, &a, 128, 0).unwrap();
                assert_eq!(v0.resolved_next, v0.bell_now, "opened at the current bell");
                // three bells later: the home is no longer resident
                let clock = fclient::clock::SeasonClock::from_season(&season_of(&c, &a).unwrap());
                advance(&mut c, clock.genesis_ts + 600 * (v0.bell_now as i64 + 3) + 5);
                let v = view(&c, &a, 128, 0).unwrap();
                assert!(!frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now), "{v:?}");
                (v, anchorable(&v))
            };
            // public, verified rounds (the chain lock is not held over the network)
            let clock = season_clock(&server::lock(&play.running.state), &a).unwrap();
            let bells = rounds;
            let provenance = fetch_rounds(&clock, bells.clone()).await.unwrap();
            assert_eq!(provenance.len(), bells.len());
            for r in &provenance {
                eprintln!("bell {} round {} from {} (verified)", r.bell, r.round, r.source);
            }
            let mut c = server::lock(&play.running.state);
            let posted = post_anchors(&mut c, &a, &payer, v0.region, &provenance).unwrap();
            assert_eq!(posted.len(), bells.len());
            // the program created each anchor with the posted round
            for b in bells.clone() {
                let d = c.account(&a.anchor(b, v0.region)).expect("anchor created by PostAnchor").data;
                assert_eq!(u64::from_le_bytes(d[frontier_abi::layout::beacon::bell_anchor::ROUND..][..8].try_into().unwrap()), clock.tlock_round(b));
            }
            // FastForward before the reveal windows close proves nothing
            let v = view(&c, &a, 128, 0).unwrap();
            assert!(fast_forward(&mut c, &a, &payer, 128, 0, &v, bells.end).is_err(), "not yet closed");
            let closed = reveal_closed_at(&c, &a, v0.region, bells.clone()).unwrap();
            advance(&mut c, closed + 1);
            let v = view(&c, &a, 128, 0).unwrap();
            let sig = fast_forward(&mut c, &a, &payer, 128, 0, &v, bells.end).unwrap();
            let after = view(&c, &a, 128, 0).unwrap();
            eprintln!("FastForward {sig}: resolved_next {} -> {}, bell now {}", v.resolved_next, after.resolved_next, after.bell_now);
            assert_eq!(after.resolved_next, bells.end, "advanced exactly as far as the anchors prove");
            assert!(frontier_abi::prologue::resident_ok(after.resolved_next, after.bell_now), "{after:?}");
            drop(c);
            play.running.stop();
        });
    }
}

/// Refusals without network or program: synthetic accounts on an in-memory
/// chain (the base Season of the runner), the recorded public q4 signature.
#[cfg(test)]
mod refusals {
    use super::*;
    use crate::expedition_play::{Base, PROGRAM, SEASON_ID};
    use frontier_abi::layout::beacon::bell_anchor as BA;
    use frontier_abi::v2::layout::{write_header, AccountKind as K2};

    fn chain() -> (Chain, Addresses) {
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        Base::new(c.unix_timestamp()).unwrap().install(&mut c).unwrap();
        (c, Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID))
    }
    fn anchor(bell: u32, region: u8, a_ts: i64) -> Vec<u8> {
        let mut d = vec![0u8; K2::BellAnchor.size()];
        assert!(write_header(&mut d, K2::BellAnchor, SEASON_ID));
        d[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        d[BA::REGION] = region;
        d[BA::A..BA::A + 8].copy_from_slice(&a_ts.to_le_bytes());
        d
    }
    fn put(c: &mut Chain, k: Address, owner: Address, data: Vec<u8>) {
        c.set_account(k, fclient::ports::Account { lamports: 1_000_000, data, owner, executable: false }).unwrap();
    }

    #[test]
    fn only_the_asked_round_with_the_pinned_signature_is_accepted() {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(fclient::seal::fixture_dir().join("q4-vector.json")).unwrap()).unwrap();
        let round = v["round"].as_u64().unwrap();
        let sig: [u8; 48] = hex::decode(v["sig"].as_str().unwrap()).unwrap().try_into().unwrap();
        let prev: [u8; 48] = hex::decode(v["prev_round_sig"].as_str().unwrap()).unwrap().try_into().unwrap();
        let pk = quicknet_info().public_key;
        let b = |round, sig48| fclient::ports::Beacon { round, sig48 };
        assert_eq!(accept_round(round, &b(round, sig), &pk), Ok(sig));
        assert!(accept_round(round, &b(round + 1, sig), &pk).is_err(), "another round served");
        assert!(accept_round(round, &b(round, prev), &pk).is_err(), "another round's signature");
        assert!(accept_round(round, &b(round, sig), &fclient::beacon::TestKey::new().pk96).is_err(), "another key");
    }

    #[test]
    fn every_region_is_anchored_in_packet_sized_batches() {
        assert_eq!(REGIONS, 16);
        assert_eq!(region_masks(0..16), vec![0x007f, 0x3f80, 0xc000]);
        assert_eq!(region_masks([1u8, 4, 15].into_iter()), vec![(1 << 1) | (1 << 4) | (1 << 15)]);
        assert!(region_masks(std::iter::empty()).is_empty());
        for m in region_masks(0..16) {
            assert!((1..=MULTI_REGIONS as u32).contains(&m.count_ones()));
        }
        // a present anchor is not asked for again
        let (mut c, a) = chain();
        put(&mut c, a.anchor(20, 3), Address::new_from_array(PROGRAM), anchor(20, 3, 5));
        let masks = missing_region_masks(&c, &a, 20).unwrap();
        assert_eq!(masks.iter().fold(0u16, |x, m| x | m), 0xffff & !(1 << 3));
        assert_eq!(masks.iter().map(|m| m.count_ones()).sum::<u32>(), 15);
        // each mask builds a PostAnchorMulti that fits the packet
        let payer = Keypair::new();
        let r = RoundProvenance { bell: 20, round: 1, signature_hex: "00".repeat(48), source: String::new(), verified_against: "test" };
        for m in &masks {
            let ix = post_anchor_multi_ix(&a, &payer.pubkey(), *m, &r).unwrap();
            assert!(encoded_len(&[ix], &payer).unwrap() <= PACKET_BYTES);
        }
        assert!(post_anchor_multi_ix(&a, &payer.pubkey(), 0, &r).is_err());
        assert!(post_anchor_multi_ix(&a, &payer.pubkey(), 0x00ff, &r).is_err(), "8 regions");
    }

    #[test]
    fn an_account_that_is_not_the_anchor_is_an_error_not_a_finished_region() {
        let program = Address::new_from_array(PROGRAM);
        let (mut c, a) = chain();
        // partial: regions 0 and 2 really anchored, the re-read drops only them
        put(&mut c, a.anchor(20, 0), program, anchor(20, 0, 5));
        put(&mut c, a.anchor(20, 2), program, anchor(20, 2, 5));
        assert_eq!(still_absent(&c, &a, 20, 0x007f), Ok(0x007a));
        assert_eq!(missing_region_masks(&c, &a, 20).unwrap(), vec![0x01fa, 0xfe00]);
        // wrong owner, short data, another bell, another region: each stops
        let bad: [(Address, Vec<u8>); 4] = [
            (Address::new_from_array([9; 32]), anchor(20, 5, 5)),
            (program, anchor(20, 5, 5)[..40].to_vec()),
            (program, anchor(21, 5, 5)),
            (program, anchor(20, 6, 5)),
        ];
        for (owner, data) in bad {
            put(&mut c, a.anchor(20, 5), owner, data);
            assert!(missing_region_masks(&c, &a, 20).is_err());
            assert!(still_absent(&c, &a, 20, 1 << 5).is_err());
            assert!(still_absent(&c, &a, 20, 1 << 4).is_ok(), "a mask without the bad region reads it not");
        }
    }

    #[test]
    fn pending_arrivals_are_the_departed_and_settled_transits_once_each() {
        use frontier_abi::world_index::march::{transit_address, MarchState};
        let program = Address::new_from_array(PROGRAM);
        let holding = Address::new_from_array([5; 32]);
        let (mut c, a) = chain();
        assert_eq!(pending_arrival_bells(&c, &a, &holding), Ok(vec![]), "no transit");
        let ctx = AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() };
        let at = |slot: u8| Address::new_from_array(transit_address(&ctx, &holding.to_bytes(), slot));
        // the records really are in the states named
        let state = |d: &[u8]| frontier_abi::world_index::expedition_transport::OwnedBridgeTransit::from_bytes(&ctx, d).unwrap().transit().state;
        assert_eq!(state(&super::test_transit_record_as(&a, 1, 15, "settled")), MarchState::Settled);
        assert_eq!(state(&super::test_transit_record_as(&a, 3, 30, "destroyed")), MarchState::DestroyedAtOrigin);
        put(&mut c, at(0), program, super::test_transit_record_as(&a, 0, 15, "departed"));
        put(&mut c, at(1), program, super::test_transit_record_as(&a, 1, 15, "settled"));
        put(&mut c, at(2), program, super::test_transit_record_as(&a, 2, 20, "settled"));
        put(&mut c, at(3), program, super::test_transit_record_as(&a, 3, 30, "destroyed"));
        assert_eq!(pending_arrival_bells(&c, &a, &holding), Ok(vec![15, 20]), "ascending, distinct, destroyed excluded");
        // a record not owned by the program is not a transit
        put(&mut c, at(3), Address::new_from_array([9; 32]), super::test_transit_record_as(&a, 3, 40, "departed"));
        assert_eq!(pending_arrival_bells(&c, &a, &holding), Ok(vec![15, 20]));
        // a program-owned record that does not read is an error, never skipped
        put(&mut c, at(3), program, vec![0u8; 16]);
        assert!(pending_arrival_bells(&c, &a, &holding).is_err());
    }

    #[test]
    fn anchors_are_read_only_after_their_identity() {
        let (mut c, a) = chain();
        let program = a.program;
        assert_eq!(anchor_landed(&c, &a, 10, 3), Ok(None));
        let k = a.anchor(10, 3);
        put(&mut c, k, program, vec![1, 2, 3]); // short: refused, no panic
        assert!(anchor_landed(&c, &a, 10, 3).is_err());
        put(&mut c, k, Address::new_from_array([9; 32]), anchor(10, 3, 5));
        assert!(anchor_landed(&c, &a, 10, 3).is_err(), "foreign owner");
        put(&mut c, k, program, anchor(11, 3, 5));
        assert!(anchor_landed(&c, &a, 10, 3).is_err(), "another bell");
        put(&mut c, k, program, anchor(10, 4, 5));
        assert!(anchor_landed(&c, &a, 10, 3).is_err(), "another region");
        let mut wrong_magic = anchor(10, 3, 5);
        wrong_magic[0] ^= 1;
        put(&mut c, k, program, wrong_magic);
        assert!(anchor_landed(&c, &a, 10, 3).is_err(), "another kind");
        put(&mut c, k, program, anchor(10, 3, 1_785_540_000));
        assert_eq!(anchor_landed(&c, &a, 10, 3), Ok(Some(1_785_540_000)));
        // closed_through and reveal_closed_at stop at (or refuse) a bad anchor
        put(&mut c, a.anchor(11, 3), program, vec![0; 10]);
        assert!(closed_through(&c, &a, 3, 10, 12).is_err());
        assert!(reveal_closed_at(&c, &a, 3, 10..12).is_err());
        assert_eq!(missing_anchors(&c, &a, 3, 10..14), vec![12, 13]);
    }

    #[test]
    fn fast_forward_is_bounded() {
        let a = Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID);
        let payer = Address::new_from_array([5; 32]);
        let v = HomeView { resolved_next: 10, bell_now: 20, region: 3 };
        assert!(fast_forward_ix(&a, &payer, 128, 0, &v, 10).is_err(), "nothing to advance");
        assert!(fast_forward_ix(&a, &payer, 128, 0, &v, 9).is_err());
        assert!(fast_forward_ix(&a, &payer, 128, 0, &v, 10 + MAX_FAST_FORWARD_BELLS + 1).is_err(), "over the bound");
        assert!(fast_forward_ix(&a, &payer, 128, 0, &HomeView { resolved_next: u32::MAX - 5, ..v }, u32::MAX).is_ok());
        let ix = fast_forward_ix(&a, &payer, 128, 0, &v, 13).unwrap();
        // payer, Season, Province, one ArrivalDay, three anchors
        assert_eq!(ix.accounts.len(), 3 + 1 + 3);
        assert_eq!(ix.data, frontier_abi::v2::ix::FastForward { to: 13, days: 1 }.to_bytes().to_vec());
        // across a day boundary: two ArrivalDays
        let edge = HomeView { resolved_next: DAY_BELLS - 2, ..v };
        let ix = fast_forward_ix(&a, &payer, 128, 0, &edge, DAY_BELLS + 1).unwrap();
        assert_eq!(ix.accounts.len(), 3 + 2 + 3);
    }
}

/// TEST ONLY: a public bridge transit record of slot `slot` arriving at
/// `arrive`, `how` = departed | settled | destroyed (pure codec, no chain).
#[cfg(test)]
pub(crate) fn test_transit_record_as(a: &Addresses, slot: u8, arrive: u32, how: &str) -> Vec<u8> {
    use frontier_abi::world_index::{expedition::AccountResolver, expedition_transport::OwnedBridgeTransit, march::WideTransit, TileAddress, HOST_IDENTITY_FULL_REF_V1};
    use permutation_rules::frontier::{doctrine::of_faction_v3, host::STAMINA_CAP, stance::{Posture, Stance}, travel::{march_stamina, MAX_PATH_STEPS}};
    let ctx = AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() };
    let r = AccountResolver::for_season(&ctx).unwrap();
    let host = r.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, slot as u32).unwrap()).unwrap();
    let doctrine = of_faction_v3(2).unwrap();
    let dealt = doctrine.dealt_bps(Posture::Stance(Stance::Hold), true) as u16;
    let t = WideTransit::depart(HOST_IDENTITY_FULL_REF_V1, host, doctrine.unit as u8, 2, TileAddress::new(host.key(), 3).unwrap(),
        arrive - 5, arrive, 600, 100_000, march_stamina(MAX_PATH_STEPS as u32), dealt, [21; 32], 0, 0, [22; 32]).unwrap();
    let b = OwnedBridgeTransit::new(&ctx, slot, t, [23; 32]).unwrap();
    let stamina = STAMINA_CAP - march_stamina(MAX_PATH_STEPS as u32);
    let b = match how {
        "departed" => b,
        "settled" => b.settle_origin(&ctx, false, Some((80_000, stamina, 2))).unwrap(),
        "destroyed" => b.settle_origin(&ctx, true, Some((0, 0, 2))).unwrap(),
        _ => unreachable!(),
    };
    b.to_bytes().to_vec()
}

/// TEST ONLY: a Departed record ([`test_transit_record_as`]).
#[cfg(test)]
pub(crate) fn test_transit_record(a: &Addresses, slot: u8, arrive: u32) -> Vec<u8> {
    test_transit_record_as(a, slot, arrive, "departed")
}
