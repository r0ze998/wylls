use crate::engine::{hex, Sandbox, GENESIS};
use frontier_abi::world_index::{WideHolding, WideProvince};
use permutation_frontier::layout::{holding as H, province as PV, Ro};
use std::fmt::Write;
pub struct Controller {
    pub sandbox: Sandbox,
    pub revision: u64,
}
impl Controller {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            sandbox: Sandbox::new()?,
            revision: 0,
        })
    }
    pub fn reject(&self, error: &str) -> Result<String, String> {
        self.render("refused", Some(error), "invalid", false)
    }
    pub fn exchange(&mut self, line: &str) -> Result<String, String> {
        self.exchange_with_limit(line, 1_048_576)
    }
    fn exchange_with_limit(&mut self, line: &str, limit: usize) -> Result<String, String> {
        if line.len() > 128 || !line.bytes().all(|b| (32..=126).contains(&b)) {
            return self.reject("BAD_COMMAND");
        }
        if line == "get" {
            return self.render("ok", None, "get", false);
        }
        let (cmd, rev) = match line.split_once(' ') {
            Some(v) => v,
            None => return self.reject("BAD_COMMAND"),
        };
        if ![
            "reset",
            "depart",
            "train",
            "settle_departure",
            "post_reveal",
            "resolve_arrival",
            "settle_transit",
            "dissolve_return",
        ]
        .contains(&cmd)
            || rev.is_empty()
            || rev.len() > 7
            || (rev.len() > 1 && rev.starts_with('0'))
            || !rev.bytes().all(|b| b.is_ascii_digit())
        {
            return self.reject("BAD_COMMAND");
        }
        if rev.parse::<u64>().ok() != Some(self.revision) {
            return self.render("refused", Some("STALE_REVISION"), cmd, false);
        }
        if self.revision >= 1_000_000 {
            return self.render("refused", Some("REVISION_LIMIT"), cmd, false);
        }
        let mut candidate = Self {
            sandbox: self.sandbox.clone(),
            revision: self.revision + 1,
        };
        let outcome = if cmd == "reset" {
            match Sandbox::new() {
                Ok(x) => {
                    candidate.sandbox = x;
                    Ok(())
                }
                Err(e) => Err(e),
            }
        } else {
            candidate.sandbox.apply(cmd)
        };
        match outcome {
            Ok(()) => {
                let reply = candidate.render("ok", None, cmd, cmd != "reset")?;
                if reply.len() > limit {
                    return self.render("fault", Some("RESPONSE_LIMIT"), cmd, false);
                }
                *self = candidate;
                Ok(reply)
            }
            Err(e) => {
                eprintln!("local_march_demo: {cmd}: {e}");
                let token = if e == "BAD_PHASE" {
                    "BAD_PHASE"
                } else if e.starts_with("Refused_") {
                    "HANDLER_REFUSED"
                } else {
                    "EXECUTION_FAULT"
                };
                self.render(
                    if token == "EXECUTION_FAULT" {
                        "fault"
                    } else {
                        "refused"
                    },
                    Some(token),
                    cmd,
                    false,
                )
            }
        }
    }
    fn render(
        &self,
        status: &str,
        error: Option<&str>,
        command: &str,
        new_records: bool,
    ) -> Result<String, String> {
        let s = &self.sandbox;
        let hd = s.data("holding")?;
        let h = WideHolding::read(hd).map_err(|_| "HOLDING")?;
        let hr = Ro(hd);
        let host = s.host()?;
        let origin = WideProvince::read(s.data("origin")?).map_err(|_| "ORIGIN")?;
        let dest = WideProvince::read(s.data("destination")?).map_err(|_| "DESTINATION")?;
        let mut out = String::with_capacity(65536);
        write!(out,"{{\"protocol\":\"wylls-local-march-v1\",\"mode\":\"local-only\",\"auth\":\"MOCK_AUTH_NO_SIGNATURE\",\"beacon\":\"PUBLIC_FIXTURES_REAL_VERIFICATION\",\"session\":\"separate-march-same-holding-train\",\"status\":\"{status}\",\"error\":{},\"command\":\"{command}\",\"revision\":{},\"phase\":\"{}\",\"trained\":{},\"allowed\":[",error.map_or("null".into(),|s|format!("\"{s}\"")),self.revision,s.phase,s.trained).unwrap();
        for (i, a) in s.allowed().iter().enumerate() {
            if i > 0 {
                out.push(',')
            }
            write!(out, "\"{a}\"").unwrap()
        }
        write!(out,"],\"clock\":{{\"unix\":\"{}\",\"bell\":{}}},\"map\":{{\"worldHex\":\"{}\",\"origin\":{{\"p\":\"{}\",\"q\":\"{}\"}},\"destination\":{{\"p\":\"{}\",\"q\":\"{}\"}},\"route\":[",s.now,(s.now-GENESIS)/600,hex(origin.world.as_bytes()),origin.coord.p(),origin.coord.q(),dest.coord.p(),dest.coord.q()).unwrap();
        for (i, step) in s.meta.get("route").ok_or("ROUTE")?.split(';').enumerate() {
            let p: Vec<_> = step.split(',').collect();
            if p.len() != 3 {
                return Err("ROUTE".into());
            }
            let (a, b, t) = (
                p[0].parse::<i64>().map_err(|_| "ROUTE")?,
                p[1].parse::<i64>().map_err(|_| "ROUTE")?,
                p[2].parse::<u8>().map_err(|_| "ROUTE")?,
            );
            if i > 0 {
                out.push(',')
            }
            write!(out, "{{\"p\":\"{a}\",\"q\":\"{b}\",\"tile\":{t}}}").unwrap()
        }
        out.push_str("],\"provinces\":[");
        for (i, (n, p)) in [("origin", origin), ("destination", dest)]
            .iter()
            .enumerate()
        {
            if i > 0 {
                out.push(',')
            }
            write!(
                out,
                "{{\"p\":\"{}\",\"q\":\"{}\",\"accountKeyHex\":\"{}\",\"passableMask\":\"{}\"}}",
                p.coord.p(),
                p.coord.q(),
                hex(&s.images[*n].key),
                Ro(s.data(n)?).u64(PV::PASSABLE_MASK).map_err(|_| "MASK")?
            )
            .unwrap()
        }
        let transit = match s.phase {
            "ready" => "absent",
            "departed" => "departed",
            "travelling" | "revealed" | "resolved" => "settled",
            _ => "closed",
        };
        let fate = if s.arrival_survivors.is_some() {
            "1"
        } else {
            "null"
        }; // replaced below with the ABI constant, never inferred by UI
        let fate = if fate == "1" {
            frontier_abi::world_index::arrival::wide_arrival::FATE_STAYS.to_string()
        } else {
            "null".into()
        };
        let engagements = s.engagements;
        write!(out," ]}},\"host\":{{\"refHex\":\"{}\",\"originTile\":{},\"destinationTile\":{},\"initialMilli\":300000,\"currentMilli\":{},\"transitState\":\"{transit}\",\"fate\":{fate}}},\"holding\":{{\"accountKeyHex\":\"{}\",\"tile\":{},\"reserveUnits\":{},\"escrowLamports\":\"{}\",\"poolOwedLamports\":\"{}\",\"openTransits\":{}}},\"combat\":{{\"engagements\":{engagements},\"arrivalSurvivorMilli\":{},\"enemyFixture\":true}},\"returned\":{{\"creditedUnits\":{},\"creditedMilli\":{}}},\"evidence\":{{\"instructions\":[",hex(&host.to_bytes()),s.num("origin_tile")?,s.num("destination_tile")?,s.current_milli()?,hex(&s.images["holding"].key),hd[H::TILE],hr.u32(H::reserve(0)).map_err(|_|"HOLDING")?,hr.u64(H::ESCROW).map_err(|_|"HOLDING")?,hr.u64(H::POOL_OWED).map_err(|_|"HOLDING")?,h.open_transits,s.arrival_survivors.map_or("null".into(),|x|x.to_string()),s.credited,s.credited*1000).unwrap();
        if new_records {
            for (i, n) in s.instructions.iter().enumerate() {
                if i > 0 {
                    out.push(',')
                }
                write!(out, "\"{n}\"").unwrap()
            }
        }
        out.push_str("],\"recordsHex\":[");
        if new_records {
            for (i, r) in s.records.iter().enumerate() {
                if i > 0 {
                    out.push(',')
                }
                write!(out, "\"{}\"", hex(r)).unwrap()
            }
        }
        out.push_str("],\"accounts\":[");
        for (i, a) in s.images.values().enumerate() {
            if i > 0 {
                out.push(',')
            }
            write!(
                out,
                "{{\"keyHex\":\"{}\",\"ownerHex\":\"{}\",\"lamports\":\"{}\",\"dataHex\":\"{}\"}}",
                hex(&a.key),
                hex(&a.owner),
                a.lamports,
                hex(&a.data)
            )
            .unwrap()
        }
        out.push_str("]}}");
        Ok(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn finish(train: bool) -> Controller {
        let mut c = Controller::new().unwrap();
        for cmd in [
            "depart",
            "train",
            "settle_departure",
            "post_reveal",
            "resolve_arrival",
            "settle_transit",
            "dissolve_return",
        ] {
            if cmd == "train" && !train {
                continue;
            }
            let reply = c.exchange(&format!("{cmd} {}", c.revision)).unwrap();
            assert!(
                reply.contains("\"status\":\"ok\""),
                "phase {cmd} failed; see stderr"
            );
        }
        c
    }
    #[test]
    fn real_full_sequence_with_train() {
        let c = finish(true);
        assert_eq!(c.sandbox.phase, "returned");
        assert!(c.sandbox.credited > 0 && c.sandbox.credited < 300);
        assert!(c.sandbox.trained);
        assert!(c.sandbox.engagements > 0);
    }
    #[test]
    fn real_full_sequence_without_train() {
        let c = finish(false);
        assert_eq!(c.sandbox.phase, "returned");
        assert!(!c.sandbox.trained);
    }
    #[test]
    fn refuses_stale_invalid_phase_and_bad_command_without_mutation() {
        let mut c = Controller::new().unwrap();
        let pre = c.sandbox.images.clone();
        for cmd in [
            "depart 1",
            "settle_transit 0",
            "train 0",
            "depart 00",
            "run 0",
            "depart 0 extra",
        ] {
            let r = c.exchange(cmd).unwrap();
            assert!(r.contains("\"status\":\"refused\""));
            assert_eq!(c.sandbox.images, pre);
            assert_eq!(c.revision, 0)
        }
    }
    #[test]
    fn refuses_failed_depart_without_committing() {
        let mut c = Controller::new().unwrap();
        c.sandbox.images.get_mut("payer").unwrap().lamports = 0;
        let pre = c.sandbox.images.clone();
        let r = c.exchange("depart 0").unwrap();
        assert!(!r.contains("\"status\":\"ok\""));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.revision, 0);
    }
    #[test]
    fn settlement_binding_mismatch_rolls_back() {
        let mut c = Controller::new().unwrap();
        for cmd in [
            "depart",
            "settle_departure",
            "post_reveal",
            "resolve_arrival",
        ] {
            let r = c.exchange(&format!("{cmd} {}", c.revision)).unwrap();
            assert!(r.contains("\"status\":\"ok\""), "{cmd}")
        }
        c.sandbox.meta.insert("commit".into(), "00".repeat(32));
        let pre = c.sandbox.images.clone();
        let rev = c.revision;
        let r = c.exchange(&format!("settle_transit {rev}")).unwrap();
        assert!(!r.contains("\"status\":\"ok\""));
        assert_eq!(pre, c.sandbox.images);
        assert_eq!(rev, c.revision);
    }
}

#[cfg(test)]
mod atomic_tests {
    use super::*;
    #[test]
    fn oversized_render_does_not_commit_successful_depart() {
        let mut c = Controller::new().unwrap();
        let pre = c.sandbox.images.clone();
        let old = c.sandbox.now;
        let r = c.exchange_with_limit("depart 0", 1).unwrap();
        assert!(r.contains("RESPONSE_LIMIT"));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.sandbox.now, old);
        assert_eq!(c.sandbox.phase, "ready");
        assert_eq!(c.revision, 0);
    }
    #[test]
    fn middle_phase_refusal_discards_seed_gather_clock_and_receipts() {
        let mut c = Controller::new().unwrap();
        for cmd in ["depart", "settle_departure", "post_reveal"] {
            let r = c.exchange(&format!("{cmd} {}", c.revision)).unwrap();
            assert!(r.contains("\"status\":\"ok\""));
        }
        let off = frontier_abi::v2::layout::province::province::SCORE_NEXT_BELL;
        c.sandbox.images.get_mut("destination").unwrap().data[off..off + 4]
            .copy_from_slice(&0u32.to_le_bytes());
        let pre = c.sandbox.images.clone();
        let old = c.sandbox.now;
        let rev = c.revision;
        let r = c.exchange(&format!("resolve_arrival {rev}")).unwrap();
        assert!(r.contains("HANDLER_REFUSED"));
        assert_eq!(c.sandbox.images, pre);
        assert_eq!(c.sandbox.now, old);
        assert_eq!(c.sandbox.phase, "revealed");
        assert_eq!(c.revision, rev);
        assert!(r.contains("\"recordsHex\":[]"));
    }
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    #[test]
    fn departed_projects_pending_origin_troops() {
        let mut c = Controller::new().unwrap();
        let r = c.exchange("depart 0").unwrap();
        assert!(r.contains("\"status\":\"ok\""));
        assert_eq!(c.sandbox.current_milli().unwrap(), 300000);
    }
}
