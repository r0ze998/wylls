//! `frontier-operator end-season` (devnet-end-season, D-dress-6): the end of
//! a season and its clean-up, in the same style as the season setup
//! ([`crate::operator`]): plan → dry run with the exact costs and refunds →
//! the send gate (`--yes-send`; on devnet also `--i-have-r0ze-approval` and
//! `--approved-sha256`) → send, one transaction at a time, re-reading the
//! chain before each, so a run that stopped half-way is finished by running
//! it again (idempotent).
//!
//! The program's rules it follows (`permutation-frontier/src/proc/season.rs`,
//! `proc/map.rs`, `proc/wide.rs`):
//!
//! 1. **EndSeason** (0x04, class N, any signer): effective status Running
//!    (stored Seeded with `now ≥ genesis_ts`) and `bell(now) ≥ end_bell`
//!    (`TooEarly` before); Ended → `AlreadyDone`. Changes the status only:
//!    no lamports move but the fee. The tool refuses to send it before the
//!    end bell (exit 3, nothing sent).
//! 2. **The 72-hour grace** (`END_GRACE_SECS`): every close below is
//!    `TooEarly` before `end + 72 h` (`end = genesis_ts + end_bell × 600`).
//!    Inside the grace the Provinces are still on chain (a ⑰ prize pool's
//!    tally reads them; ClaimDefence still pays from the DefencePool).
//! 3. **CloseProvince** (0x24, class N, any signer) for every legacy
//!    Province and **WideClose(6)** (0xDE, playable lane) for every wide
//!    province: the Province's lamports go to its wedge's ProvinceFund and
//!    `provinces_opened` drops by one. CloseSeason's final part needs every
//!    fund's `provinces_opened == 0`.
//! 4. **CloseSeason** (0x05, class O, the Season's stored authority): parts
//!    0–5 the 48 JoinShards, part 6 the 16 BeaconLogs (rent to the
//!    authority), part 8 the RingSeeds (rent to each seed's stored payer:
//!    keeper A), part 7 (final) the Frontier, the six ProvinceFunds and the
//!    DefencePool (all to the authority) and the Season shrinks to its 128-B
//!    tombstone (the lamports above the tombstone's rent, the creation bond
//!    included, to the authority); then, on the tombstone only, part 9 the
//!    AnchorArchives (to each `rent_to`) and part 10 the DefenceClaims (to
//!    each beneficiary).
//!
//! Not sent by this tool (listed in the plan with their counts): the
//! players' Holdings and Citizens (CloseHolding / CloseCitizen, anyone, rent
//! to the players; they still close on the tombstone, v1.7), keeper A's
//! floats (its `close` role), and the wide records that have no close (the
//! wide ring seeds).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::ports::ChainPort;
use fclient::{ix, Address, Instruction, Keypair, Signer};
use serde_json::{json, Value};

use crate::chain::{timed, Chain};
use crate::operator::{
    self as op, check_genesis, check_url, gate_flags, gate_program, grouped, load_authority,
    parse_profile, redact, sol, BeaconChoice, Endpoint, Landed, Opts, APPROVAL_FLAG,
    DEVNET_GENESIS, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, EXIT_WAITING, FEE_PER_SIGNATURE,
    LAND_LIMIT,
};

/// The program's grace after `end` before any close (`proc/map.rs`).
pub const END_GRACE_SECS: i64 = frontier_abi::presets::END_GRACE_SECS;
/// Bell length (the program's constant).
pub const BELL_SECS: i64 = fclient::abi::BELL_SECS;
/// CloseProvince instructions per transaction (measured offline: see the
/// PEND evidence; well inside 1.4 M CU and the packet).
pub const PROVINCES_PER_TX: usize = 6;
/// WideClose(6) instructions per transaction.
pub const WIDE_PROVINCES_PER_TX: usize = 4;

/// One account the plan closes: what it is, its lamports now and who gets them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refund {
    pub label: String,
    pub address: Address,
    pub lamports: u64,
    pub to: Address,
}

/// One planned transaction.
#[derive(Clone, Debug)]
pub struct EndStep {
    pub name: String,
    pub ixs: Vec<Instruction>,
    pub refunds: Vec<Refund>,
    /// Chain time it waits for (`None`: due now).
    pub not_before: Option<i64>,
    /// Why it cannot be sent (a precondition the chain does not meet).
    pub blocked: Option<String>,
}

/// What the chain holds for the season's end.
#[derive(Clone, Debug, Default)]
pub struct EndObserved {
    pub now: i64,
    /// Stored status (Closed for the tombstone).
    pub status: u8,
    pub tombstone: bool,
    pub authority: Address,
    pub genesis_ts: i64,
    pub end_bell: u32,
    pub program_version: u16,
    pub continuous: bool,
    pub season_lamports: u64,
    /// Rent of the 128-B tombstone (the cluster's).
    pub tombstone_rent: u64,
    pub frontier: Option<u64>,
    /// `(lamports, provinces_opened)` of each wedge fund.
    pub funds: [Option<(u64, u32)>; 6],
    pub dpool: Option<u64>,
    pub shards: Vec<Vec<Option<u64>>>,
    pub logs: Vec<Option<u64>>,
    /// Legacy Provinces `(address, p, q, lamports)`.
    pub provinces: Vec<(Address, i16, i16, u64)>,
    /// Wide provinces `(address, p, q, lamports)`.
    pub wide_provinces: Vec<(Address, i16, i16, u64)>,
    /// Province accounts of this season of neither size (never seen; blocks the final part).
    pub odd_provinces: usize,
    /// RingSeeds `(address, payer, lamports)`.
    pub ring_seeds: Vec<(Address, Address, u64)>,
    /// AnchorArchives `(address, rent_to, lamports)`.
    pub archives: Vec<(Address, Address, u64)>,
    /// DefenceClaims `(address, beneficiary, lamports)`.
    pub claims: Vec<(Address, Address, u64)>,
    /// Accounts left to others: kind → (count, lamports).
    pub others: BTreeMap<&'static str, (usize, u64)>,
}

impl EndObserved {
    pub fn end_ts(&self) -> i64 {
        self.genesis_ts + self.end_bell as i64 * BELL_SECS
    }
    pub fn close_at(&self) -> i64 {
        self.end_ts() + END_GRACE_SECS
    }
    pub fn bell(&self) -> Option<u32> {
        fclient::clock::bell_at(self.genesis_ts, self.now)
    }
    /// The effective status (Seeded with `now ≥ genesis_ts` is Running).
    pub fn effective(&self) -> u8 {
        use fclient::abi::status as st;
        if self.status == st::SEEDED && self.now >= self.genesis_ts {
            st::RUNNING
        } else {
            self.status
        }
    }
    pub fn opened_total(&self) -> u64 {
        self.funds.iter().map(|f| f.map_or(0, |x| x.1 as u64)).sum()
    }
}

pub fn status_name(s: u8) -> &'static str {
    use fclient::abi::status as st;
    match s {
        st::ANNOUNCED => "Announced",
        st::CREATED => "Created",
        st::SEEDED => "Seeded",
        st::RUNNING => "Running",
        st::ENDED => "Ended",
        st::CLOSED => "Closed",
        st::ABORTED => "Aborted",
        _ => "unknown",
    }
}

// ------------------------------------------------------------------ reading the chain

/// `getProgramAccounts` of the program's accounts of `magic` and this
/// season (both filtered by the node), optionally of one data size, with a
/// data slice: `(address, lamports, sliced bytes)`.
pub async fn program_accounts(
    chain: &Chain,
    program: &Address,
    season_id: u64,
    magic: &[u8; 8],
    size: Option<usize>,
    slice: (usize, usize),
) -> Result<Vec<(Address, u64, Vec<u8>)>, String> {
    use base64::Engine as _;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let mut filters = vec![
        json!({"memcmp": {"offset": 0, "bytes": b64(magic), "encoding": "base64"}}),
        json!({"memcmp": {"offset": 8, "bytes": b64(&season_id.to_le_bytes()), "encoding": "base64"}}),
    ];
    if let Some(n) = size {
        filters.push(json!({"dataSize": n}));
    }
    let v = chain
        .call(
            "getProgramAccounts",
            json!([program.to_string(), {"encoding": "base64", "commitment": "confirmed",
                "filters": filters, "dataSlice": {"offset": slice.0, "length": slice.1}}]),
        )
        .await?;
    let rows = v
        .as_array()
        .or_else(|| v.get("value").and_then(|x| x.as_array()))
        .ok_or("getProgramAccounts: not an array")?;
    let mut out = vec![];
    for r in rows {
        let k: Address = r["pubkey"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or("getProgramAccounts: pubkey")?;
        let lamports = r["account"]["lamports"]
            .as_u64()
            .ok_or("getProgramAccounts: lamports")?;
        let data = r["account"]["data"][0]
            .as_str()
            .map(|d| {
                base64::engine::general_purpose::STANDARD
                    .decode(d)
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        // A node that ignored dataSlice sent the whole data: slice it here.
        let data = if data.len() == slice.1 {
            data
        } else {
            data.get(slice.0..slice.0 + slice.1)
                .map(<[u8]>::to_vec)
                .unwrap_or_default()
        };
        if data.len() != slice.1 {
            return Err(format!("getProgramAccounts: {k} sent {} B", data.len()));
        }
        out.push((k, lamports, data));
    }
    out.sort_by_key(|x| x.0);
    Ok(out)
}

fn addr32(b: &[u8]) -> Address {
    Address::new_from_array(b[..32].try_into().expect("32 bytes"))
}

/// `observe`'s answer when the profile's season is not on the cluster (a wrong `seasonId` or program).
pub const NO_SEASON: &str =
    "the season does not exist on this cluster (check the profile's seasonId and programId): nothing to end";
/// `observe`'s answer when the season's address holds something else.
pub const NOT_A_SEASON: &str = "the Season address holds another kind of account";

/// Reads everything the plan needs.
pub async fn observe(chain: &Chain, a: &Addresses) -> Result<EndObserved, String> {
    use fclient::abi::magic;
    use fclient::abi::{FACTIONS, REGIONS, SHARDS_PER_FACTION};
    use frontier_abi::layout::world::season as S;
    let clock = timed(chain.port.clock())
        .await?
        .map_err(|e| format!("Clock: {e}"))?;
    let mut keys = vec![a.season, a.frontier()];
    keys.extend(a.province_funds());
    keys.push(a.defence_pool());
    for f in 0..FACTIONS {
        keys.extend((0..SHARDS_PER_FACTION).map(|s| a.join_shard(f, s)));
    }
    keys.extend((0..REGIONS).map(|r| a.beacon_log(r)));
    let got = chain.accounts(&keys).await?;
    for (k, g) in keys.iter().zip(&got) {
        if let Some(acc) = g {
            if acc.owner != a.program {
                return Err(format!(
                    "{k} is held by another owner ({}): refused",
                    acc.owner
                ));
            }
        }
    }
    let season = got[0].as_ref().ok_or(NO_SEASON)?;
    let d = &season.data;
    if d.len() < S::TOMBSTONE_SIZE || d[..8] != S::MAGIC {
        return Err(NOT_A_SEASON.into());
    }
    let tombstone = d.len() == S::TOMBSTONE_SIZE;
    let tombstone_rent = chain
        .call(
            "getMinimumBalanceForRentExemption",
            json!([S::TOMBSTONE_SIZE]),
        )
        .await?
        .as_u64()
        .ok_or("getMinimumBalanceForRentExemption: not a number")?;
    let mut o = EndObserved {
        now: clock.unix_timestamp,
        status: d[S::STATUS],
        tombstone,
        authority: addr32(&d[S::AUTHORITY..]),
        season_lamports: season.lamports,
        tombstone_rent,
        ..EndObserved::default()
    };
    if !tombstone {
        let s = fclient::decode::Season::decode(d).map_err(|e| format!("Season: {e:?}"))?;
        o.genesis_ts = s.genesis_ts;
        o.end_bell = s.end_bell;
        o.program_version = s.program_version;
        o.continuous = s.world_continues();
    }
    let lam = |i: usize| got[i].as_ref().map(|x| x.lamports);
    o.frontier = lam(1);
    for w in 0..6 {
        o.funds[w] = got[2 + w].as_ref().map(|x| {
            use frontier_abi::layout::world::province_fund as PF;
            let n = x
                .data
                .get(PF::PROVINCES_OPENED..PF::PROVINCES_OPENED + 4)
                .map_or(0, |b| u32::from_le_bytes(b.try_into().expect("4")));
            (x.lamports, n)
        });
    }
    o.dpool = lam(8);
    let mut i = 9;
    for _ in 0..FACTIONS {
        o.shards.push(
            (0..SHARDS_PER_FACTION)
                .map(|_| {
                    i += 1;
                    lam(i - 1)
                })
                .collect(),
        );
    }
    o.logs = (0..REGIONS)
        .map(|_| {
            i += 1;
            lam(i - 1)
        })
        .collect();
    let (p, sid) = (&a.program, a.season_id);
    // Provinces: legacy (the Province magic) and wide (the wide land's own header magic, `PSFXWPV1`; its prefix
    // keeps the Province layout, `P`/`Q` at 64).
    let pq = |b: &[u8]| {
        (
            i16::from_le_bytes([b[0], b[1]]),
            i16::from_le_bytes([b[2], b[3]]),
        )
    };
    o.provinces = program_accounts(chain, p, sid, magic::PROVINCE, None, (64, 4))
        .await?
        .iter()
        .map(|(k, l, b)| {
            let (pp, qq) = pq(b);
            (*k, pp, qq, *l)
        })
        .collect();
    #[cfg(feature = "playable-lane")]
    {
        use frontier_abi::world_index::land as wl;
        // (the prefix's P/Q are zero on a wide province: the coordinate is the trailer's, `WideProvince::read`)
        let m = wl::province::MAGIC;
        for (k, l, d) in program_accounts(chain, p, sid, &m, None, (0, wl::province::SIZE)).await? {
            let w = wl::WideProvince::read(&d).map_err(|e| format!("wide province {k}: {e:?}"))?;
            let (pp, qq) = (w.coord.p(), w.coord.q());
            let (pp, qq) = (
                i16::try_from(pp).map_err(|_| format!("wide province {k}: p {pp}"))?,
                i16::try_from(qq).map_err(|_| format!("wide province {k}: q {qq}"))?,
            );
            o.wide_provinces.push((k, pp, qq, l));
        }
    }
    {
        use frontier_abi::layout::world::ring_seed as RS;
        o.ring_seeds = program_accounts(chain, p, sid, magic::RING_SEED, None, (RS::PAYER, 32))
            .await?
            .into_iter()
            .map(|(k, l, b)| (k, addr32(&b), l))
            .collect();
    }
    {
        use frontier_abi::layout::beacon::anchor_archive as AA;
        o.archives = program_accounts(
            chain,
            p,
            sid,
            magic::ANCHOR_ARCHIVE,
            None,
            (AA::RENT_TO, 32),
        )
        .await?
        .into_iter()
        .map(|(k, l, b)| (k, addr32(&b), l))
        .collect();
    }
    {
        use frontier_abi::layout::beacon::defence_claim as DC;
        o.claims = program_accounts(
            chain,
            p,
            sid,
            magic::DEFENCE_CLAIM,
            None,
            (DC::BENEFICIARY, 32),
        )
        .await?
        .into_iter()
        .map(|(k, l, b)| (k, addr32(&b), l))
        .collect();
    }
    // What stays for others (counted, not closed here).
    let mut others = BTreeMap::new();
    let mut count = |name: &'static str, rows: &[(Address, u64, Vec<u8>)]| {
        if !rows.is_empty() {
            others.insert(name, (rows.len(), rows.iter().map(|r| r.1).sum()));
        }
    };
    count(
        "Citizen (players: CloseCitizen, anyone, rent to the player)",
        &program_accounts(chain, p, sid, magic::CITIZEN, None, (8, 8)).await?,
    );
    count(
        "Holding (players: CloseHolding, anyone, rent to its payer)",
        &program_accounts(chain, p, sid, magic::HOLDING, None, (8, 8)).await?,
    );
    for (name, m) in [
        ("ArrivalSlot (keeper A's close role)", magic::ARRIVAL_SLOT),
        ("ArrivalDay (keeper A's close role)", magic::ARRIVAL_DAY),
        ("ClashInputs (keeper A's close role)", magic::CLASH_INPUTS),
        ("SeedCache (keeper A's archive role)", magic::SEED_CACHE),
        ("BellAnchor (keeper A's archive role)", magic::BELL_ANCHOR),
    ] {
        count(
            name,
            &program_accounts(chain, p, sid, m, None, (8, 8)).await?,
        );
    }
    #[cfg(feature = "playable-lane")]
    {
        use frontier_abi::world_index as wi;
        for (name, m) in [
            (
                "wide ring seed (no close instruction: its rent stays, D-end-1)",
                &wi::land::ring_seed::MAGIC,
            ),
            (
                "wide holding (WideClose 1, anyone, rent to its payer)",
                &wi::holding::wide_holding::MAGIC,
            ),
            (
                "wide ticket (WideClose 0, anyone)",
                &wi::ticket::wide_ticket::MAGIC,
            ),
        ] {
            count(
                name,
                &program_accounts(chain, p, sid, m, None, (8, 8)).await?,
            );
        }
    }
    o.others = others;
    Ok(o)
}

// ------------------------------------------------------------------ the plan

/// The whole plan from what the chain holds now: the steps still to send,
/// in order, each with what it closes and who gets the lamports.
pub fn plan(o: &EndObserved, a: &Addresses, authority: Address) -> Vec<EndStep> {
    use fclient::abi::status as st;
    use fclient::abi::{FACTIONS, REGIONS, SHARDS_PER_FACTION};
    let mut out = vec![];
    let eff = o.effective();
    if o.status == st::ABORTED {
        // An aborted season closes at once; not this tool's path.
        return out;
    }
    let ended = o.status == st::ENDED || o.tombstone;
    if !ended {
        let due = o.bell().is_some_and(|b| b >= o.end_bell);
        out.push(EndStep {
            name: "EndSeason".into(),
            ixs: vec![ix::end_season(a, authority)],
            refunds: vec![],
            not_before: (!due).then(|| o.end_ts()),
            blocked: if o.continuous {
                Some("a continuous world never ends (ContinuousWorld)".into())
            } else if eff != st::RUNNING {
                Some(format!(
                    "the season is {} (EndSeason needs it Running)",
                    status_name(eff)
                ))
            } else {
                None
            },
        });
    }
    let close_at = if o.tombstone {
        None
    } else {
        Some(o.close_at())
    };
    let wait = close_at.filter(|t| !ended || o.now < *t);
    // Lamports landing in each wedge fund from the province closes.
    let mut into_fund = [0u64; 6];
    if !o.tombstone {
        for chunk in o.provinces.chunks(PROVINCES_PER_TX) {
            let mut ixs = vec![];
            let mut refunds = vec![];
            for &(k, p, q, l) in chunk {
                let w = fclient::ix::wedge_of(p as i32, q as i32);
                into_fund[w as usize] += l;
                ixs.push(ix::close_province(a, authority, p, q));
                refunds.push(Refund {
                    label: format!("Province {p},{q}"),
                    address: k,
                    lamports: l,
                    to: a.province_fund(w),
                });
            }
            out.push(EndStep {
                name: format!("CloseProvince x{}", ixs.len()),
                ixs,
                refunds,
                not_before: wait,
                blocked: None,
            });
        }
        for chunk in o.wide_provinces.chunks(WIDE_PROVINCES_PER_TX) {
            let mut ixs = vec![];
            let mut refunds = vec![];
            for &(k, p, q, l) in chunk {
                let w = fclient::ix::wedge_of(p as i32, q as i32);
                into_fund[w as usize] += l;
                match wide_close_province(a, authority, p, q, k) {
                    Ok(i) => ixs.push(i),
                    Err(e) => {
                        return vec![EndStep {
                            name: "WideClose(province)".into(),
                            ixs: vec![],
                            refunds: vec![],
                            not_before: None,
                            blocked: Some(e),
                        }]
                    }
                }
                refunds.push(Refund {
                    label: format!("wide Province {p},{q}"),
                    address: k,
                    lamports: l,
                    to: a.province_fund(w),
                });
            }
            out.push(EndStep {
                name: format!("WideClose(province) x{}", ixs.len()),
                ixs,
                refunds,
                not_before: wait,
                blocked: None,
            });
        }
    }
    // CloseSeason parts 0–5 (JoinShards) and 6 (BeaconLogs): also on the tombstone.
    for f in 0..FACTIONS {
        let have: Vec<(u8, u8, u64)> = (0..SHARDS_PER_FACTION)
            .filter_map(|s| o.shards[f as usize][s as usize].map(|l| (f, s, l)))
            .collect();
        if have.is_empty() {
            continue;
        }
        let all: Vec<(u8, u8)> = (0..SHARDS_PER_FACTION).map(|s| (f, s)).collect();
        out.push(EndStep {
            name: format!("CloseSeason part {f} (JoinShards of nation {f})"),
            ixs: vec![ix::close_season(a, authority, f, &all, &[])],
            refunds: have
                .iter()
                .map(|&(f, s, l)| Refund {
                    label: format!("JoinShard {f}/{s}"),
                    address: a.join_shard(f, s),
                    lamports: l,
                    to: authority,
                })
                .collect(),
            not_before: wait,
            blocked: None,
        });
    }
    if o.logs.iter().any(Option::is_some) {
        let all: Vec<u8> = (0..REGIONS).collect();
        out.push(EndStep {
            name: "CloseSeason part 6 (BeaconLogs)".into(),
            ixs: vec![ix::close_season(a, authority, 6, &[], &all)],
            refunds: (0..REGIONS)
                .filter_map(|r| {
                    o.logs[r as usize].map(|l| Refund {
                        label: format!("BeaconLog {r}"),
                        address: a.beacon_log(r),
                        lamports: l,
                        to: authority,
                    })
                })
                .collect(),
            not_before: wait,
            blocked: None,
        });
    }
    // Part 8: RingSeeds to their payers (from end + 72 h, or on the tombstone).
    let cap8 = frontier_abi::budgets::close_float_pairs_max(8).max(1);
    for chunk in o.ring_seeds.chunks(cap8) {
        let pairs: Vec<(Address, Address)> = chunk.iter().map(|x| (x.0, x.1)).collect();
        out.push(EndStep {
            name: format!("CloseSeason part 8 (RingSeeds x{})", pairs.len()),
            ixs: vec![ix::close_season_float(a, authority, 8, &pairs)],
            refunds: chunk
                .iter()
                .map(|&(k, payer, l)| Refund {
                    label: "RingSeed".into(),
                    address: k,
                    lamports: l,
                    to: payer,
                })
                .collect(),
            not_before: wait,
            blocked: None,
        });
    }
    // Part 7 (final): the Frontier, the six funds, the DefencePool, the Season → tombstone.
    if !o.tombstone {
        let mut refunds = vec![];
        if let Some(l) = o.frontier {
            refunds.push(Refund {
                label: "Frontier".into(),
                address: a.frontier(),
                lamports: l,
                to: authority,
            });
        }
        for w in 0..6u8 {
            if let Some((l, _)) = o.funds[w as usize] {
                refunds.push(Refund {
                    label: format!("ProvinceFund {w} (incl. its provinces' rent)"),
                    address: a.province_fund(w),
                    lamports: l + into_fund[w as usize],
                    to: authority,
                });
            }
        }
        if let Some(l) = o.dpool {
            refunds.push(Refund {
                label: "DefencePool (unclaimed defence pay included)".into(),
                address: a.defence_pool(),
                lamports: l,
                to: authority,
            });
        }
        refunds.push(Refund {
            label: "Season (above the 128-B tombstone's rent; the creation bond included)".into(),
            address: a.season,
            lamports: o.season_lamports.saturating_sub(o.tombstone_rent),
            to: authority,
        });
        let found = (o.provinces.len() + o.wide_provinces.len()) as u64;
        let blocked = if o.odd_provinces > 0 {
            Some(format!(
                "{} Province account(s) of an unknown size: not closable by this tool",
                o.odd_provinces
            ))
        } else if found != o.opened_total() {
            Some(format!(
                "the funds count {} opened provinces, the cluster listed {found}: the final part would be TooEarly{}",
                o.opened_total(),
                if cfg!(feature = "playable-lane") {
                    ""
                } else {
                    " (a playable-lane season's wide provinces are listed only by frontier-operator built with --features playable-lane)"
                }
            ))
        } else {
            None
        };
        out.push(EndStep {
            name: "CloseSeason part 7 (final: Frontier, ProvinceFunds, DefencePool, Season -> tombstone)"
                .into(),
            ixs: vec![ix::close_season(a, authority, 7, &[], &[])],
            refunds,
            not_before: wait,
            blocked,
        });
    }
    // Parts 9 and 10: only on the tombstone (after part 7).
    let cap9 = frontier_abi::budgets::close_float_pairs_max(9).max(1);
    for chunk in o.archives.chunks(cap9) {
        let pairs: Vec<(Address, Address)> = chunk.iter().map(|x| (x.0, x.1)).collect();
        out.push(EndStep {
            name: format!("CloseSeason part 9 (AnchorArchives x{})", pairs.len()),
            ixs: vec![ix::close_season_float(a, authority, 9, &pairs)],
            refunds: chunk
                .iter()
                .map(|&(k, to, l)| Refund {
                    label: "AnchorArchive".into(),
                    address: k,
                    lamports: l,
                    to,
                })
                .collect(),
            not_before: wait,
            blocked: None,
        });
    }
    let cap10 = frontier_abi::budgets::close_float_pairs_max(10).max(1);
    for chunk in o.claims.chunks(cap10) {
        let pairs: Vec<(Address, Address)> = chunk.iter().map(|x| (x.0, x.1)).collect();
        out.push(EndStep {
            name: format!("CloseSeason part 10 (DefenceClaims x{})", pairs.len()),
            ixs: vec![ix::close_season_float(a, authority, 10, &pairs)],
            refunds: chunk
                .iter()
                .map(|&(k, to, l)| Refund {
                    label: "DefenceClaim".into(),
                    address: k,
                    lamports: l,
                    to,
                })
                .collect(),
            not_before: wait,
            blocked: None,
        });
    }
    out
}

#[cfg(feature = "playable-lane")]
fn wide_close_province(
    a: &Addresses,
    any: Address,
    p: i16,
    q: i16,
    at: Address,
) -> Result<Instruction, String> {
    use fclient::AccountMeta;
    use frontier_abi::world_index::{coord::WideCoord, land as wl, wide_ix as wix};
    let coord = WideCoord::checked(p as i64, q as i64).map_err(|e| format!("{p},{q}: {e:?}"))?;
    let ctx = frontier_abi::addr::AddrCtx {
        program: a.program.to_bytes(),
        season: a.season.to_bytes(),
    };
    if Address::new_from_array(wl::province_address(&ctx, coord)) != at {
        return Err(format!("wide province {p},{q}: {at} is not its address"));
    }
    let wedge = coord.wedge().ok_or_else(|| format!("{p},{q}: no wedge"))?;
    Ok(Instruction {
        program_id: a.program,
        accounts: vec![
            AccountMeta::new_readonly(any, true),
            AccountMeta::new_readonly(a.season, false),
            AccountMeta::new(at, false),
            AccountMeta::new(a.province_fund(wedge), false),
        ],
        data: wix::Close {
            what: wix::CLOSE_WHAT_PROVINCE,
        }
        .to_bytes()
        .to_vec(),
    })
}

#[cfg(not(feature = "playable-lane"))]
fn wide_close_province(
    _: &Addresses,
    _: Address,
    p: i16,
    q: i16,
    _: Address,
) -> Result<Instruction, String> {
    Err(format!(
        "wide province {p},{q}: closing the wide land needs frontier-operator built with --features playable-lane"
    ))
}

/// Totals of a plan: fees, what the authority gets back, what goes to others.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EndTotals {
    pub txs: u64,
    pub fees: u64,
    pub to_authority: u64,
    /// Recipient → lamports (everyone but the authority; the wedge funds' share
    /// is counted again at the final part, so funds are left out here).
    pub to_others: BTreeMap<Address, u64>,
}

impl EndTotals {
    /// The authority's balance change if every step lands (refunds − fees).
    pub fn authority_net(&self) -> i128 {
        self.to_authority as i128 - self.fees as i128
    }
}

pub fn totals(steps: &[EndStep], a: &Addresses, authority: Address) -> EndTotals {
    let funds = a.province_funds();
    let mut t = EndTotals::default();
    for s in steps {
        t.txs += 1;
        t.fees += FEE_PER_SIGNATURE;
        for r in &s.refunds {
            if r.to == authority {
                t.to_authority += r.lamports;
            } else if !funds.contains(&r.to) {
                *t.to_others.entry(r.to).or_default() += r.lamports;
            }
        }
    }
    t
}

fn when(t: i64, now: i64) -> String {
    let d = t - now;
    if d <= 0 {
        format!("chain clock {t} (passed)")
    } else {
        format!(
            "chain clock {t} (in {} s = {:.1} h)",
            grouped(d as u64),
            d as f64 / 3_600.0
        )
    }
}

pub struct EndHeader<'a> {
    pub mode: &'a str,
    pub cluster: String,
    pub authority: Address,
}

/// The dry run's text.
pub fn render(h: &EndHeader, a: &Addresses, o: &EndObserved, steps: &[EndStep]) -> String {
    use std::fmt::Write;
    let mut s = String::new();
    let _ = writeln!(s, "frontier-operator end-season: plan ({})", h.mode);
    let _ = writeln!(s, "cluster    {}", h.cluster);
    let _ = writeln!(s, "program    {}", a.program);
    let _ = writeln!(
        s,
        "authority  {} (the Season's stored authority: {})",
        h.authority, o.authority
    );
    let _ = writeln!(
        s,
        "season     id {}  {}  status {}{}",
        a.season_id,
        a.season,
        status_name(o.effective()),
        if o.tombstone {
            " (128-B tombstone)"
        } else {
            ""
        }
    );
    if !o.tombstone {
        let _ = writeln!(
            s,
            "bells      now {}  end_bell {}  end {}",
            o.bell().map_or("-".into(), |b| grouped(b as u64)),
            grouped(o.end_bell as u64),
            when(o.end_ts(), o.now)
        );
        let _ = writeln!(
            s,
            "closes     from end + 72 h = {} (CloseProvince, CloseSeason; TooEarly before)",
            when(o.close_at(), o.now)
        );
    }
    let _ = writeln!(
        s,
        "found      {} legacy + {} wide provinces (funds count {} opened), {} ring seeds, {} anchor archives, {} defence claims",
        o.provinces.len(),
        o.wide_provinces.len(),
        o.opened_total(),
        o.ring_seeds.len(),
        o.archives.len(),
        o.claims.len()
    );
    for st in steps {
        let total: u64 = st.refunds.iter().map(|r| r.lamports).sum();
        let _ = writeln!(
            s,
            "\ntx {}  fee {}  closes {} account(s), {} lamports{}{}",
            st.name,
            grouped(FEE_PER_SIGNATURE),
            st.refunds.len(),
            grouped(total),
            st.not_before
                .map(|t| format!("  waits for {}", when(t, o.now)))
                .unwrap_or_default(),
            st.blocked
                .as_ref()
                .map(|b| format!("  BLOCKED: {b}"))
                .unwrap_or_default()
        );
        let mut by_to: BTreeMap<Address, (usize, u64)> = BTreeMap::new();
        for r in &st.refunds {
            let e = by_to.entry(r.to).or_default();
            e.0 += 1;
            e.1 += r.lamports;
        }
        for (to, (n, l)) in by_to {
            let who = if to == h.authority {
                "authority".to_string()
            } else if let Some(w) = a.province_funds().iter().position(|f| *f == to) {
                format!("ProvinceFund {w}")
            } else {
                to.to_string()
            };
            let _ = writeln!(s, "   -> {who}: {n} account(s), {} lamports", grouped(l));
        }
        if st.refunds.len() <= 12 {
            for r in &st.refunds {
                let _ = writeln!(s, "      {} {} {}", r.label, r.address, grouped(r.lamports));
            }
        }
    }
    let t = totals(steps, a, h.authority);
    let _ = writeln!(s);
    let _ = writeln!(
        s,
        "total      {} transaction(s), fees {} lamports; back to the authority {} lamports ({} SOL); net {} lamports",
        t.txs,
        grouped(t.fees),
        grouped(t.to_authority),
        sol(t.to_authority),
        t.authority_net()
    );
    for (to, l) in &t.to_others {
        let _ = writeln!(s, "to others  {to}: {} lamports", grouped(*l));
    }
    if !o.others.is_empty() {
        let _ = writeln!(s, "not closed by this tool (they stay for their owners):");
        for (k, (n, l)) in &o.others {
            let _ = writeln!(s, "   {k}: {n} account(s), {} lamports", grouped(*l));
        }
    }
    for w in keeper_float_warnings(o) {
        let _ = writeln!(s, "WARNING    {w}");
    }
    s
}

/// (verify-pr180) Keeper A's floats still open before the final part: a BellAnchor never closes after it
/// (ArchiveAnchors needs the season Running or Ended), and keeper A stops every duty on the tombstone, so its
/// ArrivalSlot / ArrivalDay / ClashInputs / SeedCache floats (closable on the tombstone by anyone) have no sender
/// after it. Let keeper A drain them first (its `close` / `archive` roles; from end + 72 h the season-end fallback
/// lets every march record close), then send the final part.
pub fn keeper_float_warnings(o: &EndObserved) -> Vec<String> {
    if o.tombstone {
        return vec![];
    }
    let mut out = vec![];
    let get = |p: &str| {
        o.others
            .iter()
            .filter(|(k, _)| k.starts_with(p))
            .map(|(_, v)| *v)
            .fold((0usize, 0u64), |a, v| (a.0 + v.0, a.1 + v.1))
    };
    let (n, l) = get("BellAnchor");
    if n > 0 {
        out.push(format!(
            "{n} BellAnchor(s) ({} lamports) are not archived yet: after CloseSeason part 7 they can NEVER close \
             (ArchiveAnchors needs the season Running or Ended). Let keeper A's archive role archive them first",
            grouped(l)
        ));
    }
    let mut floats = (0usize, 0u64);
    for p in ["ArrivalSlot", "ArrivalDay", "ClashInputs", "SeedCache"] {
        let (n, l) = get(p);
        floats = (floats.0 + n, floats.1 + l);
    }
    if floats.0 > 0 {
        out.push(format!(
            "{} keeper float(s) ({} lamports: ArrivalSlot / ArrivalDay / ClashInputs / SeedCache) are still open: \
             keeper A stops every duty on the tombstone, so let its close / archive roles drain them before the \
             final part (re-run this dry run until the line stops shrinking); after it they close only by hand",
            floats.0,
            grouped(floats.1)
        ));
    }
    out
}

// ------------------------------------------------------------------ command line

pub const USAGE: &str =
    "usage: frontier-operator end-season --profile FILE [--rpc URL] [--authority KEYFILE]
                         [--yes-send [--i-have-r0ze-approval --approved-sha256 HEX]]
                         [--max-txs N] [--record FILE]

  Dry run by default: reads the cluster and prints the end-of-season plan:
  EndSeason (from the end bell), then from end + 72 h every CloseProvince /
  wide province close and CloseSeason parts 0-10, each with the accounts it
  closes, their lamports now and who gets them, and the totals.
  --yes-send sends what is due, signed by the --authority key file (the
  Season's stored authority). On devnet a send also needs
  --i-have-r0ze-approval and --approved-sha256 (the deployed program's sha256).
  Exit: 0 done / plan printed, 1 failed, 2 refused, 3 not due yet (before the
  end bell, or before end + 72 h): run the same command again later.";

#[derive(Clone, Debug, Default)]
pub struct EndOpts {
    pub profile: String,
    pub authority: Option<String>,
    pub cluster_url: Option<String>,
    pub yes_send: bool,
    pub approval: bool,
    pub approved_sha256: Option<String>,
    pub max_txs: Option<usize>,
    pub record: Option<String>,
}

pub fn parse_args(args: &[String]) -> Result<EndOpts, String> {
    let mut o = EndOpts::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--profile" => o.profile = val("--profile")?,
            "--authority" => o.authority = Some(val("--authority")?),
            "--cluster-url" | "--rpc" => o.cluster_url = Some(val("--rpc")?),
            "--yes-send" => o.yes_send = true,
            x if x == APPROVAL_FLAG => o.approval = true,
            "--approved-sha256" => {
                let h = val("--approved-sha256")?.to_ascii_lowercase();
                if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("--approved-sha256 HEX (64 hex digits)".into());
                }
                o.approved_sha256 = Some(h)
            }
            "--max-txs" => {
                o.max_txs = Some(
                    val("--max-txs")?
                        .parse()
                        .map_err(|_| "--max-txs N (a number)")?,
                )
            }
            "--record" => o.record = Some(val("--record")?),
            "-h" | "--help" => return Err(USAGE.into()),
            x => return Err(format!("unknown argument {x}\n{USAGE}")),
        }
    }
    if o.profile.is_empty() {
        return Err(format!("--profile is required\n{USAGE}"));
    }
    if o.yes_send && o.authority.is_none() {
        return Err("--yes-send needs --authority KEYFILE".into());
    }
    if (o.approval || o.approved_sha256.is_some()) && !o.yes_send {
        return Err(format!(
            "{APPROVAL_FLAG} / --approved-sha256 belong to a send: add --yes-send (or drop them for a dry run)"
        ));
    }
    Ok(o)
}

type Fail = (i32, String);

fn refused(e: impl Into<String>) -> Fail {
    (EXIT_REFUSED, e.into())
}

/// `frontier-operator end-season …`; returns the exit code.
pub async fn main_with(
    args: &[String],
    out: &mut dyn FnMut(&str),
    err: &mut dyn FnMut(&str),
) -> i32 {
    let o = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            err(&e);
            return EXIT_REFUSED;
        }
    };
    match run(&o, out, err).await {
        Ok(c) => c,
        Err((c, e)) => {
            err(&format!("frontier-operator end-season: {e}"));
            c
        }
    }
}

async fn run(
    o: &EndOpts,
    out: &mut dyn FnMut(&str),
    err: &mut dyn FnMut(&str),
) -> Result<i32, Fail> {
    let text =
        std::fs::read_to_string(&o.profile).map_err(|e| refused(format!("{}: {e}", o.profile)))?;
    let profile = parse_profile(&text).map_err(refused)?;
    let url = o
        .cluster_url
        .clone()
        .unwrap_or_else(|| profile.rpc_url.clone());
    let ep = check_url(&url, &profile).map_err(refused)?;
    if profile.beacon == BeaconChoice::TestKey && ep == Endpoint::Public {
        return Err(refused(
            "operator.beacon test-key is for loopback test chains only (I-53)",
        ));
    }
    // The setup's gate, on the same flags.
    let gate_opts = Opts {
        profile: o.profile.clone(),
        yes_send: o.yes_send,
        approval: o.approval,
        approved_sha256: o.approved_sha256.clone(),
        ..Opts::default()
    };
    if o.yes_send {
        let closed = gate_flags(&gate_opts, ep);
        if !closed.is_empty() {
            return Err(refused(format!(
                "SEND GATE: CLOSED\n  - {}\n(nothing was read or sent; without --yes-send this is a dry run)",
                closed.join("\n  - ")
            )));
        }
    }
    let key = match &o.authority {
        Some(p) => Some(load_authority(Path::new(p)).map_err(refused)?),
        None => None,
    };
    let authority =
        match (&key, profile.upgrade_authority) {
            (Some(k), _) => k.pubkey(),
            (None, Some(u)) => u,
            (None, None) => return Err(refused(
                "no authority: give --authority KEYFILE or fill upgradeAuthority in the profile",
            )),
        };
    let program = profile.program.ok_or_else(|| {
        refused("programId is still a placeholder: fill it in after r0ze's deploy")
    })?;
    let a = Addresses::new(program, profile.season_id);
    let chain = Chain::public(&url, program);
    let genesis = chain
        .call("getGenesisHash", json!([]))
        .await
        .map_err(|e| (EXIT_FAILED, format!("{}: {e}", redact(&url))))?;
    let genesis = genesis.as_str().unwrap_or("").to_string();
    check_genesis(&genesis, ep).map_err(refused)?;
    let ep = if genesis == DEVNET_GENESIS {
        Endpoint::Public
    } else {
        ep
    };
    if o.yes_send {
        let closed = gate_flags(&gate_opts, ep);
        if !closed.is_empty() {
            return Err(refused(format!(
                "SEND GATE: CLOSED (genesis {genesis} is devnet's)\n  - {}\n(nothing was sent)",
                closed.join("\n  - ")
            )));
        }
    }
    let (_, info) = op::check_program(&chain, &a, authority, &profile).await;
    // (verify-pr180) a wrong `seasonId` / program in the profile is a refusal, not a failure: nothing to end there
    let obs = observe(&chain, &a).await.map_err(|e| {
        let wrong = e.starts_with(NO_SEASON) || e.starts_with(NOT_A_SEASON);
        (if wrong { EXIT_REFUSED } else { EXIT_FAILED }, e)
    })?;
    let steps = plan(&obs, &a, authority);
    let balance = chain
        .balance(&authority)
        .await
        .map_err(|e| (EXIT_FAILED, e))?;
    let h = EndHeader {
        mode: if o.yes_send {
            "SEND (--yes-send)"
        } else {
            "DRY RUN: nothing is sent without --yes-send"
        },
        cluster: format!(
            "{} {} (genesis {genesis}, chain clock {})",
            profile.cluster,
            redact(&url),
            obs.now
        ),
        authority,
    };
    out(&render(&h, &a, &obs, &steps));
    let t = totals(&steps, &a, authority);
    out(&format!(
        "balance    {} lamports ({} SOL){}",
        grouped(balance),
        sol(balance),
        if balance < t.fees {
            format!(": SHORT by {} lamports of fees", grouped(t.fees - balance))
        } else {
            String::new()
        }
    ));
    if let Some(hh) = &info.sha256 {
        out(&format!("program    sha256 {hh}"));
    }
    let mut closed = gate_flags(&gate_opts, ep);
    closed.extend(gate_program(&gate_opts, ep, &info));
    if authority != obs.authority {
        closed.push(format!(
            "the key {authority} is not the Season's stored authority {}: CloseSeason would be refused (Auth)",
            obs.authority
        ));
    }
    if balance < FEE_PER_SIGNATURE {
        closed.push("the authority cannot pay one fee: fund it first".into());
    }
    if steps.is_empty() {
        out("end-season complete: nothing to send");
        return Ok(EXIT_OK);
    }
    if closed.is_empty() {
        out("SEND GATE: OPEN");
    } else {
        out(&format!("SEND GATE: CLOSED\n  - {}", closed.join("\n  - ")));
    }
    if !o.yes_send {
        out(&format!(
            "DRY RUN: nothing sent. Add --yes-send (with --authority{}) to send what is due.",
            if ep == Endpoint::Public {
                format!(", {APPROVAL_FLAG} and --approved-sha256")
            } else {
                String::new()
            }
        ));
        return Ok(EXIT_OK);
    }
    if !closed.is_empty() {
        return Err(refused(format!("SEND GATE: CLOSED: {}", closed.join("; "))));
    }
    let key = key.expect("--yes-send has --authority");
    let loaded_limit =
        if obs.program_version == op::S1_VERSION || obs.program_version == 0 && !obs.tombstone {
            crate::chain::OP_LOADED_LIMIT
        } else {
            crate::chain::MAX_LOADED_LIMIT
        };
    let mut landed: Vec<Landed> = vec![];
    let r = execute(
        &chain,
        &a,
        &key,
        o.max_txs,
        loaded_limit,
        &mut |l| err(l),
        &mut landed,
    )
    .await;
    for l in &landed {
        out(&l.line());
    }
    if let Some(path) = &o.record {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| (EXIT_FAILED, format!("--record {path}: {e}")))?;
        for l in &landed {
            let mut v = l.json();
            v["season_id"] = json!(a.season_id);
            v["command"] = json!("end-season");
            writeln!(f, "{v}").map_err(|e| (EXIT_FAILED, format!("--record {path}: {e}")))?;
        }
    }
    match r {
        Ok(EndOutcome::Complete) => {
            out(&format!(
                "end-season complete: {} transaction(s) sent",
                landed.len()
            ));
            Ok(EXIT_OK)
        }
        Ok(EndOutcome::Waiting { name, at, now }) => {
            out(&format!(
                "end-season waiting: {name} is not due before {} ({} transaction(s) sent now); run the same command again then",
                when(at, now),
                landed.len()
            ));
            Ok(EXIT_WAITING)
        }
        Ok(EndOutcome::Stopped) => {
            out(&format!(
                "end-season stopped after --max-txs {} transaction(s); run it again to continue",
                landed.len()
            ));
            Ok(EXIT_OK)
        }
        Ok(EndOutcome::Blocked { name, why }) => Err(refused(format!(
            "{name} cannot be sent: {why} ({} transaction(s) sent before it)",
            landed.len()
        ))),
        Err(e) => Err((EXIT_FAILED, e)),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EndOutcome {
    Complete,
    Waiting { name: String, at: i64, now: i64 },
    Blocked { name: String, why: String },
    Stopped,
}

/// Sends what is due, one transaction at a time, re-reading the chain and
/// re-planning before each (so a concurrent or earlier run is never repeated).
pub async fn execute(
    chain: &Chain,
    a: &Addresses,
    authority: &Keypair,
    max_txs: Option<usize>,
    loaded_limit: u32,
    log: &mut dyn FnMut(&str),
    landed: &mut Vec<Landed>,
) -> Result<EndOutcome, String> {
    let mut sent = 0usize;
    loop {
        let obs = observe(chain, a).await?;
        let steps = plan(&obs, a, authority.pubkey());
        let Some(next) = steps.first() else {
            return Ok(EndOutcome::Complete);
        };
        if let Some(why) = &next.blocked {
            return Ok(EndOutcome::Blocked {
                name: next.name.clone(),
                why: why.clone(),
            });
        }
        if let Some(t) = next.not_before.filter(|t| obs.now < *t) {
            return Ok(EndOutcome::Waiting {
                name: next.name.clone(),
                at: t,
                now: obs.now,
            });
        }
        if max_txs.is_some_and(|m| sent >= m) {
            return Ok(EndOutcome::Stopped);
        }
        let name = next.name.clone();
        log(&format!("sending {name}"));
        let sig = chain
            .send_op_with(&next.ixs, &[authority], LAND_LIMIT, loaded_limit)
            .await
            .map_err(|e| {
                format!("{name}: {e}\n(re-run to resume: the tool re-reads the chain and sends only what is missing)")
            })?;
        sent += 1;
        let l = op::landed(chain, &name, &sig.to_string()).await;
        log(&format!("{name}: finalized"));
        landed.push(l);
        // A public node may answer the next read from a slot before this one.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// The plan as JSON (the test's evidence and `--record`'s neighbour).
pub fn plan_json(o: &EndObserved, a: &Addresses, steps: &[EndStep], authority: Address) -> Value {
    let t = totals(steps, a, authority);
    json!({
        "status": status_name(o.effective()), "tombstone": o.tombstone, "now": o.now,
        "end_bell": o.end_bell, "end_ts": o.end_ts(), "close_at": o.close_at(),
        "provinces": o.provinces.len(), "wide_provinces": o.wide_provinces.len(),
        "ring_seeds": o.ring_seeds.len(), "archives": o.archives.len(), "claims": o.claims.len(),
        "steps": steps.iter().map(|s| json!({"name": s.name, "accounts": s.refunds.len(),
            "lamports": s.refunds.iter().map(|r| r.lamports).sum::<u64>(),
            "not_before": s.not_before, "blocked": s.blocked})).collect::<Vec<_>>(),
        "txs": t.txs, "fees": t.fees, "to_authority": t.to_authority,
        "authority_net": t.authority_net().to_string(),
        "to_others": t.to_others.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<_, _>>(),
        "not_closed": o.others.iter().map(|(k, (n, l))| (k.to_string(), json!({"count": n, "lamports": l}))).collect::<serde_json::Map<_, _>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fclient::abi::status as st;

    fn obs(status: u8, now: i64) -> (EndObserved, Addresses, Address) {
        let program = Address::new_from_array([7; 32]);
        let a = Addresses::new(program, 1);
        let auth = Address::new_from_array([9; 32]);
        let mut o = EndObserved {
            now,
            status,
            authority: auth,
            genesis_ts: 1_000_000,
            end_bell: 1_008,
            program_version: 0x4804,
            season_lamports: 1_000_000_000 + 11_000_000,
            tombstone_rent: 1_300_480,
            frontier: Some(3_251_200),
            funds: [Some((6_000_000_000, 1)); 6],
            dpool: Some(20_000_000_000),
            shards: vec![vec![Some(1_950_720); 8]; 6],
            logs: vec![Some(1_300_480); 16],
            ..EndObserved::default()
        };
        for w in 0..6u8 {
            // one legacy province per wedge, on ring 1
            let (p, q) = [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)][w as usize];
            let wedge = fclient::ix::wedge_of(p, q);
            o.funds[wedge as usize] = Some((6_000_000_000, 1));
            o.provinces
                .push((a.province(p, q), p as i16, q as i16, 24_709_120));
        }
        o.ring_seeds = vec![(a.ring_seed(0), Address::new_from_array([3; 32]), 1_300_480)];
        (o, a, auth)
    }

    #[test]
    fn before_the_end_bell_endseason_waits_and_nothing_else_is_due() {
        let (o, a, auth) = obs(st::SEEDED, 1_000_000 + 1_007 * 600);
        let p = plan(&o, &a, auth);
        assert_eq!(p[0].name, "EndSeason");
        assert_eq!(p[0].not_before, Some(o.end_ts()));
        assert!(p[0].blocked.is_none());
        // every close waits for end + 72 h
        assert!(p[1..].iter().all(|s| s.not_before == Some(o.close_at())));
    }

    #[test]
    fn at_the_end_bell_endseason_is_due_and_the_closes_wait_72_hours() {
        let (o, a, auth) = obs(st::SEEDED, 1_000_000 + 1_008 * 600);
        let p = plan(&o, &a, auth);
        assert_eq!((p[0].name.as_str(), p[0].not_before), ("EndSeason", None));
        assert_eq!(p[1].not_before, Some(1_000_000 + 1_008 * 600 + 72 * 3_600));
        let (o2, _, _) = obs(st::ENDED, o.close_at() - 1);
        let p2 = plan(&o2, &a, auth);
        assert!(p2.iter().all(|s| s.name != "EndSeason"));
        assert!(p2.iter().all(|s| s.not_before == Some(o2.close_at())));
    }

    #[test]
    fn after_the_grace_every_close_is_due_and_the_refunds_add_up() {
        let (o, a, auth) = obs(st::ENDED, 1_000_000 + 1_008 * 600 + 72 * 3_600);
        let p = plan(&o, &a, auth);
        assert!(p
            .iter()
            .all(|s| s.not_before.is_none() && s.blocked.is_none()));
        let names: Vec<&str> = p.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names[0], "CloseProvince x6");
        assert!(
            names
                .iter()
                .position(|n| n.starts_with("CloseSeason part 8"))
                < names
                    .iter()
                    .position(|n| n.starts_with("CloseSeason part 7"))
        );
        let t = totals(&p, &a, auth);
        // 1 + 6 + 1 + 1 + 1 transactions: provinces, six shard parts, logs, ring seeds, final
        assert_eq!(t.txs, 10);
        let want = 3_251_200
            + 6 * (6_000_000_000 + 24_709_120)
            + 20_000_000_000
            + (1_011_000_000 - 1_300_480)
            + 48 * 1_950_720
            + 16 * 1_300_480;
        assert_eq!(t.to_authority, want);
        assert_eq!(t.authority_net(), want as i128 - 10 * 5_000);
        assert_eq!(
            t.to_others.get(&Address::new_from_array([3; 32])),
            Some(&1_300_480)
        );
    }

    #[test]
    fn the_final_part_is_blocked_when_the_funds_count_provinces_the_cluster_did_not_list() {
        let (mut o, a, auth) = obs(st::ENDED, 2_000_000_000);
        o.provinces.pop();
        let p = plan(&o, &a, auth);
        let fin = p
            .iter()
            .find(|s| s.name.starts_with("CloseSeason part 7"))
            .unwrap();
        assert!(fin
            .blocked
            .as_ref()
            .unwrap()
            .contains("the funds count 6 opened provinces, the cluster listed 5"));
    }

    #[test]
    fn a_continuous_world_or_a_season_not_running_cannot_end() {
        let (mut o, a, auth) = obs(st::SEEDED, 2_000_000_000);
        o.continuous = true;
        assert!(plan(&o, &a, auth)[0]
            .blocked
            .as_ref()
            .unwrap()
            .contains("continuous"));
        let (o, a, auth) = obs(st::CREATED, 2_000_000_000);
        assert!(plan(&o, &a, auth)[0]
            .blocked
            .as_ref()
            .unwrap()
            .contains("Created"));
    }

    #[test]
    fn on_the_tombstone_only_the_float_parts_and_leftover_shards_remain() {
        let (mut o, a, auth) = obs(st::CLOSED, 2_000_000_000);
        o.tombstone = true;
        o.provinces.clear();
        o.funds = [None; 6];
        o.frontier = None;
        o.dpool = None;
        o.shards = vec![vec![None; 8]; 6];
        o.logs = vec![None; 16];
        o.ring_seeds.clear();
        o.archives = vec![
            (
                Address::new_from_array([4; 32]),
                Address::new_from_array([5; 32]),
                10,
            ),
            (
                Address::new_from_array([6; 32]),
                Address::new_from_array([5; 32]),
                20,
            ),
            (
                Address::new_from_array([8; 32]),
                Address::new_from_array([5; 32]),
                30,
            ),
        ];
        let p = plan(&o, &a, auth);
        let names: Vec<&str> = p.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "CloseSeason part 9 (AnchorArchives x2)",
                "CloseSeason part 9 (AnchorArchives x1)"
            ]
        );
        assert!(p.iter().all(|s| s.not_before.is_none()));
        let (mut done, _, _) = obs(st::CLOSED, 2_000_000_000);
        done.tombstone = true;
        done.provinces.clear();
        done.ring_seeds.clear();
        done.shards = vec![vec![None; 8]; 6];
        done.logs = vec![None; 16];
        assert!(plan(&done, &a, auth).is_empty(), "nothing left: complete");
    }

    #[test]
    fn keeper_floats_left_before_the_final_part_are_warned_about() {
        let (mut o, _, _) = obs(st::ENDED, 2_000_000_000);
        assert!(keeper_float_warnings(&o).is_empty());
        o.others
            .insert("BellAnchor (keeper A's archive role)", (2, 3_000_000));
        o.others
            .insert("ClashInputs (keeper A's close role)", (1, 5_000_000));
        o.others
            .insert("SeedCache (keeper A's archive role)", (1, 1_000_000));
        o.others.insert(
            "Citizen (players: CloseCitizen, anyone, rent to the player)",
            (9, 9),
        );
        let w = keeper_float_warnings(&o);
        assert_eq!(w.len(), 2, "{w:?}");
        assert!(
            w[0].starts_with("2 BellAnchor(s) (3,000,000 lamports)"),
            "{}",
            w[0]
        );
        assert!(
            w[1].starts_with("2 keeper float(s) (6,000,000 lamports"),
            "{}",
            w[1]
        );
        o.tombstone = true;
        assert!(
            keeper_float_warnings(&o).is_empty(),
            "too late to warn on the tombstone"
        );
    }

    #[test]
    fn the_send_flags_belong_together() {
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(parse_args(&v(&["--profile", "p", "--yes-send"]))
            .unwrap_err()
            .contains("--authority"));
        assert!(parse_args(&v(&["--profile", "p", APPROVAL_FLAG]))
            .unwrap_err()
            .contains("add --yes-send"));
        assert!(parse_args(&v(&["--profile", "p", "--offline"]))
            .unwrap_err()
            .contains("unknown argument"));
        assert!(parse_args(&v(&["--profile", "p"])).is_ok());
    }
}
