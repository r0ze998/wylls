//! **Workstream 02-rights (candidate, test only):** the verifier against
//! the workshop-stock swap Grant's records (provisional kinds 200–205) and
//! its check VR.
//!
//! **No key is generated, derived or used, and nothing is signed.** The
//! injected transactions are unsigned wire bytes: the message from
//! `fclient::tx::message` behind placeholder signature bytes, distinct per
//! transaction (the verifier parses but never checks signatures). Every
//! account key is a raw 32-byte value taken from the recorded fixture.
//!
//! **Base.** The recorded `land-program.json` season, copied and changed in
//! two ways that are not program paths: (1) its configured ruleset is the
//! S1 one, so the S1 suites run (CQ1 walks the chains, V23–V25 and VR run);
//! (2) one holding (the facility) carries 100 arms in every state the
//! archive has of it, since no recorded M1 holding has any. The edited copy
//! has findings of its own (it is not an S1 season); every test compares
//! the findings **with** the injected Grant transactions to the findings of
//! the same base **without** them, and judges only the difference.
//!
//! **Not shown here:** a recorded S1 season with the program's own logs
//! (that needs the SBF build on a local chain, which signs); here the
//! record bodies and post-states are built by this test with the shared
//! ABI and the verifier's own holding codec, and the program's side of the
//! same encoding is checked by the program's host tests.

mod common;

use std::collections::BTreeMap;

use common::*;
use fclient::{AccountMeta, Address, Instruction};
use frontier_abi::layout::header as HD;
use frontier_abi::layout::player::citizen as C;
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::log::{self as l2, CqKind, EntityKind as E2};
use frontier_abi::v2::rights::{self as rt, layout as G, record as rec};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use verify_core::codes::*;
use verify_core::holding as hr;
use verify_core::input::Input;
use verify_core::Verdict;

type Key = [u8; 32];

fn le(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a[..b.len()].copy_from_slice(b);
    u64::from_le_bytes(a)
}

fn data_of(inp: &Input, k: &Key) -> Vec<u8> {
    inp.finals[k].as_ref().expect("an account").data.clone()
}

/// The base: land, on the S1 path, the facility with 100 arms.
struct Base {
    inp: Input,
    ctx: frontier_abi::addr::AddrCtx,
    facility: Key,
    station: Key,
    province: Key,
    issuer_c: Key,
    grantee_c: Key,
    issuer_w: Key,
    grantee_w: Key,
    genesis: i64,
}

const ARMS_SLOT: usize = arms::ARMS as usize;

fn base() -> Base {
    let mut inp = land();
    inp.cfg.ruleset_hash = frontier_abi::v2::presets::RULESET_HASH_V3;
    let ctx = findex::addr_ctx(&inp.cfg.program, inp.cfg.season_id);
    let (facility, station) = (ctx.holding(1, 2, 0), ctx.holding(1, 2, 1));
    let owner = |inp: &Input, k: &Key| -> Key {
        data_of(inp, k)[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32]
            .try_into()
            .unwrap()
    };
    let (issuer_c, grantee_c) = (owner(&inp, &facility), owner(&inp, &station));
    assert_ne!(issuer_c, grantee_c, "two owners");
    let wallet = |inp: &Input, k: &Key| -> Key {
        data_of(inp, k)[C::WALLET..C::WALLET + 32]
            .try_into()
            .unwrap()
    };
    let (issuer_w, grantee_w) = (wallet(&inp, &issuer_c), wallet(&inp, &grantee_c));
    // 100 arms in every state of the facility (its Horses store, rate 0).
    let add = |d: &mut Vec<u8>| {
        let o = H::store(ARMS_SLOT) + frontier_abi::layout::player::accrual::VALUE;
        let v = le(&d[o..o + 8]) as i64 + 100 * MILLI;
        d[o..o + 8].copy_from_slice(&v.to_le_bytes());
    };
    for t in inp.txs.iter_mut() {
        for (k, a) in t.post.iter_mut() {
            if k.to_bytes() == facility {
                if let Some(a) = a {
                    add(&mut a.data);
                }
            }
        }
    }
    if let Some(Some(a)) = inp.finals.get_mut(&facility) {
        add(&mut a.data);
    }
    let w = verify_core::world::World::parse(
        &inp.cfg.program,
        &inp.txs,
        inp.finals.clone(),
        inp.final_slot,
    );
    let genesis = verify_core::facts::Facts::build(&w, &inp.cfg).genesis_ts;
    Base {
        province: ctx.province(1, 2),
        inp,
        ctx,
        facility,
        station,
        issuer_c,
        grantee_c,
        issuer_w,
        grantee_w,
        genesis,
    }
}

/// One injected transaction under construction.
struct Flow {
    inp: Input,
    /// Accounts as the injected transactions leave them.
    state: BTreeMap<Key, Option<fclient::ports::Account>>,
    n: u8,
}

impl Flow {
    fn new(b: &Base) -> Flow {
        Flow {
            inp: b.inp.clone(),
            state: b.inp.finals.clone(),
            n: 0,
        }
    }

    fn data(&self, k: &Key) -> Vec<u8> {
        self.state[k]
            .as_ref()
            .map(|a| a.data.clone())
            .unwrap_or_default()
    }

    fn time(&self) -> i64 {
        self.inp.txs.last().unwrap().block_time + 60
    }

    /// A record body chaining `links` (entity, account) in that order,
    /// advancing each account's header in `state`.
    fn record(
        &mut self,
        kind: CqKind,
        bell: u32,
        key: &[u8],
        payload: &[u8],
        links: &[(E2, Key)],
    ) -> Vec<u8> {
        let mut bwt = vec![frontier_abi::log::VERSION, kind as u8];
        bwt.extend_from_slice(&bell.to_le_bytes());
        bwt.extend_from_slice(key);
        bwt.extend_from_slice(payload);
        let mut body = bwt.clone();
        body.push(links.len() as u8);
        for (e, k) in links {
            let d = self.data(k);
            let seq = le(&d[HD::EVENT_SEQ..HD::EVENT_SEQ + 8]);
            let head: [u8; 32] = d[HD::EVENT_HEAD..HD::EVENT_HEAD + 32].try_into().unwrap();
            let l = l2::advance(*e, seq, &head, &bwt).expect("advance");
            let a = self.state.get_mut(k).unwrap().as_mut().unwrap();
            a.data[HD::EVENT_SEQ..HD::EVENT_SEQ + 8].copy_from_slice(&l.seq.to_le_bytes());
            a.data[HD::EVENT_HEAD..HD::EVENT_HEAD + 32].copy_from_slice(&l.head);
            body.push(l.entity as u8);
            body.extend_from_slice(&l.seq.to_le_bytes());
            body.extend_from_slice(&l.head);
        }
        body
    }

    /// Appends an unsigned transaction: `ix`, its records, and the
    /// post-states of `written` as `state` holds them.
    fn push(
        &mut self,
        payer: Key,
        ix: Instruction,
        bodies: Vec<Vec<u8>>,
        written: &[Key],
        time: i64,
    ) {
        self.n += 1;
        let budget = fclient::tx::TxBudget {
            cu_limit: 200_000,
            cu_price: 0,
            loaded_limit: 1 << 20,
            heap: None,
        };
        let msg = fclient::tx::message(
            &[ix],
            &budget,
            &Address::new_from_array(payer),
            &fclient::Hash::new_from_array([self.n; 32]),
        );
        let nsig = msg.header.num_required_signatures as usize;
        // Placeholder signature bytes (not a signature): the wire format's
        // count, then 64 bytes per required signer, then the message.
        let mut wire = vec![nsig as u8];
        for i in 0..nsig {
            wire.extend_from_slice(&[0xA0u8.wrapping_add(self.n).wrapping_add(i as u8 * 16); 64]);
        }
        wire.extend_from_slice(&msg.serialize());
        let tx = fclient::tx::from_wire(&wire).expect("the unsigned wire decodes");
        let last = self.inp.txs.last().unwrap().clone();
        let program = self.inp.cfg.program;
        let lines: Vec<String> = bodies.iter().map(|b| fclient::log::log_line(b)).collect();
        self.inp.txs.push(fclient::ports::TxRecord {
            seq: last.seq + 1,
            slot: last.slot + 1,
            signature: fclient::tx::signature(&tx),
            block_time: time,
            tx: wire,
            logs: fclient::log::in_frame(&program, lines),
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: written
                .iter()
                .map(|k| {
                    (
                        Address::new_from_array(*k),
                        self.state.get(k).cloned().flatten(),
                    )
                })
                .collect(),
        });
        for k in written {
            self.inp
                .finals
                .insert(*k, self.state.get(k).cloned().flatten());
        }
    }
}

fn meta(k: Key, s: bool, w: bool) -> AccountMeta {
    let a = Address::new_from_array(k);
    if w {
        AccountMeta::new(a, s)
    } else {
        AccountMeta::new_readonly(a, s)
    }
}

/// Grant bytes as the program writes them.
#[allow(clippy::too_many_arguments)]
fn grant_bytes(
    b: &Base,
    sid: u64,
    nonce: u32,
    expires: i64,
    issued: i64,
    fgen: u8,
    sgen: u8,
    payer: &Key,
) -> Vec<u8> {
    let mut d = vec![0u8; G::SIZE];
    d[..8].copy_from_slice(&G::MAGIC);
    d[G::SEASON_ID..G::SEASON_ID + 8].copy_from_slice(&sid.to_le_bytes());
    d[G::VERSION..G::VERSION + 2].copy_from_slice(&G::VERSION_1.to_le_bytes());
    d[G::KIND] = rt::KIND_STOCK_SWAP;
    d[G::STATE] = rt::STATE_ACTIVE;
    d[G::FACILITY_GEN] = fgen;
    d[G::STATION_GEN] = sgen;
    d[G::FACILITY_SITE] = 0;
    d[G::STATION_SITE] = 1;
    d[G::P..G::P + 2].copy_from_slice(&1i16.to_le_bytes());
    d[G::Q..G::Q + 2].copy_from_slice(&2i16.to_le_bytes());
    d[G::NONCE..G::NONCE + 4].copy_from_slice(&nonce.to_le_bytes());
    d[G::ISSUER_CITIZEN..G::ISSUER_CITIZEN + 32].copy_from_slice(&b.issuer_c);
    d[G::GRANTEE_CITIZEN..G::GRANTEE_CITIZEN + 32].copy_from_slice(&b.grantee_c);
    d[G::FACILITY..G::FACILITY + 32].copy_from_slice(&b.facility);
    d[G::STATION..G::STATION + 32].copy_from_slice(&b.station);
    d[G::ISSUER_TAG..G::ISSUER_TAG + 8].copy_from_slice(&rec::tag8(&b.issuer_c).to_le_bytes());
    d[G::EXPIRES_TS..G::EXPIRES_TS + 8].copy_from_slice(&expires.to_le_bytes());
    d[G::ISSUED_TS..G::ISSUED_TS + 8].copy_from_slice(&issued.to_le_bytes());
    d[G::MAX_SWAPS..G::MAX_SWAPS + 2].copy_from_slice(&3u16.to_le_bytes());
    d[G::MAX_UNITS..G::MAX_UNITS + 4].copy_from_slice(&30u32.to_le_bytes());
    d[G::RENT_TO..G::RENT_TO + 32].copy_from_slice(payer);
    d
}

fn set_u(d: &mut [u8], o: usize, n: usize, v: u64) {
    d[o..o + n].copy_from_slice(&v.to_le_bytes()[..n]);
}

/// The honest flow, as the program would leave it: issue, reserve 10,
/// execute, reserve 4, release, revoke, close. Returns the flow and the
/// Grant's address.
fn honest(b: &Base) -> (Flow, Key) {
    let mut fl = Flow::new(b);
    let sid = b.inp.cfg.season_id;
    let program = b.inp.cfg.program;
    let issuer_tag = rec::tag8(&b.issuer_c);
    let grantee_tag = rec::tag8(&b.grantee_c);
    let grant = rt::grant(&b.ctx, issuer_tag, 0);
    let key = rec::key(issuer_tag, 0);
    let t0 = fl.time();
    let bell = |t: i64| permutation_rules::frontier::beacon::bell_at(b.genesis, t).unwrap_or(0);
    let expires = t0 + 86_400;
    let (fgen, sgen) = (
        data_of(&b.inp, &b.facility)[H::GEN],
        data_of(&b.inp, &b.station)[H::GEN],
    );
    let season = b.ctx.season;
    let system = [0u8; 32];
    let ix = |data: Vec<u8>, accts: Vec<AccountMeta>| Instruction {
        program_id: program,
        accounts: accts,
        data,
    };
    // 1. IssueGrant.
    let issue = rt::IssueGrant {
        nonce: 0,
        kind: rt::KIND_STOCK_SWAP,
        max_swaps: 3,
        max_units: 30,
        expires_ts: expires,
    };
    let rent = frontier_abi::layout::rent(G::SIZE);
    fl.state.insert(
        grant,
        Some(fclient::ports::Account {
            lamports: rent,
            data: grant_bytes(b, sid, 0, expires, t0, fgen, sgen, &b.issuer_w),
            owner: program,
            executable: false,
        }),
    );
    let payload = rec::Issued {
        grantee_tag,
        p: 1,
        q: 2,
        facility_site: 0,
        facility_gen: fgen,
        station_site: 1,
        station_gen: sgen,
        max_swaps: 3,
        max_units: 30,
        expires_ts: expires,
        rent,
    }
    .to_bytes();
    let body = fl.record(
        rec::ISSUED,
        bell(t0),
        &key,
        &payload,
        &[(E2::Citizen, b.issuer_c)],
    );
    fl.push(
        b.issuer_w,
        ix(
            issue.to_bytes().to_vec(),
            vec![
                meta(b.issuer_w, true, false),
                meta(b.issuer_w, true, true),
                meta(season, false, false),
                meta(b.issuer_c, false, true),
                meta(b.facility, false, false),
                meta(b.province, false, false),
                meta(b.grantee_c, false, false),
                meta(b.station, false, false),
                meta(grant, false, true),
                meta(system, false, false),
            ],
        ),
        vec![body],
        &[b.issuer_c, grant],
        t0,
    );
    // The swap instructions' accounts.
    let swap_accts = |by: Key, c: Key| {
        vec![
            meta(by, true, false),
            meta(by, true, true),
            meta(season, false, false),
            meta(c, false, true),
            meta(grant, false, true),
            meta(b.facility, false, true),
            meta(b.station, false, true),
            meta(b.province, false, false),
        ]
    };
    let ore = Resource::Ore as usize;
    let wood = Resource::Wood as usize;
    // Settle-without-touch, then pay or credit, as the program does.
    let mv = |fl: &mut Flow, k: Key, t: i64, pay: bool, c: [i64; RESOURCES]| {
        let d = fl.data(&k);
        let mut h = hr::read_settled(&d, t).unwrap();
        if pay {
            h.pay(t, &c).unwrap();
        } else {
            for (r, v) in c.iter().enumerate() {
                if *v > 0 {
                    h.credit(t, Resource::ALL[r], *v).unwrap();
                }
            }
        }
        let mut nd = d.clone();
        hr::write(&mut nd, &h, t).unwrap();
        fl.state.get_mut(&k).unwrap().as_mut().unwrap().data = nd;
    };
    let side = |o: i64, w: i64, a: i64| {
        let mut c = [0i64; RESOURCES];
        c[ore] = o;
        c[wood] = w;
        c[ARMS_SLOT] = a;
        c
    };
    let swap = |seq: u16, units: u32| rec::Swap {
        grantee_tag,
        p: 1,
        q: 2,
        facility_site: 0,
        station_site: 1,
        seq,
        units,
        ore: units as i64 * 2 * MILLI,
        wood: units as i64 * MILLI,
        arms: units as i64 * MILLI,
    };
    let grant_set = |fl: &mut Flow, f: &dyn Fn(&mut [u8])| {
        f(&mut fl.state.get_mut(&grant).unwrap().as_mut().unwrap().data);
    };
    // 2. ReserveSwap(10, seq 0).
    let t = t0 + 60;
    let s = swap(0, 10);
    mv(&mut fl, b.station, t, true, side(s.ore, s.wood, 0));
    mv(&mut fl, b.facility, t, true, side(0, 0, s.arms));
    grant_set(&mut fl, &|d| {
        set_u(d, G::OPEN_UNITS, 4, 10);
        set_u(d, G::OPEN_TS, 8, t as u64);
        set_u(d, G::OPEN_ORE, 8, s.ore as u64);
        set_u(d, G::OPEN_WOOD, 8, s.wood as u64);
        set_u(d, G::OPEN_ARMS, 8, s.arms as u64);
    });
    let body = fl.record(
        rec::RESERVED,
        bell(t),
        &key,
        &s.to_bytes(),
        &[
            (E2::Citizen, b.grantee_c),
            (E2::Holding, b.station),
            (E2::Holding, b.facility),
        ],
    );
    fl.push(
        b.grantee_w,
        ix(
            rt::ReserveSwap { units: 10, seq: 0 }.to_bytes().to_vec(),
            swap_accts(b.grantee_w, b.grantee_c),
        ),
        vec![body],
        &[b.grantee_c, grant, b.facility, b.station],
        t,
    );
    // 3. ExecuteSwap(seq 0).
    let t = t + 60;
    mv(&mut fl, b.station, t, false, side(0, 0, s.arms));
    mv(&mut fl, b.facility, t, false, side(s.ore, s.wood, 0));
    grant_set(&mut fl, &|d| {
        set_u(d, G::SWAPS, 2, 1);
        set_u(d, G::UNITS_SWAPPED, 4, 10);
        for (o, n) in [
            (G::OPEN_UNITS, 4),
            (G::OPEN_TS, 8),
            (G::OPEN_ORE, 8),
            (G::OPEN_WOOD, 8),
            (G::OPEN_ARMS, 8),
        ] {
            set_u(d, o, n, 0);
        }
    });
    let body = fl.record(
        rec::EXECUTED,
        bell(t),
        &key,
        &s.to_bytes(),
        &[
            (E2::Citizen, b.grantee_c),
            (E2::Holding, b.station),
            (E2::Holding, b.facility),
        ],
    );
    fl.push(
        b.grantee_w,
        ix(
            rt::ExecuteSwap { seq: 0 }.to_bytes().to_vec(),
            swap_accts(b.grantee_w, b.grantee_c),
        ),
        vec![body],
        &[b.grantee_c, grant, b.facility, b.station],
        t,
    );
    // 4. ReserveSwap(4, seq 1).
    let t = t + 60;
    let s4 = swap(1, 4);
    mv(&mut fl, b.station, t, true, side(s4.ore, s4.wood, 0));
    mv(&mut fl, b.facility, t, true, side(0, 0, s4.arms));
    grant_set(&mut fl, &|d| {
        set_u(d, G::OPEN_UNITS, 4, 4);
        set_u(d, G::OPEN_TS, 8, t as u64);
        set_u(d, G::OPEN_ORE, 8, s4.ore as u64);
        set_u(d, G::OPEN_WOOD, 8, s4.wood as u64);
        set_u(d, G::OPEN_ARMS, 8, s4.arms as u64);
    });
    let body = fl.record(
        rec::RESERVED,
        bell(t),
        &key,
        &s4.to_bytes(),
        &[
            (E2::Citizen, b.grantee_c),
            (E2::Holding, b.station),
            (E2::Holding, b.facility),
        ],
    );
    fl.push(
        b.grantee_w,
        ix(
            rt::ReserveSwap { units: 4, seq: 1 }.to_bytes().to_vec(),
            swap_accts(b.grantee_w, b.grantee_c),
        ),
        vec![body],
        &[b.grantee_c, grant, b.facility, b.station],
        t,
    );
    // 5. ReleaseSwap by the grantee.
    let t = t + 60;
    mv(&mut fl, b.station, t, false, side(s4.ore, s4.wood, 0));
    mv(&mut fl, b.facility, t, false, side(0, 0, s4.arms));
    grant_set(&mut fl, &|d| {
        for (o, n) in [
            (G::OPEN_UNITS, 4),
            (G::OPEN_TS, 8),
            (G::OPEN_ORE, 8),
            (G::OPEN_WOOD, 8),
            (G::OPEN_ARMS, 8),
        ] {
            set_u(d, o, n, 0);
        }
    });
    let undo = rec::Undo {
        by: rec::by::GRANTEE,
        p: 1,
        q: 2,
        facility_site: 0,
        station_site: 1,
        returned: [s4.ore, s4.wood, s4.arms],
        kept: [0; 3],
    };
    let body = fl.record(
        rec::RELEASED,
        bell(t),
        &key,
        &undo.to_bytes(),
        &[(E2::Holding, b.station), (E2::Holding, b.facility)],
    );
    fl.push(
        b.grantee_w,
        ix(
            rt::ReleaseSwap {}.to_bytes().to_vec(),
            vec![
                meta(b.grantee_w, true, true),
                meta(season, false, false),
                meta(b.grantee_c, false, false),
                meta(grant, false, true),
                meta(b.facility, false, true),
                meta(b.station, false, true),
                meta(b.province, false, false),
            ],
        ),
        vec![body],
        &[grant, b.facility, b.station],
        t,
    );
    // 6. RevokeGrant (nothing escrowed): the issuer's Citizen only.
    let t = t + 60;
    grant_set(&mut fl, &|d| {
        d[G::STATE] = rt::STATE_REVOKED;
        set_u(d, G::REVOKED_TS, 8, t as u64);
    });
    let undo = rec::Undo {
        by: rec::by::ISSUER,
        p: 1,
        q: 2,
        facility_site: 0,
        station_site: 1,
        returned: [0; 3],
        kept: [0; 3],
    };
    let body = fl.record(
        rec::REVOKED,
        bell(t),
        &key,
        &undo.to_bytes(),
        &[(E2::Citizen, b.issuer_c)],
    );
    fl.push(
        b.issuer_w,
        ix(
            rt::RevokeGrant {}.to_bytes().to_vec(),
            swap_accts(b.issuer_w, b.issuer_c),
        ),
        vec![body],
        // A recording lists every writable account: the holdings too,
        // unchanged (nothing was escrowed).
        &[b.issuer_c, grant, b.facility, b.station],
        t,
    );
    // 7. CloseGrant: the rent to the issuer's wallet (RENT_TO), the Grant gone.
    let t = t + 60;
    let closed = rec::Closed {
        rent,
        rent_to8: rec::tag8(&b.issuer_w),
    };
    let body = fl.record(rec::CLOSED, bell(t), &key, &closed.to_bytes(), &[]);
    fl.state.insert(grant, None);
    fl.push(
        b.issuer_w,
        ix(
            rt::CloseGrant {}.to_bytes().to_vec(),
            vec![
                meta(b.issuer_w, true, true),
                meta(season, false, false),
                meta(grant, false, true),
                meta(b.issuer_w, false, true),
            ],
        ),
        vec![body],
        &[grant],
        t,
    );
    (fl, grant)
}

/// Findings of `with` that `without` does not have (a multiset difference
/// on check, code, entity and detail).
fn new_findings(without: &Input, with: &Input) -> Vec<(String, verify_core::Severity)> {
    let line =
        |f: &verify_core::Finding| format!("{} {} {} | {}", f.check, f.code, f.entity, f.detail);
    let mut base: BTreeMap<String, usize> = BTreeMap::new();
    for f in verify_core::verify(without).findings {
        *base.entry(line(&f)).or_default() += 1;
    }
    let mut out = vec![];
    for f in verify_core::verify(with).findings {
        let l = line(&f);
        match base.get_mut(&l) {
            Some(n) if *n > 0 => *n -= 1,
            _ => out.push((l, f.severity)),
        }
    }
    out
}

fn has(found: &[(String, verify_core::Severity)], code: &str) -> bool {
    found
        .iter()
        .any(|(l, s)| l.contains(code) && *s == verify_core::Severity::Fail)
}

#[test]
fn the_honest_flow_adds_no_finding() {
    let b = base();
    let (fl, _) = honest(&b);
    let found = new_findings(&b.inp, &fl.inp);
    // The base is an M1 season judged as S1, so CQ2 reports its Season's
    // identity once per transaction: the base has that finding already,
    // and each injected transaction repeats it. Nothing else may appear.
    let artefact = "CQ2 SeasonIdentity Season";
    assert!(
        verify_core::verify(&b.inp)
            .findings
            .iter()
            .any(|f| f.check == "CQ2" && f.code == "SeasonIdentity"),
        "the base carries the artefact itself"
    );
    let injected = fl.inp.txs.len() - b.inp.txs.len();
    let (art, other): (Vec<_>, Vec<_>) = found.iter().partition(|(l, _)| l.starts_with(artefact));
    assert_eq!(art.len(), injected, "one artefact per injected transaction");
    assert!(
        other.is_empty(),
        "an honest Grant flow added findings: {other:#?}"
    );
    // VR ran on it.
    assert!(verify_core::verify(&fl.inp)
        .checks_run
        .contains(&"VR:rights"));
}

/// Each change below is one way a dishonest or broken archive differs from
/// the honest flow; each must add a FAIL (or, for missing evidence, an
/// UNVERIFIABLE) — never leave the verdict as the base's.
#[test]
fn a_missing_record_fails() {
    let b = base();
    let (mut fl, _) = honest(&b);
    // The reserve (second injected transaction) logs nothing.
    let n = fl.inp.txs.len();
    let t = n - 6;
    let program = fl.inp.cfg.program;
    fl.inp.txs[t].logs = fclient::log::in_frame(&program, Vec::<String>::new());
    let found = new_findings(&b.inp, &fl.inp);
    assert!(has(&found, RIGHTS_RECORD_MISSING), "{found:#?}");
    // Its holding writes are then unexplained to V7 as well.
    assert!(has(&found, HOLDING_REPLAY_MISMATCH), "{found:#?}");
}

#[test]
fn an_amount_the_holdings_did_not_move_fails() {
    let b = base();
    let (mut fl, _) = honest(&b);
    // The execute's station gains one more arm than its record says.
    let t = fl.inp.txs.len() - 5;
    let station = Address::new_from_array(b.station);
    for (k, a) in fl.inp.txs[t].post.iter_mut() {
        if *k == station {
            let d = &mut a.as_mut().unwrap().data;
            let o = H::store(ARMS_SLOT) + frontier_abi::layout::player::accrual::VALUE;
            let v = le(&d[o..o + 8]) as i64 + MILLI;
            d[o..o + 8].copy_from_slice(&v.to_le_bytes());
        }
    }
    let found = new_findings(&b.inp, &fl.inp);
    assert!(has(&found, HOLDING_REPLAY_MISMATCH), "{found:#?}");
}

#[test]
fn a_grant_account_unlike_its_records_fails() {
    let b = base();
    let (mut fl, grant) = honest(&b);
    // After the first reserve the Grant claims 11 units open, not 10.
    let t = fl.inp.txs.len() - 6;
    let g = Address::new_from_array(grant);
    for (k, a) in fl.inp.txs[t].post.iter_mut() {
        if *k == g {
            set_u(&mut a.as_mut().unwrap().data, G::OPEN_UNITS, 4, 11);
        }
    }
    let found = new_findings(&b.inp, &fl.inp);
    assert!(has(&found, RIGHTS_STATE_MISMATCH), "{found:#?}");
}

#[test]
fn a_record_the_rules_refuse_fails() {
    let b = base();
    let b2 = base();
    // Rebuild the flow with the first reserve's seq at 1 (no swap yet).
    let (fl, _) = honest(&b);
    let mut inp = fl.inp.clone();
    let t = inp.txs.len() - 6;
    let mut bodies = verify_core::tamper::bodies(&inp, t);
    let o = 6 + 12 + 18; // head, key, then the payload's `seq`
    bodies[0][o] = 1;
    verify_core::tamper::set_bodies(&mut inp, t, &bodies);
    let found = new_findings(&b2.inp, &inp);
    assert!(has(&found, RIGHTS_RULE), "{found:#?}");
}

#[test]
fn an_issue_without_its_record_is_not_invisible() {
    let b = base();
    let (fl, _) = honest(&b);
    // Only the IssueGrant transaction, with no record, and the Grant it
    // left in the final state: the blind spot of round 2.
    let mut inp = b.inp.clone();
    let n0 = inp.txs.len();
    let mut tx = fl.inp.txs[n0].clone();
    tx.logs = fclient::log::in_frame(&inp.cfg.program, Vec::<String>::new());
    // The Citizen's chain does not move without the record.
    let ic = Address::new_from_array(b.issuer_c);
    tx.post.retain(|(k, _)| *k != ic);
    let g = tx.post.iter().find(|(k, _)| *k != ic).cloned().unwrap();
    inp.txs.push(tx);
    inp.finals.insert(g.0.to_bytes(), g.1.clone());
    let found = new_findings(&b.inp, &inp);
    assert!(has(&found, RIGHTS_RECORD_MISSING), "{found:#?}");
    assert!(has(&found, RIGHTS_UNEXPLAINED_ACCOUNT), "{found:#?}");
    assert_eq!(verify_core::verify(&inp).verdict, Verdict::Fail);
}

#[test]
fn an_unknown_instruction_or_account_fails() {
    let b = base();
    let (mut fl, _) = honest(&b);
    // A successful instruction with tag 0xD9 (inside the rights block, not
    // a Grant instruction) that writes a program account of no known kind.
    let odd: Key = [0x5A; 32];
    fl.state.insert(
        odd,
        Some(fclient::ports::Account {
            lamports: 1,
            data: b"XXXXXXXX-unknown".to_vec(),
            owner: fl.inp.cfg.program,
            executable: false,
        }),
    );
    let t = fl.time();
    let ix = Instruction {
        program_id: fl.inp.cfg.program,
        accounts: vec![meta(b.grantee_w, true, true), meta(odd, false, true)],
        data: vec![0xD9],
    };
    fl.push(b.grantee_w, ix, vec![], &[odd], t);
    let found = new_findings(&b.inp, &fl.inp);
    assert!(has(&found, UNKNOWN_INSTRUCTION), "{found:#?}");
    assert!(has(&found, UNKNOWN_ACCOUNT), "{found:#?}");
}

#[test]
fn an_orphan_record_fails() {
    let b = base();
    let (mut fl, _) = honest(&b);
    // The close's record copied into a transaction with no Grant
    // instruction (an unknown-tag-free one: tag 0x40, Harvest-shaped).
    let t_close = fl.inp.txs.len() - 1;
    let bodies = verify_core::tamper::bodies(&fl.inp, t_close);
    let t = fl.time();
    let ix = Instruction {
        program_id: fl.inp.cfg.program,
        accounts: vec![meta(b.grantee_w, true, true)],
        data: vec![frontier_abi::tags::Ix::Harvest.tag()],
    };
    fl.push(b.grantee_w, ix, bodies, &[], t);
    let found = new_findings(&b.inp, &fl.inp);
    assert!(has(&found, RIGHTS_RECORD_ORPHAN), "{found:#?}");
}

#[test]
fn missing_evidence_is_never_a_pass() {
    let b = base();
    let (mut fl, grant) = honest(&b);
    // The first reserve's post-state of the Grant is not in the archive.
    let t = fl.inp.txs.len() - 6;
    let g = Address::new_from_array(grant);
    fl.inp.txs[t].post.retain(|(k, _)| *k != g);
    let found = new_findings(&b.inp, &fl.inp);
    assert!(
        found
            .iter()
            .any(|(l, s)| l.contains(MISSING_DATA) && *s == verify_core::Severity::Unverifiable),
        "{found:#?}"
    );
    assert_ne!(verify_core::verify(&fl.inp).verdict, Verdict::Pass);
}

/// The control of round 2, kept: a swap-shaped holding write with no
/// record at all still fails V7, now beside VR's own finding.
#[test]
fn an_unrecorded_swap_still_fails_holding_continuity() {
    let b = base();
    let (fl, _) = honest(&b);
    let mut inp = fl.inp.clone();
    let program = inp.cfg.program;
    let n = inp.txs.len();
    // Strip the execute's record (third injected transaction).
    inp.txs[n - 5].logs = fclient::log::in_frame(&program, Vec::<String>::new());
    let found = new_findings(&b.inp, &inp);
    assert!(has(&found, HOLDING_REPLAY_MISMATCH), "{found:#?}");
    assert!(has(&found, RIGHTS_RECORD_MISSING), "{found:#?}");
}

/// Every injected transaction's signature bytes are placeholders: the
/// verifier never checks them, and no test here signs.
#[test]
fn the_injected_transactions_are_unsigned_placeholders() {
    let b = base();
    let (fl, _) = honest(&b);
    for t in &fl.inp.txs[b.inp.txs.len()..] {
        let tx = fclient::tx::from_wire(&t.tx).unwrap();
        for s in &tx.signatures {
            let bytes = s.as_ref();
            assert!(
                bytes.iter().all(|x| *x == bytes[0]),
                "a placeholder, not a signature"
            );
        }
    }
    let _ = (Key::default(), ARMS_SLOT);
}

/// No false positive: VR finds nothing on any committed recorded fixture
/// (none has a Grant instruction, record or account).
#[test]
fn vr_finds_nothing_on_the_recorded_fixtures() {
    for (name, inp) in [
        ("land", land()),
        ("march", march()),
        ("march-program", march_program()),
        ("march-program-w6base", march_program_w6base()),
    ] {
        let r = verify_core::verify(&inp);
        let vr: Vec<_> = r.findings.iter().filter(|f| f.check == "VR").collect();
        assert!(vr.is_empty(), "{name}: {vr:#?}");
        assert!(r.checks_run.contains(&"VR:rights"), "{name}");
    }
}
