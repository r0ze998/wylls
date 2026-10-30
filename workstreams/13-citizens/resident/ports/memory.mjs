// The memory port: the seam to workstream 12. Until it arrives, a local
// adapter keeps one resident's episodes in its own file and recalls them
// with the citizens' retrieval (citizens/memory/retrieve.mjs, unchanged), so
// the episode shape is the citizens' (contract §5.2: id, bell, created_bell,
// kind, importance, entities, text {en, ja}, facts).
//
//   MemoryPort { append(episode) → boolean (false: id already kept),
//                recall({focus, bell}) → episodes, oldest first,
//                all() → episodes }
//
// One resident's memory is never readable by another: each adapter owns one
// file, and the resident is handed only its own adapter.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { retrieve } from '../../../../permutation-gateway/citizens/memory/retrieve.mjs';

export const EPISODE_KINDS = Object.freeze(['kept', 'broken', 'declined', 'unanswered', 'delivered', 'raided', 'failed', 'refused-by-me', 'returned', 'joined', 'built']);

export function checkEpisode(ep) {
  if (!ep || typeof ep.id !== 'string' || !Number.isInteger(ep.bell) || !EPISODE_KINDS.includes(ep.kind)) throw new Error(`bad episode ${JSON.stringify(ep)?.slice(0, 80)}`);
  if (!Array.isArray(ep.entities) || !Number.isFinite(ep.importance)) throw new Error('episode needs entities and importance');
}

/** The local adapter (append-only JSONL; appending an id twice keeps the first: restart-safe). */
export function localMemory(file) {
  const eps = new Map();
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) { const e = JSON.parse(line); if (!eps.has(e.id)) eps.set(e.id, e); }
  }
  if (file) mkdirSync(path.dirname(file), { recursive: true });
  return {
    kind: 'local-jsonl',
    append(ep) {
      checkEpisode(ep);
      if (eps.has(ep.id)) return false;
      const e = { v: 1, created_bell: ep.bell, facts: {}, text: { en: '', ja: '' }, ...ep };
      eps.set(e.id, e);
      if (file) appendFileSync(file, `${JSON.stringify(e)}\n`);
      return true;
    },
    recall({ focus = [], bell }) {
      const list = [...eps.values()];
      const ids = retrieve(list, focus, bell + 1);
      return ids.map(id => eps.get(id));
    },
    all() { return [...eps.values()]; },
  };
}

/**
 * Trust in a counterpart, from memory alone: kept +1, returned +1, broken −2.
 * Derived on demand so that a replaced memory gives the same behaviour from
 * the same episodes.
 */
export function trustOf(memory, citizen) {
  let t = 0;
  for (const e of memory.all()) {
    if (!e.entities.includes(citizen)) continue;
    if (e.kind === 'kept' || e.kind === 'returned') t += 1;
    if (e.kind === 'broken') t -= 2;
  }
  return t;
}
