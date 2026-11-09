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

async function serve() {
  let obstacle = null, releaseOverviews;
  let held = true, active = 0, peak = 0;
  const overviewGate = new Promise(r => { releaseOverviews = r; });
  const requests = [], writes = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push(path);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { writes.push(`${req.method} ${path}`); return json(405, { ok: false, code: 'ReadOnlyFixture' }); }
    if (/^\/h\/overview2?\//.test(path)) {
      active++; peak = Math.max(peak, active);
      res.once('close', () => { active--; });
      if (held) await overviewGate;
    }
    if (path.startsWith('/h/')) {
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
    overviewStats: () => ({active,peak,held}), release: () => { held = false; releaseOverviews(); },
    close: () => new Promise(r => { held = false; releaseOverviews(); server.closeAllConnections(); server.close(r); }) };
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
