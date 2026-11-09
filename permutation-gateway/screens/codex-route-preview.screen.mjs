// Original whole-page route preview, served on secure-context localhost with
// devWallet=off. No unsafe-origin flag, TLS certificate, real wallet, signed
// session, seal, send or guard self-test. See the accompanying audit document.
import { keyCalls } from './codex/no-key-node.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as NK from './ws07/nokey-page.mjs';
import { worldIdOf, WORLD_DOMAIN } from '../../permutation-server/web/frontier/map/wide.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';
import { encode as toB58, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';

// Imported only after the built-in guard above. The audited 1.58.2 launch path
// creates no certificate: no proxy, clientCertificates or remote browser.
const { chromium } = await import('playwright-core');
assert.equal(JSON.parse(readFileSync(new URL('./node_modules/playwright-core/package.json', import.meta.url))).version, '1.58.2');
assert.equal(process.env.SELENIUM_REMOTE_URL, undefined, 'use only the local Chromium runner');
const WEB = resolve(fileURLToPath(new URL('../../permutation-server/web/', import.meta.url)));
const GOLDEN = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1.json', import.meta.url)));
const PAL = JSON.parse(readFileSync(new URL('../../frontier-node/crates/herald/tests/golden/ws19-map-growth-s1-palisade.json', import.meta.url)));
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const HOST = { p: 4, q: 0, tile: 0 }, TARGET = { p: 5, q: 0, tile: 0 };
const CITY = { p:4, q:0, tile:43 }; // canonical site11, beyond this fixture's current sight
const AROUND = [5,0,0,1,0,1,1,0,1,1];

// UI-only observations: retain each immutable host-dispatch receipt payload,
// but rebind a COPY of its public identity to this page's existing season.
// These are deliberately not canonical chain records or authenticated captures.
// The separate Node regression reads the original binary vectors unchanged.
function widePresentation() {
  const s = GOLDEN.stages.grown['/h/season'].body;
  const world = worldIdOf(s.seasonAddress, s.programId), snapshot = 'ab'.repeat(32);
  const scope = {v:1,experimental:true,readOnly:true,sourceCoverage:'unknown',captureVerification:'unverified',
    world,season:s.season,seasonAddress:s.seasonAddress,program:s.programId,indexedThrough:'25',snapshot};
  const rows = ['harvest','building','wall','tier','train'].map(name => {
    const body = Buffer.from(readFileSync(new URL(`../../frontier-node/crates/verify/tests/fixtures/wide_economy/${name}/record.bin`,import.meta.url)));
    assert.ok(body[0]===0x82 && [15,16].includes(body[1]));
    Buffer.from(world,'hex').copy(body,7);
    const keyHex=body.subarray(6,62).toString('hex');
    const ring=body.readBigUInt64BE(39),wedge=body[47],pos=body.readBigUInt64BE(48);
    let p=ring-pos,q=pos;
    for(let i=0;i<wedge;i++) [p,q]=[-q,p+q];
    const province={world,p:String(p),q:String(q),keyHex:keyHex.slice(0,100)};
    const holding={...province,keyHex,site:body[56],generation:body[57],hostSequence:0};
    return {archiveSequence:'1',ordinal:'0',format:'PSW1',kind:body[1],name:body[1]===16?'WIDE_ECONOMY_MIRROR':'WIDE_ECONOMY',
      province,holding,host:null,body_b64:body.toString('base64')};
  });
  // Provisional Garrison presentation row only: explicitly synthetic receipt
  // and links, never claimed to be an authenticated host-dispatch vector.
  const garrison=Buffer.alloc(227),base=Buffer.from(rows[0].body_b64,'base64');
  garrison[0]=0x82;garrison[1]=17;garrison.writeUInt32LE(10,2);
  base.copy(garrison,6,6,62);
  garrison[62]=1;garrison.writeBigInt64LE(10n,63);garrison.writeBigInt64LE(1800433800n,71);
  garrison.fill(0x31,80,112);garrison.fill(0x32,112,144);
  garrison[144]=2;garrison[145]=1;garrison.writeBigUInt64LE(2n,146);
  garrison[186]=2;garrison.writeBigUInt64LE(3n,187);
  rows.push({...rows[0],kind:17,name:'WIDE_GARRISON',body_b64:garrison.toString('base64')});
  // A separately labelled synthetic map capture, not a live province. Copy
  // the unchanged host output and rebind public season/world identity only.
  const copy=name=>Buffer.from(readFileSync(new URL(`../../frontier-node/crates/verify/tests/fixtures/wide_economy/harvest/${name}_post.bin`,import.meta.url)));
  const pd=copy('province'),hd=copy('holding');
  assert.equal(pd.length,4864);assert.equal(pd.subarray(0,8).toString(),'PSFXWPV1');
  assert.equal(hd.length,1344);assert.equal(hd.subarray(0,8).toString(),'PSFXWHL1');
  pd.writeBigUInt64LE(BigInt(s.season),8);hd.writeBigUInt64LE(BigInt(s.season),8);
  Buffer.from(world,'hex').copy(pd,4740);Buffer.from(world,'hex').copy(hd,1288);
  const address=(tag,domain,key)=>{
    const seed=tag+Buffer.from(sha256(domain,key)).subarray(0,15).toString('hex');
    return toB58(sha256(fromB58(s.seasonAddress),seed,fromB58(s.programId)));
  };
  const capture=(bytes,address)=>({address,slot:'3001',archiveSequence:'1',postState:'transaction',verification:'captured-unverified',bytes_b64:bytes.toString('base64')});
  const provinceAddress=address('wp','PSF-WIDE-PROVINCE-SEED-v1',pd.subarray(4772,4789));
  const holdingAddress=address('wh','PSF-WIDE-HOLDING-SEED-v1',Buffer.concat([hd.subarray(1320,1337),hd.subarray(68,69)]));
  // Opt-in viewer inventory: copy the golden public Citizen, change only its
  // second inventory binding, and bind the copied capture to that public owner.
  // No wallet/session material is created; legacy holding bytes stay untouched.
  const me=structuredClone(GOLDEN.stages.grown[`/h/me/${GOLDEN.wallet}`]);
  const citizen=Buffer.from(me.body.citizen.bytes_b64,'base64');
  assert.equal(citizen.length,384);assert.equal(citizen.subarray(0,8).toString(),'PSF1CITZ');
  assert.equal(citizen[179],255,'golden slot two must start empty');
  citizen.fill(0,174,180);citizen[178]=12;citizen[138]=2;
  me.body.citizen.bytes_b64=citizen.toString('base64');
  const inventoryBytes=Buffer.from(hd);
  Buffer.from(fromB58(me.body.citizen.address)).copy(inventoryBytes,72);
  assert.equal(hd[1283],2);
  me.body.wideContext={v:1,readOnly:true,executable:false,verification:'captured-unverified',world,worldDomain:WORLD_DOMAIN,
    season:s.season,citizen:me.body.citizen.address,latestSlot:'3102',foldedThrough:'25',postState:'transaction',
    // The old golden's first ref has generation zero. The strict wide parser
    // calls that binding malformed; preserve the golden bytes and say so.
    inventory:['malformed','wide','empty'].map((binding,i)=>({inventorySlot:i+1,binding}))};
  me.body.wideHoldings=[{inventorySlot:2,status:'captured-unverified',holding:{
    world,p:'129',q:'0',ring:'129',site:hd[68],generation:hd[69],inventorySlot:2,season:s.season,
    ownerCitizen:me.body.citizen.address,hostIdentity:hd.readUInt16LE(1284),openTransits:hd[1286],capture:capture(inventoryBytes,holdingAddress)}}];
  // Exact coordinate outside Number's safe range, still a copied capture.
  // Only its public sort key/address changes; no Province is fabricated for it.
  const farMe=structuredClone(me),farBytes=Buffer.from(inventoryBytes),far=farMe.body.wideHoldings[0].holding;
  farBytes.writeBigUInt64BE(9007199254740993n,1320);
  far.p=far.ring='9007199254740993';
  far.capture=capture(farBytes,address('wh','PSF-WIDE-HOLDING-SEED-v1',Buffer.concat([farBytes.subarray(1320,1337),farBytes.subarray(68,69)])));
  const entry={p:'129',q:'0',ring:'129',wedge:0,pos:'0',state:'open',revision:'1',observedAt:'3001',legacy:null,
    wide:{world,p:'129',q:'0',openedBell:pd.readUInt32LE(76),region:pd[71],keepHolder:pd[4481],capture:capture(pd,provinceAddress),
      holdings:[{world,p:'129',q:'0',site:hd[68],generation:hd[69],inventorySlot:hd[1283],ownerCitizen:toB58(hd.subarray(72,104)),capture:capture(hd,holdingAddress)}]}};
  return {scope,rows,entry,me,farMe,
    manifest:{v:1,experimental:true,readOnly:true,completeness:'captured',world,worldDomain:WORLD_DOMAIN,
      season:s.season,seasonAddress:s.seasonAddress,program:s.programId,snapshot:{epoch:'1',stamp:snapshot,foldedThrough:'25',lastSlot:'3102'},recorded:1,refused:0,
      legacy:{rMax:5,rMaxHard:128,ringsOpened:6,provinces:0},page:{path:'/h/world/wide/page',max:256,default:64}}};
}

async function serve() {
  let obstacle = null, releaseOverviews;
  let held = true, active = 0, peak = 0;
  const overviewGate = new Promise(r => { releaseOverviews = r; });
  const wide=widePresentation();
  let historyMode='ready',historyGate=null,releaseHistory=null,captureMode='ready',inventoryMode='off';
  const requests = [], writes = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'),path=url.pathname;
    requests.push(path);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { writes.push(`${req.method} ${path}`); return json(405, { ok: false, code: 'ReadOnlyFixture' }); }
    if (/^\/h\/overview2?\//.test(path)) {
      active++; peak = Math.max(peak, active);
      res.once('close', () => { active--; });
      if (held) await overviewGate;
    }
    if (path.startsWith('/h/')) {
      if(path===`/h/me/${GOLDEN.wallet}` && inventoryMode!=='off') {
        const me=structuredClone(inventoryMode==='far'?wide.farMe:wide.me);
        if(inventoryMode==='malformed') me.body.wideHoldings[0].holding.capture.bytes_b64=Buffer.alloc(1344).toString('base64');
        if(inventoryMode==='source-changed') me.body.wideContext.world='cd'.repeat(32);
        return json(me.status,me.body);
      }
      if(path==='/h/world/wide') return json(200,{...wide.manifest,recorded:captureMode==='missing'?0:1});
      if(path==='/h/world/wide/page') {
        const entry=structuredClone(wide.entry);
        if(captureMode==='malformed') entry.wide.capture.bytes_b64=Buffer.alloc(4864).toString('base64');
        return json(200,{v:1,world:wide.scope.world,snapshot:wide.manifest.snapshot,after:null,entries:captureMode==='missing'?[]:[entry],next:null});
      }
      if(path==='/h/wide-index/status') return json(200,{...wide.scope,state:'observed',caughtUp:true,automaticWrites:false});
      if(path==='/h/wide-index/events') {
        const mode=historyMode,after=Number(url.searchParams.get('after')),limit=Number(url.searchParams.get('limit'));
        if(url.searchParams.get('through')!==wide.scope.indexedThrough||url.searchParams.get('snapshot')!==wide.scope.snapshot||limit!==20||![0,20].includes(after)) return json(400,{code:'WrongHistoryRequest'});
        if(historyGate) await historyGate;
        const events=Array.from({length:Math.min(limit,25-after)},(_,i)=>({...wide.rows[(after+i)%wide.rows.length],event:String(after+i+1),archiveSequence:String(after+i+1)}));
        if(mode==='malformed') events[0]={...events[0],host:events[0].holding};
        return json(200,{...wide.scope,after:String(after),limit,events,next:String(after+events.length),more:after===0});
      }
      let a = GOLDEN.stages.grown[path];
      if (path === '/h/structures.json' && obstacle !== null) {
        a = structuredClone(PAL.stages.palisade[path]);
        a.body.structures[0].tile = obstacle;
      }
      if (!a) return json(404, { ok: false, code: 'NotFound' });
      if (a.body?.b64 !== undefined) { res.writeHead(a.status, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }); return res.end(Buffer.from(a.body.b64, 'base64')); }
      return json(a.status, a.body);
    }
    if (path === '/gw/f/prize') return json(404, { ok: false, code: 'NoPrizePool' });
    if (path === '/gw/f/quota') return json(200, { ok: true, left: 38 });
    if (path === '/coop/config' || path === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (path.startsWith('/gw/')) return json(404, { ok: false, code: 'NotFound' });
    const full = resolve(WEB, `.${decodeURIComponent(path)}`);
    if (!full.startsWith(WEB + sep)) return json(403, { ok: false, code: 'Forbidden' });
    try {
      const body = await readFile(full);
      const headers = { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
      if (extname(full) === '.html') headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'self'; frame-ancestors 'none'";
      res.writeHead(200, headers); res.end(body);
    } catch { json(404, { ok: false, code: 'NotFound' }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, requests, writes, obstacle: v => { obstacle = v; },
    history: mode => {historyMode=mode;}, holdHistory:()=>{historyGate=new Promise(r=>{releaseHistory=r;});},
    capture: mode=>{captureMode=mode;},
    inventory: mode=>{inventoryMode=mode;},
    releaseHistory:()=>{releaseHistory?.();historyGate=null;},
    overviewStats: () => ({active,peak,held}), release: () => { held = false; releaseOverviews(); },
    close: () => new Promise(r => { held = false; releaseOverviews(); releaseHistory?.(); server.closeAllConnections(); server.close(r); }) };
}

const snapshot = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const { subjectOf } = await import('/frontier/hud/hand.mjs');
  const s = subjectOf(FS), m = window.__wyllsMap;
  const hover = m?.source().hoverRoute;
  return { who: s?.kind === 'host' ? String(s.host.id) : s?.kind, selected: FS.selected, note: FS.mapNote?.text,
    compose: FS.compose ? { dest: FS.compose.dest, dirs: FS.compose.route?.dirs, secs: FS.compose.route?.secs, error: FS.compose.routeError, bell: FS.compose.arriveBell } : null,
    hover: hover ? { key: hover.key, hexes: hover.hexes, bell: hover.arriveBell } : null,
    structures: FS.s1?.structures?.structures, nowBell: FS.nowBell, chainBell: FS.clock ? Math.floor((FS.chain.now()-FS.clock.genesisTs)/600) : null, session: !!FS.session, kernelError: FS.kernelError };
});
async function point(page, at) {
  return page.evaluate(async at => {
    const m = window.__wyllsMap, { tileHex } = await import('/frontier/fgeo.mjs'), { project } = await import('/map.mjs');
    const h = tileHex(at.p, at.q, at.tile), p = project(h.q, h.r);
    return m.project(p.x, p.y);
  }, at);
}
async function bring(page, at, width) {
  for (let i = 0; i < 18; i++) {
    await page.waitForFunction(()=>!window.__wyllsMap.cam.moving);
    await page.waitForTimeout(100);
    if(await page.evaluate(()=>window.__wyllsMap.cam.moving)) continue;
    const p = await point(page, at);
    const box = await page.evaluate(() => ({
      top: 40 + Math.max(150, ...[...document.querySelectorAll('.banner.error')].map(e => e.getBoundingClientRect()).filter(r => r.height).map(r => r.bottom)),
      bottom: Math.min(innerHeight, ...['hand','panel'].map(id => document.getElementById(id)).filter(e => e && !e.hidden).map(e => e.getBoundingClientRect()).filter(r => r.height && r.width > innerWidth * 0.6).map(r => r.top)) - 40,
    }));
    if (p.x > 40 && p.x < width - 40 && p.y > box.top && p.y < box.bottom) return p;
    await page.locator('#frontier-map').focus();
    const key = p.x >= width - 40 ? 'ArrowRight' : p.x <= 40 ? 'ArrowLeft' : p.y <= box.top ? 'ArrowUp' : 'ArrowDown';
    for (let k = 0; k < 3; k++) await page.keyboard.press(key);
    await page.waitForTimeout(350);
  }
  throw new Error(`tile not visible: ${JSON.stringify(await snapshot(page))}`);
}

// Use the real recorded-world button, client, parser and sheet on the original
// player page. No controller/source replacement and no write or action review.
async function wideEconomy(page,srv,vp,outDir) {
  const press=loc=>vp.width<760?loc.tap():loc.click();
  const toggle=page.locator('[data-map="wide"]'),sheet=page.locator('#wide-world');
  const rows=page.locator('#wide-history-list > li');
  const ready=async n=>page.waitForFunction(n=>document.querySelectorAll('#wide-history-list > li').length===n,n);
  const open=async()=>{await press(toggle);await sheet.waitFor({state:'visible'});};
  const close=async()=>{await press(page.locator('#wide-close'));await sheet.waitFor({state:'hidden'});};
  await open();await ready(20);
  assert.match(await sheet.textContent(),/読み取り専用/);
  assert.match(await page.locator('#wide-status').textContent(),/記録 1 州/);
  const province=page.locator('#wide-list .wide-row[data-p="129"][data-q="0"]');
  await press(province);
  assert.match(await page.locator('#wide-selected').textContent(),/P 129, Q 0/);
  assert.match(await province.textContent(),/保有地 1 件/);
  await press(page.locator('#wide-recentre'));
  assert.equal(await page.locator('#wide-origin').textContent(),'P 129, Q 0');
  assert.match(await page.locator('#wide-history-status').textContent(),/土地やプレイ可能状態は示しません/);
  const first=await rows.allTextContents();
  for(const word of ['収穫','建設','訓練','WIDE_ECONOMY_MIRROR','WIDE_GARRISON']) assert.ok(first.some(x=>x.includes(word)),word);
  assert.ok(first.some(x=>x.includes('WIDE_GARRISON') && /10/.test(x) && x.includes('追加予約')),'garrison history describes queued troops, not an active defence');
  assert.equal(await rows.locator('button').count(),0,'a holding receipt is never a host action');
  assert.equal(await page.locator('#wide-action-review').textContent(),'');
  const layout=await sheet.evaluate(s=>{
    const close=s.querySelector('#wide-close'),r=close.getBoundingClientRect(),side=s.querySelector('.wide-side').getBoundingClientRect();
    const style=getComputedStyle(s),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return {closeUncovered:close.contains(hit),background:style.backgroundColor,color:style.color,sideHeight:side.height,width:s.getBoundingClientRect().width};
  });
  assert.equal(layout.closeUncovered,true,'the ordinary drawer cannot cover the Close control');
  assert.deepEqual([layout.background,layout.color],['rgb(16, 34, 31)','rgb(244, 239, 224)'],'readable ink on opaque metal');
  assert.ok(layout.sideHeight>140,'history retains a usable scroll area');
  assert.ok(layout.width<=vp.width,'no horizontal overflow');
  await rows.first().scrollIntoViewIfNeeded();
  await page.screenshot({path:`${outDir}/${vp.name}-wide-economy.png`});
  await press(page.locator('#wide-history-next'));await ready(5);
  assert.match(await rows.first().textContent(),/^21 WIDE_ECONOMY/);
  assert.equal(await page.locator('#wide-history-next').isDisabled(),true);
  await close();await open();await ready(20);
  assert.match(await rows.first().textContent(),/^1 WIDE_ECONOMY/,'reopen starts a fresh pinned page');
  await close();

  // An in-flight stale response may not populate a closed or newer sheet.
  srv.holdHistory();srv.history('ready');
  const count=srv.requests.filter(p=>p==='/h/wide-index/events').length;
  await open();
  await page.waitForFunction(()=>document.getElementById('wide-history-status').textContent.includes('履歴を読み込んでいます'));
  for(let i=0;i<50&&srv.requests.filter(p=>p==='/h/wide-index/events').length===count;i++) await page.waitForTimeout(20);
  assert.ok(srv.requests.filter(p=>p==='/h/wide-index/events').length>count);
  await close();srv.history('malformed');srv.releaseHistory();await open();
  await page.waitForFunction(()=>document.getElementById('wide-history-status').textContent.includes('BadWideHistory'));
  assert.equal(await rows.count(),0,'malformed current history cannot inherit an older page');
  assert.match(await page.locator('#wide-history-status').textContent(),/空の履歴という意味ではありません/);
  assert.equal(await page.locator('#wide-history-next').isDisabled(),true);
  await close();srv.history('ready');await open();await ready(20);
  await close();
  srv.capture('malformed');await open();
  await page.waitForFunction(()=>document.getElementById('wide-status').textContent.includes('BadWideCapture'));
  assert.equal(await page.locator('#wide-list .wide-row').count(),0,'contradictory raw bytes cannot leave previous land visible');
  assert.equal(await rows.count(),0,'invalid capture source does not retain history');
  await close();srv.capture('ready');await open();await ready(20);
  assert.equal(await province.count(),1);await close();
  assert.equal((await snapshot(page)).session,false);
  assert.equal(await page.evaluate(async()=>(await import('/frontier/fstate.mjs')).FS.world.ringsOpen),6);
  console.log(JSON.stringify({viewport:vp.name,wideEconomy:{presentationOnly:true,canonicalWorldUnchanged:true,pageRows:[20,5],actions:0,reopen:true,abortedStaleResponse:true,malformedRejected:true,capture129Navigated:true,contradictoryCaptureRejected:true}}));
}

// The actual player rail -> captured village -> recorded map path. Only the
// fixture's GET replies change: no replacement FS.world, camera, controller,
// wallet, clock or source. Capture/inventory mutations are synthetic UI cases.
async function wideVillageNavigation(page,srv,vp,outDir) {
  const press=loc=>vp.width<760?loc.tap():loc.click();
  const pip=page.locator('[data-act="wide-select"][data-slot="2"]:visible');
  const map=page.locator('[data-act="wide-map"]:visible'),sheet=page.locator('#wide-world');
  const refresh=()=>page.evaluate(async()=>{await (await import('/frontier/controller.mjs')).refresh();});
  const state=()=>page.evaluate(async()=>{
    const {FS}=await import('/frontier/fstate.mjs');
    return {rings:FS.world.ringsOpen,holdings:FS.holdings.map(h=>[h.p,h.q,h.site]),
      wideStatus:FS.wideStatus,selected:FS.wideSelect?.inventorySlot??null,session:!!FS.session,compose:!!FS.compose};
  });
  const before=await state();
  const card=async(p='129')=>{
    // Phone pips live in the resting sheet, not the desktop rail. Close the
    // current drawer through its normal control before selecting that pip.
    if(vp.width<760 && !await pip.isVisible()) {
      const drawerClose=page.locator('#panel [data-act="drawer-close"]:visible');
      if(await drawerClose.count()) await press(drawerClose);
    }
    await press(pip);
    if(vp.width<760 && await page.locator('#panel').getAttribute('data-sheet')==='peek') await page.locator('#panel [data-sheet-handle]').tap();
    await map.waitFor({state:'visible'});
    assert.ok((await page.locator('#panel').textContent()).includes(`P ${p}, Q 0`));
    assert.match(await page.locator('#panel').textContent(),/捕捉・未検証/);
    assert.match(await map.textContent(),/読み取り専用/);
  };
  const open=async()=>{await press(map);await sheet.waitFor({state:'visible'});};
  const close=async()=>{await press(page.locator('#wide-close'));await sheet.waitFor({state:'hidden'});};
  const focused=()=>page.waitForFunction(()=>document.getElementById('wide-origin').textContent==='P 129, Q 0' && document.querySelectorAll('#wide-list .wide-row').length===1);
  srv.inventory('ready');await refresh();
  assert.equal((await state()).wideStatus,'ready','synthetic captured inventory passes the real parser');
  for(let repeat=0;repeat<2;repeat++) {
    await card();await open();await focused();
    assert.match(await page.locator('#wide-selected').textContent(),/P 129, Q 0/);
    assert.doesNotMatch(await page.locator('#wide-selected').textContent(),/不明/);
    assert.equal(await page.locator('#wide-list .wide-row[data-p="129"][data-q="0"]').count(),1);
    assert.equal(await page.locator('#wide-action-review').textContent(),'');
    await refresh();await focused();
    assert.match(await page.locator('#wide-selected').textContent(),/P 129, Q 0/,'equivalent refreshed inventory preserves focus');
    await page.screenshot({path:`${outDir}/${vp.name}-wide-village-map.png`});
    await close();
  }
  // The inventory capture alone must never invent a captured Province.
  srv.capture('missing');await card();await open();
  await page.waitForFunction(()=>document.getElementById('wide-selected').textContent.includes('不明'));
  assert.equal(await page.locator('#wide-origin').textContent(),'P 129, Q 0');
  assert.match(await page.locator('#wide-selected').textContent(),/P 129, Q 0.*不明/);
  assert.equal(await page.locator('#wide-list .wide-row').count(),0);
  await page.screenshot({path:`${outDir}/${vp.name}-wide-village-unknown.png`});await close();
  srv.inventory('far');await refresh();await card('9007199254740993');await open();
  await page.waitForFunction(()=>document.getElementById('wide-selected').textContent.includes('不明'));
  assert.equal(await page.locator('#wide-origin').textContent(),'P 9007199254740993, Q 0');
  assert.match(await page.locator('#wide-selected').textContent(),/P 9007199254740993, Q 0.*不明/);
  assert.equal(await page.locator('#wide-list .wide-row').count(),0);
  await page.screenshot({path:`${outDir}/${vp.name}-wide-village-exact-far.png`});await close();
  srv.inventory('ready');await refresh();
  srv.capture('malformed');await card();await open();
  await page.waitForFunction(()=>document.getElementById('wide-status').textContent.includes('BadWideCapture'));
  assert.equal(await page.locator('#wide-list .wide-row').count(),0);
  await close();srv.capture('ready');
  // Inventory changes flow through the normal controller refresh. A refused
  // reply cannot retain the old village or its navigation button.
  for(const mode of ['malformed','source-changed']) {
    srv.inventory('ready');await refresh();await card();await open();await focused();
    srv.inventory(mode);await refresh();
    await page.waitForFunction(async()=>!(await import('/frontier/fstate.mjs')).FS.wideSelect);
    await map.waitFor({state:'hidden'});await pip.waitFor({state:'hidden'});
    assert.equal(await map.count(),0);assert.equal(await pip.count(),0);
    assert.equal(await page.locator('#panel .wide-village').count(),0);
    assert.equal((await state()).wideStatus,'error');
    await page.waitForFunction(()=>document.getElementById('wide-status').textContent.includes('WideSelectionChanged'));
    assert.equal(await page.locator('#wide-list .wide-row').count(),0);
    assert.doesNotMatch(await page.locator('#wide-selected').textContent(),/129/);
    assert.equal(await page.locator('#wide-history-list > li').count(),0);
    await close();
  }
  srv.inventory('ready');await refresh();await card();await open();await focused();await close();
  await press(page.locator('[data-act="wide-close"]:visible'));
  assert.equal((await state()).selected,null,'return restores legacy village');
  srv.inventory('off');await refresh();
  const after=await state();
  assert.deepEqual(after.holdings,before.holdings,'legacy holdings remain unchanged');
  assert.equal(after.rings,before.rings);assert.equal(after.rings,6);
  assert.equal(after.session,false);assert.equal(after.compose,false);
  console.log(JSON.stringify({viewport:vp.name,wideVillageNavigation:{pip:'W2',exactCoordinates:[['129','0'],['9007199254740993','0']],repeated:true,equivalentRefreshPreservesFocus:true,unknownNotLand:true,malformedCaptureRejected:true,malformedInventoryCleared:true,changedWorldCleared:true,canonicalWorldUnchanged:true}}));
}

// Max-supported-radius renderer stress on the original page. Only the map's
// supplied presentation source is expanded; FS.world, actual herald records,
// clock, wallet and controller state stay at the canonical six-ring fixture.
// This is not a chain-growth or wide-gameplay claim. Every callback remains
// the original audited read-only presentation path; no new kernel export.
async function largeChart(page, vp, outDir) {
  await page.locator('#panel [data-act="drawer-close"]').click();
  await page.waitForFunction(()=>!window.__wyllsMap.cam.moving);
  await page.evaluate(async()=>{
    const m=window.__wyllsMap,{ringProvinces}=await import('/frontier/fgeo.mjs');
    const {buildSurvey}=await import('/frontier/map/survey.mjs');
    const source=m.source, original=source(), overviews=new Map(), sites=Array(12).fill(0), owners=Array(12).fill(255);
    for(let d=0;d<=128;d++) overviews.set(d,{ok:true,ring:d,bell:0,provinces:ringProvinces(d).map(pr=>({...pr,sites,owners,control:d%6,keepTile:d>=2?30:null,keepTroops:0,contender:null,contestProgress:0,contestRequired:72,heartland:false}))});
    // Preserve canonical home/keep data at its real coordinates.
    for(const [d,ov] of original.overviews) overviews.set(d,ov);
    const metrics={terrain:0,province:0,frames:[],fillMs:0,strokeMs:0,backdropMs:0,keepFrameMs:0}, draw=m.draw;
    const restore=[];
    const time=(object,key,total)=>{const original=object[key];object[key]=function(...a){const t=performance.now();try{return original.apply(this,a);}finally{metrics[total]+=performance.now()-t;}};restore.push(()=>{object[key]=original;});};
    time(CanvasRenderingContext2D.prototype,'fill','fillMs');
    time(CanvasRenderingContext2D.prototype,'stroke','strokeMs');
    time(m,'backdrop','backdropMs');time(m.keeps,'frame','keepFrameMs');
    const sv=buildSurvey({ringsOpen:129,showAll:true});
    window.__largeChart={source,draw,metrics,restore,originalView:{...m.view},worldRings:(await import('/frontier/fstate.mjs')).FS.world.ringsOpen};
    m.source=()=>({...source(),ringsOpen:129,rMax:128,rMaxCeiling:128,overviews,survey:sv,
      terrainOf:(...a)=>{metrics.terrain++;return original.terrainOf?.(...a);},
      provinceOf:(...a)=>{metrics.province++;return original.provinceOf?.(...a);}});
    m.draw=function(...a){const t=performance.now();const result=draw.apply(this,a);if(!this.cam.moving&&this.lod==='world') metrics.frames.push(performance.now()-t);return result;};
    m.invalidate();
  });
  await page.waitForFunction(()=>window.__wyllsMap.rings===129);
  await page.locator('#frontier-map').focus();
  await page.keyboard.press('m');
  await page.waitForFunction(()=>window.__wyllsMap.chartOn()&&!window.__wyllsMap.cam.moving,null,{timeout:30000});
  const check=async()=>page.evaluate(async()=>{
    const m=window.__wyllsMap,{landBox,freeBox}=await import('/frontier/map/camera.mjs');
    const b=landBox(129),s=m.size(),f=freeBox(s,m.inset()),v=m.view;
    const {provincePixel}=await import('/frontier/map/layers.mjs');
    const {pick}=await import('/frontier/map/fmap.mjs');
    const c=provincePixel(125,-40),p=m.project(c.x,c.y,{box:true});
    const picked=pick(v,s,p.x,p.y);
    return {zoom:v.zoom,min:m.zoomMin(),lod:m.lod,chart:m.chartOn(),
      fitsX:2*b.x*v.zoom<=f.width*.7+1e-7,fitsY:2*b.y*v.zoom<=f.height*.7+1e-7,
      picked:[picked.p,picked.q],worldRings:(await import('/frontier/fstate.mjs')).FS.world.ringsOpen};
  });
  let result=await check();
  assert.ok(result.zoom<.02);assert.ok(result.min<result.zoom);assert.equal(result.lod,'world');
  assert.ok(result.fitsX&&result.fitsY);assert.deepEqual(result.picked,[125,-40]);assert.equal(result.worldRings,6);
  await page.evaluate(()=>{const x=window.__largeChart;x.metrics.terrain=0;x.metrics.province=0;x.metrics.frames=[];x.metrics.fillMs=0;x.metrics.strokeMs=0;x.metrics.backdropMs=0;x.metrics.keepFrameMs=0;});
  for(let i=0;i<8;i++) await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>{window.__wyllsMap.draw();r();})));
  const measured=await page.evaluate(()=>window.__largeChart.metrics);
  assert.equal(measured.province,0,'coarse chart does not hydrate provinces');
  // Existing own markers can read their small original local terrain set.
  assert.ok(measured.terrain<100,'no whole-world terrain generation');
  await page.screenshot({path:`${outDir}/${vp.name}-radius128-chart.png`});
  await page.keyboard.press('m');
  await page.waitForFunction(()=>!window.__wyllsMap.cam.moving);
  const returned=await page.evaluate(()=>({view:window.__wyllsMap.view,want:window.__largeChart.originalView,back:window.__wyllsMap.back}));
  assert.deepEqual(returned.view,returned.want);assert.equal(returned.back,null);
  // A real viewport resize uses the original canvas observer and camera fit.
  await page.setViewportSize({width:vp.width===390?320:1180,height:vp.height===844?568:760});
  await page.locator('#frontier-map').focus();await page.keyboard.press('m');
  await page.waitForFunction(()=>window.__wyllsMap.chartOn()&&!window.__wyllsMap.cam.moving);
  const resized=await check();assert.ok(resized.fitsX&&resized.fitsY);assert.deepEqual(resized.picked,[125,-40]);
  await page.keyboard.press('m');await page.waitForFunction(()=>!window.__wyllsMap.cam.moving);
  await page.evaluate(()=>{const m=window.__wyllsMap,x=window.__largeChart;m.source=x.source;m.draw=x.draw;x.restore.forEach(f=>f());m.invalidate();});
  await page.setViewportSize({width:vp.width,height:vp.height});
  await page.waitForFunction(()=>window.__wyllsMap.rings===6);
  const times=measured.frames.sort((a,b)=>a-b);
  const report={syntheticRadius:128,canonicalWorldUnchanged:true,view:result,resized,
    samples:times.length,drawMedianMs:times[Math.floor(times.length/2)],drawMaxMs:times.at(-1),terrainCalls:measured.terrain,provinceCalls:measured.province,totals:{fillMs:measured.fillMs,strokeMs:measured.strokeMs,backdropMs:measured.backdropMs,keepFrameMs:measured.keepFrameMs}};
  console.log(JSON.stringify({viewport:vp.name,largeChart:report}));
  await writeFile(`${outDir}/${vp.name}-large-chart.json`,JSON.stringify(report,null,2));
}

for (const vp of [{width:1440,height:900,name:'desktop'}, {width:390,height:844,name:'phone'}]) {
  test(`original map route preview @ ${vp.name}`, { timeout: 180_000 }, async () => {
    const srv = await serve();
    const phone = vp.width < 760;
    const errors = [], requests = [], failures = [];
    const outDir = process.env.WYLLS_SCREEN_OUT ?? '/tmp/wylls-route-preview-20261108';
    let browser, ctx, page;
    try {
      browser = await chromium.launch({ channel:'chromium', chromiumSandbox:true });
      ctx = await browser.newContext({ viewport: {width:vp.width,height:vp.height}, isMobile:phone, hasTouch:phone, locale:'ja-JP', timezoneId:'UTC', serviceWorkers:'block' });
      await mkdir(outDir, { recursive:true });
      await NK.prepare(ctx, { wallet:GOLDEN.wallet }, { lang:'ja' });
      // Do not allow an accidentally imported inline sealing fallback either.
      await ctx.route('**/seal-worker.mjs', route => route.abort('blockedbyclient'));
      page = await ctx.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => requests.push({ method:r.method(),url:r.url() }));
      page.on('requestfailed', r => failures.push({ url:r.url(),reason:r.failure()?.errorText }));
      await page.clock.setFixedTime(new Date(Number(GOLDEN.stages.grown['/h/season'].body.latestUnix)*1000+500));
      const url = `${srv.base}/frontier/index.html?devWallet=off&at=4,0,0,${phone?'0.55':'1.0'}`;
      await page.goto(url);
      // Keep all summary responses pending. Viewer identity must still start:
      // previously boot awaited every ring before calling startPlay at all.
      await page.waitForFunction(async()=>{
        const {FS}=await import('/frontier/fstate.mjs');
        return FS.meStatus==='ready' && FS.holdings.length>0;
      },null,{timeout:30000});
      assert.equal(srv.overviewStats().held,true);
      assert.ok(srv.overviewStats().active>0);
      assert.ok(srv.overviewStats().peak<=4,'boot/controller share one request bound');
      assert.equal(await page.evaluate(async()=>(await import('/frontier/fstate.mjs')).FS.overviews.size),0);
      console.log(JSON.stringify({viewport:vp.name,viewerReadyWhileOverviewBlocked:true,overviews:srv.overviewStats()}));
      srv.release();
      await page.waitForFunction(async () => { const {FS}=await import('/frontier/fstate.mjs'); return FS.playReady && FS.meStatus==='ready' && FS.holdings.length && !!FS.kernel && !!FS.s1?.structures; }, null, { timeout:30000 });
      assert.equal(await page.evaluate(() => isSecureContext && !!crypto.subtle), true, 'native secure localhost, no insecure-origin override');
      assert.equal((await snapshot(page)).session, false);
      await page.evaluate(async () => {
        const { Kernel } = await import('/frontier/wasm.mjs');
        const call = Kernel.prototype.call;
        window.__plans = [];
        Kernel.prototype.call = function(name,args) { const t=performance.now(); const value=call.call(this,name,args); if(name==='plan_path') window.__plans.push({ms:performance.now()-t,blocked:args.blocked,dirs:value.value?.dirs}); return value; };
      });
      const tap = async at => { const p=await bring(page,at,vp.width); if(phone) await page.touchscreen.tap(p.x,p.y); else await page.mouse.click(p.x,p.y); await page.waitForTimeout(400); };
      const selectHost = async () => { for(let i=0;i<4 && (await snapshot(page)).who!==String(GOLDEN.host);i++) await tap(HOST); assert.equal((await snapshot(page)).who,String(GOLDEN.host)); };
      await selectHost();
      if (!phone) {
        const p=await bring(page,TARGET,vp.width); await page.mouse.move(p.x,p.y);
        await page.waitForFunction(() => window.__wyllsMap.source().hoverRoute?.hexes.length > 0);
        const initial=await snapshot(page);
        assert.equal(initial.hover.key,`${GOLDEN.host}|41,-20`,'hover is the intended target, not a passing camera tile');
        srv.obstacle(6);
        await page.evaluate(async()=>{await (await import('/frontier/controller.mjs')).refresh();});
        const blocked=await snapshot(page);
        assert.notDeepEqual(blocked.hover.hexes,initial.hover.hexes,'stationary hover avoids new palisade');
        assert.equal(blocked.hover.hexes.some(h=>h.q===33&&h.r===-16),false);
        srv.obstacle(5); // same count, different first step: (33,-17)
        await page.evaluate(async()=>{await (await import('/frontier/controller.mjs')).refresh();});
        const moved=await snapshot(page);
        assert.notDeepEqual(moved.hover.hexes,blocked.hover.hexes,'stationary hover follows same-count obstacle movement');
        assert.equal(moved.hover.hexes.some(h=>h.q===33&&h.r===-17),false);
        const perf=await page.evaluate(async()=>{
          const m=window.__wyllsMap, times=[], before=window.__plans.length;
          for(let i=0;i<120;i++){await new Promise(r=>requestAnimationFrame(r)); const t=performance.now(); m.source(); times.push(performance.now()-t); m.tick();}
          times.sort((a,b)=>a-b);
          return {sourceMedianMs:times[60],sourceP95Ms:times[114],sourceMaxMs:times[119],extraPlans:window.__plans.length-before,samples:times.length};
        });
        assert.equal(perf.extraPlans,0,'stationary redraws reuse geometry');
        console.log(JSON.stringify({viewport:vp.name,performance:perf}));
        await writeFile(`${outDir}/${vp.name}-performance.json`,JSON.stringify(perf,null,2));
        // Advance only the wall-clock Date, not timers or a turn boundary.
        // ChainClock's audited rate is one and the fixture starts 102 seconds
        // into turn zero, so +350 stays in the same turn (no auto-nudge path).
        const plansBeforeClock=await page.evaluate(async()=>{
          const {FS}=await import('/frontier/fstate.mjs');
          if(FS.chain.rate!==1) throw new Error('clock test requires the audited one-timescale fixture');
          return window.__plans.length;
        });
        await page.clock.setFixedTime(new Date(Number(GOLDEN.stages.grown['/h/season'].body.latestUnix)*1000+350500));
        const later=await snapshot(page);
        assert.equal(later.nowBell,0,'displayed turn remains unchanged');
        assert.equal(later.chainBell,0,'actual chain clock stays within the original turn');
        assert.deepEqual(later.hover.hexes,moved.hover.hexes,'wall time does not change route geometry');
        assert.ok(later.hover.bell>moved.hover.bell,'arrival updates within the same turn without a pointer event');
        assert.equal(await page.evaluate(()=>window.__plans.length),plansBeforeClock,'clock update reuses planned geometry');
      }
      srv.obstacle(6);
      await page.evaluate(async()=>{await (await import('/frontier/controller.mjs')).refresh();});
      await selectHost();
      // Read the original inspector, not the keep tile (which would compose
      // a march with this host in hand). hand-info and drawer-close only
      // change UI state; refreshConquest supplies the read-only history.
      for(let repeat=0;repeat<2;repeat++) {
        const info=page.locator('#hand [data-act="hand-info"]');
        if(phone) await info.tap(); else await info.click();
        // The real phone inspector starts as a small sheet; its read-only
        // handle expands it before the keep details become visible.
        if(phone && await page.locator('#panel').getAttribute('data-sheet')==='peek') await page.locator('#panel [data-sheet-handle]').tap();
        const keep=page.locator('#panel .conquest-keep.kp');
        await keep.waitFor();
        assert.equal(await keep.getAttribute('aria-label'),'この州の砦 · マス 2');
        assert.equal((await keep.locator('.kp-def .num').textContent()).trim(),'100');
        assert.match(await keep.locator('.kp-holder').textContent(),/アステルが保持/);
        await page.waitForFunction(async()=>!!(await import('/frontier/fstate.mjs')).FS.conquest?.history?.get('4,0')?.holders);
        const details=await page.evaluate(async()=>{
          const {FS}=await import('/frontier/fstate.mjs'),h=FS.conquest.history.get('4,0');
          return {selected:[FS.selected.p,FS.selected.q],inspect:FS.inspectOpen,compose:FS.compose,session:!!FS.session,
            keep:{holder:h.holder,tile:h.tile,troops:h.troops,holders:h.holders,captures:h.captures,contests:h.contests}};
        });
        assert.deepEqual(details,{selected:[4,0],inspect:true,compose:null,session:false,
          keep:{holder:0,tile:1,troops:100,holders:[{holder:0,since:0}],captures:[],contests:[]}});
        await keep.locator('.kp-history .kp-h-held').waitFor();
        await keep.scrollIntoViewIfNeeded();
        await page.screenshot({path:`${outDir}/${vp.name}-keep-panel.png`});
        const close=page.locator('#panel [data-act="drawer-close"]');
        if(phone) await close.tap(); else await close.click();
        await page.waitForFunction(async()=>!(await import('/frontier/fstate.mjs')).FS.inspectOpen);
        await keep.waitFor({state:'hidden'});
      }
      for(let repeat=0;repeat<2;repeat++) {
        await selectHost(); await tap(TARGET);
        if ((await snapshot(page)).note==='ルールを読み込んでいます') { await page.waitForTimeout(700); await tap(TARGET); }
        await page.waitForFunction(async()=>!!(await import('/frontier/fstate.mjs')).FS.compose?.route);
        const s=await snapshot(page);
        assert.deepEqual(s.compose.dirs,AROUND,'actual S1 order card takes the pinned detour');
        assert.equal(s.compose.secs,1320);
        await page.locator('[data-act="march-send"]:not([disabled])').waitFor();
        await page.screenshot({path:`${outDir}/${vp.name}-palisade-order.png`});
        const close=page.locator('[data-act="compose-close"]:visible').first();
        if(phone) await close.tap(); else await close.click();
        await page.waitForFunction(async()=>!(await import('/frontier/fstate.mjs')).FS.compose);
      }
      // The real Free City is outside this player's sight. Fetching the
      // Province must not expose its identity, defenders or attack action.
      await selectHost();
      const release=page.locator('#hand [data-act="hand-close"]');
      if(phone) await release.tap(); else await release.click();
      await tap(CITY);
      if(phone && await page.locator('#panel').getAttribute('data-sheet')==='peek') await page.locator('#panel [data-sheet-handle]').tap();
      const hiddenCity=await page.evaluate(async()=>{
        const {FS}=await import('/frontier/fstate.mjs'),{inspectModel}=await import('/frontier/hud/inspect.mjs'),{tileName}=await import('/frontier/hud/place.mjs');
        const m=inspectModel(FS,FS.terrainOf),pv=FS.provinces.get('4,0').province;
        return {selected:[FS.selected.p,FS.selected.q,FS.selected.idx],level:FS.survey.levelOf(4,0,43),
          canonicalState:pv.siteMirror[11].state,canonicalGarrison:pv.siteMirror[11].garrison,
          site:m.tile.site,name:tileName(FS,4,0,43),session:!!FS.session};
      });
      assert.deepEqual(hiddenCity.selected,[4,0,43]);
      assert.deepEqual([hiddenCity.canonicalState,hiddenCity.canonicalGarrison],[5,300000]);
      assert.equal(hiddenCity.level,1,'own village and host cannot see the city');
      assert.equal(hiddenCity.site,null,'inspector preserves fog');
      assert.notEqual(hiddenCity.name,'自由都市','destination naming preserves fog');
      assert.equal(hiddenCity.session,false);
      assert.doesNotMatch(await page.locator('#panel').textContent(),/守備隊 300|自由都市/);
      await page.screenshot({path:`${outDir}/${vp.name}-free-city-fog.png`});
      const cityClose=page.locator('#panel [data-act="drawer-close"]');
      if(phone) await cityClose.tap(); else await cityClose.click();
      await selectHost();
      const cityAction=await page.evaluate(async()=>{
        const {tileHex}=await import('/frontier/fgeo.mjs'),h=tileHex(4,0,43),a=window.__wyllsMap.source().actions;
        const {FS}=await import('/frontier/fstate.mjs'),{kindOf}=await import('/frontier/map/actions.mjs');
        return {marker:a?.byHex.get(`${h.q},${h.r}`)?.kind,kind:kindOf(FS.provinces.get('4,0').province,43,{faction:FS.citizen.faction,level:FS.survey.levelOf(4,0,43)})};
      });
      assert.ok(cityAction.marker===undefined || cityAction.marker==='move','unsurveyed city does not leak an attack marker');
      assert.equal(cityAction.kind,'move','real survey keeps the target unknown');
      await tap(CITY);
      await page.waitForFunction(async()=>!!(await import('/frontier/fstate.mjs')).FS.compose?.route);
      const cityOrder=await snapshot(page);
      assert.equal(cityOrder.session,false);
      assert.deepEqual([cityOrder.compose.dest.p,cityOrder.compose.dest.q,cityOrder.compose.dest.tile],[4,0,43]);
      assert.doesNotMatch(await page.locator('.mc-dest-name:visible, .order-sum .os-dest:visible').first().textContent(),/自由都市/);
      await page.screenshot({path:`${outDir}/${vp.name}-free-city-order.png`});
      const cancelCity=page.locator('[data-act="compose-close"]:visible').first();
      if(phone) await cancelCity.tap(); else await cancelCity.click();
      await page.waitForFunction(async()=>!(await import('/frontier/fstate.mjs')).FS.compose);
      await page.reload();
      await page.waitForFunction(async()=>{const {FS}=await import('/frontier/fstate.mjs');return FS.playReady&&FS.meStatus==='ready'&&!!FS.s1?.structures;});
      assert.equal((await snapshot(page)).compose,null,'reload does not restore a stale order card');
      assert.equal((await snapshot(page)).session,false,'reload does not create a session');
      await wideEconomy(page,srv,vp,outDir);
      await wideVillageNavigation(page,srv,vp,outDir);
      // The original spectator page intentionally sees public world state.
      // This validates a visible city without changing the player's survey.
      await page.goto(`${srv.base}/frontier/spectate.html?devWallet=off&at=4,0,43,${phone?'0.55':'1.0'}`);
      await page.waitForFunction(async()=>{
        const {FS}=await import('/frontier/fstate.mjs');
        return FS.mode==='spectate'&&FS.overviewsBooted&&FS.conquest?.status==='ready'&&FS.survey?.showAll&&!!window.__wyllsMap;
      },null,{timeout:30000});
      await tap(CITY);
      await page.waitForFunction(async()=>{
        const {FS}=await import('/frontier/fstate.mjs');
        return FS.selected?.p===4&&FS.selected?.q===0&&FS.selected?.idx===43&&FS.provinces.get('4,0')?.province?.siteMirror?.[11]?.state===5;
      });
      if(phone && await page.locator('#panel').getAttribute('data-sheet')==='peek') await page.locator('#panel [data-sheet-handle]').tap();
      const observed=await page.evaluate(async()=>{
        const {FS}=await import('/frontier/fstate.mjs'),{inspectModel}=await import('/frontier/hud/inspect.mjs');
        const m=inspectModel(FS,FS.terrainOf);
        return {mode:FS.mode,level:m.level,state:m.tile.site.state,garrison:m.tile.site.garrison,wallet:FS.wallet,session:FS.session,compose:!!FS.compose};
      });
      assert.deepEqual(observed,{mode:'spectate',level:3,state:'freeCity',garrison:300,wallet:null,session:null,compose:false});
      const cityPanel=page.locator('#panel');
      assert.match(await cityPanel.textContent(),/自由都市/);
      assert.match(await cityPanel.textContent(),/守備隊 300/);
      assert.equal(await cityPanel.locator('[data-act="cq-outpost"]').count(),0);
      await cityPanel.getByText('自由都市',{exact:true}).first().scrollIntoViewIfNeeded();
      await page.screenshot({path:`${outDir}/${vp.name}-free-city-spectator.png`});
      await largeChart(page, vp, outDir);
      assert.ok(srv.overviewStats().peak<=4,'overview bound remains four after reloads');
      assert.deepEqual(keyCalls,[],'Node runner made no key operation');
      assert.deepEqual(srv.writes,[],'server received no writes');
      assert.deepEqual(requests.filter(r=>!['GET','HEAD'].includes(r.method)),[],'browser made no writes');
      assert.deepEqual(requests.filter(r=>!r.url.startsWith(srv.base)),[],'all app requests stayed on the fixture origin');
      assert.deepEqual(errors,[],'no page exception');
      assert.deepEqual(failures.filter(x=>!x.reason.includes('ERR_ABORTED')),[],'no failed asset or worker requests');
    } catch (error) {
      if (page && !page.isClosed()) {
        console.log(JSON.stringify({viewport:vp.name,error:String(error.stack??error),failedSnapshot:await snapshot(page),errors,failures,
          pointer:await page.evaluate(()=>{const m=window.__wyllsMap;return {mouse:m?.mouse,hover:m?.hover,view:m?.cam.drawn,hand:document.getElementById('hand')?.getBoundingClientRect().toJSON()};})}));
        await page.screenshot({path:`${outDir}/${vp.name}-failure.png`});
      }
      throw error;
    } finally {
      try {
        if(ctx) {
          assert.ok(page && !page.isClosed(),'expected page remains readable for safety checks');
          assert.equal(ctx.pages().length,1,'no uninspected page was opened');
          const safety=await page.evaluate(async()=>({
            uses:window.__keyUses,
            storedUses:JSON.parse(localStorage.getItem('ws07:keyUses')??'[]'),
            seeds:Object.keys(localStorage).filter(k=>k==='ps-dev-wallet'||k.startsWith('ps-fsession:')),
            session:!!(await import('/frontier/fstate.mjs')).FS.session,
        }));
        console.log(JSON.stringify({viewport:vp.name,safety,nodeKeyCalls:keyCalls,serverWrites:srv.writes}));
        assert.deepEqual(safety,{uses:[],storedUses:[],seeds:[],session:false},'no key call or stored/session key on success or failure');
        }
        assert.deepEqual(keyCalls,[],'Node runner made no key operation');
        assert.deepEqual(srv.writes,[],'server received no writes');
        assert.deepEqual(requests.filter(r=>!['GET','HEAD'].includes(r.method)),[],'browser made no writes');
        assert.deepEqual(requests.filter(r=>!r.url.startsWith(srv.base)),[],'all app requests stayed on the fixture origin');
      } finally { await Promise.all([ctx?.close(),browser?.close(),srv.close()]); }
    }
  });
}
