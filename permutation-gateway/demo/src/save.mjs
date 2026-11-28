// The walletless demo's save (demo-polish-2; owner Q-WD-6: "saving in the next step"). The demo world survives a
// reload: this file keeps, in the browser's localStorage, what is needed to make the same world again.
//
// What is saved is not the world itself but its INPUTS, and it is replayed on load:
//   - the world's clock (`clock` below is the `wall` the world reads; it starts at 0 when the world is made);
//   - the moment the page first read the world (`seen`: the world's clock starts there);
//   - every POST the page sent (a signed join, order or reveal, as text) with the clock reading it was taken at, and a
//     digest of what the world answered.
// The world (screens/liveworld.mjs) is deterministic: its other nations follow a seeded script, its keeper steps run at
// fixed world times whatever reads come between, and the clock is held still while a POST is taken (so the world
// reads one time for the whole of it, as the replay does). Replaying the inputs at their clock readings therefore
// makes the same world; every answer is compared with its saved digest, and any difference throws (the caller then
// starts a fresh world and says so). The page's own storage (`ps-*`: its guest wallet, its in-game key, its seal book)
// stays where it is, as the real game keeps it.
//
// Why replay and not a snapshot: the world's state is a few dozen closures over Maps, BigInts and byte arrays that
// change with every rule; a snapshot would have to follow each one, a replay follows none of them. A replay costs the
// catch-up (about 4 ms a turn in Node with the fixture encoder memoized: 300 turns ≈ 1.2 s).
//
// The record is versioned twice: `v` (this format) and `world` (a hash of the world bundle, made at build time:
// build.mjs). A save from another format or another world build is old: it is dropped and the world starts fresh.
//
// Sections (demo-npc-merchants): what the PAGE keeps that is no input of the world (the travelers' talk: which line
// each traveler says next) rides in `sections: {<name>: {v, ...}}` — each section carries its own version, and a
// reader takes only the sections (and versions) it knows. A save without `sections` (written before them) is still
// this format; a reader that knows no sections ignores the field. Nothing in a section is replayed or checked.
export const SAVE_KEY = 'wylls-demo-save';
export const SAVE_V = 1;
/** Above this many characters the save is given up (localStorage holds about 5 M characters per origin, shared). */
export const MAX_CHARS = 2_000_000;

/**
 * The world's clock: milliseconds since the world was made, held still by `freeze` (a POST, a replay) and running on
 * from where it was held by `thaw`. `set(w)` holds it at `w` (the replay).
 */
export function createClock(realNow = () => Date.now()) {
  const start = realNow();
  let offset = 0, held = null, depth = 0;
  const running = () => offset + (realNow() - start);
  const release = () => { if (held !== null) offset = held - (realNow() - start); held = null; depth = 0; };
  return {
    wall: () => (held !== null ? held : running()),
    /** Hold the clock (nested holds: it runs again when the last one thaws). */
    freeze() { if (depth++ === 0 && held === null) held = running(); return held; },
    thaw() { if (depth > 0 && --depth === 0) release(); },
    /** The replay: hold the clock at `w` (until `release`). */
    set(w) { held = w; },
    /** Move the clock on by `ms` (a test's fast-forward: the save reads this same clock, so a reload replays it). */
    skip(ms) { if (held === null && Number.isFinite(ms) && ms > 0) offset += ms; },
    release,
    get held() { return held !== null; },
  };
}

/** A short digest of an answer (FNV-1a over its JSON; BigInts as text). */
export function digest(value) {
  let text;
  try { text = JSON.stringify(value ?? null, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x)); } catch { text = 'unjsonable'; }
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const isNum = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
/** Whether `s` has the shape this file writes (anything else is a damaged save). */
export function validSave(s) {
  if (!s || typeof s !== 'object' || !isNum(s.w) || !Array.isArray(s.events)) return false;
  let last = 0;
  for (const e of s.events) {
    if (!e || typeof e !== 'object' || !isNum(e.w) || e.w < last || e.w > s.w) return false;
    last = e.w;
    if (e.k === 'seen') continue;
    if (e.k !== 'post' || typeof e.m !== 'string' || typeof e.p !== 'string' || !/^\/(gw|coop)\//.test(e.p) || !(e.b === null || typeof e.b === 'string') || typeof e.r !== 'string') return false;
  }
  return true;
}

/**
 * What the storage holds: `{status: 'none'}` (nothing saved), `{status: 'resume', save}`, `{status: 'old'}` (another
 * format or world build), `{status: 'corrupt'}` (not this file's shape), or `{status: 'unavailable'}` (no storage).
 */
export function readSave(storage, worldId) {
  let text;
  try { if (!storage) return { status: 'unavailable' }; text = storage.getItem(SAVE_KEY); } catch { return { status: 'unavailable' }; }
  if (text === null || text === undefined) return { status: 'none' };
  let s;
  try { s = JSON.parse(text); } catch { return { status: 'corrupt' }; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { status: 'corrupt' };
  if (s.v !== SAVE_V || s.world !== worldId) return { status: 'old' };
  return validSave(s) ? { status: 'resume', save: s } : { status: 'corrupt' };
}

/** The saved answer did not come again: the world would not be the one that was saved. */
export class ReplayMismatch extends Error {
  constructor(i, want, got) { super(`replay: input ${i} answered ${got}, saved ${want}`); this.code = 'ReplayMismatch'; this.index = i; }
}

// (as boot.mjs reads a POST's body: an empty body is {})
const bodyOf = text => { try { return JSON.parse(text || '{}'); } catch { return null; } };

/**
 * Make the saved world again: every input at its clock reading, then the clock at the saved reading, running.
 * `live` is a new world made with `clock.wall`. Throws ReplayMismatch when an answer differs from the saved one.
 */
export async function replay(live, save, clock) {
  for (let i = 0; i < save.events.length; i++) {
    const e = save.events[i];
    clock.set(e.w);
    if (e.k === 'seen') { live.seen(); continue; }
    let r;
    try { r = digest(await live.relay(e.m, e.p, bodyOf(e.b))); } catch (err) { r = `throw:${digest(String(err?.message ?? err))}`; }
    if (r !== e.r) throw new ReplayMismatch(i, e.r, r);
  }
  clock.set(save.w);
  clock.release();
}

/**
 * The recorder: `seen(live)`, `post(m, p, bodyText, run)` (run = the world's answer), `tick(turn)` (a write when the
 * turn changed), `write()` (also on pagehide), `clear()` ("Start over"). `state()` says whether saving works:
 * `{on, why, inputs}` (why: 'full' when the storage refused or the save grew too big, 'unavailable' without storage).
 */
export function createRecorder({ storage, worldId, clock, from = null, maxChars = MAX_CHARS }) {
  const events = from ? [...from.events] : [];
  // (the page's own sections: kept as they were read, written with every save; a damaged field is dropped)
  const sections = {};
  if (from?.sections && typeof from.sections === 'object' && !Array.isArray(from.sections)) {
    for (const [k, x] of Object.entries(from.sections)) if (x && typeof x === 'object' && !Array.isArray(x) && Number.isInteger(x.v)) sections[k] = x;
  }
  let seenDone = events.some(e => e.k === 'seen');
  let on = !!storage, why = storage ? null : 'unavailable', lastTurn = null, stopped = false;
  let chain = Promise.resolve();
  function fail(reason) {
    on = false; why = reason;
    // a save that can no longer follow the world is dropped: a reload then starts fresh, page storage and all
    try { storage?.removeItem(SAVE_KEY); } catch { /* nothing more to do */ }
    return false;
  }
  function write() {
    if (!on || stopped) return false;
    const text = JSON.stringify({ v: SAVE_V, world: worldId, w: Math.floor(clock.wall()), savedAt: Date.now(), events, ...(Object.keys(sections).length ? { sections } : {}) });
    if (text.length > maxChars) return fail('full');
    try { storage.setItem(SAVE_KEY, text); return true; } catch (e) { return fail(/quota/i.test(String(e?.name ?? '') + String(e?.message ?? '')) || e?.code === 22 ? 'full' : 'unavailable'); }
  }
  return {
    events,
    seen(live) {
      if (seenDone) { live.seen(); return; }
      const w = clock.freeze();
      try { live.seen(); } finally { clock.thaw(); }
      seenDone = true;
      events.push({ w, k: 'seen' });
      write();
    },
    /** Take one POST: the clock is held for the whole of it, and one POST at a time (as the replay takes them). */
    post(m, p, bodyText, run) {
      const go = async () => {
        const w = clock.freeze();
        try {
          let r;
          try { r = await run(); } catch (err) { events.push({ w, k: 'post', m, p, b: bodyText ?? null, r: `throw:${digest(String(err?.message ?? err))}` }); write(); throw err; }
          events.push({ w, k: 'post', m, p, b: bodyText ?? null, r: digest(r) });
          write();
          return r;
        } finally { clock.thaw(); }
      };
      const out = chain.then(go, go);
      chain = out.then(() => {}, () => {});
      return out;
    },
    tick(turn) { if (turn !== lastTurn) { lastTurn = turn; write(); } },
    /** A section of the page's own (`{v, ...}`, a JSON object with an integer version), or null. */
    section: name => (Object.hasOwn(sections, name) ? structuredClone(sections[name]) : null),
    /** Keep a section (written at once). A value that is not `{v: integer, ...}` is refused (false). */
    setSection(name, value) {
      if (typeof name !== 'string' || !value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.v)) return false;
      try { sections[name] = JSON.parse(JSON.stringify(value)); } catch { return false; }
      return write();
    },
    write,
    /** Stop writing and leave the save as it is (a browser that cannot replay it: `why` says why). */
    disable(reason) { on = false; why = String(reason); },
    /** "Start over": the save is removed and nothing more is written from this page. */
    clear() { stopped = true; try { storage?.removeItem(SAVE_KEY); } catch { /* nothing more to do */ } },
    state: () => ({ on: on && !stopped, why, inputs: events.filter(e => e.k === 'post').length }),
  };
}
