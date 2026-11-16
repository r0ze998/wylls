// The safety guard of first-guide-villages.screen.mjs, as pure code with everything it touches handed in (2026-11-16),
// so that it is tested with fake handles and a fake disk (test/web-frontier-first-guide-safety.test.mjs) and the screen
// test only wires real ones. Nothing here imports a browser, a server, `fs` or a timer of its own.
//
// FAIL-CLOSED: a free-space value, a profile size or a profile file that cannot be read is a failure, not a pass —
// the guard trips and closes this test's own handles. One exception, on purpose: a profile file that is GONE (ENOENT
// between listing and reading — Chromium deletes temporary files while it runs) is not on disk, so it adds no size and
// holds no storage; any other error (EACCES, EIO, …) fails.
// HANDLES: each is adopted through the guard. One adopted after a trip (a browser whose launch was still running when
// the monitor tripped) is closed at once and the adoption throws, so nothing launched late is left running. Each
// handle is closed at most once; a close that throws is recorded and makes the run fail. No signal is sent anywhere.
// LIMITS are checked every `every` ms: not hard limits — up to one interval's writing can pass them before the close.

export const GONE = 'ENOENT';
const isGone = e => e && e.code === GONE;

/** Every file under `dir` (`list(dir)` → [{name, dir: bool}]); a directory that cannot be listed throws (unless gone). */
export function walkFiles(dir, { list, join }) {
  let entries;
  try { entries = list(dir); } catch (e) { if (isGone(e)) return []; throw e; }
  return entries.flatMap(e => (e.dir ? walkFiles(join(dir, e.name), { list, join }) : [join(dir, e.name)]));
}

/** The total size of `files` (`size(f)`); a file that cannot be read throws (a gone one adds nothing). */
export function totalSize(files, { size }) {
  let n = 0;
  for (const f of files) { try { n += size(f); } catch (e) { if (!isGone(e)) throw e; } }
  return n;
}

/** The files holding any of `keys` (`read(f)` → a Buffer or string); `unreadable` lists files that could not be read. */
export function scanStorage(files, keys, { read }) {
  const leaked = [], unreadable = [];
  for (const f of files) {
    let b;
    try { b = read(f); } catch (e) { if (!isGone(e)) unreadable.push(`${f}: ${e.code ?? e.message}`); continue; }
    if (keys.some(k => b.includes(k))) leaked.push(f);
  }
  return { leaked, unreadable };
}

/**
 * The guard. `freeBytes()` and `profileBytes()` may throw: that trips it. `timers` = {setInterval, clearInterval}.
 * Returns {adopt(kind, handleOrPromise), start(), sample(), closeAll(), state()}.
 */
export function createGuard({ freeBytes, profileBytes, freeMin, profileMax, every = 1000, timers }) {
  const handles = new Map();
  let tripped = null, closing = null, timer = null;
  const errors = [], peak = { profile: 0, freeLow: Infinity };
  const trip = why => { if (!tripped) tripped = why; return closeAll(); };
  function sample() {
    if (tripped || closing) return;
    let free, prof;
    try { free = freeBytes(); } catch (e) { trip(`free space unreadable: ${e.code ?? e.message}`); return; }
    if (!Number.isFinite(free)) { trip(`free space unreadable: ${free}`); return; }
    try { prof = profileBytes(); } catch (e) { trip(`profile size unreadable: ${e.code ?? e.message}`); return; }
    if (!Number.isFinite(prof)) { trip(`profile size unreadable: ${prof}`); return; }
    peak.profile = Math.max(peak.profile, prof); peak.freeLow = Math.min(peak.freeLow, free);
    if (free <= freeMin) trip(`free space ${(free / 2 ** 30).toFixed(2)} GiB ≤ ${(freeMin / 2 ** 30).toFixed(0)} GiB`);
    else if (prof > profileMax) trip(`profile ${(prof / 2 ** 20).toFixed(1)} MiB > ${(profileMax / 2 ** 20).toFixed(0)} MiB`);
  }
  // (a close that rejects, or resolves WITH an Error — server.mjs's close hands node's `server.close` callback its
  //  resolve, so a close error arrives as the resolved value — is a failure)
  const closeOne = async (kind, h) => { try { const v = await h.close(); if (v instanceof Error) errors.push(`${kind}: ${v.message}`); } catch (e) { errors.push(`${kind}: ${e?.message ?? e}`); } };
  function closeAll() {
    return (closing ??= (async () => {
      if (timer !== null) { timers.clearInterval(timer); timer = null; }
      // (the page's context, then the browser, then the server: each once)
      for (const kind of ['ctx', 'browser', 'srv']) { const h = handles.get(kind); handles.delete(kind); if (h) await closeOne(kind, h); }
    })());
  }
  /** Adopt a handle (or the promise of one). After a trip or a close it is closed at once and this throws. */
  async function adopt(kind, h) {
    const v = await h;
    if (closing) { await closeOne(kind, v); throw new Error(`${kind} arrived after the guard closed (${tripped ?? 'closed'}): closed at once`); }
    if (handles.has(kind)) throw new Error(`${kind} adopted twice`);
    handles.set(kind, v);
    return v;
  }
  const start = () => { if (timer === null && !closing) { timer = timers.setInterval(sample, every); timer?.unref?.(); } };
  const state = () => ({ tripped, closed: !!closing, closeErrors: [...errors], open: [...handles.keys()], peak: { ...peak } });
  return { adopt, start, sample, closeAll, state };
}
