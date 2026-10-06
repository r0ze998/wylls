// Fixture generator, kept outside the production program. Link to a freshly
// built permutation_rules rlib with the same rustc toolchain, then redirect
// stdout to holding-projection.json. The settle_tiered adapter below is the
// exact economic sequence from permutation-frontier/src/proc/holding.rs;
// walls use that module's commit_walls(now), without waking the holding.
use permutation_rules::frontier::{catalog, holding::{Accrual, Effect, Holding, QueueItem, Resource, Tier}};

fn base() -> Holding { let mut h=Holding::found(0,0,1); h.production=catalog::base_production(Tier::Hamlet); h.set_upkeep(0,Resource::Food,0).unwrap(); h }
fn q(t:i64,effect:Effect)->Option<QueueItem>{Some(QueueItem{done_at:t,effect})}
fn settle_tiered(h:&mut Holding,now:i64){
  loop { let next=h.queue.iter().flatten().filter(|q|matches!(q.effect,Effect::TierUp)&&q.done_at<=now).map(|q|q.done_at).min();
    let Some(t)=next else{break}; let t=t.max(h.stores[0].t0);let old=h.tier;h.settle(t).unwrap();
    if h.tier!=old { let a=catalog::base_production(old);let b=catalog::base_production(h.tier);for r in 0..8 {h.production[r]=h.production[r].saturating_add(b[r]-a[r]);}h.set_upkeep(t,Resource::Food,h.upkeep[0]).unwrap();}else{break;}
  } h.settle(now).unwrap();h.commit_walls(now);
}
fn nums(a:&[i64])->String{format!("[{}]",a.iter().map(|x|format!("\"{}\"",x)).collect::<Vec<_>>().join(","))}
fn dump(h:&Holding)->String{
 let stores=h.stores.iter().map(|a|format!("{{\"value\":\"{}\",\"rate\":\"{}\",\"cap\":\"{}\",\"t0\":\"{}\",\"frac\":\"{}\"}}",a.value,a.rate,a.cap,a.t0,a.frac)).collect::<Vec<_>>().join(",");
 let queue=h.queue.iter().flatten().map(|q|{let (kind,arg,delta)=match q.effect{Effect::Production{resource,delta}=>(1,resource as u8,delta),Effect::Upkeep{resource,delta}=>(2,resource as u8,delta),Effect::TierUp=>(3,0,0),Effect::Walls{delta}=>(4,0,delta as i64)};format!("{{\"doneAt\":\"{}\",\"kind\":{},\"arg\":{},\"delta\":\"{}\"}}",q.done_at,kind,arg,delta)}).collect::<Vec<_>>().join(",");
 format!("{{\"tier\":{},\"lastOwnerAction\":\"{}\",\"stores\":[{}],\"production\":{},\"upkeep\":{},\"queue\":[{}],\"walls\":{},\"foodShortfall\":\"{}\"}}",h.tier as u8,h.last_owner_action,stores,nums(&h.production),nums(&h.upkeep),queue,h.walls,h.food_shortfall)
}
fn main(){let mut cases=Vec::new();
 let mut h=base();h.queue[0]=q(60,Effect::Production{resource:Resource::Food,delta:12000});for t in [59,60,3660]{cases.push(("first_farm",h.clone(),t));}
 let mut h=base();h.queue[0]=q(3600,Effect::TierUp);for t in [3599,3600,10800]{cases.push(("town_base_production",h.clone(),t));}
 let mut h=base();h.stores[0].value=1990000;h.queue[0]=q(3600,Effect::TierUp);cases.push(("cap_before_town",h,10800));
 let mut h=base();h.production[0]=0;h.upkeep[0]=1;h.stores[0]=Accrual::new(1,-1,2000000,0);for t in [1,2,3601]{cases.push(("negative_fraction",h.clone(),t));}
 let mut h=base();for a in &mut h.stores{a.t0=428400;}cases.push(("dormancy",h.clone(),435600));h.queue[0]=q(432000,Effect::Production{resource:Resource::Food,delta:12000});cases.push(("completion_at_dormancy",h,435600));
 let mut h=base();h.queue[0]=q(60,Effect::Walls{delta:50});for t in [60,61]{cases.push(("walls_strict_boundary",h.clone(),t));}
 let mut h=base();h.queue[0]=q(60,Effect::Production{resource:Resource::Food,delta:12000});h.queue[1]=q(120,Effect::Production{resource:Resource::Ore,delta:6000});h.queue[2]=q(3600,Effect::TierUp);h.queue[3]=q(7200,Effect::Upkeep{resource:Resource::Food,delta:1000});cases.push(("mixed_effects",h,10800));
 let mut h=base();h.production[0]=995000;h.stores[0].rate=995000;h.queue[0]=q(3600,Effect::TierUp);h.queue[1]=q(3600,Effect::Production{resource:Resource::Food,delta:12000});cases.push(("same_time_tier_and_capped_production",h,7200));
 let rows=cases.into_iter().map(|(name,h,now)|{let input=dump(&h);let mut out=h;settle_tiered(&mut out,now);format!("{{\"name\":\"{}\",\"now\":{},\"input\":{},\"expected\":{}}}",name,now,input,dump(&out))}).collect::<Vec<_>>().join(",");println!("{{\"generator\":\"Rust permutation_rules::Holding::settle + proc::holding::settle_tiered adapter, commit_walls(now)\",\"cases\":[{}]}}",rows);
}
