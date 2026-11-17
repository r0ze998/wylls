// Focused original-game display regressions over synthetic public state.
// No app boot, wallet, network, WASM, worker, signing or key API self-test.
// Mirrors use ABI state 3 (released-free), 4 (reserved), 5 (Free City).
// PSFOV2 uses siteKinds=2 independently of its legacy two-bit site prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tileWhat, tileName } from '../../permutation-server/web/frontier/hud/place.mjs';
import { kindOf } from '../../permutation-server/web/frontier/map/actions.mjs';
import { SpriteArt, overviewArtKey } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { inspectModel, render } from '../../permutation-server/web/frontier/hud/inspect.mjs';

const TILE = 7;
const TERRAIN = { terrain: Array(61).fill(0), sites: [TILE], names: ['Grassland'] };
function fixture({ state=5, level=3, mirror=true, siteKind=2, legacy=0 }={}) {
  const rec={p:4,q:0,owners:[7],sites:[legacy],siteKinds:[siteKind],clash:false};
  const prov={p:4,q:0,siteCount:1,sites:Uint8Array.of(TILE),relations:0n,roadMask:0n,resolvedNext:1,
    siteMirror:[{state,faction:6,tier:0,garrison:300000,shieldUntilBell:0}],entries:[],camp:{state:0}};
  const survey={showAll:false,levelAt:()=>level,levelOf:()=>level,province:()=>({max:level}),ownHosts:new Set(),villages:[]};
  const FS={mode:'spectate',selected:{p:4,q:0,idx:TILE},provinces:new Map(mirror?[['4,0',{province:prov}]]:[]),
    overviews:new Map([[4,{bell:0,provinces:[rec]}]]),holdings:[],citizen:{faction:1},nowBell:0,
    terrainOf:()=>TERRAIN,survey,marches:[],pins:[],season:{},view:{},ui:{}};
  const entry={p:4,q:0,...TERRAIN,rec,prov:mirror?prov:null,fog:'sight'};
  return {FS,entry,prov,rec,survey};
}
const modelTile=({entry,survey})=>new SpriteArt().model([entry],{ringsOpen:6,survey}).byId.get(`4,0,${TILE}`);
const text=x=>String(x).replace(/<svg[\s\S]*?<\/svg>/g,'').replace(/<[^>]+>/g,' ');

test('ABI distinguishes released sites from genesis Free Cities',()=>{
  const source=readFileSync(new URL('../../frontier-abi/src/v2/layout/province.rs',import.meta.url),'utf8');
  assert.match(source,/STATE_FREE_CITY:\s*u8\s*=\s*5/);
  assert.match(source,/STATE_RELEASED_FREE|pub use .*site/);
});

test('place names use state 5, never released state 3, for Free City',()=>{
  const city=fixture();
  assert.equal(tileWhat(city.FS,4,0,TILE).kind,'freeCity');
  assert.equal(tileName(city.FS,4,0,TILE),'自由都市');
  for(const state of [0,3,4]) {
    const f=fixture({state});
    assert.equal(tileWhat(f.FS,4,0,TILE).kind,'land',`state ${state}`);
    assert.notEqual(tileName(f.FS,4,0,TILE),'自由都市');
  }
});

test('unexplored Free City identity stays out of destination names and inspector',()=>{
  for(const level of [0,1]) {
    const f=fixture({level});
    assert.equal(tileWhat(f.FS,4,0,TILE).kind,'land');
    assert.notEqual(tileName(f.FS,4,0,TILE),'自由都市');
    assert.equal(inspectModel(f.FS,()=>TERRAIN).tile.site,null);
    assert.doesNotMatch(text(render(f.FS,()=>TERRAIN)),/守備隊 300/);
  }
});

test('sprite model draws actual Free Cities and clears released ones',()=>{
  assert.equal(modelTile(fixture()).state,5);
  assert.equal(modelTile(fixture({state:3})).state,0);
  assert.equal(modelTile(fixture({state:4})).state,0);
});

test('the known neutral Free City is an attack target; hidden land stays a plain move',()=>{
  const {prov}=fixture();
  // Neutral targets are not protected by player diplomacy or a holding's shield.
  prov.relations=(1n<<64n)-1n; prov.siteMirror[0].shieldUntilBell=99;
  for(const level of [2,3]) assert.equal(kindOf(prov,TILE,{faction:1,level}),'attack');
  for(const level of [0,1]) assert.equal(kindOf(prov,TILE,{faction:1,level}),'move');
  prov.siteMirror[0].state=3;
  assert.equal(kindOf(prov,TILE,{faction:1}),'move');
});

test('overview2-only Free City survives without a live Province mirror',()=>{
  for(const level of [2,3]) {
    const f=fixture({mirror:false,level});
    assert.equal(inspectModel(f.FS,()=>TERRAIN).tile.site.state,'freeCity');
    assert.equal(modelTile(f).state,5);
    assert.equal(inspectModel(f.FS,()=>TERRAIN).tile.site.garrison,null);
    assert.doesNotMatch(text(render(f.FS,()=>TERRAIN)),/守備隊 300/);
  }
  const legacy=fixture({mirror:false});
  delete legacy.rec.siteKinds;
  assert.equal(inspectModel(legacy.FS,()=>TERRAIN).tile.site.state,'free');
  assert.equal(modelTile(legacy).state,0);
});

test('visible Free City defenders are shown; survey hides troops and unknown sites',()=>{
  const visible=fixture();
  assert.equal(inspectModel(visible.FS,()=>TERRAIN).tile.site.garrison,300);
  assert.match(text(render(visible.FS,()=>TERRAIN)),/守備隊 300/);
  const known=fixture({level:2});
  assert.equal(inspectModel(known.FS,()=>TERRAIN).tile.site.state,'freeCity');
  assert.equal(inspectModel(known.FS,()=>TERRAIN).tile.site.garrison,null);
  assert.doesNotMatch(text(render(known.FS,()=>TERRAIN)),/守備隊 300/);
  const hidden=fixture({level:1});
  assert.equal(inspectModel(hidden.FS,()=>TERRAIN).tile.site,null);
  assert.equal(modelTile(hidden).site,undefined);
});

test('a captured holding mirror takes precedence over an older Free City overview',()=>{
  const f=fixture({state:1});
  f.prov.siteMirror[0].faction=1;
  assert.equal(tileWhat(f.FS,4,0,TILE).kind,'holding');
  assert.equal(inspectModel(f.FS,()=>TERRAIN).tile.site.state,'holding');
  assert.equal(modelTile(f).state,1);
  assert.equal(kindOf(f.prov,TILE,{faction:1}),'move');
  assert.equal(kindOf(f.prov,TILE,{faction:1,own:new Set([`4,0,${TILE}`])}),'home');
});


test('a kind-only overview update invalidates sprite identity and the model cache',()=>{
  const f=fixture({mirror:false,siteKind:3});
  const art=new SpriteArt(), before=overviewArtKey(f.rec);
  assert.equal(art.model([f.entry],{ringsOpen:6,survey:f.survey}).byId.get(`4,0,${TILE}`).state,0);
  f.rec.siteKinds[0]=2;
  assert.notEqual(overviewArtKey(f.rec),before);
  assert.equal(art.model([f.entry],{ringsOpen:6,survey:f.survey}).byId.get(`4,0,${TILE}`).state,5);
});

test('Free City inspector does not offer an outpost; a released site still can',()=>{
  for(const state of [5,3]) {
    const f=fixture({state});
    Object.assign(f.FS,{mode:'play',season:{programVersion:4},holdings:[{p:9,q:9,site:0}],conquest:{outpost:{eligible:false}}});
    const page=String(render(f.FS,()=>TERRAIN));
    assert.equal(page.includes('data-act="cq-outpost"'),state===3);
  }
});
