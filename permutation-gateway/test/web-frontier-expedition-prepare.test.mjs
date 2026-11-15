// Selected public-only tests. Run under both existing no-key guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { EXPEDITION_POP, clearInspection, inspectionRequest, inspectionInput, inspectExpedition } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { preparationRequest, preparationReport, prepareExpedition, reconcilePreparation, clearPreparation } from '../../permutation-server/web/frontier/fexpedition-prepare.mjs';
import { syntheticReturnInspection } from '../screens/codex/return-observation.mjs';
import { syntheticPreparation } from '../screens/codex/prepare-observation.mjs';
import { toHex, fromBase64, toBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const OTHER = encode(new Uint8Array(32).fill(66));
const A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const OWNER = A.of('Citizen', { wallet: WALLET });
const HOST = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const CLOSED = { dispatch_available: false, admitted: false, signed: false, enqueued: false, automatic_send: false, completion_proven: false, history_verified: false };
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const fixture = JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8'));
const SEASON = decode('Season', Buffer.from(fixture.bytes_b64, 'base64'));

function world({ village = false } = {}) {
  const h = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1,
    SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: village ? [] : [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff,
      HOLDING: [{ P: 2, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 2, q: 0, idx: 30 }, hand: { host: village ? null : HOST, pop: EXPEDITION_POP },
    nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['2,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  clearInspection(fs);
  fs.expeditionPreview.p = '129'; fs.expeditionPreview.q = '0'; fs.expeditionPreview.sequence = village ? '0' : '';
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  return { fs, ctx, h, province };
}
const clone = x => structuredClone(x);
async function observed(phase='dissolve') {
  const w=world(); await inspectExpedition(w.fs,{context:()=>w.ctx,read:async r=>syntheticReturnInspection(r,{phase})}); return w;
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('selected original Dissolve and Return produce exact host-only requests and immutable unsigned review',async()=>{
  for(const phase of ['dissolve','return']) {
    const {fs,ctx}=await observed(phase), state=fs.expeditionPreview;
    const r=preparationRequest(state.report,state.request,'public_1'),v=syntheticPreparation(r),out=preparationReport(v,r);
    assert.equal(r.source_request.deployment.program_version,'18436');
    assert.equal(r.proposal.bytes_hex.length,120);assert.equal(out.prepared.instruction_hex.length,128);
    assert.equal(out.request.source_snapshot_digest,'ab'.repeat(32));assert.equal(out.source.digest,'cd'.repeat(32));
    assert.ok(Object.isFrozen(out.prepared.roles));for(const k of ['ready','signed','admitted','enqueued','relay_submission_available'])assert.equal(out[k],false);
    await prepareExpedition(fs,{context:()=>ctx,read:async()=>v});
    assert.equal(fs.expeditionPreview.preparation.status,'error','a response to another request ID cannot be replayed');
    await prepareExpedition(fs,{context:()=>ctx,read:async req=>syntheticPreparation(req)});
    assert.equal(fs.expeditionPreview.preparation.status,'prepared');
  }
});

test('preparation refuses normal deployment, absent proposal, raw drafts and stale source scope',async()=>{
 const {fs}=await observed();const {report,request}=fs.expeditionPreview;
 for(const change of [r=>{r.deployment.program_version='16388';},r=>{r.standing.p='130';},r=>{r.wallet=OTHER;}]) {
   const r=clone(request);change(r);assert.throws(()=>preparationRequest(report,r));
 }
 assert.throws(()=>preparationRequest({proposal:report.draft},request));
 assert.throws(()=>preparationRequest(report,request,'bad id'));
 const wait=await observed('resolving');assert.throws(()=>preparationRequest(wait.fs.expeditionPreview.report,wait.fs.expeditionPreview.request));
});

test('request echo, fresh source floor and blockhash context/height/margin are enforced',async()=>{
 const {fs}=await observed(),r=preparationRequest(fs.expeditionPreview.report,fs.expeditionPreview.request,'check');
 for(const change of [v=>{v.request.request_id='other';},v=>{v.request.source_request.standing.p='130';},v=>{v.source.context_slot='4999';},
  v=>{v.source.request_digest='00'.repeat(32);},v=>{v.source.authority_verified=true;},v=>{v.blockhash.latest_context_slot='5000';},
  v=>{v.blockhash.validity_context_slot='5000';},v=>{v.blockhash.height_min_context_slot='5000';},v=>{v.blockhash.remaining_block_heights='1';},
  v=>{v.blockhash.block_height='251';},v=>{v.blockhash.valid=false;},v=>{v.ready=true;},v=>{v.extra=true;}]) {
   const v=syntheticPreparation(r);change(v);assert.throws(()=>preparationReport(v,r));
 }
});

test('unsigned message digest, exact envelope, role order/flags, budgets, signers and shape cannot be substituted',async()=>{
 const {fs}=await observed(),r=preparationRequest(fs.expeditionPreview.report,fs.expeditionPreview.request,'bytes');
 for(const change of [v=>{v.prepared.roles.reverse();},v=>{v.prepared.roles[0].signer=false;},v=>{v.prepared.budget.cu_limit++;},
  v=>{v.prepared.budget.cu_price='1';},v=>{v.prepared.budget.loaded_limit++;},v=>{v.prepared.budget.heap=32768;},
  v=>{v.prepared.instruction_hex=v.prepared.instruction_hex.replace('0204','0205');},v=>{v.prepared.message_digest='00'.repeat(32);},
  v=>{v.prepared.message_b64+=' ';},v=>{v.prepared.signers=[];},v=>{v.prepared.shape.bytes--;},v=>{v.blockhash.hash=OTHER;},
  v=>{v.prepared.proposal_digest='00'.repeat(32);},v=>{v.prepared.fee_payer=OTHER;},v=>{v.prepared.program_version='16388';},
  v=>{const b=fromBase64(v.prepared.message_b64);b[b.length-1]^=1;v.prepared.message_b64=toBase64(b);v.prepared.message_digest=toHex(sha256(b));}]) {
   const v=syntheticPreparation(r);change(v);assert.throws(()=>preparationReport(v,r));
 }
});

test('pending preparations abort and discard late replies after edits, close, wallet/session/source and observation changes',async()=>{
 for(const mutate of [w=>inspectionInput(w.fs,'expedition-p','130'),w=>clearInspection(w.fs),w=>{w.fs.wallet={...w.fs.wallet};},
  w=>{w.fs.session={publicKey:'public-only'};},w=>{w.ctx.source={};},w=>{w.ctx.relay='/other';},
  w=>{w.fs.expeditionPreview.report=clone(w.fs.expeditionPreview.report);},w=>{w.fs.holdings[0].gen++;}]) {
   const w=await observed(),d=deferred();let request,signal;
   const work=prepareExpedition(w.fs,{context:()=>w.ctx,read:async(r,o)=>{request=r;signal=o.signal;return d.promise;}});
   mutate(w);reconcilePreparation(w.fs,w.ctx);assert.equal(signal.aborted,true);
   d.resolve(syntheticPreparation(request));await work;assert.equal(w.fs.expeditionPreview.preparation??null,null);
 }
});

test('new requests supersede old replies and completed reports disappear on later context changes',async()=>{
 const w=await observed(),d=deferred();let old;
 const work=prepareExpedition(w.fs,{context:()=>w.ctx,read:async r=>{old=r;return d.promise;}});
 await prepareExpedition(w.fs,{context:()=>w.ctx,read:async r=>syntheticPreparation(r)});
 const latest=w.fs.expeditionPreview.preparation.report;assert.notEqual(latest.request.request_id,old.request_id);
 d.resolve(syntheticPreparation(old));await work;assert.equal(w.fs.expeditionPreview.preparation.report,latest);
 w.fs.expeditionPreview.p='130';assert.equal(reconcilePreparation(w.fs,w.ctx),false);assert.equal(w.fs.expeditionPreview.preparation,null);
});

test('blocked reports remain closed and invalid replacement clears a previous prepared message',async()=>{
 const w=await observed();await prepareExpedition(w.fs,{context:()=>w.ctx,read:async r=>syntheticPreparation(r)});
 await prepareExpedition(w.fs,{context:()=>w.ctx,read:async r=>({...syntheticPreparation(r),status:'blocked',prepared:null,blockhash:null,blocker:{code:'SourceBlocked'}})});
 assert.equal(w.fs.expeditionPreview.preparation.status,'blocked');assert.equal(w.fs.expeditionPreview.preparation.report.prepared,null);
 await prepareExpedition(w.fs,{context:()=>w.ctx,read:async()=>({ready:true})});
 assert.equal(w.fs.expeditionPreview.preparation.status,'error');assert.equal(w.fs.expeditionPreview.preparation.report,null);
 clearPreparation(w.fs);
});
