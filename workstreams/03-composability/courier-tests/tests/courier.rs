//! Workstream 03: another author's program (the courier) acts on the Wylls
//! world through the Frontier program's SendCaravan, by CPI.
//!
//! **Execution:** every test here is `[LOCAL CHAIN: LiteSVM]`: the SBF
//! builds of both programs (the Frontier test-beacon build, the courier's
//! release build) executed by LiteSVM 0.16, with signature verification,
//! the real CPI path (stack height 2, the runtime's privilege checks) and
//! the harness's SIMD-0186 loaded-data enforcement. Game state that needs
//! time to pass (a caravan's road, a Province's resolved bells, an open
//! raid) is crafted the way the core's own `caravan.rs` crafts it; the
//! crafted parts are named in each test. Nothing is sent to a network.
//!
//! Passing points (task brief): **(1) the owner signs, the courier calls**
//! — `t01`–`t11`. **(2) a limited delegation acts without the owner's
//! online signature** — `t12`–`t14`, through the courier's PROVISIONAL
//! mandate adapter (not workstream 02's Grant) over the core's existing
//! session key.

use fclient::ix::v2::{self as fx, PlaceRef, RaidCaravanArgs};
use frontier_abi::v2::layout::province::caravan_slot as CS;
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use frontier_abi::v2::layout::world::season as S;
use frontier_abi::v2::log::{caravan_outcome, raid_choice, AnyKind, CqKind};
use frontier_abi::v2::{CqError as Cq, Ix as I2};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Build, Chain, Landed};
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::conquest::assert_cq;
use permutation_frontier_svm_tests::world::holding::i64_at;
use permutation_frontier_svm_tests::{
    AccountMeta, Address, FrontierError as E, Instruction, Keypair, Signer,
};
use permutation_rules::frontier::caravan::{caravan_id, CaravanSlot, MAX_CARAVAN_SLOTS};
use wylls_courier_tests::*;

const CARGO: [u32; 8] = [0, 100, 0, 0, 0, 30, 0, 0];

// ------------------------------------------------------------ helpers

fn slot_of(c: &Chain, province: &Address, id: u64) -> Option<(usize, CaravanSlot)> {
    let d = c.data(province);
    (0..MAX_CARAVAN_SLOTS)
        .map(|i| CaravanSlot::decode(&d[CS::at(i)..CS::at(i) + CS::SIZE]).unwrap())
        .enumerate()
        .find(|(_, s)| s.id == id)
}

fn put_slot(c: &mut Chain, province: &Address, i: usize, s: &CaravanSlot) {
    c.edit(province, |d| {
        assert!(s.encode(&mut d[CS::at(i)..CS::at(i) + CS::SIZE]).is_some())
    });
}

#[track_caller]
fn event(l: &Landed, k: CqKind) -> fclient::conquest::CqEvent {
    let _ = records::one_cq(&l.logs, k);
    let body = records::bodies(&l.logs)
        .into_iter()
        .find(|b| frontier_abi::v2::log::decode(b).is_ok_and(|r| r.kind == AnyKind::Cq(k)))
        .expect("the body");
    fclient::conquest::parse(&body)
        .expect("fclient parses it")
        .event
}

/// A's wallet signs, the courier forwards.
fn courier_send(
    k: &mut Cast,
    x: &fx::SendCaravanArgs,
) -> permutation_frontier_svm_tests::chain::SendResult {
    let inner = k.send_ix(&k.a.player(), x);
    let ix = send_signed(k.courier, &inner);
    send_any(&mut k.c, I2::SendCaravan, &[ix], &[&k.a.wallet])
}

fn direct_send(
    k: &mut Cast,
    x: &fx::SendCaravanArgs,
) -> permutation_frontier_svm_tests::chain::SendResult {
    let ix = k.send_ix(&k.a.player(), x);
    send_any(&mut k.c, I2::SendCaravan, &[ix], &[&k.a.wallet])
}

/// The accounts a SendCaravan writes, byte for byte, with lamports.
fn snapshot(k: &Cast, seq: u32) -> Vec<(Address, Vec<u8>, u64)> {
    [
        k.a.citizen,
        k.a.holding,
        k.vault(),
        k.a.province,
        k.caravan(seq),
    ]
    .iter()
    .map(|a| (*a, k.c.data(a), k.c.lamports(a)))
    .collect()
}

fn session_set(k: &mut Cast, label: &[u8], secs: i64) -> Keypair {
    let s = k.c.funded(label, 1);
    let exp = k.c.now + secs;
    expect_lands(
        k.set_session(&s.pubkey(), exp),
        "SetSession (wallet, top level)",
    );
    s
}

// ------------------------------------------------------------ (1) owner-signed

/// [LOCAL CHAIN: LiteSVM] The owner signs; the courier's CPI lands with the
/// same effect as the direct call, byte for byte: the source is debited
/// once, the Citizen's caravan counter moves once, the same Caravan and
/// slot appear.
#[test]
fn t01_signed_send_through_the_courier_equals_the_direct_call() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, CARGO);
    let before = k.stores(&k.a);
    // The direct call on a fork of the same chain.
    let mut other = k.c.fork();
    std::mem::swap(&mut k.c, &mut other);
    let ld = expect_lands(direct_send(&mut k, &x), "direct SendCaravan");
    let direct = snapshot(&k, 0);
    std::mem::swap(&mut k.c, &mut other);
    let lc = expect_lands(courier_send(&mut k, &x), "courier SendCaravan");
    assert_eq!(
        snapshot(&k, 0),
        direct,
        "the courier's effect is the direct call's"
    );
    assert_eq!(k.caravans(), 1);
    let after = k.stores(&k.a);
    for r in [1usize, 5] {
        let taken = before[r] - after[r];
        assert!(
            (CARGO[r] as i64 * MILLI - 10 * MILLI..=CARGO[r] as i64 * MILLI).contains(&taken),
            "debited once, resource {r}: {taken}"
        );
    }
    assert_eq!(
        lc.return_data,
        0u32.to_le_bytes(),
        "the courier's return data: the seq"
    );
    assert!(lc
        .logs
        .iter()
        .any(|l| l.contains("courier: SendCaravan seq 0 forwarded")));
    assert_eq!(ld.fee, lc.fee, "one signature either way");
    match event(&lc, CqKind::CARAVAN_SENT) {
        fclient::conquest::CqEvent::CaravanSent { seq, cargo, .. } => {
            assert_eq!((seq, cargo), (0, CARGO))
        }
        e => panic!("{e:?}"),
    }
    println!(
        "[t01] direct cu={} courier cu={} (+{})",
        ld.cu,
        lc.cu,
        lc.cu - ld.cu
    );
}

/// [LOCAL CHAIN: LiteSVM] No owner signature: the courier forwards the
/// flags as given, and the core refuses (`Auth`); a stranger's signature
/// as actor is refused too.
#[test]
fn t02_unsigned_or_wrong_signer_is_refused_by_the_core() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, CARGO);
    let stranger = k.c.funded(b"stranger", 1);
    // The actor (A's wallet) does not sign; the stranger pays.
    let mut inner = k.send_ix(&acting(&stranger, &k.a.wallet.pubkey()), &x);
    inner.accounts[0] = AccountMeta::new_readonly(k.a.wallet.pubkey(), false);
    let ix = send_signed(k.courier, &inner);
    let before = snapshot(&k, 0);
    assert_code(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&stranger]),
        E::Auth,
    );
    // The stranger signs as the actor of A's Citizen.
    let inner = k.send_ix(&acting(&stranger, &k.a.wallet.pubkey()), &x);
    let ix = send_signed(k.courier, &inner);
    assert_code(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&stranger]),
        E::Auth,
    );
    assert_eq!(snapshot(&k, 0), before, "nothing moved");
}

/// [LOCAL CHAIN: LiteSVM] Someone else's source: A signs with R's holding as
/// the source (`NotOwner`); R's wallet acting for A's Citizen (`Auth`).
#[test]
fn t03_someone_elses_source_is_refused() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let mut x = k.send_args(0, CARGO);
    x.src = PlaceRef::Holding {
        h: k.r.href(),
        gen: k.r.gen,
    };
    let r_before = k.stores(&k.r);
    assert_code(courier_send(&mut k, &x), E::NotOwner);
    let x = k.send_args(0, CARGO);
    let inner = k.send_ix(&acting(&k.r.wallet, &k.a.wallet.pubkey()), &x);
    let ix = send_signed(k.courier, &inner);
    assert_code(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&k.r.wallet]),
        E::Auth,
    );
    assert_eq!(k.stores(&k.r), r_before);
    assert_eq!(k.caravans(), 0);
}

/// [LOCAL CHAIN: LiteSVM] The session key through the courier: a send
/// between A's own places lands; a send to another player needs the wallet
/// (`WalletRequired`); an expired session (`SessionExpired`) and a key that
/// is not the session (`Auth`) are refused.
#[test]
fn t04_session_key_limits_hold_through_the_courier() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let s = session_set(&mut k, b"a-session", 3_600);
    let wallet = k.a.wallet.pubkey();
    let to_r = k.send_to_r_args(0, CARGO);
    let ix = send_signed(k.courier, &k.send_ix(&acting(&s, &wallet), &to_r));
    assert_cq(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&s]),
        Cq::WalletRequired,
    );
    let own = k.send_args(0, CARGO);
    let ix = send_signed(k.courier, &k.send_ix(&acting(&s, &wallet), &own));
    expect_lands(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&s]),
        "own send by the session key, via the courier",
    );
    // Not the session key.
    let other = k.c.funded(b"not-the-session", 1);
    let own1 = k.send_args(1, CARGO);
    let ix = send_signed(k.courier, &k.send_ix(&acting(&other, &wallet), &own1));
    assert_code(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&other]),
        E::Auth,
    );
    // Expired.
    k.c.advance(3_601);
    let ix = send_signed(k.courier, &k.send_ix(&acting(&s, &wallet), &own1));
    assert_code(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&s]),
        E::SessionExpired,
    );
    assert_eq!(k.caravans(), 1);
}

/// [LOCAL CHAIN: LiteSVM] Wrong PDAs and wrong owning programs: a caravan
/// address of another seq (`BadAddress`), a source owned by another program
/// (`BadAccount`), an impostor Frontier program (courier `WrongFrontier`,
/// before any CPI), a Season copy outside the Frontier program (courier
/// `WrongFrontier`), a Frontier-owned Season copy at a non-PDA address
/// (core `BadAddress`).
#[test]
fn t05_wrong_pda_or_owning_program_is_refused() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, CARGO);
    let good = k.send_ix(&k.a.player(), &x);
    // Caravan PDA of seq 1.
    let mut ix = good.clone();
    ix.accounts[6].pubkey = k.caravan(1);
    assert_code(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &ix)],
            &[&k.a.wallet],
        ),
        E::BadAddress,
    );
    // The source's bytes under another owner, at another address.
    let fake = Address::new_unique();
    let (hd, hl) = (k.c.data(&k.a.holding), k.c.lamports(&k.a.holding));
    k.c.put(fake, k.courier, hd, hl);
    let mut ix = good.clone();
    ix.accounts[4].pubkey = fake;
    assert_code(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &ix)],
            &[&k.a.wallet],
        ),
        E::BadAccount,
    );
    // An impostor Frontier: the same ELF at another id.
    let impostor = Address::new_unique();
    let (_, so) = permutation_frontier_svm_tests::chain::load_so(Build::TestBeacon);
    k.c.deploy(impostor, &so, so.len(), None);
    let mut ix = good.clone();
    ix.program_id = impostor;
    let f = assert_courier(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &ix)],
            &[&k.a.wallet],
        ),
        &k.courier,
        CourierError::WrongFrontier,
    );
    assert!(
        !f.logs
            .iter()
            .any(|l| l.contains(&format!("Program {impostor} invoke"))),
        "refused before the CPI"
    );
    // A Season copy owned by the System program.
    let s_copy = Address::new_unique();
    let (sd, sl) = (k.c.data(&k.w.a.season), k.c.lamports(&k.w.a.season));
    k.c.put(s_copy, Address::default(), sd.clone(), sl);
    let mut ix = good.clone();
    ix.accounts[2].pubkey = s_copy;
    assert_courier(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &ix)],
            &[&k.a.wallet],
        ),
        &k.courier,
        CourierError::WrongFrontier,
    );
    // A Frontier-owned Season copy (crafted: no program would make one) at a
    // non-PDA address passes the courier's owner check; the core recomputes
    // the PDA.
    let s_copy2 = Address::new_unique();
    k.c.put(s_copy2, k.c.program, sd, sl);
    let mut ix = good.clone();
    ix.accounts[2].pubkey = s_copy2;
    assert_code(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &ix)],
            &[&k.a.wallet],
        ),
        E::BadAddress,
    );
    assert_eq!(k.caravans(), 0);
}

/// [LOCAL CHAIN: LiteSVM] Missing, extra or mis-flagged accounts: no path
/// Province, an extra account (`TooManyAccounts`), a read-only source, a
/// fake System program (`BadAccount`); the courier with no accounts or
/// truncated data (courier `Accounts`, `BadInstruction`).
#[test]
fn t06_missing_or_malformed_accounts_are_refused() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, CARGO);
    let good = k.send_ix(&k.a.player(), &x);
    let send = |k: &mut Cast, ix: &Instruction| {
        let w = send_signed(k.courier, ix);
        send_any(&mut k.c, I2::SendCaravan, &[w], &[&k.a.wallet])
    };
    let mut ix = good.clone();
    ix.accounts.pop();
    assert_code(send(&mut k, &ix), E::TooManyAccounts);
    let mut ix = good.clone();
    for _ in 0..4 {
        ix.accounts.push(AccountMeta::new(k.a.province, false));
    }
    assert_code(send(&mut k, &ix), E::TooManyAccounts);
    let mut ix = good.clone();
    ix.accounts[4].is_writable = false;
    assert_code(send(&mut k, &ix), E::BadAccount);
    let mut ix = good.clone();
    ix.accounts[7].pubkey = Address::new_unique();
    assert_code(send(&mut k, &ix), E::BadAccount);
    // The courier itself.
    let bare = Instruction {
        program_id: k.courier,
        accounts: vec![],
        data: vec![OP_SEND_SIGNED, IFACE_VERSION],
    };
    assert_courier(
        send_any(&mut k.c, I2::SendCaravan, &[bare], &[&k.a.wallet]),
        &k.courier,
        CourierError::Accounts,
    );
    let mut w = send_signed(k.courier, &good);
    w.data.truncate(w.data.len() - 1);
    assert_courier(
        send_any(&mut k.c, I2::SendCaravan, &[w], &[&k.a.wallet]),
        &k.courier,
        CourierError::BadInstruction,
    );
    assert_eq!(k.caravans(), 0);
}

/// [LOCAL CHAIN: LiteSVM] Duplicates do not multiply: the same signed
/// request again (`BadData`: the seq is used); the same request twice in
/// one transaction (the whole transaction fails, nothing moved); two
/// different seqs in one transaction land both; a second settle of a
/// settled caravan (`BadAccount`) credits nothing.
#[test]
fn t07_duplicate_requests_do_not_multiply() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x0 = k.send_args(0, CARGO);
    let w0 = send_signed(k.courier, &k.send_ix(&k.a.player(), &x0));
    // Twice in one transaction.
    let before = snapshot(&k, 0);
    assert_code(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[w0.clone(), w0.clone()],
            &[&k.a.wallet],
        ),
        E::BadData,
    );
    assert_eq!(snapshot(&k, 0), before, "atomic: nothing moved");
    // Once, then the same again.
    expect_lands(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            std::slice::from_ref(&w0),
            &[&k.a.wallet],
        ),
        "first",
    );
    let once = snapshot(&k, 0);
    k.c.svm.expire_blockhash();
    assert_code(
        send_any(&mut k.c, I2::SendCaravan, &[w0], &[&k.a.wallet]),
        E::BadData,
    );
    assert_eq!(snapshot(&k, 0), once);
    // Seqs 1 and 2 in one transaction.
    let w1 = send_signed(
        k.courier,
        &k.send_ix(&k.a.player(), &k.send_args(1, [0, 10, 0, 0, 0, 0, 0, 0])),
    );
    let w2 = send_signed(
        k.courier,
        &k.send_ix(&k.a.player(), &k.send_args(2, [0, 10, 0, 0, 0, 0, 0, 0])),
    );
    expect_lands(
        send_any(&mut k.c, I2::SendCaravan, &[w1, w2], &[&k.a.wallet]),
        "two seqs in one transaction",
    );
    assert_eq!(k.caravans(), 3);
    // Settle caravan 0 twice.
    let cv = k.caravan(0);
    k.arrive(&cv);
    let keeper = k.c.funded(b"keeper", 1);
    let s = k.settle_ix(cv, k.vault(), &keeper.pubkey());
    expect_lands(
        send_any(
            &mut k.c,
            I2::SettleCaravan,
            std::slice::from_ref(&s),
            &[&keeper],
        ),
        "settle",
    );
    let v = k.vault_store(1);
    assert_eq!(v, 100 * MILLI);
    let s2 = fx::settle_caravan(
        &k.w.a,
        keeper.pubkey(),
        cv,
        k.vault(),
        keeper.pubkey(),
        k.a.wallet.pubkey(),
        &[(k.a.p, k.a.q)],
    );
    assert_code(
        send_any(&mut k.c, I2::SettleCaravan, &[s2], &[&keeper]),
        E::BadAccount,
    );
    assert_eq!(k.vault_store(1), v, "delivered once");
}

/// [LOCAL CHAIN: LiteSVM] Nothing arrives early: SendCaravan and
/// SettleCaravan cannot even share a transaction (the settle makes the
/// destination writable, and SendCaravan refuses a writable destination,
/// `BadAccount`, instruction 2 = the send); after the arrival time but
/// before the Province has resolved the caravan's bells, `CaravanEarly`;
/// after both (crafted resolve), delivered exactly once.
#[test]
fn t08_no_receipt_before_arrival() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, CARGO);
    let w = send_signed(k.courier, &k.send_ix(&k.a.player(), &x));
    let keeper = k.c.funded(b"keeper", 1);
    let settle = fx::settle_caravan(
        &k.w.a,
        k.a.wallet.pubkey(),
        k.caravan(0),
        k.vault(),
        k.a.wallet.pubkey(),
        k.a.wallet.pubkey(),
        &[(k.a.p, k.a.q)],
    );
    let f = assert_code(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[w.clone(), settle],
            &[&k.a.wallet],
        ),
        E::BadAccount,
    );
    assert!(
        f.err.contains("InstructionError(2,"),
        "the send (instruction 2) refused: {}",
        f.err
    );
    assert_eq!(k.caravans(), 0, "nothing moved");
    expect_lands(
        send_any(&mut k.c, I2::SendCaravan, &[w], &[&k.a.wallet]),
        "send",
    );
    let cv = k.caravan(0);
    let s = k.settle_ix(cv, k.vault(), &keeper.pubkey());
    assert_cq(
        send_any(
            &mut k.c,
            I2::SettleCaravan,
            std::slice::from_ref(&s),
            &[&keeper],
        ),
        Cq::CaravanEarly,
    );
    let arrive = i64_at(&k.c.data(&cv), CV::ARRIVE_TS);
    k.c.set_time(arrive + 1);
    assert_cq(
        send_any(
            &mut k.c,
            I2::SettleCaravan,
            std::slice::from_ref(&s),
            &[&keeper],
        ),
        Cq::CaravanEarly,
    );
    assert_eq!(k.vault_store(1), 0, "nothing before the arrival");
    k.arrive(&cv);
    expect_lands(
        send_any(&mut k.c, I2::SettleCaravan, &[s], &[&keeper]),
        "settle after the arrival and the resolve",
    );
    assert_eq!(k.vault_store(1), 100 * MILLI);
    assert_eq!(k.vault_store(5), 30 * MILLI);
}

/// [LOCAL CHAIN: LiteSVM] Version mismatch: the courier's own interface
/// version (`InterfaceVersion`), a Season of another `program_version` or
/// ruleset (`FrontierVersion`, before the CPI; the direct call refuses the
/// ruleset itself, `RulesetMismatch`), data that is not a SendCaravan
/// (`BadInstruction`).
#[test]
fn t09_version_mismatch_is_refused_before_the_cpi() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let x = k.send_args(0, CARGO);
    let inner = k.send_ix(&k.a.player(), &x);
    let w2 = wrap(k.courier, OP_SEND_SIGNED, IFACE_VERSION + 1, &inner);
    assert_courier(
        send_any(&mut k.c, I2::SendCaravan, &[w2], &[&k.a.wallet]),
        &k.courier,
        CourierError::InterfaceVersion,
    );
    // program_version 5 (a later program the courier was not built for).
    let season = k.w.a.season;
    let pv = k.c.data(&season)[S::PROGRAM_VERSION..S::PROGRAM_VERSION + 2].to_vec();
    k.c.edit(&season, |d| {
        d[S::PROGRAM_VERSION..S::PROGRAM_VERSION + 2].copy_from_slice(&5u16.to_le_bytes())
    });
    let f = assert_courier(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &inner)],
            &[&k.a.wallet],
        ),
        &k.courier,
        CourierError::FrontierVersion,
    );
    assert!(
        !f.logs
            .iter()
            .any(|l| l.contains(&format!("Program {} invoke [2]", k.c.program))),
        "refused before the CPI"
    );
    k.c.edit(&season, |d| {
        d[S::PROGRAM_VERSION..S::PROGRAM_VERSION + 2].copy_from_slice(&pv)
    });
    // Another ruleset.
    let rh = k.c.data(&season)[S::RULESET_HASH..S::RULESET_HASH + 32].to_vec();
    k.c.edit(&season, |d| d[S::RULESET_HASH] ^= 1);
    assert_courier(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &inner)],
            &[&k.a.wallet],
        ),
        &k.courier,
        CourierError::FrontierVersion,
    );
    assert_code(direct_send(&mut k, &x), E::RulesetMismatch);
    k.c.edit(&season, |d| {
        d[S::RULESET_HASH..S::RULESET_HASH + 32].copy_from_slice(&rh)
    });
    // BuildVault's data under SendSigned.
    let bv = fx::build_vault(&k.w.a, &k.a.player(), k.a.href(), (k.a.p, k.a.q), k.vt);
    assert_courier(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[send_signed(k.courier, &bv)],
            &[&k.a.wallet],
        ),
        &k.courier,
        CourierError::BadInstruction,
    );
    expect_lands(
        courier_send(&mut k, &x),
        "the same send once the versions match",
    );
}

/// [LOCAL CHAIN: LiteSVM] The rules hold for a couriered caravan: a raid
/// (crafted open raid by R's host in the caravan's slot, as caravan.rs)
/// lets R take it, and it settles at R's holding, not A's vault; a
/// destination whose generation changed (crafted) loses the cargo. A vault
/// cannot be built and filled in one transaction: each instruction refuses
/// an account it lists read-only that the other writes (BuildVault reads
/// the Province the send writes, the send reads the vault BuildVault
/// writes); the first to run, BuildVault (instruction 2), refuses
/// (`BadAccount`). In two transactions it lands.
#[test]
fn t10_transport_raid_and_generation_rules_hold() {
    let mut k = Cast::new(false);
    // BuildVault + courier SendCaravan to the new vault, one transaction.
    let bv = fx::build_vault(&k.w.a, &k.a.player(), k.a.href(), (k.a.p, k.a.q), k.vt);
    let x = k.send_args(0, [0, 100, 0, 0, 0, 50, 0, 0]);
    let w = send_signed(k.courier, &k.send_ix(&k.a.player(), &x));
    let f = assert_code(
        send_any(
            &mut k.c,
            I2::SendCaravan,
            &[bv.clone(), w.clone()],
            &[&k.a.wallet],
        ),
        E::BadAccount,
    );
    assert!(
        f.err.contains("InstructionError(2,"),
        "BuildVault (instruction 2) refused: {}",
        f.err
    );
    assert!(k.c.is_absent(&k.vault()), "the vault rolled back too");
    expect_lands(
        send_any(&mut k.c, I2::BuildVault, &[bv], &[&k.a.wallet]),
        "BuildVault",
    );
    expect_lands(
        send_any(&mut k.c, I2::SendCaravan, &[w], &[&k.a.wallet]),
        "couriered send, next transaction",
    );
    // The raid (crafted slot, the clash of the raid bell resolved).
    let id = caravan_id(k.a.citizen_tag(), 0);
    let (i, mut s) = slot_of(&k.c, &k.a.province, id).expect("slot");
    s.raid_off = 0;
    s.raid_pos = 0;
    s.tiles[0] = k.a.tile;
    s.raider = k.r.host_id(0);
    put_slot(&mut k.c, &k.a.province, i, &s);
    k.w.to_bell(&mut k.c, s.first_bell + 1, 5);
    k.w.set_resolved_next(&mut k.c, &k.a.province, s.first_bell + 1);
    let (steps, path) = local_path(&k.c, &k.a, k.a.tile, k.r.tile);
    let ra = RaidCaravanArgs {
        caravan: k.caravan(0),
        raid: (k.a.p, k.a.q),
        raider_holding: k.r.href(),
        choice: raid_choice::TAKE,
        dst: Some(PlaceRef::Holding {
            h: k.r.href(),
            gen: k.r.gen,
        }),
        steps,
        path,
        path_provinces: vec![],
        old_route: vec![(k.a.p, k.a.q)],
    };
    let rix = fx::raid_caravan(&k.w.a, &k.r.player(), &ra);
    expect_lands(
        send_any(&mut k.c, I2::RaidCaravan, &[rix], &[&k.r.wallet]),
        "R takes the couriered caravan",
    );
    let cd = k.c.data(&k.caravan(0));
    assert_eq!(
        &cd[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32],
        k.r.citizen.as_ref()
    );
    let rb = k.stores(&k.r)[1];
    let cv = k.caravan(0);
    k.arrive(&cv);
    let keeper = k.c.funded(b"keeper", 1);
    let st = k.settle_ix(cv, k.r.holding, &keeper.pubkey());
    expect_lands(
        send_any(&mut k.c, I2::SettleCaravan, &[st], &[&keeper]),
        "settled at R's holding",
    );
    assert!(k.stores(&k.r)[1] >= rb + 100 * MILLI);
    assert_eq!(k.vault_store(1), 0, "A's vault got nothing");
    // A second couriered send to the vault, whose generation then changes.
    let x1 = k.send_args(1, [0, 10, 0, 0, 0, 0, 0, 0]);
    expect_lands(courier_send(&mut k, &x1), "second send");
    k.c.edit(&k.vault(), |d| d[VA::GEN] = 2);
    let cv = k.caravan(1);
    k.arrive(&cv);
    let st = k.settle_ix(cv, k.vault(), &keeper.pubkey());
    let l = expect_lands(
        send_any(&mut k.c, I2::SettleCaravan, &[st], &[&keeper]),
        "settle to a vault of another generation",
    );
    assert_eq!(k.vault_store(1), 0);
    match event(&l, CqKind::CARAVAN_SETTLED) {
        fclient::conquest::CqEvent::CaravanSettled { outcome, .. } => {
            assert_eq!(outcome, caravan_outcome::LOST)
        }
        e => panic!("{e:?}"),
    }
}

/// [LOCAL CHAIN: LiteSVM, hostile test-only courier build] The runtime
/// refuses an external program that tries to go around the core: writing a
/// Frontier account's data, spending a Frontier account's lamports, or
/// claiming a signature the transaction does not carry.
#[test]
fn t11_a_hostile_wrapper_cannot_go_around_the_core() {
    let mut k = Cast::new(true);
    expect_lands(k.build_vault(), "BuildVault");
    let hostile = |k: &Cast, sub: u8, accounts: Vec<AccountMeta>, extra: &[u8]| {
        let mut data = vec![OP_HOSTILE, IFACE_VERSION, sub];
        data.extend_from_slice(extra);
        Instruction {
            program_id: k.courier,
            accounts,
            data,
        }
    };
    let before = snapshot(&k, 0);
    // 1. Write A's holding.
    let ix = hostile(&k, 1, vec![AccountMeta::new(k.a.holding, false)], &[]);
    assert_runtime(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&k.a.wallet]),
        "ExternalAccountDataModified",
    );
    // 2. Spend the vault's lamports.
    let ix = hostile(
        &k,
        2,
        vec![
            AccountMeta::new(k.vault(), false),
            AccountMeta::new(k.a.wallet.pubkey(), true),
        ],
        &[],
    );
    assert_runtime(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&k.a.wallet]),
        "ExternalAccountLamportSpend",
    );
    // 3. A's wallet marked signer inside the CPI, signed by nobody.
    let stranger = k.c.funded(b"stranger", 1);
    let x = k.send_args(0, CARGO);
    let mut inner = k.send_ix(&acting(&stranger, &k.a.wallet.pubkey()), &x);
    inner.accounts[0] = AccountMeta::new_readonly(k.a.wallet.pubkey(), false);
    let mut accounts = vec![AccountMeta::new_readonly(k.c.program, false)];
    accounts.extend(inner.accounts.iter().cloned());
    let ix = hostile(&k, 3, accounts, &inner.data);
    assert_runtime(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&stranger]),
        "PrivilegeEscalation",
    );
    assert_eq!(snapshot(&k, 0), before, "nothing moved");
}

// ------------------------------------------------------------ (2) delegated, provisional adapter

struct Delegation {
    p: Pdas,
    cranker: Keypair,
}

/// A registers a mandate, sets its session key to the courier's session
/// PDA (its own top-level SetSession) and funds the purse.
fn delegate(k: &mut Cast, max_sends: u16, cap: [u32; 8], secs: i64) -> Delegation {
    let p = pdas(&k.courier, &k.w.a.season, &k.a.citizen);
    let reg = register_mandate(
        k.courier,
        k.a.wallet.pubkey(),
        k.w.a.season,
        k.a.citizen,
        k.c.now + secs,
        max_sends,
        cap,
    );
    expect_lands(k.c.send(&[reg], &[&k.a.wallet]), "RegisterMandate");
    expect_lands(
        k.set_session(&p.session, k.c.now + secs),
        "SetSession to the courier's session PDA",
    );
    k.c.airdrop(&p.purse, 1_000_000_000);
    let cranker = k.c.funded(b"cranker", 1);
    Delegation { p, cranker }
}

fn delegated_ix(k: &Cast, d: &Delegation, x: &fx::SendCaravanArgs) -> Instruction {
    let inner = k.send_ix(
        &fclient::ix::Player {
            actor: d.p.session,
            payer: d.p.purse,
            wallet: k.a.wallet.pubkey(),
        },
        x,
    );
    send_delegated(k.courier, d.cranker.pubkey(), &inner)
}

fn crank(
    k: &mut Cast,
    d: &Delegation,
    x: &fx::SendCaravanArgs,
) -> permutation_frontier_svm_tests::chain::SendResult {
    let ix = delegated_ix(k, d, x);
    send_any(&mut k.c, I2::SendCaravan, &[ix], &[&d.cranker])
}

/// [LOCAL CHAIN: LiteSVM] Passing point (2), through the provisional
/// adapter: after the owner's one-time setup, a cranker who is not the
/// owner sends the caravan; the owner signs nothing in that transaction.
/// The purse pays the caravan's rent and fee (rent back to the purse at
/// the settle), the cranker only the transaction fee.
#[test]
fn t12_delegated_send_lands_without_the_owners_signature() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let d = delegate(&mut k, 2, [1_000; 8], 3_600);
    let x = k.send_args(0, CARGO);
    let (purse0, crank0, wallet0) = (
        k.c.lamports(&d.p.purse),
        k.c.lamports(&d.cranker.pubkey()),
        k.c.lamports(&k.a.wallet.pubkey()),
    );
    let ix = delegated_ix(&k, &d, &x);
    let t = k.c.transaction(
        &profile_for(
            &k.c,
            I2::SendCaravan,
            std::slice::from_ref(&ix),
            &[&d.cranker],
        ),
        &[ix],
        &[&d.cranker],
    );
    assert_eq!(
        t.message.header.num_required_signatures, 1,
        "the cranker alone signs"
    );
    let l = expect_lands(k.c.submit(t), "delegated SendCaravan");
    assert_eq!(k.caravans(), 1);
    assert_eq!(
        k.c.lamports(&k.a.wallet.pubkey()),
        wallet0,
        "the owner paid nothing and signed nothing"
    );
    assert_eq!(
        k.c.lamports(&d.cranker.pubkey()),
        crank0 - l.fee,
        "the cranker paid the fee only"
    );
    let cv = k.caravan(0);
    let cost = purse0 - k.c.lamports(&d.p.purse);
    assert_eq!(
        cost,
        k.c.lamports(&cv),
        "the purse paid the caravan's rent and settle fee"
    );
    assert_eq!(
        &k.c.data(&cv)[CV::RENT_TO..CV::RENT_TO + 32],
        d.p.purse.as_ref()
    );
    assert_eq!(
        u16::from_le_bytes(
            k.c.data(&d.p.mandate)[mandate::USED..mandate::USED + 2]
                .try_into()
                .unwrap()
        ),
        1
    );
    // The settle: the fee to the settler, the rent back to the purse.
    k.arrive(&cv);
    let keeper = k.c.funded(b"keeper", 1);
    let st = k.settle_ix(cv, k.vault(), &keeper.pubkey());
    expect_lands(
        send_any(&mut k.c, I2::SettleCaravan, &[st], &[&keeper]),
        "settle",
    );
    assert_eq!(k.vault_store(1), 100 * MILLI);
    assert_eq!(
        purse0 - k.c.lamports(&d.p.purse),
        permutation_rules::frontier::caravan::CARAVAN_FEE,
        "only the settle fee stays spent"
    );
    println!(
        "[t12] delegated cu={} tx_bytes={} loaded={}",
        l.cu, l.tx_bytes, l.loaded
    );
}

/// [LOCAL CHAIN: LiteSVM] The delegation's limits: the adapter's own (cargo
/// cap, number of sends, expiry, another citizen's mandate, a forged
/// mandate) and the core's session limits, which the adapter cannot widen
/// (a send to another player `WalletRequired`; the owner's SetSession back
/// to itself revokes, `Auth`; the session's expiry, `SessionExpired`).
#[test]
fn t13_delegation_limits() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let cap = [0, 100, 0, 0, 0, 30, 0, 0];
    let d = delegate(&mut k, 1, cap, 3_600);
    // Over the cap.
    let over = k.send_args(0, [0, 101, 0, 0, 0, 0, 0, 0]);
    assert_courier(
        crank(&mut k, &d, &over),
        &k.courier,
        CourierError::CargoOverCap,
    );
    // To another player: the core's session rule.
    let to_r = k.send_to_r_args(0, [0, 10, 0, 0, 0, 0, 0, 0]);
    assert_cq(crank(&mut k, &d, &to_r), Cq::WalletRequired);
    // One send, then exhausted.
    expect_lands(
        {
            let a = k.send_args(0, CARGO);
            crank(&mut k, &d, &a)
        },
        "first delegated send",
    );
    assert_courier(
        {
            let a = k.send_args(1, [0, 1, 0, 0, 0, 0, 0, 0]);
            crank(&mut k, &d, &a)
        },
        &k.courier,
        CourierError::MandateExhausted,
    );
    // R's citizen with A's mandate: the PDAs are R's, A's mandate is not.
    let a1 = k.send_args(1, [0, 1, 0, 0, 0, 0, 0, 0]);
    let mut ix = delegated_ix(&k, &d, &a1);
    ix.accounts[6].pubkey = k.r.citizen;
    assert_courier(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&d.cranker]),
        &k.courier,
        CourierError::MandateMismatch,
    );
    // A forged mandate: the same bytes, owned by the System program.
    let forged = Address::new_unique();
    let (md, ml) = (k.c.data(&d.p.mandate), k.c.lamports(&d.p.mandate));
    k.c.put(forged, Address::default(), md, ml);
    let a1 = k.send_args(1, [0, 1, 0, 0, 0, 0, 0, 0]);
    let mut ix = delegated_ix(&k, &d, &a1);
    ix.accounts[2].pubkey = forged;
    assert_courier(
        send_any(&mut k.c, I2::SendCaravan, &[ix], &[&d.cranker]),
        &k.courier,
        CourierError::MandateMismatch,
    );
    assert_eq!(k.caravans(), 1);

    // A fresh cast: the expiry, and the owner's revocation.
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let d = delegate(&mut k, 10, [1_000; 8], 3_600);
    // The owner sets the session back to its own wallet: the core refuses.
    let wallet = k.a.wallet.pubkey();
    let exp = k.c.now + 3_600;
    expect_lands(k.set_session(&wallet, exp), "SetSession (revoke)");
    assert_code(
        {
            let a = k.send_args(0, CARGO);
            crank(&mut k, &d, &a)
        },
        E::Auth,
    );
    expect_lands(
        k.set_session(&d.p.session, k.c.now + 60),
        "SetSession to the PDA, 60 s",
    );
    k.c.advance(61);
    assert_code(
        {
            let a = k.send_args(0, CARGO);
            crank(&mut k, &d, &a)
        },
        E::SessionExpired,
    );
    expect_lands(
        k.set_session(&d.p.session, k.c.now + 7_200),
        "SetSession to the PDA, 2 h",
    );
    k.c.advance(3_600);
    assert_courier(
        {
            let a = k.send_args(0, CARGO);
            crank(&mut k, &d, &a)
        },
        &k.courier,
        CourierError::MandateExpired,
    );
    assert_eq!(k.caravans(), 0);
}

/// [LOCAL CHAIN: LiteSVM] The adapter's own setup: only the Citizen's
/// wallet registers or revokes a mandate (`NotWallet`); a mandate for
/// another Citizen's PDA (`MandateMismatch`); a revoked mandate stops the
/// courier (`MandateMismatch`).
#[test]
fn t14_mandate_setup_is_the_owners_alone() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let reg = register_mandate(
        k.courier,
        k.r.wallet.pubkey(),
        k.w.a.season,
        k.a.citizen,
        k.c.now + 3_600,
        1,
        [1_000; 8],
    );
    assert_courier(
        k.c.send(&[reg], &[&k.r.wallet]),
        &k.courier,
        CourierError::NotWallet,
    );
    let mut reg = register_mandate(
        k.courier,
        k.a.wallet.pubkey(),
        k.w.a.season,
        k.a.citizen,
        k.c.now + 3_600,
        1,
        [1_000; 8],
    );
    reg.accounts[3].pubkey = pdas(&k.courier, &k.w.a.season, &k.r.citizen).mandate;
    assert_courier(
        k.c.send(&[reg], &[&k.a.wallet]),
        &k.courier,
        CourierError::MandateMismatch,
    );
    let d = delegate(&mut k, 1, [1_000; 8], 3_600);
    let rv = revoke_mandate(k.courier, k.r.wallet.pubkey(), d.p.mandate);
    assert_courier(
        k.c.send(&[rv], &[&k.r.wallet]),
        &k.courier,
        CourierError::NotWallet,
    );
    let rv = revoke_mandate(k.courier, k.a.wallet.pubkey(), d.p.mandate);
    expect_lands(k.c.send(&[rv], &[&k.a.wallet]), "RevokeMandate");
    assert!(k.c.is_absent(&d.p.mandate));
    assert_courier(
        {
            let a = k.send_args(0, CARGO);
            crank(&mut k, &d, &a)
        },
        &k.courier,
        CourierError::MandateMismatch,
    );
    assert_eq!(k.caravans(), 0);
}

// ------------------------------------------------------------ measurements

/// [LOCAL CHAIN: LiteSVM] What each path costs on this local chain: CU,
/// transaction bytes, SIMD-0186 loaded bytes against the kind's `L(kind)`,
/// the CU limit the relay's budget table names, the fee and the lamports
/// the payer moved. Local figures only (LiteSVM 0.16, mainnet rent
/// parameters, the test-beacon build); not production costs.
/// `COURIER_MEASURE_OUT=<file>` writes them as JSON.
#[test]
fn t20_measure_direct_signed_and_delegated() {
    let mut rows = vec![];
    for path in ["direct", "courier-signed", "courier-delegated"] {
        let mut k = Cast::new(false);
        expect_lands(k.build_vault(), "BuildVault");
        let d = (path == "courier-delegated").then(|| delegate(&mut k, 5, [1_000; 8], 3_600));
        let x = k.send_args(0, CARGO);
        let (ix, payer, signer): (Instruction, Address, &Keypair) = match path {
            "direct" => (
                k.send_ix(&k.a.player(), &x),
                k.a.wallet.pubkey(),
                &k.a.wallet,
            ),
            "courier-signed" => (
                send_signed(k.courier, &k.send_ix(&k.a.player(), &x)),
                k.a.wallet.pubkey(),
                &k.a.wallet,
            ),
            _ => {
                let d = d.as_ref().unwrap();
                (delegated_ix(&k, d, &x), d.p.purse, &d.cranker)
            }
        };
        let fee_payer = signer.pubkey();
        let lk = l_kind(&k.c, I2::SendCaravan);
        let relay_l = frontier_abi::v2::budgets::loaded_limit_s1(I2::SendCaravan);
        let need = loaded_need(&k.c, std::slice::from_ref(&ix), &[signer]);
        let harness = loaded_harness(&k.c, std::slice::from_ref(&ix), &[signer]);
        let validator = loaded_validator(&k.c, std::slice::from_ref(&ix), &[signer]);
        let (p0, f0) = (k.c.lamports(&payer), k.c.lamports(&fee_payer));
        let l = expect_lands(send_any(&mut k.c, I2::SendCaravan, &[ix], &[signer]), path);
        let moved = if payer == fee_payer {
            p0 - k.c.lamports(&payer) - l.fee
        } else {
            p0 - k.c.lamports(&payer)
        };
        let fee_paid = f0 - k.c.lamports(&fee_payer) - if payer == fee_payer { moved } else { 0 };
        let cu_limit = frontier_abi::v2::budgets::cu_limit_s1(I2::SendCaravan);
        rows.push(format!(
            "{{\"path\":\"{path}\",\"cu\":{},\"cu_limit_budget\":{cu_limit},\"within_cu_budget\":{},\"tx_bytes\":{},\"tx_contract\":{},\"loaded_harness_rule\":{harness},\"loaded_validator_rule\":{validator},\"loaded_need_pages\":{need},\"l_kind_harness\":{lk},\"loaded_limit_relay\":{relay_l},\"within_relay_loaded_limit\":{},\"fee\":{fee_paid},\"payer_moved\":{moved},\"caravan_lamports\":{}}}",
            l.cu,
            l.cu <= cu_limit as u64,
            l.tx_bytes,
            frontier_abi::v2::budgets::budget(I2::SendCaravan).tx_contract,
            need <= relay_l,
            k.c.lamports(&k.caravan(0)),
        ));
        println!("[t20] {}", rows.last().unwrap());
    }
    if let Ok(out) = std::env::var("COURIER_MEASURE_OUT") {
        std::fs::write(out, format!("[\n  {}\n]\n", rows.join(",\n  "))).unwrap();
    }
}

/// [LOCAL CHAIN: LiteSVM] The delegated path's one-time setup and the
/// settle, as the owner and a settler pay them (local figures only).
/// `COURIER_SETUP_OUT=<file>` writes them as JSON.
#[test]
fn t21_measure_delegation_setup_and_settle() {
    let mut k = Cast::new(false);
    expect_lands(k.build_vault(), "BuildVault");
    let p = pdas(&k.courier, &k.w.a.season, &k.a.citizen);
    let w0 = k.c.lamports(&k.a.wallet.pubkey());
    let reg = register_mandate(
        k.courier,
        k.a.wallet.pubkey(),
        k.w.a.season,
        k.a.citizen,
        k.c.now + 3_600,
        5,
        [1_000; 8],
    );
    let lr = expect_lands(k.c.send(&[reg], &[&k.a.wallet]), "RegisterMandate");
    let reg_paid = w0 - k.c.lamports(&k.a.wallet.pubkey()) - lr.fee;
    let ls = expect_lands(k.set_session(&p.session, k.c.now + 3_600), "SetSession");
    k.c.airdrop(&p.purse, 1_000_000_000);
    let cranker = k.c.funded(b"cranker", 1);
    let d = Delegation { p, cranker };
    let x = k.send_args(0, CARGO);
    let l = expect_lands(crank(&mut k, &d, &x), "delegated send");
    let cv = k.caravan(0);
    k.arrive(&cv);
    let keeper = k.c.funded(b"keeper", 1);
    let kb = k.c.lamports(&keeper.pubkey());
    let st = k.settle_ix(cv, k.vault(), &keeper.pubkey());
    let lt = expect_lands(
        send_any(&mut k.c, I2::SettleCaravan, &[st], &[&keeper]),
        "settle",
    );
    let settler_net = k.c.lamports(&keeper.pubkey()) as i64 - kb as i64;
    let rv = revoke_mandate(k.courier, k.a.wallet.pubkey(), d.p.mandate);
    let w1 = k.c.lamports(&k.a.wallet.pubkey());
    let lv = expect_lands(k.c.send(&[rv], &[&k.a.wallet]), "RevokeMandate");
    let refund = k.c.lamports(&k.a.wallet.pubkey()) + lv.fee - w1;
    let row = format!(
        "{{\"register_mandate_cu\":{},\"register_mandate_rent\":{reg_paid},\"mandate_size\":{},\"set_session_cu\":{},\"delegated_send_cu\":{},\"settle_cu\":{},\"settle_fee_to_settler_net_of_tx_fee\":{settler_net},\"revoke_cu\":{},\"revoke_refund\":{refund},\"tx_fee_per_signature\":{}}}",
        lr.cu, mandate::SIZE, ls.cu, l.cu, lt.cu, lv.cu, lt.fee
    );
    println!("[t21] {row}");
    assert_eq!(refund, reg_paid, "the mandate's rent comes back");
    if let Ok(out) = std::env::var("COURIER_SETUP_OUT") {
        std::fs::write(out, format!("{row}\n")).unwrap();
    }
}
