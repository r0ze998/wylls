// Memory attach (contract sections 4.3, 5.2 retrieval, 5.5, 5.6): the mind's side of memory.
//  * focus   = {own tag, nation:<own>, home pq} + the entities of every candidate + the tags of this
//              prompt's inbox senders + the nations named in this prompt's threat facts (section 5.2);
//  * the MEMORY block and the handles M1..Mk come from AC2's renderMemory(ownState, focus, budget)
//    (pinned in 11.6); retrieval itself (score, half-life, grievance sources, the cut) is AC2's;
//  * refs    = for each candidate the handles whose episode entities intersect the candidate's
//              entities (<= 3, best score first), computed here from the episodes behind the handles;
//  * goals_served = the goal ids this kind of action advances for this persona;
//  * C handles   = people handles used in say.to and trust.who, with a legend line the prompt prints.
// AC2 is built in parallel. What this file assumes of ownState and renderMemory is listed in
// AC1a-NOTES.md ("assumed AC2 shapes"); tests use a double with exactly those shapes.
import { kindBase } from './schema.mjs';

export const MAX_REFS = 3;
export const MAX_PEOPLE = 12;

/** Deterministic score used only to order a candidate's refs (same shape as the section 5.2 retrieval score). */
export function refScore(episode, candEntities, bellNow, halfLife = 72) {
  const inter = (episode.entities ?? []).filter((e) => candEntities.includes(e)).length;
  return (episode.importance ?? 1) * 0.5 ** ((bellNow - episode.bell) / halfLife) * (1 + 0.5 * inter);
}

const KIND_GOALS = {
  // default table of "which goal ids does this kind of action advance" per persona (section 2.2).
  // goals.mjs of AC2 may provide a function that replaces it (deps.goalsServed).
  conqueror: { march: ['G2', 'G3', 'G4'], train: ['G1'], muster: ['G1'], hold: [], recall: [], build: [], walls: [], explore: [], autopilot: [] },
  guardian: { walls: ['G1'], hold: ['G2', 'G3'], recall: ['G4', 'G3'], train: ['G2'], muster: ['G3'], march: [], build: [], explore: [], autopilot: [] },
  diplomat: { build: ['G4'], hold: [], march: [], train: [], muster: [], explore: [], walls: [], recall: [], autopilot: [] },
  avenger: { march: ['G1'], hold: ['G2'], train: ['G4'], muster: ['G4'], recall: ['G2'], build: [], walls: [], explore: [], autopilot: [] },
  founder: { build: ['G1', 'G3'], explore: ['G2'], hold: ['G4'], walls: ['G1'], train: ['G4'], muster: [], march: [], recall: [], autopilot: [] },
  opportunist: { march: ['G1', 'G2', 'G3'], build: ['G4'], train: [], muster: [], hold: [], recall: [], walls: [], explore: [], autopilot: [] },
};

export function goalsServedDefault(personaId, candidate) {
  const table = KIND_GOALS[personaId] ?? {};
  return [...(table[kindBase(candidate.kind)] ?? [])];
}

/**
 * People handles for one prompt. `sources` is an ordered list of {tag, wallet?, name?, faction?} (inbox
 * senders first, then hall authors, motion authors, relations, episode entities). Citizens only; nations
 * are N<f> and need no table. Deterministic: first appearance order, at most MAX_PEOPLE.
 */
export function buildPeople(sources, ownTag) {
  const byTag = new Map();
  for (const s of sources) {
    if (!s?.tag || s.tag === ownTag) continue;
    const prev = byTag.get(s.tag);
    if (prev) {
      prev.wallet ??= s.wallet ?? null;
      prev.name ??= s.name ?? null;
      prev.faction ??= s.faction ?? null;
      continue;
    }
    if (byTag.size >= MAX_PEOPLE) continue;
    byTag.set(s.tag, { tag: s.tag, wallet: s.wallet ?? null, name: s.name ?? null, faction: s.faction ?? null });
  }
  const people = [];
  let n = 1;
  for (const p of byTag.values()) people.push({ handle: `C${n++}`, ...p });
  const byHandle = Object.fromEntries(people.map((p) => [p.handle, p]));
  const handleOfTag = (tag) => people.find((p) => p.tag === tag)?.handle ?? null;
  return { people, byHandle, handleOfTag };
}

export function createMemoryAttach({ renderMemory, goalsServed = null, blockTokens = 750, maxRefs = MAX_REFS } = {}) {
  if (typeof renderMemory !== 'function') throw new Error('createMemoryAttach: renderMemory (AC2) is required');

  function focusOf({ ownState, request, inboxTags = [], threatNations = [], extraEntities = [] }) {
    const set = new Set();
    set.add(ownState.tag);
    const f = request.situation?.me?.faction;
    if (f != null) set.add(`nation:${f}`);
    const home = request.situation?.me?.home;
    if (home && home.p != null) set.add(`pq:${home.p},${home.q}`);
    for (const c of request.candidates ?? []) for (const e of c.entities ?? []) set.add(e);
    for (const e of extraEntities) set.add(e);
    for (const t of inboxTags) set.add(t);
    for (const n of threatNations) set.add(`nation:${n}`);
    return [...set].sort();
  }

  /**
   * attach({ownState, request, bell, inboxTags, threatNations, budgetTokens, handleOf}) ->
   *   {block, handles: {M1: id, ...}, retrieved: [id in handle order], candidates: [candidate + refs + goals_served], focus}
   * The candidates keep every brain field; the mind only adds `refs` and `goals_served`.
   */
  function attach({ ownState, request, bell, inboxTags = [], threatNations = [], extraEntities = [], budgetTokens = blockTokens, handleOf = null }) {
    const focus = focusOf({ ownState, request, inboxTags, threatNations, extraEntities });
    // AC2's renderMemory(ownState, focus, budget): ownState = {tag, bell, ledger (a snapshot), episodes, summary, persona, progress},
    // focus = the entity strings, budget = {tokens, count?, handleOf?}. The mind passes no async token counter: the block is cut
    // with AC2's own estimate and prompt.mjs counts the whole prompt exactly afterwards.
    const rendered = renderMemory({ ...ownState, ledger: ownState.doc ?? ownState.ledger, bell }, focus, { tokens: budgetTokens, handleOf }) ?? {};
    const handles = rendered.handles ?? {};
    const handleList = Object.keys(handles).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const retrieved = handleList.map((h) => handles[h]);
    const episodes = new Map();
    for (const h of handleList) {
      const e = ownState.episodes?.get?.(handles[h]);
      if (e) episodes.set(h, e);
    }
    const persona = ownState.persona?.id ?? ownState.persona?.persona ?? null;
    const candidates = (request.candidates ?? []).map((c) => {
      const ents = c.entities ?? [];
      const scored = [];
      for (const [h, e] of episodes) {
        if (!ents.length) continue;
        if ((e.entities ?? []).some((x) => ents.includes(x))) scored.push({ h, s: refScore(e, ents, bell), bell: e.bell, id: e.id });
      }
      scored.sort((a, b) => b.s - a.s || b.bell - a.bell || (a.id < b.id ? -1 : 1));
      const refs = scored.slice(0, maxRefs).map((x) => x.h);
      const gs = goalsServed ? goalsServed(ownState.persona, c) : goalsServedDefault(persona, c);
      return { ...c, refs, goals_served: gs };
    });
    return { block: rendered.block ?? '', handles, retrieved, candidates, focus, tokens: rendered.tokens ?? null };
  }

  /** Map a model's `mem` handles to episode ids; unknown or repeated handles are dropped and counted. */
  function resolveMem(mem, handles) {
    const ids = [];
    let dropped = 0;
    const seen = new Set();
    for (const h of mem ?? []) {
      if (typeof h !== 'string' || !Object.hasOwn(handles, h) || seen.has(h)) {
        dropped += 1;
        continue;
      }
      seen.add(h);
      ids.push(handles[h]);
    }
    return { ids, dropped };
  }

  return { attach, resolveMem, focusOf };
}
