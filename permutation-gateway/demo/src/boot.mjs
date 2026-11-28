// The walletless demo's world, in the page (build.mjs bundles this file as
// frontier/demo-world.js and puts it before app.mjs in every page of the
// static bundle). It plays the screens SAMPLE WORLD (screens/liveworld.mjs:
// the M1 rules in the real herald and relay shapes, clashes by the page's own
// frontier.wasm, other nations by a seeded script) and answers the page's
// herald (/h/*), relay (/gw/*) and cooperation (/coop/*) reads through a
// `fetch` shim, exactly as screens/server.mjs answers them over HTTP. Nothing
// leaves the browser: a request to another origin is refused and logged.
// The world is saved in this browser and made again at the next load (save.mjs: its inputs are replayed); without a
// save, or with an old or damaged one, it is a new world (the same seed) and the demo's page storage is cleared at
// load, keeping only the language. "Start over" (the demo tag) clears both. (demo-polish-2: Q-WD-6, Q-WD-8)
import * as W from '../../screens/world.mjs';
import { createLive as makeLive } from '../../screens/liveworld.mjs';
import { keyFromSeed, verify } from '../../../permutation-server/web/session.mjs';
import { initKernel } from './kernel.mjs';
import { SAVE_KEY, createClock, createRecorder, readSave, replay } from './save.mjs';
import { DEMO } from 'demo:config';

// the world's clock is the save's (save.mjs): held while a POST is taken, set by the replay
const CLOCK = createClock();
// (a browser without Ed25519: the world is made keyless — it shows the nation picker and its notice, and signs nothing)
let NO_KEYS = false;
const createLive = opts => makeLive({ ...opts, wall: CLOCK.wall, ...(NO_KEYS ? { keyless: true } : {}) });

const realFetch = globalThis.fetch.bind(globalThis);
const page = new URL(globalThis.location.href);
// (file:// pages have the origin "null": the page then asks for "null/h/…" relative to itself)
const WORLD = /^(?:.*\/null)?\/(h|gw|coop)\/.*$/;
const log = { requests: [], blocked: [], errors: [] };

// ------------------------------------------------------------------ storage: the saved guest, or a fresh one
function chooseLang() {
  const asked = page.searchParams.get('lang');
  if (asked === 'ja' || asked === 'en') return asked;
  const kept = globalThis.localStorage?.getItem('ps-lang');
  if (kept === 'ja' || kept === 'en') return kept;
  return /^ja\b/i.test(globalThis.navigator?.language ?? '') ? 'ja' : 'en';
}
/** A short note for the next load ("your save could not be restored"), read and removed once. */
const NOTE_KEY = 'wylls-demo-save-note';
const WORLD_ID = String(DEMO.worldId ?? 'dev');
let LS = null;
try { LS = globalThis.localStorage ?? null; } catch { LS = null; }
function freshStorage() {
  const lang = chooseLang();
  for (const k of Object.keys(LS)) if (k.startsWith('ps-') && k !== 'ps-lang') LS.removeItem(k);
  // stage none: no Citizen yet (the page shows the nation picker); W.storageFor reads the viewer only for later stages
  for (const [k, v] of Object.entries(W.storageFor(null, { stage: 'none', lang, live: true }))) LS.setItem(k, v);
}
const FOUND = readSave(LS, WORLD_ID);
/** What happened to the save at this load: 'none' | 'resume' | 'old' | 'corrupt' | 'failed' (a replay that differed) | 'unavailable'. */
let RESTORE = FOUND.status;
try {
  const note = LS?.getItem(NOTE_KEY);
  if (note !== null && note !== undefined) { LS.removeItem(NOTE_KEY); if (RESTORE === 'none' && ['old', 'corrupt', 'failed'].includes(note)) RESTORE = note; }
  if (FOUND.status === 'resume') {
    const asked = page.searchParams.get('lang');
    if (asked === 'ja' || asked === 'en') LS.setItem('ps-lang', asked);
  } else if (LS) {
    if (FOUND.status === 'old' || FOUND.status === 'corrupt') LS.removeItem(SAVE_KEY);
    freshStorage();
  }
} catch (e) { log.errors.push(`storage: ${e?.message ?? e}`); }
const SAVER = createRecorder({ storage: LS, worldId: WORLD_ID, clock: CLOCK, from: FOUND.status === 'resume' ? FOUND.save : null });

/** Start over: the save and the demo's page storage go, then the page loads a new world (`note`: said at that load). */
function startOver(note = null) {
  SAVER.clear();
  try {
    for (const k of Object.keys(LS ?? {})) if (k.startsWith('ps-') && k !== 'ps-lang') LS.removeItem(k);
    if (note) LS?.setItem(NOTE_KEY, note);
  } catch { /* the reload starts fresh anyway: there is no save */ }
  globalThis.location.reload();
}
globalThis.document?.addEventListener('click', e => {
  const b = e.target?.closest?.('[data-demo-reset]');
  if (!b) return;
  e.preventDefault();
  if (globalThis.confirm(b.getAttribute('data-confirm') || 'Start over?')) startOver();
});
globalThis.addEventListener?.('pagehide', () => SAVER.write());
globalThis.document?.addEventListener('visibilitychange', () => { if (globalThis.document.visibilityState === 'hidden') SAVER.write(); });

// ------------------------------------------------------------------ the browser's Ed25519 (Q-WD-8): the page signs with it
// (session.mjs `preflight`'s test, without its text tables in the world bundle: a secure page, and a WebCrypto that
//  really signs and verifies Ed25519. 'ok', 'InsecureContext' or 'NoEd25519')
export async function cryptoCheck(g = globalThis) {
  if (!g.isSecureContext || !g.crypto?.subtle) return 'InsecureContext';
  try {
    const k = await keyFromSeed(new Uint8Array(32).fill(7));
    const msg = new TextEncoder().encode('Wylls demo preflight');
    return (await verify(k.publicKey, msg, await k.sign(msg))) ? 'ok' : 'NoEd25519';
  } catch { return 'NoEd25519'; }
}
const CRYPTO = cryptoCheck();

// ------------------------------------------------------------------ the world (made at the page's first read)
let made = null;
function world() {
  made ??= (async () => {
    await initKernel(new URL('wasm/frontier.wasm', import.meta.url).href, realFetch);
    const v = await W.viewer({ keyless: NO_KEYS });
    W.setLiveStorage(true);
    const live = createLive({ viewer: v, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true, camps: true, turn: DEMO.turnSecs, delay: DEMO.delaySecs, landMs: DEMO.landMs });
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

/** The world made again from the save (or a new one), before any read is answered. A replay that differs starts over. */
let readyP = null;
const ready = () => (readyP ??= CRYPTO.then(c => {
  // (without Ed25519 nothing can be joined or replayed: the save is left as it is and nothing is written)
  NO_KEYS = c !== 'ok';
  if (NO_KEYS) SAVER.disable(c);
  return world();
}).then(async x => {
  if (FOUND.status !== 'resume' || NO_KEYS) return x;
  try { await replay(x.live, FOUND.save, CLOCK); } catch (e) {
    log.errors.push(`save: ${e?.message ?? e}`);
    startOver('failed');
    return new Promise(() => {});   // the page is reloading
  }
  return x;
}));
ready().catch(e => log.errors.push(`world: ${e?.message ?? e}`));   // (made at once: the kernel and a replay overlap the page's own load)

/**
 * The demo's own field on the season record: the page says "playable demo", links the live world, says whether the
 * world is saved in this browser (and what became of an old save), and whether this browser can sign (Ed25519).
 */
const withDemo = (body, crypto) => (body && typeof body === 'object' && body.sample ? { ...body, sample: { ...body.sample, demo: { live: DEMO.liveUrl, save: { ...SAVER.state(), restore: RESTORE }, crypto } } } : body);

async function route(method, url, bodyText) {
  const path = url.pathname.replace(/^.*\/null(?=\/)/, '');
  if (path === '/coop/config') return { status: 204 };
  if (path.startsWith('/coop/')) return json(404, { code: 'NotFound' });
  const { v, live } = await ready();
  SAVER.tick(live.turn());
  if (path.startsWith('/h/')) {
    if (path === '/h/season') SAVER.seen(live);
    const r = live.herald(path, url) ?? stillHerald(v, path, url);
    return path === '/h/season' ? { ...r, body: withDemo(r.body, await CRYPTO) } : r;
  }
  let body = null;
  if (method === 'POST') { try { body = JSON.parse(bodyText || '{}'); } catch { body = null; } }
  // (a POST is an input of the world: saved with its clock reading, the clock held for the whole of it)
  if (method === 'POST') return (await SAVER.post(method, path, bodyText ?? null, () => live.relay(method, path, body))) ?? stillRelay(v, path, method);
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
globalThis.__wyllsDemo = Object.freeze({ log, world: () => ready().then(x => x.live), config: DEMO, modules: {}, save: () => ({ ...SAVER.state(), restore: RESTORE, key: SAVE_KEY, world: WORLD_ID }) });
