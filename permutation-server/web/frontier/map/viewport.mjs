// Original-map viewport culling. Enumerate the visible lattice window, not
// every province in the season; then apply the same pixel/tilt predicates.
// This includes cloud cells beyond ring128, not additional playable land.
import { ringOf, sextant } from '../fgeo.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from './layers.mjs';
import { nearQuad } from './tilt.mjs';

const U = provincePixel(1,0), V = provincePixel(0,1);
const DET = U.x*V.y-U.y*V.x;
const inverse = (x,y) => ({p:(V.y*x-V.x*y)/DET,q:(U.x*y-U.y*x)/DET});

/** Conservative axial bounds of the pixel rectangle, expanded by a cell radius. */
export function provinceWindow(view,size,maxRing) {
  if (!Number.isSafeInteger(Math.floor(maxRing)) || maxRing<0 || !Number.isFinite(view?.x) || !Number.isFinite(view?.y)
      || !(view?.zoom>0) || !Number.isFinite(view.zoom) || !Number.isFinite(size?.width) || !Number.isFinite(size?.height)
      || size.width<0 || size.height<0) return null;
  const ring=Math.floor(maxRing), m=PROVINCE_CIRCUMRADIUS;
  const left=view.x-size.width/2/view.zoom-m, right=view.x+size.width/2/view.zoom+m;
  const top=view.y-size.height/2/view.zoom-m, bottom=view.y+size.height/2/view.zoom+m;
  if (![left,right,top,bottom].every(Number.isFinite)) return null;
  const corners=[inverse(left,top),inverse(left,bottom),inverse(right,top),inverse(right,bottom)];
  if (!corners.every(c=>Number.isFinite(c.p)&&Number.isFinite(c.q))) return null;
  // One extra lattice cell absorbs floating-point error at exact boundaries;
  // the final pixel predicate still decides inclusion with the original math.
  return {ring,left,right,top,bottom,
    minP:Math.max(-ring,Math.floor(Math.min(...corners.map(c=>c.p)))-1),
    maxP:Math.min(ring,Math.ceil(Math.max(...corners.map(c=>c.p)))+1),
    minQ:Math.max(-ring,Math.floor(Math.min(...corners.map(c=>c.q)))-1),
    maxQ:Math.min(ring,Math.ceil(Math.max(...corners.map(c=>c.q)))+1)};
}

/** The bounded candidates, exported so work counts can be tested without timing thresholds. */
export function* provinceCandidates(view,size,maxRing) {
  const w=provinceWindow(view,size,maxRing);
  if (!w) return;
  for(let p=w.minP;p<=w.maxP;p++) {
    const lo=Math.max(w.minQ,-w.ring-p),hi=Math.min(w.maxQ,w.ring-p);
    for(let q=lo;q<=hi;q++) yield {p:p||0,q:q||0};
  }
}

// ringProvinces' original stable tie order, without its gameplay-only
// provinceFromIndex limit: the renderer also needs the outer cloud cells.
const ringOrder = ({p,q}) => {
  const d=ringOf(p,q);
  if (!d) return 0;
  const k=sextant(p,q);
  for(let i=0;i<k;i++) [p,q]=[p+q,-p];
  return 1+3*d*(d-1)+k*d+q;
};

/** Visible cells, nearest first; equal distances retain the original ring order. */
export function visibleProvinces(view,size,maxRing,quad=null) {
  const w=provinceWindow(view,size,maxRing);
  if (!w) return [];
  const out=[],m=PROVINCE_CIRCUMRADIUS;
  for(const pr of provinceCandidates(view,size,maxRing)) {
    const c=provincePixel(pr.p,pr.q);
    if(c.x>=w.left && c.x<=w.right && c.y>=w.top && c.y<=w.bottom && nearQuad(quad,c.x,c.y,m)) {
      out.push({...pr,dist:Math.hypot(c.x-view.x,c.y-view.y)});
    }
  }
  return out.sort((a,b)=>a.dist-b.dist || ringOrder(a)-ringOrder(b)).map(({p,q})=>({p,q}));
}
