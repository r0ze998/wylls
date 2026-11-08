// Literal response shapes only. No keypairs, signatures, network or fixture generation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHerald} from '../../permutation-server/web/frontier/herald.mjs';
const client = body => createHerald({fetch:async()=>({ok:true,status:200,json:async()=>body})});

test('events requires an explicit ordered page rather than defaulting missing data to empty success', async()=>{
  for(const body of [null,{}, {events:{}}, {events:[],next:null}, {events:[],next:'1'},
    {events:[],next:'0',full:undefined}, {events:[],next:'0',full:true}, {events:[{seq:'2',body_b64:'AA=='}],next:'1'},
    {events:[{seq:'1',body_b64:'AA=='},{seq:'1',body_b64:'AA=='}],next:'1'}]) {
    const r = await client(body && {v:1,full:false,...body}).events(0); assert.equal(r.ok,false); assert.equal(r.code,'BadRecord');
  }
  assert.deepEqual(await client({v:1,events:[],next:'7',full:false}).events('7'), {ok:true,events:[],next:'7',full:false});
  const rows = [{seq:'8',body_b64:'AA=='},{seq:'9',body_b64:'AA=='}];
  assert.equal((await client({v:1,events:rows,next:'9',full:false}).events('7')).ok,true);
});
test('a missing or undecodable ArrivalSlot fails the me view instead of disappearing', async()=>{
  const empty = {v:1,citizen:null,holdings:[],slots:[]};
  assert.equal((await client(empty).me('unused')).ok,true);
  for(const body of [{}, {...empty,slots:undefined},{...empty,slots:{}},{...empty,slots:[{}]},
    {...empty,slots:[{bytes_b64:'AA=='}]}]) {
    assert.equal((await client(body).me('unused')).ok,false);
  }
});
