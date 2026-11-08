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
const AROUND = [5,0,0,1,0,1,1,0,1,1];

async function serve() {
  let obstacle = null;
  const requests = [], writes = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push(path);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { writes.push(`${req.method} ${path}`); return json(405, { ok: false, code: 'ReadOnlyFixture' }); }
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
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

const snapshot = page => page.evaluate(async () => {
  const { FS } = await import('/frontier/fstate.mjs');
  const { subjectOf } = await import('/frontier/hud/hand.mjs');
  const s = subjectOf(FS), m = window.__wyllsMap;
  const hover = m?.source().hoverRoute;
  return { who: s?.kind === 'host' ? String(s.host.id) : s?.kind, selected: FS.selected, note: FS.mapNote?.text,
    compose: FS.compose ? { dest: FS.compose.dest, dirs: FS.compose.route?.dirs, secs: FS.compose.route?.secs, error: FS.compose.routeError, bell: FS.compose.arriveBell } : null,
    hover: hover ? { key: hover.key, hexes: hover.hexes, bell: hover.arriveBell } : null,
    structures: FS.s1?.structures?.structures, nowBell: FS.nowBell, session: !!FS.session, kernelError: FS.kernelError };
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
      }
      srv.obstacle(6);
      await page.evaluate(async()=>{await (await import('/frontier/controller.mjs')).refresh();});
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
      await page.reload();
      await page.waitForFunction(async()=>{const {FS}=await import('/frontier/fstate.mjs');return FS.playReady&&FS.meStatus==='ready'&&!!FS.s1?.structures;});
      assert.equal((await snapshot(page)).compose,null,'reload does not restore a stale order card');
      assert.equal((await snapshot(page)).session,false,'reload does not create a session');
      assert.deepEqual(keyCalls,[],'Node runner made no key operation');
      assert.deepEqual(srv.writes,[],'server received no writes');
      assert.deepEqual(requests.filter(r=>!['GET','HEAD'].includes(r.method)),[],'browser made no writes');
      assert.deepEqual(requests.filter(r=>!r.url.startsWith(srv.base)),[],'all app requests stayed on the fixture origin');
      assert.deepEqual(errors,[],'no page exception');
      assert.deepEqual(failures.filter(x=>!x.reason.includes('ERR_ABORTED')),[],'no failed asset or worker requests');
    } catch (error) {
      if (page && !page.isClosed()) {
        console.log(JSON.stringify({viewport:vp.name,failedSnapshot:await snapshot(page),errors,failures,
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
