// SYNTHETIC structure-only snapshots (wide-march-local-synthetic.mjs). Never used by the actual demo or a real-host
// claim: they show that the browser's checks are coherent and that each tampering is refused, nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL, parseReplyObject, commandFromBody, commandFromQuoteBody, commandLine, checkTransition, checkQuote, parseRouteQuote, routeDirsOk, MAX_ROUTE_DIRS, allowedFor, MAX_ACCOUNTS, HISTORY } from '../screens/wide-march-local/local-model.mjs';
import { createController, cleanPath, mutationHeaderProblem, parseCanonicalJson, requestAllowed, API, LOCAL_FILES } from '../screens/wide-march-local/local-server.mjs';
import { createClient, bindingMatchesQuote } from '../screens/wide-march-local/local-client.mjs';
import { decodeRecord, KIND, provinceKeyHex } from '../screens/wide-march-local/local-receipts.mjs';
import {
  fixture, openStep, economyStep, step, chosenFlow, recordedFlow, openedSession, editBytes, accountOf, setCursor, hostQuote, quoteReply, refused,
  CHOSEN_DIRS, MARCH_STEPS, TRANSIT_KEY, FUND_KEYS, FUND_LAMPORTS, WORLD, PROGRAM, toHex, fromHex,
} from './wide-march-local-synthetic.mjs';

/** The refusal must be the one the case is about, not some earlier check failing by accident. */
const code = c => e => { assert.equal(e?.code, c, e?.message); return true; };
const CHOSEN_CMDS = ['depart_route', ...MARCH_STEPS];
const cmdFor = (prev, kind) => kind === 'depart_route' ? { kind, rev: prev.revision, dirs: CHOSEN_DIRS } : { kind, rev: prev.revision };
/** Transition i of a flow (1-based next index) with `edit` applied to a fresh copy of the reply. */
function T(flow, cmds, i, edit = () => {}) { const n = structuredClone(flow[i]); edit(n); return () => checkTransition(flow[i - 1], cmdFor(flow[i - 1], cmds[i - 1]), n, fixture()); }
const RECORDED_CMDS = ['depart', ...MARCH_STEPS];
const reachableQuote = s => hostQuote(s, '222');

// ------------------------------------------------------------------ v3 contract, on coherent v4 snapshots
test('strict structure and byte correspondence reject forged summaries',()=>{
 assert.equal(parseReplyObject(fixture()).phase,'ready');
 for(const edit of [r=>r.holding.reserveUnits++,r=>r.holding.escrowLamports='2',r=>r.holding.openTransits++,r=>r.map.provinces[0].passableMask='1',r=>r.evidence.accounts[0].ownerHex='ff'.repeat(32),r=>r.evidence.accounts.push(r.evidence.accounts[0]),r=>r.extra=true,r=>r.host.refHex='ff',r=>r.allowed.push('train'),
  r=>r.trained=false,r=>{r.protocol='wylls-local-march-v3';},r=>{delete r.marchBinding;},r=>{r.marchBinding={};},r=>{delete r.horizon.selectedDestinationResolvedNext;},r=>{delete r.map.provinces[0].history;}]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r)); }
});
test('fixture isolation: no store, queue or account object is shared inside or across snapshots',()=>{
 const f=fixture();
 assert.equal(new Set(f.village.stores).size,8,'eight distinct store objects');
 assert.equal(new Set(f.village.queue).size,4,'four distinct queue objects');
 assert.equal(new Set(f.evidence.accounts).size,f.evidence.accounts.length);
 f.village.stores[1].rate='1';f.village.stores[7].value='9';f.village.queue[1].kind=1;f.village.queue[3].delta='5';f.village.production[2]='7';f.village.reserve[4]=3;
 f.evidence.accounts[0].dataHex='00';f.horizon.originResolvedNext=99;f.economy.harvests=5;f.map.route[0].tile=9;
 const g=fixture();
 assert.equal(g.village.stores[1].rate,'0');assert.equal(g.village.stores[7].value,'0');assert.equal(g.village.queue[1].kind,0);assert.equal(g.village.queue[3].delta,'0');
 assert.equal(parseReplyObject(g).phase,'ready');
 const a=fixture(),before=JSON.stringify(a);for(const k of ['harvest','build_farm','train'])economyStep(a,k);step(a,'depart');assert.equal(JSON.stringify(a),before,'the step helpers never edit their input');
});
test('every village and horizon number must be the account bytes, never an invented stock',()=>{
 for(const edit of [
  r=>{r.village.stores[0].value='2000000';},r=>{r.village.stores[1].rate='1';},r=>{r.village.stores[0].t0='1';},r=>{r.village.stores[5].cap='1';},r=>{r.village.production[0]='52000';},
  r=>{r.village.queue[0]={doneAt:'1',kind:1,arg:0,delta:'12000'};},r=>{r.village.queue[3].delta='1';},r=>{r.village.reserve[1]=1;},r=>{r.village.tier=1;},r=>{r.village.lastOwnerAction='5';},
  r=>{r.horizon.originResolvedNext=6;},r=>{r.horizon.destinationResolvedNext=19;},
  r=>{r.evidence.accounts=r.evidence.accounts.filter(a=>a.keyHex!=='04'.repeat(32));},
 ]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r),code('EvidenceMismatch'),String(edit)); }
 for(const edit of [
  r=>{r.village.reserve[0]=610;},r=>{r.horizon.destinationPreparedThroughBell=20;},r=>{r.horizon.model='SYNCHRONIZED';},
  r=>{r.economy.perInstantBudget=9;},r=>{r.economy.trainCount=11;},r=>{r.economy.usedThisInstant=9;},r=>{r.refusalCode=21;},
  r=>{r.village.stores[0].value='01900000';},r=>{r.village.stores[0].value='-0';},r=>{r.village.stores.pop();},r=>{r.village.queue.push({doneAt:'0',kind:0,arg:0,delta:'0'});},
 ]) { const r=fixture(); edit(r); assert.throws(()=>parseReplyObject(r),code('BadReply'),String(edit)); }
 const r=fixture();editBytes(r,'01',(b,d)=>d.setBigInt64(152,1234567n,true));r.village.stores[0].value='1234567';assert.equal(parseReplyObject(r).village.stores[0].value,'1234567');
 const f=fixture();Object.assign(f,{status:'refused',error:'HANDLER_REFUSED',refusalCode:21});assert.equal(parseReplyObject(f).refusalCode,21);
 f.error='BAD_PHASE';assert.throws(()=>parseReplyObject(f));
});
test('commands have exact schemas and no caller supplied route/account/time/amount',()=>{
 assert.equal(commandLine(commandFromBody('action',{expectedRevision:1,action:'depart'})),'depart 1');
 for(const k of ['harvest','build_farm','train'])assert.equal(commandLine(commandFromBody('action',{expectedRevision:7,action:k})),`${k} 7`);
 for(const b of [{expectedRevision:0,action:'depart',p:'1'},{expectedRevision:-1,action:'train'},{expectedRevision:0,action:'advance'},{expectedRevision:0,action:'build'},{expectedRevision:0,action:'build_farm',item:6},{expectedRevision:0,action:'train',count:1000},{expectedRevision:0,action:'reset'},{expectedRevision:0,action:'depart_route'}]) assert.throws(()=>commandFromBody('action',b));
 assert.throws(()=>commandFromBody('reset',{expectedRevision:0,action:'harvest'}));
});
test('allowed list: phase step, depart_route while ready with an opened province, economy until the per-instant budget is spent',()=>{
 assert.deepEqual(allowedFor('ready',0),['depart','harvest','build_farm','train','open_province','reset']);
 assert.deepEqual(allowedFor('ready',0,1),['depart','depart_route','harvest','build_farm','train','open_province','reset']);
 assert.deepEqual(allowedFor('ready',8),['depart','open_province','reset']);
 assert.deepEqual(allowedFor('departed',0,1),['settle_departure','harvest','build_farm','train','open_province','reset'],'never during a march');
 assert.deepEqual(allowedFor('returned',3),['harvest','build_farm','train','open_province','reset']);
 assert.deepEqual(allowedFor('ready',8,4),['depart','depart_route','reset']);
});
test('route-quote command: a bounded directions string chosen by the player, nothing else',()=>{
 assert.equal(commandLine(commandFromQuoteBody({dirs:'222'})),'quote_route 222');
 for(const d of ['222','0','5','0'.repeat(MAX_ROUTE_DIRS)]) assert.ok(routeDirsOk(d),d);
 for(const d of ['','6','2x','29','-1','0'.repeat(MAX_ROUTE_DIRS+1),'2 2',' 2',2,null]) assert.ok(!routeDirsOk(d),String(d));
 for(const b of [{},{dirs:''},{dirs:'6'},{dirs:'2',extra:1},{dir:'2'},{dirs:2}]) assert.throws(()=>commandFromQuoteBody(b),e=>e.code==='BadCommand');
 assert.throws(()=>commandLine({kind:'quote_route',dirs:'2 extra'}));
});
test('a route quote is present exactly on a successful quote_route or a depart_route refused as unreachable, never with records',()=>{
 const f=fixture();
 assert.equal(parseReplyObject(quoteReply(f,reachableQuote(f))).routeQuote.reachable,true);
 const g=fixture();g.routeQuote=reachableQuote(g);assert.throws(()=>parseReplyObject(g),code('BadReply'));
 assert.throws(()=>parseReplyObject(quoteReply(f,null)),code('BadReply'));
 const rec=quoteReply(f,reachableQuote(f));rec.evidence.recordsHex=['00'];assert.throws(()=>parseReplyObject(rec));
});
test('route-quote honesty: reachable iff an end and no reason, and only over known passable land',()=>{
 const ps=new Set(['129,0','129,-1']), ok=reachableQuote(fixture());
 assert.doesNotThrow(()=>parseRouteQuote(ok,ps));
 for(const edit of [q=>{q.reachable=false;},q=>{q.end=null;},q=>{q.reason='IMPASSABLE';},q=>{q.steps[0].passable=false;},q=>{q.steps[0].known=false;},q=>{q.steps[0].p='130';},q=>{q.provincesEntered=[{p:'130',q:'0'}];},q=>{q.start.p='130';}])
  {const q=structuredClone(ok);edit(q);assert.throws(()=>parseRouteQuote(q,ps),String(edit));}
 const unknown=hostQuote(fixture(),CHOSEN_DIRS);assert.equal(unknown.reason,'UNKNOWN_PROVINCE');assert.doesNotThrow(()=>parseRouteQuote(unknown,ps));
});
test('checkQuote accepts a non-mutating quote and rejects any state, binding or revision drift',()=>{
 const prev=fixture();
 assert.equal(checkQuote(prev,quoteReply(prev,reachableQuote(prev))).reachable,true);
 for(const edit of [n=>{n.revision=1;},n=>{n.host.currentMilli--;},n=>{n.command='depart';},n=>{n.village.reserve[0]=610;}]){const n=quoteReply(prev,reachableQuote(prev));edit(n);assert.throws(()=>checkQuote(prev,n));}
 // during a chosen march the quote is still a read
 const F=chosenFlow();assert.equal(checkQuote(F[2],quoteReply(F[2],hostQuote(F[2],CHOSEN_DIRS))).reachable,true);
 // a read-only quote reply carries no instructions or receipts (the host renders none for quote_route); one that
 // still carries the previous mutation's evidence is refused, not accepted as a quote
 const leftover=quoteReply(F[2],hostQuote(F[2],CHOSEN_DIRS));
 assert.deepEqual([leftover.evidence.instructions,leftover.evidence.recordsHex],[[],[]]);
 leftover.evidence.instructions=[...F[2].evidence.instructions];leftover.evidence.recordsHex=[...F[2].evidence.recordsHex];
 assert.throws(()=>checkQuote(F[2],leftover),code('BadReply'));
});
test('economy transition: same phase and instant, counters by one, only the village accounts changed, one Economy receipt on the holding chain',()=>{
 const a=fixture();
 for(const kind of ['harvest','build_farm','train']) assert.equal(checkTransition(a,{kind,rev:0},economyStep(a,kind),a),'ok');
 const bad=[
  // (v4: a non-ready phase without a march binding is refused at parse, before the phase rule)
  ['BadClock',n=>{n.clock={unix:String(BigInt(n.clock.unix)+1n),bell:6};}],['BadReply',n=>{n.phase='departed';n.allowed=allowedFor('departed',1);}],['BadEconomy',n=>{n.economy.usedThisInstant--;n.allowed=allowedFor(n.phase,n.economy.usedThisInstant);}],
  ['BadEconomy',n=>{n.economy.trains++;}],['BadEconomy',n=>{n.host.currentMilli--;}],['BadEconomy',n=>{n.evidence.instructions=['Train'];}],['BadEconomy',n=>{n.evidence.recordsHex=[];}],
  ['BadEconomy',n=>editBytes(n,'03',b=>{b[100]^=1;})],['BadEconomy',n=>{n.evidence.accounts[0].lamports='1';}],
  // the receipt itself: replayed (the one-receipt economy rule), tampered, or the holding header not advanced by it
  ['BadEconomy',n=>{n.evidence.recordsHex.push(n.evidence.recordsHex[0]);}],
  ['ReceiptChain',n=>{const h=n.evidence.recordsHex[0];n.evidence.recordsHex[0]=h.slice(0,160)+(h[160]==='0'?'1':'0')+h.slice(161);}],
  ['ReceiptChainEnd',n=>editBytes(n,'01',b=>{b[40]^=1;})],
 ];
 for(const [want,edit] of bad){const n=economyStep(a,'harvest');edit(n);assert.throws(()=>checkTransition(a,{kind:'harvest',rev:0},n,a),code(want),String(edit));}
 assert.throws(()=>checkTransition(a,{kind:'train',rev:0},economyStep(a,'train',{reserveDelta:11}),a),code('BadEconomy'));
});
test('phase steps keep economy counters; a new instant resets the per-instant budget',()=>{
 const a=economyStep(fixture(),'harvest'),b=step(a,'depart');
 assert.equal(checkTransition(a,{kind:'depart',rev:1},b,fixture()),'ok');
 const reset0=structuredClone(b);reset0.economy.usedThisInstant=0;reset0.allowed=allowedFor('departed',0);assert.throws(()=>checkTransition(a,{kind:'depart',rev:1},reset0,fixture()),code('BadEconomy'),'same instant keeps the budget used');
 const c=step(b,'settle_departure');assert.equal(c.economy.usedThisInstant,0);
 assert.equal(checkTransition(b,{kind:'settle_departure',rev:2},c,fixture()),'ok');
 const stuck=structuredClone(c);stuck.economy.usedThisInstant=1;stuck.allowed=allowedFor('travelling',1);assert.throws(()=>checkTransition(b,{kind:'settle_departure',rev:2},stuck,fixture()),code('BadEconomy'));
 const counted=structuredClone(c);counted.economy.harvests=0;assert.throws(()=>checkTransition(b,{kind:'settle_departure',rev:2},counted,fixture()),code('BadEconomy'));
});
test('the recorded march: every phase step verifies, binding fixed, fixture cursors forward only, opened provinces untouched',()=>{
 const F=recordedFlow();
 F.slice(1).forEach((n,i)=>assert.equal(checkTransition(F[i],cmdFor(F[i],RECORDED_CMDS[i]),n,fixture()),'ok',RECORDED_CMDS[i]));
 assert.equal(F[1].marchBinding.kind,'recorded');assert.deepEqual(F[1].marchBinding.trail,['RECORDED_FIXTURE_ORDER','REAL_DEPART']);
 assert.equal(F[1].combat.enemyFixture,true);assert.equal(F[6].marchBinding.destination.q,'-1');
 assert.equal(F[1].horizon.selectedDestinationResolvedNext,F[1].horizon.destinationResolvedNext,'for depart the selected cursor is the recorded destination\'s');
 const t=(i,want,edit)=>assert.throws(T(F,RECORDED_CMDS,i,edit),code(want),String(edit));
 // a cursor never moves back, even when bytes, summary and horizon agree
 t(2,'CursorRegressed',n=>setCursor(n,0,4));
 t(5,'CursorRegressed',n=>setCursor(n,1,19));
 // a summary cursor that is not the account's bytes, or not the horizon, is refused before any transition rule
 t(2,'EvidenceMismatch',n=>{n.map.provinces[0].resolvedNext=8;n.horizon.originResolvedNext=8;});
 t(2,'EvidenceMismatch',n=>{n.horizon.originResolvedNext=5;});
 // anything else of a province changing under a phase step is an identity change (here its mask, consistently)
 // (a mask that keeps the recorded route's tiles passable, so the binding's own route check is not what refuses)
 t(2,'IdentityChanged',n=>{const m=(1n<<60n)-1n;editBytes(n,'02',(x,d)=>d.setBigUint64(264,m,true));n.map.provinces[0].passableMask=m.toString();});
 // the recorded binding never changes after depart; it adds no account
 t(3,'BadBinding',n=>{n.marchBinding.departedMilli--;});
 t(3,'AccountAdded',n=>{n.evidence.accounts.push({keyHex:'ef'.repeat(32),ownerHex:PROGRAM,lamports:'1',dataHex:'00'});});
 // the economy may not move the map, not even a consistent cursor
 const a=fixture(),e=economyStep(a,'harvest');setCursor(e,0,6);
 assert.throws(()=>checkTransition(a,{kind:'harvest',rev:0},e,a),code('IdentityChanged'));
 // an opened province is not on the recorded march: its account stays byte-identical through every phase step
 const o=openStep(a,'129','-2');assert.equal(checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-2'},o,a),'ok');
 const od=step(o,'depart');assert.equal(checkTransition(o,{kind:'depart',rev:1},od,a),'ok');
 const touched=step(o,'depart');editBytes(touched,'10',x=>{x[1000]^=1;});
 assert.throws(()=>checkTransition(o,{kind:'depart',rev:1},touched,a),code('IdentityChanged'));
 const paid=step(o,'depart');accountOf(paid,'10'.repeat(32)).lamports='1';
 assert.throws(()=>checkTransition(o,{kind:'depart',rev:1},paid,a));
});
test('phase, monotone clock and reset baseline are enforced',()=>{
 const a=fixture(),b=step(a,'depart');
 assert.equal(checkTransition(a,{kind:'depart',rev:0},b,a),'ok');
 const c=structuredClone(b);c.clock.unix='1';assert.throws(()=>checkTransition(a,{kind:'depart',rev:0},c,a));
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
test('controller refuses a first state that already carries economy history, opened land or a march',async()=>{
 const used=fixture();used.economy.harvests=1;
 const c=createController({bridge:{alive:true,close(){},async exchange(){return JSON.stringify(used);}}});
 assert.equal((await c.start()).status,502);assert.equal(c.phase,'uncertain');
 const opened=openedSession();Object.assign(opened,{command:'get',revision:0});opened.evidence.instructions=[];
 const d=createController({bridge:{alive:true,close(){},async exchange(){return JSON.stringify(opened);}}});
 assert.equal((await d.start()).status,502);
});
test('controller serializes economy commands and judges each against its predecessor',async()=>{
 const a=fixture(),b=economyStep(a,'harvest');let calls=[];
 const bridge={alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(calls.length===1?a:b);}};
 const c=createController({bridge});await c.start();
 const [one,two]=await Promise.all([c.mutate({kind:'harvest',rev:0}),c.mutate({kind:'harvest',rev:0})]);
 assert.equal(one.status,200);assert.equal(one.body.outcome,'ok');assert.equal(two.status,409,'the duplicate is stale inside the queue');
 assert.deepEqual(calls,['get','harvest 0']);
});
test('controller route quote is a read; a drifting reply makes the session uncertain for good',async()=>{
 let calls=[];const initial=fixture();
 const c=createController({bridge:{alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(line==='get'?initial:quoteReply(initial,reachableQuote(initial)));}}});await c.start();
 const r=await c.quote({kind:'quote_route',dirs:'222'});
 assert.equal(r.status,200);assert.equal(r.body.routeQuote.reachable,true);assert.deepEqual(calls,['get','quote_route 222']);assert.equal(c.view().revision,0);
 const drift=quoteReply(initial,reachableQuote(initial));drift.revision=1;
 const d=createController({bridge:{alive:true,close(){},async exchange(line){return JSON.stringify(line==='get'?initial:drift);}}});await d.start();
 assert.equal((await d.quote({kind:'quote_route',dirs:'2'})).status,502);assert.equal(d.phase,'uncertain');
});
test('HTTP boundary rejects escape routes, missing origin and noncanonical bodies; depart_route is a mutation route',()=>{
 for(const s of ['/../a','/%2e/a','//a','/a?x=1','/a\\b'])assert.equal(cleanPath(s),null);
 assert.equal(mutationHeaderProblem({},'http://127.0.0.1:1'),403);
 assert.throws(()=>parseCanonicalJson(Buffer.from('{"a":1,"a":1}')));
 assert.throws(()=>parseCanonicalJson(Buffer.from('{ "a":1}')));
 assert.equal(API.departRoute,'/api/depart_route');
 for(const f of ['local-receipts.mjs','local-route.mjs'])assert.ok(LOCAL_FILES.includes(f),f);
});
test('refusal preserves all map, clock, village, binding and account state',()=>{
 const a=fixture(),b=refused(a,'build_farm','HANDLER_REFUSED',{refusalCode:21});
 assert.equal(checkTransition(a,{kind:'build_farm',rev:0},b,a),'refused');
 const c=structuredClone(b);c.economy.farmBuilds=1;assert.throws(()=>checkTransition(a,{kind:'build_farm',rev:0},c,a),code('BadTransition'));
 b.host.currentMilli--;assert.throws(()=>checkTransition(a,{kind:'build_farm',rev:0},b,a),code('BadTransition'));
});
test('cross-origin/API reads and mutations rejected; top-level navigation only exception',()=>{
 const host='127.0.0.1:55555';
 assert.equal(requestAllowed({host:'localhost:55555'},host,'GET','/api/state'),false);
 const cross={host,'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 assert.equal(requestAllowed(cross,host,'GET','/api/state'),false);
 assert.equal(requestAllowed(cross,host,'GET','/api/depart_route'),false);
 assert.equal(requestAllowed(cross,host,'GET','/permutation-gateway/screens/wide-march-local/index.html'),true);
 const h={host,origin:'http://'+host,'sec-fetch-site':'same-origin','x-wylls-local-action':PROTOCOL,'content-type':'application/json','content-length':'2'};
 assert.equal(mutationHeaderProblem(h,'http://'+host),0);
 assert.equal(mutationHeaderProblem({...h,origin:'https://evil.example'},'http://'+host),403);
 assert.equal(mutationHeaderProblem({...h,'sec-fetch-site':'cross-site'},'http://'+host),403);
 assert.equal(mutationHeaderProblem({...h,'x-wylls-local-action':'wylls-local-march-v3'},'http://'+host),403,'the old protocol label is not accepted');
});
test('child death while idle clears cached view and blocks further mutations',async()=>{
 const bridge={alive:true,close(){},async exchange(){return JSON.stringify(fixture());}};
 const c=createController({bridge});await c.start();bridge.alive=false;bridge.deadReason='Exit';
 assert.equal(c.state().body.view.reply,null);assert.equal(c.phase,'uncertain');
 assert.equal((await c.mutate({kind:'harvest',rev:0})).status,503);
});
const view=(r,last=null)=>({v:1,protocol:PROTOCOL,mode:'local-simulation',mockAuth:true,phase:'ready',uncertain:false,revision:r.revision,reply:r,lastResult:last});
const response = r => ({status:200,text:async()=>JSON.stringify({view:view(r)})});
const posted = (r,outcome) => ({status:200,text:async()=>JSON.stringify({outcome,view:view(r,{command:r.command,outcome,code:r.error,revision:r.revision})})});
const quoteResponse = (rq, state) => ({ status: 200, text: async () => JSON.stringify({ routeQuote: rq, view: view(state) }) });
test('browser duplicate submit blocked, network failure clears map/state, no retry; explicit GET recovers',async()=>{
 let calls=[], rejectSend;const initial=fixture();
 const client=createClient({fetchFn:async(path,init)=>{calls.push([path,init.method]);if(init.method==='GET')return response(initial);return new Promise((_,reject)=>{rejectSend=reject;});}});
 await client.refresh();const pending=client.submit({kind:'harvest'});
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
 const a=fixture(),b=economyStep(a,'train');
 const client=createClient({fetchFn:async(_p,init)=>init.method==='GET'?response(a):posted(b,'ok')});
 await client.refresh();assert.equal((await client.submit({kind:'train'})).ok,true);assert.equal(client.snapshot.state.village.reserve[0],610);
 const client2=createClient({fetchFn:async(_p,init)=>init.method==='GET'?response(b):posted(refused(b,'train','HANDLER_REFUSED',{refusalCode:17}),'refused')});
 await client2.refresh();const r2=await client2.submit({kind:'train'});assert.equal(r2.reason,'refused');assert.equal(client2.snapshot.state.refusalCode,17);assert.equal(client2.snapshot.notice.code,'HANDLER_REFUSED');
});
test('browser route quote attaches a validated quote, never mutates, and a drifting reply fails closed',async()=>{
 const a=fixture();let calls=[];
 const client=createClient({fetchFn:async(path,init)=>{calls.push([path,init.method]);return init.method==='GET'?response(a):quoteResponse(reachableQuote(a),a);}});
 await client.refresh();
 assert.equal((await client.quote('222')).ok,true);assert.equal(client.snapshot.quote.reachable,true);assert.equal(client.snapshot.quoteDirs,'222');assert.equal(client.snapshot.state.revision,0);
 assert.equal((await client.quote('6')).reason,'input');assert.equal(calls.length,2);
 await client.refresh();assert.equal(client.snapshot.quote,null);
 const drift=structuredClone(a);drift.revision=1;
 const c2=createClient({fetchFn:async(_p,init)=>init.method==='GET'?response(a):quoteResponse(reachableQuote(a),drift)});
 await c2.refresh();assert.equal((await c2.quote('2')).reason,'unknown');assert.equal(c2.snapshot.state,null);
});
test('the LOCAL land records are re-read from their bytes, never taken from the summary',()=>{
 for(const edit of [
  r=>editBytes(r,'05',b=>{b[48]^=1;}),r=>editBytes(r,'05',(b,d)=>d.setBigUint64(40,1n,true)),r=>editBytes(r,'05',b=>{b[18]=1;}),r=>editBytes(r,'05',(b,d)=>d.setBigUint64(20,130n,true)),
  r=>editBytes(r,'05',(b,d)=>d.setBigUint64(112,4n,true)),r=>editBytes(r,'06',b=>{b[19]=1;}),r=>editBytes(r,'06',b=>{b[56]^=1;}),r=>editBytes(r,'09',b=>{b[16]=5;}),
  r=>editBytes(r,'0a',(b,d)=>d.setUint32(20,1,true)),r=>editBytes(r,'02',b=>{b[4800]^=1;}),r=>editBytes(r,'03',(b,d)=>d.setBigUint64(4792,7n,true)),r=>editBytes(r,'02',b=>{b[70]^=1;}),
  r=>editBytes(r,'03',b=>{b[71]^=1;}),r=>editBytes(r,'02',(b,d)=>d.setUint32(76,2,true)),r=>{r.land.ringSeedKeyHex='04'.repeat(32);},
 ]){const r=fixture();edit(r);assert.throws(()=>parseReplyObject(r),code('EvidenceMismatch'),String(edit));}
 for(const edit of [
  r=>{r.land.budget=5;},r=>{r.land.ring=130;},r=>{r.land.opened=1;},r=>{r.land.provenance.ringSeed='VERIFIED_BEACON';},r=>{delete r.land.provenance.golden;},r=>{r.land.fundKeysHex[1]=r.land.fundKeysHex[0];},r=>{r.land.extra=1;},
  r=>{r.map.provinces[0].source='opened';},r=>{r.map.provinces.reverse();},r=>{r.map.provinces[1].wedge=6;},r=>{r.allowed=r.allowed.filter(k=>k!=='open_province');},r=>{r.map.provinces[0].history='NONE';},
 ]){const r=fixture();edit(r);assert.throws(()=>parseReplyObject(r),code('BadReply'),String(edit));}
});
test('an opened province must be ring 129, opened now, with no resolve history unless it is the prepared chosen destination',()=>{
 const ok=openStep(fixture(),'129','-2');
 assert.equal(parseReplyObject(ok).map.provinces[2].history,HISTORY.NONE);
 for(const edit of [n=>{n.map.provinces[2].source='fixture';},n=>{n.map.provinces[2].resolvedNext=7;},n=>{n.map.provinces[2].openedBell=7;},n=>{n.land.opened=0;},n=>{n.land.provincesCreated=3;},n=>{n.map.provinces[2].p='129';n.map.provinces[2].q='0';},
  n=>{n.map.provinces[2].history=HISTORY.PREPARED;},n=>{n.map.provinces[2].history='SYNCHRONIZED';}]){const n=openStep(fixture(),'129','-2');edit(n);assert.throws(()=>parseReplyObject(n),String(edit));}
 assert.throws(()=>parseReplyObject(openStep(fixture(),'130','0')),code('BadReply'));
 const f=openStep(fixture(),'129','-2');editBytes(f,'10',(b,d)=>d.setBigUint64(4832,1n,true));assert.throws(()=>parseReplyObject(f),code('EvidenceMismatch'));
});
test('open transition: exactly the asked province (fresh chain header), the ring seed and one fund change; nothing of the village or march',()=>{
 const a=fixture();
 assert.equal(checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-2'},openStep(a,'129','-2'),a),'ok');
 for(const [want,edit] of [['BadOpen',n=>{n.clock={unix:String(BigInt(n.clock.unix)+1n),bell:6};}],['BadOpen',n=>{n.economy.harvests=1;}],['BadOpen',n=>{n.host.currentMilli--;}],['BadOpen',n=>editBytes(n,'01',b=>{b[540]^=1;})],
  ['BadOpen',n=>editBytes(n,'08',b=>{b[100]^=1;})],['BadOpen',n=>{accountOf(n,'07'.repeat(32)).lamports=String(BigInt(FUND_LAMPORTS)-1n);}],['BadOpen',n=>{n.returned.creditedUnits=1;}],
  // a new province's chain header is the fresh one (seq 0, zero head): it starts with no receipt behind it
  ['ReceiptChainEnd',n=>editBytes(n,'10',(b,d)=>d.setBigUint64(24,1n,true))],['ReceiptChainEnd',n=>editBytes(n,'10',b=>{b[40]=1;})],
 ]){const n=openStep(a,'129','-2');edit(n);assert.throws(()=>checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-2'},n,a),code(want),String(edit));}
 assert.throws(()=>checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'-3'},openStep(a,'129','-2'),a),code('BadOpen'));
 const r=refused(a,'open_province','LAND_DUPLICATE_OPEN');assert.equal(checkTransition(a,{kind:'open_province',rev:0,p:'129',q:'0'},r,a),'refused');
 let s=a;for(const [i,[p,q]] of [['129','-2'],['129','-3'],['128','1'],['127','2']].entries()){const n=openStep(s,p,q,{key:`1${i}`,wedge:i});assert.equal(checkTransition(s,{kind:'open_province',rev:s.revision,p,q},n,a),'ok');s=n;}
 assert.ok(!s.allowed.includes('open_province'));
 const reset=structuredClone(a);Object.assign(reset,{command:'reset',revision:s.revision+1});assert.equal(checkTransition(s,{kind:'reset',rev:s.revision},reset,a),'ok');
});
test('open commands carry only the shown revision and canonical coordinate strings',()=>{
 assert.equal(commandLine(commandFromBody('open',{expectedRevision:3,p:'129',q:'-2'})),'open_province 3 129 -2');
 for(const b of [{expectedRevision:0,p:129,q:'-2'},{expectedRevision:0,p:'0129',q:'-2'},{expectedRevision:0,p:'-0',q:'0'},{expectedRevision:0,p:'129'},{expectedRevision:0,p:'129',q:'-2',ring:'129'},{expectedRevision:0,p:'4611686018427387905',q:'0'},{p:'129',q:'-2'}])
  assert.throws(()=>commandFromBody('open',b),code('BadCommand'),JSON.stringify(b));
});
test('controller opening is serialized and judged; a stale duplicate never reaches the host',async()=>{
 const a=fixture(),b=openStep(a,'129','-2');let calls=[];
 const c=createController({bridge:{alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(calls.length===1?a:b);}}});await c.start();
 const cmd=commandFromBody('open',{expectedRevision:0,p:'129',q:'-2'});
 const [one,two]=await Promise.all([c.mutate(cmd),c.mutate(cmd)]);
 assert.equal(one.status,200);assert.equal(two.status,409);assert.deepEqual(calls,['get','open_province 0 129 -2']);
});

// ------------------------------------------------------------------ v4: the chosen march
test('depart_route commands carry only the shown revision and the quoted directions',()=>{
 assert.equal(commandLine(commandFromBody('depart_route',{expectedRevision:2,dirs:CHOSEN_DIRS})),`depart_route 2 ${CHOSEN_DIRS}`);
 assert.ok(commandLine({kind:'depart_route',rev:1000000,dirs:'5'.repeat(32)}).length<=128);
 for(const b of [{expectedRevision:0},{dirs:'2'},{expectedRevision:0,dirs:''},{expectedRevision:0,dirs:'6'},{expectedRevision:0,dirs:'2'.repeat(33)},{expectedRevision:0,dirs:'2 2'},{expectedRevision:-1,dirs:'2'},
  {expectedRevision:0,dirs:'2',p:'129',q:'-2'},{expectedRevision:0,dirs:'2',tile:60},{expectedRevision:0,dirs:2},{expectedRevision:'0',dirs:'2'}])
  assert.throws(()=>commandFromBody('depart_route',b),code('BadCommand'),JSON.stringify(b));
 assert.throws(()=>commandLine({kind:'depart_route',rev:0,dirs:'2 extra'}));
});
test('the chosen march: every step verifies, the selection is not the fixed route, the recorded destination stays untouched',()=>{
 const F=chosenFlow();
 F.slice(1).forEach((n,i)=>assert.equal(checkTransition(F[i],cmdFor(F[i],CHOSEN_CMDS[i]),n,fixture()),'ok',CHOSEN_CMDS[i]));
 const b=F[1].marchBinding;
 assert.equal(b.kind,'chosen');assert.equal(b.directions,CHOSEN_DIRS);assert.deepEqual([b.destination.p,b.destination.q],['129','-2']);
 assert.notDeepEqual({p:b.destination.p,q:b.destination.q},F[1].map.destination,'not the recorded destination');
 assert.equal(F[1].combat.enemyFixture,false);
 assert.deepEqual(F.slice(1).map(s=>s.horizon.selectedDestinationResolvedNext),[6,6,20,21,21,24]);
 assert.equal(F[3].map.provinces[2].history,HISTORY.PREPARED);assert.equal(F[3].marchBinding.preparation.resolves,14);
 // the recorded destination's account and summary are byte-identical from the opening to the return
 assert.deepEqual(accountOf(F[6],F[0].map.provinces[1].accountKeyHex),accountOf(F[0],F[0].map.provinces[1].accountKeyHex));
 assert.deepEqual(F[6].map.provinces[1],F[0].map.provinces[1]);
 // the preparation receipts: 14 Resolves of bells 6..19 keyed by the chosen province, then the Revealed
 const recs=F[3].evidence.recordsHex.map(decodeRecord),dest=provinceKeyHex(WORLD,'129','-2');
 assert.deepEqual(recs.map(r=>r.kind),[...Array(14).fill(KIND.RESOLVE),KIND.REVEALED]);
 assert.deepEqual(recs.slice(0,14).map(r=>r.bell),Array.from({length:14},(_,i)=>6+i));
 assert.ok(recs.every(r=>r.provinceHex===dest));
 // zero engagements and every departed troop staying are legitimate at an enemy-free province
 assert.equal(F[4].combat.engagements,0);assert.equal(F[4].combat.arrivalSurvivorMilli,b.departedMilli);
 assert.equal(F[6].holding.reserveUnits,F[5].holding.reserveUnits+F[6].returned.creditedUnits);
});
test('the economy interleaves with a chosen march without touching the map or the binding',()=>{
 const F=chosenFlow();
 const e=economyStep(F[1],'train');assert.equal(checkTransition(F[1],{kind:'train',rev:F[1].revision},e,fixture()),'ok');
 const t=step(e,'settle_departure');assert.equal(checkTransition(e,{kind:'settle_departure',rev:e.revision},t,fixture()),'ok');
 const bad=structuredClone(e);bad.marchBinding.departedMilli--;assert.throws(()=>checkTransition(F[1],{kind:'train',rev:F[1].revision},bad,fixture()),code('BadEconomy'));
});
test('chosen binding shape: route re-walked from the directions, provinces from the map, labels exact',()=>{
 const F=chosenFlow(),p=i=>e=>{const n=structuredClone(F[i]);e(n);return ()=>parseReplyObject(n);};
 for(const [want,i,e] of [
  ['BadBindingRoute',1,n=>{n.marchBinding.destination.tile=(n.marchBinding.destination.tile+1)%61;}],
  ['BadBindingRoute',1,n=>{n.marchBinding.steps[0].tile=3;}],
  ['BadReply',1,n=>{n.marchBinding.directions='2'.repeat(11);}],
  ['BadBindingRoute',1,n=>{n.marchBinding.directions='2'.repeat(11)+'3';}],
  ['BadBindingRoute',1,n=>{n.marchBinding.provincesEntered.reverse();}],
  ['BadBindingRoute',1,n=>{n.marchBinding.pathProvinces[0].accountKeyHex='03'.repeat(32);}],
  ['BadBindingRoute',1,n=>{n.marchBinding.pathProvinces.pop();}],
  ['BadBinding',1,n=>{n.marchBinding.order.labels.pop();}],
  ['BadBinding',1,n=>{n.marchBinding.order.source='RECORDED_FIXTURE_ORDER';}],
  ['BadBindingTrail',1,n=>{n.marchBinding.trail.push('REAL_REVEAL');}],
  ['BadBindingTrail',3,n=>{n.marchBinding.trail.reverse();}],
  ['BadBindingAccounts',3,n=>{n.marchBinding.accounts[0].keyHex='ee'.repeat(32);}],
  ['BadBindingAccounts',3,n=>{n.marchBinding.accounts[1].keyHex=n.marchBinding.accounts[0].keyHex;}],
  ['BadReply',3,n=>{n.marchBinding.accounts[0].role='payer';}],
  ['BadPreparation',3,n=>{n.marchBinding.preparation.fromBell=7;}],
  ['BadPreparation',3,n=>{n.marchBinding.preparation.resolves=13;}],
  ['BadPreparation',3,n=>{n.marchBinding.preparation.labels.pop();}],
  ['BadPreparation',3,n=>{n.marchBinding.preparation.provenance='BEACON_DERIVED';}],
  ['BadPreparation',2,n=>{n.marchBinding.preparation=structuredClone(F[3].marchBinding.preparation);}],
  ['BadReply',1,n=>{n.marchBinding.destination.source='fixture';}],
  ['BadReply',1,n=>{n.combat.enemyFixture=true;}],
  ['BadReply',1,n=>{n.horizon.selectedDestinationResolvedNext=7;}],
  ['BadReply',0,n=>{n.marchBinding=structuredClone(F[1].marchBinding);}],
  ['BadReply',1,n=>{n.marchBinding=null;}],
  ['BadReply',1,n=>{n.marchBinding.arriveBell=21;}],
 ]) assert.throws(p(i)(e),code(want),String(e));
 // the selected cursor is the province's own bytes
 assert.throws(p(3)(n=>{n.map.provinces[2].resolvedNext=21;n.horizon.selectedDestinationResolvedNext=21;}),code('EvidenceMismatch'));
 // the recorded binding names the recorded route exactly
 const R=recordedFlow();for(const e of [n=>{n.marchBinding.destination.tile=0;},n=>{n.marchBinding.trail=['REAL_DEPART'];},n=>{n.marchBinding.kind='chosen';}]){const n=structuredClone(R[1]);e(n);assert.throws(()=>parseReplyObject(n),String(e));}
});
test('the live transit record carries the binding\'s root, in the phase\'s state, and is emptied once settled',()=>{
 const F=chosenFlow(),p=(i,e)=>{const n=structuredClone(F[i]);e(n);return ()=>parseReplyObject(n);};
 const tr=n=>accountOf(n,TRANSIT_KEY);
 const flip=(n,i)=>{const b=fromHex(tr(n).dataHex);b[i]^=1;tr(n).dataHex=toHex(b);};
 for(const [i,e] of [[1,n=>flip(n,210)],[1,n=>flip(n,1)],[1,n=>flip(n,9)],[1,n=>flip(n,70)],[4,n=>flip(n,120)],[1,n=>flip(n,172)],
  [2,n=>{Object.assign(tr(n),{ownerHex:'00'.repeat(32),lamports:'0',dataHex:''});}],[5,n=>{Object.assign(tr(n),structuredClone(tr(F[4])));}]])
  assert.throws(p(i,e),code('EvidenceMismatch'),String(e));
 assert.equal(fromHex(tr(F[1]).dataHex).subarray(200,232).toString('hex'),F[1].marchBinding.order.rootHex);
});
test('chosen phase steps: exact cursors, GATED bytes, recorded destination and other provinces unchanged, accounts append-only',()=>{
 const F=chosenFlow(),t=(i,want,edit)=>assert.throws(T(F,CHOSEN_CMDS,i,edit),code(want),String(edit));
 t(4,'BadCursor',n=>setCursor(n,2,22));
 t(3,'GatedChanged',n=>editBytes(n,'10',b=>{b[130]^=1;}));
 t(6,'GatedChanged',n=>editBytes(n,'10',b=>{b[4850]^=1;})); // a trailer byte no summary reports
 t(2,'FixtureDestinationChanged',n=>editBytes(n,'03',b=>{b[1000]^=1;}));
 t(3,'FixtureDestinationChanged',n=>setCursor(n,1,21));
 t(2,'IdentityChanged',n=>editBytes(n,'10',b=>{b[1000]^=1;}));
 t(5,'AccountRemoved',n=>{n.evidence.accounts=n.evidence.accounts.filter(a=>a.keyHex!==TRANSIT_KEY);});
 t(2,'AccountAdded',n=>{n.evidence.accounts.push({keyHex:'ef'.repeat(32),ownerHex:PROGRAM,lamports:'1',dataHex:'00'});});
 t(3,'AccountAdded',n=>{n.evidence.accounts.push({keyHex:'ef'.repeat(32),ownerHex:PROGRAM,lamports:'1',dataHex:'00'});});
 t(2,'LandChanged',n=>editBytes(n,'06',b=>{b[90]^=1;}));
 t(4,'BadArrival',n=>{n.combat.arrivalSurvivorMilli=n.marchBinding.departedMilli+1;n.host.currentMilli=n.combat.arrivalSurvivorMilli;});
 t(2,'BadBinding',n=>{n.marchBinding.departedMilli--;});
 t(5,'BadPreparation',n=>{n.marchBinding.preparation.scoreNextBell++;});
 t(4,'BadBindingAccounts',n=>{const a=n.marchBinding.accounts;[a[0],a[1]]=[a[1],a[0]];});
 t(6,'BadReturn',n=>{n.returned.creditedUnits++;n.returned.creditedMilli+=1000;});
 // another opened province stays byte-identical through the chosen march
 const s0=openStep(openedSession(),'129','-3',{key:'11',wedge:5}),d=step(s0,'depart_route',{dirs:CHOSEN_DIRS}),tr=step(d,'settle_departure');
 assert.equal(checkTransition(s0,{kind:'depart_route',rev:s0.revision,dirs:CHOSEN_DIRS},d,fixture()),'ok');
 const touched=structuredClone(tr);editBytes(touched,'11',b=>{b[1000]^=1;});
 assert.throws(()=>checkTransition(d,{kind:'settle_departure',rev:d.revision},touched,fixture()),code('IdentityChanged'));
});
test('chosen receipts: exact kinds, bells and provinces; every chain from the previous headers to the next; tampering refused',()=>{
 const F=chosenFlow(),t=(i,want,edit)=>assert.throws(T(F,CHOSEN_CMDS,i,edit),code(want),String(edit));
 const flipHex=(h,i)=>h.slice(0,2*i)+((parseInt(h.slice(2*i,2*i+2),16)^1).toString(16).padStart(2,'0'))+h.slice(2*i+2);
 t(3,'ReceiptKinds',n=>{n.evidence.recordsHex.shift();});
 t(3,'ReceiptKinds',n=>{n.evidence.recordsHex.splice(13,0,n.evidence.recordsHex[13]);});
 t(3,'BadInstructions',n=>{n.evidence.recordsHex.shift();n.evidence.instructions.shift();});
 t(3,'ReceiptChain',n=>{const r=n.evidence.recordsHex;[r[0],r[1]]=[r[1],r[0]];});
 t(3,'ReceiptChain',n=>{n.evidence.recordsHex[5]=flipHex(n.evidence.recordsHex[5],70);});
 t(3,'ReceiptChainEnd',n=>editBytes(n,'10',b=>{b[40]^=1;}));
 t(2,'ReceiptChainEnd',n=>editBytes(n,'01',b=>{b[40]^=1;}));
 t(1,'BadInstructions',n=>{n.evidence.instructions=['Depart','Depart'];});
 t(4,'BadInstructions',n=>{n.evidence.instructions=['Gather','PostSeed','Resolve'];});
 // the step's receipts in another order: not the step's kind sequence
 t(4,'ReceiptKinds',n=>{n.evidence.recordsHex.reverse();});
 // the settle_transit receipt replaced by the recorded march's (keyed to the recorded destination). Both synthetic
 // flows have identical holding histories before it, so its holding link recomputes (seq 3); but the holding then
 // ends at seq 3 with a head that is not the account's (the account was advanced by the chosen receipt). The holding
 // chain is walked first, so its end mismatch is the refusal.
 t(5,'ReceiptChainEnd',n=>{n.evidence.recordsHex=[...recordedFlow()[5].evidence.recordsHex];});
});
test('depart_route transition: the binding is exactly the sent directions; a recorded command cannot bind a chosen march',()=>{
 const F=chosenFlow();
 assert.throws(()=>checkTransition(F[0],{kind:'depart_route',rev:F[0].revision,dirs:'2'.repeat(11)},F[1],fixture()),code('BadBinding'));
 assert.throws(()=>checkTransition(F[0],{kind:'depart',rev:F[0].revision},F[1],fixture()),code('BadTransition'));
 const late=structuredClone(F[1]);late.clock={unix:String(BigInt(late.clock.unix)+1n),bell:late.clock.bell};assert.throws(()=>checkTransition(F[0],{kind:'depart_route',rev:F[0].revision,dirs:CHOSEN_DIRS},late,fixture()),code('BadClock'),'a departure never moves the clock');
 // opening another province during the chosen march leaves the binding as it is
 const o=openStep(F[2],'129','-3',{key:'12',wedge:5});assert.equal(checkTransition(F[2],{kind:'open_province',rev:F[2].revision,p:'129',q:'-3'},o,fixture()),'ok');
 const ob=structuredClone(o);ob.marchBinding.trail.push('X');assert.throws(()=>checkTransition(F[2],{kind:'open_province',rev:F[2].revision,p:'129',q:'-3'},ob,fixture()));
});
test('depart_route refusals change nothing; only an unreachable one carries the host quote, never a re-route',()=>{
 const s=openedSession(),cmd={kind:'depart_route',rev:s.revision,dirs:'2'.repeat(32)};
 const unreach=refused(s,'depart_route','ROUTE_UNREACHABLE',{routeQuote:hostQuote(s,'2'.repeat(32))});
 assert.equal(checkTransition(s,cmd,unreach,fixture()),'refused');
 assert.throws(()=>parseReplyObject(refused(s,'depart_route','ROUTE_UNREACHABLE')),code('BadReply'),'the host quote is required');
 assert.throws(()=>parseReplyObject(refused(s,'depart_route','ROUTE_UNREACHABLE',{routeQuote:hostQuote(s,'222')})),code('BadReply'),'a reachable quote is no unreachable refusal');
 for(const e of ['ROUTE_DESTINATION_ORIGIN','ROUTE_DESTINATION_FIXTURE','ROUTE_DESTINATION_UNSUPPORTED','STALE_REVISION','BAD_PHASE','ARRIVAL_FATE_UNSUPPORTED']){
  assert.equal(checkTransition(s,cmd,refused(s,'depart_route',e),fixture()),'refused',e);
  assert.throws(()=>parseReplyObject(refused(s,'depart_route',e,{routeQuote:hostQuote(s,'2'.repeat(32))})),code('BadReply'),e);
 }
 assert.equal(checkTransition(s,cmd,refused(s,'depart_route','ROUTE_REHEARSAL_REFUSED',{refusalCode:21}),fixture()),'refused');
 assert.throws(()=>parseReplyObject(refused(s,'depart_route','ROUTE_DESTINATION_FIXTURE',{refusalCode:21})),code('BadReply'));
 const drift=refused(s,'depart_route','ROUTE_DESTINATION_ORIGIN');drift.phase='departed';assert.throws(()=>checkTransition(s,cmd,drift,fixture()));
 const bound=refused(s,'depart_route','ROUTE_UNREACHABLE',{routeQuote:hostQuote(s,'2'.repeat(32))});bound.marchBinding=null;bound.host.currentMilli--;assert.throws(()=>checkTransition(s,cmd,bound,fixture()),code('BadTransition'));
});
test('reset after a chosen march restores the fresh baseline: no binding, no opened province, no selected cursor',()=>{
 const F=chosenFlow(),last=F.at(-1);
 const reset=structuredClone(fixture());Object.assign(reset,{command:'reset',revision:last.revision+1});
 assert.equal(checkTransition(last,{kind:'reset',rev:last.revision},reset,fixture()),'ok');
 const kept=structuredClone(reset);kept.economy.harvests=1;assert.throws(()=>checkTransition(last,{kind:'reset',rev:last.revision},kept,fixture()),code('BadReset'));
});
test('at most 96 persistent images: the browser\'s bound is the host\'s',()=>{
 assert.equal(MAX_ACCOUNTS,96);
 const r=fixture();while(r.evidence.accounts.length<96)r.evidence.accounts.push({keyHex:(r.evidence.accounts.length).toString(16).padStart(2,'0').repeat(31)+'ff',ownerHex:'00'.repeat(32),lamports:'0',dataHex:''});
 assert.equal(parseReplyObject(r).evidence.accounts.length,96);
 r.evidence.accounts.push({keyHex:'fe'.repeat(32),ownerHex:'00'.repeat(32),lamports:'0',dataHex:''});
 assert.throws(()=>parseReplyObject(r),code('BadReply'));
});
test('controller: a chosen departure is serialized and judged; a stale duplicate never reaches the host',async()=>{
 const a=fixture(),o=openStep(a,'129','-2',{wedge:5}),d=step(o,'depart_route',{dirs:CHOSEN_DIRS});let calls=[];
 const replies=[a,o,d];
 const c=createController({bridge:{alive:true,close(){},async exchange(line){calls.push(line);return JSON.stringify(replies[calls.length-1]);}}});await c.start();
 assert.equal((await c.mutate(commandFromBody('open',{expectedRevision:0,p:'129',q:'-2'}))).status,200);
 const cmd=commandFromBody('depart_route',{expectedRevision:1,dirs:CHOSEN_DIRS});
 const [one,two]=await Promise.all([c.mutate(cmd),c.mutate(cmd)]);
 assert.equal(one.status,200);assert.equal(one.body.outcome,'ok');assert.equal(two.status,409);
 assert.deepEqual(calls,['get','open_province 0 129 -2',`depart_route 1 ${CHOSEN_DIRS}`]);
 assert.equal(c.view().reply.marchBinding.kind,'chosen');
});
test('browser chosen send: only from the current reachable quote, its exact directions and revision; the binding must be that quote',async()=>{
 const s=openedSession(),d=step(s,'depart_route',{dirs:CHOSEN_DIRS});let calls=[];
 const mk=(postReply)=>createClient({fetchFn:async(path,init)=>{calls.push([path,init.method,init.body??null]);if(init.method==='GET')return response(s);if(path==='/api/quote')return quoteResponse(hostQuote(s,JSON.parse(init.body).dirs),s);return postReply();}});
 const client=mk(()=>posted(d,'ok'));
 await client.refresh();
 // no quote, or a direct submit, sends nothing
 assert.equal((await client.departRoute()).reason,'input');
 assert.equal((await client.submit({kind:'depart_route',dirs:CHOSEN_DIRS})).reason,'input');
 assert.equal(calls.length,1);
 // an unreachable quote is not sendable
 await client.quote('2'.repeat(32));assert.equal(client.snapshot.quote.reachable,false);
 assert.equal((await client.departRoute()).reason,'input');assert.equal(calls.length,2);
 // a reachable quote: one POST of exactly {expectedRevision, dirs}, judged, bound to that quote
 await client.quote(CHOSEN_DIRS);
 const q=client.snapshot.quote;
 const r=await client.departRoute();
 assert.equal(r.ok,true);
 assert.deepEqual(calls.at(-1),['/api/depart_route','POST',`{"expectedRevision":${s.revision},"dirs":"${CHOSEN_DIRS}"}`]);
 assert.ok(bindingMatchesQuote(client.snapshot.state.marchBinding,CHOSEN_DIRS,q));
 assert.equal(client.snapshot.quote,null,'the quote is consumed by the state change');
 // a reply whose binding is not the quoted route fails closed (nothing stale shown, never retried)
 const forged=hostQuote(s,CHOSEN_DIRS);forged.end={...forged.end,tile:(forged.end.tile+1)%61};forged.steps.at(-1).tile=forged.end.tile;
 const c3=createClient({fetchFn:async(path,init)=>{if(init.method==='GET')return response(s);if(path==='/api/quote')return quoteResponse(forged,s);return posted(d,'ok');}});
 await c3.refresh();await c3.quote(CHOSEN_DIRS);assert.equal((await c3.departRoute()).reason,'unknown');assert.equal(c3.snapshot.state,null);
 // an unreachable refusal shows the host's quote of the refused directions; nothing else changes, nothing is re-sent
 const unreach=refused(s,'depart_route','ROUTE_UNREACHABLE',{routeQuote:hostQuote(s,'2'.repeat(32))});
 let posts=0;const c4=createClient({fetchFn:async(path,init)=>{if(init.method==='GET')return response(s);if(path==='/api/quote')return quoteResponse(hostQuote(s,CHOSEN_DIRS),s);posts++;return posted(unreach,'refused');}});
 await c4.refresh();await c4.quote(CHOSEN_DIRS);const r4=await c4.departRoute();
 assert.equal(r4.reason,'refused');assert.equal(posts,1);assert.equal(c4.snapshot.state.revision,s.revision);assert.equal(c4.snapshot.quote.reachable,false);assert.equal(c4.snapshot.notice.code,'ROUTE_UNREACHABLE');
 // any other mutation invalidates the quote: the send is then refused locally
 const h=economyStep(s,'harvest');const c5=createClient({fetchFn:async(path,init)=>{if(init.method==='GET')return response(s);if(path==='/api/quote')return quoteResponse(hostQuote(s,CHOSEN_DIRS),s);return posted(h,'ok');}});
 await c5.refresh();await c5.quote(CHOSEN_DIRS);await c5.submit({kind:'harvest'});assert.equal(c5.snapshot.quote,null);assert.equal((await c5.departRoute()).reason,'input');
});
