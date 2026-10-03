//! ABI v2 instruction builders (MC contract §5.5, §5.6): the seven new
//! instructions and the M1 instructions whose account lists MC changes.
//! Data comes from `frontier_abi::v2::ix` (one encoder for the program,
//! the SDK and the off-chain spine); account orders are
//! `frontier_abi::v2::prologue::accounts_of`, which `tests` checks
//! position by position (signer and writable flags). Every canonical
//! address is recomputed from its key.
//!
//! Where §5.5 leaves an account open (marked D-n in
//! `docs/frontier/conquest/CQ2-D-NOTES.md`), the builder takes the address
//! from the caller and documents the default the keeper passes.

use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

use frontier_abi::ix::TicketSite;
use frontier_abi::v2::ix as d2;

use super::{r, rs, w, ws, HoldingRef, Player, SettleTransitArgs, Site};
use crate::addr::{self, Addresses};

fn build(a: &Addresses, metas: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a.program,
        accounts: metas,
        data,
    }
}

/// The player prologue `[actor s] [payer s,w] [season r] [citizen w]`.
fn prologue(a: &Addresses, p: &Player) -> Vec<AccountMeta> {
    vec![
        rs(p.actor),
        ws(p.payer),
        r(a.season),
        w(a.citizen(&p.wallet)),
    ]
}

/// DeclareSiege's accounts beyond the prologue (§5.5 0xA0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeclareSiegeArgs {
    /// The declarer's Holding that owns the host on the hex (pays the stake).
    pub src: HoldingRef,
    /// The target's Province and site.
    pub target: (i16, i16),
    pub site: u8,
    /// The declaring host's entry index (the hex's lead host, K-24).
    pub entry: u8,
    /// The target Holding's owner Citizen (`Holding.owner_citizen`); for a
    /// Free City any absent canonical address (D-1: the builder's
    /// [`DeclareSiegeArgs::free_city`] passes the site's canonical Holding
    /// address, absent for a Free City).
    pub owner_citizen: Address,
    /// The Province proving Frontier protection (`nearby_site` names a
    /// first holding of the attacker's faction there); `None`: not needed,
    /// the builder passes the target's canonical Holding address (absent
    /// for a Free City; for a holding it is present but unread, D-1).
    pub nearby: Option<(i16, i16)>,
    pub nearby_site: u8,
}

impl DeclareSiegeArgs {
    /// A Free City target: no Holding, no owner.
    pub fn free_city(
        a: &Addresses,
        src: HoldingRef,
        target: (i16, i16),
        site: u8,
        entry: u8,
    ) -> Self {
        DeclareSiegeArgs {
            src,
            target,
            site,
            entry,
            owner_citizen: a.holding(target.0 as i32, target.1 as i32, site),
            nearby: None,
            nearby_site: 0,
        }
    }
}

/// 0xA0 DeclareSiege (P): `[actor s] [payer s,w] [season r] [citizen w]
/// [src_holding w] [province w] [target_holding r] [owner_citizen r]
/// [nearby_province r] [system]`.
pub fn declare_siege(a: &Addresses, p: &Player, x: &DeclareSiegeArgs) -> Instruction {
    let (tp, tq) = (x.target.0 as i32, x.target.1 as i32);
    let target_holding = a.holding(tp, tq, x.site);
    let nearby = x
        .nearby
        .map_or(target_holding, |(np, nq)| a.province(np as i32, nq as i32));
    let mut m = prologue(a, p);
    m.extend([
        w(x.src.address(a)),
        w(a.province(tp, tq)),
        r(target_holding),
        r(x.owner_citizen),
        r(nearby),
        r(addr::system_program()),
    ]);
    let data = d2::DeclareSiege {
        site: x.site,
        entry: x.entry,
        nearby_site: x.nearby_site,
    }
    .to_bytes()
    .to_vec();
    build(a, m, data)
}

/// 0xA1 SettleSiege (N): `[any s] [season r] [province w]
/// [recipient_holding w] [slot_citizen w] ([ticket_funder w])`.
/// `recipient` is the canonical Holding the record names (flags bit 1:
/// the site's Holding; bit 2 or a lapsed siege: `src`), `slot_citizen`
/// the Citizen of the record's `actor` when a slot is owed back (bit 5),
/// else any absent canonical address; `ticket_funder` that Citizen's
/// funder when a slot is owed back (CQ1-C D-6).
pub fn settle_siege(
    a: &Addresses,
    any: Address,
    province: (i16, i16),
    site: u8,
    recipient: Address,
    slot_citizen: Address,
    ticket_funder: Option<Address>,
) -> Instruction {
    let mut m = vec![
        rs(any),
        r(a.season),
        w(a.province(province.0 as i32, province.1 as i32)),
        w(recipient),
        w(slot_citizen),
    ];
    if let Some(f) = ticket_funder {
        m.push(w(f));
    }
    build(a, m, d2::SettleSiege { site }.to_bytes().to_vec())
}

/// SettleCapture's accounts (§5.5 0xA2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettleCaptureArgs {
    pub province: (i16, i16),
    pub site: u8,
    pub captor_citizen: Address,
    pub captor_shard: (u8, u8),
    /// `(victim Citizen, its (faction, shard), the Holding's rent payer)`;
    /// `None` for a Free City (D-2: the builder then passes the site's
    /// canonical Holding address, absent, at positions 6–8).
    pub victim: Option<(Address, (u8, u8), Address)>,
    /// The record's `src` Holding (the stake's return); may be absent.
    pub stake_holding: Address,
    pub beneficiary: Address,
}

/// 0xA2 SettleCapture (D): `[fee_payer s,w] [season r] [holding w]
/// [province w] [captor_citizen w] [captor_joinshard w] [victim_citizen w]
/// [victim_joinshard w] [victim_rent_payer w] [stake_holding w] [system]`.
pub fn settle_capture(a: &Addresses, fee_payer: Address, x: &SettleCaptureArgs) -> Instruction {
    let (p, q) = (x.province.0 as i32, x.province.1 as i32);
    let holding = a.holding(p, q, x.site);
    let (vc, vjs, vrp) = match x.victim {
        Some((c, (f, s), rp)) => (c, a.join_shard(f, s), rp),
        None => (holding, holding, holding),
    };
    let m = vec![
        ws(fee_payer),
        r(a.season),
        w(holding),
        w(a.province(p, q)),
        w(x.captor_citizen),
        w(a.join_shard(x.captor_shard.0, x.captor_shard.1)),
        w(vc),
        w(vjs),
        w(vrp),
        w(x.stake_holding),
        r(addr::system_program()),
    ];
    let data = d2::SettleCapture {
        site: x.site,
        beneficiary: x.beneficiary.to_bytes(),
    }
    .to_bytes()
    .to_vec();
    build(a, m, data)
}

/// 0xA3 FileOutpost (P): P + `[frontier r] [province × m w] [system]
/// [anchor_holding w]` (the M1 FileTicket list and the anchor).
pub fn file_outpost(
    a: &Addresses,
    p: &Player,
    sites: &[Site],
    anchor: HoldingRef,
    anchor_site_key: u64,
) -> Instruction {
    assert!((1..=3).contains(&sites.len()), "1–3 sites");
    let mut m = prologue(a, p);
    m.push(r(a.frontier()));
    m.extend(
        super::ticket_provinces(sites)
            .into_iter()
            .map(|(pp, qq)| w(a.province(pp as i32, qq as i32))),
    );
    m.push(r(addr::system_program()));
    m.push(w(anchor.address(a)));
    let mut ts = [TicketSite::default(); 3];
    for (t, s) in ts.iter_mut().zip(sites) {
        *t = TicketSite {
            p: s.p,
            q: s.q,
            site: s.site,
        };
    }
    let o = d2::FileOutpost {
        n: sites.len() as u8,
        sites: ts,
        anchor_site_key,
    };
    let mut buf = [0u8; d2::FileOutpost::MAX_LEN];
    let n = o.encode(&mut buf).expect("1–3 sites encode");
    build(a, m, buf[..n].to_vec())
}

/// 0xA5 FoldMarch (D): `[fee_payer s,w] [season r] [march w]
/// [province × 7 r] (march_members order) [system]`.
pub fn fold_march(
    a: &Addresses,
    fee_payer: Address,
    (m_, n_): (i32, i32),
    hour: u32,
    count: u8,
    beneficiary: &Address,
) -> Instruction {
    let mut m = vec![ws(fee_payer), r(a.season), w(a.march_state(m_, n_))];
    m.extend(
        frontier_abi::v2::addr::march_members(m_, n_)
            .iter()
            .map(|&(p, q)| r(a.province(p, q))),
    );
    m.push(r(addr::system_program()));
    let data = d2::FoldMarch {
        m: m_,
        n: n_,
        hour,
        count,
        beneficiary: beneficiary.to_bytes(),
    }
    .to_bytes()
    .to_vec();
    build(a, m, data)
}

/// 0xA6 RetireHost (P during the season, the victim's wallet or session as
/// `actor`; N after `end_bell`, any actor): `[actor s] [payer s,w]
/// [season r] [victim_citizen r] [province w] [captured_holding r]
/// [home_holding r]`.
#[allow(clippy::too_many_arguments)]
pub fn retire_host(
    a: &Addresses,
    actor: Address,
    payer: Address,
    victim_citizen: Address,
    province: (i16, i16),
    captured: HoldingRef,
    home: HoldingRef,
    entry: u8,
) -> Instruction {
    let m = vec![
        rs(actor),
        ws(payer),
        r(a.season),
        r(victim_citizen),
        w(a.province(province.0 as i32, province.1 as i32)),
        r(captured.address(a)),
        r(home.address(a)),
    ];
    build(a, m, d2::RetireHost { entry }.to_bytes().to_vec())
}

/// 0xA7 CloseMarch (N): `[any s] [season r] [march w] [rent_to w]`.
pub fn close_march(
    a: &Addresses,
    any: Address,
    (m_, n_): (i32, i32),
    rent_to: Address,
) -> Instruction {
    let m = vec![rs(any), r(a.season), w(a.march_state(m_, n_)), w(rent_to)];
    build(a, m, d2::CloseMarch {}.to_bytes().to_vec())
}

// ------------------------------------------------------------ changed M1 shapes

fn resident_v2(a: &Addresses, p: &Player, h: HoldingRef, province_w: bool) -> Vec<AccountMeta> {
    let mut m = prologue(a, p);
    m.push(w(h.address(a)));
    let pv = h.province(a);
    m.push(if province_w { w(pv) } else { r(pv) });
    m
}

/// 0x40 Harvest v2 (§5.6, the capture lock): P + `[holding w] [province r]`.
pub fn harvest(a: &Addresses, p: &Player, h: HoldingRef) -> Instruction {
    build(
        a,
        resident_v2(a, p, h, false),
        vec![crate::abi::tag::HARVEST],
    )
}

/// 0x41 Build v2: P + `[holding w] [province r|w]`; the Province is
/// writable for walls and for a tier-up (`tier_next`).
pub fn build_item(
    a: &Addresses,
    p: &Player,
    h: HoldingRef,
    item: u8,
    writes_province: bool,
) -> Instruction {
    build(
        a,
        resident_v2(a, p, h, writes_province),
        vec![crate::abi::tag::BUILD, item],
    )
}

/// 0x42 Train v2: P + `[holding w] [province r]` (MC pays
/// `catalog::train_v2`, §3.16; the data is M1's).
pub fn train(a: &Addresses, p: &Player, h: HoldingRef, unit: u8, n: u32) -> Instruction {
    let mut d = vec![crate::abi::tag::TRAIN, unit];
    d.extend_from_slice(&n.to_le_bytes());
    build(a, resident_v2(a, p, h, false), d)
}

/// 0x54 SettleTransit v2: M1's list, the optional camp Citizen, and
/// `[prev_home_holding w]` when the Holding's generation is not the host
/// id's (a captured Holding, §5.6; CQ1-C D-8: an optional trailing group).
pub fn settle_transit(
    a: &Addresses,
    payer: Address,
    x: &SettleTransitArgs,
    prev_home: Option<HoldingRef>,
) -> Instruction {
    let mut ix = super::settle_transit(a, payer, x);
    if let Some(h) = prev_home {
        ix.accounts.push(w(h.address(a)));
    }
    ix
}

/// 0x01 CreateSeason v2 (§5.6): M1's accounts; data `SeasonParams v2`
/// (352 B) ‖ `PayoutParams`.
pub fn create_season(
    a: &Addresses,
    authority: Address,
    params: &frontier_abi::v2::presets::SeasonParamsV2,
    payout: &[u8],
) -> Instruction {
    super::create_season(a, authority, &params.to_bytes(), payout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::prologue::{Group, Wr};
    use frontier_abi::v2::prologue::{accounts_of, count_bounds};
    use frontier_abi::v2::tags::Ix;

    fn addrs() -> Addresses {
        Addresses::new(Address::new_from_array([7; 32]), 1)
    }

    /// Expands a v2 account list for `n` accounts (each optional group as
    /// many times as it fits, in order) and checks every position's signer
    /// and writable flag.
    fn check_flags(ix: Ix, metas: &[AccountMeta]) {
        let groups: &[Group] = accounts_of(ix);
        let (lo, hi) = count_bounds(ix);
        assert!(
            (lo..=hi).contains(&metas.len()),
            "{}: {} accounts not in {lo}..={hi}",
            ix.name(),
            metas.len()
        );
        let mut extra = metas.len() - lo;
        let mut specs = vec![];
        for g in groups {
            let mut reps = g.min as usize;
            while reps < g.max as usize && extra >= g.specs.len() {
                reps += 1;
                extra -= g.specs.len();
            }
            for _ in 0..reps {
                specs.extend_from_slice(g.specs);
            }
        }
        assert_eq!(specs.len(), metas.len(), "{}", ix.name());
        for (i, (s, m)) in specs.iter().zip(metas).enumerate() {
            assert_eq!(
                m.is_signer,
                s.signer,
                "{} #{i} {} signer",
                ix.name(),
                s.name
            );
            match s.wr {
                Wr::W => assert!(m.is_writable, "{} #{i} {} writable", ix.name(), s.name),
                Wr::R => assert!(!m.is_writable, "{} #{i} {} read-only", ix.name(), s.name),
                Wr::Either => {}
            }
        }
    }

    fn all_v2() -> Vec<(Ix, Instruction)> {
        let a = addrs();
        let k = Address::new_from_array([9; 32]);
        let w2 = Address::new_from_array([8; 32]);
        let pl = Player {
            actor: w2,
            payer: k,
            wallet: w2,
        };
        let h = HoldingRef {
            p: 3,
            q: 0,
            site: 2,
        };
        let home = HoldingRef {
            p: 2,
            q: 1,
            site: 5,
        };
        let sites = [
            Site {
                p: 4,
                q: 0,
                site: 1,
            },
            Site {
                p: 4,
                q: 1,
                site: 2,
            },
            Site {
                p: 5,
                q: 0,
                site: 3,
            },
        ];
        let st = SettleTransitArgs {
            holding: h,
            transit_slot: 0,
            commit: [0; 32],
            seal: [0; 165],
            beneficiary: k,
            dest: (3, 0),
            arrive: 10,
            faction: 1,
            slot_i: 0,
            home: (2, 0),
            anchor_present: true,
            slot_beneficiary: k,
            resolver: k,
            holding_rent_payer: k,
            camp_citizen: Some(w2),
        };
        let ds = DeclareSiegeArgs {
            src: h,
            target: (4, 0),
            site: 7,
            entry: 3,
            owner_citizen: w2,
            nearby: Some((4, 1)),
            nearby_site: 2,
        };
        let sc = SettleCaptureArgs {
            province: (4, 0),
            site: 7,
            captor_citizen: a.citizen(&w2),
            captor_shard: (1, 3),
            victim: Some((a.citizen(&k), (2, 5), k)),
            stake_holding: h.address(&a),
            beneficiary: k,
        };
        vec![
            (Ix::DeclareSiege, declare_siege(&a, &pl, &ds)),
            (
                Ix::DeclareSiege,
                declare_siege(&a, &pl, &DeclareSiegeArgs::free_city(&a, h, (4, 0), 7, 3)),
            ),
            (
                Ix::SettleSiege,
                settle_siege(&a, k, (4, 0), 7, h.address(&a), w2, None),
            ),
            (
                Ix::SettleSiege,
                settle_siege(&a, k, (4, 0), 7, h.address(&a), w2, Some(k)),
            ),
            (Ix::SettleCapture, settle_capture(&a, k, &sc)),
            (
                Ix::SettleCapture,
                settle_capture(&a, k, &SettleCaptureArgs { victim: None, ..sc }),
            ),
            (Ix::FileOutpost, file_outpost(&a, &pl, &sites, home, 0x1234)),
            (Ix::FileOutpost, file_outpost(&a, &pl, &sites[..1], home, 1)),
            (Ix::FoldMarch, fold_march(&a, k, (-1, 2), 40, 6, &k)),
            (
                Ix::RetireHost,
                retire_host(&a, w2, k, a.citizen(&w2), (3, 0), h, home, 4),
            ),
            (Ix::CloseMarch, close_march(&a, k, (0, 0), k)),
            (Ix::Harvest, harvest(&a, &pl, h)),
            (Ix::Build, build_item(&a, &pl, h, 7, true)),
            (Ix::Build, build_item(&a, &pl, h, 7, false)),
            (Ix::Train, train(&a, &pl, h, 2, 500)),
            (Ix::SettleTransit, settle_transit(&a, k, &st, Some(home))),
            (
                Ix::CreateSeason,
                create_season(&a, k, &frontier_abi::v2::presets::MC_TEST, &[0; 128]),
            ),
        ]
    }

    /// MC §5.5–§5.6: one builder per new tag and per changed account list;
    /// each matches frontier-abi's v2 list position by position, carries
    /// frontier-abi's data, and fits the packet and lock limits.
    #[test]
    fn cq_builders_match_the_v2_lists_and_fit_a_packet() {
        let k = Address::new_from_array([9; 32]);
        let bh = solana_hash::Hash::new_from_array([1; 32]);
        let all = all_v2();
        let mut tags: Vec<u8> = all.iter().map(|(_, i)| i.data[0]).collect();
        tags.sort();
        tags.dedup();
        for t in Ix::NEW {
            assert!(tags.contains(&t.tag()), "{} has a builder", t.name());
        }
        for (ix, ixn) in &all {
            assert_eq!(ixn.data[0], ix.tag());
            let (dlo, dhi) = frontier_abi::v2::ix::data_len_range(*ix);
            assert!(
                (dlo..=dhi).contains(&ixn.data.len()),
                "{}: data {} not in {dlo}..={dhi}",
                ix.name(),
                ixn.data.len()
            );
            check_flags(*ix, &ixn.accounts);
            let msg = solana_message::Message::new_with_blockhash(
                &[
                    crate::tx::set_compute_unit_limit(1),
                    crate::tx::set_compute_unit_price(1),
                    crate::tx::set_loaded_accounts_data_size_limit(1),
                    ixn.clone(),
                ],
                Some(&k),
                &bh,
            );
            let sh = crate::tx::shape(&msg);
            assert!(sh.locks <= crate::abi::LOCK_LIMIT, "{}", ix.name());
            assert!(
                sh.bytes <= crate::abi::PACKET,
                "{}: {} B",
                ix.name(),
                sh.bytes
            );
            let row = crate::abi::ix_info_v2(ix.tag()).unwrap();
            if ix.is_new() {
                // §5.4's Tx B max, or frontier-abi's raised ceiling (CQ1-C D-11).
                let ceiling = frontier_abi::v2::budgets::tx_ceiling(*ix) as usize;
                assert!(
                    sh.bytes <= ceiling.max(row.tx_max as usize),
                    "{}: {} B over {}",
                    ix.name(),
                    sh.bytes,
                    ceiling
                );
            }
        }
    }

    #[test]
    fn cq_builders_recompute_canonical_keys() {
        let a = addrs();
        let k = Address::new_from_array([9; 32]);
        let f = fold_march(&a, k, (-1, 2), 40, 3, &k);
        assert_eq!(f.accounts[2].pubkey, a.march_state(-1, 2));
        let mem = frontier_abi::v2::addr::march_members(-1, 2);
        for (i, (p, q)) in mem.iter().enumerate() {
            assert_eq!(f.accounts[3 + i].pubkey, a.province(*p, *q));
        }
        let d = frontier_abi::v2::ix::FoldMarch::decode(&f.data).unwrap();
        assert_eq!((d.m, d.n, d.hour, d.count), (-1, 2, 40, 3));
        let sc = settle_capture(
            &a,
            k,
            &SettleCaptureArgs {
                province: (4, 0),
                site: 7,
                captor_citizen: k,
                captor_shard: (1, 3),
                victim: None,
                stake_holding: k,
                beneficiary: k,
            },
        );
        assert_eq!(sc.accounts[2].pubkey, a.holding(4, 0, 7));
        assert_eq!(sc.accounts[5].pubkey, a.join_shard(1, 3));
        assert_eq!(sc.accounts[6].pubkey, a.holding(4, 0, 7), "D-2 placeholder");
    }
}
