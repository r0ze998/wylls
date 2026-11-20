//! Wide claims (devnet runbook gap P7; the playable lane 0x4804, feature
//! `playable-lane`). Role `wide-tickets`, class D: the production form of
//! the local runner's `run_claims` duty (`itest::wide_play`), with the same
//! instructions ([`crate::widelane`]).
//!
//! - **WideSettleTicket (0xDC, k 0)** of every open wide ticket (a 0xD9
//!   WideClaimSite filed by a player, from a rim or any other anchor
//!   village) whose bell has ended and whose `S(bell, region)` is on chain
//!   (the `beacon` role's anchor and seed cache, found by the same
//!   [`SeedFinder`] the legacy `tickets` role uses), or which has expired
//!   (`now_bell ≥ bell + 24`: settled `expired`, no seed read). Per wide
//!   site, the oldest cohort first and then the lottery order (score
//!   `wide_ticket_score(seed, coord, site, citizen_tag)` descending, then
//!   the lower tag), one in flight per site: an honest cohort settles with
//!   no displacement and the others end `taken`. A ticket that beats a
//!   provisional holding of its own cohort that someone settled out of
//!   order is sent in the 13-account displacing form (the holder's
//!   `RENT_PAYER`, Citizen and JoinShard read from the chain).
//! - **WideFinalize (0xDF)** of every provisional wide village this role
//!   has seen a ticket for, once the program's own rule holds on the bytes
//!   just read: `frontier_abi::prologue::finality_due` (`now ≥ final_ts`
//!   and the ticket's cohort closed on the province), the very function
//!   the handler calls (`proc/wide.rs wide_finality_due`). So the write is
//!   "simulated" before it is planned, without an RPC simulation, and a
//!   `TooEarly` is never paid for.
//!
//! **Discovery.** A wide ticket emits no PS2 record (no `TICKET`/`SETTLE`
//! kind is allocated for the wide site key), and `ChainPort` has no
//! program-account scan. The record's address is the Citizen's
//! (`ticket_address(citizen)`), and the feed index knows every Citizen
//! (`JOIN` / `RESIDENT_JOINED`), so every `wide_scan_slots` (default 25)
//! the role reads the known Citizens' records (one `getMultipleAccounts` per
//! 100), then the provinces, Citizens and holdings it needs. The record is
//! kept `Settled` with its coordinate and site until the season-end close,
//! so a restarted keeper finds the provisional villages again, except one
//! whose Citizen has filed a NEWER claim since (its record now names the
//! new site): the claim itself flips the previous anchor final when due
//! (`claim_site`'s `flip_prev`), and anyone may still send WideFinalize.
//!
//! **Who pays.** The class-D pool payer pays the fees only: the wide
//! village's rent comes out of the ticket's escrow (paid by the claimer at
//! 0xD9), and WideFinalize moves no lamport.
//!
//! **A keeper that is down.** Nothing is lost on chain but time: a ticket
//! settles whenever any payer sends 0xDC (permissionless); after 24 bells
//! (4 h) it settles `expired`: no village, the claimer's escrow stays in the
//! record until the season-end close returns it to its funder (the deployed
//! `TICKET_ESCROW` retention). A village not finalized stays provisional
//! (still the claimer's; displaceable only within its own cohort, which is
//! closed by then).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use solana_address::Address;

use fclient::abi::{status, Class};
use fclient::addr::citizen_tag_u64;
use fclient::ix::SeedSource;
use fclient::land::beats;
use fclient::ports::{Account, ChainPort, PortResult};
use frontier_abi::layout::player::{citizen as C, holding as H};
use frontier_abi::layout::province::province::COHORT_BELLS;
use frontier_abi::prologue::{finality_due, HoldingHdr};
use frontier_abi::world_index::holding as wh;
use frontier_abi::world_index::land::{self as wl, WideProvince};
use frontier_abi::world_index::ticket::{self as wt, TicketStatus, WideTicket};
use frontier_abi::world_index::wide_ix::WideIx;
use frontier_abi::world_index::WideCoord;

use crate::beacon::AnchorInfo;
use crate::engine::{BuildCtx, Engine, Outcome, WriteSpec};
use crate::landindex::LandIndex;
use crate::seeds::SeedFinder;
use crate::widelane::{self, Displaced};
use crate::Tick;

pub fn settle_key(citizen: &Address, bell: u32) -> String {
    format!("wide-settle:{citizen}:{bell}")
}
pub fn finalize_key(p: i64, q: i64, site: u8) -> String {
    format!("wide-final:{p},{q}:{site}")
}

/// A wide site `(P, Q, site)`.
pub type WideSite = (i64, i64, u8);

/// One open wide ticket ready to settle this scan.
#[derive(Clone, Debug)]
pub struct WideCandidate {
    pub rec: WideTicket,
    pub faction: u8,
    pub shard: u8,
    pub tag: u64,
    pub region: u8,
    pub score: u64,
    pub src: SeedSource,
    pub expired: bool,
}

/// Per wide site: the oldest cohort first, then the lottery order (score
/// descending, the lower tag). The same order as the legacy
/// [`crate::tickets::settle_order`].
pub fn settle_order(v: &mut [WideCandidate]) {
    v.sort_by(|a, b| {
        a.rec
            .bell
            .cmp(&b.rec.bell)
            .then(b.score.cmp(&a.score))
            .then(a.tag.cmp(&b.tag))
    });
}

/// The candidates to plan now, one per site (all the expired ones go: an
/// expired settlement reads no site).
pub fn pick(mut cands: Vec<WideCandidate>) -> Vec<WideCandidate> {
    let mut by_site: BTreeMap<WideSite, Vec<WideCandidate>> = BTreeMap::new();
    let mut out = vec![];
    for c in cands.drain(..) {
        if c.expired {
            out.push(c);
        } else {
            by_site
                .entry((c.rec.coord.p(), c.rec.coord.q(), c.rec.site))
                .or_default()
                .push(c);
        }
    }
    for (_, mut v) in by_site {
        settle_order(&mut v);
        out.push(v.swap_remove(0));
    }
    out
}

/// The holding header the program's finality rule reads (wide holdings
/// keep the legacy Holding offsets).
pub fn holding_hdr(d: &[u8]) -> Option<HoldingHdr> {
    let u32_at = |o: usize| Some(u32::from_le_bytes(d.get(o..o + 4)?.try_into().ok()?));
    let i64_at = |o: usize| Some(i64::from_le_bytes(d.get(o..o + 8)?.try_into().ok()?));
    Some(HoldingHdr {
        p: 0,
        q: 0,
        site: *d.get(H::SITE)?,
        gen: *d.get(H::GEN)?,
        state: *d.get(H::STATE)?,
        ticket_bell: u32_at(H::TICKET_BELL)?,
        final_ts: i64_at(H::FINAL_TS)?,
    })
}

#[derive(Default)]
pub struct WideTicketDuty {
    last_scan: Option<u64>,
    /// Wide sites this role has seen a ticket for, until their holding is
    /// final (or gone with no open ticket left on them).
    pub watch: BTreeSet<WideSite>,
    /// Open wide tickets at the last scan.
    pub open: usize,
    /// Of them, waiting for their bell's seed.
    pub waiting_seed: usize,
    /// Landed WideSettleTickets: `(key, slot)`.
    pub settled: Vec<(String, u64)>,
    /// Landed WideFinalizes: `(key, slot)`.
    pub finalized: Vec<(String, u64)>,
    /// Settlements planned as expired.
    pub expired: usize,
}

fn owned(a: &Option<Account>, program: &Address) -> bool {
    a.as_ref()
        .is_some_and(|a| a.owner == *program && !a.data.is_empty())
}

async fn read_all<P: ChainPort>(port: &P, keys: &[Address]) -> PortResult<Vec<Option<Account>>> {
    let mut got = Vec::with_capacity(keys.len());
    for chunk in keys.chunks(100) {
        got.extend(port.accounts(chunk, 0).await?);
    }
    Ok(got)
}

impl WideTicketDuty {
    pub fn on_outcome(&mut self, key: &str, o: &Outcome) {
        if let Outcome::Landed { slot, .. } = o {
            if key.starts_with("wide-settle:") {
                self.settled.push((key.to_string(), *slot));
            } else if key.starts_with("wide-final:") {
                self.finalized.push((key.to_string(), *slot));
            }
        }
    }

    pub async fn plan<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        index: &LandIndex,
        seeds: &mut SeedFinder,
        anchors: &BTreeMap<(u32, u8), AnchorInfo>,
    ) -> PortResult<()> {
        if !t.cfg.has_role("wide-tickets") || t.season.effective_status(t.now) != status::RUNNING {
            return Ok(());
        }
        if self
            .last_scan
            .is_some_and(|s| t.slot < s.saturating_add(t.cfg.wide_scan_slots))
        {
            return Ok(());
        }
        self.last_scan = Some(t.slot);
        let program = t.addrs.program;
        let now_bell = t.clock.bell_at(t.now).unwrap_or(0);
        let c = widelane::ctx(t.addrs);
        let adr = Address::new_from_array;

        // 1. The known Citizens' wide ticket records.
        let citizens: Vec<Address> = index.citizens.keys().copied().collect();
        let rkeys: Vec<Address> = citizens
            .iter()
            .map(|z| adr(wt::ticket_address(&c, &z.to_bytes())))
            .collect();
        let mut open = vec![];
        for (z, acct) in citizens.iter().zip(read_all(port, &rkeys).await?) {
            let Some(rec) = acct
                .filter(|a| a.owner == program)
                .and_then(|a| WideTicket::read(&a.data).ok())
                .filter(|r| r.citizen == z.to_bytes())
            else {
                continue;
            };
            self.watch.insert((rec.coord.p(), rec.coord.q(), rec.site));
            if rec.status == TicketStatus::Open && rec.next == 0 {
                open.push(rec);
            }
        }
        self.open = open.len();
        self.waiting_seed = 0;
        let ended: Vec<WideTicket> = open.iter().filter(|r| r.bell < now_bell).cloned().collect();

        // 2. Their provinces (the region) and Citizens (nation, shard, tag).
        let coords: Vec<WideCoord> = ended
            .iter()
            .map(|r| r.coord)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let pkeys: Vec<Address> = coords
            .iter()
            .map(|&x| adr(wl::province_address(&c, x)))
            .collect();
        let mut region: BTreeMap<WideCoord, u8> = BTreeMap::new();
        for (x, acct) in coords.iter().zip(read_all(port, &pkeys).await?) {
            if let Some(p) = acct
                .filter(|a| a.owner == program)
                .and_then(|a| WideProvince::read(&a.data).ok())
            {
                region.insert(*x, p.region);
            }
        }
        let ckeys: Vec<Address> = ended.iter().map(|r| adr(r.citizen)).collect();
        let cz = read_all(port, &ckeys).await?;
        let mut cands = vec![];
        for (rec, acct) in ended.into_iter().zip(cz) {
            let (Some(&reg), Some(d)) = (
                region.get(&rec.coord),
                acct.filter(|a| a.owner == program).map(|a| a.data),
            ) else {
                continue;
            };
            let (Some(&faction), Some(&shard), Some(tag)) = (
                d.get(C::FACTION),
                d.get(C::JOIN_SHARD),
                d.get(C::CITIZEN_TAG..C::CITIZEN_TAG + 8)
                    .map(|b| u64::from_le_bytes(b.try_into().unwrap())),
            ) else {
                continue;
            };
            let expired = now_bell >= rec.bell.saturating_add(COHORT_BELLS);
            let (src, seed) = if expired {
                (SeedSource::Cache { nonce: 0 }, [0u8; 32])
            } else {
                match seeds
                    .find(port, t.addrs, anchors, rec.bell, reg, t.slot)
                    .await?
                {
                    Some(s) => (s.src, s.seed),
                    None => {
                        self.waiting_seed += 1;
                        continue;
                    }
                }
            };
            let score = if expired {
                0
            } else {
                wt::wide_ticket_score(&seed, rec.coord, rec.site, tag)
            };
            cands.push(WideCandidate {
                rec,
                faction,
                shard,
                tag,
                region: reg,
                score,
                src,
                expired,
            });
        }

        // 3. One per site, displacing an out-of-order holder of its cohort.
        let chosen = pick(cands);
        let hkeys: Vec<Address> = chosen
            .iter()
            .map(|x| adr(wh::holding_address(&c, x.rec.coord, x.rec.site)))
            .collect();
        let held = read_all(port, &hkeys).await?;
        for (x, hacct) in chosen.into_iter().zip(held) {
            let mut displaced = None;
            if !x.expired && owned(&hacct, &program) {
                let hd = hacct.map(|a| a.data).unwrap_or_default();
                let h = holding_hdr(&hd);
                let held_score = hd
                    .get(H::TICKET_SCORE..H::TICKET_SCORE + 8)
                    .map(|b| u64::from_le_bytes(b.try_into().unwrap()));
                let owner: Option<[u8; 32]> = hd
                    .get(H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32)
                    .map(|b| b.try_into().unwrap());
                let payer: Option<[u8; 32]> = hd
                    .get(H::RENT_PAYER..H::RENT_PAYER + 32)
                    .map(|b| b.try_into().unwrap());
                if let (Some(h), Some(hs), Some(owner), Some(payer)) = (h, held_score, owner, payer)
                {
                    let owner = adr(owner);
                    if h.state == H::STATE_PROVISIONAL
                        && h.ticket_bell == x.rec.bell
                        && owner != adr(x.rec.citizen)
                        && beats(x.score, x.tag, hs, citizen_tag_u64(&owner))
                    {
                        let od = port.accounts(&[owner], 0).await?;
                        let Some(od) = od[0].as_ref().filter(|a| a.owner == program) else {
                            continue;
                        };
                        let (Some(&f), Some(&s)) =
                            (od.data.get(C::FACTION), od.data.get(C::JOIN_SHARD))
                        else {
                            continue;
                        };
                        displaced = Some(Displaced {
                            rent_payer: adr(payer),
                            citizen: owner,
                            shard: t.addrs.join_shard(f, s),
                        });
                    }
                }
            }
            if x.expired {
                self.expired += 1;
            }
            let a = t.addrs.clone();
            let rec = x.rec;
            let (faction, shard, region, src) = (x.faction, x.shard, x.region, x.src);
            engine.ensure(
                WriteSpec {
                    key: settle_key(&adr(x.rec.citizen), x.rec.bell),
                    kind: "wide-settle",
                    tag: WideIx::SettleTicket.tag(),
                    class: Class::D,
                    bell: Some(x.rec.bell),
                    region: Some(region),
                    build: Arc::new(move |b: &BuildCtx| {
                        vec![widelane::settle_ticket(
                            &a, b.payer, &rec, faction, shard, region, src, displaced,
                        )]
                    }),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            );
        }

        // 4. WideFinalize of every watched provisional village that is due.
        let open_sites: BTreeSet<WideSite> = open
            .iter()
            .map(|r| (r.coord.p(), r.coord.q(), r.site))
            .collect();
        let watch: Vec<WideSite> = self.watch.iter().copied().collect();
        let mut keys = vec![];
        for &(p, q, s) in &watch {
            let Ok(x) = WideCoord::checked(p, q) else {
                continue;
            };
            keys.push(adr(wh::holding_address(&c, x, s)));
            keys.push(adr(wl::province_address(&c, x)));
        }
        let got = read_all(port, &keys).await?;
        for (i, &(p, q, s)) in watch.iter().enumerate() {
            let (Some(h), Some(pv)) = (got.get(2 * i), got.get(2 * i + 1)) else {
                continue;
            };
            let Some(hh) = h
                .as_ref()
                .filter(|a| a.owner == program)
                .and_then(|a| holding_hdr(&a.data))
            else {
                if !open_sites.contains(&(p, q, s)) {
                    self.watch.remove(&(p, q, s));
                }
                continue;
            };
            if hh.state != H::STATE_PROVISIONAL {
                self.watch.remove(&(p, q, s));
                continue;
            }
            let Some(pd) = pv.as_ref().filter(|a| a.owner == program) else {
                continue;
            };
            if !finality_due(&hh, &pd.data, t.now, now_bell) {
                continue;
            }
            let Ok(x) = WideCoord::checked(p, q) else {
                continue;
            };
            let a = t.addrs.clone();
            engine.ensure(
                WriteSpec {
                    key: finalize_key(p, q, s),
                    kind: "wide-final",
                    tag: WideIx::Finalize.tag(),
                    class: Class::D,
                    bell: None,
                    region: None,
                    build: Arc::new(move |b: &BuildCtx| {
                        vec![widelane::finalize(&a, b.payer, x, s)]
                    }),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            );
        }
        Ok(())
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "wide_tickets_open": self.open,
            "wide_tickets_waiting_seed": self.waiting_seed,
            "wide_tickets_settled": self.settled.len(),
            "wide_tickets_expired_planned": self.expired,
            "wide_villages_watched": self.watch.len(),
            "wide_villages_finalized": self.finalized.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(bell: u32, site: u8, score: u64, tag: u64, expired: bool) -> WideCandidate {
        WideCandidate {
            rec: WideTicket {
                season_id: 1,
                world: frontier_abi::world_index::WorldId::new([5; 32]).unwrap(),
                status: TicketStatus::Open,
                citizen: [tag as u8; 32],
                coord: WideCoord::checked(129, 0).unwrap(),
                site,
                slot: 2,
                bell,
                next: 0,
                funder: [0; 32],
                rent_payer: [0; 32],
                escrow: 0,
            },
            faction: 0,
            shard: 0,
            tag,
            region: 1,
            score,
            src: SeedSource::Cache { nonce: 0 },
            expired,
        }
    }

    #[test]
    fn one_per_site_oldest_cohort_then_lottery_and_every_expired() {
        let v = vec![
            cand(10, 1, 5, 1, false),
            cand(10, 1, 9, 2, false),
            cand(9, 1, 1, 3, false),
            cand(10, 2, 4, 4, false),
            cand(10, 2, 4, 3, false),
            cand(1, 1, 0, 6, true),
            cand(1, 1, 0, 7, true),
        ];
        let p = pick(v);
        let tags: BTreeSet<u64> = p.iter().map(|c| c.tag).collect();
        // site 1: bell 9 first; site 2: equal scores, the lower tag; both expired ones
        assert_eq!(tags, [3u64, 6, 7].into_iter().collect::<BTreeSet<_>>());
        assert_eq!(p.len(), 4);
        assert_eq!(p.iter().filter(|c| c.rec.site == 2).count(), 1);
    }

    #[test]
    fn the_finality_rule_is_the_programs_on_the_holding_bytes() {
        let mut hd = vec![0u8; H::SIZE];
        hd[H::STATE] = H::STATE_PROVISIONAL;
        hd[H::TICKET_BELL..H::TICKET_BELL + 4].copy_from_slice(&7u32.to_le_bytes());
        hd[H::FINAL_TS..H::FINAL_TS + 8].copy_from_slice(&1_000i64.to_le_bytes());
        let h = holding_hdr(&hd).unwrap();
        assert_eq!((h.state, h.ticket_bell, h.final_ts), (1, 7, 1_000));
        use frontier_abi::layout::province::{cohort, province as P};
        let mut pd = vec![0u8; P::SIZE];
        // (no cohort of bell 7 on the province: closed; only the clock waits)
        assert!(!finality_due(&h, &pd, 999, 8));
        assert!(finality_due(&h, &pd, 1_000, 8));
        // (its cohort open — one filed, none settled — until 24 bells after it)
        let o = P::cohort(0);
        pd[o + cohort::BELL..o + cohort::BELL + 4].copy_from_slice(&7u32.to_le_bytes());
        pd[o + cohort::FILED..o + cohort::FILED + 2].copy_from_slice(&1u16.to_le_bytes());
        assert!(!finality_due(&h, &pd, 1_000, 8));
        assert!(finality_due(&h, &pd, 1_000, 7 + COHORT_BELLS));
        pd[o + cohort::SETTLED..o + cohort::SETTLED + 2].copy_from_slice(&1u16.to_le_bytes());
        assert!(finality_due(&h, &pd, 1_000, 8));
        assert!(holding_hdr(&hd[..10]).is_none());
    }
}
