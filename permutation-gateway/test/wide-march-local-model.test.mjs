// Synthetic structure-only test snapshots. Never used by the actual demo or a real-host claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, SESSION, parseReplyObject, commandFromBody, commandFromQuoteBody, commandLine, checkTransition, checkQuote, parseRouteQuote, routeDirsOk, MAX_ROUTE_DIRS, allowedFor } from '../screens/wide-march-local/local-model.mjs';
import { createController, cleanPath, mutationHeaderProblem, parseCanonicalJson, requestAllowed } from '../screens/wide-march-local/local-server.mjs';
import { createClient } from '../screens/wide-march-local/local-client.mjs';
import { ringPosition } from '../../permutation-server/web/frontier/map/wide.mjs';
const toHex = b => Buffer.from(b).toString('hex');
const fromHex = s => Buffer.from(s, 'hex');
function raw(n,magic,sortOffset,p,q) {
 const b=Buffer.alloc(n),d=new DataView(b.buffer,b.byteOffset,b.byteLength);b.write(magic);d.setUint16(16,3,true);
 const rp=ringPosition(BigInt(p),BigInt(q));d.setBigUint64(sortOffset,rp.ring,false);b[sortOffset+8]=rp.wedge;d.setBigUint64(sortOffset+9,rp.pos,false);
 const wide=n===1344?1280:4736;d.setUint16(wide,1,true);b[wide+2]=1; if(n===4864)b[4739]=15;
 b.fill(0x33,n===1344?1288:4740,n===1344?1320:4772);
 return b;
}
const acct=(key,b,lamports='0')=>({keyHex:key.repeat(32),ownerHex:'12'.repeat(32),lamports,dataHex:toHex(b)});
const dv=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const SEED_ROUND=32547581n, PROVINCE_RENT='34744320', FUND_LAMPORTS='200000000';
/** A wide province's bytes: identity, bells and the ring seed record's literal seed and round in the trailer. */
function provinceBytes(p,q,{resolvedNext,openedBell,region,funded=0n}){
 const b=raw(4864,'PSFXWPV1',4772,p,q),d=dv(b);
 b[70]=ringPosition(BigInt(p),BigInt(q)).wedge;b[71]=region;d.setUint32(72,resolvedNext,true);d.setUint32(76,openedBell,true);
 d.setBigUint64(4792,SEED_ROUND,true);b.fill(0x81,4800,4832);d.setBigUint64(4832,funded,true);
 return b;
}
const PROVENANCE={ringSeed:'LOCAL_SYNTHETIC_RING_SEED',rules:'PROTOTYPE_CANDIDATE_RULES_V1',funds:'LOCAL_FIXTURE_FUNDS',golden:'GOLDEN_REOPEN_STATIC_FIELDS_MATCH',opened:'REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME',resolveHistory:'NO_RESOLVE_HISTORY',auth:'MOCK_PAYER_SIGNER_FLAG_NO_SIGNATURE',budget:'DEMO_BUDGET_4_EXTRA_PROVINCES'};
const FUND_KEYS=['07','08','09','0a','0b','0c'];
/** The LOCAL land records as bytes: ring seed 129 Seeded (literal seed and round), rules {1,2,2,1}, six funds. */
function landAccounts(created=3n){
 const s=Buffer.alloc(192),sd=dv(s);s.write('PSFXWRS1');s[18]=2;sd.setBigUint64(20,129n,true);sd.setBigUint64(40,SEED_ROUND,true);s.fill(0x81,48,80);s.fill(0x33,80,112);sd.setBigUint64(112,created,true);
 const c=Buffer.alloc(96);c.write('PSFXWRC1');dv(c).setUint16(16,1,true);c.set([1,2,2,1],18);c.fill(0x33,24,56);c.fill(0xaa,56,88);
 const funds=FUND_KEYS.map((k,w)=>{const f=Buffer.alloc(128);f.write('PSF1PFND');f[16]=w;return acct(k,f,FUND_LAMPORTS);});
 return [acct('05',s),acct('06',c),...funds];
}
// Factories, never shared objects: every fixture() call and every store/queue entry is a fresh object, so a test
// that mutates one snapshot can never leak into another (Array(n).fill(obj) would alias one object n times).
const zeroStore=()=>({value:'0',rate:'0',cap:'0',t0:'0'});
const freeSlot=()=>({doneAt:'0',kind:0,arg:0,delta:'0'});
export function fixture() {
 const hb=raw(1344,'PSFXWHL1',1320,129,0),hd=dv(hb);
 hb.fill(0x04,72,104); // OWNER_CITIZEN: the village citizen account below
 hd.setBigInt64(152,1900000n,true);hd.setBigInt64(160,40000n,true);hd.setBigInt64(168,2000000n,true);hd.setBigInt64(176,1790447367n,true);
 hd.setBigInt64(472,40000n,true);hd.setUint32(720,600,true);
 const ob=provinceBytes(129,0,{resolvedNext:5,openedBell:1,region:8}),db=provinceBytes(129,-1,{resolvedNext:20,openedBell:1,region:6});
 const cb=Buffer.alloc(384);cb.write('PSF1CITZ');
 const h=acct('01',hb),a=acct('02',ob),b=acct('03',db),c=acct('04',cb);
 const fixtureProvince=(p,q,keyHex,resolvedNext,region)=>({p,q,accountKeyHex:keyHex,passableMask:'0',source:'fixture',openedBell:1,resolvedNext,wedge:ringPosition(BigInt(p),BigInt(q)).wedge,region});
 return {protocol:PROTOCOL,mode:'local-only',auth:'MOCK_AUTH_NO_SIGNATURE',beacon:'PUBLIC_FIXTURES_REAL_VERIFICATION',session:SESSION,status:'ok',error:null,refusalCode:null,command:'get',revision:0,phase:'ready',
  allowed:['depart','harvest','build_farm','train','open_province','reset'],clock:{unix:'1790448507',bell:6},
  horizon:{model:'PHASE_STEPS_ONLY',finalBell:25,destinationPreparedThroughBell:19,originResolvedNext:5,destinationResolvedNext:20},
  economy:{perInstantBudget:8,usedThisInstant:0,harvests:0,farmBuilds:0,trains:0,farmItem:0,trainUnit:0,trainCount:10},
  village:{tier:0,flags:0,lastOwnerAction:'0',stores:[{value:'1900000',rate:'40000',cap:'2000000',t0:'1790447367'},...Array.from({length:7},zeroStore)],production:['40000',...Array(7).fill('0')],queue:Array.from({length:4},freeSlot),reserve:[600,0,0,0,0,0,0,0]},
  land:{ring:129,budget:4,opened:0,provincesCreated:3,ringSeedKeyHex:'05'.repeat(32),rulesConfigKeyHex:'06'.repeat(32),fundKeysHex:FUND_KEYS.map(k=>k.repeat(32)),provenance:{...PROVENANCE}},
  map:{worldHex:'33'.repeat(32),origin:{p:'129',q:'0'},destination:{p:'129',q:'-1'},route:[{p:'129',q:'0',tile:0},{p:'129',q:'-1',tile:0}],provinces:[fixtureProvince('129','0',a.keyHex,5,8),fixtureProvince('129','-1',b.keyHex,20,6)]},
  host:{refHex:'01'+'33'.repeat(32)+'0000000000000081000000000000000000'+'000000000000',originTile:0,destinationTile:0,initialMilli:300000,currentMilli:300000,transitState:'absent',fate:null},
  holding:{accountKeyHex:h.keyHex,tile:0,reserveUnits:600,escrowLamports:'0',poolOwedLamports:'0',openTransits:0},
  combat:{engagements:0,arrivalSurvivorMilli:null,enemyFixture:true},returned:{creditedUnits:0,creditedMilli:0},evidence:{instructions:[],recordsHex:[],accounts:[h,a,b,c,...landAccounts()]},routeQuote:null};
}
/** A consistent successful opening of ring-129 (p, q) on `prev`: the new province's bytes (opened now, no resolve
 * history, its own lamports as funded), the ring seed's count + 1, one wedge fund paying the rent with its two
 * opening counters + 1, the land summary + 1. `key` names the new account. */
export function openStep(prev,p,q,{key='10',wedge=0,region=3}={}){
 const n=structuredClone(prev);Object.assign(n,{command:'open_province',revision:prev.revision+1});
 n.evidence.instructions=['WideOpenProvince'];n.evidence.recordsHex=[];
 const bell=n.clock.bell;
 n.evidence.accounts.push(acct(key,provinceBytes(p,q,{resolvedNext:bell,openedBell:bell,region,funded:BigInt(PROVINCE_RENT)}),PROVINCE_RENT));
 n.map.provinces.push({p,q,accountKeyHex:key.repeat(32),passableMask:'0',source:'opened',openedBell:bell,resolvedNext:bell,wedge:ringPosition(BigInt(p),BigInt(q)).wedge,region});
 n.land.opened++;n.land.provincesCreated++;
 editBytes(n,'05',(b,d)=>d.setBigUint64(112,d.getBigUint64(112,true)+1n,true));
 const f=n.evidence.accounts.find(a=>a.keyHex===FUND_KEYS[wedge].repeat(32));f.lamports=String(BigInt(f.lamports)-BigInt(PROVINCE_RENT));
 editBytes(n,FUND_KEYS[wedge],(b,d)=>{d.setUint32(20,d.getUint32(20,true)+1,true);d.setUint32(44,d.getUint32(44,true)+1,true);});
 n.allowed=allowedFor(n.phase,n.economy.usedThisInstant,n.land.opened);
 return n;
}
/** A well-formed route-quote reply over the fixture's two provinces: `command:'quote_route'`, revision unchanged, routeQuote present. */
export function quoteReply(routeQuote) {
 const r = fixture(); Object.assign(r, { command: 'quote_route', routeQuote }); return r;
}
/** A reachable quote staying within the origin province (known, passable). */
const reachableQuote = {
 start:{p:'129',q:'0',tile:2}, reachable:true, reason:null, blockedStep:null,
 steps:[{p:'129',q:'0',tile:1,known:true,passable:true},{p:'129',q:'-1',tile:34,known:true,passable:true}],
 end:{p:'129',q:'-1',tile:34}, provincesEntered:[{p:'129',q:'0'},{p:'129',q:'-1'}],
};
/** An unreachable quote that steps into a province the host did not return. */
const unknownQuote = {
 start:{p:'129',q:'0',tile:2}, reachable:false, reason:'UNKNOWN_PROVINCE', blockedStep:1,
 steps:[{p:'129',q:'-1',tile:34,known:true,passable:true},{p:'129',q:'-2',tile:0,known:false,passable:null}],
 end:null, provincesEntered:[],
};
/** Edit one account's bytes in place (by key prefix byte). */
function editBytes(r,key,fn){const a=r.evidence.accounts.find(x=>x.keyHex===key.repeat(32));const b=fromHex(a.dataHex);fn(b,dv(b));a.dataHex=toHex(b);}
/** A consistent economy reply: bytes and the reported village moved together. */
function economyStep(prev,kind,{reserveDelta=kind==='train'?10:0,storeValue='1890000'}={}){
 const n=structuredClone(prev);Object.assign(n,{command:kind,revision:prev.revision+1});
 n.economy.usedThisInstant++;n.economy[{harvest:'harvests',build_farm:'farmBuilds',train:'trains'}[kind]]++;
 n.allowed=allowedFor(n.phase,n.economy.usedThisInstant,n.land.opened);
 n.evidence.instructions=[{harvest:'Harvest',build_farm:'BuildFarm',train:'Train'}[kind]];n.evidence.recordsHex=['00'];
 editBytes(n,'01',(b,d)=>{d.setBigInt64(152,BigInt(storeValue),true);d.setUint32(720,d.getUint32(720,true)+reserveDelta,true);});
 editBytes(n,'04',b=>{b[160]^=1;});
 n.village.stores[0]={...n.village.stores[0],value:storeValue};n.village.reserve[0]+=reserveDelta;n.holding.reserveUnits+=reserveDelta;
 return n;
}
test('strict structure and byte correspondence reject forged summaries',()=>{
 assert.equal(parseReplyObject(fixture()).phase,'ready');
 for(const edit of [r=>r.holding.reserveUnits++,r=>r.holding.escrowLamports='2',r=>r.holding.openTransits++,r=>r.map.provinces[0].passableMask='1',r=>r.evidence.accounts[0].ownerHex='ff'.repeat(32),r=>r.evidence.accounts.push(r.evidence.accounts[0]),r=>r.extra=true,r=>r.host.refHex='ff',r=>r.allowed.push('train'),
  r=>r.trained=false,r=>{r.protocol='wylls-local-march-v1';}]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r)); }
});
test('fixture isolation: no store, queue or account object is shared inside or across snapshots',()=>{
 const f=fixture();
 assert.equal(new Set(f.village.stores).size,8,'eight distinct store objects');
 assert.equal(new Set(f.village.queue).size,4,'four distinct queue objects');
 assert.equal(new Set(f.evidence.accounts).size,f.evidence.accounts.length);
 // mutating one snapshot deeply leaves the next snapshot intact and still byte-consistent
 f.village.stores[1].rate='1';f.village.stores[7].value='9';f.village.queue[1].kind=1;f.village.queue[3].delta='5';f.village.production[2]='7';f.village.reserve[4]=3;
 f.evidence.accounts[0].dataHex='00';f.horizon.originResolvedNext=99;f.economy.harvests=5;f.map.route[0].tile=9;
 const g=fixture();
 assert.equal(g.village.stores[1].rate,'0');assert.equal(g.village.stores[7].value,'0');assert.equal(g.village.queue[1].kind,0);assert.equal(g.village.queue[3].delta,'0');
 assert.equal(g.village.queue[0].kind,0,'a sibling slot never moves with another');assert.equal(g.village.stores[2].rate,'0');
 assert.equal(parseReplyObject(g).phase,'ready');
 assert.ok(g.village.stores.every(s=>!f.village.stores.includes(s)) && g.village.queue.every(q=>!f.village.queue.includes(q)));
 // within one snapshot, editing one slot never edits its siblings
 const h=fixture();h.village.queue[2].kind=4;assert.deepEqual(h.village.queue.map(q=>q.kind),[0,0,4,0]);
 h.village.stores[3].cap='1';assert.deepEqual(h.village.stores.map(s=>s.cap),['2000000','0','0','1','0','0','0','0']);
 // the step helper never edits its input
 const a=fixture(),before=JSON.stringify(a);for(const k of ['harvest','build_farm','train'])economyStep(a,k);assert.equal(JSON.stringify(a),before);
 assert.equal(parseReplyObject(fixture()).phase,'ready');
});
/** The refusal must be the one the case is about, not some earlier check failing by accident. */
const code = c => e => { assert.equal(e?.code, c); return true; };
test('every village and horizon number must be the account bytes, never an invented stock',()=>{
 // schema-valid reports that disagree with the returned bytes: refused by the byte decoder
 for(const edit of [
  r=>{r.village.stores[0].value='2000000';},r=>{r.village.stores[1].rate='1';},r=>{r.village.stores[0].t0='1';},r=>{r.village.stores[5].cap='1';},r=>{r.village.production[0]='52000';},
  r=>{r.village.queue[0]={doneAt:'1',kind:1,arg:0,delta:'12000'};},r=>{r.village.queue[3].delta='1';},r=>{r.village.reserve[1]=1;},r=>{r.village.tier=1;},r=>{r.village.lastOwnerAction='5';},
  r=>{r.horizon.originResolvedNext=6;},r=>{r.horizon.destinationResolvedNext=19;},
  r=>{r.evidence.accounts=r.evidence.accounts.filter(a=>a.keyHex!=='04'.repeat(32));}, // the holding's owner citizen account is missing
 ]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r),code('EvidenceMismatch'),String(edit)); }
 // off-schema reports: refused before any byte is read
 for(const edit of [
  r=>{r.village.reserve[0]=610;},r=>{r.horizon.destinationPreparedThroughBell=20;},r=>{r.horizon.model='SYNCHRONIZED';},
  r=>{r.economy.perInstantBudget=9;},r=>{r.economy.trainCount=11;},r=>{r.economy.usedThisInstant=9;},r=>{r.refusalCode=21;},
  r=>{r.village.stores[0].value='01900000';},r=>{r.village.stores[0].value='-0';},r=>{r.village.stores.pop();},r=>{r.village.queue.push({doneAt:'0',kind:0,arg:0,delta:'0'});},
 ]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r),code('BadReply'),String(edit)); }
 // the bytes and the report moving together is accepted
 const r=fixture();editBytes(r,'01',(b,d)=>d.setBigInt64(152,1234567n,true));r.village.stores[0].value='1234567';assert.equal(parseReplyObject(r).village.stores[0].value,'1234567');
 // a refusal code belongs to a handler refusal only
 const f=fixture();Object.assign(f,{status:'refused',error:'HANDLER_REFUSED',refusalCode:21});assert.equal(parseReplyObject(f).refusalCode,21);
 f.error='BAD_PHASE';assert.throws(()=>parseReplyObject(f));
});
test('commands have exact schemas and no caller supplied route/account/time/amount',()=>{
 assert.equal(commandLine(commandFromBody('action',{expectedRevision:1,action:'depart'})),'depart 1');
 for(const k of ['harvest','build_farm','train'])assert.equal(commandLine(commandFromBody('action',{expectedRevision:7,action:k})),`${k} 7`);
 for(const b of [{expectedRevision:0,action:'depart',p:'1'},{expectedRevision:-1,action:'train'},{expectedRevision:0,action:'advance'},{expectedRevision:0,action:'build'},{expectedRevision:0,action:'build_farm',item:6},{expectedRevision:0,action:'train',count:1000},{expectedRevision:0,action:'reset'}]) assert.throws(()=>commandFromBody('action',b));
 assert.throws(()=>commandFromBody('reset',{expectedRevision:0,action:'harvest'}));
});
test('allowed list: phase step plus economy until the per-instant budget is spent',()=>{
 assert.deepEqual(allowedFor('ready',0),['depart','harvest','build_farm','train','open_province','reset']);
 assert.deepEqual(allowedFor('ready',8),['depart','open_province','reset']);
 assert.deepEqual(allowedFor('returned',3),['harvest','build_farm','train','open_province','reset']);
 // opening is bounded by the land budget, not by the per-instant economy budget
 assert.deepEqual(allowedFor('ready',8,4),['depart','reset']);
 assert.deepEqual(allowedFor('ready',0,3),['depart','harvest','build_farm','train','open_province','reset']);
});
test('route-quote command: a bounded directions string chosen by the player, nothing else',()=>{
 assert.equal(commandLine(commandFromQuoteBody({dirs:'222'})),'quote_route 222');
 assert.equal(commandLine({kind:'quote_route',dirs:'012345'}),'quote_route 012345');
 for(const d of ['222','0','5','0'.repeat(MAX_ROUTE_DIRS)]) assert.ok(routeDirsOk(d),d);
 for(const d of ['','6','2x','29','-1','0'.repeat(MAX_ROUTE_DIRS+1),'2 2',' 2',2,null]) assert.ok(!routeDirsOk(d),String(d));
 for(const b of [{},{dirs:''},{dirs:'6'},{dirs:'2',extra:1},{dir:'2'},{dirs:2}]) assert.throws(()=>commandFromQuoteBody(b),e=>e.code==='BadCommand');
 // a quote command never carries a revision, account, coordinate or amount
 assert.throws(()=>commandLine({kind:'quote_route',dirs:'2 extra'}));
});
test('a route quote is present exactly on a successful quote_route and never carries records',()=>{
 const ok=quoteReply(reachableQuote);assert.equal(parseReplyObject(ok).routeQuote.reachable,true);
 // a non-quote reply must carry a null quote
 const g=fixture();g.routeQuote=reachableQuote;assert.throws(()=>parseReplyObject(g),e=>e.code==='BadReply');
 // a quote_route reply must carry a quote (not null) when ok
 const empty=quoteReply(null);assert.throws(()=>parseReplyObject(empty),e=>e.code==='BadReply');
 // a quote reply with new records is refused
 const rec=quoteReply(reachableQuote);rec.evidence.recordsHex=['00'];assert.throws(()=>parseReplyObject(rec));
});
test('route-quote honesty: reachable iff an end and no reason, and only over known passable land',()=>{
 const ps=new Set(['129,0','129,-1']);
 assert.doesNotThrow(()=>parseRouteQuote(reachableQuote,ps));
 assert.doesNotThrow(()=>parseRouteQuote(unknownQuote,ps));
 const bad=[
  q=>{q.reachable=false;},                               // reachable but reason null and end set -> inconsistent
  q=>{q.end=null;},                                       // reachable but no end
  q=>{q.reason='IMPASSABLE';},                            // reachable but a reason
  q=>{q.steps[0].passable=false;},                        // reachable but an impassable step
  q=>{q.steps[0].known=false;},                           // reachable but an unknown step
  q=>{q.steps[0].p='130';},                               // a step whose province the host did not return, marked known
  q=>{q.provincesEntered=[{p:'130',q:'0'}];},             // an entered province not among the host's
  q=>{q.start.p='130';},                                  // the start is not one of the host's provinces
 ];
 for(const edit of bad){const q=structuredClone(reachableQuote);edit(q);assert.throws(()=>parseRouteQuote(q,ps),String(edit));}
 const badUnknown=[
  q=>{q.end={p:'129',q:'-1',tile:0};},                    // unreachable but an end set
  q=>{q.reason=null;},                                    // unreachable but no reason
  q=>{q.steps[1].passable=true;},                         // an unknown step must have null passability
 ];
 for(const edit of badUnknown){const q=structuredClone(unknownQuote);edit(q);assert.throws(()=>parseRouteQuote(q,ps),String(edit));}
});
test('checkQuote accepts a non-mutating quote and rejects any state or revision drift',()=>{
 const prev=fixture();
 const ok=quoteReply(reachableQuote);
 assert.equal(checkQuote(prev,ok).reachable,true);
 const drift=[
  n=>{n.revision=1;},n=>{n.phase='departed';n.allowed=allowedFor('departed',0);},n=>{n.host.currentMilli--;},
  n=>{n.command='depart';},n=>{n.status='refused';n.error='X';n.routeQuote=null;},n=>{n.village.reserve[0]=610;},
 ];
 for(const edit of drift){const n=quoteReply(reachableQuote);edit(n);assert.throws(()=>checkQuote(prev,n));}
});
test('economy transition: same phase and instant, counters by one, only the village accounts changed',()=>{
 const a=fixture();
 for(const kind of ['harvest','build_farm','train']) assert.equal(checkTransition(a,{kind,rev:0},economyStep(a,kind),a),'ok');
 const bad=[
  ['BadClock',n=>{n.clock={unix:'1790448508',bell:6};}],['BadPhase',n=>{n.phase='departed';n.allowed=allowedFor('departed',1);}],['BadEconomy',n=>{n.economy.usedThisInstant--;n.allowed=allowedFor(n.phase,n.economy.usedThisInstant);}],
  ['BadEconomy',n=>{n.economy.trains++;}],['BadEconomy',n=>{n.host.currentMilli--;}],['BadEconomy',n=>{n.evidence.instructions=['Train'];}],['BadEconomy',n=>{n.evidence.recordsHex=[];}],
  ['BadEconomy',n=>editBytes(n,'03',b=>{b[100]^=1;})], // a destination byte moved under an economy command
  ['BadEconomy',n=>{n.evidence.accounts[0].lamports='1';}],
 ];
 for(const [want,edit] of bad){const n=economyStep(a,'harvest');edit(n);assert.throws(()=>checkTransition(a,{kind:'harvest',rev:0},n,a),code(want),String(edit));}
 // the train's reserve credit is its own fixed request count, compared, not computed
 assert.throws(()=>checkTransition(a,{kind:'train',rev:0},economyStep(a,'train',{reserveDelta:11}),a),code('BadEconomy'));
 assert.throws(()=>checkTransition(a,{kind:'harvest',rev:0},economyStep(a,'harvest',{reserveDelta:10}),a),code('BadEconomy'));
});
test('phase steps keep economy counters; a new instant resets the per-instant budget',()=>{
 const a=economyStep(fixture(),'harvest'),b=structuredClone(a);
 Object.assign(b,{command:'depart',revision:2,phase:'departed'});b.allowed=allowedFor('departed',1);b.evidence.instructions=['Depart'];b.evidence.recordsHex=['00'];
 assert.equal(checkTransition(a,{kind:'depart',rev:1},b,fixture()),'ok');
 const reset0=structuredClone(b);reset0.economy.usedThisInstant=0;reset0.allowed=allowedFor('departed',0);assert.throws(()=>checkTransition(a,{kind:'depart',rev:1},reset0,fixture()),code('BadEconomy'),'same instant keeps the budget used');
 const c=structuredClone(b);Object.assign(c,{command:'settle_departure',revision:3,phase:'travelling',clock:{unix:'1790449707',bell:8}});c.economy.usedThisInstant=0;c.allowed=allowedFor('travelling',0);c.evidence.instructions=['Resolve','Resolve','SettleDeparture'];
 assert.equal(checkTransition(b,{kind:'settle_departure',rev:2},c,fixture()),'ok');
 const stuck=structuredClone(c);stuck.economy.usedThisInstant=1;stuck.allowed=allowedFor('travelling',1);assert.throws(()=>checkTransition(b,{kind:'settle_departure',rev:2},stuck,fixture()),code('BadEconomy'));
 const counted=structuredClone(c);counted.economy.harvests=0;assert.throws(()=>checkTransition(b,{kind:'settle_departure',rev:2},counted,fixture()),code('BadEconomy'));
});
/** A phase step at `phase` on `prev`; `cursor` moves the origin (i=0, account '02') or destination (i=1, '03')
 * resolve cursor consistently in the bytes, the province summary and the horizon, as real Resolve does. */
function phaseStep(prev,kind,phase,{cursor=null,clock=prev.clock}={}){
 const n=structuredClone(prev);Object.assign(n,{command:kind,revision:prev.revision+1,phase,clock:{...clock}});
 if(clock.unix!==prev.clock.unix)n.economy.usedThisInstant=0;
 n.allowed=allowedFor(phase,n.economy.usedThisInstant,n.land.opened);n.evidence.instructions=['Resolve'];n.evidence.recordsHex=['00'];
 if(cursor){const [i,v]=cursor;editBytes(n,i===0?'02':'03',(b,d)=>d.setUint32(72,v,true));n.map.provinces[i].resolvedNext=v;n.horizon[i===0?'originResolvedNext':'destinationResolvedNext']=v;}
 return n;
}
test('a phase step may only advance the fixtures\' resolve cursors; every other map field and every opened province stay exact',()=>{
 const a=fixture(),settle={unix:'1790449707',bell:8};
 const b=phaseStep(a,'depart','departed');assert.equal(checkTransition(a,{kind:'depart',rev:0},b,a),'ok');
 // real Resolve at settlement moves the origin cursor 5 -> 8: accepted (bytes, summary and horizon agree)
 const c=phaseStep(b,'settle_departure','travelling',{cursor:[0,8],clock:settle});
 assert.equal(checkTransition(b,{kind:'settle_departure',rev:1},c,a),'ok');
 const T=(n,want)=>assert.throws(()=>checkTransition(b,{kind:'settle_departure',rev:1},n,a),code(want));
 // a cursor never moves back, even when bytes, summary and horizon agree
 T(phaseStep(b,'settle_departure','travelling',{cursor:[0,4],clock:settle}),'CursorRegressed');
 T(phaseStep(b,'settle_departure','travelling',{cursor:[1,19],clock:settle}),'CursorRegressed');
 // a summary cursor that is not the account's bytes, or not the horizon, is refused before any transition rule
 const summaryOnly=phaseStep(b,'settle_departure','travelling',{clock:settle});summaryOnly.map.provinces[0].resolvedNext=8;summaryOnly.horizon.originResolvedNext=8;T(summaryOnly,'EvidenceMismatch');
 const noHorizon=phaseStep(b,'settle_departure','travelling',{cursor:[0,8],clock:settle});noHorizon.horizon.originResolvedNext=5;T(noHorizon,'EvidenceMismatch');
 // anything else of a province changing under a phase step is an identity change (here its mask, consistently)
 const mask=phaseStep(b,'settle_departure','travelling',{cursor:[0,8],clock:settle});editBytes(mask,'02',(x,d)=>d.setBigUint64(264,1n,true));mask.map.provinces[0].passableMask='1';T(mask,'IdentityChanged');
 // the economy still may not move the map at all, not even a consistent cursor
 const e=economyStep(a,'harvest');editBytes(e,'02',(x,d)=>d.setUint32(72,6,true));e.map.provinces[0].resolvedNext=6;e.horizon.originResolvedNext=6;
 assert.throws(()=>checkTransition(a,{kind:'harvest',rev:0},e,a),code('IdentityChanged'));
 // an opened province is not on the fixed march: its account stays byte-identical through every phase step
 const o=openStep(a,'129','-2');assert.equal(checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-2'},o,a),'ok');
 const od=phaseStep(o,'depart','departed');assert.equal(checkTransition(o,{kind:'depart',rev:1},od,a),'ok');
 const touched=phaseStep(o,'depart','departed');editBytes(touched,'10',x=>{x[1000]^=1;});
 assert.throws(()=>checkTransition(o,{kind:'depart',rev:1},touched,a),code('IdentityChanged'));
 const paid=phaseStep(o,'depart','departed');paid.evidence.accounts.find(x=>x.keyHex==='10'.repeat(32)).lamports='1';
 assert.throws(()=>checkTransition(o,{kind:'depart',rev:1},paid,a));
});
test('phase, monotone clock and reset baseline are enforced',()=>{
 const a=fixture(),b=structuredClone(a);Object.assign(b,{command:'depart',revision:1,phase:'departed',allowed:['settle_departure','harvest','build_farm','train','open_province','reset']});b.evidence.instructions=['Depart'];b.evidence.recordsHex=['00'];
 assert.equal(checkTransition(a,{kind:'depart',rev:0},b,a),'ok');
 const c=structuredClone(b);c.clock.unix='1';assert.throws(()=>checkTransition(a,{kind:'depart',rev:0},c,a),code('BadClock'));
 const reset=structuredClone(a);Object.assign(reset,{command:'reset',revision:2});assert.equal(checkTransition(b,{kind:'reset',rev:1},reset,a),'ok');
 reset.host.currentMilli++;assert.throws(()=>checkTransition(b,{kind:'reset',rev:1},reset,a),code('BadReset'));
 const villageReset=structuredClone(a);Object.assign(villageReset,{command:'reset',revision:2});villageReset.economy.harvests=1;assert.throws(()=>checkTransition(b,{kind:'reset',rev:1},villageReset,a),code('BadReset'));
});
test('controller stale duplicate never contacts host and malformed response is permanently uncertain',async()=>{
 let calls=0,closed=0; const initial=fixture(); const bridge={alive:true,close(){closed++;},async exchange(){calls++;if(calls===1)return JSON.stringify(initial);return '{}';}};
 const c=createController({bridge});assert.equal((await c.start()).status,200);
 assert.equal((await c.mutate({kind:'harvest',rev:8})).status,409);assert.equal(calls,1);
 assert.equal((await c.mutate({kind:'harvest',rev:0})).status,502);assert.equal(c.phase,'uncertain');assert.equal(c.view().reply,null);
 assert.equal((await c.mutate({kind:'depart',rev:0})).status,503);assert.equal(calls,2);assert.equal(closed,1);
});
test('controller refuses a first state that already carries economy history',async()=>{
 const used=fixture();used.economy.harvests=1;
 const c=createController({bridge:{alive:true,close(){},async exchange(){return JSON.stringify(used);}}});
 assert.equal((await c.start()).status,502);assert.equal(c.phase,'uncertain');
});
test('controller serializes economy commands and judges each against its predecessor',async()=>{
 const a=fixture(),b=economyStep(a,'harvest');let calls=[];
 const bridge={alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(calls.length===1?a:b);}};
 const c=createController({bridge});await c.start();
 const [one,two]=await Promise.all([c.mutate({kind:'harvest',rev:0}),c.mutate({kind:'harvest',rev:0})]);
 assert.equal(one.status,200);assert.equal(one.body.outcome,'ok');assert.equal(two.status,409,'the duplicate is stale inside the queue');
 assert.deepEqual(calls,['get','harvest 0']);
});
test('controller route quote is a read: validated against the cached state, never mutating it',async()=>{
 let calls=[];const initial=fixture();
 const bridge={alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(line==='get'?initial:quoteReply(reachableQuote));}};
 const c=createController({bridge});await c.start();
 const r=await c.quote({kind:'quote_route',dirs:'222'});
 assert.equal(r.status,200);assert.equal(r.body.routeQuote.reachable,true);
 assert.deepEqual(calls,['get','quote_route 222']);
 assert.equal(c.view().revision,0);assert.equal(c.phase,'ready');assert.ok(c.view().reply);
});
test('controller route quote: a drifting reply makes the session uncertain for good',async()=>{
 const initial=fixture();const drift=quoteReply(reachableQuote);drift.revision=1;
 const bridge={alive:true,close(){},async exchange(line){return JSON.stringify(line==='get'?initial:drift);}};
 const c=createController({bridge});await c.start();
 const r=await c.quote({kind:'quote_route',dirs:'2'});
 assert.equal(r.status,502);assert.equal(c.phase,'uncertain');assert.equal(c.view().reply,null);
});
test('HTTP boundary rejects escape routes, missing origin and noncanonical bodies',()=>{
 for(const s of ['/../a','/%2e/a','//a','/a?x=1','/a\\b'])assert.equal(cleanPath(s),null);
 assert.equal(mutationHeaderProblem({},'http://127.0.0.1:1'),403);
 assert.throws(()=>parseCanonicalJson(Buffer.from('{"a":1,"a":1}')));
 assert.throws(()=>parseCanonicalJson(Buffer.from('{ "a":1}')));
});

test('refusal preserves all map, clock, village and account state',()=>{
 const a=fixture(),b=structuredClone(a);Object.assign(b,{status:'refused',error:'HANDLER_REFUSED',refusalCode:21,command:'build_farm'});
 assert.equal(checkTransition(a,{kind:'build_farm',rev:0},b,a),'refused');
 const c=structuredClone(b);c.economy.farmBuilds=1;assert.throws(()=>checkTransition(a,{kind:'build_farm',rev:0},c,a),code('BadTransition'));
 b.host.currentMilli--;assert.throws(()=>checkTransition(a,{kind:'build_farm',rev:0},b,a),code('BadTransition'));
});
test('cross-origin/API reads and mutations rejected; top-level navigation only exception',()=>{
 const host='127.0.0.1:55555';
 assert.equal(requestAllowed({host:'localhost:55555'},host,'GET','/api/state'),false);
 const cross={host,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 assert.equal(requestAllowed(cross,host,'GET','/api/state'),false);
 assert.equal(requestAllowed(cross,host,'GET','/permutation-gateway/screens/wide-march-local/index.html'),true);
 const h={host,origin:'http://'+host,'sec-fetch-site':'same-origin','x-wylls-local-action':PROTOCOL,'content-type':'application/json','content-length':'2'};
 assert.equal(mutationHeaderProblem(h,'http://'+host),0);
 assert.equal(mutationHeaderProblem({...h,origin:'https://evil.example'},'http://'+host),403);
 assert.equal(mutationHeaderProblem({...h,'sec-fetch-site':'cross-site'},'http://'+host),403);
 assert.equal(mutationHeaderProblem({...h,'x-wylls-local-action':'wylls-local-march-v1'},'http://'+host),403,'the old protocol label is not accepted');
});
test('child death while idle clears cached view and blocks further mutations',async()=>{
 const bridge={alive:true,close(){},async exchange(){return JSON.stringify(fixture());}};
 const c=createController({bridge});await c.start();bridge.alive=false;bridge.deadReason='Exit';
 assert.equal(c.state().body.view.reply,null);assert.equal(c.phase,'uncertain');
 assert.equal((await c.mutate({kind:'harvest',rev:0})).status,503);
});
const response = r => ({status:200,text:async()=>JSON.stringify({view:{v:1,protocol:PROTOCOL,mode:'local-simulation',mockAuth:true,phase:'ready',uncertain:false,revision:r.revision,reply:r,lastResult:null}})});
test('browser duplicate submit blocked, network failure clears map/state, no retry; explicit GET recovers',async()=>{
 let calls=[], rejectSend;const initial=fixture();
 const client=createClient({fetchFn:async(path,init)=>{calls.push([path,init.method]);if(init.method==='GET')return response(initial);return new Promise((_,reject)=>{rejectSend=reject;});}});
 await client.refresh();assert.equal(client.snapshot.phase,'ready');const pending=client.submit({kind:'harvest'});
 assert.equal((await client.submit({kind:'train'})).reason,'busy');assert.equal(calls.length,2);
 rejectSend(new Error('lost'));await pending;assert.equal(client.snapshot.state,null);assert.equal(client.snapshot.phase,'error');assert.equal(calls.length,2);
 await client.refresh();assert.equal(client.snapshot.phase,'ready');assert.deepEqual(calls.map(c=>c[1]),['GET','POST','GET']);
});
test('browser stale revision response updates without automatic replay',async()=>{
 let calls=0;const a=fixture(),b=economyStep(a,'harvest');
 const client=createClient({fetchFn:async()=>{calls++;return calls===1?response(a):{...response(b),status:409};}});
 await client.refresh();assert.equal((await client.submit({kind:'harvest'})).reason,'stale');assert.equal(calls,2);assert.equal(client.snapshot.state.revision,1);
});
test('browser accepts a judged economy reply and shows the host refusal code verbatim',async()=>{
 const a=fixture(),b=economyStep(a,'train');let n=0;
 const view=(r,last)=>({status:200,text:async()=>JSON.stringify({outcome:last.outcome,view:{v:1,protocol:PROTOCOL,mode:'local-simulation',mockAuth:true,phase:'ready',uncertain:false,revision:r.revision,reply:r,lastResult:last}})});
 const client=createClient({fetchFn:async(_p,init)=>{n++;if(init.method==='GET')return response(a);return view(b,{command:'train',outcome:'ok',code:null,revision:1});}});
 await client.refresh();const r=await client.submit({kind:'train'});assert.equal(r.ok,true);assert.equal(client.snapshot.state.village.reserve[0],610);
 const refused=structuredClone(b);Object.assign(refused,{status:'refused',error:'HANDLER_REFUSED',refusalCode:17,command:'train'});refused.evidence.instructions=[];refused.evidence.recordsHex=[];
 const client2=createClient({fetchFn:async(_p,init)=>init.method==='GET'?response(b):view(refused,{command:'train',outcome:'refused',code:'HANDLER_REFUSED',revision:1})});
 await client2.refresh();const r2=await client2.submit({kind:'train'});assert.equal(r2.reason,'refused');assert.equal(client2.snapshot.state.refusalCode,17);assert.equal(client2.snapshot.notice.code,'HANDLER_REFUSED');
 assert.ok(n>=2);
});
const quoteResponse = (rq, state) => ({ status: 200, text: async () => JSON.stringify({ routeQuote: rq, view: { v: 1, protocol: PROTOCOL, mode: 'local-simulation', mockAuth: true, phase: 'ready', uncertain: false, revision: state.revision, reply: state, lastResult: null } }) });
test('browser route quote attaches a validated quote and never mutates the shown state',async()=>{
 const a=fixture();let calls=[];
 const client=createClient({fetchFn:async(path,init)=>{calls.push([path,init.method]);return init.method==='GET'?response(a):quoteResponse(reachableQuote,a);}});
 await client.refresh();
 const r=await client.quote('222');
 assert.equal(r.ok,true);assert.equal(client.snapshot.quote.reachable,true);assert.equal(client.snapshot.quoteDirs,'222');
 assert.equal(client.snapshot.state.revision,0);assert.equal(client.snapshot.phase,'ready');
 assert.deepEqual(calls,[['/api/state','GET'],['/api/quote','POST']]);
 // an input the schema refuses never leaves the browser
 assert.equal((await client.quote('6')).reason,'input');assert.equal(calls.length,2);
 // a following refresh clears the stale quote
 await client.refresh();assert.equal(client.snapshot.quote,null);
});
test('browser route quote: a reply that drifts from the shown revision fails closed',async()=>{
 const a=fixture(),drift=structuredClone(a);drift.revision=1;
 const client=createClient({fetchFn:async(_p,init)=>init.method==='GET'?response(a):quoteResponse(reachableQuote,drift)});
 await client.refresh();const r=await client.quote('2');
 assert.equal(r.reason,'unknown');assert.equal(client.snapshot.phase,'error');assert.equal(client.snapshot.state,null);
});

// ------------------------------------------------------------------ v3: LOCAL land records and openings
test('the LOCAL land records are re-read from their bytes, never taken from the summary',()=>{
 assert.equal(parseReplyObject(fixture()).land.opened,0);
 const evidence=[
  r=>editBytes(r,'05',b=>{b[48]^=1;}),                                   // ring seed is not the pinned literal
  r=>editBytes(r,'05',(b,d)=>d.setBigUint64(40,1n,true)),                // ring seed round
  r=>editBytes(r,'05',b=>{b[18]=1;}),                                    // ring seed not Seeded
  r=>editBytes(r,'05',(b,d)=>d.setBigUint64(20,130n,true)),              // another ring
  r=>editBytes(r,'05',(b,d)=>d.setBigUint64(112,4n,true)),               // provinces created disagrees
  r=>editBytes(r,'06',b=>{b[19]=1;}),                                    // a rule byte
  r=>editBytes(r,'06',b=>{b[56]^=1;}),                                   // the authority
  r=>editBytes(r,'09',b=>{b[16]=5;}),                                    // a fund's wedge byte
  r=>editBytes(r,'0a',(b,d)=>d.setUint32(20,1,true)),                    // a fund claims an opening
  r=>editBytes(r,'02',b=>{b[4800]^=1;}),                                 // a province's seed is not the record's
  r=>editBytes(r,'03',(b,d)=>d.setBigUint64(4792,7n,true)),              // a province's round
  r=>editBytes(r,'02',b=>{b[70]^=1;}),                                   // the prefix wedge disagrees with the key
  r=>editBytes(r,'03',b=>{b[71]^=1;}),                                   // the region byte
  r=>editBytes(r,'02',(b,d)=>d.setUint32(76,2,true)),                    // the opened bell
  r=>{r.land.ringSeedKeyHex='04'.repeat(32);},                           // a record key naming another account
 ];
 for(const edit of evidence){const r=fixture();edit(r);assert.throws(()=>parseReplyObject(r),code('EvidenceMismatch'),String(edit));}
 const schema=[
  r=>{r.land.budget=5;},r=>{r.land.ring=130;},r=>{r.land.opened=1;},r=>{r.land.provenance.ringSeed='VERIFIED_BEACON';},
  r=>{delete r.land.provenance.golden;},r=>{r.land.fundKeysHex[1]=r.land.fundKeysHex[0];},r=>{r.land.extra=1;},
  r=>{r.map.provinces[0].source='opened';},r=>{r.map.provinces.reverse();},r=>{r.map.provinces[1].wedge=6;},
  r=>{r.allowed=r.allowed.filter(k=>k!=='open_province');},
 ];
 for(const edit of schema){const r=fixture();edit(r);assert.throws(()=>parseReplyObject(r),code('BadReply'),String(edit));}
});
test('an opened province must be ring 129, opened now, with no resolve history',()=>{
 const ok=openStep(fixture(),'129','-2');
 assert.equal(parseReplyObject(ok).map.provinces.length,3);
 for(const edit of [
  n=>{n.map.provinces[2].source='fixture';},n=>{n.map.provinces[2].resolvedNext=7;},n=>{n.map.provinces[2].openedBell=7;},
  n=>{n.land.opened=0;},n=>{n.land.provincesCreated=3;},n=>{n.map.provinces[2].p='129';n.map.provinces[2].q='0';},
 ]){const n=openStep(fixture(),'129','-2');edit(n);assert.throws(()=>parseReplyObject(n),String(edit));}
 // a ring-130 "province" is refused before its bytes are read
 const far=openStep(fixture(),'130','0');assert.throws(()=>parseReplyObject(far),code('BadReply'));
 // an opened province's funded lamports are its own
 const f=openStep(fixture(),'129','-2');editBytes(f,'10',(b,d)=>d.setBigUint64(4832,1n,true));assert.throws(()=>parseReplyObject(f),code('EvidenceMismatch'));
});
test('open transition: exactly the asked province, the ring seed and one fund change; nothing of the village or march',()=>{
 const a=fixture();
 assert.equal(checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-2'},openStep(a,'129','-2'),a),'ok');
 const bad=[
  ['BadOpen',n=>{n.clock={unix:'1790448508',bell:6};}],
  ['BadOpen',n=>{n.economy.harvests=1;}],
  ['BadOpen',n=>{n.host.currentMilli--;}],
  ['BadOpen',n=>editBytes(n,'01',b=>{b[540]^=1;})],                       // the holding moved under an opening (an upkeep byte no summary reports)
  ['BadOpen',n=>editBytes(n,'08',b=>{b[100]^=1;})],                       // a second fund changed
  ['BadOpen',n=>{n.evidence.accounts.find(x=>x.keyHex==='07'.repeat(32)).lamports=String(BigInt(FUND_LAMPORTS)-1n);}], // the fund paid the wrong amount
  ['BadOpen',n=>{n.returned.creditedUnits=1;}],
 ];
 for(const [want,edit] of bad){const n=openStep(a,'129','-2');edit(n);assert.throws(()=>checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-2'},n,a),code(want),String(edit));}
 // a reply for another coordinate than the one asked
 assert.throws(()=>checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-3'},openStep(a,'129','-2'),a),code('BadOpen'));
 // a refused opening changes nothing at all
 const refused=structuredClone(a);Object.assign(refused,{status:'refused',error:'LAND_DUPLICATE_OPEN',command:'open_province'});
 assert.equal(checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'0'},refused,a),'refused');
 const dirty=structuredClone(refused);dirty.land.opened=1;assert.throws(()=>checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'0'},dirty,a));
 // economy and phase steps may not touch the land
 const step=economyStep(a,'harvest');step.land.provincesCreated=4;assert.throws(()=>checkTransition(a,{kind:'harvest',rev:0},step,a));
 // the budget: a fourth opening removes open_province from the allowed list, a fifth is not offered
 let s=a;for(const [i,[p,q]] of [['129','-2'],['129','-3'],['128','1'],['127','2']].entries()){const n=openStep(s,p,q,{key:`1${i}`,wedge:i});assert.equal(checkTransition(s,{kind:'open_province',rev:s.revision,p,q},n,a),'ok');s=n;}
 assert.ok(!s.allowed.includes('open_province'));
 assert.throws(()=>checkTransition(s,{kind:'open_province',rev:s.revision,p:'126',q:'3'},openStep(s,'126','3',{key:'15',wedge:4}),a));
 // reset back to the installed baseline
 const reset=structuredClone(a);Object.assign(reset,{command:'reset',revision:s.revision+1});assert.equal(checkTransition(s,{kind:'reset',rev:s.revision},reset,a),'ok');
});
test('open commands carry only the shown revision and canonical coordinate strings',()=>{
 assert.equal(commandLine(commandFromBody('open',{expectedRevision:3,p:'129',q:'-2'})),'open_province 3 129 -2');
 assert.equal(commandLine(commandFromBody('open',{expectedRevision:0,p:'-4611686018427387904',q:'4611686018427387904'})),'open_province 0 -4611686018427387904 4611686018427387904');
 for(const b of [{expectedRevision:0,p:129,q:'-2'},{expectedRevision:0,p:'0129',q:'-2'},{expectedRevision:0,p:'129',q:'-02'},{expectedRevision:0,p:'-0',q:'0'},
  {expectedRevision:0,p:'129'},{expectedRevision:0,p:'129',q:'-2',ring:'129'},{expectedRevision:0,p:'4611686018427387905',q:'0'},{expectedRevision:-1,p:'129',q:'-2'},{p:'129',q:'-2'}])
  assert.throws(()=>commandFromBody('open',b),code('BadCommand'),JSON.stringify(b));
 assert.throws(()=>commandFromBody('action',{expectedRevision:0,action:'open_province'}),code('BadCommand'));
});
test('controller opening is serialized and judged; a stale duplicate never reaches the host',async()=>{
 const a=fixture(),b=openStep(a,'129','-2');let calls=[];
 const bridge={alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(calls.length===1?a:b);}};
 const c=createController({bridge});await c.start();
 const cmd=commandFromBody('open',{expectedRevision:0,p:'129',q:'-2'});
 const [one,two]=await Promise.all([c.mutate(cmd),c.mutate(cmd)]);
 assert.equal(one.status,200);assert.equal(one.body.outcome,'ok');assert.equal(two.status,409);
 assert.deepEqual(calls,['get','open_province 0 129 -2']);
 assert.equal(c.view().reply.land.opened,1);
});
test('controller refuses a first state that already carries opened land',async()=>{
 const opened=openStep(fixture(),'129','-2');Object.assign(opened,{command:'get',revision:0});opened.evidence.instructions=[];
 const c=createController({bridge:{alive:true,close(){},async exchange(){return JSON.stringify(opened);}}});
 assert.equal((await c.start()).status,502);assert.equal(c.phase,'uncertain');
});
test('browser open intent posts the coordinate to /api/open and adopts the judged opening',async()=>{
 const a=fixture(),b=openStep(a,'129','-2');let calls=[];
 const view=r=>({status:200,text:async()=>JSON.stringify({outcome:'ok',view:{v:1,protocol:PROTOCOL,mode:'local-simulation',mockAuth:true,phase:'ready',uncertain:false,revision:r.revision,reply:r,lastResult:{command:'open_province',outcome:'ok',code:null,revision:r.revision}}})});
 const client=createClient({fetchFn:async(path,init)=>{calls.push([path,init.method,init.body??null]);return init.method==='GET'?response(a):view(b);}});
 await client.refresh();
 const r=await client.submit({kind:'open_province',p:'129',q:'-2'});
 assert.equal(r.ok,true);assert.equal(client.snapshot.state.land.opened,1);
 assert.deepEqual(calls[1],['/api/open','POST','{"expectedRevision":0,"p":"129","q":"-2"}']);
 // a malformed coordinate never leaves the browser
 assert.equal((await client.submit({kind:'open_province',p:'1e3',q:'0'})).reason,'input');assert.equal(calls.length,2);
});
