// Fixed public records only; no RPC, keys, signing, runtime or fixture generation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseWideManifest, parseWidePage, WideWalk, worldIdOf, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { syntheticWideEntry } from './fixtures/wide-map-capture.mjs';

const program = encode(new Uint8Array(32).fill(0x5e)), seasonAddress = encode(new Uint8Array(32).fill(3));
const world = worldIdOf(seasonAddress, program);
const snapshot = { epoch: '1', stamp: 'ab'.repeat(32), lastSlot: '20', foldedThrough: '12' };
const manifestJSON = () => ({ v:1, experimental:true, readOnly:true, completeness:'captured', world, worldDomain:WORLD_DOMAIN,
  program, seasonAddress, season:'5', snapshot:{...snapshot}, recorded:1, refused:0, page:{max:256} });
const manifest = () => parseWideManifest(manifestJSON());
const entry = (p = '129', q = '0') => syntheticWideEntry({seasonAddress, program, p, q, slot:'20'});
const page = e => ({v:1,world,snapshot,after:null,next:null,entries:[e]});
const parse = e => parseWidePage(page(e), {world,manifest:manifest()});
const bad = e => assert.throws(() => parse(e), {code:'BadWideCapture'});
const alter = (capture, offset, value) => {
  const b = Buffer.from(capture.bytes_b64, 'base64'); b[offset] = value; capture.bytes_b64 = b.toString('base64');
};

test('wide map verifies both raw capture identities at exact coordinates in every wedge', () => {
  for (const [p,q] of [['129','0'],['0','129'],['-129','129'],['-129','0'],['0','-129'],['129','-129'],['9007199254740993','0']]) {
    const got = parse(entry(p,q)).entries[0];
    assert.equal(got.p,BigInt(p)); assert.equal(got.q,BigInt(q));
    assert.equal(got.wide.capture.verification,'captured-unverified');
    assert.equal(got.wide.holdings[0].capture.verification,'captured-unverified');
  }
});

test('zero bytes, malformed ABI headers and contradictory province fields are refused', () => {
  for (const [offset,value] of [[0,0],[16,2],[4736,2],[4738,0],[4739,0],[4789,1],[4840,1],[64,1],[68,1],[70,1],[71,4],[76,6],[4481,3],[4740,0],[4772,1],[8,6]]) {
    const e = entry(); alter(e.wide.capture,offset,value); bad(e);
  }
  const e = entry(); e.wide.capture.bytes_b64 = Buffer.alloc(4864).toString('base64'); bad(e);
  const seed = entry(), b = Buffer.from(seed.wide.capture.bytes_b64,'base64');
  b.fill(0,4800,4832); seed.wide.capture.bytes_b64 = b.toString('base64'); bad(seed);
});

test('holding raw bytes must match its owner, slot, generation, coordinate and ABI identity', () => {
  for (const [offset,value] of [[0,0],[16,2],[1280,2],[1282,0],[1287,1],[1337,1],[64,1],[68,3],[69,2],[1283,3],[72,4],[1288,0],[1320,1],[8,6],[1284,2]]) {
    const e=entry(); alter(e.wide.holdings[0].capture,offset,value); bad(e);
  }
  const e=entry(); e.wide.holdings[0].capture.bytes_b64=Buffer.alloc(1344).toString('base64'); bad(e);
});

test('canonical public addresses and fold bounds are required for both captures', () => {
  for (const pick of [e=>e.wide.capture,e=>e.wide.holdings[0].capture]) {
    for (const [key,value] of [['address',seasonAddress],['slot','21'],['archiveSequence','13']]) {
      const e=entry(); pick(e)[key]=value; bad(e);
    }
  }
  assert.throws(()=>parseWidePage(page(entry()),{world}),{code:'BadWideCapture'});
  const j=manifestJSON(); delete j.snapshot.lastSlot; delete j.snapshot.foldedThrough;
  assert.throws(()=>parseWidePage(page(entry()),{world,manifest:parseWideManifest(j)}),{code:'BadWideCapture'});
  j.snapshot.lastSlot='20'; assert.throws(()=>parseWideManifest(j),{code:'BadManifest'});
  const changed=page(entry()); changed.snapshot={...snapshot,epoch:'2'};
  assert.throws(()=>parseWidePage(changed,{manifest:manifest()}),{code:'StaleSnapshot'});
});

test('a refused capture cannot be partially installed by the paginated walk', () => {
  const walk=new WideWalk(); walk.begin(manifest());
  const e=entry(); e.wide.keepHolder=2;
  assert.equal(walk.accept(page(e)),'BadWideCapture');
  assert.equal(walk.entries.size,0); assert.equal(walk.done,false);
});
