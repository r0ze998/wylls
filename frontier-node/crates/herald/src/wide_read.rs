//! Read-only views over an explicitly configured typed index. Its event keys
//! are observations, not terrain; account captures remain unverified.
use crate::{
    files::Out,
    fold::{Fold, FoldCfg},
    runner::IngestCfg,
    server::App,
};
use axum::http::StatusCode;
use base64::Engine;
use findex::wide_index::{ObservedEvent, WideReader};
use frontier_abi::world_index::{ProvinceKey, WideHostRef, WorldId};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

type Fault = (StatusCode, &'static str);
fn fault(code: &'static str) -> Fault {
    (StatusCode::SERVICE_UNAVAILABLE, code)
}
fn scoped(app: &App) -> Result<(WideReader, Value), Fault> {
    if app.season.cluster.trim().eq_ignore_ascii_case("fixture") {
        return Err(fault("FixtureWorldUnavailable"));
    }
    let path = app
        .wide_index
        .as_ref()
        .ok_or(fault("WideIndexUnavailable"))?;
    let f = app.fold.read().map_err(|_| fault("WideIndexUnavailable"))?;
    let world = WorldId::derive_legacy_season(&f.ctx.season, &f.cfg.program.to_bytes())
        .map_err(|_| fault("WideIndexScopeMismatch"))?;
    let reader =
        WideReader::open(path, f.cfg.program, world).map_err(|_| fault("WideIndexUnreadable"))?;
    let scope = json!({"v":1,"experimental":true,"readOnly":true,"program":f.cfg.program.to_string(),
        "season":f.cfg.season_id.to_string(),"seasonAddress":solana_address::Address::new_from_array(f.ctx.season).to_string(),
        "world":hex::encode(world.as_bytes()),"sourceCoverage":"unknown","captureVerification":"unverified"});
    Ok((reader, scope))
}
pub fn status_json(app: &App) -> Result<Value, Fault> {
    let (reader, mut v) = scoped(app)?;
    let status = reader.status().map_err(|_| fault("WideIndexUnreadable"))?;
    v["state"] = json!(if status.blocked.is_some() {
        "blocked"
    } else if status.caught_up {
        "observed"
    } else {
        "incomplete"
    });
    v["indexedThrough"] = json!(status.last_seq.to_string());
    v["snapshot"] = json!(hex::encode(status.snapshot));
    v["caughtUp"] = json!(status.caught_up && status.blocked.is_none());
    v["automaticWrites"] = json!(false);
    Ok(v)
}
fn decimal(s: &str) -> Option<u64> {
    let n = s.parse::<u64>().ok()?;
    (n.to_string() == s).then_some(n)
}
fn province(bytes: &[u8]) -> Result<Value, Fault> {
    let p = ProvinceKey::from_bytes(bytes).map_err(|_| fault("WideIndexCorrupt"))?;
    Ok(
        json!({"world":hex::encode(p.world().as_bytes()),"p":p.coord().p().to_string(),"q":p.coord().q().to_string(),"keyHex":hex::encode(bytes)}),
    )
}
fn host(bytes: &[u8]) -> Result<Value, Fault> {
    let h = WideHostRef::from_bytes(bytes).map_err(|_| fault("WideIndexCorrupt"))?;
    let mut v = province(&h.key().to_bytes())?;
    v["keyHex"] = json!(hex::encode(bytes));
    v["site"] = json!(h.site());
    v["generation"] = json!(h.gen());
    v["hostSequence"] = json!(h.seq());
    Ok(v)
}
fn event(
    row: ObservedEvent,
    world: &str,
    through: u64,
    ctx: &frontier_abi::addr::AddrCtx,
) -> Result<Value, Fault> {
    if row.archive_seq == 0 || row.archive_seq > through || row.ordinal > i64::MAX as u64 {
        return Err(fault("WideIndexCorrupt"));
    }
    // Revalidate the stored body and attribution instead of trusting a corrupt cache.
    let mut v = json!({"event":row.event.to_string(),"archiveSequence":row.archive_seq.to_string(),"ordinal":row.ordinal.to_string(),"format":row.format,"body_b64":base64::engine::general_purpose::STANDARD.encode(&row.body)});
    if (row.format == "PS2" && matches!(row.body.get(1), Some(145..=148)))
        || (row.format == "PSW1" && row.body.get(1) == Some(&25))
    {
        use fclient::typed_log::{ExpeditionRecord, ProgramRecord};
        use frontier_abi::world_index::{
            expedition_event as source, expedition_producer_event as producer,
            legacy_source_event::Direction,
        };
        let record = if row.format == "PS2" {
            ProgramRecord::ExpeditionOriginal {
                body: row.body.clone(),
            }
        } else {
            ProgramRecord::ExpeditionWide {
                body: row.body.clone(),
            }
        };
        let r = record
            .expedition(ctx)
            .map_err(|_| fault("WideIndexCorrupt"))?
            .ok_or(fault("WideIndexCorrupt"))?;
        if row.province != Some(r.province().to_bytes().to_vec())
            || row.host != r.host().map(|h| h.to_bytes().to_vec())
            || row.holding.is_some()
            || hex::encode(r.province().world().as_bytes()) != world
        {
            return Err(fault("WideIndexCorrupt"));
        }
        v["kind"] = json!(row.body[1]);
        v["name"] = json!(match &r {
            ExpeditionRecord::LegacySource(r) => match r.source.direction {
                Direction::Debit => "ORIGINAL_CONQUEST_DEBIT",
                Direction::Credit => "ORIGINAL_CONQUEST_CREDIT",
            },
            ExpeditionRecord::Source(r) => match r.source.receipt.action {
                source::Action::Depart => "ORIGINAL_EXPEDITION_DEPART",
                source::Action::SettleOrigin => "ORIGINAL_EXPEDITION_SETTLE_ORIGIN",
            },
            ExpeditionRecord::Producer(r) => match r.target.action() {
                producer::Action::Reveal => "ORIGINAL_EXPEDITION_REVEAL",
                producer::Action::Gather => "ORIGINAL_EXPEDITION_GATHER",
            },
            ExpeditionRecord::Settlement(r) =>
                if r.wide_link.is_some() {
                    "WIDE_ORIGINAL_EXPEDITION_SETTLE_MEMBER"
                } else {
                    "ORIGINAL_EXPEDITION_SETTLE_MEMBER"
                },
            ExpeditionRecord::CampSettlement(r) =>
                if r.record.wide_link.is_some() {
                    "WIDE_ORIGINAL_EXPEDITION_SETTLE_CAMP"
                } else {
                    "ORIGINAL_EXPEDITION_SETTLE_CAMP"
                },
        });
        v["expedition"] = json!({"observationOnly":true,"receiptVerification":"unverified","sourceVerification":"unverified","originalChainVerification":"unverified"});
        v["originalHost"] = r
            .host()
            .map(|h| host(&h.to_bytes()))
            .transpose()?
            .unwrap_or(Value::Null);
        let (origin, destination) = match &r {
            ExpeditionRecord::Source(r) => (Some(r.source.identity.origin), None),
            ExpeditionRecord::LegacySource(_) => (None, None),
            _ => (None, Some(r.province())),
        };
        v["originProvince"] = origin
            .map(|p| province(&p.to_bytes()))
            .transpose()?
            .unwrap_or(Value::Null);
        v["destinationProvince"] = destination
            .map(|p| province(&p.to_bytes()))
            .transpose()?
            .unwrap_or(Value::Null);
    } else if row.format == "PSWC" {
        let r = frontier_abi::world_index::event::conquest::SidecarClose::decode(&row.body)
            .map_err(|_| fault("WideIndexCorrupt"))?;
        if r.season != ctx.season
            || row.province.is_some()
            || row.host.is_some()
            || row.holding.is_some()
        {
            return Err(fault("WideIndexCorrupt"));
        }
        v["kind"] = Value::Null;
        v["action"] = json!(7);
        v["name"] = json!("WIDE_CONQUEST_SIDECAR_CLOSED");
        v["citizenAddress"] = json!(solana_address::Address::new_from_array(r.citizen).to_string());
        v["receiptVerification"] = json!("unverified");
    } else if (row.format == "PS2" && row.body.get(1) == Some(&149))
        || (row.format == "PSW1" && row.body.get(1) == Some(&26))
    {
        use frontier_abi::world_index::expedition_resident_event::{Action, Record};
        let r = Record::decode(ctx, &row.body).map_err(|_| fault("WideIndexCorrupt"))?;
        if (row.format == "PSW1") != r.wide_link.is_some()
            || row.province != Some(r.identity.standing.to_bytes().to_vec())
            || row.host != Some(r.identity.host.to_bytes().to_vec())
            || row.holding.is_some()
            || hex::encode(r.identity.standing.world().as_bytes()) != world
        {
            return Err(fault("WideIndexCorrupt"));
        }
        v["kind"] = json!(row.body[1]);
        v["name"] = json!(match (r.wide_link.is_some(), r.action) {
            (false, Action::Dissolve) => "ORIGINAL_RESIDENT_DISSOLVE",
            (false, Action::Return) => "ORIGINAL_RESIDENT_RETURN",
            (true, Action::Dissolve) => "WIDE_ORIGINAL_RESIDENT_DISSOLVE",
            (true, Action::Return) => "WIDE_ORIGINAL_RESIDENT_RETURN",
        });
    } else if row.format == "PSW1" {
        let r = frontier_abi::world_index::event::WideRecord::decode(&row.body)
            .map_err(|_| fault("WideIndexCorrupt"))?;
        if row.province != r.province_of().map(|p| p.to_bytes().to_vec())
            || row.holding != r.holding_of().map(|h| h.to_bytes().to_vec())
            || row.host != r.host().map(|h| h.to_bytes().to_vec())
        {
            return Err(fault("WideIndexCorrupt"));
        }
        if r.province_of()
            .is_none_or(|p| hex::encode(p.world().as_bytes()) != world)
        {
            return Err(fault("WideIndexScopeMismatch"));
        }
        v["kind"] = json!(r.kind as u8);
        v["name"] = json!(r.kind.name());
    } else if row.format == "PS2" {
        let r =
            fclient::log::Record::decode_v2(&row.body).map_err(|_| fault("WideIndexCorrupt"))?;
        if row.province.is_some() || row.holding.is_some() || row.host.is_some() {
            return Err(fault("WideIndexCorrupt"));
        }
        v["kind"] = json!(r.kind);
        v["name"] = json!("PS2");
    } else {
        return Err(fault("WideIndexCorrupt"));
    }
    v["province"] = row
        .province
        .as_deref()
        .map(province)
        .transpose()?
        .unwrap_or(Value::Null);
    v["holding"] = row
        .holding
        .as_deref()
        .map(host)
        .transpose()?
        .unwrap_or(Value::Null);
    v["host"] = row
        .host
        .as_deref()
        .map(host)
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(v)
}
pub fn events_json(app: &App, q: &HashMap<String, String>) -> Result<Value, Fault> {
    let bad = (StatusCode::BAD_REQUEST, "BadWideCursor");
    let after = decimal(q.get("after").map(String::as_str).unwrap_or("0")).ok_or(bad)?;
    let through = q.get("through").and_then(|s| decimal(s)).ok_or(bad)?;
    let limit = q.get("limit").and_then(|s| decimal(s)).unwrap_or(20);
    if !(1..=256).contains(&limit) || q.get("limit").is_some_and(|s| decimal(s).is_none()) {
        return Err((StatusCode::BAD_REQUEST, "BadLimit"));
    }
    let snapshot: [u8; 32] = q
        .get("snapshot")
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .and_then(|s| hex::decode(s).ok())
        .and_then(|b| b.try_into().ok())
        .ok_or(bad)?;
    let (reader, mut v) = scoped(app)?;
    let state = reader.status().map_err(|_| fault("WideIndexUnreadable"))?;
    if state.blocked.is_some() {
        return Err(fault("WideIndexBlocked"));
    }
    if !state.caught_up {
        return Err(fault("WideIndexIncomplete"));
    }
    let page = reader
        .events(after, limit as usize, through, snapshot)
        .map_err(|e| match e.as_str() {
            "WideIndexChanged" => (StatusCode::CONFLICT, "WideIndexChanged"),
            "BadWideCursor" => bad,
            _ => fault("WideIndexUnreadable"),
        })?;
    v["indexedThrough"] = json!(page.indexed_through.to_string());
    v["snapshot"] = json!(hex::encode(page.snapshot));
    v["after"] = json!(after.to_string());
    v["next"] = json!(page.next.to_string());
    v["more"] = json!(page.more);
    v["limit"] = json!(limit);
    let ctx = app
        .fold
        .read()
        .map_err(|_| fault("WideIndexUnavailable"))?
        .ctx;
    v["events"] = Value::Array(
        page.events
            .into_iter()
            .map(|row| event(row, v["world"].as_str().unwrap_or(""), through, &ctx))
            .collect::<Result<Vec<_>, _>>()?,
    );
    Ok(v)
}

/// Serve an existing checkpoint without opening/repairing an ingest store.
/// Missing/damaged checkpoints are an error, never an empty replacement world.
pub fn load_read_only_fold(cfg: &IngestCfg) -> Result<Arc<RwLock<Fold>>, String> {
    let (st, cq) = crate::checkpoint::load_full(
        &cfg.checkpoint_path(),
        &cfg.program.to_bytes(),
        cfg.season_id,
    )
    .ok_or("read-only mode requires a valid matching herald.ckpt")?;
    let mut f = Fold::with_state(
        FoldCfg {
            program: cfg.program,
            season_id: cfg.season_id,
            builder: cfg.builder.clone(),
            exact_post: false,
        },
        Out::new(cfg.files_dir()),
        st,
    );
    if let Some(bytes) = cq {
        f.cq = serde_json::from_slice(&bytes)
            .ok()
            .and_then(|v| crate::conquest::Cq::from_json(&v))
            .ok_or("read-only checkpoint conquest section invalid")?;
    }
    f.ingest.stopped = true;
    f.ingest.coverage = Some(json!({"state":"unknown","mode":"checkpoint-read-only"}));
    Ok(Arc::new(RwLock::new(f)))
}

#[cfg(test)]
#[path = "../../fclient/tests/fixtures/resident.rs"]
mod resident_fixture;
#[cfg(test)]
mod resident_tests {
    use super::*;
    #[test]
    fn resident_rows_are_raw_scoped_and_never_wide_holdings() {
        use frontier_abi::world_index::expedition_resident_event::{Action, Record};
        let ctx = resident_fixture::ctx();
        for action in [Action::Dissolve, Action::Return] {
            let (a, b) = resident_fixture::pair(action, resident_fixture::zero());
            for (format, body) in [("PS2", a), ("PSW1", b)] {
                let r = Record::decode(&ctx, &body).unwrap();
                let world = hex::encode(r.identity.standing.world().as_bytes());
                let row = ObservedEvent {
                    event: 1,
                    archive_seq: 1,
                    ordinal: 0,
                    format: format.into(),
                    body,
                    province: Some(r.identity.standing.to_bytes().to_vec()),
                    holding: None,
                    host: Some(r.identity.host.to_bytes().to_vec()),
                };
                let value = event(row.clone(), &world, 1, &ctx).unwrap();
                assert!(value["name"]
                    .as_str()
                    .unwrap()
                    .contains("ORIGINAL_RESIDENT_"));
                assert!(value["holding"].is_null());
                assert_eq!(
                    value["host"]["keyHex"],
                    hex::encode(r.identity.host.to_bytes())
                );
                let mut bad = row.clone();
                bad.holding = bad.host.clone();
                assert!(event(bad, &world, 1, &ctx).is_err());
                let mut bad = row;
                bad.body[8] = 1;
                assert!(event(bad, &world, 1, &ctx).is_err());
            }
        }
    }
}

#[cfg(test)]
#[path = "../../fclient/tests/fixtures/original_boundary.rs"]
mod expedition_fixture;
#[cfg(test)]
mod expedition_tests {
    use super::*;
    #[test]
    fn native_scoped_rows_preserve_identity_and_explicit_unverified_metadata() {
        use fclient::typed_log::{decode_transaction_with_expedition, TransactionRecords};
        let (c, txs) = super::expedition_fixture::trace();
        let p = solana_address::Address::new_from_array(c.program);
        let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
        for tx in txs {
            let TransactionRecords::Committed(records) =
                decode_transaction_with_expedition(&tx, &p, &c).unwrap()
            else {
                panic!()
            };
            for r in records {
                let Some(x) = r.expedition(&c).unwrap() else {
                    continue;
                };
                let row = ObservedEvent {
                    event: 1,
                    archive_seq: 1,
                    ordinal: 0,
                    format: r.format().into(),
                    body: r.body().to_vec(),
                    province: Some(x.province().to_bytes().to_vec()),
                    holding: None,
                    host: x.host().map(|h| h.to_bytes().to_vec()),
                };
                let value = event(row.clone(), &hex::encode(world.as_bytes()), 1, &c).unwrap();
                assert!(value["holding"].is_null());
                assert_eq!(value["expedition"]["sourceVerification"], "unverified");
                assert_eq!(
                    value["expedition"]["originalChainVerification"],
                    "unverified"
                );
                let mut bad = row.clone();
                bad.holding = bad.province.clone();
                assert!(event(bad, &hex::encode(world.as_bytes()), 1, &c).is_err());
            }
        }
    }
    #[test]
    fn sidecar_has_no_invented_province_kind_or_host() {
        use frontier_abi::world_index::event::conquest::{Receipt, SidecarClose, ESCROW_CLOSE};
        let c = super::resident_fixture::ctx();
        let world = WorldId::derive_legacy_season(&c.season, &c.program).unwrap();
        let r = SidecarClose {
            season: c.season,
            citizen: [9; 32],
            bell: 10,
            receipt: Receipt::new(ESCROW_CLOSE, 0, [1; 32], [2; 32]).unwrap(),
        };
        let row = ObservedEvent {
            event: 1,
            archive_seq: 1,
            ordinal: 0,
            format: "PSWC".into(),
            body: r.encode().unwrap().to_vec(),
            province: None,
            holding: None,
            host: None,
        };
        let value = event(row.clone(), &hex::encode(world.as_bytes()), 1, &c).unwrap();
        assert!(value["kind"].is_null());
        assert_eq!(value["action"], 7);
        assert_eq!(value["name"], "WIDE_CONQUEST_SIDECAR_CLOSED");
        for k in ["province", "holding", "host"] {
            assert!(value[k].is_null());
        }
        let mut bad = row;
        bad.body[1] ^= 1;
        assert!(event(bad, &hex::encode(world.as_bytes()), 1, &c).is_err());
    }
}

#[cfg(test)]
#[path = "../../fclient/tests/fixtures/camp_observation.rs"]
mod camp_fixture;
#[cfg(test)]
mod camp_tests {
    use super::*;
    #[test]
    fn camp_rows_keep_exact_version_citizen_and_unverified_metadata() {
        use frontier_abi::world_index::expedition_settlement_event::camp_v2::CampRecord;
        let ctx = camp_fixture::ctx();
        let (a, b, _) = camp_fixture::pair(camp_fixture::zero());
        let world = hex::encode(camp_fixture::province().world().as_bytes());
        for (format, body, name) in [
            ("PS2", a, "ORIGINAL_EXPEDITION_SETTLE_CAMP"),
            ("PSW1", b, "WIDE_ORIGINAL_EXPEDITION_SETTLE_CAMP"),
        ] {
            let r = CampRecord::decode(&ctx, &body).unwrap().record;
            let row = ObservedEvent {
                event: 1,
                archive_seq: 1,
                ordinal: 0,
                format: format.into(),
                body,
                province: Some(r.identity.destination.to_bytes().to_vec()),
                holding: None,
                host: Some(r.identity.host.to_bytes().to_vec()),
            };
            let v = event(row.clone(), &world, 1, &ctx).unwrap();
            assert_eq!(v["name"], name);
            assert_eq!(v["expedition"]["observationOnly"], true);
            for field in [
                "receiptVerification",
                "sourceVerification",
                "originalChainVerification",
            ] {
                assert_eq!(v["expedition"][field], "unverified");
            }
            assert_eq!(
                v["body_b64"],
                base64::engine::general_purpose::STANDARD.encode(&row.body)
            );
            assert_eq!(r.identity.citizen, Some([7; 32]));
            assert!(v["holding"].is_null());
            let mut bad = row.clone();
            bad.holding = bad.host.clone();
            assert!(event(bad, &world, 1, &ctx).is_err());
            let mut bad = row;
            bad.body[6] = 1;
            assert!(event(bad, &world, 1, &ctx).is_err());
        }
    }
}
