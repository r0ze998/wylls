//! What the fleet did and what it saw, for the stack report (E5 criterion
//! 5: "every persona's expected outcome observed"; criterion 7: bot
//! outcome statistics, reported). Every sent action is one [`Outcome`];
//! the report counts them by group (archetype or persona), action and
//! result, and judges the personas whose expected outcome a bot can see
//! itself (a refusal it receives). The rest need the chain's final state
//! and are left `needs-chain` for the stack report and the verifier.

use std::collections::{BTreeMap, BTreeSet};

use frontier_agents::cqpersona::{CqPersona, Expect};
use frontier_agents::policy::SealKind;
use frontier_agents::{Arch, Persona};
use serde_json::{json, Value};

/// One action's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub bot: u32,
    pub arch: Arch,
    pub persona: Option<Persona>,
    /// The intent (`policy::Intent::name`).
    pub action: &'static str,
    /// `relay`, `keeper`, `direct`, `herald`, `local`.
    pub route: &'static str,
    pub ok: bool,
    /// HTTP status (0 for a direct transaction).
    pub status: u16,
    /// Refusal code (relay code name, keeper code, program error name).
    pub code: Option<String>,
    pub signature: Option<String>,
    /// Persona detail (e.g. `late`, `forged`, `zero_tip`).
    pub tag: Option<&'static str>,
}

impl Outcome {
    pub fn result(&self) -> String {
        if self.ok {
            "ok".into()
        } else {
            self.code
                .clone()
                .unwrap_or_else(|| format!("http_{}", self.status))
        }
    }
}

/// A persona's verdict from what its bots saw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The expected refusal was seen and nothing contradicted it.
    Observed,
    /// Something the contract says must not happen happened (e.g. a late
    /// reveal accepted).
    Violated,
    /// The persona has not reached its test yet.
    Pending,
    /// Only the chain can tell (stack report, verifier).
    NeedsChain,
}

impl Verdict {
    pub fn name(self) -> &'static str {
        match self {
            Verdict::Observed => "observed",
            Verdict::Violated => "violated",
            Verdict::Pending => "pending",
            Verdict::NeedsChain => "needs-chain",
        }
    }
}

/// A march that settled with no REVEAL observed (W6T-3, w6-s7 R4: the
/// bots journalled `revealed` on the relay's 202 and never learnt that 27
/// honest Reveals were refused `Shielded`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unrevealed {
    pub bot: u32,
    pub persona: Option<Persona>,
    pub kind: SealKind,
    pub host: u64,
    pub depart_bell: u32,
    pub arrive: u32,
    pub dest: (i32, i32),
    /// How the owner revealed: `keeper` (`/f/reveal`), `direct`, or `none`.
    pub route: &'static str,
    /// The relay (or the chain) accepted the material.
    pub accepted: bool,
    pub tries: u8,
    /// The last refusal code of a Reveal attempt (e.g. `Shielded`).
    pub last_code: Option<String>,
}

impl Unrevealed {
    pub fn to_json(&self) -> Value {
        json!({
            "bot": self.bot,
            "persona": self.persona.map(|p| p.name()),
            "seal": match self.kind {
                SealKind::Honest => "honest",
                SealKind::Garbage => "garbage",
                SealKind::BadPlaintext => "bad_plaintext",
            },
            "host": self.host.to_string(),
            "depart_bell": self.depart_bell,
            "arrive": self.arrive,
            "dest": [self.dest.0, self.dest.1],
            "route": self.route,
            "accepted": self.accepted,
            "tries": self.tries,
            "last_code": self.last_code,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub struct Report {
    /// (group, action, result) → count.
    pub counts: BTreeMap<(String, String, String), u64>,
    /// Outcomes of persona bots, kept whole (few: ≤ 1% of bots each).
    pub persona_outcomes: Vec<Outcome>,
    pub errors: BTreeMap<String, u64>,
    pub steps: u64,
    pub bots: u64,
    /// `/f/nudge` requests by result (`sent`, `failed`; integ-W4 review).
    pub nudges: BTreeMap<&'static str, u64>,
    /// Marches settled with no REVEAL observed (W6T-3).
    pub unrevealed: Vec<Unrevealed>,
    /// The conquest layer (`--conquest`, MC §8.6); empty and absent from
    /// the JSON when it is off.
    pub cq: CqReport,
}

/// One conquest action's result (the personas' are kept whole).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CqOutcome {
    pub bot: u32,
    pub persona: Option<CqPersona>,
    /// `declare_siege`, `file_outpost`, `retire_host`.
    pub action: &'static str,
    pub ok: bool,
    /// The refusal code (the program's or the relay's name).
    pub code: Option<String>,
    /// The bell it was sent in (the spammer's per-day count).
    pub bell: u32,
}

/// A campaign as the fleet's plan held it: (faction, target) over epochs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CampaignRow {
    pub faction: u8,
    /// `keep` or `hold`.
    pub kind: &'static str,
    pub p: i16,
    pub q: i16,
    /// The site of a holding target (`None` for a keep).
    pub site: Option<u8>,
    pub first_bell: u32,
    pub last_bell: u32,
    pub epochs: u32,
    pub fails: u8,
    pub hosts_sent: u32,
}

/// One game day's counts (the bot-activity gate's numerators, §8.8).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DayCounts {
    /// Departs the relay accepted (every bot).
    pub departs: u64,
    /// Departs of a conquest plan's keep strike.
    pub keep_marches: u64,
    /// `keep_taken` events of the herald's day file.
    pub keep_captures: u64,
    /// DeclareSieges the relay accepted.
    pub declares: u64,
}

/// What the conquest layer did (§8.6 Reports).
#[derive(Clone, Debug, Default)]
pub struct CqReport {
    pub enabled: bool,
    /// Planner epochs computed, epochs skipped (files not ready), epochs
    /// whose province files were the `latest` ones.
    pub epochs: u64,
    pub epochs_unready: u64,
    pub latest_fallbacks: u64,
    /// Persona → bots assigned.
    pub personas_assigned: BTreeMap<&'static str, u64>,
    pub campaigns: BTreeMap<(u8, &'static str, i16, i16, u8), CampaignRow>,
    /// The herald's conquest events by kind (`/h/conquest/{day}.json`),
    /// each event once (by `seq`).
    pub events: BTreeMap<String, u64>,
    pub seen: BTreeSet<u64>,
    /// The personas' outcomes.
    pub outcomes: Vec<CqOutcome>,
    /// Honest bots' (action, result) → count.
    pub honest: BTreeMap<(&'static str, String), u64>,
    /// Orders and sends the bot did not make: why → count.
    pub skipped: BTreeMap<&'static str, u64>,
    pub days: BTreeMap<u32, DayCounts>,
    /// Bots by join day (the activity rates' denominators accumulate).
    pub join_days: BTreeMap<u32, u64>,
    /// The season's `sieges_per_day` (the spammer's cap).
    pub sieges_per_day: u32,
    /// The last game day a planner epoch ran (the activity arrays run to
    /// it, trailing zero days included).
    pub last_epoch_day: u32,
}

/// The verdict of a persona whose outcome is a refusal the bot itself
/// sees. `cap` is the season's `sieges_per_day`.
fn cq_judge(p: CqPersona, os: &[&CqOutcome], cap: u32) -> Verdict {
    if os.is_empty() {
        return Verdict::Pending;
    }
    // A persona whose adversarial behaviour the bot does not stage yet
    // (`CqPersona::staged`) is never `observed`: what it did is a plain
    // player's, so its row waits for the chain run (W2R2-F6).
    if !p.staged() {
        return Verdict::NeedsChain;
    }
    let Expect::Refused(_) = p.expected() else {
        return Verdict::NeedsChain;
    };
    let refused_ok = |o: &&CqOutcome| !o.ok && o.code.as_deref().is_some_and(|c| p.accepts(c));
    if p == CqPersona::SiegeSpammer {
        // The first `sieges_per_day` declarations of a day are honest
        // horns; beyond them every one must be refused.
        let mut per: BTreeMap<(u32, u32), u32> = BTreeMap::new();
        for o in os.iter().filter(|o| o.ok) {
            *per.entry((o.bot, o.bell / 144)).or_default() += 1;
        }
        let refusals: Vec<&&CqOutcome> = os.iter().filter(|o| !o.ok).collect();
        return if per.values().any(|&n| n > cap.max(1)) {
            Verdict::Violated
        } else if refusals.is_empty() {
            Verdict::Pending
        } else if refusals.iter().all(|o| refused_ok(o)) {
            Verdict::Observed
        } else {
            Verdict::NeedsChain
        };
    }
    if os.iter().any(|o| o.ok) {
        Verdict::Violated
    } else if os.iter().all(refused_ok) {
        Verdict::Observed
    } else {
        Verdict::NeedsChain
    }
}

impl CqReport {
    pub fn record(&mut self, o: CqOutcome) {
        match o.persona {
            Some(_) => self.outcomes.push(o),
            None => {
                let r = if o.ok {
                    "ok".to_string()
                } else {
                    o.code.clone().unwrap_or_else(|| "refused".into())
                };
                *self.honest.entry((o.action, r)).or_default() += 1;
            }
        }
    }

    pub fn skip(&mut self, why: &'static str) {
        *self.skipped.entry(why).or_default() += 1;
    }

    /// The verdict for `p` from its bots' outcomes.
    pub fn verdict(&self, p: CqPersona) -> Verdict {
        let os: Vec<&CqOutcome> = self
            .outcomes
            .iter()
            .filter(|o| o.persona == Some(p))
            .collect();
        cq_judge(p, &os, self.sieges_per_day)
    }

    /// A campaign seen at an epoch (`hosts_sent`: dispatches of the epoch
    /// for it).
    pub fn campaign(&mut self, row: CampaignRow) {
        let k = (row.faction, row.kind, row.p, row.q, row.site.unwrap_or(255));
        match self.campaigns.get_mut(&k) {
            Some(e) => {
                e.last_bell = row.last_bell;
                e.fails = row.fails;
                e.epochs += 1;
                e.hosts_sent += row.hosts_sent;
            }
            None => {
                self.campaigns.insert(k, CampaignRow { epochs: 1, ..row });
            }
        }
    }

    /// Adds another lifetime's (or process's) conquest report.
    pub fn merge(&mut self, o: CqReport) {
        self.enabled |= o.enabled;
        self.sieges_per_day = self.sieges_per_day.max(o.sieges_per_day);
        self.epochs += o.epochs;
        self.epochs_unready += o.epochs_unready;
        self.latest_fallbacks += o.latest_fallbacks;
        for (k, v) in o.personas_assigned {
            *self.personas_assigned.entry(k).or_default() += v;
        }
        for (_, c) in o.campaigns {
            let k = (c.faction, c.kind, c.p, c.q, c.site.unwrap_or(255));
            match self.campaigns.get_mut(&k) {
                Some(e) => {
                    e.first_bell = e.first_bell.min(c.first_bell);
                    e.last_bell = e.last_bell.max(c.last_bell);
                    e.epochs += c.epochs;
                    e.hosts_sent += c.hosts_sent;
                    e.fails = e.fails.max(c.fails);
                }
                None => {
                    self.campaigns.insert(k, c);
                }
            }
        }
        for (k, v) in o.events {
            *self.events.entry(k).or_default() += v;
        }
        self.seen.extend(o.seen);
        self.outcomes.extend(o.outcomes);
        for (k, v) in o.honest {
            *self.honest.entry(k).or_default() += v;
        }
        for (k, v) in o.skipped {
            *self.skipped.entry(k).or_default() += v;
        }
        for (d, c) in o.days {
            let e = self.days.entry(d).or_default();
            e.departs += c.departs;
            e.keep_marches += c.keep_marches;
            e.keep_captures += c.keep_captures;
            e.declares += c.declares;
        }
        for (d, n) in o.join_days {
            *self.join_days.entry(d).or_default() += n;
        }
    }

    pub fn day(&mut self, d: u32) -> &mut DayCounts {
        self.days.entry(d).or_default()
    }

    fn event_count(&self, kinds: &[&str]) -> u64 {
        kinds
            .iter()
            .map(|k| self.events.get(*k).copied().unwrap_or(0))
            .sum()
    }

    fn own(&self, action: &str, ok: bool) -> u64 {
        let mut n = self
            .outcomes
            .iter()
            .filter(|o| o.action == action && o.ok == ok)
            .count() as u64;
        n += self
            .honest
            .iter()
            .filter(|((a, r), _)| *a == action && (r == "ok") == ok)
            .map(|(_, c)| *c)
            .sum::<u64>();
        n
    }

    /// `refused_by_code` of the bots' own DeclareSieges.
    fn refused_by_code(&self) -> BTreeMap<String, u64> {
        let mut m: BTreeMap<String, u64> = BTreeMap::new();
        for ((a, r), n) in &self.honest {
            if *a == "declare_siege" && r != "ok" {
                *m.entry(r.clone()).or_default() += n;
            }
        }
        for o in &self.outcomes {
            if o.action == "declare_siege" && !o.ok {
                *m.entry(o.code.clone().unwrap_or_else(|| "refused".into()))
                    .or_default() += 1;
            }
        }
        m
    }

    pub fn to_json(&self) -> Value {
        let cum = |d: u32| -> u64 { self.join_days.range(..=d).map(|(_, n)| *n).sum::<u64>() };
        // Every day up to the last the fleet played an epoch, trailing
        // zero days included (a quiet day is a zero rate, not a missing
        // one: W2R2-F9).
        let last = self
            .days
            .keys()
            .next_back()
            .copied()
            .unwrap_or(0)
            .max(self.last_epoch_day);
        let rate = |n: u64, d: u32| -> f64 {
            let b = cum(d).max(1) as f64;
            n as f64 / b
        };
        let by = |f: &dyn Fn(&DayCounts) -> u64| -> Vec<f64> {
            (0..=last)
                .map(|d| rate(self.days.get(&d).map_or(0, f), d))
                .collect()
        };
        let personas: Vec<Value> = CqPersona::ALL
            .iter()
            .map(|&p| {
                let mut codes: BTreeMap<String, u64> = BTreeMap::new();
                for o in self.outcomes.iter().filter(|o| o.persona == Some(p)) {
                    let r = if o.ok {
                        "ok".to_string()
                    } else {
                        o.code.clone().unwrap_or_else(|| "refused".into())
                    };
                    *codes.entry(format!("{}:{r}", o.action)).or_default() += 1;
                }
                let expected = match p.expected() {
                    Expect::Refused(c) => json!({"refused": c.name()}),
                    Expect::Outcome(t) => json!({"outcome": t}),
                };
                json!({
                    "persona": p.name(),
                    "expected": expected,
                    "verdict": self.verdict(p).name(),
                    "locally_checkable": p.locally_checkable(),
                    "staged": p.staged(),
                    "bots": self.personas_assigned.get(p.name()).copied().unwrap_or(0),
                    "results": codes,
                })
            })
            .collect();
        let campaigns: Vec<Value> = self
            .campaigns
            .values()
            .map(|c| {
                json!({
                    "faction": c.faction, "kind": c.kind, "p": c.p, "q": c.q,
                    "site": c.site, "first_bell": c.first_bell, "last_bell": c.last_bell,
                    "epochs": c.epochs, "fails": c.fails, "hosts_sent": c.hosts_sent,
                })
            })
            .collect();
        json!({
            "conquest": {
                "campaigns": campaigns,
                // The herald's events, fleet-wide (the bots are the players).
                "keeps": {
                    "contested": self.event_count(&["keep_contest"]),
                    "taken": self.event_count(&["keep_taken"]),
                    // a holder losing its keep is a keep taken; a contest
                    // that ended without a take is a broken one
                    "lost": self.event_count(&["keep_taken"]),
                    "broken": self.event_count(&["keep_broken"]),
                },
                "sieges": {
                    "declared": self.own("declare_siege", true),
                    "won": self.event_count(&["occupied", "capture_due"]),
                    "lost": self.event_count(&["siege_failed"]),
                    "refused_by_code": self.refused_by_code(),
                },
                "occupations": self.event_count(&["occupied"]),
                "liberations": self.event_count(&["liberated"]),
                "captures": self.event_count(&["captured"]),
                "outposts": self.event_count(&["outpost"]),
                "events": self.events,
                "own": {
                    "declare_siege": {"ok": self.own("declare_siege", true), "refused": self.own("declare_siege", false)},
                    "file_outpost": {"ok": self.own("file_outpost", true), "refused": self.own("file_outpost", false)},
                    "retire_host": {"ok": self.own("retire_host", true), "refused": self.own("retire_host", false)},
                },
                "epochs": self.epochs,
                "epochs_unready": self.epochs_unready,
                "latest_fallbacks": self.latest_fallbacks,
                "skipped": self.skipped,
                "personas": personas,
            },
            // Per game day, index = day (§8.6 R-11; the stack's bot-activity
            // gate compares each against `thresholds/mc-7d-1k.json`).
            "activity": {
                "departs_per_bot_day": by(&|d| d.departs),
                "keep_marches_per_bot_day": by(&|d| d.keep_marches),
                "keep_captures_per_bot_day": by(&|d| d.keep_captures),
                "declares_per_bot_day": by(&|d| d.declares),
                "bots": (0..=last).map(cum).collect::<Vec<u64>>(),
                "counts": (0..=last).map(|d| {
                    let c = self.days.get(&d).copied().unwrap_or_default();
                    json!({"day": d, "departs": c.departs, "keep_marches": c.keep_marches,
                           "keep_captures": c.keep_captures, "declares": c.declares})
                }).collect::<Vec<_>>(),
            },
        })
    }
}

fn refused_as(o: &Outcome, codes: &[&str]) -> bool {
    !o.ok && o.code.as_deref().is_some_and(|c| codes.contains(&c))
}

impl Report {
    pub fn record(&mut self, o: Outcome) {
        let group = match o.persona {
            Some(p) => format!("persona:{}", p.name()),
            None => format!("arch:{}", o.arch.key()),
        };
        *self
            .counts
            .entry((group, o.action.to_string(), o.result()))
            .or_default() += 1;
        if o.persona.is_some() {
            self.persona_outcomes.push(o);
        }
    }

    pub fn error(&mut self, what: &str) {
        *self.errors.entry(what.to_string()).or_default() += 1;
    }

    /// The verdict for `p` from its bots' outcomes (§8.6's brackets).
    pub fn verdict(&self, p: Persona) -> Verdict {
        let os: Vec<&Outcome> = self
            .persona_outcomes
            .iter()
            .filter(|o| o.persona == Some(p))
            .collect();
        let tagged =
            |t: &str| -> Vec<&&Outcome> { os.iter().filter(|o| o.tag == Some(t)).collect() };
        let judge = |xs: Vec<&&Outcome>, codes: &[&str]| {
            if xs.is_empty() {
                Verdict::Pending
            } else if xs.iter().any(|o| o.ok) {
                Verdict::Violated
            } else if xs.iter().all(|o| refused_as(o, codes)) {
                Verdict::Observed
            } else {
                // Refused, but not with the code the contract names: the
                // report lists the codes; the stack report decides.
                Verdict::NeedsChain
            }
        };
        match p {
            // integ-W6t review: the racer tries from its arrival bell on;
            // a try before the resolve (`NotResident`, `HostBusy`) tests
            // nothing and is left out.
            Persona::SettleRacer => judge(
                tagged("redepart")
                    .into_iter()
                    .filter(|o| !refused_as(o, &["NotResident", "HostBusy", "RateLimited"]))
                    .collect(),
                &["HostInTransit"],
            ),
            // integ-W6 (W6-C F1): the keeper's `202` on `/f/reveal` means
            // "queued" (§8.2, `/v1/reveal`: the keeper's pipeline never
            // sends at or after `A + W − 2 slots` and expires the track), not
            // a Reveal the program took, so it is not evidence either way.
            // A late Reveal the program accepts shows as the direct route's
            // `ok`, which still reads `violated`.
            // integ-W6t review: a late try that found the march already
            // revealed (`AlreadyDone`, w6-s7), settled (`TransitState`) or
            // its host gone on a new march (`CommitMismatch`, the 20× racer
            // check) never reached the window check; it is left out.
            Persona::LateRevealer => judge(
                tagged("late")
                    .into_iter()
                    .filter(|o| !(o.route == "keeper" && o.ok))
                    .filter(|o| !refused_as(o, &["AlreadyDone", "TransitState", "CommitMismatch"]))
                    .collect(),
                &["WindowClosed", "LatchClosed", "Archived", "TooLate"],
            ),
            // integ-W6t review: a forged SettleTransit that finds the
            // transit already settled (`TransitState`, `AlreadyDone`: a
            // keeper settled first) or not yet settleable (`TooEarly`)
            // never reached the account check; it
            // tests nothing either way, so it is left out (the rehearsal's
            // nightly 2: 7 forged Reveals refused `BadAddress`, 2 forged
            // settles `TransitState`, read `needs-chain`).
            Persona::Forger => judge(
                tagged("forged")
                    .into_iter()
                    .filter(|o| !refused_as(o, &["TransitState", "AlreadyDone", "TooEarly"]))
                    .collect(),
                &[
                    "BadAccount",
                    "BadAddress",
                    "WrongRegion",
                    "NoAnchor",
                    "RelayRejected",
                ],
            ),
            Persona::ZeroTip => judge(tagged("zero_tip"), &["TipTooLow", "TipNotPreset"]),
            Persona::Spammer => {
                let sp = tagged("spam");
                if sp.is_empty() {
                    Verdict::Pending
                } else if sp.iter().any(|o| {
                    o.status == 429 || refused_as(o, &["QuotaExceeded", "RateLimited", "Bucket"])
                }) {
                    Verdict::Observed
                } else {
                    Verdict::Pending
                }
            }
            _ => Verdict::NeedsChain,
        }
    }

    pub fn merge(&mut self, other: Report) {
        for (k, v) in other.counts {
            *self.counts.entry(k).or_default() += v;
        }
        self.persona_outcomes.extend(other.persona_outcomes);
        for (k, v) in other.errors {
            *self.errors.entry(k).or_default() += v;
        }
        self.steps += other.steps;
        self.bots += other.bots;
        self.unrevealed.extend(other.unrevealed);
        self.cq.merge(other.cq);
    }

    pub fn to_json(&self) -> Value {
        let mut by_group: BTreeMap<&str, BTreeMap<String, BTreeMap<&str, u64>>> = BTreeMap::new();
        for ((g, a, r), n) in &self.counts {
            by_group
                .entry(g)
                .or_default()
                .entry(a.clone())
                .or_default()
                .insert(r, *n);
        }
        let personas: Vec<Value> = Persona::ALL
            .iter()
            .map(|&p| {
                let mut codes: BTreeMap<String, u64> = BTreeMap::new();
                for o in self
                    .persona_outcomes
                    .iter()
                    .filter(|o| o.persona == Some(p))
                {
                    // The route too (integ-W6, W6-C F1: a keeper `202`
                    // and a direct simulation read alike without it).
                    *codes
                        .entry(format!("{}@{}:{}", o.action, o.route, o.result()))
                        .or_default() += 1;
                }
                json!({
                    "persona": p.name(),
                    "expected": p.expected(),
                    "verdict": self.verdict(p).name(),
                    "locally_checkable": p.locally_checkable(),
                    "results": codes,
                })
            })
            .collect();
        let mut v = json!({
            "v": 1,
            "bots": self.bots,
            "steps": self.steps,
            "groups": by_group,
            "personas": personas,
            "errors": self.errors,
            "nudges": self.nudges,
            "unrevealed": self.unrevealed.iter().map(Unrevealed::to_json).collect::<Vec<_>>(),
            "unrevealed_honest": self.unrevealed.iter().filter(|u| u.kind == SealKind::Honest).count(),
        });
        if self.cq.enabled {
            if let (Some(o), Value::Object(c)) = (v.as_object_mut(), self.cq.to_json()) {
                o.extend(c);
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(p: Persona, tag: &'static str, ok: bool, code: &str, status: u16) -> Outcome {
        Outcome {
            bot: 1,
            arch: Arch::Bot,
            persona: Some(p),
            action: "x",
            route: "relay",
            ok,
            status,
            code: (!code.is_empty()).then(|| code.to_string()),
            signature: None,
            tag: Some(tag),
        }
    }

    /// integ-W6t review: a late Reveal refused because the march was
    /// already revealed or settled is the expected refusal.
    #[test]
    fn a_settle_racer_try_before_the_resolve_is_no_evidence() {
        let mut r = Report::default();
        r.record(o(Persona::SettleRacer, "redepart", false, "NotResident", 0));
        r.record(o(Persona::SettleRacer, "redepart", false, "HostBusy", 0));
        r.record(o(
            Persona::SettleRacer,
            "redepart",
            false,
            "RateLimited",
            429,
        ));
        assert_eq!(r.verdict(Persona::SettleRacer), Verdict::Pending);
        r.record(o(
            Persona::SettleRacer,
            "redepart",
            false,
            "HostInTransit",
            0,
        ));
        assert_eq!(r.verdict(Persona::SettleRacer), Verdict::Observed);
        r.record(o(Persona::SettleRacer, "redepart", true, "", 0));
        assert_eq!(r.verdict(Persona::SettleRacer), Verdict::Violated);
    }

    #[test]
    fn a_forged_settle_that_came_too_late_is_no_evidence() {
        let mut r = Report::default();
        r.record(o(Persona::Forger, "forged", false, "TransitState", 0));
        r.record(o(Persona::Forger, "forged", false, "TooEarly", 0));
        assert_eq!(r.verdict(Persona::Forger), Verdict::Pending);
        r.record(o(Persona::Forger, "forged", false, "BadAddress", 0));
        assert_eq!(r.verdict(Persona::Forger), Verdict::Observed);
        r.record(o(Persona::Forger, "forged", false, "Shielded", 0));
        assert_eq!(r.verdict(Persona::Forger), Verdict::NeedsChain);
        r.record(o(Persona::Forger, "forged", true, "", 0));
        assert_eq!(r.verdict(Persona::Forger), Verdict::Violated);
    }

    #[test]
    fn late_reveal_refused_after_reveal_or_settle_is_observed() {
        let mut r = Report::default();
        r.record(o(Persona::LateRevealer, "late", false, "TransitState", 0));
        r.record(o(Persona::LateRevealer, "late", false, "AlreadyDone", 0));
        r.record(o(Persona::LateRevealer, "late", false, "CommitMismatch", 0));
        assert_eq!(r.verdict(Persona::LateRevealer), Verdict::Pending);
        r.record(o(Persona::LateRevealer, "late", false, "WindowClosed", 0));
        assert_eq!(r.verdict(Persona::LateRevealer), Verdict::Observed);
        r.record(o(Persona::LateRevealer, "late", true, "", 0));
        assert_eq!(r.verdict(Persona::LateRevealer), Verdict::Violated);
    }

    #[test]
    fn verdicts() {
        let mut r = Report::default();
        assert_eq!(r.verdict(Persona::ZeroTip), Verdict::Pending);
        r.record(o(Persona::ZeroTip, "zero_tip", false, "TipNotPreset", 400));
        r.record(o(Persona::ZeroTip, "zero_tip", false, "TipTooLow", 0));
        assert_eq!(r.verdict(Persona::ZeroTip), Verdict::Observed);
        r.record(o(Persona::LateRevealer, "late", false, "WindowClosed", 410));
        assert_eq!(r.verdict(Persona::LateRevealer), Verdict::Observed);
        // A keeper's 202 is "queued", not a landing (W6-C F1).
        let mut queued = o(Persona::LateRevealer, "late", true, "", 202);
        queued.route = "keeper";
        r.record(queued);
        assert_eq!(r.verdict(Persona::LateRevealer), Verdict::Observed);
        // A late Reveal the program took (the direct route) is a violation.
        let mut took = o(Persona::LateRevealer, "late", true, "", 0);
        took.route = "direct";
        r.record(took);
        assert_eq!(r.verdict(Persona::LateRevealer), Verdict::Violated);
        assert_eq!(
            r.to_json()["personas"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["persona"] == "late_revealer")
                .unwrap()["results"]["x@keeper:ok"],
            1
        );
        r.record(o(Persona::Spammer, "spam", true, "", 200));
        assert_eq!(r.verdict(Persona::Spammer), Verdict::Pending);
        r.record(o(Persona::Spammer, "spam", false, "QuotaExceeded", 429));
        assert_eq!(r.verdict(Persona::Spammer), Verdict::Observed);
        r.record(o(
            Persona::SettleRacer,
            "redepart",
            false,
            "NotResident",
            400,
        ));
        // integ-W6t review: a try before the resolve is no evidence.
        assert_eq!(r.verdict(Persona::SettleRacer), Verdict::Pending);
        r.record(o(Persona::SettleRacer, "redepart", false, "Shielded", 400));
        assert_eq!(r.verdict(Persona::SettleRacer), Verdict::NeedsChain);
        assert_eq!(r.verdict(Persona::MinTip), Verdict::NeedsChain);
        let j = r.to_json();
        assert_eq!(j["personas"].as_array().unwrap().len(), 13);
    }

    fn cqo(
        p: Option<CqPersona>,
        action: &'static str,
        ok: bool,
        code: &str,
        bell: u32,
    ) -> CqOutcome {
        CqOutcome {
            bot: 1,
            persona: p,
            action,
            ok,
            code: (!code.is_empty()).then(|| code.to_string()),
            bell,
        }
    }

    /// §8.6 Reports: `conquest {campaigns[], keeps {contested, taken,
    /// lost}, sieges {declared, won, lost, refused_by_code}, occupations,
    /// liberations, captures, outposts, personas}` and `activity` per game
    /// day; absent when the layer is off.
    #[test]
    fn cq_report_has_the_8_6_sections() {
        let off = Report::default().to_json();
        assert!(off.get("conquest").is_none() && off.get("activity").is_none());
        let mut r = Report::default();
        r.cq.enabled = true;
        r.cq.join_days.insert(0, 60);
        r.cq.join_days.insert(1, 40);
        r.cq.campaign(CampaignRow {
            faction: 0,
            kind: "keep",
            p: 3,
            q: -1,
            site: None,
            first_bell: 288,
            last_bell: 288,
            epochs: 1,
            fails: 0,
            hosts_sent: 4,
        });
        r.cq.campaign(CampaignRow {
            faction: 0,
            kind: "keep",
            p: 3,
            q: -1,
            site: None,
            first_bell: 294,
            last_bell: 294,
            epochs: 1,
            fails: 1,
            hosts_sent: 2,
        });
        for k in [
            "keep_contest",
            "keep_taken",
            "keep_broken",
            "occupied",
            "liberated",
            "captured",
            "outpost",
            "siege_failed",
        ] {
            r.cq.events.insert(k.to_string(), 2);
        }
        r.cq.record(cqo(None, "declare_siege", true, "", 300));
        r.cq.record(cqo(None, "declare_siege", false, "NotLead", 300));
        r.cq.record(cqo(None, "file_outpost", true, "", 300));
        r.cq.day(0).departs = 12;
        r.cq.day(0).keep_marches = 6;
        r.cq.day(1).departs = 50;
        r.cq.day(1).keep_captures = 1;
        r.cq.day(1).declares = 10;
        let j = r.to_json();
        let c = &j["conquest"];
        assert_eq!(c["campaigns"].as_array().unwrap().len(), 1);
        assert_eq!(c["campaigns"][0]["epochs"], 2);
        assert_eq!(c["campaigns"][0]["hosts_sent"], 6);
        assert_eq!(c["campaigns"][0]["fails"], 1);
        assert_eq!(c["keeps"]["contested"], 2);
        assert_eq!(c["keeps"]["taken"], 2);
        assert_eq!(c["keeps"]["lost"], 2, "keep_taken: the holder's loss");
        assert_eq!(c["keeps"]["broken"], 2, "keep_broken: a contest broken");
        assert_eq!(c["sieges"]["declared"], 1);
        assert_eq!(c["sieges"]["refused_by_code"]["NotLead"], 1);
        assert_eq!(c["sieges"]["lost"], 2);
        assert_eq!(c["sieges"]["won"], 2, "occupied + capture_due: 2 + 0");
        for k in ["occupations", "liberations", "captures", "outposts"] {
            assert_eq!(c[k], 2, "{k}");
        }
        assert_eq!(c["personas"].as_array().unwrap().len(), 19);
        // Rates per bot-day: day 0 has 60 bots, day 1 has 100.
        let a = &j["activity"];
        let day = |k: &str, d: usize| a[k][d].as_f64().unwrap();
        assert!((day("departs_per_bot_day", 0) - 12.0 / 60.0).abs() < 1e-12);
        assert!((day("departs_per_bot_day", 1) - 50.0 / 100.0).abs() < 1e-12);
        assert!((day("keep_marches_per_bot_day", 0) - 6.0 / 60.0).abs() < 1e-12);
        assert!((day("keep_captures_per_bot_day", 1) - 1.0 / 100.0).abs() < 1e-12);
        assert!((day("declares_per_bot_day", 1) - 10.0 / 100.0).abs() < 1e-12);
        assert_eq!(a["bots"], json!([60, 100]));
        // Reports of two lifetimes add up.
        let mut r2 = Report::default();
        r2.cq.enabled = true;
        r2.cq.day(1).departs = 7;
        r.merge(r2);
        assert_eq!(r.cq.days[&1].departs, 57);
    }

    /// The conquest personas' verdicts (criterion 13): a refusal with an
    /// expected code observed; the program taking it is a violation;
    /// `siege_seat` and `siege_spammer` have their two readings.
    #[test]
    fn cq_persona_verdicts() {
        use CqPersona::*;
        let mut r = Report::default();
        r.cq.enabled = true;
        r.cq.sieges_per_day = 2;
        assert_eq!(r.cq.verdict(SiegeHeartland), Verdict::Pending);
        r.cq.record(cqo(
            Some(SiegeHeartland),
            "declare_siege",
            false,
            "Heartland",
            300,
        ));
        assert_eq!(r.cq.verdict(SiegeHeartland), Verdict::Observed);
        r.cq.record(cqo(
            Some(SiegeHeartland),
            "declare_siege",
            false,
            "Immune",
            301,
        ));
        assert_eq!(r.cq.verdict(SiegeHeartland), Verdict::NeedsChain);
        r.cq.record(cqo(Some(SiegeHeartland), "declare_siege", true, "", 302));
        assert_eq!(r.cq.verdict(SiegeHeartland), Verdict::Violated);
        // A Seat's reserved site: the program's step 3 or step 8 code.
        r.cq.record(cqo(
            Some(SiegeSeat),
            "declare_siege",
            false,
            "NotBesiegeable",
            300,
        ));
        r.cq.record(cqo(
            Some(SiegeSeat),
            "declare_siege",
            false,
            "ReservedSite",
            300,
        ));
        assert_eq!(r.cq.verdict(SiegeSeat), Verdict::Observed);
        // The spammer: two honest horns a day, then refusals.
        r.cq.record(cqo(Some(SiegeSpammer), "declare_siege", true, "", 300));
        r.cq.record(cqo(Some(SiegeSpammer), "declare_siege", true, "", 301));
        assert_eq!(r.cq.verdict(SiegeSpammer), Verdict::Pending);
        r.cq.record(cqo(
            Some(SiegeSpammer),
            "declare_siege",
            false,
            "QuotaExceeded",
            302,
        ));
        r.cq.record(cqo(
            Some(SiegeSpammer),
            "declare_siege",
            false,
            "SiegeCap",
            303,
        ));
        assert_eq!(r.cq.verdict(SiegeSpammer), Verdict::Observed);
        // A third accepted horn in a game day is a violation.
        r.cq.record(cqo(Some(SiegeSpammer), "declare_siege", true, "", 304));
        assert_eq!(r.cq.verdict(SiegeSpammer), Verdict::Violated);
        // The next day's horns count afresh.
        let mut r = Report::default();
        r.cq.sieges_per_day = 2;
        for bell in [300, 301, 450, 451] {
            r.cq.record(cqo(Some(SiegeSpammer), "declare_siege", true, "", bell));
        }
        r.cq.record(cqo(
            Some(SiegeSpammer),
            "declare_siege",
            false,
            "SiegeCap",
            452,
        ));
        assert_eq!(r.cq.verdict(SiegeSpammer), Verdict::Observed);
        // An outcome the chain shows: the bot cannot judge it.
        r.cq.record(cqo(Some(FirstTaker), "declare_siege", true, "", 300));
        assert_eq!(r.cq.verdict(FirstTaker), Verdict::NeedsChain);
    }
}
