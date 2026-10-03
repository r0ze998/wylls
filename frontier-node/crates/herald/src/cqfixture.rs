//! A synthetic conquest mini-season (`frontier-herald --fixture conquest`,
//! the CQ2-E tests; MC contract §8.4 "Fixture mode"). CQ3-E replaces it
//! with a recorded `MC_TEST` mini-season; until then this is the design
//! chat's and the web tests' MC data source.
//!
//! **How it is made.** The program's conquest instructions are Wave 2's
//! other units (CQ2-A/B/C), so these transactions are fixtures, not
//! program output. Every bell of every Province runs through the shared
//! models exactly as ResolveFromInputs and SkipQuiet are specified to
//! (§5.7): a resolve is `build_v2 → resolve_clash → apply_v2 →
//! report_from_outcome → settle_bell → step → finish_bell`; quiet bells
//! are batched into SkipQuiet runs of up to 6 bells (`report_quiet →
//! settle_bell → step → finish_bell`), so the herald's replay path is
//! exercised. CONQUEST payloads come from `conquest_model::
//! conquest_payload`, MARCH_FOLD from `conquest_model::fold` and
//! `apply_fold`. The player-side writes (DeclareSiege, SettleSiege,
//! SettleCapture, SettleTicket for an outpost, hosts arriving and
//! leaving) are scripted byte edits with their records, as the contract
//! states their effects. No CLASH, seed or anchor records are emitted
//! (the clash report path is M1's and is exercised by `fixture.rs`).
//!
//! **What happens** (season of 288 bells, `MC_TEST` timers with
//! `capture_credit_min_bells` 144 so a recapture can go uncredited): the
//! keeps of the March's outer provinces are taken one by one by one
//! faction (so the March banner changes); a keep contest is broken by a
//! defender's arrival; a siege on a first holding is broken by a
//! defender (immunity, stake owed and settled); a siege on another first
//! holding pauses through the owner's vigil, completes into an
//! occupation and is liberated when the owner's host retakes the
//! tile (with Respite); a genesis Free City is captured (credited) and settled, then
//! recaptured by another faction inside `capture_credit_min_bells`
//! (uncredited) and settled; an outpost is settled; a host is retired;
//! hourly folds; EndSeason.

use std::collections::{BTreeMap, BTreeSet};

use solana_address::Address;

use fclient::log::log_line;
use fclient::ports::{Account, Signature, TxRecord};
use frontier_abi::addr::{host_id, AddrCtx};
use frontier_abi::clash_model::{self as cm, TERRAINS};
use frontier_abi::conquest_model::{self as qm, StepOut, StepParams};
use frontier_abi::entry::{write_entry, Entry, EntryOp};
use frontier_abi::layout::province::entry as E;
use frontier_abi::v2::kernel::keep as kkeep;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{conquest as CR, province as P, site as SM};
use frontier_abi::v2::layout::world::{join_shard as JS2, march_state as MS, season as SE};
use frontier_abi::v2::layout::{write_header, AccountKind};
use frontier_abi::v2::log::{self as v2log, AnyKind, CqKind, EntityKind, Link};
use frontier_abi::v2::presets::{ConquestParams, MC_TEST};
use permutation_rules::frontier::clash::{frontier_ruleset, is_quiet, resolve_clash};
use permutation_rules::frontier::geometry::{
    march_members, march_of, provinces_within, MarchCoord, ProvinceCoord,
};
use permutation_rules::frontier::terrain::generate_province;

pub const SEASON_ID: u64 = 9;
pub const GENESIS_TS: i64 = 1_800_000_000;
pub const END_BELL: u32 = 288;
const RING_SEED: [u8; 32] = [7u8; 32];
const GENESIS_SEED: [u8; 32] = [0x47; 32];
const SEED: [u8; 32] = [5u8; 32];

pub fn program() -> Address {
    Address::new_from_array([0x6E; 32])
}

pub fn ctx() -> AddrCtx {
    findex::addr_ctx(&program(), SEASON_ID)
}

/// The conquest timers: `MC_TEST` with `capture_credit_min_bells` 144.
pub fn params() -> ConquestParams {
    ConquestParams {
        capture_credit_min_bells: 144,
        ..MC_TEST.cq
    }
}

fn step_params() -> StepParams {
    StepParams {
        genesis_ts: GENESIS_TS,
        end_bell: END_BELL,
        cq: params(),
    }
}

/// The fixture's wallets: one citizen per role.
pub fn wallet(i: u8) -> Address {
    let mut a = [0xC0u8; 32];
    a[0] = i;
    Address::new_from_array(a)
}

fn put(d: &mut [u8], o: usize, b: &[u8]) {
    d[o..o + b.len()].copy_from_slice(b);
}

struct Cit {
    wallet: [u8; 32],
    addr: [u8; 32],
    tag: u64,
    faction: u8,
    home: (i32, i32, u8),
}

struct Prov {
    c: ProvinceCoord,
    pd: Vec<u8>,
    /// Pending SkipQuiet bells (a run).
    run: Vec<u32>,
}

struct World {
    ctx: AddrCtx,
    txs: Vec<TxRecord>,
    seq: u64,
    slot: u64,
    season: Vec<u8>,
    provs: Vec<Prov>,
    holdings: BTreeMap<(i32, i32, u8), Vec<u8>>,
    cits: Vec<Cit>,
    march: MarchCoord,
    march_state: Vec<u8>,
    host_seq: u32,
}

fn pq_key(p: i32, q: i32) -> [u8; 8] {
    let mut k = [0u8; 8];
    k[..4].copy_from_slice(&p.to_le_bytes());
    k[4..].copy_from_slice(&q.to_le_bytes());
    k
}

fn site_key(p: i32, q: i32, s: u8) -> [u8; 9] {
    let mut k = [0u8; 9];
    k[..8].copy_from_slice(&pq_key(p, q));
    k[8] = s;
    k
}

/// A payload of `kind` with the named fields set (the rest zero).
fn payload(kind: CqKind, fields: &[(&str, &[u8])]) -> Vec<u8> {
    let k = AnyKind::Cq(kind);
    let mut p = vec![0u8; k.payload_len()];
    for (n, b) in fields {
        if let Some((o, w)) = v2log::field(k, n, true) {
            let m = b.len().min(w);
            p[o..o + m].copy_from_slice(&b[..m]);
        }
    }
    p
}

/// A v2 record body; `chain` = accounts it advances, in entity order.
fn record(
    kind: CqKind,
    bell: u32,
    key: &[u8],
    payload: &[u8],
    chain: &mut [(EntityKind, &mut Vec<u8>)],
) -> Vec<u8> {
    let mut out = vec![0u8; 512];
    let n = v2log::write_body(AnyKind::Cq(kind), bell, key, payload, &mut out).unwrap_or(0);
    let bwt = out[..n].to_vec();
    let mut links: Vec<Link> = vec![];
    for (e, d) in chain.iter_mut() {
        let seq = u64::from_le_bytes(d[24..32].try_into().unwrap_or_default());
        let head: [u8; 32] = d[32..64].try_into().unwrap_or_default();
        if let Some(l) = v2log::advance(*e, seq, &head, &bwt) {
            put(d, 24, &l.seq.to_le_bytes());
            put(d, 32, &l.head);
            links.push(l);
        }
    }
    let m = v2log::write_tail(&links, &mut out, n).unwrap_or(n);
    out.truncate(m);
    out
}

impl World {
    fn tx(&mut self, bodies: Vec<Vec<u8>>, post: Vec<([u8; 32], Option<Vec<u8>>)>) {
        self.seq += 1;
        self.slot += 1;
        let mut sig = [0u8; 64];
        sig[..8].copy_from_slice(&self.seq.to_le_bytes());
        sig[8] = 0xC9;
        self.txs.push(TxRecord {
            seq: self.seq,
            slot: self.slot,
            signature: Signature::from(sig),
            block_time: GENESIS_TS + self.slot as i64,
            tx: vec![],
            logs: fclient::log::in_frame(&program(), bodies.iter().map(|b| log_line(b))),
            err: None,
            code: None,
            units: 0,
            fee: 5_000,
            post: post
                .into_iter()
                .map(|(k, d)| {
                    (
                        Address::new_from_array(k),
                        d.map(|data| Account {
                            lamports: 1_000_000,
                            data,
                            owner: program(),
                            executable: false,
                        }),
                    )
                })
                .collect(),
        });
    }

    fn prov_post(&self, i: usize) -> ([u8; 32], Option<Vec<u8>>) {
        let c = self.provs[i].c;
        (self.ctx.province(c.p, c.q), Some(self.provs[i].pd.clone()))
    }

    fn cit(&self, i: usize) -> &Cit {
        &self.cits[i]
    }

    /// A host of citizen `ci` arriving on `tile` of province `pi` at `b`.
    fn arrive(&mut self, pi: usize, ci: usize, tile: u8, troops: u32, b: u32) -> u64 {
        self.flush(pi);
        self.host_seq += 1;
        let (hp, hq, hs) = self.cits[ci].home;
        let id = host_id(hp, hq, hs, 0, self.host_seq).unwrap_or(0);
        let e = Entry {
            id,
            faction: self.cits[ci].faction,
            unit: 0,
            tile,
            state: E::STATE_ROSTER,
            troops: troops * 1_000,
            stamina_value: 120,
            dealt_bps: 10_000,
            stamina_bell: 0,
            ready_bell: 0,
            from_bell: b,
            pend_bell: 0,
            op: EntryOp::None,
        };
        let pd = &mut self.provs[pi].pd;
        let slot = (0..P::ENTRIES_N).find(|&i| pd[P::entry(i) + E::STATE] == E::STATE_FREE);
        if let Some(i) = slot {
            let _ = write_entry(pd, i, &e);
            let n = pd[P::N_ENTRIES];
            pd[P::N_ENTRIES] = n.saturating_add(1);
        }
        let post = vec![self.prov_post(pi)];
        self.tx(vec![], post);
        id
    }

    /// A host leaving (its entry freed, as a settled departure).
    fn leave(&mut self, pi: usize, id: u64) {
        self.flush(pi);
        let pd = &mut self.provs[pi].pd;
        if let Some(i) = frontier_abi::entry::find_entry(pd, id) {
            let o = P::entry(i);
            pd[o..o + E::SIZE].fill(0);
            let n = pd[P::N_ENTRIES];
            pd[P::N_ENTRIES] = n.saturating_sub(1);
        }
        let post = vec![self.prov_post(pi)];
        self.tx(vec![], post);
    }

    fn quiet(pd: &[u8], b: u32) -> bool {
        cm::trivially_quiet_v2(pd, b).unwrap_or(false)
            || cm::build_v2(pd, None, b)
                .ok()
                .and_then(|built| is_quiet(&frontier_ruleset(), &built.input(&[0; 32])).ok())
                .unwrap_or(false)
    }

    /// CONQUEST of step bell `b`, logged by a transaction landing at bell
    /// `now` (the program's `bell_log`: the header is the landing bell, the
    /// step bell is in the key, §6).
    fn conquest_body(&mut self, pi: usize, b: u32, now: u32, so: &StepOut) -> Vec<u8> {
        let c = self.provs[pi].c;
        let pl = qm::conquest_payload(&self.provs[pi].pd, so).expect("payload");
        let key = v2log::conquest_key(c.p, c.q, b);
        let mut pd = std::mem::take(&mut self.provs[pi].pd);
        let body = record(
            CqKind::CONQUEST,
            now,
            &key,
            &pl.to_bytes(),
            &mut [(EntityKind::Province, &mut pd)],
        );
        self.provs[pi].pd = pd;
        body
    }

    /// ResolveFromInputs of bell `b`.
    fn resolve(&mut self, pi: usize, b: u32) {
        let pd = &mut self.provs[pi].pd;
        let built = cm::build_v2(pd, None, b).expect("build_v2");
        let out = resolve_clash(&frontier_ruleset(), &built.input(&SEED)).expect("clash");
        let ap = cm::apply_v2(pd, &built, &out).expect("apply_v2");
        let rep = qm::report_from_outcome(&built, &out).expect("report");
        let settled = cm::settle_bell(pd, b).expect("settle");
        let so = qm::step(pd, b, &rep, &step_params()).expect("step");
        cm::finish_bell(pd, b, ap.changed() || settled || so.roster_changed).expect("finish");
        let bodies = if so.emits() {
            vec![self.conquest_body(pi, b, b + 1, &so)]
        } else {
            vec![]
        };
        let post = vec![self.prov_post(pi)];
        self.tx(bodies, post);
    }

    /// The pending SkipQuiet run of province `pi`, as one transaction.
    fn flush(&mut self, pi: usize) {
        let run = std::mem::take(&mut self.provs[pi].run);
        if run.is_empty() {
            return;
        }
        let mut bodies = vec![];
        let last = run.last().copied().unwrap_or(0);
        for b in run {
            let pd = &mut self.provs[pi].pd;
            let rep = qm::report_quiet(pd, b).expect("report_quiet");
            let settled = cm::settle_bell(pd, b).expect("settle");
            let so = qm::step(pd, b, &rep, &step_params()).expect("step");
            cm::finish_bell(pd, b, settled || so.roster_changed).expect("finish");
            if so.emits() {
                bodies.push(self.conquest_body(pi, b, last + 1, &so));
            }
        }
        let post = vec![self.prov_post(pi)];
        self.tx(bodies, post);
    }

    fn bell(&mut self, b: u32, touched: &BTreeSet<usize>) {
        for pi in 0..self.provs.len() {
            let quiet = !touched.contains(&pi) && Self::quiet(&self.provs[pi].pd, b);
            if quiet {
                self.provs[pi].run.push(b);
                if self.provs[pi].run.len() >= 6 {
                    self.flush(pi);
                }
            } else {
                self.flush(pi);
                self.resolve(pi, b);
            }
        }
    }

    /// FoldMarch for every hour whose members all resolved past `6h`.
    fn folds(&mut self) {
        loop {
            let h = u32::from_le_bytes(
                self.march_state[MS::NEXT_HOUR..MS::NEXT_HOUR + 4]
                    .try_into()
                    .unwrap_or_default(),
            );
            if 6 * h >= END_BELL {
                return;
            }
            let members = march_members(self.march);
            let datas: Vec<Option<Vec<u8>>> = members
                .iter()
                .map(|c| self.provs.iter().find(|x| x.c == *c).map(|x| x.pd.clone()))
                .collect();
            let refs: [Option<&[u8]>; 7] = std::array::from_fn(|i| datas[i].as_deref());
            let Ok(hf) = qm::fold(&refs, h) else {
                return;
            };
            let mut ms = std::mem::take(&mut self.march_state);
            let log = qm::apply_fold(&mut ms, &hf, params().dominion_per_hour).expect("apply_fold");
            let mut key = [0u8; 12];
            key[..8].copy_from_slice(&pq_key(self.march.m, self.march.n));
            key[8..].copy_from_slice(&h.to_le_bytes());
            let body = record(
                CqKind::MARCH_FOLD,
                6 * h + 6,
                &key,
                &log.to_bytes(),
                &mut [(EntityKind::MarchState, &mut ms)],
            );
            let addr = frontier_abi::v2::addr::march_state(&self.ctx, self.march.m, self.march.n);
            self.march_state = ms;
            let post = vec![(addr, Some(self.march_state.clone()))];
            self.tx(vec![body], post);
        }
    }

    /// DeclareSiege on `site` of province `pi` by citizen `ci` at bell `b`
    /// (the record and SIEGE_DECLARED; §3.4's effects).
    fn declare(&mut self, pi: usize, site: u8, ci: usize, owner: Option<usize>, slot: u8, b: u32) {
        self.flush(pi);
        let c = self.provs[pi].c;
        let cit = self.cit(ci);
        let (tag, fac, home) = (cit.tag, cit.faction, cit.home);
        let src = host_id(home.0, home.1, home.2, 0, 0).unwrap_or(0);
        let pd = &mut self.provs[pi].pd;
        let o = P::site(site as usize);
        let free = pd[o + SM::STATE] == SM::STATE_FREE_CITY;
        let (owner_tag, owner_f, vigil) = match owner {
            Some(oi) => (self.cits[oi].tag, self.cits[oi].faction, 0u16),
            None => (0, 6, 0),
        };
        let tk = if free {
            CR::TARGET_FREE_CITY
        } else if pd[o + SM::ORDER] <= 1 {
            CR::TARGET_FIRST
        } else {
            CR::TARGET_OTHER
        };
        let rec = qm::Record {
            kind: CR::KIND_SIEGE,
            faction: fac,
            flags: CR::FLAG_HELD | if free { CR::FLAG_NEUTRAL } else { 0 },
            progress: 0,
            required: 36,
            target: CR::target(tk, slot),
            vigil_start: vigil,
            vigil_next: vigil,
            vigil_from_day: 0,
            bell: b,
            actor: tag,
            src,
        };
        rec.write(pd, site as usize).expect("record");
        let pl = payload(
            CqKind::SIEGE_DECLARED,
            &[
                ("attacker", &[fac]),
                ("owner_faction", &[owner_f]),
                ("target", &[rec.target]),
                ("declarer_tag", &tag.to_le_bytes()),
                ("required", &[36]),
                ("vigil_start", &vigil.to_le_bytes()),
                ("vigil_next", &vigil.to_le_bytes()),
                ("stake", &500u32.to_le_bytes()),
                ("src_key", &src.to_le_bytes()),
                ("owner_tag", &owner_tag.to_le_bytes()),
            ],
        );
        let mut pd = std::mem::take(&mut self.provs[pi].pd);
        let body = record(
            CqKind::SIEGE_DECLARED,
            b,
            &site_key(c.p, c.q, site),
            &pl,
            &mut [(EntityKind::Province, &mut pd)],
        );
        self.provs[pi].pd = pd;
        let post = vec![self.prov_post(pi)];
        self.tx(vec![body], post);
    }

    /// SettleSiege: the owed flags cleared, SIEGE_SETTLED.
    fn settle_siege(&mut self, pi: usize, site: u8, reason: u8, b: u32) {
        self.flush(pi);
        let c = self.provs[pi].c;
        let pd = &mut self.provs[pi].pd;
        let mut r = qm::Record::read(pd, site as usize).expect("record");
        r.flags &= !CR::OWED_MASK;
        r.write(pd, site as usize).expect("record");
        let pl = payload(
            CqKind::SIEGE_SETTLED,
            &[("reason", &[reason]), ("amount", &500u32.to_le_bytes())],
        );
        let mut pd = std::mem::take(&mut self.provs[pi].pd);
        let body = record(
            CqKind::SIEGE_SETTLED,
            b,
            &site_key(c.p, c.q, site),
            &pl,
            &mut [(EntityKind::Province, &mut pd)],
        );
        self.provs[pi].pd = pd;
        let post = vec![self.prov_post(pi)];
        self.tx(vec![body], post);
    }

    /// SettleCapture: the record to post-capture immunity, the Holding to
    /// the captor (or created for a Free City), CAPTURE_SETTLED.
    fn settle_capture(
        &mut self,
        pi: usize,
        site: u8,
        captor: usize,
        victim: Option<usize>,
        b: u32,
    ) {
        self.flush(pi);
        let c = self.provs[pi].c;
        let pd = &mut self.provs[pi].pd;
        let r = qm::Record::read(pd, site as usize).expect("record");
        let credited = r.flags & CR::FLAG_CREDITED != 0;
        let slot = CR::target_slot(r.target);
        let n = qm::Record {
            faction: CR::BARRED_ALL,
            bell: r.bell + 1 + params().immunity_bells as u32,
            ..qm::Record::ZERO
        };
        n.write(pd, site as usize).expect("record");
        let gen = pd[P::site(site as usize) + SM::GEN];
        let cap = &self.cits[captor];
        let (ctag, caddr) = (cap.tag, cap.addr);
        let h = self
            .holdings
            .entry((c.p, c.q, site))
            .or_insert_with(|| holding(c.p, c.q, site, 0, &caddr, 0, slot));
        put(h, H2::OWNER_CITIZEN, &caddr);
        h[H2::GEN] = gen;
        h[H2::ORDER] = slot;
        h[H2::FACTION] = self.cits[captor].faction;
        let hd = h.clone();
        let vtag = victim.map_or(0, |v| self.cits[v].tag);
        let pl = payload(
            CqKind::CAPTURE_SETTLED,
            &[
                ("outcome", &[if victim.is_none() { 2 } else { 0 }]),
                ("credited", &[credited as u8]),
                ("captor_tag", &ctag.to_le_bytes()),
                ("victim_tag", &vtag.to_le_bytes()),
                ("new_gen", &[gen]),
                ("slot", &[slot]),
            ],
        );
        let mut pd = std::mem::take(&mut self.provs[pi].pd);
        let body = record(
            CqKind::CAPTURE_SETTLED,
            b,
            &site_key(c.p, c.q, site),
            &pl,
            &mut [(EntityKind::Province, &mut pd)],
        );
        self.provs[pi].pd = pd;
        let post = vec![
            self.prov_post(pi),
            (self.ctx.holding(c.p, c.q, site), Some(hd)),
        ];
        self.tx(vec![body], post);
    }
}

#[allow(clippy::too_many_arguments)]
fn holding(
    p: i32,
    q: i32,
    site: u8,
    faction: u8,
    owner: &[u8; 32],
    tile: u8,
    order: u8,
) -> Vec<u8> {
    let mut d = vec![0u8; H2::SIZE];
    write_header(&mut d, AccountKind::Holding, SEASON_ID);
    put(&mut d, H2::P, &(p as i16).to_le_bytes());
    put(&mut d, H2::Q, &(q as i16).to_le_bytes());
    d[H2::SITE] = site;
    d[H2::TILE] = tile;
    d[H2::STATE] = 1;
    put(&mut d, H2::OWNER_CITIZEN, owner);
    d[H2::FACTION] = faction;
    d[H2::ORDER] = order;
    put(&mut d, H2::FOUNDED_TS, &GENESIS_TS.to_le_bytes());
    put(
        &mut d,
        H2::LAST_OWNER_ACTION,
        &(GENESIS_TS + 400_000).to_le_bytes(),
    );
    put(&mut d, H2::FINAL_TS, &GENESIS_TS.to_le_bytes());
    d
}

/// A fresh Province v2 at `c` with its keep (the test helper of
/// `frontier-abi`'s `cq_conquest_model`, with the season's guard).
fn province(c: ProvinceCoord) -> Vec<u8> {
    let t = generate_province(&RING_SEED, c);
    let mut pd = vec![0u8; P::SIZE];
    write_header(&mut pd, AccountKind::Province, SEASON_ID);
    put(&mut pd, P::P, &(c.p as i16).to_le_bytes());
    put(&mut pd, P::Q, &(c.q as i16).to_le_bytes());
    put(&mut pd, P::RING, &(c.ring() as u16).to_le_bytes());
    pd[P::WEDGE] = c.wedge().unwrap_or(0);
    pd[P::REGION] = permutation_rules::frontier::geometry::region_of(c);
    for i in 0..61 {
        pd[P::TERRAIN + i] = TERRAINS
            .iter()
            .position(|x| *x == t.terrain[i])
            .unwrap_or(0) as u8;
        pd[P::RESOURCE + i] = match t.resource[i] {
            None => 0,
            Some(r) => 1 + cm::RESOURCES.iter().position(|x| *x == r).unwrap_or(0) as u8,
        };
    }
    put(&mut pd, P::SITES, &t.sites);
    pd[P::SITE_COUNT] = t.site_count;
    for s in 0..12 {
        let o = P::site(s);
        put(&mut pd, o + SM::PEND0_BELL, &SM::NO_BELL.to_le_bytes());
        put(&mut pd, o + SM::PEND1_BELL, &SM::NO_BELL.to_le_bytes());
    }
    let camp = cm::Camp {
        tile: 0,
        state: 0,
        troops: 0,
        next_check_day: 1_000,
        gen: 0,
    };
    camp.write(&mut pd).expect("camp");
    let w = c.wedge().unwrap_or(0);
    match kkeep::keep_tile(&t, &t.sites, t.site_count, w) {
        Some(tile) if c.ring() >= 2 => {
            let kp = params().keep_params();
            match kkeep::open(c, w, params().heartland_max_ring, tile, &kp, 0) {
                Some(k) => qm::write_keep(&mut pd, &k).expect("keep"),
                None => qm::write_no_keep(&mut pd).expect("no keep"),
            }
        }
        _ => qm::write_no_keep(&mut pd).expect("no keep"),
    }
    pd
}

/// A holding on site `s` of `pd` (mirror state 1).
fn hold_site(pd: &mut [u8], s: usize, faction: u8, order: u8) {
    let o = P::site(s);
    pd[o + SM::STATE] = SM::STATE_HOLDING;
    pd[o + SM::FACTION] = faction;
    pd[o + SM::ORDER] = order;
    pd[o + SM::TIER] = 0;
}

fn other(avoid: &[u8]) -> u8 {
    (0..6u8).find(|f| !avoid.contains(f)).unwrap_or(0)
}

/// The mini-season's transactions in archive order.
pub fn mini_season() -> Vec<TxRecord> {
    let ctx = ctx();
    // the March of the first ring-3 province; its members are the provinces
    let first3 = ProvinceCoord::from_index(provinces_within(2));
    let march = march_of(first3);
    let members: Vec<ProvinceCoord> = march_members(march)
        .into_iter()
        .filter(|c| (2..=4).contains(&c.ring()))
        .collect();
    let mut provs: Vec<Prov> = members
        .iter()
        .map(|&c| Prov {
            c,
            pd: province(c),
            run: vec![],
        })
        .collect();
    provs.sort_by_key(|x| x.c.index());
    let outer: Vec<usize> = (0..provs.len())
        .filter(|&i| provs[i].c.ring() >= 3)
        .collect();
    assert!(
        outer.len() >= 3,
        "the fixture March has ≥ 3 outer provinces"
    );
    let a = outer[0];
    let bp = outer[1 % outer.len()];
    let cp = outer[2 % outer.len()];
    let wedge = |i: usize| provs[i].c.wedge().unwrap_or(0);
    let (wa, wb, wc) = (wedge(a), wedge(bp), wedge(cp));
    let wedges: Vec<u8> = provs.iter().map(|x| x.c.wedge().unwrap_or(0)).collect();
    // factions of the roles
    let fx = other(&wedges);
    let fy = other(&[wb, fx]);
    let fs = other(&[wa, fx, fy]);
    let fo = other(&[wb, fx, fs]);
    let fc = other(&[wc, fx, fy, fs]);
    let fr = other(&[wc, fc, fx]);
    // citizens: (role, faction, home province, home site)
    let counts: Vec<u8> = provs.iter().map(|x| x.pd[P::SITE_COUNT]).collect();
    let sites = |i: usize| counts[i];
    let roles: Vec<(u8, usize, u8)> = vec![
        (wa, a, 0),         // 0 c_def: the first holding besieged and defended
        (wb, bp, 0),        // 1 c_occ: the first holding occupied and liberated
        (fx, a, 2),         // 2 the keep taker
        (fy, bp, 2),        // 3 the broken contender
        (fs, a, 3),         // 4 the siege attacker (broken)
        (fo, bp, 3),        // 5 the occupier
        (fc, cp, 2),        // 6 the Free City captor
        (fr, cp, 3),        // 7 the recaptor
        (wa, a, 4),         // 8 a defender of A
        (wedge(bp), bp, 4), // 9 the keep defender of B
        (fc, cp, 4.min(sites(cp).saturating_sub(1))), // 10 the outpost settler
    ];
    let mut cits = vec![];
    for (i, (f, pi, s)) in roles.iter().enumerate() {
        let w = wallet(i as u8).to_bytes();
        let addr = ctx.citizen(&w);
        let c = provs[*pi].c;
        cits.push(Cit {
            wallet: w,
            addr,
            tag: u64::from_le_bytes(addr[..8].try_into().unwrap_or_default()),
            faction: *f,
            home: (c.p, c.q, *s),
        });
    }
    // the Free City on C's site 1 (fixture placement; §3.7's
    // `free_city_site` is CQ2-A's OpenProvince)
    let fc_site = 1u8;
    // the outpost site: the last site of C
    let op_site = sites(cp) - 1;
    let mut holdings = BTreeMap::new();
    for (i, cit) in cits.iter().enumerate() {
        if i == 10 {
            continue; // the outpost comes later
        }
        let (p, q, s) = cit.home;
        let pi = provs
            .iter()
            .position(|x| x.c == ProvinceCoord::new(p, q))
            .unwrap_or(0);
        let tile = provs[pi].pd[P::SITES + s as usize];
        hold_site(&mut provs[pi].pd, s as usize, cit.faction, 1);
        // every owner's vigil is 00:00–08:00 UTC (the record snapshots
        // `vigil_start` 0): genesis is 08:00 UTC, so bells 96–143 pause
        holdings.insert((p, q, s), holding(p, q, s, cit.faction, &cit.addr, tile, 1));
    }
    // the outpost settler's first holding lives elsewhere (site 5 of A)
    {
        let s = 5u8.min(sites(a) - 1);
        let c = provs[a].c;
        cits[10].home = (c.p, c.q, s);
        hold_site(&mut provs[a].pd, s as usize, cits[10].faction, 1);
        let tile = provs[a].pd[P::SITES + s as usize];
        holdings.insert(
            (c.p, c.q, s),
            holding(c.p, c.q, s, cits[10].faction, &cits[10].addr, tile, 1),
        );
    }
    {
        let o = P::site(fc_site as usize);
        let pd = &mut provs[cp].pd;
        pd[o + SM::STATE] = SM::STATE_FREE_CITY;
        pd[o + SM::FACTION] = 6;
        pd[o + SM::ORDER] = 0;
        put(
            pd,
            o + SM::GARRISON,
            &(params().free_city_garrison * 1_000).to_le_bytes(),
        );
    }
    let mut season = vec![0u8; SE::SIZE];
    write_header(&mut season, AccountKind::Season, SEASON_ID);
    season[SE::STATUS] = SE::STATUS_RUNNING;
    season[SE::REGIONS] = 16;
    season[SE::GENESIS_RING] = 4;
    put(&mut season, SE::R_MAX, &16u16.to_le_bytes());
    put(
        &mut season,
        SE::RULESET_HASH,
        &frontier_abi::v2::presets::RULESET_HASH_V2,
    );
    put(
        &mut season,
        SE::RULES_VERSION,
        &frontier_abi::v2::presets::RULES_VERSION_V2.to_le_bytes(),
    );
    put(
        &mut season,
        SE::PROGRAM_VERSION,
        &SE::PROGRAM_VERSION_V2.to_le_bytes(),
    );
    put(&mut season, SE::BELL_SECS, &600u32.to_le_bytes());
    put(&mut season, SE::GENESIS_TS, &GENESIS_TS.to_le_bytes());
    put(&mut season, SE::END_BELL, &END_BELL.to_le_bytes());
    put(&mut season, SE::GENESIS_SEED, &GENESIS_SEED);
    put(&mut season, SE::CONQUEST_PARAMS, &params().to_bytes());
    let mut march_state = vec![0u8; MS::SIZE];
    write_header(&mut march_state, AccountKind::MarchState, SEASON_ID);
    put(&mut march_state, MS::M, &march.m.to_le_bytes());
    put(&mut march_state, MS::N, &march.n.to_le_bytes());
    march_state[MS::CONTROLLER] = MS::CONTROLLER_NONE;
    let mut w = World {
        ctx,
        txs: vec![],
        seq: 0,
        slot: 0,
        season,
        provs,
        holdings,
        cits,
        march,
        march_state,
        host_seq: 0,
    };
    // ---- genesis: season, citizens, shards, holdings, provinces (KEEP, NEUTRAL)
    let mut post = vec![(w.ctx.season, Some(w.season.clone()))];
    let mut shards: BTreeMap<u8, (u32, u32)> = BTreeMap::new();
    for c in &w.cits {
        let mut d = vec![0u8; C2::SIZE];
        write_header(&mut d, AccountKind::Citizen, SEASON_ID);
        put(&mut d, C2::WALLET, &c.wallet);
        d[C2::FACTION] = c.faction;
        d[C2::HOLDINGS_N] = 1;
        put(&mut d, C2::CITIZEN_TAG, &c.tag.to_le_bytes());
        post.push((c.addr, Some(d)));
        let e = shards.entry(c.faction).or_default();
        e.0 += 1;
        e.1 += 1;
    }
    for (f, (m, fin)) in &shards {
        let mut d = vec![0u8; JS2::SIZE];
        write_header(&mut d, AccountKind::JoinShard, SEASON_ID);
        d[JS2::FACTION] = *f;
        put(&mut d, JS2::MEMBERS, &m.to_le_bytes());
        put(&mut d, JS2::HOLDINGS, &fin.to_le_bytes());
        put(&mut d, JS2::FINAL_HOLDINGS, &fin.to_le_bytes());
        post.push((w.ctx.join_shard(*f, 0), Some(d)));
    }
    for ((p, q, s), h) in &w.holdings {
        post.push((w.ctx.holding(*p, *q, *s), Some(h.clone())));
    }
    let mut bodies = vec![];
    for i in 0..w.provs.len() {
        let c = w.provs[i].c;
        if let Ok(Some(k)) = qm::read_keep(&w.provs[i].pd) {
            let pl = payload(
                CqKind::KEEP,
                &[
                    ("cause", &[0]),
                    ("holder", &[k.holder]),
                    ("from", &[0xFF]),
                    ("troops", &k.troops.to_le_bytes()),
                    ("consolidated_until", &0u32.to_le_bytes()),
                ],
            );
            let mut pd = std::mem::take(&mut w.provs[i].pd);
            bodies.push(record(
                CqKind::KEEP,
                0,
                &pq_key(c.p, c.q),
                &pl,
                &mut [(EntityKind::Province, &mut pd)],
            ));
            w.provs[i].pd = pd;
        }
    }
    {
        let c = w.provs[cp].c;
        let pl = payload(
            CqKind::NEUTRAL,
            &[
                ("kind", &[0]),
                ("garrison", &params().free_city_garrison.to_le_bytes()),
                ("tier", &[0]),
            ],
        );
        let mut pd = std::mem::take(&mut w.provs[cp].pd);
        bodies.push(record(
            CqKind::NEUTRAL,
            0,
            &site_key(c.p, c.q, fc_site),
            &pl,
            &mut [(EntityKind::Province, &mut pd)],
        ));
        w.provs[cp].pd = pd;
    }
    for i in 0..w.provs.len() {
        post.push(w.prov_post(i));
    }
    w.tx(bodies, post);
    // ---- the script
    let keep_tile = |w: &World, i: usize| {
        qm::read_keep(&w.provs[i].pd)
            .ok()
            .flatten()
            .map(|k| k.tile)
            .unwrap_or(0)
    };
    let site_tile = |w: &World, i: usize, s: u8| w.provs[i].pd[P::SITES + s as usize];
    let mut taker_hosts: Vec<(usize, u64)> = vec![];
    let mut ids: BTreeMap<&'static str, (usize, u64)> = BTreeMap::new();
    for b in 0..END_BELL {
        let mut touched = BTreeSet::new();
        // the keep taker visits the outer keeps one by one (B after the
        // broken contest)
        for (k, &pi) in outer.iter().enumerate() {
            let start = match k {
                1 => 90,
                _ => 2 + 30 * k as u32,
            };
            if b == start {
                let t = keep_tile(&w, pi);
                let id = w.arrive(pi, 2, t, 4_000, b);
                taker_hosts.push((pi, id));
                touched.insert(pi);
            }
        }
        match b {
            // a siege broken by a defender (A, c_def's first holding)
            3 => {
                let t = site_tile(&w, a, 0);
                let id = w.arrive(a, 4, t, 3_000, b);
                ids.insert("sieger", (a, id));
                touched.insert(a);
            }
            4 => {
                w.declare(a, 0, 4, Some(0), 0, b);
                touched.insert(a);
            }
            12 => {
                let t = site_tile(&w, a, 0);
                let id = w.arrive(a, 8, t, 20_000, b);
                ids.insert("defender", (a, id));
                touched.insert(a);
            }
            14 => {
                w.settle_siege(a, 0, 0, b);
                touched.insert(a);
            }
            // the Free City
            20 => {
                let t = site_tile(&w, cp, fc_site);
                let id = w.arrive(cp, 6, t, 5_000, b);
                ids.insert("fc", (cp, id));
                touched.insert(cp);
            }
            21 => {
                w.declare(cp, fc_site, 6, None, 2, b);
                touched.insert(cp);
            }
            // the outpost (OUTPOST_SETTLED with SettleTicket's effects)
            30 => {
                w.flush(cp);
                let c = w.provs[cp].c;
                hold_site(&mut w.provs[cp].pd, op_site as usize, w.cits[10].faction, 2);
                let o = P::site(op_site as usize);
                put(
                    &mut w.provs[cp].pd,
                    o + SM::HELD_SINCE_HOUR,
                    &((b + 1).div_ceil(6) as u16).to_le_bytes(),
                );
                let tile = site_tile(&w, cp, op_site);
                let h = holding(
                    c.p,
                    c.q,
                    op_site,
                    w.cits[10].faction,
                    &w.cits[10].addr,
                    tile,
                    2,
                );
                w.holdings.insert((c.p, c.q, op_site), h.clone());
                let pl = payload(
                    CqKind::OUTPOST_SETTLED,
                    &[
                        ("citizen_tag", &w.cits[10].tag.to_le_bytes()),
                        ("order", &[2]),
                    ],
                );
                let mut pd = std::mem::take(&mut w.provs[cp].pd);
                let body = record(
                    CqKind::OUTPOST_SETTLED,
                    b,
                    &site_key(c.p, c.q, op_site),
                    &pl,
                    &mut [(EntityKind::Province, &mut pd)],
                );
                w.provs[cp].pd = pd;
                let post = vec![w.prov_post(cp), (w.ctx.holding(c.p, c.q, op_site), Some(h))];
                w.tx(vec![body], post);
                touched.insert(cp);
            }
            // a keep contest broken by the defender's arrival (B)
            40 => {
                let t = keep_tile(&w, bp);
                let id = w.arrive(bp, 3, t, 2_000, b);
                ids.insert("contender", (bp, id));
                touched.insert(bp);
            }
            50 => {
                let t = keep_tile(&w, bp);
                let id = w.arrive(bp, 9, t, 25_000, b);
                ids.insert("keepdef", (bp, id));
                touched.insert(bp);
            }
            // the occupation (B, c_occ's first holding), through the vigil
            69 => {
                let t = site_tile(&w, bp, 0);
                let id = w.arrive(bp, 5, t, 3_000, b);
                ids.insert("occupier", (bp, id));
                touched.insert(bp);
            }
            70 => {
                w.declare(bp, 0, 5, Some(1), 0, b);
                touched.insert(bp);
            }
            62 => {
                if let Some((pi, id)) = ids.get("keepdef").copied() {
                    w.leave(pi, id);
                    touched.insert(pi);
                }
            }
            // the recapture (uncredited: held < 144 bells at completion)
            84 => {
                let t = site_tile(&w, cp, fc_site);
                let id = w.arrive(cp, 7, t, 20_000, b);
                ids.insert("recaptor", (cp, id));
                touched.insert(cp);
            }
            86 => {
                w.declare(cp, fc_site, 7, Some(6), 2, b);
                touched.insert(cp);
            }
            // the owner retakes the occupied holding (a host of its own on
            // the tile, much stronger): liberated, with Respite (§3.5)
            _ if (160..260).contains(&b)
                && ids.contains_key("occupier")
                && !ids.contains_key("liberator")
                && occupied(&w, bp, 0) =>
            {
                let t = site_tile(&w, bp, 0);
                let id = w.arrive(bp, 1, t, 30_000, b);
                ids.insert("liberator", (bp, id));
                touched.insert(bp);
            }
            _ => {}
        }
        // stakes and captures owed: settle them as a keeper would
        for (pi, site) in owed(&w) {
            let r = qm::Record::read(&w.provs[pi].pd, site as usize).expect("record");
            if r.kind == CR::KIND_CAPTURE_DUE && b > r.bell {
                let victim = (0..w.cits.len()).find(|&i| {
                    let c = w.provs[pi].c;
                    w.holdings.get(&(c.p, c.q, site)).is_some_and(|h| {
                        h[H2::OWNER_CITIZEN..H2::OWNER_CITIZEN + 32] == w.cits[i].addr
                    })
                });
                let captor = (0..w.cits.len())
                    .find(|&i| w.cits[i].tag == r.actor)
                    .unwrap_or(0);
                w.settle_capture(pi, site, captor, victim, b);
                touched.insert(pi);
            } else if r.kind == CR::KIND_OCCUPATION && b > r.bell + 1 {
                w.settle_siege(pi, site, 1, b);
                touched.insert(pi);
            }
        }
        // a retired host (A's defender, as RetireHost after the season's
        // fighting; display data only)
        if b == 200 {
            if let Some((pi, id)) = ids.get("defender").copied() {
                if frontier_abi::entry::find_entry(&w.provs[pi].pd, id).is_some() {
                    let mut key = [0u8; 8];
                    key.copy_from_slice(&id.to_le_bytes());
                    let pl = payload(
                        CqKind::RETIRE,
                        &[("troops", &1_000u32.to_le_bytes()), ("by", &[0])],
                    );
                    let mut pd = std::mem::take(&mut w.provs[pi].pd);
                    let body = record(
                        CqKind::RETIRE,
                        b,
                        &key,
                        &pl,
                        &mut [(EntityKind::Province, &mut pd)],
                    );
                    w.provs[pi].pd = pd;
                    let post = vec![w.prov_post(pi)];
                    w.tx(vec![body], post);
                    w.leave(pi, id);
                    touched.insert(pi);
                }
            }
        }
        w.bell(b, &touched);
        w.folds();
    }
    for pi in 0..w.provs.len() {
        w.flush(pi);
    }
    w.folds();
    // EndSeason
    w.season[SE::STATUS] = SE::STATUS_ENDED;
    let post = vec![(w.ctx.season, Some(w.season.clone()))];
    w.tx(vec![], post);
    w.txs
}

fn occupied(w: &World, pi: usize, site: u8) -> bool {
    qm::Record::read(&w.provs[pi].pd, site as usize).is_ok_and(|r| r.kind == CR::KIND_OCCUPATION)
}

/// Sites whose record owes a settle (capture due, a stake to `src`).
fn owed(w: &World) -> Vec<(usize, u8)> {
    let mut v = vec![];
    for (pi, p) in w.provs.iter().enumerate() {
        for s in 0..12u8 {
            if let Ok(r) = qm::Record::read(&p.pd, s as usize) {
                if r.kind == CR::KIND_CAPTURE_DUE
                    || (r.kind == CR::KIND_OCCUPATION && r.flags & CR::FLAG_STAKE_TO_SRC != 0)
                {
                    v.push((pi, s));
                }
            }
        }
    }
    v
}

/// A `findex::Source` over a fixed list (the fixture's ingest).
pub struct VecSource {
    pub txs: Vec<TxRecord>,
    pub pos: usize,
    pub batch: usize,
}

impl findex::Source for VecSource {
    async fn pull(&mut self) -> fclient::ports::PortResult<Vec<TxRecord>> {
        let end = (self.pos + self.batch).min(self.txs.len());
        let out = self.txs[self.pos..end].to_vec();
        self.pos = end;
        Ok(out)
    }
    fn cursor(&self) -> serde_json::Value {
        serde_json::json!({"pos": self.pos})
    }
    fn restore(&mut self, v: &serde_json::Value) {
        if let Some(p) = v.get("pos").and_then(|x| x.as_u64()) {
            self.pos = p as usize;
        }
    }
}
