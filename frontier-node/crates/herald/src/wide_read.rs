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
fn event(row: ObservedEvent, world: &str, through: u64) -> Result<Value, Fault> {
    if row.archive_seq == 0 || row.archive_seq > through || row.ordinal > i64::MAX as u64 {
        return Err(fault("WideIndexCorrupt"));
    }
    // Revalidate the stored body and attribution instead of trusting a corrupt cache.
    let mut v = json!({"event":row.event.to_string(),"archiveSequence":row.archive_seq.to_string(),"ordinal":row.ordinal.to_string(),"format":row.format,"body_b64":base64::engine::general_purpose::STANDARD.encode(&row.body)});
    if row.format == "PSW1" {
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
    v["events"] = Value::Array(
        page.events
            .into_iter()
            .map(|row| event(row, v["world"].as_str().unwrap_or(""), through))
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
