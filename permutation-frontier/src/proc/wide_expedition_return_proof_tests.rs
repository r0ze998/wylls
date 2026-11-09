//! Selected, real-crypto host tests, not chain or transaction evidence.
//! The immutable public Quicknet signature/hints are actually verified; its
//! published IBE block actually recovers the existing symmetric key. Only a
//! deterministic synthetic wide body is built in memory. Reusing this public
//! key/keystream is UNSAFE for production sealing and adds no confidentiality.
//! No keypair, signature, random value, recorded opening key or export is used.
//!
//! Canonical anchor/archive accounts below are explicit prior-state snapshots,
//! NOT output from PostAnchor/ArchiveAnchors. PostAnchor creation requires an
//! absent zero-length account plus allocation CPI; an existing valid account
//! is a no-op and malformed preallocated data refuses. No allocation override,
//! CPI-success stub or imported native-crypto test suite is installed here.
use super::*;
use crate::crypto::quick::tests::{decode, FIXTURE_HINTS_HEX, FIXTURE_ROUND, FIXTURE_SIG_HEX};
use crate::crypto::{quick, xmd};
use crate::layout::beacon::{anchor_archive as AA, archive_entry as AE};
use alloc::boxed::Box;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot;
use permutation_rules::frontier::beacon;

const PROGRAM: [u8; 32] = [12; 32];
const OWNER: [u8; 32] = [33; 32];
const RENT_TO: [u8; 32] = [22; 32];
const SID: u64 = 11;
const ARRIVE: u32 = 12;
const SLOT: u8 = 2;
const POSITION: usize = wa::wide_clash_inputs::position(2, 0);

fn account(address: [u8; 32], owner: [u8; 32], data: Vec<u8>) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_from_array(address))),
        false,
        false,
        Box::leak(Box::new(1_000_000_000)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(Pubkey::new_from_array(owner))),
        false,
    )
}

fn public_signature() -> [u8; 48] {
    decode::<48>(FIXTURE_SIG_HEX)
}

/// Every caller repeats real signature verification and FO recovery. No key
/// is retained in the fixture, compared in a Debug assertion, printed or saved.
fn synthetic(plain: &wseal::WidePlain) -> ([u8; 32], [u8; wseal::WIDE_SEAL_LEN]) {
    use crate::crypto::seal::tests::{cases, get};
    let vectors = include_bytes!("../../../permutation-rules/vectors/seal-vectors-v1.json");
    assert_eq!(
        xmd::sha256(&[vectors]),
        decode::<32>("9b93a9fb89e4c254942a78037210228ec91642f311b55cfefa076e5b9e294887")
    );
    let case = cases()
        .into_iter()
        .find(|c| get(c, "name") == "valid_spv2_32551361")
        .unwrap();
    assert_eq!(get(&case, "round").parse::<u64>().unwrap(), FIXTURE_ROUND);
    assert!(get(&case, "open_sig") == FIXTURE_SIG_HEX);
    assert!(quick::PK == quick::QUICKNET_PK);
    let hints = decode::<{ 2 * quick::HINT_LEN }>(FIXTURE_HINTS_HEX);
    let verified = quick::verify(FIXTURE_ROUND, &public_signature(), &hints).unwrap();
    let legacy = decode::<{ cseal::SEAL_LEN }>(get(&case, "seal"));
    let ibe: [u8; cseal::IBE_LEN] = legacy[..cseal::IBE_LEN].try_into().unwrap();
    let recovered = cseal::recover_key(&verified, &ibe).unwrap();
    let salt = ks::salt_of(&recovered);
    assert_eq!(salt, decode::<32>(get(&case, "salt")));
    let packed = wseal::pack(plain);
    let seal = wseal::assemble(&ibe, &wseal::body_xor(&recovered, &packed));
    (wseal::commit(&packed, &salt), seal)
}

struct Fixture {
    a: Vec<AccountInfo<'static>>,
    anchor: AccountInfo<'static>,
    plain: wseal::WidePlain,
    commit: [u8; 32],
    seal: [u8; wseal::WIDE_SEAL_LEN],
    settle_at: i64,
}

impl Fixture {
    fn ctx(&self) -> AddrCtx {
        addr::ctx(&key(&self.a[0]), &PROGRAM)
    }
    fn run(&self) -> R<PendingVerifiedResolvedReturn> {
        stage(
            &Pubkey::new_from_array(PROGRAM),
            &self.a,
            &self.anchor,
            SLOT,
            &self.commit,
            &self.seal,
        )
    }
    fn snapshot(&self) -> Vec<([u8; 32], Pubkey, u64, Vec<u8>)> {
        self.a
            .iter()
            .chain(core::iter::once(&self.anchor))
            .map(|ai| {
                (
                    key(ai),
                    *ai.owner,
                    ai.lamports(),
                    ai.try_borrow_data().unwrap().to_vec(),
                )
            })
            .collect()
    }
    fn refused(&self, expected: Option<crate::Error>) {
        let before = self.snapshot();
        let error = self.run().err().expect("this input must be refused");
        if let Some(expected) = expected {
            assert_eq!(error, expected);
        }
        assert_eq!(self.snapshot(), before, "refusal has no account effects");
    }
    /// Test-only corrupt prior state: bind the supplied bytes to BOTH actual
    /// stored roots so bad-seal tests reach the real opener, not root refusal.
    fn rebind_root(&self) {
        let root = cseal::wide_seal_root_of(&self.commit, &self.seal);
        Rw(&mut self.a[1].try_borrow_mut_data().unwrap())
            .set_arr(H::transit(SLOT as usize) + T::SEAL_ROOT, &root)
            .unwrap();
        let mut ed = self.a[2].try_borrow_mut_data().unwrap();
        let mut transit = OwnedBridgeTransit::from_bytes(&self.ctx(), &ed)
            .unwrap()
            .transit();
        transit.seal_root = root;
        // The strict owned envelope embeds the existing 288-byte transit at16.
        ed[16..16 + wm::WIDE_TRANSIT_LEN].copy_from_slice(&transit.to_bytes());
    }
    fn replace_plain(&mut self, plain: wseal::WidePlain) {
        (self.commit, self.seal) = synthetic(&plain);
        self.rebind_root();
    }
}

fn fixture() -> Fixture {
    let p = Pubkey::new_from_array(PROGRAM);
    let bump =
        Pubkey::find_program_address(&[addr::SEASON_PREFIX, &addr::season_seed_id(SID)], &p).1;
    let sk = addr::season_pda(SID, bump, &PROGRAM);
    let ctx = addr::ctx(&sk, &PROGRAM);
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = resolver
        .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 2, 1, 0).unwrap())
        .unwrap();
    // A geometrically valid two-step original ring128 -> wide ring129 route.
    // Its historical Reveal/Gather/Resolve producers are NOT executed here.
    let (origin, target) = (0..61)
        .find_map(|local| {
            let border = WideTile::of(TileAddress::new(host.key(), local).unwrap());
            let next = border.neighbors()[0]?;
            let prev = border.neighbors()[3]?;
            (next.province_coord().ring() > 128 && prev.province() == host.key())
                .then_some((prev.address(), next.address()))
        })
        .unwrap();
    let plain = wseal::WidePlain {
        version: wseal::WIDE_PLAIN_VERSION,
        host,
        arrive_bell: ARRIVE,
        dest: target.key(),
        dest_tile: target.local(),
        stance: 0,
        retreat_bps: 0,
        path_len: 2,
        path: [0; ks::PATH_BYTES],
        reserved: [0; wseal::WIDE_RESERVED_BYTES],
    };
    let (commit, seal) = synthetic(&plain);
    let round_ts = beacon::round_time(beacon::QUICKNET.genesis, 3, FIXTURE_ROUND);
    let genesis = round_ts - (ARRIVE as i64 + 1) * 600;
    let landed = round_ts + 7;
    let mut sd = vec![0; K2::Season.size()];
    assert!(write_header(&mut sd, K2::Season, SID));
    let mut w = Rw(&mut sd);
    w.set_u8(S::STATUS, S::STATUS_RUNNING).unwrap();
    w.set_u8(S::BUMP, bump).unwrap();
    w.set_arr(S::RULESET_HASH, &RULESET_HASH).unwrap();
    w.set_u16(S::PROGRAM_VERSION, crate::PROGRAM_VERSION)
        .unwrap();
    w.set_i64(S::GENESIS_TS, genesis).unwrap();
    w.set_u32(S::END_BELL, 1000).unwrap();
    w.set_i64(S::DRAND_GENESIS, beacon::QUICKNET.genesis)
        .unwrap();
    w.set_u32(S::DRAND_PERIOD, 3).unwrap();
    w.set_u32(S::REVEAL_WINDOW, 600).unwrap();
    w.set_u32(S::WINDOW_NEXT, 1200).unwrap();
    w.set_u32(S::WINDOW_FROM_BELL, u32::MAX).unwrap();
    w.set_u32(S::SEED_MARGIN, 60).unwrap();
    w.set_u64(S::MARCH_FEE, 10).unwrap();
    w.set_u64(S::SEAL_BOND, 20).unwrap();
    let clock = SeasonClock::read(&sd).unwrap();
    assert_eq!(clock.tlock_round(ARRIVE), FIXTURE_ROUND);
    assert_eq!(clock.round_time(FIXTURE_ROUND), round_ts);
    assert!(clock.round_time(FIXTURE_ROUND - 1) < beacon::bell_end(genesis, ARRIVE));
    let settle_at =
        clock.reveal_close(ARRIVE, landed) + crate::proc::transit::SETTLE_AFTER_CLOSE_SECS;
    prologue::set_test_clock(settle_at, 90);
    let departed = OwnedBridgeTransit::new(
        &ctx,
        SLOT,
        WideTransit::depart(
            wm::HOST_IDENTITY_FULL_REF_V1,
            host,
            1,
            2,
            origin,
            10,
            ARRIVE,
            genesis + 6000,
            100_000,
            crate::proc::host::DEPART_STAMINA,
            250,
            cseal::wide_seal_root_of(&commit, &seal),
            0,
            0,
            RENT_TO,
        )
        .unwrap(),
        OWNER,
    )
    .unwrap();
    let marker = BridgeMarker::new(
        &ctx,
        departed.common(),
        7,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .unwrap();
    let arrival = ExpeditionArrivalSlot::new(
        &ctx,
        WideArrivalSlot {
            season_id: SID,
            dest: plain.dest,
            bell: ARRIVE,
            faction: 2,
            i: 0,
            transit_slot: SLOT,
            host,
            citizen: OWNER,
            unit: 1,
            stance: plain.stance,
            tile: plain.dest_tile,
            retreat_bps: plain.retreat_bps,
            dealt_bps: 250,
            dep_mass: 100_000,
            flags: 0,
            beneficiary: [36; 32],
            rent_to: RENT_TO,
            ev_slot: 1,
            ev_price: 0,
            ev_limit: 0,
            ev_loaded: 0,
            claimed: false,
        },
        100,
    )
    .unwrap();
    let bridge = departed
        .settle_origin(&ctx, false, Some((80_000, 40, 0)))
        .unwrap()
        .gather_worn(&ctx, &arrival)
        .unwrap();
    let t = bridge.transit();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let mut w = Rw(&mut hd);
    w.set_i16(H::P, 128).unwrap();
    w.set_u8(H::SITE, 2).unwrap();
    w.set_u8(H::GEN, 1).unwrap();
    w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
    w.set_u8(H::ORDER, 1).unwrap();
    w.set_u8(H::FACTION, 2).unwrap();
    w.set_u8(H::TILE, origin.local()).unwrap();
    w.set_arr(H::OWNER_CITIZEN, &OWNER).unwrap();
    w.set_arr(H::RENT_PAYER, &RENT_TO).unwrap();
    w.set_u32(H::HOST_SEQ, 1).unwrap();
    w.set_u64(H::ESCROW, 37).unwrap();
    hd[H::transit(SLOT as usize)..H::transit(SLOT as usize) + MARKER_LEN]
        .copy_from_slice(&marker.to_bytes());
    let mut home = vec![0; K2::Province.size()];
    assert!(write_header(&mut home, K2::Province, SID));
    let mut w = Rw(&mut home);
    w.set_i16(PV::P, 128).unwrap();
    w.set_u16(PV::RING, 128).unwrap();
    w.set_u32(PV::RESOLVED_NEXT, 13).unwrap();
    w.set_u32(PV2::SCORE_NEXT_BELL, 13).unwrap();
    w.set_u8(PV::SITE_COUNT, 3).unwrap();
    w.set_u8(PV::N_SITES_USED, 1).unwrap();
    w.set_u8(PV::SITES, (origin.local() + 1) % 61).unwrap();
    w.set_u8(PV::SITES + 1, (origin.local() + 2) % 61).unwrap();
    w.set_u8(PV::SITES + 2, origin.local()).unwrap();
    for i in 0..PV::SITES_N {
        let o = PV::site(i);
        w.set_u8(o + SM::FACTION, permutation_rules::frontier::clash::NEUTRAL)
            .unwrap();
        w.set_u32(o + SM::PEND0_BELL, SM::NO_BELL).unwrap();
        w.set_u32(o + SM::PEND1_BELL, SM::NO_BELL).unwrap();
    }
    let o = PV::site(2);
    w.set_u8(o + SM::STATE, SM::STATE_HOLDING).unwrap();
    w.set_u8(o + SM::FACTION, 2).unwrap();
    w.set_u8(o + SM::GEN, 1).unwrap();
    w.set_u8(o + SM::ORDER, 1).unwrap();
    let mut dest = vec![0; wl::province::SIZE];
    WideProvince {
        season_id: SID,
        world: plain.dest.world(),
        coord: plain.dest.coord(),
        wedge: plain.dest.coord().wedge().unwrap(),
        region: 0,
        opened_bell: 0,
        readiness: wl::readiness::REQUIRED,
        seed_round: 0,
        ring_seed: [44; 32],
        funded_lamports: 0,
    }
    .write_identity(&mut dest)
    .unwrap();
    Rw(&mut dest).set_u32(PV::RESOLVED_NEXT, 13).unwrap();
    Rw(&mut dest).set_u32(PV2::SCORE_NEXT_BELL, 13).unwrap();
    for i in 0..PV::SITES_N {
        Rw(&mut dest)
            .set_u32(PV::site(i) + SM::PEND0_BELL, SM::NO_BELL)
            .unwrap();
        Rw(&mut dest)
            .set_u32(PV::site(i) + SM::PEND1_BELL, SM::NO_BELL)
            .unwrap();
    }
    let mut inputs = vec![0; wa::wide_clash_inputs::SIZE];
    let mut ih = WideClashInputsHdr::new(SID, plain.dest, ARRIVE, [31; 32]);
    ih.flags = wa::wide_clash_inputs::FLAG_RESOLVED;
    ih.n_present = 1;
    ih.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    ih.resolver = [35; 32];
    // Resolve stores seconds since Season genesis, unlike absolute anchor A.
    ih.resolved_ts = clock
        .reveal_close(ARRIVE, landed)
        .checked_sub(clock.genesis_ts)
        .and_then(|seconds| u32::try_from(seconds).ok())
        .unwrap();
    ih.write(&mut inputs).unwrap();
    WideArrival {
        host,
        citizen: OWNER,
        dep_mass: t.dep_mass,
        troops: t.troops_after,
        stamina: frontier_abi::clash_model::arrival_stamina(t.stamina_after, t.depart_bell, ARRIVE),
        retreat_bps: plain.retreat_bps,
        dealt_bps: 250,
        faction: 2,
        unit: 1,
        tile: plain.dest_tile,
        stance: plain.stance,
        present: true,
        fate: wa::wide_arrival::FATE_BOUNCED,
        troops_after: 12_345,
    }
    .write_at(&mut inputs, POSITION)
    .unwrap();
    // This is a fixture snapshot, not a PostAnchor writer execution. The
    // signature was genuinely verified by synthetic(), and round/time exactly
    // match the Season clock, but account creation provenance is untested.
    let mut ad = vec![0; BA::SIZE];
    crate::layout::init_header(&mut ad, AccountKind::BellAnchor, SID).unwrap();
    let mut w = Rw(&mut ad);
    w.set_u32(BA::BELL, ARRIVE).unwrap();
    w.set_u8(BA::REGION, 0).unwrap();
    w.set_u8(BA::NET, quick::NET_QUICKNET).unwrap();
    w.set_u64(BA::ROUND, FIXTURE_ROUND).unwrap();
    w.set_i64(BA::A, landed).unwrap();
    w.set_u64(BA::SLOT, 77).unwrap();
    w.set_arr(BA::SIG48, &public_signature()).unwrap();
    w.set_arr(BA::RENT_TO, &RENT_TO).unwrap();
    let holding = resolver.holding_address(&host).unwrap();
    Fixture {
        a: vec![
            account(sk, PROGRAM, sd),
            account(holding, PROGRAM, hd),
            account(
                wm::transit_address(&ctx, &holding, SLOT),
                PROGRAM,
                bridge.to_bytes().to_vec(),
            ),
            account(ctx.province(128, 0), PROGRAM, home),
            account(
                resolver.province_address(plain.dest).unwrap(),
                PROGRAM,
                dest,
            ),
            account(
                wa::clash_inputs_address(&ctx, plain.dest, ARRIVE),
                PROGRAM,
                inputs,
            ),
            account(
                wa::arrival_slot_address(&ctx, plain.dest, ARRIVE, 2, 0),
                PROGRAM,
                arrival.to_bytes(&ctx).unwrap().to_vec(),
            ),
            account(RENT_TO, [0; 32], vec![]),
        ],
        anchor: account(ctx.bell_anchor(ARRIVE, 0), PROGRAM, ad),
        plain,
        commit,
        seal,
        settle_at,
    }
}

#[test]
fn public_proof_binds_original_return_without_effects() {
    let f = fixture();
    let before = f.snapshot();
    let preview = f.run().unwrap();
    assert_eq!(preview.plain, f.plain);
    assert_eq!(preview.anchor.sig48, public_signature());
    assert_eq!(preview.anchor.anchor_slot, Some(77));
    assert_eq!(preview.settle_at, f.settle_at);
    assert_eq!(preview.pending.payments_if_valid.total, 37);
    assert_eq!(preview.pending.credited_milli, 12_345);
    let entry = frontier_abi::entry::read_entry(preview.pending.home.as_ref().unwrap(), 0).unwrap();
    assert_eq!(
        entry.id,
        frontier_abi::addr::host_id(128, 0, 2, 1, 0).unwrap()
    );
    assert_eq!(entry.state, E::STATE_MUSTER_PENDING);
    assert_eq!(preview.pending.arrival_position, POSITION);
    assert_eq!(f.snapshot(), before);
}

#[test]
fn settlement_grace_and_schedule_are_exact() {
    let f = fixture();
    prologue::set_test_clock(f.settle_at - 1, 90);
    f.refused(Some(FrontierError::TooEarly.into()));
    prologue::set_test_clock(f.settle_at, 90);
    assert!(f.run().is_ok());
    Rw(&mut f.a[0].try_borrow_mut_data().unwrap())
        .set_u32(S::WINDOW_FROM_BELL, ARRIVE)
        .unwrap();
    f.refused(Some(FrontierError::TooEarly.into()));
    prologue::set_test_clock(f.settle_at + 600, 90);
    assert_eq!(f.run().unwrap().settle_at, f.settle_at + 600);
    Rw(&mut f.a[4].try_borrow_mut_data().unwrap())
        .set_u32(PV::RESOLVED_NEXT, ARRIVE)
        .unwrap();
    f.refused(Some(FrontierError::TooEarly.into()));
}

#[test]
fn canonical_archive_snapshot_uses_same_signature_and_time() {
    let mut f = fixture();
    let original = f.run().unwrap();
    let clock = SeasonClock::read(&f.a[0].try_borrow_data().unwrap()).unwrap();
    let mut ad = vec![0; AA::SIZE];
    crate::layout::init_header(&mut ad, AccountKind::AnchorArchive, SID).unwrap();
    let mut w = Rw(&mut ad);
    w.set_u8(AA::REGION, 0).unwrap();
    w.set_u32(AA::PART, archive_part_of(ARRIVE)).unwrap();
    for field in [AA::ARCHIVED, AA::TOMBSTONE] {
        let (o, bit) = AA::bit(field, ARRIVE);
        w.set_u8(o, bit).unwrap();
    }
    let off = AA::entry(ARRIVE);
    w.set_u32(
        off + AE::A_OFF,
        crate::proc::beacon::a_off_of(original.anchor.a, clock.genesis_ts, ARRIVE).unwrap(),
    )
    .unwrap();
    w.set_arr(off + AE::SIG, &public_signature()).unwrap();
    // The unused seed remains a literal zero fixture, not a proven PostSeed.
    f.anchor = account(
        f.ctx().anchor_archive(0, archive_part_of(ARRIVE)),
        PROGRAM,
        ad,
    );
    let before = f.snapshot();
    let preview = f.run().unwrap();
    assert_eq!(preview.anchor.anchor_slot, None);
    assert_eq!(preview.settle_at, original.settle_at);
    assert_eq!(preview.pending.holding, original.pending.holding);
    assert_eq!(preview.pending.home, original.pending.home);
    assert_eq!(f.snapshot(), before);
    let (o, _) = AA::bit(AA::ARCHIVED, ARRIVE);
    Rw(&mut f.anchor.try_borrow_mut_data().unwrap())
        .set_u8(o, 0)
        .unwrap();
    f.refused(Some(FrontierError::NoAnchor.into()));
}

#[test]
fn anchor_identity_owner_absence_and_bad_point_refuse() {
    let mut f = fixture();
    let valid = f.anchor.clone();
    f.anchor = account(
        f.ctx().bell_anchor(ARRIVE, 1),
        PROGRAM,
        valid.try_borrow_data().unwrap().to_vec(),
    );
    f.refused(Some(FrontierError::BadAddress.into()));
    f.anchor = account(
        key(&valid),
        [99; 32],
        valid.try_borrow_data().unwrap().to_vec(),
    );
    f.refused(Some(BAD_ACCOUNT));
    f.anchor = account(key(&valid), [0; 32], vec![]);
    f.refused(Some(FrontierError::NoAnchor.into()));
    f.anchor = valid;
    Rw(&mut f.anchor.try_borrow_mut_data().unwrap())
        .set_u32(BA::BELL, ARRIVE + 1)
        .unwrap();
    f.refused(Some(BAD_ACCOUNT));
    Rw(&mut f.anchor.try_borrow_mut_data().unwrap())
        .set_u32(BA::BELL, ARRIVE)
        .unwrap();
    Rw(&mut f.anchor.try_borrow_mut_data().unwrap())
        .set_arr(BA::SIG48, &[0; 48])
        .unwrap();
    f.refused(Some(crypto(crate::error::crypto_sub::BAD_POINT)));
}

#[test]
fn changed_ciphertext_and_commitment_require_stored_root() {
    let mut f = fixture();
    f.seal[wseal::WIDE_SEAL_LEN - 1] ^= 1;
    f.refused(Some(FrontierError::CommitMismatch.into()));
    f.seal[wseal::WIDE_SEAL_LEN - 1] ^= 1;
    f.commit[0] ^= 1;
    f.refused(Some(FrontierError::CommitMismatch.into()));
}

#[test]
fn real_bad_seal_verdicts_are_unsupported_without_forfeiture() {
    let mut f = fixture();
    let valid = f.seal;
    f.seal[..96].fill(0); // the seal's invalid point, not an anchor error
    f.rebind_root();
    f.refused(Some(FrontierError::NotImplemented.into()));
    f.seal = valid;
    f.seal[cseal::IBE_LEN] ^= 1; // valid IBE, bad wide commitment
    f.rebind_root();
    f.refused(Some(FrontierError::NotImplemented.into()));
}

#[test]
fn committed_host_arrival_and_destination_cannot_be_substituted() {
    let mut f = fixture();
    let mut plain = f.plain;
    plain.host = WideHostRef::new(plain.host.key(), 2, 1, 1).unwrap();
    f.replace_plain(plain);
    f.refused(Some(FrontierError::NotImplemented.into()));
    plain = f.plain;
    plain.arrive_bell += 1;
    f.replace_plain(plain);
    f.refused(Some(FrontierError::NotImplemented.into()));
    plain = f.plain;
    plain.dest = ProvinceKey::new(plain.dest.world(), WideCoord::checked(140, 0).unwrap());
    f.replace_plain(plain);
    f.refused(Some(FrontierError::BadAddress.into()));
}

#[test]
fn final_set_nonmember_duplicate_and_replay_are_not_settled() {
    let f = fixture();
    let original = f.a[5].try_borrow_data().unwrap().to_vec();
    let mut rec = WideArrival::read_at(&original, POSITION).unwrap().unwrap();
    rec.host = WideHostRef::new(rec.host.key(), 2, 1, 1).unwrap();
    rec.write_at(&mut f.a[5].try_borrow_mut_data().unwrap(), POSITION)
        .unwrap();
    f.refused(Some(BAD_ACCOUNT));
    f.a[5]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&original);
    let rec = WideArrival::read_at(&original, POSITION).unwrap().unwrap();
    rec.write_at(&mut f.a[5].try_borrow_mut_data().unwrap(), POSITION + 1)
        .unwrap();
    f.refused(Some(BAD_ACCOUNT));
    f.a[5]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&original);
    let held_preview = f.run().unwrap();
    let mut ih = WideClashInputsHdr::read(&original).unwrap();
    ih.settled_mask |= 1 << POSITION;
    ih.write(&mut f.a[5].try_borrow_mut_data().unwrap())
        .unwrap();
    f.refused(Some(FrontierError::AlreadyDone.into()));
    // A retained preview remains inert, and no effects API accepts it. Fresh
    // proof/staging re-reads the settled bit and refuses instead of reusing it.
    assert_eq!(held_preview.pending.arrival_position, POSITION);
}

#[test]
fn full_original_owner_and_retained_slot_remain_bound() {
    let f = fixture();
    let original = f.a[5].try_borrow_data().unwrap().to_vec();
    let mut rec = WideArrival::read_at(&original, POSITION).unwrap().unwrap();
    rec.citizen = [99; 32];
    rec.write_at(&mut f.a[5].try_borrow_mut_data().unwrap(), POSITION)
        .unwrap();
    Rw(&mut f.a[1].try_borrow_mut_data().unwrap())
        .set_arr(H::OWNER_CITIZEN, &[99; 32])
        .unwrap();
    f.refused(Some(BAD_ACCOUNT));
    Rw(&mut f.a[1].try_borrow_mut_data().unwrap())
        .set_arr(H::OWNER_CITIZEN, &OWNER)
        .unwrap();
    f.a[5]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&original);
    let mut sd = f.a[6].try_borrow_mut_data().unwrap();
    let slot = ExpeditionArrivalSlot::read(&f.ctx(), &sd).unwrap();
    let mut common = *slot.common();
    common.citizen = [99; 32];
    sd.copy_from_slice(
        &ExpeditionArrivalSlot::new(&f.ctx(), common, slot.worn_bps())
            .unwrap()
            .to_bytes(&f.ctx())
            .unwrap(),
    );
    drop(sd);
    f.refused(Some(BAD_ACCOUNT));
}

#[test]
fn recorded_fates_determine_preview_and_missing_slot_is_supported() {
    let mut f = fixture();
    for fate in [
        wa::wide_arrival::FATE_STAYS,
        wa::wide_arrival::FATE_WITHDREW,
        wa::wide_arrival::FATE_RETREATED,
        wa::wide_arrival::FATE_BOUNCED,
        wa::wide_arrival::FATE_DESTROYED,
    ] {
        let mut cd = f.a[5].try_borrow_mut_data().unwrap();
        let mut rec = WideArrival::read_at(&cd, POSITION).unwrap().unwrap();
        rec.fate = fate;
        rec.troops_after = if fate == wa::wide_arrival::FATE_DESTROYED {
            0
        } else {
            12_345
        };
        rec.write_at(&mut cd, POSITION).unwrap();
        drop(cd);
        let before = f.snapshot();
        let preview = f.run().unwrap();
        let returns = matches!(
            fate,
            wa::wide_arrival::FATE_RETREATED | wa::wide_arrival::FATE_BOUNCED
        );
        assert_eq!(preview.pending.home.is_some(), returns);
        assert_eq!(
            preview.pending.credited_milli,
            if returns { 12_345 } else { 0 }
        );
        assert_eq!(f.snapshot(), before);
    }
    f.a[6] = account(key(&f.a[6]), [0; 32], vec![]);
    let preview = f.run().unwrap();
    assert!(preview.pending.retained_slot.is_none());
}

#[test]
fn captured_original_proof_credits_only_live_previous_home() {
    let mut f = fixture();
    let ctx = f.ctx();
    let previous = frontier_abi::addr::host_id(127, 0, 0, 3, 0).unwrap();
    {
        let mut hd = f.a[1].try_borrow_mut_data().unwrap();
        let off = H::transit(SLOT as usize);
        let marker = BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).unwrap();
        // Snapshot of the existing capture ledger transition, not a payment.
        let capture = marker.capture_bond_plan(37, 20).unwrap();
        hd[off..off + MARKER_LEN].copy_from_slice(&capture.marker_after.to_bytes());
        let mut w = Rw(&mut hd);
        w.set_u64(H::ESCROW, capture.escrow_after).unwrap();
        w.set_u8(H::GEN, 2).unwrap();
        w.set_u8(H2::PREV_GEN, 1).unwrap();
        w.set_u8(H2::CAPTURE_FLAGS, H2::CAPTURE_FLAG_CAPTURED)
            .unwrap();
        w.set_u64(H2::PREV_OWNER_TAG, frontier_abi::addr::citizen_tag(&OWNER))
            .unwrap();
        w.set_u64(H2::PREV_HOME, previous).unwrap();
        w.set_arr(H::OWNER_CITIZEN, &[99; 32]).unwrap();
        w.set_u32(H::HOST_SEQ, 0).unwrap();
    }
    Rw(&mut f.a[3].try_borrow_mut_data().unwrap())
        .set_u8(PV::site(2) + SM::GEN, 2)
        .unwrap();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    Rw(&mut hd).set_i16(H::P, 127).unwrap();
    Rw(&mut hd).set_u8(H::GEN, 3).unwrap();
    Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL).unwrap();
    f.a.push(account(ctx.holding(127, 0, 0), PROGRAM, hd));
    let before = f.snapshot();
    let preview = f.run().unwrap();
    assert!(preview.pending.home.is_none());
    assert_eq!(preview.pending.payments_if_valid.total, 17);
    assert_eq!(preview.pending.payments_if_valid.bond.0, 0);
    assert_eq!(preview.pending.credited_milli, 12_000);
    assert_eq!(
        Ro(preview.pending.previous_home.as_ref().unwrap())
            .u32(H::reserve(1))
            .unwrap(),
        12
    );
    assert_eq!(Ro(&preview.pending.holding).u32(H::reserve(1)).unwrap(), 0);
    assert_eq!(f.snapshot(), before);
    // A captured/reused PREV_HOME must not credit its new generation.
    Rw(&mut f.a[8].try_borrow_mut_data().unwrap())
        .set_u8(H::GEN, 4)
        .unwrap();
    assert_eq!(f.run().unwrap().pending.credited_milli, 0);
    f.a.pop();
    f.refused(Some(BAD_ACCOUNT));
}

#[test]
fn stale_marker_and_settled_slot_refuse_but_claimed_slot_is_independent() {
    let f = fixture();
    let _inert_preview = f.run().unwrap();
    let original = f.a[1].try_borrow_data().unwrap().to_vec();
    let off = H::transit(SLOT as usize);
    f.a[1].try_borrow_mut_data().unwrap()[off..off + MARKER_LEN].fill(0);
    f.refused(Some(BAD_ACCOUNT));
    f.a[1]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&original);
    let ctx = f.ctx();
    let slot = ExpeditionArrivalSlot::read(&ctx, &f.a[6].try_borrow_data().unwrap()).unwrap();
    let claimed = slot.with_claimed(true);
    f.a[6]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&claimed.to_bytes(&ctx).unwrap());
    assert!(
        f.run()
            .unwrap()
            .pending
            .retained_slot
            .unwrap()
            .common()
            .claimed
    );
    f.a[6]
        .try_borrow_mut_data()
        .unwrap()
        .copy_from_slice(&claimed.with_settled().to_bytes(&ctx).unwrap());
    f.refused(Some(BAD_ACCOUNT));
    // Existing v1 must not be implicitly upgraded to an original-owned slot.
    slot.common()
        .write(&mut f.a[6].try_borrow_mut_data().unwrap())
        .unwrap();
    f.refused(Some(BAD_ACCOUNT));
}
