//! Citizens and land (W3-A, M1 contract §5.6, §5.9, I-29, I-40, I-47,
//! I-49, I-51): Join, SetSession, SetVigil, FileTicket, SettleTicket,
//! ReleaseDormant, CloseHolding, CloseCitizen. Functional and cohort tests
//! (`citizen_…`), G1 (`g01_join`, `g01_file_ticket`, `g01_settle_ticket`),
//! G2 (`g02_…`), G3 (`g03_…`). Seasons run on the test-beacon build (any
//! round, I-53) unless the test says otherwise.
//!
//! Crafted state (named where used): the Season's status byte for
//! Ended/Aborted (W4-B's instructions), a Season's ruleset hash
//! (`RulesetMismatch`), the Frontier's folded counters (`Capacity`), a
//! Holding's transit record and `pool_owed` (Depart and SettleTransit are
//! W3-B's and W4-B's), and on the trace build an anchor and a seed cache.

mod common;

use common::{assert_program_account, copy_to_fresh, paid, prefunds};
use fclient::ix::{Displaced, Player, SeedSource, Site};
use frontier_abi::layout::player::{citizen as C, holding as H, holding_ref as HR, transit as T};
use frontier_abi::layout::province::{cohort as CO, province as PV, site as SM};
use frontier_abi::layout::world::{
    defence_pool as DP, frontier as FR, join_shard as JS, season as S,
};
use frontier_abi::log::{settle_outcome, EntityKind, Kind};
use frontier_abi::prologue::{cohort_closed, finality_due, HoldingHdr};
use frontier_abi::tags::Ix;
use permutation_frontier_svm_tests::budget::{assert_within, ceilings, Need};
use permutation_frontier_svm_tests::chain::{
    assert_code, expect_lands, loaded_limit, with_account, without_signer, Build, Chain, Profile,
};
use permutation_frontier_svm_tests::ix::citizen::{self as cix, player_at, settle_at};
use permutation_frontier_svm_tests::records::one;
use permutation_frontier_svm_tests::wallets;
use permutation_frontier_svm_tests::world::land::{
    provinces_of, rd_i64, rd_u16, rd_u32, rd_u64, region, ChainTrack, Citizen,
};
use permutation_frontier_svm_tests::world::{params_for, World};
use permutation_frontier_svm_tests::{keypair, Address, FrontierError as E, Keypair, Signer};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::holding::{Holding, Tier};
use permutation_rules::frontier::siege;

/// A running season with the genesis rings open and ring 2 of wedge 0.
fn land() -> (Chain, World, Vec<(i16, i16)>) {
    let mut c = Chain::test_beacon();
    let (w, v) = World::land(&mut c, 1, 0);
    (c, w, v)
}

fn site(p: (i16, i16), s: u8) -> Site {
    Site {
        p: p.0,
        q: p.1,
        site: s,
    }
}

fn hdr_of(d: &[u8]) -> HoldingHdr {
    HoldingHdr {
        p: rd_u16(d, H::P) as i16,
        q: rd_u16(d, H::Q) as i16,
        site: d[H::SITE],
        gen: d[H::GEN],
        state: d[H::STATE],
        ticket_bell: rd_u32(d, H::TICKET_BELL),
        final_ts: rd_i64(d, H::FINAL_TS),
    }
}

fn shard_of(w: &World, c: &Chain, who: &Citizen) -> Address {
    let d = w.citizen_data(c, who);
    w.a.join_shard(d[C::FACTION], d[C::JOIN_SHARD])
}

fn holdings(c: &Chain, shard: &Address) -> (u32, u32) {
    let d = c.data(shard);
    (rd_u32(&d, JS::HOLDINGS), rd_u32(&d, JS::HOLDINGS_BY_WEDGE))
}

/// Files `who`'s ticket and lands it.
fn file(w: &World, c: &mut Chain, who: &Citizen, sites: &[Site]) {
    expect_lands(w.file_ticket(c, who, sites), "FileTicket");
}

/// The cohort record `(filed, settled)` of `bell` in a Province.
fn cohort(c: &Chain, w: &World, p: (i16, i16), bell: u32) -> Option<(u16, u16)> {
    let d = c.data(&w.a.province(p.0 as i32, p.1 as i32));
    (0..PV::COHORTS_N).find_map(|i| {
        let o = PV::cohort(i);
        (rd_u32(&d, o + CO::BELL) == bell && rd_u16(&d, o + CO::FILED) > 0)
            .then(|| (rd_u16(&d, o + CO::FILED), rd_u16(&d, o + CO::SETTLED)))
    })
}

// ------------------------------------------------------------ Join, sessions, vigils

#[test]
fn citizen_join_creates_the_citizen() {
    let (mut c, w, _) = land();
    let who = c.funded(b"joiner", 10);
    let ck = w.a.citizen(&who.pubkey());
    let shard_i = fclient::addr::join_shard_of(&who.pubkey().to_bytes());
    let jk = w.a.join_shard(2, shard_i);
    let members = rd_u32(&c.data(&jk), JS::MEMBERS);
    let cw = ChainTrack::new(&c, ck, EntityKind::Citizen);
    let jw = ChainTrack::new(&c, jk, EntityKind::JoinShard);
    // Refusals first: faction 6, a session beyond 30 days, a wrong shard.
    let bad = cix::join(
        &w.a,
        who.pubkey(),
        who.pubkey(),
        6,
        &Address::default(),
        0,
        None,
    );
    assert_code(c.send(&[bad], &[&who]), E::BadData);
    let far = c.now + 30 * 86_400 + 1;
    let bad = cix::join(
        &w.a,
        who.pubkey(),
        who.pubkey(),
        2,
        &who.pubkey(),
        far,
        None,
    );
    assert_code(c.send(&[bad], &[&who]), E::BadData);
    let ix = w.join_ix(&who, 2);
    let other = w.a.join_shard(2, (shard_i + 1) % 8);
    assert_code(
        c.send(&[with_account(ix.clone(), 5, other)], &[&who]),
        E::BadAddress,
    );
    let fake = copy_to_fresh(&mut c, &w.a.citizen(&keypair(b"x").pubkey()), b"cit");
    assert_code(
        c.send(&[with_account(ix.clone(), 4, fake)], &[&who]),
        E::BadAddress,
    );
    let before = c.lamports(&who.pubkey());
    let l = expect_lands(c.send(std::slice::from_ref(&ix), &[&who]), "Join");
    assert_eq!(
        paid(before, &c, &who, &l),
        c.rent(C::SIZE),
        "the payer funds the Citizen"
    );
    cw.check(&c, &l.logs, 1);
    jw.check(&c, &l.logs, 1);
    assert_program_account(&c, &ck, C::MAGIC, C::SIZE, 1);
    let d = c.data(&ck);
    assert_eq!(&d[C::WALLET..C::WALLET + 32], who.pubkey().as_ref());
    assert_eq!(d[C::FACTION], 2);
    assert_eq!(d[C::FLAGS], C::FLAG_JOINED);
    assert_eq!(d[C::EXPLORES_FLOOR_LEFT], 3);
    assert_eq!(d[C::JOIN_SHARD], shard_i);
    assert_eq!(rd_u32(&d, C::TICKET_BELL), C::NO_TICKET);
    assert_eq!(rd_u32(&d, C::BUCKET_MILLI), 60_000, "bucket full");
    assert_eq!(
        rd_u64(&d, C::CITIZEN_TAG),
        fclient::addr::citizen_tag_u64(&ck)
    );
    assert_eq!(&d[C::RENT_PAYER..C::RENT_PAYER + 32], who.pubkey().as_ref());
    assert_eq!(rd_u32(&c.data(&jk), JS::MEMBERS), members + 1);
    let r = one(&l.logs, Kind::JOIN);
    assert_eq!(r.field("wallet", true), who.pubkey().as_ref());
    assert_eq!(r.u64("shard"), shard_i as u64);
    // A second Join is an idempotent repeat.
    assert_code(c.send(&[ix], &[&who]), E::AlreadyDone);
    // No join gate in this season: an eighth account is refused.
    let late = c.funded(b"late", 10);
    let gated = cix::join(
        &w.a,
        late.pubkey(),
        late.pubkey(),
        1,
        &Address::default(),
        0,
        Some(late.pubkey()),
    );
    assert_code(c.send(&[gated], &[&late]), E::TooManyAccounts);
    // Capacity (crafted folded Frontier: every site occupied, no ring left).
    let mut f = c.fork();
    f.edit(&w.a.frontier(), |d| {
        d[FR::OPEN_SITES..FR::OPEN_SITES + 4].copy_from_slice(&100u32.to_le_bytes());
        d[FR::OCCUPIED_SITES..FR::OCCUPIED_SITES + 4].copy_from_slice(&100u32.to_le_bytes());
        d[FR::RINGS_OPENED..FR::RINGS_OPENED + 2].copy_from_slice(&17u16.to_le_bytes());
    });
    assert_code(w.join(&mut f, &late, 1), E::Capacity);
    // A forged Frontier.
    let mut f = c.fork();
    f.edit(&w.a.frontier(), |d| d[0] ^= 1);
    assert_code(w.join(&mut f, &late, 1), E::BadAccount);
    // After join_close_bell (756): WrongStatus.
    let mut f = c.fork();
    f.set_time(w.genesis_ts() + 756 * 600);
    assert_code(w.join(&mut f, &late, 1), E::WrongStatus);
    // A ruleset the binary does not enforce (crafted).
    let mut f = c.fork();
    f.edit(&w.a.season, |d| d[S::RULESET_HASH] ^= 1);
    assert_code(w.join(&mut f, &late, 1), E::RulesetMismatch);
}

#[test]
fn citizen_join_gate_needs_the_gate_signature() {
    let mut c = Chain::test_beacon();
    let gate = keypair(b"join-gate");
    let mut p = params_for(&c);
    p.join_gate = gate.pubkey().to_bytes();
    let w = World::running_with(&mut c, 1, p);
    let who = c.funded(b"gated", 10);
    assert_code(w.join(&mut c, &who, 0), E::JoinGate);
    let impostor = keypair(b"not-the-gate");
    let ix = cix::join(
        &w.a,
        who.pubkey(),
        who.pubkey(),
        0,
        &Address::default(),
        0,
        Some(impostor.pubkey()),
    );
    assert_code(c.send(&[ix], &[&who, &impostor]), E::JoinGate);
    let ix = cix::join(
        &w.a,
        who.pubkey(),
        who.pubkey(),
        0,
        &Address::default(),
        0,
        Some(gate.pubkey()),
    );
    expect_lands(
        c.send(&[ix], &[&who, &gate]),
        "Join with the gate's co-signature",
    );
}

#[test]
fn citizen_join_refused_before_genesis() {
    let mut c = Chain::test_beacon();
    let w = World::seeded(&mut c, 1);
    let who = c.funded(b"early", 10);
    assert_code(w.join(&mut c, &who, 0), E::WrongStatus);
}

#[test]
fn citizen_session_and_vigil_through_the_player_prologue() {
    // The long season: a second vigil change is a week after the first.
    let mut c = Chain::test_beacon();
    let (w, _) = World::land_long(&mut c, 1, 0);
    let a = w.citizen(&mut c, "a", 0);
    let session = keypair(b"session-a");
    c.airdrop(&session.pubkey(), 1_000_000_000);
    let ck = w.a.citizen(&a.key());
    let cw = ChainTrack::new(&c, ck, EntityKind::Citizen);
    let exp = c.now + 3_600;
    let ix = cix::set_session(&w.a, &a.player(), &session.pubkey(), exp);
    let l = expect_lands(c.send(&[ix], &[&a.wallet]), "SetSession");
    cw.check(&c, &l.logs, 1);
    let d = c.data(&ck);
    assert_eq!(&d[C::SESSION..C::SESSION + 32], session.pubkey().as_ref());
    assert_eq!(rd_i64(&d, C::SESSION_EXPIRY), exp);
    assert_eq!(one(&l.logs, Kind::SESSION).u64("expiry") as i64, exp);
    let far = c.now + 30 * 86_400 + 1;
    let ix = cix::set_session(&w.a, &a.player(), &session.pubkey(), far);
    assert_code(c.send(&[ix], &[&a.wallet]), E::BadData);
    // The session key cannot replace the session (wallet only).
    let sp = Player {
        actor: session.pubkey(),
        payer: session.pubkey(),
        wallet: a.key(),
    };
    let ix = cix::set_session(&w.a, &sp, &session.pubkey(), exp);
    assert_code(c.send(&[ix], &[&session]), E::Auth);
    // … but it may act (SetVigil).
    assert_code(
        c.send(&[cix::set_vigil(&w.a, &sp, 1_440)], &[&session]),
        E::BadData,
    );
    let l = expect_lands(
        c.send(&[cix::set_vigil(&w.a, &sp, 120)], &[&session]),
        "SetVigil",
    );
    let from = siege::change_effective_at(c.now);
    let d = c.data(&ck);
    assert_eq!(rd_u16(&d, C::VIGIL_NEXT_MIN), 120);
    assert_eq!(rd_i64(&d, C::VIGIL_FROM_TS), from);
    assert_eq!(from % 86_400, 0, "a UTC midnight");
    assert!(from >= c.now + 86_400 && from < c.now + 2 * 86_400);
    assert_eq!(one(&l.logs, Kind::VIGIL).u64("start_min"), 120);
    // Weekly rule (Citizen form): not before vigil_from_ts + 6 days.
    c.set_time(from + 6 * 86_400 - 1);
    let sp2 = a.player();
    assert_code(
        c.send(&[cix::set_vigil(&w.a, &sp2, 60)], &[&a.wallet]),
        E::Cooldown,
    );
    c.advance(1);
    expect_lands(
        c.send(&[cix::set_vigil(&w.a, &sp2, 60)], &[&a.wallet]),
        "SetVigil a week on",
    );
    let d = c.data(&ck);
    assert_eq!(
        rd_u16(&d, C::VIGIL_START_MIN),
        120,
        "the earlier change folded in"
    );
    assert_eq!(rd_u16(&d, C::VIGIL_NEXT_MIN), 60);
    // The session expired meanwhile.
    assert_code(
        c.send(&[cix::set_vigil(&w.a, &sp, 30)], &[&session]),
        E::SessionExpired,
    );
    // Another wallet is not the citizen's actor.
    let stranger = c.funded(b"stranger", 1);
    let xp = Player {
        actor: stranger.pubkey(),
        payer: stranger.pubkey(),
        wallet: a.key(),
    };
    assert_code(
        c.send(&[cix::set_vigil(&w.a, &xp, 30)], &[&stranger]),
        E::Auth,
    );
    // The action bucket (burst 60): the 61st action in one instant fails.
    let b = w.citizen(&mut c, "bucket", 0);
    let mut refused = false;
    for i in 0..61u32 {
        let ix = cix::set_session(&w.a, &b.player(), &Address::default(), i as i64);
        match c.send(&[ix], &[&b.wallet]) {
            Ok(_) => {}
            Err(f) => {
                assert_eq!(i, 60, "burst 60");
                assert_code(Err(f), E::Bucket);
                refused = true;
                break;
            }
        }
    }
    assert!(refused);
    // After end_bell: WrongStatus (no post-end player action).
    c.set_time(w.genesis_ts() + 4_032 * 600);
    assert_code(
        c.send(&[cix::set_vigil(&w.a, &sp2, 60)], &[&a.wallet]),
        E::WrongStatus,
    );
}

#[test]
fn g03_player_prologue_refuses_forged_citizens_and_seasons() {
    let (mut c, w, _) = land();
    let a = w.citizen(&mut c, "a", 0);
    let ix = cix::set_vigil(&w.a, &a.player(), 60);
    let ck = w.a.citizen(&a.key());
    let fake = copy_to_fresh(&mut c, &ck, b"citizen-copy");
    assert_code(
        c.send(
            &[with_account(ix.clone(), player_at::CITIZEN, fake)],
            &[&a.wallet],
        ),
        E::BadAddress,
    );
    let season_copy = copy_to_fresh(&mut c, &w.a.season, b"season-copy");
    assert_code(
        c.send(
            &[with_account(ix.clone(), player_at::SEASON, season_copy)],
            &[&a.wallet],
        ),
        E::BadAddress,
    );
    for off in [0usize, 8] {
        let mut f = c.fork();
        f.edit(&ck, |d| d[off] ^= 1);
        assert_code(
            f.send(std::slice::from_ref(&ix), &[&a.wallet]),
            E::BadAccount,
        );
    }
    let mut f = c.fork();
    f.set_owner(&ck, Address::new_from_array([7; 32]));
    assert_code(
        f.send(std::slice::from_ref(&ix), &[&a.wallet]),
        E::BadAccount,
    );
    // A citizen whose stored wallet is another's: not at its canonical address.
    let b = w.citizen(&mut c, "b", 0);
    let mut f = c.fork();
    let bw = b.key();
    f.edit(&ck, |d| {
        d[C::WALLET..C::WALLET + 32].copy_from_slice(bw.as_ref())
    });
    assert_code(f.send(&[ix], &[&a.wallet]), E::BadAddress);
}

// ------------------------------------------------------------ tickets

#[test]
fn citizen_file_and_settle_a_fresh_holding() {
    let (mut c, w, ring2) = land();
    let a = w.citizen(&mut c, "a", 0);
    let (p0, p1) = (ring2[0], ring2[1]);
    let sites = [site(p0, 0), site(p1, 1)];
    let ck = w.a.citizen(&a.key());
    let rent_h = c.rent(H::SIZE);
    // Refusals of FileTicket.
    let seat = provinces_of(1, Some(0))[0];
    assert_code(w.file_ticket(&mut c, &a, &[site(seat, 0)]), E::ReservedSite);
    let alien = provinces_of(2, Some(1))[0]; // another wedge, own wedge not full
    assert_code(w.file_ticket(&mut c, &a, &[site(alien, 0)]), E::BadData);
    let beyond = provinces_of(4, Some(0))[0]; // ring 4 not opened
    assert_code(w.file_ticket(&mut c, &a, &[site(beyond, 0)]), E::BadData);
    let n0 = w.site_count(&c, p0.0, p0.1);
    assert_code(w.file_ticket(&mut c, &a, &[site(p0, n0)]), E::BadData);
    assert_code(
        w.file_ticket(&mut c, &a, &[site(p0, 0), site(p0, 0)]),
        E::BadData,
    );
    let unopened = provinces_of(3, Some(0))[0]; // ring 3 open, province not opened
    assert_code(
        w.file_ticket(&mut c, &a, &[site(unopened, 0)]),
        E::BadAccount,
    );
    // The payer must cover the escrow.
    let poor = keypair(b"poor");
    c.airdrop(&poor.pubkey(), rent_h - 1);
    let pp = Player {
        actor: a.key(),
        payer: poor.pubkey(),
        wallet: a.key(),
    };
    let ix = cix::file_ticket(&w.a, &pp, &sites);
    assert_code(c.send(&[ix], &[&a.wallet, &poor]), E::Insufficient);
    // Lands.
    let cw = ChainTrack::new(&c, ck, EntityKind::Citizen);
    let before = c.lamports(&a.key());
    let bell = w.now_bell(&c);
    let l = expect_lands(w.file_ticket(&mut c, &a, &sites), "FileTicket");
    cw.check(&c, &l.logs, 1);
    assert_eq!(paid(before, &c, &a.wallet, &l), rent_h, "the escrow (I-47)");
    let d = c.data(&ck);
    assert_eq!(rd_u32(&d, C::TICKET_BELL), bell);
    assert_eq!(rd_u64(&d, C::TICKET_ESCROW), rent_h);
    assert_eq!(
        &d[C::TICKET_FUNDER..C::TICKET_FUNDER + 32],
        a.key().as_ref()
    );
    assert_eq!(cohort(&c, &w, p0, bell), Some((1, 0)));
    assert_eq!(cohort(&c, &w, p1, bell), Some((1, 0)));
    let r = one(&l.logs, Kind::TICKET);
    assert_eq!(r.u64("n"), 2);
    assert_eq!(r.links.len(), 3, "Citizen and two Provinces");
    assert_code(w.file_ticket(&mut c, &a, &sites), E::TicketState);
    // SettleTicket before THE anchor and before the seed.
    assert_code(w.settle_ticket(&mut c, &a, 0, None), E::NoAnchor);
    let r0 = region(p0.0, p0.1);
    expect_lands(w.post_anchor(&mut c, bell, r0), "PostAnchor");
    assert_code(w.settle_ticket(&mut c, &a, 0, None), E::SeedNotReady);
    w.seed_ready(&mut c, bell, r0);
    assert_code(w.settle_ticket(&mut c, &a, 1, None), E::TicketState);
    // Fresh.
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let pk = w.a.province(p0.0 as i32, p0.1 as i32);
    let shard = shard_of(&w, &c, &a);
    let watches = [
        ChainTrack::new(&c, ck, EntityKind::Citizen),
        ChainTrack::new(&c, pk, EntityKind::Province),
        ChainTrack::new(&c, shard, EntityKind::JoinShard),
    ];
    let keeper_before = c.lamports(&w.keeper.pubkey());
    let l = expect_lands(w.settle_ticket(&mut c, &a, 0, None), "SettleTicket (fresh)");
    for cwch in &watches {
        cwch.check(&c, &l.logs, 1);
    }
    assert_eq!(
        paid(keeper_before, &c, &w.keeper, &l),
        0,
        "the escrow funds the Holding"
    );
    assert_program_account(&c, &hk, H::MAGIC, H::SIZE, 1);
    assert_eq!(c.lamports(&hk), rent_h);
    assert_eq!(
        c.lamports(&ck),
        c.rent(C::SIZE),
        "the escrow left the Citizen"
    );
    let seed = w.bell_seed(&c, bell, r0);
    let score = w.score_of(&seed, &a, sites[0]);
    let hd = c.data(&hk);
    assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
    assert_eq!(hd[H::GEN], 1, "the first founding of the site");
    assert_eq!(&hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], ck.as_ref());
    assert_eq!(rd_u64(&hd, H::TICKET_SCORE), score);
    assert_eq!(rd_u32(&hd, H::TICKET_BELL), bell);
    assert_eq!(&hd[H::RENT_PAYER..H::RENT_PAYER + 32], a.key().as_ref());
    let s_round = w.seed_round(&c, bell, r0);
    assert_eq!(rd_i64(&hd, H::FINAL_TS), World::round_time(s_round) + 600);
    // The founded holding: Hamlet base production and the starter kit.
    let mut want = Holding::found(c.now, w.now_bell(&c) / 144, 1);
    want.production = catalog::base_production(Tier::Hamlet);
    for r in 0..8 {
        assert_eq!(
            rd_u64(&hd, H::PRODUCTION + 8 * r) as i64,
            want.production[r]
        );
        assert_eq!(
            rd_u64(&hd, H::store(r)) as i64,
            catalog::starter_kit()[r],
            "store {r}"
        );
    }
    // MC §3.9: the first-holding shield is the season's (Frontier-7: 24 h,
    // `shield_late_secs` after `shield_late_after_secs`), not M1's constant.
    let life = w.params.lifecycle();
    assert_eq!(
        rd_i64(&hd, H::SHIELD_UNTIL),
        c.now + life.shield_secs_for(1, c.now, w.genesis_ts())
    );
    assert_eq!(hd[H::TILE], c.data(&pk)[PV::SITES]);
    let d = c.data(&ck);
    assert_eq!(d[C::FLAGS] & C::FLAG_PROVISIONAL, C::FLAG_PROVISIONAL);
    assert_eq!(rd_u16(&d, C::HOLDING + HR::P) as i16, p0.0);
    assert_eq!(d[C::HOLDING + HR::GEN], 1);
    assert_eq!(rd_u32(&d, C::TICKET_BELL), C::NO_TICKET, "the ticket ended");
    assert_eq!(rd_u64(&d, C::TICKET_ESCROW), 0);
    let pd = c.data(&pk);
    assert_eq!(pd[PV::site(0) + SM::STATE], SM::STATE_HOLDING);
    assert_eq!(pd[PV::site(0) + SM::FACTION], 0);
    assert_eq!(pd[PV::site(0) + SM::GEN], 1);
    assert_eq!(pd[PV::N_SITES_USED], 1);
    assert_eq!(
        cohort(&c, &w, p0, bell),
        Some((1, 1)),
        "settled: the record is free"
    );
    assert!(cohort_closed(&pd, bell, w.now_bell(&c)));
    assert!(cohort_closed(
        &c.data(&w.a.province(p1.0 as i32, p1.1 as i32)),
        bell,
        w.now_bell(&c)
    ));
    assert_eq!(holdings(&c, &shard), (1, 1));
    let r = one(&l.logs, Kind::SETTLE);
    assert_eq!(r.u64("outcome"), settle_outcome::FRESH as u64);
    assert_eq!(r.u64("score"), score);
    assert_eq!(r.u64("gen"), 1);
    assert_eq!(
        r.links.len(),
        5,
        "JoinShard, Citizen, Holding, two Provinces"
    );
    // Final after `final_ts` with the cohort closed (the flip is lazy, in
    // the resident prologue: W3-B).
    let h = hdr_of(&hd);
    assert!(!finality_due(&h, &pd, c.now, w.now_bell(&c)) || c.now >= h.final_ts);
    assert!(finality_due(&h, &pd, h.final_ts, w.now_bell(&c)));
    // Settled: a repeat is refused, FileTicket too.
    assert_code(w.settle_ticket(&mut c, &a, 0, None), E::NoTicket);
    assert_code(w.file_ticket(&mut c, &a, &sites), E::TicketState);
    // The fold counts it.
    w.fold(&mut c);
    let fr = c.data(&w.a.frontier());
    assert_eq!(rd_u32(&fr, FR::OCCUPIED_SITES), 1);
    assert_eq!(rd_u32(&fr, FR::WEDGE_OCCUPIED), 1);
}

/// I-47: inside a cohort a higher score displaces with no time condition,
/// even after `final_ts`, while the cohort's Province is "held" (its other
/// tickets not settled); finality waits for the cohort; a lower score is
/// taken and the ticket is exhausted.
#[test]
fn citizen_cohort_displacement_has_no_deadline_and_finality_waits() {
    let (mut c, w, ring2) = land();
    let p0 = ring2[0];
    let s = site(p0, 0);
    let who: Vec<Citizen> = (0..3)
        .map(|i| w.citizen(&mut c, &format!("k{i}"), 0))
        .collect();
    let bell = w.now_bell(&c);
    for x in &who {
        file(&w, &mut c, x, &[s]);
    }
    assert_eq!(cohort(&c, &w, p0, bell), Some((3, 0)));
    let r0 = region(p0.0, p0.1);
    w.seed_ready(&mut c, bell, r0);
    let seed = w.bell_seed(&c, bell, r0);
    let mut order: Vec<usize> = (0..3).collect();
    order.sort_by_key(|&i| w.score_of(&seed, &who[i], s));
    let (lo, mid, hi) = (&who[order[0]], &who[order[1]], &who[order[2]]);
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let pk = w.a.province(p0.0 as i32, p0.1 as i32);
    expect_lands(
        w.settle_ticket(&mut c, lo, 0, None),
        "SettleTicket lo (fresh)",
    );
    let final_ts = rd_i64(&c.data(&hk), H::FINAL_TS);
    // The Province "held" past final_ts: nothing settles for 6 bells.
    c.set_time(final_ts + 6 * 600);
    assert!(w.now_bell(&c) < bell + 24);
    let h = hdr_of(&c.data(&hk));
    assert!(
        !finality_due(&h, &c.data(&pk), c.now, w.now_bell(&c)),
        "the cohort is open: no finality"
    );
    // The higher score still wins: displacement, with the displaced holder.
    assert_code(w.settle_ticket(&mut c, hi, 0, None), E::TooManyAccounts);
    let disp = w.displaced_at(&c, p0.0, p0.1, 0, 0);
    assert_eq!(disp.wallet, lo.key());
    let lo_ck = w.a.citizen(&lo.key());
    let hi_ck = w.a.citizen(&hi.key());
    let lo_before = c.lamports(&lo.key());
    let hw = ChainTrack::new(&c, hk, EntityKind::Holding);
    let lw = ChainTrack::new(&c, lo_ck, EntityKind::Citizen);
    let (lo_shard, hi_shard) = (shard_of(&w, &c, lo), shard_of(&w, &c, hi));
    let l = expect_lands(
        w.settle_ticket(&mut c, hi, 0, Some(&disp)),
        "SettleTicket hi (displace)",
    );
    hw.check(&c, &l.logs, 1);
    lw.check(&c, &l.logs, 1);
    let hd = c.data(&hk);
    assert_eq!(hd[H::GEN], 2, "re-founded in place");
    assert_eq!(&hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], hi_ck.as_ref());
    assert_eq!(rd_u64(&hd, H::TICKET_SCORE), w.score_of(&seed, hi, s));
    assert_eq!(&hd[H::RENT_PAYER..H::RENT_PAYER + 32], hi.key().as_ref());
    assert_eq!(
        c.lamports(&lo.key()),
        lo_before + c.rent(H::SIZE),
        "the new escrow repays the displaced funder"
    );
    let ld = c.data(&lo_ck);
    assert_eq!(ld[C::FLAGS] & C::FLAG_PROVISIONAL, 0);
    // MC §5.2.3: the emptied slot-1 entry has `gen = 0xFF`.
    assert_eq!(&ld[C::HOLDING..C::HOLDING + 6], &[0, 0, 0, 0, 0, 0xFF]);
    assert_eq!(ld[C::HOLDINGS_N], 0);
    assert_eq!(rd_u32(&ld, C::TICKET_BELL), C::NO_TICKET);
    if lo_shard == hi_shard {
        assert_eq!(holdings(&c, &hi_shard), (1, 1));
    } else {
        assert_eq!(holdings(&c, &lo_shard), (0, 0));
        assert_eq!(holdings(&c, &hi_shard), (1, 1));
    }
    assert_eq!(c.data(&pk)[PV::site(0) + SM::GEN], 2);
    assert_eq!(c.data(&pk)[PV::N_SITES_USED], 1);
    let r = one(&l.logs, Kind::SETTLE);
    assert_eq!(r.u64("outcome"), settle_outcome::DISPLACE as u64);
    assert_eq!(r.u64("displaced_tag"), w.citizen_tag(lo));
    assert_eq!(cohort(&c, &w, p0, bell), Some((3, 2)));
    // The lower score is taken; one site: the ticket is exhausted, the
    // escrow stays for the next ticket.
    let disp2 = w.displaced_at(&c, p0.0, p0.1, 0, 0);
    assert_code(
        w.settle_ticket(&mut c, mid, 0, Some(&disp2)),
        E::TooManyAccounts,
    );
    let l = expect_lands(
        w.settle_ticket(&mut c, mid, 0, None),
        "SettleTicket mid (taken)",
    );
    let r = one(&l.logs, Kind::SETTLE);
    assert_eq!(r.u64("outcome"), settle_outcome::TAKEN as u64);
    let md = c.data(&w.a.citizen(&mid.key()));
    assert_eq!(rd_u32(&md, C::TICKET_BELL), C::NO_TICKET, "exhausted");
    assert_eq!(
        rd_u64(&md, C::TICKET_ESCROW),
        c.rent(H::SIZE),
        "escrow kept"
    );
    // The cohort closed: finality is due now.
    assert_eq!(cohort(&c, &w, p0, bell), Some((3, 3)));
    let h = hdr_of(&c.data(&hk));
    assert!(finality_due(&h, &c.data(&pk), c.now, w.now_bell(&c)));
    // The displaced citizen refiles (the web's one-tap refile).
    let other = site(ring2[1], 0);
    file(&w, &mut c, lo, &[other]);
    // A repeat of a settled preference is an idempotent AlreadyDone once
    // the ticket moved on: a two-site ticket, the first taken.
    let two = [s, site(ring2[1], 1)];
    file(&w, &mut c, mid, &two);
    let b2 = w.now_bell(&c);
    w.seed_ready(&mut c, b2, r0);
    w.seed_ready(&mut c, b2, region(ring2[1].0, ring2[1].1));
    let l = expect_lands(
        w.settle_ticket(&mut c, mid, 0, None),
        "taken, next preference",
    );
    assert_eq!(
        one(&l.logs, Kind::SETTLE).u64("outcome"),
        settle_outcome::TAKEN as u64
    );
    let ix0 = {
        // k = 0 again, built against the stored ticket
        w.settle_ticket_ix(&c, mid, 0, None)
    };
    assert_code(c.send(&[ix0], &[&w.keeper]), E::AlreadyDone);
}

/// Two citizens of the same faction and JoinShard: the displacement nets
/// out on the one shard, chained once (W3-A notes, deviation D5).
#[test]
fn citizen_cohort_displacement_within_one_join_shard() {
    let (mut c, w, ring2) = land();
    // Labels whose wallets share a JoinShard.
    let key_of = |l: &str| keypair(format!("citizen-1-{l}").as_bytes()).pubkey();
    let s0 = fclient::addr::join_shard_of(&key_of("same0").to_bytes());
    let label = (1..200)
        .map(|i| format!("same{i}"))
        .find(|l| fclient::addr::join_shard_of(&key_of(l).to_bytes()) == s0)
        .expect("a second wallet in the shard");
    let x = w.citizen(&mut c, "same0", 0);
    let y = w.citizen(&mut c, &label, 0);
    let p0 = ring2[0];
    let s = site(p0, 2);
    let bell = w.now_bell(&c);
    file(&w, &mut c, &x, &[s]);
    file(&w, &mut c, &y, &[s]);
    let r0 = region(p0.0, p0.1);
    w.seed_ready(&mut c, bell, r0);
    let seed = w.bell_seed(&c, bell, r0);
    let (lo, hi) = if w.score_of(&seed, &x, s) < w.score_of(&seed, &y, s) {
        (&x, &y)
    } else {
        (&y, &x)
    };
    expect_lands(w.settle_ticket(&mut c, lo, 0, None), "fresh");
    let shard = shard_of(&w, &c, hi);
    assert_eq!(shard, shard_of(&w, &c, lo));
    let jw = ChainTrack::new(&c, shard, EntityKind::JoinShard);
    let disp = w.displaced_at(&c, p0.0, p0.1, 2, 0);
    let l = expect_lands(
        w.settle_ticket(&mut c, hi, 0, Some(&disp)),
        "displace in one shard",
    );
    let links = jw.check(&c, &l.logs, 1);
    assert_eq!(links.len(), 1, "the shard is chained once");
    assert_eq!(holdings(&c, &shard), (1, 1));
}

/// I-47: a ticket not settled within 24 bells expires; its cohort record
/// is marked, the escrow stays for the refile (which then costs nothing).
#[test]
fn citizen_cohort_expiry_ends_the_ticket() {
    let (mut c, w, ring2) = land();
    let a = w.citizen(&mut c, "a", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 3)]);
    c.set_time(w.genesis_ts() + (bell as i64 + 24) * 600);
    let ck = w.a.citizen(&a.key());
    let cw = ChainTrack::new(&c, ck, EntityKind::Citizen);
    let l = expect_lands(
        w.settle_ticket(&mut c, &a, 0, None),
        "SettleTicket (expired)",
    );
    cw.check(&c, &l.logs, 1);
    let r = one(&l.logs, Kind::SETTLE);
    assert_eq!(r.u64("outcome"), settle_outcome::EXPIRED as u64);
    let d = c.data(&ck);
    assert_eq!(rd_u32(&d, C::TICKET_BELL), C::NO_TICKET);
    assert_eq!(rd_u64(&d, C::TICKET_ESCROW), c.rent(H::SIZE));
    assert!(c.is_absent(&w.a.holding(p0.0 as i32, p0.1 as i32, 3)));
    // The record expired anyway; a refile reuses the escrow.
    let before = c.lamports(&a.key());
    let l = expect_lands(w.file_ticket(&mut c, &a, &[site(p0, 3)]), "refile");
    assert_eq!(paid(before, &c, &a.wallet, &l), 0, "the escrow is reused");
    assert_eq!(one(&l.logs, Kind::TICKET).u64("escrow"), c.rent(H::SIZE));
}

/// v1.5 §5.9 (wave-3 review, W3-A major): a refile that adds nothing to
/// the escrow keeps the funder that paid it. A sponsor pays the escrow;
/// the ticket expires; the player refiles self-paid (fee only): the
/// funder, and after a fresh settle the Holding's `rent_payer`, stay the
/// sponsor's. The reverse (a sponsored refile over a self-funded escrow)
/// keeps the player; a refile over an empty escrow makes the payer the
/// funder.
#[test]
fn citizen_refile_keeps_the_escrow_funder() {
    let (mut c, w, ring2) = land();
    let sponsor = c.funded(b"sponsor-pool", 5);
    let a = w.citizen(&mut c, "a", 0);
    let p0 = ring2[0];
    let s = site(p0, 4);
    let ck = w.a.citizen(&a.key());
    let funder = |c: &Chain| {
        let d = c.data(&ck);
        Address::try_from(&d[C::TICKET_FUNDER..C::TICKET_FUNDER + 32]).unwrap()
    };
    let sponsored = |c: &mut Chain, who: &Citizen, sites: &[Site]| {
        let pl = Player {
            actor: who.key(),
            payer: sponsor.pubkey(),
            wallet: who.key(),
        };
        let ix = cix::file_ticket(&w.a, &pl, sites);
        c.send(&[ix], &[&sponsor, &who.wallet])
    };
    let bell = w.now_bell(&c);
    let l = expect_lands(sponsored(&mut c, &a, &[s]), "sponsored FileTicket");
    assert_eq!(funder(&c), sponsor.pubkey(), "the sponsor paid the escrow");
    assert_eq!(
        one(&l.logs, Kind::TICKET).field("funder", true),
        sponsor.pubkey().as_ref()
    );
    c.set_time(w.genesis_ts() + (bell as i64 + 24) * 600);
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "expired");
    // The self-paid refile adds nothing: the sponsor stays the funder.
    let b2 = w.now_bell(&c);
    let before = c.lamports(&a.key());
    let l = expect_lands(w.file_ticket(&mut c, &a, &[s]), "self-paid refile");
    assert_eq!(paid(before, &c, &a.wallet, &l), 0);
    assert_eq!(funder(&c), sponsor.pubkey(), "the refile keeps the funder");
    assert_eq!(
        one(&l.logs, Kind::TICKET).field("funder", true),
        sponsor.pubkey().as_ref()
    );
    w.seed_ready(&mut c, b2, region(p0.0, p0.1));
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "fresh");
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 4);
    assert_eq!(
        &c.data(&hk)[H::RENT_PAYER..H::RENT_PAYER + 32],
        sponsor.pubkey().as_ref(),
        "the Holding's rent goes back to the sponsor"
    );
    // The reverse: a self-funded escrow is not taken over by a sponsored
    // refile; and an empty escrow makes the payer the funder.
    let b = w.citizen(&mut c, "b", 0);
    let bk = w.a.citizen(&b.key());
    let bell = w.now_bell(&c);
    file(&w, &mut c, &b, &[site(p0, 5)]);
    c.set_time(w.genesis_ts() + (bell as i64 + 24) * 600);
    expect_lands(w.settle_ticket(&mut c, &b, 0, None), "expired b");
    expect_lands(sponsored(&mut c, &b, &[site(p0, 5)]), "sponsored refile");
    let d = c.data(&bk);
    assert_eq!(
        &d[C::TICKET_FUNDER..C::TICKET_FUNDER + 32],
        b.key().as_ref()
    );
    let x = w.citizen(&mut c, "x", 0);
    expect_lands(
        sponsored(&mut c, &x, &[site(p0, 6)]),
        "sponsored, empty escrow",
    );
    let d = c.data(&w.a.citizen(&x.key()));
    assert_eq!(
        &d[C::TICKET_FUNDER..C::TICKET_FUNDER + 32],
        sponsor.pubkey().as_ref()
    );
}

/// DECISIONS K9 (decided 2026-09-28, contract v1.6 §5.9): a **fresh**
/// settlement in a Province waits (`TicketState`) while an **earlier**
/// ticket cohort of the same Province is still open, so a later cohort
/// can never make an earlier winner `taken` and I-47's 24-bell bound
/// holds. Displacement and `taken` are unaffected; an earlier cohort that
/// closed (every ticket settled) or expired (24 bells) no longer blocks.
#[test]
fn citizen_cohort_fresh_waits_for_an_earlier_open_cohort() {
    let (mut c, w, ring2) = land();
    let p0 = ring2[0];
    let r0 = region(p0.0, p0.1);
    let s = site(p0, 0);
    let a = w.citizen(&mut c, "k9a", 0);
    let b = w.citizen(&mut c, "k9b", 0);
    let e = w.citizen(&mut c, "k9e", 0);
    let b1 = w.now_bell(&c);
    file(&w, &mut c, &a, &[s]);
    // A second earlier-cohort ticket at another site of the Province,
    // never settled: it keeps the b1 cohort open until it expires.
    file(&w, &mut c, &e, &[site(p0, 5)]);
    c.set_time(w.genesis_ts() + (b1 as i64 + 1) * 600 + 1);
    let b2 = w.now_bell(&c);
    assert_eq!(b2, b1 + 1);
    file(&w, &mut c, &b, &[s, site(p0, 1)]);
    w.seed_ready(&mut c, b1, r0);
    w.seed_ready(&mut c, b2, r0);
    assert_eq!(cohort(&c, &w, p0, b1), Some((2, 0)));
    // The later cohort's fresh settlement waits while b1 is open.
    assert_code(w.settle_ticket(&mut c, &b, 0, None), E::TicketState);
    // The earlier winner settles fresh; the later ticket is then taken.
    let l = expect_lands(w.settle_ticket(&mut c, &a, 0, None), "a fresh (b1)");
    assert_eq!(
        one(&l.logs, Kind::SETTLE).u64("outcome"),
        settle_outcome::FRESH as u64
    );
    let l = expect_lands(w.settle_ticket(&mut c, &b, 0, None), "b taken (b2)");
    assert_eq!(
        one(&l.logs, Kind::SETTLE).u64("outcome"),
        settle_outcome::TAKEN as u64
    );
    // Its next preference (site 1, free) still waits: e's b1 ticket is open.
    assert_eq!(cohort(&c, &w, p0, b1), Some((2, 1)));
    assert_code(w.settle_ticket(&mut c, &b, 1, None), E::TicketState);
    // Once the b1 cohort expired (bell b1 + 24 < b2 + 24) it lands fresh.
    c.set_time(w.genesis_ts() + (b1 as i64 + 24) * 600 + 1);
    let l = expect_lands(w.settle_ticket(&mut c, &b, 1, None), "b fresh (b1 expired)");
    assert_eq!(
        one(&l.logs, Kind::SETTLE).u64("outcome"),
        settle_outcome::FRESH as u64
    );
}

#[test]
fn citizen_cohort_table_full_refuses_a_ninth_bell() {
    let (mut c, w, ring2) = land();
    let p0 = ring2[0];
    for b in 0..8 {
        let x = w.citizen(&mut c, &format!("f{b}"), 0);
        file(&w, &mut c, &x, &[site(p0, 0)]);
        c.advance(600);
    }
    let x = w.citizen(&mut c, "f8", 0);
    assert_code(w.file_ticket(&mut c, &x, &[site(p0, 0)]), E::CohortFull);
}

#[test]
fn g03_settle_ticket_refuses_forged_accounts() {
    let (mut c, w, ring2) = land();
    let a = w.citizen(&mut c, "a", 0);
    let (p0, p1) = (ring2[0], ring2[1]);
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0), site(p1, 0)]);
    let r0 = region(p0.0, p0.1);
    w.seed_ready(&mut c, bell, r0);
    let ix = w.settle_ticket_ix(&c, &a, 0, None);
    let send = |c: &mut Chain, ix| c.send(&[ix], &[&w.keeper]);
    assert_code(
        send(
            &mut c,
            with_account(
                ix.clone(),
                settle_at::HOLDING,
                w.a.holding(p0.0 as i32, p0.1 as i32, 1),
            ),
        ),
        E::BadAddress,
    );
    assert_code(
        send(
            &mut c,
            with_account(
                ix.clone(),
                settle_at::PROVINCE,
                w.a.province(p1.0 as i32, p1.1 as i32),
            ),
        ),
        E::BadAddress,
    );
    assert_code(
        send(
            &mut c,
            with_account(
                ix.clone(),
                settle_at::OTHER0,
                w.a.province(p0.0 as i32, p0.1 as i32),
            ),
        ),
        E::BadAddress,
    );
    assert_code(
        send(
            &mut c,
            with_account(ix.clone(), settle_at::JOINSHARD, w.a.join_shard(1, 0)),
        ),
        E::BadAddress,
    );
    let copy = copy_to_fresh(&mut c, &w.a.citizen(&a.key()), b"cit");
    assert_code(
        send(&mut c, with_account(ix.clone(), settle_at::CITIZEN, copy)),
        E::BadAddress,
    );
    // THE anchor of another region; a cache naming another anchor.
    let other_r = (r0 + 1) % 16;
    assert_code(
        send(
            &mut c,
            with_account(ix.clone(), settle_at::ANCHOR, w.a.anchor(bell, other_r)),
        ),
        E::BadAddress,
    );
    let mut f = c.fork();
    let ck = w.a.seed_cache(bell, r0, 0);
    f.edit(&ck, |d| d[64] ^= 1); // anchor_key
    assert_code(
        f.send(std::slice::from_ref(&ix), &[&w.keeper]),
        E::BadAccount,
    );
    let mut f = c.fork();
    f.edit(&w.a.province(p0.0 as i32, p0.1 as i32), |d| d[3] ^= 1);
    assert_code(
        f.send(std::slice::from_ref(&ix), &[&w.keeper]),
        E::BadAccount,
    );
    let mut f = c.fork();
    let js = shard_of(&w, &c, &a);
    f.edit(&js, |d| d[8] ^= 1); // another season's JoinShard
    assert_code(
        f.send(std::slice::from_ref(&ix), &[&w.keeper]),
        E::BadAccount,
    );
    // A pre-existing impostor at the Holding address of a free site.
    let mut f = c.fork();
    f.put_program_account(w.a.holding(p0.0 as i32, p0.1 as i32, 0), vec![0u8; H::SIZE]);
    assert_code(
        f.send(std::slice::from_ref(&ix), &[&w.keeper]),
        E::BadAccount,
    );
    // The other province missing.
    let mut short = ix.clone();
    short.accounts.remove(settle_at::OTHER0);
    assert_code(send(&mut c, short), E::TooManyAccounts);
    // Wrong status (crafted Ended): no holding is founded after the season.
    let mut f = c.fork();
    w.craft_status(&mut f, S::STATUS_ENDED);
    assert_code(
        f.send(std::slice::from_ref(&ix), &[&w.keeper]),
        E::WrongStatus,
    );
    // The unsigned payer (another key pays the fee).
    let fee = c.funded(b"fee-payer", 1);
    assert_code(
        c.send(&[without_signer(ix.clone(), settle_at::PAYER)], &[&fee]),
        E::Auth,
    );
    // Lands, then the archive path of a later settlement is refused while
    // no archive exists (seed source = archive, absent): SeedNotReady.
    expect_lands(send(&mut c, ix), "SettleTicket");
    let b = w.citizen(&mut c, "b", 0);
    let b_bell = w.now_bell(&c);
    file(&w, &mut c, &b, &[site(p0, 1)]);
    w.seed_ready(&mut c, b_bell, r0);
    let ix = w.settle_ticket_ix_src(&c, &b, 0, None, SeedSource::Archive);
    assert_code(c.send(&[ix], &[&w.keeper]), E::SeedNotReady);
}

/// G3 for SettleTicket's displaced triple (wave-3 review, W3-A): the
/// displaced rent payer (the one account that receives the escrow), the
/// displaced Citizen and its JoinShard, each substituted.
#[test]
fn g03_settle_ticket_refuses_a_forged_displaced_triple() {
    let mut c = Chain::test_beacon();
    let (w, hi, d) = displacement_setup(&mut c, false);
    let z = w.citizen(&mut c, "z", 0);
    let ix = w.settle_ticket_ix(&c, &hi, 0, Some(&d));
    let n = ix.accounts.len();
    let (rp, dc, dj) = (n - 4, n - 3, n - 2);
    assert_eq!(ix.accounts[rp].pubkey, d.rent_payer, "triple position");
    let send = |c: &mut Chain, ix| c.send(&[ix], &[&w.keeper]);
    let thief = keypair(b"thief").pubkey();
    assert_code(
        send(&mut c, with_account(ix.clone(), rp, thief)),
        E::BadAddress,
    );
    assert_code(
        send(&mut c, with_account(ix.clone(), rp, z.key())),
        E::BadAddress,
    );
    assert_code(
        send(&mut c, with_account(ix.clone(), dc, w.a.citizen(&z.key()))),
        E::BadAddress,
    );
    let dd = c.data(&w.a.citizen(&d.wallet));
    let shard = dd[C::JOIN_SHARD];
    assert_code(
        send(
            &mut c,
            with_account(ix.clone(), dj, w.a.join_shard(1, shard)),
        ),
        E::BadAddress,
    );
    assert_code(
        send(
            &mut c,
            with_account(ix.clone(), dj, w.a.join_shard(0, (shard + 1) % 8)),
        ),
        E::BadAddress,
    );
    let before = c.lamports(&d.rent_payer);
    expect_lands(send(&mut c, ix), "the genuine displacement");
    assert_eq!(c.lamports(&d.rent_payer), before + c.rent(H::SIZE));
}

/// Wave-3 review (W3-B missing item): a Holding founded by the real
/// SettleTicket (W3-A's writer) runs W3-B's Harvest, Train, Build and
/// Muster: the two Holding codecs agree (the kernel reading of W3-A's
/// bytes settles exactly as the program's). The province's
/// `resolved_next` is moved as W4-A's resolves would (stand-in).
#[test]
fn citizen_founded_holding_runs_the_holding_actions() {
    use permutation_frontier_svm_tests::ix::holding as hx;
    use permutation_frontier_svm_tests::world::holding::{read_kholding, Estate};
    let (mut c, w, ring2) = land();
    let a = w.citizen(&mut c, "a", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0)]);
    w.seed_ready(&mut c, bell, region(p0.0, p0.1));
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "fresh");
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let pk = w.a.province(p0.0 as i32, p0.1 as i32);
    // F8 twin (wave-3 review, W3-C): the keeper's ticket score is the
    // program's stored score.
    let seed = w.bell_seed(&c, bell, region(p0.0, p0.1));
    assert_eq!(
        rd_u64(&c.data(&hk), H::TICKET_SCORE),
        fclient::land::ticket_score(&seed, p0.0 as i32, p0.1 as i32, 0, w.citizen_tag(&a))
    );
    let final_ts = rd_i64(&c.data(&hk), H::FINAL_TS);
    c.set_time(final_ts + 2 * 3_600);
    let b = w.now_bell(&c);
    c.edit(&pk, |d| {
        d[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4].copy_from_slice(&(b - 1).to_le_bytes())
    });
    let tile = c.data(&pk)[PV::SITES];
    let ck = w.a.citizen(&a.key());
    let e = Estate {
        wallet: a.wallet,
        faction: 0,
        p: p0.0,
        q: p0.1,
        site: 0,
        gen: c.data(&hk)[H::GEN],
        tile,
        holding: hk,
        province: pk,
        citizen: ck,
    };
    let send = |c: &mut Chain, ix| c.send(&[ix], &[&e.wallet]);
    let mut before = read_kholding(&c.data(&hk));
    let l = expect_lands(
        send(&mut c, hx::harvest(&w.a, &e.player(), e.href())),
        "Harvest on a SettleTicket holding",
    );
    one(&l.logs, Kind::HARVEST);
    // MC §5.6: Harvest carries the holding's own Province now, so it is the
    // first action that runs the lazy flip.
    one(&l.logs, Kind::HOLDING_FINAL);
    assert_eq!(c.data(&hk)[H::STATE], H::STATE_FINAL);
    before.settle(c.now).unwrap();
    before.touch_owner(c.now).unwrap();
    before.commit_walls(c.now);
    assert_eq!(read_kholding(&c.data(&hk)), before, "the codecs agree");
    w.enrich(&mut c, &e, 50_000);
    expect_lands(
        send(&mut c, hx::train(&w.a, &e.player(), e.href(), 0, 300)),
        "Train",
    );
    expect_lands(
        send(
            &mut c,
            hx::build_item(&w.a, &e.player(), e.href(), 0, false),
        ),
        "Build",
    );
    let l = expect_lands(
        send(
            &mut c,
            permutation_frontier_svm_tests::ix::host::muster(
                &w.a,
                &e.player(),
                e.href(),
                0,
                200,
                tile,
            ),
        ),
        "Muster",
    );
    // Already final: no second flip.
    assert!(
        permutation_frontier_svm_tests::records::of_kind(&l.logs, Kind::HOLDING_FINAL).is_empty()
    );
    one(&l.logs, Kind::MUSTER);
    assert_eq!(c.data(&hk)[H::STATE], H::STATE_FINAL);
    assert_eq!(rd_u32(&c.data(&hk), H::reserve(0)), 100);
}

// ------------------------------------------------------------ release, closes

#[test]
fn citizen_release_dormant_frees_the_site_and_strands_the_gen() {
    // The long season: release comes 10 days after the last owner action.
    let mut c = Chain::test_beacon();
    let (w, ring2) = World::land_long(&mut c, 1, 0);
    let a = w.citizen(&mut c, "a", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0)]);
    w.seed_ready(&mut c, bell, region(p0.0, p0.1));
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "fresh");
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let pk = w.a.province(p0.0 as i32, p0.1 as i32);
    let ck = w.a.citizen(&a.key());
    let shard = shard_of(&w, &c, &a);
    let rel = |c: &mut Chain, rent_payer: Address| {
        let h = cix::HoldingRef {
            p: p0.0,
            q: p0.1,
            site: 0,
        };
        let ix = cix::release_dormant(&w.a, w.keeper.pubkey(), h, &a.key(), 0, rent_payer);
        c.send(&[ix], &[&w.keeper])
    };
    assert_code(rel(&mut c, a.key()), E::NotDormant);
    let mut f = c.fork();
    w.craft_status(&mut f, S::STATUS_ENDED);
    assert_code(rel(&mut f, a.key()), E::WrongStatus);
    let last = rd_i64(&c.data(&hk), H::LAST_OWNER_ACTION);
    c.set_time(last + 864_000);
    // A transit in flight (crafted record, W3-B's Depart) blocks it.
    let mut f = c.fork();
    f.edit(&hk, |d| d[H::transit(0) + T::STATE] = T::STATE_DEPARTED);
    assert_code(rel(&mut f, a.key()), E::NotDormant);
    assert_code(rel(&mut c, keypair(b"x").pubkey()), E::BadAddress);
    // G3 (wave-3 review): the Citizen, its JoinShard and the DefencePool
    // substituted.
    {
        let z = w.citizen(&mut c, "z", 0);
        let h = cix::HoldingRef {
            p: p0.0,
            q: p0.1,
            site: 0,
        };
        let ix = cix::release_dormant(&w.a, w.keeper.pubkey(), h, &a.key(), 0, a.key());
        let send = |c: &mut Chain, ix| c.send(&[ix], &[&w.keeper]);
        assert_code(
            send(
                &mut c,
                with_account(ix.clone(), cix::release_at::CITIZEN, w.a.citizen(&z.key())),
            ),
            E::BadAddress,
        );
        let s = c.data(&ck)[C::JOIN_SHARD];
        assert_code(
            send(
                &mut c,
                with_account(ix.clone(), cix::release_at::JOINSHARD, w.a.join_shard(1, s)),
            ),
            E::BadAddress,
        );
        let pool_copy = copy_to_fresh(&mut c, &w.a.defence_pool(), b"dpool");
        assert_code(
            send(
                &mut c,
                with_account(ix.clone(), cix::release_at::DPOOL, pool_copy),
            ),
            E::BadAddress,
        );
        let mut f = c.fork();
        f.edit(&w.a.defence_pool(), |d| d[8] ^= 1); // another season's pool
        assert_code(f.send(&[ix], &[&w.keeper]), E::BadAccount);
    }
    // pool_owed (crafted with its lamports, W4-B's SettleTransit) is swept.
    let owed = 12_345u64;
    c.edit(&hk, |d| {
        d[H::POOL_OWED..H::POOL_OWED + 8].copy_from_slice(&owed.to_le_bytes())
    });
    let mut acc = c.account(&hk).unwrap();
    acc.lamports += owed;
    c.put(hk, c.program, acc.data.clone(), acc.lamports);
    let pool = w.a.defence_pool();
    let (pool_before, wallet_before, h_lamports) =
        (c.lamports(&pool), c.lamports(&a.key()), c.lamports(&hk));
    let watches = [
        ChainTrack::new(&c, ck, EntityKind::Citizen),
        ChainTrack::new(&c, pk, EntityKind::Province),
        ChainTrack::new(&c, shard, EntityKind::JoinShard),
    ];
    let l = expect_lands(rel(&mut c, a.key()), "ReleaseDormant");
    for x in &watches {
        x.check(&c, &l.logs, 1);
    }
    assert!(c.is_absent(&hk));
    assert_eq!(c.lamports(&pool), pool_before + owed);
    assert_eq!(c.lamports(&a.key()), wallet_before + h_lamports - owed);
    let pd = c.data(&pk);
    assert_eq!(pd[PV::site(0) + SM::STATE], SM::STATE_RELEASED_FREE);
    assert_eq!(
        pd[PV::site(0) + SM::GEN],
        1,
        "kept: the next founding bumps it"
    );
    assert_eq!(pd[PV::N_SITES_USED], 0);
    let d = c.data(&ck);
    assert_eq!(d[C::FLAGS] & C::FLAG_REFUGEE, C::FLAG_REFUGEE);
    assert_eq!(
        d[C::FLAGS] & (C::FLAG_PROVISIONAL | C::FLAG_FIRST_HOLDING_FINAL),
        0
    );
    let jd = c.data(&shard);
    assert_eq!(rd_u32(&jd, JS::HOLDINGS), 0);
    assert_eq!(rd_u32(&jd, JS::RELEASED), 1);
    one(&l.logs, Kind::RELEASE);
    one(&l.logs, Kind::POOL_SWEEP);
    let close = one(&l.logs, Kind::CLOSE);
    assert_eq!(close.field("recipient", true), a.key().as_ref());
    // Re-creation of the Holding: a new ticket founds it again, gen 2.
    let b = w.citizen(&mut c, "b", 0);
    let b_bell = w.now_bell(&c);
    file(&w, &mut c, &b, &[site(p0, 0)]);
    w.seed_ready(&mut c, b_bell, region(p0.0, p0.1));
    // v1.5 §6: a creation record after CLOSE starts a new chain at the
    // same address (seq 1 from a zero head).
    let hw = ChainTrack::new(&c, hk, EntityKind::Holding);
    assert_eq!(hw.before, (0, [0; 32]));
    let l = expect_lands(
        w.settle_ticket(&mut c, &b, 0, None),
        "fresh on a released site",
    );
    let links = hw.check(&c, &l.logs, 1);
    assert_eq!(links[0].seq, 1, "the re-created Holding's chain restarts");
    assert_eq!(
        one(&l.logs, Kind::SETTLE).u64("outcome"),
        settle_outcome::FRESH as u64
    );
    assert_eq!(c.data(&hk)[H::GEN], 2);
    // The refugee may file again.
    expect_lands(w.file_ticket(&mut c, &a, &[site(p0, 1)]), "refugee refiles");
}

#[test]
fn citizen_season_end_closes_holding_and_citizen() {
    let (mut c, w, ring2) = land();
    let a = w.citizen(&mut c, "a", 0);
    let b = w.citizen(&mut c, "b", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0)]);
    w.seed_ready(&mut c, bell, region(p0.0, p0.1));
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "fresh");
    file(&w, &mut c, &b, &[site(p0, 1)]); // b keeps an open ticket (escrow)
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let h = cix::HoldingRef {
        p: p0.0,
        q: p0.1,
        site: 0,
    };
    let close_h = |c: &mut Chain, payer: Address| {
        let ix = cix::close_holding(&w.a, w.keeper.pubkey(), h, payer);
        c.send(&[ix], &[&w.keeper])
    };
    let close_c = |c: &mut Chain, who: &Citizen, funder: Option<Address>| {
        let ix = cix::close_citizen(&w.a, w.keeper.pubkey(), &who.key(), who.key(), funder);
        c.send(&[ix], &[&w.keeper])
    };
    assert_code(close_h(&mut c, a.key()), E::WrongStatus);
    w.craft_status(&mut c, S::STATUS_ENDED);
    c.set_time(w.end_ts() + 72 * 3_600 - 1);
    assert_code(close_h(&mut c, a.key()), E::TooEarly);
    assert_code(close_c(&mut c, &a, None), E::TooEarly);
    c.advance(1);
    assert_code(close_h(&mut c, keypair(b"x").pubkey()), E::BadAddress);
    let hw = ChainTrack::new(&c, hk, EntityKind::Holding);
    let (before, hl) = (c.lamports(&a.key()), c.lamports(&hk));
    let l = expect_lands(close_h(&mut c, a.key()), "CloseHolding");
    hw.check(&c, &l.logs, 1);
    assert!(c.is_absent(&hk));
    assert_eq!(c.lamports(&a.key()), before + hl);
    // CloseCitizen: a has no escrow, b has one (its funder must be listed).
    assert_code(close_c(&mut c, &a, Some(a.key())), E::TooManyAccounts);
    let ak = w.a.citizen(&a.key());
    let (before, cl) = (c.lamports(&a.key()), c.lamports(&ak));
    let l = expect_lands(close_c(&mut c, &a, None), "CloseCitizen");
    assert!(c.is_absent(&ak));
    assert_eq!(c.lamports(&a.key()), before + cl);
    assert_eq!(one(&l.logs, Kind::CLOSE).u64("lamports"), cl);
    assert_code(close_c(&mut c, &b, None), E::TooManyAccounts);
    assert_code(
        close_c(&mut c, &b, Some(keypair(b"y").pubkey())),
        E::BadAddress,
    );
    let bk = w.a.citizen(&b.key());
    let (before, cl) = (c.lamports(&b.key()), c.lamports(&bk));
    expect_lands(
        close_c(&mut c, &b, Some(b.key())),
        "CloseCitizen with escrow",
    );
    assert_eq!(
        c.lamports(&b.key()),
        before + cl,
        "escrow to the funder, rent to the payer"
    );
    // Re-creation refused: Join and SettleTicket need Running.
    assert_code(w.join(&mut c, &a.wallet, 0), E::WrongStatus);
    // Aborted: the closes run at once.
    let (mut c2, w2, r2) = land();
    let x = w2.citizen(&mut c2, "x", 0);
    let _ = r2;
    w2.craft_status(&mut c2, S::STATUS_ABORTED);
    let ix = cix::close_citizen(&w2.a, w2.keeper.pubkey(), &x.key(), x.key(), None);
    expect_lands(c2.send(&[ix], &[&w2.keeper]), "CloseCitizen (Aborted)");
    let _ = DP::SIZE;
}

// ------------------------------------------------------------ G2

#[test]
fn g02_prefund_citizen_join() {
    let (base, w, _) = land();
    let rent = base.rent(C::SIZE);
    for pre in prefunds(rent) {
        let mut c = base.fork();
        let who = c.funded(b"pre-join", 10);
        let ck = w.a.citizen(&who.pubkey());
        c.prefund(&ck, pre);
        let before = c.lamports(&who.pubkey());
        let l = expect_lands(w.join(&mut c, &who, 0), "Join pre-funded");
        assert_eq!(paid(before, &c, &who, &l), rent.saturating_sub(pre));
        assert_program_account(&c, &ck, C::MAGIC, C::SIZE, 1);
    }
}

#[test]
fn g02_prefund_holding_settle_ticket_fresh() {
    let (mut base, w, ring2) = land();
    let a = w.citizen(&mut base, "a", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&base);
    file(&w, &mut base, &a, &[site(p0, 0)]);
    w.seed_ready(&mut base, bell, region(p0.0, p0.1));
    let rent = base.rent(H::SIZE);
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    for pre in prefunds(rent) {
        let mut c = base.fork();
        c.prefund(&hk, pre);
        let before = c.lamports(&w.keeper.pubkey());
        let l = expect_lands(
            w.settle_ticket(&mut c, &a, 0, None),
            "SettleTicket pre-funded",
        );
        assert_eq!(paid(before, &c, &w.keeper, &l), 0);
        assert_eq!(
            c.lamports(&hk),
            pre + rent,
            "the whole escrow moves; the extra stays"
        );
        assert_eq!(c.lamports(&w.a.citizen(&a.key())), c.rent(C::SIZE));
        assert_program_account(&c, &hk, H::MAGIC, H::SIZE, 1);
    }
}

// ------------------------------------------------------------ G1

fn trace_on() -> bool {
    std::env::var("PSF_TRACE").is_ok_and(|v| v == "1")
}

fn measure(
    c: &Chain,
    ix: Ix,
    label: &str,
    ixs: &[permutation_frontier_svm_tests::Instruction],
    signers: &[&Keypair],
) -> u64 {
    let need = c
        .measure(ixs, signers)
        .unwrap_or_else(|f| panic!("{label}: {f:?}"));
    assert_within(label, &need, &ceilings(ix, 0, c.programdata_len()));
    need.cu
}

/// §13.1 Join: 1,000 seeded wallets (CL-28) and the adversarial one, each
/// sent at the client profile (the 25k budget as CU limit); the worst
/// re-measured against every ceiling.
#[test]
fn g01_join_seeded_wallets() {
    let (mut c, w, _) = land();
    let mut worst = (0u64, 0u32);
    let mut all = wallets::wallets(wallets::SEEDED);
    all.push(wallets::adversarial());
    for (i, k) in all.iter().enumerate() {
        c.airdrop(&k.pubkey(), 100_000_000);
        let ix = w.join_ix(k, (i % 6) as u8);
        let l = expect_lands(c.send_client(&[ix], &[k]), "Join at the 25k limit");
        worst = worst.max((l.cu, i as u32));
    }
    println!(
        "Join over {} wallets: worst {} CU (wallet #{})",
        all.len(),
        worst.0,
        worst.1
    );
    let (mut c2, w2, _) = land();
    let k = &all[worst.1 as usize];
    c2.airdrop(&k.pubkey(), 100_000_000);
    measure(
        &c2,
        Ix::Join,
        "Join (worst wallet)",
        &[w2.join_ix(k, (worst.1 % 6) as u8)],
        &[k],
    );
    if trace_on() {
        let mut t = Chain::new(Build::Trace);
        let (wt, _) = World::land(&mut t, 1, 0);
        t.airdrop(&k.pubkey(), 100_000_000);
        measure(
            &t,
            Ix::Join,
            "Join (trace build)",
            &[wt.join_ix(k, 0)],
            &[k],
        );
    }
}

/// Three sites in three provinces whose cohort tables hold seven open
/// cohorts each (the eighth record is the free one).
fn full_cohort_world(c: &mut Chain) -> (World, [Site; 3]) {
    let (w, ring2) = World::land(c, 1, 0);
    let ring3 = w.open_provinces(c, 3, Some(0));
    let sites = [site(ring2[0], 0), site(ring2[1], 0), site(ring3[0], 0)];
    for b in 0..7 {
        let x = w.citizen(c, &format!("fill{b}"), 0);
        expect_lands(w.file_ticket(c, &x, &sites), "filler ticket");
        c.advance(600);
    }
    (w, sites)
}

#[test]
fn g01_file_ticket_three_provinces_full_cohorts() {
    // The trace build first (heap), so its figure is printed whatever the
    // plain build's CU verdict.
    if trace_on() {
        let mut t = Chain::new(Build::Trace);
        let (wt, sites) = full_cohort_world(&mut t);
        let a = wt.citizen(&mut t, "a", 0);
        let tn = t
            .measure(&[wt.file_ticket_ix(&a, &sites)], &[&a.wallet])
            .expect("measure (trace)");
        println!("FileTicket (trace build): {tn}");
        assert!(tn.heap.expect("trace heap") <= ceilings(Ix::FileTicket, 0, 0).heap);
    }
    let mut c = Chain::test_beacon();
    let (w, sites) = full_cohort_world(&mut c);
    let a = w.citizen(&mut c, "a", 0);
    let ix = w.file_ticket_ix(&a, &sites);
    measure(
        &c,
        Ix::FileTicket,
        "FileTicket (3 provinces, 7 open cohorts each)",
        std::slice::from_ref(&ix),
        &[&a.wallet],
    );
    expect_lands(
        c.send_client(&[ix], &[&a.wallet]),
        "FileTicket at the 14k limit",
    );
}

/// A displacement at site k = 0 of a three-province ticket, with the
/// displaced rent payer, Citizen and JoinShard (the largest account list).
fn displacement_setup(c: &mut Chain, crafted_seed: bool) -> (World, Citizen, Displaced) {
    let (w, sites) = full_cohort_world(c);
    let x = w.citizen(c, "x", 0);
    let y = w.citizen(c, "y", 0);
    let bell = w.now_bell(c);
    expect_lands(w.file_ticket(c, &x, &sites), "x");
    expect_lands(w.file_ticket(c, &y, &sites), "y");
    let r0 = region(sites[0].p, sites[0].q);
    if crafted_seed {
        let a = w.bell_end(bell);
        w.craft_seed(c, bell, r0, a, [0x42; 32]);
        c.set_time(a + 3_600);
    } else {
        w.seed_ready(c, bell, r0);
    }
    let seed = w.bell_seed(c, bell, r0);
    let (lo, hi) = if w.score_of(&seed, &x, sites[0]) < w.score_of(&seed, &y, sites[0]) {
        (x, y)
    } else {
        (y, x)
    };
    // DECISIONS K9 (integ-W4): the fresh settle waits while an earlier
    // cohort is open, so it lands at bell + 23, when the seven filler
    // cohorts (bells bell − 7 … bell − 1) have expired and this ticket has
    // not (bell + 24). The records stay in the tables (expiry does not
    // rewrite them), so the displacement below still scans the full table.
    c.set_time(w.genesis_ts() + (bell as i64 + 23) * 600 + 1);
    expect_lands(w.settle_ticket(c, &lo, 0, None), "fresh");
    let d = w.displaced_at(c, sites[0].p, sites[0].q, 0, 0);
    (w, hi, d)
}

#[test]
fn g01_settle_ticket_displacement_three_provinces() {
    let mut c = Chain::test_beacon();
    let (w, hi, d) = displacement_setup(&mut c, false);
    let ix = w.settle_ticket_ix(&c, &hi, 0, Some(&d));
    assert_eq!(
        ix.accounts.len(),
        14,
        "the largest SettleTicket account list"
    );
    measure(
        &c,
        Ix::SettleTicket,
        "SettleTicket (displace, 3 provinces)",
        std::slice::from_ref(&ix),
        &[&w.keeper],
    );
    let l = expect_lands(
        c.send_client(&[ix], &[&w.keeper]),
        "SettleTicket at the 40k limit",
    );
    assert_eq!(
        one(&l.logs, Kind::SETTLE).u64("outcome"),
        settle_outcome::DISPLACE as u64
    );
    if trace_on() {
        let mut t = Chain::new(Build::Trace);
        let (wt, hi, d) = displacement_setup(&mut t, true);
        let ix = wt.settle_ticket_ix(&t, &hi, 0, Some(&d));
        measure(
            &t,
            Ix::SettleTicket,
            "SettleTicket (trace build, crafted seed)",
            &[ix],
            &[&wt.keeper],
        );
    }
}

/// Every other W3-A instruction at its largest account list (§13.1 "all
/// others"), measured and asserted against the §5.5 ceilings.
#[test]
fn g01_land_other_instructions() {
    // W5-A: on the release binary (seeds crafted), and every row also runs
    // `L(kind)` at its programdata length (`common::loaded_check(`).
    let mut c = Chain::release();
    let (w, ring2) = World::land_long(&mut c, 1, 0);
    let k = w.keeper.insecure_clone();
    let mut rows: Vec<(Ix, String, Need)> = vec![];
    let mut m = |c: &Chain,
                 ix: Ix,
                 label: &str,
                 ixs: &[permutation_frontier_svm_tests::Instruction],
                 s: &[&Keypair]| {
        let need = c
            .measure(ixs, s)
            .unwrap_or_else(|f| panic!("{label}: {f:?}"));
        common::loaded_check(c, ix, ixs, s);
        rows.push((ix, label.to_string(), need));
    };
    // OpenRing beyond g (the longer path): a bell later, wedge 0 at θ
    // (crafted folded occupancy, as in tests/map.rs).
    w.fold(&mut c);
    let mut f = c.fork();
    f.advance(600);
    let open0 = rd_u32(&f.data(&w.a.frontier()), FR::WEDGE_OPEN);
    f.edit(&w.a.frontier(), |d| {
        d[FR::WEDGE_OCCUPIED..FR::WEDGE_OCCUPIED + 4].copy_from_slice(&open0.to_le_bytes())
    });
    m(
        &f,
        Ix::OpenRing,
        "OpenRing (ring 4, 6 funds)",
        &[w.open_ring_ix(4)],
        &[&k],
    );
    for part in 0..3 {
        m(
            &c,
            Ix::FoldOccupancy,
            &format!("FoldOccupancy part {part}"),
            &[w.fold_ix(part)],
            &[&k],
        );
        expect_lands(w.fold_part(&mut c, part), "fold");
    }
    let a = w.citizen(&mut c, "a", 0);
    let session = keypair(b"s");
    m(
        &c,
        Ix::SetSession,
        "SetSession",
        &[cix::set_session(
            &w.a,
            &a.player(),
            &session.pubkey(),
            c.now + 60,
        )],
        &[&a.wallet],
    );
    m(
        &c,
        Ix::SetVigil,
        "SetVigil",
        &[cix::set_vigil(&w.a, &a.player(), 120)],
        &[&a.wallet],
    );
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0)]);
    let at = w.bell_end(bell);
    w.craft_seed(&mut c, bell, region(p0.0, p0.1), at, [0x42; 32]);
    c.set_time(at + 3_600);
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "fresh");
    let h = cix::HoldingRef {
        p: p0.0,
        q: p0.1,
        site: 0,
    };
    let last = rd_i64(
        &c.data(&w.a.holding(p0.0 as i32, p0.1 as i32, 0)),
        H::LAST_OWNER_ACTION,
    );
    let mut f = c.fork();
    f.set_time(last + 864_000);
    let rel = cix::release_dormant(&w.a, k.pubkey(), h, &a.key(), 0, a.key());
    m(&f, Ix::ReleaseDormant, "ReleaseDormant", &[rel], &[&k]);
    w.craft_status(&mut c, S::STATUS_ABORTED);
    m(
        &c,
        Ix::CloseHolding,
        "CloseHolding",
        &[cix::close_holding(&w.a, k.pubkey(), h, a.key())],
        &[&k],
    );
    let b = w.citizen(&mut f, "b", 0);
    file(&w, &mut f, &b, &[site(p0, 1)]);
    w.craft_status(&mut f, S::STATUS_ABORTED);
    m(
        &f,
        Ix::CloseCitizen,
        "CloseCitizen (escrow to the funder)",
        &[cix::close_citizen(
            &w.a,
            k.pubkey(),
            &b.key(),
            b.key(),
            Some(b.key()),
        )],
        &[&k],
    );
    m(
        &c,
        Ix::CloseProvince,
        "CloseProvince",
        &[permutation_frontier_svm_tests::ix::map::close_province(
            &w.a,
            k.pubkey(),
            p0.0,
            p0.1,
        )],
        &[&k],
    );
    let mut over = vec![];
    for (ix, label, need) in &rows {
        let ce = ceilings(*ix, 0, c.programdata_len());
        println!("{label}: {need} (budget {} CU)", ce.cu);
        if need.cu > ce.cu as u64 {
            over.push(format!("{label}: {} CU > {}", need.cu, ce.cu));
        }
        assert!(
            need.tx_bytes as u32 <= ce.tx_bytes && need.loaded <= ce.loaded as u64,
            "{label}"
        );
    }
    assert!(over.is_empty(), "over budget: {over:?}");
}

// ================================================================ W5-A: G13 completion

/// A running release season with the genesis rings and ring 2 of wedge 0.
fn land_release() -> (Chain, World, Vec<(i16, i16)>) {
    let mut c = Chain::release();
    let (w, v) = World::land(&mut c, 1, 0);
    (c, w, v)
}

/// Join with the wallet not signing (the relay pays): `Auth`; `L(Join)`.
/// SetSession on an Ended season (`WrongStatus`) and with a Citizen of
/// another season at the canonical address (`BadAccount`); SetVigil on a
/// Season of another ruleset (`RulesetMismatch`).
#[test]
fn citizen_g13_join_session_vigil() {
    let (mut c, w, _) = land_release();
    let who = c.funded(b"g13-joiner", 10);
    let relay = c.funded(b"g13-relay", 10);
    let ix = cix::join(
        &w.a,
        who.pubkey(),
        relay.pubkey(),
        2,
        &Address::default(),
        0,
        None,
    );
    assert_code(
        c.fork().send(&[without_signer(ix.clone(), 0)], &[&relay]),
        E::Auth,
    );
    common::loaded_check(&c, Ix::Join, std::slice::from_ref(&ix), &[&relay, &who]);
    let a = w.citizen(&mut c, "a", 0);
    let session = keypair(b"g13-session");
    let set = cix::set_session(&w.a, &a.player(), &session.pubkey(), c.now + 60);
    let mut f = c.fork();
    w.craft_status(&mut f, S::STATUS_ENDED);
    assert_code(
        f.send(std::slice::from_ref(&set), &[&a.wallet]),
        E::WrongStatus,
    );
    let mut f = c.fork();
    f.edit(&w.a.citizen(&a.key()), |d| d[8] ^= 1);
    assert_code(f.send(&[set], &[&a.wallet]), E::BadAccount);
    let mut f = c.fork();
    f.edit(&w.a.season, |d| d[S::RULESET_HASH] ^= 1);
    assert_code(
        f.send(&[cix::set_vigil(&w.a, &a.player(), 120)], &[&a.wallet]),
        E::RulesetMismatch,
    );
}

/// FileTicket: a Province's bytes at another address (`BadAddress`), a
/// fourth Province account (`TooManyAccounts`); `L(FileTicket)` with
/// three Provinces.
#[test]
fn citizen_g13_file_ticket_forgery_shape_loaded() {
    let (mut c, w, ring2) = land_release();
    let ring3 = w.open_provinces(&mut c, 3, Some(0));
    let sites = [site(ring2[0], 0), site(ring2[1], 0), site(ring3[0], 0)];
    let a = w.citizen(&mut c, "a", 0);
    let ix = w.file_ticket_ix(&a, &sites);
    let pk = w.a.province(sites[0].p as i32, sites[0].q as i32);
    let fake = copy_to_fresh(&mut c, &pk, b"g13 province");
    assert_code(
        c.fork().send(
            &[with_account(ix.clone(), player_at::PROVINCE0, fake)],
            &[&a.wallet],
        ),
        E::BadAddress,
    );
    let mut extra = ix.clone();
    extra
        .accounts
        .push(solana_instruction::AccountMeta::new_readonly(
            w.a.province(ring3[1].0 as i32, ring3[1].1 as i32),
            false,
        ));
    // The shape check, not the loaded-data limit: `L(FileTicket)` has no
    // room for a fourth Province (W6-B: the release `.so` grew 2,264 B, one
    // more 4-KiB page of `max_len`, and the 267-B margin this relied on
    // went), so this send asks for one Province (and a page) more.
    let extra_room = frontier_abi::v2::layout::province::province::SIZE as u32 + 4_096;
    let p = c
        .profile_of(&[extra.clone()], Profile::ladder)
        .with_loaded(loaded_limit(Ix::FileTicket, c.programdata_len()) + extra_room);
    assert_code(
        c.fork().send_with(&p, &[extra], &[&a.wallet]),
        E::TooManyAccounts,
    );
    common::loaded_check(&c, Ix::FileTicket, &[ix], &[&a.wallet]);
}

/// SettleTicket's archive-entry seed path (`[archive] [archive]`): with the
/// ticket bell's anchor and cache gone and an AnchorArchive holding the
/// same `A` and seed, the settlement lands with the same outcome and the
/// same Holding as through the cache. (A real ArchiveAnchors cannot reach
/// an open ticket: `archive_after` ≥ 48 h, a ticket expires after 24 bells,
/// and an expired ticket settles without a seed; the archive is crafted
/// as ArchiveAnchors writes it.) Then `L(SettleTicket)` at the largest
/// account list (a displacement of a three-province ticket).
#[test]
fn citizen_g13_settle_ticket_archive_path_and_loaded() {
    use frontier_abi::layout::beacon::{anchor_archive as AA, archive_entry as AE};
    use permutation_frontier_svm_tests::world::archive_part;
    let (mut c, w, ring2) = land_release();
    let a = w.citizen(&mut c, "a", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0)]);
    let r0 = region(p0.0, p0.1);
    let at = w.bell_end(bell) + 17;
    w.craft_seed(&mut c, bell, r0, at, [0x5a; 32]);
    c.set_time(at + 3_600);
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let mut via_cache = c.fork();
    let l1 = expect_lands(
        w.settle_ticket(&mut via_cache, &a, 0, None),
        "via the cache",
    );
    let arch = w.craft_archive(&mut c, r0, archive_part(bell), &[bell]);
    c.edit(&arch, |d| {
        let o = AA::entry(bell);
        let a_off = (at - w.bell_end(bell)) as u32;
        d[o + AE::A_OFF..o + AE::A_OFF + 4].copy_from_slice(&a_off.to_le_bytes());
        d[o + AE::SEED..o + AE::SEED + 32].copy_from_slice(&[0x5a; 32]);
    });
    c.remove(&w.a.anchor(bell, r0));
    c.remove(&w.a.seed_cache(bell, r0, 0));
    let ix = w.settle_ticket_ix_src(&c, &a, 0, None, SeedSource::Archive);
    let l2 = expect_lands(c.send(&[ix], &[&w.keeper]), "via the archive");
    assert_eq!(c.data(&hk), via_cache.data(&hk), "the same Holding");
    assert_eq!(
        one(&l1.logs, Kind::SETTLE).u64("outcome"),
        one(&l2.logs, Kind::SETTLE).u64("outcome")
    );
    // L(SettleTicket): the displacement list (crafted seed, release).
    let mut d = Chain::release();
    let (wd, hi, disp) = displacement_setup(&mut d, true);
    let ix = wd.settle_ticket_ix(&d, &hi, 0, Some(&disp));
    assert_eq!(ix.accounts.len(), 14);
    common::loaded_check(&d, Ix::SettleTicket, &[ix], &[&wd.keeper]);
}

/// ReleaseDormant, CloseHolding and CloseCitizen with a forged account:
/// the Holding or the Citizen of another season at its canonical address
/// (`BadAccount`).
#[test]
fn citizen_g13_season_end_closes_refuse_forgeries() {
    let mut c = Chain::release();
    let (w, ring2) = World::land_long(&mut c, 1, 0);
    let a = w.citizen(&mut c, "a", 0);
    let p0 = ring2[0];
    let bell = w.now_bell(&c);
    file(&w, &mut c, &a, &[site(p0, 0)]);
    let at = w.bell_end(bell);
    w.craft_seed(&mut c, bell, region(p0.0, p0.1), at, [0x42; 32]);
    c.set_time(at + 3_600);
    expect_lands(w.settle_ticket(&mut c, &a, 0, None), "fresh");
    let h = cix::HoldingRef {
        p: p0.0,
        q: p0.1,
        site: 0,
    };
    let hk = w.a.holding(p0.0 as i32, p0.1 as i32, 0);
    let ck = w.a.citizen(&a.key());
    let k = w.keeper.insecure_clone();
    let last = rd_i64(&c.data(&hk), H::LAST_OWNER_ACTION);
    let mut f = c.fork();
    f.set_time(last + 864_000);
    let rel = cix::release_dormant(&w.a, k.pubkey(), h, &a.key(), 0, a.key());
    let mut g = f.fork();
    g.edit(&hk, |d| d[8] ^= 1);
    assert_code(g.send(std::slice::from_ref(&rel), &[&k]), E::BadAccount);
    let mut g = f.fork();
    g.edit(&ck, |d| d[8] ^= 1);
    assert_code(g.send(std::slice::from_ref(&rel), &[&k]), E::BadAccount);
    expect_lands(f.send(&[rel], &[&k]), "ReleaseDormant");
    w.craft_status(&mut c, S::STATUS_ABORTED);
    let ch = cix::close_holding(&w.a, k.pubkey(), h, a.key());
    let mut g = c.fork();
    g.edit(&hk, |d| d[8] ^= 1);
    assert_code(g.send(std::slice::from_ref(&ch), &[&k]), E::BadAccount);
    expect_lands(c.send(&[ch], &[&k]), "CloseHolding");
    let cc = cix::close_citizen(&w.a, k.pubkey(), &a.key(), a.key(), None);
    let mut g = c.fork();
    g.edit(&ck, |d| d[8] ^= 1);
    assert_code(g.send(std::slice::from_ref(&cc), &[&k]), E::BadAccount);
    expect_lands(c.send(&[cc], &[&k]), "CloseCitizen");
}

// ------------------------------------------------------------ MC (CQ2-A): outposts, slots, S3

mod cq {
    //! MC contract §3.8, §3.15, §5.2.3, §5.5, §5.6 on the test-beacon build,
    //! `MC_TEST` (heartland rings 2, Free Cities from ring 3, outposts from a
    //! Hamlet, a 2-h outpost shield), so ring 3 (a genesis ring) is outpost
    //! land. Crafted state is named where used.

    use super::*;
    use frontier_abi::v2::layout::player::citizen as C2;
    use frontier_abi::v2::layout::province::{conquest as CR, province as PV2, site as SM2};
    use frontier_abi::v2::layout::world::join_shard as JS2;
    use frontier_abi::v2::log::CqKind;
    use frontier_abi::v2::presets::MC_TEST;
    use frontier_abi::v2::CqError as Cq;
    use permutation_frontier_svm_tests::ix::citizen::outpost_at;
    use permutation_frontier_svm_tests::ix::map as mix;
    use permutation_frontier_svm_tests::records::{any_records, one_cq};
    use permutation_frontier_svm_tests::world::holding::{read_kholding, Estate};
    use permutation_rules::fixed::MILLI;
    use permutation_rules::frontier::geometry::ProvinceCoord;
    use permutation_rules::frontier::holding::duplicate_cost;

    pub(super) fn mc_test() -> (Chain, World) {
        let mut c = Chain::test_beacon();
        let w = World::land_v2(&mut c, 1, MC_TEST);
        (c, w)
    }

    pub(super) fn dist(a: (i16, i16), b: (i16, i16)) -> u32 {
        ProvinceCoord::new(a.0 as i32, a.1 as i32)
            .distance(ProvinceCoord::new(b.0 as i32, b.1 as i32))
    }

    /// The first ring-3 province of `wedge` within `range` of `home`,
    /// opened if absent.
    pub(super) fn front(c: &mut Chain, w: &World, home: (i16, i16), wedge: u8) -> (i16, i16) {
        let t = provinces_of(3, Some(wedge))
            .into_iter()
            .find(|t| dist(home, *t) <= 3)
            .expect("a ring-3 province within 3");
        if c.is_absent(&w.a.province(t.0 as i32, t.1 as i32)) {
            expect_lands(w.open_province(c, t.0, t.1), "OpenProvince (ring 3)");
        }
        t
    }

    pub(super) fn send(
        c: &mut Chain,
        e: &Estate,
        ix: permutation_frontier_svm_tests::Instruction,
    ) -> permutation_frontier_svm_tests::chain::SendResult {
        c.send(&[ix], &[&e.wallet])
    }

    /// The settler cost of a citizen with `n` holdings (MC §3.8), milli.
    pub(super) fn settler(n: u8) -> [i64; 8] {
        let mut c = [0i64; 8];
        for (r, b) in catalog::SETTLER_COST.iter().enumerate() {
            c[r] = duplicate_cost(*b as u64, n as u32).unwrap() as i64 * MILLI;
        }
        c
    }

    fn slot_ref(d: &[u8], slot: u8) -> (i16, i16, u8, u8) {
        let o = C2::holding_of_slot(slot);
        (
            rd_u16(d, o + HR::P) as i16,
            rd_u16(d, o + HR::Q) as i16,
            d[o + HR::SITE],
            d[o + HR::GEN],
        )
    }

    /// Join writes the slot-indexed list empty (MC §5.2.3).
    #[test]
    fn cq_join_writes_empty_slots() {
        let (mut c, w) = mc_test();
        let a = w.citizen(&mut c, "a", 0);
        let d = w.citizen_data(&c, &a);
        for slot in 1..=3 {
            assert_eq!(slot_ref(&d, slot), (0, 0, 0, C2::EMPTY_GEN), "slot {slot}");
        }
        assert_eq!(d[C2::SLOTS], 0);
        assert_eq!(d[C::HOLDINGS_N], 0);
    }

    /// FileOutpost files a slot-2 ticket at the front; SettleTicket founds
    /// the outpost there; a second one takes slot 3; then the slots are
    /// full (MC §3.8, §5.5, §5.6, K-25).
    #[test]
    fn cq_outpost_files_and_settles_into_slots_2_and_3() {
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        w.fold(&mut c);
        let rent_h = c.rent(H::SIZE);
        let anchor0 = read_kholding(&c.data(&e.holding));
        let bell = w.now_bell(&c);
        let watches = [
            ChainTrack::new(&c, e.citizen, EntityKind::Citizen),
            ChainTrack::new(&c, e.holding, EntityKind::Holding),
        ];
        let before = c.lamports(&e.wallet.pubkey());
        let l = expect_lands(
            send(&mut c, &e, w.file_outpost_ix(&e, &[site(t, s0)], &e)),
            "FileOutpost",
        );
        for x in &watches {
            x.check(&c, &l.logs, 1);
        }
        assert_eq!(paid(before, &c, &e.wallet, &l), rent_h, "one Holding rent");
        let d = c.data(&e.citizen);
        assert_eq!(d[C2::SLOTS] & C2::SLOTS_TICKET_MASK, 2, "the ticket's slot");
        assert_eq!(rd_u32(&d, C::TICKET_BELL), bell);
        assert_eq!(rd_u64(&d, C::TICKET_ESCROW), rent_h);
        assert_eq!(cohort(&c, &w, t, bell), Some((1, 0)));
        // The settler cost (one holding: × 1) left the anchor's stores.
        let mut want = anchor0.clone();
        want.settle(c.now).unwrap();
        want.touch_owner(c.now).unwrap();
        want.commit_walls(c.now);
        want.pay(c.now, &settler(1)).unwrap();
        assert_eq!(read_kholding(&c.data(&e.holding)), want);
        one(&l.logs, Kind::TICKET);
        let h = one(&l.logs, Kind::HARVEST);
        assert_eq!(h.key[8], e.site, "the anchor's stores digest");
        // A second ticket is refused while one is open.
        assert_code(
            send(&mut c, &e, w.file_outpost_ix(&e, &[site(t, s0)], &e)),
            E::TicketState,
        );
        // Settles into slot 2.
        let hk = w.a.holding(t.0 as i32, t.1 as i32, s0);
        let pk = w.a.province(t.0 as i32, t.1 as i32);
        let shard = {
            let d = c.data(&e.citizen);
            w.a.join_shard(d[C::FACTION], d[C::JOIN_SHARD])
        };
        let watches = [
            ChainTrack::new(&c, e.citizen, EntityKind::Citizen),
            ChainTrack::new(&c, pk, EntityKind::Province),
            ChainTrack::new(&c, shard, EntityKind::JoinShard),
        ];
        let l = expect_lands(
            w.settle_estate_ticket(&mut c, &e, 0, None),
            "SettleTicket (outpost)",
        );
        for x in &watches {
            x.check(&c, &l.logs, 1);
        }
        let now = c.now;
        let nb = w.now_bell(&c);
        let hd = c.data(&hk);
        assert_eq!(hd[H::ORDER], 2);
        assert_eq!(hd[H::GEN], 1);
        assert_eq!(hd[H::STATE], H::STATE_PROVISIONAL);
        assert_eq!(
            &hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32],
            e.citizen.as_ref()
        );
        assert_eq!(
            rd_i64(&hd, H::SHIELD_UNTIL),
            now + MC_TEST.cq.outpost_shield_secs as i64
        );
        let mut want = Holding::found(now, nb / 144, 2);
        want.production = catalog::base_production(Tier::Hamlet);
        for r in 0..8 {
            assert_eq!(rd_u64(&hd, H::store(r)), 0, "no starter kit (store {r})");
            assert_eq!(
                rd_u64(&hd, H::PRODUCTION + 8 * r) as i64,
                want.production[r]
            );
        }
        let pd = c.data(&pk);
        let o = PV::site(s0 as usize);
        assert_eq!(pd[o + SM::STATE], SM::STATE_HOLDING);
        assert_eq!(pd[o + SM::ORDER], 2);
        assert_eq!(pd[o + SM::FACTION], 0);
        assert_eq!(
            rd_u16(&pd, o + SM2::HELD_SINCE_HOUR),
            nb.div_ceil(6) as u16,
            "held_since_hour = ⌈b / 6⌉"
        );
        assert!(
            pd[PV2::record(s0 as usize)..PV2::record(s0 as usize) + CR::SIZE]
                .iter()
                .all(|b| *b == 0)
        );
        let d = c.data(&e.citizen);
        assert_eq!(slot_ref(&d, 2), (t.0, t.1, s0, 1));
        assert_eq!(slot_ref(&d, 3).3, C2::EMPTY_GEN);
        assert_eq!(d[C::HOLDINGS_N], 2);
        assert_eq!(d[C2::SLOTS], 0, "the ticket ended");
        assert_eq!(rd_u64(&d, C::TICKET_ESCROW), 0);
        assert_eq!(
            d[C::FLAGS] & C::FLAG_FIRST_HOLDING_FINAL,
            C::FLAG_FIRST_HOLDING_FINAL,
            "the first holding's flags are untouched"
        );
        let jd = c.data(&shard);
        assert_eq!(rd_u32(&jd, JS2::EXTRA_HOLDINGS), 1);
        assert_eq!(rd_u32(&jd, JS2::OUTPOSTS), 1);
        assert_eq!(rd_u32(&jd, JS::HOLDINGS), 1, "first holdings only");
        let r = one_cq(&l.logs, CqKind::OUTPOST_SETTLED);
        assert_eq!(r.u64("citizen_tag"), le8(e.citizen.as_ref()));
        assert_eq!(r.u64("order"), 2);
        assert_eq!(r.u64("gen"), 1);
        assert_eq!(r.u64("shield_until") as i64, rd_i64(&hd, H::SHIELD_UNTIL));
        assert_eq!(
            one(&l.logs, Kind::SETTLE).u64("outcome"),
            settle_outcome::FRESH as u64
        );
        // The fold counts the outpost (MC §5.2.4).
        c.advance(600);
        w.fold(&mut c);
        assert_eq!(rd_u32(&c.data(&w.a.frontier()), FR::OCCUPIED_SITES), 2);
        // Slot 3: a holding in slot 2 is there; the cost doubles to × 1.5.
        let s1 = w.free_sites(&c, t.0, t.1)[0];
        let anchor1 = read_kholding(&c.data(&e.holding));
        expect_lands(
            send(&mut c, &e, w.file_outpost_ix(&e, &[site(t, s1)], &e)),
            "FileOutpost (slot 3)",
        );
        assert_eq!(c.data(&e.citizen)[C2::SLOTS] & 3, 3);
        let mut want = anchor1;
        want.settle(c.now).unwrap();
        want.touch_owner(c.now).unwrap();
        want.commit_walls(c.now);
        want.pay(c.now, &settler(2)).unwrap();
        assert_eq!(read_kholding(&c.data(&e.holding)), want, "× 1.5");
        expect_lands(
            w.settle_estate_ticket(&mut c, &e, 0, None),
            "SettleTicket (slot 3)",
        );
        let d = c.data(&e.citizen);
        assert_eq!(slot_ref(&d, 3), (t.0, t.1, s1, 1));
        assert_eq!(d[C::HOLDINGS_N], 3);
        assert_eq!(
            c.data(&w.a.holding(t.0 as i32, t.1 as i32, s1))[H::ORDER],
            3
        );
        // Every slot taken.
        let s2 = w.free_sites(&c, t.0, t.1)[0];
        let ix = w.file_outpost_ix(&e, &[site(t, s2)], &e);
        assert_code(send(&mut c, &e, ix), Cq::HoldingsFull);
    }

    fn le8(b: &[u8]) -> u64 {
        u64::from_le_bytes(b[..8].try_into().unwrap())
    }

    /// One test per FileOutpost refusal (G13, MC §3.8, §5.3, §5.5).
    #[test]
    fn g13_cq_file_outpost_refusals() {
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        w.fold(&mut c);
        let ok = w.file_outpost_ix(&e, &[site(t, s0)], &e);
        // Ring: a heartland ring (2) is not outpost land.
        let h2 = provinces_of(2, Some(0))[1];
        if c.is_absent(&w.a.province(h2.0 as i32, h2.1 as i32)) {
            expect_lands(w.open_province(&mut c, h2.0, h2.1), "OpenProvince");
        }
        let ix = w.file_outpost_ix(&e, &[site(h2, 1)], &e);
        assert_code(send(&mut c.fork(), &e, ix), Cq::OutpostRule);
        // Range: a ring-3 province farther than 3 from the anchor.
        let far = provinces_of(3, None)
            .into_iter()
            .find(|x| dist(home, *x) > 3)
            .expect("a far province");
        let mut f = c.fork();
        expect_lands(w.open_province(&mut f, far.0, far.1), "OpenProvince (far)");
        let ix = w.file_outpost_ix(&e, &[site(far, w.free_sites(&f, far.0, far.1)[0])], &e);
        assert_code(send(&mut f, &e, ix), Cq::OutpostRule);
        // Share: the faction holds ≥ 50% of the province (crafted holding
        // of faction 0 on another site).
        let mut f = c.fork();
        let s9 = w.free_sites(&f, t.0, t.1)[1];
        f.edit(&w.a.province(t.0 as i32, t.1 as i32), |d| {
            let o = PV::site(s9 as usize);
            d[o + SM::STATE] = SM::STATE_HOLDING;
            d[o + SM::FACTION] = 0;
            d[o + SM::ORDER] = 1;
            d[o + SM::GARRISON..o + SM::GARRISON + 4].copy_from_slice(&5_000_000u32.to_le_bytes());
        });
        assert_code(send(&mut f, &e, ok.clone()), Cq::OutpostRule);
        // Close: at or after `end_bell − outpost_close_bells`.
        let mut f = c.fork();
        let close = MC_TEST.base.end_bell - MC_TEST.cq.outpost_close_bells as u32;
        f.set_time(w.genesis_ts() + 600 * close as i64);
        assert_code(send(&mut f, &e, ok.clone()), Cq::OutpostRule);
        // Land gate: folded free sites below 20% of open (crafted Frontier).
        let mut f = c.fork();
        f.edit(&w.a.frontier(), |d| {
            let open = rd_u32(d, FR::OPEN_SITES);
            d[FR::OCCUPIED_SITES..FR::OCCUPIED_SITES + 4].copy_from_slice(&open.to_le_bytes());
        });
        assert_code(send(&mut f, &e, ok.clone()), E::Capacity);
        // S1: a site with a conquest record (crafted).
        let mut f = c.fork();
        f.edit(&w.a.province(t.0 as i32, t.1 as i32), |d| {
            d[PV2::record(s0 as usize) + CR::FLAGS] = CR::FLAG_SLOT_OWED;
        });
        assert_code(send(&mut f, &e, ok.clone()), Cq::SiegeBusy);
        // Prerequisite: the first holding not final (crafted flag).
        let mut f = c.fork();
        f.edit(&e.citizen, |d| d[C::FLAGS] &= !C::FLAG_FIRST_HOLDING_FINAL);
        assert_code(send(&mut f, &e, ok.clone()), Cq::OutpostRule);
        // The anchor: not final, of another generation, at another address,
        // another citizen's.
        let mut f = c.fork();
        f.edit(&e.holding, |d| d[H::STATE] = H::STATE_PROVISIONAL);
        assert_code(send(&mut f, &e, ok.clone()), E::NotFinal);
        let ix = cix::file_outpost(&w.a, &e.player(), &[site(t, s0)], e.href(), e.gen + 1);
        assert_code(send(&mut c.fork(), &e, ix), E::BadData);
        let mut ix = ok.clone();
        ix.accounts[outpost_at::anchor(1)].pubkey = w.a.holding(t.0 as i32, t.1 as i32, s0);
        assert_code(send(&mut c.fork(), &e, ix), E::BadAddress);
        let b = w.final_estate(&mut c, "b", 0, home, 1, 10_000);
        let ix = w.file_outpost_ix(&e, &[site(t, s0)], &b);
        assert_code(send(&mut c.fork(), &e, ix), E::NotOwner);
        // A captured holding cannot anchor (pinned, notes D-4) — crafted
        // as an outpost with `capture_flags` set.
        let mut f = c.fork();
        f.edit(&e.holding, |d| {
            d[H::ORDER] = 2;
            d[frontier_abi::v2::layout::player::holding::CAPTURE_FLAGS] = 1;
        });
        assert_code(send(&mut f, &e, ok.clone()), Cq::OutpostRule);
        // The anchor's stores cannot pay.
        let mut f = c.fork();
        w.edit_kholding(&mut f, &e, |h| {
            for s in h.stores.iter_mut() {
                s.value = 0;
            }
        });
        assert_code(send(&mut f, &e, ok.clone()), E::Insufficient);
        // A ring below 2 is a Seat's (as FileTicket).
        let seat = provinces_of(1, Some(0))[0];
        let ix = w.file_outpost_ix(&e, &[site(seat, 0)], &e);
        assert_code(send(&mut c.fork(), &e, ix), E::ReservedSite);
        // A missing Province account.
        let mut ix = ok.clone();
        ix.accounts.remove(outpost_at::PROVINCE0);
        assert_code(send(&mut c.fork(), &e, ix), E::TooManyAccounts);
        // Lands; then an open ticket refuses the next one.
        expect_lands(send(&mut c, &e, ok.clone()), "FileOutpost");
        assert_code(send(&mut c, &e, ok), E::TicketState);
        // A full slot list (crafted reservations of slots 2 and 3).
        let mut f = c.fork();
        f.edit(&e.citizen, |d| {
            d[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&C::NO_TICKET.to_le_bytes());
            d[C2::SLOTS] = C2::SLOTS_RESERVED_2 | C2::SLOTS_RESERVED_3;
        });
        let s1 = w.free_sites(&f, t.0, t.1)[1];
        let ix = w.file_outpost_ix(&e, &[site(t, s1)], &e);
        assert_code(send(&mut f, &e, ix), Cq::HoldingsFull);
    }

    /// The outpost founded at `t`/`s0` for `e` (slot 2), made final (the
    /// flip is crafted) and stocked, as an anchor estate.
    fn settled_outpost(c: &mut Chain, w: &World, e: &Estate, t: (i16, i16), s0: u8) -> Estate {
        expect_lands(
            send(c, e, w.file_outpost_ix(e, &[site(t, s0)], e)),
            "FileOutpost",
        );
        expect_lands(
            w.settle_estate_ticket(c, e, 0, None),
            "SettleTicket (outpost)",
        );
        let hk = w.a.holding(t.0 as i32, t.1 as i32, s0);
        let o = Estate {
            wallet: e.wallet.insecure_clone(),
            faction: e.faction,
            p: t.0,
            q: t.1,
            site: s0,
            gen: 1,
            tile: 0,
            holding: hk,
            province: w.a.province(t.0 as i32, t.1 as i32),
            citizen: e.citizen,
        };
        c.edit(&hk, |d| d[H::STATE] = H::STATE_FINAL);
        w.enrich(c, &o, 10_000);
        o
    }

    /// Review CQ2-A (§5.8, P3): an outpost anchor whose Province is listed
    /// is capture-locked from the completion on (the generation test only;
    /// `capture_flags` lifts nothing, notes D-14).
    #[test]
    fn g13_cq_file_outpost_capture_lock_on_the_anchor() {
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        w.fold(&mut c);
        let o = settled_outpost(&mut c, &w, &e, t, s0);
        c.advance(600);
        let s1 = w.free_sites(&c, t.0, t.1)[0];
        let ix = w.file_outpost_ix(&e, &[site(t, s1)], &o);
        expect_lands(
            send(&mut c.fork(), &e, ix.clone()),
            "FileOutpost (outpost anchor)",
        );
        let mut f = c.fork();
        f.edit(&o.province, |d| {
            d[PV::site(s0 as usize) + SM::GEN] = o.gen + 1
        });
        assert_code(send(&mut f, &e, ix), Cq::CapturePending);
    }

    /// Review CQ2-A (D-15): the Town prerequisite reads the anchor as an
    /// owner touch leaves it, so a finished tier-up no action has applied
    /// yet counts.
    #[test]
    fn g13_cq_file_outpost_town_prerequisite_reads_the_touched_tier() {
        use permutation_rules::frontier::holding::Effect;
        let mut c = Chain::test_beacon();
        let mut p = MC_TEST;
        p.cq.outpost_tier_min = 1;
        let w = World::land_v2(&mut c, 1, p);
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        w.fold(&mut c);
        let ok = w.file_outpost_ix(&e, &[site(t, s0)], &e);
        assert_code(send(&mut c.fork(), &e, ok.clone()), Cq::OutpostRule);
        let mut f = c.fork();
        let now = f.now;
        w.edit_kholding(&mut f, &e, |h| {
            h.enqueue(now, 10, Effect::TierUp).unwrap();
        });
        assert_eq!(read_kholding(&f.data(&e.holding)).tier, Tier::Hamlet);
        f.advance(60);
        expect_lands(send(&mut f, &e, ok), "FileOutpost");
        assert_eq!(read_kholding(&f.data(&e.holding)).tier, Tier::Town);
    }

    /// Review CQ2-A: FileOutpost's cohort table refuses a ninth open bell
    /// (as FileTicket).
    #[test]
    fn g13_cq_file_outpost_cohort_table_full_refuses_a_ninth_bell() {
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        let s1 = w.free_sites(&c, t.0, t.1)[1];
        for b in 0..8 {
            let wedge = mix::wedge_of(t.0 as i32, t.1 as i32);
            let x = w.citizen(&mut c, &format!("fill{b}"), wedge);
            expect_lands(w.file_ticket(&mut c, &x, &[site(t, s1)]), "filler ticket");
            c.advance(600);
        }
        w.fold(&mut c);
        let ix = w.file_outpost_ix(&e, &[site(t, s0)], &e);
        assert_code(send(&mut c, &e, ix), E::CohortFull);
    }

    /// Review CQ2-A: an outpost displaced inside its cohort frees its slot
    /// and its JoinShard counters, and leaves the first-holding flags alone.
    #[test]
    fn cq_outpost_displacement_frees_the_slot() {
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let a = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let b = w.final_estate(&mut c, "b", 0, home, 1, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        w.fold(&mut c);
        let bell = w.now_bell(&c);
        for x in [&a, &b] {
            expect_lands(
                send(&mut c, x, w.file_outpost_ix(x, &[site(t, s0)], x)),
                "FileOutpost",
            );
        }
        let cit = |e: &Estate| Citizen {
            wallet: e.wallet.insecure_clone(),
            faction: e.faction,
        };
        let r = region(t.0, t.1);
        w.seed_ready(&mut c, bell, r);
        let seed = w.bell_seed(&c, bell, r);
        let s = site(t, s0);
        let (lo, hi) = if w.score_of(&seed, &cit(&a), s) < w.score_of(&seed, &cit(&b), s) {
            (&a, &b)
        } else {
            (&b, &a)
        };
        expect_lands(
            w.settle_estate_ticket(&mut c, lo, 0, None),
            "SettleTicket lo",
        );
        let hk = w.a.holding(t.0 as i32, t.1 as i32, s0);
        assert_eq!(c.data(&hk)[H::ORDER], 2);
        let disp = w.displaced_at(&c, t.0, t.1, s0, 0);
        expect_lands(
            w.settle_estate_ticket(&mut c, hi, 0, Some(&disp)),
            "SettleTicket hi (displace)",
        );
        let hd = c.data(&hk);
        assert_eq!(hd[H::GEN], 2, "re-founded in place");
        assert_eq!(hd[H::ORDER], 2);
        assert_eq!(
            &hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32],
            hi.citizen.as_ref()
        );
        let ld = c.data(&lo.citizen);
        assert_eq!(slot_ref(&ld, 2), (0, 0, 0, C2::EMPTY_GEN), "slot 2 freed");
        assert_eq!(ld[C::HOLDINGS_N], 1);
        assert_eq!(
            ld[C::FLAGS] & C::FLAG_FIRST_HOLDING_FINAL,
            C::FLAG_FIRST_HOLDING_FINAL
        );
        assert_eq!(ld[C::FLAGS] & C::FLAG_PROVISIONAL, 0);
        let hdd = c.data(&hi.citizen);
        assert_eq!(slot_ref(&hdd, 2), (t.0, t.1, s0, 2));
        assert_eq!(hdd[C::HOLDINGS_N], 2);
        // One outpost in all, whichever JoinShards the two citizens use.
        let shards: std::collections::BTreeSet<Address> = [lo, hi]
            .iter()
            .map(|e| {
                w.a.join_shard(
                    c.data(&e.citizen)[C::FACTION],
                    c.data(&e.citizen)[C::JOIN_SHARD],
                )
            })
            .collect();
        let (mut outposts, mut extra) = (0, 0);
        for sh in &shards {
            let jd = c.data(sh);
            outposts += rd_u32(&jd, JS2::OUTPOSTS);
            extra += rd_u32(&jd, JS2::EXTRA_HOLDINGS);
        }
        assert_eq!((outposts, extra), (1, 1));
    }

    /// Review CQ2-A: the first holding's shield turns to `shield_late_secs`
    /// when founded `shield_late_after_secs` after genesis (MC §3.9,
    /// Frontier-28's rule).
    #[test]
    fn cq_first_holding_shield_turns_late_after_the_season_timer() {
        let mut c = Chain::test_beacon();
        let mut p = MC_TEST;
        p.cq.shield_secs = 7_200;
        p.cq.shield_late_secs = 14_400;
        p.cq.shield_late_after_secs = 6_000;
        let w = World::land_v2(&mut c, 1, p);
        let ring2 = provinces_of(2, Some(0));
        let p0 = ring2[0];
        expect_lands(w.open_province(&mut c, p0.0, p0.1), "OpenProvince");
        let found = |c: &mut Chain, label: &str, s: u8| -> i64 {
            let x = w.citizen(c, label, 0);
            expect_lands(w.file_ticket(c, &x, &[site(p0, s)]), "FileTicket");
            let bell = w.now_bell(c);
            w.seed_ready(c, bell, region(p0.0, p0.1));
            expect_lands(w.settle_ticket(c, &x, 0, None), "SettleTicket");
            let hd = c.data(&w.a.holding(p0.0 as i32, p0.1 as i32, s));
            rd_i64(&hd, H::SHIELD_UNTIL) - c.now
        };
        assert!(c.now < w.genesis_ts() + 6_000);
        assert_eq!(found(&mut c, "early", 0), 7_200);
        c.set_time(w.genesis_ts() + 6_000 + 5);
        assert_eq!(found(&mut c, "late", 1), 14_400);
    }

    /// FileTicket under v2 (MC §5.6): an open outpost ticket blocks it
    /// (`TransitState`), a site with a conquest record is refused
    /// (`SiegeBusy`, S1), the ticket is tagged slot 1.
    #[test]
    fn g13_cq_file_ticket_v2_refusals() {
        let (mut c, w) = mc_test();
        let ring2 = provinces_of(2, Some(0));
        let p0 = ring2[0];
        expect_lands(w.open_province(&mut c, p0.0, p0.1), "OpenProvince");
        let a = w.citizen(&mut c, "a", 0);
        let mut f = c.fork();
        f.edit(&w.a.province(p0.0 as i32, p0.1 as i32), |d| {
            d[PV2::record(0) + CR::KIND] = CR::KIND_SIEGE;
        });
        assert_code(w.file_ticket(&mut f, &a, &[site(p0, 0)]), Cq::SiegeBusy);
        let mut f = c.fork();
        f.edit(&w.a.citizen(&a.key()), |d| {
            d[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&5u32.to_le_bytes());
            d[C2::SLOTS] = 2;
        });
        assert_code(w.file_ticket(&mut f, &a, &[site(p0, 0)]), E::TransitState);
        expect_lands(w.file_ticket(&mut c, &a, &[site(p0, 0)]), "FileTicket");
        assert_eq!(w.citizen_data(&c, &a)[C2::SLOTS] & 3, 1, "slot 1");
    }

    /// ReleaseDormant v2 (S3): a live record refuses (`SiegeBusy`), an
    /// owing kind-0 record refuses (`StakeUnsettled`); the release zeroes
    /// the record and keeps the citizen's outposts (MC §3.15).
    #[test]
    fn g13_cq_release_dormant_s3_and_record_reset() {
        let mut c = Chain::test_beacon();
        let mut p = World::long_params(&c);
        p.end_bell = 4_032;
        let w = World::running_with(&mut c, 1, p);
        w.open_genesis_rings(&mut c);
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 0);
        let pk = w.a.province(home.0 as i32, home.1 as i32);
        let rel = |c: &mut Chain| {
            let h = cix::HoldingRef {
                p: home.0,
                q: home.1,
                site: 0,
            };
            let ix = cix::release_dormant(
                &w.a,
                w.keeper.pubkey(),
                h,
                &e.wallet.pubkey(),
                0,
                e.wallet.pubkey(),
            );
            c.send(&[ix], &[&w.keeper])
        };
        let last = rd_i64(&c.data(&e.holding), H::LAST_OWNER_ACTION);
        c.set_time(last + w.params.cq.release_after_secs as i64);
        // Crafted: an outpost in slot 2 (the Citizen's entry), kept.
        c.edit(&e.citizen, |d| {
            let o = C2::holding_of_slot(2);
            d[o..o + 2].copy_from_slice(&3i16.to_le_bytes());
            d[o + 5] = 1;
            d[C::HOLDINGS_N] = 2;
        });
        let mut f = c.fork();
        f.edit(&pk, |d| d[PV2::record(0) + CR::KIND] = CR::KIND_OCCUPATION);
        assert_code(rel(&mut f), Cq::SiegeBusy);
        let mut f = c.fork();
        f.edit(&pk, |d| {
            d[PV2::record(0) + CR::FLAGS] = CR::FLAG_STAKE_TO_SRC
        });
        assert_code(rel(&mut f), Cq::StakeUnsettled);
        // A kind-0 record with only immunity left is released and zeroed.
        c.edit(&pk, |d| {
            d[PV2::record(0) + CR::FACTION] = 3;
            d[PV2::record(0) + CR::BELL..PV2::record(0) + CR::BELL + 4]
                .copy_from_slice(&9_999u32.to_le_bytes());
        });
        expect_lands(rel(&mut c), "ReleaseDormant");
        let pd = c.data(&pk);
        assert!(pd[PV2::record(0)..PV2::record(0) + CR::SIZE]
            .iter()
            .all(|b| *b == 0));
        assert_eq!(pd[PV::site(0) + SM::STATE], SM::STATE_RELEASED_FREE);
        let d = c.data(&e.citizen);
        assert_eq!(slot_ref(&d, 1).3, C2::EMPTY_GEN, "slot 1 emptied");
        assert_eq!(slot_ref(&d, 2), (3, 0, 0, 1), "the outpost kept");
        assert_eq!(d[C::HOLDINGS_N], 1);
    }

    /// G2 (MC §13.2): the outpost Holding on SettleTicket's fresh path at a
    /// pre-funded address.
    #[test]
    fn g02_cq_prefund_outpost_holding() {
        let (mut base, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut base, "a", 0, home, 0, 10_000);
        let t = front(&mut base, &w, home, 0);
        let s0 = w.free_sites(&base, t.0, t.1)[0];
        w.fold(&mut base);
        expect_lands(
            send(&mut base, &e, w.file_outpost_ix(&e, &[site(t, s0)], &e)),
            "FileOutpost",
        );
        let hk = w.a.holding(t.0 as i32, t.1 as i32, s0);
        let rent = base.rent(H::SIZE);
        for pre in prefunds(rent) {
            let mut c = base.fork();
            c.prefund(&hk, pre);
            let l = expect_lands(
                w.settle_estate_ticket(&mut c, &e, 0, None),
                "SettleTicket (outpost) pre-funded",
            );
            assert_eq!(
                one(&l.logs, Kind::SETTLE).u64("outcome"),
                settle_outcome::FRESH as u64
            );
            assert_program_account(&c, &hk, H::MAGIC, H::SIZE, 1);
            assert_eq!(c.lamports(&hk), pre + rent, "the escrow's rent moves whole");
            assert_eq!(c.data(&hk)[H::ORDER], 2);
            assert_eq!(rd_u64(&c.data(&e.citizen), C::TICKET_ESCROW), 0);
        }
    }

    /// G1 (§13.1, §5.4): FileOutpost with 3 sites in 3 Provinces whose
    /// cohort tables hold seven open cohorts each, paying from the anchor's
    /// stores (24,000 CU); its `L(kind)`; then the outpost's SettleTicket
    /// (40,000 CU).
    #[test]
    fn g01_cq_file_outpost_three_provinces_full_cohorts() {
        use frontier_abi::v2::Ix as V2;
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 100_000);
        let fronts: Vec<(i16, i16)> = provinces_of(3, None)
            .into_iter()
            .filter(|t| dist(home, *t) <= 3)
            .take(3)
            .collect();
        assert_eq!(fronts.len(), 3);
        let mut sites = vec![];
        for t in &fronts {
            if c.is_absent(&w.a.province(t.0 as i32, t.1 as i32)) {
                expect_lands(w.open_province(&mut c, t.0, t.1), "OpenProvince");
            }
            sites.push(site(*t, w.free_sites(&c, t.0, t.1)[0]));
        }
        // Seven open cohorts per Province (filler first-holding tickets of
        // the provinces' own wedges, one bell apart).
        for b in 0..7 {
            for t in &fronts {
                let wedge = mix::wedge_of(t.0 as i32, t.1 as i32);
                let x = w.citizen(&mut c, &format!("fill{b}-{}-{}", t.0, t.1), wedge);
                let s2 = w.free_sites(&c, t.0, t.1)[1];
                expect_lands(w.file_ticket(&mut c, &x, &[site(*t, s2)]), "filler ticket");
            }
            c.advance(600);
        }
        let rn = w.now_bell(&c).saturating_sub(1);
        c.edit(&e.province, |d| {
            d[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4].copy_from_slice(&rn.to_le_bytes())
        });
        w.fold(&mut c);
        let ix = w.file_outpost_ix(&e, &sites, &e);
        let need = c
            .measure(std::slice::from_ref(&ix), &[&e.wallet])
            .expect("measure");
        let file_need = need;
        common::loaded_check(&c, V2::FileOutpost, std::slice::from_ref(&ix), &[&e.wallet]);
        // At the ladder profile (the client's 24k limit would refuse it
        // while the budget amendment is pending; CQ2-A notes §2).
        expect_lands(c.send(&[ix], &[&e.wallet]), "FileOutpost at the 24k limit");
        // The outpost's SettleTicket (fresh, three Provinces).
        let who = Citizen {
            wallet: e.wallet.insecure_clone(),
            faction: 0,
        };
        let (bell, ts) = w.ticket_of(&c, &who);
        w.seed_ready(&mut c, bell, region(ts[0].p, ts[0].q));
        // DECISIONS K9: a fresh settlement waits for the earlier (filler)
        // cohorts: the bell before this ticket's expiry, when they have.
        let t = w.genesis_ts() + 600 * (bell as i64 + 23) + 1;
        if c.now < t {
            c.set_time(t);
        }
        let st = w.settle_ticket_ix(&c, &who, 0, None);
        let need = c
            .measure(std::slice::from_ref(&st), &[&w.keeper])
            .expect("measure");
        assert_within(
            "SettleTicket (outpost, three Provinces)",
            &need,
            &ceilings(V2::SettleTicket, 0, c.programdata_len()),
        );
        // Last: FileOutpost against §5.4's 24,000 CU (measured above; the
        // tx bytes, locks and loaded data are within their ceilings).
        assert_within(
            "FileOutpost (3 provinces, 7 open cohorts each)",
            &file_need,
            &ceilings(V2::FileOutpost, 0, c.programdata_len()),
        );
    }

    /// G3 (MC §13.2): FileOutpost's keyed reads recomputed: a forged
    /// Province (another season's copy, another address), a forged anchor.
    #[test]
    fn g03_cq_file_outpost_refuses_forged_accounts() {
        let (mut c, w) = mc_test();
        let home = provinces_of(2, Some(0))[0];
        let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
        let t = front(&mut c, &w, home, 0);
        let s0 = w.free_sites(&c, t.0, t.1)[0];
        w.fold(&mut c);
        let ok = w.file_outpost_ix(&e, &[site(t, s0)], &e);
        let pk = w.a.province(t.0 as i32, t.1 as i32);
        let copy = copy_to_fresh(&mut c, &pk, b"province");
        assert_code(
            send(
                &mut c.fork(),
                &e,
                with_account(ok.clone(), outpost_at::PROVINCE0, copy),
            ),
            E::BadAddress,
        );
        let hcopy = copy_to_fresh(&mut c, &e.holding, b"anchor");
        assert_code(
            send(
                &mut c.fork(),
                &e,
                with_account(ok.clone(), outpost_at::anchor(1), hcopy),
            ),
            E::BadAddress,
        );
        let mut f = c.fork();
        f.edit(&pk, |d| d[8] ^= 1); // another season's Province
        assert_code(send(&mut f, &e, ok.clone()), E::BadAccount);
        let mut f = c.fork();
        f.edit(&pk, |d| d[16] = 1); // an M1 header (layout_version 1)
        assert_code(send(&mut f, &e, ok.clone()), E::BadAccount);
        expect_lands(send(&mut c, &e, ok), "FileOutpost");
        let _ = any_records(&[]);
    }
}
