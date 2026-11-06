//! What user B reads before granting (contract §1, §4): derived from the
//! manifest bytes alone, so the screen cannot say more or less than the
//! code that will run.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use permutation_rules::frontier::holding::{Resource, RESOURCES};

use crate::manifest::{Manifest, Op, Operand};

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn res(r: u8) -> String {
    // S1 keeps arms in the store the kernel names Horses
    // (`permutation_rules::frontier::arms::ARMS`): say what the user holds.
    if Resource::ALL.get(r as usize) == Some(&permutation_rules::frontier::arms::ARMS) {
        return "Arms".into();
    }
    Resource::ALL
        .get(r as usize)
        .map(|x| format!("{x:?}"))
        .unwrap_or_else(|| format!("res{r}"))
}

fn operand(o: &Operand) -> String {
    match o {
        Operand::Const(v) => format!("{v}"),
        Operand::Arg(i) => format!("arg{i}"),
        Operand::Field(i) => format!("field{i}"),
        Operand::NowBell => "now_bell".into(),
        Operand::Escrow(r) => format!("escrow[{}]", res(*r)),
    }
}

/// One line per op, in words.
pub fn op_line(op: &Op) -> String {
    match op {
        Op::Require(c, a, b) => format!("require {} {} {}", operand(a), c.symbol(), operand(b)),
        Op::Set(f, x) => format!("field{f} := {}", operand(x)),
        Op::Add(f, x) => format!("field{f} += {}", operand(x)),
        Op::Pay(r, x) => format!(
            "pay {} {} from your holding into your escrow",
            operand(x),
            res(*r)
        ),
        Op::Refund(r, x) => format!(
            "refund {} {} from your escrow to your holding",
            operand(x),
            res(*r)
        ),
        Op::Burn(r, x) => format!(
            "BURN {} {} from your holding (not returned)",
            operand(x),
            res(*r)
        ),
        Op::Emit(c) => format!("record event {c}"),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub id_hex: String,
    pub lines: Vec<String>,
    /// Per resource: the most one call can take from the Holding (milli).
    pub max_spend_per_call: [i64; RESOURCES],
    pub burns: bool,
    /// Some entry pays into escrow but no entry refunds it.
    pub escrow_without_refund: bool,
}

pub fn describe(m: &Manifest) -> Summary {
    let mut lines = Vec::new();
    lines.push(format!("extension \"{}\" by {}", m.name, hex(&m.author)));
    lines.push(format!("id {}", hex(&m.id())));
    lines.push(format!(
        "core program_version {} ruleset {}",
        m.core.program_version,
        hex(&m.core.ruleset_hash)
    ));
    lines.push(format!(
        "state: {} field(s) per user, at most {} users",
        m.fields.len(),
        m.max_instances
    ));
    for (i, f) in m.fields.iter().enumerate() {
        lines.push(format!(
            "  field{i}: {}..={} (starts {})",
            f.min, f.max, f.init
        ));
    }
    for (r, c) in m.pay_cap.iter().enumerate() {
        if *c > 0 {
            lines.push(format!(
                "may take up to {c} milli {} per call (core resources only; enforced by the core interpreter)",
                res(r as u8)
            ));
        }
    }
    let mut pays = false;
    let mut refunds = false;
    let mut burns = false;
    for e in &m.entries {
        let args: Vec<String> = e
            .args
            .iter()
            .enumerate()
            .map(|(i, a)| format!("arg{i} in {}..={}", a.min, a.max))
            .collect();
        lines.push(format!("entry {} ({})", e.id, args.join(", ")));
        for op in &e.ops {
            pays |= matches!(op, Op::Pay(..));
            refunds |= matches!(op, Op::Refund(..));
            burns |= matches!(op, Op::Burn(..));
            lines.push(format!("  {}", op_line(op)));
        }
    }
    lines.push(
        "cannot: create resources, touch another user's holding or escrow, call other programs"
            .into(),
    );
    lines.push(
        "stop: the author or the operator may pause or revoke; you can then withdraw your escrow"
            .into(),
    );
    if burns {
        lines.push("WARNING: some resources are consumed and never returned".into());
    }
    if pays && !refunds {
        lines.push(
            "WARNING: escrow has no refund entry; it returns only by withdraw after a stop".into(),
        );
    }
    Summary {
        id_hex: hex(&m.id()),
        lines,
        max_spend_per_call: m.pay_cap,
        burns,
        escrow_without_refund: pays && !refunds,
    }
}
