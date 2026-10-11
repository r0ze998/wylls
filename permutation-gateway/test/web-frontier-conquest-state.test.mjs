import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conquestEnabled, territoryStandings, keepFromProvince, applyControl, outpostOffer, nextOutpostSlot, effectiveTier, capturePending, provinceWeights } from '../../permutation-server/web/frontier/fconquest.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { decodeControl, decodeOverviewV2 } from '../../permutation-server/web/frontier/herald.mjs';

const file = path => readFileSync(new URL(`../../${path}`, import.meta.url));
const json = path => JSON.parse(file(path));
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const fields = o => Object.fromEntries(Object.entries(o).map(([k,v]) => [camel(k),v]));
const preset = json('frontier-abi/vectors/v2/presets.json').presets.find(p => p.name === 'MC_LOCAL_14D').fields;
const season = { layoutVersion: 2, ...fields(preset.base), conquestParams: fields(preset.conquest) };
const store = n => ({ value: BigInt(n)*1000n, rate: 0n, cap: 6000000n, t0: 0n, frac: 0n });
const home = extra => ({ p:2,q:0,site:0,gen:0,order:1,state:2,tier:1,queue:[],stores:Array(8).fill(5000).map(store),...extra });
const target = { p:4,q:0,site:0 };
const province = extra => ({ p:4,q:0,siteCount:1,siteMirror:[{state:0}],conquest:[{kind:0}],...extra });
const state = extra => ({ season,citizen:{faction:0,slots:0,holding:[{gen:0},{gen:255},{gen:255}]},holdings:[home()],provinces:new Map([['4,0',{province:province()}]]),record:{openSites:100,occupiedSites:79},nowBell:100,chain:{now:()=>1000},...extra });

test('the live season preset is 14 days at ten minutes per turn; conquest requires the matching layout and program', () => {
  assert.equal(season.endBell*season.bellSecs,14*86400);
  assert.equal(season.bellSecs,600);
  assert.equal(conquestEnabled(season),true);
  assert.equal(conquestEnabled({...season,layoutVersion:1}),false);
  assert.equal(conquestEnabled({...season,programVersion:2}),false);
});

test('national scores read the Rust herald fixture and preserve exact territory totals without borrowing Dominion', () => {
  const source=json('frontier-node/crates/herald/vectors/cq-json/standings-latest.json');
  const result=territoryStandings(source);
  assert.equal(result.metric,'province-bells');
  assert.deepEqual(result.rows.map(x=>x.provinceBells),source.factions.map(x=>String(x.territoryBells)));
  const mutate=fn=>{const copy=structuredClone(source);fn(copy);return territoryStandings(copy);};
  assert.equal(mutate(x=>delete x.scoring),null);
  assert.equal(mutate(x=>x.factions[0].faction=x.factions[1].faction),null);
  for(const bad of [null,true,'',-1,'1.5',9007199254740992]) assert.equal(mutate(x=>x.factions[0].territoryBells=bad),null);
  assert.equal(mutate(x=>x.factions[0].territoryBells='9007199254740993').rows[0].provinceBells,'9007199254740993');
  assert.equal(mutate(x=>{x.factions[0].territoryBells='123';x.factions[0].dominion=999999;}).rows[0].provinceBells,'123');
});

test('raw Rust Province conquest vectors decode inherited records and preserve whole-unit keep troops', () => {
  const source=json('frontier-abi/vectors/v2/conquest.json');
  for(const row of source.cases) {
    const bytes=fileBytes(row.province_before), p=decode('Province',bytes), k=keepFromProvince(p);
    assert.equal(p.layoutVersion,2); assert.equal(p.entries.length,56); assert.equal(p.siteMirror.length,12);
    if(p.keep.tile===255) {assert.equal(k,null);continue;}
    assert.equal(k.tile,bytes[4480]);
    assert.equal(k.troops,new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4488,true));
    assert.equal(k.heartland,!!(bytes[4485]&1));
  }
  const p=decode('Province',fileBytes(source.cases[0].province_before));
  p.keep={...p.keep,tile:20,holder:0,troops:300};
  assert.equal(keepFromProvince(p).troops,300,'a keep uses whole troops, unlike host and site garrisons');
});
const fileBytes = hex => Uint8Array.from(Buffer.from(hex,'hex'));

test('province control overlays the Rust binary overview by coordinates, not site majority', () => {
  const source='frontier-node/fixtures/cq/formats/';
  const overview=decodeOverviewV2(file(`${source}overview2-r4-b300.bin`));
  const control=decodeControl(file(`${source}control-r4-b300.bin`));
  applyControl(new Map([[4,overview]]),control);
  for(const p of overview.provinces) {
    const c=control.provinces.find(x=>x.p===p.p&&x.q===p.q);
    assert.equal(p.control,c.control); assert.equal(p.contender,c.contender); assert.equal(p.contestProgress,c.progress);
  }
});

test('outpost weights agree with Rust control vectors before snapshot rounding', () => {
  for(const v of json('permutation-rules/vectors/control-vectors-v1.json').site_weight_centi) {
    const p=province({siteMirror:[{state:1,faction:0,tier:v.tier,garrison:v.garrison,order:v.order}]});
    const w=provinceWeights(p,0,100);
    assert.equal(Math.floor(w.mine/10000),v.centi); assert.equal(w.mine,w.total);
  }
  const p=province({siteCount:2,siteMirror:[{state:1,faction:0,tier:0,tierNext:1,tierNextBell:100,garrison:0,order:1},{state:5,tier:0,tierNext:3,tierNextBell:1,garrison:0,order:0}]});
  assert.deepEqual(provinceWeights(p,0,100),{mine:1300000,total:2300000});
});

test('the outpost offer respects actual resource cost, the nested preset, range, share, close and free-land boundaries', () => {
  assert.equal(outpostOffer(state(),target).eligible,true);
  assert.deepEqual(outpostOffer(state(),target).cost,[800,800,400,0,0,200,0,0]);
  const poor=home({stores:[799,800,400,0,0,200,0,0].map(store)});
  assert.equal(outpostOffer(state({holdings:[poor]}),target).eligible,false);
  const boundary=home({stores:[800,800,400,0,0,200,0,0].map(store)});
  assert.equal(outpostOffer(state({holdings:[boundary]}),target).eligible,true);
  assert.equal(outpostOffer(state({record:{openSites:100,occupiedSites:80}}),target).eligible,true);
  assert.equal(outpostOffer(state({record:{openSites:100,occupiedSites:81}}),target).eligible,false);
  assert.equal(outpostOffer(state({nowBell:season.endBell-25}),target).eligible,true);
  assert.equal(outpostOffer(state({nowBell:season.endBell-24}),target).eligible,false);
  assert.equal(outpostOffer(state({holdings:[home({p:0,q:0})]}),target).eligible,false);
  const own={state:1,faction:0,tier:0,garrison:0,order:1},enemy={...own,faction:1};
  const p=province({siteCount:3,siteMirror:[{state:0},own,enemy]});
  assert.equal(outpostOffer(state({provinces:new Map([['4,0',{province:p}]])}),target).eligible,false);
});

test('completed Town construction counts immediately but pending capture and occupied settlement slots remain blocked', () => {
  const upgrading=home({tier:0,queue:[{kind:3,doneAt:1000n}]});
  assert.equal(effectiveTier(upgrading,999),0); assert.equal(effectiveTier(upgrading,1000),1);
  assert.equal(outpostOffer(state({holdings:[upgrading]}),target).eligible,true);
  const s=state();
  s.citizen.slots=4;
  assert.equal(nextOutpostSlot(s.citizen,s.holdings),3);
  assert.equal(outpostOffer(s,target).eligible,false,'slot 3 requires a finalized slot 2');
  s.citizen.slots=12;
  assert.equal(nextOutpostSlot(s.citizen,s.holdings),null);
  assert.equal(outpostOffer(s,target).code,'CapturePending');
  s.citizen.slots=8;
  assert.equal(nextOutpostSlot(s.citizen,s.holdings),2);
  assert.equal(outpostOffer(s,target).code,'CapturePending','even a different slot may raise the price when the capture settles');
  s.citizen.slots=2;
  assert.equal(outpostOffer(s,target).pending,true);
  s.citizen.slots=0;
  s.provinces.set('2,0',{province:{siteMirror:[{state:1,gen:1}]}});
  assert.equal(capturePending(s,s.holdings[0]),true);
  assert.equal(outpostOffer(s,target).eligible,false);
  s.provinces.get('2,0').province.siteMirror[0].gen=0;
  s.provinces.get('4,0').province.conquest[0]={kind:0,flags:1};
  assert.equal(outpostOffer(s,target).eligible,false,'an owing record still blocks the site after its live contest ended');
});
