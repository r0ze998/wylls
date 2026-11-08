// Synthetic structure-only test snapshots. Never used by the actual demo or a real-host claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, parseReplyObject, commandFromBody, commandLine, checkTransition } from '../screens/wide-march-local/local-model.mjs';
import { createController, cleanPath, mutationHeaderProblem, parseCanonicalJson, requestAllowed } from '../screens/wide-march-local/local-server.mjs';
import { createClient } from '../screens/wide-march-local/local-client.mjs';
import { ringPosition } from '../../permutation-server/web/frontier/map/wide.mjs';
const toHex = b => Buffer.from(b).toString('hex');
function account(key,n,magic,sortOffset,p,q) {
 const b=Buffer.alloc(n),d=new DataView(b.buffer,b.byteOffset,b.byteLength);b.write(magic);d.setUint16(16,3,true);
 const rp=ringPosition(BigInt(p),BigInt(q));d.setBigUint64(sortOffset,rp.ring,false);b[sortOffset+8]=rp.wedge;d.setBigUint64(sortOffset+9,rp.pos,false);
 const wide=n===1344?1280:4736;d.setUint16(wide,1,true);b[wide+2]=1; if(n===4864)b[4739]=15;
 b.fill(0x33,n===1344?1288:4740,n===1344?1320:4772);
 return {keyHex:key.repeat(32),ownerHex:'12'.repeat(32),lamports:'0',dataHex:toHex(b)};
}
export function fixture() {
 const h=account('01',1344,'PSFXWHL1',1320,129,0),a=account('02',4864,'PSFXWPV1',4772,129,0),b=account('03',4864,'PSFXWPV1',4772,129,-1);
 return {protocol:PROTOCOL,mode:'local-only',auth:'MOCK_AUTH_NO_SIGNATURE',beacon:'PUBLIC_FIXTURES_REAL_VERIFICATION',session:'separate-march-same-holding-train',status:'ok',error:null,command:'get',revision:0,phase:'ready',trained:false,allowed:['depart','reset'],clock:{unix:'1790448507',bell:6},map:{worldHex:'33'.repeat(32),origin:{p:'129',q:'0'},destination:{p:'129',q:'-1'},route:[{p:'129',q:'0',tile:0},{p:'129',q:'-1',tile:0}],provinces:[{p:'129',q:'0',accountKeyHex:a.keyHex,passableMask:'0'},{p:'129',q:'-1',accountKeyHex:b.keyHex,passableMask:'0'}]},host:{refHex:'01'+'33'.repeat(32)+'0000000000000081000000000000000000'+'000000000000',originTile:0,destinationTile:0,initialMilli:300000,currentMilli:300000,transitState:'absent',fate:null},holding:{accountKeyHex:h.keyHex,tile:0,reserveUnits:0,escrowLamports:'0',poolOwedLamports:'0',openTransits:0},combat:{engagements:0,arrivalSurvivorMilli:null,enemyFixture:true},returned:{creditedUnits:0,creditedMilli:0},evidence:{instructions:[],recordsHex:[],accounts:[h,a,b]}};
}
test('strict structure and byte correspondence reject forged summaries',()=>{
 assert.equal(parseReplyObject(fixture()).phase,'ready');
 for(const edit of [r=>r.holding.reserveUnits++,r=>r.holding.escrowLamports='2',r=>r.holding.openTransits++,r=>r.map.provinces[0].passableMask='1',r=>r.evidence.accounts[0].ownerHex='ff'.repeat(32),r=>r.evidence.accounts.push(r.evidence.accounts[0]),r=>r.extra=true,r=>r.host.refHex='ff',r=>r.allowed.push('train')]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r)); }
});
test('commands have exact schemas and no caller supplied route/account/time',()=>{
 assert.equal(commandLine(commandFromBody('action',{expectedRevision:1,action:'depart'})),'depart 1');
 for(const b of [{expectedRevision:0,action:'depart',p:'1'},{expectedRevision:-1,action:'train'},{expectedRevision:0,action:'advance'}]) assert.throws(()=>commandFromBody('action',b));
});
test('phase, monotone clock and reset baseline are enforced',()=>{
 const a=fixture(),b=structuredClone(a);Object.assign(b,{command:'depart',revision:1,phase:'departed',allowed:['settle_departure','train','reset']});
 assert.equal(checkTransition(a,{kind:'depart',rev:0},b,a),'ok');
 const c=structuredClone(b);c.clock.unix='1';assert.throws(()=>checkTransition(a,{kind:'depart',rev:0},c,a));
 const reset=structuredClone(a);Object.assign(reset,{command:'reset',revision:2});assert.equal(checkTransition(b,{kind:'reset',rev:1},reset,a),'ok');
 reset.host.currentMilli++;assert.throws(()=>checkTransition(b,{kind:'reset',rev:1},reset,a));
});
test('controller stale duplicate never contacts host and malformed response is permanently uncertain',async()=>{
 let calls=0,closed=0; const initial=fixture(); const bridge={alive:true,close(){closed++;},async exchange(){calls++;if(calls===1)return JSON.stringify(initial);return '{}';}};
 const c=createController({bridge});assert.equal((await c.start()).status,200);
 assert.equal((await c.mutate({kind:'depart',rev:8})).status,409);assert.equal(calls,1);
 assert.equal((await c.mutate({kind:'depart',rev:0})).status,502);assert.equal(c.phase,'uncertain');assert.equal(c.view().reply,null);
 assert.equal((await c.mutate({kind:'depart',rev:0})).status,503);assert.equal(calls,2);assert.equal(closed,1);
});
test('HTTP boundary rejects escape routes, missing origin and noncanonical bodies',()=>{
 for(const s of ['/../a','/%2e/a','//a','/a?x=1','/a\\b'])assert.equal(cleanPath(s),null);
 assert.equal(mutationHeaderProblem({},'http://127.0.0.1:1'),403);
 assert.throws(()=>parseCanonicalJson(Buffer.from('{"a":1,"a":1}')));
 assert.throws(()=>parseCanonicalJson(Buffer.from('{ "a":1}')));
});

test('refusal preserves all map, clock and account state',()=>{
 const a=fixture(),b=structuredClone(a);Object.assign(b,{status:'refused',error:'WrongPhase',command:'depart'});
 assert.equal(checkTransition(a,{kind:'depart',rev:0},b,a),'refused');
 b.host.currentMilli--;assert.throws(()=>checkTransition(a,{kind:'depart',rev:0},b,a));
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
});
test('child death while idle clears cached view and blocks further mutations',async()=>{
 const bridge={alive:true,close(){},async exchange(){return JSON.stringify(fixture());}};
 const c=createController({bridge});await c.start();bridge.alive=false;bridge.deadReason='Exit';
 assert.equal(c.state().body.view.reply,null);assert.equal(c.phase,'uncertain');
 assert.equal((await c.mutate({kind:'depart',rev:0})).status,503);
});
const response = r => ({status:200,text:async()=>JSON.stringify({view:{v:1,protocol:PROTOCOL,mode:'local-simulation',mockAuth:true,phase:'ready',uncertain:false,revision:r.revision,reply:r,lastResult:null}})});
test('browser duplicate submit blocked, network failure clears map/state, no retry; explicit GET recovers',async()=>{
 let calls=[], rejectSend;const initial=fixture();
 const client=createClient({fetchFn:async(path,init)=>{calls.push([path,init.method]);if(init.method==='GET')return response(initial);return new Promise((_,reject)=>{rejectSend=reject;});}});
 await client.refresh();assert.equal(client.snapshot.phase,'ready');const pending=client.submit({kind:'depart'});
 assert.equal((await client.submit({kind:'depart'})).reason,'busy');assert.equal(calls.length,2);
 rejectSend(new Error('lost'));await pending;assert.equal(client.snapshot.state,null);assert.equal(client.snapshot.phase,'error');assert.equal(calls.length,2);
 await client.refresh();assert.equal(client.snapshot.phase,'ready');assert.deepEqual(calls.map(c=>c[1]),['GET','POST','GET']);
});
test('browser stale revision response updates without automatic replay',async()=>{
 let calls=0;const a=fixture(),b=structuredClone(a);Object.assign(b,{revision:1,phase:'departed',command:'depart',allowed:['settle_departure','train','reset']});
 const client=createClient({fetchFn:async()=>{calls++;return calls===1?response(a):{...response(b),status:409};}});
 await client.refresh();assert.equal((await client.submit({kind:'depart'})).reason,'stale');assert.equal(calls,2);assert.equal(client.snapshot.state.revision,1);
});
