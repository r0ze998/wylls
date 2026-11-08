// Synthetic structure-only test snapshots. Never used by the actual demo or a real-host claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, SESSION, parseReplyObject, commandFromBody, commandLine, checkTransition, allowedFor } from '../screens/wide-march-local/local-model.mjs';
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
const acct=(key,b)=>({keyHex:key.repeat(32),ownerHex:'12'.repeat(32),lamports:'0',dataHex:toHex(b)});
const dv=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
// Factories, never shared objects: every fixture() call and every store/queue entry is a fresh object, so a test
// that mutates one snapshot can never leak into another (Array(n).fill(obj) would alias one object n times).
const zeroStore=()=>({value:'0',rate:'0',cap:'0',t0:'0'});
const freeSlot=()=>({doneAt:'0',kind:0,arg:0,delta:'0'});
export function fixture() {
 const hb=raw(1344,'PSFXWHL1',1320,129,0),hd=dv(hb);
 hb.fill(0x04,72,104); // OWNER_CITIZEN: the village citizen account below
 hd.setBigInt64(152,1900000n,true);hd.setBigInt64(160,40000n,true);hd.setBigInt64(168,2000000n,true);hd.setBigInt64(176,1790447367n,true);
 hd.setBigInt64(472,40000n,true);hd.setUint32(720,600,true);
 const ob=raw(4864,'PSFXWPV1',4772,129,0),db=raw(4864,'PSFXWPV1',4772,129,-1);dv(ob).setUint32(72,5,true);dv(db).setUint32(72,20,true);
 const cb=Buffer.alloc(384);cb.write('PSF1CITZ');
 const h=acct('01',hb),a=acct('02',ob),b=acct('03',db),c=acct('04',cb);
 return {protocol:PROTOCOL,mode:'local-only',auth:'MOCK_AUTH_NO_SIGNATURE',beacon:'PUBLIC_FIXTURES_REAL_VERIFICATION',session:SESSION,status:'ok',error:null,refusalCode:null,command:'get',revision:0,phase:'ready',
  allowed:['depart','harvest','build_farm','train','reset'],clock:{unix:'1790448507',bell:6},
  horizon:{model:'PHASE_STEPS_ONLY',finalBell:25,destinationPreparedThroughBell:19,originResolvedNext:5,destinationResolvedNext:20},
  economy:{perInstantBudget:8,usedThisInstant:0,harvests:0,farmBuilds:0,trains:0,farmItem:0,trainUnit:0,trainCount:10},
  village:{tier:0,flags:0,lastOwnerAction:'0',stores:[{value:'1900000',rate:'40000',cap:'2000000',t0:'1790447367'},...Array.from({length:7},zeroStore)],production:['40000',...Array(7).fill('0')],queue:Array.from({length:4},freeSlot),reserve:[600,0,0,0,0,0,0,0]},
  map:{worldHex:'33'.repeat(32),origin:{p:'129',q:'0'},destination:{p:'129',q:'-1'},route:[{p:'129',q:'0',tile:0},{p:'129',q:'-1',tile:0}],provinces:[{p:'129',q:'0',accountKeyHex:a.keyHex,passableMask:'0'},{p:'129',q:'-1',accountKeyHex:b.keyHex,passableMask:'0'}]},
  host:{refHex:'01'+'33'.repeat(32)+'0000000000000081000000000000000000'+'000000000000',originTile:0,destinationTile:0,initialMilli:300000,currentMilli:300000,transitState:'absent',fate:null},
  holding:{accountKeyHex:h.keyHex,tile:0,reserveUnits:600,escrowLamports:'0',poolOwedLamports:'0',openTransits:0},
  combat:{engagements:0,arrivalSurvivorMilli:null,enemyFixture:true},returned:{creditedUnits:0,creditedMilli:0},evidence:{instructions:[],recordsHex:[],accounts:[h,a,b,c]}};
}
/** Edit one account's bytes in place (by key prefix byte). */
function editBytes(r,key,fn){const a=r.evidence.accounts.find(x=>x.keyHex===key.repeat(32));const b=fromHex(a.dataHex);fn(b,dv(b));a.dataHex=toHex(b);}
/** A consistent economy reply: bytes and the reported village moved together. */
function economyStep(prev,kind,{reserveDelta=kind==='train'?10:0,storeValue='1890000'}={}){
 const n=structuredClone(prev);Object.assign(n,{command:kind,revision:prev.revision+1});
 n.economy.usedThisInstant++;n.economy[{harvest:'harvests',build_farm:'farmBuilds',train:'trains'}[kind]]++;
 n.allowed=allowedFor(n.phase,n.economy.usedThisInstant);
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
  r=>{r.evidence.accounts.pop();}, // the holding's owner citizen account is missing
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
 assert.deepEqual(allowedFor('ready',0),['depart','harvest','build_farm','train','reset']);
 assert.deepEqual(allowedFor('ready',8),['depart','reset']);
 assert.deepEqual(allowedFor('returned',3),['harvest','build_farm','train','reset']);
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
test('phase, monotone clock and reset baseline are enforced',()=>{
 const a=fixture(),b=structuredClone(a);Object.assign(b,{command:'depart',revision:1,phase:'departed',allowed:['settle_departure','harvest','build_farm','train','reset']});b.evidence.instructions=['Depart'];b.evidence.recordsHex=['00'];
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
