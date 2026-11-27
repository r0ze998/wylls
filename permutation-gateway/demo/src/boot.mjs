// The walletless demo's world, in the page (build.mjs bundles this file as
// frontier/demo-world.js and puts it before app.mjs in every page of the
// static bundle). It plays the screens SAMPLE WORLD (screens/liveworld.mjs:
// the M1 rules in the real herald and relay shapes, clashes by the page's own
// frontier.wasm, other nations by a seeded script) and answers the page's
// herald (/h/*), relay (/gw/*) and cooperation (/coop/*) reads through a
// `fetch` shim, exactly as screens/server.mjs answers them over HTTP. Nothing
// leaves the browser: a request to another origin is refused and logged.
// Each page load is a new world (the same seed), so the demo's storage is
// cleared at load, keeping only the language.
import * as W from '../../screens/world.mjs';
import { createLive } from '../../screens/liveworld.mjs';
import { initKernel } from './kernel.mjs';
import { DEMO } from 'demo:config';

const realFetch = globalThis.fetch.bind(globalThis);
const page = new URL(globalThis.location.href);
// (file:// pages have the origin "null": the page then asks for "null/h/…" relative to itself)
const WORLD = /^(?:.*\/null)?\/(h|gw|coop)\/.*$/;
const log = { requests: [], blocked: [], errors: [] };

// ------------------------------------------------------------------ storage: a fresh guest each load
function chooseLang() {
  const asked = page.searchParams.get('lang');
  if (asked === 'ja' || asked === 'en') return asked;
  const kept = globalThis.localStorage?.getItem('ps-lang');
  if (kept === 'ja' || kept === 'en') return kept;
  return /^ja\b/i.test(globalThis.navigator?.language ?? '') ? 'ja' : 'en';
}
try {
  const lang = chooseLang();
  const ls = globalThis.localStorage;
  for (const k of Object.keys(ls)) if (k.startsWith('ps-') && k !== 'ps-lang') ls.removeItem(k);
  // stage none: no Citizen yet (the page shows the nation picker); W.storageFor reads the viewer only for later stages
  for (const [k, v] of Object.entries(W.storageFor(null, { stage: 'none', lang, live: true }))) ls.setItem(k, v);
} catch (e) { log.errors.push(`storage: ${e?.message ?? e}`); }

// ------------------------------------------------------------------ the world (made at the page's first read)
let made = null;
function world() {
  made ??= (async () => {
    await initKernel(new URL('wasm/frontier.wasm', import.meta.url).href, realFetch);
    const v = await W.viewer();
    W.setLiveStorage(true);
    const live = createLive({ viewer: v, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true, turn: DEMO.turnSecs, delay: DEMO.delaySecs, landMs: DEMO.landMs });
    return { v, live };
  })();
  return made;
}

const json = (status, body) => ({ status, body });
// what screens/server.mjs answers when the live world does not (the still fixture's files)
function stillHerald(v, path, url) {
  let m;
  if (path === '/h/season') return json(200, W.seasonRecord());
  if ((m = /^\/h\/overview\/(\d+)\/(?:latest|\d+)\.bin$/.exec(path))) return Number(m[1]) < 3 ? { status: 200, bytes: W.overview(Number(m[1])) } : json(404, { code: 'NotFound' });
  if ((m = /^\/h\/roster\/(\d+)\/latest\.bin$/.exec(path))) return Number(m[1]) < 3 ? { status: 200, bytes: W.roster(Number(m[1])) } : json(404, { code: 'NotFound' });
  if ((m = /^\/h\/province\/(-?\d+),(-?\d+)\/(latest|\d+)$/.exec(path))) return json(200, W.provinceEnvelope(Number(m[1]), Number(m[2]), m[3] === 'latest' ? W.BELL : Number(m[3]), 'none'));
  if ((m = /^\/h\/bell\/(\d+)\/region\/(\d+)$/.exec(path))) return json(200, W.bellRegion(Number(m[1]), Number(m[2])));
  if ((m = /^\/h\/me\/(\w+)$/.exec(path))) return json(200, W.meRecord({ ...v, wallet: m[1] }, 'none'));
  if (path === '/h/events') {
    let after = 0n;
    try { after = BigInt(url.searchParams.get('after') ?? '0'); } catch { after = 0n; }
    const list = W.events().filter(e => BigInt(e.seq) > after);
    return json(200, { v: 1, events: list, next: list.length ? list[list.length - 1].seq : String(after), full: false });
  }
  return json(404, { code: 'NotFound' });
}
function stillRelay(v, path, method) {
  const quota = { left: 38, resetsAt: W.GENESIS_TS + 86_400, lamportsLeft: '400000000' };
  if (method === 'GET' && path === '/gw/f/quota') return json(200, { ok: true, ...quota });
  if (method === 'GET' && path === '/gw/f/relay') return json(200, { ok: true, feePayer: v.A.season, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000, programId: W.PROGRAM, quota });
  return json(200, { ok: false, code: 'Unavailable', error: 'not part of this demo' });
}

/** The demo's own field on the season record: the page says "playable demo" and links the live world. */
const withDemo = body => (body && typeof body === 'object' && body.sample ? { ...body, sample: { ...body.sample, demo: { live: DEMO.liveUrl } } } : body);

async function route(method, url, bodyText) {
  const path = url.pathname.replace(/^.*\/null(?=\/)/, '');
  if (path === '/coop/config') return { status: 204 };
  if (path.startsWith('/coop/')) return json(404, { code: 'NotFound' });
  const { v, live } = await world();
  if (path.startsWith('/h/')) {
    const r = live.herald(path, url) ?? stillHerald(v, path, url);
    return path === '/h/season' ? { ...r, body: withDemo(r.body) } : r;
  }
  let body = null;
  if (method === 'POST') { try { body = JSON.parse(bodyText || '{}'); } catch { body = null; } }
  return (await live.relay(method, path, body)) ?? stillRelay(v, path, method);
}

function toResponse(r) {
  const headers = { 'Cache-Control': 'no-store' };
  if (r.status === 204) return new Response(null, { status: 204, headers });
  if (r.bytes) return new Response(r.bytes, { status: r.status, headers: { ...headers, 'Content-Type': 'application/octet-stream' } });
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

globalThis.fetch = async function demoFetch(input, init = {}) {
  const req = typeof Request === 'function' && input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input?.href ?? input), globalThis.location.href);
  const method = String(init.method ?? req?.method ?? 'GET').toUpperCase();
  const local = url.origin === globalThis.location.origin || url.protocol === 'file:';
  if (local && WORLD.test(url.pathname)) {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    let text = typeof init.body === 'string' ? init.body : null;
    if (text === null && req && method === 'POST') text = await req.text();
    try {
      const r = await route(method, url, text);
      log.requests.push({ method, path: url.pathname, status: r.status });
      return toResponse(r);
    } catch (e) {
      log.errors.push(`${method} ${url.pathname}: ${e?.message ?? e}`);
      return toResponse(json(500, { code: 'DemoWorldError', error: String(e?.message ?? e) }));
    }
  }
  if (!local && url.protocol !== 'data:' && url.protocol !== 'blob:') {
    log.blocked.push(url.href);
    throw new TypeError(`walletless demo: no network (${url.origin})`);
  }
  return realFetch(input, init);
};

// (tests and the curious: what the world answered, what was refused; the world itself for a summary)
// (modules: the page bundle's own module instances, filled by src/page-app.mjs for tests; see there)
globalThis.__wyllsDemo = Object.freeze({ log, world: () => world().then(x => x.live), config: DEMO, modules: {} });
