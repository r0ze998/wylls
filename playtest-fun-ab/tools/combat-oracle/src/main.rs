//! Prints one JSON object per line: an engagement's inputs and the result
//! of `permutation_rules::combat::resolve_engagement` with the clash's
//! ruleset (`frontier::clash::frontier_ruleset`). The prototype's test
//! (`tests/engine.test.js`) feeds the same inputs to its own engine and
//! checks the numbers are equal.
use permutation_rules::combat::{resolve_engagement, Combatant, Situation};
use permutation_rules::frontier::clash::frontier_ruleset;
use permutation_rules::units::UnitType;

const UNITS: [(UnitType, &str); 6] = [
    (UnitType::Spearman, "spear"),
    (UnitType::Archer, "archer"),
    (UnitType::Horseman, "horse"),
    (UnitType::Pikeman, "pike"),
    (UnitType::Crossbowman, "xbow"),
    (UnitType::Knight, "knight"),
];

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn main() {
    let rules = frontier_ruleset();
    let mut r = Lcg(20261024);
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(400);
    for _ in 0..n {
        // Troop counts from 1 to 30,000, in milli-troops, sometimes fractional.
        let size = |r: &mut Lcg| -> u32 {
            let base = [1u64, 30, 100, 450, 1_000, 5_000, 30_000][r.below(7) as usize];
            ((base * 1000 * (500 + r.below(1000))) / 1000) as u32
        };
        let a_city = false;
        let d_city = r.below(4) == 0;
        let (au, an) = UNITS[r.below(6) as usize];
        let (du, dn) = UNITS[r.below(6) as usize];
        let at = size(&mut r);
        let dt = size(&mut r);
        let rough = r.below(2) == 0;
        let exhausted = r.below(4) == 0;
        let walls = d_city && r.below(3) != 0;
        let va = 9000 + r.below(2001) as u32;
        let vd = 9000 + r.below(2001) as u32;
        let attacker = Combatant::Army { unit: au, troops: at };
        let defender = if d_city {
            Combatant::City { defense: dt }
        } else {
            Combatant::Army { unit: du, troops: dt }
        };
        let sit = Situation {
            defender_on_rough_terrain: rough,
            city_walls: walls,
            attacker_exhausted: exhausted,
            ..Situation::default()
        };
        let (to_def, to_att) = resolve_engagement(&rules, attacker, defender, sit, va, vd);
        println!(
            "{{\"a\":{{\"unit\":\"{an}\",\"troops\":{at},\"city\":{a_city}}},\"d\":{{\"unit\":{du},\"troops\":{dt},\"city\":{d_city}}},\"rough\":{rough},\"exhausted\":{exhausted},\"walls\":{walls},\"va\":{va},\"vd\":{vd},\"toDef\":{to_def},\"toAtt\":{to_att}}}",
            du = if d_city { "null".to_string() } else { format!("\"{dn}\"") },
        );
    }
}
