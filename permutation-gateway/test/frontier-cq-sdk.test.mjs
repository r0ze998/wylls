import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { fromHex } from '../client/src/bytes.mjs';
import { parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { TAGS } from '../client/src/frontier/abi-v2-tags.mjs';
import { PRESETS } from '../client/src/frontier/abi-v2-presets.mjs';
import { encodeIxData, decodeIxData, decodeAccount, encodeAccount } from '../client/src/frontier/codec.mjs';
import { shapeMessage, classify } from '../client/src/frontier/shapes.mjs';
import { profileForHash, profileForSeason } from '../client/src/frontier/profile.mjs';
import { SYSTEM_PROGRAM } from '../client/src/frontier/addresses.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { allowanceFor, HOLDING_RENT, drainGuard } from '../src/frontier/shapes.mjs';
import { checkMe } from '../../permutation-server/web/frontier/herald.mjs';
import { instantHomeEnabled } from '../../permutation-server/web/frontier/home.mjs';
let seq=1;
function fresh(){seq++;return Keypair.fromSeed(Uint8Array.from({length:32},(_,i)=>(seq+i)%255)).publicKey.toBase58();}
const fixture = f => JSON.parse(readFileSync(new URL(`../../frontier-abi/vectors/v2/${f}.json`,import.meta.url),'utf8'));

test('first-village v2 layout1 and conquest v3 layout2 are distinct capabilities',()=>{
  assert.equal(instantHomeEnabled({programVersion:2,layoutVersion:1}),true);
  assert.equal(instantHomeEnabled({programVersion:2,layoutVersion:2}),false);
  assert.equal(instantHomeEnabled({programVersion:3,layoutVersion:2}),true);
  assert.equal(profileForHash(PRESETS.ruleset_hash),2);
  assert.equal(profileForSeason({PROGRAM_VERSION:2,LAYOUT_VERSION:1}),1);
  assert.equal(profileForHash('00'.repeat(32)),null);
});
test('both browser decoders read actual Rust conquest Provinces and territory counters',()=>{
  for(const c of fixture('conquest').cases){
    const bytes=fromHex(c.province_before), a=decodeAccount('Province',bytes), b=decode('Province',bytes);
    assert.equal(a.LAYOUT_VERSION,2,c.case);
    assert.equal(a.KEEP[0].HOLDER,b.keep.holder,c.case);
    assert.equal(a.CONQUEST.length,b.conquest.length,c.case);
    assert.deepEqual(a.TERRITORY_BELLS,b.territoryBells,c.case);
  }
  const bytes=encodeAccount('Province',{LAYOUT_VERSION:2,TERRITORY_BELLS:[0n,1n,1008n,2016n,90000n,0n],SCORE_NEXT_BELL:2016},{profile:2});
  assert.equal(bytes.length,4736);
  assert.deepEqual(decode('Province',bytes).territoryBells,[0n,1n,1008n,2016n,90000n,0n]);
});
test('all CQ player/settle messages pass the versioned relay allowlist and reject legacy dispatch',()=>{
  for(const ix of TAGS.instructions.filter(i=>i.relay_player_shape||i.relay_settle_shape)){
    const fields=Object.fromEntries((ix.data??[]).map(f=>[f.name,f.len>8?new Uint8Array(f.len):0]));
    if(['FileTicket','FileOutpost'].includes(ix.name)) Object.assign(fields,{sites:[{p:4,q:-1,site:2},{p:5,q:-1,site:1}],anchor_site_key:12345678n});
    if((ix.data??[]).some(f=>f.name==='tiles')) fields.tiles=new Uint8Array(ix.data.find(f=>f.name==='tiles').len);
    const data=encodeIxData(ix.name,fields,2);
    assert.deepEqual(encodeIxData(ix.name,decodeIxData(data,2),2),data,ix.name);
    const accounts={};
    for(const g of ix.account_groups) for(const a of g.accounts) accounts[a.name]=g.max>1?Array.from({length:g.max},fresh):a.kind==='system'?SYSTEM_PROGRAM:fresh();
    const programId=fresh(), message=shapeMessage({programId,name:ix.name,accounts,fields,feePayer:accounts.payer ?? accounts.fee_payer ?? accounts.any,recentBlockhash:fresh(),profile:2});
    const wire=wireTransaction(message),tx=parseTransaction(wire),actual=classify(tx,{programId,wireBytes:wire.length,profile:2});
    assert.equal(actual.ok,true,`${ix.name}: ${actual.problem}`);
    if(ix.changed_in_v2||ix.new_in_v2) assert.equal(classify(tx,{programId,profile:1}).ok,false,`${ix.name} must not be accepted using a legacy budget/list`);
  }
});
test('CQ Build requests write access for walls and tier-up only',()=>{
  for(const item of [0,6,7]){
    const accounts={actor:fresh(),payer:fresh(),season:fresh(),citizen:fresh(),holding:fresh(),province:fresh()};
    const programId=fresh(),message=shapeMessage({programId,name:'Build',accounts,fields:{item},feePayer:accounts.payer ?? accounts.fee_payer ?? accounts.any,recentBlockhash:fresh(),profile:2});
    const tx=parseTransaction(wireTransaction(message));
    assert.equal(tx.instructions[3].keys.find(k=>k.pubkey===accounts.province).isWritable,item!==0);
    assert.equal(classify(tx,{programId,profile:2}).ok,true);
  }
});

// A second capture reservation must not spend escrow already backing a first one.
test('CQ sponsorship funds exactly one new reservation and rejects excess drain',()=>{
  for(const tag of [0xA0,0xA3]){
    const allowed=allowanceFor({tag},{season:{},citizen:{TICKET_ESCROW:HOLDING_RENT}});
    assert.equal(allowed,HOLDING_RENT);
    assert.equal(drainGuard({pre:2n*HOLDING_RENT,post:HOLDING_RENT,fee:0n,allowance:allowed}),HOLDING_RENT);
    assert.throws(()=>drainGuard({pre:2n*HOLDING_RENT,post:HOLDING_RENT-1n,fee:0n,allowance:allowed}),/relay refused/);
  }
  assert.equal(allowanceFor({tag:0xA6},{season:{}}),0n);
});

test('v2-only MarchState detects its wire layout without caller hints',()=>{
  const bytes=encodeAccount('MarchState',{LAYOUT_VERSION:2,SEASON_ID:88n},{profile:2});
  assert.equal(decodeAccount('MarchState',bytes).SEASON_ID,88n);
  assert.equal(decode('MarchState',bytes).seasonId,88n);
});

test('CQ own-holding reads reject an expired ownership generation',()=>{
  const w=Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
  const owner=Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey;
  const addresses={of:kind=>kind==='Citizen'?owner.toBase58():fresh()};
  const h={p:2,q:0,site:1,gen:3,ownerCitizen:owner.toBytes()};
  const citizen={wallet:w.toBytes(),layoutVersion:2,holding:[{p:2,q:0,site:1,gen:3}]};
  assert.doesNotThrow(()=>checkMe(addresses,w.toBase58(),{},citizen,[h]));
  for(const gen of [2,255]){
    citizen.holding[0].gen=gen;
    assert.throws(()=>checkMe(addresses,w.toBase58(),{},citizen,[h]),/Citizen does not name/);
  }
});
