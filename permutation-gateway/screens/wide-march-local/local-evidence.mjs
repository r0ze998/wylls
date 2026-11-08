// Independent byte correspondence, not execution/authentication verification.
// Prefix fields: generated production fcodec V2. Wide trailers: frontier-abi world_index/{holding,land}.
// Every village number the host reports (stores, production, queue, reserve, tier, flags, owner-action stamp) must
// equal the holding account bytes it also returns; the browser re-reads them, it never computes or projects them.
import { decodePrefix } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { ringPosition } from '../../../permutation-server/web/frontier/map/wide.mjs';
const fail = () => { throw new Error('EvidenceMismatch'); };
const check = x => { if (!x) fail(); };
const bytes = s => Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x,16));
const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const owner = '12'.repeat(32);
/** Province RESOLVED_NEXT (u32 LE at 72, frontier-abi layout::province). */
const RESOLVED_NEXT = 72;
function sortCheck(b, offset, p, q) { const d = new DataView(b.buffer,b.byteOffset,b.byteLength), rp = ringPosition(BigInt(p),BigInt(q)); check(d.getBigUint64(offset,false) === rp.ring && b[offset+8] === rp.wedge && d.getBigUint64(offset+9,false) === rp.pos); }
function account(r,key,size,magic) { const a = r.evidence.accounts.find(a=>a.keyHex===key); check(a && a.ownerHex===owner); const b=bytes(a.dataHex); check(b.length===size && String.fromCharCode(...b.slice(0,8))===magic && new DataView(b.buffer).getUint16(16,true)===3); return b; }
const holdingPrefix = r => decodePrefix('Holding', account(r,r.holding.accountKeyHex,1344,'PSFXWHL1'), {profile:2});
/** The two accounts an economy command may write: the holding and the Citizen its own bytes name as owner. */
export function villageAccountKeys(r) { return [r.holding.accountKeyHex, hex(holdingPrefix(r).ownerCitizen)]; }
function checkVillage(r, v) {
  const s = r.village;
  check(v.tier === s.tier && v.flags === s.flags && String(v.lastOwnerAction) === s.lastOwnerAction);
  check(v.stores.length === 8 && v.production.length === 8 && v.queue.length === 4 && v.reserve.length === 8);
  v.stores.forEach((x, i) => check(String(x.value) === s.stores[i].value && String(x.rate) === s.stores[i].rate && String(x.cap) === s.stores[i].cap && String(x.t0) === s.stores[i].t0));
  v.production.forEach((x, i) => check(String(x) === s.production[i]));
  v.queue.forEach((x, i) => check(String(x.doneAt) === s.queue[i].doneAt && x.kind === s.queue[i].kind && x.arg === s.queue[i].arg && String(x.delta) === s.queue[i].delta));
  v.reserve.forEach((x, i) => check(x === s.reserve[i]));
  // the owner citizen is one of the returned accounts, under the program
  const c = r.evidence.accounts.find(a => a.keyHex === hex(v.ownerCitizen));
  check(c && c.ownerHex === owner && c.dataHex.length === 2 * 384);
}
export function checkEvidence(r) {
  const h=account(r,r.holding.accountKeyHex,1344,'PSFXWHL1'), hd=new DataView(h.buffer), v=decodePrefix('Holding',h,{profile:2});
  check(hd.getUint16(1280,true)===1 && h[1282]===1 && hex(h.slice(1288,1320))===r.map.worldHex);
  sortCheck(h,1320,r.map.origin.p,r.map.origin.q);
  check(v.reserve[0]===r.holding.reserveUnits && String(v.escrow)===r.holding.escrowLamports && String(v.poolOwed)===r.holding.poolOwedLamports && h[1286]===r.holding.openTransits && v.tile===r.holding.tile);
  check(v.site<12 && v.p===0 && v.q===0);
  checkVillage(r, v);
  const ref=bytes(r.host.refHex); check(ref[0]===1 && hex(ref.slice(1,33))===r.map.worldHex && ref[50]===v.site && ref[51]===v.gen); sortCheck(ref,33,r.map.origin.p,r.map.origin.q);
  for(const p of r.map.provinces) {
    const b=account(r,p.accountKeyHex,4864,'PSFXWPV1'), d=new DataView(b.buffer);
    check(d.getUint16(4736,true)===1 && b[4738]===1 && b[4739]===15 && hex(b.slice(4740,4772))===r.map.worldHex && d.getInt16(64,true)===0 && d.getInt16(66,true)===0);
    sortCheck(b,4772,p.p,p.q);
    check(String(d.getBigUint64(264,true))===p.passableMask);
    const isOrigin = p.p===r.map.origin.p && p.q===r.map.origin.q;
    if(isOrigin) check(b[250+v.site]===v.tile);
    // the horizon cursors are the provinces' own bytes, not a host claim
    check(d.getUint32(RESOLVED_NEXT,true) === (isOrigin ? r.horizon.originResolvedNext : r.horizon.destinationResolvedNext));
  }
  // Host/combat/returned projections are intentionally not independently decoded here.
  return true;
}
