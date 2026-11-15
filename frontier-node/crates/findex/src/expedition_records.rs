//! Opt-in typed expedition observations. Full framed transactions and required
//! pairs are validated before filtering. This is NOT manifest authentication,
//! economic replay, or verification of the original entity-chain history.
use fclient::{
    ports::TxRecord,
    typed_log::{
        decode_transaction_with_expedition, ExpeditionRecord, ProgramRecord, TransactionRecords,
    },
    Address,
};
use frontier_abi::{addr::AddrCtx, log::Link};

pub struct Record {
    pub kind: u8,
    pub bell: u32,
    pub links: Vec<Link>,
}

pub fn decode(ctx: &AddrCtx, body: &[u8]) -> Result<Option<Record>, String> {
    let Some(&kind @ 145..=149) = body.get(1) else {
        return Ok(None);
    };
    if kind == 149 {
        let r = ProgramRecord::ResidentOriginal {
            body: body.to_vec(),
        }
        .resident(ctx)
        .map_err(|e| format!("experimental resident PS2: {e:?}"))?
        .ok_or("missing resident record")?;
        if r.original_links.iter().any(|l| l.seq > i64::MAX as u64) {
            return Err("resident link sequence exceeds index range".into());
        }
        return Ok(Some(Record {
            kind,
            bell: r.bell,
            links: r.original_links,
        }));
    }
    let r = ProgramRecord::ExpeditionOriginal {
        body: body.to_vec(),
    }
    .expedition(ctx)
    .map_err(|e| format!("experimental PS2 {kind}: {e:?}"))?
    .ok_or("missing typed record")?;
    let (bell, links) = match r {
        ExpeditionRecord::LegacySource(r) => (r.source.bell, vec![r.link]),
        ExpeditionRecord::Source(r) => (r.source.bell, r.links),
        ExpeditionRecord::Producer(r) => (r.bell, vec![]),
        ExpeditionRecord::Settlement(r) => (r.bell, r.original_links),
        ExpeditionRecord::CampSettlement(r) => (r.record.bell, r.record.original_links),
    };
    if links.iter().any(|l| l.seq > i64::MAX as u64) {
        return Err("experimental link sequence exceeds index range".into());
    }
    Ok(Some(Record { kind, bell, links }))
}

pub fn transaction(
    tx: &TxRecord,
    program: &Address,
    ctx: &AddrCtx,
) -> Result<Vec<ProgramRecord>, String> {
    let decoded = match decode_transaction_with_expedition(tx, program, ctx) {
        // The decoder has already checked every invocation/exit and rejected
        // unframed data before producing this exact error. A complete unrelated
        // transaction contributes zero target records, as in the legacy reader.
        Err(fclient::typed_log::DecodeError::MissingProgramFrame) => return Ok(vec![]),
        other => other.map_err(|e| format!("typed transaction {}: {e:?}", tx.seq))?,
    };
    match decoded {
        TransactionRecords::RolledBack => Ok(vec![]),
        TransactionRecords::Committed(records) => {
            for r in &records {
                if r.format() == "PS2" {
                    match r {
                        ProgramRecord::Ps2 { .. } => {}
                        ProgramRecord::ExpeditionOriginal { body }
                            if matches!(body.get(1), Some(145..=148)) =>
                        {
                            decode(ctx, body)?.ok_or("missing expedition projection")?;
                        }
                        ProgramRecord::ResidentOriginal { body } => {
                            decode(ctx, body)?.ok_or("missing resident projection")?;
                        }
                        _ => return Err("unsupported typed PS2 family".into()),
                    }
                }
            }
            Ok(records)
        }
    }
}

pub fn account_matches_entity(data: &[u8], entity: frontier_abi::log::EntityKind) -> bool {
    data.get(..8)
        .and_then(|m| frontier_abi::layout::AccountKind::from_magic(m.try_into().ok()?))
        == Some(entity.account_kind())
}

#[cfg(test)]
#[path = "../../fclient/tests/fixtures/original_boundary.rs"]
pub(crate) mod fixture;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_frames_are_empty_but_unframed_and_broken_logs_fail() {
        let (ctx, txs) = fixture::trace();
        let p = Address::new_from_array(ctx.program);
        let mut tx = txs[0].clone();
        tx.logs = vec![
            "Program 11111111111111111111111111111111 invoke [1]".into(),
            "Program 11111111111111111111111111111111 success".into(),
        ];
        assert!(transaction(&tx, &p, &ctx).unwrap().is_empty());
        tx.logs.push("Program data: UFMy AQ==".into());
        assert!(transaction(&tx, &p, &ctx).is_err());
        tx.logs = vec!["Program 11111111111111111111111111111111 invoke [1]".into()];
        assert!(transaction(&tx, &p, &ctx).is_err());
    }
    #[test]
    fn whole_trace_validates_pairs_and_rejects_corruption() {
        let (ctx, txs) = fixture::trace();
        let program = Address::new_from_array(ctx.program);
        let mut kinds = std::collections::BTreeSet::new();
        let mut paired = false;
        for tx in &txs {
            let rs = transaction(tx, &program, &ctx).unwrap();
            for r in &rs {
                if r.format() != "PS2" {
                    continue;
                }
                if let Some(p) = decode(&ctx, r.body()).unwrap() {
                    kinds.insert(p.kind);
                    assert!(decode(&ctx, &r.body()[..r.body().len() - 1]).is_err());
                    let mut b = r.body().to_vec();
                    b[0] ^= 255;
                    assert!(decode(&ctx, &b).is_err());
                    if p.kind == 147 {
                        assert!(p.links.is_empty());
                    }
                    if p.kind == 146 {
                        assert!(matches!(p.links.len(), 2 | 3));
                        assert!(decode(
                            &AddrCtx {
                                program: [9; 32],
                                season: [8; 32]
                            },
                            r.body()
                        )
                        .is_err());
                    }
                }
            }
            if rs
                .iter()
                .any(|r| matches!(r, ProgramRecord::ExpeditionWide { .. }))
            {
                paired = true;
                let mut bad = tx.clone();
                bad.logs
                    .retain(|l| !l.starts_with("Program data: UFNXMQ== "));
                assert!(transaction(&bad, &program, &ctx).is_err());
            }
        }
        assert!(paired);
        for k in [146, 147, 148, 149] {
            assert!(kinds.contains(&k));
        }
    }
}

#[cfg(test)]
pub(crate) fn browser_trace() -> (AddrCtx, Vec<TxRecord>) {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("../tests/fixtures/browser_depart_v1.json");
    assert_eq!(
        hex::encode(Sha256::digest(bytes)),
        "089863eb038fff939507f726f8c9a8e476616f3044dc244655be30d9a1ba4c99"
    );
    let p: Address = "5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn"
        .parse()
        .unwrap();
    let rows: Vec<serde_json::Value> = serde_json::from_slice(bytes).unwrap();
    (
        crate::addr_ctx(&p, 11),
        rows.iter()
            .map(|r| crate::archive::record_from_json(r).unwrap())
            .collect(),
    )
}
