//! P17 (devnet-p17, devnet gap P17): the WEB PAGE sends its WIDE village's own acts on the devnet wide season, on the
//! exact devnet `.so` (67a33c92…, unchanged), offline — wallet-signed, wallet-paid, through the gateway's devnet play
//! routes (`/gw/f/devnet-play/act/submit`).
//!
//! P7's whole run first (the page Joins, files the rim FileTicket, harvests, files the wide claim; keeper A's
//! `tickets` and `wide-tickets` roles settle and finalize: the page's wide village, slot 2, final), then:
//!
//! 1. **Declared** (as P6, `after_wide`): the wide village's stores filled (the means of Build and Train; natural
//!    production would take days of chain time). Nothing about its reserve: the page trains its own troops.
//! 2. REAL, the page (page_driver.mjs `--wide-acts`): the wide village's card 「この遠方の村への命令」. A muster with an
//!    empty reserve is refused by the page before anything is signed (JA and EN notices). Then Harvest, Build (a
//!    building, item 0), Build (the walls, item 6: the province writable), Train 100 Spearmen — each its FIRST press
//!    (「費用を確認」: the fee, in SOL), its SECOND press (「署名して送る」: ONE wallet-signed transaction), and its result
//!    read back from the village's next record.
//! 3. **Declared**: the wide province's `resolved_next` = the current bell (stands in for keeper A's `wide-resolve`,
//!    which needs THE anchor of every bell; the shipped rounds do not cover these bells), then the page's Muster of 100
//!    Spearmen on its province's first passable tile: the preview names the fee PLUS the rent of the province's wide
//!    roster (3,248 bytes, its first muster), at this chain's rent rate.
//!
//! 2b. (verify-pr151) **Declared**: the wide province's `resolved_next` = two bells behind; the page's Muster of 100
//!    Spearmen passes the page's own checks (a lag warning) and is refused by the chain's preflight (NotResident) — not
//!    sent, nothing paid — in JA and EN.
//!
//! Asserted on chain: every page act landed with one signature, the wallet as fee payer; the wallet's lamports for each
//! act are exactly the preview's total, and the refused sends cost nothing; the roster exists, the program's, holding
//! its rent; the village's reserve went +100 then −100 and it issued one host. (The walls Build is queued — the card
//! reads the queue grow back — its completion is not waited for.)

use super::*;

/// The 0xDA tag every wide village act carries (`wide_ix::WideIx::Depart`'s band, ops 1 and 3).
const WIDE_TAG: u8 = 0xDA;

/// P17's phase, inside [`page_flow`] after the page showed its wide village as final. `driver_alive` says whether the
/// page driver still runs. → the summary's `p17_wide_acts`.
#[allow(clippy::too_many_arguments)]
pub(super) async fn phase(
    r: &mut Run<'_>,
    sync: &std::path::Path,
    driver_alive: &mut dyn FnMut() -> bool,
    w: Address,
    target: WideCoord,
    site: u8,
) -> Value {
    use frontier_abi::layout::player::accrual as AC;
    use frontier_abi::layout::province::province as PV1;
    use frontier_abi::world_index::roster as wro;
    use frontier_abi::world_index::{ProvinceKey, WorldId};
    use permutation_rules::frontier::holding::RESOURCES;
    const STORES: i64 = 5_000_000_000;
    let ctx = r.ctx();
    let a = r.c.a.clone();
    let wholding = adr(wh::holding_address(&ctx, target, site));
    let wprov = adr(wl::province_address(&ctx, target));
    let world = WorldId::derive_legacy_season(&a.season.to_bytes(), &a.program.to_bytes())
        .expect("the season's world");
    let roster = adr(wro::roster_address(&ctx, ProvinceKey::new(world, target)));
    assert!(
        r.data(&roster).is_none(),
        "no roster before the page's first muster"
    );
    let edit = |r: &mut Run<'_>, key: Address, what: &str, f: &dyn Fn(&mut Vec<u8>)| {
        let mut acct = r.lock().account(&key).expect("an account to patch");
        f(&mut acct.data);
        r.patch(key, acct, what);
    };
    let before = r.data(&wholding).expect("the wide village");
    let reserve0 = le_u32(&before, H::reserve(0));
    let seq0 = le_u32(&before, H::HOST_SEQ);
    let walls0 = le_u32(&before, H::WALLS);
    // 1. Declared: the stores.
    edit(
        r,
        wholding,
        "the wide village's stores filled (the means of the page's Build and Train)",
        &|d| {
            for res in 0..RESOURCES {
                let so = H::store(res);
                d[so + AC::VALUE..so + AC::VALUE + 8].copy_from_slice(&STORES.to_le_bytes());
                let cap = i64::from_le_bytes(d[so + AC::CAP..so + AC::CAP + 8].try_into().unwrap());
                if cap < STORES {
                    d[so + AC::CAP..so + AC::CAP + 8].copy_from_slice(&STORES.to_le_bytes());
                }
            }
        },
    );
    {
        let mut c = r.lock();
        c.set_scale(1.0);
        c.set_paused(false);
    }
    let since = r.lock().slot();
    let pre_lamports = r.lock().account(&w).map(|x| x.lamports).unwrap_or(0);
    std::fs::write(
        sync.join("go-wide-acts"),
        format!("{} {} {}\n", target.p(), target.q(), site),
    )
    .unwrap();
    // 2./3. The page's acts; before its muster, the declared province cursor.
    let t0 = Instant::now();
    let mut mustered_at_bell = None;
    let mut behind_at_bell = None;
    let done = loop {
        if let Ok(t) = std::fs::read_to_string(sync.join("done-wide.json")) {
            break serde_json::from_str::<Value>(&t).unwrap_or(json!({"raw": t}));
        }
        // (verify-pr151) before the muster: the province declared two bells behind — the page's muster must then be
        // refused by the chain's preflight (not sent, nothing paid), in JA and EN
        if behind_at_bell.is_none() && sync.join("ready-chain-refusal").exists() {
            let now_b = r.bell();
            let behind = now_b.saturating_sub(2);
            edit(
                r,
                wprov,
                &format!(
                    "wide province ({}, {}) resolved_next = bell {behind} (two behind bell {now_b}: the muster is refused)",
                    target.p(),
                    target.q()
                ),
                &|d| d[PV1::RESOLVED_NEXT..PV1::RESOLVED_NEXT + 4].copy_from_slice(&behind.to_le_bytes()),
            );
            {
                let mut c = r.lock();
                c.set_scale(1.0);
                c.set_paused(false);
            }
            behind_at_bell = Some(now_b);
            std::fs::write(sync.join("go-chain-refusal"), behind.to_string()).unwrap();
        }
        if mustered_at_bell.is_none() && sync.join("ready-muster").exists() {
            let now_b = r.bell();
            edit(
                r,
                wprov,
                &format!(
                    "wide province ({}, {}) resolved_next = bell {now_b} (stands in for keeper A's wide-resolve)",
                    target.p(),
                    target.q()
                ),
                &|d| d[PV1::RESOLVED_NEXT..PV1::RESOLVED_NEXT + 4].copy_from_slice(&now_b.to_le_bytes()),
            );
            {
                let mut c = r.lock();
                c.set_scale(1.0);
                c.set_paused(false);
            }
            mustered_at_bell = Some(now_b);
            std::fs::write(sync.join("go-muster"), now_b.to_string()).unwrap();
        }
        if let Ok(f) = std::fs::read_to_string(sync.join("failed.txt")) {
            panic!("the page driver failed in P17: {f}");
        }
        assert!(
            driver_alive(),
            "the driver exited during the wide village's acts"
        );
        assert!(
            t0.elapsed() < Duration::from_secs(1_200),
            "the page did not finish the wide village's acts"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };
    // Every 0xDA transaction since: the page's, one signature, the wallet the fee payer, landed.
    let rows: Vec<(Value, Option<u64>)> = r
        .lock()
        .feed(0, 1_000_000, Some(&r.c.program))
        .into_iter()
        .filter(|l| l.slot > since)
        .filter_map(|l| {
            let t = fclient::tx::from_wire(&l.wire).ok()?;
            let ix = t.message.instructions.iter().find(|i| t.message.account_keys.get(i.program_id_index as usize) == Some(&r.c.program))?;
            (ix.data.first() == Some(&WIDE_TAG) && t.message.account_keys.first() == Some(&w)).then(|| {
                let from = l.pre_balances.first().zip(l.post_balances.first()).map(|(a, b)| a.saturating_sub(*b));
                (json!({"slot": l.slot, "ok": l.err.is_none(), "err": l.err, "signatures": t.signatures.len(),
                    "op": ix.data.get(3), "action": ix.data.get(4..10), "compute_units": l.units, "fee": l.fee, "lamports_from_wallet": from}), from)
            })
        })
        .collect();
    let acts = done["acts"].as_array().cloned().unwrap_or_default();
    assert_eq!(acts.len(), 5, "five acts pressed: {done:#}");
    for x in &acts {
        assert!(
            x["refused"].is_null(),
            "the page refused {}: {x:#}",
            x["label"]
        );
        assert_eq!(x["sent"]["step"], "sent", "{x:#}");
        assert_eq!(
            x["sent"]["result"]["changed"], true,
            "the result read back for {}: {x:#}",
            x["label"]
        );
    }
    assert_eq!(
        rows.len(),
        acts.len(),
        "one 0xDA transaction per act, nothing else from the wallet: {rows:#?}"
    );
    for ((row, from), x) in rows.iter().zip(&acts) {
        assert_eq!(row["ok"], true, "{row:#}");
        assert_eq!(row["signatures"], 1, "{row:#}");
        let total: u64 = x["preview"]["total"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .expect("the preview's total");
        assert_eq!(
            *from,
            Some(total),
            "{}: the wallet paid exactly the preview's total ({row:#})",
            x["label"]
        );
    }
    // The refusal before anything was signed: Insufficient, in both languages.
    for lang in ["ja", "en"] {
        assert_eq!(
            done["refusal"][lang]["code"], "Insufficient",
            "{lang}: {done:#}"
        );
    }
    // (verify-pr151) The chain's refusal of a muster on an unresolved province: the page's checks passed (a preview), the
    // send was refused before landing (NotResident), said in plain words in both languages; nothing was sent (the 0xDA
    // rows above are the five acts) and nothing was paid (below: the wallet spent exactly the five rows' debits).
    for lang in ["ja", "en"] {
        let c = &done["chainRefusal"][lang];
        assert_eq!(
            c["stage"], "send",
            "{lang}: the page's checks pass, the chain refuses: {done:#}"
        );
        // (the node's preflight "not taken" — LocalActRejected, program code 26 NotResident — or the program's name)
        assert!(
            c["code"] == "LocalActRejected" || c["code"] == "NotResident",
            "{lang}: {c:#}"
        );
        let text = c["text"].as_str().unwrap_or("");
        assert!(
            !text.is_empty() && !text.contains("NotResident") && !text.contains("Custom"),
            "{lang}: a plain sentence: {c:#}"
        );
    }
    assert!(
        done["chainRefusal"]["ja"]["text"]
            .as_str()
            .is_some_and(|t| t.chars().any(|ch| ('\u{3040}'..='\u{30ff}').contains(&ch))),
        "the Japanese refusal is Japanese: {done:#}"
    );
    assert!(
        done["chainRefusal"]["en"]["text"]
            .as_str()
            .is_some_and(|t| !t.chars().any(|ch| ('\u{3040}'..='\u{9fff}').contains(&ch))),
        "the English refusal is English: {done:#}"
    );
    // The chain: the reserve, the host, the walls, the roster.
    let after = r.data(&wholding).expect("the wide village");
    assert_eq!(
        le_u32(&after, H::reserve(0)),
        reserve0,
        "+100 trained, −100 mustered"
    );
    assert_eq!(le_u32(&after, H::HOST_SEQ), seq0 + 1, "one host issued");
    let walls1 = le_u32(&after, H::WALLS);
    let ro = r
        .lock()
        .account(&roster)
        .expect("the roster the first muster created");
    assert_eq!(ro.owner, r.c.program);
    let muster = acts.iter().find(|x| x["name"] == "WideMuster").unwrap();
    assert_eq!(muster["preview"]["rosterNew"], true, "{muster:#}");
    assert_eq!(
        muster["preview"]["deposit"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok()),
        Some(ro.lamports),
        "the preview named the roster's rent"
    );
    let post_lamports = r.lock().account(&w).map(|x| x.lamports).unwrap_or(0);
    assert_eq!(
        pre_lamports.saturating_sub(post_lamports),
        rows.iter().filter_map(|x| x.1).sum::<u64>(),
        "the wallet paid for the five acts and nothing else (the refused sends cost nothing)"
    );
    json!({
        "p17_wide_acts": "the web page as the participant: its WIDE village's Harvest, Build (item 0, walls), Train and Muster — each two presses (the SOL preview, then ONE wallet-signed send through the gateway's devnet play routes) and its result read back",
        "wide_village": {"p": target.p(), "q": target.q(), "site": site, "holding": wholding.to_string(), "province": wprov.to_string()},
        "transactions": rows.iter().map(|x| x.0.clone()).collect::<Vec<_>>(),
        "wallet_lamports": {"before": pre_lamports, "after": post_lamports, "spent": pre_lamports.saturating_sub(post_lamports)},
        "roster": {"address": roster.to_string(), "lamports": ro.lamports, "bytes": ro.data.len()},
        "reserve0": {"before": reserve0, "after": le_u32(&after, H::reserve(0))}, "host_seq": {"before": seq0, "after": le_u32(&after, H::HOST_SEQ)},
        "walls": {"before": walls0, "after": walls1},
        "declared_resolved_next_bell": mustered_at_bell,
        "declared_behind_at_bell": behind_at_bell,
        "driver": done,
    })
}
