//! Real VM coverage for the version-3 first-village path.
use fclient::ix::v2 as ix;
use fclient::ix::{HoldingRef, Site};
use frontier_abi::layout::player::queue_item as Q;
use frontier_abi::layout::world::{frontier as F, season as SE};
use frontier_abi::log::{EntityKind, Kind};
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::province::{province as P, site as S};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, with_account, Chain};
use permutation_frontier_svm_tests::records::{one, ChainWatch};
use permutation_frontier_svm_tests::world::land::{rd_i64, rd_u32, Citizen};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{FrontierError as E, Signer};
use solana_instruction::Instruction;
fn setup() -> (Chain, World, Citizen, Site) {
    let mut c = Chain::test_beacon();
    let (w, ps) = World::land(&mut c, 1, 0);
    let who = w.citizen(&mut c, "first-home", 0);
    let s = Site {
        p: ps[0].0,
        q: ps[0].1,
        site: 0,
    };
    (c, w, who, s)
}
fn place(c: &Chain, w: &World, who: &Citizen, s: Site) -> Instruction {
    let d = w.citizen_data(c, who);
    fclient::ix::place_home(&w.a, &who.player(), s, who.faction, d[C::JOIN_SHARD])
}
fn href(s: Site) -> HoldingRef {
    HoldingRef {
        p: s.p,
        q: s.q,
        site: s.site,
    }
}
#[test]
fn first_home_is_final_sponsored_and_chained_immediately() {
    let (mut c, w, who, s) = setup();
    let hk = w.a.holding(s.p as i32, s.q as i32, s.site);
    let ck = w.a.citizen(&who.key());
    let pk = w.a.province(s.p as i32, s.q as i32);
    let shard = w.citizen_data(&c, &who)[C::JOIN_SHARD];
    let sk = w.a.join_shard(0, shard);
    let watchers = [
        ChainWatch::new(&c, ck, EntityKind::Citizen),
        ChainWatch::new(&c, pk, EntityKind::Province),
        ChainWatch::new(&c, sk, EntityKind::JoinShard),
    ];
    let sponsor = c.funded(b"home-sponsor", 10);
    let mut player = who.player();
    player.payer = sponsor.pubkey();
    let tx = fclient::ix::place_home(&w.a, &player, s, 0, shard);
    c.prefund(&hk, 1);
    c.prefund(&hk, 1);
    let landed = expect_lands(c.send_client(&[tx], &[&who.wallet, &sponsor]), "PlaceHome");
    assert!(landed.cu <= 40_000, "PlaceHome CU {}", landed.cu);
    for watch in watchers {
        watch.check(&c, &landed.logs, 1);
    }
    let hd = c.data(&hk);
    let cd = c.data(&ck);
    let pd = c.data(&pk);
    assert_eq!(hd[H::STATE], H::STATE_FINAL);
    assert_eq!(hd[H::FLAGS], 2);
    assert_eq!(rd_i64(&hd, H::FINAL_TS), c.now);
    assert_eq!(&hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32], ck.as_ref());
    assert_eq!(
        &hd[H::RENT_PAYER..H::RENT_PAYER + 32],
        sponsor.pubkey().as_ref()
    );
    assert_eq!(cd[C::HOLDINGS_N], 1);
    assert_eq!(cd[C::FLAGS] & 36, 36);
    assert_eq!(rd_u32(&cd, C::TICKET_BELL), C::NO_TICKET);
    assert_eq!(pd[P::site(s.site as usize) + S::STATE], S::STATE_HOLDING);
    let record = one(&landed.logs, Kind::HOME_PLACED);
    assert_eq!(record.u64("gen"), 1);
    assert_eq!(record.links.len(), 4);
    c.next_slot();
    let retry = place(&c, &w, &who, s);
    assert_code(c.send(&[retry], &[&who.wallet]), E::AlreadyDone);
    assert_eq!(c.data(&hk), hd);
}
#[test]
fn first_home_rejects_occupied_foreign_closed_and_reserved_sites() {
    let (c, w, who, s) = setup();
    let tx = place(&c, &w, &who, s);
    let pk = w.a.province(s.p as i32, s.q as i32);
    let mut x = c.fork();
    x.edit(&pk, |d| d[P::site(0) + S::STATE] = S::STATE_HOLDING);
    assert_code(x.send(&[tx.clone()], &[&who.wallet]), E::TicketState);
    let mut x = c.fork();
    x.edit(&w.a.citizen(&who.key()), |d| d[C::FACTION] = 1);
    assert_code(x.send(&[tx.clone()], &[&who.wallet]), E::BadData);
    let mut x = c.fork();
    x.edit(&w.a.frontier(), |d| {
        d[F::RINGS_OPENED..F::RINGS_OPENED + 2].copy_from_slice(&2u16.to_le_bytes())
    });
    assert_code(x.send(&[tx], &[&who.wallet]), E::BadData);
    let mut x = c.fork();
    let tx = place(
        &x,
        &w,
        &who,
        Site {
            p: 0,
            q: 0,
            site: 0,
        },
    );
    assert_code(x.send(&[tx], &[&who.wallet]), E::ReservedSite);
}
#[test]
fn first_home_cannot_bypass_legacy_holding_ticket_or_cohort() {
    let (c, w, who, s) = setup();
    let tx = place(&c, &w, &who, s);
    for flags in [
        C::FLAG_FIRST_HOLDING_FINAL,
        C::FLAG_PROVISIONAL,
        C::FLAG_REFUGEE,
    ] {
        let mut x = c.fork();
        x.edit(&w.a.citizen(&who.key()), |d| d[C::FLAGS] |= flags);
        assert_code(x.send(&[tx.clone()], &[&who.wallet]), E::TicketState);
    }
    let mut x = c.fork();
    x.edit(&w.a.citizen(&who.key()), |d| d[C::HOLDINGS_N] = 1);
    assert_code(x.send(&[tx.clone()], &[&who.wallet]), E::TicketState);
    let mut x = c.fork();
    expect_lands(w.file_ticket(&mut x, &who, &[s]), "FileTicket");
    assert_code(x.send(&[tx], &[&who.wallet]), E::TicketState);
    let other = w.citizen(&mut x, "pending-neighbor", 0);
    let tx = place(&x, &w, &other, Site { site: 1, ..s });
    assert_code(x.send(&[tx], &[&other.wallet]), E::TicketState);
}
#[test]
fn first_home_authentication_addresses_and_old_season_checked() {
    let (c, w, who, s) = setup();
    let tx = place(&c, &w, &who, s);
    let mut x = c.fork();
    let other = x.funded(b"outsider", 10);
    let forged = with_account(tx.clone(), 0, other.pubkey());
    assert_code(x.send(&[forged], &[&other, &who.wallet]), E::Auth);
    let mut seeded = c.fork();
    let hk = w.a.holding(s.p as i32, s.q as i32, s.site);
    seeded.put_program_account(hk, vec![0u8; H::SIZE]);
    assert_code(seeded.send(&[tx.clone()], &[&who.wallet]), E::BadAccount);
    let mut x = c.fork();
    let wrong = x.funded(b"wrong-holding", 10);
    assert_code(
        x.send(
            &[with_account(tx.clone(), 6, wrong.pubkey())],
            &[&who.wallet],
        ),
        E::BadAddress,
    );
    let mut x = c.fork();
    x.edit(&w.a.season, |d| {
        d[SE::PROGRAM_VERSION..SE::PROGRAM_VERSION + 2].copy_from_slice(&1u16.to_le_bytes())
    });
    assert_code(x.send(&[tx], &[&who.wallet]), E::RulesetMismatch);
}
#[test]
fn first_home_only_one_production_build_is_short() {
    let (mut c, w, who, s) = setup();
    let tx = place(&c, &w, &who, s);
    expect_lands(c.send(&[tx], &[&who.wallet]), "PlaceHome");
    let hk = w.a.holding(s.p as i32, s.q as i32, s.site);
    let first = expect_lands(
        c.send(
            &[ix::build_item(&w.a, &who.player(), href(s), 0, false)],
            &[&who.wallet],
        ),
        "first Build",
    );
    assert_eq!(
        one(&first.logs, Kind::BUILD).u64("done_at") as i64,
        c.now + 60
    );
    assert_eq!(c.data(&hk)[H::FLAGS] & 2, 0);
    let second = expect_lands(
        c.send(
            &[ix::build_item(&w.a, &who.player(), href(s), 1, false)],
            &[&who.wallet],
        ),
        "second Build",
    );
    assert_eq!(
        one(&second.logs, Kind::BUILD).u64("done_at") as i64,
        c.now + 60 + 5400
    );
    assert_eq!(rd_i64(&c.data(&hk), H::queue(0) + Q::DONE_AT), c.now + 60);
    c.advance(61);
    expect_lands(
        c.send(&[ix::harvest(&w.a, &who.player(), href(s))], &[&who.wallet]),
        "Harvest",
    );
    assert_eq!(c.data(&hk)[H::FLAGS] & 2, 0);
}

#[test]
fn first_home_allows_live_session_and_rejects_expiry() {
    let (mut c, w, who, s) = setup();
    let session = c.funded(b"home-session", 1);
    let ck = w.a.citizen(&who.key());
    let expiry = c.now + 600;
    expect_lands(
        c.send(
            &[fclient::ix::set_session(
                &w.a,
                &who.player(),
                &session.pubkey(),
                expiry,
            )],
            &[&who.wallet],
        ),
        "SetSession",
    );
    let mut p = who.player();
    p.actor = session.pubkey();
    let shard = c.data(&ck)[C::JOIN_SHARD];
    let tx = fclient::ix::place_home(&w.a, &p, s, 0, shard);
    let mut expired = c.fork();
    expired.advance(600);
    assert_code(
        expired.send(&[tx.clone()], &[&who.wallet, &session]),
        E::SessionExpired,
    );
    expect_lands(c.send(&[tx], &[&who.wallet, &session]), "session PlaceHome");
}

#[test]
fn first_home_failed_build_does_not_consume_intro_and_walls_do_not_use_it() {
    let (mut c, w, who, s) = setup();
    let tx = place(&c, &w, &who, s);
    expect_lands(c.send(&[tx], &[&who.wallet]), "PlaceHome");
    let hk = w.a.holding(s.p as i32, s.q as i32, s.site);
    let mut broke = c.fork();
    broke.edit(&hk, |d| {
        for i in 0..8 {
            let o = H::store(i);
            d[o..o + 8].fill(0);
        }
    });
    assert_code(
        broke.send(
            &[ix::build_item(&w.a, &who.player(), href(s), 0, false)],
            &[&who.wallet],
        ),
        E::Insufficient,
    );
    assert_eq!(broke.data(&hk)[H::FLAGS] & 2, 2);
    // Fund the optional walls explicitly; the starter kit is for production.
    c.edit(&hk, |d| {
        for i in 0..8 {
            let o = H::store(i);
            d[o..o + 8].copy_from_slice(&1_000_000i64.to_le_bytes());
        }
    });
    // Walls are optional advanced work and do not spend the production-building tutorial boost.
    let wall = expect_lands(
        c.send(
            &[ix::build_item(&w.a, &who.player(), href(s), 6, true)],
            &[&who.wallet],
        ),
        "walls",
    );
    assert_ne!(
        one(&wall.logs, Kind::BUILD).u64("done_at") as i64,
        c.now + 60
    );
    assert_eq!(c.data(&hk)[H::FLAGS] & 2, 2);
}
