//! TEST-ONLY generator of reservation read-path vectors for the Fable map
//! (`FABLE-CONQUEST-ORDER-B-CONTRACT-20261112.md` §14.4 items 1 and 3).
//!
//! Every byte comes from the real ABI codecs and pure plans
//! (`WideConquest::reserve` / `not_apply` / `settle_reservation` /
//! `apply_reservation` / `to_bytes` / `read`, `event::write_body` /
//! `advance` / `write_tail`, `conquest::Receipt::new` / `encode`,
//! `input_digest` / `output_digest`). The only bytes laid out here are the
//! ones the program itself assembles inline without an ABI codec: the
//! SettleReservation outcome (`wide_conquest_settle_exec.rs`
//! `settle_reservation_inner`, the `outcome` vector) and the unchained `PSWR`
//! record body (same function, the `province_present == false` branch).
//!
//! Nothing is written to disk unless `WYLLS_WRITE_VECTORS=<path>` is set; then
//! the JSON document is written to that path.
use super::*;
use crate::world_index::event::{
    self as wev, conquest as rc, WideEntity, WideKind, MAX_BODY, WIDE_LOG_PREFIX,
};
use crate::world_index::wide_ix;
use crate::world_index::WideCoord;
use alloc::format;
use alloc::string::String;
use alloc::vec;

const SEASON_ID: u64 = 11;
const NOW_TS: i64 = 1_785_547_846;
/// The program's escrow refund is `min(Rent::minimum_balance(WideHolding
/// SIZE), escrow)`. For the vector: the Solana default Rent (6,960 lamports
/// per byte incl. the 128-byte account overhead) of a 1,344-byte WideHolding.
const WIDE_RENT: u64 = (128 + crate::world_index::holding::wide_holding::SIZE as u64) * 6_960;

fn world() -> WorldId {
    WorldId::new([0x77; 32]).unwrap()
}
fn key() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(129, 0).unwrap())
}
/// A wide home province of the hosts (ring 130).
fn wide_home() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(130, 0).unwrap())
}
/// A legacy village province (ring 128), as in the real-SBF run.
fn legacy_home() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(128, 0).unwrap())
}
fn label(s: &str) -> [u8; 32] {
    sha256(&[b"WYLLS-RESERVATION-VECTOR-v1", s.as_bytes()])
}
fn rent_payer() -> [u8; 32] {
    label("rent payer")
}
fn citizen(name: &str) -> [u8; 32] {
    label(&format!("citizen {name}"))
}
fn res(name: &str, site: u8, bell: u32, slot: u8, faction: u8, host: WideHostRef) -> Reservation {
    let c = citizen(name);
    Reservation {
        status: RES_PENDING,
        site,
        entry: site + 20,
        reserved_slot: slot,
        faction,
        done: 0,
        bell,
        seq: 0,
        citizen: c,
        host,
        actor_tag: crate::addr::citizen_tag(&c),
        gold_milli: 500_000,
        arms_milli: 50_000,
    }
}
fn wide_host(site: u8, seq: u32) -> WideHostRef {
    WideHostRef::new(wide_home(), site, 1, seq).unwrap()
}
fn idle() -> Record {
    let mut r = Record::ZERO;
    r.faction = CR::BARRED_NONE;
    r
}
fn entry_of(r: &Reservation) -> WideConquestEntry {
    WideConquestEntry {
        rules: SiteRecordRules {
            kind: CR::KIND_SIEGE,
            faction: r.faction,
            flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
            progress: 0,
            required: 36,
            target: CR::target(CR::TARGET_FREE_CITY, r.reserved_slot),
            vigil_start: 0,
            vigil_next: 0,
            vigil_from_day: 0,
            bell: r.bell,
        },
        citizen: r.citizen,
        source: Some(r.source()),
        actor_tag: r.actor_tag,
        reserved_slot: r.reserved_slot,
        original_target_gen: 0,
        declaration_bell: r.bell,
    }
}

// ------------------------------------------------------------ text helpers

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}
fn base58(b: &[u8]) -> String {
    const A: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let zeros = b.iter().take_while(|x| **x == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for &byte in b {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut s = String::new();
    for _ in 0..zeros {
        s.push('1');
    }
    for d in digits.iter().rev() {
        s.push(A[*d as usize] as char);
    }
    s
}
fn q(s: &str) -> String {
    format!("\"{s}\"")
}
fn obj(fields: &[(&str, String)]) -> String {
    let inner: Vec<String> = fields.iter().map(|(k, v)| format!("{}:{}", q(k), v)).collect();
    format!("{{{}}}", inner.join(","))
}
fn arr(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

#[test]
fn base58_matches_known_values() {
    assert_eq!(base58(&[0u8; 32]), "11111111111111111111111111111111");
    assert_eq!(base58(b"hello world"), "StV1DL6CwTryKyV");
    assert_eq!(base58(&[0, 0, 1]), "112");
}

// ------------------------------------------------------------ (a) the table

/// The table, built only through the real pure plans, with each site's
/// province prefix as the program writes it.
struct Built {
    table: WideConquest,
    prefixes: [Record; 12],
    applied: Reservation,
    freed_seq: u32,
}

fn reserve(t: &mut WideConquest, p: &mut [Record; 12], r: Reservation) -> Reservation {
    let (next, prefix, r) = t.reserve(p[r.site as usize], r).unwrap();
    *t = next;
    p[r.site as usize] = prefix;
    r
}
fn not_apply(t: &mut WideConquest, p: &mut [Record; 12], seq: u32) {
    let (i, r) = t.reservation(seq).unwrap();
    *t = t.not_apply(i).unwrap();
    if t.entry(r.site).unwrap().is_none() {
        p[r.site as usize] = t.idle_prefix(r.site, p[r.site as usize]).unwrap();
    }
}

fn build() -> Built {
    let mut t = WideConquest::new(SEASON_ID, key(), rent_payer()).unwrap();
    let mut p = [idle(); 12];
    // seq 0..4, records 0..4
    let a0 = reserve(&mut t, &mut p, res("A", 5, 30, 2, 0, wide_host(0, 3)));
    let c1 = reserve(&mut t, &mut p, res("C", 3, 36, 3, 2, wide_host(2, 1)));
    let b2 = reserve(&mut t, &mut p, res("B", 1, 38, 2, 1, wide_host(1, 4)));
    let e3 = reserve(&mut t, &mut p, res("E", 9, 35, 2, 4, wide_host(4, 0)));
    let f4 = reserve(&mut t, &mut p, res("F", 10, 33, 3, 5, wide_host(5, 2)));
    assert_eq!((a0.seq, c1.seq, b2.seq, e3.seq, f4.seq), (0, 1, 2, 3, 4));
    // bell 30: A's reservation does not apply; slot and rent released, resources blocked
    not_apply(&mut t, &mut p, 0);
    t = t.settle_reservation(0, false, true, false).unwrap().conquest;
    // bell 33: F does not apply (fully returned later); bell 35: E applies
    not_apply(&mut t, &mut p, 4);
    let i = t.reservation(3).unwrap().0;
    let plan = t.apply_reservation(i, entry_of(&e3)).unwrap();
    t = plan.conquest;
    p[9] = plan.prefix;
    // bell 36: C does not apply; resources returned, slot/rent still owed
    not_apply(&mut t, &mut p, 1);
    t = t.settle_reservation(1, true, false, false).unwrap().conquest;
    // bell 38: B does not apply; nothing returned yet
    not_apply(&mut t, &mut p, 2);
    // A reserves again on slot 2 (its earlier record no longer holds it), with a
    // legacy (ring 128) village host as in the real-SBF run; D reserves too.
    let a5 = reserve(
        &mut t,
        &mut p,
        res("A", 1, 40, 2, 0, WideHostRef::new(legacy_home(), 0, 2, 0).unwrap()),
    );
    let d6 = reserve(&mut t, &mut p, res("D", 7, 41, 3, 3, wide_host(3, 5)));
    assert_eq!((a5.seq, d6.seq), (5, 6));
    // F's return completes: its record is freed (a gap between used records)
    let s = t.settle_reservation(4, true, true, false).unwrap();
    assert!(s.freed);
    t = s.conquest;
    Built {
        table: t,
        prefixes: p,
        applied: e3,
        freed_seq: 4,
    }
}

fn status_name(s: u8) -> &'static str {
    match s {
        RES_PENDING => "pending",
        RES_NOT_APPLIED => "not_applied",
        _ => "?",
    }
}

#[test]
fn table_vector_roundtrips_through_the_real_codec() {
    let b = build();
    let bytes = b.table.to_bytes();
    assert_eq!(bytes.len(), 2688);
    let back = WideConquest::read(&bytes, SEASON_ID, key()).unwrap();
    assert_eq!(back, b.table);
    assert_eq!(back.to_bytes(), bytes);
    assert_eq!(back.next_seq(), 7);
    // layout: record i at 1664 + 128 i; the counter at 120
    assert_eq!(u32::from_le_bytes(bytes[120..124].try_into().unwrap()), 7);
    let used: Vec<Option<(u8, u8, u32)>> = back
        .reservations()
        .iter()
        .map(|r| r.map(|r| (r.status, r.done, r.seq)))
        .collect();
    assert_eq!(
        used,
        [
            Some((RES_NOT_APPLIED, RES_SLOT_RENT_RELEASED, 0)),
            Some((RES_NOT_APPLIED, RES_RESOURCES_RETURNED, 1)),
            Some((RES_NOT_APPLIED, 0, 2)),
            Some((RES_PENDING, 0, 5)),
            None,
            Some((RES_PENDING, 0, 6)),
            None,
            None,
        ]
    );
    for (i, r) in back.reservations().iter().enumerate() {
        let o = 1664 + 128 * i;
        match r {
            None => assert!(bytes[o..o + 128].iter().all(|x| *x == 0)),
            Some(r) => {
                assert_eq!(bytes[o], r.status);
                assert_eq!(bytes[o + 5], r.done);
                assert_eq!(&bytes[o + 16..o + 48], &r.citizen);
                assert_eq!(u64::from_le_bytes(bytes[o + 112..o + 120].try_into().unwrap()), r.gold_milli);
            }
        }
    }
    // every site prefix pairs with the table (PENDING flag both ways)
    for s in 0..12u8 {
        back.validate_paired(s, b.prefixes[s as usize]).unwrap();
    }
    assert_eq!(b.prefixes[1].flags, CR::FLAG_PENDING);
    assert_eq!(b.prefixes[7].flags, CR::FLAG_PENDING);
    assert_eq!(b.prefixes[3].flags, 0);
    // the applied reservation is now the site entry, with its bell and slot
    let e = back.entry(9).unwrap().unwrap();
    assert_eq!((e.citizen, e.reserved_slot, e.declaration_bell), (b.applied.citizen, 2, 35));
    assert!(back.reservation(b.applied.seq).is_none() && back.reservation(b.freed_seq).is_none());
}

fn record_json(i: usize, r: &Reservation) -> String {
    let h = r.host;
    obj(&[
        ("index", format!("{i}")),
        ("offset", format!("{}", 1664 + 128 * i)),
        ("record_hex", q(&hex(&r_bytes(r)))),
        ("status", format!("{}", r.status)),
        ("status_name", q(status_name(r.status))),
        ("site", format!("{}", r.site)),
        ("entry", format!("{}", r.entry)),
        ("slot", format!("{}", r.reserved_slot)),
        ("faction", format!("{}", r.faction)),
        ("done", format!("{}", r.done)),
        ("resources_returned", format!("{}", r.done & RES_RESOURCES_RETURNED != 0)),
        ("slot_rent_released", format!("{}", r.done & RES_SLOT_RENT_RELEASED != 0)),
        ("holds_slot", format!("{}", r.holds_slot())),
        ("bell", format!("{}", r.bell)),
        ("seq", format!("{}", r.seq)),
        ("citizen_base58", q(&base58(&r.citizen))),
        ("citizen_hex", q(&hex(&r.citizen))),
        ("actor_tag", q(&format!("{}", r.actor_tag))),
        ("gold_milli", q(&format!("{}", r.gold_milli))),
        ("arms_milli", q(&format!("{}", r.arms_milli))),
        ("host_ref_hex", q(&hex(&h.to_bytes()))),
        (
            "host",
            obj(&[
                ("p", format!("{}", h.key().coord().p())),
                ("q", format!("{}", h.key().coord().q())),
                ("site", format!("{}", h.site())),
                ("gen", format!("{}", h.gen())),
                ("seq", format!("{}", h.seq())),
            ]),
        ),
        ("source_holding_ref_hex", q(&hex(&r.source().to_bytes()))),
        (
            "fable_decoder_expected",
            obj(&[
                ("index", format!("{i}")),
                ("status", q(status_name(r.status))),
                ("site", format!("{}", r.site)),
                ("entry", format!("{}", r.entry)),
                ("slot", format!("{}", r.reserved_slot)),
                ("faction", format!("{}", r.faction)),
                ("resourcesReturned", format!("{}", r.done & RES_RESOURCES_RETURNED != 0)),
                ("slotRentReleased", format!("{}", r.done & RES_SLOT_RENT_RELEASED != 0)),
                ("bell", format!("{}", r.bell)),
                ("seq", format!("{}", r.seq)),
                ("citizen", q(&base58(&r.citizen))),
                ("goldMilli", q(&format!("{}", r.gold_milli))),
                ("armsMilli", q(&format!("{}", r.arms_milli))),
            ]),
        ),
    ])
}
fn r_bytes(r: &Reservation) -> [u8; RESERVATION_LEN] {
    let mut b = [0u8; RESERVATION_LEN];
    r.write(&mut b);
    b
}

fn table_json() -> String {
    let b = build();
    let bytes = b.table.to_bytes();
    let records: Vec<String> = b
        .table
        .reservations()
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.as_ref().map(|r| record_json(i, r)))
        .collect();
    let free: Vec<String> = b
        .table
        .reservations()
        .iter()
        .enumerate()
        .filter(|(_, r)| r.is_none())
        .map(|(i, _)| format!("{i}"))
        .collect();
    let sites: Vec<String> = (0..12u8)
        .map(|s| {
            let p = b.prefixes[s as usize];
            let e = b.table.entry(s).unwrap();
            obj(&[
                ("site", format!("{s}")),
                ("entry_present", format!("{}", e.is_some())),
                ("prefix_kind", format!("{}", p.kind)),
                ("prefix_flags", format!("{}", p.flags)),
                ("pending_flag", format!("{}", p.flags & CR::FLAG_PENDING != 0)),
                ("has_pending_reservation", format!("{}", b.table.has_pending(s))),
            ])
        })
        .collect();
    let e = b.table.entry(9).unwrap().unwrap();
    obj(&[
        ("season_id", q(&format!("{SEASON_ID}"))),
        ("world_hex", q(&hex(world().as_bytes()))),
        ("province", obj(&[("p", q("129")), ("q", q("0"))])),
        ("province_key_hex", q(&hex(&key().to_bytes()))),
        ("rent_payer_hex", q(&hex(&rent_payer()))),
        ("size", "2688".into()),
        ("next_reservation_seq", format!("{}", b.table.next_seq())),
        ("table_hex", q(&hex(&bytes))),
        ("records", arr(&records)),
        ("free_record_indices", arr(&free)),
        ("site_prefixes", arr(&sites)),
        (
            "applied_reservation_now_site_entry",
            obj(&[
                ("former_seq", format!("{}", b.applied.seq)),
                ("site", "9".into()),
                ("kind", format!("{}", e.rules.kind)),
                ("citizen_base58", q(&base58(&e.citizen))),
                ("reserved_slot", format!("{}", e.reserved_slot)),
                ("declaration_bell", format!("{}", e.declaration_bell)),
                ("source_holding_ref_hex", q(&hex(&e.source.unwrap().to_bytes()))),
            ]),
        ),
        ("fully_returned_seq_absent", format!("{}", b.freed_seq)),
        (
            "history",
            q("seq0 A site5 bell30 not applied, slot/rent released (resources blocked); seq1 C site3 bell36 not applied, resources returned; seq2 B site1 bell38 not applied, nothing returned; seq3 E site9 bell35 APPLIED (now the site 9 entry); seq4 F site10 bell33 not applied and fully returned (record freed); seq5 A site1 bell40 PENDING (legacy ring-128 host); seq6 D site7 bell41 PENDING"),
        ),
    ])
}

// ------------------------------------------------------------ (b) refused tables

fn refused() -> Vec<(&'static str, [u8; CONQUEST_SIZE], ConquestError)> {
    let b = build();
    // both done bits on a NOT_APPLIED record (the program frees such a record)
    let mut both = b.table.clone();
    let mut r = both.reservations[2].unwrap();
    r.done = RES_RESOURCES_RETURNED | RES_SLOT_RENT_RELEASED;
    both.reservations[2] = Some(r);
    // two records with the same seq
    let mut dup = b.table.clone();
    let mut r = dup.reservations[5].unwrap();
    r.seq = dup.reservations[3].unwrap().seq;
    dup.reservations[5] = Some(r);
    vec![
        ("both_done_bits", both.to_bytes(), ConquestError::State),
        ("duplicate_seq", dup.to_bytes(), ConquestError::State),
    ]
}

#[test]
fn refused_tables_give_their_conquest_error() {
    for (_, bytes, want) in refused() {
        assert_eq!(WideConquest::read(&bytes, SEASON_ID, key()).err(), Some(want));
    }
}

fn refused_json() -> String {
    let items: Vec<String> = refused()
        .iter()
        .map(|(name, bytes, want)| {
            let at = match *name {
                "both_done_bits" => "record index 2 (seq 2): done = 3",
                _ => "record index 5 (seq 6 -> 5): same seq as record index 3",
            };
            obj(&[
                ("name", q(name)),
                ("change", q(at)),
                ("expected_error", q(&format!("{want:?}"))),
                ("fable_decoder_expected_code", q(match *name {
                    "both_done_bits" => "ReservationRecordDone",
                    _ => "ReservationRecordSeq",
                })),
                ("table_hex", q(&hex(bytes))),
            ])
        })
        .collect();
    arr(&items)
}

// ------------------------------------------------------------ (c) receipts and bodies

/// A synthetic, deterministic receipt context and manifest. The digests are
/// NOT reproducible from any chain; they show what each digest commits to.
fn synthetic_accounts() -> Vec<(u16, [u8; 32], Vec<u8>, u64)> {
    vec![
        (1, label("account 1"), vec![1, 2, 3], 1_000),
        (2, label("account 2"), vec![4, 5, 6, 7], 2_000),
    ]
}
fn receipt_for(action: u8, command: &[u8], bell: u32, evidence: &[u8], outcomes: &[u8]) -> rc::Receipt {
    let season = label("season account bytes");
    let ctx = rc::Context {
        command,
        now_ts: NOW_TS,
        bell,
        season: &season,
        evidence,
    };
    let acc = synthetic_accounts();
    let snaps: Vec<rc::AccountSnapshot<'_>> = acc
        .iter()
        .map(|(role, address, data, lamports)| rc::AccountSnapshot {
            role: *role,
            address: *address,
            owner: label("program"),
            present: true,
            lamports: *lamports,
            data,
            chained: false,
        })
        .collect();
    let input = rc::input_digest(&ctx, &snaps).unwrap();
    let output = rc::output_digest(&ctx, &snaps, outcomes).unwrap();
    let r = rc::Receipt::new(action, 0, input, output).unwrap();
    assert_eq!(rc::Receipt::decode(&r.encode()).unwrap(), r);
    r
}
/// A chained record body: `write_body`, then `advance` each linked entity
/// from a fixed previous chain state, then `write_tail` (the program's
/// `Stage::event` / `prepare_wide`).
fn chained(kind: WideKind, bell: u32, event_key: &[u8], r: &rc::Receipt) -> (Vec<u8>, Vec<(u8, u64, [u8; 32])>) {
    let mut body = [0u8; MAX_BODY];
    let n = wev::write_body(kind, bell, event_key, &r.encode(), &mut body).unwrap();
    let mut links = Vec::new();
    let mut prev = Vec::new();
    for e in kind.links() {
        let (seq, head) = match e {
            WideEntity::Province => (41u64, label("province chain head before")),
            WideEntity::Holding => (7u64, label("holding chain head before")),
        };
        prev.push((*e as u8, seq, head));
        links.push(wev::advance(*e, seq, &head, &body[..n]).unwrap());
    }
    let m = wev::write_tail(kind, &links, &mut body, n).unwrap();
    let rec = wev::WideRecord::decode(&body[..m]).unwrap();
    assert_eq!((rec.kind, rec.bell, rec.payload), (kind, bell, &r.encode()[..]));
    (body[..m].to_vec(), prev)
}
fn body_json(kind: WideKind, bell: u32, event_key: &[u8], r: &rc::Receipt) -> String {
    let (b, prev) = chained(kind, bell, event_key, r);
    let prev: Vec<String> = prev
        .iter()
        .map(|(e, s, h)| obj(&[("entity", format!("{e}")), ("seq_before", format!("{s}")), ("head_before_hex", q(&hex(h)))]))
        .collect();
    obj(&[
        ("log_prefix", q(core::str::from_utf8(WIDE_LOG_PREFIX).unwrap())),
        ("kind", format!("{}", kind as u8)),
        ("kind_name", q(kind.name())),
        ("key_hex", q(&hex(event_key))),
        ("chain_before", arr(&prev)),
        ("body_hex", q(&hex(&b))),
    ])
}
fn receipt_json(r: &rc::Receipt) -> String {
    obj(&[
        ("action", format!("{}", r.action)),
        ("outcome_byte", format!("{}", r.outcome)),
        ("operation_id_hex", q(&hex(&r.operation_id))),
        ("input_digest_hex", q(&hex(&r.input))),
        ("output_digest_hex", q(&hex(&r.output))),
        ("receipt_hex", q(&hex(&r.encode()))),
    ])
}

/// The record every refund case settles (wide source, so the credit event
/// is a chained WIDE_CONQUEST_CREDITED; a legacy source logs the existing
/// `PS2` legacy source receipt instead).
fn refund_case_reservation() -> Reservation {
    let mut r = res("B", 1, 38, 2, 1, wide_host(1, 4));
    r.seq = 2;
    r
}

struct Case {
    name: &'static str,
    outcome: [u8; 28],
    plan: ReservationSettle,
    terminal: bool,
    province_present: bool,
}

/// One SettleReservation case run through the real pure plan, with the
/// outcome bytes assembled exactly as `settle_reservation_inner` does.
fn case(
    name: &'static str,
    pending: bool,
    done_before: u8,
    resources_ok: bool,
    slot_rent_ok: bool,
    terminal_lapse: bool,
    terminal: bool,
    province_present: bool,
) -> Case {
    let mut t = WideConquest::new(SEASON_ID, key(), rent_payer()).unwrap();
    // two earlier reservations of this province are gone: this one gets seq 2
    t.next_seq = 2;
    let (next, _, r) = t.reserve(idle(), refund_case_reservation()).unwrap();
    t = next;
    let seq = r.seq;
    assert_eq!(seq, 2);
    if !pending {
        t = t.not_apply(t.reservation(seq).unwrap().0).unwrap();
        let mut rr = t.reservation(seq).unwrap().1;
        rr.done = done_before;
        let i = t.reservation(seq).unwrap().0;
        t.reservations[i] = Some(rr);
        t = WideConquest::read(&t.to_bytes(), SEASON_ID, key()).unwrap();
    }
    let plan = t.settle_reservation(seq, resources_ok, slot_rent_ok, terminal_lapse).unwrap();
    // handler: refund only when the binding is refunded from a live escrow
    let refund = if plan.release_slot_rent && !terminal { WIDE_RENT } else { 0 };
    let (gold, arms) = if plan.return_resources {
        (r.gold_milli, r.arms_milli)
    } else {
        (0, 0)
    };
    let done_after = plan
        .conquest
        .reservation(seq)
        .map_or(RES_RESOURCES_RETURNED | RES_SLOT_RENT_RELEASED, |(_, n)| n.done);
    let mut outcome = [0u8; 28];
    outcome[0..8].copy_from_slice(&refund.to_le_bytes());
    outcome[8..16].copy_from_slice(&gold.to_le_bytes());
    outcome[16..24].copy_from_slice(&arms.to_le_bytes());
    outcome[24] = done_after;
    outcome[25] = u8::from(terminal);
    outcome[26] = u8::from(plan.lapsed);
    outcome[27] = u8::from(province_present);
    Case {
        name,
        outcome,
        plan,
        terminal,
        province_present,
    }
}
fn cases() -> Vec<Case> {
    vec![
        // NOT_APPLIED, nothing done; resources fit, slot/rent cannot be paired now
        case("resources_only", false, 0, true, false, false, false, true),
        // NOT_APPLIED, nothing done; resources blocked (no room / source absent)
        case("slot_rent_only", false, 0, false, true, false, false, true),
        case("both", false, 0, true, true, false, false, true),
        // closable season, escrow already closed by CloseCaptureEscrow
        case("terminal_escrow_close", false, RES_RESOURCES_RETURNED, false, true, false, true, true),
        // Aborted season: a PENDING reservation lapses; nothing doable now
        case("lapsed", true, 0, false, false, true, false, true),
        // closable season, province closed: lapse + terminal escrow + resources
        case("province_absent_pswr", true, 0, true, true, true, true, false),
    ]
}

#[test]
fn outcome_layout_and_bodies_follow_the_handler() {
    let cs = cases();
    let want: [(u64, u64, u64, u8, u8, u8, u8); 6] = [
        (0, 500_000, 50_000, 1, 0, 0, 1),
        (WIDE_RENT, 0, 0, 2, 0, 0, 1),
        (WIDE_RENT, 500_000, 50_000, 3, 0, 0, 1),
        (0, 0, 0, 3, 1, 0, 1),
        (0, 0, 0, 0, 0, 1, 1),
        (0, 500_000, 50_000, 3, 1, 1, 0),
    ];
    let mut outputs = Vec::new();
    for (c, w) in cs.iter().zip(want) {
        let o = &c.outcome;
        let u = |a: usize| u64::from_le_bytes(o[a..a + 8].try_into().unwrap());
        assert_eq!((u(0), u(8), u(16), o[24], o[25], o[26], o[27]), w, "{}", c.name);
        let r = receipt_for(
            rc::RESERVATION_REFUND,
            &wide_ix::SettleReservation { seq: 2 }.to_bytes(),
            40,
            &[],
            &o[..],
        );
        // the outcome is committed ONLY through the output digest
        assert_eq!(r.encode()[2], 0);
        outputs.push(r.output);
        if c.province_present {
            chained(WideKind::ConquestSettled, 40, &key().to_bytes(), &r);
        } else {
            assert_eq!(pswr(&r).len(), 1 + 32 + 32 + 4 + 4 + 100);
        }
        if c.plan.return_resources {
            chained(WideKind::ConquestCredited, 40, &refund_case_reservation().source().to_bytes(), &r);
        }
        let _ = c.terminal;
    }
    // differing outcomes -> differing output digests (lapsed alone too)
    for i in 0..outputs.len() {
        for j in i + 1..outputs.len() {
            assert_ne!(outputs[i], outputs[j]);
        }
    }
    // a refund receipt never passes as a declaration-side record and back
    let r9 = receipt_for(rc::RESERVATION_REFUND, &[1], 40, &[], &[0]);
    let mut out = [0u8; MAX_BODY];
    assert!(wev::write_body(WideKind::ConquestDeclared, 40, &key().to_bytes(), &r9.encode(), &mut out).is_none());
}

/// The unchained record of `settle_reservation_inner` when the target
/// province is absent: version 1, Season address, conquest table address,
/// seq (u32 LE), bell (u32 LE), receipt (100). Logged as
/// `sol_log_data(["PSWR", body])`.
fn pswr(r: &rc::Receipt) -> Vec<u8> {
    let (season, table) = pswr_addresses();
    let mut b = Vec::new();
    b.push(1);
    b.extend_from_slice(&season);
    b.extend_from_slice(&table);
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&40u32.to_le_bytes());
    b.extend_from_slice(&r.encode());
    b
}
fn pswr_addresses() -> ([u8; 32], [u8; 32]) {
    let ctx = crate::addr::AddrCtx {
        season: label("season address"),
        program: label("program address"),
    };
    (ctx.season, conquest_address(&ctx, key()))
}

fn reserve_json() -> String {
    // action 8: outcome = total lamports funded (u64), evidence = host ref
    let r = refund_case_reservation();
    let total: u64 = 25_000_000;
    let cmd = wide_ix::DeclareSiege { site: r.site, entry: r.entry }.to_bytes();
    let rc8 = receipt_for(rc::RESERVE, &cmd, r.bell, &r.host.to_bytes(), &total.to_le_bytes());
    obj(&[
        ("action", "8".into()),
        ("note", q("RESERVE: the DeclareSiege that became a reservation. Same record kinds as DECLARE (1): WIDE_CONQUEST_DECLARED on the province chain + the source debit (WIDE_CONQUEST_DEBITED for a wide source; the PS2 legacy source receipt for a legacy village). Digests are over a SYNTHETIC manifest.")),
        ("command_hex", q(&hex(&cmd))),
        ("evidence_hex", q(&hex(&r.host.to_bytes()))),
        ("outcome_label", q("synthetic preimage expected values (not extractable from logs)")),
        ("outcome_preimage_hex", q(&hex(&total.to_le_bytes()))),
        ("outcome_preimage_expected", obj(&[("total_lamports_funded", q(&format!("{total}")))])),
        ("receipt", receipt_json(&rc8)),
        ("declared", body_json(WideKind::ConquestDeclared, r.bell, &key().to_bytes(), &rc8)),
        ("debited_wide_source", body_json(WideKind::ConquestDebited, r.bell, &r.source().to_bytes(), &rc8)),
    ])
}

fn refunds_json() -> String {
    let items: Vec<String> = cases()
        .iter()
        .map(|c| {
            let o = &c.outcome[..];
            let u = |a: usize| u64::from_le_bytes(o[a..a + 8].try_into().unwrap());
            let r = receipt_for(
                rc::RESERVATION_REFUND,
                &wide_ix::SettleReservation { seq: 2 }.to_bytes(),
                40,
                &[],
                o,
            );
            let record = if c.province_present {
                body_json(WideKind::ConquestSettled, 40, &key().to_bytes(), &r)
            } else {
                let (season, table) = pswr_addresses();
                obj(&[
                    ("log_prefix", q("PSWR")),
                    ("version", "1".into()),
                    ("season_address_hex", q(&hex(&season))),
                    ("table_address_hex", q(&hex(&table))),
                    ("seq", "2".into()),
                    ("bell", "40".into()),
                    ("body_hex", q(&hex(&pswr(&r)))),
                    ("body_len", format!("{}", pswr(&r).len())),
                ])
            };
            let credited = if c.plan.return_resources {
                body_json(WideKind::ConquestCredited, 40, &refund_case_reservation().source().to_bytes(), &r)
            } else {
                "null".into()
            };
            obj(&[
                ("name", q(c.name)),
                ("command_hex", q(&hex(&wide_ix::SettleReservation { seq: 2 }.to_bytes()))),
                ("outcome_label", q("synthetic preimage expected values (not extractable from logs)")),
                ("outcome_preimage_hex", q(&hex(o))),
                (
                    "outcome_preimage_expected",
                    obj(&[
                        ("rent_refunded", q(&format!("{}", u(0)))),
                        ("gold_returned_milli", q(&format!("{}", u(8)))),
                        ("arms_returned_milli", q(&format!("{}", u(16)))),
                        ("done_after", format!("{}", o[24])),
                        ("terminal", format!("{}", o[25])),
                        ("lapsed", format!("{}", o[26])),
                        ("province_present", format!("{}", o[27])),
                    ]),
                ),
                ("record_freed", format!("{}", c.plan.freed)),
                ("receipt", receipt_json(&r)),
                ("settled_or_pswr", record),
                ("credited_wide_source", credited),
            ])
        })
        .collect();
    arr(&items)
}

fn document() -> String {
    obj(&[
        ("schema", q("wylls-conquest-reservation-vectors-v1")),
        ("generator", q("frontier-abi/src/world_index/conquest_reservation_vectors_tests.rs (cargo test -p frontier-abi --features conquest-dispatch-experimental)")),
        ("synthetic", q("All values are a test fixture built through the real ABI codecs; no chain, world or key. Receipt digests are over a synthetic manifest and are not replayable against any chain.")),
        ("table", table_json()),
        ("refused_tables", refused_json()),
        (
            "receipts",
            obj(&[
                ("outcome_not_in_receipt", q("Receipt::new refuses a nonzero outcome byte: the 100-byte receipt carries only version, action, outcome byte 0, operation_id and the input/output digests. The outcome bytes (outcome_preimage_*) are committed only inside the output digest preimage: they are synthetic preimage expected values, NOT extractable from the receipt, a PSW1/PS2 body or a PSWR line")),
                ("evidence_kind", q("synthetic codec evidence: built through the real ABI codecs over a synthetic manifest; not chain evidence")),
                ("refund_outcome_layout", q("rent_refunded u64 LE | gold_returned_milli u64 LE | arms_returned_milli u64 LE | done_after u8 | terminal u8 | lapsed u8 | province_present u8 (28 bytes)")),
                ("reserve", reserve_json()),
                ("reservation_refund", refunds_json()),
                ("legacy_source_ps2", legacy_json()),
            ]),
        ),
    ])
}

#[test]
fn vectors_document_is_written_only_when_requested() {
    let doc = document();
    assert!(doc.starts_with('{') && doc.ends_with('}'));
    if let Ok(path) = std::env::var("WYLLS_WRITE_VECTORS") {
        let mut s = doc;
        s.push('\n');
        std::fs::write(&path, s).expect("write the vectors file");
        std::eprintln!("wrote {path}");
    }
}

// ------------------------------------------------------------ legacy source (PS2 kind 145)

/// A legacy (ring <= R_MAX_HARD) source Holding does not emit
/// WIDE_CONQUEST_DEBITED / CREDITED: the program's `prepare_source`
/// (`wide_conquest_exec.rs`) emits the PS2 kind-145
/// `legacy_source_event::SourceReceipt` instead (prefix `PS2`, the Holding's
/// existing PS2 chain). Its world must be the Season-derived legacy world, so
/// this section uses the resolver of a synthetic AddrCtx.
struct Legacy {
    resolver: crate::world_index::expedition::AccountResolver,
    source: WideHostRef,
    source_address: [u8; 32],
    target: ProvinceKey,
}
fn legacy() -> Legacy {
    use crate::world_index::expedition::{AccountFamily, AccountResolver};
    let ctx = crate::addr::AddrCtx {
        season: label("season address"),
        program: label("program address"),
    };
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let w = resolver.adapter().world();
    let source =
        WideHostRef::new(ProvinceKey::new(w, WideCoord::checked(128, 0).unwrap()), 0, 2, 0).unwrap();
    let target = ProvinceKey::new(w, WideCoord::checked(129, 0).unwrap());
    assert_eq!(resolver.family(source.key()).unwrap(), AccountFamily::Legacy);
    assert_eq!(resolver.family(target).unwrap(), AccountFamily::Wide);
    let source_address = resolver.holding_address(&source).unwrap();
    Legacy {
        resolver,
        source,
        source_address,
        target,
    }
}
/// (name, action, target kind, receipt, PS2 body, outcome preimage)
fn legacy_cases() -> Vec<(&'static str, u8, WideKind, rc::Receipt, Vec<u8>, Vec<u8>)> {
    use crate::world_index::legacy_source_event as le;
    let l = legacy();
    let prev_head = label("legacy holding PS2 head before");
    let refund_outcome = {
        let mut o = Vec::new();
        for n in [WIDE_RENT, 500_000u64, 50_000u64] {
            o.extend_from_slice(&n.to_le_bytes());
        }
        o.extend_from_slice(&[3, 0, 0, 1]);
        o
    };
    let rows: [(&'static str, le::Direction, u8, WideKind, u32, Vec<u8>, Vec<u8>, Vec<u8>); 2] = [
        (
            "debit_reserve",
            le::Direction::Debit,
            rc::RESERVE,
            WideKind::ConquestDeclared,
            19,
            wide_ix::DeclareSiege { site: 1, entry: 0 }.to_bytes().to_vec(),
            l.source.to_bytes().to_vec(),
            25_000_000u64.to_le_bytes().to_vec(),
        ),
        (
            "credit_reservation_refund",
            le::Direction::Credit,
            rc::RESERVATION_REFUND,
            WideKind::ConquestSettled,
            40,
            wide_ix::SettleReservation { seq: 0 }.to_bytes().to_vec(),
            Vec::new(),
            refund_outcome,
        ),
    ];
    let mut out = Vec::new();
    for (name, dir, action, kind, bell, cmd, evidence, outcome) in rows {
        let r = receipt_for(action, &cmd, bell, &evidence, &outcome);
        let sr = le::SourceReceipt {
            direction: dir,
            bell,
            source: l.source,
            source_address: l.source_address,
            receipt: r,
        };
        let (body, link) = sr.prepare(&l.resolver, 12, &prev_head).unwrap();
        // decoded and verified back, then paired with its target record
        let rec = le::Record::decode(&l.resolver, &body).unwrap();
        assert_eq!(rec.source, sr);
        assert_eq!(rec.link, link);
        rec.verify_previous(&l.resolver, 12, &prev_head).unwrap();
        let (target, _) = chained(kind, bell, &l.target.to_bytes(), &r);
        let tr = wev::WideRecord::decode(&target).unwrap();
        sr.pair_target(&l.resolver, &tr).unwrap();
        // the other target kind refuses this receipt
        let wrong = if kind == WideKind::ConquestDeclared {
            WideKind::ConquestSettled
        } else {
            WideKind::ConquestDeclared
        };
        let mut buf = [0u8; MAX_BODY];
        assert!(wev::write_body(wrong, bell, &l.target.to_bytes(), &r.encode(), &mut buf).is_none());
        out.push((name, action, kind, r, body.to_vec(), outcome));
    }
    out
}

#[test]
fn legacy_source_records_prepare_decode_and_pair() {
    let cs = legacy_cases();
    assert_eq!(cs.len(), 2);
    for (_, action, _, r, body, _) in &cs {
        assert_eq!(body.len(), crate::world_index::legacy_source_event::BODY_LEN);
        assert_eq!((body[1], body[7]), (145, if *action == rc::RESERVE { 1 } else { 2 }));
        assert_eq!(&body[98..198], &r.encode()[..]);
    }
}

fn legacy_json() -> String {
    let l = legacy();
    let items: Vec<String> = legacy_cases()
        .iter()
        .map(|(name, action, kind, r, body, outcome)| {
            obj(&[
                ("name", q(name)),
                ("log_prefix", q("PS2")),
                ("ps2_kind", "145".into()),
                ("direction", format!("{}", if *action == rc::RESERVE { 1 } else { 2 })),
                ("action", format!("{action}")),
                ("pairs_with", q(kind.name())),
                ("outcome_label", q("synthetic preimage expected values (not extractable from logs)")),
                ("outcome_preimage_hex", q(&hex(outcome))),
                ("receipt", receipt_json(r)),
                (
                    "chain_before",
                    obj(&[
                        ("entity", "5".into()),
                        ("seq_before", "12".into()),
                        ("head_before_hex", q(&hex(&label("legacy holding PS2 head before")))),
                    ]),
                ),
                ("body_hex", q(&hex(body))),
                ("body_len", format!("{}", body.len())),
                (
                    "target_record",
                    body_json(*kind, u32::from_le_bytes(body[2..6].try_into().unwrap()), &l.target.to_bytes(), r),
                ),
            ])
        })
        .collect();
    obj(&[
        ("evidence_kind", q("synthetic codec evidence")),
        ("note", q("Legacy-family source (a ring-128 village, as in the real-SBF fixture): prepare_source emits PS2 kind 145 (legacy_source_event::SourceReceipt) on the source Holding's existing PS2 chain instead of WIDE_CONQUEST_DEBITED/CREDITED. Built with SourceReceipt::prepare, decoded with Record::decode, checked with verify_previous and pair_target against the target record. World = the Season-derived legacy world of a synthetic AddrCtx (differs from the table section's fixed world).")),
        ("world_hex", q(&hex(l.resolver.adapter().world().as_bytes()))),
        ("source_host_ref_hex", q(&hex(&l.source.to_bytes()))),
        ("source_address_hex", q(&hex(&l.source_address))),
        ("source_address_base58", q(&base58(&l.source_address))),
        ("target_province_key_hex", q(&hex(&l.target.to_bytes()))),
        ("records", arr(&items)),
    ])
}
