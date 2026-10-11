// AC6: the minimal chronicle (contract section 6.7): template lines in English and Japanese, filled only with numbers and names taken
// from code (bells, coordinates, counts, derived names, nation names), never with model text. The kinds: motion, call_adopted (no target),
// call_declined, no_call, strike_result (at S + 2, with the target), ai_joined, ai_card_changed, ai_march_opened. The mind never reads it.
//
//   fillLine(kind, vals, lang) -> string           pure; throws when a template value is missing
//   tallyPhrase(split, {seatVoted}, lang) -> string  "1 AI ballot and the presenter's ballot", "... and a scripted seat ballot"
//   createChronicle({aiDir, roster, nameOf, nationName}) -> {add(spec), lines(), latest(n), flush()}
//
// A line is {id, kind, bell, day, actors:[tag], ai:[bool], by?, refs:[string], text:{en, ja}}. `ai[]` comes from the roster only. Files:
// PUB/chronicle/latest.json (last 100) and PUB/chronicle/<day>.json (a day's lines); both are rewritten (max-age 2), the journal
// STATE/watcher/chronicle.jsonl keeps the lines across a restart.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { safeText } from '../memory/safe.mjs';

const read = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
export const TEMPLATES = { en: read('./templates.en.json'), ja: read('./templates.ja.json') };
export const LANGS = ['en', 'ja'];
export const KINDS = Object.freeze(['motion', 'call_adopted', 'call_declined', 'no_call', 'strike_result', 'ai_joined', 'ai_card_changed', 'ai_march_opened']);
export const DAY_BELLS = 144;
export const LATEST_LINES = 100;

const sub = (tpl, vals) => tpl.replace(/\{(\w+)\}/g, (m, k) => {
  if (!(k in vals)) throw new Error(`chronicle template: no value for {${k}}`);
  return String(vals[k]);
});

export function fillLine(kind, vals, lang) {
  const t = TEMPLATES[lang];
  if (!t?.kinds?.[kind]) throw new Error(`chronicle: no template ${kind} (${lang})`);
  return sub(t.kinds[kind], vals);
}

const countWord = (w, n) => sub(n === 1 ? w.one : w.many, { n });

/** "with 1 AI ballot and the presenter's ballot" (EN) / the same in JA. `split` = {ai, human, scripted}; `seatVoted` = the seat's wallet is among the ballots. */
export function tallyPhrase(split, { seatVoted = false } = {}, lang = 'en') {
  const w = TEMPLATES[lang].words;
  const parts = [];
  const ai = split?.ai ?? 0;
  let human = split?.human ?? 0;
  const scripted = split?.scripted ?? 0;
  if (ai > 0) parts.push(countWord(w.ballot_ai, ai));
  if (seatVoted && scripted === 0 && human > 0) { parts.push(w.ballot_presenter); human -= 1; }
  if (human > 0) parts.push(countWord(w.ballot_human, human));
  if (scripted > 0) parts.push(countWord(w.ballot_scripted, scripted));
  return `${w.with}${parts.length ? parts.join(w.and) : w.ballots_none}${w.with_suffix}`;
}

/** The lost-troops phrase of a strike result: "Aster 120, Ember 80" or "no clash was recorded". `lost` = {nation number: troops}. */
export function lostPhrase(lost, lang, nationName) {
  const w = TEMPLATES[lang].words;
  const keys = Object.keys(lost ?? {}).map(Number).sort((a, b) => a - b);
  if (!keys.length) return w.lost_none;
  return keys.map(f => sub(w.lost_item, { nation: nationName(f)[lang], n: lost[f] })).join(w.lost_sep);
}

const lineId = (kind, bell, actors, refs) => createHash('sha256').update(JSON.stringify([kind, bell, actors, refs])).digest('hex').slice(0, 16);

/** The words table of a language (templates.<lang>.json `words`). */
export const words = lang => TEMPLATES[lang].words;
/** `{n}` replaced by a count in a word template. */
export const withCount = (tpl, n) => sub(tpl, { n });

export function createChronicle({ pubDir, stateDir, roster, nameOf, nationName, onError = () => {} } = {}) {
  const STATE = stateDir;
  const DIR = `${pubDir}/chronicle`;
  const journal = `${STATE}/chronicle.jsonl`;
  const all = [];
  const ids = new Set();
  const dirtyDays = new Set();
  let dirty = false;

  if (existsSync(journal)) {
    for (const l of readFileSync(journal, 'utf8').split('\n')) {
      if (!l) continue;
      try { const x = JSON.parse(l); if (!ids.has(x.id)) { ids.add(x.id); all.push(x); } } catch { /* a torn last line */ }
    }
    dirty = all.length > 0;
    for (const x of all) dirtyDays.add(x.day);
  }

  const isAi = tag => Boolean(roster.byTag?.(tag)) || Boolean(roster.isAi?.(tag));
  const name = (tag, lang) => nameOf(tag)[lang];
  const nation = (f, lang) => nationName(f)[lang];

  /**
   * add({kind, bell, actors, by, refs, vals}): `vals(lang)` -> the template values of that language (code numbers and names only).
   * Returns the line, or null when an identical one (same kind, bell, actors, refs) exists already.
   */
  function add({ kind, bell, actors = [], by = null, refs = [], vals }) {
    if (!KINDS.includes(kind)) throw new Error(`chronicle: unknown kind ${kind}`);
    const id = lineId(kind, bell, actors, refs);
    if (ids.has(id)) return null;
    const text = {};
    for (const l of LANGS) text[l] = safeText(fillLine(kind, vals(l), l), { kind: 'trusted' });
    const line = { id, kind, bell, day: Math.floor(bell / DAY_BELLS), actors, ai: actors.map(isAi), ...(by ? { by } : {}), refs, text };
    ids.add(id);
    all.push(line);
    dirty = true;
    dirtyDays.add(line.day);
    try {
      mkdirSync(STATE, { recursive: true });
      appendFileSync(journal, `${JSON.stringify(line)}\n`);
    } catch (e) { onError(e); }
    return line;
  }

  const atomic = (path, obj) => {
    mkdirSync(DIR, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path);
  };

  return {
    add, name, nation,
    lines: () => all.slice(),
    latest: (n = LATEST_LINES) => all.slice(-n),
    /** Write latest.json and the files of the days that changed; returns true when something was written. */
    flush() {
      if (!dirty) return false;
      const ordered = [...all].sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1));
      atomic(`${DIR}/latest.json`, { v: 1, lines: ordered.slice(-LATEST_LINES) });
      for (const d of dirtyDays) atomic(`${DIR}/${d}.json`, { v: 1, day: d, lines: ordered.filter(x => x.day === d) });
      dirtyDays.clear();
      dirty = false;
      return true;
    },
  };
}
