//! Unsigned Depart preparation over literal PUBLIC account bytes and a fixed
//! blockhash observation: no key, signer, socket, RPC, chain or send.
#![cfg(feature = "expedition-dispatch-experimental")]

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};

use base64::Engine as _;
use fclient::blockhash_preflight::ObservedBlockhash;
use fclient::clock::SeasonClock;
use fclient::original_expedition_depart_draft::Draft;
use fclient::ports::ClockSysvar;
use fclient::unsigned_message_preflight::BlockhashObservation;
use frontier_abi::addr::{host_id, AddrCtx};
use frontier_abi::bytes::{wr_arr, wr_i16, wr_u16, wr_u32, wr_u64};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::{
    header,
    player::{citizen as C1, holding as H1, holding_ref as HR, transit as T},
    province::entry as E,
    world::season as S1,
};
use frontier_abi::v2::layout::{
    player::{citizen as C, holding as H},
    province::{province as P, site as SM},
    world::season as S,
};
use frontier_abi::world_index::{
    expedition::AccountResolver, expedition_dispatch_ix as wire, ProvinceKey, WideCoord, WideHostRef,
};
use keeper_core::experimental_expedition_depart_prepare as dp;
use keeper_core::experimental_expedition_prepare::Settings;
use keeper_core::widesnapshot::{
    parse_snapshot_response, sysvar_owner, Snapshot, SnapshotError, SnapshotSource,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

const ID: u64 = 11;
const GENESIS: i64 = 1_700_000_000;
const NOW: i64 = GENESIS + 6_000;
const CONTEXT: u64 = 100;
const MIN_SLOT: u64 = 80;

fn a(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn header_bytes(size: usize, magic: [u8; 8]) -> Vec<u8> {
    let mut data = vec![0; size];
    assert!(wr_arr(&mut data, header::MAGIC, &magic));
    assert!(wr_u64(&mut data, header::SEASON_ID, ID));
    assert!(wr_u16(&mut data, header::LAYOUT_VERSION, 2));
    data
}
fn hid() -> u64 {
    host_id(128, 0, 1, 2, 0).unwrap()
}
fn roster_entry() -> Entry {
    Entry {
        id: hid(),
        unit: 2,
        faction: 0,
        state: E::STATE_ROSTER,
        troops: 12_000,
        // full stamina (the kernel's cap), no cooldown: `Host::depart` passes
        stamina_value: permutation_rules::frontier::host::STAMINA_CAP,
        op: EntryOp::None,
        ..Entry::FREE
    }
}
fn province_at(p: i16) -> Vec<u8> {
    let mut d = header_bytes(P::SIZE, P::MAGIC);
    assert!(wr_i16(&mut d, P::P, p));
    assert!(wr_u32(&mut d, P::RESOLVED_NEXT, 10));
    d
}

/// The original host (128, 0) site 1 gen 2 seq 0, final, standing at home or
/// (`remote`) in the original Province (127, 0).
struct Fixture {
    program: Address,
    season: Address,
    host: WideHostRef,
    standing: ProvinceKey,
    standing_p: i16,
    wallet: Address,
    payer: Address,
    season_data: Vec<u8>,
    holding: Vec<u8>,
    home: Vec<u8>,
    remote: Option<Vec<u8>>,
    citizen: Vec<u8>,
    transit: Option<Vec<u8>>,
}
impl Fixture {
    fn new() -> Self {
        let program = a(4);
        let (season, bump) = fclient::addr::season_pda(&program, ID);
        let ctx = AddrCtx { program: program.to_bytes(), season: season.to_bytes() };
        let resolver = AccountResolver::for_season(&ctx).unwrap();
        let host = resolver.legacy_host_ref(hid()).unwrap();
        let wallet = a(7);
        let citizen_key = Address::new_from_array(ctx.citizen(&wallet.to_bytes()));
        let mut s = header_bytes(S::SIZE, S::MAGIC);
        s[S::STATUS] = S::STATUS_RUNNING;
        s[S::BUMP] = bump;
        assert!(wr_u16(&mut s, S::PROGRAM_VERSION, wire::PROGRAM_VERSION));
        assert!(wr_arr(&mut s, S::RULESET_HASH, &[9; 32]));
        assert!(wr_arr(&mut s, S::GENESIS_TS, &GENESIS.to_le_bytes()));
        assert!(wr_u32(&mut s, S::BELL_SECS, 600));
        assert!(wr_u32(&mut s, S::END_BELL, 1008));
        // one action per minute, ten in reserve (the player prologue's bucket)
        assert!(wr_u16(&mut s, S1::BUCKET_RATE_PER_H, 60));
        assert!(wr_u16(&mut s, S1::BUCKET_BURST, 10));
        let mut h = header_bytes(H::SIZE, H::MAGIC);
        assert!(wr_i16(&mut h, H::P, 128));
        h[H::SITE] = host.site();
        h[H::GEN] = host.gen();
        h[H::STATE] = H::STATE_FINAL;
        h[H::ORDER] = 1;
        assert!(wr_arr(&mut h, H::OWNER_CITIZEN, &citizen_key.to_bytes()));
        assert!(wr_u32(&mut h, H::HOST_SEQ, 1));
        let mut home = province_at(128);
        write_entry(&mut home, 0, &roster_entry()).unwrap();
        home[P::N_ENTRIES] = 1;
        let mut citizen = header_bytes(C::SIZE, C::MAGIC);
        assert!(wr_arr(&mut citizen, C::WALLET, &wallet.to_bytes()));
        assert!(wr_u32(&mut citizen, C1::BUCKET_MILLI, 5_000));
        let slot = C::holding_of_slot(1);
        assert!(wr_i16(&mut citizen, slot + HR::P, 128));
        citizen[slot + HR::SITE] = host.site();
        citizen[slot + HR::GEN] = host.gen();
        Self {
            program, season, host, standing: host.key(), standing_p: 128, wallet, payer: a(8),
            season_data: s, holding: h, home, remote: None, citizen, transit: None,
        }
    }
    /// The same host resident in the neighbouring original Province (127, 0).
    fn remote() -> Self {
        let mut f = Self::new();
        let resolver = AccountResolver::for_season(&f.ctx()).unwrap();
        f.standing = ProvinceKey::new(resolver.adapter().world(), WideCoord::checked(127, 0).unwrap());
        f.standing_p = 127;
        write_entry(&mut f.home, 0, &Entry::FREE).unwrap();
        f.home[P::N_ENTRIES] = 0;
        let mut pd = province_at(127);
        write_entry(&mut pd, 0, &roster_entry()).unwrap();
        pd[P::N_ENTRIES] = 1;
        f.remote = Some(pd);
        f
    }
    fn ctx(&self) -> AddrCtx {
        AddrCtx { program: self.program.to_bytes(), season: self.season.to_bytes() }
    }
    fn decoded(&self) -> fclient::decode::Season {
        fclient::decode::Season::decode(&self.season_data).unwrap()
    }
    fn bell(&self) -> u32 {
        SeasonClock::from_season(&self.decoded()).bell_at(NOW).unwrap()
    }
    /// The Season's own minimum tip (the program's `TipTooLow` floor).
    fn min_tip(&self) -> u64 {
        let s = self.decoded();
        fclient::fees::min_tip_lamports(s.min_reveal_priority_milli, s.reveal_cu_limit, s.reveal_loaded_limit)
    }
    fn draft_abs(&self, arrive: u32, tip: u64) -> Draft {
        Draft::for_wallet(&self.ctx(), self.host, self.standing, self.wallet, self.payer, 0, arrive, tip, [1; 32], [0xa7; 264]).unwrap()
    }
    /// `extra` lamports above the Season's minimum tip.
    fn draft(&self, arrive: u32, extra: u64) -> Draft {
        self.draft_abs(arrive, self.min_tip() + extra)
    }
    fn request_abs(&self, arrive: u32, tip: u64) -> Value {
        json!({"schema":dp::REQUEST_SCHEMA,"request_id":"depart-1","cluster":"localnet",
            "program":self.program.to_string(),"season":self.season.to_string(),
            "deployment":{"program_version":wire::PROGRAM_VERSION.to_string(),"ruleset_hash":"09".repeat(32)},
            "wallet":self.wallet.to_string(),"payer":self.payer.to_string(),"host":hex::encode(self.host.to_bytes()),
            "standing":{"p":self.standing_p.to_string(),"q":"0"},"transit_slot":"0","arrive_bell":arrive.to_string(),"tip":tip.to_string(),
            "public_commit":"01".repeat(32),"public_seal":"a7".repeat(264),"min_slot":MIN_SLOT.to_string(),
            "proposal":dp::canonical_proposal(&self.draft_abs(arrive, tip))})
    }
    fn request(&self, arrive: u32, extra: u64) -> Value {
        self.request_abs(arrive, self.min_tip() + extra)
    }
    /// One getMultipleAccounts-shaped response for the request's keys (+ Clock).
    fn response(&self, r: &dp::Request) -> Value {
        let roles = r.draft().roles();
        let mut values = Vec::new();
        for key in r.snapshot_keys() {
            let data = if key == roles[2].address {
                Some(self.season_data.clone())
            } else if key == roles[3].address {
                Some(self.citizen.clone())
            } else if key == roles[4].address {
                Some(self.holding.clone())
            } else if key == roles[5].address && self.remote.is_some() {
                self.remote.clone()
            } else if key == roles[5].address || key == roles[7].address {
                Some(self.home.clone())
            } else {
                self.transit.clone()
            };
            values.push(match data {
                Some(d) => json!({"lamports":10_000_000,"owner":self.program.to_string(),"executable":false,
                    "data":[base64::engine::general_purpose::STANDARD.encode(d),"base64"]}),
                None => Value::Null,
            });
        }
        let clock = ClockSysvar { slot: CONTEXT, unix_timestamp: NOW, ..ClockSysvar::default() };
        values.push(json!({"lamports":1,"owner":sysvar_owner().to_string(),"executable":false,
            "data":[base64::engine::general_purpose::STANDARD.encode(clock.encode()),"base64"]}));
        json!({"context":{"slot":CONTEXT},"value":values})
    }
    /// Lock the home Province's mirror of this site as a completed, unsettled capture
    /// (`frontier_abi::v2::prologue::capture_locked`: mirror state
    /// `STATE_HOLDING` and mirror gen = holding gen + 1).
    fn capture_home(&mut self) {
        let o = P::site(self.host.site() as usize);
        self.home[o + SM::GEN] = self.host.gen().wrapping_add(1);
        self.home[o + SM::STATE] = SM::STATE_HOLDING;
    }
}

/// Answers with a fixed response, parsed for whatever the caller asks
/// (`min_slot` overridable to fake a response made for another request).
struct Fixed {
    response: Value,
    min_slot: Option<u64>,
}
impl SnapshotSource for Fixed {
    fn snapshot_boxed<'a>(
        &'a self,
        keys: &'a [Address],
        with_rent: bool,
        min_slot: u64,
    ) -> Pin<Box<dyn Future<Output = Result<Snapshot, SnapshotError>> + Send + 'a>> {
        let r = parse_snapshot_response(&self.response, keys, with_rent, self.min_slot.unwrap_or(min_slot));
        Box::pin(async move { r })
    }
}

fn settings(f: &Fixture) -> Settings {
    Settings { program: f.program, season: f.season, fee_payer: f.payer, ruleset_hash: [9; 32], cu_limit: 200_000, loaded_limit: 1_000_000 }
}
fn observed(latest: u64) -> ObservedBlockhash {
    ObservedBlockhash {
        observation: BlockhashObservation { blockhash: [24; 32], context_slot: 101, valid: true, block_height: 200, last_valid_block_height: 210 },
        latest_context_slot: latest,
        height_min_context_slot: 101,
    }
}
fn parse(v: &Value) -> Result<dp::Request, &'static str> {
    dp::parse_request(&serde_json::to_vec(v).unwrap())
}
fn run_with(r: &dp::Request, source: &Fixed, s: Settings, latest: u64) -> Value {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(dp::prepare(r, s, source, move |_| async move { Ok(observed(latest)) }))
}
fn run_request(f: &Fixture, request: &Value) -> Value {
    let r = parse(request).expect("canonical request");
    let source = Fixed { response: f.response(&r), min_slot: None };
    run_with(&r, &source, settings(f), CONTEXT)
}
fn run(f: &Fixture, arrive: u32, extra: u64) -> Value {
    run_request(f, &f.request(arrive, extra))
}
fn blocker(v: &Value) -> &str {
    assert_eq!(v["status"], "blocked", "{v}");
    v["blocker"]["code"].as_str().unwrap()
}
fn closed(v: &Value) {
    assert_eq!(v["host_only"], true);
    for k in ["ready", "deployment_verified", "admitted", "signed", "enqueued", "relay_submission_available", "automatic_send", "seal_verified"] {
        assert_eq!(v[k], false, "{k}");
    }
}

#[test]
fn canonical_fresh_departure_prepares_an_unsigned_message_only() {
    for f in [Fixture::new(), Fixture::remote()] {
        let arrive = f.bell() + 5;
        let v = run(&f, arrive, 3);
        assert_eq!(v["status"], "prepared", "standing {}: {v}", f.standing_p);
        closed(&v);
        let d = f.draft(arrive, 3);
        let p = &v["prepared"];
        assert_eq!(p["action"], "Depart");
        assert_eq!(p["program_version"], wire::PROGRAM_VERSION.to_string());
        assert_eq!(p["roles"], dp::canonical_proposal(&d)["roles"]);
        assert_eq!(p["proposal_digest"], hex::encode(dp::content_digest(&d)));
        let expected = wire::encode(wire::Kind::Depart, &d.proposed_bytes()).unwrap();
        assert_eq!(p["instruction_hex"], hex::encode(&expected));
        assert!(p["instruction_hex"].as_str().unwrap().starts_with("daff0200"));
        let message = base64::engine::general_purpose::STANDARD.decode(p["message_b64"].as_str().unwrap()).unwrap();
        assert_eq!(p["message_digest"], hex::encode(Sha256::digest(&message)));
        assert!(message.windows(expected.len()).any(|w| w == expected.as_slice()));
        assert_eq!(p["signers"], json!([f.payer.to_string(), f.wallet.to_string()]));
        assert_eq!(v["source"]["context_slot"], CONTEXT.to_string());
        assert_eq!(v["source"]["transit_slot_free"], true);
        assert_eq!(v["source"]["authority_verified"], false);
        assert_eq!(v["blockhash"]["coherent"], false);
    }
    // the remote standing role is another account than the home role
    let f = Fixture::remote();
    let d = f.draft(f.bell() + 5, 3);
    assert_ne!(d.roles()[5].address, d.roles()[7].address);
}

/// A Solana compact-u16 ("shortvec") at `*at`.
fn shortvec(b: &[u8], at: &mut usize) -> usize {
    let mut n = 0usize;
    for shift in [0, 7, 14] {
        let x = b[*at];
        *at += 1;
        n |= ((x & 0x7f) as usize) << shift;
        if x & 0x80 == 0 {
            break;
        }
    }
    n
}
/// A legacy Message: header, keys, blockhash, instructions `(program index, account indices, data)`.
fn legacy(b: &[u8]) -> ([u8; 3], Vec<[u8; 32]>, [u8; 32], Vec<(usize, Vec<usize>, Vec<u8>)>) {
    let header = [b[0], b[1], b[2]];
    let mut at = 3;
    let n = shortvec(b, &mut at);
    let keys = (0..n).map(|i| b[at + 32 * i..at + 32 * (i + 1)].try_into().unwrap()).collect();
    at += 32 * n;
    let hash = b[at..at + 32].try_into().unwrap();
    at += 32;
    let m = shortvec(b, &mut at);
    let mut ixs = Vec::new();
    for _ in 0..m {
        let program = b[at] as usize;
        at += 1;
        let k = shortvec(b, &mut at);
        let accounts = b[at..at + k].iter().map(|x| *x as usize).collect();
        at += k;
        let d = shortvec(b, &mut at);
        ixs.push((program, accounts, b[at..at + d].to_vec()));
        at += d;
    }
    assert_eq!(at, b.len(), "no trailing bytes");
    (header, keys, hash, ixs)
}

#[test]
fn the_prepared_message_carries_exactly_the_canonical_instruction_and_privileges() {
    for f in [Fixture::new(), Fixture::remote()] {
        let arrive = f.bell() + 5;
        let v = run(&f, arrive, 3);
        assert_eq!(v["status"], "prepared", "{v}");
        let d = f.draft(arrive, 3);
        let message = base64::engine::general_purpose::STANDARD.decode(v["prepared"]["message_b64"].as_str().unwrap()).unwrap();
        let (header, keys, hash, ixs) = legacy(&message);
        // two distinct signers: the payer (fee payer, writable) then the wallet (read-only)
        assert_eq!(header, [2, 1, header[2]]);
        assert_eq!(keys[0], f.payer.to_bytes());
        assert_eq!(keys[1], f.wallet.to_bytes());
        assert_eq!(hash, [24; 32]);
        // three compute-budget instructions, then the game instruction
        assert_eq!(ixs.len(), 4);
        let (program, accounts, data) = &ixs[3];
        assert_eq!(keys[*program], f.program.to_bytes());
        assert_eq!(*data, wire::encode(wire::Kind::Depart, &d.proposed_bytes()).unwrap());
        let n = keys.len();
        let signer = |i: usize| i < header[0] as usize;
        let writable = |i: usize| if signer(i) { i < (header[0] - header[1]) as usize } else { i < n - header[2] as usize };
        assert_eq!(accounts.len(), 9);
        for (role, &i) in d.roles().iter().zip(accounts) {
            assert_eq!(keys[i], role.address.to_bytes(), "{}", role.name);
            assert_eq!(signer(i), role.signer, "{} signer", role.name);
            assert_eq!(writable(i), role.writable, "{} writable", role.name);
        }
        // nothing beyond the roles, the program and the compute-budget program
        let mut named: Vec<[u8; 32]> = d.roles().iter().map(|r| r.address.to_bytes()).collect();
        named.push(f.program.to_bytes());
        named.sort();
        named.dedup();
        assert_eq!(n, named.len() + 1);
        assert!(!signer(*program) && !writable(*program));
    }
}

#[test]
fn a_refused_snapshot_never_asks_for_a_blockhash() {
    for change in [
        (|f: &mut Fixture| f.holding.clear()) as fn(&mut Fixture),
        |f: &mut Fixture| f.capture_home(),
        |f: &mut Fixture| f.transit = Some(vec![1; 16]),
        |f: &mut Fixture| f.season_data[S::RULESET_HASH] ^= 1,
    ] {
        let mut f = Fixture::new();
        change(&mut f);
        let r = parse(&f.request(f.bell() + 5, 3)).unwrap();
        let source = Fixed { response: f.response(&r), min_slot: None };
        let calls = AtomicUsize::new(0);
        let v = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(dp::prepare(
            &r,
            settings(&f),
            &source,
            |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                async move { Ok(observed(CONTEXT)) }
            },
        ));
        assert_eq!(v["status"], "blocked", "{v}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{v}");
    }
    // and a fresh one asks exactly once
    let f = Fixture::new();
    let r = parse(&f.request(f.bell() + 5, 3)).unwrap();
    let source = Fixed { response: f.response(&r), min_slot: None };
    let calls = AtomicUsize::new(0);
    let v = tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(dp::prepare(&r, settings(&f), &source, |_| {
        calls.fetch_add(1, Ordering::SeqCst);
        async move { Ok(observed(CONTEXT)) }
    }));
    assert_eq!(v["status"], "prepared");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// The real prepared report of the fixed PUBLIC home fixture as one JSON
/// line on stdout, for the gateway's cross-check fixture. Run with
/// `--exact prepared_report_fixture_json -- --nocapture`. No file, key or network.
#[test]
fn prepared_report_fixture_json() {
    let f = Fixture::new();
    let v = run(&f, f.bell() + 5, 3);
    assert_eq!(v["status"], "prepared", "{v}");
    closed(&v);
    println!("{}", serde_json::to_string(&v).unwrap());
}

#[test]
fn a_tip_below_the_seasons_minimum_is_refused() {
    let f = Fixture::new();
    let min = f.min_tip();
    assert!(min > 0, "the fixture's Season has a positive minimum tip");
    let arrive = f.bell() + 5;
    assert_eq!(blocker(&run_request(&f, &f.request_abs(arrive, min - 1))), "TipTooLow");
    assert_eq!(run_request(&f, &f.request_abs(arrive, min))["status"], "prepared");
}

#[test]
fn stale_or_foreign_fresh_state_is_blocked() {
    let check = |name: &str, codes: &[&str], make: &dyn Fn() -> Fixture, change: &dyn Fn(&mut Fixture)| {
        let mut f = make();
        change(&mut f);
        let v = run(&f, f.bell() + 5, 3);
        closed(&v);
        assert!(codes.contains(&blocker(&v)), "{name}: {v}");
    };
    let home = &Fixture::new;
    let remote = &Fixture::remote;
    check("empty holding", &["SourceLayout"], home, &|f| f.holding.clear());
    check("empty citizen", &["SourceLayout"], home, &|f| f.citizen = vec![0; 8]);
    check("another owner", &["OwnerMismatch"], home, &|f| f.holding[H::OWNER_CITIZEN] ^= 1);
    check("another wallet", &["OwnerMismatch"], home, &|f| f.citizen[C::WALLET] ^= 1);
    check("generation", &["SourceGeneration"], home, &|f| f.holding[H::GEN] ^= 1);
    check("not issued", &["HostNotIssued"], home, &|f| assert!(wr_u32(&mut f.holding, H::HOST_SEQ, 0)));
    check("not final", &["SourceNotFinal"], home, &|f| f.holding[H::STATE] = H::STATE_PROVISIONAL);
    check("citizen binding", &["CitizenBinding"], home, &|f| {
        let s = C::holding_of_slot(1);
        f.citizen[s + HR::SITE] ^= 1;
    });
    check("ruleset", &["DeploymentMismatch"], home, &|f| f.season_data[S::RULESET_HASH] ^= 1);
    check("season id", &["SeasonAddress"], home, &|f| assert!(wr_u64(&mut f.season_data, header::SEASON_ID, ID + 1)));
    check("season bump", &["SeasonAddress"], home, &|f| f.season_data[S::BUMP] ^= 1);
    check("home captured", &["CaptureLocked"], home, &|f| f.capture_home());
    check("home captured, standing remote", &["CaptureLocked"], remote, &|f| f.capture_home());
    check("standing coordinates", &["StandingIdentity"], remote, &|f| {
        assert!(wr_i16(f.remote.as_mut().unwrap(), P::P, 126));
    });
    check("not resident", &["NotResident"], home, &|f| {
        let e = Entry { state: E::STATE_DEPARTED, ..roster_entry() };
        write_entry(&mut f.home, 0, &e).unwrap();
    });
    check("no entry", &["NotResident"], home, &|f| {
        write_entry(&mut f.home, 0, &Entry::FREE).unwrap();
        f.home[P::N_ENTRIES] = 0;
    });
    check("busy", &["HostBusy"], home, &|f| {
        let e = Entry { op: EntryOp::Leave, ..roster_entry() };
        write_entry(&mut f.home, 0, &e).unwrap();
    });
    check("no stamina", &["HostCannotDepart"], home, &|f| {
        let e = Entry { stamina_value: 0, stamina_bell: f.bell(), ..roster_entry() };
        write_entry(&mut f.home, 0, &e).unwrap();
    });
    check("faction", &["EntryInvalid"], home, &|f| {
        let e = Entry { faction: 9, ..roster_entry() };
        write_entry(&mut f.home, 0, &e).unwrap();
    });
    check("slot state", &["TransitSlotBusy", "TransitState", "HostInTransit"], home, &|f| f.holding[H::transit(0) + T::STATE] = 1);
    check("external present", &["TransitSlotBusy"], home, &|f| f.transit = Some(vec![1; 16]));
    check("empty bucket", &["Bucket"], home, &|f| {
        assert!(wr_u32(&mut f.citizen, C1::BUCKET_MILLI, 0));
        assert!(wr_u32(&mut f.citizen, C1::BUCKET_T, (NOW - GENESIS) as u32));
    });
    check("escrow overflow", &["EscrowOverflow"], home, &|f| assert!(wr_u64(&mut f.holding, H1::ESCROW, u64::MAX)));
    check("arrivals overflow", &["ArrivalsOverflow"], home, &|f| assert!(wr_u32(&mut f.citizen, C1::ARRIVALS, u32::MAX)));
}

#[test]
fn arrival_window_snapshot_scope_and_blockhash_are_bounded() {
    let f = Fixture::new();
    let bell = f.bell();
    for arrive in [bell, bell + 1, bell + 73] {
        assert_eq!(blocker(&run(&f, arrive, 3)), "ArrivalBell", "{arrive}");
    }
    assert_eq!(run(&f, bell + 2, 3)["status"], "prepared");
    assert_eq!(run(&f, bell + 72, 3)["status"], "prepared");
    let mut ending = Fixture::new();
    assert!(wr_u32(&mut ending.season_data, S::END_BELL, bell + 5));
    assert_eq!(blocker(&run(&ending, bell + 5, 3)), "ArrivalBell");
    assert_eq!(run(&ending, bell + 4, 3)["status"], "prepared");

    let r = parse(&f.request(bell + 5, 3)).unwrap();
    // a response sealed for another request's minimum slot
    let other = Fixed { response: f.response(&r), min_slot: Some(MIN_SLOT - 1) };
    assert_eq!(blocker(&run_with(&r, &other, settings(&f), CONTEXT)), "SnapshotMismatch");
    // a response older than the request's minimum slot cannot even be parsed
    let mut old = f.response(&r);
    old["context"]["slot"] = json!(MIN_SLOT - 1);
    let stale = Fixed { response: old, min_slot: None };
    assert_eq!(blocker(&run_with(&r, &stale, settings(&f), CONTEXT)), "SourceUnavailable");
    // configured ruleset differs from the request's
    let fresh = Fixed { response: f.response(&r), min_slot: None };
    let mut s = settings(&f);
    s.ruleset_hash = [8; 32];
    assert_eq!(blocker(&run_with(&r, &fresh, s, CONTEXT)), "ScopeMismatch");
    // a blockhash observed before the snapshot's own context
    assert_eq!(blocker(&run_with(&r, &fresh, settings(&f), CONTEXT - 1)), "BlockhashUnavailable");
}

#[test]
fn tampered_proposals_are_refused_before_any_read() {
    let f = Fixture::new();
    let arrive = f.bell() + 5;
    let mut v = f.request(arrive, 3);
    let mut bytes = v["proposal"]["bytes_hex"].as_str().unwrap().to_owned();
    bytes.replace_range(0..2, if &bytes[0..2] == "00" { "01" } else { "00" });
    v["proposal"]["bytes_hex"] = json!(bytes);
    assert_eq!(parse(&v).err(), Some("ProposalMismatch"));
    let mut v = f.request(arrive, 3);
    v["proposal"]["roles"][1]["writable"] = json!(false);
    assert_eq!(parse(&v).err(), Some("ProposalMismatch"));
    let mut v = f.request(arrive, 3);
    v["proposal"]["content_digest"] = json!("00".repeat(32));
    assert_eq!(parse(&v).err(), Some("ProposalMismatch"));
    // a seal whose first byte fails the program's flag syntax
    let mut v = f.request(arrive, 3);
    v["public_seal"] = json!(format!("27{}", "a7".repeat(263)));
    assert_eq!(parse(&v).err(), Some("SealSyntax"));
    // a proposal for another arrival bell
    let mut v = f.request(arrive, 3);
    v["arrive_bell"] = json!((arrive + 1).to_string());
    assert_eq!(parse(&v).err(), Some("ProposalMismatch"));
}

/// Browser-compatible PUBLIC fixture with the acting wallet also paying.
/// Emitted by the actual Rust preparer; no key, signature, RPC or network.
#[test]
fn prepared_report_wallet_payer_fixture_json() {
    let mut f = Fixture::new();
    f.payer = f.wallet;
    let v = run(&f, f.bell() + 5, 3);
    assert_eq!(v["status"], "prepared", "{v}");
    assert_eq!(v["request"]["wallet"], v["request"]["payer"]);
    assert_eq!(v["prepared"]["signers"].as_array().unwrap().len(), 1);
    closed(&v);
    println!("{}", serde_json::to_string(&v).unwrap());
}

/// permutation-frontier's runtime-contract departure fixture (its actual
/// original-host accounts and command, exported and checked current by
/// `departure_accounts_export_is_the_committed_fixture`) prepared by the real
/// preparer. The committed report must be exactly this output; the runtime
/// test feeds it through the strict Message decoder to the actual handler.
/// No key, signature, RPC or network.
#[test]
fn runtime_contract_departure_report_is_the_committed_fixture() {
    const INPUT: &str = include_str!("../../../../permutation-frontier/runtime-contract-tests/fixtures/expedition-depart-accounts.json");
    const REPORT: &str = include_str!("../../../../permutation-frontier/runtime-contract-tests/fixtures/expedition-depart-prepared-report.json");
    let x: Value = serde_json::from_str(INPUT).unwrap();
    assert_eq!(x["schema"], "frontier-runtime-contract-depart-accounts-v1");
    let s = |k: &str| x[k].as_str().unwrap().to_owned();
    let address = |k: &str| s(k).parse::<Address>().unwrap();
    let (program, season, wallet, payer) = (address("program"), address("season"), address("wallet"), address("payer"));
    let ctx = AddrCtx { program: program.to_bytes(), season: season.to_bytes() };
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let host = WideHostRef::from_bytes(&hex::decode(s("host")).unwrap()).unwrap();
    let (p, q): (i64, i64) = (x["standing"]["p"].as_str().unwrap().parse().unwrap(), x["standing"]["q"].as_str().unwrap().parse().unwrap());
    let standing = ProvinceKey::new(resolver.adapter().world(), WideCoord::checked(p, q).unwrap());
    let n = |k: &str| s(k).parse::<u64>().unwrap();
    let commit: [u8; 32] = hex::decode(s("public_commit")).unwrap().try_into().unwrap();
    let seal = hex::decode(s("public_seal")).unwrap().try_into().unwrap();
    let draft = Draft::for_wallet(&ctx, host, standing, wallet, payer, n("transit_slot") as u8, n("arrive_bell") as u32, n("tip"), commit, seal).unwrap();
    let request = json!({"schema":dp::REQUEST_SCHEMA,"request_id":"runtime-contract-depart","cluster":"localnet",
        "program":s("program"),"season":s("season"),
        "deployment":{"program_version":s("program_version"),"ruleset_hash":s("ruleset_hash")},
        "wallet":s("wallet"),"payer":s("payer"),"host":s("host"),
        "standing":x["standing"],"transit_slot":s("transit_slot"),"arrive_bell":s("arrive_bell"),"tip":s("tip"),
        "public_commit":s("public_commit"),"public_seal":s("public_seal"),"min_slot":MIN_SLOT.to_string(),
        "proposal":dp::canonical_proposal(&draft)});
    let r = parse(&request).expect("canonical request");
    // one getMultipleAccounts-shaped response of exactly the fixture's bytes
    let mut values: Vec<Value> = r
        .snapshot_keys()
        .iter()
        .map(|key| {
            let a = x["accounts"].as_array().unwrap().iter().find(|a| a["address"] == key.to_string()).expect("fixture account");
            json!({"lamports":a["lamports"].as_str().unwrap().parse::<u64>().unwrap(),"owner":a["owner"],"executable":false,
                "data":[base64::engine::general_purpose::STANDARD.encode(hex::decode(a["data"].as_str().unwrap()).unwrap()),"base64"]})
        })
        .collect();
    let clock = ClockSysvar { slot: CONTEXT, unix_timestamp: s("unix_timestamp").parse().unwrap(), ..ClockSysvar::default() };
    values.push(json!({"lamports":1,"owner":sysvar_owner().to_string(),"executable":false,
        "data":[base64::engine::general_purpose::STANDARD.encode(clock.encode()),"base64"]}));
    let source = Fixed { response: json!({"context":{"slot":CONTEXT},"value":values}), min_slot: None };
    let ruleset_hash: [u8; 32] = hex::decode(s("ruleset_hash")).unwrap().try_into().unwrap();
    let settings = Settings { program, season, fee_payer: payer, ruleset_hash, cu_limit: 200_000, loaded_limit: 1_000_000 };
    let v = run_with(&r, &source, settings, CONTEXT);
    assert_eq!(v["status"], "prepared", "{v}");
    closed(&v);
    let fresh = serde_json::to_string(&v).unwrap();
    if fresh != REPORT.trim_end() {
        println!("{fresh}");
        panic!("expedition-depart-prepared-report.json is stale: replace it with the line above");
    }
}
