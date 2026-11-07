use permutation_rules::frontier::geometry::ProvinceCoord;
fn main() {
    for (p, q) in [(0, -2), (1, -3), (3, -3)] {
        let c = ProvinceCoord::new(p, q);
        println!("({p},{q}) ring {} wedge {:?}", c.ring(), c.wedge());
    }
}
