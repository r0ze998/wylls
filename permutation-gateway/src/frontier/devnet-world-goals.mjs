// The DEVNET world's off-chain world-goals judge (pt-world-goals-devnet; owner r0ze 2026-11-26 15:48 JST Q-PT-6 (c),
// Q-PT-7 (b)): the flag keeps of the wide land — neutral wide keeps and Free Cities, captured and held 24 hours —
// judged by wide-flags.mjs over what the HERALD already holds. No money, no on-chain write, no key, and NO RPC: the
// only reads are the herald's public routes on loopback (`/h/season`, `/h/world/wide`, `/h/world/wide/page`), which
// the herald answers from its own fold. The relay serves the answer it writes (`--world-goals-file`, GET /f/goals/state).
//
//   node src/frontier/devnet-world-goals.mjs --herald http://127.0.0.1:41040 --dir <state dir>
//        [--every-ms 300000]      how often the herald is read (default 5 min; a turn is 10 min)
//        [--once]                 one read, then exit
//   node src/frontier/devnet-world-goals.mjs --replay <dir>/archive.jsonl [--print]
//                                 rebuild the answer from an archive alone (anyone can: the verifier-style check)
//
// The state directory: `archive.jsonl` (one line per read: `{n, obs}` — the decoded fields the judge reads and the
// sha256 and slot of each captured Province's bytes, so a reader with the herald's or the chain's archive can check
// them), `answer.json` (what the relay serves) and nothing else. On start the archive is replayed: the answer is
// always a function of the archive. Wall-clock time is written beside an observation (`readAt`) for operators only;
// the judge never reads it.
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { answerOf, initialState, observationOf, replay, stepFlags, WIDE_FLAGS_DEFAULTS } from './wide-flags.mjs';

export const ARCHIVE_FILE = 'archive.jsonl';
export const ANSWER_FILE = 'answer.json';
export const DEFAULT_EVERY_MS = 300_000;
/** The herald's page maximum (frontier-abi world_index MAX_PAGE). */
export const PAGE_LIMIT = 256;
/** A read that pages past this many Provinces stops (a herald gone wrong must not make the judge loop forever). */
export const MAX_PROVINCES = 200_000;

const LOOPBACK = /^http:\/\/(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\]):\d{2,5}$/;

/** `argv` → `{herald, dir, everyMs, once, replay, print}`; throws on a bad or non-loopback herald. */
export function parseArgs(argv) {
  const o = { herald: null, dir: null, everyMs: DEFAULT_EVERY_MS, once: false, replay: null, print: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--print') o.print = true;
    else if (a === '--herald') o.herald = String(argv[++i] ?? '').replace(/\/+$/, '');
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--replay') o.replay = argv[++i];
    else if (a === '--every-ms') o.everyMs = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.replay) return o;
  if (!o.herald || !LOOPBACK.test(o.herald)) throw new Error('--herald must be the herald on loopback (http://127.0.0.1:PORT): the judge reads no remote service');
  if (!o.dir) throw new Error('--dir is required');
  if (!Number.isInteger(o.everyMs) || o.everyMs < 10_000) throw new Error('--every-ms must be an integer ≥ 10000');
  return o;
}

const getJson = async (fetchImpl, url) => {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(`${url}: HTTP ${r.status} ${j?.error ?? j?.code ?? ''}`.trim()), { status: r.status, code: j?.error ?? j?.code ?? null });
  return j;
};

/**
 * One read of the herald → `{season: {seasonId, programId, seasonAddress, world}, entries}`: the season record, the wide
 * manifest, and every page of the wide index in order. A page answering StaleSnapshot (the index moved under the read)
 * starts the walk over, at most three times.
 */
export async function readHerald(herald, { fetchImpl = globalThis.fetch } = {}) {
  const s = await getJson(fetchImpl, `${herald}/h/season`);
  const m = await getJson(fetchImpl, `${herald}/h/world/wide`);
  if (String(m.season) !== String(s.season) || m.program !== s.programId) throw new Error('the wide manifest is of another season');
  const season = { seasonId: String(s.season), programId: s.programId, seasonAddress: s.seasonAddress, world: m.world };
  for (let attempt = 0; attempt < 3; attempt++) {
    const entries = [];
    let after = null, stale = false;
    for (;;) {
      let page;
      try { page = await getJson(fetchImpl, `${herald}/h/world/wide/page?limit=${PAGE_LIMIT}${after ? `&after=${after}` : ''}`); } catch (e) {
        if (e.code === 'StaleSnapshot' || e.status === 409) { stale = true; break; }
        throw e;
      }
      if (page.world !== m.world) throw new Error('a wide page of another world');
      entries.push(...(page.entries ?? []));
      if (entries.length > MAX_PROVINCES) throw new Error('the wide index is larger than the judge reads');
      if (!page.next) break;
      after = page.next;
    }
    if (!stale) return { season, entries };
  }
  throw new Error('the wide index kept moving under the read (StaleSnapshot ×3)');
}

const readLines = async file => {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
};

/** Replay an archive file → `{state, season, lines}` (the season is the archive's first line's). */
export async function replayArchive(file) {
  const lines = await readLines(file);
  lines.forEach((l, i) => { if (l.n !== i + 1) throw new Error(`archive line ${i + 1} says n=${l.n}`); });
  const season = lines[0]?.season ?? null;
  if (lines.some(l => JSON.stringify(l.season) !== JSON.stringify(season))) throw new Error('the archive mixes seasons');
  const rules = lines[0]?.rules ?? WIDE_FLAGS_DEFAULTS;
  return { state: replay(lines.map(l => l.obs), rules), season, lines, rules };
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/**
 * The judge over a state directory: `{tick(), state}`. `tick()` reads the herald once, steps the judge, appends the
 * observation to the archive and rewrites the answer → `{events, answer}`.
 */
export async function openJudge({ herald, dir, fetchImpl = globalThis.fetch, rules = WIDE_FLAGS_DEFAULTS, log = () => {}, now = () => new Date().toISOString() }) {
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, ARCHIVE_FILE), answerFile = path.join(dir, ANSWER_FILE);
  const r = await replayArchive(archive);
  let state = r.lines.length ? r.state : initialState(rules), season = r.season, n = r.lines.length;
  const judge = {
    get state() { return state; },
    async tick() {
      const h = await readHerald(herald, { fetchImpl });
      if (season && (season.seasonId !== h.season.seasonId || season.programId !== h.season.programId || season.world !== h.season.world)) throw new Error(`the herald now serves another world (season ${h.season.seasonId}); this archive is season ${season.seasonId}'s — use another --dir`);
      season ??= h.season;
      const obs = observationOf(h.entries, { seasonId: season.seasonId, world: season.world });
      const step = stepFlags(state, obs);
      n += 1;
      await appendFile(archive, `${JSON.stringify({ n, season, rules: { holdBells: state.holdBells, firstOnly: state.firstOnly }, readAt: now(), obs })}\n`);
      state = step.state;
      const answer = answerOf(state, { seasonId: season.seasonId, programId: season.programId, seasonAddress: season.seasonAddress });
      await writeAtomic(answerFile, JSON.stringify(answer));
      if (obs.refused) log(`world goals: ${obs.refused} captured wide Province(s) did not read as the season's; left out`);
      for (const e of step.events) log(`world goals: nation ${e.nation} held the ${e.kind} at ${e.p},${e.q}${e.site !== undefined ? ` site ${e.site}` : ''} for ${state.holdBells} turns (bell ${e.bell})`);
      return { events: step.events, answer };
    },
  };
  if (n) await writeAtomic(answerFile, JSON.stringify(answerOf(state, { seasonId: season.seasonId, programId: season.programId, seasonAddress: season.seasonAddress })));
  return judge;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.replay) {
    const r = await replayArchive(o.replay);
    const a = answerOf(r.state, { seasonId: r.season?.seasonId ?? '?', programId: r.season?.programId, seasonAddress: r.season?.seasonAddress });
    if (o.print) console.log(JSON.stringify(a, null, 2));
    else console.log(`replayed ${r.lines.length} observations: bell ${a.bell}, ${a.wideFlags.flags.length} flags, ${a.achievements.length} achievements, inputs ${a.judge.inputsHash}`);
    return;
  }
  const judge = await openJudge({ herald: o.herald, dir: o.dir, log: m => console.log(m) });
  let stopped = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopped = true; });
  for (;;) {
    try { const t = await judge.tick(); console.log(`world goals: read ${judge.state.observations}, bell ${t.answer.bell}, ${t.answer.wideFlags.flags.length} flags, ${t.answer.achievements.length} achievements`); } catch (e) { console.error(`world goals: ${e.message}`); }
    if (o.once || stopped) return;
    await new Promise(res => { const t = setTimeout(res, o.everyMs); const w = setInterval(() => { if (stopped) { clearTimeout(t); clearInterval(w); res(); } }, 500); t.unref?.(); });
    if (stopped) return;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1); });
