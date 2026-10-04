// Reads and writes against the page's own origin (serve.mjs on 41902): /h/ai/* (the AI's files), /h/* (the herald),
// /f/ai/* (the social service). Never throws: every call answers `{ok, status, json}`. Files that are final once
// written (talk, minds, open, anchors: contract §8.3) are cached for the life of the page; everything else is asked
// again every time (the server's own cache is 2 s).
const IMMUTABLE = /^\/h\/ai\/(talk|minds|open|anchors)\/\d+\.json$/;

export function createApi({ fetchFn = globalThis.fetch?.bind(globalThis), base = '', timeoutMs = 8000 } = {}) {
  const kept = new Map();
  async function getJson(path) {
    if (IMMUTABLE.test(path) && kept.has(path)) return kept.get(path);
    let res;
    try {
      res = await fetchFn(`${base}${path}`, { cache: 'no-store', signal: globalThis.AbortSignal?.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
    } catch { return { ok: false, status: 0, json: null }; }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    const out = { ok: res.ok, status: res.status, json };
    if (res.ok && IMMUTABLE.test(path)) kept.set(path, out);
    return out;
  }
  async function post(path, body) {
    let res;
    try {
      res = await fetchFn(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: globalThis.AbortSignal?.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
    } catch { return { ok: false, status: 0, json: null }; }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  }
  /** A same-origin file by full URL (resolved by the caller against import.meta.url), e.g. the Japanese dictionary beside the modules. */
  async function getUrl(url) {
    let res;
    try { res = await fetchFn(url, { cache: 'no-cache' }); } catch { return { ok: false, status: 0, json: null }; }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok, status: res.status, json };
  }
  return { getJson, post, get: getJson, getUrl, cacheSize: () => kept.size };
}
